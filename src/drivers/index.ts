import type { DriverType, IDatabaseDriver } from './common/driver'
import { SqliteDriver } from './sqlite/driver'
import { PostgresDriver } from './postgres/driver'
import { MysqlDriver } from './mysql/driver'
import { RedisDriver } from './redis/driver'
import { ClickHouseDriver } from './clickhouse/driver'
import { LibsqlDriver } from './libsql/driver'

export * from './common/driver'
export * from './common/update-builder'
export * from './common/schema'
export { SqliteDriver, SqliteSession } from './sqlite/driver'
export { PostgresDriver, PostgresSession, type PostgresEngineType } from './postgres/driver'
export { MysqlDriver, MysqlSession, type MysqlEngineType } from './mysql/driver'
export { RedisDriver, RedisSession, tokenizeRedisCommandScript } from './redis/driver'
export { ClickHouseDriver, ClickHouseSession } from './clickhouse/driver'
export { LibsqlDriver, LibsqlSession } from './libsql/driver'

const registry = new Map<DriverType, IDatabaseDriver>()

export function getDriver(type: DriverType): IDatabaseDriver {
  let driver = registry.get(type)
  if (!driver) {
    switch (type) {
      case 'sqlite':
        driver = new SqliteDriver()
        break
      case 'postgres':
        driver = new PostgresDriver('postgres')
        break
      case 'cockroachdb':
        driver = new PostgresDriver('cockroachdb')
        break
      case 'mysql':
        driver = new MysqlDriver('mysql')
        break
      case 'mariadb':
        driver = new MysqlDriver('mariadb')
        break
      case 'redis':
        driver = new RedisDriver()
        break
      case 'clickhouse':
        driver = new ClickHouseDriver()
        break
      case 'libsql':
        driver = new LibsqlDriver()
        break
      default: {
        const exhaustive: never = type
        throw new Error(`Unsupported database driver: ${String(exhaustive)}`)
      }
    }
    registry.set(type, driver)
  }
  return driver
}

export function createDriver(type: DriverType): IDatabaseDriver {
  return getDriver(type)
}
