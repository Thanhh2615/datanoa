import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorState, EditorView, history, historyKeymap } from '../vendor/codemirror.js'
import { formatJsonPreservingNumbers } from '../src/shared-grid-paste.js'
import {
  AI_MAX_IPC_PREFIX_CHARS,
  AI_MAX_IPC_SUFFIX_CHARS,
  createCmInlineAiExtension,
  trackAcceptance,
} from '../src/shared-cm-inline-ai.js'
import {
  clearDbSqlErrorEffect,
  createCmSqlLintExtension,
  setDbSqlErrorEffect,
  sqlDiagnosticsField,
  triggerSqlLintEffect,
} from '../src/shared-cm-sql-lint.js'
import {
  formatAiStatusBadge,
  getAiPanelMaxHeight,
  openSharedAiConfigModal,
  renderAiStatusButtonContent,
  renderSharedAiFixPanel,
  renderSharedExplainAiPanel,
  resolveExplainAiPhase,
} from '../src/shared-ai-ui.js'
import { CLICKHOUSE_LOGO_RECTS } from '../src/shared-db-icons.js'
import { ValueInspectorController } from '../src/editor/value-inspector.js'
import { TransactionToolbarController } from '../src/editor/transaction-toolbar.js'
import {
  SqlConsoleController,
  extractExecutionRange,
  replaceEditorSqlRange,
} from '../src/editor/console.js'
import { createStudioDomTree } from '../src/editor/studio-dom.js'
import {
  createPanelCodeMirrorEditor,
  extractPanelExecutionRange,
  replacePanelSqlRange,
} from '../src/panel/panel-cm.js'
import { createPanelSqlController } from '../src/panel/panel-sql.js'
import {
  STUDIO_VIEW_STATE_STORAGE_KEY,
  STUDIO_WARM_CACHE_STORAGE_KEY,
  scrubSensitiveStringForLocalStorage,
  writeLocalStudioWarmCache,
  writeStudioViewStateSnapshot,
} from '../src/editor/document-meta.js'
import { openStudioDangerSqlModal } from '../src/editor/danger-sql-modal.js'
import { openStudioConnectionModal } from '../src/editor/connection-modal.js'
import { formatDdlForDisplay, normalizeTableDetailsForDraft } from '../src/editor/schema-ddl.js'
import { EDITOR_STYLE } from '../src/editor/theme.js'
import { DatanoaStudioEditor } from '../src/editor/index.js'
import {
  DATANOA_VERSION,
  buildPanelMigrationSql,
  createPanelStructDraft,
  scrubClientUrlCredentials,
} from '../src/panel/panel-core.js'
import { createPanelConnectionFormController } from '../src/panel/panel-connection-form.js'
import { createPanelDataGridController } from '../src/panel/panel-data-grid.js'
import { createPanelStructureController } from '../src/panel/panel-structure.js'
import type { AiStatusSnapshot, ConnectionProfile, TableDetails, TransactionState } from '../src/protocol.js'
import { installDomHarness, type DomHarness } from './helpers/dom-harness.js'

let activeDom: DomHarness | null = null

afterEach(() => {
  vi.useRealTimers()
  if (activeDom) {
    activeDom.teardown()
    activeDom = null
  }
})

function setupDom(withPanelHtml = false): DomHarness {
  const dom = installDomHarness()
  activeDom = dom
  if (withPanelHtml) {
    dom.mountPanelHtml()
  }
  return dom
}

