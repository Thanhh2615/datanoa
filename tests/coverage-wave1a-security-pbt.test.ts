import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  analyzeDangerousSql,
  detectRedisCredentialCommand,
  findCredentialAuthorityAtIndex,
  maskConnectionUriSecret,
  scanSecretValueSpan,
  scrubSensitiveText,
  tokenizeRedisCommandLine,
} from '../src/shared-sql-safety.js'
import type { DatabaseDriverType } from '../src/protocol.js'

describe('Wave 1A Group 3: shared-sql-safety.js behavioral & PBT coverage', () => {
  it('covers findCredentialAuthorityAtIndex and maskConnectionUriSecret edge cases', () => {
    // Invalid inputs / out-of-range colon
    expect(findCredentialAuthorityAtIndex('postgres://', null as unknown as string, 0)).toBe(-1)
    expect(findCredentialAuthorityAtIndex('postgres://', 'abc', -1)).toBe(-1)
    expect(findCredentialAuthorityAtIndex('postgres://', 'abc', 99)).toBe(-1)
    expect(findCredentialAuthorityAtIndex('postgres://', 'abc:def', 1)).toBe(-1)
    expect(findCredentialAuthorityAtIndex(undefined as unknown as string, 'u:p@host', 1)).toBe(3)

    // Invalid ports / non-host entries / IPv6 / qualified vs unqualified candidates
    expect(findCredentialAuthorityAtIndex('postgres://', 'u:p@host:0', 1)).toBe(-1)
    expect(findCredentialAuthorityAtIndex('postgres://', 'u:p@host:70000', 1)).toBe(-1)
    expect(findCredentialAuthorityAtIndex('postgres://', 'u:p@host:notport', 1)).toBe(-1)
    expect(findCredentialAuthorityAtIndex('postgres://', 'u:p@1234', 1)).toBe(-1)
    expect(findCredentialAuthorityAtIndex('postgres://', 'u:p@host,,host2', 1)).toBe(-1)
    expect(findCredentialAuthorityAtIndex('postgres://', 'u:p@[::1]:5432/db', 1)).toBe(3)

    // originIsHostPort branches for HTTP vs non-HTTP and slashThenQueryOrHash / fragment
    expect(
      findCredentialAuthorityAtIndex('http://', 'example.com:8080/path?x=1@host.local:80', 11)
    ).toBe(25)
    expect(
      findCredentialAuthorityAtIndex('http://', 'example.com:8080/path?x=1@host', 11)
    ).toBe(-1)
    expect(
      findCredentialAuthorityAtIndex('http://', 'example.com:8080#frag=1@host', 11)
    ).toBe(-1)
    expect(
      findCredentialAuthorityAtIndex('http://', 'example.com:8080#frag=1@host/p', 11)
    ).toBe(23)
    expect(
      findCredentialAuthorityAtIndex('http://', 'example.com:8080?x=1@host', 11)
    ).toBe(-1)
    expect(
      findCredentialAuthorityAtIndex('http://', 'example.com:8080?x=1@host/p', 11)
    ).toBe(20)
    expect(
      findCredentialAuthorityAtIndex('http://', 'example.com:8080?x=1@host:9090/p', 11)
    ).toBe(20)
    expect(
      findCredentialAuthorityAtIndex('postgres://', 'host:5432#frag=1@other', 4)
    ).toBe(-1)
    expect(
      findCredentialAuthorityAtIndex('http://', 'example.com:8080#frag=1@host', 11)
    ).toBe(-1)
    expect(
      findCredentialAuthorityAtIndex('http://', 'example.com:8080#frag=1@host/p', 11)
    ).toBe(23)
    expect(
      findCredentialAuthorityAtIndex('postgres://', 'u:p/a@host1/p?q=@host2', 1)
    ).toBe(5)
    // Candidate pool fallback: all candidates after query/fragment assignment
    expect(
      findCredentialAuthorityAtIndex('postgres://', 'u:p?a=1@h1@h2:5432', 1)
    ).toBe(10)
    expect(
      findCredentialAuthorityAtIndex('postgres://', 'u:p#a=1@h1', 1)
    ).toBe(7)

    // maskConnectionUriSecret: empty, malformed % key in query, fragment with '?'
    expect(maskConnectionUriSecret('')).toBe('')
    expect(maskConnectionUriSecret('postgres://u:sec@host/db?%E0%A4%A=val&token=abc#f?password=123&other=1')).toBe(
      'postgres://u:***@host/db?%E0%A4%A=val&token=***#f?password=***&other=1'
    )
    expect(maskConnectionUriSecret('postgres://host/db?flagOnly')).toBe(
      'postgres://host/db?flagOnly'
    )
  })

  it('covers scanSecretValueSpan and scrubSensitiveText across quotes, braces, multi-backslash JSON, and fragments', () => {
    expect(scanSecretValueSpan(null as unknown as string, 0)).toEqual({ skip: true, end: 0 })
    expect(scanSecretValueSpan('abc', -1)).toEqual({ skip: true, end: -1 })
    expect(scanSecretValueSpan('abc', 9)).toEqual({ skip: true, end: 9 })

    // Empty value in ado mode skips, in query mode returns non-skip empty span
    expect(scanSecretValueSpan('Pwd=;', 4, 'ado')).toEqual({ skip: true, end: 4 })
    expect(scanSecretValueSpan('?pwd=&x=1', 5, 'query')).toEqual({ skip: false, end: 5 })

    // Escaped brace password `{pass}}word}` and unterminated `{`
    expect(scanSecretValueSpan('Pwd={a}}b};', 4, 'ado')).toEqual({ skip: false, end: 10 })
    expect(scanSecretValueSpan('Pwd={unterminated', 4, 'ado').skip).toBe(false)

    // Quoted literal with escaped char & unterminated quote falling through to skip
    expect(scanSecretValueSpan("Pwd='a\\'b';", 4, 'ado')).toEqual({ skip: false, end: 10 })
    expect(scanSecretValueSpan("Pwd='unterminated", 4, 'ado')).toEqual({ skip: true, end: 4 })

    // Odd & even backslash-escaped quotes in JSON exceptions
    expect(scanSecretValueSpan('"Pwd=\\\\"', 5, 'ado')).toEqual({ skip: false, end: 7 })
    const multiBs = 'Pwd=\\\\\\"sec\\a\\\\b\\n\\""'
    expect(scanSecretValueSpan(multiBs, 4, 'ado')).toEqual({
      skip: false,
      end: multiBs.length - 1,
    })
    expect(scanSecretValueSpan('Pwd=\\"sec\\\\"next"', 4, 'ado')).toEqual({
      skip: false,
      end: 11,
    })
    expect(scanSecretValueSpan('Pwd=\\"unterminated', 4, 'ado').end).toBe(18)
    expect(scanSecretValueSpan('Pwd=\\"line1\nline2', 4, 'ado').end).toBe(11)

    // Redacted sentinel with trailing real secret + backslash-slash path inside value
    expect(scanSecretValueSpan('Pwd=[REDACTED]real\\/path ', 4, 'ado')).toEqual({
      skip: false,
      end: 24,
    })
    expect(scanSecretValueSpan('Pwd=[REDACTED]: err', 4, 'ado')).toEqual({ skip: true, end: 14 })
    expect(scanSecretValueSpan('Pwd=***: err', 4, 'mongo')).toEqual({ skip: true, end: 7 })

    // scrubSensitiveText non-string / empty / boundary checks (`1http://`) / malformed % key / fragments
    expect(scrubSensitiveText(null as unknown as string)).toBe('')
    expect(scrubSensitiveText('')).toBe('')
    expect(
      scrubSensitiveText(
        '1http://u:keep@host/p postgres://u:sec@host/db?%E0%A4%A=1&=empty#opaque) next http://u:p@host#k=1'
      )
    ).toContain('1http://u:keep@host/p')

    const fragStripped = scrubSensitiveText(
      '1http://a:b@h#f postgres://u:sec@h#frag(1) http://x:y@h#k=1',
      { stripOpaqueFragment: true }
    )
    expect(fragStripped).toContain('1http://a:b@h#f')
    expect(fragStripped).toContain('postgres://u@h#[REDACTED])')
    expect(fragStripped).toContain('http://x@h#k=1')
    expect(scrubSensitiveText(fragStripped, { stripOpaqueFragment: true })).toBe(fragStripped)

    const allFragStripped = scrubSensitiveText('1http://a:b@h#f https://u:sec@h#secretfrag', {
      stripAllFragments: true,
    })
    expect(allFragStripped).toContain('1http://a:b@h#f')
    expect(allFragStripped).toBe('1http://a:b@h#f https://u@h')
  })

  it('covers Redis tokenizer, credential detection, and dangerous Redis/SQL/Mongo/EXPLAIN analyzers', () => {
    // Redis tokenizer escapes: \n, \r, \t, \x41, unknown \z, // comment, strict error
    expect(tokenizeRedisCommandLine('// comment line')).toEqual([])
    expect(tokenizeRedisCommandLine('SET k "a\\nb\\rc\\td\\x41\\z"')).toEqual([
      'SET',
      'k',
      'a\nb\rc\tdAz',
    ])
    expect(() => tokenizeRedisCommandLine('SET k "unterminated', { strict: true })).toThrow(
      'Unterminated'
    )

    // detectRedisCredentialCommand: placeholders, empty string, HELLO single AUTH, MIGRATE KEYS/AUTH/AUTH2
    expect(detectRedisCredentialCommand('')).toBe(false)
    expect(detectRedisCredentialCommand('AUTH ""')).toBe(false)
    expect(detectRedisCredentialCommand('AUTH <PASSWORD>')).toBe(false)
    expect(detectRedisCredentialCommand('AUTH $1')).toBe(false)
    expect(detectRedisCredentialCommand('HELLO 3 AUTH mypass123')).toBe(true)
    expect(detectRedisCredentialCommand('HELLO 3 AUTH <TOKEN>')).toBe(false)
    expect(detectRedisCredentialCommand('MIGRATE 127.0.0.1 6379 "" 0 5000 KEYS k1 AUTH safe')).toBe(
      false
    )
    expect(detectRedisCredentialCommand('MIGRATE 127.0.0.1 6379 "" 0 5000 AUTH mysecret')).toBe(true)
    expect(detectRedisCredentialCommand('MIGRATE 127.0.0.1 6379 "" 0 5000 AUTH <PASSWORD>')).toBe(
      false
    )
    expect(
      detectRedisCredentialCommand('MIGRATE 127.0.0.1 6379 "" 0 5000 AUTH2 usr secret2')
    ).toBe(true)
    expect(
      detectRedisCredentialCommand('MIGRATE 127.0.0.1 6379 "" 0 5000 AUTH2 usr <PASSWORD>')
    ).toBe(false)

    // analyzeDangerousSql empty/Redis/comments-only/EXPLAIN options/MariaDB ANALYZE/DML variants
    expect(analyzeDangerousSql('', 'postgres')).toEqual([])
    expect(analyzeDangerousSql('   ', 'postgres')).toEqual([])
    expect(analyzeDangerousSql('# comment\n// c2\nGET foo\n"FLUSHDB"', 'redis')).toHaveLength(1)
    expect(analyzeDangerousSql('123\nGET foo', 'redis')).toEqual([])
    expect(analyzeDangerousSql('/* just comment */', 'postgres')).toEqual([])

    const explainCases: Array<[string, DatabaseDriverType, boolean]> = [
      ['EXPLAIN (ANALYZE FALSE, VERBOSE) DELETE FROM users', 'postgres', false],
      ['EXPLAIN ANALYZE', 'postgres', false],
      ['EXPLAIN ANALYZE VERBOSE DELETE FROM users', 'postgres', true],
      ['EXPLAIN (ANALYZE, INTO OUTFILE "/tmp/x" DELETE FROM users', 'postgres', false],
      ['EXPLAIN (ANALYZE, INTO OUTFILE "/tmp/x") DELETE FROM users', 'postgres', true],
      ['EXPLAIN (ANALYZE, FORMAT JSON) UPDATE users SET a = 1', 'postgres', true],
      ['EXPLAIN max_threads = 1, ANALYZE DELETE FROM users', 'clickhouse', true],
      ['EXPLAIN ANALYZE REPLACE INTO t VALUES (1)', 'mysql', false],
      ['EXPLAIN ANALYZE MERGE INTO t USING s ON (1=1) WHEN NOT MATCHED THEN INSERT (id) VALUES (1)', 'oracle', false],
      ['EXPLAIN ANALYZE MERGE INTO t USING s ON (1=1) WHEN MATCHED THEN DELETE', 'oracle', true],
      ['EXPLAIN ANALYZE ALTER TABLE t ADD COLUMN c INT', 'postgres', false],
      ['EXPLAIN ANALYZE CREATE TABLE t (id INT)', 'postgres', false],
      ['EXPLAIN ANALYZE INSERT INTO t VALUES (1)', 'postgres', false],
      ['EXPLAIN ANALYZE DROP TABLE t', 'postgres', true],
      ['EXPLAIN ANALYZE TRUNCATE TABLE t', 'postgres', true],
      ['EXPLAIN ANALYZE WITH d AS (DELETE FROM t) SELECT * FROM d', 'postgres', true],
      ['ANALYZE DELETE FROM users', 'mariadb', true],
      ['ANALYZE UPDATE users SET a = 1', 'mariadb', true],
      ['ANALYZE DROP TABLE users', 'mariadb', true],
      ['ANALYZE TRUNCATE TABLE users', 'mariadb', true],
      ['ANALYZE WITH d AS (DELETE FROM t) SELECT 1', 'mariadb', true],
      ['ANALYZE "lit"', 'mariadb', false],
    ]
    for (const [sql, dialect, expectDangerous] of explainCases) {
      const res = analyzeDangerousSql(sql, dialect)
      expect(res.length > 0, `SQL: ${sql}`).toBe(expectDangerous)
    }

    // Dialects & SQL tokens: MySQL # and /*!50000 ...*/, PG E'...' and $tag$, SQLite/MSSQL [col]]x], bare DELETE/UPDATE/DROP/TRUNCATE
    expect(analyzeDangerousSql("# c\n/*!50000 DROP TABLE t1 */;", 'mysql')).toHaveLength(1)
    expect(analyzeDangerousSql('/*!50000 EXPLAIN ANALYZE DELETE FROM t */', 'mysql')).toHaveLength(1)
    expect(
      analyzeDangerousSql(
        "/* non-exec */ SELECT E'a\\'b', 'str', $q$DROP$q$; DELETE users",
        'postgres'
      )
    ).toHaveLength(1)
    expect(analyzeDangerousSql('SELECT $q$unclosed', 'postgres')).toEqual([])
    expect(analyzeDangerousSql('UPDATE [unclosed]]col SET x=1', 'mssql')).toHaveLength(1)
    expect(analyzeDangerousSql('DELETE FROM `my``tbl`; UPDATE `unclosed``col SET x=1', 'mysql')).toHaveLength(2)
    expect(analyzeDangerousSql('DROP TABLE "my""tbl"; DROP TABLE', 'postgres')[0].target).toBe('my"tbl')
    expect(analyzeDangerousSql('DROP TABLE', 'postgres')[0].target).toBeUndefined()
    expect(analyzeDangerousSql('DROP (x) users', 'postgres')[0].target).toBe('users')
    expect(analyzeDangerousSql('UPDATE', 'postgres')[0].target).toBeUndefined()
    expect(analyzeDangerousSql('TRUNCATE TABLE', 'postgres')[0].target).toBeUndefined()
    expect(analyzeDangerousSql('WITH c AS (DELETE) SELECT 1', 'postgres')).toHaveLength(1)
    expect(analyzeDangerousSql('WITH c AS (SELECT 1) DELETE FROM t', 'postgres')).toHaveLength(1)
    expect(analyzeDangerousSql('SELECT (1)); DELETE FROM items', 'postgres')).toHaveLength(1)
    expect(
      analyzeDangerousSql('WITH c AS (UPDATE users SET a = 1) SELECT * FROM c', 'postgres')
    ).toHaveLength(1)

    // MongoDB dangerous script & JSON command coverage (including EOF comments, nested parens, missing target)
    const mongoFindings = analyzeDangerousSql(
      `
      // line comment
      -- sql comment
      /* block comment */
      { "drop": "logs", "extra": 12.5 };
      { "dropDatabase": 1 };
      { "delete": "orders", "deletes": [{ "q": {} }] };
      { "update": "users", "updates": [{ "q": {} }] };
      [1, 2];
      { bad json };
      db.getCollection('items\\'1').drop();
      db.dropDatabase();
      db.orders.deleteMany();
      db.orders.deleteMany((1));
      db.orders.remove({ });
      db.orders.updateMany({}, { $set: { a: [1] } });
      db.fn().drop();
      db.fn().deleteMany({});
      db.fn().updateMany({}, {});
      .drop();
      /* unclosed at eof`,
      'mongodb'
    )
    expect(mongoFindings.length).toBeGreaterThanOrEqual(11)
    expect(
      analyzeDangerousSql('db.orders.deleteMany({ status: [1, 2], "unterminated: 1 });', 'mongodb')
    ).toEqual([])
    expect(analyzeDangerousSql('// comment eof', 'mongodb')).toEqual([])
    expect(analyzeDangerousSql('-- comment eof', 'mongodb')).toEqual([])
  })

  it('PBT: scrubSensitiveText is strictly idempotent, never leaks embedded secrets, and handles arbitrary UTF-8 safely', () => {
    const safeOptsArb = fc.record({
      stripOpaqueFragment: fc.boolean(),
      stripAllFragments: fc.boolean(),
    })

    // Strict idempotency across combinations of URIs, queries, fragments, backslashes, and [REDACTED]
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z]{3,8}$/),
        fc.stringMatching(/^[A-Za-z0-9_]{2,8}$/),
        fc.stringMatching(/^[A-Za-z0-9!$_.-]{3,12}$/),
        fc.integer({ min: 0, max: 13 }),
        safeOptsArb,
        (scheme, user, secret, bsCount, opts) => {
          const slashes = '\\'.repeat(bsCount)
          const text = `${scheme}://${user}:${secret}@db.example.com:5432/app?token=${secret}&email=${user}@corp.io#frag; Pwd=${slashes}"${secret}${slashes}" Authorization: Bearer ${secret} Pwd=[REDACTED]`
          const once = scrubSensitiveText(text, opts)
          const twice = scrubSensitiveText(once, opts)
          const thrice = scrubSensitiveText(twice, opts)
          expect(twice).toBe(once)
          expect(thrice).toBe(once)
          expect(once).not.toContain(`:${secret}@`)
          expect(once).not.toContain(`token=${secret}`)
          expect(once).toContain(`email=${user}@corp.io`)
        }
      ),
      { numRuns: 100 }
    )

    // Fuzz resilience: never throws on arbitrary UTF-8 strings for scrub, redis tokenizer, and danger analyzer
    fc.assert(
      fc.property(fc.string({ maxLength: 120 }), (input) => {
        const scrubbed = scrubSensitiveText(input, { stripOpaqueFragment: true })
        expect(scrubSensitiveText(scrubbed, { stripOpaqueFragment: true })).toBe(scrubbed)
        expect(() => tokenizeRedisCommandLine(input)).not.toThrow()
        expect(() => analyzeDangerousSql(input, 'postgres')).not.toThrow()
        expect(() => analyzeDangerousSql(input, 'mongodb')).not.toThrow()
      }),
      { numRuns: 100 }
    )
  })
})
