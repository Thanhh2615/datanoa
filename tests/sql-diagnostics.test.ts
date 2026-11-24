import { describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import {
  analyzeSqlDiagnostics,
  extractDbSyntaxErrorDiagnostic,
  type SqlDiagnostic,
} from '../src/shared-sql-diagnostics.js'

function sliceOf(doc: string, diag: SqlDiagnostic): string {
  return doc.slice(diag.from, diag.to)
}

describe('shared-sql-diagnostics: guards & non-SQL dialects', () => {
  it('returns [] for empty, whitespace-only, comment-only, and oversized docs', () => {
    expect(analyzeSqlDiagnostics('')).toEqual([])
    expect(analyzeSqlDiagnostics('   \n\t  ')).toEqual([])
    expect(analyzeSqlDiagnostics('-- just a comment\n/* block comment */')).toEqual([])
    expect(analyzeSqlDiagnostics('SELECT ' + 'a'.repeat(100_005))).toEqual([])
  })

  it('skips non-SQL dialects completely', () => {
    const weird = "SELCT ((( 'unclosed /* open"
    expect(analyzeSqlDiagnostics(weird, { dialect: 'redis' })).toEqual([])
    expect(analyzeSqlDiagnostics(weird, { dialect: 'mongodb' })).toEqual([])
    expect(analyzeSqlDiagnostics(weird, { dialect: 'elasticsearch' })).toEqual([])
    expect(analyzeSqlDiagnostics(weird, { dialect: 'neo4j' })).toEqual([])
    expect(analyzeSqlDiagnostics(weird, { dialect: 'REDIS' })).toEqual([])
  })

  it('caps diagnostics at 25 and returns them sorted by from', () => {
    const manyErrors = Array.from({ length: 40 }, () => 'SELECT a,, b FROM t;').join('\n')
    const diags = analyzeSqlDiagnostics(manyErrors, { dialect: 'postgres' })
    expect(diags).toHaveLength(25)
    for (let i = 1; i < diags.length; i++) {
      expect(diags[i].from).toBeGreaterThanOrEqual(diags[i - 1].from)
    }
  })
})

describe('shared-sql-diagnostics: lexer rules (strings, identifiers, comments, parens)', () => {
  it('detects unterminated single-quoted strings and caps span at line end or 24 chars', () => {
    const shortDoc = "SELECT 'hello"
    const shortDiags = analyzeSqlDiagnostics(shortDoc, { dialect: 'postgres' })
    expect(shortDiags).toHaveLength(1)
    expect(shortDiags[0].code).toBe('unterminated-string')
    expect(shortDiags[0].severity).toBe('error')
    expect(sliceOf(shortDoc, shortDiags[0])).toBe("'hello")

    const longDoc = "SELECT 'this is a very long unterminated string literal on one line\nFROM users"
    const longDiags = analyzeSqlDiagnostics(longDoc, { dialect: 'postgres' })
    expect(longDiags.some((d) => d.code === 'unterminated-string')).toBe(true)
    const strDiag = longDiags.find((d) => d.code === 'unterminated-string')!
    expect(strDiag.from).toBe(7)
    expect(strDiag.to - strDiag.from).toBeLessThanOrEqual(24)
  })

  it('handles dialect-specific string escapes, PG E-strings, dollar-quotes, MSSQL N-strings, Oracle q-quotes', () => {
    expect(analyzeSqlDiagnostics("SELECT 'it''s fine' FROM t", { dialect: 'sqlite' })).toEqual([])
    expect(analyzeSqlDiagnostics("SELECT E'it\\'s ok\\n' FROM t", { dialect: 'postgres' })).toEqual([])
    expect(analyzeSqlDiagnostics("SELECT 'a\\' FROM t", { dialect: 'postgres' })).toEqual([])
    expect(analyzeSqlDiagnostics("SELECT 'it\\'s ok', 'end\\\\' FROM t", { dialect: 'mysql' })).toEqual([])
    expect(analyzeSqlDiagnostics("SELECT 'it\\'s ok' FROM t", { dialect: 'mariadb' })).toEqual([])
    expect(analyzeSqlDiagnostics("SELECT 'it\\'s ok' FROM t", { dialect: 'clickhouse' })).toEqual([])
    expect(analyzeSqlDiagnostics("SELECT 'it\\'s ok' FROM t", { dialect: 'snowflake' })).toEqual([])
    expect(analyzeSqlDiagnostics("SELECT 'it\\'s ok' FROM t", { dialect: 'bigquery' })).toEqual([])
    expect(analyzeSqlDiagnostics("SELECT N'Xin chào' FROM [dbo].[users]", { dialect: 'mssql' })).toEqual([])
    expect(
      analyzeSqlDiagnostics(
        "SELECT q'[it's ok]', q'(a'b)', q'{c'd}', q'<e'f>' FROM dual",
        { dialect: 'oracle' }
      )
    ).toEqual([])

    const unclosedDollar = 'SELECT $fn$ BEGIN SELCT 1;'
    const dollarDiags = analyzeSqlDiagnostics(unclosedDollar, { dialect: 'postgres' })
    expect(dollarDiags).toHaveLength(1)
    expect(dollarDiags[0].code).toBe('unterminated-string')
    expect(dollarDiags[0].from).toBe(7)

    const validDollar = `
      CREATE OR REPLACE FUNCTION f() RETURNS void AS $body$
      BEGIN
        -- never report inside dollar-quoted bodies even if pseudo-code appears
        SELCT * FORM whatever;
      END;
      $body$ LANGUAGE plpgsql;
    `
    expect(analyzeSqlDiagnostics(validDollar, { dialect: 'postgres' })).toEqual([])
  })

  it('detects unterminated quoted identifiers and treats [...] as identifier ONLY in MSSQL', () => {
    const dq = 'SELECT "unclosed FROM t'
    const dqDiags = analyzeSqlDiagnostics(dq, { dialect: 'postgres' })
    expect(dqDiags.some((d) => d.code === 'unterminated-identifier')).toBe(true)

    const bt = 'SELECT `unclosed FROM t'
    const btDiags = analyzeSqlDiagnostics(bt, { dialect: 'mysql' })
    expect(btDiags.some((d) => d.code === 'unterminated-identifier')).toBe(true)

    const brMssql = 'SELECT [unclosed FROM dbo.users'
    const brMssqlDiags = analyzeSqlDiagnostics(brMssql, { dialect: 'mssql' })
    expect(brMssqlDiags.some((d) => d.code === 'unterminated-identifier')).toBe(true)

    const brMssqlEnd = 'SELECT [dbo].[unclosed'
    const brMssqlEndDiags = analyzeSqlDiagnostics(brMssqlEnd, { dialect: 'mssql' })
    expect(brMssqlEndDiags.some((d) => d.code === 'unterminated-identifier')).toBe(true)

    // Balanced [ ] in non-MSSQL dialects must never be treated as unterminated identifier
    expect(analyzeSqlDiagnostics('SELECT arr[1], ARRAY[1, 2, 3] FROM t', { dialect: 'postgres' })).toEqual([])
    expect(analyzeSqlDiagnostics('SELECT [1, 2, 3][1] FROM t', { dialect: 'duckdb' })).toEqual([])
    expect(analyzeSqlDiagnostics('SELECT arr[OFFSET(0)] FROM t', { dialect: 'bigquery' })).toEqual([])
  })

  it('detects unterminated block comments with span on /* and supports nested comments in PG/CockroachDB/DuckDB', () => {
    const doc = 'SELECT 1 /* unclosed comment'
    const diags = analyzeSqlDiagnostics(doc, { dialect: 'sqlite' })
    expect(diags).toHaveLength(1)
    expect(diags[0].code).toBe('unterminated-comment')
    expect(sliceOf(doc, diags[0])).toBe('/*')

    const nestedValid = 'SELECT /* outer /* inner */ still outer */ 1'
    expect(analyzeSqlDiagnostics(nestedValid, { dialect: 'postgres' })).toEqual([])
    expect(analyzeSqlDiagnostics(nestedValid, { dialect: 'cockroachdb' })).toEqual([])
    expect(analyzeSqlDiagnostics(nestedValid, { dialect: 'duckdb' })).toEqual([])

    const nestedUnclosed = 'SELECT /* outer /* inner */ still open'
    const nestedDiags = analyzeSqlDiagnostics(nestedUnclosed, { dialect: 'postgres' })
    expect(nestedDiags).toHaveLength(1)
    expect(nestedDiags[0].code).toBe('unterminated-comment')
    expect(sliceOf(nestedUnclosed, nestedDiags[0])).toBe('/*')

    // Hash comments in MySQL/MariaDB/ClickHouse/BigQuery only
    expect(analyzeSqlDiagnostics("SELECT 1 # 'unclosed in comment\nFROM t", { dialect: 'mysql' })).toEqual([])
    expect(analyzeSqlDiagnostics("SELECT 1 # 'unclosed in comment\nFROM t", { dialect: 'mariadb' })).toEqual([])
    expect(analyzeSqlDiagnostics("SELECT 1 # 'unclosed in comment\nFROM t", { dialect: 'clickhouse' })).toEqual([])
    expect(analyzeSqlDiagnostics("SELECT 1 # 'unclosed in comment\nFROM t", { dialect: 'bigquery' })).toEqual([])
    // In Postgres, # is an operator, not a comment
    expect(analyzeSqlDiagnostics("SELECT data #> '{a,b}' FROM t", { dialect: 'postgres' })).toEqual([])
  })

  it('detects unmatched closing and unclosed opening parentheses', () => {
    const extraClose = 'SELECT (1 + 2)) FROM t'
    const closeDiags = analyzeSqlDiagnostics(extraClose)
    expect(closeDiags).toHaveLength(1)
    expect(closeDiags[0].code).toBe('unmatched-paren')
    expect(sliceOf(extraClose, closeDiags[0])).toBe(')')
    expect(closeDiags[0].from).toBe(14)

    const extraOpen = 'SELECT ((1 + 2) FROM t'
    const openDiags = analyzeSqlDiagnostics(extraOpen)
    expect(openDiags).toHaveLength(1)
    expect(openDiags[0].code).toBe('unmatched-paren')
    expect(sliceOf(extraOpen, openDiags[0])).toBe('(')
    expect(openDiags[0].from).toBe(7)
  })
})

describe('shared-sql-diagnostics: active-cursor typing grace', () => {
  it('does not flicker while typing valid SQL keyword prefixes at cursor', () => {
    for (const prefix of ['S', 'SE', 'SEL', 'SELE', 'SELEC']) {
      expect(
        analyzeSqlDiagnostics(prefix, { dialect: 'postgres', cursorOffset: prefix.length })
      ).toEqual([])
    }
    const midQuery = 'SELECT * FROM users WH'
    expect(
      analyzeSqlDiagnostics(midQuery, { dialect: 'postgres', cursorOffset: midQuery.length })
    ).toEqual([])

    const midLimit = 'SELECT * FROM users LIM'
    expect(
      analyzeSqlDiagnostics(midLimit, { dialect: 'postgres', cursorOffset: midLimit.length })
    ).toEqual([])
  })

  it('flags non-prefix close typos even when cursor is right on the token', () => {
    const typo = 'SELCT'
    const diags = analyzeSqlDiagnostics(typo, { dialect: 'postgres', cursorOffset: 5 })
    expect(diags).toHaveLength(1)
    expect(diags[0].code).toBe('unknown-keyword')
    expect(diags[0].suggestion).toBe('SELECT')
    expect(sliceOf(typo, diags[0])).toBe('SELCT')
  })

  it('suppresses EOF incomplete-clause while typing right on/after keyword, but flags with semicolon or cursor moved away', () => {
    expect(
      analyzeSqlDiagnostics('SELECT * FROM ', { dialect: 'postgres', cursorOffset: 14 })
    ).toEqual([])
    expect(
      analyzeSqlDiagnostics('SELECT * FROM', { dialect: 'postgres', cursorOffset: 13 })
    ).toEqual([])
    expect(
      analyzeSqlDiagnostics('SELECT * FROM users WHERE ', { dialect: 'postgres', cursorOffset: 26 })
    ).toEqual([])
    expect(
      analyzeSqlDiagnostics('SELECT * FROM users WHERE id = 1 AND ', {
        dialect: 'postgres',
        cursorOffset: 37,
      })
    ).toEqual([])

    // Semicolon explicitly terminates dangling clause -> always flag
    const withSemi = analyzeSqlDiagnostics('SELECT * FROM;', {
      dialect: 'postgres',
      cursorOffset: 14,
    })
    expect(withSemi.some((d) => d.code === 'incomplete-clause')).toBe(true)

    // Cursor moved earlier -> flag EOF dangling clause
    const cursorMoved = analyzeSqlDiagnostics('SELECT * FROM', {
      dialect: 'postgres',
      cursorOffset: 7,
    })
    expect(cursorMoved.some((d) => d.code === 'incomplete-clause')).toBe(true)

    // No cursorOffset provided -> flag EOF dangling clause
    const noCursor = analyzeSqlDiagnostics('SELECT * FROM', { dialect: 'postgres' })
    expect(noCursor.some((d) => d.code === 'incomplete-clause')).toBe(true)
  })
})

describe('shared-sql-diagnostics: statement starters & starter typos', () => {
  it('flags misspelled statement starters with exact suggestions', () => {
    const cases: Array<[string, string, string]> = [
      ['SELCT * FROM users', 'SELCT', 'SELECT'],
      ['UPADTE users SET a = 1', 'UPADTE', 'UPDATE'],
      ['DELTE FROM users WHERE id = 1', 'DELTE', 'DELETE'],
      ['INSRET INTO users VALUES (1)', 'INSRET', 'INSERT'],
      ['CRATE TABLE t (id INT)', 'CRATE', 'CREATE'],
      ['ALETR TABLE t ADD COLUMN x INT', 'ALETR', 'ALTER'],
      ['DRPO TABLE t', 'DRPO', 'DROP'],
      ['EXLAIN SELECT 1', 'EXLAIN', 'EXPLAIN'],
      ['TRUNCTAE TABLE t', 'TRUNCTAE', 'TRUNCATE'],
    ]

    for (const [sql, badTok, expected] of cases) {
      const diags = analyzeSqlDiagnostics(sql, { dialect: 'postgres' })
      const hit = diags.find((d) => d.code === 'unknown-keyword')
      expect(hit, `Expected unknown-keyword for: ${sql}`).toBeDefined()
      expect(sliceOf(sql, hit!)).toBe(badTok)
      expect(hit!.suggestion).toBe(expected)
    }
  })

  it('flags completely unrecognizable multi-token statement starters as unexpected-statement-start', () => {
    const sql = 'FOOBAR * FROM users'
    const diags = analyzeSqlDiagnostics(sql, { dialect: 'postgres' })
    expect(diags).toHaveLength(1)
    expect(diags[0].code).toBe('unexpected-statement-start')
    expect(sliceOf(sql, diags[0])).toBe('FOOBAR')
  })

  it('allows all valid multi-dialect SQL statement starters including parenthesized queries', () => {
    const validStarters = [
      '(SELECT 1) UNION (SELECT 2)',
      'WITH cte AS (SELECT 1) SELECT * FROM cte',
      'VALUES (1, 2), (3, 4)',
      'TABLE users',
      'PRAGMA table_info(users)',
      'SHOW TABLES',
      'DESCRIBE users',
      'DESC users',
      'EXPLAIN SELECT 1',
      'BEGIN; COMMIT; ROLLBACK;',
      'START TRANSACTION; COMMIT;',
      'SET search_path TO public',
      'USE mydb',
      'CALL my_proc(1)',
      'EXEC dbo.my_proc',
      'DO $$ BEGIN PERFORM 1; END $$',
      'DECLARE @a INT',
      'COPY users TO STDOUT',
      'MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE',
      'REPLACE INTO users VALUES (1, 2)',
      'UPSERT INTO users VALUES (1, 2)',
      'TRUNCATE TABLE users',
      'ANALYZE users',
      'VACUUM FULL',
      'GRANT SELECT ON users TO app',
      'REVOKE SELECT ON users FROM app',
      'ATTACH DATABASE ":memory:" AS aux',
      'DETACH DATABASE aux',
      'OPTIMIZE TABLE events',
      'CHECK TABLE users',
      'FLUSH PRIVILEGES',
      'LOCK TABLES users READ',
      'UNLOCK TABLES',
      "COMMENT ON TABLE users IS 'ok'",
      'REFRESH MATERIALIZED VIEW mv_sales',
      'PREPARE q AS SELECT 1',
      'EXECUTE q',
      'DEALLOCATE q',
      'FETCH NEXT FROM cur',
      'GO',
    ]

    for (const sql of validStarters) {
      expect(analyzeSqlDiagnostics(sql, { dialect: 'postgres' }), `Failed on: ${sql}`).toEqual([])
    }
    expect(analyzeSqlDiagnostics('FROM users SELECT id, name', { dialect: 'duckdb' })).toEqual([])
    expect(
      analyzeSqlDiagnostics('PIVOT sales ON yr USING SUM(amt) GROUP BY item', { dialect: 'duckdb' })
    ).toEqual([])
    expect(analyzeSqlDiagnostics('SUMMARIZE SELECT * FROM users', { dialect: 'duckdb' })).toEqual([])
  })
})

describe('shared-sql-diagnostics: top-level clause & grammar checks', () => {
  it('detects missing-select-expr', () => {
    const q1 = 'SELECT FROM users'
    const d1 = analyzeSqlDiagnostics(q1)
    expect(d1).toHaveLength(1)
    expect(d1[0].code).toBe('missing-select-expr')
    expect(sliceOf(q1, d1[0])).toBe('FROM')

    const q2 = 'SELECT DISTINCT FROM users'
    const d2 = analyzeSqlDiagnostics(q2)
    expect(d2).toHaveLength(1)
    expect(d2[0].code).toBe('missing-select-expr')
    expect(sliceOf(q2, d2[0])).toBe('FROM')
  })

  it('detects trailing-comma before clauses and skips duckdb & bigquery', () => {
    const q1 = 'SELECT id, name, FROM users'
    const d1 = analyzeSqlDiagnostics(q1, { dialect: 'postgres' })
    expect(d1).toHaveLength(1)
    expect(d1[0].code).toBe('trailing-comma')
    expect(sliceOf(q1, d1[0])).toBe(',')

    const q2 = 'UPDATE users SET a = 1, WHERE id = 1'
    const d2 = analyzeSqlDiagnostics(q2, { dialect: 'mysql' })
    expect(d2).toHaveLength(1)
    expect(d2[0].code).toBe('trailing-comma')

    const q3 = 'SELECT id FROM users GROUP BY id, ORDER BY id'
    const d3 = analyzeSqlDiagnostics(q3, { dialect: 'sqlite' })
    expect(d3).toHaveLength(1)
    expect(d3[0].code).toBe('trailing-comma')

    // Valid trailing commas in DuckDB and BigQuery
    expect(analyzeSqlDiagnostics(q1, { dialect: 'duckdb' })).toEqual([])
    expect(analyzeSqlDiagnostics(q1, { dialect: 'bigquery' })).toEqual([])
  })

  it('detects duplicate-comma and underlines the second comma', () => {
    const sql = 'SELECT id,, name FROM users'
    const diags = analyzeSqlDiagnostics(sql)
    expect(diags).toHaveLength(1)
    expect(diags[0].code).toBe('duplicate-comma')
    expect(diags[0].from).toBe(10)
    expect(sliceOf(sql, diags[0])).toBe(',')
  })

  it('detects all misspelled-clause patterns without false-positiving on valid aliases', () => {
    const cases: Array<[string, string, string]> = [
      ['SELECT * FORM users', 'FORM', 'FROM'],
      ['SELECT id, name FORM users WHERE active = 1', 'FORM', 'FROM'],
      ['DELETE FORM users WHERE id = 1', 'FORM', 'FROM'],
      ['INSERT INOT users (id) VALUES (1)', 'INOT', 'INTO'],
      ['UPDATE users STE a = 1 WHERE id = 1', 'STE', 'SET'],
      ['SELECT * FROM users ODRER BY id', 'ODRER', 'ORDER'],
      ['SELECT * FROM users ORDR BY id', 'ORDR', 'ORDER'],
      ['SELECT dept, COUNT(*) FROM emp GRUOP BY dept', 'GRUOP', 'GROUP'],
      ['SELECT dept, COUNT(*) FROM emp GROP BY dept', 'GROP', 'GROUP'],
      ['SELECT * FROM users LIMT 10', 'LIMT', 'LIMIT'],
      ['SELECT * FROM users LMIT 10', 'LMIT', 'LIMIT'],
      ['SELECT * FROM users LIM 10', 'LIM', 'LIMIT'],
      ['SELECT * FROM users LIMIT 10 OFSET 5', 'OFSET', 'OFFSET'],
      ['SELECT * FROM users LIMIT 10 OFFST $1', 'OFFST', 'OFFSET'],
      ['SELECT * FROM users LIMT ALL', 'LIMT', 'LIMIT'],
      ['SELECT * FROM users WEHRE id = 1', 'WEHRE', 'WHERE'],
      ['SELECT * FROM users WHER id = 1', 'WHER', 'WHERE'],
      ['SELECT * FROM users u WEHRE u.id = 1', 'WEHRE', 'WHERE'],
      ['SELECT * FROM users JION orders ON users.id = orders.uid', 'JION', 'JOIN'],
      ['SELECT * FROM users LEFT JION orders ON users.id = orders.uid', 'JION', 'JOIN'],
      ['SELECT dept, COUNT(*) FROM emp GROUP BY dept HAVNG count(*) > 1', 'HAVNG', 'HAVING'],
      ['SELECT * FROM users LIMWHERE id = 1', 'LIMWHERE', 'WHERE'],
      ['SELECT * FROM "banners" b LIMWHERE id = 1', 'LIMWHERE', 'WHERE'],
      ['SELECT * FROM users LIMTWHERE id = 1', 'LIMTWHERE', 'WHERE'],
      ['SELECT * FROM users FRMWHERE id = 1', 'FRMWHERE', 'WHERE'],
      ['SELECT * FROM users FORMWHERE id = 1', 'FORMWHERE', 'WHERE'],
      ['SELECT * FROM users GRPHAVING count(*) > 1', 'GRPHAVING', 'HAVING'],
      ['SELECT * FROM users LEFTJOIN orders ON users.id = orders.uid', 'LEFTJOIN', 'LEFT JOIN'],
      ['SELECT * FROM users LIMIT10OFFSET 5', 'LIMIT10OFFSET', 'OFFSET'],
      ['SELECT * FROM users ORDERBY id', 'ORDERBY', 'ORDER BY'],
      ['SELECT * FROM users GROUPBY dept', 'GROUPBY', 'GROUP BY'],
      ['UPDATE users SET a = 1 WEHRE id = 1', 'WEHRE', 'WHERE'],
      ['UPDATE users SET a = 1 LIMT 10', 'LIMT', 'LIMIT'],
      ['WITH cte AS (SELECT 1) SELECT * FORM cte', 'FORM', 'FROM'],
      ['CREATE VIEW v AS SELECT * FORM users', 'FORM', 'FROM'],
      ['EXPLAIN ANALYZE SELECT * FORM users', 'FORM', 'FROM'],
      ['(SELECT id FROM a) UNION (SELECT id FROM b) LIMT 5', 'LIMT', 'LIMIT'],
      ['SELECT DISTINCT * FORM users', 'FORM', 'FROM'],
      ['SELECT t.* FORM users t', 'FORM', 'FROM'],
    ]

    for (const [sql, badTok, expected] of cases) {
      const diags = analyzeSqlDiagnostics(sql, { dialect: 'postgres' })
      const hit = diags.find((d) => d.code === 'misspelled-clause')
      expect(hit, `Expected misspelled-clause for: ${sql}`).toBeDefined()
      expect(sliceOf(sql, hit!)).toBe(badTok)
      expect(hit!.suggestion).toBe(expected)
    }

    // Strict zero-false-positive checks for valid column & table aliases
    expect(analyzeSqlDiagnostics('SELECT a b FROM users')).toEqual([])
    expect(analyzeSqlDiagnostics('SELECT a form FROM users')).toEqual([])
    expect(analyzeSqlDiagnostics('SELECT * FROM "banners" b')).toEqual([])
    expect(analyzeSqlDiagnostics('SELECT * FROM "banners" lim')).toEqual([])
    expect(analyzeSqlDiagnostics('SELECT * FROM "banners" lim WHERE lim.id = 1')).toEqual([])
    expect(analyzeSqlDiagnostics('SELECT * FROM users WHERE wehre = 1')).toEqual([])
    expect(analyzeSqlDiagnostics('SELECT * FROM users WHERE a = 1 AND havng > 1')).toEqual([])
    expect(analyzeSqlDiagnostics('UPDATE users SET wehre = 1, order = 2 WHERE id = 1')).toEqual([])
    expect(analyzeSqlDiagnostics('SELECT 2 * form alias')).toEqual([])
    expect(analyzeSqlDiagnostics('SELECT * FROM users elsewhere(a)')).toEqual([])
    expect(analyzeSqlDiagnostics('SELECT * FROM users anywhere(a)')).toEqual([])
    expect(analyzeSqlDiagnostics('SELECT * FROM users reorder(a)')).toEqual([])
    expect(analyzeSqlDiagnostics('SELECT * FROM users subgroup(a)')).toEqual([])
    expect(analyzeSqlDiagnostics('SELECT * FROM users semigroup(a)')).toEqual([])
    expect(analyzeSqlDiagnostics('SELECT * FROM users coinorder(a)')).toEqual([])
    expect(analyzeSqlDiagnostics('SELECT * FROM limits limit1 WHERE limit1.id = 1')).toEqual([])
    expect(analyzeSqlDiagnostics('SELECT * FROM orders order1 WHERE order1.id = 1')).toEqual([])
  })

  it('detects missing-by on ORDER/GROUP while avoiding all valid non-BY contexts', () => {
    const q1 = 'SELECT * FROM users ORDER id'
    const d1 = analyzeSqlDiagnostics(q1)
    expect(d1).toHaveLength(1)
    expect(d1[0].code).toBe('missing-by')
    expect(sliceOf(q1, d1[0])).toBe('ORDER')

    const q2 = 'SELECT dept FROM emp GROUP dept'
    const d2 = analyzeSqlDiagnostics(q2)
    expect(d2).toHaveLength(1)
    expect(d2[0].code).toBe('missing-by')
    expect(sliceOf(q2, d2[0])).toBe('GROUP')

    // Valid contexts that must NEVER trigger missing-by
    expect(
      analyzeSqlDiagnostics('SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY x) FROM t')
    ).toEqual([])
    expect(analyzeSqlDiagnostics('SELECT x AS order, y AS group FROM t')).toEqual([])
    expect(analyzeSqlDiagnostics('SELECT t.order, t.group FROM t')).toEqual([])
    expect(analyzeSqlDiagnostics('SELECT "order", "group" FROM t')).toEqual([])
    expect(analyzeSqlDiagnostics('SELECT order FROM t')).toEqual([])
    expect(analyzeSqlDiagnostics('SELECT GROUP_CONCAT(name) FROM t', { dialect: 'mysql' })).toEqual([])
    expect(
      analyzeSqlDiagnostics('SELECT ename FROM emp CONNECT BY PRIOR id = pid ORDER SIBLINGS BY ename', {
        dialect: 'oracle',
      })
    ).toEqual([])
  })

  it('detects duplicate-keyword', () => {
    const cases = [
      ['SELECT SELECT * FROM t', 'SELECT'],
      ['SELECT * FROM FROM t', 'FROM'],
      ['SELECT * FROM t WHERE WHERE id = 1', 'WHERE'],
      ['SELECT * FROM t WHERE a = 1 AND AND b = 2', 'AND'],
      ['SELECT * FROM t WHERE a = 1 OR OR b = 2', 'OR'],
      ['SELECT a FROM t GROUP BY a HAVING HAVING count(*) > 1', 'HAVING'],
      ['SELECT * FROM t LIMIT LIMIT 10', 'LIMIT'],
      ['SELECT * FROM t LIMIT 10 OFFSET OFFSET 5', 'OFFSET'],
      ['UPDATE t SET SET a = 1', 'SET'],
    ] as const

    for (const [sql, dup] of cases) {
      const diags = analyzeSqlDiagnostics(sql)
      const hit = diags.find((d) => d.code === 'duplicate-keyword')
      expect(hit, `Expected duplicate-keyword for: ${sql}`).toBeDefined()
      expect(sliceOf(sql, hit!)).toBe(dup)
    }
  })

  it('detects incomplete-clause for empty clauses and dangling keywords', () => {
    const cases = [
      'SELECT * FROM WHERE id = 1',
      'SELECT * FROM users WHERE ORDER BY id',
      'SELECT * FROM users WHERE LIMIT 10',
      'SELECT * FROM users WHERE AND id = 1',
      'SELECT * FROM users WHERE OR id = 1',
      'SELECT * FROM;',
      'SELECT * FROM users WHERE;',
      'SELECT * FROM users LIMIT;',
      'SELECT * FROM users OFFSET;',
      'SELECT * FROM users WHERE id = 1 AND;',
      'SELECT * FROM users WHERE id = 1 OR;',
    ]

    for (const sql of cases) {
      const diags = analyzeSqlDiagnostics(sql, { dialect: 'postgres' })
      expect(
        diags.some((d) => d.code === 'incomplete-clause'),
        `Expected incomplete-clause for: ${sql}`
      ).toBe(true)
    }
  })

  it('produces zero false positives for everyday table/column/function identifiers (settings, format) and multiline division', () => {
    const dialects = ['sqlite', 'postgres', 'mysql', 'mssql', 'oracle', 'clickhouse'] as const
    const settingsTableQueries = [
      'SELECT * FROM settings',
      'SELECT * FROM settings WHERE id = 1',
      "DELETE FROM settings WHERE key = 'k'",
      'WITH settings AS (SELECT 1 AS id) SELECT * FROM settings',
    ]
    for (const dialect of dialects) {
      for (const sql of settingsTableQueries) {
        expect(analyzeSqlDiagnostics(sql, { dialect }), `FP [${dialect}]: ${sql}`).toEqual([])
      }
    }

    expect(
      analyzeSqlDiagnostics(
        "SELECT * FROM users WHERE format('%s %s', first_name, last_name) = 'John Doe'",
        { dialect: 'postgres' }
      )
    ).toEqual([])
    expect(
      analyzeSqlDiagnostics("SELECT * FROM orders WHERE FORMAT(total, 2) = '10.00'", {
        dialect: 'mysql',
      })
    ).toEqual([])
    expect(
      analyzeSqlDiagnostics("SELECT * FROM orders WHERE FORMAT(created_at, 'yyyy') = '2026'", {
        dialect: 'mssql',
      })
    ).toEqual([])

    const predicateQueries = [
      'SELECT * FROM users WHERE settings IS NOT NULL',
      "SELECT * FROM exports WHERE format IN ('csv', 'json')",
      'SELECT * FROM logs WHERE active = true AND format IS NOT NULL',
      'SELECT * FROM users GROUP BY settings HAVING settings IS NOT NULL',
    ]
    for (const sql of predicateQueries) {
      expect(analyzeSqlDiagnostics(sql, { dialect: 'postgres' }), `FP: ${sql}`).toEqual([])
    }

    // Standalone `/` is Oracle SQL*Plus batch separator only; multiline division in PG/MySQL/SQLite must not split
    const multilineDivision = 'SELECT a\n /\n NULLIF(b, 0) FROM t'
    expect(analyzeSqlDiagnostics(multilineDivision, { dialect: 'postgres' })).toEqual([])
    expect(analyzeSqlDiagnostics(multilineDivision, { dialect: 'mysql' })).toEqual([])
    expect(analyzeSqlDiagnostics(multilineDivision, { dialect: 'sqlite' })).toEqual([])

    // MSSQL RAISERROR starter
    expect(analyzeSqlDiagnostics("RAISERROR('boom', 16, 1)", { dialect: 'mssql' })).toEqual([])
  })

  it('detects unclosed-case and skips procedural BEGIN blocks', () => {
    const bad = "SELECT CASE WHEN active = 1 THEN 'yes' FROM users"
    const diags = analyzeSqlDiagnostics(bad)
    expect(diags).toHaveLength(1)
    expect(diags[0].code).toBe('unclosed-case')
    expect(sliceOf(bad, diags[0])).toBe('CASE')

    const validNested =
      'SELECT CASE WHEN a = 1 THEN CASE WHEN b = 2 THEN 10 ELSE 20 END ELSE 30 END FROM t'
    expect(analyzeSqlDiagnostics(validNested)).toEqual([])

    const triggerWithBegin =
      "CREATE TRIGGER tr AFTER INSERT ON t BEGIN INSERT INTO log VALUES (CASE WHEN NEW.x > 0 THEN 1 END); END;"
    expect(analyzeSqlDiagnostics(triggerWithBegin, { dialect: 'sqlite' })).toEqual([])

    const plsqlWithBegin =
      'BEGIN IF x > 0 THEN NULL; END IF; CASE y WHEN 1 THEN NULL; END CASE; END;'
    expect(analyzeSqlDiagnostics(plsqlWithBegin, { dialect: 'oracle' })).toEqual([])

    // Transaction BEGIN; must NOT suppress unclosed-case in subsequent statements
    const txBegin = "BEGIN; SELECT CASE WHEN active = 1 THEN 'yes' FROM users; COMMIT;"
    const txDiags = analyzeSqlDiagnostics(txBegin, { dialect: 'postgres' })
    expect(txDiags).toHaveLength(1)
    expect(txDiags[0].code).toBe('unclosed-case')
    expect(sliceOf(txBegin, txDiags[0])).toBe('CASE')

    // MSSQL GO batch separator still catches errors in following batch
    const afterGo = 'SELECT 1\nGO\nSELCT * FROM [dbo].[users]'
    const goDiags = analyzeSqlDiagnostics(afterGo, { dialect: 'mssql' })
    expect(goDiags).toHaveLength(1)
    expect(goDiags[0].code).toBe('unknown-keyword')
    expect(goDiags[0].suggestion).toBe('SELECT')
  })
})

describe('shared-sql-diagnostics: 35+ query zero-false-positive multi-dialect corpus', () => {
  const validCorpus: Array<{ name: string; dialect: string; sql: string }> = [
    // PostgreSQL (8)
    {
      name: 'pg-cte-upsert-returning',
      dialect: 'postgres',
      sql: `
        WITH RECURSIVE tree AS (
          SELECT id, parent_id, 0 AS depth FROM nodes WHERE parent_id IS NULL
          UNION ALL
          SELECT n.id, n.parent_id, t.depth + 1 FROM nodes n JOIN tree t ON n.parent_id = t.id
        )
        INSERT INTO node_summary (id, depth)
        SELECT id, depth FROM tree
        ON CONFLICT (id) DO UPDATE SET depth = EXCLUDED.depth
        RETURNING id, depth;
      `,
    },
    {
      name: 'pg-window-filter-within-group',
      dialect: 'postgres',
      sql: `
        SELECT
          region,
          percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95,
          COUNT(*) FILTER (WHERE status >= 500) AS errors,
          ROW_NUMBER() OVER (PARTITION BY region ORDER BY COUNT(*) DESC NULLS LAST) AS rn
        FROM api_logs
        WHERE created_at >= NOW() - INTERVAL '7 days'
        GROUP BY region
        HAVING COUNT(*) > 100
        ORDER BY p95 DESC
        LIMIT ALL OFFSET $1;
      `,
    },
    {
      name: 'pg-dollar-quote-plpgsql',
      dialect: 'postgres',
      sql: `
        CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $fn$
        BEGIN
          NEW.updated_at := now();
          RETURN NEW;
        END;
        $fn$ LANGUAGE plpgsql;
      `,
    },
    {
      name: 'pg-jsonb-array-escape-nested-comments',
      dialect: 'postgres',
      sql: `
        /* outer /* nested */ comment */
        SELECT
          payload #>> '{user,email}' AS email,
          tags[1] AS primary_tag,
          ARRAY['a', 'b']::text[] AS defaults,
          E'line1\\nline2\\'s' AS note
        FROM events
        WHERE payload @> '{"active": true}'::jsonb;
      `,
    },
    {
      name: 'pg-distinct-on-and-quoted-reserved',
      dialect: 'postgres',
      sql: `
        SELECT DISTINCT ON (user_id)
          user_id, "order", "group", t.order, x AS order, y AS group
        FROM "orders" t
        WHERE t.amount > 0
        ORDER BY user_id, created_at DESC;
      `,
    },
    {
      name: 'pg-explain-json',
      dialect: 'postgres',
      sql: 'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM users WHERE id = $1;',
    },
    {
      name: 'pg-create-rule-semis-in-parens',
      dialect: 'postgres',
      sql: 'CREATE RULE r_audit AS ON INSERT TO orders DO (INSERT INTO log1 VALUES (1); INSERT INTO log2 VALUES (2););',
    },
    {
      name: 'pg-union-parenthesized',
      dialect: 'postgres',
      sql: '(SELECT id FROM a ORDER BY id LIMIT 5) UNION ALL (SELECT id FROM b ORDER BY id LIMIT 5);',
    },

    // CockroachDB (2)
    {
      name: 'crdb-as-of-system-time',
      dialect: 'cockroachdb',
      sql: "SELECT id, balance FROM accounts AS OF SYSTEM TIME '-10s' WHERE balance > 0;",
    },
    {
      name: 'crdb-upsert',
      dialect: 'cockroachdb',
      sql: "UPSERT INTO kv (k, v) VALUES ('alpha', 'beta') RETURNING k;",
    },

    // MySQL (4)
    {
      name: 'mysql-backticks-hash-escapes-limit-pair',
      dialect: 'mysql',
      sql: "SELECT `id`, `order`, `group` FROM `orders` # trailing comment\n WHERE `note` = 'it\\'s ok' AND `dir` = 'C:\\\\data\\\\' ORDER BY `id` DESC LIMIT 20, 10;",
    },
    {
      name: 'mysql-exec-comment-group-concat',
      dialect: 'mysql',
      sql: "/*!50001 SELECT 1 */ SELECT dept, GROUP_CONCAT(name ORDER BY name SEPARATOR ', ') FROM emp GROUP BY dept;",
    },
    {
      name: 'mysql-on-duplicate-key-update',
      dialect: 'mysql',
      sql: 'INSERT INTO stats (k, cnt) VALUES (1, 1) ON DUPLICATE KEY UPDATE cnt = cnt + 1;',
    },
    {
      name: 'mysql-multi-table-delete-and-interval',
      dialect: 'mysql',
      sql: 'DELETE u FROM users u JOIN stale s ON u.id = s.user_id WHERE s.seen_at < NOW() - INTERVAL 30 DAY;',
    },

    // MariaDB (2)
    {
      name: 'mariadb-returning-and-show',
      dialect: 'mariadb',
      sql: "DELETE FROM sessions WHERE expired = 1 RETURNING id; SHOW ENGINE INNODB STATUS;",
    },
    {
      name: 'mariadb-system-versioning',
      dialect: 'mariadb',
      sql: "SELECT * FROM audit_table FOR SYSTEM_TIME AS OF TIMESTAMP '2026-01-01 00:00:00';",
    },

    // SQLite / LibSQL (4)
    {
      name: 'sqlite-pragma-upsert-hex',
      dialect: 'sqlite',
      sql: "PRAGMA foreign_keys = ON; INSERT OR REPLACE INTO blobs (id, raw) VALUES (1, X'CAFEBABE');",
    },
    {
      name: 'sqlite-trigger-begin-end',
      dialect: 'sqlite',
      sql: `
        CREATE TRIGGER trg_items_after_ins AFTER INSERT ON items
        BEGIN
          INSERT INTO audit_log (item_id, action) VALUES (NEW.id, 'insert');
          UPDATE counters SET total = total + 1 WHERE name = 'items';
        END;
      `,
    },
    {
      name: 'sqlite-explain-indexed-by',
      dialect: 'sqlite',
      sql: "EXPLAIN QUERY PLAN SELECT id, name FROM users INDEXED BY idx_users_name WHERE name GLOB 'a*';",
    },
    {
      name: 'libsql-attach-detach',
      dialect: 'libsql',
      sql: "ATTACH DATABASE ':memory:' AS scratch; SELECT * FROM scratch.sqlite_master; DETACH DATABASE scratch;",
    },

    // MSSQL (4)
    {
      name: 'mssql-brackets-nolock-offset-fetch',
      dialect: 'mssql',
      sql: `
        SELECT TOP 25 [id], [order], [col]]escaped]
        FROM [dbo].[orders] WITH (NOLOCK)
        WHERE [customer] = N'Nguyễn Văn A'
        ORDER BY [id] DESC
        OFFSET 0 ROWS FETCH NEXT 25 ROWS ONLY;
      `,
    },
    {
      name: 'mssql-temp-table-declare-go',
      dialect: 'mssql',
      sql: 'DECLARE @minId INT = 10; SELECT id, limit, offset FROM #temp_plans WHERE id >= @minId;\nGO\nEXEC dbo.sp_who2;',
    },
    {
      name: 'mssql-merge',
      dialect: 'mssql',
      sql: `
        MERGE INTO [dbo].[target] AS t
        USING [dbo].[source] AS s ON t.[id] = s.[id]
        WHEN MATCHED THEN UPDATE SET t.[val] = s.[val]
        WHEN NOT MATCHED THEN INSERT ([id], [val]) VALUES (s.[id], s.[val]);
      `,
    },
    {
      name: 'mssql-try-catch',
      dialect: 'mssql',
      sql: 'BEGIN TRY SELECT 1 / 0; END TRY BEGIN CATCH SELECT ERROR_MESSAGE(); END CATCH;',
    },

    // Oracle (4)
    {
      name: 'oracle-q-quotes-and-v-dollar',
      dialect: 'oracle',
      sql: "SELECT q'[Don't panic]', q'(a'b)', q'{c'd}', q'<e'f>', nq'[unicode]' FROM v$session WHERE status = 'ACTIVE';",
    },
    {
      name: 'oracle-connect-by-order-siblings',
      dialect: 'oracle',
      sql: 'SELECT LEVEL, ename FROM emp START WITH mgr IS NULL CONNECT BY PRIOR empno = mgr ORDER SIBLINGS BY ename;',
    },
    {
      name: 'oracle-plsql-slash-separator',
      dialect: 'oracle',
      sql: 'DECLARE v_n NUMBER; BEGIN SELECT COUNT(*) INTO v_n FROM dual; END;\n/\nSELECT 1 FROM dual;',
    },
    {
      name: 'oracle-create-sequence-order',
      dialect: 'oracle',
      sql: 'CREATE SEQUENCE seq_invoices START WITH 1 INCREMENT BY 1 ORDER NOCACHE;',
    },

    // ClickHouse (3)
    {
      name: 'clickhouse-prewhere-totals-limit-by-format-settings',
      dialect: 'clickhouse',
      sql: `
        SELECT user_id, count() AS c
        FROM events FINAL SAMPLE 0.1 # ch comment
        PREWHERE event_date >= today() - 7
        WHERE status = 200
        GROUP BY user_id WITH TOTALS
        ORDER BY c DESC
        LIMIT 5 BY user_id
        FORMAT JSONEachRow
        SETTINGS max_threads = 4;
      `,
    },
    {
      name: 'clickhouse-array-indexing',
      dialect: 'clickhouse',
      sql: "SELECT tags[1], arrayJoin(tags) AS tag FROM items WHERE msg = 'it\\'s ok';",
    },
    {
      name: 'clickhouse-optimize',
      dialect: 'clickhouse',
      sql: 'OPTIMIZE TABLE events PARTITION 202611 FINAL;',
    },

    // DuckDB (3)
    {
      name: 'duckdb-from-first-and-trailing-comma',
      dialect: 'duckdb',
      sql: 'FROM users SELECT id, name, WHERE active = true ORDER BY id DESC;',
    },
    {
      name: 'duckdb-pivot-and-summarize',
      dialect: 'duckdb',
      sql: "PIVOT sales ON year USING SUM(amount) GROUP BY product; SUMMARIZE SELECT * FROM 'sales.parquet';",
    },
    {
      name: 'duckdb-nested-comments-list-struct',
      dialect: 'duckdb',
      sql: "SELECT /* a /* b */ c */ [10, 20, 30][1], {'k': 'v'} FROM range(5) t(i);",
    },

    // BigQuery (3)
    {
      name: 'bigquery-trailing-comma-backticks-qualify-offset',
      dialect: 'bigquery',
      sql: `
        SELECT
          user_id,
          tags[OFFSET(0)] AS first_tag,
        FROM \`my-proj.analytics.events\` # bq comment
        WHERE note = '''multi
line''' AND status = "active"
        QUALIFY ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY ts DESC) = 1;
      `,
    },
    {
      name: 'bigquery-unnest-with-offset',
      dialect: 'bigquery',
      sql: 'SELECT id, item, pos FROM `proj.ds.orders`, UNNEST(items) AS item WITH OFFSET AS pos;',
    },
    {
      name: 'bigquery-except-replace',
      dialect: 'bigquery',
      sql: 'SELECT * EXCEPT (secret) REPLACE (UPPER(name) AS name) FROM `proj.ds.users`;',
    },

    // Non-SQL (2)
    {
      name: 'redis-commands',
      dialect: 'redis',
      sql: 'SET session:42 "hello" EX 300\nGET session:42',
    },
    {
      name: 'mongodb-js-shell',
      dialect: 'mongodb',
      sql: 'db.orders.aggregate([{ $match: { status: "paid" } }, { $limit: 20 }])',
    },
  ]

  it('produces zero false positives across all 39 multi-dialect valid queries', () => {
    expect(validCorpus.length).toBeGreaterThanOrEqual(35)
    for (const entry of validCorpus) {
      const diags = analyzeSqlDiagnostics(entry.sql, { dialect: entry.dialect })
      expect(diags, `False positive on [${entry.dialect}] ${entry.name}`).toEqual([])
    }
  })
})

describe('shared-sql-diagnostics: extractDbSyntaxErrorDiagnostic', () => {
  it('parses PostgreSQL / CockroachDB syntax errors with and without LINE N:', () => {
    const doc = 'SELECT 1;\nSELECT * FORM users;'
    const err = 'ERROR: syntax error at or near "FORM"\nLINE 2: SELECT * FORM users;'
    const diag = extractDbSyntaxErrorDiagnostic(doc, err)
    expect(diag).not.toBeNull()
    expect(diag!.code).toBe('db-syntax-error')
    expect(diag!.severity).toBe('error')
    expect(sliceOf(doc, diag!)).toBe('FORM')

    // Disambiguates duplicate token across lines using LINE N:
    const multi = 'SELECT FORM FROM t1;\nSELECT * FORM t2;'
    const multiDiag = extractDbSyntaxErrorDiagnostic(
      multi,
      'syntax error at or near "FORM"\nLINE 2: SELECT * FORM t2;'
    )
    expect(multiDiag).not.toBeNull()
    expect(multiDiag!.from).toBe(multi.lastIndexOf('FORM'))
    expect(sliceOf(multi, multiDiag!)).toBe('FORM')
  })

  it('parses SQLite / LibSQL syntax errors', () => {
    const doc = 'SELECT * FORM users WHERE id = 1'
    const diag = extractDbSyntaxErrorDiagnostic(doc, 'SQLITE_ERROR: near "FORM": syntax error')
    expect(diag).not.toBeNull()
    expect(diag!.code).toBe('db-syntax-error')
    expect(sliceOf(doc, diag!)).toBe('FORM')
  })

  it('parses MySQL / MariaDB syntax errors with snippet and line number', () => {
    const doc = 'SELECT 1;\nSELECT * FORM users WHERE id = 1;'
    const err =
      "You have an error in your SQL syntax; check the manual that corresponds to your MySQL server version for the right syntax to use near 'FORM users WHERE id = 1' at line 2"
    const diag = extractDbSyntaxErrorDiagnostic(doc, err)
    expect(diag).not.toBeNull()
    expect(diag!.code).toBe('db-syntax-error')
    expect(diag!.from).toBe(doc.indexOf('FORM'))
    expect(sliceOf(doc, diag!)).toBe('FORM')
  })

  it('parses MSSQL syntax errors (both plain and "the keyword")', () => {
    const doc1 = 'SELECT * FORM [dbo].[users]'
    const d1 = extractDbSyntaxErrorDiagnostic(doc1, "Incorrect syntax near 'FORM'.")
    expect(d1).not.toBeNull()
    expect(sliceOf(doc1, d1!)).toBe('FORM')

    const doc2 = 'SELECT FROM [dbo].[users]'
    const d2 = extractDbSyntaxErrorDiagnostic(doc2, "Incorrect syntax near the keyword 'FROM'.")
    expect(d2).not.toBeNull()
    expect(sliceOf(doc2, d2!)).toBe('FROM')
  })

  it('parses ClickHouse syntax errors at 1-based position', () => {
    const doc = 'SELECT * FORM users'
    const diag = extractDbSyntaxErrorDiagnostic(
      doc,
      "Code: 62. DB::Exception: Syntax error: failed at position 10 ('FORM') (line 1, col 10)"
    )
    expect(diag).not.toBeNull()
    expect(diag!.code).toBe('db-syntax-error')
    expect(sliceOf(doc, diag!)).toBe('FORM')
  })

  it('scopes mapping cleanly to targetRange and returns document-absolute offsets', () => {
    const stmt1 = 'SELECT FORM FROM t1;\n'
    const stmt2 = 'SELECT * FORM users;'
    const doc = stmt1 + stmt2
    const targetRange = { from: stmt1.length, to: doc.length }

    const pgDiag = extractDbSyntaxErrorDiagnostic(
      doc,
      'syntax error at or near "FORM"\nLINE 1: SELECT * FORM users;',
      targetRange
    )
    expect(pgDiag).not.toBeNull()
    expect(pgDiag!.from).toBe(stmt1.length + stmt2.indexOf('FORM'))
    expect(sliceOf(doc, pgDiag!)).toBe('FORM')

    const chDiag = extractDbSyntaxErrorDiagnostic(
      doc,
      'Syntax error: failed at position 10',
      targetRange
    )
    expect(chDiag).not.toBeNull()
    expect(chDiag!.from).toBe(stmt1.length + stmt2.indexOf('FORM'))
    expect(sliceOf(doc, chDiag!)).toBe('FORM')
  })

  it('returns null when error is not a syntax error or token/position cannot be mapped', () => {
    expect(
      extractDbSyntaxErrorDiagnostic('SELECT * FROM users', 'relation "users" does not exist')
    ).toBeNull()
    expect(
      extractDbSyntaxErrorDiagnostic(
        'SELECT * FROM users',
        'syntax error at or near "NONEXISTENT_TOKEN"'
      )
    ).toBeNull()
    // Must not falsely match partial word substring inside a larger identifier
    expect(
      extractDbSyntaxErrorDiagnostic('SELECT foobar FROM users', 'syntax error at or near "foo"')
    ).toBeNull()
    expect(
      extractDbSyntaxErrorDiagnostic('SELECT 1', 'Syntax error: failed at position 999')
    ).toBeNull()
    expect(extractDbSyntaxErrorDiagnostic('', 'near "x": syntax error')).toBeNull()
    expect(extractDbSyntaxErrorDiagnostic('SELECT 1', '')).toBeNull()
  })

  it('skips string literals when locating offending SQL tokens and handles EOF/empty MySQL/ClickHouse spans', () => {
    const withStr = "SELECT 'FORM' FORM users"
    const pgDiag = extractDbSyntaxErrorDiagnostic(withStr, 'syntax error at or near "FORM"')
    expect(pgDiag).not.toBeNull()
    expect(pgDiag!.from).toBe(withStr.lastIndexOf('FORM'))
    expect(sliceOf(withStr, pgDiag!)).toBe('FORM')

    const mysqlEof = 'SELECT * FROM'
    const mysqlDiag = extractDbSyntaxErrorDiagnostic(
      mysqlEof,
      "You have an error in your SQL syntax; check the manual for the right syntax to use near '' at line 1"
    )
    expect(mysqlDiag).not.toBeNull()
    expect(sliceOf(mysqlEof, mysqlDiag!)).toBe('FROM')

    const chEof = 'SELECT * FROM'
    const chDiag = extractDbSyntaxErrorDiagnostic(
      chEof,
      'Syntax error: failed at position 14'
    )
    expect(chDiag).not.toBeNull()
    expect(sliceOf(chEof, chDiag!)).toBe('FROM')
  })
})

describe('shared-sql-diagnostics: property-based invariants', () => {
  it('never throws and always emits in-bounds sorted diagnostics (<= 25) on arbitrary input', () => {
    const dialects = [
      'postgres',
      'mysql',
      'sqlite',
      'mssql',
      'oracle',
      'clickhouse',
      'duckdb',
      'bigquery',
      'redis',
      'mongodb',
    ] as const

    fc.assert(
      fc.property(
        fc.string({ maxLength: 300 }),
        fc.constantFrom(...dialects),
        fc.option(fc.nat({ max: 300 }), { nil: null }),
        (sql, dialect, cursorOffset) => {
          const diags = analyzeSqlDiagnostics(sql, { dialect, cursorOffset })
          expect(Array.isArray(diags)).toBe(true)
          expect(diags.length).toBeLessThanOrEqual(25)
          for (let i = 0; i < diags.length; i++) {
            const d = diags[i]
            expect(d.from).toBeGreaterThanOrEqual(0)
            expect(d.to).toBeGreaterThanOrEqual(d.from)
            expect(d.to).toBeLessThanOrEqual(sql.length)
            expect(d.severity === 'error' || d.severity === 'warning').toBe(true)
            expect(d.code.length).toBeGreaterThan(0)
            expect(d.message.length).toBeGreaterThan(0)
            if (i > 0) {
              expect(d.from).toBeGreaterThanOrEqual(diags[i - 1].from)
            }
          }
        }
      ),
      { numRuns: 200 }
    )
  })
})
