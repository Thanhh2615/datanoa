// src/editor/bind-params-modal.ts
// Dedicated modal for Phase 2: Bind Parameters (openStudioBindParamsModal)
// Live SQL preview, type coercion validation, and Enter-to-run execution

import type { DatabaseDriverType } from '../protocol.js'
import type { StudioModalMountContext } from './studio-modals.js'
import {
  bindSqlParameters,
  coerceBindParamValue,
  type BindParamInput,
  type BindParamValueType,
  type DetectedSqlParam,
} from './sql-params.js'

export interface StudioBindParamsModalContext extends StudioModalMountContext {
  sql: string
  dialect: DatabaseDriverType
  params: DetectedSqlParam[]
  rememberedValues?: Record<string, BindParamInput>
  onConfirm: (
    boundSql: string,
    nextValues: Record<string, BindParamInput>
  ) => void
}

const PARAM_TYPE_OPTIONS: BindParamValueType[] = [
  'auto',
  'text',
  'number',
  'boolean',
  'null',
]

const VALUE_PLACEHOLDER = 'Value (e.g. 42, active)'

function getOwnRememberedValue(
  values: Record<string, BindParamInput> | undefined,
  key: string
): BindParamInput | undefined {
  if (!values || !Object.prototype.hasOwnProperty.call(values, key)) {
    return undefined
  }
  return values[key]
}

