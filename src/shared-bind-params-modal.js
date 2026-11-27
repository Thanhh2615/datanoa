// src/shared-bind-params-modal.js
// Shared Bind Parameters modal for both Fullscreen Studio and Docked Side Panel (Run & Explain).
// Pure Browser/Studio ESM: zero Node built-ins, zero .ts imports.

import {
  bindSqlParameters,
  coerceBindParamValue,
  extractSqlParameters,
} from './shared-sql-params.js'
import { bindCtrlWheelHorizontalScroll } from './shared-wheel-scroll.js'

export const BIND_PARAM_TYPE_OPTIONS = Object.freeze([
  'auto',
  'text',
  'number',
  'boolean',
  'null',
  'json',
  'raw',
])

const STYLE_ELEMENT_ID = 'datanoa-bind-params-modal-styles'
const VALUE_PLACEHOLDER = 'Value (e.g. 42, active)'
const FOCUSABLE_SELECTOR =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

function ensureStylesInjected() {
  if (typeof document === 'undefined' || !document.head) return
  if (typeof document.getElementById === 'function' && document.getElementById(STYLE_ELEMENT_ID)) {
    return
  }
  const style = document.createElement('style')
  style.id = STYLE_ELEMENT_ID
  style.textContent = `
.datanoa-bind-params-overlay {
  position: fixed;
  inset: 0;
  z-index: 2147482000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(0, 0, 0, 0.56);
  backdrop-filter: blur(2px);
  font-family: var(--ui-font, var(--sans, var(--orca-font-sans, system-ui, -apple-system, sans-serif)));
  color: var(--text, var(--t1, var(--fg, var(--orca-foreground, #e6e6e6))));
}
.datanoa-bind-params-modal {
  width: min(680px, 94vw);
  max-width: min(680px, 94vw);
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-strong, var(--border, var(--orca-border, rgba(148, 163, 184, 0.28))));
  border-radius: var(--radius, min(var(--orca-radius, 8px), 10px));
  background: var(--popover, var(--orca-popover, var(--bg, var(--orca-background, #14181f))));
  color: var(--text, var(--t1, var(--fg, var(--orca-foreground, #e6e6e6))));
  box-shadow: var(--menu-shadow, 0 12px 32px rgba(0, 0, 0, 0.48));
  overflow: hidden;
}
.datanoa-bind-params-modal .datanoa-modal-head,
.datanoa-bind-params-modal .datanoa-modal-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 14px;
  background: var(--surface, var(--card, color-mix(in srgb, var(--text, var(--t1, #e6e6e6)) 4%, var(--bg, #000000))));
}
.datanoa-bind-params-modal .datanoa-modal-head {
  border-bottom: 1px solid var(--border, var(--orca-border, rgba(148, 163, 184, 0.2)));
  font-weight: 600;
  font-size: 13px;
}
.datanoa-bind-params-modal .datanoa-modal-actions {
  border-top: 1px solid var(--border, var(--orca-border, rgba(148, 163, 184, 0.2)));
  justify-content: flex-end;
}
.datanoa-bind-params-modal .datanoa-modal-body {
  padding: 12px 14px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.datanoa-bind-params-modal .datanoa-bind-param-context {
  display: block;
  margin-top: 3px;
  max-width: 210px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--mono-font, var(--mono, var(--orca-font-mono, ui-monospace, monospace)));
  font-size: 10.5px;
  color: var(--muted, var(--t2, color-mix(in srgb, var(--text, var(--t1, #e6e6e6)) 65%, var(--bg, #000000))));
}
.datanoa-bind-params-modal .datanoa-bind-param-toggles {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-left: 6px;
  font-size: 11px;
  color: var(--muted, var(--t2, #94a3b8));
}
.datanoa-bind-params-modal .datanoa-bind-param-toggle-label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  white-space: nowrap;
}
.datanoa-bind-params-modal .datanoa-bind-param-remember-row {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--muted, var(--t2, #94a3b8));
  margin-right: auto;
  cursor: pointer;
}
.datanoa-bind-params-modal .datanoa-modal-sql {
  border: 1px solid var(--border, var(--orca-border, rgba(148, 163, 184, 0.2)));
  border-radius: var(--radius-control, 6px);
  background: var(--input-bg, var(--surface, var(--bg, #000000)));
  color: var(--text, var(--t1, var(--fg, #e6e6e6)));
  font-family: var(--mono-font, var(--mono, var(--orca-font-mono, ui-monospace, monospace)));
  font-size: 11.5px;
  padding: 8px 10px;
}
.datanoa-bind-params-modal .datanoa-modal-box.error {
  border: 1px solid var(--danger, var(--orca-destructive, #f87171));
  border-radius: var(--radius-control, 6px);
  background: color-mix(in srgb, var(--danger, var(--orca-destructive, #f87171)) 10%, transparent);
  color: var(--danger, var(--orca-destructive, #f87171));
  padding: 6px 9px;
  margin-bottom: 4px;
  font-size: 11.5px;
}
`
  document.head.appendChild(style)
}

