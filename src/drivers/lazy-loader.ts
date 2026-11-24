// src/drivers/lazy-loader.ts
// On-demand dynamic importer for built-in database drivers so the worker cold-boot
// never evaluates unused vendor bundles (pg, mysql2, mongodb, mssql, oracledb).

import type { DatabaseDriverType } from '../protocol'
import type { IDatabaseDriver } from './common/driver'

const cachedDrivers = new Map<DatabaseDriverType, Promise<IDatabaseDriver>>()

async function instantiateBuiltinDriver(type: DatabaseDriverType): Promise<IDatabaseDriver> {
  switch (type) {
    case 'sqlite': {
      const { SqliteDriver } = await import('./sqlite/driver')
      return new SqliteDriver()
    }
    case 'postgres': {
      const { PostgresDriver } = await import('./postgres/driver')
      return new PostgresDriver('postgres')
    }
    case 'cockroachdb': {
      const { PostgresDriver } = await import('./postgres/driver')
      return new PostgresDriver('cockroachdb')
    }
    case 'mysql': {
      const { MysqlDriver } = await import('./mysql/driver')
      return new MysqlDriver('mysql')
    }
    case 'mariadb': {
      const { MysqlDriver } = await import('./mysql/driver')
      return new MysqlDriver('mariadb')
    }
    case 'redis': {
      const { RedisDriver } = await import('./redis/driver')
      return new RedisDriver()
    }
    case 'clickhouse': {
      const { ClickHouseDriver } = await import('./clickhouse/driver')
      return new ClickHouseDriver()
    }
    case 'libsql': {
      const { LibsqlDriver } = await import('./libsql/driver')
      return new LibsqlDriver()
    }
    case 'd1': {
      const { D1Driver } = await import('./d1/driver')
      return new D1Driver()
    }
    case 'mssql': {
      const { MssqlDriver } = await import('./mssql/driver')
      return new MssqlDriver()
    }
    case 'oracle': {
      const { OracleDriver } = await import('./oracle/driver')
      return new OracleDriver()
    }
    case 'mongodb': {
      const { MongoDriver } = await import('./mongodb/driver')
      return new MongoDriver()
    }
    default: {
      const exhaustive: never = type
      throw new Error(`Unsupported database driver: ${String(exhaustive)}`)
    }
  }
}

export function loadBuiltinDriver(type: DatabaseDriverType): Promise<IDatabaseDriver> {
  const existing = cachedDrivers.get(type)
  if (existing) return existing

  const pending = instantiateBuiltinDriver(type).catch((err: unknown) => {
    cachedDrivers.delete(type)
    throw err
  })
  cachedDrivers.set(type, pending)
  return pending
}
