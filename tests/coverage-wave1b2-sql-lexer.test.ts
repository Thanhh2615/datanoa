import { describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import {
  buildQuickFilterPredicate,
  compactSql,
  hasExplainAnalyzeOption,
  isExplainTargetMutating,
  isMutatingStatement,
  rewriteCockroachViewBodyDatabaseQualifier,
  rewriteCockroachViewBodyWithMeta,
  sanitizeFilterClause,
  stripCommentsAndLiterals,
} from '../src/drivers/common/sql-lexer'

describe('Wave 1B-2a: src/drivers/common/sql-lexer.ts', () => {
  it('strips comments and literals while preserving quoted identifiers as neutral x placeholders', () => {
    expect(
      stripCommentsAndLiterals(
        "SELECT [col]]1], \"id\", `k` INTO [dbo].[out] FROM t -- line\n /* block */ WHERE a = 'x'",
        'mssql'
      )
    ).toContain('x')
    expect(stripCommentsAndLiterals('SELECT [unclosed', 'mssql')).toBe('SELECT  x ')
    expect(
      stripCommentsAndLiterals("/*!50001 SELECT 1 */ # cmt\n WHERE a = 'it\\'s'", 'mysql', true)
    ).not.toContain('it')
    expect(
      stripCommentsAndLiterals("/*!50001 SELECT 1 */ SELECT 2", 'mysql', false)
    ).toContain('SELECT 2')
    expect(
      stripCommentsAndLiterals(
        "SELECT /* /* nested */ */ E'a\\'b', $$body$$, $tag$unclosed",
        'postgres'
      )
    ).toBe('SELECT    ,  ,  ')
    expect(stripCommentsAndLiterals('SELECT $not_a_tag FROM t', 'postgres')).toBe(
      'SELECT $not_a_tag FROM t'
    )

    expect(compactSql('  SELECT   a,   b   FROM   t  ')).toBe('SELECT a, b FROM t')
    expect(compactSql(`SELECT ${'col_name, '.repeat(12)} FROM t`, 30)).toMatch(/\.\.\.$/)
  })

  it('sanitizes WHERE/ORDER BY filter clauses and builds safe quick filter predicates', () => {
    expect(sanitizeFilterClause(undefined)).toBeUndefined()
    expect(sanitizeFilterClause('   ')).toBeUndefined()
    expect(sanitizeFilterClause('WHERE   ')).toBeUndefined()
    expect(sanitizeFilterClause("WHERE E'a\\'b' = 'a' AND $q$hi$q$ = $q$hi$q$", 'postgres')).toBe(
      "E'a\\'b' = 'a' AND $q$hi$q$ = $q$hi$q$"
    )
    expect(sanitizeFilterClause('ORDER BY [col]]1] = "x" AND $plain = 1', 'mssql')).toBe(
      '[col]]1] = "x" AND $plain = 1'
    )
    expect(sanitizeFilterClause("name = 'a#b' AND col = 'a--b' # cmt", 'postgres')).toContain('# cmt')

    expect(() => sanitizeFilterClause("E'unclosed", 'postgres')).toThrow(/unclosed ' quote/)
    expect(() => sanitizeFilterClause("name = 'unclosed", 'sqlite')).toThrow(/unclosed ' quote/)
    expect(() => sanitizeFilterClause('col = [unclosed', 'mssql')).toThrow(/unclosed \[/)
    expect(() => sanitizeFilterClause('col = $q$unclosed', 'postgres')).toThrow(/unclosed \$q\$/)
    expect(() => sanitizeFilterClause('id = 1; DROP TABLE x', 'postgres')).toThrow(/semicolon/)
    expect(() => sanitizeFilterClause('id = 1 # comment', 'mysql')).toThrow(/#\)/)
    expect(() => sanitizeFilterClause('id = 1 -- comment', 'postgres')).toThrow(/--\)/)
    expect(() => sanitizeFilterClause('id = 1 /* block */', 'postgres')).toThrow(/\/\*\)/)

    expect(buildQuickFilterPredicate('status', null, 'eq', 'postgres')).toBe('"status" IS NULL')
    expect(buildQuickFilterPredicate('status', undefined, 'neq', 'postgres')).toBe('"status" IS NOT NULL')
    expect(buildQuickFilterPredicate('status', 'ok', 'eq', 'mysql')).toBe("`status` = 'ok'")
    expect(buildQuickFilterPredicate('status', 5, 'neq', 'mssql')).toBe('[status] != 5')
    expect(buildQuickFilterPredicate('status', null, 'is-null', 'postgres')).toBe('"status" IS NULL')
    expect(buildQuickFilterPredicate('status', null, 'is-not-null', 'postgres')).toBe(
      '"status" IS NOT NULL'
    )
    expect(() => buildQuickFilterPredicate('   ', 1, 'eq', 'postgres')).toThrow(/Column name is required/)

    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9_ ]{0,20}$/),
        fc.constantFrom(';', '--', '/*'),
        (prefix, badToken) => {
          expect(() => sanitizeFilterClause(`${prefix} ${badToken}`, 'postgres')).toThrow()
        }
      ),
      { numRuns: 50 }
    )
  })

  it('analyzes EXPLAIN options and SQL mutation safety across dialects, CTEs, PRAGMAs, and parens', () => {
    expect(hasExplainAnalyzeOption('SELECT 1', 'postgres')).toBe(false)
    expect(hasExplainAnalyzeOption('EXPLAIN (ANALYZE', 'postgres')).toBe(false)
    expect(hasExplainAnalyzeOption('EXPLAIN (ANALYZE FALSE, VERBOSE) SELECT 1', 'postgres')).toBe(false)
    expect(hasExplainAnalyzeOption('EXPLAIN (ANALYSE, COSTS) SELECT 1', 'postgres')).toBe(true)
    expect(hasExplainAnalyzeOption('EXPLAIN ANALYZE SELECT 1', 'mysql')).toBe(true)

    expect(isExplainTargetMutating('   -- comment', 'postgres')).toBe(false)
    expect(isExplainTargetMutating('EXPLAIN (unclosed', 'postgres')).toBe(true)
    expect(isExplainTargetMutating("EXPLAIN (INTO OUTFILE '/tmp/x') SELECT 1", 'mysql')).toBe(true)
    expect(
      isExplainTargetMutating('EXPLAIN FORMAT=JSON FOR CONNECTION 12', 'mysql')
    ).toBe(false)
    expect(
      isExplainTargetMutating('EXPLAIN FORMAT=JSON INSERT INTO t VALUES (1)', 'mysql')
    ).toBe(true)
    expect(isExplainTargetMutating('EXPLAIN VERBOSE FORMAT JSON SELECT 1', 'postgres')).toBe(false)
    expect(
      isExplainTargetMutating(
        'EXPLAIN PLAN SET STATEMENT_ID = s1 INTO plan_table FOR SELECT 1 FROM dual',
        'oracle'
      )
    ).toBe(false)
    expect(
      isExplainTargetMutating(
        'EXPLAIN PLAN SET STATEMENT_ID = INTO plan_table FOR DELETE FROM users',
        'oracle'
      )
    ).toBe(true)
    expect(
      isExplainTargetMutating('EXPLAIN PLAN header = 1, actions = 1 SELECT 1', 'clickhouse')
    ).toBe(false)
    expect(isExplainTargetMutating("EXPLAIN SELECT 1 INTO OUTFILE '/a'", 'mysql')).toBe(true)

    expect(isMutatingStatement('', 'postgres')).toBe(false)
    expect(isMutatingStatement('((SELECT 1)) ORDER BY 1 LIMIT 2', 'postgres')).toBe(false)
    expect(isMutatingStatement('(SELECT 1) UNION ALL SELECT 2', 'postgres')).toBe(false)
    expect(isMutatingStatement('(SELECT 1) INTO OUTFILE \'/tmp/x\'', 'mysql')).toBe(true)
    expect(isMutatingStatement('(SELECT 1) FOR UPDATE', 'postgres')).toBe(true)
    expect(isMutatingStatement('(SELECT 1', 'postgres')).toBe(true)
    expect(isMutatingStatement('(SELECT 1) EXTRA', 'postgres')).toBe(true)
    expect(isMutatingStatement('()', 'postgres')).toBe(true)
    expect(isMutatingStatement('12345', 'postgres')).toBe(false)
    expect(isMutatingStatement('SHOW TABLES; DESCRIBE users; DESC orders', 'mysql')).toBe(false)
    expect(isMutatingStatement('VALUES (1, 2)', 'postgres')).toBe(false)
    expect(isMutatingStatement('TABLE users FOR NO KEY UPDATE', 'postgres')).toBe(true)
    expect(isMutatingStatement('SELECT * INTO TEMP tbl FROM users', 'postgres')).toBe(true)
    expect(isMutatingStatement("SELECT setval('seq', 1)", 'postgres')).toBe(true)
    expect(isMutatingStatement('PRAGMA table_info(users); PRAGMA main.index_info(idx); PRAGMA user_version', 'sqlite')).toBe(false)
    expect(isMutatingStatement('PRAGMA writable_schema(1)', 'sqlite')).toBe(true)
    expect(isMutatingStatement('PRAGMA cache_size = 100', 'sqlite')).toBe(true)
    expect(isMutatingStatement('PRAGMA wal_checkpoint', 'sqlite')).toBe(true)
    expect(isMutatingStatement('PRAGMA unknown_fn(1)', 'sqlite')).toBe(true)
    expect(isMutatingStatement('EXPLAIN ANALYZE SELECT 1', 'postgres')).toBe(true)
    expect(isMutatingStatement('EXPLAIN SELECT 1', 'postgres')).toBe(false)

    // CTE forms
    expect(
      isMutatingStatement(
        'WITH RECURSIVE c(a) AS MATERIALIZED (SELECT 1), d AS NOT MATERIALIZED (SELECT 2) SELECT * FROM c',
        'postgres'
      )
    ).toBe(false)
    expect(
      isMutatingStatement('WITH d AS (DELETE FROM users RETURNING *) SELECT * FROM d', 'postgres')
    ).toBe(true)
    expect(isMutatingStatement('WITH bad AS (SELECT 1) UNKNOWN_VERB', 'postgres')).toBe(true)
    expect(isMutatingStatement('WITH 123 AS (SELECT 1) SELECT 1', 'postgres')).toBe(true)
    expect(isMutatingStatement('WITH c(a AS (SELECT 1) SELECT 1', 'postgres')).toBe(true)
    expect(isMutatingStatement('WITH c FROM (SELECT 1) SELECT 1', 'postgres')).toBe(true)
    expect(isMutatingStatement('WITH c AS SELECT 1', 'postgres')).toBe(true)
    expect(isMutatingStatement('WITH c AS (SELECT 1', 'postgres')).toBe(true)
    expect(isMutatingStatement('WITH c AS () SELECT 1', 'postgres')).toBe(true)
    expect(isMutatingStatement('WITH c AS (SELECT 1), ', 'postgres')).toBe(true)
    expect(isMutatingStatement('   ;  ', 'postgres')).toBe(false)
    expect(
      isMutatingStatement('WITH c AS (PRAGMA unknown_mut(1)) SELECT * FROM c', 'sqlite')
    ).toBe(true)

    fc.assert(
      fc.property(
        fc.constantFrom('SELECT 1 FROM users', 'INSERT INTO users VALUES (1)'),
        fc.constantFrom('-- lead\n', '/* blk */ ', '   '),
        (sql, prefix) => {
          expect(isMutatingStatement(`${prefix}${sql}`, 'postgres')).toBe(
            isMutatingStatement(sql, 'postgres')
          )
        }
      ),
      { numRuns: 20 }
    )
  })

  it('classifies Redis and MongoDB commands accurately for read-only enforcement', () => {
    expect(
      isMutatingStatement(
        "# comment\n-- cmt\n// cmt\nGET key\nCONFIG GET maxmemory\nCLIENT LIST\nACL WHOAMI\nSCRIPT EXISTS abc",
        'redis'
      )
    ).toBe(false)
    expect(isMutatingStatement('SET a b', 'redis')).toBe(true)
    expect(isMutatingStatement('CONFIG SET a b', 'redis')).toBe(true)
    expect(isMutatingStatement('CLIENT KILL 1.2.3.4:1', 'redis')).toBe(true)
    expect(isMutatingStatement('ACL SETUSER a', 'redis')).toBe(true)
    expect(isMutatingStatement('SCRIPT FLUSH', 'redis')).toBe(true)
    expect(isMutatingStatement('UNKNOWN_CMD a', 'redis')).toBe(true)

    // MongoDB readonly & mutating shell + raw commands
    expect(
      isMutatingStatement(
        `
        // line comment
        /* block comment */
        users;
        analytics.events;
        show dbs;
        use mydb;
        db.stats();
        db.runCommand({ "find": "users", "filter": { "a": 1 } });
        db.adminCommand({ "explain": { "count": "users" } });
        db.users
          .find({ name: /a[\\/b]c/i, q: "x\\'y" })
          .sort({ _id: -1 })
          .limit(10)
          .toArray();
        db.getCollection("users").aggregate([{ $match: { active: true } }]);
        db["users"].countDocuments();
        { "find": "users" }
        `,
        'mongodb'
      )
    ).toBe(false)

    expect(isMutatingStatement('/* unclosed', 'mongodb')).toBe(false)
    expect(isMutatingStatement('unknownStmt()', 'mongodb')).toBe(true)
    expect(isMutatingStatement('db', 'mongodb')).toBe(false)
    expect(isMutatingStatement('db .', 'mongodb')).toBe(true)
    expect(isMutatingStatement('db []', 'mongodb')).toBe(true)
    expect(isMutatingStatement('db..find()', 'mongodb')).toBe(true)
    expect(isMutatingStatement('db.users.find(unclosed', 'mongodb')).toBe(true)
    expect(isMutatingStatement('db[123].find()', 'mongodb')).toBe(true)
    expect(isMutatingStatement('db[""].find()', 'mongodb')).toBe(true)
    expect(isMutatingStatement('db.unknownDbFn()', 'mongodb')).toBe(true)
    expect(isMutatingStatement('db.getCollection("u").notCursor', 'mongodb')).toBe(true)
    expect(isMutatingStatement('db.users.insertOne({ a: 1 })', 'mongodb')).toBe(true)
    expect(isMutatingStatement('db.users.find({ a: 1 }).unknownChain()', 'mongodb')).toBe(true)
    expect(
      isMutatingStatement('db.users.aggregate([{ $out: "copy" }])', 'mongodb')
    ).toBe(true)
    expect(
      isMutatingStatement('db.users.find().aggregate([{ "$merge": "t" }])', 'mongodb')
    ).toBe(true)
    expect(isMutatingStatement('{ "insert": "u" }', 'mongodb')).toBe(true)
    expect(isMutatingStatement('{ "aggregate": "u", "pipeline": [{ "$merge": "t" }] }', 'mongodb')).toBe(true)
    expect(isMutatingStatement('{ "explain": { "drop": "u" } }', 'mongodb')).toBe(true)
    expect(isMutatingStatement('[]', 'mongodb')).toBe(true)
    expect(isMutatingStatement('{}', 'mongodb')).toBe(true)
    expect(isMutatingStatement('{', 'mongodb')).toBe(true)
    // Non-JSON JS object fallback paths inside isMongoRawCommandObjectMutating
    expect(isMutatingStatement('{ find: "u", filter: /a[x]\\/b/gi }', 'mongodb')).toBe(false)
    expect(isMutatingStatement("{ explain: { 'count': 'u' } }", 'mongodb')).toBe(false)
    expect(isMutatingStatement('{ explain: "notObj" }', 'mongodb')).toBe(true)
    expect(isMutatingStatement('{ 123: 1 }', 'mongodb')).toBe(true)
    expect(isMutatingStatement('{ }', 'mongodb')).toBe(true)
  })

  it('rewrites CockroachDB view database qualifiers while preserving portability and detecting unsafe forms', () => {
    expect(rewriteCockroachViewBodyWithMeta('', 'appdb')).toEqual({
      body: '',
      hasExternalDbReference: false,
    })

    const rewritten = rewriteCockroachViewBodyDatabaseQualifier(
      "SELECT u.id, 'db1.public.ignored', 123 FROM db1.public.users AS u JOIN \"db1\".public.orders o ON o.uid = u.id, LATERAL ONLY (SELECT * FROM extdb.public.audit) a WHERE E'it\\'s' = $$x$$ -- cmt\n /* /* blk */ */",
      'db1'
    )
    expect(rewritten).toContain('FROM public.users AS u JOIN public.orders o')
    expect(rewritten).toContain("'db1.public.ignored'")

    const metaExt = rewriteCockroachViewBodyWithMeta(
      'SELECT 1 IS DISTINCT FROM 2, * FROM extdb.public.t; SELECT * FROM (SELECT 1 FROM db1.public.a UNION SELECT 1 FROM pg_catalog.generate_series(1, 2) WHERE 1=1) g JOIN db1.public.b USING (id)',
      'db1'
    )
    expect(metaExt.hasExternalDbReference).toBe(true)
    expect(metaExt.body).toContain('FROM public.a')
    expect(metaExt.body).toContain('JOIN public.b')

    const groupParen = rewriteCockroachViewBodyWithMeta(
      'SELECT * FROM ONLY (db1.public.t1), LATERAL (VALUES (1)) v WHERE $tag$body$tag$ IS NOT NULL',
      'db1'
    )
    expect(groupParen.body).toContain('(public.t1)')

    expect(() =>
      rewriteCockroachViewBodyWithMeta('SELECT * FROM db1 . /* c */ public.t', 'db1')
    ).toThrow(/cannot be made portable/)
    expect(() =>
      rewriteCockroachViewBodyWithMeta('SELECT * FROM db1.a.b.c', 'db1')
    ).toThrow(/cannot be made portable/)
    expect(() =>
      rewriteCockroachViewBodyWithMeta("SELECT * FROM db1.public.t WHERE x = 'unclosed", 'db1')
    ).toThrow(/cannot be made portable/)
    expect(() =>
      rewriteCockroachViewBodyWithMeta('SELECT * FROM db1.public.t WHERE ((1=1', 'db1')
    ).toThrow(/cannot be made portable/)
    expect(() =>
      rewriteCockroachViewBodyWithMeta('SELECT * FROM db1.public.t) /* unclosed', 'db1')
    ).toThrow(/cannot be made portable/)
    expect(() =>
      rewriteCockroachViewBodyWithMeta("SELECT * FROM db1.public.t WHERE x = $u$a AND y = \"q AND z = E'e", 'db1')
    ).toThrow(/cannot be made portable/)
    expect(
      rewriteCockroachViewBodyWithMeta('SELECT * FROM public.users WHERE id = 1', 'db1').body
    ).toBe('SELECT * FROM public.users WHERE id = 1')

    expect(
      rewriteCockroachViewBodyWithMeta('SELECT * FROM db1.public.; SELECT * FROM t2', 'db1').body
    ).toContain('db1.public.;')
    expect(
      rewriteCockroachViewBodyWithMeta("SELECT * FROM (SELECT 1) s, 123, 'lit'", 'db1').body
    ).toContain("'lit'")

    // Remaining reachable sql-lexer.ts branches:
    expect(() => buildQuickFilterPredicate(undefined as unknown as string, 1, 'eq', 'postgres')).toThrow()
    expect(isExplainTargetMutating('INSERT INTO t VALUES (1)', 'postgres')).toBe(true)
    expect(isMutatingStatement("SELECT * INTO OUTFILE '/tmp/out' FROM users", 'mysql')).toBe(true)
    expect(isMutatingStatement('SELECT * FROM users FOR UPDATE', 'postgres')).toBe(true)
    expect(isMutatingStatement('PING', 'redis')).toBe(false)

    // Mongo unclosed string, comments inside group, EOF line comment, spaced key/$out, invalid explain, bad tails
    expect(isMutatingStatement('db.users.find({ a: "unclosed })', 'mongodb')).toBe(false)
    expect(isMutatingStatement('db.users.find((1) /* c */ // line\n)', 'mongodb')).toBe(false)
    expect(isMutatingStatement('db.users.find((/* unclosed', 'mongodb')).toBe(true)
    expect(isMutatingStatement('db.users.find() // eof comment', 'mongodb')).toBe(false)
    expect(isMutatingStatement('db.runCommand({ $out   : "copy" })', 'mongodb')).toBe(true)
    expect(isMutatingStatement('{ \'explain\': { } }', 'mongodb')).toBe(true)
    expect(isMutatingStatement('{ \'find\' : \'users\' }', 'mongodb')).toBe(false)
    expect(isMutatingStatement('{ \'flag\' }', 'mongodb')).toBe(true)
    expect(isMutatingStatement('{ "explain": { "aggregate": [{ "$out": "t" }] } }', 'mongodb')).toBe(true)
    expect(isMutatingStatement('db.runCommand({ a: 1, $out: "t" })', 'mongodb')).toBe(true)
    expect(isMutatingStatement('db[\'unclosed', 'mongodb')).toBe(true)
    expect(isMutatingStatement('db .users extra', 'mongodb')).toBe(true)
    expect(isMutatingStatement('db .users.stats', 'mongodb')).toBe(true)
    expect(isMutatingStatement('db.stats().extra()', 'mongodb')).toBe(true)
    expect(isMutatingStatement('db .users', 'mongodb')).toBe(true)

    // Cockroach view unclosed E'...' and "..." + leading comment before FROM + unclosed trailing `(`
    expect(() =>
      rewriteCockroachViewBodyWithMeta("SELECT * FROM db1.public.t WHERE x = E'unclosed", 'db1')
    ).toThrow(/cannot be made portable/)
    expect(() =>
      rewriteCockroachViewBodyWithMeta('SELECT * FROM db1.public.t WHERE x = "unclosed', 'db1')
    ).toThrow(/cannot be made portable/)
    expect(() =>
      rewriteCockroachViewBodyWithMeta('/* lead */ FROM db1.public.t WHERE (', 'db1')
    ).toThrow(/cannot be made portable/)
    expect(
      rewriteCockroachViewBodyWithMeta('/* lead */ FROM public.t WHERE (', 'db1').body
    ).toBe('/* lead */ FROM public.t WHERE (')
  })
})
