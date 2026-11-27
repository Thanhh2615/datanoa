import type {
  SchemaCatalogObjectsResult,
  SchemaErGraph,
  SchemaObject,
  TableDetails,
} from '../protocol'
import type { IDatabaseSession } from '../drivers/common/driver'
import {
  buildSchemaErGraphFromTableDetails,
  ER_LITE_FALLBACK_MAX_TABLES,
} from '../drivers/common/schema-er-graph'
import { reconstructTableDdl } from '../drivers/common/sql-tools'
import { WorkerSchemaMetadataCache } from './ai-sql-context'
import { createHostError, scrubCredentialsInText } from './worker-utils'

export interface SchemaCatalogSessionProvider {
  getSession(connectionId: string): Promise<IDatabaseSession>
  getActiveSessions?: () => Map<string, IDatabaseSession>
}

export interface SchemaCatalogOptions {
  sessionManager?: SchemaCatalogSessionProvider
}

interface ObjectsCatalogEntry {
  data: SchemaObject[]
  cachedAt: number
  generation: number
  revision: number
}

interface ErGraphCacheEntry {
  graph: SchemaErGraph
  cachedAt: number
}

interface InFlightSlot<T> {
  epoch: number
  promise: Promise<T>
  isRefresh: boolean
}

interface FollowUpSlot<T> {
  epoch: number
  started: boolean
  promise: Promise<T>
  run: () => Promise<T>
  resolve: (value: T) => void
  reject: (err: unknown) => void
}

interface CoalesceKeyState<T> {
  connectionId: string
  inFlight: InFlightSlot<T> | null
  followUp: FollowUpSlot<T> | null
}

const ER_FALLBACK_CONCURRENCY = 4
const MAX_FULL_DETAILS_PER_CONNECTION = 200

function normalizeSchemaExact(schema?: string): string {
  return typeof schema === 'string' ? schema.trim() : ''
}

function buildObjectsKey(connectionId: string, schema?: string): string {
  return JSON.stringify(['objects', connectionId, normalizeSchemaExact(schema)])
}

function buildTableKey(connectionId: string, table: string, schema?: string): string {
  return JSON.stringify(['table', connectionId, normalizeSchemaExact(schema), table.trim()])
}

function buildErKey(connectionId: string, schema?: string, includeViews = true): string {
  return JSON.stringify(['er', connectionId, normalizeSchemaExact(schema), includeViews ? 1 : 0])
}

function buildExactDetailKey(table: string, schema?: string): string {
  return JSON.stringify([normalizeSchemaExact(schema), table.trim()])
}

function createAbortError(message = 'Operation was cancelled'): Error & { code: string } {
  return createHostError('cancelled', message)
}

function createSessionClosedError(): Error & { code: string } {
  return createHostError('session_closed', 'Database session was closed during schema operation')
}

function isAbortSignalError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const rec = err as { name?: unknown; code?: unknown }
  return rec.name === 'AbortError' || rec.code === 'ABORT_ERR'
}

/**
 * Unified SchemaCatalog extending WorkerSchemaMetadataCache for Studio, Side Panel, ER Diagram, and AI:
 * - Atomic `getAiSnapshot()` (`{ snapshot, revision }`)
 * - Single-flight + 1-queued-follow-up coalescing (N concurrent refreshes <= 2 DB queries, never parallel)
 * - Epoch fencing across `invalidate()` / `onSessionClosed()`
 * - Detached DB fetches isolated from individual panel `AbortSignal`s
 * - `TableDetails` completeness tracking (`'lite' | 'full'`) preventing `'lite'` ER cache from masking `'full'`
 * - Stale-while-error semantics for `schema.listObjectsCatalog` (preserving cached data & generation)
 */
export class SchemaCatalog extends WorkerSchemaMetadataCache {
  private readonly sessionManager?: SchemaCatalogSessionProvider
  private readonly epochs = new Map<string, number>()
  private readonly detailEpochs = new Map<string, number>()
  private readonly objectsCatalog = new Map<string, ObjectsCatalogEntry>()
  private readonly erGraphs = new Map<string, ErGraphCacheEntry>()
  private readonly exactDetailsByConn = new Map<string, Map<string, TableDetails>>()
  private readonly verifiedDefaultSchemaByConn = new Map<string, string>()
  private readonly coalesceMap = new Map<string, CoalesceKeyState<unknown>>()
  private readonly closeRejectorsByConn = new Map<string, Set<(err: Error) => void>>()
  private generationCounter = 0
  private disposed = false

