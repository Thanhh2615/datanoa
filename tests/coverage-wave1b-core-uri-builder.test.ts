import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { sanitizeJsonPayload, type DatabaseDriverType } from '../src/protocol.js'
import { getCanonicalByodStarterCode } from '../src/drivers/common/byod-templates.js'
import {
  assembleTableBrowseResult,
  buildBatchStatements,
  buildChunkedInsertStatements,
  buildDeleteStatement,
  buildFetchPageQueries,
  buildInsertStatement,
  buildRowUpdateStatement,
  buildSelectByPrimaryKeySql,
  buildSelectPageSql,
  buildUpdateSql,
  canBindOptimisticLockValue,
  formatSqlValue,
  makePlaceholder,
  projectDeleteRowsToPrimaryKeys,
  quoteIdentifier,
  quoteQualifiedTable,
} from '../src/drivers/common/update-builder.js'
import {
  detectRecognizableSqlCredential,
  scrubDriverErrorText,
} from '../src/drivers/common/sql-credentials.js'
import {
  getEngineMetadata,
  isCloudDatabaseHost,
  isD1HttpLoopbackEndpoint,
  isSupabaseDirectHost,
  isSupabaseHost,
  parseConnectionUri,
  resolveTlsSettings,
  scrubUrlCredentials,
  splitCommaSeedAuthority,
  validateD1EndpointUrl,
  validateLibsqlEndpointUrl,
} from '../src/drivers/common/connection-uri.js'

const SQL_DIALECTS: readonly DatabaseDriverType[] = [
  'sqlite',
  'postgres',
  'mysql',
  'mariadb',
  'cockroachdb',
  'clickhouse',
  'libsql',
  'd1',
  'mssql',
  'oracle',
]

describe('Wave 1B-1: protocol.ts sanitizeJsonPayload & byod-templates.ts', () => {
  it('normalizes every JS runtime value into strict Orca JSON without undefined keys or non-finite numbers', () => {
    expect(sanitizeJsonPayload(undefined)).toBeUndefined()
    expect(sanitizeJsonPayload(null)).toBeNull()
    expect(sanitizeJsonPayload(true)).toBe(true)
    expect(sanitizeJsonPayload('ok')).toBe('ok')
    expect(sanitizeJsonPayload(42)).toBe(42)
    expect(sanitizeJsonPayload(Number.NaN)).toBeNull()
    expect(sanitizeJsonPayload(Number.POSITIVE_INFINITY)).toBeNull()
    expect(sanitizeJsonPayload(10n)).toBe(10)
    expect(sanitizeJsonPayload(9007199254740993n)).toBe('9007199254740993')

    const d = new Date('2026-05-01T10:20:30.000Z')
    expect(sanitizeJsonPayload(d)).toBe('2026-05-01T10:20:30.000Z')
    expect(sanitizeJsonPayload(new Date('bad-date'))).toBeNull()
    expect(sanitizeJsonPayload(new ArrayBuffer(5))).toBe('[BLOB 5 B]')
    expect(sanitizeJsonPayload(new Uint8Array([1, 2, 3]))).toBe('[BLOB 3 B]')
    expect(sanitizeJsonPayload(() => 1)).toBeNull()
    expect(sanitizeJsonPayload(Symbol('x'))).toBeNull()

    expect(
      sanitizeJsonPayload({
        keep: 1,
        dropUndef: undefined,
        dropFn: () => {},
        dropSym: Symbol('s'),
        arr: [1, undefined, 9007199254740993n],
      })
    ).toEqual({
      keep: 1,
      arr: [1, null, '9007199254740993'],
    })

    // Property: output of sanitizeJsonPayload is always JSON.stringify-roundtrippable without throwing
    fc.assert(
      fc.property(
        fc.anything({ maxDepth: 3, withBigInt: true, withDate: true, withNullPrototype: true }),
        (val) => {
          const sanitized = sanitizeJsonPayload(val)
          const json = JSON.stringify(sanitized)
          if (sanitized === undefined) {
            expect(json).toBeUndefined()
          } else {
            expect(() => JSON.parse(json)).not.toThrow()
          }
        }
      ),
      { numRuns: 100 }
    )
  })

  it('falls back cleanly to custom BYOD starter template on empty/whitespace driverId', () => {
    const emptyCode = getCanonicalByodStarterCode('')
    const wsCode = getCanonicalByodStarterCode('   ')
    expect(emptyCode).toContain('type: "custom"')
    expect(wsCode).toBe(emptyCode)
  })
})

