/**
 * test/e2e/harness/mock-orca-runtime.ts
 *
 * Lightweight, zero-dependency, fully-typed in-memory mock of Orca's
 * trusted-worker runtime environment (OrcaWorkerApi) and IPC bridge.
 *
 * Implements:
 * - StorageApi (storage:own) with deep cloning and onDidChange events
 * - SecretsApi (secrets:own) with async in-memory key-value vault
 * - SettingsApi (settings:own) with defaults and change notifications
 * - PanelsApi with typed handle() request registration and post() event dispatch
 * - CommandsApi & EventsApi
 * - Client IPC request dispatcher with timeout, AbortSignal coordination, and HostCallError wrapping
 */

import type {
  PluginRequests,
  PluginPanelEvents,
  PluginRequestInput,
  PluginRequestOutput
} from './protocol-types.js'

// Standard Orca Disposable
export interface Disposable {
  dispose(): void
}

// JSON Values
export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonArray
export interface JsonObject {
  [key: string]: JsonValue
}
export interface JsonArray extends Array<JsonValue> {}

// Host Error Codes per Orca specification
export type HostErrorCode =
  | 'invalid_request'
  | 'invalid_params'
  | 'unknown_method'
  | 'capability_denied'
  | 'consent_required'
  | 'not_permitted'
  | 'rate_limited'
  | 'unavailable'
  | 'action_failed'
  | 'cancelled'
  | 'timeout'
  | 'conflict'
  | 'too_large'

export interface HostCallError extends Error {
  code: HostErrorCode | string
  retryable?: boolean
  retryAfterMs?: number
}

export function createHostError(
  code: HostErrorCode | string,
  message?: string,
  options?: { retryable?: boolean; retryAfterMs?: number }
): HostCallError {
  const err = new Error(message || `Orca Host Error: [${code}]`) as HostCallError
  err.code = code
  if (options?.retryable !== undefined) err.retryable = options.retryable
  if (options?.retryAfterMs !== undefined) err.retryAfterMs = options.retryAfterMs
  return err
}

// Storage API Contract
export interface StorageApi {
  get(key: string): Promise<JsonValue | null>
  set(key: string, value: JsonValue): Promise<void>
  delete(key: string): Promise<void>
  keys(): Promise<string[]>
  onDidChange(listener: (change: { key: string }) => void): Disposable
}

// Secrets API Contract
export interface SecretsApi {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

// Settings API Contract
export interface SettingsApi {
  get(key?: string): Promise<any>
  set(key: string, value: JsonValue): Promise<void>
  onDidChange(listener: (change: { key: string }) => void): Disposable
}

// Panels & IPC Context
export interface PanelRequestContext {
  panel: {
    id: string
    surface: string
    contributionId: string
  }
  signal: AbortSignal
}

export interface PanelsApi {
  handle<K extends keyof PluginRequests>(
    name: K,
    handler: (
      input: PluginRequestInput<K>,
      context: PanelRequestContext
    ) => PluginRequestOutput<K> | Promise<PluginRequestOutput<K>>
  ): Disposable
  post<K extends keyof PluginPanelEvents>(
    event: K,
    payload: PluginPanelEvents[K],
    options?: { panel?: string }
  ): void
}

export interface CommandContext {
  invokedFrom?: string
}

export interface CommandsApi {
  register(
    commandId: string,
    handler: (args: any, ctx: CommandContext) => any
  ): Disposable
}

export interface EventsApi {
  on(event: string, handler: (payload: any) => any): Disposable
}

export interface HooksApi {
  on(hook: string, handler: any): Disposable
}

export interface HostApiVersion {
  major: number
  minor: number
}

// Full Worker API Contract passed to activate(orca)
export interface OrcaWorkerApi {
  api: HostApiVersion
  storage: StorageApi
  secrets: SecretsApi
  settings: SettingsApi
  panels: PanelsApi
  commands: CommandsApi
  events: EventsApi
  hooks: HooksApi
  host: Record<string, unknown>
  grantedCapabilities: string[]
  log(message: string): void
}

// Client Request Options
export interface ClientRequestOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

/**
 * MockOrcaRuntime
 *
 * Simulates Orca host execution in memory, providing clean state isolation,
 * deep cloning to prevent test pollution, and full IPC request/event coordination.
 */
export class MockOrcaRuntime {
  public readonly storageData = new Map<string, JsonValue>()
  public readonly secretsData = new Map<string, string>()
  public readonly settingsData = new Map<string, JsonValue>()

  private storageListeners = new Set<(change: { key: string }) => void>()
  private settingsListeners = new Set<(change: { key: string }) => void>()
  private panelHandlers = new Map<string, (input: any, ctx: PanelRequestContext) => any>()
  private panelEventListeners = new Map<string, Set<(payload: any) => void>>()
  private commandHandlers = new Map<string, (args: any, ctx: CommandContext) => any>()
  private eventListeners = new Map<string, Set<(payload: any) => void>>()

  public readonly logs: string[] = []
  public readonly eventHistory: Array<{ event: string; payload: any; timestamp: number }> = []

