export interface BigIntegerInstance {
  toString(radix?: number, alphabet?: string): string
  valueOf(): number
}

export type BigIntegerValue = number | string | bigint | BigIntegerInstance

export interface BigIntegerStatic {
  (value?: BigIntegerValue, radix?: BigIntegerValue, alphabet?: string, caseSensitive?: boolean): BigIntegerInstance
}

declare const bigInt: BigIntegerStatic
export default bigInt
