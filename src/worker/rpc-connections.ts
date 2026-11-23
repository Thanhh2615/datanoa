import * as fs from 'node:fs'
import * as path from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import {
  ACTIVE_CONNECTION_STORAGE_KEY,
  type ConnectionProfile,
  type PersistedLocalDriverConfig,
} from '../protocol'
import { CUSTOM_DRIVERS_STORAGE_KEY } from '../shared-constants'
import {
  isD1HttpLoopbackEndpoint,
  parseConnectionUri,
  SUPPORTED_DRIVERS,
  validateD1EndpointUrl,
} from '../drivers/common/connection-uri'
import { isByodDriverId, type DriverManager } from '../drivers/driver-manager'
import {
  detectWorkspaceEnvConnections,
  discoverWorkspaceSqliteFiles,
  formatByteSize,
  getLocalWorkspaceDirs,
  scanDirectoryForSqliteFiles,
  type DiscoveredSqliteFile,
} from './discovery'
import { detectWorkspaceDockerComposeConnections } from './docker-compose-discovery'
import type { SessionManager } from './session-manager'
import {
  createHostError,
  createSerializedQueue,
  getDefaultByodDriverDirs,
  getUiSessionSnapshot,
  listDirectoryForPicker,
  listWorkspaceScopesForUi,
  normalizeSqliteProfile,
  readHostConfigBackup,
  sanitizeConnectionProfile,
  saveUiSessionSnapshot,
  scaffoldLocalDriverDirectory,
  writeHostConfigBackupPatch,
  type WorkerRegisterHandler,
} from './worker-utils'

export interface ConnectionHandlersDeps {
  orca: OrcaWorkerApi
  registerHandler: WorkerRegisterHandler
  sessionManager: SessionManager
  driverManager: DriverManager
}

