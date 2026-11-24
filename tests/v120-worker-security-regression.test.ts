import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaWorkerApi, PanelRequestContext } from 'orca/worker'
import type { ConnectionProfile, DatabaseDriverType, SchemaObject, TransactionState } from '../src/protocol'
import type { FetchPageParams, IDatabaseSession } from '../src/drivers/common/driver'
import { runDriverConnectionTest } from '../src/drivers/common/driver'
import { ACTIONABLE_TLS_CERT_ERROR_HINT } from '../src/drivers/common/tls-and-tunnel'
import { ClickHouseDriver } from '../src/drivers/clickhouse/driver'
import { DriverManager } from '../src/drivers/driver-manager'
import {
  detectRedisCredentialCommand,
  maskConnectionUriSecret,
  scrubSensitiveText,
} from '../src/shared-sql-safety.js'
import {
  AI_MAX_COMPLETION_BODY_BYTES,
  AI_MAX_EXPLAIN_BODY_BYTES,
  AI_RPC_MAX_PREFIX_CHARS,
  AI_RPC_MAX_SUFFIX_CHARS,
  AiResponseTooLargeError,
  completeChat,
  completeSql,
  explainFailure,
  hasSensitiveContent,
  isLoopbackHost,
  listModels,
  sanitizeAiBaseUrlForDisplay,
  validateAiBaseUrl,
  type AiProviderConfig,
} from '../src/worker/ai-client'
import { WorkerSchemaMetadataCache } from '../src/worker/ai-sql-context'
import { registerAiHandlers } from '../src/worker/rpc-ai'
import { registerConnectionHandlers } from '../src/worker/rpc-connections'
import { registerDataAndSchemaHandlers } from '../src/worker/rpc-data-schema'
import { buildExplainPlanForStatement, registerQueryAndTxHandlers } from '../src/worker/rpc-query-tx'
import {
  buildTunnelProxiedProfile,
  resolveSshTunnelTarget,
  type SessionManager,
} from '../src/worker/session-manager'
import { TxOwnershipController } from '../src/worker/tx-ownership'
import {
  appendActionableTlsErrorHint,
  clearInMemoryUiSessionSnapshots,
  createQueryRuntimeTracker,
  getUiSessionSnapshot,
  saveUiSessionSnapshot,
  scrubAndEnhanceWorkerError,
  type WorkerRegisterHandler,
} from '../src/worker/worker-utils'

type RpcHandler = (input: unknown, ctx?: PanelRequestContext) => Promise<unknown> | unknown

function createMockOrcaHost(opts?: {
  settings?: Record<string, unknown>
  storage?: Record<string, unknown>
  secrets?: Record<string, string>
  workspaceDirs?: string[]
}) {
  const settingsMap = new Map<string, unknown>(Object.entries(opts?.settings ?? {}))
  const storageMap = new Map<string, unknown>(Object.entries(opts?.storage ?? {}))
  const secretsMap = new Map<string, string>(Object.entries(opts?.secrets ?? {}))
  const logs: string[] = []
  const posted: Array<{ channel: string; payload: unknown }> = []
  const handlers = new Map<string, RpcHandler>()
  const settingsListeners: Array<(change: { key?: string }) => void> = []

  const orca = {
    log: (msg: string) => {
      logs.push(msg)
    },
    settings: {
      get: async (key?: string) => {
        if (key === undefined) {
          return Object.fromEntries(settingsMap.entries())
        }
        return settingsMap.get(key)
      },
      set: async (key: string, value: unknown) => {
        settingsMap.set(key, value)
        for (const fn of settingsListeners) fn({ key })
      },
      onDidChange: (cb: (change: { key?: string }) => void) => {
        settingsListeners.push(cb)
        return {
          dispose: () => {
            const idx = settingsListeners.indexOf(cb)
            if (idx >= 0) settingsListeners.splice(idx, 1)
          },
        }
      },
    },
    storage: {
      get: async (key: string) => storageMap.get(key) ?? null,
      set: async (key: string, value: unknown) => {
        storageMap.set(key, value)
      },
      delete: async (key: string) => {
        storageMap.delete(key)
      },
    },
    secrets: {
      get: async (key: string) => secretsMap.get(key) ?? null,
      set: async (key: string, value: string) => {
        secretsMap.set(key, value)
      },
      delete: async (key: string) => {
        secretsMap.delete(key)
      },
      protection: async () => 'os-keyring',
    },
    panels: {
      handle: (name: string, fn: RpcHandler) => {
        handlers.set(name, fn)
      },
      post: (channel: string, payload: unknown) => {
        posted.push({ channel, payload })
      },
    },
    host: opts?.workspaceDirs
      ? {
          has: () => true,
          call: async (method: string) => {
            if (method === 'workspace.list') {
              return {
                workspaces: opts.workspaceDirs?.map((dir, idx) => ({
                  id: `ws_${idx}`,
                  path: dir,
                  name: path.basename(dir),
                  hostId: null,
                })),
              }
            }
            if (method === 'secrets.protection') return { status: 'os-keyring' }
            return null
          },
        }
      : undefined,
    commands: {
      register: () => {},
    },
  } as unknown as OrcaWorkerApi

  const registerHandler = ((name: string, fn: RpcHandler) => {
    handlers.set(name, fn)
  }) as unknown as WorkerRegisterHandler

  const call = async <T = unknown>(
    name: string,
    input?: unknown,
    panelId?: string
  ): Promise<T> => {
    const fn = handlers.get(name)
    if (!fn) throw new Error(`Handler not registered: ${name}`)
    const ctx = panelId
      ? ({ panel: { id: panelId } } as unknown as PanelRequestContext)
      : ({} as PanelRequestContext)
    return (await fn(input, ctx)) as T
  }

  return { orca, registerHandler, call, logs, posted, settingsMap, storageMap, secretsMap }
}

function createFakeTxSession(driverType: DatabaseDriverType) {
  let txState: TransactionState = {
    supported: true,
    active: false,
    autoCommit: true,
    statementCount: 0,
  }
  const fetchPageCalls: FetchPageParams[] = []
  const runQueryCalls: string[] = []
  const updateCellCalls: unknown[] = []
  const applyChangesCalls: unknown[] = []
  let runQueryHook: ((sql: string) => Promise<void>) | null = null
  let commitHook: (() => Promise<void>) | null = null

  const session: IDatabaseSession = {
    driverType,
    profile: { id: `conn_${driverType}`, name: `Test ${driverType}`, driver: driverType },
    isAlive: () => true,
    close: async () => {},
    listObjects: async () => [],
    getTableDetails: async (table) => ({
      name: table,
      columns: [],
      indexes: [],
      foreignKeys: [],
    }),
    getDdl: async () => '',
    fetchPage: async (params) => {
      fetchPageCalls.push(params)
      return {
        columns: [{ name: 'id', type: 'INT' }],
        rows: [[1]],
        totalCount: 1,
        page: params.page,
        pageSize: params.pageSize,
        primaryKeys: ['id'],
        executionTimeMs: 1,
      }
    },
    updateCell: async (params) => {
      updateCellCalls.push(params)
      if (!txState.autoCommit && !txState.active) {
        txState = { ...txState, active: true, statementCount: txState.statementCount + 1 }
      }
      return { ok: true, affectedRows: 1 }
    },
    previewChanges: async () => ({ statements: [] }),
    applyChanges: async (params) => {
      applyChangesCalls.push(params)
      if (!txState.autoCommit && !txState.active) {
        txState = { ...txState, active: true, statementCount: txState.statementCount + 1 }
      }
      return { ok: true, inserted: 1, updated: 0, deleted: 0, statements: [] }
    },
    runQuery: async (_queryId, sql) => {
      runQueryCalls.push(sql)
      if (runQueryHook) {
        await runQueryHook(sql)
      }
      if (/^\s*(?:BEGIN|START\s+TRANSACTION)\b/i.test(sql)) {
        txState = { ...txState, active: true }
      } else if (
        /^\s*(?:COMMIT|ROLLBACK|ABORT|PREPARE\s+TRANSACTION)\b/i.test(sql) ||
        /\bROLLBACK\b/i.test(sql)
      ) {
        txState = { ...txState, active: false, statementCount: 0 }
      } else if (!txState.autoCommit && !txState.active) {
        txState = { ...txState, active: true, statementCount: 1 }
      }
      return {
        columns: [{ name: 'ok', type: 'INT' }],
        rows: [[1]],
        rowCount: 1,
        executionTimeMs: 1,
        truncated: false,
        isSelect: true,
      }
    },
    cancelQuery: async () => {},
    getTransactionState: () => ({ ...txState }),
    beginTransaction: async () => {
      txState = { ...txState, active: true }
      return { ...txState }
    },
    commitTransaction: async () => {
      if (commitHook) await commitHook()
      txState = { ...txState, active: false, statementCount: 0 }
      return { ...txState }
    },
    rollbackTransaction: async () => {
      txState = { ...txState, active: false, statementCount: 0 }
      return { ...txState }
    },
    setAutoCommit: async (enabled) => {
      txState = { ...txState, autoCommit: enabled, active: enabled ? false : txState.active }
      return { ...txState }
    },
  }

  return {
    session,
    fetchPageCalls,
    runQueryCalls,
    updateCellCalls,
    applyChangesCalls,
    setRunQueryHook: (fn: ((sql: string) => Promise<void>) | null) => {
      runQueryHook = fn
    },
    setCommitHook: (fn: (() => Promise<void>) | null) => {
      commitHook = fn
    },
    setTxState: (next: Partial<TransactionState>) => {
      txState = { ...txState, ...next }
    },
  }
}

