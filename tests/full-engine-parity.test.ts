import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorState } from '../vendor/codemirror.js'
import { analyzeDangerousSql } from '../src/shared-sql-safety.js'
import {
  buildCompletionExtension,
  buildLanguageExtension,
  computeSmartSqlCompletions,
  resolveSqlDialect,
} from '../src/editor/console'
import { createByodDriverLogoSvg, getStudioEngineMeta } from '../src/editor/db-icons'
import {
  readLocalStudioWarmCache,
  scrubSensitiveStringForLocalStorage,
  writeLocalStudioWarmCache,
} from '../src/editor/document-meta'
import * as sharedSqlCore from '../src/shared-sql-core.js'
import { DatanoaStudioEditor } from '../src/editor/index'
import { EDITOR_STYLE } from '../src/editor/theme'
import { buildPanelDbSvgMarkupMap } from '../src/shared-db-icons.js'
import { analyzeEditableSelectQuery } from '../src/editor/select-editability'
import {
  buildColumnHeaderPredicate,
  injectSqlColumnFilter,
} from '../src/editor/sql-column-filter'
import { bindSqlParameters, extractSqlParameters } from '../src/editor/sql-params'
import * as panelCore from '../src/panel/panel-core.js'
import {
  buildPanelCompletionExtension,
  buildPanelLanguageExtension,
} from '../src/panel/panel-cm.js'
import { shouldDisableEditStructureButton } from '../src/panel/panel-data-grid.js'
import {
  buildCountQueryForObject,
  createPanelExplorerController,
  generateSqlForTable,
  getExplorerObjectGroupLabel,
} from '../src/panel/panel-explorer.js'
import {
  findMongoStatementAtOffset,
  getPanelDangerFindingBadgeLabel,
  getPanelEditorPlaceholder,
  splitPanelTargetStatements,
} from '../src/panel/panel-sql.js'
import { computePanelSqlCompletions } from '../src/panel/panel-sql-tabs.js'
import { canEditDriverStructure, getPanelDriverColumnTypes } from '../src/panel/panel-structure.js'
import { buildImportCommandPreview, openStudioImportModal } from '../src/editor/import-modal'
import { SchemaInspectorView } from '../src/editor/schema-inspector'
import {
  buildDangerTableCommand,
  openStudioCreateTableModal,
  openStudioDangerTableModal,
} from '../src/editor/studio-modals'
import {
  buildSqlTemplateForObject,
  createSidebarContextMenu,
  getSidebarObjectGroupLabel,
} from '../src/editor/studio-sidebar'
import { detectWorkspaceEnvConnections } from '../src/worker/discovery'
import {
  buildExplainPlanForStatement,
  registerQueryAndTxHandlers,
} from '../src/worker/rpc-query-tx'
import {
  buildTunnelProxiedProfile,
  resolveSshTunnelTarget,
  SessionManager,
} from '../src/worker/session-manager'
import {
  openStudioDocumentInOrca,
  sanitizeConnectionProfile,
  scrubCredentialsInText,
} from '../src/worker/worker-utils'
import type { ConnectionProfile } from '../src/protocol'

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) {
      await fs.promises.rm(dir, { recursive: true, force: true })
    }
  }
})

function makeMongoProfile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id: 'conn-mongo',
    name: 'Mongo Primary',
    driver: 'mongodb',
    host: 'fallback-host',
    port: 27017,
    database: 'app',
    ...overrides,
  }
}

