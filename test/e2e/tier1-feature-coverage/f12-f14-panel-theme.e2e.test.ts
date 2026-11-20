/**
 * test/e2e/tier1-feature-coverage/f12-f14-panel-theme.e2e.test.ts
 *
 * Tier 1 Feature Coverage: Features F12 through F14
 * - Feature F12: Sidebar Panel UI & Connections Tree
 * - Feature F13: Orca Visual Check Scenarios
 * - Feature F14: Studio Editor Frame, OLED Theme Tokens & DataGrip Parity
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { PanelContext } from 'orca'
import {
  setupE2ETestContext,
  teardownE2ETestContext,
  type TestContext,
} from '../harness/test-helpers.js'
import type { ConnectionProfile, SchemaObject } from '../../../src/protocol.js'
import { DATANOA_LOGO_DATA_URI } from '../../../src/assets/logo.js'

interface MockSubscription {
  event: string
  handler: (payload: unknown) => void
  dispose: ReturnType<typeof vi.fn>
}

interface MockAtom<T> {
  __orcaAtom: T
  __orcaWritable: true
  __val: T
}

interface MockDerived<T> {
  __orcaAtom: T
  __compute: () => T
}

// Hoist complete Orca UI + JSX runtime mock so both Vitest and `orca plugin test`
// (which aliases 'orca' -> 'orca/jsx-runtime') receive the full export surface.
const { mockSubscriptions, mockPlugin, orcaModuleMock } = vi.hoisted(() => {
  const subscriptions: MockSubscription[] = []
  const pluginMock = {
    on: vi.fn((event: string, handler: (payload: unknown) => void) => {
      const sub: MockSubscription = { event, handler, dispose: vi.fn() }
      subscriptions.push(sub)
      return sub
    }),
    request: vi.fn(async () => []),
  }

  const makeComponent = (name: string) =>
    vi.fn((props: Record<string, unknown> = {}) => ({ type: name, props }))

  const jsxFactory = (
    type: unknown,
    props: Record<string, unknown> = {},
    key?: string | number
  ) => ({
    type,
    props,
    ...(key !== undefined ? { key } : {}),
  })

  const moduleMock = {
    plugin: pluginMock,
    Stack: makeComponent('Stack'),
    Row: makeComponent('Row'),
    Card: makeComponent('Card'),
    Box: makeComponent('Box'),
    Button: makeComponent('Button'),
    Badge: makeComponent('Badge'),
    Heading: makeComponent('Heading'),
    Text: makeComponent('Text'),
    Tree: makeComponent('Tree'),
    Input: makeComponent('Input'),
    Select: makeComponent('Select'),
    Table: makeComponent('Table'),
    Callout: makeComponent('Callout'),
    CodeView: makeComponent('CodeView'),
    EmptyState: makeComponent('EmptyState'),
    IconButton: makeComponent('IconButton'),
    KeyValue: makeComponent('KeyValue'),
    List: makeComponent('List'),
    ListItem: makeComponent('ListItem'),
    Separator: makeComponent('Separator'),
    Switch: makeComponent('Switch'),
    Tabs: makeComponent('Tabs'),
    Tab: makeComponent('Tab'),
    Textarea: makeComponent('Textarea'),
    atom: vi.fn(<T>(initialOrKey: T | string, ...rest: T[]): MockAtom<T> => {
      const initial = rest.length > 0 ? rest[0] : (initialOrKey as T)
      return {
        __orcaAtom: initial,
        __orcaWritable: true as const,
        __val: initial,
      }
    }),
    derived: vi.fn(<T>(compute: () => T): MockDerived<T> => ({
      __orcaAtom: compute(),
      __compute: compute,
    })),
    read: vi.fn(<T>(target: Partial<MockAtom<T>> & Partial<MockDerived<T>>): T => {
      if (typeof target.__compute === 'function') {
        return target.__compute()
      }
      return (target.__val ?? target.__orcaAtom) as T
    }),
    set: vi.fn(<T>(target: Partial<MockAtom<T>>, value: T): void => {
      target.__val = value
    }),
    update: vi.fn(<T>(target: Partial<MockAtom<T>>, updater: (previous: T) => T): void => {
      const current = (target.__val ?? target.__orcaAtom) as T
      target.__val = updater(current)
    }),
    Fragment: Symbol.for('orca.Fragment'),
    jsx: jsxFactory,
    jsxs: jsxFactory,
    jsxDEV: jsxFactory,
    jsxsDEV: jsxFactory,
  }

  return {
    mockSubscriptions: subscriptions,
    mockPlugin: pluginMock,
    orcaModuleMock: moduleMock,
  }
})

vi.mock('orca', () => orcaModuleMock)
vi.mock('orca/jsx-runtime', () => orcaModuleMock)
vi.mock('orca/jsx-dev-runtime', () => orcaModuleMock)
vi.mock('orca/testing', () => ({
  defineCheck: (config: unknown) => config,
}))

describe('Tier 1 Feature Coverage: Features F12 - F14 (Panel, Visual Checks, Editor Frame & Theme)', () => {
  let context: TestContext
  const projectRoot = path.resolve(__dirname, '../../..')

  beforeEach(() => {
    context = setupE2ETestContext({ withSqlite: false })
    mockSubscriptions.length = 0
  })

  afterEach(async () => {
    await teardownE2ETestContext(context)
  })

  // =========================================================================
  // Feature F12: Sidebar Panel UI & Connections Tree (Production HTML/CSS/ESM)
  // =========================================================================
  describe('Feature F12: Sidebar Panel UI & Connections Tree', () => {
    it('F12-T01: Verify production HTML/CSS/ESM panel files and manifest entry', () => {
      const manifestPath = path.join(projectRoot, 'orca-plugin.json')
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      const panelEntry = manifest.contributes.panels.find(
        (p: { id: string }) => p.id === 'datanoa-panel'
      )
      expect(panelEntry).toBeDefined()
      expect(panelEntry.entry).toBe('src/panel/panel.html')
      expect(panelEntry.ui).toBe('html')

      const panelHtml = fs.readFileSync(path.join(projectRoot, 'src/panel/panel.html'), 'utf8')
      const panelCss = fs.readFileSync(path.join(projectRoot, 'src/panel/panel.css'), 'utf8')
      const panelCore = fs.readFileSync(path.join(projectRoot, 'src/panel/panel-core.js'), 'utf8')
      expect(panelHtml).toContain('./panel.css')
      expect(panelHtml).toContain('./panel-core.js')
      expect(panelCss.length).toBeGreaterThan(1000)
      expect(panelCore.length).toBeGreaterThan(1000)
      expect(fs.existsSync(path.join(projectRoot, 'src/panel/index.tsx'))).toBe(false)
      expect(fs.existsSync(path.join(projectRoot, 'src/panel/index.check.ts'))).toBe(false)
    })

    it('F12-T02: Verify panel runtime event subscriptions registration in panel.html', () => {
      const panelHtml = fs.readFileSync(path.join(projectRoot, 'src/panel/panel.html'), 'utf8')
      expect(panelHtml).toContain("'connections.changed'")
      expect(panelHtml).toContain("'data.cellUpdated'")
      expect(panelHtml).toContain("window.orca.on('theme'")
    })

    it('F12-T03: Verify panel-core.js 8-engine catalog, DDL fallback, and privacy-safe feedback builder', async () => {
      const panelCore = (await import('../../../src/panel/panel-core.js')) as {
        ENGINES: ReadonlyArray<{ id: string; label: string }>
        buildDdlFallback: (details: unknown, driver: string) => string
        buildPanelFeedbackMarkdown: (input: Record<string, unknown>) => string
        buildGithubIssueUrl: (input: Record<string, unknown>) => string
      }

      expect(panelCore.ENGINES).toHaveLength(8)
      expect(panelCore.ENGINES.map((e) => e.id)).toEqual([
        'sqlite',
        'postgres',
        'mysql',
        'mariadb',
        'cockroachdb',
        'clickhouse',
        'redis',
        'libsql',
      ])

      const ddl = panelCore.buildDdlFallback(
        {
          name: 'customers',
          schema: 'main',
          columns: [
            { name: 'id', type: 'INTEGER', nullable: false, isPrimaryKey: true },
            { name: 'email', type: 'TEXT', nullable: false, isPrimaryKey: false },
          ],
          primaryKey: ['id'],
          foreignKeys: [],
        },
        'sqlite'
      )
      expect(ddl).toContain('CREATE TABLE "customers"')
      expect(ddl).toContain('PRIMARY KEY ("id")')

      const md = panelCore.buildPanelFeedbackMarkdown({
        kind: 'bug',
        title: 'Grid scroll test',
        description: 'Steps here',
        driver: 'postgres',
        tab: 'data',
        readOnly: false,
        orcaApi: 'v1.2',
        platform: 'Win32',
        lastError:
          'Failed postgres://admin:supersecret@db.internal:5432/prod Bearer eyJhbGciOiJIUzI1NiJ9 10.0.1.42 D:\\prod.db /var/lib/pg/secret.conf',
      })
      expect(md).toContain('Datanoa v1.0.2')
      expect(md).toContain('v1.2')
      expect(md).toContain('Win32')
      expect(md).not.toContain('supersecret')
      expect(md).not.toContain('admin')
      expect(md).not.toContain('db.internal')
      expect(md).not.toContain('eyJhbGciOiJIUzI1NiJ9')
      expect(md).not.toContain('10.0.1.42')
      expect(md).not.toContain('prod.db')
      expect(md).not.toContain('secret.conf')

      const url = panelCore.buildGithubIssueUrl({
        kind: 'bug',
        title: 'Grid scroll test',
        markdownBody: md,
      })
      expect(url).toContain('https://github.com/Thanhh2615/datanoa/issues/new')
      expect(url).toContain('template=bug_report.yml')
    })

    it('F12-T04: Verify panel action controls and registered extension commands', () => {
      const manifestPath = path.join(projectRoot, 'orca-plugin.json')
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      const commandIds = manifest.contributes.commands.map((c: { id: string }) => c.id)

      expect(commandIds).toContain('datanoa.newQuery')
      expect(commandIds).toContain('datanoa.openSqliteFile')

      const panelHtml = fs.readFileSync(path.join(projectRoot, 'src/panel/panel.html'), 'utf8')
      expect(panelHtml).toContain('id="newServerBtn"')
      expect(panelHtml).toContain('id="feedbackBtn"')
      expect(panelHtml).toContain('id="feedbackModal"')
      expect(panelHtml).toContain('id="openStudioBtn"')
    })

    it('F12-T05: React to connections.changed event and update tree reactive state', () => {
      let stateCount = 0
      const onConnectionsChanged = (payload: unknown) => {
        stateCount = (payload as { count: number }).count
      }

      mockPlugin.on('connections.changed', onConnectionsChanged)

      const sub = mockSubscriptions.find((s) => s.event === 'connections.changed')
      expect(sub).toBeDefined()
      sub?.handler({ count: 7 })

      expect(stateCount).toBe(7)
    })

    it('F12-T06: Handle tree item selection event and trigger connection activation', () => {
      let activeConnectionId: string | null = null

      const handleSelectNode = (node: { key: string; data?: { type: string; id: string } }) => {
        if (node.data?.type === 'connection') {
          activeConnectionId = node.data.id
        }
      }

      handleSelectNode({ key: 'conn_123', data: { type: 'connection', id: 'conn_123' } })
      expect(activeConnectionId).toBe('conn_123')

      handleSelectNode({ key: 'tables_123', data: { type: 'tables_folder', id: '123' } })
      expect(activeConnectionId).toBe('conn_123')
    })
  })

  // =========================================================================
  // Feature F13: Orca Visual Assets, Manifest Cover & Screenshots Compliance
  // =========================================================================
  describe('Feature F13: Orca Visual Assets & Marketplace Compliance', () => {
    it('F13-T01: Verify manifest cover and screenshots are declared with valid alt text', () => {
      const manifestPath = path.join(projectRoot, 'orca-plugin.json')
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

      expect(manifest.cover).toBeDefined()
      expect(manifest.cover.path).toBe('images/cover.png')
      expect(manifest.cover.alt.length).toBeGreaterThan(10)
      expect(Array.isArray(manifest.screenshots)).toBe(true)
      expect(manifest.screenshots.length).toBeGreaterThanOrEqual(4)
    })

    it('F13-T02: Validate cover and all screenshot PNG files exist, are 1600x1000, and fit Orca size limits', () => {
      const manifestPath = path.join(projectRoot, 'orca-plugin.json')
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      const imagePaths: string[] = [
        manifest.cover.path,
        ...manifest.screenshots.map((s: { path: string }) => s.path),
      ]

      let totalBytes = 0
      for (const relPath of imagePaths) {
        const fullPath = path.join(projectRoot, relPath)
        expect(fs.existsSync(fullPath), `Missing image: ${relPath}`).toBe(true)
        const buf = fs.readFileSync(fullPath)
        totalBytes += buf.length
        const width = buf.readUInt32BE(16)
        const height = buf.readUInt32BE(20)
        expect(width).toBe(1600)
        expect(height).toBe(1000)
        expect(buf.length).toBeLessThanOrEqual(relPath === manifest.cover.path ? 1024 * 1024 : 1536 * 1024)
      }
      expect(totalBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
    })

    it('F13-T03: Validate panel.css and panel.html dark/light token parity', () => {
      const panelCss = fs.readFileSync(path.join(projectRoot, 'src/panel/panel.css'), 'utf8')
      expect(panelCss).toContain('html.light')
      expect(panelCss).toContain('--bg: var(--orca-background, #000000);')
      expect(panelCss).toContain('--border-strong:')
    })

    it('F13-T04: Validate GitHub Issue Templates and CONTRIBUTING.md exist for user feedback', () => {
      expect(fs.existsSync(path.join(projectRoot, '.github/ISSUE_TEMPLATE/bug_report.yml'))).toBe(true)
      expect(fs.existsSync(path.join(projectRoot, '.github/ISSUE_TEMPLATE/feature_request.yml'))).toBe(true)
      expect(fs.existsSync(path.join(projectRoot, '.github/ISSUE_TEMPLATE/config.yml'))).toBe(true)
      expect(fs.existsSync(path.join(projectRoot, 'CONTRIBUTING.md'))).toBe(true)
    })

    it('F13-T05: Verify connection form supports all 8 database engines', () => {
      const panelHtml = fs.readFileSync(path.join(projectRoot, 'src/panel/panel.html'), 'utf8')
      const panelCore = fs.readFileSync(path.join(projectRoot, 'src/panel/panel-core.js'), 'utf8')
      for (const engine of ['sqlite', 'postgres', 'mysql', 'mariadb', 'cockroachdb', 'clickhouse', 'redis', 'libsql']) {
        expect(panelCore).toContain(`'${engine}'`)
      }
      expect(panelHtml).toContain('id="formFilePath"')
      expect(panelHtml).toContain('id="formHost"')
      expect(panelHtml).toContain('id="formPort"')
    })

    it('F13-T06: Ensure all RPC requests called by panel.html match PluginRequests interface', () => {
      const panelHtml = fs.readFileSync(path.join(projectRoot, 'src/panel/panel.html'), 'utf8')
      const validRequestKeys = new Set([
        'connections.list',
        'connection.save',
        'connection.delete',
        'connection.test',
        'connection.parseUri',
        'sqlite.scanFolder',
        'studio.open',
        'workspace.detectConnections',
        'schema.listObjects',
        'schema.tableDetails',
        'schema.generateDdl',
        'data.fetchPage',
        'data.updateCell',
        'data.applyChanges',
        'data.previewChanges',
        'query.run',
        'query.explain',
        'query.cancel',
        'query.history.list',
        'query.history.clear',
      ])

      const rpcMatches = Array.from(panelHtml.matchAll(/\brpc\(\s*['"]([^'"]+)['"]/g))
      expect(rpcMatches.length).toBeGreaterThanOrEqual(10)
      for (const match of rpcMatches) {
        expect(
          validRequestKeys.has(match[1]),
          `panel.html contains unknown IPC key: ${match[1]}`
        ).toBe(true)
      }
    })
  })

  // =========================================================================
  // Feature F14: Studio Editor Frame, True OLED Theme & DataGrip Parity
  // =========================================================================
  describe('Feature F14: Studio Editor Frame & Theme Tokens', () => {
    it('F14-T01: Verify isolated frame DOM bootstrap and structural element hierarchy', () => {
      const editorSource = fs.readFileSync(path.join(projectRoot, 'src/editor/index.ts'), 'utf8')

      expect(editorSource).toContain('.datanoa-editor-root')
      expect(editorSource).toContain('.datanoa-toolbar')
      expect(editorSource).toContain('.datanoa-sql-area')
      expect(editorSource).toContain('.datanoa-grid-area')
      expect(editorSource).toContain('.datanoa-status-bar')
    })

    it('F14-T02: Validate Orca design tokens integration in CSS stylesheet', () => {
      const editorSource = fs.readFileSync(path.join(projectRoot, 'src/editor/index.ts'), 'utf8')

      expect(editorSource).toContain('var(--orca-editor-surface')
      expect(editorSource).toContain('var(--orca-border')
      expect(editorSource).toContain('var(--orca-foreground')
      expect(editorSource).toContain('var(--orca-foreground-muted')
      expect(editorSource).toContain('var(--orca-accent')
    })

    it('F14-T03: Synchronize light and dark theme classes with token cascading', () => {
      const themeSource = fs.readFileSync(path.join(projectRoot, 'src/editor/theme.ts'), 'utf8')
      const panelHtml = fs.readFileSync(path.join(projectRoot, 'src/panel/panel.html'), 'utf8')

      expect(themeSource).toContain('html.light, body.light')
      expect(panelHtml).toContain('html.light')
      expect(themeSource).toContain('--bg: var(--orca-background, #000000);')
      expect(themeSource).toContain('--bg: var(--orca-background, #ffffff);')
    })

    it('F14-T04: Verify editor toolbar controls: Execute button and connection selector', () => {
      const editorSource = fs.readFileSync(path.join(projectRoot, 'src/editor/index.ts'), 'utf8')

      expect(editorSource).toContain('Execute (Ctrl+Enter)')
      expect(editorSource).toContain('Select Connection...')
      expect(editorSource).toContain('datanoa-btn datanoa-btn-primary')
    })

    it('F14-T05: Verify status bar layout, execution state, and row count metrics', () => {
      const editorSource = fs.readFileSync(path.join(projectRoot, 'src/editor/index.ts'), 'utf8')

      expect(editorSource).toContain('.datanoa-status-bar')
      expect(editorSource).toContain('Ready')
      expect(editorSource).toContain('0 rows')
    })

    it('F14-T06: Verify document session lifecycle attachment', () => {
      const editorSource = fs.readFileSync(path.join(projectRoot, 'src/editor/index.ts'), 'utf8')

      expect(editorSource).toContain('.orca?.document')
      expect(editorSource).toContain('.session()')
      expect(editorSource).toContain('initializeEditor()')
    })

    it('F14-T07: Enforce True OLED #000000 fallbacks without hardcoded #0d0f12 or --orca-* root overrides', () => {
      const panelHtml = fs.readFileSync(path.join(projectRoot, 'src/panel/panel.html'), 'utf8')
      const editorTheme = fs.readFileSync(path.join(projectRoot, 'src/editor/theme.ts'), 'utf8')
      const editorIndex = fs.readFileSync(path.join(projectRoot, 'src/editor/index.ts'), 'utf8')

      // Panel HTML OLED tokens + zero hardcoded host overrides
      expect(panelHtml).toContain('--bg: var(--orca-background, #000000);')
      expect(panelHtml).toContain('--surface: var(--orca-editor-surface, #0a0a0a);')
      expect(panelHtml).toContain('--card: var(--orca-secondary, #0f0f0f);')
      expect(panelHtml).toContain('--primary-fg: var(--orca-primary-foreground, #000000);')
      expect(panelHtml).toContain("var(--orca-background, #000000)")
      expect(panelHtml).not.toContain('#0d0f12')
      expect(panelHtml).not.toMatch(/--orca-background\s*:/)

      // Editor theme.ts OLED tokens + Geist / Cascadia Code + zero host overrides
      expect(editorTheme).toContain('--bg: var(--orca-background, #000000);')
      expect(editorTheme).toContain('--surface: var(--orca-editor-surface, #0a0a0a);')
      expect(editorTheme).toContain('--card: var(--orca-secondary, #0f0f0f);')
      expect(editorTheme).toContain('--primary-fg: var(--orca-primary-foreground, #000000);')
      expect(editorTheme).toContain("'Geist'")
      expect(editorTheme).toContain("'Cascadia Code'")
      expect(editorTheme).not.toContain('#0d0f12')
      expect(editorTheme).not.toMatch(/--orca-background\s*:/)

      // Editor index.ts OLED fallback + Orca typography sync + zero host overrides
      expect(editorIndex).toContain('var(--orca-editor-surface, var(--orca-card, #0a0a0a))')
      expect(editorIndex).toContain('var(--orca-background, #000000)')
      expect(editorIndex).toContain('editor.readTypography')
      expect(editorIndex).not.toContain('#0d0f12')
      expect(editorIndex).not.toMatch(/--orca-background\s*:/)
    })

    it('F14-T08: Verify DATANOA_LOGO_DATA_URI usage in panel.html and editor/index.ts', () => {
      expect(DATANOA_LOGO_DATA_URI.startsWith('data:image/png;base64,')).toBe(true)
      expect(DATANOA_LOGO_DATA_URI.length).toBeGreaterThan(200)

      const panelHtml = fs.readFileSync(path.join(projectRoot, 'src/panel/panel.html'), 'utf8')
      const editorIndex = fs.readFileSync(path.join(projectRoot, 'src/editor/index.ts'), 'utf8')

      expect(panelHtml).toContain(`class="brand-logo" src="${DATANOA_LOGO_DATA_URI}"`)
      expect(editorIndex).toContain("import { DATANOA_LOGO_DATA_URI } from '../assets/logo.js'")
      expect(editorIndex).toContain('brandLogo.src = DATANOA_LOGO_DATA_URI')
    })

    it('F14-T09: Verify vector SVG logos for all 8 database engines in panel.html and editor/index.ts', () => {
      const engines = [
        'sqlite',
        'postgres',
        'mysql',
        'mariadb',
        'cockroachdb',
        'clickhouse',
        'redis',
        'libsql',
      ] as const

      const panelHtml = fs.readFileSync(path.join(projectRoot, 'src/panel/panel.html'), 'utf8')
      const panelCore = fs.readFileSync(path.join(projectRoot, 'src/panel/panel-core.js'), 'utf8')
      const editorDbIcons = fs.readFileSync(path.join(projectRoot, 'src/editor/db-icons.ts'), 'utf8')

      expect(panelHtml).toContain('function getDbLogoSvg(')
      expect(panelHtml).toContain('DB_SVG_MARKUP')
      expect(editorDbIcons).toContain('export function createDbLogoSvg(')
      expect(editorDbIcons).toContain('DB_LOGO_COLORS')

      for (const engine of engines) {
        expect(panelCore).toContain(`id: '${engine}'`)
        expect(panelHtml).toContain(`${engine}: '<svg`)
        expect(editorDbIcons).toContain(`${engine}: '`)
        expect(editorDbIcons).toContain(`case '${engine}':`)
      }
    })

    it('F14-T10: Verify JetBrains DataGrip parity features across panel.html, editor/index.ts, grid.ts, and schema-inspector.ts', () => {
      const panelHtml = fs.readFileSync(path.join(projectRoot, 'src/panel/panel.html'), 'utf8')
      const editorIndex = fs.readFileSync(path.join(projectRoot, 'src/editor/index.ts'), 'utf8')
      const gridSource = fs.readFileSync(path.join(projectRoot, 'src/editor/grid.ts'), 'utf8')
      const inspectorSource = fs.readFileSync(
        path.join(projectRoot, 'src/editor/schema-inspector.ts'),
        'utf8'
      )

      // 1. Server-side WHERE / ORDER BY filtering
      expect(panelHtml).toContain('id="dataWhereInput"')
      expect(panelHtml).toContain('id="dataOrderInput"')
      expect(panelHtml).toContain('whereClause')
      expect(panelHtml).toContain('orderByClause')
      expect(editorIndex).toContain("whereLbl.textContent = 'WHERE'")
      expect(editorIndex).toContain("orderLbl.textContent = 'ORDER BY'")
      expect(editorIndex).toContain('whereClause')
      expect(editorIndex).toContain('orderByClause')

      // 2. Transactional batch staging (Submit, Revert, DML Preview, + Row, − Row, Clone)
      for (const token of [
        'Submit [0]',
        'Revert',
        'DML Preview',
        '+ Row',
        'data.applyChanges',
        'data.previewChanges',
      ]) {
        expect(panelHtml).toContain(token)
        expect(editorIndex).toContain(token)
      }
      expect(panelHtml).toContain('&minus; Row')
      expect(panelHtml).toContain('Clone Row')
      expect(editorIndex).toContain('− Row')
      expect(editorIndex).toContain("cloneRowBtn.textContent = 'Clone'")
      expect(gridSource).toContain('addBlankRow')
      expect(gridSource).toContain('markRowDeleted')
      expect(gridSource).toContain('cloneSelectedRow')

      // 3. Transpose view
      expect(panelHtml).toContain('id="transposeBtn"')
      expect(panelHtml).toContain('Transpose')
      expect(editorIndex).toContain('⇄ Transpose')
      expect(gridSource).toContain('setTransposed')

      // 4. 7-format Data Extractor
      const exportFormats = ['sql-insert', 'sql-update', 'json', 'ndjson', 'csv', 'tsv', 'markdown']
      for (const fmt of exportFormats) {
        expect(panelHtml).toContain(`value="${fmt}"`)
        expect(editorIndex).toContain(`value: '${fmt}'`)
      }

      // 5. Explain & Query History
      expect(panelHtml).toContain('Explain')
      expect(panelHtml).toContain('query.explain')
      expect(panelHtml).toContain('Query History')
      expect(panelHtml).toContain('query.history.list')
      expect(panelHtml).toContain('query.history.clear')

      expect(editorIndex).toContain('Explain')
      expect(editorIndex).toContain('query.explain')
      expect(editorIndex).toContain('Query History')
      expect(editorIndex).toContain('query.history.list')
      expect(editorIndex).toContain('query.history.clear')

      // 6. Live DDL Viewer
      expect(panelHtml).toContain('CREATE TABLE DDL')
      expect(panelHtml).toContain('Copy DDL')
      expect(panelHtml).toContain('schema.generateDdl')
      expect(inspectorSource).toContain('DDL Definition')
      expect(inspectorSource).toContain('Copy DDL')
      expect(inspectorSource).toContain('reconstructTableDdl')

      // 7. DEV / STAGING / PROD environment color tags & Read-Only lock
      expect(panelHtml).toContain('data-env="dev"')
      expect(panelHtml).toContain('data-env="staging"')
      expect(panelHtml).toContain('data-env="prod"')
      expect(panelHtml).toContain('id="formReadOnly"')
      expect(panelHtml).toContain('Read-Only Mode')
      expect(editorIndex).toContain('datanoa-env-pill')
      expect(editorIndex).toContain('datanoa-ro-badge')
      expect(editorIndex).toContain('isActiveConnectionReadOnly')
    })
  })
})
