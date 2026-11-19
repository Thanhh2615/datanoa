import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { PluginRequestArgs, PluginRequestInput, PluginRequestOutput } from 'orca'
import { DATANOA_LOGO_DATA_URI } from '../../src/assets/logo'
import type {
  ConnectionColorTag,
  ConnectionProfile,
  PluginRequests,
  QueryHistoryEntry,
  TableDetails,
} from '../../src/protocol'
import {
  buildAlterTableSql,
  buildCreateTableSql,
  buildDropTableSql,
  buildQuickFilterPredicate,
  buildTableMigrationSql,
  buildTruncateTableSql,
  createInitialTableDraft,
  findStatementAtOffset,
  formatCellMatrixExport,
  formatDataExport,
  formatSql,
  formatSqlInList,
  formatSqlLiteral,
  hasExplainAnalyzeOption,
  isExplainTargetMutating,
  isMutatingStatement,
  normalizeSqlDefaultExpression,
  quoteIdentForDialect,
  quoteTableReference,
  reconstructTableDdl,
  sanitizeFilterClause,
  splitSqlStatements,
  stripLeadingSqlComments,
  validateTableStructureDraft,
  type CreateTableColumnDraft,
} from '../../src/drivers/common/sql-tools'
import {
  assembleTableBrowseResult,
  buildSelectPageSql,
} from '../../src/drivers/common/update-builder'

describe('sql-tools: quoteIdentForDialect', () => {
  it('uses backticks for mysql/mariadb/clickhouse and double quotes for SQL/kv/http dialects, keeping single-identifier dots intact', () => {
    expect(quoteIdentForDialect('users', 'mysql')).toBe('`users`')
    expect(quoteIdentForDialect('users', 'mariadb')).toBe('`users`')
    expect(quoteIdentForDialect('users', 'clickhouse')).toBe('`users`')

    expect(quoteIdentForDialect('users', 'postgres')).toBe('"users"')
    expect(quoteIdentForDialect('users', 'sqlite')).toBe('"users"')
    expect(quoteIdentForDialect('users', 'cockroachdb')).toBe('"users"')
    expect(quoteIdentForDialect('users', 'libsql')).toBe('"users"')

    // Escapes embedded quote characters and treats a single identifier with dots as one identifier
    expect(quoteIdentForDialect('col`1', 'mysql')).toBe('`col``1`')
    expect(quoteIdentForDialect('col"1', 'postgres')).toBe('"col""1"')
    expect(quoteIdentForDialect('user.email', 'postgres')).toBe('"user.email"')
    expect(quoteIdentForDialect('user.email', 'clickhouse')).toBe('`user.email`')
  })
})

describe('sql-tools: formatDataExport (7 formats)', () => {
  const columns = ['id', 'name', 'bio', 'score', 'active', 'meta']
  const rows: Record<string, unknown>[] = [
    {
      id: 1,
      name: "O'Reilly",
      bio: 'Line 1\nLine 2, "quoted" | piped',
      score: 98.5,
      active: true,
      meta: { role: 'admin' },
    },
    {
      id: 2,
      name: null,
      bio: 'Simple',
      score: 0,
      active: false,
      meta: null,
    },
  ]

  it('formats sql-insert with dialect quoting, escaped single quotes, and NULL literals', () => {
    const pgSql = formatDataExport({
      columns,
      rows,
      format: 'sql-insert',
      tableName: 'public.users',
      dialect: 'postgres',
    })
    expect(pgSql).toBe(
      [
        `INSERT INTO "public"."users" ("id", "name", "bio", "score", "active", "meta") VALUES (1, 'O''Reilly', 'Line 1\nLine 2, "quoted" | piped', 98.5, TRUE, '{"role":"admin"}');`,
        `INSERT INTO "public"."users" ("id", "name", "bio", "score", "active", "meta") VALUES (2, NULL, 'Simple', 0, FALSE, NULL);`,
      ].join('\n')
    )

    const mysqlSql = formatDataExport({
      columns: ['id', 'path'],
      rows: [{ id: 1, path: "C:\\data\\O'Brien" }],
      format: 'sql-insert',
      tableName: 'logs',
      dialect: 'mysql',
    })
    expect(mysqlSql).toBe(
      "INSERT INTO `logs` (`id`, `path`) VALUES (1, 'C:\\\\data\\\\O''Brien');"
    )
  })

  it('formats sql-update using primaryKeys in WHERE (including IS NULL safety)', () => {
    const updateSql = formatDataExport({
      columns: ['id', 'name', 'active'],
      rows: [
        { id: 1, name: "O'Reilly", active: true },
        { id: null, name: 'Ghost', active: false },
      ],
      format: 'sql-update',
      tableName: 'users',
      dialect: 'sqlite',
      primaryKeys: ['id'],
    })
    expect(updateSql).toBe(
      [
        `UPDATE "users" SET "name" = 'O''Reilly', "active" = TRUE WHERE "id" = 1;`,
        `UPDATE "users" SET "name" = 'Ghost', "active" = FALSE WHERE "id" IS NULL;`,
      ].join('\n')
    )
  })

  it('formats pretty json and ndjson preserving column order and BigInt values', () => {
    const jsonOut = formatDataExport({
      columns: ['id', 'name'],
      rows: [{ name: 'Alice', id: 42n }],
      format: 'json',
    })
    expect(jsonOut).toBe(JSON.stringify([{ id: 42, name: 'Alice' }], null, 2))

    const ndjsonOut = formatDataExport({
      columns: ['id', 'name'],
      rows: [
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
      ],
      format: 'ndjson',
    })
    expect(ndjsonOut).toBe('{"id":1,"name":"Alice"}\n{"id":2,"name":"Bob"}')
  })

  it('formats RFC-4180 csv and tsv properly quoting commas, tabs, quotes, and newlines', () => {
    const csvOut = formatDataExport({
      columns: ['id', 'name', 'bio'],
      rows,
      format: 'csv',
    })
    expect(csvOut).toBe(
      [
        'id,name,bio',
        '1,O\'Reilly,"Line 1\nLine 2, ""quoted"" | piped"',
        '2,,Simple',
      ].join('\n')
    )

    const tsvOut = formatDataExport({
      columns: ['id', 'note'],
      rows: [{ id: 1, note: 'a\tb' }, { id: 2, note: null }],
      format: 'tsv',
    })
    expect(tsvOut).toBe(['id\tnote', '1\t"a\tb"', '2\t'].join('\n'))
  })

  it('formats markdown tables with escaped pipes and line breaks', () => {
    const mdOut = formatDataExport({
      columns: ['id', 'name', 'bio'],
      rows,
      format: 'markdown',
    })
    expect(mdOut).toBe(
      [
        '| id | name | bio |',
        '| --- | --- | --- |',
        '| 1 | O\'Reilly | Line 1<br>Line 2, "quoted" \\| piped |',
        '| 2 | NULL | Simple |',
      ].join('\n')
    )
  })
})

