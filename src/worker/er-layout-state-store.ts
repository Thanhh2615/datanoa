import type { JsonValue, OrcaWorkerApi } from 'orca/worker'
import {
  sanitizeJsonPayload,
  type ErLayoutStateEntry,
  type ErNodePosition,
} from '../protocol'
import {
  LatestWinsWriter,
  belongsToConnectionKey,
  isPlainRecord,
  measureJsonBytes,
  readHostConfigBackup,
  writeHostConfigBackupPatch,
} from './worker-utils'

export const ER_LAYOUT_STATE_STORAGE_KEY = 'datanoa.erLayoutState'
export const MAX_ER_LAYOUT_ENTRIES = 50
export const MAX_ER_LAYOUT_BYTES = 150_000
const MAX_POSITIONS_PER_SCHEMA = 1000

export interface ErLayoutStateStoreOptions {
  orca: Pick<OrcaWorkerApi, 'storage' | 'host' | 'log'>
  debounceMs?: number
  beforeLoad?: () => Promise<void>
  isActive?: () => boolean
}

function normalizePositions(raw: unknown): Record<string, ErNodePosition> {
  if (!isPlainRecord(raw)) return {}
  const out: Record<string, ErNodePosition> = {}
  let count = 0
  for (const [nodeId, pos] of Object.entries(raw)) {
    if (count >= MAX_POSITIONS_PER_SCHEMA) break
    if (!nodeId || !isPlainRecord(pos)) continue
    const x = pos.x
    const y = pos.y
    if (typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y)) {
      out[nodeId] = {
        x: Math.round(x * 100) / 100,
        y: Math.round(y * 100) / 100,
      }
      count += 1
    }
  }
  return out
}

export function normalizeErLayoutStateEntry(raw: unknown): ErLayoutStateEntry | null {
  if (!isPlainRecord(raw)) return null
  const positions = normalizePositions(raw.positions)
  const compactMode = raw.compactMode === true ? true : undefined
  const hideOrphans = raw.hideOrphans === true ? true : undefined
  const collapseJunctions = raw.collapseJunctions === true ? true : undefined

  if (
    Object.keys(positions).length === 0 &&
    !compactMode &&
    !hideOrphans &&
    !collapseJunctions
  ) {
    return null
  }

  return {
    positions,
    ...(compactMode ? { compactMode: true } : {}),
    ...(hideOrphans ? { hideOrphans: true } : {}),
    ...(collapseJunctions ? { collapseJunctions: true } : {}),
    updatedAt:
      typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) && raw.updatedAt > 0
        ? Math.trunc(raw.updatedAt)
        : 0,
    revision:
      typeof raw.revision === 'number' && Number.isFinite(raw.revision) && raw.revision >= 0
        ? Math.trunc(raw.revision)
        : 0,
  }
}

/**
 * Bounded per-schema ER diagram manual layout store (`datanoa.erLayoutState`)
 * with LRU 50 schemas, <= 150 KB UTF-8 cap, and LatestWinsWriter flush before backup writes.
 */
export class ErLayoutStateStore {
  private readonly orca: Pick<OrcaWorkerApi, 'storage' | 'host' | 'log'>
  private readonly entries = new Map<string, ErLayoutStateEntry>()
  private readonly writer: LatestWinsWriter
  private readonly beforeLoad?: () => Promise<void>
  private readonly isActive?: () => boolean
  private opQueue: Promise<void> = Promise.resolve()
  private tearingDown = false
  private flushingForTeardown = false
  private loadPromise: Promise<void> | null = null
  private loaded = false
  private disposed = false

  constructor(options: ErLayoutStateStoreOptions) {
    this.orca = options.orca
    this.beforeLoad = options.beforeLoad
    this.isActive = options.isActive
    this.writer = new LatestWinsWriter(
      () => this.persistNow(),
      options.debounceMs,
      () => !this.disposed && (!this.isActive || this.isActive() || this.flushingForTeardown)
    )
  }

  private isEvicted(): boolean {
    return this.disposed || this.tearingDown || Boolean(this.isActive && !this.isActive())
  }

  beginTeardown(): void {
    this.tearingDown = true
    this.flushingForTeardown = true
    this.writer.pauseTimer()
  }

