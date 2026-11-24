import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fc from 'fast-check'
import { installDomHarness, type DomHarness } from './helpers/dom-harness.js'
import { parseConnectionUri } from '../src/drivers/common/connection-uri'
import { introspectSqliteTableDetails } from '../src/drivers/common/schema.js'
import type {
  ConnectionProfile,
  DatabaseDriverType,
  DriverRegistryItem,
  TableDetails,
} from '../src/protocol.js'
import {
  compactFilePath,
  openStudioConnectionModal,
  type StudioConnectionModalContext,
} from '../src/editor/connection-modal.js'
import { SchemaInspectorView } from '../src/editor/schema-inspector.js'

let dom: DomHarness

async function flushAsync(ticks = 6): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(1)
  }
}

function findButton(root: ParentNode, match: string | RegExp): HTMLButtonElement | undefined {
  const buttons = Array.from(root.querySelectorAll('button')) as HTMLButtonElement[]
  return buttons.find((b) => {
    const text = (b.textContent ?? '').trim()
    return typeof match === 'string' ? text === match || text.includes(match) : match.test(text)
  })
}

function findInputForLabel(root: ParentNode, labelMatch: string): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null {
  const labels = Array.from(root.querySelectorAll('label'))
  for (const label of labels) {
    if ((label.textContent ?? '').includes(labelMatch)) {
      const targetId = label.getAttribute('for')
      if (targetId) {
        const byId = document.getElementById(targetId)
        if (byId) return byId as HTMLInputElement
      }
      const inside = label.querySelector('input, select, textarea')
      if (inside) return inside as HTMLInputElement
    }
  }
  return null
}

function makeDriversList(): DriverRegistryItem[] {
  return [
    {
      id: 'postgres',
      name: 'PostgreSQL',
      category: 'built-in',
      packaging: 'bundled',
      transport: 'TCP / TLS',
      description: 'PostgreSQL',
      status: 'built-in',
    },
    {
      id: 'mysql',
      name: 'MySQL',
      category: 'built-in',
      packaging: 'bundled',
      transport: 'TCP / TLS',
      description: 'MySQL',
      status: 'built-in',
    },
    {
      id: 'mariadb',
      name: 'MariaDB',
      category: 'built-in',
      packaging: 'bundled',
      transport: 'TCP',
      description: 'MariaDB',
      status: 'built-in',
    },
    {
      id: 'sqlite',
      name: 'SQLite',
      category: 'built-in',
      packaging: 'built-in',
      transport: 'File',
      description: 'SQLite',
      status: 'built-in',
    },
    {
      id: 'mssql',
      name: 'SQL Server',
      category: 'built-in',
      packaging: 'bundled',
      transport: 'TDS',
      description: 'SQL Server',
      status: 'built-in',
    },
    {
      id: 'oracle',
      name: 'Oracle',
      category: 'built-in',
      packaging: 'bundled',
      transport: 'TCP',
      description: 'Oracle DB',
      status: 'built-in',
    },
    {
      id: 'mongodb',
      name: 'MongoDB',
      category: 'built-in',
      packaging: 'bundled',
      transport: 'TCP',
      description: 'MongoDB',
      status: 'built-in',
    },
    {
      id: 'redis',
      name: 'Redis',
      category: 'built-in',
      packaging: 'bundled',
      transport: 'RESP',
      description: 'Redis',
      status: 'built-in',
    },
    {
      id: 'libsql',
      name: 'LibSQL / Turso',
      category: 'built-in',
      packaging: 'bundled',
      transport: 'HTTPS',
      description: 'LibSQL',
      status: 'built-in',
    },
    {
      id: 'd1',
      name: 'Cloudflare D1',
      category: 'built-in',
      packaging: 'bundled',
      transport: 'HTTPS',
      description: 'Cloudflare D1',
      status: 'built-in',
    },
    {
      id: 'clickhouse',
      name: 'ClickHouse',
      category: 'built-in',
      packaging: 'bundled',
      transport: 'HTTP',
      description: 'ClickHouse',
      status: 'built-in',
    },
    {
      id: 'cockroachdb',
      name: 'CockroachDB',
      category: 'built-in',
      packaging: 'bundled',
      transport: 'TCP',
      description: 'CockroachDB',
      status: 'built-in',
    },
    {
      id: 'duckdb',
      name: 'DuckDB',
      category: 'local-byod',
      packaging: 'native',
      transport: 'File',
      description: 'DuckDB local engine',
      status: 'not-configured',
    },
    {
      id: 'snowflake',
      name: 'Snowflake',
      category: 'local-byod',
      packaging: 'npm',
      transport: 'HTTPS',
      description: 'Snowflake warehouse',
      status: 'local-verified',
      localPath: '/drivers/snowflake',
      resolvedEntry: '/drivers/snowflake/index.mjs',
      sha256: '0123456789abcdef0123456789abcdef01234567',
    },
    {
      id: 'bigquery',
      name: 'BigQuery',
      category: 'local-byod',
      packaging: 'npm',
      transport: 'HTTPS',
      description: 'BigQuery analytics',
      status: 'local-error',
      localPath: '/drivers/bigquery',
      error: 'Module load failed',
    },
    {
      id: 'cassandra',
      name: 'Cassandra',
      category: 'local-byod',
      packaging: 'npm',
      transport: 'CQL',
      description: 'Apache Cassandra',
      status: 'not-configured',
    },
  ]
}

beforeEach(() => {
  vi.useFakeTimers()
  dom = installDomHarness()
  const nav = (globalThis as { navigator?: { clipboard?: { writeText: (t: string) => Promise<void> } } }).navigator
  if (nav) {
    try {
      Object.defineProperty(nav, 'clipboard', {
        configurable: true,
        value: { writeText: vi.fn(async () => {}) },
      })
    } catch {
      // Ignore readonly navigator.clipboard
    }
  }
})

afterEach(() => {
  vi.useRealTimers()
  dom.teardown()
})

