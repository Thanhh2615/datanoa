import type { OrcaWorkerApi } from 'orca/worker'
import {
  sanitizeJsonPayload,
  type ConnectionProfile,
  type SchemaCatalogObjectsResult,
  type SchemaErGraph,
  type SchemaObject,
  type SchemaObjectKind,
  type TableBrowseResult,
  type TableDetails,
} from '../protocol'
import { sanitizeSchemaFileName } from '../drivers/common/schema'
import {
  buildSchemaErGraphFromTableDetails,
  ER_LITE_FALLBACK_MAX_TABLES,
} from '../drivers/common/schema-er-graph'
import {
  isMutatingStatement,
  reconstructTableDdl,
  sanitizeFilterClause,
  stripCommentsAndLiterals,
} from '../drivers/common/sql-tools'
import type { WorkerSchemaMetadataCache } from './ai-sql-context'
import { COPY_IMPORT_MAX_CHUNK_BYTES, type CopyImportRegistry } from './copy-import-registry'
import type { ErLayoutStateStore } from './er-layout-state-store'
import { SchemaCatalog } from './schema-catalog'
import type { SessionManager } from './session-manager'
import type { TableDisplayStateStore } from './table-display-state-store'
import { TxOwnershipController } from './tx-ownership'
import {
  assertMutableConnection,
  assertNoCompactedPreviewOverwrite,
  createHostError,
  measureJsonBytes,
  READ_ONLY_MUTATION_ERROR,
  scrubAndEnhanceWorkerError,
  scrubCredentialsInText,
  type WorkerRegisterHandler,
} from './worker-utils'

const MAX_PANEL_BROADCAST_BYTES = 256 * 1024
export const MAX_TABLE_DISPLAY_KEY_BYTES = 2048

function assertValidTableDisplayKey(rawKey: unknown, required = true): string {
  if (typeof rawKey !== 'string' || rawKey.trim().length === 0) {
    if (!required && rawKey === undefined) return ''
    throw createHostError('invalid_params', 'tableKey parameter is required')
  }
  if (Buffer.byteLength(rawKey, 'utf8') > MAX_TABLE_DISPLAY_KEY_BYTES) {
    throw createHostError(
      'invalid_params',
      `tableKey exceeds maximum ${MAX_TABLE_DISPLAY_KEY_BYTES} UTF-8 byte limit`
    )
  }
  return rawKey
}

function postCellUpdatedBounded(
  orca: OrcaWorkerApi,
  raw: {
    connectionId: string
    schema?: string
    table: string
    primaryKeys: Record<string, unknown>
    column: string
  }
): void {
  let payload: {
    connectionId?: string
    schema?: string
    table: string
    primaryKeys: Record<string, unknown>
    column: string
    truncated?: boolean
  } = sanitizeJsonPayload(raw)
  if (measureJsonBytes(payload) > MAX_PANEL_BROADCAST_BYTES) {
    payload = sanitizeJsonPayload({
      connectionId: raw.connectionId,
      schema: raw.schema,
      table: raw.table,
      primaryKeys: {},
      column: raw.column,
      truncated: true,
    })
  }
  if (measureJsonBytes(payload) > MAX_PANEL_BROADCAST_BYTES) {
    payload = sanitizeJsonPayload({
      connectionId: raw.connectionId,
      table: raw.table.slice(0, 1024),
      primaryKeys: {},
      column: '*',
      truncated: true,
    })
  }
  try {
    orca.panels.post('data.cellUpdated', payload)
  } catch (err: unknown) {
    const msg = scrubCredentialsInText(err instanceof Error ? err.message : String(err))
    orca.log(`[Worker] data.cellUpdated broadcast failed: ${msg}`)
  }
}

export interface DataSchemaHandlersDeps {
  orca: OrcaWorkerApi
  registerHandler: WorkerRegisterHandler
  sessionManager: SessionManager
  schemaCache?: WorkerSchemaMetadataCache
  txOwnership?: TxOwnershipController
  copyImportRegistry?: CopyImportRegistry
  tableDisplayStateStore?: TableDisplayStateStore
  erLayoutStateStore?: ErLayoutStateStore
}

const ALLOWED_SCHEMA_OBJECT_KINDS: readonly SchemaObjectKind[] = [
  'table',
  'view',
  'materialized_view',
  'function',
  'procedure',
  'trigger',
  'sequence',
  'type',
]

