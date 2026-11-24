import type * as mysqlTypes from 'mysql2'
import type * as mysqlPromiseTypes from 'mysql2/promise'

export * from 'mysql2'
export const mysqlPromise: typeof mysqlPromiseTypes
declare const _default: typeof mysqlTypes
export default _default
