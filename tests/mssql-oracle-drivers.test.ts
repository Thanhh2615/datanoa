import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ConnectionProfile } from '../src/protocol'
import {
  buildMssqlPoolConfig,
  MssqlDriver,
  MssqlSession,
  splitMssqlBatches,
  type MssqlPoolLike,
  type MssqlRequestLike,
  type MssqlTransactionLike,
} from '../src/drivers/mssql/driver'
import {
  buildOracleConnectionConfig,
  OracleDriver,
  OracleSession,
  splitOracleStatements,
  type OracleConnectionLike,
} from '../src/drivers/oracle/driver'
import { parseConnectionUri } from '../src/drivers/common/connection-uri'
import {
  buildBatchStatements,
  buildDeleteStatement,
  buildInsertStatement,
  buildSelectPageSql,
  buildUpdateSql,
  formatSqlValue,
  makePlaceholder,
  quoteQualifiedTable,
} from '../src/drivers/common/update-builder'
import {
  buildAlterTableSql,
  buildCreateTableSql,
  reconstructTableDdl,
} from '../src/drivers/common/sql-migration'

describe('MSSQL & Oracle update-builder and DDL generation', () => {
  it('generates dialect-specific placeholders, quoting, literals, and OFFSET/FETCH pagination', () => {
    expect(makePlaceholder('mssql', 1)).toBe('@p1')
    expect(makePlaceholder('oracle', 3)).toBe(':p3')
    expect(quoteQualifiedTable('orders', 'dbo', 'mssql')).toBe('[dbo].[orders]')
    expect(quoteQualifiedTable('EMPLOYEES', 'HR', 'oracle')).toBe('"HR"."EMPLOYEES"')

    expect(formatSqlValue(true, 'mssql')).toBe('1')
    expect(formatSqlValue(false, 'mssql')).toBe('0')
    expect(formatSqlValue(Buffer.from([0xde, 0xad, 0xbe, 0xef]), 'mssql')).toBe('0xdeadbeef')
    expect(formatSqlValue(Buffer.from([0xde, 0xad, 0xbe, 0xef]), 'oracle')).toBe(
      "HEXTORAW('deadbeef')"
    )

    const mssqlNoOrder = buildSelectPageSql({
      driver: 'mssql',
      table: 'audit_logs',
      schema: 'dbo',
      page: 2,
      pageSize: 25,
    })
    expect(mssqlNoOrder.sql).toBe(
      'SELECT * FROM [dbo].[audit_logs] ORDER BY (SELECT NULL) OFFSET @p1 ROWS FETCH NEXT @p2 ROWS ONLY;'
    )
    expect(mssqlNoOrder.countSql).toBe('SELECT COUNT(*) AS total FROM [dbo].[audit_logs];')
    expect(mssqlNoOrder.params).toEqual([25, 25])

    const mssqlSorted = buildSelectPageSql({
      driver: 'mssql',
      table: 'audit_logs',
      schema: 'dbo',
      page: 3,
      pageSize: 50,
      sortColumn: 'created_at',
      sortDirection: 'DESC',
      whereClause: "status = 'open'",
    })
    expect(mssqlSorted.sql).toBe(
      "SELECT * FROM [dbo].[audit_logs] WHERE status = 'open' ORDER BY [created_at] DESC OFFSET @p1 ROWS FETCH NEXT @p2 ROWS ONLY;"
    )
    expect(mssqlSorted.params).toEqual([100, 50])

    const oracleNoOrder = buildSelectPageSql({
      driver: 'oracle',
      table: 'EMPLOYEES',
      schema: 'HR',
      page: 2,
      pageSize: 10,
    })
    expect(oracleNoOrder.sql).toBe(
      'SELECT * FROM "HR"."EMPLOYEES" OFFSET :p1 ROWS FETCH NEXT :p2 ROWS ONLY;'
    )
    expect(oracleNoOrder.params).toEqual([10, 10])

    const oracleSorted = buildSelectPageSql({
      driver: 'oracle',
      table: 'EMPLOYEES',
      schema: 'HR',
      page: 1,
      pageSize: 20,
      primaryKey: ['EMPLOYEE_ID'],
    })
    expect(oracleSorted.sql).toBe(
      'SELECT * FROM "HR"."EMPLOYEES" ORDER BY "EMPLOYEE_ID" ASC OFFSET :p1 ROWS FETCH NEXT :p2 ROWS ONLY;'
    )
    expect(oracleSorted.params).toEqual([0, 20])
  })

  it('generates parameterized INSERT/UPDATE/DELETE and ALTER/CREATE DDL for MSSQL and Oracle', () => {
    const mssqlUpd = buildUpdateSql({
      driver: 'mssql',
      table: 'users',
      schema: 'dbo',
      column: 'active',
      newValue: false,
      primaryKeys: { id: 7 },
      originalValue: true,
    })
    expect(mssqlUpd.sql).toBe(
      'UPDATE [dbo].[users] SET [active] = @p1 WHERE [id] = @p2 AND [active] = @p3'
    )
    expect(mssqlUpd.params).toEqual([false, 7, true])

    const oracleIns = buildInsertStatement({
      driver: 'oracle',
      table: 'USERS',
      schema: 'APP',
      row: { ID: 1, EMAIL: 'a@b.com' },
    })
    expect(oracleIns.sql).toBe('INSERT INTO "APP"."USERS" ("ID", "EMAIL") VALUES (:p1, :p2)')
    expect(oracleIns.params).toEqual([1, 'a@b.com'])

    const oracleDel = buildDeleteStatement({
      driver: 'oracle',
      table: 'USERS',
      schema: 'APP',
      primaryKeys: { ID: 1 },
    })
    expect(oracleDel.sql).toBe('DELETE FROM "APP"."USERS" WHERE "ID" = :p1')
    expect(oracleDel.params).toEqual([1])

    const batchMssql = buildBatchStatements({
      driver: 'mssql',
      table: 'users',
      schema: 'dbo',
      inserts: [{ id: 1, active: true }],
    })
    expect(batchMssql.previewStatements).toEqual([
      'INSERT INTO [dbo].[users] ([id], [active]) VALUES (1, 1);',
    ])

    expect(
      buildAlterTableSql(
        {
          kind: 'addColumn',
          table: 'users',
          schema: 'dbo',
          columnName: 'role',
          dataType: 'NVARCHAR(32)',
          nullable: false,
          defaultValue: "'member'",
        },
        'mssql'
      )
    ).toBe("ALTER TABLE [dbo].[users] ADD [role] NVARCHAR(32) NOT NULL DEFAULT 'member';")

    expect(
      buildAlterTableSql(
        {
          kind: 'renameTable',
          table: 'users',
          schema: 'dbo',
          newTableName: 'accounts',
        },
        'mssql'
      )
    ).toBe("EXEC sp_rename '[dbo].[users]', 'accounts';")

    expect(
      buildAlterTableSql(
        {
          kind: 'addColumn',
          table: 'USERS',
          schema: 'HR',
          columnName: 'ROLE',
          dataType: 'VARCHAR2(32)',
          nullable: false,
          defaultValue: "'member'",
        },
        'oracle'
      )
    ).toBe('ALTER TABLE "HR"."USERS" ADD ("ROLE" VARCHAR2(32) DEFAULT \'member\' NOT NULL);')

    const oracleCreate = buildCreateTableSql(
      {
        tableName: 'USERS',
        schema: 'HR',
        columns: [
          { name: 'ID', dataType: 'NUMBER', isPrimaryKey: true, isAutoIncrement: true, nullable: false },
          { name: 'ROLE', dataType: 'VARCHAR2(20)', defaultValue: "'user'", nullable: false },
        ],
      },
      'oracle'
    )
    expect(oracleCreate).toContain('"ID" NUMBER GENERATED BY DEFAULT AS IDENTITY NOT NULL')
    expect(oracleCreate).toContain('"ROLE" VARCHAR2(20) DEFAULT \'user\' NOT NULL')

    const mssqlReconstructed = reconstructTableDdl(
      {
        name: 'orders',
        schema: 'dbo',
        kind: 'table',
        primaryKey: ['id'],
        columns: [
          {
            name: 'id',
            type: 'int',
            nativeType: 'int',
            nullable: false,
            defaultValue: null,
            isPrimaryKey: true,
            isAutoIncrement: true,
          },
        ],
        indexes: [],
        foreignKeys: [],
      },
      'mssql'
    )
    expect(mssqlReconstructed).toContain('[id] int IDENTITY(1,1) NOT NULL')
  })
})