export function registerConnectionHandlers({
  orca,
  registerHandler,
  sessionManager,
  driverManager,
}: ConnectionHandlersDeps): void {
  const connectionsQueue = createSerializedQueue()

  const isLiveDesktopHost = Boolean(orca.host && typeof orca.host.call === 'function')
  if (isLiveDesktopHost) {
    driverManager.setBackupLoader(async () => {
      const backup = await readHostConfigBackup()
      return Array.isArray(backup?.byodConfigs) ? backup.byodConfigs : null
    })
  }

  registerHandler('connections.list', async (): Promise<ConnectionProfile[]> => {
    await connectionsQueue.waitIdle()
    let stored = await sessionManager.getStoredConnections()
    if (stored.length === 0 && isLiveDesktopHost) {
      stored = await connectionsQueue.run(async () => {
        const latest = await sessionManager.getStoredConnections()
        if (latest.length > 0) return latest
        const backup = await readHostConfigBackup()
        if (Array.isArray(backup?.connections) && backup.connections.length > 0) {
          const sanitizedBackup = backup.connections
            .filter((c) => c && typeof c === 'object' && typeof c.id === 'string' && c.id.length > 0)
            .map(sanitizeConnectionProfile)
          if (sanitizedBackup.length > 0) {
            await sessionManager.saveStoredConnections(sanitizedBackup)
            return sanitizedBackup
          }
        }
        return latest
      })
    }
    const cleaned = stored.filter(
      (c) =>
        c &&
        typeof c === 'object' &&
        typeof c.id === 'string' &&
        c.id.length > 0 &&
        !c.id.startsWith('ws_')
    )
    if (cleaned.length !== stored.length) {
      await connectionsQueue.run(async () => {
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

  registerHandler('connection.save', async (input) => {
    if (!input || !input.profile || !input.profile.driver) {
      throw createHostError('invalid_params', 'Missing profile configuration')
    }
    if (
      !SUPPORTED_DRIVERS.includes(input.profile.driver) &&
      !isByodDriverId(input.profile.driver)
    ) {
      throw createHostError(
        'invalid_params',
        `Unsupported database driver: ${String(input.profile.driver)}`
      )
    }

    if (
      input.profile.driver === 'd1' &&
      typeof input.profile.url === 'string' &&
      input.profile.url.trim().length > 0
    ) {
      const checked = validateD1EndpointUrl(input.profile.url)
      if (!checked.ok) {
        throw createHostError('invalid_params', checked.error)
      }
    }

    const normalized = await normalizeSqliteProfile(input.profile)
    const id =
      normalized.id && !normalized.id.startsWith('ws_')
        ? normalized.id
        : `conn_${normalized.driver}_${Date.now()}`
    const d1HttpLoopback =
      normalized.driver === 'd1' &&
      typeof normalized.url === 'string' &&
      isD1HttpLoopbackEndpoint(normalized.url)

    const rawProfile = input.profile as unknown as Record<string, unknown>
    const hasOwn = (key: string): boolean => Object.prototype.hasOwnProperty.call(rawProfile, key)
    const sshExplicitlyDisabled = hasOwn('sshEnabled') && !input.profile.sshEnabled

    return await connectionsQueue.run(async () => {
      if (d1HttpLoopback) {
        let effectiveToken: string | undefined
        if (input.authToken !== undefined) {
          effectiveToken = input.authToken
        } else {
          if (input.sourceConnectionId) {
            effectiveToken = await sessionManager.getSecret(input.sourceConnectionId, 'd1')
          }
          if (!effectiveToken) {
            effectiveToken = await sessionManager.getSecret(id, 'd1')
          }
        }
        if (effectiveToken && effectiveToken.trim().length > 0) {
          throw createHostError(
            'invalid_params',
            'Cloudflare D1 cannot send an API token over plain HTTP; use an HTTPS endpoint or remove the token for a localhost/loopback emulator.'
          )
        }
      }

      if (input.sourceConnectionId) {
        const copyPrefixes: string[] = []
        if (input.password === undefined) copyPrefixes.push('pwd')
        if (input.authToken === undefined) copyPrefixes.push('tok')
        if (input.sslKeyPassphrase === undefined) copyPrefixes.push('sslkey')
        if (input.sshPassphrase === undefined) copyPrefixes.push('sshpass')
        if (input.sshPassword === undefined) copyPrefixes.push('sshpwd')
        if (copyPrefixes.length > 0) {
          await sessionManager.copySecret(input.sourceConnectionId, id, copyPrefixes)
        }
      }
      await sessionManager.saveSecret(id, {
        password: input.password,
        authToken: input.authToken,
        sslKeyPassphrase: input.sslKeyPassphrase,
        sshPassphrase: input.sshPassphrase,
        sshPassword: input.sshPassword,
      })

      const list = await sessionManager.getStoredConnections()
      const idx = list.findIndex((c) => c.id === id)
      const existing = idx >= 0 ? list[idx] : undefined
      const merged: ConnectionProfile = { ...normalized }

      if (existing) {
        if (!hasOwn('folder')) merged.folder = existing.folder
        if (!hasOwn('workspaceScope')) merged.workspaceScope = existing.workspaceScope
        if (existing.driver === normalized.driver) {
          if (!hasOwn('sslMode')) merged.sslMode = existing.sslMode
          if (!hasOwn('sslCaPath')) merged.sslCaPath = existing.sslCaPath
          if (!hasOwn('sslCertPath')) merged.sslCertPath = existing.sslCertPath
          if (!hasOwn('sslKeyPath')) merged.sslKeyPath = existing.sslKeyPath
          if (!hasOwn('hasSslKeyPassphrase')) {
            merged.hasSslKeyPassphrase = existing.hasSslKeyPassphrase
          }
          if (!hasOwn('sslRejectUnauthorized')) {
            merged.sslRejectUnauthorized = existing.sslRejectUnauthorized
          }
          if (!hasOwn('d1AccountId')) merged.d1AccountId = existing.d1AccountId
          if (!hasOwn('d1DatabaseId')) merged.d1DatabaseId = existing.d1DatabaseId
          if (!hasOwn('sshEnabled')) merged.sshEnabled = existing.sshEnabled
          if (!sshExplicitlyDisabled) {
            if (!hasOwn('sshHost')) merged.sshHost = existing.sshHost
            if (!hasOwn('sshPort')) merged.sshPort = existing.sshPort
            if (!hasOwn('sshUser')) merged.sshUser = existing.sshUser
            if (!hasOwn('sshAuthMethod')) merged.sshAuthMethod = existing.sshAuthMethod
            if (!hasOwn('sshPrivateKeyPath')) merged.sshPrivateKeyPath = existing.sshPrivateKeyPath
            if (!hasOwn('hasSshPassphrase')) merged.hasSshPassphrase = existing.hasSshPassphrase
            if (!hasOwn('hasSshPassword')) merged.hasSshPassword = existing.hasSshPassword
          }
        }
      }

      const hasPassword =
        input.password !== undefined ? Boolean(input.password) : Boolean(merged.hasPassword)
      const hasAuthToken =
        input.authToken !== undefined ? Boolean(input.authToken) : Boolean(merged.hasAuthToken)
      const hasSslKeyPassphrase =
        input.sslKeyPassphrase !== undefined
          ? Boolean(input.sslKeyPassphrase)
          : Boolean(merged.hasSslKeyPassphrase)
      const hasSshPassphrase =
        input.sshPassphrase !== undefined
          ? Boolean(input.sshPassphrase)
          : Boolean(merged.hasSshPassphrase)
      const hasSshPassword =
        input.sshPassword !== undefined
          ? Boolean(input.sshPassword)
          : Boolean(merged.hasSshPassword)

      const profileToSave = sanitizeConnectionProfile({
        ...merged,
        id,
        hasPassword,
        hasAuthToken: hasAuthToken || undefined,
        hasSslKeyPassphrase: hasSslKeyPassphrase || undefined,
        hasSshPassphrase: hasSshPassphrase || undefined,
        hasSshPassword: hasSshPassword || undefined,
      })

      if (idx >= 0) {
        list[idx] = profileToSave
      } else {
        list.push(profileToSave)
      }

      await sessionManager.saveStoredConnections(list)
      if (isLiveDesktopHost) {
        await writeHostConfigBackupPatch({ connections: list.map(sanitizeConnectionProfile) })
      }

      const currentActiveId = await orca.storage.get(ACTIVE_CONNECTION_STORAGE_KEY)
      const activeStillExists =
        typeof currentActiveId === 'string' &&
        currentActiveId.trim().length > 0 &&
        list.some((c) => c.id === currentActiveId)
      if (!activeStillExists) {
        await orca.storage.set(ACTIVE_CONNECTION_STORAGE_KEY, id)
      }

      await sessionManager.closeSession(id)

      orca.panels.post('connections.changed', { count: list.length })
      return { ok: true, id }
    })
  })

  registerHandler('connection.delete', async (input) => {
    if (!input || !input.id) {
      throw createHostError('invalid_params', 'Missing id parameter')
    }

    return await connectionsQueue.run(async () => {
      const list = await sessionManager.getStoredConnections()
      const updated = list.filter((c) => c.id !== input.id)
      await sessionManager.saveStoredConnections(updated)
      if (isLiveDesktopHost) {
        await writeHostConfigBackupPatch({ connections: updated.map(sanitizeConnectionProfile) })
      }
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

  registerHandler('connection.test', async (input) => {
    if (!input?.profile?.driver) {
      throw createHostError('invalid_params', 'Driver must be specified')
    }
    if (
      !SUPPORTED_DRIVERS.includes(input.profile.driver) &&
      !isByodDriverId(input.profile.driver)
    ) {
      throw createHostError(
        'invalid_params',
        `Unsupported database driver: ${String(input.profile.driver)}`
      )
    }

    const normalized = await normalizeSqliteProfile(input.profile)
    if (
      normalized.driver === 'd1' &&
      typeof normalized.url === 'string' &&
      normalized.url.trim().length > 0
    ) {
      const checked = validateD1EndpointUrl(normalized.url)
      if (!checked.ok) {
        throw createHostError('invalid_params', checked.error)
      }
    }
    const usesToken = normalized.driver === 'libsql' || normalized.driver === 'd1'
    let secret = usesToken ? input.authToken : input.password
    const secretLookupId =
      normalized.id &&
      !normalized.id.startsWith('ws_') &&
      !normalized.id.startsWith('conn_test_')
        ? normalized.id
        : input.sourceConnectionId
    if (secret === undefined && secretLookupId) {
      const hasStoredSecret = usesToken
        ? normalized.hasAuthToken !== false
        : Boolean(normalized.hasPassword)
      if (hasStoredSecret) {
        secret = await sessionManager.getSecret(secretLookupId, normalized.driver)
      }
    }

    const storedSecrets = secretLookupId
      ? await sessionManager.getExtendedSecrets(secretLookupId)
      : {}
    const allowStoredExtended = Boolean(input.sourceConnectionId)
    const extraSecrets = {
      sslKeyPassphrase:
        input.sslKeyPassphrase ??
        (allowStoredExtended || normalized.hasSslKeyPassphrase
          ? storedSecrets.sslKeyPassphrase
          : undefined),
      sshPassphrase:
        input.sshPassphrase ??
        (allowStoredExtended || normalized.hasSshPassphrase
          ? storedSecrets.sshPassphrase
          : undefined),
      sshPassword:
        input.sshPassword ??
        (allowStoredExtended || normalized.hasSshPassword
          ? storedSecrets.sshPassword
          : undefined),
    }
    return await sessionManager.testConnection(normalized, secret, extraSecrets)
  })

  registerHandler('connection.parseUri', async (input) => {
    const rawUri = typeof input?.uri === 'string' ? input.uri : ''
    return parseConnectionUri(rawUri)
  })

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

    const [envConnections, items, dockerComposeConnections] = await Promise.all([
      detectWorkspaceEnvConnections(targetDirs),
      sqliteFilesPromise,
      detectWorkspaceDockerComposeConnections(targetDirs, {
        onlyMatchedWorkspaces: Boolean(rawFolder),
      }),
    ])

    return {
      sqliteFiles: items.map((d) => ({
        name: d.name.replace(/\s*\(Workspace\)$/, ''),
        filePath: d.filePath,
        sizeBytes: d.sizeBytes ?? 0,
        sizeLabel: d.sizeLabel || formatByteSize(d.sizeBytes ?? 0),
      })),
      envConnections,
      dockerComposeConnections,
    }
  })

  const syncByodConfigsToBackup = async (): Promise<void> => {
    if (!isLiveDesktopHost) return
    try {
      const raw = await orca.storage.get(CUSTOM_DRIVERS_STORAGE_KEY)
      if (Array.isArray(raw)) {
        await writeHostConfigBackupPatch({
          byodConfigs: raw as unknown as PersistedLocalDriverConfig[],
        })
      }
    } catch {
      // Ignore backup write failure
    }
  }

  registerHandler('drivers.list', async () => {
    return { drivers: await driverManager.listDrivers() }
  })

  registerHandler('drivers.inspectLocal', async (input) => {
    if (!input?.driverId || !input?.localPath) {
      throw createHostError('invalid_params', 'driverId and localPath are required')
    }
    return await driverManager.inspectLocalDriver({
      driverId: input.driverId,
      localPath: input.localPath,
    })
  })

  registerHandler('drivers.configureLocal', async (input) => {
    if (!input?.driverId || !input?.localPath) {
      throw createHostError('invalid_params', 'driverId and localPath are required')
    }
    const item = await driverManager.configureLocalDriver({
      driverId: input.driverId,
      localPath: input.localPath,
      name: input.name,
      trustedSha256: input.trustedSha256,
    })
    await sessionManager.closeSessionsByDriver(input.driverId)
    await syncByodConfigsToBackup()
    return { ok: true, item }
  })

  registerHandler('drivers.verify', async (input) => {
    if (!input?.driverId) {
      throw createHostError('invalid_params', 'driverId is required')
    }
    const res = await driverManager.verifyLocalDriver(input.driverId, {
      trustedSha256: input.trustedSha256,
    })
    if (!res.ok || res.sha256Changed) {
      await sessionManager.closeSessionsByDriver(input.driverId)
    }
    await syncByodConfigsToBackup()
    return res
  })

  registerHandler('drivers.removeLocal', async (input) => {
    if (!input?.driverId) {
      throw createHostError('invalid_params', 'driverId is required')
    }
    const res = await driverManager.removeLocalDriver(input.driverId)
    await sessionManager.closeSessionsByDriver(input.driverId)
    await syncByodConfigsToBackup()
    return res
  })

  registerHandler('drivers.defaultPaths', async () => {
    return getDefaultByodDriverDirs()
  })

  registerHandler('drivers.setupLocal', async (input) => {
    if (!input?.driverId || !input?.localPath) {
      throw createHostError('invalid_params', 'driverId and localPath are required')
    }
    const setupRes = await scaffoldLocalDriverDirectory({
      driverId: input.driverId,
      localPath: input.localPath,
    })
    const inspect = await driverManager.inspectLocalDriver({
      driverId: input.driverId,
      localPath: setupRes.dirPath,
    })
    let item = undefined
    const realSetupEntry = await fs.promises
      .realpath(setupRes.entryPath)
      .catch(() => setupRes.entryPath)
    const canAutoTrust =
      input.autoTrust !== false &&
      setupRes.wroteCanonicalEntry &&
      inspect.ok &&
      inspect.resolvedEntry === realSetupEntry &&
      inspect.sha256 === setupRes.canonicalSha256
    if (canAutoTrust) {
      try {
        item = await driverManager.configureLocalDriver({
          driverId: input.driverId,
          localPath: setupRes.dirPath,
          trustedSha256: inspect.sha256,
        })
        await sessionManager.closeSessionsByDriver(input.driverId)
        await syncByodConfigsToBackup()
      } catch {
        // Leave pending for manual Trust & Verify until npm package is installed
      }
    }
    return {
      ok: true,
      dirPath: setupRes.dirPath,
      entryPath: setupRes.entryPath,
      wroteCanonicalEntry: setupRes.wroteCanonicalEntry,
      installPackage: setupRes.installPackage,
      inspect,
      item,
    }
  })

  registerHandler('fs.listDir', async (input) => {
    const workspaceDirs = await getLocalWorkspaceDirs(orca).catch(() => [])
    return await listDirectoryForPicker(input || {}, workspaceDirs)
  })

  registerHandler('workspace.listScopes', async () => {
    return await listWorkspaceScopesForUi(orca)
  })

  registerHandler('ui.getSessionSnapshot', async (input) => {
    const surface = input?.surface === 'studio' ? 'studio' : 'panel'
    return await getUiSessionSnapshot(orca, surface)
  })

  registerHandler('ui.saveSessionSnapshot', async (input) => {
    const surface = input?.surface === 'studio' ? 'studio' : 'panel'
    return await saveUiSessionSnapshot(orca, surface, {
      viewState: input?.viewState,
      dataCache: input?.dataCache,
    })
  })
}