export function openStudioBindParamsModal(ctx: StudioBindParamsModalContext): void {
  const currentValues: Record<string, BindParamInput> = {}

  // Initialize values from rememberedValues or defaults
  for (const p of ctx.params) {
    const existing =
      getOwnRememberedValue(ctx.rememberedValues, p.key) ??
      getOwnRememberedValue(ctx.rememberedValues, p.key.slice(1))
    currentValues[p.key] = {
      value: existing?.value ?? '',
      type: existing?.type ?? 'auto',
    }
  }

  const modal = document.createElement('div')
  modal.className = 'datanoa-create-table-modal datanoa-bind-params-modal'
  modal.style.maxWidth = '680px'

  // Modal Head
  const head = document.createElement('div')
  head.className = 'datanoa-modal-head'

  const titleSpan = document.createElement('span')
  titleSpan.textContent = 'Bind SQL Parameters'

  const badgeGroup = document.createElement('div')
  badgeGroup.className = 'datanoa-ddl-actions'

  const dialectBadge = document.createElement('span')
  dialectBadge.className = 'datanoa-badge datanoa-badge-pk'
  dialectBadge.textContent = ctx.dialect.toUpperCase()

  const countBadge = document.createElement('span')
  countBadge.className = 'datanoa-badge'
  countBadge.textContent = `${ctx.params.length} ${ctx.params.length === 1 ? 'param' : 'params'}`

  badgeGroup.appendChild(dialectBadge)
  badgeGroup.appendChild(countBadge)
  head.appendChild(titleSpan)
  head.appendChild(badgeGroup)
  modal.appendChild(head)

  // Modal Body
  const body = document.createElement('div')
  body.className = 'datanoa-modal-body'

  const errBox = document.createElement('div')
  errBox.className = 'datanoa-modal-box error'
  errBox.setAttribute('role', 'alert')
  errBox.style.display = 'none'
  body.appendChild(errBox)

  // Parameters Table Container
  const tableContainer = document.createElement('div')
  tableContainer.style.maxHeight = '240px'
  tableContainer.style.overflowY = 'auto'
  tableContainer.style.marginBottom = '12px'

  const table = document.createElement('table')
  table.className = 'datanoa-matrix-table'
  table.style.width = '100%'

  const thead = document.createElement('thead')
  const thr = document.createElement('tr')
  for (const h of ['Parameter', 'Type', 'Value', 'Count']) {
    const th = document.createElement('th')
    th.textContent = h
    if (h === 'Count') th.style.textAlign = 'center'
    thr.appendChild(th)
  }
  thead.appendChild(thr)
  table.appendChild(thead)

  const tbody = document.createElement('tbody')

  interface BindParamRow {
    param: DetectedSqlParam
    typeSelect: HTMLSelectElement
    nullCheckbox: HTMLInputElement
    valInput: HTMLInputElement
    lastNonNullValue: string
    lastNonNullType: BindParamValueType
  }

  // Map of input elements for live updates and validation
  const inputElements: BindParamRow[] = []

  for (const p of ctx.params) {
    const tr = document.createElement('tr')
    const initial = currentValues[p.key] ?? { value: '', type: 'auto' }
    const initialIsNull = initial.type === 'null'

    // Param Key
    const tdKey = document.createElement('td')
    const keyBadge = document.createElement('code')
    keyBadge.className = 'datanoa-badge'
    keyBadge.style.fontFamily = 'monospace'
    keyBadge.style.fontWeight = 'bold'
    keyBadge.textContent = p.key
    tdKey.appendChild(keyBadge)
    tr.appendChild(tdKey)

    // Type Select + explicit NULL toggle
    const tdType = document.createElement('td')
    const typeSelect = document.createElement('select')
    typeSelect.className = 'datanoa-filter-input'
    typeSelect.style.width = '90px'
    typeSelect.style.padding = '3px 6px'
    typeSelect.setAttribute('aria-label', `Parameter ${p.key} type`)
    for (const optVal of PARAM_TYPE_OPTIONS) {
      const opt = document.createElement('option')
      opt.value = optVal
      opt.textContent = optVal
      if (optVal === initial.type) {
        opt.selected = true
      }
      typeSelect.appendChild(opt)
    }
    tdType.appendChild(typeSelect)

    const nullCheckbox = document.createElement('input')
    nullCheckbox.type = 'checkbox'
    nullCheckbox.className = 'datanoa-param-null-checkbox'
    nullCheckbox.checked = initialIsNull
    nullCheckbox.setAttribute('aria-label', `Parameter ${p.key} is NULL`)
    nullCheckbox.title = 'Bind NULL'
    tdType.appendChild(nullCheckbox)
    tr.appendChild(tdType)

    // Value Input
    const tdVal = document.createElement('td')
    const valInput = document.createElement('input')
    valInput.type = 'text'
    valInput.className = 'datanoa-filter-input'
    valInput.style.width = '100%'
    valInput.setAttribute('aria-label', `Parameter ${p.key} value`)
    valInput.placeholder = initialIsNull ? '(null)' : VALUE_PLACEHOLDER
    valInput.value = initialIsNull ? '' : initial.value
    valInput.disabled = initialIsNull
    tdVal.appendChild(valInput)
    tr.appendChild(tdVal)

    // Occurrences Count
    const tdCount = document.createElement('td')
    tdCount.style.textAlign = 'center'
    const cntBadge = document.createElement('span')
    cntBadge.className = 'datanoa-badge'
    cntBadge.style.opacity = '0.7'
    cntBadge.textContent = `×${p.occurrences}`
    tdCount.appendChild(cntBadge)
    tr.appendChild(tdCount)

    tbody.appendChild(tr)
    inputElements.push({
      param: p,
      typeSelect,
      nullCheckbox,
      valInput,
      lastNonNullValue: initial.value,
      lastNonNullType: initialIsNull ? 'auto' : initial.type,
    })
  }

  table.appendChild(tbody)
  tableContainer.appendChild(table)
  body.appendChild(tableContainer)

  // Live SQL Preview
  const previewLabel = document.createElement('div')
  previewLabel.style.fontSize = '11px'
  previewLabel.style.fontWeight = '600'
  previewLabel.style.opacity = '0.7'
  previewLabel.style.marginBottom = '4px'
  previewLabel.textContent = 'Bound SQL Preview'
  body.appendChild(previewLabel)

  const previewPre = document.createElement('pre')
  previewPre.className = 'datanoa-modal-sql'
  previewPre.style.maxHeight = '150px'
  previewPre.style.overflow = 'auto'
  previewPre.style.margin = '0 0 12px 0'
  previewPre.style.whiteSpace = 'pre-wrap'
  previewPre.style.wordBreak = 'break-word'
  body.appendChild(previewPre)

  modal.appendChild(body)

  // Modal Actions
  const actions = document.createElement('div')
  actions.className = 'datanoa-modal-actions'

  const cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.className = 'datanoa-btn'
  cancelBtn.textContent = 'Cancel'

  const submitBtn = document.createElement('button')
  submitBtn.type = 'button'
  submitBtn.className = 'datanoa-btn datanoa-btn-primary'
  submitBtn.textContent = 'Run Query'

  actions.appendChild(cancelBtn)
  actions.appendChild(submitBtn)
  modal.appendChild(actions)

  const applyNullState = (item: BindParamRow, isNull: boolean): void => {
    if (isNull) {
      if (!item.valInput.disabled) {
        item.lastNonNullValue = item.valInput.value
      }
      item.typeSelect.value = 'null'
      item.nullCheckbox.checked = true
      item.valInput.value = ''
      item.valInput.disabled = true
      item.valInput.placeholder = '(null)'
      return
    }
    item.nullCheckbox.checked = false
    if (item.typeSelect.value === 'null') {
      item.typeSelect.value = item.lastNonNullType
    }
    item.valInput.disabled = false
    item.valInput.value = item.lastNonNullValue
    item.valInput.placeholder = VALUE_PLACEHOLDER
  }

  // Validation & Live Preview Update Logic
  let lastBoundSql = ''
  let isValid = true
  let submitted = false

  const updatePreviewAndValidation = (): void => {
    errBox.style.display = 'none'
    errBox.textContent = ''
    isValid = true

    // Synchronize current values & validate
    for (const item of inputElements) {
      const type = item.typeSelect.value as BindParamValueType
      const value = type === 'null' ? '' : item.valInput.value
      currentValues[item.param.key] = { value, type }

      try {
        coerceBindParamValue({ value, type })
        item.valInput.style.borderColor = ''
      } catch (err) {
        isValid = false
        item.valInput.style.borderColor = 'var(--danger)'
        errBox.textContent =
          err instanceof Error
            ? `${item.param.key}: ${err.message}`
            : `${item.param.key}: Invalid value`
        errBox.style.display = 'block'
      }
    }

    if (isValid) {
      try {
        lastBoundSql = bindSqlParameters(ctx.sql, currentValues, ctx.dialect)
        previewPre.textContent = lastBoundSql
      } catch (err) {
        isValid = false
        lastBoundSql = ''
        previewPre.textContent = '-- Invalid parameter value'
        errBox.textContent =
          err instanceof Error ? err.message : 'Invalid parameter value'
        errBox.style.display = 'block'
      }
    }

    submitBtn.disabled = !isValid
  }

  // Attach change listeners
  for (const item of inputElements) {
    item.typeSelect.addEventListener('change', () => {
      const next = item.typeSelect.value as BindParamValueType
      if (next === 'null') {
        applyNullState(item, true)
      } else {
        item.lastNonNullType = next
        if (item.nullCheckbox.checked) {
          applyNullState(item, false)
        }
      }
      updatePreviewAndValidation()
    })
    item.nullCheckbox.addEventListener('change', () => {
      applyNullState(item, item.nullCheckbox.checked)
      updatePreviewAndValidation()
    })
    item.valInput.addEventListener('input', () => {
      updatePreviewAndValidation()
    })
  }

  const executeSubmit = (): void => {
    if (!isValid || submitted) return
    submitted = true
    ctx.closeModal()
    ctx.onConfirm(lastBoundSql, currentValues)
  }

  modal.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Enter' || submitBtn.disabled) return
    const target = e.target as HTMLElement | null
    const tag = target?.tagName?.toLowerCase()
    if (tag !== 'input' && tag !== 'select') return
    e.preventDefault()
    executeSubmit()
  })

  cancelBtn.addEventListener('click', () => {
    ctx.closeModal()
  })

  submitBtn.addEventListener('click', () => {
    executeSubmit()
  })

  // Initial computation
  updatePreviewAndValidation()

  // Mount modal
  ctx.mountModal(modal)

  // Focus first enabled value input, falling back to the type select / submit
  setTimeout(() => {
    const firstEnabled = inputElements.find((item) => !item.valInput.disabled)
    const focusTarget = firstEnabled?.valInput ?? inputElements[0]?.typeSelect ?? submitBtn
    focusTarget.focus()
  }, 50)
}
