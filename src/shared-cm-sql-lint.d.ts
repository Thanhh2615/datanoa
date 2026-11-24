import type { Extension, StateEffect, StateField } from '../vendor/codemirror.js'
import type { SqlDiagnostic, SqlDiagnosticRange } from './shared-sql-diagnostics.js'

export interface DbSqlErrorPayload {
  errorMessage: string
  targetRange?: SqlDiagnosticRange | null
}

export interface SqlDiagnosticsState {
  staticDiags: SqlDiagnostic[]
  dbDiag: SqlDiagnostic | null
}

export interface CmSqlLintOptions {
  getDialect?: () => string | undefined
  debounceMs?: number
}

export const setSqlDiagnosticsEffect: {
  of(value: SqlDiagnostic[]): StateEffect<SqlDiagnostic[]>
}

export const setDbSqlErrorEffect: {
  of(value: DbSqlErrorPayload | null): StateEffect<DbSqlErrorPayload | null>
}

export const clearDbSqlErrorEffect: {
  of(value?: undefined): StateEffect<undefined>
}

export const triggerSqlLintEffect: {
  of(value?: undefined): StateEffect<undefined>
}

export const sqlDiagnosticsField: StateField<SqlDiagnosticsState>

export function createCmSqlLintExtension(options?: CmSqlLintOptions): Extension
