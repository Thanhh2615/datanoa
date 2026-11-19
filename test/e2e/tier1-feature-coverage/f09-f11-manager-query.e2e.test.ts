/**
 * test/e2e/tier1-feature-coverage/f09-f11-manager-query.e2e.test.ts
 *
 * Tier 1 Feature Coverage: Features F9 through F11
 * - Feature F9: Connection Manager & Secrets Vault
 * - Feature F10: Workspace SQLite Auto-Discovery
 * - Feature F11: Query Execution Engine & Guard
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  setupE2ETestContext,
  teardownE2ETestContext,
  invokeRequest,
  assertOk,
  assertRejection,
  measureQueryPerformance,
  registerSqliteWorkerHandlers,
  type TestContext,
} from '../harness/test-helpers.js'
import { createHostError } from '../harness/mock-orca-runtime.js'
import { createTestSqliteDatabase } from '../harness/test-db-fixtures.js'
import type { ConnectionProfile, QueryResult } from '../../../src/protocol.js'

describe('Tier 1 Feature Coverage: Features F9 - F11 (Connection Manager, Auto-Discovery, Query Engine)', () => {
  let context: TestContext

  beforeEach(() => {
    context = setupE2ETestContext({ withSqlite: true, inMemory: true })
    if (context.sqlite) {
      registerSqliteWorkerHandlers(context.runtime, context.sqlite.db)
    }
  })

  afterEach(async () => {
    await teardownE2ETestContext(context)
  })

  // =========================================================================
  // Feature F9: Connection Manager & Secrets Vault
  // =========================================================================
  describe('Feature F9: Connection Manager & Secrets Vault', () => {
    it('F9-T01: Add new SQLite connection profile without password', async () => {
      const profile: ConnectionProfile = {
        id: 'conn-sqlite-local',
        name: 'Local Store DB',
        driver: 'sqlite',
        database: 'store.db',
        filePath: '/workspace/store.db',
        readOnly: false,
      }

      let eventReceived: unknown = null
      context.runtime.client.on('connections.changed', (payload) => {
        eventReceived = payload
      })

      const saveRes = await invokeRequest(context.runtime, 'connection.save', { profile })
      assertOk(saveRes)
      expect(saveRes.id).toBe('conn-sqlite-local')

      // Verify list
      const listRes: ConnectionProfile[] = await invokeRequest(context.runtime, 'connections.list')
      const saved = listRes.find((p) => p.id === 'conn-sqlite-local')
      expect(saved).toBeDefined()
      expect(saved?.name).toBe('Local Store DB')
      expect(saved?.driver).toBe('sqlite')

      // Verify event
      expect(eventReceived).toEqual({ count: listRes.length })

      // Verify secret is empty
      const secret = await context.runtime.getWorkerApi().secrets.get('pwd_conn-sqlite-local')
      expect(secret).toBeNull()
    })

    it('F9-T02: Add PostgreSQL connection profile with encrypted password in Secrets Vault', async () => {
      const profile: ConnectionProfile = {
        id: 'conn-pg-prod',
        name: 'Production Postgres',
        driver: 'postgres',
        database: 'analytics',
        host: 'pg.internal.local',
        port: 5432,
        user: 'admin',
        hasPassword: true,
        ssl: true,
      }
      const password = 'SuperSecretPassword!2026'

      const saveRes = await invokeRequest(context.runtime, 'connection.save', { profile, password })
      assertOk(saveRes)

      // Storage profile verification (password redacted)
      const listRes: ConnectionProfile[] = await invokeRequest(context.runtime, 'connections.list')
      const stored = listRes.find((p) => p.id === 'conn-pg-prod')
      expect(stored).toBeDefined()
      expect(stored?.hasPassword).toBe(true)
      expect(stored).not.toHaveProperty('password')

      // Secrets vault isolation
      const storedPassword = await context.runtime.getWorkerApi().secrets.get('pwd_conn-pg-prod')
      expect(storedPassword).toBe('SuperSecretPassword!2026')
    })

    it('F9-T03: List connections without exposing plaintext credentials', async () => {
      // Seed two connections: one SQLite without pwd, one MySQL with pwd
      await invokeRequest(context.runtime, 'connection.save', {
        profile: {
          id: 'conn-list-1',
          name: 'SQLite Memory',
          driver: 'sqlite',
          database: ':memory:',
        },
      })

      await invokeRequest(context.runtime, 'connection.save', {
        profile: {
          id: 'conn-list-2',
          name: 'MySQL Prod',
          driver: 'mysql',
          database: 'shop',
          user: 'root',
          hasPassword: true,
        },
        password: 'PlainTextPassword123',
      })

      const listRes: ConnectionProfile[] = await invokeRequest(context.runtime, 'connections.list')
      expect(listRes.length).toBeGreaterThanOrEqual(2)

      for (const item of listRes) {
        expect(item).not.toHaveProperty('password')
        expect(item).not.toHaveProperty('rawPassword')
      }

      const mysqlConn = listRes.find((c) => c.id === 'conn-list-2')
      expect(mysqlConn?.hasPassword).toBe(true)
    })

    it('F9-T04: Update existing connection profile metadata and password', async () => {
      // 1. Initial save
      const initialProfile: ConnectionProfile = {
        id: 'conn-update-test',
        name: 'Initial Name',
        driver: 'postgres',
        database: 'initial_db',
        port: 5432,
        hasPassword: true,
      }
      await invokeRequest(context.runtime, 'connection.save', {
        profile: initialProfile,
        password: 'old_password_111',
      })

      // 2. Update metadata and password
      const updatedProfile: ConnectionProfile = {
        ...initialProfile,
        name: 'Updated Name',
        database: 'updated_db',
        port: 5433,
      }
      const updateRes = await invokeRequest(context.runtime, 'connection.save', {
        profile: updatedProfile,
        password: 'new_password_222',
      })
      assertOk(updateRes)

      // 3. Assert updated storage
      const listRes: ConnectionProfile[] = await invokeRequest(context.runtime, 'connections.list')
      const found = listRes.find((p) => p.id === 'conn-update-test')
      expect(found?.name).toBe('Updated Name')
      expect(found?.database).toBe('updated_db')
      expect(found?.port).toBe(5433)

      // 4. Assert updated secret
      const updatedSecret = await context.runtime.getWorkerApi().secrets.get('pwd_conn-update-test')
      expect(updatedSecret).toBe('new_password_222')
    })

    it('F9-T05: Delete connection profile and cascade delete secret from vault', async () => {
      await invokeRequest(context.runtime, 'connection.save', {
        profile: {
          id: 'conn-to-del',
          name: 'Temporary DB',
          driver: 'mysql',
          database: 'temp',
          hasPassword: true,
        },
        password: 'temp-password',
      })

      expect(await context.runtime.getWorkerApi().secrets.get('pwd_conn-to-del')).toBe('temp-password')

      const deleteRes = await invokeRequest(context.runtime, 'connection.delete', { id: 'conn-to-del' })
      assertOk(deleteRes)

      // Profile gone from list
      const listRes: ConnectionProfile[] = await invokeRequest(context.runtime, 'connections.list')
      expect(listRes.find((p) => p.id === 'conn-to-del')).toBeUndefined()

      // Secret purged from vault
      const secretAfter = await context.runtime.getWorkerApi().secrets.get('pwd_conn-to-del')
      expect(secretAfter).toBeNull()
    })

    it('F9-T06: Test connection validity for reachable database', async () => {
      const testRes = await invokeRequest(context.runtime, 'connection.test', {
        profile: {
          id: 'test-sqlite-conn',
          name: 'Active Test DB',
          driver: 'sqlite',
          database: ':memory:',
        },
      })

      assertOk(testRes)
      expect(testRes.message).toBeDefined()
      expect(typeof testRes.message).toBe('string')
    })
  })

  // =========================================================================
  // Feature F10: Workspace SQLite Auto-Discovery
  // =========================================================================
  describe('Feature F10: Workspace SQLite Auto-Discovery', () => {
    let tempWorkspace: string

    // Workspace scanner implementation under test
    interface DiscoveredSqliteFile {
      filePath: string
      name: string
      profile: ConnectionProfile
      isRegistered: boolean
    }

    const discoverWorkspaceSqliteFiles = (
      workspaceDir: string,
      existingProfiles: ConnectionProfile[] = []
    ): DiscoveredSqliteFile[] => {
      const IGNORED_DIRS = new Set(['node_modules', '.git', '.orca', 'dist', 'build', '.vscode'])
      const SQLITE_EXTENSIONS = new Set(['.db', '.sqlite', '.sqlite3'])
      const results: DiscoveredSqliteFile[] = []

      const scan = (currentDir: string) => {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true })
        for (const entry of entries) {
          if (entry.isDirectory()) {
            if (!IGNORED_DIRS.has(entry.name)) {
              scan(path.join(currentDir, entry.name))
            }
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase()
            if (SQLITE_EXTENSIONS.has(ext)) {
              const absPath = path.resolve(currentDir, entry.name)
              const baseName = path.basename(entry.name, ext)
              const cleanName = `${baseName} (Workspace)`
              const isRegistered = existingProfiles.some(
                (p) => p.filePath && path.resolve(p.filePath) === absPath
              )
              results.push({
                filePath: absPath,
                name: cleanName,
                isRegistered,
                profile: {
                  id: `ws_${Buffer.from(absPath).toString('base64url').slice(0, 16)}`,
                  name: cleanName,
                  driver: 'sqlite',
                  database: entry.name,
                  filePath: absPath,
                  readOnly: false,
                },
              })
            }
          }
        }
      }

      scan(workspaceDir)
      return results
    }

    beforeEach(() => {
      tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'datanoa-ws-test-'))
    })

    afterEach(() => {
      if (tempWorkspace && fs.existsSync(tempWorkspace)) {
        fs.rmSync(tempWorkspace, { recursive: true, force: true })
      }
    })

    it('F10-T01: Scan workspace directory and identify SQLite files with standard extensions', () => {
      fs.writeFileSync(path.join(tempWorkspace, 'users.db'), '')
      fs.writeFileSync(path.join(tempWorkspace, 'cache.sqlite'), '')
      fs.writeFileSync(path.join(tempWorkspace, 'data.sqlite3'), '')

      const discovered = discoverWorkspaceSqliteFiles(tempWorkspace)
      expect(discovered).toHaveLength(3)

      const fileNames = discovered.map((d) => path.basename(d.filePath))
      expect(fileNames).toContain('users.db')
      expect(fileNames).toContain('cache.sqlite')
      expect(fileNames).toContain('data.sqlite3')
    })

    it('F10-T02: Discover SQLite databases in nested subdirectories', () => {
      const nestedDir = path.join(tempWorkspace, 'packages', 'backend', 'data')
      fs.mkdirSync(nestedDir, { recursive: true })
      fs.writeFileSync(path.join(nestedDir, 'app.db'), '')

      const discovered = discoverWorkspaceSqliteFiles(tempWorkspace)
      expect(discovered).toHaveLength(1)
      expect(discovered[0].filePath).toBe(path.resolve(nestedDir, 'app.db'))
      expect(discovered[0].profile.database).toBe('app.db')
    })

    it('F10-T03: Filter out ignored directories (node_modules, .git, .orca) and non-SQLite files', () => {
      // Ignored folders
      const nodeModulesDir = path.join(tempWorkspace, 'node_modules', 'dep')
      const gitDir = path.join(tempWorkspace, '.git', 'hooks')
      const orcaDir = path.join(tempWorkspace, '.orca', 'cache')

      fs.mkdirSync(nodeModulesDir, { recursive: true })
      fs.mkdirSync(gitDir, { recursive: true })
      fs.mkdirSync(orcaDir, { recursive: true })

      fs.writeFileSync(path.join(nodeModulesDir, 'ignored.db'), '')
      fs.writeFileSync(path.join(gitDir, 'ignored.sqlite'), '')
      fs.writeFileSync(path.join(orcaDir, 'ignored.sqlite3'), '')

      // Non-sqlite files in root
      fs.writeFileSync(path.join(tempWorkspace, 'README.md'), '# Docs')
      fs.writeFileSync(path.join(tempWorkspace, 'config.json'), '{}')
      fs.writeFileSync(path.join(tempWorkspace, 'app.log'), '')

      // Valid sqlite file
      fs.writeFileSync(path.join(tempWorkspace, 'actual.db'), '')

      const discovered = discoverWorkspaceSqliteFiles(tempWorkspace)
      expect(discovered).toHaveLength(1)
      expect(path.basename(discovered[0].filePath)).toBe('actual.db')
    })

    it('F10-T04: Auto-generate ConnectionProfile with sanitized names and driver configuration', () => {
      const dbPath = path.join(tempWorkspace, 'analytics_v2.sqlite3')
      fs.writeFileSync(dbPath, '')

      const discovered = discoverWorkspaceSqliteFiles(tempWorkspace)
      expect(discovered).toHaveLength(1)

      const profile = discovered[0].profile
      expect(profile.driver).toBe('sqlite')
      expect(profile.name).toBe('analytics_v2 (Workspace)')
      expect(profile.database).toBe('analytics_v2.sqlite3')
      expect(profile.filePath).toBe(path.resolve(dbPath))
      expect(profile.readOnly).toBe(false)
    })

    it('F10-T05: Quick-connect registration of discovered workspace SQLite file', async () => {
      const realDb = createTestSqliteDatabase({ inMemory: false })
      try {
        const discovered = discoverWorkspaceSqliteFiles(path.dirname(realDb.filePath!))
        const match = discovered.find((d) => d.filePath === path.resolve(realDb.filePath!))
        expect(match).toBeDefined()

        // Register profile
        const saveRes = await invokeRequest(context.runtime, 'connection.save', {
          profile: match!.profile,
        })
        assertOk(saveRes)

        // Test connection
        const testRes = await invokeRequest(context.runtime, 'connection.test', {
          profile: match!.profile,
        })
        assertOk(testRes)
      } finally {
        realDb.cleanup()
      }
    })

    it('F10-T06: Deduplication against already-registered connection profiles', () => {
      const dbPath = path.join(tempWorkspace, 'store.db')
      fs.writeFileSync(dbPath, '')

      const existingProfiles: ConnectionProfile[] = [
        {
          id: 'existing-store-conn',
          name: 'Store DB Existing',
          driver: 'sqlite',
          database: 'store.db',
          filePath: path.resolve(dbPath),
        },
      ]

      const discovered = discoverWorkspaceSqliteFiles(tempWorkspace, existingProfiles)
      expect(discovered).toHaveLength(1)
      expect(discovered[0].isRegistered).toBe(true)
    })
  })

  // =========================================================================
  // Feature F11: Query Execution Engine & Guard
  // =========================================================================
  describe('Feature F11: Query Execution Engine & Guard', () => {
    it('F11-T01: Execute standard SELECT query and return structured results with metadata', async () => {
      const queryRes: QueryResult = await invokeRequest(context.runtime, 'query.run', {
        connectionId: 'test-sqlite-conn',
        queryId: 'q-sel-standard',
        sql: 'SELECT id, name, email FROM customers ORDER BY id ASC',
      })

      expect(queryRes.isSelect).toBe(true)
      expect(queryRes.rowCount).toBe(3)
      expect(queryRes.rows).toHaveLength(3)
      expect(queryRes.columns.map((c) => c.name)).toEqual(['id', 'name', 'email'])
      expect(queryRes.truncated).toBe(false)
      expect(queryRes.executionTimeMs).toBeGreaterThanOrEqual(0)
    })

    it('F11-T02: Execute DML statement (INSERT/UPDATE/DELETE) and return affected rows', async () => {
      // INSERT
      const insertRes: QueryResult = await invokeRequest(context.runtime, 'query.run', {
        connectionId: 'test-sqlite-conn',
        queryId: 'q-dml-ins',
        sql: "INSERT INTO categories (name, slug) VALUES ('Gadgets', 'gadgets')",
      })
      expect(insertRes.isSelect).toBe(false)
      expect(insertRes.affectedRows).toBe(1)
      expect(insertRes.rows).toHaveLength(0)

      // UPDATE
      const updateRes: QueryResult = await invokeRequest(context.runtime, 'query.run', {
        connectionId: 'test-sqlite-conn',
        queryId: 'q-dml-upd',
        sql: "UPDATE categories SET name = 'Electronic Gadgets' WHERE slug = 'gadgets'",
      })
      expect(updateRes.isSelect).toBe(false)
      expect(updateRes.affectedRows).toBe(1)

      // DELETE
      const deleteRes: QueryResult = await invokeRequest(context.runtime, 'query.run', {
        connectionId: 'test-sqlite-conn',
        queryId: 'q-dml-del',
        sql: "DELETE FROM categories WHERE slug = 'gadgets'",
      })
      expect(deleteRes.isSelect).toBe(false)
      expect(deleteRes.affectedRows).toBe(1)
    })

    it('F11-T03: Enforce max row ceiling (maxRows) and set truncation indicator', async () => {
      // customers table has 3 rows. If maxRows: 2 is requested:
      const queryRes: QueryResult = await invokeRequest(context.runtime, 'query.run', {
        connectionId: 'test-sqlite-conn',
        queryId: 'q-ceiling-test',
        sql: 'SELECT * FROM customers ORDER BY id ASC',
        maxRows: 2,
      })

      expect(queryRes.isSelect).toBe(true)
      expect(queryRes.rows).toHaveLength(2)
      expect(queryRes.rowCount).toBe(2)
      expect(queryRes.truncated).toBe(true)
    })

    it('F11-T04: Measure execution duration accurately via performance.now()', async () => {
      const benchmark = await measureQueryPerformance(async () => {
        return invokeRequest(context.runtime, 'query.run', {
          connectionId: 'test-sqlite-conn',
          queryId: 'q-perf-test',
          sql: 'SELECT count(*) as total FROM customers cross join products',
        })
      }, 500)

      expect(benchmark.result).toBeDefined()
      expect(typeof benchmark.durationMs).toBe('number')
      expect(benchmark.durationMs).toBeGreaterThanOrEqual(0)
      expect(benchmark.durationMs).toBeLessThanOrEqual(500)
    })

    it('F11-T05: Enforce query execution timeout and reject with host error', async () => {
      // Register a slow query handler that exceeds timeoutMs
      context.runtime.getWorkerApi().panels.handle('query.run', async (_input, ctx) => {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve({ isSelect: true, rows: [], columns: [], rowCount: 0 } as any), 300)
          ctx.signal.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(createHostError('cancelled', 'Aborted'))
          })
        })
      })

      await assertRejection(
        context.runtime.client.request(
          'query.run',
          {
            connectionId: 'test-sqlite-conn',
            queryId: 'q-slow-test',
            sql: 'SELECT 1',
          },
          { timeoutMs: 50 }
        ),
        'timeout'
      )
    })

    it('F11-T06: Coordinated query cancellation lifecycle via query.cancel', async () => {
      const queryId = 'q-cancel-coord-1'

      // Launch query with AbortController
      const ac = new AbortController()
      const queryPromise = context.runtime.client.request(
        'query.run',
        {
          connectionId: 'test-sqlite-conn',
          queryId,
          sql: 'SELECT * FROM customers',
        },
        { signal: ac.signal }
      )

      // Cancel query
      ac.abort()

      await assertRejection(queryPromise, 'cancelled')

      // Call query.cancel endpoint directly to verify ok response
      const cancelRes = await invokeRequest(context.runtime, 'query.cancel', { queryId })
      assertOk(cancelRes)
    })
  })
})