  // Active abort controllers for pending requests
  public readonly activeControllers = new Map<string, AbortController>()

  constructor() {
    this.reset()
  }

  /**
   * Resets all internal stores, listeners, and aborts any active controllers.
   */
  public reset(): void {
    this.storageData.clear()
    this.secretsData.clear()
    this.settingsData.clear()
    this.storageListeners.clear()
    this.settingsListeners.clear()
    this.panelHandlers.clear()
    this.panelEventListeners.clear()
    this.commandHandlers.clear()
    this.eventListeners.clear()
    this.logs.length = 0
    this.eventHistory.length = 0

    for (const controller of this.activeControllers.values()) {
      try {
        controller.abort()
      } catch {}
    }
    this.activeControllers.clear()

    // Default extension settings
    this.settingsData.set('defaultDriver', 'sqlite')
    this.settingsData.set('queryTimeoutSeconds', 30)
    this.settingsData.set('rowLimit', 1000)
  }

  /**
   * Deep clone helper to emulate JSON-based IPC and storage isolation.
   */
  private clone<T>(value: T): T {
    if (value === undefined || value === null) return value
    return JSON.parse(JSON.stringify(value))
  }

  /**
   * Builds the OrcaWorkerApi object injected into the worker's activate(orca) entrypoint.
   */
  public getWorkerApi(): OrcaWorkerApi {
    const self = this

    const storage: StorageApi = {
      async get(key: string): Promise<JsonValue | null> {
        const val = self.storageData.get(key)
        if (val === undefined) return null
        return self.clone(val)
      },
      async set(key: string, value: JsonValue): Promise<void> {
        self.storageData.set(key, self.clone(value))
        for (const listener of self.storageListeners) {
          try {
            listener({ key })
          } catch (e) {
            console.error('Error in storage listener', e)
          }
        }
      },
      async delete(key: string): Promise<void> {
        self.storageData.delete(key)
        for (const listener of self.storageListeners) {
          try {
            listener({ key })
          } catch (e) {
            console.error('Error in storage listener', e)
          }
        }
      },
      async keys(): Promise<string[]> {
        return Array.from(self.storageData.keys())
      },
      onDidChange(listener: (change: { key: string }) => void): Disposable {
        self.storageListeners.add(listener)
        return {
          dispose: () => self.storageListeners.delete(listener)
        }
      }
    }

    const secrets: SecretsApi = {
      async get(key: string): Promise<string | null> {
        const val = self.secretsData.get(key)
        return val !== undefined ? val : null
      },
      async set(key: string, value: string): Promise<void> {
        self.secretsData.set(key, String(value))
      },
      async delete(key: string): Promise<void> {
        self.secretsData.delete(key)
      }
    }

    const settings: SettingsApi = {
      async get(key?: string): Promise<any> {
        if (!key) {
          const result: Record<string, JsonValue> = {}
          for (const [k, v] of self.settingsData.entries()) {
            result[k] = self.clone(v)
          }
          return result
        }
        const val = self.settingsData.get(key)
        return val !== undefined ? self.clone(val) : undefined
      },
      async set(key: string, value: JsonValue): Promise<void> {
        self.settingsData.set(key, self.clone(value))
        for (const listener of self.settingsListeners) {
          try {
            listener({ key })
          } catch (e) {
            console.error('Error in settings listener', e)
          }
        }
      },
      onDidChange(listener: (change: { key: string }) => void): Disposable {
        self.settingsListeners.add(listener)
        return {
          dispose: () => self.settingsListeners.delete(listener)
        }
      }
    }

    const panels: PanelsApi = {
      handle(name: any, handler: any): Disposable {
        self.panelHandlers.set(String(name), handler)
        return {
          dispose: () => {
            if (self.panelHandlers.get(String(name)) === handler) {
              self.panelHandlers.delete(String(name))
            }
          }
        }
      },
      post(event: any, payload?: any, _options?: { panel?: string }): void {
        const evName = String(event)
        const clonedPayload = self.clone(payload)
        self.eventHistory.push({ event: evName, payload: clonedPayload, timestamp: Date.now() })
        const listeners = self.panelEventListeners.get(evName)
        if (listeners) {
          for (const listener of listeners) {
            try {
              listener(clonedPayload)
            } catch (e) {
              console.error(`Error in panel event listener for [${evName}]`, e)
            }
          }
        }
      }
    }

    return {
      api: { major: 1, minor: 9 },
      commands: {
        register(commandId: string, handler: any): Disposable {
          self.commandHandlers.set(commandId, handler)
          return {
            dispose: () => {
              if (self.commandHandlers.get(commandId) === handler) {
                self.commandHandlers.delete(commandId)
              }
            }
          }
        }
      },
      events: {
        on(event: string, handler: any): Disposable {
          if (!self.eventListeners.has(event)) {
            self.eventListeners.set(event, new Set())
          }
          self.eventListeners.get(event)!.add(handler)
          return {
            dispose: () => {
              self.eventListeners.get(event)?.delete(handler)
            }
          }
        }
      },
      hooks: {
        on(): Disposable {
          return { dispose: () => {} }
        }
      },
      host: {},
      panels,
      storage,
      settings,
      secrets,
      grantedCapabilities: [
        'storage:own',
        'secrets:own',
        'settings:own',
        'workspace:read',
        'workspace:write'
      ],
      log(message: string): void {
        self.logs.push(`[${new Date().toISOString()}] ${message}`)
      }
    }
  }

