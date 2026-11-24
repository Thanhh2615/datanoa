import { describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import {
  analyzeSqliteTriggerReferences,
  containsDdlStatement,
  findStatementAtOffset,
  findTopLevelPostgresCastIndex,
  formatSql,
  formatSqlBinaryLiteral,
  formatSqlLiteral,
  hasBalancedParens,
  isIdentContChar,
  isIdentStartChar,
  isNumericOrBooleanTypeName,
  isPostgresEscapeStringStart,
  matchDollarQuoteTag,
  matchMysqlExecCommentPrefix,
  normalizeJsonValue,
  normalizeSqlDefaultExpression,
  quoteIdentForDialect,
  quoteTableReference,
  resolveSqlExecutionSpan,
  resolveSqlReplacementSpan,
  scanBlockCommentEnd,
  scanLineCommentEnd,
  scanOracleQuoteEnd,
  scanQuotedSegmentEnd,
  splitSqlStatements,
  stripCommentsAndLiterals,
  stripLeadingSqlComments,
  supportsDollarQuoting,
  supportsNestedBlockComments,
  usesBackslashAndHash,
  validateColumnTypeSpec,
} from '../src/shared-sql-core.js'

describe('Wave 1B-2a: src/shared-sql-core.js', () => {
  it('handles dialect predicates, quoting, JSON normalization, binary/value literals, and primitive scanners', () => {
    expect(usesBackslashAndHash('mysql')).toBe(true)
    expect(usesBackslashAndHash('postgres')).toBe(false)
    expect(supportsNestedBlockComments('cockroachdb')).toBe(true)
    expect(supportsDollarQuoting('postgres')).toBe(true)

    expect(matchMysqlExecCommentPrefix('/*!50001 SELECT 1 */', 0, 'mysql')).toBe(8)
    expect(matchMysqlExecCommentPrefix('/*M!100301 SELECT 1 */', 0, 'mariadb')).toBe(10)
    expect(matchMysqlExecCommentPrefix('/* normal */', 0, 'mysql')).toBe(0)
    expect(matchMysqlExecCommentPrefix('SELECT', 0, 'mysql')).toBe(0)
    expect(matchMysqlExecCommentPrefix('/*!1*/', 0, 'postgres')).toBe(0)

    expect(isPostgresEscapeStringStart("E'abc'", 0, 'postgres')).toBe(true)
    expect(isPostgresEscapeStringStart("SE'abc'", 1, 'postgres')).toBe(false)
    expect(isPostgresEscapeStringStart('E', 0, 'postgres')).toBe(false)
    expect(isPostgresEscapeStringStart("E'abc'", 0, 'mysql')).toBe(false)

    expect(quoteIdentForDialect('a]b', 'mssql')).toBe('[a]]b]')
    expect(quoteIdentForDialect('a`b', 'mysql')).toBe('`a``b`')
    expect(quoteIdentForDialect('a"b', 'postgres')).toBe('"a""b"')

    expect(quoteTableReference('   ', 'postgres')).toBe('"table_name"')
    expect(quoteTableReference('[dbo].[users]]1]', 'mssql')).toBe('[dbo].[users]]1]')
    expect(quoteTableReference('[unclosed', 'mssql')).toBe('[[unclosed]')
    expect(quoteTableReference('[][a]', 'mssql')).toBe('[[]][a]]]')
    expect(quoteTableReference('[a][b]', 'mssql')).toBe('[[a]][b]]]')
    expect(quoteTableReference('[x].[y]', 'mssql')).toBe('[x].[y]')
    expect(quoteTableReference('[a].', 'mssql')).toBe('[[a]].]')
    expect(quoteTableReference('"public"."users"', 'mysql')).toBe('`public`.`users`')
    expect(quoteTableReference('`a``b`.`c`', 'postgres')).toBe('"a`b"."c"')
    expect(quoteTableReference('"unclosed', 'postgres')).toBe('"""unclosed"')
    expect(quoteTableReference('""."a"', 'postgres')).toBe('""""".""a"""')
    expect(quoteTableReference('"a""b"x', 'postgres')).toBe('"""a""""b""x"')
    expect(quoteTableReference('"a".', 'postgres')).toBe('"""a""."')
    expect(quoteTableReference('""', 'postgres')).toBe('""""""')
    expect(quoteTableReference('public.users', 'postgres')).toBe('"public"."users"')
    expect(quoteTableReference('plain_tbl', 'postgres')).toBe('"plain_tbl"')

    expect(normalizeJsonValue(undefined)).toBeNull()
    expect(normalizeJsonValue(NaN)).toBeNull()
    expect(normalizeJsonValue(42n)).toBe(42)
    expect(normalizeJsonValue(9007199254740995n)).toBe('9007199254740995')
    expect(normalizeJsonValue(new Date('invalid'))).toBeNull()
    expect(normalizeJsonValue(new Date('2025-01-01T00:00:00.000Z'))).toBe('2025-01-01T00:00:00.000Z')
    expect(normalizeJsonValue(new Uint8Array([0x0a, 0xff]).buffer)).toBe('0aff')
    expect(normalizeJsonValue(new Uint8Array([0x01, 0x02]).subarray(1))).toBe('02')
    expect(normalizeJsonValue([1, () => {}, Symbol('s')])).toEqual([1, null, null])
    expect(normalizeJsonValue({ a: 1, b: undefined, fn: () => {} })).toEqual({ a: 1 })
    expect(normalizeJsonValue(Symbol('top'))).toBeNull()

    expect(formatSqlBinaryLiteral('0a', 'postgres')).toBe("E'\\\\x0a'::bytea")
    expect(formatSqlBinaryLiteral('0a', 'clickhouse')).toBe("unhex('0a')")
    expect(formatSqlBinaryLiteral('0a', 'mssql')).toBe('0x0a')
    expect(formatSqlBinaryLiteral('0a', 'oracle')).toBe("HEXTORAW('0a')")
    expect(formatSqlBinaryLiteral('0a', 'sqlite')).toBe("X'0a'")

    expect(formatSqlLiteral(null, 'postgres')).toBe('NULL')
    expect(formatSqlLiteral(true, 'mssql')).toBe('1')
    expect(formatSqlLiteral(false, 'postgres')).toBe('FALSE')
    expect(formatSqlLiteral(Infinity, 'postgres')).toBe('NULL')
    expect(formatSqlLiteral(7n, 'postgres')).toBe('7')
    expect(formatSqlLiteral(new Date('invalid'), 'postgres')).toBe('NULL')
    expect(formatSqlLiteral(new Date('2025-01-01T00:00:00.000Z'), 'postgres')).toBe("'2025-01-01T00:00:00.000Z'")
    expect(formatSqlLiteral(new Uint8Array([0xab]), 'sqlite')).toBe("X'ab'")
    expect(formatSqlLiteral({ k: 'v' }, 'postgres')).toBe('\'{"k":"v"}\'')
    expect(formatSqlLiteral('a\0b', 'sqlite')).toBe("'a' || char(0) || 'b'")
    expect(formatSqlLiteral("a\\b'c\0", 'mysql')).toBe("'a\\\\b''c\\0'")

    expect(isIdentStartChar(65)).toBe(true)
    expect(isIdentContChar(48)).toBe(true)
    expect(matchDollarQuoteTag('abc', 0)).toBeNull()
    expect(matchDollarQuoteTag('a$t$', 1)).toBeNull()
    expect(matchDollarQuoteTag('$', 0)).toBeNull()
    expect(matchDollarQuoteTag('$$', 0)).toBe('$$')
    expect(matchDollarQuoteTag('$1', 0)).toBeNull()
    expect(matchDollarQuoteTag('$tag$x', 0)).toBe('$tag$')
    expect(matchDollarQuoteTag('$unclosed', 0)).toBeNull()

    expect(scanOracleQuoteEnd("q'[a]'", 0, 'postgres')).toBeNull()
    expect(scanOracleQuoteEnd("nq'{a}'", 0, 'oracle')).toEqual({ end: 7, closed: true })
    expect(scanOracleQuoteEnd("q' 1'", 0, 'oracle')).toBeNull()
    expect(scanOracleQuoteEnd("xq'[a]'", 1, 'oracle')).toBeNull()
    expect(scanOracleQuoteEnd("q'<unclosed", 0, 'oracle')).toEqual({ end: 11, closed: false })
    expect(scanQuotedSegmentEnd("'a\\'b''c'", 0, "'", true)).toEqual({ end: 9, closed: true })
    expect(scanQuotedSegmentEnd("'unclosed", 0, "'", false)).toEqual({ end: 9, closed: false })
    expect(scanLineCommentEnd('-- hi\n', 0)).toBe(6)
    expect(scanLineCommentEnd('-- eof', 0)).toBe(6)
    expect(scanBlockCommentEnd('/* a /* b */ c */', 0, true)).toBe(17)
    expect(scanBlockCommentEnd('/* unclosed', 0, false)).toBe(11)

    fc.assert(
      fc.property(
        fc.string({ maxLength: 20 }),
        fc.constantFrom('postgres', 'mysql', 'mssql', 'sqlite'),
        (ident, dialect) => {
          const quoted = quoteIdentForDialect(ident, dialect)
          if (dialect === 'mssql') {
            expect(quoted.startsWith('[') && quoted.endsWith(']')).toBe(true)
          } else if (dialect === 'mysql') {
            expect(quoted.startsWith('`') && quoted.endsWith('`')).toBe(true)
          } else {
            expect(quoted.startsWith('"') && quoted.endsWith('"')).toBe(true)
          }
        }
      ),
      { numRuns: 100 }
    )
  })

  it('splits MongoDB shell, compound SQL/DELIMITER scripts, tracks caret offsets, and detects DDL', () => {
    const mongoScript =
      "// lead\n/* blk */ db.users.find({ name: `hi ${'w' + { a: 1 }.a /* inner */}!`, re: /a[x\\]b\\/\\nc/gi, n: 1_0, op: 4/2 });\n" +
      'db.orders.insertOne({ a: return /x/i, b: /bad\n, c: /bad2\\\n });'
    const mongoStmts = splitSqlStatements(mongoScript, 'mongodb')
    expect(mongoStmts.length).toBe(2)

    expect(
      splitSqlStatements('db.t.find({ re: /ok\\\\n/, arr: [1, 2] })', 'mongodb').length
    ).toBe(1)

    const mysqlCompound =
      'DELIMITER //\n' +
      'CREATE TRIGGER tr BEFORE INSERT ON t FOR EACH ROW BEGIN CASE NEW.x WHEN 1 THEN SET @a = 1; END CASE; END //\n' +
      'DELIMITER ;\n' +
      'CREATE PROCEDURE p() BEGIN SELECT 1; END;\n' +
      "/*!50001 SELECT 1; */ -- c\n# hash\nSELECT 'a';"
    const mysqlSlices = splitSqlStatements(mysqlCompound, 'mysql')
    expect(mysqlSlices.length).toBe(3)

    const sqliteTrig =
      'CREATE TRIGGER tr1 AFTER INSERT ON items BEGIN\n' +
      '  BEGIN TRANSACTION;\n' +
      '  UPDATE stats SET c = CASE WHEN NEW.v > 0 THEN 1 ELSE 0 END WHERE 1 = 1;\n' +
      'END;\n' +
      'CREATE PROCEDURE dummy BEGIN SELECT 1; END IF; END;'
    expect(splitSqlStatements(sqliteTrig, 'sqlite').length).toBe(2)

    const pgMulti =
      "CREATE FUNCTION f() RETURNS void AS $$ SELECT 1; $$ LANGUAGE sql; -- cmt\n" +
      "SELECT E'x\\'y', $a$unclosed"
    const pgSlices = splitSqlStatements(pgMulti, 'postgres')
    expect(pgSlices.length).toBe(2)

    const mssqlScript = 'SELECT [a]]b] FROM t; /* unclosed */'
    const mssqlSlices = splitSqlStatements(mssqlScript, 'mssql')
    expect(mssqlSlices.length).toBe(1)

    const oracleScript = "SELECT q'[a;b]' FROM dual; /* c */ SELECT 2 FROM dual;"
    const oracleSlices = splitSqlStatements(oracleScript, 'oracle')
    expect(oracleSlices.length).toBe(2)
    expect(findStatementAtOffset('', 0, 'postgres')).toBe('')
    expect(findStatementAtOffset('SELECT 1; SELECT 2', 3, 'postgres')).toBe('SELECT 1')
    expect(findStatementAtOffset('SELECT 1;   SELECT 2', 9, 'postgres')).toBe('SELECT 1')
    expect(findStatementAtOffset('SELECT 1;   SELECT 2', 11, 'postgres')).toBe('SELECT 2')
    expect(findStatementAtOffset('SELECT 1;', 99, 'postgres')).toBe('SELECT 1')
    expect(findStatementAtOffset('SELECT 1; SELECT 2', 9, 'postgres')).toBe('SELECT 1')
    expect(findStatementAtOffset('SELECT 1\n\nSELECT 2', 9, 'postgres')).toBe('SELECT 1\n\nSELECT 2')
    expect(findStatementAtOffset('DELIMITER //\nSELECT 1 //  SELECT 2', 21, 'mysql')).toBe('SELECT 1')
    expect(findStatementAtOffset('DELIMITER //\nSELECT 1 //  SELECT 2', 24, 'mysql')).toBe('SELECT 2')

    expect(stripLeadingSqlComments('  -- a\n# b\n/* c */ /*!50001 SELECT 1 */', 'mysql')).toBe(
      '/*!50001 SELECT 1 */'
    )
    expect(stripLeadingSqlComments('  /* only */  ', 'postgres')).toBe('')

    expect(
      stripCommentsAndLiterals(
        "/*!50001 SELECT */ -- a\n# b\n/* c */ E'e' q'[o]' [br] $t$d$t$ $bad",
        'mysql',
        true
      )
    ).toBeDefined()
    expect(
      stripCommentsAndLiterals("/*!50001 SELECT */ E'x' q'[o]' [b] $$d$$", 'postgres', false)
    ).toBeDefined()
    expect(stripCommentsAndLiterals("q'(a)'", 'oracle')).toBe(' ')
    expect(stripCommentsAndLiterals('[b]', 'mssql')).toBe(' ')

    expect(containsDdlStatement('', 'postgres')).toBe(false)
    expect(containsDdlStatement('FLUSHDB', 'redis')).toBe(false)
    expect(containsDdlStatement('SELECT 1; CREATE TABLE t(a INT)', 'postgres')).toBe(true)
    expect(containsDdlStatement('  -- cmt\n123; (SELECT 1)', 'postgres')).toBe(false)
    expect(containsDdlStatement('{ "create": "logs" }', 'mongodb')).toBe(true)
    expect(containsDdlStatement("db.runCommand({ 'drop': 'logs' })", 'mongodb')).toBe(true)
    expect(containsDdlStatement('db.logs.createIndex({ a: 1 }, { unique: true })', 'mongodb')).toBe(true)
    expect(containsDdlStatement('db.logs.find({ a: 1 })', 'mongodb')).toBe(false)
    expect(containsDdlStatement('otherCall()', 'mongodb')).toBe(false)
    expect(containsDdlStatement('{ 1: "x" }', 'mongodb')).toBe(false)

    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (sql) => {
        const slices = splitSqlStatements(sql, 'postgres')
        for (let i = 0; i < slices.length; i++) {
          expect(slices[i].start).toBeGreaterThanOrEqual(0)
          expect(slices[i].end).toBeLessThanOrEqual(sql.length)
          expect(slices[i].end).toBeGreaterThan(slices[i].start)
          if (i > 0) expect(slices[i].start).toBeGreaterThanOrEqual(slices[i - 1].end)
        }
      }),
      { numRuns: 100 }
    )
  })

  it('normalizes defaults, validates column types, formats multi-clause SQL, and analyzes SQLite triggers', () => {
    expect(findTopLevelPostgresCastIndex("'a''b::text'::varchar(10)")).toBe(12)
    expect(findTopLevelPostgresCastIndex('"col""1"::[x]::int')).toBe(13)
    expect(hasBalancedParens("('a''b')")).toBe(true)
    expect(hasBalancedParens('(a))(', false)).toBe(false)
    expect(hasBalancedParens('(a)(b)', true)).toBe(false)
    expect(isNumericOrBooleanTypeName('DECIMAL(10,2)')).toBe(true)
    expect(isNumericOrBooleanTypeName(undefined)).toBe(false)

    expect(normalizeSqlDefaultExpression('', 'TEXT')).toBe('')
    expect(() => normalizeSqlDefaultExpression('1; DROP TABLE x', 'INT')).toThrow(/invalid SQL tokens/)
    expect(normalizeSqlDefaultExpression("'42'", 'INT')).toBe("'42'")
    expect(normalizeSqlDefaultExpression("'true'", 'BOOLEAN')).toBe("'true'")
    expect(() => normalizeSqlDefaultExpression("'abc'", 'INT')).toThrow(/Invalid default/)
    expect(normalizeSqlDefaultExpression('(1 + 2)', 'INT')).toBe('(1 + 2)')
    expect(() => normalizeSqlDefaultExpression('(1)(2)', 'INT')).toThrow(/parenthesized/)
    expect(() => normalizeSqlDefaultExpression('(SELECT 1)', 'INT')).toThrow(/cannot contain SQL queries/)
    expect(normalizeSqlDefaultExpression("X'deadbeef'", 'BLOB')).toBe("X'deadbeef'")
    expect(normalizeSqlDefaultExpression("'{}'::jsonb", 'JSONB')).toBe("'{}'::jsonb")
    expect(normalizeSqlDefaultExpression('NULL', 'TEXT')).toBe('NULL')
    expect(normalizeSqlDefaultExpression('CURRENT_TIMESTAMP', 'TIMESTAMP')).toBe('CURRENT_TIMESTAMP')
    expect(() => normalizeSqlDefaultExpression('ARRAY[SELECT 1]', 'TEXT[]')).toThrow(/function expression/)
    expect(normalizeSqlDefaultExpression('"abc"', 'TEXT')).toBe("'abc'")
    expect(() => normalizeSqlDefaultExpression('"abc"', 'INT')).toThrow(/Numeric\/boolean/)
    expect(normalizeSqlDefaultExpression("hash#val'", 'TEXT')).toBe("'hash#val'''")
    expect(() => normalizeSqlDefaultExpression("1 # OR 1", 'TEXT')).toThrow(/Invalid SQL default/)
    expect(() => normalizeSqlDefaultExpression('bad', 'INT')).toThrow(/Invalid default/)
    expect(() => normalizeSqlDefaultExpression('SELECT', 'TEXT')).toThrow(/Invalid SQL keyword/)
    expect(normalizeSqlDefaultExpression('plain', 'TEXT')).toBe("'plain'")

    expect(() => validateColumnTypeSpec('')).toThrow(/required/)
    expect(validateColumnTypeSpec("ENUM('a','b')")).toBe("ENUM('a','b')")
    expect(() => validateColumnTypeSpec("ENUM('a','b') -- c")).toThrow()
    expect(() => validateColumnTypeSpec('INT; DROP')).toThrow(/Invalid SQL column type/)
    expect(() => validateColumnTypeSpec('VARCHAR(10) SELECT')).toThrow(/Invalid SQL keyword/)
    expect(validateColumnTypeSpec('VARCHAR(255)[]')).toBe('VARCHAR(255)[]')

    expect(formatSql('', 'postgres')).toBe('')
    expect(formatSql('  GET mykey  ', 'redis')).toBe('GET mykey')
    expect(formatSql('  /* cmt */  ', 'postgres')).toBe('/* cmt */')
    const formatted = formatSql(
      "select distinct u.id, -1.5e+2, u.data->>'k', count(*) from users u left outer join orders o on u.id = o.uid where u.age between -10 and +20 and u.ok = true or u.flag <= 1 -- end\n/* blk */;\ninsert into t values (1, -2); (select 3);",
      'postgres'
    )
    expect(formatted).toContain('SELECT DISTINCT\n  u.id,')
    expect(formatted).toContain('LEFT OUTER JOIN')
    expect(formatted).toContain('WHERE u.age BETWEEN -10 AND +20\n  AND')
    expect(formatted).toContain('INSERT INTO t')

    expect(
      formatSql("SELECT a /* blk */ FROM t; # m\nSELECT 1+-2, E'a', q'[b]'", 'mysql')
    ).toContain('SELECT a')
    expect(formatSql('SELECT [col], 1.5 + .5, - .5 FROM t ORDER BY a DESC', 'mssql')).toContain(
      'ORDER BY'
    )
    expect(formatSql('SELECT $$a$$ FROM t', 'postgres')).toContain('$$a$$')
    expect(formatSql("SELECT q'[x]' FROM dual", 'oracle')).toContain("q'[x]'")

    expect(analyzeSqliteTriggerReferences('', 'users')).toEqual({
      referencesOrigTableInBody: false,
      onTargetTable: null,
      onTargetMatchesOrigTable: false,
      referencedIdents: [],
    })
    const trigInfo = analyzeSqliteTriggerReferences(
      'CREATE TRIGGER tr_upd AFTER UPDATE OF "col1", [col2] ON main."users""v1" ' +
        '-- cmt\n /* blk */ FOR EACH ROW WHEN NEW."col1" IS NOT NULL BEGIN ' +
        'UPDATE "users""v1" SET c = NEW.id; INSERT INTO "audit`x" VALUES (\'ignored\'); END;',
      'users"v1',
      ['col1', 'col2', '', 'audit`x', 'col1']
    )
    expect(trigInfo).toEqual({
      referencesOrigTableInBody: true,
      onTargetTable: 'users"v1',
      onTargetMatchesOrigTable: true,
      referencedIdents: ['col1', 'col2', 'audit`x'],
    })
    expect(
      analyzeSqliteTriggerReferences('CREATE TRIGGER t2 AFTER DELETE ON [items] BEGIN UPDATE other SET a = OLD.items; END', 'items', null as unknown as string[])
    ).toMatchObject({
      referencesOrigTableInBody: false,
      onTargetTable: 'items',
      onTargetMatchesOrigTable: true,
    })

    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (raw) => {
        expect(() => formatSql(raw, 'postgres')).not.toThrow()
      }),
      { numRuns: 100 }
    )
    const canonical = formatSql('select id, name from users where active = true and age > 10', 'postgres')
    expect(formatSql(canonical, 'postgres')).toBe(canonical)

    // Remaining reachable shared-sql-core.js branches:
    expect(matchMysqlExecCommentPrefix('/*m!100301 SELECT 1 */', 0, 'mariadb')).toBe(10)
    expect(quoteTableReference('[a].b', 'mssql')).toBe('[[a]].b]')
    expect(quoteTableReference('"a".b', 'postgres')).toBe('"""a"".b"')
    expect(formatSqlLiteral(false, 'mssql')).toBe('0')
    expect(scanOracleQuoteEnd("q'", 0, 'oracle')).toBeNull()
    expect(scanOracleQuoteEnd("nqX'a'", 0, 'oracle')).toBeNull()
    expect(splitSqlStatements('db.t.find("unclosed)', 'mongodb').length).toBe(1)
    expect(splitSqlStatements('db.t.find(/unclosed)', 'mongodb').length).toBe(1)
    expect(
      splitSqlStatements(
        '  DELIMITER //\nCREATE TRIGGER t1 BEGIN SELECT 1; END //\nDELIMITER ;',
        'mysql'
      ).length
    ).toBe(1)
    expect(splitSqlStatements('CREATE TRIGGER t2 BEGIN   ', 'mysql').length).toBe(1)
    expect(splitSqlStatements('CREATE TRIGGER t3 BEGIN (1); END;', 'mysql').length).toBe(1)
    expect(
      splitSqlStatements(
        'CREATE TRIGGER t4 BEFORE UPDATE ON u FOR EACH ROW BEGIN CASE WHEN 1 THEN SELECT 1; END CASE; END;',
        'mysql'
      ).length
    ).toBe(1)
    expect(splitSqlStatements('CREATE TRIGGER t5 SELECT CASE WHEN 1 THEN 1 END;', 'sqlite').length).toBe(1)
    expect(stripCommentsAndLiterals('$tag$unclosed', 'postgres')).toBe(' ')
    expect(containsDdlStatement('{', 'mongodb')).toBe(false)
    expect(containsDdlStatement('CREATE TABLE x (id INT)', 'postgres')).toBe(true)
    expect(containsDdlStatement(';', 'postgres')).toBe(false)
    expect(normalizeSqlDefaultExpression(null as unknown as string, 'TEXT')).toBe('')
    expect(() => validateColumnTypeSpec("ENUM('a;b')")).toThrow(/Invalid SQL column type/)
    expect(
      formatSql("SELECT /* cmt */ -1+2, +.5, '1'::int, 'x' -5, E'it\\'s' FROM t", 'postgres')
    ).toContain('::int')
    expect(formatSql('-5', 'postgres')).toBe('-5')
    expect(formatSql('SELECT a; SELECT b, c FROM t', 'postgres')).toContain('SELECT a;')
    expect(formatSql('SELECT $u$unclosed', 'postgres')).toBe('SELECT $u$unclosed')
    expect(
      analyzeSqliteTriggerReferences('CREATE TRIGGER t1 AFTER INSERT ON', 't1')
    ).toMatchObject({ onTargetTable: null })
    expect(formatSql('SELECT COALESCE(1, 2), a FROM t', 'postgres')).toContain('COALESCE(1, 2)')
    expect(formatSql('SELECT a', 'postgres')).toBe('SELECT a')
    expect(formatSql('SELECT 1-2 FROM t', 'postgres')).toContain('1 - 2')
    expect(() =>
      analyzeSqliteTriggerReferences(
        null as unknown as string,
        null as unknown as string,
        [123 as unknown as string, 'col1']
      )
    ).not.toThrow()
    expect(
      analyzeSqliteTriggerReferences('CREATE TRIGGER t1 AFTER INSERT ON "unclosed', 'tbl')
    ).toMatchObject({ onTargetTable: 'unclosed' })
    expect(
      analyzeSqliteTriggerReferences('CREATE TRIGGER t1 AFTER INSERT ON `back``unclosed', 'tbl')
    ).toMatchObject({ onTargetTable: 'back`unclosed' })
    expect(
      analyzeSqliteTriggerReferences('CREATE TRIGGER t1 AFTER INSERT ON [bkt_unclosed', 'tbl')
    ).toMatchObject({ onTargetTable: 'bkt_unclosed' })
    expect(
      analyzeSqliteTriggerReferences('CREATE TRIGGER t1 AFTER INSERT ON t1 DELETE FROM log', 't1')
    ).toMatchObject({ onTargetTable: 't1' })
    expect(
      analyzeSqliteTriggerReferences('CREATE TRIGGER t1 BEGIN SELECT 1; END', 't1')
    ).toMatchObject({ onTargetTable: null })
  })

  it('formats multi-CTE PostgreSQL queries with window OVER(), FILTER, JOIN ON, GROUP/ORDER lists, subqueries, and comments cleanly and idempotently', () => {
    const rawThreeCteQuery = [
      "with completed_orders as (-- 1. Lọc các đơn hàng hoàn tất trong năm gần nhất",
      "select o.id as order_id, o.customer_id, o.order_date, sum(oi.quantity * oi.unit_price) as order_total from orders o inner join order_items oi on oi.order_id = o.id where o.status = 'completed' and o.order_date >= current_date - interval '12 months' group by o.id, o.customer_id, o.order_date),",
      "monthly_customer_spend as (-- 2. Tổng hợp chi tiêu theo tháng cho từng khách hàng",
      "select c.id as customer_id, c.segment, date_trunc('month', co.order_date) as spend_month, count(*) filter (where co.order_total >= 1000) as high_value_orders, sum(co.order_total) as monthly_revenue from completed_orders co inner join customers c on c.id = co.customer_id group by c.id, c.segment, date_trunc('month', co.order_date)),",
      "ranked_and_trended as (-- 3. Xếp hạng khách hàng và tính lũy kế doanh thu theo phân khúc",
      "select segment, customer_id, spend_month, high_value_orders, monthly_revenue, rank() over (partition by segment, spend_month order by monthly_revenue desc) as revenue_rank, sum(monthly_revenue) over (partition by segment, customer_id order by spend_month rows between unbounded preceding and current row) as cumulative_revenue from monthly_customer_spend)",
      "-- 4. Lọc lấy Top 3 khách hàng mỗi phân khúc theo tháng",
      "select segment, customer_id, spend_month, high_value_orders, round(monthly_revenue, 2) as monthly_revenue, round(cumulative_revenue, 2) as cumulative_revenue from ranked_and_trended where revenue_rank <= 3 order by segment asc, spend_month desc, revenue_rank asc;",
    ].join('\n')

    const formatted = formatSql(rawThreeCteQuery, 'postgres')

    // 1. Properly indented CTE blocks & breaks between CTEs
    expect(formatted).toContain(
      'WITH completed_orders AS (\n  -- 1. Lọc các đơn hàng hoàn tất trong năm gần nhất\n  SELECT\n    o.id AS order_id,'
    )
    expect(formatted).toContain('),\nmonthly_customer_spend AS (\n  -- 2.')
    expect(formatted).toContain('),\nranked_and_trended AS (\n  -- 3.')

    // 2. FILTER (WHERE ...) preserves space before '('
    expect(formatted).toContain('COUNT(*) FILTER (WHERE co.order_total >= 1000)')
    expect(formatted).not.toContain('FILTER(')

    // 3. Multi-clause window OVER (...) expands onto cleanly indented lines while keeping ROWS BETWEEN ... AND ... intact
    expect(formatted).toContain(
      '    rank() OVER (\n      PARTITION BY segment, spend_month\n      ORDER BY monthly_revenue DESC\n    ) AS revenue_rank,'
    )
    expect(formatted).toContain(
      '    SUM(monthly_revenue) OVER (\n      PARTITION BY segment, customer_id\n      ORDER BY spend_month\n      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW\n    ) AS cumulative_revenue'
    )

    // 4. Clean INNER JOIN ... ON ... and multi-line GROUP BY / ORDER BY
    expect(formatted).toContain('  INNER JOIN order_items oi\n    ON oi.order_id = o.id')
    expect(formatted).toContain('  GROUP BY\n    o.id,\n    o.customer_id,\n    o.order_date')
    expect(formatted).toContain('ORDER BY\n  segment ASC,\n  spend_month DESC,\n  revenue_rank ASC;')

    // 5. Comment -- 4. sits on its own line above SELECT (never glued onto ')' or SELECT)
    expect(formatted).toContain(
      ')\n-- 4. Lọc lấy Top 3 khách hàng mỗi phân khúc theo tháng\nSELECT\n  segment,'
    )
    expect(formatted).not.toContain(') -- 4.')
    expect(formatted).not.toContain('SELECTsegment')

    // 6. Regular function calls stay compact inline
    expect(formatted).toContain("date_trunc('month', co.order_date)")
    expect(formatted).toContain('round(monthly_revenue, 2)')

    // 7. 100% idempotent
    expect(formatSql(formatted, 'postgres')).toBe(formatted)

    // 8. Nested subqueries (EXISTS, IN, FROM subquery) & crisp single-clause OVER () / single-item ORDER BY
    const subqueries = formatSql(
      "select u.id, u.name, row_number() over (order by u.id), count(*) over () from (select id, name, org_id, active from users where active = true) u where exists (select 1 from orders o where o.user_id = u.id and o.total > 100) and u.org_id in (select id from orgs where tier = 'pro') order by u.id desc",
      'postgres'
    )
    expect(subqueries).toContain('row_number() OVER (ORDER BY u.id)')
    expect(subqueries).toContain('COUNT(*) OVER ()')
    expect(subqueries).toContain('FROM (\n  SELECT\n    id,\n    name,\n    org_id,\n    active\n  FROM users\n  WHERE active = TRUE\n) u')
    expect(subqueries).toContain(
      'WHERE EXISTS (\n  SELECT 1\n  FROM orders o\n  WHERE o.user_id = u.id\n    AND o.total > 100\n)'
    )
    expect(subqueries).toContain(
      "  AND u.org_id IN (\n    SELECT id\n    FROM orgs\n    WHERE tier = 'pro'\n  )"
    )
    expect(subqueries).toContain('ORDER BY u.id DESC')
    expect(formatSql(subqueries, 'postgres')).toBe(subqueries)

    // 9. WITHIN GROUP, LATERAL subquery, RECURSIVE / MATERIALIZED / writable CTE, CASE WHEN ... AND ... END, USING + ON CONFLICT
    const advanced = formatSql(
      "with recursive tree(id, parent_id) as materialized (select id, parent_id from nodes where parent_id is null union all select n.id, n.parent_id from nodes n inner join tree t on t.id = n.parent_id), agg as not materialized (select dept, percentile_cont(0.5) within group (order by salary) as med, case when count(*) > 5 and sum(salary) > 100 then 'high' else 'low' end as band from emp group by dept) select a.dept, a.med, l.val from agg a left join lateral (select val from logs where logs.dept = a.dept order by created_at desc limit 1) l on true;",
      'postgres'
    )
    expect(advanced).toContain('WITH RECURSIVE tree(id, parent_id) AS MATERIALIZED (\n  SELECT\n    id,\n    parent_id')
    expect(advanced).toContain('),\nagg AS NOT MATERIALIZED (\n  SELECT\n    dept,\n    percentile_cont(0.5) WITHIN GROUP (ORDER BY salary) AS med,')
    expect(advanced).toContain("CASE WHEN COUNT(*) > 5 AND SUM(salary) > 100 THEN 'high' ELSE 'low' END AS band")
    expect(advanced).toContain('LEFT JOIN LATERAL (\n  SELECT val\n  FROM logs\n  WHERE logs.dept = a.dept\n  ORDER BY created_at DESC\n  LIMIT 1\n) l\n  ON TRUE;')
    expect(formatSql(advanced, 'postgres')).toBe(advanced)

    const upsertUsing = formatSql(
      'insert into target select a.id from a join b using (id) on conflict (id) do nothing;',
      'postgres'
    )
    expect(upsertUsing).toContain('JOIN b USING (id) ON CONFLICT (id) DO NOTHING;')
    expect(formatSql(upsertUsing, 'postgres')).toBe(upsertUsing)

    const writableCte = formatSql(
      'with deleted as (delete from logs where created_at < now() returning id, created_at) insert into archive select id, created_at from deleted;',
      'postgres'
    )
    expect(writableCte).toContain('WITH deleted AS (\n  DELETE FROM logs\n  WHERE created_at < now()\n  RETURNING id, created_at\n)\nINSERT INTO archive')
    expect(formatSql(writableCte, 'postgres')).toBe(writableCte)

    const commentEdgeCases = formatSql(
      "with a as (\n-- lead\nselect\n  -- col1\n  x, -- after comma\n  y\nfrom t\n-- tail\n),\n-- between ctes\nb as (select 1)\n-- before main\nselect * from b -- end\n;",
      'postgres'
    )
    expect(commentEdgeCases).toContain('WITH a AS (\n  -- lead\n  SELECT\n    -- col1\n    x,')
    expect(commentEdgeCases).toContain('),\n-- between ctes\nb AS (\n  SELECT 1\n)\n-- before main\nSELECT *\nFROM b -- end\n;')
    expect(formatSql(commentEdgeCases, 'postgres')).toBe(commentEdgeCases)
  })

  it('resolves SQL execution spans identically across all, selection, explain, redis, and multi-statement caret modes', () => {
    const paddedScript = '  SELECT 1;\n  SELECT 2;  '
    // 1. mode === 'all' returns full trimmed span (ignoring non-empty selection)
    expect(
      resolveSqlExecutionSpan(paddedScript, { from: 2, to: 10, empty: false }, 'all', 'sqlite')
    ).toEqual({
      from: 2,
      to: 23,
      sql: 'SELECT 1;\n  SELECT 2;',
      originalSlice: 'SELECT 1;\n  SELECT 2;',
    })
    expect(resolveSqlExecutionSpan('   \n\t  ', null, 'all', 'sqlite')).toBeNull()

    // 2. Non-empty selection trims surrounding whitespace and overrides 'explain' and 'redis'
    const explainDoc = 'SELECT 1;\n  SELECT * FROM users  ;\nSELECT 2;'
    const selStart = explainDoc.indexOf('  SELECT * FROM users  ')
    const selEnd = selStart + '  SELECT * FROM users  '.length
    const expectedSelectedSpan = {
      from: selStart + 2,
      to: selStart + 2 + 'SELECT * FROM users'.length,
      sql: 'SELECT * FROM users',
      originalSlice: 'SELECT * FROM users',
    }
    expect(
      resolveSqlExecutionSpan(explainDoc, { from: selStart, to: selEnd }, 'caret', 'postgres')
    ).toEqual(expectedSelectedSpan)
    expect(
      resolveSqlExecutionSpan(
        explainDoc,
        { from: selStart, to: selEnd, empty: false },
        'explain',
        'postgres'
      )
    ).toEqual(expectedSelectedSpan)
    expect(
      resolveSqlExecutionSpan(
        '  GET k1\nSET k2 v2  ',
        { from: 2, to: 8, empty: false },
        'caret',
        'redis'
      )
    ).toEqual({
      from: 2,
      to: 8,
      sql: 'GET k1',
      originalSlice: 'GET k1',
    })

    // Explicit empty: true does not use selection range
    expect(
      resolveSqlExecutionSpan(
        'SELECT 1; SELECT 2;',
        { from: 10, to: 18, head: 2, empty: true },
        'caret',
        'sqlite'
      )
    ).toEqual({
      from: 0,
      to: 8,
      sql: 'SELECT 1',
      originalSlice: 'SELECT 1',
    })

    // 3. Whitespace-only selection falls through to caret / explain / redis
    const wsGapDoc = 'SELECT 1;   SELECT 2;'
    expect(
      resolveSqlExecutionSpan(wsGapDoc, { from: 9, to: 12, head: 12, empty: false }, 'caret', 'sqlite')
    ).toEqual({
      from: 12,
      to: 20,
      sql: 'SELECT 2',
      originalSlice: 'SELECT 2',
    })
    expect(
      resolveSqlExecutionSpan(wsGapDoc, { from: 9, to: 12, head: 12, empty: false }, 'explain', 'sqlite')
    ).toEqual({
      from: 0,
      to: 21,
      sql: 'SELECT 1;   SELECT 2;',
      originalSlice: 'SELECT 1;   SELECT 2;',
    })
    expect(
      resolveSqlExecutionSpan('  GET a   SET b 1  ', { from: 7, to: 10, empty: false }, 'caret', 'redis')
    ).toEqual({
      from: 2,
      to: 17,
      sql: 'GET a   SET b 1',
      originalSlice: 'GET a   SET b 1',
    })

    // 4. 'explain' and 'redis' without selection return full trimmed doc
    expect(resolveSqlExecutionSpan('  SELECT 1; SELECT 2;  ', null, 'explain', 'postgres')).toEqual({
      from: 2,
      to: 21,
      sql: 'SELECT 1; SELECT 2;',
      originalSlice: 'SELECT 1; SELECT 2;',
    })
    expect(resolveSqlExecutionSpan('  HGETALL user:1  ', undefined, 'caret', 'redis')).toEqual({
      from: 2,
      to: 16,
      sql: 'HGETALL user:1',
      originalSlice: 'HGETALL user:1',
    })

    // 5. Multi-statement caret bounds and ';' gap tie-breaking
    // Indices: "SELECT 1" = [0,8), "  ;  " = [8,13), semiBoundary = 11, "SELECT 2" = [13,21)
    const gapDoc = 'SELECT 1  ;  SELECT 2'
    expect(resolveSqlExecutionSpan(gapDoc, null, 'caret', 'postgres')).toEqual({
      from: 0,
      to: 8,
      sql: 'SELECT 1',
      originalSlice: 'SELECT 1',
    })
    expect(resolveSqlExecutionSpan(gapDoc, { from: 8, to: 8, head: 8 }, 'caret', 'postgres')?.sql).toBe('SELECT 1')
    expect(resolveSqlExecutionSpan(gapDoc, { from: 11, to: 11, head: 11 }, 'caret', 'postgres')?.sql).toBe('SELECT 1')
    expect(resolveSqlExecutionSpan(gapDoc, { from: 12, to: 12, head: 12 }, 'caret', 'postgres')?.sql).toBe('SELECT 2')
    expect(resolveSqlExecutionSpan(gapDoc, { from: 999, to: 999, head: 999 }, 'caret', 'postgres')?.sql).toBe('SELECT 2')
    expect(resolveSqlExecutionSpan(gapDoc, { from: -10, to: -10, head: -10 }, 'caret', 'postgres')?.sql).toBe('SELECT 1')

    // Gap without ';' (MySQL DELIMITER //) ties at stmt.end
    const delimDoc = 'DELIMITER //\nSELECT 1 //  SELECT 2'
    const s1End = delimDoc.indexOf('SELECT 1') + 'SELECT 1'.length
    expect(resolveSqlExecutionSpan(delimDoc, { from: s1End, to: s1End, head: s1End }, 'caret', 'mysql')?.sql).toBe('SELECT 1')
    expect(resolveSqlExecutionSpan(delimDoc, { from: s1End + 1, to: s1End + 1, head: s1End + 1 }, 'caret', 'mysql')?.sql).toBe('SELECT 2')

    // Comment-only script returns null in caret mode
    expect(resolveSqlExecutionSpan('  -- only comment\n/* block */  ', { from: 0, to: 0 }, 'caret', 'sqlite')).toBeNull()

    // Dialect awareness (Postgres dollar quotes & MongoDB regexes containing ';')
    const pgDollar = 'SELECT $$a;b$$; SELECT 2;'
    expect(resolveSqlExecutionSpan(pgDollar, { from: 10, to: 10, head: 10 }, 'caret', 'postgres')).toEqual({
      from: 0,
      to: 14,
      sql: 'SELECT $$a;b$$',
      originalSlice: 'SELECT $$a;b$$',
    })
    const mongoDoc = 'db.users.find({ re: /a;b/i }); db.orders.find({});'
    expect(resolveSqlExecutionSpan(mongoDoc, { from: 22, to: 22, head: 22 }, 'caret', 'mongodb')).toEqual({
      from: 0,
      to: 29,
      sql: 'db.users.find({ re: /a;b/i })',
      originalSlice: 'db.users.find({ re: /a;b/i })',
    })
  })

  it('resolves SQL replacement spans safely across exact match, unique fallback, multi-stmt refusal, redis fallback, and semicolon dedup', () => {
    const multiDoc = 'SELECT 1;\nSELECT * FROM bad_tbl;\nSELECT 2;'

    // 1. Empty / whitespace replacement returns null
    expect(resolveSqlReplacementSpan(multiDoc, { from: 10, to: 31 }, '   ', 'sqlite')).toBeNull()

    // 2. Priority 1: Exact range + matching originalSlice + trailing ';' dedup
    const exactEdit = resolveSqlReplacementSpan(
      multiDoc,
      { from: 10, to: 31, originalSlice: 'SELECT * FROM bad_tbl', fallbackSql: 'SELECT * FROM bad_tbl' },
      '  SELECT * FROM good_tbl;  ',
      'sqlite'
    )
    expect(exactEdit).toEqual({
      from: 10,
      to: 32,
      insert: 'SELECT * FROM good_tbl;',
    })
    if (exactEdit) {
      expect(
        `${multiDoc.slice(0, exactEdit.from)}${exactEdit.insert}${multiDoc.slice(exactEdit.to)}`
      ).toBe('SELECT 1;\nSELECT * FROM good_tbl;\nSELECT 2;')
    }

    // Without trailing ';' in nextSql, existing ';' in doc is preserved
    const noSemiEdit = resolveSqlReplacementSpan(
      multiDoc,
      { from: 10, to: 31, originalSlice: 'SELECT * FROM bad_tbl' },
      'SELECT * FROM good_tbl',
      'sqlite'
    )
    expect(noSemiEdit).toEqual({
      from: 10,
      to: 31,
      insert: 'SELECT * FROM good_tbl',
    })
    if (noSemiEdit) {
      expect(
        `${multiDoc.slice(0, noSemiEdit.from)}${noSemiEdit.insert}${multiDoc.slice(noSemiEdit.to)}`
      ).toBe('SELECT 1;\nSELECT * FROM good_tbl;\nSELECT 2;')
    }

    // Priority 1 with omitted or empty originalSlice accepts valid bounds
    expect(
      resolveSqlReplacementSpan(multiDoc, { from: 10, to: 31 }, 'SELECT 99', 'sqlite')
    ).toEqual({ from: 10, to: 31, insert: 'SELECT 99' })
    expect(
      resolveSqlReplacementSpan(multiDoc, { from: 10, to: 31, originalSlice: '' }, 'SELECT 99', 'sqlite')
    ).toEqual({ from: 10, to: 31, insert: 'SELECT 99' })

    // 3. Priority 2: Stale originalSlice (shifted offsets) falls back to unique fallbackSql
    const shiftedDoc = '-- header\n' + multiDoc
    const fallbackEdit = resolveSqlReplacementSpan(
      shiftedDoc,
      { from: 10, to: 31, originalSlice: 'SELECT * FROM bad_tbl', fallbackSql: 'SELECT * FROM bad_tbl' },
      'SELECT * FROM fixed_tbl;',
      'sqlite'
    )
    const expectedStart = shiftedDoc.indexOf('SELECT * FROM bad_tbl')
    expect(fallbackEdit).toEqual({
      from: expectedStart,
      to: expectedStart + 'SELECT * FROM bad_tbl'.length + 1,
      insert: 'SELECT * FROM fixed_tbl;',
    })
    if (fallbackEdit) {
      expect(
        `${shiftedDoc.slice(0, fallbackEdit.from)}${fallbackEdit.insert}${shiftedDoc.slice(fallbackEdit.to)}`
      ).toBe('-- header\nSELECT 1;\nSELECT * FROM fixed_tbl;\nSELECT 2;')
    }

    // 4. Priority 2 rejects non-unique fallbackSql -> Priority 3 refuses multi-statement overwrite
    const dupDoc = 'SELECT * FROM bad_tbl;\nSELECT * FROM bad_tbl;'
    expect(
      resolveSqlReplacementSpan(
        dupDoc,
        { from: -1, to: -1, fallbackSql: 'SELECT * FROM bad_tbl' },
        'SELECT * FROM fixed_tbl;',
        'sqlite'
      )
    ).toBeNull()

    // Stale range + missing fallback in multi-statement script returns null
    expect(
      resolveSqlReplacementSpan(
        multiDoc,
        { from: 10, to: 31, originalSlice: 'STALE', fallbackSql: 'SELECT * FROM missing' },
        'SELECT 42;',
        'sqlite'
      )
    ).toBeNull()

    // 5. Priority 2 exact multi-statement fallback match preserves outer whitespace when padded
    expect(
      resolveSqlReplacementSpan(
        `  ${multiDoc}  `,
        { from: -1, to: -1, fallbackSql: multiDoc },
        'SELECT 100;',
        'sqlite'
      )
    ).toEqual({
      from: 2,
      to: 2 + multiDoc.length,
      insert: 'SELECT 100;',
    })
    expect(
      resolveSqlReplacementSpan(
        multiDoc,
        { from: -1, to: -1, fallbackSql: `  ${multiDoc}  ` },
        'SELECT 100;',
        'sqlite'
      )
    ).toEqual({
      from: 0,
      to: multiDoc.length,
      insert: 'SELECT 100;',
    })

    // Priority 3: Single-statement doc replaces 0..docLen even when stale/missing target
    const singleDoc = '  SELECT * FROM old_tbl;  '
    expect(
      resolveSqlReplacementSpan(
        singleDoc,
        { from: -1, to: -1, fallbackSql: 'SELECT something_else' },
        'SELECT * FROM new_tbl;',
        'postgres'
      )
    ).toEqual({
      from: 0,
      to: singleDoc.length,
      insert: 'SELECT * FROM new_tbl;',
    })
    expect(resolveSqlReplacementSpan('   ', null, 'SELECT 1;', 'sqlite')).toEqual({
      from: 0,
      to: 3,
      insert: 'SELECT 1;',
    })

    // Priority 3: Redis treats full doc as single statement even with semicolons/newlines
    const redisDoc = 'SET a 1; GET a\nDEL a'
    expect(
      resolveSqlReplacementSpan(
        redisDoc,
        { from: -1, to: -1, fallbackSql: 'UNMATCHED' },
        'GET a',
        'redis'
      )
    ).toEqual({
      from: 0,
      to: redisDoc.length,
      insert: 'GET a',
    })
  })

  it('satisfies structural invariants for resolveSqlExecutionSpan and resolveSqlReplacementSpan across arbitrary inputs', () => {
    const dialectArb = fc.constantFrom<'sqlite' | 'postgres' | 'mysql' | 'redis' | 'mongodb'>(
      'sqlite',
      'postgres',
      'mysql',
      'redis',
      'mongodb'
    )
    const modeArb = fc.constantFrom<'caret' | 'all' | 'explain'>('caret', 'all', 'explain')

    fc.assert(
      fc.property(
        fc.string({ maxLength: 80 }),
        fc.option(
          fc.record({
            from: fc.integer({ min: -5, max: 85 }),
            to: fc.integer({ min: -5, max: 85 }),
            head: fc.option(fc.integer({ min: -5, max: 85 }), { nil: undefined }),
            empty: fc.option(fc.boolean(), { nil: undefined }),
          }),
          { nil: null }
        ),
        modeArb,
        dialectArb,
        (doc, selection, mode, dialect) => {
          const span = resolveSqlExecutionSpan(doc, selection, mode, dialect)
          if (span !== null) {
            expect(span.from).toBeGreaterThanOrEqual(0)
            expect(span.to).toBeLessThanOrEqual(doc.length)
            expect(span.to).toBeGreaterThan(span.from)
            expect(span.sql.length).toBeGreaterThan(0)
            expect(doc.slice(span.from, span.to)).toBe(span.originalSlice)
            expect(span.originalSlice.trim()).toBe(span.sql)
          }
        }
      ),
      { numRuns: 150 }
    )

    fc.assert(
      fc.property(
        fc.string({ maxLength: 80 }),
        fc.option(
          fc.record({
            from: fc.integer({ min: -5, max: 85 }),
            to: fc.integer({ min: -5, max: 85 }),
            originalSlice: fc.option(fc.string({ maxLength: 20 }), { nil: undefined }),
            fallbackSql: fc.option(fc.string({ maxLength: 20 }), { nil: undefined }),
          }),
          { nil: null }
        ),
        fc.string({ maxLength: 40 }),
        dialectArb,
        (doc, target, nextSql, dialect) => {
          const edit = resolveSqlReplacementSpan(doc, target, nextSql, dialect)
          if (!nextSql.trim()) {
            expect(edit).toBeNull()
            return
          }
          if (edit !== null) {
            expect(edit.from).toBeGreaterThanOrEqual(0)
            expect(edit.to).toBeLessThanOrEqual(doc.length)
            expect(edit.to).toBeGreaterThanOrEqual(edit.from)
            expect(edit.insert).toBe(nextSql.trim())
          }
        }
      ),
      { numRuns: 150 }
    )

    // Round-trip property: execution span feeds cleanly into replacement span without double semicolons
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('SELECT 1', 'SELECT 2', 'SELECT a FROM t', 'UPDATE t SET x = 1'), {
          minLength: 1,
          maxLength: 4,
        }),
        fc.integer({ min: 0, max: 120 }),
        fc.boolean(),
        (stmts, caretOffset, appendSemi) => {
          const doc = `${stmts.join(';\n')};`
          const span = resolveSqlExecutionSpan(
            doc,
            { from: caretOffset, to: caretOffset, head: caretOffset, empty: true },
            'caret',
            'sqlite'
          )
          expect(span).not.toBeNull()
          const nextSql = appendSemi ? 'SELECT 999;' : 'SELECT 999'
          const edit = resolveSqlReplacementSpan(
            doc,
            span ? { ...span, fallbackSql: span.sql } : null,
            nextSql,
            'sqlite'
          )
          expect(edit).not.toBeNull()
          if (edit) {
            expect(edit.from).toBe(span?.from)
            const patched = `${doc.slice(0, edit.from)}${edit.insert}${doc.slice(edit.to)}`
            expect(patched).not.toContain(';;')
            expect(splitSqlStatements(patched, 'sqlite').length).toBe(stmts.length)
          }
        }
      ),
      { numRuns: 100 }
    )
  })
})