const READ_ONLY_FILTER_FORBIDDEN_CALL_RE =
  /\b(?:pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|lo_import|lo_export|lo_unlink|setval|nextval|xp_cmdshell|sp_configure|load_file|dbms_lock|utl_http|utl_file)\s*\(/i

function assertReadOnlyFilterClauseSafe(
  clause: string | undefined,
  kind: 'where' | 'orderBy',
  driver?: ConnectionProfile['driver']
): void {
  if (!clause) return
  if (driver === 'redis' || driver === 'mongodb') {
    return
  }
  const dialect = driver ?? 'postgres'
  const probeSql = kind === 'where' ? `SELECT 1 FROM _t WHERE ${clause}` : `SELECT 1 FROM _t ORDER BY ${clause}`
  if (isMutatingStatement(probeSql, dialect)) {
    throw createHostError('not_permitted', READ_ONLY_MUTATION_ERROR)
  }
  const clean = stripCommentsAndLiterals(clause, dialect)
  if (
    READ_ONLY_FILTER_FORBIDDEN_CALL_RE.test(clean) ||
    /\b(?:INTO\s+(?:OUTFILE|DUMPFILE)|FOR\s+(?:NO\s+KEY\s+)?UPDATE|NEXT\s+VALUE\s+FOR)\b/i.test(clean)
  ) {
    throw createHostError('not_permitted', READ_ONLY_MUTATION_ERROR)
  }
}

export function registerDataAndSchemaHandlers({
  orca,
  registerHandler: rawRegisterHandler,
  sessionManager,
  schemaCache,
  txOwnership,
  copyImportRegistry,
  tableDisplayStateStore,
  erLayoutStateStore,
}: DataSchemaHandlersDeps): void {
  const tx = txOwnership ?? new TxOwnershipController()
  const catalog = schemaCache instanceof SchemaCatalog ? schemaCache : null
  const registerHandler = ((
    name: Parameters<WorkerRegisterHandler>[0],
    handler: (input: never, ctx: never) => unknown
  ) =>
    rawRegisterHandler(name as never, (async (input: never, ctx: never) => {
      try {
        return await handler(input, ctx)
      } catch (err: unknown) {
        throw scrubAndEnhanceWorkerError(err)
      }
    }) as never)) as WorkerRegisterHandler

  registerHandler(
    'schema.listObjects',
    async (input, ctx): Promise<SchemaObject[]> => {
      if (!input?.connectionId) {
        throw createHostError('invalid_params', 'connectionId parameter is required')
      }
      if (catalog) {
        return await catalog.listObjects(input.connectionId, input.schema, {
          signal: ctx?.signal,
        })
      }
      const session = await sessionManager.getSession(input.connectionId)
      const objects = await session.listObjects(input.schema)
      schemaCache?.setObjects(input.connectionId, objects, input.schema)
      return objects
    }
  )

  registerHandler(
    'schema.listObjectsCatalog',
    async (input, ctx): Promise<SchemaCatalogObjectsResult> => {
      if (!input?.connectionId) {
        throw createHostError('invalid_params', 'connectionId parameter is required')
      }
      if (catalog) {
        return await catalog.listObjectsCatalog(input.connectionId, input.schema, {
          forceRefresh: Boolean(input.forceRefresh),
          signal: ctx?.signal,
        })
      }
      const session = await sessionManager.getSession(input.connectionId)
      const objects = await session.listObjects(input.schema)
      schemaCache?.setObjects(input.connectionId, objects, input.schema)
      const revision = schemaCache?.getConnectionRevision(input.connectionId) ?? 1
      return {
        data: objects,
        stale: false,
        cachedAt: Date.now(),
        revision,
      }
    }
  )

  registerHandler(
    'schema.erGraph',
    async (input, ctx): Promise<SchemaErGraph> => {
      if (!input?.connectionId) {
        throw createHostError('invalid_params', 'connectionId parameter is required')
      }
      if (catalog) {
        return await catalog.getErGraph(input.connectionId, {
          schema: input.schema,
          includeViews: input.includeViews,
          forceRefresh: Boolean(input.forceRefresh),
          signal: ctx?.signal,
        })
      }
      const session = await sessionManager.getSession(input.connectionId)
      if (typeof session.introspectErGraph === 'function') {
        return await session.introspectErGraph(input.schema)
      }
      const allObjects = await session.listObjects(input.schema)
      const includeViews = input.includeViews !== false
      const tabular = allObjects.filter(
        (obj) => obj.kind === 'table' || (includeViews && obj.kind === 'view')
      )
      const capped = tabular.slice(0, ER_LITE_FALLBACK_MAX_TABLES)
      const detailsList: TableDetails[] = []
      for (const obj of capped) {
        const det = await session.getTableDetails(obj.name, obj.schema || input.schema)
        const liteDet: TableDetails = { ...det, completeness: 'lite' }
        detailsList.push(liteDet)
        schemaCache?.setTableDetails(input.connectionId, liteDet)
      }
      return buildSchemaErGraphFromTableDetails(input.connectionId, detailsList, {
        schema: input.schema,
        completeness: 'lite',
        maxTables: ER_LITE_FALLBACK_MAX_TABLES,
        totalTableCount: tabular.length,
      })
    }
  )

  registerHandler(
    'schema.tableDetails',
    async (input, ctx): Promise<TableDetails> => {
      if (!input?.connectionId) {
        throw createHostError('invalid_params', 'connectionId parameter is required')
      }
      if (!input?.table) {
        throw createHostError('invalid_params', 'Table parameter is required')
      }
      if (catalog) {
        return await catalog.getTableDetails(input.connectionId, input.table, input.schema, {
          signal: ctx?.signal,
        })
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
      const fullDetails: TableDetails = { ...details, completeness: 'full' }
      schemaCache?.setTableDetails(input.connectionId, fullDetails)
      return fullDetails
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

  registerHandler('schema.listSchemas', async (input) => {
    if (typeof input?.connectionId !== 'string' || input.connectionId.trim().length === 0) {
      throw createHostError('invalid_params', 'connectionId parameter is required')
    }
    const session = await sessionManager.getSession(input.connectionId)
    if (typeof session.listSchemas !== 'function') {
      const fallback = session.profile.database || ''
      return { schemas: fallback ? [fallback] : [], defaultSchema: fallback }
    }
    return sanitizeJsonPayload(await session.listSchemas())
  })

  registerHandler('schema.getObjectDdl', async (input) => {
    if (typeof input?.connectionId !== 'string' || input.connectionId.trim().length === 0) {
      throw createHostError('invalid_params', 'connectionId parameter is required')
    }
    if (typeof input?.name !== 'string' || input.name.trim().length === 0) {
      throw createHostError('invalid_params', 'Object name is required')
    }
    if (input.schema !== undefined && typeof input.schema !== 'string') {
      throw createHostError('invalid_params', 'schema parameter must be a string')
    }
    if (!ALLOWED_SCHEMA_OBJECT_KINDS.includes(input.kind)) {
      throw createHostError('invalid_params', `Unsupported object kind: ${String(input.kind)}`)
    }
    const session = await sessionManager.getSession(input.connectionId)
    if (typeof session.getObjectDdl !== 'function') {
      throw createHostError(
        'invalid_params',
        `Object DDL is not supported for driver '${session.driverType}'`
      )
    }
    const ddl = await session.getObjectDdl(input.name.trim(), input.kind, input.schema)
    return { ddl }
  })

  registerHandler('schema.exportSchemaDdl', async (input) => {
    if (typeof input?.connectionId !== 'string' || input.connectionId.trim().length === 0) {
      throw createHostError('invalid_params', 'connectionId parameter is required')
    }
    const session = await sessionManager.getSession(input.connectionId)
    if (typeof session.exportSchemaDdl !== 'function') {
      throw createHostError(
        'invalid_params',
        `Full schema DDL export is not supported for driver '${session.driverType}'`
      )
    }
    const requestedSchema =
      typeof input.schema === 'string' && input.schema.trim().length > 0
        ? input.schema.trim()
        : undefined
    const result = await session.exportSchemaDdl(requestedSchema)
    const profile = await sessionManager.findProfile(input.connectionId)
    const label =
      requestedSchema || profile?.database || session.profile.database || 'schema'
    const safeSchema = sanitizeSchemaFileName(label)
    return {
      ddl: result.ddl,
      objectCount: result.objectCount,
      fileName: `${safeSchema}_schema.sql`,
    }
  })

  registerHandler(
    'data.fetchPage',
    async (input, ctx): Promise<TableBrowseResult> => {
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
      if (profile?.readOnly) {
        assertReadOnlyFilterClauseSafe(whereClause, 'where', profile.driver)
        assertReadOnlyFilterClauseSafe(orderByClause, 'orderBy', profile.driver)
      }

      const rawPage = Number(input.page)
      const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1
      const rawPageSize = Number(input.pageSize)
      const pageSize =
        Number.isFinite(rawPageSize) && rawPageSize >= 1
          ? Math.max(1, Math.min(10000, Math.floor(rawPageSize)))
          : 50
      const session = await sessionManager.getSession(input.connectionId)
      copyImportRegistry?.assertNoActiveImport(input.connectionId)
      const panelId = tx.getPanelId(ctx)
      const fetchDecision = await tx.withLock(input.connectionId, async () => {
        const txState =
          typeof session.getTransactionState === 'function' ? session.getTransactionState() : undefined
        const bypassTransaction = tx.isForeignOwned(input.connectionId, session, panelId, txState)
        const needsSerializedRead = Boolean(!bypassTransaction && (txState?.active || txState?.autoCommit === false))
        if (needsSerializedRead) {
          const result = await session.fetchPage({
            table: input.table,
            schema: input.schema,
            page,
            pageSize,
            sortColumn: input.sortColumn,
            sortDirection: input.sortDirection,
            whereClause,
            orderByClause,
            bypassTransaction,
          })
          return { executed: true as const, result }
        }
        return { executed: false as const, bypassTransaction }
      })
      if (fetchDecision.executed) {
        return fetchDecision.result
      }
      return await session.fetchPage({
        table: input.table,
        schema: input.schema,
        page,
        pageSize,
        sortColumn: input.sortColumn,
        sortDirection: input.sortDirection,
        whereClause,
        orderByClause,
        bypassTransaction: fetchDecision.bypassTransaction,
      })
    }
  )

  registerHandler('data.updateCell', async (input, ctx) => {
    if (!input?.connectionId) {
      throw createHostError('invalid_params', 'connectionId parameter is required')
    }
    if (!input?.table || !input.column || !input.primaryKeys) {
      throw createHostError('invalid_params', 'Missing required update parameters')
    }
    if (
      typeof input.primaryKeys !== 'object' ||
      Array.isArray(input.primaryKeys) ||
      Object.keys(input.primaryKeys).length === 0
    ) {
      throw createHostError('invalid_params', 'Primary keys are required for cell update')
    }

    await assertMutableConnection(sessionManager, input.connectionId)
    copyImportRegistry?.assertNoActiveImport(input.connectionId)
    assertNoCompactedPreviewOverwrite(input.newValue, input.column)
    const session = await sessionManager.getSession(input.connectionId)
    const panelId = tx.getPanelId(ctx)
    const result = await tx.withLock(input.connectionId, async () => {
      const preState =
        typeof session.getTransactionState === 'function' ? session.getTransactionState() : undefined
      if (tx.isForeignOwned(input.connectionId, session, panelId, preState)) {
        throw createHostError(
          'forbidden',
          'Cannot modify data while another editor panel owns a transaction on this connection.'
        )
      }
      const wasActive = Boolean(preState?.active)
      try {
        return await session.updateCell({
          table: input.table,
          schema: input.schema,
          primaryKeys: input.primaryKeys,
          column: input.column,
          newValue: input.newValue,
          originalValue: input.originalValue,
        })
      } finally {
        if (typeof session.getTransactionState === 'function') {
          tx.reconcileAfterWrite(
            input.connectionId,
            session,
            panelId,
            wasActive,
            session.getTransactionState()
          )
        }
      }
    })

    postCellUpdatedBounded(orca, {
      connectionId: input.connectionId,
      schema: input.schema,
      table: input.table,
      primaryKeys: input.primaryKeys,
      column: input.column,
    })

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
      deleteRows: input.deleteRows,
    })
  })

  registerHandler('data.applyChanges', async (input, ctx) => {
    if (!input?.connectionId) {
      throw createHostError('invalid_params', 'connectionId parameter is required')
    }
    if (!input?.table) {
      throw createHostError('invalid_params', 'Table parameter is required')
    }
    await assertMutableConnection(sessionManager, input.connectionId)
    copyImportRegistry?.assertNoActiveImport(input.connectionId)
    if (Array.isArray(input.inserts)) {
      for (const row of input.inserts) {
        if (row && typeof row === 'object') {
          for (const [col, val] of Object.entries(row)) {
            assertNoCompactedPreviewOverwrite(val, col)
          }
        }
      }
    }
    if (Array.isArray(input.updates)) {
      for (const upd of input.updates) {
        if (upd?.changes && typeof upd.changes === 'object') {
          for (const [col, val] of Object.entries(upd.changes)) {
            assertNoCompactedPreviewOverwrite(val, col)
          }
        }
      }
    }
    const session = await sessionManager.getSession(input.connectionId)
    const panelId = tx.getPanelId(ctx)
    const res = await tx.withLock(input.connectionId, async () => {
      const preState =
        typeof session.getTransactionState === 'function' ? session.getTransactionState() : undefined
      if (tx.isForeignOwned(input.connectionId, session, panelId, preState)) {
        throw createHostError(
          'forbidden',
          'Cannot modify data while another editor panel owns a transaction on this connection.'
        )
      }
      const wasActive = Boolean(preState?.active)
      try {
        return await session.applyChanges({
          table: input.table,
          schema: input.schema,
          inserts: input.inserts,
          updates: input.updates,
          deletes: input.deletes,
          deleteRows: input.deleteRows,
        })
      } finally {
        if (typeof session.getTransactionState === 'function') {
          tx.reconcileAfterWrite(
            input.connectionId,
            session,
            panelId,
            wasActive,
            session.getTransactionState()
          )
        }
      }
    })

    const firstUpdate = input.updates?.[0]
    postCellUpdatedBounded(orca, {
      connectionId: input.connectionId,
      schema: input.schema,
      table: input.table,
      primaryKeys: firstUpdate?.primaryKeys ?? {},
      column: firstUpdate ? Object.keys(firstUpdate.changes)[0] || '*' : '*',
    })
    return res
  })

  registerHandler('data.copyImport.open', async (input, ctx) => {
    if (typeof input?.connectionId !== 'string' || input.connectionId.trim().length === 0) {
      throw createHostError('invalid_params', 'connectionId parameter is required')
    }
    if (typeof input?.table !== 'string' || input.table.trim().length === 0) {
      throw createHostError('invalid_params', 'Table parameter is required')
    }
    if (!Array.isArray(input.columns) || input.columns.length === 0) {
      throw createHostError('invalid_params', 'columns array must be non-empty for COPY import')
    }
    if (!copyImportRegistry) {
      return {
        ok: false,
        useLegacyBatch: true,
        fallbackReason: 'Streaming COPY import registry is unavailable',
      }
    }

    await assertMutableConnection(sessionManager, input.connectionId)
    const panelId = tx.getPanelId(ctx)
    return await tx.withLock(input.connectionId, async () => {
      copyImportRegistry.assertNoActiveImport(input.connectionId)

      const session = await sessionManager.getSession(input.connectionId)
      const txState =
        typeof session.getTransactionState === 'function' ? session.getTransactionState() : undefined
      if (tx.isForeignOwned(input.connectionId, session, panelId, txState)) {
        throw createHostError(
          'forbidden',
          'Cannot import data while another editor panel owns a transaction on this connection.'
        )
      }

      if (typeof session.openCopyImport !== 'function') {
        return {
          ok: false,
          useLegacyBatch: true,
          fallbackReason: `Streaming COPY import is not supported for driver '${session.driverType}'`,
        }
      }

      try {
        const handle = await session.openCopyImport({
          table: input.table,
          schema: input.schema,
          columns: input.columns,
          signal: ctx?.signal,
        })
        if (!handle.supported) {
          return {
            ok: false,
            useLegacyBatch: true,
            fallbackReason:
              handle.fallbackReason ||
              `Streaming COPY import is not supported for driver '${session.driverType}'`,
          }
        }
        try {
          const importId = copyImportRegistry.register({
            connectionId: input.connectionId,
            table: input.table,
            schema: input.schema,
            columns: input.columns,
            panelId,
            handle,
          })
          return { ok: true, importId }
        } catch (regErr) {
          await handle.abort('Failed to register COPY import stream').catch(() => {})
          throw regErr
        }
      } catch (err: unknown) {
        const code =
          err && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code) : ''
        if (code === '0A000' || code === 'NOT_SUPPORTED') {
          return {
            ok: false,
            useLegacyBatch: true,
            fallbackReason: err instanceof Error ? err.message : String(err),
          }
        }
        throw err
      }
    })
  })

  registerHandler('data.copyImport.write', async (input, ctx) => {
    if (!copyImportRegistry) {
      throw createHostError('invalid_params', 'Streaming COPY import registry is unavailable')
    }
    if (!input?.importId || typeof input.importId !== 'string') {
      throw createHostError('invalid_params', 'importId parameter is required')
    }
    if (!Array.isArray(input.rows)) {
      throw createHostError('invalid_params', 'rows array is required')
    }
    const jsonBytes = Buffer.byteLength(JSON.stringify(input), 'utf8')
    if (jsonBytes > COPY_IMPORT_MAX_CHUNK_BYTES) {
      throw createHostError(
        'invalid_params',
        `COPY chunk JSON payload (${jsonBytes} B) exceeds 512 KiB (${COPY_IMPORT_MAX_CHUNK_BYTES} B) limit.`
      )
    }
    const panelId = tx.getPanelId(ctx)
    const res = await copyImportRegistry.write(input.importId, input.rows, panelId)
    return {
      ok: true,
      bytesWritten: res.bytesWritten,
      rowCount: res.rowCount,
    }
  })

  registerHandler('data.copyImport.commit', async (input, ctx) => {
    if (!copyImportRegistry) {
      throw createHostError('invalid_params', 'Streaming COPY import registry is unavailable')
    }
    if (!input?.importId || typeof input.importId !== 'string') {
      throw createHostError('invalid_params', 'importId parameter is required')
    }
    const panelId = tx.getPanelId(ctx)
    const committed = await copyImportRegistry.commit(input.importId, panelId)
    postCellUpdatedBounded(orca, {
      connectionId: committed.connectionId,
      schema: committed.schema,
      table: committed.table,
      primaryKeys: {},
      column: '*',
    })
    return {
      ok: true,
      inserted: committed.inserted,
    }
  })

  registerHandler('data.copyImport.abort', async (input, ctx) => {
    if (!copyImportRegistry) {
      return { ok: true }
    }
    if (!input?.importId || typeof input.importId !== 'string') {
      throw createHostError('invalid_params', 'importId parameter is required')
    }
    const panelId = tx.getPanelId(ctx)
    await copyImportRegistry.abort(input.importId, input.reason, panelId)
    return { ok: true }
  })

  if (tableDisplayStateStore) {
    registerHandler('ui.tableDisplayState.get', async (input) => {
      const tableKey = assertValidTableDisplayKey(input?.tableKey, true)
      return await tableDisplayStateStore.get(tableKey)
    })

    registerHandler('ui.tableDisplayState.patch', async (input) => {
      const tableKey = assertValidTableDisplayKey(input?.tableKey, true)
      if (!input?.patch || typeof input.patch !== 'object' || Array.isArray(input.patch)) {
        throw createHostError('invalid_params', 'patch object is required')
      }
      return await tableDisplayStateStore.patch({
        tableKey,
        patch: input.patch,
        baseRevision: input.baseRevision,
      })
    })

    registerHandler('ui.tableDisplayState.reset', async (input) => {
      if (input?.tableKey !== undefined) {
        assertValidTableDisplayKey(input.tableKey, true)
      }
      if (
        typeof input?.connectionId === 'string' &&
        Buffer.byteLength(input.connectionId, 'utf8') > MAX_TABLE_DISPLAY_KEY_BYTES
      ) {
        throw createHostError(
          'invalid_params',
          `connectionId exceeds maximum ${MAX_TABLE_DISPLAY_KEY_BYTES} UTF-8 byte limit`
        )
      }
      return await tableDisplayStateStore.reset(input ?? {})
    })
  }

  if (erLayoutStateStore) {
    registerHandler('ui.erLayoutState.get', async (input) => {
      if (typeof input?.schemaKey !== 'string' || input.schemaKey.trim().length === 0) {
        throw createHostError('invalid_params', 'schemaKey parameter is required')
      }
      return await erLayoutStateStore.get(input.schemaKey)
    })

    registerHandler('ui.erLayoutState.patch', async (input) => {
      if (typeof input?.schemaKey !== 'string' || input.schemaKey.trim().length === 0) {
        throw createHostError('invalid_params', 'schemaKey parameter is required')
      }
      if (!input.patch || typeof input.patch !== 'object' || Array.isArray(input.patch)) {
        throw createHostError('invalid_params', 'patch object is required')
      }
      return await erLayoutStateStore.patch({
        schemaKey: input.schemaKey,
        patch: input.patch,
      })
    })

    registerHandler('ui.erLayoutState.reset', async (input) => {
      return await erLayoutStateStore.reset(input ?? {})
    })
  }
}
