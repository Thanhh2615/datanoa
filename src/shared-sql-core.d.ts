import type { DatabaseDriverType } from './protocol'

export interface SqlStatementSlice {
  text: string
  start: number
  end: number
}

export declare function usesBackslashAndHash(dialect?: DatabaseDriverType): boolean
export declare function supportsNestedBlockComments(dialect?: DatabaseDriverType): boolean
export declare function supportsDollarQuoting(dialect?: DatabaseDriverType): boolean
export declare function matchMysqlExecCommentPrefix(
  sql: string,
  index: number,
  dialect?: DatabaseDriverType
): number
export declare function isPostgresEscapeStringStart(
  sql: string,
  index: number,
  dialect?: DatabaseDriverType
): boolean
export declare function quoteIdentForDialect(ident: string, dialect: DatabaseDriverType): string
export declare function quoteTableReference(tableName: string, dialect: DatabaseDriverType): string
export declare function normalizeJsonValue(value: unknown): unknown
export declare function formatSqlBinaryLiteral(hex: string, dialect: DatabaseDriverType): string
export declare function formatSqlLiteral(value: unknown, dialect: DatabaseDriverType): string
export declare function isIdentStartChar(code: number): boolean
export declare function isIdentContChar(code: number): boolean
export declare function matchDollarQuoteTag(sql: string, index: number): string | null
export declare function scanQuotedSegmentEnd(
  sql: string,
  start: number,
  quoteChar: string,
  allowBackslashEscape: boolean
): { end: number; closed: boolean }
export declare function scanLineCommentEnd(sql: string, start: number): number
export declare function scanBlockCommentEnd(sql: string, start: number, nested?: boolean): number
export declare function splitSqlStatements(
  script: string,
  dialect?: DatabaseDriverType
): SqlStatementSlice[]
export declare function findStatementAtOffset(
  script: string,
  offset: number,
  dialect?: DatabaseDriverType
): string
export declare function stripLeadingSqlComments(
  sql: string,
  dialect?: DatabaseDriverType
): string
export declare function stripCommentsAndLiterals(
  sql: string,
  dialect?: DatabaseDriverType,
  preserveMysqlExecComments?: boolean
): string
export declare function containsDdlStatement(
  sql: string,
  dialect?: DatabaseDriverType
): boolean

export declare const KNOWN_SQL_DEFAULT_KEYWORDS: RegExp
export declare const FORBIDDEN_DEFAULT_TOKENS: RegExp
export declare const FORBIDDEN_SUBQUERY_VERBS: RegExp

export declare function findTopLevelPostgresCastIndex(input: string): number
export declare function hasBalancedParens(input: string, singleOuterGroupOnly?: boolean): boolean
export declare function isNumericOrBooleanTypeName(dataType: string): boolean
export declare function normalizeSqlDefaultExpression(
  rawDefault: string,
  dataType?: string
): string
export declare function validateColumnTypeSpec(rawType: string): string
export declare function formatSql(sql: string, dialect?: DatabaseDriverType): string
