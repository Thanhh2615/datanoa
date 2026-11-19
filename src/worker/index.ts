import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { JsonValue, OrcaWorkerApi, PanelRequestContext } from 'orca/worker'
import {
  ACTIVE_CONNECTION_STORAGE_KEY,
  sanitizeJsonPayload,
  type ConnectionColorTag,
  type ConnectionProfile,
  type QueryHistoryEntry,
  type QueryResult,
  type SchemaObject,
  type TableBrowseResult,
  type TableDetails,
} from '../protocol'
import { getDriver, type IDatabaseSession } from '../drivers'
import { parseConnectionUri, SUPPORTED_DRIVERS } from '../drivers/common/connection-uri'
import {
  hasExplainAnalyzeOption,
  isExplainTargetMutating,
  isMutatingStatement,
  quoteIdentForDialect,
  reconstructTableDdl,
  sanitizeFilterClause,
  splitSqlStatements,
  stripLeadingSqlComments,
} from '../drivers/common/sql-tools'
import {
  detectWorkspaceEnvConnections,
  discoverWorkspaceSqliteFiles,
  formatByteSize,
  getLocalWorkspaceDirs,
  isBlockedScanRoot,
  isLocalWorkspaceHost,
  resolveSqliteFilePath,
  scanDirectoryForSqliteFiles,
  type DiscoveredSqliteFile,
} from './discovery'
import { SessionManager } from './session-manager'

export {
  detectWorkspaceEnvConnections,
  discoverWorkspaceSqliteFiles,
  isBlockedScanRoot,
  resolveSqliteFilePath,
  scanDirectoryForSqliteFiles,
} from './discovery'
export { SessionManager } from './session-manager'

const READ_ONLY_MUTATION_ERROR =
  'Connection is Read-Only. Uncheck Read-Only in connection settings to modify data.'
const QUERY_HISTORY_STORAGE_KEY = 'datanoa.queryHistory'
const MAX_QUERY_HISTORY = 50

function createHostError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string }
  err.code = code
  return err
}

async function assertMutableConnection(
  sessionManager: SessionManager,
  connectionId: string
): Promise<ConnectionProfile> {
  const profile = await sessionManager.findProfile(connectionId)
  if (!profile) {
    throw createHostError('invalid_params', `Connection '${connectionId}' not found in storage`)
  }
  if (profile.readOnly) {
    throw createHostError('not_permitted', READ_ONLY_MUTATION_ERROR)
  }
  return profile
}

function normalizeColorTag(tag: unknown): ConnectionColorTag | undefined {
  if (tag === 'none' || tag === 'dev' || tag === 'staging' || tag === 'prod') {
    return tag
  }
  return undefined
}

function sanitizeConnectionProfile(conn: ConnectionProfile): ConnectionProfile {
  const redisDb =
    typeof conn.redisDb === 'number' &&
    Number.isInteger(conn.redisDb) &&
    conn.redisDb >= 0 &&
    conn.redisDb <= 15
      ? conn.redisDb
      : undefined
  const url =
    typeof conn.url === 'string' && conn.url.trim().length > 0 ? conn.url.trim() : undefined
  const options =
    typeof conn.options === 'string' && conn.options.trim().length > 0
      ? conn.options.trim()
      : undefined

  return sanitizeJsonPayload({
    id: conn.id,
    name: conn.name,
    driver: conn.driver,
    database: conn.database,
    filePath: conn.filePath,
    host: conn.host,
    port: conn.port,
    user: conn.user,
    hasPassword: Boolean(conn.hasPassword),
    hasAuthToken: conn.hasAuthToken !== undefined ? Boolean(conn.hasAuthToken) : undefined,
    ssl: conn.ssl,
    readOnly: conn.readOnly,
    url,
    redisDb,
    colorTag: normalizeColorTag(conn.colorTag),
    options,
  })
}

async function normalizeSqliteProfile(profile: ConnectionProfile): Promise<ConnectionProfile> {
  if (profile.driver !== 'sqlite') {
    return sanitizeJsonPayload(profile)
  }
  const rawTarget = profile.filePath || profile.database || ''
  const resolvedPath = await resolveSqliteFilePath(rawTarget)
  const dbName =
    resolvedPath && resolvedPath !== ':memory:'
      ? path.basename(resolvedPath)
      : profile.database || ':memory:'
  return sanitizeJsonPayload({
    ...profile,
    database: dbName,
    filePath: resolvedPath || profile.filePath,
  })
}

function normalizePathForCompare(rawPath: string): string {
  const cleaned = path.resolve(rawPath).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? cleaned.toLowerCase() : cleaned || '/'
}

