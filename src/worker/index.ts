import type { OrcaWorkerApi, PanelRequestContext } from 'orca/worker'
import { sanitizeJsonPayload } from '../protocol'
import { DriverManager } from '../drivers/driver-manager'
import { SessionManager } from './session-manager'
import { registerConnectionHandlers } from './rpc-connections'
import { registerDataAndSchemaHandlers } from './rpc-data-schema'
import { registerQueryAndTxHandlers } from './rpc-query-tx'
import {
  clearInMemoryUiSessionSnapshots,
  createQueryRuntimeTracker,
  fitResponseWithinOrcaIpcLimit,
  flushHostConfigBackupWrites,
  openStudioDocumentInOrca,
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
const queryTracker = createQueryRuntimeTracker()

export default function activate(orca: OrcaWorkerApi): void {
  if (currentSessionManager) {
    void currentSessionManager.closeAll().catch(() => {})
    currentSessionManager = null
  }
  const sessionManager = new SessionManager(orca)
  currentSessionManager = sessionManager
  const driverManager = new DriverManager(orca.storage, (message) => orca.log(message))
  sessionManager.setDriverManager(driverManager)

  // Wrap orca.panels.handle so every returned value is guaranteed to be strict JSON
  // (no undefined keys, no null-prototype objects from node:sqlite, no BigInt/Uint8Array)
  const rawHandle = orca.panels.handle.bind(orca.panels)
  const registerHandler = ((
    name: Parameters<typeof orca.panels.handle>[0],
    handler: (input: never, ctx: PanelRequestContext) => unknown
  ) => {
    return rawHandle(name as never, async (input: unknown, ctx: PanelRequestContext) => {
      const res = await handler(input as never, ctx)
      return fitResponseWithinOrcaIpcLimit(sanitizeJsonPayload(res)) as never
    })
  }) as WorkerRegisterHandler

  registerConnectionHandlers({ orca, registerHandler, sessionManager, driverManager })
  registerDataAndSchemaHandlers({ orca, registerHandler, sessionManager })
  registerQueryAndTxHandlers({ orca, registerHandler, sessionManager, tracker: queryTracker })

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
  if (currentSessionManager) {
    await currentSessionManager.closeAll()
    currentSessionManager = null
  }
  queryTracker.clear()
  clearInMemoryUiSessionSnapshots()
  await flushHostConfigBackupWrites()
}
