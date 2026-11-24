import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import type { JsonValue, OrcaWorkerApi, PanelRequestContext } from 'orca/worker'

const mockHomeState = vi.hoisted(() => ({
  realHomedir: '',
  isolatedHomedir: '',
  useRealHome: false,
}))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  const fsMod = await import('node:fs')
  const pathMod = await import('node:path')
  mockHomeState.realHomedir = actual.homedir()
  mockHomeState.isolatedHomedir = fsMod.mkdtempSync(
    pathMod.join(actual.tmpdir(), 'datanoa-w4c-home-')
  )
  const homedir = () =>
    mockHomeState.useRealHome ? mockHomeState.realHomedir : mockHomeState.isolatedHomedir
  return {
    ...actual,
    homedir,
    default: {
      ...actual,
      homedir,
    },
  }
})

import * as net from 'node:net'
import type { ConnectionProfile } from '../src/protocol'
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
  type DockerInspectContainer,
} from '../src/worker/docker-compose-discovery'
import { registerConnectionHandlers } from '../src/worker/rpc-connections'
import { registerDataAndSchemaHandlers } from '../src/worker/rpc-data-schema'
import {
  buildExplainPlanForStatement,
  registerQueryAndTxHandlers,
} from '../src/worker/rpc-query-tx'
import { registerAiHandlers } from '../src/worker/rpc-ai'
import { completeSql } from '../src/worker/ai-client'
import {
  WorkerSchemaMetadataCache,
  buildSqlCompletionContext,
  extractReferencedMongoCollections,
} from '../src/worker/ai-sql-context'
import { SqliteDriver, SqliteSession } from '../src/drivers/sqlite/driver'
import { DriverManager } from '../src/drivers/driver-manager'
import {
  SessionManager,
  buildTunnelProxiedProfile,
  resolveSshTunnelTarget,
} from '../src/worker/session-manager'
import {
  assertMutableConnection,
  assertNoCompactedPreviewOverwrite,
  clearInMemoryUiSessionSnapshots,
  createHostError,
  createQueryRuntimeTracker,
  deriveWorkspaceProjectFolder,
  ensureByodDirectoryScaffolded,
  executeSessionQuery,
  fitResponseWithinOrcaIpcLimit,
  flushHostConfigBackupWrites,
  getDefaultByodDriverDirs,
  getUiSessionSnapshot,
  listDirectoryForPicker,
  listWorkspaceScopesForUi,
  normalizeColorTag,
  normalizeSqliteProfile,
  openStudioDocumentInOrca,
  readClampedTimeoutSeconds,
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
} from '../src/worker/worker-utils'

