// src/editor/document-meta.ts
// Document metadata header parsing/serialization, persisted view state, and initial host theme detection.

import {
  sanitizeJsonPayload,
  type ConnectionProfile,
  type QueryResult,
  type SchemaObject,
  type SchemaObjectKind,
  type TableBrowseResult,
} from '../protocol.js'
import type { PersistedConsoleTabsState } from './console-tabs.js'

export interface DocumentSessionLike {
  value?: unknown
  readOnly?: boolean
  change?: (next: string) => void
  onReplace?: (handler: (next: unknown) => void) => { dispose(): void } | void
  dispose?: () => void
}

export interface ParsedDatanoaDocument {
  metadataLines: string[]
  cleanSql: string
  connectionId?: string
  table?: string
  schema?: string
}

export interface TableColumnConfig {
  hidden: string[]
  pinned: string[]
}

export interface StudioPersistedViewState {
  activeViewMode?: 'split' | 'grid' | 'sql' | 'inspector'
  activeConnectionId?: string | null
  activeTable?: string | null
  activeSchema?: string
  currentPage?: number
  pageSize?: number
  activeWhereClause?: string
  activeOrderByClause?: string
  clientFilter?: string
  filterQuery?: string
  isTransposed?: boolean
  sidebarCollapsed?: boolean
  customSqlPanePx?: number | null
  sqlDraft?: string
  consoleTabs?: PersistedConsoleTabsState
  columnConfigByTable?: Record<string, TableColumnConfig>
  scrollState?: {
    sidebarTop?: number
    gridTop?: number
    gridLeft?: number
  }
}

export const STUDIO_VIEW_STATE_STORAGE_KEY = 'datanoa.studioViewState'
export const STUDIO_WARM_CACHE_STORAGE_KEY = 'datanoa.studioWarmCache'

export interface StudioWarmCacheSnapshot {
  updatedAt: number
  connections?: ConnectionProfile[]
  activeConnectionId?: string | null
  activeTable?: string | null
  activeSchema?: string
  activeObjectKind?: SchemaObjectKind | null
  activeReadOnlyObject?: SchemaObject | null
  availableSchemas?: string[]
  defaultSchema?: string
  selectedSchema?: string
  isShowingSqlResult?: boolean
  whereClause?: string
  orderByClause?: string
  page?: number
  pageSize?: number
  schemaMap?: Record<string, string[]> | null
  schemaObjects?: SchemaObject[] | null
  pageData?: TableBrowseResult | null
  lastSqlResult?: QueryResult | null
}

export function parseDatanoaDocument(docText: string): ParsedDatanoaDocument {
  const lines = docText.split('\n')
  const metadataLines: string[] = []
  let connectionId: string | undefined
  let table: string | undefined
  let schema: string | undefined

  let i = 0
  while (i < lines.length) {
    const rawLine = lines[i].replace(/\r$/, '')
    const match = /^--\s*datanoa:\s*(.+)$/i.exec(rawLine)
    if (!match) break

    metadataLines.push(rawLine)
    const pairs = match[1].trim()
    const kv = /^([A-Za-z0-9_]+)=(.*)$/.exec(pairs)
    if (kv) {
      const key = kv[1].toLowerCase()
      const val = kv[2].trim()
      if (key === 'connectionid' && val) connectionId = val
      else if (key === 'table' && val) table = val
      else if (key === 'schema' && val) schema = val
    }
    i++
  }

  const cleanSql = lines.slice(i).join('\n')
  return {
    metadataLines,
    cleanSql,
    connectionId,
    table,
    schema,
  }
}

export function composeDatanoaDocument(
  metadataLines: readonly string[],
  visibleSql: string
): string {
  if (metadataLines.length === 0) {
    return visibleSql
  }
  return `${metadataLines.join('\n')}\n${visibleSql}`
}

export function upsertDatanoaMetadataHeader(
  metadataLines: string[],
  key: 'connectionId' | 'table' | 'schema',
  value: string
): void {
  const prefix = `-- datanoa: ${key}=`
  const idx = metadataLines.findIndex((line) =>
    line.toLowerCase().startsWith(prefix.toLowerCase())
  )
  const nextLine = `${prefix}${value}`
  if (idx >= 0) {
    metadataLines[idx] = nextLine
  } else {
    metadataLines.push(nextLine)
  }
}

