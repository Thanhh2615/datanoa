export type SqlDiagnosticSeverity = 'error' | 'warning'

export interface SqlDiagnostic {
  from: number
  to: number
  severity: SqlDiagnosticSeverity
  code: string
  message: string
  suggestion?: string
}

export interface AnalyzeSqlDiagnosticsOptions {
  dialect?: string
  cursorOffset?: number | null
}

export interface SqlDiagnosticRange {
  from: number
  to: number
}

export declare function analyzeSqlDiagnostics(
  docText: string,
  options?: AnalyzeSqlDiagnosticsOptions
): SqlDiagnostic[]

export declare function extractDbSyntaxErrorDiagnostic(
  docText: string,
  errorMessage: string,
  targetRange?: SqlDiagnosticRange | null
): SqlDiagnostic | null
