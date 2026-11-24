import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaWorkerApi } from 'orca/worker'
import type { ConnectionProfile, TableDetails, TransactionState } from '../src/protocol'
import { introspectSqliteTableDetails } from '../src/drivers/common/schema'
import {
  analyzeSqliteTriggerReferences,
  quoteIdentForDialect,
} from '../src/shared-sql-core.js'
import {
  buildAlterTableSql,
  buildTableMigrationSql,
  createInitialTableDraft,
  reconstructTableDdl,
  validateTableStructureDraft,
} from '../src/drivers/common/sql-migration'
import { getCanonicalByodStarterCode } from '../src/drivers/common/byod-templates'
import {
  isExplainTargetMutating,
  isMutatingStatement,
  sanitizeFilterClause,
  stripCommentsAndLiterals,
} from '../src/drivers/common/sql-lexer'
import {
  detectRecognizableSqlCredential,
  scrubDriverErrorText,
} from '../src/drivers/common/sql-credentials'
import { ClickHouseDriver, ClickHouseSession, normalizeClickHouseBaseUrl } from '../src/drivers/clickhouse/driver'
import { D1Driver, D1Session } from '../src/drivers/d1/driver'
import { LibsqlSession } from '../src/drivers/libsql/driver'
import { RedisDriver, RedisSession } from '../src/drivers/redis/driver'
import { SqliteDriver } from '../src/drivers/sqlite/driver'
import {
  autoMapImportColumns,
  buildMappedImportRecords,
  parseImportText,
  parseJsonPreservingBigInts,
} from '../src/editor/data-import'
import {
  parseDelimitedClipboard,
  parseJsonPreservingBigInts as sharedParseJsonPreservingBigInts,
} from '../src/shared-grid-paste.js'
import { buildGridChangesPayload, type InternalRowState } from '../src/editor/grid-data-ops'
import type { GridModel } from '../src/editor/grid-formatters'
import { TransactionToolbarController } from '../src/editor/transaction-toolbar'
import { registerQueryAndTxHandlers } from '../src/worker/rpc-query-tx'
import { createQueryRuntimeTracker } from '../src/worker/worker-utils'

describe('Budget & package version invariants', () => {
  it('enforces 25 MB package budget in check-package-size.mjs & CONTRIBUTING.md and pins mysql2 3.24.6', () => {
    const sizeScript = fs.readFileSync(
      path.join(process.cwd(), 'build', 'check-package-size.mjs'),
      'utf8'
    )
    expect(sizeScript).toContain('MAX_TOTAL_BYTES = 25_000_000')
    expect(sizeScript).toContain('MAX_VENDOR_FILE_BYTES = 1024 * 1024')
    expect(sizeScript).toContain('>= MAX_VENDOR_FILE_BYTES')
    expect(sizeScript).toContain("'.datanoa'")
    expect(sizeScript).toContain("'.vite'")
    expect(sizeScript).not.toMatch(/\b5_000_000\b/)
    expect(sizeScript).not.toMatch(/\b5 MB\b/)

    const contributing = fs.readFileSync(path.join(process.cwd(), 'CONTRIBUTING.md'), 'utf8')
    expect(contributing).toContain('25,000,000')
    expect(contributing).toContain('25 MB')
    expect(contributing).not.toMatch(/\b5,000_000\b/)
    expect(contributing).not.toContain('<= 5 MB')

    const pkg = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')
    ) as { devDependencies?: Record<string, string> }
    const expectedVendorPins: Record<string, string> = {
      '@codemirror/autocomplete': '6.20.4',
      '@codemirror/commands': '6.11.1',
      '@codemirror/lang-sql': '6.10.0',
      '@codemirror/language': '6.13.1',
      '@codemirror/search': '6.7.2',
      '@codemirror/state': '6.7.6',
      '@codemirror/view': '6.43.15',
      '@lezer/highlight': '1.2.5',
      mongodb: '7.9.1',
      mssql: '12.8.1',
      mysql2: '3.24.6',
      oracledb: '26.0.0',
      pg: '8.23.1',
      'pg-cursor': '2.22.1',
    }
    for (const [dep, ver] of Object.entries(expectedVendorPins)) {
      expect(pkg.devDependencies?.[dep]).toBe(ver)
    }
  })
})

