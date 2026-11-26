// src/editor/transaction-toolbar.ts
// Cohesive Transaction Toolbar & Manual Transaction lifecycle controller for Datanoa Studio.

import type { ConnectionProfile, TransactionState } from '../protocol.js'
import { createSvgElement } from './db-icons.js'

export interface TransactionToolbarHost {
  getActiveConnectionId: () => string | null
  getActiveConnection: () => ConnectionProfile | undefined
  isReadOnly: () => boolean
  isQueryRunning: () => boolean
  isShowingSqlResult: () => boolean
  getActiveTable: () => string | null
  getCurrentPage: () => number
  requestPlugin: <T = unknown>(
    method: string,
    payload?: Record<string, unknown>,
    options?: { timeoutMs?: number }
  ) => Promise<T>
  reloadTableData: (connId: string, table: string, page: number) => void
  showErrorBanner: (title: string, detail: string) => void
  updateStatus: (stateText: string) => void
}

interface InFlightTxAcquire {
  connId: string
  token: number
  done: Promise<void>
  rollbackOnSettle: boolean
}

const DEFAULT_TX_STATE: TransactionState = {
  active: false,
  autoCommit: true,
  statementCount: 0,
  supported: false,
}

export class TransactionToolbarController {
  private readonly host: TransactionToolbarHost
  private groupEl: HTMLDivElement | null = null
  private txToggleBtn: HTMLButtonElement | null = null
  private txToggleDotEl: HTMLSpanElement | null = null
  private txToggleLabelEl: HTMLSpanElement | null = null
  private txToggleChevEl: HTMLSpanElement | null = null
  private txTrayEl: HTMLDivElement | null = null
  private autoCommitBtn: HTMLButtonElement | null = null
  private beginBtn: HTMLButtonElement | null = null
  private commitBtn: HTMLButtonElement | null = null
  private rollbackBtn: HTMLButtonElement | null = null
  private badgeEl: HTMLSpanElement | null = null
  private state: TransactionState = { ...DEFAULT_TX_STATE }
  private isExpanded = false
  private busy = false
  private busyAction: 'commit' | 'rollback' | 'begin' | 'toggle' | null = null
  private contextGeneration = 0
  private mutationEpoch = 0
  private nextMutationToken = 0
  private activeMutationToken: number | null = null
  private refreshSeq = 0
  private destroyed = false
  private inFlightBegin: InFlightTxAcquire | null = null
  private inFlightSetAutoCommit: InFlightTxAcquire | null = null
  private readonly pendingConnectionCleanups = new Map<string, Promise<void>>()
  private readonly knownTxTokens = new Map<string, number>()
  private boundCleanups: Array<() => void> = []

  constructor(host: TransactionToolbarHost) {
    this.host = host
  }

  private addClickListener(btn: HTMLButtonElement, handler: () => void): void {
    btn.addEventListener('click', handler)
    this.boundCleanups.push(() => btn.removeEventListener('click', handler))
  }

  private syncDrawerState(): void {
    if (!this.groupEl || !this.txToggleBtn || !this.txTrayEl) return
    this.groupEl.classList.toggle('is-expanded', this.isExpanded)
    this.txToggleBtn.setAttribute('aria-expanded', String(this.isExpanded))
    this.txTrayEl.setAttribute('aria-hidden', String(!this.isExpanded))
    const tabIdx = this.isExpanded ? 0 : -1
    for (const btn of [this.autoCommitBtn, this.beginBtn, this.commitBtn, this.rollbackBtn]) {
      if (btn) btn.tabIndex = tabIdx
    }
  }

  public toggleDrawer(): void {
    this.isExpanded = !this.isExpanded
    this.syncDrawerState()
  }