describe('Wave 1B-1: update-builder.ts behavioral & property tests', () => {
  it('covers identifier quoting, placeholders, value formatting, optimistic lock checks, and statement builders', () => {
    expect(quoteQualifiedTable('users', 'main', 'sqlite')).toBe('"users"')
    expect(quoteQualifiedTable('users', 'public', 'postgres')).toBe('"public"."users"')
    expect(quoteIdentifier('col', 'postgres')).toBe('"col"')
    expect(quoteIdentifier('postgres', 'users', 'public')).toBe('"public"."users"')
    expect(quoteIdentifier('postgres', 'users')).toBe('"users"')
    expect(quoteIdentifier('unknown' as DatabaseDriverType, 'users')).toBe('"users"')

    expect(makePlaceholder('postgres', 1)).toBe('$1')
    expect(makePlaceholder('mssql', 2)).toBe('@p2')
    expect(makePlaceholder('oracle', 3)).toBe(':p3')
    expect(makePlaceholder('mysql', 1)).toBe('?')

    expect(formatSqlValue(null, 'postgres')).toBe('NULL')
    expect(formatSqlValue(true, 'mssql')).toBe('1')
    expect(formatSqlValue(false, 'mssql')).toBe('0')
    expect(formatSqlValue(true, 'postgres')).toBe('TRUE')
    expect(formatSqlValue(false, 'postgres')).toBe('FALSE')
    expect(formatSqlValue(Number.POSITIVE_INFINITY, 'postgres')).toBe('NULL')
    expect(formatSqlValue(12.5, 'postgres')).toBe('12.5')
    expect(formatSqlValue(99n, 'postgres')).toBe('99')
    expect(formatSqlValue(new Date('2026-01-01T00:00:00.000Z'), 'postgres')).toBe(
      "'2026-01-01T00:00:00.000Z'"
    )
    expect(formatSqlValue(new Date('invalid'), 'postgres')).toBe('NULL')
    expect(formatSqlValue(new Uint8Array([0xab, 0xcd]).buffer, 'postgres')).toContain('abcd')
    expect(formatSqlValue(new Uint8Array([0x0f]), 'postgres')).toContain('0f')
    expect(formatSqlValue({ k: 'v' }, 'mysql')).toBe('\'{"k":"v"}\'')
    expect(formatSqlValue("a\\b\0'c", 'mysql')).toBe("'a\\\\b\\0''c'")
    expect(formatSqlValue(Symbol('s'), 'postgres')).toBe("'Symbol(s)'")

    expect(canBindOptimisticLockValue(undefined)).toBe(false)
    expect(canBindOptimisticLockValue(1.5, 'DOUBLE PRECISION')).toBe(false)
    expect(canBindOptimisticLockValue('{"a":1}', 'JSON')).toBe(false)
    expect(canBindOptimisticLockValue(null, '   ')).toBe(true)
    expect(canBindOptimisticLockValue({ nested: 1 }, 'TEXT')).toBe(false)
    expect(canBindOptimisticLockValue('[BLOB 16 B]', 'TEXT')).toBe(false)
    expect(canBindOptimisticLockValue('ok', 'TEXT')).toBe(true)

    // buildUpdateSql validation & lock branches
    expect(() =>
      buildUpdateSql({ driver: 'postgres', table: '', column: 'a', newValue: 1, primaryKeys: { id: 1 } })
    ).toThrow('Table name')
    expect(() =>
      buildUpdateSql({ driver: 'postgres', table: 't', column: '', newValue: 1, primaryKeys: { id: 1 } })
    ).toThrow('Column name')
    expect(() =>
      buildUpdateSql({ driver: 'postgres', table: 't', column: 'a', newValue: 1, primaryKeys: {} })
    ).toThrow('primary key')

    const updNull = buildUpdateSql({
      driver: 'postgres',
      table: 't',
      column: 'note',
      newValue: 'hi',
      primaryKeys: { id: null },
      originalValue: null,
    })
    expect(updNull.sql).toBe('UPDATE "t" SET "note" = $1 WHERE "id" IS NULL AND "note" IS NULL')
    expect(updNull.params).toEqual(['hi'])

    // buildSelectByPrimaryKeySql
    expect(
      buildSelectByPrimaryKeySql({
        driver: 'postgres',
        table: 't',
        primaryKeys: undefined as unknown as Record<string, unknown>,
      })
    ).toBeNull()
    expect(
      buildSelectByPrimaryKeySql({ driver: 'postgres', table: 't', primaryKeys: {} })
    ).toBeNull()
    const selPk = buildSelectByPrimaryKeySql({
      driver: 'postgres',
      table: 't',
      primaryKeys: { id: 1, tag: null },
      editedColumn: 'id',
      newValue: 2,
    })
    expect(selPk).toEqual({
      sql: 'SELECT * FROM "t" WHERE "id" = $1 AND "tag" IS NULL',
      params: [2],
    })

    // buildInsertStatement
    expect(() =>
      buildInsertStatement({ driver: 'postgres', table: '', row: { a: 1 } })
    ).toThrow('Table name')
    expect(
      buildInsertStatement({ driver: 'mysql', table: 't', row: { skip: undefined } }).sql
    ).toBe('INSERT INTO `t` () VALUES ()')
    expect(
      buildInsertStatement({ driver: 'postgres', table: 't', row: undefined as unknown as Record<string, unknown> }).sql
    ).toBe('INSERT INTO "t" DEFAULT VALUES')

    // buildDeleteStatement
    expect(() =>
      buildDeleteStatement({ driver: 'postgres', table: '', primaryKeys: { id: 1 } })
    ).toThrow('Table name')
    expect(() =>
      buildDeleteStatement({
        driver: 'postgres',
        table: 't',
        primaryKeys: undefined as unknown as Record<string, unknown>,
      })
    ).toThrow('primary key')
    expect(() =>
      buildDeleteStatement({ driver: 'postgres', table: 't', primaryKeys: { id: undefined } })
    ).toThrow('primary key')
    expect(
      buildDeleteStatement({ driver: 'postgres', table: 't', primaryKeys: { id: null } }).sql
    ).toBe('DELETE FROM "t" WHERE "id" IS NULL')

    // projectDeleteRowsToPrimaryKeys fallback when row lacks a PK property
    expect(
      projectDeleteRowsToPrimaryKeys([{ name: 'a', blob: { k: 1 }, undef: undefined }], ['id'])
    ).toEqual([{ name: 'a' }])

    // buildRowUpdateStatement
    expect(() =>
      buildRowUpdateStatement({
        driver: 'postgres',
        table: '',
        update: { primaryKeys: { id: 1 }, changes: { a: 1 } },
      })
    ).toThrow('Table name')
    expect(() =>
      buildRowUpdateStatement({
        driver: 'postgres',
        table: 't',
        update: { primaryKeys: undefined as unknown as Record<string, unknown>, changes: { a: 1 } },
      })
    ).toThrow('primary key')
    expect(
      buildRowUpdateStatement({
        driver: 'postgres',
        table: 't',
        update: { primaryKeys: { id: 1 }, changes: undefined as unknown as Record<string, unknown> },
      })
    ).toBeNull()
    expect(
      buildRowUpdateStatement({
        driver: 'postgres',
        table: 't',
        update: { primaryKeys: { id: 1 }, changes: { a: undefined } },
      })
    ).toBeNull()
    const rowUpd = buildRowUpdateStatement({
      driver: 'postgres',
      table: 't',
      update: {
        primaryKeys: { id: null },
        changes: { a: 1, b: 2, c: 3, d: 4 },
        originalRow: { a: null, b: 'old', c: { obj: true } },
      },
    })!
    expect(rowUpd.sql).toBe(
      'UPDATE "t" SET "a" = $1, "b" = $2, "c" = $3, "d" = $4 WHERE "id" IS NULL AND "a" IS NULL AND "b" = $5'
    )
    expect(rowUpd.params).toEqual([1, 2, 3, 4, 'old'])

    // buildChunkedInsertStatements & buildBatchStatements
    expect(buildChunkedInsertStatements({ driver: 'postgres', table: 't', inserts: [] })).toEqual([])
    const chunked = buildChunkedInsertStatements({
      driver: 'mssql',
      table: 't',
      inserts: [
        undefined as unknown as Record<string, unknown>,
        { a: 1, b: 2 },
        { a: 3, b: 4 },
        { a: 5, c: 6 },
        undefined as unknown as Record<string, unknown>,
        { a: 7 },
        { x: 8, y: 9 },
      ],
    })
    expect(chunked.map((c) => c.rowCount)).toEqual([1, 2, 1, 1, 1, 1])
    expect(
      buildChunkedInsertStatements({ driver: 'oracle', table: 't', inserts: [{ a: 1 }, { a: 2 }] })
    ).toHaveLength(2)

    const batch = buildBatchStatements({
      driver: 'postgres',
      table: 't',
      deletes: [{ id: 1 }],
      updates: [
        { primaryKeys: { id: 2 }, changes: { a: undefined } },
        { primaryKeys: { id: 3 }, changes: { a: 'v' } },
      ],
      inserts: [{ id: 4, a: 'new' }],
    })
    expect(batch.all).toHaveLength(3)
    expect(batch.previewStatements).toHaveLength(3)

    // buildSelectPageSql / buildFetchPageQueries & assembleTableBrowseResult
    const pageOrderOverride = buildFetchPageQueries({
      driver: 'oracle',
      table: 'USERS',
      schema: 'HR',
      page: Number.NaN,
      pageSize: -5,
      orderByClause: 'CREATED_AT DESC',
    })
    expect(pageOrderOverride.sql).toContain('ORDER BY CREATED_AT DESC OFFSET :p1 ROWS FETCH NEXT :p2 ROWS ONLY;')
    expect(pageOrderOverride.countSql).toContain('AS "total"')

    expect(
      buildSelectPageSql({ driver: 'mssql', table: 'Users', page: 1, pageSize: 10 }).sql
    ).toContain('ORDER BY (SELECT NULL) OFFSET @p1 ROWS FETCH NEXT @p2 ROWS ONLY;')
    expect(
      buildSelectPageSql({
        driver: 'postgres',
        table: 'users',
        page: 2,
        pageSize: 20,
        sortColumn: 'id',
      }).sql
    ).toContain('ORDER BY "id" ASC LIMIT $1 OFFSET $2;')
    expect(
      buildSelectPageSql({
        driver: 'postgres',
        table: 'users',
        page: 2,
        pageSize: 20,
        sortColumn: 'id',
        sortDirection: 'DESC',
      }).sql
    ).toContain('ORDER BY "id" DESC LIMIT $1 OFFSET $2;')

    expect(
      assembleTableBrowseResult({
        tableDetails: { name: 't', kind: 'table', columns: [], primaryKey: ['id'], indexes: [], foreignKeys: [] },
        rows: [],
        countRow: { TOTAL: 5 },
        page: 1,
        pageSize: 10,
      }).totalRows
    ).toBe(5)
    expect(
      assembleTableBrowseResult({
        tableDetails: { name: 't', kind: 'table', columns: [], primaryKey: ['id'], indexes: [], foreignKeys: [] },
        rows: [],
        countRow: { 'COUNT(*)': 6 },
        page: 1,
        pageSize: 10,
      }).totalRows
    ).toBe(6)
    expect(
      assembleTableBrowseResult({
        tableDetails: { name: 't', kind: 'table', columns: [], primaryKey: ['id'], indexes: [], foreignKeys: [] },
        rows: [],
        countRow: { count: 7 },
        page: 1,
        pageSize: 10,
      }).totalRows
    ).toBe(7)
    expect(
      assembleTableBrowseResult({
        tableDetails: { name: 't', kind: 'table', columns: [], primaryKey: ['id'], indexes: [], foreignKeys: [] },
        rows: [],
        countRow: { COUNT: 8 },
        page: 1,
        pageSize: 10,
      }).totalRows
    ).toBe(8)
    expect(
      assembleTableBrowseResult({
        tableDetails: { name: 't', kind: 'table', columns: [], primaryKey: ['id'], indexes: [], foreignKeys: [] },
        rows: [],
        countRow: { extra: 1, 'Count(*)': 9 },
        page: 1,
        pageSize: 10,
      }).totalRows
    ).toBe(9)
    expect(
      assembleTableBrowseResult({
        tableDetails: { name: 't', kind: 'view', columns: [], primaryKey: [], indexes: [], foreignKeys: [] },
        rows: [],
        countRow: {},
        page: 1,
        pageSize: 10,
      })
    ).toMatchObject({ totalRows: 0, canEdit: false })
    expect(
      assembleTableBrowseResult({
        tableDetails: { name: 't', kind: 'view', columns: [], primaryKey: [], indexes: [], foreignKeys: [] },
        rows: [],
        countRow: { total: -5 },
        page: 1,
        pageSize: 10,
      }).totalRows
    ).toBe(0)

    // Property: placeholder index monotonicity & positive bounded pagination
    fc.assert(
      fc.property(
        fc.constantFrom(...SQL_DIALECTS),
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: -5, max: 500 }),
        fc.integer({ min: -5, max: 20000 }),
        (driver, n, rawPage, rawSize) => {
          const ph = Array.from({ length: n }, (_, i) => makePlaceholder(driver, i + 1))
          if (driver === 'postgres' || driver === 'cockroachdb' || driver === 'mssql' || driver === 'oracle') {
            expect(new Set(ph).size).toBe(n)
          }
          const q = buildSelectPageSql({ driver, table: 'items', page: rawPage, pageSize: rawSize })
          expect(q.limit).toBeGreaterThanOrEqual(1)
          expect(q.limit).toBeLessThanOrEqual(10000)
          expect(q.offset).toBeGreaterThanOrEqual(0)
        }
      ),
      { numRuns: 100 }
    )
  })
})

