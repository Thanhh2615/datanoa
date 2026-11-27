// src/shared-ssh-hostkey-modal.js
// Top-layer SSH host-key verification & trust modal shared across Fullscreen Studio and Docked Side Panel.
// Pure Browser/Studio ESM: zero Node built-ins, zero .ts imports.

const STYLE_ELEMENT_ID = 'datanoa-ssh-trust-modal-styles'
const FOCUSABLE_SELECTOR =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

const activeModals = new Map()
let modalInstanceSeq = 0

function ensureStylesInjected() {
  if (typeof document === 'undefined' || !document.head) return
  if (typeof document.getElementById === 'function' && document.getElementById(STYLE_ELEMENT_ID)) {
    return
  }
  const style = document.createElement('style')
  style.id = STYLE_ELEMENT_ID
  style.textContent = `
.datanoa-ssh-trust-overlay {
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(0, 0, 0, 0.62);
  backdrop-filter: blur(2px);
  font-family: var(--ui-font, var(--sans, var(--orca-font-sans, system-ui, -apple-system, sans-serif)));
  color: var(--text, var(--t1, var(--fg, var(--orca-foreground, #e6e6e6))));
}
.datanoa-ssh-trust-modal {
  width: min(560px, 95vw);
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-strong, var(--border, var(--orca-border, rgba(148, 163, 184, 0.28))));
  border-radius: var(--radius, min(var(--orca-radius, 8px), 10px));
  background: var(--popover, var(--orca-popover, var(--bg, var(--orca-background, #14181f))));
  color: var(--text, var(--t1, var(--fg, var(--orca-foreground, #e6e6e6))));
  box-shadow: var(--menu-shadow, 0 16px 42px rgba(0, 0, 0, 0.56));
  overflow: hidden;
}
.datanoa-ssh-trust-modal[data-reason='mismatch'],
.datanoa-ssh-trust-modal[data-reason='revoked'] {
  border-color: var(--danger, var(--orca-destructive, #f87171));
}
.datanoa-ssh-trust-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 16px;
  background: var(--surface, var(--card, color-mix(in srgb, var(--text, var(--t1, #e6e6e6)) 5%, var(--bg, #000000))));
  border-bottom: 1px solid var(--border, var(--orca-border, rgba(148, 163, 184, 0.2)));
}
.datanoa-ssh-trust-title-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex-wrap: wrap;
}
.datanoa-ssh-trust-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text, var(--t1, var(--fg, #e6e6e6)));
}
.datanoa-ssh-trust-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 7px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  border: 1px solid var(--border, var(--orca-border, rgba(148, 163, 184, 0.25)));
  background: var(--card, color-mix(in srgb, var(--text, var(--t1, #e6e6e6)) 6%, var(--bg, #000000)));
  color: var(--muted, var(--t2, color-mix(in srgb, var(--text, var(--t1, #e6e6e6)) 68%, var(--bg, #000000))));
}
.datanoa-ssh-trust-badge.tone-warn {
  color: var(--warn, #fbbf24);
  border-color: color-mix(in srgb, var(--warn, #fbbf24) 45%, transparent);
  background: color-mix(in srgb, var(--warn, #fbbf24) 12%, transparent);
}
.datanoa-ssh-trust-badge.tone-danger {
  color: var(--danger, var(--orca-destructive, #f87171));
  border-color: color-mix(in srgb, var(--danger, var(--orca-destructive, #f87171)) 45%, transparent);
  background: color-mix(in srgb, var(--danger, var(--orca-destructive, #f87171)) 12%, transparent);
}
.datanoa-ssh-trust-body {
  padding: 14px 16px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  font-size: 12.5px;
  line-height: 1.45;
}
.datanoa-ssh-trust-alert {
  padding: 10px 12px;
  border-radius: var(--radius-control, 6px);
  border: 1px solid color-mix(in srgb, var(--danger, var(--orca-destructive, #f87171)) 48%, transparent);
  background: color-mix(in srgb, var(--danger, var(--orca-destructive, #f87171)) 11%, transparent);
  color: var(--text, var(--t1, var(--fg, #e6e6e6)));
  font-size: 12px;
}
.datanoa-ssh-trust-alert.is-info {
  border-color: color-mix(in srgb, var(--warn, #fbbf24) 42%, transparent);
  background: color-mix(in srgb, var(--warn, #fbbf24) 10%, transparent);
}
.datanoa-ssh-trust-alert-title {
  display: block;
  margin-bottom: 4px;
  font-weight: 600;
  color: var(--danger, var(--orca-destructive, #f87171));
}
.datanoa-ssh-trust-alert.is-info .datanoa-ssh-trust-alert-title {
  color: var(--warn, #fbbf24);
}
.datanoa-ssh-trust-details {
  display: grid;
  grid-template-columns: minmax(120px, auto) 1fr;
  gap: 6px 12px;
  padding: 10px 12px;
  border-radius: var(--radius-control, 6px);
  border: 1px solid var(--border, var(--orca-border, rgba(148, 163, 184, 0.2)));
  background: var(--surface, var(--card, color-mix(in srgb, var(--text, var(--t1, #e6e6e6)) 4%, var(--bg, #000000))));
  font-size: 12px;
}
.datanoa-ssh-trust-label {
  color: var(--muted, var(--t2, color-mix(in srgb, var(--text, var(--t1, #e6e6e6)) 68%, var(--bg, #000000))));
  font-weight: 500;
}
.datanoa-ssh-trust-value {
  color: var(--text, var(--t1, var(--fg, #e6e6e6)));
  overflow-wrap: anywhere;
}
.datanoa-ssh-trust-value.is-mono {
  font-family: var(--mono-font, var(--mono, var(--orca-font-mono, ui-monospace, monospace)));
  font-size: 11.5px;
}
.datanoa-ssh-trust-value.is-old {
  color: var(--muted, var(--t2, #94a3b8));
}
.datanoa-ssh-trust-value.is-new {
  color: var(--warn, #fbbf24);
  font-weight: 600;
}
.datanoa-ssh-trust-confirm-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border-radius: var(--radius-control, 6px);
  border: 1px solid var(--border, var(--orca-border, rgba(148, 163, 184, 0.22)));
  background: var(--card, color-mix(in srgb, var(--text, var(--t1, #e6e6e6)) 5%, var(--bg, #000000)));
  cursor: pointer;
  font-size: 12px;
}
.datanoa-ssh-trust-confirm-row input[type='checkbox'] {
  margin-top: 2px;
  flex-shrink: 0;
}
.datanoa-ssh-trust-error {
  padding: 8px 10px;
  border-radius: var(--radius-control, 6px);
  border: 1px solid var(--danger, var(--orca-destructive, #f87171));
  background: color-mix(in srgb, var(--danger, var(--orca-destructive, #f87171)) 12%, transparent);
  color: var(--danger, var(--orca-destructive, #f87171));
  font-size: 12px;
}
.datanoa-ssh-trust-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
  padding: 12px 16px;
  border-top: 1px solid var(--border, var(--orca-border, rgba(148, 163, 184, 0.2)));
  background: var(--surface, var(--card, color-mix(in srgb, var(--text, var(--t1, #e6e6e6)) 4%, var(--bg, #000000))));
}
.datanoa-ssh-trust-btn {
  height: 28px;
  padding: 0 12px;
  border-radius: var(--radius-control, 6px);
  border: 1px solid var(--btn-border, var(--border-strong, rgba(148, 163, 184, 0.28)));
  background: var(--btn-bg, var(--card, color-mix(in srgb, var(--text, var(--t1, #e6e6e6)) 7%, var(--bg, #000000))));
  color: var(--text, var(--t1, var(--fg, #e6e6e6)));
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}
.datanoa-ssh-trust-btn:hover:not(:disabled) {
  background: var(--btn-hover-bg, var(--hover, color-mix(in srgb, var(--text, var(--t1, #e6e6e6)) 12%, var(--bg, #000000))));
  border-color: var(--btn-hover-border, var(--border-strong, rgba(148, 163, 184, 0.42)));
}
.datanoa-ssh-trust-btn:focus-visible {
  outline: 2px solid var(--accent-ring, var(--orca-ring, var(--primary, #38bdf8)));
  outline-offset: 1px;
}
.datanoa-ssh-trust-btn:disabled {
  opacity: 0.48;
  cursor: not-allowed;
}
.datanoa-ssh-trust-btn.is-primary {
  background: var(--primary, var(--orca-primary, #e6e6e6));
  color: var(--primary-fg, var(--orca-primary-foreground, #000000));
  border-color: transparent;
}
.datanoa-ssh-trust-btn.is-danger {
  background: var(--danger, var(--orca-destructive, #f87171));
  color: var(--danger-fg, var(--orca-destructive-foreground, #1a0606));
  border-color: transparent;
}
`
  document.head.appendChild(style)
}

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined && text !== null) node.textContent = String(text)
  return node
}