describe('Full 12-Engine Cross-Cutting Parity', () => {
  describe('Slice 1: Worker EXPLAIN, SSH tunnel, .env discovery & SQL/MQL safety', () => {
    it('builds SHOWPLAN_ALL EXPLAIN plans for MSSQL and rejects mutating EXPLAIN ANALYZE / multi-statement SHOWPLAN', () => {
      const plan = buildExplainPlanForStatement('SELECT * FROM [dbo].[Users];', 'mssql', true)
      expect(plan.explainSql).toBe(
        'SET SHOWPLAN_ALL ON;\nGO\nSELECT * FROM [dbo].[Users]\nGO\nSET SHOWPLAN_ALL OFF;'
      )

      const alreadyWrapped = buildExplainPlanForStatement(
        'SET SHOWPLAN_ALL ON;\nGO\nSELECT 1\nGO\nSET SHOWPLAN_ALL OFF;',
        'mssql',
        true
      )
      expect(alreadyWrapped.explainSql).toContain('SET SHOWPLAN_ALL ON')

      expect(() =>
        buildExplainPlanForStatement('EXPLAIN ANALYZE DELETE FROM [dbo].[Users]', 'mssql', false)
      ).toThrow(/EXPLAIN ANALYZE is not permitted/i)

      expect(() =>
        buildExplainPlanForStatement('SELECT 1;\nDELETE FROM [dbo].[Users];', 'mssql', true)
      ).toThrow(/Read-Only/i)

      expect(() =>
        buildExplainPlanForStatement('SELECT 1;\nSELECT 2;', 'mssql', true)
      ).toThrow(/Multi-statement SHOWPLAN/i)

      expect(() =>
        buildExplainPlanForStatement('SELECT 1;\nDELETE FROM [dbo].[Users];', 'mssql', false)
      ).toThrow(/Multi-statement SHOWPLAN/i)

      expect(() =>
        buildExplainPlanForStatement(
          'SELECT 1\nGO\nSET SHOWPLAN_ALL OFF\nGO\nSELECT 2',
          'mssql',
          true
        )
      ).toThrow(/Multi-statement SHOWPLAN/i)
    })

    it('builds EXPLAIN PLAN FOR plans for Oracle and blocks mutating EXPLAIN ANALYZE', () => {
      const plan = buildExplainPlanForStatement('SELECT * FROM "APP"."ORDERS";', 'oracle', true)
      expect(plan.explainSql).toBe('EXPLAIN PLAN FOR SELECT * FROM "APP"."ORDERS"')

      const existingPlan = buildExplainPlanForStatement(
        'EXPLAIN PLAN FOR SELECT * FROM DUAL',
        'oracle',
        true
      )
      expect(existingPlan.explainSql).toBe('EXPLAIN PLAN FOR SELECT * FROM DUAL')

      expect(() =>
        buildExplainPlanForStatement('EXPLAIN ANALYZE UPDATE "APP"."ORDERS" SET x = 1', 'oracle', false)
      ).toThrow(/EXPLAIN ANALYZE is not permitted/i)
    })

    it('rewrites MongoDB JSON & shell queries for EXPLAIN and enforces readOnly mutation rules', () => {
      const jsonFind = buildExplainPlanForStatement(
        '{"find":"users","filter":{"active":true}}',
        'mongodb',
        true
      )
      expect(JSON.parse(jsonFind.explainSql)).toEqual({
        explain: { find: 'users', filter: { active: true } },
      })

      const jsonAgg = buildExplainPlanForStatement(
        '{"aggregate":"orders","pipeline":[{"$match":{"total":{"$gt":10}}}]}',
        'mongodb',
        true
      )
      expect(JSON.parse(jsonAgg.explainSql)).toEqual({
        explain: { aggregate: 'orders', pipeline: [{ $match: { total: { $gt: 10 } } }] },
      })

      const shellFind = buildExplainPlanForStatement(
        'db.getCollection("users").find({ active: true }).limit(20);',
        'mongodb',
        true
      )
      expect(shellFind.explainSql).toBe(
        'db.getCollection("users").find({ active: true }).limit(20).explain("queryPlanner")'
      )

      const shellAgg = buildExplainPlanForStatement(
        'db.orders.aggregate([{ $match: { status: "paid" } }]).toArray();',
        'mongodb',
        true
      )
      expect(shellAgg.explainSql).toBe(
        'db.orders.aggregate([{ $match: { status: "paid" } }]).explain("queryPlanner")'
      )

      const shellAlreadyExplain = buildExplainPlanForStatement(
        'db.users.find({}).explain("queryPlanner")',
        'mongodb',
        true
      )
      expect(shellAlreadyExplain.explainSql).toBe('db.users.find({}).explain("queryPlanner")')

      expect(() =>
        buildExplainPlanForStatement('db.users.deleteMany({})', 'mongodb', true)
      ).toThrow(/read-only/i)

      expect(() =>
        buildExplainPlanForStatement(
          '{"aggregate":"orders","pipeline":[{"$out":"archive"}]}',
          'mongodb',
          true
        )
      ).toThrow(/read-only/i)

      expect(() =>
        buildExplainPlanForStatement(
          '{"explain":{"delete":"users","deletes":[{"q":{},"limit":0}]}}',
          'mongodb',
          true
        )
      ).toThrow(/read-only/i)
    })

    it('resolves SSH tunnel targets and rewrites tunnel-proxied URLs for MongoDB', () => {
      const profile = makeMongoProfile({
        url: 'mongodb://admin:secret@mongo.internal.lan/analytics?authSource=admin',
      })
      expect(resolveSshTunnelTarget(profile)).toEqual({
        targetHost: 'mongo.internal.lan',
        targetPort: 27017,
      })

      const customPortProfile = makeMongoProfile({
        url: 'mongodb://mongo.internal.lan:27018/analytics',
      })
      expect(resolveSshTunnelTarget(customPortProfile)).toEqual({
        targetHost: 'mongo.internal.lan',
        targetPort: 27018,
      })

      const proxied = buildTunnelProxiedProfile(profile, {
        localHost: '127.0.0.1',
        localPort: 54321,
      })
      expect(proxied.host).toBe('127.0.0.1')
      expect(proxied.port).toBe(54321)
      expect(proxied.url).toBe('mongodb://admin:secret@127.0.0.1:54321/analytics?authSource=admin')
    })

    it('auto-discovers MSSQL, Oracle, and MongoDB connection URIs from .env files', async () => {
      const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'datanoa-env-parity-'))
      tempDirs.push(tmpDir)
      await fs.promises.writeFile(
        path.join(tmpDir, '.env'),
        [
          'MSSQL_URL="mssql://sa:Pass123!@127.0.0.1:1433/master"',
          'SQLSERVER_URL="sqlserver://app:Pass123!@10.0.0.2:1433/billing"',
          'ORACLE_URL="oracle://scott:tiger@10.0.0.3:1521/ORCLPDB1"',
          'MONGODB_URL="mongodb://root:secret@127.0.0.1:27017/app?authSource=admin"',
          'MONGO_URI="mongodb+srv://atlas-user:atlas-pass@cluster0.example.mongodb.net/prod"',
        ].join('\n'),
        'utf8'
      )

      const found = await detectWorkspaceEnvConnections([tmpDir])
      const driversByKey = Object.fromEntries(found.map((item) => [item.envKey, item.driver]))
      expect(driversByKey).toEqual({
        MSSQL_URL: 'mssql',
        SQLSERVER_URL: 'mssql',
        ORACLE_URL: 'oracle',
        MONGODB_URL: 'mongodb',
        MONGO_URI: 'mongodb',
      })
    })

    it('treats [ident] brackets safely in MSSQL analyzeDangerousSql', () => {
      const safeDelete = analyzeDangerousSql(
        'DELETE FROM [dbo].[users] WHERE [WHERE] = 1;',
        'mssql'
      )
      expect(safeDelete).toEqual([])

      const unsafeBracketTable = analyzeDangerousSql('DELETE FROM [WHERE];', 'mssql')
      expect(unsafeBracketTable).toHaveLength(1)
      expect(unsafeBracketTable[0].kind).toBe('delete_without_where')
      expect(unsafeBracketTable[0].target).toBe('WHERE')

      const unsafeDelete = analyzeDangerousSql('DELETE FROM [users];', 'mssql')
      expect(unsafeDelete).toHaveLength(1)
      expect(unsafeDelete[0].kind).toBe('delete_without_where')
      expect(unsafeDelete[0].target).toBe('users')
    })

    it('detects dangerous MongoDB commands while ignoring comments, strings, and scoped filters', () => {
      expect(analyzeDangerousSql('db.users.drop()', 'mongodb').map((f) => f.kind)).toEqual(['drop'])
      expect(analyzeDangerousSql('db.dropDatabase()', 'mongodb').map((f) => f.kind)).toEqual([
        'drop',
      ])
      expect(analyzeDangerousSql('db.users.deleteMany({})', 'mongodb').map((f) => f.kind)).toEqual([
        'delete_without_where',
      ])
      expect(
        analyzeDangerousSql('db.getCollection("orders").deleteMany( { /* all */ } )', 'mongodb').map(
          (f) => f.kind
        )
      ).toEqual(['delete_without_where'])
      expect(
        analyzeDangerousSql(
          'db.users.updateMany({}, { $set: { archived: true } })',
          'mongodb'
        ).map((f) => f.kind)
      ).toEqual(['update_without_where'])
      expect(analyzeDangerousSql('{"drop": "logs"}', 'mongodb').map((f) => f.kind)).toEqual([
        'drop',
      ])
      expect(analyzeDangerousSql('{"dropDatabase": 1}', 'mongodb').map((f) => f.kind)).toEqual([
        'drop',
      ])

      // Safe commands, comments, and string literals must NOT trigger warnings
      expect(
        analyzeDangerousSql(
          [
            '// db.users.drop()',
            '/* db.dropDatabase(); db.users.deleteMany({}) */',
            'db.users.find({ note: "db.users.drop()" });',
            'db.users.deleteMany({ status: "archived" });',
            'db.users.updateMany({ active: false }, { $set: { flagged: true } });',
          ].join('\n'),
          'mongodb'
        )
      ).toEqual([])
    })
  })

  describe('Slice 2: Params, Column Filters, and Select Editability parity', () => {
    it('excludes MongoDB JSON/MQL from SQL parameter extraction while supporting Oracle :param and MSSQL [ident]/@param', () => {
      const mql = 'db.users.find({ "email:primary": "a@b.com", status: "active" })'
      expect(extractSqlParameters(mql, 'mongodb')).toEqual([])
      expect(bindSqlParameters(mql, { ':primary': { type: 'text', value: 'x' } }, 'mongodb')).toBe(
        mql
      )

      const oracleSql = 'SELECT * FROM "APP"."USERS" WHERE "ID" = :user_id AND "ROLE" = :role'
      expect(extractSqlParameters(oracleSql, 'oracle').map((p) => p.key)).toEqual([
        ':user_id',
        ':role',
      ])
      expect(
        bindSqlParameters(
          oracleSql,
          { ':user_id': { type: 'number', value: '42' }, ':role': { type: 'text', value: 'admin' } },
          'oracle'
        )
      ).toBe('SELECT * FROM "APP"."USERS" WHERE "ID" = 42 AND "ROLE" = \'admin\'')

      const mssqlSql = 'SELECT [col:one], [@ignored] FROM [dbo].[Users] WHERE [Status] = @status'
      expect(extractSqlParameters(mssqlSql, 'mssql').map((p) => p.key)).toEqual(['@status'])
      expect(
        bindSqlParameters(mssqlSql, { '@status': { type: 'text', value: 'open' } }, 'mssql')
      ).toBe("SELECT [col:one], [@ignored] FROM [dbo].[Users] WHERE [Status] = 'open'")
    })

    it('quotes MSSQL [ident] & Oracle "ident" filters cleanly and rejects MongoDB SQL filter injection', () => {
      expect(injectSqlColumnFilter('db.users.find({})', 'name', 'alice', 'contains', 'mongodb')).toEqual(
        { ok: false, reason: 'non_sql_dialect' }
      )

      const mssqlPredicate = buildColumnHeaderPredicate('User Name', 'alice', 'contains', 'mssql')
      expect(mssqlPredicate).toContain('[User Name]')
      expect(mssqlPredicate).toContain('LIKE')

      const mssqlFiltered = injectSqlColumnFilter(
        'SELECT [FROM], [User Name] FROM [dbo].[Users] ORDER BY [Id] OFFSET 0 ROWS FETCH NEXT 50 ROWS ONLY;',
        'User Name',
        'alice',
        'eq',
        'mssql'
      )
      expect(mssqlFiltered.ok).toBe(true)
      if (mssqlFiltered.ok) {
        expect(mssqlFiltered.sql).toBe(
          "SELECT [FROM], [User Name] FROM [dbo].[Users] WHERE [User Name] = 'alice' ORDER BY [Id] OFFSET 0 ROWS FETCH NEXT 50 ROWS ONLY;"
        )
      }

      const oraclePredicate = buildColumnHeaderPredicate('EMAIL', 'corp.com', 'contains', 'oracle')
      expect(oraclePredicate).toContain('"EMAIL"')
      expect(oraclePredicate).toContain('LIKE')

      const oracleFiltered = injectSqlColumnFilter(
        'SELECT "ID", "EMAIL" FROM "APP"."USERS" FETCH FIRST 25 ROWS ONLY',
        'EMAIL',
        'a@b.com',
        'eq',
        'oracle'
      )
      expect(oracleFiltered.ok).toBe(true)
      if (oracleFiltered.ok) {
        expect(oracleFiltered.sql).toBe(
          'SELECT "ID", "EMAIL" FROM "APP"."USERS" WHERE "EMAIL" = \'a@b.com\' FETCH FIRST 25 ROWS ONLY'
        )
      }
    })

    it('supports MSSQL [schema].[table] + TOP queries and Oracle quoted SELECT editability while blocking MongoDB', () => {
      const mongoEdit = analyzeEditableSelectQuery({
        sql: 'db.users.find({})',
        dialect: 'mongodb',
        isReadOnly: false,
        resultColumns: [{ name: '_id' }],
        schemaObjects: [],
        resolveTableDetails: () => undefined,
      })
      expect(mongoEdit.editable).toBe(false)

      const mssqlEdit = analyzeEditableSelectQuery({
        sql: 'SELECT TOP 100 * FROM [dbo].[Users] ORDER BY [Id]',
        dialect: 'mssql',
        isReadOnly: false,
        resultColumns: [{ name: 'Id' }, { name: 'FROM' }],
        schemaObjects: [{ name: 'Users', schema: 'dbo', kind: 'table' }],
        resolveTableDetails: (table, schema) =>
          table === 'Users' && schema === 'dbo'
            ? {
                name: 'Users',
                schema: 'dbo',
                kind: 'table',
                columns: [
                  { name: 'Id', type: 'INT', nullable: false, primaryKey: true },
                  { name: 'FROM', type: 'NVARCHAR(100)', nullable: true, primaryKey: false },
                ],
                primaryKey: ['Id'],
                foreignKeys: [],
                indexes: [],
              }
            : undefined,
      })
      expect(mssqlEdit.editable).toBe(true)
      expect(mssqlEdit.schema).toBe('dbo')
      expect(mssqlEdit.table).toBe('Users')

      const mssqlFromColEdit = analyzeEditableSelectQuery({
        sql: 'SELECT [Id], [FROM] FROM [dbo].[Users]',
        dialect: 'mssql',
        isReadOnly: false,
        resultColumns: [{ name: 'Id' }, { name: 'FROM' }],
        schemaObjects: [{ name: 'Users', schema: 'dbo', kind: 'table' }],
        resolveTableDetails: () => ({
          name: 'Users',
          schema: 'dbo',
          kind: 'table',
          columns: [
            { name: 'Id', type: 'INT', nullable: false, primaryKey: true },
            { name: 'FROM', type: 'NVARCHAR(100)', nullable: true, primaryKey: false },
          ],
          primaryKey: ['Id'],
          foreignKeys: [],
          indexes: [],
        }),
      })
      expect(mssqlFromColEdit.editable).toBe(true)

      const oracleEdit = analyzeEditableSelectQuery({
        sql: 'SELECT "ID", "NAME" FROM "APP"."CUSTOMERS" FETCH FIRST 50 ROWS ONLY',
        dialect: 'oracle',
        isReadOnly: false,
        resultColumns: [{ name: 'ID' }, { name: 'NAME' }],
        schemaObjects: [{ name: 'CUSTOMERS', schema: 'APP', kind: 'table' }],
        resolveTableDetails: () => ({
          name: 'CUSTOMERS',
          schema: 'APP',
          kind: 'table',
          columns: [
            { name: 'ID', type: 'NUMBER', nullable: false, primaryKey: true },
            { name: 'NAME', type: 'VARCHAR2(100)', nullable: true, primaryKey: false },
          ],
          primaryKey: ['ID'],
          foreignKeys: [],
          indexes: [],
        }),
      })
      expect(oracleEdit.editable).toBe(true)
      expect(oracleEdit.schema).toBe('APP')
      expect(oracleEdit.table).toBe('CUSTOMERS')
    })
  })

  describe('Slice 3: CodeMirror dialect highlighting & autocomplete parity', () => {
    it('provides dedicated language extensions for mssql, oracle, and mongodb in both Studio & Side Panel', () => {
      expect(resolveSqlDialect('mssql')).toBeTruthy()
      expect(resolveSqlDialect('oracle')).toBeTruthy()

      const studioMssql = buildLanguageExtension('mssql')
      const studioOracle = buildLanguageExtension('oracle')
      const studioMongo = buildLanguageExtension('mongodb')
      expect(studioMssql).toBeTruthy()
      expect(studioOracle).toBeTruthy()
      expect(studioMongo).toBeTruthy()
      expect((studioMongo as { language?: { name?: string } }).language?.name).toBe('mongodb')
      expect((studioMssql as { language?: { name?: string } }).language?.name).toBe('mssql')
      expect((studioOracle as { language?: { name?: string } }).language?.name).toBe('oracle')

      const panelMssql = buildPanelLanguageExtension('mssql')
      const panelOracle = buildPanelLanguageExtension('oracle')
      const panelMongo = buildPanelLanguageExtension('mongodb')
      expect(panelMongo.language?.name).toBe('mongodb')
      expect(panelMssql.language?.name).toBe('mssql')
      expect(panelOracle.language?.name).toBe('oracle')
    })

    it('offers MQL operators, methods, and collection completions for MongoDB in Studio & Side Panel', () => {
      const schema = {
        users: ['_id', 'email', 'role'],
        orders: ['_id', 'userId', 'total'],
      }

      const dbDot = computeSmartSqlCompletions('db.', 3, 'mongodb', schema)
      expect(dbDot).not.toBeNull()
      const dbLabels = dbDot?.options.map((o) => o.label) ?? []
      expect(dbLabels).toContain('getCollection')
      expect(dbLabels).toContain('users')
      expect(dbLabels).toContain('orders')

      const stage = computeSmartSqlCompletions('db.users.aggregate([{ $mat', 26, 'mongodb', schema)
      expect(stage).not.toBeNull()
      expect(stage?.options.map((o) => o.label)).toContain('$match')

      const panelStage = computePanelSqlCompletions('db.users.aggregate([{ $gro', 26, 'mongodb', schema)
      expect(panelStage).not.toBeNull()
      expect(panelStage?.options.map((o) => o.label)).toContain('$group')

      const panelObjId = computePanelSqlCompletions('db.users.find({ _id: Obj', 24, 'mongodb', schema)
      expect(panelObjId?.options.map((o) => o.label)).toContain('ObjectId()')
    })

    it('offers MSSQL & Oracle dialect keyword completions in Studio & Side Panel', () => {
      const schema = { Orders: ['Id', 'Total'] }
      const mssqlComp = computeSmartSqlCompletions('SELECT TOP', 10, 'mssql', schema)
      expect(mssqlComp?.options.some((o) => o.label.includes('TOP'))).toBe(true)

      const mssqlGetDate = computePanelSqlCompletions('SELECT GETD', 11, 'mssql', schema)
      expect(mssqlGetDate?.options.some((o) => o.label === 'GETDATE()')).toBe(true)

      const oracleNvl = computeSmartSqlCompletions('SELECT NVL', 10, 'oracle', schema)
      expect(oracleNvl?.options.some((o) => o.label === 'NVL()')).toBe(true)

      const oracleDual = computePanelSqlCompletions('SELECT SYSD FROM DUA', 20, 'oracle', schema)
      expect(oracleDual?.options.some((o) => o.label === 'DUAL')).toBe(true)
    })
  })

  describe('Slice 4: Studio UI 12-engine parity (Sidebar, Modals, Inspector, Import)', () => {
    function withFakeDom(fn: () => void): void {
      class FakeClassList {
        private set = new Set<string>()
        add(...names: string[]): void {
          names.forEach((n) => this.set.add(n))
        }
        remove(...names: string[]): void {
          names.forEach((n) => this.set.delete(n))
        }
        toggle(name: string, force?: boolean): boolean {
          if (force === true) {
            this.set.add(name)
            return true
          }
          if (force === false) {
            this.set.delete(name)
            return false
          }
          if (this.set.has(name)) {
            this.set.delete(name)
            return false
          }
          this.set.add(name)
          return true
        }
        contains(name: string): boolean {
          return this.set.has(name)
        }
        get value(): string {
          return Array.from(this.set).join(' ')
        }
      }

      class FakeEl {
        tagName: string
        children: FakeEl[] = []
        style: Record<string, string> = {}
        dataset: Record<string, string> = {}
        classList = new FakeClassList()
        attributes: Record<string, string> = {}
        listeners: Record<string, Array<(e?: unknown) => void>> = {}
        value = ''
        type = ''
        placeholder = ''
        title = ''
        disabled = false
        checked = false
        hidden = false
        selected = false
        tabIndex = 0
        scrollTop = 0
        private _text = ''
        private _html = ''

        constructor(tagName: string) {
          this.tagName = tagName.toUpperCase()
        }
        get className(): string {
          return this.classList.value
        }
        set className(v: string) {
          this.classList = new FakeClassList()
          v.split(/\s+/)
            .filter(Boolean)
            .forEach((n) => this.classList.add(n))
        }
        get textContent(): string {
          if (this.children.length > 0 && !this._text) {
            return this.children.map((c) => c.textContent).join(' ')
          }
          return this._text + this.children.map((c) => c.textContent).join(' ')
        }
        set textContent(v: string) {
          this._text = String(v ?? '')
          this.children = []
        }
        get innerHTML(): string {
          return this._html
        }
        set innerHTML(v: string) {
          this._html = String(v ?? '')
          if (!v) this.children = []
        }
        appendChild(child: FakeEl): FakeEl {
          this.children.push(child)
          return child
        }
        remove(): void {}
        focus(): void {}
        select(): void {}
        setAttribute(k: string, v: string): void {
          this.attributes[k] = v
        }
        addEventListener(type: string, cb: (e?: unknown) => void): void {
          ;(this.listeners[type] ||= []).push(cb)
        }
        getBoundingClientRect() {
          return { width: 160, height: 220, left: 0, top: 0, right: 160, bottom: 220 }
        }
        querySelectorAll(selector: string): FakeEl[] {
          const out: FakeEl[] = []
          const cls = selector.startsWith('.') ? selector.slice(1) : null
          const walk = (el: FakeEl): void => {
            for (const c of el.children) {
              if ((cls && c.classList.contains(cls)) || (!cls && c.tagName === selector.toUpperCase())) {
                out.push(c)
              }
              walk(c)
            }
          }
          walk(this)
          return out
        }
      }

      const prevDoc = (globalThis as Record<string, unknown>).document
      const prevWin = (globalThis as Record<string, unknown>).window
      const prevEl = (globalThis as Record<string, unknown>).HTMLElement
      const docBody = new FakeEl('body')
      ;(globalThis as Record<string, unknown>).HTMLElement = FakeEl
      ;(globalThis as Record<string, unknown>).document = {
        body: docBody,
        createElement: (tag: string) => new FakeEl(tag),
      }
      ;(globalThis as Record<string, unknown>).window = { innerWidth: 1280, innerHeight: 800 }
      try {
        fn()
      } finally {
        ;(globalThis as Record<string, unknown>).document = prevDoc
        ;(globalThis as Record<string, unknown>).window = prevWin
        ;(globalThis as Record<string, unknown>).HTMLElement = prevEl
      }
    }

    it('renders MongoDB Collections labels & MQL quick templates alongside MSSQL TOP / Oracle FETCH FIRST', () => {
      expect(getSidebarObjectGroupLabel('table', 'mongodb')).toBe('Collections')
      expect(getSidebarObjectGroupLabel('table', 'redis')).toBe('Keyspaces')
      expect(getSidebarObjectGroupLabel('table', 'mssql')).toBe('Tables')
      expect(getSidebarObjectGroupLabel('table', 'oracle')).toBe('Tables')

      const mongoSel = buildSqlTemplateForObject(
        { name: 'users', schema: 'app', kind: 'table' },
        'select',
        'mongodb',
        [{ name: '_id', type: 'ObjectId', nullable: false, primaryKey: true }],
        ['_id']
      )
      expect(mongoSel).toBe('db.getCollection("users").find({}).limit(100);')

      const mssqlSel = buildSqlTemplateForObject(
        { name: 'Users', schema: 'dbo', kind: 'table' },
        'select',
        'mssql',
        [{ name: 'Id', type: 'INT', nullable: false, primaryKey: true }],
        ['Id']
      )
      expect(mssqlSel).toBe('SELECT TOP 100 [Id]\nFROM [dbo].[Users];')

      const oracleSel = buildSqlTemplateForObject(
        { name: 'ORDERS', schema: 'APP', kind: 'table' },
        'select',
        'oracle',
        [{ name: 'ID', type: 'NUMBER', nullable: false, primaryKey: true }],
        ['ID']
      )
      expect(oracleSel).toBe('SELECT "ID"\nFROM "APP"."ORDERS"\nFETCH FIRST 100 ROWS ONLY;')

      withFakeDom(() => {
        const mongoMenu = createSidebarContextMenu({
          clientX: 10,
          clientY: 10,
          item: { name: 'users', schema: 'app', kind: 'table' },
          driver: 'mongodb',
          isReadOnly: false,
          activeViewMode: 'split',
          onSelectSidebarObject: () => {},
          onSelectReadOnlyObject: () => {},
          onSwitchMode: () => {},
          onCountRows: () => {},
          onGenerateSql: () => {},
          onOpenImportModal: () => {},
          onOpenDangerModal: () => {},
          onCopyObjectDdl: () => {},
          onOpenObjectDdlInConsole: () => {},
          onUpdateStatus: () => {},
          onCloseMenu: () => {},
        })
        const menuText = mongoMenu.textContent
        expect(menuText).toContain('Count Docs')
        expect(menuText).toContain('Import CSV / JSON...')
        expect(menuText).toContain('Truncate Collection...')
        expect(menuText).toContain('Drop Collection...')
        expect(menuText).not.toContain('Edit Table Structure')
      })
    })

    it('builds Mongo MQL danger commands and supports Collection/Table creation on mongodb, mssql, oracle', () => {
      expect(
        buildDangerTableCommand('truncate', { name: 'logs', schema: 'app', kind: 'table' }, 'mongodb')
      ).toBe('db.getCollection("logs").deleteMany({});')
      expect(
        buildDangerTableCommand('drop', { name: 'logs', schema: 'app', kind: 'table' }, 'mongodb')
      ).toBe('db.getCollection("logs").drop();')

      withFakeDom(() => {
        let mountedEl: { textContent: string } | null = null
        openStudioCreateTableModal({
          activeConnectionId: 'c1',
          activeConnection: {
            id: 'c1',
            name: 'Mongo',
            driver: 'mongodb',
            host: 'localhost',
            port: 27017,
            database: 'app',
          },
          requestPlugin: async () => ({ columns: [], rows: [], rowCount: 0, executionTimeMs: 0, truncated: false, isSelect: false }),
          mountModal: (el) => {
            mountedEl = el as unknown as { textContent: string }
          },
          closeModal: () => {},
          updateStatus: () => {},
          showQueryBanner: () => {},
          createElapsedTimer: () => () => {},
          onTableCreated: async () => {},
        })
        expect(mountedEl?.textContent).toContain('Create New Collection')
        expect(mountedEl?.textContent).toContain('db.createCollection(')

        let mssqlMounted: { textContent: string } | null = null
        openStudioCreateTableModal({
          activeConnectionId: 'c2',
          activeConnection: {
            id: 'c2',
            name: 'SQL Server',
            driver: 'mssql',
            host: 'localhost',
            port: 1433,
            database: 'master',
          },
          activeSchema: 'dbo',
          requestPlugin: async () => ({ columns: [], rows: [], rowCount: 0, executionTimeMs: 0, truncated: false, isSelect: false }),
          mountModal: (el) => {
            mssqlMounted = el as unknown as { textContent: string }
          },
          closeModal: () => {},
          updateStatus: () => {},
          showQueryBanner: () => {},
          createElapsedTimer: () => () => {},
          onTableCreated: async () => {},
        })
        expect(mssqlMounted?.textContent).toContain('CREATE TABLE [dbo].[new_table]')

        let mongoDangerMounted: { textContent: string } | null = null
        openStudioDangerTableModal(
          {
            activeConnectionId: 'c1',
            activeConnection: {
              id: 'c1',
              name: 'Mongo',
              driver: 'mongodb',
              host: 'localhost',
              port: 27017,
              database: 'app',
            },
            requestPlugin: async () => ({ columns: [], rows: [], rowCount: 0, executionTimeMs: 0, truncated: false, isSelect: false }),
            mountModal: (el) => {
              mongoDangerMounted = el as unknown as { textContent: string }
            },
            closeModal: () => {},
            updateStatus: () => {},
            showQueryBanner: () => {},
            createElapsedTimer: () => () => {},
            onDangerActionSucceeded: async () => {},
          },
          'drop',
          { name: 'events', schema: 'app', kind: 'table' }
        )
        expect(mongoDangerMounted?.textContent).toContain('Drop Collection "events"')
        expect(mongoDangerMounted?.textContent).toContain('db.getCollection("events").drop();')
      })
    })

    it('keeps SchemaInspector structure editing enabled for mssql & oracle, and read-only schema preview + drop for mongodb', () => {
      withFakeDom(() => {
        const container = document.createElement('div') as unknown as HTMLElement
        const inspector = new SchemaInspectorView(container, {
          dialect: 'mssql',
          readOnly: false,
          onApplyMigration: async () => {},
          onDropTable: () => {},
        })
        inspector.setDetails({
          name: 'Users',
          schema: 'dbo',
          kind: 'table',
          columns: [{ name: 'Id', type: 'INT', nullable: false, primaryKey: true }],
          primaryKey: ['Id'],
          foreignKeys: [],
          indexes: [],
        })
        expect(
          (container as unknown as { querySelectorAll: (s: string) => unknown[] }).querySelectorAll(
            '.datanoa-edit-table-name-input'
          ).length
        ).toBe(1)

        inspector.setDialect('oracle')
        expect(
          (container as unknown as { querySelectorAll: (s: string) => unknown[] }).querySelectorAll(
            '.datanoa-edit-table-name-input'
          ).length
        ).toBe(1)

        inspector.setDialect('mongodb')
        inspector.setDetails({
          name: 'users',
          schema: 'app',
          kind: 'table',
          columns: [{ name: '_id', type: 'ObjectId', nullable: false, primaryKey: true }],
          primaryKey: ['_id'],
          foreignKeys: [],
          indexes: [{ name: '_id_', columns: ['_id'], unique: true }],
        })
        expect(
          (container as unknown as { querySelectorAll: (s: string) => unknown[] }).querySelectorAll(
            '.datanoa-edit-table-name-input'
          ).length
        ).toBe(0)
        expect(container.textContent).toContain('schemaless')
        expect(container.textContent).toContain('Drop Collection')
      })
    })

    it('supports MongoDB MQL insertOne import preview and allows MSSQL/Oracle/MongoDB import modals', () => {
      expect(
        buildImportCommandPreview([{ name: 'Alice', age: 30 }], {
          driver: 'mongodb',
          table: 'users',
          maxStatements: 3,
        })
      ).toBe('db.getCollection("users").insertOne({"name":"Alice","age":30});')

      withFakeDom(() => {
        let mounted = 0
        for (const driver of ['mssql', 'oracle', 'mongodb'] as const) {
          openStudioImportModal({
            activeConnectionId: `c-${driver}`,
            activeConnection: {
              id: `c-${driver}`,
              name: driver,
              driver,
              host: 'localhost',
              port: 1433,
              database: 'app',
            },
            targetTable: 'users',
            targetColumns: [{ name: 'name', type: 'TEXT', nullable: true, primaryKey: false }],
            canStageInGrid: driver !== 'mongodb',
            requestPlugin: async () => ({ columns: [], rows: [], rowCount: 0, executionTimeMs: 0, truncated: false, isSelect: false }),
            mountModal: () => {
              mounted++
            },
            closeModal: () => {},
            updateStatus: () => {},
            showQueryBanner: () => {},
            createElapsedTimer: () => () => {},
            onStageRows: () => 0,
            onDirectImportComplete: async () => {},
          })
        }
        expect(mounted).toBe(3)
      })
    })
  })

  describe('Slice 5: Side Panel 12-engine parity (Explorer, Structure, Data Grid, SQL Console)', () => {
    it('supports MongoDB Collections, MQL templates/count queries, and MSSQL/Oracle templates in panel-explorer', () => {
      expect(getExplorerObjectGroupLabel('mongodb')).toBe('Collections')
      expect(getExplorerObjectGroupLabel('redis')).toBe('Keyspaces')
      expect(getExplorerObjectGroupLabel('mssql')).toBe('Tables')
      expect(getExplorerObjectGroupLabel('oracle')).toBe('Tables')

      expect(
        generateSqlForTable(
          'select',
          { driver: 'mongodb' },
          { name: 'users', schema: 'app', kind: 'table' },
          { columns: [{ name: '_id', type: 'ObjectId' }, { name: 'email', type: 'String' }] }
        )
      ).toBe('db.getCollection("users").find({}).limit(100);')

      expect(
        generateSqlForTable(
          'insert',
          { driver: 'mongodb' },
          { name: 'users', schema: 'app', kind: 'table' },
          { columns: [{ name: '_id', type: 'ObjectId' }, { name: 'email', type: 'String' }] }
        )
      ).toContain('.insertOne(')

      expect(
        generateSqlForTable(
          'select',
          { driver: 'mssql' },
          { name: 'Users', schema: 'dbo', kind: 'table' },
          { columns: [{ name: 'Id', type: 'INT' }] }
        )
      ).toBe('SELECT TOP 100 [Id]\nFROM [dbo].[Users];')

      expect(
        generateSqlForTable(
          'select',
          { driver: 'oracle' },
          { name: 'ORDERS', schema: 'APP', kind: 'table' },
          { columns: [{ name: 'ID', type: 'NUMBER' }] }
        )
      ).toBe('SELECT "ID"\nFROM "APP"."ORDERS"\nFETCH FIRST 100 ROWS ONLY;')

      expect(
        buildCountQueryForObject({ driver: 'mongodb' }, { name: 'users', schema: 'app', kind: 'table' })
      ).toBe('db.getCollection("users").countDocuments({});')
      expect(
        buildCountQueryForObject({ driver: 'mssql' }, { name: 'Users', schema: 'dbo', kind: 'table' })
      ).toBe('SELECT COUNT(*) AS row_count FROM [dbo].[Users];')
    })

    it('gates Structure editing for schemaless MongoDB while enabling MSSQL & Oracle editing + native column types', () => {
      expect(canEditDriverStructure({ kind: 'table' }, { driver: 'mssql', readOnly: false })).toBe(
        true
      )
      expect(canEditDriverStructure({ kind: 'table' }, { driver: 'oracle', readOnly: false })).toBe(
        true
      )
      expect(canEditDriverStructure({ kind: 'table' }, { driver: 'mongodb', readOnly: false })).toBe(
        false
      )
      expect(canEditDriverStructure({ kind: 'table' }, { driver: 'redis', readOnly: false })).toBe(
        false
      )

      const mssqlTypes = getPanelDriverColumnTypes('mssql')
      expect(mssqlTypes).toContain('NVARCHAR(255)')
      expect(mssqlTypes).toContain('UNIQUEIDENTIFIER')

      const oracleTypes = getPanelDriverColumnTypes('oracle')
      expect(oracleTypes).toContain('VARCHAR2(255)')
      expect(oracleTypes).toContain('NUMBER(10)')

      expect(
        shouldDisableEditStructureButton({
          busy: false,
          isView: false,
          activeTable: 'users',
          driver: 'mongodb',
        })
      ).toBe(true)
      expect(
        shouldDisableEditStructureButton({
          busy: false,
          isView: false,
          activeTable: 'Users',
          driver: 'mssql',
        })
      ).toBe(false)
      expect(
        shouldDisableEditStructureButton({
          busy: false,
          isView: false,
          activeTable: 'ORDERS',
          driver: 'oracle',
        })
      ).toBe(false)
    })

    it('provides MongoDB editor placeholders, MQL danger badges, and comment-safe MQL statement splitting in panel-sql', () => {
      expect(getPanelEditorPlaceholder('mongodb')).toContain('db.getCollection(')
      expect(getPanelEditorPlaceholder('redis')).toContain('SCAN')
      expect(getPanelEditorPlaceholder('mssql')).toContain('SELECT')

      expect(getPanelDangerFindingBadgeLabel('delete_without_where', 'mongodb')).toBe(
        'DELETE ALL DOCUMENTS'
      )
      expect(getPanelDangerFindingBadgeLabel('update_without_where', 'mongodb')).toBe(
        'UPDATE ALL DOCUMENTS'
      )
      expect(getPanelDangerFindingBadgeLabel('drop', 'mongodb')).toBe('DROP COLLECTION / DB')
      expect(getPanelDangerFindingBadgeLabel('delete_without_where', 'mssql')).toBe(
        'DELETE WITHOUT WHERE'
      )

      const stmts = splitPanelTargetStatements(
        '// ignore ; semicolon in comment\ndb.users.find({ note: "a;b" });\ndb.orders.find({});',
        'mongodb'
      )
      expect(stmts).toEqual(['db.users.find({ note: "a;b" })', 'db.orders.find({})'])
    })
  })

  describe('Slice 6: Review findings (#49, #50, #51, #53)', () => {
    function makeHandlerHarness(driver: ConnectionProfile['driver'], profileOverrides: Partial<ConnectionProfile> = {}) {
      const handlers = new Map<string, (input: unknown, ctx?: unknown) => Promise<unknown>>()
      const logs: string[] = []
      const executedQueries: string[] = []
      let txState = { supported: true, autoCommit: true, active: false, statementCount: 0 }
      let prevAutoCommit = true
      let queryRunErr: Error | null = null

      const fakeSession = {
        driverType: driver,
        isAlive: () => true,
        getTransactionState: () => ({ ...txState }),
        beginTransaction: async () => {
          prevAutoCommit = txState.autoCommit
          txState = { ...txState, active: true, autoCommit: false }
          return { ...txState }
        },
        commitTransaction: async () => {
          if (!txState.active) {
            throw Object.assign(new Error('No active transaction'), { code: 'NO_ACTIVE_TX' })
          }
          txState = { ...txState, active: false, autoCommit: prevAutoCommit, statementCount: 0 }
          return { ...txState }
        },
        rollbackTransaction: async () => {
          if (!txState.active) {
            throw Object.assign(new Error('No active transaction'), { code: 'NO_ACTIVE_TX' })
          }
          txState = { ...txState, active: false, autoCommit: prevAutoCommit, statementCount: 0 }
          return { ...txState }
        },
        setAutoCommit: async (enabled: boolean) => {
          prevAutoCommit = enabled
          txState = { ...txState, autoCommit: enabled }
          return { ...txState }
        },
        runQuery: async (_queryId: string, sql: string) => {
          executedQueries.push(sql)
          if (queryRunErr) throw queryRunErr
          if (sql.includes('DBMS_XPLAN.DISPLAY')) {
            return {
              columns: [{ name: 'PLAN_TABLE_OUTPUT', type: 'VARCHAR2' }],
              rows: [['| Id | Operation | Name |'], ['| 0 | SELECT STATEMENT | |']],
              rowCount: 2,
              executionTimeMs: 4,
              truncated: false,
              isSelect: true,
            }
          }
          return {
            columns: [],
            rows: [],
            rowCount: 0,
            executionTimeMs: 3,
            truncated: false,
            isSelect: false,
          }
        },
        close: async () => {
          throw new Error('Failed closing postgres://admin:TopSecret123@db.internal:5432/prod')
        },
      }

      const profile: ConnectionProfile = {
        id: 'c_test',
        name: 'Test Conn',
        driver,
        host: 'db.internal',
        port: driver === 'oracle' ? 1521 : 5432,
        database: 'app',
        ...profileOverrides,
      }

      const orca = {
        storage: {
          get: async () => [],
          set: async () => {
            throw new Error('persist failed postgres://u:SecretPass99@host/db')
          },
        },
        settings: { get: async () => 500 },
        log: (msg: string) => logs.push(msg),
      }

      registerQueryAndTxHandlers({
        orca: orca as never,
        registerHandler: ((name: string, fn: (input: unknown, ctx?: unknown) => Promise<unknown>) => {
          handlers.set(name, fn)
        }) as never,
        sessionManager: {
          findProfile: async () => profile,
          getSession: async () => fakeSession,
        } as never,
        tracker: {
          activeQuerySessions: new Map(),
          consumePreCancelledQuery: () => false,
          trackQuery: () => {},
          untrackQuery: () => {},
        } as never,
      })

      return {
        handlers,
        logs,
        executedQueries,
        fakeSession,
        setQueryError: (err: Error | null) => {
          queryRunErr = err
        },
      }
    }

    it('#49 Bugs 1 & 3: scrubs thrown errors and worker/session-manager logs for credentials', async () => {
      const h = makeHandlerHarness('postgres')
      h.setQueryError(
        Object.assign(
          new Error('Connect failed: postgres://admin:MegaSecret123@pg.internal:5432/prod?token=SecretTok'),
          { code: 'ECONNREFUSED' }
        )
      )

      let caughtRunErr: unknown
      try {
        await h.handlers.get('query.run')?.(
          { connectionId: 'c_test', sql: 'SELECT 1;' },
          { panel: { id: 'p1' } }
        )
      } catch (err) {
        caughtRunErr = err
      }
      expect(caughtRunErr).toBeInstanceOf(Error)
      expect((caughtRunErr as Error).message).not.toContain('MegaSecret123')
      expect((caughtRunErr as Error).message).not.toContain('SecretTok')
      expect((caughtRunErr as { code?: string }).code).toBe('ECONNREFUSED')

      let caughtExplainErr: unknown
      try {
        await h.handlers.get('query.explain')?.(
          { connectionId: 'c_test', sql: 'SELECT 1;' },
          { panel: { id: 'p1' } }
        )
      } catch (err) {
        caughtExplainErr = err
      }
      expect(caughtExplainErr).toBeInstanceOf(Error)
      expect((caughtExplainErr as Error).message).not.toContain('MegaSecret123')
      expect((caughtExplainErr as Error).message).not.toContain('SecretTok')

      // Trigger history persistence error log and SessionManager closeSession error log
      h.setQueryError(null)
      await h.handlers.get('query.run')?.(
        { connectionId: 'c_test', sql: 'SELECT 1;' },
        { panel: { id: 'p1' } }
      )
      await new Promise((r) => setTimeout(r, 15))
      expect(h.logs.some((l) => l.includes('SecretPass99'))).toBe(false)

      const smLogs: string[] = []
      const sm = new SessionManager({
        storage: { get: async () => [], set: async () => {} },
        secrets: { get: async () => null, set: async () => {}, delete: async () => {} },
        log: (msg: string) => smLogs.push(msg),
      })
      ;(sm as unknown as { activeSessions: Map<string, unknown> }).activeSessions.set('c1', {
        close: async () => {
          throw new Error('Close err Server=db;Password=PlainMssqlPwd!;')
        },
      })
      await sm.closeSession('c1')
      expect(smLogs.length).toBeGreaterThan(0)
      expect(smLogs.join('\n')).not.toContain('PlainMssqlPwd!')
    })

    it('#51 Bug 4: tx.rollback(onlyIfOwner) resets autoCommit and frees tx ownership on switch & commit/rollback', async () => {
      const h = makeHandlerHarness('postgres')
      const setAutoCommit = h.handlers.get('tx.setAutoCommit')!
      const rollback = h.handlers.get('tx.rollback')!
      const begin = h.handlers.get('tx.begin')!
      const commit = h.handlers.get('tx.commit')!

      // Panel 1 disables autoCommit (active=false, autoCommit=false), then switches connections
      const s1 = (await setAutoCommit(
        { connectionId: 'c_test', enabled: false },
        { panel: { id: 'panel_1' } }
      )) as {
        txToken?: number
      }
      const rbSwitch = (await rollback(
        { connectionId: 'c_test', onlyIfOwner: true, txToken: s1.txToken },
        { panel: { id: 'panel_1' } }
      )) as { autoCommit: boolean; active: boolean }
      expect(rbSwitch.autoCommit).toBe(true)
      expect(rbSwitch.active).toBe(false)

      // Panel 2 must NOT be blocked by Panel 1's released ownership
      const s2 = (await begin({ connectionId: 'c_test' }, { panel: { id: 'panel_2' } })) as {
        active: boolean
      }
      expect(s2.active).toBe(true)

      // After Panel 2 commits, Panel 1 can acquire TX ownership without forbidden
      await commit({ connectionId: 'c_test' }, { panel: { id: 'panel_2' } })
      const s3 = (await begin({ connectionId: 'c_test' }, { panel: { id: 'panel_1' } })) as {
        active: boolean
      }
      expect(s3.active).toBe(true)

      // After Panel 1 rolls back in autoCommit=true mode, ownership is released
      await rollback({ connectionId: 'c_test' }, { panel: { id: 'panel_1' } })
      const s4 = (await begin({ connectionId: 'c_test' }, { panel: { id: 'panel_2' } })) as {
        active: boolean
      }
      expect(s4.active).toBe(true)
    })

    it('#50 Bug 13: resolves SSH targets and rewrites tunnel-proxied URLs for MSSQL & Oracle', () => {
      const mssqlUrlProfile: ConnectionProfile = {
        id: 'm1',
        name: 'MSSQL URL',
        driver: 'mssql',
        host: 'localhost',
        port: 1433,
        database: 'master',
        url: 'mssql://sa:Pass@mssql.bastion.internal/master',
      }
      expect(resolveSshTunnelTarget(mssqlUrlProfile)).toEqual({
        targetHost: 'mssql.bastion.internal',
        targetPort: 1433,
      })
      const proxiedMssql = buildTunnelProxiedProfile(mssqlUrlProfile, {
        localHost: '127.0.0.1',
        localPort: 60123,
      })
      expect(proxiedMssql.url).toBe('mssql://sa:Pass@127.0.0.1:60123/master')

      const adoProfile: ConnectionProfile = {
        id: 'm2',
        name: 'MSSQL ADO',
        driver: 'mssql',
        host: 'localhost',
        port: 1433,
        database: 'billing',
        url: 'Server=ado-sql.internal,14330;Database=billing;Encrypt=true;',
      }
      expect(resolveSshTunnelTarget(adoProfile)).toEqual({
        targetHost: 'ado-sql.internal',
        targetPort: 14330,
      })
      const proxiedAdo = buildTunnelProxiedProfile(adoProfile, {
        localHost: '127.0.0.1',
        localPort: 60124,
      })
      expect(proxiedAdo.url).toContain('Server=127.0.0.1,60124')

      const oracleUrlProfile: ConnectionProfile = {
        id: 'o1',
        name: 'Oracle URL',
        driver: 'oracle',
        host: 'localhost',
        port: 1521,
        database: 'FREEPDB1',
        url: 'oracle://app:pw@ora.bastion.internal/FREEPDB1',
      }
      expect(resolveSshTunnelTarget(oracleUrlProfile)).toEqual({
        targetHost: 'ora.bastion.internal',
        targetPort: 1521,
      })
      const proxiedOracle = buildTunnelProxiedProfile(oracleUrlProfile, {
        localHost: '127.0.0.1',
        localPort: 60125,
      })
      expect(proxiedOracle.url).toBe('oracle://app:pw@127.0.0.1:60125/FREEPDB1')
    })

    it('#53 Bug 1: Oracle query.explain executes EXPLAIN PLAN FOR followed by DBMS_XPLAN.DISPLAY()', async () => {
      const h = makeHandlerHarness('oracle')
      const res = (await h.handlers.get('query.explain')?.(
        { connectionId: 'c_test', sql: 'SELECT * FROM "APP"."ORDERS"' },
        { panel: { id: 'p1' } }
      )) as { columns: Array<{ name: string }>; rows: unknown[][]; rowCount: number }

      expect(h.executedQueries).toEqual([
        'EXPLAIN PLAN FOR SELECT * FROM "APP"."ORDERS"',
        'SELECT PLAN_TABLE_OUTPUT FROM TABLE(DBMS_XPLAN.DISPLAY())',
      ])
      expect(res.columns[0].name).toBe('PLAN_TABLE_OUTPUT')
      expect(res.rowCount).toBe(2)
    })

    it('#53 Bug 4: wires active CM6 autocompletion override providers for StreamLanguage dialects (mssql, oracle, mongodb)', async () => {
      type CompletionSourceFn = (ctx: {
        state: { doc: { toString: () => string } }
        pos: number
        explicit?: boolean
      }) => { from: number; options: Array<{ label: string }> } | null

      for (const dialect of ['mssql', 'oracle', 'mongodb'] as const) {
        const doc = dialect === 'mongodb' ? 'db.' : 'SELECT '
        const studioState = EditorState.create({
          doc,
          selection: { anchor: doc.length },
          extensions: [
            buildLanguageExtension(dialect),
            buildCompletionExtension(dialect, { users: ['id', 'name'] }),
          ],
        })
        const studioSources = studioState.languageDataAt<CompletionSourceFn>(
          'autocomplete',
          doc.length
        )
        expect(studioSources.length).toBeGreaterThan(0)
        const studioRes = studioSources[0]({ state: studioState, pos: doc.length, explicit: true })
        expect(studioRes?.options.length).toBeGreaterThan(0)
        if (dialect === 'mongodb') {
          expect(studioRes?.options.some((o) => o.label === 'getCollection')).toBe(true)
        }

        const panelState = EditorState.create({
          doc,
          selection: { anchor: doc.length },
          extensions: [
            buildPanelLanguageExtension(dialect),
            buildPanelCompletionExtension(dialect, { users: ['id', 'name'] }),
          ],
        })
        const panelSources = panelState.languageDataAt<CompletionSourceFn>(
          'autocomplete',
          doc.length
        )
        expect(panelSources.length).toBeGreaterThan(0)
        const panelRes = panelSources[0]({ state: panelState, pos: doc.length, explicit: true })
        expect(panelRes?.options.length).toBeGreaterThan(0)
      }
    })

    it('#53 Bug 8 & Bug 9: panel-explorer Mongo collection actions & panel-sql MongoDB caret offset statement selection', () => {
      const script =
        '// comment\ndb.users.find({ name: "a;b" });\ndb.orders.find({});\ndb.logs.find({});'
      expect(findMongoStatementAtOffset(script, 14)).toBe('db.users.find({ name: "a;b" })')
      expect(findMongoStatementAtOffset(script, 48)).toBe('db.orders.find({})')
      expect(findMongoStatementAtOffset(script, script.length)).toBe('db.logs.find({})')

      // Verify panel-explorer context menu wires Mongo collection creation & danger actions
      const created: string[] = []
      const dangled: Array<{ action: string; name: string }> = []
      const fakeMenuChildren: Array<{ textContent: string; onClick?: (e?: unknown) => void }> = []
      const prevDoc = (globalThis as Record<string, unknown>).document
      const fakeMenu = {
        hidden: true,
        style: {},
        textContent: '',
        appendChild: (el: { textContent: string; _click?: (e?: unknown) => void }) => {
          fakeMenuChildren.push({ textContent: el.textContent, onClick: el._click })
        },
        getBoundingClientRect: () => ({ width: 200, height: 260, left: 0, top: 0 }),
      }
      ;(globalThis as Record<string, unknown>).document = {
        getElementById: (id: string) => (id === 'contextMenu' ? fakeMenu : null),
        createElement: () => {
          const node: Record<string, unknown> = {
            className: '',
            textContent: '',
            disabled: false,
            style: {},
            setAttribute: () => {},
            appendChild: () => {},
            addEventListener: (_ev: string, cb: (e?: unknown) => void) => {
              node._click = cb
            },
          }
          return node
        },
      }
      ;(globalThis as Record<string, unknown>).window = { innerWidth: 1200, innerHeight: 800 }
      try {
        const ctrl = createPanelExplorerController({
          state: { connections: [], objects: [], tableDetails: {} },
          QUERY_TIMEOUT_MS: 5000,
          getActiveConn: () => null,
          getConnById: () => null,
          openContextMenu: () => {},
          activateConnection: () => {},
          loadSchema: async () => {},
          selectTableAndOpen: async () => {},
          switchTab: () => {},
          setSqlText: () => {},
          renderSqlSafetyBanner: () => {},
          resetSqlSafetyBannerDismissal: () => {},
          renderConnectionsBar: () => {},
          persistActiveConnectionId: async () => {},
          openFullStudio: () => {},
          openCreateTableModal: () => {
            created.push('open')
          },
          openDangerTableModal: (action: string, _conn: unknown, obj: { name: string }) => {
            dangled.push({ action, name: obj.name })
          },
          showBanner: () => {},
          copyText: async () => {},
          rpc: async () => ({}),
          populateFormFromProfile: () => {},
          openDeleteConfirmModal: () => {},
          savePanelViewState: () => {},
        })
        const mongoConn = { id: 'mc1', name: 'Mongo', driver: 'mongodb', readOnly: false }
        ctrl.openContextMenu(10, 10, {
          type: 'object',
          conn: mongoConn,
          obj: { name: 'events', schema: 'app', kind: 'table' },
        })
        const truncBtn = fakeMenuChildren.find((c) => c.textContent === 'Truncate Collection...')
        const dropBtn = fakeMenuChildren.find((c) => c.textContent === 'Drop Collection...')
        expect(truncBtn).toBeTruthy()
        expect(dropBtn).toBeTruthy()
        truncBtn?.onClick?.({ stopPropagation: () => {} })
        dropBtn?.onClick?.({ stopPropagation: () => {} })
        expect(dangled).toEqual([
          { action: 'truncate', name: 'events' },
          { action: 'drop', name: 'events' },
        ])

        fakeMenuChildren.length = 0
        ctrl.openContextMenu(10, 10, { type: 'conn', conn: mongoConn })
        const newColBtn = fakeMenuChildren.find((c) => c.textContent === '+ New Collection...')
        expect(newColBtn).toBeTruthy()
        newColBtn?.onClick?.({ stopPropagation: () => {} })
        expect(created).toEqual(['open'])
      } finally {
        ;(globalThis as Record<string, unknown>).document = prevDoc
      }
    })

    it('#53 Bug 10: blocks D1 table rebuild while a manual transaction is active in SchemaInspectorView', () => {
      const container = {
        innerHTML: '',
        appendChild: () => {},
        addEventListener: () => {},
      } as unknown as HTMLElement
      const view = new SchemaInspectorView(container, {
        dialect: 'd1',
        readOnly: false,
        isManualTxActive: () => true,
      })
      const draft = {
        tableName: 'items',
        originalTableName: 'items',
        columns: [
          {
            id: 'c1',
            status: 'existing' as const,
            originalName: 'id',
            name: 'id',
            originalDataType: 'INTEGER',
            dataType: 'INTEGER',
            originalNullable: false,
            nullable: false,
            originalDefaultValue: null,
            defaultValue: '',
            originalIsPrimaryKey: true,
            isPrimaryKey: true,
            isAutoIncrement: true,
          },
          {
            id: 'c2',
            status: 'existing' as const,
            originalName: 'legacy',
            name: 'legacy',
            originalDataType: 'TEXT',
            dataType: 'INTEGER',
            originalNullable: true,
            nullable: true,
            originalDefaultValue: null,
            defaultValue: '',
            originalIsPrimaryKey: false,
            isPrimaryKey: false,
            isAutoIncrement: false,
          },
        ],
        indexes: [],
        foreignKeys: [],
      }
      const plan = (
        view as unknown as {
          computeValidatedPlan: (d: typeof draft) => { valid: boolean; errors: string[] }
        }
      ).computeValidatedPlan(draft)
      expect(plan.valid).toBe(false)
      expect(plan.errors.some((e) => e.includes('manual transaction is active'))).toBe(true)
    })

    it('#53 Bug 11: routes Studio explainSql() through DangerSQL confirmation modal before dispatching query.explain', async () => {
      const rpcCalls: string[] = []
      const mountedModals: Array<{ textContent: string; querySelectorAll?: unknown }> = []
      const prevWin = (globalThis as Record<string, unknown>).window
      const prevDoc = (globalThis as Record<string, unknown>).document
      ;(globalThis as Record<string, unknown>).window = {
        orca: {
          plugin: {
            request: async (method: string, payload: { sql?: string }) => {
              rpcCalls.push(`${method}:${payload?.sql ?? ''}`)
              return { columns: [], rows: [], rowCount: 0, executionTimeMs: 1, truncated: false, isSelect: true }
            },
          },
        },
      }
      const makeBtn = () => ({
        tagName: 'BUTTON',
        type: '',
        className: '',
        textContent: '',
        disabled: false,
        style: {},
        classList: { add: () => {}, remove: () => {} },
        children: [] as Array<Record<string, unknown>>,
        appendChild(c: Record<string, unknown>) {
          this.children.push(c)
          return c
        },
        addEventListener: () => {},
        setAttribute: () => {},
        focus: () => {},
        querySelector: () => null,
      })
      ;(globalThis as Record<string, unknown>).document = {
        createElement: () => makeBtn(),
      }
      try {
        const fakeCtx = {
          sqlConsole: {
            getSelectedSql: () => '',
            getText: () => 'DROP TABLE users;',
          },
          activeQueryId: null,
          cancelledQueryIds: new Set<string>(),
          activeConnectionId: 'c1',
          getActiveConnection: () => ({
            id: 'c1',
            name: 'Dev SQLite',
            driver: 'sqlite',
            host: 'localhost',
            port: 0,
            database: 'app.db',
          }),
          isActiveConnectionReadOnly: () => false,
          updateStatus: () => {},
          hideQueryBanner: () => {},
          setQueryRunningState: () => {},
          createElapsedTimer: () => () => {},
          mountStudioModal: (el: { textContent: string }) => {
            mountedModals.push(el)
          },
          closeActiveModal: () => {},
          consoleTabs: {
            getActiveTabId: () => 'tab1',
            setResultForTab: () => {},
            getActiveTab: () => undefined,
          },
          closeValueInspector: () => {},
          applyResultTabState: () => {},
          saveStudioViewState: () => {},
          saveStudioDataCache: () => {},
          showQueryBanner: () => {},
          hideResultSetsBar: () => {},
          renderExplainAiForActiveTab: () => {},
          updatePaginationButtons: () => {},
          updateExportDropdownOptions: () => {},
          refreshTransactionState: async () => {},
          requestPlugin: (method: string, payload: { sql?: string }) =>
            (
              globalThis as unknown as {
                window: { orca: { plugin: { request: (m: string, p: { sql?: string }) => Promise<unknown> } } }
              }
            ).window.orca.plugin.request(method, payload),
          querySeq: 0,
          gridViewSeq: 0,
          tableLoadToken: 0,
          isTableLoading: false,
          activeWorkerQueryId: null,
          runBtn: null,
          runAllBtn: null,
          explainBtn: null,
          dataGrid: null,
          promptBindParams: () => {},
        }
        await DatanoaStudioEditor.prototype.explainSql.call(fakeCtx, false)
        expect(mountedModals.length).toBe(1)
        expect(rpcCalls).toHaveLength(0)

        // Plain EXPLAIN DELETE passes DangerSQL directly to query.explain
        fakeCtx.sqlConsole.getText = () => 'EXPLAIN DELETE FROM users;'
        await DatanoaStudioEditor.prototype.explainSql.call(fakeCtx, false)
        expect(rpcCalls).toEqual(['query.explain:EXPLAIN DELETE FROM users'])
      } finally {
        ;(globalThis as Record<string, unknown>).window = prevWin
        ;(globalThis as Record<string, unknown>).document = prevDoc
      }
    })
  })

  describe('Slice 7: Wave 2 fixes (#69, #71, #72, #73)', () => {
    it('#69 Bug 1: preserves non-secret MongoDB authSource/authMechanism params while redacting genuine secrets & #fragments', () => {
      const sanitized = sanitizeConnectionProfile({
        id: 'mongo-1',
        name: 'Mongo Atlas',
        driver: 'mongodb',
        host: 'cluster0.example.net',
        port: 27017,
        database: 'app',
        url: 'mongodb+srv://u:p%40s@cluster0.example.net/db?authSource=admin&authMechanism=SCRAM-SHA-256&authType=scram&token=DropMe#auth_token=FragDrop&x=1',
      })
      expect(sanitized.url).toBe('mongodb+srv://cluster0.example.net/db?authSource=admin&authMechanism=SCRAM-SHA-256&authType=scram#x=1')

      const scrubbedLog = scrubCredentialsInText(
        'Failed connecting mongodb://admin:TopPass99@db.lan/app?authSource=admin&authToken=SecretTok&api_key=K1&apikey=K2&credential=Cr3&signature=Sig4#jwt=J1&ok=1 | Authorization: Bearer tokBearer123 | Basic dXNlcjpwYXNz | Basic authentication failed | Server=db;Password={p@}}ss;1};Database=app'
      )
      expect(scrubbedLog).toContain('authSource=admin')
      expect(scrubbedLog).toContain('Basic authentication failed')
      expect(scrubbedLog).toContain('Server=db')
      expect(scrubbedLog).toContain('Database=app')
      expect(scrubbedLog).not.toContain('TopPass99')
      expect(scrubbedLog).not.toContain('SecretTok')
      expect(scrubbedLog).not.toContain('K1')
      expect(scrubbedLog).not.toContain('K2')
      expect(scrubbedLog).not.toContain('Cr3')
      expect(scrubbedLog).not.toContain('Sig4')
      expect(scrubbedLog).not.toContain('J1')
      expect(scrubbedLog).not.toContain('tokBearer123')
      expect(scrubbedLog).not.toContain('dXNlcjpwYXNz')
      expect(scrubbedLog).not.toContain('p@')
    })

    it('#71 Bug 6: preserves EXPLAIN PLAN SET STATEMENT_ID ... FOR in Oracle buildExplainPlanForStatement', () => {
      const customPlan = buildExplainPlanForStatement(
        "EXPLAIN PLAN SET STATEMENT_ID = 'w2' INTO my_plan FOR SELECT * FROM \"HR\".\"EMP\";",
        'oracle',
        true
      )
      expect(customPlan.explainSql).toBe(
        "EXPLAIN PLAN SET STATEMENT_ID = 'w2' INTO my_plan FOR SELECT * FROM \"HR\".\"EMP\""
      )
    })

    it('#72 Bug 1: retains and rotates txToken across commit/rollback while autoCommit === false and releases on switch or autoCommit === true', async () => {
      const handlers = new Map<string, (input: unknown, ctx?: unknown) => Promise<unknown>>()
      let txState = { supported: true, autoCommit: true, active: false, statementCount: 0 }
      let prevAutoCommit = true

      const session = {
        driverType: 'postgres' as const,
        isAlive: () => true,
        getTransactionState: () => ({ ...txState }),
        beginTransaction: async () => {
          prevAutoCommit = txState.autoCommit
          txState = { ...txState, active: true, autoCommit: false }
          return { ...txState }
        },
        commitTransaction: async () => {
          txState = { ...txState, active: false, autoCommit: prevAutoCommit, statementCount: 0 }
          return { ...txState }
        },
        rollbackTransaction: async () => {
          txState = { ...txState, active: false, autoCommit: prevAutoCommit, statementCount: 0 }
          return { ...txState }
        },
        setAutoCommit: async (enabled: boolean) => {
          prevAutoCommit = enabled
          txState = { ...txState, autoCommit: enabled }
          return { ...txState }
        },
        runQuery: async () => ({
          columns: [],
          rows: [],
          rowCount: 0,
          executionTimeMs: 1,
          truncated: false,
          isSelect: false,
        }),
      }
      registerQueryAndTxHandlers({
        orca: { storage: { get: async () => [], set: async () => {} }, settings: { get: async () => 500 }, log: () => {} } as never,
        registerHandler: ((name: string, fn: (input: unknown, ctx?: unknown) => Promise<unknown>) => {
          handlers.set(name, fn)
        }) as never,
        sessionManager: {
          findProfile: async () => ({ id: 'c_tx', name: 'PG', driver: 'postgres', host: 'h', port: 5432, database: 'd' }),
          getSession: async () => session,
        } as never,
        tracker: { activeQuerySessions: new Map(), consumePreCancelledQuery: () => false, trackQuery: () => {}, untrackQuery: () => {} } as never,
      })

      const setAutoCommit = handlers.get('tx.setAutoCommit')!
      const begin = handlers.get('tx.begin')!
      const commit = handlers.get('tx.commit')!
      const rollback = handlers.get('tx.rollback')!
      const status = handlers.get('tx.status')!

      // Panel 1 disables autoCommit, begins and commits: autoCommit stays false and txToken rotates
      const acRes = (await setAutoCommit({ connectionId: 'c_tx', enabled: false }, { panel: { id: 'p1' } })) as { txToken?: number }
      await begin({ connectionId: 'c_tx' }, { panel: { id: 'p1' } })
      const cRes = (await commit({ connectionId: 'c_tx' }, { panel: { id: 'p1' } })) as { txToken?: number; autoCommit: boolean }
      expect(cRes.autoCommit).toBe(false)
      expect(typeof cRes.txToken).toBe('number')
      expect(cRes.txToken).not.toBe(acRes.txToken)

      const stAfterCommit = (await status({ connectionId: 'c_tx' }, { panel: { id: 'p1' } })) as { txToken?: number }
      expect(stAfterCommit.txToken).toBe(cRes.txToken)

      // Explicit rollback while autoCommit is false also rotates txToken cleanly
      await begin({ connectionId: 'c_tx' }, { panel: { id: 'p1' } })
      const rbRes = (await rollback({ connectionId: 'c_tx' }, { panel: { id: 'p1' } })) as { txToken?: number; autoCommit: boolean }
      expect(rbRes.autoCommit).toBe(false)
      expect(typeof rbRes.txToken).toBe('number')
      expect(rbRes.txToken).not.toBe(cRes.txToken)

      // Switching away via onlyIfOwner resets autoCommit=true and frees connection for Panel 2
      const rbSwitch = (await rollback({ connectionId: 'c_tx', onlyIfOwner: true, txToken: rbRes.txToken }, { panel: { id: 'p1' } })) as { autoCommit: boolean }
      expect(rbSwitch.autoCommit).toBe(true)
      const p2Begin = (await begin({ connectionId: 'c_tx' }, { panel: { id: 'p2' } })) as { active: boolean }
      expect(p2Begin.active).toBe(true)
    })

    it('#73 Bug 1 & Bug 3: Studio countRowsForObject uses countDocuments for MongoDB and openStudioForWorkspace emits dialect starters', async () => {
      const rpcCalls: Array<{ method: string; sql: string }> = []
      const banners: string[] = []
      const prevWin = (globalThis as Record<string, unknown>).window
      ;(globalThis as Record<string, unknown>).window = {
        orca: { plugin: { request: async () => ({}) } },
      }
      try {
        const fakeEditor = {
          activeConnectionId: 'c1',
          countRowsSeq: 0,
          getActiveConnection: () => ({ id: 'c1', name: 'Mongo', driver: 'mongodb', host: 'localhost', port: 27017, database: 'app' }),
          formatQualifiedSqlTable: (o: { name: string }) => `"${o.name}"`,
          updateStatus: () => {},
          requestPlugin: async (method: string, payload: { sql: string }) => {
            rpcCalls.push({ method, sql: payload.sql })
            return { columns: [{ name: 'count', type: 'number' }], rows: [[42]], rowCount: 1, executionTimeMs: 2, truncated: false, isSelect: true }
          },
          showQueryBanner: (_kind: string, title: string, detail: string) => {
            banners.push(`${title}|${detail}`)
          },
        }
        await (
          DatanoaStudioEditor.prototype as unknown as {
            countRowsForObject: (item: { name: string; schema: string; kind: string }) => Promise<void>
          }
        ).countRowsForObject.call(fakeEditor, { name: 'events', schema: 'app', kind: 'table' })
        expect(rpcCalls[0]).toEqual({
          method: 'query.run',
          sql: 'db.getCollection("events").countDocuments({});',
        })
        expect(banners[0]).toContain('42')
      } finally {
        ;(globalThis as Record<string, unknown>).window = prevWin
      }

      const tmpWs = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'datanoa-open-studio-'))
      tempDirs.push(tmpWs)
      const makeOrca = () => ({
        host: {
          call: async (name: string) =>
            name === 'workspace.list' ? { workspaces: [{ id: 'w1', path: tmpWs, name: 'ws' }] } : null,
        },
        panels: { post: () => {} },
      })
      for (const tc of [
        { driver: 'mongodb' as const, table: 'users', expected: 'db.getCollection("users").find({}).limit(100);' },
        { driver: 'mongodb' as const, table: undefined, expected: 'db.stats();' },
        { driver: 'mssql' as const, table: 'Users', schema: 'dbo', expected: 'SELECT TOP 100 * FROM [dbo].[Users];' },
        { driver: 'oracle' as const, table: 'EMP', schema: 'HR', expected: 'SELECT * FROM "HR"."EMP" FETCH FIRST 100 ROWS ONLY;' },
        { driver: 'oracle' as const, table: undefined, expected: 'SELECT 1 FROM DUAL;' },
      ]) {
        const res = await openStudioDocumentInOrca(
          makeOrca() as never,
          { connectionId: 'p1', table: tc.table, schema: tc.schema },
          {
            findProfile: async () => ({
              id: 'p1',
              name: tc.driver,
              driver: tc.driver,
              host: 'localhost',
              port: 1,
              database: 'db',
            }),
          } as never
        )
        expect(res.ok).toBe(true)
        expect(typeof res.path).toBe('string')
        const written = await fs.promises.readFile(path.join(tmpWs, String(res.path || '')), 'utf8')
        expect(written).toContain(tc.expected)
      }
    })

    it('#72 Bugs 2 & 4, #73 Bugs 2, 4, 5, 6, 7: fixes panel-core trigger rewrite, case-sensitive rename, Mongo formatting/DDL, SSL/d1 defaults, theme tokens, and dialect column types', () => {
      // #72 Bug 2: trigger rewrite skips comments and quoted literals
      const plan = panelCore.buildPanelMigrationSql(
        {
          tableName: 'orders_v2',
          originalTableName: 'orders',
          columns: [
            { id: 'c1', status: 'existing', originalName: 'id', name: 'id', originalDataType: 'INTEGER', dataType: 'INTEGER', originalNullable: false, nullable: false, originalDefaultValue: '', defaultValue: '', isPrimaryKey: true, originalIsPrimaryKey: true },
            { id: 'c2', status: 'existing', originalName: 'total', name: 'total', originalDataType: 'TEXT', dataType: 'INTEGER', originalNullable: true, nullable: true, originalDefaultValue: '', defaultValue: '', isPrimaryKey: false, originalIsPrimaryKey: false },
          ],
          indexes: [],
          foreignKeys: [],
          triggers: [
            {
              name: 'trg_commented',
              sql: "CREATE TRIGGER trg_commented AFTER INSERT ON /* ON orders */ \"orders\" BEGIN SELECT 'ON orders'; END;",
            },
          ],
        },
        'sqlite'
      )
      const trgStmt = plan.find((s) => s.includes('CREATE TRIGGER'))
      expect(trgStmt).toContain('AFTER INSERT ON /* ON orders */ "orders_v2"')
      expect(trgStmt).toContain("'ON orders'")

      // #72 Bug 4: case-only table rename blocked when triggers exist
      expect(() =>
        panelCore.buildPanelMigrationSql(
          {
            tableName: 'Users',
            originalTableName: 'users',
            columns: [{ id: 'c1', status: 'existing', originalName: 'id', name: 'id', originalDataType: 'INTEGER', dataType: 'INTEGER', originalNullable: false, nullable: false, originalDefaultValue: '', defaultValue: '', isPrimaryKey: true, originalIsPrimaryKey: true }],
            indexes: [],
            foreignKeys: [],
            triggers: [{ name: 't1', sql: 'CREATE TRIGGER t1 AFTER INSERT ON users BEGIN SELECT 1; END;' }],
          },
          'sqlite'
        )
      ).toThrow(/Trigger "t1" exists on "users".*Direct table rename to "Users"/)

      // #73 Bug 4: Mongo formatting preserved & Mongo DDL recognized cleanly
      const rawMql = 'db.users.find({ order: 1, set: 2, count: true }).limit(10);'
      expect(panelCore.formatPanelSql(rawMql, 'mongodb')).toBe(rawMql)
      expect(panelCore.panelContainsDdlStatement('db.createCollection("events");', 'mongodb')).toBe(true)
      expect(panelCore.panelContainsDdlStatement('db.getCollection("events").drop();', 'mongodb')).toBe(true)
      expect(panelCore.panelContainsDdlStatement('{ "drop": "events" }', 'mongodb')).toBe(true)
      expect(panelCore.panelContainsDdlStatement('{ "find": "events", "filter": { "drop": true } }', 'mongodb')).toBe(false)
      expect(panelCore.panelContainsDdlStatement('// db.events.drop()\ndb.events.find({ note: "db.events.drop()" });', 'mongodb')).toBe(false)

      // #73 Bug 2 & 7 helpers in panel-core
      expect(panelCore.buildSelectPreviewQuery('mongodb', 'users', 'app', '')).toBe(
        'db.getCollection("users").find({}).limit(100);'
      )
      expect(panelCore.buildSelectPreviewQuery('mssql', 'Users', 'dbo', '')).toBe(
        'SELECT TOP 100 * FROM [dbo].[Users];'
      )
      expect(panelCore.buildSelectPreviewQuery('oracle', 'EMP', 'HR', '')).toBe(
        'SELECT * FROM "HR"."EMP" FETCH FIRST 100 ROWS ONLY;'
      )
      expect(
        (panelCore as unknown as { buildInitialCreateTableDraftColumns: (d: string) => Array<{ dataType: string }> })
          .buildInitialCreateTableDraftColumns('oracle')
          .map((c) => c.dataType)
      ).toEqual(['NUMBER(10)', 'VARCHAR2(255)'])
      expect(
        (panelCore as unknown as { buildInitialCreateTableDraftColumns: (d: string) => Array<{ dataType: string }> })
          .buildInitialCreateTableDraftColumns('mssql')
          .map((c) => c.dataType)
      ).toEqual(['INT', 'NVARCHAR(255)'])

      // #73 Bug 5: SSL capability flags + d1 defaultDb consistency
      expect(panelCore.ENGINE_BY_ID.cassandra.supportsSsl).toBe(true)
      expect(panelCore.ENGINE_BY_ID.elasticsearch.supportsSsl).toBe(true)
      expect(panelCore.ENGINE_BY_ID.neo4j.supportsSsl).toBe(true)
      expect(getStudioEngineMeta('d1').defaultDb).toBe('main')

      // #73 Bug 6: theme.ts color variables in dark and light themes
      for (const token of [
        '--db-mssql:',
        '--db-oracle:',
        '--db-mongodb:',
        '--db-duckdb:',
        '--db-snowflake:',
        '--db-bigquery:',
        '--db-cassandra:',
        '--db-elasticsearch:',
        '--db-neo4j:',
        '--db-custom:',
      ]) {
        const matches = EDITOR_STYLE.match(new RegExp(token, 'g')) ?? []
        expect(matches.length).toBeGreaterThanOrEqual(2)
      }
    })
  })

  describe('Slice 8: Wave 3 fixes (#90, #93, #94)', () => {
    it('#90 Bug 2: uses CSS --db-* variables and db-<id> classes on all BYOD SVG icons', () => {
      const panelMap = buildPanelDbSvgMarkupMap()
      const byodIds = ['duckdb', 'snowflake', 'bigquery', 'cassandra', 'elasticsearch', 'neo4j', 'custom'] as const
      for (const id of byodIds) {
        expect(panelMap[id]).toContain(`db-${id}`)
        expect(panelMap[id]).toContain(`db-byod-${id}`)
        expect(panelMap[id]).toContain(`color: var(--db-${id},`)
      }

      const prevDoc = (globalThis as Record<string, unknown>).document
      ;(globalThis as Record<string, unknown>).document = {
        createElementNS: (_ns: string, tag: string) => ({
          tag,
          attrs: {} as Record<string, string>,
          setAttribute(k: string, v: string) {
            this.attrs[k] = v
          },
          appendChild() {},
        }),
      }
      try {
        for (const id of byodIds) {
          const el = createByodDriverLogoSvg(id) as unknown as { attrs: Record<string, string> }
          expect(el.attrs.class).toContain(`db-${id}`)
          expect(el.attrs.class).toContain(`db-byod-${id}`)
          expect(el.attrs.style).toContain(`color: var(--db-${id},`)
        }
        const fallbackEl = createByodDriverLogoSvg('my-slot') as unknown as { attrs: Record<string, string> }
        expect(fallbackEl.attrs.class).toContain('db-custom')
        expect(fallbackEl.attrs.class).toContain('db-byod-my-slot')
        expect(fallbackEl.attrs.style).toContain('color: var(--db-custom,')
      } finally {
        ;(globalThis as Record<string, unknown>).document = prevDoc
      }
    })

    it('#93 Bugs 2 & 3, #94 Bug 1: scrubs slash/# passwords, slash-less query @ emails, and JSON-escaped ClickHouse URIs', () => {
      // Passwords with '/' and '#' before @host
      const redisOut = scrubCredentialsInText(
        'Connect failed: redis://u:Pass/Slash#99@127.0.0.1:56379/0?password=Sec99'
      )
      expect(redisOut).toContain('127.0.0.1:56379/0')
      expect(redisOut).not.toContain('Pass/Slash#99')
      expect(redisOut).not.toContain('Sec99')

      // Password containing '?', '#', '@', ':' and '/' before real @host
      const complexMongo = scrubCredentialsInText(
        'mongodb+srv://admin:M#1?2@3:4/5@cluster0.example.net/w3_r3_db?authSource=admin&token=SecTok'
      )
      expect(complexMongo).toContain('@cluster0.example.net/w3_r3_db?authSource=admin')
      expect(complexMongo).not.toContain('M#1?2@3:4/5')
      expect(complexMongo).not.toContain('SecTok')

      // Slash-less URIs with '@' in query params & braced ADO.NET passwords
      const slashlessMongo = scrubCredentialsInText(
        'mongodb+srv://u:SecPass1@host?authSource=admin&email=a@b'
      )
      expect(slashlessMongo).toBe('mongodb+srv://u@host?authSource=admin&email=a@b')

      const sanitizedSlashless = sanitizeConnectionProfile({
        id: 'm_slashless',
        name: 'Mongo',
        driver: 'mongodb',
        host: 'host',
        port: 27017,
        database: 'app',
        url: 'mongodb+srv://u:SecPass1@host?authSource=admin&email=a@b&token=DropMe#tab=indexes',
      })
      expect(sanitizedSlashless.url).toBe(
        'mongodb+srv://host?authSource=admin&email=a@b#tab=indexes'
      )
      expect(sanitizedSlashless.url).not.toContain('SecPass1')
      expect(sanitizedSlashless.url).not.toContain('DropMe')

      const slashlessOracle = scrubCredentialsInText(
        'oracle://hr:Sec!99@ora.example:1521?token=tok123&authSource=admin&Pwd={p@ss;1}'
      )
      expect(slashlessOracle).toContain('ora.example:1521')
      expect(slashlessOracle).toContain('authSource=admin')
      expect(slashlessOracle).not.toContain('Sec!99')
      expect(slashlessOracle).not.toContain('tok123')
      expect(slashlessOracle).not.toContain('p@ss;1')

      // Escaped ClickHouse JSON URI (:\\/\\/)
      const chEscaped = scrubCredentialsInText(
        '{"exception":"Code: 60. DB::Exception: http:\\/\\/u:ChRowSecret99@127.0.0.1:8123\\/db\\/0 failed"}'
      )
      expect(chEscaped).toContain('127.0.0.1:8123')
      expect(chEscaped).not.toContain('ChRowSecret99')

      // Path @handle and query ?next=@alice without credentials stay intact while secrets redact
      const pathAt = scrubCredentialsInText(
        'https://example.com:8443/users/@alice?token=secret#tab=indexes'
      )
      expect(pathAt).toBe('https://example.com:8443/users/@alice?token=[REDACTED]#tab=indexes')

      const queryAt = scrubCredentialsInText(
        'https://example.com:8443?next=@alice&token=secret'
      )
      expect(queryAt).toBe('https://example.com:8443?next=@alice&token=[REDACTED]')
    })

    it('#94 Bug 3: panelContainsDdlStatement delegates MongoDB cleanly to sharedContainsDdlStatement', () => {
      expect(panelCore.panelContainsDdlStatement("db['y'].createIndex({ a: 1 })", 'mongodb')).toBe(true)
      expect(panelCore.panelContainsDdlStatement('db.createView("v", "users", [])', 'mongodb')).toBe(true)
      expect(panelCore.panelContainsDdlStatement('db.runCommand({ create: "z" })', 'mongodb')).toBe(true)
      expect(panelCore.panelContainsDdlStatement('db.adminCommand({ dropDatabase: 1 })', 'mongodb')).toBe(true)
      expect(panelCore.panelContainsDdlStatement('{ create: "z" }', 'mongodb')).toBe(true)
      expect(panelCore.panelContainsDdlStatement('db.users.find({}); { create: "z" }', 'mongodb')).toBe(true)
      expect(panelCore.panelContainsDdlStatement('db.users.find({ create: "ok" })', 'mongodb')).toBe(false)
    })
  })

  describe('Slice 9: Wave 4 fixes (#110, #113, #114)', () => {
    it('#113 Bug 1: emits 2-step temp rename for SQLite/LibSQL/D1 case-only table rename and executes cleanly in SQLite', async () => {
      for (const drv of ['sqlite', 'libsql', 'd1'] as const) {
        const stmts = panelCore.buildPanelMigrationSql(
          {
            tableName: 'w4_case',
            originalTableName: 'W4_Case',
            columns: [
              {
                id: 'c1',
                status: 'existing',
                originalName: 'id',
                name: 'id',
                originalDataType: 'INTEGER',
                dataType: 'INTEGER',
                originalNullable: false,
                nullable: false,
                originalDefaultValue: '',
                defaultValue: '',
                isPrimaryKey: true,
                originalIsPrimaryKey: true,
              },
            ],
            indexes: [],
            foreignKeys: [],
          },
          drv
        )
        expect(stmts).toEqual([
          'ALTER TABLE "W4_Case" RENAME TO "__datanoa_case_rename_tmp";',
          'ALTER TABLE "__datanoa_case_rename_tmp" RENAME TO "w4_case";',
        ])
      }

      const sqliteMod = (await import('node:sqlite').catch(() => null)) as {
        DatabaseSync?: new (p: string) => { exec: (sql: string) => void; prepare: (sql: string) => { get: () => Record<string, unknown> | undefined }; close: () => void }
      } | null
      if (sqliteMod?.DatabaseSync) {
        const db = new sqliteMod.DatabaseSync(':memory:')
        try {
          db.exec('CREATE TABLE "W4_Case" (id INTEGER PRIMARY KEY);')
          const stmts = panelCore.buildPanelMigrationSql(
            {
              tableName: 'w4_case',
              originalTableName: 'W4_Case',
              columns: [
                {
                  id: 'c1',
                  status: 'existing',
                  originalName: 'id',
                  name: 'id',
                  originalDataType: 'INTEGER',
                  dataType: 'INTEGER',
                  originalNullable: false,
                  nullable: false,
                  originalDefaultValue: '',
                  defaultValue: '',
                  isPrimaryKey: true,
                  originalIsPrimaryKey: true,
                },
              ],
              indexes: [],
              foreignKeys: [],
            },
            'sqlite'
          )
          db.exec(stmts.join('\n'))
          const row = db
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='w4_case'")
            .get()
          expect(row?.name).toBe('w4_case')
        } finally {
          db.close()
        }
      }
    })

    it('#110 Bug 1 & theme alignment: rejects studioOnly drivers in Side Panel driver resolver and aligns all 19 dark/light CSS tokens between theme.ts and panel.css', async () => {
      const resolvePanelFormDriver = (
        panelCore as unknown as {
          resolvePanelFormDriver: (candidate: unknown, fallback?: string) => string
        }
      ).resolvePanelFormDriver
      expect(typeof resolvePanelFormDriver).toBe('function')
      expect(resolvePanelFormDriver('d1')).toBe('sqlite')
      expect(resolvePanelFormDriver('postgres')).toBe('postgres')
      expect(resolvePanelFormDriver('unknown_drv')).toBe('sqlite')

      const panelCss = await fs.promises.readFile(
        path.resolve(__dirname, '../src/panel/panel.css'),
        'utf8'
      )
      const extractDbVars = (cssText: string, startMarker: string, endMarker: string): Record<string, string> => {
        const startIdx = cssText.indexOf(startMarker)
        const endIdx = cssText.indexOf(endMarker, startIdx)
        const slice = cssText.slice(startIdx, endIdx)
        const out: Record<string, string> = {}
        for (const m of slice.matchAll(/(--db-[a-z0-9]+):\s*([^;]+);/g)) {
          if (m[1] !== '--db-cockroach') {
            out[m[1]] = m[2].trim().toLowerCase()
          }
        }
        return out
      }
      const themeDark = extractDbVars(EDITOR_STYLE, ':root {', 'color-scheme: dark;')
      const panelDark = extractDbVars(panelCss, ':root {', '--radius:')
      const themeLight = extractDbVars(EDITOR_STYLE, 'html.light, body.light {', 'color-scheme: light;')
      const panelLight = extractDbVars(panelCss, 'html.light, body.light {', '--menu-shadow:')
      expect(themeDark).toEqual(panelDark)
      expect(themeLight).toEqual(panelLight)
    })

    it('#114 Bug 2: unifies client localStorage scrubbers across Studio document-meta and Side Panel storage', () => {
      const scrubPanelUrl = (
        panelCore as unknown as { scrubClientUrlCredentials: (raw: unknown) => string }
      ).scrubClientUrlCredentials
      expect(typeof scrubPanelUrl).toBe('function')

      const stored = new Map<string, string>()
      const prevWin = (globalThis as Record<string, unknown>).window
      ;(globalThis as Record<string, unknown>).window = {
        localStorage: {
          getItem: (k: string) => stored.get(k) ?? null,
          setItem: (k: string, v: string) => {
            stored.set(k, v)
          },
        },
      }
      try {
        const vectors = [
          {
            input:
              'mongodb+srv://u:Pass1@cluster0.example.net/db?authSource=admin&authMechanism=SCRAM-SHA-256&authMechanismProperties=SERVICE_NAME:hive&authType=scram&credentials=CredPlural&api-key=AK1&auth-token=AT1&access-token=Ac1&refresh-token=Rf1&id-token=Id1&client-secret=Cs1&private-key=Pk1#auth_token=FragDrop&tab=indexes',
            keep: ['authSource=admin', 'authMechanism=SCRAM-SHA-256', 'authMechanismProperties=SERVICE_NAME:hive', 'authType=scram', 'tab=indexes'],
            drop: ['Pass1', 'CredPlural', 'AK1', 'AT1', 'Ac1', 'Rf1', 'Id1', 'Cs1', 'Pk1', 'FragDrop'],
          },
          {
            input: 'redis://u:Pass/Slash#99@127.0.0.1:56379/0?password=Sec99',
            keep: ['127.0.0.1:56379/0'],
            drop: ['Pass/Slash#99', 'Sec99'],
          },
          {
            input: 'mongodb+srv://u:Pass?a=1@cluster0.example.net/db?authSource=admin',
            keep: ['cluster0.example.net/db?authSource=admin'],
            drop: ['Pass?a=1'],
          },
          {
            input: 'mongodb+srv://u:SecPass1@host?authSource=admin&email=a@b',
            keep: ['host?authSource=admin&email=a@b'],
            drop: ['SecPass1'],
          },
          {
            input: 'oracle://hr:Sec!99@ora.example:1521?token=tok123&authSource=admin&Pwd={p@ss;1}',
            keep: ['ora.example:1521', 'authSource=admin'],
            drop: ['Sec!99', 'tok123', 'p@ss;1'],
          },
          {
            input: 'https://api-server:8443/users/@alice?credentials=DropCred#tab=indexes',
            keep: ['https://api-server:8443/users/@alice', '#tab=indexes'],
            drop: ['DropCred'],
          },
          {
            input: 'https://api-server:8443/db#section=a@b.com',
            keep: ['https://api-server:8443/db#section=a@b.com'],
            drop: [],
          },
          {
            input: 'Server=db;Password={p}}s;1};Bearer TokB1;Basic dXNlcjpwYXNz',
            keep: ['Server=db'],
            drop: ['p}}s;1', 'TokB1', 'dXNlcjpwYXNz'],
          },
        ]

        for (const v of vectors) {
          const panelOut = scrubPanelUrl(v.input)
          for (const k of v.keep) expect(panelOut).toContain(k)
          for (const d of v.drop) expect(panelOut).not.toContain(d)
        }

        writeLocalStudioWarmCache({
          updatedAt: Date.now(),
          connections: vectors.map((v, idx) => ({
            id: `c_${idx}`,
            name: `Conn ${idx}`,
            driver: 'postgres',
            host: 'localhost',
            port: 5432,
            database: 'app',
            url: v.input,
            options: v.input,
          })),
        })
        const warm = readLocalStudioWarmCache()
        expect(warm?.connections?.length).toBe(vectors.length)
        for (let idx = 0; idx < vectors.length; idx++) {
          const url = warm?.connections?.[idx]?.url ?? ''
          const opts = warm?.connections?.[idx]?.options ?? ''
          for (const k of vectors[idx].keep) {
            expect(url).toContain(k)
            expect(opts).toContain(k)
          }
          for (const d of vectors[idx].drop) {
            expect(url).not.toContain(d)
            expect(opts).not.toContain(d)
          }
        }
      } finally {
        ;(globalThis as Record<string, unknown>).window = prevWin
      }
    })
  })

  describe('Slice 10: Wave 5 fixes (#114 Bug 2 authority/JSON bounds)', () => {
    it('preserves query/fragment @ after non-clean passwords and stops query/kv redaction before JSON delimiters', () => {
      const scrubPanelUrl = (
        panelCore as unknown as { scrubClientUrlCredentials: (raw: unknown) => string }
      ).scrubClientUrlCredentials

      const cases = [
        {
          input: 'mongodb+srv://admin:pass?a=1@cluster0.example.net/db?email=x@y.com',
          expected: 'mongodb+srv://admin@cluster0.example.net/db?email=x@y.com',
        },
        {
          input: 'mongodb+srv://u:Pass/Slash#99@host/db#section=a@b.com',
          expected: 'mongodb+srv://u@host/db#section=a@b.com',
        },
        {
          input: 'https://admin:pass?a=1@ch.example.com:8443/analytics?email=x@y.com',
          expected: 'https://admin@ch.example.com:8443/analytics?email=x@y.com',
        },
        {
          input: 'https://u:p/1@myhost/users/@alice.dev?token=secret',
          expected: 'https://u@myhost/users/@alice.dev?token=[REDACTED]',
        },
        {
          input: '{"url":"https://u:p@host/db?token=secret"}',
          expected: '{"url":"https://u@host/db?token=[REDACTED]"}',
        },
        {
          input: '{"url":"https://api-server:8443/users/@alice?credentials=k6"}',
          expected: '{"url":"https://api-server:8443/users/@alice?credentials=[REDACTED]"}',
        },
        {
          input: '{"opts":"Server=db;Password=Sec123"}',
          expected: '{"opts":"Server=db;Password=[REDACTED]"}',
        },
      ]

      for (const tc of cases) {
        expect(scrubPanelUrl(tc.input)).toBe(tc.expected)
        expect(scrubSensitiveStringForLocalStorage(tc.input)).toBe(tc.expected)
      }
    })
  })

  describe('Slice 11: Wave 6 fixes (R1 Bug 1, R4 Bug 1a, R4 Bug 4)', () => {
    it('R1 Bug 1: qualifies Step 2 temp table with draft.schema for attached SQLite schema case-only rename', async () => {
      const stmts = panelCore.buildPanelMigrationSql(
        {
          tableName: 'w6_ledger',
          originalTableName: 'W6_Ledger',
          schema: 'w6_r1_aux',
          columns: [
            {
              id: 'c1',
              status: 'existing',
              originalName: 'id',
              name: 'id',
              originalDataType: 'INTEGER',
              dataType: 'INTEGER',
              originalNullable: false,
              nullable: false,
              originalDefaultValue: '',
              defaultValue: '',
              isPrimaryKey: true,
              originalIsPrimaryKey: true,
            },
          ],
          indexes: [],
          foreignKeys: [],
        },
        'sqlite'
      )
      expect(stmts).toEqual([
        'ALTER TABLE "w6_r1_aux"."W6_Ledger" RENAME TO "__datanoa_case_rename_tmp";',
        'ALTER TABLE "w6_r1_aux"."__datanoa_case_rename_tmp" RENAME TO "w6_ledger";',
      ])

      const sqliteMod = (await import('node:sqlite').catch(() => null)) as {
        DatabaseSync?: new (p: string) => {
          exec: (sql: string) => void
          prepare: (sql: string) => { all: () => Array<{ name: string }> }
          close: () => void
        }
      } | null
      if (sqliteMod?.DatabaseSync) {
        const db = new sqliteMod.DatabaseSync(':memory:')
        try {
          db.exec('ATTACH DATABASE ":memory:" AS w6_r1_aux;')
          db.exec('CREATE TABLE main.__datanoa_case_rename_tmp (id INTEGER PRIMARY KEY);')
          db.exec('CREATE TABLE w6_r1_aux."W6_Ledger" (id INTEGER PRIMARY KEY);')
          db.exec(stmts.join('\n'))
          const mainTables = db.prepare("SELECT name FROM main.sqlite_master WHERE type='table'").all().map((r) => r.name)
          const auxTables = db.prepare("SELECT name FROM w6_r1_aux.sqlite_master WHERE type='table'").all().map((r) => r.name)
          expect(mainTables).toEqual(['__datanoa_case_rename_tmp'])
          expect(auxTables).toEqual(['w6_ledger'])
        } finally {
          db.close()
        }
      }
    })

    it('R4 Bug 1a: masks numeric-prefix ? / # / / passwords while preserving uncredentialed /@handle and ?next=@handle origins', () => {
      const scrubPanelUrl = (
        panelCore as unknown as { scrubClientUrlCredentials: (raw: unknown) => string }
      ).scrubClientUrlCredentials

      const cases = [
        {
          input: 'mongodb+srv://ops:1234?b=2@shard.internal/w6_db?owner=lead@corp.io',
          expected: 'mongodb+srv://ops@shard.internal/w6_db?owner=lead@corp.io',
        },
        {
          input: 'https://ops:1234?k=1@ch.internal:8443/v1?notify=ops@corp.io',
          expected: 'https://ops@ch.internal:8443/v1?notify=ops@corp.io',
        },
        {
          input: 'redis://svc:9981/sub@redis-node/2?password=Top99',
          expected: 'redis://svc@redis-node/2?password=[REDACTED]',
        },
        {
          input: 'mongodb://u:1234#tag=1@cluster.net/db?email=a@b.io',
          expected: 'mongodb://u@cluster.net/db?email=a@b.io',
        },
        {
          input: 'https://u:1234/z@api.internal/v2/@bob?authSource=admin',
          expected: 'https://u@api.internal/v2/@bob?authSource=admin',
        },
        {
          input: 'https://edge-gw:9443/org/@charlie.dev?token=Sec',
          expected: 'https://edge-gw:9443/org/@charlie.dev?token=[REDACTED]',
        },
        {
          input: 'https://edge-gw:9443?next=@charlie.dev',
          expected: 'https://edge-gw:9443?next=@charlie.dev',
        },
      ]

      for (const tc of cases) {
        expect(scrubPanelUrl(tc.input)).toBe(tc.expected)
        expect(scrubSensitiveStringForLocalStorage(tc.input)).toBe(tc.expected)
      }
    })

    it("R4 Bug 4: supports Oracle q'<delim>...<close>' alternative quoting across shared-sql-core, panel-core, and panel-cm", async () => {
      const q1 = "SELECT q'[it's ; ok]' FROM dual;\nSELECT 2 FROM dual;"
      expect(sharedSqlCore.splitSqlStatements(q1, 'oracle').map((s) => s.text)).toEqual([
        "SELECT q'[it's ; ok]' FROM dual",
        'SELECT 2 FROM dual',
      ])
      expect(sharedSqlCore.findStatementAtOffset(q1, 14, 'oracle')).toBe(
        "SELECT q'[it's ; ok]' FROM dual"
      )

      const qAll =
        "SELECT q'(it's ; round)' FROM dual;\nSELECT q'{curly ; brace}' FROM dual;\nSELECT q'<angle ; bracket>' FROM dual;\nSELECT q'!bang ; delim!' FROM dual;"
      expect(sharedSqlCore.splitSqlStatements(qAll, 'oracle')).toHaveLength(4)

      const qNotDdl = "SELECT q'[hello]' || q'[it's CREATE TABLE evil (id INT);]' FROM dual;"
      expect(sharedSqlCore.splitSqlStatements(qNotDdl, 'oracle')).toHaveLength(1)
      expect(sharedSqlCore.containsDdlStatement(qNotDdl, 'oracle')).toBe(false)
      expect(panelCore.panelContainsDdlStatement(qNotDdl, 'oracle')).toBe(false)

      const qWithRealDdl = "SELECT q'[it's ok]' FROM dual;\nCREATE TABLE real_t (id INT);"
      expect(sharedSqlCore.splitSqlStatements(qWithRealDdl, 'oracle')).toHaveLength(2)
      expect(sharedSqlCore.containsDdlStatement(qWithRealDdl, 'oracle')).toBe(true)
      expect(panelCore.panelContainsDdlStatement(qWithRealDdl, 'oracle')).toBe(true)

      const cm = (await import('../vendor/codemirror.js')) as unknown as {
        EditorState: { create: (cfg: { doc: string; extensions: unknown[] }) => { doc: { toString: () => string } } }
        syntaxTree?: (state: unknown) => {
          iterate: (opts: { enter: (node: { name: string; from: number; to: number }) => void }) => void
        }
      }
      const oracleDoc = "SELECT q'[it's ; ok]' FROM dual"
      const state = cm.EditorState.create({
        doc: oracleDoc,
        extensions: [buildPanelLanguageExtension('oracle')],
      })
      if (typeof cm.syntaxTree === 'function') {
        const tree = cm.syntaxTree(state)
        const tokens: Array<{ name: string; text: string }> = []
        tree.iterate({
          enter: (n) => {
            tokens.push({ name: n.name, text: oracleDoc.slice(n.from, n.to) })
          },
        })
        expect(tokens.some((t) => t.text === "q'[it's ; ok]'" && t.name.toLowerCase().includes('string'))).toBe(true)
        expect(tokens.some((t) => t.text === 'FROM' && !t.name.toLowerCase().includes('string'))).toBe(true)
      }
    })
  })

  describe('Slice 12: Wave 7 fixes (R1 Bug 2, R1 Bug 3b, R4 Bug 1, R4 Bug 3)', () => {
    it('R1 Bug 2: Studio handleUpdateCell refreshes transaction state on success and error', async () => {
      const prevWin = (globalThis as Record<string, unknown>).window
      ;(globalThis as Record<string, unknown>).window = {
        orca: { plugin: { request: async () => ({}) } },
      }
      const refreshed: string[] = []
      let failNext = false
      const fakeEditor = {
        activeConnectionId: 'c_w7',
        resolveEditableTargetTable: () => ({ table: 'items', schema: 'main' }),
        isActiveConnectionReadOnly: () => false,
        updateStatus: () => {},
        refreshTransactionState: async (connId: string) => {
          refreshed.push(connId)
        },
        requestPlugin: async () => {
          if (failNext) throw new Error('CHECK constraint failed')
          return { ok: true, affectedRows: 1 }
        },
      }
      try {
        const proto = DatanoaStudioEditor.prototype as unknown as {
          handleUpdateCell: (params: {
            primaryKeys: Record<string, unknown>
            column: string
            newValue: unknown
            originalValue: unknown
            rowIndex: number
          }) => Promise<{ ok: boolean }>
        }
        const okRes = await proto.handleUpdateCell.call(fakeEditor, {
          primaryKeys: { id: 1 },
          column: 'name',
          newValue: 'b',
          originalValue: 'a',
          rowIndex: 0,
        })
        expect(okRes.ok).toBe(true)
        failNext = true
        const errRes = await proto.handleUpdateCell.call(fakeEditor, {
          primaryKeys: { id: 1 },
          column: 'name',
          newValue: 'c',
          originalValue: 'b',
          rowIndex: 0,
        })
        expect(errRes.ok).toBe(false)
        expect(refreshed).toEqual(['c_w7', 'c_w7'])
      } finally {
        ;(globalThis as Record<string, unknown>).window = prevWin
      }
    })

    it('R1 Bug 3b: qualifies attached SQLite schema on index name (not ON table) and on DROP INDEX', async () => {
      const rebuildStmts = panelCore.buildPanelMigrationSql(
        {
          tableName: 'w7_ledger',
          originalTableName: 'W7_Ledger',
          schema: 'w7_r1_aux',
          columns: [
            {
              id: 'c1',
              status: 'existing',
              originalName: 'id',
              name: 'id',
              originalDataType: 'INTEGER',
              dataType: 'INTEGER',
              originalNullable: false,
              nullable: false,
              originalDefaultValue: '',
              defaultValue: '',
              isPrimaryKey: true,
              originalIsPrimaryKey: true,
            },
            {
              id: 'c2',
              status: 'existing',
              originalName: 'val',
              name: 'val',
              originalDataType: 'TEXT',
              dataType: 'INTEGER',
              originalNullable: true,
              nullable: true,
              originalDefaultValue: '',
              defaultValue: '',
              isPrimaryKey: false,
              originalIsPrimaryKey: false,
            },
          ],
          indexes: [
            {
              id: 'i1',
              status: 'existing',
              name: 'idx_w7_val',
              columns: ['val'],
              unique: false,
              isPrimary: false,
            },
          ],
          foreignKeys: [],
        },
        'sqlite'
      )
      expect(rebuildStmts.some((s) => s.includes('CREATE INDEX IF NOT EXISTS "w7_r1_aux"."idx_w7_val" ON "w7_ledger"'))).toBe(true)

      const alterStmts = panelCore.buildPanelMigrationSql(
        {
          tableName: 'W7_Ledger',
          originalTableName: 'W7_Ledger',
          schema: 'w7_r1_aux',
          columns: [
            {
              id: 'c1',
              status: 'existing',
              originalName: 'id',
              name: 'id',
              originalDataType: 'INTEGER',
              dataType: 'INTEGER',
              originalNullable: false,
              nullable: false,
              originalDefaultValue: '',
              defaultValue: '',
              isPrimaryKey: true,
              originalIsPrimaryKey: true,
            },
            {
              id: 'c2',
              status: 'existing',
              originalName: 'val',
              name: 'val',
              originalDataType: 'INTEGER',
              dataType: 'INTEGER',
              originalNullable: true,
              nullable: true,
              originalDefaultValue: '',
              defaultValue: '',
              isPrimaryKey: false,
              originalIsPrimaryKey: false,
            },
          ],
          indexes: [
            {
              id: 'i_old',
              status: 'deleted',
              originalName: 'idx_w7_old',
              name: 'idx_w7_old',
              columns: ['val'],
              unique: false,
              isPrimary: false,
            },
            {
              id: 'i_new',
              status: 'new',
              name: 'idx_w7_new',
              columns: ['val'],
              unique: false,
              isPrimary: false,
            },
          ],
          foreignKeys: [],
        },
        'sqlite'
      )
      expect(alterStmts).toContain('DROP INDEX "w7_r1_aux"."idx_w7_old";')
      expect(alterStmts).toContain('CREATE INDEX "w7_r1_aux"."idx_w7_new" ON "W7_Ledger" ("val");')

      const sqliteMod = (await import('node:sqlite').catch(() => null)) as {
        DatabaseSync?: new (p: string) => {
          exec: (sql: string) => void
          prepare: (sql: string) => { all: () => Array<{ name: string }> }
          close: () => void
        }
      } | null
      if (sqliteMod?.DatabaseSync) {
        const db = new sqliteMod.DatabaseSync(':memory:')
        try {
          db.exec('ATTACH DATABASE ":memory:" AS w7_r1_aux;')
          db.exec('CREATE TABLE main."Main_Ledger" (id INTEGER PRIMARY KEY, val INTEGER);')
          db.exec('CREATE INDEX main."idx_w7_old" ON "Main_Ledger" ("val");')
          db.exec('CREATE TABLE w7_r1_aux."W7_Ledger" (id INTEGER PRIMARY KEY, val INTEGER);')
          db.exec('CREATE INDEX w7_r1_aux."idx_w7_old" ON "W7_Ledger" ("val");')
          db.exec(alterStmts.join('\n'))
          const mainIdx = db.prepare("SELECT name FROM main.sqlite_master WHERE type='index'").all().map((r) => r.name)
          const auxIdx = db.prepare("SELECT name FROM w7_r1_aux.sqlite_master WHERE type='index'").all().map((r) => r.name)
          expect(mainIdx).toContain('idx_w7_old')
          expect(auxIdx).not.toContain('idx_w7_old')
          expect(auxIdx).toContain('idx_w7_new')
        } finally {
          db.close()
        }
      }
    })

    it('R4 Bug 1: delegates client storage scrubbers to shared findCredentialAuthorityAtIndex and preserves escaped \\" quotes', () => {
      const scrubPanelUrl = (
        panelCore as unknown as { scrubClientUrlCredentials: (raw: unknown) => string }
      ).scrubClientUrlCredentials

      const cases = [
        {
          input: 'https://ch.internal:8443?notify=ops@corp.io',
          expected: 'https://ch.internal:8443?notify=ops@corp.io',
        },
        {
          input: 'https://edge-gw:9443?q=a@charlie.dev',
          expected: 'https://edge-gw:9443?q=a@charlie.dev',
        },
        {
          input: 'https://ch.internal:8443/v1?notify=ops@corp.io#top',
          expected: 'https://ch.internal:8443/v1?notify=ops@corp.io#top',
        },
        {
          input: 'https://edge-gw:9443/v1?q=a@charlie.dev/extra',
          expected: 'https://edge-gw:9443/v1?q=a@charlie.dev/extra',
        },
        {
          input: 'mongodb://svc:443#h=1@rs1:27017,rs2:27017/w7_r3_db',
          expected: 'mongodb://svc@rs1:27017,rs2:27017/w7_r3_db',
        },
        {
          input: 'https://ops:1234#tag=1@ch.internal/db',
          expected: 'https://ops@ch.internal/db',
        },
        {
          input: 'https://ops:1234#tag=1@ch.internal',
          expected: 'https://ops:1234#tag=1@ch.internal',
        },
        {
          input: '{"err":"https://u:ChSec9@edge-gw:8443/db?token=ChTok9\\""}',
          expected: '{"err":"https://u@edge-gw:8443/db?token=[REDACTED]\\""}',
        },
      ]

      for (const tc of cases) {
        expect(scrubPanelUrl(tc.input)).toBe(tc.expected)
        expect(scrubSensitiveStringForLocalStorage(tc.input)).toBe(tc.expected)
      }
    })

    it("R4 Bug 3: Studio ORACLE_PLSQL_LANG highlights NQ'[...]', q'[... ] ...]', and multiline q'[...]' cleanly", () => {
      const oracleExt = buildLanguageExtension('oracle')
      const oracleLang = oracleExt as unknown as {
        language: {
          parser: {
            parse: (doc: string) => {
              iterate: (opts: { enter: (n: { name: string; from: number; to: number }) => void }) => void
            }
          }
        }
      }
      for (const doc of [
        "SELECT NQ'[it's ; nq]' FROM dual",
        "SELECT q'[it's ] ; b]' FROM dual",
        "SELECT q'[line1 ;\nline2]' FROM dual",
      ]) {
        const state = EditorState.create({ doc, extensions: [oracleExt] })
        expect(state.doc.toString()).toBe(doc)
        const tree = oracleLang.language.parser.parse(doc)
        const tokens: Array<{ name: string; text: string }> = []
        tree.iterate({
          enter: (n) => {
            tokens.push({ name: n.name, text: doc.slice(n.from, n.to) })
          },
        })
        const fromTok = tokens.find((t) => t.text === 'FROM')
        const dualTok = tokens.find((t) => t.text === 'dual')
        expect(fromTok?.name.toLowerCase()).not.toContain('string')
        expect(dualTok?.name.toLowerCase()).not.toContain('string')
        expect(tokens.some((t) => t.name.toLowerCase().includes('string'))).toBe(true)
      }
    })
  })

  describe('Slice 13: Wave 8 fixes (scrubSensitiveText unification & Modal/CreateTable A11y)', () => {
    it('unifies panel-core and document-meta localStorage scrubbers via scrubSensitiveText', () => {
      const scrubPanelUrl = (
        panelCore as unknown as { scrubClientUrlCredentials: (raw: unknown) => string }
      ).scrubClientUrlCredentials

      const cases = [
        {
          input: 'mongodb://[::1]:27017/db?email=a@b.io',
          expected: 'mongodb://[::1]:27017/db?email=a@b.io',
        },
        {
          input: 'mongodb://u:p?1@[::1]:27017/db?authSource=admin',
          expected: 'mongodb://u@[::1]:27017/db?authSource=admin',
        },
        {
          input: 'mongodb://svc:8080?x=1@mongo-primary?authSource=admin',
          expected: 'mongodb://svc@mongo-primary?authSource=admin',
        },
        {
          input: 'postgres://svc:5432#k=1@pgnode?sslmode=require',
          expected: 'postgres://svc@pgnode?sslmode=require',
        },
        {
          input: '{"opts":"Pwd=\\"Sec8\\""}',
          expected: '{"opts":"Pwd=[REDACTED]"}',
        },
        {
          input: 'https://edge-gw:9443/v1?Authorization=Bearer Tok88',
          expected: 'https://edge-gw:9443/v1?Authorization=[REDACTED]',
        },
        {
          input: 'http:\\\\\\/\\\\\\/u:Sec8@127.0.0.1:8123\\\\\\/db',
          expected: 'http:\\\\\\/\\\\\\/u@127.0.0.1:8123\\\\\\/db',
        },
        {
          input: 'http:\\\\\\\\\\/\\\\\\\\\\/u:Sec8@127.0.0.1:8123\\\\\\\\\\/db',
          expected: 'http:\\\\\\\\\\/\\\\\\\\\\/u@127.0.0.1:8123\\\\\\\\\\/db',
        },
        {
          input: 'https://ch.internal:8443/v1?notify=ops@corp.io#top',
          expected: 'https://ch.internal:8443/v1?notify=ops@corp.io#top',
        },
      ]

      for (const tc of cases) {
        expect(scrubPanelUrl(tc.input)).toBe(tc.expected)
        expect(scrubSensitiveStringForLocalStorage(tc.input)).toBe(tc.expected)
      }
    })

    it('R4 Bug 3: sets aria-labelledby/aria-label on Studio & SchemaInspector modals and labels Panel Create Table row controls', () => {
      const makeMockNode = (tag: string) => {
        const attrs = new Map<string, string>()
        const children: ReturnType<typeof makeMockNode>[] = []
        const node = {
          tagName: tag.toUpperCase(),
          className: '',
          textContent: '',
          id: '',
          style: {} as Record<string, string>,
          children,
          setAttribute(k: string, v: string) {
            attrs.set(k, v)
            if (k === 'id') node.id = v
          },
          getAttribute(k: string) {
            return attrs.get(k) ?? null
          },
          hasAttribute(k: string) {
            return attrs.has(k)
          },
          appendChild(child: ReturnType<typeof makeMockNode>) {
            children.push(child)
            return child
          },
          addEventListener() {},
          focus() {},
          remove() {},
          querySelector(selector: string) {
            const parts = selector.split(',').map((s) => s.trim())
            const matches = (el: ReturnType<typeof makeMockNode>): boolean => {
              const clsList = el.className.split(/\s+/).filter(Boolean)
              return parts.some((sel) => {
                if (sel.startsWith('.')) return clsList.includes(sel.slice(1))
                if (sel === '[role="heading"]') return el.getAttribute('role') === 'heading'
                if (sel.includes(' ')) {
                  const [pCls, cTag] = sel.split(/\s+/)
                  return el.tagName.toLowerCase() === cTag && clsList.includes(pCls.slice(1))
                }
                return el.tagName.toLowerCase() === sel.toLowerCase()
              })
            }
            const walk = (root: ReturnType<typeof makeMockNode>): ReturnType<typeof makeMockNode> | null => {
              for (const child of root.children) {
                if (matches(child)) return child
                const nested = walk(child)
                if (nested) return nested
              }
              return null
            }
            return walk(node)
          },
        }
        return node
      }

      const prevDoc = (globalThis as Record<string, unknown>).document
      const prevWin = (globalThis as Record<string, unknown>).window
      const bodyNode = makeMockNode('body')
      ;(globalThis as Record<string, unknown>).document = {
        body: bodyNode,
        createElement: (tag: string) => makeMockNode(tag),
        querySelector: () => null,
      }
      ;(globalThis as Record<string, unknown>).window = {}

      try {
        // 1. mountStudioModal with heading -> aria-labelledby
        const editorProto = DatanoaStudioEditor.prototype as unknown as {
          mountStudioModal: (modalEl: unknown) => ReturnType<typeof makeMockNode> | null
        }
        const fakeEditor = {
          activeModalBackdrop: null,
          activeModalKeyCleanup: null,
          closeActiveModal() {},
        }
        const titledModal = makeMockNode('div')
        const titleSpan = makeMockNode('span')
        titleSpan.className = 'datanoa-modal-title'
        titleSpan.textContent = 'Danger Check'
        titledModal.appendChild(titleSpan)
        const titledBackdrop = editorProto.mountStudioModal.call(fakeEditor, titledModal)
        expect(titledBackdrop?.getAttribute('role')).toBe('dialog')
        expect(titledBackdrop?.getAttribute('aria-modal')).toBe('true')
        expect(titleSpan.id.length).toBeGreaterThan(0)
        expect(titledBackdrop?.getAttribute('aria-labelledby')).toBe(titleSpan.id)

        // 2. mountStudioModal without heading -> fallback aria-label="Dialog"
        const plainModal = makeMockNode('div')
        const plainBackdrop = editorProto.mountStudioModal.call(fakeEditor, plainModal)
        expect(plainBackdrop?.getAttribute('aria-label')).toBe('Dialog')

        // 3. SchemaInspectorView.openMigrationConfirmModal -> role="alertdialog" + aria-labelledby
        const inspectorProto = SchemaInspectorView.prototype as unknown as {
          openMigrationConfirmModal: () => void
        }
        const fakeInspector = {
          draft: {
            tableName: 'orders_v2',
            originalTableName: 'orders',
            columns: [
              {
                id: 'c1',
                status: 'existing',
                originalName: 'id',
                name: 'id',
                originalDataType: 'INTEGER',
                dataType: 'INTEGER',
                originalNullable: false,
                nullable: false,
                originalDefaultValue: '',
                defaultValue: '',
                isPrimaryKey: true,
                originalIsPrimaryKey: true,
              },
            ],
            indexes: [],
            foreignKeys: [],
          },
          isMigrating: false,
          currentDialect: 'sqlite',
          container: makeMockNode('div'),
          confirmModalBackdrop: null as ReturnType<typeof makeMockNode> | null,
          confirmEscHandler: null,
          closeConfirmModal() {},
          computeValidatedPlan: () => ({
            valid: true,
            errors: [],
            warnings: [],
            changeSummaries: ['Rename table'],
            statements: ['ALTER TABLE "orders" RENAME TO "orders_v2";'],
            isSqliteRebuild: false,
          }),
        }
        inspectorProto.openMigrationConfirmModal.call(fakeInspector)
        const confirmBackdrop = fakeInspector.confirmModalBackdrop
        expect(confirmBackdrop?.getAttribute('role')).toBe('alertdialog')
        expect(confirmBackdrop?.getAttribute('aria-modal')).toBe('true')
        const labelledId = confirmBackdrop?.getAttribute('aria-labelledby') ?? ''
        expect(labelledId.length).toBeGreaterThan(0)
        const headEl = confirmBackdrop?.querySelector('.datanoa-modal-head')
        expect(headEl?.children[0]?.id).toBe(labelledId)

        // 4. Panel Create Table row A11y label contract
        const getLabels = (
          panelCore as unknown as {
            getPanelCreateTableRowAriaLabels: (idx: number) => Record<string, string>
          }
        ).getPanelCreateTableRowAriaLabels
        expect(typeof getLabels).toBe('function')
        expect(getLabels(0)).toEqual({
          name: 'Column 1 name',
          type: 'Column 1 type',
          typeToggle: 'Choose type for column 1',
          primaryKey: 'Column 1 primary key',
          nullable: 'Column 1 nullable',
          defaultValue: 'Column 1 default value',
          remove: 'Remove column 1',
        })
      } finally {
        ;(globalThis as Record<string, unknown>).document = prevDoc
        ;(globalThis as Record<string, unknown>).window = prevWin
      }
    })
  })
})
