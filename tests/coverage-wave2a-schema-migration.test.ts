import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import type { DatabaseDriverType, TableDetails } from '../src/protocol'
import {
  MYSQL_SCHEMA_QUERIES,
  POSTGRES_SCHEMA_QUERIES,
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
  introspectPostgresSchemaDependencies,
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

const ALL_SQL_DIALECTS: readonly DatabaseDriverType[] = [
  'sqlite',
  'libsql',
  'd1',
  'postgres',
  'cockroachdb',
  'mysql',
  'mariadb',
  'mssql',
  'oracle',
  'clickhouse',
]

function makeSqliteExecutor(db: DatabaseSync): QueryExecutor {
  return async (sql: string) => {
    const stmt = db.prepare(sql)
    return stmt.all() as Record<string, unknown>[]
  }
}

describe('Wave 2A-2b Shared schema.ts & sql-migration.ts: PBT, Live SQLite & Full Dialect Matrix', () => {
  it('covers schema.ts utilities, TableDetailsCache TTL, query templates, and PBT', async () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (raw) => {
        const sanitized = sanitizeSchemaFileName(raw)
        expect(sanitized.length).toBeGreaterThan(0)
        expect(sanitized).toMatch(/^[A-Za-z0-9_-]+$/)
      }),
      { numRuns: 50 }
    )
    expect(sanitizeSchemaFileName('path/to/my db.sqlite')).toBe('my_db_sqlite')
    expect(sanitizeSchemaFileName('///')).toBe('schema')

    expect(toSqlBool(true)).toBe(true)
    expect(toSqlBool(1)).toBe(true)
    expect(toSqlBool(1n)).toBe(true)
    expect(toSqlBool('1')).toBe(true)
    expect(toSqlBool('TRUE')).toBe(true)
    expect(toSqlBool(new Uint8Array([1]))).toBe(true)
    expect(toSqlBool(false)).toBe(false)
    expect(toSqlBool(0)).toBe(false)
    expect(toSqlBool(0n)).toBe(false)
    expect(toSqlBool('0')).toBe(false)
    expect(toSqlBool('false')).toBe(false)
    expect(toSqlBool(new Uint8Array([0]))).toBe(false)
    expect(toSqlBool(null)).toBe(false)

    // TableDetailsCache hit, explicit merge, column lookup, and expiry
    let fakeNow = 1_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => fakeNow)
    try {
      const cache = new TableDetailsCache(2)
      const sampleDetails: TableDetails = {
        name: 'items',
        schema: 'public',
        kind: 'table',
        columns: [
          { name: 'id', type: 'INTEGER', nativeType: 'int4', nullable: false, defaultValue: null, isPrimaryKey: true },
          { name: 'note', type: 'TEXT', nullable: true, defaultValue: null, isPrimaryKey: false },
        ],
        primaryKey: ['id'],
        indexes: [],
        foreignKeys: [],
      }
      expect(cache.resolveColumnTypes('public', 'public', 'items')).toBeUndefined()
      expect(cache.findColumnType('public', 'public', 'items', 'id', 'bigint')).toBe('bigint')
      cache.set(undefined, 'public', 'items', sampleDetails)
      expect(cache.get('  ', 'public', 'items')?.name).toBe('items')
      expect(cache.resolveColumnTypes('public', 'public', 'items', { extra: 'text' })).toEqual({
        id: 'int4',
        note: 'TEXT',
        extra: 'text',
      })
      expect(cache.findColumnType('public', 'public', 'items', 'id')).toBe('int4')
      expect(cache.findColumnType('public', 'public', 'items', 'missing')).toBeUndefined()
      fakeNow += 15
      expect(cache.get('public', 'public', 'items')).toBeUndefined()
      cache.set('public', 'public', 'items', sampleDetails)
      cache.clear()
      expect(cache.get('public', 'public', 'items')).toBeUndefined()
    } finally {
      nowSpy.mockRestore()
    }

    // Query builders across SQLite / Postgres / MySQL
    expect(SQLITE_SCHEMA_QUERIES.listObjectsForSchema('aux')).toContain('"aux".sqlite_master')
    expect(SQLITE_SCHEMA_QUERIES.tableInfo('t"1', 'aux')).toContain('table_xinfo("t""1")')
    expect(SQLITE_SCHEMA_QUERIES.indexInfo('idx"1', 'aux')).toContain('index_info("idx""1")')
    expect(POSTGRES_SCHEMA_QUERIES.listObjects("o'hare")).toContain("o''hare")
    expect(POSTGRES_SCHEMA_QUERIES.columns('t', 'public')).toContain('information_schema.columns')
    expect(POSTGRES_SCHEMA_QUERIES.primaryKeys('t', 'public')).toContain('PRIMARY KEY')
    expect(POSTGRES_SCHEMA_QUERIES.foreignKeys('t', 'public')).toContain('FOREIGN KEY')
    expect(POSTGRES_SCHEMA_QUERIES.indexes('t', 'public')).toContain('pg_indexes')
    expect(MYSQL_SCHEMA_QUERIES.listObjects("db'1")).toContain("db''1")
    expect(MYSQL_SCHEMA_QUERIES.columns('t', 'db')).toContain('information_schema.COLUMNS')
    expect(MYSQL_SCHEMA_QUERIES.foreignKeys('t', 'db')).toContain('KEY_COLUMN_USAGE')
    expect(MYSQL_SCHEMA_QUERIES.indexes('t', 'db')).toContain('information_schema.STATISTICS')

    // unwrapMssqlDefaultExpression edge forms
    expect(unwrapMssqlDefaultExpression(null)).toBeNull()
    expect(unwrapMssqlDefaultExpression('((0))')).toBe('0')
    expect(unwrapMssqlDefaultExpression("(N'abc')")).toBe("N'abc'")
    expect(unwrapMssqlDefaultExpression('(getdate())')).toBe('getdate()')
    expect(unwrapMssqlDefaultExpression('(1) + (2)')).toBe('(1) + (2)')
  })

  it('exercises live SQLite introspection fallbacks & full schema DDL assembly (cycles, views, dialects)', async () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`
      ATTACH DATABASE ':memory:' AS aux;
      CREATE TABLE aux.parents (id INTEGER, tenant_id INTEGER, PRIMARY KEY (id, tenant_id));
      CREATE TABLE aux.children (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        p_id INTEGER,
        p_tenant INTEGER,
        email TEXT COLLATE NOCASE UNIQUE ON CONFLICT IGNORE,
        qty INTEGER DEFAULT 1 CHECK (qty >= 0),
        FOREIGN KEY (p_id, p_tenant) REFERENCES parents (id, tenant_id) ON DELETE CASCADE ON UPDATE NO ACTION
      );
      CREATE INDEX aux.idx_children_email ON children (email COLLATE NOCASE DESC);
    `)
    const exec = makeSqliteExecutor(db)
    const auxDetails = await introspectSqliteTableDetails(exec, 'children', 'aux')
    expect(auxDetails.foreignKeys).toHaveLength(2)
    expect(auxDetails.indexes.length).toBeGreaterThanOrEqual(1)
    db.close()

    // Mock executor for SQLite omitted fk.to resolution (resolveParentPrimaryKeys) & indexXInfo->indexInfo fallback
    const mockSqliteQuery: QueryExecutor = async (sql) => {
      if (sql.includes("name = 'child'")) {
        return [{ sql: 'CREATE TABLE child (id INT PRIMARY KEY, ref_id INT REFERENCES parent)' }]
      }
      if (sql.includes('table_xinfo("child")')) {
        return [
          { cid: 0, name: 'id', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 1, hidden: 0 },
          { cid: 1, name: 'ref_id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 0, hidden: 0 },
        ]
      }
      if (sql.includes('table_xinfo("parent")')) {
        return [{ cid: 0, name: 'pid', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 1, hidden: 0 }]
      }
      if (sql.includes('table_xinfo("broken_parent")')) {
        throw new Error('no such table')
      }
      if (sql.includes('foreign_key_list("child")')) {
        return [
          { id: 0, seq: 0, table: 'parent', from: 'ref_id', to: null, on_delete: 'CASCADE', on_update: 'RESTRICT' },
          { id: 1, seq: 0, table: 'parent', from: 'ref_id', to: '', on_delete: '', on_update: '' },
          { id: 2, seq: 0, table: 'broken_parent', from: 'ref_id', to: null },
        ]
      }
      if (sql.includes('index_list("child")')) {
        return [{ seq: 0, name: 'idx_c', unique: 0, origin: 'c', partial: 0 }]
      }
      if (sql.includes('index_xinfo')) {
        throw new Error('index_xinfo unsupported')
      }
      if (sql.includes('index_info')) {
        return [{ seqno: 0, cid: 1, name: 'ref_id' }]
      }
      return []
    }
    const mockedChild = await introspectSqliteTableDetails(mockSqliteQuery, 'child')
    expect(mockedChild.foreignKeys[0].referencedColumn).toBe('pid')
    expect(mockedChild.indexes[0].columns).toEqual(['ref_id'])

    // Postgres schema dependency introspection mock
    const pgDeps = await introspectPostgresSchemaDependencies(async () => [
      { consumer_kind: 'view', consumer_name: 'v_orders', prerequisite_kind: 'table', prerequisite_name: 'orders' },
      { consumer_kind: 'view', consumer_name: 'v_orders', prerequisite_kind: 'table', prerequisite_name: 'orders' }, // dup
      { consumer_kind: 'view', consumer_name: 'v_orders', prerequisite_kind: 'view', prerequisite_name: 'v_orders' }, // self-loop
      { consumer_kind: 'unknown', consumer_name: 'x', prerequisite_kind: 'table', prerequisite_name: 'y' },
    ])
    expect(pgDeps).toHaveLength(1)

    // assembleFullSchemaDdl + extractCyclicPgForeignKeys + extractReferencedRelationsFromViewDdl + MySQL/MSSQL/Oracle/SQLite formatting
    const pgCycleExport = await collectAndAssembleSchemaDdl({
      dialect: 'postgres',
      schemaName: 'public',
      objects: [
        { name: 'a', kind: 'table', schema: 'public' },
        { name: 'b', kind: 'table', schema: 'public' },
        { name: 'b', kind: 'table', schema: 'public' }, // dup ignored
        { name: 'v_ab', kind: 'view', schema: 'public' },
        { name: 'broken_fn', kind: 'function', schema: 'public' },
      ],
      getObjectDdl: async (obj) => {
        if (obj.name === 'a') {
          return 'CREATE TABLE "a" (\n  id int PRIMARY KEY,\n  b_id int,\n  CONSTRAINT fk_ab FOREIGN KEY (b_id) REFERENCES "b"(id),\n);'
        }
        if (obj.name === 'b') {
          return 'CREATE TABLE "b" (\n  id int PRIMARY KEY,\n  a_id int,\n  FOREIGN KEY (a_id) REFERENCES "a"(id)\n);'
        }
        if (obj.name === 'v_ab') {
          return `CREATE VIEW v_ab AS
            SELECT EXTRACT(YEAR FROM a.created_at), TRIM(BOTH 'x' FROM a.code)
            FROM ONLY public.a AS aa, LATERAL db.public.b bb
            LEFT JOIN (SELECT 1) sub ON true;`
        }
        throw new Error('permission denied')
      },
      dependencies: [
        {
          consumer: { kind: 'view', name: 'v_ab' },
          prerequisite: { kind: 'table', name: 'a' },
        },
      ],
    })
    expect(pgCycleExport.objectCount).toBe(3)
    expect(pgCycleExport.ddl).toContain('Deferred Foreign Keys')
    expect(pgCycleExport.ddl).toContain('-- Failed to export function broken_fn: permission denied')

    // MySQL cyclic + DELIMITER $$ + SQLite cyclic + MSSQL GO + Oracle /
    const mysqlExport = assembleFullSchemaDdl({
      dialect: 'mysql',
      schemaName: 'appdb',
      sections: [
        { kind: 'table', name: 't1', ddl: 'CREATE TABLE t1 (id INT, t2_id INT, FOREIGN KEY (t2_id) REFERENCES t2(id))' },
        { kind: 'table', name: 't2', ddl: 'CREATE TABLE t2 (id INT, t1_id INT, FOREIGN KEY (t1_id) REFERENCES t1(id))' },
        { kind: 'procedure', name: 'p1', ddl: 'CREATE PROCEDURE p1() BEGIN SELECT 1; END;' },
      ],
    })
    expect(mysqlExport.ddl).toContain('SET FOREIGN_KEY_CHECKS = 0;')
    expect(mysqlExport.ddl).toContain('DELIMITER $$')
    expect(mysqlExport.ddl).toContain('SET FOREIGN_KEY_CHECKS = 1;')

    const sqliteCycleExport = assembleFullSchemaDdl({
      dialect: 'sqlite',
      schemaName: 'main',
      sections: [
        { kind: 'table', name: 's1', ddl: 'CREATE TABLE s1 (id INT, FOREIGN KEY (id) REFERENCES s2(id));' },
        { kind: 'table', name: 's2', ddl: 'CREATE TABLE s2 (id INT, FOREIGN KEY (id) REFERENCES s1(id));' },
        { kind: 'view', name: 'empty_v', ddl: '   ' },
      ],
    })
    expect(sqliteCycleExport.ddl).toContain('PRAGMA foreign_keys = OFF;')
    expect(sqliteCycleExport.ddl).toContain('PRAGMA foreign_keys = ON;')

    const mssqlExport = assembleFullSchemaDdl({
      dialect: 'mssql',
      schemaName: 'dbo',
      sections: [
        { kind: 'view', name: 'v_top', ddl: 'CREATE VIEW dbo.v_top AS SELECT * FROM ONLY dbo.v_base AS b, LATERAL (SELECT TRIM(BOTH FROM x)) z;' },
        { kind: 'view', name: 'v_base', ddl: 'CREATE VIEW dbo.v_base AS SELECT EXTRACT(YEAR FROM d) AS yr FROM orders AS o, users u INNER JOIN orgs ON 1=1;' },
        { kind: 'procedure', name: 'sp1', ddl: 'CREATE PROC dbo.sp1 AS SELECT 1;' },
      ],
    })
    expect(mssqlExport.ddl).toContain('\nGO\n')

    const oracleExport = assembleFullSchemaDdl({
      dialect: 'oracle',
      schemaName: 'HR',
      sections: [{ kind: 'trigger', name: 'trg1', ddl: 'CREATE TRIGGER trg1 BEFORE INSERT ON t BEGIN NULL; END;\n/' }],
    })
    expect(oracleExport.ddl).toContain('\n/\n')
  })

  it('exercises MySQL, MSSQL & Oracle schema introspection catalog edge paths via QueryExecutor mocks', async () => {
    // MySQL edge queries
    const mysqlMock: QueryExecutor = async (sql) => {
      const lowerSql = sql.toLowerCase()
      if (lowerSql.includes('select database()')) return [{ schema_name: 'app' }]
      if (lowerSql.includes('show databases')) {
        return [{ Database: 'mysql' }, { Database: 'information_schema' }, { Database: 'app' }, { Database: 'analytics' }]
      }
      if (lowerSql.includes('information_schema.tables')) {
        return [{ name: 'orders', schema: 'app', kind: 'table' }, { name: 'v_orders', schema: 'app', kind: 'view' }]
      }
      if (lowerSql.includes('information_schema.routines')) return [{ name: 'calc', kind: 'function', schema: 'app' }]
      if (lowerSql.includes('information_schema.triggers')) return [{ name: 'tr_orders', schema: 'app', kind: 'trigger', detail: 'orders' }]
      if (lowerSql.includes('show create table')) return [{ 'Create Table': 'CREATE TABLE `orders` (`id` INT)' }]
      if (lowerSql.includes('show create function')) return [{ 'Create Function': 'CREATE FUNCTION calc() RETURNS INT RETURN 1' }]
      if (lowerSql.includes('information_schema.columns')) {
        return [{ name: 'id', type: 'int(11)', native_type: 'int', nullable: 0, default_value: null, is_primary_key: 1, is_auto_increment: 1 }]
      }
      if (lowerSql.includes("constraint_name = 'primary'")) {
        return [{ column_name: 'id' }]
      }
      if (lowerSql.includes('referential_constraints')) {
        return [{ constraint_name: 'fk_u', column: 'uid', referenced_schema: 'shared', referenced_table: 'users', referenced_column: 'id', on_update: 'CASCADE', on_delete: 'SET NULL' }]
      }
      if (lowerSql.includes('information_schema.statistics')) {
        return [
          { index_name: 'PRIMARY', column_name: 'id', non_unique: 0 },
          { index_name: 'idx_u', column_name: 'uid', non_unique: 1 },
        ]
      }
      return []
    }
    expect((await introspectMysqlSchemas(mysqlMock)).schemas).toContain('analytics')
    expect((await introspectMysqlObjects(mysqlMock, 'app')).some((o) => o.kind === 'trigger')).toBe(true)
    expect((await introspectMysqlObjects(mysqlMock, '')).length).toBeGreaterThanOrEqual(2)
    expect(await introspectMysqlObjectDdl(mysqlMock, 'orders', 'table', 'app')).toContain('CREATE TABLE')
    expect(await introspectMysqlObjectDdl(mysqlMock, 'calc', 'function', 'app')).toContain('CREATE FUNCTION')
    expect((await introspectMysqlTableDetails(mysqlMock, 'orders', 'app')).primaryKey).toEqual(['id'])

    // MSSQL edge queries
    const mssqlMock: QueryExecutor = async (sql) => {
      if (sql.includes('FROM sys.schemas')) return [{ name: 'dbo', default_schema: 'dbo' }, { name: 'sales', default_schema: 'dbo' }]
      if (sql.includes('FROM sys.objects')) return [{ name: 'orders', schema: 'dbo', kind: 'table' }]
      if (sql.includes('FROM sys.types')) return [{ name: 'PhoneNum', schema: 'dbo', kind: 'type' }]
      if (sql.includes('FROM sys.columns')) {
        return [
          { name: 'id', base_type: 'int', max_length: 4, precision: 10, scale: 0, is_nullable: 0, default_value: null, is_identity: 1, is_computed: 0 },
          { name: 'price', base_type: 'decimal', max_length: 9, precision: 12, scale: 2, is_nullable: 1, default_value: '((0))', is_identity: 0, is_computed: 0 },
          { name: 'tag', base_type: 'nvarchar', max_length: -1, precision: 0, scale: 0, is_nullable: 1, default_value: "(N'ok')", is_identity: 0, is_computed: 0 },
          { name: 'bin', base_type: 'varbinary', max_length: 32, precision: 0, scale: 0, is_nullable: 1, default_value: null, is_identity: 0, is_computed: 1 },
          { name: 'ts', base_type: 'datetime2', max_length: 8, precision: 27, scale: 7, is_nullable: 1, default_value: null, is_identity: 0, is_computed: 0 },
          { name: 'ratio', base_type: 'float', max_length: 4, precision: 24, scale: 0, is_nullable: 1, default_value: null, is_identity: 0, is_computed: 0 },
        ]
      }
      if (sql.includes('i.is_primary_key = 1')) return [{ column_name: 'id' }]
      if (sql.includes('FROM sys.foreign_keys')) {
        return [{ constraint_name: 'fk_cust', column_name: 'price', referenced_table: 'customers', referenced_column: 'id', on_delete: 'CASCADE', on_update: 'NO_ACTION' }]
      }
      if (sql.includes('FROM sys.indexes')) {
        return [{ name: 'PK_orders', is_unique: 1, is_primary: 1, column_name: 'id' }]
      }
      if (sql.includes('OBJECT_DEFINITION')) return [{ definition: null }]
      if (sql.includes('sys.sql_modules')) return [{ definition: 'CREATE VIEW dbo.v_o AS SELECT 1 AS id;' }]
      return []
    }
    expect((await introspectMssqlSchemas(mssqlMock)).schemas).toEqual(['dbo', 'sales'])
    expect((await introspectMssqlObjects(mssqlMock, 'dbo')).some((o) => o.kind === 'type')).toBe(true)
    const mssqlTbl = await introspectMssqlTableDetails(mssqlMock, 'orders', 'dbo')
    expect(mssqlTbl.ddl).toContain('nvarchar(MAX)')
    expect(await introspectMssqlObjectDdl(mssqlMock, 'v_o', 'view', 'dbo')).toContain('CREATE VIEW')

    // Oracle edge queries
    const oracleMock: QueryExecutor = async (sql) => {
      if (sql.includes('DBMS_METADATA.GET_DDL')) return [{ ddl: '' }]
      if (sql.includes('all_views')) return [{ text: 'SELECT 1 FROM DUAL' }]
      if (sql.includes('all_mviews')) return [{ query: 'SELECT 2 FROM DUAL' }]
      if (sql.includes('FROM DUAL')) return [{ current_user: 'app_user' }]
      if (sql.includes('all_users')) return [{ name: 'HR' }]
      if (sql.includes('FROM all_objects')) return [{ name: 'EMP', schema: 'HR', object_type: 'TABLE' }, { name: 'V_EMP', schema: 'HR', object_type: 'VIEW' }]
      if (sql.includes('FROM all_tab_columns')) {
        return [
          { column_name: 'ID', data_type: 'NUMBER', data_length: 22, data_precision: 10, data_scale: 0, nullable: 'N', data_default: null, identity_column: 'YES' },
          { column_name: 'NAME', data_type: 'VARCHAR2', data_length: 100, char_length: 100, nullable: 'Y', data_default: "'anon'", identity_column: 'NO' },
        ]
      }
      if (sql.includes("constraint_type = 'P'")) return [{ column_name: 'ID' }]
      if (sql.includes("constraint_type = 'R'")) return [{ constraint_name: 'FK_D', column_name: 'DEPT_ID', referenced_table: 'DEPT', referenced_column: 'ID', delete_rule: 'CASCADE' }]
      if (sql.includes('FROM all_ind_columns')) return [{ index_name: 'PK_EMP', uniqueness: 'UNIQUE', column_name: 'ID', constraint_type: 'P' }]
      return []
    }
    const oraSchemas = await introspectOracleSchemas(oracleMock)
    expect(oraSchemas.defaultSchema).toBe('APP_USER')
    expect((await introspectOracleObjects(oracleMock, 'HR')).length).toBe(2)
    const oraTbl = await introspectOracleTableDetails(oracleMock, 'EMP', 'HR')
    expect(oraTbl.ddl).toContain('NUMBER(10)')
    expect(await introspectOracleObjectDdl(oracleMock, 'V_EMP', 'view', 'HR')).toContain('V_EMP')
    expect(await introspectOracleObjectDdl(oracleMock, 'MV_EMP', 'materialized_view', 'HR')).toContain('MATERIALIZED VIEW')
  })

  it('exercises sql-migration.ts across ALL 10 dialects + live SQLite 12-step FK rebuild & FK abort execution', () => {
    // Dialect-wide PBT & matrix for CREATE TABLE / TRUNCATE TABLE / DROP TABLE / ALTER TABLE
    for (const dialect of ALL_SQL_DIALECTS) {
      const createSql = buildCreateTableSql(
        {
          tableName: 'orders',
          schema: dialect === 'sqlite' ? undefined : 'app',
          columns: [
            { name: 'id', dataType: 'INTEGER', nullable: false, defaultValue: '', isPrimaryKey: true, isAutoIncrement: true },
            { name: 'title', dataType: 'VARCHAR(100)', nullable: false, defaultValue: "'none'", isPrimaryKey: false, isAutoIncrement: false },
          ],
        },
        dialect
      )
      expect(createSql).toContain('orders')

      const truncSql = buildTruncateTableSql('orders', dialect, 'app')
      expect(truncSql.length).toBeGreaterThan(0)
      expect(buildDropTableSql('orders', 'table', dialect, 'app', true)).toContain('DROP TABLE IF EXISTS')
      expect(buildDropTableSql('v_orders', 'view', dialect, 'app', false)).toContain('DROP VIEW')

      expect(buildAlterTableSql({ kind: 'addColumn', table: 'orders', schema: 'app', columnName: 'flag', dataType: 'INTEGER', nullable: false }, dialect)).toContain('orders')
      expect(buildAlterTableSql({ kind: 'renameColumn', table: 'orders', schema: 'app', oldColumnName: 'flag', newColumnName: 'status' }, dialect)).toBeTruthy()
      expect(buildAlterTableSql({ kind: 'dropColumn', table: 'orders', schema: 'app', columnName: 'status' }, dialect)).toContain('DROP COLUMN')
      expect(buildAlterTableSql({ kind: 'renameTable', table: 'orders', schema: 'app', newTableName: 'orders_v2' }, dialect)).toBeTruthy()
      expect(buildAlterTableSql({ kind: 'addIndex', table: 'orders', schema: 'app', columns: ['title'], unique: true }, dialect)).toBeTruthy()
      expect(buildAlterTableSql({ kind: 'dropIndex', table: 'orders', schema: 'app', indexName: 'idx_orders_title' }, dialect)).toBeTruthy()
      expect(buildAlterTableSql({ kind: 'addForeignKey', table: 'orders', schema: 'app', column: 'parent_id', foreignTable: 'parents', foreignColumn: 'id', onDelete: 'CASCADE', onUpdate: 'SET NULL' }, dialect)).toContain('FOREIGN KEY')
      expect(buildAlterTableSql({ kind: 'dropForeignKey', table: 'orders', schema: 'app', constraintName: 'fk_orders_parent_id_parents' }, dialect)).toContain('orders')

      if (dialect === 'postgres' || dialect === 'cockroachdb' || dialect === 'mysql' || dialect === 'mariadb' || dialect === 'mssql' || dialect === 'oracle' || dialect === 'clickhouse') {
        expect(
          buildAlterTableSql(
            { kind: 'alterColumn', table: 'orders', schema: 'app', columnName: 'title', dataType: 'VARCHAR(200)', nullable: true, defaultValue: '' },
            dialect
          )
        ).toBeTruthy()
      } else {
        expect(() =>
          buildAlterTableSql({ kind: 'alterColumn', table: 'orders', columnName: 'title', dataType: 'TEXT' }, dialect)
        ).toThrow(/atomic table rebuild/i)
      }
    }

    // Reject Redis & invalid inputs cleanly
    expect(() => buildTruncateTableSql('k', 'redis')).toThrow(/Redis/i)
    expect(() => buildDropTableSql('k', 'table', 'redis')).toThrow(/Redis/i)
    expect(() => buildCreateTableSql({ tableName: 't', columns: [] }, 'sqlite')).toThrow(/at least one column/i)
    expect(() => buildTruncateTableSql('', 'postgres')).toThrow(/required/i)
    expect(() => buildDropTableSql('bad;drop', 'table', 'postgres')).toThrow(/invalid/i)
    expect(() => buildAlterTableSql({ kind: 'addColumn', table: 't', columnName: 'c' }, 'redis')).toThrow(/Redis/i)
    expect(() => buildAlterTableSql({ kind: 'renameColumn', table: 't', oldColumnName: 'a', newColumnName: 'a' }, 'postgres')).toThrow(/different/i)
    expect(() => buildAlterTableSql({ kind: 'renameTable', table: 't', newTableName: 't' }, 'postgres')).toThrow(/different/i)

    // Non-rebuild migration sequence on PostgreSQL (drop FK -> drop idx -> drop col -> rename col -> alter col -> add col -> add idx -> add FK -> rename table)
    const pgDetails: TableDetails = {
      name: 'users',
      schema: 'public',
      kind: 'table',
      columns: [
        { name: 'id', type: 'INT', nullable: false, defaultValue: null, isPrimaryKey: true, isAutoIncrement: true },
        { name: 'name', type: 'TEXT', nullable: true, defaultValue: null, isPrimaryKey: false },
        { name: 'legacy', type: 'TEXT', nullable: true, defaultValue: null, isPrimaryKey: false },
      ],
      primaryKey: ['id'],
      indexes: [{ name: 'idx_old', columns: ['name'], isUnique: false, isPrimary: false }],
      foreignKeys: [{ constraintName: 'fk_org', column: 'org_id', referencedTable: 'orgs', referencedColumn: 'id' }],
    }
    const pgDraft = createInitialTableDraft(pgDetails)
    expect(isDraftColumnDirty(pgDraft.columns[0])).toBe(false)
    expect(countTableStructureChanges(pgDraft)).toBe(0)
    expect(buildTableMigrationSql(pgDraft, 'postgres')).toEqual([])

    pgDraft.tableName = 'members'
    pgDraft.foreignKeys[0].status = 'deleted'
    pgDraft.indexes[0].status = 'deleted'
    pgDraft.columns[2].status = 'deleted'
    pgDraft.columns[1].name = 'full_name'
    pgDraft.columns[1].nullable = false
    pgDraft.columns.push({
      id: 'new_1',
      name: 'org_id',
      dataType: 'INT',
      nullable: false,
      defaultValue: '0',
      isPrimaryKey: false,
      isAutoIncrement: false,
      status: 'new',
    })
    pgDraft.indexes.push({ id: 'idx_new', name: 'idx_members_name', columns: ['full_name'], unique: true, isPrimary: false, status: 'new' })
    pgDraft.foreignKeys.push({ id: 'fk_new', constraintName: 'fk_m_org', column: 'org_id', foreignTable: 'orgs', foreignColumn: 'id', onDelete: 'CASCADE', onUpdate: 'NO ACTION', status: 'new' })
    expect(requiresSqliteTableRebuild(pgDraft)).toBe(true)
    const pgMig = buildTableMigrationSql(pgDraft, 'postgres')
    expect(pgMig.length).toBeGreaterThanOrEqual(6)
    const valRes = validateTableStructureDraft(pgDraft, 'postgres', ['orgs'])
    expect(valRes.changeSummaries.length).toBeGreaterThan(0)
    expect(reconstructTableDdl(pgDetails, 'postgres')).toContain('CREATE TABLE')

    // Real SQLite execution: create tables -> seed rows -> run 12-step atomic rebuild with trigger rewrite + verify SQLITE_FK_CHECK_ABORT_SQL
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys = ON;')
    db.exec(
      buildCreateTableSql(
        {
          tableName: 'orgs',
          columns: [{ name: 'id', dataType: 'INTEGER', nullable: false, defaultValue: '', isPrimaryKey: true, isAutoIncrement: false }],
        },
        'sqlite'
      )
    )
    db.exec(
      buildCreateTableSql(
        {
          tableName: 'tasks',
          columns: [
            { name: 'id', dataType: 'INTEGER', nullable: false, defaultValue: '', isPrimaryKey: true, isAutoIncrement: true },
            { name: 'org_id', dataType: 'INTEGER', nullable: false, defaultValue: '1', isPrimaryKey: false, isAutoIncrement: false },
            { name: 'title', dataType: 'TEXT', nullable: true, defaultValue: '', isPrimaryKey: false, isAutoIncrement: false },
          ],
        },
        'sqlite'
      )
    )
    db.exec(`
      CREATE TRIGGER trg_tasks_audit AFTER INSERT ON "tasks" BEGIN
        UPDATE tasks SET title = COALESCE(NEW.title, 'untitled') WHERE id = NEW.id;
      END;
      INSERT INTO orgs (id) VALUES (1);
      INSERT INTO tasks (org_id, title) VALUES (1, 'First Task');
    `)

    const sqliteDraft: TableStructureDraft = {
      originalTableName: 'tasks',
      tableName: 'work_items',
      schema: 'main',
      columns: [
        { id: 'c1', originalName: 'id', name: 'id', dataType: 'INTEGER', originalDataType: 'INTEGER', nullable: false, originalNullable: false, defaultValue: '', originalDefaultValue: '', isPrimaryKey: true, originalIsPrimaryKey: true, isAutoIncrement: true, status: 'existing' },
        { id: 'c2', originalName: 'org_id', name: 'org_id', dataType: 'INTEGER', originalDataType: 'INTEGER', nullable: false, originalNullable: false, defaultValue: '1', originalDefaultValue: '1', isPrimaryKey: false, originalIsPrimaryKey: false, isAutoIncrement: false, status: 'existing' },
        { id: 'c3', originalName: 'title', name: 'summary', dataType: 'TEXT', originalDataType: 'TEXT', nullable: false, originalNullable: true, defaultValue: "'item'", originalDefaultValue: '', isPrimaryKey: false, originalIsPrimaryKey: false, isAutoIncrement: false, status: 'existing' },
      ],
      indexes: [
        { id: 'i1', name: 'idx_work_summary', columns: ['summary'], unique: false, isPrimary: false, status: 'new' },
      ],
      foreignKeys: [
        { id: 'f1', constraintName: 'fk_org', column: 'org_id', foreignTable: 'orgs', foreignColumn: 'id', onDelete: 'CASCADE', onUpdate: 'NO ACTION', status: 'new' },
      ],
      triggers: [
        {
          name: 'trg_tasks_audit',
          sql: 'CREATE TRIGGER trg_tasks_audit AFTER INSERT ON "tasks" BEGIN UPDATE work_items SET summary = COALESCE(NEW.summary, \'untitled\') WHERE id = NEW.id; END',
        },
      ],
    }

    const sqliteRebuildStmts = buildTableMigrationSql(sqliteDraft, 'sqlite')
    for (const stmt of sqliteRebuildStmts) {
      db.exec(stmt)
    }
    const migratedRows = db.prepare('SELECT id, org_id, summary FROM work_items').all() as Array<Record<string, unknown>>
    expect(migratedRows).toEqual([{ id: 1, org_id: 1, summary: 'First Task' }])

    // Verify SQLITE_FK_CHECK_ABORT_SQL actually aborts when an FK violation exists
    db.exec('PRAGMA foreign_keys = OFF; INSERT INTO work_items (id, org_id, summary) VALUES (2, 999, \'Orphan\');')
    expect(() => db.exec(SQLITE_FK_CHECK_ABORT_SQL)).toThrow(/__datanoa_fk_violation__/i)

    db.exec('DELETE FROM work_items WHERE id = 2;')
    db.exec(buildTruncateTableSql('work_items', 'sqlite'))
    expect(db.prepare('SELECT COUNT(*) AS c FROM work_items').get()).toEqual({ c: 0 })
    db.exec(buildDropTableSql('work_items', 'table', 'sqlite', undefined, true))
    db.close()

    // PBT on validateTableStructureDraft edge errors
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z]{3,10}$/), (tbl) => {
        const draft = createInitialTableDraft({
          name: tbl,
          kind: 'table',
          columns: [{ name: 'id', type: 'INT', nullable: false, defaultValue: null, isPrimaryKey: true }],
          primaryKey: ['id'],
          indexes: [],
          foreignKeys: [],
        })
        const res = validateTableStructureDraft(draft, 'sqlite')
        expect(res.errors).toEqual([])
      }),
      { numRuns: 20 }
    )
  })
})
