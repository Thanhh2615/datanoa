// Hybrid Docker Compose Auto-Discovery:
// Combines cross-platform read-only Docker CLI inspection (expanded for Windows & 10 engines)
// with a bounded zero-dependency static Compose YAML + .env parser.

import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import type { DiscoveredDockerComposeConnection, DockerComposeDriverType } from '../protocol'
import { readRegularFileBounded } from '../drivers/common/tls-and-tunnel'
import { isBlockedScanRoot, normalizePathForCompare } from './discovery'

function formatUrlHost(host: string): string {
  const trimmed = host.trim()
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return trimmed
  const zoneIdx = trimmed.indexOf('%')
  const bare = zoneIdx >= 0 ? trimmed.slice(0, zoneIdx) : trimmed
  return net.isIP(bare) === 6 ? `[${trimmed}]` : trimmed
}

export interface DockerInspectContainer {
  Id?: string
  Name: string
  Config: {
    Image: string
    Env: string[] | null
    Cmd?: string[] | null
    Args?: string[] | null
    Labels: Record<string, string> | null
    ExposedPorts?: Record<string, unknown> | null
  }
  State: { Status: string }
  NetworkSettings: {
    Ports: Record<string, Array<{ HostIp: string; HostPort: string }> | null> | null
  }
}

export interface ComposeDetectOptions {
  onlyMatchedWorkspaces?: boolean
  liveContainersOverride?: DockerInspectContainer[]
}

export interface DockerTargetLocality {
  isLocal: boolean
  contextLabel: 'Local Docker' | 'Docker Context'
}

const KNOWN_LOCAL_DOCKER_CONTEXTS: ReadonlySet<string> = new Set([
  'default',
  'desktop-linux',
  'desktop-windows',
  'rancher-desktop',
  'orbstack',
  'colima',
  'lima-default',
  'podman-machine-default',
])

function isLocalDockerHostEndpoint(rawHost: string): boolean {
  const trimmed = rawHost.trim().toLowerCase()
  if (!trimmed) return true
  if (trimmed.startsWith('unix://') || trimmed.startsWith('npipe://') || trimmed.startsWith('fd://')) {
    return true
  }
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol === 'tcp:' || parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      const h = parsed.hostname.replace(/^\[|\]$/g, '')
      return h === 'localhost' || h === '::1' || /^127(?:\.\d{1,3}){3}$/.test(h)
    }
  } catch {
    // Non-URL Docker host (e.g. remote ssh/host) treated as non-local
  }
  return false
}

export function detectDockerTargetLocality(
  env: NodeJS.ProcessEnv = process.env,
  dockerConfigPath?: string
): DockerTargetLocality {
  const dockerHost = (env.DOCKER_HOST || '').trim()
  if (dockerHost.length > 0) {
    const isLocal = isLocalDockerHostEndpoint(dockerHost)
    return {
      isLocal,
      contextLabel: isLocal ? 'Local Docker' : 'Docker Context',
    }
  }

  const dockerContext = (env.DOCKER_CONTEXT || '').trim()
  if (dockerContext.length > 0) {
    const isLocal = KNOWN_LOCAL_DOCKER_CONTEXTS.has(dockerContext.toLowerCase())
    return {
      isLocal,
      contextLabel: isLocal ? 'Local Docker' : 'Docker Context',
    }
  }

  const configPath =
    dockerConfigPath ??
    path.join(
      (env.DOCKER_CONFIG || '').trim() ||
        path.join(env.HOME || env.USERPROFILE || os.homedir(), '.docker'),
      'config.json'
    )
  try {
    const st = fs.lstatSync(configPath)
    if (!st.isSymbolicLink() && st.isFile() && st.size <= MAX_COMPOSE_FILE_BYTES) {
      const raw = fs.readFileSync(configPath, 'utf8')
      const parsed = JSON.parse(raw) as { currentContext?: unknown }
      const currentContext =
        typeof parsed?.currentContext === 'string' ? parsed.currentContext.trim() : ''
      if (currentContext.length > 0 && !KNOWN_LOCAL_DOCKER_CONTEXTS.has(currentContext.toLowerCase())) {
        return {
          isLocal: false,
          contextLabel: 'Docker Context',
        }
      }
    }
  } catch {
    // Unreadable ~/.docker/config.json defaults to Local Docker
  }

  return {
    isLocal: true,
    contextLabel: 'Local Docker',
  }
}

const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project'
const COMPOSE_SERVICE_LABEL = 'com.docker.compose.service'
const COMPOSE_WORKDIR_LABEL = 'com.docker.compose.project.working_dir'
const COMPOSE_CONFIG_FILES_LABEL = 'com.docker.compose.project.config_files'

const DOCKER_TIMEOUT_MS = 4000
const DOCKER_MAX_BUFFER = 8 * 1024 * 1024
const MAX_COMPOSE_FILE_BYTES = 262_144
const MAX_COMPOSE_FILES_PER_SCAN = 20

const EXACT_COMPOSE_NAMES = [
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
] as const
const COMPOSE_VARIANT_RE = /^(?:docker-)?compose\.[A-Za-z0-9_.-]+\.ya?ml$/i
const INFRA_SUBDIRS = ['docker', 'infra', 'deploy', '.devcontainer'] as const

const ADMIN_OR_TOOL_IMAGE_RE =
  /(?:pgadmin|phpmyadmin|adminer|pgweb|redis-commander|redisinsight|mongo-express|cloudbeaver|dbeaver|metabase|grafana|prometheus|exporter|nginx|caddy|traefik|haproxy|busybox|alpine\/git|cloudflared|mailhog|mailpit)/i

interface DriverRule {
  driver: DockerComposeDriverType
  defaultPort: number
  ports: readonly number[]
  fallbackPorts?: readonly number[]
  imageRe: RegExp
}