async function openStudioDocumentInOrca(
  orca: OrcaWorkerApi,
  options?: { connectionId?: string; table?: string; schema?: string; sql?: string },
  sessionManager?: SessionManager
): Promise<{ ok: boolean; path?: string; message?: string }> {
  try {
    if (!orca.host || typeof orca.host.call !== 'function') {
      return {
        ok: false,
        message: 'Open a local workspace folder in Orca to launch Full Studio.',
      }
    }

    const listResult = (await orca.host.call('workspace.list')) as {
      workspaces?: Array<{
        id: string
        path: string
        name?: string
        branch?: string | null
        hostId?: string | null
      }>
    } | null
    const localWorkspaces = (listResult?.workspaces || []).filter(
      (w) =>
        Boolean(w) &&
        typeof w.path === 'string' &&
        w.path.trim().length > 0 &&
        isLocalWorkspaceHost(w.hostId)
    )
    if (localWorkspaces.length === 0) {
      return {
        ok: false,
        message: 'Open a local workspace folder in Orca to launch Full Studio.',
      }
    }

    let matched: (typeof localWorkspaces)[number] | undefined
    try {
      const ctx = await orca.host.call('workspace.readContext')
      if (ctx?.workspaceId) {
        matched = localWorkspaces.find((w) => w.id === ctx.workspaceId)
      }
      if (!matched && ctx?.displayName) {
        matched = localWorkspaces.find(
          (w) =>
            w.name === ctx.displayName &&
            (ctx.branch ? w.branch === ctx.branch : true)
        )
      }
    } catch {
      // Fall back to local workspace selection
    }

    const homeNorm = normalizePathForCompare(os.homedir())
    const target =
      matched ??
      localWorkspaces.find((w) => normalizePathForCompare(w.path) !== homeNorm) ??
      localWorkspaces[0]

    const studioDir = path.join(target.path, '.datanoa')
    await fs.promises.mkdir(studioDir, { recursive: true })
    const gitignorePath = path.join(studioDir, '.gitignore')
    if (!fs.existsSync(gitignorePath)) {
      await fs.promises.writeFile(gitignorePath, '*\n', 'utf8')
    }

    const fileName = 'studio.datanoa'
    const fullFilePath = path.join(studioDir, fileName)
    try {
      const existingFiles = await fs.promises.readdir(studioDir)
      for (const entry of existingFiles) {
        if (entry.endsWith('.datanoa') && entry !== fileName) {
          await fs.promises.unlink(path.join(studioDir, entry)).catch(() => {})
        }
      }
    } catch {
      // Ignore cleanup errors
    }

    let resolvedConnectionId =
      typeof options?.connectionId === 'string' && options.connectionId.trim().length > 0
        ? options.connectionId.trim()
        : ''

    if (!resolvedConnectionId && sessionManager) {
      const savedList = (await sessionManager.getStoredConnections()).filter(
        (c) => c && typeof c.id === 'string' && c.id.length > 0 && !c.id.startsWith('ws_')
      )
      const storedActiveId = await orca.storage.get(ACTIVE_CONNECTION_STORAGE_KEY)
      if (
        typeof storedActiveId === 'string' &&
        storedActiveId.trim().length > 0 &&
        savedList.some((c) => c.id === storedActiveId)
      ) {
        resolvedConnectionId = storedActiveId
      } else if (savedList[0]?.id) {
        resolvedConnectionId = savedList[0].id
      }
    }

    const headerLines = [
      `-- datanoa: connectionId=${resolvedConnectionId}`,
      options?.table ? `-- datanoa: table=${options.table}` : '',
      options?.schema ? `-- datanoa: schema=${options.schema}` : '',
    ].filter(Boolean)

    const profile =
      resolvedConnectionId && sessionManager
        ? await sessionManager.findProfile(resolvedConnectionId)
        : null
    const dialect = profile?.driver ?? 'postgres'
    const quotedTable = options?.table ? quoteIdentForDialect(options.table, dialect) : ''
    const qualifiedTable =
      quotedTable &&
      options?.schema &&
      !((dialect === 'sqlite' || dialect === 'libsql') && options.schema === 'main') &&
      options.schema !== 'public'
        ? `${quoteIdentForDialect(options.schema, dialect)}.${quotedTable}`
        : quotedTable

    const defaultSql =
      options?.sql ||
      (dialect === 'redis'
        ? 'SCAN 0 MATCH * COUNT 50'
        : qualifiedTable
          ? `SELECT * FROM ${qualifiedTable} LIMIT 100;`
          : '-- Datanoa SQL Studio\nSELECT 1;\n')

    const content = `${headerLines.join('\n')}\n${defaultSql}\n`
    await fs.promises.writeFile(fullFilePath, content, 'utf8')

    const relPath = `.datanoa/${fileName}`
    try {
      await orca.host.call('workspace.open', { workspaceId: target.id })
    } catch {
      // Ignore if workspace is already open/focused
    }
    await orca.host.call('editor.open', {
      workspaceId: target.id,
      path: relPath,
    })
    return { ok: true, path: relPath }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    orca.log(`[Worker] studio.open failed: ${msg}`)
    return { ok: false, message: msg }
  }
}

