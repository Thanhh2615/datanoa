import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { installDomHarness } from './helpers/dom-harness'
import {
  buildCreateObjectCommand,
  buildCreateTableSql,
  buildDdlFallback,
  buildGithubIssueUrl,
  buildInitialCreateTableDraftColumns,
  buildPanelExportData,
  buildPanelFeedbackMarkdown,
  buildPanelMigrationSql,
  buildSelectPreviewQuery,
  buildTruncateOrDropSql,
  coerceTypedCellInput,
  compactPathLabel,
  computeInitialColumnWidths,
  computeVirtualRange,
  countPanelStructChanges,
  createPanelStructDraft,
  formatAggNum,
  formatDdlForDisplay,
  formatPanelSql,
  formatRelativeTime,
  formatSelectionAsOutput,
  formatSqlLiteral,
  getActiveIndexColNames,
  getFkColName,
  getIndexColNames,
  getPanelCreateTableRowAriaLabels,
  isBooleanSqlType,
  isEmptyAsNullNonTextSqlType,
  isNumericSqlType,
  normalizeCellRange,
  resolvePanelFormDriver,
  sanitizeFeedbackError,
  sanitizeJson,
  scanQuotedEnd,
  skipSqlToken,
  srgbLin,
  stripLeadingSqlComments,
  subtractCellFromRange,
  subtractColFromRange,
  subtractRowFromRange,
  validatePanelStructDraft,
} from '../src/panel/panel-core.js'

