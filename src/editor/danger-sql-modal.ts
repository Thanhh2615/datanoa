// src/editor/danger-sql-modal.ts
// Dedicated modal for Phase 7A: Dangerous SQL Execution Guard (openStudioDangerSqlModal)
// Highlights unbounded mutations, drops, truncations, and enforces production confirmation gate

import type { ConnectionColorTag } from '../protocol.js'
import type { StudioModalMountContext } from './studio-modals.js'
import type { DangerousSqlFinding } from './sql-safety.js'

export interface StudioDangerSqlModalContext extends StudioModalMountContext {
  connectionName: string
  colorTag?: ConnectionColorTag
  findings: DangerousSqlFinding[]
  sql: string
  onConfirm: () => void
}

function getFindingKindBadgeText(kind: DangerousSqlFinding['kind']): string {
  switch (kind) {
    case 'delete_without_where':
      return 'DELETE WITHOUT WHERE'
    case 'update_without_where':
      return 'UPDATE WITHOUT WHERE'
    case 'drop':
      return 'DROP OBJECT'
    case 'truncate':
      return 'TRUNCATE TABLE'
  }
}

export function openStudioDangerSqlModal(ctx: StudioDangerSqlModalContext): void {
  const isProd = ctx.colorTag === 'prod'
  const isStaging = ctx.colorTag === 'staging'

  const modal = document.createElement('div')
  modal.className = 'datanoa-create-table-modal datanoa-danger-modal'
  modal.style.maxWidth = '640px'

  // Modal Head
  const head = document.createElement('div')
  head.className = 'datanoa-modal-head'

  const titleSpan = document.createElement('span')
  titleSpan.textContent = 'Potentially Dangerous SQL'

  const badge = document.createElement('span')
  badge.className = 'datanoa-badge datanoa-badge-danger'
  badge.textContent = `${ctx.findings.length} ${ctx.findings.length === 1 ? 'WARNING' : 'WARNINGS'}`

  head.appendChild(titleSpan)
  head.appendChild(badge)
  modal.appendChild(head)

  // Modal Body
  const body = document.createElement('div')
  body.className = 'datanoa-modal-body'

  // Environment Alert Banners
  if (isProd) {
    const prodBox = document.createElement('div')
    prodBox.className = 'datanoa-modal-box error'
    prodBox.setAttribute('role', 'alert')
    prodBox.style.marginBottom = '12px'
    prodBox.style.fontWeight = 'bold'
    prodBox.textContent = `[PRODUCTION CONNECTION]: "${ctx.connectionName}". Any destructive changes directly affect live production data!`
    body.appendChild(prodBox)
  } else if (isStaging) {
    const stgBox = document.createElement('div')
    stgBox.className = 'datanoa-modal-box warn'
    stgBox.setAttribute('role', 'alert')
    stgBox.style.marginBottom = '12px'
    stgBox.style.fontWeight = 'bold'
    stgBox.textContent = `[STAGING CONNECTION]: "${ctx.connectionName}".`
    body.appendChild(stgBox)
  }

  // Findings List
  const findingsContainer = document.createElement('div')
  findingsContainer.setAttribute('role', 'alert')
  findingsContainer.style.display = 'flex'
  findingsContainer.style.flexDirection = 'column'
  findingsContainer.style.gap = '8px'
  findingsContainer.style.marginBottom = '12px'

  for (const finding of ctx.findings) {
    const itemEl = document.createElement('div')
    itemEl.className = 'datanoa-modal-box error'
    itemEl.style.display = 'flex'
    itemEl.style.alignItems = 'flex-start'
    itemEl.style.gap = '8px'

    const badgeEl = document.createElement('span')
    badgeEl.className = 'datanoa-badge datanoa-badge-danger'
    badgeEl.style.flexShrink = '0'
    badgeEl.textContent = getFindingKindBadgeText(finding.kind)

    const msgEl = document.createElement('span')
    msgEl.style.fontSize = '12px'
    msgEl.textContent = finding.message

    itemEl.appendChild(badgeEl)
    itemEl.appendChild(msgEl)
    findingsContainer.appendChild(itemEl)
  }
  body.appendChild(findingsContainer)

  // SQL Preview
  const previewLabel = document.createElement('div')
  previewLabel.style.fontSize = '11px'
  previewLabel.style.fontWeight = '600'
  previewLabel.style.opacity = '0.7'
  previewLabel.style.marginBottom = '4px'
  previewLabel.textContent = 'SQL Statement Preview'
  body.appendChild(previewLabel)

  const previewPre = document.createElement('pre')
  previewPre.className = 'datanoa-modal-sql'
  previewPre.style.maxHeight = '140px'
  previewPre.style.overflow = 'auto'
  previewPre.style.margin = '0 0 12px 0'
  previewPre.style.whiteSpace = 'pre-wrap'
  previewPre.style.wordBreak = 'break-word'
  previewPre.textContent = ctx.sql.trim()
  body.appendChild(previewPre)

  // Production Confirmation Gate (Strictly on prod connections)
  let prodCheckbox: HTMLInputElement | null = null
  let prodTextInput: HTMLInputElement | null = null

  if (isProd) {
    const gateBox = document.createElement('div')
    gateBox.className = 'datanoa-modal-box error'
    gateBox.style.padding = '10px 12px'
    gateBox.style.marginBottom = '12px'

    const checkLabel = document.createElement('label')
    checkLabel.style.display = 'flex'
    checkLabel.style.alignItems = 'center'
    checkLabel.style.gap = '8px'
    checkLabel.style.fontSize = '12px'
    checkLabel.style.cursor = 'pointer'
    checkLabel.style.marginBottom = '8px'

    prodCheckbox = document.createElement('input')
    prodCheckbox.type = 'checkbox'
    prodCheckbox.className = 'datanoa-danger-confirm-check'

    const checkText = document.createElement('span')
    checkText.textContent = 'I understand this query modifies live production data'

    checkLabel.appendChild(prodCheckbox)
    checkLabel.appendChild(checkText)
    gateBox.appendChild(checkLabel)

    prodTextInput = document.createElement('input')
    prodTextInput.type = 'text'
    prodTextInput.id = 'datanoa-danger-confirm-input'
    prodTextInput.className = 'datanoa-filter-input datanoa-danger-confirm-input'
    prodTextInput.placeholder = 'Type CONFIRM'
    prodTextInput.setAttribute('aria-label', 'Type CONFIRM to enable execution')
    prodTextInput.style.width = '100%'

    const inputHint = document.createElement('label')
    inputHint.htmlFor = prodTextInput.id
    inputHint.style.fontSize = '11px'
    inputHint.style.opacity = '0.8'
    inputHint.style.marginBottom = '4px'
    inputHint.appendChild(document.createElement('span')).textContent = 'Type '
    const confirmWord = document.createElement('strong')
    confirmWord.textContent = 'CONFIRM'
    inputHint.appendChild(confirmWord)
    inputHint.appendChild(document.createElement('span')).textContent = ' to unlock execution:'
    gateBox.appendChild(inputHint)
    gateBox.appendChild(prodTextInput)

    body.appendChild(gateBox)
  }

  modal.appendChild(body)

  // Modal Actions
  const actions = document.createElement('div')
  actions.className = 'datanoa-modal-actions'

  const cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.className = 'datanoa-btn datanoa-danger-cancel-btn'
  cancelBtn.textContent = 'Cancel'

  const executeBtn = document.createElement('button')
  executeBtn.type = 'button'
  executeBtn.className = 'datanoa-btn datanoa-btn-danger-solid datanoa-danger-execute-btn'
  executeBtn.textContent = 'Execute Anyway'
  executeBtn.disabled = isProd // Disabled by default on prod

  actions.appendChild(cancelBtn)
  actions.appendChild(executeBtn)
  modal.appendChild(actions)

  // Prod Gate Listener
  if (isProd && prodCheckbox && prodTextInput) {
    const updateGate = (): void => {
      const isChecked = prodCheckbox?.checked ?? false
      const isTextMatch = (prodTextInput?.value ?? '').trim() === 'CONFIRM'
      executeBtn.disabled = !(isChecked && isTextMatch)
    }

    prodCheckbox.addEventListener('change', updateGate)
    prodTextInput.addEventListener('input', updateGate)
  }

  cancelBtn.addEventListener('click', () => {
    ctx.closeModal()
  })

  executeBtn.addEventListener('click', () => {
    ctx.closeModal()
    ctx.onConfirm()
  })

  // Mount modal
  ctx.mountModal(modal)
  cancelBtn.focus()
}
