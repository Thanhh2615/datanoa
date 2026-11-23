// src/editor/feedback-modal.ts
// Privacy-Safe In-App Feedback, Bug Report & Feature Request Modal

import type { DatabaseDriverType } from '../protocol.js'
import { DATANOA_APP_VERSION } from '../shared-constants.js'
import { sanitizeDiagnosticErrorText } from '../shared-grid-paste.js'
import { copyTextFallback } from './db-icons.js'
import type { StudioModalMountContext } from './studio-modals.js'

export { sanitizeDiagnosticErrorText }

const GITHUB_NEW_ISSUE_BASE_URL = 'https://github.com/Thanhh2615/datanoa/issues/new'

export interface StudioFeedbackModalContext extends StudioModalMountContext {
  activeDriver: DatabaseDriverType | null
  activeViewMode: 'split' | 'grid' | 'sql' | 'inspector'
  isReadOnly: boolean
  lastQueryErrorText: string
  updateStatus: (stateText: string, metricsText?: string) => void
}

function detectOrcaApiVersion(): string {
  if (typeof window === 'undefined') return 'v1'
  const api = (window as unknown as { orca?: { api?: { major?: number; minor?: number } } }).orca?.api
  if (api && typeof api.major === 'number') {
    return typeof api.minor === 'number' ? `v${api.major}.${api.minor}` : `v${api.major}`
  }
  return 'v1'
}

function detectRuntimePlatform(): string {
  if (typeof navigator !== 'undefined') {
    const navPlatform = (navigator as unknown as { userAgentData?: { platform?: string }; platform?: string })
    const label = navPlatform.userAgentData?.platform || navPlatform.platform || ''
    if (label.trim()) return label.trim()
  }
  if (typeof process !== 'undefined' && typeof process.platform === 'string') {
    return process.platform
  }
  return 'unknown'
}

export function buildStudioDiagnosticSummary(ctx: {
  activeDriver: DatabaseDriverType | null
  activeViewMode: 'split' | 'grid' | 'sql' | 'inspector'
  isReadOnly: boolean
  lastQueryErrorText?: string
}): string {
  const lines: string[] = [
    `Datanoa v${DATANOA_APP_VERSION}`,
    `Orca API: ${detectOrcaApiVersion()}`,
    'Surface: Fullscreen Studio',
    `Active Engine: ${ctx.activeDriver ?? 'none'}`,
    `View Mode: ${ctx.activeViewMode}`,
    `Read-Only: ${Boolean(ctx.isReadOnly)}`,
    `Platform: ${detectRuntimePlatform()}`,
  ]
  const sanitizedErr = sanitizeDiagnosticErrorText(ctx.lastQueryErrorText || '')
  if (sanitizedErr) {
    lines.push(`Last Error: ${sanitizedErr}`)
  }
  return lines.join('\n')
}

