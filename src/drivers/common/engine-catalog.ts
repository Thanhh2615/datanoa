// src/drivers/common/engine-catalog.ts
// Single source of truth for built-in database engine metadata & capabilities.

import type { DatabaseDriverType } from '../../protocol'

export type EngineTransport = 'local-file' | 'tcp' | 'http'
export type EnginePackaging = 'native' | 'pure-ts-http' | 'pure-ts-tcp' | 'bundled'
export type EngineQuoteStyle = 'double' | 'backtick' | 'none'

export interface EngineCatalogEntry {
  readonly id: DatabaseDriverType
  readonly label: string
  readonly shortLabel: string
  readonly transport: EngineTransport
  readonly packaging: EnginePackaging
  readonly defaultPort?: number
  readonly supportsTransactions: boolean
  readonly supportsTlsConfig: boolean
  readonly supportsSshTunnel: boolean
  readonly isSql: boolean
  readonly quoteStyle: EngineQuoteStyle
}

export const BUILTIN_ENGINE_CATALOG: readonly EngineCatalogEntry[] = [
  {
    id: 'sqlite',
    label: 'SQLite',
    shortLabel: 'SQLite',
    transport: 'local-file',
    packaging: 'native',
    supportsTransactions: true,
    supportsTlsConfig: false,
    supportsSshTunnel: false,
    isSql: true,
    quoteStyle: 'double',
  },
  {
    id: 'postgres',
    label: 'PostgreSQL',
    shortLabel: 'Postgres',
    transport: 'tcp',
    packaging: 'bundled',
    defaultPort: 5432,
    supportsTransactions: true,
    supportsTlsConfig: true,
    supportsSshTunnel: true,
    isSql: true,
    quoteStyle: 'double',
  },
  {
    id: 'mysql',
    label: 'MySQL',
    shortLabel: 'MySQL',
    transport: 'tcp',
    packaging: 'bundled',
    defaultPort: 3306,
    supportsTransactions: true,
    supportsTlsConfig: true,
    supportsSshTunnel: true,
    isSql: true,
    quoteStyle: 'backtick',
  },
  {
    id: 'mariadb',
    label: 'MariaDB',
    shortLabel: 'MariaDB',
    transport: 'tcp',
    packaging: 'bundled',
    defaultPort: 3306,
    supportsTransactions: true,
    supportsTlsConfig: true,
    supportsSshTunnel: true,
    isSql: true,
    quoteStyle: 'backtick',
  },
  {
    id: 'cockroachdb',
    label: 'CockroachDB',
    shortLabel: 'Cockroach',
    transport: 'tcp',
    packaging: 'bundled',
    defaultPort: 26257,
    supportsTransactions: true,
    supportsTlsConfig: true,
    supportsSshTunnel: true,
    isSql: true,
    quoteStyle: 'double',
  },
  {
    id: 'clickhouse',
    label: 'ClickHouse',
    shortLabel: 'ClickHouse',
    transport: 'http',
    packaging: 'pure-ts-http',
    defaultPort: 8123,
    supportsTransactions: false,
    supportsTlsConfig: true,
    supportsSshTunnel: true,
    isSql: true,
    quoteStyle: 'backtick',
  },
  {
    id: 'redis',
    label: 'Redis',
    shortLabel: 'Redis',
    transport: 'tcp',
    packaging: 'pure-ts-tcp',
    defaultPort: 6379,
    supportsTransactions: false,
    supportsTlsConfig: true,
    supportsSshTunnel: true,
    isSql: false,
    quoteStyle: 'none',
  },
  {
    id: 'libsql',
    label: 'Turso / LibSQL',
    shortLabel: 'LibSQL',
    transport: 'http',
    packaging: 'pure-ts-http',
    defaultPort: 443,
    supportsTransactions: false,
    supportsTlsConfig: true,
    supportsSshTunnel: false,
    isSql: true,
    quoteStyle: 'double',
  },
  {
    id: 'd1',
    label: 'Cloudflare D1',
    shortLabel: 'D1',
    transport: 'http',
    packaging: 'pure-ts-http',
    defaultPort: 443,
    supportsTransactions: false,
    supportsTlsConfig: true,
    supportsSshTunnel: false,
    isSql: true,
    quoteStyle: 'double',
  },
] as const

const ENGINE_BY_ID: ReadonlyMap<DatabaseDriverType, EngineCatalogEntry> = new Map(
  BUILTIN_ENGINE_CATALOG.map((entry) => [entry.id, entry])
)

export function getEngineCatalogEntry(id: DatabaseDriverType): EngineCatalogEntry {
  const found = ENGINE_BY_ID.get(id)
  if (!found) {
    throw new Error(`Unsupported database driver: ${String(id)}`)
  }
  return found
}

export function getDefaultPortForDriver(id: DatabaseDriverType): number {
  return getEngineCatalogEntry(id).defaultPort ?? 0
}

export function isTcpNetworkDriver(id: DatabaseDriverType): boolean {
  return getEngineCatalogEntry(id).transport === 'tcp'
}