describe('Wave 3B Step 4: connection-modal.ts & schema-inspector.ts', () => {
  it('covers compactFilePath PBT & edge cases plus full openStudioConnectionModal flows', async () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 90 }),
        fc.integer({ min: 4, max: 64 }),
        (rawPath, maxLen) => {
          const out = compactFilePath(rawPath, maxLen)
          expect(typeof out).toBe('string')
          const raw = rawPath.trim()
          if (raw.length <= maxLen) {
            expect(out).toBe(raw)
          } else {
            expect(out).toContain('...')
            const parts = raw.split(/[\\/]/).filter(Boolean)
            if (parts.length <= 2) {
              expect(out.length).toBe(maxLen)
              expect(out.startsWith('...')).toBe(true)
            } else {
              expect(out.endsWith(parts[parts.length - 1])).toBe(true)
            }
          }
        }
      ),
      { numRuns: 60 }
    )
    expect(compactFilePath('', 20)).toBe('')
    expect(compactFilePath('short.db', 48)).toBe('short.db')
    const winCompacted = compactFilePath('C:\\Users\\Alice\\Documents\\Projects\\datanoa\\data\\very-long-name-database.sqlite', 32)
    expect(winCompacted).toContain('...')
    expect(winCompacted.endsWith('very-long-name-database.sqlite')).toBe(true)
    const unixCompacted = compactFilePath('/a/b/c/superlongfilenamewithoutfitsreallylong.db', 16)
    expect(unixCompacted).toBe('.../superlongfilenamewithoutfitsreallylong.db')
    expect(compactFilePath('abcdef/ghijklmnopqrstuvwxyz', 6)).toBe('...xyz')

    let backdropActive = true
    let mountedModal: HTMLElement | null = null
    let mountedFoot: HTMLElement | null = null
    let closeCalls = 0
    const statusLog: Array<{ msg: string; detail?: string }> = []
    const activatedIds: string[] = []
    const deletedIds: string[] = []
    let parseMode: 'ok' | 'fail-msg' | 'throw' = 'ok'
    let testMode: 'ok' | 'fail-msg' | 'throw' | 'slow' = 'fail-msg'
    let saveMode: 'ok' | 'fail-msg' | 'throw' = 'fail-msg'
    let deleteMode: 'fail-msg' | 'throw' | 'ok' = 'fail-msg'
    let detectMode: 'ok' | 'empty' | 'throw' = 'ok'
    let setupLocalMode: 'ok' | 'fail' | 'manual' = 'fail'
    let inspectLocalMode: 'ok' | 'fail' | 'enoent' = 'fail'
    let configureLocalMode: 'ok' | 'fail' = 'fail'
    let resolveSlowTest: ((v: { ok: boolean; message?: string }) => void) | null = null
    let fsFileName = 'analytics.sqlite3'

    const drivers = makeDriversList()

    const ctx: StudioConnectionModalContext = {
      isBackdropActive: () => backdropActive,
      mountModal: (el) => {
        mountedModal = el
        document.body.appendChild(el)
        const foot = document.createElement('div')
        foot.className = 'datanoa-modal-foot'
        mountedFoot = foot
        el.appendChild(foot)
        return foot as unknown as HTMLDivElement
      },
      closeModal: () => {
        closeCalls++
        mountedModal?.remove()
      },
      createElapsedTimer: (onTick) => {
        onTick('0.1s', 100)
        return () => {}
      },
      updateStatus: (msg, metrics) => {
        statusLog.push({ msg, detail: metrics })
      },
      activateSavedConnection: async (savedId) => {
        activatedIds.push(savedId)
      },
      onConnectionDeleted: async (deletedId) => {
        deletedIds.push(deletedId)
      },
      currentWorkspaceScope: 'ws:app',
      requestPlugin: vi.fn(async (method: string, payload?: unknown) => {
        const params = (payload ?? {}) as Record<string, unknown>
        if (method === 'drivers.list') return { drivers }
        if (method === 'drivers.defaultPaths') return { localDir: 'C:\\datanoa-drivers' }
        if (method === 'drivers.setupLocal') {
          if (setupLocalMode === 'fail') return { ok: false, error: 'npm unavailable' }
          const dirPath = String(params.localPath || 'C:\\datanoa-drivers\\duckdb')
          const inspect = {
            ok: true,
            driverId: String(params.driverId ?? 'duckdb'),
            sha256: 'feedface1234567890abcdef1234567890abcdef',
            resolvedEntry: `${dirPath}/index.mjs`,
            scopeNote: 'Verified SHA-256.',
          }
          if (setupLocalMode === 'manual') {
            return {
              ok: true,
              dirPath,
              inspect,
              installPackage: 'duckdb',
            }
          }
          return {
            ok: true,
            dirPath,
            inspect,
            item: {
              ...drivers.find((d) => d.id === String(params.driverId ?? 'duckdb'))!,
              status: 'local-verified',
              localPath: dirPath,
              resolvedEntry: `${dirPath}/index.mjs`,
              sha256: inspect.sha256,
            },
          }
        }
        if (method === 'drivers.inspectLocal') {
          if (inspectLocalMode === 'enoent') throw new Error('ENOENT: driver entry missing')
          if (inspectLocalMode === 'fail') throw new Error('Invalid directory')
          return {
            ok: true,
            driverId: String(params.driverId ?? 'duckdb'),
            sha256: 'cafebabe1234567890abcdef1234567890abcdef',
            resolvedEntry: `${String(params.localPath)}/index.mjs`,
            scopeNote: 'Verified SHA-256.',
          }
        }
        if (method === 'drivers.configureLocal') {
          if (configureLocalMode === 'fail') return { ok: false, error: 'Hash mismatch' }
          return {
            ok: true,
            item: {
              ...drivers.find((d) => d.id === String(params.driverId ?? 'duckdb'))!,
              status: 'local-verified',
              localPath: String(params.localPath),
              sha256: String(params.trustedSha256),
            },
          }
        }
        if (method === 'connections.list') {
          return [
            {
              id: 'existing_pg',
              name: 'Saved App DB',
              driver: 'postgres',
              host: 'localhost',
              port: 5432,
              database: 'app_db',
              username: 'postgres',
              folder: 'Production',
            },
            {
              id: 'existing_analytics',
              name: 'Analytics DB',
              driver: 'postgres',
              host: 'localhost',
              port: 5432,
              database: 'analytics',
              username: 'postgres',
              folder: 'Analytics',
            },
          ]
        }
        if (method === 'workspace.listScopes') {
          return {
            currentScopeId: 'ws1',
            currentScopeLabel: 'Workspace One',
            workspaces: [
              {
                id: 'ws1',
                name: 'Workspace One',
                branch: 'main',
                path: '/repo/app',
                label: 'Workspace One (main)',
                isCurrent: true,
              },
              {
                id: 'ws2',
                name: 'Workspace Two',
                branch: 'dev',
                path: '/repo/api',
                projectFolder: 'mono',
                label: 'Workspace Two (dev)',
                isCurrent: false,
              },
            ],
          }
        }
        if (method === 'workspace.detectConnections') {
          if (detectMode === 'throw') throw new Error('Docker daemon unreachable')
          if (detectMode === 'empty') {
            return {
              sqliteFiles: [],
              envConnections: [],
              dockerComposeConnections: [],
              scannedDirs: ['/repo/app'],
            }
          }
          return {
            sqliteFiles: [
              {
                name: 'Local Chinook',
                filePath: '/repo/app/data/chinook.sqlite',
                sizeBytes: 12288,
                sizeLabel: '12 KB',
              },
            ],
            envConnections: [
              {
                envKey: 'DATABASE_URL',
                sourceFile: '/repo/app/.env',
                driver: 'postgres',
                name: 'Saved App DB',
                uri: 'postgres://postgres:pw@localhost:5432/app_db',
              },
            ],
            dockerComposeConnections: [
              {
                service: 'postgres',
                sourceFile: '/repo/app/docker-compose.yml',
                driver: 'postgres',
                name: 'Compose Postgres',
                uri: 'postgres://app:pw@127.0.0.1:5432/compose_db',
                containerName: 'app-pg',
                running: true,
              },
              {
                service: 'redis',
                sourceFile: 'container:redis-other',
                driver: 'redis',
                name: 'Other Redis Container',
                uri: 'redis://127.0.0.1:6379/0',
                containerName: 'redis-other',
                running: true,
                inCurrentWorkspace: false,
              },
            ],
            scannedDirs: ['/repo/app'],
            folderScoped: false,
            dockerIsLocal: false,
            dockerScopeLabel: 'Other Local Docker',
          }
        }
        if (method === 'sqlite.scanFolder') {
          return {
            files: ['/repo/custom/alpha.db', '/repo/custom/beta.sqlite3'],
            notes: ['Found 2 SQLite files'],
          }
        }
        if (method === 'fs.listDir') {
          const cur = String(params.dir || '/repo/app')
          return {
            ok: true,
            currentDir: cur,
            parentDir: '/repo',
            roots: ['/repo/app'],
            entries: [
              { name: 'subdir', path: `${cur}/subdir`, kind: 'dir' },
              { name: fsFileName, path: `${cur}/${fsFileName}`, kind: 'file', size: 4096 },
              { name: '.sqlite', path: `${cur}/.sqlite`, kind: 'file', size: 1024 },
            ],
          }
        }
        if (method === 'connection.parseUri') {
          if (parseMode === 'throw') throw new Error('URI parser crashed')
          if (parseMode === 'fail-msg') return { ok: false, error: 'Unsupported scheme' }
          return parseConnectionUri(String(params.uri ?? ''))
        }
        if (method === 'connection.test') {
          if (testMode === 'slow') {
            return new Promise((res) => {
              resolveSlowTest = res
            })
          }
          if (testMode === 'throw') throw new Error('Network unreachable')
          if (testMode === 'fail-msg') return { ok: false, error: 'Invalid credentials' }
          return { ok: true, latencyMs: 7, message: 'Connected (7 ms)' }
        }
        if (method === 'connection.save') {
          if (saveMode === 'throw') throw new Error('Disk full')
          if (saveMode === 'fail-msg') return { ok: false, error: 'Duplicate profile name' }
          const prof = params.profile as ConnectionProfile
          return { ok: true, id: prof.id || 'conn_saved', profile: { ...prof, id: prof.id || 'conn_saved' } }
        }
        if (method === 'connection.delete') {
          if (deleteMode === 'throw') throw new Error('Delete locked')
          if (deleteMode === 'fail-msg') return { ok: false, error: 'Connection busy' }
          return { ok: true }
        }
        return {}
      }) as StudioConnectionModalContext['requestPlugin'],
    }

    openStudioConnectionModal(ctx)
    await flushAsync(8)
    expect(mountedModal).toBeTruthy()
    const modal = mountedModal!

    // 1. URI parsing error, throw, and valid hash-scrubbed URIs (including LibSQL & network URL)
    const uriInp = modal.querySelector('.datanoa-conn-uri-input') as HTMLInputElement
    const parseBtn = findButton(modal, 'Parse URI')!
    expect(parseBtn).toBeTruthy()
    parseMode = 'ok'
    uriInp.value = ''
    parseBtn.click()
    await flushAsync()
    uriInp.value = 'bad://url'
    parseMode = 'fail-msg'
    parseBtn.click()
    await flushAsync()
    parseMode = 'throw'
    parseBtn.click()
    await flushAsync()

    parseMode = 'ok'
    uriInp.value = 'libsql://app-org.turso.io/?authToken=secret_tok#frag=secret'
    uriInp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flushAsync()
    uriInp.value = 'https://user:pass@remote.example.com/libsql?jwt=abc#hashSecret=123'
    parseBtn.click()
    await flushAsync()
    uriInp.value = 'postgres://bob:pw@db.internal:5432/orders?sslmode=require'
    parseBtn.click()
    await flushAsync()

    // Click existing folder chip preset
    findButton(modal, 'Production')?.click()

    // 2. Quick Browse DB File -> file picker modal interaction -> handlePickLocalSqliteFile & deriveStudioSqliteName
    const browseDbBtn = findButton(modal, 'Browse DB File...')
    expect(browseDbBtn).toBeTruthy()
    browseDbBtn!.click()
    await flushAsync(8)
    let pickerOverlay = document.querySelector('.datanoa-fp-overlay')
    expect(pickerOverlay).toBeTruthy()
    if (pickerOverlay) {
      const fileRows = Array.from(pickerOverlay.querySelectorAll('.datanoa-fp-row'))
      const sqliteRow = fileRows.find((r) => (r.textContent ?? '').includes('analytics.sqlite3'))
      sqliteRow?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      findButton(pickerOverlay, 'Select file')?.click()
      await flushAsync(6)
    }
    // Second pick choosing hidden dotfile `.sqlite` covers parent/base fallback in deriveStudioSqliteName
    browseDbBtn!.click()
    await flushAsync(8)
    pickerOverlay = document.querySelector('.datanoa-fp-overlay')
    if (pickerOverlay) {
      const fileRows = Array.from(pickerOverlay.querySelectorAll('.datanoa-fp-row'))
      const dotRow = fileRows.find((r) => (r.textContent ?? '').trim() === '.sqlite')
      dotRow?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      findButton(pickerOverlay, 'Select file')?.click()
      await flushAsync(6)
    }

    // 3. Auto-Detect & Scan Folder workspace connections
    const detectBtn = findButton(modal, 'Auto-Detect')!
    const scanBtn = findButton(modal, 'Scan Folder')!
    expect(scanBtn).toBeTruthy()
    detectMode = 'throw'
    detectBtn.click()
    await flushAsync(6)
    detectMode = 'empty'
    detectBtn.click()
    await flushAsync(6)
    detectMode = 'ok'
    detectBtn.click()
    await flushAsync(6)
    const folderInp = modal.querySelector('input[aria-label="Folder path to scan"]') as HTMLInputElement | null
    if (folderInp) {
      folderInp.value = ''
      scanBtn.click()
      await flushAsync()
      folderInp.value = '/repo/custom'
      folderInp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await flushAsync(6)
    }

    // Click discovered items inside modal if buttons/items exist
    const discoveryButtons = Array.from(modal.querySelectorAll('button')).filter((b) =>
      /Compose Postgres|Other Redis|Local Chinook|alpha\.db|Use/i.test(b.textContent ?? '')
    )
    for (const btn of discoveryButtons) {
      btn.click()
      await flushAsync(4)
    }

    // Search/filter inputs inside discovery or driver bar
    for (const inp of Array.from(modal.querySelectorAll('input')) as HTMLInputElement[]) {
      const ph = (inp.placeholder ?? '').toLowerCase()
      if (ph.includes('filter') || ph.includes('search')) {
        inp.value = 'postgres'
        inp.dispatchEvent(new Event('input', { bubbles: true }))
        inp.value = ''
        inp.dispatchEvent(new Event('input', { bubbles: true }))
      }
    }

    // 4. Switch drivers & exercise driver-specific fields + BYOD inline card (duckdb, snowflake, bigquery, d1, mssql, oracle, mongodb, redis, postgres)
    const driverCards = Array.from(modal.querySelectorAll('.datanoa-engine-tile, [data-driver]'))
    for (const targetDriver of ['duckdb', 'snowflake', 'bigquery', 'cassandra', 'd1', 'libsql', 'mssql', 'oracle', 'mongodb', 'redis', 'sqlite', 'postgres']) {
      const card = driverCards.find(
        (el) => el.getAttribute('data-driver') === targetDriver
      ) as HTMLElement | undefined
      if (card) {
        card.click()
        await flushAsync(4)
      }
      if (targetDriver === 'duckdb') {
        const localPathInp = modal.querySelector('.datanoa-driver-mgr-byod input:not([readonly])') as HTMLInputElement | null
        const browseDirBtn = findButton(modal, 'Browse Folder...')
        browseDirBtn?.click()
        await flushAsync(6)
        const dirOverlay = document.querySelector('.datanoa-fp-overlay')
        if (dirOverlay) {
          findButton(dirOverlay, 'Select folder')?.click()
          await flushAsync(6)
        }
        findButton(modal, 'Copy Command')?.click()
        findButton(modal, 'Copy Starter index.mjs')?.click()

        if (localPathInp) {
          localPathInp.value = ''
          localPathInp.dispatchEvent(new Event('input', { bubbles: true }))
        }
        const inspectBtn = findButton(modal, 'Inspect SHA-256')
        inspectBtn?.click() // empty error
        await flushAsync()

        if (localPathInp) {
          localPathInp.value = '/drivers/duckdb'
          localPathInp.dispatchEvent(new Event('input', { bubbles: true }))
        }
        inspectLocalMode = 'fail'
        inspectBtn?.click()
        await flushAsync(4)
        inspectLocalMode = 'enoent'
        setupLocalMode = 'manual'
        inspectBtn?.click() // triggers setupLocal fallback
        await flushAsync(6)
        inspectLocalMode = 'ok'
        inspectBtn?.click()
        await flushAsync(4)

        const configBtn = findButton(modal, 'Trust & Verify')
        configureLocalMode = 'fail'
        configBtn?.click()
        await flushAsync(4)
        configureLocalMode = 'ok'
        configBtn?.click()
        await flushAsync(4)

        const setupBtn = findButton(modal, /Create Folder &/i)
        setupLocalMode = 'fail'
        setupBtn?.click()
        await flushAsync(4)
        setupLocalMode = 'manual'
        setupBtn?.click()
        await flushAsync(4)
        setupLocalMode = 'ok'
        setupBtn?.click()
        await flushAsync(4)
      }
      if (targetDriver === 'd1') {
        findButton(modal, /Test/i)?.click() // missing accountId & databaseId
        await flushAsync()
      }
      if (targetDriver === 'libsql') {
        const libInp = findInputForLabel(modal, 'LibSQL / Turso URL') as HTMLInputElement | null
        if (libInp) libInp.value = ''
        findButton(modal, /Test/i)?.click() // missing libsql URL
        await flushAsync()
      }
      if (targetDriver === 'sqlite') {
        const fpInp = modal.querySelector('input[placeholder*="database.db"]') as HTMLInputElement | null
        if (fpInp) fpInp.value = ''
        findButton(modal, /Test/i)?.click() // missing sqlite file path
        await flushAsync()
      }
    }

    // 5. Validation failures + SSH tunnel failSsh + Supabase / placeholder password guards + TLS toggles + Test + Save
    const nameInp = findInputForLabel(modal, 'Name') as HTMLInputElement | null
    const hostInp = findInputForLabel(modal, 'Host') as HTMLInputElement | null
    const portInp = findInputForLabel(modal, 'Port') as HTMLInputElement | null
    const dbInp = findInputForLabel(modal, 'Database') as HTMLInputElement | null
    const userInp = findInputForLabel(modal, 'Username') as HTMLInputElement | null
    const passInp = findInputForLabel(modal, 'Password') as HTMLInputElement | null

    const saveBtn = findButton(modal, 'Save & Connect')!
    const testBtn = findButton(modal, /Test/i)!
    expect(saveBtn).toBeTruthy()
    expect(testBtn).toBeTruthy()

    // Placeholder password check via URI containing [YOUR-PASSWORD]
    uriInp.value = 'postgres://postgres:[YOUR-PASSWORD]@db.proj.supabase.co:5432/postgres'
    parseBtn.click()
    await flushAsync()
    testBtn.click()
    await flushAsync()
    if (passInp) {
      passInp.value = ''
      passInp.dispatchEvent(new Event('input', { bubbles: true }))
    }
    // Supabase without password
    uriInp.value = 'postgres://postgres@db.proj.supabase.co:5432/postgres'
    parseBtn.click()
    await flushAsync()
    testBtn.click()
    await flushAsync()

    if (nameInp) nameInp.value = ''
    testBtn.click()
    await flushAsync()

    if (nameInp) nameInp.value = 'Prod PG'
    if (hostInp) hostInp.value = 'db.prod.local'
    if (portInp) portInp.value = '5432'
    if (dbInp) dbInp.value = 'prod'
    if (userInp) userInp.value = 'alice'
    if (passInp) passInp.value = 's3cret'

    // Expand SSH & TLS collapsibles and trigger all failSsh branches
    const sshHead = findButton(modal, /SSH Tunnel/i)
    const tlsHead = findButton(modal, /TLS \/ Custom/i)
    sshHead?.click()
    tlsHead?.click()
    const sshCheck = findInputForLabel(modal, 'Enable SSH Tunnel') as HTMLInputElement | null
    const sshHostInp = findInputForLabel(modal, 'Bastion Host') as HTMLInputElement | null
    const sshPortInp = findInputForLabel(modal, 'SSH Port') as HTMLInputElement | null
    const sshUserInp = findInputForLabel(modal, 'SSH Username') as HTMLInputElement | null
    const sshAuthSel = findInputForLabel(modal, 'Auth Method') as HTMLSelectElement | null
    const sshKeyInp = findInputForLabel(modal, 'Private Key Path') as HTMLInputElement | null

    if (sshCheck) {
      sshCheck.checked = true
      sshCheck.dispatchEvent(new Event('change', { bubbles: true }))
      if (sshHostInp) sshHostInp.value = '-oProxyCommand=id'
      if (sshUserInp) sshUserInp.value = 'ubuntu'
      testBtn.click() // injection blocked -> failSsh
      await flushAsync()
      if (sshHostInp) sshHostInp.value = ''
      testBtn.click() // missing host -> failSsh
      await flushAsync()
      if (sshHostInp) sshHostInp.value = 'bastion.example.com'
      if (sshUserInp) sshUserInp.value = ''
      testBtn.click() // missing user -> failSsh
      await flushAsync()
      if (sshUserInp) sshUserInp.value = 'ubuntu'
      if (sshPortInp) sshPortInp.value = '0'
      testBtn.click() // bad port -> failSsh
      await flushAsync()
      if (sshPortInp) sshPortInp.value = '22'
      if (sshAuthSel) {
        sshAuthSel.value = 'key'
        sshAuthSel.dispatchEvent(new Event('change', { bubbles: true }))
      }
      if (sshKeyInp) sshKeyInp.value = ''
      testBtn.click() // missing key -> failSsh
      await flushAsync()
      if (sshKeyInp) sshKeyInp.value = '~/.ssh/id_ed25519'
      sshCheck.checked = false
      sshCheck.dispatchEvent(new Event('change', { bubbles: true }))
    }

    // TLS mTLS controls & sync
    const sslModeSel = findInputForLabel(modal, 'SSL Mode') as HTMLSelectElement | null
    const sslCaInp = findInputForLabel(modal, 'CA Certificate Path') as HTMLInputElement | null
    if (sslModeSel) {
      sslModeSel.value = 'verify-full'
      sslModeSel.dispatchEvent(new Event('change', { bubbles: true }))
    }
    if (sslCaInp) {
      sslCaInp.value = '/certs/ca.pem'
      sslCaInp.dispatchEvent(new Event('input', { bubbles: true }))
    }

    // Clear button (clearModalFields)
    const clearBtn = findButton(modal, /Clear/i)
    clearBtn?.click()
    await flushAsync()
    // Re-populate required fields after clear
    if (nameInp) nameInp.value = 'Prod PG'
    if (hostInp) hostInp.value = 'db.prod.local'
    if (portInp) portInp.value = '5432'
    if (dbInp) dbInp.value = 'prod'

    // runTest: slow (blocks collapsible click while isBusy) -> throw -> fail -> ok
    testMode = 'slow'
    testBtn.click()
    await flushAsync(2)
    tlsHead?.click() // blocked because isBusy === true
    resolveSlowTest?.({ ok: true, message: 'Slow ok' })
    await flushAsync(4)

    testMode = 'throw'
    testBtn.click()
    await flushAsync()
    testMode = 'fail-msg'
    testBtn.click()
    await flushAsync()
    testMode = 'ok'
    testBtn.click()
    await flushAsync()

    // runSave: fail-msg -> throw -> ok
    saveMode = 'fail-msg'
    saveBtn.click()
    await flushAsync()
    saveMode = 'throw'
    saveBtn.click()
    await flushAsync()
    saveMode = 'ok'
    saveBtn.click()
    await flushAsync(6)
    expect(activatedIds.length).toBeGreaterThanOrEqual(1)
    expect(closeCalls).toBeGreaterThanOrEqual(1)

    // 6. Edit mode: pre-populated TLS/SSH/secret flags + orphan workspaceScope + Delete arm -> timeout disarm -> confirm error -> success
    openStudioConnectionModal(ctx, {
      id: 'conn_edit_1',
      name: 'Edit Bastion PG',
      driver: 'postgres',
      host: 'db.internal',
      port: 5432,
      database: 'app',
      user: 'appuser',
      hasPassword: true,
      ssl: true,
      sslMode: 'verify-ca',
      sslRejectUnauthorized: true,
      sslCaPath: '/etc/ssl/ca.pem',
      hasSslKeyPassphrase: true,
      workspaceScope: 'ws_orphan_saved',
      sshEnabled: true,
      sshHost: 'bastion.internal',
      sshPort: 2222,
      sshUser: 'ops',
      sshAuthMethod: 'key',
      sshPrivateKeyPath: '~/.ssh/ops_ed25519',
      hasSshPassphrase: true,
    })
    await flushAsync(8)
    const editModal = mountedModal!
    const deleteBtn = findButton(editModal, /Delete/i)!
    expect(deleteBtn).toBeTruthy()
    // First click arms
    deleteBtn.click()
    await flushAsync()
    // 4s timer disarms delete
    await vi.advanceTimersByTimeAsync(4100)
    await flushAsync()
    // Re-arm and confirm: fail-msg -> throw -> ok
    deleteBtn.click()
    deleteMode = 'fail-msg'
    deleteBtn.click()
    await flushAsync()
    deleteBtn.click()
    deleteMode = 'throw'
    deleteBtn.click()
    await flushAsync()
    deleteBtn.click()
    deleteMode = 'ok'
    deleteBtn.click()
    await flushAsync(6)
    expect(deletedIds).toEqual(['conn_edit_1'])

    // 7. Oracle edit URL scrubbing + Cancel button path
    openStudioConnectionModal(ctx, {
      id: 'conn_ora',
      name: 'Oracle Edit',
      driver: 'oracle',
      host: 'ora.internal',
      port: 1521,
      database: 'ORCL',
      url: 'https://ora-user:secret@ora.internal:1521/ORCL?password=pw',
    })
    await flushAsync(6)
    findButton(mountedModal!, 'Cancel')?.click()
    await flushAsync(2)

    backdropActive = false
    expect(mountedFoot).toBeTruthy()
  })

  it('covers SchemaInspectorView across live SQLite DatabaseSync introspection, edits, rebuild guard, readOnly, and dialect matrix', async () => {
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        created_at TEXT DEFAULT 'now'
      );
      CREATE TABLE orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending',
        total REAL
      );
      CREATE INDEX idx_orders_status ON orders(status);
    `)
    const execSqlite = async (sql: string) => sqlite.prepare(sql).all() as Record<string, unknown>[]
    const liveOrdersDetails = await introspectSqliteTableDetails(execSqlite, 'orders', 'main')
    const liveUsersDetails = await introspectSqliteTableDetails(execSqlite, 'users', 'main')

    const container = document.createElement('div')
    document.body.appendChild(container)

    let manualTx = false
    const insertedDdl: string[] = []
    const copiedDdl: string[] = []
    const openedInConsole: Array<{ ddl: string; title: string }> = []
    let applyMode: 'reject' | 'resolve' = 'reject'
    let dropCalls = 0
    let truncateCalls = 0

    const inspector = new SchemaInspectorView(container, {
      dialect: 'sqlite',
      readOnly: false,
      referenceTables: ['users', 'orders'],
      isManualTxActive: () => manualTx,
      onInsertDdl: (ddl) => insertedDdl.push(ddl),
      onCopyDdl: (ddl) => copiedDdl.push(ddl),
      onOpenDdlInConsole: (ddl) => openedInConsole.push({ ddl, title: 'v_orders' }),
      onApplyMigration: async () => {
        if (applyMode === 'reject') throw new Error('Constraint check failed')
      },
      onDropTable: async () => {
        dropCalls++
      },
      onTruncateTable: async () => {
        truncateCalls++
      },
    })

    // 1. Empty -> Loading -> Error & Retry -> Clear
    inspector.render()
    inspector.setLoading(true, 'orders')
    const retrySpy = vi.fn()
    inspector.setError('Failed to introspect orders', retrySpy)
    const retryBtn = container.querySelector('.datanoa-error-retry-btn') as HTMLButtonElement | null
    retryBtn?.click()
    expect(retrySpy).toHaveBeenCalledTimes(1)
    inspector.clear()

    // 2. Read-only non-table object DDL (view) + copy timer reset + open in console + scroll dismiss
    inspector.setReadOnlyObjectDdl(
      { name: 'v_orders', schema: 'main', kind: 'view', detail: 'main' },
      'CREATE VIEW v_orders AS SELECT id, status FROM orders;',
      'sqlite'
    )
    expect(container.querySelector('.datanoa-ddl-pre')?.textContent).toContain('CREATE VIEW v_orders')
    ;(container.querySelector('.datanoa-copy-ddl-btn') as HTMLButtonElement | null)?.click()
    await vi.advanceTimersByTimeAsync(1500)
    ;(container.querySelector('.datanoa-open-ddl-console-btn') as HTMLButtonElement | null)?.click()
    expect(copiedDdl.length).toBeGreaterThanOrEqual(1)
    expect(openedInConsole.length).toBeGreaterThanOrEqual(1)
    container.querySelector('.datanoa-inspector-scroll-body')?.dispatchEvent(new Event('scroll'))

    // 3. Load live introspected SQLite TableDetails
    inspector.setReferenceTables(['users', 'orders', 'profiles'])
    inspector.setDetails(liveOrdersDetails, 'sqlite')
    expect(inspector.getStagedChangeCount()).toBe(0)

    // Horizontal wheel & scroll binding on column scrollWrap & ddlPre
    const colScrollWrap = container.querySelector('.datanoa-struct-columns-table')?.parentElement as HTMLElement | null
    const ddlPre = container.querySelector('.datanoa-ddl-pre') as HTMLElement | null
    for (const scroller of [colScrollWrap, ddlPre]) {
      if (!scroller) continue
      Object.defineProperty(scroller, 'scrollWidth', { configurable: true, value: 800 })
      Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 300 })
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 0, deltaX: 0, ctrlKey: true, bubbles: true, cancelable: true }))
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 40, deltaX: 0, deltaMode: 0, ctrlKey: true, bubbles: true, cancelable: true }))
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 0, deltaX: 2, deltaMode: 1, metaKey: true, bubbles: true, cancelable: true }))
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 1, deltaX: 0, deltaMode: 2, ctrlKey: true, bubbles: true, cancelable: true }))
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 40, deltaX: 0, ctrlKey: false, bubbles: true, cancelable: true }))
      scroller.dispatchEvent(new Event('scroll'))
    }

    // Table name rename
    const tblNameInp = container.querySelector('.datanoa-edit-table-name-input') as HTMLInputElement
    tblNameInp.value = 'customer_orders'
    tblNameInp.dispatchEvent(new Event('input', { bubbles: true }))

    // Rename existing 'status' column -> updates index column pill ref!
    const colNameInputs = Array.from(container.querySelectorAll('.datanoa-col-name-input')) as HTMLInputElement[]
    const statusInp = colNameInputs.find((el) => el.value === 'status')!
    statusInp.value = 'order_status'
    statusInp.dispatchEvent(new Event('input', { bubbles: true }))

    // Combobox popover interaction on column type
    const comboToggle = container.querySelector('.datanoa-combo-toggle') as HTMLButtonElement | null
    comboToggle?.click()
    const typeInp = container.querySelector('.datanoa-col-type-input') as HTMLInputElement | null
    if (typeInp) {
      typeInp.focus()
      typeInp.value = 'TEXT'
      typeInp.dispatchEvent(new Event('input', { bubbles: true }))
      typeInp.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      typeInp.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
      typeInp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      // Open again and click item or press Escape / outside click
      comboToggle?.click()
      const firstItem = document.querySelector('.datanoa-combo-popover .datanoa-combo-item') as HTMLElement | null
      firstItem?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      comboToggle?.click()
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      comboToggle?.click()
      typeInp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    }

    // Default input & clear default + PK & Nullable checkboxes
    const defInp = container.querySelector('.datanoa-col-default-input') as HTMLInputElement | null
    if (defInp) {
      defInp.value = "'draft'"
      defInp.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const clearDefBtn = container.querySelector('.datanoa-clear-default-btn') as HTMLButtonElement | null
    clearDefBtn?.click()
    const pkCbs = Array.from(container.querySelectorAll('.datanoa-col-pk-checkbox')) as HTMLInputElement[]
    if (pkCbs[1]) {
      pkCbs[1].checked = !pkCbs[1].checked
      pkCbs[1].dispatchEvent(new Event('change', { bubbles: true }))
      pkCbs[1].checked = !pkCbs[1].checked
      pkCbs[1].dispatchEvent(new Event('change', { bubbles: true }))
    }
    const nullableCb = container.querySelector('.datanoa-col-nullable-checkbox') as HTMLInputElement | null
    if (nullableCb) {
      nullableCb.checked = !nullableCb.checked
      nullableCb.dispatchEvent(new Event('change', { bubbles: true }))
    }

    // Add column -> drop newly added column -> add another real column
    ;(container.querySelector('.datanoa-add-col-btn') as HTMLButtonElement).click()
    const dropColBtns = Array.from(container.querySelectorAll('.datanoa-col-drop-btn')) as HTMLButtonElement[]
    dropColBtns[dropColBtns.length - 1]?.click() // drops brand new column immediately
    ;(container.querySelector('.datanoa-add-col-btn') as HTMLButtonElement).click()
    const newColInputs = Array.from(container.querySelectorAll('.datanoa-col-name-input')) as HTMLInputElement[]
    const lastColInp = newColInputs[newColInputs.length - 1]
    lastColInp.value = 'notes'
    lastColInp.dispatchEvent(new Event('input', { bubbles: true }))

    // Add FK & edit target fields & drop/undo FK
    ;(container.querySelector('.datanoa-add-fk-btn') as HTMLButtonElement).click()
    const fkNameInputs = Array.from(container.querySelectorAll('.datanoa-fk-name-input')) as HTMLInputElement[]
    const lastFkName = fkNameInputs[fkNameInputs.length - 1]
    if (lastFkName) {
      lastFkName.value = 'fk_orders_ref'
      lastFkName.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const fkColSelects = Array.from(container.querySelectorAll('.datanoa-fk-col-select')) as HTMLSelectElement[]
    const lastFkCol = fkColSelects[fkColSelects.length - 1]
    if (lastFkCol && lastFkCol.options.length > 0) {
      lastFkCol.value = lastFkCol.options[0].value
      lastFkCol.dispatchEvent(new Event('change', { bubbles: true }))
    }
    const fkTargetTables = Array.from(container.querySelectorAll('.datanoa-fk-target-table-input')) as HTMLInputElement[]
    const lastFkTable = fkTargetTables[fkTargetTables.length - 1]
    if (lastFkTable) {
      lastFkTable.value = 'users'
      lastFkTable.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const fkTargetCols = Array.from(container.querySelectorAll('.datanoa-fk-target-col-input')) as HTMLInputElement[]
    const lastFkTargetCol = fkTargetCols[fkTargetCols.length - 1]
    if (lastFkTargetCol) {
      lastFkTargetCol.value = 'id'
      lastFkTargetCol.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const fkOnDelete = Array.from(container.querySelectorAll('.datanoa-fk-ondelete-select')) as HTMLSelectElement[]
    if (fkOnDelete[0]) {
      fkOnDelete[0].value = 'SET NULL'
      fkOnDelete[0].dispatchEvent(new Event('change', { bubbles: true }))
    }

    // Add Index & toggle column pill & change uniqueness
    ;(container.querySelector('.datanoa-add-idx-btn') as HTMLButtonElement).click()
    const idxNames = Array.from(container.querySelectorAll('.datanoa-idx-name-input')) as HTMLInputElement[]
    const lastIdxName = idxNames[idxNames.length - 1]
    if (lastIdxName) {
      lastIdxName.value = 'idx_orders_notes'
      lastIdxName.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const pills = Array.from(container.querySelectorAll('.datanoa-col-pill')) as HTMLButtonElement[]
    pills[pills.length - 1]?.click()
    const uniqSelects = Array.from(container.querySelectorAll('.datanoa-idx-unique-select')) as HTMLSelectElement[]
    if (uniqSelects[uniqSelects.length - 1]) {
      uniqSelects[uniqSelects.length - 1].value = 'true'
      uniqSelects[uniqSelects.length - 1].dispatchEvent(new Event('change', { bubbles: true }))
    }
    // Drop/undo existing index + remove newly added index -> re-add
    const idxDropBtns = Array.from(container.querySelectorAll('.datanoa-idx-drop-btn')) as HTMLButtonElement[]
    const nonPkIdxDrop = idxDropBtns.find((b) => !b.disabled)
    nonPkIdxDrop?.click()
    ;(container.querySelector('.datanoa-idx-drop-btn:not(:disabled)') as HTMLButtonElement | null)?.click()
    ;(container.querySelector('.datanoa-add-idx-btn') as HTMLButtonElement | null)?.click()
    const removeButtons = Array.from(container.querySelectorAll('button')).filter(
      (b) => b.textContent === 'Remove'
    ) as HTMLButtonElement[]
    removeButtons[removeButtons.length - 1]?.click()

    expect(inspector.getStagedChangeCount()).toBeGreaterThan(0)
    ;(container.querySelector('.datanoa-struct-preview-btn') as HTMLButtonElement | null)?.click()
    const previewDrawer = container.querySelector('.datanoa-struct-preview-drawer') as HTMLElement | null
    if (previewDrawer) {
      findButton(previewDrawer, 'Copy SQL')?.click()
      await vi.advanceTimersByTimeAsync(1300)
      findButton(previewDrawer, 'Open in Console')?.click()
      findButton(previewDrawer, 'Close')?.click()
      ;(container.querySelector('.datanoa-struct-preview-btn') as HTMLButtonElement | null)?.click()
      ;(container.querySelector('.datanoa-struct-preview-apply-btn') as HTMLButtonElement | null)?.click()
      expect(inspector.isConfirmModalOpen()).toBe(true)
      const confirmModal = document.querySelector('.datanoa-struct-confirm-modal')
      if (confirmModal) {
        findButton(confirmModal, 'Copy SQL')?.click()
        await vi.advanceTimersByTimeAsync(1300)
        // Backdrop click dismisses confirm modal
        const backdrop = confirmModal.parentElement
        backdrop?.dispatchEvent(new MouseEvent('click', { bubbles: false }))
      }
      expect(inspector.isConfirmModalOpen()).toBe(false)
    }
    expect(insertedDdl.length).toBeGreaterThanOrEqual(1)

    // Manual TX blocks SQLite rebuild + Escape key closes confirm modal via onModalKeyDown
    manualTx = true
    inspector.applyStagedChanges()
    await flushAsync(4)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(inspector.isConfirmModalOpen()).toBe(false)
    inspector.applyStagedChanges()
    await flushAsync(4)
    const confirmCancelBtn = document.querySelector('.datanoa-struct-confirm-cancel-btn') as HTMLButtonElement | null
    confirmCancelBtn?.click()
    manualTx = false

    // Apply staged changes: confirm modal open -> closeConfirmModalIfIdle -> execute fail with interval timer -> succeed
    inspector.applyStagedChanges()
    expect(inspector.isConfirmModalOpen()).toBe(true)
    expect(inspector.closeConfirmModalIfIdle()).toBe(true)
    expect(inspector.isConfirmModalOpen()).toBe(false)

    inspector.applyStagedChanges()
    applyMode = 'reject'
    ;(document.querySelector('.datanoa-struct-confirm-execute-btn') as HTMLButtonElement).click()
    await vi.advanceTimersByTimeAsync(1100)
    await flushAsync(4)
    expect(inspector.isMigrationInFlight()).toBe(false)

    applyMode = 'resolve'
    ;(document.querySelector('.datanoa-struct-confirm-execute-btn') as HTMLButtonElement).click()
    await vi.advanceTimersByTimeAsync(250)
    await flushAsync(4)

    // Revert, Truncate, and Drop table flows (buttons directly invoke onTruncateTable / onDropTable)
    const tblNameAfterApply = container.querySelector('.datanoa-edit-table-name-input') as HTMLInputElement
    tblNameAfterApply.value = 'temp_rename'
    tblNameAfterApply.dispatchEvent(new Event('input', { bubbles: true }))
    ;(container.querySelector('.datanoa-struct-revert-btn') as HTMLButtonElement | null)?.click()
    expect(inspector.getStagedChangeCount()).toBe(0)
    ;(container.querySelector('.datanoa-struct-truncate-btn') as HTMLButtonElement | null)?.click()
    ;(container.querySelector('.datanoa-struct-drop-btn') as HTMLButtonElement | null)?.click()
    expect(truncateCalls).toBe(1)
    expect(dropCalls).toBe(1)

    // 4. Switch dialects & test readOnly toggle & NoSQL (mongodb, redis)
    const genericTable: TableDetails = {
      name: 'accounts',
      schema: 'public',
      columns: [
        { name: 'id', type: 'bigint', nullable: false, isPrimaryKey: true, isAutoIncrement: true },
        { name: 'title', type: 'varchar(120)', nullable: false, defaultValue: "'n/a'" },
      ],
      foreignKeys: [
        { name: 'fk_org', column: 'id', referencedSchema: 'public', referencedTable: 'orgs', referencedColumn: 'id' },
      ],
      indexes: [{ name: 'idx_title', columns: ['title'], unique: false }],
      ddl: 'CREATE TABLE "public"."accounts" ("id" bigint PRIMARY KEY);',
    }
    for (const d of ['postgres', 'mysql', 'mssql', 'oracle', 'clickhouse'] as DatabaseDriverType[]) {
      inspector.setDialect(d)
      inspector.setDetails(genericTable, d)
    }
    inspector.setDialect('mongodb')
    inspector.setDetails(genericTable, 'mongodb')
    ;(container.querySelector('.datanoa-struct-drop-btn') as HTMLButtonElement | null)?.click()
    expect(dropCalls).toBe(2)

    inspector.setDialect('redis')
    inspector.setDetails(genericTable, 'redis')
    expect(container.querySelector('.datanoa-struct-drop-btn')).toBeNull()

    inspector.setReadOnly(true)
    inspector.setDialect('postgres')
    inspector.setDetails(genericTable, 'postgres')
    inspector.setReadOnly(false)
    inspector.setReadOnly(false)

    expect(liveUsersDetails.columns.length).toBeGreaterThan(0)
    inspector.destroy()
    sqlite.close()
  })
})
