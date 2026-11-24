import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import type {
  ColumnInfo,
  DatabaseDriverType,
  SchemaObject,
  SchemaObjectKind,
  TableDetails,
} from '../src/protocol'
import {
  SQLITE_SCHEMA_QUERIES,
  TableDetailsCache,
  assembleFullSchemaDdl,
  collectAndAssembleSchemaDdl,
  introspectMssqlObjectDdl,
  introspectMssqlObjects,
  introspectMssqlSchemas,
  introspectMssqlTableDetails,
  introspectMysqlObjectDdl,
  introspectMysqlObjects,
  introspectMysqlSchemas,
  introspectMysqlTableDetails,
  introspectOracleObjectDdl,
  introspectOracleObjects,
  introspectOracleSchemas,
  introspectOracleTableDetails,
  introspectPostgresObjectDdl,
  introspectPostgresObjects,
  introspectPostgresSchemaDependencies,
  introspectPostgresSchemas,
  introspectPostgresTableDetails,
  introspectSqliteObjectDdl,
  introspectSqliteObjects,
  introspectSqliteSchemas,
  introspectSqliteTableDetails,
  sanitizeSchemaFileName,
  toSqlBool,
  unwrapMssqlDefaultExpression,
  type QueryExecutor,
} from '../src/drivers/common/schema'
import {
  SQLITE_FK_CHECK_ABORT_SQL,
  buildAlterTableSql,
  buildCreateTableSql,
  buildDropTableSql,
  buildTableMigrationSql,
  buildTruncateTableSql,
  countTableStructureChanges,
  createInitialTableDraft,
  isDraftColumnDirty,
  reconstructTableDdl,
  requiresSqliteTableRebuild,
  validateTableStructureDraft,
  type TableStructureDraft,
} from '../src/drivers/common/sql-migration'

function createSqliteQuery(db: DatabaseSync): QueryExecutor {
  return async (sql: string, params: unknown[] = []) => {
    const stmt = db.prepare(sql)
    const cleanParams = params.map((p) => (p === undefined ? null : p)) as Array<
      string | number | bigint | Uint8Array | null
    >
    const rows = stmt.all(...cleanParams)
    return rows as Record<string, unknown>[]
  }
}

function makeColumn(overrides: Partial<ColumnInfo> & { name: string }): ColumnInfo {
  return {
    type: 'TEXT',
    nativeType: 'TEXT',
    nullable: true,
    defaultValue: null,
    isPrimaryKey: false,
    isAutoIncrement: false,
    ...overrides,
  }
}

function makeBaseDraft(overrides: Partial<TableStructureDraft> = {}): TableStructureDraft {
  return {
    tableName: 'orders',
    originalTableName: 'orders',
    schema: 'public',
    columns: [
      {
        id: 'c1',
        name: 'id',
        originalName: 'id',
        dataType: 'INTEGER',
        originalDataType: 'INTEGER',
        nullable: false,
        originalNullable: false,
        defaultValue: '',
        originalDefaultValue: '',
        isPrimaryKey: true,
        originalIsPrimaryKey: true,
        status: 'existing',
      },
      {
        id: 'c2',
        name: 'title',
        originalName: 'title',
        dataType: 'VARCHAR(100)',
        originalDataType: 'VARCHAR(100)',
        nullable: true,
        originalNullable: true,
        defaultValue: '',
        originalDefaultValue: '',
        isPrimaryKey: false,
        originalIsPrimaryKey: false,
        status: 'existing',
      },
    ],
    indexes: [],
    foreignKeys: [],
    ...overrides,
  }
}

