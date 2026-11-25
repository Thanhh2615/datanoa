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
  targetRange?: SqlDiagnosticRange | null,
  dialect?: string
): SqlDiagnostic | null

export interface SqlScriptStatementSlice {
  text: string
  start: number
  end: number
}

export declare function resolveFailedStatementInScript(
  scriptText: string,
  errorMessage: string,
  stmtSlices: readonly SqlScriptStatementSlice[],
  dialect?: string
): number | null

export interface ExecutionErrorFixTarget {
  failedSql: string
  fixTargetRange: {
    from: number
    to: number
    originalSlice: string
    statementIndex?: number
    totalStatements?: number
    preserveOtherStatements?: boolean
  } | null
}

export declare function resolveExecutionErrorFixTarget(
  execRange: { from: number; to: number; sql: string; originalSlice: string } | null | undefined,
  fallbackSql: string,
  errorMessage: string,
  stmtSlices: readonly SqlScriptStatementSlice[],
  dialect?: string,
  failedStatementIndex?: number | null,
  expectedStatementCount?: number | null
): ExecutionErrorFixTarget