function formatHopLabel(challenge) {
  const hasIndex = typeof challenge?.hopIndex === 'number' && Number.isFinite(challenge.hopIndex)
  const hasCount = typeof challenge?.hopCount === 'number' && Number.isFinite(challenge.hopCount)
  if (!hasIndex && !hasCount) return ''
  const idx = hasIndex ? Math.max(0, Math.floor(challenge.hopIndex)) : 0
  const count = hasCount ? Math.max(1, Math.floor(challenge.hopCount)) : idx + 1
  if (count <= 1 && !hasIndex) return ''
  const role = count > 1 ? (idx < count - 1 ? ' (Jump Host)' : ' (Bastion)') : ''
  return `Hop ${idx + 1} of ${count}${role}`
}

function formatKnownHostsLocation(pathStr, line) {
  const cleanPath = typeof pathStr === 'string' ? pathStr.trim() : ''
  const hasLine = typeof line === 'number' && Number.isFinite(line) && line >= 1
  if (!cleanPath && !hasLine) return ''
  if (cleanPath && hasLine) return `${cleanPath} (line ${Math.floor(line)})`
  return cleanPath || `line ${Math.floor(line)}`
}

function isReadOnlySystemKnownHosts(challenge) {
  if (challenge?.knownHostsReadOnly === true) return true
  const rawPath = typeof challenge?.knownHostsPath === 'string' ? challenge.knownHostsPath.trim() : ''
  if (!rawPath) return false
  const normalized = rawPath.replace(/\\/g, '/').toLowerCase()
  if (normalized === '/etc/ssh/ssh_known_hosts' || normalized.endsWith('/etc/ssh/ssh_known_hosts')) {
    return true
  }
  if (
    normalized === 'programdata/ssh/ssh_known_hosts' ||
    normalized.endsWith('/programdata/ssh/ssh_known_hosts') ||
    /^[a-z]:\/programdata\/ssh\/ssh_known_hosts$/.test(normalized)
  ) {
    return true
  }
  return false
}