  /**
   * Client-side API simulating UI requests dispatched to the background worker.
   */
  public get client() {
    const self = this

    return {
      /**
       * Dispatches a typed IPC request to the worker handler.
       */
      async request<K extends keyof PluginRequests>(
        name: K,
        input?: PluginRequestInput<K>,
        options?: ClientRequestOptions
      ): Promise<PluginRequestOutput<K>> {
        const reqName = String(name)
        const handler = self.panelHandlers.get(reqName)
        if (!handler) {
          throw createHostError(
            'unknown_method',
            `No handler registered in worker for request: '${reqName}'`
          )
        }

        const controller = new AbortController()
        const requestId = `${reqName}_${Math.random().toString(36).substring(2, 9)}`
        self.activeControllers.set(requestId, controller)

        let timer: ReturnType<typeof setTimeout> | null = null
        let callerAbortListener: (() => void) | null = null
        let abortPromiseCleanup: (() => void) | undefined = undefined
        let timedOut = false

        try {
          // Propagate caller abort signal if supplied
          if (options?.signal) {
            if (options.signal.aborted) {
              controller.abort()
              throw createHostError('cancelled', `Request '${reqName}' aborted prior to dispatch`)
            }
            callerAbortListener = () => controller.abort()
            options.signal.addEventListener('abort', callerAbortListener, { once: true })
          }

          if (controller.signal.aborted) {
            throw createHostError('cancelled', `Request '${reqName}' was cancelled`)
          }

          const timeoutMs = options?.timeoutMs ?? 10000

          const timeoutPromise = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              timedOut = true
              controller.abort()
              reject(
                createHostError(
                  'timeout',
                  `Request '${reqName}' timed out after ${timeoutMs}ms`
                )
              )
            }, timeoutMs)
          })
          timeoutPromise.catch(() => {})

          const abortPromise = new Promise<never>((_, reject) => {
            if (controller.signal.aborted && !timedOut) {
              reject(createHostError('cancelled', 'Request was cancelled'))
              return
            }
            const onAbort = () => {
              if (!timedOut) {
                reject(createHostError('cancelled', 'Request was cancelled'))
              }
            }
            controller.signal.addEventListener('abort', onAbort, { once: true })
            abortPromiseCleanup = () => controller.signal.removeEventListener('abort', onAbort)
          })
          abortPromise.catch(() => {})

          const context: PanelRequestContext = {
            panel: {
              id: 'mock-panel-datanoa',
              surface: 'panel',
              contributionId: 'datanoa'
            },
            signal: controller.signal
          }

          // Deep clone input to avoid mutable parameter leaking
          const safeInput = self.clone(input)
          const executionPromise = Promise.resolve().then(() => handler(safeInput, context))
          executionPromise.catch(() => {})
          const result = await Promise.race([executionPromise, timeoutPromise, abortPromise])
          return self.clone(result) as PluginRequestOutput<K>
        } catch (err: any) {
          if (err && typeof err === 'object' && 'code' in err) {
            throw err
          }
          const hostErr = createHostError('action_failed', err?.message || String(err))
          if (err?.stack) hostErr.stack = err.stack
          throw hostErr
        } finally {
          if (timer) clearTimeout(timer)
          if (options?.signal && callerAbortListener) {
            options.signal.removeEventListener('abort', callerAbortListener)
          }
          const cleanupFn = abortPromiseCleanup as unknown
          if (typeof cleanupFn === 'function') {
            (cleanupFn as () => void)()
          }
          self.activeControllers.delete(requestId)
        }
      },

      /**
       * Subscribes to panel events broadcast by the worker.
       */
      on<K extends keyof PluginPanelEvents>(
        event: K,
        handler: (payload: PluginPanelEvents[K]) => void
      ): Disposable {
        const evName = String(event)
        if (!self.panelEventListeners.has(evName)) {
          self.panelEventListeners.set(evName, new Set())
        }
        self.panelEventListeners.get(evName)!.add(handler)
        return {
          dispose: () => {
            self.panelEventListeners.get(evName)?.delete(handler)
          }
        }
      },

      /**
       * Emits an event to worker event listeners (registered via orca.events.on).
       */
      async emit(event: string, payload: any): Promise<void> {
        const listeners = self.eventListeners.get(event)
        if (listeners) {
          const safePayload = self.clone(payload)
          for (const listener of listeners) {
            try {
              await listener(safePayload)
            } catch (e) {
              console.error(`Error in worker event listener for [${event}]`, e)
            }
          }
        }
      }
    }
  }
}