const tempDirs: string[] = []
const httpServers: http.Server[] = []

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  clearInMemoryUiSessionSnapshots()
  while (httpServers.length > 0) {
    const srv = httpServers.pop()
    if (srv) {
      await new Promise<void>((resolve) => srv.close(() => resolve()))
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
  vi.restoreAllMocks()
})

describe('[HIGH-2] & [MED-1] ReDoS Elimination in scrubSensitiveText', () => {
  it('completes adversarial slash, backslash, and 100K alphanumeric inputs in < 50 ms', () => {
    const slashPayload = 'https://host' + '/a'.repeat(40)
    const t0 = performance.now()
    expect(scrubSensitiveText(slashPayload, { stripAllFragments: true })).toBe(slashPayload)
    expect(scrubSensitiveText(slashPayload, { stripOpaqueFragment: true })).toBe(slashPayload)
    const t1 = performance.now()
    expect(t1 - t0).toBeLessThan(50)

    const longAlpha = 'a'.repeat(100_000)
    const t2 = performance.now()
    expect(scrubSensitiveText(longAlpha)).toBe(longAlpha)
    const t3 = performance.now()
    expect(t3 - t2).toBeLessThan(50)

    const authPayload = 'Authorization: Bearer ' + '/a'.repeat(40)
    const t4 = performance.now()
    const scrubbedAuth = scrubSensitiveText(authPayload)
    const t5 = performance.now()
    expect(t5 - t4).toBeLessThan(50)
    expect(scrubbedAuth).toContain('[REDACTED]')
  })

  it('preserves escaped-slash ClickHouse URL + fragment redaction across PBT inputs', () => {
    const escaped1 = String.raw`{"url":"https:\/\/u:Sec123@ch.internal:8443\/db#opaqueTok"}`
    const escaped3 = String.raw`{"url":"https:\\\/\\\/u:Sec123@ch.internal:8443\\\/db#opaqueTok"}`
    expect(scrubSensitiveText(escaped1, { stripOpaqueFragment: true })).not.toContain('Sec123')
    expect(scrubSensitiveText(escaped1, { stripOpaqueFragment: true })).not.toContain('opaqueTok')
    expect(scrubSensitiveText(escaped3, { stripOpaqueFragment: true })).not.toContain('Sec123')
    expect(scrubSensitiveText(escaped3, { stripOpaqueFragment: true })).not.toContain('opaqueTok')

    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('/', '\\/', 'a', '1', ':', '#', '?', '='), { minLength: 1, maxLength: 60 }),
        (parts) => {
          const sample = `https://host${parts.join('')}`
          const start = performance.now()
          const res = scrubSensitiveText(sample, { stripAllFragments: true })
          expect(typeof res).toBe('string')
          expect(performance.now() - start).toBeLessThan(50)
        }
      ),
      { numRuns: 40 }
    )
  })
})