describe('Item 1 & Item 4: SQLite / D1 rebuild UNIQUE constraints, triggers, FK checks & batch execution', () => {
  it('introspects SQLite index origin, columnSpecs (COLLATE/DESC), ON CONFLICT, triggers, column collate, and inboundForeignKeys', async () => {
    const db = new DatabaseSync(':memory:')
    try {
      db.exec(`
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          email TEXT NOT NULL COLLATE NOCASE UNIQUE ON CONFLICT IGNORE,
          org_id INTEGER NOT NULL,
          code TEXT NOT NULL,
          UNIQUE (org_id, code COLLATE NOCASE DESC) ON CONFLICT REPLACE
        );
        CREATE TABLE child_refs (
          id INTEGER PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX idx_users_org ON users (org_id);
        CREATE TRIGGER trg_users_after_insert AFTER INSERT ON users BEGIN
          SELECT 1;
        END;
      `)

      const query = async (sql: string, params: unknown[] = []) => {
        const stmt = db.prepare(sql)
        return stmt.all(...(params as [string])) as Record<string, unknown>[]
      }

      const details = await introspectSqliteTableDetails(query, 'users', 'main')
      const emailCol = details.columns.find((c) => c.name === 'email')
      const uniqEmail = details.indexes.find((i) => i.columns.length === 1 && i.columns[0] === 'email')
      const uniqComposite = details.indexes.find((i) => i.columns.join(',') === 'org_id,code')
      const customIdx = details.indexes.find((i) => i.name === 'idx_users_org')

      expect(emailCol?.collate).toBe('NOCASE')
      expect(uniqEmail?.origin).toBe('u')
      expect(uniqEmail?.isUnique).toBe(true)
      expect(uniqEmail?.isPrimary).toBe(false)
      expect(uniqEmail?.columnSpecs).toEqual([{ name: 'email', collate: 'NOCASE' }])
      expect(uniqEmail?.onConflict).toBe('IGNORE')

      expect(uniqComposite?.origin).toBe('u')
      expect(uniqComposite?.columnSpecs).toEqual([
        { name: 'org_id' },
        { name: 'code', collate: 'NOCASE', desc: true },
      ])
      expect(uniqComposite?.onConflict).toBe('REPLACE')

      expect(customIdx?.origin).toBe('c')
      expect(details.triggers).toHaveLength(1)
      expect(details.triggers?.[0].name).toBe('trg_users_after_insert')
      expect(details.triggers?.[0].sql).toContain('CREATE TRIGGER trg_users_after_insert')
      expect(details.inboundForeignKeys).toEqual([
        { fromTable: 'child_refs', fromColumn: 'user_id', toColumn: 'id', onDelete: 'CASCADE' },
      ])
    } finally {
      db.close()
    }
  })

  it('preserves UNIQUE collation/DESC/ON CONFLICT, safe triggers, defer_foreign_keys, and server-side FK abort SQL; blocks composite UNIQUE drops, unsafe triggers, and D1 inbound-FK rebuilds', () => {
    const FK_ABORT_SQL =
      "SELECT json_extract('{}', '__datanoa_fk_violation__') FROM pragma_foreign_key_check LIMIT 1;"

    const details: TableDetails = {
      name: 'users',
      schema: 'main',
      kind: 'table',
      primaryKey: ['id'],
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
          collate: 'NOCASE',
        },
        {
          name: 'org_id',
          type: 'INTEGER',
          nativeType: 'INTEGER',
          nullable: false,
          defaultValue: null,
          isPrimaryKey: false,
          isAutoIncrement: false,
        },
        {
          name: 'code',
          type: 'TEXT',
          nativeType: 'TEXT',
          nullable: false,
          defaultValue: null,
          isPrimaryKey: false,
          isAutoIncrement: false,
        },
        {
          name: 'legacy_code',
          type: 'TEXT',
          nativeType: 'TEXT',
          nullable: true,
          defaultValue: null,
          isPrimaryKey: false,
          isAutoIncrement: false,
        },
      ],
      indexes: [
        {
          name: 'sqlite_autoindex_users_1',
          isUnique: true,
          isPrimary: false,
          origin: 'u',
          columns: ['email'],
          columnSpecs: [{ name: 'email', collate: 'NOCASE' }],
          onConflict: 'IGNORE',
        },
        {
          name: 'sqlite_autoindex_users_2',
          isUnique: true,
          isPrimary: false,
          origin: 'u',
          columns: ['org_id', 'code'],
          columnSpecs: [{ name: 'org_id' }, { name: 'code', collate: 'NOCASE', desc: true }],
          onConflict: 'REPLACE',
        },
        {
          name: 'sqlite_autoindex_users_3',
          isUnique: true,
          isPrimary: false,
          origin: 'u',
          columns: ['legacy_code'],
        },
        {
          name: 'idx_users_email',
          isUnique: false,
          isPrimary: false,
          origin: 'c',
          columns: ['email'],
        },
      ],
      foreignKeys: [],
      triggers: [
        {
          name: 'trg_users_noop',
          sql: 'CREATE TRIGGER trg_users_noop AFTER INSERT ON "users" BEGIN SELECT 1; END',
        },
      ],
    }

    const draft = createInitialTableDraft(details)
    expect(draft.columns[1].collate).toBe('NOCASE')
    expect(draft.indexes[0].origin).toBe('u')
    expect(draft.indexes[0].onConflict).toBe('IGNORE')
    expect(draft.indexes[1].columnSpecs).toEqual([
      { name: 'org_id' },
      { name: 'code', collate: 'NOCASE', desc: true },
    ])
    expect(draft.triggers).toHaveLength(1)

    // Safe rebuild: rename table users -> accounts, rename email -> primary_email, change type, drop legacy_code
    draft.tableName = 'accounts'
    draft.columns[1].name = 'primary_email'
    draft.columns[1].dataType = 'VARCHAR(320)'
    draft.columns[4].status = 'deleted'

    const sqliteStmts = buildTableMigrationSql(draft, 'sqlite')
    expect(sqliteStmts[0]).toBe('PRAGMA foreign_keys = OFF;')
    expect(sqliteStmts[1]).toBe('BEGIN IMMEDIATE;')
    expect(sqliteStmts[2]).toBe('PRAGMA defer_foreign_keys = ON;')
    const createStmt = sqliteStmts.find((s) => s.startsWith('CREATE TABLE "__datanoa_new_users"'))
    expect(createStmt).toContain('COLLATE NOCASE')
    expect(createStmt).toContain('UNIQUE ("primary_email" COLLATE NOCASE) ON CONFLICT IGNORE')
    expect(createStmt).toContain('UNIQUE ("org_id", "code" COLLATE NOCASE DESC) ON CONFLICT REPLACE')
    expect(createStmt).not.toContain('legacy_code')
    // Must not emit CREATE INDEX for sqlite_autoindex_*
    expect(sqliteStmts.some((s) => /CREATE.*INDEX.*sqlite_autoindex/i.test(s))).toBe(false)
    // Must re-emit safe trigger with rewritten ON "accounts" and trailing semicolon
    const triggerStmt = sqliteStmts.find((s) => s.startsWith('CREATE TRIGGER trg_users_noop'))
    expect(triggerStmt).toBeDefined()
    expect(triggerStmt).toContain('ON "accounts"')
    expect(triggerStmt?.endsWith(';')).toBe(true)
    // Server-side failing FK check must be right before COMMIT;
    const fkCheckIdx = sqliteStmts.indexOf(FK_ABORT_SQL)
    const commitIdx = sqliteStmts.indexOf('COMMIT;')
    expect(fkCheckIdx).toBeGreaterThan(0)
    expect(commitIdx).toBe(fkCheckIdx + 1)

    // D1 dialect (without inbound FKs): PRAGMA defer_foreign_keys = ON; at start, server-side FK abort SQL at end
    const d1Stmts = buildTableMigrationSql(draft, 'd1')
    expect(d1Stmts[0]).toBe('PRAGMA defer_foreign_keys = ON;')
    expect(d1Stmts[d1Stmts.length - 1]).toBe(FK_ABORT_SQL)
    expect(d1Stmts.some((s) => /PRAGMA\s+foreign_keys\s*=/i.test(s))).toBe(false)
    expect(d1Stmts.some((s) => /^(?:BEGIN|COMMIT)\b/i.test(s))).toBe(false)

    const d1Plan = validateTableStructureDraft(draft, 'd1', ['users'])
    expect(d1Plan.valid).toBe(true)
    expect(
      d1Plan.warnings.some(
        (w) => /batched HTTP request/i.test(w) && /PRAGMA defer_foreign_keys = ON/i.test(w)
      )
    ).toBe(true)

    // reconstructTableDdl also preserves column COLLATE, UNIQUE COLLATE/DESC/ON CONFLICT, and triggers
    const ddl = reconstructTableDdl(details, 'sqlite')
    expect(ddl).toContain('"email" TEXT NOT NULL COLLATE NOCASE')
    expect(ddl).toContain('UNIQUE ("email" COLLATE NOCASE) ON CONFLICT IGNORE')
    expect(ddl).toContain('UNIQUE ("org_id", "code" COLLATE NOCASE DESC) ON CONFLICT REPLACE')
    expect(ddl).not.toContain('CREATE UNIQUE INDEX "sqlite_autoindex_users_1"')
    expect(ddl).toContain('CREATE TRIGGER trg_users_noop')

    // BLOCKING CASE 1: Dropping one column of a composite UNIQUE without deleting the constraint
    const compositeBreakDraft = createInitialTableDraft(details)
    compositeBreakDraft.columns[3].status = 'deleted' // drop `code` while UNIQUE(org_id, code) stays active
    const compositePlan = validateTableStructureDraft(compositeBreakDraft, 'sqlite', ['users'])
    expect(compositePlan.valid).toBe(false)
    expect(compositePlan.errors.some((e) => /composite UNIQUE/i.test(e) && /code/i.test(e))).toBe(true)
    expect(() => buildTableMigrationSql(compositeBreakDraft, 'sqlite')).toThrow(/composite UNIQUE/i)

    // BLOCKING CASE 2: Trigger references renamed/dropped column (UPDATE OF / NEW. / OLD.)
    const colTriggerDetails: TableDetails = {
      ...details,
      triggers: [
        {
          name: 'trg_users_audit',
          sql: 'CREATE TRIGGER trg_users_audit AFTER UPDATE OF email ON "users" BEGIN SELECT NEW.email, OLD.legacy_code; END',
        },
      ],
    }
    const unsafeColTriggerDraft = createInitialTableDraft(colTriggerDetails)
    unsafeColTriggerDraft.columns[1].name = 'primary_email'
    unsafeColTriggerDraft.columns[1].dataType = 'VARCHAR(320)'
    const unsafeColPlan = validateTableStructureDraft(unsafeColTriggerDraft, 'sqlite', ['users'])
    expect(unsafeColPlan.valid).toBe(false)
    expect(unsafeColPlan.errors.some((e) => /trg_users_audit/i.test(e) && /email/i.test(e))).toBe(true)
    expect(() => buildTableMigrationSql(unsafeColTriggerDraft, 'sqlite')).toThrow(/trg_users_audit/i)

    // BLOCKING CASE 3: Table rename when trigger body references old table name unsafely
    const bodyTableTriggerDetails: TableDetails = {
      ...details,
      triggers: [
        {
          name: 'trg_users_self',
          sql: 'CREATE TRIGGER trg_users_self AFTER INSERT ON users BEGIN UPDATE users SET code = NEW.code WHERE id = NEW.id; END',
        },
      ],
    }
    const unsafeTableRenameDraft = createInitialTableDraft(bodyTableTriggerDetails)
    unsafeTableRenameDraft.tableName = 'accounts'
    unsafeTableRenameDraft.columns[1].dataType = 'VARCHAR(320)'
    const unsafeTablePlan = validateTableStructureDraft(unsafeTableRenameDraft, 'sqlite', ['users'])
    expect(unsafeTablePlan.valid).toBe(false)
    expect(unsafeTablePlan.errors.some((e) => /trg_users_self/i.test(e) && /users/i.test(e))).toBe(true)
    expect(() => buildTableMigrationSql(unsafeTableRenameDraft, 'sqlite')).toThrow(/trg_users_self/i)

    // BLOCKING CASE 4: D1 rebuild blocked when inboundForeignKeys is non-empty
    const d1InboundDetails: TableDetails = {
      ...details,
      inboundForeignKeys: [
        { fromTable: 'child_refs', fromColumn: 'user_id', toColumn: 'id', onDelete: 'CASCADE' },
      ],
    }
    const d1InboundDraft = createInitialTableDraft(d1InboundDetails)
    d1InboundDraft.columns[1].dataType = 'VARCHAR(320)'
    const d1InboundPlan = validateTableStructureDraft(d1InboundDraft, 'd1', ['users'])
    expect(d1InboundPlan.valid).toBe(false)
    expect(d1InboundPlan.errors.some((e) => /child_refs/i.test(e) && /D1/i.test(e))).toBe(true)
    expect(() => buildTableMigrationSql(d1InboundDraft, 'd1')).toThrow(/child_refs/i)
  })

  it('quotes MSSQL & Oracle identifiers, tokenizes SQLite trigger refs accurately, blocks composite UNIQUE index (origin=c) partial drops & pure trigger table renames', () => {
    expect(quoteIdentForDialect('my]table', 'mssql')).toBe('[my]]table]')
    expect(quoteIdentForDialect('my"col', 'oracle')).toBe('"my""col"')

    // R4#1 & R4#2: Multi-word quoted table/trigger identifier "bảng order" must NOT match column "order",
    // and ON "bảng order" target header must be excluded from trigger body table reference checks.
    const multiWordTrigger = `
      CREATE TRIGGER "trg order kiểm tra" AFTER INSERT ON "bảng order"
      BEGIN
        -- ignore 'order' inside comments and strings
        INSERT INTO audit_log(note) VALUES ('bảng order / order');
        SELECT NEW."mã đơn";
      END
    `
    const multiWordRes = analyzeSqliteTriggerReferences(multiWordTrigger, 'bảng order', [
      'order',
      'mã đơn',
    ])
    expect(multiWordRes.referencesOrigTableInBody).toBe(false)
    expect(multiWordRes.onTargetMatchesOrigTable).toBe(true)
    expect(multiWordRes.referencedIdents).toEqual(['mã đơn'])

    // Trigger body reference (not NEW./OLD. and not ON <origTable>) MUST be detected
    const bodyRefTrigger = `
      CREATE TRIGGER trg_invoices_audit AFTER INSERT ON invoices
      BEGIN
        UPDATE invoices SET total = NEW.total WHERE id = NEW.id;
      END
    `
    const bodyRefRes = analyzeSqliteTriggerReferences(bodyRefTrigger, 'invoices', ['total', 'status'])
    expect(bodyRefRes.referencesOrigTableInBody).toBe(true)
    expect(bodyRefRes.referencedIdents).toEqual(['total'])

    // R2#2: Dropping 1 column ('org_id') of a 2-col composite CREATE UNIQUE INDEX (origin='c') MUST be blocked
    const uniqueIdxDetails: TableDetails = {
      name: 'items',
      schema: 'main',
      kind: 'table',
      primaryKey: ['id'],
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
          name: 'org_id',
          type: 'INTEGER',
          nativeType: 'INTEGER',
          nullable: false,
          defaultValue: null,
          isPrimaryKey: false,
          isAutoIncrement: false,
        },
        {
          name: 'slug',
          type: 'TEXT',
          nativeType: 'TEXT',
          nullable: false,
          defaultValue: null,
          isPrimaryKey: false,
          isAutoIncrement: false,
        },
      ],
      indexes: [
        {
          name: 'idx_items_org_slug',
          isUnique: true,
          isPrimary: false,
          origin: 'c',
          columns: ['org_id', 'slug'],
        },
      ],
      foreignKeys: [],
    }
    const partialUniqueIdxDraft = createInitialTableDraft(uniqueIdxDetails)
    partialUniqueIdxDraft.columns[1].status = 'deleted' // drop org_id while keeping idx_items_org_slug active
    const partialUniquePlan = validateTableStructureDraft(partialUniqueIdxDraft, 'sqlite', ['items'])
    expect(partialUniquePlan.valid).toBe(false)
    expect(partialUniquePlan.errors.some((e) => /composite UNIQUE/i.test(e) && /org_id/i.test(e))).toBe(true)
    expect(() => buildTableMigrationSql(partialUniqueIdxDraft, 'sqlite')).toThrow(/composite UNIQUE/i)

    // Explicitly deleting the composite UNIQUE index allows dropping org_id
    const explicitDeleteIdxDraft = createInitialTableDraft(uniqueIdxDetails)
    explicitDeleteIdxDraft.columns[1].status = 'deleted'
    explicitDeleteIdxDraft.indexes[0].status = 'deleted'
    expect(validateTableStructureDraft(explicitDeleteIdxDraft, 'sqlite', ['items']).valid).toBe(true)

    // R2#1: Pure table rename (no rebuild) on a table with a trigger whose body omits origTable MUST be blocked,
    // without emitting a misleading "will be recreated" warning!
    const invoiceDetails: TableDetails = {
      name: 'invoices',
      schema: 'main',
      kind: 'table',
      primaryKey: ['id'],
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
          name: 'status',
          type: 'TEXT',
          nativeType: 'TEXT',
          nullable: false,
          defaultValue: null,
          isPrimaryKey: false,
          isAutoIncrement: false,
        },
      ],
      indexes: [],
      foreignKeys: [],
      triggers: [
        {
          name: 'trg_invoices_noop',
          sql: 'CREATE TRIGGER trg_invoices_noop AFTER INSERT ON "invoices" BEGIN SELECT NEW.status; END',
        },
      ],
    }
    const pureRenameDraft = createInitialTableDraft(invoiceDetails)
    pureRenameDraft.tableName = 'billing_invoices'
    const pureRenamePlan = validateTableStructureDraft(pureRenameDraft, 'sqlite', ['invoices'])
    expect(pureRenamePlan.isRebuild).toBe(false)
    expect(pureRenamePlan.valid).toBe(false)
    expect(pureRenamePlan.errors.some((e) => /trg_invoices_noop/i.test(e))).toBe(true)
    expect(pureRenamePlan.warnings.some((w) => /will be recreated/i.test(w))).toBe(false)
    expect(() => buildTableMigrationSql(pureRenameDraft, 'sqlite')).toThrow(/trg_invoices_noop/i)

    // Pure column rename (no rebuild) referenced by trigger MUST also be blocked
    const pureColRenameDraft = createInitialTableDraft(invoiceDetails)
    pureColRenameDraft.columns[1].name = 'invoice_status'
    const pureColRenamePlan = validateTableStructureDraft(pureColRenameDraft, 'sqlite', ['invoices'])
    expect(pureColRenamePlan.isRebuild).toBe(false)
    expect(pureColRenamePlan.valid).toBe(false)
    expect(pureColRenamePlan.errors.some((e) => /trg_invoices_noop/i.test(e) && /status/i.test(e))).toBe(true)

    // Rebuild + table rename with safe trigger (body omits origTable) MUST still succeed and rewrite ON target
    const rebuildRenameDraft = createInitialTableDraft(invoiceDetails)
    rebuildRenameDraft.tableName = 'billing_invoices'
    rebuildRenameDraft.columns[1].dataType = 'VARCHAR(50)'
    const rebuildRenamePlan = validateTableStructureDraft(rebuildRenameDraft, 'sqlite', ['invoices'])
    expect(rebuildRenamePlan.isRebuild).toBe(true)
    expect(rebuildRenamePlan.valid).toBe(true)
    expect(rebuildRenamePlan.statements.some((s) => /CREATE TRIGGER trg_invoices_noop[\s\S]*ON "billing_invoices"/i.test(s))).toBe(true)
  })

  it('aborts SQLite rebuild on server-side FK check, rejects rebuild during active manual tx, and preserves PRAGMA foreign_keys = OFF state', async () => {
    const tmpFile = path.join(
      os.tmpdir(),
      `.tmp_fk_test_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.db`
    )
    const driver = new SqliteDriver()
    const profile: ConnectionProfile = {
      id: 'sqlite_fk_test',
      name: 'SQLite FK Test',
      driver: 'sqlite',
      database: tmpFile,
      filePath: tmpFile,
    }
    const session = await driver.createSession(profile)
    try {
      await session.runQuery(
        'q_setup',
        `
        CREATE TABLE parents (id INTEGER PRIMARY KEY, email TEXT UNIQUE);
        CREATE TABLE children (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parents(id));
        INSERT INTO parents (id, email) VALUES (1, 'a@test.com');
        INSERT INTO children (id, parent_id) VALUES (10, 1);
        CREATE TRIGGER trg_parents_noop AFTER INSERT ON parents BEGIN SELECT 1; END;
        `
      )
      const details = await session.getTableDetails('parents')
      expect(details.indexes.some((i) => i.origin === 'u')).toBe(true)
      expect(details.triggers?.some((t) => t.name === 'trg_parents_noop')).toBe(true)
      expect(details.inboundForeignKeys).toEqual([
        { fromTable: 'children', fromColumn: 'parent_id', toColumn: 'id', onDelete: 'NO ACTION' },
      ])

      const ddl = await session.getDdl('parents')
      expect(ddl).toContain('trg_parents_noop')

      // 1. Server-side FK check abort before COMMIT rolls back and translates sentinel error cleanly
      await expect(
        session.runQuery(
          'q_bad_rebuild',
          `
          PRAGMA foreign_keys = OFF;
          BEGIN IMMEDIATE;
          PRAGMA defer_foreign_keys = ON;
          DELETE FROM parents WHERE id = 1;
          SELECT json_extract('{}', '__datanoa_fk_violation__') FROM pragma_foreign_key_check LIMIT 1;
          COMMIT;
          PRAGMA foreign_keys = ON;
          `
        )
      ).rejects.toThrow(/FOREIGN KEY constraint failed/i)

      const check = await session.runQuery('q_verify', 'SELECT COUNT(*) AS cnt FROM parents;')
      expect(Number(check.rows[0]?.[0])).toBe(1)

      // 2. Reject rebuild script immediately when inManualTx is active
      await session.beginTransaction()
      await expect(
        session.runQuery(
          'q_rebuild_in_tx',
          `
          PRAGMA foreign_keys = OFF;
          BEGIN IMMEDIATE;
          CREATE TABLE __tmp_p (id INTEGER PRIMARY KEY);
          COMMIT;
          PRAGMA foreign_keys = ON;
          `
        )
      ).rejects.toThrow(/manual transaction is active/i)
      await session.rollbackTransaction()

      // 3. When foreign_keys was explicitly OFF, a successful (or failed) rebuild must restore OFF, NOT flip it ON
      await session.runQuery('q_fk_off', 'PRAGMA foreign_keys = OFF;')
      await session.runQuery(
        'q_good_rebuild_fk_off',
        `
        PRAGMA foreign_keys = OFF;
        BEGIN IMMEDIATE;
        PRAGMA defer_foreign_keys = ON;
        SELECT json_extract('{}', '__datanoa_fk_violation__') FROM pragma_foreign_key_check LIMIT 1;
        COMMIT;
        PRAGMA foreign_keys = ON;
        `
      )
      const fkAfter = await session.runQuery('q_fk_check_state', 'PRAGMA foreign_keys;')
      expect(Number(fkAfter.rows[0]?.[0])).toBe(0)
    } finally {
      await session.close()
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          fs.unlinkSync(`${tmpFile}${suffix}`)
        } catch {
          // Ignore missing file
        }
      }
    }
  })

  it('executes D1 multi-statement runQuery in a single executeBatch HTTP request, asserts result count, and translates FK abort sentinel', async () => {
    const fetchCalls: Array<{ url: string; body: Record<string, unknown> }> = []
    const origFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const bodyObj = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>
      fetchCalls.push({ url: String(input), body: bodyObj })
      return new Response(
        JSON.stringify({
          success: true,
          errors: [],
          result: [
            { success: true, results: [], meta: { changes: 0 } },
            { success: true, results: [{ id: 1, email: 'a@b.com' }], meta: { changes: 0 } },
            { success: true, results: [], meta: { changes: 1 } },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }) as unknown as typeof fetch

    try {
      const session = new D1Session(
        {
          id: 'd1_1',
          name: 'D1',
          driver: 'd1',
          database: 'db',
          d1AccountId: 'acc_123',
          d1DatabaseId: 'db_456',
        },
        'tok_secret'
      )

      const res = await session.runQuery(
        'q_batch',
        'PRAGMA defer_foreign_keys = ON; SELECT id, email FROM users; UPDATE users SET email = "x@y.com" WHERE id = 1;'
      )
      expect(fetchCalls).toHaveLength(1)
      expect(Array.isArray(fetchCalls[0].body.batch)).toBe(true)
      expect((fetchCalls[0].body.batch as unknown[]).length).toBe(3)
      expect(res.resultSets).toHaveLength(3)
      expect(res.affectedRows).toBe(1)
      expect(res.rows).toEqual([[1, 'a@b.com']])

      // Must reject if D1 returns fewer batch results than statements submitted
      globalThis.fetch = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            success: true,
            errors: [],
            result: [{ success: true, results: [], meta: { changes: 0 } }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }) as unknown as typeof fetch

      await expect(
        session.runQuery('q_mismatch', 'SELECT 1; SELECT 2;')
      ).rejects.toThrow(/unexpected number of batch results/i)

      // Must translate server-side FK abort sentinel error into clean FOREIGN KEY constraint failed
      globalThis.fetch = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            success: false,
            errors: [{ message: "bad JSON path: '__datanoa_fk_violation__'" }],
            result: [],
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        )
      }) as unknown as typeof fetch

      await expect(
        session.runQuery(
          'q_fk_sentinel',
          "PRAGMA defer_foreign_keys = ON; SELECT json_extract('{}', '__datanoa_fk_violation__') FROM pragma_foreign_key_check LIMIT 1;"
        )
      ).rejects.toThrow(/FOREIGN KEY constraint failed/i)
    } finally {
      globalThis.fetch = origFetch
    }
  })
})

describe('Item 2: Single shared parseJsonPreservingBigInts & full E2E SQLite BIGINT storage', () => {
  it('reuses one shared parseJsonPreservingBigInts from shared-grid-paste and stores exact 64-bit BIGINTs end-to-end in SQLite', async () => {
    expect(parseJsonPreservingBigInts).toBe(sharedParseJsonPreservingBigInts)

    const rawJson =
      '[{"id": 9007199254740993, "neg": -9007199254740995, "safe": 9007199254740991, "small": 42, "floatVal": 9007199254740993.5, "sci": 1234567890123456e2, "label": "id is 9007199254740993"}]'

    const parsed = parseJsonPreservingBigInts(rawJson) as Array<Record<string, unknown>>
    expect(parsed[0].id).toBe('9007199254740993')
    expect(parsed[0].neg).toBe('-9007199254740995')
    expect(parsed[0].safe).toBe(9007199254740991)
    expect(parsed[0].small).toBe(42)
    expect(typeof parsed[0].floatVal).toBe('number')
    expect(typeof parsed[0].sci).toBe('number')
    expect(parsed[0].label).toBe('id is 9007199254740993')

    const clip = parseDelimitedClipboard('{"id": 9007199254740993, "a": 1}')
    expect(clip).toEqual([['{"id": 9007199254740993, "a": 1}']])

    // Full E2E through parseImportText (JSON & NDJSON) -> buildMappedImportRecords -> SqliteSession.applyChanges -> CAST(big_id AS TEXT)
    const tmpFile = path.join(
      os.tmpdir(),
      `.tmp_bigint_e2e_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.db`
    )
    const driver = new SqliteDriver()
    const session = await driver.createSession({
      id: 'sqlite_bigint',
      name: 'SQLite BigInt',
      driver: 'sqlite',
      database: tmpFile,
      filePath: tmpFile,
    })
    try {
      await session.runQuery(
        'q_init',
        'CREATE TABLE bigints (seq INTEGER PRIMARY KEY, label TEXT, big_id BIGINT, payload TEXT);'
      )
      const details = await session.getTableDetails('bigints')

      const jsonInput =
        '[' +
        '{"seq": 1, "label": "unquoted_53plus", "big_id": 9007199254740993, "payload": {"nested": 9007199254740993}},' +
        '{"seq": 2, "label": "quoted_53plus", "big_id": "9007199254740993", "payload": {"nested": "9007199254740993"}},' +
        '{"seq": 3, "label": "unquoted_max64", "big_id": 9223372036854775807, "payload": null},' +
        '{"seq": 4, "label": "quoted_max64", "big_id": "9223372036854775807", "payload": null}' +
        ']'
      const jsonDataset = parseImportText(jsonInput, {
        format: 'json',
        delimiter: 'auto',
        hasHeaderRow: true,
        trimValues: false,
      })
      const jsonMapping = autoMapImportColumns(jsonDataset.headers, details.columns, jsonDataset.hasNamedHeaders)
      const jsonRecords = buildMappedImportRecords(jsonDataset, jsonMapping, details.columns, {
        nullHandling: 'empty-and-null',
        trimValues: false,
        skipEmptyRows: true,
      })
      await session.applyChanges({ table: 'bigints', inserts: jsonRecords.rows })

      const ndjsonInput =
        '{"seq": 5, "label": "unquoted_min64", "big_id": -9223372036854775808, "payload": null}\n' +
        '{"seq": 6, "label": "quoted_min64", "big_id": "-9223372036854775808", "payload": null}'
      const ndjsonDataset = parseImportText(ndjsonInput, {
        format: 'ndjson',
        delimiter: 'auto',
        hasHeaderRow: true,
        trimValues: false,
      })
      const ndjsonMapping = autoMapImportColumns(ndjsonDataset.headers, details.columns, ndjsonDataset.hasNamedHeaders)
      const ndjsonRecords = buildMappedImportRecords(ndjsonDataset, ndjsonMapping, details.columns, {
        nullHandling: 'empty-and-null',
        trimValues: false,
        skipEmptyRows: true,
      })
      await session.applyChanges({ table: 'bigints', inserts: ndjsonRecords.rows })

      const res = await session.runQuery(
        'q_read',
        'SELECT label, typeof(big_id), CAST(big_id AS TEXT), payload FROM bigints ORDER BY seq ASC;'
      )
      expect(res.rows).toEqual([
        ['unquoted_53plus', 'integer', '9007199254740993', '{"nested":"9007199254740993"}'],
        ['quoted_53plus', 'integer', '9007199254740993', '{"nested":"9007199254740993"}'],
        ['unquoted_max64', 'integer', '9223372036854775807', null],
        ['quoted_max64', 'integer', '9223372036854775807', null],
        ['unquoted_min64', 'integer', '-9223372036854775808', null],
        ['quoted_min64', 'integer', '-9223372036854775808', null],
      ])
    } finally {
      await session.close()
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          fs.unlinkSync(`${tmpFile}${suffix}`)
        } catch {
          // Ignore missing file
        }
      }
    }
  })
})