/**
 * Pure in-RAM parameter memory store (never persisted to disk or localStorage).
 */
export function createRememberedBindParamsStore() {
  const scopes = new Map()
  return {
    get(scopeKey = 'default') {
      const k = String(scopeKey || 'default')
      return scopes.get(k) || {}
    },
    set(scopeKey = 'default', nextValues = {}) {
      const k = String(scopeKey || 'default')
      const prev = scopes.get(k) || {}
      scopes.set(k, { ...prev, ...nextValues })
    },
    clear(scopeKey) {
      if (scopeKey === undefined) {
        scopes.clear()
      } else {
        scopes.delete(String(scopeKey || 'default'))
      }
    },
  }
}

function getOwnRememberedValue(values, key) {
  if (!values || typeof values !== 'object') return undefined
  if (!Object.prototype.hasOwnProperty.call(values, key)) return undefined
  return values[key]
}

function resolveRememberedEntry(rememberedValues, param) {
  const exact = getOwnRememberedValue(rememberedValues, param.key)
  if (exact) return exact
  if (param.bareName) {
    const byBare = getOwnRememberedValue(rememberedValues, param.bareName)
    if (byBare) return byBare
  }
  if (param.key && param.key.length > 1) {
    const sliced = getOwnRememberedValue(rememberedValues, param.key.slice(1))
    if (sliced) return sliced
  }
  return undefined
}

function normalizeUiType(rawType, keepRaw) {
  if (keepRaw === true || rawType === 'raw') return 'raw'
  if (
    rawType === 'auto' ||
    rawType === 'text' ||
    rawType === 'number' ||
    rawType === 'boolean' ||
    rawType === 'null' ||
    rawType === 'json'
  ) {
    return rawType
  }
  return 'auto'
}

function validateAndNormalizeInputForBind(uiInput) {
  const type = normalizeUiType(uiInput.type, uiInput.keepRaw)
  const value = type === 'null' ? '' : String(uiInput.value ?? '')
  if (uiInput.keepRaw === true || type === 'raw') {
    return { value, type: 'raw', keepRaw: true }
  }
  if (type === 'json') {
    const trimmed = value.trim()
    if (!trimmed) {
      throw new Error('Invalid JSON parameter value: empty string')
    }
    try {
      JSON.parse(trimmed)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'invalid JSON'
      throw new Error(`Invalid JSON parameter value: ${msg}`)
    }
    return { value: trimmed, type: 'text' }
  }
  coerceBindParamValue({ value, type })
  return { value, type }
}

function isElementVisible(node, boundary) {
  if (!node || node.disabled || node.hidden) return false
  let cur = node
  while (cur && cur !== boundary) {
    if (cur.hidden) return false
    if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
      const style = window.getComputedStyle(cur)
      if (style.display === 'none' || style.visibility === 'hidden') return false
    } else if (cur.style?.display === 'none' || cur.style?.visibility === 'hidden') {
      return false
    }
    cur = cur.parentElement
  }
  return true
}

/**
 * Opens the shared Bind SQL Parameters modal for Studio or Side Panel (Run & Explain).
 * Returns a Promise resolving to `{ boundSql, values, rememberInRam }` or `null` when cancelled,
 * and also invokes `options.onConfirm` / `options.onCancel` callbacks when provided.
 */