function addDetailRow(grid, labelText, valueText, extraValueClass = '') {
  if (!valueText) return
  grid.appendChild(el('div', 'datanoa-ssh-trust-label', labelText))
  const valEl = el(
    'div',
    extraValueClass ? `datanoa-ssh-trust-value ${extraValueClass}` : 'datanoa-ssh-trust-value',
    valueText
  )
  grid.appendChild(valEl)
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
 * Programmatically closes an active SSH Host Key modal by its challengeId
 * (used by `ssh.hostKeyResolved` multi-panel auto-close events).
 */
export function closeByChallengeId(challengeId, decision = 'cancel') {
  const id = typeof challengeId === 'string' ? challengeId.trim() : ''
  if (!id) return false

  let closedAny = false
  const entry = activeModals.get(id)
  if (entry) {
    entry.forceClose(decision)
    closedAny = true
  }

  if (typeof document !== 'undefined' && typeof document.querySelectorAll === 'function') {
    const overlays = Array.from(document.querySelectorAll('.datanoa-ssh-trust-overlay'))
    for (const ov of overlays) {
      if (ov?.dataset?.challengeId === id || ov?.getAttribute?.('data-challenge-id') === id) {
        if (typeof ov.remove === 'function') {
          ov.remove()
        } else if (ov.parentNode) {
          ov.parentNode.removeChild(ov)
        }
        closedAny = true
      }
    }
  }

  return closedAny
}

/**
 * Closes all open SSH Host Key modals as `'cancel'`.
 */
export function closeAllSshHostKeyModals() {
  for (const entry of Array.from(activeModals.values())) {
    entry.forceClose('cancel')
  }
}

/**
 * Opens the top-layer SSH Host Key verification modal on `document.body`.
 * Default focus, Enter, and Escape ALWAYS resolve as `'cancel'`.
 */
export function openSharedSshHostKeyModal(options) {
  const challenge = options?.challenge
  const challengeId = typeof challenge?.challengeId === 'string' ? challenge.challengeId.trim() : ''
  const reason =
    challenge?.reason === 'mismatch' || challenge?.reason === 'revoked' ? challenge.reason : 'unknown'
  const resolveDecision =
    typeof options?.resolveDecision === 'function' ? options.resolveDecision : null

  if (!challenge || !challengeId || typeof document === 'undefined' || !document.body) {
    return Promise.resolve('cancel')
  }

  const filterPanelId =
    typeof options?.panelId === 'string' && options.panelId.trim() ? options.panelId.trim() : ''
  const filterConnId =
    typeof options?.connectionId === 'string' && options.connectionId.trim()
      ? options.connectionId.trim()
      : ''
  const challengePanelId =
    typeof challenge?.panelId === 'string' && challenge.panelId.trim()
      ? challenge.panelId.trim()
      : ''
  const challengeConnId =
    typeof challenge?.connectionId === 'string' && challenge.connectionId.trim()
      ? challenge.connectionId.trim()
      : ''
  if (filterPanelId && challengePanelId && filterPanelId !== challengePanelId) {
    return Promise.resolve('cancel')
  }
  if (filterConnId && challengeConnId && filterConnId !== challengeConnId) {
    return Promise.resolve('cancel')
  }

  const existing = activeModals.get(challengeId)
  if (existing && existing.overlay?.isConnected !== false) {
    if (resolveDecision && !existing.hasResolveDecision()) {
      existing.setResolveDecision(resolveDecision)
    }
    if (typeof options?.onClose === 'function') {
      existing.onCloseListeners.push(options.onClose)
    }
    if (typeof options?.onResolveResult === 'function') {
      if (existing.lastResolveResult !== undefined) {
        try {
          options.onResolveResult(existing.lastResolveResult)
        } catch {
          // Ignore resolve listener errors
        }
      } else {
        existing.onResolveListeners.push(options.onResolveResult)
      }
    }
    return existing.promise
  }
  if (existing) {
    existing.forceClose('cancel')
  }

  ensureStylesInjected()

  let currentResolveDecision = resolveDecision
  const onCloseListeners = typeof options?.onClose === 'function' ? [options.onClose] : []
  const onResolveListeners =
    typeof options?.onResolveResult === 'function' ? [options.onResolveResult] : []

  const modalPromise = new Promise((resolve) => {
    const uid = `datanoa-ssh-trust-${++modalInstanceSeq}`
    const prevFocus =
      document.activeElement && typeof document.activeElement.focus === 'function'
        ? document.activeElement
        : null

    let settled = false
    let busy = false

    const overlay = el('div', 'datanoa-ssh-trust-overlay')
    overlay.tabIndex = -1
    if (overlay.dataset) {
      overlay.dataset.challengeId = challengeId
      overlay.dataset.reason = reason
    }
    overlay.setAttribute('data-challenge-id', challengeId)
    overlay.setAttribute('data-reason', reason)

    const modal = el('div', 'datanoa-ssh-trust-modal')
    modal.setAttribute('role', 'dialog')
    modal.setAttribute('aria-modal', 'true')
    modal.setAttribute('data-reason', reason)

    const head = el('div', 'datanoa-ssh-trust-head')
    const titleWrap = el('div', 'datanoa-ssh-trust-title-wrap')
    const titleText =
      reason === 'mismatch'
        ? 'SSH Host Key Mismatch'
        : reason === 'revoked'
          ? 'SSH Host Key Revoked'
          : 'Verify SSH Host Key'
    const titleEl = el('h3', 'datanoa-ssh-trust-title', titleText)
    titleEl.id = `${uid}-title`
    modal.setAttribute('aria-labelledby', titleEl.id)
    titleWrap.appendChild(titleEl)

    const reasonBadgeText =
      reason === 'mismatch' ? 'MITM Warning' : reason === 'revoked' ? 'Revoked' : 'Unknown Host'
    const reasonBadgeTone = reason === 'unknown' ? 'tone-warn' : 'tone-danger'
    titleWrap.appendChild(el('span', `datanoa-ssh-trust-badge ${reasonBadgeTone}`, reasonBadgeText))

    const hopLabel = formatHopLabel(challenge)
    if (hopLabel) {
      titleWrap.appendChild(el('span', 'datanoa-ssh-trust-badge datanoa-ssh-trust-hop-badge', hopLabel))
    }
    head.appendChild(titleWrap)
    modal.appendChild(head)

    const body = el('div', 'datanoa-ssh-trust-body')

    // Reason alert banner
    const alertBox = el('div', reason === 'unknown' ? 'datanoa-ssh-trust-alert is-info' : 'datanoa-ssh-trust-alert')
    alertBox.setAttribute('role', 'alert')
    if (reason === 'mismatch') {
      alertBox.appendChild(
        el(
          'strong',
          'datanoa-ssh-trust-alert-title',
          'WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!'
        )
      )
      alertBox.appendChild(
        document.createTextNode(
          'The SSH host key presented by this server does not match the trusted key in known_hosts. Someone could be intercepting this connection (Man-in-the-Middle attack), or the server host key was rotated.'
        )
      )
    } else if (reason === 'revoked') {
      alertBox.appendChild(
        el('strong', 'datanoa-ssh-trust-alert-title', 'Connection Blocked: Host Key Revoked')
      )
      alertBox.appendChild(
        document.createTextNode(
          'This SSH host key is explicitly marked @revoked in known_hosts and cannot be trusted.'
        )
      )
    } else {
      alertBox.appendChild(
        el('strong', 'datanoa-ssh-trust-alert-title', 'Unrecognized SSH Host Key')
      )
      alertBox.appendChild(
        document.createTextNode(
          `The authenticity of host '${challenge.host}:${challenge.port}' cannot be established automatically. Verify the SHA-256 fingerprint before trusting.`
        )
      )
    }
    body.appendChild(alertBox)

    // Metadata grid
    const grid = el('div', 'datanoa-ssh-trust-details')
    const endpoint = `${challenge.host}:${challenge.port}`
    addDetailRow(grid, 'Host', endpoint, 'is-mono')
    if (hopLabel) {
      addDetailRow(grid, 'SSH Hop', hopLabel)
    }
    addDetailRow(grid, 'Key Type', challenge.keyType, 'is-mono')

    const khLoc = formatKnownHostsLocation(challenge.knownHostsPath, challenge.line)
    if (khLoc) {
      addDetailRow(grid, 'known_hosts', khLoc, 'is-mono')
    }

    if (reason === 'mismatch') {
      const oldLabel = [challenge.existingKeyType, challenge.existingFingerprintSha256]
        .filter(Boolean)
        .join(' · ')
      if (oldLabel) {
        addDetailRow(grid, 'Previous Fingerprint', oldLabel, 'is-mono is-old')
      }
      addDetailRow(grid, 'New Fingerprint', challenge.fingerprintSha256, 'is-mono is-new')
    } else {
      addDetailRow(grid, 'SHA-256 Fingerprint', challenge.fingerprintSha256, 'is-mono')
    }
    body.appendChild(grid)

    let replaceCheckbox = null
    const knownHostsReadOnly = reason === 'mismatch' && isReadOnlySystemKnownHosts(challenge)
    if (reason === 'mismatch') {
      if (knownHostsReadOnly) {
        const readOnlyNote = el('div', 'datanoa-ssh-trust-alert is-read-only')
        readOnlyNote.setAttribute('role', 'note')
        readOnlyNote.appendChild(
          el('strong', 'datanoa-ssh-trust-alert-title', 'Read-only system known_hosts')
        )
        readOnlyNote.appendChild(
          document.createTextNode(
            'The mismatched host key resides in the read-only system known_hosts file and cannot be replaced here. It must be updated by a system administrator.'
          )
        )
        body.appendChild(readOnlyNote)
      } else {
        const confirmRow = el('label', 'datanoa-ssh-trust-confirm-row')
        const cbId = `${uid}-mismatch-confirm`
        confirmRow.htmlFor = cbId
        confirmRow.setAttribute('for', cbId)
        replaceCheckbox = el('input', 'datanoa-ssh-trust-confirm-check')
        replaceCheckbox.type = 'checkbox'
        replaceCheckbox.id = cbId
        replaceCheckbox.checked = false
        replaceCheckbox.setAttribute(
          'aria-label',
          'I have verified the new SSH host key fingerprint and want to replace the existing entry'
        )
        const cbLabel = el(
          'span',
          '',
          'I have verified the new host key fingerprint and understand the MITM risk of replacing the existing known_hosts entry.'
        )
        confirmRow.appendChild(replaceCheckbox)
        confirmRow.appendChild(cbLabel)
        body.appendChild(confirmRow)
      }
    }

    const errorEl = el('div', 'datanoa-ssh-trust-error')
    errorEl.setAttribute('role', 'alert')
    errorEl.hidden = true
    body.appendChild(errorEl)

    modal.appendChild(body)

    const actions = el('div', 'datanoa-ssh-trust-actions')
    const actionButtons = []

    const cancelBtn = el(
      'button',
      'datanoa-ssh-trust-btn is-cancel',
      reason === 'revoked' ? 'Close' : 'Cancel'
    )
    cancelBtn.type = 'button'
    cancelBtn.setAttribute('data-decision', 'cancel')
    actionButtons.push(cancelBtn)

    let trustOnceBtn = null
    let trustSaveBtn = null
    let replaceBtn = null

    if (reason === 'unknown') {
      trustOnceBtn = el('button', 'datanoa-ssh-trust-btn', 'Trust Once')
      trustOnceBtn.type = 'button'
      trustOnceBtn.setAttribute('data-decision', 'trust-once')

      trustSaveBtn = el('button', 'datanoa-ssh-trust-btn is-primary', 'Trust & Save')
      trustSaveBtn.type = 'button'
      trustSaveBtn.setAttribute('data-decision', 'save')

      actions.appendChild(cancelBtn)
      actions.appendChild(trustOnceBtn)
      actions.appendChild(trustSaveBtn)
      actionButtons.push(trustOnceBtn, trustSaveBtn)
    } else if (reason === 'mismatch') {
      replaceBtn = el('button', 'datanoa-ssh-trust-btn is-danger', 'Replace in known_hosts')
      replaceBtn.type = 'button'
      replaceBtn.disabled = true
      replaceBtn.setAttribute('data-decision', 'replace')
      if (knownHostsReadOnly) {
        replaceBtn.setAttribute('aria-disabled', 'true')
        replaceBtn.setAttribute('data-readonly-known-hosts', 'true')
        replaceBtn.title = 'System known_hosts is read-only and must be updated by a system administrator.'
      }

      actions.appendChild(cancelBtn)
      actions.appendChild(replaceBtn)
      actionButtons.push(replaceBtn)
    } else {
      actions.appendChild(cancelBtn)
    }

    modal.appendChild(actions)
    overlay.appendChild(modal)

    const syncButtons = () => {
      for (const btn of actionButtons) {
        if (btn === replaceBtn) {
          btn.disabled = busy || knownHostsReadOnly || !replaceCheckbox?.checked
        } else {
          btn.disabled = busy
        }
      }
      if (replaceCheckbox) {
        replaceCheckbox.disabled = busy
      }
    }

    const cleanupDomAndListeners = () => {
      if (activeModals.get(challengeId)?.overlay === overlay) {
        activeModals.delete(challengeId)
      }
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('keydown', onKeyDown, true)
      }
      if (typeof overlay.remove === 'function') {
        overlay.remove()
      } else if (overlay.parentNode) {
        overlay.parentNode.removeChild(overlay)
      }
      if (prevFocus && prevFocus.isConnected !== false) {
        try {
          prevFocus.focus()
        } catch {
          // Ignore focus restore failures in minimal DOM environments
        }
      }
    }

    const settle = (decision) => {
      if (settled) return
      settled = true
      cleanupDomAndListeners()
      for (const cb of onCloseListeners) {
        try {
          cb(decision)
        } catch {
          // Ignore close listener errors
        }
      }
      resolve(decision)
    }

    const submitDecision = async (decision) => {
      if (settled || busy) return
      if (decision === 'replace' && (knownHostsReadOnly || !replaceCheckbox?.checked)) return
      if (reason === 'revoked' && decision !== 'cancel') return

      if (decision === 'cancel') {
        if (currentResolveDecision) {
          void Promise.resolve(currentResolveDecision({ challengeId, decision: 'cancel' })).catch(() => {})
        }
        settle('cancel')
        return
      }

      if (!currentResolveDecision) {
        settle(decision)
        return
      }

      busy = true
      errorEl.hidden = true
      errorEl.textContent = ''
      syncButtons()
      try {
        const resolveRes = await currentResolveDecision({ challengeId, decision })
        const entry = activeModals.get(challengeId)
        if (entry && entry.overlay === overlay) {
          entry.lastResolveResult = resolveRes
        }
        for (const cb of onResolveListeners) {
          try {
            cb(resolveRes)
          } catch {
            // Ignore resolve listener errors
          }
        }
        settle(decision)
      } catch (err) {
        if (settled) return
        busy = false
        errorEl.textContent = err instanceof Error ? err.message : String(err)
        errorEl.hidden = false
        syncButtons()
      }
    }

    const trapTabFocus = (e) => {
      const focusables = Array.from(modal.querySelectorAll(FOCUSABLE_SELECTOR)).filter((node) =>
        isElementVisible(node, overlay)
      )
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement
      if (e.shiftKey) {
        if (active === first || !modal.contains(active)) {
          e.preventDefault()
          last.focus?.()
        }
      } else if (active === last || !modal.contains(active)) {
        e.preventDefault()
        first.focus?.()
      }
    }

    const onKeyDown = (e) => {
      if (settled || e.isComposing) return
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()
        void submitDecision('cancel')
        return
      }
      if (e.key === 'Enter') {
        // Security invariant: Enter NEVER trusts or replaces an SSH host key.
        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()
        void submitDecision('cancel')
        return
      }
      if (e.key === 'Tab') {
        trapTabFocus(e)
      }
    }

    cancelBtn.addEventListener('click', () => {
      void submitDecision('cancel')
    })
    trustOnceBtn?.addEventListener('click', () => {
      void submitDecision('trust-once')
    })
    trustSaveBtn?.addEventListener('click', () => {
      void submitDecision('save')
    })
    replaceCheckbox?.addEventListener('change', () => {
      syncButtons()
    })
    replaceBtn?.addEventListener('click', () => {
      void submitDecision('replace')
    })
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay && !busy) {
        void submitDecision('cancel')
      }
    })

    activeModals.set(challengeId, {
      overlay,
      promise: null,
      onCloseListeners,
      onResolveListeners,
      lastResolveResult: undefined,
      hasResolveDecision: () => Boolean(currentResolveDecision),
      setResolveDecision: (fn) => {
        currentResolveDecision = fn
      },
      forceClose: (decision) => settle(decision || 'cancel'),
    })

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('keydown', onKeyDown, true)
    }

    document.body.appendChild(overlay)
    // Focus Cancel / Close immediately as the safe default
    cancelBtn.focus?.()
  })

  const record = activeModals.get(challengeId)
  if (record) {
    record.promise = modalPromise
  }
  return modalPromise
}