describe('Wave 1B-1: sql-credentials.ts behavioral & property tests', () => {
  it('detects SQL credential literals, DB URIs, comments/strings, and scrubs driver errors safely', () => {
    expect(detectRecognizableSqlCredential('')).toBeNull()
    expect(detectRecognizableSqlCredential(null as unknown as string)).toBeNull()

    // Lexical edge cases: MySQL #, /*M!...*/ & /*!50000...*/, E'...', $tag$...$tag$, "...", `...`, $123
    expect(
      detectRecognizableSqlCredential(
        `
        # ignored mysql comment password='x'
        /* ordinary block comment */
        /*m!100203 CREATE USER u IDENTIFIED BY 'SecMdb' */;
      `,
        'mariadb'
      )
    ).toBe('sql-auth-literal')
    expect(
      detectRecognizableSqlCredential("/*!50000 SET PASSWORD FOR 'u'@'h' = PASSWORD('SecMy') */;", 'mysql')
    ).toBe('sql-auth-literal')
    expect(
      detectRecognizableSqlCredential('SET PASSWORD = "SecDoubleQuoted";', 'mysql')
    ).toBe('sql-auth-literal')
    expect(
      detectRecognizableSqlCredential("CREATE OR REPLACE USER admin WITH PASSWORD 'SecPg';", 'postgres')
    ).toBe('sql-auth-literal')
    expect(
      detectRecognizableSqlCredential("ALTER ROLE dev WITH PASSWORD NULL;", 'postgres')
    ).toBeNull()
    expect(
      detectRecognizableSqlCredential("ALTER USER u IDENTIFIED WITH mysql_native_password BY 'SecPlug';", 'mysql')
    ).toBe('sql-auth-literal')
    expect(
      detectRecognizableSqlCredential('CREATE USER u IDENTIFIED BY RANDOM;', 'mysql')
    ).toBeNull()
    expect(
      detectRecognizableSqlCredential('CREATE USER u IDENTIFIED BY PASSWORD;', 'mysql')
    ).toBeNull()
    expect(
      detectRecognizableSqlCredential("SELECT E'ignore\\'me', $tag$ignored$tag$, $123, `col``1`, \"id\"\"2\" FROM t;")
    ).toBeNull()
    expect(detectRecognizableSqlCredential("SELECT E'unclosed_escape", 'postgres')).toBeNull()
    expect(detectRecognizableSqlCredential('SELECT $tag$unclosed_dollar', 'postgres')).toBeNull()
    expect(detectRecognizableSqlCredential('SELECT "unclosed_dq', 'postgres')).toBeNull()
    expect(detectRecognizableSqlCredential('SELECT `unclosed_bt', 'mysql')).toBeNull()
    expect(detectRecognizableSqlCredential("SELECT 'unclosed_sq", 'postgres')).toBeNull()
    expect(detectRecognizableSqlCredential('"col" a b;', 'postgres')).toBeNull()
    expect(detectRecognizableSqlCredential('SET PASSWORD FOR u = $1;', 'mysql')).toBeNull()
    expect(detectRecognizableSqlCredential('SET PASSWORD FOR u = [PASSWORD];', 'mysql')).toBeNull()
    expect(detectRecognizableSqlCredential('CREATE USER u PASSWORD $param;', 'postgres')).toBeNull()

    // URI inspection across schemes, HTTP endpoints, WS endpoints, cloud hosts, and malformed % escapes
    expect(detectRecognizableSqlCredential("SELECT 'ftp://u:sec@host/file';")).toBeNull()
    expect(detectRecognizableSqlCredential("SELECT 'postgres:///db';")).toBeNull()
    expect(detectRecognizableSqlCredential("SELECT 'postgres://u:YOUR_PASSWORD@db.example.com/app';")).toBeNull()
    expect(detectRecognizableSqlCredential("SELECT 'postgres://u:$1@db.example.com/app';")).toBeNull()
    expect(
      detectRecognizableSqlCredential("SELECT 'postgres://u:sec%E0%A4%A@db.example.com/app#p@w';")
    ).toBe('db-uri-credential')
    expect(
      detectRecognizableSqlCredential("SELECT 'http://u:p@[1:2:3:4:5:6:7:8:9]/db#a@b';")
    ).toBeNull()
    expect(detectRecognizableSqlCredential("SELECT 'rediss://default@h:6379?password=rsec';")).toBe(
      'db-uri-credential'
    )
    expect(
      detectRecognizableSqlCredential("SELECT 'clickhouses://h:8443?password=csec';")
    ).toBe('db-uri-credential')
    expect(
      detectRecognizableSqlCredential("SELECT 'libsql://h.turso.io?jwt=tok123';")
    ).toBe('db-uri-credential')
    expect(
      detectRecognizableSqlCredential("SELECT 'libsql://h.turso.io?token=tok123';")
    ).toBe('db-uri-credential')
    expect(
      detectRecognizableSqlCredential("SELECT 'd1+https://acct/db?apiToken=d1tok';")
    ).toBe('db-uri-credential')
    expect(
      detectRecognizableSqlCredential("SELECT 'd1://acct/db?api_token=d1tok';")
    ).toBe('db-uri-credential')
    expect(
      detectRecognizableSqlCredential("SELECT 'd1://acct/db';")
    ).toBeNull()
    expect(
      detectRecognizableSqlCredential("SELECT 'wss://db.turso.io?auth_token=wstok';")
    ).toBe('db-uri-credential')
    expect(
      detectRecognizableSqlCredential("SELECT 'ws://example.com:8080?jwt=ws8080';", 'libsql')
    ).toBe('db-uri-credential')
    expect(
      detectRecognizableSqlCredential("SELECT 'ws://example.com:8081?jwt=ws8081';", 'libsql')
    ).toBe('db-uri-credential')
    expect(
      detectRecognizableSqlCredential("SELECT 'ws://example.com/v2/x?jwt=wspath';", 'libsql')
    ).toBe('db-uri-credential')
    expect(
      detectRecognizableSqlCredential("SELECT 'ws://example.com/?jwt=ignored';", 'postgres')
    ).toBeNull()
    expect(
      detectRecognizableSqlCredential("SELECT 'http://127.0.0.1:8787/d1?token=locald1';", 'd1')
    ).toBe('db-uri-credential')
    expect(
      detectRecognizableSqlCredential("SELECT 'http://[::1]:8787/d1?apiToken=locald1';", 'd1')
    ).toBe('db-uri-credential')
    expect(
      detectRecognizableSqlCredential("SELECT 'https://api.cloudflare.com/client/v4/accounts/a/d1/database/b?api_token=cftok';")
    ).toBe('db-uri-credential')
    expect(
      detectRecognizableSqlCredential("SELECT 'https://api.cloudflare.com/client/v4/accounts/a/d1/database/b';")
    ).toBeNull()
    expect(
      detectRecognizableSqlCredential("SELECT 'http://localhost:8080/v2/pipeline?authToken=locallib';", 'libsql')
    ).toBe('db-uri-credential')
    expect(
      detectRecognizableSqlCredential("SELECT 'http://example.com:8080?auth_token=lib8080';", 'libsql')
    ).toBe('db-uri-credential')
    expect(
      detectRecognizableSqlCredential("SELECT 'http://example.com:8081?jwt=lib8081';", 'libsql')
    ).toBe('db-uri-credential')
    expect(
      detectRecognizableSqlCredential("SELECT 'http://example.com/v2/pipeline?jwt=libpipe';", 'libsql')
    ).toBe('db-uri-credential')
    expect(
      detectRecognizableSqlCredential("SELECT 'http://example.com/plain?jwt=no';", 'libsql')
    ).toBeNull()
    expect(
      detectRecognizableSqlCredential("SELECT 'https://ch.internal:8443?password=chp';")
    ).toBe('db-uri-credential')
    expect(
      detectRecognizableSqlCredential("SELECT 'http://ch.internal:8123/';")
    ).toBeNull()
    expect(
      detectRecognizableSqlCredential("SELECT 'http://ch.internal/?user=u&password=chp';", 'clickhouse')
    ).toBe('db-uri-credential')
    expect(
      detectRecognizableSqlCredential("SELECT 'http://ch.internal/?database=analytics&password=chp';", 'clickhouse')
    ).toBe('db-uri-credential')
    expect(
      detectRecognizableSqlCredential("SELECT 'https://u:sec@my.supabase.co/rest';")
    ).toBe('db-uri-credential')
    expect(
      detectRecognizableSqlCredential('CONNECT postgres://u:sec@db.example.com:5432/app')
    ).toBe('db-uri-credential')
    expect(
      detectRecognizableSqlCredential("SELECT 'postgres://u:sec%ZZ@';", 'postgres')
    ).toBeNull()

    // Property: scrubDriverErrorText idempotency & zero secret leakage
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9_]{3,10}$/),
        fc.stringMatching(/^[A-Za-z0-9!$_.]{4,12}$/),
        (user, secret) => {
          const fullSecret = `s_${secret}`
          const raw = `Error at postgres://${user}:${fullSecret}@db.internal:5432/app?token=${fullSecret}#fragSecret`
          const s1 = scrubDriverErrorText(raw)
          const s2 = scrubDriverErrorText(s1)
          expect(s2).toBe(s1)
          expect(s1).not.toContain(fullSecret)
          expect(s1).not.toContain('fragSecret')
        }
      ),
      { numRuns: 100 }
    )
  })
})