describe('sql-tools: splitSqlStatements & findStatementAtOffset', () => {
  it('ignores semicolons inside single, double, backtick quotes, $$ dollar blocks, line comments, and nested block comments', () => {
    const pgScript = [
      "-- header; ignore ;",
      "SELECT 'a;b', 'O''Brien;c', E'it\\'s;d' AS s;",
      'SELECT "col;1", "x""y;z" FROM `tbl;1` WHERE `c``d;e` = 1;',
      'CREATE FUNCTION f() RETURNS void AS $$ BEGIN PERFORM 1; PERFORM 2; END; $$ LANGUAGE plpgsql;',
      'SELECT $tag$nested ; semicolon$tag$ /* outer ; /* inner ; */ still comment ; */;',
      '  ;  -- trailing only',
    ].join('\n')

    const stmts = splitSqlStatements(pgScript, 'postgres')
    expect(stmts).toHaveLength(4)
    expect(stmts[0].text).toBe("-- header; ignore ;\nSELECT 'a;b', 'O''Brien;c', E'it\\'s;d' AS s")
    expect(stmts[1].text).toBe('SELECT "col;1", "x""y;z" FROM `tbl;1` WHERE `c``d;e` = 1')
    expect(stmts[2].text).toBe(
      'CREATE FUNCTION f() RETURNS void AS $$ BEGIN PERFORM 1; PERFORM 2; END; $$ LANGUAGE plpgsql'
    )
    expect(stmts[3].text).toBe(
      'SELECT $tag$nested ; semicolon$tag$ /* outer ; /* inner ; */ still comment ; */'
    )

    for (const stmt of stmts) {
      expect(pgScript.slice(stmt.start, stmt.end)).toBe(stmt.text)
    }

    // MySQL backslash single-quote escaping preserves semicolons inside 'it\'s;d'
    const mysqlStmts = splitSqlStatements("SELECT 'it\\'s;d' AS s; # trailing; comment", 'mysql')
    expect(mysqlStmts).toHaveLength(1)
    expect(mysqlStmts[0].text).toBe("SELECT 'it\\'s;d' AS s")
  })

  it('finds the exact statement at caret offset across statement boundaries', () => {
    const script = 'SELECT 1;\nSELECT 2;\nSELECT 3;'
    const firstEnd = 'SELECT 1'.length

    expect(findStatementAtOffset(script, 0)).toBe('SELECT 1')
    expect(findStatementAtOffset(script, 4)).toBe('SELECT 1')
    expect(findStatementAtOffset(script, firstEnd)).toBe('SELECT 1')
    expect(findStatementAtOffset(script, firstEnd + 1)).toBe('SELECT 1')

    const secondStart = script.indexOf('SELECT 2')
    expect(findStatementAtOffset(script, secondStart)).toBe('SELECT 2')
    expect(findStatementAtOffset(script, secondStart + 5)).toBe('SELECT 2')

    const thirdStart = script.indexOf('SELECT 3')
    expect(findStatementAtOffset(script, thirdStart)).toBe('SELECT 3')
    expect(findStatementAtOffset(script, script.length)).toBe('SELECT 3')

    expect(findStatementAtOffset('   -- only comment\n  ', 3)).toBe('')
  })
})

describe('sql-tools: reconstructTableDdl', () => {
  const sampleDetails: TableDetails = {
    name: 'orders',
    schema: 'public',
    kind: 'table',
    columns: [
      {
        name: 'id',
        type: 'integer',
        nativeType: 'int4',
        nullable: false,
        defaultValue: null,
        isPrimaryKey: true,
        isAutoIncrement: true,
      },
      {
        name: 'user_id',
        type: 'integer',
        nativeType: 'int4',
        nullable: false,
        defaultValue: null,
        isPrimaryKey: false,
        isAutoIncrement: false,
      },
      {
        name: 'code',
        type: 'text',
        nativeType: 'varchar(64)',
        nullable: true,
        defaultValue: "'pending'",
        isPrimaryKey: false,
        isAutoIncrement: false,
      },
    ],
    primaryKey: ['id'],
    indexes: [
      { name: 'orders_pkey', isUnique: true, isPrimary: true, columns: ['id'] },
      { name: 'idx_orders_code', isUnique: true, isPrimary: false, columns: ['code'] },
      { name: 'idx_orders_user', isUnique: false, isPrimary: false, columns: ['user_id', 'code'] },
    ],
    foreignKeys: [
      {
        constraintName: 'fk_orders_user',
        column: 'user_id',
        referencedTable: 'public.users',
        referencedColumn: 'id',
      },
    ],
  }

  it('reconstructs CREATE TABLE, PK, FK, and CREATE [UNIQUE] INDEX for postgres and mysql', () => {
    const pgDdl = reconstructTableDdl(sampleDetails, 'postgres')
    expect(pgDdl).toContain('CREATE TABLE "public"."orders" (')
    expect(pgDdl).toContain('"id" int4 GENERATED BY DEFAULT AS IDENTITY NOT NULL')
    expect(pgDdl).toContain('"code" varchar(64) DEFAULT \'pending\'')
    expect(pgDdl).toContain('PRIMARY KEY ("id")')
    expect(pgDdl).toContain(
      'CONSTRAINT "fk_orders_user" FOREIGN KEY ("user_id") REFERENCES "public"."users" ("id")'
    )
    expect(pgDdl).not.toContain('orders_pkey')
    expect(pgDdl).toContain('CREATE UNIQUE INDEX "idx_orders_code" ON "public"."orders" ("code");')
    expect(pgDdl).toContain('CREATE INDEX "idx_orders_user" ON "public"."orders" ("user_id", "code");')

    const mysqlDdl = reconstructTableDdl({ ...sampleDetails, schema: 'shop' }, 'mysql')
    expect(mysqlDdl).toContain('CREATE TABLE `shop`.`orders` (')
    expect(mysqlDdl).toContain('`id` int4 NOT NULL AUTO_INCREMENT')
    expect(mysqlDdl).toContain('PRIMARY KEY (`id`)')
    expect(mysqlDdl).toContain('CREATE UNIQUE INDEX `idx_orders_code` ON `shop`.`orders` (`code`);')
  })

  it('reconstructs valid SQLite DDL with inline INTEGER PRIMARY KEY AUTOINCREMENT when schema is main', () => {
    const sqliteDetails: TableDetails = {
      name: 'items',
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
          name: 'title',
          type: 'TEXT',
          nativeType: 'TEXT',
          nullable: false,
          defaultValue: "''",
          isPrimaryKey: false,
          isAutoIncrement: false,
        },
      ],
      primaryKey: ['id'],
      indexes: [],
      foreignKeys: [],
    }

    const ddl = reconstructTableDdl(sqliteDetails, 'sqlite')
    expect(ddl).toContain('CREATE TABLE "items" (')
    expect(ddl).not.toContain('"main".')
    expect(ddl).toContain('"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL')
  })
})