function createMockMssqlHarness() {
  const executed: Array<{
    sql: string
    inputs: Record<string, unknown>
    inTx: boolean
    arrayRowMode: boolean
  }> = []
  const txEvents: string[] = []
  let cancelCalled = false
  type MockMssqlResult = {
    recordset?: unknown[]
    recordsets?: unknown[][]
    rowsAffected?: number[]
  }
  let nextResultHandler: ((
    sql: string,
    inputs: Record<string, unknown>,
    arrayRowMode: boolean
  ) => MockMssqlResult | Promise<MockMssqlResult>) | null = null

  const makeRequest = (inTx: boolean): MssqlRequestLike => {
    const inputs: Record<string, unknown> = {}
    const req: MssqlRequestLike = {
      arrayRowMode: false,
      input(name: string, typeOrVal: unknown, maybeVal?: unknown) {
        inputs[name] = arguments.length >= 3 ? maybeVal : typeOrVal
        return req
      },
      async query(sql: string) {
        executed.push({
          sql,
          inputs: { ...inputs },
          inTx,
          arrayRowMode: Boolean(req.arrayRowMode),
        })
        if (nextResultHandler) {
          const res = await nextResultHandler(sql, inputs, Boolean(req.arrayRowMode))
          return {
            recordset: res.recordset ?? res.recordsets?.[0] ?? [],
            recordsets: res.recordsets ?? (res.recordset ? [res.recordset] : []),
            rowsAffected: res.rowsAffected ?? [0],
          }
        }
        return { recordset: [], recordsets: [], rowsAffected: [0] }
      },
      cancel() {
        cancelCalled = true
      },
    }
    return req
  }

  const pool: MssqlPoolLike = {
    connected: true,
    on: vi.fn(),
    connect: vi.fn(async () => pool),
    close: vi.fn(async () => {
      pool.connected = false
    }),
    request: () => makeRequest(false),
    transaction: () => {
      const tx: MssqlTransactionLike = {
        begin: vi.fn(async () => {
          txEvents.push('begin')
        }),
        commit: vi.fn(async () => {
          txEvents.push('commit')
        }),
        rollback: vi.fn(async () => {
          txEvents.push('rollback')
        }),
        request: () => makeRequest(true),
      }
      return tx
    },
  }

  return {
    pool,
    executed,
    txEvents,
    wasCancelled: () => cancelCalled,
    setHandler(fn: NonNullable<typeof nextResultHandler>) {
      nextResultHandler = fn
    },
  }
}