describe('Wave 1B-1: connection-uri.ts behavioral & property tests', () => {
  it('covers metadata helpers, TLS modes, comma seeds, cloud hosts, D1/LibSQL/ClickHouse/Redis/SQLite/SQL URIs, and scrubUrlCredentials', () => {
    expect(getEngineMetadata('postgres').defaultPort).toBe(5432)
    expect(() => getEngineMetadata('bogus' as DatabaseDriverType)).toThrow('Unsupported database driver')

    expect(isCloudDatabaseHost('')).toBe(false)
    expect(isCloudDatabaseHost('localhost')).toBe(false)
    expect(isCloudDatabaseHost('::1')).toBe(false)
    expect(isCloudDatabaseHost('ep-1.neon.tech')).toBe(true)
    expect(isSupabaseHost(null as unknown as string)).toBe(false)
    expect(isSupabaseHost('db.proj.supabase.co')).toBe(true)
    expect(isSupabaseDirectHost(null as unknown as string)).toBe(false)
    expect(isSupabaseDirectHost('db.proj.supabase.co')).toBe(true)
    expect(isSupabaseDirectHost('pooler.supabase.com')).toBe(false)

    expect(splitCommaSeedAuthority('rs1,rs2:abc')).toEqual({ primaryHostAndRest: 'rs1,rs2:abc' })
    expect(splitCommaSeedAuthority('rs1,rs2')).toEqual({
      primaryHostAndRest: 'rs1',
      authoritySeedList: 'rs1,rs2',
    })
    expect(splitCommaSeedAuthority('rs1,12345')).toEqual({ primaryHostAndRest: 'rs1,12345' })
    expect(splitCommaSeedAuthority('rs1,rs2:99999')).toEqual({ primaryHostAndRest: 'rs1,rs2:99999' })
    expect(splitCommaSeedAuthority('rs1:27017,rs2:27018/app')).toEqual({
      primaryHostAndRest: 'rs1:27017/app',
      authoritySeedList: 'rs1:27017,rs2:27018',
    })

    // resolveTlsSettings exhaustive mode & JSON branches
    for (const m of ['disable', 'disabled', 'false', '0', 'off', 'no']) {
      expect(resolveTlsSettings(new URLSearchParams(`sslmode=${m}`), true)).toEqual({
        ssl: false,
        sslMode: 'disable',
      })
    }
    expect(resolveTlsSettings(new URLSearchParams('sslmode=verify-full'), false).sslRejectUnauthorized).toBe(true)
    expect(resolveTlsSettings(new URLSearchParams('sslmode=verify-ca'), false).sslMode).toBe('verify-ca')
    expect(resolveTlsSettings(new URLSearchParams('sslmode=require'), false).sslRejectUnauthorized).toBe(false)
    expect(resolveTlsSettings(new URLSearchParams('sslmode=prefer'), false)).toEqual({ ssl: true })
    expect(resolveTlsSettings(new URLSearchParams('sslmode=invalid'), false).error).toContain('Unsupported sslmode')
    expect(resolveTlsSettings(new URLSearchParams('ssl={"rejectUnauthorized":true}'), false).sslMode).toBe('verify-full')
    expect(resolveTlsSettings(new URLSearchParams('ssl={"rejectUnauthorized":false}'), false).sslMode).toBe('require')
    expect(resolveTlsSettings(new URLSearchParams('ssl={"foo":"bar"}'), false)).toEqual({ ssl: true })
    expect(resolveTlsSettings(new URLSearchParams('ssl=[1,2]'), false)).toEqual({ ssl: true })
    expect(resolveTlsSettings(new URLSearchParams('ssl={bad'), false)).toEqual({ ssl: true })
    for (const f of ['false', '0', 'disable', 'disabled', 'off', 'no']) {
      expect(resolveTlsSettings(new URLSearchParams(`tls=${f}`), true)).toEqual({ ssl: false })
    }
    expect(resolveTlsSettings(new URLSearchParams('secure=yes'), false)).toEqual({ ssl: true })
    expect(resolveTlsSettings(new URLSearchParams('secure='), false)).toEqual({ ssl: false })

    // D1 & LibSQL endpoint validators
    expect(isD1HttpLoopbackEndpoint('')).toBe(false)
    expect(isD1HttpLoopbackEndpoint('not a url')).toBe(false)
    expect(isD1HttpLoopbackEndpoint('http://127.0.0.1:8787')).toBe(true)
    expect(validateD1EndpointUrl('')).toMatchObject({ ok: false })
    expect(validateD1EndpointUrl('https://api.cloudflare.com\x01')).toMatchObject({ ok: false })
    expect(validateD1EndpointUrl('not-url')).toMatchObject({ ok: false })
    expect(validateD1EndpointUrl('ftp://api.cloudflare.com')).toMatchObject({ ok: false })
    expect(validateD1EndpointUrl('https://u:p@api.cloudflare.com')).toMatchObject({ ok: false })
    expect(validateD1EndpointUrl('https://api.cloudflare.com?token=abc')).toMatchObject({ ok: false })
    expect(validateD1EndpointUrl('http://remote.example.com')).toMatchObject({ ok: false })
    expect(validateD1EndpointUrl('http://127.0.0.1:8787', { hasAuthToken: true })).toMatchObject({ ok: false })
    expect(validateD1EndpointUrl('https://api.cloudflare.com/client/v4/accounts/a/d1/database/b')).toMatchObject({ ok: true })

    expect(validateLibsqlEndpointUrl('')).toMatchObject({ ok: false })
    expect(validateLibsqlEndpointUrl('https://db.turso.io\x07')).toMatchObject({ ok: false })
    expect(validateLibsqlEndpointUrl('bad')).toMatchObject({ ok: false })
    expect(validateLibsqlEndpointUrl('ftp://db.turso.io')).toMatchObject({ ok: false })
    expect(validateLibsqlEndpointUrl('libsql://')).toMatchObject({ ok: false })
    expect(validateLibsqlEndpointUrl('https://u:p@db.turso.io')).toMatchObject({ ok: false })
    expect(validateLibsqlEndpointUrl('https://db.turso.io?jwt=x')).toMatchObject({ ok: false })
    expect(validateLibsqlEndpointUrl('http://remote.turso.io')).toMatchObject({ ok: false })
    expect(validateLibsqlEndpointUrl('http://localhost:8080', { hasAuthToken: true })).toMatchObject({ ok: false })

    // parseConnectionUri across engines, error cases, env assignment, quotes, bracketed pass, malformed %
    expect(parseConnectionUri('')).toMatchObject({ ok: false })
    expect(parseConnectionUri('not-a-uri')).toMatchObject({ ok: false })
    expect(parseConnectionUri('ftp://host/db')).toMatchObject({ ok: false })
    expect(parseConnectionUri('postgres://')).toMatchObject({ ok: false })
    expect(parseConnectionUri('postgres://host:0/db')).toMatchObject({ ok: false })
    expect(parseConnectionUri('postgres://host:99999/db')).toMatchObject({ ok: false })
    expect(parseConnectionUri('postgres:///db')).toMatchObject({ ok: false })
    expect(parseConnectionUri('DATABASE_URL="postgres://u:[My#Pass]@db.example.com/app?options=-c%20x=1"')).toMatchObject({
      ok: true,
      password: 'My#Pass',
      profile: { driver: 'postgres', options: '-c x=1' },
    })
    expect(parseConnectionUri("  'postgres://u:%E0%20@db.example.com/app'  ")).toMatchObject({
      ok: true,
    })
    expect(parseConnectionUri('postgres://u:[<PASSWORD>]@bad host')).toMatchObject({ ok: false })
    expect(parseConnectionUri('mongodb://u:[<PASSWORD>]@rs1,rs2/app')).toMatchObject({
      ok: true,
      placeholderPassword: true,
      profile: { driver: 'mongodb', url: 'mongodb://rs1,rs2/app' },
    })
    expect(parseConnectionUri('postgres://u:[real]@bad host')).toMatchObject({ ok: false })
    expect(parseConnectionUri('mongodb://u@rs1,rs2:notport/app')).toMatchObject({ ok: false })
    expect(parseConnectionUri('http://[aa%ZZ],rs2/app')).toMatchObject({ ok: false })
    expect(parseConnectionUri('mongodb://u@rs1,rs2')).toMatchObject({
      ok: true,
      profile: { driver: 'mongodb', url: 'mongodb://rs1,rs2' },
    })
    expect(parseConnectionUri('http:///nohost')).toMatchObject({
      ok: true,
      profile: { driver: 'clickhouse', host: 'nohost' },
    })
    expect(parseConnectionUri('postgres://u:<PASSWORD>@db.example.com/app')).toMatchObject({
      ok: true,
      placeholderPassword: true,
    })
    expect(parseConnectionUri('postgres://u:[<PASSWORD>]@db.example.com/app')).toMatchObject({
      ok: true,
      placeholderPassword: true,
      profile: { driver: 'postgres', host: 'db.example.com', database: 'app' },
    })
    expect(parseConnectionUri('http://u@rs1:notport,rs2/app')).toMatchObject({ ok: false })
    expect(parseConnectionUri('http://u@rs1:99999,rs2/app')).toMatchObject({ ok: false })
    expect(parseConnectionUri('http://[::1::2],rs2/app')).toMatchObject({ ok: false })
    expect(parseConnectionUri('mongodb://u@rs1,rs2/app')).toMatchObject({
      ok: true,
      profile: { driver: 'mongodb', url: 'mongodb://rs1,rs2/app' },
    })
    expect(parseConnectionUri('mssql://sa:p@db/app?encrypt=false').profile?.ssl).toBe(false)
    expect(parseConnectionUri('mssql://sa:p@db/app?encrypt=true&trustServerCertificate=false').profile?.sslRejectUnauthorized).toBe(true)
    expect(parseConnectionUri('mssql://sa:p@db/app?encrypt=true&trustServerCertificate=true').profile?.sslRejectUnauthorized).toBe(false)
    expect(parseConnectionUri('mssql://sa:p@db/app?encrypt=true').profile?.ssl).toBe(true)
    expect(parseConnectionUri('oracle://hr:p@db:1521/?serviceName=XEPDB1').profile?.database).toBe('')

    // Redis URI
    expect(parseConnectionUri('redis:///0')).toMatchObject({ ok: false })
    expect(parseConnectionUri('redis://h:0/0')).toMatchObject({ ok: false })
    expect(parseConnectionUri('redis://h:99999/0')).toMatchObject({ ok: false })
    expect(parseConnectionUri('redis://h/abc')).toMatchObject({ ok: false })
    expect(parseConnectionUri('redis://h/16')).toMatchObject({ ok: false })
    expect(parseConnectionUri('redis://h/1?sslmode=bad')).toMatchObject({ ok: false })
    expect(parseConnectionUri('rediss://default@h:6380?password=rpass&db=2')).toMatchObject({
      ok: true,
      password: 'rpass',
      profile: { driver: 'redis', redisDb: 2, ssl: true },
    })

    // ClickHouse URI
    expect(parseConnectionUri('clickhouse:///default')).toMatchObject({ ok: false })
    expect(parseConnectionUri('clickhouse://h?sslmode=bad')).toMatchObject({ ok: false })
    expect(parseConnectionUri('clickhouse://h:0/default')).toMatchObject({ ok: false })
    expect(parseConnectionUri('http://ch.local')).toMatchObject({
      ok: true,
      profile: { driver: 'clickhouse', database: 'default', port: 80, ssl: false },
    })
    expect(parseConnectionUri('https://u:p@ch.example.com:8443/?database=analytics')).toMatchObject({
      ok: true,
      profile: { driver: 'clickhouse', database: 'analytics', ssl: true },
    })

    // LibSQL URI
    expect(parseConnectionUri('libsql:///db')).toMatchObject({ ok: false })
    expect(parseConnectionUri('libsql://db.turso.io?sslmode=bad')).toMatchObject({ ok: false })
    expect(parseConnectionUri('libsql://db.turso.io:0')).toMatchObject({ ok: false })
    expect(parseConnectionUri('http://remote.turso.io?authToken=tok')).toMatchObject({ ok: false })
    expect(parseConnectionUri('https://my-db.turso.io/sub/?jwt=tok123')).toMatchObject({
      ok: true,
      authToken: 'tok123',
      profile: { driver: 'libsql', url: 'https://my-db.turso.io/sub' },
    })

    // D1 URI
    expect(parseConnectionUri('d1:///db')).toMatchObject({ ok: false })
    expect(parseConnectionUri('d1://acct1/')).toMatchObject({ ok: false })
    expect(parseConnectionUri('d1://acct1/db1?token=')).toMatchObject({ ok: true })
    expect(parseConnectionUri('d1://acct1/db1?endpoint=http://remote.host&token=tok')).toMatchObject({ ok: false })
    expect(parseConnectionUri('d1+https://acct1/db1?endpoint=https://api.cloudflare.com/client/v4/accounts/acct1/d1/database/db1&auth_token=tok1')).toMatchObject({
      ok: true,
      authToken: 'tok1',
      profile: { driver: 'd1', d1AccountId: 'acct1', d1DatabaseId: 'db1' },
    })

    // SQLite URI
    expect(parseConnectionUri('sqlite://')).toMatchObject({ ok: false })
    expect(parseConnectionUri('sqlite:///')).toMatchObject({ ok: false })
    expect(parseConnectionUri('sqlite://///')).toMatchObject({ ok: false })
    expect(parseConnectionUri('sqlite:local.db')).toMatchObject({
      ok: true,
      profile: { driver: 'sqlite', filePath: 'local.db', database: 'local.db' },
    })
    expect(parseConnectionUri('sqlite://localhost/C:/data/app.db?mode=ro')).toMatchObject({
      ok: true,
      profile: { driver: 'sqlite', filePath: 'C:/data/app.db', database: 'app.db', readOnly: true },
    })
    expect(parseConnectionUri('sqlite::memory:')).toMatchObject({
      ok: true,
      profile: { driver: 'sqlite', filePath: ':memory:', database: ':memory:' },
    })

    // scrubUrlCredentials edge cases
    expect(scrubUrlCredentials('   ')).toBeUndefined()
    expect(scrubUrlCredentials('not a url')).toBeUndefined()
    expect(scrubUrlCredentials('postgres://u:sec@host/db?%E0%A4%A=1&flagOnly&token=x#s?pwd=1&keep=2')).toBe(
      'postgres://host/db?%E0%A4%A=1&flagOnly#s?keep=2'
    )
    expect(scrubUrlCredentials('postgres://u:sec@host/db#?token=1')).toBe('postgres://host/db')

    // Property: parseConnectionUri -> scrubUrlCredentials never leaks password & keeps RFC 3986 literal '@'
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9_]{3,8}$/),
        fc.stringMatching(/^[A-Za-z0-9!$_.]{4,10}$/),
        fc.constantFrom('postgres', 'mysql', 'mariadb', 'mssql', 'oracle', 'mongodb'),
        (user, rawPass, scheme) => {
          const pass = `!${rawPass}`
          const uri = `${scheme}://${user}:${pass}@db.example.com/app?email=${user}@corp.io&token=${pass}`
          const parsed = parseConnectionUri(uri)
          expect(parsed.ok).toBe(true)
          expect(parsed.password).toBe(pass)
          const scrubbed = scrubUrlCredentials(uri)!
          expect(scrubbed).not.toContain(pass)
          expect(scrubbed).toContain(`email=${user}@corp.io`)
        }
      ),
      { numRuns: 100 }
    )
  })
})