describe('sql-tools: sanitizeFilterClause', () => {
  it('trims clauses, strips leading WHERE / ORDER BY, and preserves quoted special chars', () => {
    expect(sanitizeFilterClause(undefined)).toBeUndefined()
    expect(sanitizeFilterClause('   ')).toBeUndefined()
    expect(sanitizeFilterClause('WHERE   ')).toBeUndefined()
    expect(sanitizeFilterClause('order by  ')).toBeUndefined()

    expect(sanitizeFilterClause("  WHERE status = 'active'  ")).toBe("status = 'active'")
    expect(sanitizeFilterClause('ORDER BY created_at DESC, id ASC')).toBe('created_at DESC, id ASC')
    expect(sanitizeFilterClause('where_id = 10')).toBe('where_id = 10')
    expect(sanitizeFilterClause('order_date DESC')).toBe('order_date DESC')

    expect(sanitizeFilterClause("note = 'a;b -- /*safe*/' AND \"col;1\" = 5")).toBe(
      "note = 'a;b -- /*safe*/' AND \"col;1\" = 5"
    )
    expect(sanitizeFilterClause('`col--1` = 1')).toBe('`col--1` = 1')
  })

  it('rejects unquoted statement breakouts (;, --, /*) and unclosed quotes', () => {
    const malicious = [
      'id = 1; DROP TABLE users',
      "name = 'ok'; DELETE FROM users",
      'id = 1 -- bypass',
      'id = 1 /* comment */',
      "name = 'unclosed",
    ]
    for (const clause of malicious) {
      expect(() => sanitizeFilterClause(clause), `Expected rejection for: ${clause}`).toThrow()
    }
  })
})

describe('sql-tools: isMutatingStatement', () => {
  it('blocks SQL mutation verbs, writable CTEs, multi-statement mutations, and PRAGMA writable_schema while allowing read-only SQL', () => {
    const blockedSql = [
      'INSERT INTO users (name) VALUES (\'a\')',
      'UPDATE users SET active = 0 WHERE id = 1',
      'DELETE FROM users WHERE id = 1',
      'REPLACE INTO cache VALUES (1, 2)',
      'UPSERT INTO kv VALUES (1, 2)',
      'DROP TABLE users',
      'ALTER TABLE users ADD COLUMN age INT',
      'CREATE TABLE temp (id INT)',
      'TRUNCATE TABLE audit_log',
      'GRANT SELECT ON users TO app',
      'REVOKE ALL ON users FROM app',
      "ATTACH DATABASE 'other.db' AS aux",
      'PRAGMA writable_schema = 1',
      'PRAGMA writable_schema',
      'WITH d AS (DELETE FROM orders WHERE id = 1 RETURNING *) SELECT * FROM d',
      'SELECT 1; DROP TABLE users',
      'EXPLAIN ANALYZE DELETE FROM users',
    ]
    for (const sql of blockedSql) {
      expect(isMutatingStatement(sql, 'postgres'), `Expected SQL block: ${sql}`).toBe(true)
      expect(isMutatingStatement(sql, 'sqlite'), `Expected SQLite block: ${sql}`).toBe(true)
    }

    const allowedSql = [
      'SELECT * FROM users WHERE id = 1',
      "SELECT 'DROP TABLE users; DELETE FROM x' AS note",
      '-- DELETE FROM users\nSELECT 1',
      '/* UPDATE users */ SELECT count(*) FROM users',
      'EXPLAIN SELECT * FROM users',
      'SHOW TABLES',
      'SHOW CREATE TABLE users',
      'DESCRIBE users',
      'PRAGMA table_info(users)',
      'WITH active AS (SELECT id FROM users) SELECT * FROM active',
    ]
    for (const sql of allowedSql) {
      expect(isMutatingStatement(sql, 'postgres'), `Expected PG allow: ${sql}`).toBe(false)
      expect(isMutatingStatement(sql, 'mysql'), `Expected MySQL allow: ${sql}`).toBe(false)
      expect(isMutatingStatement(sql, 'sqlite'), `Expected SQLite allow: ${sql}`).toBe(false)
    }
  })

  it('blocks write Redis commands and allows read-only Redis commands', () => {
    const blockedRedis = [
      'SET foo bar',
      'DEL foo',
      'UNLINK foo bar',
      'HSET user:1 name alice',
      'HDEL user:1 name',
      'LPUSH queue job1',
      'RPUSH queue job2',
      'SADD tags db',
      'ZADD scores 100 alice',
      'FLUSHDB',
      'FLUSHALL',
      'RENAME old new',
      'EXPIRE session:1 60',
      'INCR counter',
      'DECR counter',
      'PING\nSET evil 1',
      'CONFIG SET maxmemory 100mb',
    ]
    for (const cmd of blockedRedis) {
      expect(isMutatingStatement(cmd, 'redis'), `Expected Redis block: ${cmd}`).toBe(true)
    }

    const allowedRedis = [
      'GET foo',
      'SCAN 0 MATCH user:* COUNT 100',
      'TYPE user:1',
      'TTL session:1',
      'KEYS user:*',
      'PING',
      'INFO server',
      'CONFIG GET maxmemory',
    ]
    for (const cmd of allowedRedis) {
      expect(isMutatingStatement(cmd, 'redis'), `Expected Redis allow: ${cmd}`).toBe(false)
    }
  })
})