describe('Wave 4B Step 1 — schema.ts helpers, cache, SQLite live introspection & multi-dialect coverage', () => {
  it('covers TableDetailsCache TTL expiration, type fallbacks, toSqlBool & sanitizeSchemaFileName', async () => {
    const cache = new TableDetailsCache(5)
    const sample: TableDetails = {
      name: 'users',
      schema: 'public',
      kind: 'table',
      columns: [
        makeColumn({ name: 'id', type: 'integer', nativeType: 'int4', isPrimaryKey: true, nullable: false }),
        makeColumn({ name: 'nick', type: 'varchar(50)', nativeType: '' }),
        makeColumn({ name: 'empty_type', type: '', nativeType: '' }),
      ],
      primaryKey: ['id'],
      indexes: [],
      foreignKeys: [],
    }

    expect(cache.get('', 'public', 'users')).toBeUndefined()
    expect(cache.resolveColumnTypes(undefined, 'public', 'users')).toBeUndefined()
    expect(cache.resolveColumnTypes(undefined, 'public', 'users', { extra: 'TEXT' })).toEqual({ extra: 'TEXT' })
    expect(cache.findColumnType(undefined, 'public', 'users', 'id', 'bigint')).toBe('bigint')
    expect(cache.findColumnType(undefined, 'public', 'users', 'id')).toBeUndefined()

    cache.set('  ', 'public', 'users', sample)
    expect(cache.get('public', 'public', 'users')?.name).toBe('users')
    expect(cache.resolveColumnTypes('public', 'public', 'users', { nick: 'TEXT' })).toEqual({
      id: 'int4',
      nick: 'TEXT',
    })
    expect(cache.findColumnType(undefined, 'public', 'users', 'nick')).toBe('varchar(50)')
    expect(cache.findColumnType(undefined, 'public', 'users', 'missing')).toBeUndefined()

    await new Promise((r) => setTimeout(r, 15))
    expect(cache.get(undefined, 'public', 'users')).toBeUndefined()

    cache.set('public', 'public', 'users', sample)
    cache.clear()
    expect(cache.get('public', 'public', 'users')).toBeUndefined()

    expect(toSqlBool(true)).toBe(true)
    expect(toSqlBool(1)).toBe(true)
    expect(toSqlBool(1n)).toBe(true)
    expect(toSqlBool('1')).toBe(true)
    expect(toSqlBool('TRUE')).toBe(true)
    expect(toSqlBool(new Uint8Array([1]))).toBe(true)
    expect(toSqlBool(new Uint8Array([0]))).toBe(false)
    expect(toSqlBool('0')).toBe(false)
    expect(toSqlBool(null)).toBe(false)

    expect(sanitizeSchemaFileName('path/to/my db!.sql')).toBe('my_db_sql')
    expect(sanitizeSchemaFileName('C:\\dir\\***')).toBe('schema')
    expect(sanitizeSchemaFileName('')).toBe('schema')
  })

  it('property-tests sanitizeSchemaFileName, unwrapMssqlDefaultExpression, buildCreateTableSql & reconstructTableDdl', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (raw) => {
        const sanitized = sanitizeSchemaFileName(raw)
        expect(sanitized.length).toBeGreaterThan(0)
        expect(sanitized).toMatch(/^[A-Za-z0-9_-]+$/)
      }),
      { numRuns: 40 }
    )

    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant('0'),
          fc.constant("N'abc''def'"),
          fc.constant('getutcdate()'),
          fc.constant('(1)+(2)')
        ),
        fc.integer({ min: 0, max: 4 }),
        (core, depth) => {
          const wrapped = `${'('.repeat(depth)}${core}${')'.repeat(depth)}`
          const unwrapped = unwrapMssqlDefaultExpression(wrapped)
          expect(unwrapped).toBe(core)
        }
      ),
      { numRuns: 30 }
    )

    const safeIdentArb = fc.stringMatching(/^[a-z][a-z0-9_]{1,12}$/)
    const dialects: DatabaseDriverType[] = ['sqlite', 'postgres', 'mysql', 'mssql', 'oracle', 'clickhouse']
    fc.assert(
      fc.property(safeIdentArb, safeIdentArb, fc.constantFrom(...dialects), fc.boolean(), (tbl, col, dialect, isPk) => {
        const sql = buildCreateTableSql(
          {
            tableName: tbl,
            columns: [{ name: col, dataType: 'INTEGER', nullable: !isPk, isPrimaryKey: isPk }],
          },
          dialect
        )
        expect(sql.toUpperCase()).toContain('CREATE TABLE')
        expect(sql).toContain(col)
      }),
      { numRuns: 40 }
    )
  })

  it('introspects live node:sqlite databases with comments, brackets, quotes, ON CONFLICT, FKs, views, triggers & attached schemas', async () => {
    const db = new DatabaseSync(':memory:')
    const query = createSqliteQuery(db)
    try {
      db.exec(`
        PRAGMA foreign_keys = ON;
        ATTACH DATABASE ':memory:' AS aux;
        CREATE TABLE parents_comp (
          tenant_id INTEGER NOT NULL,
          ext_id INTEGER NOT NULL,
          PRIMARY KEY (tenant_id, ext_id)
        ) WITHOUT ROWID;
        CREATE TABLE [complex_items] (
          -- leading line comment with ('fake', [paren])
          /* block comment with , comma */
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          "quoted""code" TEXT COLLATE NOCASE UNIQUE ON CONFLICT REPLACE,
          [bracket_col] TEXT COLLATE RTRIM NOT NULL DEFAULT 'x',
          ` + '`backtick``col`' + ` INTEGER,
          parent_t INTEGER,
          parent_e INTEGER,
          total INTEGER GENERATED ALWAYS AS (COALESCE(` + '`backtick``col`' + `, 0) * 2) VIRTUAL,
          CONSTRAINT uq_combo UNIQUE ("quoted""code", [bracket_col] COLLATE NOCASE DESC) ON CONFLICT IGNORE,
          FOREIGN KEY (parent_t, parent_e) REFERENCES parents_comp ON DELETE CASCADE ON UPDATE RESTRICT
        );
        CREATE INDEX idx_complex_desc ON [complex_items] ([bracket_col] COLLATE NOCASE DESC);
        CREATE TRIGGER trg_complex_upd AFTER UPDATE ON [complex_items]
        BEGIN
          UPDATE [complex_items] SET [bracket_col] = NEW.[bracket_col] WHERE id = NEW.id;
        END;
        CREATE VIEW v_complex AS SELECT id, [bracket_col] FROM [complex_items];
        CREATE TABLE aux.aux_tbl (id INTEGER PRIMARY KEY);
      `)

      const schemas = await introspectSqliteSchemas(query)
      expect(schemas.defaultSchema).toBe('main')
      expect(schemas.schemas).toContain('aux')

      const mainObjs = await introspectSqliteObjects(query, '')
      expect(mainObjs.some((o) => o.name === 'complex_items' && o.kind === 'table')).toBe(true)
      expect(mainObjs.some((o) => o.name === 'trg_complex_upd' && o.kind === 'trigger' && o.detail === 'complex_items')).toBe(true)
      expect(mainObjs.some((o) => o.name === 'v_complex' && o.kind === 'view')).toBe(true)

      const viewDdl = await introspectSqliteObjectDdl(query, 'v_complex', 'view', '')
      expect(viewDdl).toContain('CREATE VIEW v_complex')
      const trgDdl = await introspectSqliteObjectDdl(query, 'trg_complex_upd', 'trigger', 'main')
      expect(trgDdl).toContain('CREATE TRIGGER trg_complex_upd')
      await expect(introspectSqliteObjectDdl(query, 'no_such_tbl', 'table', 'aux')).rejects.toThrow(/DDL not found/)

      const details = await introspectSqliteTableDetails(query, 'complex_items', 'main')
      expect(details.kind).toBe('table')
      expect(details.columns.find((c) => c.name === 'quoted"code')?.collate).toBe('NOCASE')
      expect(details.columns.find((c) => c.name === 'bracket_col')?.collate).toBe('RTRIM')
      expect(details.columns.find((c) => c.name === 'total')?.isGenerated).toBe(true)
      expect(details.foreignKeys).toHaveLength(2)
      expect(details.foreignKeys[0]).toMatchObject({
        constraintName: 'fk_complex_items_0_parents_comp',
        referencedTable: 'parents_comp',
        referencedColumn: 'tenant_id',
        onDelete: 'CASCADE',
        onUpdate: 'RESTRICT',
      })
      expect(details.foreignKeys[1].referencedColumn).toBe('ext_id')
      expect(details.indexes.some((i) => i.origin === 'u' && i.onConflict === 'REPLACE')).toBe(true)
      expect(details.indexes.some((i) => i.origin === 'u' && i.onConflict === 'IGNORE')).toBe(true)
      expect(details.indexes.some((i) => i.name === 'idx_complex_desc' && i.columnSpecs?.[0]?.desc)).toBe(true)
      expect(details.triggers).toHaveLength(1)

      const parentDetails = await introspectSqliteTableDetails(query, 'parents_comp', 'main')
      expect(parentDetails.inboundForeignKeys?.length).toBeGreaterThanOrEqual(2)
      const auxDetails = await introspectSqliteTableDetails(query, 'aux_tbl', 'aux')
      expect(auxDetails.schema).toBe('aux')
    } finally {
      db.close()
    }
  })

  it('covers SQLite introspection fallback error/unterminated-token branches via mock queries', async () => {
    const emptySchemas = await introspectSqliteSchemas(async () => [{ name: '' }])
    expect(emptySchemas).toEqual({ schemas: ['main'], defaultSchema: 'main' })

    const mockQuery: QueryExecutor = async (sql) => {
      if (sql.includes('sqlite_master') && sql.includes("type IN ('table', 'view')")) {
        return [{
          type: 'table',
          sql: `CREATE TABLE edge -- cmt\n(/* blk */ [c1 TEXT COLLATE BINARY, "u1" TEXT, 'lit' /* unclosed`,
        }]
      }
      if (sql.includes('PRAGMA table_xinfo("edge")')) {
        return [
          { name: 'id', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 1, hidden: 0 },
          { name: 'ref_col', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0, hidden: 0 },
          { name: 'u1', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0, hidden: 0 },
        ]
      }
      if (sql.includes('PRAGMA table_xinfo("broken_parent")')) {
        throw new Error('parent locked')
      }
      if (sql.includes('PRAGMA table_xinfo("pk_parent")')) {
        return [{ name: 'only_pk', type: 'INTEGER', pk: 1, hidden: 0 }]
      }
      if (sql.includes('PRAGMA foreign_key_list("edge")')) {
        return [
          { id: 0, seq: 0, table: 'broken_parent', from: 'ref_col', to: null, on_delete: '', on_update: null },
          { id: 1, seq: 9, table: 'pk_parent', from: 'ref_col', to: '', on_delete: 'set null', on_update: 'no action' },
        ]
      }
      if (sql.includes('PRAGMA index_list("edge")')) {
        return [{ name: 'idx_fallback', unique: 1, origin: 'weird' }]
      }
      if (sql.includes('PRAGMA index_xinfo("idx_fallback")')) {
        throw new Error('no index_xinfo on old sqlite')
      }
      if (sql.includes('PRAGMA index_info("idx_fallback")')) {
        return [{ seqno: 0, name: 'u1', coll: 'NOCASE', desc: 1 }]
      }
      if (sql.includes("type = 'trigger'")) {
        throw new Error('trigger query blocked')
      }
      if (sql.includes("UPPER(sql) LIKE '%REFERENCES%'")) {
        return [{ name: 'child_a' }, { name: '' }]
      }
      if (sql.includes('PRAGMA foreign_key_list("child_a")')) {
        throw new Error('child pragma failed')
      }
      return []
    }

    const res = await introspectSqliteTableDetails(mockQuery, 'edge', '')
    expect(res.foreignKeys[0].referencedColumn).toBe('')
    expect(res.foreignKeys[1].referencedColumn).toBe('only_pk')
    expect(res.indexes[0].origin).toBeUndefined()
    expect(res.indexes[0].columnSpecs?.[0]).toEqual({ name: 'u1', collate: 'NOCASE', desc: true })
    expect(res.triggers).toEqual([])
    expect(res.inboundForeignKeys).toEqual([])

    const emptyBodyQuery: QueryExecutor = async (sql) => {
      if (sql.includes('sqlite_master') && sql.includes("type IN ('table', 'view')")) {
        return [{ type: 'table', sql: 'CREATE TABLE bad_unclosed (id INT' }]
      }
      if (sql.includes('PRAGMA index_list')) return []
      if (sql.includes('PRAGMA foreign_key_list')) return []
      if (sql.includes('PRAGMA table_xinfo')) return [{ name: 'id', type: 'INTEGER', pk: 1, notnull: 1, hidden: 0 }]
      return []
    }
    const emptyBodyDetails = await introspectSqliteTableDetails(emptyBodyQuery, 'bad_unclosed')
    expect(emptyBodyDetails.columns).toHaveLength(1)
  })

  it('covers Postgres introspection schemas, objects (incl. PG<11/CRDB fallback), dependencies, all DDL kinds & matview details', async () => {
    const schemas = await introspectPostgresSchemas(async () => [
      { name: 'pg_catalog' },
      { name: 'pg_toast_1' },
      { name: 'pg_temp_2' },
      { name: 'analytics' },
      { name: '' },
    ])
    expect(schemas).toEqual({ schemas: ['analytics'], defaultSchema: 'analytics' })

    const fallbackObjQuery: QueryExecutor = async (sql) => {
      if (sql.includes('information_schema.tables')) {
        return [
          { name: '', schema: 'app', kind: 'table' },
          { name: 'orders', schema: '', kind: 'unknown_kind' },
        ]
      }
      if (sql.includes('pg_matviews')) {
        throw new Error('permission denied for pg_matviews')
      }
      if (sql.includes('pg_catalog.pg_class') && sql.includes("c.relkind = 'S'")) {
        throw new Error('pg_depend blocked')
      }
      if (sql.includes('information_schema.sequences')) {
        return [{ name: 'order_seq', schema: 'app', kind: 'sequence' }]
      }
      if (sql.includes('p.prokind IN')) {
        throw new Error('column p.prokind does not exist')
      }
      if (sql.includes('NOT p.proisagg')) {
        return [{ name: 'calc_fn', schema: 'app', kind: 'function' }]
      }
      return []
    }
    const objs = await introspectPostgresObjects(fallbackObjQuery, 'app')
    expect(objs.map((o) => [o.kind, o.name, o.schema])).toEqual([
      ['function', 'calc_fn', 'app'],
      ['sequence', 'order_seq', 'app'],
      ['table', 'orders', 'app'],
    ])

    const deps = await introspectPostgresSchemaDependencies(async () => [
      { consumer_kind: 'bad', consumer_name: 'x', prerequisite_kind: 'table', prerequisite_name: 'y' },
      { consumer_kind: 'view', consumer_name: '', prerequisite_kind: 'table', prerequisite_name: 'y' },
      { consumer_kind: 'table', consumer_name: 'a', prerequisite_kind: 'table', prerequisite_name: 'a' },
      { consumer_kind: 'view', consumer_name: 'v1', prerequisite_kind: 'table', prerequisite_name: 't1' },
      { consumer_kind: 'view', consumer_name: 'v1', prerequisite_kind: 'table', prerequisite_name: 't1' },
    ], '')
    expect(deps).toEqual([
      { consumer: { kind: 'view', name: 'v1' }, prerequisite: { kind: 'table', name: 't1' } },
    ])

    // DDL variants & error paths
    await expect(introspectPostgresObjectDdl(async () => [], 'v_missing', 'view')).rejects.toThrow(/View definition/)
    await expect(introspectPostgresObjectDdl(async () => [], 'fn_missing', 'function')).rejects.toThrow(/Function definition/)
    await expect(introspectPostgresObjectDdl(async () => [], 'tr_missing', 'trigger')).rejects.toThrow(/Trigger definition/)
    await expect(introspectPostgresObjectDdl(async () => [], 'typ_missing', 'type')).rejects.toThrow(/Type definition/)
    await expect(introspectPostgresObjectDdl(async () => [], 'seq_missing', 'sequence')).rejects.toThrow(/Sequence definition/)
    await expect(introspectPostgresObjectDdl(async () => [], 'bad', 'other' as SchemaObjectKind)).rejects.toThrow(/Unsupported PostgreSQL/)

    const enumDdl = await introspectPostgresObjectDdl(
      async (sql) => (sql.includes('pg_enum') ? [{ label: "a'b" }, { label: 'c' }] : []),
      'mood',
      'type',
      ''
    )
    expect(enumDdl).toContain("'a''b'")

    const domainStrDdl = await introspectPostgresObjectDdl(
      async (sql) =>
        sql.includes('domains')
          ? [{ data_type: 'character varying', max_length: 32, precision: null, scale: null }]
          : [],
      'email_dom',
      'type'
    )
    expect(domainStrDdl).toBe('CREATE DOMAIN "public"."email_dom" AS character varying(32);')

    const domainNumDdl = await introspectPostgresObjectDdl(
      async (sql) =>
        sql.includes('domains')
          ? [{ data_type: 'numeric', max_length: null, precision: 10, scale: null }]
          : [],
      'money_dom',
      'type'
    )
    expect(domainNumDdl).toBe('CREATE DOMAIN "public"."money_dom" AS numeric(10,0);')

    const seqDdl = await introspectPostgresObjectDdl(
      async () => [{ data_type: 'bigint', start_value: 1, increment_by: 2, min_value: 1, max_value: 999, cycle: true }],
      'my_seq',
      'sequence'
    )
    expect(seqDdl).toBe(
      'CREATE SEQUENCE "public"."my_seq" AS bigint START WITH 1 INCREMENT BY 2 MINVALUE 1 MAXVALUE 999 CYCLE;'
    )

    const matviewDdl = await introspectPostgresObjectDdl(
      async () => [{ ddl: 'SELECT id FROM mydb.public.users;' }],
      'mv_users',
      'materialized_view',
      'public',
      { sourceDatabase: 'mydb' }
    )
    expect(matviewDdl).toContain('CREATE MATERIALIZED VIEW "public"."mv_users" AS')

    // Materialized view table details
    const mvDetails = await introspectPostgresTableDetails(
      async (sql) => {
        if (sql.includes('information_schema.tables')) return []
        if (sql.includes("c.relkind = 'm'")) return [{ relkind: 'm' }]
        if (sql.includes("tc.constraint_type = 'PRIMARY KEY'")) return [{ column_name: 'id' }]
        if (sql.includes('FROM pg_catalog.pg_index')) {
          return [{ index_name: 'idx_mv', is_unique: 1, is_primary: 1, column_name: 'id' }]
        }
        if (sql.includes('FROM pg_catalog.pg_attribute')) {
          return [{ name: 'id', type: 'integer', native_type: 'int4', nullable: false, default_value: null, is_auto_increment: false }]
        }
        if (sql.includes("tc.constraint_type = 'FOREIGN KEY'")) {
          return [{
            constraint_name: 'fk_mv',
            column_name: 'id',
            referenced_schema: 'public',
            referenced_table: 'u',
            referenced_column: 'id',
            on_delete: 'cascade',
            on_update: 'restrict',
          }]
        }
        return []
      },
      'mv_users',
      ''
    )
    expect(mvDetails.kind).toBe('view')
    expect(mvDetails.foreignKeys[0]).toMatchObject({ referencedSchema: 'public', onDelete: 'CASCADE', onUpdate: 'RESTRICT' })
    expect(mvDetails.indexes[0]).toMatchObject({ isUnique: true, isPrimary: true })
  })

  it('covers MySQL schemas, objects, DDL variants (incl. trigger SQL Original Statement) & TableDetails', async () => {
    const schemas = await introspectMysqlSchemas(
      async () => [{ Database: '' }, { database: 'mysql' }, { Database: 'sys' }, { Database: 'app_db' }],
      'app_db'
    )
    expect(schemas).toEqual({ schemas: ['app_db'], defaultSchema: 'app_db' })

    const noCurrentSchemas = await introspectMysqlSchemas(
      async () => [{ col0: 'information_schema' }],
      ''
    )
    expect(noCurrentSchemas).toEqual({ schemas: [], defaultSchema: '' })

    const objsAll = await introspectMysqlObjects(async (sql) => {
      if (sql.includes('information_schema.tables')) return [{ name: 't1', schema: 'shop', kind: 'table' }]
      if (sql.includes('routines')) return [{ name: 'p1', schema: 'shop', kind: 'procedure' }]
      if (sql.includes('triggers')) return [{ name: 'trg1', schema: 'shop', kind: 'trigger', detail: 't1' }]
      return []
    }, '')
    expect(objsAll.map((o) => o.kind)).toEqual(['procedure', 'table', 'trigger'])

    await expect(introspectMysqlObjectDdl(async () => [], 't', 'table', ' ')).rejects.toThrow(/required/)
    await expect(introspectMysqlObjectDdl(async () => [], 's', 'sequence', 'shop')).rejects.toThrow(/does not support DDL export/)
    await expect(introspectMysqlObjectDdl(async () => [{}], 'v', 'view', 'shop')).rejects.toThrow(/DDL not found/)

    const trgDdl = await introspectMysqlObjectDdl(
      async () => [{ Trigger: 'tr1', 'SQL Original Statement': 'CREATE TRIGGER tr1 BEFORE INSERT ON t FOR EACH ROW SET NEW.a = 1' }],
      'tr1',
      'trigger',
      'shop'
    )
    expect(trgDdl).toMatch(/CREATE TRIGGER tr1.*;$/)
    expect(await introspectMysqlObjectDdl(async () => [{ 'Create Procedure': 'CREATE PROCEDURE p()' }], 'p', 'procedure', 'shop')).toBe('CREATE PROCEDURE p();')
    expect(await introspectMysqlObjectDdl(async () => [{ 'Create Function': 'CREATE FUNCTION f() RETURNS INT' }], 'f', 'function', 'shop')).toBe('CREATE FUNCTION f() RETURNS INT;')
    expect(await introspectMysqlObjectDdl(async () => [{ 'Create Table': 'CREATE TABLE t (id INT)' }], 't', 'table', 'shop')).toBe('CREATE TABLE t (id INT);')

    const mysqlTbl = await introspectMysqlTableDetails(
      async (sql) => {
        if (sql.includes("table_type = 'VIEW'")) return [{ kind: 'table' }]
        if (sql.includes('FROM information_schema.columns')) {
          return [{
            name: 'status',
            type: "enum('a','b')",
            native_type: 'enum',
            nullable: 0,
            default_value: 'a',
            is_primary_key: 1,
            is_auto_increment: 0,
          }]
        }
        if (sql.includes("constraint_name = 'PRIMARY'")) return [{ column_name: 'status' }]
        if (sql.includes('referential_constraints')) {
          return [{ constraint_name: 'fk_m', column_name: 'status', referenced_schema: 'other_db', referenced_table: 'ref', referenced_column: 'k', on_delete: 'CASCADE', on_update: 'SET NULL' }]
        }
        if (sql.includes('information_schema.statistics')) {
          return [{ name: 'PRIMARY', is_unique: 1, is_primary: 1, column_name: 'status' }]
        }
        return []
      },
      'orders',
      'shop'
    )
    expect(mysqlTbl.columns[0].nativeType).toBe("enum('a','b')")
    expect(mysqlTbl.foreignKeys[0]).toMatchObject({ referencedSchema: 'other_db', onDelete: 'CASCADE', onUpdate: 'SET NULL' })
  })

  it('covers MSSQL schemas, objects, table details (computed/INCLUDE/filtered/FK/trigger) & type/sequence DDL', async () => {
    expect(unwrapMssqlDefaultExpression(null)).toBeNull()
    expect(unwrapMssqlDefaultExpression('   ')).toBeNull()
    expect(unwrapMssqlDefaultExpression('(())')).toBe('()')
    expect(unwrapMssqlDefaultExpression('((1))')).toBe('1')
    expect(unwrapMssqlDefaultExpression("(('unbalanced'")).toBe("(('unbalanced'")

    const mssqlSchemas = await introspectMssqlSchemas(async () => [
      { name: 'sales', default_schema: 'custom_dbo' },
    ])
    expect(mssqlSchemas).toEqual({ schemas: ['custom_dbo', 'sales'], defaultSchema: 'custom_dbo' })

    const mssqlObjs = await introspectMssqlObjects(async (sql) => {
      if (sql.includes('sys.objects')) return [{ name: 't1', schema: 'dbo', kind: 'table' }]
      return [{ name: 'id_list', schema: 'dbo', kind: 'type' }]
    }, '')
    expect(mssqlObjs.map((o) => o.kind)).toEqual(['type', 'table'])

    const mssqlDetails = await introspectMssqlTableDetails(
      async (sql) => {
        if (sql.includes("o.type IN ('U', 'V')")) return [{ obj_type: 'U', object_id: 10 }]
        if (sql.includes('FROM sys.columns')) {
          return [
            { name: 'id', base_type: 'int', is_nullable: 0, is_identity: 1, is_computed: 0 },
            { name: 'note', base_type: 'nvarchar', max_length: -1, is_nullable: 1, default_value: "((N'hi'))" },
            { name: 'code', base_type: 'nchar', max_length: 10, is_nullable: 1 },
            { name: 'blob', base_type: 'varbinary', max_length: -1, is_nullable: 1 },
            { name: 'tag', base_type: 'varchar', max_length: 20, is_nullable: 1 },
            { name: 'amt', base_type: 'decimal', precision: 10, scale: 2, is_nullable: 1 },
            { name: 'ts', base_type: 'datetime2', scale: 3, is_nullable: 1 },
            { name: 'flt', base_type: 'float', precision: 24, is_nullable: 1 },
            { name: 'comp', base_type: 'int', is_computed: 1, computed_definition: '([id] * 2)', is_persisted: 1 },
          ]
        }
        if (sql.includes('FROM sys.indexes')) {
          return [
            { index_name: 'PK_tbl', is_primary_key: 1, is_unique: 1, is_unique_constraint: 0, column_name: 'id', is_included_column: 0, is_descending_key: 0 },
            { index_name: 'UQ_tag', is_primary_key: 0, is_unique: 1, is_unique_constraint: 1, column_name: 'tag', is_included_column: 0, is_descending_key: 0 },
            {
              index_name: 'IX_note',
              is_primary_key: 0,
              is_unique: 0,
              is_unique_constraint: 0,
              filter_definition: '([note] IS NOT NULL)',
              column_name: 'code',
              is_included_column: 0,
              is_descending_key: 1,
            },
            { index_name: 'IX_note', is_primary_key: 0, is_unique: 0, is_unique_constraint: 0, column_name: 'note', is_included_column: 1 },
          ]
        }
        if (sql.includes('WHERE ps.name')) {
          return [{ constraint_name: 'FK_parent', column_name: 'id', referenced_schema: 'ref_s', referenced_table: 'parent', referenced_column: 'id', on_delete: 'CASCADE', on_update: 'SET_NULL' }]
        }
        if (sql.includes('WHERE rs.name')) return [{ from_table: 'child', from_column: 'pid', to_column: 'id', on_delete: 'NO_ACTION' }]
        if (sql.includes('FROM sys.triggers')) return [{ name: 'tr_u', sql: 'CREATE TRIGGER tr_u ON dbo.t AFTER INSERT AS SELECT 1' }]
        return []
      },
      't',
      ''
    )
    expect(mssqlDetails.ddl).toContain('nvarchar(MAX)')
    expect(mssqlDetails.ddl).toContain('nchar(5)')
    expect(mssqlDetails.ddl).toContain('varbinary(MAX)')
    expect(mssqlDetails.ddl).toContain('varchar(20)')
    expect(mssqlDetails.ddl).toContain('decimal(10,2)')
    expect(mssqlDetails.ddl).toContain('datetime2(3)')
    expect(mssqlDetails.ddl).toContain('float(24)')
    expect(mssqlDetails.ddl).toContain('[comp] AS ([id] * 2) PERSISTED')
    expect(mssqlDetails.ddl).toContain('INCLUDE ([note]) WHERE ([note] IS NOT NULL)')
    expect(mssqlDetails.ddl).toContain('ON UPDATE SET NULL')

    const tblTypeDdl = await introspectMssqlObjectDdl(
      async (sql) =>
        sql.includes('sys.table_types')
          ? [{ name: 'id', base_type: 'int', is_nullable: 0 }]
          : [{ is_table_type: 1, base_type: 'table' }],
      'IdList',
      'type'
    )
    expect(tblTypeDdl).toContain('CREATE TYPE [dbo].[IdList] AS TABLE')

    const scalarTypeDdl = await introspectMssqlObjectDdl(
      async () => [{ is_table_type: 0, base_type: 'varchar', max_length: 30, is_nullable: 1 }],
      'PhoneStr',
      'type'
    )
    expect(scalarTypeDdl).toBe('CREATE TYPE [dbo].[PhoneStr] FROM varchar(30) NULL;')

    const seqCycle = await introspectMssqlObjectDdl(
      async () => [{ data_type: 'bigint', start_value: 10, increment_by: 5, min_value: 1, max_value: 100, is_cycling: 1 }],
      'SeqA',
      'sequence'
    )
    expect(seqCycle).toContain('CYCLE;')
    const seqNoCycle = await introspectMssqlObjectDdl(
      async () => [{ data_type: 'bigint', is_cycling: 0 }],
      'SeqB',
      'sequence'
    )
    expect(seqNoCycle).toContain('NO CYCLE;')

    await expect(introspectMssqlObjectDdl(async () => [], 'MissingSeq', 'sequence')).rejects.toThrow(/Sequence definition/)
    await expect(introspectMssqlObjectDdl(async () => [], 'MissingType', 'type')).rejects.toThrow(/Type definition/)
    await expect(introspectMssqlObjectDdl(async () => [], 'MissingView', 'view')).rejects.toThrow(/DDL not found/)
    await expect(introspectMssqlObjectDdl(async () => [], 'X', 'materialized_view')).rejects.toThrow(/Unsupported SQL Server/)

    const modFallback = await introspectMssqlObjectDdl(
      async (sql) => (sql.includes('sys.sql_modules') ? [{ definition: 'CREATE VIEW dbo.v1 AS SELECT 1' }] : []),
      'v1',
      'view'
    )
    expect(modFallback).toBe('CREATE VIEW [dbo].[v1] AS SELECT 1;'.replace('[dbo].[v1]', 'dbo.v1'))
  })

  it('covers Oracle schemas, objects, table details (all column types, catch paths) & all DDL object kinds', async () => {
    const oracleSchemas = await introspectOracleSchemas(
      async (sql) => {
        if (sql.includes('DUAL')) throw new Error('dual blocked')
        return [{ USERNAME: 'APP' }, { name: 'APP' }]
      },
      'custom_owner'
    )
    expect(oracleSchemas).toEqual({ schemas: ['CUSTOM_OWNER', 'APP'], defaultSchema: 'CUSTOM_OWNER' })

    const oracleObjs = await introspectOracleObjects(async () => [
      { OBJECT_NAME: 'T1', OWNER: 'HR', OBJECT_TYPE: 'TABLE' },
      { OBJECT_NAME: 'MV1', OWNER: 'HR', OBJECT_TYPE: 'MATERIALIZED VIEW' },
      { OBJECT_NAME: 'P1', OWNER: 'HR', OBJECT_TYPE: 'PROCEDURE' },
      { OBJECT_NAME: 'F1', OWNER: 'HR', OBJECT_TYPE: 'FUNCTION' },
      { OBJECT_NAME: 'TR1', OWNER: 'HR', OBJECT_TYPE: 'TRIGGER' },
      { OBJECT_NAME: 'SQ1', OWNER: 'HR', OBJECT_TYPE: 'SEQUENCE' },
      { OBJECT_NAME: 'TY1', OWNER: 'HR', OBJECT_TYPE: 'TYPE' },
      { OBJECT_NAME: 'IGN', OWNER: 'HR', OBJECT_TYPE: 'SYNONYM' },
      { OBJECT_NAME: '', OWNER: 'HR', OBJECT_TYPE: 'TABLE' },
    ], 'hr')
    expect(oracleObjs).toHaveLength(7)

    const oraTbl = await introspectOracleTableDetails(
      async (sql) => {
        if (sql.includes('all_objects')) return [{ object_type: 'TABLE' }]
        if (sql.includes('FROM all_tab_columns')) {
          return [
            { COLUMN_NAME: 'ID', DATA_TYPE: 'NUMBER', DATA_PRECISION: 10, DATA_SCALE: 0, NULLABLE: 'N', IDENTITY_COLUMN: 'YES', DATA_DEFAULT: '"HR"."ISEQ$$_42".nextval' },
            { COLUMN_NAME: 'AMT', DATA_TYPE: 'NUMBER', DATA_PRECISION: 12, DATA_SCALE: 2, NULLABLE: 'Y' },
            { COLUMN_NAME: 'ANYNUM', DATA_TYPE: 'NUMBER', NULLABLE: 'Y' },
            { COLUMN_NAME: 'NAME', DATA_TYPE: 'VARCHAR2', CHAR_LENGTH: 40, CHAR_USED: 'C', NULLABLE: 'N', DATA_DEFAULT: "'n/a'" },
            { COLUMN_NAME: 'RAW_ID', DATA_TYPE: 'RAW', DATA_LENGTH: 16, NULLABLE: 'Y' },
            { COLUMN_NAME: 'FLT', DATA_TYPE: 'FLOAT', DATA_PRECISION: 63, NULLABLE: 'Y' },
            { COLUMN_NAME: 'V_TOTAL', DATA_TYPE: 'NUMBER', VIRTUAL_COLUMN: 'YES', NULLABLE: 'Y' },
          ]
        }
        if (sql.includes('all_tab_cols')) throw new Error('no priv')
        if (sql.includes("constraint_type = 'P'")) return [{ column_name: 'ID', constraint_name: 'PK_EMP' }]
        if (sql.includes("constraint_type = 'U'")) throw new Error('uq blocked')
        if (sql.includes("constraint_type = 'R'")) return [{ from_table: 'CHILD', from_column: 'EMP_ID', to_column: 'ID', on_delete: 'CASCADE' }]
        if (sql.includes('all_triggers')) return [{ trigger_name: 'TR_EMP', when_clause: 'NEW.ID > 0', trigger_body: 'BEGIN NULL; END;' }]
        return []
      },
      'EMP',
      'hr'
    )
    expect(oraTbl.ddl).toContain('NUMBER(10)')
    expect(oraTbl.ddl).toContain('NUMBER(12,2)')
    expect(oraTbl.ddl).toContain('VARCHAR2(40 CHAR)')
    expect(oraTbl.ddl).toContain('RAW(16)')
    expect(oraTbl.ddl).toContain('FLOAT(63)')
    expect(oraTbl.columns.find((c) => c.name === 'ID')?.defaultValue).toBeNull()
    expect(oraTbl.columns.find((c) => c.name === 'V_TOTAL')?.isGenerated).toBe(true)
    expect(oraTbl.triggers?.[0]?.sql).toContain('WHEN (NEW.ID > 0)')

    await expect(introspectOracleObjectDdl(async () => [], 'V', 'view', 'hr')).rejects.toThrow(/View definition/)
    await expect(introspectOracleObjectDdl(async () => [], 'MV', 'materialized_view', 'hr')).rejects.toThrow(/Materialized view/)
    await expect(introspectOracleObjectDdl(async () => [], 'P', 'procedure', 'hr')).rejects.toThrow(/PROCEDURE definition/)
    await expect(introspectOracleObjectDdl(async () => [], 'TR', 'trigger', 'hr')).rejects.toThrow(/Trigger definition/)
    await expect(introspectOracleObjectDdl(async () => [], 'SQ', 'sequence', 'hr')).rejects.toThrow(/Sequence definition/)
    await expect(introspectOracleObjectDdl(async () => [], 'X', 'other' as SchemaObjectKind, 'hr')).rejects.toThrow(/Unsupported Oracle/)

    const oraMv = await introspectOracleObjectDdl(async () => [{ query: 'SELECT 1 FROM DUAL' }], 'MV', 'materialized_view', 'hr')
    expect(oraMv).toContain('CREATE MATERIALIZED VIEW "HR"."MV" AS')
    const oraFn = await introspectOracleObjectDdl(async () => [{ text: 'FUNCTION f RETURN NUMBER IS BEGIN RETURN 1; END;' }], 'F', 'function', 'hr')
    expect(oraFn).toMatch(/^CREATE OR REPLACE FUNCTION/)
    const oraSeqNoCache = await introspectOracleObjectDdl(
      async () => [{ increment_by: 1, min_value: 1, max_value: 99, cycle_flag: 'N', cache_size: 0 }],
      'SQ',
      'sequence',
      'hr'
    )
    expect(oraSeqNoCache).toContain('NOCYCLE NOCACHE;')
    const oraSeqCache = await introspectOracleObjectDdl(
      async () => [{ increment_by: 2, cycle_flag: 'Y', cache_size: 20 }],
      'SQ2',
      'sequence',
      'hr'
    )
    expect(oraSeqCache).toContain('CYCLE CACHE 20;')
  })

  it('covers assembleFullSchemaDdl & collectAndAssembleSchemaDdl across cycles, delimiters, PG deps & error fallback', async () => {
    const objects: SchemaObject[] = [
      { name: 'empty_tbl', schema: 'public', kind: 'table' },
      { name: 'tbl_a', schema: 'public', kind: 'table' },
      { name: 'tbl_a', schema: 'public', kind: 'table' }, // deduped
      { name: 'tbl_b', schema: 'public', kind: 'table' },
      { name: 'v_join', schema: 'public', kind: 'view' },
      { name: 'v_fail', schema: 'public', kind: 'view' },
      { name: 'fn_custom', schema: 'public', kind: 'function' },
      { name: 'custom_kind', schema: 'public', kind: 'custom_ext' as SchemaObjectKind },
    ]

    const pgAssembled = await collectAndAssembleSchemaDdl({
      dialect: 'postgres',
      schemaName: 'public',
      objects,
      dependencies: [
        {
          consumer: { kind: 'function', name: 'fn_custom' },
          prerequisite: { kind: 'table', name: 'tbl_a' },
        },
        {
          consumer: { kind: 'table', name: 'tbl_b' },
          prerequisite: { kind: 'table', name: 'tbl_b' }, // self dep ignored
        },
      ],
      getObjectDdl: async (obj) => {
        if (obj.name === 'empty_tbl') return '   '
        if (obj.name === 'tbl_a') {
          return `CREATE TABLE "public"."tbl_a" (\n  id INT PRIMARY KEY,\n  b_id INT,\n  CONSTRAINT fk_ab FOREIGN KEY (b_id) REFERENCES "public"."tbl_b"(id)\n);`
        }
        if (obj.name === 'tbl_b') {
          return `CREATE TABLE "public"."tbl_b" (\n  id INT PRIMARY KEY,\n  a_id INT,\n  FOREIGN KEY (a_id) REFERENCES "tbl_a"(id)\n);`
        }
        if (obj.name === 'v_join') {
          return `CREATE VIEW v_join AS SELECT /* comment REFERENCES */ E'escape\\'str' AS s, EXTRACT(YEAR FROM ts) FROM public.tbl_a AS a, ONLY tbl_b b JOIN db.public.tbl_a a2 ON true WHERE a.id > 0;`
        }
        if (obj.name === 'v_fail') {
          throw 'plain string error'
        }
        if (obj.name === 'fn_custom') {
          return `CREATE FUNCTION fn_custom() RETURNS INT LANGUAGE plpgsql AS $fn$ BEGIN RETURN 1; END; $fn$;`
        }
        return 'CREATE EXTENSION pgcrypto;'
      },
    })
    expect(pgAssembled.objectCount).toBe(5)
    expect(pgAssembled.ddl).toContain('-- Deferred Foreign Keys (cyclic references)')
    expect(pgAssembled.ddl).toContain('ALTER TABLE "public"."tbl_a" ADD CONSTRAINT fk_ab FOREIGN KEY')
    expect(pgAssembled.ddl).toContain('-- Failed to export view v_fail: plain string error')
    expect(pgAssembled.ddl).toContain('CREATE EXTENSION pgcrypto;')

    // MySQL DELIMITER $$ & cyclic checks + SQLite PRAGMA foreign_keys = OFF/ON + MSSQL GO + Oracle /
    const mysqlAssembled = assembleFullSchemaDdl({
      dialect: 'mysql',
      schemaName: 'shop',
      sections: [
        { kind: 'table', name: 't1', ddl: '# hash comment\nCREATE TABLE `t1` (id INT, CONSTRAINT fk1 FOREIGN KEY (id) REFERENCES `t2`(id));' },
        { kind: 'table', name: 't2', ddl: 'CREATE TABLE `t2` (id INT, FOREIGN KEY (id) REFERENCES `t1`(id));' },
        { kind: 'trigger', name: 'tr_log', ddl: 'CREATE TRIGGER tr_log AFTER INSERT ON t1 FOR EACH ROW BEGIN SET @x = 1; END;' },
      ],
    })
    expect(mysqlAssembled.ddl).toContain('SET FOREIGN_KEY_CHECKS = 0;')
    expect(mysqlAssembled.ddl).toContain('DELIMITER $$\nCREATE TRIGGER tr_log')
    expect(mysqlAssembled.ddl).toContain('SET FOREIGN_KEY_CHECKS = 1;')

    const sqliteAssembled = assembleFullSchemaDdl({
      dialect: 'sqlite',
      schemaName: 'main',
      sections: [
        { kind: 'table', name: 'a', ddl: 'CREATE TABLE [a] (id INT REFERENCES [b](id));' },
        { kind: 'table', name: 'b', ddl: 'CREATE TABLE [b] (id INT REFERENCES [a](id));' },
      ],
    })
    expect(sqliteAssembled.ddl).toContain('PRAGMA foreign_keys = OFF;')
    expect(sqliteAssembled.ddl).toContain('PRAGMA foreign_keys = ON;')

    const mssqlAssembled = assembleFullSchemaDdl({
      dialect: 'mssql',
      schemaName: 'dbo',
      sections: [{ kind: 'procedure', name: 'p_run', ddl: 'CREATE PROCEDURE dbo.p_run AS SELECT 1;' }],
    })
    expect(mssqlAssembled.ddl).toContain('\nGO\n')

    const oracleAssembled = assembleFullSchemaDdl({
      dialect: 'oracle',
      schemaName: 'HR',
      sections: [{ kind: 'trigger', name: 'tr_x', ddl: 'CREATE OR REPLACE TRIGGER tr_x BEFORE INSERT ON T FOR EACH ROW BEGIN NULL; END;\n/' }],
    })
    expect(oracleAssembled.ddl).toMatch(/\n\/\n?$/)
  })
})