  constructor(options: SchemaCatalogOptions = {}) {
    super()
    this.sessionManager = options.sessionManager
  }

  private getEpoch(connectionId: string): number {
    return this.epochs.get(connectionId) ?? 0
  }

  private bumpEpoch(connectionId: string): number {
    const next = this.getEpoch(connectionId) + 1
    this.epochs.set(connectionId, next)
    return next
  }

  private getDetailEpoch(connectionId: string): number {
    return this.detailEpochs.get(connectionId) ?? 0
  }

  private bumpDetailEpoch(connectionId: string): number {
    const next = this.getDetailEpoch(connectionId) + 1
    this.detailEpochs.set(connectionId, next)
    return next
  }

  private clearCachedEntriesForConnection(connectionId: string): void {
    const objKeyPrefix = JSON.stringify(['objects', connectionId])
    const objPrefix = objKeyPrefix.slice(0, -1) + ','
    for (const key of Array.from(this.objectsCatalog.keys())) {
      if (key.startsWith(objPrefix)) {
        this.objectsCatalog.delete(key)
      }
    }
    const erPrefix = JSON.stringify(['er', connectionId]).slice(0, -1) + ','
    for (const key of Array.from(this.erGraphs.keys())) {
      if (key.startsWith(erPrefix)) {
        this.erGraphs.delete(key)
      }
    }
    this.exactDetailsByConn.delete(connectionId)
    this.verifiedDefaultSchemaByConn.delete(connectionId)
  }

  private invalidateDerivedForSchema(connectionId: string, schema?: string): void {
    this.bumpDetailEpoch(connectionId)
    super.invalidateSchemaDetails(connectionId, schema)
    const targetSchema = normalizeSchemaExact(schema)
    const erPrefix = JSON.stringify(['er', connectionId]).slice(0, -1) + ','
    for (const key of Array.from(this.erGraphs.keys())) {
      if (key.startsWith(erPrefix)) {
        this.erGraphs.delete(key)
      }
    }
    const exactMap = this.exactDetailsByConn.get(connectionId)
    if (exactMap) {
      if (!targetSchema) {
        exactMap.clear()
      } else {
        const schPrefix = JSON.stringify([targetSchema]).slice(0, -1) + ','
        for (const [k, det] of Array.from(exactMap.entries())) {
          if (k.startsWith(schPrefix) || normalizeSchemaExact(det.schema) === targetSchema) {
            exactMap.delete(k)
          }
        }
      }
    }
  }

  override setTableDetails(
    connectionId: string,
    details: TableDetails,
    options?: {
      requestedSchema?: string
      requestedTable?: string
      allowUnqualifiedAlias?: boolean
    }
  ): void {
    if (!connectionId || !details?.name) return
    super.setTableDetails(connectionId, details)
    let exactMap = this.exactDetailsByConn.get(connectionId)
    if (!exactMap) {
      exactMap = new Map()
      this.exactDetailsByConn.set(connectionId, exactMap)
    }
    const incomingCompleteness = details.completeness === 'lite' ? 'lite' : 'full'
    const normalizedDetails: TableDetails =
      details.completeness === incomingCompleteness
        ? details
        : { ...details, completeness: incomingCompleteness }
    const detailsSchema = normalizeSchemaExact(details.schema)
    const requestedSchema = normalizeSchemaExact(options?.requestedSchema)
    const verifiedDefault = this.verifiedDefaultSchemaByConn.get(connectionId)
    const keys: string[] = []
    const pushKey = (k: string) => {
      if (!keys.includes(k)) keys.push(k)
    }
    if (!detailsSchema) {
      if (requestedSchema) {
        pushKey(buildExactDetailKey(details.name, requestedSchema))
      } else {
        pushKey(buildExactDetailKey(details.name))
      }
    } else {
      pushKey(buildExactDetailKey(details.name, details.schema))
      if (requestedSchema && requestedSchema !== detailsSchema) {
        pushKey(buildExactDetailKey(details.name, requestedSchema))
      }
      if (
        options?.allowUnqualifiedAlias === true ||
        (Boolean(verifiedDefault) && detailsSchema === verifiedDefault)
      ) {
        pushKey(buildExactDetailKey(details.name))
      }
    }
    if (!requestedSchema && options?.requestedTable && options.requestedTable.trim()) {
      pushKey(buildExactDetailKey(options.requestedTable))
    }
    for (const k of keys) {
      const prev = exactMap.get(k)
      if (prev && prev.completeness !== 'lite' && incomingCompleteness === 'lite') {
        continue
      }
      exactMap.delete(k)
      exactMap.set(k, normalizedDetails)
      while (exactMap.size > MAX_FULL_DETAILS_PER_CONNECTION) {
        const oldest = exactMap.keys().next().value
        if (oldest === undefined) break
        exactMap.delete(oldest)
      }
    }
  }

