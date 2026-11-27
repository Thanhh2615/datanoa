// src/editor/bind-params-modal.ts
// Dedicated modal for Bind Parameters (Run & Explain), backed by shared-bind-params-modal.js

import type { DatabaseDriverType } from '../protocol.js'
import type { StudioModalMountContext } from './studio-modals.js'
import type { BindParamInput, DetectedSqlParam } from './sql-params.js'
import {
  openSharedBindParamsModal,
  createRememberedBindParamsStore,
  BIND_PARAM_TYPE_OPTIONS,
  type RememberedBindParamsStore,
} from '../shared-bind-params-modal.js'

export {
  BIND_PARAM_TYPE_OPTIONS,
  createRememberedBindParamsStore,
  type RememberedBindParamsStore,
}

export interface StudioBindParamsModalContext extends StudioModalMountContext {
  sql: string
  dialect: DatabaseDriverType
  params: DetectedSqlParam[]
  action?: 'run' | 'explain'
  rememberedValues?: Record<string, BindParamInput>
  memoryStore?: RememberedBindParamsStore
  scopeKey?: string
  onConfirm: (
    boundSql: string,
    nextValues: Record<string, BindParamInput>
  ) => void
  onCancel?: () => void
}

export function openStudioBindParamsModal(ctx: StudioBindParamsModalContext): void {
  let didSubmit = false
  void openSharedBindParamsModal({
    sql: ctx.sql,
    dialect: ctx.dialect,
    params: ctx.params,
    action: ctx.action,
    rememberedValues: ctx.rememberedValues,
    memoryStore: ctx.memoryStore,
    scopeKey: ctx.scopeKey,
    mountModal: (modalEl, canClose) => {
      const cancelBtn = modalEl.querySelector('.datanoa-modal-actions button')
      if (cancelBtn) {
        cancelBtn.addEventListener('click', () => {
          if (didSubmit) {
            ctx.closeModal()
          }
        })
      }
      return ctx.mountModal(modalEl, canClose)
    },
    closeModal: ctx.closeModal,
    onConfirm: (boundSql, nextValues) => {
      didSubmit = true
      ctx.onConfirm(boundSql, nextValues)
    },
    onCancel: ctx.onCancel,
  })
}
