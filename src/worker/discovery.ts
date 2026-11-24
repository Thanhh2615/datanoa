import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import type { ConnectionProfile, DatabaseDriverType } from '../protocol'
import { parseConnectionUri } from '../drivers/common/connection-uri'

export interface DiscoveredSqliteFile {
  filePath: string
  name: string
  profile: ConnectionProfile
  isRegistered: boolean
  sizeBytes?: number
  sizeLabel?: string
}

export interface DetectedEnvConnection {
  envKey: string
  sourceFile: string
  driver: DatabaseDriverType
  name: string
  uri: string
}

export interface ScanBudgetOptions {
  maxDurationMs?: number
  maxDepth?: number
  maxDirs?: number
  maxResults?: number
  deadlineMs?: number
}

export const DEFAULT_SCAN_BUDGET = {
  maxDurationMs: 800,
  maxDepth: 4,
  maxDirs: 350,
  maxResults: 60,
} as const

export const IGNORED_SCAN_DIRS = new Set([
  'node_modules',
  '.git',
  '.orca',
  '.gemini',
  '.agents',
  'AppData',
  'Application Data',
  'Local Settings',
  'Library',
  'OneDrive',
  'Downloads',
  'Documents',
  '.vscode',
  '.cursor',
  '.npm',
  '.pnpm-store',
  '.yarn',
  '.cache',
  'dist',
  'build',
  'out',
  'release',
  'target',
  'vendor',
  '.next',
  '.nuxt',
  '.venv',
  'venv',
  '__pycache__',
  'coverage',
  '$RECYCLE.BIN',
  'System Volume Information',
])

const IGNORED_SCAN_DIRS_LOWER = new Set(
  Array.from(IGNORED_SCAN_DIRS, (dir) => dir.toLowerCase())
)

export const SQLITE_FILE_EXTENSIONS = new Set(['.db', '.sqlite', '.sqlite3'])

export function normalizePathForCompare(rawPath: string): string {
  const cleaned = path.resolve(rawPath).replace(/[\\/]+$/, '')
  if (process.platform === 'win32') {
    return cleaned.toLowerCase()
  }
  return cleaned || '/'
}

function isSameOrChildPath(candidateNorm: string, rootNorm: string): boolean {
  if (candidateNorm === rootNorm) return true
  const sep = process.platform === 'win32' ? '\\' : '/'
  const prefix = rootNorm.endsWith(sep) ? rootNorm : `${rootNorm}${sep}`
  return candidateNorm.startsWith(prefix)
}

/**
 * Returns true if the directory is a filesystem root, user home directory,
 * AppData root, or OS/system directory that must never be swept automatically.
 */