  private enqueueOp<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.opQueue.then(fn)
    this.opQueue = task.then(
      () => undefined,
      () => undefined
    )
    return task
  }

  private isLiveDesktopHost(): boolean {
    return Boolean(this.orca.host && typeof this.orca.host.call === 'function')
  }

  private serializeMap(): Record<string, ErLayoutStateEntry> {
    const out: Record<string, ErLayoutStateEntry> = {}
    for (const [k, v] of this.entries.entries()) {
      out[k] = v
    }
    return out
  }

  private enforceBounds(): void {
    while (this.entries.size > MAX_ER_LAYOUT_ENTRIES) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
    while (this.entries.size > 0 && measureJsonBytes(this.serializeMap()) > MAX_ER_LAYOUT_BYTES) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  private touchEntry(schemaKey: string, entry: ErLayoutStateEntry): void {
    this.entries.delete(schemaKey)
    this.entries.set(schemaKey, entry)
    this.enforceBounds()
  }

  private async persistNow(): Promise<void> {
    if (this.disposed) return
    if (this.isActive && !this.isActive() && !this.flushingForTeardown) return
    this.enforceBounds()
    const payload = sanitizeJsonPayload(this.serializeMap())
    await this.orca.storage.set(ER_LAYOUT_STATE_STORAGE_KEY, payload as unknown as JsonValue)
    if (this.disposed) return
    if (this.isLiveDesktopHost()) {
      await writeHostConfigBackupPatch({ erLayoutState: payload })
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    if (this.loadPromise) return await this.loadPromise

    this.loadPromise = (async () => {
      if (this.beforeLoad) {
        await this.beforeLoad().catch(() => {})
      }
      if (this.isEvicted()) return

      let rawStore = await this.orca.storage.get(ER_LAYOUT_STATE_STORAGE_KEY).catch(() => null)
      if ((!isPlainRecord(rawStore) || Object.keys(rawStore).length === 0) && this.isLiveDesktopHost()) {
        const backup = await readHostConfigBackup()
        if (isPlainRecord(backup?.erLayoutState)) {
          rawStore = backup.erLayoutState as unknown as JsonValue
        }
      }
      if (isPlainRecord(rawStore)) {
        for (const [schemaKey, rawEntry] of Object.entries(rawStore)) {
          if (!schemaKey) continue
          const clean = normalizeErLayoutStateEntry(rawEntry)
          if (clean) {
            this.entries.set(schemaKey, clean)
          }
        }
      }
      this.enforceBounds()
      if (this.isEvicted()) return
      this.loaded = true
    })()

    try {
      await this.loadPromise
    } finally {
      this.loadPromise = null
    }
  }

  async get(schemaKey: string): Promise<{
    schemaKey: string
    entry: ErLayoutStateEntry | null
    revision: number
  }> {
    return await this.enqueueOp(async () => {
      await this.ensureLoaded()
      const key = typeof schemaKey === 'string' ? schemaKey.trim() : ''
      if (!key) {
        return { schemaKey: '', entry: null, revision: 0 }
      }
      const found = this.entries.get(key)
      if (!found) {
        return { schemaKey: key, entry: null, revision: 0 }
      }
      this.touchEntry(key, found)
      return {
        schemaKey: key,
        entry: sanitizeJsonPayload(found),
        revision: found.revision,
      }
    })
  }

  async patch(input: {
    schemaKey: string
    patch: Partial<Omit<ErLayoutStateEntry, 'updatedAt' | 'revision'>>
    replacePositions?: boolean
  }): Promise<{
    ok: boolean
    schemaKey: string
    entry: ErLayoutStateEntry | null
    revision: number
  }> {
    return await this.enqueueOp(async () => {
      await this.ensureLoaded()
      const key = typeof input?.schemaKey === 'string' ? input.schemaKey.trim() : ''
      if (!key || this.isEvicted()) {
        return { ok: false, schemaKey: key, entry: null, revision: 0 }
      }

      const current = this.entries.get(key) ?? null
      const nextRevision = (current?.revision ?? 0) + 1
      let mergedPositions: Record<string, ErNodePosition> = { ...(current?.positions ?? {}) }
      if (input.patch.positions !== undefined) {
        if (input.replacePositions === true) {
          mergedPositions = normalizePositions(input.patch.positions)
        } else if (isPlainRecord(input.patch.positions)) {
          for (const [nodeId, rawPos] of Object.entries(
            input.patch.positions as Record<string, unknown>
          )) {
            if (!nodeId) continue
            if (rawPos === null) {
              delete mergedPositions[nodeId]
            } else if (isPlainRecord(rawPos)) {
              const x = rawPos.x
              const y = rawPos.y
              if (
                typeof x === 'number' &&
                Number.isFinite(x) &&
                typeof y === 'number' &&
                Number.isFinite(y)
              ) {
                mergedPositions[nodeId] = {
                  x: Math.round(x * 100) / 100,
                  y: Math.round(y * 100) / 100,
                }
              }
            }
          }
        }
      }

      const nextEntry = normalizeErLayoutStateEntry({
        ...(current ?? {}),
        ...input.patch,
        positions: mergedPositions,
        updatedAt: Date.now(),
        revision: nextRevision,
      })

      if (nextEntry) {
        this.touchEntry(key, nextEntry)
      } else {
        this.entries.delete(key)
      }

      this.writer.schedule()
      return {
        ok: true,
        schemaKey: key,
        entry: nextEntry ? sanitizeJsonPayload(nextEntry) : null,
        revision: nextEntry ? nextEntry.revision : current ? current.revision + 1 : 0,
      }
    })
  }

  async reset(input: { schemaKey?: string; connectionId?: string }): Promise<{
    ok: boolean
    removedCount: number
  }> {
    return await this.enqueueOp(async () => {
      await this.ensureLoaded()
      if (this.isEvicted()) {
        return { ok: false, removedCount: 0 }
      }
      const targetKey = typeof input?.schemaKey === 'string' ? input.schemaKey.trim() : ''
      const targetConnId = typeof input?.connectionId === 'string' ? input.connectionId.trim() : ''
      let removedCount = 0

      if (targetKey) {
        if (this.entries.delete(targetKey)) removedCount += 1
      } else if (targetConnId) {
        for (const k of Array.from(this.entries.keys())) {
          if (belongsToConnectionKey(k, targetConnId)) {
            this.entries.delete(k)
            removedCount += 1
          }
        }
      } else {
        removedCount = this.entries.size
        this.entries.clear()
      }

      if (removedCount > 0) {
        this.writer.schedule()
      }
      return { ok: true, removedCount }
    })
  }

  async deleteByConnection(connectionId: string): Promise<number> {
    if (!connectionId) return 0
    const res = await this.reset({ connectionId })
    return res.removedCount
  }

  async flush(): Promise<void> {
    this.flushingForTeardown = true
    this.writer.pauseTimer()
    try {
      await this.opQueue.catch(() => {})
      await this.writer.flush()
    } finally {
      this.flushingForTeardown = false
    }
  }

  dispose(): void {
    this.tearingDown = true
    this.disposed = true
    this.writer.dispose()
    this.entries.clear()
  }
}
