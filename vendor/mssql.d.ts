import type * as mssqlTypes from 'mssql'

export {
  ConnectionPool,
  Transaction,
  Request,
  TYPES,
  ISOLATION_LEVEL,
  PreparedStatement,
  Table,
  NVarChar,
  VarChar,
  Int,
  BigInt,
  Float,
  Bit,
  DateTime,
  DateTime2,
  DateTimeOffset,
  UniqueIdentifier,
  VarBinary,
  Decimal,
} from 'mssql'

export type * from 'mssql'

declare const _default: typeof mssqlTypes
export default _default