describe('v1.2.0 Wave 4 UI Parity, Security & /unslop Regressions', () => {
  describe('[MED-5] Lossless BigInt JSON formatter & Value Inspector dirty-state guard', () => {
    it('formatJsonPreservingNumbers preserves unquoted BigInts, decimals, exponents, strings & empties cleanly', () => {
      const raw =
        '\uFEFF{"big":9007199254740993,"neg":-9223372036854775807,"dotZero":9007199254740993.0,"sci":1e30,"tricky":":,{}[]\\"9007199254740993\\"","emptyObj":{},"emptyArr":[]}'
      const pretty = formatJsonPreservingNumbers(raw, 2)
      expect(pretty).toContain('"big": 9007199254740993,')
      expect(pretty).toContain('"neg": -9223372036854775807,')
      expect(pretty).toContain('"dotZero": 9007199254740993.0,')
      expect(pretty).toContain('"sci": 1e30,')
      expect(pretty).toContain('"tricky": ":,{}[]\\"9007199254740993\\"",')
      expect(pretty).toContain('"emptyObj": {},')
      expect(pretty).toContain('"emptyArr": []')

      const minified = formatJsonPreservingNumbers(pretty, 0)
      expect(minified).toBe(
        '{"big":9007199254740993,"neg":-9223372036854775807,"dotZero":9007199254740993.0,"sci":1e30,"tricky":":,{}[]\\"9007199254740993\\"","emptyObj":{},"emptyArr":[]}'
      )
      expect(() => formatJsonPreservingNumbers('{"bad": 1,}')).toThrow(SyntaxError)
    })

    it('Studio ValueInspectorController keeps BigInt unquoted, disables Apply on unmodified non-null cell, and allows Apply on null cell', async () => {
      const dom = setupDom()
      const inspectBtn = document.createElement('button')
      const updateCalls: Array<{ newValue: unknown }> = []
      const fakeGrid = {
        handleViewportResize: () => {},
        isBatchMode: () => false,
        getStagedCount: () => 0,
        stageCellEdit: () => {},
        getModel: () => ({
          headers: ['id', 'payload'],
          rows: [{ id: 1, payload: '{"id":9007199254740993}' }],
          primaryKey: ['id'],
        }),
      }
      const ctrl = new ValueInspectorController({
        getInspectButton: () => inspectBtn,
        getDataGrid: () => fakeGrid as unknown as ReturnType<ConstructorParameters<typeof ValueInspectorController>[0]['getDataGrid']>,
        getActiveTarget: () => ({
          connectionId: 'c1',
          table: 'items',
          page: 1,
          viewSeq: 1,
        }),
        updateCell: async (params) => {
          updateCalls.push({ newValue: params.newValue })
          return { ok: true }
        },
        reloadTableData: async () => {},
        updateStatus: () => {},
      })

      const root = ctrl.buildElement()
      document.body.appendChild(root)

      ctrl.open({
        rowIndex: 0,
        colIndex: 1,
        columnName: 'payload',
        columnType: 'JSON',
        value: '{"id":9007199254740993,"neg":-9223372036854775807}',
        isEditable: true,
        isInserted: false,
        isDeleted: false,
        isNullable: true,
      })

      const ta = root.querySelector('.datanoa-value-textarea') as HTMLTextAreaElement
      const buttons = Array.from(root.querySelectorAll('button'))
      const applyBtn = buttons.find((b) => b.textContent === 'Apply') as HTMLButtonElement
      const minifyBtn = buttons.find((b) => b.textContent === 'Minify JSON') as HTMLButtonElement
      const prettyBtn = buttons.find((b) => b.textContent === 'Format JSON') as HTMLButtonElement

      // Unquoted lossless BigInt preserved on initial open
      expect(ta.value).toContain('"id": 9007199254740993')
      expect(ta.value).toContain('"neg": -9223372036854775807')
      // Apply starts disabled on unmodified non-null cell, and Ctrl+Enter is blocked
      expect(applyBtn.disabled).toBe(true)
      dom.fireKey(ta, 'Enter', { ctrlKey: true })
      await dom.flushMicrotasks()
      expect(updateCalls).toHaveLength(0)

      // Minify preserves exact BigInt and enables Apply because text changed from initialDisplayText
      minifyBtn.click()
      expect(ta.value).toBe('{"id":9007199254740993,"neg":-9223372036854775807}')
      expect(applyBtn.disabled).toBe(false)

      // Format back to identical initialDisplayText disables Apply again
      prettyBtn.click()
      expect(ta.value).toContain('"id": 9007199254740993')
      expect(applyBtn.disabled).toBe(true)

      // Typing enables Apply and saves exact value
      dom.setInput(ta, '{"id":9007199254740993,"edited":true}', 'input')
      expect(applyBtn.disabled).toBe(false)
      applyBtn.click()
      await dom.flushMicrotasks()
      expect(updateCalls).toHaveLength(1)
      expect(String(updateCalls[0].newValue)).toContain('9007199254740993')
      // After successful save, Apply returns to disabled
      expect(applyBtn.disabled).toBe(true)

      // NULL cell allows applying immediately (to save empty string "")
      ctrl.open({
        rowIndex: 0,
        colIndex: 1,
        columnName: 'payload',
        columnType: 'TEXT',
        value: null,
        isEditable: true,
        isInserted: false,
        isDeleted: false,
        isNullable: true,
      })
      expect(applyBtn.disabled).toBe(false)

      ctrl.destroy()
    })

    it('Side Panel panel-data-grid.js renderValueInspector preserves BigInt unquoted', () => {
      setupDom(true)
      const state = {
        activeConnectionId: 'c1',
        activeTable: 'items',
        activeSchema: undefined,
        pageData: {
          columns: [{ name: 'id', type: 'INTEGER', nullable: false }, { name: 'doc', type: 'JSON', nullable: true }],
          rows: [{ id: 1, doc: '{"big":9007199254740993}' }],
          primaryKey: ['id'],
          canEdit: true,
        },
        stagedInserts: [],
        stagedUpdates: new Map(),
        stagedDeletes: new Map(),
        selectedRowKey: 'row_0',
        selectedCol: 'doc',
        inspectorOpen: true,
        inspectorCollapsed: false,
        hiddenColsByTable: {},
        pinnedColsByTable: {},
        columnWidthsByTable: {},
        findMatches: [],
        findMatchSet: new Set(),
        findMatchIdx: -1,
      }
      const ctrl = createPanelDataGridController({
        state: { ...state, schemaObjects: { c1: [] } },
        VIRT_ROW_HEIGHT_PX: 26,
        VIRT_OVERSCAN_ROWS: 10,
        getActiveConn: () => ({ id: 'c1', driver: 'sqlite', readOnly: false }),
        isSubmittingChanges: () => false,
        isPreviewingDml: () => false,
        getStagedCount: () => 0,
        getTablePrefsKey: () => 'c1::items',
        getAllDisplayRows: () => [{ rowKey: '0', rowIndex: 0, data: state.pageData.rows[0], isInsert: false }],
        getActiveGridSelection: () => null,
        setInspectorUserModified: () => {},
        updateInspectorMetaAndJson: () => {},
        showBanner: () => {},
        renderDataGrid: () => {},
        updateViewportLayout: () => {},
        savePanelViewState: () => {},
        loadTablePage: async () => {},
        clearDataFindState: () => {},
        closeDataColsPopover: () => {},
        isStagingBusy: () => false,
        openBulkFillModal: () => {},
        copyText: async () => {},
      })

      ctrl.renderValueInspector()
      const ta = document.getElementById('valueInspectorText') as HTMLTextAreaElement
      expect(ta.value).toContain('"big": 9007199254740993')
    })
  })

  describe('[MED-11] & [HIGH-8] Side Panel TLS form parity, verify toggle & reload persistence', () => {
    it('enforces fail-closed SSL toggle, Verify TLS checkbox, edit-mode non-resurrection & URI verify-full', async () => {
      const dom = setupDom(true)
      const existingProfile: ConnectionProfile = {
        id: 'conn_pg_tls',
        name: 'Prod PG',
        driver: 'postgres',
        host: 'db.prod.internal',
        port: 5432,
        database: 'app',
        user: 'admin',
        ssl: true,
        sslMode: 'verify-full',
        sslRejectUnauthorized: true,
        sslCaPath: '/etc/ssl/ca.pem',
        sshEnabled: true,
        sshHost: 'bastion.internal',
      }
      const state: Record<string, unknown> = {
        formOpen: true,
        formDriver: 'postgres',
        formColorTag: 'none',
        editingId: null,
        formSslMode: undefined,
        formSslRejectUnauthorized: undefined,
        formSslTouched: false,
        connections: [existingProfile],
        discoveredEnvs: [],
        discoveredDocker: [],
        discoveredFiles: [],
      }

      ;(window as unknown as { orca: unknown }).orca = {
        plugin: {
          request: async (method: string, payload?: Record<string, unknown>) => {
            if (method === 'connection.parseUri') {
              const uri = String(payload?.uri || '')
              if (uri.includes('sslmode=verify-full')) {
                return {
                  ok: true,
                  profile: {
                    driver: 'postgres',
                    host: 'secure.example.com',
                    port: 5432,
                    database: 'app',
                    user: 'u',
                    ssl: true,
                    sslMode: 'verify-full',
                    sslRejectUnauthorized: true,
                  },
                }
              }
              return {
                ok: true,
                profile: {
                  driver: 'postgres',
                  host: '127.0.0.1',
                  port: 5432,
                  database: 'localdb',
                  user: 'dev',
                  ssl: false,
                },
              }
            }
            return {}
          },
        },
      }

      const formCtrl = createPanelConnectionFormController({
        state,
        showBanner: () => {},
        showFormNotice: () => {},
        clearFormNotice: () => {},
        setFormOpen: () => {},
        updateViewportLayout: () => {},
        savePanelViewState: () => {},
      })
      formCtrl.initStaticSelectors()
      formCtrl.setFormDriver('postgres', true)

      const sslCheck = document.getElementById('formSsl') as HTMLInputElement
      const verifyRow = document.getElementById('sslVerifyRow') as HTMLElement
      const verifyCheck = document.getElementById('formSslVerify') as HTMLInputElement

      expect(sslCheck.checked).toBe(false)
      expect(verifyRow.hidden).toBe(true)

      // Toggle SSL ON -> fail-closed sslRejectUnauthorized: true, verify checkbox shown & checked
      dom.setInput(sslCheck, true, 'change')
      expect(verifyRow.hidden).toBe(false)
      expect(verifyCheck.checked).toBe(true)
      expect(verifyCheck.disabled).toBe(false)
      expect(state.formSslRejectUnauthorized).toBe(true)

      const subDefaultTls = formCtrl.buildFormSubmission('new_1')
      expect(subDefaultTls.profile.ssl).toBe(true)
      expect(subDefaultTls.profile.sslRejectUnauthorized).toBe(true)

      // Uncheck Verify TLS -> explicit opt-out sslRejectUnauthorized: false
      dom.setInput(verifyCheck, false, 'change')
      const subOptOut = formCtrl.buildFormSubmission('new_2')
      expect(subOptOut.profile.sslRejectUnauthorized).toBe(false)

      // Parse verify-full URI -> verifyCheck checked & disabled
      await formCtrl.handleParseUri('postgres://u:p@secure.example.com:5432/app?sslmode=verify-full')
      expect(state.formSslMode).toBe('verify-full')
      expect(sslCheck.checked).toBe(true)
      expect(verifyRow.hidden).toBe(false)
      expect(verifyCheck.checked).toBe(true)
      expect(verifyCheck.disabled).toBe(true)

      // Edit existing verify-full profile -> parse local URI (ssl: false) -> MUST NOT resurrect existing.sslMode
      formCtrl.populateFormFromProfile(existingProfile, 'edit')
      expect(state.formSslMode).toBe('verify-full')
      expect(state.formSslTouched).toBe(false)

      await formCtrl.handleParseUri('postgres://dev:pw@127.0.0.1:5432/localdb')
      expect(state.formSslTouched).toBe(true)
      const editedSub = formCtrl.buildFormSubmission(existingProfile.id)
      expect(editedSub.profile.ssl).toBe(false)
      expect(editedSub.profile.sslMode).toBe('disable')
      expect(editedSub.profile.sslRejectUnauthorized).toBeUndefined()
      // Unrelated extended fields from existing profile remain preserved
      expect(editedSub.profile.sshEnabled).toBe(true)
      expect(editedSub.profile.sslCaPath).toBe('/etc/ssl/ca.pem')
    })

    it('persists and restores formDraft TLS fields across panel-app.js reload', async () => {
      const dom = setupDom(true)
      const savedSnapshots: Array<Record<string, unknown>> = []
      const bootOrca = () => ({
        plugin: {
          request: async (method: string, payload?: Record<string, unknown>) => {
            if (method === 'connections.list') return []
            if (method === 'ui.getSessionSnapshot') return { viewState: null, dataCache: null, updatedAt: 0 }
            if (method === 'ui.saveSessionSnapshot') {
              if (payload) savedSnapshots.push(payload)
              return { ok: true, updatedAt: Date.now() }
            }
            if (method === 'connection.parseUri') {
              return {
                ok: true,
                profile: {
                  driver: 'postgres',
                  host: 'pg.cloud.io',
                  port: 5432,
                  database: 'prod',
                  user: 'ops',
                  ssl: true,
                  sslMode: 'verify-full',
                  sslRejectUnauthorized: true,
                },
              }
            }
            if (method === 'ai.status.get') {
              return { enabled: false, state: 'off', destination: 'none', host: '' }
            }
            return {}
          },
          onEvent: () => ({ dispose: () => {} }),
        },
        host: { onEvent: () => ({ dispose: () => {} }), call: async () => ({}) },
        settings: { onDidChange: () => ({ dispose: () => {} }) },
      })

      ;(window as unknown as { orca: unknown }).orca = bootOrca()
      vi.resetModules()
      await import('../src/panel/panel-app.js')
      await new Promise((r) => setTimeout(r, 30))

      // Open connection form, parse verify-full URI (handleParseUri persists formDraft TLS fields)
      ;(document.getElementById('emptyAddConnBtn') as HTMLButtonElement | null)?.click()
      const uriInput = document.getElementById('uriInput') as HTMLInputElement
      uriInput.value = 'postgres://ops:secret@pg.cloud.io:5432/prod?sslmode=verify-full'
      ;(document.getElementById('parseUriBtn') as HTMLButtonElement).click()
      await new Promise((r) => setTimeout(r, 120))

      const rawSaved = dom.localStorage.getItem('datanoa.panelViewState') || ''
      const parsed = JSON.parse(rawSaved) as {
        formDraft?: { ssl?: boolean; sslMode?: string; sslRejectUnauthorized?: boolean; sslTouched?: boolean }
      }
      expect(parsed.formDraft?.ssl).toBe(true)
      expect(parsed.formDraft?.sslMode).toBe('verify-full')
      expect(parsed.formDraft?.sslRejectUnauthorized).toBe(true)
      expect(parsed.formDraft?.sslTouched).toBe(true)

      // Reload panel-app.js with persisted localStorage -> verify SSL verify UI restored
      dom.mountPanelHtml()
      ;(window as unknown as { orca: unknown }).orca = bootOrca()
      vi.resetModules()
      await import('../src/panel/panel-app.js')
      await new Promise((r) => setTimeout(r, 30))

      const sslAfter = document.getElementById('formSsl') as HTMLInputElement
      const verifyRowAfter = document.getElementById('sslVerifyRow') as HTMLElement
      const verifyAfter = document.getElementById('formSslVerify') as HTMLInputElement
      expect(sslAfter.checked).toBe(true)
      expect(verifyRowAfter.hidden).toBe(false)
      expect(verifyAfter.checked).toBe(true)
      expect(verifyAfter.disabled).toBe(true)
    })

    it('marks formSslTouched = true when applying a discovered Docker Compose chip in edit mode so existing sslMode is not resurrected', () => {
      setupDom(true)
      const existingProfile: ConnectionProfile = {
        id: 'conn_pg_docker_edit',
        name: 'Prod PG',
        driver: 'postgres',
        host: 'db.prod.internal',
        port: 5432,
        database: 'app',
        user: 'admin',
        ssl: true,
        sslMode: 'verify-full',
        sslRejectUnauthorized: true,
        sshEnabled: true,
        sshHost: 'bastion.internal',
      }
      const state: Record<string, unknown> = {
        formOpen: true,
        formDriver: 'postgres',
        formColorTag: 'none',
        editingId: null,
        formSslMode: undefined,
        formSslRejectUnauthorized: undefined,
        formSslTouched: false,
        connections: [existingProfile],
        discoveredEnvs: [],
        discoveredDocker: [
          {
            id: 'dc_local_nossl',
            project: 'app',
            service: 'pg-local',
            driver: 'postgres',
            name: 'Local Docker PG',
            host: '127.0.0.1',
            port: 5432,
            database: 'app_dev',
            user: 'postgres',
            ssl: false,
            sourceKind: 'live',
            sourceFile: 'docker-compose.yml',
            status: 'running',
            workspaceMatched: true,
          },
          {
            id: 'dc_local_ssl',
            project: 'app',
            service: 'pg-tls',
            driver: 'postgres',
            name: 'TLS Docker PG',
            host: '127.0.0.1',
            port: 5433,
            database: 'app_tls',
            user: 'postgres',
            ssl: true,
            sourceKind: 'live',
            sourceFile: 'docker-compose.yml',
            status: 'running',
            workspaceMatched: true,
          },
        ],
        discoveredFiles: [],
      }

      const formCtrl = createPanelConnectionFormController({
        state,
        showBanner: () => {},
        showFormNotice: () => {},
        clearFormNotice: () => {},
        setFormOpen: () => {},
        updateViewportLayout: () => {},
        savePanelViewState: () => {},
      })
      formCtrl.initStaticSelectors()
      formCtrl.populateFormFromProfile(existingProfile, 'edit')
      expect(state.formSslMode).toBe('verify-full')
      expect(state.formSslTouched).toBe(false)

      formCtrl.renderDiscoveredItems()
      const dockerChips = Array.from(
        document.querySelectorAll('#discoveredDockerList .file-chip')
      ) as HTMLButtonElement[]
      expect(dockerChips).toHaveLength(2)

      // Click non-SSL Docker Compose chip -> formSslTouched = true, existing verify-full NOT resurrected
      dockerChips[0].click()
      expect(state.formSslTouched).toBe(true)
      const subNoSsl = formCtrl.buildFormSubmission(existingProfile.id)
      expect(subNoSsl.profile.ssl).toBe(false)
      expect(subNoSsl.profile.sslMode).toBeUndefined()
      expect(subNoSsl.profile.sslRejectUnauthorized).toBeUndefined()
      expect(subNoSsl.profile.sshEnabled).toBe(true)

      // Click SSL Docker Compose chip -> formSslTouched = true, fail-closed sslRejectUnauthorized: true
      dockerChips[1].click()
      expect(state.formSslTouched).toBe(true)
      const subSsl = formCtrl.buildFormSubmission(existingProfile.id)
      expect(subSsl.profile.ssl).toBe(true)
      expect(subSsl.profile.sslMode).toBe('auto')
      expect(subSsl.profile.sslRejectUnauthorized).toBe(true)
    })
  })

  describe('[HIGH-9] Client-side localStorage & session snapshot secret scrubbing', () => {
    it('Studio document-meta.ts scrubs activeWhereClause, connections[].name, whereClause, lastSqlResult while keeping #top parity', () => {
      const dom = setupDom()

      // Parity contract: public scrubSensitiveStringForLocalStorage matches panelCore.scrubClientUrlCredentials on #top
      const benignHashUrl = 'https://ch.internal:8443/v1?notify=ops@corp.io#top'
      expect(scrubSensitiveStringForLocalStorage(benignHashUrl)).toBe(benignHashUrl)
      expect(scrubClientUrlCredentials(benignHashUrl)).toBe(benignHashUrl)

      writeStudioViewStateSnapshot({
        activeWhereClause: "token = 'TokSecret123'",
        sqlDraft: 'AUTH myRedisSecret99',
        consoleTabs: {
          activeTabId: 't1',
          tabs: [{ id: 't1', title: 'Query 1', sql: "ALTER USER admin WITH PASSWORD 'PwSecret77'" }],
        },
      })
      const rawView = dom.localStorage.getItem(STUDIO_VIEW_STATE_STORAGE_KEY) || ''
      expect(rawView).not.toContain('TokSecret123')
      expect(rawView).not.toContain('myRedisSecret99')
      expect(rawView).not.toContain('PwSecret77')

      writeLocalStudioWarmCache({
        updatedAt: Date.now(),
        connections: [
          {
            id: 'c1',
            name: 'prod :TopSec@db.internal libsql://turso.io?authToken=eyJSecret1',
            driver: 'libsql',
            database: 'main',
            url: 'libsql://turso.io/db#OpaqueSecretFragment',
            options: 'https://opt.internal/cfg#OptSecretFrag',
          },
        ],
        whereClause: "secret = 'WhereSec99'",
        lastSqlResult: {
          columns: [{ name: 'ok', type: 'TEXT' }],
          rows: [['OK']],
          rowCount: 1,
          executionTimeMs: 2,
          truncated: false,
          isSelect: false,
          resultSets: [
            {
              index: 0,
              sqlPreview: 'AUTH RedisSuperSecret',
              sql: 'AUTH RedisSuperSecret',
              errorMessage: 'failed https://u:ErrPass@h/db#ErrOpaque',
              columns: [],
              rows: [],
              rowCount: 0,
              truncated: false,
              isSelect: false,
            },
          ],
        },
      })
      const rawWarm = dom.localStorage.getItem(STUDIO_WARM_CACHE_STORAGE_KEY) || ''
      expect(rawWarm).not.toContain('TopSec')
      expect(rawWarm).not.toContain('eyJSecret1')
      expect(rawWarm).not.toContain('OpaqueSecretFragment')
      expect(rawWarm).not.toContain('OptSecretFrag')
      expect(rawWarm).not.toContain('WhereSec99')
      expect(rawWarm).not.toContain('RedisSuperSecret')
      expect(rawWarm).not.toContain('ErrPass')
      expect(rawWarm).not.toContain('ErrOpaque')
    })

    it('Side Panel panel-app.js scrubs whereClause, lastSqlResult, consoleTabsState & formDraft.name in both localStorage and ui.saveSessionSnapshot', async () => {
      const dom = setupDom(true)
      const workerSnapshots: Array<Record<string, unknown>> = []
      ;(window as unknown as { orca: unknown }).orca = {
        plugin: {
          request: async (method: string, payload?: Record<string, unknown>) => {
            if (method === 'connections.list') {
              return [
                {
                  id: 'c_sec',
                  name: 'redis :ConnNameSecret@cache.internal',
                  driver: 'redis',
                  host: '127.0.0.1',
                  port: 6379,
                  database: '0',
                },
              ]
            }
            if (method === 'ui.getSessionSnapshot') return { viewState: null, dataCache: null, updatedAt: 0 }
            if (method === 'ui.saveSessionSnapshot') {
              if (payload) workerSnapshots.push(payload)
              return { ok: true, updatedAt: Date.now() }
            }
            if (method === 'query.run') {
              return {
                columns: [{ name: 'result', type: 'TEXT' }],
                rows: [['OK']],
                rowCount: 1,
                executionTimeMs: 1,
                truncated: false,
                isSelect: false,
                resultSets: [
                  {
                    index: 0,
                    sqlPreview: 'AUTH PanelRedisSecret99',
                    sql: 'AUTH PanelRedisSecret99',
                    columns: [{ name: 'result', type: 'TEXT' }],
                    rows: [['OK']],
                    rowCount: 1,
                    truncated: false,
                    isSelect: false,
                  },
                ],
              }
            }
            if (method === 'schema.listObjects') return []
            if (method === 'ai.status.get') return { enabled: false, state: 'off', destination: 'none', host: '' }
            return {}
          },
          onEvent: () => ({ dispose: () => {} }),
        },
        host: { onEvent: () => ({ dispose: () => {} }), call: async () => ({}) },
        settings: { onDidChange: () => ({ dispose: () => {} }) },
      }

      vi.resetModules()
      await import('../src/panel/panel-app.js')
      await new Promise((r) => setTimeout(r, 40))

      // Inject secret-like connection name in formDraft & trigger savePanelViewState
      const formName = document.getElementById('formName') as HTMLInputElement
      dom.setInput(formName, 'my :DraftSecret88@host libsql://db.turso.io?authToken=eyJDraftTok', 'input')

      // Also run sensitive Redis AUTH in SQL tab to populate lastSqlResult + savePanelDataCache
      const sqlInput = document.getElementById('sqlInput') as HTMLTextAreaElement
      if (sqlInput) {
        sqlInput.value = 'AUTH PanelRedisSecret99'
        sqlInput.dispatchEvent(new Event('input', { bubbles: true }))
      }
      ;(document.getElementById('runSqlBtn') as HTMLButtonElement | null)?.click()
      await new Promise((r) => setTimeout(r, 40))

      const localView = dom.localStorage.getItem('datanoa.panelViewState') || ''
      const localWarm = dom.localStorage.getItem('datanoa.panelWarmCache') || ''
      const allWorkerJson = JSON.stringify(workerSnapshots)

      for (const blob of [localView, localWarm, allWorkerJson]) {
        expect(blob).not.toContain('DraftSecret88')
        expect(blob).not.toContain('eyJDraftTok')
        expect(blob).not.toContain('PanelRedisSecret99')
        expect(blob).not.toContain('ConnNameSecret')
      }
    })
  })

  describe('[MED-10] candidateId auto-detect without dataset.rawAutoUri', () => {
    it('Studio connection modal uses candidateId via closure (never dataset.rawAutoUri) and guards Docker async resolution', async () => {
      const dom = setupDom()
      let mountedModal: HTMLElement | null = null
      const parseCalls: Array<Record<string, unknown>> = []
      const resolvers: Array<(v: { ok: boolean; password?: string }) => void> = []

      openStudioConnectionModal({
        isBackdropActive: () => true,
        mountModal: (el) => {
          mountedModal = el
          document.body.appendChild(el)
          return el as HTMLDivElement
        },
        closeModal: () => {},
        createElapsedTimer: () => () => {},
        updateStatus: () => {},
        activateSavedConnection: async () => {},
        onConnectionDeleted: async () => {},
        requestPlugin: async <T,>(method: string, payload?: Record<string, unknown>): Promise<T> => {
          if (method === 'workspace.detectConnections') {
            return {
              envConnections: [
                {
                  candidateId: 'cand_env_1',
                  envKey: 'DATABASE_URL',
                  sourceFile: '.env',
                  driver: 'postgres',
                  name: 'env-pg',
                  uri: 'postgres://admin:***@localhost:5432/app',
                },
              ],
              dockerComposeConnections: [
                {
                  id: 'dc1',
                  candidateId: 'cand_dc_1',
                  project: 'p1',
                  service: 'pg1',
                  driver: 'postgres',
                  name: 'docker-pg-1',
                  host: '127.0.0.1',
                  port: 5432,
                  database: 'db1',
                  user: 'u1',
                  hasPassword: true,
                  sourceKind: 'live',
                  sourceFile: 'docker-compose.yml',
                  status: 'running',
                  workspaceMatched: true,
                },
                {
                  id: 'dc2',
                  candidateId: 'cand_dc_2',
                  project: 'p1',
                  service: 'pg2',
                  driver: 'postgres',
                  name: 'docker-pg-2',
                  host: '127.0.0.1',
                  port: 5433,
                  database: 'db2',
                  user: 'u2',
                  hasPassword: true,
                  sourceKind: 'live',
                  sourceFile: 'docker-compose.yml',
                  status: 'running',
                  workspaceMatched: true,
                },
              ],
              sqliteFiles: [],
            } as unknown as T
          }
          if (method === 'connection.parseUri') {
            parseCalls.push(payload || {})
            return {
              ok: true,
              profile: { driver: 'postgres', host: 'localhost', port: 5432, database: 'app', user: 'admin' },
              password: 'ResolvedEnvPassword',
            } as unknown as T
          }
          if (method === 'workspace.resolveDetectedCandidate') {
            return await new Promise<T>((resolve) => {
              resolvers.push((v) => resolve(v as unknown as T))
            })
          }
          if (method === 'connection.test') return { ok: true } as unknown as T
          return {} as unknown as T
        },
      })

      const buttons = Array.from(mountedModal?.querySelectorAll('button') || [])
      buttons.find((b) => b.textContent?.includes('Auto-Detect'))?.click()
      await new Promise((r) => setTimeout(r, 25))

      const envChip = Array.from(mountedModal?.querySelectorAll('.datanoa-conn-chip') || []).find((c) =>
        c.textContent?.includes('DATABASE_URL')
      ) as HTMLButtonElement | undefined
      expect(envChip).toBeTruthy()
      envChip?.click()
      await new Promise((r) => setTimeout(r, 25))

      const uriInp = mountedModal?.querySelector('.datanoa-conn-uri-input') as HTMLInputElement
      expect(uriInp.dataset.rawAutoUri).toBeUndefined()
      expect(parseCalls[0]).toEqual({ candidateId: 'cand_env_1' })

      // Clearing uriInp.value = '' WITHOUT firing 'input' invalidates candidateId so Test does NOT re-parse
      uriInp.value = ''
      const testBtn = buttons.find((b) => b.textContent === 'Test Connection')
      testBtn?.click()
      await new Promise((r) => setTimeout(r, 25))
      expect(parseCalls).toHaveLength(1)

      // Docker chips: click dc1 then dc2 before dc1 resolves -> dc1 stale response MUST NOT overwrite dc2 password
      const dockerChips = Array.from(mountedModal?.querySelectorAll('.datanoa-conn-chip') || [])
      ;(dockerChips.find((c) => c.textContent?.includes('docker-pg-1')) as HTMLButtonElement | undefined)?.click()
      ;(dockerChips.find((c) => c.textContent?.includes('docker-pg-2')) as HTMLButtonElement | undefined)?.click()
      expect(resolvers).toHaveLength(2)

      // Resolve dc2 first, then stale dc1
      resolvers[1]({ ok: true, password: 'NewerDc2Password' })
      await dom.flushMicrotasks()
      resolvers[0]({ ok: true, password: 'StaleDc1Password' })
      await dom.flushMicrotasks()

      const pwInput = Array.from(mountedModal?.querySelectorAll('input') || []).find(
        (i) => i.type === 'password' && i.placeholder === 'Optional'
      ) as HTMLInputElement | undefined
      expect(pwInput?.value).toBe('NewerDc2Password')
    })
  })

  describe('[MED-13] TransactionToolbarController inFlightSetAutoCommit race cleanup', () => {
    it('rolls back with exact txToken when tx.setAutoCommit(false) settles after resetForConnectionSwitch and rollbackOnUnload', async () => {
      setupDom()
      const rollbacks: Array<Record<string, unknown>> = []
      let resolveAutoCommit: ((v: TransactionState) => void) | null = null
      let activeConnId: string | null = 'c1'

      const ctrl = new TransactionToolbarController({
        getActiveConnectionId: () => activeConnId,
        getActiveConnection: () =>
          activeConnId
            ? { id: activeConnId, name: 'PG', driver: 'postgres', database: 'app' }
            : undefined,
        isReadOnly: () => false,
        isQueryRunning: () => false,
        isShowingSqlResult: () => false,
        getActiveTable: () => null,
        getCurrentPage: () => 1,
        requestPlugin: async <T,>(method: string, payload?: Record<string, unknown>): Promise<T> => {
          if (method === 'tx.status') {
            return { active: false, autoCommit: true, statementCount: 0, supported: true } as unknown as T
          }
          if (method === 'tx.setAutoCommit') {
            return await new Promise<T>((resolve) => {
              resolveAutoCommit = (val) => resolve(val as unknown as T)
            })
          }
          if (method === 'tx.rollback') {
            rollbacks.push(payload || {})
            return { active: false, autoCommit: true, statementCount: 0, supported: true } as unknown as T
          }
          return {} as unknown as T
        },
        reloadTableData: () => {},
        showErrorBanner: () => {},
        updateStatus: () => {},
      })

      ctrl.mount(document.body)
      await ctrl.refreshState('c1')

      // Scenario 1: resetForConnectionSwitch while tx.setAutoCommit(false) is in flight
      const pendingSwitch = ctrl.toggleAutoCommit()
      await Promise.resolve()
      activeConnId = 'c2'
      ctrl.resetForConnectionSwitch('c1')
      resolveAutoCommit?.({
        active: false,
        autoCommit: false,
        statementCount: 0,
        supported: true,
        txToken: 55,
      })
      await pendingSwitch
      expect(rollbacks).toContainEqual({ connectionId: 'c1', onlyIfOwner: true, txToken: 55 })

      // Scenario 2: rollbackOnUnload while tx.setAutoCommit(false) is in flight
      rollbacks.length = 0
      activeConnId = 'c2'
      await ctrl.refreshState('c2')
      const pendingUnload = ctrl.toggleAutoCommit()
      await Promise.resolve()
      ctrl.rollbackOnUnload()
      resolveAutoCommit?.({
        active: false,
        autoCommit: false,
        statementCount: 0,
        supported: true,
        txToken: 77,
      })
      await pendingUnload
      expect(rollbacks).toContainEqual({ connectionId: 'c2', onlyIfOwner: true, txToken: 77 })

      ctrl.destroy()
    })
  })

  describe('[MED-14] & [LOW-4] AI EXPLAIN privacy disclosure, destination pill, onDismiss abort & Perf #4/#6', () => {
    it('renders accurate EXPLAIN privacy copy with destination host and sentence-case severity badges', () => {
      setupDom()
      const container = document.createElement('div')
      document.body.appendChild(container)

      const noopCallbacks = {
        onAnalyze: () => {},
        onConfigureAi: () => {},
        onCancel: () => {},
        onApplySql: () => {},
        onOpenNewTab: () => {},
        onCopyText: () => {},
        onToggleCollapsed: () => {},
      }

      renderSharedExplainAiPanel(
        container,
        {
          phase: 'idle',
          aiEnabled: true,
          aiReady: true,
          explainLanguage: 'en',
          destination: 'remote',
          host: 'api.openai.com',
        },
        noopCallbacks
      )
      expect(container.querySelector('.datanoa-ai-hint')).toBeNull()
      expect(container.querySelector('.datanoa-ai-lang-pill')).toBeNull()
      expect(container.querySelector('.datanoa-ai-explain-controls button')?.textContent).toBe(
        'Analyze with AI'
      )

      renderSharedExplainAiPanel(
        container,
        {
          phase: 'idle',
          aiEnabled: false,
          aiReady: false,
        },
        noopCallbacks
      )
      const disabledHint = container.querySelector('.datanoa-ai-hint')?.textContent || ''
      expect(disabledHint).toContain('AI is turned off')

      renderSharedExplainAiPanel(
        container,
        {
          phase: 'ready',
          aiEnabled: true,
          aiReady: true,
          explainLanguage: 'en',
          result: {
            summary: 'Seq scan detected',
            bottlenecks: [
              { title: 'Full table scan', detail: 'Add index', severity: 'high' },
              { title: 'Sort spill', detail: 'Increase work_mem', severity: 'medium' },
              { title: 'Minor filter', detail: 'Low impact', severity: 'low' },
            ],
            optimizedSql: null,
            indexSuggestions: [],
            caveats: [],
            language: 'en',
            durationMs: 120,
          },
        },
        noopCallbacks
      )
      const sevTexts = Array.from(container.querySelectorAll('.datanoa-ai-sev')).map((n) => n.textContent)
      expect(sevTexts).toEqual(['High', 'Medium', 'Low'])

      // Status badge keeps label/tone unchanged and enriches tooltip with destination
      const badgeLocal = formatAiStatusBadge({
        enabled: true,
        state: 'on',
        lastMs: 400,
        suggested: 1,
        reason: null,
        format: 'ollama',
        baseUrl: 'http://localhost:11434/v1',
        host: 'localhost:11434',
        model: 'qwen2.5-coder:1.5b',
        maxTokens: 96,
        explainMaxTokens: 2048,
        explainLanguage: 'auto',
        hasKey: false,
        destination: 'local',
      })
      expect(badgeLocal.label).toBe('AI · 0.4s')
      expect(badgeLocal.tone).toBe('success')
      expect(badgeLocal.title).toContain('Local (localhost:11434)')
    })

    it('openSharedAiConfigModal updates .datanoa-ai-dest-pill live, keeps 9 form controls, and aborts signal via mountModal onDismiss', async () => {
      const dom = setupDom()
      let capturedOnDismiss: (() => void) | undefined
      let capturedModal: HTMLElement | null = null
      let statsSignal: AbortSignal | undefined

      const initialStatus: AiStatusSnapshot = {
        enabled: true,
        state: 'on',
        lastMs: 250,
        suggested: 2,
        reason: null,
        format: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        host: 'api.openai.com',
        model: 'gpt-4o-mini',
        maxTokens: 96,
        explainMaxTokens: 2048,
        explainLanguage: 'auto',
        hasKey: true,
        destination: 'remote',
      }

      await openSharedAiConfigModal({
        initialStatus,
        saveSettings: async () => {},
        rpc: async <T,>(name: string, _input?: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<T> => {
          if (name === 'ai.status.get') return initialStatus as unknown as T
          if (name === 'ai.stats.get') {
            statsSignal = opts?.signal
            return await new Promise<T>(() => {})
          }
          return { ok: true, models: [] } as unknown as T
        },
        mountModal: (el, _canClose, onDismiss) => {
          capturedModal = el
          capturedOnDismiss = onDismiss
          document.body.appendChild(el)
          return el
        },
      })

      expect(capturedModal).toBeTruthy()
      // Exactly 9 form controls preserved (dest pill is a <span>, not an input/select)
      const formControls = capturedModal?.querySelectorAll('input, select, textarea') || []
      expect(formControls.length).toBe(9)

      const destPill = capturedModal?.querySelector('.datanoa-ai-dest-pill') as HTMLElement
      expect(destPill.getAttribute('data-destination')).toBe('remote')
      expect(destPill.textContent).toBe('Remote · api.openai.com')

      // Switch preset to local Ollama -> pill switches live to local
      const presetSelect = capturedModal?.querySelector('select') as HTMLSelectElement
      dom.setInput(presetSelect, 'ollama', 'change')
      expect(destPill.getAttribute('data-destination')).toBe('local')
      expect(destPill.textContent).toBe('Local · localhost:11434')

      // External host dismissal via onDismiss aborts in-flight modalAbort.signal
      expect(statsSignal?.aborted).toBe(false)
      expect(typeof capturedOnDismiss).toBe('function')
      capturedOnDismiss?.()
      expect(statsSignal?.aborted).toBe(true)
    })

    it('Side Panel Escape closes .datanoa-ai-backdrop ONLY without closing open Connection Form', async () => {
      const dom = setupDom(true)
      ;(window as unknown as { orca: unknown }).orca = {
        plugin: {
          request: async (method: string) => {
            if (method === 'connections.list') return []
            if (method === 'ui.getSessionSnapshot') return { viewState: null, dataCache: null, updatedAt: 0 }
            if (method === 'ai.status.get') {
              return {
                enabled: false,
                state: 'off',
                format: 'openai',
                baseUrl: 'https://api.openai.com/v1',
                host: 'api.openai.com',
                model: 'gpt-4o-mini',
                maxTokens: 96,
                explainMaxTokens: 2048,
                explainLanguage: 'auto',
                hasKey: false,
                destination: 'remote',
              }
            }
            if (method === 'ai.stats.get') return { summary: {} }
            return {}
          },
          onEvent: () => ({ dispose: () => {} }),
        },
        host: { onEvent: () => ({ dispose: () => {} }), call: async () => ({}) },
        settings: { onDidChange: () => ({ dispose: () => {} }) },
      }

      vi.resetModules()
      await import('../src/panel/panel-app.js')
      await new Promise((r) => setTimeout(r, 30))

      // Open connection form
      ;(document.getElementById('emptyAddConnBtn') as HTMLButtonElement | null)?.click()
      expect((document.getElementById('connFormBox') as HTMLElement).hidden).toBe(false)

      // Open standalone AI settings modal on top of connection form
      await openSharedAiConfigModal({
        rpc: async <T,>(m: string): Promise<T> =>
          (m === 'ai.stats.get' ? { summary: {} } : { enabled: false, state: 'off', destination: 'none' }) as unknown as T,
        saveSettings: async () => {},
      })
      expect(document.querySelector('.datanoa-ai-backdrop')).toBeTruthy()

      // Press Escape -> AI modal closes, Connection Form stays open!
      dom.fireKey(document, 'Escape')
      expect(document.querySelector('.datanoa-ai-backdrop')).toBeNull()
      expect((document.getElementById('connFormBox') as HTMLElement).hidden).toBe(false)
    })

    it('trackAcceptance clears both 5s and 25s timers via clearTimeout on cancel (Perf #6) & CM inline AI slices 8000/4000 IPC window (Perf #4)', async () => {
      vi.useFakeTimers()
      const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
      try {
        const makeModel = (txt: string) => {
          const ranges = new Map<string, string>()
          return {
            getText: () => txt,
            trackRange: () => {
              ranges.set('r1', txt)
              return 'r1'
            },
            getTrackedText: (id: string) => ranges.get(id) ?? null,
            untrackRange: (id: string) => {
              ranges.delete(id)
            },
          }
        }
        const verdicts: string[] = []
        // Cancel before 5s clears early timer
        const cancelEarly = trackAcceptance(
          makeModel('SELECT 1'),
          { startOffset: 0, text: 'SELECT 1' },
          (v) => verdicts.push(v)
        )
        cancelEarly()
        expect(clearSpy).toHaveBeenCalledTimes(1)

        // Advance past 5s so late timer is scheduled, then cancel before 30s -> clears late timer
        const cancelLate = trackAcceptance(
          makeModel('SELECT 2'),
          { startOffset: 0, text: 'SELECT 2' },
          (v) => verdicts.push(v)
        )
        await vi.advanceTimersByTimeAsync(5000)
        cancelLate()
        expect(clearSpy).toHaveBeenCalledTimes(2)
        await vi.advanceTimersByTimeAsync(30000)
        expect(verdicts).toEqual([])

        // CM6 inline AI plugin bounds IPC prefix <= 8000 & suffix <= 4000 on 50,000-char SQL doc
        const dom = setupDom()
        const captured: Array<{ prefix: string; suffix: string; offset: number }> = []
        const bigBefore = 'SELECT /* ' + 'a'.repeat(24980) + ' */ '
        const bigAfter = ' -- ' + 'b'.repeat(24990)
        const view = new EditorView({
          state: EditorState.create({
            doc: bigBefore + bigAfter,
            selection: { anchor: bigBefore.length },
            extensions: [
              createCmInlineAiExtension({
                isEnabled: () => true,
                requestCompletion: async (input) => {
                  captured.push({ prefix: input.prefix, suffix: input.suffix, offset: input.offset })
                  return { suggestion: '', id: 0 }
                },
              }),
            ],
          }),
          parent: dom.body,
        })
        try {
          view.dispatch({
            changes: { from: bigBefore.length, to: bigBefore.length, insert: ' ' },
            selection: { anchor: bigBefore.length + 1 },
          })
          await vi.advanceTimersByTimeAsync(1000)
          expect(captured).toHaveLength(1)
          expect(captured[0].prefix.length).toBe(AI_MAX_IPC_PREFIX_CHARS)
          expect(captured[0].suffix.length).toBe(AI_MAX_IPC_SUFFIX_CHARS)
          expect(AI_MAX_IPC_PREFIX_CHARS).toBe(8000)
          expect(AI_MAX_IPC_SUFFIX_CHARS).toBe(4000)
        } finally {
          view.destroy()
        }
      } finally {
        clearSpy.mockRestore()
      }
    })
  })

  describe('Issue #14 confirmation parity, panel-structure.js fail-closed tx.status & panel-core.js rebuild parity', () => {
    it('Studio danger modal enforces checkbox on dev/none, checkbox+CONFIRM+Enter on prod, and sentence-case warning badge', () => {
      const dom = setupDom()
      let mounted: HTMLElement | null = null
      const onConfirmDev = vi.fn()
      openStudioDangerSqlModal({
        connectionName: 'Dev DB',
        colorTag: 'dev',
        findings: [{ kind: 'drop', statementIndex: 0, statementPreview: 'DROP TABLE t', message: 'Drops table t' }],
        sql: 'DROP TABLE t;',
        mountModal: (el) => {
          mounted = el
          document.body.appendChild(el)
        },
        closeModal: () => {},
        onConfirm: onConfirmDev,
      })
      const badge = mounted?.querySelector('.datanoa-badge-danger')
      expect(badge?.textContent).toBe('1 warning')
      const devExec = mounted?.querySelector('.datanoa-danger-execute-btn') as HTMLButtonElement
      const devChk = mounted?.querySelector('.datanoa-danger-confirm-check') as HTMLInputElement
      expect(devExec.disabled).toBe(true)
      expect(mounted?.querySelector('.datanoa-danger-confirm-input')).toBeNull()
      dom.setInput(devChk, true, 'change')
      expect(devExec.disabled).toBe(false)
      devExec.click()
      expect(onConfirmDev).toHaveBeenCalledTimes(1)

      // Prod requires checkbox + CONFIRM and supports Enter key
      mounted = null
      const onConfirmProd = vi.fn()
      openStudioDangerSqlModal({
        connectionName: 'Prod DB',
        colorTag: 'prod',
        findings: [
          { kind: 'drop', statementIndex: 0, statementPreview: 'DROP TABLE a', message: 'Drop a' },
          { kind: 'truncate', statementIndex: 1, statementPreview: 'TRUNCATE b', message: 'Truncate b' },
        ],
        sql: 'DROP TABLE a; TRUNCATE b;',
        mountModal: (el) => {
          mounted = el
          document.body.appendChild(el)
        },
        closeModal: () => {},
        onConfirm: onConfirmProd,
      })
      expect(mounted?.querySelector('.datanoa-badge-danger')?.textContent).toBe('2 warnings')
      const prodChk = mounted?.querySelector('.datanoa-danger-confirm-check') as HTMLInputElement
      const prodInput = mounted?.querySelector('.datanoa-danger-confirm-input') as HTMLInputElement
      dom.setInput(prodChk, true, 'change')
      dom.setInput(prodInput, 'CONFIRM', 'input')
      dom.fireKey(prodInput, 'Enter')
      expect(onConfirmProd).toHaveBeenCalledTimes(1)
    })

    it('Studio executeSql gates DROP/TRUNCATE on dev connections and cancels if active console tab switches before confirm', async () => {
      const dom = setupDom()
      const ranSqls: string[] = []
      ;(window as unknown as { orca: unknown }).orca = {
        plugin: {
          request: async (method: string, payload?: Record<string, unknown>) => {
            if (method === 'connections.list') {
              return [{ id: 'c_dev', name: 'Dev SQLite', driver: 'sqlite', filePath: ':memory:', colorTag: 'dev' }]
            }
            if (method === 'schema.listObjects') return []
            if (method === 'query.run') {
              ranSqls.push(String(payload?.sql || ''))
              return { columns: [], rows: [], rowCount: 0, executionTimeMs: 1, truncated: false, isSelect: false }
            }
            if (method === 'tx.status') return { active: false, autoCommit: true, statementCount: 0, supported: true }
            if (method === 'ai.status.get') return { enabled: false, state: 'off', destination: 'none', host: '' }
            return {}
          },
          onEvent: () => ({ dispose: () => {} }),
        },
        host: { onEvent: () => ({ dispose: () => {} }), call: async () => ({}) },
        settings: { onDidChange: () => ({ dispose: () => {} }) },
      }

      const mountHost = document.createElement('div')
      document.body.appendChild(mountHost)
      const editor = new DatanoaStudioEditor(mountHost)
      try {
        await new Promise((r) => setTimeout(r, 40))
        // Trigger DROP TABLE on dev connection -> must show danger modal (NOT execute immediately)
        void editor.executeSql(false, true, 'DROP TABLE legacy_logs;', false)
        await dom.flushMicrotasks()
        expect(ranSqls).toHaveLength(0)
        const modal = document.querySelector('.datanoa-danger-modal')
        expect(modal).toBeTruthy()

        // Switch to a new console tab before clicking Execute Anyway -> execution MUST cancel!
        ;(document.querySelector('.datanoa-console-tab-add') as HTMLButtonElement | null)?.click()
        const chk = modal?.querySelector('.datanoa-danger-confirm-check') as HTMLInputElement
        dom.setInput(chk, true, 'change')
        ;(modal?.querySelector('.datanoa-danger-execute-btn') as HTMLButtonElement).click()
        await new Promise((r) => setTimeout(r, 30))
        expect(ranSqls).toHaveLength(0)
      } finally {
        editor.destroy()
      }
    })

    it('panel-structure.js fails closed when rpc(tx.status) rejects before SQLite rebuild', async () => {
      setupDom(true)
      const queryRuns: unknown[] = []
      ;(window as unknown as { orca: unknown }).orca = {
        plugin: {
          request: async (method: string, payload?: unknown) => {
            if (method === 'tx.status') {
              throw new Error('IPC channel offline')
            }
            if (method === 'query.run') {
              queryRuns.push(payload)
              return { columns: [], rows: [], rowCount: 0, executionTimeMs: 1, truncated: false, isSelect: false }
            }
            return {}
          },
        },
      }
      const banners: Array<{ msg: string; tone: string }> = []
      const details: TableDetails = {
        name: 'items',
        schema: 'main',
        kind: 'table',
        columns: [
          { name: 'id', type: 'INTEGER', nativeType: 'INTEGER', nullable: false, defaultValue: null, isPrimaryKey: true, isAutoIncrement: false },
          { name: 'price', type: 'INTEGER', nativeType: 'INTEGER', nullable: true, defaultValue: '0', isPrimaryKey: false, isAutoIncrement: false },
        ],
        primaryKey: ['id'],
        indexes: [],
        foreignKeys: [],
      }
      const draft = createPanelStructDraft(details)
      draft.columns[1].nullable = false // triggers SQLite rebuild

      const state = {
        activeConnectionId: 'c1',
        activeTable: 'items',
        activeSchema: 'main',
        schemaObjects: { c1: [] },
        tableDetails: { 'c1::main::items': details },
        structDraftKey: 'c1::main::items',
        structDraft: draft,
        structPreviewOpen: false,
        isMigrating: false,
      }
      const structCtrl = createPanelStructureController({
        state,
        QUERY_TIMEOUT_MS: 30000,
        getActiveConn: () => ({ id: 'c1', name: 'Local', driver: 'sqlite', readOnly: false }),
        getConnById: () => ({ id: 'c1', name: 'Local', driver: 'sqlite', readOnly: false }),
        showBanner: (msg: string, tone: string) => banners.push({ msg, tone }),
        savePanelViewState: () => {},
        loadSchema: async () => {},
        loadTableDetails: async () => {},
        loadTablePage: async () => {},
        copyText: async () => {},
        runSqlInTab: () => {},
      })
      structCtrl.applyPanelStructChanges()
      await structCtrl.executeConfirmedPanelMigration()

      expect(queryRuns).toHaveLength(0)
      expect(banners.some((b) => b.tone === 'danger' && b.msg.includes('Cannot verify transaction status'))).toBe(true)
    })

    it('panel-core.js v1.2.0 blocks D1 self-ref FK & expression indexes and emits GENERATED, CHECK, WITHOUT ROWID, STRICT & partial WHERE', () => {
      expect(DATANOA_VERSION).toBe('1.2.0')

      // D1 self-ref FK blocked
      const d1Details: TableDetails = {
        name: 'nodes',
        schema: 'main',
        kind: 'table',
        columns: [
          { name: 'id', type: 'INTEGER', nativeType: 'INTEGER', nullable: false, defaultValue: null, isPrimaryKey: true, isAutoIncrement: false },
          { name: 'parent_id', type: 'INTEGER', nativeType: 'INTEGER', nullable: true, defaultValue: null, isPrimaryKey: false, isAutoIncrement: false },
          { name: 'label', type: 'TEXT', nativeType: 'TEXT', nullable: true, defaultValue: null, isPrimaryKey: false, isAutoIncrement: false },
        ],
        primaryKey: ['id'],
        indexes: [],
        foreignKeys: [
          { constraintName: 'fk_self', column: 'parent_id', referencedTable: 'nodes', referencedColumn: 'id', onDelete: 'CASCADE' },
        ],
        inboundForeignKeys: [{ fromTable: 'nodes', fromColumn: 'parent_id', toColumn: 'id', onDelete: 'CASCADE' }],
      }
      const d1Draft = createPanelStructDraft(d1Details)
      d1Draft.columns[2].nullable = false
      expect(() => buildPanelMigrationSql(d1Draft, 'd1')).toThrow(/self-referencing foreign key/i)

      // Deleting self-ref FK allows D1 rebuild
      d1Draft.foreignKeys[0].status = 'deleted'
      expect(buildPanelMigrationSql(d1Draft, 'd1').length).toBeGreaterThan(0)

      // Expression index blocked unconditionally on SQLite rebuild
      const exprDetails: TableDetails = {
        name: 'users',
        schema: 'main',
        kind: 'table',
        columns: [
          { name: 'id', type: 'INTEGER', nativeType: 'INTEGER', nullable: false, defaultValue: null, isPrimaryKey: true, isAutoIncrement: false },
          { name: 'code', type: 'TEXT', nativeType: 'TEXT', nullable: true, defaultValue: null, isPrimaryKey: false, isAutoIncrement: false },
        ],
        primaryKey: ['id'],
        indexes: [{ name: 'idx_lower_code', isUnique: false, isPrimary: false, columns: [], isExpression: true }],
        foreignKeys: [],
      }
      const exprDraft = createPanelStructDraft(exprDetails)
      exprDraft.columns[1].nullable = false
      expect(() => buildPanelMigrationSql(exprDraft, 'sqlite')).toThrow(/Expression index "idx_lower_code"/i)

      // Full SQLite rebuild fidelity: GENERATED ALWAYS AS (excluded from INSERT..SELECT), CHECK, WITHOUT ROWID, STRICT, partial index WHERE
      const richDetails: TableDetails = {
        name: 'orders',
        schema: 'main',
        kind: 'table',
        columns: [
          { name: 'id', type: 'INTEGER', nativeType: 'INTEGER', nullable: false, defaultValue: null, isPrimaryKey: true, isAutoIncrement: false },
          { name: 'qty', type: 'INTEGER', nativeType: 'INTEGER', nullable: false, defaultValue: '1', isPrimaryKey: false, isAutoIncrement: false },
          { name: 'total', type: 'INTEGER', nativeType: 'INTEGER', nullable: true, defaultValue: null, isPrimaryKey: false, isAutoIncrement: false, isGenerated: true, generatedExpression: 'qty * 10', generatedStorage: 'STORED' },
          { name: 'active', type: 'INTEGER', nativeType: 'INTEGER', nullable: true, defaultValue: '1', isPrimaryKey: false, isAutoIncrement: false },
        ],
        primaryKey: ['id'],
        indexes: [
          {
            name: 'idx_active_qty',
            isUnique: false,
            isPrimary: false,
            columns: ['qty'],
            columnSpecs: [{ name: 'qty', desc: true }],
            partial: true,
            whereClause: 'active = 1',
          },
        ],
        foreignKeys: [],
        checkConstraints: ['CHECK (qty > 0)'],
        strict: true,
        withoutRowid: true,
      }
      const normalized = normalizeTableDetailsForDraft(richDetails)
      expect(normalized.columns[2].generatedExpression).toBe('qty * 10')
      expect(normalized.indexes[0].whereClause).toBe('active = 1')

      const richDraft = createPanelStructDraft(richDetails)
      richDraft.columns[3].nullable = false
      const stmts = buildPanelMigrationSql(richDraft, 'sqlite')
      const joined = stmts.join('\n')
      expect(joined).toContain('GENERATED ALWAYS AS (qty * 10) STORED')
      expect(joined).toContain('CHECK (qty > 0)')
      expect(joined).toContain(') WITHOUT ROWID, STRICT;')
      expect(joined).toContain('WHERE active = 1;')
      const insertStmt = stmts.find((s) => s.startsWith('INSERT INTO ')) || ''
      expect(insertStmt).not.toContain('"total"')
    })
  })

  describe('[LOW-9], [LOW-10] & /unslop theme, motion, icon & copy guards', () => {
    it('schema-ddl.ts formatDdlForDisplay handles unterminated SQL comments without hanging', () => {
      const ddlLine = 'CREATE TABLE t (a INT, b INT -- trailing comment'
      const ddlBlock = 'CREATE TABLE t (a INT, /* unclosed block'
      expect(formatDdlForDisplay(ddlLine, 'sqlite')).toContain('CREATE TABLE t')
      expect(formatDdlForDisplay(ddlBlock, 'sqlite')).toContain('CREATE TABLE t')
    })

    it('enforces theme.ts, panel.css, panel.html, shared-db-icons.js & UI copy /unslop invariants', () => {
      const rootDir = process.cwd()
      const panelCss = fs.readFileSync(path.join(rootDir, 'src', 'panel', 'panel.css'), 'utf8')
      const panelHtml = fs.readFileSync(path.join(rootDir, 'src', 'panel', 'panel.html'), 'utf8')
      const panelApp = fs.readFileSync(path.join(rootDir, 'src', 'panel', 'panel-app.js'), 'utf8')
      const panelConnForm = fs.readFileSync(path.join(rootDir, 'src', 'panel', 'panel-connection-form.js'), 'utf8')
      const connModal = fs.readFileSync(path.join(rootDir, 'src', 'editor', 'connection-modal.ts'), 'utf8')
      const schemaInspector = fs.readFileSync(path.join(rootDir, 'src', 'editor', 'schema-inspector.ts'), 'utf8')
      const dbIcons = fs.readFileSync(path.join(rootDir, 'src', 'editor', 'db-icons.ts'), 'utf8')

      // [LOW-10] Theme parity & z-index
      expect(EDITOR_STYLE).not.toContain('.datanoa-ai-backdrop')
      expect(EDITOR_STYLE).toContain('--db-clickhouse-accent: #dc382d;')
      expect(EDITOR_STYLE).toContain('--db-clickhouse-accent: #b91c1c;')
      expect(panelCss).toMatch(/html\.light,\s*body\.light\s*\{[\s\S]*?--input-bg:/)
      expect(panelCss).toMatch(/html\.light\s+\.modal-backdrop,\s*body\.light\s+\.modal-backdrop/)
      expect(panelCss).toMatch(/\.datanoa-ai-backdrop\s*\{\s*z-index:\s*10020;\s*\}/)
      expect(panelCss).toContain('--db-clickhouse-accent: #dc382d;')
      expect(panelCss).toContain('--db-clickhouse-accent: #b91c1c;')

      // /unslop Motion: .datanoa-tx-tray animates only GPU-composited opacity & transform
      const txTrayBlock = /\.datanoa-tx-tray\s*\{[^}]*\}/.exec(EDITOR_STYLE)?.[0] || ''
      expect(txTrayBlock).toContain('transition:')
      expect(txTrayBlock).not.toContain('grid-template-columns 180ms')
      expect(txTrayBlock).not.toContain('margin-left')

      // /unslop Typography: removed uppercase tracked badges
      const kindBadgeBlock = /\.datanoa-object-kind-badge\s*\{[^}]*\}/.exec(EDITOR_STYLE)?.[0] || ''
      expect(kindBadgeBlock).not.toContain('text-transform: uppercase')
      const groupTitleBlock = /\.datanoa-sidebar-group-title\s*\{[^}]*\}/.exec(EDITOR_STYLE)?.[0] || ''
      expect(groupTitleBlock).not.toContain('text-transform: uppercase')
      const txBadgeBlock = /\.datanoa-tx-badge\s*\{[^}]*\}/.exec(EDITOR_STYLE)?.[0] || ''
      expect(txBadgeBlock).not.toContain('text-transform: uppercase')

      // /unslop ClickHouse accent token replaces harsh #ff0000
      const chAccentRect = CLICKHOUSE_LOGO_RECTS.find((r) => 'fill' in r)
      expect(chAccentRect?.fill).toBe('var(--db-clickhouse-accent, #dc382d)')

      // /unslop Copy: no routine exclamation marks in status/copy messages
      expect(panelHtml).toContain('>1 warning<')
      expect(panelHtml).not.toContain('>1 WARNING<')
      expect(panelApp).not.toContain("'Copied!'")
      expect(panelApp).not.toContain('Connection verified successfully!')
      expect(panelConnForm).not.toContain('driver verified and ready!')
      expect(connModal).not.toContain('Connection verified successfully!')
      expect(schemaInspector).not.toContain("'Copied!'")
      expect(dbIcons).not.toContain("'Copied!'")
    })
  })

  describe('[v1.2.0 UX] Cloud Auto-SSL Edit, Split Built-in/BYOD Panel Grid, Compact Discovery & Metadata', () => {
    it('reveals Verify TLS checkbox when editing Cloud Auto-SSL / legacy SSL profiles in Side Panel and Studio, persisting sslMode=require on opt-out', async () => {
      const dom = setupDom(true)
      const cloudAutoProfile: ConnectionProfile = {
        id: 'conn_cloud_auto',
        name: 'Supabase Pooler',
        driver: 'postgres',
        host: 'aws-0-ap-southeast-1.pooler.supabase.com',
        port: 5432,
        database: 'postgres',
        user: 'postgres.proj',
        hasPassword: true,
        // Legacy / auto-SSL: ssl & sslRejectUnauthorized omitted
      }
      const legacySslProfile: ConnectionProfile = {
        id: 'conn_legacy_ssl',
        name: 'Legacy TLS PG',
        driver: 'postgres',
        host: 'pg.corp.internal',
        port: 5432,
        database: 'app',
        user: 'app',
        ssl: true,
      }

      const state: Record<string, unknown> = {
        formOpen: false,
        formDriver: 'sqlite',
        formColorTag: 'none',
        editingId: null,
        formSslMode: undefined,
        formSslRejectUnauthorized: undefined,
        formSslTouched: false,
        connections: [cloudAutoProfile, legacySslProfile],
        discoveredEnvs: [],
        discoveredDocker: [],
        discoveredFiles: [],
      }

      const formCtrl = createPanelConnectionFormController({
        state,
        showBanner: () => {},
        showFormNotice: () => {},
        clearFormNotice: () => {},
        setFormOpen: (v: boolean) => {
          state.formOpen = v
        },
        updateViewportLayout: () => {},
        savePanelViewState: () => {},
      })
      formCtrl.initStaticSelectors()

      const sslCheck = document.getElementById('formSsl') as HTMLInputElement
      const verifyRow = document.getElementById('sslVerifyRow') as HTMLElement
      const verifyCheck = document.getElementById('formSslVerify') as HTMLInputElement

      // 1. Editing Cloud Auto-SSL profile (ssl: undefined) checks #formSsl and shows #sslVerifyRow
      formCtrl.populateFormFromProfile(cloudAutoProfile, 'edit')
      expect(sslCheck.checked).toBe(true)
      expect(verifyRow.hidden).toBe(false)
      expect(verifyCheck.checked).toBe(true)
      expect(verifyCheck.disabled).toBe(false)

      // Uncheck Verify TLS in 1 click -> persists ssl: true, sslMode: 'require', sslRejectUnauthorized: false
      dom.setInput(verifyCheck, false, 'change')
      const cloudSub = formCtrl.buildFormSubmission(cloudAutoProfile.id)
      expect(cloudSub.profile.ssl).toBe(true)
      expect(cloudSub.profile.sslMode).toBe('require')
      expect(cloudSub.profile.sslRejectUnauthorized).toBe(false)

      // 2. Editing legacy ssl: true profile (sslRejectUnauthorized: undefined) shows Verify TLS checked
      formCtrl.populateFormFromProfile(legacySslProfile, 'edit')
      expect(sslCheck.checked).toBe(true)
      expect(verifyRow.hidden).toBe(false)
      expect(verifyCheck.checked).toBe(true)
      dom.setInput(verifyCheck, false, 'change')
      const legacySub = formCtrl.buildFormSubmission(legacySslProfile.id)
      expect(legacySub.profile.ssl).toBe(true)
      expect(legacySub.profile.sslMode).toBe('require')
      expect(legacySub.profile.sslRejectUnauthorized).toBe(false)

      // 3. Studio connection modal Edit flow for Cloud Auto-SSL host
      let studioSaved: { profile?: ConnectionProfile } | null = null
      let mountedModal: HTMLElement | null = null
      openStudioConnectionModal(
        {
          isBackdropActive: () => true,
          mountModal: (el) => {
            mountedModal = el
            document.body.appendChild(el)
            return el as HTMLDivElement
          },
          closeModal: () => {},
          createElapsedTimer: () => () => {},
          updateStatus: () => {},
          activateSavedConnection: async () => {},
          onConnectionDeleted: async () => {},
          requestPlugin: async <T,>(method: string, payload?: Record<string, unknown>): Promise<T> => {
            if (method === 'connection.test') return { ok: true } as unknown as T
            if (method === 'connection.save') {
              studioSaved = (payload || null) as { profile?: ConnectionProfile } | null
              return { ok: true, id: cloudAutoProfile.id } as unknown as T
            }
            if (method === 'connections.list') return [cloudAutoProfile] as unknown as T
            if (method === 'drivers.list') return { drivers: [] } as unknown as T
            if (method === 'workspace.listScopes') return { workspaces: [] } as unknown as T
            return {} as unknown as T
          },
        },
        cloudAutoProfile
      )

      const studioChecks = Array.from(
        mountedModal?.querySelectorAll('.datanoa-conn-check') || []
      )
      const studioSslInput = studioChecks
        .find((el) => el.textContent?.includes('SSL / TLS'))
        ?.querySelector('input') as HTMLInputElement | null
      const studioRejectInput = studioChecks
        .find((el) => el.textContent?.includes('Reject Unauthorized Certs'))
        ?.querySelector('input') as HTMLInputElement | null
      expect(studioSslInput?.checked).toBe(true)
      expect(studioRejectInput?.checked).toBe(true)

      // Uncheck Reject Unauthorized Certs -> auto-syncs sslMode to 'require' & saves cleanly
      if (studioRejectInput) dom.setInput(studioRejectInput, false, 'change')
      const updateBtn = Array.from(mountedModal?.querySelectorAll('button') || []).find((b) =>
        b.textContent?.includes('Update Connection')
      ) as HTMLButtonElement | undefined
      updateBtn?.click()
      await new Promise((r) => setTimeout(r, 30))

      expect(studioSaved?.profile?.ssl).toBe(true)
      expect(studioSaved?.profile?.sslMode).toBe('require')
      expect(studioSaved?.profile?.sslRejectUnauthorized).toBe(false)
    })

    it('splits Side Panel #engineGrid into Built-in Database Engines (11) and Local Custom Drivers (BYOD) (7) while preserving selectors', () => {
      setupDom(true)
      const state: Record<string, unknown> = {
        formOpen: true,
        formDriver: 'sqlite',
        formColorTag: 'none',
        editingId: null,
        connections: [],
        discoveredEnvs: [],
        discoveredDocker: [],
        discoveredFiles: [],
      }
      const formCtrl = createPanelConnectionFormController({
        state,
        showBanner: () => {},
        showFormNotice: () => {},
        clearFormNotice: () => {},
        setFormOpen: () => {},
        updateViewportLayout: () => {},
        savePanelViewState: () => {},
      })
      formCtrl.initStaticSelectors()

      const grid = document.getElementById('engineGrid') as HTMLElement
      const groups = Array.from(grid.querySelectorAll('.engine-group')) as HTMLElement[]
      expect(groups).toHaveLength(2)

      const builtinGroup = groups[0]
      const byodGroup = groups[1]
      expect(builtinGroup.dataset.engineGroup).toBe('builtin')
      expect(builtinGroup.querySelector('.engine-group-label')?.textContent).toBe(
        'Built-in Database Engines'
      )
      expect(byodGroup.dataset.engineGroup).toBe('byod')
      expect(byodGroup.querySelector('.engine-group-label')?.textContent).toBe(
        'Local Custom Drivers (BYOD)'
      )

      const builtinDrivers = Array.from(builtinGroup.querySelectorAll('.engine-tile')).map(
        (el) => (el as HTMLElement).dataset.driver
      )
      const byodDrivers = Array.from(byodGroup.querySelectorAll('.engine-tile')).map(
        (el) => (el as HTMLElement).dataset.driver
      )
      // Side Panel supports 11 built-in engines (d1 is intentionally studioOnly) + 7 BYOD engines
      expect(builtinDrivers).toEqual([
        'sqlite',
        'postgres',
        'mysql',
        'mariadb',
        'cockroachdb',
        'clickhouse',
        'redis',
        'libsql',
        'mssql',
        'oracle',
        'mongodb',
      ])
      expect(byodDrivers).toEqual([
        'duckdb',
        'snowflake',
        'bigquery',
        'cassandra',
        'elasticsearch',
        'neo4j',
        'custom',
      ])
      expect(grid.querySelectorAll('.engine-tile')).toHaveLength(18)

      // Clicking a BYOD tile updates active driver cleanly
      const duckTile = grid.querySelector('.engine-tile[data-driver="duckdb"]') as HTMLButtonElement
      duckTile.click()
      expect(state.formDriver).toBe('duckdb')
      expect(duckTile.classList.contains('active')).toBe(true)

      // CSS /unslop check: quiet neutral .engine-group-label (no uppercase tracking / 700 weight)
      const panelCss = fs.readFileSync(path.join(process.cwd(), 'src', 'panel', 'panel.css'), 'utf8')
      const labelRule = /^\.engine-group-label\s*\{[^}]*\}/m.exec(panelCss)?.[0] || ''
      expect(labelRule).toContain('color: var(--t2)')
      expect(labelRule).not.toContain('text-transform: uppercase')
      expect(labelRule).not.toContain('font-weight: 700')
    })

    it('renders compact Auto-Discovery scanned folder counts with full-path title tooltip in both Side Panel and Studio', async () => {
      setupDom(true)
      let detectPayload: {
        scannedDirs: string[]
        folderScoped: boolean
        dockerIsLocal: boolean
        dockerScopeLabel: string
      } = {
        scannedDirs: ['D:\\workspaces\\proj-alpha'],
        folderScoped: false,
        dockerIsLocal: true,
        dockerScopeLabel: 'Local Docker',
      }

      ;(window as unknown as { orca: unknown }).orca = {
        plugin: {
          request: async (method: string) => {
            if (method === 'workspace.detectConnections') {
              return {
                envConnections: [],
                dockerComposeConnections: [],
                sqliteFiles: [],
                ...detectPayload,
              }
            }
            if (method === 'sqlite.scanFolder') return { files: [] }
            return {}
          },
        },
      }

      const panelCtrl = createPanelConnectionFormController({
        state: {
          formOpen: true,
          formDriver: 'sqlite',
          formColorTag: 'none',
          editingId: null,
          connections: [],
          discoveredEnvs: [],
          discoveredDocker: [],
          discoveredFiles: [],
        },
        showBanner: () => {},
        showFormNotice: () => {},
        clearFormNotice: () => {},
        setFormOpen: () => {},
        updateViewportLayout: () => {},
        savePanelViewState: () => {},
      })
      const scopeHint = document.getElementById('discoveredScopeHint') as HTMLElement

      // 1 local folder
      await panelCtrl.detectWorkspace('', false)
      expect(scopeHint.textContent).toBe(
        'Scanned 1 local workspace folder · Plus local Docker containers (non-workspace labeled "Other Local Docker").'
      )
      expect(scopeHint.title).toBe('D:\\workspaces\\proj-alpha')

      // Multiple local folders (must NOT print full paths inline)
      const nineDirs = Array.from({ length: 9 }, (_, i) => `D:\\workspaces\\repo-${i + 1}`)
      detectPayload = {
        scannedDirs: nineDirs,
        folderScoped: false,
        dockerIsLocal: true,
        dockerScopeLabel: 'Local Docker',
      }
      await panelCtrl.detectWorkspace('', false)
      expect(scopeHint.textContent).toBe(
        'Scanned 9 local workspace folders · Plus local Docker containers (non-workspace labeled "Other Local Docker").'
      )
      expect(scopeHint.textContent).not.toContain('repo-1')
      expect(scopeHint.title).toBe(nineDirs.join(', '))

      // Remote Docker Context
      detectPayload = {
        scannedDirs: nineDirs.slice(0, 2),
        folderScoped: false,
        dockerIsLocal: false,
        dockerScopeLabel: 'Docker Context',
      }
      await panelCtrl.detectWorkspace('', false)
      expect(scopeHint.textContent).toBe(
        'Scanned 2 local workspace folders · Plus active Docker Context containers (non-workspace labeled "Other Docker Context").'
      )
      expect(scopeHint.title).toBe('D:\\workspaces\\repo-1, D:\\workspaces\\repo-2')

      // Explicit folder scan (folderScoped)
      detectPayload = {
        scannedDirs: ['D:\\custom\\my-backend\\'],
        folderScoped: true,
        dockerIsLocal: true,
        dockerScopeLabel: 'Local Docker',
      }
      await panelCtrl.detectWorkspace('D:\\custom\\my-backend\\', true)
      expect(scopeHint.textContent).toBe(
        'Scanned folder: my-backend (Compose files and matching containers inside this folder only).'
      )
      expect(scopeHint.title).toBe('D:\\custom\\my-backend\\')

      // Studio parity check
      let mountedModal: HTMLElement | null = null
      openStudioConnectionModal({
        isBackdropActive: () => true,
        mountModal: (el) => {
          mountedModal = el
          document.body.appendChild(el)
          return el as HTMLDivElement
        },
        closeModal: () => {},
        createElapsedTimer: () => () => {},
        updateStatus: () => {},
        activateSavedConnection: async () => {},
        onConnectionDeleted: async () => {},
        requestPlugin: async <T,>(method: string): Promise<T> => {
          if (method === 'workspace.detectConnections') {
            return {
              envConnections: [],
              dockerComposeConnections: [],
              sqliteFiles: [],
              ...detectPayload,
            } as unknown as T
          }
          if (method === 'sqlite.scanFolder') return { files: [] } as unknown as T
          if (method === 'connections.list') return [] as unknown as T
          if (method === 'drivers.list') return { drivers: [] } as unknown as T
          if (method === 'workspace.listScopes') return { workspaces: [] } as unknown as T
          return {} as unknown as T
        },
      })

      const detectBtn = Array.from(mountedModal?.querySelectorAll('button') || []).find((b) =>
        b.textContent?.includes('Auto-Detect')
      ) as HTMLButtonElement | undefined
      const studioHint = mountedModal?.querySelector('.datanoa-conn-hint') as HTMLElement | null

      detectPayload = {
        scannedDirs: ['D:\\ws\\a', 'D:\\ws\\b', 'D:\\ws\\c'],
        folderScoped: false,
        dockerIsLocal: true,
        dockerScopeLabel: 'Local Docker',
      }
      detectBtn?.click()
      await new Promise((r) => setTimeout(r, 25))
      expect(studioHint?.textContent).toBe(
        'Scanned 3 local workspace folders · Plus local Docker containers (non-workspace labeled "Other Local Docker").'
      )
      expect(studioHint?.title).toBe('D:\\ws\\a, D:\\ws\\b, D:\\ws\\c')
      expect(studioHint?.textContent).not.toContain('D:\\ws\\a')

      detectPayload = {
        scannedDirs: ['D:\\projects\\analytics-api'],
        folderScoped: true,
        dockerIsLocal: true,
        dockerScopeLabel: 'Local Docker',
      }
      const folderInp = mountedModal?.querySelector(
        'input[aria-label="Folder path to scan"]'
      ) as HTMLInputElement | null
      const scanBtn = Array.from(mountedModal?.querySelectorAll('button') || []).find(
        (b) => b.textContent === 'Scan Folder'
      ) as HTMLButtonElement | undefined
      if (folderInp) folderInp.value = 'D:\\projects\\analytics-api'
      scanBtn?.click()
      await new Promise((r) => setTimeout(r, 25))
      expect(studioHint?.textContent).toBe(
        'Scanned folder: analytics-api (Compose files and matching containers inside this folder only).'
      )
      expect(studioHint?.title).toBe('D:\\projects\\analytics-api')
    })

    it('keeps orca-plugin.json v1.2.0 description and screenshot metadata accurate for AI SQL Assistant, 12 engines, and BYOD', () => {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), 'orca-plugin.json'), 'utf8')
      ) as {
        description?: string
        screenshots?: Array<{ path: string; alt: string; caption: string }>
      }
      expect(manifest.description).toContain('AI SQL Assistant')
      expect(manifest.description).toContain('inline ghost completion')
      expect(manifest.description).toContain('EXPLAIN')
      expect(manifest.description).toContain('12 built-in engines')
      expect(manifest.description).toContain('BYOD')
      expect(manifest.screenshots).toHaveLength(5)
      expect(manifest.screenshots?.[0]?.caption).toContain('AI')
      expect(manifest.screenshots?.[1]?.caption).toContain('BYOD')
    })
  })

  describe('[v1.2.1] Wide Empty-State Text & Fix with AI (Hướng A) UI, XSS Safety, and Undoable Replace', () => {
    it('widens .empty-desc in panel.css (>= 480px) with text-wrap: balance and generous .empty padding while preserving panel.html BYOD copy', () => {
      const panelCss = fs.readFileSync(path.join(process.cwd(), 'src', 'panel', 'panel.css'), 'utf8')
      const emptyRule = /^\.empty\s*\{[^}]*\}/m.exec(panelCss)?.[0] || ''
      const emptyDescRule = /^\.empty-desc\s*\{[^}]*\}/m.exec(panelCss)?.[0] || ''

      expect(emptyRule).toContain('padding: 24px 20px')
      const maxWidthMatch = /max-width:\s*(\d+)px/.exec(emptyDescRule)
      expect(maxWidthMatch).toBeTruthy()
      expect(Number(maxWidthMatch?.[1] || 0)).toBeGreaterThanOrEqual(480)
      expect(emptyDescRule).toContain('width: 100%')
      expect(emptyDescRule).toContain('line-height: 1.5')
      expect(emptyDescRule).toContain('text-wrap: balance')

      const panelHtml = fs.readFileSync(
        path.join(process.cwd(), 'src', 'panel', 'panel.html'),
        'utf8'
      )
      expect(panelHtml).toContain(
        'BYOD (DuckDB, Snowflake, BigQuery, Cassandra, Elasticsearch, Neo4j, Custom)'
      )
    })

    it('wires #sqlFixAiBtn and #sqlAiFixPanel in panel.html and queryBannerFixAiBtn and aiFixEl in studio-dom.ts', () => {
      setupDom(true)
      const fixBtn = document.getElementById('sqlFixAiBtn') as HTMLButtonElement | null
      const fixPanel = document.getElementById('sqlAiFixPanel') as HTMLDivElement | null
      const errBanner = document.getElementById('sqlErrorBanner') as HTMLDivElement | null
      expect(fixBtn).toBeTruthy()
      expect(fixBtn?.hidden).toBe(true)
      expect(fixBtn?.textContent).toBe('Fix with AI')
      expect(errBanner?.contains(fixBtn)).toBe(true)
      expect(fixPanel).toBeTruthy()
      expect(fixPanel?.hidden).toBe(true)
      expect(errBanner?.nextElementSibling).toBe(fixPanel)

      const studioDom = createStudioDomTree(100, () => {}, document.createElement('div'))
      expect(studioDom.queryBannerFixAiBtn.textContent).toBe('Fix with AI')
      expect(studioDom.queryBannerFixAiBtn.style.display).toBe('none')
      expect(studioDom.queryBannerEl.contains(studioDom.queryBannerFixAiBtn)).toBe(true)
      expect(studioDom.aiFixEl.className).toBe('datanoa-ai-fix-panel')
      expect(studioDom.aiFixEl.hidden).toBe(true)
      expect(studioDom.queryBannerEl.nextElementSibling).toBe(studioDom.aiFixEl)
    })

    it('renderSharedAiFixPanel renders hidden/loading/error/ready via pure XSS-safe DOM and invokes all callbacks', () => {
      setupDom()
      const container = document.createElement('div')
      document.body.appendChild(container)

      const calls = {
        replace: [] as string[],
        copy: [] as string[],
        retry: 0,
        cancel: 0,
        dismiss: 0,
        configure: 0,
      }
      const callbacks = {
        onReplaceQuery: (sql: string) => calls.replace.push(sql),
        onCopySql: (sql: string) => calls.copy.push(sql),
        onRetry: () => {
          calls.retry += 1
        },
        onCancel: () => {
          calls.cancel += 1
        },
        onDismiss: () => {
          calls.dismiss += 1
        },
        onConfigureAi: () => {
          calls.configure += 1
        },
      }

      // 1. hidden
      renderSharedAiFixPanel(
        container,
        { phase: 'hidden', aiEnabled: false, aiReady: false },
        callbacks
      )
      expect(container.hidden).toBe(true)
      expect(container.childNodes.length).toBe(0)

      // 2. loading (Cancel + Dismiss)
      renderSharedAiFixPanel(
        container,
        { phase: 'loading', aiEnabled: true, aiReady: true },
        callbacks
      )
      expect(container.hidden).toBe(false)
      expect(container.textContent).toContain('AI Query Fix')
      expect(container.textContent).toContain('Analyzing SQL error and schema to suggest a fix...')
      const loadingButtons = Array.from(container.querySelectorAll('button'))
      loadingButtons.find((b) => b.textContent === 'Cancel')?.click()
      loadingButtons.find((b) => b.textContent === 'Dismiss')?.click()
      expect(calls.cancel).toBe(1)
      expect(calls.dismiss).toBe(1)

      // 3. error when AI not ready (no Retry, Configure AI present, XSS payload safe)
      const xssPayload = '<img src=x onerror=alert(1)>'
      renderSharedAiFixPanel(
        container,
        {
          phase: 'error',
          aiEnabled: false,
          aiReady: false,
          error: `Bad config ${xssPayload}`,
        },
        callbacks
      )
      expect(container.querySelector('img')).toBeNull()
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(xssPayload)
      const unreadyErrBtns = Array.from(container.querySelectorAll('button'))
      expect(unreadyErrBtns.find((b) => b.textContent === 'Retry')).toBeUndefined()
      unreadyErrBtns.find((b) => b.textContent === 'Configure AI')?.click()
      expect(calls.configure).toBe(1)

      // 4. error when AI ready (Retry + AI Settings both present)
      renderSharedAiFixPanel(
        container,
        {
          phase: 'error',
          aiEnabled: true,
          aiReady: true,
          error: 'Timeout contacting provider',
        },
        callbacks
      )
      const readyErrBtns = Array.from(container.querySelectorAll('button'))
      readyErrBtns.find((b) => b.textContent === 'Retry')?.click()
      readyErrBtns.find((b) => b.textContent === 'AI Settings')?.click()
      expect(calls.retry).toBe(1)
      expect(calls.configure).toBe(2)

      // 5. ready state (XSS-safe explanation, changesSummary, model pill, fixedSql preview + buttons)
      renderSharedAiFixPanel(
        container,
        {
          phase: 'ready',
          aiEnabled: true,
          aiReady: true,
          result: {
            fixedSql: `SELECT id FROM users WHERE note = '${xssPayload}';`,
            explanation: `Column name typo ${xssPayload}`,
            changesSummary: `Renamed usr_id to id ${xssPayload}`,
            language: 'en',
            model: `gpt-4o-mini ${xssPayload}`,
            durationMs: 342.4,
          },
        },
        callbacks
      )
      expect(container.querySelector('img')).toBeNull()
      expect(container.querySelector('.datanoa-ai-pill')?.textContent).toContain('342 ms')
      expect(container.querySelector('.datanoa-ai-pill')?.textContent).toContain('gpt-4o-mini')
      expect(container.querySelector('pre.datanoa-ai-code')?.textContent).toBe(
        `SELECT id FROM users WHERE note = '${xssPayload}';`
      )
      expect(container.textContent).toContain(`Column name typo ${xssPayload}`)
      expect(container.textContent).toContain(`Renamed usr_id to id ${xssPayload}`)

      const readyButtons = Array.from(container.querySelectorAll('button'))
      readyButtons.find((b) => b.textContent === 'Replace Query')?.click()
      readyButtons.find((b) => b.textContent === 'Copy SQL')?.click()
      readyButtons[readyButtons.length - 1]?.click()
      expect(calls.replace).toEqual([`SELECT id FROM users WHERE note = '${xssPayload}';`])
      expect(calls.copy).toEqual([`SELECT id FROM users WHERE note = '${xssPayload}';`])
      expect(calls.dismiss).toBe(2)
    })

    it('replaceSqlRange in Studio console.ts and Side Panel panel-cm.js performs single undoable replacement preserving surrounding statements', () => {
      setupDom()
      const undoCmd = historyKeymap.find((b) => b.key === 'Mod-z')?.run
      expect(typeof undoCmd).toBe('function')

      const multiDoc = 'SELECT 1;\nSELECT * FROM bad_tbl;\nSELECT 2;'

      // --- A. Studio SqlConsoleController ---
      const studioHost = document.createElement('div')
      document.body.appendChild(studioHost)
      const studioConsole = new SqlConsoleController({
        parent: studioHost,
        initialDoc: multiDoc,
        dialect: 'sqlite',
      })

      // Place caret inside statement 2 (`SELECT * FROM bad_tbl`)
      const stmt2Offset = multiDoc.indexOf('bad_tbl') + 2
      studioConsole.setCursorOffset(stmt2Offset)
      const studioRange = studioConsole.getExecutionRange('caret', 'sqlite')
      expect(studioRange).toEqual({
        from: 10,
        to: 31,
        sql: 'SELECT * FROM bad_tbl',
        originalSlice: 'SELECT * FROM bad_tbl',
      })

      // Replace with semicolon-terminated AI fix: must NOT double-semicolon and must preserve stmt 1 & 3
      const studioReplaced = studioConsole.replaceSqlRange(
        studioRange ? { ...studioRange, fallbackSql: studioRange.sql } : null,
        'SELECT * FROM good_tbl;'
      )
      expect(studioReplaced).toBe(true)
      expect(studioConsole.getText()).toBe('SELECT 1;\nSELECT * FROM good_tbl;\nSELECT 2;')

      // Safety guard: stale range + non-matching fallback in multi-statement doc must refuse and return false
      const refused = studioConsole.replaceSqlRange(
        {
          from: 10,
          to: 31,
          originalSlice: 'SELECT * FROM bad_tbl',
          fallbackSql: 'SELECT * FROM totally_missing',
        },
        'SELECT 999;'
      )
      expect(refused).toBe(false)
      expect(studioConsole.getText()).toBe('SELECT 1;\nSELECT * FROM good_tbl;\nSELECT 2;')

      // Direct EditorView undo check via replaceEditorSqlRange
      const viewHost = document.createElement('div')
      document.body.appendChild(viewHost)
      const rawView = new EditorView({
        state: EditorState.create({
          doc: multiDoc,
          selection: { anchor: stmt2Offset },
          extensions: [history()],
        }),
        parent: viewHost,
      })
      const rawRange = extractExecutionRange(rawView, 'caret', 'sqlite')
      expect(rawRange?.sql).toBe('SELECT * FROM bad_tbl')
      expect(
        replaceEditorSqlRange(
          rawView,
          rawRange ? { ...rawRange, fallbackSql: rawRange.sql } : null,
          'SELECT * FROM fixed_tbl;',
          'sqlite'
        )
      ).toBe(true)
      expect(rawView.state.doc.toString()).toBe('SELECT 1;\nSELECT * FROM fixed_tbl;\nSELECT 2;')
      // Single Ctrl+Z undo restores exact original multi-statement script
      expect(undoCmd?.(rawView)).toBe(true)
      expect(rawView.state.doc.toString()).toBe(multiDoc)

      rawView.destroy()
      studioConsole.destroy()

      // --- B. Side Panel panel-cm.js ---
      const panelHost = document.createElement('div')
      document.body.appendChild(panelHost)
      const panelEditor = createPanelCodeMirrorEditor({
        parent: panelHost,
        initialDoc: multiDoc,
        dialect: 'sqlite',
      })
      panelEditor.setCursorOffset(stmt2Offset)
      const panelRange = panelEditor.getExecutionRange('caret', 'sqlite')
      expect(panelRange).toEqual({
        from: 10,
        to: 31,
        sql: 'SELECT * FROM bad_tbl',
        originalSlice: 'SELECT * FROM bad_tbl',
      })
      expect(extractPanelExecutionRange(panelEditor.view.state, 'caret', 'sqlite')).toEqual(
        panelRange
      )

      const panelReplaced = replacePanelSqlRange(
        panelEditor.view,
        panelRange ? { ...panelRange, fallbackSql: panelRange.sql } : null,
        'SELECT * FROM panel_fixed_tbl;',
        'sqlite'
      )
      expect(panelReplaced).toBe(true)
      expect(panelEditor.getValue()).toBe('SELECT 1;\nSELECT * FROM panel_fixed_tbl;\nSELECT 2;')

      // Single undo reverts cleanly
      expect(undoCmd?.(panelEditor.view)).toBe(true)
      expect(panelEditor.getValue()).toBe(multiDoc)

      // Refuses silent corruption on mismatched multi-statement script
      expect(
        panelEditor.replaceSqlRange(
          {
            from: 0,
            to: 5,
            originalSlice: 'WRONG',
            fallbackSql: 'NON_EXISTENT_SQL',
          },
          'SELECT 42;'
        )
      ).toBe(false)
      expect(panelEditor.getValue()).toBe(multiDoc)

      panelEditor.destroy()
    })

    it('Side Panel panel-sql.js exposes Fix with AI on SQL errors and applies undoable Replace Query via ai.fixQuery', async () => {
      const dom = setupDom(true)
      const aiFixRequests: Array<Record<string, unknown>> = []
      const banners: Array<{ msg: string; tone?: string }> = []

      ;(window as unknown as { orca: unknown }).orca = {
        locale: 'en',
        plugin: {
          request: async (method: string, payload?: Record<string, unknown>) => {
            if (method === 'query.run') {
              throw new Error('no such table: bad_users')
            }
            if (method === 'ai.fixQuery') {
              aiFixRequests.push(payload || {})
              return {
                fixedSql: 'SELECT * FROM users LIMIT 10;',
                explanation: 'Table bad_users does not exist; use users instead.',
                changesSummary: 'Replaced bad_users with users',
                language: 'en',
                model: 'gpt-4o-mini',
                durationMs: 180,
              }
            }
            return {}
          },
        },
        settings: {
          get: async () => undefined,
        },
      }

      const panelState: Record<string, unknown> = {
        activeConnectionId: 'c1',
        activeSchema: 'main',
        activeTable: 'users',
        activeQueryId: null,
        activeWorkerQueryId: null,
        lastSqlResult: null,
        sqlSortColIdx: null,
        sqlSortDir: 'ASC',
        sqlColWidths: [],
        sqlRowNumWidth: 42,
        historyOpen: false,
        historyEntries: [],
      }

      const sqlCtrl = createPanelSqlController({
        state: panelState,
        QUERY_TIMEOUT_MS: 30000,
        VIRT_ROW_HEIGHT_PX: 26,
        getActiveConn: () => ({ id: 'c1', name: 'Main DB', driver: 'sqlite', readOnly: false }),
        getConnById: () => ({ id: 'c1', name: 'Main DB', driver: 'sqlite', readOnly: false }),
        getSqlGridSel: () => null,
        getSuppressSortClickUntil: () => 0,
        setLastPanelCopiedText: () => {},
        computeVirtualRange: () => ({ start: 0, end: 0 }),
        attachColumnResizeHandle: () => {},
        copyText: async () => {},
        showBanner: (msg: string, tone?: string) => banners.push({ msg, tone }),
        loadSchema: async () => {},
        savePanelViewState: () => {},
        scheduleSavePanelViewState: () => {},
        savePanelDataCache: () => {},
        onFormatSql: () => {},
        getAiStatus: () => ({
          enabled: true,
          state: 'on',
          explainLanguage: 'en',
          destination: 'remote',
          host: 'api.openai.com',
          model: 'gpt-4o-mini',
        }),
        openAiSettingsModal: () => {},
        onRefreshAiStatus: () => {},
      })

      const script = 'SELECT 1;\nSELECT * FROM bad_users LIMIT 10;\nSELECT 2;'
      sqlCtrl.setSqlText(script, { cursorOffset: script.indexOf('bad_users') + 2 })
      await sqlCtrl.runSql('caret')
      await dom.flushMicrotasks()

      const fixBtn = document.getElementById('sqlFixAiBtn') as HTMLButtonElement
      const fixPanel = document.getElementById('sqlAiFixPanel') as HTMLDivElement
      expect(fixBtn.hidden).toBe(false)
      expect(fixPanel.hidden).toBe(true)

      fixBtn.click()
      await dom.flushMicrotasks()
      await new Promise((r) => setTimeout(r, 10))

      expect(aiFixRequests).toHaveLength(1)
      expect(aiFixRequests[0].sql).toBe('SELECT * FROM bad_users LIMIT 10')
      expect(aiFixRequests[0].errorMessage).toBe('no such table: bad_users')
      expect(fixPanel.hidden).toBe(false)
      expect(fixPanel.textContent).toContain('Table bad_users does not exist')

      const replaceBtn = Array.from(fixPanel.querySelectorAll('button')).find(
        (b) => b.textContent === 'Replace Query'
      ) as HTMLButtonElement | undefined
      expect(replaceBtn).toBeTruthy()
      replaceBtn?.click()

      expect(sqlCtrl.getSqlText()).toBe('SELECT 1;\nSELECT * FROM users LIMIT 10;\nSELECT 2;')
      expect(fixPanel.hidden).toBe(true)
      expect(banners.some((b) => b.msg.includes('Ctrl+Z to undo'))).toBe(true)

      sqlCtrl.destroySqlEditor()
    })
  })

  describe('[v1.2.1] Connection Quick Actions All-Tab Visibility, SQL Squiggly Lint, CSS Parity & #74/#75 P1/P2 Fixes', () => {
    it('panel-app.js keeps #connMetaRow visible across explorer, data, sql, and structure tabs when a connection is active', async () => {
      setupDom(true)
      ;(window as unknown as { orca: unknown }).orca = {
        plugin: {
          request: async (method: string) => {
            if (method === 'connections.list') {
              return [
                {
                  id: 'c_meta_all',
                  name: 'All-Tabs PG',
                  driver: 'postgres',
                  host: '127.0.0.1',
                  port: 5432,
                  database: 'app',
                  user: 'dev',
                },
              ]
            }
            if (method === 'ui.getSessionSnapshot') {
              return { viewState: null, dataCache: null, updatedAt: 0 }
            }
            if (method === 'ui.saveSessionSnapshot') {
              return { ok: true, updatedAt: Date.now() }
            }
            if (method === 'schema.listObjects') return []
            if (method === 'ai.status.get') {
              return { enabled: false, state: 'off', destination: 'none', host: '' }
            }
            return {}
          },
          onEvent: () => ({ dispose: () => {} }),
        },
        host: { onEvent: () => ({ dispose: () => {} }), call: async () => ({}) },
        settings: { onDidChange: () => ({ dispose: () => {} }) },
      }

      vi.resetModules()
      await import('../src/panel/panel-app.js')
      await new Promise((r) => setTimeout(r, 40))

      const metaRow = document.getElementById('connMetaRow') as HTMLElement | null
      expect(metaRow).toBeTruthy()
      expect(metaRow?.hidden).toBe(false)

      for (const tabKey of ['data', 'sql', 'structure', 'explorer']) {
        const tabBtn = document.querySelector(`.nav-tab[data-tab="${tabKey}"]`) as HTMLButtonElement | null
        expect(tabBtn).toBeTruthy()
        tabBtn?.click()
        expect(metaRow?.hidden).toBe(false)
      }

      // Opening the connection form still hides #connMetaRow cleanly
      ;(document.getElementById('newServerBtn') as HTMLButtonElement | null)?.click()
      expect(metaRow?.hidden).toBe(true)
    })

    it('createCmSqlLintExtension underlines misspelled SQL with .cm-sql-diag-error, yields 0 decorations on valid SQL, and clears live DB errors on doc edits', async () => {
      const dom = setupDom()
      let currentDialect = 'postgres'
      const host = document.createElement('div')
      document.body.appendChild(host)

      const view = new EditorView({
        state: EditorState.create({
          doc: 'SELCT * FROM users',
          selection: { anchor: 18 },
          extensions: [
            createCmSqlLintExtension({
              getDialect: () => currentDialect,
              debounceMs: 25,
            }),
          ],
        }),
        parent: host,
      })

      // Wait for initial microtask lint pass
      await dom.flushMicrotasks()
      const badSpans = host.querySelectorAll('.cm-sql-diag-error')
      expect(badSpans.length).toBeGreaterThanOrEqual(1)
      expect(badSpans[0].textContent).toBe('SELCT')
      expect(badSpans[0].getAttribute('data-sql-diag')).toContain('SELECT')

      // Fix typo -> after debounce, 0 diagnostic decorations remain
      view.dispatch({
        changes: { from: 0, to: 5, insert: 'SELECT' },
        selection: { anchor: 19 },
      })
      await new Promise((r) => setTimeout(r, 45))
      expect(host.querySelectorAll('.cm-sql-diag-error').length).toBe(0)
      expect(host.querySelectorAll('.cm-sql-diag-warn').length).toBe(0)

      // Overlay live DB syntax error via setDbSqlErrorEffect
      view.dispatch({
        effects: setDbSqlErrorEffect.of({
          errorMessage: 'syntax error at or near "users"',
          targetRange: { from: 0, to: view.state.doc.length },
        }),
      })
      expect(view.state.field(sqlDiagnosticsField).dbDiag).toBeTruthy()
      const dbErrorSpans = host.querySelectorAll('.cm-sql-diag-error')
      expect(dbErrorSpans.length).toBe(1)
      expect(dbErrorSpans[0].textContent).toBe('users')
      expect(dbErrorSpans[0].getAttribute('data-sql-diag')).toContain('syntax error')

      // Any document edit automatically clears live DB error marker
      view.dispatch({
        changes: { from: view.state.doc.length, to: view.state.doc.length, insert: ' ' },
      })
      expect(view.state.field(sqlDiagnosticsField).dbDiag).toBeNull()
      expect(host.querySelectorAll('.cm-sql-diag-error').length).toBe(0)

      // Explicit clearDbSqlErrorEffect clears live DB error without editing doc
      view.dispatch({
        effects: setDbSqlErrorEffect.of({
          errorMessage: 'syntax error at or near "users"',
          targetRange: null,
        }),
      })
      expect(view.state.field(sqlDiagnosticsField).dbDiag).toBeTruthy()
      view.dispatch({ effects: clearDbSqlErrorEffect.of(undefined) })
      expect(view.state.field(sqlDiagnosticsField).dbDiag).toBeNull()

      // Dialect switch to non-SQL ('redis') + triggerSqlLintEffect clears static SQL errors immediately
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: 'SELCT * FROM users' },
        selection: { anchor: 18 },
      })
      await new Promise((r) => setTimeout(r, 45))
      expect(host.querySelectorAll('.cm-sql-diag-error').length).toBeGreaterThanOrEqual(1)
      currentDialect = 'redis'
      view.dispatch({ effects: triggerSqlLintEffect.of(undefined) })
      await dom.flushMicrotasks()
      expect(host.querySelectorAll('.cm-sql-diag-error').length).toBe(0)

      view.destroy()
    })

    it('declares .cm-ai-replace-strike and .cm-sql-diag-error/.cm-sql-diag-warn/.cm-sql-diag-tooltip with Dark + Light parity in both Studio and Side Panel', () => {
      const consoleTs = fs.readFileSync(path.join(process.cwd(), 'src', 'editor', 'console.ts'), 'utf8')
      const panelCmJs = fs.readFileSync(path.join(process.cwd(), 'src', 'panel', 'panel-cm.js'), 'utf8')
      const panelCss = fs.readFileSync(path.join(process.cwd(), 'src', 'panel', 'panel.css'), 'utf8')

      for (const blob of [EDITOR_STYLE, panelCss]) {
        expect(blob).toContain('.cm-ai-replace-strike')
        expect(blob).toContain('html.light .cm-ai-replace-strike')
        expect(blob).toContain('body.light .cm-ai-replace-strike')
        expect(blob).toContain('.cm-sql-diag-error')
        expect(blob).toContain('html.light .cm-sql-diag-error')
        expect(blob).toContain('body.light .cm-sql-diag-error')
        expect(blob).toContain('.cm-sql-diag-warn')
        expect(blob).toContain('html.light .cm-sql-diag-warn')
        expect(blob).toContain('.cm-sql-diag-tooltip')
        expect(blob).not.toMatch(/^\s*--orca-[a-z0-9-]+\s*:/m)
      }

      for (const cmSrc of [consoleTs, panelCmJs]) {
        expect(cmSrc).toContain("'.cm-ai-replace-strike'")
        expect(cmSrc).toContain("'.cm-sql-diag-error'")
        expect(cmSrc).toContain("'.cm-sql-diag-warn'")
        expect(cmSrc).toContain("'.cm-sql-diag-tooltip'")
        expect(cmSrc).toContain('createCmSqlLintExtension')
        expect(cmSrc).toContain('setDbSyntaxError')
        expect(cmSrc).toContain('clearDbSyntaxError')
      }
    })

    it('[#75 P1 #1 & #3, P2 #1 & #2] permits Fix with AI + Retry when aiStatus.state === "error", guards onReplaceQuery against tab/connection switches, aligns timeoutMs to 50000, and matches early-stop multi-statement batches', async () => {
      const dom = setupDom(true)
      const fixCalls: Array<{ payload: Record<string, unknown>; timeoutMs?: number }> = []
      let aiFixAttempt = 0

      ;(window as unknown as { orca: unknown }).orca = {
        locale: 'en',
        plugin: {
          request: async (
            method: string,
            payload?: Record<string, unknown>,
            opts?: { timeoutMs?: number }
          ) => {
            if (method === 'query.run') {
              // Early-stop multi-statement result: 3 statements sent, stopped at statement 2 (idx 1)
              return {
                columns: [],
                rows: [],
                rowCount: 0,
                executionTimeMs: 4,
                truncated: false,
                isSelect: false,
                resultSets: [
                  {
                    index: 0,
                    sql: 'SELECT 1',
                    sqlPreview: 'SELECT 1',
                    columns: [{ name: '1', type: 'INT' }],
                    rows: [[1]],
                    rowCount: 1,
                    executionTimeMs: 1,
                    truncated: false,
                    isSelect: true,
                  },
                  {
                    index: 1,
                    sql: 'SELECT * FROM bad_t',
                    sqlPreview: 'SELECT * FROM bad_t',
                    isError: true,
                    errorMessage: 'near "bad_t": syntax error',
                    columns: [],
                    rows: [],
                    rowCount: 0,
                    executionTimeMs: 2,
                    truncated: false,
                    isSelect: true,
                  },
                ],
              }
            }
            if (method === 'ai.fixQuery') {
              fixCalls.push({ payload: payload || {}, timeoutMs: opts?.timeoutMs })
              aiFixAttempt += 1
              if (aiFixAttempt === 1) {
                throw new Error('Temporary provider 503')
              }
              return {
                fixedSql: 'SELECT * FROM good_t;',
                explanation: 'Fixed table name',
                changesSummary: 'bad_t -> good_t',
                language: 'en',
                model: 'gpt-4o-mini',
                durationMs: 120,
              }
            }
            return {}
          },
        },
        settings: { get: async () => undefined },
      }

      let activeConnId = 'c1'
      const panelState: Record<string, unknown> = {
        activeConnectionId: 'c1',
        activeSchema: 'main',
        activeTable: 'users',
        activeQueryId: null,
        activeWorkerQueryId: null,
        lastSqlResult: null,
        sqlSortColIdx: null,
        sqlSortDir: 'ASC',
        sqlColWidths: [],
        sqlRowNumWidth: 42,
        historyOpen: false,
        historyEntries: [],
      }
      const aiStatus: AiStatusSnapshot = {
        enabled: true,
        state: 'error',
        explainLanguage: 'en',
        destination: 'remote',
        host: 'api.openai.com',
        model: 'gpt-4o-mini',
        lastError: 'Previous transient error',
      }

      const sqlCtrl = createPanelSqlController({
        state: panelState,
        QUERY_TIMEOUT_MS: 30000,
        VIRT_ROW_HEIGHT_PX: 26,
        getActiveConn: () => ({ id: activeConnId, name: 'DB', driver: 'sqlite', readOnly: false }),
        getConnById: (id: string) => ({ id, name: 'DB', driver: 'sqlite', readOnly: false }),
        getSqlGridSel: () => null,
        getSuppressSortClickUntil: () => 0,
        setLastPanelCopiedText: () => {},
        computeVirtualRange: () => ({ start: 0, end: 0 }),
        attachColumnResizeHandle: () => {},
        copyText: async () => {},
        showBanner: () => {},
        loadSchema: async () => {},
        savePanelViewState: () => {},
        scheduleSavePanelViewState: () => {},
        savePanelDataCache: () => {},
        onFormatSql: () => {},
        getAiStatus: () => aiStatus,
        openAiSettingsModal: () => {},
        onRefreshAiStatus: () => {},
      })

      // 3-statement Run All where worker stops early at statement 2
      const script = 'SELECT 1;\nSELECT * FROM bad_t;\nSELECT * FROM bad_t;'
      sqlCtrl.setSqlText(script)
      await sqlCtrl.runSql('all')
      await dom.flushMicrotasks()

      // Select Result 2 (error) if needed and click Fix with AI while aiStatus.state === 'error'
      const errTabBtn = Array.from(document.querySelectorAll('#sqlResultSetsBar button')).find((b) =>
        b.textContent?.includes('Error')
      ) as HTMLButtonElement | undefined
      errTabBtn?.click()

      const fixBtn = document.getElementById('sqlFixAiBtn') as HTMLButtonElement
      const fixPanel = document.getElementById('sqlAiFixPanel') as HTMLDivElement
      expect(fixBtn.hidden).toBe(false)

      // Attempt 1 fails -> Retry button MUST still be visible even though aiStatus.state === 'error'
      fixBtn.click()
      await dom.flushMicrotasks()
      await new Promise((r) => setTimeout(r, 15))
      expect(fixCalls).toHaveLength(1)
      expect(fixCalls[0].timeoutMs).toBe(65000)
      const retryBtn = Array.from(fixPanel.querySelectorAll('button')).find(
        (b) => b.textContent === 'Retry'
      ) as HTMLButtonElement | undefined
      expect(retryBtn).toBeTruthy()

      // Attempt 2 via Retry succeeds
      retryBtn?.click()
      await dom.flushMicrotasks()
      await new Promise((r) => setTimeout(r, 15))
      expect(fixCalls).toHaveLength(2)
      const replaceBtn = Array.from(fixPanel.querySelectorAll('button')).find(
        (b) => b.textContent === 'Replace Query'
      ) as HTMLButtonElement | undefined
      expect(replaceBtn).toBeTruthy()

      // P1 #3 origin guard: simulate connection change before clicking Replace Query -> MUST abort silently!
      activeConnId = 'c2'
      panelState.activeConnectionId = 'c2'
      replaceBtn?.click()
      expect(sqlCtrl.getSqlText()).toBe(script)
      expect(fixPanel.hidden).toBe(true)

      // Restore origin connection, re-run Fix with AI, and verify early-stop P2 #2 replaces ONLY statement 2 (not duplicate stmt 3!)
      activeConnId = 'c1'
      panelState.activeConnectionId = 'c1'
      fixBtn.click()
      await dom.flushMicrotasks()
      await new Promise((r) => setTimeout(r, 15))
      const replaceBtn2 = Array.from(fixPanel.querySelectorAll('button')).find(
        (b) => b.textContent === 'Replace Query'
      ) as HTMLButtonElement | undefined
      replaceBtn2?.click()
      expect(sqlCtrl.getSqlText()).toBe('SELECT 1;\nSELECT * FROM good_t;\nSELECT * FROM bad_t;')

      sqlCtrl.destroySqlEditor()

      // Verify panel-app.js selectTableAndOpen clears Fix panel & DB syntax error, and Studio index.ts wires P1 #1/#3 & P2 #1/#2
      const panelAppSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'panel', 'panel-app.js'), 'utf8')
      const selectTableSlice = panelAppSrc.slice(
        panelAppSrc.indexOf('function selectTableAndOpen('),
        panelAppSrc.indexOf('async function deleteConnectionById(')
      )
      expect(selectTableSlice).toContain('sqlCtrl.clearAiFixPanel?.()')
      expect(selectTableSlice).toContain('sqlCtrl.clearDbSyntaxError?.()')

      const studioIdxSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'editor', 'index.ts'), 'utf8')
      expect(studioIdxSrc).toContain('private isAiConfiguredAndEnabled(): boolean')
      expect(studioIdxSrc).toContain("this.aiStatus.state === 'error'")
      expect(studioIdxSrc).toContain('this.activeConnectionId !== current.originConnectionId')
      expect(studioIdxSrc).toContain('this.consoleTabs.getActiveTabId() !== current.originTabId')
      expect(studioIdxSrc).toContain("this.sqlConsole.getExecutionRange?.('explain', driver) ?? null")
      expect(studioIdxSrc).toContain("this.sqlConsole.getExecutionRange?.(executeAll ? 'all' : 'caret', driver) ?? null")
      expect(studioIdxSrc).not.toContain('timeoutMs: 25_000')
    })
  })

  describe('Unslop AI status button, hover contrast fix, inline error recovery & vertical AI panel resizers', () => {
    it('preserves high-contrast primary & ghost hover states in Studio theme.ts and panel.css (Dark & Light) and removes circle status dot', () => {
      const panelCss = fs.readFileSync(path.join(process.cwd(), 'src', 'panel', 'panel.css'), 'utf8')

      // Primary AI button hover MUST explicitly preserve primary background + primary-fg (never dark --btn-hover-bg!)
      const primaryHoverMatch = EDITOR_STYLE.match(
        /\.datanoa-ai-btn\.btn-primary:hover:not\(:disabled\)\s*\{([^}]*)\}/
      )
      expect(primaryHoverMatch).toBeTruthy()
      expect(primaryHoverMatch?.[1]).toContain('background: var(--primary-hover, color-mix(in srgb, var(--primary) 88%, var(--bg)))')
      expect(primaryHoverMatch?.[1]).toContain('color: var(--primary-fg)')
      expect(primaryHoverMatch?.[1]).toContain('border-color: var(--primary)')
      expect(primaryHoverMatch?.[1]).toContain('opacity: 1')

      // Ghost AI button hover MUST explicitly restore text contrast
      const ghostHoverMatch = EDITOR_STYLE.match(
        /\.datanoa-ai-btn\.btn-ghost:hover:not\(:disabled\)\s*\{([^}]*)\}/
      )
      expect(ghostHoverMatch).toBeTruthy()
      expect(ghostHoverMatch?.[1]).toContain('background: var(--btn-hover-bg)')
      expect(ghostHoverMatch?.[1]).toContain('color: var(--text)')
      expect(ghostHoverMatch?.[1]).toContain('border-color: var(--btn-hover-border)')

      // Studio .datanoa-btn-primary & Side Panel .btn-primary hover preserve primary-fg in both modes
      expect(EDITOR_STYLE).toMatch(
        /\.datanoa-btn-primary:hover:not\(:disabled\)\s*\{[^}]*color:\s*var\(--primary-fg\)/
      )
      expect(panelCss).toMatch(
        /\.btn-primary:hover:not\(:disabled\)\s*\{[^}]*color:\s*var\(--primary-fg\)/
      )
      expect(panelCss).toMatch(
        /\.datanoa-ai-btn\.btn-primary:hover:not\(:disabled\)\s*\{[^}]*color:\s*var\(--primary-fg\)/
      )

      // Old 6px circle dot ::before MUST be completely removed; replaced by monochrome SVG .datanoa-ai-icon tone coloring
      expect(EDITOR_STYLE).not.toContain('.datanoa-ai-toolbar-btn::before')
      expect(panelCss).not.toContain('.datanoa-ai-toolbar-btn::before')
      expect(EDITOR_STYLE).toContain('.datanoa-ai-toolbar-btn.tone-success .datanoa-ai-icon')
      expect(panelCss).toContain('.datanoa-ai-toolbar-btn.tone-success .datanoa-ai-icon')

      // Status bar actions cluster & vertical AI resizer rules present in both Dark & Light compatible tokens
      expect(EDITOR_STYLE).toContain('.datanoa-status-actions')
      expect(EDITOR_STYLE).toContain('.datanoa-ai-resizer')
      expect(EDITOR_STYLE).toContain('.datanoa-ai-panel-scroll')
      expect(panelCss).toContain('.datanoa-ai-resizer')
      expect(panelCss).toContain('.datanoa-ai-panel-scroll')
    })

    it('places Studio aiBtn with shortcutsBtn & feedbackBtn in .datanoa-status-actions, renders crisp SVG + Title Case across states, and syncs Side Panel #sqlAiBtn', () => {
      const dom = setupDom(false)

      // Title Case badge formatting across all states
      expect(formatAiStatusBadge(null).label).toBe('AI · Off')
      expect(formatAiStatusBadge({ enabled: false, state: 'off' }).label).toBe('AI · Off')
      expect(formatAiStatusBadge({ enabled: true, state: 'on' }).label).toBe('AI · On')
      expect(formatAiStatusBadge({ enabled: true, state: 'setup' }).label).toBe('AI · Setup')
      expect(formatAiStatusBadge({ enabled: true, state: 'slow' }).label).toBe('AI · Slow')
      expect(formatAiStatusBadge({ enabled: true, state: 'error' }).label).toBe('AI · Error')
      expect(formatAiStatusBadge({ enabled: true, state: 'on', lastMs: 4100 }).label).toBe('AI · 4.1s')

      // Studio DOM layout: aiBtn moved out of sqlToolbarEl into .datanoa-status-actions inside .datanoa-status-bar
      const studioDom = createStudioDomTree(100, () => {}, document.createElement('div'))

      expect(studioDom.sqlToolbarEl.contains(studioDom.aiBtn)).toBe(false)
      const statusBar = studioDom.rootEl.querySelector('.datanoa-status-bar') as HTMLElement | null
      const statusActions = statusBar?.querySelector('.datanoa-status-actions') as HTMLElement | null
      expect(statusBar).toBeTruthy()
      expect(statusActions).toBeTruthy()
      expect(statusActions?.contains(studioDom.aiBtn)).toBe(true)
      expect(statusActions?.contains(studioDom.shortcutsBtn)).toBe(true)
      expect(statusActions?.contains(studioDom.feedbackBtn)).toBe(true)
      expect(Array.from(statusActions?.children || [])).toEqual([
        studioDom.aiBtn,
        studioDom.shortcutsBtn,
        studioDom.feedbackBtn,
      ])

      const initIcon = studioDom.aiBtn.querySelector('svg.datanoa-ai-icon')
      const initLabel = studioDom.aiBtn.querySelector('.datanoa-ai-label')
      expect(initIcon).toBeTruthy()
      expect(initIcon?.getAttribute('aria-hidden')).toBe('true')
      expect(initLabel?.textContent).toBe('AI · Off')

      // Updating via renderAiStatusButtonContent updates label, icon, title, aria-label cleanly
      const updated = renderAiStatusButtonContent(studioDom.aiBtn, {
        enabled: true,
        state: 'on',
        model: 'gpt-4o-mini',
        destination: 'remote',
        host: 'api.openai.com',
      })
      expect(updated.tone).toBe('success')
      expect(updated.label).toBe('AI · On')
      expect(studioDom.aiBtn.querySelector('svg.datanoa-ai-icon')).toBeTruthy()
      expect(studioDom.aiBtn.querySelector('.datanoa-ai-label')?.textContent).toBe('AI · On')
      expect(studioDom.aiBtn.getAttribute('aria-label')).toContain('AI SQL Assistant')

      // Side Panel #sqlAiBtn renders SVG + Title Case on init and onAiStatusChanged
      dom.teardown()
      activeDom = null
      const panelHtml = fs.readFileSync(path.join(process.cwd(), 'src', 'panel', 'panel.html'), 'utf8')
      expect(panelHtml).toContain('>AI · Off</button>')
      setupDom(true)
      let currentStatus: AiStatusSnapshot = { enabled: false, state: 'off' }
      const panelState = {
        activeConnectionId: 'c1',
        activeSchema: undefined,
        activeTable: 'users',
        activeQueryId: null,
        activeWorkerQueryId: null,
        lastSqlResult: null,
        sqlSortColIdx: null,
        sqlSortDir: 'ASC',
        sqlColWidths: [],
        sqlRowNumWidth: 42,
        historyOpen: false,
        historyEntries: [],
      }
      const sqlCtrl = createPanelSqlController({
        state: panelState,
        QUERY_TIMEOUT_MS: 30000,
        VIRT_ROW_HEIGHT_PX: 26,
        getActiveConn: () => ({ id: 'c1', name: 'DB', driver: 'sqlite', readOnly: false }),
        getConnById: () => ({ id: 'c1', name: 'DB', driver: 'sqlite', readOnly: false }),
        getSqlGridSel: () => null,
        getSuppressSortClickUntil: () => 0,
        setLastPanelCopiedText: () => {},
        computeVirtualRange: () => ({ start: 0, end: 0 }),
        attachColumnResizeHandle: () => {},
        copyText: async () => {},
        showBanner: () => {},
        loadSchema: async () => {},
        savePanelViewState: () => {},
        scheduleSavePanelViewState: () => {},
        savePanelDataCache: () => {},
        onFormatSql: () => {},
        getAiStatus: () => currentStatus,
        openAiSettingsModal: () => {},
        onRefreshAiStatus: () => {},
      })
      const panelBtn = document.getElementById('sqlAiBtn') as HTMLButtonElement
      expect(panelBtn.querySelector('svg.datanoa-ai-icon')).toBeTruthy()
      expect(panelBtn.querySelector('.datanoa-ai-label')?.textContent).toBe('AI · Off')

      currentStatus = { enabled: true, state: 'error', reason: 'HTTP 504' }
      sqlCtrl.onAiStatusChanged()
      expect(panelBtn.querySelector('svg.datanoa-ai-icon')).toBeTruthy()
      expect(panelBtn.querySelector('.datanoa-ai-label')?.textContent).toBe('AI · Error')
      expect(panelBtn.className).toContain('tone-danger')
      sqlCtrl.destroySqlEditor()
    })

    it('mounts vertical drag resizer on BOTH renderSharedExplainAiPanel and renderSharedAiFixPanel with drag, keyboard, persistence & double-click reset', () => {
      setupDom(false)

      // 1. Execution Plan Analysis panel (top edge drag: dragging UP increases height)
      const explainContainer = document.createElement('div')
      ;(explainContainer as unknown as { _rect: Record<string, number> })._rect = {
        left: 0,
        top: 400,
        right: 800,
        bottom: 600,
        width: 800,
        height: 200,
      }
      document.body.appendChild(explainContainer)
      const onExplainResize = vi.fn()
      const explainState = {
        phase: 'ready' as const,
        aiEnabled: true,
        aiReady: true,
        explainLanguage: 'en' as const,
        collapsed: false,
        result: {
          summary: 'Sequential scan on large table.',
          bottlenecks: [{ severity: 'high' as const, title: 'Seq Scan', detail: 'Add composite index.' }],
          indexSuggestions: [],
          caveats: [],
          language: 'en',
          durationMs: 220,
        },
      }
      const explainCb = {
        onAnalyze: () => {},
        onConfigureAi: () => {},
        onCancel: () => {},
        onApplySql: () => {},
        onOpenNewTab: () => {},
        onCopyText: () => {},
        onToggleCollapsed: () => {},
        resizeEdge: 'top' as const,
        onResize: onExplainResize,
      }
      renderSharedExplainAiPanel(explainContainer, explainState, explainCb)

      const topResizer = explainContainer.querySelector('.datanoa-ai-resizer.is-top') as HTMLElement | null
      expect(topResizer).toBeTruthy()
      expect(topResizer?.querySelector('.datanoa-ai-resizer-grip')).toBeTruthy()
      expect(explainContainer.firstElementChild).toBe(topResizer)
      expect(explainContainer.querySelector('.datanoa-ai-panel-scroll')).toBeTruthy()

      // Drag UP by 120px (startY=400 -> moveY=280) => height 200 + 120 = 320px
      topResizer?.dispatchEvent(new MouseEvent('mousedown', { clientY: 400, button: 0 }))
      window.dispatchEvent(new MouseEvent('mousemove', { clientY: 280 }))
      window.dispatchEvent(new MouseEvent('mouseup', { clientY: 280 }))
      expect(explainContainer.style.height).toBe('320px')
      expect(explainContainer.style.maxHeight).toBe('none')
      expect(explainContainer.dataset.userHeight).toBe('320')
      expect(onExplainResize).toHaveBeenCalled()

      // Re-rendering in ready preserves saved height; collapsed clears inline height without losing dataset
      renderSharedExplainAiPanel(explainContainer, explainState, explainCb)
      expect(explainContainer.style.height).toBe('320px')
      renderSharedExplainAiPanel(explainContainer, { ...explainState, collapsed: true }, explainCb)
      expect(explainContainer.style.height).toBe('')
      expect(explainContainer.querySelector('.datanoa-ai-resizer')).toBeNull()
      renderSharedExplainAiPanel(explainContainer, explainState, explainCb)
      expect(explainContainer.style.height).toBe('320px')

      // Double-click resets height & dataset.userHeight cleanly
      const resizerAgain = explainContainer.querySelector('.datanoa-ai-resizer.is-top') as HTMLElement
      resizerAgain.dispatchEvent(new MouseEvent('dblclick'))
      expect(explainContainer.style.height).toBe('')
      expect(explainContainer.style.maxHeight).toBe('')
      expect(explainContainer.dataset.userHeight).toBeUndefined()

      // 2. AI Query Fix panel (bottom edge drag: dragging DOWN increases height)
      const fixContainer = document.createElement('div')
      ;(fixContainer as unknown as { _rect: Record<string, number> })._rect = {
        left: 0,
        top: 100,
        right: 800,
        bottom: 280,
        width: 800,
        height: 180,
      }
      document.body.appendChild(fixContainer)
      const onFixResize = vi.fn()
      const fixCb = {
        onReplaceQuery: () => {},
        onCopySql: () => {},
        onRetry: () => {},
        onCancel: () => {},
        onDismiss: () => {},
        onConfigureAi: () => {},
        resizeEdge: 'bottom' as const,
        onResize: onFixResize,
      }
      renderSharedAiFixPanel(
        fixContainer,
        {
          phase: 'ready',
          aiEnabled: true,
          aiReady: true,
          result: {
            explanation: 'Fixed missing FROM clause.',
            changesSummary: 'Added FROM users',
            fixedSql: 'SELECT * FROM users;',
            durationMs: 140,
            model: 'gpt-4o-mini',
          },
        },
        fixCb
      )
      const bottomResizer = fixContainer.querySelector('.datanoa-ai-resizer.is-bottom') as HTMLElement | null
      expect(bottomResizer).toBeTruthy()
      expect(fixContainer.lastElementChild).toBe(bottomResizer)
      expect(fixContainer.querySelector('.datanoa-ai-panel-scroll')).toBeTruthy()

      // Drag DOWN by 90px (startY=280 -> moveY=370) => height 180 + 90 = 270px
      bottomResizer?.dispatchEvent(new MouseEvent('mousedown', { clientY: 280, button: 0 }))
      window.dispatchEvent(new MouseEvent('mousemove', { clientY: 370 }))
      window.dispatchEvent(new MouseEvent('mouseup', { clientY: 370 }))
      expect(fixContainer.style.height).toBe('270px')
      expect(fixContainer.dataset.userHeight).toBe('270')
      expect(onFixResize).toHaveBeenCalled()

      // Keyboard ArrowDown expands by +24px (270 -> 294px)
      ;(fixContainer as unknown as { _rect: Record<string, number> })._rect.height = 270
      bottomResizer?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
      expect(fixContainer.style.height).toBe('294px')
      expect(fixContainer.dataset.userHeight).toBe('294')

      // Hidden clears height styles cleanly
      renderSharedAiFixPanel(fixContainer, { phase: 'hidden', aiEnabled: true, aiReady: true }, fixCb)
      expect(fixContainer.hidden).toBe(true)
      expect(fixContainer.style.height).toBe('')
      expect(fixContainer.style.maxHeight).toBe('')
    })

    it('keeps inline AI enabled when aiStatus.state === "error" and forwards manual + bumped timeouts in Studio & Side Panel', async () => {
      const studioIdxSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'editor', 'index.ts'), 'utf8')
      const panelSqlSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'panel', 'panel-sql.js'), 'utf8')

      // Studio isAiInlineReady allows error state (only excludes 'off' and 'setup')
      const readyFnStart = studioIdxSrc.indexOf('private isAiInlineReady(): boolean')
      const readyFnSlice = studioIdxSrc.slice(readyFnStart, readyFnStart + 260)
      expect(readyFnSlice).toContain("this.aiStatus.state !== 'off'")
      expect(readyFnSlice).toContain("this.aiStatus.state !== 'setup'")
      expect(studioIdxSrc).toContain('...(manual ? { manual: true } : {})')
      expect(studioIdxSrc).toContain('timeoutMs: 18_000')
      expect(studioIdxSrc).toContain('timeoutMs: 65_000')
      expect(studioIdxSrc).not.toContain('timeoutMs: 12_000')
      expect(studioIdxSrc).not.toContain('timeoutMs: 50_000')

      // Side Panel aiInline.isEnabled & isPanelAiReady allow error state and bump timeouts
      expect(panelSqlSrc).toContain("s.state !== 'off' && s.state !== 'setup'")
      expect(panelSqlSrc).toContain('...(manual ? { manual: true } : {})')
      expect(panelSqlSrc).toContain('timeoutMs: 18000')
      expect(panelSqlSrc).toContain('timeoutMs: 65000')
      expect(panelSqlSrc).not.toContain('timeoutMs: 12000')
      expect(panelSqlSrc).not.toContain('timeoutMs: 50000')

      // Live Side Panel inline AI smoke check when state === 'error'
      setupDom(true)
      const completeCalls: Array<{ input: Record<string, unknown>; timeoutMs?: number }> = []
      ;(window as unknown as Record<string, unknown>).orca = {
        plugin: {
          request: vi.fn(async (name: string, input: Record<string, unknown>, opts?: { timeoutMs?: number }) => {
            if (name === 'ai.complete') {
              completeCalls.push({ input, timeoutMs: opts?.timeoutMs })
              return { id: 1, suggestion: ' LIMIT 10' }
            }
            return {}
          }),
        },
      }
      const sqlCtrl = createPanelSqlController({
        state: {
          activeConnectionId: 'c1',
          activeSchema: undefined,
          activeTable: 'users',
          activeQueryId: null,
          activeWorkerQueryId: null,
          lastSqlResult: null,
          sqlSortColIdx: null,
          sqlSortDir: 'ASC',
          sqlColWidths: [],
          sqlRowNumWidth: 42,
          historyOpen: false,
          historyEntries: [],
        },
        QUERY_TIMEOUT_MS: 30000,
        VIRT_ROW_HEIGHT_PX: 26,
        getActiveConn: () => ({ id: 'c1', name: 'DB', driver: 'sqlite', readOnly: false }),
        getConnById: () => ({ id: 'c1', name: 'DB', driver: 'sqlite', readOnly: false }),
        getSqlGridSel: () => null,
        getSuppressSortClickUntil: () => 0,
        setLastPanelCopiedText: () => {},
        computeVirtualRange: () => ({ start: 0, end: 0 }),
        attachColumnResizeHandle: () => {},
        copyText: async () => {},
        showBanner: () => {},
        loadSchema: async () => {},
        savePanelViewState: () => {},
        scheduleSavePanelViewState: () => {},
        savePanelDataCache: () => {},
        onFormatSql: () => {},
        getAiStatus: () => ({ enabled: true, state: 'error', reason: 'Transient 504' }),
        openAiSettingsModal: () => {},
        onRefreshAiStatus: () => {},
      })
      // Trigger onAiStatusChanged under error state — should remain ready without clearing lockout
      sqlCtrl.onAiStatusChanged()
      const btn = document.getElementById('sqlAiBtn') as HTMLButtonElement
      expect(btn.querySelector('.datanoa-ai-label')?.textContent).toBe('AI · Error')
      expect(completeCalls).toHaveLength(0)
      sqlCtrl.destroySqlEditor()
    })

    it('renders CM6 native .cm-placeholder inside .cm-content in Side Panel SQL editor without overlapping .cm-gutters', () => {
      const panelCss = fs.readFileSync(path.join(process.cwd(), 'src', 'panel', 'panel.css'), 'utf8')
      expect(panelCss).not.toContain('.sql-cm-mount.is-empty::after')
      expect(panelCss).toContain('.sql-cm-mount .cm-placeholder')

      setupDom(false)
      const mount = document.createElement('div')
      mount.className = 'sql-cm-mount'
      document.body.appendChild(mount)

      const editor = createPanelCodeMirrorEditor({
        parent: mount,
        initialDoc: '',
        dialect: 'postgres',
      })

      try {
        editor.setPlaceholder('SELECT * FROM table_name LIMIT 25;')
        expect(mount.dataset.placeholder).toBe('SELECT * FROM table_name LIMIT 25;')

        const cmContent = mount.querySelector('.cm-content')
        const cmGutters = mount.querySelector('.cm-gutters')
        expect(cmContent).toBeTruthy()
        expect(cmGutters).toBeTruthy()

        const ph1 = cmContent?.querySelector('.cm-placeholder') as HTMLElement | null
        expect(ph1).toBeTruthy()
        expect(ph1?.textContent).toBe('SELECT * FROM table_name LIMIT 25;')
        expect(cmGutters?.querySelector('.cm-placeholder')).toBeNull()

        // Dynamic update via setPlaceholder(...)
        editor.setPlaceholder('db.collection.find({}).limit(25)')
        expect(mount.dataset.placeholder).toBe('db.collection.find({}).limit(25)')
        const ph2 = cmContent?.querySelector('.cm-placeholder') as HTMLElement | null
        expect(ph2?.textContent).toBe('db.collection.find({}).limit(25)')

        // Typing / non-empty doc hides native placeholder; clearing restores it
        editor.setValue('SELECT 1;')
        expect(cmContent?.querySelector('.cm-placeholder')).toBeNull()
        editor.setValue('')
        expect(cmContent?.querySelector('.cm-placeholder')?.textContent).toBe(
          'db.collection.find({}).limit(25)'
        )

        // Clearing placeholder string removes .cm-placeholder widget
        editor.setPlaceholder('')
        expect(mount.dataset.placeholder).toBe('')
        expect(cmContent?.querySelector('.cm-placeholder')).toBeNull()
      } finally {
        editor.destroy()
      }
    })

    it('pins .datanoa-ai-fix-footer outside .datanoa-ai-panel-scroll before bottom resizer, tracks dataset phase/collapsed, exports resolveExplainAiPhase, and clamps getAiPanelMaxHeight to parent bounds', () => {
      setupDom(false)
      const origInnerHeight = window.innerHeight
      Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 1000 })

      try {
        // 1. Pure resolveExplainAiPhase helper
        const sampleAnalysis = {
          summary: 'Index scan used.',
          bottlenecks: [],
          indexSuggestions: [],
          caveats: [],
          language: 'en' as const,
          durationMs: 42,
        }
        expect(resolveExplainAiPhase(true, 'err', sampleAnalysis)).toBe('loading')
        expect(resolveExplainAiPhase(false, 'Timeout', sampleAnalysis)).toBe('error')
        expect(resolveExplainAiPhase(false, null, sampleAnalysis)).toBe('ready')
        expect(resolveExplainAiPhase(false, null, null)).toBe('idle')

        // 2. AI Query Fix panel pins .datanoa-ai-fix-footer directly under container, outside scrollWrap, before bottomResizer
        const parent = document.createElement('div')
        ;(parent as unknown as { _rect: Record<string, number> })._rect = {
          left: 0,
          top: 100,
          right: 900,
          bottom: 500,
          width: 900,
          height: 400,
        }
        const fixContainer = document.createElement('div')
        ;(fixContainer as unknown as { _rect: Record<string, number> })._rect = {
          left: 0,
          top: 220,
          right: 900,
          bottom: 380,
          width: 900,
          height: 160,
        }
        parent.appendChild(fixContainer)
        document.body.appendChild(parent)

        const replaceSpy = vi.fn()
        const copySpy = vi.fn()
        const dismissSpy = vi.fn()
        const fixCb = {
          onReplaceQuery: replaceSpy,
          onCopySql: copySpy,
          onRetry: () => {},
          onCancel: () => {},
          onDismiss: dismissSpy,
          onConfigureAi: () => {},
          resizeEdge: 'bottom' as const,
        }

        const longCteSql = Array.from({ length: 40 }, (_, i) => `  SELECT ${i + 1} AS c${i + 1}`).join('\nUNION ALL\n')
        renderSharedAiFixPanel(
          fixContainer,
          {
            phase: 'ready',
            aiEnabled: true,
            aiReady: true,
            result: {
              explanation: 'Fixed ambiguous column reference in multi-CTE query.',
              changesSummary: 'Qualified alias on cte_orders.id',
              fixedSql: `WITH cte_orders AS (\n${longCteSql}\n)\nSELECT * FROM cte_orders;`,
              durationMs: 280,
              model: 'gpt-4o-mini',
            },
          },
          fixCb
        )

        expect(fixContainer.dataset.phase).toBe('ready')
        const scrollWrap = fixContainer.querySelector('.datanoa-ai-panel-scroll') as HTMLElement | null
        const footer = fixContainer.querySelector('.datanoa-ai-fix-footer') as HTMLElement | null
        const bottomResizer = fixContainer.querySelector('.datanoa-ai-resizer.is-bottom') as HTMLElement | null
        expect(scrollWrap).toBeTruthy()
        expect(footer).toBeTruthy()
        expect(bottomResizer).toBeTruthy()

        // Footer is direct child of container, NOT inside scrollWrap, and sits before bottomResizer
        expect(footer?.parentElement).toBe(fixContainer)
        expect(scrollWrap?.contains(footer)).toBe(false)
        expect(scrollWrap?.nextElementSibling).toBe(footer)
        expect(footer?.nextElementSibling).toBe(bottomResizer)
        expect(fixContainer.lastElementChild).toBe(bottomResizer)

        // Content stays in scrollWrap while actions live in pinned footer
        expect(scrollWrap?.querySelector('.datanoa-ai-summary')?.textContent).toContain('ambiguous column')
        expect(scrollWrap?.querySelector('.datanoa-ai-fix-changes')?.textContent).toContain('cte_orders.id')
        expect(scrollWrap?.querySelector('pre.datanoa-ai-code')).toBeTruthy()

        const footerButtons = Array.from(footer?.querySelectorAll('button') ?? [])
        expect(footerButtons.map((b) => b.textContent)).toEqual(['Replace Query', 'Copy SQL', 'Dismiss'])
        footerButtons[0]?.click()
        footerButtons[1]?.click()
        footerButtons[2]?.click()
        expect(replaceSpy).toHaveBeenCalledTimes(1)
        expect(copySpy).toHaveBeenCalledTimes(1)
        expect(dismissSpy).toHaveBeenCalledTimes(1)

        // dataset.phase updates across loading/error and clears on hidden
        renderSharedAiFixPanel(fixContainer, { phase: 'loading', aiEnabled: true, aiReady: true }, fixCb)
        expect(fixContainer.dataset.phase).toBe('loading')
        renderSharedAiFixPanel(fixContainer, { phase: 'error', aiEnabled: true, aiReady: true, error: 'Err' }, fixCb)
        expect(fixContainer.dataset.phase).toBe('error')
        renderSharedAiFixPanel(fixContainer, { phase: 'hidden', aiEnabled: true, aiReady: true }, fixCb)
        expect(fixContainer.dataset.phase).toBeUndefined()

        // 3. renderSharedExplainAiPanel sets dataset.phase + dataset.collapsed and clears both on hidden
        const explainContainer = document.createElement('div')
        parent.appendChild(explainContainer)
        const explainCb = {
          onAnalyze: () => {},
          onConfigureAi: () => {},
          onCancel: () => {},
          onApplySql: () => {},
          onOpenNewTab: () => {},
          onCopyText: () => {},
          onToggleCollapsed: () => {},
          resizeEdge: 'top' as const,
        }
        renderSharedExplainAiPanel(
          explainContainer,
          { phase: 'idle', aiEnabled: true, aiReady: true, explainLanguage: 'en', collapsed: false },
          explainCb
        )
        expect(explainContainer.dataset.phase).toBe('idle')
        expect(explainContainer.dataset.collapsed).toBe('false')

        renderSharedExplainAiPanel(
          explainContainer,
          { phase: 'ready', aiEnabled: true, aiReady: true, explainLanguage: 'en', collapsed: true, result: sampleAnalysis },
          explainCb
        )
        expect(explainContainer.dataset.phase).toBe('ready')
        expect(explainContainer.dataset.collapsed).toBe('true')

        renderSharedExplainAiPanel(
          explainContainer,
          { phase: 'hidden', aiEnabled: true, aiReady: true, explainLanguage: 'en', collapsed: true },
          explainCb
        )
        expect(explainContainer.dataset.phase).toBeUndefined()
        expect(explainContainer.dataset.collapsed).toBeUndefined()

        // 4. getAiPanelMaxHeight clamps to parent rect when parentRect.height > 180 and falls back to window.innerHeight * 0.72 when <= 0
        // parent: top=100, bottom=500 (height=400); fixContainer: top=220, bottom=380 (height=160)
        // bottom edge: floor(500 - 220 - 8) = 272; top edge: floor(380 - 100 - 8) = 272
        expect(getAiPanelMaxHeight(fixContainer, 'bottom')).toBe(272)
        expect(getAiPanelMaxHeight(fixContainer, 'top')).toBe(272)

        // Tight parent clamps to >= AI_PANEL_MIN_HEIGHT (110)
        ;(parent as unknown as { _rect: Record<string, number> })._rect = {
          left: 0,
          top: 100,
          right: 900,
          bottom: 300,
          width: 900,
          height: 200,
        }
        ;(fixContainer as unknown as { _rect: Record<string, number> })._rect = {
          left: 0,
          top: 250,
          right: 900,
          bottom: 290,
          width: 900,
          height: 40,
        }
        expect(getAiPanelMaxHeight(fixContainer, 'bottom')).toBe(110)

        // Dragging inside a bounded parent respects parent max and keeps style.maxHeight = 'none'
        ;(parent as unknown as { _rect: Record<string, number> })._rect = {
          left: 0,
          top: 100,
          right: 900,
          bottom: 500,
          width: 900,
          height: 400,
        }
        ;(fixContainer as unknown as { _rect: Record<string, number> })._rect = {
          left: 0,
          top: 220,
          right: 900,
          bottom: 380,
          width: 900,
          height: 160,
        }
        renderSharedAiFixPanel(
          fixContainer,
          {
            phase: 'ready',
            aiEnabled: true,
            aiReady: true,
            result: {
              explanation: 'Fixed.',
              changesSummary: '',
              fixedSql: 'SELECT 1;',
              durationMs: 50,
              model: 'gpt-4o-mini',
            },
          },
          fixCb
        )
        const activeBottomResizer = fixContainer.querySelector('.datanoa-ai-resizer.is-bottom') as HTMLElement
        activeBottomResizer.dispatchEvent(new MouseEvent('mousedown', { clientY: 380, button: 0 }))
        window.dispatchEvent(new MouseEvent('mousemove', { clientY: 900 }))
        window.dispatchEvent(new MouseEvent('mouseup', { clientY: 900 }))
        expect(fixContainer.style.height).toBe('272px')
        expect(fixContainer.style.maxHeight).toBe('none')

        // Zero-height parent falls back cleanly to Math.max(280, Math.floor(1000 * 0.72)) = 720
        ;(parent as unknown as { _rect: Record<string, number> })._rect = {
          left: 0,
          top: 0,
          right: 0,
          bottom: 0,
          width: 0,
          height: 0,
        }
        expect(getAiPanelMaxHeight(fixContainer, 'bottom')).toBe(720)
        expect(getAiPanelMaxHeight(fixContainer, 'top')).toBe(720)
      } finally {
        Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: origInnerHeight })
      }
    })

    it('enforces AI Fix & Explain flex containment rules across Studio theme.ts and Side Panel panel.css', () => {
      const panelCss = fs.readFileSync(path.join(process.cwd(), 'src', 'panel', 'panel.css'), 'utf8')

      // Studio theme.ts (EDITOR_STYLE)
      const studioExplainBlock = EDITOR_STYLE.match(/\.datanoa-ai-explain-panel\s*\{[^}]*\}/)?.[0] ?? ''
      const studioFixBlock = EDITOR_STYLE.match(/\.datanoa-ai-fix-panel\s*\{[^}]*\}/)?.[0] ?? ''
      expect(studioExplainBlock).toContain('flex: 0 1 auto;')
      expect(studioExplainBlock).not.toContain('flex-shrink: 0;')
      expect(studioFixBlock).toContain('flex: 0 1 auto;')
      expect(studioFixBlock).not.toContain('flex-shrink: 0;')
      expect(EDITOR_STYLE).toMatch(/\.datanoa-ai-explain-panel\[hidden\]\s*\{\s*display:\s*none;\s*\}/)
      expect(EDITOR_STYLE).toMatch(
        /\.datanoa-ai-explain-panel\[data-phase='idle'\][\s\S]*?\.datanoa-ai-explain-panel\[data-phase='loading'\][\s\S]*?\.datanoa-ai-explain-panel\[data-collapsed='true'\][\s\S]*?\{[^}]*flex-shrink:\s*0;[^}]*min-height:\s*0;/
      )
      expect(EDITOR_STYLE).toMatch(
        /\.datanoa-ai-fix-panel\[data-phase='ready'\],\s*\.datanoa-ai-fix-panel\[data-phase='error'\]\s*\{[^}]*min-height:\s*min\(132px,\s*28vh\);/
      )
      expect(EDITOR_STYLE).toMatch(
        /\.datanoa-ai-fix-panel:not\(\[hidden\]\)\s*~\s*\.datanoa-grid-area\s*\{[^}]*flex-basis:\s*0;[^}]*min-height:\s*0;/
      )
      expect(EDITOR_STYLE).toMatch(
        /\.datanoa-ai-fix-footer\s*\{[^}]*flex-shrink:\s*0;[^}]*padding:\s*6px 12px;[^}]*border-top:\s*1px solid var\(--border\);[^}]*background:\s*var\(--surface\);/
      )

      // Side Panel panel.css
      const panelExplainBlock = panelCss.match(/\.datanoa-ai-explain-panel\s*\{[^}]*\}/)?.[0] ?? ''
      const panelFixBlock = panelCss.match(/\.datanoa-ai-fix-panel\s*\{[^}]*\}/)?.[0] ?? ''
      expect(panelExplainBlock).toContain('flex: 0 1 auto;')
      expect(panelExplainBlock).not.toContain('flex-shrink: 0;')
      expect(panelFixBlock).toContain('flex: 0 1 auto;')
      expect(panelFixBlock).not.toContain('flex-shrink: 0;')
      expect(panelCss).toMatch(
        /\.datanoa-ai-explain-panel\[data-phase='idle'\][\s\S]*?\.datanoa-ai-explain-panel\[data-phase='loading'\][\s\S]*?\.datanoa-ai-explain-panel\[data-collapsed='true'\][\s\S]*?\{[^}]*flex-shrink:\s*0;[^}]*min-height:\s*0;/
      )
      expect(panelCss).toMatch(
        /\.datanoa-ai-fix-panel\[data-phase='ready'\],\s*\.datanoa-ai-fix-panel\[data-phase='error'\]\s*\{[^}]*min-height:\s*min\(132px,\s*28vh\);/
      )
      expect(panelCss).toMatch(
        /#sqlAiFixPanel:not\(\[hidden\]\)\s*~\s*#sqlResultWrap\s*\{[^}]*min-height:\s*0;/
      )
      expect(panelCss).toMatch(
        /\.datanoa-ai-fix-footer\s*\{[^}]*flex-shrink:\s*0;[^}]*padding:\s*6px 8px;[^}]*border-top:\s*1px solid var\(--border\);[^}]*background:\s*var\(--surface\);/
      )
    })

    it('applies high-contrast Connect button tokens and readable .conn-sub across Dark and Light themes in Side Panel and Studio', () => {
      setupDom(true)
      const connectBtn = document.getElementById('newServerBtn') as HTMLButtonElement | null
      expect(connectBtn).toBeTruthy()
      expect(connectBtn?.classList.contains('btn')).toBe(true)
      expect(connectBtn?.classList.contains('btn-connect')).toBe(true)
      expect(connectBtn?.classList.contains('btn-sm')).toBe(true)

      const panelCss = fs.readFileSync(path.join(process.cwd(), 'src', 'panel', 'panel.css'), 'utf8')
      const panelDarkRoot = panelCss.match(/:root\s*\{[\s\S]*?\n\}/)?.[0] ?? ''
      const panelLightRoot = panelCss.match(/html\.light,\s*body\.light\s*\{[\s\S]*?\n\}/)?.[0] ?? ''
      expect(panelDarkRoot).toContain('--connect-fg: #38bdf8;')
      expect(panelDarkRoot).toContain('--connect-fg-hover: #7dd3fc;')
      expect(panelLightRoot).toContain('--connect-fg: #0369a1;')
      expect(panelLightRoot).toContain('--connect-fg-hover: #075985;')

      expect(panelCss).toMatch(
        /\.btn\.btn-connect\s*\{[^}]*color:\s*var\(--connect-fg\);[^}]*border-color:\s*color-mix\(in srgb,\s*var\(--connect-fg\) 40%,\s*var\(--border\)\);[^}]*background:\s*color-mix\(in srgb,\s*var\(--connect-fg\) 10%,\s*var\(--bg\)\);[^}]*font-weight:\s*600;/
      )
      expect(panelCss).toMatch(
        /\.btn\.btn-connect:hover:not\(:disabled\),\s*\.btn\.btn-connect\.btn-active\s*\{[^}]*color:\s*var\(--connect-fg-hover\);[^}]*border-color:\s*var\(--connect-fg\);[^}]*background:\s*color-mix\(in srgb,\s*var\(--connect-fg\) 18%,\s*var\(--bg\)\);/
      )
      const connSubBlock = panelCss.match(/\.conn-sub\s*\{[^}]*\}/)?.[0] ?? ''
      expect(connSubBlock).toContain('color: var(--t2);')
      expect(connSubBlock).not.toContain('color: var(--t3);')

      // Studio theme.ts dark & light Connect tokens + .datanoa-btn.datanoa-add-conn-btn
      const studioDarkRoot = EDITOR_STYLE.match(/:root\s*\{[\s\S]*?\n  \}/)?.[0] ?? ''
      const studioLightRoot = EDITOR_STYLE.match(/html\.light,\s*body\.light\s*\{[\s\S]*?\n  \}/)?.[0] ?? ''
      expect(studioDarkRoot).toContain('--connect-fg: #38bdf8;')
      expect(studioDarkRoot).toContain('--connect-fg-hover: #7dd3fc;')
      expect(studioLightRoot).toContain('--connect-fg: #0369a1;')
      expect(studioLightRoot).toContain('--connect-fg-hover: #075985;')
      expect(EDITOR_STYLE).toMatch(
        /\.datanoa-btn\.datanoa-add-conn-btn\s*\{[^}]*color:\s*var\(--connect-fg\);[^}]*border-color:\s*color-mix\(in srgb,\s*var\(--connect-fg\) 40%,\s*var\(--border\)\);[^}]*background:\s*color-mix\(in srgb,\s*var\(--connect-fg\) 10%,\s*var\(--bg\)\);[^}]*font-weight:\s*600;/
      )
      expect(EDITOR_STYLE).toMatch(
        /\.datanoa-btn\.datanoa-add-conn-btn:hover:not\(:disabled\)\s*\{[^}]*color:\s*var\(--connect-fg-hover\);[^}]*border-color:\s*var\(--connect-fg\);[^}]*background:\s*color-mix\(in srgb,\s*var\(--connect-fg\) 18%,\s*var\(--bg\)\);/
      )
    })
  })
})