let currentSessionManager: SessionManager | null = null
const activeQuerySessions = new Map<string, IDatabaseSession>()
const PRE_CANCELLED_QUERY_TTL_MS = 60_000
const preCancelledQueryIds = new Map<string, number>()

function prunePreCancelledQueries(now: number): void {
  for (const [id, expiresAt] of preCancelledQueryIds.entries()) {
    if (expiresAt <= now) {
      preCancelledQueryIds.delete(id)
    }
  }
}

function markQueryPreCancelled(queryId: string): void {
  const now = Date.now()
  prunePreCancelledQueries(now)
  preCancelledQueryIds.set(queryId, now + PRE_CANCELLED_QUERY_TTL_MS)
}

function consumePreCancelledQuery(queryId: string): boolean {
  const now = Date.now()
  const expiresAt = preCancelledQueryIds.get(queryId)
  if (expiresAt === undefined) {
    return false
  }
  preCancelledQueryIds.delete(queryId)
  return expiresAt > now
}

async function readClampedTimeoutSeconds(orca: OrcaWorkerApi): Promise<number> {
  const settingTimeout = Number(await orca.settings.get('queryTimeoutSeconds'))
  return Number.isFinite(settingTimeout) && settingTimeout > 0
    ? Math.max(1, Math.min(110, Math.floor(settingTimeout)))
    : 30
}

async function executeSessionQuery(
  session: IDatabaseSession,
  queryId: string,
  sql: string,
  maxRows: number,
  timeoutSeconds: number,
  signal: AbortSignal
): Promise<QueryResult> {
  activeQuerySessions.set(queryId, session)

  let abortCleanup: (() => void) | undefined
  const abortPromise = new Promise<QueryResult>((_, reject) => {
    const onAbort = () => {
      void session.cancelQuery(queryId).catch(() => {})
      reject(createHostError('cancelled', 'Query execution was cancelled'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    abortCleanup = () => signal.removeEventListener('abort', onAbort)
  })
  abortPromise.catch(() => {})

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<QueryResult>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      void session.cancelQuery(queryId).catch(() => {})
      reject(createHostError('timeout', `Query timed out after ${timeoutSeconds}s`))
    }, timeoutSeconds * 1000)
  })
  timeoutPromise.catch(() => {})

  try {
    const queryPromise = session.runQuery(queryId, sql, maxRows)
    queryPromise.catch(() => {})
    return await Promise.race([queryPromise, abortPromise, timeoutPromise])
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle)
    }
    if (typeof abortCleanup === 'function') {
      abortCleanup()
    }
    activeQuerySessions.delete(queryId)
  }
}