const DRIVER_RULES: readonly DriverRule[] = [
  { driver: 'cockroachdb', defaultPort: 26257, ports: [26257], fallbackPorts: [26257], imageRe: /(?:^|\/|-)cockroach(?:db)?(?::|$)/i },
  { driver: 'mariadb', defaultPort: 3306, ports: [3306], imageRe: /(?:^|\/|-)mariadb(?::|$)/i },
  { driver: 'mysql', defaultPort: 3306, ports: [3306], fallbackPorts: [3306], imageRe: /(?:^|\/|-)(?:mysql|percona|vitess)(?::|$)/i },
  { driver: 'postgres', defaultPort: 5432, ports: [5432], fallbackPorts: [5432], imageRe: /(?:^|\/|-)(?:postgres(?:ql)?|postgis|pgvector|timescaledb|paradedb|supabase\/postgres)(?::|$)/i },
  { driver: 'clickhouse', defaultPort: 8123, ports: [8123, 8443], imageRe: /clickhouse/i },
  { driver: 'redis', defaultPort: 6379, ports: [6379], fallbackPorts: [6379], imageRe: /(?:^|\/|-)(?:redis|valkey|keydb|dragonfly)(?::|$)/i },
  { driver: 'libsql', defaultPort: 8080, ports: [8080], imageRe: /(?:libsql|sqld|tursodatabase|hrana)/i },
  { driver: 'mssql', defaultPort: 1433, ports: [1433], fallbackPorts: [1433], imageRe: /(?:mssql|sqlserver|azure-sql-edge)/i },
  { driver: 'oracle', defaultPort: 1521, ports: [1521], fallbackPorts: [1521], imageRe: /oracle/i },
  { driver: 'mongodb', defaultPort: 27017, ports: [27017], fallbackPorts: [27017], imageRe: /(?:^|\/|-)(?:mongo|mongodb|documentdb|percona-server-mongodb)(?::|$)/i },
]

function getDefaultPortForComposeDriver(driver: DockerComposeDriverType): number {
  const rule = DRIVER_RULES.find((r) => r.driver === driver)
  return rule ? rule.defaultPort : 5432
}

function getDockerSearchDirs(): string[] {
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  if (process.platform === 'win32') {
    const candidates = [
      ...pathDirs,
      process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Docker', 'Docker', 'resources', 'bin') : '',
      'C:\\Program Files\\Docker\\Docker\\resources\\bin',
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Docker', 'Docker', 'resources', 'bin') : '',
      path.join(os.homedir(), '.docker', 'bin'),
      path.join(os.homedir(), '.rd', 'bin'),
    ]
    return candidates.filter(Boolean)
  }
  const home = process.env.HOME || os.homedir()
  return [
    ...pathDirs,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home, '.orbstack', 'bin'),
    path.join(home, '.docker', 'bin'),
    path.join(home, '.rd', 'bin'),
    '/Applications/Docker.app/Contents/Resources/bin',
    '/usr/bin',
    '/bin',
  ]
}

export function findDockerBinary(): string | null {
  const exe = process.platform === 'win32' ? 'docker.exe' : 'docker'
  const seen = new Set<string>()
  for (const dir of getDockerSearchDirs()) {
    const norm = normalizePathForCompare(dir)
    if (seen.has(norm)) continue
    seen.add(norm)
    const candidate = path.join(dir, exe)
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate
      }
    } catch {
      // Ignore unreadable PATH segments
    }
  }
  return null
}

function runDockerCommand(bin: string, args: string[], timeoutMs = DOCKER_TIMEOUT_MS): Promise<string> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: process.env.HOME || os.homedir(),
  }
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { env, timeout: timeoutMs, maxBuffer: DOCKER_MAX_BUFFER, windowsHide: true },
      (error: Error | null, stdout: string, stderr: string) => {
        if (error) {
          reject(new Error(`docker ${args[0] || ''} failed: ${String(stderr || error.message).trim()}`))
        } else {
          resolve(String(stdout))
        }
      }
    )
  })
}

async function listLiveDockerContainers(): Promise<DockerInspectContainer[]> {
  const bin = findDockerBinary()
  if (!bin) return []
  try {
    const idsOut = await runDockerCommand(bin, [
      'ps',
      '-a',
      '-q',
      '--filter',
      `label=${COMPOSE_PROJECT_LABEL}`,
    ])
    const ids = idsOut
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 80)
    if (ids.length === 0) return []
    const inspectOut = await runDockerCommand(bin, ['inspect', ...ids])
    const parsed = JSON.parse(inspectOut) as unknown
    return Array.isArray(parsed) ? (parsed as DockerInspectContainer[]) : []
  } catch {
    return []
  }
}

function isSameOrParentDir(candidatePath: string, workspaceDirs: readonly string[]): boolean {
  if (!candidatePath || workspaceDirs.length === 0) return false
  const candNorm = normalizePathForCompare(candidatePath)
  const sep = process.platform === 'win32' ? '\\' : '/'
  for (const wsDir of workspaceDirs) {
    if (!wsDir) continue
    const wsNorm = normalizePathForCompare(wsDir)
    if (candNorm === wsNorm) return true
    if (candNorm.startsWith(`${wsNorm}${sep}`) || wsNorm.startsWith(`${candNorm}${sep}`)) {
      return true
    }
  }
  return false
}

function isInsideDir(candidatePath: string, parentDir: string): boolean {
  if (!candidatePath || !parentDir) return false
  const candNorm = normalizePathForCompare(candidatePath)
  const parentNorm = normalizePathForCompare(parentDir)
  const sep = process.platform === 'win32' ? '\\' : '/'
  return candNorm !== parentNorm && candNorm.startsWith(`${parentNorm}${sep}`)
}

function stripImageRegistryAndTag(rawImage: string): string {
  const withoutDigest = String(rawImage || '').trim().split('@')[0] || ''
  const lastSlash = withoutDigest.lastIndexOf('/')
  const lastColon = withoutDigest.lastIndexOf(':')
  const withoutTag = lastColon > lastSlash ? withoutDigest.slice(0, lastColon) : withoutDigest
  return withoutTag.toLowerCase()
}