  private rejectWaitersForConnection(connectionId: string, err: Error): void {
    const waiters = this.closeRejectorsByConn.get(connectionId)
    if (!waiters) return
    this.closeRejectorsByConn.delete(connectionId)
    for (const reject of Array.from(waiters)) {
      try {
        reject(err)
      } catch {
        // Ignore waiter rejection errors
      }
    }
  }

  /**
   * Invalidates cached schema data for `connectionId`, bumps the epoch fence,
   * and triggers `session.clearSchemaCache?.()` on any active session.
   */
  invalidate(connectionId: string): void {
    if (!connectionId) return
    this.bumpEpoch(connectionId)
    this.bumpDetailEpoch(connectionId)
    super.invalidateConnection(connectionId)
    this.clearCachedEntriesForConnection(connectionId)
    const activeSession = this.sessionManager?.getActiveSessions?.().get(connectionId)
    if (activeSession && typeof activeSession.clearSchemaCache === 'function') {
      try {
        activeSession.clearSchemaCache()
      } catch {
        // Ignore driver cache clear errors
      }
    }
  }

  override invalidateConnection(connectionId: string): void {
    this.invalidate(connectionId)
  }

  /**
   * Cancels in-flight catalog callers for a closed session and invalidates its epoch.
   */
  onSessionClosed(connectionId: string): void {
    if (!connectionId) return
    this.invalidate(connectionId)
    for (const [key, state] of Array.from(this.coalesceMap.entries())) {
      if (state.connectionId !== connectionId) continue
      if (state.followUp) {
        const next = state.followUp
        state.followUp = null
        next.reject(createSessionClosedError())
      }
      if (!state.inFlight) {
        this.coalesceMap.delete(key)
      }
    }
    this.rejectWaitersForConnection(connectionId, createSessionClosedError())
  }

  private async raceDetached<T>(
    connectionId: string,
    promise: Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    if (this.disposed) {
      throw createAbortError('Schema catalog has been disposed')
    }
    if (signal?.aborted) {
      throw createAbortError('Request aborted')
    }

    let closeRejector: ((err: Error) => void) | null = null
    let abortListener: (() => void) | null = null

    const closePromise = new Promise<never>((_, reject) => {
      closeRejector = reject
      let set = this.closeRejectorsByConn.get(connectionId)
      if (!set) {
        set = new Set()
        this.closeRejectorsByConn.set(connectionId, set)
      }
      set.add(reject)
    })

    const racers: Promise<T>[] = [promise, closePromise]

    if (signal) {
      const abortPromise = new Promise<never>((_, reject) => {
        abortListener = () => reject(createAbortError('Request aborted'))
        signal.addEventListener('abort', abortListener, { once: true })
      })
      racers.push(abortPromise)
    }

    try {
      return await Promise.race(racers)
    } finally {
      if (closeRejector) {
        this.closeRejectorsByConn.get(connectionId)?.delete(closeRejector)
      }
      if (signal && abortListener) {
        signal.removeEventListener('abort', abortListener)
      }
    }
  }

  private getOrCreateCoalesceState<T>(key: string, connectionId: string): CoalesceKeyState<T> {
    let state = this.coalesceMap.get(key) as CoalesceKeyState<T> | undefined
    if (!state) {
      state = { connectionId, inFlight: null, followUp: null }
      this.coalesceMap.set(key, state as CoalesceKeyState<unknown>)
    }
    return state
  }