export default function activate(orca: OrcaWorkerApi): void {
  const sessionManager = new SessionManager(orca)
  currentSessionManager = sessionManager

  // Wrap orca.panels.handle so every returned value is guaranteed to be strict JSON
  // (no undefined keys, no null-prototype objects from node:sqlite, no BigInt/Uint8Array)
  const rawHandle = orca.panels.handle.bind(orca.panels)
  const registerHandler = ((
    name: Parameters<typeof orca.panels.handle>[0],
    handler: (input: never, ctx: PanelRequestContext) => unknown
  ) => {
    return rawHandle(name as never, async (input: unknown, ctx: PanelRequestContext) => {
      const res = await handler(input as never, ctx)
      return sanitizeJsonPayload(res) as never
    })
  }) as typeof orca.panels.handle

  let connectionsWriteChain: Promise<void> = Promise.resolve()
  const runSerializedConnectionWrite = <T>(fn: () => Promise<T>): Promise<T> => {
    const task = connectionsWriteChain.then(fn)
    connectionsWriteChain = task.then(
      () => undefined,
      () => undefined
    )
    return task
  }

  // =========================================================================
  // 1. connections.list (storage-only, < 10ms, zero filesystem crawl)
  // =========================================================================
  registerHandler('connections.list', async (): Promise<ConnectionProfile[]> => {
    await connectionsWriteChain
    const stored = await sessionManager.getStoredConnections()
    const cleaned = stored.filter(
      (c) =>
        c &&
        typeof c === 'object' &&
        typeof c.id === 'string' &&
        c.id.length > 0 &&
        !c.id.startsWith('ws_')
    )
    if (cleaned.length !== stored.length) {
      await runSerializedConnectionWrite(async () => {
        const latest = await sessionManager.getStoredConnections()
        const latestCleaned = latest.filter(
          (c) =>
            c &&
            typeof c === 'object' &&
            typeof c.id === 'string' &&
            c.id.length > 0 &&
            !c.id.startsWith('ws_')
        )
        if (latestCleaned.length !== latest.length) {
          await sessionManager.saveStoredConnections(latestCleaned)
        }
      })
    }

    return cleaned.map(sanitizeConnectionProfile)
  })

  // =========================================================================
  // 2. connection.save
  // =========================================================================
  registerHandler('connection.save', async (input) => {
    if (!input || !input.profile || !input.profile.driver) {
      throw createHostError('invalid_params', 'Missing profile configuration')
    }
    if (!SUPPORTED_DRIVERS.includes(input.profile.driver)) {
      throw createHostError(
        'invalid_params',
        `Unsupported database driver: ${String(input.profile.driver)}`
      )
    }

    const normalized = await normalizeSqliteProfile(input.profile)
    const id =
      normalized.id && !normalized.id.startsWith('ws_')
        ? normalized.id
        : `conn_${normalized.driver}_${Date.now()}`
    const hasPassword =
      input.password !== undefined ? Boolean(input.password) : Boolean(normalized.hasPassword)
    const hasAuthToken =
      input.authToken !== undefined ? Boolean(input.authToken) : Boolean(normalized.hasAuthToken)

    const profileToSave = sanitizeConnectionProfile({
      ...normalized,
      id,
      hasPassword,
      hasAuthToken: hasAuthToken || undefined,
    })

    return await runSerializedConnectionWrite(async () => {
      // Persist/copy secrets BEFORE exposing the connection profile in storage
      if (
        input.sourceConnectionId &&
        input.password === undefined &&
        input.authToken === undefined
      ) {
        await sessionManager.copySecret(input.sourceConnectionId, id)
      }
      await sessionManager.saveSecret(id, {
        password: input.password,
        authToken: input.authToken,
      })

      const list = await sessionManager.getStoredConnections()
      const idx = list.findIndex((c) => c.id === id)
      if (idx >= 0) {
        list[idx] = profileToSave
      } else {
        list.push(profileToSave)
      }

      await sessionManager.saveStoredConnections(list)

      const currentActiveId = await orca.storage.get(ACTIVE_CONNECTION_STORAGE_KEY)
      const activeStillExists =
        typeof currentActiveId === 'string' &&
        currentActiveId.trim().length > 0 &&
        list.some((c) => c.id === currentActiveId)
      if (!activeStillExists) {
        await orca.storage.set(ACTIVE_CONNECTION_STORAGE_KEY, id)
      }

      // Invalidate active session so modified credentials or connection settings take effect
      await sessionManager.closeSession(id)

      orca.panels.post('connections.changed', { count: list.length })
      return { ok: true, id }
    })
  })

  // =========================================================================
  // 3. connection.delete
  // =========================================================================
  registerHandler('connection.delete', async (input) => {
    if (!input || !input.id) {
      throw createHostError('invalid_params', 'Missing id parameter')
    }

    return await runSerializedConnectionWrite(async () => {
      const list = await sessionManager.getStoredConnections()
      const updated = list.filter((c) => c.id !== input.id)
      await sessionManager.saveStoredConnections(updated)
      await sessionManager.deleteSecret(input.id)
      await sessionManager.closeSession(input.id)

      const validUpdated = updated.filter(
        (c) => c && typeof c.id === 'string' && c.id.length > 0 && !c.id.startsWith('ws_')
      )
      const currentActiveId = await orca.storage.get(ACTIVE_CONNECTION_STORAGE_KEY)
      const activeStillValid =
        typeof currentActiveId === 'string' &&
        validUpdated.some((c) => c.id === currentActiveId)
      if (currentActiveId === input.id || !activeStillValid) {
        const nextActiveId = validUpdated[0]?.id
        if (nextActiveId) {
          await orca.storage.set(ACTIVE_CONNECTION_STORAGE_KEY, nextActiveId)
        } else {
          await orca.storage.delete(ACTIVE_CONNECTION_STORAGE_KEY)
        }
      }

      orca.panels.post('connections.changed', { count: updated.length })
      return { ok: true }
    })
  })

  // =========================================================================
  // 4. connection.test & connection.parseUri
  // =========================================================================
  registerHandler('connection.test', async (input) => {
    if (!input?.profile?.driver) {
      throw createHostError('invalid_params', 'Driver must be specified')
    }
    if (!SUPPORTED_DRIVERS.includes(input.profile.driver)) {
      throw createHostError(
        'invalid_params',
        `Unsupported database driver: ${String(input.profile.driver)}`
      )
    }

    const normalized = await normalizeSqliteProfile(input.profile)
    const isLibsql = normalized.driver === 'libsql'
    let secret = isLibsql ? input.authToken : input.password
    const secretLookupId =
      normalized.id &&
      !normalized.id.startsWith('ws_') &&
      !normalized.id.startsWith('conn_test_')
        ? normalized.id
        : input.sourceConnectionId
    if (secret === undefined && secretLookupId) {
      const hasStoredSecret = isLibsql
        ? normalized.hasAuthToken !== false
        : Boolean(normalized.hasPassword)
      if (hasStoredSecret) {
        secret = await sessionManager.getSecret(secretLookupId, normalized.driver)
      }
    }

    const driver = getDriver(normalized.driver)
    return await driver.testConnection(normalized, secret)
  })

  registerHandler('connection.parseUri', async (input) => {
    const rawUri = typeof input?.uri === 'string' ? input.uri : ''
    return parseConnectionUri(rawUri)
  })

  // =========================================================================
  // 5. schema.listObjects
  // =========================================================================
  registerHandler(
    'schema.listObjects',
    async (input): Promise<SchemaObject[]> => {
      if (!input?.connectionId) {
        throw createHostError('invalid_params', 'connectionId parameter is required')
      }
      const session = await sessionManager.getSession(input.connectionId)
      return await session.listObjects(input.schema)
    }
  )

  // =========================================================================
  // 6. schema.tableDetails & schema.generateDdl
  // =========================================================================
  registerHandler(
    'schema.tableDetails',
    async (input): Promise<TableDetails> => {
      if (!input?.connectionId) {
        throw createHostError('invalid_params', 'connectionId parameter is required')
      }
      if (!input?.table) {
        throw createHostError('invalid_params', 'Table parameter is required')
      }
      const session = await sessionManager.getSession(input.connectionId)
      const details = await session.getTableDetails(input.table, input.schema)
      if (!details.ddl) {
        try {
          const ddl = await session.getDdl(input.table, input.schema)
          if (ddl) {
            details.ddl = ddl
          }
        } catch {
          details.ddl = reconstructTableDdl(details, session.driverType)
        }
      }
      return details
    }
  )

  registerHandler('schema.generateDdl', async (input) => {
    if (!input?.connectionId) {
      throw createHostError('invalid_params', 'connectionId parameter is required')
    }
    if (!input?.table) {
      throw createHostError('invalid_params', 'Table parameter is required')
    }
    const session = await sessionManager.getSession(input.connectionId)
    const ddl = await session.getDdl(input.table, input.schema)
    return { ddl }
  })

  // =========================================================================
  // 7. data.fetchPage
  // =========================================================================
  registerHandler(
    'data.fetchPage',
    async (input): Promise<TableBrowseResult> => {
      if (!input?.connectionId) {
        throw createHostError('invalid_params', 'connectionId parameter is required')
      }
      if (!input?.table) {
        throw createHostError('invalid_params', 'Table parameter is required')
      }

      const profile = await sessionManager.findProfile(input.connectionId)
      let whereClause: string | undefined
      let orderByClause: string | undefined
      try {
        whereClause = sanitizeFilterClause(input.whereClause, profile?.driver)
        orderByClause = sanitizeFilterClause(input.orderByClause, profile?.driver)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        throw createHostError('invalid_params', msg)
      }

      const rawPage = Number(input.page)
      const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1
      const rawPageSize = Number(input.pageSize)
      const pageSize =
        Number.isFinite(rawPageSize) && rawPageSize >= 1
          ? Math.max(1, Math.min(10000, Math.floor(rawPageSize)))
          : 50
      const session = await sessionManager.getSession(input.connectionId)
      return await session.fetchPage({
        table: input.table,
        schema: input.schema,
        page,
        pageSize,
        sortColumn: input.sortColumn,
        sortDirection: input.sortDirection,
        whereClause,
        orderByClause,
      })
    }
  )

  // =========================================================================
  // 8. data.updateCell, data.previewChanges & data.applyChanges
  // =========================================================================
  registerHandler('data.updateCell', async (input) => {
    if (!input?.connectionId) {
      throw createHostError('invalid_params', 'connectionId parameter is required')
    }
    if (!input?.table || !input.column || !input.primaryKeys) {
      throw createHostError('invalid_params', 'Missing required update parameters')
    }
    if (typeof input.primaryKeys !== 'object' || Object.keys(input.primaryKeys).length === 0) {
      throw createHostError('invalid_params', 'Primary keys are required for cell update')
    }

    await assertMutableConnection(sessionManager, input.connectionId)
    const session = await sessionManager.getSession(input.connectionId)
    const result = await session.updateCell({
      table: input.table,
      schema: input.schema,
      primaryKeys: input.primaryKeys,
      column: input.column,
      newValue: input.newValue,
      originalValue: input.originalValue,
    })

    orca.panels.post(
      'data.cellUpdated',
      sanitizeJsonPayload({
        connectionId: input.connectionId,
        schema: input.schema,
        table: input.table,
        primaryKeys: input.primaryKeys,
        column: input.column,
      })
    )

    return result
  })

  registerHandler('data.previewChanges', async (input) => {
    if (!input?.connectionId) {
      throw createHostError('invalid_params', 'connectionId parameter is required')
    }
    if (!input?.table) {
      throw createHostError('invalid_params', 'Table parameter is required')
    }
    const session = await sessionManager.getSession(input.connectionId)
    return await session.previewChanges({
      table: input.table,
      schema: input.schema,
      inserts: input.inserts,
      updates: input.updates,
      deletes: input.deletes,
    })
  })

  registerHandler('data.applyChanges', async (input) => {
    if (!input?.connectionId) {
      throw createHostError('invalid_params', 'connectionId parameter is required')
    }
    if (!input?.table) {
      throw createHostError('invalid_params', 'Table parameter is required')
    }
    await assertMutableConnection(sessionManager, input.connectionId)
    const session = await sessionManager.getSession(input.connectionId)
    const res = await session.applyChanges({
      table: input.table,
      schema: input.schema,
      inserts: input.inserts,
      updates: input.updates,
      deletes: input.deletes,
    })

    const firstUpdate = input.updates?.[0]
    orca.panels.post(
      'data.cellUpdated',
      sanitizeJsonPayload({
        connectionId: input.connectionId,
        schema: input.schema,
        table: input.table,
        primaryKeys: firstUpdate?.primaryKeys ?? {},
        column: firstUpdate ? Object.keys(firstUpdate.changes)[0] || '*' : '*',
      })
    )
    return res
  })

  let historyWriteChain: Promise<void> = Promise.resolve()
  const recordQueryHistory = (entry: QueryHistoryEntry): Promise<void> => {
    const task = historyWriteChain.then(async () => {
      try {
        const existing = (await orca.storage.get(
          QUERY_HISTORY_STORAGE_KEY
        )) as QueryHistoryEntry[] | null
        const list = Array.isArray(existing) ? existing : []
        const next = [sanitizeJsonPayload(entry), ...list].slice(0, MAX_QUERY_HISTORY)
        await orca.storage.set(
          QUERY_HISTORY_STORAGE_KEY,
          sanitizeJsonPayload(next) as unknown as JsonValue
        )
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        orca.log(`[Worker] Failed to persist query history: ${msg}`)
      }
    })
    historyWriteChain = task.catch(() => {})
    return task
  }

  // =========================================================================
  // 9. query.run, query.explain & query.history.*
  // =========================================================================
  registerHandler('query.run', async (input, ctx): Promise<QueryResult> => {
    if (!input?.sql || typeof input.sql !== 'string') {
      throw createHostError('invalid_params', 'SQL string is required')
    }
    const trimmed = input.sql.trim()
    if (!trimmed) {
      throw createHostError('invalid_params', 'SQL statement cannot be empty')
    }
    if (!input.connectionId) {
      throw createHostError('invalid_params', 'connectionId parameter is required')
    }

    if (ctx.signal.aborted) {
      throw createHostError('cancelled', 'Query was cancelled prior to execution')
    }

    const profile = await sessionManager.findProfile(input.connectionId)
    if (!profile) {
      throw createHostError('invalid_params', `Connection '${input.connectionId}' not found in storage`)
    }
    if (profile.readOnly && isMutatingStatement(trimmed, profile.driver)) {
      throw createHostError('not_permitted', READ_ONLY_MUTATION_ERROR)
    }

    const settingMaxRows = Number(await orca.settings.get('maxRows'))
    const defaultMaxRows =
      Number.isFinite(settingMaxRows) && settingMaxRows > 0
        ? Math.max(1, Math.min(50000, Math.floor(settingMaxRows)))
        : 1000
    const reqMaxRows = Number(input.maxRows)
    const maxRows =
      Number.isFinite(reqMaxRows) && reqMaxRows > 0
        ? Math.max(1, Math.min(50000, Math.floor(reqMaxRows)))
        : defaultMaxRows

    const timeoutSeconds = await readClampedTimeoutSeconds(orca)
    const queryId =
      input.queryId || `q_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`

    if (ctx.signal.aborted || consumePreCancelledQuery(queryId)) {
      throw createHostError('cancelled', 'Query execution was cancelled')
    }

    const session = await sessionManager.getSession(input.connectionId)
    if (ctx.signal.aborted || consumePreCancelledQuery(queryId)) {
      throw createHostError('cancelled', 'Query execution was cancelled')
    }

    const startedAt = Date.now()
    try {
      const res = await executeSessionQuery(
        session,
        queryId,
        trimmed,
        maxRows,
        timeoutSeconds,
        ctx.signal
      )
      await recordQueryHistory({
        id: queryId,
        timestamp: Date.now(),
        connectionId: profile.id,
        connectionName: profile.name,
        driver: profile.driver,
        sql: trimmed,
        durationMs:
          typeof res.executionTimeMs === 'number' ? res.executionTimeMs : Date.now() - startedAt,
        rowCount: typeof res.rowCount === 'number' ? res.rowCount : 0,
        isError: false,
      })
      return res
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      await recordQueryHistory({
        id: queryId,
        timestamp: Date.now(),
        connectionId: profile.id,
        connectionName: profile.name,
        driver: profile.driver,
        sql: trimmed,
        durationMs: Date.now() - startedAt,
        rowCount: 0,
        isError: true,
        errorMessage,
      })
      throw err
    }
  })

  registerHandler('query.explain', async (input, ctx): Promise<QueryResult> => {
    if (!input?.connectionId) {
      throw createHostError('invalid_params', 'connectionId parameter is required')
    }
    if (!input?.sql || typeof input.sql !== 'string') {
      throw createHostError('invalid_params', 'SQL string is required')
    }
    const trimmed = input.sql.trim()
    if (!trimmed) {
      throw createHostError('invalid_params', 'SQL statement cannot be empty')
    }
    if (ctx.signal.aborted) {
      throw createHostError('cancelled', 'Explain was cancelled prior to execution')
    }

    const profile = await sessionManager.findProfile(input.connectionId)
    if (!profile) {
      throw createHostError('invalid_params', `Connection '${input.connectionId}' not found in storage`)
    }

    if (profile.driver === 'redis') {
      const tokens = trimmed.split(/\s+/)
      const cmd = (tokens[0] || '').replace(/^["']|["']$/g, '').toUpperCase()
      const mutating = isMutatingStatement(trimmed, 'redis')
      return {
        columns: [
          { name: 'command', type: 'TEXT' },
          { name: 'mode', type: 'TEXT' },
          { name: 'diagnostic', type: 'TEXT' },
        ],
        rows: [
          [
            cmd,
            mutating ? 'write' : 'read-only',
            `Redis command ${cmd} (${tokens.length} argument(s)). Redis executes commands sequentially without SQL query plans.`,
          ],
        ],
        rowCount: 1,
        executionTimeMs: 0,
        truncated: false,
        isSelect: true,
      }
    }

    const explainStmts = splitSqlStatements(trimmed, profile.driver)
    if (explainStmts.length === 0) {
      throw createHostError('invalid_params', 'SQL statement cannot be empty')
    }
    if (explainStmts.length > 1) {
      throw createHostError(
        'invalid_params',
        'EXPLAIN only supports a single SQL statement at a time.'
      )
    }

    const sqlBody = explainStmts[0].text.replace(/;+\s*$/, '').trim()
    const leadingStripped = stripLeadingSqlComments(sqlBody, profile.driver)
    const explainSql = /^EXPLAIN\b/i.test(leadingStripped)
      ? sqlBody
      : profile.driver === 'sqlite' || profile.driver === 'libsql'
        ? `EXPLAIN QUERY PLAN ${sqlBody}`
        : `EXPLAIN ${sqlBody}`

    if (profile.readOnly && isMutatingStatement(explainSql, profile.driver)) {
      throw createHostError('not_permitted', READ_ONLY_MUTATION_ERROR)
    }
    if (
      hasExplainAnalyzeOption(explainSql, profile.driver) &&
      isExplainTargetMutating(sqlBody, profile.driver)
    ) {
      throw createHostError(
        'not_permitted',
        'EXPLAIN ANALYZE is not permitted for mutating statements in Explain mode.'
      )
    }

    const explainQueryId =
      typeof input.queryId === 'string' && input.queryId.trim().length > 0
        ? input.queryId.trim()
        : `explain_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`

    if (ctx.signal.aborted || consumePreCancelledQuery(explainQueryId)) {
      throw createHostError('cancelled', 'Explain execution was cancelled')
    }

    const timeoutSeconds = await readClampedTimeoutSeconds(orca)
    const session = await sessionManager.getSession(input.connectionId)
    if (ctx.signal.aborted || consumePreCancelledQuery(explainQueryId)) {
      throw createHostError('cancelled', 'Explain execution was cancelled')
    }

    return await executeSessionQuery(
      session,
      explainQueryId,
      explainSql,
      1000,
      timeoutSeconds,
      ctx.signal
    )
  })

  registerHandler('query.history.list', async (input) => {
    await historyWriteChain.catch(() => {})
    const raw = (await orca.storage.get(QUERY_HISTORY_STORAGE_KEY)) as QueryHistoryEntry[] | null
    const all = Array.isArray(raw) ? raw : []
    const reqLimit = Number(input?.limit)
    const limit =
      Number.isFinite(reqLimit) && reqLimit >= 1
        ? Math.min(MAX_QUERY_HISTORY, Math.floor(reqLimit))
        : MAX_QUERY_HISTORY
    return { entries: all.slice(0, limit) }
  })

  registerHandler('query.history.clear', async () => {
    const task = historyWriteChain.then(async () => {
      await orca.storage.set(QUERY_HISTORY_STORAGE_KEY, [])
    })
    historyWriteChain = task.catch(() => {})
    await task
    return { ok: true }
  })

  // =========================================================================
  // 10. query.cancel
  // =========================================================================
  registerHandler('query.cancel', async (input) => {
    if (!input?.queryId) {
      throw createHostError('invalid_params', 'queryId parameter is required')
    }

    const activeSession = activeQuerySessions.get(input.queryId)
    if (activeSession) {
      await activeSession.cancelQuery(input.queryId).catch(() => {})
      activeQuerySessions.delete(input.queryId)
    } else {
      // Track queryId briefly in case query.run is still inside getSession()
      markQueryPreCancelled(input.queryId)
      // Broadcast cancelQuery to all active sessions in pool idempotently
      for (const s of sessionManager.getActiveSessions().values()) {
        try {
          await s.cancelQuery(input.queryId)
        } catch {
          // Ignore
        }
      }
    }

    return { ok: true }
  })

  // =========================================================================
  // 11. sqlite.scanFolder & workspace.detectConnections
  // =========================================================================
  registerHandler('sqlite.scanFolder', async (input) => {
    const stored = await sessionManager.getStoredConnections()
    const rawFolder = input?.folderPath?.trim()
    let items: DiscoveredSqliteFile[] = []
    if (rawFolder) {
      try {
        let targetDir = rawFolder
        try {
          const stat = await fs.promises.stat(rawFolder)
          if (stat.isFile()) {
            targetDir = path.dirname(rawFolder)
          }
        } catch {
          // Keep rawFolder as directory candidate
        }
        items = await scanDirectoryForSqliteFiles(targetDir, stored)
      } catch {
        items = []
      }
    } else {
      items = await discoverWorkspaceSqliteFiles(orca, stored)
    }

    return {
      files: items.map((d) => ({
        name: d.name.replace(/\s*\(Workspace\)$/, ''),
        filePath: d.filePath,
        sizeBytes: d.sizeBytes ?? 0,
        sizeLabel: d.sizeLabel || formatByteSize(d.sizeBytes ?? 0),
      })),
    }
  })

  registerHandler('workspace.detectConnections', async (input) => {
    const stored = await sessionManager.getStoredConnections()
    const rawFolder = input?.folderPath?.trim()
    let targetDirs: string[] = []
    let sqliteFilesPromise: Promise<DiscoveredSqliteFile[]>

    if (rawFolder) {
      let targetDir = rawFolder
      try {
        const stat = await fs.promises.stat(rawFolder)
        if (stat.isFile()) {
          targetDir = path.dirname(rawFolder)
        }
      } catch {
        // Keep rawFolder
      }
      targetDirs = [targetDir]
      sqliteFilesPromise = scanDirectoryForSqliteFiles(targetDir, stored, { maxDurationMs: 750 })
    } else {
      targetDirs = await getLocalWorkspaceDirs(orca)
      sqliteFilesPromise = discoverWorkspaceSqliteFiles(orca, stored, { maxDurationMs: 750 })
    }

    const [envConnections, items] = await Promise.all([
      detectWorkspaceEnvConnections(targetDirs),
      sqliteFilesPromise,
    ])

    return {
      sqliteFiles: items.map((d) => ({
        name: d.name.replace(/\s*\(Workspace\)$/, ''),
        filePath: d.filePath,
        sizeBytes: d.sizeBytes ?? 0,
        sizeLabel: d.sizeLabel || formatByteSize(d.sizeBytes ?? 0),
      })),
      envConnections,
    }
  })

  // =========================================================================
  // 12. studio.open
  // =========================================================================
  registerHandler('studio.open', async (input) => {
    return await openStudioDocumentInOrca(orca, input, sessionManager)
  })

  // =========================================================================
  // Extension Commands
  // =========================================================================
  orca.commands.register('datanoa.openSqliteFile', async () => {
    orca.log('Datanoa: openSqliteFile command invoked')
    await openStudioDocumentInOrca(orca, undefined, sessionManager)
  })

  orca.commands.register('datanoa.newQuery', async () => {
    orca.log('Datanoa: newQuery command invoked')
    await openStudioDocumentInOrca(orca, undefined, sessionManager)
  })
}

export async function deactivate(): Promise<void> {
  if (currentSessionManager) {
    await currentSessionManager.closeAll()
    currentSessionManager = null
  }
  activeQuerySessions.clear()
  preCancelledQueryIds.clear()
}
