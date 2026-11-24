// src/editor/sql-safety.ts
// Thin TypeScript re-export wrapper of ../shared-sql-safety.js

export {
  analyzeDangerousSql,
  type DangerousSqlFinding,
  type DangerousSqlKind,
} from '../shared-sql-safety.js'