describe('[HIGH-3] & [HIGH-4] Cross-Panel TX Isolation, Single-Lock Serialization & Dialect TX-End', () => {
  const pinnedDrivers: readonly DatabaseDriverType[] = [
    'postgres',
    'mysql',
    'sqlite',
    'mssql',
    'oracle',
    'mongodb',
  ]

  for (const driver of pinnedDrivers) {
    it(`isolates cross-panel data.updateCell, data.applyChanges, data.fetchPage, query.run & query.explain on ${driver}`, async () => {
      const host = createMockOrcaHost()
      const fake = createFakeTxSession(driver)
      const profile: ConnectionProfile = {
        id: `conn_${driver}`,
        name: `Conn ${driver}`,
        driver,
      }
      const sessionManager = {
        findProfile: async (id: string) => (id === profile.id ? profile : null),
        getSession: async () => fake.session,
        getActiveSessions: () => new Map([[profile.id, fake.session]]),
      } as unknown as SessionManager

      const txOwnership = new TxOwnershipController()
      registerDataAndSchemaHandlers({
        orca: host.orca,
        registerHandler: host.registerHandler,
        sessionManager,
        txOwnership,
      })
      registerQueryAndTxHandlers({
        orca: host.orca,
        registerHandler: host.registerHandler,
        sessionManager,
        tracker: createQueryRuntimeTracker(),
        txOwnership,
      })

      // Panel A turns off autoCommit (manual TX mode, active === false initially)
      const manualState = await host.call<TransactionState & { txToken?: number }>(
        'tx.setAutoCommit',
        { connectionId: profile.id, enabled: false },
        'panel-A'
      )
      expect(manualState.autoCommit).toBe(false)
      const originalToken = manualState.txToken
      expect(typeof originalToken).toBe('number')

      // Panel B MUST be blocked on updateCell, applyChanges, query.run, and query.explain
      await expect(
        host.call(
          'data.updateCell',
          {
            connectionId: profile.id,
            table: 'users',
            primaryKeys: { id: 1 },
            column: 'name',
            newValue: 'Mallory',
          },
          'panel-B'
        )
      ).rejects.toMatchObject({ code: 'forbidden' })

      await expect(
        host.call(
          'data.applyChanges',
          {
            connectionId: profile.id,
            table: 'users',
            inserts: [{ id: 2, name: 'Mallory' }],
          },
          'panel-B'
        )
      ).rejects.toMatchObject({ code: 'forbidden' })

      const sampleQuery = driver === 'mongodb' ? 'db.users.find({})' : 'SELECT 1/0'
      await expect(
        host.call('query.run', { connectionId: profile.id, queryId: 'qB1', sql: sampleQuery }, 'panel-B')
      ).rejects.toMatchObject({ code: 'forbidden' })

      await expect(
        host.call('query.explain', { connectionId: profile.id, sql: sampleQuery }, 'panel-B')
      ).rejects.toMatchObject({ code: 'forbidden' })

      // Panel B data.fetchPage succeeds with bypassTransaction: true
      await host.call(
        'data.fetchPage',
        { connectionId: profile.id, table: 'users', page: 1, pageSize: 20 },
        'panel-B'
      )
      expect(fake.fetchPageCalls.at(-1)?.bypassTransaction).toBe(true)

      // Panel A data.fetchPage uses pinned TX (bypassTransaction: false)
      await host.call(
        'data.fetchPage',
        { connectionId: profile.id, table: 'users', page: 1, pageSize: 20 },
        'panel-A'
      )
      expect(fake.fetchPageCalls.at(-1)?.bypassTransaction).toBe(false)

      // Panel A data.updateCell transitions !active -> active while preserving original txToken
      await host.call(
        'data.updateCell',
        {
          connectionId: profile.id,
          table: 'users',
          primaryKeys: { id: 1 },
          column: 'name',
          newValue: 'Alice',
        },
        'panel-A'
      )
      const statusA = await host.call<TransactionState & { txToken?: number }>(
        'tx.status',
        { connectionId: profile.id },
        'panel-A'
      )
      expect(statusA.active).toBe(true)
      expect(statusA.txToken).toBe(originalToken)
    })
  }

  it('serializes owner query.explain under txOwnership.withLock before concurrent tx.commit', async () => {
    const host = createMockOrcaHost()
    const fake = createFakeTxSession('postgres')
    const profile: ConnectionProfile = { id: 'conn_pg', name: 'PG', driver: 'postgres' }
    const sessionManager = {
      findProfile: async () => profile,
      getSession: async () => fake.session,
      getActiveSessions: () => new Map([[profile.id, fake.session]]),
    } as unknown as SessionManager

    const events: string[] = []
    let releaseExplain: (() => void) | undefined
    const explainGate = new Promise<void>((resolve) => {
      releaseExplain = resolve
    })
    let explainEntered: (() => void) | undefined
    const explainStarted = new Promise<void>((resolve) => {
      explainEntered = resolve
    })

    fake.setRunQueryHook(async () => {
      events.push('explain:start')
      explainEntered?.()
      await explainGate
      events.push('explain:end')
    })
    fake.setCommitHook(async () => {
      events.push('commit:start')
    })

    const txOwnership = new TxOwnershipController()
    registerQueryAndTxHandlers({
      orca: host.orca,
      registerHandler: host.registerHandler,
      sessionManager,
      tracker: createQueryRuntimeTracker(),
      txOwnership,
    })

    await host.call('tx.begin', { connectionId: profile.id }, 'panel-A')

    const explainPromise = host.call(
      'query.explain',
      { connectionId: profile.id, sql: 'SELECT * FROM users' },
      'panel-A'
    )
    await explainStarted

    const commitPromise = host.call('tx.commit', { connectionId: profile.id }, 'panel-A')
    await new Promise((r) => setTimeout(r, 15))
    expect(events).toEqual(['explain:start'])

    releaseExplain?.()
    await Promise.all([explainPromise, commitPromise])
    expect(events).toEqual(['explain:start', 'explain:end', 'commit:start'])
  })

  it('detects PG ABORT/PREPARE TRANSACTION, MSSQL GO/semicolon-less TX-end (excluding savepoint), Oracle PL/SQL & DDL, and MySQL implicit-commit DDL', async () => {
    const cases: Array<{
      driver: DatabaseDriverType
      sql: string
      expectCommitRollbackMsg: boolean
    }> = [
      { driver: 'postgres', sql: 'ABORT WORK', expectCommitRollbackMsg: true },
      { driver: 'postgres', sql: "PREPARE TRANSACTION 'tx_42'", expectCommitRollbackMsg: true },
      { driver: 'mssql', sql: 'SELECT 1\nGO\nROLLBACK TRAN', expectCommitRollbackMsg: true },
      { driver: 'mssql', sql: 'SELECT 1\nCOMMIT TRAN', expectCommitRollbackMsg: true },
      { driver: 'mssql', sql: 'ROLLBACK TRAN sp1', expectCommitRollbackMsg: false },
      { driver: 'oracle', sql: 'BEGIN\n  ROLLBACK;\nEND;\n/', expectCommitRollbackMsg: true },
      { driver: 'oracle', sql: 'CREATE TABLE t_ddl (id NUMBER)', expectCommitRollbackMsg: true },
      { driver: 'mysql', sql: 'DROP TABLE t_old', expectCommitRollbackMsg: true },
      { driver: 'mysql', sql: 'SET autocommit = 1', expectCommitRollbackMsg: true },
      { driver: 'mysql', sql: 'CREATE TEMPORARY TABLE t_tmp (id INT)', expectCommitRollbackMsg: false },
    ]

    for (const tc of cases) {
      const host = createMockOrcaHost()
      const fake = createFakeTxSession(tc.driver)
      const profile: ConnectionProfile = { id: `c_${tc.driver}`, name: tc.driver, driver: tc.driver }
      const sessionManager = {
        findProfile: async () => profile,
        getSession: async () => fake.session,
        getActiveSessions: () => new Map([[profile.id, fake.session]]),
      } as unknown as SessionManager

      registerQueryAndTxHandlers({
        orca: host.orca,
        registerHandler: host.registerHandler,
        sessionManager,
        tracker: createQueryRuntimeTracker(),
        txOwnership: new TxOwnershipController(),
      })

      await host.call('tx.begin', { connectionId: profile.id }, 'panel-A')

      try {
        await host.call(
          'query.run',
          { connectionId: profile.id, queryId: 'q_test', sql: tc.sql },
          'panel-B'
        )
        throw new Error(`Expected forbidden error for ${tc.driver}: ${tc.sql}`)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        expect((err as { code?: string }).code).toBe('forbidden')
        if (tc.expectCommitRollbackMsg) {
          expect(msg).toContain('Cannot commit or roll back a transaction opened by another editor panel.')
        } else {
          expect(msg).toContain('Another editor panel owns an active transaction')
        }
      }
    }
  })

  it('[LOW-8] supports dotted MongoDB collection names in buildExplainPlanForStatement', () => {
    const plan = buildExplainPlanForStatement('db.app.events.find({ ok: true })', 'mongodb', true)
    expect(plan.explainSql).toBe('db.app.events.find({ ok: true }).explain("queryPlanner")')

    const aggPlan = buildExplainPlanForStatement(
      'db.app.events.v2.aggregate([{ $match: { status: 1 } }])',
      'mongodb',
      true
    )
    expect(aggPlan.explainSql).toContain('.explain("queryPlanner")')

    expect(() =>
      buildExplainPlanForStatement(
        'db.app.events.aggregate([{ $out: "target" }])',
        'mongodb',
        true
      )
    ).toThrow(/Read-Only/i)
  })

  it('[POSTREV-MED-1] splits Oracle query.explain on /, never executes raw DELETE after /, and rejects PL/SQL blocks', async () => {
    const host = createMockOrcaHost()
    const fake = createFakeTxSession('oracle')
    const mutableProfile: ConnectionProfile = {
      id: 'conn_ora_rw',
      name: 'Oracle RW',
      driver: 'oracle',
      readOnly: false,
    }
    const readOnlyProfile: ConnectionProfile = {
      id: 'conn_ora_ro',
      name: 'Oracle RO',
      driver: 'oracle',
      readOnly: true,
    }
    const profiles = new Map<string, ConnectionProfile>([
      [mutableProfile.id, mutableProfile],
      [readOnlyProfile.id, readOnlyProfile],
    ])
    const sessionManager = {
      findProfile: async (id: string) => profiles.get(id) ?? null,
      getSession: async () => fake.session,
      getActiveSessions: () => new Map([[mutableProfile.id, fake.session]]),
    } as unknown as SessionManager

    registerQueryAndTxHandlers({
      orca: host.orca,
      registerHandler: host.registerHandler,
      sessionManager,
      tracker: createQueryRuntimeTracker(),
      txOwnership: new TxOwnershipController(),
    })

    // Mutable Oracle: each /-delimited statement is wrapped in EXPLAIN PLAN FOR — DELETE is NEVER executed raw
    await host.call('query.explain', {
      connectionId: mutableProfile.id,
      sql: 'SELECT 1 FROM DUAL\n/\nDELETE FROM users WHERE id = 1',
    })
    expect(fake.runQueryCalls).toEqual([
      'EXPLAIN PLAN FOR SELECT 1 FROM DUAL',
      'SELECT PLAN_TABLE_OUTPUT FROM TABLE(DBMS_XPLAN.DISPLAY())',
      'EXPLAIN PLAN FOR DELETE FROM users WHERE id = 1',
      'SELECT PLAN_TABLE_OUTPUT FROM TABLE(DBMS_XPLAN.DISPLAY())',
    ])
    expect(fake.runQueryCalls.some((q) => /^\s*DELETE\b/i.test(q))).toBe(false)

    // Read-Only Oracle: blocked before ANY query runs
    fake.runQueryCalls.length = 0
    await expect(
      host.call('query.explain', {
        connectionId: readOnlyProfile.id,
        sql: 'SELECT 1 FROM DUAL\n/\nDELETE FROM users WHERE id = 1',
      })
    ).rejects.toMatchObject({ code: 'not_permitted' })
    expect(fake.runQueryCalls).toHaveLength(0)

    // PL/SQL blocks (standalone or trailing after /) are rejected cleanly with 0 queries executed
    await expect(
      host.call('query.explain', {
        connectionId: mutableProfile.id,
        sql: 'BEGIN DELETE FROM users; END;\n/',
      })
    ).rejects.toMatchObject({
      code: 'invalid_params',
      message: expect.stringMatching(/EXPLAIN PLAN does not support PL\/SQL blocks/i),
    })
    await expect(
      host.call('query.explain', {
        connectionId: mutableProfile.id,
        sql: 'SELECT 1 FROM DUAL\n/\nBEGIN NULL; END;\n/',
      })
    ).rejects.toMatchObject({
      code: 'invalid_params',
      message: expect.stringMatching(/EXPLAIN PLAN does not support PL\/SQL blocks/i),
    })
    expect(fake.runQueryCalls).toHaveLength(0)

    // Direct buildExplainPlanForStatement rejects multi-statement / chunks and PL/SQL, strips trailing /
    expect(() =>
      buildExplainPlanForStatement(
        'SELECT 1 FROM DUAL\n/\nDELETE FROM users WHERE id = 1',
        'oracle',
        false
      )
    ).toThrow(/single SQL statement/i)
    expect(() =>
      buildExplainPlanForStatement('BEGIN DELETE FROM users; END;\n/', 'oracle', false)
    ).toThrow(/EXPLAIN PLAN does not support PL\/SQL blocks/i)
    expect(buildExplainPlanForStatement('SELECT 1 FROM DUAL\n/', 'oracle', true).explainSql).toBe(
      'EXPLAIN PLAN FOR SELECT 1 FROM DUAL'
    )
  })
})