export function readLocalStudioViewState(): StudioPersistedViewState | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage?.getItem(STUDIO_VIEW_STATE_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as StudioPersistedViewState
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function containsSensitiveSqlLiteral(sql: string): boolean {
  return (
    /\b(?:identified\s+by|set\s+password|password\s*=|secret\s*=|token\s*=|auth\s+['"]|alter\s+(?:user|role)\b[^;]*\bpassword\b|create\s+(?:user|role)\b[^;]*\b(?:password|identified\s+by)\b)/i.test(
      sql
    ) ||
    /:\/\/[^:/\s?#@]*:[^\s/]+@/i.test(sql) ||
    /[?&][^=&\s#]*(?:token|pass|pwd|secret|key|auth)[^=&\s#]*=/i.test(sql)
  )
}

function scrubSensitiveStringForLocalStorage(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  return trimmed
    .replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^:/\s?#@]*):([^\s/]*)@/g, '$1$2@')
    .replace(/([?&])([^=&\s#]*(?:token|pass|pwd|secret|key|auth)[^=&\s#]*)=([^&\s#]*)/gi, '$1$2=[REDACTED]')
    .replace(/\b(password|passwd|pwd|secret|token|auth_token)\s*=\s*([^\s;&]+)/gi, '$1=[REDACTED]')
}

function sanitizeStudioSnapshotForLocalStorage(
  snapshot: StudioPersistedViewState
): StudioPersistedViewState {
  const safe: StudioPersistedViewState = { ...snapshot }
  if (typeof safe.sqlDraft === 'string' && containsSensitiveSqlLiteral(safe.sqlDraft)) {
    delete safe.sqlDraft
  }
  if (safe.consoleTabs && Array.isArray(safe.consoleTabs.tabs)) {
    safe.consoleTabs = {
      ...safe.consoleTabs,
      tabs: safe.consoleTabs.tabs.map((tab) =>
        tab && typeof tab.sql === 'string' && containsSensitiveSqlLiteral(tab.sql)
          ? { ...tab, sql: '' }
          : tab
      ),
    }
  }
  return sanitizeJsonPayload(safe) as StudioPersistedViewState
}

export function writeStudioViewStateSnapshot(snapshot: StudioPersistedViewState): void {
  if (typeof window === 'undefined') return
  try {
    const safe = sanitizeStudioSnapshotForLocalStorage(snapshot)
    window.localStorage?.setItem(STUDIO_VIEW_STATE_STORAGE_KEY, JSON.stringify(safe))
  } catch {
    // Ignore storage quota errors
  }
}

const MAX_STUDIO_WARM_CACHE_BYTES = 350_000

function measureWarmCacheBytes(json: string): number {
  try {
    return typeof TextEncoder === 'function' ? new TextEncoder().encode(json).length : json.length * 2
  } catch {
    return json.length * 2
  }
}

function sanitizeWarmConnections(conns: ConnectionProfile[] | undefined): ConnectionProfile[] | undefined {
  if (!Array.isArray(conns)) return undefined
  return conns.slice(0, 120).map((c) => {
    const copy = { ...c } as Record<string, unknown>
    delete copy.password
    delete copy.authToken
    delete copy.sshPassword
    delete copy.sshPassphrase
    delete copy.sslKeyPassphrase
    if (typeof copy.url === 'string') {
      copy.url = scrubSensitiveStringForLocalStorage(copy.url)
    }
    if (typeof copy.options === 'string') {
      copy.options = scrubSensitiveStringForLocalStorage(copy.options)
    }
    return copy as unknown as ConnectionProfile
  })
}

export function readLocalStudioWarmCache(): StudioWarmCacheSnapshot | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage?.getItem(STUDIO_WARM_CACHE_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as StudioWarmCacheSnapshot
    if (!parsed || typeof parsed !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

export function writeLocalStudioWarmCache(snapshot: StudioWarmCacheSnapshot): void {
  if (typeof window === 'undefined') return
  try {
    const candidate: StudioWarmCacheSnapshot = {
      ...snapshot,
      updatedAt: Number.isFinite(snapshot.updatedAt) ? snapshot.updatedAt : Date.now(),
      connections: sanitizeWarmConnections(snapshot.connections),
      whereClause:
        typeof snapshot.whereClause === 'string' && containsSensitiveSqlLiteral(snapshot.whereClause)
          ? ''
          : snapshot.whereClause,
    }
    const clean = sanitizeJsonPayload(candidate) as StudioWarmCacheSnapshot
    let serialized = JSON.stringify(clean)
    if (measureWarmCacheBytes(serialized) > MAX_STUDIO_WARM_CACHE_BYTES) {
      clean.pageData = null
      clean.lastSqlResult = null
      serialized = JSON.stringify(clean)
    }
    if (measureWarmCacheBytes(serialized) > MAX_STUDIO_WARM_CACHE_BYTES) {
      clean.schemaObjects = null
      serialized = JSON.stringify(clean)
    }
    if (measureWarmCacheBytes(serialized) <= MAX_STUDIO_WARM_CACHE_BYTES) {
      window.localStorage?.setItem(STUDIO_WARM_CACHE_STORAGE_KEY, serialized)
    }
  } catch {
    // Ignore storage quota errors
  }
}

export function syncInitialThemeFromHost(): void {
  if (typeof document === 'undefined' || !document.body) return
  if (
    document.documentElement.classList.contains('light') ||
    document.documentElement.classList.contains('dark')
  ) {
    return
  }
  try {
    const probe = document.createElement('div')
    probe.style.position = 'absolute'
    probe.style.visibility = 'hidden'
    probe.style.background = 'var(--orca-background, #000000)'
    document.body.appendChild(probe)
    const bg = getComputedStyle(probe).backgroundColor
    probe.remove()
    const parts = bg.match(/[\d.]+/g)
    if (!parts || (parts.length > 3 && Number(parts[3]) === 0)) return
    const toLin = (c: number) => {
      const s = c / 255
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
    }
    const lum =
      0.2126 * toLin(Number(parts[0])) +
      0.7152 * toLin(Number(parts[1])) +
      0.0722 * toLin(Number(parts[2]))
    document.documentElement.classList.toggle('light', lum > 0.45)
  } catch {
    // Non-browser environment
  }
}