export const HARD_TLS_FAILURE_KINDS = new Set([
  'Expired',
  'NotYetValid',
  'Revoked',
  'HandshakeRejected',
  'CaFileInvalid',
  'ClientIdentityInvalid',
])

/**
 * Renders the 13-kind TLS failure remedy box with zero downgrade/bypass buttons
 * on hard certificate errors, shared across Studio and Side Panel.
 */
export function renderSharedTlsFailureRemedy(box, failure, options = {}) {
  if (!box || !failure || typeof failure !== 'object') return
  box.textContent = ''
  if (options.displayMode === 'hidden') {
    box.hidden = false
  } else {
    box.style.display = 'flex'
  }
  const isHard = HARD_TLS_FAILURE_KINDS.has(failure.kind)
  box.classList.toggle('is-hard-error', isHard)

  const hintClass = options.hintClass || 'datanoa-conn-hint'
  const actionsClass = options.actionsClass || 'datanoa-tls-remedy-actions'
  const buttonClass = options.buttonClass || 'datanoa-btn datanoa-btn-sm'
  const allowAutoSuggestedMode = Boolean(options.allowAutoSuggestedMode)

  const summaryEl = document.createElement('div')
  summaryEl.textContent = `[TLS · ${failure.kind}] ${failure.summary || ''}`
  box.appendChild(summaryEl)

  if (failure.detail) {
    const detailEl = document.createElement('div')
    detailEl.className = hintClass
    detailEl.textContent = failure.detail
    box.appendChild(detailEl)
  }

  const actionsRow = document.createElement('div')
  actionsRow.className = actionsClass

  const addSafeBtn = (label, actionName, onClick, sslTarget) => {
    // H7 invariant: never offer disabling encryption unless the server explicitly refused TLS.
    if (sslTarget === 'disable' && failure.kind !== 'ServerRefusedTls') {
      return
    }
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = buttonClass
    btn.dataset.tlsRemedyBtn = 'true'
    btn.dataset.tlsRemedyAction = actionName
    if (sslTarget) btn.dataset.tlsSslMode = sslTarget
    btn.textContent = label
    btn.addEventListener('click', onClick)
    actionsRow.appendChild(btn)
  }

  if (isHard) {
    // ZERO downgrade/bypass buttons allowed on hard certificate failures
    if (failure.kind === 'CaFileInvalid') {
      addSafeBtn('Inspect CA Certificate Path', 'ChooseCaCert', () => {
        options.onInspectCaCert?.('CaFileInvalid')
      })
    } else if (failure.kind === 'ClientIdentityInvalid') {
      addSafeBtn('Inspect Client Certificate & Key', 'ChooseClientCert', () => {
        options.onInspectClientCert?.()
      })
    } else {
      const guidance = document.createElement('div')
      guidance.className = hintClass
      guidance.textContent =
        'Certificate error cannot be bypassed. Renew, trust, or fix the server certificate and retry.'
      box.appendChild(guidance)
    }
  } else {
    switch (failure.kind) {
      case 'ServerRequiresTls': {
        const targetMode =
          failure.suggestedSslMode && failure.suggestedSslMode !== 'disable'
            ? failure.suggestedSslMode
            : 'verify-full'
        addSafeBtn(
          `Enable TLS (${targetMode}) & Retest`,
          'ChangeEncryption',
          () => {
            options.onApplySslMode?.(targetMode, true)
          },
          targetMode
        )
        break
      }
      case 'ServerRefusedTls':
        addSafeBtn(
          'Disable TLS & Retest',
          'ChangeEncryption',
          () => {
            options.onApplySslMode?.('disable', true)
          },
          'disable'
        )
        break
      case 'ServerRequiresStrict':
        addSafeBtn(
          'Use Strict TLS Mode & Retest',
          'ChangeEncryption',
          () => {
            options.onApplySslMode?.('strict', true)
          },
          'strict'
        )
        break
      case 'ServerRefusedStrict': {
        const fallbackMode =
          failure.suggestedSslMode &&
          failure.suggestedSslMode !== 'strict' &&
          failure.suggestedSslMode !== 'disable'
            ? failure.suggestedSslMode
            : 'verify-full'
        addSafeBtn(
          `Switch to ${fallbackMode} & Retest`,
          'ChangeEncryption',
          () => {
            options.onApplySslMode?.(fallbackMode, true)
          },
          fallbackMode
        )
        break
      }
      case 'UnknownIssuer': {
        addSafeBtn('Specify CA Certificate Path', 'ChooseCaCert', () => {
          options.onInspectCaCert?.('UnknownIssuer')
        })
        const suggested = failure.suggestedSslMode
        const isSafeSuggested = allowAutoSuggestedMode
          ? Boolean(suggested && suggested !== 'disable' && suggested !== 'require')
          : suggested === 'verify-ca' || suggested === 'verify-full' || suggested === 'strict'
        if (isSafeSuggested) {
          addSafeBtn(
            `Switch to ${suggested} & Retest`,
            'ChangeEncryption',
            () => {
              options.onApplySslMode?.(suggested, true)
            },
            suggested
          )
        }
        break
      }
      case 'NameMismatch':
        if (failure.suggestedServerName) {
          const targetHost = failure.suggestedServerName
          addSafeBtn(`Use Host "${targetHost}" & Retest`, 'SetServerName', () => {
            options.onSetServerName?.(targetHost)
          })
        }
        addSafeBtn('Specify CA Certificate / Verify CA', 'ChooseCaCert', () => {
          options.onVerifyCaOnly?.()
        })
        break
      case 'Other':
        addSafeBtn('Review TLS Settings', 'InspectTls', () => {
          options.onInspectTls?.()
        })
        break
    }
  }

  if (actionsRow.children.length > 0) {
    box.appendChild(actionsRow)
  }
}