function detectDriverFromImageAndPorts(
  image: string,
  containerPorts: ReadonlySet<number>
): DockerComposeDriverType | null {
  const imageNoTag = stripImageRegistryAndTag(image)
  const shortName = imageNoTag.split('/').pop() || imageNoTag
  if (imageNoTag && ADMIN_OR_TOOL_IMAGE_RE.test(imageNoTag)) {
    return null
  }
  for (const rule of DRIVER_RULES) {
    if (rule.imageRe.test(imageNoTag) || rule.imageRe.test(shortName)) {
      return rule.driver
    }
  }
  for (const rule of DRIVER_RULES) {
    if (rule.fallbackPorts?.some((p) => containerPorts.has(p))) {
      return rule.driver
    }
  }
  return null
}

function normalizeHostIp(rawIp: string | undefined): string {
  const ip = String(rawIp || '').trim()
  if (!ip || ip === '0.0.0.0' || ip === '::' || ip === '[::]') {
    return '127.0.0.1'
  }
  return ip
}

function parseContainerPortNumber(key: string): number | null {
  const m = /^(\d{1,5})(?:\/tcp)?$/i.exec(key.trim())
  if (!m) return null
  const num = Number.parseInt(m[1], 10)
  return Number.isFinite(num) && num >= 1 && num <= 65535 ? num : null
}

function extractRequirePassFromArgs(args: ReadonlyArray<string>): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const token = String(args[i] || '')
    if (token === '--requirepass' && i + 1 < args.length) {
      return String(args[i + 1])
    }
    if (token.startsWith('--requirepass=')) {
      return token.slice('--requirepass='.length)
    }
  }
  return undefined
}

function pickEnvValue(env: ReadonlyMap<string, string>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const val = env.get(key)
    if (val !== undefined && val !== '') {
      return val
    }
  }
  return undefined
}

interface ResolvedComposeCredentials {
  user?: string
  password?: string
  database: string
  redisDb?: number
  ssl?: boolean
  url?: string
  passwordFromFile?: string
}

function buildCredentialsForDriver(
  driver: DockerComposeDriverType,
  host: string,
  port: number,
  env: ReadonlyMap<string, string>,
  cmdArgs: ReadonlyArray<string>,
  rawPasswordFileKey?: string
): ResolvedComposeCredentials {
  if (driver === 'postgres' || driver === 'cockroachdb') {
    const user = pickEnvValue(env, 'POSTGRES_USER', 'POSTGRESQL_USERNAME') ?? (driver === 'cockroachdb' ? 'root' : 'postgres')
    let password = pickEnvValue(env, 'POSTGRES_PASSWORD', 'POSTGRESQL_PASSWORD')
    const database =
      pickEnvValue(env, 'POSTGRES_DB', 'POSTGRESQL_DATABASE') ??
      (driver === 'cockroachdb' ? 'defaultdb' : user)
    if (password === undefined && env.get('POSTGRES_HOST_AUTH_METHOD') === 'trust') {
      password = ''
    }
    const isInsecureCrdb = driver === 'cockroachdb' && cmdArgs.some((a) => a === '--insecure')
    const passwordFromFile = password === undefined ? rawPasswordFileKey : undefined
    return {
      user,
      ...(password !== undefined ? { password } : {}),
      database,
      ...(driver === 'cockroachdb' ? { ssl: !isInsecureCrdb } : {}),
      ...(passwordFromFile ? { passwordFromFile } : {}),
    }
  }

  if (driver === 'mysql' || driver === 'mariadb') {
    const appUser = pickEnvValue(env, 'MYSQL_USER', 'MARIADB_USER')
    const appPass = pickEnvValue(env, 'MYSQL_PASSWORD', 'MARIADB_PASSWORD')
    let user: string
    let password: string | undefined
    if (appUser && appPass !== undefined) {
      user = appUser
      password = appPass
    } else {
      user = 'root'
      password = pickEnvValue(env, 'MYSQL_ROOT_PASSWORD', 'MARIADB_ROOT_PASSWORD')
      if (
        password === undefined &&
        pickEnvValue(env, 'MYSQL_ALLOW_EMPTY_PASSWORD', 'MARIADB_ALLOW_EMPTY_ROOT_PASSWORD', 'MARIADB_ALLOW_EMPTY_PASSWORD')
      ) {
        password = ''
      }
    }
    const database = pickEnvValue(env, 'MYSQL_DATABASE', 'MARIADB_DATABASE') ?? 'mysql'
    const passwordFromFile = password === undefined ? rawPasswordFileKey : undefined
    return {
      user,
      ...(password !== undefined ? { password } : {}),
      database,
      ...(passwordFromFile ? { passwordFromFile } : {}),
    }
  }

  if (driver === 'redis') {
    const password = pickEnvValue(env, 'REDIS_PASSWORD') ?? extractRequirePassFromArgs(cmdArgs)
    const user = pickEnvValue(env, 'REDIS_USERNAME')
    const passwordFromFile = password === undefined ? rawPasswordFileKey : undefined
    return {
      ...(user ? { user } : {}),
      ...(password !== undefined ? { password } : {}),
      database: '0',
      redisDb: 0,
      ...(passwordFromFile ? { passwordFromFile } : {}),
    }
  }

  if (driver === 'clickhouse') {
    const user = pickEnvValue(env, 'CLICKHOUSE_USER') ?? 'default'
    const password = pickEnvValue(env, 'CLICKHOUSE_PASSWORD')
    const database = pickEnvValue(env, 'CLICKHOUSE_DB') ?? 'default'
    const scheme = port === 8443 ? 'https' : 'http'
    const passwordFromFile = password === undefined ? rawPasswordFileKey : undefined
    return {
      user,
      ...(password !== undefined ? { password } : {}),
      database,
      ssl: scheme === 'https',
      url: `${scheme}://${formatUrlHost(host)}:${port}`,
      ...(passwordFromFile ? { passwordFromFile } : {}),
    }
  }

  if (driver === 'libsql') {
    const url = `http://${formatUrlHost(host)}:${port}`
    return {
      database: 'main',
      url,
      ssl: false,
    }
  }

  if (driver === 'mssql') {
    const user = 'sa'
    const password = pickEnvValue(env, 'MSSQL_SA_PASSWORD', 'SA_PASSWORD')
    const database = pickEnvValue(env, 'MSSQL_DB', 'MSSQL_DATABASE') ?? 'master'
    const passwordFromFile = password === undefined ? rawPasswordFileKey : undefined
    return {
      user,
      ...(password !== undefined ? { password } : {}),
      database,
      ...(passwordFromFile ? { passwordFromFile } : {}),
    }
  }

  if (driver === 'oracle') {
    const appUser = pickEnvValue(env, 'APP_USER')
    const appPass = pickEnvValue(env, 'APP_USER_PASSWORD')
    const user = appUser && appPass ? appUser : 'system'
    const password =
      appUser && appPass
        ? appPass
        : pickEnvValue(env, 'ORACLE_PASSWORD', 'ORACLE_PWD')
    const database = pickEnvValue(env, 'ORACLE_DATABASE') ?? 'FREEPDB1'
    const passwordFromFile = password === undefined ? rawPasswordFileKey : undefined
    return {
      user,
      ...(password !== undefined ? { password } : {}),
      database,
      ...(passwordFromFile ? { passwordFromFile } : {}),
    }
  }

  // mongodb
  const user = pickEnvValue(env, 'MONGO_INITDB_ROOT_USERNAME', 'MONGODB_USERNAME')
  const password = pickEnvValue(env, 'MONGO_INITDB_ROOT_PASSWORD', 'MONGODB_PASSWORD')
  const database = pickEnvValue(env, 'MONGO_INITDB_DATABASE', 'MONGODB_DATABASE') ?? 'admin'
  const passwordFromFile = password === undefined ? rawPasswordFileKey : undefined
  return {
    ...(user ? { user } : {}),
    ...(password !== undefined ? { password } : {}),
    database,
    ...(passwordFromFile ? { passwordFromFile } : {}),
  }
}