export function isBlockedScanRoot(dirPath: string): boolean {
  if (!dirPath || typeof dirPath !== 'string') return true
  const trimmed = dirPath.trim()
  if (!trimmed) return true
  if (trimmed === '/' || trimmed === '\\' || /^[A-Za-z]:[\\/]?$/.test(trimmed)) {
    return true
  }

  const resolved = path.resolve(trimmed)
  const norm = normalizePathForCompare(resolved)
  const rootNorm = normalizePathForCompare(path.parse(resolved).root)
  if (norm === rootNorm) {
    return true
  }

  const homeResolved = path.resolve(os.homedir())
  const homeNorm = normalizePathForCompare(homeResolved)
  if (norm === homeNorm || isSameOrChildPath(homeNorm, norm)) {
    return true
  }

  const tmpNorm = normalizePathForCompare(os.tmpdir())
  const isInsideTmp = isSameOrChildPath(norm, tmpNorm)

  if (!isInsideTmp) {
    const appDataCandidates = [
      path.join(homeResolved, 'AppData'),
      path.join(homeResolved, 'AppData', 'Local'),
      path.join(homeResolved, 'AppData', 'Roaming'),
      path.join(homeResolved, 'AppData', 'LocalLow'),
      path.join(homeResolved, 'Library'),
      process.env.APPDATA,
      process.env.LOCALAPPDATA,
    ].filter((p): p is string => Boolean(p && p.trim()))

    for (const candidate of appDataCandidates) {
      if (isSameOrChildPath(norm, normalizePathForCompare(candidate))) {
        return true
      }
    }
  }

  if (process.platform === 'win32') {
    const winRoots = [
      process.env.SystemRoot,
      process.env.WINDIR,
      'C:\\Windows',
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
      process.env.ProgramData,
      'C:\\Program Files',
      'C:\\Program Files (x86)',
      'C:\\ProgramData',
      'C:\\$Recycle.Bin',
      'C:\\System Volume Information',
    ].filter((p): p is string => Boolean(p && p.trim()))

    for (const sysRoot of winRoots) {
      if (isSameOrChildPath(norm, normalizePathForCompare(sysRoot))) {
        return true
      }
    }
  }

  const posixExactBlocked = new Set([
    '/system',
    '/library',
    '/applications',
    '/usr',
    '/bin',
    '/sbin',
    '/etc',
    '/proc',
    '/sys',
    '/dev',
    '/boot',
    '/lib',
    '/lib64',
    '/opt',
    '/run',
    '/var',
    '/users',
    '/home',
  ])
  const lowerPosix = resolved.replace(/\/+$/, '').toLowerCase()
  if (posixExactBlocked.has(lowerPosix)) {
    return true
  }
  if (
    !isInsideTmp &&
    ['/system/', '/proc/', '/sys/', '/dev/', '/usr/', '/etc/', '/bin/', '/sbin/'].some((p) =>
      lowerPosix.startsWith(p)
    )
  ) {
    return true
  }

  return false
}

export function isLocalWorkspaceHost(hostId?: string | null): boolean {
  return hostId === 'local' || hostId === null || hostId === undefined
}

export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function matchSqliteExtension(fileName: string): string | null {
  const lower = fileName.toLowerCase()
  const ext = path.extname(lower)
  if (SQLITE_FILE_EXTENSIONS.has(ext)) {
    return ext
  }
  for (const candidate of SQLITE_FILE_EXTENSIONS) {
    if (lower === candidate || lower.endsWith(candidate)) {
      return candidate
    }
  }
  return null
}

/**
 * Resolves a user-provided SQLite path: if the user entered a directory path
 * (e.g. `D:\electron-project\mkt-care-2025\libs\data`), picks `.db` or the
 * first non-empty SQLite database inside that directory asynchronously.
 */
export async function resolveSqliteFilePath(rawPath: string): Promise<string> {
  const trimmed = (rawPath || '').trim()
  if (!trimmed || trimmed === ':memory:') return trimmed
  try {
    const stat = await fs.promises.stat(trimmed)
    if (stat.isDirectory()) {
      const dotDb = path.join(trimmed, '.db')
      try {
        const dotStat = await fs.promises.stat(dotDb)
        if (dotStat.isFile()) {
          return dotDb
        }
      } catch {
        // .db does not exist inside folder
      }
      const discovered = await scanDirectoryForSqliteFiles(trimmed, [], {
        maxDurationMs: 400,
        maxDepth: 2,
        maxDirs: 50,
        maxResults: 20,
      })
      const nonEmpty = discovered.find((d) => (d.sizeBytes ?? 0) > 0)
      if (nonEmpty) return nonEmpty.filePath
      if (discovered.length > 0) return discovered[0].filePath
    }
  } catch {
    // Ignore stat errors and fall back to raw path
  }
  return trimmed
}

/**
 * Asynchronously scans a directory using breadth-first traversal for SQLite database files
 * within strict duration, depth, directory count, and result budgets.
 */
