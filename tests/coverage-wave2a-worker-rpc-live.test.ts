import { DatabaseSync } from 'node:sqlite'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import type { JsonValue, OrcaWorkerApi, PanelRequestContext } from 'orca/worker'
import type { ConnectionProfile } from '../src/protocol'

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  const fsMod = await import('node:fs')
  const pathMod = await import('node:path')
  const isolatedHome = fsMod.mkdtempSync(pathMod.join(actual.tmpdir(), 'datanoa-mock-home-'))
  return {
    ...actual,
    homedir: () => isolatedHome,
    default: {
      ...actual,
      homedir: () => isolatedHome,
    },
  }
})

import activate, { deactivate } from '../src/worker/index'
import { SessionManager, buildTunnelProxiedProfile, resolveSshTunnelTarget } from '../src/worker/session-manager'
import {
  assertNoCompactedPreviewOverwrite,
  clearInMemoryUiSessionSnapshots,
  deriveWorkspaceProjectFolder,
  executeSessionQuery,
  fitResponseWithinOrcaIpcLimit,
  flushHostConfigBackupWrites,
  getDefaultByodDriverDirs,
  getUiSessionSnapshot,
  listDirectoryForPicker,
  listWorkspaceScopesForUi,
  normalizeColorTag,
  readHostConfigBackup,
  readSavedQueries,
  sanitizeConnectionProfile,
  sanitizeSavedQueryInput,
  saveUiSessionSnapshot,
  scaffoldLocalDriverDirectory,
  scrubCredentialsInText,
  stripControlChars,
  stripDisallowedSqlControlChars,
  writeHostConfigBackupPatch,
  createQueryRuntimeTracker,
} from '../src/worker/worker-utils'
import {
  detectWorkspaceEnvConnections,
  discoverWorkspaceSqliteFiles,
  formatByteSize,
  getLocalWorkspaceDirs,
  isBlockedScanRoot,
  isLocalWorkspaceHost,
  normalizePathForCompare,
  resolveSqliteFilePath,
  scanDirectoryForSqliteFiles,
} from '../src/worker/discovery'
import {
  detectDockerTargetLocality,
  detectWorkspaceDockerComposeConnections,
  findDockerBinary,
  mergeDockerComposeDiscoveries,
  parseComposeFileContent,
  parseDockerInspectContainers,
} from '../src/worker/docker-compose-discovery'
import { buildExplainPlanForStatement } from '../src/worker/rpc-query-tx'

const LIVE_PG_PORT = 55433
const LIVE_REDIS_PORT = 56380
const LIVE_MONGO_PORT = 57017
const LIVE_PG_SCHEMA = 'cov_worker_pg_live'
const LIVE_MONGO_DB = 'datanoa_cov_worker_mongo'

function createMockOrcaHost(workspaceDirs: string[], opts: { protectionStatus?: string } = {}) {
  const storage = new Map<string, JsonValue>()
  const secrets = new Map<string, string>()
  const settings = new Map<string, JsonValue>([
    ['maxRows', 200],
    ['queryTimeoutSeconds', 15],
  ])
  const handlers = new Map<string, (input: unknown, ctx: PanelRequestContext) => Promise<unknown>>()
  const commands = new Map<string, () => Promise<void>>()
  const postedEvents: Array<{ event: string; payload: unknown }> = []
  const logs: string[] = []
  const openedFiles: string[] = []
  let activeWorkspaceId = 'ws-1'

  const api: OrcaWorkerApi = {
    storage: {
      get: async (key: string) => (storage.has(key) ? storage.get(key)! : null),
      set: async (key: string, val: JsonValue) => {
        storage.set(key, val)
      },
      delete: async (key: string) => {
        storage.delete(key)
      },
    } as OrcaWorkerApi['storage'],
    secrets: {
      get: async (key: string) => (secrets.has(key) ? secrets.get(key)! : null),
      set: async (key: string, val: string) => {
        secrets.set(key, val)
      },
      delete: async (key: string) => {
        secrets.delete(key)
      },
      protection: async () => opts.protectionStatus ?? 'os-keyring',
    } as unknown as OrcaWorkerApi['secrets'],
    settings: {
      get: async (key: string) => (settings.has(key) ? settings.get(key)! : null),
      onDidChange: () => ({ dispose: () => {} }),
    } as unknown as OrcaWorkerApi['settings'],
    panels: {
      handle: (name: string, fn: (input: unknown, ctx: PanelRequestContext) => Promise<unknown>) => {
        handlers.set(name, fn)
        return { dispose: () => handlers.delete(name) }
      },
      post: (event: string, payload?: unknown) => {
        postedEvents.push({ event, payload })
      },
    } as unknown as OrcaWorkerApi['panels'],
    commands: {
      register: (name: string, fn: () => Promise<void>) => {
        commands.set(name, fn)
        return { dispose: () => commands.delete(name) }
      },
    } as unknown as OrcaWorkerApi['commands'],
    host: {
      has: (cap: string) => cap === 'secrets.protection' || cap.startsWith('workspace.'),
      call: async (method: string, arg?: unknown) => {
        if (method === 'secrets.protection') {
          return { status: opts.protectionStatus ?? 'os-keyring' }
        }
        if (method === 'workspace.list') {
          return {
            workspaces: workspaceDirs.map((dir, i) => ({
              id: `ws-${i + 1}`,
              path: dir,
              name: path.basename(dir),
              branch: 'main',
              hostId: null,
            })),
          }
        }
        if (method === 'workspace.readContext') {
          return { workspaceId: activeWorkspaceId, displayName: path.basename(workspaceDirs[0] || ''), branch: 'main' }
        }
        if (method === 'workspace.open') {
          return { ok: true }
        }
        if (method === 'editor.open') {
          const filePath = (arg as { path?: string })?.path
          if (filePath) openedFiles.push(filePath)
          return { ok: true }
        }
        return null
      },
    } as unknown as OrcaWorkerApi['host'],
    log: (msg: string) => {
      logs.push(msg)
    },
  }

  return {
    api,
    storage,
    secrets,
    settings,
    handlers,
    commands,
    postedEvents,
    logs,
    openedFiles,
    setWorkspaceId: (id: string) => {
      activeWorkspaceId = id
    },
    invoke: async <T = unknown>(
      name: string,
      input?: unknown,
      ctx: Partial<PanelRequestContext> = {}
    ): Promise<T> => {
      const fn = handlers.get(name)
      if (!fn) throw new Error(`Handler not registered: ${name}`)
      const fullCtx = {
        panel: { id: 'panel-1' },
        signal: new AbortController().signal,
        ...ctx,
      } as unknown as PanelRequestContext
      return (await fn(input, fullCtx)) as T
    },
  }
}

