import { createHostError } from './worker-utils'

export interface TxOwnerEntry {
  panelId: string
  txToken: number
  sessionRef: unknown
}

export interface TxSessionStateLike {
  active?: boolean
  autoCommit?: boolean
}

export interface TxPanelContextLike {
  panel?: { id?: string }
}

/**
 * Coordinates per-connection transaction ownership and serialized TX locking across
 * query execution, transaction RPCs, and grid data mutation/read handlers.
 */
export class TxOwnershipController {
  private readonly ownerByConn = new Map<string, TxOwnerEntry>()
  private readonly lockTailByConn = new Map<string, Promise<void>>()
  private tokenSeq = 0

  async withLock<T>(connectionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.lockTailByConn.get(connectionId) ?? Promise.resolve()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = prev.then(
      () => gate,
      () => gate
    )
    this.lockTailByConn.set(connectionId, tail)
    await prev.catch(() => {})
    try {
      return await fn()
    } finally {
      release()
      if (this.lockTailByConn.get(connectionId) === tail) {
        this.lockTailByConn.delete(connectionId)
      }
    }
  }

  getPanelId(ctx: TxPanelContextLike | undefined): string | undefined {
    const id = ctx?.panel?.id
    return typeof id === 'string' && id.trim().length > 0 ? id.trim() : undefined
  }

  requirePanelId(ctx: TxPanelContextLike | undefined): string {
    const panelId = this.getPanelId(ctx)
    if (!panelId) {
      throw createHostError(
        'forbidden',
        'Transaction control requires an identifiable editor panel.'
      )
    }
    return panelId
  }

  syncForSession(
    connectionId: string,
    session: unknown,
    state: TxSessionStateLike | null | undefined
  ): TxOwnerEntry | undefined {
    const existing = this.ownerByConn.get(connectionId)
    if (existing && existing.sessionRef !== session) {
      this.ownerByConn.delete(connectionId)
      return undefined
    }
    if (state && !state.active && state.autoCommit) {
      this.ownerByConn.delete(connectionId)
      return undefined
    }
    return this.ownerByConn.get(connectionId)
  }

  setOwner(connectionId: string, panelId: string, session: unknown): number {
    const txToken = ++this.tokenSeq
    this.ownerByConn.set(connectionId, {
      panelId,
      txToken,
      sessionRef: session,
    })
    return txToken
  }

  clearOwner(connectionId: string): void {
    this.ownerByConn.delete(connectionId)
  }

  isForeignOwned(
    connectionId: string,
    session: unknown,
    panelId: string | undefined,
    state?: TxSessionStateLike | null
  ): boolean {
    const owner = this.syncForSession(connectionId, session, state)
    return Boolean(owner && owner.panelId !== panelId && (!state || state.active || !state.autoCommit))
  }

  reconcileAfterWrite(
    connectionId: string,
    session: unknown,
    panelId: string | undefined,
    wasActive: boolean,
    postState: TxSessionStateLike
  ): void {
    const existingOwner = this.syncForSession(connectionId, session, postState)
    if (!wasActive && postState.active) {
      if (panelId && !existingOwner) {
        this.setOwner(connectionId, panelId, session)
      }
      return
    }
    if (wasActive && !postState.active) {
      if (!postState.autoCommit && existingOwner) {
        this.setOwner(connectionId, existingOwner.panelId, session)
      } else {
        this.clearOwner(connectionId)
      }
      return
    }
    if (!wasActive && !postState.active && postState.autoCommit === false) {
      if (panelId && !existingOwner) {
        this.setOwner(connectionId, panelId, session)
      }
    }
  }

  clearAll(): void {
    this.ownerByConn.clear()
    this.lockTailByConn.clear()
  }
}
