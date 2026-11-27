import { randomUUID } from 'node:crypto'
import type { CopyImportStreamHandle } from '../drivers/common/driver'
import { createHostError } from './worker-utils'

export const COPY_IMPORT_IDLE_TIMEOUT_MS = 30_000
export const COPY_IMPORT_MAX_CHUNK_BYTES = 512 * 1024

export interface CopyImportRegistryOptions {
  idleTimeoutMs?: number
}

interface CopyImportEntry {
  importId: string
  connectionId: string
  table: string
  schema?: string
  columns: string[]
  panelId?: string
  handle: CopyImportStreamHandle
  idleTimer: ReturnType<typeof setTimeout> | null
  closed: boolean
  committing: boolean
  opChain: Promise<void>
}

/**
 * Tracks active streaming COPY FROM STDIN imports across worker RPC calls with
 * per-connection lease exclusivity (`COPY_IN_PROGRESS`), >30s `.unref()` idle reaper,
 * and early abort on session close or worker teardown.
 */
export class CopyImportRegistry {
  private readonly importsById = new Map<string, CopyImportEntry>()
  private readonly activeImportByConn = new Map<string, string>()
  private readonly idleTimeoutMs: number

  constructor(options: CopyImportRegistryOptions = {}) {
    this.idleTimeoutMs = Math.max(10, options.idleTimeoutMs ?? COPY_IMPORT_IDLE_TIMEOUT_MS)
  }

  hasActiveImport(connectionId: string): boolean {
    if (!connectionId) return false
    const importId = this.activeImportByConn.get(connectionId)
    if (!importId) return false
    const entry = this.importsById.get(importId)
    return Boolean(entry && !entry.closed)
  }

  assertNoActiveImport(connectionId: string): void {
    if (this.hasActiveImport(connectionId)) {
      throw createHostError(
        'COPY_IN_PROGRESS',
        'Cannot run session operation while a COPY import stream is active.'
      )
    }
  }

  private clearIdleTimer(entry: CopyImportEntry): void {
    if (entry.idleTimer !== null) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = null
    }
  }

  private armIdleTimer(entry: CopyImportEntry): void {
    this.clearIdleTimer(entry)
    if (entry.closed) return
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null
      if (entry.closed) return
      void this.abort(entry.importId, 'COPY stream idle timeout exceeded (>30s)').catch(() => {})
    }, this.idleTimeoutMs)
    if (typeof entry.idleTimer.unref === 'function') {
      entry.idleTimer.unref()
    }
  }

  private cleanupEntry(entry: CopyImportEntry): void {
    entry.closed = true
    this.clearIdleTimer(entry)
    this.importsById.delete(entry.importId)
    if (this.activeImportByConn.get(entry.connectionId) === entry.importId) {
      this.activeImportByConn.delete(entry.connectionId)
    }
  }

  register(params: {
    connectionId: string
    table: string
    schema?: string
    columns: string[]
    panelId?: string
    handle: CopyImportStreamHandle
  }): string {
    this.assertNoActiveImport(params.connectionId)
    const importId = `copy_${randomUUID()}`
    const entry: CopyImportEntry = {
      importId,
      connectionId: params.connectionId,
      table: params.table,
      schema: params.schema,
      columns: [...params.columns],
      panelId: params.panelId,
      handle: params.handle,
      idleTimer: null,
      closed: false,
      committing: false,
      opChain: Promise.resolve(),
    }
    this.importsById.set(importId, entry)
    this.activeImportByConn.set(params.connectionId, importId)
    this.armIdleTimer(entry)
    return importId
  }

  private getOwnedEntry(importId: string, panelId?: string): CopyImportEntry {
    const entry = this.importsById.get(importId)
    if (!entry || entry.closed) {
      throw createHostError('invalid_params', `COPY import session '${importId}' not found or closed`)
    }
    if (entry.panelId && panelId && entry.panelId !== panelId) {
      throw createHostError(
        'forbidden',
        'Cannot access a COPY import stream opened by another editor panel.'
      )
    }
    return entry
  }

  private enqueueEntryOp<T>(entry: CopyImportEntry, fn: () => Promise<T>): Promise<T> {
    const task = entry.opChain.then(fn)
    entry.opChain = task.then(
      () => undefined,
      () => undefined
    )
    return task
  }

  async write(
    importId: string,
    rows: Array<Record<string, unknown> | unknown[]>,
    panelId?: string
  ): Promise<{ bytesWritten: number; rowCount: number }> {
    const entry = this.getOwnedEntry(importId, panelId)
    if (entry.committing) {
      throw createHostError(
        'INVALID_STATE',
        'Cannot write rows after COPY import commit has started.'
      )
    }
    return await this.enqueueEntryOp(entry, async () => {
      if (entry.closed) {
        throw createHostError(
          'INVALID_STATE',
          `COPY import session '${importId}' is already closed.`
        )
      }
      this.clearIdleTimer(entry)
      try {
        const result = await entry.handle.writeRows(rows)
        if (!entry.closed && !entry.committing) {
          this.armIdleTimer(entry)
        }
        return result
      } catch (err: unknown) {
        this.cleanupEntry(entry)
        throw err
      }
    })
  }

  async commit(
    importId: string,
    panelId?: string
  ): Promise<{ inserted: number; connectionId: string; schema?: string; table: string }> {
    const entry = this.getOwnedEntry(importId, panelId)
    if (entry.committing) {
      throw createHostError('INVALID_STATE', 'COPY import commit is already in progress.')
    }
    entry.committing = true
    this.clearIdleTimer(entry)
    return await this.enqueueEntryOp(entry, async () => {
      if (entry.closed) {
        throw createHostError(
          'INVALID_STATE',
          `COPY import session '${importId}' was closed before commit.`
        )
      }
      try {
        const res = await entry.handle.commit()
        return {
          inserted: res.inserted,
          connectionId: entry.connectionId,
          schema: entry.schema,
          table: entry.table,
        }
      } finally {
        this.cleanupEntry(entry)
      }
    })
  }

  async abort(importId: string, reason?: string, panelId?: string): Promise<boolean> {
    const entry = this.importsById.get(importId)
    if (!entry) return false
    if (entry.panelId && panelId && entry.panelId !== panelId) {
      throw createHostError(
        'forbidden',
        'Cannot abort a COPY import stream opened by another editor panel.'
      )
    }
    this.cleanupEntry(entry)
    await entry.handle.abort(reason).catch(() => {})
    return true
  }

  async abortByConnection(connectionId: string, reason = 'Session closed'): Promise<void> {
    const importId = this.activeImportByConn.get(connectionId)
    if (!importId) return
    await this.abort(importId, reason)
  }

  async dispose(): Promise<void> {
    const entries = Array.from(this.importsById.values())
    for (const entry of entries) {
      this.cleanupEntry(entry)
    }
    await Promise.all(entries.map((entry) => entry.handle.abort('Worker deactivated').catch(() => {})))
  }
}