export function parseDockerInspectContainers(
  containers: readonly DockerInspectContainer[],
  workspaceDirs: readonly string[]
): DiscoveredDockerComposeConnection[] {
  const results: DiscoveredDockerComposeConnection[] = []

  for (const container of containers) {
    const labels = container.Config?.Labels ?? {}
    const project = String(labels[COMPOSE_PROJECT_LABEL] || '').trim()
    const service = String(labels[COMPOSE_SERVICE_LABEL] || '').trim()
    if (!project || !service) continue
    if (labels['com.ddev.site-name'] || project.startsWith('ddev-')) continue

    const exposedKeys = [
      ...Object.keys(container.Config?.ExposedPorts ?? {}),
      ...Object.keys(container.NetworkSettings?.Ports ?? {}),
    ]
    const portNumbers = new Set<number>()
    for (const key of exposedKeys) {
      const p = parseContainerPortNumber(key)
      if (p !== null) portNumbers.add(p)
    }

    const driver = detectDriverFromImageAndPorts(container.Config?.Image || '', portNumbers)
    if (!driver) continue

    const rule = DRIVER_RULES.find((r) => r.driver === driver)
    const candidateContainerPorts = rule ? rule.ports : [getDefaultPortForComposeDriver(driver)]
    const portBindingsMap = container.NetworkSettings?.Ports ?? {}

    let host = '127.0.0.1'
    let port = candidateContainerPorts[0] || getDefaultPortForComposeDriver(driver)
    let hasPublishedPort = false

    for (const cPort of candidateContainerPorts) {
      const bindings = portBindingsMap[`${cPort}/tcp`]
      if (Array.isArray(bindings) && bindings.length > 0) {
        const ipv4First = bindings.find((b) => b.HostPort && (!b.HostIp || b.HostIp === '0.0.0.0' || !b.HostIp.includes(':')))
        const picked = ipv4First ?? bindings.find((b) => Boolean(b.HostPort))
        if (picked && picked.HostPort) {
          const parsedHostPort = Number.parseInt(picked.HostPort, 10)
          if (Number.isFinite(parsedHostPort) && parsedHostPort >= 1 && parsedHostPort <= 65535) {
            host = normalizeHostIp(picked.HostIp)
            port = parsedHostPort
            hasPublishedPort = true
            break
          }
        }
      }
    }

    const env = new Map<string, string>()
    for (const entry of container.Config?.Env ?? []) {
      const eq = entry.indexOf('=')
      if (eq > 0) {
        env.set(entry.slice(0, eq), entry.slice(eq + 1))
      }
    }
    const passwordFileKey = Array.from(env.keys()).find((k) => k.endsWith('_PASSWORD_FILE'))
    const cmdArgs = [...(container.Config?.Cmd ?? []), ...(container.Config?.Args ?? [])]
    const creds = buildCredentialsForDriver(driver, host, port, env, cmdArgs, passwordFileKey)

    const status = String(container.State?.Status || 'unknown').toLowerCase()
    const workDir = String(labels[COMPOSE_WORKDIR_LABEL] || '').trim()
    const configFiles = String(labels[COMPOSE_CONFIG_FILES_LABEL] || '').trim()
    const primaryConfigFile = configFiles ? configFiles.split(',')[0].trim() : ''
    const configFileDir = primaryConfigFile ? path.dirname(primaryConfigFile) : ''
    const sourceFile = primaryConfigFile || workDir || `compose:${project}`

    const workspaceMatched =
      isSameOrParentDir(workDir, workspaceDirs) ||
      isSameOrParentDir(configFileDir, workspaceDirs)

    const unpublishedPort = status === 'running' && !hasPublishedPort
    let hint: string | undefined
    if (status !== 'running') {
      hint = `Container "${project}/${service}" is ${status} — run \`docker compose up -d\` before connecting.`
    } else if (unpublishedPort) {
      hint = `Container "${project}/${service}" does not publish port ${candidateContainerPorts[0]} to host.`
    } else if (creds.passwordFromFile) {
      hint = `Password is loaded from ${creds.passwordFromFile} inside the container; enter your password manually.`
    }

    results.push({
      id: `live:${project}/${service}`,
      project,
      service,
      driver,
      name: `${project} · ${service}`,
      host,
      port,
      database: creds.database,
      ...(creds.user !== undefined ? { user: creds.user } : {}),
      ...(creds.password !== undefined ? { password: creds.password } : {}),
      ...(creds.url !== undefined ? { url: creds.url } : {}),
      ...(creds.redisDb !== undefined ? { redisDb: creds.redisDb } : {}),
      ...(creds.ssl !== undefined ? { ssl: creds.ssl } : {}),
      sourceKind: 'live',
      sourceFile,
      status,
      workspaceMatched,
      ...(hint ? { hint } : {}),
      ...(unpublishedPort ? { unpublishedPort: true } : {}),
      ...(creds.passwordFromFile ? { passwordFromFile: creds.passwordFromFile } : {}),
    })
  }

  return results
}