describe('brand assets, manifest & protocol contract', () => {
  const projectRoot = path.resolve(__dirname, '../..')

  function readPngDimensions(buf: Buffer): { width: number; height: number } {
    const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(buf.subarray(0, 8).equals(pngSig)).toBe(true)
    expect(buf.subarray(12, 16).toString('ascii')).toBe('IHDR')
    return {
      width: buf.readUInt32BE(16),
      height: buf.readUInt32BE(20),
    }
  }

  it('provides crisp 256x256 assets/icon.png (< 200 KB) and 64x64 DATANOA_LOGO_DATA_URI (< 15 KB)', () => {
    const iconPath = path.join(projectRoot, 'assets/icon.png')
    expect(fs.existsSync(iconPath)).toBe(true)
    const iconBuf = fs.readFileSync(iconPath)
    expect(iconBuf.byteLength).toBeGreaterThan(0)
    expect(iconBuf.byteLength).toBeLessThan(200 * 1024)
    expect(readPngDimensions(iconBuf)).toEqual({ width: 256, height: 256 })

    const logoTsPath = path.join(projectRoot, 'src/assets/logo.ts')
    expect(fs.existsSync(logoTsPath)).toBe(true)
    expect(fs.statSync(logoTsPath).size).toBeLessThan(15 * 1024)
    expect(DATANOA_LOGO_DATA_URI.startsWith('data:image/png;base64,')).toBe(true)

    const logoBuf = Buffer.from(
      DATANOA_LOGO_DATA_URI.slice('data:image/png;base64,'.length),
      'base64'
    )
    expect(readPngDimensions(logoBuf)).toEqual({ width: 64, height: 64 })
  })

  it('includes marketplace metadata in orca-plugin.json, LICENSE, and THIRD-PARTY-NOTICES.md', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'orca-plugin.json'), 'utf8')
    )
    expect(manifest.$schema).toBe(
      'https://raw.githubusercontent.com/stablyai/orca/main/docs/schemas/plugins/orca-plugin.v2.schema.json'
    )
    expect(manifest.license).toBe('MIT')
    expect(manifest.icon).toBe('assets/icon.png')
    expect(manifest.id).toBe('datanoa')
    expect(manifest.execution).toBe('trusted-worker')

    const license = fs.readFileSync(path.join(projectRoot, 'LICENSE'), 'utf8')
    expect(license).toContain('MIT License')

    const notices = fs.readFileSync(path.join(projectRoot, 'THIRD-PARTY-NOTICES.md'), 'utf8')
    expect(notices).toContain('pg')
    expect(notices).toContain('mysql2')
    expect(notices).toContain('@codemirror/')
  })

  it('exposes strictly typed JetBrains protocol extensions with zero : any', () => {
    const protocolSrc = fs.readFileSync(path.join(projectRoot, 'src/protocol.ts'), 'utf8')
    expect(protocolSrc).not.toMatch(/: any\b/)

    const tag: ConnectionColorTag = 'prod'
    const profile: ConnectionProfile = {
      id: 'c1',
      name: 'prod-db',
      driver: 'postgres',
      database: 'app',
      colorTag: tag,
    }
    const history: QueryHistoryEntry = {
      id: 'h1',
      timestamp: Date.now(),
      connectionId: profile.id,
      connectionName: profile.name,
      driver: profile.driver,
      sql: 'SELECT 1',
      durationMs: 4,
      rowCount: 1,
      isError: false,
    }
    const fetchInput: PluginRequests['data.fetchPage']['input'] = {
      connectionId: 'c1',
      table: 'users',
      page: 1,
      pageSize: 50,
      whereClause: 'active = true',
      orderByClause: 'id DESC',
    }
    const applyRes: PluginRequests['data.applyChanges']['output'] = {
      ok: true,
      inserted: 1,
      updated: 0,
      deleted: 0,
      statements: ['INSERT INTO "users" ("id") VALUES (1);'],
    }
    const previewRes: PluginRequests['data.previewChanges']['output'] = {
      statements: applyRes.statements,
    }
    const detectRes: PluginRequests['workspace.detectConnections']['output'] = {
      sqliteFiles: [],
      envConnections: [],
    }
    const ddlRes: PluginRequests['schema.generateDdl']['output'] = { ddl: 'CREATE TABLE "users" ();' }
    const explainInput: PluginRequests['query.explain']['input'] = {
      connectionId: 'c1',
      sql: 'SELECT 1',
      queryId: 'explain_1',
    }
    const historyListRes: PluginRequests['query.history.list']['output'] = { entries: [history] }
    const historyClearRes: PluginRequests['query.history.clear']['output'] = { ok: true }

    // Verify `declare module 'orca'` augmentation compatibility for optional & required args
    const historyArgsEmpty: PluginRequestArgs<'query.history.list'> = []
    const historyArgsWithLimit: PluginRequestArgs<'query.history.list'> = [{ limit: 50 }]
    const historyInputCheck: PluginRequestInput<'query.history.list'> = { limit: 10 }
    const explainOutputCheck: PluginRequestOutput<'query.explain'> = {
      columns: [],
      rows: [],
      rowCount: 0,
      executionTimeMs: 1,
      truncated: false,
      isSelect: true,
    }
    const clearArgsEmpty: PluginRequestArgs<'query.history.clear'> = []

    expect(historyArgsEmpty).toHaveLength(0)
    expect(historyArgsWithLimit).toHaveLength(1)
    expect(historyInputCheck?.limit).toBe(10)
    expect(explainOutputCheck.isSelect).toBe(true)
    expect(clearArgsEmpty).toHaveLength(0)

    expect(fetchInput.whereClause).toBe('active = true')
    expect(previewRes.statements).toHaveLength(1)
    expect(detectRes.sqliteFiles).toEqual([])
    expect(ddlRes.ddl).toContain('CREATE TABLE')
    expect(explainInput.sql).toBe('SELECT 1')
    expect(historyListRes.entries).toHaveLength(1)
    expect(historyClearRes.ok).toBe(true)
  })

  it('normalizes SQL default expressions and builds multi-dialect table migrations (SQLite 12-step rebuild, Postgres, MySQL, ClickHouse)', () => {
    // 1. Smart default quoting & expression preservation
    expect(normalizeSqlDefaultExpression('active', 'TEXT')).toBe("'active'")
    expect(normalizeSqlDefaultExpression("it's ok", 'VARCHAR(255)')).toBe("'it''s ok'")
    expect(normalizeSqlDefaultExpression('0', 'INTEGER')).toBe('0')
    expect(normalizeSqlDefaultExpression('3.14', 'REAL')).toBe('3.14')
    expect(normalizeSqlDefaultExpression('true', 'BOOLEAN')).toBe('true')
    expect(normalizeSqlDefaultExpression('CURRENT_TIMESTAMP', 'TIMESTAMP')).toBe('CURRENT_TIMESTAMP')
    expect(normalizeSqlDefaultExpression('NULL', 'TEXT')).toBe('NULL')

    const baseDetails: TableDetails = {
      name: 'users',
      schema: 'main',
      kind: 'table',
      columns: [
        {
          name: 'id',
          type: 'integer',
          nativeType: 'INTEGER',
          nullable: false,
          defaultValue: null,
          isPrimaryKey: true,
          isAutoIncrement: true,
        },
        {
          name: 'email',
          type: 'text',
          nativeType: 'TEXT',
          nullable: true,
          defaultValue: null,
          isPrimaryKey: false,
          isAutoIncrement: false,
        },
      ],
      primaryKey: ['id'],
      indexes: [],
      foreignKeys: [],
    }

    // 2. SQLite modifying column default/nullability triggers 12-step atomic rebuild
    const sqliteDraft = createInitialTableDraft(baseDetails)
    sqliteDraft.columns[1].defaultValue = 'unknown@local'
    sqliteDraft.columns[1].nullable = false
    sqliteDraft.indexes.push({
      id: 'idx_new',
      name: 'idx_users_email',
      columns: ['email'],
      unique: true,
      status: 'new',
    })
    const sqliteStmts = buildTableMigrationSql(sqliteDraft, 'sqlite')
    expect(sqliteStmts[0]).toBe('PRAGMA foreign_keys = OFF;')
    expect(sqliteStmts[1]).toBe('BEGIN IMMEDIATE;')
    const joinedSqlite = sqliteStmts.join('\n')
    expect(joinedSqlite).toContain('CREATE TABLE "__datanoa_new_users"')
    expect(joinedSqlite).toContain("COALESCE(\"email\", 'unknown@local')")
    expect(joinedSqlite).toContain('DROP TABLE "users";')
    expect(joinedSqlite).toContain('ALTER TABLE "__datanoa_new_users" RENAME TO "users";')
    expect(joinedSqlite).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_email" ON "users" ("email");')
    expect(sqliteStmts[sqliteStmts.length - 1]).toBe('PRAGMA foreign_keys = ON;')

    // 3. Postgres ALTER COLUMN + ADD CONSTRAINT
    const pgDraft = createInitialTableDraft(baseDetails)
    pgDraft.schema = 'public'
    pgDraft.columns[1].defaultValue = 'guest'
    pgDraft.columns[1].nullable = false
    pgDraft.foreignKeys.push({
      id: 'fk_new',
      constraintName: 'fk_users_org',
      column: 'id',
      foreignTable: 'orgs',
      foreignColumn: 'id',
      onDelete: 'CASCADE',
      onUpdate: 'NO ACTION',
      status: 'new',
    })
    const pgSql = buildTableMigrationSql(pgDraft, 'postgres').join('\n')
    expect(pgSql).toContain("ALTER TABLE \"users\" ALTER COLUMN \"email\" SET NOT NULL, ALTER COLUMN \"email\" SET DEFAULT 'guest';")
    expect(pgSql).toContain('ADD CONSTRAINT "fk_users_org" FOREIGN KEY ("id") REFERENCES "orgs" ("id") ON DELETE CASCADE;')

    // 4. MySQL MODIFY COLUMN + CREATE UNIQUE INDEX
    const mysqlDraft = createInitialTableDraft(baseDetails)
    mysqlDraft.schema = undefined
    mysqlDraft.columns[1].dataType = 'VARCHAR(190)'
    mysqlDraft.columns[1].defaultValue = 'none'
    const mysqlSql = buildTableMigrationSql(mysqlDraft, 'mysql').join('\n')
    expect(mysqlSql).toContain("ALTER TABLE `users` MODIFY COLUMN `email` VARCHAR(190) NULL DEFAULT 'none';")

    // 5. ClickHouse MODIFY COLUMN + ADD INDEX
    const chDraft = createInitialTableDraft(baseDetails)
    chDraft.schema = undefined
    chDraft.columns[1].defaultValue = 'na'
    chDraft.indexes.push({
      id: 'ch_idx',
      name: 'idx_email_minmax',
      columns: ['email'],
      unique: false,
      status: 'new',
    })
    const chSql = buildTableMigrationSql(chDraft, 'clickhouse').join('\n')
    expect(chSql).toContain("ALTER TABLE `users` MODIFY COLUMN `email` TEXT DEFAULT 'na';")
    expect(chSql).toContain('ALTER TABLE `users` ADD INDEX `idx_email_minmax` (`email`) TYPE minmax GRANULARITY 1;')

    // 6. Strict pre-flight validation rejects invalid/nonsensical edits
    expect(() => normalizeSqlDefaultExpression("'a' OR '1'='1'", 'TEXT')).toThrow()
    expect(() => normalizeSqlDefaultExpression('(SELECT 1)', 'INTEGER')).toThrow()
    expect(() => normalizeSqlDefaultExpression('(1) OR (1=1)', 'INTEGER')).toThrow()
    expect(() => normalizeSqlDefaultExpression('linhtinh', 'INTEGER')).toThrow()
    expect(() => normalizeSqlDefaultExpression("'abc'", 'INTEGER')).toThrow()
    expect(() => normalizeSqlDefaultExpression("'abc'::int", 'INTEGER')).toThrow()

    const invalidDraft = createInitialTableDraft(baseDetails)
    invalidDraft.columns[1].name = 'id' // Duplicate column name
    invalidDraft.columns[1].dataType = 'VARCHAR(' // Unbalanced parens
    invalidDraft.columns[0].defaultValue = 'not_a_number' // Non-numeric default on INTEGER
    invalidDraft.foreignKeys.push({
      id: 'fk_bad',
      constraintName: 'fk_bad',
      column: 'missing_col',
      foreignTable: 'non_existent_table',
      foreignColumn: '',
      onDelete: 'CASCADE',
      onUpdate: 'NO ACTION',
      status: 'new',
    })
    const invalidPlan = validateTableStructureDraft(invalidDraft, 'postgres', ['users', 'orgs'])
    expect(invalidPlan.valid).toBe(false)
    expect(invalidPlan.errors.length).toBeGreaterThanOrEqual(4)

    // 7. PostgreSQL sequence defaults with nested ::regclass cast (e.g. nextval('menu_items_item_id_seq'::regclass))
    expect(
      normalizeSqlDefaultExpression("nextval('menu_items_item_id_seq'::regclass)", 'int4')
    ).toBe("nextval('menu_items_item_id_seq'::regclass)")
    expect(
      normalizeSqlDefaultExpression("('now'::text)::timestamp with time zone", 'timestamptz')
    ).toBe("('now'::text)::timestamp with time zone")

    const pgSeqDetails: TableDetails = {
      name: 'menu_items',
      schema: 'public',
      kind: 'table',
      columns: [
        {
          name: 'item_id',
          type: 'int4',
          nativeType: 'int4',
          nullable: false,
          defaultValue: "nextval('menu_items_item_id_seq'::regclass)",
          isPrimaryKey: true,
          isAutoIncrement: true,
        },
        {
          name: 'name',
          type: 'varchar',
          nativeType: 'varchar',
          nullable: false,
          defaultValue: null,
          isPrimaryKey: false,
          isAutoIncrement: false,
        },
      ],
      primaryKey: ['item_id'],
      indexes: [],
      foreignKeys: [],
    }
    const pgSeqDraft = createInitialTableDraft(pgSeqDetails)
    pgSeqDraft.columns[1].dataType = 'VARCHAR(255)'
    const pgSeqPlan = validateTableStructureDraft(pgSeqDraft, 'postgres', ['menu_items'])
    expect(pgSeqPlan.valid).toBe(true)
    expect(pgSeqPlan.errors).toEqual([])
  })
})

