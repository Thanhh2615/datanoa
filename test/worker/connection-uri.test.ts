import { describe, expect, it } from 'vitest'
import {
  ENGINE_CATALOG,
  SUPPORTED_DRIVERS,
  parseConnectionUri,
} from '../../src/drivers/common/connection-uri'

describe('connection-uri: ENGINE_CATALOG & SUPPORTED_DRIVERS', () => {
  it('exposes all 8 supported drivers and engine metadata with exact default ports', () => {
    expect(SUPPORTED_DRIVERS).toEqual([
      'sqlite',
      'postgres',
      'mysql',
      'mariadb',
      'cockroachdb',
      'clickhouse',
      'redis',
      'libsql',
    ])
    expect(ENGINE_CATALOG).toHaveLength(8)

    const byId = Object.fromEntries(ENGINE_CATALOG.map((e) => [e.id, e]))
    expect(byId.sqlite).toMatchObject({ id: 'sqlite', defaultPort: 0, supportsSsl: false, kind: 'file' })
    expect(byId.postgres).toMatchObject({ id: 'postgres', defaultPort: 5432, supportsSsl: true, kind: 'sql' })
    expect(byId.mysql).toMatchObject({ id: 'mysql', defaultPort: 3306, supportsSsl: true, kind: 'sql' })
    expect(byId.mariadb).toMatchObject({ id: 'mariadb', defaultPort: 3306, supportsSsl: true, kind: 'sql' })
    expect(byId.cockroachdb).toMatchObject({ id: 'cockroachdb', defaultPort: 26257, supportsSsl: true, kind: 'sql' })
    expect(byId.clickhouse).toMatchObject({ id: 'clickhouse', defaultPort: 8123, supportsSsl: true, kind: 'http' })
    expect(byId.redis).toMatchObject({ id: 'redis', defaultPort: 6379, supportsSsl: true, kind: 'kv' })
    expect(byId.libsql).toMatchObject({ id: 'libsql', defaultPort: 443, supportsSsl: true, kind: 'http' })

    for (const item of ENGINE_CATALOG) {
      expect(item.label.length).toBeGreaterThan(0)
      expect(item.shortLabel.length).toBeGreaterThan(0)
    }
  })
})

describe('connection-uri: PostgreSQL & CockroachDB', () => {
  it('parses postgres:// and postgresql:// URIs with decoded credentials and SSL params', () => {
    const res1 = parseConnectionUri(
      'postgres://admin%40org:p%40ss%23word%21@ep-cool.us-east-2.aws.neon.tech:5433/neondb?sslmode=require'
    )
    expect(res1.ok).toBe(true)
    expect(res1.password).toBe('p@ss#word!')
    expect(res1.profile).toMatchObject({
      driver: 'postgres',
      host: 'ep-cool.us-east-2.aws.neon.tech',
      port: 5433,
      user: 'admin@org',
      database: 'neondb',
      hasPassword: true,
      ssl: true,
    })

    const res2 = parseConnectionUri('postgresql://reader@db.internal/analytics?ssl=true')
    expect(res2.ok).toBe(true)
    expect(res2.password).toBeUndefined()
    expect(res2.profile).toMatchObject({
      driver: 'postgres',
      host: 'db.internal',
      port: 5432,
      user: 'reader',
      database: 'analytics',
      ssl: true,
    })

    const res3 = parseConnectionUri('postgres://localhost/dev?sslmode=verify-full')
    expect(res3.ok).toBe(true)
    expect(res3.profile?.ssl).toBe(true)

    const res4 = parseConnectionUri('postgres://localhost/dev?sslmode=verify-ca')
    expect(res4.ok).toBe(true)
    expect(res4.profile?.ssl).toBe(true)

    const res5 = parseConnectionUri('postgres://localhost/dev')
    expect(res5.ok).toBe(true)
    expect(res5.profile).toMatchObject({
      driver: 'postgres',
      host: 'localhost',
      port: 5432,
      database: 'dev',
      ssl: false,
    })
  })

  it('parses cockroachdb:// and cockroach:// with default port 26257 and ssl=true unless sslmode=disable', () => {
    const crdbDefault = parseConnectionUri('cockroachdb://max:roach@free-tier.cockroachlabs.cloud/movr')
    expect(crdbDefault.ok).toBe(true)
    expect(crdbDefault.password).toBe('roach')
    expect(crdbDefault.profile).toMatchObject({
      driver: 'cockroachdb',
      host: 'free-tier.cockroachlabs.cloud',
      port: 26257,
      user: 'max',
      database: 'movr',
      hasPassword: true,
      ssl: true,
    })

    const crdbInsecure = parseConnectionUri('cockroach://root@localhost:26258/defaultdb?sslmode=disable')
    expect(crdbInsecure.ok).toBe(true)
    expect(crdbInsecure.profile).toMatchObject({
      driver: 'cockroachdb',
      host: 'localhost',
      port: 26258,
      user: 'root',
      database: 'defaultdb',
      ssl: false,
    })
  })
})

