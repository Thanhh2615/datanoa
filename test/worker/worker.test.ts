import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { MockOrcaRuntime } from '../e2e/harness/mock-orca-runtime'
import { createTestSqliteDatabase, type SqliteTestDatabase } from '../e2e/harness/test-db-fixtures'
import {
  ACTIVE_CONNECTION_STORAGE_KEY,
  type ConnectionProfile,
  type PluginRequests,
  type QueryResult,
  type TableBrowseResult,
  type TableDetails,
} from '../../src/protocol'
import activate, {
  deactivate,
  detectWorkspaceEnvConnections,
  discoverWorkspaceSqliteFiles,
  isBlockedScanRoot,
  scanDirectoryForSqliteFiles,
  SessionManager,
} from '../../src/worker/index'
import { SchemaInspectorView } from '../../src/editor/schema-inspector'
import { SqliteDriver } from '../../src/drivers/sqlite/driver'
import {
  buildCreateTableSql,
  buildDropTableSql,
  buildTruncateTableSql,
} from '../../src/drivers/common/sql-tools'

function invokeWorker<K extends keyof PluginRequests>(
  runtime: MockOrcaRuntime,
  name: K,
  input?: PluginRequests[K]['input']
): Promise<PluginRequests[K]['output']> {
  return (runtime.client.request as (n: string, i?: unknown) => Promise<PluginRequests[K]['output']>)(
    name,
    input
  )
}