describe('sql-tools: Wave 11 utilities (formatSqlLiteral, formatSqlInList, formatCellMatrixExport, buildQuickFilterPredicate, formatSql, DDL builders)', () => {
  it('exports formatSqlLiteral across dialects and types', () => {
    expect(formatSqlLiteral(null, 'postgres')).toBe('NULL')
    expect(formatSqlLiteral(undefined, 'postgres')).toBe('NULL')
    expect(formatSqlLiteral(42, 'postgres')).toBe('42')
    expect(formatSqlLiteral(true, 'postgres')).toBe('TRUE')
    expect(formatSqlLiteral("O'Reilly", 'postgres')).toBe("'O''Reilly'")
    expect(formatSqlLiteral("C:\\O'Brien", 'mysql')).toBe("'C:\\\\O''Brien'")
  })

  it('formats SQL IN lists with deduplication, empty/NULL handling, and optional columnName', () => {
    expect(formatSqlInList([], 'postgres')).toBe('')
    expect(formatSqlInList([], 'postgres', { columnName: 'id' })).toBe('')
    expect(formatSqlInList([1, 2, 2, 3], 'postgres')).toBe('(1, 2, 3)')
    expect(formatSqlInList([1, 2, 2], 'postgres', { deduplicate: false })).toBe('(1, 2, 2)')
    expect(formatSqlInList(['a', "b'c", 'a'], 'postgres', { columnName: 'code' })).toBe(
      `"code" IN ('a', 'b''c')`
    )
    expect(formatSqlInList([null, undefined], 'postgres', { columnName: 'deleted_at' })).toBe(
      '"deleted_at" IS NULL'
    )
    expect(formatSqlInList([1, null, 2, 1], 'mysql', { columnName: 'status' })).toBe(
      '(`status` IN (1, 2) OR `status` IS NULL)'
    )
    expect(formatSqlInList([null], 'sqlite')).toBe('(NULL)')
  })

  it('formats cell matrices for tsv, tsv-headers, csv, and json', () => {
    const headers = ['id', 'note']
    const matrix: unknown[][] = [
      [1, 'hello, "world"\nline2'],
      [2, null],
    ]
    expect(formatCellMatrixExport(headers, matrix, 'tsv')).toBe(
      '1\t"hello, ""world""\nline2"\n2\t'
    )
    expect(formatCellMatrixExport(headers, matrix, 'tsv-headers')).toBe(
      'id\tnote\n1\t"hello, ""world""\nline2"\n2\t'
    )
    expect(formatCellMatrixExport(headers, matrix, 'csv')).toBe(
      'id,note\n1,"hello, ""world""\nline2"\n2,'
    )
    expect(formatCellMatrixExport(headers, matrix, 'json')).toBe(
      JSON.stringify(
        [
          { id: 1, note: 'hello, "world"\nline2' },
          { id: 2, note: null },
        ],
        null,
        2
      )
    )
  })

  it('builds safe quick-filter predicates that pass sanitizeFilterClause', () => {
    const eqPg = buildQuickFilterPredicate('email', "a'b; -- /*x*/", 'eq', 'postgres')
    expect(eqPg).toBe(`"email" = 'a''b; -- /*x*/'`)
    expect(sanitizeFilterClause(eqPg)).toBe(eqPg)

    const neqMysql = buildQuickFilterPredicate('status', 5, 'neq', 'mysql')
    expect(neqMysql).toBe('`status` != 5')
    expect(sanitizeFilterClause(neqMysql)).toBe(neqMysql)

    const eqNull = buildQuickFilterPredicate('deleted_at', null, 'eq', 'sqlite')
    expect(eqNull).toBe('"deleted_at" IS NULL')
    expect(sanitizeFilterClause(eqNull)).toBe(eqNull)

    const neqNull = buildQuickFilterPredicate('deleted_at', null, 'neq', 'sqlite')
    expect(neqNull).toBe('"deleted_at" IS NOT NULL')
    expect(sanitizeFilterClause(neqNull)).toBe(neqNull)

    expect(buildQuickFilterPredicate('bio', 'ignored', 'is-null', 'postgres')).toBe('"bio" IS NULL')
    expect(buildQuickFilterPredicate('bio', 'ignored', 'is-not-null', 'postgres')).toBe(
      '"bio" IS NOT NULL'
    )
  })

  it('formats SQL cleanly while strictly preserving quotes, comments, dollar-quotes, and statement boundaries', () => {
    const raw =
      "select u.id, u.name, 'select from where' as note from \"users\" u left join `orders` o on o.user_id = u.id where u.active = true and o.total > 10 or u.role = 'admin' group by u.id having count(o.id) > 0 order by u.id desc limit 20 offset 5; -- keep comment\n/* block select */ select $$begin; select 1; end;$$;"
    const formatted = formatSql(raw, 'postgres')

    expect(formatted).toContain("SELECT\n  u.id,\n  u.name,\n  'select from where' AS note")
    expect(formatted).toContain('\nFROM "users" u')
    expect(formatted).toContain('\nLEFT JOIN `orders` o ON o.user_id = u.id')
    expect(formatted).toContain('\nWHERE u.active = TRUE\n  AND o.total > 10\n  OR u.role = \'admin\'')
    expect(formatted).toContain('\nGROUP BY u.id')
    expect(formatted).toContain('\nHAVING COUNT(o.id) > 0')
    expect(formatted).toContain('\nORDER BY u.id DESC')
    expect(formatted).toContain('\nLIMIT 20\nOFFSET 5;')
    expect(formatted).toContain('-- keep comment')
    expect(formatted).toContain('/* block select */')
    expect(formatted).toContain('$$begin; select 1; end;$$')

    // BETWEEN ... AND must stay inline without splitting AND onto a new line
    const betweenFmt = formatSql('select id from logs where created_at between 1 and 10 and active = true')
    expect(betweenFmt).toContain('WHERE created_at BETWEEN 1 AND 10\n  AND active = TRUE')
  })

  it('builds CREATE TABLE, TRUNCATE TABLE, and DROP TABLE/VIEW SQL and flags all as mutating', () => {
    const cols: CreateTableColumnDraft[] = [
      { name: 'id', dataType: 'INTEGER', nullable: false, isPrimaryKey: true, isAutoIncrement: true },
      { name: 'email', dataType: 'VARCHAR(255)', nullable: false, defaultValue: 'guest@local' },
    ]
    const sqliteCreate = buildCreateTableSql({ tableName: 'accounts', columns: cols }, 'sqlite')
    expect(sqliteCreate).toContain('CREATE TABLE "accounts"')
    expect(sqliteCreate).toContain('"id" INTEGER PRIMARY KEY AUTOINCREMENT')
    expect(sqliteCreate).toContain(`"email" VARCHAR(255) NOT NULL DEFAULT 'guest@local'`)
    expect(isMutatingStatement(sqliteCreate, 'sqlite')).toBe(true)

    const pgCreate = buildCreateTableSql(
      {
        tableName: 'memberships',
        schema: 'app',
        columns: [
          { name: 'org_id', dataType: 'INT', nullable: false, isPrimaryKey: true },
          { name: 'user_id', dataType: 'INT', nullable: false, isPrimaryKey: true },
          { name: 'role', dataType: 'TEXT', nullable: false, defaultValue: 'member' },
        ],
      },
      'postgres'
    )
    expect(pgCreate).toContain('CREATE TABLE "app"."memberships"')
    expect(pgCreate).toContain('PRIMARY KEY ("org_id", "user_id")')
    expect(isMutatingStatement(pgCreate, 'postgres')).toBe(true)

    const mysqlCreate = buildCreateTableSql({ tableName: 'events', columns: cols }, 'mysql')
    expect(mysqlCreate).toContain('CREATE TABLE `events`')
    expect(mysqlCreate).toContain('AUTO_INCREMENT')
    expect(mysqlCreate).toContain('PRIMARY KEY (`id`)')
    expect(isMutatingStatement(mysqlCreate, 'mysql')).toBe(true)

    // Validation rejects duplicate column names, empty names, invalid types/defaults
    expect(() =>
      buildCreateTableSql({ tableName: '', columns: cols }, 'sqlite')
    ).toThrow()
    expect(() =>
      buildCreateTableSql(
        {
          tableName: 'bad',
          columns: [
            { name: 'id', dataType: 'INT' },
            { name: 'ID', dataType: 'TEXT' },
          ],
        },
        'postgres'
      )
    ).toThrow()
    expect(() =>
      buildCreateTableSql(
        { tableName: 'bad', columns: [{ name: 'n', dataType: 'INT', defaultValue: 'not_num' }] },
        'postgres'
      )
    ).toThrow()

    // Truncate
    const truncSqlite = buildTruncateTableSql('accounts', 'sqlite')
    const truncLibsql = buildTruncateTableSql('accounts', 'libsql')
    const truncPg = buildTruncateTableSql('accounts', 'postgres', 'app')
    const truncMysql = buildTruncateTableSql('accounts', 'mysql')
    const truncCh = buildTruncateTableSql('accounts', 'clickhouse')
    expect(truncSqlite).toBe('DELETE FROM "accounts";')
    expect(truncLibsql).toBe('DELETE FROM "accounts";')
    expect(truncPg).toBe('TRUNCATE TABLE "app"."accounts";')
    expect(truncMysql).toBe('TRUNCATE TABLE `accounts`;')
    expect(truncCh).toBe('TRUNCATE TABLE `accounts`;')
    for (const [sql, d] of [
      [truncSqlite, 'sqlite'],
      [truncLibsql, 'libsql'],
      [truncPg, 'postgres'],
      [truncMysql, 'mysql'],
      [truncCh, 'clickhouse'],
    ] as const) {
      expect(isMutatingStatement(sql, d)).toBe(true)
    }

    // Drop
    const dropTbl = buildDropTableSql('accounts', 'table', 'postgres', 'app', true)
    const dropView = buildDropTableSql('v_accounts', 'view', 'mysql', undefined, false)
    expect(dropTbl).toBe('DROP TABLE IF EXISTS "app"."accounts";')
    expect(dropView).toBe('DROP VIEW `v_accounts`;')
    expect(isMutatingStatement(dropTbl, 'postgres')).toBe(true)
    expect(isMutatingStatement(dropView, 'mysql')).toBe(true)
  })
})