export async function scanDirectoryForSqliteFiles(
  workspaceDir: string,
  existingProfiles: ConnectionProfile[] = [],
  options: ScanBudgetOptions = {}
): Promise<DiscoveredSqliteFile[]> {
  if (!workspaceDir || isBlockedScanRoot(workspaceDir)) {
    return []
  }

  const maxDurationMs = options.maxDurationMs ?? DEFAULT_SCAN_BUDGET.maxDurationMs
  const maxDepth = options.maxDepth ?? DEFAULT_SCAN_BUDGET.maxDepth
  const maxDirs = options.maxDirs ?? DEFAULT_SCAN_BUDGET.maxDirs
  const maxResults = options.maxResults ?? DEFAULT_SCAN_BUDGET.maxResults
  const deadline = options.deadlineMs ?? Date.now() + maxDurationMs

  const results: DiscoveredSqliteFile[] = []
  const resolvedRoot = path.resolve(workspaceDir)
  const queue: Array<{ dir: string; depth: number }> = [{ dir: resolvedRoot, depth: 0 }]
  const visitedDirs = new Set<string>()
  const existingPaths = new Set<string>()
  for (const p of existingProfiles) {
    if (p.filePath) {
      existingPaths.add(normalizePathForCompare(path.resolve(p.filePath)))
    }
  }

  let dirsVisited = 0

  while (queue.length > 0) {
    if (Date.now() >= deadline || dirsVisited >= maxDirs || results.length >= maxResults) {
      break
    }

    const current = queue.shift()
    if (!current) break
    const currentNorm = normalizePathForCompare(current.dir)
    if (visitedDirs.has(currentNorm)) {
      continue
    }
    visitedDirs.add(currentNorm)
    dirsVisited++

    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(current.dir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (Date.now() >= deadline || results.length >= maxResults) {
        break
      }
      if (entry.isSymbolicLink()) {
        continue
      }

      if (entry.isDirectory()) {
        if (
          current.depth < maxDepth &&
          !entry.name.startsWith('.') &&
          !IGNORED_SCAN_DIRS_LOWER.has(entry.name.toLowerCase())
        ) {
          queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 })
        }
        continue
      }

      if (entry.isFile()) {
        const matchedExt = matchSqliteExtension(entry.name)
        if (!matchedExt) continue

        const absPath = path.resolve(current.dir, entry.name)
        const rawStem = path.basename(entry.name, matchedExt)
        const baseName =
          rawStem && rawStem !== '.' && !rawStem.startsWith('.')
            ? rawStem
            : `${path.basename(current.dir)}/${entry.name}`
        const cleanName = `${baseName} (Workspace)`
        const isRegistered = existingPaths.has(normalizePathForCompare(absPath))

        let sizeBytes = 0
        try {
          const stat = await fs.promises.stat(absPath)
          sizeBytes = stat.size
        } catch {
          sizeBytes = 0
        }

        const id = `ws_${crypto.createHash('sha256').update(absPath).digest('base64url').slice(0, 20)}`
        results.push({
          filePath: absPath,
          name: cleanName,
          isRegistered,
          sizeBytes,
          sizeLabel: formatByteSize(sizeBytes),
          profile: {
            id,
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

  return results
}

/**
 * Resolves local, non-blocked workspace directories from the Orca host API.
 */
export async function getLocalWorkspaceDirs(orca: OrcaWorkerApi): Promise<string[]> {
  const workspaceDirs = new Map<string, string>()

  const addCandidate = (rawPath: string | undefined | null, hostId?: string | null): void => {
    if (!rawPath || typeof rawPath !== 'string' || !isLocalWorkspaceHost(hostId)) {
      return
    }
    const resolved = path.resolve(rawPath)
    if (isBlockedScanRoot(resolved)) {
      return
    }
    const norm = normalizePathForCompare(resolved)
    if (!workspaceDirs.has(norm)) {
      workspaceDirs.set(norm, resolved)
    }
  }

  if (!orca.host || typeof (orca.host as { call?: unknown }).call !== 'function') {
    return []
  }

  if (typeof orca.host.has !== 'function' || orca.host.has('workspace.list')) {
    try {
      const listResult = (await orca.host.call('workspace.list')) as {
        workspaces?: Array<{ path?: string; hostId?: string | null }>
      } | null
      if (listResult?.workspaces && Array.isArray(listResult.workspaces)) {
        for (const ws of listResult.workspaces) {
          addCandidate(ws?.path, ws?.hostId)
        }
      }
    } catch {
      // Host method unavailable or not permitted
    }
  }

  if (typeof orca.host.has !== 'function' || orca.host.has('project.list')) {
    try {
      const projResult = (await orca.host.call('project.list')) as {
        projects?: Array<{ path?: string; hostId?: string | null }>
      } | null
      if (projResult?.projects && Array.isArray(projResult.projects)) {
        for (const proj of projResult.projects) {
          addCandidate(proj?.path, proj?.hostId)
        }
      }
    } catch {
      // Host method unavailable or not permitted
    }
  }

  if (typeof orca.host.has !== 'function' || orca.host.has('workspace.readContext')) {
    try {
      const ctxResult = (await orca.host.call('workspace.readContext')) as {
        path?: string
        hostId?: string | null
        workspace?: { path?: string; hostId?: string | null }
      } | null
      if (ctxResult?.path) {
        addCandidate(ctxResult.path, ctxResult.hostId)
      } else if (ctxResult?.workspace?.path) {
        addCandidate(ctxResult.workspace.path, ctxResult.workspace.hostId)
      }
    } catch {
      // Host method unavailable or not permitted
    }
  }

  return Array.from(workspaceDirs.values())
}

/**
 * Automatically discovers SQLite files across active local workspaces via the Orca host API,
 * or from a specific directory path within strict time and traversal budgets.
 */
export async function discoverWorkspaceSqliteFiles(
  orcaOrDir: OrcaWorkerApi | string,
  existingProfiles: ConnectionProfile[] = [],
  options: ScanBudgetOptions = {}
): Promise<DiscoveredSqliteFile[]> {
  if (typeof orcaOrDir === 'string') {
    return scanDirectoryForSqliteFiles(orcaOrDir, existingProfiles, options)
  }

  const maxDurationMs = options.maxDurationMs ?? DEFAULT_SCAN_BUDGET.maxDurationMs
  const deadlineMs = options.deadlineMs ?? Date.now() + maxDurationMs
  const maxResults = options.maxResults ?? DEFAULT_SCAN_BUDGET.maxResults

  const workspaceDirs = await getLocalWorkspaceDirs(orcaOrDir)
  const allDiscovered: DiscoveredSqliteFile[] = []
  const seenPaths = new Set<string>()

  for (const dir of workspaceDirs) {
    if (Date.now() >= deadlineMs || allDiscovered.length >= maxResults) {
      break
    }
    const files = await scanDirectoryForSqliteFiles(dir, existingProfiles, {
      ...options,
      deadlineMs,
      maxResults: maxResults - allDiscovered.length,
    })
    for (const file of files) {
      const norm = normalizePathForCompare(file.filePath)
      if (!seenPaths.has(norm)) {
        seenPaths.add(norm)
        allDiscovered.push(file)
      }
    }
  }

  return allDiscovered
}

const ENV_FILENAMES = ['.env', '.env.local', '.env.development'] as const

const KNOWN_DB_ENV_KEYS = new Set([
  'DATABASE_URL',
  'DB_URL',
  'POSTGRES_URL',
  'POSTGRESQL_URL',
  'PG_URL',
  'MYSQL_URL',
  'MARIADB_URL',
  'COCKROACH_URL',
  'COCKROACHDB_URL',
  'REDIS_URL',
  'KV_URL',
  'CLICKHOUSE_URL',
  'TURSO_DATABASE_URL',
  'TURSO_URL',
  'LIBSQL_URL',
  'LIBSQL_DATABASE_URL',
  'D1_DATABASE_URL',
  'CLOUDFLARE_D1_URL',
  'SQLITE_URL',
  'MSSQL_URL',
  'SQLSERVER_URL',
  'ORACLE_URL',
  'MONGODB_URL',
  'MONGO_URL',
  'MONGODB_URI',
  'MONGO_URI',
])

const EXPLICIT_DB_SCHEMES = new Set([
  'postgres',
  'postgresql',
  'mysql',
  'mariadb',
  'cockroachdb',
  'cockroach',
  'redis',
  'rediss',
  'clickhouse',
  'clickhouses',
  'libsql',
  'd1',
  'd1+http',
  'd1+https',
  'sqlite',
  'file',
  'mssql',
  'sqlserver',
  'oracle',
  'oracledb',
  'mongodb',
  'mongodb+srv',
])

function stripEnvValueQuotes(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'") || (first === '`' && last === '`')) {
      return trimmed.slice(1, -1).trim()
    }
  }
  return trimmed.replace(/\s+#.*$/, '').trim()
}

function shouldInspectEnvEntry(envKey: string, uriValue: string): boolean {
  if (!uriValue || /\$\{[^}]+\}/.test(uriValue)) {
    return false
  }
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(uriValue)
  if (!schemeMatch) {
    return false
  }
  const scheme = schemeMatch[1].toLowerCase()
  if (scheme === 'http' || scheme === 'https') {
    return /clickhouse/i.test(envKey)
  }
  if (!EXPLICIT_DB_SCHEMES.has(scheme)) {
    return false
  }
  return KNOWN_DB_ENV_KEYS.has(envKey) || /(?:_URL|_URI|_DSN|_CONNECTION_STRING)$/i.test(envKey)
}

/**
 * Non-blockingly detects database connection URIs from root-level `.env`, `.env.local`,
 * and `.env.development` files (never recursing into subdirectories).
 */
export async function detectWorkspaceEnvConnections(
  workspaceDirs: string[]
): Promise<DetectedEnvConnection[]> {
  const detected: DetectedEnvConnection[] = []
  const seenUris = new Set<string>()
  const seenDirs = new Set<string>()

  for (const dir of workspaceDirs) {
    if (!dir || isBlockedScanRoot(dir)) {
      continue
    }
    const resolvedDir = path.resolve(dir)
    const dirNorm = normalizePathForCompare(resolvedDir)
    if (seenDirs.has(dirNorm)) {
      continue
    }
    seenDirs.add(dirNorm)

    for (const fileName of ENV_FILENAMES) {
      const filePath = path.join(resolvedDir, fileName)
      let content: string
      try {
        content = await fs.promises.readFile(filePath, 'utf8')
      } catch {
        continue
      }

      const lines = content.split(/\r?\n/)
      for (const rawLine of lines) {
        const trimmedLine = rawLine.trim()
        if (!trimmedLine || trimmedLine.startsWith('#')) {
          continue
        }
        const withoutExport = trimmedLine.replace(/^export\s+/, '')
        const eqIdx = withoutExport.indexOf('=')
        if (eqIdx <= 0) {
          continue
        }
        const envKey = withoutExport.slice(0, eqIdx).trim()
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envKey)) {
          continue
        }
        const uriValue = stripEnvValueQuotes(withoutExport.slice(eqIdx + 1))
        if (!shouldInspectEnvEntry(envKey, uriValue)) {
          continue
        }

        const parsed = parseConnectionUri(uriValue)
        if (!parsed.ok || !parsed.profile?.driver) {
          continue
        }

        const dedupeKey = `${parsed.profile.driver}|${uriValue}`
        if (seenUris.has(dedupeKey)) {
          continue
        }
        seenUris.add(dedupeKey)

        const labelBase = parsed.profile.name || parsed.profile.host || parsed.profile.database || envKey
        detected.push({
          envKey,
          sourceFile: filePath,
          driver: parsed.profile.driver,
          name: `${labelBase} (${envKey})`,
          uri: uriValue,
        })
      }
    }
  }

  return detected
}