  private launchSlot<T>(
    key: string,
    state: CoalesceKeyState<T>,
    epoch: number,
    isRefresh: boolean,
    fn: () => Promise<T>
  ): Promise<T> {
    const promise = (async () => {
      try {
        return await fn()
      } finally {
        state.inFlight = null
        if (state.followUp) {
          const next = state.followUp
          state.followUp = null
          if (this.disposed) {
            this.coalesceMap.delete(key)
            next.reject(createAbortError('Schema catalog disposed'))
          } else if (this.getEpoch(state.connectionId) !== next.epoch) {
            this.coalesceMap.delete(key)
            next.reject(createSessionClosedError())
          } else {
            next.started = true
            const chained = this.launchSlot(key, state, next.epoch, true, next.run)
            chained.then(next.resolve, next.reject)
          }
        } else {
          this.coalesceMap.delete(key)
        }
      }
    })()

    state.inFlight = { epoch, promise, isRefresh }
    return promise
  }

  private queueFollowUp<T>(
    state: CoalesceKeyState<T>,
    epoch: number,
    fn: () => Promise<T>
  ): Promise<T> {
    let resolve: (val: T) => void = () => {}
    let reject: (err: unknown) => void = () => {}
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })
    // Prevent unhandled rejection if caller aborts before follow-up settles
    promise.catch(() => {})
    state.followUp = {
      epoch,
      started: false,
      promise,
      run: fn,
      resolve,
      reject,
    }
    return promise
  }

  private async runCoalesced<T>(params: {
    connectionId: string
    key: string
    forceRefresh: boolean
    signal?: AbortSignal
    readCached: () => T | undefined
    fetchFresh: (epoch: number) => Promise<T>
  }): Promise<T> {
    const { connectionId, key, forceRefresh, signal, readCached, fetchFresh } = params
    if (signal?.aborted) {
      throw createAbortError('Request aborted')
    }
    if (this.disposed) {
      throw createAbortError('Schema catalog has been disposed')
    }

    if (!forceRefresh) {
      const cached = readCached()
      if (cached !== undefined) {
        return cached
      }
    }

    const currentEpoch = this.getEpoch(connectionId)
    const state = this.getOrCreateCoalesceState<T>(key, connectionId)

    if (!forceRefresh) {
      if (state.inFlight) {
        if (state.inFlight.epoch === currentEpoch) {
          return await this.raceDetached(connectionId, state.inFlight.promise, signal)
        }
        // Old epoch is in flight: chain AFTER old epoch settles (never run in parallel)
        if (state.followUp && !state.followUp.started && state.followUp.epoch === currentEpoch) {
          return await this.raceDetached(connectionId, state.followUp.promise, signal)
        }
        if (!state.followUp) {
          const queued = this.queueFollowUp(state, currentEpoch, async () => {
            const cachedNow = readCached()
            if (cachedNow !== undefined && this.getEpoch(connectionId) === currentEpoch) {
              return cachedNow
            }
            return await fetchFresh(currentEpoch)
          })
          return await this.raceDetached(connectionId, queued, signal)
        }
        await this.raceDetached(
          connectionId,
          state.inFlight.promise.then(
            () => undefined,
            () => undefined
          ),
          signal
        )
        return await this.runCoalesced(params)
      }

      const promise = this.launchSlot(key, state, currentEpoch, false, () =>
        fetchFresh(currentEpoch)
      )
      return await this.raceDetached(connectionId, promise, signal)
    }

    // forceRefresh === true: join !started follow-up or queue 1 follow-up
    if (!state.inFlight) {
      const promise = this.launchSlot(key, state, currentEpoch, true, () =>
        fetchFresh(currentEpoch)
      )
      return await this.raceDetached(connectionId, promise, signal)
    }

    if (state.followUp && !state.followUp.started && state.followUp.epoch === currentEpoch) {
      return await this.raceDetached(connectionId, state.followUp.promise, signal)
    }

    if (!state.followUp) {
      const queued = this.queueFollowUp(state, currentEpoch, () => fetchFresh(currentEpoch))
      return await this.raceDetached(connectionId, queued, signal)
    }

    await this.raceDetached(
      connectionId,
      state.inFlight.promise.then(
        () => undefined,
        () => undefined
      ),
      signal
    )
    return await this.runCoalesced(params)
  }

  private async resolveSession(connectionId: string): Promise<IDatabaseSession> {
    if (!this.sessionManager) {
      throw createHostError('invalid_params', 'SessionManager is not configured on SchemaCatalog')
    }
    return await this.sessionManager.getSession(connectionId)
  }

  private storeObjectsResult(
    connectionId: string,
    schema: string | undefined,
    objects: SchemaObject[],
    fetchEpoch: number
  ): ObjectsCatalogEntry {
    const key = buildObjectsKey(connectionId, schema)
    const now = Date.now()
    if (this.disposed || this.getEpoch(connectionId) !== fetchEpoch) {
      return {
        data: objects,
        cachedAt: now,
        generation: this.generationCounter,
        revision: this.getConnectionRevision(connectionId),
      }
    }
    super.setObjects(connectionId, objects, schema)
    const revision = this.getConnectionRevision(connectionId)
    const generation = ++this.generationCounter
    const entry: ObjectsCatalogEntry = {
      data: objects,
      cachedAt: now,
      generation,
      revision,
    }
    this.objectsCatalog.set(key, entry)
    return entry
  }

  /**
   * Lists schema objects returning `SchemaObject[]` and throwing on errors (legacy parity).
   */
  async listObjects(
    connectionId: string,
    schema?: string,
    options?: { forceRefresh?: boolean; signal?: AbortSignal }
  ): Promise<SchemaObject[]> {
    const key = buildObjectsKey(connectionId, schema)
    const forceRefresh = Boolean(options?.forceRefresh)
    const entry = await this.runCoalesced<ObjectsCatalogEntry>({
      connectionId,
      key,
      forceRefresh,
      signal: options?.signal,
      readCached: () => this.objectsCatalog.get(key),
      fetchFresh: async (fetchEpoch) => {
        const session = await this.resolveSession(connectionId)
        if (forceRefresh && typeof session.clearSchemaCache === 'function') {
          session.clearSchemaCache()
        }
        const objects = await session.listObjects(schema)
        if (forceRefresh && !this.disposed && this.getEpoch(connectionId) === fetchEpoch) {
          this.invalidateDerivedForSchema(connectionId, schema)
        }
        return this.storeObjectsResult(connectionId, schema, objects, fetchEpoch)
      },
    })
    return entry.data
  }

  /**
   * Lists schema objects with stale-while-error metadata (`{ data, stale, staleReason, cachedAt, revision }`).
   * On refresh failure when cached data exists, preserves cached data and generation unchanged.
   */
  async listObjectsCatalog(
    connectionId: string,
    schema?: string,
    options?: { forceRefresh?: boolean; signal?: AbortSignal }
  ): Promise<SchemaCatalogObjectsResult> {
    const key = buildObjectsKey(connectionId, schema)
    const forceRefresh = Boolean(options?.forceRefresh)
    try {
      const entry = await this.runCoalesced<ObjectsCatalogEntry>({
        connectionId,
        key,
        forceRefresh,
        signal: options?.signal,
        readCached: () => this.objectsCatalog.get(key),
        fetchFresh: async (fetchEpoch) => {
          const session = await this.resolveSession(connectionId)
          if (forceRefresh && typeof session.clearSchemaCache === 'function') {
            session.clearSchemaCache()
          }
          const objects = await session.listObjects(schema)
          if (forceRefresh && !this.disposed && this.getEpoch(connectionId) === fetchEpoch) {
            this.invalidateDerivedForSchema(connectionId, schema)
          }
          return this.storeObjectsResult(connectionId, schema, objects, fetchEpoch)
        },
      })
      return {
        data: entry.data,
        stale: false,
        cachedAt: entry.cachedAt,
        revision: entry.revision,
        generation: entry.generation,
      }
    } catch (err: unknown) {
      if (options?.signal?.aborted || isAbortSignalError(err)) {
        throw err
      }
      const errRec = err as { code?: unknown } | null
      if (errRec && (errRec.code === 'cancelled' || errRec.code === 'session_closed')) {
        throw err
      }
      const cached = this.objectsCatalog.get(key)
      if (cached) {
        const rawMsg = err instanceof Error ? err.message : String(err)
        return {
          data: cached.data,
          stale: true,
          staleReason: scrubCredentialsInText(rawMsg),
          cachedAt: cached.cachedAt,
          revision: cached.revision,
          generation: cached.generation,
        }
      }
      throw err
    }
  }

  private lookupFullTableDetails(
    connectionId: string,
    table: string,
    schema?: string
  ): TableDetails | undefined {
    const exactMap = this.exactDetailsByConn.get(connectionId)
    if (!exactMap) return undefined
    const hit = exactMap.get(buildExactDetailKey(table, schema))
    if (!hit || hit.completeness === 'lite') {
      return undefined
    }
    return hit
  }

  private async resolveVerifiedDefaultSchema(
    connectionId: string,
    session: IDatabaseSession,
    fetchEpoch: number
  ): Promise<string | undefined> {
    const cached = this.verifiedDefaultSchemaByConn.get(connectionId)
    if (cached) return cached
    if (typeof session.listSchemas !== 'function') return undefined
    try {
      const res = await session.listSchemas()
      const def = normalizeSchemaExact(res?.defaultSchema)
      if (def && !this.disposed && this.getEpoch(connectionId) === fetchEpoch) {
        this.verifiedDefaultSchemaByConn.set(connectionId, def)
        return def
      }
    } catch {
      // Ignore schema listing error; fail closed by not caching unqualified alias
    }
    return undefined
  }

  /**
   * Fetches full `TableDetails` for `(table, schema)`, automatically upgrading any `'lite'`
   * ER-fallback entry to `'full'` and populating DDL if missing.
   */
  async getTableDetails(
    connectionId: string,
    table: string,
    schema?: string,
    options?: { forceRefresh?: boolean; signal?: AbortSignal }
  ): Promise<TableDetails> {
    const key = buildTableKey(connectionId, table, schema)
    const requestedSchema = normalizeSchemaExact(schema)
    const forceRefresh = Boolean(options?.forceRefresh)
    return await this.runCoalesced<TableDetails>({
      connectionId,
      key,
      forceRefresh,
      signal: options?.signal,
      readCached: () => this.lookupFullTableDetails(connectionId, table, schema),
      fetchFresh: async (fetchEpoch) => {
        const startDetailEpoch = this.getDetailEpoch(connectionId)
        const session = await this.resolveSession(connectionId)
        if (forceRefresh && typeof session.clearSchemaCache === 'function') {
          session.clearSchemaCache()
        }
        const details = await session.getTableDetails(table, schema)
        if (!details.ddl) {
          try {
            const ddl = await session.getDdl(table, schema)
            if (ddl) {
              details.ddl = ddl
            }
          } catch {
            details.ddl = reconstructTableDdl(details, session.driverType)
          }
        }
        const fullDetails: TableDetails = {
          ...details,
          completeness: 'full',
        }
        const resolvedSchema = normalizeSchemaExact(fullDetails.schema)
        let allowUnqualifiedAlias = requestedSchema.length === 0
        if (!allowUnqualifiedAlias && resolvedSchema) {
          const verifiedDefault = await this.resolveVerifiedDefaultSchema(
            connectionId,
            session,
            fetchEpoch
          )
          allowUnqualifiedAlias = Boolean(verifiedDefault && resolvedSchema === verifiedDefault)
        }
        if (
          !this.disposed &&
          this.getEpoch(connectionId) === fetchEpoch &&
          this.getDetailEpoch(connectionId) === startDetailEpoch
        ) {
          this.setTableDetails(connectionId, fullDetails, {
            requestedSchema,
            requestedTable: table,
            allowUnqualifiedAlias,
          })
        }
        return fullDetails
      },
    })
  }

  /**
   * Returns a normalized `SchemaErGraph` via fast-path `session.introspectErGraph?.()` or
   * bounded `'lite'` fallback (concurrency 4, cap 100 tables, tagged `completeness: 'lite'`).
   */
  async getErGraph(
    connectionId: string,
    options?: {
      schema?: string
      includeViews?: boolean
      forceRefresh?: boolean
      signal?: AbortSignal
    }
  ): Promise<SchemaErGraph> {
    const schema = options?.schema?.trim() || undefined
    const includeViews = options?.includeViews !== false
    const forceRefresh = Boolean(options?.forceRefresh)
    const key = buildErKey(connectionId, schema, includeViews)

    return await this.runCoalesced<SchemaErGraph>({
      connectionId,
      key,
      forceRefresh,
      signal: options?.signal,
      readCached: () => this.erGraphs.get(key)?.graph,
      fetchFresh: async (fetchEpoch) => {
        const session = await this.resolveSession(connectionId)
        if (forceRefresh && typeof session.clearSchemaCache === 'function') {
          session.clearSchemaCache()
        }

        if (forceRefresh && !this.disposed && this.getEpoch(connectionId) === fetchEpoch) {
          this.invalidateDerivedForSchema(connectionId, schema)
        }
        const startDetailEpoch = this.getDetailEpoch(connectionId)
        let graph: SchemaErGraph
        if (typeof session.introspectErGraph === 'function') {
          graph = await session.introspectErGraph(schema)
        } else {
          const allObjects = await session.listObjects(schema)
          if (!this.disposed && this.getEpoch(connectionId) === fetchEpoch) {
            this.storeObjectsResult(connectionId, schema, allObjects, fetchEpoch)
          }
          const tabular = allObjects.filter(
            (obj) => obj.kind === 'table' || (includeViews && obj.kind === 'view')
          )
          const totalTableCount = tabular.length
          const capped = tabular.slice(0, ER_LITE_FALLBACK_MAX_TABLES)
          const collected: TableDetails[] = new Array(capped.length)
          let cursor = 0

          const workerCount = Math.min(ER_FALLBACK_CONCURRENCY, capped.length)
          const workers: Promise<void>[] = []
          for (let w = 0; w < workerCount; w += 1) {
            workers.push(
              (async () => {
                while (cursor < capped.length) {
                  const idx = cursor
                  cursor += 1
                  const obj = capped[idx]
                  const det = await session.getTableDetails(obj.name, obj.schema || schema)
                  const liteDet: TableDetails = {
                    ...det,
                    completeness: 'lite',
                  }
                  collected[idx] = liteDet
                  if (
                    !this.disposed &&
                    this.getEpoch(connectionId) === fetchEpoch &&
                    this.getDetailEpoch(connectionId) === startDetailEpoch
                  ) {
                    this.setTableDetails(connectionId, liteDet, {
                      requestedSchema: obj.schema || schema,
                    })
                  }
                }
              })()
            )
          }
          await Promise.all(workers)
          graph = buildSchemaErGraphFromTableDetails(connectionId, collected.filter(Boolean), {
            schema,
            completeness: 'lite',
            maxTables: ER_LITE_FALLBACK_MAX_TABLES,
            totalTableCount,
          })
        }

        if (!includeViews && graph.nodes.some((n) => n.kind === 'view')) {
          const viewIds = new Set(graph.nodes.filter((n) => n.kind === 'view').map((n) => n.id))
          graph = {
            ...graph,
            nodes: graph.nodes.filter((n) => n.kind !== 'view'),
            edges: graph.edges.filter((e) => !viewIds.has(e.fromNodeId) && !viewIds.has(e.toNodeId)),
          }
        }

        if (
          !this.disposed &&
          this.getEpoch(connectionId) === fetchEpoch &&
          this.getDetailEpoch(connectionId) === startDetailEpoch
        ) {
          this.erGraphs.set(key, { graph, cachedAt: Date.now() })
        }
        return graph
      },
    })
  }

  dispose(): void {
    this.disposed = true
    for (const state of Array.from(this.coalesceMap.values())) {
      if (state.followUp) {
        const next = state.followUp
        state.followUp = null
        next.reject(createAbortError('Schema catalog disposed'))
      }
    }
    for (const connId of Array.from(this.closeRejectorsByConn.keys())) {
      this.rejectWaitersForConnection(connId, createAbortError('Schema catalog disposed'))
    }
    this.epochs.clear()
    this.detailEpochs.clear()
    this.objectsCatalog.clear()
    this.erGraphs.clear()
    this.exactDetailsByConn.clear()
    this.verifiedDefaultSchemaByConn.clear()
    this.coalesceMap.clear()
    this.store.clear()
    this.connectionRevisions.clear()
  }
}