describe('connection-uri: MySQL & MariaDB', () => {
  it('parses mysql:// and mariadb:// URIs with default port 3306, credentials, and SSL params', () => {
    const mysqlRes = parseConnectionUri(
      'mysql://app_user:sec%2Fr%2Bet@mysql.planetscale.internal:3307/shop_prod?ssl={"rejectUnauthorized":true}'
    )
    expect(mysqlRes.ok).toBe(true)
    expect(mysqlRes.password).toBe('sec/r+et')
    expect(mysqlRes.profile).toMatchObject({
      driver: 'mysql',
      host: 'mysql.planetscale.internal',
      port: 3307,
      user: 'app_user',
      database: 'shop_prod',
      hasPassword: true,
      ssl: true,
    })

    const mariaRes = parseConnectionUri('mariadb://dba:pass123@10.0.0.15/inventory?ssl-mode=REQUIRED')
    expect(mariaRes.ok).toBe(true)
    expect(mariaRes.password).toBe('pass123')
    expect(mariaRes.profile).toMatchObject({
      driver: 'mariadb',
      host: '10.0.0.15',
      port: 3306,
      user: 'dba',
      database: 'inventory',
      hasPassword: true,
      ssl: true,
    })

    const localMysql = parseConnectionUri('mysql://root@127.0.0.1')
    expect(localMysql.ok).toBe(true)
    expect(localMysql.profile).toMatchObject({
      driver: 'mysql',
      host: '127.0.0.1',
      port: 3306,
      user: 'root',
      database: '',
      ssl: false,
    })
  })
})

describe('connection-uri: Redis & Rediss', () => {
  it('parses rediss:// Upstash URLs, DB indexes 0..15, TLS params, and URL-encoded credentials', () => {
    const upstash = parseConnectionUri('rediss://default:AXyz%2F123%3D@us1-merry.upstash.io:6379')
    expect(upstash.ok).toBe(true)
    expect(upstash.password).toBe('AXyz/123=')
    expect(upstash.profile).toMatchObject({
      driver: 'redis',
      host: 'us1-merry.upstash.io',
      port: 6379,
      user: 'default',
      redisDb: 0,
      database: '0',
      hasPassword: true,
      ssl: true,
    })

    const passOnly = parseConnectionUri('redis://:my%40secret@127.0.0.1:6380/5')
    expect(passOnly.ok).toBe(true)
    expect(passOnly.password).toBe('my@secret')
    expect(passOnly.profile?.user).toBeUndefined()
    expect(passOnly.profile).toMatchObject({
      driver: 'redis',
      host: '127.0.0.1',
      port: 6380,
      redisDb: 5,
      database: '5',
      hasPassword: true,
      ssl: false,
    })

    const tlsParam = parseConnectionUri('redis://cache.internal/15?tls=true')
    expect(tlsParam.ok).toBe(true)
    expect(tlsParam.profile).toMatchObject({
      driver: 'redis',
      host: 'cache.internal',
      port: 6379,
      redisDb: 15,
      database: '15',
      ssl: true,
    })

    const sslParam = parseConnectionUri('redis://cache.internal/0?ssl=true')
    expect(sslParam.ok).toBe(true)
    expect(sslParam.profile?.ssl).toBe(true)
    expect(sslParam.profile?.redisDb).toBe(0)
  })

  it('rejects out-of-range or non-numeric Redis DB indexes without throwing', () => {
    const outOfRange = parseConnectionUri('redis://localhost:6379/16')
    expect(outOfRange.ok).toBe(false)
    expect(outOfRange.error).toBeTruthy()

    const nonNumeric = parseConnectionUri('redis://localhost:6379/mydb')
    expect(nonNumeric.ok).toBe(false)
    expect(nonNumeric.error).toBeTruthy()
  })
})