const SSH_RETRY_TRUST_TTL_MS = 60_000

function buildSshRetryChainSignature(jumpHosts) {
  if (!Array.isArray(jumpHosts) || jumpHosts.length === 0) return 'direct'
  return JSON.stringify(
    jumpHosts.map((h) => [
      String(h?.hopId ?? ''),
      String(h?.host ?? '').toLowerCase(),
      Number(h?.port ?? 22) || 22,
    ])
  )
}

function buildSshRetryHopTrustKey(scopeKey, challenge) {
  return JSON.stringify([
    scopeKey,
    String(challenge?.host ?? '').toLowerCase(),
    Number(challenge?.port ?? 22) || 22,
    String(challenge?.keyType ?? ''),
    String(challenge?.fingerprintSha256 ?? ''),
  ])
}

/**
 * Executes a connection attempt with bounded `hopCount + 1` interactive SSH host-key
 * verification retries and a short-lived multi-hop retry trust context so `trust-once`
 * on earlier hops is preserved until the chain finishes or cancels.
 */
export async function runWithSshHostKeyRetry(options) {
  const runAttempt = options?.runAttempt
  if (typeof runAttempt !== 'function') {
    return { ok: false, message: 'SSH host key verification did not complete.' }
  }
  const jumpHosts = options?.jumpHosts
  const hopBudget = (Array.isArray(jumpHosts) ? jumpHosts.length : 0) + 1
  const explicitMaxHops =
    typeof options?.maxHops === 'number' && Number.isFinite(options.maxHops)
      ? Math.max(1, Math.floor(options.maxHops))
      : 0
  const maxHops = Math.max(hopBudget, explicitMaxHops)
  const maxAttempts = Math.max(8, maxHops + 2, maxHops * maxHops + 2)
  const rePinLimit = Math.max(8, maxHops)
  const isActive = typeof options?.isActive === 'function' ? options.isActive : () => true
  const baseResolveDecision =
    typeof options?.resolveDecision === 'function' ? options.resolveDecision : undefined
  let currentRetryToken =
    typeof options?.sshRetryToken === 'string' && options.sshRetryToken.trim()
      ? options.sshRetryToken.trim()
      : undefined
  const captureRetryToken = (candidate) => {
    if (typeof candidate === 'string' && candidate.trim()) {
      currentRetryToken = candidate.trim()
    }
  }
  const resolveDecision = baseResolveDecision
    ? async (input) => {
        const resolveRes = await baseResolveDecision(input)
        captureRetryToken(resolveRes?.retryToken)
        return resolveRes
      }
    : undefined
  const connScope =
    typeof options?.connectionId === 'string' && options.connectionId.trim()
      ? options.connectionId.trim()
      : '__default__'
  const scopeKey = JSON.stringify([connScope, buildSshRetryChainSignature(jumpHosts)])
  const trustedOnceByHop = new Map()

  const getTrustedFingerprints = () =>
    Array.from(trustedOnceByHop.values())
      .filter((e) => e.expiresAt > Date.now())
      .map((e) => ({
        host: e.host,
        port: e.port,
        keyType: e.keyType,
        fingerprintSha256: e.fingerprintSha256,
      }))

  const promptWithRetryToken = (challenge) => {
    captureRetryToken(challenge?.retryToken)
    return openSharedSshHostKeyModal({
      challenge,
      panelId: options?.panelId,
      connectionId: options?.connectionId,
      resolveDecision,
      onResolveResult: (resolveRes) => {
        captureRetryToken(resolveRes?.retryToken)
      },
    })
  }

  try {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const attemptContext = {
        scopeKey,
        attempt,
        retryAttempt: attempt,
        ...(currentRetryToken ? { sshRetryToken: currentRetryToken } : {}),
        getTrustedFingerprints,
      }
      const res = await runAttempt(attemptContext)
      if (!isActive()) return res
      if (res?.ok || !res?.sshChallenge) {
        return res
      }
      const ch = res.sshChallenge
      captureRetryToken(ch?.retryToken)
      const hopTrustKey = buildSshRetryHopTrustKey(scopeKey, ch)
      const existingTrust = trustedOnceByHop.get(hopTrustKey)
      if (
        ch.reason === 'unknown' &&
        existingTrust &&
        existingTrust.expiresAt > Date.now() &&
        existingTrust.rePinCount < rePinLimit
      ) {
        existingTrust.rePinCount++
        if (resolveDecision) {
          try {
            const resolved = await resolveDecision({
              challengeId: ch.challengeId,
              decision: 'trust-once',
            })
            if (!isActive() || resolved?.decision === 'cancel') {
              return res
            }
          } catch {
            // Fall through to interactive prompt if silent re-pin fails
            trustedOnceByHop.delete(hopTrustKey)
            const fallbackDecision = await promptWithRetryToken(ch)
            if (fallbackDecision === 'cancel') return res
            if (fallbackDecision === 'trust-once') {
              trustedOnceByHop.set(hopTrustKey, {
                host: ch.host,
                port: ch.port,
                keyType: ch.keyType,
                fingerprintSha256: ch.fingerprintSha256,
                rePinCount: 0,
                expiresAt: Date.now() + SSH_RETRY_TRUST_TTL_MS,
              })
            }
          }
        }
        continue
      }

      const decision = await promptWithRetryToken(ch)
      if (decision === 'cancel') {
        return res
      }
      if (decision === 'trust-once' && ch.reason === 'unknown') {
        trustedOnceByHop.set(hopTrustKey, {
          host: ch.host,
          port: ch.port,
          keyType: ch.keyType,
          fingerprintSha256: ch.fingerprintSha256,
          rePinCount: 0,
          expiresAt: Date.now() + SSH_RETRY_TRUST_TTL_MS,
        })
      }
    }
    return { ok: false, message: 'SSH host key verification did not complete.' }
  } finally {
    trustedOnceByHop.clear()
  }
}