function createMockHost(
  opts: {
    workspaces?: Array<{ id: string; path: string; name?: string; branch?: string | null; hostId?: string | null }>
    projects?: Array<{ path?: string; hostId?: string | null }>
    readContextResult?: unknown
    readContextThrows?: boolean
    workspaceListThrows?: boolean
    projectListThrows?: boolean
    hasFn?: (cap: string) => boolean
    omitHost?: boolean
    protectionStatus?: unknown
    protectionThrows?: boolean
    useHostProtectionOnly?: boolean
    workspaceOpenThrows?: boolean
    editorOpenThrows?: boolean
    panelsPostThrows?: boolean
    storageGetThrows?: boolean
    storageSetThrows?: boolean
  } = {}
) {
  const storage = new Map<string, JsonValue>()
  const secrets = new Map<string, string>()
  const settings = new Map<string, JsonValue>([
    ['maxRows', 200],
    ['queryTimeoutSeconds', 15],
  ])
  const handlers = new Map<string, (input: unknown, ctx: PanelRequestContext) => Promise<unknown>>()
  const postedEvents: Array<{ event: string; payload: unknown }> = []
  const logs: string[] = []
  const openedFiles: string[] = []

  const hostObj = opts.omitHost
    ? undefined
    : ({
        ...(opts.hasFn ? { has: opts.hasFn } : {}),
        call: async (method: string, arg?: unknown) => {
          if (method === 'secrets.protection') {
            if (opts.protectionThrows) throw new Error('protection call failed')
            return opts.protectionStatus ?? { status: 'os-keyring' }
          }
          if (method === 'workspace.list') {
            if (opts.workspaceListThrows) throw new Error('workspace.list failed')
            return { workspaces: opts.workspaces ?? [] }
          }
          if (method === 'project.list') {
            if (opts.projectListThrows) throw new Error('project.list failed')
            return { projects: opts.projects ?? [] }
          }
          if (method === 'workspace.readContext') {
            if (opts.readContextThrows) throw new Error('readContext failed')
            return opts.readContextResult ?? null
          }
          if (method === 'workspace.open') {
            if (opts.workspaceOpenThrows) throw new Error('workspace.open failed')
            return { ok: true }
          }
          if (method === 'editor.open') {
            if (opts.editorOpenThrows) throw new Error('editor.open failed')
            const filePath = (arg as { path?: string })?.path
            if (filePath) openedFiles.push(filePath)
            return { ok: true }
          }
          return null
        },
      } as unknown as OrcaWorkerApi['host'])

  const secretsApi = {
    get: async (key: string) => (secrets.has(key) ? secrets.get(key)! : null),
    set: async (key: string, val: string) => {
      secrets.set(key, val)
    },
    delete: async (key: string) => {
      secrets.delete(key)
    },
    ...(opts.useHostProtectionOnly
      ? {}
      : {
          protection: async () => {
            if (opts.protectionThrows) throw new Error('secrets.protection failed')
            return opts.protectionStatus ?? 'os-keyring'
          },
        }),
  } as unknown as OrcaWorkerApi['secrets']

  const api: OrcaWorkerApi = {
    storage: {
      get: async (key: string) => {
        if (opts.storageGetThrows) throw new Error('storage.get failed')
        return storage.has(key) ? storage.get(key)! : null
      },
      set: async (key: string, val: JsonValue) => {
        if (opts.storageSetThrows) throw new Error('storage.set failed')
        storage.set(key, val)
      },
      delete: async (key: string) => {
        storage.delete(key)
      },
    } as OrcaWorkerApi['storage'],
    secrets: secretsApi,
    settings: {
      get: async (key?: string) => {
        if (!key) return Object.fromEntries(settings.entries()) as unknown as JsonValue
        return settings.has(key) ? settings.get(key)! : null
      },
      onDidChange: () => ({ dispose: () => {} }),
    } as unknown as OrcaWorkerApi['settings'],
    panels: {
      handle: (name: string, fn: (input: unknown, ctx: PanelRequestContext) => Promise<unknown>) => {
        handlers.set(name, fn)
        return { dispose: () => handlers.delete(name) }
      },
      post: (event: string, payload?: unknown) => {
        if (opts.panelsPostThrows) throw new Error('panels.post failed')
        postedEvents.push({ event, payload })
      },
    } as unknown as OrcaWorkerApi['panels'],
    commands: {
      register: () => ({ dispose: () => {} }),
    } as unknown as OrcaWorkerApi['commands'],
    host: hostObj as OrcaWorkerApi['host'],
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
    postedEvents,
    logs,
    openedFiles,
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

describe('Wave 4C Worker Runtime & SQLite Tails Closure', () => {
  const tempRoots: string[] = []
  let tmpBase = ''

  beforeAll(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'datanoa-w4c-ws-'))
    tempRoots.push(tmpBase)
  })

  afterEach(() => {
    mockHomeState.useRealHome = false
    vi.restoreAllMocks()
  })

  afterAll(async () => {
    mockHomeState.useRealHome = false
    try {
      await flushHostConfigBackupWrites()
    } catch {
      // ignore backup flush errors
    }
    for (const dir of [...tempRoots, mockHomeState.isolatedHomedir]) {
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
      }
    }
  }, 20_000)

  it('Slice 1A: closes discovery.ts branches across scan roots, .db names, workspace APIs, .env edge cases & PBT', async () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 24 }), (raw) => {
        expect(typeof isBlockedScanRoot(raw)).toBe('boolean')
        expect(typeof formatByteSize(raw.length * 1024)).toBe('string')
      }),
      { numRuns: 30 }
    )

    // Blocked roots: empty, whitespace, non-string, /, \, C:\, C:\., homedir parent, AppData outside tmpdir, Win system roots
    expect(isBlockedScanRoot('')).toBe(true)
    expect(isBlockedScanRoot('   ')).toBe(true)
    expect(isBlockedScanRoot(null as unknown as string)).toBe(true)
    expect(isBlockedScanRoot('/')).toBe(true)
    expect(isBlockedScanRoot('\\')).toBe(true)
    expect(isBlockedScanRoot('C:\\')).toBe(true)
    expect(isBlockedScanRoot('C:\\.')).toBe(true)
    expect(isBlockedScanRoot(path.parse(tmpBase).root)).toBe(true)
    expect(isBlockedScanRoot(path.dirname(os.homedir()))).toBe(true)
    expect(isBlockedScanRoot('C:\\Windows\\System32')).toBe(true)

    mockHomeState.useRealHome = true
    try {
      const realHome = os.homedir()
      expect(isBlockedScanRoot(path.join(realHome, 'AppData', 'Roaming'))).toBe(true)
    } finally {
      mockHomeState.useRealHome = false
    }

    // resolveSqliteFilePath: empty, missing, directory with literal '.db', directory with only 0-byte '.sqlite', empty directory
    expect(await resolveSqliteFilePath('   ')).toBe('')
    expect(await resolveSqliteFilePath(path.join(tmpBase, 'missing-nope.db'))).toContain('missing-nope.db')

    const dotDbDir = path.join(tmpBase, 'dot-db-dir')
    fs.mkdirSync(dotDbDir, { recursive: true })
    fs.writeFileSync(path.join(dotDbDir, '.db'), 'SQLite format 3\0')
    expect(await resolveSqliteFilePath(dotDbDir)).toBe(path.join(dotDbDir, '.db'))

    const zeroByteDir = path.join(tmpBase, 'zero-byte-dir')
    fs.mkdirSync(zeroByteDir, { recursive: true })
    fs.writeFileSync(path.join(zeroByteDir, '.sqlite'), '')
    expect(await resolveSqliteFilePath(zeroByteDir)).toBe(path.join(zeroByteDir, '.sqlite'))

    const emptyScanDir = path.join(tmpBase, 'empty-scan-dir')
    fs.mkdirSync(emptyScanDir, { recursive: true })
    expect(await resolveSqliteFilePath(emptyScanDir)).toBe(emptyScanDir)

    // scanDirectoryForSqliteFiles: blocked root, budget limits (maxDirs:0, expired deadline, maxResults:1), stat error, symlink skip, readdir error
    expect(await scanDirectoryForSqliteFiles('')).toEqual([])
    expect(await scanDirectoryForSqliteFiles(os.homedir())).toEqual([])

    const scanTarget = path.join(tmpBase, 'scan-target')
    fs.mkdirSync(path.join(scanTarget, 'sub1'), { recursive: true })
    fs.writeFileSync(path.join(scanTarget, 'a.db'), 'abc')
    fs.writeFileSync(path.join(scanTarget, 'b.sqlite3'), 'def')
    fs.writeFileSync(path.join(scanTarget, '.sqlite'), 'hidden')
    fs.writeFileSync(path.join(scanTarget, 'sub1', 'c.db'), 'ghi')

    expect(await scanDirectoryForSqliteFiles(scanTarget, [], { deadlineMs: Date.now() - 10 })).toEqual([])
    expect(await scanDirectoryForSqliteFiles(scanTarget, [], { maxDirs: 0 })).toEqual([])
    const oneResult = await scanDirectoryForSqliteFiles(scanTarget, [], { maxResults: 1 })
    expect(oneResult.length).toBe(1)

    // Symlink + stat error + readdir error inside scanDirectoryForSqliteFiles
    const origReaddir = fs.promises.readdir
    const origStat = fs.promises.stat
    const readdirSpy = vi.spyOn(fs.promises, 'readdir').mockImplementation((async (
      targetPath: fs.PathLike,
      opts?: unknown
    ) => {
      const pStr = String(targetPath)
      if (pStr.endsWith('sub1')) {
        throw new Error('EACCES mock')
      }
      const res = await origReaddir.call(fs.promises, targetPath, opts as never)
      if (Array.isArray(res) && pStr === scanTarget && res.length > 0 && typeof res[0] === 'object') {
        const fakeSym = {
          name: 'sym.db',
          isSymbolicLink: () => true,
          isDirectory: () => false,
          isFile: () => false,
        } as unknown as fs.Dirent
        return [fakeSym, ...res]
      }
      return res
    }) as typeof fs.promises.readdir)
    const statSpy = vi.spyOn(fs.promises, 'stat').mockImplementation((async (p: fs.PathLike) => {
      if (String(p).endsWith('b.sqlite3')) throw new Error('stat fail mock')
      return origStat.call(fs.promises, p)
    }) as typeof fs.promises.stat)

    const scannedWithMocks = await scanDirectoryForSqliteFiles(scanTarget)
    expect(scannedWithMocks.some((f) => f.filePath.endsWith('a.db'))).toBe(true)
    expect(scannedWithMocks.some((f) => f.filePath.endsWith('b.sqlite3') && f.sizeBytes === 0)).toBe(true)
    expect(scannedWithMocks.some((f) => f.filePath.endsWith('sym.db'))).toBe(false)
    readdirSpy.mockRestore()
    statSpy.mockRestore()

    // Duplicate directory queued in scanDirectoryForSqliteFiles (visitedDirs dedup L303-304)
    const dupReaddirSpy = vi.spyOn(fs.promises, 'readdir').mockImplementation((async (p: fs.PathLike) => {
      if (String(p) === scanTarget) {
        const d = { name: 'sub1', isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false } as unknown as fs.Dirent
        return [d, d]
      }
      return []
    }) as typeof fs.promises.readdir)
    expect(await scanDirectoryForSqliteFiles(scanTarget)).toEqual([])
    dupReaddirSpy.mockRestore()

    // getLocalWorkspaceDirs: omitted host, host.has=false, workspace.list throw, project.list ok+throw, workspace.readContext variants
    const noHost = createMockHost({ omitHost: true })
    expect(await getLocalWorkspaceDirs(noHost.api)).toEqual([])

    const wsDirA = path.join(tmpBase, 'ws-a')
    const wsDirB = path.join(tmpBase, 'ws-b')
    fs.mkdirSync(wsDirA, { recursive: true })
    fs.mkdirSync(wsDirB, { recursive: true })
    fs.writeFileSync(path.join(wsDirA, 'shared.db'), '123')

    const hasFalseHost = createMockHost({
      hasFn: () => false,
      workspaces: [{ id: 'w1', path: wsDirA }],
    })
    expect(await getLocalWorkspaceDirs(hasFalseHost.api)).toEqual([])

    const throwingHost = createMockHost({
      workspaceListThrows: true,
      projectListThrows: true,
      readContextThrows: true,
    })
    expect(await getLocalWorkspaceDirs(throwingHost.api)).toEqual([])

    const ctxPathHost = createMockHost({
      workspaces: [
        { id: 'w-remote', path: wsDirB, hostId: 'ssh-remote' },
        { id: 'w-blocked', path: os.homedir(), hostId: 'local' },
      ],
      projects: [{ path: wsDirA, hostId: null }],
      readContextResult: { path: wsDirB, hostId: 'local' },
    })
    expect(await getLocalWorkspaceDirs(ctxPathHost.api)).toEqual([wsDirA, wsDirB])

    const ctxNestedHost = createMockHost({
      readContextResult: { workspace: { path: wsDirB, hostId: 'local' } },
    })
    expect(await getLocalWorkspaceDirs(ctxNestedHost.api)).toEqual([wsDirB])

    // discoverWorkspaceSqliteFiles: string path + dedup + expired deadline
    expect((await discoverWorkspaceSqliteFiles(wsDirA)).length).toBeGreaterThanOrEqual(1)
    expect(
      await discoverWorkspaceSqliteFiles(ctxPathHost.api, [], { deadlineMs: Date.now() - 10 })
    ).toEqual([])
    const dedupHost = createMockHost({
      workspaces: [{ id: 'w1', path: wsDirA }],
      projects: [{ path: wsDirA }],
    })
    expect((await discoverWorkspaceSqliteFiles(dedupHost.api)).length).toBe(1)

    // detectWorkspaceEnvConnections: blocked/dup dirs, missing '=', bad keys, bad scheme, non-DB key, bad URI, duplicate URI, fallback names
    const envDir = path.join(tmpBase, 'env-edge-dir')
    fs.mkdirSync(envDir, { recursive: true })
    fs.writeFileSync(
      path.join(envDir, '.env'),
      [
        'NO_EQUALS_LINE',
        '123BAD_KEY=postgres://u:p@127.0.0.1:5432/db',
        'DATABASE_URL=not-a-uri',
        'FTP_URL=ftp://user:pass@host/path',
        'MY_PG=postgres://user:pass@host/db',
        'CUSTOM_DB_DSN=postgres://',
        'CUSTOM_PG_DSN=postgres://u:p@pg.local:5432/appdb',
        'SQLITE_URL=sqlite:./local.db',
        'SQLITE_PATH_DSN=sqlite:///tmp/only_db.db',
      ].join('\n'),
      'utf8'
    )
    fs.writeFileSync(
      path.join(envDir, '.env.local'),
      'DATABASE_URL=postgres://u:p@pg.local:5432/appdb\n',
      'utf8'
    )
    const envFound = await detectWorkspaceEnvConnections([
      '',
      os.homedir(),
      envDir,
      envDir,
    ])
    expect(envFound.some((e) => e.envKey === 'CUSTOM_PG_DSN')).toBe(true)
    expect(envFound.filter((e) => e.uri.includes('pg.local')).length).toBe(1)

    // Real AppData exact root match (isSameOrChildPath candidateNorm === rootNorm L91:34)
    mockHomeState.useRealHome = true
    const realAppData = path.join(os.homedir(), 'AppData')
    expect(isBlockedScanRoot(realAppData)).toBe(true)
    mockHomeState.useRealHome = false
  }, 20_000)

  it('Slice 1B: closes docker-compose-discovery.ts locality, live failure, all 10 engines, YAML/env edge cases & merge', async () => {
    // detectDockerTargetLocality: DOCKER_HOST, DOCKER_CONTEXT, dockerConfigPath
    expect(detectDockerTargetLocality({ DOCKER_HOST: 'unix:///var/run/docker.sock' }).isLocal).toBe(true)
    expect(detectDockerTargetLocality({ DOCKER_HOST: 'npipe:////./pipe/docker_engine' }).isLocal).toBe(true)
    expect(detectDockerTargetLocality({ DOCKER_HOST: 'fd://0' }).isLocal).toBe(true)
    expect(detectDockerTargetLocality({ DOCKER_HOST: 'tcp://127.0.0.1:2375' }).isLocal).toBe(true)
    expect(detectDockerTargetLocality({ DOCKER_HOST: 'http://localhost:2375' }).isLocal).toBe(true)
    expect(detectDockerTargetLocality({ DOCKER_HOST: 'https://[::1]:2376' }).isLocal).toBe(true)
    expect(detectDockerTargetLocality({ DOCKER_HOST: 'tcp://10.20.30.40:2375' })).toEqual({
      isLocal: false,
      contextLabel: 'Docker Context',
    })
    expect(detectDockerTargetLocality({ DOCKER_HOST: 'ssh://ops@prod-box' }).isLocal).toBe(false)
    expect(detectDockerTargetLocality({ DOCKER_HOST: '::invalid-url::' }).isLocal).toBe(false)
    expect(detectDockerTargetLocality({ DOCKER_HOST: '   ', DOCKER_CONTEXT: 'desktop-linux' }).isLocal).toBe(true)
    expect(detectDockerTargetLocality({ DOCKER_CONTEXT: 'remote-prod' })).toEqual({
      isLocal: false,
      contextLabel: 'Docker Context',
    })

    const dockerCfgDir = path.join(tmpBase, 'docker-cfg')
    fs.mkdirSync(dockerCfgDir, { recursive: true })
    const remoteCfg = path.join(dockerCfgDir, 'remote.json')
    const localCfg = path.join(dockerCfgDir, 'local.json')
    const badCfg = path.join(dockerCfgDir, 'bad.json')
    fs.writeFileSync(remoteCfg, JSON.stringify({ currentContext: 'remote-swarm' }))
    fs.writeFileSync(localCfg, JSON.stringify({ currentContext: 'default' }))
    fs.writeFileSync(badCfg, '{not valid json')
    expect(detectDockerTargetLocality({}, remoteCfg).isLocal).toBe(false)
    expect(detectDockerTargetLocality({}, localCfg).isLocal).toBe(true)
    expect(detectDockerTargetLocality({}, badCfg).isLocal).toBe(true)

    findDockerBinary()

    // Trigger real runDockerCommand non-zero exit + listLiveDockerContainers catch cleanly via dead DOCKER_HOST
    const prevDockerHost = process.env.DOCKER_HOST
    process.env.DOCKER_HOST = 'tcp://127.0.0.1:1'
    try {
      const deadDockerDir = path.join(tmpBase, 'dead-docker')
      fs.mkdirSync(deadDockerDir, { recursive: true })
      const emptyRes = await detectWorkspaceDockerComposeConnections([deadDockerDir], {
        onlyMatchedWorkspaces: true,
      })
      expect(emptyRes).toEqual([])
    } finally {
      if (prevDockerHost === undefined) delete process.env.DOCKER_HOST
      else process.env.DOCKER_HOST = prevDockerHost
    }

    // parseDockerInspectContainers across ALL 10 drivers + fallbackPorts + ddev/pgadmin + unpublished + IPv6 HostIp
    const wsParent = path.join(tmpBase, 'compose-ws-parent')
    const wsChild = path.join(wsParent, 'app')
    fs.mkdirSync(wsChild, { recursive: true })

    const containers: DockerInspectContainer[] = [
      // skipped: missing labels, ddev, admin tool, unknown image & port
      { Name: '/nolabel', Config: { Image: 'postgres:16', Env: null, Labels: null }, State: { Status: 'running' }, NetworkSettings: { Ports: null } },
      { Name: '/ddev', Config: { Image: 'postgres:16', Env: [], Labels: { 'com.docker.compose.project': 'ddev-app', 'com.docker.compose.service': 'db' } }, State: { Status: 'running' }, NetworkSettings: { Ports: null } },
      { Name: '/pgadmin', Config: { Image: 'dpage/pgadmin4:latest', Env: [], Labels: { 'com.docker.compose.project': 'p', 'com.docker.compose.service': 'admin' } }, State: { Status: 'running' }, NetworkSettings: { Ports: null } },
      { Name: '/unknown', Config: { Image: 'custom/worker:1', Env: [], Labels: { 'com.docker.compose.project': 'p', 'com.docker.compose.service': 'w' }, ExposedPorts: { '9999/tcp': {} } }, State: { Status: 'running' }, NetworkSettings: { Ports: null } },
      // fallbackPort detection (custom image name, port 5432/tcp) + trust auth + :: HostIp + parent workdir match
      {
        Name: '/fb-pg',
        Config: {
          Image: 'internal-registry:5000/custom-db:v1',
          Env: ['POSTGRES_HOST_AUTH_METHOD=trust'],
          Labels: {
            'com.docker.compose.project': 'p1',
            'com.docker.compose.service': 'pgtrust',
            'com.docker.compose.project.working_dir': wsParent,
          },
          ExposedPorts: { '5432/tcp': {}, badport: {} },
        },
        State: { Status: 'running' },
        NetworkSettings: { Ports: { '5432/tcp': [{ HostIp: '::', HostPort: '15432' }] } },
      },
      // cockroachdb insecure + unpublished running container
      {
        Name: '/crdb',
        Config: {
          Image: 'cockroachdb/cockroach:v25.1',
          Env: [],
          Cmd: ['start-single-node'],
          Args: ['--insecure'],
          Labels: {
            'com.docker.compose.project': 'p1',
            'com.docker.compose.service': 'crdb',
            'com.docker.compose.project.config_files': path.join(wsChild, 'docker-compose.yml'),
          },
          ExposedPorts: { '26257/tcp': {} },
        },
        State: { Status: 'running' },
        NetworkSettings: { Ports: { '26257/tcp': [{ HostIp: '127.0.0.1', HostPort: '99999' }] } },
      },
      // mysql app user + mariadb empty root pw
      {
        Name: '/mysql-app',
        Config: { Image: 'mysql:8.4', Env: ['MYSQL_USER=appu', 'MYSQL_PASSWORD=appp', 'MYSQL_DATABASE=appd'], Labels: { 'com.docker.compose.project': 'p1', 'com.docker.compose.service': 'my1' } },
        State: { Status: 'running' },
        NetworkSettings: { Ports: { '3306/tcp': [{ HostIp: '0.0.0.0', HostPort: '33060' }] } },
      },
      {
        Name: '/maria-empty',
        Config: { Image: 'mariadb:11', Env: ['MARIADB_ALLOW_EMPTY_ROOT_PASSWORD=1'], Labels: { 'com.docker.compose.project': 'p1', 'com.docker.compose.service': 'ma1' } },
        State: { Status: 'running' },
        NetworkSettings: { Ports: { '3306/tcp': [{ HostIp: '127.0.0.1', HostPort: '33061' }] } },
      },
      // redis --requirepass=eq + REDIS_USERNAME
      {
        Name: '/redis-eq',
        Config: { Image: 'redis:7', Env: ['REDIS_USERNAME=ruser'], Cmd: ['redis-server', '--requirepass=rsecret'], Labels: { 'com.docker.compose.project': 'p1', 'com.docker.compose.service': 'red1' } },
        State: { Status: 'running' },
        NetworkSettings: { Ports: { '6379/tcp': [{ HostIp: '127.0.0.1', HostPort: '16379' }] } },
      },
      // clickhouse 8443 https & 8123 http
      {
        Name: '/ch-https',
        Config: { Image: 'clickhouse/clickhouse-server:24', Env: ['CLICKHOUSE_PASSWORD_FILE=/run/ch_pw'], Labels: { 'com.docker.compose.project': 'p1', 'com.docker.compose.service': 'ch1' } },
        State: { Status: 'running' },
        NetworkSettings: { Ports: { '8443/tcp': [{ HostIp: '127.0.0.1', HostPort: '8443' }] } },
      },
      // libsql
      {
        Name: '/libsql',
        Config: { Image: 'ghcr.io/tursodatabase/libsql-server:latest', Env: [], Labels: { 'com.docker.compose.project': 'p1', 'com.docker.compose.service': 'ls1' } },
        State: { Status: 'running' },
        NetworkSettings: { Ports: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '18080' }] } },
      },
      // mssql
      {
        Name: '/mssql',
        Config: { Image: 'mcr.microsoft.com/mssql/server:2022', Env: ['SA_PASSWORD=MsPass!1', 'MSSQL_DB=msdb'], Labels: { 'com.docker.compose.project': 'p1', 'com.docker.compose.service': 'ms1' } },
        State: { Status: 'running' },
        NetworkSettings: { Ports: { '1433/tcp': [{ HostIp: '127.0.0.1', HostPort: '11433' }] } },
      },
      // oracle app user + fallback ORACLE_PWD
      {
        Name: '/oracle-app',
        Config: { Image: 'gvenzl/oracle-free:23', Env: ['APP_USER=orauser', 'APP_USER_PASSWORD=orapass', 'ORACLE_DATABASE=ORCL'], Labels: { 'com.docker.compose.project': 'p1', 'com.docker.compose.service': 'ora1' } },
        State: { Status: 'running' },
        NetworkSettings: { Ports: { '1521/tcp': [{ HostIp: '127.0.0.1', HostPort: '11521' }] } },
      },
      {
        Name: '/oracle-sys',
        Config: { Image: 'gvenzl/oracle-free:23', Env: ['ORACLE_PWD=syspass'], Labels: { 'com.docker.compose.project': 'p1', 'com.docker.compose.service': 'ora2' } },
        State: { Status: 'running' },
        NetworkSettings: { Ports: { '1521/tcp': [{ HostIp: '127.0.0.1', HostPort: '11522' }] } },
      },
      // mongodb
      {
        Name: '/mongo',
        Config: { Image: 'mongo:7', Env: ['MONGO_INITDB_ROOT_USERNAME=muser', 'MONGO_INITDB_ROOT_PASSWORD=mpass', 'MONGO_INITDB_DATABASE=mdb'], Labels: { 'com.docker.compose.project': 'p1', 'com.docker.compose.service': 'mg1' } },
        State: { Status: 'running' },
        NetworkSettings: { Ports: { '27017/tcp': [{ HostIp: '127.0.0.1', HostPort: '27017' }] } },
      },
    ]

    const parsedLive = parseDockerInspectContainers(containers, [wsChild])
    expect(parsedLive.length).toBe(11)
    expect(parsedLive.find((c) => c.service === 'crdb')?.unpublishedPort).toBe(true)
    expect(parsedLive.find((c) => c.service === 'crdb')?.ssl).toBe(false)
    expect(parsedLive.find((c) => c.service === 'ch1')?.ssl).toBe(true)

    // Real docker-compose file inside INFRA_SUBDIRS (docker/docker-compose.yml) + root .env + nested .env
    const composeWs = path.join(tmpBase, 'compose-infra-ws')
    const dockerSub = path.join(composeWs, 'docker')
    fs.mkdirSync(dockerSub, { recursive: true })
    fs.writeFileSync(path.join(composeWs, '.env'), '\uFEFFexport ROOT_USER=root_u\nBAD_LINE\n123=bad\nROOT_PW="pw\\"1" # comment\nUNQUOTED=abc # trailing\n', 'utf8')
    fs.writeFileSync(path.join(dockerSub, 'extra.env'), 'EXTRA_PW=epw\n', 'utf8')
    fs.writeFileSync(
      path.join(dockerSub, 'docker-compose.yml'),
      `
services:
  pg_static:
    image: postgres:16
    container_name: my_pg_c
    ports:
      - "5432"
      - "0.0.0.0:15433:5432/tcp"
      - "\${UNRESOLVED_PORT}"
    expose:
      - "5432/tcp"
    env_file:
      - extra.env
      - ../outside-ignored.env
      - path: missing.env
    environment:
      POSTGRES_USER: \${ROOT_USER-fallback}
      POSTGRES_PASSWORD: \${MISSING_UNDEF-defpw}
      POSTGRES_DB: \${UNRESOLVED_VAR}
      EXTRA_PW:
      ESCAPED: "$$literal"
  redis_list:
    image: redis:7
    ports:
      - host_ip: 127.0.0.1
        published: 16380
        target: 6379
    command:
      - redis-server
      - --requirepass
      - listpw
  mongo_unpub:
    image: mongo:7
    environment:
      - MONGO_INITDB_ROOT_PASSWORD_FILE=/run/m_pw
      - ROOT_USER
    command: "mongod --auth --note 'hello world'"
volumes:
  data: {}
`,
      'utf8'
    )
    // Also a root compose file with single string env_file + non-service section
    fs.writeFileSync(
      path.join(composeWs, 'compose.yaml'),
      `
services:
  ch_single:
    image: clickhouse/clickhouse-server
    env_file: docker/extra.env
    ports:
      - published: 18123
        target: 8123
    environment:
      CLICKHOUSE_PASSWORD: \${EXTRA_PW}
`,
      'utf8'
    )

    const discoveredCompose = await detectWorkspaceDockerComposeConnections([composeWs], {
      liveContainersOverride: [
        {
          Name: '/match-by-host-port',
          Config: { Image: 'postgres:16', Env: [], Labels: { 'com.docker.compose.project': 'otherproj', 'com.docker.compose.service': 'pg_static' } },
          State: { Status: 'running' },
          NetworkSettings: { Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '15433' }] } },
        },
        {
          Name: '/stopped-ch',
          Config: { Image: 'clickhouse/clickhouse-server', Env: [], Labels: { 'com.docker.compose.project': 'other', 'com.docker.compose.service': 'ch2' } },
          State: { Status: 'exited' },
          NetworkSettings: { Ports: null },
        },
      ],
    })
    expect(discoveredCompose.some((c) => c.service === 'pg_static')).toBe(true)
    expect(discoveredCompose.some((c) => c.service === 'redis_list' && c.password === 'listpw')).toBe(true)
    expect(discoveredCompose.some((c) => c.service === 'mongo_unpub' && c.unpublishedPort)).toBe(true)
    expect(discoveredCompose.some((c) => c.service === 'ch_single' && c.password === 'epw')).toBe(true)

    // parseComposeFileContent edge: env_file block path: + trailing long port flush + $VAR/$UNDEF + invalid port + published port with PASSWORD_FILE
    const extraStatic = parseComposeFileContent(
      `
services:
  oradb:
    image: gvenzl/oracle-free:23
    env_file:
      path: sub.env
    ports:
      - target: 1521
        published: 21521
  pg_file:
    image: postgres:16
    ports:
      - "15499:5432"
      - ":::"
    environment:
      POSTGRES_USER: $PLAIN_VAR
      POSTGRES_DB: $UNDEF_PLAIN
      POSTGRES_PASSWORD_FILE: /run/pg_pw
`,
      path.join(composeWs, 'compose-extra.yml'),
      new Map([['PLAIN_VAR', 'pv']]),
      false,
      () => new Map([['ORACLE_PASSWORD', 'opw']])
    )
    expect(extraStatic[0]?.password).toBe('opw')
    expect(extraStatic[1]?.passwordFromFile).toBe('POSTGRES_PASSWORD_FILE')
    expect(extraStatic[1]?.hint).toContain('POSTGRES_PASSWORD_FILE')

    // Missing dir & unreadable compose file in detectWorkspaceDockerComposeConnections
    const brokenComposeDir = path.join(tmpBase, 'broken-compose-dir')
    fs.mkdirSync(brokenComposeDir, { recursive: true })
    fs.writeFileSync(path.join(brokenComposeDir, 'docker-compose.yml'), 'services:\n', 'utf8')
    const origReadFile = fs.promises.readFile
    const rfSpy = vi.spyOn(fs.promises, 'readdir').mockRejectedValueOnce(new Error('missing dir'))
    const readFileOnce = vi.spyOn(fs.promises, 'readFile').mockImplementation((async (p: fs.PathLike, enc?: unknown) => {
      if (String(p).startsWith(brokenComposeDir)) throw new Error('unreadable compose')
      return origReadFile.call(fs.promises, p, enc as never)
    }) as typeof fs.promises.readFile)
    await detectWorkspaceDockerComposeConnections(
      [path.join(tmpBase, 'does-not-exist-compose'), brokenComposeDir],
      { liveContainersOverride: [] }
    )
    rfSpy.mockRestore()
    readFileOnce.mockRestore()

    const mergedManual = mergeDockerComposeDiscoveries(
      [
        {
          id: 'live:x/y',
          project: 'x',
          service: 'oradb',
          driver: 'oracle',
          name: 'x · oradb',
          host: '127.0.0.1',
          port: 21521,
          database: '',
          sourceKind: 'live',
          sourceFile: 'compose:x',
          status: 'exited',
          workspaceMatched: false,
        },
      ],
      extraStatic
    )
    expect(mergedManual[0]?.password).toBe('opw')
    expect(mergedManual[0]?.database).toBe('FREEPDB1')

    // Round 2 compose edge closures: empty DOCKER_HOST, USERPROFILE fallback + non-string currentContext, empty Env/State/Image containers,
    // invalid ports, empty :- / nested defaults, command quotes, unknown image, oversized compose file, matching dir merge
    expect(detectDockerTargetLocality({ DOCKER_HOST: '   ' }).isLocal).toBe(true)
    const userProfDir = path.join(tmpBase, 'docker-userprof')
    fs.mkdirSync(path.join(userProfDir, '.docker'), { recursive: true })
    fs.writeFileSync(path.join(userProfDir, '.docker', 'config.json'), JSON.stringify({ currentContext: 123 }), 'utf8')
    expect(detectDockerTargetLocality({ USERPROFILE: userProfDir }).isLocal).toBe(true)
    expect(detectDockerTargetLocality({}).isLocal).toBe(true)

    const minContainers = parseDockerInspectContainers(
      [
        {
          Id: 'min_1',
          Name: '/min-pg',
          Config: {
            Labels: {
              'com.docker.compose.project': 'minproj',
              'com.docker.compose.service': 'minpg',
            },
          },
          NetworkSettings: { Ports: { '5432/tcp': [{ HostPort: '55432' }] } },
        },
        {
          Id: 'min_2',
          Name: '/min-skip',
          Config: {
            Labels: {
              'com.docker.compose.project': 'minproj',
              'com.docker.compose.service': 'minskip',
            },
          },
          NetworkSettings: { Ports: {} },
        },
      ],
      []
    )
    expect(minContainers.length).toBe(1)
    expect(minContainers[0]?.status).toBe('unknown')

    const staticEdgeDir = path.join(tmpBase, 'compose-edge-static')
    fs.mkdirSync(staticEdgeDir, { recursive: true })
    const edgeYaml = [
      'services:',
      '  util_only:',
      '    image: alpine:latest',
      '  pg_def:',
      '    image: postgres:16',
      '    command: "postgres -c \'log=on\' plain_arg"',
      '    ports:',
      '      - "99999"',
      '      - "99999:5432"',
      '      - "127.0.0.1:99999:5432"',
      '      -',
      '      - target: badport',
      '        published: badpub',
      '      - "15432:5432"',
      '    environment:',
      '      POSTGRES_USER: ${EMPTY_VAR:-fallback_user}',
      '      POSTGRES_DB: ${UNSET_A:-${UNSET_INNER}}',
      '      EXTRA_VAL: ${UNSET_B-${UNSET_INNER2}}',
      '  mssql_def:',
      '    image: mcr.microsoft.com/mssql/server:2022-latest',
      '    ports:',
      '      - "11433:1433"',
      '  mysql_file:',
      '    image: mysql:8',
      '    environment:',
      '      MYSQL_PASSWORD_FILE: /run/secrets/mysql_pw',
      '  ora_file:',
      '    image: gvenzl/oracle-xe:21',
      '    environment:',
      '      ORACLE_PASSWORD_FILE: /run/secrets/ora_pw',
    ].join('\n')
    const parsedEdge = parseComposeFileContent(
      edgeYaml,
      path.join(staticEdgeDir, 'docker-compose.yml'),
      new Map([['EMPTY_VAR', '']])
    )
    expect(parsedEdge.some((d) => d.driver === 'mssql' && d.database === 'master')).toBe(true)

    const mergedByDir = mergeDockerComposeDiscoveries(
      [
        {
          id: 'live:dir/1',
          project: 'other_proj',
          service: 'pg_other',
          driver: 'postgres',
          name: 'p',
          host: '127.0.0.1',
          port: 55432,
          database: 'db',
          sourceKind: 'live',
          sourceFile: path.join(staticEdgeDir, 'docker-compose.yml'),
          status: 'running',
          workspaceMatched: true,
        },
      ],
      parsedEdge
    )
    expect(mergedByDir.length).toBeGreaterThan(1)

    const bigComposeDir = path.join(tmpBase, 'big-compose-dir')
    fs.mkdirSync(bigComposeDir, { recursive: true })
    fs.writeFileSync(path.join(bigComposeDir, 'docker-compose.yml'), 'services:\n' + '# '.repeat(600_000), 'utf8')
    await detectWorkspaceDockerComposeConnections([os.homedir(), bigComposeDir], { liveContainersOverride: [] })
  }, 20_000)

  it('Slice 2: closes worker-utils.ts helpers, openStudioDocumentInOrca, IPC compaction, snapshots, backup errors, scopes, picker & BYOD scaffold', async () => {
    // 1. sanitizeSavedQueryInput edge cases & fast-check PBT
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 40 }).filter((s) => stripControlChars(s).trim().length > 0),
        (rawName) => {
          const out = sanitizeSavedQueryInput({ name: rawName, sql: 'SELECT 1;' })
          expect(out.name.length).toBeGreaterThan(0)
          expect(out.sql).toBe('SELECT 1;')
        }
      ),
      { numRuns: 25 }
    )
    expect(() => sanitizeSavedQueryInput({ name: 123, sql: 'SELECT 1' })).toThrow(/required/i)
    expect(() => sanitizeSavedQueryInput({ name: 'q', sql: 123 })).toThrow(/required/i)
    expect(() => sanitizeSavedQueryInput({ name: 'q', sql: 'a'.repeat(100_001) })).toThrow(/exceeds/i)
    expect(() => sanitizeSavedQueryInput({ name: 'q', sql: 'SELECT 1', dialect: 'bogus' })).toThrow(/Unsupported/i)
    expect(() =>
      sanitizeSavedQueryInput({ name: 'q', sql: "SELECT 'postgres://user:pass@host.db/app';", dialect: 'postgres' })
    ).toThrow(/credential/i)
    const sqClean = sanitizeSavedQueryInput({
      name: '  q  ',
      sql: 'SELECT 1',
      description: '   ',
      tags: [123, '   ', 't1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10', 't11'],
    })
    expect(sqClean.description).toBeUndefined()
    expect(sqClean.tags?.length).toBe(10)
    expect(sanitizeSavedQueryInput({ name: 'q', sql: 'SELECT 1', tags: ['  '] }).tags).toBeUndefined()

    // 2. assertMutableConnection not found
    const hostEmpty = createMockHost()
    const smEmpty = new SessionManager(hostEmpty.api)
    await expect(assertMutableConnection(smEmpty, 'missing-conn')).rejects.toThrow(/not found/i)

    // 3. sanitizeConnectionProfile comprehensive fields + PBT
    const sanitizedFull = sanitizeConnectionProfile({
      id: 'p1',
      name: 'user:secretpass@db.internal',
      driver: 'redis',
      redisDb: 15,
      options: '  {"tls":true}  ',
      folder: '  \u0001TeamA  ',
      workspaceScope: '  ws-1  ',
      sslMode: 'verify-full',
      sslCaPath: '  /ca.pem  ',
      sslCertPath: '  /cert.pem  ',
      sslKeyPath: '  /key.pem  ',
      hasSslKeyPassphrase: true,
      sslRejectUnauthorized: false,
      hasAuthToken: false,
      d1AccountId: '  acc123  ',
      d1DatabaseId: '  db123  ',
      sshEnabled: true,
      sshHost: '  bastion  ',
      sshPort: 2222,
      sshUser: '  ops  ',
      sshAuthMethod: 'key',
      sshPrivateKeyPath: '  /id_ed25519  ',
      hasSshPassphrase: true,
      hasSshPassword: true,
      url: 'mongodb://h1:27017,h2:27017/db?api_key=k1&ok=1#access_token=t1&keep=2',
    } as unknown as ConnectionProfile)
    expect(sanitizedFull.redisDb).toBe(15)
    expect(sanitizedFull.sslMode).toBe('verify-full')
    expect(sanitizedFull.sshAuthMethod).toBe('key')
    expect(sanitizedFull.sshPort).toBe(2222)
    expect(sanitizedFull.hasAuthToken).toBe(false)
    expect(sanitizedFull.sslRejectUnauthorized).toBe(false)
    expect(sanitizedFull.url).not.toContain('secret')
    expect(sanitizedFull.url).not.toContain('api_key')
    expect(sanitizedFull.url).not.toContain('access_token')
    expect(sanitizedFull.name).not.toContain('secretpass')

    const sanitizedInvalidOpts = sanitizeConnectionProfile({
      id: 'p2',
      name: 123 as unknown as string,
      driver: 'postgres',
      redisDb: 99,
      options: '   ',
      folder: '   ',
      workspaceScope: 456 as unknown as string,
      sslMode: 'invalid' as never,
      sshAuthMethod: 'invalid' as never,
      sshPort: 99999,
      url: 'not a valid ::: url?token=abc',
    } as unknown as ConnectionProfile)
    expect(sanitizedInvalidOpts.redisDb).toBeUndefined()
    expect(sanitizedInvalidOpts.sslMode).toBeUndefined()
    expect(sanitizedInvalidOpts.sshAuthMethod).toBeUndefined()
    expect(sanitizedInvalidOpts.sshPort).toBeUndefined()
    expect(sanitizedInvalidOpts.name).toBe('')

    // normalizeSqliteProfile with :memory: and empty
    expect((await normalizeSqliteProfile({ id: 'm', name: 'M', driver: 'sqlite' })).database).toBe(':memory:')
    expect(scrubCredentialsInText('')).toBe('')

    // 4. openStudioDocumentInOrca across missing host, no local workspaces, displayName match, stale .datanoa cleanup, dialects & errors
    expect((await openStudioDocumentInOrca(createMockHost({ omitHost: true }).api)).ok).toBe(false)
    expect(
      (
        await openStudioDocumentInOrca(
          createMockHost({ workspaces: [{ id: 'r1', path: '/remote', hostId: 'ssh' }] }).api
        )
      ).ok
    ).toBe(false)

    const studioWs = path.join(tmpBase, 'studio-ws')
    const dotDatanoa = path.join(studioWs, '.datanoa')
    fs.mkdirSync(dotDatanoa, { recursive: true })
    fs.writeFileSync(path.join(dotDatanoa, '.gitignore'), '*\n', 'utf8')
    fs.writeFileSync(path.join(dotDatanoa, 'old-stale.datanoa'), '-- stale', 'utf8')

    const studioHost = createMockHost({
      workspaces: [{ id: 'ws-disp', path: studioWs, name: 'MyApp', branch: 'feat' }],
      readContextResult: { workspaceId: 'unmatched', displayName: 'MyApp', branch: 'feat' },
      workspaceOpenThrows: true,
      panelsPostThrows: true,
    })
    const smStudio = new SessionManager(studioHost.api)
    await smStudio.saveStoredConnections([
      { id: 'c_redis', name: 'R', driver: 'redis', host: '127.0.0.1', port: 6379 },
      { id: 'c_mongo', name: 'M', driver: 'mongodb', host: '127.0.0.1', port: 27017 },
      { id: 'c_mssql', name: 'MS', driver: 'mssql', host: '127.0.0.1', port: 1433 },
      { id: 'c_ora', name: 'O', driver: 'oracle', host: '127.0.0.1', port: 1521 },
      { id: 'c_pg', name: 'PG', driver: 'postgres', host: '127.0.0.1', port: 5432 },
    ])
    // Active connection fallback -> savedList[0] (redis)
    const rOpen = await openStudioDocumentInOrca(studioHost.api, {}, smStudio)
    expect(rOpen.ok).toBe(true)
    expect(fs.existsSync(path.join(dotDatanoa, 'old-stale.datanoa'))).toBe(false)
    expect(fs.readFileSync(path.join(dotDatanoa, 'studio.datanoa'), 'utf8')).toContain('SCAN 0')

    // Stored ACTIVE_CONNECTION_STORAGE_KEY + table/schema across mongodb, mssql, oracle, postgres
    await studioHost.api.storage.set('datanoa.activeConnectionId', 'c_mongo')
    await openStudioDocumentInOrca(studioHost.api, { table: 'orders' }, smStudio)
    expect(fs.readFileSync(path.join(dotDatanoa, 'studio.datanoa'), 'utf8')).toContain('getCollection("orders")')
    await openStudioDocumentInOrca(studioHost.api, { connectionId: 'c_mongo' }, smStudio)
    expect(fs.readFileSync(path.join(dotDatanoa, 'studio.datanoa'), 'utf8')).toContain('db.stats()')

    await openStudioDocumentInOrca(studioHost.api, { connectionId: 'c_mssql', table: 'items', schema: 'dbo' }, smStudio)
    expect(fs.readFileSync(path.join(dotDatanoa, 'studio.datanoa'), 'utf8')).toContain('SELECT TOP 100 * FROM [dbo].[items]')
    await openStudioDocumentInOrca(studioHost.api, { connectionId: 'c_mssql' }, smStudio)

    await openStudioDocumentInOrca(studioHost.api, { connectionId: 'c_ora', table: 'emp', schema: 'hr' }, smStudio)
    expect(fs.readFileSync(path.join(dotDatanoa, 'studio.datanoa'), 'utf8')).toContain('FETCH FIRST 100 ROWS ONLY')
    await openStudioDocumentInOrca(studioHost.api, { connectionId: 'c_ora' }, smStudio)
    expect(fs.readFileSync(path.join(dotDatanoa, 'studio.datanoa'), 'utf8')).toContain('FROM DUAL')

    await openStudioDocumentInOrca(studioHost.api, { connectionId: 'c_pg', table: 'users', schema: 'analytics' }, smStudio)
    expect(fs.readFileSync(path.join(dotDatanoa, 'studio.datanoa'), 'utf8')).toContain('SELECT * FROM "analytics"."users"')

    // Match by displayName without branch (ctx.branch falsy -> : true) + readdir failure catch (L348, L379)
    const noBranchHost = createMockHost({
      workspaces: [{ id: 'ws-disp', path: studioWs, name: 'MyApp', branch: 'feat' }],
      readContextResult: { displayName: 'MyApp', branch: null },
    })
    const readdirStudioSpy = vi.spyOn(fs.promises, 'readdir').mockRejectedValueOnce(new Error('readdir fail'))
    expect((await openStudioDocumentInOrca(noBranchHost.api, { connectionId: 'c_pg' }, smStudio)).ok).toBe(true)
    readdirStudioSpy.mockRestore()

    // readContextThrows + home-only workspace fallback + editor.open throwing
    const failEditorHost = createMockHost({
      workspaces: [{ id: 'w-home', path: os.homedir(), name: 'Home' }],
      readContextThrows: true,
      editorOpenThrows: true,
    })
    expect((await openStudioDocumentInOrca(failEditorHost.api)).ok).toBe(false)

    // 5. createQueryRuntimeTracker TTL pruning + readClampedTimeoutSeconds + executeSessionQuery timeout
    const tracker = createQueryRuntimeTracker()
    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy.mockReturnValue(1_000)
    tracker.markQueryPreCancelled('q_expired')
    nowSpy.mockReturnValue(100_000)
    tracker.markQueryPreCancelled('q_fresh')
    expect(tracker.consumePreCancelledQuery('q_expired')).toBe(false)
    expect(tracker.consumePreCancelledQuery('q_fresh')).toBe(true)
    expect(tracker.consumePreCancelledQuery('q_fresh')).toBe(false)
    nowSpy.mockRestore()
    tracker.clear()

    const timeoutHost = createMockHost()
    timeoutHost.settings.set('queryTimeoutSeconds', 'bad')
    expect(await readClampedTimeoutSeconds(timeoutHost.api)).toBe(30)
    timeoutHost.settings.set('queryTimeoutSeconds', 999)
    expect(await readClampedTimeoutSeconds(timeoutHost.api)).toBe(110)

    const cancelMock = vi.fn(async () => ({ ok: true }))
    const slowSession = {
      runQuery: () => new Promise(() => {}),
      cancelQuery: cancelMock,
    } as never
    await expect(
      executeSessionQuery(tracker, slowSession, 'q_to', 'SELECT 1', 10, 0.02, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'timeout' })
    expect(cancelMock).toHaveBeenCalledWith('q_to')

    // 6. stripSecretsFromViewState, saveUiSessionSnapshot storage catch, getUiSessionSnapshot storage/backup fallback & writeHostConfigBackupPatch rename fail
    clearInMemoryUiSessionSnapshots()
    const snapHostErr = createMockHost({ storageGetThrows: true, storageSetThrows: true })
    await saveUiSessionSnapshot(snapHostErr.api, 'panel', {
      viewState: {
        sqlDraft: "SELECT 'postgres://u:secret@db/x';",
        consoleTabs: {
          tabs: ['primitive-tab', { id: 't1', sql: "SELECT 'mysql://u:pw@h/d';" }, { id: 't2', sql: 'SELECT 1;' }],
        },
        formDraft: {
          clickhouseUrl: 'http://user:chpass@127.0.0.1:8123/db?password=p1#token=t2',
          libsqlUrl: 'http://127.0.0.1:8080',
        },
      },
    })
    clearInMemoryUiSessionSnapshots()
    await writeHostConfigBackupPatch({
      panelViewState: { activeConnectionId: 'from-bk-panel' },
      studioViewState: { activeConnectionId: 'from-bk-studio' },
    })
    await flushHostConfigBackupWrites()
    const restoredPanel = await getUiSessionSnapshot(snapHostErr.api, 'panel')
    expect(restoredPanel.viewState?.activeConnectionId).toBe('from-bk-panel')
    const restoredStudio = await getUiSessionSnapshot(snapHostErr.api, 'studio')
    expect(restoredStudio.viewState?.activeConnectionId).toBe('from-bk-studio')

    clearInMemoryUiSessionSnapshots()
    const storageOnlyHost = createMockHost()
    await storageOnlyHost.api.storage.set('datanoa.panelViewState', { sqlDraft: 'SELECT 42;' })
    expect((await getUiSessionSnapshot(storageOnlyHost.api, 'panel')).viewState?.sqlDraft).toBe('SELECT 42;')

    // Trigger writeHostConfigBackupPatch rename retry exhaustion & unlink cleanup + mkdir outer catch
    const renameSpy = vi.spyOn(fs.promises, 'rename').mockRejectedValue(new Error('EBUSY mock'))
    await writeHostConfigBackupPatch({ connections: [] })
    await flushHostConfigBackupWrites()
    renameSpy.mockRestore()
    const mkdirSpy = vi.spyOn(fs.promises, 'mkdir').mockRejectedValueOnce(new Error('EACCES mkdir'))
    await writeHostConfigBackupPatch({ connections: [] })
    await flushHostConfigBackupWrites()
    mkdirSpy.mockRestore()

    // 7. deriveWorkspaceProjectFolder & listWorkspaceScopesForUi edge branches
    expect(deriveWorkspaceProjectFolder('C:\\Users\\x\\workspaces\\proj-a\\main', 'fb')).toBe('proj-a')
    expect(deriveWorkspaceProjectFolder('', '  CustomName  ')).toBe('CustomName')
    expect(deriveWorkspaceProjectFolder('', '')).toBe('General')

    expect(await listWorkspaceScopesForUi(createMockHost({ omitHost: true }).api)).toEqual({
      currentScopeId: '',
      currentScopeLabel: '',
      workspaces: [],
    })
    const scopeMatchByNameHost = createMockHost({
      workspaces: [{ id: 'ws-a', path: 'D:\\ws\\alpha', name: 'Alpha', branch: 'dev' }],
      readContextResult: { workspaceId: 'unmatched-id', displayName: 'Alpha', branch: 'dev' },
    })
    const matchedScopes = await listWorkspaceScopesForUi(scopeMatchByNameHost.api)
    expect(matchedScopes.currentScopeLabel).toBe('Alpha (dev)')

    const scopeUnmatchedHost = createMockHost({
      workspaces: [{ id: 'ws-a', path: 'D:\\ws\\alpha', name: 'Alpha', branch: 'dev' }],
      readContextResult: { workspaceId: 'folder:0123456789abcdef' },
    })
    const scopesUnmatched = await listWorkspaceScopesForUi(scopeUnmatchedHost.api)
    expect(scopesUnmatched.currentScopeId).toBe('folder:0123456789abcdef')
    expect(scopesUnmatched.workspaces[0]?.name).toBe('Current Workspace')
    expect(scopesUnmatched.workspaces[0]?.isCurrent).toBe(true)

    const scopeThrowHost = createMockHost({
      workspaceListThrows: true,
      readContextThrows: true,
    })
    expect((await listWorkspaceScopesForUi(scopeThrowHost.api)).workspaces).toEqual([])

    const scopeNoCtxId = createMockHost({
      workspaces: [{ id: 'ws-1', path: '', branch: 'main' }],
      readContextResult: {},
    })
    expect((await listWorkspaceScopesForUi(scopeNoCtxId.api)).currentScopeId).toBe('ws-1')

    // 8. listDirectoryForPicker: parent fallback, file strictDir error, mode:'folder', symlinks, >500 truncation, readdir error
    const pickerDir = path.join(tmpBase, 'picker-dir')
    const bigDir = path.join(pickerDir, 'big505')
    fs.mkdirSync(bigDir, { recursive: true })
    const sampleFile = path.join(pickerDir, 'sample.txt')
    fs.writeFileSync(sampleFile, 'hello', 'utf8')
    for (let i = 0; i < 502; i++) {
      fs.writeFileSync(path.join(bigDir, `f_${String(i).padStart(3, '0')}.sql`), '')
    }

    expect((await listDirectoryForPicker({ dir: path.join(pickerDir, 'nonexistent-child.db') })).currentDir).toBe(pickerDir)
    const savedIsolatedHome = mockHomeState.isolatedHomedir
    mockHomeState.isolatedHomedir = path.join(tmpBase, 'missing-home-xyz', 'sub')
    try {
      const dotFallback = await listDirectoryForPicker(
        { dir: path.join(tmpBase, 'missing-1', 'missing-2') },
        [path.join(tmpBase, 'missing-ws', 'sub')]
      )
      expect(dotFallback.currentDir).toBe(path.resolve('.'))
    } finally {
      mockHomeState.isolatedHomedir = savedIsolatedHome
    }
    expect((await listDirectoryForPicker({ dir: sampleFile, strictDir: true })).ok).toBe(false)
    expect((await listDirectoryForPicker({ dir: path.parse(pickerDir).root, strictDir: true })).parentDir).toBeNull()
    expect((await listDirectoryForPicker({ dir: pickerDir, mode: 'folder', strictDir: true })).entries.every((e) => e.kind === 'dir')).toBe(true)

    const truncatedRes = await listDirectoryForPicker({ dir: bigDir, strictDir: true })
    expect(truncatedRes.ok).toBe(true)
    expect(truncatedRes.truncated).toBe(true)
    expect(truncatedRes.entries.length).toBe(500)

    const origPickerReaddir = fs.promises.readdir
    const pickerReaddirSpy = vi.spyOn(fs.promises, 'readdir').mockImplementation((async (
      dir: fs.PathLike,
      opts?: unknown
    ) => {
      if (String(dir) === path.join(pickerDir, 'readdir-fail')) throw new Error('EACCES picker')
      if (String(dir) === pickerDir && opts) {
        return [
          { name: 'sym-valid', isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false },
          { name: 'sym-broken', isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false },
        ] as unknown as fs.Dirent[]
      }
      return origPickerReaddir.call(fs.promises, dir, opts as never)
    }) as typeof fs.promises.readdir)
    const origPickerStat = fs.promises.stat
    const pickerStatSpy = vi.spyOn(fs.promises, 'stat').mockImplementation((async (p: fs.PathLike) => {
      if (String(p).endsWith('sym-valid')) return origPickerStat.call(fs.promises, sampleFile)
      if (String(p).endsWith('sym-broken')) throw new Error('ENOENT symlink')
      return origPickerStat.call(fs.promises, p)
    }) as typeof fs.promises.stat)

    const symListed = await listDirectoryForPicker({ dir: pickerDir, strictDir: true })
    expect(symListed.entries.some((e) => e.name === 'sym-valid')).toBe(true)
    expect(symListed.entries.some((e) => e.name === 'sym-broken')).toBe(false)

    fs.mkdirSync(path.join(pickerDir, 'readdir-fail'), { recursive: true })
    expect((await listDirectoryForPicker({ dir: path.join(pickerDir, 'readdir-fail'), strictDir: true })).ok).toBe(false)
    pickerReaddirSpy.mockRestore()
    pickerStatSpy.mockRestore()

    // >500 directory entries truncation (L1223)
    const manyDirsMock = vi.spyOn(fs.promises, 'readdir').mockResolvedValueOnce(
      Array.from({ length: 502 }, (_, i) => ({
        name: `d_${i}`,
        isSymbolicLink: () => false,
        isDirectory: () => true,
        isFile: () => false,
      })) as unknown as fs.Dirent[]
    )
    const manyDirsRes = await listDirectoryForPicker({ dir: pickerDir, strictDir: true })
    expect(manyDirsRes.truncated).toBe(true)
    manyDirsMock.mockRestore()

    // 9. ensureByodDirectoryScaffolded / scaffoldLocalDriverDirectory validation & overwrite branches
    await expect(scaffoldLocalDriverDirectory({ driverId: 'bad id!', localPath: tmpBase })).rejects.toThrow(/Driver ID/i)
    await expect(scaffoldLocalDriverDirectory({ driverId: 'postgres', localPath: tmpBase })).rejects.toThrow(/built-in/i)
    await expect(ensureByodDirectoryScaffolded('duckdb', '   ')).rejects.toThrow(/required/i)

    const explicitDir = path.join(tmpBase, 'byod-explicit')
    fs.mkdirSync(explicitDir, { recursive: true })
    fs.writeFileSync(
      path.join(explicitDir, 'package.json'),
      JSON.stringify({ name: 'custom-pkg', exports: { '.': './x.js' }, scripts: { postinstall: 'bad' } }),
      'utf8'
    )
    const customEntry = path.join(explicitDir, 'custom-driver.mjs')
    const res1 = await ensureByodDirectoryScaffolded('snowflake', customEntry, false)
    expect(res1.wroteCanonicalEntry).toBe(true)
    const pkgAfter = JSON.parse(fs.readFileSync(path.join(explicitDir, 'package.json'), 'utf8'))
    expect(pkgAfter.exports).toBeUndefined()
    expect(pkgAfter.scripts).toBeUndefined()

    // Existing canonical matches -> wroteCanonicalEntry true; modified -> false; readFile err -> false; overwriteEntry true -> true
    expect((await ensureByodDirectoryScaffolded('snowflake', customEntry, false)).wroteCanonicalEntry).toBe(true)
    const rfFailOnce = vi.spyOn(fs.promises, 'readFile').mockImplementation(async (p) => {
      if (String(p) === customEntry) throw new Error('EACCES read entry')
      return '{}'
    })
    expect((await ensureByodDirectoryScaffolded('snowflake', customEntry, false)).wroteCanonicalEntry).toBe(false)
    rfFailOnce.mockRestore()
    fs.writeFileSync(customEntry, '// modified by user\n', 'utf8')
    expect((await ensureByodDirectoryScaffolded('snowflake', customEntry, false)).wroteCanonicalEntry).toBe(false)
    expect((await ensureByodDirectoryScaffolded('snowflake', customEntry, true)).wroteCanonicalEntry).toBe(true)

    // 10. fitResponseWithinOrcaIpcLimit exhaustive branches (circular/non-object, primitive, dataCache, viewState, shrinkDdl, entries, object rows, resultSets)
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(fitResponseWithinOrcaIpcLimit(circular)).toBe(circular)
    expect(fitResponseWithinOrcaIpcLimit('x'.repeat(1_100_000))).toBeTypeOf('string')

    // clampViewStateToFit direct path (dataCache: null + >950KB viewState) + dataCache shrink after deleting pageData/lastSqlResult
    const clampVsOnly = fitResponseWithinOrcaIpcLimit({
      dataCache: null,
      viewState: {
        sqlDraft: 's'.repeat(15_000),
        consoleTabs: { tabs: Array.from({ length: 10 }, (_, i) => (i === 0 ? 'bad' : { id: i, sql: 'q'.repeat(5000) })) },
        columnConfigByTable: { a: 'x'.repeat(960_000) },
      },
    })
    expect((clampVsOnly.viewState as Record<string, unknown>)?.columnConfigByTable).toBeUndefined()

    const shrinkDataCache = fitResponseWithinOrcaIpcLimit({
      dataCache: {
        lastSqlResult: { unshrinkable: 'k'.repeat(960_000) },
        keep: 'small',
      },
      viewState: null,
    })
    expect((shrinkDataCache.dataCache as Record<string, unknown>)?.keep).toBe('small')

    const nullDataCache = fitResponseWithinOrcaIpcLimit({
      dataCache: { otherBig: 'm'.repeat(960_000) },
      viewState: null,
    })
    expect(nullDataCache.dataCache).toBeNull()

    // entries wrapper fitting on first 4096 pass
    const entriesFirstPass = fitResponseWithinOrcaIpcLimit({
      entries: Array.from({ length: 100 }, (_, i) => ({ id: i, sql: 'q'.repeat(12_000) })),
    })
    expect(entriesFirstPass.entries.length).toBe(100)

    // Non-serializable cell on 2nd stringify inside compactCellValue + primitive row + null resultSet element + rows-only step 4
    let toJsonCalls = 0
    const flakeyObj = {
      toJSON() {
        toJsonCalls++
        if (toJsonCalls === 2) throw new Error('non-serializable on compactCellValue')
        return 'ok'
      },
    }
    const bigintCellRes = fitResponseWithinOrcaIpcLimit({
      rows: [123, [flakeyObj], ...Array.from({ length: 1000 }, () => ['z'.repeat(1200)])],
    })
    expect(Array.isArray(bigintCellRes.rows)).toBe(true)

    const rowsOnlyStep4 = fitResponseWithinOrcaIpcLimit({
      rows: Array.from({ length: 30_000 }, (_, idx) => [`r_${idx}_${'y'.repeat(50)}`]),
      rowCount: 30_000,
    })
    expect(rowsOnlyStep4.truncated).toBe(true)

    const nullRsElem = fitResponseWithinOrcaIpcLimit({
      rows: Array.from({ length: 30_000 }, (_, idx) => [`r_${idx}_${'y'.repeat(50)}`]),
      resultSets: [null as never],
    })
    expect(nullRsElem.truncated).toBe(true)

    // viewState + dataCache progressive clamp -> dataCache delete -> dataCache null -> viewState null
    const hugeBlock = 'k'.repeat(600_000)
    const hugeSnap1 = fitResponseWithinOrcaIpcLimit({
      dataCache: { lastSqlResult: { rows: [[hugeBlock, hugeBlock]] }, keepFlag: true },
      viewState: {
        sqlDraft: 's'.repeat(12_000),
        consoleTabs: { tabs: Array.from({ length: 10 }, (_, i) => (i === 0 ? 'bad' : { id: i, sql: 'q'.repeat(5000) })) },
        columnConfigByTable: { a: 'x'.repeat(400_000) },
      },
    })
    expect(Buffer.byteLength(JSON.stringify(hugeSnap1), 'utf8')).toBeLessThanOrEqual(950_000)

    const hugeSnapNull = fitResponseWithinOrcaIpcLimit({
      dataCache: { giantRaw: 'g'.repeat(1_050_000) },
      viewState: { giantVs: 'v'.repeat(1_050_000) },
    })
    expect(hugeSnapNull.dataCache).toBeNull()
    expect(hugeSnapNull.viewState).toBeNull()

    // shrinkDdlFieldToFit failing 8 attempts due to unshrinkable sibling field
    const hugeDdlWithExtra = fitResponseWithinOrcaIpcLimit({
      ddl: 'CREATE TABLE x (id INT);'.repeat(50_000),
      extra: 'e'.repeat(10_000),
    })
    expect(hugeDdlWithExtra.ddl.length).toBeLessThan(900_000)
    const hugeDdlFallback = fitResponseWithinOrcaIpcLimit({
      ddl: 'SELECT 1;',
      hugeSibling: 's'.repeat(1_000_000),
    })
    expect(hugeDdlFallback.ddl).toContain('DDL truncated')

    // entries wrapper requiring second compaction tier & slice
    const bigEntriesObj = fitResponseWithinOrcaIpcLimit({
      entries: Array.from({ length: 1000 }, (_, i) => ({ id: i, sql: 'q'.repeat(2500) })),
    })
    expect(bigEntriesObj.entries.length).toBeLessThan(1000)

    // Object rows (step 3 cell compaction + step 4 clamping) + 1 giant unshrinkable row + unshrinkable resultSets fallback
    const hugeObjRows = fitResponseWithinOrcaIpcLimit({
      rows: [{ a: 'r'.repeat(5000), b: { nested: 'n'.repeat(5000) } }, ...Array.from({ length: 1000 }, () => ({ a: 'y'.repeat(2000) }))],
      rowCount: 1001,
    })
    expect((hugeObjRows.rows[0] as { a: string }).a).toContain('… [+')
    expect(Buffer.byteLength(JSON.stringify(hugeObjRows), 'utf8')).toBeLessThanOrEqual(950_000)

    const singleHugeRow = fitResponseWithinOrcaIpcLimit({
      rows: [Array.from({ length: 45_000 }, () => 'abcdefghij')],
      rowCount: 1,
      resultSets: [
        {
          index: 0,
          sql: 's',
          columns: [],
          rows: [Array.from({ length: 45_000 }, () => 'klmnopqrst')],
          rowCount: 1,
          executionTimeMs: 1,
          truncated: false,
          isSelect: true,
        },
        {
          index: 1,
          sql: 's2',
          columns: [],
          rows: [],
          rowCount: 0,
          executionTimeMs: 1,
          truncated: false,
          isSelect: true,
        },
      ],
    })
    expect(singleHugeRow.rows).toEqual([])
    expect(singleHugeRow.rowCount).toBe(0)

    const unshrinkableRs = fitResponseWithinOrcaIpcLimit({
      rows: [['x'], ['y']],
      rowCount: 2,
      resultSets: [
        {
          index: 0,
          sql: 's'.repeat(1_050_000),
          columns: [],
          rows: [],
          rowCount: 0,
          executionTimeMs: 1,
          truncated: false,
          isSelect: true,
        },
      ],
    })
    expect(unshrinkableRs.resultSets).toEqual([])

    // Round 2 worker-utils tails: sqlite non-main schema & non-Error editor.open throw, url non-string/blank, backup non-object viewState,
    // workspace scopes bad/no-name/no-id-ctx/empty-list, picker non-string dir/file-target/dups/ext/truncated/non-Error, BYOD invalid paths,
    // empty columnName preview, empty ddl / array viewState / resultSets-only IPC compaction
    expect(
      sanitizeConnectionProfile({ id: 'u_bad_url', name: 'U', driver: 'postgres', url: 123 as never }).url
    ).toBeUndefined()
    expect(
      sanitizeConnectionProfile({ id: 'u_ws_url', name: 'U', driver: 'postgres', url: '   ' }).url
    ).toBeUndefined()

    const sqMainHost = createMockHost({ workspaces: [{ id: 'ws1', path: path.join(tmpBase, 'studio-ws'), name: 'App' }] })
    const smSqMain = new SessionManager(sqMainHost.api)
    await smSqMain.saveStoredConnections([{ id: 'c_sq', name: 'SQ', driver: 'sqlite', filePath: ':memory:' }])
    await openStudioDocumentInOrca(sqMainHost.api, { connectionId: 'c_sq', table: 'items', schema: 'temp' }, smSqMain)
    vi.spyOn(sqMainHost.api.host!, 'call').mockImplementation(async (m: string) => {
      if (m === 'editor.open') throw 'non_error_editor_open'
      if (m === 'workspace.list') return { workspaces: [{ id: 'ws1', path: path.join(tmpBase, 'studio-ws'), name: 'App' }] }
      return null
    })
    expect((await openStudioDocumentInOrca(sqMainHost.api, { connectionId: 'c_sq' }, smSqMain)).ok).toBe(false)
    await smSqMain.closeAll()
    vi.restoreAllMocks()

    clearInMemoryUiSessionSnapshots()
    const snapEdgeHost = createMockHost()
    await saveUiSessionSnapshot(snapEdgeHost.api, 'panel', { viewState: null, dataCache: null })
    expect((await getUiSessionSnapshot(snapEdgeHost.api, 'panel')).dataCache).toBeNull()
    clearInMemoryUiSessionSnapshots()
    await writeHostConfigBackupPatch({ panelViewState: null, studioViewState: null })
    await flushHostConfigBackupWrites()
    await snapEdgeHost.api.storage.set('datanoa.panelViewState', 'not-an-object')
    expect((await getUiSessionSnapshot(snapEdgeHost.api, 'panel')).viewState).toBeNull()
    await snapEdgeHost.api.storage.set('datanoa.panelViewState', { sqlDraft: 'SELECT 99;' })
    expect((await getUiSessionSnapshot(snapEdgeHost.api, 'panel')).viewState).toEqual({ sqlDraft: 'SELECT 99;' })

    const scopeBadHost = createMockHost({
      workspaces: [
        { id: '' as string, path: '' },
        { id: 'w_noname', path: path.join(tmpBase, 'proj-alpha'), name: '  ', branch: '  ' },
      ],
      readContextResult: { workspaceId: '', displayName: 'proj-alpha', branch: '' },
    })
    const sc1 = await listWorkspaceScopesForUi(scopeBadHost.api)
    expect(sc1.currentScopeId).toBe('w_noname')

    const scopeFallbackHost = createMockHost({
      workspaces: [{ id: 'w_other', path: path.join(tmpBase, 'proj-beta'), name: 'Beta' }],
      readContextResult: { workspaceId: 'folder:deadbeef', displayName: '', branch: '' },
    })
    const sc2 = await listWorkspaceScopesForUi(scopeFallbackHost.api)
    expect(sc2.currentScopeLabel).toBe('Current Workspace')

    const scopeEmptyHost = createMockHost({ workspaces: [], readContextResult: null })
    expect((await listWorkspaceScopesForUi(scopeEmptyHost.api)).currentScopeId).toBe('')

    const pickerFileDir = path.join(tmpBase, 'picker-505')
    fs.mkdirSync(pickerFileDir, { recursive: true })
    for (let i = 0; i < 505; i++) {
      fs.writeFileSync(path.join(pickerFileDir, `f_${String(i).padStart(3, '0')}.sql`), '')
    }
    const pickerLeaf = path.join(pickerFileDir, 'f_000.sql')
    const pNonStr = await listDirectoryForPicker({ dir: 123 as never, extensions: ['sql', '.db'] }, [pickerFileDir, pickerFileDir])
    expect(pNonStr.ok).toBe(true)
    const pFromFile = await listDirectoryForPicker({ dir: pickerLeaf })
    expect(pFromFile.ok).toBe(true)
    expect(pFromFile.truncated).toBe(true)

    const pReaddirErr = vi.spyOn(fs.promises, 'readdir').mockRejectedValueOnce('raw_readdir_err')
    expect((await listDirectoryForPicker({ dir: pickerFileDir })).error).toBe('raw_readdir_err')
    pReaddirErr.mockRestore()

    expect(Object.keys(getDefaultByodDriverDirs()).length).toBeGreaterThan(0)
    await expect(scaffoldLocalDriverDirectory({ driverId: undefined as never, localPath: 'x' })).rejects.toThrow(/Driver ID/i)
    await expect(scaffoldLocalDriverDirectory({ driverId: 'duckdb', localPath: 123 as never })).rejects.toThrow()
    expect(() =>
      assertNoCompactedPreviewOverwrite('hello… [+5 chars]', '')
    ).toThrow(/truncated display preview/i)

    expect(fitResponseWithinOrcaIpcLimit({ ddl: '', big: 'x'.repeat(960_000) }).big).toBeDefined()
    expect(fitResponseWithinOrcaIpcLimit({ viewState: ['arr'], big: 'x'.repeat(960_000) }).big).toBeDefined()
    const rsOnlyRes = fitResponseWithinOrcaIpcLimit({
      resultSets: [
        'bad-rs' as never,
        {
          index: 0,
          sql: 'SELECT *',
          columns: [],
          rows: Array.from({ length: 30_000 }, (_, idx) => [`r_${idx}_${'y'.repeat(50)}`]),
          rowCount: 30_000,
          executionTimeMs: 1,
          truncated: false,
          isSelect: true,
        },
      ],
    })
    expect(rsOnlyRes.truncated).toBe(true)
  }, 20_000)

  it('Slice 3: closes session-manager.ts target resolution, secrets, dead-session eviction & real local TCP SSH tunnels', async () => {
    // 1. resolveSshTunnelTarget & buildTunnelProxiedProfile PBT + edge variants
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 65535 }), (port) => {
        const res = resolveSshTunnelTarget({
          id: 'c',
          name: 'C',
          driver: 'mongodb',
          url: `mongodb://mongo.internal:${port}/app`,
        })
        expect(res).toEqual({ targetHost: 'mongo.internal', targetPort: port })
      }),
      { numRuns: 20 }
    )
    expect(resolveSshTunnelTarget({ id: 'm1', name: 'M', driver: 'mongodb', url: 'mongodb://m.local/db' })).toEqual({
      targetHost: 'm.local',
      targetPort: 27017,
    })
    expect(resolveSshTunnelTarget({ id: 'c1', name: 'C', driver: 'clickhouse', url: 'clickhouses://ch.local/db' })).toEqual({
      targetHost: 'ch.local',
      targetPort: 8443,
    })
    expect(resolveSshTunnelTarget({ id: 'c2', name: 'C', driver: 'clickhouse', url: 'https://ch.local/db' })).toEqual({
      targetHost: 'ch.local',
      targetPort: 443,
    })
    expect(resolveSshTunnelTarget({ id: 'o1', name: 'O', driver: 'oracle', url: 'oracle://ora.local/FREEPDB1' })).toEqual({
      targetHost: 'ora.local',
      targetPort: 1521,
    })
    expect(resolveSshTunnelTarget({ id: 'ms1', name: 'MS', driver: 'mssql', url: 'Server=sql.internal;Database=db' })).toEqual({
      targetHost: 'sql.internal',
      targetPort: 1433,
    })
    expect(resolveSshTunnelTarget({ id: 'ms2', name: 'MS', driver: 'mssql', url: 'Server= ;Database=db', host: 'fb.host' })).toEqual({
      targetHost: 'fb.host',
      targetPort: 1433,
    })
    expect(resolveSshTunnelTarget({ id: 'ms3', name: 'MS', driver: 'mssql', url: 'Driver=SQL Server;Database=db', host: 'fb2.host' })).toEqual({
      targetHost: 'fb2.host',
      targetPort: 1433,
    })
    expect(resolveSshTunnelTarget({ id: 'ms4', name: 'MS', driver: 'mssql', url: 'Server=tcp:sql.internal,badport;Database=db' })).toEqual({
      targetHost: 'sql.internal',
      targetPort: 1433,
    })
    expect(resolveSshTunnelTarget({ id: 'pg_def', name: 'PG', driver: 'postgres', port: 5432 })).toEqual({
      targetHost: 'localhost',
      targetPort: 5432,
    })
    expect(
      buildTunnelProxiedProfile(
        { id: 'ms5', name: 'MS', driver: 'mssql', url: 'Driver=SQL Server;Database=db' },
        { localHost: '127.0.0.1', localPort: 45556 }
      ).url
    ).toBe('Driver=SQL Server;Database=db')
    expect(resolveSshTunnelTarget({ id: 'dk1', name: 'D', driver: 'duckdb' as never, host: 'duck.host' })).toEqual({
      targetHost: 'duck.host',
      targetPort: 0,
    })
    expect(() =>
      resolveSshTunnelTarget({
        id: 'msrv',
        name: 'M',
        driver: 'mongodb',
        url: 'mongodb+srv://cluster.example.net/db',
      })
    ).toThrow(/mongodb\+srv/i)
    expect(() =>
      buildTunnelProxiedProfile(
        { id: 'msrv', name: 'M', driver: 'mongodb', url: 'mongodb+srv://cluster.example.net/db' },
        { localHost: '127.0.0.1', localPort: 45555 }
      )
    ).toThrow(/mongodb\+srv/i)

    // 2. assertSecureSecretStorage variants (host.call fallback + hasFn=true + throws), legacy 'connections' fallback, empty extended/driver guards
    const hostFallbackKeyring = createMockHost({
      useHostProtectionOnly: true,
      hasFn: () => true,
      protectionStatus: { status: 'os-keyring' },
    })
    const smFallback = new SessionManager(hostFallbackKeyring.api)
    await hostFallbackKeyring.api.storage.set('connections', [{ id: 'leg_1', name: 'Leg', driver: 'sqlite', filePath: ':memory:' }])
    expect((await smFallback.getStoredConnections()).map((c) => c.id)).toEqual(['leg_1'])
    expect(await smFallback.getExtendedSecrets('')).toEqual({})
    await smFallback.closeSessionsByDriver('')
    await smFallback.saveSecret('c1', { password: 'p1', authToken: 't1' })
    expect(await smFallback.getSecret('c1', 'libsql')).toBe('t1')
    expect(await smFallback.getSecret('c1', 'd1')).toBe('t1')
    await smFallback.saveSecret('c1', { password: '' })
    expect(await smFallback.getSecret('c1', 'postgres')).toBeUndefined()
    await smFallback.copySecret('', 'c2')
    await smFallback.copySecret('c1', 'c1')
    await smFallback.copySecret('no_secrets_id', 'c2')

    const hostProtNum = createMockHost({ protectionStatus: { status: 123 } })
    await expect(new SessionManager(hostProtNum.api).assertSecureSecretStorage()).rejects.toThrow(/OS keyring/i)
    const hostProtThrows = createMockHost({ protectionThrows: true })
    await expect(new SessionManager(hostProtThrows.api).assertSecureSecretStorage()).rejects.toThrow(/OS keyring/i)

    // 3. Unsupported driver without driverManager, missing connectionId getSession, libsql secret branch, dead session eviction, superseded getSession
    await expect(smFallback.testConnection({ id: 'u', name: 'U', driver: 'unknown_eng' as never })).rejects.toThrow(/Unsupported/i)
    await expect(smFallback.getSession('does-not-exist')).rejects.toMatchObject({ code: 'invalid_params' })
    await smFallback.saveStoredConnections([
      { id: 'ls_get_sess', name: 'LS', driver: 'libsql', url: 'https://bad-invalid-host-xyz.invalid' },
      { id: 'ls_no_tok', name: 'LS2', driver: 'libsql', url: 'http://127.0.0.1:18080', hasAuthToken: false },
    ])
    expect((await smFallback.getSession('ls_get_sess')).driverType).toBe('libsql')
    expect((await smFallback.getSession('ls_no_tok')).driverType).toBe('libsql')
    await smFallback.closeAll()

    // 4. Local TCP forwarder SSH tunnel + BYOD SessionManager lifecycle + superseded + close error catches
    const forwarderScript = path.join(tmpBase, 'sm-ssh-forwarder.mjs')
    fs.writeFileSync(
      forwarderScript,
      `
import * as net from 'node:net';
const args = process.argv.slice(2);
const lIdx = args.indexOf('-L');
const parts = (lIdx >= 0 ? args[lIdx + 1] : '').split(':');
const localPort = Number(parts[1]);
const targetPort = Number(parts[parts.length - 1]);
const targetHost = parts.slice(2, parts.length - 1).join(':').replace(/^\\[|\\]$/g, '');
const srv = net.createServer((client) => {
  const up = net.connect({ host: targetHost, port: targetPort });
  client.pipe(up);
  up.pipe(client);
  const stop = () => { client.destroy(); up.destroy(); };
  client.on('error', stop);
  up.on('error', stop);
});
srv.listen(localPort, '127.0.0.1');
process.on('SIGTERM', () => srv.close(() => process.exit(0)));
      `,
      'utf8'
    )

    const tcpTarget = net.createServer((sock) => sock.on('error', () => {}))
    await new Promise<void>((resolve) => tcpTarget.listen(0, '127.0.0.1', () => resolve()))
    const targetPort = (tcpTarget.address() as net.AddressInfo).port

    try {
      vi.resetModules()
      let supersedingRef: { closeSession: (id: string) => Promise<void> } | null = null
      let supersedeDuringTunnel = false
      vi.doMock('../src/drivers/common/tls-and-tunnel', async (importOriginal) => {
        const actual = await importOriginal<typeof import('../src/drivers/common/tls-and-tunnel')>()
        return {
          ...actual,
          openSshTunnel: async (profile: ConnectionProfile, tHost: string, tPort: number, opts?: Record<string, unknown>) => {
            const handle = await actual.openSshTunnel(profile, tHost, tPort, {
              ...opts,
              sshBinary: forwarderScript,
            })
            if (supersedeDuringTunnel && supersedingRef) {
              supersedeDuringTunnel = false
              await supersedingRef.closeSession(profile.id)
            }
            return handle
          },
        }
      })
      const { SessionManager: TunneledSessionManager } = await import('../src/worker/session-manager')

      const host = createMockHost()
      const sm = new TunneledSessionManager(host.api)
      supersedingRef = sm

      let createBehavior: 'ok' | 'throw' | 'supersede-inside-create' = 'ok'
      let sessionAlive = true
      let closeShouldThrow = false
      const createdSessions: Array<{ close: () => Promise<void> }> = []

      sm.setDriverManager({
        resolveVerifiedAdapter: async () => ({
          type: 'duckdb' as never,
          testConnection: async (prof) => ({ ok: Boolean(prof.port), message: 'ok' }),
          createSession: async (prof) => {
            if (createBehavior === 'throw') throw new Error('createSession exploded')
            if (createBehavior === 'supersede-inside-create') {
              await sm.closeSession('duck_ssh')
            }
            sessionAlive = true
            const sess = {
              driverType: prof.driver,
              profile: prof,
              isAlive: () => sessionAlive,
              close: async () => {
                if (closeShouldThrow) throw new Error('close exploded password=secret_pw_123')
              },
              test: async () => ({ ok: true }),
              listObjects: async () => [],
              getTableDetails: async () => ({ name: 't', kind: 'table' as const, columns: [], primaryKey: [] }),
              fetchPage: async () => ({ columns: [], rows: [], page: 1, pageSize: 10, totalRows: 0, totalPages: 0 }),
              updateCell: async () => ({ ok: true, affectedRows: 0 }),
              previewChanges: async () => ({ statements: [] }),
              applyChanges: async () => ({ ok: true, inserted: 0, updated: 0, deleted: 0, statements: [] }),
              getDdl: async () => '',
              runQuery: async () => ({ columns: [], rows: [], rowCount: 0, executionTimeMs: 0, truncated: false, isSelect: true }),
              cancelQuery: async () => ({ ok: true }),
              getTransactionState: () => ({ active: false, autoCommit: true, statementCount: 0, supported: false }),
              beginTransaction: async () => ({ active: false, autoCommit: true, statementCount: 0, supported: false }),
              commitTransaction: async () => ({ active: false, autoCommit: true, statementCount: 0, supported: false }),
              rollbackTransaction: async () => ({ active: false, autoCommit: true, statementCount: 0, supported: false }),
              setAutoCommit: async () => ({ active: false, autoCommit: true, statementCount: 0, supported: false }),
            }
            createdSessions.push(sess)
            return sess
          },
        }),
      })

      const tunneledProfile: ConnectionProfile = {
        id: 'duck_ssh',
        name: 'Duck SSH',
        driver: 'duckdb' as never,
        host: '127.0.0.1',
        port: targetPort,
        hasPassword: true,
        hasSshPassword: true,
        sshEnabled: true,
        sshHost: '127.0.0.1',
        sshPort: 22,
        sshUser: 'datanoa',
        sshAuthMethod: 'password',
      }
      await sm.saveStoredConnections([tunneledProfile])
      await sm.saveSecret('duck_ssh', { password: 'dbpw', sshPassword: 'sshpw' })

      // withTunnel success
      expect((await sm.testConnection(tunneledProfile, 'dbpw', { sshPassword: 'sshpw' })).ok).toBe(true)

      // openSessionWithTunnel success + wrapped isAlive() + idempotent wrapped close()
      const s1 = await sm.getSession('duck_ssh')
      expect(s1.isAlive()).toBe(true)
      expect(sm.hasActiveSession('duck_ssh')).toBe(true)
      // Mark dead so next getSession evicts stale dead session (L396-398)
      sessionAlive = false
      expect(sm.hasActiveSession('duck_ssh')).toBe(false)
      const s2 = await sm.getSession('duck_ssh')
      expect(s2).not.toBe(s1)
      await s2.close()
      await s2.close()

      // createSession throws -> releases tunnel & rethrows
      await sm.closeSession('duck_ssh')
      createBehavior = 'throw'
      await expect(sm.getSession('duck_ssh')).rejects.toThrow(/createSession exploded/)

      // Superseded deterministically right after openSshTunnel resolves (L562-565)
      createBehavior = 'ok'
      supersedeDuringTunnel = true
      await expect(sm.getSession('duck_ssh')).rejects.toThrow(/superseded/i)

      // Superseded while createSession in flight (deterministic inside createSession)
      createBehavior = 'supersede-inside-create'
      await expect(sm.getSession('duck_ssh')).rejects.toThrow(/superseded/i)

      // Non-SSH direct connection superseded inside createSession (hits session-manager.ts:425-428 + .catch on close)
      const directProfile: ConnectionProfile = {
        id: 'duck_direct',
        name: 'Duck Direct',
        driver: 'duckdb' as never,
        database: ':memory:',
        sshEnabled: false,
      }
      await sm.saveStoredConnections([tunneledProfile, directProfile])
      createBehavior = 'ok'
      sm.setDriverManager({
        resolveVerifiedAdapter: async () => ({
          type: 'duckdb' as never,
          testConnection: async () => ({ ok: true, message: 'ok' }),
          createSession: async (prof) => {
            if (createBehavior === 'throw') throw new Error('createSession exploded')
            if (createBehavior === 'supersede-inside-create') {
              await sm.closeSession(prof.id)
            }
            sessionAlive = true
            const sess = {
              driverType: prof.driver,
              profile: prof,
              isAlive: () => sessionAlive,
              close: async () => {
                if (closeShouldThrow) throw new Error('close exploded password=secret_pw_123')
              },
              test: async () => ({ ok: true }),
              listObjects: async () => [],
              getTableDetails: async () => ({ name: 't', kind: 'table' as const, columns: [], primaryKey: [] }),
              fetchPage: async () => ({ columns: [], rows: [], page: 1, pageSize: 10, totalRows: 0, totalPages: 0 }),
              updateCell: async () => ({ ok: true, affectedRows: 0 }),
              previewChanges: async () => ({ statements: [] }),
              applyChanges: async () => ({ ok: true, inserted: 0, updated: 0, deleted: 0, statements: [] }),
              getDdl: async () => '',
              runQuery: async () => ({ columns: [], rows: [], rowCount: 0, executionTimeMs: 0, truncated: false, isSelect: true }),
              cancelQuery: async () => ({ ok: true }),
              getTransactionState: () => ({ active: false, autoCommit: true, statementCount: 0, supported: false }),
              beginTransaction: async () => ({ active: false, autoCommit: true, statementCount: 0, supported: false }),
              commitTransaction: async () => ({ active: false, autoCommit: true, statementCount: 0, supported: false }),
              rollbackTransaction: async () => ({ active: false, autoCommit: true, statementCount: 0, supported: false }),
              setAutoCommit: async () => ({ active: false, autoCommit: true, statementCount: 0, supported: false }),
            }
            createdSessions.push(sess)
            return sess
          },
        }),
      })
      createBehavior = 'supersede-inside-create'
      closeShouldThrow = true
      await expect(sm.getSession('duck_direct')).rejects.toThrow(/superseded/i)
      closeShouldThrow = false
      createBehavior = 'ok'
      expect((await sm.testConnection(directProfile)).ok).toBe(true)

      // closeSession non-Error catch log + closeSessionsByDriver getStoredConnections catch + closeAll clean & non-Error tunnel/session catches
      createBehavior = 'ok'
      const s3 = await sm.getSession('duck_ssh')
      void s3
      closeShouldThrow = true
      await sm.closeSession('duck_ssh')
      expect(host.logs.some((l) => l.includes('Error closing session'))).toBe(true)

      await sm.getSession('duck_ssh')
      const s3Str = sm.getActiveSessions().get('duck_ssh')!
      s3Str.close = async () => {
        throw 'session_close_string_err'
      }
      await sm.closeSession('duck_ssh')

      closeShouldThrow = false
      await sm.getSession('duck_ssh')
      await sm.closeAll()

      await sm.getSession('duck_ssh')
      vi.spyOn(sm, 'getStoredConnections').mockRejectedValueOnce(new Error('storage fail'))
      await sm.closeSessionsByDriver('duckdb')

      await sm.getSession('duck_ssh')
      closeShouldThrow = true
      // Force active tunnel close() to reject during closeAll()
      const activeTunnels = (sm as unknown as { activeTunnels: Set<{ close: () => Promise<void> }> }).activeTunnels
      for (const t of activeTunnels) {
        const origClose = t.close
        t.close = async () => {
          await origClose()
          throw new Error('tunnel close exploded password=tun_secret_99')
        }
      }
      await sm.closeAll()
      expect(host.logs.some((l) => l.includes('Error closing SSH tunnel'))).toBe(true)
      expect(host.logs.some((l) => l.includes('Error closing session on shutdown'))).toBe(true)

      // Non-Error string throws from both session.close and tunnel.close on closeAll()
      closeShouldThrow = false
      await sm.getSession('duck_ssh')
      sm.getActiveSessions().get('duck_ssh')!.close = async () => {
        throw 'shutdown_sess_str'
      }
      for (const t of activeTunnels) {
        const origClose = t.close
        t.close = async () => {
          await origClose()
          throw 'shutdown_tun_str'
        }
      }
      await sm.closeAll()
    } finally {
      vi.doUnmock('../src/drivers/common/tls-and-tunnel')
      vi.resetModules()
      await new Promise<void>((resolve) => tcpTarget.close(() => resolve()))
    }
  }, 20_000)

  it('Slice 4A: closes rpc-connections.ts & rpc-data-schema.ts handlers, backup restore, LibSQL/D1 rules, BYOD RPCs & schema fallbacks', async () => {
    const host = createMockHost()
    const sm = new SessionManager(host.api)
    const dm = new DriverManager(host.api.storage, (m) => host.api.log(m))
    const schemaCache = new WorkerSchemaMetadataCache()
    registerConnectionHandlers({
      orca: host.api,
      registerHandler: host.api.panels.handle,
      sessionManager: sm,
      driverManager: dm,
      schemaCache,
    })
    registerDataAndSchemaHandlers({
      orca: host.api,
      registerHandler: host.api.panels.handle,
      sessionManager: sm,
      schemaCache,
    })

    // 1. connections.list: empty backup restore no-op, then non-empty backup restore, then ws_* pruning
    await writeHostConfigBackupPatch({ connections: [], byodConfigs: [] })
    await flushHostConfigBackupWrites()
    expect(await host.invoke<ConnectionProfile[]>('connections.list')).toEqual([])

    await writeHostConfigBackupPatch({
      connections: [{ id: 'bk_restored', name: 'Restored', driver: 'sqlite', filePath: ':memory:' }],
      byodConfigs: [],
    })
    await flushHostConfigBackupWrites()
    // Concurrent connections.list exercises double-checked lock latest.length > 0 branch (L102:31)
    const [restoredList, concurrentList] = await Promise.all([
      host.invoke<ConnectionProfile[]>('connections.list'),
      host.invoke<ConnectionProfile[]>('connections.list'),
    ])
    expect(restoredList.some((c) => c.id === 'bk_restored')).toBe(true)
    expect(concurrentList.some((c) => c.id === 'bk_restored')).toBe(true)

    await sm.saveStoredConnections([
      { id: 'ws_auto_1', name: 'WS', driver: 'sqlite', filePath: ':memory:' },
      { id: 'keep_1', name: 'Keep', driver: 'sqlite', filePath: ':memory:' },
    ])
    const prunedList = await host.invoke<ConnectionProfile[]>('connections.list')
    expect(prunedList.map((c) => c.id)).toEqual(['keep_1'])

    // 2. connection.save: D1 / LibSQL validation, HTTP loopback token rejection, auto-ID, sourceConnectionId secret copy, update preserve vs sshEnabled:false
    await expect(
      host.invoke('connection.save', {
        profile: { id: 'd1_bad', name: 'D1', driver: 'd1', url: 'ftp://bad.endpoint' },
      })
    ).rejects.toThrow()
    await expect(
      host.invoke('connection.save', {
        profile: { id: 'd1_http', name: 'D1', driver: 'd1', url: 'http://127.0.0.1:8787' },
        authToken: 'tok-loopback',
      })
    ).rejects.toThrow(/plain HTTP/i)

    // Save source D1 with HTTPS & token, then try cloning into http://127.0.0.1 -> rejected via sourceConnectionId token
    await host.invoke('connection.save', {
      profile: { id: 'd1_https_src', name: 'D1 SRC', driver: 'd1', url: 'https://api.cloudflare.com/client/v4' },
      authToken: 'cf-token-1',
    })
    await expect(
      host.invoke('connection.save', {
        profile: { id: 'd1_http_clone', name: 'D1', driver: 'd1', url: 'http://127.0.0.1:8787' },
        sourceConnectionId: 'd1_https_src',
      })
    ).rejects.toThrow(/plain HTTP/i)
    await host.invoke('connection.save', {
      profile: { id: 'd1_http_existing', name: 'D1', driver: 'd1', url: 'https://api.cloudflare.com/client/v4' },
      authToken: 'cf-token-2',
    })
    await expect(
      host.invoke('connection.save', {
        profile: { id: 'd1_http_existing', name: 'D1', driver: 'd1', url: 'http://127.0.0.1:8787' },
      })
    ).rejects.toThrow(/plain HTTP/i)

    // LibSQL resolveLibsqlEndpointCandidate branches (host+port, libsql:// + ssl:false, bare host, invalid URL, HTTP loopback with token)
    await expect(
      host.invoke('connection.save', {
        profile: { id: 'ls_bad', name: 'LS', driver: 'libsql', url: 'ftp://bad' },
      })
    ).rejects.toThrow()
    await host.invoke('connection.save', {
      profile: { id: 'ls_host', name: 'LS', driver: 'libsql', host: 'db.turso.io', ssl: true },
      authToken: 'ls-tok',
    })
    await host.invoke('connection.save', {
      profile: { id: 'ls_http', name: 'LS', driver: 'libsql', url: 'libsql://127.0.0.1:8080', ssl: false },
    })
    await host.invoke('connection.save', {
      profile: { id: 'ls_bare', name: 'LS', driver: 'libsql', url: 'my-turso.example.com' },
      authToken: 'ls-tok2',
    })
    await host.invoke('connection.save', {
      profile: { id: 'ls_tok_src', name: 'LS', driver: 'libsql', url: 'https://my-turso.example.com' },
      authToken: 'secret-tok',
    })
    await expect(
      host.invoke('connection.save', {
        profile: { id: 'ls_http_clone', name: 'LS', driver: 'libsql', host: '127.0.0.1', port: 8080, ssl: false },
        sourceConnectionId: 'ls_tok_src',
      })
    ).rejects.toThrow()
    await expect(
      host.invoke('connection.save', {
        profile: { id: 'ls_http_direct_tok', name: 'LS', driver: 'libsql', host: '127.0.0.1', port: 8080, ssl: false },
        authToken: 'direct-tok',
      })
    ).rejects.toThrow()
    // Empty authToken bypasses L174 and hits L224 (input.authToken !== undefined)
    await host.invoke('connection.save', {
      profile: { id: 'ls_http_empty_tok', name: 'LS', driver: 'libsql', host: '127.0.0.1', port: 8080, ssl: false },
      authToken: '',
    })
    // Default https:443 host branch (L63) & empty candidate (L69)
    await host.invoke('connection.save', {
      profile: { id: 'ls_443', name: 'LS', driver: 'libsql', host: 'db.turso.io', port: 443, ssl: true },
    })
    await host.invoke('connection.save', {
      profile: { id: 'ls_no_ep', name: 'LS', driver: 'libsql' },
    })
    await host.invoke('connection.parseUri', { uri: 123 as never })

    // Auto-generated id + sourceConnectionId copying all 5 secret prefixes + updating existing profile preserving fields & disabling SSH
    const autoSaved = await host.invoke<{ ok: boolean; id: string }>('connection.save', {
      profile: { id: 'ws_gen', name: 'PG Src', driver: 'postgres', host: '127.0.0.1', port: 5432, folder: 'F1', workspaceScope: 'ws1', sslMode: 'require', sshEnabled: true, sshHost: 'bastion', sshPort: 2222, sshUser: 'u', sshAuthMethod: 'password', d1AccountId: 'a1', d1DatabaseId: 'd1' },
      password: 'p1',
      sslKeyPassphrase: 'k1',
      sshPassphrase: 'sp1',
      sshPassword: 'sw1',
    })
    expect(autoSaved.id).toMatch(/^conn_postgres_/)

    const cloned = await host.invoke<{ ok: boolean; id: string }>('connection.save', {
      profile: { id: 'pg_cloned', name: 'PG Cloned', driver: 'postgres', host: '127.0.0.1', port: 5432 },
      sourceConnectionId: autoSaved.id,
    })
    expect(await sm.getSecret(cloned.id, 'postgres')).toBe('p1')

    // Update existing preserving omitted fields
    await host.invoke('connection.save', {
      profile: { id: autoSaved.id, name: 'PG Updated', driver: 'postgres', host: '127.0.0.1', port: 5432 },
    })
    const updatedList = await host.invoke<ConnectionProfile[]>('connections.list')
    const afterPreserve = updatedList.find((c) => c.id === autoSaved.id)
    expect(afterPreserve?.folder).toBe('F1')
    expect(afterPreserve?.sshEnabled).toBe(true)

    // Update with sshEnabled: false clears SSH fields
    await host.invoke('connection.save', {
      profile: { id: autoSaved.id, name: 'PG NoSSH', driver: 'postgres', host: '127.0.0.1', port: 5432, sshEnabled: false },
    })

    // 3. connection.delete active reassignment -> empty deletion
    await host.api.storage.set('datanoa.activeConnectionId', autoSaved.id)
    await host.invoke('connection.delete', { id: autoSaved.id })
    expect(await host.api.storage.get('datanoa.activeConnectionId')).not.toBe(autoSaved.id)
    for (const c of await host.invoke<ConnectionProfile[]>('connections.list')) {
      await host.invoke('connection.delete', { id: c.id })
    }
    expect(await host.api.storage.get('datanoa.activeConnectionId')).toBeNull()

    // 4. connection.test validation errors & sourceConnectionId secrets
    await expect(
      host.invoke('connection.test', { profile: { driver: 'no_such_driver' } })
    ).rejects.toThrow(/Unsupported/i)
    await expect(
      host.invoke('connection.test', { profile: { driver: 'd1', url: 'ftp://bad' } })
    ).rejects.toThrow()
    await expect(
      host.invoke('connection.test', { profile: { driver: 'libsql', url: 'ftp://bad' } })
    ).rejects.toThrow()

    await host.invoke('connection.save', {
      profile: { id: 'sq_src', name: 'SQ', driver: 'sqlite', filePath: ':memory:', hasSslKeyPassphrase: true, hasSshPassphrase: true, hasSshPassword: true },
      password: 'p',
      sslKeyPassphrase: 'k',
      sshPassphrase: 'sp',
      sshPassword: 'sw',
    })
    expect(
      (
        await host.invoke<{ ok: boolean }>('connection.test', {
          sourceConnectionId: 'sq_src',
          profile: { id: 'conn_test_1', driver: 'sqlite', filePath: ':memory:', hasPassword: true, hasSslKeyPassphrase: true, hasSshPassphrase: true, hasSshPassword: true },
        })
      ).ok
    ).toBe(true)
    expect(
      (
        await host.invoke<{ ok: boolean }>('connection.test', {
          profile: { driver: 'sqlite', filePath: ':memory:' },
        })
      ).ok
    ).toBe(true)

    // 5. sqlite.scanFolder & workspace.detectConnections with omitted/nonexistent/file path & error catch
    const scanFileDir = path.join(tmpBase, 'rpc-scan-file')
    fs.mkdirSync(scanFileDir, { recursive: true })
    const dbFilePath = path.join(scanFileDir, 'leaf.db')
    fs.writeFileSync(dbFilePath, 'SQLite format 3\0')
    expect((await host.invoke<{ files: unknown[] }>('sqlite.scanFolder', {})).files).toEqual([])
    expect((await host.invoke<{ files: unknown[] }>('sqlite.scanFolder', { folderPath: path.join(tmpBase, 'missing-scan-xyz') })).files).toEqual([])
    expect((await host.invoke<{ sqliteFiles: unknown[] }>('workspace.detectConnections', { folderPath: path.join(tmpBase, 'missing-detect-xyz') })).sqliteFiles).toEqual([])
    expect((await host.invoke<{ files: unknown[] }>('sqlite.scanFolder', { folderPath: dbFilePath })).files.length).toBe(1)
    expect((await host.invoke<{ sqliteFiles: unknown[] }>('workspace.detectConnections', { folderPath: dbFilePath })).sqliteFiles.length).toBe(1)

    const readdirOnce = vi.spyOn(fs.promises, 'readdir').mockRejectedValueOnce(new Error('boom'))
    expect((await host.invoke<{ files: unknown[] }>('sqlite.scanFolder', { folderPath: scanFileDir })).files).toEqual([])
    readdirOnce.mockRestore()

    // 6. BYOD RPC missing params, verify sha256 mismatch, setupLocal autoTrust=false & configure error catch, backup sync catch
    for (const [m, arg] of [
      ['drivers.inspectLocal', {}],
      ['drivers.configureLocal', {}],
      ['drivers.verify', {}],
      ['drivers.removeLocal', {}],
      ['drivers.setupLocal', {}],
    ] as const) {
      await expect(host.invoke(m, arg)).rejects.toThrow(/required/i)
    }
    const byodDir = path.join(tmpBase, 'rpc-byod-edge')
    const setupNoTrust = await host.invoke<{ ok: boolean; item?: unknown }>('drivers.setupLocal', {
      driverId: 'duckdb',
      localPath: byodDir,
      autoTrust: false,
    })
    expect(setupNoTrust.ok).toBe(true)
    expect(setupNoTrust.item).toBeUndefined()

    fs.writeFileSync(
      path.join(byodDir, 'index.mjs'),
      "export default { type: 'duckdb', createSession: async () => ({}), testConnection: async () => ({ ok: true }) };\n",
      'utf8'
    )
    const insp = await host.invoke<{ sha256: string }>('drivers.inspectLocal', { driverId: 'duckdb', localPath: byodDir })
    await host.invoke('drivers.configureLocal', { driverId: 'duckdb', localPath: byodDir, trustedSha256: insp.sha256 })
    fs.writeFileSync(
      path.join(byodDir, 'index.mjs'),
      "export default { type: 'duckdb', modified: true, createSession: async () => ({}), testConnection: async () => ({ ok: true }) };\n",
      'utf8'
    )
    const badVerify = await host.invoke<{ ok: boolean }>('drivers.verify', {
      driverId: 'duckdb',
    })
    expect(badVerify.ok).toBe(false)

    vi.spyOn(dm, 'configureLocalDriver').mockRejectedValueOnce(new Error('npm pkg missing'))
    const setupCatch = await host.invoke<{ ok: boolean; item?: unknown }>('drivers.setupLocal', {
      driverId: 'snowflake',
      localPath: path.join(tmpBase, 'rpc-byod-catch'),
    })
    expect(setupCatch.ok).toBe(true)
    expect(setupCatch.item).toBeUndefined()

    // drivers.setupLocal success autoTrust + syncByodConfigsToBackup storage.get catch (L565, L654-655)
    vi.spyOn(dm, 'configureLocalDriver').mockResolvedValueOnce({
      id: 'cassandra',
      name: 'Cassandra',
      category: 'local-byod',
      transport: 'local-path',
      packaging: 'byod-local',
      status: 'local-verified',
    } as never)
    const origStorageGet = host.api.storage.get.bind(host.api.storage)
    const storageSpy = vi.spyOn(host.api.storage, 'get').mockImplementation(async (k: string) => {
      if (k === 'datanoa.customDrivers') throw new Error('storage read fail')
      return origStorageGet(k)
    })
    const setupOkTrust = await host.invoke<{ ok: boolean; item?: unknown }>('drivers.setupLocal', {
      driverId: 'cassandra',
      localPath: path.join(tmpBase, 'rpc-byod-ok-trust'),
    })
    expect(setupOkTrust.ok).toBe(true)
    expect(setupOkTrust.item).toBeDefined()
    storageSpy.mockRestore()

    // 7. rpc-data-schema.ts: missing connectionId, non-string schema, fallback getDdl/listSchemas/getObjectDdl/exportSchemaDdl, fetchPage filter error & default pageSize, updateCell PK array, applyChanges empty updates
    for (const [m, arg] of [
      ['schema.tableDetails', { table: 't' }],
      ['schema.generateDdl', { table: 't' }],
      ['schema.getObjectDdl', { name: 't', kind: 'table' }],
      ['schema.getObjectDdl', { connectionId: 'sq_src' }],
      ['schema.getObjectDdl', { connectionId: 'sq_src', name: 't', kind: 'table', schema: 123 }],
      ['data.fetchPage', { table: 't' }],
      ['data.updateCell', { table: 't' }],
      ['data.updateCell', { connectionId: 'sq_src', table: 't', column: 'c', primaryKeys: [] }],
      ['data.previewChanges', { table: 't' }],
      ['data.applyChanges', { table: 't' }],
    ] as const) {
      await expect(host.invoke(m, arg)).rejects.toThrow()
    }

    await expect(
      host.invoke('data.fetchPage', { connectionId: 'sq_src', table: 't', whereClause: '1=1; DROP TABLE t' })
    ).rejects.toThrow()
    // Non-Error throw from sanitizeFilterClause (L177)
    await expect(
      host.invoke('data.fetchPage', { connectionId: 'sq_src', table: 't', whereClause: 123 as never })
    ).rejects.toThrow()

    // Minimal mock session lacking listSchemas, getObjectDdl, exportSchemaDdl, and throwing getDdl
    const minimalConnId = 'minimal_mock_conn'
    await sm.saveStoredConnections([
      ...(await host.invoke<ConnectionProfile[]>('connections.list')),
      { id: minimalConnId, name: 'Min', driver: 'postgres', database: '' },
    ])
    const mockSessionsMap = sm.getActiveSessions()
    let getDdlMode: 'throw' | 'empty' = 'throw'
    mockSessionsMap.set(minimalConnId, {
      driverType: 'postgres',
      profile: { id: minimalConnId, name: 'Min', driver: 'postgres', database: '' },
      isAlive: () => true,
      close: async () => {},
      test: async () => ({ ok: true }),
      listObjects: async () => [],
      getTableDetails: async (table: string) => ({
        name: table,
        schema: 'public',
        kind: 'table',
        columns: [{ name: 'id', type: 'INT', nullable: false, isPrimaryKey: true }],
        primaryKey: ['id'],
        indexes: [],
        foreignKeys: [],
      }),
      getDdl: async () => {
        if (getDdlMode === 'throw') throw new Error('ddl unavailable')
        return ''
      },
      fetchPage: async (p) => ({
        columns: [],
        rows: [],
        page: p.page,
        pageSize: p.pageSize,
        totalRows: 0,
        totalPages: 0,
      }),
      updateCell: async () => ({ ok: true, affectedRows: 1 }),
      previewChanges: async () => ({ statements: [] }),
      applyChanges: async () => ({ ok: true, inserted: 0, updated: 0, deleted: 0, statements: [] }),
      runQuery: async () => ({ columns: [], rows: [], rowCount: 0, executionTimeMs: 0, truncated: false, isSelect: true }),
      cancelQuery: async () => ({ ok: true }),
      getTransactionState: () => ({ active: false, autoCommit: true, statementCount: 0, supported: false }),
      beginTransaction: async () => ({ active: false, autoCommit: true, statementCount: 0, supported: false }),
      commitTransaction: async () => ({ active: false, autoCommit: true, statementCount: 0, supported: false }),
      rollbackTransaction: async () => ({ active: false, autoCommit: true, statementCount: 0, supported: false }),
      setAutoCommit: async () => ({ active: false, autoCommit: true, statementCount: 0, supported: false }),
    })

    const detFallback = await host.invoke<{ ddl?: string }>('schema.tableDetails', {
      connectionId: minimalConnId,
      table: 'items',
    })
    expect(detFallback.ddl).toContain('CREATE TABLE')
    getDdlMode = 'empty'
    const detEmpty = await host.invoke<{ ddl?: string }>('schema.tableDetails', {
      connectionId: minimalConnId,
      table: 'items',
    })
    expect(detEmpty.ddl).toBeUndefined()

    expect(await host.invoke('schema.listSchemas', { connectionId: minimalConnId })).toEqual({
      schemas: [],
      defaultSchema: '',
    })
    mockSessionsMap.get(minimalConnId)!.profile.database = 'mydb'
    expect(await host.invoke('schema.listSchemas', { connectionId: minimalConnId })).toEqual({
      schemas: ['mydb'],
      defaultSchema: 'mydb',
    })
    await expect(
      host.invoke('schema.getObjectDdl', { connectionId: minimalConnId, name: 'items', kind: 'table' })
    ).rejects.toThrow(/not supported/i)
    await expect(
      host.invoke('schema.exportSchemaDdl', { connectionId: minimalConnId })
    ).rejects.toThrow(/not supported/i)

    // exportSchemaDdl with explicit schema vs fallback 'schema'
    const sqExport = await host.invoke<{ fileName: string }>('schema.exportSchemaDdl', {
      connectionId: 'sq_src',
      schema: 'main',
    })
    expect(sqExport.fileName).toBe('main_schema.sql')
    mockSessionsMap.get(minimalConnId)!.exportSchemaDdl = async () => ({ ddl: 'CREATE TABLE x;', objectCount: 1 })
    mockSessionsMap.get(minimalConnId)!.profile.database = ''
    expect((await host.invoke<{ fileName: string }>('schema.exportSchemaDdl', { connectionId: minimalConnId })).fileName).toBe('schema_schema.sql')

    const minPage = await host.invoke<{ pageSize: number }>('data.fetchPage', {
      connectionId: minimalConnId,
      table: 'items',
      pageSize: 0,
    })
    expect(minPage.pageSize).toBe(50)
    await host.invoke('data.applyChanges', {
      connectionId: minimalConnId,
      table: 'items',
      updates: [{ primaryKeys: { id: 1 }, changes: {} }],
    })
    await host.invoke('data.applyChanges', {
      connectionId: minimalConnId,
      table: 'items',
    })

    await sm.closeAll()

    // Non-desktop host (omitHost: true) -> default surface 'panel' + fs.listDir catch
    const minHost = createMockHost({ omitHost: true })
    const minSm = new SessionManager(minHost.api)
    const minDm = new DriverManager(minHost.api.storage, (m) => minHost.api.log(m))
    registerConnectionHandlers({
      orca: minHost.api,
      registerHandler: minHost.api.panels.handle,
      sessionManager: minSm,
      driverManager: minDm,
    })
    await minHost.invoke('ui.saveSessionSnapshot', { viewState: { tab: 1 } })
    await minHost.invoke('ui.getSessionSnapshot', {})
    await minHost.invoke('fs.listDir', undefined as never)
    await minHost.invoke('drivers.removeLocal', { driverId: 'duckdb' })
    await minSm.closeAll()
  }, 20_000)

  it('Slice 4B: closes rpc-query-tx.ts Mongo/Oracle explain, scrubThrownError, cross-panel TX, !autoCommit, cancel & backup restore', async () => {
    const host = createMockHost()
    const sm = new SessionManager(host.api)
    const schemaCache = new WorkerSchemaMetadataCache()
    const tracker = createQueryRuntimeTracker()
    const onHistoryChanged = vi.fn()
    registerQueryAndTxHandlers({
      orca: host.api,
      registerHandler: host.api.panels.handle,
      sessionManager: sm,
      tracker,
      schemaCache,
      onHistoryChanged,
    })

    // 1. buildExplainPlanForStatement edge cases (MongoDB + Oracle + Postgres)
    expect(
      buildExplainPlanForStatement('EXPLAIN SELECT 1;', 'postgres', true).explainSql
    ).toBe('EXPLAIN SELECT 1')
    expect(
      buildExplainPlanForStatement('EXPLAIN PLAN FOR SELECT 1 FROM DUAL;', 'oracle', false).explainSql
    ).toBe('EXPLAIN PLAN FOR SELECT 1 FROM DUAL')
    expect(() =>
      buildExplainPlanForStatement('INSERT INTO t VALUES (1);', 'oracle', true)
    ).toThrow(/Read-Only/i)

    expect(
      buildExplainPlanForStatement(
        '/* c1 */\n// c2\n-- c3\ndb.getCollection("users").find({ "k": "v\\"x" }).toArray()',
        'mongodb',
        true
      ).explainSql
    ).toContain('.explain("queryPlanner")')
    expect(
      buildExplainPlanForStatement(
        "db.orders.aggregate([/* c */\n// line\n{ $match: { s: 'x\\'y' } }])",
        'mongodb',
        false
      ).explainSql
    ).toContain('.explain("queryPlanner")')
    expect(buildExplainPlanForStatement('db.orders.find(// eof', 'mongodb', false).explainSql).toContain('.explain("queryPlanner")')
    expect(buildExplainPlanForStatement('db.orders.find(/* unclosed', 'mongodb', false).explainSql).toContain('.explain("queryPlanner")')
    expect(buildExplainPlanForStatement('db.orders.find({}); // eof', 'mongodb', false).explainSql).toContain('.explain("queryPlanner")')
    expect(buildExplainPlanForStatement('db.orders.find({}); // eof\n', 'mongodb', false).explainSql).toContain('.explain("queryPlanner")')
    expect(buildExplainPlanForStatement('db.orders.find({}); /* unclosed', 'mongodb', false).explainSql).toContain('.explain("queryPlanner")')
    expect(buildExplainPlanForStatement('db.orders.find({}); /* closed */ ', 'mongodb', false).explainSql).toContain('.explain("queryPlanner")')
    expect(() => buildExplainPlanForStatement('// comment only eof', 'mongodb', false)).toThrow(/cannot be empty/i)
    expect(() => buildExplainPlanForStatement('-- comment only eof', 'mongodb', false)).toThrow(/cannot be empty/i)
    expect(() => buildExplainPlanForStatement('/* unclosed comment eof', 'mongodb', false)).toThrow(/cannot be empty/i)
    expect(() => buildExplainPlanForStatement('{}', 'mongodb', true)).toThrow(/Read-Only/i)
    expect(
      buildExplainPlanForStatement('{"explain": {"find": "users"}, "verbosity": 123}', 'mongodb', true).explainSql
    ).toContain('"find"')
    expect(
      buildExplainPlanForStatement('{"explain": {"insert": "users"}, "verbosity": "queryPlanner"}', 'mongodb', false).explainSql
    ).toContain('"insert"')
    expect(() =>
      buildExplainPlanForStatement('{"explain": {"insert": "users"}, "verbosity": "executionStats"}', 'mongodb', false)
    ).toThrow(/Read-Only/i)
    expect(() =>
      buildExplainPlanForStatement('db.users.insertOne({}).explain("executionStats")', 'mongodb', false)
    ).toThrow(/Read-Only/i)
    expect(buildExplainPlanForStatement('-- only comment', 'postgres', false).explainSql).toContain('EXPLAIN')
    expect(
      buildExplainPlanForStatement('db.users.find({ a: 1 }).explain()', 'mongodb', true).explainSql
    ).toContain('.explain()')
    expect(
      buildExplainPlanForStatement('{ "explain": { "find": "users" } }', 'mongodb', true).explainSql
    ).toContain('"find"')

    for (const badMongo of [
      '/* only comment */',
      '{bad json',
      '[1, 2]',
      '{ "explain": "not-obj" }',
      'db.dropDatabase()',
      'show collections',
      'db.users.insertOne({})',
      'db.users.countDocuments({})',
      'db.users.aggregate([{ $out: "dest" }]).explain("executionStats")',
      'db.users.aggregate({ nested: { $merge: "dest" } })',
    ]) {
      expect(() => buildExplainPlanForStatement(badMongo, 'mongodb', true)).toThrow()
    }
    expect(() => buildExplainPlanForStatement('db.users.insertOne({})', 'mongodb', false)).toThrow(/only supports/i)
    expect(() => buildExplainPlanForStatement('db.users.countDocuments({})', 'mongodb', false)).toThrow(/not supported/i)
    expect(buildExplainPlanForStatement('db.users.find({ a: `u`', 'mongodb', false).explainSql).toContain('.explain("queryPlanner")')

    // 2. Mock connections (Oracle, Mongo, SQL mock with TX state machine + scrubThrownError + active query cancel)
    await sm.saveStoredConnections([
      { id: 'ora_1', name: 'Ora', driver: 'oracle', host: 'h', port: 1521, database: 'ORCL' },
      { id: 'mgo_1', name: 'Mgo', driver: 'mongodb', host: 'h', port: 27017, database: 'app' },
      { id: 'pg_tx', name: 'PG', driver: 'postgres', host: 'h', port: 5432, database: 'app' },
    ])

    const oraQueries: string[] = []
    sm.getActiveSessions().set('ora_1', {
      driverType: 'oracle',
      profile: { id: 'ora_1', name: 'Ora', driver: 'oracle' },
      isAlive: () => true,
      close: async () => {},
      test: async () => ({ ok: true }),
      listObjects: async () => [],
      getTableDetails: async () => ({ name: 't', kind: 'table', columns: [], primaryKey: [] }),
      fetchPage: async () => ({ columns: [], rows: [], page: 1, pageSize: 10, totalRows: 0, totalPages: 0 }),
      updateCell: async () => ({ ok: true, affectedRows: 0 }),
      previewChanges: async () => ({ statements: [] }),
      applyChanges: async () => ({ ok: true, inserted: 0, updated: 0, deleted: 0, statements: [] }),
      getDdl: async () => '',
      runQuery: async (_qid, sql) => {
        oraQueries.push(sql)
        return {
          columns: [{ name: 'PLAN_TABLE_OUTPUT', type: 'TEXT' }],
          rows: [['Plan hash value: 123']],
          rowCount: 1,
          executionTimeMs: 5,
          truncated: false,
          isSelect: true,
        }
      },
      cancelQuery: async () => ({ ok: true }),
      getTransactionState: () => ({ active: false, autoCommit: true, statementCount: 0, supported: false }),
      beginTransaction: async () => ({ active: false, autoCommit: true, statementCount: 0, supported: false }),
      commitTransaction: async () => ({ active: false, autoCommit: true, statementCount: 0, supported: false }),
      rollbackTransaction: async () => ({ active: false, autoCommit: true, statementCount: 0, supported: false }),
      setAutoCommit: async () => ({ active: false, autoCommit: true, statementCount: 0, supported: false }),
    })

    // Oracle explain executes EXPLAIN PLAN FOR + DBMS_XPLAN.DISPLAY(), plus undefined executionTimeMs / rowCount + { message: null } throw + initial empty history + Redis GET explain
    expect((await host.invoke<{ entries: unknown[] }>('query.history.list', {})).entries).toEqual([])
    const oraExplain = await host.invoke<{ rows: unknown[][] }>('query.explain', {
      connectionId: 'ora_1',
      sql: 'SELECT 1 FROM DUAL;',
    })
    expect(oraExplain.rows[0][0]).toContain('Plan hash')
    expect(oraQueries.some((q) => q.includes('DBMS_XPLAN.DISPLAY'))).toBe(true)

    await sm.saveStoredConnections([
      { id: 'ora_1', name: 'Ora', driver: 'oracle', host: 'h', port: 1521, database: 'ORCL' },
      { id: 'ora_undef', name: 'OraU', driver: 'oracle', host: 'h', port: 1521, database: 'ORCL' },
      { id: 'red_1', name: 'Red', driver: 'redis', host: '127.0.0.1', port: 6379 },
      { id: 'mgo_1', name: 'Mgo', driver: 'mongodb', host: 'h', port: 27017, database: 'app' },
      { id: 'pg_tx', name: 'PG', driver: 'postgres', host: 'h', port: 5432, database: 'app' },
    ])
    sm.getActiveSessions().set('ora_undef', {
      ...sm.getActiveSessions().get('ora_1')!,
      profile: { id: 'ora_undef', name: 'OraU', driver: 'oracle' },
      runQuery: async (_qid, sql) => {
        if (sql.includes('FAIL_NULL_MSG')) throw { message: null }
        return {
          columns: [{ name: 'PLAN_TABLE_OUTPUT', type: 'TEXT' }],
          rows: [['Plan']],
          truncated: false,
          isSelect: true,
        } as never
      },
    })
    await host.invoke('query.explain', { connectionId: 'ora_undef', sql: 'SELECT 1 FROM DUAL;' })
    await host.invoke('query.run', { connectionId: 'ora_undef', sql: 'SELECT 1 FROM DUAL;' })
    await expect(host.invoke('query.run', { connectionId: 'ora_undef', sql: 'SELECT FAIL_NULL_MSG FROM DUAL;' })).rejects.toMatchObject({ message: '' })
    const redRo = await host.invoke<{ rows: unknown[][] }>('query.explain', { connectionId: 'red_1', sql: 'GET mykey' })
    expect(redRo.rows[0]?.[1]).toBe('read-only')

    // MongoDB multi-stmt explain with string escapes & comments + mid-loop cancellation
    sm.getActiveSessions().set('mgo_1', {
      ...sm.getActiveSessions().get('ora_1')!,
      driverType: 'mongodb',
      profile: { id: 'mgo_1', name: 'Mgo', driver: 'mongodb' },
      runQuery: async () => ({
        columns: [{ name: 'plan', type: 'JSON' }],
        rows: [['{}']],
        rowCount: 1,
        executionTimeMs: 2,
        truncated: false,
        isSelect: true,
      }),
    })
    const mgoMulti = await host.invoke<{ resultSets: unknown[] }>('query.explain', {
      connectionId: 'mgo_1',
      sql: '// c\ndb.items.find({ k: "a\\";b" }); /* b */ db.items.find({ k: \'c\\\'d\' })',
    })
    expect(mgoMulti.resultSets.length).toBe(2)

    // Pre-cancelled query.explain & mid-multi-stmt cancel
    await host.invoke('query.cancel', { queryId: 'exp_pre_1' })
    await expect(
      host.invoke('query.explain', { connectionId: 'mgo_1', sql: 'db.items.find({})', queryId: 'exp_pre_1' })
    ).rejects.toMatchObject({ code: 'cancelled' })

    const expAbort = new AbortController()
    await expect(
      host.invoke('query.explain', { connectionId: 'mgo_1', sql: 'db.items.find({})' }, { signal: expAbort.signal })
    ).resolves.toBeDefined()
    expAbort.abort()
    await expect(
      host.invoke('query.explain', { connectionId: 'mgo_1', sql: 'db.items.find({})' }, { signal: expAbort.signal })
    ).rejects.toMatchObject({ code: 'cancelled' })

    const midExpCtrl = new AbortController()
    let expCalls = 0
    sm.getActiveSessions().get('mgo_1')!.runQuery = async () => {
      expCalls++
      if (expCalls === 1) midExpCtrl.abort()
      return { columns: [], rows: [], rowCount: 0, executionTimeMs: 1, truncated: false, isSelect: true }
    }
    await expect(
      host.invoke(
        'query.explain',
        { connectionId: 'mgo_1', sql: 'db.items.find({}); db.items.find({});' },
        { signal: midExpCtrl.signal }
      )
    ).rejects.toMatchObject({ code: 'cancelled' })

    // 3. query.run validations, scrubThrownError (object + string), active query.cancel, DDL schemaCache invalidation, history error & credential skip
    for (const [m, arg] of [
      ['query.run', { connectionId: 'pg_tx' }],
      ['query.run', { sql: 'SELECT 1' }],
      ['query.run', { connectionId: 'missing_conn', sql: 'SELECT 1' }],
      ['query.explain', { sql: 'SELECT 1' }],
      ['query.explain', { connectionId: 'pg_tx' }],
      ['query.explain', { connectionId: 'pg_tx', sql: '   ' }],
      ['query.explain', { connectionId: 'missing_conn', sql: 'SELECT 1' }],
      ['query.explain', { connectionId: 'pg_tx', sql: '/* comment only */' }],
      ['tx.begin', {}],
      ['tx.setAutoCommit', {}],
    ] as const) {
      await expect(host.invoke(m, arg)).rejects.toThrow()
    }

    const preAborted = new AbortController()
    preAborted.abort()
    await expect(
      host.invoke('query.run', { connectionId: 'pg_tx', sql: 'SELECT 1' }, { signal: preAborted.signal })
    ).rejects.toMatchObject({ code: 'cancelled' })

    await host.invoke('query.cancel', { queryId: 'q_pre_run' })
    await expect(
      host.invoke('query.run', { connectionId: 'pg_tx', sql: 'SELECT 1', queryId: 'q_pre_run' })
    ).rejects.toMatchObject({ code: 'cancelled' })

    // State machine mock session for pg_tx
    let txActive = false
    let txAutoCommit = true
    let throwMode: 'none' | 'obj' | 'str' | 'hang' = 'none'
    let cancelThrows = false
    const pgMock = {
      driverType: 'postgres' as const,
      profile: { id: 'pg_tx', name: 'PG', driver: 'postgres' as const },
      isAlive: () => true,
      close: async () => {},
      test: async () => ({ ok: true }),
      listObjects: async () => [],
      getTableDetails: async () => ({ name: 't', kind: 'table' as const, columns: [], primaryKey: [] }),
      fetchPage: async () => ({ columns: [], rows: [], page: 1, pageSize: 10, totalRows: 0, totalPages: 0 }),
      updateCell: async () => ({ ok: true, affectedRows: 0 }),
      previewChanges: async () => ({ statements: [] }),
      applyChanges: async () => ({ ok: true, inserted: 0, updated: 0, deleted: 0, statements: [] }),
      getDdl: async () => '',
      runQuery: async (_qid: string, sql: string) => {
        if (throwMode === 'obj') throw { message: 'postgres://u:secret_obj_pw@h/db', code: 'E_OBJ' }
        if (throwMode === 'str') throw 'postgres://u:secret_str_pw@h/db'
        if (throwMode === 'hang') {
          return await new Promise<never>(() => {})
        }
        if (/^BEGIN/i.test(sql)) txActive = true
        else if (/^(?:COMMIT|ROLLBACK)/i.test(sql)) txActive = false
        return { columns: [], rows: [], rowCount: 0, executionTimeMs: 3, truncated: false, isSelect: false }
      },
      cancelQuery: async () => {
        if (cancelThrows) throw new Error('cancel fail')
        return { ok: true }
      },
      getTransactionState: () => ({ active: txActive, autoCommit: txAutoCommit, statementCount: 0, supported: true }),
      beginTransaction: async () => {
        txActive = true
        return { active: txActive, autoCommit: txAutoCommit, statementCount: 0, supported: true }
      },
      commitTransaction: async () => {
        txActive = false
        return { active: txActive, autoCommit: txAutoCommit, statementCount: 0, supported: true }
      },
      rollbackTransaction: async () => {
        txActive = false
        return { active: txActive, autoCommit: txAutoCommit, statementCount: 0, supported: true }
      },
      setAutoCommit: async (enabled: boolean) => {
        txAutoCommit = enabled
        return { active: txActive, autoCommit: txAutoCommit, statementCount: 0, supported: true }
      },
    }
    sm.getActiveSessions().set('pg_tx', pgMock)

    // scrubThrownError non-Error object & string
    throwMode = 'obj'
    await expect(host.invoke('query.run', { connectionId: 'pg_tx', sql: 'SELECT 1' })).rejects.toMatchObject({
      code: 'E_OBJ',
    })
    throwMode = 'str'
    await expect(host.invoke('query.run', { connectionId: 'pg_tx', sql: 'SELECT 1' })).rejects.not.toContain('secret_str_pw')
    throwMode = 'none'

    // Active query.cancel while query is tracked in tracker.activeQuerySessions
    throwMode = 'hang'
    const hungCtrl = new AbortController()
    const hungRun = host.invoke('query.run', { connectionId: 'pg_tx', sql: 'SELECT 1', queryId: 'q_active_1' }, { signal: hungCtrl.signal })
    await new Promise((r) => setTimeout(r, 15))
    await host.invoke('query.cancel', { queryId: 'q_active_1' })
    hungCtrl.abort()
    await expect(hungRun).rejects.toMatchObject({ code: 'cancelled' })
    throwMode = 'none'

    // Pre-cancel query.cancel when session.cancelQuery throws
    cancelThrows = true
    await host.invoke('query.cancel', { queryId: 'q_ignore_cancel_err' })
    cancelThrows = false

    // DDL statement invalidates schemaCache + credential SQL skips history + invalid maxRows default + explicit maxRows + normal autoCommit BEGIN/COMMIT + getSession mid-abort
    host.settings.set('maxRows', 'not-a-number')
    schemaCache.setObjects('pg_tx', [{ name: 't', kind: 'table' }])
    await host.invoke('query.run', { connectionId: 'pg_tx', sql: 'CREATE TABLE t2 (id INT);' })
    await host.invoke('query.run', { connectionId: 'pg_tx', sql: 'SELECT 1;', maxRows: 25 })
    expect(schemaCache.getSnapshot('pg_tx')).toBeNull()
    await host.invoke('query.run', { connectionId: 'pg_tx', sql: "SELECT 'postgres://u:pw123456@h/db';" })

    // Normal autoCommit=true BEGIN -> COMMIT clearing txOwnerByConn (L705-706) + normal tx.rollback
    const panelA = { panel: { id: 'panel-A' } } as unknown as Partial<PanelRequestContext>
    const panelB = { panel: { id: 'panel-B' } } as unknown as Partial<PanelRequestContext>
    await host.invoke('query.run', { connectionId: 'pg_tx', sql: 'BEGIN;' }, panelA)
    await host.invoke('query.run', { connectionId: 'pg_tx', sql: 'COMMIT;' }, panelA)
    await host.invoke('tx.begin', { connectionId: 'pg_tx' }, panelA)
    await host.invoke('tx.rollback', { connectionId: 'pg_tx' }, panelA)

    // Abort mid-getSession in query.run & query.explain (L644-645, L841-842)
    const midGetCtrl = new AbortController()
    const origGetSess = sm.getSession.bind(sm)
    vi.spyOn(sm, 'getSession').mockImplementation(async (id: string) => {
      midGetCtrl.abort()
      return origGetSess(id)
    })
    await expect(
      host.invoke('query.run', { connectionId: 'pg_tx', sql: 'SELECT 1' }, { signal: midGetCtrl.signal })
    ).rejects.toMatchObject({ code: 'cancelled' })
    const midGetCtrl2 = new AbortController()
    vi.spyOn(sm, 'getSession').mockImplementationOnce(async (id: string) => {
      midGetCtrl2.abort()
      return origGetSess(id)
    })
    await expect(
      host.invoke('query.explain', { connectionId: 'pg_tx', sql: 'SELECT 1' }, { signal: midGetCtrl2.signal })
    ).rejects.toMatchObject({ code: 'cancelled' })
    vi.restoreAllMocks()

    // Cross-panel TX ownership in query.run & tx.* + !autoCommit mode
    await host.invoke('tx.setAutoCommit', { connectionId: 'pg_tx', enabled: false }, panelA)
    await host.invoke('query.run', { connectionId: 'pg_tx', sql: 'BEGIN;' }, panelA)
    await expect(host.invoke('query.run', { connectionId: 'pg_tx', sql: 'COMMIT;' }, panelB)).rejects.toThrow(/another editor panel/i)
    await expect(host.invoke('query.run', { connectionId: 'pg_tx', sql: 'BEGIN;' }, panelB)).rejects.toThrow(/another editor panel/i)
    await expect(host.invoke('tx.begin', { connectionId: 'pg_tx' }, panelB)).rejects.toThrow(/another editor panel/i)
    await expect(host.invoke('tx.setAutoCommit', { connectionId: 'pg_tx', enabled: true }, panelB)).rejects.toThrow(/another editor panel/i)
    await host.invoke('query.run', { connectionId: 'pg_tx', sql: 'COMMIT;' }, panelA)
    // tx.commit in !autoCommit mode retains ownership token
    const postCommitManual = await host.invoke<{ txToken?: number }>('tx.commit', { connectionId: 'pg_tx' }, panelA)
    expect(postCommitManual.txToken).toBeDefined()
    // onlyIfOwner mismatches vs active + !autoCommit match
    const rbMismatch = await host.invoke<{ active: boolean }>('tx.rollback', { connectionId: 'pg_tx', onlyIfOwner: true, txToken: 999999 }, panelA)
    expect(rbMismatch.active).toBe(false)
    await host.invoke('tx.begin', { connectionId: 'pg_tx' }, panelA)
    const stNow = await host.invoke<{ txToken?: number }>('tx.status', { connectionId: 'pg_tx' }, panelA)
    const rbOwnerMatch = await host.invoke<{ active: boolean; autoCommit: boolean }>(
      'tx.rollback',
      { connectionId: 'pg_tx', onlyIfOwner: true, txToken: stNow.txToken },
      panelA
    )
    expect(rbOwnerMatch.autoCommit).toBe(true)

    // tx.begin when driver unsupported (active=false, autoCommit=true)
    await host.invoke('tx.begin', { connectionId: 'ora_1' }, panelA)

    // query.history.list default limit + queries.saved.list empty backup & restore + queries.saved.save update existing ID
    expect((await host.invoke<{ entries: unknown[] }>('query.history.list', {})).entries.length).toBeGreaterThanOrEqual(1)

    await writeHostConfigBackupPatch({ savedQueries: [] })
    await flushHostConfigBackupWrites()
    expect((await host.invoke<{ entries: Array<{ id: string }> }>('queries.saved.list')).entries).toEqual([])

    await writeHostConfigBackupPatch({
      savedQueries: [{ id: 'sq_bk', name: 'Restored Q', sql: 'SELECT 1;', createdAt: 1, updatedAt: 2 }],
    })
    await flushHostConfigBackupWrites()
    const [savedRestored, savedConcurrent] = await Promise.all([
      host.invoke<{ entries: Array<{ id: string }> }>('queries.saved.list'),
      host.invoke<{ entries: Array<{ id: string }> }>('queries.saved.list'),
    ])
    expect(savedRestored.entries.some((e) => e.id === 'sq_bk')).toBe(true)
    expect(savedConcurrent.entries.some((e) => e.id === 'sq_bk')).toBe(true)

    const updatedSq = await host.invoke<{ ok: boolean; entry: { id: string; name: string } }>('queries.saved.save', {
      id: 'sq_bk',
      name: 'Updated Q',
      sql: 'SELECT 2;',
    })
    expect(updatedSq.entry.name).toBe('Updated Q')

    // Non-autoCommit without active tx still rejects BEGIN from another panel (L676)
    await host.invoke('tx.setAutoCommit', { connectionId: 'pg_tx', enabled: false }, panelA)
    await expect(host.invoke('query.run', { connectionId: 'pg_tx', sql: 'BEGIN;' }, panelB)).rejects.toThrow(/another editor panel/i)
    await host.invoke('tx.setAutoCommit', { connectionId: 'pg_tx', enabled: true }, panelA)

    // recordQueryHistory non-Error rejection catch (L592:70)
    const origSet = host.api.storage.set.bind(host.api.storage)
    const setSpy = vi.spyOn(host.api.storage, 'set').mockImplementation(async (k: string, v: JsonValue) => {
      if (k === 'datanoa.queryHistory') throw 'disk full non-error'
      return origSet(k, v)
    })
    await host.invoke('query.run', { connectionId: 'pg_tx', sql: 'SELECT 77;' }, panelA)
    await host.invoke('query.history.list', {})
    setSpy.mockRestore()

    await sm.closeAll()
  }, 20_000)

  it('Slice 5: closes remaining AI (ai-client, ai-sql-context, rpc-ai) & SQLite (driver.ts, thread.ts) worker tails', async () => {
    // 1. ai-client.ts: extractStreamDelta non-record JSON chunk (data: [1, 2, 3])
    const enc = new TextEncoder()
    const streamRes = await completeSql(
      {
        format: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
        apiKey: 'sk-12345678901234567890',
        maxTokens: 32,
      },
      { dialect: 'sqlite', system: 'sys', user: 'SELECT ', prefix: 'SELECT ', suffix: '' },
      new AbortController().signal,
      (async () => ({
        ok: true,
        status: 200,
        headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
        body: {
          getReader: () => {
            let n = 0
            return {
              read: async () => {
                n++
                if (n === 1) return { done: false, value: enc.encode('data: [1,2,3]\ndata: {"choices":[{"delta":{"content":"1"}}]}\n') }
                return { done: true, value: undefined }
              },
              cancel: async () => {},
              releaseLock: () => {},
            }
          },
        },
        json: async () => ({}),
      })) as never
    )
    expect(streamRes).toBe('1')

    // 2. ai-sql-context.ts: db.runCommand(ident), MAX_HISTORY_CHARS overflow, remainingBudget <= 0 across tier1Items, fitColumnListToBudget < title(...)
    expect(extractReferencedMongoCollections('db.runCommand(cmdObj)')).toEqual([])
    const cache = new WorkerSchemaMetadataCache()
    const longTableA = `t_budget_a_${'a'.repeat(130)}`
    const longTableB = `t_budget_b_${'b'.repeat(130)}`
    const longTableC = `t_budget_c_${'c'.repeat(130)}`
    for (const tbl of [longTableA, longTableB, longTableC]) {
      cache.setTableDetails('c_ai', {
        name: tbl,
        kind: 'table',
        columns: Array.from({ length: 12 }, (_, idx) => ({
          name: `very_long_column_${idx}_${'z'.repeat(40)}`,
          type: 'TEXT',
          nullable: true,
          isPrimaryKey: idx === 0,
        })),
        primaryKey: ['very_long_column_0_' + 'z'.repeat(40)],
        indexes: [{ name: `idx_${tbl}`, columns: ['very_long_column_1_' + 'z'.repeat(40)], isUnique: true, isPrimary: false }],
        foreignKeys: [],
      })
    }
    const aiCtx = buildSqlCompletionContext({
      connectionId: 'c_ai',
      dialect: 'sqlite',
      prefix: `SELECT * FROM ${longTableA}, ${longTableB}, ${longTableC} WHERE `,
      suffix: '',
      snapshot: cache.getSnapshot('c_ai'),
      historyEntries: [
        {
          id: 'h1',
          connectionId: 'c_ai',
          connectionName: 'AI',
          driver: 'sqlite',
          sql: `SELECT ${'col_a, '.repeat(26)}id FROM ${longTableA}`,
          durationMs: 1,
          rowCount: 1,
          timestamp: 2,
        },
        {
          id: 'h2',
          connectionId: 'c_ai',
          connectionName: 'AI',
          driver: 'sqlite',
          sql: `SELECT ${'col_b, '.repeat(26)}id FROM ${longTableB}`,
          durationMs: 1,
          rowCount: 1,
          timestamp: 1,
        },
      ],
    })
    expect(aiCtx.system.length).toBeGreaterThan(0)

    // 3. rpc-ai.ts: backspace non-ident tail continue, shorter vs longer deletedTail, joinFlight pre-aborted synchronously in fetchPost, aiBaseUrl undefined, concurrent ai.explainAnalyze
    const aiHost = createMockHost()
    aiHost.settings.set('aiEnabled', true)
    aiHost.settings.set('aiFormat', 'openai')
    aiHost.settings.set('aiBaseUrl', 'https://api.openai.com/v1')
    aiHost.settings.set('aiModel', 'gpt-4o-mini')

    let abortOnFetch: AbortController | null = null
    let releaseExplain: (() => void) | null = null
    let explainSeq = 0
    const aiCtrl = registerAiHandlers({
      registerHandler: aiHost.api.panels.handle,
      orca: { ...aiHost.api, events: { emit: () => {} } } as never,
      schemaCache: cache,
      sessionManager: new SessionManager(aiHost.api),
      fetchPost: (async (_url: string, init: { body?: string }) => {
        if (abortOnFetch) {
          abortOnFetch.abort()
          abortOnFetch = null
        }
        const body = String(init?.body || '')
        if (body.includes('performance engineer')) {
          const mySeq = ++explainSeq
          if (mySeq === 1) {
            await new Promise<void>((resolve) => {
              releaseExplain = resolve
            })
          }
          return {
            ok: true,
            status: 200,
            headers: { get: () => 'application/json' },
            json: async () => ({
              choices: [{ message: { content: JSON.stringify({ summary: `ok ${mySeq}`, bottlenecks: [], optimizedSql: null, indexSuggestions: [], caveats: [] }) } }],
            }),
          }
        }
        return {
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          json: async () => ({ choices: [{ message: { content: 'bl1' } }] }),
        }
      }) as never,
      fetchGet: (async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: 'gpt-4o-mini' }] }) })) as never,
    })

    await aiHost.invoke('ai.key.set', { key: 'sk-12345678901234567890', baseUrl: 'https://api.openai.com/v1' })

    // Backspace invalid character (';') + longer vs shorter deletedTail ordering
    await aiHost.invoke('ai.complete', { prefix: 'SELECT a;', suffix: '', connectionId: 'c_ai', dialect: 'sqlite' })
    expect((await aiHost.invoke<{ suggestion: string }>('ai.complete', { prefix: 'SELECT a', suffix: '', connectionId: 'c_ai', dialect: 'sqlite' })).suggestion).toBe('bl1')
    await aiHost.invoke('ai.complete', { prefix: 'SELECT b FROM x', suffix: '', connectionId: 'c_ai', dialect: 'sqlite' })
    await aiHost.invoke('ai.complete', { prefix: 'SELECT b FROM xlong', suffix: '', connectionId: 'c_ai', dialect: 'sqlite' })
    const backSorted = await aiHost.invoke<{ suggestion: string }>('ai.complete', {
      prefix: 'SELECT b FROM ',
      suffix: '',
      connectionId: 'c_ai',
      dialect: 'sqlite',
    })
    expect(backSorted.suggestion).toBe('xbl1')

    // joinFlight when signal aborts inside fetchPost synchronously before joinFlight runs
    const syncAbort = new AbortController()
    abortOnFetch = syncAbort
    const abortedJoin = await aiHost.invoke<{ suggestion: string }>(
      'ai.complete',
      { prefix: 'SELECT z FROM tbl', suffix: '', connectionId: 'c_ai', dialect: 'sqlite' },
      { signal: syncAbort.signal }
    )
    expect(abortedJoin.suggestion).toBe('')

    // keyForListing with undefined settings.aiBaseUrl & ai.models.bench without key
    aiHost.settings.delete('aiBaseUrl')
    await aiHost.invoke('ai.models.list', { format: 'openai', baseUrl: 'https://api.openai.com/v1' })
    await aiHost.invoke('ai.models.bench', { format: 'openai', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o-mini'] })
    aiHost.settings.set('aiBaseUrl', 'https://api.openai.com/v1')

    // prefixMatch shorter vs longer prefix ordering (rpc-ai.ts L217:11)
    await aiHost.invoke('ai.complete', { prefix: 'SELECT p2 ', suffix: '', connectionId: 'c_ai', dialect: 'sqlite' })
    await aiHost.invoke('ai.complete', { prefix: 'SELECT p2 id ', suffix: '', connectionId: 'c_ai', dialect: 'sqlite' })
    expect((await aiHost.invoke<{ suggestion: string }>('ai.complete', { prefix: 'SELECT p2 id bl', suffix: '', connectionId: 'c_ai', dialect: 'sqlite' })).suggestion).toBe('1')
    await aiHost.invoke('ai.complete', { prefix: 'SELECT p3 id ', suffix: '', connectionId: 'c_ai', dialect: 'sqlite' })
    await aiHost.invoke('ai.complete', { prefix: 'SELECT p3 ', suffix: '', connectionId: 'c_ai', dialect: 'sqlite' })
    await aiHost.invoke('ai.complete', { prefix: 'SELECT p3 id b', suffix: '', connectionId: 'c_ai', dialect: 'sqlite' })

    // Concurrent ai.explainAnalyze on same panel so first controller !== inflightExplainByPanel.get(panelId) in finally
    const exp1 = aiHost.invoke('ai.explainAnalyze', { sql: 'SELECT * FROM rb_tbl', dialect: 'sqlite' }).catch((e) => e)
    await new Promise((r) => setTimeout(r, 10))
    const exp2 = aiHost.invoke('ai.explainAnalyze', { sql: 'SELECT * FROM rb_tbl', dialect: 'sqlite' })
    releaseExplain?.()
    await exp2
    await exp1
    aiCtrl.dispose()

    // 4. src/drivers/sqlite/driver.ts & thread.ts real Worker & trigger/ON CONFLICT ROLLBACK tails
    const prevUdf = process.env.DATANOA_ENABLE_TEST_UDF
    process.env.DATANOA_ENABLE_TEST_UDF = '1'
    const sqDir = path.join(tmpBase, 'sqlite-tails')
    fs.mkdirSync(sqDir, { recursive: true })
    const sqDriver = new SqliteDriver()
    let s: SqliteSession | undefined
    let s2: SqliteSession | undefined
    try {
      s = (await sqDriver.createSession({
        id: 'sq_tail_1',
        name: 'SQ',
        driver: 'sqlite',
        filePath: path.join(sqDir, 'tails.db'),
      })) as SqliteSession

      // updateCell where AFTER UPDATE trigger deletes the row so reloadQuery returns undefined (L424)
      await s.runQuery(
        'init-trig',
        `
        CREATE TABLE del_after (id INTEGER PRIMARY KEY, v TEXT);
        INSERT INTO del_after VALUES (1, 'old');
        CREATE TRIGGER trg_del AFTER UPDATE ON del_after BEGIN
          DELETE FROM del_after WHERE id = NEW.id;
        END;
        CREATE TABLE rb_tbl (id INTEGER PRIMARY KEY, u INTEGER UNIQUE ON CONFLICT ROLLBACK);
        INSERT INTO rb_tbl VALUES (1, 100);
        CREATE TABLE auto_uniq (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE);
        `
      )
      expect((await s.exportSchemaDdl()).ddl).toContain('auto_uniq')
      const updDeleted = await s.updateCell({
        table: 'del_after',
        column: 'v',
        newValue: 'new',
        primaryKeys: { id: 1 },
        originalValue: 'old',
      })
      expect(updDeleted.updatedRecord).toBeUndefined()

      // applyBatch ON CONFLICT ROLLBACK triggers thread.ts L375 catch (SQLite already rolled back)
      await expect(
        s.applyChanges({
          table: 'rb_tbl',
          inserts: [{ id: 2, u: 100 }],
        })
      ).rejects.toThrow(/UNIQUE/i)

      // fetchPage with undefined countRow & fetchTableOrViewDdl with ';' terminated SQL
      const origSendToWorker = (s as unknown as { sendToWorker: (...a: unknown[]) => Promise<unknown> }).sendToWorker
      const sendSpy = vi
        .spyOn(s as unknown as { sendToWorker: (...a: unknown[]) => Promise<unknown> }, 'sendToWorker')
        .mockImplementation(async (type: string, payload?: Record<string, unknown>) => {
          if (type === 'get' && String(payload?.sql || '').includes('COUNT(*)')) return undefined
          if (type === 'all' && String(payload?.sql || '').includes('sqlite_master')) {
            return [{ type: 'table', sql: 'CREATE TABLE x (id INT);' }, { type: 'index', sql: null }]
          }
          return origSendToWorker.call(s, type, payload)
        })
      expect((await s.fetchPage({ table: 'rb_tbl', page: 1, pageSize: 10 })).totalRows).toBe(0)
      expect(await s.getDdl('rb_tbl')).toBe('CREATE TABLE x (id INT);')
      sendSpy.mockRestore()

      // Stale worker error event while cancelQuery cleared this.worker before terminating (L143)
      const firstWorker = (s as unknown as { worker: EventEmitter | null }).worker
      const slowA = s.runQuery('sq_slow_a', 'SELECT sleep_ms(600);').catch((e) => e)
      await new Promise((r) => setTimeout(r, 20))
      const cancelAP = s.cancelQuery('sq_slow_a')
      firstWorker?.emit('error', new Error('stale worker err'))
      await cancelAP
      await slowA

      // cancelQuery + close race (L624-626) + oldWorker.terminate throw inside cancel (driver.ts L650) + sendToWorker while closingPromise set (L180)
      const slowB = s.runQuery('sq_slow_b', 'SELECT sleep_ms(800);').catch((e) => e)
      await new Promise((r) => setTimeout(r, 20))
      const wBeforeCancel = (s as unknown as { worker: { terminate: () => Promise<number> } | null }).worker
      if (wBeforeCancel) {
        const origBeforeTerm = wBeforeCancel.terminate.bind(wBeforeCancel)
        wBeforeCancel.terminate = async () => {
          await origBeforeTerm().catch(() => {})
          throw new Error('terminate fail inside cancel mock')
        }
      }
      const cancelB1 = s.cancelQuery('sq_slow_b')
      const cancelB2 = s.cancelQuery('sq_slow_b').catch((e) => e)
      const closeP = s.close()
      await Promise.allSettled([slowB, cancelB1, cancelB2, closeP])

      // Direct close() where sendToWorker sees closingPromise before isClosed (L180:31) & workerToTerminate.terminate() throws (L264)
      const sTerm = (await sqDriver.createSession({
        id: 'sq_term_err',
        name: 'SQTerm',
        driver: 'sqlite',
        filePath: ':memory:',
      })) as SqliteSession
      const wTerm = (sTerm as unknown as { worker: { terminate: () => Promise<number> } | null }).worker!
      wTerm.terminate = async () => {
        throw new Error('terminate throws directly')
      }
      const sTermCloseP = sTerm.close()
      await expect(sTerm.listObjects()).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
      await sTermCloseP

      // extractSqliteErrMessage string & non-Error fallbacks via postMessage throw in test() + close() after ON CONFLICT ROLLBACK in manual TX (thread.ts L594)
      s2 = (await sqDriver.createSession({
        id: 'sq_tail_2',
        name: 'SQ2',
        driver: 'sqlite',
        filePath: path.join(sqDir, 'tails.db'),
      })) as SqliteSession
      await s2.beginTransaction()
      await expect(s2.runQuery('rb_in_tx', 'INSERT INTO rb_tbl VALUES (2, 100);')).rejects.toThrow(/UNIQUE/i)
      const w2 = (s2 as unknown as { worker: { postMessage: (msg: unknown) => void } | null }).worker!
      const origPost = w2.postMessage.bind(w2)
      w2.postMessage = () => {
        throw 'string_post_err'
      }
      expect(await s2.test()).toEqual({ ok: false, message: 'string_post_err' })
      w2.postMessage = () => {
        throw { unexpected: true }
      }
      expect(await s2.test()).toEqual({ ok: false, message: 'SQLite test failed' })
      w2.postMessage = origPost
      await s2.close()
    } finally {
      await s?.close().catch(() => {})
      await s2?.close().catch(() => {})
      if (prevUdf === undefined) delete process.env.DATANOA_ENABLE_TEST_UDF
      else process.env.DATANOA_ENABLE_TEST_UDF = prevUdf
    }

    // 5. thread.ts MessageChannel isolated non-object error & pragma catch branches (L92-97, L195, L498, L533, L551)
    vi.resetModules()
    const realWt = await import('node:worker_threads')
    const { port1, port2 } = new realWt.MessageChannel()
    try {
      class PortBridge extends EventEmitter {
        constructor(private p: import('node:worker_threads').MessagePort) {
          super()
          p.on('message', (m) => this.emit('message', m))
        }
        postMessage(m: unknown) {
          this.p.postMessage(m)
        }
      }
      const fakePort = new PortBridge(port2)
      vi.doMock('node:worker_threads', async () => {
        const actual = await vi.importActual<typeof import('node:worker_threads')>('node:worker_threads')
        return { ...actual, parentPort: fakePort }
      })
      vi.doMock('node:sqlite', async () => {
        const actual = await vi.importActual<typeof import('node:sqlite')>('node:sqlite')
        let failRollback = false
        let failFkRestore = false
        let returnUndefinedChanges = false
        let returnNullRow = false
        let throwWeirdErrObj = false
        class WrappedDb extends actual.DatabaseSync {
          exec(sql: string) {
            if (sql.includes('busy_timeout')) throw new Error('busy_timeout blocked')
            if (sql === 'ROLLBACK;' && failRollback) throw new Error('already rolled back')
            if (failFkRestore && /^PRAGMA\s+foreign_keys\s*=/i.test(sql)) {
              throw new Error('fk restore blocked')
            }
            return super.exec(sql)
          }
          prepare(sql: string) {
            const stmt = super.prepare(sql)
            if (sql === 'PRAGMA foreign_keys;') {
              return { ...stmt, get: () => { throw new Error('fk read fail') } } as never
            }
            return {
              all: (...args: unknown[]) => {
                if (throwWeirdErrObj) {
                  throwWeirdErrObj = false
                  throw { foo: 'weird_err_without_message_or_stack' }
                }
                if (returnNullRow) {
                  returnNullRow = false
                  return [null]
                }
                return stmt.all(...(args as never[]))
              },
              get: (...args: unknown[]) => stmt.get(...(args as never[])),
              run: (...args: unknown[]) => {
                const res = stmt.run(...(args as never[]))
                return returnUndefinedChanges ? {} : res
              },
              columns: () => stmt.columns(),
              setReturnArrays: (v: boolean) => stmt.setReturnArrays(v),
              iterate: (...args: unknown[]) => stmt.iterate(...(args as never[])),
            } as never
          }
        }
        return {
          ...actual,
          DatabaseSync: WrappedDb,
          __setFailFlags: (rb: boolean, fk: boolean) => {
            failRollback = rb
            failFkRestore = fk
          },
          __setEdgeFlags: (undefChg: boolean, nullRow: boolean, weirdErr: boolean) => {
            returnUndefinedChanges = undefChg
            returnNullRow = nullRow
            throwWeirdErrObj = weirdErr
          },
        }
      })
      const sqliteMockMod = (await import('node:sqlite')) as unknown as {
        __setFailFlags: (rb: boolean, fk: boolean) => void
        __setEdgeFlags: (undefChg: boolean, nullRow: boolean, weirdErr: boolean) => void
      }
      await import('../src/drivers/sqlite/thread')
      let seq = 0
      const callThread = (msg: Record<string, unknown>) =>
        new Promise<{ ok: boolean; error?: { message: string; code: string } }>((resolve) => {
          const id = `t_${++seq}`
          const onMsg = (m: { id: string; ok: boolean; error?: { message: string; code: string } }) => {
            if (m.id === id) {
              port1.off('message', onMsg)
              resolve(m)
            }
          }
          port1.on('message', onMsg)
          port1.postMessage({ id, ...msg })
        })

      await callThread({ type: 'init', filePath: ':memory:' })
      // Trigger non-object throws inside extractSqliteErrorInfo (L92-97)
      fakePort.emit('message', {
        id: 't_raw_fk',
        get type(): string {
          throw '__datanoa_fk_violation__'
        },
      })
      const rawStrPromise = new Promise<{ ok: boolean; error?: { message: string } }>((resolve) => {
        const onMsg = (m: { id: string; ok: boolean; error?: { message: string } }) => {
          if (m.id === 't_raw_str') {
            port1.off('message', onMsg)
            resolve(m)
          }
        }
        port1.on('message', onMsg)
      })
      fakePort.emit('message', {
        id: 't_raw_str',
        get type(): string {
          throw 'plain_string_throw'
        },
      })
      expect((await rawStrPromise).error?.message).toBe('plain_string_throw')

      // applyBatch rollback catch (L375)
      sqliteMockMod.__setFailFlags(true, false)
      await callThread({ type: 'exec', sql: 'CREATE TABLE mt_rb (id INT PRIMARY KEY);' })
      const rbBatch = await callThread({
        type: 'applyBatch',
        deletes: [{ sql: 'DELETE FROM mt_rb WHERE id = 999;', params: [] }],
        updates: [],
        inserts: [],
      })
      expect(rbBatch.ok).toBe(false)

      // query BEGIN + error rollback catch (L541)
      const qRbCatch = await callThread({
        type: 'query',
        sql: 'BEGIN; SELECT * FROM no_such_tbl;',
        statements: ['BEGIN;', 'SELECT * FROM no_such_tbl;'],
      })
      expect(qRbCatch.ok).toBe(false)
      sqliteMockMod.__setFailFlags(false, false)
      await callThread({ type: 'exec', sql: 'ROLLBACK;' }).catch(() => {})

      // Single-stmt PRAGMA foreign_keys = OFF (L498 catch) + multi-stmt restore catch on success & error (L533, L551)
      await callThread({ type: 'query', sql: 'PRAGMA foreign_keys = OFF;' })
      sqliteMockMod.__setFailFlags(false, true)
      await callThread({
        type: 'query',
        sql: 'PRAGMA foreign_keys = ON; SELECT 1;',
        statements: ['PRAGMA foreign_keys = ON;', 'SELECT 1;'],
      })
      await callThread({
        type: 'query',
        sql: 'PRAGMA foreign_keys = ON; SELECT * FROM missing_t;',
        statements: ['PRAGMA foreign_keys = ON;', 'SELECT * FROM missing_t;'],
      })
      sqliteMockMod.__setFailFlags(false, false)

      // Edge closures for sqlite/thread.ts: empty-message/no-stack err (L80,L89), null row normalize (L152), undefined changes (L233,L321,L336,L351,L500), empty sql (L403)
      await callThread({ type: 'exec', sql: 'CREATE TABLE IF NOT EXISTS mt_u (id INT PRIMARY KEY, v INT); INSERT INTO mt_u VALUES (1, 1);' })
      sqliteMockMod.__setEdgeFlags(false, false, true)
      expect((await callThread({ type: 'all', sql: 'SELECT 1;' })).ok).toBe(false)
      sqliteMockMod.__setEdgeFlags(false, true, false)
      expect((await callThread({ type: 'all', sql: 'SELECT 1;' })).ok).toBe(true)
      await callThread({ type: 'query', sql: '', statements: [''] })

      sqliteMockMod.__setEdgeFlags(true, false, false)
      await callThread({ type: 'run', sql: 'UPDATE mt_u SET v = 2 WHERE id = 1;' })
      expect(
        (
          await callThread({
            type: 'applyBatch',
            deletes: [{ sql: 'DELETE FROM mt_u WHERE id = 1;', params: [] }],
            updates: [],
            inserts: [],
          })
        ).ok
      ).toBe(false)
      expect(
        (
          await callThread({
            type: 'applyBatch',
            deletes: [],
            updates: [{ sql: 'UPDATE mt_u SET v = 3 WHERE id = 1;', params: [] }],
            inserts: [],
          })
        ).ok
      ).toBe(false)
      expect(
        (
          await callThread({
            type: 'applyBatch',
            deletes: [],
            updates: [],
            inserts: [{ sql: 'INSERT INTO mt_u VALUES (2, 2);', params: [] }],
          })
        ).ok
      ).toBe(true)
      await callThread({ type: 'query', sql: 'DELETE FROM mt_u WHERE id = 2;' })
      sqliteMockMod.__setEdgeFlags(false, false, false)

      // close() rollback catch while inManualTx (L594)
      sqliteMockMod.__setFailFlags(true, false)
      await callThread({ type: 'txBegin' })
      await callThread({ type: 'close' })
    } finally {
      port1.close()
      port2.close()
      vi.doUnmock('node:sqlite')
      vi.doUnmock('node:worker_threads')
      vi.resetModules()
    }
  }, 20_000)

  it('Slice 6: closes POSIX platform branches in discovery.ts & docker-compose-discovery.ts safely via isolated module load', async () => {
    const origDesc = Object.getOwnPropertyDescriptor(process, 'platform')
    const origPathEnv = process.env.PATH
    const origLocalAppData = process.env.LOCALAPPDATA
    try {
      vi.resetModules()
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
      process.env.PATH = ''
      delete process.env.LOCALAPPDATA
      vi.doMock('node:path', async () => {
        const actual = await vi.importActual<typeof import('node:path')>('node:path')
        return { ...actual.posix, default: actual.posix }
      })
      vi.doMock('node:fs', async () => {
        const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
        const existsSync = (p: fs.PathLike) => String(p).includes('bad-docker-dir')
        const statSync: typeof fs.statSync = ((p: fs.PathLike, opts?: fs.StatSyncOptions) => {
          if (String(p).includes('bad-docker-dir')) throw new Error('EACCES')
          return actual.statSync(p, opts as never)
        }) as typeof fs.statSync
        return { ...actual, existsSync, statSync, default: { ...actual, existsSync, statSync } }
      })
      const discPosix = await import('../src/worker/discovery')
      const composePosix = await import('../src/worker/docker-compose-discovery')
      const utilsPosix = await import('../src/worker/worker-utils')
      expect(discPosix.normalizePathForCompare('/Users/Dev/')).toBe('/Users/Dev')
      expect(discPosix.isBlockedScanRoot('/etc')).toBe(true)
      expect(discPosix.isBlockedScanRoot('/etc/passwd')).toBe(true)
      expect(discPosix.isBlockedScanRoot('/opt/my-app/db')).toBe(false)
      process.env.LOCALAPPDATA = '/'
      expect(discPosix.isBlockedScanRoot('/opt/my-app/db')).toBe(true)
      expect(composePosix.findDockerBinary()).toBeNull()
      process.env.PATH = '/bad-docker-dir'
      expect(composePosix.findDockerBinary()).toBeNull()
      await utilsPosix.listDirectoryForPicker({ dir: '/' }).catch(() => {})
    } finally {
      if (origDesc) Object.defineProperty(process, 'platform', origDesc)
      if (origPathEnv === undefined) delete process.env.PATH
      else process.env.PATH = origPathEnv
      if (origLocalAppData === undefined) delete process.env.LOCALAPPDATA
      else process.env.LOCALAPPDATA = origLocalAppData
      vi.doUnmock('node:fs')
      vi.doUnmock('node:path')
      vi.resetModules()
    }
  }, 20_000)

  it('Slice 7: closes isolated defensive fallback branches across rpc-data-schema, sqlite/driver, and rpc-connections', async () => {
    // 1. rpc-data-schema.ts L177:47 non-Error catch in data.fetchPage (reaches 100% B/S/F)
    try {
      vi.resetModules()
      vi.doMock('../src/drivers/common/sql-tools', async () => {
        const actual = await vi.importActual<typeof import('../src/drivers/common/sql-tools')>('../src/drivers/common/sql-tools')
        return {
          ...actual,
          sanitizeFilterClause: () => {
            throw 'raw_non_error_filter_msg'
          },
        }
      })
      const { registerDataAndSchemaHandlers: regMockSchema } = await import('../src/worker/rpc-data-schema')
      const { SessionManager: SmIsolated } = await import('../src/worker/session-manager')
      const h1 = createMockHost()
      const sm1 = new SmIsolated(h1.api)
      regMockSchema({ orca: h1.api, registerHandler: h1.api.panels.handle, sessionManager: sm1 })
      await expect(
        h1.invoke('data.fetchPage', { connectionId: 'missing', table: 't', whereClause: 'a = 1' })
      ).rejects.toThrow(/raw_non_error_filter_msg/)
      await sm1.closeAll()
    } finally {
      vi.doUnmock('../src/drivers/common/sql-tools')
      vi.resetModules()
    }

    // 2. sqlite/driver.ts L112:34 jsUrl fallback when thread.ts does not exist (reaches 100% B/S/F)
    try {
      vi.resetModules()
      vi.doMock('node:fs', async () => {
        const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
        const existsSync = (p: fs.PathLike) => (String(p).includes('thread.ts') ? false : actual.existsSync(p))
        return { ...actual, existsSync, default: { ...actual, existsSync } }
      })
      vi.doMock('node:worker_threads', async () => {
        const actual = await vi.importActual<typeof import('node:worker_threads')>('node:worker_threads')
        class FakeWorker extends EventEmitter {
          constructor(public readonly scriptURL: unknown) {
            super()
          }
          postMessage(msg: { id: string }) {
            queueMicrotask(() => this.emit('message', { id: msg.id, ok: true, data: {} }))
          }
          async terminate() {
            return 0
          }
        }
        return { ...actual, Worker: FakeWorker, default: { ...actual, Worker: FakeWorker } }
      })
      const { SqliteDriver: JsUrlSqliteDriver } = await import('../src/drivers/sqlite/driver')
      const jsSess = await new JsUrlSqliteDriver().createSession({
        id: 'jsurl_1',
        name: 'J',
        driver: 'sqlite',
        filePath: ':memory:',
      })
      await jsSess.close()
    } finally {
      vi.doUnmock('node:worker_threads')
      vi.doUnmock('node:fs')
      vi.resetModules()
    }

    // 3. rpc-connections.ts L498-499 & L541-542 missing sizeBytes/sizeLabel normalization fallbacks
    try {
      vi.resetModules()
      vi.doMock('../src/worker/discovery', async () => {
        const actual = await vi.importActual<typeof import('../src/worker/discovery')>('../src/worker/discovery')
        const stubItems = [{ name: 'leaf (Workspace)', filePath: '/tmp/leaf.db', isWorkspaceMatch: true }]
        return {
          ...actual,
          scanDirectoryForSqliteFiles: async () => stubItems,
          discoverWorkspaceSqliteFiles: async () => stubItems,
        }
      })
      const { registerConnectionHandlers: regMockConn } = await import('../src/worker/rpc-connections')
      const { SessionManager: SmConn } = await import('../src/worker/session-manager')
      const { DriverManager: DmConn } = await import('../src/drivers/driver-manager')
      const h2 = createMockHost()
      const sm2 = new SmConn(h2.api)
      const dm2 = new DmConn(h2.api.storage, (m) => h2.api.log(m))
      regMockConn({
        orca: h2.api,
        registerHandler: h2.api.panels.handle,
        sessionManager: sm2,
        driverManager: dm2,
      })
      const sf = await h2.invoke<{ files: Array<{ sizeBytes: number; sizeLabel: string }> }>('sqlite.scanFolder', {
        folderPath: tmpBase,
      })
      expect(sf.files[0]).toMatchObject({ sizeBytes: 0, sizeLabel: '0 B' })
      const wd = await h2.invoke<{ sqliteFiles: Array<{ sizeBytes: number; sizeLabel: string }> }>('workspace.detectConnections', {
        folderPath: tmpBase,
      })
      expect(wd.sqliteFiles[0]).toMatchObject({ sizeBytes: 0, sizeLabel: '0 B' })
      await sm2.closeAll()
    } finally {
      vi.doUnmock('../src/worker/discovery')
      vi.resetModules()
    }
  }, 20_000)
})