describe('Datanoa Trusted Worker: RPC Handlers & Real Driver Integration', () => {
  let runtime: MockOrcaRuntime
  let testDb: SqliteTestDatabase
  let dbProfile: ConnectionProfile

  beforeEach(async () => {
    runtime = new MockOrcaRuntime()
    testDb = createTestSqliteDatabase({ inMemory: false, seed: true })

    dbProfile = {
      id: 'conn-worker-sqlite',
      name: 'Worker Test SQLite',
      driver: 'sqlite',
      database: 'test.db',
      filePath: testDb.filePath,
      readOnly: false,
    }

    // Activate the real worker under test
    activate(runtime.getWorkerApi() as any)
  })

  afterEach(async () => {
    await deactivate()
    testDb.cleanup()
    runtime.reset()
  })

  // =========================================================================
  // 1. connections.list & Auto-Discovery
  // =========================================================================
  describe('1. connections.list & SQLite Discovery', () => {
    it('returns empty list initially when no connections are saved', async () => {
      const list = await runtime.client.request('connections.list')
      expect(Array.isArray(list)).toBe(true)
      expect(list).toHaveLength(0)
    })

    it('returns saved connection profiles stripped of sensitive passwords', async () => {
      await runtime.client.request('connection.save', {
        profile: {
          id: 'conn-pg-secret',
          name: 'PostgreSQL Prod',
          driver: 'postgres',
          database: 'production',
          host: 'db.example.com',
          port: 5432,
          user: 'postgres',
          hasPassword: true,
        },
        password: 'TopSecretPassword999',
      })

      const list = await runtime.client.request('connections.list')
      expect(list).toHaveLength(1)
      const item = list[0]
      expect(item.id).toBe('conn-pg-secret')
      expect(item.hasPassword).toBe(true)
      expect((item as any).password).toBeUndefined()
      expect((item as any).rawPassword).toBeUndefined()

      // Verify password stored in encrypted secrets vault
      const secret = await runtime.getWorkerApi().secrets.get('pwd_conn-pg-secret')
      expect(secret).toBe('TopSecretPassword999')
    })

    it('scans and discovers workspace SQLite files asynchronously', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'datanoa-worker-scan-'))
      try {
        fs.writeFileSync(path.join(tempDir, 'app_cache.sqlite3'), '')
        fs.writeFileSync(path.join(tempDir, 'data.db'), '')

        const discovered = await scanDirectoryForSqliteFiles(tempDir)
        expect(discovered).toHaveLength(2)
        const names = discovered.map((d) => d.profile.database)
        expect(names).toContain('app_cache.sqlite3')
        expect(names).toContain('data.db')
        expect(discovered[0].profile.driver).toBe('sqlite')
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true })
      }
    })

    it('blocks homedir, filesystem roots, and AppData in isBlockedScanRoot and discoverWorkspaceSqliteFiles', async () => {
      expect(isBlockedScanRoot(os.homedir())).toBe(true)
      expect(isBlockedScanRoot(path.parse(process.cwd()).root)).toBe(true)
      expect(isBlockedScanRoot('/')).toBe(true)
      expect(isBlockedScanRoot(path.join(os.homedir(), 'AppData'))).toBe(true)

      const tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'datanoa-ws-filter-'))
      try {
        expect(isBlockedScanRoot(tempWorkspace)).toBe(false)

        fs.writeFileSync(path.join(tempWorkspace, 'valid.db'), '')
        fs.mkdirSync(path.join(tempWorkspace, 'node_modules'), { recursive: true })
        fs.writeFileSync(path.join(tempWorkspace, 'node_modules', 'ignored.db'), '')
        fs.mkdirSync(path.join(tempWorkspace, '.venv'), { recursive: true })
        fs.writeFileSync(path.join(tempWorkspace, '.venv', 'ignored2.db'), '')

        // Depth > 4 should be skipped
        const deepDir = path.join(tempWorkspace, 'd1', 'd2', 'd3', 'd4', 'd5')
        fs.mkdirSync(deepDir, { recursive: true })
        fs.writeFileSync(path.join(deepDir, 'too_deep.db'), '')

        const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'datanoa-remote-ws-'))
        try {
          fs.writeFileSync(path.join(remoteDir, 'remote.db'), '')
          const mockOrca = {
            host: {
              has: (m: string) => m === 'workspace.list',
              call: async (m: string) => {
                if (m === 'workspace.list') {
                  return {
                    workspaces: [
                      { id: 'w-home', path: os.homedir(), hostId: 'local' },
                      { id: 'w-app', path: path.join(os.homedir(), 'AppData'), hostId: 'local' },
                      { id: 'w-ssh', path: remoteDir, hostId: 'ssh:prod' },
                      { id: 'w-ok', path: tempWorkspace, hostId: 'local' },
                    ],
                  }
                }
                return {}
              },
            },
          }

          const started = performance.now()
          const found = await discoverWorkspaceSqliteFiles(mockOrca as any)
          const elapsed = performance.now() - started

          expect(elapsed).toBeLessThan(850)
          expect(found.map((f) => f.filePath)).toEqual([path.resolve(path.join(tempWorkspace, 'valid.db'))])
        } finally {
          fs.rmSync(remoteDir, { recursive: true, force: true })
        }
      } finally {
        fs.rmSync(tempWorkspace, { recursive: true, force: true })
      }
    })

    it('detects root-only .env database URIs via workspace.detectConnections and skips nested .env and non-DB URLs', async () => {
      const envDir = fs.mkdtempSync(path.join(os.tmpdir(), 'datanoa-env-detect-'))
      try {
        fs.writeFileSync(path.join(envDir, 'local.db'), '')
        fs.writeFileSync(
          path.join(envDir, '.env'),
          [
            '# comment',
            'export DATABASE_URL="postgres://app:pw@db.internal:5432/core?sslmode=require"',
            'NEXT_PUBLIC_API_URL=https://api.example.com/v1',
            'CLICKHOUSE_URL=https://default:chpass@ch.example.com:8443/metrics',
          ].join('\n'),
          'utf8'
        )
        fs.writeFileSync(
          path.join(envDir, '.env.local'),
          [
            'REDIS_URL=rediss://default:tok@cache.upstash.io:6379/2',
            'TURSO_DATABASE_URL=libsql://edge-db.turso.io?authToken=jwt_tok_123',
            // Duplicate of .env DATABASE_URL should deduplicate
            'POSTGRES_URL=postgres://app:pw@db.internal:5432/core?sslmode=require',
          ].join('\n'),
          'utf8'
        )
        fs.mkdirSync(path.join(envDir, 'nested'), { recursive: true })
        fs.writeFileSync(
          path.join(envDir, 'nested', '.env'),
          'MYSQL_URL=mysql://root:pass@127.0.0.1:3306/ignored_nested\n',
          'utf8'
        )

        const directEnv = await detectWorkspaceEnvConnections([envDir])
        expect(directEnv.map((e) => e.driver)).toEqual(['postgres', 'clickhouse', 'redis', 'libsql'])

        const started = performance.now()
        const res = await invokeWorker(runtime, 'workspace.detectConnections', {
          folderPath: envDir,
        })
        const elapsed = performance.now() - started

        expect(elapsed).toBeLessThan(800)
        expect(res.sqliteFiles).toHaveLength(1)
        expect(res.sqliteFiles[0].filePath).toBe(path.resolve(path.join(envDir, 'local.db')))
        expect(res.envConnections).toHaveLength(4)
        expect(res.envConnections.map((e) => e.envKey)).toEqual([
          'DATABASE_URL',
          'CLICKHOUSE_URL',
          'REDIS_URL',
          'TURSO_DATABASE_URL',
        ])
        expect(res.envConnections[0].sourceFile).toContain('.env')
        expect(res.envConnections[3].driver).toBe('libsql')
      } finally {
        fs.rmSync(envDir, { recursive: true, force: true })
      }
    })

    it('connections.list never crawls filesystem, purges legacy ws_ IDs, and returns in < 50ms', async () => {
      let hostCalled = false
      const workerApi = runtime.getWorkerApi()
      workerApi.host = {
        has: () => true,
        call: async () => {
          hostCalled = true
          throw new Error('connections.list must never call workspace.list!')
        },
      }
      await deactivate()
      activate(workerApi as any)

      // Seed storage with a legacy ws_ entry alongside a real saved connection
      await workerApi.storage.set('datanoa.savedConnections', [
        {
          id: 'ws_legacy123',
          name: 'Legacy Workspace DB',
          driver: 'sqlite',
          database: 'legacy.db',
          filePath: '/tmp/legacy.db',
        },
        {
          id: 'conn-real-1',
          name: 'Real Saved DB',
          driver: 'libsql',
          database: 'app',
          url: 'https://db.turso.io',
          hasAuthToken: true,
          colorTag: 'prod',
          readOnly: true,
        },
      ] as any)

      const started = performance.now()
      const list = await invokeWorker(runtime, 'connections.list')
      const elapsed = performance.now() - started

      expect(hostCalled).toBe(false)
      expect(elapsed).toBeLessThan(50)
      expect(list).toHaveLength(1)
      expect(list[0]).toMatchObject({
        id: 'conn-real-1',
        driver: 'libsql',
        url: 'https://db.turso.io',
        hasAuthToken: true,
        colorTag: 'prod',
        readOnly: true,
      })

      // Legacy ws_ should have been purged from storage
      const persisted = (await workerApi.storage.get(
        'datanoa.savedConnections'
      )) as unknown as ConnectionProfile[]
      expect(persisted.some((p) => p.id.startsWith('ws_'))).toBe(false)
    })
  })

  // =========================================================================
  // 2. connection.save & connection.delete
  // =========================================================================
  describe('2. connection.save & connection.delete', () => {
    it('saves a connection profile and emits connections.changed event', async () => {
      let eventPayload: unknown = null
      runtime.client.on('connections.changed', (payload) => {
        eventPayload = payload
      })

      const res = await invokeWorker(runtime, 'connection.save', {
        profile: dbProfile,
      })

      expect(res.ok).toBe(true)
      expect(res.id).toBe(dbProfile.id)
      expect(eventPayload).toEqual({ count: 1 })

      const list = await runtime.client.request('connections.list')
      expect(list).toHaveLength(1)
      expect(list[0].id).toBe(dbProfile.id)
    })

    it('generates an ID if not supplied in profile', async () => {
      const res = await runtime.client.request('connection.save', {
        profile: {
          id: '',
          name: 'Auto-ID Conn',
          driver: 'sqlite',
          database: ':memory:',
        },
      })

      expect(res.ok).toBe(true)
      expect(res.id).toMatch(/^conn_sqlite_/)
    })

    it('rejects connection.save with invalid_params if profile or driver is missing', async () => {
      await expect(
        runtime.client.request('connection.save', {} as any)
      ).rejects.toMatchObject({ code: 'invalid_params' })
    })

    it('deletes connection, purges secret, and emits connections.changed', async () => {
      await invokeWorker(runtime, 'connection.save', {
        profile: dbProfile,
        password: 'sample_password',
      })

      expect(await runtime.getWorkerApi().secrets.get(`pwd_${dbProfile.id}`)).toBe('sample_password')

      let changedPayload: unknown = null
      runtime.client.on('connections.changed', (payload) => {
        changedPayload = payload
      })

      const delRes = await runtime.client.request('connection.delete', { id: dbProfile.id })
      expect(delRes.ok).toBe(true)
      expect(changedPayload).toEqual({ count: 0 })

      expect(await runtime.getWorkerApi().secrets.get(`pwd_${dbProfile.id}`)).toBeNull()
      const list = await runtime.client.request('connections.list')
      expect(list).toHaveLength(0)
    })

    it('supports all 8 drivers, stores colorTag/url/redisDb/tok_ secrets, and exposes connection.parseUri', async () => {
      const parsed = await invokeWorker(runtime, 'connection.parseUri', {
        uri: 'libsql://edge-db.turso.io?authToken=turso_secret_jwt',
      })
      expect(parsed.ok).toBe(true)
      expect(parsed.authToken).toBe('turso_secret_jwt')
      expect(parsed.profile?.driver).toBe('libsql')

      const badParse = await invokeWorker(runtime, 'connection.parseUri', { uri: 'oracle://bad' })
      expect(badParse.ok).toBe(false)
      expect(badParse.error).toBeTruthy()

      const savedTurso = await invokeWorker(runtime, 'connection.save', {
        profile: {
          id: 'conn-libsql-1',
          name: 'Turso Prod',
          driver: 'libsql',
          database: 'edge-db',
          url: 'https://edge-db.turso.io',
          colorTag: 'prod',
          readOnly: true,
        },
        authToken: 'turso_secret_jwt',
      })
      expect(savedTurso.ok).toBe(true)
      expect(await runtime.getWorkerApi().secrets.get('tok_conn-libsql-1')).toBe('turso_secret_jwt')

      const savedRedis = await invokeWorker(runtime, 'connection.save', {
        profile: {
          id: 'conn-redis-1',
          name: 'Upstash Staging',
          driver: 'redis',
          database: '3',
          host: 'cache.example.com',
          port: 6379,
          redisDb: 3,
          ssl: true,
          colorTag: 'staging',
        },
        password: 'redis_pw',
      })
      expect(savedRedis.ok).toBe(true)
      expect(await runtime.getWorkerApi().secrets.get('pwd_conn-redis-1')).toBe('redis_pw')

      // Save remaining multi-engine profiles to verify 8-driver acceptance
      for (const drv of ['mariadb', 'cockroachdb', 'clickhouse'] as const) {
        const res = await invokeWorker(runtime, 'connection.save', {
          profile: {
            id: `conn-${drv}`,
            name: drv,
            driver: drv,
            database: 'default',
            host: '127.0.0.1',
            colorTag: 'dev',
          },
        })
        expect(res.ok).toBe(true)
      }

      const list = await invokeWorker(runtime, 'connections.list')
      const libsqlItem = list.find((c) => c.id === 'conn-libsql-1')
      const redisItem = list.find((c) => c.id === 'conn-redis-1')
      expect(libsqlItem).toMatchObject({
        driver: 'libsql',
        url: 'https://edge-db.turso.io',
        hasAuthToken: true,
        colorTag: 'prod',
        readOnly: true,
      })
      expect((libsqlItem as any).authToken).toBeUndefined()
      expect(redisItem).toMatchObject({
        driver: 'redis',
        redisDb: 3,
        colorTag: 'staging',
        hasPassword: true,
      })

      // Reject unsupported driver
      await expect(
        invokeWorker(runtime, 'connection.save', {
          profile: {
            id: 'conn-bad',
            name: 'Oracle',
            driver: 'oracle' as any,
            database: 'orcl',
          },
        })
      ).rejects.toMatchObject({ code: 'invalid_params' })

      // Delete purges both tok_ and pwd_ secrets
      await invokeWorker(runtime, 'connection.delete', { id: 'conn-libsql-1' })
      expect(await runtime.getWorkerApi().secrets.get('tok_conn-libsql-1')).toBeNull()
    })
  })

  // =========================================================================
  // 3. connection.test
  // =========================================================================
  describe('3. connection.test', () => {
    it('verifies connectivity against a real SQLite database file', async () => {
      const res = await invokeWorker(runtime, 'connection.test', {
        profile: dbProfile,
      })
      expect(res.ok).toBe(true)
      expect(res.message).toBeDefined()
    })

    it('rejects connection.test without driver', async () => {
      await expect(
        runtime.client.request('connection.test', { profile: {} as any })
      ).rejects.toMatchObject({ code: 'invalid_params' })
    })
  })

  // =========================================================================
  // 4. Schema Introspection: listObjects & tableDetails
  // =========================================================================
  describe('4. Schema Introspection', () => {
    beforeEach(async () => {
      await invokeWorker(runtime, 'connection.save', { profile: dbProfile })
    })

    it('lists tables and views via schema.listObjects', async () => {
      const objects = await runtime.client.request('schema.listObjects', {
        connectionId: dbProfile.id,
      })

      expect(Array.isArray(objects)).toBe(true)
      expect(objects.length).toBeGreaterThanOrEqual(3)
      const tableNames = objects.map((o) => o.name)
      expect(tableNames).toContain('customers')
      expect(tableNames).toContain('products')
      expect(tableNames).toContain('orders')
    })

    it('inspects detailed column metadata and primary keys via schema.tableDetails', async () => {
      const details = (await runtime.client.request('schema.tableDetails', {
        connectionId: dbProfile.id,
        table: 'customers',
      })) as TableDetails

      expect(details.name).toBe('customers')
      expect(details.kind).toBe('table')
      expect(details.primaryKey).toEqual(['id'])
      expect(details.columns.length).toBeGreaterThanOrEqual(4)

      const idCol = details.columns.find((c) => c.name === 'id')
      expect(idCol?.isPrimaryKey).toBe(true)

      const emailCol = details.columns.find((c) => c.name === 'email')
      expect(emailCol).toBeDefined()
    })

    it('rejects schema.tableDetails for non-existent table with invalid_params', async () => {
      await expect(
        runtime.client.request('schema.tableDetails', {
          connectionId: dbProfile.id,
          table: '',
        })
      ).rejects.toMatchObject({ code: 'invalid_params' })
    })
  })

  // =========================================================================
  // 5. Data Browsing & Inline Editing
  // =========================================================================
  describe('5. Data Browsing & Inline Editing', () => {
    beforeEach(async () => {
      await invokeWorker(runtime, 'connection.save', { profile: dbProfile })
    })

    it('fetches paginated rows via data.fetchPage', async () => {
      const page = (await runtime.client.request('data.fetchPage', {
        connectionId: dbProfile.id,
        table: 'customers',
        page: 1,
        pageSize: 2,
        sortColumn: 'id',
        sortDirection: 'ASC',
      })) as TableBrowseResult

      expect(page.page).toBe(1)
      expect(page.pageSize).toBe(2)
      expect(page.totalRows).toBe(3)
      expect(page.rows).toHaveLength(2)
      expect(page.canEdit).toBe(true)
      expect(page.primaryKey).toEqual(['id'])
    })

    it('updates a cell with optimistic concurrency locking via data.updateCell', async () => {
      let cellUpdatedPayload: unknown = null
      runtime.client.on('data.cellUpdated', (payload) => {
        cellUpdatedPayload = payload
      })

      const updateRes = await runtime.client.request('data.updateCell', {
        connectionId: dbProfile.id,
        table: 'customers',
        primaryKeys: { id: 1 },
        column: 'name',
        newValue: 'Nguyễn Văn An Updated',
        originalValue: 'Nguyễn Văn An',
      })

      expect(updateRes.ok).toBe(true)
      expect(updateRes.affectedRows).toBe(1)
      expect(updateRes.updatedRecord).toBeDefined()
      expect(updateRes.updatedRecord?.name).toBe('Nguyễn Văn An Updated')

      expect(cellUpdatedPayload).toEqual({
        connectionId: dbProfile.id,
        table: 'customers',
        primaryKeys: { id: 1 },
        column: 'name',
      })

      // Attempt concurrent update with stale originalValue -> expect conflict
      await expect(
        runtime.client.request('data.updateCell', {
          connectionId: dbProfile.id,
          table: 'customers',
          primaryKeys: { id: 1 },
          column: 'name',
          newValue: 'Nguyễn Văn An Double Update',
          originalValue: 'Nguyễn Văn An', // Stale!
        })
      ).rejects.toMatchObject({ code: 'conflict' })
    })
  })

  // =========================================================================
  // 6. Query Execution & Cancellation
  // =========================================================================
  describe('6. Query Execution & Cancellation', () => {
    beforeEach(async () => {
      await invokeWorker(runtime, 'connection.save', { profile: dbProfile })
    })

    it('executes SELECT query with structured result and timing', async () => {
      const res = (await runtime.client.request('query.run', {
        connectionId: dbProfile.id,
        queryId: 'q-sel-worker-1',
        sql: 'SELECT id, name, email FROM customers ORDER BY id ASC;',
      })) as QueryResult

      expect(res.isSelect).toBe(true)
      expect(res.rowCount).toBe(3)
      expect(res.rows).toHaveLength(3)
      expect(res.columns.map((c) => c.name)).toEqual(['id', 'name', 'email'])
      expect(res.truncated).toBe(false)
      expect(typeof res.executionTimeMs).toBe('number')
    })

    it('executes DML statements and reports affectedRows', async () => {
      const res = (await runtime.client.request('query.run', {
        connectionId: dbProfile.id,
        queryId: 'q-dml-worker-1',
        sql: "INSERT INTO categories (name, slug) VALUES ('Automated Test', 'auto-test');",
      })) as QueryResult

      expect(res.isSelect).toBe(false)
      expect(res.affectedRows).toBe(1)
      expect(res.rowCount).toBe(0)
    })

    it('enforces row limit ceiling and flags truncated result', async () => {
      const res = (await runtime.client.request('query.run', {
        connectionId: dbProfile.id,
        queryId: 'q-trunc-worker-1',
        sql: 'SELECT * FROM customers ORDER BY id ASC;',
        maxRows: 2,
      })) as QueryResult

      expect(res.isSelect).toBe(true)
      expect(res.rowCount).toBe(2)
      expect(res.rows).toHaveLength(2)
      expect(res.truncated).toBe(true)
    })

    it('cancels queries via query.cancel', async () => {
      const cancelRes = await runtime.client.request('query.cancel', {
        queryId: 'q-cancel-target-1',
      })
      expect(cancelRes.ok).toBe(true)
    })

    it('rejects query.run with empty SQL as invalid_params', async () => {
      await expect(
        runtime.client.request('query.run', {
          connectionId: dbProfile.id,
          queryId: 'q-empty',
          sql: '   ',
        })
      ).rejects.toMatchObject({ code: 'invalid_params' })
    })

    it('discovers dotfile .db databases and resolves folder paths in sqlite.scanFolder', async () => {
      const sourcePath = testDb.filePath!
      const dirPath = path.dirname(sourcePath)
      const dotDbPath = path.join(dirPath, '.db')
      fs.copyFileSync(sourcePath, dotDbPath)

      const scanRes = (await (runtime.client.request as any)('sqlite.scanFolder', {
        folderPath: dirPath,
      })) as { files: Array<{ name: string; filePath: string; sizeBytes: number }> }

      expect(scanRes.files.some((f) => f.filePath === path.resolve(dotDbPath))).toBe(true)

      // Passing folder path to connection.test should auto-resolve to .db inside folder
      const testFolderRes = (await runtime.client.request('connection.test', {
        profile: {
          id: 'conn_folder_resolve',
          name: 'Folder DB',
          driver: 'sqlite',
          database: '.db',
          filePath: dirPath,
        },
      })) as { ok: boolean }
      expect(testFolderRes.ok).toBe(true)
    })

    it('strips undefined keys and normalizes null-prototype objects in worker responses', async () => {
      const list = (await runtime.client.request('connections.list')) as ConnectionProfile[]
      for (const item of list) {
        expect(Object.getPrototypeOf(item)).toBe(Object.prototype)
        for (const [, val] of Object.entries(item)) {
          expect(val).not.toBeUndefined()
        }
      }
    })

    it('generates collision-free ws_ IDs in scanDirectoryForSqliteFiles while findProfile reads storage only', async () => {
      const subDir = path.join(path.dirname(testDb.filePath!), 'multi-db-folder')
      fs.mkdirSync(subDir, { recursive: true })
      const dbA = path.join(subDir, '.db')
      const dbB = path.join(subDir, 'accounts.db')
      const dbC = path.join(subDir, 'logs.sqlite')
      fs.copyFileSync(testDb.filePath!, dbA)
      fs.copyFileSync(testDb.filePath!, dbB)
      fs.copyFileSync(testDb.filePath!, dbC)

      const discovered = await scanDirectoryForSqliteFiles(subDir)
      expect(discovered).toHaveLength(3)
      const ids = discovered.map((d) => d.profile.id)
      expect(new Set(ids).size).toBe(3)
      ids.forEach((id) => expect(id.startsWith('ws_')).toBe(true))

      let workspaceListCalls = 0
      const mockOrca = {
        storage: { get: async () => [] },
        secrets: { get: async () => null, set: async () => {}, delete: async () => {} },
        host: {
          has: (m: string) => m === 'workspace.list',
          call: async () => {
            workspaceListCalls++
            return { workspaces: [{ path: subDir, hostId: 'local' }] }
          },
        },
        log: () => {},
      }
      const manager = new SessionManager(mockOrca as any)
      for (const item of discovered) {
        const resolved = await manager.findProfile(item.profile.id)
        expect(resolved).toBeNull()
      }
      expect(workspaceListCalls).toBe(0)
    })

    it('escapes HTML in SchemaInspectorView column, FK, and index metadata', () => {
      const createdNodes: Array<{ innerHTML: string; className: string; style: Record<string, string>; textContent: string; appendChild: (c: unknown) => void }> = []
      const makeNode = () => {
        const node = {
          innerHTML: '',
          className: '',
          style: {} as Record<string, string>,
          textContent: '',
          appendChild: () => {},
        }
        createdNodes.push(node)
        return node
      }
      const prevDoc = (globalThis as any).document
      ;(globalThis as any).document = { createElement: () => makeNode() }

      try {
        const root = makeNode()
        const view = new SchemaInspectorView(root as any)
        const payload: TableDetails = {
          name: 'users<script>',
          schema: 'main',
          kind: 'table',
          primaryKey: ['id'],
          columns: [
            {
              name: '<img src=x onerror=alert(1)>',
              type: 'TEXT<script>',
              nativeType: 'VARCHAR<svg>',
              nullable: false,
              defaultValue: '<script>evil()</script>',
              isPrimaryKey: false,
              isAutoIncrement: false,
            },
          ],
          indexes: [
            {
              name: 'idx_<script>',
              columns: ['<img src=x>'],
              isUnique: true,
              isPrimary: false,
            },
          ],
          foreignKeys: [
            {
              constraintName: 'fk_<script>',
              column: '<col>',
              referencedTable: '<refTable>',
              referencedColumn: '<refCol>',
            },
          ],
        }
        view.setDetails(payload)

        const renderedHtml = createdNodes.map((n) => n.innerHTML).join('\n')
        expect(renderedHtml).not.toContain('<script>')
        expect(renderedHtml).not.toContain('<img ')
        expect(renderedHtml).not.toContain('<svg>')
        expect(renderedHtml).toContain('&lt;img src=x onerror=alert(1)&gt;')
        expect(renderedHtml).toContain('&lt;script&gt;evil()&lt;/script&gt;')
        expect(renderedHtml).toContain('fk_&lt;script&gt;')
        expect(renderedHtml).toContain('&lt;refTable&gt;')
      } finally {
        if (prevDoc === undefined) {
          delete (globalThis as any).document
        } else {
          ;(globalThis as any).document = prevDoc
        }
      }
    })

    it('exposes required custom HTML panel controls and avoids eval/new Function', () => {
      const panelHtml = fs.readFileSync(
        path.resolve(__dirname, '../../src/panel/panel.html'),
        'utf-8'
      )
      expect(panelHtml).toContain('id="newServerBtn"')
      expect(panelHtml).toContain('id="openStudioBtn"')
      expect(panelHtml).toContain('id="refreshBtn"')
      expect(panelHtml).toContain('id="confirmDeleteModal"')
      expect(panelHtml).toContain('id="inspectCellBtn"')
      expect(panelHtml).toContain('id="emptyAddConnBtn"')
      expect(panelHtml).toContain('id="cancelSqlBtn"')
      expect(panelHtml).toContain('id="structureFkWrap"')
      expect(panelHtml).toContain('id="structureFkList"')
      expect(panelHtml).toContain('foreignKeys')

      expect(panelHtml).not.toContain('id="liveDot"')
      expect(panelHtml).not.toContain('id="openSqliteBtn"')
      expect(panelHtml).not.toContain('id="scanHeaderBtn"')
      expect(panelHtml).not.toContain('id="newQueryBtn"')
      expect(panelHtml).not.toContain('id="studioActiveBtn"')
      expect(panelHtml).not.toContain('id="copyExportBtn"')

      expect(panelHtml).not.toMatch(/\beval\s*\(/)
      expect(panelHtml).not.toContain('new Function')
    })

    it('sanitizes non-finite and out-of-range page/pageSize inputs in data.fetchPage', async () => {
      const resNonFinite = (await runtime.client.request('data.fetchPage', {
        connectionId: dbProfile.id,
        table: 'customers',
        page: Number.NaN,
        pageSize: Infinity,
      })) as TableBrowseResult
      expect(resNonFinite.page).toBe(1)
      expect(resNonFinite.pageSize).toBe(50)
      expect(resNonFinite.rows.length).toBeGreaterThan(0)

      const res5000 = (await runtime.client.request('data.fetchPage', {
        connectionId: dbProfile.id,
        table: 'customers',
        page: 1,
        pageSize: 5000,
      })) as TableBrowseResult
      expect(res5000.page).toBe(1)
      expect(res5000.pageSize).toBe(5000)

      const resClamped = (await runtime.client.request('data.fetchPage', {
        connectionId: dbProfile.id,
        table: 'customers',
        page: -3,
        pageSize: 50000,
      })) as TableBrowseResult
      expect(resClamped.page).toBe(1)
      expect(resClamped.pageSize).toBe(10000)
    })

    it('closes SqliteSession cleanly on concurrent close() calls and releases Windows file lock', async () => {
      const driver = new SqliteDriver()
      const isolatedPath = path.join(path.dirname(testDb.filePath!), 'close-lock-check.db')
      fs.copyFileSync(testDb.filePath!, isolatedPath)

      const session = await driver.createSession({
        id: 'conn_close_check',
        name: 'Close Lock Check',
        driver: 'sqlite',
        database: 'close-lock-check.db',
        filePath: isolatedPath,
        readOnly: false,
      })

      await session.runQuery('q_before_close', 'SELECT 1 AS ok;', 10)

      // Concurrent close() calls must resolve cleanly and release native SQLite handle
      await Promise.all([session.close(), session.close()])

      await expect(session.runQuery('q_after_close', 'SELECT 1;', 10)).rejects.toMatchObject({
        code: 'SESSION_CLOSED',
      })

      expect(() => fs.unlinkSync(isolatedPath)).not.toThrow()
    })
  })

  // =========================================================================
  // 7. Full Studio Tab Opener (studio.open)
  // =========================================================================
  describe('7. Full Studio Tab Opener (studio.open)', () => {
    it('returns actionable error when no local workspaces are open', async () => {
      const workerApi = runtime.getWorkerApi()
      workerApi.host = {
        has: (m: string) => m === 'workspace.list' || m === 'workspace.readContext',
        call: async (m: string) => {
          if (m === 'workspace.list') {
            return {
              workspaces: [
                { id: 'ws-ssh', kind: 'worktree', name: 'remote-app', path: '/srv/app', branch: 'main', hostId: 'ssh:box' },
              ],
            }
          }
          return null
        },
      }
      await deactivate()
      activate(workerApi as any)

      const res = await invokeWorker(runtime, 'studio.open', {})
      expect(res.ok).toBe(false)
      expect(res.message).toBe('Open a local workspace folder in Orca to launch Full Studio.')
    })

    it('matches focused context, prefers non-homedir fallback, writes .datanoa files with dialect SQL/Redis, and calls workspace.open + editor.open', async () => {
      const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'datanoa-studio-ws-'))
      const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'datanoa-studio-other-'))
      try {
        const hostCalls: Array<{ method: string; params: unknown }> = []
        let contextMode: 'byId' | 'byNameBranch' | 'fallback' = 'byId'

        const workerApi = runtime.getWorkerApi()
        workerApi.host = {
          has: () => true,
          call: async (method: string, params?: unknown) => {
            hostCalls.push({ method, params })
            if (method === 'workspace.list') {
              if (contextMode === 'fallback') {
                return {
                  workspaces: [
                    { id: 'ws-home', kind: 'folder', name: 'Home', path: os.homedir(), branch: null, hostId: 'local' },
                    { id: 'ws-proj', kind: 'worktree', name: 'datanoa', path: wsRoot, branch: 'feat/ui', hostId: 'local' },
                  ],
                }
              }
              return {
                workspaces: [
                  { id: 'ws-1', kind: 'worktree', name: 'repo', path: otherRoot, branch: 'main', hostId: 'local' },
                  { id: 'ws-2', kind: 'worktree', name: 'repo', path: wsRoot, branch: 'feat/oled', hostId: null },
                ],
              }
            }
            if (method === 'workspace.readContext') {
              if (contextMode === 'byId') {
                return { workspaceId: 'ws-2', displayName: 'repo', branch: 'main', terminals: [] }
              }
              if (contextMode === 'byNameBranch') {
                return { displayName: 'repo', branch: 'feat/oled', terminals: [] }
              }
              return null
            }
            if (method === 'workspace.open') {
              throw new Error('Already focused')
            }
            if (method === 'editor.open') {
              return { opened: true }
            }
            return {}
          },
        }

        await deactivate()
        activate(workerApi as any)

        // Save a MySQL and a Redis profile
        await invokeWorker(runtime, 'connection.save', {
          profile: {
            id: 'conn-mysql-studio',
            name: 'MySQL Studio',
            driver: 'mysql',
            database: 'shop',
            host: '127.0.0.1',
          },
        })
        await invokeWorker(runtime, 'connection.save', {
          profile: {
            id: 'conn-redis-studio',
            name: 'Redis Studio',
            driver: 'redis',
            database: '0',
            host: '127.0.0.1',
          },
        })

        // 1. Match by workspaceId -> ws-2 (wsRoot) with MySQL backticks and canonical studio.datanoa
        fs.mkdirSync(path.join(wsRoot, '.datanoa'), { recursive: true })
        fs.writeFileSync(path.join(wsRoot, '.datanoa', 'stale_table.datanoa'), 'stale', 'utf8')
        const res1 = await invokeWorker(runtime, 'studio.open', {
          connectionId: 'conn-mysql-studio',
          table: 'orders',
          schema: 'shop',
        })
        expect(res1).toEqual({ ok: true, path: '.datanoa/studio.datanoa' })
        expect(fs.existsSync(path.join(wsRoot, '.datanoa', 'stale_table.datanoa'))).toBe(false)
        expect(fs.readFileSync(path.join(wsRoot, '.datanoa', '.gitignore'), 'utf8')).toBe('*\n')
        const mysqlContent = fs.readFileSync(path.join(wsRoot, '.datanoa', 'studio.datanoa'), 'utf8')
        expect(mysqlContent).toContain('-- datanoa: connectionId=conn-mysql-studio')
        expect(mysqlContent).toContain('-- datanoa: table=orders')
        expect(mysqlContent).toContain('-- datanoa: schema=shop')
        expect(mysqlContent).toContain('SELECT * FROM `shop`.`orders` LIMIT 100;')
        expect(hostCalls.some((c) => c.method === 'workspace.open' && (c.params as any).workspaceId === 'ws-2')).toBe(true)
        expect(hostCalls.some((c) => c.method === 'editor.open' && (c.params as any).workspaceId === 'ws-2' && (c.params as any).path === '.datanoa/studio.datanoa')).toBe(true)

        // 2. Match by displayName + branch -> ws-2 with Redis default SCAN command
        contextMode = 'byNameBranch'
        hostCalls.length = 0
        const res2 = await invokeWorker(runtime, 'studio.open', {
          connectionId: 'conn-redis-studio',
        })
        expect(res2).toEqual({ ok: true, path: '.datanoa/studio.datanoa' })
        const redisContent = fs.readFileSync(path.join(wsRoot, '.datanoa', 'studio.datanoa'), 'utf8')
        expect(redisContent).toContain('SCAN 0 MATCH * COUNT 50')

        // 3. Fallback skips os.homedir() and chooses ws-proj, and resolves connectionId from active storage when omitted
        contextMode = 'fallback'
        hostCalls.length = 0
        const res3 = await invokeWorker(runtime, 'studio.open', {})
        expect(res3.ok).toBe(true)
        expect(hostCalls.some((c) => c.method === 'editor.open' && (c.params as any).workspaceId === 'ws-proj')).toBe(true)
        const studioFallbackContent = fs.readFileSync(
          path.join(wsRoot, '.datanoa', 'studio.datanoa'),
          'utf8'
        )
        expect(studioFallbackContent).toContain('-- datanoa: connectionId=conn-mysql-studio')

        // 4. Explicit ACTIVE_CONNECTION_STORAGE_KEY selection takes precedence when options.connectionId is omitted/empty
        await workerApi.storage.set(ACTIVE_CONNECTION_STORAGE_KEY, 'conn-redis-studio')
        const res4 = await invokeWorker(runtime, 'studio.open', { connectionId: '' })
        expect(res4.ok).toBe(true)
        const activeRedisContent = fs.readFileSync(
          path.join(wsRoot, '.datanoa', 'studio.datanoa'),
          'utf8'
        )
        expect(activeRedisContent).toContain('-- datanoa: connectionId=conn-redis-studio')
        expect(activeRedisContent).toContain('SCAN 0 MATCH * COUNT 50')

        // 5. Deleting active connection re-points ACTIVE_CONNECTION_STORAGE_KEY to remaining connection; deleting last clears it
        await invokeWorker(runtime, 'connection.delete', { id: 'conn-redis-studio' })
        expect(await workerApi.storage.get(ACTIVE_CONNECTION_STORAGE_KEY)).toBe('conn-mysql-studio')

        // Stale ACTIVE_CONNECTION_STORAGE_KEY falls back to list[0]?.id in studio.open
        await workerApi.storage.set(ACTIVE_CONNECTION_STORAGE_KEY, 'conn-does-not-exist')
        const res5 = await invokeWorker(runtime, 'studio.open', {})
        expect(res5.ok).toBe(true)
        const staleFallbackContent = fs.readFileSync(
          path.join(wsRoot, '.datanoa', 'studio.datanoa'),
          'utf8'
        )
        expect(staleFallbackContent).toContain('-- datanoa: connectionId=conn-mysql-studio')

        await invokeWorker(runtime, 'connection.delete', { id: 'conn-mysql-studio' })
        expect(await workerApi.storage.get(ACTIVE_CONNECTION_STORAGE_KEY)).toBeNull()
      } finally {
        fs.rmSync(wsRoot, { recursive: true, force: true })
        fs.rmSync(otherRoot, { recursive: true, force: true })
      }
    })

    it('reports editor.open failure cleanly and logs without throwing', async () => {
      const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'datanoa-studio-err-'))
      try {
        const workerApi = runtime.getWorkerApi()
        workerApi.host = {
          has: () => true,
          call: async (method: string) => {
            if (method === 'workspace.list') {
              return { workspaces: [{ id: 'ws-1', kind: 'folder', name: 'app', path: wsRoot, branch: null, hostId: 'local' }] }
            }
            if (method === 'workspace.readContext') return null
            if (method === 'workspace.open') return { opened: true }
            if (method === 'editor.open') throw new Error('Desktop window unavailable')
            return {}
          },
        }
        await deactivate()
        activate(workerApi as any)

        const res = await invokeWorker(runtime, 'studio.open', {})
        expect(res.ok).toBe(false)
        expect(res.message).toContain('Desktop window unavailable')
        expect(runtime.logs.some((l) => l.includes('studio.open'))).toBe(true)
      } finally {
        fs.rmSync(wsRoot, { recursive: true, force: true })
      }
    })
  })

  // =========================================================================
  // 8. Read-Only Guard, Query History & Timeout Clamping
  // =========================================================================
  describe('8. Read-Only Guard, Query History & Timeout Clamping', () => {
    it('blocks data.updateCell and mutating query.run when profile.readOnly is true while allowing SELECT', async () => {
      const roProfile: ConnectionProfile = {
        ...dbProfile,
        id: 'conn-ro-sqlite',
        name: 'Read-Only SQLite',
        readOnly: true,
      }
      await invokeWorker(runtime, 'connection.save', { profile: roProfile })

      await expect(
        invokeWorker(runtime, 'data.updateCell', {
          connectionId: roProfile.id,
          table: 'customers',
          primaryKeys: { id: 1 },
          column: 'name',
          newValue: 'Should Fail',
        })
      ).rejects.toMatchObject({ code: 'not_permitted' })

      for (const mutSql of [
        "INSERT INTO categories (name, slug) VALUES ('Blocked', 'blocked');",
        "UPDATE customers SET name = 'Hacked' WHERE id = 1;",
        'DELETE FROM customers WHERE id = 1;',
        'DROP TABLE customers;',
        'SELECT 1; DELETE FROM customers;',
        'SELECT 1; PRAGMA query_only(0);',
        'SELECT 1; PRAGMA writable_schema = 1;',
        buildCreateTableSql(
          {
            tableName: 'ro_blocked_tbl',
            columns: [{ name: 'id', dataType: 'INTEGER', isPrimaryKey: true }],
          },
          'sqlite'
        ),
        buildTruncateTableSql('customers', 'sqlite'),
        buildDropTableSql('customers', 'table', 'sqlite', undefined, true),
      ]) {
        await expect(
          invokeWorker(runtime, 'query.run', {
            connectionId: roProfile.id,
            queryId: `q-ro-${Math.random()}`,
            sql: mutSql,
          })
        ).rejects.toMatchObject({ code: 'not_permitted' })
      }

      const selRes = await invokeWorker(runtime, 'query.run', {
        connectionId: roProfile.id,
        queryId: 'q-ro-select',
        sql: 'SELECT id, name FROM customers ORDER BY id ASC;',
      })
      expect(selRes.isSelect).toBe(true)
      expect(selRes.rowCount).toBe(3)

      const pragmaRes = await invokeWorker(runtime, 'query.run', {
        connectionId: roProfile.id,
        queryId: 'q-ro-pragma-readonly',
        sql: 'PRAGMA table_info(customers); PRAGMA foreign_key_list(orders);',
      })
      expect(pragmaRes.isSelect).toBe(true)
      expect(pragmaRes.rowCount).toBeGreaterThan(0)
    })

    it('persists query history newest-first capped at 50 entries and supports list & clear', async () => {
      await invokeWorker(runtime, 'connection.save', { profile: dbProfile })

      // Seed 52 fast queries plus 1 failing query
      for (let i = 1; i <= 52; i++) {
        await invokeWorker(runtime, 'query.run', {
          connectionId: dbProfile.id,
          queryId: `q-hist-${i}`,
          sql: `SELECT ${i} AS num;`,
        })
      }

      await expect(
        invokeWorker(runtime, 'query.run', {
          connectionId: dbProfile.id,
          queryId: 'q-hist-err',
          sql: 'SELECT * FROM table_does_not_exist;',
        })
      ).rejects.toBeDefined()

      const histAll = await invokeWorker(runtime, 'query.history.list')
      expect(histAll.entries).toHaveLength(50)
      expect(histAll.entries[0].sql).toBe('SELECT * FROM table_does_not_exist;')
      expect(histAll.entries[0].isError).toBe(true)
      expect(histAll.entries[0].errorMessage).toBeTruthy()
      expect(histAll.entries[1].sql).toBe('SELECT 52 AS num;')
      expect(histAll.entries[1].isError).toBe(false)
      expect(histAll.entries[1].rowCount).toBe(1)
      expect(histAll.entries[1].connectionId).toBe(dbProfile.id)
      expect(histAll.entries[1].driver).toBe('sqlite')

      const histLimited = await invokeWorker(runtime, 'query.history.list', { limit: 5 })
      expect(histLimited.entries).toHaveLength(5)

      const cleared = await invokeWorker(runtime, 'query.history.clear')
      expect(cleared.ok).toBe(true)

      const afterClear = await invokeWorker(runtime, 'query.history.list')
      expect(afterClear.entries).toHaveLength(0)
    })

    it('clamps queryTimeoutSeconds to [1, 110] seconds', async () => {
      await invokeWorker(runtime, 'connection.save', { profile: dbProfile })
      await runtime.getWorkerApi().settings.set('queryTimeoutSeconds', 999)

      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
      try {
        await invokeWorker(runtime, 'query.run', {
          connectionId: dbProfile.id,
          queryId: 'q-timeout-clamp',
          sql: 'SELECT 1;',
        })
        const delays = setTimeoutSpy.mock.calls.map((c) => Number(c[1]))
        expect(delays).toContain(110000)
        expect(delays).not.toContain(600000)
        expect(delays).not.toContain(999000)
      } finally {
        setTimeoutSpy.mockRestore()
      }
    })

    it('tracks optional queryId in query.explain so query.cancel targets the running explain session', async () => {
      await invokeWorker(runtime, 'connection.save', { profile: dbProfile })

      const capturedRunIds: string[] = []
      const capturedCancelIds: string[] = []
      let markEnteredRun: (() => void) | null = null
      const enteredRun = new Promise<void>((resolve) => {
        markEnteredRun = resolve
      })
      const origCreateSession = SqliteDriver.prototype.createSession
      const createSpy = vi
        .spyOn(SqliteDriver.prototype, 'createSession')
        .mockImplementation(async function (this: SqliteDriver, profile, secret) {
          const realSession = await origCreateSession.call(this, profile, secret)
          const origRun = realSession.runQuery.bind(realSession)
          const origCancel = realSession.cancelQuery.bind(realSession)
          let releasePending: (() => void) | null = null
          realSession.runQuery = async (queryId, sql, maxRows) => {
            capturedRunIds.push(queryId)
            if (queryId === 'explain-inflight-cancel-id') {
              if (markEnteredRun) {
                const notify = markEnteredRun
                markEnteredRun = null
                notify()
              }
              await new Promise<void>((resolve) => {
                releasePending = resolve
              })
            }
            return origRun(queryId, sql, maxRows)
          }
          realSession.cancelQuery = async (queryId) => {
            capturedCancelIds.push(queryId)
            if (releasePending) {
              const fn = releasePending
              releasePending = null
              fn()
            }
            return origCancel(queryId)
          }
          return realSession
        })

      try {
        const explainPromise = invokeWorker(runtime, 'query.explain', {
          connectionId: dbProfile.id,
          sql: 'SELECT * FROM customers WHERE id = 1;',
          queryId: 'explain-inflight-cancel-id',
        })

        await enteredRun
        expect(capturedRunIds).toContain('explain-inflight-cancel-id')

        const cancelRes = await invokeWorker(runtime, 'query.cancel', {
          queryId: 'explain-inflight-cancel-id',
        })
        expect(cancelRes.ok).toBe(true)
        expect(capturedCancelIds).toContain('explain-inflight-cancel-id')

        const explainRes = await explainPromise
        expect(explainRes.isSelect).toBe(true)
      } finally {
        createSpy.mockRestore()
      }
    })
  })

  // =========================================================================
  // 9. Filter Sanitization, Transactional Staging, DDL & EXPLAIN
  // =========================================================================
  describe('9. Filter Sanitization, Transactional Staging, DDL & EXPLAIN', () => {
    it('supports safe WHERE / ORDER BY in data.fetchPage and rejects unsafe semicolons/comments with invalid_params', async () => {
      await invokeWorker(runtime, 'connection.save', { profile: dbProfile })

      const filtered = await invokeWorker(runtime, 'data.fetchPage', {
        connectionId: dbProfile.id,
        table: 'customers',
        page: 1,
        pageSize: 10,
        whereClause: 'WHERE id >= 2',
        orderByClause: 'ORDER BY id DESC',
      })
      expect(filtered.rows.map((r) => r.id)).toEqual([3, 2])

      for (const badFilter of [
        { whereClause: 'id = 1; DROP TABLE customers' },
        { whereClause: 'id = 1 -- bypass' },
        { orderByClause: 'id DESC /* evil */' },
        { whereClause: "name = 'unclosed" },
      ]) {
        await expect(
          invokeWorker(runtime, 'data.fetchPage', {
            connectionId: dbProfile.id,
            table: 'customers',
            page: 1,
            pageSize: 10,
            ...badFilter,
          })
        ).rejects.toMatchObject({ code: 'invalid_params' })
      }
    })

    it('previews and atomically applies batched inserts/updates/deletes via data.previewChanges & data.applyChanges and blocks readOnly', async () => {
      await invokeWorker(runtime, 'connection.save', { profile: dbProfile })

      const changesPayload = {
        connectionId: dbProfile.id,
        table: 'categories',
        inserts: [{ name: 'BatchCat', slug: 'batch-cat' }],
        updates: [
          {
            primaryKeys: { category_id: 1 },
            changes: { name: 'Updated Cat 1' },
          },
        ],
        deletes: [{ category_id: 2 }],
      }

      const preview = await invokeWorker(runtime, 'data.previewChanges', changesPayload)
      expect(preview.statements.length).toBeGreaterThanOrEqual(3)

      let cellUpdatedCount = 0
      runtime.client.on('data.cellUpdated', () => {
        cellUpdatedCount++
      })

      const applyRes = await invokeWorker(runtime, 'data.applyChanges', changesPayload)
      expect(applyRes.ok).toBe(true)
      expect(applyRes.inserted).toBe(1)
      expect(applyRes.updated).toBe(1)
      expect(applyRes.deleted).toBe(1)
      expect(cellUpdatedCount).toBe(1)

      const roProfile: ConnectionProfile = {
        ...dbProfile,
        id: 'conn-ro-staging',
        readOnly: true,
      }
      await invokeWorker(runtime, 'connection.save', { profile: roProfile })
      await expect(
        invokeWorker(runtime, 'data.applyChanges', {
          ...changesPayload,
          connectionId: roProfile.id,
        })
      ).rejects.toMatchObject({ code: 'not_permitted' })

      // Verify untouched default / autoincrement columns + boolean binding via RPC
      await invokeWorker(runtime, 'query.run', {
        connectionId: dbProfile.id,
        queryId: 'q-create-bool-defaults',
        sql: `
          CREATE TABLE rpc_defaults (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            label TEXT NOT NULL DEFAULT 'auto'
          );
        `,
      })
      const insertDefaultsRes = await invokeWorker(runtime, 'data.applyChanges', {
        connectionId: dbProfile.id,
        table: 'rpc_defaults',
        inserts: [{ id: undefined, active: false, created_at: undefined, label: undefined }],
      })
      expect(insertDefaultsRes.ok).toBe(true)
      expect(insertDefaultsRes.inserted).toBe(1)

      const updBoolRes = await invokeWorker(runtime, 'data.updateCell', {
        connectionId: dbProfile.id,
        table: 'rpc_defaults',
        primaryKeys: { id: 1 },
        column: 'active',
        newValue: true,
        originalValue: false,
      })
      expect(updBoolRes.ok).toBe(true)
      expect(updBoolRes.updatedRecord?.active).toBe(1)
      expect(updBoolRes.updatedRecord?.label).toBe('auto')
    })

    it('returns CREATE TABLE DDL via schema.generateDdl and inside schema.tableDetails', async () => {
      await invokeWorker(runtime, 'connection.save', { profile: dbProfile })

      const ddlRes = await invokeWorker(runtime, 'schema.generateDdl', {
        connectionId: dbProfile.id,
        table: 'customers',
      })
      expect(ddlRes.ddl).toContain('CREATE TABLE')
      expect(ddlRes.ddl).toContain('customers')

      const details = await invokeWorker(runtime, 'schema.tableDetails', {
        connectionId: dbProfile.id,
        table: 'customers',
      })
      expect(details.ddl).toContain('CREATE TABLE')
      expect(details.ddl).toContain('customers')
    })

    it('executes EXPLAIN plan via query.explain without polluting query history and blocks mutating explain on readOnly', async () => {
      await invokeWorker(runtime, 'connection.save', { profile: dbProfile })
      await invokeWorker(runtime, 'query.history.clear')

      const explainRes = await invokeWorker(runtime, 'query.explain', {
        connectionId: dbProfile.id,
        sql: 'SELECT * FROM customers WHERE id = 1;',
        queryId: 'explain-custom-id-1',
      })
      expect(explainRes.isSelect).toBe(true)
      expect(explainRes.rows.length).toBeGreaterThan(0)

      // query.cancel cleanly accepts custom explain queryId
      const cancelExplainRes = await invokeWorker(runtime, 'query.cancel', {
        queryId: 'explain-custom-id-1',
      })
      expect(cancelExplainRes.ok).toBe(true)

      // Must NOT pollute query history
      const historyAfter = await invokeWorker(runtime, 'query.history.list')
      expect(historyAfter.entries).toHaveLength(0)

      // Redis connection diagnostic explain works without touching history
      await invokeWorker(runtime, 'connection.save', {
        profile: {
          id: 'conn-redis-explain',
          name: 'Redis Explain',
          driver: 'redis',
          database: '0',
          host: '127.0.0.1',
        },
      })
      const redisExplain = await invokeWorker(runtime, 'query.explain', {
        connectionId: 'conn-redis-explain',
        sql: 'SCAN 0 MATCH user:* COUNT 50',
      })
      expect(redisExplain.isSelect).toBe(true)
      expect(redisExplain.rows.length).toBeGreaterThan(0)

      // Read-Only blocks EXPLAIN ANALYZE DELETE and British EXPLAIN ANALYSE DELETE
      await invokeWorker(runtime, 'connection.save', {
        profile: { ...dbProfile, id: 'conn-ro-explain', readOnly: true },
      })
      for (const blockedExplain of [
        'EXPLAIN ANALYZE DELETE FROM customers',
        'EXPLAIN ANALYSE DELETE FROM customers',
        'EXPLAIN (ANALYSE) DELETE FROM customers',
      ]) {
        await expect(
          invokeWorker(runtime, 'query.explain', {
            connectionId: 'conn-ro-explain',
            sql: blockedExplain,
          })
        ).rejects.toMatchObject({ code: 'not_permitted' })
      }

      // Writable connection also blocks EXPLAIN ANALYSE DELETE in Explain mode
      await expect(
        invokeWorker(runtime, 'query.explain', {
          connectionId: dbProfile.id,
          sql: 'EXPLAIN ANALYSE DELETE FROM customers',
        })
      ).rejects.toMatchObject({ code: 'not_permitted' })
    })
  })

  // =========================================================================
  // 10. Wave 12 Stability, Atomicity, Dead-Session Eviction & Cancel Safety
  // =========================================================================
  describe('10. Wave 12 Stability, Atomicity, Dead-Session Eviction & Cancel Safety', () => {
    it('serializes concurrent connection.save calls via connectionsWriteChain without losing profiles and preserves options', async () => {
      const [r1, r2] = await Promise.all([
        invokeWorker(runtime, 'connection.save', {
          profile: {
            id: 'conn-race-1',
            name: 'Race PG 1',
            driver: 'postgres',
            database: 'db1',
            host: 'ep-1.neon.tech',
            options: 'endpoint=ep-1',
          },
          password: 'pw1',
        }),
        invokeWorker(runtime, 'connection.save', {
          profile: {
            id: 'conn-race-2',
            name: 'Race PG 2',
            driver: 'postgres',
            database: 'db2',
            host: 'ep-2.neon.tech',
            options: 'endpoint=ep-2',
          },
          password: 'pw2',
        }),
      ])
      expect(r1.ok).toBe(true)
      expect(r2.ok).toBe(true)

      const list = await invokeWorker(runtime, 'connections.list')
      const ids = list.map((c) => c.id).sort()
      expect(ids).toEqual(['conn-race-1', 'conn-race-2'])
      expect(list.find((c) => c.id === 'conn-race-1')?.options).toBe('endpoint=ep-1')
      expect(list.find((c) => c.id === 'conn-race-2')?.options).toBe('endpoint=ep-2')
    })

    it('evicts closed/dead sessions in SessionManager.getSession() and transparently reconnects', async () => {
      const manager = new SessionManager(runtime.getWorkerApi())
      await manager.saveStoredConnections([dbProfile])

      const firstSession = await manager.getSession(dbProfile.id)
      expect(firstSession.isAlive()).toBe(true)

      // Simulate external crash / unexpected closure without going through manager.closeSession()
      await firstSession.close()
      expect(firstSession.isAlive()).toBe(false)
      expect(manager.hasActiveSession(dbProfile.id)).toBe(false)

      const secondSession = await manager.getSession(dbProfile.id)
      expect(secondSession).not.toBe(firstSession)
      expect(secondSession.isAlive()).toBe(true)
      const res = await secondSession.runQuery('q-reconnected', 'SELECT 1 AS ok;')
      expect(res.rows).toEqual([[1]])

      await manager.closeAll()
    })

    it('aborts query.run right after slow getSession() when query.cancel arrived pre-connect', async () => {
      await invokeWorker(runtime, 'connection.save', { profile: dbProfile })

      let executedOnServer = false
      const origCreate = SqliteDriver.prototype.createSession
      const spy = vi
        .spyOn(SqliteDriver.prototype, 'createSession')
        .mockImplementation(async function (this: SqliteDriver, profile, secret) {
          await new Promise((r) => setTimeout(r, 80))
          const real = await origCreate.call(this, profile, secret)
          const origRun = real.runQuery.bind(real)
          real.runQuery = async (qid, sql, maxRows) => {
            executedOnServer = true
            return origRun(qid, sql, maxRows)
          }
          return real
        })

      try {
        const runPromise = invokeWorker(runtime, 'query.run', {
          connectionId: dbProfile.id,
          queryId: 'q-pre-cancel-1',
          sql: 'SELECT 42 AS ran_after_cancel;',
        })
        await new Promise((r) => setTimeout(r, 20))
        await invokeWorker(runtime, 'query.cancel', { queryId: 'q-pre-cancel-1' })

        await expect(runPromise).rejects.toMatchObject({ code: 'cancelled' })
        expect(executedOnServer).toBe(false)
      } finally {
        spy.mockRestore()
      }
    })

    it('does not emit unhandledRejection when cancelQuery rejects during abort or timeout', async () => {
      await invokeWorker(runtime, 'connection.save', { profile: dbProfile })
      await runtime.getWorkerApi().settings.set('queryTimeoutSeconds', 1)

      let unhandledCount = 0
      const onUnhandled = (): void => {
        unhandledCount++
      }
      process.on('unhandledRejection', onUnhandled)

      const origCreate = SqliteDriver.prototype.createSession
      const spy = vi
        .spyOn(SqliteDriver.prototype, 'createSession')
        .mockImplementation(async function (this: SqliteDriver, profile, secret) {
          const real = await origCreate.call(this, profile, secret)
          real.runQuery = async () => new Promise<QueryResult>(() => {})
          real.cancelQuery = async () => {
            throw new Error('Session is closed')
          }
          return real
        })

      try {
        await expect(
          invokeWorker(runtime, 'query.run', {
            connectionId: dbProfile.id,
            queryId: 'q-timeout-reject-cancel',
            sql: 'SELECT 1;',
          })
        ).rejects.toMatchObject({ code: 'timeout' })

        // Let microtasks flush so any unhandledRejection would surface
        await new Promise((r) => setTimeout(r, 30))
        expect(unhandledCount).toBe(0)
      } finally {
        spy.mockRestore()
        process.off('unhandledRejection', onUnhandled)
      }
    })

    it('chains query.history.clear onto historyWriteChain and forwards connectionId/schema in data.cellUpdated', async () => {
      await invokeWorker(runtime, 'connection.save', { profile: dbProfile })

      let updatedEvent: unknown = null
      runtime.client.on('data.cellUpdated', (payload) => {
        updatedEvent = payload
      })

      await invokeWorker(runtime, 'data.applyChanges', {
        connectionId: dbProfile.id,
        schema: 'main',
        table: 'customers',
        updates: [
          {
            primaryKeys: { id: 1 },
            changes: { name: 'Schema Event Check' },
          },
        ],
      })
      expect(updatedEvent).toEqual({
        connectionId: dbProfile.id,
        schema: 'main',
        table: 'customers',
        primaryKeys: { id: 1 },
        column: 'name',
      })

      // Fire history write followed immediately by clear -> clear runs after write
      const qPromise = invokeWorker(runtime, 'query.run', {
        connectionId: dbProfile.id,
        queryId: 'q-hist-chain',
        sql: 'SELECT 1;',
      })
      await qPromise
      await invokeWorker(runtime, 'query.history.clear')
      const afterClear = await invokeWorker(runtime, 'query.history.list')
      expect(afterClear.entries).toHaveLength(0)
    })

    it('strips leading comments before checking EXPLAIN prefix in query.explain without double-prefixing', async () => {
      await invokeWorker(runtime, 'connection.save', { profile: dbProfile })

      const explained = await invokeWorker(runtime, 'query.explain', {
        connectionId: dbProfile.id,
        sql: '/* header note */\n-- line comment\nEXPLAIN QUERY PLAN SELECT * FROM customers;',
      })
      expect(explained.isSelect).toBe(true)
      expect(explained.rowCount).toBeGreaterThan(0)

      await expect(
        invokeWorker(runtime, 'query.explain', {
          connectionId: dbProfile.id,
          sql: '/* note */ EXPLAIN ANALYSE DELETE FROM customers;',
        })
      ).rejects.toMatchObject({ code: 'not_permitted' })
    })
  })
})
