import type * as mongodbTypes from 'mongodb'

export {
  MongoClient,
  ObjectId,
  Decimal128,
  Long,
  Binary,
  UUID,
  Int32,
  Double,
  Timestamp,
  MinKey,
  MaxKey,
  BSONRegExp,
  Code,
  BSON,
} from 'mongodb'

export const EJSON: typeof mongodbTypes.BSON.EJSON

export type * from 'mongodb'

declare const _default: typeof mongodbTypes
export default _default