describe('connection-uri: ClickHouse & LibSQL', () => {
  it('parses clickhouse://, clickhouses://, http://, and https:// into clickhouse profile without leaking credentials into url', () => {
    const chHttp = parseConnectionUri('http://ch_user:p%40ss@localhost:8123/analytics')
    expect(chHttp.ok).toBe(true)
    expect(chHttp.password).toBe('p@ss')
    expect(chHttp.profile).toMatchObject({
      driver: 'clickhouse',
      url: 'http://localhost:8123',
      host: 'localhost',
      port: 8123,
      user: 'ch_user',
      database: 'analytics',
      hasPassword: true,
      ssl: false,
    })

    const chCloud = parseConnectionUri('https://default:secret@abc.clickhouse.cloud:8443/prod')
    expect(chCloud.ok).toBe(true)
    expect(chCloud.password).toBe('secret')
    expect(chCloud.profile?.url).not.toContain('secret')
    expect(chCloud.profile).toMatchObject({
      driver: 'clickhouse',
      url: 'https://abc.clickhouse.cloud:8443',
      host: 'abc.clickhouse.cloud',
      port: 8443,
      user: 'default',
      database: 'prod',
      hasPassword: true,
      ssl: true,
    })

    const chHttpsDefaultPort = parseConnectionUri('https://ch.internal/metrics')
    expect(chHttpsDefaultPort.ok).toBe(true)
    expect(chHttpsDefaultPort.profile).toMatchObject({
      driver: 'clickhouse',
      url: 'https://ch.internal',
      host: 'ch.internal',
      port: 443,
      database: 'metrics',
      ssl: true,
    })

    const chScheme = parseConnectionUri('clickhouses://reader@ch.example.com')
    expect(chScheme.ok).toBe(true)
    expect(chScheme.profile).toMatchObject({
      driver: 'clickhouse',
      url: 'https://ch.example.com:8443',
      host: 'ch.example.com',
      port: 8443,
      user: 'reader',
      database: 'default',
      ssl: true,
    })

    const chPlain = parseConnectionUri('clickhouse://10.0.0.5?ssl=true&database=events')
    expect(chPlain.ok).toBe(true)
    expect(chPlain.profile).toMatchObject({
      driver: 'clickhouse',
      url: 'https://10.0.0.5:8123',
      host: '10.0.0.5',
      port: 8123,
      database: 'events',
      ssl: true,
    })
  })

  it('parses libsql:// URIs, normalizes https url, and extracts authToken cleanly without leaking token in url', () => {
    const turso = parseConnectionUri('libsql://my-db-myorg.turso.io?authToken=eyJhbGci.payload.sig')
    expect(turso.ok).toBe(true)
    expect(turso.authToken).toBe('eyJhbGci.payload.sig')
    expect(turso.profile?.url).not.toContain('authToken')
    expect(turso.profile).toMatchObject({
      driver: 'libsql',
      url: 'https://my-db-myorg.turso.io',
      host: 'my-db-myorg.turso.io',
      port: 443,
      hasAuthToken: true,
      ssl: true,
    })

    const noToken = parseConnectionUri('libsql://public-db.turso.io')
    expect(noToken.ok).toBe(true)
    expect(noToken.authToken).toBeUndefined()
    expect(noToken.profile?.hasAuthToken).toBeUndefined()
    expect(noToken.profile).toMatchObject({
      driver: 'libsql',
      url: 'https://public-db.turso.io',
      host: 'public-db.turso.io',
      port: 443,
      ssl: true,
    })

    const localSqld = parseConnectionUri('libsql://127.0.0.1:8080?tls=0')
    expect(localSqld.ok).toBe(true)
    expect(localSqld.profile).toMatchObject({
      driver: 'libsql',
      url: 'http://127.0.0.1:8080',
      host: '127.0.0.1',
      port: 8080,
      ssl: false,
    })
  })
})