describe('[HIGH-9] & [LOW-1] Storage Redaction & Redis 3-Arg AUTH', () => {
  it('scrubs consoleTabsState, whereClause, activeWhereClause, lastSqlResult, and formDraft secrets while preserving benign filters', async () => {
    const host = createMockOrcaHost()
    await saveUiSessionSnapshot(host.orca, 'panel', {
      viewState: {
        whereClause: "url = 'postgres://admin:TopSecret99@db.local:5432/app'",
        activeWhereClause: "WHERE password IS NOT NULL AND token_type = 'oauth'",
        consoleTabsState: {
          tabs: [
            { id: 't1', sql: 'AUTH myRealRedisSecret ?' },
            { id: 't2', sql: 'SELECT * FROM users WHERE password IS NOT NULL' },
          ],
        },
        lastSqlResult: {
          sqlPreview: 'AUTH myRealRedisSecret ?',
          sql: "ALTER USER admin PASSWORD 'SecretPass123!'",
          resultSets: [
            {
              index: 0,
              sqlPreview: 'https://user:Pass123@ch.internal/db?token=Tok999',
              sql: "CREATE USER u IDENTIFIED BY 'Pwd123!'",
              error: 'Failed connecting to postgres://u:ErrPass@db:5432/app#opaqueFrag',
            },
          ],
        },
        formDraft: {
          name: ':s3cr3t@redis.internal:6379',
          url: 'https://u:pw@ch.internal:8443/db?sslpassword=SslP4ss&keep=1',
          options: 'tlsCertificateKeyFilePassword=KeyP4ss&sslmode=verify-full',
        },
      },
      dataCache: {
        whereClause: 'AUTH myRealRedisSecret ?',
        lastSqlResult: {
          sqlPreview: "ALTER USER root IDENTIFIED BY 'SecretRoot!'",
        },
      },
    })

    const snap = await getUiSessionSnapshot(host.orca, 'panel')
    const view = snap.viewState as Record<string, unknown>
    expect(view.whereClause).toBe('')
    expect(view.activeWhereClause).toBe("WHERE password IS NOT NULL AND token_type = 'oauth'")

    const tabs = (view.consoleTabsState as { tabs: Array<{ sql: string }> }).tabs
    expect(tabs[0].sql).toBe('')
    expect(tabs[1].sql).toBe('SELECT * FROM users WHERE password IS NOT NULL')

    const serialized = JSON.stringify(snap)
    expect(serialized).not.toContain('TopSecret99')
    expect(serialized).not.toContain('myRealRedisSecret')
    expect(serialized).not.toContain('SecretPass123')
    expect(serialized).not.toContain('Pass123')
    expect(serialized).not.toContain('Tok999')
    expect(serialized).not.toContain('Pwd123')
    expect(serialized).not.toContain('ErrPass')
    expect(serialized).not.toContain('opaqueFrag')
    expect(serialized).not.toContain('s3cr3t')
    expect(serialized).not.toContain('SslP4ss')
    expect(serialized).not.toContain('KeyP4ss')
    expect(serialized).not.toContain('SecretRoot')
    expect((view.formDraft as { name: string }).name).toBe('@redis.internal:6379')
  })

  it('[LOW-1] detects Redis 3-arg AUTH & HELLO AUTH and excludes them from query history even on error', async () => {
    expect(detectRedisCredentialCommand('AUTH myRealSecret ?')).toBe(true)
    expect(detectRedisCredentialCommand('AUTH myRealSecret ""')).toBe(true)
    expect(detectRedisCredentialCommand('AUTH myRealSecret $1')).toBe(true)
    expect(detectRedisCredentialCommand('AUTH myRealSecret <PASSWORD>')).toBe(true)
    expect(detectRedisCredentialCommand('HELLO 3 AUTH myRealSecret ?')).toBe(true)

    const host = createMockOrcaHost()
    const profile: ConnectionProfile = { id: 'c_redis', name: 'Redis', driver: 'redis' }
    const session = createFakeTxSession('redis').session
    session.runQuery = async () => {
      throw new Error('ERR wrong number of arguments for auth command')
    }
    const sessionManager = {
      findProfile: async () => profile,
      getSession: async () => session,
      getActiveSessions: () => new Map([[profile.id, session]]),
    } as unknown as SessionManager

    registerQueryAndTxHandlers({
      orca: host.orca,
      registerHandler: host.registerHandler,
      sessionManager,
      tracker: createQueryRuntimeTracker(),
    })

    await expect(
      host.call('query.run', {
        connectionId: profile.id,
        queryId: 'q_r1',
        sql: 'AUTH myRealSecret ?',
      })
    ).rejects.toThrow(/wrong number of arguments/i)

    const history = await host.call<{ entries: Array<{ sql: string }> }>('query.history.list')
    expect(history.entries).toHaveLength(0)
  })
})

