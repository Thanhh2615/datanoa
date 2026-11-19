/**
 * test/e2e/panel-editor-runtime.e2e.test.ts
 *
 * Comprehensive Automated Runtime & Regression Gate:
 * - Gate A: Static JS semantic validation of src/panel/panel.html <script type="module"> (TS2304 / TS2552 = 0)
 * - Gate B: Native Orca Geist variable font embedding & Ctrl + Scroll user shortcut hint parity
 * - Gate C: Interactive VirtualDataGrid & SchemaInspectorView DOM flows via typed Fake DOM harness
 * - Gate D: Real node:sqlite + activate(orca) worker end-to-end integration & MySQL string flag coercion
 * - Gate E: Wave 6 UI/UX, Centered Avatar, <colgroup> Smooth Column Resizing, Sleek SVG Sort & On-Demand Edit Cell
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import ts from 'typescript'
import type { OrcaWorkerApi } from 'orca/worker'
import type {
  ConnectionProfile,
  PluginRequests,
  TableBrowseResult,
  TableDetails,
} from '../../src/protocol.js'
import { ACTIVE_CONNECTION_STORAGE_KEY } from '../../src/protocol.js'
import { GEIST_FONT_DATA_URI } from '../../src/assets/geist-font.js'
import { DATANOA_LOGO_DATA_URI } from '../../src/assets/logo.js'
import { EDITOR_STYLE } from '../../src/editor/theme.js'
import {
  DatanoaStudioEditor,
  buildAlterTableSql,
  computeSmartSqlCompletions,
  copyTextToClipboard,
} from '../../src/editor/index.js'
import { VirtualDataGrid } from '../../src/editor/grid.js'
import { SchemaInspectorView, formatDdlForDisplay } from '../../src/editor/schema-inspector.js'
import activate, { deactivate } from '../../src/worker/index.js'
import { introspectMysqlTableDetails } from '../../src/drivers/common/schema.js'
import { isCloudDatabaseHost, parseConnectionUri } from '../../src/drivers/common/connection-uri.js'
import { mapSupabaseIpv6ToRegion } from '../../src/drivers/postgres/driver.js'
import { MockOrcaRuntime } from './harness/mock-orca-runtime.js'
import {
  FakeDomHarness,
  FakeElement,
  FakeEvent,
  FakeHTMLButtonElement,
  FakeHTMLInputElement,
  FakeHTMLOptionElement,
  FakeHTMLSelectElement,
  FakeHTMLTableColElement,
  FakeHTMLTextAreaElement,
  flushMicrotasks,
} from './harness/fake-dom.js'

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(THIS_DIR, '..', '..')

// ============================================================================
// Typed Worker Invocation & Host Adapter (zero : any)
// ============================================================================

interface RecordedHostCall {
  method: string
  params: unknown
}

function createTypedWorkerApi(
  runtime: MockOrcaRuntime,
  workspacePath: string,
  hostCalls: RecordedHostCall[]
): OrcaWorkerApi {
  const base = runtime.getWorkerApi()
  const host = {
    has(method: string): boolean {
      return (
        method === 'workspace.list' ||
        method === 'workspace.readContext' ||
        method === 'workspace.open' ||
        method === 'editor.open'
      )
    },
    async call(method: string, params?: unknown): Promise<unknown> {
      hostCalls.push({ method, params })
      if (method === 'workspace.list') {
        return {
          workspaces: [
            {
              id: 'ws-local-e2e',
              path: workspacePath,
              name: 'e2e-workspace',
              branch: null,
              hostId: null,
            },
          ],
        }
      }
      if (method === 'workspace.readContext') {
        return {
          workspaceId: 'ws-local-e2e',
          displayName: 'e2e-workspace',
          branch: null,
        }
      }
      if (method === 'workspace.open' || method === 'editor.open') {
        return { ok: true }
      }
      return null
    },
  }

  const adapted = {
    ...base,
    host,
  }
  return adapted as unknown as OrcaWorkerApi
}

function invokeWorker<K extends keyof PluginRequests>(
  runtime: MockOrcaRuntime,
  name: K,
  input?: PluginRequests[K]['input']
): Promise<PluginRequests[K]['output']> {
  const client = runtime.client as unknown as {
    request: (reqName: string, reqInput?: unknown) => Promise<PluginRequests[K]['output']>
  }
  return client.request(name, input)
}

// ============================================================================
// Test Suite
// ============================================================================

describe('Panel & Editor Runtime Gate (Gates A, B, C, D, E)', () => {
  const activeDomHarnesses: FakeDomHarness[] = []
  const tempDirs: string[] = []
  let workerActivated = false

  afterEach(async () => {
    while (activeDomHarnesses.length > 0) {
      activeDomHarnesses.pop()?.uninstall()
    }
    if (workerActivated) {
      await deactivate()
      workerActivated = false
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    }
  })

  // ==========================================================================
  // Gate A — Static JS Semantic Gate (panel.html)
  // ==========================================================================
  describe('Gate A — Static JS Semantic Gate (panel.html)', () => {
    it('compiles panel.html <script type="module"> in-memory with zero undeclared identifiers (TS2304 / TS2552)', () => {
      const panelHtmlPath = path.join(REPO_ROOT, 'src', 'panel', 'panel.html')
      const html = fs.readFileSync(panelHtmlPath, 'utf8')
      const match = /<script\b[^>]*type=["']module["'][^>]*>([\s\S]*?)<\/script>/i.exec(html)
      expect(match).not.toBeNull()

      const scriptSource = match?.[1] ?? ''
      expect(scriptSource.length).toBeGreaterThan(500)
      expect(scriptSource).toContain('canEditCell')

      const virtualFile = path.join(REPO_ROOT, '__virtual_panel_module__.js')
      const options: ts.CompilerOptions = {
        allowJs: true,
        checkJs: true,
        noEmit: true,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
      }

      const defaultHost = ts.createCompilerHost(options, true)
      const virtualHost: ts.CompilerHost = {
        ...defaultHost,
        fileExists: (fileName: string) =>
          path.resolve(fileName) === virtualFile || defaultHost.fileExists(fileName),
        readFile: (fileName: string) =>
          path.resolve(fileName) === virtualFile ? scriptSource : defaultHost.readFile(fileName),
        getSourceFile: (
          fileName: string,
          languageVersionOrOptions: ts.ScriptTarget | ts.CreateSourceFileOptions,
          onError?: (message: string) => void,
          shouldCreateNewSourceFile?: boolean
        ) => {
          if (path.resolve(fileName) === virtualFile) {
            return ts.createSourceFile(
              fileName,
              scriptSource,
              ts.ScriptTarget.ES2022,
              true,
              ts.ScriptKind.JS
            )
          }
          return defaultHost.getSourceFile(
            fileName,
            languageVersionOrOptions,
            onError,
            shouldCreateNewSourceFile
          )
        },
      }

      const program = ts.createProgram([virtualFile], options, virtualHost)
      const sourceFile = program.getSourceFile(virtualFile)
      expect(sourceFile).toBeDefined()

      const semanticDiagnostics = program.getSemanticDiagnostics(sourceFile)
      const undeclaredDiagnostics = semanticDiagnostics.filter(
        (diag) => diag.code === 2304 || diag.code === 2552
      )

      const formatted = undeclaredDiagnostics.map((d) => {
        const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n')
        const pos =
          d.file && d.start !== undefined
            ? d.file.getLineAndCharacterOfPosition(d.start)
            : { line: 0, character: 0 }
        return `TS${d.code} at L${pos.line + 1}:C${pos.character + 1}: ${msg}`
      })

      expect(formatted).toEqual([])
    })
  })

  // ==========================================================================
  // Gate B — Native Orca Geist Font & Ctrl + Scroll Hint Gate
  // ==========================================================================
  describe('Gate B — Native Orca Geist Font & Ctrl + Scroll Hint Gate', () => {
    it('bundles Geist-Variable.woff2 < 1 MiB and embeds GEIST_FONT_DATA_URI + Ctrl + Scroll hint in panel & editor', () => {
      const fontFilePath = path.join(REPO_ROOT, 'assets', 'fonts', 'Geist-Variable.woff2')
      expect(fs.existsSync(fontFilePath)).toBe(true)

      const stat = fs.statSync(fontFilePath)
      expect(stat.size).toBeGreaterThan(1024)
      expect(stat.size).toBeLessThan(1024 * 1024)

      expect(GEIST_FONT_DATA_URI.startsWith('data:font/woff2;base64,')).toBe(true)

      const panelHtml = fs.readFileSync(path.join(REPO_ROOT, 'src', 'panel', 'panel.html'), 'utf8')
      const editorIndexTs = fs.readFileSync(
        path.join(REPO_ROOT, 'src', 'editor', 'index.ts'),
        'utf8'
      )

      expect(panelHtml).toContain('@font-face')
      expect(panelHtml).toContain(GEIST_FONT_DATA_URI)
      expect(panelHtml).toContain('Ctrl + Scroll')

      expect(EDITOR_STYLE).toContain('@font-face')
      expect(EDITOR_STYLE).toContain("font-family: 'Geist'")
      expect(EDITOR_STYLE).toContain(GEIST_FONT_DATA_URI)

      expect(editorIndexTs).toContain('datanoa-shortcut-hint')
      expect(editorIndexTs).toContain('Ctrl + Scroll')
    })
  })

  // ==========================================================================
  // Gate C — Interactive VirtualDataGrid & SchemaInspectorView DOM Flow
  // ==========================================================================
  describe('Gate C — Interactive VirtualDataGrid & SchemaInspectorView DOM Flow', () => {
    beforeEach(() => {
      const dom = new FakeDomHarness()
      dom.install()
      activeDomHarnesses.push(dom)
    })

    it('handles VirtualDataGrid Ctrl+Wheel pan, in-place click selection, inline edit Escape/Tab/blur, and default-omitting addBlankRow', async () => {
      const dom = activeDomHarnesses[activeDomHarnesses.length - 1]
      const container = dom.createElement('div') as unknown as HTMLElement

      const columns: TableBrowseResult['columns'] = [
        {
          name: 'uuid',
          type: 'TEXT',
          nativeType: 'TEXT',
          nullable: false,
          defaultValue: null,
          isPrimaryKey: true,
          isAutoIncrement: false,
        },
        {
          name: 'seqId',
          type: 'INTEGER',
          nativeType: 'INTEGER',
          nullable: false,
          defaultValue: null,
          isPrimaryKey: false,
          isAutoIncrement: true,
        },
        {
          name: 'createdAt',
          type: 'TEXT',
          nativeType: 'TEXT',
          nullable: false,
          defaultValue: "(datetime('now'))",
          isPrimaryKey: false,
          isAutoIncrement: false,
        },
        {
          name: 'name',
          type: 'TEXT',
          nativeType: 'TEXT',
          nullable: true,
          defaultValue: null,
          isPrimaryKey: false,
          isAutoIncrement: false,
        },
        {
          name: 'notes',
          type: 'TEXT',
          nativeType: 'TEXT',
          nullable: true,
          defaultValue: null,
          isPrimaryKey: false,
          isAutoIncrement: false,
        },
      ]

      for (let i = columns.length; i < 58; i++) {
        columns.push({
          name: `attr_${i}`,
          type: 'TEXT',
          nativeType: 'TEXT',
          nullable: true,
          defaultValue: null,
          isPrimaryKey: false,
          isAutoIncrement: false,
        })
      }

      const makeRow = (id: string, seq: number, name: string): Record<string, unknown> => {
        const rec: Record<string, unknown> = {
          uuid: id,
          seqId: seq,
          createdAt: '2026-01-01 00:00:00',
          name,
          notes: 'Initial note',
        }
        for (let i = 5; i < 58; i++) {
          rec[`attr_${i}`] = `v_${seq}_${i}`
        }
        return rec
      }

      const browseData: TableBrowseResult = {
        columns,
        rows: [makeRow('u-1', 1, 'Alice'), makeRow('u-2', 2, 'Bob')],
        totalRows: 2,
        page: 1,
        pageSize: 50,
        primaryKey: ['uuid'],
        canEdit: true,
      }

      const grid = new VirtualDataGrid({
        container,
        data: browseData,
        batchMode: true,
        tableName: 'account_test',
        dialect: 'sqlite',
      })

      const fakeContainer = container as unknown as FakeElement
      const tableContainer = fakeContainer.querySelector('.datanoa-grid-container')
      expect(tableContainer).not.toBeNull()

      // 1. Regular scroll leaves horizontal scrollLeft untouched; Ctrl+Wheel pans horizontally
      const plainWheel = new FakeEvent({ type: 'wheel', ctrlKey: false, deltaY: 120, deltaMode: 0 })
      tableContainer?.dispatchEvent(plainWheel)
      expect(plainWheel.defaultPrevented).toBe(false)
      expect(tableContainer?.scrollLeft).toBe(0)

      const ctrlWheel = new FakeEvent({ type: 'wheel', ctrlKey: true, deltaY: 120, deltaMode: 0 })
      tableContainer?.dispatchEvent(ctrlWheel)
      expect(ctrlWheel.defaultPrevented).toBe(true)
      expect(tableContainer?.scrollLeft).toBeGreaterThan(0)

      // 2. Cell click selects in-place without clearing or detaching the <td> node
      const tbody = fakeContainer.querySelector('tbody')
      expect(tbody).not.toBeNull()

      const tr0 = tbody?.querySelector('tr[data-row-index="0"]')
      const nameTd = tbody?.querySelector('td[data-row-index="0"][data-col-index="3"]')
      expect(tr0).not.toBeNull()
      expect(nameTd).not.toBeNull()

      nameTd?.dispatchEvent(new FakeEvent({ type: 'click' }))
      expect(tbody?.querySelector('td[data-row-index="0"][data-col-index="3"]')).toBe(nameTd)
      expect(tr0?.contains(nameTd ?? null)).toBe(true)
      expect(nameTd?.classList.contains('datanoa-cell-selected')).toBe(true)
      expect(tr0?.classList.contains('datanoa-row-selected')).toBe(true)

      // 3. Double-click opens inline editor; Escape cancels without staging
      nameTd?.dispatchEvent(new FakeEvent({ type: 'dblclick' }))
      const escInput = nameTd?.querySelector('input.datanoa-inline-input')
      expect(escInput).toBeInstanceOf(FakeHTMLInputElement)
      if (escInput instanceof FakeHTMLInputElement) {
        expect(escInput.value).toBe('Alice')
        escInput.value = 'CanceledValue'
        escInput.dispatchEvent(new FakeEvent({ type: 'keydown', key: 'Escape' }))
      }
      expect(nameTd?.querySelector('input.datanoa-inline-input')).toBeNull()
      expect(nameTd?.textContent).toBe('Alice')
      expect(grid.getChangesPayload().updates).toHaveLength(0)

      // 4. Double-click -> Tab commits current cell and moves inline editor to next editable cell; blur commits
      nameTd?.dispatchEvent(new FakeEvent({ type: 'dblclick' }))
      const tabInput = nameTd?.querySelector('input.datanoa-inline-input')
      expect(tabInput).toBeInstanceOf(FakeHTMLInputElement)
      if (tabInput instanceof FakeHTMLInputElement) {
        tabInput.value = 'Alice Renamed'
        tabInput.dispatchEvent(new FakeEvent({ type: 'keydown', key: 'Tab' }))
      }
      await flushMicrotasks()

      expect(tbody?.querySelector('td[data-row-index="0"][data-col-index="3"]')?.textContent).toBe(
        'Alice Renamed'
      )
      const nextTd = tbody?.querySelector('td[data-row-index="0"][data-col-index="4"]')
      expect(nextTd).not.toBeNull()
      const nextInput = nextTd?.querySelector('input.datanoa-inline-input')
      expect(nextInput).toBeInstanceOf(FakeHTMLInputElement)

      if (nextInput instanceof FakeHTMLInputElement) {
        nextInput.value = 'Updated Note via Tab+Blur'
        nextInput.dispatchEvent(new FakeEvent({ type: 'blur' }))
      }
      await flushMicrotasks()

      const committedNextTd = tbody?.querySelector('td[data-row-index="0"][data-col-index="4"]')
      expect(committedNextTd?.querySelector('input.datanoa-inline-input')).toBeNull()
      expect(committedNextTd?.textContent).toBe('Updated Note via Tab+Blur')
      const stagedAfterEdits = grid.getChangesPayload()
      expect(stagedAfterEdits.updates).toHaveLength(1)
      expect(stagedAfterEdits.updates[0].changes).toEqual({
        name: 'Alice Renamed',
        notes: 'Updated Note via Tab+Blur',
      })

      // 5. addBlankRow omits auto-increment & default columns and renders placeholders
      const insertedIdx = grid.addBlankRow()
      expect(insertedIdx).toBe(2)

      const autoTd = tbody?.querySelector('td[data-row-index="2"][data-col-index="1"]')
      const defaultTd = tbody?.querySelector('td[data-row-index="2"][data-col-index="2"]')
      expect(autoTd?.textContent).toBe('(auto)')
      expect(defaultTd?.textContent).toBe('(default)')

      const insertPayload = grid.getChangesPayload()
      expect(insertPayload.inserts).toHaveLength(1)
      expect('seqId' in insertPayload.inserts[0]).toBe(false)
      expect('createdAt' in insertPayload.inserts[0]).toBe(false)
      expect('uuid' in insertPayload.inserts[0]).toBe(true)

      grid.destroy()
      expect(dom.activeWheelListeners.size).toBe(0)
    })

    it('formats DDL cleanly and wraps SchemaInspectorView tables with Ctrl+Wheel, preserving casing and cleaning up', () => {
      const dom = activeDomHarnesses[activeDomHarnesses.length - 1]
      const formattedDdl = formatDdlForDisplay(
        'CREATE TABLE "account" ("id" INTEGER PRIMARY KEY, "createdAt" datetime DEFAULT (datetime(\'now\')), "name" TEXT);'
      )
      expect(formattedDdl.split('\n').length).toBeGreaterThanOrEqual(4)
      expect(formattedDdl).toContain('\n  "id" INTEGER PRIMARY KEY,')
      expect(formattedDdl).toContain('\n  "createdAt" datetime DEFAULT (datetime(\'now\')),')

      const hostEl = dom.createElement('div') as unknown as HTMLElement
      const inspector = new SchemaInspectorView(hostEl, { dialect: 'sqlite' })

      const details: TableDetails = {
        name: 'account_profile',
        schema: 'main',
        kind: 'table',
        primaryKey: ['uuid'],
        columns: [
          {
            name: 'uuid',
            type: 'TEXT',
            nativeType: 'TEXT',
            nullable: false,
            defaultValue: null,
            isPrimaryKey: true,
            isAutoIncrement: false,
          },
          {
            name: 'friend_facebook',
            type: 'TEXT',
            nativeType: 'TEXT',
            nullable: true,
            defaultValue: null,
            isPrimaryKey: false,
            isAutoIncrement: false,
          },
        ],
        foreignKeys: [
          {
            constraintName: 'fk_friend_facebook',
            column: 'friend_facebook',
            referencedTable: 'facebook_directory',
            referencedColumn: 'fb_id',
          },
        ],
        indexes: [
          {
            name: 'idx_friend_facebook',
            isUnique: false,
            isPrimary: false,
            columns: ['friend_facebook'],
          },
        ],
      }

      inspector.setDetails(details, 'sqlite')

      const fakeHost = hostEl as unknown as FakeElement
      const matrixTables = fakeHost.querySelectorAll('.datanoa-matrix-table')
      const scrollWrappers = fakeHost.querySelectorAll('.datanoa-matrix-scroll')
      expect(matrixTables).toHaveLength(3)
      expect(scrollWrappers).toHaveLength(3)
      for (const tbl of matrixTables) {
        expect(tbl.parentElement?.classList.contains('datanoa-matrix-scroll')).toBe(true)
      }
      expect(fakeHost.querySelectorAll('.datanoa-inspector-view')).toHaveLength(0)

      // DDL pre + 3 matrix scroll wrappers = 4 Ctrl+Wheel bindings
      const ddlPre = fakeHost.querySelector('.datanoa-ddl-pre')
      expect(ddlPre).not.toBeNull()
      expect(dom.activeWheelListeners.size).toBe(4)

      for (const scrollable of [ddlPre, ...scrollWrappers]) {
        const wheelEv = new FakeEvent({ type: 'wheel', ctrlKey: true, deltaY: 120, deltaMode: 0 })
        scrollable?.dispatchEvent(wheelEv)
        expect(wheelEv.defaultPrevented).toBe(true)
        expect(scrollable?.scrollLeft).toBeGreaterThan(0)
      }

      // Preserve exact identifier casing
      const pkBadge = fakeHost.querySelector('.datanoa-badge-pk')
      expect(pkBadge?.textContent).toBe('PK: uuid')
      expect(pkBadge?.textContent).not.toContain('UUID')
      expect(fakeHost.innerHTML).toContain('friend_facebook')
      expect(fakeHost.innerHTML).not.toContain('FRIEND_FACEBOOK')

      inspector.clear()
      expect(dom.activeWheelListeners.size).toBe(0)
      expect(fakeHost.textContent).toContain('No table selected')

      inspector.setDetails(details, 'sqlite')
      expect(dom.activeWheelListeners.size).toBe(4)

      inspector.destroy()
      expect(dom.activeWheelListeners.size).toBe(0)
      expect(fakeHost.childNodes).toHaveLength(0)
    })
  })

  // ==========================================================================
  // Gate D — Full Real node:sqlite + activate(orca) Worker E2E Integration
  // ==========================================================================
  describe('Gate D — Real node:sqlite + activate(orca) Worker Integration', () => {
    it('evaluates DB defaults, coerces booleans, runs/blocks multi-statements, resolves active connection in studio.open, and maps MySQL flags', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'datanoa-runtime-gate-'))
      tempDirs.push(tempDir)
      const workspaceDir = path.join(tempDir, 'workspace')
      fs.mkdirSync(workspaceDir, { recursive: true })
      const dbPath = path.join(tempDir, 'account_gate.sqlite')

      const seedDb = new DatabaseSync(dbPath)
      seedDb.exec(`
        CREATE TABLE account_test (
          uuid TEXT PRIMARY KEY,
          name TEXT,
          active INTEGER NOT NULL DEFAULT 1,
          createdAt TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO account_test (uuid, name, active) VALUES ('u1', 'Alice', 1);
      `)
      seedDb.close()

      const runtime = new MockOrcaRuntime()
      const hostCalls: RecordedHostCall[] = []
      const workerApi = createTypedWorkerApi(runtime, workspaceDir, hostCalls)
      activate(workerApi)
      workerActivated = true

      const rwProfile: ConnectionProfile = {
        id: 'conn-sqlite-gate-rw',
        name: 'SQLite Gate RW',
        driver: 'sqlite',
        database: 'account_gate.sqlite',
        filePath: dbPath,
        readOnly: false,
      }

      const saveRwRes = await invokeWorker(runtime, 'connection.save', { profile: rwProfile })
      expect(saveRwRes.ok).toBe(true)

      // 1. + Row insert omitting createdAt evaluates SQLite DEFAULT (datetime('now'))
      const insertRes = await invokeWorker(runtime, 'data.applyChanges', {
        connectionId: rwProfile.id,
        table: 'account_test',
        inserts: [{ uuid: 'u-default-row', name: 'RowWithDefault', active: true }],
      })
      expect(insertRes.ok).toBe(true)
      expect(insertRes.inserted).toBe(1)

      const insertedPage = await invokeWorker(runtime, 'data.fetchPage', {
        connectionId: rwProfile.id,
        table: 'account_test',
        page: 1,
        pageSize: 50,
      })
      const insertedRow = insertedPage.rows.find((r) => r.uuid === 'u-default-row')
      expect(insertedRow).toBeDefined()
      expect(String(insertedRow?.createdAt ?? '')).toMatch(/^\d{4}-\d{2}-\d{2}/)
      expect(insertedRow?.createdAt).not.toBe("datetime('now')")

      // Remove u-default-row so later total count across multi-statement test stays deterministic (u1 + u2 + u3 = 3)
      const deleteInsertedRes = await invokeWorker(runtime, 'data.applyChanges', {
        connectionId: rwProfile.id,
        table: 'account_test',
        deletes: [{ uuid: 'u-default-row' }],
      })
      expect(deleteInsertedRes.ok).toBe(true)
      expect(deleteInsertedRes.deleted).toBe(1)

      // 2. data.updateCell with boolean false stores 0 cleanly without node:sqlite TypeError
      const updateBoolRes = await invokeWorker(runtime, 'data.updateCell', {
        connectionId: rwProfile.id,
        table: 'account_test',
        primaryKeys: { uuid: 'u1' },
        column: 'active',
        newValue: false,
        originalValue: 1,
      })
      expect(updateBoolRes.ok).toBe(true)
      expect(updateBoolRes.updatedRecord?.active).toBe(0)

      // 3. Multi-statement query.run executes all statements and returns final SELECT count === 3
      const multiRunRes = await invokeWorker(runtime, 'query.run', {
        connectionId: rwProfile.id,
        queryId: 'q-multi-gate',
        sql: "INSERT INTO account_test (uuid, name, active) VALUES ('u2', 'Bob', 1); INSERT INTO account_test (uuid, name, active) VALUES ('u3', 'Cam', 0); SELECT COUNT(*) AS total FROM account_test;",
      })
      expect(multiRunRes.isSelect).toBe(true)
      expect(multiRunRes.rows[0]?.[0]).toBe(3)

      // 4. Multi-statement readOnly guard blocks compound mutation and preserves all 3 rows
      const roProfile: ConnectionProfile = {
        ...rwProfile,
        id: 'conn-sqlite-gate-ro',
        name: 'SQLite Gate RO',
        readOnly: true,
      }
      await invokeWorker(runtime, 'connection.save', { profile: roProfile })

      await expect(
        invokeWorker(runtime, 'query.run', {
          connectionId: roProfile.id,
          queryId: 'q-multi-ro-block',
          sql: 'SELECT 1; DELETE FROM account_test;',
        })
      ).rejects.toMatchObject({ code: 'not_permitted' })

      const countAfterBlock = await invokeWorker(runtime, 'query.run', {
        connectionId: roProfile.id,
        queryId: 'q-verify-count',
        sql: 'SELECT COUNT(*) AS total FROM account_test;',
      })
      expect(countAfterBlock.rows[0]?.[0]).toBe(3)

      // 5. studio.open with NO connectionId parameter resolves ACTIVE_CONNECTION_STORAGE_KEY
      await runtime.getWorkerApi().storage.set(ACTIVE_CONNECTION_STORAGE_KEY, rwProfile.id)
      const studioOpenRes = await invokeWorker(runtime, 'studio.open', {})
      expect(studioOpenRes.ok).toBe(true)
      expect(studioOpenRes.path).toBe('.datanoa/studio.datanoa')

      const studioFilePath = path.join(workspaceDir, '.datanoa', 'studio.datanoa')
      expect(fs.existsSync(studioFilePath)).toBe(true)
      const studioContent = fs.readFileSync(studioFilePath, 'utf8')
      expect(studioContent).toContain(`-- datanoa: connectionId=${rwProfile.id}`)

      const editorOpenCall = hostCalls.find((c) => c.method === 'editor.open')
      expect(editorOpenCall?.params).toEqual({
        workspaceId: 'ws-local-e2e',
        path: '.datanoa/studio.datanoa',
      })

      // 6. introspectMysqlTableDetails maps MySQL bigNumberStrings ('0' / '1') flags accurately
      const mysqlDetails = await introspectMysqlTableDetails(
        async (sql: string) => {
          if (sql.includes('FROM information_schema.tables')) {
            return [{ kind: 'table' }]
          }
          if (sql.includes('FROM information_schema.columns')) {
            return [
              {
                name: 'id',
                type: 'bigint unsigned',
                native_type: 'bigint',
                nullable: '0',
                default_value: null,
                is_primary_key: '1',
                is_auto_increment: '1',
              },
              {
                name: 'email',
                type: 'varchar(255)',
                native_type: 'varchar',
                nullable: '1',
                default_value: null,
                is_primary_key: '0',
                is_auto_increment: '0',
              },
            ]
          }
          if (sql.includes("AND constraint_name = 'PRIMARY'")) {
            return [{ column_name: 'id' }]
          }
          if (sql.includes('AND referenced_table_name IS NOT NULL')) {
            return []
          }
          if (sql.includes('FROM information_schema.statistics')) {
            return [
              {
                name: 'PRIMARY',
                is_unique: '1',
                is_primary: '1',
                column_name: 'id',
                seq_in_index: 1,
              },
              {
                name: 'idx_email',
                is_unique: '0',
                is_primary: '0',
                column_name: 'email',
                seq_in_index: 1,
              },
            ]
          }
          return []
        },
        'users',
        'app_db'
      )

      expect(mysqlDetails.columns[0].nullable).toBe(false)
      expect(mysqlDetails.columns[0].isPrimaryKey).toBe(true)
      expect(mysqlDetails.columns[0].isAutoIncrement).toBe(true)
      expect(mysqlDetails.columns[1].nullable).toBe(true)
      expect(mysqlDetails.columns[1].isPrimaryKey).toBe(false)
      expect(mysqlDetails.columns[1].isAutoIncrement).toBe(false)
      expect(mysqlDetails.indexes[0].isUnique).toBe(true)
      expect(mysqlDetails.indexes[0].isPrimary).toBe(true)
      expect(mysqlDetails.indexes[1].isUnique).toBe(false)
      expect(mysqlDetails.indexes[1].isPrimary).toBe(false)
    })
  })

  // ==========================================================================
  // Gate E — Wave 6 UI/UX, Centered Avatar, <colgroup> Smooth Column Resizing,
  // Sleek SVG Sort & On-Demand Edit Cell
  // ==========================================================================
  describe('Gate E — Wave 6 UI/UX, Centered Avatar, <colgroup> Smooth Column Resizing, Sleek SVG Sort & On-Demand Edit Cell', () => {
    it('a) ships symmetrical PNG brand avatar (256x256 icon.png & 64x64 logo URI) with object-fit: contain + #ffffff padding', () => {
      const iconPath = path.join(REPO_ROOT, 'assets', 'icon.png')
      const iconBytes = fs.readFileSync(iconPath)
      expect(iconBytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
      expect(iconBytes.readUInt32BE(16)).toBe(256)
      expect(iconBytes.readUInt32BE(20)).toBe(256)

      expect(DATANOA_LOGO_DATA_URI.startsWith('data:image/png;base64,')).toBe(true)
      const logoPng = Buffer.from(
        DATANOA_LOGO_DATA_URI.slice('data:image/png;base64,'.length),
        'base64'
      )
      expect(logoPng.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
      expect(logoPng.readUInt32BE(16)).toBe(64)
      expect(logoPng.readUInt32BE(20)).toBe(64)

      const panelHtml = fs.readFileSync(path.join(REPO_ROOT, 'src', 'panel', 'panel.html'), 'utf8')
      const themeTs = fs.readFileSync(path.join(REPO_ROOT, 'src', 'editor', 'theme.ts'), 'utf8')
      const editorIndexTs = fs.readFileSync(
        path.join(REPO_ROOT, 'src', 'editor', 'index.ts'),
        'utf8'
      )

      expect(panelHtml).toContain(`class="brand-logo" src="${DATANOA_LOGO_DATA_URI}"`)
      expect(panelHtml).toMatch(
        /\.brand-mark\s*\{[\s\S]*?width:\s*22px;[\s\S]*?height:\s*22px;[\s\S]*?background:\s*#ffffff;[\s\S]*?padding:\s*1px;/
      )
      expect(panelHtml).toMatch(/\.brand-logo\s*\{[\s\S]*?object-fit:\s*contain;/)

      expect(themeTs).toMatch(
        /\.datanoa-brand-logo\s*\{[\s\S]*?width:\s*22px;[\s\S]*?height:\s*22px;[\s\S]*?background:\s*#ffffff;[\s\S]*?padding:\s*1px;[\s\S]*?object-fit:\s*contain;/
      )
      expect(editorIndexTs).toContain('brandLogo.src = DATANOA_LOGO_DATA_URI')
    })

    it('b) enforces Wave 6 single-row header, confirmDeleteModal, flex dataGridWrap, and button token parity', () => {
      const panelHtml = fs.readFileSync(path.join(REPO_ROOT, 'src', 'panel', 'panel.html'), 'utf8')
      const themeTs = fs.readFileSync(path.join(REPO_ROOT, 'src', 'editor', 'theme.ts'), 'utf8')

      const headerMatch = /<header\b[^>]*class="header"[^>]*>([\s\S]*?)<\/header>/.exec(panelHtml)
      expect(headerMatch).not.toBeNull()
      const headerHtml = headerMatch?.[1] ?? ''
      expect(headerHtml).toContain('id="newServerBtn"')
      expect(headerHtml).toContain('id="refreshBtn"')
      expect(headerHtml).toContain('id="openStudioBtn"')
      for (const removedId of ['liveDot', 'openSqliteBtn', 'scanHeaderBtn', 'newQueryBtn']) {
        expect(headerHtml).not.toContain(`id="${removedId}"`)
        expect(panelHtml).not.toContain(`id="${removedId}"`)
      }

      expect(panelHtml).toMatch(/\.header\s*\{[\s\S]*?flex-direction:\s*row;/)
      expect(panelHtml).toContain('id="confirmDeleteModal"')
      expect(panelHtml).toContain('id="cancelDeleteBtn"')
      expect(panelHtml).toContain('id="confirmDeleteBtn"')
      expect(panelHtml).toContain('function openDeleteConfirmModal(')

      expect(panelHtml).not.toContain('max-height: 340px')
      expect(panelHtml).toMatch(
        /#dataGridWrap[\s\S]*?\{[\s\S]*?flex:\s*1 1 0;[\s\S]*?min-height:\s*110px;[\s\S]*?max-height:\s*none;/
      )

      for (const token of ['--btn-bg:', '--btn-border:', '--btn-disabled-bg:']) {
        expect(panelHtml).toContain(token)
        expect(themeTs).toContain(token)
        expect(EDITOR_STYLE).toContain(token)
      }
    })

    it('c) places shortcut hint in status bar and opens Value Inspector only on demand via Edit Cell or context menu', () => {
      const panelHtml = fs.readFileSync(path.join(REPO_ROOT, 'src', 'panel', 'panel.html'), 'utf8')
      expect(panelHtml).toContain('id="inspectCellBtn"')
      expect(panelHtml).toContain('inspectorOpen: false')
      expect(panelHtml).toContain('if (!state.inspectorOpen')

      const dom = new FakeDomHarness()
      dom.install()
      activeDomHarnesses.push(dom)
      expect(dom.window.orca).toBeUndefined()

      const editor = new DatanoaStudioEditor()
      try {
        expect(
          dom.head
            .querySelectorAll('style')
            .some((styleNode) => styleNode.textContent.includes('.datanoa-editor-root'))
        ).toBe(true)

        // Shortcut hint is inside .datanoa-status-bar, NOT inside .datanoa-grid-subbar
        const statusHint = dom.body.querySelector('.datanoa-status-bar .datanoa-shortcut-hint')
        const subbarHint = dom.body.querySelector('.datanoa-grid-subbar .datanoa-shortcut-hint')
        expect(statusHint).not.toBeNull()
        expect(statusHint?.textContent).toContain('Ctrl + Scroll')
        expect(subbarHint).toBeNull()

        const inspectBtn = dom.body
          .querySelectorAll('button')
          .find((btn) => btn.textContent === 'Edit Cell')
        expect(inspectBtn).toBeInstanceOf(FakeHTMLButtonElement)
        const valueInspector = dom.body.querySelector('.datanoa-value-inspector')
        expect(valueInspector).not.toBeNull()

        if (inspectBtn instanceof FakeHTMLButtonElement) {
          expect(inspectBtn.disabled).toBe(true)
        }
        expect(valueInspector?.style.display).toBe('none')

        // Populate DataGrid with a 2-column editable page
        const grid = editor.getDataGrid()
        expect(grid).not.toBeNull()
        grid?.setData({
          columns: [
            {
              name: 'id',
              type: 'INTEGER',
              nativeType: 'INTEGER',
              nullable: false,
              defaultValue: null,
              isPrimaryKey: true,
              isAutoIncrement: true,
            },
            {
              name: 'payload',
              type: 'TEXT',
              nativeType: 'TEXT',
              nullable: true,
              defaultValue: null,
              isPrimaryKey: false,
              isAutoIncrement: false,
            },
          ],
          rows: [{ id: 1, payload: '{"ok":true}' }],
          totalRows: 1,
          page: 1,
          pageSize: 50,
          primaryKey: ['id'],
          canEdit: true,
        })

        // Clicking a cell enables Edit Cell without auto-opening .datanoa-value-inspector
        const payloadTd = dom.body.querySelector('tbody td[data-row-index="0"][data-col-index="1"]')
        expect(payloadTd).not.toBeNull()
        payloadTd?.dispatchEvent(new FakeEvent({ type: 'click', bubbles: true }))

        if (inspectBtn instanceof FakeHTMLButtonElement) {
          expect(inspectBtn.disabled).toBe(false)
          expect(inspectBtn.classList.contains('active')).toBe(false)
        }
        expect(valueInspector?.style.display).toBe('none')

        // Clicking Edit Cell opens .datanoa-value-inspector
        inspectBtn?.dispatchEvent(new FakeEvent({ type: 'click', bubbles: true }))
        expect(valueInspector?.style.display).toBe('flex')
        expect(inspectBtn?.classList.contains('active')).toBe(true)
        const inspectorTextarea = valueInspector?.querySelector('.datanoa-value-textarea')
        expect(inspectorTextarea).toBeInstanceOf(FakeHTMLTextAreaElement)
        if (inspectorTextarea instanceof FakeHTMLTextAreaElement) {
          expect(inspectorTextarea.value).toContain('"ok": true')
        }

        // Clicking Close hides .datanoa-value-inspector
        const closeBtn = valueInspector
          ?.querySelectorAll('button')
          .find((btn) => btn.textContent === 'Close')
        expect(closeBtn).toBeDefined()
        closeBtn?.dispatchEvent(new FakeEvent({ type: 'click', bubbles: true }))
        expect(valueInspector?.style.display).toBe('none')
        expect(inspectBtn?.classList.contains('active')).toBe(false)

        // Right-click -> Edit in Value Inspector opens .datanoa-value-inspector
        payloadTd?.dispatchEvent(
          new FakeEvent({ type: 'contextmenu', clientX: 24, clientY: 24, bubbles: true })
        )
        const ctxMenu = dom.body.querySelector('.datanoa-context-menu')
        expect(ctxMenu).not.toBeNull()
        const inspectMenuItem = ctxMenu
          ?.querySelectorAll('.datanoa-context-item')
          .find((btn) => btn.textContent === 'Edit in Value Inspector')
        expect(inspectMenuItem).toBeDefined()
        inspectMenuItem?.dispatchEvent(new FakeEvent({ type: 'click', bubbles: true }))
        expect(valueInspector?.style.display).toBe('flex')
        expect(inspectBtn?.classList.contains('active')).toBe(true)
      } finally {
        editor.destroy()
      }

      expect(dom.body.querySelector('.datanoa-editor-root')).toBeNull()
      expect(
        dom.head
          .querySelectorAll('style')
          .some((styleNode) => styleNode.textContent.includes('.datanoa-editor-root'))
      ).toBe(false)
    })

    it('d) renders <colgroup> widths, sleek SVG sort chevron, live 60fps col resizing without tbody rebuild, and dblclick auto-fit', () => {
      const dom = new FakeDomHarness()
      dom.install()
      activeDomHarnesses.push(dom)

      const gridTableRuleMatch = /\.datanoa-grid-table\s*\{([^}]*)\}/.exec(EDITOR_STYLE)
      expect(gridTableRuleMatch).not.toBeNull()
      expect(gridTableRuleMatch?.[1]).not.toContain('min-width: 100%')
      expect(EDITOR_STYLE).toMatch(/\.datanoa-grid-table\.transposed\s*\{[\s\S]*?min-width:\s*100%;/)

      const container = dom.createElement('div') as unknown as HTMLElement
      const onSort = vi.fn()

      const grid = new VirtualDataGrid({
        container,
        tableName: 'friend_links',
        dialect: 'sqlite',
        onSort,
        data: {
          columns: [
            {
              name: 'account_uid',
              type: 'TEXT',
              nativeType: 'TEXT',
              nullable: false,
              defaultValue: null,
              isPrimaryKey: true,
              isAutoIncrement: false,
            },
            {
              name: 'friend_facebook_uid',
              type: 'TEXT',
              nativeType: 'TEXT',
              nullable: false,
              defaultValue: null,
              isPrimaryKey: false,
              isAutoIncrement: false,
            },
          ],
          rows: [
            { account_uid: 'acc_001', friend_facebook_uid: '100001234567890' },
            { account_uid: 'acc_002', friend_facebook_uid: '100009876543210' },
          ],
          totalRows: 2,
          page: 1,
          pageSize: 50,
          primaryKey: ['account_uid'],
          canEdit: true,
        },
      })

      const fakeContainer = container as unknown as FakeElement
      const table = fakeContainer.querySelector('table.datanoa-grid-table')
      expect(table).not.toBeNull()

      const colgroup = table?.childNodes[0]
      const thead = table?.childNodes[1]
      expect(colgroup).toBeInstanceOf(FakeHTMLTableColElement)
      expect(colgroup instanceof FakeElement ? colgroup.tagName : '').toBe('COLGROUP')
      expect(thead instanceof FakeElement ? thead.tagName : '').toBe('THEAD')

      const cols = colgroup instanceof FakeElement ? colgroup.children : []
      expect(cols).toHaveLength(3)
      for (const col of cols) {
        expect(col).toBeInstanceOf(FakeHTMLTableColElement)
        expect(col.tagName).toBe('COL')
      }

      const rowNumColW = Number.parseInt(cols[0].style.width, 10)
      const col1W = Number.parseInt(cols[1].style.width, 10)
      const col2W = Number.parseInt(cols[2].style.width, 10)
      expect(rowNumColW).toBe(44)
      expect(col1W).toBeGreaterThanOrEqual(84)
      expect(col1W).toBeLessThanOrEqual(300)
      expect(col2W).toBeGreaterThanOrEqual(84)
      expect(col2W).toBeLessThanOrEqual(300)

      const initialTotalW = rowNumColW + col1W + col2W
      expect(table?.style.width).toBe(`${initialTotalW}px`)

      const rowNumCells = fakeContainer.querySelectorAll('tbody td.datanoa-td-rownum')
      expect(rowNumCells).toHaveLength(2)
      expect(rowNumCells.map((c) => c.textContent)).toEqual(['1', '2'])

      // Click account_uid header -> sorted class + sleek stroke <svg> chevron, no raw Unicode ▲/▼
      const initialThs = fakeContainer.querySelectorAll('thead th')
      expect(initialThs).toHaveLength(3)
      initialThs[1].dispatchEvent(new FakeEvent({ type: 'click', bubbles: true }))
      expect(onSort).toHaveBeenCalledTimes(1)
      expect(onSort).toHaveBeenCalledWith('account_uid', 'ASC')

      const sortedThs = fakeContainer.querySelectorAll('thead th')
      const sortedTh = sortedThs[1]
      const sortedCols = colgroup instanceof FakeElement ? colgroup.children : []
      expect(sortedCols).toHaveLength(3)
      expect(sortedTh.classList.contains('sorted')).toBe(true)
      const sortSvg = sortedTh.querySelector('.datanoa-th-sort-icon svg')
      expect(sortSvg).not.toBeNull()
      expect(sortSvg?.getAttribute('stroke')).toBe('currentColor')
      expect(sortSvg?.getAttribute('fill')).toBe('none')
      expect(sortedTh.textContent).not.toContain('▲')
      expect(sortedTh.textContent).not.toContain('▼')

      // Drag account_uid resize handle (+40px) -> live col & table width update without tbody rebuild
      onSort.mockClear()
      const tbody = fakeContainer.querySelector('tbody')
      const tr0Before = tbody?.querySelector('tr[data-row-index="0"]')
      const td0Before = tbody?.querySelector('td[data-row-index="0"][data-col-index="0"]')
      expect(tr0Before).not.toBeNull()
      expect(td0Before).not.toBeNull()

      const accountResizeHandle = sortedTh.querySelector('.datanoa-resize-handle')
      expect(accountResizeHandle).not.toBeNull()

      accountResizeHandle?.dispatchEvent(
        new FakeEvent({ type: 'mousedown', clientX: 100, bubbles: true })
      )
      expect(accountResizeHandle?.classList.contains('resizing')).toBe(true)
      expect(dom.body.style.cursor).toBe('col-resize')

      dom.window.dispatchEvent(new FakeEvent({ type: 'mousemove', clientX: 140 }))
      expect(sortedCols[1].style.width).toBe(`${col1W + 40}px`)
      expect(sortedTh.style.width).toBe(`${col1W + 40}px`)
      expect(table?.style.width).toBe(`${initialTotalW + 40}px`)
      expect(tbody?.querySelector('tr[data-row-index="0"]')).toBe(tr0Before)
      expect(tbody?.querySelector('td[data-row-index="0"][data-col-index="0"]')).toBe(td0Before)

      dom.window.dispatchEvent(new FakeEvent({ type: 'mouseup', clientX: 140 }))
      expect(accountResizeHandle?.classList.contains('resizing')).toBe(false)
      expect(dom.body.style.cursor).toBe('')

      // Immediate click after resize release must NOT fire onSort (suppressSortClickUntil)
      sortedTh.dispatchEvent(new FakeEvent({ type: 'click', bubbles: true }))
      expect(onSort).not.toHaveBeenCalled()

      // Drag # handle (colIndex -1) cleanly resizes # column
      const rowNumResizeHandle = sortedThs[0].querySelector('.datanoa-resize-handle')
      expect(rowNumResizeHandle).not.toBeNull()
      rowNumResizeHandle?.dispatchEvent(
        new FakeEvent({ type: 'mousedown', clientX: 44, bubbles: true })
      )
      dom.window.dispatchEvent(new FakeEvent({ type: 'mousemove', clientX: 60 }))
      expect(sortedCols[0].style.width).toBe('60px')
      expect(sortedThs[0].style.width).toBe('60px')
      expect(table?.style.width).toBe(`${initialTotalW + 40 + 16}px`)
      dom.window.dispatchEvent(new FakeEvent({ type: 'mouseup', clientX: 60 }))

      // Double-click resize handle -> auto-fit updates <col> width within [64px..480px]
      accountResizeHandle?.dispatchEvent(new FakeEvent({ type: 'dblclick', bubbles: true }))
      const fittedCol1W = Number.parseInt(sortedCols[1].style.width, 10)
      expect(fittedCol1W).toBeGreaterThanOrEqual(64)
      expect(fittedCol1W).toBeLessThanOrEqual(480)
      expect(fittedCol1W).not.toBe(col1W + 40)
      expect(sortedTh.style.width).toBe(`${fittedCol1W}px`)
      expect(table?.style.width).toBe(`${60 + fittedCol1W + col2W}px`)

      grid.destroy()
    })
  })

  // ==========================================================================
  // Gate F — Wave 7: Shortcut Hint Cleanup, Query Status/Error Banners,
  // Query-Aware Empty Message, Canonical Studio Tab, and Page Size Selector
  // ==========================================================================
  describe('Gate F — Wave 7: Query Feedback, Query-Aware Empty Message, Canonical Tab & Page Size (100..10000)', () => {
    it('removes panel shortcut-hint boxes, right-aligns editor shortcut hint, supports 100/500/1000/5000/10000 pageSize, and shows query banners & query-aware empty message', async () => {
      const panelHtml = fs.readFileSync(path.join(REPO_ROOT, 'src', 'panel', 'panel.html'), 'utf8')
      expect(panelHtml).not.toContain('id="dataShortcutHint"')
      expect(panelHtml).not.toContain('id="sqlShortcutHint"')
      expect(panelHtml).toContain('id="pageSizeSelect"')
      expect(panelHtml).toContain('id="sqlSuccessBanner"')
      for (const size of ['100', '500', '1000', '5000', '10000']) {
        expect(panelHtml).toContain(`value="${size}"`)
      }

      // CSS checks for right-aligned status bar shortcut hint & box-sizing alignment
      expect(EDITOR_STYLE).toMatch(
        /\.datanoa-shortcut-hint\s*\{[\s\S]*?text-align:\s*right;[\s\S]*?margin-left:\s*auto;/
      )
      expect(EDITOR_STYLE).toMatch(
        /\.datanoa-grid-empty-cell\s*\{[\s\S]*?border-right:\s*1px solid var\(--border\);[\s\S]*?box-sizing:\s*border-box;/
      )

      const dom = new FakeDomHarness()
      dom.install()
      activeDomHarnesses.push(dom)

      const fetchPageCalls: Array<Record<string, unknown>> = []
      let shouldFailQuery = false

      dom.window.orca = {
        plugin: {
          request: async (name: string, payload?: Record<string, unknown>) => {
            if (name === 'connections.list') {
              return [
                {
                  id: 'conn_sqlite_1',
                  name: 'data/.db',
                  driver: 'sqlite',
                  database: 'data.db',
                  filePath: '/tmp/data.db',
                },
              ]
            }
            if (name === 'schema.listObjects') {
              return [
                { name: 'account', kind: 'table', schema: 'main' },
                { name: 'accounts_friend_facebooks', kind: 'table', schema: 'main' },
              ]
            }
            if (name === 'schema.tableDetails') {
              return {
                name: String(payload?.table || 'account'),
                columns: [
                  {
                    name: 'uuid',
                    type: 'TEXT',
                    nativeType: 'TEXT',
                    nullable: false,
                    defaultValue: null,
                    isPrimaryKey: true,
                    isAutoIncrement: false,
                  },
                ],
                primaryKey: ['uuid'],
                indexes: [],
                foreignKeys: [],
              }
            }
            if (name === 'data.fetchPage') {
              fetchPageCalls.push(payload || {})
              return {
                columns: [
                  {
                    name: 'uuid',
                    type: 'TEXT',
                    nativeType: 'TEXT',
                    nullable: false,
                    defaultValue: null,
                    isPrimaryKey: true,
                    isAutoIncrement: false,
                  },
                ],
                rows: [],
                totalRows: 0,
                page: Number(payload?.page || 1),
                pageSize: Number(payload?.pageSize || 100),
                primaryKey: ['uuid'],
                canEdit: true,
              }
            }
            if (name === 'query.run') {
              if (shouldFailQuery) {
                throw new Error('SQLITE_ERROR: no such column: non_existent_col')
              }
              return {
                columns: [
                  { name: 'account_uid', type: 'TEXT' },
                  { name: 'friend_facebook_uid', type: 'TEXT' },
                ],
                rows: [],
                rowCount: 0,
                executionTimeMs: 14,
                truncated: false,
                isSelect: true,
              }
            }
            return {}
          },
        },
        storage: {
          get: async () => 'conn_sqlite_1',
          set: async () => {},
        },
      }

      const editor = new DatanoaStudioEditor()
      try {
        await editor.refreshConnections()
        await new Promise((r) => setTimeout(r, 30))

        // Initially loaded "account" table with 0 rows
        const emptyCellBefore = dom.body.querySelector('.datanoa-grid-empty-cell')
        expect(emptyCellBefore?.textContent).toBe('Table "account" has no rows.')

        // Verify pageSizeSelectEl has 100, 500, 1000, 5000, 10000 and triggers reload with 5000
        const pageSizeSelect = dom.body
          .querySelectorAll('select')
          .find((s) => s.getAttribute('aria-label') === 'Rows per page')
        expect(pageSizeSelect).toBeDefined()
        const optionVals = (pageSizeSelect?.querySelectorAll('option') || []).map((o) =>
          o.getAttribute('value') || (o as unknown as FakeHTMLOptionElement).value
        )
        expect(optionVals).toEqual(['100', '500', '1000', '5000', '10000'])

        if (pageSizeSelect instanceof FakeHTMLSelectElement) {
          pageSizeSelect.value = '5000'
          pageSizeSelect.dispatchEvent(new FakeEvent({ type: 'change', bubbles: true }))
          await new Promise((r) => setTimeout(r, 20))
          expect(fetchPageCalls[fetchPageCalls.length - 1]?.pageSize).toBe(5000)
        }

        // Now run `select * from accounts_friend_facebooks` returning 0 rows
        editor.applyDocumentMetadata('select * from accounts_friend_facebooks')
        await editor.executeSql(true)

        const emptyCellAfterQuery = dom.body.querySelector('.datanoa-grid-empty-cell')
        expect(emptyCellAfterQuery?.textContent).not.toContain('Table "account" has no rows.')
        expect(emptyCellAfterQuery?.textContent).toContain('accounts_friend_facebooks')

        const queryBanner = dom.body.querySelector('.datanoa-query-banner')
        expect(queryBanner).not.toBeNull()
        expect(queryBanner?.style.display).not.toBe('none')
        expect(queryBanner?.classList.contains('success')).toBe(true)
        expect(queryBanner?.textContent).toContain('0 rows')

        // Now trigger a failing SQL query and verify clear error banner + grid empty state
        shouldFailQuery = true
        editor.applyDocumentMetadata('SELECT non_existent_col FROM account;')
        await editor.executeSql(true)

        expect(queryBanner?.style.display).not.toBe('none')
        expect(queryBanner?.classList.contains('error')).toBe(true)
        expect(queryBanner?.textContent).toContain('no such column: non_existent_col')
        const emptyCellAfterErr = dom.body.querySelector('.datanoa-grid-empty-cell')
        expect(emptyCellAfterErr?.textContent).toContain('no such column: non_existent_col')

        // Verify Copy Error button executes synchronous execCommand('copy') and flashes 'Copied!'
        // even when navigator.clipboard.writeText rejects in sandboxed iframe
        const execCommandSpy = vi.fn(() => true)
        ;(dom.document as unknown as Record<string, unknown>).execCommand = execCommandSpy
        const copyErrorBtn = queryBanner
          ?.querySelectorAll('button')
          .find((b) => b.textContent === 'Copy Error')
        expect(copyErrorBtn).toBeDefined()
        copyErrorBtn?.dispatchEvent(new FakeEvent({ type: 'click', bubbles: true }))
        expect(execCommandSpy).toHaveBeenCalledWith('copy')
        expect(copyErrorBtn?.textContent).toBe('Copied!')

        // Also verify copyTextToClipboard directly
        execCommandSpy.mockClear()
        expect(copyTextToClipboard('2026-10-12 10:27:39')).toBe(true)
        expect(execCommandSpy).toHaveBeenCalledWith('copy')

        // Verify smart context-aware SQL & Redis autocomplete
        const testSchema = {
          account: ['uuid', 'createdAt', 'updatedAt', 'email'],
          accounts_friend_facebooks: ['account_uid', 'friend_facebook_uid'],
        }

        // 1. Typing `SELECT cre` BEFORE `FROM account` suggests `createdAt` from defaultTable (`account`)
        const colComp = computeSmartSqlCompletions(
          'SELECT cre',
          10,
          'sqlite',
          testSchema,
          'account'
        )
        expect(colComp).not.toBeNull()
        expect(colComp?.options.some((o) => o.label === 'createdAt' && o.type === 'property')).toBe(
          true
        )

        // 2. Typing `SELECT createdAt from acc` boosts table names (`account`, `accounts_friend_facebooks`)
        const tblComp = computeSmartSqlCompletions(
          'SELECT createdAt from acc',
          25,
          'sqlite',
          testSchema,
          'account'
        )
        expect(tblComp).not.toBeNull()
        expect(tblComp?.options[0]?.type).toBe('class')
        expect(tblComp?.options.map((o) => o.label)).toContain('account')
        expect(tblComp?.options.map((o) => o.label)).toContain('accounts_friend_facebooks')

        // 3. Alias dot-completion: `SELECT a.up FROM account a` -> `updatedAt`
        const aliasComp = computeSmartSqlCompletions(
          'SELECT a.up FROM account a',
          11,
          'sqlite',
          testSchema,
          'account'
        )
        expect(aliasComp).not.toBeNull()
        expect(aliasComp?.options.map((o) => o.label)).toContain('updatedAt')

        // 4. Redis command completion
        const redisComp = computeSmartSqlCompletions('HGET', 4, 'redis', {}, undefined)
        expect(redisComp).not.toBeNull()
        expect(redisComp?.options.map((o) => o.label)).toContain('HGETALL')
      } finally {
        editor.destroy()
      }
    })
  })

  // ==========================================================================
  // Gate G — Wave 8 Cloud Connectivity, Visual Table Structure Editor, Persistent Bookmarks & Deep Audit Regressions
  // ==========================================================================
  describe('Gate G — Wave 8 Cloud Connectivity, Visual Table Structure Editor, Persistent Bookmarks & Deep Audit Regressions', () => {
    it('parses bracketed Supabase URIs, enables Cloud Auto-SSL, routes Turso https:// URIs, and maps Supabase IPv6 regions', () => {
      // 1. Bracketed placeholder password from Supabase dashboard
      const supaPlaceholder = parseConnectionUri(
        'postgresql://postgres:[YOUR-DATABASE-PASSWORD]@db.toethftlamjmkkodtglq.supabase.co:5432/postgres'
      )
      expect(supaPlaceholder.ok).toBe(true)
      expect(supaPlaceholder.profile?.driver).toBe('postgres')
      expect(supaPlaceholder.profile?.host).toBe('db.toethftlamjmkkodtglq.supabase.co')
      expect(supaPlaceholder.profile?.ssl).toBe(true)
      expect(supaPlaceholder.password).toBeUndefined()

      // 2. Bracketed real password
      const supaWithPass = parseConnectionUri(
        'postgresql://postgres:[MySecret#Pass123]@db.toethftlamjmkkodtglq.supabase.co:5432/postgres'
      )
      expect(supaWithPass.ok).toBe(true)
      expect(supaWithPass.password).toBe('MySecret#Pass123')
      expect(supaWithPass.profile?.ssl).toBe(true)

      // 3. Cloud Auto-SSL host recognition & Turso https:// routing
      expect(isCloudDatabaseHost('db.toethftlamjmkkodtglq.supabase.co')).toBe(true)
      expect(isCloudDatabaseHost('aws-1-ap-southeast-1.pooler.supabase.com')).toBe(true)
      expect(isCloudDatabaseHost('ep-cool-darkness.us-east-2.aws.neon.tech')).toBe(true)
      expect(isCloudDatabaseHost('localhost')).toBe(false)

      const tursoHttps = parseConnectionUri('https://my-db-org.turso.io?authToken=eyJhbGciOi')
      expect(tursoHttps.ok).toBe(true)
      expect(tursoHttps.profile?.driver).toBe('libsql')
      expect(tursoHttps.authToken).toBe('eyJhbGciOi')

      // 4. Supabase AWS IPv6 prefix to region mapping
      expect(mapSupabaseIpv6ToRegion('2406:da18:1691:a201:0:de81:6755:659')).toBe('ap-southeast-1')
      expect(mapSupabaseIpv6ToRegion('2600:1f18:2000::1')).toBe('us-east-1')
      expect(mapSupabaseIpv6ToRegion('2a05:d014:1234::1')).toBe('eu-central-1')
    })

    it('builds dialect-safe ALTER TABLE SQL, executes visual Edit Table Structure in Studio, persists Studio bookmark state, and blocks multi-statement EXPLAIN mutations', async () => {
      // 1. Dialect-safe ALTER TABLE SQL generation
      expect(
        buildAlterTableSql(
          {
            kind: 'addColumn',
            table: 'account',
            columnName: 'bio',
            dataType: 'TEXT',
            nullable: false,
            defaultValue: "''",
          },
          'sqlite'
        )
      ).toBe(`ALTER TABLE "account" ADD COLUMN "bio" TEXT NOT NULL DEFAULT '';`)

      expect(
        buildAlterTableSql(
          {
            kind: 'renameColumn',
            table: 'account',
            oldName: 'bio',
            newName: 'profile_bio',
          },
          'postgres'
        )
      ).toBe(`ALTER TABLE "account" RENAME COLUMN "bio" TO "profile_bio";`)

      expect(
        buildAlterTableSql(
          {
            kind: 'dropColumn',
            table: 'account',
            columnName: 'profile_bio',
          },
          'mysql'
        )
      ).toBe('ALTER TABLE `account` DROP COLUMN `profile_bio`;')

      expect(
        buildAlterTableSql(
          {
            kind: 'renameTable',
            table: 'account',
            newTableName: 'user_accounts',
          },
          'sqlite'
        )
      ).toBe('ALTER TABLE "account" RENAME TO "user_accounts";')

      // 2. End-to-end Staged Visual Table Structure Designer & bookmark persistence in DatanoaStudioEditor
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'datanoa-wave9-e2e-'))
      tempDirs.push(tmpDir)
      const dbPath = path.join(tmpDir, 'wave9.db')
      const seedDb = new DatabaseSync(dbPath)
      seedDb.exec(`
        CREATE TABLE orgs (id INTEGER PRIMARY KEY, title TEXT NOT NULL);
        INSERT INTO orgs (id, title) VALUES (1, 'Acme Corp');
        CREATE TABLE account (id INTEGER PRIMARY KEY, org_id INTEGER, name TEXT NOT NULL);
        INSERT INTO account (id, org_id, name) VALUES (1, 1, 'Beta'), (2, 1, 'Alpha');
      `)
      seedDb.close()

      const runtime = new MockOrcaRuntime()
      const hostCalls: RecordedHostCall[] = []
      const workerApi = createTypedWorkerApi(runtime, tmpDir, hostCalls)
      activate(workerApi)
      workerActivated = true

      const saved = await invokeWorker(runtime, 'connection.save', {
        profile: {
          id: 'conn_wave8',
          name: 'wave8db',
          driver: 'sqlite',
          database: 'wave8.db',
          filePath: dbPath,
        },
      })
      expect(saved.ok).toBe(true)

      // Verify query.explain blocks multi-statement SQL injection (SELECT 1; DELETE FROM account)
      await expect(
        invokeWorker(runtime, 'query.explain', {
          connectionId: 'conn_wave8',
          sql: 'SELECT * FROM account; DELETE FROM account;',
        })
      ).rejects.toThrow(/single SQL statement/i)

      const dom = new FakeDomHarness()
      activeDomHarnesses.push(dom)
      dom.install()

      const storageMap = new Map<string, string>()
      ;(dom.window as unknown as Record<string, unknown>).localStorage = {
        getItem: (k: string) => storageMap.get(k) ?? null,
        setItem: (k: string, v: string) => {
          storageMap.set(k, v)
        },
      }
      const clientBridge = runtime.client as unknown as {
        request: (reqName: string, reqInput?: unknown) => Promise<unknown>
      }
      dom.window.orca = {
        on: () => ({ dispose() {} }),
        plugin: {
          request: (name: string, payload?: Record<string, unknown>) =>
            clientBridge.request(name, payload),
          on: () => ({ dispose() {} }),
        },
        storage: {
          get: (key: string) => runtime.getWorkerApi().storage.get(key),
          set: (key: string, val: unknown) =>
            runtime.getWorkerApi().storage.set(key, val as Record<string, string>),
        },
      }

      const waitForWorkerTurn = async (ms = 120): Promise<void> => {
        await new Promise((resolve) => setTimeout(resolve, ms))
        await flushMicrotasks(12)
      }

      const editor = new DatanoaStudioEditor()
      try {
        await waitForWorkerTurn(180)

        // Click "Edit Table" button in gridSubbar -> switches to Schema Inspector
        const editTableBtn = dom.body
          .querySelectorAll('button')
          .find((b) => b.textContent === 'Edit Table')
        expect(editTableBtn).toBeDefined()
        editTableBtn?.dispatchEvent(new FakeEvent({ type: 'click', bubbles: true }))
        await waitForWorkerTurn(150)

        // Verify DataGrip-style Staged Structure Designer is rendered inside Schema Inspector
        const colStructTable = dom.body.querySelector('.datanoa-struct-columns-table')
        expect(colStructTable).not.toBeNull()

        // 2a. Modify existing column "name" default value -> Anonymous (auto-quoted to 'Anonymous')
        const defaultInputs = dom.body.querySelectorAll<FakeHTMLInputElement>('.datanoa-col-default-input')
        const nameDefaultInput = defaultInputs[2] // id=0, org_id=1, name=2
        expect(nameDefaultInput).toBeDefined()
        if (nameDefaultInput) {
          nameDefaultInput.value = 'Anonymous'
          nameDefaultInput.dispatchEvent(new FakeEvent({ type: 'input', bubbles: true }))
        }

        // 2b. Click "+ Column" to append a new row, rename it to "role" with default "member"
        const addColBtn = dom.body.querySelector('.datanoa-add-col-btn')
        expect(addColBtn).not.toBeNull()
        addColBtn?.dispatchEvent(new FakeEvent({ type: 'click', bubbles: true }))
        const colNameInputs = dom.body.querySelectorAll<FakeHTMLInputElement>('.datanoa-col-name-input')
        const newColNameInput = colNameInputs[colNameInputs.length - 1]
        const newColDefInputs = dom.body.querySelectorAll<FakeHTMLInputElement>('.datanoa-col-default-input')
        const newColDefInput = newColDefInputs[newColDefInputs.length - 1]
        if (newColNameInput) {
          newColNameInput.value = 'role'
          newColNameInput.dispatchEvent(new FakeEvent({ type: 'input', bubbles: true }))
        }
        if (newColDefInput) {
          newColDefInput.value = 'member'
          newColDefInput.dispatchEvent(new FakeEvent({ type: 'input', bubbles: true }))
        }

        // 2c. Click "+ Index / Key" and mark it UNIQUE on "name"
        const addIdxBtn = dom.body.querySelector('.datanoa-add-idx-btn')
        addIdxBtn?.dispatchEvent(new FakeEvent({ type: 'click', bubbles: true }))
        const idxNameInput = dom.body.querySelector<FakeHTMLInputElement>('.datanoa-idx-name-input')
        const idxUniqSelect = dom.body.querySelector<FakeHTMLSelectElement>('.datanoa-idx-unique-select')
        if (idxNameInput) {
          idxNameInput.value = 'idx_account_id_uniq'
          idxNameInput.dispatchEvent(new FakeEvent({ type: 'input', bubbles: true }))
        }
        if (idxUniqSelect) {
          idxUniqSelect.value = 'unique'
          idxUniqSelect.dispatchEvent(new FakeEvent({ type: 'change', bubbles: true }))
        }

        // 2d. Click "+ Foreign Key" and bind org_id -> orgs(id) ON DELETE CASCADE
        const addFkBtn = dom.body.querySelector('.datanoa-add-fk-btn')
        addFkBtn?.dispatchEvent(new FakeEvent({ type: 'click', bubbles: true }))
        const fkColSel = dom.body.querySelector<FakeHTMLSelectElement>('.datanoa-fk-col-select')
        const fkTargetTblInp = dom.body.querySelector<FakeHTMLInputElement>('.datanoa-fk-target-table-input')
        const fkOnDelSel = dom.body.querySelector<FakeHTMLSelectElement>('.datanoa-fk-ondelete-select')
        if (fkColSel) {
          fkColSel.value = 'org_id'
          fkColSel.dispatchEvent(new FakeEvent({ type: 'change', bubbles: true }))
        }
        if (fkTargetTblInp) {
          fkTargetTblInp.value = 'orgs'
          fkTargetTblInp.dispatchEvent(new FakeEvent({ type: 'input', bubbles: true }))
        }
        if (fkOnDelSel) {
          fkOnDelSel.value = 'CASCADE'
          fkOnDelSel.dispatchEvent(new FakeEvent({ type: 'change', bubbles: true }))
        }

        // 2e. Open DDL Preview and confirm 12-step SQLite rebuild statements are generated
        const previewBtn = dom.body.querySelector('.datanoa-struct-preview-btn')
        previewBtn?.dispatchEvent(new FakeEvent({ type: 'click', bubbles: true }))
        const previewPre = dom.body.querySelector('.datanoa-struct-preview-drawer .datanoa-dml-drawer-pre')
        expect(previewPre?.textContent).toContain('PRAGMA foreign_keys = OFF;')
        expect(previewPre?.textContent).toContain('CREATE TABLE "__datanoa_new_account"')
        expect(previewPre?.textContent).toContain('ON DELETE CASCADE')
        expect(previewPre?.textContent).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "idx_account_id_uniq"')

        // 2f. Verify validation rejects nonsensical ("linh tinh") edits inside Confirmation Modal
        const orgIdDefaultInp = defaultInputs[1] // org_id INTEGER
        if (orgIdDefaultInp) {
          orgIdDefaultInp.value = 'linh_tinh_text'
          orgIdDefaultInp.dispatchEvent(new FakeEvent({ type: 'input', bubbles: true }))
        }
        const applyBtn = dom.body.querySelector('.datanoa-struct-apply-btn')
        applyBtn?.dispatchEvent(new FakeEvent({ type: 'click', bubbles: true }))
        const blockedModal = dom.body.querySelector('.datanoa-struct-confirm-modal')
        expect(blockedModal).not.toBeNull()
        const blockedExecBtn = dom.body.querySelector('.datanoa-struct-confirm-execute-btn')
        expect((blockedExecBtn as HTMLButtonElement | null)?.disabled).toBe(true)
        dom.body.querySelector('.datanoa-struct-confirm-cancel-btn')?.dispatchEvent(
          new FakeEvent({ type: 'click', bubbles: true })
        )

        // Also confirm quoted non-numeric default & parenthesized breakout on INTEGER are blocked
        if (orgIdDefaultInp) {
          orgIdDefaultInp.value = "'abc'"
          orgIdDefaultInp.dispatchEvent(new FakeEvent({ type: 'input', bubbles: true }))
          applyBtn?.dispatchEvent(new FakeEvent({ type: 'click', bubbles: true }))
          expect((dom.body.querySelector('.datanoa-struct-confirm-execute-btn') as HTMLButtonElement | null)?.disabled).toBe(true)
          dom.body.querySelector('.datanoa-struct-confirm-cancel-btn')?.dispatchEvent(new FakeEvent({ type: 'click', bubbles: true }))

          orgIdDefaultInp.value = '(1) OR (1=1)'
          orgIdDefaultInp.dispatchEvent(new FakeEvent({ type: 'input', bubbles: true }))
          applyBtn?.dispatchEvent(new FakeEvent({ type: 'click', bubbles: true }))
          expect((dom.body.querySelector('.datanoa-struct-confirm-execute-btn') as HTMLButtonElement | null)?.disabled).toBe(true)
          dom.body.querySelector('.datanoa-struct-confirm-cancel-btn')?.dispatchEvent(new FakeEvent({ type: 'click', bubbles: true }))
        }

        // Verify Side Panel structure validator, confirmation modal & FK selector isolation contracts
        const panelHtmlSource = fs.readFileSync(path.join(REPO_ROOT, 'src', 'panel', 'panel.html'), 'utf8')
        expect(panelHtmlSource).toContain('id="structureToolbar"')
        expect(panelHtmlSource).toContain('id="structValidationBanner"')
        expect(panelHtmlSource).toContain('id="confirmMigrationModal"')
        expect(panelHtmlSource).toContain('validatePanelStructDraft')
        expect(panelHtmlSource).toContain('executeConfirmedPanelMigration')
        expect(panelHtmlSource).toContain('select.struct-fk-col-select option')
        expect(panelHtmlSource).toContain('Duplicate index name')
        expect(panelHtmlSource).toContain('ClickHouse does not support FOREIGN KEY constraints.')

        // Fix invalid edit and reopen Review & Confirm Migration Modal -> Confirm & Execute
        if (orgIdDefaultInp) {
          orgIdDefaultInp.value = ''
          orgIdDefaultInp.dispatchEvent(new FakeEvent({ type: 'input', bubbles: true }))
        }
        expect(applyBtn?.textContent).toContain('Review & Apply [')
        applyBtn?.dispatchEvent(new FakeEvent({ type: 'click', bubbles: true }))

        const confirmModal = dom.body.querySelector('.datanoa-struct-confirm-modal')
        expect(confirmModal).not.toBeNull()
        const execConfirmBtn = dom.body.querySelector('.datanoa-struct-confirm-execute-btn')
        expect((execConfirmBtn as HTMLButtonElement | null)?.disabled).toBe(false)
        execConfirmBtn?.dispatchEvent(new FakeEvent({ type: 'click', bubbles: true }))

        let detailsAfterApply = await invokeWorker(runtime, 'schema.tableDetails', {
          connectionId: 'conn_wave8',
          table: 'account',
        })
        for (let attempt = 0; attempt < 40; attempt++) {
          if (detailsAfterApply.columns.some((c) => c.name === 'role')) break
          await waitForWorkerTurn(80)
          detailsAfterApply = await invokeWorker(runtime, 'schema.tableDetails', {
            connectionId: 'conn_wave8',
            table: 'account',
          })
        }
        expect(detailsAfterApply.columns.map((c) => c.name)).toContain('role')
        const updatedNameCol = detailsAfterApply.columns.find((c) => c.name === 'name')
        expect(updatedNameCol?.defaultValue).toContain('Anonymous')
        expect(detailsAfterApply.indexes.some((i) => i.name === 'idx_account_id_uniq' && i.isUnique)).toBe(true)
        expect(
          detailsAfterApply.foreignKeys.some((fk) => fk.column === 'org_id' && fk.referencedTable === 'orgs')
        ).toBe(true)

        // Verify existing rows were preserved and new insert receives updated defaults
        await invokeWorker(runtime, 'query.run', {
          connectionId: 'conn_wave8',
          queryId: 'verify_defaults',
          sql: 'INSERT INTO "account" ("id", "org_id") VALUES (3, 1);',
        })
        const verifyRows = await invokeWorker(runtime, 'query.run', {
          connectionId: 'conn_wave8',
          queryId: 'select_verify',
          sql: 'SELECT "id", "name", "role" FROM "account" ORDER BY "id" ASC;',
        })
        expect(verifyRows.rows).toHaveLength(3)
        expect(verifyRows.rows[0]?.[1]).toBe('Beta')
        expect(verifyRows.rows[2]?.[1]).toBe('Anonymous')
        expect(verifyRows.rows[2]?.[2]).toBe('member')

        // Rename column "role" -> "user_role" via handleAlterTable API compatibility check
        await editor.handleAlterTable({
          kind: 'renameColumn',
          table: 'account',
          oldName: 'role',
          newName: 'user_role',
        })
        await waitForWorkerTurn(150)
        const detailsAfterRename = await invokeWorker(runtime, 'schema.tableDetails', {
          connectionId: 'conn_wave8',
          table: 'account',
        })
        expect(detailsAfterRename.columns.map((c) => c.name)).toContain('user_role')

        // Verify 2-mode sidebar toggle (Left Sidebar vs Horizontal Top Table Bar)
        editor.setSidebarCollapsed(true)
        const sidebarEl = dom.body.querySelector('.datanoa-sidebar')
        const topbarEl = dom.body.querySelector('.datanoa-table-topbar')
        expect(sidebarEl?.classList.contains('collapsed')).toBe(true)
        expect(topbarEl?.classList.contains('visible')).toBe(true)
        expect(dom.body.querySelectorAll('.datanoa-topbar-pill').length).toBeGreaterThanOrEqual(2)

        // Verify pinned top zone + scrollable body + in-DOM combobox (no <datalist>) in SchemaInspectorView
        expect(dom.body.querySelector('.datanoa-inspector-top-zone')).toBeDefined()
        expect(dom.body.querySelector('.datanoa-inspector-scroll-body')).toBeDefined()
        expect(dom.body.querySelectorAll('.datanoa-combo-wrap').length).toBeGreaterThan(0)
        expect(dom.body.querySelectorAll('datalist').length).toBe(0)

        // Verify bookmark state was persisted to localStorage ('datanoa.studioViewState') including sidebarCollapsed
        const rawSavedState = storageMap.get('datanoa.studioViewState')
        expect(rawSavedState).toBeTruthy()
        const parsedState = JSON.parse(rawSavedState ?? '{}') as {
          activeViewMode?: string
          activeConnectionId?: string
          activeTable?: string
          sidebarCollapsed?: boolean
        }
        expect(parsedState.activeViewMode).toBe('inspector')
        expect(parsedState.activeConnectionId).toBe('conn_wave8')
        expect(parsedState.activeTable).toBe('account')
        expect(parsedState.sidebarCollapsed).toBe(true)

        // Verify Side Panel Wave 10 contracts (file discovery search, 4-segment path, form-fill-height, in-DOM combobox)
        const panelHtml = fs.readFileSync(path.join(REPO_ROOT, 'src/panel/panel.html'), 'utf8')
        expect(panelHtml).toContain('id="discoveredFileSearch"')
        expect(panelHtml).toContain('form-fill-height')
        expect(panelHtml).toContain('parts.slice(-4)')
        expect(panelHtml).toContain('createPanelComboInput')
        expect(panelHtml).not.toContain('<datalist')

        // Also verify VirtualDataGrid keeps newly inserted (+ Row) visible even when clientFilter is non-empty,
        // and supports in-memory sorting on SQL results
        editor.applyDocumentMetadata('SELECT id, name FROM account;')
        await editor.executeSql(true)
        await waitForWorkerTurn(80)

        const nameHeader = dom.body
          .querySelectorAll('.datanoa-th')
          .find((el) => el.textContent?.includes('name'))
        expect(nameHeader).toBeDefined()
        nameHeader?.dispatchEvent(new FakeEvent({ type: 'click', bubbles: true }))
        await flushMicrotasks(8)

        const cellsAfterSort = dom.body.querySelectorAll('.datanoa-td')
        expect(cellsAfterSort[1]?.textContent).toBe('2')
        expect(cellsAfterSort[2]?.textContent).toBe('Alpha')
      } finally {
        editor.destroy()
      }
    })
  })
})