describe('Wave 3A Step 1 & 2: Shared DOM Harness + panel-core.js Full Branch Coverage & PBT', () => {
  it('validates shared DOM/HTML harness against real src/panel/panel.html without leaking globals', () => {
    const hadWindowBefore = 'window' in globalThis
    const dom = installDomHarness()
    try {
      dom.mountPanelHtml()
      expect(dom.body.children.length).toBeGreaterThan(0)
      expect(dom.document.querySelector('#tab-explorer') ?? dom.body.querySelector('[data-tab]')).not.toBeNull()

      // HTML parser: comments, SVG self-closing, void tags, quoted/unquoted attrs & entities
      const box = dom.document.createElement('div')
      box.innerHTML =
        '<!-- c --><svg viewBox="0 0 10 10"><path d="M0 0"/></svg><input id=inp-1 type="checkbox" checked disabled data-foo-bar="a&amp;b"><span>&lt;hi&gt;</span>'
      expect(box.outerHTML).toContain('viewBox="0 0 10 10"')
      const inp = box.querySelector('#inp-1[type="checkbox"]:checked:disabled')
      expect(inp).not.toBeNull()
      expect(inp?.dataset.fooBar).toBe('a&b')
      expect(box.querySelector('input:not(:disabled)')).toBeNull()
      expect(box.querySelector('span:last-child')?.textContent).toBe('<hi>')

      // Events: capture, target, bubble, stopPropagation + KeyboardEvent helper
      const trail: string[] = []
      box.addEventListener('keydown', () => trail.push('cap'), { capture: true })
      inp?.addEventListener('keydown', (ev) => {
        trail.push('target')
        ev.preventDefault()
      })
      dom.window.addEventListener('keydown', () => trail.push('win-bub'))
      dom.body.appendChild(box)
      const notCancelled = dom.fireKey(inp!, 'Enter', { ctrlKey: true })
      expect(notCancelled).toBe(false)
      expect(trail).toEqual(['cap', 'target', 'win-bub'])

      // Style & URL shims
      box.style.backgroundColor = 'red'
      expect(box.getAttribute('style')).toContain('background-color: red')
      const objUrl = URL.createObjectURL(new Blob(['ok']))
      expect(dom.createdObjectUrls).toEqual([objUrl])
      URL.revokeObjectURL(objUrl)
      expect(dom.revokedObjectUrls).toEqual([objUrl])
    } finally {
      dom.teardown()
    }
    expect('window' in globalThis).toBe(hadWindowBefore)
  })

  it('covers formatters, JSON sanitizer, SQL quoting/DDL formatters, range algebra PBT, and typed coercion', () => {
    // sanitizeJson edge cases
    const cyc: Record<string, unknown> = { a: [1, () => {}, Symbol('s')], fn: () => 2 }
    cyc.self = cyc
    expect(sanitizeJson(cyc)).toEqual({ a: [1, null, null], self: null })
    expect(sanitizeJson(undefined)).toBeNull()
    expect(sanitizeJson(42n)).toBe('42')

    // srgbLin, formatAggNum, formatRelativeTime, compactPathLabel
    expect(srgbLin(10)).toBeGreaterThan(0)
    expect(srgbLin(200)).toBeGreaterThan(0.5)
    expect(formatAggNum('bad')).toBe('0')
    expect(formatAggNum(12)).toBe('12')
    expect(formatAggNum(1.23456)).toBe('1.2346')

    const now = 1_700_000_000_000
    expect(formatRelativeTime('x', now)).toBe('')
    expect(formatRelativeTime(0, now)).toBe('')
    expect(formatRelativeTime(now - 5_000, now)).toBe('just now')
    expect(formatRelativeTime(now - 30_000, now)).toBe('30s ago')
    expect(formatRelativeTime(now - 10 * 60_000, now)).toBe('10m ago')
    expect(formatRelativeTime(now - 5 * 3_600_000, now)).toBe('5h ago')
    expect(formatRelativeTime(now - 3 * 86_400_000, now)).toBe('3d ago')

    expect(compactPathLabel('a\\b\\c')).toBe('a/b/c')
    expect(compactPathLabel('/u/local/share/app/db/main.sqlite')).toBe('.../share/app/db/main.sqlite')

    // scanQuotedEnd, stripLeadingSqlComments, formatSqlLiteral, formatPanelSql
    expect(scanQuotedEnd("'it''s';", 0, "'", false)).toBe(7)
    expect(stripLeadingSqlComments('-- hi\n/* c */\nSELECT 1;', 'postgres')).toBe('SELECT 1;')
    expect(formatSqlLiteral("o'hara", 'postgres')).toBe("'o''hara'")
    expect(formatPanelSql('KEYS *', 'redis')).toBe('KEYS *')

    // skipSqlToken & formatDdlForDisplay
    expect(skipSqlToken('-- comment\nSELECT', 0)).toBe(10)
    expect(skipSqlToken('/* c */ x', 0)).toBe(7)
    expect(skipSqlToken('/* unclosed', 0)).toBe(11)
    expect(skipSqlToken("'a\\'b''c' x", 0)).toBe(9)
    expect(skipSqlToken("'unclosed", 0)).toBe(9)
    expect(skipSqlToken('SELECT', 0)).toBe(-1)

    expect(formatDdlForDisplay('')).toBe('')
    expect(formatDdlForDisplay('CREATE VIEW v AS SELECT 1;')).toBe('CREATE VIEW v AS SELECT 1;')
    expect(formatDdlForDisplay('CREATE TABLE broken (id INT')).toBe('CREATE TABLE broken (id INT')
    expect(formatDdlForDisplay('CREATE TABLE empty_t ();')).toBe('CREATE TABLE empty_t ();')
    expect(formatDdlForDisplay('CREATE TABLE t (\n  id INT\n);')).toBe('CREATE TABLE t (\n  id INT\n);')
    expect(formatDdlForDisplay('CREATE TABLE t (id INT, note TEXT DEFAULT \'a,b\', FOREIGN KEY (id) REFERENCES p(id));')).toContain(
      ',\n  FOREIGN KEY (id) REFERENCES p(id)'
    )

    // buildDdlFallback
    expect(buildDdlFallback({ name: 'empty_tbl', columns: [] }, 'sqlite')).toBe('CREATE TABLE "empty_tbl" ();')
    const ddlFb = buildDdlFallback(
      {
        name: 'items',
        schema: 'public',
        columns: [
          { name: 'id', type: 'int', nativeType: 'INTEGER', nullable: false, isPrimaryKey: true, defaultValue: null },
          { name: 'note', type: 'text', nullable: true, defaultValue: "'n/a'" },
        ],
        foreignKeys: [{ column: 'id', referencedTable: 'orgs', referencedColumn: 'id' }],
      },
      'postgres'
    )
    expect(ddlFb).toContain('PRIMARY KEY ("id")')
    expect(ddlFb).toContain('FOREIGN KEY ("id") REFERENCES "orgs" ("id")')

    // Range algebra PBT
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 0, max: 25 }),
        fc.integer({ min: 0, max: 25 }),
        (a, b, c, d, r, col) => {
          const norm = normalizeCellRange(a, b, c, d)
          expect(norm.r1).toBeLessThanOrEqual(norm.r2)
          expect(norm.c1).toBeLessThanOrEqual(norm.c2)
          const subCell = subtractCellFromRange(norm, r, col)
          const subRow = subtractRowFromRange(norm, r)
          const subCol = subtractColFromRange(norm, col)
          const origCount = (norm.r2 - norm.r1 + 1) * (norm.c2 - norm.c1 + 1)
          const cellArea = subCell.reduce((acc, x) => acc + (x.r2 - x.r1 + 1) * (x.c2 - x.c1 + 1), 0)
          const insideCell = r >= norm.r1 && r <= norm.r2 && col >= norm.c1 && col <= norm.c2
          expect(cellArea).toBe(insideCell ? origCount - 1 : origCount)
          const rowArea = subRow.reduce((acc, x) => acc + (x.r2 - x.r1 + 1) * (x.c2 - x.c1 + 1), 0)
          const insideRow = r >= norm.r1 && r <= norm.r2
          expect(rowArea).toBe(insideRow ? origCount - (norm.c2 - norm.c1 + 1) : origCount)
          const colArea = subCol.reduce((acc, x) => acc + (x.r2 - x.r1 + 1) * (x.c2 - x.c1 + 1), 0)
          const insideCol = col >= norm.c1 && col <= norm.c2
          expect(colArea).toBe(insideCol ? origCount - (norm.r2 - norm.r1 + 1) : origCount)
        }
      ),
      { numRuns: 40 }
    )

    // Type predicates + coerceTypedCellInput
    expect(isNumericSqlType('BIGINT')).toBe(true)
    expect(isNumericSqlType('VARCHAR')).toBe(false)
    expect(isBooleanSqlType('BOOLEAN')).toBe(true)
    expect(isEmptyAsNullNonTextSqlType('UUID')).toBe(true)
    expect(coerceTypedCellInput('', null, 'INT')).toBeNull()
    expect(coerceTypedCellInput('NULL', 'x', 'TEXT', true, { allowNullKeyword: true })).toBeNull()
    expect(coerceTypedCellInput('NULL', 'x', 'TEXT', false, { allowNullKeyword: true })).toBe('NULL')
    expect(coerceTypedCellInput('TRUE', null, 'BOOLEAN')).toBe(true)
    expect(coerceTypedCellInput('false', null, 'BOOL')).toBe(false)
    expect(coerceTypedCellInput('42', null, 'INT')).toBe(42)
    expect(coerceTypedCellInput('9007199254740999', null, 'BIGINT')).toBe('9007199254740999')
    expect(coerceTypedCellInput('1.25', null, 'DECIMAL')).toBe(1.25)
    expect(coerceTypedCellInput('1.1234567890123456', null, 'DECIMAL')).toBe('1.1234567890123456')
    expect(coerceTypedCellInput('abc', 'raw', 'TEXT')).toBe('abc')

    // computeInitialColumnWidths & computeVirtualRange
    const widths = computeInitialColumnWidths(
      [{ name: 'id', isPrimaryKey: true }, { name: 'meta' }],
      [{ data: { id: 1, meta: { ok: 'long-value-here' } } }, { data: { id: null, meta: undefined } }]
    )
    expect(widths).toHaveLength(2)
    expect(computeVirtualRange(0, 400, 0)).toEqual({ start: 0, end: 0 })
    expect(computeVirtualRange(260, 0, 50)).toEqual({ start: 0, end: 37 })
  })

  it('covers buildPanelExportData, formatSelectionAsOutput, CREATE/TRUNCATE/DROP & feedback URL builders', () => {
    expect(buildPanelExportData({ columns: [], rows: [], format: 'csv' })).toBe('')
    const cols = [{ name: 'id' }, { name: 'id' }, { name: 'payload' }]
    const objRows = [
      { id: 1, payload: { a: '1,2' } },
      { id: 2, payload: null },
    ]
    expect(buildPanelExportData({ columns: cols, rows: [[1, 10, 'a\nb'], [2, 20, null]], format: 'sql-insert', tableName: 't', schema: 's', driver: 'postgres' })).toContain('INSERT INTO')
    expect(
      buildPanelExportData({
        columns: ['id'],
        rows: [[1], [null]],
        format: 'sql-update',
        tableName: 't',
        driver: 'sqlite',
        primaryKeys: ['id', 'ghost'],
      })
    ).toContain('WHERE "id" IS NULL AND "ghost" IS NULL;')
    expect(
      buildPanelExportData({
        columns: ['id', 'name'],
        rows: [{ id: 1, name: 'A' }],
        format: 'sql-update',
        driver: 'postgres',
      })
    ).toContain('SET "name" = \'A\' WHERE "id" = 1;')
    expect(JSON.parse(buildPanelExportData({ columns: cols, rows: objRows, format: 'json' }))[0].id_2).toBe(undefined === objRows[0].id ? null : 1)
    expect(buildPanelExportData({ columns: cols, rows: [[1, undefined, 'z']], format: 'ndjson' })).toContain('"id_2":null')
    expect(buildPanelExportData({ columns: cols, rows: objRows, format: 'csv' })).toContain('"{""a"":""1,2""}"')
    expect(buildPanelExportData({ columns: cols, rows: objRows, format: 'markdown' })).toContain('| NULL |')
    expect(buildPanelExportData({ columns: cols, rows: objRows, format: 'unknown' })).toBe('')

    // formatSelectionAsOutput
    expect(formatSelectionAsOutput(cols, [], [], 'csv', true)).toBe('')
    expect(
      formatSelectionAsOutput(['id', 'name'], [{ id: 1, name: 'x\ty' }, { id: null, name: null }], [{ r: 0, c: 0 }, { r: 1, c: 0 }, { r: 5, c: 0 }], 'sql-in', false, 't', '', 'postgres')
    ).toBe('("id" IN (1) OR "id" IS NULL)')
    expect(
      formatSelectionAsOutput(['id'], [[1], [2]], [{ r: 0, c: 0 }, { r: 1, c: 0 }], 'sql-in', false, 't', '', 'postgres')
    ).toBe('"id" IN (1, 2)')
    expect(
      formatSelectionAsOutput(['id'], [[null]], [{ r: 0, c: 0 }], 'sql-in', false, 't', '', 'postgres')
    ).toBe('"id" IS NULL')
    expect(
      formatSelectionAsOutput(['id'], [['ok']], [{ r: 0, c: 0 }], 'sql-in', false, 't', '', 'postgres')
    ).toBe('"id" IN (\'ok\')')
    expect(
      formatSelectionAsOutput(['a', 'b'], [[1, 2], [null, 3]], [{ r: 0, c: 0 }, { r: 1, c: 1 }, { r: 1, c: 0 }], 'sql-in', false, 't', '', 'postgres')
    ).toBe('(1, 3)')
    expect(
      formatSelectionAsOutput(['a', 'b'], [[null, null]], [{ r: 0, c: 0 }, { r: 0, c: 1 }], 'sql-in', false, 't', '', 'postgres')
    ).toBe('(NULL)')
    expect(
      formatSelectionAsOutput(['a', 'b'], [[1, 'v']], [{ r: 0, c: 0 }, { r: 0, c: 1 }], 'sql-in', false, 't', '', 'postgres')
    ).toBe('(1, \'v\')')
    expect(
      formatSelectionAsOutput(['a', 'b'], [[undefined, undefined]], [{ r: 0, c: 9 }], 'sql-in', false, 't', '', 'postgres')
    ).toBe('')
    expect(formatSelectionAsOutput(['a'], [['raw\ttext']], [{ r: 0, c: 0 }], 'tsv', false)).toBe('raw\ttext')
    expect(formatSelectionAsOutput(['a', 'b'], [[{ x: 1 }, 'b'], [2, 'c']], [{ r: 0, c: 0 }, { r: 1, c: 1 }], 'tsv', true)).toContain(
      'a\tb\n"{""x"":1}"\t\n\tc'
    )
    expect(formatSelectionAsOutput(['a'], [[1]], [{ r: 0, c: 0 }], 'json', true, 'u', 'main', 'sqlite')).toContain('"a": 1')

    // CREATE / TRUNCATE / DROP
    expect(() => buildCreateTableSql('t', [{ name: 'a', dataType: 'INT' }], 'redis')).toThrow()
    expect(() => buildCreateTableSql('', [{ name: 'a', dataType: 'INT' }], 'postgres')).toThrow()
    expect(() => buildCreateTableSql('bad;name', [{ name: 'a', dataType: 'INT' }], 'postgres')).toThrow()
    expect(() => buildCreateTableSql('t', [], 'postgres')).toThrow()
    expect(() => buildCreateTableSql('t', [{ name: '', dataType: 'INT' }], 'postgres')).toThrow()
    expect(() => buildCreateTableSql('t', [{ name: 'bad;col', dataType: 'INT' }], 'postgres')).toThrow()
    expect(() => buildCreateTableSql('t', [{ name: 'a', dataType: 'INT' }, { name: 'A', dataType: 'INT' }], 'postgres')).toThrow()

    expect(
      buildCreateTableSql(
        'events',
        [
          { name: 'id', dataType: 'INT', isPrimaryKey: true, nullable: false, defaultValue: '1' },
          { name: 'sub', dataType: 'INT', isPrimaryKey: true, nullable: false },
          { name: 'note', dataType: 'VARCHAR2(20)', nullable: false, defaultValue: 'hi' },
        ],
        'oracle',
        'HR'
      )
    ).toContain("DEFAULT 'hi' NOT NULL")
    expect(
      buildCreateTableSql(
        'ch_ev',
        [
          { name: 'id', dataType: 'UInt64', isPrimaryKey: true },
          { name: 'v', dataType: 'String', nullable: true },
        ],
        'clickhouse',
        'analytics'
      )
    ).toContain('ORDER BY (`id`)')
    expect(buildCreateTableSql('ch_np', [{ name: 'v', dataType: 'String', nullable: true }], 'clickhouse')).toContain('ORDER BY tuple()')
    expect(() => buildCreateObjectCommand('', [], 'mongodb')).toThrow()
    expect(() => buildCreateObjectCommand('bad;col', [], 'mongodb')).toThrow()
    expect(buildCreateObjectCommand('logs', [], 'mongodb')).toBe('db.createCollection("logs");')
    expect(buildCreateObjectCommand('t', [{ name: 'id', dataType: 'INTEGER', isPrimaryKey: true }], 'sqlite', 'main')).toContain('CREATE TABLE "t"')

    expect(() => buildTruncateOrDropSql('drop', { name: '' }, 'mongodb')).toThrow()
    expect(buildTruncateOrDropSql('truncate', { name: 'logs' }, 'mongodb')).toBe('db.getCollection("logs").deleteMany({});')
    expect(buildTruncateOrDropSql('drop', { name: 'logs' }, 'mongodb')).toBe('db.getCollection("logs").drop();')
    expect(buildTruncateOrDropSql('truncate', { name: 'u', schema: 'main' }, 'd1')).toBe('DELETE FROM "u";')
    expect(buildTruncateOrDropSql('truncate', { name: 'u', schema: 'public' }, 'postgres')).toBe('TRUNCATE TABLE "public"."u";')
    expect(buildTruncateOrDropSql('drop', { name: 'v_u', kind: 'view' }, 'postgres')).toBe('DROP VIEW "v_u";')
    expect(buildTruncateOrDropSql('drop', { name: 'u', kind: 'table' }, 'postgres')).toBe('DROP TABLE "u";')

    // Feedback builders & preview queries
    expect(sanitizeFeedbackError('Error pg://u:sec@host/db')).not.toContain('sec')
    const mdBug = buildPanelFeedbackMarkdown({
      kind: 'bug',
      title: 'Crash',
      description: 'Details',
      driver: 'postgres',
      tab: 'sql',
      readOnly: true,
      orcaApi: 'v2',
      platform: 'win32',
      lastError: 'fail',
    })
    expect(mdBug).toContain('## Bug Report: Crash')
    expect(mdBug).toContain('Postgres (postgres)')
    expect(mdBug).toContain('### Last Sanitized Error')
    const mdFeat = buildPanelFeedbackMarkdown({ kind: 'feature', driver: 'custom_engine' })
    expect(mdFeat).toContain('### Proposal / Use Case')
    expect(mdFeat).toContain('custom_engine')
    const mdAnon = buildPanelFeedbackMarkdown({})
    expect(mdAnon).toContain('**Active Engine:** None')

    const urlLong = buildGithubIssueUrl({ kind: 'feature', title: 'New AI', markdownBody: 'x'.repeat(3600) })
    expect(urlLong).toContain('template=feature_request.yml')
    expect(decodeURIComponent(urlLong)).toContain('...(truncated')
    expect(buildGithubIssueUrl({ kind: 'bug', title: '[Bug]: Already', markdownBody: '' })).toContain('Already')
    expect(buildGithubIssueUrl({})).toContain('%5BBug%5D%3A')

    expect(buildSelectPreviewQuery('redis', '(root)')).toBe('SCAN 0 MATCH * COUNT 50')
    expect(buildSelectPreviewQuery('redis', 'sess:*')).toBe('SCAN 0 MATCH sess:* COUNT 50')
    expect(buildSelectPreviewQuery('mongodb', 'users', '', '{"active":true}')).toContain('.find({"active":true})')
    expect(buildSelectPreviewQuery('mongodb', 'users', '', 'ignored')).toContain('.find({})')
    expect(buildSelectPreviewQuery('mssql', 'users', 'dbo', 'id > 1')).toBe('SELECT TOP 100 * FROM [dbo].[users] WHERE id > 1;')
    expect(buildSelectPreviewQuery('mssql', 'users', 'dbo')).toBe('SELECT TOP 100 * FROM [dbo].[users];')
    expect(buildSelectPreviewQuery('oracle', 'EMP', 'HR', 'ID = 1')).toBe('SELECT * FROM "HR"."EMP" WHERE ID = 1 FETCH FIRST 100 ROWS ONLY;')
    expect(buildSelectPreviewQuery('oracle', 'EMP', 'HR')).toBe('SELECT * FROM "HR"."EMP" FETCH FIRST 100 ROWS ONLY;')
    expect(buildSelectPreviewQuery('postgres', 'users', 'public', 'id > 0')).toBe('SELECT * FROM "public"."users" WHERE id > 0 LIMIT 100;')
    expect(buildSelectPreviewQuery(undefined, 'users', 'main')).toBe('SELECT * FROM "users" LIMIT 100;')
  })

  it('covers full panel-core migration & validation paths (SQLite rebuild, D1, triggers, PG/MySQL/MSSQL/Oracle/ClickHouse ALTER)', () => {
    // Index/FK ref helpers
    expect(getIndexColNames(null, null)).toEqual([])
    expect(getActiveIndexColNames(null, null)).toEqual([])
    expect(getFkColName(null, null)).toBe('')

    const richDraft = createPanelStructDraft(
      {
        name: 'orders',
        schema: 'main',
        columns: [
          { name: 'id', type: 'INTEGER', nullable: false, isPrimaryKey: true, isAutoIncrement: true, defaultValue: null },
          { name: 'email', type: 'TEXT', nullable: true, defaultValue: null },
          { name: 'qty', type: 'INTEGER', nullable: false, defaultValue: '0' },
        ],
        indexes: [
          { name: 'idx_orders_email', columns: ['email'], unique: true },
        ],
        foreignKeys: [
          { constraintName: 'fk_orders_user', column: 'id', referencedTable: 'users', referencedColumn: 'id', onDelete: 'CASCADE' },
        ],
        triggers: [{ name: 'trg_o', sql: 'CREATE TRIGGER trg_o AFTER INSERT ON orders BEGIN SELECT 1; END;' }],
        inboundForeignKeys: [{ fromTable: 'items', fromColumn: 'order_id', toColumn: 'id', onDelete: 'SET NULL', onUpdate: 'CASCADE' }],
      },
      'sqlite'
    )

    expect(getIndexColNames(richDraft, { columnRefs: [{ fallbackName: 'email' }] })).toEqual(['email'])
    expect(getIndexColNames(richDraft, { columns: ['qty'] })).toEqual(['qty'])
    richDraft.columns[1].status = 'deleted'
    expect(getIndexColNames(richDraft, { columnRefs: [{ colId: richDraft.columns[1].id }] })).toEqual(['email'])
    richDraft.columns[1].status = 'existing'

    expect(
      getActiveIndexColNames(richDraft, {
        columnRefs: [{ colId: richDraft.columns[0].id }, { fallbackName: 'email' }],
      })
    ).toEqual(['id', 'email'])
    expect(getActiveIndexColNames(richDraft, { columns: ['qty'] })).toEqual(['qty'])
    expect(getFkColName(richDraft, { column: 'email' })).toBe('email')

    // D1 SQLite rebuild with composite PK, unique ON CONFLICT, FK, trigger rewrite, NOT NULL COALESCE
    const d1Draft = createPanelStructDraft(
      {
        name: 'orders',
        schema: 'main',
        columns: [
          { name: 'id', type: 'INTEGER', nullable: false, isPrimaryKey: true, defaultValue: null },
          { name: 'tenant', type: 'INTEGER', nullable: false, isPrimaryKey: true, defaultValue: null },
          { name: 'code', type: 'TEXT', nullable: true, defaultValue: null },
        ],
        indexes: [
          { name: 'uq_code', columns: ['code'], unique: true, ddlKind: 'unique_constraint', onConflict: 'REPLACE' },
          { name: 'idx_code', columns: ['code'], unique: false },
        ],
        foreignKeys: [{ column: 'tenant', referencedTable: 'tenants', referencedColumn: 'id', onDelete: 'CASCADE' }],
        triggers: [{ name: 't1', sql: 'CREATE TRIGGER t1 AFTER INSERT ON main."orders" BEGIN SELECT 1; END;' }],
      },
      'd1'
    )
    d1Draft.tableName = 'orders_v2'
    d1Draft.columns[2].nullable = false
    d1Draft.columns[2].defaultValue = 'DEF'
    Object.assign(d1Draft.indexes[0], { ddlKind: 'unique_constraint', origin: 'u' })
    const d1Val = validatePanelStructDraft(d1Draft, 'd1', ['orders', 'tenants'])
    expect(d1Val.valid).toBe(true)
    expect(d1Val.warnings.some((w) => w.includes('Cloudflare D1'))).toBe(true)
    expect(d1Val.statements.join('\n')).toContain('COALESCE("code", \'DEF\')')
    expect(d1Val.statements.join('\n')).toContain('PRIMARY KEY ("id", "tenant")')
    expect(d1Val.statements.join('\n')).toContain('ON CONFLICT REPLACE')

    // Case-only rename on sqlite -> __datanoa_case_rename_tmp and _2 branch
    const caseDraft = createPanelStructDraft(
      { name: 'Users', columns: [{ name: 'id', type: 'INTEGER', nullable: false, isPrimaryKey: true }] },
      'sqlite'
    )
    caseDraft.tableName = 'users'
    expect(buildPanelMigrationSql(caseDraft, 'sqlite').join('\n')).toContain('__datanoa_case_rename_tmp')
    const caseTmpDraft = createPanelStructDraft(
      { name: '__datanoa_case_rename_tmp', columns: [{ name: 'id', type: 'INTEGER', nullable: false, isPrimaryKey: true }] },
      'sqlite'
    )
    caseTmpDraft.tableName = '__DATANOA_CASE_RENAME_TMP'
    expect(buildPanelMigrationSql(caseTmpDraft, 'sqlite').join('\n')).toContain('__datanoa_case_rename_tmp_2')

    // ALTER TABLE paths across PG, MySQL, MSSQL, Oracle, ClickHouse
    for (const driver of ['postgres', 'mysql', 'mssql', 'oracle', 'clickhouse'] as const) {
      const altDraft = createPanelStructDraft(
        {
          name: 'items',
          schema: driver === 'mssql' ? 'dbo' : driver === 'oracle' ? 'HR' : 'public',
          columns: [
            { name: 'id', type: 'INT', nullable: false, isPrimaryKey: true },
            { name: 'old_col', type: 'VARCHAR(20)', nullable: true, defaultValue: "'abc'" },
            { name: 'drop_col', type: 'INT', nullable: true },
          ],
          indexes: [{ name: 'ix_old', columns: ['old_col'] }],
          foreignKeys: [{ constraintName: 'fk_drop', column: 'drop_col', referencedTable: 'other', referencedColumn: 'id' }],
        },
        driver
      )
      altDraft.columns[2].status = 'deleted'
      altDraft.indexes[0].status = 'deleted'
      altDraft.foreignKeys[0].status = 'deleted'
      altDraft.columns[1].name = 'new_col'
      altDraft.columns[1].dataType = 'VARCHAR(40)'
      altDraft.columns[1].nullable = false
      altDraft.columns[1].defaultValue = ''
      altDraft.columns.push({
        id: 'c_new',
        status: 'new',
        name: 'added_c',
        originalName: 'added_c',
        dataType: 'INT',
        originalDataType: 'INT',
        nullable: false,
        originalNullable: false,
        defaultValue: '5',
        originalDefaultValue: '5',
        isPrimaryKey: false,
        originalIsPrimaryKey: false,
        isAutoIncrement: false,
      })
      if (driver !== 'clickhouse') {
        altDraft.columns[0].isPrimaryKey = false
      }
      altDraft.indexes.push({
        id: 'i_new',
        status: 'new',
        name: 'ix_new',
        columnRefs: [{ colId: 'c_new' }],
        unique: true,
        isPrimary: false,
      })
      if (driver !== 'clickhouse') {
        altDraft.foreignKeys.push({
          id: 'f_new',
          status: 'new',
          constraintName: '',
          columnId: 'c_new',
          column: 'added_c',
          foreignTable: 'orgs',
          foreignColumn: 'id',
          onDelete: 'CASCADE',
        })
      }
      altDraft.tableName = 'items_v2'
      const sqls = buildPanelMigrationSql(altDraft, driver)
      expect(sqls.length).toBeGreaterThan(2)
    }
    expect(() => {
      const chPk = createPanelStructDraft({ name: 't', columns: [{ name: 'id', type: 'Int32', isPrimaryKey: true }] }, 'clickhouse')
      chPk.columns[0].isPrimaryKey = false
      return buildPanelMigrationSql(chPk, 'clickhouse')
    }).toThrow(/PRIMARY KEY.*ClickHouse/i)

    // Validation errors for missing index cols, duplicate names, FK errors, ClickHouse FK
    const errDraft = createPanelStructDraft(
      {
        name: 'bad_t',
        columns: [{ id: 'c1', name: 'id', type: 'INT', nullable: false, isPrimaryKey: true }],
      },
      'clickhouse'
    )
    errDraft.columns.push({
      id: 'c_del',
      status: 'deleted',
      name: 'gone',
      originalName: 'gone',
      dataType: 'INT',
      originalDataType: 'INT',
      nullable: true,
      originalNullable: true,
      defaultValue: '',
      originalDefaultValue: '',
      isPrimaryKey: false,
      originalIsPrimaryKey: false,
      isAutoIncrement: false,
    })
    errDraft.indexes.push(
      { id: 'i1', status: 'new', name: '', columnRefs: [] },
      { id: 'i2', status: 'new', name: 'dup_i', columnRefs: [{ colId: 'c_del' }, { fallbackName: 'missing_fb' }] },
      { id: 'i3', status: 'new', name: 'dup_i', columns: ['no_such_col'] }
    )
    errDraft.foreignKeys.push({
      id: 'f1',
      status: 'new',
      columnId: 'c_del',
      column: '',
      foreignTable: 'nonexistent',
      foreignColumn: '',
      onDelete: 'NO ACTION',
    })
    const errRes = validatePanelStructDraft(errDraft, 'clickhouse', ['bad_t'])
    expect(errRes.valid).toBe(false)
    expect(errRes.errors.some((e) => e.includes('ClickHouse does not support FOREIGN KEY'))).toBe(true)
    expect(errRes.errors.some((e) => e.includes('Duplicate index name'))).toBe(true)
    expect(errRes.errors.some((e) => e.includes('references missing/dropped column'))).toBe(true)

    // Remaining panel-core helpers, trigger tokenizer, MSSQL named constraint & SQLite NOT NULL default inference
    expect(buildInitialCreateTableDraftColumns('oracle')[0].dataType).toBe('NUMBER(10)')
    expect(buildInitialCreateTableDraftColumns('mssql')[1].dataType).toBe('NVARCHAR(255)')
    expect(buildInitialCreateTableDraftColumns('sqlite')[0].dataType).toBe('INTEGER')
    expect(getPanelCreateTableRowAriaLabels(0).name).toBe('Column 1 name')
    expect(resolvePanelFormDriver('postgres')).toBe('postgres')
    expect(resolvePanelFormDriver('d1', 'postgres')).toBe('postgres')
    expect(resolvePanelFormDriver(123 as unknown as string, 'd1')).toBe('sqlite')

    // Trigger tokenizer with comments/quotes/brackets + unnamed rebuild index + columnRefs
    const trigDraft = createPanelStructDraft(
      {
        name: 'ord_tok',
        schema: 'main',
        columns: [{ name: 'id', type: 'INTEGER', nullable: false, isPrimaryKey: true }],
        triggers: [
          {
            name: 't_tok',
            sql: "/* hdr */ -- line\nCREATE TRIGGER \"t_tok\" AFTER INSERT ON [ord_tok] WHEN [a]]b] > 'a''b' BEGIN SELECT 1; END;",
          },
        ],
      },
      'sqlite'
    )
    trigDraft.tableName = 'ord_v2'
    trigDraft.columns[0].dataType = 'BIGINT'
    trigDraft.indexes.push({
      id: 'i_un',
      status: 'new',
      name: '',
      columnRefs: [{ colId: trigDraft.columns[0].id }],
      columnSpecs: [],
      unique: false,
      isPrimary: false,
    })
    const trigSql = buildPanelMigrationSql(trigDraft, 'sqlite').join('\n')
    expect(trigSql).toContain('"ord_v2"')
    expect(trigSql).toContain('CREATE INDEX IF NOT EXISTS')

    // SQLite ALTER ADD NOT NULL inferred defaults (0 vs '')
    const sqlAddNotNull = createPanelStructDraft(
      { name: 't_add', columns: [{ name: 'id', type: 'INTEGER', isPrimaryKey: true, nullable: false }] },
      'sqlite'
    )
    sqlAddNotNull.columns.push(
      {
        id: 'n1',
        status: 'new',
        name: 'num_c',
        originalName: 'num_c',
        dataType: 'INTEGER',
        originalDataType: 'INTEGER',
        nullable: false,
        originalNullable: false,
        defaultValue: '',
        originalDefaultValue: '',
        isPrimaryKey: false,
        originalIsPrimaryKey: false,
        isAutoIncrement: false,
      },
      {
        id: 'n2',
        status: 'new',
        name: 'txt_c',
        originalName: 'txt_c',
        dataType: 'TEXT',
        originalDataType: 'TEXT',
        nullable: false,
        originalNullable: false,
        defaultValue: '',
        originalDefaultValue: '',
        isPrimaryKey: false,
        originalIsPrimaryKey: false,
        isAutoIncrement: false,
      }
    )
    const addSql = buildPanelMigrationSql(sqlAddNotNull, 'sqlite').join('\n')
    expect(addSql).toContain('DEFAULT 0')
    expect(addSql).toContain("DEFAULT ''")

    // MSSQL named defaultConstraintName drop + countPanelStructChanges invalid type catch + deleted FK + bad tbl name
    const msDefDraft = createPanelStructDraft(
      { name: 't_ms', schema: 'dbo', columns: [{ name: 'id', type: 'INT', isPrimaryKey: true }, { name: 'c', type: 'INT', defaultValue: '1' }] },
      'mssql'
    )
    msDefDraft.columns[1].defaultConstraintName = 'DF_t_ms_c'
    msDefDraft.columns[1].defaultValue = ''
    expect(buildPanelMigrationSql(msDefDraft, 'mssql').join('\n')).toContain('DROP CONSTRAINT [DF_t_ms_c]')

    msDefDraft.columns[1].dataType = 'INVALID;;TYPE'
    expect(countPanelStructChanges(msDefDraft)).toBeGreaterThanOrEqual(1)
    msDefDraft.tableName = 'bad;name'
    msDefDraft.foreignKeys.push({ id: 'fkd', status: 'deleted', constraintName: 'fk_old', column: 'c', foreignTable: 'o', foreignColumn: 'id' })
    const badVal = validatePanelStructDraft(msDefDraft, 'mssql')
    expect(badVal.errors.some((e) => e.includes('invalid characters'))).toBe(true)
    expect(badVal.diffs.some((d) => d.includes('Drop FK'))).toBe(true)
  })
})