describe('MssqlDriver & MssqlSession', () => {
  const baseProfile: ConnectionProfile = {
    id: 'mssql_1',
    name: 'SQL Server Test',
    driver: 'mssql',
    host: 'localhost',
    port: 1433,
    user: 'sa',
    database: 'appdb',
  }

  it('splits GO batches ignoring quotes/comments and enforces readOnly + serializes BigInt/Date/Buffer + multi-recordset', async () => {
    const batches = splitMssqlBatches(`
      SELECT 'GO' AS txt, [GO] AS col;
      -- GO in line comment
      /*
      GO in block comment
      */
      GO
      SELECT 1 AS a;
      SELECT 2 AS b;
      GO 2
    `)
    expect(batches).toHaveLength(3)
    expect(batches[0]).toContain("SELECT 'GO' AS txt")
    expect(batches[1]).toContain('SELECT 1 AS a')
    expect(batches[2]).toContain('SELECT 2 AS b')

    const harness = createMockMssqlHarness()
    const rs1 = Object.assign(
      [[9007199254740993n, new Date('2025-01-02T03:04:05.000Z'), Buffer.from([1, 2, 3])]],
      {
        columns: [
          { name: 'big_id', type: { name: 'BigInt' } },
          { name: 'created_at', type: { name: 'DateTime2' } },
          { name: 'payload', type: { name: 'VarBinary' } },
        ],
      }
    )
    const rs2 = Object.assign([[42]], {
      columns: [{ name: 'ok', type: { name: 'Int' } }],
    })
    harness.setHandler(() => ({
      recordsets: [rs1, rs2],
      rowsAffected: [1, 1],
    }))

    const session = new MssqlSession(harness.pool, baseProfile)
    const res = await session.runQuery('q1', 'SELECT * FROM t1; SELECT 42 AS ok;')
    expect(res.resultSets).toHaveLength(2)
    expect(res.resultSets?.[0].columns.map((c) => c.name)).toEqual([
      'big_id',
      'created_at',
      'payload',
    ])
    expect(res.resultSets?.[0].rows).toEqual([
      ['9007199254740993', '2025-01-02T03:04:05.000Z', '[BLOB 3 B]'],
    ])
    expect(res.resultSets?.[1].rows).toEqual([[42]])

    const roSession = new MssqlSession(harness.pool, { ...baseProfile, readOnly: true })
    await expect(roSession.runQuery('q_ro', 'DELETE FROM users WHERE id = 1;')).rejects.toMatchObject({
      code: 'read_only',
    })
    await expect(
      roSession.runQuery('q_ro_into', 'SELECT * INTO #tmp FROM users;')
    ).rejects.toMatchObject({ code: 'read_only' })
  })

  it('introspects schemas, objects, table details (identity, computed, defaults, DESC/included indexes, outbound & inbound FKs, triggers) and DDL', async () => {
    const harness = createMockMssqlHarness()
    harness.setHandler((sql, inputs) => {
      if (sql.includes('FROM sys.schemas')) {
        return {
          recordset: [
            { name: 'dbo', default_schema: 'dbo' },
            { name: 'sales', default_schema: 'dbo' },
          ],
        }
      }
      if (sql.includes('FROM sys.objects') && sql.includes('o.type IN')) {
        if (sql.includes('WHERE s.name = @p1 AND o.name = @p2')) {
          return { recordset: [{ obj_type: 'U', object_id: 100 }] }
        }
        return {
          recordset: [
            { name: 'orders', schema: 'dbo', kind: 'table', detail: null },
            { name: 'v_orders', schema: 'dbo', kind: 'view', detail: null },
            { name: 'usp_sync', schema: 'dbo', kind: 'procedure', detail: null },
            { name: 'fn_tax', schema: 'dbo', kind: 'function', detail: null },
            { name: 'tr_orders_audit', schema: 'dbo', kind: 'trigger', detail: 'orders' },
            { name: 'seq_order_no', schema: 'dbo', kind: 'sequence', detail: null },
          ],
        }
      }
      if (sql.includes('FROM sys.types') && sql.includes('is_user_defined = 1')) {
        return { recordset: [{ name: 'MoneyAmount', schema: 'dbo', kind: 'type' }] }
      }
      if (sql.includes('FROM sys.columns')) {
        return {
          recordset: [
            {
              name: 'id',
              base_type: 'int',
              system_type: 'int',
              max_length: 4,
              precision: 10,
              scale: 0,
              is_nullable: false,
              is_identity: true,
              is_computed: false,
              default_value: null,
              computed_definition: null,
            },
            {
              name: 'code',
              base_type: 'nvarchar',
              system_type: 'nvarchar',
              max_length: 100,
              precision: 0,
              scale: 0,
              is_nullable: false,
              is_identity: false,
              is_computed: false,
              default_value: "('NEW')",
              computed_definition: null,
            },
            {
              name: 'total_cents',
              base_type: 'bigint',
              system_type: 'bigint',
              max_length: 8,
              precision: 19,
              scale: 0,
              is_nullable: true,
              is_identity: false,
              is_computed: true,
              default_value: null,
              computed_definition: '([qty]*(100))',
              is_persisted: true,
            },
          ],
        }
      }
      if (sql.includes('FROM sys.indexes')) {
        return {
          recordset: [
            {
              index_name: 'PK_orders',
              is_unique: true,
              is_primary_key: true,
              is_unique_constraint: false,
              column_name: 'id',
              is_descending_key: false,
              is_included_column: false,
            },
            {
              index_name: 'IX_orders_code',
              is_unique: true,
              is_primary_key: false,
              is_unique_constraint: false,
              column_name: 'code',
              is_descending_key: true,
              is_included_column: false,
            },
            {
              index_name: 'IX_orders_code',
              is_unique: true,
              is_primary_key: false,
              is_unique_constraint: false,
              column_name: 'total_cents',
              is_descending_key: false,
              is_included_column: true,
            },
          ],
        }
      }
      if (sql.includes('FROM sys.foreign_keys') && sql.includes('ps.name = @p1 AND pt.name = @p2')) {
        return {
          recordset: [
            {
              constraint_name: 'FK_orders_customer',
              column_name: 'customer_id',
              referenced_schema: 'dbo',
              referenced_table: 'customers',
              referenced_column: 'id',
              on_delete: 'CASCADE',
              on_update: 'NO_ACTION',
            },
          ],
        }
      }
      if (sql.includes('FROM sys.foreign_keys') && sql.includes('rs.name = @p1 AND rt.name = @p2')) {
        return {
          recordset: [
            {
              from_table: 'order_items',
              from_column: 'order_id',
              to_column: 'id',
              on_delete: 'CASCADE',
            },
          ],
        }
      }
      if (sql.includes('FROM sys.triggers')) {
        return {
          recordset: [
            {
              name: 'tr_orders_audit',
              sql: 'CREATE TRIGGER [dbo].[tr_orders_audit] ON [dbo].[orders] AFTER INSERT AS BEGIN SET NOCOUNT ON; END',
            },
          ],
        }
      }
      if (sql.includes('OBJECT_DEFINITION(OBJECT_ID(')) {
        return {
          recordset: [
            { definition: `CREATE PROCEDURE ${String(inputs.p1)} AS BEGIN SELECT 1; END` },
          ],
        }
      }
      if (sql.includes('FROM sys.sequences sq')) {
        return {
          recordset: [
            {
              data_type: 'bigint',
              start_value: 1,
              increment_by: 1,
              min_value: 1,
              max_value: 999999,
              is_cycling: 0,
            },
          ],
        }
      }
      if (sql.includes('t.is_user_defined = 1')) {
        return {
          recordset: [
            {
              is_table_type: 0,
              base_type: 'decimal',
              max_length: 9,
              precision: 18,
              scale: 4,
              is_nullable: 0,
            },
          ],
        }
      }
      return { recordset: [] }
    })

    const session = new MssqlSession(harness.pool, baseProfile)
    const schemas = await session.listSchemas()
    expect(schemas.defaultSchema).toBe('dbo')
    expect(schemas.schemas).toEqual(['dbo', 'sales'])

    const objs = await session.listObjects('dbo')
    expect(objs.map((o) => `${o.kind}:${o.name}`)).toEqual([
      'function:fn_tax',
      'type:MoneyAmount',
      'table:orders',
      'sequence:seq_order_no',
      'trigger:tr_orders_audit',
      'procedure:usp_sync',
      'view:v_orders',
    ])

    const details = await session.getTableDetails('orders', 'dbo')
    expect(details.primaryKey).toEqual(['id'])
    expect(details.columns[0].isAutoIncrement).toBe(true)
    expect(details.columns[1].type).toBe('nvarchar(50)')
    expect(details.columns[1].defaultValue).toBe("'NEW'")
    expect(details.columns[2].isGenerated).toBe(true)
    expect(details.indexes.find((i) => i.name === 'IX_orders_code')?.columnSpecs).toEqual([
      { name: 'code', desc: true },
    ])
    expect(details.foreignKeys[0]).toMatchObject({
      constraintName: 'FK_orders_customer',
      referencedTable: 'customers',
      onDelete: 'CASCADE',
    })
    expect(details.inboundForeignKeys).toEqual([
      { fromTable: 'order_items', fromColumn: 'order_id', toColumn: 'id', onDelete: 'CASCADE' },
    ])
    expect(details.ddl).toContain('INCLUDE ([total_cents])')
    expect(details.ddl).toContain('AS ([qty]*(100)) PERSISTED')

    const procDdl = await session.getObjectDdl('usp_sync', 'procedure', 'dbo')
    expect(procDdl).toContain('CREATE PROCEDURE [dbo].[usp_sync]')

    const schemaDdl = await session.exportSchemaDdl('dbo')
    expect(schemaDdl.objectCount).toBe(7)
    expect(schemaDdl.ddl).toContain('CREATE TABLE [dbo].[orders]')
    expect(schemaDdl.ddl).toContain('CREATE PROCEDURE [dbo].[usp_sync]')
    expect(schemaDdl.ddl).toContain('GO')
  })

  it('handles optimistic updateCell tx guard, transactional applyChanges with deleteRows, query cancellation, and manual transactions', async () => {
    const harness = createMockMssqlHarness()
    let updateAffected = 1
    harness.setHandler((sql) => {
      if (sql.startsWith('UPDATE ')) {
        return { rowsAffected: [updateAffected] }
      }
      if (sql.startsWith('DELETE ')) {
        return { rowsAffected: [1] }
      }
      if (sql.startsWith('INSERT ')) {
        return { rowsAffected: [1] }
      }
      if (sql.startsWith('SELECT * FROM [dbo].[users] WHERE')) {
        return { recordset: [{ id: 1, name: 'Updated' }] }
      }
      return { recordset: [] }
    })

    const session = new MssqlSession(harness.pool, baseProfile)

    const updated = await session.updateCell({
      table: 'users',
      schema: 'dbo',
      primaryKeys: { id: 1 },
      column: 'name',
      newValue: 'Updated',
      originalValue: 'Old',
    })
    expect(updated.ok).toBe(true)
    expect(updated.affectedRows).toBe(1)
    expect(updated.updatedRecord).toEqual({ id: 1, name: 'Updated' })
    expect(harness.txEvents).toEqual(['begin', 'commit'])

    // Conflict when 0 or >1 rows affected rolls back tx
    updateAffected = 2
    harness.txEvents.length = 0
    await expect(
      session.updateCell({
        table: 'users',
        schema: 'dbo',
        primaryKeys: { id: 1 },
        column: 'name',
        newValue: 'Updated',
      })
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(harness.txEvents).toEqual(['begin', 'rollback'])

    // applyChanges supporting deleteRows when deletes omitted
    updateAffected = 1
    harness.txEvents.length = 0
    const applied = await session.applyChanges({
      table: 'users',
      schema: 'dbo',
      deleteRows: [{ id: 9 }],
      updates: [{ primaryKeys: { id: 1 }, changes: { name: 'Alice' }, originalRow: { name: 'Bob' } }],
      inserts: [{ id: 2, name: 'NewUser' }],
    })
    expect(applied).toMatchObject({ ok: true, deleted: 1, updated: 1, inserted: 1 })
    expect(harness.txEvents).toEqual(['begin', 'commit'])

    // Manual transaction lifecycle
    await session.beginTransaction()
    expect(session.getTransactionState().active).toBe(true)
    await session.setAutoCommit(false)
    await expect(session.setAutoCommit(true)).rejects.toMatchObject({ code: 'TX_ACTIVE' })
    await session.runQuery('q_tx', 'UPDATE [dbo].[users] SET [name] = @p1;')
    expect(session.getTransactionState().statementCount).toBe(1)
    await session.commitTransaction()
    expect(session.getTransactionState().active).toBe(false)
    await session.setAutoCommit(true)

    // Cancel running query
    let releaseSlow: () => void = () => {}
    harness.setHandler(
      () =>
        new Promise((resolve) => {
          releaseSlow = () => resolve({ recordset: [], rowsAffected: [0] })
        })
    )
    const slowPromise = session.runQuery('q_slow', 'WAITFOR DELAY \'00:00:10\';')
    await Promise.resolve()
    const cancelRes = await session.cancelQuery('q_slow')
    expect(cancelRes.ok).toBe(true)
    expect(harness.wasCancelled()).toBe(true)
    releaseSlow()
    await expect(slowPromise).rejects.toMatchObject({ code: 'cancelled' })

    // fetchPage pagination with ORDER BY + params
    harness.setHandler((sql) => {
      if (sql.includes('COUNT(*)')) return { recordset: [{ total: 2 }] }
      if (sql.includes('OFFSET @p1 ROWS FETCH NEXT @p2 ROWS ONLY')) {
        return { recordset: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }] }
      }
      return { recordset: [] }
    })
    const page = await session.fetchPage({
      table: 'users',
      schema: 'dbo',
      page: 1,
      pageSize: 50,
      primaryKey: 'id',
    })
    expect(page.totalRows).toBe(2)
    expect(page.rows).toEqual([
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
    ])
    await session.close()
  })

  it('builds MSSQL ConnectionPool with resolved TLS options and profile.url parsing', async () => {
    expect(typeof MssqlDriver).toBe('function')

    const disabledCfg = await buildMssqlPoolConfig({
      id: 'm_disabled',
      name: 'Local MSSQL',
      type: 'mssql',
      host: 'db\\SQL2022',
      user: 'sa',
      database: '',
      sslMode: 'disable',
    })
    expect(disabledCfg.server).toBe('db')
    expect(disabledCfg.port).toBeUndefined()
    expect(disabledCfg.database).toBe('master')
    expect(disabledCfg.options?.instanceName).toBe('SQL2022')
    expect(disabledCfg.options?.encrypt).toBe(false)
    expect(disabledCfg.options?.trustServerCertificate).toBe(false)
    expect(disabledCfg.options?.enableArithAbort).toBe(true)

    const tempCaFile = path.join(os.tmpdir(), `datanoa-mssql-ca-${Date.now()}.pem`)
    await fs.promises.writeFile(
      tempCaFile,
      '-----BEGIN CERTIFICATE-----\nTESTCA\n-----END CERTIFICATE-----\n',
      'utf8'
    )
    try {
      const verifiedCfg = await buildMssqlPoolConfig({
        id: 'm_tls',
        name: 'Cloud MSSQL',
        type: 'mssql',
        url: 'mssql://sa:pass%21@sql.example.com:1434/analytics',
        sslMode: 'verify-full',
        sslCaPath: tempCaFile,
      })
      expect(verifiedCfg.server).toBe('sql.example.com')
      expect(verifiedCfg.port).toBe(1434)
      expect(verifiedCfg.user).toBe('sa')
      expect(verifiedCfg.password).toBe('pass!')
      expect(verifiedCfg.database).toBe('analytics')
      expect(verifiedCfg.options?.encrypt).toBe(true)
      expect(verifiedCfg.options?.trustServerCertificate).toBe(false)
      expect(verifiedCfg.options?.cryptoCredentialsDetails?.ca).toContain('TESTCA')
    } finally {
      await fs.promises.unlink(tempCaFile).catch(() => {})
    }
  })
})

