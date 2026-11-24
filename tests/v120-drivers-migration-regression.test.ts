import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionProfile } from '../src/protocol'
import { isMssqlReadOnlyBlocked } from '../src/drivers/common/mssql-sql'
import { splitOracleStatements } from '../src/drivers/common/oracle-sql'
import { introspectSqliteTableDetails } from '../src/drivers/common/schema'
import { isMutatingStatement } from '../src/drivers/common/sql-lexer'
import {
  buildTableMigrationSql,
  createInitialTableDraft,
} from '../src/drivers/common/sql-migration'
import { ClickHouseSession } from '../src/drivers/clickhouse/driver'
import { D1Session } from '../src/drivers/d1/driver'
import {
  MongoLiteralParser,
  parseMongoStatement,
  parseRelaxedMongoValue,
} from '../src/drivers/mongodb/driver'
import { MssqlSession, buildMssqlPoolConfig } from '../src/drivers/mssql/driver'
import { buildOracleConnectionConfig } from '../src/drivers/oracle/driver'
import { SqliteDriver } from '../src/drivers/sqlite/driver'
import { parseJsonPreservingBigInts } from '../src/shared-grid-paste.js'
import { analyzeDangerousSql } from '../src/shared-sql-safety.js'

function createSqliteQueryExecutor(db: DatabaseSync) {
  return async (sql: string, params?: unknown[]): Promise<Record<string, unknown>[]> => {
    const stmt = db.prepare(sql)
    const args = (params ?? []) as Array<string | number | null | Uint8Array | bigint>
    const rows = stmt.all(...args) as Array<Record<string, unknown>>
    return rows.map((r) => ({ ...r }))
  }
}

