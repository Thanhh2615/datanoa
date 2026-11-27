import type { OrcaWorkerApi, PanelRequestContext } from 'orca/worker'
import { sanitizeJsonPayload } from '../protocol'
import { DriverManager } from '../drivers/driver-manager'
import { CopyImportRegistry } from './copy-import-registry'
import { ErLayoutStateStore } from './er-layout-state-store'
import { registerAiHandlers, type AiHandlersController } from './rpc-ai'
import { registerConnectionHandlers, type ConnectionHandlersController } from './rpc-connections'
import { registerDataAndSchemaHandlers } from './rpc-data-schema'
import { registerQueryAndTxHandlers } from './rpc-query-tx'
import { SchemaCatalog } from './schema-catalog'
import { SessionManager } from './session-manager'
import { SshHostKeyChallengeStore } from './ssh-host-key-challenge-store'
import { TableDisplayStateStore } from './table-display-state-store'
import { TxOwnershipController } from './tx-ownership'
import {
  clearInMemoryUiSessionSnapshots,
  createQueryRuntimeTracker,
  createStudioNavTokenConsumer,
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

interface WorkerSshManagerHandle {
  dispose: () => void
}

let currentSshManager: WorkerSshManagerHandle | null = null
let currentSessionManager: SessionManager | null = null
let currentSchemaCatalog: SchemaCatalog | null = null
let currentCopyImportRegistry: CopyImportRegistry | null = null
let currentTableDisplayStateStore: TableDisplayStateStore | null = null
let currentErLayoutStateStore: ErLayoutStateStore | null = null
let currentAiController: AiHandlersController | null = null
let currentTxOwnership: TxOwnershipController | null = null
let currentConnController: ConnectionHandlersController | null = null
let prevTeardownPromise: Promise<void> = Promise.resolve()
let activationGeneration = 0
const queryTracker = createQueryRuntimeTracker()

function captureAndResetWorkerHandles() {
  const prev = {
    aiController: currentAiController,
    connController: currentConnController,
    txOwnership: currentTxOwnership,
    copyImportRegistry: currentCopyImportRegistry,
    schemaCatalog: currentSchemaCatalog,
    tableDisplayStateStore: currentTableDisplayStateStore,
    erLayoutStateStore: currentErLayoutStateStore,
    sessionManager: currentSessionManager,
    sshManager: currentSshManager,
  }
  currentAiController = null
  currentConnController = null
  currentTxOwnership = null
  currentCopyImportRegistry = null
  currentSchemaCatalog = null
  currentTableDisplayStateStore = null
  currentErLayoutStateStore = null
  currentSessionManager = null
  currentSshManager = null
  prev.tableDisplayStateStore?.beginTeardown()
  prev.erLayoutStateStore?.beginTeardown()
  return prev
}

async function disposeCapturedHandles(
  prev: ReturnType<typeof captureAndResetWorkerHandles>
): Promise<void> {
  prev.aiController?.dispose()
  prev.connController?.clearDetectedCandidates()
  prev.txOwnership?.clearAll()
  await prev.copyImportRegistry?.dispose()
  prev.schemaCatalog?.dispose()
  await prev.tableDisplayStateStore?.flush()
  prev.tableDisplayStateStore?.dispose()
  await prev.erLayoutStateStore?.flush()
  prev.erLayoutStateStore?.dispose()
  await prev.sessionManager?.closeAll()
  prev.sshManager?.dispose()
  await flushHostConfigBackupWrites()
}

export default function activate(orca: OrcaWorkerApi): void {
  const myGeneration = ++activationGeneration
  const prevHandles = captureAndResetWorkerHandles()
  const hasPrev = Object.values(prevHandles).some(Boolean)
  if (hasPrev) {
    prevTeardownPromise = prevTeardownPromise
      .then(() => disposeCapturedHandles(prevHandles))
      .catch(() => {})
  }
  const waitForPrevTeardown = prevTeardownPromise
  const isActivationCurrent = () => activationGeneration === myGeneration

  // Acyclic DAG creation:
  // sshManager/challengeStore -> sessionManager -> schemaCatalog & copyImportRegistry;
  // tableDisplayStateStore & erLayoutStateStore -> rpc handlers
  const challengeStore = new SshHostKeyChallengeStore()
  const sshManager: WorkerSshManagerHandle = {
    dispose: () => {
      challengeStore.dispose()
    },
  }
  currentSshManager = sshManager

  let schemaCatalogRef: SchemaCatalog | null = null
  let copyImportRef: CopyImportRegistry | null = null

  const sessionManager = new SessionManager(orca, {
    challengeStore,
    onSessionClosed: async (connectionId) => {
      await copyImportRef?.abortByConnection(connectionId, 'Session closed')
      schemaCatalogRef?.onSessionClosed(connectionId)
    },
  })
  currentSessionManager = sessionManager

  const driverManager = new DriverManager(orca.storage, (message) => orca.log(message))
  sessionManager.setDriverManager(driverManager)

  const schemaCatalog = new SchemaCatalog({ sessionManager })
  schemaCatalogRef = schemaCatalog
  currentSchemaCatalog = schemaCatalog

  const copyImportRegistry = new CopyImportRegistry()
  copyImportRef = copyImportRegistry
  currentCopyImportRegistry = copyImportRegistry

  const tableDisplayStateStore = new TableDisplayStateStore({
    orca,
    beforeLoad: () => waitForPrevTeardown,
    isActive: isActivationCurrent,
  })
  currentTableDisplayStateStore = tableDisplayStateStore

  const erLayoutStateStore = new ErLayoutStateStore({
    orca,
    beforeLoad: () => waitForPrevTeardown,
    isActive: isActivationCurrent,
  })
  currentErLayoutStateStore = erLayoutStateStore

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

  const aiController = registerAiHandlers({
    orca,
    registerHandler,
    sessionManager,
    schemaCache: schemaCatalog,
  })
  currentAiController = aiController

  currentConnController = registerConnectionHandlers({
    orca,
    registerHandler,
    sessionManager,
    driverManager,
    schemaCache: schemaCatalog,
    challengeStore,
    tableDisplayStateStore,
    erLayoutStateStore,
  })
  registerDataAndSchemaHandlers({
    orca,
    registerHandler,
    sessionManager,
    schemaCache: schemaCatalog,
    txOwnership,
    copyImportRegistry,
    tableDisplayStateStore,
    erLayoutStateStore,
  })
  registerQueryAndTxHandlers({
    orca,
    registerHandler,
    sessionManager,
    tracker: queryTracker,
    schemaCache: schemaCatalog,
    txOwnership,
    copyImportRegistry,
    onHistoryChanged: aiController.invalidateHistoryCache,
  })

  const consumeStudioNavToken = createStudioNavTokenConsumer(orca)
  registerHandler('studio.open', async (input) => {
    return await openStudioDocumentInOrca(orca, input, sessionManager)
  })
  registerHandler('studio.navToken.consume', async (input) => {
    return await consumeStudioNavToken(input?.navToken ?? '')
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
  activationGeneration += 1
  const prevHandles = captureAndResetWorkerHandles()
  queryTracker.clear()
  clearInMemoryUiSessionSnapshots()
  prevTeardownPromise = prevTeardownPromise
    .then(() => disposeCapturedHandles(prevHandles))
    .catch(() => {})
  await prevTeardownPromise
}
