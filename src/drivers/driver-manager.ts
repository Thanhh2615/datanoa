// src/drivers/driver-manager.ts
// Local Custom Driver Path (BYOD) manager.
// Zero automatic network downloads: adapters load strictly from a user-supplied local path.

import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as moduleApi from 'node:module'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import * as vm from 'node:vm'
import type { JsonValue, OrcaWorkerApi } from 'orca/worker'
import { CUSTOM_DRIVERS_STORAGE_KEY } from '../shared-constants'
import {
  type DriverInspectResult,
  type DriverRegistryItem,
  type DriverVerifyResult,
  type PersistedLocalDriverConfig,
} from '../protocol'
import type { IDatabaseDriver } from './common/driver'
import { BUILTIN_ENGINE_CATALOG } from './common/engine-catalog'

export const BYOD_DRIVER_IDS = ['mssql', 'oracle', 'mongodb', 'custom'] as const
export type ByodDriverType = (typeof BYOD_DRIVER_IDS)[number]

export function isByodDriverId(value: unknown): value is ByodDriverType {
  return typeof value === 'string' && (BYOD_DRIVER_IDS as readonly string[]).includes(value)
}

export function getByodDefaultPort(driverId: string): number {
  switch (driverId) {
    case 'mssql':
      return 1433
    case 'oracle':
      return 1521
    case 'mongodb':
      return 27017
    default:
      return 5432
  }
}

export const BYOD_DRIVER_SLOTS: readonly {
  id: string
  name: string
  description: string
}[] = [
  {
    id: 'mssql',
    name: 'SQL Server (MSSQL — BYOD Local Driver)',
    description: 'Microsoft SQL Server via a locally installed Node driver adapter.',
  },
  {
    id: 'oracle',
    name: 'Oracle Database (Thin — BYOD Local Driver)',
    description: 'Oracle Database thin client via a locally installed Node driver adapter.',
  },
  {
    id: 'mongodb',
    name: 'MongoDB (BYOD Local Driver)',
    description: 'MongoDB document store via a locally installed Node driver adapter.',
  },
  {
    id: 'custom',
    name: 'Custom Adapter (BYOD Local Driver)',
    description: 'Any custom Datanoa driver adapter module on this machine.',
  },
]

const BUILTIN_IDS: ReadonlySet<string> = new Set(
  BUILTIN_ENGINE_CATALOG.map((engine) => engine.id)
)
const SLOT_IDS: ReadonlySet<string> = new Set(BYOD_DRIVER_SLOTS.map((slot) => slot.id))
const DRIVER_ID_RE = /^[a-z][a-z0-9_-]{1,63}$/i
const SHA256_HEX_RE = /^[a-f0-9]{64}$/
const VALID_ENTRY_EXTENSIONS: ReadonlySet<string> = new Set(['.mjs', '.cjs', '.js'])
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/
export const BYOD_TRUST_SCOPE_NOTE =
  'SHA-256 verifies the resolved entry file bytes only. Relative imports and node_modules inside the driver directory are loaded by Node once trusted.'

interface CachedAdapterEntry {
  adapter: IDatabaseDriver
  resolvedEntry: string
  sha256: string
}

function normalizeSha256(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  return SHA256_HEX_RE.test(normalized) ? normalized : null
}