export function openSharedBindParamsModal(options) {
  const sql = String(options?.sql ?? '')
  const dialect =
    typeof options?.dialect === 'string' && options.dialect.trim()
      ? options.dialect.trim().toLowerCase()
      : 'sqlite'
  const formatOptions =
    options?.formatOptions ||
    (options?.standardConformingStrings !== undefined || options?.noBackslashEscapes !== undefined
      ? {
          ...(options.standardConformingStrings !== undefined
            ? { standardConformingStrings: options.standardConformingStrings }
            : {}),
          ...(options.noBackslashEscapes !== undefined
            ? { noBackslashEscapes: options.noBackslashEscapes }
            : {}),
        }
      : undefined)
  const params = Array.isArray(options?.params)
    ? options.params
    : extractSqlParameters(sql, dialect, formatOptions)
  const action = options?.action === 'explain' ? 'explain' : 'run'
  const rememberedSource = options?.memoryStore
    ? options.memoryStore.get(options.scopeKey || 'default')
    : options?.rememberedValues

  ensureStylesInjected()

  return new Promise((resolve) => {
    const uiValues = {}
    const bindValues = {}

    for (const p of params) {
      const existing = resolveRememberedEntry(rememberedSource, p)
      const keepRaw = Boolean(existing?.keepRaw === true || existing?.type === 'raw')
      const type = normalizeUiType(existing?.type, keepRaw)
      uiValues[p.key] = {
        value: existing?.value ?? '',
        type,
        keepRaw,
      }
      bindValues[p.key] = {
        value: type === 'null' ? '' : String(existing?.value ?? ''),
        type: type === 'json' ? 'text' : type,
        ...(keepRaw ? { keepRaw: true } : {}),
      }
    }

    const modal = document.createElement('div')
    modal.className = 'datanoa-create-table-modal datanoa-bind-params-modal'
    modal.setAttribute('role', 'dialog')
    modal.setAttribute('aria-modal', 'true')
    modal.style.maxWidth = '680px'

    // Head
    const head = document.createElement('div')
    head.className = 'datanoa-modal-head'

    const titleSpan = document.createElement('span')
    titleSpan.textContent =
      options?.title ||
      (action === 'explain' ? 'Bind Parameters for EXPLAIN' : 'Bind SQL Parameters')

    const badgeGroup = document.createElement('div')
    badgeGroup.className = 'datanoa-ddl-actions'

    const dialectBadge = document.createElement('span')
    dialectBadge.className = 'datanoa-badge datanoa-badge-pk'
    dialectBadge.textContent = String(dialect).toUpperCase()

    const countBadge = document.createElement('span')
    countBadge.className = 'datanoa-badge'
    countBadge.textContent = `${params.length} ${params.length === 1 ? 'param' : 'params'}`

    badgeGroup.appendChild(dialectBadge)
    badgeGroup.appendChild(countBadge)
    head.appendChild(titleSpan)
    head.appendChild(badgeGroup)
    modal.appendChild(head)

    // Body
    const body = document.createElement('div')
    body.className = 'datanoa-modal-body'

    const errBox = document.createElement('div')
    errBox.className = 'datanoa-modal-box error'
    errBox.setAttribute('role', 'alert')
    errBox.style.display = 'none'
    body.appendChild(errBox)

    const tableContainer = document.createElement('div')
    tableContainer.style.maxHeight = '240px'
    tableContainer.style.overflowY = 'auto'
    tableContainer.style.overflowX = 'auto'
    tableContainer.style.marginBottom = '8px'
    bindCtrlWheelHorizontalScroll(tableContainer)

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
    const inputElements = []

    for (const p of params) {
      const tr = document.createElement('tr')
      const initial = uiValues[p.key] || { value: '', type: 'auto', keepRaw: false }
      const initialIsNull = initial.type === 'null'
      const initialKeepRaw = Boolean(initial.keepRaw || initial.type === 'raw')

      // Parameter key + optional ? contextPreview
      const tdKey = document.createElement('td')
      const keyBadge = document.createElement('code')
      keyBadge.className = 'datanoa-badge'
      keyBadge.style.fontFamily = 'monospace'
      keyBadge.style.fontWeight = 'bold'
      keyBadge.textContent = p.key
      tdKey.appendChild(keyBadge)
      if (p.contextPreview) {
        const previewHint = document.createElement('span')
        previewHint.className = 'datanoa-bind-param-context'
        previewHint.textContent = p.contextPreview
        previewHint.title = p.contextPreview
        tdKey.appendChild(previewHint)
      }
      tr.appendChild(tdKey)

      // Type selector + NULL & Keep raw toggles
      const tdType = document.createElement('td')
      const typeSelect = document.createElement('select')
      typeSelect.className = 'datanoa-filter-input'
      typeSelect.style.width = '90px'
      typeSelect.style.padding = '3px 6px'
      typeSelect.setAttribute('aria-label', `Parameter ${p.key} type`)
      for (const optVal of BIND_PARAM_TYPE_OPTIONS) {
        const opt = document.createElement('option')
        opt.value = optVal
        opt.textContent = optVal
        if (optVal === initial.type) {
          opt.selected = true
        }
        typeSelect.appendChild(opt)
      }
      tdType.appendChild(typeSelect)

      const togglesWrap = document.createElement('span')
      togglesWrap.className = 'datanoa-bind-param-toggles'

      const nullLabel = document.createElement('label')
      nullLabel.className = 'datanoa-bind-param-toggle-label'
      const nullCheckbox = document.createElement('input')
      nullCheckbox.type = 'checkbox'
      nullCheckbox.className = 'datanoa-param-null-checkbox'
      nullCheckbox.checked = initialIsNull
      nullCheckbox.setAttribute('aria-label', `Parameter ${p.key} is NULL`)
      nullCheckbox.title = 'Bind NULL'
      nullLabel.appendChild(nullCheckbox)
      nullLabel.appendChild(document.createTextNode('NULL'))
      togglesWrap.appendChild(nullLabel)

      const rawLabel = document.createElement('label')
      rawLabel.className = 'datanoa-bind-param-toggle-label'
      const rawCheckbox = document.createElement('input')
      rawCheckbox.type = 'checkbox'
      rawCheckbox.className = 'datanoa-param-raw-checkbox'
      rawCheckbox.checked = initialKeepRaw
      rawCheckbox.setAttribute('aria-label', `Keep ${p.key} raw`)
      rawCheckbox.title = 'Keep placeholder raw (do not substitute)'
      rawLabel.appendChild(rawCheckbox)
      rawLabel.appendChild(document.createTextNode('Keep raw'))
      togglesWrap.appendChild(rawLabel)

      tdType.appendChild(togglesWrap)
      tr.appendChild(tdType)

      // Value input
      const tdVal = document.createElement('td')
      const valInput = document.createElement('input')
      valInput.type = 'text'
      valInput.className = 'datanoa-filter-input'
      valInput.style.width = '100%'
      valInput.setAttribute('aria-label', `Parameter ${p.key} value`)
      valInput.placeholder = initialIsNull
        ? '(null)'
        : initialKeepRaw
          ? `(kept raw: ${p.raw || p.key})`
          : VALUE_PLACEHOLDER
      valInput.value = initialIsNull ? '' : initial.value
      valInput.disabled = initialIsNull || initialKeepRaw
      tdVal.appendChild(valInput)
      tr.appendChild(tdVal)

      // Occurrences count
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
        rawCheckbox,
        valInput,
        lastNonSpecialValue: initial.value,
        lastNonSpecialType:
          initialIsNull || initialKeepRaw ? 'auto' : initial.type,
      })
    }

    table.appendChild(tbody)
    tableContainer.appendChild(table)
    body.appendChild(tableContainer)

    // Live SQL Preview
    const previewLabel = document.createElement('div')
    previewLabel.style.fontSize = '11px'
    previewLabel.style.fontWeight = '600'
    previewLabel.style.opacity = '0.75'
    previewLabel.style.marginBottom = '2px'
    previewLabel.textContent = 'Bound SQL Preview'
    body.appendChild(previewLabel)

    const previewPre = document.createElement('pre')
    previewPre.className = 'datanoa-modal-sql'
    previewPre.style.maxHeight = '150px'
    previewPre.style.overflow = 'auto'
    previewPre.style.margin = '0 0 6px 0'
    previewPre.style.whiteSpace = 'pre-wrap'
    previewPre.style.wordBreak = 'break-word'
    body.appendChild(previewPre)

    modal.appendChild(body)

    // Actions
    const actions = document.createElement('div')
    actions.className = 'datanoa-modal-actions'

    const rememberLabel = document.createElement('label')
    rememberLabel.className = 'datanoa-bind-param-remember-row'
    const rememberCheckbox = document.createElement('input')
    rememberCheckbox.type = 'checkbox'
    rememberCheckbox.className = 'datanoa-param-remember-checkbox'
    rememberCheckbox.checked = options?.rememberInRam !== false
    rememberCheckbox.setAttribute('aria-label', 'Remember parameter values in RAM for this session')
    rememberLabel.appendChild(rememberCheckbox)
    rememberLabel.appendChild(document.createTextNode('Remember in RAM'))
    actions.appendChild(rememberLabel)

    const cancelBtn = document.createElement('button')
    cancelBtn.type = 'button'
    cancelBtn.className = 'datanoa-btn'
    cancelBtn.textContent = 'Cancel'

    const submitBtn = document.createElement('button')
    submitBtn.type = 'button'
    submitBtn.className = 'datanoa-btn datanoa-btn-primary'
    submitBtn.textContent =
      options?.submitLabel || (action === 'explain' ? 'Explain Query' : 'Run Query')

    actions.appendChild(cancelBtn)
    actions.appendChild(submitBtn)
    modal.appendChild(actions)

    const applyNullState = (item, isNull) => {
      if (isNull) {
        if (!item.valInput.disabled) {
          item.lastNonSpecialValue = item.valInput.value
        }
        item.typeSelect.value = 'null'
        item.nullCheckbox.checked = true
        item.rawCheckbox.checked = false
        item.valInput.value = ''
        item.valInput.disabled = true
        item.valInput.placeholder = '(null)'
        return
      }
      item.nullCheckbox.checked = false
      if (item.typeSelect.value === 'null') {
        item.typeSelect.value = item.lastNonSpecialType || 'auto'
      }
      item.valInput.disabled = item.rawCheckbox.checked
      item.valInput.value = item.lastNonSpecialValue
      item.valInput.placeholder = item.rawCheckbox.checked
        ? `(kept raw: ${item.param.raw || item.param.key})`
        : VALUE_PLACEHOLDER
    }

    const applyKeepRawState = (item, keepRaw) => {
      if (keepRaw) {
        if (!item.valInput.disabled) {
          item.lastNonSpecialValue = item.valInput.value
        }
        item.rawCheckbox.checked = true
        item.nullCheckbox.checked = false
        item.typeSelect.value = 'raw'
        item.valInput.disabled = true
        item.valInput.placeholder = `(kept raw: ${item.param.raw || item.param.key})`
        return
      }
      item.rawCheckbox.checked = false
      if (item.typeSelect.value === 'raw') {
        item.typeSelect.value = item.lastNonSpecialType || 'auto'
      }
      item.valInput.disabled = item.nullCheckbox.checked
      item.valInput.placeholder = item.nullCheckbox.checked ? '(null)' : VALUE_PLACEHOLDER
    }

    let lastBoundSql = ''
    let isValid = true
    let settled = false
    let standaloneOverlay = null
    const prevFocus =
      typeof document !== 'undefined' &&
      document.activeElement &&
      typeof document.activeElement.focus === 'function'
        ? document.activeElement
        : null

    const updatePreviewAndValidation = () => {
      errBox.style.display = 'none'
      errBox.textContent = ''
      isValid = true

      for (const item of inputElements) {
        const type = item.typeSelect.value
        const keepRaw = item.rawCheckbox.checked || type === 'raw'
        const value = type === 'null' ? '' : item.valInput.value
        uiValues[item.param.key] = { value, type, keepRaw }

        try {
          bindValues[item.param.key] = validateAndNormalizeInputForBind({ value, type, keepRaw })
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
          lastBoundSql = bindSqlParameters(sql, bindValues, dialect, formatOptions)
          previewPre.textContent = lastBoundSql
        } catch (err) {
          isValid = false
          lastBoundSql = ''
          previewPre.textContent = '-- Invalid parameter value'
          errBox.textContent = err instanceof Error ? err.message : 'Invalid parameter value'
          errBox.style.display = 'block'
        }
      }

      submitBtn.disabled = !isValid
    }

    for (const item of inputElements) {
      item.typeSelect.addEventListener('change', () => {
        const next = item.typeSelect.value
        if (next === 'null') {
          applyNullState(item, true)
        } else if (next === 'raw') {
          applyKeepRawState(item, true)
        } else {
          item.lastNonSpecialType = next
          if (item.nullCheckbox.checked) {
            applyNullState(item, false)
          }
          if (item.rawCheckbox.checked) {
            applyKeepRawState(item, false)
          }
        }
        updatePreviewAndValidation()
      })
      item.nullCheckbox.addEventListener('change', () => {
        applyNullState(item, item.nullCheckbox.checked)
        updatePreviewAndValidation()
      })
      item.rawCheckbox.addEventListener('change', () => {
        applyKeepRawState(item, item.rawCheckbox.checked)
        updatePreviewAndValidation()
      })
      item.valInput.addEventListener('input', () => {
        item.lastNonSpecialValue = item.valInput.value
        updatePreviewAndValidation()
      })
    }

    const cleanupModal = () => {
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('keydown', onStandaloneKeyDown, true)
      }
      if (options?.closeModal) {
        options.closeModal()
      } else if (standaloneOverlay) {
        if (typeof standaloneOverlay.remove === 'function') {
          standaloneOverlay.remove()
        } else if (standaloneOverlay.parentNode) {
          standaloneOverlay.parentNode.removeChild(standaloneOverlay)
        }
        standaloneOverlay = null
        if (prevFocus && prevFocus.isConnected !== false) {
          try {
            prevFocus.focus()
          } catch {
            // Ignore focus restore errors in minimal DOM
          }
        }
      }
    }

    const cancel = () => {
      if (settled) return
      settled = true
      cleanupModal()
      options?.onCancel?.()
      resolve(null)
    }

    const executeSubmit = () => {
      if (!isValid || settled) return
      settled = true
      const rememberInRam = Boolean(rememberCheckbox.checked)
      if (options?.memoryStore) {
        if (rememberInRam) {
          options.memoryStore.set(options.scopeKey || 'default', bindValues)
        } else {
          options.memoryStore.clear(options.scopeKey || 'default')
        }
      }
      cleanupModal()
      options?.onConfirm?.(lastBoundSql, bindValues, { rememberInRam })
      resolve({
        boundSql: lastBoundSql,
        values: bindValues,
        rememberInRam,
      })
    }

    const onStandaloneKeyDown = (e) => {
      if (settled || e.isComposing) return
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()
        cancel()
        return
      }
      if (e.key === 'Tab' && standaloneOverlay) {
        const focusables = Array.from(modal.querySelectorAll(FOCUSABLE_SELECTOR)).filter((node) =>
          isElementVisible(node, standaloneOverlay)
        )
        if (focusables.length === 0) return
        const first = focusables[0]
        const last = focusables[focusables.length - 1]
        const active = document.activeElement
        if (e.shiftKey && (active === first || !modal.contains(active))) {
          e.preventDefault()
          last.focus?.()
        } else if (!e.shiftKey && (active === last || !modal.contains(active))) {
          e.preventDefault()
          first.focus?.()
        }
      }
    }

    modal.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || submitBtn.disabled) return
      const tag = e.target?.tagName?.toLowerCase()
      if (tag !== 'input' && tag !== 'select') return
      e.preventDefault()
      executeSubmit()
    })

    cancelBtn.addEventListener('click', () => {
      cancel()
    })

    submitBtn.addEventListener('click', () => {
      executeSubmit()
    })

    updatePreviewAndValidation()

    if (typeof options?.mountModal === 'function') {
      options.mountModal(modal)
    } else if (typeof document !== 'undefined' && document.body) {
      standaloneOverlay = document.createElement('div')
      standaloneOverlay.className = 'datanoa-bind-params-overlay'
      standaloneOverlay.tabIndex = -1
      standaloneOverlay.addEventListener('click', (e) => {
        if (e.target === standaloneOverlay) cancel()
      })
      standaloneOverlay.appendChild(modal)
      document.body.appendChild(standaloneOverlay)
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('keydown', onStandaloneKeyDown, true)
      }
    }

    setTimeout(() => {
      const firstEnabled = inputElements.find((item) => !item.valInput.disabled)
      const focusTarget = firstEnabled?.valInput ?? inputElements[0]?.typeSelect ?? submitBtn
      focusTarget.focus?.()
    }, 50)
  })
}