  public mount(parent: HTMLElement): void {
    const sep = document.createElement('span')
    sep.className = 'datanoa-toolbar-sep'
    sep.setAttribute('aria-hidden', 'true')

    const group = document.createElement('div')
    group.className = 'datanoa-tx-group'
    this.groupEl = group

    this.txToggleBtn = document.createElement('button')
    this.txToggleBtn.type = 'button'
    this.txToggleBtn.className = 'datanoa-btn datanoa-tx-toggle-btn'
    this.txToggleBtn.setAttribute('aria-expanded', 'false')
    this.txToggleBtn.title = 'Toggle transaction controls (Auto-Commit, BEGIN, COMMIT, ROLLBACK)'

    this.txToggleDotEl = document.createElement('span')
    this.txToggleDotEl.className = 'datanoa-tx-dot'
    this.txToggleDotEl.setAttribute('aria-hidden', 'true')

    this.txToggleLabelEl = document.createElement('span')
    this.txToggleLabelEl.className = 'datanoa-tx-toggle-label'
    this.txToggleLabelEl.textContent = 'TX'

    this.txToggleChevEl = document.createElement('span')
    this.txToggleChevEl.className = 'datanoa-tx-toggle-chev'
    this.txToggleChevEl.setAttribute('aria-hidden', 'true')
    const chevSvg = createSvgElement('svg', {
      width: '12',
      height: '12',
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '2.2',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    })
    chevSvg.appendChild(createSvgElement('polyline', { points: '9 18 15 12 9 6' }))
    this.txToggleChevEl.appendChild(chevSvg)

    this.txToggleBtn.appendChild(this.txToggleDotEl)
    this.txToggleBtn.appendChild(this.txToggleLabelEl)
    this.txToggleBtn.appendChild(this.txToggleChevEl)
    this.addClickListener(this.txToggleBtn, () => {
      this.toggleDrawer()
    })

    this.txTrayEl = document.createElement('div')
    this.txTrayEl.className = 'datanoa-tx-tray'
    this.txTrayEl.setAttribute('aria-hidden', 'true')

    const trayInner = document.createElement('div')
    trayInner.className = 'datanoa-tx-tray-inner'

    this.autoCommitBtn = document.createElement('button')
    this.autoCommitBtn.type = 'button'
    this.autoCommitBtn.className = 'datanoa-btn datanoa-tx-autocommit-btn'
    this.autoCommitBtn.textContent = 'Auto-Commit'
    this.addClickListener(this.autoCommitBtn, () => {
      void this.toggleAutoCommit()
    })

    this.beginBtn = document.createElement('button')
    this.beginBtn.type = 'button'
    this.beginBtn.className = 'datanoa-btn datanoa-tx-begin-btn'
    this.beginBtn.textContent = 'BEGIN'
    this.addClickListener(this.beginBtn, () => {
      void this.begin()
    })

    this.commitBtn = document.createElement('button')
    this.commitBtn.type = 'button'
    this.commitBtn.className = 'datanoa-btn datanoa-tx-commit-btn'
    this.commitBtn.textContent = 'COMMIT'
    this.addClickListener(this.commitBtn, () => {
      void this.commit()
    })

    this.rollbackBtn = document.createElement('button')
    this.rollbackBtn.type = 'button'
    this.rollbackBtn.className = 'datanoa-btn datanoa-tx-rollback-btn'
    this.rollbackBtn.textContent = 'ROLLBACK'
    this.addClickListener(this.rollbackBtn, () => {
      void this.rollback()
    })

    this.badgeEl = document.createElement('span')
    this.badgeEl.className = 'datanoa-tx-badge'
    this.badgeEl.textContent = 'TX open'
    this.badgeEl.style.display = 'none'
    this.badgeEl.setAttribute('role', 'status')
    this.badgeEl.setAttribute('aria-live', 'polite')

    trayInner.appendChild(this.autoCommitBtn)
    trayInner.appendChild(this.beginBtn)
    trayInner.appendChild(this.commitBtn)
    trayInner.appendChild(this.rollbackBtn)
    trayInner.appendChild(this.badgeEl)
    this.txTrayEl.appendChild(trayInner)

    group.appendChild(this.txToggleBtn)
    group.appendChild(this.txTrayEl)

    parent.appendChild(sep)
    parent.appendChild(group)
    this.syncDrawerState()
  }

  public getState(): TransactionState {
    return this.state
  }

  public isBusy(): boolean {
    return this.busy
  }

  public hasActiveOrManualTx(): boolean {
    return this.state.active || !this.state.autoCommit
  }

  private isCurrentContext(gen: number, connId: string): boolean {
    return (
      !this.destroyed &&
      gen === this.contextGeneration &&
      this.host.getActiveConnectionId() === connId
    )
  }