describe('[MED-2] Live HTTP 307 Redirect Blocking in AI Client & ClickHouse Driver', () => {
  it('blocks 307 redirects without forwarding credentials across completeSql, completeChat, listModels, and ClickHouse', async () => {
    let targetHits = 0
    const targetServer = http.createServer((_req, res) => {
      targetHits += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
    await new Promise<void>((resolve) => targetServer.listen(0, '127.0.0.1', () => resolve()))
    httpServers.push(targetServer)
    const targetAddr = targetServer.address()
    if (!targetAddr || typeof targetAddr === 'string') throw new Error('Target server failed')

    const redirectServer = http.createServer((_req, res) => {
      res.writeHead(307, {
        location: `http://127.0.0.1:${targetAddr.port}/steal`,
      })
      res.end()
    })
    await new Promise<void>((resolve) => redirectServer.listen(0, '127.0.0.1', () => resolve()))
    httpServers.push(redirectServer)
    const redirectAddr = redirectServer.address()
    if (!redirectAddr || typeof redirectAddr === 'string') throw new Error('Redirect server failed')

    const baseUrl = `http://127.0.0.1:${redirectAddr.port}/v1`
    const provider: AiProviderConfig = {
      format: 'openai',
      baseUrl,
      model: 'gpt-4o-mini',
      apiKey: 'sk-secret-do-not-forward-1234567890',
      maxTokens: 64,
    }

    await expect(
      completeSql(
        provider,
        { system: 's', user: 'u', prefix: 'SELECT ', suffix: '' },
        AbortSignal.timeout(5000)
      )
    ).rejects.toThrow()

    let chatErr: unknown
    try {
      await completeChat(provider, 's', 'Explain SELECT 1', 64, AbortSignal.timeout(5000))
    } catch (e) {
      chatErr = e
    }
    expect(chatErr).toBeDefined()
    expect(explainFailure(chatErr, `127.0.0.1:${redirectAddr.port}`, 5000)).toMatch(
      /Blocked HTTP redirect/i
    )

    await expect(listModels(provider, AbortSignal.timeout(5000))).rejects.toThrow()

    const chDriver = new ClickHouseDriver()
    const chSession = await chDriver.createSession(
      {
        id: 'ch_redir',
        name: 'CH Redir',
        driver: 'clickhouse',
        url: `http://127.0.0.1:${redirectAddr.port}`,
        user: 'admin',
      },
      'ClickHouseSecretPass'
    )
    await expect(chSession.runQuery('q_ch', 'SELECT 1', 10)).rejects.toMatchObject({
      code: 'CLICKHOUSE_REDIRECT_BLOCKED',
    })
    await chSession.close()

    expect(targetHits).toBe(0)
  })
})

describe('[MED-3] AI Base URL Validation, Non-Loopback HTTP Blocking & Sanitization', () => {
  it('enforces strict loopback check, blocks non-loopback HTTP with API key, and strips embedded credentials/query in status', async () => {
    expect(isLoopbackHost('localhost:11434')).toBe(true)
    expect(isLoopbackHost('127.0.0.1:11434')).toBe(true)
    expect(isLoopbackHost('[::1]:11434')).toBe(true)
    expect(isLoopbackHost('::1')).toBe(true)
    expect(isLoopbackHost('127.999.0.1')).toBe(false)
    expect(isLoopbackHost('192.168.1.10:11434')).toBe(false)

    expect(validateAiBaseUrl('http://192.168.1.10:11434/v1', { hasApiKey: false }).ok).toBe(true)
    expect(validateAiBaseUrl('http://192.168.1.10:11434/v1', { hasApiKey: true }).ok).toBe(false)
    expect(validateAiBaseUrl('http://127.0.0.1:11434/v1', { hasApiKey: true }).ok).toBe(true)
    expect(validateAiBaseUrl('https://user:pass@api.openai.com/v1').ok).toBe(false)
    expect(validateAiBaseUrl('https://api.openai.com/v1?api_key=abc').ok).toBe(false)
    expect(validateAiBaseUrl('https://api.openai.com/v1#frag').ok).toBe(false)
    expect(validateAiBaseUrl('https://api.openai.com/v1\n').ok).toBe(true) // trimmed
    expect(validateAiBaseUrl('https://api.openai.com/v1\x00').ok).toBe(false)

    expect(sanitizeAiBaseUrlForDisplay('https://user:pw@api.openai.com/v1/?k=secret#frag')).toBe(
      'https://api.openai.com/v1'
    )

    const host = createMockOrcaHost({
      settings: {
        aiEnabled: true,
        aiFormat: 'openai',
        aiBaseUrl: 'https://user:leak@api.openai.com/v1?api_key=secret',
        aiModel: 'gpt-4o-mini',
      },
    })
    const sessionManager = {
      assertSecureSecretStorage: async () => {},
    } as unknown as SessionManager
    registerAiHandlers({
      orca: host.orca,
      registerHandler: host.registerHandler,
      sessionManager,
      schemaCache: new WorkerSchemaMetadataCache(),
    })

    await expect(
      host.call('ai.key.set', {
        key: 'sk-test-key-1234567890123456',
        baseUrl: 'http://remote.example.com/v1',
      })
    ).rejects.toMatchObject({ code: 'invalid_params' })

    await expect(
      host.call('ai.key.set', {
        key: 'sk-test-key-1234567890123456',
        baseUrl: 'https://user:pass@api.openai.com/v1',
      })
    ).rejects.toMatchObject({ code: 'invalid_params' })

    const listRes = await host.call<{ ok: boolean; message: string }>('ai.models.list', {
      format: 'openai',
      baseUrl: 'http://remote.example.com/v1',
      key: 'sk-test-key-1234567890123456',
    })
    expect(listRes.ok).toBe(false)
    expect(listRes.message).toMatch(/unencrypted http:\/\//i)

    const status = await host.call<{ baseUrl: string; state: string }>('ai.status.get')
    expect(status.baseUrl).toBe('https://api.openai.com/v1')
    expect(status.baseUrl).not.toContain('leak')
    expect(status.baseUrl).not.toContain('secret')
    expect(status.state).toBe('setup')
  })
})

describe('[MED-8] SSH Tunnel Fail-Closed & Oracle Easy Connect / TNS Rewrite', () => {
  it('fails closed on mongodb+srv:// and multi-host MongoDB URIs', () => {
    const srvProfile: ConnectionProfile = {
      id: 'm1',
      name: 'Atlas',
      driver: 'mongodb',
      url: 'mongodb+srv://user:pass@cluster0.mongodb.net/app',
      sshEnabled: true,
    }
    expect(() => resolveSshTunnelTarget(srvProfile)).toThrow(/mongodb\+srv/i)
    expect(() =>
      buildTunnelProxiedProfile(srvProfile, { localHost: '127.0.0.1', localPort: 50001 })
    ).toThrow(/mongodb\+srv/i)

    const multiMongo: ConnectionProfile = {
      id: 'm2',
      name: 'RS',
      driver: 'mongodb',
      url: 'mongodb://h1.internal:27017,h2.internal:27017/app',
      sshEnabled: true,
    }
    expect(() => resolveSshTunnelTarget(multiMongo)).toThrow(/multi-host/i)
    expect(() =>
      buildTunnelProxiedProfile(multiMongo, { localHost: '127.0.0.1', localPort: 50001 })
    ).toThrow(/multi-host/i)
  })

  it('rewrites Oracle Easy Connect & single-address TNS through SSH tunnel and fails closed on multi-address TNS', () => {
    const easyProfile: ConnectionProfile = {
      id: 'o1',
      name: 'Oracle Easy',
      driver: 'oracle',
      url: 'ora.internal:1521/FREEPDB1',
      sshEnabled: true,
    }
    expect(resolveSshTunnelTarget(easyProfile)).toEqual({
      targetHost: 'ora.internal',
      targetPort: 1521,
    })
    expect(
      buildTunnelProxiedProfile(easyProfile, { localHost: '127.0.0.1', localPort: 54321 }).url
    ).toBe('127.0.0.1:54321/FREEPDB1')

    const tcpsEasy: ConnectionProfile = {
      id: 'o2',
      name: 'Oracle TCPS',
      driver: 'oracle',
      url: 'tcps://ora-tls.internal/ORCL',
      sshEnabled: true,
    }
    expect(resolveSshTunnelTarget(tcpsEasy)).toEqual({
      targetHost: 'ora-tls.internal',
      targetPort: 2484,
    })
    expect(
      buildTunnelProxiedProfile(tcpsEasy, { localHost: '127.0.0.1', localPort: 54322 }).url
    ).toBe('tcps://127.0.0.1:54322/ORCL')

    const tnsSingle: ConnectionProfile = {
      id: 'o3',
      name: 'Oracle TNS',
      driver: 'oracle',
      url: '(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=ora-tns.internal)(PORT=1522))(CONNECT_DATA=(SERVICE_NAME=ORCL)))',
      sshEnabled: true,
    }
    expect(resolveSshTunnelTarget(tnsSingle)).toEqual({
      targetHost: 'ora-tns.internal',
      targetPort: 1522,
    })
    const proxiedTns = buildTunnelProxiedProfile(tnsSingle, {
      localHost: '127.0.0.1',
      localPort: 54323,
    })
    expect(proxiedTns.url).toContain('(HOST=127.0.0.1)')
    expect(proxiedTns.url).toContain('(PORT=54323)')
    expect(proxiedTns.url).not.toContain('ora-tns.internal')

    const tnsMulti: ConnectionProfile = {
      id: 'o4',
      name: 'Oracle Multi TNS',
      driver: 'oracle',
      url: '(DESCRIPTION=(ADDRESS_LIST=(ADDRESS=(PROTOCOL=TCP)(HOST=h1)(PORT=1521))(ADDRESS=(PROTOCOL=TCP)(HOST=h2)(PORT=1521)))(CONNECT_DATA=(SERVICE_NAME=ORCL)))',
      sshEnabled: true,
    }
    expect(() => resolveSshTunnelTarget(tnsMulti)).toThrow(/multi-address/i)
    expect(() =>
      buildTunnelProxiedProfile(tnsMulti, { localHost: '127.0.0.1', localPort: 54324 })
    ).toThrow(/multi-address/i)
  })
})

describe('[MED-10] Ephemeral Worker candidateId Store & Masking', () => {
  it('omits raw secrets from workspace.detectConnections and resolves them only via candidateId RPCs', async () => {
    const wsDir = makeTempDir('datanoa-med10-')
    fs.writeFileSync(
      path.join(wsDir, '.env'),
      'DATABASE_URL=postgres://admin:EnvS3cr3t@127.0.0.1:5432/appdb?sslpassword=SslP4ss&tlsCertificateKeyFilePassword=KeyP4ss#opaqueFrag\n',
      'utf8'
    )
    fs.writeFileSync(
      path.join(wsDir, 'docker-compose.yml'),
      [
        'services:',
        '  pg:',
        '    image: postgres:16',
        '    ports:',
        '      - "5432:5432"',
        '    environment:',
        '      POSTGRES_USER: pgadmin',
        '      POSTGRES_PASSWORD: DockerS3cr3tVal',
        '      POSTGRES_DB: appdb',
      ].join('\n'),
      'utf8'
    )

    const host = createMockOrcaHost({ workspaceDirs: [wsDir] })
    const sessionManager = {
      getStoredConnections: async () => [],
    } as unknown as SessionManager
    const driverManager = new DriverManager(host.orca.storage, (m) => host.logs.push(m))
    const connCtrl = registerConnectionHandlers({
      orca: host.orca,
      registerHandler: host.registerHandler,
      sessionManager,
      driverManager,
    })

    const detected = await host.call<{
      envConnections: Array<{ candidateId?: string; uri: string }>
      dockerComposeConnections: Array<{
        candidateId?: string
        password?: string
        hasPassword?: boolean
      }>
    }>('workspace.detectConnections', { folderPath: wsDir })

    const rawIpc = JSON.stringify(detected)
    expect(rawIpc).not.toContain('EnvS3cr3t')
    expect(rawIpc).not.toContain('SslP4ss')
    expect(rawIpc).not.toContain('KeyP4ss')
    expect(rawIpc).not.toContain('opaqueFrag')
    expect(rawIpc).not.toContain('DockerS3cr3tVal')

    expect(detected.envConnections).toHaveLength(1)
    const envItem = detected.envConnections[0]
    expect(envItem.candidateId).toBeTruthy()
    expect(envItem.uri).toContain('#***')
    expect(maskConnectionUriSecret('postgres://u:p@h/db?tlsCertificateKeyFilePassword=xyz')).not.toContain('xyz')

    const parsed = await host.call<{ ok: boolean; password?: string }>('connection.parseUri', {
      candidateId: envItem.candidateId,
    })
    expect(parsed.ok).toBe(true)
    expect(parsed.password).toBe('EnvS3cr3t')

    const dockerItem = detected.dockerComposeConnections.find((d) => d.hasPassword)
    expect(dockerItem).toBeDefined()
    expect(dockerItem?.password).toBeUndefined()
    expect(dockerItem?.candidateId).toBeTruthy()

    const resolvedDocker = await host.call<{ ok: boolean; password?: string }>(
      'workspace.resolveDetectedCandidate',
      { candidateId: dockerItem?.candidateId }
    )
    expect(resolvedDocker.ok).toBe(true)
    expect(resolvedDocker.password).toBe('DockerS3cr3tVal')

    connCtrl.clearDetectedCandidates()
    const expired = await host.call<{ ok: boolean }>('connection.parseUri', {
      candidateId: envItem.candidateId,
    })
    expect(expired.ok).toBe(false)
  })
})

describe('[LOW-2], Perf #1, Perf #4 & Perf #7 — AI Hardening, Lazy Loader & Multi-Schema Cache', () => {
  it('[LOW-2] detects Authorization/Bearer/Basic/URI-query secrets, enforces body/stream byte caps, skips empty SSE deltas, and scrubs errors', async () => {
    expect(hasSensitiveContent('Authorization: Bearer superSecretToken1234', '')).not.toBeNull()
    expect(hasSensitiveContent('Authorization: Basic dXNlcjpwYXNzMTIz', '')).not.toBeNull()
    expect(hasSensitiveContent('Bearer myLiveTokenValue98765', '')).not.toBeNull()
    expect(hasSensitiveContent('Basic dXNlcjpwYXNzMTIz==', '')).not.toBeNull()
    expect(hasSensitiveContent('SELECT * FROM t -- https://host/db?sslpassword=RealPass99', '')).not.toBeNull()
    expect(hasSensitiveContent('const apiKey = "your_api_key"', '')).toBeNull()
    expect(hasSensitiveContent('Bearer authorization flow', '')).toBeNull()

    const provider: AiProviderConfig = {
      format: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      apiKey: 'sk-test',
      maxTokens: 64,
    }

    // Stream exceeding AI_MAX_COMPLETION_BODY_BYTES (256 KiB) must reject and cancel stream
    let streamCancelled = false
    const oversizeStream = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunk = new Uint8Array(64 * 1024).fill(65)
        for (let i = 0; i < 6; i++) controller.enqueue(chunk)
        controller.close()
      },
      cancel() {
        streamCancelled = true
      },
    })
    await expect(
      completeSql(
        provider,
        { system: 's', user: 'u', prefix: 'SELECT ', suffix: '' },
        AbortSignal.timeout(5000),
        async () => ({
          ok: true,
          status: 200,
          headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
          body: oversizeStream,
          json: async () => ({}),
          text: async () => '',
        })
      )
    ).rejects.toBeInstanceOf(AiResponseTooLargeError)
    expect(streamCancelled).toBe(true)

    // EXPLAIN chat response exceeding AI_MAX_EXPLAIN_BODY_BYTES (1 MiB) via Content-Length header
    await expect(
      completeChat(
        provider,
        's',
        'Explain SELECT 1',
        256,
        AbortSignal.timeout(5000),
        async () => ({
          ok: true,
          status: 200,
          headers: {
            get: (k) =>
              k.toLowerCase() === 'content-length'
                ? String(AI_MAX_EXPLAIN_BODY_BYTES + 1024)
                : null,
          },
          body: null,
          json: async () => ({}),
          text: async () => '',
        })
      )
    ).rejects.toBeInstanceOf(AiResponseTooLargeError)

    // Empty SSE keepalive frames do not break real SQL delta assembly
    const sseWithKeepalives = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder()
        controller.enqueue(enc.encode('data: {"choices":[{"delta":{}}]}\n\n'))
        controller.enqueue(enc.encode(': keepalive\n\n'))
        controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"id FROM users;"}}]}\n\n'))
        controller.enqueue(enc.encode('data: [DONE]\n\n'))
        controller.close()
      },
    })
    const completed = await completeSql(
      provider,
      { system: 's', user: 'u', prefix: 'SELECT ', suffix: '' },
      AbortSignal.timeout(5000),
      async () => ({
        ok: true,
        status: 200,
        headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
        body: sseWithKeepalives,
        json: async () => ({}),
        text: async () => '',
      })
    )
    expect(completed).toBe('id FROM users;')

    // explainFailure fallback scrubs sensitive URLs & credentials
    expect(AI_MAX_COMPLETION_BODY_BYTES).toBe(256 * 1024)
    const scrubbed = explainFailure(
      new Error('Unexpected error for postgres://admin:LeakPass99@db.local:5432/app#secretFrag'),
      'api.openai.com',
      5000
    )
    expect(scrubbed).not.toContain('LeakPass99')
    expect(scrubbed).not.toContain('secretFrag')

    // rpc-ai logFailure scrubs credentials before orca.log and status.reason
    const logHost = createMockOrcaHost({
      settings: {
        aiEnabled: true,
        aiFormat: 'openai',
        aiBaseUrl: 'https://api.openai.com/v1',
        aiModel: 'gpt-4o-mini',
      },
      storage: { 'datanoa.ai.keyAddress': 'https://api.openai.com/v1' },
      secrets: { ai_api_key: 'sk-valid-key-1234567890123456' },
    })
    registerAiHandlers({
      orca: logHost.orca,
      registerHandler: logHost.registerHandler,
      sessionManager: { assertSecureSecretStorage: async () => {} } as unknown as SessionManager,
      schemaCache: new WorkerSchemaMetadataCache(),
      fetchPost: async () => {
        throw new Error('Upstream failed at https://u:LogLeak99@api.openai.com/v1?token=TokLeak#fragLeak')
      },
    })
    await logHost.call('ai.complete', {
      connectionId: 'c1',
      dialect: 'postgres',
      prefix: 'SELECT ',
      suffix: '',
    })
    const combinedLogs = logHost.logs.join('\n')
    expect(combinedLogs).toContain('[AI]')
    expect(combinedLogs).not.toContain('LogLeak99')
    expect(combinedLogs).not.toContain('TokLeak')
    expect(combinedLogs).not.toContain('fragLeak')
    const st = await logHost.call<{ reason: string | null }>('ai.status.get')
    expect(st.reason ?? '').not.toContain('LogLeak99')
    expect(st.reason ?? '').not.toContain('TokLeak')
  })

  it('[LOW-6] DriverManager rejects self-mutating / disk-tampered CJS BYOD entry during load', async () => {
    const dir = makeTempDir('datanoa-byod-toctou-')
    const entryPath = path.join(dir, 'index.cjs')
    fs.writeFileSync(
      entryPath,
      [
        "const fs = require('node:fs')",
        "fs.writeFileSync(__filename, 'module.exports = { tampered: true }\\n', 'utf8')",
        'module.exports = {',
        '  testConnection: async () => ({ ok: true }),',
        '  createSession: async () => ({}),',
        '}',
      ].join('\n'),
      'utf8'
    )
    const host = createMockOrcaHost()
    const dm = new DriverManager(host.orca.storage, (m) => host.logs.push(m))
    const inspected = await dm.inspectLocalDriver({ driverId: 'custom', localPath: dir })
    expect(inspected.ok).toBe(true)
    const expectedHash = createHash('sha256').update(fs.readFileSync(entryPath)).digest('hex')
    expect(inspected.sha256).toBe(expectedHash)

    await expect(
      dm.configureLocalDriver({
        driverId: 'custom',
        localPath: dir,
        trustedSha256: inspected.sha256,
      })
    ).rejects.toThrow(/Local driver entry changed during load/i)

    // Clean CJS entry tampered on disk after configuration must also fail closed on resolveVerifiedAdapter
    const cleanDir = makeTempDir('datanoa-byod-clean-')
    const cleanEntry = path.join(cleanDir, 'index.cjs')
    fs.writeFileSync(
      cleanEntry,
      "module.exports = { type: 'custom', testConnection: async () => ({ ok: true }), createSession: async () => ({}) }\n",
      'utf8'
    )
    const dm2 = new DriverManager(createMockOrcaHost().orca.storage, () => {})
    const cleanInspect = await dm2.inspectLocalDriver({ driverId: 'custom', localPath: cleanDir })
    expect(cleanInspect.ok).toBe(true)
    await dm2.configureLocalDriver({
      driverId: 'custom',
      localPath: cleanDir,
      trustedSha256: cleanInspect.sha256,
    })
    fs.writeFileSync(cleanEntry, 'module.exports = { tampered: true }\n', 'utf8')
    await expect(dm2.resolveVerifiedAdapter('custom')).rejects.toThrow(/SHA-256|changed|mismatch/i)
  })

  it('Perf #1: worker entry, session-manager, and rpc-query-tx have zero static vendor driver imports', () => {
    const workerDir = path.resolve(process.cwd(), 'src/worker')
    const indexSrc = fs.readFileSync(path.join(workerDir, 'index.ts'), 'utf8')
    const sessionMgrSrc = fs.readFileSync(path.join(workerDir, 'session-manager.ts'), 'utf8')
    const rpcQueryTxSrc = fs.readFileSync(path.join(workerDir, 'rpc-query-tx.ts'), 'utf8')

    expect(sessionMgrSrc).toContain("from '../drivers/lazy-loader'")
    expect(sessionMgrSrc).not.toMatch(/from\s+['"]\.\.\/drivers['"]/)
    expect(rpcQueryTxSrc).not.toMatch(/from\s+['"]\.\.\/drivers\/(?:mssql|oracle|postgres|mysql|mongodb)\/driver['"]/)
    expect(rpcQueryTxSrc).toContain("from '../drivers/common/mssql-sql'")
    expect(rpcQueryTxSrc).toContain("from '../drivers/common/oracle-sql'")
    expect(indexSrc).not.toMatch(/vendor\/(?:pg|mysql2|mongodb|mssql|oracledb)\.js/)
  })

  it('Perf #4: exports 8000/4000 IPC truncation constants and bounds cached prefix/suffix while keeping full secret guard', async () => {
    expect(AI_RPC_MAX_PREFIX_CHARS).toBe(8000)
    expect(AI_RPC_MAX_SUFFIX_CHARS).toBe(4000)

    const host = createMockOrcaHost({
      settings: {
        aiEnabled: true,
        aiFormat: 'openai',
        aiBaseUrl: 'https://api.openai.com/v1',
        aiModel: 'gpt-4o-mini',
      },
      storage: { 'datanoa.ai.keyAddress': 'https://api.openai.com/v1' },
      secrets: { ai_api_key: 'sk-valid-key-1234567890123456' },
    })
    let fetchCalls = 0
    registerAiHandlers({
      orca: host.orca,
      registerHandler: host.registerHandler,
      sessionManager: { assertSecureSecretStorage: async () => {} } as unknown as SessionManager,
      schemaCache: new WorkerSchemaMetadataCache(),
      fetchPost: async () => {
        fetchCalls += 1
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: 'id FROM users;' } }] }),
          text: async () => '',
        }
      },
    })

    const tail = '-- query\n'.repeat(1000) + 'SELECT '
    const p1 = '-- header A\n' + tail
    const p2 = '-- header B\n' + tail
    expect(p1.length).toBeGreaterThan(AI_RPC_MAX_PREFIX_CHARS)
    expect(p1.slice(-AI_RPC_MAX_PREFIX_CHARS)).toBe(p2.slice(-AI_RPC_MAX_PREFIX_CHARS))

    const r1 = await host.call<{ suggestion: string }>('ai.complete', {
      connectionId: 'c1',
      dialect: 'postgres',
      prefix: p1,
      suffix: ' FROM orders',
    })
    const r2 = await host.call<{ suggestion: string }>('ai.complete', {
      connectionId: 'c1',
      dialect: 'postgres',
      prefix: p2,
      suffix: ' FROM orders',
    })
    expect(r1.suggestion).toBe('id FROM users;')
    expect(r2.suggestion).toBe('id FROM users;')
    expect(fetchCalls).toBe(1)
  })

  it('Perf #7: merges multi-schema objects in WorkerSchemaMetadataCache via schema.listObjects without losing prior schemas', async () => {
    const cache = new WorkerSchemaMetadataCache()
    const host = createMockOrcaHost()
    const bySchema: Record<string, SchemaObject[]> = {
      analytics: [{ name: 'events', schema: 'analytics', kind: 'table' }],
      public: [{ name: 'users', schema: 'public', kind: 'table' }],
    }
    const session = createFakeTxSession('postgres').session
    session.listObjects = async (schema?: string) => bySchema[schema ?? 'public'] ?? []
    const sessionManager = {
      findProfile: async () => ({ id: 'c_pg', name: 'PG', driver: 'postgres' as const }),
      getSession: async () => session,
    } as unknown as SessionManager

    registerDataAndSchemaHandlers({
      orca: host.orca,
      registerHandler: host.registerHandler,
      sessionManager,
      schemaCache: cache,
    })

    await host.call('schema.listObjects', { connectionId: 'c_pg', schema: 'analytics' })
    await host.call('schema.listObjects', { connectionId: 'c_pg', schema: 'public' })

    const snap1 = cache.getSnapshot('c_pg')
    expect(snap1?.objects.map((o) => `${o.schema}.${o.name}`)).toEqual([
      'analytics.events',
      'public.users',
    ])

    // Refreshing 'analytics' replaces stale analytics objects while preserving 'public'
    bySchema.analytics = [{ name: 'sessions', schema: 'analytics', kind: 'table' }]
    await host.call('schema.listObjects', { connectionId: 'c_pg', schema: 'analytics' })
    const snap2 = cache.getSnapshot('c_pg')
    expect(snap2?.objects.map((o) => `${o.schema}.${o.name}`)).toEqual([
      'public.users',
      'analytics.sessions',
    ])

    // Cap at 2000 objects per connection
    const hugeList: SchemaObject[] = Array.from({ length: 2200 }, (_, i) => ({
      name: `tbl_${i}`,
      schema: 'bulk',
      kind: 'table',
    }))
    cache.setObjects('c_pg', hugeList, 'bulk')
    expect(cache.getSnapshot('c_pg')?.objects.length).toBeLessThanOrEqual(2000)

    cache.invalidateConnection('c_pg')
    expect(cache.getSnapshot('c_pg')).toBeNull()
  })
})