// ============================================================================
// Bounded Zero-Dependency Static Compose YAML + .env Parser
// ============================================================================

function stripYamlInlineComment(line: string): string {
  let quote: '"' | "'" | null = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote) {
      if (quote === '"' && ch === '\\') {
        i++
        continue
      }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i).trimEnd()
    }
  }
  return line.trimEnd()
}

function unquoteYamlScalar(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

function loadEnvMapFromText(content: string, out = new Map<string, string>()): Map<string, string> {
  const cleanContent = content.replace(/^\uFEFF/, '')
  for (const rawLine of cleanContent.split(/\r?\n/)) {
    const trimmed = rawLine.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const clean = trimmed.replace(/^export\s+/, '')
    const eq = clean.indexOf('=')
    if (eq <= 0) continue
    const key = clean.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    let val = clean.slice(eq + 1).trim()
    if (
      val.length >= 2 &&
      ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
    ) {
      val = val.slice(1, -1)
    } else {
      val = stripYamlInlineComment(val).trim()
    }
    out.set(key, val)
  }
  return out
}

function interpolateComposeVars(raw: string, vars: ReadonlyMap<string, string>): string | undefined {
  let missingUnresolved = false
  const replaced = raw
    .replace(/\$\$/g, '\u0000DOLLAR\u0000')
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?-)([^}]*))?\}/g, (_m, name: string, op: string | undefined, def: string | undefined) => {
      const val = vars.get(name)
      if (op === ':-') {
        if (val !== undefined && val !== '') return val
        return def !== undefined ? (interpolateComposeVars(def, vars) ?? '') : ''
      }
      if (op === '-') {
        if (val !== undefined) return val
        return def !== undefined ? (interpolateComposeVars(def, vars) ?? '') : ''
      }
      if (val !== undefined) return val
      missingUnresolved = true
      return ''
    })
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name: string) => {
      const val = vars.get(name)
      if (val !== undefined) return val
      missingUnresolved = true
      return ''
    })
    .replace(/\u0000DOLLAR\u0000/g, '$')

  return missingUnresolved ? undefined : replaced
}

interface RawStaticService {
  name: string
  image: string
  containerName?: string
  ports: Array<{ hostIp?: string; hostPort?: number; containerPort: number }>
  exposed: number[]
  envEntries: Array<{ key: string; value?: string }>
  envFiles: string[]
  cmdArgs: string[]
}

function parseShortPortMapping(
  raw: string,
  vars: ReadonlyMap<string, string>
): { hostIp?: string; hostPort?: number; containerPort: number } | null {
  const expanded = interpolateComposeVars(unquoteYamlScalar(raw), vars)
  if (!expanded) return null
  const withoutProto = expanded.replace(/\/(?:tcp|udp)$/i, '').trim()
  const parts = withoutProto.split(':').filter((p) => p.length > 0)
  const parsePortVal = (s: string): number | null => {
    const first = s.split('-')[0].trim()
    const num = Number.parseInt(first, 10)
    return Number.isFinite(num) && num >= 1 && num <= 65535 ? num : null
  }
  if (parts.length === 1) {
    const p = parsePortVal(parts[0])
    return p !== null ? { hostPort: p, containerPort: p } : null
  }
  if (parts.length === 2) {
    const hp = parsePortVal(parts[0])
    const cp = parsePortVal(parts[1])
    return hp !== null && cp !== null ? { hostPort: hp, containerPort: cp } : null
  }
  if (parts.length >= 3) {
    const cp = parsePortVal(parts[parts.length - 1])
    const hp = parsePortVal(parts[parts.length - 2])
    const ip = parts.slice(0, -2).join(':')
    return hp !== null && cp !== null ? { hostIp: ip, hostPort: hp, containerPort: cp } : null
  }
  return null
}

function tokenizeCommandString(raw: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(raw)) !== null) {
    out.push(match[1] ?? match[2] ?? match[3] ?? '')
  }
  return out
}