describe('connection-uri: SQLite & Error Cases', () => {
  it('parses sqlite:// and file:// URIs including Windows drive paths, encoded spaces, POSIX paths, and :memory:', () => {
    const winTriple = parseConnectionUri('sqlite:///D:/a/b.db')
    expect(winTriple.ok).toBe(true)
    expect(winTriple.profile).toMatchObject({
      driver: 'sqlite',
      filePath: 'D:/a/b.db',
      database: 'b.db',
    })

    const winDouble = parseConnectionUri('sqlite://D:/a/b.db')
    expect(winDouble.ok).toBe(true)
    expect(winDouble.profile).toMatchObject({
      driver: 'sqlite',
      filePath: 'D:/a/b.db',
      database: 'b.db',
    })

    const fileEncoded = parseConnectionUri('file:///D:/My%20Projects/app%201.sqlite?mode=ro')
    expect(fileEncoded.ok).toBe(true)
    expect(fileEncoded.profile).toMatchObject({
      driver: 'sqlite',
      filePath: 'D:/My Projects/app 1.sqlite',
      database: 'app 1.sqlite',
      readOnly: true,
    })

    const fileLocalhost = parseConnectionUri('file://localhost/D:/data/store.sqlite3')
    expect(fileLocalhost.ok).toBe(true)
    expect(fileLocalhost.profile).toMatchObject({
      driver: 'sqlite',
      filePath: 'D:/data/store.sqlite3',
      database: 'store.sqlite3',
    })

    const posix = parseConnectionUri('sqlite:///var/lib/datanoa/prod.db')
    expect(posix.ok).toBe(true)
    expect(posix.profile).toMatchObject({
      driver: 'sqlite',
      filePath: '/var/lib/datanoa/prod.db',
      database: 'prod.db',
    })

    const rel = parseConnectionUri('sqlite://./relative/local.db')
    expect(rel.ok).toBe(true)
    expect(rel.profile).toMatchObject({
      driver: 'sqlite',
      filePath: './relative/local.db',
      database: 'local.db',
    })

    const mem = parseConnectionUri('sqlite://:memory:')
    expect(mem.ok).toBe(true)
    expect(mem.profile).toMatchObject({
      driver: 'sqlite',
      filePath: ':memory:',
      database: ':memory:',
    })
  })

  it('returns { ok: false, error } without throwing on empty, malformed, missing-host, invalid-port, and unsupported URIs', () => {
    const invalidInputs = [
      '',
      '   ',
      'localhost:5432/db',
      'mongodb://localhost:27017/mydb',
      'ftp://files.internal/db.sqlite',
      'postgres:///onlydb',
      'redis://',
      'postgres://localhost:notaport/db',
      'mysql://localhost:70000/db',
      'sqlite://',
      'file:///',
      'http://[invalid-host/db',
    ]

    for (const input of invalidInputs) {
      const res = parseConnectionUri(input)
      expect(res.ok, `Expected failure for '${input}'`).toBe(false)
      expect(typeof res.error).toBe('string')
      expect((res.error ?? '').length).toBeGreaterThan(0)
    }
  })

  it('flags Supabase template placeholder passwords, strips brackets on real bracketed passwords, accepts .env KEY="uri" pastes, and recovers unencoded special characters (#, ?) in authority passwords', () => {
    const placeholder = parseConnectionUri(
      'postgresql://postgres:[YOUR-DATABASE-PASSWORD]@db.toethftlamjmkkodtglq.supabase.co:5432/postgres'
    )
    expect(placeholder.ok).toBe(true)
    expect(placeholder.password).toBeUndefined()
    expect(placeholder.placeholderPassword).toBe(true)
    expect(placeholder.profile).toMatchObject({
      driver: 'postgres',
      host: 'db.toethftlamjmkkodtglq.supabase.co',
      port: 5432,
      user: 'postgres',
      database: 'postgres',
      ssl: true,
    })

    // Exact Supabase pooler .env formats (DATABASE_URL="..." & DIRECT_URL="..." with [YOUR-PASSWORD])
    const envTxPooler = parseConnectionUri(
      'DATABASE_URL="postgresql://postgres.toethftlamjmkkodtglq:[YOUR-PASSWORD]@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true"'
    )
    expect(envTxPooler.ok).toBe(true)
    expect(envTxPooler.password).toBeUndefined()
    expect(envTxPooler.placeholderPassword).toBe(true)
    expect(envTxPooler.profile).toMatchObject({
      driver: 'postgres',
      host: 'aws-1-ap-southeast-1.pooler.supabase.com',
      port: 6543,
      user: 'postgres.toethftlamjmkkodtglq',
      database: 'postgres',
      ssl: true,
    })

    const quotedDirectPooler = parseConnectionUri(
      '"postgresql://postgres.toethftlamjmkkodtglq:SupaSecret!@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres"'
    )
    expect(quotedDirectPooler.ok).toBe(true)
    expect(quotedDirectPooler.password).toBe('SupaSecret!')
    expect(quotedDirectPooler.placeholderPassword).toBeUndefined()
    expect(quotedDirectPooler.profile).toMatchObject({
      driver: 'postgres',
      host: 'aws-1-ap-southeast-1.pooler.supabase.com',
      port: 5432,
      user: 'postgres.toethftlamjmkkodtglq',
      database: 'postgres',
      ssl: true,
      hasPassword: true,
    })

    // Bracketed password without '#' (where WHATWG new URL does NOT throw!) must still strip '[' and ']'
    const bracketedNoHash = parseConnectionUri(
      'postgresql://postgres:[MyPass123@]@db.toethftlamjmkkodtglq.supabase.co:5432/postgres'
    )
    expect(bracketedNoHash.ok).toBe(true)
    expect(bracketedNoHash.password).toBe('MyPass123@')
    expect(bracketedNoHash.placeholderPassword).toBeUndefined()

    // Unencoded '#' in numeric or string password must not corrupt host to 'postgres' or lose password
    const hashNumeric = parseConnectionUri(
      'postgresql://postgres:1234#abc@db.toethftlamjmkkodtglq.supabase.co:5432/postgres'
    )
    expect(hashNumeric.ok).toBe(true)
    expect(hashNumeric.password).toBe('1234#abc')
    expect(hashNumeric.profile?.host).toBe('db.toethftlamjmkkodtglq.supabase.co')
    expect(hashNumeric.profile?.port).toBe(5432)

    const hashQuestion = parseConnectionUri(
      'postgresql://postgres:pass?x=1#y@db.toethftlamjmkkodtglq.supabase.co:5432/postgres?sslmode=require'
    )
    expect(hashQuestion.ok).toBe(true)
    expect(hashQuestion.password).toBe('pass?x=1#y')
    expect(hashQuestion.profile?.host).toBe('db.toethftlamjmkkodtglq.supabase.co')
    expect(hashQuestion.profile?.ssl).toBe(true)

    // Password-only Redis URI on IPv6 literal with unencoded '#'
    const redisIpv6Hash = parseConnectionUri('redis://:my#secret@[::1]:6379/0')
    expect(redisIpv6Hash.ok).toBe(true)
    expect(redisIpv6Hash.password).toBe('my#secret')
    expect(redisIpv6Hash.profile?.host).toBe('[::1]')
    expect(redisIpv6Hash.profile?.ssl).toBe(false)
  })

  it('handles Wave 12 Cloud URI edge cases: http LibSQL, jwt param, ssl=off|no, Upstash/ClickHouse Cloud auto-SSL, Docker _ hosts, and PG/CRDB ?options=', () => {
    // 1. http:// LibSQL keeps http and ssl: false
    const localHttpLibsql = parseConnectionUri('http://localhost:8080?authToken=devtoken')
    expect(localHttpLibsql.ok).toBe(true)
    expect(localHttpLibsql.authToken).toBe('devtoken')
    expect(localHttpLibsql.profile).toMatchObject({
      driver: 'libsql',
      url: 'http://localhost:8080',
      ssl: false,
      port: 8080,
    })

    // 2. https:// LibSQL with ?jwt= extracts authToken
    const jwtLibsql = parseConnectionUri('https://my-sqld.example.com?jwt=myjwt123')
    expect(jwtLibsql.ok).toBe(true)
    expect(jwtLibsql.authToken).toBe('myjwt123')
    expect(jwtLibsql.profile).toMatchObject({
      driver: 'libsql',
      url: 'https://my-sqld.example.com',
      ssl: true,
      hasAuthToken: true,
    })

    // 3. ssl=off / ssl=no / tls=off respected as false
    expect(parseConnectionUri('mysql://user:pw@localhost:3306/mydb?ssl=off').profile?.ssl).toBe(false)
    expect(parseConnectionUri('postgres://user:pw@localhost:5432/mydb?ssl=no').profile?.ssl).toBe(false)
    expect(parseConnectionUri('redis://default:tok@us1-cat-123.upstash.io:6379?tls=off').profile?.ssl).toBe(false)

    // 4. Upstash Redis & ClickHouse Cloud auto-enable SSL
    const upstashPlain = parseConnectionUri('redis://default:tok@us1-cat-123.upstash.io:6379')
    expect(upstashPlain.ok).toBe(true)
    expect(upstashPlain.profile?.ssl).toBe(true)

    const chCloudPlain = parseConnectionUri('clickhouse://default:pw@abc.clickhouse.cloud:8443/prod')
    expect(chCloudPlain.ok).toBe(true)
    expect(chCloudPlain.profile?.ssl).toBe(true)
    expect(chCloudPlain.profile?.url).toBe('https://abc.clickhouse.cloud:8443')

    // 5. Docker hostnames with underscores + '#' in password recover cleanly
    const dockerPg = parseConnectionUri('postgres://user:p#ss@postgres_db:5432/app')
    expect(dockerPg.ok).toBe(true)
    expect(dockerPg.password).toBe('p#ss')
    expect(dockerPg.profile).toMatchObject({
      driver: 'postgres',
      host: 'postgres_db',
      port: 5432,
      database: 'app',
    })

    // 6. CockroachDB Cloud & Neon ?options= preserved on profile
    const crdbOptions = parseConnectionUri(
      'postgresql://max:pw@free-tier.cockroachlabs.cloud:26257/defaultdb?sslmode=verify-full&options=--cluster%3Dmy-cluster-123'
    )
    expect(crdbOptions.ok).toBe(true)
    expect(crdbOptions.profile?.options).toBe('--cluster=my-cluster-123')

    const neonOptions = parseConnectionUri(
      'postgres://neondb_owner:pw@ep-cool.us-east-2.aws.neon.tech/neondb?options=endpoint%3Dep-cool'
    )
    expect(neonOptions.ok).toBe(true)
    expect(neonOptions.profile?.options).toBe('endpoint=ep-cool')
  })
})