describe('[v1.2.0 UX] Actionable TLS Self-Signed Certificate Error Hints', () => {
  it('appends actionable hint for Node TLS cert-verification errors idempotently without leaking secrets', () => {
    const tlsErrors = [
      'self signed certificate in certificate chain',
      'self-signed certificate',
      'Error: DEPTH_ZERO_SELF_SIGNED_CERT',
      'Error: SELF_SIGNED_CERT_IN_CHAIN',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'ERR_TLS_CERT_ALTNAME_INVALID',
      'unable to verify the first certificate',
    ]
    for (const msg of tlsErrors) {
      const enhanced = appendActionableTlsErrorHint(msg)
      expect(enhanced).toContain(msg)
      expect(enhanced).toContain(ACTIONABLE_TLS_CERT_ERROR_HINT)
      // Strictly idempotent — calling again never duplicates the hint
      expect(appendActionableTlsErrorHint(enhanced)).toBe(enhanced)
    }

    // Non-TLS errors remain untouched
    expect(appendActionableTlsErrorHint('password authentication failed for user "postgres"')).toBe(
      'password authentication failed for user "postgres"'
    )
    expect(appendActionableTlsErrorHint('connect ECONNREFUSED 127.0.0.1:5432')).toBe(
      'connect ECONNREFUSED 127.0.0.1:5432'
    )

    // Code-based and cause-based TLS errors trigger hint while scrubbing URI secrets first
    const secretTlsErr = Object.assign(
      new Error('postgres://admin:TopSecret99@db.example.com:5432/app: self signed certificate in certificate chain'),
      { code: 'SELF_SIGNED_CERT_IN_CHAIN' }
    )
    const scrubbed = scrubAndEnhanceWorkerError(secretTlsErr) as Error & { code?: string }
    expect(scrubbed).toBeInstanceOf(Error)
    expect(scrubbed.code).toBe('SELF_SIGNED_CERT_IN_CHAIN')
    expect(scrubbed.message).not.toContain('TopSecret99')
    expect(scrubbed.message).toContain(ACTIONABLE_TLS_CERT_ERROR_HINT)

    const causeErr = new Error('fetch failed') as Error & { cause?: unknown }
    causeErr.cause = Object.assign(new Error('unable to verify the first certificate'), {
      code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    })
    const enhancedCause = scrubAndEnhanceWorkerError(causeErr) as Error
    expect(enhancedCause.message).toContain(ACTIONABLE_TLS_CERT_ERROR_HINT)
  })

  it('surfaces actionable TLS hint through runDriverConnectionTest, connection.test, schema.listObjects, and query.run', async () => {
    // 1. runDriverConnectionTest wraps both returned test() failure and thrown createSession error
    const returnedRes = await runDriverConnectionTest(
      async () => ({
        ...createFakeTxSession('postgres').session,
        test: async () => ({ ok: false, message: 'self signed certificate in certificate chain' }),
      }),
      (err) => (err instanceof Error ? err.message : String(err))
    )
    expect(returnedRes.ok).toBe(false)
    expect(returnedRes.message).toContain(ACTIONABLE_TLS_CERT_ERROR_HINT)
    expect(returnedRes.message?.split(ACTIONABLE_TLS_CERT_ERROR_HINT).length).toBe(2)

    const thrownRes = await runDriverConnectionTest(
      async () => {
        throw Object.assign(new Error('certificate verify failed'), {
          code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
        })
      },
      (err) => (err instanceof Error ? err.message : String(err))
    )
    expect(thrownRes.ok).toBe(false)
    expect(thrownRes.message).toContain(ACTIONABLE_TLS_CERT_ERROR_HINT)

    // 2. Worker RPC handlers (connection.test, schema.listObjects, query.run)
    const host = createMockOrcaHost()
    const profile: ConnectionProfile = {
      id: 'conn_tls_pg',
      name: 'Cloud PG',
      driver: 'postgres',
      host: 'aws-0-ap-southeast-1.pooler.supabase.com',
      port: 5432,
      database: 'postgres',
    }
    const failingSession = createFakeTxSession('postgres').session
    failingSession.listObjects = async () => {
      throw Object.assign(new Error('self signed certificate in certificate chain'), {
        code: 'SELF_SIGNED_CERT_IN_CHAIN',
      })
    }
    failingSession.runQuery = async () => {
      throw new Error('self signed certificate in certificate chain')
    }

    const sessionManager = {
      findProfile: async () => profile,
      getStoredConnections: async () => [profile],
      saveStoredConnections: async () => {},
      getSession: async () => failingSession,
      getExtendedSecrets: async () => ({}),
      getSecret: async () => undefined,
      closeSession: async () => {},
      closeSessionsByDriver: async () => {},
      testConnection: async () => ({
        ok: false,
        message: 'self signed certificate in certificate chain',
      }),
    } as unknown as SessionManager

    const driverManager = new DriverManager(host.orca.storage, host.orca.log)
    registerConnectionHandlers({
      orca: host.orca,
      registerHandler: host.registerHandler,
      sessionManager,
      driverManager,
    })
    registerDataAndSchemaHandlers({
      orca: host.orca,
      registerHandler: host.registerHandler,
      sessionManager,
    })
    registerQueryAndTxHandlers({
      orca: host.orca,
      registerHandler: host.registerHandler,
      sessionManager,
      tracker: createQueryRuntimeTracker(),
    })

    const testRes = await host.call<{ ok: boolean; message?: string }>('connection.test', {
      profile,
    })
    expect(testRes.ok).toBe(false)
    expect(testRes.message).toContain(ACTIONABLE_TLS_CERT_ERROR_HINT)
    expect(testRes.message?.split(ACTIONABLE_TLS_CERT_ERROR_HINT).length).toBe(2)

    await expect(
      host.call('schema.listObjects', { connectionId: profile.id })
    ).rejects.toThrow(ACTIONABLE_TLS_CERT_ERROR_HINT)

    await expect(
      host.call('query.run', { connectionId: profile.id, sql: 'SELECT 1' })
    ).rejects.toThrow(ACTIONABLE_TLS_CERT_ERROR_HINT)
  })
})