function hasNonBuiltinEsmImport(source: string): boolean {
  if (/\b(?:require|createRequire)\s*\(/.test(source)) return true
  const importRe = /\b(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]/g
  let match: RegExpExecArray | null
  while ((match = importRe.exec(source)) !== null) {
    const spec = (match[1] ?? match[2] ?? '').trim()
    if (!spec.startsWith('node:')) return true
  }
  return false
}

function looksLikeEsmSyntax(source: string): boolean {
  return /(?:^|[\r\n;])\s*(?:import\s+(?:[\w*{]|['"])|export\s+(?:default\b|const\b|let\b|var\b|function\b|async\s+function\b|class\b|\{|\*))/.test(
    source
  )
}

async function isPackageTypeModule(entryPath: string): Promise<boolean> {
  let dir = path.dirname(entryPath)
  for (let depth = 0; depth < 8; depth++) {
    const pkgPath = path.join(dir, 'package.json')
    try {
      const raw = await fs.promises.readFile(pkgPath, 'utf8')
      const parsed = JSON.parse(raw) as unknown
      if (isRecord(parsed) && typeof parsed.type === 'string') {
        return parsed.type === 'module'
      }
      return false
    } catch {
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return false
}

type DriverManagerStorage = Pick<OrcaWorkerApi['storage'], 'get' | 'set' | 'delete'>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isDatabaseDriver(value: unknown): value is IDatabaseDriver {
  if (!isRecord(value)) return false
  if (typeof value.type !== 'string' || value.type.length === 0) return false
  if (typeof value.createSession !== 'function') return false
  if (typeof value.testConnection !== 'function') return false
  return true
}

function resolvePackageExportTarget(exportsField: unknown): string | undefined {
  if (typeof exportsField === 'string') return exportsField
  if (!isRecord(exportsField)) return undefined
  const dot = exportsField['.']
  if (typeof dot === 'string') return dot
  if (isRecord(dot)) {
    for (const key of ['import', 'default']) {
      const target = dot[key]
      if (typeof target === 'string') return target
    }
  }
  for (const key of ['import', 'default']) {
    const target = exportsField[key]
    if (typeof target === 'string') return target
  }
  return undefined
}

function normalizePersistedConfig(value: unknown): PersistedLocalDriverConfig | null {
  if (!isRecord(value)) return null
  const id = typeof value.id === 'string' ? value.id.trim().toLowerCase() : ''
  const localPath = typeof value.localPath === 'string' ? value.localPath.trim() : ''
  const resolvedEntry = typeof value.resolvedEntry === 'string' ? value.resolvedEntry.trim() : ''
  const sha256 = typeof value.sha256 === 'string' ? value.sha256.trim().toLowerCase() : ''
  const verifiedAt = Number(value.verifiedAt)
  const name = typeof value.name === 'string' ? value.name.trim() : undefined
  if (!DRIVER_ID_RE.test(id) || !localPath || !resolvedEntry) return null
  if (!/^[a-f0-9]{64}$/.test(sha256) || !Number.isFinite(verifiedAt)) return null
  return { id, localPath, resolvedEntry, sha256, verifiedAt, ...(name ? { name } : {}) }
}

export class DriverManager {
  private readonly storage: DriverManagerStorage
  private readonly log: (message: string) => void
  private readonly adapterCache = new Map<string, CachedAdapterEntry>()
  private readonly errors = new Map<string, string>()
  private writeChain: Promise<void> = Promise.resolve()
  private backupLoader: (() => Promise<PersistedLocalDriverConfig[] | null>) | null = null
  private attemptedBackupRestore = false

  constructor(storage: DriverManagerStorage, log: (message: string) => void) {
    this.storage = storage
    this.log = log
  }

  setBackupLoader(loader: () => Promise<PersistedLocalDriverConfig[] | null>): void {
    this.backupLoader = loader
    this.attemptedBackupRestore = false
  }

  private parseNormalizedConfigs(raw: unknown): PersistedLocalDriverConfig[] {
    if (!Array.isArray(raw)) return []
    const seen = new Set<string>()
    const out: PersistedLocalDriverConfig[] = []
    for (const item of raw) {
      const config = normalizePersistedConfig(item)
      if (!config || BUILTIN_IDS.has(config.id) || seen.has(config.id)) continue
      seen.add(config.id)
      out.push(config)
    }
    return out
  }

  private async readConfigsDirect(): Promise<PersistedLocalDriverConfig[]> {
    const latest = this.parseNormalizedConfigs(await this.storage.get(CUSTOM_DRIVERS_STORAGE_KEY))
    if (latest.length > 0 || !this.backupLoader || this.attemptedBackupRestore) {
      if (latest.length > 0) this.attemptedBackupRestore = true
      return latest
    }
    this.attemptedBackupRestore = true
    try {
      const fromBackup = this.parseNormalizedConfigs(await this.backupLoader())
      if (fromBackup.length > 0) {
        await this.writeConfigs(fromBackup)
        return fromBackup
      }
    } catch {
      // Best-effort backup restore
    }
    return latest
  }

  private async readConfigs(): Promise<PersistedLocalDriverConfig[]> {
    await this.writeChain
    const out = this.parseNormalizedConfigs(await this.storage.get(CUSTOM_DRIVERS_STORAGE_KEY))
    if (out.length === 0 && this.backupLoader && !this.attemptedBackupRestore) {
      return await this.runSerializedWrite(() => this.readConfigsDirect())
    }
    if (out.length > 0) this.attemptedBackupRestore = true
    return out
  }

  private async writeConfigs(configs: PersistedLocalDriverConfig[]): Promise<void> {
    const sorted = [...configs].sort((a, b) => a.id.localeCompare(b.id))
    await this.storage.set(
      CUSTOM_DRIVERS_STORAGE_KEY,
      sorted as unknown as JsonValue
    )
  }

  private async runSerializedWrite<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(task)
    this.writeChain = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  /**
   * Resolves a user-supplied local path to a loadable JavaScript entry file.
   * Directories resolve through package.json `main` (or index.mjs/index.js/index.cjs)
   * and may never escape their own directory.
   */
  async resolveEntryFile(localPath: string): Promise<string> {
    const raw = typeof localPath === 'string' ? localPath.trim() : ''
    if (!raw) throw new Error('Local driver path is required')
    if (CONTROL_CHARS_RE.test(raw)) {
      throw new Error('Local driver path must not contain control characters')
    }
    const absolute = path.resolve(raw)
    let stat: fs.Stats
    try {
      stat = await fs.promises.stat(absolute)
    } catch {
      throw new Error(`Local driver path does not exist: ${absolute}`)
    }

    if (stat.isFile()) {
      let realFile: string
      try {
        realFile = await fs.promises.realpath(absolute)
      } catch {
        throw new Error(`Local driver path does not exist: ${absolute}`)
      }
      this.assertEntryExtension(realFile)
      return realFile
    }
    if (!stat.isDirectory()) {
      throw new Error(`Local driver path is neither a file nor a directory: ${absolute}`)
    }

    const directory = absolute
    const realDirectory = await fs.promises.realpath(directory)
    let candidate: string | undefined
    const packageJsonPath = path.join(directory, 'package.json')
    if (await this.pathExists(packageJsonPath)) {
      let mainField: unknown
      let exportsField: unknown
      try {
        const parsed = JSON.parse(await fs.promises.readFile(packageJsonPath, 'utf8')) as unknown
        mainField = isRecord(parsed) ? parsed.main : undefined
        exportsField = isRecord(parsed) ? parsed.exports : undefined
      } catch (err) {
        throw new Error(
          `Cannot parse package.json in ${directory}: ${err instanceof Error ? err.message : String(err)}`
        )
      }
      const mainEntry =
        typeof mainField === 'string' && mainField.trim().length > 0
          ? mainField.trim()
          : resolvePackageExportTarget(exportsField)?.trim() || ''
      if (mainEntry) {
        if (CONTROL_CHARS_RE.test(mainEntry)) {
          throw new Error('package.json entry must not contain control characters')
        }
        if (path.isAbsolute(mainEntry) || /^[a-zA-Z]:[\\/]/.test(mainEntry)) {
          throw new Error('package.json entry must be a relative path inside the driver directory')
        }
        candidate = path.resolve(directory, mainEntry)
        if (mainEntry === 'index.js' && !(await this.pathExists(candidate))) {
          candidate = undefined
        }
      }
    }
    if (!candidate) {
      for (const name of ['index.mjs', 'index.js', 'index.cjs']) {
        const probe = path.join(directory, name)
        if (await this.pathExists(probe)) {
          candidate = probe
          break
        }
      }
    }

    if (!candidate) {
      throw new Error(
        `No driver entry found in ${directory}: add index.mjs/index.js/index.cjs or a package.json "main"/"exports"`
      )
    }
    const lexicalRelative = path.relative(directory, candidate)
    if (!lexicalRelative || lexicalRelative.startsWith('..') || path.isAbsolute(lexicalRelative)) {
      throw new Error('Resolved driver entry escapes the selected driver directory')
    }
    let realCandidate: string
    try {
      realCandidate = await fs.promises.realpath(candidate)
    } catch {
      throw new Error(`Resolved driver entry does not exist: ${candidate}`)
    }
    const relative = path.relative(realDirectory, realCandidate)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Resolved driver entry escapes the selected driver directory')
    }
    this.assertEntryExtension(realCandidate)
    return realCandidate
  }

  private assertEntryExtension(entryPath: string): void {
    const ext = path.extname(entryPath).toLowerCase()
    if (!VALID_ENTRY_EXTENSIONS.has(ext)) {
      throw new Error('Local driver entry must use a .mjs, .cjs, or .js extension')
    }
  }

  private async pathExists(target: string): Promise<boolean> {
    try {
      const stat = await fs.promises.stat(target)
      return stat.isFile()
    } catch {
      return false
    }
  }

  async computeFileSha256(filePath: string): Promise<string> {
    const content = await fs.promises.readFile(filePath)
    return createHash('sha256').update(content).digest('hex').toLowerCase()
  }

  private async readAndHashEntry(filePath: string): Promise<{ bytes: Buffer; sha256: string }> {
    const bytes = await fs.promises.readFile(filePath)
    const sha256 = createHash('sha256').update(bytes).digest('hex').toLowerCase()
    return { bytes, sha256 }
  }

  /**
   * Read-only inspection of a local driver path: resolves the entry file and
   * computes its SHA-256 fingerprint WITHOUT importing or executing any code.
   */
  async inspectLocalDriver(input: {
    driverId: string
    localPath: string
  }): Promise<DriverInspectResult> {
    const id = this.assertConfigurableId(input.driverId)
    const resolvedEntry = await this.resolveEntryFile(input.localPath)
    const { bytes, sha256 } = await this.readAndHashEntry(resolvedEntry)
    return {
      ok: true,
      driverId: id,
      localPath: path.resolve(input.localPath.trim()),
      resolvedEntry,
      sha256,
      byteLength: bytes.byteLength,
      scopeNote: BYOD_TRUST_SCOPE_NOTE,
    }
  }

  validateDriverAdapterModule(mod: unknown): IDatabaseDriver {
    const namespace = isRecord(mod) ? mod : {}
    for (const candidate of [namespace.default, namespace.driver]) {
      if (isDatabaseDriver(candidate)) return candidate
    }
    if (typeof namespace.createDriver === 'function') {
      const made: unknown = (namespace.createDriver as (...args: unknown[]) => unknown)()
      if (isDatabaseDriver(made)) return made
    }
    throw new Error(
      'Invalid Datanoa driver adapter: expected an object with string "type", function "createSession" and function "testConnection"'
    )
  }

  private async importVerifiedEntryBytes(
    entryPath: string,
    bytes: Buffer,
    expectedSha256: string
  ): Promise<unknown> {
    const ext = path.extname(entryPath).toLowerCase()
    const sourceText = bytes.toString('utf8')

    // CommonJS: .cjs, or .js outside "type":"module" without static ESM syntax
    const isCjs =
      ext === '.cjs' ||
      (ext === '.js' && !(await isPackageTypeModule(entryPath)) && !looksLikeEsmSyntax(sourceText))

    if (isCjs) {
      const cjsRequire = moduleApi.createRequire(entryPath)
      const moduleObj: { exports: Record<string, unknown> } = { exports: {} }
      const compiled = vm.compileFunction(
        sourceText,
        ['exports', 'require', 'module', '__filename', '__dirname'],
        { filename: entryPath }
      ) as (
        exports: Record<string, unknown>,
        req: NodeRequire,
        mod: { exports: Record<string, unknown> },
        filename: string,
        dirname: string
      ) => void
      compiled(moduleObj.exports, cjsRequire, moduleObj, entryPath, path.dirname(entryPath))
      return { default: moduleObj.exports, ...moduleObj.exports }
    }

    // Standalone ESM (no relative/package imports): import exact verified bytes via data: URL
    if (!hasNonBuiltinEsmImport(sourceText)) {
      const dataUrl = `data:text/javascript;base64,${bytes.toString('base64')}`
      return await import(dataUrl)
    }

    // ESM with local/package imports: serve verified in-memory bytes via Node registerHooks (zero entry TOCTOU)
    const pinnedUrl = `${pathToFileURL(entryPath).href}?v=${expectedSha256}`
    const registerHooksFn = (
      moduleApi as unknown as {
        registerHooks?: (hooks: {
          load: (
            url: string,
            context: Record<string, unknown>,
            nextLoad: (url: string, context: Record<string, unknown>) => unknown
          ) => unknown
        }) => { deregister: () => void }
      }
    ).registerHooks

    if (typeof registerHooksFn === 'function') {
      const hook = registerHooksFn({
        load(url, context, nextLoad) {
          if (url === pinnedUrl) {
            return { format: 'module', source: bytes, shortCircuit: true }
          }
          return nextLoad(url, context)
        },
      })
      try {
        return await import(pinnedUrl)
      } finally {
        hook.deregister()
      }
    }

    // Fallback when registerHooks is unavailable: verify digest immediately after import
    const mod: unknown = await import(pinnedUrl)
    const afterSha = await this.computeFileSha256(entryPath)
    if (afterSha !== expectedSha256) {
      throw new Error(
        `Local driver entry changed during load (expected ${expectedSha256.slice(0, 12)}..., observed ${afterSha.slice(0, 12)}...). Re-inspect and re-trust the driver.`
      )
    }
    return mod
  }

  private async loadAdapter(
    driverId: string,
    entryPath: string,
    expectedSha256: string,
    bypassCache = false
  ): Promise<IDatabaseDriver> {
    const normalizedExpected = normalizeSha256(expectedSha256)
    if (!normalizedExpected) {
      throw new Error(
        `Explicit SHA-256 trust confirmation is required before loading local driver "${driverId}".`
      )
    }

    const { bytes, sha256 } = await this.readAndHashEntry(entryPath)
    if (sha256 !== normalizedExpected) {
      this.adapterCache.delete(driverId)
      throw new Error(
        `Local driver "${driverId}" SHA-256 mismatch (expected ${normalizedExpected.slice(0, 12)}..., found ${sha256.slice(0, 12)}...). Re-inspect and explicitly trust the file before loading.`
      )
    }

    if (!bypassCache) {
      const cached = this.adapterCache.get(driverId)
      if (cached && cached.resolvedEntry === entryPath && cached.sha256 === sha256) {
        return cached.adapter
      }
    }

    const mod = await this.importVerifiedEntryBytes(entryPath, bytes, sha256)
    const adapter = this.validateDriverAdapterModule(mod)
    if (adapter.type !== driverId) {
      throw new Error(
        `Driver adapter type "${adapter.type}" does not match configured driver ID "${driverId}"`
      )
    }
    this.adapterCache.set(driverId, { adapter, resolvedEntry: entryPath, sha256 })
    return adapter
  }

  getAdapter(
    driverId: string,
    expected?: { resolvedEntry?: string; sha256?: string }
  ): IDatabaseDriver | undefined {
    const cached = this.adapterCache.get(driverId)
    if (!cached) return undefined
    if (expected?.resolvedEntry && cached.resolvedEntry !== expected.resolvedEntry) {
      return undefined
    }
    if (expected?.sha256 && cached.sha256 !== expected.sha256.trim().toLowerCase()) {
      return undefined
    }
    return cached.adapter
  }

  async resolveVerifiedAdapter(driverId: string): Promise<IDatabaseDriver> {
    const id = typeof driverId === 'string' ? driverId.trim().toLowerCase() : ''
    const configs = await this.readConfigs()
    const config = configs.find((entry) => entry.id === id)
    if (!config) {
      throw new Error(
        `Local BYOD driver "${id}" is not configured or verified yet. Open Connection settings, select this BYOD driver, inspect SHA-256 and click "Trust & Verify" first.`
      )
    }
    const resolvedEntry = await this.resolveEntryFile(config.localPath)
    if (resolvedEntry !== config.resolvedEntry) {
      this.adapterCache.delete(id)
      throw new Error(
        `Local driver "${id}" resolved entry path changed (${resolvedEntry}). Open Connection settings to re-inspect SHA-256 and re-trust.`
      )
    }
    return await this.loadAdapter(id, config.resolvedEntry, config.sha256, false)
  }

  async listDrivers(): Promise<DriverRegistryItem[]> {
    const configs = await this.readConfigs()
    const configById = new Map(configs.map((config) => [config.id, config]))
    const byodIds = new Set<string>([...SLOT_IDS, ...configs.map((config) => config.id)])
    const items: DriverRegistryItem[] = BUILTIN_ENGINE_CATALOG.map((engine) => ({
      id: engine.id,
      name: engine.label,
      description: `${engine.label} (${engine.transport}, ${engine.packaging})`,
      category: 'builtin',
      transport: engine.transport,
      packaging: engine.packaging,
      status: 'builtin',
    }))

    for (const id of byodIds) {
      const slot = BYOD_DRIVER_SLOTS.find((entry) => entry.id === id)
      const config = configById.get(id)
      const error = this.errors.get(id)
      items.push({
        id,
        name: config?.name || slot?.name || id,
        description:
          slot?.description || 'Locally configured Datanoa driver adapter (BYOD local path).',
        category: 'local-byod',
        transport: 'local-path',
        packaging: 'byod-local',
        status: config ? (error ? 'local-error' : 'local-verified') : 'not-configured',
        ...(config
          ? {
              localPath: config.localPath,
              resolvedEntry: config.resolvedEntry,
              sha256: config.sha256,
              verifiedAt: config.verifiedAt,
            }
          : {}),
        ...(error ? { error } : {}),
      })
    }

    return items
  }

  private assertConfigurableId(driverId: string): string {
    const id = typeof driverId === 'string' ? driverId.trim().toLowerCase() : ''
    if (!DRIVER_ID_RE.test(id)) {
      throw new Error(
        'Driver ID must start with a letter and contain only letters, digits, "-" or "_" (2-64 chars)'
      )
    }
    if (BUILTIN_IDS.has(id)) {
      throw new Error(`"${id}" is a built-in engine and cannot be configured as a local driver`)
    }
    return id
  }

  async configureLocalDriver(input: {
    driverId: string
    localPath: string
    name?: string
    trustedSha256?: string
  }): Promise<DriverRegistryItem> {
    const id = this.assertConfigurableId(input.driverId)
    const trustedSha = normalizeSha256(input.trustedSha256)
    if (!trustedSha) {
      throw new Error(
        `Explicit SHA-256 trust confirmation is required before loading local driver "${id}". Inspect the driver fingerprint first.`
      )
    }
    return await this.runSerializedWrite(async () => {
      const resolvedEntry = await this.resolveEntryFile(input.localPath)
      const sha256 = await this.computeFileSha256(resolvedEntry)
      if (sha256 !== trustedSha) {
        throw new Error(
          `Local driver "${id}" SHA-256 mismatch (expected ${trustedSha.slice(0, 12)}..., found ${sha256.slice(0, 12)}...). Re-inspect and confirm trust before loading.`
        )
      }
      await this.loadAdapter(id, resolvedEntry, trustedSha, true)

      const config: PersistedLocalDriverConfig = {
        id,
        localPath: path.resolve(input.localPath.trim()),
        resolvedEntry,
        sha256,
        verifiedAt: Date.now(),
        ...(input.name && input.name.trim() ? { name: input.name.trim().slice(0, 120) } : {}),
      }
      const configs = await this.readConfigsDirect()
      const next = configs.filter((entry) => entry.id !== id)
      next.push(config)
      await this.writeConfigs(next)
      this.errors.delete(id)
      this.log(`[DriverManager] Verified local driver "${id}" (${sha256.slice(0, 12)}...)`)

      const slot = BYOD_DRIVER_SLOTS.find((entry) => entry.id === id)
      return {
        id,
        name: config.name || slot?.name || id,
        description:
          slot?.description || 'Locally configured Datanoa driver adapter (BYOD local path).',
        category: 'local-byod',
        transport: 'local-path',
        packaging: 'byod-local',
        status: 'local-verified',
        localPath: config.localPath,
        resolvedEntry,
        sha256,
        verifiedAt: config.verifiedAt,
      }
    })
  }

  async verifyLocalDriver(
    driverId: string,
    options?: { trustedSha256?: string }
  ): Promise<DriverVerifyResult> {
    const id = typeof driverId === 'string' ? driverId.trim().toLowerCase() : ''
    return await this.runSerializedWrite(async () => {
      const slot = BYOD_DRIVER_SLOTS.find((entry) => entry.id === id)
      const configs = await this.readConfigsDirect()
      const config = configs.find((entry) => entry.id === id)
      const baseItem: DriverRegistryItem = {
        id,
        name: config?.name || slot?.name || id,
        description:
          slot?.description || 'Locally configured Datanoa driver adapter (BYOD local path).',
        category: 'local-byod',
        transport: 'local-path',
        packaging: 'byod-local',
        status: 'not-configured',
        ...(config
          ? {
              localPath: config.localPath,
              resolvedEntry: config.resolvedEntry,
              sha256: config.sha256,
              verifiedAt: config.verifiedAt,
            }
          : {}),
      }
      if (!config) {
        return {
          ok: false,
          sha256Changed: false,
          item: baseItem,
          message: `Local driver "${id}" is not configured`,
        }
      }

      try {
        const resolvedEntry = await this.resolveEntryFile(config.localPath)
        const currentSha = await this.computeFileSha256(resolvedEntry)
        const registeredSha = config.sha256.toLowerCase()
        const sha256Changed = currentSha !== registeredSha
        const entryChanged = resolvedEntry !== config.resolvedEntry
        const explicitRetrustSha = normalizeSha256(options?.trustedSha256)

        if ((sha256Changed || entryChanged) && explicitRetrustSha !== currentSha) {
          const reason = sha256Changed
            ? `SHA-256 changed (${currentSha.slice(0, 12)}...)`
            : `resolved entry path changed (${resolvedEntry})`
          const message = `Local driver "${id}" ${reason}. Explicit re-trust is required before loading.`
          this.adapterCache.delete(id)
          this.errors.set(id, message)
          return {
            ok: false,
            sha256Changed: sha256Changed || entryChanged,
            requiresTrust: true,
            pendingSha256: currentSha,
            item: { ...baseItem, status: 'local-error', resolvedEntry, error: message },
            message,
          }
        }

        await this.loadAdapter(id, resolvedEntry, currentSha, true)
        const verifiedAt = Date.now()
        const next = configs.map((entry) =>
          entry.id === id
            ? { ...entry, resolvedEntry, sha256: currentSha, verifiedAt }
            : entry
        )
        await this.writeConfigs(next)
        this.errors.delete(id)
        return {
          ok: true,
          sha256Changed,
          requiresTrust: false,
          item: {
            ...baseItem,
            status: 'local-verified',
            resolvedEntry,
            sha256: currentSha,
            verifiedAt,
          },
          message: sha256Changed
            ? `Local driver "${id}" re-trusted and verified with updated SHA-256.`
            : `Local driver "${id}" verified — SHA-256 matches the registered fingerprint.`,
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        this.errors.set(id, message)
        this.adapterCache.delete(id)
        return {
          ok: false,
          sha256Changed: false,
          item: { ...baseItem, status: 'local-error', error: message },
          message: `Local driver "${id}" failed verification: ${message}`,
        }
      }
    })
  }

  async removeLocalDriver(driverId: string): Promise<{ ok: boolean }> {
    const id = typeof driverId === 'string' ? driverId.trim().toLowerCase() : ''
    if (!id) return { ok: false }
    await this.runSerializedWrite(async () => {
      const configs = await this.readConfigsDirect()
      const next = configs.filter((entry) => entry.id !== id)
      if (next.length !== configs.length) {
        await this.writeConfigs(next)
      }
    })
    this.adapterCache.delete(id)
    this.errors.delete(id)
    return { ok: true }
  }
}