  private isCurrentMutation(token: number, gen: number, connId: string): boolean {
    return this.activeMutationToken === token && this.isCurrentContext(gen, connId)
  }

  private releaseMutation(token: number): void {
    if (this.activeMutationToken !== token) return
    this.activeMutationToken = null
    this.busy = false
    this.busyAction = null
    this.mutationEpoch++
    this.updateToolbar()
  }

  private trackConnectionCleanup(connId: string, cleanupTask: Promise<unknown>): void {
    const prev = this.pendingConnectionCleanups.get(connId) ?? Promise.resolve()
    const next: Promise<void> = prev
      .then(() => cleanupTask)
      .then(
        () => undefined,
        () => undefined
      )
    const tracked = next.finally(() => {
      if (this.pendingConnectionCleanups.get(connId) === tracked) {
        this.pendingConnectionCleanups.delete(connId)
        if (
          !this.destroyed &&
          this.host.getActiveConnectionId() === connId &&
          this.activeMutationToken === null
        ) {
          void this.refreshState(connId)
        }
      }
    })
    this.pendingConnectionCleanups.set(connId, tracked)
  }

  private async waitForConnectionCleanup(connId: string): Promise<void> {
    while (true) {
      const pending = this.pendingConnectionCleanups.get(connId)
      if (!pending) return
      await pending
    }
  }

  private rememberTxToken(connId: string, state: TransactionState): void {
    if (typeof state.txToken === 'number') {
      this.knownTxTokens.set(connId, state.txToken)
    } else if (!state.active && state.autoCommit) {
      this.knownTxTokens.delete(connId)
    }
  }

  public resetForConnectionSwitch(prevConnId: string | null): void {
    if (prevConnId) {
      const txToken = this.state.txToken ?? this.knownTxTokens.get(prevConnId)
      if (this.inFlightBegin && this.inFlightBegin.connId === prevConnId) {
        this.inFlightBegin.rollbackOnSettle = true
        this.trackConnectionCleanup(prevConnId, this.inFlightBegin.done)
      }
      if (this.inFlightSetAutoCommit && this.inFlightSetAutoCommit.connId === prevConnId) {
        this.inFlightSetAutoCommit.rollbackOnSettle = true
        this.trackConnectionCleanup(prevConnId, this.inFlightSetAutoCommit.done)
      }
      if (this.hasActiveOrManualTx() && this.busyAction !== 'commit') {
        const rollbackPromise = this.host
          .requestPlugin<TransactionState>('tx.rollback', {
            connectionId: prevConnId,
            onlyIfOwner: true,
            ...(txToken !== undefined ? { txToken } : {}),
          })
          .catch(() => {})
        this.trackConnectionCleanup(prevConnId, rollbackPromise)
      }
    }
    this.contextGeneration++
    this.mutationEpoch++
    this.refreshSeq++
    this.activeMutationToken = null
    this.inFlightBegin = null
    this.inFlightSetAutoCommit = null
    this.state = { ...DEFAULT_TX_STATE }
    this.busy = false
    this.busyAction = null
  }

  public resetLocalStateAndRender(): void {
    this.refreshSeq++
    this.state = { ...DEFAULT_TX_STATE }
    this.updateToolbar()
  }

  public rollbackOnUnload(): void {
    const activeConnId = this.host.getActiveConnectionId()
    const inFlightConnIds = new Set<string>()
    if (this.inFlightBegin) {
      this.inFlightBegin.rollbackOnSettle = true
      inFlightConnIds.add(this.inFlightBegin.connId)
    }
    if (this.inFlightSetAutoCommit) {
      this.inFlightSetAutoCommit.rollbackOnSettle = true
      inFlightConnIds.add(this.inFlightSetAutoCommit.connId)
    }
    const targets = new Set<string>()
    if (activeConnId && this.hasActiveOrManualTx()) {
      targets.add(activeConnId)
    }
    for (const pendingConnId of this.pendingConnectionCleanups.keys()) {
      if (!inFlightConnIds.has(pendingConnId)) {
        targets.add(pendingConnId)
      }
    }
    for (const connId of targets) {
      const txToken =
        (connId === activeConnId ? this.state.txToken : undefined) ??
        this.knownTxTokens.get(connId)
      void this.host
        .requestPlugin<TransactionState>('tx.rollback', {
          connectionId: connId,
          onlyIfOwner: true,
          ...(txToken !== undefined ? { txToken } : {}),
        })
        .catch(() => {})
    }
  }

