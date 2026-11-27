import type { JsonValue, OrcaWorkerApi } from 'orca/worker'
import {
  sanitizeJsonPayload,
  type PluginPanelEvents,
  type TableDisplayStateEntry,
} from '../protocol'
import {
  normalizeTableDisplayStateEntry,
  rebaseTableDisplayStateEntry,
  sanitizeColumnWidths,
  scrubSensitiveTableDisplayEntry,
} from '../shared-table-display.js'
import {
  LatestWinsWriter,
  belongsToConnectionKey,
  isPlainRecord,
  measureJsonBytes,
  normalizeMigratedTableDisplayKey,
  readHostConfigBackup,
  writeHostConfigBackupPatch,
} from './worker-utils'

export { LatestWinsWriter }

export const TABLE_DISPLAY_STATE_STORAGE_KEY = 'datanoa.tableDisplayState'
export const TABLE_DISPLAY_MIGRATED_STORAGE_KEY = 'datanoa.tableDisplayState.migrated'
export const MAX_TABLE_DISPLAY_ENTRIES = 200
export const MAX_TABLE_DISPLAY_BYTES = 300_000
export const MAX_TABLE_DISPLAY_BROADCAST_BYTES = 256 * 1024
const MAX_REVISION_HISTORY_PER_TABLE = 12
const DELTA_COALESCE_MS = 16
const DELTA_RATE_WINDOW_MS = 16
const DELTA_BURST_IMMEDIATE_LIMIT = 3
const DELTA_MAX_PER_TICK = 6
export const TABLE_DISPLAY_BROADCAST_WINDOW_MS = 10_000
export const MAX_TABLE_DISPLAY_BROADCASTS_PER_10S = 120

export interface TableDisplayStateStoreOptions {
  orca: Pick<OrcaWorkerApi, 'storage' | 'panels' | 'host' | 'log'>
  debounceMs?: number
  beforeLoad?: () => Promise<void>
  isActive?: () => boolean
}

function toStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}

function mergeStringLists(a: readonly string[] | undefined, b: readonly string[] | undefined): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of [...(a ?? []), ...(b ?? [])]) {
    if (!seen.has(item)) {
      seen.add(item)
      out.push(item)
    }
  }
  return out
}

/**
 * Bounded per-table display store (`datanoa.tableDisplayState`) with LRU 200 tables,
 * <= 300 KB UTF-8 cap, 3-way multi-tab rebase, one-time Studio+Panel legacy migration,
 * single-table delta broadcasting (<= 256 KiB), and LatestWinsWriter flush before backup writes.
 */
export type TableDisplayChangedPayload = PluginPanelEvents['ui.tableDisplayState.changed']

export class TableDisplayStateStore {
  private readonly orca: Pick<OrcaWorkerApi, 'storage' | 'panels' | 'host' | 'log'>
  private readonly entries = new Map<string, TableDisplayStateEntry>()
  private readonly revisionHistory = new Map<string, Map<number, TableDisplayStateEntry>>()
  private readonly maxRevisionByKey = new Map<string, number>()
  private globalRevisionFloor = 0
  private readonly writer: LatestWinsWriter
  private readonly beforeLoad?: () => Promise<void>
  private readonly isActive?: () => boolean
  private readonly pendingDeltaBroadcasts = new Map<
    string,
    { entry: TableDisplayStateEntry | null; revision: number }
  >()
  private readonly pendingBulkResets: TableDisplayChangedPayload[] = []
  private deltaCoalesceTimer: ReturnType<typeof setTimeout> | null = null
  private deltaWindowStartAt = 0
  private deltaWindowEmitCount = 0
  private readonly broadcastTimestamps: number[] = []
  private tearingDown = false
  private flushingForTeardown = false
  private loadPromise: Promise<void> | null = null
  private loaded = false
  private disposed = false

  constructor(options: TableDisplayStateStoreOptions) {
    this.orca = options.orca
    this.beforeLoad = options.beforeLoad
    this.isActive = options.isActive
    this.writer = new LatestWinsWriter(
      () => this.persistNow(),
      options.debounceMs,
      () => !this.disposed && (!this.isActive || this.isActive() || this.flushingForTeardown)
    )
  }

