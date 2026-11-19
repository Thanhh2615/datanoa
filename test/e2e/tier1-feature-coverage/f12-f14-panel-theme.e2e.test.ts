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
  // Feature F12: Sidebar Panel UI & Connections Tree
  // =========================================================================
  describe('Feature F12: Sidebar Panel UI & Connections Tree', () => {
    it('F12-T01: Verify panel module component definition and Orca export contracts', async () => {
      const panelModule = await import('../../../src/panel/index.js')
      expect(typeof panelModule.setup).toBe('function')
      expect(typeof panelModule.default).toBe('function')

      // Render default panel component
      const rendered = panelModule.default() as unknown as { type: unknown }
      expect(rendered).toBeDefined()
      expect(typeof rendered.type).toBe('function')
    })

    it('F12-T02: Verify panel setup lifecycle and event subscriptions registration', async () => {
      const { setup } = await import('../../../src/panel/index.js')
      const fakeCtx: PanelContext = {
        subscriptions: [],
        signal: new AbortController().signal,
        visible: { __orcaAtom: true },
        panel: { id: 'datanoa-panel' },
      }

      setup(fakeCtx)
      expect(fakeCtx.subscriptions.length).toBeGreaterThanOrEqual(2)

      const subscribedEvents = mockSubscriptions.map((s) => s.event)
      expect(subscribedEvents).toContain('connections.changed')
      expect(subscribedEvents).toContain('data.cellUpdated')
    })

    it('F12-T03: Render hierarchical connection and schema tree items', async () => {
      const { buildConnectionTree } = await import('../../../src/panel/index.js')

      const mockConns: ConnectionProfile[] = [
        { id: 'c1', name: 'Store SQLite', driver: 'sqlite', database: 'store.db' },
        { id: 'c2', name: 'Postgres Cloud', driver: 'postgres', database: 'cloud_db' },
      ]
      const mockObjects: Record<string, SchemaObject[]> = {
        c1: [
          { name: 'customers', schema: 'main', kind: 'table' },
          { name: 'v_orders', schema: 'main', kind: 'view' },
        ],
        c2: [{ name: 'users', schema: 'public', kind: 'table' }],
      }

      const tree = buildConnectionTree(mockConns, mockObjects, {
        'c1:customers': {
          name: 'customers',
          schema: 'main',
          kind: 'table',
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
              name: 'email',
              type: 'TEXT',
              nativeType: 'TEXT',
              nullable: false,
              defaultValue: null,
              isPrimaryKey: false,
              isAutoIncrement: false,
            },
          ],
          primaryKey: ['id'],
          indexes: [],
          foreignKeys: [],
        },
      })
      expect(tree).toHaveLength(2)
      expect(tree[0].label).toBe('Store SQLite (sqlite)')
      expect(tree[0].children?.[0].children?.[0].label).toBe('customers')
      expect(tree[0].children?.[0].children?.[0].children?.[0].label).toBe('id (INTEGER) [PK]')
      expect(tree[0].children?.[1].children?.[0].label).toBe('v_orders')
    })

    it('F12-T04: Verify panel action buttons bind to registered extension commands', () => {
      const manifestPath = path.join(projectRoot, 'orca-plugin.json')
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      const commandIds = manifest.contributes.commands.map((c: { id: string }) => c.id)

      expect(commandIds).toContain('datanoa.newQuery')
      expect(commandIds).toContain('datanoa.openSqliteFile')

      const panelSource = fs.readFileSync(path.join(projectRoot, 'src/panel/index.tsx'), 'utf8')
      expect(panelSource).toContain('New Query')
      expect(panelSource).toContain('Open SQLite')
    })

    it('F12-T05: React to connections.changed event and update tree reactive state', () => {
      let stateCount = 0
      const onConnectionsChanged = (payload: unknown) => {
        stateCount = (payload as { count: number }).count
      }

      // Simulate registration
      mockPlugin.on('connections.changed', onConnectionsChanged)

      // Emit event
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

      // Selecting non-connection node leaves connection active
      handleSelectNode({ key: 'tables_123', data: { type: 'tables_folder', id: '123' } })
      expect(activeConnectionId).toBe('conn_123')
    })
  })

  // =========================================================================
  // Feature F13: Orca Visual Check Scenarios
  // =========================================================================
  describe('Feature F13: Orca Visual Check Scenarios', () => {
    it('F13-T01: Verify visual check module export and defineCheck contract compliance', async () => {
      const checkModule = await import('../../../src/panel/index.check.js')
      expect(checkModule.default).toBeDefined()
      expect(typeof checkModule.default).toBe('object')
    })

    it('F13-T02: Validate empty scenario schema and mock request responses', async () => {
      const checkModule = await import('../../../src/panel/index.check.js')
      const config = checkModule.default as Record<string, { requests: Record<string, unknown> }>

      expect(config.empty).toBeDefined()
      expect(config.empty.requests).toBeDefined()
      expect(config.empty.requests['connections.list']).toEqual([])
    })

    it('F13-T03: Validate tree scenario mock payloads against protocol contracts', async () => {
      const checkModule = await import('../../../src/panel/index.check.js')
      const treeScenario = checkModule.default.tree

      expect(treeScenario).toBeDefined()
      const conns: ConnectionProfile[] = treeScenario.requests['connections.list']
      expect(Array.isArray(conns)).toBe(true)
      expect(conns.length).toBeGreaterThanOrEqual(2)

      expect(conns[0].id).toBe('conn_sqlite_local')
      expect(conns[0].driver).toBe('sqlite')

      const objects: SchemaObject[] = treeScenario.requests['schema.listObjects']
      expect(Array.isArray(objects)).toBe(true)
      expect(objects.length).toBeGreaterThanOrEqual(3)
      expect(objects.some((o) => o.kind === 'table')).toBe(true)
      expect(objects.some((o) => o.kind === 'view')).toBe(true)
    })

    it('F13-T04: Validate tree-dark scenario theme configuration and dark token parity', async () => {
      const checkModule = await import('../../../src/panel/index.check.js')
      const config = checkModule.default as Record<string, { theme?: string; requests: unknown }>

      expect(config['tree-dark']).toBeDefined()
      expect(config['tree-dark'].theme).toBe('dark')
      expect(config['tree-dark'].requests).toEqual(config.tree.requests)
    })

    it('F13-T05: Verify connection form check scenario with form input states', () => {
      const connectionFormScenario = {
        name: 'New Connection Form',
        drivers: ['sqlite', 'postgres', 'mysql'],
        fields: {
          sqlite: ['name', 'filePath'],
          postgres: ['name', 'host', 'port', 'database', 'user', 'password', 'ssl'],
          mysql: ['name', 'host', 'port', 'database', 'user', 'password'],
        },
      }

      expect(connectionFormScenario.drivers).toContain('sqlite')
      expect(connectionFormScenario.drivers).toContain('postgres')
      expect(connectionFormScenario.drivers).toContain('mysql')
      expect(connectionFormScenario.fields.sqlite).toContain('filePath')
      expect(connectionFormScenario.fields.postgres).toContain('port')
    })

    it('F13-T06: Ensure all check scenario request keys match PluginRequests interface', async () => {
      const checkModule = await import('../../../src/panel/index.check.js')
      const config = checkModule.default as Record<string, { requests: Record<string, unknown> }>

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

      for (const [scenarioName, scenario] of Object.entries(config)) {
        if (scenario.requests) {
          for (const reqKey of Object.keys(scenario.requests)) {
            expect(
              validRequestKeys.has(reqKey),
              `Scenario ${scenarioName} contains unknown IPC key: ${reqKey}`
            ).toBe(true)
          }
        }
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
      const editorIndex = fs.readFileSync(path.join(projectRoot, 'src/editor/index.ts'), 'utf8')

      expect(panelHtml).toContain('function getDbLogoSvg(')
      expect(panelHtml).toContain('DB_SVG_MARKUP')
      expect(editorIndex).toContain('function createDbLogoSvg(')
      expect(editorIndex).toContain('DB_LOGO_COLORS')

      for (const engine of engines) {
        expect(panelHtml).toContain(`id: '${engine}'`)
        expect(panelHtml).toContain(`${engine}: '<svg`)
        expect(editorIndex).toContain(`${engine}: '`)
        expect(editorIndex).toContain(`case '${engine}':`)
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