describe('sql-tools: Wave 12 Security, Dialect Lexer, DDL & Safety Regressions', () => {
  it('blocks backslash-quote SQLi & readOnly bypasses on Postgres/SQLite/LibSQL while supporting Windows paths and PG JSONB #>>', () => {
    // 1. Backslash-quote SQLi in WHERE clause MUST throw on standard SQL dialects
    for (const dialect of ['postgres', 'cockroachdb', 'sqlite', 'libsql'] as const) {
      expect(() =>
        sanitizeFilterClause("name = '\\'; DROP TABLE users; --'", dialect)
      ).toThrow(/semicolon/i)
      expect(isMutatingStatement("SELECT '\\'; DROP TABLE users; --'", dialect)).toBe(true)
    }

    // 2. Double-quoted identifier NEVER allows backslash escaping even in MySQL/MariaDB/ClickHouse
    for (const dialect of ['mysql', 'mariadb', 'clickhouse', 'postgres', 'sqlite'] as const) {
      expect(() =>
        sanitizeFilterClause('"col\\"; DROP TABLE users; --"', dialect)
      ).toThrow(/semicolon/i)
    }

    // 3. Windows paths ending in backslash MUST succeed on PG/SQLite/LibSQL and MySQL
    const pgWinPath = buildQuickFilterPredicate('path', 'C:\\temp\\', 'eq', 'postgres')
    expect(pgWinPath).toBe(`"path" = 'C:\\temp\\'`)
    expect(sanitizeFilterClause(pgWinPath, 'postgres')).toBe(pgWinPath)
    expect(sanitizeFilterClause("path = 'C:\\temp\\'", 'sqlite')).toBe("path = 'C:\\temp\\'")

    const mysqlWinPath = buildQuickFilterPredicate('path', 'C:\\temp\\', 'eq', 'mysql')
    expect(mysqlWinPath).toBe("`path` = 'C:\\\\temp\\\\'")
    expect(sanitizeFilterClause(mysqlWinPath, 'mysql')).toBe(mysqlWinPath)

    // 4. PG JSONB #> / #>> allowed in Postgres/CockroachDB, while `#` comment blocked in MySQL/ClickHouse
    expect(sanitizeFilterClause("payload #>> '{user,name}' = 'alice'", 'postgres')).toBe(
      "payload #>> '{user,name}' = 'alice'"
    )
    expect(() => sanitizeFilterClause('id = 1 # comment', 'mysql')).toThrow(/comment/i)
    expect(() => sanitizeFilterClause('id = 1 # comment', 'clickhouse')).toThrow(/comment/i)

    // `#` is NOT a comment in Postgres so trailing DROP TABLE cannot be smuggled behind `#`
    expect(isMutatingStatement('SELECT 1 # 2; DROP TABLE users;', 'postgres')).toBe(true)
    expect(splitSqlStatements('SELECT 1 # 2; SELECT 3;', 'postgres')).toHaveLength(2)
  })

  it('blocks MySQL executable comments, EXPLAIN ANALY[ZS]E variants, and expanded mutating verbs', () => {
    // MySQL executable comments must NOT be stripped during mutation detection
    expect(isMutatingStatement('/*!50000 DROP TABLE users */', 'mysql')).toBe(true)
    expect(isMutatingStatement('SELECT 1 /*!50000 ; DROP TABLE users */', 'mysql')).toBe(true)
    expect(isMutatingStatement('/*!50000 DROP TABLE users */', 'mariadb')).toBe(true)
    expect(isMutatingStatement('/*!50000 SELECT 1 */', 'mysql')).toBe(false)

    // EXPLAIN ANALYSE (British) & EXPLAIN (ANALYSE/ANALYZE) & format options
    expect(isMutatingStatement('EXPLAIN ANALYSE DELETE FROM users', 'postgres')).toBe(true)
    expect(isMutatingStatement('EXPLAIN (ANALYSE, BUFFERS) DELETE FROM users', 'postgres')).toBe(true)
    expect(isMutatingStatement('EXPLAIN (ANALYZE ON) SELECT 1', 'postgres')).toBe(true)
    expect(isMutatingStatement('EXPLAIN FORMAT=JSON DELETE FROM users', 'mysql')).toBe(true)
    expect(isMutatingStatement("SELECT * FROM users INTO OUTFILE '/tmp/dump.csv'", 'mysql')).toBe(true)
    expect(hasExplainAnalyzeOption('EXPLAIN ANALYSE DELETE FROM users', 'postgres')).toBe(true)
    expect(hasExplainAnalyzeOption('EXPLAIN (ANALYSE, FORMAT JSON) SELECT 1', 'postgres')).toBe(true)
    expect(hasExplainAnalyzeOption('EXPLAIN (ANALYZE FALSE) SELECT 1', 'postgres')).toBe(false)
    expect(isExplainTargetMutating('EXPLAIN ANALYSE DELETE FROM users', 'postgres')).toBe(true)
    expect(isExplainTargetMutating('EXPLAIN ANALYZE SELECT 1', 'postgres')).toBe(false)
    expect(isMutatingStatement('EXPLAIN (FORMAT JSON, VERBOSE) SELECT 1', 'postgres')).toBe(false)

    // Expanded SQL_MUTATING_VERBS
    const adminMutations = [
      'SHUTDOWN',
      'RESTART',
      'RESET ALL',
      'SET role admin',
      'SYSTEM FLUSH LOGS',
      'EXCHANGE TABLES a AND b',
      'REFRESH MATERIALIZED VIEW mv_sales',
      'CLUSTER users USING idx_users_id',
      'RESTORE TABLE backup_users',
      'INSTALL PLUGIN evil',
      'UNINSTALL PLUGIN good',
      'REASSIGN OWNED BY bob TO alice',
      'PREPARE stmt AS SELECT 1',
      'BEGIN',
      'USE other_db',
    ]
    for (const stmt of adminMutations) {
      expect(isMutatingStatement(stmt, 'postgres'), `Expected mutation block for: ${stmt}`).toBe(true)
      expect(isMutatingStatement(stmt, 'mysql'), `Expected MySQL block for: ${stmt}`).toBe(true)
    }
  })

  it('safely quotes quoteTableReference with interior quotes, fixes PG/MySQL DDL reconstruction, ClickHouse renameTable, PG dropIndex schema, and finite totalRows', () => {
    // 1. quoteTableReference escapes interior quotes instead of returning verbatim
    expect(quoteTableReference('"foo"; DROP TABLE x; --"', 'postgres')).toBe(
      '"""foo""; DROP TABLE x; --"""'
    )
    expect(quoteTableReference('"public"."users"', 'postgres')).toBe('"public"."users"')
    expect(quoteTableReference('`shop`.`orders`', 'mysql')).toBe('`shop`.`orders`')

    // 2. PG reconstructTableDdl preserves precision, converts _text -> text[], and omits IDENTITY when default has nextval(
    const pgRealDetails: TableDetails = {
      name: 'users',
      schema: 'public',
      kind: 'table',
      columns: [
        {
          name: 'id',
          type: 'integer',
          nativeType: 'int4',
          nullable: false,
          defaultValue: "nextval('users_id_seq'::regclass)",
          isPrimaryKey: true,
          isAutoIncrement: true,
        },
        {
          name: 'email',
          type: 'character varying(255)',
          nativeType: 'varchar',
          nullable: false,
          defaultValue: null,
          isPrimaryKey: false,
          isAutoIncrement: false,
        },
        {
          name: 'tags',
          type: 'ARRAY',
          nativeType: '_text',
          nullable: true,
          defaultValue: null,
          isPrimaryKey: false,
          isAutoIncrement: false,
        },
      ],
      primaryKey: ['id'],
      indexes: [],
      foreignKeys: [],
    }
    const pgDdl = reconstructTableDdl(pgRealDetails, 'postgres')
    expect(pgDdl).not.toContain('GENERATED BY DEFAULT AS IDENTITY')
    expect(pgDdl).toContain(`"id" int4 NOT NULL DEFAULT nextval('users_id_seq'::regclass)`)
    expect(pgDdl).toContain('"email" character varying(255) NOT NULL')
    expect(pgDdl).toContain('"tags" text[]')

    // 3. MySQL reconstructTableDdl preserves COLUMN_TYPE length/enum and quotes bare enum default
    const mysqlDetails: TableDetails = {
      name: 'accounts',
      schema: 'shop',
      kind: 'table',
      columns: [
        {
          name: 'email',
          type: 'varchar(255)',
          nativeType: 'varchar',
          nullable: false,
          defaultValue: null,
          isPrimaryKey: false,
          isAutoIncrement: false,
        },
        {
          name: 'status',
          type: "enum('active','disabled')",
          nativeType: 'enum',
          nullable: false,
          defaultValue: 'active',
          isPrimaryKey: false,
          isAutoIncrement: false,
        },
      ],
      primaryKey: [],
      indexes: [],
      foreignKeys: [],
    }
    const mysqlDdl = reconstructTableDdl(mysqlDetails, 'mysql')
    expect(mysqlDdl).toContain('`email` varchar(255) NOT NULL')
    expect(mysqlDdl).toContain("`status` enum('active','disabled') NOT NULL DEFAULT 'active'")

    // 4. ClickHouse renameTable & PG/CockroachDB schema-qualified dropIndex
    expect(
      buildAlterTableSql(
        { kind: 'renameTable', table: 'events', schema: 'analytics', newTableName: 'events_v2' },
        'clickhouse'
      )
    ).toBe('RENAME TABLE `analytics`.`events` TO `analytics`.`events_v2`;')

    expect(
      buildAlterTableSql(
        { kind: 'dropIndex', table: 'events', schema: 'analytics', indexName: 'idx_events_ts' },
        'postgres'
      )
    ).toBe('DROP INDEX "analytics"."idx_events_ts";')

    expect(
      buildAlterTableSql(
        { kind: 'dropIndex', table: 'events', schema: 'public', indexName: 'idx_events_ts' },
        'postgres'
      )
    ).toBe('DROP INDEX "idx_events_ts";')

    // 5. Non-finite or negative totalRows clamped safely to 0
    for (const badTotal of [Number.NaN, Number.POSITIVE_INFINITY, -10, 'not-a-num']) {
      const browse = assembleTableBrowseResult({
        tableDetails: pgRealDetails,
        rows: [],
        countRow: { total: badTotal },
        page: 1,
        pageSize: 50,
      })
      expect(browse.totalRows).toBe(0)
    }
  })

  it('handles PG/CRDB dollar-quotes in sanitizeFilterClause, unary +/- in formatSql, stripLeadingSqlComments, and non-finite pagination guards', () => {
    // 1. PG/CockroachDB dollar-quote scanning blocks injected semicolon/comments after $$...$$
    expect(() =>
      sanitizeFilterClause("name = $$a'$$; DROP TABLE users; -- '", 'postgres')
    ).toThrow(/semicolon/i)
    expect(() =>
      sanitizeFilterClause("name = $tag$a' $tag$ -- comment", 'cockroachdb')
    ).toThrow(/comment/i)
    expect(() => sanitizeFilterClause('name = $tag$unclosed', 'postgres')).toThrow(
      /unclosed \$tag\$/i
    )
    expect(sanitizeFilterClause("name = $tag$a; -- /* b$tag$", 'postgres')).toBe(
      "name = $tag$a; -- /* b$tag$"
    )

    // 2. formatSql keeps unary -/+ attached to numbers while preserving binary subtraction/addition
    const formattedUnary = formatSql(
      'select a - 5, b + 3, -10, +2.5 from accounts where balance >= -5 and delta = +10 and x in (-2, +3) and y between -4 and +8 and z = 1 - -2',
      'postgres'
    )
    expect(formattedUnary).toContain('a - 5')
    expect(formattedUnary).toContain('b + 3')
    expect(formattedUnary).toContain('-10')
    expect(formattedUnary).toContain('+2.5')
    expect(formattedUnary).toContain('balance >= -5')
    expect(formattedUnary).toContain('delta = +10')
    expect(formattedUnary).toContain('IN (-2, +3)')
    expect(formattedUnary).toContain('BETWEEN -4 AND +8')
    expect(formattedUnary).toContain('1 - -2')

    // 3. stripLeadingSqlComments strips --, /* */, and dialect # comments
    expect(stripLeadingSqlComments('/* note */ -- line\nEXPLAIN SELECT 1', 'postgres')).toBe(
      'EXPLAIN SELECT 1'
    )
    expect(stripLeadingSqlComments('# mysql note\nEXPLAIN SELECT 1', 'mysql')).toBe(
      'EXPLAIN SELECT 1'
    )

    // 4. buildSelectPageSql safely clamps Infinity / -Infinity / NaN page & pageSize
    const clampedPage = buildSelectPageSql({
      driver: 'postgres',
      table: 'users',
      schema: 'public',
      page: Number.POSITIVE_INFINITY,
      pageSize: Number.NaN,
    })
    expect(clampedPage.limit).toBe(50)
    expect(clampedPage.offset).toBe(0)
    expect(clampedPage.params).toEqual([50, 0])
  })
})