describe('Item 3: ClickHouse strict deleteRows contract, per-row delete verification & narrowed updateCell readback', () => {
  it('validates deleteRows, disables IN(...) batching, enforces exact COUNT(*) === 1 per row, and narrows updateCell readback', async () => {
    const model: GridModel = {
      headers: ['id', 'tenant', 'note'],
      columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'tenant', type: 'String' },
        { name: 'note', type: 'Nullable(String)' },
      ],
      rows: [
        { id: 10, tenant: 'acme', note: 'first' },
        { id: 20, tenant: 'beta', note: null },
      ],
      rowCount: 2,
      canEdit: true,
      primaryKey: ['id'],
    }
    const rowStates: InternalRowState[] = [
      {
        kind: 'existing',
        deleted: true,
        original: { id: 10, tenant: 'acme', note: 'first' },
        dirtyCols: new Map(),
      },
      {
        kind: 'existing',
        deleted: true,
        original: { id: 20, tenant: 'beta', note: null },
        dirtyCols: new Map(),
      },
    ]

    const payload = buildGridChangesPayload(model, rowStates)
    expect(payload.deletes).toEqual([{ id: 10 }, { id: 20 }])
    expect(payload.deleteRows).toEqual([
      { id: 10, tenant: 'acme', note: 'first' },
      { id: 20, tenant: 'beta', note: null },
    ])

    const executedSqls: string[] = []
    let countResult = 1
    const origFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const sql = String(init?.body || '')
      executedSqls.push(sql)
      if (/^SELECT COUNT\(\*\) AS total/i.test(sql)) {
        return new Response(
          JSON.stringify({
            meta: [{ name: 'total', type: 'UInt64' }],
            data: [[countResult]],
            rows: 1,
          }),
          { status: 200 }
        )
      }
      if (/^SELECT \* FROM/i.test(sql)) {
        return new Response(
          JSON.stringify({
            meta: [
              { name: 'id', type: 'UInt64' },
              { name: 'tenant', type: 'String' },
            ],
            data: [[10, 'new_acme']],
            rows: 1,
          }),
          { status: 200 }
        )
      }
      return new Response('', { status: 200 })
    }) as unknown as typeof fetch

    try {
      const ch = new ClickHouseSession({
        id: 'ch1',
        name: 'CH',
        driver: 'clickhouse',
        database: 'default',
        host: 'localhost',
        port: 8123,
      })

      // 1. Even WITHOUT deleteRows (single-column PK), ClickHouse deletes MUST NOT use IN (...) batching
      const pkOnlyPreview = await ch.previewChanges({
        table: 'events',
        deletes: [{ id: 10 }, { id: 20 }],
      })
      expect(pkOnlyPreview.statements).toEqual([
        'ALTER TABLE `default`.`events` DELETE WHERE `id` = 10;',
        'ALTER TABLE `default`.`events` DELETE WHERE `id` = 20;',
      ])

      // 2. Mismatched deleteRows length or PK mismatch must throw invalid_params
      await expect(
        ch.previewChanges({
          table: 'events',
          deletes: [{ id: 10 }, { id: 20 }],
          deleteRows: [{ id: 10, tenant: 'acme' }],
        })
      ).rejects.toMatchObject({ code: 'invalid_params' })

      await expect(
        ch.previewChanges({
          table: 'events',
          deletes: [{ id: 10 }],
          deleteRows: [{ id: 999, tenant: 'acme' }],
        })
      ).rejects.toMatchObject({ code: 'invalid_params' })

      // 3. Full-row predicates do not duplicate PK column
      const preview = await ch.previewChanges({
        table: 'events',
        deletes: payload.deletes,
        deleteRows: payload.deleteRows,
      })
      expect(preview.statements).toEqual([
        "ALTER TABLE `default`.`events` DELETE WHERE `id` = 10 AND `tenant` = 'acme' AND `note` = 'first';",
        "ALTER TABLE `default`.`events` DELETE WHERE `id` = 20 AND `tenant` = 'beta' AND `note` IS NULL;",
      ])

      const applied = await ch.applyChanges({
        table: 'events',
        deletes: payload.deletes,
        deleteRows: payload.deleteRows,
      })
      expect(applied.deleted).toBe(2)

      // 4. Exact COUNT(*) === 1 guard rejects both > 1 and 0
      countResult = 3
      await expect(
        ch.applyChanges({
          table: 'events',
          deletes: [{ id: 10 }],
          deleteRows: [{ id: 10, tenant: 'acme', note: 'first' }],
        })
      ).rejects.toMatchObject({ code: 'conflict' })

      countResult = 0
      await expect(
        ch.applyChanges({
          table: 'events',
          deletes: [{ id: 10 }],
          deleteRows: [{ id: 10, tenant: 'acme', note: 'first' }],
        })
      ).rejects.toMatchObject({ code: 'conflict' })

      // 5. updateCell throws conflict when matchedRows > 1, and when matchedRows === 1 narrows readback SELECT with updated column value
      countResult = 2
      await expect(
        ch.updateCell({
          table: 'events',
          primaryKeys: { id: 10 },
          column: 'tenant',
          newValue: 'new_acme',
          originalValue: 'acme',
        })
      ).rejects.toMatchObject({ code: 'conflict' })

      countResult = 1
      executedSqls.length = 0
      const updatedCell = await ch.updateCell({
        table: 'events',
        primaryKeys: { id: 10 },
        column: 'tenant',
        newValue: 'new_acme',
        originalValue: 'acme',
      })
      expect(updatedCell.ok).toBe(true)
      const readbackSql = executedSqls.find((s) => /^SELECT \* FROM/i.test(s))
      expect(readbackSql).toBeDefined()
      expect(readbackSql).toContain("`id` = 10 AND `tenant` = 'new_acme'")
    } finally {
      globalThis.fetch = origFetch
    }
  })
})

describe('Items 5, 7, 9: BYOD templates (MSSQL, Oracle, MongoDB) & MongoDB read-only command allowlist + collection shorthand', () => {
  it('uses isolated ConnectionPool in MSSQL, autoCommit: true in Oracle, and readOnly guard with bare collection shorthand in MongoDB BYOD templates', () => {
    const mssqlCode = getCanonicalByodStarterCode('mssql')
    expect(mssqlCode).toContain('new mssql.ConnectionPool(')
    expect(mssqlCode).toContain('await pool.connect()')
    expect(mssqlCode).not.toContain('mssql.connect(')

    const oracleCode = getCanonicalByodStarterCode('oracle')
    expect(oracleCode).toContain('await conn.execute(sql, [], { autoCommit: true })')

    const mongoCode = getCanonicalByodStarterCode('mongodb')
    expect(mongoCode).toContain('if (profile.readOnly)')
    expect(mongoCode).toContain('$out')
    expect(mongoCode).toContain('$merge')
    expect(mongoCode).toContain('/^[A-Za-z_][A-Za-z0-9_.-]{0,127};?$/')
  })

  it('strictly enforces the MongoDB read-only command allowlist while allowing bare collection-name shorthand', () => {
    // Bare collection shorthand (executed as read-only .find({}).limit(100))
    expect(isMutatingStatement('users', 'mongodb')).toBe(false)
    expect(isMutatingStatement('audit.logs;', 'mongodb')).toBe(false)
    expect(isMutatingStatement('order_items-v2', 'mongodb')).toBe(false)

    // Explicit read-only JSON commands
    expect(isMutatingStatement('{"find": "users", "filter": {}}', 'mongodb')).toBe(false)
    expect(isMutatingStatement('{"count": "users"}', 'mongodb')).toBe(false)
    expect(isMutatingStatement('{"distinct": "users", "key": "role"}', 'mongodb')).toBe(false)
    expect(isMutatingStatement('{"ping": 1}', 'mongodb')).toBe(false)
    expect(isMutatingStatement('{"listCollections": 1}', 'mongodb')).toBe(false)
    expect(
      isMutatingStatement(
        '{"aggregate": "orders", "pipeline": [{"$match": {"status": "paid"}}], "cursor": {}}',
        'mongodb'
      )
    ).toBe(false)

    // Aggregate with $out or $merge must be rejected as mutating
    expect(
      isMutatingStatement(
        '{"aggregate": "orders", "pipeline": [{"$match": {}}, {"$out": "stolen_copy"}], "cursor": {}}',
        'mongodb'
      )
    ).toBe(true)
    expect(
      isMutatingStatement(
        '{"aggregate": "orders", "pipeline": [{"$merge": {"into": "other"}}], "cursor": {}}',
        'mongodb'
      )
    ).toBe(true)

    // Write commands, multi-token shell strings & malformed JSON must be treated as mutating
    expect(isMutatingStatement('{"insert": "users", "documents": [{"a": 1}]}', 'mongodb')).toBe(
      true
    )
    expect(isMutatingStatement('{"delete": "users", "deletes": []}', 'mongodb')).toBe(true)
    expect(isMutatingStatement('{"findAndModify": "users", "remove": true}', 'mongodb')).toBe(true)
    expect(isMutatingStatement('{"dropDatabase": 1}', 'mongodb')).toBe(true)
    expect(isMutatingStatement('db.users.drop()', 'mongodb')).toBe(true)
    expect(isMutatingStatement('users delete', 'mongodb')).toBe(true)
    expect(isMutatingStatement('{invalid json', 'mongodb')).toBe(true)
  })
})