export function parseComposeFileContent(
  yamlContent: string,
  sourceFilePath: string,
  baseEnvVars: ReadonlyMap<string, string>,
  workspaceMatched = true,
  readExtraEnvFile?: (resolvedEnvPath: string) => ReadonlyMap<string, string> | null
): DiscoveredDockerComposeConnection[] {
  const projectDir = path.dirname(sourceFilePath)
  let projectName = path.basename(projectDir) || 'compose'
  const lines = yamlContent.replace(/^\uFEFF/, '').split(/\r?\n/)

  let inServices = false
  let servicesIndent = -1
  let currentService: RawStaticService | null = null
  let currentServiceIndent = -1
  let currentSection: 'ports' | 'expose' | 'environment' | 'env_file' | 'command' | null = null
  let currentSectionIndent = -1
  let pendingLongPort: { hostIp?: string; hostPort?: number; containerPort?: number } | null = null

  const services: RawStaticService[] = []

  const flushLongPort = (): void => {
    if (pendingLongPort && currentService && pendingLongPort.containerPort) {
      currentService.ports.push({
        ...(pendingLongPort.hostIp ? { hostIp: pendingLongPort.hostIp } : {}),
        ...(pendingLongPort.hostPort ? { hostPort: pendingLongPort.hostPort } : {}),
        containerPort: pendingLongPort.containerPort,
      })
    }
    pendingLongPort = null
  }

  for (const rawLine of lines) {
    const noComment = stripYamlInlineComment(rawLine)
    if (!noComment.trim()) continue
    const indent = noComment.length - noComment.trimStart().length
    const trimmed = noComment.trim()

    if (indent === 0) {
      flushLongPort()
      currentSection = null
      currentService = null
      if (/^services\s*:\s*$/.test(trimmed)) {
        inServices = true
        servicesIndent = 0
        continue
      }
      inServices = false
      const topName = /^name\s*:\s*(.+)$/.exec(trimmed)
      if (topName) {
        const cleanName = unquoteYamlScalar(topName[1])
        if (cleanName) projectName = cleanName
      }
      continue
    }

    if (!inServices) continue

    if (currentService === null || (currentServiceIndent !== -1 && indent <= currentServiceIndent && !trimmed.startsWith('-'))) {
      flushLongPort()
      currentSection = null
      if (indent <= servicesIndent) {
        inServices = false
        continue
      }
      const svcMatch = /^([A-Za-z0-9_.-]+)\s*:\s*$/.exec(trimmed)
      if (svcMatch) {
        currentService = {
          name: svcMatch[1],
          image: '',
          ports: [],
          exposed: [],
          envEntries: [],
          envFiles: [],
          cmdArgs: [],
        }
        services.push(currentService)
        currentServiceIndent = indent
      }
      continue
    }

    if (currentSection && indent > currentSectionIndent) {
      if (currentSection === 'ports') {
        if (trimmed.startsWith('-')) {
          flushLongPort()
          const item = trimmed.slice(1).trim()
          if (!item) continue
          const kvInList = /^(target|published|host_ip)\s*:\s*(.+)$/.exec(item)
          if (kvInList) {
            pendingLongPort = {}
            const val = interpolateComposeVars(unquoteYamlScalar(kvInList[2]), baseEnvVars) ?? ''
            if (kvInList[1] === 'target') pendingLongPort.containerPort = Number.parseInt(val, 10) || undefined
            else if (kvInList[1] === 'published') pendingLongPort.hostPort = Number.parseInt(val, 10) || undefined
            else if (kvInList[1] === 'host_ip') pendingLongPort.hostIp = val
          } else {
            const parsed = parseShortPortMapping(item, baseEnvVars)
            if (parsed) currentService.ports.push(parsed)
          }
          continue
        }
        if (pendingLongPort) {
          const kv = /^(target|published|host_ip)\s*:\s*(.+)$/.exec(trimmed)
          if (kv) {
            const val = interpolateComposeVars(unquoteYamlScalar(kv[2]), baseEnvVars) ?? ''
            if (kv[1] === 'target') pendingLongPort.containerPort = Number.parseInt(val, 10) || undefined
            else if (kv[1] === 'published') pendingLongPort.hostPort = Number.parseInt(val, 10) || undefined
            else if (kv[1] === 'host_ip') pendingLongPort.hostIp = val
          }
          continue
        }
      }

      if (currentSection === 'expose' && trimmed.startsWith('-')) {
        const val = unquoteYamlScalar(trimmed.slice(1))
        const p = Number.parseInt(val.split('/')[0], 10)
        if (Number.isFinite(p) && p >= 1 && p <= 65535) currentService.exposed.push(p)
        continue
      }

      if (currentSection === 'env_file') {
        if (trimmed.startsWith('-')) {
          const item = trimmed.slice(1).trim()
          const pathKv = /^path\s*:\s*(.+)$/.exec(item)
          const rawPath = pathKv ? pathKv[1] : item
          if (rawPath) currentService.envFiles.push(unquoteYamlScalar(rawPath))
        } else {
          const pathKv = /^path\s*:\s*(.+)$/.exec(trimmed)
          if (pathKv) currentService.envFiles.push(unquoteYamlScalar(pathKv[1]))
        }
        continue
      }

      if (currentSection === 'command' && trimmed.startsWith('-')) {
        currentService.cmdArgs.push(unquoteYamlScalar(trimmed.slice(1)))
        continue
      }

      if (currentSection === 'environment') {
        if (trimmed.startsWith('-')) {
          const entry = unquoteYamlScalar(trimmed.slice(1))
          const eq = entry.indexOf('=')
          if (eq > 0) {
            currentService.envEntries.push({
              key: entry.slice(0, eq).trim(),
              value: entry.slice(eq + 1),
            })
          } else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry)) {
            currentService.envEntries.push({ key: entry })
          }
        } else {
          const colon = trimmed.indexOf(':')
          if (colon > 0) {
            const key = trimmed.slice(0, colon).trim()
            const rawVal = trimmed.slice(colon + 1).trim()
            if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
              currentService.envEntries.push({
                key,
                value: rawVal ? unquoteYamlScalar(rawVal) : undefined,
              })
            }
          }
        }
        continue
      }
    }

    flushLongPort()
    currentSection = null

    const propMatch = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(trimmed)
    if (!propMatch) continue
    const prop = propMatch[1]
    const rawVal = propMatch[2].trim()

    if (prop === 'image') {
      currentService.image = unquoteYamlScalar(rawVal)
    } else if (prop === 'container_name') {
      currentService.containerName = unquoteYamlScalar(rawVal)
    } else if (prop === 'command') {
      if (rawVal) {
        currentService.cmdArgs.push(...tokenizeCommandString(rawVal))
      } else {
        currentSection = 'command'
        currentSectionIndent = indent
      }
    } else if (prop === 'ports' || prop === 'expose' || prop === 'environment' || prop === 'env_file') {
      if (prop === 'env_file' && rawVal) {
        const cleanEnvVal = stripYamlInlineComment(rawVal).trim()
        if (cleanEnvVal.startsWith('[') && cleanEnvVal.endsWith(']')) {
          for (const part of cleanEnvVal.slice(1, -1).split(',')) {
            const unquoted = unquoteYamlScalar(part)
            if (unquoted) currentService.envFiles.push(unquoted)
          }
        } else if (cleanEnvVal && !cleanEnvVal.startsWith('[')) {
          currentService.envFiles.push(unquoteYamlScalar(cleanEnvVal))
        }
      } else if (!rawVal) {
        currentSection = prop
        currentSectionIndent = indent
      }
    }
  }
  flushLongPort()

  const out: DiscoveredDockerComposeConnection[] = []
  for (const svc of services) {
    const portSet = new Set<number>([
      ...svc.ports.map((p) => p.containerPort),
      ...svc.exposed,
    ])
    const driver = detectDriverFromImageAndPorts(svc.image, portSet)
    if (!driver) continue

    const rule = DRIVER_RULES.find((r) => r.driver === driver)
    const preferredPorts = rule ? rule.ports : [getDefaultPortForComposeDriver(driver)]
    const matchedMapping = svc.ports.find((p) => preferredPorts.includes(p.containerPort)) ?? svc.ports[0]
    const host = normalizeHostIp(matchedMapping?.hostIp)
    const port = matchedMapping?.hostPort ?? preferredPorts[0] ?? getDefaultPortForComposeDriver(driver)
    const unpublishedPort = !matchedMapping?.hostPort

    const mergedVars = new Map<string, string>(baseEnvVars)
    const svcEnv = new Map<string, string>()
    if (readExtraEnvFile) {
      for (const relEnv of svc.envFiles) {
        const resolvedEnv = path.resolve(projectDir, relEnv)
        if (!isInsideDir(resolvedEnv, projectDir)) continue
        const loaded = readExtraEnvFile(resolvedEnv)
        if (loaded) {
          loaded.forEach((v, k) => {
            mergedVars.set(k, v)
            svcEnv.set(k, v)
          })
        }
      }
    }
    for (const { key, value } of svc.envEntries) {
      if (value !== undefined) {
        const resolved = interpolateComposeVars(value, mergedVars)
        if (resolved !== undefined) {
          svcEnv.set(key, resolved)
        }
      } else {
        const fromEnv = mergedVars.get(key)
        if (fromEnv !== undefined) {
          svcEnv.set(key, fromEnv)
        }
      }
    }

    const passwordFileKey = Array.from(svcEnv.keys()).find((k) => k.endsWith('_PASSWORD_FILE'))
    const expandedCmdArgs = svc.cmdArgs.map((arg) => interpolateComposeVars(arg, mergedVars) ?? arg)
    const creds = buildCredentialsForDriver(driver, host, port, svcEnv, expandedCmdArgs, passwordFileKey)

    let hint: string | undefined
    if (unpublishedPort) {
      hint = `Service "${svc.name}" in ${path.basename(sourceFilePath)} does not expose a published host port.`
    } else if (creds.passwordFromFile) {
      hint = `Password is loaded from ${creds.passwordFromFile}; enter your password manually.`
    }

    out.push({
      id: `file:${sourceFilePath}#${svc.name}`,
      project: projectName,
      service: svc.name,
      driver,
      name: `${projectName} · ${svc.name}`,
      host,
      port,
      database: creds.database,
      ...(creds.user !== undefined ? { user: creds.user } : {}),
      ...(creds.password !== undefined ? { password: creds.password } : {}),
      ...(creds.url !== undefined ? { url: creds.url } : {}),
      ...(creds.redisDb !== undefined ? { redisDb: creds.redisDb } : {}),
      ...(creds.ssl !== undefined ? { ssl: creds.ssl } : {}),
      sourceKind: 'file',
      sourceFile: sourceFilePath,
      status: 'compose file',
      workspaceMatched,
      ...(hint ? { hint } : {}),
      ...(unpublishedPort ? { unpublishedPort: true } : {}),
      ...(creds.passwordFromFile ? { passwordFromFile: creds.passwordFromFile } : {}),
    })
  }

  return out
}

