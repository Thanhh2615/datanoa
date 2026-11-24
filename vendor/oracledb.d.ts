import type OracleDB from 'oracledb'

export const getConnection: typeof OracleDB.getConnection
export const createPool: typeof OracleDB.createPool
export const getPool: typeof OracleDB.getPool
export const OUT_FORMAT_OBJECT: typeof OracleDB.OUT_FORMAT_OBJECT
export const OUT_FORMAT_ARRAY: typeof OracleDB.OUT_FORMAT_ARRAY
export const ARRAY: typeof OracleDB.OUT_FORMAT_ARRAY
export const OBJECT: typeof OracleDB.OUT_FORMAT_OBJECT
export const BIND_IN: typeof OracleDB.BIND_IN
export const BIND_OUT: typeof OracleDB.BIND_OUT
export const BIND_INOUT: typeof OracleDB.BIND_INOUT
export const DB_TYPE_BFILE: typeof OracleDB.DB_TYPE_BFILE
export const DB_TYPE_BINARY_DOUBLE: typeof OracleDB.DB_TYPE_BINARY_DOUBLE
export const DB_TYPE_BINARY_FLOAT: typeof OracleDB.DB_TYPE_BINARY_FLOAT
export const DB_TYPE_BINARY_INTEGER: typeof OracleDB.DB_TYPE_BINARY_INTEGER
export const DB_TYPE_BLOB: typeof OracleDB.DB_TYPE_BLOB
export const DB_TYPE_BOOLEAN: typeof OracleDB.DB_TYPE_BOOLEAN
export const DB_TYPE_CHAR: typeof OracleDB.DB_TYPE_CHAR
export const DB_TYPE_CLOB: typeof OracleDB.DB_TYPE_CLOB
export const DB_TYPE_CURSOR: typeof OracleDB.DB_TYPE_CURSOR
export const DB_TYPE_DATE: typeof OracleDB.DB_TYPE_DATE
export const DB_TYPE_INTERVAL_DS: typeof OracleDB.DB_TYPE_INTERVAL_DS
export const DB_TYPE_INTERVAL_YM: typeof OracleDB.DB_TYPE_INTERVAL_YM
export const DB_TYPE_JSON: typeof OracleDB.DB_TYPE_JSON
export const DB_TYPE_LONG: typeof OracleDB.DB_TYPE_LONG
export const DB_TYPE_LONG_NVARCHAR: typeof OracleDB.DB_TYPE_LONG_NVARCHAR
export const DB_TYPE_LONG_RAW: typeof OracleDB.DB_TYPE_LONG_RAW
export const DB_TYPE_NCHAR: typeof OracleDB.DB_TYPE_NCHAR
export const DB_TYPE_NCLOB: typeof OracleDB.DB_TYPE_NCLOB
export const DB_TYPE_NUMBER: typeof OracleDB.DB_TYPE_NUMBER
export const DB_TYPE_NVARCHAR: typeof OracleDB.DB_TYPE_NVARCHAR
export const DB_TYPE_OBJECT: typeof OracleDB.DB_TYPE_OBJECT
export const DB_TYPE_RAW: typeof OracleDB.DB_TYPE_RAW
export const DB_TYPE_ROWID: typeof OracleDB.DB_TYPE_ROWID
export const DB_TYPE_TIMESTAMP: typeof OracleDB.DB_TYPE_TIMESTAMP
export const DB_TYPE_TIMESTAMP_LTZ: typeof OracleDB.DB_TYPE_TIMESTAMP_LTZ
export const DB_TYPE_TIMESTAMP_TZ: typeof OracleDB.DB_TYPE_TIMESTAMP_TZ
export const DB_TYPE_VARCHAR: typeof OracleDB.DB_TYPE_VARCHAR
export const DB_TYPE_XMLTYPE: typeof OracleDB.DB_TYPE_XMLTYPE
export const DB_TYPE_VECTOR: typeof OracleDB.DB_TYPE_VECTOR
export const BLOB: typeof OracleDB.BLOB
export const BUFFER: typeof OracleDB.BUFFER
export const CLOB: typeof OracleDB.CLOB
export const CURSOR: typeof OracleDB.CURSOR
export const DATE: typeof OracleDB.DATE
export const NCLOB: typeof OracleDB.NCLOB
export const NUMBER: typeof OracleDB.NUMBER
export const STRING: typeof OracleDB.STRING
export const DEFAULT: typeof OracleDB.DEFAULT
export const STMT_TYPE_UNKNOWN: typeof OracleDB.STMT_TYPE_UNKNOWN
export const STMT_TYPE_SELECT: typeof OracleDB.STMT_TYPE_SELECT
export const STMT_TYPE_UPDATE: typeof OracleDB.STMT_TYPE_UPDATE
export const STMT_TYPE_DELETE: typeof OracleDB.STMT_TYPE_DELETE
export const STMT_TYPE_INSERT: typeof OracleDB.STMT_TYPE_INSERT
export const STMT_TYPE_CREATE: typeof OracleDB.STMT_TYPE_CREATE
export const STMT_TYPE_DROP: typeof OracleDB.STMT_TYPE_DROP
export const STMT_TYPE_ALTER: typeof OracleDB.STMT_TYPE_ALTER
export const STMT_TYPE_BEGIN: typeof OracleDB.STMT_TYPE_BEGIN
export const STMT_TYPE_DECLARE: typeof OracleDB.STMT_TYPE_DECLARE
export const STMT_TYPE_CALL: typeof OracleDB.STMT_TYPE_CALL
export const STMT_TYPE_EXPLAIN_PLAN: typeof OracleDB.STMT_TYPE_EXPLAIN_PLAN
export const STMT_TYPE_MERGE: typeof OracleDB.STMT_TYPE_MERGE
export const STMT_TYPE_ROLLBACK: typeof OracleDB.STMT_TYPE_ROLLBACK
export const STMT_TYPE_COMMIT: typeof OracleDB.STMT_TYPE_COMMIT

export type Connection = OracleDB.Connection
export type Pool = OracleDB.Pool
export type Lob = OracleDB.Lob
export type ResultSet<T = unknown> = OracleDB.ResultSet<T>
export type Result<T = unknown> = OracleDB.Result<T>
export type Results<T = unknown> = OracleDB.Results<T>
export type ExecuteOptions = OracleDB.ExecuteOptions
export type ExecuteManyOptions = OracleDB.ExecuteManyOptions
export type BindParameter = OracleDB.BindParameter
export type BindDefinition = OracleDB.BindDefinition
export type BindParameters = OracleDB.BindParameters
export type ConnectionAttributes = OracleDB.ConnectionAttributes
export type PoolAttributes = OracleDB.PoolAttributes
export type GetPooledConnectionOptions = OracleDB.GetPooledConnectionOptions
export type CloseConnectionOptions = OracleDB.CloseConnectionOptions
export type Metadata<T = unknown> = OracleDB.Metadata<T>
export type DBError = OracleDB.DBError
export type QueryStreamOptions = OracleDB.QueryStreamOptions
export type DbType = OracleDB.DbType
export type BaseDBObject = OracleDB.BaseDBObject
export type DBObjectClass<T = unknown> = OracleDB.DBObjectClass<T>
export type IntervalYM = OracleDB.IntervalYM
export type IntervalDS = OracleDB.IntervalDS
export type JsonId = OracleDB.JsonId
export type SparseVector = OracleDB.SparseVector
export type Pipeline = OracleDB.Pipeline

declare const _default: typeof OracleDB
export default _default
