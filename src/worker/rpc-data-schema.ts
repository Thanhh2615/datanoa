import type { OrcaWorkerApi } from 'orca/worker'
import {
  sanitizeJsonPayload,
  type ConnectionProfile,
  type SchemaObject,
  type SchemaObjectKind,
  type TableBrowseResult,
  type TableDetails,
} from '../protocol'
import { sanitizeSchemaFileName } from '../drivers/common/schema'
import {
  isMutatingStatement,
  reconstructTableDdl,
  sanitizeFilterClause,
  stripCommentsAndLiterals,
} from '../drivers/common/sql-tools'
import type { WorkerSchemaMetadataCache } from './ai-sql-context'
import type { SessionManager } from './session-manager'
import { TxOwnershipController } from './tx-ownership'
import {
  assertMutableConnection,
  assertNoCompactedPreviewOverwrite,
  createHostError,
  READ_ONLY_MUTATION_ERROR,
  scrubAndEnhanceWorkerError,
  type WorkerRegisterHandler,
} from './worker-utils'

export interface DataSchemaHandlersDeps {
  orca: OrcaWorkerApi
  registerHandler: WorkerRegisterHandler
  sessionManager: SessionManager
  schemaCache?: WorkerSchemaMetadataCache
  txOwnership?: TxOwnershipController
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
}: DataSchemaHandlersDeps): void {
  const tx = txOwnership ?? new TxOwnershipController()
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
    async (input): Promise<SchemaObject[]> => {
      if (!input?.connectionId) {
        throw createHostError('invalid_params', 'connectionId parameter is required')
      }
      const session = await sessionManager.getSession(input.connectionId)
      const objects = await session.listObjects(input.schema)
      schemaCache?.setObjects(input.connectionId, objects, input.schema)
      return objects
    }
  )

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
      schemaCache?.setTableDetails(input.connectionId, details)
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
}
