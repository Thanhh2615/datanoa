// src/editor/transaction-toolbar.ts
// Cohesive Transaction Toolbar & Manual Transaction lifecycle controller for Datanoa Studio.

import type { ConnectionProfile, TransactionState } from '../protocol.js'

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

const DEFAULT_TX_STATE: TransactionState = {
  active: false,
  autoCommit: true,
  statementCount: 0,
  supported: false,
}

export class TransactionToolbarController {
  private readonly host: TransactionToolbarHost
  private autoCommitBtn: HTMLButtonElement | null = null
  private beginBtn: HTMLButtonElement | null = null
  private commitBtn: HTMLButtonElement | null = null
  private rollbackBtn: HTMLButtonElement | null = null
  private badgeEl: HTMLSpanElement | null = null
  private state: TransactionState = { ...DEFAULT_TX_STATE }
  private busy = false
  private contextGeneration = 0
  private mutationEpoch = 0
  private nextMutationToken = 0
  private activeMutationToken: number | null = null
  private refreshSeq = 0
  private destroyed = false
  private inFlightBegin: { connId: string; token: number; done: Promise<void> } | null = null
  private readonly pendingConnectionCleanups = new Map<string, Promise<void>>()
  private boundCleanups: Array<() => void> = []

  constructor(host: TransactionToolbarHost) {
    this.host = host
  }

  private addClickListener(btn: HTMLButtonElement, handler: () => void): void {
    btn.addEventListener('click', handler)
    this.boundCleanups.push(() => btn.removeEventListener('click', handler))
  }

  public mount(parent: HTMLElement): void {
    const sep = document.createElement('span')
    sep.className = 'datanoa-toolbar-sep'
    sep.setAttribute('aria-hidden', 'true')

    const group = document.createElement('div')
    group.className = 'datanoa-tx-group'

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
    this.badgeEl.textContent = 'TX OPEN'
    this.badgeEl.style.display = 'none'
    this.badgeEl.setAttribute('role', 'status')
    this.badgeEl.setAttribute('aria-live', 'polite')

    group.appendChild(this.autoCommitBtn)
    group.appendChild(this.beginBtn)
    group.appendChild(this.commitBtn)
    group.appendChild(this.rollbackBtn)
    group.appendChild(this.badgeEl)

    parent.appendChild(sep)
    parent.appendChild(group)
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

  public resetForConnectionSwitch(prevConnId: string | null): void {
    if (prevConnId) {
      if (this.inFlightBegin && this.inFlightBegin.connId === prevConnId) {
        this.trackConnectionCleanup(prevConnId, this.inFlightBegin.done)
      }
      if (this.hasActiveOrManualTx()) {
        const rollbackPromise = this.host
          .requestPlugin<TransactionState>('tx.rollback', { connectionId: prevConnId })
          .catch(() => {})
        this.trackConnectionCleanup(prevConnId, rollbackPromise)
      }
    }
    this.contextGeneration++
    this.mutationEpoch++
    this.refreshSeq++
    this.activeMutationToken = null
    this.inFlightBegin = null
    this.state = { ...DEFAULT_TX_STATE }
    this.busy = false
  }

  public resetLocalStateAndRender(): void {
    this.refreshSeq++
    this.state = { ...DEFAULT_TX_STATE }
    this.updateToolbar()
  }

  public rollbackOnUnload(): void {
    const activeConnId = this.host.getActiveConnectionId()
    const targets = new Set<string>()
    if (
      activeConnId &&
      (this.hasActiveOrManualTx() || this.inFlightBegin?.connId === activeConnId)
    ) {
      targets.add(activeConnId)
    }
    for (const pendingConnId of this.pendingConnectionCleanups.keys()) {
      targets.add(pendingConnId)
    }
    for (const connId of targets) {
      void this.host
        .requestPlugin<TransactionState>('tx.rollback', { connectionId: connId })
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
        this.state.statementCount > 0 ? `TX OPEN · ${this.state.statementCount} stmt(s)` : 'TX OPEN'
    }
  }

  private reportError(title: string, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err)
    this.host.showErrorBanner(title, msg)
    this.host.updateStatus(`${title}: ${msg}`)
  }

  public async toggleAutoCommit(): Promise<void> {
    const connId = this.host.getActiveConnectionId()
    if (!connId || this.busy || !this.state.supported || this.host.isReadOnly()) {
      return
    }
    const gen = this.contextGeneration
    const token = ++this.nextMutationToken
    const enabled = !this.state.autoCommit
    this.activeMutationToken = token
    this.mutationEpoch++
    this.busy = true
    this.updateToolbar()
    try {
      if (this.pendingConnectionCleanups.has(connId)) {
        await this.waitForConnectionCleanup(connId)
        if (!this.isCurrentMutation(token, gen, connId)) return
      }
      const next = await this.host.requestPlugin<TransactionState>('tx.setAutoCommit', {
        connectionId: connId,
        enabled,
      })
      if (!this.isCurrentMutation(token, gen, connId)) return
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
      this.releaseMutation(token)
    }
  }

  public async begin(): Promise<void> {
    const connId = this.host.getActiveConnectionId()
    if (!connId || this.busy || !this.state.supported || this.host.isReadOnly()) {
      return
    }
    const gen = this.contextGeneration
    const token = ++this.nextMutationToken
    this.activeMutationToken = token
    this.mutationEpoch++
    this.busy = true
    this.updateToolbar()

    let resolveDone: () => void = () => {}
    let beginEntry: { connId: string; token: number; done: Promise<void> } | null = null

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
      beginEntry = { connId, token, done }
      this.inFlightBegin = beginEntry

      const next = await this.host.requestPlugin<TransactionState>('tx.begin', {
        connectionId: connId,
      })
      if (!this.isCurrentMutation(token, gen, connId)) {
        if (next?.active) {
          await this.host
            .requestPlugin<TransactionState>('tx.rollback', { connectionId: connId })
            .catch(() => {})
        }
        return
      }
      this.state = next
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
    if (!connId || this.busy || !this.state.active) return
    const gen = this.contextGeneration
    const token = ++this.nextMutationToken
    this.activeMutationToken = token
    this.mutationEpoch++
    this.busy = true
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
    if (!connId || this.busy || !this.state.active) return
    const gen = this.contextGeneration
    const token = ++this.nextMutationToken
    this.activeMutationToken = token
    this.mutationEpoch++
    this.busy = true
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
    this.busy = false
    while (this.boundCleanups.length > 0) {
      this.boundCleanups.pop()?.()
    }
    this.autoCommitBtn = null
    this.beginBtn = null
    this.commitBtn = null
    this.rollbackBtn = null
    this.badgeEl = null
  }
}
