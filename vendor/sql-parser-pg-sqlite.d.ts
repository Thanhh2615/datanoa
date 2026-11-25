export interface SqlParserLocationPoint {
  offset: number
  line: number
  column: number
}

export interface SqlParserLocation {
  start: SqlParserLocationPoint
  end: SqlParserLocationPoint
}

export interface SqlParserInstance {
  astify(sql: string): unknown
}

export declare class PostgresParser implements SqlParserInstance {
  astify(sql: string): unknown
}

export declare class SqliteParser implements SqlParserInstance {
  astify(sql: string): unknown
}