export function mergeDockerComposeDiscoveries(
  liveItems: readonly DiscoveredDockerComposeConnection[],
  staticItems: readonly DiscoveredDockerComposeConnection[]
): DiscoveredDockerComposeConnection[] {
  const merged = liveItems.map((item) => ({ ...item }))

  for (const sItem of staticItems) {
    const staticDir = normalizePathForCompare(path.dirname(sItem.sourceFile))
    const matchedLive = merged.find((lItem) => {
      if (lItem.service !== sItem.service || lItem.driver !== sItem.driver) return false
      const liveDir = lItem.sourceFile ? normalizePathForCompare(path.dirname(lItem.sourceFile)) : ''
      if (liveDir && liveDir === staticDir) return true
      if (lItem.project === sItem.project) return true
      return lItem.host === sItem.host && lItem.port === sItem.port
    })

    if (matchedLive) {
      matchedLive.workspaceMatched = matchedLive.workspaceMatched || sItem.workspaceMatched
      if (matchedLive.password === undefined && sItem.password !== undefined) {
        matchedLive.password = sItem.password
      }
      if (!matchedLive.user && sItem.user) matchedLive.user = sItem.user
      if (!matchedLive.database && sItem.database) matchedLive.database = sItem.database
      if (sItem.sourceFile) matchedLive.sourceFile = sItem.sourceFile
      continue
    }

    merged.push(sItem)
  }

  const rankOf = (item: DiscoveredDockerComposeConnection): number => {
    const ws = item.workspaceMatched ? 0 : 10
    const kind =
      item.sourceKind === 'live'
        ? item.status === 'running'
          ? 0
          : 1
        : 2
    return ws + kind
  }

  return merged.sort((a, b) => {
    const diff = rankOf(a) - rankOf(b)
    if (diff !== 0) return diff
    return a.name.localeCompare(b.name)
  })
}