interface MockOracleExecuted {
  sql: string
  binds: unknown
  autoCommit: boolean
}

function createMockOracleHarness() {
  const executed: MockOracleExecuted[] = []
  let commits = 0
  let rollbacks = 0
  let breakCalled = false
  let closed = false

  type MockOracleResult = {
    metaData?: Array<{ name: string }>
    rows?: unknown[]
    rowsAffected?: number
  }
  let nextHandler: ((
    sql: string,
    binds: unknown,
    options: Record<string, unknown>
  ) => MockOracleResult | Promise<MockOracleResult>) | null = null

  const connection: OracleConnectionLike = {
    async execute(sql: string, binds?: unknown, options?: Record<string, unknown>) {
      const opts = options ?? {}
      executed.push({
        sql,
        binds: binds ?? null,
        autoCommit: Boolean(opts.autoCommit),
      })
      if (nextHandler) {
        return await nextHandler(sql, binds ?? null, opts)
      }
      return { metaData: [], rows: [], rowsAffected: 0 }
    },
    async commit() {
      commits += 1
    },
    async rollback() {
      rollbacks += 1
    },
    async breakExecution() {
      breakCalled = true
    },
    async close() {
      closed = true
    },
  }

  return {
    connection,
    executed,
    getTxCounts: () => ({ commits, rollbacks }),
    resetTxCounts: () => {
      commits = 0
      rollbacks = 0
    },
    wasBroken: () => breakCalled,
    wasClosed: () => closed,
    setHandler(fn: typeof nextHandler) {
      nextHandler = fn
    },
  }
}