describe('Item 6: Shared-session transaction token, per-connection lock, setAutoCommit & query.run ownership across panels', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).document
  })

  it('enforces panelId, txToken, setAutoCommit, query.run ownership, sessionRef reset, and per-connection serialization', async () => {
    const handlers = new Map<
      string,
      (input: Record<string, unknown>, ctx?: { panel?: { id: string }; signal?: AbortSignal }) => Promise<unknown>
    >()
    let txState: TransactionState = {
      supported: true,
      autoCommit: true,
      active: false,
      statementCount: 0,
    }
    const makeMockSession = () => ({
      getTransactionState: () => ({ ...txState }),
      beginTransaction: vi.fn(async () => {
        txState = { ...txState, active: true }
        return { ...txState }
      }),
      commitTransaction: vi.fn(async () => {
        txState = { ...txState, active: false, statementCount: 0 }
        return { ...txState }
      }),
      rollbackTransaction: vi.fn(async () => {
        txState = { ...txState, active: false, statementCount: 0 }
        return { ...txState }
      }),
      setAutoCommit: vi.fn(async (enabled: boolean) => {
        txState = { ...txState, autoCommit: enabled }
        return { ...txState }
      }),
      runQuery: vi.fn(async (_qid: string, sql: string) => {
        const up = sql.trim().toUpperCase()
        if (up.startsWith('BEGIN')) {
          txState = { ...txState, active: true }
        } else if (up.startsWith('COMMIT') || up.startsWith('ROLLBACK') || up.startsWith('END')) {
          txState = { ...txState, active: false, statementCount: 0 }
        }
        return {
          columns: [],
          rows: [],
          rowCount: 0,
          affectedRows: 0,
          executionTimeMs: 1,
          truncated: false,
          isSelect: false,
        }
      }),
    })
    let activeSession = makeMockSession()

    const fakeOrca = {
      storage: { get: async () => null, set: async () => {} },
      settings: { get: async () => 1000 },
      log: () => {},
    } as unknown as OrcaWorkerApi

    registerQueryAndTxHandlers({
      orca: fakeOrca,
      registerHandler: ((name: string, fn: (input: Record<string, unknown>, ctx?: { panel?: { id: string } }) => Promise<unknown>) => {
        handlers.set(name, fn)
      }) as unknown as OrcaWorkerApi['panels']['handle'],
      sessionManager: {
        findProfile: async () => ({
          id: 'pg1',
          name: 'PG',
          driver: 'postgres',
          database: 'app',
          readOnly: false,
        }),
        getSession: async () => activeSession,
        getActiveSessions: () => new Map(),
      } as never,
      tracker: createQueryRuntimeTracker(),
    })

    const begin = handlers.get('tx.begin')!
    const rollback = handlers.get('tx.rollback')!
    const commit = handlers.get('tx.commit')!
    const setAutoCommit = handlers.get('tx.setAutoCommit')!
    const runQuery = handlers.get('query.run')!

    // 1. Missing panelId must be rejected with forbidden on begin, commit, rollback (!onlyIfOwner), setAutoCommit
    await expect(begin({ connectionId: 'pg1' }, undefined)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(commit({ connectionId: 'pg1' }, undefined)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(rollback({ connectionId: 'pg1' }, undefined)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(setAutoCommit({ connectionId: 'pg1', enabled: false }, undefined)).rejects.toMatchObject({
      code: 'forbidden',
    })

    // 2. Panel A starts tx1 -> returns monotonic txToken
    const tx1 = (await begin({ connectionId: 'pg1' }, { panel: { id: 'panel-A' } })) as TransactionState
    expect(tx1.active).toBe(true)
    expect(typeof tx1.txToken).toBe('number')

    const statusHandler = handlers.get('tx.status')!
    const statusNoPanel = (await statusHandler({ connectionId: 'pg1' }, undefined)) as TransactionState
    expect(statusNoPanel.txToken).toBeUndefined()
    const statusOwner = (await statusHandler(
      { connectionId: 'pg1' },
      { panel: { id: 'panel-A' } }
    )) as TransactionState
    expect(statusOwner.txToken).toBe(tx1.txToken)
    const statusOtherPanel = (await statusHandler(
      { connectionId: 'pg1' },
      { panel: { id: 'panel-B' } }
    )) as TransactionState
    expect(statusOtherPanel.txToken).toBeUndefined()

    // 3. Panel B cannot hijack via setAutoCommit, begin, rollback, commit, or SQL COMMIT/ROLLBACK
    await expect(
      setAutoCommit({ connectionId: 'pg1', enabled: false }, { panel: { id: 'panel-B' } })
    ).rejects.toMatchObject({ code: 'forbidden' })
    await expect(
      begin({ connectionId: 'pg1' }, { panel: { id: 'panel-B' } })
    ).rejects.toMatchObject({ code: 'forbidden' })
    const afterPassiveRollback = (await rollback(
      { connectionId: 'pg1', onlyIfOwner: true, txToken: tx1.txToken },
      { panel: { id: 'panel-B' } }
    )) as TransactionState
    expect(afterPassiveRollback.active).toBe(true)
    expect(activeSession.rollbackTransaction).not.toHaveBeenCalled()
    await expect(
      rollback({ connectionId: 'pg1' }, { panel: { id: 'panel-B' } })
    ).rejects.toMatchObject({ code: 'forbidden' })
    await expect(
      commit({ connectionId: 'pg1' }, { panel: { id: 'panel-B' } })
    ).rejects.toMatchObject({ code: 'forbidden' })
    await expect(
      runQuery({ connectionId: 'pg1', queryId: 'q_b_commit', sql: 'COMMIT;' }, { panel: { id: 'panel-B' } })
    ).rejects.toMatchObject({ code: 'forbidden' })
    await expect(
      runQuery({ connectionId: 'pg1', queryId: 'q_b_rb', sql: 'ROLLBACK;' }, { panel: { id: 'panel-B' } })
    ).rejects.toMatchObject({ code: 'forbidden' })

    // 4. Panel A commits tx1 and opens tx2 -> stale txToken from tx1 MUST NOT roll back tx2!
    const committed = (await commit({ connectionId: 'pg1' }, { panel: { id: 'panel-A' } })) as TransactionState
    expect(committed.active).toBe(false)
    const tx2 = (await begin({ connectionId: 'pg1' }, { panel: { id: 'panel-A' } })) as TransactionState
    expect(tx2.txToken).toBeGreaterThan(tx1.txToken!)

    const staleRollback = (await rollback(
      { connectionId: 'pg1', onlyIfOwner: true, txToken: tx1.txToken },
      { panel: { id: 'panel-A' } }
    )) as TransactionState
    expect(staleRollback.active).toBe(true)
    expect(activeSession.rollbackTransaction).not.toHaveBeenCalled()

    const matchingRollback = (await rollback(
      { connectionId: 'pg1', onlyIfOwner: true, txToken: tx2.txToken },
      { panel: { id: 'panel-A' } }
    )) as TransactionState
    expect(matchingRollback.active).toBe(false)
    expect(activeSession.rollbackTransaction).toHaveBeenCalledTimes(1)

    // 5. Panel A opens tx via SQL BEGIN -> acquires ownership; Panel B blocked from SQL ROLLBACK
    await runQuery({ connectionId: 'pg1', queryId: 'q_a_begin', sql: 'BEGIN;' }, { panel: { id: 'panel-A' } })
    expect(txState.active).toBe(true)
    await expect(
      runQuery({ connectionId: 'pg1', queryId: 'q_b_rb2', sql: 'ROLLBACK;' }, { panel: { id: 'panel-B' } })
    ).rejects.toMatchObject({ code: 'forbidden' })

    // 6. Session replacement (sessionRef !== session) clears stale ownership
    txState = { supported: true, autoCommit: true, active: false, statementCount: 0 }
    activeSession = makeMockSession()
    const tx3 = (await begin({ connectionId: 'pg1' }, { panel: { id: 'panel-B' } })) as TransactionState
    expect(tx3.active).toBe(true)
  })

  it('sends onlyIfOwner + txToken from TransactionToolbarController, chains in-flight begin cleanup, and rolls back before clearing activeConnectionId in Studio destroy()', async () => {
    const rpcCalls: Array<{ method: string; payload?: Record<string, unknown> }> = []
    let activeConnId: string | null = 'pg1'
    let resolveInFlightBegin: ((val: TransactionState) => void) | null = null

    const ctrl = new TransactionToolbarController({
      getActiveConnectionId: () => activeConnId,
      getActiveConnection: () => ({ id: 'pg1', name: 'PG', driver: 'postgres', database: 'app' }),
      isReadOnly: () => false,
      isQueryRunning: () => false,
      isShowingSqlResult: () => false,
      getActiveTable: () => null,
      getCurrentPage: () => 1,
      requestPlugin: async <T>(method: string, payload?: Record<string, unknown>) => {
        rpcCalls.push({ method, payload })
        if (method === 'tx.begin' && resolveInFlightBegin === null && payload?.connectionId === 'pg_inflight') {
          return (await new Promise<TransactionState>((resolve) => {
            resolveInFlightBegin = resolve
          })) as unknown as T
        }
        return {
          supported: true,
          autoCommit: false,
          active: true,
          statementCount: 1,
          txToken: 42,
        } as unknown as T
      },
      reloadTableData: () => {},
      showErrorBanner: () => {},
      updateStatus: () => {},
    })

    await ctrl.refreshState('pg1')
    ctrl.resetForConnectionSwitch('pg1')
    expect(rpcCalls).toContainEqual({
      method: 'tx.rollback',
      payload: { connectionId: 'pg1', onlyIfOwner: true, txToken: 42 },
    })

    rpcCalls.length = 0
    await ctrl.refreshState('pg1')
    activeConnId = 'pg1'
    ctrl.rollbackOnUnload()
    expect(rpcCalls).toContainEqual({
      method: 'tx.rollback',
      payload: { connectionId: 'pg1', onlyIfOwner: true, txToken: 42 },
    })

    // In-flight begin during rollbackOnUnload / destroy must chain rollback with exact txToken after begin settles
    const rpcCalls2: Array<{ method: string; payload?: Record<string, unknown> }> = []
    let resolveBegin2: ((val: TransactionState) => void) | null = null
    const ctrl2 = new TransactionToolbarController({
      getActiveConnectionId: () => 'pg2',
      getActiveConnection: () => ({ id: 'pg2', name: 'PG2', driver: 'postgres', database: 'app' }),
      isReadOnly: () => false,
      isQueryRunning: () => false,
      isShowingSqlResult: () => false,
      getActiveTable: () => null,
      getCurrentPage: () => 1,
      requestPlugin: async <T>(method: string, payload?: Record<string, unknown>) => {
        rpcCalls2.push({ method, payload })
        if (method === 'tx.status') {
          return { supported: true, autoCommit: true, active: false, statementCount: 0 } as unknown as T
        }
        if (method === 'tx.begin') {
          return (await new Promise<TransactionState>((resolve) => {
            resolveBegin2 = resolve
          })) as unknown as T
        }
        return { supported: true, autoCommit: true, active: false, statementCount: 0 } as unknown as T
      },
      reloadTableData: () => {},
      showErrorBanner: () => {},
      updateStatus: () => {},
    })
    await ctrl2.refreshState('pg2')
    const beginPromise = ctrl2.begin()
    // Wait a microtask so tx.begin RPC has been dispatched
    await Promise.resolve()
    ctrl2.rollbackOnUnload()
    ctrl2.destroy()
    resolveBegin2!({ supported: true, autoCommit: true, active: true, statementCount: 0, txToken: 77 })
    await beginPromise
    expect(rpcCalls2).toContainEqual({
      method: 'tx.rollback',
      payload: { connectionId: 'pg2', onlyIfOwner: true, txToken: 77 },
    })

    // Verify Studio destroy() calls txToolbar.rollbackOnUnload() BEFORE this.activeConnectionId = null
    const indexSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'editor', 'index.ts'), 'utf8')
    const destroyStart = indexSrc.indexOf('public destroy(): void {')
    expect(destroyStart).toBeGreaterThan(0)
    const destroyBlock = indexSrc.slice(destroyStart, destroyStart + 1400)
    const rollbackIdx = destroyBlock.indexOf('this.txToolbar.rollbackOnUnload()')
    const nullConnIdx = destroyBlock.indexOf('this.activeConnectionId = null')
    expect(rollbackIdx).toBeGreaterThan(0)
    expect(nullConnIdx).toBeGreaterThan(rollbackIdx)
  })

  it('wires schema-inspector.ts, panel-structure.js, and panel-data-grid.js cleanly without row_ page-index fallback', () => {
    const inspectorSrc = fs.readFileSync(
      path.join(process.cwd(), 'src', 'editor', 'schema-inspector.ts'),
      'utf8'
    )
    expect(inspectorSrc).toContain('isManualTxActive?: () => boolean')
    expect(inspectorSrc).toContain('SQLITE_REBUILD_ACTIVE_TX_ERROR')
    expect(inspectorSrc).toContain("idx.origin === 'u'")
    expect(inspectorSrc).toContain('buildDraftWithOriginAndTriggers')
    expect(inspectorSrc).toContain('inboundForeignKeys')
    expect(inspectorSrc).toContain('columnSpecs')

    const panelStructSrc = fs.readFileSync(
      path.join(process.cwd(), 'src', 'panel', 'panel-structure.js'),
      'utf8'
    )
    expect(panelStructSrc).toContain("idx.origin === 'u'")
    expect(panelStructSrc).toContain("rpc('tx.status'")
    expect(panelStructSrc).toContain('nextDraft.triggers')
    expect(panelStructSrc).toContain('inboundForeignKeys')

    const panelGridSrc = fs.readFileSync(
      path.join(process.cwd(), 'src', 'panel', 'panel-data-grid.js'),
      'utf8'
    )
    expect(panelGridSrc).toContain('originalRow: { ...entry.data }')
    expect(panelGridSrc).toContain('deletes, deleteRows')
    const buildPayloadStart = panelGridSrc.indexOf('function buildDataChangesPayload()')
    expect(buildPayloadStart).toBeGreaterThan(0)
    const buildPayloadBlock = panelGridSrc.slice(buildPayloadStart, buildPayloadStart + 1400)
    expect(buildPayloadBlock).not.toContain("startsWith('row_')")
    expect(buildPayloadBlock).not.toContain('pdRows')
  })

  it('Wave 2 regressions (#48 Bug 1, #49 Bug 4, #50 Bugs 3/8/10/11, #51 Bug 2, #53 Bugs 2/13)', async () => {
    // 1. #48 Bug 1: MongoDB read-only vs mutating statement classification
    expect(isMutatingStatement('show dbs', 'mongodb')).toBe(false)
    expect(isMutatingStatement('show databases', 'mongodb')).toBe(false)
    expect(isMutatingStatement('show collections', 'mongodb')).toBe(false)
    expect(isMutatingStatement('show tables', 'mongodb')).toBe(false)
    expect(isMutatingStatement('use analytics', 'mongodb')).toBe(false)
    expect(isMutatingStatement('db.stats()', 'mongodb')).toBe(false)
    expect(isMutatingStatement('db.serverStatus()', 'mongodb')).toBe(false)
    expect(isMutatingStatement('db.getCollectionNames()', 'mongodb')).toBe(false)
    expect(isMutatingStatement('db.users.find({ active: true }).sort({ id: -1 }).limit(10)', 'mongodb')).toBe(false)
    expect(isMutatingStatement('db.users.findOne({ id: 1 })', 'mongodb')).toBe(false)
    expect(isMutatingStatement('db.users.aggregate([{ $match: { active: true } }])', 'mongodb')).toBe(false)
    expect(isMutatingStatement('db.users.countDocuments({})', 'mongodb')).toBe(false)
    expect(isMutatingStatement('db.users.estimatedDocumentCount()', 'mongodb')).toBe(false)
    expect(isMutatingStatement("db.users.distinct('role')", 'mongodb')).toBe(false)
    expect(isMutatingStatement('db.users.getIndexes()', 'mongodb')).toBe(false)
    expect(isMutatingStatement('db.users.stats()', 'mongodb')).toBe(false)
    expect(isMutatingStatement("db.users.find({}).explain('queryPlanner')", 'mongodb')).toBe(false)
    expect(isMutatingStatement("db.users.explain('queryPlanner').find({})", 'mongodb')).toBe(false)
    expect(isMutatingStatement("db.getCollection('users').find({ active: true })", 'mongodb')).toBe(false)
    expect(isMutatingStatement("db['orders'].countDocuments()", 'mongodb')).toBe(false)
    expect(isMutatingStatement('{ "ping": 1 }', 'mongodb')).toBe(false)
    expect(isMutatingStatement("{ find: 'users' }", 'mongodb')).toBe(false)
    expect(isMutatingStatement('{ "aggregate": "users", "pipeline": [{ "$match": {} }] }', 'mongodb')).toBe(false)
    expect(isMutatingStatement('{ "explain": { "find": "users" } }', 'mongodb')).toBe(false)
    expect(isMutatingStatement('users', 'mongodb')).toBe(false)

    expect(isMutatingStatement('db.users.insertOne({ name: "a" })', 'mongodb')).toBe(true)
    expect(isMutatingStatement("db.getCollection('users').deleteMany({})", 'mongodb')).toBe(true)
    expect(isMutatingStatement('db.users.drop()', 'mongodb')).toBe(true)
    expect(isMutatingStatement("db.users.aggregate([{ $out: 'copy' }])", 'mongodb')).toBe(true)
    expect(isMutatingStatement("db.users.aggregate([{ $merge: { into: 'copy' } }])", 'mongodb')).toBe(true)
    expect(isMutatingStatement('db.dropDatabase()', 'mongodb')).toBe(true)
    expect(isMutatingStatement('db.runCommand({ insert: "users" })', 'mongodb')).toBe(true)
    expect(isMutatingStatement('{ "aggregate": "users", "pipeline": [{ "$out": "copy" }] }', 'mongodb')).toBe(true)

    // 2. #50 Bugs 3 & 11 + #53 Bug 2: MSSQL bracket placeholder, filter bracket scanning, Oracle EXPLAIN PLAN FOR
    expect(stripCommentsAndLiterals('SELECT * INTO [dbo].[copy_users] FROM [dbo].[users];', 'mssql')).toContain('INTO')
    expect(isMutatingStatement('SELECT * INTO [dbo].[copy_users] FROM [dbo].[users];', 'mssql')).toBe(true)
    expect(sanitizeFilterClause("[col;name] = 'ok' AND [col--2] > 0", 'mssql')).toBe(
      "[col;name] = 'ok' AND [col--2] > 0"
    )
    expect(isExplainTargetMutating('EXPLAIN PLAN FOR DELETE FROM users', 'oracle')).toBe(true)
    expect(isMutatingStatement('EXPLAIN PLAN FOR DELETE FROM users', 'oracle')).toBe(true)
    expect(
      isExplainTargetMutating(
        "EXPLAIN PLAN SET STATEMENT_ID = 's1' INTO plan_tbl FOR SELECT 1 FROM DUAL",
        'oracle'
      )
    ).toBe(false)
    expect(
      isMutatingStatement(
        "EXPLAIN PLAN SET STATEMENT_ID = 's1' INTO plan_tbl FOR SELECT 1 FROM DUAL",
        'oracle'
      )
    ).toBe(false)

    // 3. #53 Bug 13: DB_SPECIFIC_SCHEMES includes mssql/sqlserver/oracle/oracledb/mongodb/mongodb+srv
    expect(detectRecognizableSqlCredential("'mssql://sa:SecretPass1!@sql.example.com/app'")).toBe('db-uri-credential')
    expect(detectRecognizableSqlCredential("'sqlserver://sa:SecretPass1!@sql.example.com/app'")).toBe(
      'db-uri-credential'
    )
    expect(detectRecognizableSqlCredential("'oracle://hr:SecretPass1!@ora.example.com/FREEPDB1'")).toBe(
      'db-uri-credential'
    )
    expect(detectRecognizableSqlCredential("'oracledb://hr:SecretPass1!@ora.example.com/FREEPDB1'")).toBe(
      'db-uri-credential'
    )
    expect(detectRecognizableSqlCredential("'mongodb://app:SecretPass1!@mongo.example.com/db'")).toBe(
      'db-uri-credential'
    )
    expect(detectRecognizableSqlCredential("'mongodb+srv://app:SecretPass1!@cluster.example.com/db'")).toBe(
      'db-uri-credential'
    )

    // 4. #51 Bug 2: rewriteSqliteTriggerTargetTable when trigger name contains `begin`
    const trgBeginDetails: TableDetails = {
      name: 'old_items',
      schema: 'main',
      kind: 'table',
      columns: [
        { name: 'id', type: 'INTEGER', nativeType: 'INTEGER', nullable: false, defaultValue: null, isPrimaryKey: true, isAutoIncrement: true },
        { name: 'note', type: 'TEXT', nativeType: 'TEXT', nullable: true, defaultValue: null, isPrimaryKey: false, isAutoIncrement: false },
      ],
      primaryKey: ['id'],
      indexes: [],
      foreignKeys: [],
      triggers: [
        {
          name: 'trg begin',
          sql: 'CREATE TRIGGER "trg begin" AFTER INSERT ON "old_items" FOR EACH ROW BEGIN UPDATE stats SET c = c + 1; END;',
        },
      ],
    }
    const trgBeginDraft = createInitialTableDraft(trgBeginDetails, 'sqlite')
    trgBeginDraft.tableName = 'new_items'
    trgBeginDraft.columns[1].dataType = 'VARCHAR(50)'
    const trgBeginValidation = validateTableStructureDraft(trgBeginDraft, 'sqlite')
    expect(trgBeginValidation.errors).toEqual([])
    const rebuildStmts = buildTableMigrationSql(trgBeginDraft, 'sqlite')
    expect(rebuildStmts.some((s) => s.includes('ON "new_items"'))).toBe(true)

    // 5. #50 Bugs 8 & 10: MSSQL unchanged default vs clearing default + MSSQL/Oracle PK changes
    const mssqlAlterNoDefChange: TableDetails = {
      name: 'orders',
      schema: 'dbo',
      kind: 'table',
      columns: [
        { name: 'id', type: 'INT', nativeType: 'INT', nullable: false, defaultValue: null, isPrimaryKey: true, isAutoIncrement: true },
        { name: 'status', type: 'NVARCHAR(50)', nativeType: 'NVARCHAR(50)', nullable: false, defaultValue: "'NEW'", isPrimaryKey: false, isAutoIncrement: false },
      ],
      primaryKey: ['id'],
      indexes: [{ name: 'PK_orders', isUnique: true, isPrimary: true, columns: ['id'], origin: 'pk' }],
      foreignKeys: [],
    }
    const mssqlKeepDefDraft = createInitialTableDraft(mssqlAlterNoDefChange, 'mssql')
    mssqlKeepDefDraft.columns[1].nullable = true
    const mssqlKeepDefStmts = buildTableMigrationSql(mssqlKeepDefDraft, 'mssql')
    expect(mssqlKeepDefStmts.some((s) => s.includes('ALTER COLUMN [status]'))).toBe(true)
    expect(mssqlKeepDefStmts.some((s) => /\bADD\b[\s\S]*\bDEFAULT\b/i.test(s))).toBe(false)

    const mssqlClearDefDraft = createInitialTableDraft(mssqlAlterNoDefChange, 'mssql')
    mssqlClearDefDraft.columns[1].defaultValue = ''
    const mssqlClearDefStmts = buildTableMigrationSql(mssqlClearDefDraft, 'mssql')
    expect(mssqlClearDefStmts.some((s) => s.includes('DROP CONSTRAINT'))).toBe(true)
    expect(mssqlClearDefStmts.some((s) => /\bADD\b[\s\S]*\bDEFAULT\b/i.test(s))).toBe(false)

    const directClearDefSql = buildAlterTableSql(
      { kind: 'alterColumn', table: 'orders', schema: 'dbo', columnName: 'status', defaultValue: '' },
      'mssql'
    )
    expect(directClearDefSql).toContain('DROP CONSTRAINT')

    const mssqlPkChangeDraft = createInitialTableDraft(mssqlAlterNoDefChange, 'mssql')
    mssqlPkChangeDraft.columns[0].isPrimaryKey = false
    mssqlPkChangeDraft.columns[1].isPrimaryKey = true
    const mssqlPkStmts = buildTableMigrationSql(mssqlPkChangeDraft, 'mssql')
    expect(mssqlPkStmts).toContain('ALTER TABLE [dbo].[orders] DROP CONSTRAINT [PK_orders];')
    expect(mssqlPkStmts).toContain('ALTER TABLE [dbo].[orders] ADD PRIMARY KEY ([status]);')

    const oraclePkDetails: TableDetails = {
      name: 'ORDERS',
      schema: 'HR',
      kind: 'table',
      columns: [
        { name: 'ID', type: 'NUMBER(10)', nativeType: 'NUMBER(10)', nullable: false, defaultValue: null, isPrimaryKey: true, isAutoIncrement: false },
        { name: 'CODE', type: 'VARCHAR2(30)', nativeType: 'VARCHAR2(30)', nullable: false, defaultValue: null, isPrimaryKey: false, isAutoIncrement: false },
      ],
      primaryKey: ['ID'],
      indexes: [{ name: 'PK_ORDERS', isUnique: true, isPrimary: true, columns: ['ID'], origin: 'pk' }],
      foreignKeys: [],
    }
    const oraclePkDraft = createInitialTableDraft(oraclePkDetails, 'oracle')
    oraclePkDraft.columns[0].isPrimaryKey = false
    oraclePkDraft.columns[1].isPrimaryKey = true
    const oraclePkStmts = buildTableMigrationSql(oraclePkDraft, 'oracle')
    expect(oraclePkStmts).toContain('ALTER TABLE "HR"."ORDERS" DROP CONSTRAINT "PK_ORDERS";')
    expect(oraclePkStmts).toContain('ALTER TABLE "HR"."ORDERS" ADD PRIMARY KEY ("CODE");')

    // 6. #49 Bug 4: ClickHouse URL credential strip & ClickHouse/D1/Redis error scrubbing
    expect(
      normalizeClickHouseBaseUrl({
        id: 'ch_url',
        name: 'CH',
        type: 'clickhouse',
        url: 'https://alice:TopSecret99@ch.example.com:8443/default',
      })
    ).toBe('https://ch.example.com:8443/default')
    expect(
      normalizeClickHouseBaseUrl(
        {
          id: 'ch_url2',
          name: 'CH',
          type: 'clickhouse',
          url: 'clickhouses://alice:TopSecret99@ch.example.com:8443',
          sslMode: 'disable',
        },
        false
      )
    ).toBe('http://ch.example.com:8443')

    const chDriver = new ClickHouseDriver()
    vi.spyOn(ClickHouseSession.prototype, 'test').mockRejectedValueOnce(
      new Error('connect failed to https://chuser:ChSecret!@ch.example.com:8443/?password=SecretQuery#tok=hashSec')
    )
    const chTest = await chDriver.testConnection({ id: 'ch_e', name: 'CH', type: 'clickhouse', host: 'localhost' })
    expect(chTest.ok).toBe(false)
    expect(chTest.message).not.toContain('ChSecret!')
    expect(chTest.message).not.toContain('SecretQuery')
    expect(chTest.message).not.toContain('hashSec')

    const d1Driver = new D1Driver()
    vi.spyOn(D1Session.prototype, 'test').mockRejectedValueOnce(
      new Error('POST https://user:D1Secret@api.cloudflare.com?token=CF_SECRET_TOKEN failed')
    )
    const d1Test = await d1Driver.testConnection({
      id: 'd1_e',
      name: 'D1',
      type: 'd1',
      d1AccountId: 'acc',
      d1DatabaseId: 'db',
    })
    expect(d1Test.ok).toBe(false)
    expect(d1Test.message).not.toContain('D1Secret')
    expect(d1Test.message).not.toContain('CF_SECRET_TOKEN')

    const redisDriver = new RedisDriver()
    const redisTest = await redisDriver.testConnection({
      id: 'rd_e',
      name: 'Redis',
      type: 'redis',
      url: 'redis://default:RedisSuperSecret@127.0.0.1:1',
    })
    expect(redisTest.ok).toBe(false)
    expect(redisTest.message).not.toContain('RedisSuperSecret')
  })

  it('Wave 3 regressions (#69 Bug 1, #70 Bug 5, #71 Bugs 3/4/5/7/8, #72 Bugs 2/3)', async () => {
    // 1. #71 Bug 3 & #69 Bug 1: braced ADO.NET passwords, Bearer/Basic headers, preserve ?authSource=admin
    const scrubbedErr = scrubDriverErrorText(
      'Failed Pwd={p@ss;1}; with Bearer eyJHeader.Payload.Sig123 and Basic dXNlcjpwYXNz on mongodb+srv://u:p@cluster/db?authSource=admin&authMechanism=SCRAM-SHA-256&token=SecTok#auth_token=FragTok'
    )
    expect(scrubbedErr).toContain('Pwd=[REDACTED];')
    expect(scrubbedErr).not.toContain('p@ss;1')
    expect(scrubbedErr).not.toContain(';1};')
    expect(scrubbedErr).not.toContain('eyJHeader.Payload.Sig123')
    expect(scrubbedErr).not.toContain('dXNlcjpwYXNz')
    expect(scrubbedErr).not.toContain('SecTok')
    expect(scrubbedErr).not.toContain('FragTok')
    expect(scrubbedErr).toContain('authSource=admin')
    expect(scrubbedErr).toContain('authMechanism=SCRAM-SHA-256')

    // 2. #71 Bug 4: parenthesized statements after EXPLAIN PLAN ... FOR must not be skipped as PG options
    expect(isExplainTargetMutating('EXPLAIN PLAN FOR (UPDATE t SET a = 1)', 'oracle')).toBe(true)
    expect(isMutatingStatement('EXPLAIN PLAN FOR (UPDATE t SET a = 1)', 'oracle')).toBe(true)
    expect(
      isExplainTargetMutating(
        "EXPLAIN PLAN SET STATEMENT_ID = 'w2' INTO my_plan FOR (DELETE FROM t)",
        'oracle'
      )
    ).toBe(true)
    expect(
      isMutatingStatement(
        "EXPLAIN PLAN SET STATEMENT_ID = 'w2' INTO my_plan FOR (DELETE FROM t)",
        'oracle'
      )
    ).toBe(true)
    expect(isMutatingStatement('EXPLAIN (ANALYZE FALSE, VERBOSE) SELECT 1', 'postgres')).toBe(false)

    // 3. #71 Bug 5: WITH CTE containing SELECT ... INTO [dbo].[w2_copy] / #tmp
    expect(
      isMutatingStatement(
        'WITH c AS (SELECT 1 AS a) SELECT * INTO [dbo].[w2_copy] FROM c',
        'mssql'
      )
    ).toBe(true)
    expect(
      isMutatingStatement(
        'WITH c AS (SELECT * FROM src) SELECT * INTO #tmp FROM c',
        'mssql'
      )
    ).toBe(true)
    expect(
      isMutatingStatement('WITH c AS (SELECT * FROM src) SELECT * FROM c', 'mssql')
    ).toBe(false)

    // 4. #71 Bug 7: MSSQL dropping defaults on multiple colliding columns emits distinct @df_ variables
    const mssqlCollideDetails: TableDetails = {
      name: 'items',
      schema: 'dbo',
      kind: 'table',
      columns: [
        { name: 'id', type: 'INT', nativeType: 'INT', nullable: false, defaultValue: null, isPrimaryKey: true, isAutoIncrement: true },
        { name: 'col-1', type: 'INT', nativeType: 'INT', nullable: true, defaultValue: '0', isPrimaryKey: false, isAutoIncrement: false },
        { name: 'col_1', type: 'INT', nativeType: 'INT', nullable: true, defaultValue: '1', isPrimaryKey: false, isAutoIncrement: false },
      ],
      primaryKey: ['id'],
      indexes: [],
      foreignKeys: [],
    }
    const mssqlCollideDraft = createInitialTableDraft(mssqlCollideDetails, 'mssql')
    mssqlCollideDraft.columns[1].defaultValue = ''
    mssqlCollideDraft.columns[2].defaultValue = ''
    const mssqlCollideStmts = buildTableMigrationSql(mssqlCollideDraft, 'mssql')
    expect(mssqlCollideStmts).toHaveLength(2)
    const declMatches = mssqlCollideStmts.map((s) => /DECLARE (@df_[A-Za-z0-9_]+)/.exec(s)?.[1])
    expect(declMatches[0]).toBeTruthy()
    expect(declMatches[1]).toBeTruthy()
    expect(declMatches[0]).not.toBe(declMatches[1])

    // 5. #71 Bug 8: reconstructTableDdl omits ISEQ$$_*.nextval DEFAULT when Oracle identity column
    const oraIdentityDdl = reconstructTableDdl(
      {
        name: 'IDENT_TBL',
        schema: 'HR',
        kind: 'table',
        columns: [
          {
            name: 'ID',
            type: 'NUMBER(10)',
            nativeType: 'NUMBER(10)',
            nullable: false,
            defaultValue: '"HR"."ISEQ$$_445566".nextval',
            isPrimaryKey: true,
            isAutoIncrement: true,
          },
        ],
        primaryKey: ['ID'],
        indexes: [],
        foreignKeys: [],
      },
      'oracle'
    )
    expect(oraIdentityDdl).toContain('GENERATED BY DEFAULT AS IDENTITY')
    expect(oraIdentityDdl).not.toContain('ISEQ$$_445566')

    // 6. #72 Bug 2: rewriteSqliteTriggerTargetTable ignores comments containing `ON old_tbl BEGIN`
    const cmtTriggerDetails: TableDetails = {
      name: 'w2_r1_old_sched2',
      schema: 'main',
      kind: 'table',
      columns: [
        { name: 'id', type: 'INTEGER', nativeType: 'INTEGER', nullable: false, defaultValue: null, isPrimaryKey: true, isAutoIncrement: true },
        { name: 'note', type: 'TEXT', nativeType: 'TEXT', nullable: true, defaultValue: null, isPrimaryKey: false, isAutoIncrement: false },
      ],
      primaryKey: ['id'],
      indexes: [],
      foreignKeys: [],
      triggers: [
        {
          name: 'trg_cmt',
          sql: "CREATE TRIGGER trg_cmt /* comment ON w2_r1_old_sched2 BEGIN */ AFTER INSERT ON w2_r1_old_sched2 BEGIN INSERT INTO w2_r1_trg_audit2(val) VALUES ('ins'); END;",
        },
      ],
    }
    const cmtTriggerDraft = createInitialTableDraft(cmtTriggerDetails, 'sqlite')
    cmtTriggerDraft.tableName = 'w2_r1_new_sched2'
    cmtTriggerDraft.columns[1].dataType = 'VARCHAR(50)'
    const cmtStmts = buildTableMigrationSql(cmtTriggerDraft, 'sqlite')
    const rewrittenTrg = cmtStmts.find((s) => s.includes('CREATE TRIGGER trg_cmt')) || ''
    expect(rewrittenTrg).toContain('/* comment ON w2_r1_old_sched2 BEGIN */')
    expect(rewrittenTrg).toContain('AFTER INSERT ON "w2_r1_new_sched2" BEGIN')

    // 7. #72 Bug 3: LibsqlSession scrubs Bearer/Basic tokens while preserving authSource
    const libsqlSession = new LibsqlSession({
      id: 'lib_scrub',
      name: 'LibSQL',
      type: 'libsql',
      url: 'http://127.0.0.1:59999?authSource=admin',
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
      new Error('Authorization: Bearer eyJLibSecret.Payload.Sig failed at http://127.0.0.1:59999?authSource=admin')
    )
    try {
      let libErrMsg = ''
      try {
        await libsqlSession.applyChanges({
          table: 'users',
          schema: 'main',
          inserts: [{ id: 1, name: 'A' }],
        })
      } catch (err: unknown) {
        libErrMsg = err instanceof Error ? err.message : String(err)
      }
      expect(libErrMsg).toBeTruthy()
      expect(libErrMsg).not.toContain('eyJLibSecret.Payload.Sig')
      expect(libErrMsg).toContain('authSource=admin')
    } finally {
      fetchMock.mockRestore()
      await libsqlSession.close()
    }

    // 8. #70 Bug 5: RedisSession.runQuery scrubs credential strings from thrown errors
    const redisSession = new RedisSession(
      {
        id: 'rd_run_err',
        name: 'Redis',
        type: 'redis',
        host: '127.0.0.1',
        port: 1,
      },
      'SecPass'
    )
    const spyOpen = vi
      .spyOn(redisSession as unknown as { openAuthenticatedClient: () => Promise<never> }, 'openAuthenticatedClient')
      .mockRejectedValueOnce(
        new Error('dial redis://default:RedisRunSecret!@127.0.0.1:6379?password=QPwd&Pwd={Br@ce}')
      )
    try {
      let rdMsg = ''
      try {
        await redisSession.runQuery('rq_1', 'PING')
      } catch (err: unknown) {
        rdMsg = err instanceof Error ? err.message : String(err)
      }
      expect(rdMsg).toBeTruthy()
      expect(rdMsg).not.toContain('RedisRunSecret!')
      expect(rdMsg).not.toContain('QPwd')
      expect(rdMsg).not.toContain('Br@ce')
    } finally {
      spyOpen.mockRestore()
      await redisSession.close()
    }
  })

  it('Wave 3 regressions (#92 Bugs 1-3, #93 Bugs 2-3)', () => {
    // 1. #92 Bug 1: Iterative WITH CTE guard without infinite recursion
    expect(isMutatingStatement('WITH c AS (SELECT 1) EXEC sp_help', 'mssql')).toBe(true)
    expect(isMutatingStatement('WITH c AS (SELECT 1) EXECUTE sp_who2', 'mssql')).toBe(true)
    expect(isMutatingStatement('WITH c AS (SELECT 1) CALL do_write()', 'postgres')).toBe(true)
    expect(
      isMutatingStatement('WITH c AS (SELECT 1 AS a) (SELECT * INTO [dbo].[w3_copy] FROM c)', 'mssql')
    ).toBe(true)
    expect(
      isExplainTargetMutating(
        'EXPLAIN WITH c AS (SELECT 1 AS a) (SELECT * INTO [dbo].[w3_copy] FROM c)',
        'mssql'
      )
    ).toBe(true)
    expect(isMutatingStatement('WITH c AS (SELECT 1)', 'postgres')).toBe(true)
    expect(isMutatingStatement('WITH c AS (SELECT 1', 'postgres')).toBe(true)
    expect(isMutatingStatement('WITH c AS () SELECT * FROM c', 'postgres')).toBe(true)
    expect(
      isMutatingStatement('WITH c AS (SELECT 1) (SELECT * FROM c WHERE a = 1) FOR UPDATE', 'postgres')
    ).toBe(true)
    expect(isMutatingStatement('WITH c AS (SELECT 1) INSERT INTO items VALUES (1)', 'postgres')).toBe(
      true
    )
    expect(isMutatingStatement('WITH c AS (SELECT 1) VALUES (1)', 'postgres')).toBe(false)
    expect(isMutatingStatement('WITH c AS (SELECT 1) TABLE emp', 'postgres')).toBe(false)
    expect(
      isMutatingStatement('WITH c AS (SELECT 1), d AS (SELECT 2) (SELECT * FROM d)', 'postgres')
    ).toBe(false)
    expect(
      isMutatingStatement(
        'WITH RECURSIVE c(n) AS MATERIALIZED (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 3) SELECT * FROM c',
        'postgres'
      )
    ).toBe(false)
    expect(isMutatingStatement('WITH c AS (SELECT 1) SHOW TABLES', 'mysql')).toBe(false)
    expect(isMutatingStatement('SELECT * FROM items WITH (NOLOCK)', 'mssql')).toBe(false)

    // 2. #92 Bug 3: Unique and length-bounded MSSQL [DF_...] constraint names
    const extractDfName = (sql: string): string => {
      const m = /ADD CONSTRAINT \[([^\]]+)\]/i.exec(sql)
      return m ? m[1] : ''
    }
    const dfSqlDash = buildAlterTableSql(
      {
        kind: 'alterColumn',
        table: 'orders',
        columnName: 'col-1',
        defaultValue: '0',
      },
      'mssql'
    )
    const dfSqlUnderscore = buildAlterTableSql(
      {
        kind: 'alterColumn',
        table: 'orders',
        columnName: 'col_1',
        defaultValue: '0',
      },
      'mssql'
    )
    const dfDash = extractDfName(dfSqlDash)
    const dfUnderscore = extractDfName(dfSqlUnderscore)
    expect(dfDash).toMatch(/^DF_/)
    expect(dfUnderscore).toMatch(/^DF_/)
    expect(dfDash).not.toBe(dfUnderscore)
    expect(dfDash.length).toBeLessThanOrEqual(128)
    expect(dfUnderscore.length).toBeLessThanOrEqual(128)

    const longTable = `orders_${'x'.repeat(90)}`
    const longColA = `column_${'y'.repeat(90)}_a`
    const longColB = `column_${'y'.repeat(90)}_b`
    const dfLongA = extractDfName(
      buildAlterTableSql(
        {
          kind: 'alterColumn',
          table: longTable,
          columnName: longColA,
          defaultValue: "'a'",
        },
        'mssql'
      )
    )
    const dfLongB = extractDfName(
      buildAlterTableSql(
        {
          kind: 'alterColumn',
          table: longTable,
          columnName: longColB,
          defaultValue: "'b'",
        },
        'mssql'
      )
    )
    expect(dfLongA).toMatch(/^DF_/)
    expect(dfLongB).toMatch(/^DF_/)
    expect(dfLongA).not.toBe(dfLongB)
    expect(dfLongA.length).toBeLessThanOrEqual(128)
    expect(dfLongB.length).toBeLessThanOrEqual(128)

    const collidingDetails: TableDetails = {
      name: 'orders',
      schema: 'dbo',
      kind: 'table',
      columns: [
        { name: 'id', type: 'INT', nativeType: 'INT', nullable: false, defaultValue: null, isPrimaryKey: true, isAutoIncrement: true },
        { name: 'col-1', type: 'INT', nativeType: 'INT', nullable: false, defaultValue: null, isPrimaryKey: false, isAutoIncrement: false },
        { name: 'col_1', type: 'INT', nativeType: 'INT', nullable: false, defaultValue: null, isPrimaryKey: false, isAutoIncrement: false },
      ],
      primaryKey: ['id'],
      indexes: [],
      foreignKeys: [],
    }
    const collidingDraft = createInitialTableDraft(collidingDetails, 'mssql')
    collidingDraft.columns[1].defaultValue = '0'
    collidingDraft.columns[2].defaultValue = '1'
    const collidingMigration = buildTableMigrationSql(collidingDraft, 'mssql')
    const dfConstraints = collidingMigration
      .map((s) => extractDfName(s))
      .filter((n) => n.length > 0)
    expect(dfConstraints).toHaveLength(2)
    expect(new Set(dfConstraints).size).toBe(2)

    // 3. #92 Bug 2 & #93 Bugs 2/3: URI credential scrubbing edge cases
    expect(scrubDriverErrorText('redis://u:dGVzdA==@127.0.0.1:6379/0')).toBe(
      'redis://u@127.0.0.1:6379/0'
    )
    expect(
      scrubDriverErrorText(
        'ClickHouse error: {"url":"http:\\/\\/u:ChRowSecret99@127.0.0.1:8123\\/db\\/0"}'
      )
    ).toBe('ClickHouse error: {"url":"http:\\/\\/u@127.0.0.1:8123\\/db\\/0"}')

    expect(scrubDriverErrorText('redis://u:Pass/Slash#99@127.0.0.1:56379/0?password=Sec99')).toBe(
      'redis://u@127.0.0.1:56379/0?password=[REDACTED]'
    )

    expect(
      scrubDriverErrorText(
        'mongodb+srv://admin:M#1?2@3:4/5@cluster0.example.net/w3_r3_db?authSource=admin&token=secret'
      )
    ).toBe(
      'mongodb+srv://admin@cluster0.example.net/w3_r3_db?authSource=admin&token=[REDACTED]'
    )

    expect(
      scrubDriverErrorText(
        'Failed oracle://hr:Sec!99@ora.example:1521?token=tok123&authSource=admin&Pwd={p@ss;1}'
      )
    ).toBe('Failed oracle://hr@ora.example:1521?token=[REDACTED]&authSource=admin&Pwd=[REDACTED]')

    expect(scrubDriverErrorText('mongodb+srv://u:p@host?authSource=admin&email=a@b')).toBe(
      'mongodb+srv://u@host?authSource=admin&email=a@b'
    )

    expect(scrubDriverErrorText('https://example.com:8443/users/@alice?token=secret&x=1')).toBe(
      'https://example.com:8443/users/@alice?token=[REDACTED]&x=1'
    )
  })

  it('Wave 4 regressions (#111 Bug 2, #113 Bug 1, #114 Bug 1)', async () => {
    // 1. #114 Bug 1: plural `credentials` is a sensitive query key everywhere
    const { SENSITIVE_URL_QUERY_PARAM_RE, scrubUrlCredentials, validateLibsqlEndpointUrl } =
      await import('../src/drivers/common/connection-uri')
    expect(SENSITIVE_URL_QUERY_PARAM_RE.test('credentials')).toBe(true)
    expect(SENSITIVE_URL_QUERY_PARAM_RE.test('credential')).toBe(true)
    expect(SENSITIVE_URL_QUERY_PARAM_RE.test('authSource')).toBe(false)
    const scrubbedUrl = scrubUrlCredentials(
      'postgres://u:p@db.example:5432/app?authSource=admin&credentials=k6#tab=indexes'
    )
    expect(scrubbedUrl).not.toContain('k6')
    expect(scrubbedUrl).toContain('authSource=admin')
    expect(validateLibsqlEndpointUrl('https://db.turso.io?credentials=k6').ok).toBe(false)
    expect(scrubDriverErrorText('https://db.example/x?credentials=k6&authType=iam')).toBe(
      'https://db.example/x?credentials=[REDACTED]&authType=iam'
    )

    // 2. #111 Bug 2: password containing `?a=1` before `@host`, query email preserved
    expect(
      scrubDriverErrorText(
        'mongodb+srv://admin:pass?a=1@cluster0.example.net/w4_r3_db?email=x@y.com'
      )
    ).toBe('mongodb+srv://admin@cluster0.example.net/w4_r3_db?email=x@y.com')
    expect(scrubDriverErrorText('mongodb://u:p/x@mongo-primary?email=a@b.com')).toBe(
      'mongodb://u@mongo-primary?email=a@b.com'
    )
    // Single-label host:port origin without userinfo keeps `/users/@alice`
    expect(scrubDriverErrorText('https://api-server:8443/users/@alice?token=secret')).toBe(
      'https://api-server:8443/users/@alice?token=[REDACTED]'
    )
    // Digit-only password before `/` still redacted when a real host:port follows
    expect(scrubDriverErrorText('redis://u:1234/x@127.0.0.1:6379/0')).toBe(
      'redis://u@127.0.0.1:6379/0'
    )
    // JSON closing quote/brace after a sensitive query value stays intact
    expect(scrubDriverErrorText('{"url":"https://h.example/db?token=t1"}')).toBe(
      '{"url":"https://h.example/db?token=[REDACTED]"}'
    )
    expect(scrubDriverErrorText("{'url':'https://h.example/db?password=t2'}")).toBe(
      "{'url':'https://h.example/db?password=[REDACTED]'}"
    )

    // 3. #113 Bug 1: SQLite/LibSQL/D1 case-only table rename runs through a temp name
    for (const dialect of ['sqlite', 'libsql', 'd1'] as const) {
      const directSql = buildAlterTableSql(
        { kind: 'renameTable', table: 'W4_Case', newTableName: 'w4_case' },
        dialect
      )
      expect(directSql).toBe(
        'ALTER TABLE "W4_Case" RENAME TO "__datanoa_case_rename_tmp";\nALTER TABLE "__datanoa_case_rename_tmp" RENAME TO "w4_case";'
      )
    }
    expect(
      buildAlterTableSql({ kind: 'renameTable', table: 'W4_Case', newTableName: 'w4_other' }, 'sqlite')
    ).toBe('ALTER TABLE "W4_Case" RENAME TO "w4_other";')

    const caseDetails: TableDetails = {
      name: 'W4_Case',
      schema: 'main',
      kind: 'table',
      columns: [
        { name: 'id', type: 'INTEGER', nativeType: 'INTEGER', nullable: false, defaultValue: null, isPrimaryKey: true, isAutoIncrement: false },
        { name: 'label', type: 'TEXT', nativeType: 'TEXT', nullable: true, defaultValue: null, isPrimaryKey: false, isAutoIncrement: false },
      ],
      primaryKey: ['id'],
      indexes: [],
      foreignKeys: [],
    }
    const caseDraft = createInitialTableDraft(caseDetails, 'sqlite')
    caseDraft.tableName = 'w4_case'
    const casePlan = validateTableStructureDraft(caseDraft, 'sqlite', ['W4_Case'])
    expect(casePlan.valid).toBe(true)
    const caseStmts = buildTableMigrationSql(caseDraft, 'sqlite')
    expect(caseStmts).toEqual([
      'ALTER TABLE "W4_Case" RENAME TO "__datanoa_case_rename_tmp";',
      'ALTER TABLE "__datanoa_case_rename_tmp" RENAME TO "w4_case";',
    ])

    const caseDb = new DatabaseSync(':memory:')
    try {
      caseDb.exec('CREATE TABLE "W4_Case" (id INTEGER PRIMARY KEY, label TEXT);')
      caseDb.exec(`INSERT INTO "W4_Case" (id, label) VALUES (1, 'O''Reilly');`)
      expect(() => caseDb.exec('ALTER TABLE "W4_Case" RENAME TO "w4_case";')).toThrow()
      for (const stmt of caseStmts) caseDb.exec(stmt)
      const names = caseDb
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((row) => String((row as { name: unknown }).name))
      expect(names).toEqual(['w4_case'])
      const row = caseDb.prepare('SELECT label FROM "w4_case" WHERE id = 1').get() as
        | { label: unknown }
        | undefined
      expect(row?.label).toBe("O'Reilly")
    } finally {
      caseDb.close()
    }
  })

  it('Wave 5 regressions (#136: URI authority recovery & scrubUrlCredentials, SQLite tmp_2 rename, thread autoCommit on updateCell/applyChanges, exportSchemaDdl no duplicate triggers)', async () => {
    const { parseConnectionUri, scrubUrlCredentials } = await import(
      '../src/drivers/common/connection-uri'
    )

    // 1. parseConnectionUri / parseStandardUrl authority recovery with ?, /, # in password + @ in query/hash
    const p1 = parseConnectionUri(
      'mongodb+srv://admin:pass?a=1@cluster0.example.net/w5_db?email=x@y.com&credentials=c99&authSource=admin'
    )
    expect(p1.ok).toBe(true)
    expect(p1.profile?.host).toBe('cluster0.example.net')
    expect(p1.profile?.database).toBe('w5_db')
    expect(p1.profile?.user).toBe('admin')
    expect(p1.password).toBe('pass?a=1')
    expect(p1.profile?.url).not.toContain('c99')
    expect(p1.profile?.url).toContain('authSource=admin')

    const p2 = parseConnectionUri('mongodb://u:p/x@mongo-primary?email=a@b.com')
    expect(p2.ok).toBe(true)
    expect(p2.profile?.host).toBe('mongo-primary')
    expect(p2.profile?.user).toBe('u')
    expect(p2.password).toBe('p/x')
    expect(p2.profile?.url).toContain('email=a@b.com')

    const p3 = parseConnectionUri('mongodb://u:p@mongo-primary/db#section=a@b.com')
    expect(p3.ok).toBe(true)
    expect(p3.profile?.host).toBe('mongo-primary')
    expect(p3.profile?.database).toBe('db')
    expect(p3.profile?.user).toBe('u')
    expect(p3.password).toBe('p')

    const p4 = parseConnectionUri('https://api-server:8443/users/@alice?token=secret')
    expect(p4.ok).toBe(true)
    expect(p4.profile?.host).toBe('api-server')
    expect(p4.profile?.port).toBe(8443)
    expect(p4.password).toBeUndefined()

    const p5 = parseConnectionUri('redis://u:1234/x@127.0.0.1:6379/0')
    expect(p5.ok).toBe(true)
    expect(p5.profile?.host).toBe('127.0.0.1')
    expect(p5.profile?.port).toBe(6379)
    expect(p5.password).toBe('1234/x')

    const p6 = parseConnectionUri('mongodb://u:p#1@mongo-primary/db?authSource=admin&email=a@b.com')
    expect(p6.ok).toBe(true)
    expect(p6.profile?.host).toBe('mongo-primary')
    expect(p6.profile?.database).toBe('db')
    expect(p6.password).toBe('p#1')

    const p7 = parseConnectionUri('mongodb://u:1234/p@mongo-primary/db?email=a@b.com')
    expect(p7.ok).toBe(true)
    expect(p7.profile?.host).toBe('mongo-primary')
    expect(p7.profile?.database).toBe('db')
    expect(p7.password).toBe('1234/p')

    // 2. scrubUrlCredentials recovers URIs with unencoded ?, /, # in password and preserves authSource/email
    const s1 = scrubUrlCredentials(
      'mongodb+srv://admin:pass?a=1@cluster0.example.net/w5_db?email=x@y.com&credentials=c99&authSource=admin'
    )
    expect(s1).toBe(
      'mongodb+srv://cluster0.example.net/w5_db?email=x@y.com&authSource=admin'
    )
    expect(scrubUrlCredentials('mongodb://u:p/x@mongo-primary?email=a@b.com')).toBe(
      'mongodb://mongo-primary?email=a@b.com'
    )
    expect(scrubUrlCredentials('mongodb://u:p@mongo-primary/db#section=a@b.com')).toBe(
      'mongodb://mongo-primary/db#section=a@b.com'
    )

    // 3. SQLite case-only rename collision guard (__datanoa_case_rename_tmp_2)
    const tmpRenameSql = buildAlterTableSql(
      {
        kind: 'renameTable',
        table: '__DATANOA_CASE_RENAME_TMP',
        newTableName: '__datanoa_case_rename_tmp',
      },
      'sqlite'
    )
    expect(tmpRenameSql).toBe(
      'ALTER TABLE "__DATANOA_CASE_RENAME_TMP" RENAME TO "__datanoa_case_rename_tmp_2";\nALTER TABLE "__datanoa_case_rename_tmp_2" RENAME TO "__datanoa_case_rename_tmp";'
    )
    const tmpDetails: TableDetails = {
      name: '__DATANOA_CASE_RENAME_TMP',
      schema: 'main',
      kind: 'table',
      columns: [
        { name: 'id', type: 'INTEGER', nativeType: 'INTEGER', nullable: false, defaultValue: null, isPrimaryKey: true, isAutoIncrement: false },
      ],
      primaryKey: ['id'],
      indexes: [],
      foreignKeys: [],
    }
    const tmpDraft = createInitialTableDraft(tmpDetails, 'sqlite')
    tmpDraft.tableName = '__datanoa_case_rename_tmp'
    const tmpStmts = buildTableMigrationSql(tmpDraft, 'sqlite')
    expect(tmpStmts).toEqual([
      'ALTER TABLE "__DATANOA_CASE_RENAME_TMP" RENAME TO "__datanoa_case_rename_tmp_2";',
      'ALTER TABLE "__datanoa_case_rename_tmp_2" RENAME TO "__datanoa_case_rename_tmp";',
    ])
    const tmpDb = new DatabaseSync(':memory:')
    try {
      tmpDb.exec('CREATE TABLE "__DATANOA_CASE_RENAME_TMP" (id INTEGER PRIMARY KEY);')
      tmpDb.exec('INSERT INTO "__DATANOA_CASE_RENAME_TMP" (id) VALUES (7);')
      for (const stmt of tmpStmts) tmpDb.exec(stmt)
      const row = tmpDb
        .prepare('SELECT id FROM "__datanoa_case_rename_tmp" WHERE id = 7')
        .get() as { id?: unknown } | undefined
      expect(Number(row?.id)).toBe(7)
    } finally {
      tmpDb.close()
    }

    // 4 & 5. Real SQLite temp DB tests: manual-commit updateCell/applyChanges rollback + exportSchemaDdl replay
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'datanoa-w5-'))
    const dbPath = path.join(tmpDir, 'w5_test.sqlite')
    const seedDb = new DatabaseSync(dbPath)
    seedDb.exec(`
      CREATE TABLE w5_orders (
        id INTEGER PRIMARY KEY,
        label TEXT NOT NULL,
        total INTEGER NOT NULL
      );
      CREATE INDEX idx_w5_orders_total ON w5_orders (total);
      CREATE TABLE w5_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        note TEXT NOT NULL
      );
      CREATE VIEW v_w5_orders AS SELECT id, label, total FROM w5_orders;
      CREATE TRIGGER trg_w5_orders_ins AFTER INSERT ON w5_orders BEGIN
        INSERT INTO w5_audit (note) VALUES ('ins:' || NEW.label);
      END;
      CREATE TRIGGER trg_w5_orders_upd AFTER UPDATE ON w5_orders BEGIN
        INSERT INTO w5_audit (note) VALUES ('upd:' || NEW.label);
      END;
      INSERT INTO w5_orders (id, label, total) VALUES (1, 'init', 100);
    `)
    seedDb.close()

    const sqliteDriver = new SqliteDriver()
    const sqliteSession = await sqliteDriver.createSession({
      id: 'w5_sqlite',
      name: 'W5 SQLite',
      driver: 'sqlite',
      filePath: dbPath,
    })

    try {
      // 4a. setAutoCommit(false) -> updateCell -> rollbackTransaction must undo cleanly
      await sqliteSession.setAutoCommit(false)
      await sqliteSession.updateCell({
        table: 'w5_orders',
        schema: 'main',
        column: 'label',
        newValue: 'edited_cell',
        primaryKeys: { id: 1 },
        originalValue: 'init',
      })
      expect(sqliteSession.getTransactionState().active).toBe(true)
      const rolledBackCell = await sqliteSession.rollbackTransaction()
      expect(rolledBackCell.active).toBe(false)
      expect(rolledBackCell.autoCommit).toBe(false)
      const afterCellRb = await sqliteSession.runQuery(
        'q_check_cell_rb',
        'SELECT label FROM w5_orders WHERE id = 1;'
      )
      expect(afterCellRb.rows).toEqual([['init']])
      await sqliteSession.rollbackTransaction() // clear tx auto-opened by SELECT under autoCommit=false

      // 4b. setAutoCommit(false) -> applyChanges -> rollbackTransaction must undo cleanly
      await sqliteSession.applyChanges({
        table: 'w5_orders',
        schema: 'main',
        inserts: [{ id: 2, label: 'added', total: 200 }],
        updates: [
          {
            primaryKeys: { id: 1 },
            changes: { label: 'updated_batch' },
            originalRow: { id: 1, label: 'init' },
          },
        ],
      })
      expect(sqliteSession.getTransactionState().active).toBe(true)
      const rolledBackBatch = await sqliteSession.rollbackTransaction()
      expect(rolledBackBatch.active).toBe(false)
      const afterBatchRb = await sqliteSession.runQuery(
        'q_check_batch_rb',
        'SELECT id, label FROM w5_orders ORDER BY id ASC;'
      )
      expect(afterBatchRb.rows).toEqual([[1, 'init']])
      await sqliteSession.rollbackTransaction()

      // 4c. setAutoCommit(false) -> applyChanges -> commitTransaction persists, then restore autoCommit
      await sqliteSession.applyChanges({
        table: 'w5_orders',
        schema: 'main',
        inserts: [{ id: 3, label: 'persisted', total: 300 }],
      })
      await sqliteSession.commitTransaction()
      await sqliteSession.setAutoCommit(true)
      const afterCommit = await sqliteSession.runQuery(
        'q_check_commit',
        'SELECT id, label FROM w5_orders ORDER BY id ASC;'
      )
      expect(afterCommit.rows).toEqual([
        [1, 'init'],
        [3, 'persisted'],
      ])

      // 5a. Single-table getDdl keeps triggers; exportSchemaDdl emits each trigger ONCE and replays cleanly
      const singleDdl = await sqliteSession.getDdl('w5_orders', 'main')
      expect(singleDdl).toContain('CREATE TRIGGER trg_w5_orders_ins')
      expect(singleDdl).toContain('CREATE TRIGGER trg_w5_orders_upd')

      const exportedSqlite = await sqliteSession.exportSchemaDdl('main')
      expect(exportedSqlite.ddl.match(/CREATE TRIGGER trg_w5_orders_ins\b/g)).toHaveLength(1)
      expect(exportedSqlite.ddl.match(/CREATE TRIGGER trg_w5_orders_upd\b/g)).toHaveLength(1)
      const replaySqlite = new DatabaseSync(':memory:')
      try {
        replaySqlite.exec(exportedSqlite.ddl)
        replaySqlite.exec("INSERT INTO w5_orders (id, label, total) VALUES (9, 'nine', 90);")
        const auditRows = replaySqlite.prepare('SELECT note FROM w5_audit').all() as Array<{
          note: unknown
        }>
        expect(auditRows.map((r) => r.note)).toEqual(['ins:nine'])
      } finally {
        replaySqlite.close()
      }

      // 5b. LibsqlSession & D1Session exportSchemaDdl also emit triggers ONCE and preserve getDdl
      const backingDb = new DatabaseSync(dbPath, { readOnly: true })
      const runSqlAgainstBackingDb = async (
        sqlText: string,
        params: unknown[] = []
      ): Promise<Record<string, unknown>[]> =>
        backingDb
          .prepare(sqlText)
          .all(...(params as Array<string | number | bigint | Uint8Array | null>)) as Record<
          string,
          unknown
        >[]

      const libSession = new LibsqlSession({
        id: 'w5_libsql',
        name: 'W5 LibSQL',
        type: 'libsql',
        url: 'http://127.0.0.1:59999',
      })
      ;(
        libSession as unknown as {
          queryExecutor: (sqlText: string, params?: unknown[]) => Promise<Record<string, unknown>[]>
        }
      ).queryExecutor = runSqlAgainstBackingDb

      const d1Session = new D1Session(
        {
          id: 'w5_d1',
          name: 'W5 D1',
          driver: 'd1',
          database: 'db',
          d1AccountId: 'acc',
          d1DatabaseId: 'db',
        },
        'tok'
      )
      ;(
        d1Session as unknown as {
          queryExecutor: (sqlText: string, params?: unknown[]) => Promise<Record<string, unknown>[]>
        }
      ).queryExecutor = runSqlAgainstBackingDb

      try {
        for (const sess of [libSession, d1Session]) {
          const tblDdl = await sess.getDdl('w5_orders', 'main')
          expect(tblDdl).toContain('CREATE TRIGGER trg_w5_orders_ins')
          const exp = await sess.exportSchemaDdl('main')
          expect(exp.ddl.match(/CREATE TRIGGER trg_w5_orders_ins\b/g)).toHaveLength(1)
          expect(exp.ddl.match(/CREATE TRIGGER trg_w5_orders_upd\b/g)).toHaveLength(1)
          const replayMem = new DatabaseSync(':memory:')
          try {
            replayMem.exec(exp.ddl)
          } finally {
            replayMem.close()
          }
        }
      } finally {
        await libSession.close()
        await d1Session.close()
        backingDb.close()
      }
    } finally {
      await sqliteSession.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('Wave 6 regressions (#153: numeric-prefix delimiter recovery, Mongo replica seeds, mixed percent-decode, single-label /@handle.dev)', async () => {
    const { parseConnectionUri, scrubUrlCredentials } = await import(
      '../src/drivers/common/connection-uri'
    )

    // 1. Numeric-prefix passwords with ?, #, / across parseConnectionUri & scrubUrlCredentials
    const numCases = [
      {
        uri: 'mongodb://u:1234?k=1@cluster.net/db?email=a@b.io',
        host: 'cluster.net',
        port: 27017,
        pass: '1234?k=1',
        db: 'db',
        scrubbed: 'mongodb://cluster.net/db?email=a@b.io',
      },
      {
        uri: 'postgres://u:1234?k=1@pg-node:5432/db?email=a@b.io',
        host: 'pg-node',
        port: 5432,
        pass: '1234?k=1',
        db: 'db',
        scrubbed: 'postgres://pg-node:5432/db?email=a@b.io',
      },
      {
        uri: 'redis://u:1234?k=1@127.0.0.1:6379/1',
        host: '127.0.0.1',
        port: 6379,
        pass: '1234?k=1',
        db: '1',
        scrubbed: 'redis://127.0.0.1:6379/1',
      },
      {
        uri: 'mongodb://u:1234#tag=1@cluster.net/db?email=a@b.io',
        host: 'cluster.net',
        port: 27017,
        pass: '1234#tag=1',
        db: 'db',
        scrubbed: 'mongodb://cluster.net/db?email=a@b.io',
      },
      {
        uri: 'redis://u:1234#tag=1@127.0.0.1:6379/1',
        host: '127.0.0.1',
        port: 6379,
        pass: '1234#tag=1',
        db: '1',
        scrubbed: 'redis://127.0.0.1:6379/1',
      },
    ]
    for (const tc of numCases) {
      const parsed = parseConnectionUri(tc.uri)
      expect(parsed.ok).toBe(true)
      expect(parsed.profile?.host).toBe(tc.host)
      expect(parsed.profile?.port).toBe(tc.port)
      expect(parsed.profile?.database).toBe(tc.db)
      expect(parsed.password).toBe(tc.pass)
      expect(scrubUrlCredentials(tc.uri)).toBe(tc.scrubbed)
    }

    expect(scrubUrlCredentials('https://u:1234?k=1@api.internal:8443/v2/@bob?authSource=admin')).toBe(
      'https://api.internal:8443/v2/@bob?authSource=admin'
    )
    expect(scrubUrlCredentials('https://u:1234/z@api.internal/v2/@bob?authSource=admin')).toBe(
      'https://api.internal/v2/@bob?authSource=admin'
    )
    const pHttp1 = parseConnectionUri(
      'https://u:1234?k=1@api.internal:8443/v2/@bob?authSource=admin'
    )
    expect(pHttp1.ok).toBe(true)
    expect(pHttp1.profile?.host).toBe('api.internal')
    expect(pHttp1.profile?.port).toBe(8443)
    expect(pHttp1.password).toBe('1234?k=1')

    const pHttp2 = parseConnectionUri('https://u:1234/z@api.internal/v2/@bob?authSource=admin')
    expect(pHttp2.ok).toBe(true)
    expect(pHttp2.profile?.host).toBe('api.internal')
    expect(pHttp2.password).toBe('1234/z')

    // Uncredentialed HTTPS /@handle endpoints stay completely untouched
    expect(scrubUrlCredentials('https://api.internal:8443/v2/@bob?authSource=admin')).toBe(
      'https://api.internal:8443/v2/@bob?authSource=admin'
    )
    expect(scrubUrlCredentials('https://api.internal:8443/v2/@bob?token=LeakMe&authSource=admin')).toBe(
      'https://api.internal:8443/v2/@bob?authSource=admin'
    )
    const pUncred = parseConnectionUri('https://api.internal:8443/v2/@bob?authSource=admin')
    expect(pUncred.ok).toBe(true)
    expect(pUncred.profile?.host).toBe('api.internal')
    expect(pUncred.profile?.port).toBe(8443)
    expect(pUncred.password).toBeUndefined()

    // 2. MongoDB replica-set comma seed lists (with delimiter password, clean password, no password)
    const rs1 = parseConnectionUri(
      'mongodb://u:p/x@n1:27017,n2:27017/app?replicaSet=rs0&email=a@b.io'
    )
    expect(rs1.ok).toBe(true)
    expect(rs1.profile?.host).toBe('n1')
    expect(rs1.profile?.port).toBe(27017)
    expect(rs1.profile?.database).toBe('app')
    expect(rs1.password).toBe('p/x')
    expect(rs1.profile?.url).toBe('mongodb://n1:27017,n2:27017/app?replicaSet=rs0&email=a@b.io')
    expect(
      scrubUrlCredentials('mongodb://u:p/x@n1:27017,n2:27017/app?replicaSet=rs0&email=a@b.io')
    ).toBe('mongodb://n1:27017,n2:27017/app?replicaSet=rs0&email=a@b.io')

    const rs2 = parseConnectionUri(
      'mongodb://u:sec@n1:27017,n2:27017/app?replicaSet=rs0&email=a@b.io'
    )
    expect(rs2.ok).toBe(true)
    expect(rs2.profile?.host).toBe('n1')
    expect(rs2.password).toBe('sec')
    expect(rs2.profile?.url).toBe('mongodb://n1:27017,n2:27017/app?replicaSet=rs0&email=a@b.io')

    const rs3 = parseConnectionUri('mongodb://u:sec@n1:27017,n2:27017/app?replicaSet=rs0')
    expect(rs3.ok).toBe(true)
    expect(rs3.profile?.host).toBe('n1')
    expect(rs3.password).toBe('sec')
    expect(rs3.profile?.url).toBe('mongodb://n1:27017,n2:27017/app?replicaSet=rs0')

    const rs4 = parseConnectionUri('mongodb://n1:27017,n2:27017/app?replicaSet=rs0')
    expect(rs4.ok).toBe(true)
    expect(rs4.profile?.host).toBe('n1')
    expect(rs4.profile?.port).toBe(27017)
    expect(rs4.password).toBeUndefined()
    expect(rs4.profile?.url).toBe('mongodb://n1:27017,n2:27017/app?replicaSet=rs0')
    expect(scrubUrlCredentials('mongodb://n1:27017,n2:27017/app?replicaSet=rs0')).toBe(
      'mongodb://n1:27017,n2:27017/app?replicaSet=rs0'
    )

    // 3. decodeUriPart decodes valid %XX alongside malformed %ZZ
    const mixedPct = parseConnectionUri('postgres://ops:p%ZZ:sec@pg-primary:5432/w6_db?email=a@b.io')
    expect(mixedPct.ok).toBe(true)
    expect(mixedPct.profile?.host).toBe('pg-primary')
    expect(mixedPct.password).toBe('p%ZZ:sec')

    // 4. scrubDriverErrorText single-label host:port /@handle.dev, ?next=@handle, non-HTTP single-label numeric passwords
    expect(
      scrubDriverErrorText('Err https://apihost:8443/v2/@bob.dev?token=LeakMe&authSource=admin')
    ).toBe('Err https://apihost:8443/v2/@bob.dev?token=[REDACTED]&authSource=admin')
    expect(scrubDriverErrorText('Err https://edge-gw:9443?next=@charlie.dev')).toBe(
      'Err https://edge-gw:9443?next=@charlie.dev'
    )
    expect(scrubDriverErrorText('Err https://edge-gw:9443/login?next=@charlie.dev#top')).toBe(
      'Err https://edge-gw:9443/login?next=@charlie.dev'
    )
    expect(
      scrubDriverErrorText('https://u:p/2@apihost/v2/@bob.dev?token=Sec&authSource=admin')
    ).toBe('https://u@apihost/v2/@bob.dev?token=[REDACTED]&authSource=admin')
    expect(
      scrubDriverErrorText('mongodb://svc:8080?x=1@mongo-primary/w6_r3_db?authSource=admin')
    ).toBe('mongodb://svc@mongo-primary/w6_r3_db?authSource=admin')
    expect(
      scrubDriverErrorText('redis://svc:9981/sub@redis-node/2?password=Top99')
    ).toBe('redis://svc@redis-node/2?password=[REDACTED]')
    expect(
      scrubDriverErrorText(
        'Wrapped {"err":"https:\\/\\/svc:SecPass9@edge-gw:8443\\/db?credentials=Cred9"}'
      )
    ).toBe('Wrapped {"err":"https:\\/\\/svc@edge-gw:8443\\/db?credentials=[REDACTED]"}')
  })

  it('Wave 7 regressions (#175: rpc query.run txToken preservation, attached SQLite CREATE INDEX, portless comma seeds, double-escaped ClickHouse & \\" preservation)', async () => {
    // 1. R1 Bug 1: query.run opening TX under existing panel-A setAutoCommit(false) keeps txToken intact
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'datanoa-w7-tx-'))
    const dbPath = path.join(tmpDir, 'w7_tx.sqlite')
    const seedDb = new DatabaseSync(dbPath)
    seedDb.exec('CREATE TABLE w7_tx_t (id INTEGER PRIMARY KEY, val TEXT);')
    seedDb.exec("INSERT INTO w7_tx_t (id, val) VALUES (1, 'clean');")
    seedDb.close()

    const sqliteDriver = new SqliteDriver()
    const session = await sqliteDriver.createSession({
      id: 'w7_tx_conn',
      name: 'W7 TX',
      driver: 'sqlite',
      filePath: dbPath,
    })

    try {
      const rpcHandlers = new Map<
        string,
        (input: Record<string, unknown>, ctx?: { panel?: { id: string } }) => Promise<unknown>
      >()
      const tracker = createQueryRuntimeTracker()
      const fakeOrca = {
        storage: { get: async () => undefined, set: async () => {} },
        settings: { get: async () => 1000 },
        secrets: { get: async () => undefined },
        log: () => {},
      } as unknown as OrcaWorkerApi

      registerQueryAndTxHandlers({
        orca: fakeOrca,
        registerHandler: ((
          name: string,
          fn: (input: Record<string, unknown>, ctx?: { panel?: { id: string } }) => Promise<unknown>
        ) => {
          rpcHandlers.set(name, fn)
        }) as unknown as OrcaWorkerApi['panels']['handle'],
        sessionManager: {
          findProfile: async () => ({
            id: 'w7_tx_conn',
            name: 'W7 TX',
            driver: 'sqlite',
            filePath: dbPath,
            readOnly: false,
          }),
          getSession: async () => session,
        } as unknown as Parameters<typeof registerQueryAndTxHandlers>[0]['sessionManager'],
        tracker,
      })

      const txSetAutoCommit = rpcHandlers.get('tx.setAutoCommit')!
      const queryRun = rpcHandlers.get('query.run')!
      const txRollback = rpcHandlers.get('tx.rollback')!
      const panelCtx = { panel: { id: 'panel-A' } }

      const manualState = (await txSetAutoCommit(
        { connectionId: 'w7_tx_conn', enabled: false },
        panelCtx
      )) as TransactionState
      expect(manualState.autoCommit).toBe(false)
      expect(manualState.active).toBe(false)
      const initialToken = manualState.txToken
      expect(typeof initialToken).toBe('number')

      await queryRun(
        { connectionId: 'w7_tx_conn', sql: "UPDATE w7_tx_t SET val = 'dirty' WHERE id = 1;" },
        panelCtx
      )
      expect(session.getTransactionState().active).toBe(true)

      const rbState = (await txRollback(
        { connectionId: 'w7_tx_conn', onlyIfOwner: true, txToken: initialToken },
        panelCtx
      )) as TransactionState
      expect(rbState.active).toBe(false)
      expect(rbState.autoCommit).toBe(true)
      expect(session.getTransactionState().active).toBe(false)

      const verifyRes = (await queryRun(
        { connectionId: 'w7_tx_conn', sql: 'SELECT val FROM w7_tx_t WHERE id = 1;' },
        panelCtx
      )) as { rows: unknown[][] }
      expect(verifyRes.rows).toEqual([['clean']])
    } finally {
      await session.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }

    // 2. R1 Bug 3a: Attached SQLite schema CREATE INDEX qualifies index name, never ON "schema"."table"
    for (const dialect of ['sqlite', 'libsql', 'd1'] as const) {
      const addIdxSql = buildAlterTableSql(
        {
          kind: 'addIndex',
          table: 'W7_Ledger',
          schema: 'w7_r1_aux',
          indexName: 'idx_w7_aux_code',
          columns: ['code'],
          unique: true,
        },
        dialect
      )
      expect(addIdxSql).toBe(
        'CREATE UNIQUE INDEX "w7_r1_aux"."idx_w7_aux_code" ON "W7_Ledger" ("code");'
      )
    }

    const auxDetails: TableDetails = {
      name: 'W7_Ledger',
      schema: 'w7_r1_aux',
      kind: 'table',
      columns: [
        { name: 'id', type: 'INTEGER', nativeType: 'INTEGER', nullable: false, defaultValue: null, isPrimaryKey: true, isAutoIncrement: false },
        { name: 'code', type: 'TEXT', nativeType: 'TEXT', nullable: false, defaultValue: null, isPrimaryKey: false, isAutoIncrement: false },
      ],
      primaryKey: ['id'],
      indexes: [
        { name: 'idx_w7_aux_code', columns: ['code'], unique: false, isPrimary: false, origin: 'c' },
      ],
      foreignKeys: [],
    }
    const auxRebuildDraft = createInitialTableDraft(auxDetails, 'sqlite')
    auxRebuildDraft.tableName = 'w7_ledger_v2'
    auxRebuildDraft.columns[1].dataType = 'VARCHAR(64)'
    const auxRebuildStmts = buildTableMigrationSql(auxRebuildDraft, 'sqlite')
    expect(auxRebuildStmts).toContain(
      'CREATE INDEX IF NOT EXISTS "w7_r1_aux"."idx_w7_aux_code" ON "w7_ledger_v2" ("code");'
    )

    const auxDb = new DatabaseSync(':memory:')
    try {
      auxDb.exec("ATTACH DATABASE ':memory:' AS w7_r1_aux;")
      auxDb.exec('CREATE TABLE w7_r1_aux."W7_Ledger" (id INTEGER PRIMARY KEY, code TEXT NOT NULL);')
      auxDb.exec('CREATE INDEX "w7_r1_aux"."idx_w7_aux_code" ON "W7_Ledger" ("code");')
      auxDb.exec('INSERT INTO w7_r1_aux."W7_Ledger" (id, code) VALUES (1, \'A1\');')
      for (const stmt of auxRebuildStmts) {
        auxDb.exec(stmt)
      }
      const addIdxStmt = buildAlterTableSql(
        {
          kind: 'addIndex',
          table: 'w7_ledger_v2',
          schema: 'w7_r1_aux',
          indexName: 'idx_w7_aux_id_code',
          columns: ['id', 'code'],
          unique: true,
        },
        'sqlite'
      )
      auxDb.exec(addIdxStmt)
      const idxList = auxDb.prepare('PRAGMA w7_r1_aux.index_list("w7_ledger_v2")').all() as Array<{
        name: unknown
      }>
      expect(idxList.map((r) => r.name)).toContain('idx_w7_aux_code')
      expect(idxList.map((r) => r.name)).toContain('idx_w7_aux_id_code')
    } finally {
      auxDb.close()
    }

    // 4. R2 Bug 2: Portless and partial-port MongoDB comma seed lists extract primary host/name
    const { parseConnectionUri, scrubUrlCredentials } = await import(
      '../src/drivers/common/connection-uri'
    )
    const rsNoPort = parseConnectionUri('mongodb://u:sec@rs1,rs2/app?replicaSet=rs0')
    expect(rsNoPort.ok).toBe(true)
    expect(rsNoPort.profile?.host).toBe('rs1')
    expect(rsNoPort.profile?.name).toBe('rs1')
    expect(rsNoPort.profile?.port).toBe(27017)
    expect(rsNoPort.password).toBe('sec')
    expect(rsNoPort.profile?.url).toBe('mongodb://rs1,rs2/app?replicaSet=rs0')
    expect(scrubUrlCredentials('mongodb://u:sec@rs1,rs2/app?replicaSet=rs0')).toBe(
      'mongodb://rs1,rs2/app?replicaSet=rs0'
    )

    const rsNoAuth = parseConnectionUri('mongodb://rs1,rs2/app?replicaSet=rs0')
    expect(rsNoAuth.ok).toBe(true)
    expect(rsNoAuth.profile?.host).toBe('rs1')
    expect(rsNoAuth.profile?.name).toBe('rs1')
    expect(rsNoAuth.profile?.url).toBe('mongodb://rs1,rs2/app?replicaSet=rs0')

    const rsPartialPort = parseConnectionUri('mongodb://u:sec@rs1,rs2:27017/app?replicaSet=rs0')
    expect(rsPartialPort.ok).toBe(true)
    expect(rsPartialPort.profile?.host).toBe('rs1')
    expect(rsPartialPort.profile?.name).toBe('rs1')
    expect(rsPartialPort.profile?.port).toBe(27017)
    expect(rsPartialPort.profile?.url).toBe('mongodb://rs1,rs2:27017/app?replicaSet=rs0')
    expect(scrubUrlCredentials('mongodb://u:sec@rs1,rs2:27017/app?replicaSet=rs0')).toBe(
      'mongodb://rs1,rs2:27017/app?replicaSet=rs0'
    )

    // 5. R3 Bug 4: ClickHouse double-escaped :\\/\\/ and JSON-escaped \\" preservation
    expect(
      scrubDriverErrorText(
        'SELECT throwIf(1, \'{\\"err\\":\\"https://u:ChSec9@edge-gw:8443/db?token=ChTok9\\"}\')'
      )
    ).toBe('SELECT throwIf(1, \'{\\"err\\":\\"https://u@edge-gw:8443/db?token=[REDACTED]\\"}\')')

    expect(
      scrubDriverErrorText(
        '{"err":"https:\\\\/\\\\/svc:ChSec9@edge-gw:8443\\\\/db?token=ChTok9#frag=F1"}'
      )
    ).toBe('{"err":"https:\\\\/\\\\/svc@edge-gw:8443\\\\/db?token=[REDACTED]"}')

    expect(
      scrubDriverErrorText(
        'SELECT throwIf(1, \'{\\"err\\":\\"https:\\\\/\\\\/svc:ChSec9@edge-gw:8443\\\\/db?token=ChTok9#frag=F1\\"}\')'
      )
    ).toBe(
      'SELECT throwIf(1, \'{\\"err\\":\\"https:\\\\/\\\\/svc@edge-gw:8443\\\\/db?token=[REDACTED]\\"}\')'
    )
  })

  it('Wave 8 regressions (#195: unified findCredentialAuthorityAtIndex, [::1] guard, scrubSensitiveText, detectRecognizableSqlCredential)', async () => {
    const { parseConnectionUri, scrubUrlCredentials } = await import(
      '../src/drivers/common/connection-uri'
    )

    // 1. connection-uri.ts IPv6 [::1] preservation & credential recovery + edge-gw & non-HTTP ?query
    expect(scrubUrlCredentials('mongodb://[::1]:27017/w8db?email=ops@acme.io')).toBe(
      'mongodb://[::1]:27017/w8db?email=ops@acme.io'
    )
    const ipv6Uncred = parseConnectionUri('mongodb://[::1]:27017/w8db?email=ops@acme.io')
    expect(ipv6Uncred.ok).toBe(true)
    expect(ipv6Uncred.profile?.host).toBe('[::1]')
    expect(ipv6Uncred.profile?.port).toBe(27017)
    expect(ipv6Uncred.profile?.database).toBe('w8db')
    expect(ipv6Uncred.password).toBeUndefined()

    expect(scrubUrlCredentials('https://[::1]:8443/v2/@bob.dev?token=Sec')).toBe(
      'https://[::1]:8443/v2/@bob.dev'
    )
    const ipv6Http = parseConnectionUri('https://[::1]:8443/v2/@bob.dev?token=Sec')
    expect(ipv6Http.ok).toBe(true)
    expect(ipv6Http.profile?.host).toBe('[::1]')
    expect(ipv6Http.password).toBeUndefined()

    const ipv6Seed = parseConnectionUri(
      'mongodb://[::1]:27017,seed-b:27018/w8db?email=ops@acme.io'
    )
    expect(ipv6Seed.ok).toBe(true)
    expect(ipv6Seed.profile?.host).toBe('[::1]')
    expect(ipv6Seed.profile?.port).toBe(27017)
    expect(ipv6Seed.profile?.url).toBe('mongodb://[::1]:27017,seed-b:27018/w8db?email=ops@acme.io')

    const ipv6Cred = parseConnectionUri('mongodb://u:p?1@[::1]:27017/w8db?email=ops@acme.io')
    expect(ipv6Cred.ok).toBe(true)
    expect(ipv6Cred.profile?.host).toBe('[::1]')
    expect(ipv6Cred.password).toBe('p?1')
    expect(scrubUrlCredentials('mongodb://u:p?1@[::1]:27017/w8db?email=ops@acme.io')).toBe(
      'mongodb://[::1]:27017/w8db?email=ops@acme.io'
    )

    // Uncredentialed query @ with single-label hosts and edge-gw:9443/v1?q=a@charlie.dev/extra
    expect(scrubUrlCredentials('https://edge-gw:9443/v1?q=a@charlie.dev/extra')).toBe(
      'https://edge-gw:9443/v1?q=a@charlie.dev/extra'
    )
    const pEdge = parseConnectionUri('https://edge-gw:9443/v1?q=a@charlie.dev/extra')
    expect(pEdge.ok).toBe(true)
    expect(pEdge.profile?.host).toBe('edge-gw')
    expect(pEdge.profile?.port).toBe(9443)
    expect(pEdge.password).toBeUndefined()

    expect(scrubUrlCredentials('mongodb://mongo:27017?email=a@b.com')).toBe(
      'mongodb://mongo:27017?email=a@b.com'
    )
    expect(parseConnectionUri('mongodb://mongo:27017?email=a@b.com').profile?.host).toBe('mongo')
    expect(scrubUrlCredentials('redis://redis-node:6379/0?email=a@b.com')).toBe(
      'redis://redis-node:6379/0?email=a@b.com'
    )
    expect(parseConnectionUri('redis://redis-node:6379/0?email=a@b.com').profile?.host).toBe(
      'redis-node'
    )

    // Non-HTTP ?query-only and #fragment-only numeric-prefix password recovery
    const pMQuery = parseConnectionUri('mongodb://svc:8080?x=1@mongo-primary?authSource=admin')
    expect(pMQuery.ok).toBe(true)
    expect(pMQuery.profile?.host).toBe('mongo-primary')
    expect(pMQuery.password).toBe('8080?x=1')
    expect(pMQuery.profile?.url).toBe('mongodb://mongo-primary?authSource=admin')
    expect(scrubUrlCredentials('mongodb://svc:8080?x=1@mongo-primary?authSource=admin')).toBe(
      'mongodb://mongo-primary?authSource=admin'
    )

    const pPgFrag = parseConnectionUri('postgres://svc:5432#k=1@pgnode?sslmode=require')
    expect(pPgFrag.ok).toBe(true)
    expect(pPgFrag.profile?.host).toBe('pgnode')
    expect(pPgFrag.password).toBe('5432#k=1')
    expect(scrubUrlCredentials('postgres://svc:5432#k=1@pgnode?sslmode=require')).toBe(
      'postgres://pgnode?sslmode=require'
    )

    const pRedFrag = parseConnectionUri('redis://svc:443#h=1@redis-node?password=Top99')
    expect(pRedFrag.ok).toBe(true)
    expect(pRedFrag.profile?.host).toBe('redis-node')
    expect(pRedFrag.password).toBe('443#h=1')
    expect(scrubUrlCredentials('redis://svc:443#h=1@redis-node?password=Top99')).toBe(
      'redis://redis-node'
    )

    // 2. sql-credentials.ts scrubDriverErrorText delegated to scrubSensitiveText({ stripAllFragments: true })
    expect(scrubDriverErrorText('postgres://svc:5432#k=1@pgnode?sslmode=require')).toBe(
      'postgres://svc@pgnode?sslmode=require'
    )
    expect(scrubDriverErrorText('mongodb://[::1]:27017/w8db?email=ops@acme.io')).toBe(
      'mongodb://[::1]:27017/w8db?email=ops@acme.io'
    )
    expect(scrubDriverErrorText('{"err":"Pwd=\\"Sec8\\""}')).toBe('{"err":"Pwd=[REDACTED]"}')
    expect(
      scrubDriverErrorText('https://ch.internal:8443/v1?Authorization=Bearer Tok88&authSource=admin')
    ).toBe('https://ch.internal:8443/v1?Authorization=[REDACTED]&authSource=admin')
    expect(
      scrubDriverErrorText(
        'SELECT throwIf(1, \'{\\"err\\":\\"https:\\\\\\\\\\/\\\\\\\\\\/svc:ChSec9@edge-gw:8443\\\\\\\\\\/db?token=ChTok9#frag=F1\\"}\')'
      )
    ).toBe(
      'SELECT throwIf(1, \'{\\"err\\":\\"https:\\\\\\\\\\/\\\\\\\\\\/svc@edge-gw:8443\\\\\\\\\\/db?token=[REDACTED]\\"}\')'
    )

    // 3. detectRecognizableSqlCredential recovers #/? passwords + comma seed hosts
    expect(
      detectRecognizableSqlCredential(
        "SELECT 'mongodb://svc:443#h=1@seed1:27017,seed2:27017/w8_r3_db'"
      )
    ).toBe('db-uri-credential')
    expect(
      detectRecognizableSqlCredential(
        "SELECT 'redis://svc:443#h=1@redis-node/2?password=Top99'"
      )
    ).toBe('db-uri-credential')
    expect(
      detectRecognizableSqlCredential("SELECT 'postgres://svc:5432#k=1@pgnode/w8'")
    ).toBe('db-uri-credential')
    expect(
      detectRecognizableSqlCredential(
        "SELECT 'mongodb://svc:8080?x=1@mongo-primary/w8_r3_db?authSource=admin'"
      )
    ).toBe('db-uri-credential')
    expect(
      detectRecognizableSqlCredential("SELECT 'https://edge-gw:9443/v1?q=a@charlie.dev/extra'")
    ).toBeNull()
  })
})
