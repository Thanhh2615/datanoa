import type { OrcaWorkerApi } from 'orca/worker'
import {
  sanitizeJsonPayload,
  type SchemaObject,
  type SchemaObjectKind,
  type TableBrowseResult,
  type TableDetails,
} from '../protocol'
import { sanitizeSchemaFileName } from '../drivers/common/schema'
import { reconstructTableDdl, sanitizeFilterClause } from '../drivers/common/sql-tools'
import type { SessionManager } from './session-manager'
import {
  assertMutableConnection,
  assertNoCompactedPreviewOverwrite,
  createHostError,
  type WorkerRegisterHandler,
} from './worker-utils'

export interface DataSchemaHandlersDeps {
  orca: OrcaWorkerApi
  registerHandler: WorkerRegisterHandler
  sessionManager: SessionManager
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

export function registerDataAndSchemaHandlers({
  orca,
  registerHandler,
  sessionManager,
}: DataSchemaHandlersDeps): void {
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

  registerHandler('data.updateCell', async (input) => {
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
}