describe('OracleDriver & OracleSession (Slice 4)', () => {
  const oracleProfile: ConnectionProfile = {
    id: 'ora_1',
    name: 'Test Oracle',
    type: 'oracle',
    host: 'localhost',
    port: 1521,
    user: 'hr',
    database: 'FREEPDB1',
  }

  it('builds Easy Connect, TNS, URI, and TLS wallet configs for Oracle Thin mode', async () => {
    const easyCfg = await buildOracleConnectionConfig({
      id: 'ora_easy',
      name: 'Easy',
      type: 'oracle',
      host: 'db.internal',
      port: 1521,
      user: 'hr',
      database: 'FREEPDB1',
    })
    expect(easyCfg.attrs.connectString).toBe('db.internal:1521/FREEPDB1')
    expect(easyCfg.attrs.user).toBe('hr')
    expect(easyCfg.usedDatabaseAsService).toBe(true)
    expect(easyCfg.defaultSchema).toBe('HR')

    const tnsString =
      '(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=tns.internal)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=PROD)))'
    const tnsCfg = await buildOracleConnectionConfig({
      id: 'ora_tns',
      name: 'TNS',
      type: 'oracle',
      host: tnsString,
      user: 'app_user',
      database: 'SALES',
    })
    expect(tnsCfg.attrs.connectString).toBe(tnsString)
    expect(tnsCfg.currentSchema).toBe('SALES')
    expect(tnsCfg.usedDatabaseAsService).toBe(false)

    const tempCa = path.join(os.tmpdir(), `datanoa-ora-ca-${Date.now()}.pem`)
    await fs.promises.writeFile(tempCa, '-----BEGIN CERTIFICATE-----\nORACA\n-----END CERTIFICATE-----\n')
    try {
      const urlCfg = await buildOracleConnectionConfig({
        id: 'ora_url',
        name: 'URL Oracle',
        type: 'oracle',
        url: 'oracle://scott:sec%21@ora.example.com:1522/ORCLPDB1?schema=SALES',
        sslMode: 'verify-full',
        sslCaPath: tempCa,
      })
      expect(urlCfg.attrs.user).toBe('scott')
      expect(urlCfg.attrs.password).toBe('sec!')
      expect(urlCfg.attrs.connectString).toBe('tcps://ora.example.com:1522/ORCLPDB1')
      expect(urlCfg.attrs.walletContent).toContain('ORACA')
      expect(urlCfg.attrs.sslServerDNMatch).toBe(true)
      expect(urlCfg.currentSchema).toBe('SALES')
      expect(urlCfg.usedDatabaseAsService).toBe(false)
    } finally {
      await fs.promises.unlink(tempCa).catch(() => {})
    }
  })

  it('splits PL/SQL blocks vs regular SQL respecting Q-quotes, comments, and trailing semicolons', () => {
    const script = [
      '-- leading regular SQL',
      "SELECT q'[a;b / c]' AS txt FROM DUAL;",
      'BEGIN',
      '  INSERT INTO audit_log(msg) VALUES (\'ok\');',
      '  COMMIT;',
      'END;',
      '/',
      'CREATE OR REPLACE PROCEDURE sync_emp AS',
      'BEGIN',
      '  NULL;',
      'END sync_emp;',
      '/',
      'SELECT 42 FROM DUAL;',
    ].join('\n')

    const parts = splitOracleStatements(script)
    expect(parts).toHaveLength(4)
    expect(parts[0]).toMatchObject({
      isPlSql: false,
      text: "-- leading regular SQL\nSELECT q'[a;b / c]' AS txt FROM DUAL",
    })
    expect(parts[1].isPlSql).toBe(true)
    expect(parts[1].text).toContain('END;')
    expect(parts[1].text.endsWith('/')).toBe(false)
    expect(parts[2].isPlSql).toBe(true)
    expect(parts[2].text).toContain('END sync_emp;')
    expect(parts[3]).toMatchObject({ isPlSql: false, text: 'SELECT 42 FROM DUAL' })
  })

  it('runs Oracle queries (deduped columns, BigInt/Buffer/LOB, readOnly guard for SQL & PL/SQL) and cancellation', async () => {
    const harness = createMockOracleHarness()
    harness.setHandler((sql) => {
      if (sql.includes('DUAL') || sql.startsWith('SELECT a.id')) {
        return {
          metaData: [{ name: 'ID' }, { name: 'ID' }, { name: 'PAYLOAD' }, { name: 'NOTES' }, { name: 'CREATED_AT' }],
          rows: [
            [
              BigInt('9007199254740993'),
              2,
              Buffer.from('ab', 'hex'),
              { getData: async () => 'large-clob-text' },
              new Date('2025-02-01T10:20:30.000Z'),
            ],
          ],
        }
      }
      return { metaData: [], rows: [], rowsAffected: 1 }
    })

    const session = new OracleSession(harness.connection, oracleProfile, { defaultSchema: 'HR' })
    const res = await session.runQuery(
      'q1',
      "SELECT a.id, b.id, payload, notes, created_at FROM items a JOIN items b ON 1=1;\nBEGIN\n  UPDATE t SET x = 1;\nEND;\n/"
    )
    expect(res.resultSets).toHaveLength(2)
    expect(res.columns.map((c) => c.name)).toEqual([
      'ID',
      'ID_2',
      'PAYLOAD',
      'NOTES',
      'CREATED_AT',
    ])
    expect(res.rows[0]).toEqual([
      '9007199254740993',
      2,
      '[BLOB 1 B]',
      'large-clob-text',
      '2025-02-01T10:20:30.000Z',
    ])
    expect(harness.executed[0].sql.endsWith(';')).toBe(false)
    expect(harness.executed[1].sql.trim().endsWith('END;')).toBe(true)

    const roSession = new OracleSession(harness.connection, { ...oracleProfile, readOnly: true }, { defaultSchema: 'HR' })
    await expect(roSession.runQuery('ro1', 'DELETE FROM employees WHERE id = 1;')).rejects.toMatchObject({
      code: 'read_only',
    })
    await expect(roSession.runQuery('ro2', 'BEGIN DELETE FROM employees; END;')).rejects.toMatchObject({
      code: 'read_only',
    })
    const roAllowed = await roSession.runQuery('ro3', 'SELECT 1 FROM DUAL;')
    expect(roAllowed.rows).toHaveLength(1)

    let releaseSlow: () => void = () => {}
    harness.setHandler(
      () =>
        new Promise((resolve) => {
          releaseSlow = () => resolve({ metaData: [], rows: [], rowsAffected: 0 })
        })
    )
    const slowPromise = session.runQuery('q_slow', 'SELECT * FROM big_table;')
    await Promise.resolve()
    const cancelRes = await session.cancelQuery('q_slow')
    expect(cancelRes.ok).toBe(true)
    expect(harness.wasBroken()).toBe(true)
    releaseSlow()
    await expect(slowPromise).rejects.toMatchObject({ code: 'cancelled' })
    expect(session.driverType).toBe('oracle')
    expect(session.isAlive()).toBe(true)
    await session.close()
    expect(session.isAlive()).toBe(false)
    expect(harness.wasClosed()).toBe(true)
  })

  it('introspects Oracle schemas, objects, table details, DBMS_METADATA + fallback DDL, and exportSchemaDdl', async () => {
    const harness = createMockOracleHarness()
    harness.setHandler((sql) => {
      if (sql.includes('SELECT USER')) {
        return { rows: [{ current_user: 'HR' }] }
      }
      if (sql.includes('FROM all_users')) {
        return { rows: [{ name: 'HR' }, { name: 'SALES' }] }
      }
      if (sql.includes('FROM all_objects') && sql.includes('object_type IN')) {
        return {
          rows: [
            { name: 'EMPLOYEES', schema: 'HR', object_type: 'TABLE' },
            { name: 'EMP_MV', schema: 'HR', object_type: 'MATERIALIZED VIEW' },
            { name: 'CALC_BONUS', schema: 'HR', object_type: 'FUNCTION' },
            { name: 'TR_EMP_AUDIT', schema: 'HR', object_type: 'TRIGGER' },
          ],
        }
      }
      if (sql.includes('FROM all_objects') && sql.includes("object_type IN ('TABLE'")) {
        return { rows: [{ object_type: 'TABLE' }] }
      }
      if (sql.includes('FROM all_tab_columns')) {
        return {
          rows: [
            {
              column_name: 'ID',
              data_type: 'NUMBER',
              data_length: 22,
              char_length: 0,
              char_used: null,
              data_precision: 10,
              data_scale: 0,
              nullable: 'N',
              data_default: null,
              identity_column: 'YES',
            },
            {
              column_name: 'SALARY',
              data_type: 'NUMBER',
              data_length: 22,
              char_length: 0,
              char_used: null,
              data_precision: 12,
              data_scale: 2,
              nullable: 'N',
              data_default: '0',
              identity_column: 'NO',
            },
            {
              column_name: 'FULL_LABEL',
              data_type: 'VARCHAR2',
              data_length: 100,
              char_length: 100,
              char_used: 'C',
              data_precision: null,
              data_scale: null,
              nullable: 'Y',
              data_default: null,
              identity_column: 'NO',
            },
          ],
        }
      }
      if (sql.includes('FROM all_tab_cols')) {
        return { rows: [{ column_name: 'FULL_LABEL', virtual_column: 'YES' }] }
      }
      if (sql.includes("ac.constraint_type = 'P'")) {
        return { rows: [{ column_name: 'ID', constraint_name: 'PK_EMPLOYEES' }] }
      }
      if (sql.includes("ac.constraint_type = 'U'")) {
        return { rows: [{ constraint_name: 'UQ_EMP_CODE' }] }
      }
      if (sql.includes("ac.constraint_type = 'R'") && sql.includes('ac.owner = :p1')) {
        return {
          rows: [
            {
              constraint_name: 'FK_EMP_DEPT',
              column_name: 'DEPT_ID',
              referenced_schema: 'HR',
              referenced_table: 'DEPARTMENTS',
              referenced_column: 'ID',
              on_delete: 'SET NULL',
            },
          ],
        }
      }
      if (sql.includes("ac.constraint_type = 'R'") && sql.includes('rc.owner = :p1')) {
        return {
          rows: [
            {
              from_schema: 'HR',
              from_table: 'PAYROLL',
              from_column: 'EMP_ID',
              to_column: 'ID',
              on_delete: 'CASCADE',
            },
          ],
        }
      }
      if (sql.includes('FROM all_indexes')) {
        return {
          rows: [
            {
              index_name: 'PK_EMPLOYEES',
              uniqueness: 'UNIQUE',
              index_type: 'NORMAL',
              column_name: 'ID',
              descend: 'ASC',
              column_position: 1,
            },
            {
              index_name: 'IX_EMP_SALARY',
              uniqueness: 'NONUNIQUE',
              index_type: 'NORMAL',
              column_name: 'SALARY',
              descend: 'DESC',
              column_position: 1,
            },
          ],
        }
      }
      if (sql.includes('FROM all_triggers')) {
        return {
          rows: [
            {
              trigger_owner: 'HR',
              trigger_name: 'TR_EMP_AUDIT',
              trigger_type: 'BEFORE EACH ROW',
              triggering_event: 'INSERT',
              description: '"HR"."TR_EMP_AUDIT" BEFORE INSERT ON "HR"."EMPLOYEES" FOR EACH ROW',
              when_clause: null,
              trigger_body: 'BEGIN NULL; END;',
            },
          ],
        }
      }
      if (sql.includes('DBMS_METADATA.GET_DDL')) {
        if (sql.includes("'FUNCTION'") || String((harness.executed[harness.executed.length - 1]?.binds as Record<string, unknown>)?.p1) === 'FUNCTION') {
          return { rows: [{ ddl: 'CREATE OR REPLACE FUNCTION "HR"."CALC_BONUS" RETURN NUMBER AS BEGIN RETURN 0; END;' }] }
        }
        throw new Error('ORA-31603: object not found or insufficient privileges')
      }
      if (sql.includes('FROM all_mviews')) {
        return { rows: [{ query: 'SELECT id, salary FROM employees' }] }
      }
      return { rows: [] }
    })

    const session = new OracleSession(harness.connection, oracleProfile, { defaultSchema: 'HR' })
    const schemas = await session.listSchemas()
    expect(schemas).toEqual({ schemas: ['HR', 'SALES'], defaultSchema: 'HR' })

    const objs = await session.listObjects('HR')
    expect(objs.map((o) => `${o.kind}:${o.name}`)).toEqual([
      'function:CALC_BONUS',
      'materialized_view:EMP_MV',
      'table:EMPLOYEES',
      'trigger:TR_EMP_AUDIT',
    ])

    const details = await session.getTableDetails('EMPLOYEES', 'HR')
    expect(details.primaryKey).toEqual(['ID'])
    expect(details.columns[0].isAutoIncrement).toBe(true)
    expect(details.columns[0].type).toBe('NUMBER(10)')
    expect(details.columns[1].type).toBe('NUMBER(12,2)')
    expect(details.columns[2].isGenerated).toBe(true)
    expect(details.indexes.find((i) => i.name === 'IX_EMP_SALARY')?.columnSpecs).toEqual([
      { name: 'SALARY', desc: true },
    ])
    expect(details.foreignKeys[0]).toMatchObject({
      constraintName: 'FK_EMP_DEPT',
      referencedTable: 'DEPARTMENTS',
      onDelete: 'SET NULL',
    })
    expect(details.inboundForeignKeys).toEqual([
      { fromTable: 'PAYROLL', fromColumn: 'EMP_ID', toColumn: 'ID', onDelete: 'CASCADE' },
    ])
    expect(details.ddl).toContain('CREATE TABLE "HR"."EMPLOYEES"')
    expect(details.ddl).toContain('CREATE OR REPLACE TRIGGER "HR"."TR_EMP_AUDIT"')

    const mvDdl = await session.getObjectDdl('EMP_MV', 'materialized_view', 'HR')
    expect(mvDdl).toContain('CREATE MATERIALIZED VIEW "HR"."EMP_MV" AS')

    const exportRes = await session.exportSchemaDdl('HR')
    expect(exportRes.objectCount).toBe(4)
    expect(exportRes.ddl).toContain('CREATE TABLE "HR"."EMPLOYEES"')
    expect(exportRes.ddl).toContain('/')
  })

  it('handles Oracle fetchPage, savepoint-guarded updateCell, atomic applyChanges, and interactive transactions', async () => {
    const harness = createMockOracleHarness()
    let updateAffected = 1
    harness.setHandler((sql) => {
      if (sql.includes('COUNT(*)')) {
        return { rows: [{ total: 3 }] }
      }
      if (sql.includes('OFFSET :p1 ROWS FETCH NEXT :p2 ROWS ONLY')) {
        return {
          rows: [
            { ID: 1, NAME: 'Alice' },
            { ID: 2, NAME: 'Bob' },
          ],
        }
      }
      if (sql.startsWith('UPDATE ')) {
        return { rowsAffected: updateAffected }
      }
      if (sql.startsWith('DELETE ') || sql.startsWith('INSERT ')) {
        return { rowsAffected: 1 }
      }
      if (sql.startsWith('SELECT * FROM "HR"."EMPLOYEES" WHERE')) {
        return { rows: [{ ID: 1, NAME: 'Alice2' }] }
      }
      return { rows: [], rowsAffected: 0 }
    })

    const session = new OracleSession(harness.connection, oracleProfile, { defaultSchema: 'HR' })

    const page = await session.fetchPage({
      table: 'EMPLOYEES',
      schema: 'HR',
      page: 1,
      pageSize: 25,
      primaryKey: 'ID',
    })
    expect(page.totalRows).toBe(3)
    expect(page.rows).toHaveLength(2)
    const fetchExec = harness.executed.find((e) => e.sql.includes('OFFSET :p1'))
    expect(fetchExec?.binds).toEqual({ p1: 0, p2: 25 })
    expect(fetchExec?.sql.endsWith(';')).toBe(false)

    // Optimistic updateCell success + commit
    const updated = await session.updateCell({
      table: 'EMPLOYEES',
      schema: 'HR',
      primaryKeys: { ID: 1 },
      column: 'NAME',
      newValue: 'Alice2',
      originalValue: 'Alice',
    })
    expect(updated.ok).toBe(true)
    expect(updated.updatedRecord).toEqual({ ID: 1, NAME: 'Alice2' })
    expect(harness.getTxCounts()).toEqual({ commits: 1, rollbacks: 0 })

    // Optimistic conflict rolls back
    updateAffected = 0
    harness.resetTxCounts()
    await expect(
      session.updateCell({
        table: 'EMPLOYEES',
        schema: 'HR',
        primaryKeys: { ID: 1 },
        column: 'NAME',
        newValue: 'Alice3',
      })
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(harness.getTxCounts()).toEqual({ commits: 0, rollbacks: 1 })

    // Atomic applyChanges with deleteRows + inserts + updates
    updateAffected = 1
    harness.resetTxCounts()
    const applied = await session.applyChanges({
      table: 'EMPLOYEES',
      schema: 'HR',
      deleteRows: [{ ID: 9 }],
      updates: [{ primaryKeys: { ID: 1 }, changes: { NAME: 'Updated' } }],
      inserts: [{ ID: 4, NAME: 'Dana' }],
    })
    expect(applied).toMatchObject({ ok: true, deleted: 1, updated: 1, inserted: 1 })
    expect(harness.getTxCounts()).toEqual({ commits: 1, rollbacks: 0 })

    const preview = await session.previewChanges({
      table: 'EMPLOYEES',
      schema: 'HR',
      deleteRows: [{ ID: 9 }],
      inserts: [{ ID: 4, NAME: 'Dana' }],
    })
    expect(preview.statements).toHaveLength(2)

    // Interactive manual transaction + savepoint rollback on updateCell failure
    await session.beginTransaction()
    expect(session.getTransactionState().active).toBe(true)
    await expect(session.setAutoCommit(true)).rejects.toMatchObject({ code: 'TX_ACTIVE' })
    updateAffected = 2
    await expect(
      session.updateCell({
        table: 'EMPLOYEES',
        schema: 'HR',
        primaryKeys: { ID: 1 },
        column: 'NAME',
        newValue: 'Boom',
      })
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(harness.executed.some((e) => e.sql.includes('SAVEPOINT datanoa_uc'))).toBe(true)
    expect(harness.executed.some((e) => e.sql.includes('ROLLBACK TO SAVEPOINT datanoa_uc'))).toBe(true)
    await session.rollbackTransaction()
    expect(session.getTransactionState().active).toBe(false)
    expect(typeof OracleDriver).toBe('function')
  })

  it('connects via OracleDriver with LOB fetch setup, CURRENT_SCHEMA handling, and ORA-01435 guard', async () => {
    const oracledbMod = await import('../vendor/oracledb.js')
    const harness = createMockOracleHarness()
    harness.setHandler((sql) => {
      if (sql.includes('CURRENT_SCHEMA') && sql.includes('"PDB_SVC"')) {
        throw Object.assign(new Error('ORA-01435: user does not exist'), { errorNum: 1435 })
      }
      return { rows: [{ ok: 1 }] }
    })

    const spy = vi
      .spyOn(oracledbMod.default, 'getConnection')
      .mockResolvedValue(harness.connection as never)
    try {
      const driver = new OracleDriver()
      const testRes = await driver.testConnection({
        id: 'ora_drv_1',
        name: 'PDB Easy',
        type: 'oracle',
        host: 'localhost',
        port: 1521,
        user: 'hr',
        database: 'PDB_SVC',
      })
      expect(testRes.ok).toBe(true)
      expect(spy).toHaveBeenCalledTimes(1)
      expect(oracledbMod.default.fetchAsString).toEqual([oracledbMod.CLOB, oracledbMod.NCLOB])
      expect(oracledbMod.default.fetchAsBuffer).toEqual([oracledbMod.BLOB])

      // Explicit schema from URL throws if invalid instead of swallowing ORA-01435, and closes conn cleanly
      const closeHarness = createMockOracleHarness()
      closeHarness.setHandler((sql) => {
        if (sql.includes('CURRENT_SCHEMA')) {
          throw Object.assign(new Error('ORA-01435: user does not exist'), { errorNum: 1435 })
        }
        return { rows: [] }
      })
      spy.mockResolvedValueOnce(closeHarness.connection as never)
      await expect(
        driver.createSession({
          id: 'ora_drv_bad',
          name: 'Explicit Bad Schema',
          type: 'oracle',
          url: 'oracle://hr:pw@localhost:1521/FREEPDB1?schema=MISSING_USER',
        })
      ).rejects.toThrow('ORA-01435')
      expect(closeHarness.wasClosed()).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it('Wave 2 regressions (#49 Bug 4, #50 Bugs 1-7, #53 Bug 3) for MSSQL & Oracle', async () => {
    // 1. #50 Bug 1: Oracle fetchPage totalRows works with uppercase { TOTAL: 42 } and quoted count alias
    const oraHarness = createMockOracleHarness()
    oraHarness.setHandler((sql) => {
      if (sql.includes("ac.constraint_type = 'P'")) {
        return { rows: [{ column_name: 'ID', constraint_name: 'PK_EMP' }] }
      }
      if (sql.includes('COUNT(*)')) {
        return { rows: [{ TOTAL: 42 }] }
      }
      if (sql.includes('OFFSET :p1 ROWS FETCH NEXT :p2 ROWS ONLY')) {
        return { rows: [{ ID: 1, NAME: 'Alice' }] }
      }
      return { rows: [] }
    })
    const oraSession = new OracleSession(
      oraHarness.connection,
      { id: 'ora_w2', name: 'Ora', type: 'oracle', user: 'hr', database: 'FREEPDB1' },
      { defaultSchema: 'HR' }
    )
    const oraPage = await oraSession.fetchPage({
      table: 'EMPLOYEES',
      schema: 'HR',
      page: 1,
      pageSize: 25,
      primaryKey: 'ID',
    })
    expect(oraPage.totalRows).toBe(42)

    // 2. #50 Bug 4 & #53 Bug 3: Oracle setAutoCommit(false) + SQL DML sets txActive=true
    await oraSession.setAutoCommit(false)
    oraHarness.setHandler(() => ({ rowsAffected: 1 }))
    await oraSession.runQuery('q_dml', "UPDATE EMPLOYEES SET NAME = 'Bob' WHERE ID = 1;")
    expect(oraSession.getTransactionState().active).toBe(true)
    await expect(oraSession.setAutoCommit(true)).rejects.toMatchObject({ code: 'TX_ACTIVE' })
    await oraSession.commitTransaction()
    expect(oraSession.getTransactionState().active).toBe(false)
    await oraSession.setAutoCommit(true)

    // 3. #50 Bug 5: Oracle updateCell on PK column re-selects using newValue
    oraHarness.executed.length = 0
    oraHarness.setHandler((sql) => {
      if (sql.startsWith('UPDATE ')) return { rowsAffected: 1 }
      if (sql.startsWith('SELECT * FROM "HR"."EMPLOYEES" WHERE')) return { rows: [{ ID: 99, NAME: 'Alice' }] }
      return { rows: [] }
    })
    const pkEdit = await oraSession.updateCell({
      table: 'EMPLOYEES',
      schema: 'HR',
      primaryKeys: { ID: 1 },
      column: 'ID',
      newValue: 99,
      originalValue: 1,
    })
    expect(pkEdit.updatedRecord).toEqual({ ID: 99, NAME: 'Alice' })
    const reselect = oraHarness.executed.find((e) => e.sql.startsWith('SELECT * FROM "HR"."EMPLOYEES" WHERE'))
    expect(reselect?.binds).toEqual({ p1: 99 })

    // 4. #50 Bug 6: Oracle previewChanges/applyChanges with deleteRows extracts PKs cleanly
    oraHarness.executed.length = 0
    oraHarness.setHandler((sql) => {
      if (sql.includes('FROM all_constraints') && sql.includes("ac.constraint_type = 'P'")) {
        return { rows: [{ column_name: 'ID', constraint_name: 'PK_EMP' }] }
      }
      if (sql.startsWith('DELETE ')) return { rowsAffected: 1 }
      return { rows: [] }
    })
    const deleteRowPayload = { ID: 7, NAME: 'Dana', AVATAR: '[BLOB 12 B]', META: { nested: true } }
    const oraPreview = await oraSession.previewChanges({
      table: 'EMPLOYEES',
      schema: 'HR',
      deleteRows: [deleteRowPayload],
    })
    expect(oraPreview.statements).toEqual(['DELETE FROM "HR"."EMPLOYEES" WHERE "ID" = 7;'])
    const oraApply = await oraSession.applyChanges({
      table: 'EMPLOYEES',
      schema: 'HR',
      deleteRows: [deleteRowPayload],
    })
    expect(oraApply.deleted).toBe(1)
    const delExec = oraHarness.executed.find((e) => e.sql.startsWith('DELETE '))
    expect(delExec?.binds).toEqual({ p1: 7 })

    // 5. #50 Bug 7: Oracle identity column omits redundant ISEQ$$_*.nextval DEFAULT in DDL
    oraHarness.setHandler((sql) => {
      if (sql.includes('FROM all_objects')) return { rows: [{ object_type: 'TABLE' }] }
      if (sql.includes('FROM all_tab_columns')) {
        return {
          rows: [
            {
              column_name: 'ID',
              data_type: 'NUMBER',
              data_precision: 10,
              data_scale: 0,
              nullable: 'N',
              data_default: '"HR"."ISEQ$$_99123".nextval',
              identity_column: 'YES',
            },
          ],
        }
      }
      if (sql.includes("ac.constraint_type = 'P'")) {
        return { rows: [{ column_name: 'ID', constraint_name: 'PK_IDENT' }] }
      }
      return { rows: [] }
    })
    const identDetails = await oraSession.getTableDetails('IDENT_TEST', 'HR')
    expect(identDetails.ddl).toContain('GENERATED BY DEFAULT AS IDENTITY')
    expect(identDetails.ddl).not.toContain('ISEQ$$_99123')

    // 6. #50 Bugs 2 & 3: MSSQL compound BEGIN TRAN; INSERT ... executes full batch & SELECT * INTO [dbo].[copy] blocked in readOnly
    const msHarness = createMockMssqlHarness()
    msHarness.setHandler(() => ({ recordset: [], rowsAffected: [1] }))
    const msSession = new MssqlSession(msHarness.pool, {
      id: 'ms_w2',
      name: 'MS',
      type: 'mssql',
      host: 'localhost',
      user: 'sa',
      database: 'master',
    })
    const msCompound = await msSession.runQuery(
      'q_cmp',
      "BEGIN TRAN;\nINSERT INTO [dbo].[users]([name]) VALUES ('alice');"
    )
    expect(msCompound.affectedRows).toBe(1)
    expect(msHarness.executed.some((e) => e.sql.includes('INSERT INTO [dbo].[users]'))).toBe(true)

    const msRoSession = new MssqlSession(msHarness.pool, {
      id: 'ms_w2_ro',
      name: 'MS RO',
      type: 'mssql',
      host: 'localhost',
      user: 'sa',
      database: 'master',
      readOnly: true,
    })
    await expect(
      msRoSession.runQuery('q_into_br', 'SELECT * INTO [dbo].[copy_users] FROM [dbo].[users];')
    ).rejects.toMatchObject({ code: 'read_only' })

    // 7. #49 Bug 4: MSSQL & Oracle testConnection/driver error messages scrub embedded credentials
    const msDriver = new MssqlDriver()
    vi.spyOn(msDriver, 'createSession').mockRejectedValueOnce(
      new Error('Failed mssql://sa:MsPass!123@sql.local/db (Server=sql.local;Password=MsAdoSecret!;)?token=UrlTok')
    )
    const msErrRes = await msDriver.testConnection({ id: 'ms_err', name: 'MS', type: 'mssql' })
    expect(msErrRes.ok).toBe(false)
    expect(msErrRes.message).not.toContain('MsPass!123')
    expect(msErrRes.message).not.toContain('MsAdoSecret!')
    expect(msErrRes.message).not.toContain('UrlTok')

    const oraDriver = new OracleDriver()
    vi.spyOn(oraDriver, 'createSession').mockRejectedValueOnce(
      new Error('Failed oracle://hr:OraSecret99@ora.local:1521/FREEPDB1?password=QPass')
    )
    const oraErrRes = await oraDriver.testConnection({ id: 'ora_err', name: 'Ora', type: 'oracle' })
    expect(oraErrRes.ok).toBe(false)
    expect(oraErrRes.message).not.toContain('OraSecret99')
    expect(oraErrRes.message).not.toContain('QPass')
  })

  it('Wave 3 regressions (#71 Bugs 1, 2, 9): full session error scrubbing and empty-path Oracle SID URI handling', async () => {
    // 1. #71 Bug 1: MssqlSession scrubs credentials across ALL async methods
    const msErrHarness = createMockMssqlHarness()
    msErrHarness.setHandler(() => {
      throw new Error('Failed mssql://sa:MsLeak!99@sql.internal/app?token=TokLeak&Pwd={Br@ce;Leak}')
    })
    const msScrubSession = new MssqlSession(msErrHarness.pool, {
      id: 'ms_scrub',
      name: 'MS Scrub',
      type: 'mssql',
      host: 'localhost',
      user: 'sa',
      database: 'master',
    })
    const msFailingCalls: Array<() => Promise<unknown>> = [
      () => msScrubSession.listSchemas(),
      () => msScrubSession.listObjects('dbo'),
      () => msScrubSession.getTableDetails('users', 'dbo'),
      () => msScrubSession.getDdl('users', 'dbo'),
      () => msScrubSession.getObjectDdl('usp_x', 'procedure', 'dbo'),
      () => msScrubSession.fetchPage({ table: 'users', schema: 'dbo', page: 1, pageSize: 10 }),
      () =>
        msScrubSession.updateCell({
          table: 'users',
          schema: 'dbo',
          primaryKeys: { id: 1 },
          column: 'name',
          newValue: 'X',
        }),
      () =>
        msScrubSession.applyChanges({
          table: 'users',
          schema: 'dbo',
          inserts: [{ id: 1, name: 'X' }],
        }),
    ]
    for (const call of msFailingCalls) {
      let caughtMsg = ''
      try {
        await call()
      } catch (err: unknown) {
        caughtMsg = err instanceof Error ? err.message : String(err)
      }
      expect(caughtMsg).toBeTruthy()
      expect(caughtMsg).not.toContain('MsLeak!99')
      expect(caughtMsg).not.toContain('TokLeak')
      expect(caughtMsg).not.toContain('Br@ce;Leak')
    }

    // 2. #71 Bug 2: OracleSession scrubs credentials across ALL async methods
    const oraErrHarness = createMockOracleHarness()
    oraErrHarness.setHandler(() => {
      throw new Error('Failed oracle://hr:OraLeak!88@ora.internal:1521/orcl?token=OraTok88')
    })
    const oraScrubSession = new OracleSession(
      oraErrHarness.connection,
      { id: 'ora_scrub', name: 'Ora Scrub', type: 'oracle', user: 'hr' },
      { defaultSchema: 'HR' }
    )
    const oraFailingCalls: Array<() => Promise<unknown>> = [
      () => oraScrubSession.listSchemas(),
      () => oraScrubSession.listObjects('HR'),
      () => oraScrubSession.getTableDetails('EMPLOYEES', 'HR'),
      () => oraScrubSession.getDdl('EMPLOYEES', 'HR'),
      () => oraScrubSession.getObjectDdl('FN_X', 'function', 'HR'),
      () => oraScrubSession.fetchPage({ table: 'EMPLOYEES', schema: 'HR', page: 1, pageSize: 10 }),
      () =>
        oraScrubSession.updateCell({
          table: 'EMPLOYEES',
          schema: 'HR',
          primaryKeys: { ID: 1 },
          column: 'NAME',
          newValue: 'X',
        }),
      () =>
        oraScrubSession.applyChanges({
          table: 'EMPLOYEES',
          schema: 'HR',
          inserts: [{ ID: 1, NAME: 'X' }],
        }),
    ]
    for (const call of oraFailingCalls) {
      let caughtMsg = ''
      try {
        await call()
      } catch (err: unknown) {
        caughtMsg = err instanceof Error ? err.message : String(err)
      }
      expect(caughtMsg).toBeTruthy()
      expect(caughtMsg).not.toContain('OraLeak!88')
      expect(caughtMsg).not.toContain('OraTok88')
    }

    // Also tx commit/rollback error scrubbing on both drivers
    const msTxErrPool = {
      ...msErrHarness.pool,
      transaction() {
        return {
          async begin() {
            throw new Error('tx begin oracle://u:TxLeak@h/d')
          },
          async commit() {},
          async rollback() {},
          request: () => msErrHarness.pool.request(),
        }
      },
    }
    const msTxSession = new MssqlSession(msTxErrPool, {
      id: 'ms_txe',
      name: 'MS',
      type: 'mssql',
      host: 'localhost',
      user: 'sa',
      database: 'master',
    })
    await expect(msTxSession.beginTransaction()).rejects.not.toThrow('TxLeak')

    const oraTxConn: OracleConnectionLike = {
      ...oraErrHarness.connection,
      async commit() {
        throw new Error('commit fail oracle://hr:CommitLeak@ora/orcl')
      },
      async rollback() {
        throw new Error('rollback fail oracle://hr:RollbackLeak@ora/orcl')
      },
    }
    const oraTxSession = new OracleSession(oraTxConn, {
      id: 'ora_txe',
      name: 'Ora',
      type: 'oracle',
      user: 'hr',
    })
    await oraTxSession.beginTransaction()
    await expect(oraTxSession.commitTransaction()).rejects.not.toThrow('CommitLeak')
    await expect(oraTxSession.rollbackTransaction()).rejects.not.toThrow('RollbackLeak')

    // 3. #71 Bug 9: Empty-path Oracle URI with ?sid= or ?service= does NOT fabricate FREEPDB1 currentSchema
    const parsedSid = parseConnectionUri('oracle://hr:p%40ss@ora.example:1521/?sid=ORCLCDB')
    expect(parsedSid.ok).toBe(true)
    expect(parsedSid.profile?.database || '').toBe('')

    const builtFromSid = await buildOracleConnectionConfig({
      id: 'ora_sid',
      name: 'SID',
      type: 'oracle',
      host: parsedSid.profile?.host,
      port: parsedSid.profile?.port,
      user: parsedSid.profile?.user,
      database: parsedSid.profile?.database,
      url: parsedSid.profile?.url,
    })
    expect(builtFromSid.currentSchema).toBeUndefined()
    expect(builtFromSid.attrs.connectString).toContain('(SID=ORCLCDB)')

    // Even if profile.database had default 'FREEPDB1' from older saved profile + ?sid=ORCLCDB URL
    const builtWithStaleDefault = await buildOracleConnectionConfig({
      id: 'ora_sid_stale',
      name: 'SID Stale',
      type: 'oracle',
      host: 'ora.example',
      port: 1521,
      user: 'hr',
      database: 'FREEPDB1',
      url: 'oracle://ora.example:1521/?sid=ORCLCDB',
    })
    expect(builtWithStaleDefault.currentSchema).toBeUndefined()
  })

  it('Wave 7 (#175 R2 Bug 1): MSSQL query.explain enforces readOnly for mutations while allowing read-only SHOWPLAN batches', async () => {
    const { buildExplainPlanForStatement, registerQueryAndTxHandlers } = await import(
      '../src/worker/rpc-query-tx'
    )
    const { createQueryRuntimeTracker } = await import('../src/worker/worker-utils')

    // Direct buildExplainPlanForStatement checks under readOnly = true
    const selPlan = buildExplainPlanForStatement('SELECT * FROM [dbo].[Users];', 'mssql', true)
    expect(selPlan.explainSql).toContain('SET SHOWPLAN_ALL ON;')

    const blockedInExplain = [
      'DELETE FROM [dbo].[Users];',
      'WITH c AS (SELECT 1) EXEC sp_help;',
      'EXPLAIN WITH c AS (SELECT 1) EXEC sp_help;',
      'SELECT * INTO #tmp FROM [dbo].[Users];',
      'SET STATISTICS IO ON;',
      'SET SHOWPLAN_ALL ON;\nGO\nDELETE FROM [dbo].[Users]\nGO\nSET SHOWPLAN_ALL OFF;',
    ]
    for (const dangerous of blockedInExplain) {
      let caughtCode = ''
      try {
        buildExplainPlanForStatement(dangerous, 'mssql', true)
      } catch (err: unknown) {
        caughtCode = (err as { code?: string }).code ?? ''
      }
      expect(caughtCode, `Expected not_permitted for: ${dangerous}`).toBe('not_permitted')
    }

    // MssqlSession(readOnly: true) allows standalone SHOWPLAN_ALL/TEXT/XML batches via query.explain
    // while still blocking non-SHOWPLAN SET statements in standalone runQuery
    const executedBatches: string[] = []
    const mockReq: MssqlRequestLike = {
      arrayRowMode: false,
      input() {
        return mockReq
      },
      async query(cmd: string) {
        executedBatches.push(cmd)
        return {
          recordsets: [
            Object.assign([['StmtText: SELECT * FROM [dbo].[Users]']], {
              columns: [{ name: 'StmtText', type: 'nvarchar' }],
            }),
          ],
          rowsAffected: [1],
        }
      },
      cancel() {},
    }
    const mockPool: MssqlPoolLike = {
      connected: true,
      async connect() {
        return mockPool
      },
      async close() {},
      request() {
        return mockReq
      },
      transaction(): MssqlTransactionLike {
        return {
          async begin() {},
          async commit() {},
          async rollback() {},
          request() {
            return mockReq
          },
        }
      },
    }

    const roProfile: ConnectionProfile = {
      id: 'ms_w7_ro',
      name: 'MS W7 RO',
      driver: 'mssql',
      host: 'localhost',
      port: 1433,
      database: 'master',
      user: 'sa',
      readOnly: true,
    }
    const roSession = new MssqlSession(mockPool, roProfile)

    await expect(roSession.runQuery('q_set_bad', 'SET ANSI_NULLS OFF;')).rejects.toMatchObject({
      code: 'read_only',
    })
    await expect(roSession.runQuery('q_set_stat', 'SET STATISTICS IO ON;')).rejects.toMatchObject({
      code: 'read_only',
    })
    await expect(
      roSession.runQuery('q_set_sneaky', 'SET SHOWPLAN_ALL ON; DELETE FROM [dbo].[Users];')
    ).rejects.toMatchObject({
      code: 'read_only',
    })

    const handlers = new Map<string, (input: Record<string, unknown>) => Promise<unknown>>()
    registerQueryAndTxHandlers({
      orca: {
        storage: { get: async () => undefined, set: async () => {} },
        settings: { get: async () => 1000 },
        secrets: { get: async () => undefined },
        log: () => {},
      } as unknown as Parameters<typeof registerQueryAndTxHandlers>[0]['orca'],
      registerHandler: ((name: string, fn: (input: Record<string, unknown>) => Promise<unknown>) => {
        handlers.set(name, fn)
      }) as unknown as Parameters<typeof registerQueryAndTxHandlers>[0]['registerHandler'],
      sessionManager: {
        findProfile: async () => roProfile,
        getSession: async () => roSession,
      } as unknown as Parameters<typeof registerQueryAndTxHandlers>[0]['sessionManager'],
      tracker: createQueryRuntimeTracker(),
    })

    const queryExplain = handlers.get('query.explain')!
    const explainRes = (await queryExplain({
      connectionId: 'ms_w7_ro',
      sql: 'SELECT * FROM [dbo].[Users];',
    })) as { rows: unknown[][] }
    expect(explainRes.rows.length).toBeGreaterThan(0)
    expect(executedBatches).toEqual([
      'SET SHOWPLAN_ALL ON;',
      'SELECT * FROM [dbo].[Users]',
      'SET SHOWPLAN_ALL OFF;',
    ])

    await expect(
      queryExplain({ connectionId: 'ms_w7_ro', sql: 'DELETE FROM [dbo].[Users];' })
    ).rejects.toMatchObject({ code: 'not_permitted' })

    await roSession.close()
  })
})

