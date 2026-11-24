import type { OrcaWorkerApi, PanelRequestContext } from 'orca/worker'
import { sanitizeJsonPayload } from '../protocol'
import { DriverManager } from '../drivers/driver-manager'
import { SessionManager } from './session-manager'
import { registerConnectionHandlers, type ConnectionHandlersController } from './rpc-connections'
import { registerDataAndSchemaHandlers } from './rpc-data-schema'
import { registerQueryAndTxHandlers } from './rpc-query-tx'
import { TxOwnershipController } from './tx-ownership'
import { WorkerSchemaMetadataCache } from './ai-sql-context'
import { registerAiHandlers, type AiHandlersController } from './rpc-ai'
import {
  clearInMemoryUiSessionSnapshots,
  createQueryRuntimeTracker,
  fitResponseWithinOrcaIpcLimit,
  flushHostConfigBackupWrites,
  openStudioDocumentInOrca,
  scrubAndEnhanceWorkerError,
  type WorkerRegisterHandler,
} from './worker-utils'

export {
  detectWorkspaceEnvConnections,
  discoverWorkspaceSqliteFiles,
  isBlockedScanRoot,
  resolveSqliteFilePath,
  scanDirectoryForSqliteFiles,
} from './discovery'
export { SessionManager } from './session-manager'

let currentSessionManager: SessionManager | null = null
let currentAiController: AiHandlersController | null = null
let currentTxOwnership: TxOwnershipController | null = null
let currentConnController: ConnectionHandlersController | null = null
const queryTracker = createQueryRuntimeTracker()

export default function activate(orca: OrcaWorkerApi): void {
  if (currentAiController) {
    currentAiController.dispose()
    currentAiController = null
  }
  if (currentConnController) {
    currentConnController.clearDetectedCandidates()
    currentConnController = null
  }
  if (currentTxOwnership) {
    currentTxOwnership.clearAll()
    currentTxOwnership = null
  }
  if (currentSessionManager) {
    void currentSessionManager.closeAll().catch(() => {})
    currentSessionManager = null
  }
  const sessionManager = new SessionManager(orca)
  currentSessionManager = sessionManager
  const driverManager = new DriverManager(orca.storage, (message) => orca.log(message))
  sessionManager.setDriverManager(driverManager)
  const schemaCache = new WorkerSchemaMetadataCache()
  const txOwnership = new TxOwnershipController()
  currentTxOwnership = txOwnership

  // Wrap orca.panels.handle so every returned value is guaranteed to be strict JSON
  // (no undefined keys, no null-prototype objects from node:sqlite, no BigInt/Uint8Array)
  const rawHandle = orca.panels.handle.bind(orca.panels)
  const registerHandler = ((
    name: Parameters<typeof orca.panels.handle>[0],
    handler: (input: never, ctx: PanelRequestContext) => unknown
  ) => {
    return rawHandle(name as never, async (input: unknown, ctx: PanelRequestContext) => {
      try {
        const res = await handler(input as never, ctx)
        return fitResponseWithinOrcaIpcLimit(sanitizeJsonPayload(res)) as never
      } catch (err: unknown) {
        throw scrubAndEnhanceWorkerError(err)
      }
    })
  }) as WorkerRegisterHandler

  const aiController = registerAiHandlers({ orca, registerHandler, sessionManager, schemaCache })
  currentAiController = aiController

  currentConnController = registerConnectionHandlers({
    orca,
    registerHandler,
    sessionManager,
    driverManager,
    schemaCache,
  })
  registerDataAndSchemaHandlers({ orca, registerHandler, sessionManager, schemaCache, txOwnership })
  registerQueryAndTxHandlers({
    orca,
    registerHandler,
    sessionManager,
    tracker: queryTracker,
    schemaCache,
    txOwnership,
    onHistoryChanged: aiController.invalidateHistoryCache,
  })

  registerHandler('studio.open', async (input) => {
    return await openStudioDocumentInOrca(orca, input, sessionManager)
  })

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
  if (currentAiController) {
    currentAiController.dispose()
    currentAiController = null
  }
  if (currentConnController) {
    currentConnController.clearDetectedCandidates()
    currentConnController = null
  }
  if (currentTxOwnership) {
    currentTxOwnership.clearAll()
    currentTxOwnership = null
  }
  if (currentSessionManager) {
    await currentSessionManager.closeAll()
    currentSessionManager = null
  }
  queryTracker.clear()
  clearInMemoryUiSessionSnapshots()
  await flushHostConfigBackupWrites()
}