describe('Wave 4B Step 1 — sql-migration.ts DDL reconstruction, multi-dialect ALTER/migration & live SQLite rebuild', () => {
  it('reconstructTableDdl covers array/numeric/mysql types, AUTO_INCREMENT, COLLATE, UNIQUE ON CONFLICT & triggers', () => {
    const pgDetails: TableDetails = {
      name: 'events',
      schema: 'analytics',
      kind: 'table',
      columns: [
        makeColumn({ name: 'id', type: 'bigint', nativeType: 'int8', nullable: false, isPrimaryKey: true, isAutoIncrement: true }),
        makeColumn({ name: 'tags', type: 'ARRAY', nativeType: '_text' }),
        makeColumn({ name: 'tags2', type: 'integer[]', nativeType: '_int4' }),
        makeColumn({ name: 'price', type: 'numeric(10,2)', nativeType: 'numeric' }),
        makeColumn({ name: 'parent_id', type: 'bigint', nativeType: 'int8' }),
      ],
      primaryKey: ['id'],
      indexes: [
        { name: 'idx_events_price', isUnique: false, isPrimary: false, columns: ['price'], columnSpecs: [{ name: 'price', desc: true }] },
      ],
      foreignKeys: [
        { constraintName: '', column: 'parent_id', referencedTable: 'parents', referencedSchema: 'core', referencedColumn: 'id', onDelete: 'CASCADE', onUpdate: 'SET NULL' },
      ],
      triggers: [
        { name: 'blank_trg', sql: '   ' },
        { name: 'trg_events', sql: 'CREATE TRIGGER trg_events AFTER INSERT ON analytics.events FOR EACH ROW EXECUTE FUNCTION log_fn()' },
      ],
    }
    const pgDdl = reconstructTableDdl(pgDetails, 'postgres')
    expect(pgDdl).toContain('"id" int8 GENERATED BY DEFAULT AS IDENTITY NOT NULL')
    expect(pgDdl).toContain('"tags" text[]')
    expect(pgDdl).toContain('"tags2" integer[]')
    expect(pgDdl).toContain('"price" numeric(10,2)')
    expect(pgDdl).toContain('FOREIGN KEY ("parent_id") REFERENCES "core"."parents" ("id") ON DELETE CASCADE ON UPDATE SET NULL')
    expect(pgDdl).toContain('CREATE INDEX "idx_events_price" ON "analytics"."events" ("price" DESC);')
    expect(pgDdl).toContain('EXECUTE FUNCTION log_fn();')

    const mysqlDetails: TableDetails = {
      name: 'items',
      schema: 'shop',
      kind: 'table',
      columns: [
        makeColumn({ name: 'id', type: 'int(11)', nativeType: 'int', nullable: false, isPrimaryKey: true, isAutoIncrement: true }),
        makeColumn({ name: 'bad_def', type: 'varchar(50)', nativeType: 'varchar', defaultValue: 'unparseable;expr' }),
      ],
      primaryKey: ['id'],
      indexes: [
        { name: 'uq_col', isUnique: true, isPrimary: false, origin: 'u', columns: ['bad_def'] },
      ],
      foreignKeys: [],
    }
    const mysqlDdl = reconstructTableDdl(mysqlDetails, 'mysql')
    expect(mysqlDdl).toContain('AUTO_INCREMENT')
    expect(mysqlDdl).toContain("DEFAULT unparseable;expr")
    expect(mysqlDdl).toContain('UNIQUE (`bad_def`)')

    const sqliteUniqueDetails: TableDetails = {
      name: 'u_tbl',
      schema: 'main',
      kind: 'table',
      columns: [
        makeColumn({ name: 'id', type: 'INTEGER', nullable: false, isPrimaryKey: true, isAutoIncrement: true }),
        makeColumn({ name: 'code', type: 'TEXT', collate: 'custom-coll' }),
      ],
      primaryKey: ['id'],
      indexes: [
        {
          name: 'uq1',
          isUnique: true,
          isPrimary: false,
          origin: 'u',
          columns: ['code'],
          columnSpecs: [{ name: 'code', collate: 'NOCASE', desc: true }],
          onConflict: 'IGNORE',
        },
        {
          name: 'sqlite_autoindex_u_tbl_1',
          isUnique: true,
          isPrimary: false,
          columns: ['code'],
          columnSpecs: [{ name: 'code', collate: 'NOCASE', desc: true }],
          onConflict: 'IGNORE',
        },
      ],
      foreignKeys: [],
    }
    const sqliteDdl = reconstructTableDdl(sqliteUniqueDetails, 'sqlite')
    expect(sqliteDdl).toContain('COLLATE "custom-coll"')
    expect(sqliteDdl.match(/UNIQUE \("code" COLLATE NOCASE DESC\) ON CONFLICT IGNORE/g)).toHaveLength(1)

    const emptyColsDdl = reconstructTableDdl(
      { name: 'empty', schema: 'main', kind: 'table', columns: [], primaryKey: [], indexes: [], foreignKeys: [] },
      'sqlite'
    )
    expect(emptyColsDdl).toBe('CREATE TABLE "empty" ();')
  })

  it('covers buildAlterTableSql across all action kinds, dialects & error guards', () => {
    expect(() => buildAlterTableSql({ kind: 'dropColumn', table: 't', columnName: 'c' }, 'redis')).toThrow(/Redis/)
    expect(() => buildAlterTableSql({ kind: 'dropColumn', table: '  ', columnName: 'c' }, 'sqlite')).toThrow(/Table name is required/)

    // addColumn
    expect(() => buildAlterTableSql({ kind: 'addColumn', table: 't', columnName: '' }, 'sqlite')).toThrow(/Column name is required/)
    expect(buildAlterTableSql({ kind: 'addColumn', table: 't', columnName: 'cnt', dataType: 'INTEGER', nullable: false }, 'sqlite')).toContain('DEFAULT 0')
    expect(buildAlterTableSql({ kind: 'addColumn', table: 't', columnName: 'lbl', dataType: 'TEXT', nullable: false }, 'libsql')).toContain("DEFAULT ''")
    expect(buildAlterTableSql({ kind: 'addColumn', table: 't', schema: 'dbo', columnName: 'c', dataType: 'INT', nullable: false }, 'mssql')).toBe('ALTER TABLE [dbo].[t] ADD [c] INT NOT NULL;')
    expect(buildAlterTableSql({ kind: 'addColumn', table: 't', schema: 'HR', columnName: 'c', dataType: 'NUMBER', nullable: false, defaultValue: '1' }, 'oracle')).toBe('ALTER TABLE "HR"."t" ADD ("c" NUMBER DEFAULT 1 NOT NULL);')

    // renameColumn
    expect(() => buildAlterTableSql({ kind: 'renameColumn', table: 't', oldColumnName: '', newColumnName: 'b' }, 'sqlite')).toThrow(/required/)
    expect(() => buildAlterTableSql({ kind: 'renameColumn', table: 't', oldColumnName: 'a', newColumnName: 'a' }, 'sqlite')).toThrow(/must be different/)
    expect(buildAlterTableSql({ kind: 'renameColumn', table: 't', schema: 'dbo', oldColumnName: 'a', newColumnName: 'b' }, 'mssql')).toBe("EXEC sp_rename '[dbo].[t].[a]', 'b', 'COLUMN';")

    // dropColumn & renameTable
    expect(() => buildAlterTableSql({ kind: 'dropColumn', table: 't', columnName: '' }, 'postgres')).toThrow(/required/)
    expect(() => buildAlterTableSql({ kind: 'renameTable', table: 't', newTableName: '' }, 'postgres')).toThrow(/required/)
    expect(() => buildAlterTableSql({ kind: 'renameTable', table: 't', newTableName: 't' }, 'postgres')).toThrow(/different/)
    expect(buildAlterTableSql({ kind: 'renameTable', table: 't', schema: 'shop', newTableName: 't2' }, 'mariadb')).toBe('RENAME TABLE `shop`.`t` TO `shop`.`t2`;')
    expect(buildAlterTableSql({ kind: 'renameTable', table: 't', schema: 'dbo', newTableName: 't2' }, 'mssql')).toBe("EXEC sp_rename '[dbo].[t]', 't2';")
    expect(buildAlterTableSql({ kind: 'renameTable', table: '__datanoa_case_rename_tmp', newTableName: '__DATANOA_CASE_RENAME_TMP' }, 'sqlite')).toContain('__datanoa_case_rename_tmp_2')

    // alterColumn per dialect
    expect(() => buildAlterTableSql({ kind: 'alterColumn', table: 't', columnName: '' }, 'postgres')).toThrow(/Column name is required/)
    expect(() => buildAlterTableSql({ kind: 'alterColumn', table: 't', columnName: 'c' }, 'postgres')).toThrow(/No column modifications/)
    expect(buildAlterTableSql({ kind: 'alterColumn', table: 't', columnName: 'c', dataType: 'TEXT', nullable: true, defaultValue: '' }, 'postgres')).toContain('DROP NOT NULL, ALTER COLUMN "c" DROP DEFAULT')
    expect(buildAlterTableSql({ kind: 'alterColumn', table: 't', schema: 'shop', columnName: 'c', nullable: true, defaultValue: '' }, 'mysql')).toBe('ALTER TABLE `shop`.`t` MODIFY COLUMN `c` VARCHAR(255) NULL DEFAULT NULL;')
    expect(buildAlterTableSql({ kind: 'alterColumn', table: 't', schema: 'shop', columnName: 'c', nullable: false, defaultValue: '5' }, 'mysql')).toBe('ALTER TABLE `shop`.`t` MODIFY COLUMN `c` VARCHAR(255) NOT NULL DEFAULT 5;')
    expect(() => buildAlterTableSql({ kind: 'alterColumn', table: 't', columnName: 'c' }, 'mssql')).toThrow(/No column modifications/)
    expect(buildAlterTableSql({ kind: 'alterColumn', table: 't', schema: 'dbo', columnName: 'c', defaultValue: '', previousDefaultValue: '0', defaultDropSeq: 2 }, 'mssql')).toContain('DECLARE @df_c_2_')
    expect(buildAlterTableSql({ kind: 'alterColumn', table: 't', columnName: 'c', dataType: 'INT', nullable: true, defaultValue: '1' }, 'mssql')).toContain('ADD CONSTRAINT [DF_t_c_')
    expect(() => buildAlterTableSql({ kind: 'alterColumn', table: 't', columnName: 'c' }, 'oracle')).toThrow(/No column modifications/)
    expect(buildAlterTableSql({ kind: 'alterColumn', table: 't', columnName: 'c', dataType: 'NUMBER', nullable: true, defaultValue: '' }, 'oracle')).toBe('ALTER TABLE "t" MODIFY ("c" NUMBER DEFAULT NULL NULL);')
    expect(buildAlterTableSql({ kind: 'alterColumn', table: 't', columnName: 'c', defaultValue: 'x' }, 'clickhouse')).toBe("ALTER TABLE `t` MODIFY COLUMN `c` String DEFAULT 'x';")
    expect(() => buildAlterTableSql({ kind: 'alterColumn', table: 't', columnName: 'c', dataType: 'TEXT' }, 'sqlite')).toThrow(/not supported by SQLite/)

    // addIndex / dropIndex / addForeignKey / dropForeignKey
    expect(() => buildAlterTableSql({ kind: 'addIndex', table: 't', columns: [] }, 'sqlite')).toThrow(/At least one column/)
    expect(buildAlterTableSql({ kind: 'addIndex', table: 't', schema: 'aux', columns: ['a'], unique: true }, 'sqlite')).toBe('CREATE UNIQUE INDEX "aux"."idx_t_a" ON "t" ("a");')
    expect(buildAlterTableSql({ kind: 'addIndex', table: 't', columns: ['a'] }, 'clickhouse')).toContain('TYPE minmax GRANULARITY 1;')
    expect(() => buildAlterTableSql({ kind: 'dropIndex', table: 't', indexName: '' }, 'postgres')).toThrow(/Index name is required/)
    expect(buildAlterTableSql({ kind: 'dropIndex', table: 't', indexName: 'ix' }, 'mssql')).toBe('DROP INDEX [ix] ON [t];')
    expect(buildAlterTableSql({ kind: 'dropIndex', table: 't', indexName: 'ix' }, 'clickhouse')).toBe('ALTER TABLE `t` DROP INDEX `ix`;')
    expect(buildAlterTableSql({ kind: 'dropIndex', table: 't', schema: 'analytics', indexName: 'ix' }, 'postgres')).toBe('DROP INDEX "analytics"."ix";')
    expect(() => buildAlterTableSql({ kind: 'addForeignKey', table: 't', column: '', foreignTable: 'p', foreignColumn: 'id' }, 'postgres')).toThrow(/required/)
    expect(buildAlterTableSql({ kind: 'addForeignKey', table: 't', column: 'pid', foreignTable: 'p', foreignColumn: 'id', onDelete: 'INVALID_ACT', onUpdate: 'CASCADE' }, 'postgres')).toBe('ALTER TABLE "t" ADD CONSTRAINT "fk_t_pid_p" FOREIGN KEY ("pid") REFERENCES "p" ("id") ON UPDATE CASCADE;')
    expect(() => buildAlterTableSql({ kind: 'dropForeignKey', table: 't', constraintName: '' }, 'mysql')).toThrow(/Constraint name is required/)
    expect(buildAlterTableSql({ kind: 'dropForeignKey', table: 't', constraintName: 'fk1' }, 'mysql')).toBe('ALTER TABLE `t` DROP FOREIGN KEY `fk1`;')
    expect(buildAlterTableSql({ kind: 'dropForeignKey', table: 't', constraintName: 'fk1' }, 'postgres')).toBe('ALTER TABLE "t" DROP CONSTRAINT "fk1";')
  })

  it('executes live SQLite 12-step rebuild via node:sqlite and covers safety/trigger/composite-unique guards', () => {
    const db = new DatabaseSync(':memory:')
    try {
      db.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE categories (id INTEGER PRIMARY KEY);
        INSERT INTO categories VALUES (1), (2);
        CREATE TABLE items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          code TEXT COLLATE NOCASE,
          old_note TEXT,
          cat_id INTEGER,
          UNIQUE (code COLLATE NOCASE DESC) ON CONFLICT IGNORE,
          FOREIGN KEY (cat_id) REFERENCES categories(id) ON DELETE CASCADE
        );
        CREATE INDEX idx_items_cat ON items (cat_id);
        CREATE TRIGGER trg_items_audit -- trg comment
        /* block */ AFTER INSERT ON main.[items] FOR EACH ROW WHEN NEW.id > 0
        BEGIN
          SELECT NEW.[id];
        END;
        INSERT INTO items (code, old_note, cat_id) VALUES ('A1', NULL, 1);
      `)

      const rebuildDraft: TableStructureDraft = {
        tableName: 'items_v2',
        originalTableName: 'items',
        schema: 'main',
        columns: [
          {
            id: 'c1',
            name: 'id',
            originalName: 'id',
            dataType: 'INTEGER',
            originalDataType: 'INTEGER',
            nullable: false,
            originalNullable: false,
            defaultValue: '',
            originalDefaultValue: '',
            isPrimaryKey: true,
            originalIsPrimaryKey: true,
            isAutoIncrement: true,
            status: 'existing',
          },
          {
            id: 'c2',
            name: 'code',
            originalName: 'code',
            dataType: 'TEXT',
            originalDataType: 'TEXT',
            collate: 'NOCASE',
            nullable: false,
            originalNullable: true,
            defaultValue: 'N/A',
            originalDefaultValue: '',
            isPrimaryKey: false,
            originalIsPrimaryKey: false,
            status: 'existing',
          },
          {
            id: 'c3',
            name: 'old_note',
            originalName: 'old_note',
            dataType: 'TEXT',
            originalDataType: 'TEXT',
            nullable: false,
            originalNullable: true,
            defaultValue: 'empty',
            originalDefaultValue: '',
            isPrimaryKey: false,
            originalIsPrimaryKey: false,
            status: 'existing',
          },
          {
            id: 'c4',
            name: 'cat_id',
            originalName: 'cat_id',
            dataType: 'INTEGER',
            originalDataType: 'INTEGER',
            nullable: true,
            originalNullable: true,
            defaultValue: '',
            originalDefaultValue: '',
            isPrimaryKey: false,
            originalIsPrimaryKey: false,
            status: 'existing',
          },
        ],
        indexes: [
          {
            id: 'i1',
            name: 'sqlite_autoindex_items_1',
            columns: ['code'],
            columnSpecs: [{ name: 'code', collate: 'NOCASE', desc: true }],
            unique: true,
            origin: 'u',
            onConflict: 'IGNORE',
            status: 'existing',
          },
          { id: 'i2', name: 'idx_items_cat', columns: ['cat_id'], unique: false, status: 'existing' },
          { id: 'i3', name: 'idx_items_missing', columns: ['dropped_col'], unique: false, status: 'existing' },
        ],
        foreignKeys: [
          {
            id: 'f1',
            constraintName: 'fk_items_cat',
            column: 'cat_id',
            foreignTable: 'categories',
            foreignColumn: 'id',
            onDelete: 'CASCADE',
            status: 'existing',
          },
        ],
        triggers: [
          {
            name: 'trg_items_audit',
            sql: `CREATE TRIGGER trg_items_audit -- trg comment\n/* block */ AFTER INSERT ON main.[items] FOR EACH ROW WHEN NEW.id > 0\nBEGIN\n  SELECT NEW.[id];\nEND`,
          },
        ],
      }

      const plan = validateTableStructureDraft(rebuildDraft, 'sqlite', ['categories', 'items'])
      expect(plan.valid).toBe(true)
      expect(plan.isRebuild).toBe(true)
      expect(plan.warnings.some((w) => w.includes('will be recreated on renamed table "items_v2"'))).toBe(true)
      expect(plan.statements[plan.statements.length - 3]).toBe(SQLITE_FK_CHECK_ABORT_SQL)

      // Execute every single generated migration statement against live node:sqlite
      for (const stmt of plan.statements) {
        db.exec(stmt)
      }
      const rows = db.prepare('SELECT id, code, old_note, cat_id FROM items_v2').all() as Array<Record<string, unknown>>
      expect(rows).toEqual([{ id: 1, code: 'A1', old_note: 'empty', cat_id: 1 }])
      const trgRow = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_items_audit'").get() as { sql: string }
      expect(trgRow.sql).toContain('ON main."items_v2"')

      // D1 inbound FK safety block & trigger safety checks
      const d1Plan = validateTableStructureDraft(
        {
          ...rebuildDraft,
          inboundForeignKeys: [{ fromTable: 'child_tbl', fromColumn: 'item_id', toColumn: 'id' }],
        },
        'd1'
      )
      expect(d1Plan.valid).toBe(false)
      expect(d1Plan.errors.some((e) => e.includes('inbound foreign key(s) (child_tbl.item_id)'))).toBe(true)

      const compositeUniqueErrDraft = makeBaseDraft({
        columns: [
          { ...makeBaseDraft().columns[0], isPrimaryKey: true },
          { ...makeBaseDraft().columns[1], status: 'deleted' },
          {
            id: 'c3',
            name: 'extra',
            originalName: 'extra',
            dataType: 'TEXT',
            originalDataType: 'TEXT',
            nullable: true,
            originalNullable: true,
            defaultValue: '',
            originalDefaultValue: '',
            isPrimaryKey: false,
            originalIsPrimaryKey: false,
            status: 'existing',
          },
        ],
        indexes: [{ id: 'u1', name: 'uq_two', columns: ['title', 'extra'], unique: true, origin: 'u', status: 'existing' }],
      })
      expect(() => buildTableMigrationSql(compositeUniqueErrDraft, 'sqlite')).toThrow(/Composite UNIQUE/)

      const trgDirectRenameErr = makeBaseDraft({
        tableName: 'orders_renamed',
        triggers: [{ name: 'tr1', sql: 'CREATE TRIGGER tr1 AFTER INSERT ON orders BEGIN SELECT 1; END;' }],
      })
      expect(() => buildTableMigrationSql(trgDirectRenameErr, 'sqlite')).toThrow(/Direct table rename/)

      const trgBodyRefErr = validateTableStructureDraft(
        {
          ...rebuildDraft,
          triggers: [
            { name: 'tr_bad', sql: 'CREATE TRIGGER tr_bad AFTER INSERT ON items BEGIN UPDATE items SET code = NEW.old_note; END;' },
          ],
        },
        'sqlite'
      )
      expect(trgBodyRefErr.errors.some((e) => e.includes('references old table "items" in its SQL body'))).toBe(true)
    } finally {
      db.close()
    }
  })

  it('covers buildTableMigrationSql PK transitions across all server dialects, validation matrix & drop/truncate', () => {
    expect(() => buildTableMigrationSql(makeBaseDraft(), 'redis')).toThrow(/Redis/)
    expect(() => buildTableMigrationSql(makeBaseDraft({ tableName: '  ', originalTableName: '  ' }), 'postgres')).toThrow(/Table name is required/)
    expect(buildTableMigrationSql(makeBaseDraft(), 'postgres')).toEqual([])

    const dupColDraft = makeBaseDraft({
      columns: [
        makeBaseDraft().columns[0],
        { ...makeBaseDraft().columns[1], name: 'ID' },
      ],
    })
    expect(() => buildTableMigrationSql(dupColDraft, 'postgres')).toThrow(/Duplicate column name/)

    const emptyColDraft = makeBaseDraft({
      columns: [
        makeBaseDraft().columns[0],
        { ...makeBaseDraft().columns[1], name: '   ' },
      ],
    })
    expect(() => buildTableMigrationSql(emptyColDraft, 'postgres')).toThrow(/non-empty name/)

    // PK membership changes + column modify + rename + index/FK add/drop across dialects
    const pkSwitchDraft = makeBaseDraft({
      tableName: 'orders_next',
      columns: [
        {
          ...makeBaseDraft().columns[0],
          isPrimaryKey: false,
          originalIsPrimaryKey: true,
        },
        {
          ...makeBaseDraft().columns[1],
          name: 'title_new',
          originalName: 'title',
          nullable: false,
          originalNullable: true,
          defaultValue: 'def',
          originalDefaultValue: '',
          isPrimaryKey: true,
          originalIsPrimaryKey: false,
        },
        {
          id: 'c3',
          name: 'created_at',
          dataType: 'TEXT',
          nullable: true,
          defaultValue: '',
          isPrimaryKey: false,
          status: 'new',
        },
      ],
      indexes: [
        { id: 'pk', name: 'orders_pkey', columns: ['id'], unique: true, isPrimary: true, status: 'existing' },
        { id: 'i_del', name: 'idx_old', columns: ['id'], unique: false, status: 'deleted' },
        { id: 'i_new', name: 'idx_new', columns: ['created_at'], unique: true, status: 'new' },
      ],
      foreignKeys: [
        { id: 'f_del', constraintName: 'fk_old', column: 'id', foreignTable: 'u', foreignColumn: 'id', status: 'deleted' },
        { id: 'f_new', column: 'created_at', foreignTable: 'u', foreignColumn: 'id', status: 'new' },
      ],
    })

    const pgStmts = buildTableMigrationSql(pkSwitchDraft, 'postgres')
    expect(pgStmts.some((s) => s.includes('DROP CONSTRAINT IF EXISTS "orders_pkey"'))).toBe(true)
    expect(pgStmts.some((s) => s.includes('ADD PRIMARY KEY ("title_new")'))).toBe(true)

    const mysqlStmts = buildTableMigrationSql(pkSwitchDraft, 'mysql')
    expect(mysqlStmts.some((s) => s.includes('DROP PRIMARY KEY;'))).toBe(true)

    const mssqlStmts = buildTableMigrationSql(pkSwitchDraft, 'mssql')
    expect(mssqlStmts.some((s) => s.includes('DROP CONSTRAINT [orders_pkey];'))).toBe(true)

    const oracleNamedPk = buildTableMigrationSql(pkSwitchDraft, 'oracle')
    expect(oracleNamedPk.some((s) => s.includes('DROP CONSTRAINT "orders_pkey";'))).toBe(true)

    const oracleUnnamedPk = buildTableMigrationSql({ ...pkSwitchDraft, indexes: [] }, 'oracle')
    expect(oracleUnnamedPk.some((s) => s.includes('DROP PRIMARY KEY;'))).toBe(true)

    expect(() => buildTableMigrationSql(pkSwitchDraft, 'clickhouse')).toThrow(/not supported on ClickHouse/)

    // draft helpers
    const initDraft = createInitialTableDraft({
      name: 't',
      schema: 'public',
      kind: 'table',
      columns: [makeColumn({ name: 'a', defaultValue: '1' })],
      primaryKey: [],
      indexes: [{ name: 'pk_a', isUnique: true, isPrimary: true, columns: ['a'] }],
      foreignKeys: [{ constraintName: 'fk1', column: 'a', referencedTable: 'b', referencedColumn: 'id' }],
    })
    expect(countTableStructureChanges(initDraft)).toBe(0)
    expect(requiresSqliteTableRebuild(initDraft)).toBe(false)
    expect(isDraftColumnDirty(initDraft.columns[0])).toBe(false)
    expect(requiresSqliteTableRebuild({ ...initDraft, foreignKeys: [{ id: 'x', column: 'a', foreignTable: 'b', foreignColumn: 'id', status: 'new' }] })).toBe(true)

    // validateTableStructureDraft negative validation sweep
    const invalidDraft = makeBaseDraft({
      tableName: 'bad;tbl',
      columns: [
        { id: 'd1', name: 'x', originalName: 'x', dataType: 'TEXT', nullable: true, defaultValue: '', isPrimaryKey: false, status: 'deleted' },
        { id: 'e1', name: 'bad;col', dataType: 'BAD;;TYPE', nullable: true, defaultValue: 'bad;def', isPrimaryKey: false, status: 'new' },
        { id: 'e2', name: 'bad;col', dataType: 'TEXT', nullable: false, defaultValue: '', isPrimaryKey: false, status: 'new' },
        { id: 'e3', name: '', dataType: 'TEXT', nullable: true, defaultValue: '', isPrimaryKey: false, status: 'existing', originalName: 'orig' },
      ],
      indexes: [
        { id: 'ix1', name: '', columns: [], unique: false, status: 'new' },
        { id: 'ix2', name: 'dup_i', columns: ['missing_c'], unique: false, status: 'new' },
        { id: 'ix3', name: 'dup_i', columns: ['bad;col'], unique: false, status: 'new' },
      ],
      foreignKeys: [
        { id: 'fx1', column: 'missing_local', foreignTable: 'ghost_tbl', foreignColumn: '', status: 'new' },
        { id: 'fx2', column: 'bad;col', foreignTable: '', foreignColumn: 'id', status: 'new' },
      ],
    })
    const invalidPlan = validateTableStructureDraft(invalidDraft, 'clickhouse', ['existing_tbl'])
    expect(invalidPlan.valid).toBe(false)
    expect(invalidPlan.errors.some((e) => e.includes('invalid characters'))).toBe(true)
    expect(invalidPlan.errors.some((e) => e.includes('ClickHouse does not support FOREIGN KEY'))).toBe(true)
    expect(invalidPlan.errors.some((e) => e.includes('Duplicate index name'))).toBe(true)

    // buildCreateTableSql, buildTruncateTableSql, buildDropTableSql errors & ClickHouse tuple()
    expect(() => buildCreateTableSql({ tableName: 't', columns: [] }, 'redis')).toThrow(/Redis/)
    expect(() => buildCreateTableSql({ tableName: '', columns: [] }, 'postgres')).toThrow(/required/)
    expect(() => buildCreateTableSql({ tableName: 'bad;name', columns: [] }, 'postgres')).toThrow(/invalid/)
    expect(() => buildCreateTableSql({ tableName: 't', schema: 'bad;s', columns: [] }, 'postgres')).toThrow(/Schema name/)
    expect(() => buildCreateTableSql({ tableName: 't', columns: [] }, 'postgres')).toThrow(/at least one column/)
    expect(() => buildCreateTableSql({ tableName: 't', columns: [{ name: '', dataType: 'INT', nullable: true }] }, 'postgres')).toThrow(/non-empty/)
    expect(() => buildCreateTableSql({ tableName: 't', columns: [{ name: 'a;b', dataType: 'INT', nullable: true }] }, 'postgres')).toThrow(/invalid SQL/)
    expect(() =>
      buildCreateTableSql(
        {
          tableName: 't',
          columns: [
            { name: 'a', dataType: 'INT', nullable: true },
            { name: 'A', dataType: 'INT', nullable: true },
          ],
        },
        'postgres'
      )
    ).toThrow(/Duplicate column name/)

    expect(
      buildCreateTableSql(
        { tableName: 'events', columns: [{ name: 'ts', dataType: 'DateTime', nullable: false }] },
        'clickhouse'
      )
    ).toContain('ORDER BY tuple();')

    expect(() => buildTruncateTableSql('t', 'redis')).toThrow(/Redis/)
    expect(() => buildTruncateTableSql('', 'sqlite')).toThrow(/required/)
    expect(() => buildTruncateTableSql('a\0b', 'sqlite')).toThrow(/Table name/)
    expect(() => buildTruncateTableSql('t', 'postgres', 's;1')).toThrow(/Schema name/)
    expect(buildTruncateTableSql('t', 'sqlite', 'main')).toBe('DELETE FROM "t";')
    expect(buildTruncateTableSql('t', 'postgres', 'analytics')).toBe('TRUNCATE TABLE "analytics"."t";')

    expect(() => buildDropTableSql('t', 'table', 'redis')).toThrow(/Redis/)
    expect(() => buildDropTableSql('', 'view', 'postgres')).toThrow(/required/)
    expect(() => buildDropTableSql('a--b', 'table', 'postgres')).toThrow(/invalid characters/)
    expect(() => buildDropTableSql('t', 'table', 'postgres', 's\0x')).toThrow(/Schema name/)
    expect(buildDropTableSql('v1', 'view', 'postgres', 'analytics', true)).toBe('DROP VIEW IF EXISTS "analytics"."v1";')
    expect(buildDropTableSql('t1', 'table', 'sqlite', 'main', false)).toBe('DROP TABLE "t1";')
  })

  it('closes remaining schema.ts & sql-migration.ts polish branches (PG/MSSQL/Oracle happy & catch paths, DDL deps cycles, D1/composite-PK rebuild)', async () => {
    // 1. SQLite tokenize comments inside parens, extractConflictAction invalid suffix & inbound catch
    const sqliteEdgeRes = await introspectSqliteTableDetails(
      async (sql) => {
        if (sql.includes("type IN ('table', 'view')")) {
          return [{
            type: 'table',
            sql: `CREATE TABLE "t_edge" (id INT CHECK ( -- lc\n /* bc */ id = 1 + 2 ), c TEXT UNIQUE ON INVALID_KW, [k] INT)`,
          }]
        }
        if (sql.includes('PRAGMA table_xinfo')) {
          return [
            { name: 'id', type: 'INTEGER', pk: 1, notnull: 1, hidden: 0 },
            { name: 'c', type: 'TEXT', pk: 0, notnull: 0, hidden: 0 },
          ]
        }
        if (sql.includes('PRAGMA foreign_key_list("t_edge")')) return []
        if (sql.includes('PRAGMA index_list')) return []
        if (sql.includes("UPPER(sql) LIKE '%REFERENCES%'")) throw new Error('master locked')
        return []
      },
      't_edge',
      'main'
    )
    expect(sqliteEdgeRes.inboundForeignKeys).toEqual([])

    const sqliteInboundOmittedTo = await introspectSqliteTableDetails(
      async (sql) => {
        if (sql.includes("type IN ('table', 'view')")) return [{ type: 'table', sql: 'CREATE TABLE p (id INT PRIMARY KEY)' }]
        if (sql.includes('PRAGMA table_xinfo')) return [{ name: 'id', type: 'INTEGER', pk: 1, notnull: 1, hidden: 0 }]
        if (sql.includes('PRAGMA foreign_key_list("p")')) return []
        if (sql.includes('PRAGMA index_list')) return []
        if (sql.includes("UPPER(sql) LIKE '%REFERENCES%'")) return [{ name: 'child_ok' }]
        if (sql.includes('PRAGMA foreign_key_list("child_ok")')) {
          return [{ table: 'p', from: 'pid', to: '', seq: 0, on_delete: 'CASCADE' }]
        }
        return []
      },
      'p',
      'main'
    )
    expect(sqliteInboundOmittedTo.inboundForeignKeys).toEqual([
      { fromTable: 'child_ok', fromColumn: 'pid', toColumn: 'id', onDelete: 'CASCADE' },
    ])

    // 2. Postgres HAPPY paths: introspectPostgresObjects, function/procedure/trigger DDL, regular colSql w/ unique_rowid()
    const pgHappyObjs = await introspectPostgresObjects(async (sql) => {
      if (sql.includes('information_schema.tables')) return [{ name: 't1', schema: 'public', kind: 'table' }]
      if (sql.includes("c.relkind = 'S'")) return [{ name: 's1', schema: 'public', kind: 'sequence' }]
      if (sql.includes('p.prokind IN')) return [{ name: 'p1', schema: 'public', kind: 'procedure' }]
      return []
    }, 'public')
    expect(pgHappyObjs.map((o) => o.kind)).toEqual(['procedure', 'sequence', 'table'])

    expect(await introspectPostgresObjectDdl(async () => [{ ddl: 'CREATE FUNCTION f() RETURNS void' }], 'f', 'function')).toContain('CREATE FUNCTION')
    expect(await introspectPostgresObjectDdl(async () => [{ ddl: 'CREATE TRIGGER tr BEFORE INSERT ON t EXECUTE FUNCTION f()' }], 'tr', 'trigger')).toContain('CREATE TRIGGER')

    const pgRegularTbl = await introspectPostgresTableDetails(
      async (sql) => {
        if (sql.includes('information_schema.tables')) return [{ kind: 'table' }]
        if (sql.includes("tc.constraint_type = 'PRIMARY KEY'")) return [{ column_name: 'id' }]
        if (sql.includes('FROM information_schema.columns')) {
          return [{ name: 'id', type: 'bigint', native_type: 'int8', nullable: false, default_value: 'unique_rowid()', is_auto_increment: false }]
        }
        if (sql.includes('FROM pg_catalog.pg_index')) return [{ index_name: 't_pkey', is_unique: true, is_primary: true, column_name: 'id' }]
        return []
      },
      'crdb_tbl',
      'public'
    )
    expect(pgRegularTbl.columns[0].isAutoIncrement).toBe(true)

    // 3. MSSQL HAPPY OBJECT_DEFINITION, collation_name, view kind, catch fallbacks on inbound/triggers
    expect(await introspectMssqlObjectDdl(async () => [{ definition: 'CREATE VIEW dbo.v_ok AS SELECT 1' }], 'v_ok', 'view')).toContain('v_ok')
    const mssqlViewAndCatches = await introspectMssqlTableDetails(
      async (sql) => {
        if (sql.includes("o.type IN ('U', 'V')")) return [{ obj_type: 'U', object_id: 1 }]
        if (sql.includes('FROM sys.columns')) {
          return [{ name: 'txt', base_type: 'varchar', max_length: 10, is_nullable: 1, collation_name: 'Latin1_General_CI_AS' }]
        }
        if (sql.includes('WHERE rs.name')) throw new Error('inbound denied')
        if (sql.includes('FROM sys.triggers')) throw new Error('triggers denied')
        return []
      },
      't_c',
      'dbo'
    )
    expect(mssqlViewAndCatches.columns[0].collate).toBe('Latin1_General_CI_AS')

    const mssqlViewNoDdl = await introspectMssqlTableDetails(
      async (sql) => (sql.includes("o.type IN ('U', 'V')") ? [{ obj_type: 'V', object_id: 2 }] : []),
      'v_c',
      'dbo'
    )
    expect(mssqlViewNoDdl.kind).toBe('view')
    expect(mssqlViewNoDdl.ddl).toBeUndefined()

    // 4. Oracle HAPPY DBMS_METADATA, virtual cols ALL_TAB_COLS, UQ constraints, all_indexes, outbound FK, matview kind
    expect(await introspectOracleObjectDdl(async () => [{ DDL: 'CREATE SEQUENCE HR.SQ1' }], 'SQ1', 'sequence', 'hr')).toBe('CREATE SEQUENCE HR.SQ1;')
    const oraFullTable = await introspectOracleTableDetails(
      async (sql) => {
        if (sql.includes('FROM all_objects')) return [{ OBJECT_TYPE: 'TABLE' }]
        if (sql.includes('FROM all_tab_columns')) {
          return [
            { COLUMN_NAME: 'ID', DATA_TYPE: 'NUMBER', DATA_PRECISION: 10, DATA_SCALE: 0, NULLABLE: 'N' },
            { COLUMN_NAME: 'S', DATA_TYPE: 'VARCHAR2', CHAR_LENGTH: 0, DATA_LENGTH: 0, NULLABLE: 'Y' },
            { COLUMN_NAME: 'D', DATA_TYPE: 'DATE', NULLABLE: 'Y' },
          ]
        }
        if (sql.includes('FROM all_tab_cols')) return [{ COLUMN_NAME: 'S', VIRTUAL_COLUMN: 'YES' }]
        if (sql.includes("ac.constraint_type = 'P'")) return [{ COLUMN_NAME: 'ID', CONSTRAINT_NAME: 'PK_FULL' }]
        if (sql.includes("constraint_type = 'U'")) return [{ CONSTRAINT_NAME: 'UQ_S' }]
        if (sql.includes('FROM all_indexes')) {
          return [
            { INDEX_NAME: 'PK_FULL', UNIQUENESS: 'UNIQUE', COLUMN_NAME: 'ID', DESCEND: 'ASC' },
            { INDEX_NAME: 'UQ_S', UNIQUENESS: 'UNIQUE', COLUMN_NAME: 'S', DESCEND: 'ASC' },
            { INDEX_NAME: 'IX_D_DESC', UNIQUENESS: 'NONUNIQUE', COLUMN_NAME: 'D', DESCEND: 'DESC' },
          ]
        }
        if (sql.includes('WHERE ac.owner = :p1')) {
          return [{ CONSTRAINT_NAME: 'FK_OR', COLUMN_NAME: 'ID', REFERENCED_SCHEMA: 'CORE', REFERENCED_TABLE: 'P', REFERENCED_COLUMN: 'ID', ON_DELETE: 'CASCADE' }]
        }
        if (sql.includes('WHERE rc.owner = :p1')) throw new Error('inbound denied')
        if (sql.includes('FROM all_triggers')) throw new Error('trg denied')
        return []
      },
      'FULL_T',
      'hr'
    )
    expect(oraFullTable.indexes).toHaveLength(3)
    expect(oraFullTable.foreignKeys[0]).toMatchObject({ constraintName: 'FK_OR', referencedSchema: 'CORE', onDelete: 'CASCADE' })
    expect(oraFullTable.ddl).toContain('CONSTRAINT "UQ_S" UNIQUE ("S")')
    expect(oraFullTable.ddl).toContain('CREATE INDEX "HR"."IX_D_DESC"')

    const oraMatviewAndObjDdl = await introspectOracleObjectDdl(
      async (sql) => {
        if (sql.includes('DBMS_METADATA')) throw new Error('no metadata priv')
        if (sql.includes('FROM all_objects')) return [{ OBJECT_TYPE: 'TABLE' }]
        if (sql.includes('FROM all_tab_columns')) return [{ COLUMN_NAME: 'X', DATA_TYPE: 'DATE', NULLABLE: 'Y' }]
        return []
      },
      'T_META',
      'table',
      'hr'
    )
    expect(oraMatviewAndObjDdl).toContain('CREATE TABLE "HR"."T_META"')

    const oraViewDetails = await introspectOracleTableDetails(
      async (sql) => (sql.includes('FROM all_objects') ? [{ OBJECT_TYPE: 'MATERIALIZED VIEW' }] : []),
      'MV_MISS',
      'hr'
    )
    expect(oraViewDetails.kind).toBe('view')
    expect(oraViewDetails.ddl).toBe('')

    // 5. DDL tokenizer dependency edge cases (bracket escaped ]], explicit cyclic deps, non-CREATE header PG cyclic table, MSSQL view GO)
    const cycleDepsOut = assembleFullSchemaDdl({
      dialect: 'postgres',
      schemaName: 'public',
      sections: [
        { kind: 'table', name: 't_cmt', ddl: `-- table header before CREATE\nCREATE TABLE "public"."t_cmt" (id INT, b INT REFERENCES "t_plain"(id));` },
        { kind: 'table', name: 't_plain', ddl: 'CREATE TABLE "public"."t_plain" (id INT, a INT REFERENCES "t_cmt"(id));' },
        { kind: 'view', name: 'v_a', ddl: 'CREATE VIEW v_a AS SELECT * FROM v_b WHERE s = \'it\'\'s\'; -- end' },
        { kind: 'view', name: 'v_b', ddl: 'CREATE VIEW v_b AS SELECT * FROM v_a;' },
        { kind: 'table', name: 't_mssql_brk', ddl: 'CREATE TABLE [tbl]]1] (id INT);' },
      ],
      dependencies: [
        { consumer: { kind: 'view', name: 'v_a' }, prerequisite: { kind: 'view', name: 'v_b' } },
        { consumer: { kind: 'view', name: 'v_b' }, prerequisite: { kind: 'view', name: 'v_a' } },
      ],
    })
    expect(cycleDepsOut.ddl).toContain('CREATE TABLE "public"."t_cmt"')
    const mssqlViewGo = assembleFullSchemaDdl({
      dialect: 'mssql',
      schemaName: 'dbo',
      sections: [{ kind: 'view', name: 'v_go', ddl: 'CREATE VIEW dbo.v_go AS SELECT 1;' }],
    })
    expect(mssqlViewGo.ddl).toContain('\nGO')

    // 6. sql-migration.ts remaining dialect & validation/rebuild branches
    const oraRebuildDdl = reconstructTableDdl(
      {
        name: 'ora_t',
        schema: 'HR',
        kind: 'table',
        columns: [
          makeColumn({ name: 'id', type: 'NUMBER', nativeType: 'NUMBER', nullable: false, isPrimaryKey: true, isAutoIncrement: true, defaultValue: '"HR"."ISEQ$$_1".nextval' }),
          makeColumn({ name: 'code', type: 'VARCHAR2(20)', nativeType: 'VARCHAR2(20)', nullable: false, defaultValue: "'X'" }),
        ],
        primaryKey: ['id'],
        indexes: [],
        foreignKeys: [],
      },
      'oracle'
    )
    expect(oraRebuildDdl).toContain('GENERATED BY DEFAULT AS IDENTITY NOT NULL')
    expect(oraRebuildDdl).toContain('"code" VARCHAR2(20) DEFAULT \'X\' NOT NULL')

    const mssqlDdl = reconstructTableDdl(
      {
        name: 'ms_t',
        schema: 'dbo',
        kind: 'table',
        columns: [
          makeColumn({ name: 'id', type: 'INT', nativeType: 'INT', nullable: false, isPrimaryKey: true, isAutoIncrement: true }),
        ],
        primaryKey: ['id'],
        indexes: [],
        foreignKeys: [],
      },
      'mssql'
    )
    expect(mssqlDdl).toContain('[id] INT IDENTITY(1,1) NOT NULL')

    // alterColumn mysql NOT NULL + renameColumn no schema mssql + dropIndex fallback
    expect(buildAlterTableSql({ kind: 'renameColumn', table: 't', oldColumnName: 'a', newColumnName: 'b' }, 'mssql')).toBe("EXEC sp_rename '[t].[a]', 'b', 'COLUMN';")
    expect(buildAlterTableSql({ kind: 'dropIndex', table: 't', indexName: 'ix' }, 'duckdb' as DatabaseDriverType)).toBe('DROP INDEX "ix";')

    // composite PK + unnamed index + D1 rebuild + trigger bracket escaping & non-matching ON target
    const d1CompositeDraft = makeBaseDraft({
      tableName: 'orders_d1',
      schema: 'main',
      columns: [
        { ...makeBaseDraft().columns[0], isPrimaryKey: true, originalIsPrimaryKey: true },
        { ...makeBaseDraft().columns[1], isPrimaryKey: true, originalIsPrimaryKey: false },
      ],
      indexes: [
        { id: 'ix_noname', name: '', columns: ['title'], unique: false, status: 'new' },
      ],
      triggers: [
        { name: 'tr_brk', sql: 'CREATE TRIGGER [tr]]1] AFTER INSERT ON [other_tbl] WHEN NEW.id > 0 BEGIN SELECT 1; END' },
        { name: 'tr_nobegin', sql: 'CREATE TRIGGER tr_nobegin AFTER INSERT ON orders SELECT 1;' },
      ],
    })
    // Trigger on [other_tbl] triggers trigger header non-match check during rename
    const planNonMatchTrg = validateTableStructureDraft(d1CompositeDraft, 'd1')
    expect(planNonMatchTrg.valid).toBe(false)

    const d1NoRenameComposite = buildTableMigrationSql({
      ...d1CompositeDraft,
      tableName: 'orders',
      triggers: [{ name: 'tr_nobegin', sql: 'CREATE TRIGGER tr_nobegin AFTER INSERT ON orders SELECT 1;' }],
    }, 'd1')
    expect(d1NoRenameComposite[0]).toBe('PRAGMA defer_foreign_keys = ON;')
    expect(d1NoRenameComposite.some((s) => s.includes('PRIMARY KEY ("id", "title")'))).toBe(true)
    expect(d1NoRenameComposite.some((s) => s.includes('CREATE INDEX IF NOT EXISTS "idx_orders_title"'))).toBe(true)

    // validateTableStructureDraft remaining errors (0 cols, empty name, NOT NULL warning, PK warning, catch in buildTableMigrationSql)
    const errZeroCols = validateTableStructureDraft({
      tableName: '',
      originalTableName: 't',
      columns: [],
      indexes: [],
      foreignKeys: [],
    }, 'sqlite')
    expect(errZeroCols.errors).toContain('Table name cannot be empty.')
    expect(errZeroCols.errors).toContain('Table must have at least one remaining column.')

    const pkAndNotNullWarnings = validateTableStructureDraft(
      makeBaseDraft({
        columns: [
          { ...makeBaseDraft().columns[0], isPrimaryKey: false, originalIsPrimaryKey: true },
          { ...makeBaseDraft().columns[1], nullable: false, originalNullable: true, defaultValue: '', originalDefaultValue: '' },
          { id: 'n1', name: 'req', dataType: 'TEXT', nullable: false, defaultValue: '', isPrimaryKey: false, status: 'new' },
        ],
      }),
      'sqlite'
    )
    expect(pkAndNotNullWarnings.warnings.some((w) => w.includes('alters row identity'))).toBe(true)
    expect(pkAndNotNullWarnings.warnings.some((w) => w.includes("auto-fills '' / 0 on SQLite"))).toBe(true)

    const dupColsInValidate = validateTableStructureDraft(
      makeBaseDraft({
        columns: [
          makeBaseDraft().columns[0],
          { ...makeBaseDraft().columns[1], name: 'ID' },
        ],
      }),
      'postgres'
    )
    expect(dupColsInValidate.errors.some((e) => e.includes('Duplicate column name'))).toBe(true)

    // ClickHouse PK switch inside validateTableStructureDraft hits catch(err) at L2077
    const chPkErrPlan = validateTableStructureDraft(
      makeBaseDraft({
        columns: [
          { ...makeBaseDraft().columns[0], isPrimaryKey: false, originalIsPrimaryKey: true },
          makeBaseDraft().columns[1],
        ],
      }),
      'clickhouse'
    )
    expect(chPkErrPlan.valid).toBe(false)
    expect(chPkErrPlan.errors.some((e) => e.includes('ClickHouse'))).toBe(true)
  })

  it('Round 3: closes remaining schema introspection, DDL tokenizer & sql-migration edge branches with PBT', async () => {
    // 1. Live node:sqlite + mock SQLite introspection edge gaps (blank schema, broken DDL tokens, inbound FKs without to/on_delete)
    const liveDb = new DatabaseSync(':memory:')
    liveDb.exec(`
      CREATE TABLE parent_live (id INTEGER PRIMARY KEY);
      CREATE VIEW v_live AS SELECT id FROM parent_live;
    `)
    const liveQ = createSqliteQuery(liveDb)
    expect((await introspectSqliteSchemas(liveQ)).schemas).toContain('main')
    expect((await introspectSqliteSchemas(async () => [{ name: null }])).schemas).toEqual(['main'])
    const liveViewInfo = await introspectSqliteTableDetails(liveQ, 'v_live', '   ')
    expect(liveViewInfo.kind).toBe('view')
    liveDb.close()

    const mockSqliteQ: QueryExecutor = async (sql) => {
      if (sql.includes("type IN ('table', 'view')")) {
        return [{
          type: 'table',
          sql: "CREATE TABLE t ( , = 1, \"\" TEXT, [col [INT, s 'unterminated, (a INT)",
        }]
      }
      if (sql.includes('sqlite_master') && sql.includes("type = 'table'") && sql.includes('UPPER(sql)')) {
        return [{ name: '' }, { name: 'child_fk' }]
      }
      if (sql.includes('sqlite_master') && sql.includes("ORDER BY type, name")) {
        return [{ name: null, type: 'table', sql: 'CREATE TABLE broken ( , )' }]
      }
      if (sql.includes('PRAGMA') && sql.includes('table_xinfo')) {
        return [{ name: 'c1', type: '', notnull: 0, dflt_value: null, pk: 0, hidden: 0 }]
      }
      if (sql.includes('PRAGMA') && sql.includes('foreign_key_list') && sql.includes('t_edge')) {
        return [{ id: undefined, seq: undefined, table: 'missing_parent', from: 'p_id', to: undefined, on_delete: '', on_update: '' }]
      }
      if (sql.includes('PRAGMA') && sql.includes('foreign_key_list') && sql.includes('child_fk')) {
        return [
          { table: 'other_tbl', from: 'x', to: 'y', seq: 0, on_delete: 'CASCADE' },
          { table: 't_edge', from: undefined, seq: undefined, to: null, on_delete: '   ' },
        ]
      }
      if (sql.includes('PRAGMA') && sql.includes('index_list')) {
        return [{ name: 'ix_empty', unique: 0, origin: undefined }]
      }
      return []
    }
    expect(await introspectSqliteObjects(mockSqliteQ, '')).toEqual([])
    const mockSqliteDetails = await introspectSqliteTableDetails(mockSqliteQ, 't_edge', '')
    expect(mockSqliteDetails.columns[0].type).toBe('TEXT')
    expect(mockSqliteDetails.inboundForeignKeys).toEqual([{ fromTable: 'child_fk', fromColumn: '', toColumn: '' }])
    await expect(introspectSqliteObjectDdl(mockSqliteQ, 'missing_v', 'view', '')).rejects.toThrow(/DDL not found/i)

    // 2. Postgres, MySQL, MSSQL & Oracle mocked catalog edge cases
    const pgEdgeQ: QueryExecutor = async (sql) => {
      if (sql.includes('pg_namespace')) return [{ name: null }]
      if (sql.includes('pg_get_functiondef') || sql.includes('pg_get_triggerdef')) return [{ ddl: 123 }]
      if (sql.includes('pg_enum')) return [{ label: null }]
      if (sql.includes('information_schema.domains')) return [{ data_type: 'numeric', max_length: null, precision: 10, scale: undefined }]
      if (sql.includes('FROM information_schema.tables')) return [{ kind: 'view' }]
      if (sql.includes("constraint_type = 'FOREIGN KEY'")) {
        return [{ constraint_name: 'fk_min', column_name: 'a', referenced_schema: undefined, referenced_table: 'p', referenced_column: 'id', on_delete: null, on_update: null }]
      }
      return []
    }
    expect(await introspectPostgresSchemas(pgEdgeQ)).toEqual({ schemas: [], defaultSchema: 'public' })
    expect(await introspectPostgresObjects(pgEdgeQ, '   ')).toEqual([])
    await expect(introspectPostgresObjectDdl(pgEdgeQ, 'fn1', 'function', '   ')).rejects.toThrow()
    await expect(introspectPostgresObjectDdl(pgEdgeQ, 'pr1', 'procedure', '   ')).rejects.toThrow()
    await expect(introspectPostgresObjectDdl(pgEdgeQ, 'tr1', 'trigger', '   ')).rejects.toThrow()
    expect(await introspectPostgresObjectDdl(pgEdgeQ, 'e_null', 'type', '   ')).toContain("''")
    const pgNoEnumQ: QueryExecutor = async (sql) =>
      sql.includes('information_schema.domains') ? [{ data_type: 'numeric', max_length: null, precision: 12, scale: undefined }] : []
    expect(await introspectPostgresObjectDdl(pgNoEnumQ, 'd_noscale', 'type', 'public')).toContain('numeric(12,0)')
    const pgViewInfo = await introspectPostgresTableDetails(pgEdgeQ, 'v_pg', '   ')
    expect(pgViewInfo.kind).toBe('view')
    expect(pgViewInfo.foreignKeys[0]).toEqual({ constraintName: 'fk_min', column: 'a', referencedTable: 'p', referencedColumn: 'id' })

    const mysqlEdgeQ: QueryExecutor = async (sql) => {
      if (sql.includes('SHOW DATABASES')) return [{ Database: null }]
      if (sql.includes('information_schema.tables')) return [{ kind: 'view' }]
      if (sql.includes("constraint_name = 'PRIMARY'")) return [{ COLUMN_NAME: 'ID' }]
      if (sql.includes('referential_constraints')) {
        return [{ constraint_name: 'fk_m', column: 'c', referenced_schema: 'app', referenced_table: 'p', referenced_column: 'id', on_delete: null, on_update: null }]
      }
      if (sql.includes('information_schema.statistics')) return [{ INDEX_NAME: 'IX_UPPER', is_unique: 0, is_primary: 0, COLUMN_NAME: 'C' }]
      return []
    }
    expect(await introspectMysqlSchemas(mysqlEdgeQ, '')).toEqual({ schemas: [], defaultSchema: '' })
    const mysqlViewInfo = await introspectMysqlTableDetails(mysqlEdgeQ, 'v_m', 'app')
    expect(mysqlViewInfo.kind).toBe('view')
    expect(mysqlViewInfo.primaryKey).toEqual(['ID'])
    expect(mysqlViewInfo.indexes[0].columns).toEqual(['C'])

    // PBT for unwrapMssqlDefaultExpression idempotence + empty/unmatched parens
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constantFrom('', '  ', '(( ))', '(0)', "((N'a''b'))", '((1+2)', '(a))((', 'plain'),
          fc.string({ maxLength: 30 })
        ),
        (raw) => {
          const once = unwrapMssqlDefaultExpression(raw)
          const twice = unwrapMssqlDefaultExpression(once)
          expect(twice).toBe(once)
        }
      ),
      { numRuns: 60 }
    )

    const mssqlEdgeQ: QueryExecutor = async (sql) => {
      if (sql.includes('FROM sys.schemas')) return [{ name: null }]
      if (sql.includes("o.type IN ('U', 'V')")) return [{ obj_type: 'U', object_id: 10 }]
      if (sql.includes('FROM sys.columns')) {
        return [
          { name: 'id', base_type: 'int', max_length: 4, precision: 10, scale: 0, is_nullable: 0, is_identity: 1, is_computed: 0 },
          { name: 'comp_np', base_type: 'int', max_length: 4, precision: 10, scale: 0, is_nullable: 1, computed_definition: '[id] + 1', is_persisted: 0 },
        ]
      }
      if (sql.includes('FROM sys.indexes')) {
        return [
          { index_name: 'ix_plain', is_unique: 0, is_primary_key: 0, is_unique_constraint: 0, filter_definition: null, is_included_column: 0, is_descending_key: 0, column_name: 'id' },
          { index_name: 'ix_inc_only', is_unique: 0, is_primary_key: 0, is_unique_constraint: 0, filter_definition: null, is_included_column: 1, is_descending_key: 0, column_name: 'comp_np' },
        ]
      }
      if (sql.includes('FROM sys.foreign_keys')) {
        return [{ constraint_name: '', column_name: 'id', referenced_schema: 'dbo', referenced_table: 'p', referenced_column: 'id', delete_action: '   ', update_action: 'NO_ACTION' }]
      }
      if (sql.includes('FROM sys.triggers')) {
        return [{ name: 'tr_nosemi', sql: 'CREATE TRIGGER dbo.tr_nosemi ON dbo.t_ms AFTER INSERT AS SELECT 1' }]
      }
      if (sql.includes('FROM sys.types')) return [{ is_table_type: 1, base_type: 'table', max_length: 0, precision: 0, scale: 0, is_nullable: 0 }]
      if (sql.includes('FROM sys.table_types')) return [{ name: 'k', base_type: 'int', max_length: 4, precision: 10, scale: 0, is_nullable: 0 }]
      return []
    }
    expect((await introspectMssqlSchemas(mssqlEdgeQ)).schemas).toEqual(['dbo'])
    expect(await introspectMssqlObjects(mssqlEdgeQ, '   ')).toEqual([])
    expect(await introspectMssqlObjectDdl(mssqlEdgeQ, 'tvp', 'type', '   ')).toContain('[k] int NOT NULL')
    const mssqlDetails = await introspectMssqlTableDetails(mssqlEdgeQ, 't_ms', '   ')
    expect(mssqlDetails.ddl).toContain('CREATE INDEX [ix_plain] ON [dbo].[t_ms] ([id]);')
    expect(mssqlDetails.ddl).toContain('[comp_np] AS [id] + 1')
    expect(mssqlDetails.ddl).not.toContain('PERSISTED')

    const oraEdgeQ: QueryExecutor = async (sql) => {
      if (sql.includes('FROM all_users')) return []
      if (sql.includes('FROM all_objects') && !sql.includes('object_name =')) {
        return [
          { kind: 'table', owner: '', name: 'T_DUP' },
          { object_type: 'TABLE', schema: 'SYSTEM', name: 'T_DUP' },
        ]
      }
      if (sql.includes('FROM all_objects') && sql.includes('object_name =')) {
        return [{ object_type: 'VIEW' }]
      }
      if (sql.includes('FROM all_source')) {
        return [{ text: null }, { text: 'CREATE PROCEDURE APP.P1 AS BEGIN NULL; END;' }]
      }
      if (sql.includes('FROM all_triggers')) {
        return [{ description: '', when_clause: '', trigger_body: 'BEGIN NULL; END;' }]
      }
      return []
    }
    expect((await introspectOracleSchemas(oraEdgeQ, 'fallback_user')).schemas).toEqual(['FALLBACK_USER'])
    expect(await introspectOracleObjects(oraEdgeQ, '')).toHaveLength(1)
    expect((await introspectOracleTableDetails(oraEdgeQ, 'V_ORA', '')).kind).toBe('view')
    expect(await introspectOracleObjectDdl(oraEdgeQ, 'P1', 'procedure', 'app')).toContain('CREATE PROCEDURE APP.P1')
    expect(await introspectOracleObjectDdl(oraEdgeQ, 'TR_MIN', 'trigger', 'app')).toContain('CREATE OR REPLACE TRIGGER "APP"."TR_MIN"\nBEGIN NULL;')

    const oraTblLowerQ: QueryExecutor = async (sql) => {
      if (sql.includes('FROM all_objects')) return [{ object_type: 'TABLE' }]
      if (sql.includes('FROM all_tab_columns')) {
        return [
          { column_name: 'C1', data_type: undefined, char_used: 'C', nullable: 'Y' },
          { column_name: 'C2', data_type: 'NUMBER', char_used: 'C', data_precision: null, nullable: 'N' },
        ]
      }
      if (sql.includes('FROM all_indexes')) {
        return [{ index_name: 'IX_ASC', uniqueness: 'NONUNIQUE', column_name: 'C1', descend: 'ASC' }]
      }
      if (sql.includes('WHERE ac.owner = :p1')) {
        return [{ constraint_name: '', column_name: 'C1', referenced_schema: 'APP', referenced_table: 'P', referenced_column: 'ID' }]
      }
      return []
    }
    const oraLowerTbl = await introspectOracleTableDetails(oraTblLowerQ, 'T_LOW', 'app')
    expect(oraLowerTbl.ddl).toContain('CREATE INDEX "APP"."IX_ASC" ON "APP"."T_LOW" ("C1");')
    expect(oraLowerTbl.ddl).toContain('CONSTRAINT "fk_ref" FOREIGN KEY')
    expect(await introspectOracleObjectDdl(oraTblLowerQ, 'V_EMPTY', 'table', 'app')).toContain('CREATE TABLE "APP"."V_EMPTY"')
    const oraEmptyTableDdl = await introspectOracleObjectDdl(
      async (sql) => (sql.includes('FROM all_objects') ? [{ object_type: 'VIEW' }] : []),
      'V_NODDL',
      'table',
      'app'
    )
    expect(oraEmptyTableDdl).toBe('')

    // 3. Schema DDL tokenizer / dependency sorting remaining edges ($tag$, unclosed $, # EOF, unclosed quote/bracket, non-word FROM/REFERENCES, missing dep nodes)
    const pgTokenEdge = assembleFullSchemaDdl({
      dialect: 'postgres',
      schemaName: 'public',
      sections: [
        {
          kind: 'table',
          name: 't_p1',
          ddl: 'CREATE TABLE t_p1 (id INT REFERENCES ;, body TEXT DEFAULT $fn$1$fn$);',
        },
        {
          kind: 'table',
          name: 't_p2',
          ddl: 'CREATE TABLE t_p2 (id INT, p INT REFERENCES t_p1(id));',
        },
        {
          kind: 'view',
          name: 'v_subq',
          ddl: 'CREATE VIEW v_subq AS SELECT $x, $fn$SELECT 1$fn$, "unclosed_id FROM (SELECT 1)',
        },
        {
          kind: 'view',
          name: 'v_unclosed_dollar',
          ddl: 'CREATE VIEW v_unclosed_dollar AS SELECT * FROM t_p1 WHERE body = $body$unclosed',
        },
      ],
      dependencies: [
        { consumer: { kind: 'view', name: 'missing_c' }, prerequisite: { kind: 'view', name: 'v_subq' } },
      ],
    })
    expect(pgTokenEdge.ddl).toContain('CREATE VIEW v_subq')

    const mysqlTokenEdge = assembleFullSchemaDdl({
      dialect: 'mysql',
      schemaName: 'app',
      sections: [
        { kind: 'view', name: 'v_hash_eof', ddl: 'CREATE VIEW `unclosed_bt AS SELECT 1; # comment eof' },
        { kind: 'view', name: 'v_hash_2', ddl: 'CREATE VIEW v_hash_2 AS # cmt\nSELECT * FROM v_hash_eof;' },
      ],
    })
    expect(mysqlTokenEdge.ddl).toContain('# comment eof')

    const singleSecDeps = assembleFullSchemaDdl({
      dialect: 'mysql',
      schemaName: 'app',
      sections: [{ kind: 'view', name: 'v_single', ddl: 'CREATE VIEW v_single AS SELECT 1;' }],
      dependencies: [{ consumer: { kind: 'view', name: 'v_single' }, prerequisite: { kind: 'view', name: 'other' } }],
    })
    expect(singleSecDeps.ddl).toContain('CREATE VIEW v_single')

    const mssqlBeginView = assembleFullSchemaDdl({
      dialect: 'mssql',
      schemaName: 'dbo',
      sections: [
        { kind: 'table', name: 't_unclosed_brk', ddl: 'CREATE TABLE [unclosed_b (id INT)' },
        { kind: 'table', name: 't_ms2', ddl: 'CREATE TABLE t_ms2 (id INT)' },
        { kind: 'view', name: 'v_begin', ddl: 'CREATE VIEW dbo.v_begin AS BEGIN SELECT 1 END' },
      ],
    })
    expect(mssqlBeginView.ddl).toContain('CREATE VIEW dbo.v_begin AS BEGIN SELECT 1 END;\nGO')

    // 4. sql-migration.ts remaining builders, drafts, trigger header rewrites & PBT
    expect(
      reconstructTableDdl(
        {
          name: 'fallback_t',
          schema: 'main',
          kind: 'table',
          columns: [
            makeColumn({ name: 'id', type: 'INTEGER', nativeType: 'INTEGER', nullable: false, isPrimaryKey: true, isAutoIncrement: true }),
            makeColumn({ name: 'c_notype', type: '', nativeType: '' }),
          ],
          primaryKey: ['id'],
          indexes: [
            { name: 'ix_empty', isUnique: false, isPrimary: false, columns: [] },
            { name: 'ix_u', isUnique: true, isPrimary: false, columns: ['c_notype'], columnSpecs: [{ name: 'c_notype', collate: 'NOCASE', desc: true }] },
          ],
          foreignKeys: [
            { constraintName: 'fk_bad', column: '', referencedTable: 'p', referencedColumn: '' },
            { constraintName: 'fk_noref', column: 'id', referencedTable: '', referencedColumn: 'id' },
          ],
          triggers: [
            { name: 'tr_blank', sql: '   ' },
            { name: 'tr_nosemi', sql: 'CREATE TRIGGER tr_nosemi AFTER INSERT ON fallback_t BEGIN SELECT 1; END' },
          ],
        },
        'sqlite'
      )
    ).toContain('PRIMARY KEY AUTOINCREMENT')

    expect(
      buildAlterTableSql(
        { kind: 'renameTable', table: 'Orders', newTableName: 'orders' },
        'sqlite'
      )
    ).toContain('RENAME TO "__datanoa_case_rename_tmp"')

    expect(
      buildAlterTableSql(
        { kind: 'renameTable', table: '__datanoa_case_rename_tmp', newTableName: '__DATANOA_CASE_RENAME_TMP' },
        'sqlite'
      )
    ).toContain('RENAME TO "__datanoa_case_rename_tmp_2"')

    const richDraft = createInitialTableDraft({
      name: 'rich_t',
      schema: 'main',
      kind: 'table',
      columns: [makeColumn({ name: 'id', type: 'INT', isPrimaryKey: true, collate: 'NOCASE' })],
      primaryKey: ['id'],
      indexes: [
        { name: 'ix_spec', isUnique: false, isPrimary: false, origin: 'c', columns: ['id'], columnSpecs: [{ name: 'id', desc: true }], onConflict: 'ABORT' },
      ],
      foreignKeys: [{ constraintName: '', column: 'id', referencedTable: 'p', referencedColumn: 'id' }],
      inboundForeignKeys: [{ fromTable: 'child', fromColumn: 'pid', toColumn: 'id' }],
      triggers: [{ name: 'tr_r', sql: 'CREATE TRIGGER tr_r AFTER INSERT ON rich_t BEGIN SELECT 1; END' }],
    })
    expect(richDraft.inboundForeignKeys).toHaveLength(1)
    expect(richDraft.triggers).toHaveLength(1)

    expect(() =>
      buildTableMigrationSql(
        makeBaseDraft({
          columns: [
            makeBaseDraft().columns[0],
            { ...makeBaseDraft().columns[1], name: 'title_new', originalName: 'title' },
          ],
          triggers: [{ name: 'tr_colref', sql: 'CREATE TRIGGER tr_colref AFTER UPDATE OF title ON orders BEGIN SELECT NEW.title; END' }],
        }),
        'sqlite'
      )
    ).toThrow(/renamed or dropped column/i)

    const mssqlDefOnlySql = buildTableMigrationSql(
      makeBaseDraft({
        columns: [
          makeBaseDraft().columns[0],
          { ...makeBaseDraft().columns[1], defaultValue: "'abc'" },
        ],
      }),
      'mssql'
    )
    expect(mssqlDefOnlySql.some((s) => s.includes("ADD CONSTRAINT"))).toBe(true)

    const pgDropPkSql = buildTableMigrationSql(
      makeBaseDraft({
        columns: [
          { ...makeBaseDraft().columns[0], status: 'deleted' },
          makeBaseDraft().columns[1],
        ],
      }),
      'postgres'
    )
    expect(pgDropPkSql.some((s) => s.includes('DROP CONSTRAINT'))).toBe(true)

    expect(buildAlterTableSql({ kind: 'addColumn', table: 't', columnName: 'c_def', nullable: true }, 'postgres')).toBe(
      'ALTER TABLE "t" ADD COLUMN "c_def" TEXT;'
    )
    expect(buildAlterTableSql({ kind: 'renameColumn', table: 't', oldColumnName: 'a', newName: 'b' }, 'postgres')).toBe(
      'ALTER TABLE "t" RENAME COLUMN "a" TO "b";'
    )
    expect(() => buildAlterTableSql({ kind: 'renameColumn', table: 't', oldColumnName: 'a' }, 'postgres')).toThrow(/New column name/i)
    expect(
      buildAlterTableSql({ kind: 'alterColumn', table: 't', columnName: 'c', dataType: 'INT', nullable: false, defaultValue: '' }, 'mysql')
    ).toBe('ALTER TABLE `t` MODIFY COLUMN `c` INT NOT NULL;')
    expect(
      buildAlterTableSql({ kind: 'alterColumn', table: 't', columnName: '---', dataType: 'INT', defaultValue: '0' }, 'mssql')
    ).toContain('DEFAULT 0 FOR [---]')
    expect(() => buildAlterTableSql({ kind: 'addIndex', table: 't', indexName: 'ix', columns: undefined }, 'postgres')).toThrow(/at least one column/i)
    expect(() =>
      buildAlterTableSql({ kind: 'addForeignKey', table: 't', column: 'a', foreignTable: undefined, foreignColumn: undefined }, 'postgres')
    ).toThrow(/target table, and target column/i)

    // createInitialTableDraft fallbacks (missing arrays, isGenerated, empty FK ref fields)
    const minDraft = createInitialTableDraft({
      name: 'gen_t',
      schema: 'main',
      kind: 'table',
      columns: [makeColumn({ name: 'g', type: 'INT', isGenerated: true })],
      primaryKey: [],
      indexes: [{ name: 'ix', isUnique: false, isPrimary: false, columns: undefined as unknown as string[] }],
      foreignKeys: [{ constraintName: 'fk', column: 'g', referencedTable: '', referencedColumn: '' }],
    })
    expect(minDraft.columns[0].isGenerated).toBe(true)
    expect(minDraft.foreignKeys[0].foreignColumn).toBe('id')
    const emptyArrayDraft = createInitialTableDraft({
      name: 'empty_arr',
      schema: 'main',
      kind: 'table',
      columns: undefined as unknown as ColumnInfo[],
      primaryKey: [],
      indexes: undefined as unknown as TableDetails['indexes'],
      foreignKeys: undefined as unknown as TableDetails['foreignKeys'],
    })
    expect(emptyArrayDraft.columns).toEqual([])

    // isDraftColumnDirty & requiresSqliteTableRebuild catch & non-existing col branches
    expect(
      isDraftColumnDirty({
        id: 'n1',
        name: 'new_c',
        dataType: 'TEXT',
        nullable: true,
        defaultValue: '',
        isPrimaryKey: false,
        status: 'new',
      })
    ).toBe(true)
    expect(
      isDraftColumnDirty({
        id: 'e_baddef',
        name: undefined as unknown as string,
        originalName: undefined,
        dataType: undefined as unknown as string,
        originalDataType: undefined,
        nullable: true,
        originalNullable: true,
        defaultValue: '; DROP TABLE x',
        originalDefaultValue: '1',
        isPrimaryKey: false,
        originalIsPrimaryKey: false,
        status: 'existing',
      })
    ).toBe(true)
    expect(
      requiresSqliteTableRebuild(
        makeBaseDraft({
          columns: [
            {
              ...makeBaseDraft().columns[0],
              defaultValue: '; DROP TABLE x',
              originalDefaultValue: '1',
              dataType: undefined as unknown as string,
              originalDataType: undefined,
            },
          ],
        })
      )
    ).toBe(true)

    // buildTableMigrationSql all-deleted error + SQLite rename with trigger header variants ([escaped]]bracket], no BEGIN, non-matching target, qualified target) + bad FK in rebuild
    expect(() =>
      buildTableMigrationSql(
        makeBaseDraft({
          columns: makeBaseDraft().columns.map((c) => ({ ...c, status: 'deleted' as const })),
        }),
        'postgres'
      )
    ).toThrow(/at least one active column/i)

    const sqliteTrgRewriteSql = buildTableMigrationSql(
      makeBaseDraft({
        tableName: 'orders_v2',
        columns: [
          { ...makeBaseDraft().columns[0], status: 'existing' },
          { ...makeBaseDraft().columns[1], dataType: 'TEXT', status: 'existing' },
        ],
        indexes: [
          { id: 'u1', name: 'u1', columns: ['title'], origin: 'u', unique: true, status: 'existing' },
          { id: 'u2', name: 'u2', columns: ['title'], origin: 'u', unique: true, status: 'existing' },
          { id: 'c1', name: 'c_idx', columns: ['missing_col', 'title'], unique: false, status: 'existing' },
        ],
        triggers: [
          { name: 'tr_blank', sql: '   ' },
          { name: 'tr_brk', sql: '-- lead\n/* blk */ CREATE TRIGGER [tr]]1] AFTER INSERT ON [main]."orders" WHEN NEW.id > 0 BEGIN SELECT 1; END' },
          { name: 'tr_nobegin', sql: 'CREATE TRIGGER `tr_bt` AFTER UPDATE OF [col]]x] ON "orders" FOR EACH ROW SELECT 1;' },
        ],
      }),
      'sqlite'
    )
    expect(sqliteTrgRewriteSql.some((s) => s.includes('"orders_v2" WHEN'))).toBe(true)
    expect(sqliteTrgRewriteSql.some((s) => s.includes('CREATE INDEX IF NOT EXISTS "c_idx"'))).toBe(true)

    expect(() =>
      buildTableMigrationSql(
        makeBaseDraft({
          columns: [
            makeBaseDraft().columns[0],
            { ...makeBaseDraft().columns[1], dataType: 'TEXT' },
          ],
          foreignKeys: [{ id: 'fk_inc', column: 'title', foreignTable: '', foreignColumn: 'id', status: 'new' }],
        }),
        'sqlite'
      )
    ).toThrow(/Foreign key requires local column/i)

    // validateTableStructureDraft missing optional props coverage
    const draftMissingOpts = validateTableStructureDraft(
      makeBaseDraft({
        tableName: '',
        originalTableName: '',
        columns: [
          {
            id: 'e1',
            name: '',
            originalName: undefined,
            dataType: '',
            originalDataType: undefined,
            nullable: true,
            originalNullable: true,
            defaultValue: '1',
            originalDefaultValue: '',
            isPrimaryKey: false,
            originalIsPrimaryKey: false,
            status: 'existing',
          },
          {
            id: 'n_bad',
            name: '',
            dataType: undefined as unknown as string,
            nullable: false,
            defaultValue: '; DROP',
            isPrimaryKey: false,
            status: 'new',
          },
        ],
        indexes: [
          { id: 'ix_d', name: 'ix_d', columns: [], unique: false, status: 'deleted' },
          { id: 'ix_n', name: 'ix_n', columns: undefined as unknown as string[], unique: false, status: 'new' },
        ],
        foreignKeys: [
          { id: 'fk_d', constraintName: undefined, column: 'c', foreignTable: 'p', foreignColumn: 'id', status: 'deleted' },
          { id: 'fk_n', column: undefined as unknown as string, foreignTable: 'p', foreignColumn: 'id', status: 'new' },
        ],
        triggers: [{ name: '', sql: 'CREATE TRIGGER tr_x AFTER INSERT ON other_tbl BEGIN SELECT 1; END' }],
      }),
      'sqlite'
    )
    expect(draftMissingOpts.valid).toBe(false)

    // Drop / Truncate validation errors + PBT over draft change counters
    expect(() => buildDropTableSql(undefined as unknown as string)).toThrow(/name is required/i)
    expect(() => buildTruncateTableSql(undefined as unknown as string)).toThrow(/name is required/i)

    fc.assert(
      fc.property(fc.stringMatching(/^[a-z][a-z0-9_]{0,10}$/), fc.boolean(), (colName, nextNull) => {
        const draft = makeBaseDraft({
          columns: [
            makeBaseDraft().columns[0],
            { ...makeBaseDraft().columns[1], name: colName, nullable: nextNull },
          ],
        })
        const expectedChanged = colName !== 'title' || !nextNull
        expect(countTableStructureChanges(draft) > 0).toBe(expectedChanged)
      }),
      { numRuns: 30 }
    )
  })
})