export function openStudioFeedbackModal(
  ctx: StudioFeedbackModalContext,
  initialKind: 'bug' | 'feature' = 'bug'
): void {
  if (typeof document === 'undefined') return
  let kind: 'bug' | 'feature' = initialKind

  const modal = document.createElement('div')
  modal.className = 'datanoa-feedback-modal'

  const head = document.createElement('div')
  head.className = 'datanoa-modal-head'
  const titleEl = document.createElement('span')
  titleEl.textContent = 'Report Issue / Request Feature'
  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'datanoa-btn datanoa-btn-sm'
  closeBtn.textContent = 'Close'
  closeBtn.addEventListener('click', () => ctx.closeModal())
  head.appendChild(titleEl)
  head.appendChild(closeBtn)

  const body = document.createElement('div')
  body.className = 'datanoa-modal-body'

  const noticeBox = document.createElement('div')
  noticeBox.className = 'datanoa-modal-box datanoa-feedback-notice is-pinned'
  noticeBox.style.display = 'none'
  noticeBox.setAttribute('role', 'status')
  const showNotice = (status: 'success' | 'neutral', text: string): void => {
    noticeBox.className = `datanoa-modal-box datanoa-feedback-notice is-pinned${status === 'success' ? ' success' : ''}`
    noticeBox.textContent = text
    noticeBox.style.display = 'block'
  }

  // Kind Toggle: Bug Report vs Feature Request / UI Improvement
  const kindRow = document.createElement('div')
  kindRow.className = 'datanoa-feedback-kind-group'
  const bugBtn = document.createElement('button')
  bugBtn.type = 'button'
  bugBtn.dataset.kind = 'bug'
  bugBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-feedback-kind-btn'
  bugBtn.textContent = 'Bug Report'

  const featureBtn = document.createElement('button')
  featureBtn.type = 'button'
  featureBtn.dataset.kind = 'feature'
  featureBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-feedback-kind-btn'
  featureBtn.textContent = 'Feature Request / UI Improvement'

  kindRow.appendChild(bugBtn)
  kindRow.appendChild(featureBtn)
  body.appendChild(kindRow)

  // Summary / Title
  const titleField = document.createElement('div')
  titleField.className = 'datanoa-conn-field is-full'
  const titleLabel = document.createElement('label')
  titleLabel.textContent = 'Summary / Title'
  const titleInput = document.createElement('input')
  titleInput.type = 'text'
  titleInput.className = 'datanoa-feedback-title-input datanoa-filter-input'
  titleInput.placeholder = 'Brief summary of the bug or feature request...'
  titleField.appendChild(titleLabel)
  titleField.appendChild(titleInput)
  body.appendChild(titleField)

  // Details / Steps to Reproduce
  const bodyField = document.createElement('div')
  bodyField.className = 'datanoa-conn-field is-full'
  const bodyLabel = document.createElement('label')
  bodyLabel.textContent = 'Details / Steps to Reproduce'
  const bodyTextarea = document.createElement('textarea')
  bodyTextarea.className = 'datanoa-feedback-body-input datanoa-value-textarea'
  bodyTextarea.rows = 5
  bodyTextarea.placeholder = 'Steps to reproduce, expected behavior, and actual behavior...'
  bodyField.appendChild(bodyLabel)
  bodyField.appendChild(bodyTextarea)
  body.appendChild(bodyField)

  // Privacy-Safe Diagnostic Summary
  const diagField = document.createElement('div')
  diagField.className = 'datanoa-conn-field is-full'
  const diagLabel = document.createElement('label')
  diagLabel.textContent = 'Privacy-Safe Diagnostic Summary (no hosts, credentials, or paths)'
  const diagPre = document.createElement('pre')
  diagPre.className = 'datanoa-feedback-diag datanoa-modal-sql'
  diagPre.setAttribute('contenteditable', 'true')
  diagPre.spellcheck = false
  diagPre.textContent = buildStudioDiagnosticSummary({
    activeDriver: ctx.activeDriver,
    activeViewMode: ctx.activeViewMode,
    isReadOnly: ctx.isReadOnly,
    lastQueryErrorText: ctx.lastQueryErrorText,
  })
  diagField.appendChild(diagLabel)
  diagField.appendChild(diagPre)
  body.appendChild(diagField)

  const syncKindPresentation = (): void => {
    const isBug = kind === 'bug'
    bugBtn.classList.toggle('active', isBug)
    bugBtn.classList.toggle('datanoa-btn-primary', isBug)
    featureBtn.classList.toggle('active', !isBug)
    featureBtn.classList.toggle('datanoa-btn-primary', !isBug)
    bodyLabel.textContent = isBug
      ? 'Details / Steps to Reproduce'
      : 'Feature Description / Use Case'
    bodyTextarea.placeholder = isBug
      ? 'Steps to reproduce, expected behavior, and actual behavior...'
      : 'Describe the feature or UI improvement and how it helps your workflow...'
  }

  bugBtn.addEventListener('click', () => {
    kind = 'bug'
    syncKindPresentation()
  })
  featureBtn.addEventListener('click', () => {
    kind = 'feature'
    syncKindPresentation()
  })
  syncKindPresentation()

  const buildReportPayload = (): { title: string; markdownBody: string; githubUrl: string } => {
    const rawTitle = titleInput.value.trim()
    const prefix = kind === 'bug' ? '[Bug]' : '[Feature]'
    const defaultTitle =
      kind === 'bug' ? 'Fullscreen Studio issue report' : 'Studio feature request'
    const baseTitle = rawTitle || defaultTitle
    const title = baseTitle.startsWith('[') ? baseTitle : `${prefix} ${baseTitle}`
    const details =
      bodyTextarea.value.trim() ||
      (kind === 'bug'
        ? '_Describe the steps to reproduce and what happened._'
        : '_Describe the proposed feature or UI improvement._')
    const diagText = (diagPre.textContent || '').trim()
    const sectionHeader =
      kind === 'bug' ? '### Steps to Reproduce / Details' : '### Feature Request / Details'
    const markdownBody = `${sectionHeader}\n${details}\n\n### Environment Diagnostics\n\`\`\`text\n${diagText}\n\`\`\``
    const templateParam = kind === 'bug' ? 'bug_report.yml' : 'feature_request.yml'
    const labelParam = kind === 'bug' ? 'bug' : 'enhancement'
    const githubUrl = `${GITHUB_NEW_ISSUE_BASE_URL}?template=${templateParam}&labels=${labelParam}&title=${encodeURIComponent(title)}&body=${encodeURIComponent(markdownBody)}`
    return { title, markdownBody, githubUrl }
  }

  const actions = document.createElement('div')
  actions.className = 'datanoa-modal-actions'

  const cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.className = 'datanoa-btn datanoa-btn-sm'
  cancelBtn.textContent = 'Cancel'
  cancelBtn.addEventListener('click', () => ctx.closeModal())

  const copyBtn = document.createElement('button')
  copyBtn.type = 'button'
  copyBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-feedback-copy-btn'
  copyBtn.textContent = 'Copy Report'
  copyBtn.addEventListener('click', () => {
    const { title, markdownBody } = buildReportPayload()
    const fullMarkdown = `## ${title}\n\n${markdownBody}`
    copyTextFallback(fullMarkdown, copyBtn)
    showNotice('success', 'Copied full Markdown report to clipboard.')
    ctx.updateStatus('Copied feedback report to clipboard')
  })

  const githubBtn = document.createElement('button')
  githubBtn.type = 'button'
  githubBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-btn-primary datanoa-feedback-github-btn'
  githubBtn.textContent = 'Open on GitHub Issues ↗'
  githubBtn.addEventListener('click', () => {
    const { title, markdownBody, githubUrl } = buildReportPayload()
    const fullMarkdown = `## ${title}\n\n${markdownBody}`
    copyTextFallback(fullMarkdown)
    const openExternalFn =
      typeof window !== 'undefined'
        ? (
            window as unknown as {
              orca?: { shell?: { openExternal?: (url: string) => unknown } }
            }
          ).orca?.shell?.openExternal
        : undefined
    if (typeof openExternalFn === 'function') {
      try {
        void Promise.resolve(openExternalFn(githubUrl)).catch(() => {})
      } catch {
        // Fallback already copied to clipboard
      }
    }
    showNotice(
      'success',
      'Report copied to clipboard and prepared for GitHub Issues (github.com/Thanhh2615/datanoa/issues).'
    )
    ctx.updateStatus('Opened GitHub Issues & copied report to clipboard')
  })

  actions.appendChild(cancelBtn)
  actions.appendChild(copyBtn)
  actions.appendChild(githubBtn)

  modal.appendChild(head)
  modal.appendChild(noticeBox)
  modal.appendChild(body)
  modal.appendChild(actions)
  ctx.mountModal(modal)
  titleInput.focus?.()
}

export const openFeedbackModal = openStudioFeedbackModal