  public async refreshState(connectionId?: string): Promise<void> {
    if (this.destroyed) return
    const targetId = connectionId ?? this.host.getActiveConnectionId()
    if (targetId && targetId !== this.host.getActiveConnectionId()) {
      return
    }
    if (this.activeMutationToken !== null) {
      return
    }
    const gen = this.contextGeneration
    const epoch = this.mutationEpoch
    const reqSeq = ++this.refreshSeq
    if (!targetId) {
      if (
        !this.destroyed &&
        gen === this.contextGeneration &&
        epoch === this.mutationEpoch &&
        reqSeq === this.refreshSeq &&
        this.activeMutationToken === null &&
        !this.host.getActiveConnectionId()
      ) {
        this.state = { ...DEFAULT_TX_STATE }
        this.updateToolbar()
      }
      return
    }
    let next: TransactionState
    try {
      next = await this.host.requestPlugin<TransactionState>('tx.status', {
        connectionId: targetId,
      })
    } catch {
      next = {
        ...DEFAULT_TX_STATE,
        reason: 'Transaction status unavailable',
      }
    }
    if (
      !this.isCurrentContext(gen, targetId) ||
      epoch !== this.mutationEpoch ||
      reqSeq !== this.refreshSeq ||
      this.activeMutationToken !== null
    ) {
      return
    }
    this.state = this.pendingConnectionCleanups.has(targetId)
      ? {
          ...next,
          active: false,
          statementCount: 0,
        }
      : next
    this.rememberTxToken(targetId, this.state)
    this.updateToolbar()
  }

  public updateToolbar(): void {
    if (
      !this.autoCommitBtn ||
      !this.beginBtn ||
      !this.commitBtn ||
      !this.rollbackBtn ||
      !this.badgeEl
    ) {
      return
    }
    const connId = this.host.getActiveConnectionId()
    const conn = this.host.getActiveConnection()
    const lockedReason =
      !connId || !conn
        ? 'No active connection'
        : this.host.isReadOnly()
          ? 'Read-Only connection'
          : !this.state.supported
            ? this.state.reason || 'Transactions are not supported by this driver'
            : this.host.isQueryRunning()
              ? 'Query running...'
              : this.busy
                ? 'Transaction operation in progress...'
                : ''

    this.autoCommitBtn.textContent = this.state.autoCommit ? 'Auto-Commit' : 'Manual TX'
    this.autoCommitBtn.classList.toggle('active', !this.state.autoCommit)
    this.autoCommitBtn.setAttribute('aria-pressed', String(!this.state.autoCommit))
    this.commitBtn.classList.toggle('datanoa-btn-primary', this.state.active)
    this.rollbackBtn.classList.toggle('datanoa-btn-danger', this.state.active)

    if (this.txToggleBtn && this.txToggleLabelEl) {
      const isManual = !this.state.autoCommit
      const isOpen = this.state.active
      this.txToggleBtn.classList.toggle('is-manual', isManual)
      this.txToggleBtn.classList.toggle('is-open', isOpen)
      this.txToggleLabelEl.textContent = isOpen
        ? 'TX Open'
        : isManual
          ? 'Manual TX'
          : 'TX'
      this.txToggleBtn.title = lockedReason
        ? `Transaction controls (${lockedReason})`
        : this.isExpanded
          ? 'Collapse transaction controls'
          : 'Expand transaction controls'
    }
    this.syncDrawerState()

    if (lockedReason) {
      for (const btn of [this.autoCommitBtn, this.beginBtn, this.commitBtn, this.rollbackBtn]) {
        btn.disabled = true
        btn.title = lockedReason
      }
    } else {
      this.autoCommitBtn.disabled = this.state.active
      this.autoCommitBtn.title = this.state.active
        ? 'Commit or rollback active transaction first'
        : this.state.autoCommit
          ? 'Auto-commit is ON. Click for manual transaction mode'
          : 'Manual transaction mode. Click to enable auto-commit'
      this.beginBtn.disabled = this.state.active
      this.beginBtn.title = this.state.active ? 'Transaction already open' : 'Begin transaction'
      this.commitBtn.disabled = !this.state.active
      this.commitBtn.title = this.state.active ? 'Commit transaction' : 'No active transaction'
      this.rollbackBtn.disabled = !this.state.active
      this.rollbackBtn.title = this.state.active ? 'Rollback transaction' : 'No active transaction'
    }

    this.badgeEl.style.display = this.state.active ? 'inline-flex' : 'none'
    if (this.state.active) {
      this.badgeEl.textContent =
        this.state.statementCount > 0 ? `TX open · ${this.state.statementCount} stmt(s)` : 'TX open'
    }
  }