  private isLiveDesktopHost(): boolean {
    return Boolean(this.orca.host && typeof this.orca.host.call === 'function')
  }

  private touchEntry(tableKey: string, entry: TableDisplayStateEntry): void {
    this.entries.delete(tableKey)
    this.entries.set(tableKey, entry)
    this.enforceBounds()
  }

  private recordMaxRevision(tableKey: string, revision: number): void {
    const cleanRev = Number.isFinite(revision) && revision > 0 ? Math.floor(revision) : 0
    if (cleanRev <= 0) return
    const prev = this.maxRevisionByKey.get(tableKey) ?? 0
    const next = Math.max(prev, cleanRev)
    this.maxRevisionByKey.delete(tableKey)
    this.maxRevisionByKey.set(tableKey, next)
    while (this.maxRevisionByKey.size > MAX_TABLE_DISPLAY_ENTRIES * 10) {
      const oldestKey = this.maxRevisionByKey.keys().next().value
      if (oldestKey === undefined) break
      const oldestRev = this.maxRevisionByKey.get(oldestKey) ?? 0
      if (oldestRev > this.globalRevisionFloor) {
        this.globalRevisionFloor = oldestRev
      }
      this.maxRevisionByKey.delete(oldestKey)
    }
  }

  private getFloorRevision(tableKey: string): number {
    return Math.max(
      this.globalRevisionFloor,
      this.maxRevisionByKey.get(tableKey) ?? 0,
      this.entries.get(tableKey)?.revision ?? 0
    )
  }

  private recordRevisionSnapshot(tableKey: string, entry: TableDisplayStateEntry): void {
    this.recordMaxRevision(tableKey, entry.revision)
    let hist = this.revisionHistory.get(tableKey)
    if (!hist) {
      hist = new Map()
      this.revisionHistory.set(tableKey, hist)
    }
    hist.delete(entry.revision)
    hist.set(entry.revision, entry)
    while (hist.size > MAX_REVISION_HISTORY_PER_TABLE) {
      const oldest = hist.keys().next().value
      if (oldest === undefined) break
      hist.delete(oldest)
    }
  }

