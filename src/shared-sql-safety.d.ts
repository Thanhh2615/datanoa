import type { DatabaseDriverType } from './protocol'

export type DangerousSqlKind =
  | 'delete_without_where'
  | 'update_without_where'
  | 'drop'
  | 'truncate'

export interface DangerousSqlFinding {
  kind: DangerousSqlKind
  statementIndex: number
  statementPreview: string
  target?: string
  message: string
}

export interface ScrubSensitiveTextOptions {
  stripOpaqueFragment?: boolean
  stripAllFragments?: boolean
}

export interface SecretValueSpan {
  skip: boolean
  end: number
}

export declare function isSensitiveUriParamKey(rawKey: string): boolean
export declare function findCredentialAuthorityAtIndex(
  schemePrefix: string,
  body: string,
  colonIdx: number
): number
export declare function maskConnectionUriSecret(rawUri: string): string
export declare function scanSecretValueSpan(
  input: string,
  startIdx: number,
  mode?: 'query' | 'ado' | 'mongo'
): SecretValueSpan
export declare function scrubSensitiveText(
  input: string,
  options?: ScrubSensitiveTextOptions
): string
export declare function tokenizeRedisCommandLine(
  line: string,
  options?: { strict?: boolean }
): string[]
export declare function detectRedisCredentialCommand(script: string): boolean
export declare function containsSensitiveSqlText(raw: string): boolean
export declare function scrubSqlPreviewForStorage(raw: string): string
export declare function sanitizeSqlResultForStorage<T>(result: T): T
export declare function scrubConnectionNameForStorage(raw: unknown): string
export declare function analyzeDangerousSql(
  sql: string,
  dialect: DatabaseDriverType
): DangerousSqlFinding[]
export declare const CLOUD_DB_HOST_SUFFIXES: readonly string[]
export declare function isCloudDatabaseHost(hostname: string): boolean
