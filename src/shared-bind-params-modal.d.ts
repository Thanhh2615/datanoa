import type { DatabaseDriverType } from './protocol.js'
import type { BindParamInput, BindParamValueType, DetectedSqlParam } from './shared-sql-params.js'

export type SharedBindParamType = BindParamValueType | 'json'

export interface RememberedBindParamsStore {
  get: (scopeKey?: string) => Record<string, BindParamInput>
  set: (scopeKey?: string, nextValues?: Record<string, BindParamInput>) => void
  clear: (scopeKey?: string) => void
}

export interface SharedBindParamsConfirmMeta {
  rememberInRam: boolean
}

export interface SharedBindParamsModalOptions {
  sql: string
  dialect: DatabaseDriverType
  params?: DetectedSqlParam[]
  action?: 'run' | 'explain'
  title?: string
  submitLabel?: string
  rememberedValues?: Record<string, BindParamInput>
  rememberInRam?: boolean
  memoryStore?: RememberedBindParamsStore
  scopeKey?: string
  mountModal?: (modalEl: HTMLElement, canClose?: () => boolean) => HTMLElement | null | void
  closeModal?: () => void
  onConfirm?: (
    boundSql: string,
    nextValues: Record<string, BindParamInput>,
    meta?: SharedBindParamsConfirmMeta
  ) => void
  onCancel?: () => void
}

export interface SharedBindParamsResult {
  boundSql: string
  values: Record<string, BindParamInput>
  rememberInRam: boolean
}

export declare const BIND_PARAM_TYPE_OPTIONS: readonly SharedBindParamType[]

export declare function createRememberedBindParamsStore(): RememberedBindParamsStore

export declare function openSharedBindParamsModal(
  options: SharedBindParamsModalOptions
): Promise<SharedBindParamsResult | null>
