import type { DatabaseDriverType } from './protocol.js'

export type SqlParamStyle =
  | 'named-colon'
  | 'named-at'
  | 'positional-dollar'
  | 'positional-question'
  | 'template-double-brace'
  | 'template-dollar-brace'

export interface ScannedSqlToken {
  start: number
  end: number
  key: string
  raw: string
  bareName: string
  style: SqlParamStyle
  contextPreview?: string
}

export interface DetectedSqlParam {
  key: string
  raw: string
  bareName: string
  style: SqlParamStyle
  occurrences: number
  contextPreview?: string
}

export type BindParamValueType = 'auto' | 'text' | 'number' | 'boolean' | 'null' | 'raw'

export interface BindParamInput {
  value: string
  type: BindParamValueType
  keepRaw?: boolean
}

export interface SqlBindFormatOptions {
  standardConformingStrings?: boolean
  noBackslashEscapes?: boolean
}

export type SqlParamDialect =
  | DatabaseDriverType
  | 'postgresql'
  | 'redshift'
  | 'greenplum'
  | 'timescaledb'

export declare function formatSqlBindLiteral(
  value: unknown,
  dialect: SqlParamDialect,
  options?: SqlBindFormatOptions
): string

export declare function scanSqlParameterTokens(
  sql: string,
  dialect: SqlParamDialect,
  options?: SqlBindFormatOptions
): ScannedSqlToken[]

export declare function extractSqlParameters(
  sql: string,
  dialect: SqlParamDialect,
  options?: SqlBindFormatOptions
): DetectedSqlParam[]

export declare function coerceBindParamValue(input: BindParamInput): unknown

export declare function bindSqlParameters(
  sql: string,
  values: Record<string, BindParamInput>,
  dialect: SqlParamDialect,
  options?: SqlBindFormatOptions
): string
