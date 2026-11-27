// src/editor/sql-params.ts
// Thin TypeScript re-export wrapper over pure shared ESM SQL bind parameter engine.

export {
  bindSqlParameters,
  coerceBindParamValue,
  extractSqlParameters,
  formatSqlBindLiteral,
  scanSqlParameterTokens,
  type BindParamInput,
  type BindParamValueType,
  type DetectedSqlParam,
  type ScannedSqlToken,
  type SqlParamStyle,
} from '../shared-sql-params.js'