function execMigrationStatements(db: DatabaseSync, statements: string[]) {
  for (const stmt of statements) {
    const trimmed = stmt.trim()
    if (!trimmed) continue
    db.exec(trimmed)
  }
}

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('v1.2.0 Wave 1+2 drivers & migration regressions', () => {
  describe('[CRIT-1] D1 self-referential FK rebuild safety (live node:sqlite)', () => {
    it.each(['CASCADE', 'SET NULL', 'NO ACTION'] as const)(
      'blocks D1 rebuild on existing self-referential FK ON DELETE %s',
      async (onDeleteAction) => {
        const db = new DatabaseSync(':memory:')
        try {
          db.exec('PRAGMA foreign_keys = ON;')
          db.exec(`
            CREATE TABLE categories (
              id INTEGER PRIMARY KEY,
              parent_id INTEGER REFERENCES categories(id) ON DELETE ${onDeleteAction},
              title TEXT NOT NULL
            );
            INSERT INTO categories (id, parent_id, title) VALUES
              (1, NULL, 'Root'),
              (2, 1, 'Child A'),
              (3, 2, 'Grandchild B');
          `)

          const details = await introspectSqliteTableDetails(
            createSqliteQueryExecutor(db),
            'categories',
            'main'
          )
          const draft = createInitialTableDraft(details)
          const titleCol = draft.columns.find((c) => c.name === 'title')
          expect(titleCol).toBeDefined()
          if (!titleCol) throw new Error('title column missing')
          titleCol.defaultValue = "'untitled'"

          expect(() => buildTableMigrationSql(draft, 'd1')).toThrow(/self-referenc|foreign key|D1/i)
        } finally {
          db.close()
        }
      }
    )

    it('blocks D1 rebuild when adding a brand-new self-referential FK', async () => {
      const db = new DatabaseSync(':memory:')
      try {
        db.exec(`
          CREATE TABLE nodes (
            id INTEGER PRIMARY KEY,
            parent_id INTEGER,
            label TEXT
          );
          INSERT INTO nodes (id, parent_id, label) VALUES (1, NULL, 'root'), (2, 1, 'leaf');
        `)

        const details = await introspectSqliteTableDetails(
          createSqliteQueryExecutor(db),
          'nodes',
          'main'
        )
        const draft = createInitialTableDraft(details)
        draft.foreignKeys.push({
          id: 'fk_new_self',
          constraintName: 'fk_nodes_parent',
          status: 'new',
          column: 'parent_id',
          foreignTable: 'nodes',
          foreignColumn: 'id',
          onDelete: 'CASCADE',
          onUpdate: 'NO ACTION',
        })

        expect(() => buildTableMigrationSql(draft, 'd1')).toThrow(/self-referenc|foreign key|D1/i)
      } finally {
        db.close()
      }
    })

    it('allows D1 rebuild when the self-referential FK is explicitly deleted and preserves all rows', async () => {
      const db = new DatabaseSync(':memory:')
      try {
        db.exec('PRAGMA foreign_keys = ON;')
        db.exec(`
          CREATE TABLE categories (
            id INTEGER PRIMARY KEY,
            parent_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
            title TEXT NOT NULL
          );
          INSERT INTO categories (id, parent_id, title) VALUES
            (1, NULL, 'Root'),
            (2, 1, 'Child A'),
            (3, 2, 'Grandchild B');
        `)

        const details = await introspectSqliteTableDetails(
          createSqliteQueryExecutor(db),
          'categories',
          'main'
        )
        const draft = createInitialTableDraft(details)
        expect(draft.foreignKeys.length).toBe(1)
        draft.foreignKeys[0].status = 'deleted'
        const titleCol = draft.columns.find((c) => c.name === 'title')
        if (!titleCol) throw new Error('title column missing')
        titleCol.defaultValue = "'untitled'"

        const stmts = buildTableMigrationSql(draft, 'd1')
        expect(stmts.length).toBeGreaterThan(0)
        // Execute rebuild on live node:sqlite to verify all 3 rows survive intact
        execMigrationStatements(db, stmts)
        const rows = db.prepare('SELECT id, parent_id, title FROM categories ORDER BY id').all()
        expect(rows).toHaveLength(3)
      } finally {
        db.close()
      }
    })
  })

  describe('[HIGH-7] SQLite table rebuild fidelity & expression-index guard (live node:sqlite)', () => {
    it('preserves INTEGER PRIMARY KEY without AUTOINCREMENT, COLLATE/DESC partial index, GENERATED ALWAYS AS, and CHECK', async () => {
      const db = new DatabaseSync(':memory:')
      try {
        db.exec(`
          CREATE TABLE orders (
            id INTEGER PRIMARY KEY,
            code TEXT NOT NULL,
            a INTEGER NOT NULL,
            b INTEGER NOT NULL,
            total INTEGER GENERATED ALWAYS AS (COALESCE(a, 0) + (b * 2)) STORED,
            active INTEGER NOT NULL DEFAULT 1,
            CONSTRAINT chk_positive CHECK ((a > 0) AND length(code) > 0)
          );
          CREATE INDEX idx_orders_code_active ON orders (code COLLATE NOCASE DESC) WHERE active = 1;
          INSERT INTO orders (id, code, a, b, active) VALUES (1, 'Alpha', 1, 2, 1), (2, 'beta', 3, 4, 0);
        `)

        const details = await introspectSqliteTableDetails(
          createSqliteQueryExecutor(db),
          'orders',
          'main'
        )
        const idCol = details.columns.find((c) => c.name === 'id')
        const totalCol = details.columns.find((c) => c.name === 'total')
        const idx = details.indexes.find((i) => i.name === 'idx_orders_code_active')

        expect(idCol?.isAutoIncrement).toBe(false)
        expect(totalCol?.isGenerated).toBe(true)
        expect(totalCol?.generatedStorage).toBe('STORED')
        expect(totalCol?.generatedExpression).toContain('COALESCE(a, 0) + (b * 2)')
        expect(details.checkConstraints?.some((c) => c.includes('(a > 0)'))).toBe(true)
        expect(idx?.partial).toBe(true)
        expect(idx?.whereClause).toContain('active = 1')
        expect(idx?.columnSpecs?.[0]?.collate?.toUpperCase()).toBe('NOCASE')
        expect(idx?.columnSpecs?.[0]?.desc).toBe(true)

        const draft = createInitialTableDraft(details)
        const activeCol = draft.columns.find((c) => c.name === 'active')
        if (!activeCol) throw new Error('active column missing')
        activeCol.defaultValue = '0'

        const stmts = buildTableMigrationSql(draft, 'sqlite')
        execMigrationStatements(db, stmts)

        // Verify no sqlite_sequence was synthesized (no phantom AUTOINCREMENT)
        const seqTable = db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'")
          .all()
        expect(seqTable).toHaveLength(0)

        // Verify generated column preserved formula & computed values
        const rows = db.prepare('SELECT id, code, total FROM orders ORDER BY id').all() as Array<{
          id: number
          code: string
          total: number
        }>
        expect(rows).toEqual([
          { id: 1, code: 'Alpha', total: 5 },
          { id: 2, code: 'beta', total: 11 },
        ])

        // Verify CHECK constraint is still enforced
        expect(() =>
          db.exec("INSERT INTO orders (id, code, a, b) VALUES (3, 'ok', 0, 1);")
        ).toThrow(/CHECK/i)

        // Verify rebuilt named index kept COLLATE NOCASE, DESC, and partial WHERE
        const idxRow = db
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_orders_code_active'")
          .get() as { sql?: string } | undefined
        expect(idxRow?.sql).toMatch(/COLLATE\s+NOCASE/i)
        expect(idxRow?.sql).toMatch(/\bDESC\b/i)
        expect(idxRow?.sql).toMatch(/WHERE\s+active\s*=\s*1/i)
      } finally {
        db.close()
      }
    })

    it('preserves comma-separated WITHOUT ROWID, STRICT table options on live rebuild', async () => {
      const db = new DatabaseSync(':memory:')
      try {
        db.exec(`
          CREATE TABLE kv_strict (
            k TEXT PRIMARY KEY,
            v INT NOT NULL DEFAULT 0
          ) WITHOUT ROWID, STRICT;
          INSERT INTO kv_strict (k, v) VALUES ('alpha', 42);
        `)

        const details = await introspectSqliteTableDetails(
          createSqliteQueryExecutor(db),
          'kv_strict',
          'main'
        )
        expect(details.withoutRowid).toBe(true)
        expect(details.strict).toBe(true)

        const draft = createInitialTableDraft(details)
        const vCol = draft.columns.find((c) => c.name === 'v')
        if (!vCol) throw new Error('v column missing')
        vCol.defaultValue = '1'

        const stmts = buildTableMigrationSql(draft, 'sqlite')
        const createStmt = stmts.find((s) => /CREATE TABLE/i.test(s))
        expect(createStmt).toMatch(/WITHOUT ROWID,\s*STRICT/i)

        execMigrationStatements(db, stmts)
        const rows = db.prepare('SELECT k, v FROM kv_strict').all() as Array<{ k: string; v: number }>
        expect(rows).toEqual([{ k: 'alpha', v: 42 }])

        // Verify STRICT typing still rejects non-INT value
        expect(() => db.exec("INSERT INTO kv_strict (k, v) VALUES ('bad', 'not-an-int');")).toThrow()
      } finally {
        db.close()
      }
    })

    it('unconditionally blocks SQLite rebuild when an expression index survives', async () => {
      const db = new DatabaseSync(':memory:')
      try {
        db.exec(`
          CREATE TABLE items (
            id INTEGER PRIMARY KEY,
            code TEXT NOT NULL,
            note TEXT
          );
          CREATE INDEX idx_items_lower_code ON items (lower(code));
          INSERT INTO items (id, code, note) VALUES (1, 'AbC', 'hi');
        `)

        const details = await introspectSqliteTableDetails(
          createSqliteQueryExecutor(db),
          'items',
          'main'
        )
        const exprIdx = details.indexes.find((i) => i.name === 'idx_items_lower_code')
        expect(exprIdx?.isExpression).toBe(true)

        const draft = createInitialTableDraft(details)
        const noteCol = draft.columns.find((c) => c.name === 'note')
        if (!noteCol) throw new Error('note column missing')
        noteCol.defaultValue = "'none'"

        expect(() => buildTableMigrationSql(draft, 'sqlite')).toThrow(/expression index/i)
      } finally {
        db.close()
      }
    })
  })

  describe('[HIGH-1] MSSQL & Oracle Read-Only / Danger-SQL guards + non-FP matrix', () => {
    it('blocks MSSQL semicolon-less, GO, bare procs, IF/DELETE, and RECEIVE in Read-Only mode', () => {
      const blocked = [
        'SELECT 1\nDELETE FROM users',
        'SELECT 1.\nDELETE FROM users',
        'SELECT 1\nGO\nDELETE FROM users',
        "sp_rename 'dbo.old_t', 'new_t'",
        "xp_cmdshell 'whoami'",
        'IF 1=1 DELETE FROM users',
        'RECEIVE TOP(1) * FROM dbo.OrderQueue',
        'SELECT * INTO dbo.backup_users FROM dbo.users',
      ]
      for (const sql of blocked) {
        expect(isMssqlReadOnlyBlocked(sql), `Expected Read-Only block for: ${sql}`).toBe(true)
        expect(isMutatingStatement(sql, 'mssql'), `Expected mutating=true for: ${sql}`).toBe(true)
      }

      const allowed = [
        'SELECT 1',
        'WITH cte AS (SELECT 1 AS a) SELECT * FROM cte',
        'SET ANSI_NULLS, QUOTED_IDENTIFIER ON',
        'SET SHOWPLAN_XML ON',
        "DECLARE @x INT = 1; SELECT @x, [delete], 'DROP'",
      ]
      for (const sql of allowed) {
        expect(isMssqlReadOnlyBlocked(sql), `Expected Read-Only allow for: ${sql}`).toBe(false)
      }
    })

    it('detects MSSQL semicolon-less/GO/IF and Oracle / scripts in analyzeDangerousSql while avoiding FPs', () => {
      expect(analyzeDangerousSql('SELECT 1\nDELETE FROM users', 'mssql').length).toBeGreaterThan(0)
      expect(
        analyzeDangerousSql('SELECT 1\nGO\nDELETE FROM users', 'mssql').some(
          (f) => f.kind === 'delete_without_where'
        )
      ).toBe(true)
      expect(
        analyzeDangerousSql('IF 1=1 DELETE FROM users', 'mssql').some(
          (f) => f.kind === 'delete_without_where'
        )
      ).toBe(true)
      expect(
        analyzeDangerousSql('DELETE FROM users\nSELECT 1 FROM orders WHERE id = 1', 'mssql').some(
          (f) => f.kind === 'delete_without_where'
        )
      ).toBe(true)
      expect(
        analyzeDangerousSql('SELECT 1 FROM DUAL\n/\nDROP TABLE users', 'oracle').some(
          (f) => f.kind === 'drop'
        )
      ).toBe(true)
      expect(
        analyzeDangerousSql('BEGIN DELETE FROM users; END;\n/', 'oracle').some(
          (f) => f.kind === 'delete_without_where'
        )
      ).toBe(true)

      // Non-FP: CASE ... END before WHERE in UPDATE across dialects
      const caseUpdate = "UPDATE users SET status = CASE WHEN active = 1 THEN 'ok' ELSE 'off' END WHERE id = 1;"
      for (const dialect of ['postgres', 'mssql', 'oracle', 'sqlite'] as const) {
        expect(analyzeDangerousSql(caseUpdate, dialect), `False positive on ${dialect}`).toEqual([])
      }

      // Non-FP: ON DELETE CASCADE, ALTER DROP COLUMN, CREATE TRIGGER AFTER DELETE
      expect(
        analyzeDangerousSql(
          'ALTER TABLE child ADD CONSTRAINT fk_p FOREIGN KEY (pid) REFERENCES parent(id) ON DELETE CASCADE;',
          'mssql'
        )
      ).toEqual([])
      expect(analyzeDangerousSql('ALTER TABLE users DROP COLUMN legacy;', 'mssql')).toEqual([])
      expect(
        analyzeDangerousSql('CREATE TRIGGER tr_u ON users AFTER DELETE AS SELECT 1;', 'mssql')
      ).toEqual([])
    })

    it('[POSTREV-MED-1]/[POSTREV-LOW-1]/[POSTREV-LOW-2] catches Oracle / mutations, MSSQL Service Broker stacked writes, and MSSQL DROP PROC / DROP INDEX', () => {
      // [POSTREV-MED-1] Oracle / separator in isMutatingStatement
      expect(
        isMutatingStatement('SELECT 1 FROM DUAL\n/\nDELETE FROM users WHERE id = 1', 'oracle')
      ).toBe(true)
      expect(isMutatingStatement('SELECT 1 FROM DUAL\n/\nBEGIN NULL; END;\n/', 'oracle')).toBe(true)
      expect(isMutatingStatement('SELECT 1 FROM DUAL\n/\nSELECT 2 FROM DUAL', 'oracle')).toBe(false)

      // [POSTREV-LOW-1] MSSQL Service Broker stacked writes blocked while CASE/column identifiers stay allowed
      const serviceBrokerBlocked = [
        "SELECT 1\nSEND ON CONVERSATION @h ('msg')",
        "DECLARE @h UNIQUEIDENTIFIER; SELECT 1\nSEND ON CONVERSATION (@h) MESSAGE TYPE [M] ('msg')",
        'SELECT 1\nEND CONVERSATION @h',
        "SELECT CASE WHEN 1=1 THEN 'ok' END\nEND CONVERSATION @h WITH CLEANUP",
        "SELECT 1\nBEGIN DIALOG @h FROM SERVICE s1 TO SERVICE 's2'",
        "SELECT 1\nBEGIN DIALOG CONVERSATION @h FROM SERVICE s1 TO SERVICE 's2'",
        'SELECT 1\nBEGIN CONVERSATION TIMER (@h) TIMEOUT = 60',
        'SELECT 1\nMOVE CONVERSATION @h TO @g',
      ]
      for (const sql of serviceBrokerBlocked) {
        expect(isMssqlReadOnlyBlocked(sql), `Expected Service Broker block for: ${sql}`).toBe(true)
        expect(isMutatingStatement(sql, 'mssql'), `Expected mutating=true for: ${sql}`).toBe(true)
      }

      const serviceBrokerAllowed = [
        "SELECT send_date, CASE WHEN 1=1 THEN 'ok' END FROM orders",
        'SELECT send, t.send, [send] FROM orders t',
        'SELECT * FROM users u JOIN messages send ON send.user_id = u.id',
        "SELECT CASE WHEN 1=1 THEN 'ok' END conversation FROM orders",
      ]
      for (const sql of serviceBrokerAllowed) {
        expect(isMssqlReadOnlyBlocked(sql), `Expected Read-Only allow for: ${sql}`).toBe(false)
      }

      // [POSTREV-LOW-2] MSSQL DROP PROC & DROP INDEX caught after ALTER TABLE and standalone, without ALTER false positives
      const dropProcFindings = analyzeDangerousSql('ALTER TABLE t DROP COLUMN x\nDROP PROC p', 'mssql')
      expect(dropProcFindings.some((f) => f.kind === 'drop' && f.target === 'p')).toBe(true)

      const dropIdxFindings = analyzeDangerousSql(
        'ALTER TABLE t DROP COLUMN x\nDROP INDEX ix ON t',
        'mssql'
      )
      expect(dropIdxFindings.some((f) => f.kind === 'drop' && f.target === 'ix')).toBe(true)

      const dropIdxIfExists = analyzeDangerousSql(
        'ALTER TABLE t DROP COLUMN x\nDROP INDEX IF EXISTS ix ON dbo.t',
        'mssql'
      )
      expect(dropIdxIfExists.some((f) => f.kind === 'drop' && f.target === 'ix')).toBe(true)

      const dropIdxLegacy = analyzeDangerousSql(
        'ALTER TABLE t DROP COLUMN x\nDROP INDEX dbo.t.ix',
        'mssql'
      )
      expect(dropIdxLegacy.some((f) => f.kind === 'drop')).toBe(true)

      expect(analyzeDangerousSql('DROP PROC p', 'mssql')[0]).toMatchObject({
        kind: 'drop',
        target: 'p',
      })
      expect(analyzeDangerousSql('DROP INDEX ix ON t', 'mssql')[0]).toMatchObject({
        kind: 'drop',
        target: 'ix',
      })

      // Non-FP: ALTER TABLE DROP INDEX/CONSTRAINT/COLUMN clauses remain clean
      expect(analyzeDangerousSql('ALTER TABLE t DROP INDEX ix', 'mssql')).toEqual([])
      expect(analyzeDangerousSql('ALTER TABLE t DROP CONSTRAINT fk_t', 'mssql')).toEqual([])
      expect(analyzeDangerousSql('ALTER TABLE t DROP COLUMN x', 'mssql')).toEqual([])
    })
  })

  describe('[HIGH-5] Oracle SSH sslServerCertDN validation & fail-closed TLS', () => {
    it('supports multi-RDN and single-CN RFC 2253 DNs, rejects invalid DN, and fails closed without DN over SSH', async () => {
      const baseProfile: ConnectionProfile = {
        id: 'ora_1',
        name: 'Oracle SSH',
        driver: 'oracle',
        host: '127.0.0.1',
        port: 54321,
        database: 'ORCL',
        user: 'system',
        ssl: true,
      }

      // SSH tunnel without ssl_server_cert_dn and default verify-full (even with tcps:// and tlsOverride undefined)
      await expect(
        buildOracleConnectionConfig(
          { ...baseProfile, url: 'tcps://127.0.0.1:54321/ORCL' },
          'secret',
          { tlsServername: 'ora-prod.internal' }
        )
      ).rejects.toThrow(/ORACLE_SSH_TLS_VERIFY_FULL_UNSUPPORTED|ssl_server_cert_dn/i)

      // Valid multi-RDN RFC 2253 DN
      const multiRdn = await buildOracleConnectionConfig(
        {
          ...baseProfile,
          url: 'tcps://127.0.0.1:54321/ORCL?ssl_server_cert_dn=CN%3Dora-prod.internal%2CO%3DAcme%2CC%3DUS',
        },
        'secret',
        { tlsServername: 'ora-prod.internal' }
      )
      expect(multiRdn.attrs.sslServerCertDN).toBe('CN=ora-prod.internal,O=Acme,C=US')
      expect(multiRdn.attrs.sslServerDNMatch).toBe(true)

      // Valid single-CN DN
      const singleCn = await buildOracleConnectionConfig(
        {
          ...baseProfile,
          url: 'tcps://127.0.0.1:54321/ORCL?ssl_server_cert_dn=CN%3Dora-prod.internal',
        },
        'secret',
        { tlsServername: 'ora-prod.internal' }
      )
      expect(singleCn.attrs.sslServerCertDN).toBe('CN=ora-prod.internal')
      expect(singleCn.attrs.sslServerDNMatch).toBe(true)

      // Invalid bare-hostname DN must NOT be swallowed by URL try/catch
      await expect(
        buildOracleConnectionConfig(
          {
            ...baseProfile,
            url: 'tcps://127.0.0.1:54321/ORCL?ssl_server_cert_dn=bad-host',
          },
          'secret',
          { tlsServername: 'ora-prod.internal' }
        )
      ).rejects.toThrow(/ssl_server_cert_dn|RFC 2253|distinguished name/i)
    })
  })

  describe('[HIGH-6] ClickHouse full-row UPDATE COUNT(*) & two-phase multi-delete', () => {
    it('preflights UPDATE with full originalRow predicate and aborts before ALTER TABLE on multi-row match', async () => {
      const sentSql: string[] = []
      globalThis.fetch = vi.fn(async (_url, init) => {
        const body = typeof init?.body === 'string' ? init.body : ''
        sentSql.push(body)
        return new Response(
          JSON.stringify({ meta: [{ name: 'total', type: 'UInt64' }], data: [[2]] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }) as unknown as typeof fetch

      const session = new ClickHouseSession({
        id: 'ch_1',
        name: 'ClickHouse',
        driver: 'clickhouse',
        host: '127.0.0.1',
        port: 8123,
        database: 'analytics',
        user: 'default',
      })

      await expect(
        session.applyChanges({
          table: 'events',
          schema: 'analytics',
          updates: [
            {
              primaryKeys: { id: 10 },
              changes: { status: 'done' },
              originalRow: { id: 10, status: 'pending', tenant: 'acme' },
            },
          ],
        })
      ).rejects.toThrow(/2|single|1/i)

      expect(sentSql).toHaveLength(1)
      expect(sentSql[0]).toContain('SELECT COUNT(*) AS total')
      expect(sentSql[0]).toContain('tenant')
      expect(sentSql.some((s) => /ALTER TABLE/i.test(s))).toBe(false)
    })

    it('runs two-phase preflight for multi-row DELETE so conflict on row 2 emits zero ALTER TABLE DELETE', async () => {
      const sentSql: string[] = []
      let countIdx = 0
      globalThis.fetch = vi.fn(async (_url, init) => {
        const body = typeof init?.body === 'string' ? init.body : ''
        sentSql.push(body)
        countIdx += 1
        const matched = countIdx === 1 ? 1 : 2
        return new Response(
          JSON.stringify({ meta: [{ name: 'total', type: 'UInt64' }], data: [[matched]] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }) as unknown as typeof fetch

      const session = new ClickHouseSession({
        id: 'ch_2',
        name: 'ClickHouse',
        driver: 'clickhouse',
        host: '127.0.0.1',
        port: 8123,
        database: 'analytics',
        user: 'default',
      })

      await expect(
        session.applyChanges({
          table: 'events',
          schema: 'analytics',
          deletes: [{ id: 1 }, { id: 2 }],
          deleteRows: [
            { id: 1, tag: 'a' },
            { id: 2, tag: 'b' },
          ],
        })
      ).rejects.toThrow(/2|single|1/i)

      expect(sentSql).toHaveLength(2)
      expect(sentSql.every((s) => s.includes('SELECT COUNT(*) AS total'))).toBe(true)
      expect(sentSql.some((s) => /ALTER TABLE/i.test(s))).toBe(false)
    })
  })

  describe('[MED-4] MSSQL ROLLBACK TRAN sp1 & SQLite ROLLBACK TRANSACTION TO', () => {
    it('keeps MSSQL transaction active and runs ROLLBACK TRAN sp1 inside tx.request()', async () => {
      const txQueries: string[] = []
      let txRollbackCalls = 0

      const mockTx = {
        begin: async () => {},
        commit: async () => {},
        rollback: async () => {
          txRollbackCalls += 1
        },
        request: () => ({
          arrayRowMode: false,
          input: () => {},
          cancel: () => {},
          query: async (sql: string) => {
            txQueries.push(sql)
            return { recordsets: [], rowsAffected: [0] }
          },
        }),
      }
      const mockPool = {
        connected: true,
        connect: async () => mockPool,
        close: async () => {},
        request: () => mockTx.request(),
        transaction: () => mockTx,
      }

      const session = new MssqlSession(mockPool as never, {
        id: 'ms_1',
        name: 'MSSQL',
        driver: 'mssql',
        host: 'localhost',
        port: 1433,
        database: 'app',
      })

      await session.beginTransaction()
      expect(session.getTransactionState().active).toBe(true)

      await session.runQuery('q_sp1', 'ROLLBACK TRAN sp1')
      expect(txRollbackCalls).toBe(0)
      expect(txQueries).toContain('ROLLBACK TRAN sp1')
      expect(session.getTransactionState().active).toBe(true)
    })

    it('keeps live node:sqlite transaction active across ROLLBACK TRANSACTION TO SAVEPOINT', async () => {
      const driver = new SqliteDriver()
      const session = await driver.createSession({
        id: 'sq_sp',
        name: 'SQLite Savepoint',
        driver: 'sqlite',
        filePath: ':memory:',
      })

      try {
        await session.runQuery('q1', 'CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT);')
        await session.beginTransaction()
        expect(session.getTransactionState().active).toBe(true)

        await session.runQuery('q2', "INSERT INTO items (id, name) VALUES (1, 'kept');")
        await session.runQuery('q3', 'SAVEPOINT sp1;')
        await session.runQuery('q4', "INSERT INTO items (id, name) VALUES (2, 'discarded');")
        await session.runQuery('q5', 'ROLLBACK TRANSACTION TO sp1;')

        expect(session.getTransactionState().active).toBe(true)
        await session.commitTransaction()

        const check = await session.runQuery('q6', 'SELECT id, name FROM items ORDER BY id;')
        expect(check.rows).toEqual([[1, 'kept']])
      } finally {
        await session.close()
      }
    })
  })

  describe('[MED-6] D1 parseD1Envelope lossless BigInt + .0/e0 handling', () => {
    it('preserves 9007199254740993, .0, and e0 forms losslessly in D1 query results and parseJsonPreservingBigInts', async () => {
      const rawJson =
        '{"success":true,"errors":[],"result":[{"success":true,"results":[{"id":9007199254740993,"id_dot":9007199254740993.0,"id_exp":9007199254740993e0,"tiny":0.00000000000000001}],"meta":{"changes":1}}]}'

      globalThis.fetch = vi.fn(async () => {
        return new Response(rawJson, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }) as unknown as typeof fetch

      const session = new D1Session(
        {
          id: 'd1_1',
          name: 'D1 Test',
          driver: 'd1',
          d1AccountId: 'acc1234567890abcdef1234567890ab',
          d1DatabaseId: 'db123456-7890-1234-5678-1234567890ab',
        },
        'cf_token_test'
      )

      const res = await session.runQuery('q_d1_bigint', 'SELECT id, id_dot, id_exp, tiny FROM bigints')
      expect(res.rows[0]).toEqual([
        '9007199254740993',
        '9007199254740993',
        '9007199254740993',
        0.00000000000000001,
      ])

      const parsed = parseJsonPreservingBigInts(
        '{"a":9007199254740993.0,"b":-9007199254740993.00e+0,"c":9007199254740993.5,"d":0.00000000000000001}'
      ) as Record<string, unknown>
      expect(parsed.a).toBe('9007199254740993')
      expect(parsed.b).toBe('-9007199254740993')
      expect(typeof parsed.c).toBe('number')
      expect(parsed.d).toBe(0.00000000000000001)
    })
  })

  describe('[MED-7] MongoDB db.runCommand & db.adminCommand dangerous operation detection', () => {
    it('flags drop, dropDatabase, and unfiltered delete/update commands while allowing ping', () => {
      expect(
        analyzeDangerousSql("db.runCommand({ drop: 'users' })", 'mongodb').some(
          (f) => f.kind === 'drop'
        )
      ).toBe(true)
      expect(
        analyzeDangerousSql('db.adminCommand({ dropDatabase: 1 })', 'mongodb').some(
          (f) => f.kind === 'drop'
        )
      ).toBe(true)
      expect(
        analyzeDangerousSql(
          "db.runCommand({ delete: 'users', deletes: [{ q: {}, limit: 0 }] })",
          'mongodb'
        ).some((f) => f.kind === 'delete_without_where')
      ).toBe(true)
      expect(
        analyzeDangerousSql(
          "db.runCommand({ update: 'users', updates: [{ q: {}, u: { $set: { a: 1 } } }] })",
          'mongodb'
        ).some((f) => f.kind === 'update_without_where')
      ).toBe(true)
      expect(analyzeDangerousSql('db.runCommand({ ping: 1 })', 'mongodb')).toEqual([])
    })
  })

  describe('[MED-9] MSSQL ADO.NET Encrypt=True & tedious options.serverName', () => {
    it('enforces fail-closed TLS for Encrypt=True and forwards SSH tlsServername to options.serverName', async () => {
      const cfg = await buildMssqlPoolConfig(
        {
          id: 'ms_ado_1',
          name: 'ADO Encrypt',
          driver: 'mssql',
          url: 'Server=db.corp.local,1433;Database=app;User Id=sa;Encrypt=True;',
        },
        'pw'
      )
      expect(cfg.options?.encrypt).toBe(true)
      expect(cfg.options?.trustServerCertificate).toBe(false)

      const strictCfg = await buildMssqlPoolConfig(
        {
          id: 'ms_ado_strict',
          name: 'ADO Strict',
          driver: 'mssql',
          url: 'Server=127.0.0.1,14330;Database=app;User Id=sa;Encrypt=Strict;',
        },
        'pw',
        { tlsServername: 'sql.corp.local' }
      )
      expect(strictCfg.options?.encrypt).toBe('strict')
      expect(strictCfg.options?.trustServerCertificate).toBe(false)
      expect((strictCfg.options as Record<string, unknown> | undefined)?.serverName).toBe(
        'sql.corp.local'
      )
    })
  })

  describe('[MED-12] Oracle nq\'[...]\' alternative quoting literals', () => {
    it('keeps semicolons, slashes, and SQL keywords inside nq\'[...]\' intact', () => {
      const chunks = splitOracleStatements(
        "SELECT nq'[a;b]' AS x FROM dual;\nSELECT NQ'(c/d)' AS y FROM dual;"
      )
      expect(chunks).toHaveLength(2)
      expect(chunks[0].text).toContain("nq'[a;b]'")
      expect(chunks[1].text).toContain("NQ'(c/d)'")

      expect(
        analyzeDangerousSql("SELECT nq'[DELETE FROM users; DROP TABLE x;]' FROM dual", 'oracle')
      ).toEqual([])
    })
  })

  describe('[LOW-3] MongoLiteralParser nesting depth cap', () => {
    it('throws a clean depth-limit error instead of RangeError on deeply nested arrays/objects', () => {
      const deepArr = '['.repeat(130) + '1' + ']'.repeat(130)
      const deepObj = '{"a":'.repeat(130) + '1' + '}'.repeat(130)

      expect(() => new MongoLiteralParser(deepArr).parseValue()).toThrow(
        /exceeds maximum nesting depth of 128/i
      )
      expect(() => parseRelaxedMongoValue(deepObj)).toThrow(
        /exceeds maximum nesting depth of 128/i
      )

      const okNested = '['.repeat(16) + '42' + ']'.repeat(16)
      expect(() => parseRelaxedMongoValue(okNested)).not.toThrow()
    })
  })

  describe('[LOW-8] MongoDB dotted collection names', () => {
    it('supports dotted collection names across read-only lexer, danger-SQL target, and statement parser', () => {
      expect(isMutatingStatement('db.app.events.find({ ok: true }).limit(5)', 'mongodb')).toBe(
        false
      )
      expect(isMutatingStatement('db.app.events.deleteMany({})', 'mongodb')).toBe(true)

      const findings = analyzeDangerousSql('db.app.events.drop()', 'mongodb')
      expect(findings).toHaveLength(1)
      expect(findings[0].kind).toBe('drop')
      expect(findings[0].target).toBe('app.events')

      const parsed = parseMongoStatement('db.app.events.find({ ok: true })')
      expect(parsed.kind).toBe('collection_method')
      if (parsed.kind === 'collection_method') {
        expect(parsed.collection).toBe('app.events')
        expect(parsed.method).toBe('find')
      }
    })
  })
})
