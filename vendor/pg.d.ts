import type * as pgTypes from 'pg'
import type CursorType from 'pg-cursor'

export const Client: typeof pgTypes.Client
export type Client = pgTypes.Client
export const Pool: typeof pgTypes.Pool
export type Pool = pgTypes.Pool
export const Query: typeof pgTypes.Query
export type Query = pgTypes.Query
export const types: typeof pgTypes.types
export const defaults: typeof pgTypes.defaults
export const Connection: typeof pgTypes.Connection
export type Connection = pgTypes.Connection
export const DatabaseError: typeof pgTypes.DatabaseError
export type DatabaseError = pgTypes.DatabaseError
export const escapeIdentifier: typeof pgTypes.escapeIdentifier
export const escapeLiteral: typeof pgTypes.escapeLiteral
export const Result: typeof pgTypes.Result
export type Result<R extends pgTypes.QueryResultRow = pgTypes.QueryResultRow> = pgTypes.Result<R>
export const Cursor: typeof CursorType

export type {
  PoolConfig,
  PoolClient,
  ClientConfig,
  QueryResult as PgQueryResult,
  QueryResultRow,
  FieldDef,
} from 'pg'

declare const _default: typeof pgTypes & { Cursor: typeof CursorType }
export default _default