  private enforceBounds(): void {
    while (this.entries.size > MAX_TABLE_DISPLAY_ENTRIES) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
      this.revisionHistory.delete(oldest)
    }
    while (this.entries.size > 0 && measureJsonBytes(this.serializeMap()) > MAX_TABLE_DISPLAY_BYTES) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
      this.revisionHistory.delete(oldest)
    }
  }

  private serializeMap(): Record<string, TableDisplayStateEntry> {
    const out: Record<string, TableDisplayStateEntry> = {}
    for (const [k, v] of this.entries.entries()) {
      out[k] = v
    }
    return out
  }

  private isEvicted(): boolean {
    return this.disposed || this.tearingDown || Boolean(this.isActive && !this.isActive())
  }

  beginTeardown(): void {
    this.tearingDown = true
    this.flushingForTeardown = true
    this.writer.pauseTimer()
  }

  private async persistNow(): Promise<void> {
    if (this.disposed) return
    if (this.isActive && !this.isActive() && !this.flushingForTeardown) return
    this.enforceBounds()
    const payload = sanitizeJsonPayload(this.serializeMap())
    await this.orca.storage.set(TABLE_DISPLAY_STATE_STORAGE_KEY, payload as unknown as JsonValue)
    if (this.disposed) return
    if (this.isLiveDesktopHost()) {
      await writeHostConfigBackupPatch({ tableDisplayState: payload })
    }
  }

  private mergeLegacyTableEntry(
    tableKey: string,
    patch: Partial<TableDisplayStateEntry>,
    persistedKeys: ReadonlySet<string>
  ): void {
    const existing = this.entries.get(tableKey)
    const isPersisted = persistedKeys.has(tableKey)
    const combined = scrubSensitiveTableDisplayEntry({
      ...(patch ?? {}),
      ...(existing ?? {}),
      columnOrder:
        existing?.columnOrder && existing.columnOrder.length > 0
          ? existing.columnOrder
          : patch.columnOrder,
      hiddenColumns:
        isPersisted && existing?.hiddenColumns && existing.hiddenColumns.length > 0
          ? existing.hiddenColumns
          : mergeStringLists(existing?.hiddenColumns, patch.hiddenColumns),
      pinnedColumns:
        isPersisted && existing?.pinnedColumns && existing.pinnedColumns.length > 0
          ? existing.pinnedColumns
          : mergeStringLists(existing?.pinnedColumns, patch.pinnedColumns),
      columnWidths: {
        ...(patch.columnWidths ?? {}),
        ...(existing?.columnWidths ?? {}),
      },
      updatedAt: existing?.updatedAt || patch.updatedAt || Date.now(),
      revision: Math.max(1, existing?.revision ?? 1),
    })
    if (combined) {
      this.entries.set(tableKey, combined)
      this.recordRevisionSnapshot(tableKey, combined)
    }
  }

  private async runOneTimeLegacyMigration(
    backup: Awaited<ReturnType<typeof readHostConfigBackup>>,
    persistedKeys: ReadonlySet<string>
  ): Promise<{ alreadyMigrated: boolean; migratedAny: boolean; readFailed: boolean }> {
    const alreadyMigrated = (await this.orca.storage.get(TABLE_DISPLAY_MIGRATED_STORAGE_KEY)) === true
    if (alreadyMigrated) return { alreadyMigrated: true, migratedAny: false, readFailed: false }

    let migratedAny = false
    let readFailed = false
    const now = Date.now()

    // 1. Migrate Studio columnConfigByTable
    let rawStudio: unknown = null
    try {
      rawStudio = await this.orca.storage.get('datanoa.studioViewState')
    } catch {
      readFailed = true
    }
    const studioCandidates = [
      isPlainRecord(rawStudio) ? rawStudio : null,
      isPlainRecord(backup?.studioViewState) ? backup.studioViewState : null,
    ]
    for (const vs of studioCandidates) {
      if (!vs || !isPlainRecord(vs.columnConfigByTable)) continue
      for (const [rawTableKey, rawCfg] of Object.entries(vs.columnConfigByTable)) {
        if (!rawTableKey || !isPlainRecord(rawCfg)) continue
        const tableKey = normalizeMigratedTableDisplayKey(rawTableKey)
        const hiddenColumns = toStringArray(rawCfg.hidden)
        const pinnedColumns = toStringArray(rawCfg.pinned)
        if (hiddenColumns.length > 0 || pinnedColumns.length > 0) {
          this.mergeLegacyTableEntry(
            tableKey,
            {
              hiddenColumns,
              pinnedColumns,
              updatedAt: now,
            },
            persistedKeys
          )
          migratedAny = true
        }
      }
    }

    // 2. Migrate Side Panel hiddenColsByTable / pinnedColsByTable / columnWidthsByTable
    let rawPanel: unknown = null
    try {
      rawPanel = await this.orca.storage.get('datanoa.panelViewState')
    } catch {
      readFailed = true
    }
    const panelCandidates = [
      isPlainRecord(rawPanel) ? rawPanel : null,
      isPlainRecord(backup?.panelViewState) ? backup.panelViewState : null,
    ]
    for (const vs of panelCandidates) {
      if (!vs) continue
      if (isPlainRecord(vs.hiddenColsByTable)) {
        for (const [rawTableKey, cols] of Object.entries(vs.hiddenColsByTable)) {
          const hiddenColumns = toStringArray(cols)
          if (rawTableKey && hiddenColumns.length > 0) {
            this.mergeLegacyTableEntry(
              normalizeMigratedTableDisplayKey(rawTableKey),
              { hiddenColumns, updatedAt: now },
              persistedKeys
            )
            migratedAny = true
          }
        }
      }
      if (isPlainRecord(vs.pinnedColsByTable)) {
        for (const [rawTableKey, cols] of Object.entries(vs.pinnedColsByTable)) {
          const pinnedColumns = toStringArray(cols)
          if (rawTableKey && pinnedColumns.length > 0) {
            this.mergeLegacyTableEntry(
              normalizeMigratedTableDisplayKey(rawTableKey),
              { pinnedColumns, updatedAt: now },
              persistedKeys
            )
            migratedAny = true
          }
        }
      }
      if (isPlainRecord(vs.columnWidthsByTable)) {
        for (const [rawTableKey, widths] of Object.entries(vs.columnWidthsByTable)) {
          if (!rawTableKey || !isPlainRecord(widths)) continue
          const cleanWidths = sanitizeColumnWidths(widths)
          if (Object.keys(cleanWidths).length > 0) {
            this.mergeLegacyTableEntry(
              normalizeMigratedTableDisplayKey(rawTableKey),
              { columnWidths: cleanWidths, updatedAt: now },
              persistedKeys
            )
            migratedAny = true
          }
        }
      }
    }

    return { alreadyMigrated: false, migratedAny, readFailed }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    if (this.loadPromise) return await this.loadPromise

    this.loadPromise = (async () => {
      if (this.beforeLoad) {
        await this.beforeLoad().catch(() => {})
      }
      if (this.isEvicted()) return

      let rawStore: unknown = null
      let rawStoreReadFailed = false
      try {
        rawStore = await this.orca.storage.get(TABLE_DISPLAY_STATE_STORAGE_KEY)
      } catch {
        rawStoreReadFailed = true
      }
      let backup: Awaited<ReturnType<typeof readHostConfigBackup>> = null
      if ((!isPlainRecord(rawStore) || Object.keys(rawStore).length === 0) && this.isLiveDesktopHost()) {
        backup = await readHostConfigBackup()
        if (isPlainRecord(backup?.tableDisplayState)) {
          rawStore = backup.tableDisplayState as unknown as JsonValue
        }
      }

      const persistedKeys = new Set<string>()
      if (isPlainRecord(rawStore)) {
        for (const [tableKey, rawEntry] of Object.entries(rawStore)) {
          if (!tableKey) continue
          const clean = scrubSensitiveTableDisplayEntry(rawEntry)
          if (clean) {
            this.entries.set(tableKey, clean)
            this.recordRevisionSnapshot(tableKey, clean)
            persistedKeys.add(tableKey)
          }
        }
      }

      if (!backup && this.isLiveDesktopHost()) {
        backup = await readHostConfigBackup()
      }
      const { alreadyMigrated, migratedAny, readFailed } = await this.runOneTimeLegacyMigration(
        backup,
        persistedKeys
      )
      this.enforceBounds()
      if (this.isEvicted()) return
      this.loaded = true
      if (!alreadyMigrated) {
        if (migratedAny) {
          try {
            await this.persistNow()
            if (!this.isEvicted() && !readFailed && !rawStoreReadFailed) {
              await this.orca.storage.set(TABLE_DISPLAY_MIGRATED_STORAGE_KEY, true).catch(() => {})
            }
          } catch {
            // Do not set migration marker until migrated state persists successfully
          }
        } else if (!readFailed && !rawStoreReadFailed) {
          await this.orca.storage.set(TABLE_DISPLAY_MIGRATED_STORAGE_KEY, true).catch(() => {})
        }
      }
    })()

    try {
      await this.loadPromise
    } finally {
      this.loadPromise = null
    }
  }

  async get(tableKey: string): Promise<{
    tableKey: string
    entry: TableDisplayStateEntry | null
    revision: number
  }> {
    await this.ensureLoaded()
    const key = typeof tableKey === 'string' ? tableKey.trim() : ''
    if (!key || this.isEvicted()) {
      return { tableKey: key, entry: null, revision: 0 }
    }
    const found = this.entries.get(key)
    if (!found) {
      return { tableKey: key, entry: null, revision: 0 }
    }
    this.touchEntry(key, found)
    return {
      tableKey: key,
      entry: sanitizeJsonPayload(found),
      revision: found.revision,
    }
  }

  private pruneBroadcastWindow(now = Date.now()): void {
    const cutoff = now - TABLE_DISPLAY_BROADCAST_WINDOW_MS
    while (this.broadcastTimestamps.length > 0 && this.broadcastTimestamps[0] <= cutoff) {
      this.broadcastTimestamps.shift()
    }
  }

  private remainingBroadcastBudget(now = Date.now()): number {
    this.pruneBroadcastWindow(now)
    return Math.max(0, MAX_TABLE_DISPLAY_BROADCASTS_PER_10S - this.broadcastTimestamps.length)
  }

  private nextBroadcastDelayMs(now = Date.now()): number {
    if (this.remainingBroadcastBudget(now) > 0) {
      return DELTA_COALESCE_MS
    }
    const oldestTs = this.broadcastTimestamps[0] ?? now
    return Math.max(DELTA_COALESCE_MS, oldestTs + TABLE_DISPLAY_BROADCAST_WINDOW_MS - now + 1)
  }

  private postBoundedBroadcast(payload: TableDisplayChangedPayload): boolean {
    const clean = sanitizeJsonPayload(payload)
    if (measureJsonBytes(clean) > MAX_TABLE_DISPLAY_BROADCAST_BYTES) {
      return false
    }
    this.broadcastTimestamps.push(Date.now())
    try {
      this.orca.panels?.post?.('ui.tableDisplayState.changed', clean)
    } catch {
      // Ignore broadcast errors in minimal test hosts
    }
    return true
  }

  private emitDeltaNow(
    tableKey: string,
    entry: TableDisplayStateEntry | null,
    revision: number
  ): void {
    let safeEntry = entry ? sanitizeJsonPayload(entry) : null
    let payload = sanitizeJsonPayload({ tableKey, entry: safeEntry, revision })
    if (safeEntry && measureJsonBytes(payload) > MAX_TABLE_DISPLAY_BROADCAST_BYTES) {
      safeEntry = {
        ...safeEntry,
        highlightRules: safeEntry.highlightRules?.slice(0, 10),
      }
      payload = sanitizeJsonPayload({ tableKey, entry: safeEntry, revision })
    }
    if (safeEntry && measureJsonBytes(payload) > MAX_TABLE_DISPLAY_BROADCAST_BYTES) {
      safeEntry = {
        updatedAt: safeEntry.updatedAt,
        revision: safeEntry.revision,
      }
      payload = sanitizeJsonPayload({ tableKey, entry: safeEntry, revision })
    }
    if (safeEntry && measureJsonBytes(payload) > MAX_TABLE_DISPLAY_BROADCAST_BYTES) {
      payload = sanitizeJsonPayload({ tableKey, entry: null, revision })
    }
    this.postBoundedBroadcast(payload)
  }

  private clearDeltaCoalesceTimer(): void {
    if (this.deltaCoalesceTimer !== null) {
      clearTimeout(this.deltaCoalesceTimer)
      this.deltaCoalesceTimer = null
    }
  }

  private scheduleDeltaCoalesceTimer(): void {
    if (this.disposed || this.deltaCoalesceTimer !== null) return
    const delayMs = this.nextBroadcastDelayMs()
    this.deltaCoalesceTimer = setTimeout(() => {
      this.deltaCoalesceTimer = null
      this.flushPendingDeltas(false)
    }, delayMs)
    if (typeof this.deltaCoalesceTimer.unref === 'function') {
      this.deltaCoalesceTimer.unref()
    }
  }

  private flushPendingDeltas(drainAll = true): void {
    this.clearDeltaCoalesceTimer()
    if (this.pendingDeltaBroadcasts.size === 0 && this.pendingBulkResets.length === 0) return
    if (this.isActive && !this.isActive() && !this.flushingForTeardown) {
      this.pendingDeltaBroadcasts.clear()
      this.pendingBulkResets.length = 0
      return
    }
    const now = Date.now()
    const remaining = this.remainingBroadcastBudget(now)
    const maxToSend = drainAll
      ? remaining
      : Math.min(DELTA_MAX_PER_TICK, remaining)
    let sent = 0
    while (sent < maxToSend && this.pendingBulkResets.length > 0) {
      const bulkPayload = this.pendingBulkResets.shift()
      if (!bulkPayload) break
      if (this.postBoundedBroadcast(bulkPayload)) {
        sent += 1
      }
    }
    for (const [k, item] of Array.from(this.pendingDeltaBroadcasts.entries())) {
      if (sent >= maxToSend) break
      this.pendingDeltaBroadcasts.delete(k)
      this.emitDeltaNow(k, item.entry, item.revision)
      sent += 1
    }
    this.deltaWindowStartAt = now
    this.deltaWindowEmitCount = sent
    if (
      (this.pendingDeltaBroadcasts.size > 0 || this.pendingBulkResets.length > 0) &&
      !this.disposed &&
      !this.tearingDown &&
      (!this.isActive || this.isActive())
    ) {
      this.scheduleDeltaCoalesceTimer()
    }
  }

  private broadcastDelta(
    tableKey: string,
    entry: TableDisplayStateEntry | null,
    revision: number
  ): void {
    if (this.isEvicted()) return
    const now = Date.now()
    if (now - this.deltaWindowStartAt >= DELTA_RATE_WINDOW_MS) {
      this.deltaWindowStartAt = now
      this.deltaWindowEmitCount = 0
    }
    if (
      this.remainingBroadcastBudget(now) > 0 &&
      this.deltaWindowEmitCount < DELTA_BURST_IMMEDIATE_LIMIT &&
      this.pendingDeltaBroadcasts.size === 0 &&
      this.pendingBulkResets.length === 0 &&
      this.deltaCoalesceTimer === null
    ) {
      this.deltaWindowEmitCount += 1
      this.emitDeltaNow(tableKey, entry, revision)
      return
    }
    this.pendingDeltaBroadcasts.delete(tableKey)
    this.pendingDeltaBroadcasts.set(tableKey, { entry, revision })
    while (this.pendingDeltaBroadcasts.size > MAX_TABLE_DISPLAY_ENTRIES) {
      const oldest = this.pendingDeltaBroadcasts.keys().next().value
      if (oldest === undefined) break
      this.pendingDeltaBroadcasts.delete(oldest)
    }
    this.scheduleDeltaCoalesceTimer()
  }

  async patch(input: {
    tableKey: string
    patch: Partial<Omit<TableDisplayStateEntry, 'updatedAt' | 'revision'>>
    baseRevision?: number
  }): Promise<{
    ok: boolean
    tableKey: string
    entry: TableDisplayStateEntry | null
    revision: number
  }> {
    await this.ensureLoaded()
    const key = typeof input?.tableKey === 'string' ? input.tableKey.trim() : ''
    if (!key || this.isEvicted()) {
      return { ok: false, tableKey: key, entry: null, revision: 0 }
    }

    const current = this.entries.get(key) ?? null
    const now = Date.now()
    const floorRev = this.getFloorRevision(key)
    let nextEntry: TableDisplayStateEntry | null = null

    if (
      typeof input.baseRevision === 'number' &&
      current !== null &&
      input.baseRevision !== current.revision
    ) {
      const baseEntry = this.revisionHistory.get(key)?.get(input.baseRevision) ?? null
      const localSeed: TableDisplayStateEntry = {
        ...(baseEntry ?? { updatedAt: 0, revision: input.baseRevision }),
        ...input.patch,
        updatedAt: now,
        revision: Math.max(input.baseRevision, floorRev) + 1,
      }
      const localClean = normalizeTableDisplayStateEntry(localSeed)
      const rebased = rebaseTableDisplayStateEntry(baseEntry, localClean, current)
      nextEntry = rebased ? scrubSensitiveTableDisplayEntry(rebased) : null
    } else {
      const nextRevision = floorRev + 1
      nextEntry = scrubSensitiveTableDisplayEntry({
        ...(current ?? {}),
        ...input.patch,
        updatedAt: now,
        revision: nextRevision,
      })
    }

    if (nextEntry && measureJsonBytes({ [key]: nextEntry }) > MAX_TABLE_DISPLAY_BYTES) {
      nextEntry = scrubSensitiveTableDisplayEntry({
        ...nextEntry,
        highlightRules: nextEntry.highlightRules?.slice(0, 10),
      })
    }

    const outRevision = nextEntry ? nextEntry.revision : floorRev + 1
    this.recordMaxRevision(key, outRevision)

    if (nextEntry) {
      this.touchEntry(key, nextEntry)
      this.recordRevisionSnapshot(key, nextEntry)
    } else {
      this.entries.delete(key)
      this.revisionHistory.delete(key)
    }

    this.writer.schedule()
    this.broadcastDelta(key, nextEntry, outRevision)

    return {
      ok: true,
      tableKey: key,
      entry: nextEntry ? sanitizeJsonPayload(nextEntry) : null,
      revision: outRevision,
    }
  }

  async reset(input: { tableKey?: string; connectionId?: string }): Promise<{
    ok: boolean
    removedCount: number
  }> {
    await this.ensureLoaded()
    if (this.isEvicted()) {
      return { ok: false, removedCount: 0 }
    }
    const targetKey = typeof input?.tableKey === 'string' ? input.tableKey.trim() : ''
    const targetConnId = typeof input?.connectionId === 'string' ? input.connectionId.trim() : ''
    const removed: Array<{ key: string; rev: number }> = []

    if (targetKey) {
      const existing = this.entries.get(targetKey)
      if (existing) {
        const nextRev = Math.max(existing.revision, this.getFloorRevision(targetKey)) + 1
        this.recordMaxRevision(targetKey, nextRev)
        this.entries.delete(targetKey)
        this.revisionHistory.delete(targetKey)
        removed.push({ key: targetKey, rev: nextRev })
      }
    } else if (targetConnId) {
      for (const [k, v] of Array.from(this.entries.entries())) {
        if (belongsToConnectionKey(k, targetConnId)) {
          const nextRev = Math.max(v.revision, this.getFloorRevision(k)) + 1
          this.recordMaxRevision(k, nextRev)
          this.entries.delete(k)
          this.revisionHistory.delete(k)
          removed.push({ key: k, rev: nextRev })
        }
      }
    } else {
      for (const [k, v] of Array.from(this.entries.entries())) {
        const nextRev = Math.max(v.revision, this.getFloorRevision(k)) + 1
        this.recordMaxRevision(k, nextRev)
        this.entries.delete(k)
        this.revisionHistory.delete(k)
        removed.push({ key: k, rev: nextRev })
      }
    }

    if (removed.length > 0) {
      for (const item of removed) {
        this.pendingDeltaBroadcasts.delete(item.key)
      }
      if (!targetKey && !targetConnId) {
        this.pendingBulkResets.length = 0
      } else if (targetConnId) {
        for (let i = this.pendingBulkResets.length - 1; i >= 0; i -= 1) {
          if (this.pendingBulkResets[i]?.connectionId === targetConnId) {
            this.pendingBulkResets.splice(i, 1)
          }
        }
      }
      this.writer.schedule()
      if (removed.length === 1) {
        this.broadcastDelta(removed[0].key, null, removed[0].rev)
      } else {
        this.broadcastBulkReset(removed, targetConnId || undefined)
      }
    }

    return { ok: true, removedCount: removed.length }
  }

  private buildSafeBulkResetPayload(
    baseTableKey: string,
    connectionId: string | undefined,
    revision: number,
    batchKeys?: string[],
    batchRevs?: Record<string, number>
  ): TableDisplayChangedPayload {
    const withKeys: TableDisplayChangedPayload = sanitizeJsonPayload({
      tableKey: baseTableKey,
      bulkReset: true,
      ...(connectionId ? { connectionId } : { all: true }),
      entry: null,
      revision,
      ...(batchKeys ? { tableKeys: batchKeys, revisions: batchRevs } : {}),
    })
    if (measureJsonBytes(withKeys) <= MAX_TABLE_DISPLAY_BROADCAST_BYTES) {
      return withKeys
    }
    const withoutKeys: TableDisplayChangedPayload = sanitizeJsonPayload({
      tableKey: baseTableKey,
      bulkReset: true,
      ...(connectionId ? { connectionId } : { all: true }),
      entry: null,
      revision,
    })
    if (measureJsonBytes(withoutKeys) <= MAX_TABLE_DISPLAY_BROADCAST_BYTES) {
      return withoutKeys
    }
    return sanitizeJsonPayload({
      tableKey: '*',
      bulkReset: true,
      all: true,
      entry: null,
      revision,
    })
  }

  private broadcastBulkReset(
    removed: ReadonlyArray<{ key: string; rev: number }>,
    connectionId?: string
  ): void {
    const baseTableKey = connectionId ? `${connectionId}:*` : '*'
    const payloads: TableDisplayChangedPayload[] = []
    let batchKeys: string[] = []
    let batchRevs: Record<string, number> = {}
    let maxRev = 0

    const pushBatch = (omitKeys = false): void => {
      if (batchKeys.length === 0 && !omitKeys) return
      payloads.push(
        this.buildSafeBulkResetPayload(
          baseTableKey,
          connectionId,
          maxRev,
          omitKeys ? undefined : batchKeys,
          omitKeys ? undefined : batchRevs
        )
      )
      batchKeys = []
      batchRevs = {}
    }

    for (const item of removed) {
      if (item.rev > maxRev) maxRev = item.rev
      const nextKeys = [...batchKeys, item.key]
      const nextRevs = { ...batchRevs, [item.key]: item.rev }
      const candidate = sanitizeJsonPayload({
        tableKey: baseTableKey,
        bulkReset: true,
        ...(connectionId ? { connectionId } : { all: true }),
        entry: null,
        revision: maxRev,
        tableKeys: nextKeys,
        revisions: nextRevs,
      })
      if (measureJsonBytes(candidate) > MAX_TABLE_DISPLAY_BROADCAST_BYTES) {
        if (batchKeys.length > 0) {
          pushBatch(false)
          batchKeys = [item.key]
          batchRevs = { [item.key]: item.rev }
          const singleCandidate = sanitizeJsonPayload({
            tableKey: baseTableKey,
            bulkReset: true,
            ...(connectionId ? { connectionId } : { all: true }),
            entry: null,
            revision: item.rev,
            tableKeys: batchKeys,
            revisions: batchRevs,
          })
          if (measureJsonBytes(singleCandidate) > MAX_TABLE_DISPLAY_BROADCAST_BYTES) {
            pushBatch(true)
          }
        } else {
          pushBatch(true)
        }
      } else {
        batchKeys = nextKeys
        batchRevs = nextRevs
      }
    }
    if (batchKeys.length > 0) {
      pushBatch(false)
    }
    if (payloads.length === 0) return

    const now = Date.now()
    if (now - this.deltaWindowStartAt >= DELTA_RATE_WINDOW_MS) {
      this.deltaWindowStartAt = now
      this.deltaWindowEmitCount = 0
    }
    const remaining = this.remainingBroadcastBudget(now)
    if (this.pendingBulkResets.length === 0 && remaining > 0) {
      const immediateCount = Math.min(payloads.length, remaining)
      for (let i = 0; i < immediateCount; i += 1) {
        if (this.postBoundedBroadcast(payloads[i])) {
          this.deltaWindowEmitCount += 1
        }
      }
      if (immediateCount < payloads.length) {
        this.pendingBulkResets.push(...payloads.slice(immediateCount))
        while (this.pendingBulkResets.length > MAX_TABLE_DISPLAY_ENTRIES) {
          this.pendingBulkResets.shift()
        }
        this.scheduleDeltaCoalesceTimer()
      }
      return
    }

    this.pendingBulkResets.push(...payloads)
    while (this.pendingBulkResets.length > MAX_TABLE_DISPLAY_ENTRIES) {
      this.pendingBulkResets.shift()
    }
    this.scheduleDeltaCoalesceTimer()
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
      if (this.loadPromise) {
        await this.loadPromise.catch(() => {})
      }
      this.flushPendingDeltas(true)
      await this.writer.flush()
    } finally {
      this.flushingForTeardown = false
    }
  }

  dispose(): void {
    this.tearingDown = true
    this.flushPendingDeltas(true)
    this.clearDeltaCoalesceTimer()
    this.pendingDeltaBroadcasts.clear()
    this.pendingBulkResets.length = 0
    this.disposed = true
    this.writer.dispose()
    this.entries.clear()
    this.revisionHistory.clear()
    this.maxRevisionByKey.clear()
    this.globalRevisionFloor = 0
  }
}