function isRealPathWithinRoots(realPath: string, realRoots: readonly string[]): boolean {
  const normPath = normalizePathForCompare(realPath)
  for (const root of realRoots) {
    const normRoot = normalizePathForCompare(root)
    if (normPath === normRoot) return true
    const rel = path.relative(normRoot, normPath)
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      return true
    }
  }
  return false
}

async function collectComposeFilePaths(
  workspaceDirs: readonly string[],
  realRoots: readonly string[]
): Promise<string[]> {
  const found: string[] = []
  const seen = new Set<string>()

  const tryAddFile = async (filePath: string): Promise<void> => {
    if (found.length >= MAX_COMPOSE_FILES_PER_SCAN) return
    try {
      const realFile = await fs.promises.realpath(filePath)
      if (!isRealPathWithinRoots(realFile, realRoots)) return
      const norm = normalizePathForCompare(realFile)
      if (seen.has(norm)) return
      const stat = await fs.promises.stat(realFile)
      if (stat.isFile() && stat.size <= MAX_COMPOSE_FILE_BYTES) {
        seen.add(norm)
        found.push(realFile)
      }
    } catch {
      // Missing or escaped compose file candidate
    }
  }

  for (const dir of workspaceDirs) {
    if (found.length >= MAX_COMPOSE_FILES_PER_SCAN) break
    if (!dir || isBlockedScanRoot(dir)) continue
    const resolvedDir = path.resolve(dir)

    try {
      const rootEntries = await fs.promises.readdir(resolvedDir, { withFileTypes: true })
      for (const entry of rootEntries) {
        if (!entry.isFile() && !entry.isSymbolicLink()) continue
        if (
          (EXACT_COMPOSE_NAMES as readonly string[]).includes(entry.name) ||
          COMPOSE_VARIANT_RE.test(entry.name)
        ) {
          await tryAddFile(path.join(resolvedDir, entry.name))
        }
      }
    } catch {
      continue
    }

    for (const sub of INFRA_SUBDIRS) {
      if (found.length >= MAX_COMPOSE_FILES_PER_SCAN) break
      const subDir = path.join(resolvedDir, sub)
      for (const name of EXACT_COMPOSE_NAMES) {
        await tryAddFile(path.join(subDir, name))
      }
    }
  }

  return found
}

function readEnvFileSyncBounded(
  filePath: string,
  allowedRealRoots: readonly string[]
): ReadonlyMap<string, string> | null {
  let fd: number | undefined
  try {
    const realFile = fs.realpathSync(filePath)
    if (!isRealPathWithinRoots(realFile, allowedRealRoots)) {
      return null
    }
    const openFlags =
      fs.constants.O_RDONLY | (typeof fs.constants.O_NONBLOCK === 'number' ? fs.constants.O_NONBLOCK : 0)
    fd = fs.openSync(realFile, openFlags)
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX_COMPOSE_FILE_BYTES) return null
    const buf = Buffer.allocUnsafe(MAX_COMPOSE_FILE_BYTES + 1)
    let offset = 0
    for (;;) {
      const bytesRead = fs.readSync(fd, buf, offset, buf.length - offset, null)
      if (bytesRead === 0) break
      offset += bytesRead
      if (offset > MAX_COMPOSE_FILE_BYTES) return null
    }
    return loadEnvMapFromText(buf.subarray(0, offset).toString('utf8'))
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        // Ignore close error
      }
    }
  }
}

export async function detectWorkspaceDockerComposeConnections(
  workspaceDirs: readonly string[],
  options: ComposeDetectOptions = {}
): Promise<DiscoveredDockerComposeConnection[]> {
  const safeDirs = workspaceDirs
    .filter((d) => Boolean(d) && !isBlockedScanRoot(d))
    .map((d) => path.resolve(d))
  const realRoots: string[] = []
  for (const dir of safeDirs) {
    try {
      realRoots.push(await fs.promises.realpath(dir))
    } catch {
      realRoots.push(dir)
    }
  }

  const [rawContainers, composeFiles] = await Promise.all([
    options.liveContainersOverride
      ? Promise.resolve(options.liveContainersOverride)
      : listLiveDockerContainers(),
    collectComposeFilePaths(safeDirs, realRoots),
  ])

  let liveItems = parseDockerInspectContainers(rawContainers, safeDirs)
  if (options.onlyMatchedWorkspaces) {
    liveItems = liveItems.filter((item) => item.workspaceMatched)
  }

  const envCache = new Map<string, ReadonlyMap<string, string> | null>()
  const readEnvCached = (envPath: string): ReadonlyMap<string, string> | null => {
    const norm = normalizePathForCompare(envPath)
    if (!envCache.has(norm)) {
      envCache.set(norm, readEnvFileSyncBounded(envPath, realRoots))
    }
    return envCache.get(norm) ?? null
  }

  const staticItems: DiscoveredDockerComposeConnection[] = []
  for (const composeFile of composeFiles) {
    try {
      const content = (
        await readRegularFileBounded(composeFile, MAX_COMPOSE_FILE_BYTES, 'Docker Compose file')
      ).toString('utf8')
      const dir = path.dirname(composeFile)
      const baseEnv = new Map<string, string>()
      for (const envName of ['.env', '.env.local']) {
        const loaded = readEnvCached(path.join(dir, envName))
        if (loaded) loaded.forEach((v, k) => baseEnv.set(k, v))
      }
      const wsRoot = realRoots.find((s) => isSameOrParentDir(dir, [s]))
      if (wsRoot && dir !== wsRoot) {
        const rootEnv = readEnvCached(path.join(wsRoot, '.env'))
        if (rootEnv) rootEnv.forEach((v, k) => { if (!baseEnv.has(k)) baseEnv.set(k, v) })
      }
      const parsed = parseComposeFileContent(content, composeFile, baseEnv, true, readEnvCached)
      staticItems.push(...parsed)
    } catch {
      // Skip unreadable compose file
    }
  }

  return mergeDockerComposeDiscoveries(liveItems, staticItems)
}