  private reportError(title: string, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err)
    this.host.showErrorBanner(title, msg)
    this.host.updateStatus(`${title}: ${msg}`)
  }

  public async toggleAutoCommit(): Promise<void> {
    const connId = this.host.getActiveConnectionId()
    if (!connId || this.busy || !this.state.supported || this.host.isReadOnly() || this.host.isQueryRunning()) {
      return
    }
    const gen = this.contextGeneration
    const token = ++this.nextMutationToken
    const enabled = !this.state.autoCommit
    this.activeMutationToken = token
    this.mutationEpoch++
    this.busy = true
    this.busyAction = 'toggle'
    this.updateToolbar()

    let resolveDone: () => void = () => {}
    let setAutoCommitEntry: InFlightTxAcquire | null = null

    try {
      if (this.pendingConnectionCleanups.has(connId)) {
        await this.waitForConnectionCleanup(connId)
        if (!this.isCurrentMutation(token, gen, connId)) return
      }
      if (!enabled) {
        const done = new Promise<void>((resolve) => {
          resolveDone = resolve
        })
        setAutoCommitEntry = { connId, token, done, rollbackOnSettle: false }
        this.inFlightSetAutoCommit = setAutoCommitEntry
      }
      const next = await this.host.requestPlugin<TransactionState>('tx.setAutoCommit', {
        connectionId: connId,
        enabled,
      })
      if (next) {
        this.rememberTxToken(connId, next)
      }
      if (setAutoCommitEntry?.rollbackOnSettle || !this.isCurrentMutation(token, gen, connId)) {
        if (setAutoCommitEntry && next && (next.active || !next.autoCommit)) {
          await this.host
            .requestPlugin<TransactionState>('tx.rollback', {
              connectionId: connId,
              onlyIfOwner: true,
              ...(next.txToken !== undefined ? { txToken: next.txToken } : {}),
            })
            .catch(() => {})
        }
        return
      }
      this.state = next
      this.host.updateStatus(
        next.autoCommit ? 'Auto-commit enabled' : 'Manual transaction mode enabled'
      )
    } catch (err) {
      if (this.isCurrentMutation(token, gen, connId)) {
        this.reportError('Transaction Error', err)
        this.releaseMutation(token)
        void this.refreshState(connId)
      }
    } finally {
      if (setAutoCommitEntry && this.inFlightSetAutoCommit === setAutoCommitEntry) {
        this.inFlightSetAutoCommit = null
      }
      this.releaseMutation(token)
      resolveDone()
    }
  }

  public async begin(): Promise<void> {
    const connId = this.host.getActiveConnectionId()
    if (!connId || this.busy || !this.state.supported || this.host.isReadOnly() || this.host.isQueryRunning()) {
      return
    }
    const gen = this.contextGeneration
    const token = ++this.nextMutationToken
    this.activeMutationToken = token
    this.mutationEpoch++
    this.busy = true
    this.busyAction = 'begin'
    this.updateToolbar()

    let resolveDone: () => void = () => {}
    let beginEntry: {
      connId: string
      token: number
      done: Promise<void>
      rollbackOnSettle: boolean
    } | null = null

    try {
      if (this.pendingConnectionCleanups.has(connId)) {
        await this.waitForConnectionCleanup(connId)
        if (!this.isCurrentMutation(token, gen, connId)) {
          return
        }
      }
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve
      })
      beginEntry = { connId, token, done, rollbackOnSettle: false }
      this.inFlightBegin = beginEntry

      const state = await this.host.requestPlugin<TransactionState>('tx.begin', {
        connectionId: connId,
      })
      if (state) {
        this.rememberTxToken(connId, state)
      }
      if (beginEntry.rollbackOnSettle || !this.isCurrentMutation(token, gen, connId)) {
        if (state?.active) {
          await this.host
            .requestPlugin<TransactionState>('tx.rollback', {
              connectionId: connId,
              onlyIfOwner: true,
              ...(state?.txToken !== undefined ? { txToken: state.txToken } : {}),
            })
            .catch(() => {})
        }
        return
      }
      this.state = state
      this.host.updateStatus('Transaction started')
    } catch (err) {
      if (this.isCurrentMutation(token, gen, connId)) {
        this.reportError('Transaction Error', err)
        this.releaseMutation(token)
        void this.refreshState(connId)
      }
    } finally {
      if (beginEntry && this.inFlightBegin === beginEntry) {
        this.inFlightBegin = null
      }
      this.releaseMutation(token)
      resolveDone()
    }
  }

  public async commit(): Promise<void> {
    const connId = this.host.getActiveConnectionId()
    if (!connId || this.busy || !this.state.active || this.host.isQueryRunning()) return
    const gen = this.contextGeneration
    const token = ++this.nextMutationToken
    this.activeMutationToken = token
    this.mutationEpoch++
    this.busy = true
    this.busyAction = 'commit'
    this.updateToolbar()
    try {
      if (this.pendingConnectionCleanups.has(connId)) {
        await this.waitForConnectionCleanup(connId)
        if (!this.isCurrentMutation(token, gen, connId)) return
      }
      const next = await this.host.requestPlugin<TransactionState>('tx.commit', {
        connectionId: connId,
      })
      if (!this.isCurrentMutation(token, gen, connId)) return
      this.state = next
      this.rememberTxToken(connId, next)
      this.host.updateStatus('Transaction committed')
      const activeTable = this.host.getActiveTable()
      if (!this.host.isShowingSqlResult() && activeTable) {
        this.host.reloadTableData(connId, activeTable, this.host.getCurrentPage() || 1)
      }
    } catch (err) {
      if (this.isCurrentMutation(token, gen, connId)) {
        this.reportError('Commit Failed', err)
        this.releaseMutation(token)
        void this.refreshState(connId)
      }
    } finally {
      this.releaseMutation(token)
    }
  }

  public async rollback(): Promise<void> {
    const connId = this.host.getActiveConnectionId()
    if (!connId || this.busy || !this.state.active || this.host.isQueryRunning()) return
    const gen = this.contextGeneration
    const token = ++this.nextMutationToken
    this.activeMutationToken = token
    this.mutationEpoch++
    this.busy = true
    this.busyAction = 'rollback'
    this.updateToolbar()
    try {
      if (this.pendingConnectionCleanups.has(connId)) {
        await this.waitForConnectionCleanup(connId)
        if (!this.isCurrentMutation(token, gen, connId)) return
      }
      const next = await this.host.requestPlugin<TransactionState>('tx.rollback', {
        connectionId: connId,
      })
      if (!this.isCurrentMutation(token, gen, connId)) return
      this.state = next
      this.rememberTxToken(connId, next)
      this.host.updateStatus('Transaction rolled back')
      const activeTable = this.host.getActiveTable()
      if (!this.host.isShowingSqlResult() && activeTable) {
        this.host.reloadTableData(connId, activeTable, this.host.getCurrentPage() || 1)
      }
    } catch (err) {
      if (this.isCurrentMutation(token, gen, connId)) {
        this.reportError('Rollback Failed', err)
        this.releaseMutation(token)
        void this.refreshState(connId)
      }
    } finally {
      this.releaseMutation(token)
    }
  }

  public destroy(): void {
    this.destroyed = true
    this.contextGeneration++
    this.mutationEpoch++
    this.refreshSeq++
    this.activeMutationToken = null
    this.inFlightBegin = null
    this.inFlightSetAutoCommit = null
    this.busy = false
    while (this.boundCleanups.length > 0) {
      this.boundCleanups.pop()?.()
    }
    this.groupEl = null
    this.txToggleBtn = null
    this.txToggleDotEl = null
    this.txToggleLabelEl = null
    this.txToggleChevEl = null
    this.txTrayEl = null
    this.autoCommitBtn = null
    this.beginBtn = null
    this.commitBtn = null
    this.rollbackBtn = null
    this.badgeEl = null
  }
}