describe('Wave 2A-2b Worker Runtime, Discovery & Live RPCs (8 src/worker/* modules)', () => {
  const tempWorkDirs: string[] = []
  let workspaceDir = ''
  let sqlitePath = ''
  let driverSetupDir = ''

  beforeAll(() => {
    expect(os.homedir()).toContain('datanoa-mock-home-')

    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'datanoa-wk-ws-'))
    driverSetupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'datanoa-wk-byod-'))
    tempWorkDirs.push(workspaceDir, driverSetupDir)

    // Real SQLite database file + ignored node_modules + subfolder .sqlite3 + empty file
    sqlitePath = path.join(workspaceDir, 'app.db')
    const db = new DatabaseSync(sqlitePath)
    db.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, role TEXT DEFAULT 'user');
      CREATE VIEW v_users AS SELECT id, name FROM users;
      INSERT INTO users (name, role) VALUES ('Alice', 'admin'), ('Bob', 'member');
    `)
    db.close()

    fs.mkdirSync(path.join(workspaceDir, 'nested'))
    fs.writeFileSync(path.join(workspaceDir, 'nested', 'cache.sqlite3'), '')
    fs.mkdirSync(path.join(workspaceDir, 'node_modules'))
    fs.writeFileSync(path.join(workspaceDir, 'node_modules', 'ignored.db'), 'fake')

    // .env + .env.local
    fs.writeFileSync(
      path.join(workspaceDir, '.env'),
      `
      # Comment line
      export DATABASE_URL="postgres://datanoa:datanoa_pass@127.0.0.1:${LIVE_PG_PORT}/datanoa_test"
      REDIS_URL='redis://:datanoa_redis_pass@127.0.0.1:${LIVE_REDIS_PORT}/0'
      CLICKHOUSE_URL=http://datanoa:datanoa_ch_pass@127.0.0.1:58123/datanoa_test
      TEMPLATE_URL="postgres://\${DB_USER}:pw@localhost/db"
      `,
      'utf8'
    )
    fs.writeFileSync(
      path.join(workspaceDir, '.env.local'),
      `MONGO_URI=\`mongodb://127.0.0.1:${LIVE_MONGO_PORT}/test\``,
      'utf8'
    )

    // Real docker-compose.yml + env_file
    fs.writeFileSync(
      path.join(workspaceDir, 'db.env'),
      'PG_DB=app_compose\nPG_USER=cuser\nPG_PASS=cpass\n',
      'utf8'
    )
    fs.writeFileSync(
      path.join(workspaceDir, 'docker-compose.yml'),
      `
name: demo-stack
services:
  pg:
    image: postgres:16-alpine # db
    ports:
      - "127.0.0.1:${LIVE_PG_PORT}:5432"
    env_file: [db.env]
    environment:
      POSTGRES_DB: \${PG_DB:-fallback}
      POSTGRES_USER: \${PG_USER}
      POSTGRES_PASSWORD: \${PG_PASS}
  cache:
    image: redis:7-alpine
    ports:
      - target: 6379
        published: ${LIVE_REDIS_PORT}
        host_ip: 127.0.0.1
    command: redis-server --requirepass rpass
  maria:
    image: mariadb:11.4
    ports:
      - "53307:3306"
    environment:
      - MYSQL_ROOT_PASSWORD=mpass
      - MYSQL_DATABASE=mdb
`,
      'utf8'
    )
  })

  afterAll(async () => {
    try {
      await deactivate()
    } catch {
      // Ignore
    }
    try {
      await flushHostConfigBackupWrites()
    } catch {
      // Ignore
    }

    // Clean mock workspace & mock home directory safely
    for (const d of [...tempWorkDirs, os.homedir()]) {
      try {
        fs.rmSync(d, { recursive: true, force: true })
      } catch {
        // Ignore cleanup failures
      }
    }
  }, 30000)

  it('covers worker-utils.ts helpers, IPC response compaction, UI snapshots, backup I/O, picker & PBT', async () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 50 }), (raw) => {
        const stripped = stripControlChars(raw)
        expect(stripped).not.toMatch(/[\u0000-\u001F\u007F]/)
        const sqlClean = stripDisallowedSqlControlChars(raw)
        expect(sqlClean).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/)
        expect(() => scrubCredentialsInText(raw)).not.toThrow()
      }),
      { numRuns: 50 }
    )

    expect(normalizeColorTag('prod')).toBe('prod')
    expect(normalizeColorTag('dev')).toBe('dev')
    expect(normalizeColorTag('staging')).toBe('staging')
    expect(normalizeColorTag('none')).toBe('none')
    expect(normalizeColorTag('invalid-color' as never)).toBeUndefined()

    const sq = sanitizeSavedQueryInput({
      name: '  Top Users  ',
      sql: 'SELECT * FROM users;',
      description: '  desc ',
      dialect: 'postgres',
      tags: ['analytics', '  ', 'analytics', 'prod'],
    })
    expect(sq.name).toBe('Top Users')
    expect(sq.tags).toEqual(['analytics', 'prod'])
    expect(() => sanitizeSavedQueryInput({ name: '   ', sql: 'SELECT 1' })).toThrow(/empty/i)
    expect(() => sanitizeSavedQueryInput({ name: 'x', sql: '   ' })).toThrow(/empty/i)

    expect(
      readSavedQueries([
        null,
        { id: '1', name: 'q', sql: 'SELECT 1', createdAt: 1, updatedAt: 2 },
        { id: 'bad' },
      ]).length
    ).toBe(1)

    const prof = sanitizeConnectionProfile({
      id: 'c1',
      name: 'PG',
      driver: 'postgres',
      host: 'localhost',
      password: 'secret-should-strip',
      sshPassword: 'secret',
    } as unknown as ConnectionProfile)
    expect('password' in prof).toBe(false)
    expect('sshPassword' in prof).toBe(false)

    // assertNoCompactedPreviewOverwrite
    expect(() => assertNoCompactedPreviewOverwrite('hello… [+50 chars]', 'bio')).toThrow(/truncated/i)
    expect(() => assertNoCompactedPreviewOverwrite('normal', 'bio')).not.toThrow()

    // fitResponseWithinOrcaIpcLimit across all 4 oversized payload strategies
    const hugeStr = 'x'.repeat(20_000)
    expect(fitResponseWithinOrcaIpcLimit({ ok: true })).toEqual({ ok: true })
    const bigArray = Array.from({ length: 3500 }, (_, i) => ({ id: i, text: 'a'.repeat(1500) }))
    const shrunkArr = fitResponseWithinOrcaIpcLimit(bigArray)
    expect(shrunkArr.length).toBeLessThan(bigArray.length)

    const bigSnapshot = fitResponseWithinOrcaIpcLimit({
      viewState: { consoleTabs: [{ id: '1', sql: hugeStr.repeat(80) }] },
      dataCache: { pageData: { rows: [[hugeStr.repeat(90)]] } },
      updatedAt: 1,
    })
    expect(Buffer.byteLength(JSON.stringify(bigSnapshot), 'utf8')).toBeLessThanOrEqual(2_500_000)

    const bigDdl = fitResponseWithinOrcaIpcLimit({ ddl: hugeStr.repeat(120), objectCount: 5 })
    expect(bigDdl.ddl.length).toBeLessThan(hugeStr.length * 120)

    const bigEntries = fitResponseWithinOrcaIpcLimit({
      entries: Array.from({ length: 4000 }, (_, i) => ({ id: i, sql: hugeStr.slice(0, 1500) })),
    })
    expect(bigEntries.entries.length).toBeLessThan(4000)

    const bigRows = fitResponseWithinOrcaIpcLimit({
      columns: [{ name: 'c', type: 'TEXT' }],
      rows: Array.from({ length: 28000 }, (_, idx) => [`row_${idx}_${'y'.repeat(80)}`]),
      rowCount: 28000,
      resultSets: [
        {
          index: 0,
          sql: 's',
          columns: [],
          rows: Array.from({ length: 28000 }, (_, idx) => [`rs_${idx}_${'z'.repeat(80)}`]),
          rowCount: 28000,
          executionTimeMs: 1,
          truncated: false,
          isSelect: true,
        },
      ],
    })
    expect(bigRows.truncated).toBe(true)
    expect(bigRows.rows.length).toBeLessThan(28000)

    // UI session snapshot (inside mocked homedir) & host backup R/W
    const mockHost = createMockOrcaHost([workspaceDir])
    clearInMemoryUiSessionSnapshots()
    await saveUiSessionSnapshot(mockHost.api, 'panel', {
      viewState: {
        activeConnectionId: 'c1',
        consoleTabs: [{ id: 't1', sql: 'SELECT 1' }],
        formDraft: { password: 'leak', libsqlUrl: 'libsql://u:secret@db.turso.io' },
      },
      dataCache: { pageData: { rows: [] } },
    })
    const snap = await getUiSessionSnapshot(mockHost.api, 'panel')
    expect((snap.viewState?.formDraft as Record<string, unknown>)?.password).toBeUndefined()
    await saveUiSessionSnapshot(mockHost.api, 'panel', { dataCache: null })
    expect((await getUiSessionSnapshot(mockHost.api, 'panel')).dataCache).toBeNull()

    await writeHostConfigBackupPatch({ connections: [{ id: 'bk1', name: 'BK', driver: 'sqlite' }] })
    await flushHostConfigBackupWrites()
    expect((await readHostConfigBackup())?.connections?.[0].id).toBe('bk1')

    expect(getDefaultByodDriverDirs().baseDir).toContain('datanoa-mock-home-')
    expect(deriveWorkspaceProjectFolder('/a/b/my-proj', 'fb')).toBe('my-proj')
    const scopes = await listWorkspaceScopesForUi(mockHost.api)
    expect(scopes.workspaces.length).toBeGreaterThanOrEqual(1)

    const picker = await listDirectoryForPicker({ dir: workspaceDir, strictDir: true, extensions: ['.db'] }, [workspaceDir])
    expect(picker.ok).toBe(true)
    expect(picker.entries.some((e) => e.name === 'app.db')).toBe(true)
    expect((await listDirectoryForPicker({ dir: path.join(workspaceDir, 'nonexistent'), strictDir: true })).ok).toBe(false)

    const scaffold = await scaffoldLocalDriverDirectory({
      driverId: 'duckdb',
      localPath: path.join(driverSetupDir, 'duck-setup'),
    })
    expect(scaffold.wroteCanonicalEntry).toBe(true)
    expect(fs.existsSync(scaffold.entryPath)).toBe(true)
  })

  it('covers discovery.ts & docker-compose-discovery.ts against real files, .env, docker-compose.yml & PBT', async () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5_000_000_000 }), fc.string({ maxLength: 30 }), (bytes, p) => {
        expect(formatByteSize(bytes).length).toBeGreaterThan(0)
        expect(typeof normalizePathForCompare(p)).toBe('string')
      }),
      { numRuns: 40 }
    )

    expect(isLocalWorkspaceHost(null)).toBe(true)
    expect(isLocalWorkspaceHost('remote-ssh')).toBe(false)
    expect(isBlockedScanRoot(os.homedir())).toBe(true)
    expect(isBlockedScanRoot(workspaceDir)).toBe(false)

    expect(await resolveSqliteFilePath(':memory:')).toBe(':memory:')
    expect(await resolveSqliteFilePath(workspaceDir)).toBe(sqlitePath)

    const scanned = await scanDirectoryForSqliteFiles(workspaceDir)
    expect(scanned.some((s) => s.filePath === sqlitePath)).toBe(true)
    expect(scanned.some((s) => s.filePath.includes('node_modules'))).toBe(false)

    const mockHost = createMockOrcaHost([workspaceDir])
    expect((await getLocalWorkspaceDirs(mockHost.api))[0]).toBe(workspaceDir)
    expect((await discoverWorkspaceSqliteFiles(mockHost.api)).some((s) => s.filePath === sqlitePath)).toBe(true)

    const envConns = await detectWorkspaceEnvConnections([workspaceDir])
    expect(envConns.some((e) => e.driver === 'postgres')).toBe(true)
    expect(envConns.some((e) => e.driver === 'redis')).toBe(true)
    expect(envConns.some((e) => e.driver === 'clickhouse')).toBe(true)
    expect(envConns.some((e) => e.driver === 'mongodb')).toBe(true)

    const locality = detectDockerTargetLocality()
    expect(typeof locality.contextLabel).toBe('string')
    findDockerBinary()

    const inspectParsed = parseDockerInspectContainers(
      [
        {
          Id: 'c1',
          Name: '/demo-pg',
          Config: {
            Image: 'postgres:16',
            Env: ['POSTGRES_USER=u', 'POSTGRES_PASSWORD_FILE=/run/secrets/pw', 'POSTGRES_DB=d'],
            Cmd: [],
            Labels: {
              'com.docker.compose.project': 'demo-stack',
              'com.docker.compose.service': 'pg',
              'com.docker.compose.project.working_dir': workspaceDir,
            },
            ExposedPorts: { '5432/tcp': {} },
          },
          State: { Status: 'running' },
          NetworkSettings: { Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: String(LIVE_PG_PORT) }] } },
        },
        {
          Id: 'c2',
          Name: '/stopped-redis',
          Config: {
            Image: 'redis:7',
            Env: [],
            Labels: { 'com.docker.compose.project': 'other', 'com.docker.compose.service': 'redis' },
            ExposedPorts: { '6379/tcp': {} },
          },
          State: { Status: 'exited' },
          NetworkSettings: { Ports: null },
        },
      ],
      [workspaceDir]
    )
    expect(inspectParsed.length).toBe(2)

    const yamlParsed = parseComposeFileContent(
      fs.readFileSync(path.join(workspaceDir, 'docker-compose.yml'), 'utf8'),
      path.join(workspaceDir, 'docker-compose.yml'),
      new Map(),
      true,
      () => new Map([['PG_DB', 'app_compose'], ['PG_USER', 'cuser'], ['PG_PASS', 'cpass']])
    )
    expect(yamlParsed.some((c) => c.driver === 'postgres')).toBe(true)
    expect(yamlParsed.some((c) => c.driver === 'redis')).toBe(true)
    expect(yamlParsed.some((c) => c.driver === 'mariadb')).toBe(true)

    const merged = mergeDockerComposeDiscoveries(inspectParsed, yamlParsed, false)
    expect(merged.length).toBeGreaterThanOrEqual(3)

    const detectedCompose = await detectWorkspaceDockerComposeConnections([workspaceDir], {
      liveContainersOverride: [],
      onlyMatchedWorkspaces: true,
    })
    expect(detectedCompose.length).toBeGreaterThanOrEqual(2)
  })

  it('covers SessionManager lifecycle, secrets, SSH target rewriting, and live DB/tunnel paths', async () => {
    expect(
      resolveSshTunnelTarget({ id: '1', name: 'r', driver: 'redis', url: 'redis://redis.internal' })
    ).toEqual({ targetHost: 'redis.internal', targetPort: 6379 })
    expect(
      resolveSshTunnelTarget({ id: '2', name: 'm', driver: 'mssql', url: 'Server=tcp:sql.local,1435;Database=d' })
    ).toEqual({ targetHost: 'sql.local', targetPort: 1435 })

    const proxied = buildTunnelProxiedProfile(
      { id: '2', name: 'm', driver: 'mssql', url: 'Server=sql.local,1433;Database=d' },
      { localHost: '127.0.0.1', localPort: 40001 }
    )
    expect(proxied.url).toContain('127.0.0.1,40001')

    const proxiedUrl = buildTunnelProxiedProfile(
      { id: '3', name: 'c', driver: 'clickhouse', url: 'https://ch.internal:8443/analytics' },
      { localHost: '127.0.0.1', localPort: 40002 }
    )
    expect(proxiedUrl.url).toBe('https://127.0.0.1:40002/analytics')

    const mockHostNoKeyring = createMockOrcaHost([workspaceDir], { protectionStatus: 'plaintext' })
    const badSm = new SessionManager(mockHostNoKeyring.api)
    await expect(badSm.saveSecret('c1', { password: 'secret' })).rejects.toThrow(/OS keyring/i)

    const mockHost = createMockOrcaHost([workspaceDir])
    const sm = new SessionManager(mockHost.api)
    await sm.saveStoredConnections([
      { id: 'c_sqlite', name: 'SQ', driver: 'sqlite', filePath: sqlitePath },
    ])
    await sm.saveSecret('c_sqlite', {
      password: 'p1',
      sshPassword: 'sp1',
      sslKeyPassphrase: 'k1',
    })
    expect(await sm.getSecret('c_sqlite', 'sqlite')).toBe('p1')
    expect((await sm.getExtendedSecrets('c_sqlite')).sshPassword).toBe('sp1')
    await sm.copySecret('c_sqlite', 'c_sqlite_copy')
    expect(await sm.getSecret('c_sqlite_copy', 'sqlite')).toBe('p1')
    expect(await sm.findProfile('ws_ignored')).toBeNull()

    // Concurrent getSession deduplication + hasActiveSession + closeSession
    const [s1, s2] = await Promise.all([sm.getSession('c_sqlite'), sm.getSession('c_sqlite')])
    expect(s1).toBe(s2)
    expect(sm.hasActiveSession('c_sqlite')).toBe(true)

    // executeSessionQuery timeout & abort branches
    const tracker = createQueryRuntimeTracker()
    const abortCtrl = new AbortController()
    const abortedRun = executeSessionQuery(tracker, s1, 'q_abrt', 'SELECT 1', 10, 5, abortCtrl.signal)
    abortCtrl.abort()
    await expect(abortedRun.catch((e) => e)).resolves.toBeDefined()

    // StrictHostKeyChecking=yes SSH error path (exercises withTunnel without touching ~/.ssh/known_hosts)
    await expect(
      sm.testConnection(
        {
          id: 'c_ssh_test',
          name: 'SSH',
          driver: 'postgres',
          host: '127.0.0.1',
          port: LIVE_PG_PORT,
          sshEnabled: true,
          sshHost: '127.0.0.1',
          sshPort: 52222,
          sshUser: 'datanoa',
          sshAuthMethod: 'password',
        },
        'datanoa_pass',
        { sshPassword: 'datanoa_ssh_pass' }
      )
    ).rejects.toThrow()

    await sm.closeSessionsByDriver('sqlite')
    expect(sm.hasActiveSession('c_sqlite')).toBe(false)
    await sm.deleteSecret('c_sqlite')
    await sm.closeAll()
  }, 20000)

  it('exercises full index.ts activate()/deactivate() & EVERY RPC handler live against SQLite, Postgres 55433, Redis 56380 & MongoDB 57017', async () => {
    const mockHost = createMockOrcaHost([workspaceDir])
    activate(mockHost.api)
    activate(mockHost.api) // covers re-activation disposal branches

    // Execute commands + studio.open
    await mockHost.commands.get('datanoa.openSqliteFile')?.()
    await mockHost.commands.get('datanoa.newQuery')?.()
    const studioOpen = await mockHost.invoke<{ ok: boolean }>('studio.open', {})
    expect(studioOpen.ok).toBe(true)
    expect(mockHost.openedFiles.length).toBeGreaterThanOrEqual(1)

    // Connection save / test / list / parseUri / scanFolder / detectConnections across live engines
    expect(
      (
        await mockHost.invoke<{ ok: boolean }>('connection.parseUri', {
          uri: `postgres://datanoa:datanoa_pass@127.0.0.1:${LIVE_PG_PORT}/datanoa_test`,
        })
      ).ok
    ).toBe(true)

    await mockHost.invoke('connection.save', {
      profile: { id: 'live_sq', name: 'Live SQLite', driver: 'sqlite', filePath: sqlitePath },
    })
    await mockHost.invoke('connection.save', {
      profile: {
        id: 'live_pg',
        name: 'Live PG',
        driver: 'postgres',
        host: '127.0.0.1',
        port: LIVE_PG_PORT,
        user: 'datanoa',
        database: 'datanoa_test',
        ssl: false,
      },
      password: 'datanoa_pass',
    })
    await mockHost.invoke('connection.save', {
      profile: {
        id: 'live_redis',
        name: 'Live Redis',
        driver: 'redis',
        host: '127.0.0.1',
        port: LIVE_REDIS_PORT,
      },
      password: 'datanoa_redis_pass',
    })
    await mockHost.invoke('connection.save', {
      profile: {
        id: 'live_mongo',
        name: 'Live Mongo',
        driver: 'mongodb',
        host: '127.0.0.1',
        port: LIVE_MONGO_PORT,
        database: LIVE_MONGO_DB,
        options: JSON.stringify({ replicaSet: 'rs0', directConnection: true }),
      },
    })
    await mockHost.invoke('connection.save', {
      profile: { id: 'ro_sq', name: 'RO SQLite', driver: 'sqlite', filePath: sqlitePath, readOnly: true },
    })

    // Invalid connection.save error checks (D1/LibSQL HTTP token & bad driver)
    await expect(
      mockHost.invoke('connection.save', {
        profile: { id: 'bad_libsql', name: 'Bad', driver: 'libsql', url: 'http://127.0.0.1:8080' },
        authToken: 'secret-token',
      })
    ).rejects.toThrow()

    const list = await mockHost.invoke<ConnectionProfile[]>('connections.list')
    expect(list.length).toBeGreaterThanOrEqual(5)
    expect((await mockHost.invoke<{ ok: boolean }>('connection.test', { profile: { id: 'live_sq', driver: 'sqlite', filePath: sqlitePath } })).ok).toBe(true)
    expect((await mockHost.invoke<{ ok: boolean }>('connection.test', { sourceConnectionId: 'live_pg', profile: { id: 'conn_test_pg', driver: 'postgres', host: '127.0.0.1', port: LIVE_PG_PORT, user: 'datanoa', database: 'datanoa_test', hasPassword: true } })).ok).toBe(true)

    expect((await mockHost.invoke<{ files: unknown[] }>('sqlite.scanFolder', { folderPath: workspaceDir })).files.length).toBeGreaterThanOrEqual(1)
    expect((await mockHost.invoke<{ sqliteFiles: unknown[] }>('workspace.detectConnections', { folderPath: workspaceDir })).sqliteFiles.length).toBeGreaterThanOrEqual(1)
    expect((await mockHost.invoke<{ sqliteFiles: unknown[] }>('workspace.detectConnections', {})).sqliteFiles.length).toBeGreaterThanOrEqual(1)

    // BYOD local driver RPCs + fs.listDir + workspace.listScopes + ui.*SessionSnapshot
    const byodScaffoldPath = path.join(driverSetupDir, 'rpc-duck-scaffold')
    await mockHost.invoke('drivers.setupLocal', {
      driverId: 'duckdb',
      localPath: byodScaffoldPath,
    })

    const byodLocal = path.join(driverSetupDir, 'rpc-duck')
    fs.mkdirSync(byodLocal, { recursive: true })
    fs.writeFileSync(
      path.join(byodLocal, 'index.mjs'),
      `export default { type: 'duckdb', createSession: async () => ({}), testConnection: async () => ({ ok: true }) };\n`,
      'utf8'
    )
    const inspRes = await mockHost.invoke<{ sha256: string }>('drivers.inspectLocal', {
      driverId: 'duckdb',
      localPath: byodLocal,
    })
    await mockHost.invoke('drivers.configureLocal', {
      driverId: 'duckdb',
      localPath: byodLocal,
      trustedSha256: inspRes.sha256,
    })
    expect((await mockHost.invoke<{ ok: boolean }>('drivers.verify', { driverId: 'duckdb' })).ok).toBe(true)
    expect((await mockHost.invoke<{ drivers: unknown[] }>('drivers.list')).drivers.length).toBeGreaterThanOrEqual(7)
    await mockHost.invoke('drivers.defaultPaths')
    await mockHost.invoke('drivers.removeLocal', { driverId: 'duckdb' })
    await mockHost.invoke('fs.listDir', { dir: workspaceDir })
    await mockHost.invoke('workspace.listScopes')
    await mockHost.invoke('ui.saveSessionSnapshot', { surface: 'studio', viewState: { tab: 1 } })
    await mockHost.invoke('ui.getSessionSnapshot', { surface: 'studio' })

    // Data & Schema RPCs against Live SQLite
    expect(await mockHost.invoke('schema.listSchemas', { connectionId: 'live_sq' })).toBeDefined()
    expect(await mockHost.invoke<unknown[]>('schema.listObjects', { connectionId: 'live_sq' })).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'users' })])
    )
    expect(await mockHost.invoke('schema.tableDetails', { connectionId: 'live_sq', table: 'users' })).toBeDefined()
    expect(await mockHost.invoke<{ ddl: string }>('schema.generateDdl', { connectionId: 'live_sq', table: 'users' })).toBeDefined()
    expect(await mockHost.invoke<{ ddl: string }>('schema.getObjectDdl', { connectionId: 'live_sq', name: 'users', kind: 'table' })).toBeDefined()
    expect(await mockHost.invoke<{ fileName: string }>('schema.exportSchemaDdl', { connectionId: 'live_sq' })).toBeDefined()

    const page = await mockHost.invoke<{ totalRows: number }>('data.fetchPage', {
      connectionId: 'live_sq',
      table: 'users',
      page: 1,
      pageSize: 10,
      whereClause: "role = 'admin'",
      orderByClause: 'id ASC',
    })
    expect(page.totalRows).toBe(1)

    await mockHost.invoke('data.updateCell', {
      connectionId: 'live_sq',
      table: 'users',
      primaryKeys: { id: 1 },
      column: 'role',
      originalValue: 'admin',
      newValue: 'superadmin',
    })
    await mockHost.invoke('data.previewChanges', {
      connectionId: 'live_sq',
      table: 'users',
      inserts: [{ name: 'Charlie', role: 'guest' }],
    })
    await mockHost.invoke('data.applyChanges', {
      connectionId: 'live_sq',
      table: 'users',
      inserts: [{ name: 'Charlie', role: 'guest' }],
      updates: [{ primaryKeys: { id: 2 }, changes: { role: 'vip' } }],
    })
    await expect(
      mockHost.invoke('data.updateCell', {
        connectionId: 'ro_sq',
        table: 'users',
        primaryKeys: { id: 1 },
        column: 'role',
        newValue: 'x',
      })
    ).rejects.toThrow()

    // Query & Explain RPCs across live SQLite, PG, Redis, Mongo + buildExplainPlanForStatement dialects
    expect(buildExplainPlanForStatement('SELECT 1;', 'mssql', false).explainSql).toContain('SHOWPLAN_ALL ON')
    expect(buildExplainPlanForStatement('SELECT 1 FROM DUAL;', 'oracle', true).explainSql).toContain('EXPLAIN PLAN FOR')
    expect(buildExplainPlanForStatement('db.items.find({})', 'mongodb', true).explainSql).toContain('.explain(')
    expect(buildExplainPlanForStatement('{ "find": "items", "filter": {} }', 'mongodb', true).explainSql).toContain('explain')
    expect(() =>
      buildExplainPlanForStatement('{ "aggregate": "items", "pipeline": [{ "$merge": "dest" }] }', 'mongodb', true)
    ).toThrow(/Read-Only/i)
    expect(() =>
      buildExplainPlanForStatement('{ "explain": { "delete": "items" }, "verbosity": "executionStats" }', 'mongodb', false)
    ).toThrow(/Read-Only/i)
    expect(() => buildExplainPlanForStatement('INSERT INTO t VALUES (1);', 'postgres', true)).toThrow()
    expect(() => buildExplainPlanForStatement('DELETE FROM t;\nGO\nSELECT 1;', 'mssql', false)).toThrow()
    expect(() => buildExplainPlanForStatement('EXPLAIN ANALYZE DELETE FROM t;', 'postgres', false)).toThrow(/mutating/i)

    // Validation & scrubThrownError checks on schema/data/query/tx/connections RPCs
    for (const [rpcName, badInput] of [
      ['connection.save', {}],
      ['connection.save', { profile: { driver: 'unknown_db' } }],
      ['connection.delete', {}],
      ['connection.test', {}],
      ['schema.listObjects', {}],
      ['schema.tableDetails', { connectionId: 'live_sq' }],
      ['schema.generateDdl', { connectionId: 'live_sq' }],
      ['schema.listSchemas', {}],
      ['schema.getObjectDdl', { connectionId: 'live_sq', name: 'users', kind: 'bogus' }],
      ['schema.exportSchemaDdl', {}],
      ['data.fetchPage', { connectionId: 'live_sq' }],
      ['data.updateCell', { connectionId: 'live_sq' }],
      ['data.previewChanges', { connectionId: 'live_sq' }],
      ['data.applyChanges', { connectionId: 'live_sq' }],
      ['query.run', { connectionId: 'live_sq', sql: '   ' }],
      ['query.explain', { connectionId: 'live_sq', sql: '' }],
      ['queries.saved.delete', {}],
      ['query.cancel', {}],
      ['tx.status', {}],
      ['tx.commit', {}],
      ['tx.rollback', {}],
      ['tx.setAutoCommit', { connectionId: 'live_pg', enabled: 'yes' }],
    ] as const) {
      await expect(mockHost.invoke(rpcName, badInput)).rejects.toThrow()
    }
    // Triggers scrubThrownError on query execution failure
    await expect(mockHost.invoke('query.run', { connectionId: 'live_sq', sql: 'SELECT * FROM no_such_table_xyz;' })).rejects.toThrow()

    expect((await mockHost.invoke<{ rowCount: number }>('query.run', { connectionId: 'live_sq', sql: 'SELECT * FROM users;' })).rowCount).toBeGreaterThanOrEqual(2)
    expect((await mockHost.invoke('query.run', { connectionId: 'live_pg', sql: 'SELECT 1 AS ok;' }))).toBeDefined()
    expect((await mockHost.invoke('query.run', { connectionId: 'live_redis', sql: 'PING' }))).toBeDefined()
    expect((await mockHost.invoke('query.run', { connectionId: 'live_mongo', sql: 'db.adminCommand({ ping: 1 })' }))).toBeDefined()
    await expect(mockHost.invoke('query.run', { connectionId: 'ro_sq', sql: 'DELETE FROM users;' })).rejects.toThrow(/Read-Only/i)

    expect(await mockHost.invoke('query.explain', { connectionId: 'live_sq', sql: 'SELECT * FROM users;' })).toBeDefined()
    expect(await mockHost.invoke('query.explain', { connectionId: 'live_pg', sql: 'SELECT 1; SELECT 2;' })).toBeDefined()
    expect(await mockHost.invoke('query.explain', { connectionId: 'live_redis', sql: 'GET mykey' })).toBeDefined()
    expect(
      await mockHost.invoke('query.explain', {
        connectionId: 'live_mongo',
        sql: 'db.items.find({}); db.items.aggregate([{ $match: {} }]);',
      })
    ).toBeDefined()
    await expect(
      mockHost.invoke('query.explain', { connectionId: 'live_mongo', sql: 'show collections' })
    ).rejects.toThrow(/MongoDB explain/i)

    expect((await mockHost.invoke<{ entries: unknown[] }>('query.history.list', { limit: 10 })).entries.length).toBeGreaterThanOrEqual(1)
    await mockHost.invoke('query.history.clear')

    const savedQ = await mockHost.invoke<{ entry: { id: string } }>('queries.saved.save', {
      name: 'List Users',
      sql: 'SELECT * FROM users;',
      dialect: 'sqlite',
      tags: ['dev'],
    })
    expect((await mockHost.invoke<{ entries: unknown[] }>('queries.saved.list')).entries.length).toBe(1)
    await mockHost.invoke('queries.saved.delete', { id: savedQ.entry.id })
    await mockHost.invoke('query.cancel', { queryId: 'pre_cancel_1' })

    // Live TX lifecycle + cross-panel ownership enforcement + missing panelId check
    await expect(
      mockHost.invoke('tx.begin', { connectionId: 'live_pg' }, { panel: undefined } as never)
    ).rejects.toThrow(/identifiable editor panel/i)
    const panelA = { panel: { id: 'panel-A' } } as unknown as Partial<PanelRequestContext>
    const panelB = { panel: { id: 'panel-B' } } as unknown as Partial<PanelRequestContext>
    const txB = await mockHost.invoke<{ active: boolean; txToken?: number }>('tx.begin', { connectionId: 'live_pg' }, panelA)
    expect(txB.active).toBe(true)
    await expect(mockHost.invoke('tx.commit', { connectionId: 'live_pg' }, panelB)).rejects.toThrow(/another editor panel/i)
    await expect(mockHost.invoke('tx.rollback', { connectionId: 'live_pg' }, panelB)).rejects.toThrow(/another editor panel/i)
    await mockHost.invoke('tx.commit', { connectionId: 'live_pg' }, panelA)

    await mockHost.invoke('tx.setAutoCommit', { connectionId: 'live_pg', enabled: false }, panelA)
    const ownerCheck = await mockHost.invoke<{ txToken?: number }>('tx.status', { connectionId: 'live_pg' }, panelA)
    expect(ownerCheck.txToken).toBeDefined()
    await mockHost.invoke('tx.rollback', { connectionId: 'live_pg', onlyIfOwner: true, txToken: ownerCheck.txToken }, panelA)
    await mockHost.invoke('tx.setAutoCommit', { connectionId: 'live_pg', enabled: true }, panelA)

    // Also run schema cleanup on live PG (unused if only SELECT 1) & delete test connection
    expect((await mockHost.invoke<{ ok: boolean }>('connection.delete', { id: 'live_mongo' })).ok).toBe(true)
    await deactivate()
  }, 30000)
})
