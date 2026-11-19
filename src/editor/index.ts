// src/editor/index.ts
// Datanoa Studio Editor: Full-Screen JetBrains DataGrip Custom Editor for .sql and .datanoa files
// Theme variables bound from Orca host: var(--orca-background), var(--orca-foreground), var(--orca-primary), var(--orca-border)

import { DATANOA_LOGO_DATA_URI } from '../assets/logo.js'
import {
  buildAlterTableSql,
  buildCreateTableSql,
  buildDropTableSql,
  buildQuickFilterPredicate,
  buildTableMigrationSql,
  buildTruncateTableSql,
  containsDdlStatement,
  countTableStructureChanges,
  createInitialTableDraft,
  formatSql,
  normalizeSqlDefaultExpression,
  quoteIdentForDialect,
  sanitizeFilterClause,
  validateTableStructureDraft,
  type AlterTableAction,
  type CreateTableColumnDraft,
  type DraftColumnItem,
  type DraftForeignKeyItem,
  type DraftIndexItem,
  type ExportFormat,
  type ReferentialAction,
  type TableMigrationPlan,
  type TableStructureDraft,
} from '../drivers/common/sql-tools.js'
import {
  SqlConsoleController,
  type SqlDialectType,
  type EditorTypography,
  extractExecutableSql,
  extractCaretStatementSql,
  computeSmartSqlCompletions,
} from './console.js'
import type { SelectionSummary } from './grid-selection.js'
import {
  VirtualDataGrid,
  formatGridModel,
  formatCellValue,
  calculateVisibleWindow,
  checkCellEditGate,
  coerceCellInputValue,
  copyTextToClipboard,
  type SelectedCellInfo,
} from './grid.js'
import { SchemaInspectorView, formatDdlForDisplay } from './schema-inspector.js'
import { EDITOR_STYLE as THEME_EDITOR_STYLE } from './theme.js'
import {
  ACTIVE_CONNECTION_STORAGE_KEY,
  sanitizeJsonPayload,
  type ConnectionColorTag,
  type ConnectionProfile,
  type DatabaseDriverType,
  type QueryHistoryEntry,
  type QueryResult,
  type TableBrowseResult,
  type TableDetails,
  type SchemaObject,
} from '../protocol.js'

const BASE_EDITOR_TOKENS = `
  :root {
    --surface: var(--orca-editor-surface, var(--orca-card, #0a0a0a));
    --border: var(--orca-border, #1f1f1f);
    --text: var(--orca-foreground, #e6e6e6);
    --muted: var(--orca-foreground-muted, var(--orca-muted-foreground, #a3a3a3));
    --accent: var(--orca-accent, #1a1a1a);
  }
  .datanoa-editor-root { display: flex; flex-direction: column; height: 100%; width: 100%; }
  .datanoa-toolbar { display: flex; align-items: center; }
  .datanoa-sql-area { overflow: auto; }
  .datanoa-grid-area { overflow: hidden; }
  .datanoa-status-bar { display: flex; justify-content: space-between; }
`

export const EDITOR_STYLE = `${BASE_EDITOR_TOKENS}\n${THEME_EDITOR_STYLE}`

export {
  SqlConsoleController,
  VirtualDataGrid,
  SchemaInspectorView,
  formatDdlForDisplay,
  extractExecutableSql,
  extractCaretStatementSql,
  computeSmartSqlCompletions,
  copyTextToClipboard,
  formatGridModel,
  formatCellValue,
  calculateVisibleWindow,
  checkCellEditGate,
  buildAlterTableSql,
  buildTableMigrationSql,
  createInitialTableDraft,
  countTableStructureChanges,
  normalizeSqlDefaultExpression,
  validateTableStructureDraft,
  type TableMigrationPlan,
  type TableStructureDraft,
  type DraftColumnItem,
  type DraftIndexItem,
  type DraftForeignKeyItem,
  type ReferentialAction,
}

interface DocumentSessionLike {
  value?: unknown
  readOnly?: boolean
  change?: (next: string) => void
  onReplace?: (handler: (next: unknown) => void) => { dispose(): void } | void
  dispose?: () => void
}

interface ParsedDatanoaDocument {
  metadataLines: string[]
  cleanSql: string
  connectionId?: string
  table?: string
  schema?: string
}

const DB_LOGO_COLORS: Readonly<Record<DatabaseDriverType, string>> = {
  sqlite: '#38bdf8',
  postgres: '#60a5fa',
  mysql: '#fb923c',
  mariadb: '#c084fc',
  cockroachdb: '#4ade80',
  clickhouse: '#facc15',
  redis: '#f87171',
  libsql: '#2dd4bf',
}

function createSvgElement(tag: string, attrs: Record<string, string>): SVGElement {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag)
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, v)
  }
  return el
}

function createDbLogoSvg(driver: DatabaseDriverType): SVGElement {
  const color = DB_LOGO_COLORS[driver] || '#e6e6e6'
  const isClickHouse = driver === 'clickhouse'
  const strokeWidth = driver === 'postgres' || driver === 'mariadb' || driver === 'redis' ? '1.8' : '1.9'
  const svg = createSvgElement('svg', {
    width: '14',
    height: '14',
    viewBox: '0 0 24 24',
    fill: isClickHouse ? color : 'none',
    stroke: isClickHouse ? 'none' : color,
    'stroke-width': strokeWidth,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  })

  switch (driver) {
    case 'sqlite': {
      svg.appendChild(createSvgElement('ellipse', { cx: '10', cy: '6', rx: '7', ry: '2.5' }))
      svg.appendChild(
        createSvgElement('path', { d: 'M3 6v12c0 1.4 3.1 2.5 7 2.5 1.8 0 3.4-.2 4.7-.6' })
      )
      svg.appendChild(createSvgElement('path', { d: 'M3 12c0 1.4 3.1 2.5 7 2.5' }))
      svg.appendChild(
        createSvgElement('path', {
          d: 'M21 4c-4.5 1-7.5 4.8-8.2 11.2l3.8-1.4c2.4-2.1 4-5.4 4.4-9.8z',
        })
      )
      break
    }
    case 'postgres': {
      svg.appendChild(
        createSvgElement('path', {
          d: 'M7 11c-2.5 0-4-1.8-4-4.2C3 4.6 5 3 7.5 3c2 0 3.5 1 4.5 2.4C13 4 14.5 3 16.5 3 19 3 21 4.6 21 6.8c0 2.4-1.5 4.2-4 4.2',
        })
      )
      svg.appendChild(
        createSvgElement('path', {
          d: 'M7 11v4.5c0 2.5 2 4 4.5 4 1.6 0 2.8-.8 3.5-2.1.5 1.6 1.5 3.6 3.5 3.6 1.2 0 2-.9 2-2.2 0-1.1-.8-1.8-1.5-2.2-.8-.5-1.2-1.4-1.2-2.8V11',
        })
      )
      svg.appendChild(createSvgElement('circle', { cx: '9.5', cy: '9', r: '0.8', fill: color }))
      svg.appendChild(createSvgElement('circle', { cx: '14.5', cy: '9', r: '0.8', fill: color }))
      break
    }
    case 'mysql': {
      svg.appendChild(
        createSvgElement('path', {
          d: 'M3 16c2.5-5 6.8-8.5 12-9.5-1.4 2.4-1.4 4.8.2 6.7 1.2 1.4 3.4 2.1 5.8 1.8-2.6 2.1-6.2 2.8-9.5 1.8-1.9-.6-3.4-2-4.6-3.7',
        })
      )
      svg.appendChild(createSvgElement('path', { d: 'M9.5 8.5L11 5l2.8 2' }))
      svg.appendChild(createSvgElement('path', { d: 'M3 19.5c3-1 6-1 9 0s6 1 9 0' }))
      break
    }
    case 'mariadb': {
      svg.appendChild(
        createSvgElement('path', {
          d: 'M4 18c1-4 3-7 6-9 2-1.4 5-1.4 6.8.5 1.2 1.3 1.4 3.5 3.2 4.5-1.4 1.5-3.2 2-5.2 1.6-1.4-.3-2.5.4-3 1.8L10.5 20H4v-2z',
        })
      )
      svg.appendChild(createSvgElement('circle', { cx: '14', cy: '10.2', r: '0.8', fill: color }))
      svg.appendChild(createSvgElement('path', { d: 'M18.5 12.2l2.5-.7' }))
      svg.appendChild(createSvgElement('path', { d: 'M18.5 14l2.5.6' }))
      break
    }
    case 'cockroachdb': {
      svg.appendChild(
        createSvgElement('polygon', {
          points: '12 3 19 8.5 16.5 19.5 12 21 7.5 19.5 5 8.5',
        })
      )
      svg.appendChild(createSvgElement('line', { x1: '12', y1: '3', x2: '12', y2: '21' }))
      svg.appendChild(createSvgElement('path', { d: 'M5 8.5l7 4 7-4' }))
      svg.appendChild(createSvgElement('path', { d: 'M8.5 5.5L6 2.5' }))
      svg.appendChild(createSvgElement('path', { d: 'M15.5 5.5L18 2.5' }))
      break
    }
    case 'clickhouse': {
      svg.appendChild(
        createSvgElement('rect', { x: '3', y: '4', width: '2.8', height: '16', rx: '0.8', fill: color, stroke: 'none' })
      )
      svg.appendChild(
        createSvgElement('rect', { x: '7.5', y: '4', width: '2.8', height: '16', rx: '0.8', fill: color, stroke: 'none' })
      )
      svg.appendChild(
        createSvgElement('rect', { x: '12', y: '4', width: '2.8', height: '16', rx: '0.8', fill: color, stroke: 'none' })
      )
      svg.appendChild(
        createSvgElement('rect', { x: '16.5', y: '4', width: '2.8', height: '12.5', rx: '0.8', fill: color, stroke: 'none' })
      )
      svg.appendChild(
        createSvgElement('rect', {
          x: '16.5',
          y: '18',
          width: '2.8',
          height: '2',
          rx: '0.6',
          opacity: '0.65',
          fill: color,
          stroke: 'none',
        })
      )
      break
    }
    case 'redis': {
      svg.appendChild(createSvgElement('polygon', { points: '12 3 21 7.5 12 12 3 7.5' }))
      svg.appendChild(createSvgElement('polyline', { points: '3 12 12 16.5 21 12' }))
      svg.appendChild(createSvgElement('polyline', { points: '3 16.5 12 21 21 16.5' }))
      break
    }
    case 'libsql': {
      svg.appendChild(
        createSvgElement('polygon', {
          points: '12 2.5 20.5 7.5 20.5 16.5 12 21.5 3.5 16.5 3.5 7.5',
        })
      )
      svg.appendChild(createSvgElement('path', { d: 'M7.5 12.5c1.5-2 3-2 4.5 0s3 2 4.5 0' }))
      svg.appendChild(createSvgElement('path', { d: 'M12.8 7.5l-2 4h3l-1.8 4' }))
      break
    }
  }

  return svg
}

function parseDatanoaDocument(docText: string): ParsedDatanoaDocument {
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

const STUDIO_VIEW_STATE_STORAGE_KEY = 'datanoa.studioViewState'
const DEFAULT_RPC_TIMEOUT_MS = 115_000

interface ConnectionEngineMeta {
  id: DatabaseDriverType
  label: string
  defaultPort: number
  defaultDb: string
  defaultUser: string
  defaultSsl: boolean
}

const CONNECTION_ENGINES: ReadonlyArray<ConnectionEngineMeta> = [
  { id: 'sqlite', label: 'SQLite', defaultPort: 0, defaultDb: 'main.db', defaultUser: '', defaultSsl: false },
  { id: 'postgres', label: 'PostgreSQL', defaultPort: 5432, defaultDb: 'postgres', defaultUser: 'postgres', defaultSsl: false },
  { id: 'mysql', label: 'MySQL', defaultPort: 3306, defaultDb: 'mysql', defaultUser: 'root', defaultSsl: false },
  { id: 'mariadb', label: 'MariaDB', defaultPort: 3306, defaultDb: 'mysql', defaultUser: 'root', defaultSsl: false },
  { id: 'cockroachdb', label: 'CockroachDB', defaultPort: 26257, defaultDb: 'defaultdb', defaultUser: 'root', defaultSsl: true },
  { id: 'clickhouse', label: 'ClickHouse', defaultPort: 8123, defaultDb: 'default', defaultUser: 'default', defaultSsl: false },
  { id: 'redis', label: 'Redis', defaultPort: 6379, defaultDb: '0', defaultUser: '', defaultSsl: false },
  { id: 'libsql', label: 'LibSQL / Turso', defaultPort: 443, defaultDb: 'turso', defaultUser: '', defaultSsl: true },
]

function getConnectionEngineMeta(driver: DatabaseDriverType): ConnectionEngineMeta {
  return CONNECTION_ENGINES.find((e) => e.id === driver) ?? CONNECTION_ENGINES[0]
}

function maskConnectionUriSecret(rawUri: string): string {
  return String(rawUri || '').replace(
    /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^:/?#\s@]*:)([^@]+)(@)/,
    '$1***$3'
  )
}

const CONNECTION_ENV_TAGS: ReadonlyArray<{ id: ConnectionColorTag; label: string }> = [
  { id: 'none', label: 'None' },
  { id: 'dev', label: 'Dev' },
  { id: 'staging', label: 'Staging' },
  { id: 'prod', label: 'Prod' },
]

type ConnectionSubmission = {
  profile: ConnectionProfile
  password?: string
  authToken?: string
}

interface ParseUriResponse {
  ok: boolean
  profile?: Partial<ConnectionProfile>
  password?: string
  authToken?: string
  placeholderPassword?: boolean
  error?: string
}

interface DiscoveredSqliteFile {
  name: string
  filePath: string
  sizeBytes: number
  sizeLabel: string
}

interface DiscoveredEnvConnection {
  envKey: string
  sourceFile: string
  driver: DatabaseDriverType
  name: string
  uri: string
}

interface WorkspaceDetectResponse {
  sqliteFiles?: DiscoveredSqliteFile[]
  envConnections?: DiscoveredEnvConnection[]
}

function isKnownConnectionDriver(value: unknown): value is DatabaseDriverType {
  return typeof value === 'string' && CONNECTION_ENGINES.some((e) => e.id === value)
}

interface TableColumnConfig {
  hidden: string[]
  pinned: string[]
}

interface StudioPersistedViewState {
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
  columnConfigByTable?: Record<string, TableColumnConfig>
}

const BUTTON_ORIG_LABELS = new WeakMap<HTMLButtonElement, string>()

function setButtonLoading(
  btn: HTMLButtonElement | null,
  busy: boolean,
  loadingLabel?: string
): void {
  if (!btn) return
  if (busy) {
    if (!BUTTON_ORIG_LABELS.has(btn)) {
      BUTTON_ORIG_LABELS.set(btn, btn.textContent || '')
    }
    btn.disabled = true
    btn.classList?.add?.('is-loading')
    const labelText = loadingLabel ?? BUTTON_ORIG_LABELS.get(btn) ?? ''
    let timerEl = btn.querySelector?.('.datanoa-live-timer')
    if (!timerEl) {
      btn.innerHTML = ''
      const spinner = document.createElement('span')
      spinner.className = 'datanoa-spinner'
      spinner.setAttribute('aria-hidden', 'true')
      timerEl = document.createElement('span')
      timerEl.className = 'datanoa-live-timer'
      btn.appendChild(spinner)
      btn.appendChild(timerEl)
    }
    timerEl.textContent = labelText
  } else {
    btn.classList?.remove?.('is-loading')
    if (BUTTON_ORIG_LABELS.has(btn)) {
      btn.textContent = BUTTON_ORIG_LABELS.get(btn) ?? ''
      BUTTON_ORIG_LABELS.delete(btn)
    }
    btn.disabled = false
  }
}

function formatAggregateNumber(value: number): string {
  if (!Number.isFinite(value)) return '0'
  if (Number.isInteger(value)) return String(value)
  return String(Number(value.toFixed(4)))
}

function formatRelativeTimestamp(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return ''
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (diffSec < 10) return 'just now'
  if (diffSec < 60) return `${diffSec}s ago`
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.floor(diffHr / 24)
  return `${diffDay}d ago`
}

function downloadTextFile(content: string, filename: string, mimeType: string): void {
  if (typeof document === 'undefined' || !document.body || typeof Blob === 'undefined') return
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.style.display = 'none'
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => {
    URL.revokeObjectURL?.(url)
  }, 1000)
}

function extractPredicateColumnName(rawHead: string): { column: string; rest: string } | null {
  const s = rawHead.trimStart()
  if (!s) return null
  const q = s[0]
  if (q === '"' || q === '`') {
    let i = 1
    let col = ''
    while (i < s.length) {
      if (s[i] === q) {
        if (s[i + 1] === q) {
          col += q
          i += 2
          continue
        }
        return col ? { column: col, rest: s.slice(i + 1).trimStart() } : null
      }
      col += s[i]
      i++
    }
    return null
  }
  if (q === '[') {
    const closeIdx = s.indexOf(']', 1)
    if (closeIdx <= 1) return null
    return { column: s.slice(1, closeIdx), rest: s.slice(closeIdx + 1).trimStart() }
  }
  const m = /^([^\s=!<>]+)\s*(.*)$/.exec(s)
  if (!m || !m[1]) return null
  return { column: m[1], rest: m[2].trimStart() }
}

function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName.toUpperCase()
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (target.isContentEditable === true) return true
  if (typeof target.closest === 'function' && target.closest('.cm-editor, .cm-content')) {
    return true
  }
  return false
}

function parseClientQuickFilterPredicate(
  predicateSql: string
): { column: string; op: 'eq' | 'neq' | 'is-null' | 'is-not-null'; value: unknown } | null {
  const parsedCol = extractPredicateColumnName(predicateSql.trim())
  if (!parsedCol) return null
  const { column, rest } = parsedCol
  const nullMatch = /^IS\s+(NOT\s+)?NULL$/i.exec(rest)
  if (nullMatch) {
    return {
      column,
      op: nullMatch[1] ? 'is-not-null' : 'is-null',
      value: null,
    }
  }
  const cmpMatch = /^(=|!=|<>)\s*(.+)$/.exec(rest)
  if (cmpMatch && cmpMatch[2]) {
    const op: 'eq' | 'neq' = cmpMatch[1] === '=' ? 'eq' : 'neq'
    const rawVal = cmpMatch[2].trim()
    let parsedVal: unknown = rawVal
    if (rawVal.startsWith("'") && rawVal.endsWith("'") && rawVal.length >= 2) {
      parsedVal = rawVal.slice(1, -1).replace(/''/g, "'")
    } else if (/^true$/i.test(rawVal)) {
      parsedVal = true
    } else if (/^false$/i.test(rawVal)) {
      parsedVal = false
    } else if (/^[+-]?\d+(?:\.\d+)?$/.test(rawVal)) {
      parsedVal = Number(rawVal)
    }
    return { column, op, value: parsedVal }
  }
  return null
}

function fuzzyMatchScore(query: string, candidate: string): number {
  const q = query.trim().toLowerCase()
  if (!q) return 1
  const c = candidate.toLowerCase()
  if (c === q) return 100
  if (c.startsWith(q)) return 80
  const idx = c.indexOf(q)
  if (idx >= 0) return 60 - Math.min(idx, 30)
  let qi = 0
  let consecutive = 0
  let score = 0
  for (let ci = 0; ci < c.length && qi < q.length; ci++) {
    if (c[ci] === q[qi]) {
      qi++
      consecutive++
      score += 2 + consecutive
    } else {
      consecutive = 0
    }
  }
  return qi === q.length ? score : 0
}

function extractQueriedTableName(sqlText: string): string | null {
  const cleaned = sqlText
    .replace(/--[^\r\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\b(?:EXTRACT|TRIM)\s*\([^()]*\bFROM\b[^()]*\)/gi, ' ')
    .trim()
  if (!/^\s*(?:WITH\b[\s\S]+?\bSELECT|SELECT)\b/i.test(cleaned)) {
    return null
  }
  const match = /\bFROM\s+(?:["`[\]]?[A-Za-z0-9_]+["`[\]]?\s*\.\s*)?["`[]?([A-Za-z0-9_]+)["`\]]?/i.exec(
    cleaned
  )
  if (!match || !match[1]) return null
  const candidate = match[1]
  if (/^(?:SELECT|WHERE|VALUES|LATERAL|UNNEST)$/i.test(candidate)) return null
  return candidate
}

function copyTextFallback(text: string, triggerBtn?: HTMLButtonElement | null): void {
  if (typeof document !== 'undefined' && document.body) {
    const prevActive =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '-9999px'
    ta.style.left = '-9999px'
    ta.style.width = '1px'
    ta.style.height = '1px'
    ta.style.opacity = '0'
    ta.style.pointerEvents = 'none'
    document.body.appendChild(ta)
    try {
      ta.focus({ preventScroll: true })
    } catch {
      ta.focus()
    }
    ta.select()
    try {
      if (typeof ta.setSelectionRange === 'function') {
        ta.setSelectionRange(0, text.length)
      }
    } catch {
      // Ignore in minimal test DOM
    }
    try {
      document.execCommand?.('copy')
    } catch {
      // Ignore fallback failure
    }
    ta.remove()
    if (prevActive && typeof prevActive.focus === 'function') {
      try {
        prevActive.focus({ preventScroll: true })
      } catch {
        prevActive.focus()
      }
    }
  }
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    void Promise.resolve(navigator.clipboard.writeText(text)).catch(() => {})
  }
  if (triggerBtn) {
    const orig = triggerBtn.dataset.origLabel || triggerBtn.textContent || 'Copy'
    triggerBtn.dataset.origLabel = orig
    triggerBtn.textContent = 'Copied!'
    setTimeout(() => {
      triggerBtn.textContent = orig
    }, 1200)
  }
}

export class DatanoaStudioEditor {
  private styleEl: HTMLStyleElement | null = null
  private rootEl: HTMLDivElement | null = null
  private sidebarEl: HTMLElement | null = null
  private sqlConsole: SqlConsoleController | null = null
  private dataGrid: VirtualDataGrid | null = null
  private schemaInspector: SchemaInspectorView | null = null

  private connLogoEl: HTMLSpanElement | null = null
  private connSelectEl: HTMLSelectElement | null = null
  private envPillEl: HTMLSpanElement | null = null
  private roBadgeEl: HTMLSpanElement | null = null
  private addConnBtn: HTMLButtonElement | null = null
  private editConnBtn: HTMLButtonElement | null = null
  private cautionStripEl: HTMLDivElement | null = null
  private runBtn: HTMLButtonElement | null = null
  private runAllBtn: HTMLButtonElement | null = null
  private explainBtn: HTMLButtonElement | null = null
  private formatSqlBtn: HTMLButtonElement | null = null
  private cancelQueryBtn: HTMLButtonElement | null = null
  private historyBtn: HTMLButtonElement | null = null
  private refreshBtn: HTMLButtonElement | null = null
  private historyDrawerEl: HTMLDivElement | null = null
  private historySearchEl: HTMLInputElement | null = null
  private clearHistoryBtn: HTMLButtonElement | null = null
  private historyListEl: HTMLDivElement | null = null
  private cachedHistoryEntries: QueryHistoryEntry[] = []
  private historySearchQuery = ''

  private sidebarListEl: HTMLDivElement | null = null
  private searchInputEl: HTMLInputElement | null = null
  private newTableBtn: HTMLButtonElement | null = null
  private topbarNewTableBtn: HTMLButtonElement | null = null
  private mainViewEl: HTMLDivElement | null = null
  private sqlToolbarEl: HTMLDivElement | null = null
  private sqlAreaEl: HTMLDivElement | null = null
  private splitResizerEl: HTMLDivElement | null = null
  private sidebarContextMenuEl: HTMLDivElement | null = null
  private gridSubbarEl: HTMLDivElement | null = null
  private gridToolbarEl: HTMLDivElement | null = null
  private gridSubbarTitleEl: HTMLSpanElement | null = null
  private gridPageInfoEl: HTMLSpanElement | null = null
  private prevBtn: HTMLButtonElement | null = null
  private nextBtn: HTMLButtonElement | null = null
  private pageSizeSelectEl: HTMLSelectElement | null = null
  private queryBannerEl: HTMLDivElement | null = null
  private queryBannerTitleEl: HTMLSpanElement | null = null
  private queryBannerDetailEl: HTMLDivElement | null = null
  private queryBannerCopyBtn: HTMLButtonElement | null = null
  private queryBannerRetryBtn: HTMLButtonElement | null = null
  private queryBannerBackBtn: HTMLButtonElement | null = null
  private queryBannerRetryHandler: (() => void) | null = null
  private lastQueryErrorText = ''
  private whereInputEl: HTMLInputElement | null = null
  private orderByInputEl: HTMLInputElement | null = null
  private filterBtn: HTMLButtonElement | null = null
  private clearFilterBtn: HTMLButtonElement | null = null
  private clientSearchEl: HTMLInputElement | null = null
  private searchMode: 'filter' | 'find' = 'filter'
  private searchModeBtn: HTMLButtonElement | null = null
  private findCountEl: HTMLSpanElement | null = null
  private findPrevBtn: HTMLButtonElement | null = null
  private findNextBtn: HTMLButtonElement | null = null

  private addRowBtn: HTMLButtonElement | null = null
  private delRowBtn: HTMLButtonElement | null = null
  private cloneRowBtn: HTMLButtonElement | null = null
  private inspectCellBtn: HTMLButtonElement | null = null
  private dmlPreviewBtn: HTMLButtonElement | null = null
  private submitBtn: HTMLButtonElement | null = null
  private revertBtn: HTMLButtonElement | null = null
  private transposeBtn: HTMLButtonElement | null = null
  private columnsBtn: HTMLButtonElement | null = null
  private exportSelectEl: HTMLSelectElement | null = null
  private batchModeBtn: HTMLButtonElement | null = null
  private editTableBtn: HTMLButtonElement | null = null
  private isRestoringViewState = false
  private restoredPageOnBoot: number | null = null

  private dmlPreviewEl: HTMLDivElement | null = null
  private dmlApplyBtn: HTMLButtonElement | null = null
  private dmlPreviewPreEl: HTMLPreElement | null = null

  private valueInspectorEl: HTMLDivElement | null = null
  private valueInspectorTitleEl: HTMLSpanElement | null = null
  private valueNullBadgeEl: HTMLSpanElement | null = null
  private valueInspectorStatusEl: HTMLDivElement | null = null
  private valueInspectorTextEl: HTMLTextAreaElement | null = null
  private valueApplyBtn: HTMLButtonElement | null = null
  private valueNullBtn: HTMLButtonElement | null = null

  private statusStateEl: HTMLSpanElement | null = null
  private statusSelectionEl: HTMLButtonElement | null = null
  private shortcutHintEl: HTMLSpanElement | null = null
  private statusMetricsEl: HTMLSpanElement | null = null
  private shortcutsBtn: HTMLButtonElement | null = null
  private gridAreaEl: HTMLDivElement | null = null
  private inspectorAreaEl: HTMLDivElement | null = null

  private tabButtons: {
    split: HTMLButtonElement
    grid: HTMLButtonElement
    sql: HTMLButtonElement
    inspector: HTMLButtonElement
  } | null = null

  private connections: ConnectionProfile[] = []
  private schemaObjects: SchemaObject[] = []
  private filterQuery = ''
  private activeConnectionId: string | null = null
  private activeTable: string | null = null
  private activeSchema: string | undefined = undefined
  private lastLoadedTableKey: string | null = null
  private activeWhereClause: string | undefined = undefined
  private activeOrderByClause: string | undefined = undefined

  private pendingDocConnectionId: string | null = null
  private pendingDocTable: string | null = null
  private pendingDocSchema: string | undefined = undefined
  private storedActiveConnectionId: string | null = null
  private preservedMetadataLines: string[] = []
  private hasLoadedActiveConnection = false

  private currentPage = 1
  private totalRows = 0
  private currentPageRowCount = 0
  private pageSize = 100
  private activeViewMode: 'split' | 'grid' | 'sql' | 'inspector' = 'split'
  private customSqlPanePx: number | null = null
  private splitResizeListeners: {
    move: (e: MouseEvent) => void
    up: () => void
    blur: () => void
  } | null = null
  private splitResizeRafId: number | null = null
  private introspectToken = 0
  private gridViewSeq = 0
  private tableLoadToken = 0
  private schemaLoadToken = 0
  private querySeq = 0
  private connectionsSeq = 0
  private historySeq = 0
  private dmlPreviewSeq = 0
  private countRowsSeq = 0
  private cancelledQueryIds = new Set<string>()
  private clientSearchDebounceTimer: ReturnType<typeof setTimeout> | null = null
  private saveViewStateTimer: ReturnType<typeof setTimeout> | null = null
  private isIntrospectingSchema = false
  private isTableLoading = false
  private isSubmittingChanges = false
  private isCancellingQuery = false
  private isRefreshingSchema = false
  private isPreviewingDml = false
  private isSavingCell = false
  private isClearingHistory = false
  private schemaMap: Record<string, string[]> = {}
  private tableDetailsCache = new Map<string, TableDetails>()
  private inFlightTableDetails = new Map<string, Promise<TableDetails>>()
  private columnConfigByTable: Record<string, TableColumnConfig> = {}
  private lastSelectionSummary: SelectionSummary | null = null
  private documentSession: DocumentSessionLike | null = null
  private replaceSub: { dispose(): void } | null = null
  private disposables: Array<{ dispose(): void }> = []
  private activeTimerStops = new Set<() => void>()
  private suppressDocSync = false
  private isShowingSqlResult = false
  private activeQueryId: string | null = null
  private currentCanEdit = false
  private selectedCell: SelectedCellInfo | null = null
  private isInspectorOpen = false
  private isHistoryOpen = false
  private sidebarCollapsed = false
  private sidebarToggleBtn: HTMLButtonElement | null = null
  private tableTopbarEl: HTMLDivElement | null = null
  private topbarFilterInputEl: HTMLInputElement | null = null
  private topbarCountEl: HTMLSpanElement | null = null
  private topbarTrackEl: HTMLDivElement | null = null
  private topbarAllBtn: HTMLButtonElement | null = null
  private topbarPopoverEl: HTMLDivElement | null = null
  private topbarPopoverOutsideCleanup: (() => void) | null = null
  private colsPopoverEl: HTMLDivElement | null = null
  private colsPopoverOutsideCleanup: (() => void) | null = null
  private activeModalBackdrop: HTMLDivElement | null = null
  private activeModalKeyCleanup: (() => void) | null = null
  private lastInspectorLoadedKey = ''

  constructor() {
    this.injectStyles()
    this.syncInitialThemeFromHost()
    this.buildDOM()
    this.restoreStudioViewStateFromLocal()
    this.bindEvents()
  }

  private createElapsedTimer(onTick: (elapsedText: string, elapsedMs: number) => void): () => void {
    const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now()
    let stopped = false
    const timerId = setInterval(() => {
      if (stopped) return
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
      const elapsedMs = Math.max(0, now - startedAt)
      onTick(`${(elapsedMs / 1000).toFixed(1)}s`, elapsedMs)
    }, 100)
    const stop = () => {
      if (stopped) return
      stopped = true
      clearInterval(timerId)
      this.activeTimerStops.delete(stop)
    }
    this.activeTimerStops.add(stop)
    return stop
  }

  private stopAllTimers(): void {
    for (const stop of Array.from(this.activeTimerStops)) {
      stop()
    }
    this.activeTimerStops.clear()
  }

  private readLocalStudioViewState(): StudioPersistedViewState | null {
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

  private applyRestoredStudioViewState(saved: StudioPersistedViewState | null): void {
    if (!saved || typeof saved !== 'object') return
    this.isRestoringViewState = true
    try {
      if (
        saved.pageSize &&
        Number.isFinite(saved.pageSize) &&
        [100, 500, 1000, 5000, 10000].includes(Number(saved.pageSize))
      ) {
        this.pageSize = Number(saved.pageSize)
        if (this.pageSizeSelectEl) {
          this.pageSizeSelectEl.value = String(this.pageSize)
        }
      }
      if (saved.customSqlPanePx && Number.isFinite(saved.customSqlPanePx) && saved.customSqlPanePx >= 80) {
        this.customSqlPanePx = Number(saved.customSqlPanePx)
      }
      if (typeof saved.filterQuery === 'string' && this.searchInputEl) {
        this.filterQuery = saved.filterQuery.toLowerCase()
        this.searchInputEl.value = saved.filterQuery
        if (this.topbarFilterInputEl) {
          this.topbarFilterInputEl.value = saved.filterQuery
        }
      }
      if (typeof saved.sidebarCollapsed === 'boolean') {
        this.setSidebarCollapsed(saved.sidebarCollapsed, false)
      }
      if (typeof saved.clientFilter === 'string' && this.clientSearchEl) {
        this.clientSearchEl.value = saved.clientFilter
        this.dataGrid?.setClientFilter(saved.clientFilter)
      }
      if (typeof saved.isTransposed === 'boolean' && this.dataGrid) {
        this.dataGrid.setTransposed(saved.isTransposed)
        this.transposeBtn?.classList.toggle('active', saved.isTransposed)
      }
      if (!this.pendingDocConnectionId && saved.activeConnectionId) {
        this.storedActiveConnectionId = saved.activeConnectionId
        this.pendingDocConnectionId = saved.activeConnectionId
      }
      if (!this.pendingDocTable && saved.activeTable) {
        this.pendingDocTable = saved.activeTable
        this.activeTable = saved.activeTable
      }
      if (!this.pendingDocSchema && saved.activeSchema) {
        this.pendingDocSchema = saved.activeSchema
        this.activeSchema = saved.activeSchema
      }
      if (typeof saved.activeWhereClause === 'string' && saved.activeWhereClause.trim()) {
        this.activeWhereClause = saved.activeWhereClause
        if (this.whereInputEl) this.whereInputEl.value = saved.activeWhereClause
      }
      if (typeof saved.activeOrderByClause === 'string' && saved.activeOrderByClause.trim()) {
        this.activeOrderByClause = saved.activeOrderByClause
        if (this.orderByInputEl) this.orderByInputEl.value = saved.activeOrderByClause
      }
      if (saved.currentPage && Number.isFinite(saved.currentPage) && saved.currentPage >= 1) {
        this.currentPage = Math.floor(saved.currentPage)
        this.restoredPageOnBoot = this.currentPage
      }
      if (
        typeof saved.sqlDraft === 'string' &&
        saved.sqlDraft.trim().length > 0 &&
        !this.documentSession
      ) {
        this.suppressDocSync = true
        try {
          this.sqlConsole?.setText(saved.sqlDraft)
        } finally {
          this.suppressDocSync = false
        }
      }
      if (saved.columnConfigByTable && typeof saved.columnConfigByTable === 'object') {
        const nextMap: Record<string, TableColumnConfig> = {}
        for (const [k, v] of Object.entries(saved.columnConfigByTable)) {
          if (v && Array.isArray(v.hidden) && Array.isArray(v.pinned)) {
            nextMap[k] = {
              hidden: v.hidden.filter((x): x is string => typeof x === 'string'),
              pinned: v.pinned.filter((x): x is string => typeof x === 'string'),
            }
          }
        }
        this.columnConfigByTable = nextMap
      }
      if (
        saved.activeViewMode &&
        (saved.activeViewMode === 'split' ||
          saved.activeViewMode === 'grid' ||
          saved.activeViewMode === 'sql' ||
          saved.activeViewMode === 'inspector')
      ) {
        this.switchMode(saved.activeViewMode)
      } else if (this.customSqlPanePx !== null) {
        this.applyClampedSplitPaneHeight()
      }
      if (this.customSqlPanePx !== null && typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => {
          this.applyClampedSplitPaneHeight()
          this.dataGrid?.handleViewportResize()
        })
      }
    } finally {
      this.isRestoringViewState = false
    }
  }

  private restoreStudioViewStateFromLocal(): void {
    const saved = this.readLocalStudioViewState()
    if (saved) {
      this.applyRestoredStudioViewState(saved)
    }
  }

  private getClampedSqlPanePx(desiredPx: number): number {
    const measuredMain = this.mainViewEl?.getBoundingClientRect?.().height || 0
    const fallbackMain =
      typeof window !== 'undefined' ? Math.max(240, (window.innerHeight || 680) - 80) : 600
    const mainHeight = measuredMain > 0 ? measuredMain : fallbackMain
    const maxByRatio = Math.floor(mainHeight * 0.72)
    const maxByGridMin = Math.max(80, Math.floor(mainHeight - 140))
    const maxPx = Math.max(80, Math.min(maxByRatio, maxByGridMin))
    return Math.max(80, Math.min(maxPx, Math.round(desiredPx)))
  }

  private applyClampedSplitPaneHeight(): void {
    if (this.activeViewMode !== 'split' || !this.sqlAreaEl || this.customSqlPanePx === null) return
    const clamped = this.getClampedSqlPanePx(this.customSqlPanePx)
    this.sqlAreaEl.style.flex = `0 0 ${clamped}px`
  }

  private writeStudioViewStateNow(): void {
    if (this.isRestoringViewState || typeof window === 'undefined') return
    const snapshot: StudioPersistedViewState = {
      activeViewMode: this.activeViewMode,
      activeConnectionId: this.activeConnectionId,
      activeTable: this.activeTable,
      activeSchema: this.activeSchema,
      currentPage: this.currentPage,
      pageSize: this.pageSize,
      activeWhereClause: this.activeWhereClause,
      activeOrderByClause: this.activeOrderByClause,
      clientFilter: this.clientSearchEl?.value || '',
      filterQuery: this.searchInputEl?.value || '',
      isTransposed: Boolean(this.dataGrid?.getTransposed()),
      sidebarCollapsed: this.sidebarCollapsed,
      customSqlPanePx: this.customSqlPanePx,
      sqlDraft: this.sqlConsole?.getText() || '',
      columnConfigByTable: this.columnConfigByTable,
    }
    try {
      window.localStorage?.setItem(STUDIO_VIEW_STATE_STORAGE_KEY, JSON.stringify(snapshot))
    } catch {
      // Ignore storage quota errors
    }
    try {
      if (typeof window.orca?.storage?.set === 'function') {
        void Promise.resolve(
          window.orca.storage.set(
            STUDIO_VIEW_STATE_STORAGE_KEY,
            sanitizeJsonPayload(snapshot) as unknown as Record<string, string | number | boolean | null>
          )
        ).catch(() => {})
      }
    } catch {
      // Ignore host storage write errors
    }
  }

  private saveStudioViewState(immediate = true): void {
    if (this.isRestoringViewState || typeof window === 'undefined') return
    if (this.saveViewStateTimer !== null) {
      clearTimeout(this.saveViewStateTimer)
      this.saveViewStateTimer = null
    }
    if (immediate) {
      this.writeStudioViewStateNow()
      return
    }
    this.saveViewStateTimer = setTimeout(() => {
      this.saveViewStateTimer = null
      this.writeStudioViewStateNow()
    }, 300)
  }

  private flushStudioViewState(): void {
    if (this.saveViewStateTimer !== null) {
      clearTimeout(this.saveViewStateTimer)
      this.saveViewStateTimer = null
      this.writeStudioViewStateNow()
    }
  }

  private cancelClientSearchDebounce(): void {
    if (this.clientSearchDebounceTimer !== null) {
      clearTimeout(this.clientSearchDebounceTimer)
      this.clientSearchDebounceTimer = null
    }
  }

  private async requestPlugin<T = unknown>(
    name: string,
    input?: Record<string, unknown>,
    options?: { timeoutMs?: number }
  ): Promise<T> {
    if (typeof window === 'undefined' || !window.orca?.plugin?.request) {
      throw new Error('Orca plugin bridge is not available')
    }
    const reqFn = window.orca.plugin.request as unknown as (
      reqName: string,
      reqInput?: unknown,
      reqOptions?: { timeoutMs?: number }
    ) => Promise<T>

    if (input === undefined && options === undefined) {
      return await reqFn(name)
    }
    const cleanInput = input === undefined ? undefined : sanitizeJsonPayload(input)
    if (options !== undefined) {
      return await reqFn(name, cleanInput, options)
    }
    return await reqFn(name, cleanInput)
  }

  private injectStyles(): void {
    if (typeof document === 'undefined') return
    this.styleEl = document.createElement('style')
    this.styleEl.textContent = EDITOR_STYLE
    document.head.appendChild(this.styleEl)
  }

  private syncInitialThemeFromHost(): void {
    if (typeof document === 'undefined') return
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

  private applyHostTypography(typography?: Partial<EditorTypography> | null): void {
    if (!typography) return
    if (this.rootEl) {
      const mono = typography.cssFontFamily || typography.fontFamily
      if (mono) {
        this.rootEl.style.setProperty('--mono-font', mono)
      }
    }
    this.sqlConsole?.applyTypography({
      fontFamily: typography.fontFamily,
      cssFontFamily: typography.cssFontFamily,
      fontSize: typography.fontSize,
      lineHeight: typography.lineHeight,
      fontWeight: typography.fontWeight,
      fontLigatures: typography.fontLigatures,
    })
  }

  private buildDOM(): void {
    if (typeof document === 'undefined') return

    this.rootEl = document.createElement('div')
    this.rootEl.className = 'datanoa-editor-root'

    // 1. Top Studio Header Toolbar
    const toolbar = document.createElement('div')
    toolbar.className = 'datanoa-toolbar'

    const sidebarToggleBtn = document.createElement('button')
    sidebarToggleBtn.type = 'button'
    sidebarToggleBtn.className = 'datanoa-btn datanoa-sidebar-toggle'
    sidebarToggleBtn.title = 'Switch Table Explorer Mode (Left Sidebar ↔ Top Horizontal Bar)'
    sidebarToggleBtn.setAttribute('aria-label', 'Switch Table Explorer Mode')
    const menuSvg = createSvgElement('svg', {
      width: '14',
      height: '14',
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '2',
      'stroke-linecap': 'round',
      'aria-hidden': 'true',
    })
    menuSvg.appendChild(createSvgElement('line', { x1: '3', y1: '6', x2: '21', y2: '6' }))
    menuSvg.appendChild(createSvgElement('line', { x1: '3', y1: '12', x2: '21', y2: '12' }))
    menuSvg.appendChild(createSvgElement('line', { x1: '3', y1: '18', x2: '21', y2: '18' }))
    sidebarToggleBtn.appendChild(menuSvg)
    sidebarToggleBtn.addEventListener('click', () => {
      this.setSidebarCollapsed(!this.sidebarCollapsed, true)
    })
    this.sidebarToggleBtn = sidebarToggleBtn

    const brandPill = document.createElement('div')
    brandPill.className = 'datanoa-brand-pill'
    const brandLogo = document.createElement('img')
    brandLogo.className = 'datanoa-brand-logo'
    brandLogo.src = DATANOA_LOGO_DATA_URI
    brandLogo.alt = 'Datanoa'
    const brandText = document.createElement('span')
    brandText.textContent = 'Datanoa Studio'
    brandPill.appendChild(brandLogo)
    brandPill.appendChild(brandText)

    const connCluster = document.createElement('div')
    connCluster.className = 'datanoa-conn-cluster'

    this.connLogoEl = document.createElement('span')
    this.connLogoEl.className = 'datanoa-db-logo'
    this.connLogoEl.appendChild(createDbLogoSvg('sqlite'))

    this.connSelectEl = document.createElement('select')
    this.connSelectEl.className = 'datanoa-select'
    this.connSelectEl.setAttribute('aria-label', 'Active Database Connection')
    const defaultOpt = document.createElement('option')
    defaultOpt.value = ''
    defaultOpt.textContent = 'Select Connection...'
    this.connSelectEl.appendChild(defaultOpt)
    this.connSelectEl.addEventListener('change', () => {
      const nextId = this.connSelectEl?.value || null
      this.pendingDocConnectionId = null
      this.pendingDocTable = null
      this.handleConnectionChanged(nextId)
      if (nextId) {
        this.updateMetadataHeader('connectionId', nextId)
      }
    })

    this.envPillEl = document.createElement('span')
    this.envPillEl.className = 'datanoa-env-pill'
    this.envPillEl.style.display = 'none'

    this.roBadgeEl = document.createElement('span')
    this.roBadgeEl.className = 'datanoa-ro-badge'
    this.roBadgeEl.textContent = 'RO'
    this.roBadgeEl.title = 'Read-Only Connection'
    this.roBadgeEl.style.display = 'none'

    connCluster.appendChild(this.connLogoEl)
    connCluster.appendChild(this.connSelectEl)
    connCluster.appendChild(this.envPillEl)
    connCluster.appendChild(this.roBadgeEl)

    this.addConnBtn = document.createElement('button')
    this.addConnBtn.type = 'button'
    this.addConnBtn.className =
      'datanoa-btn datanoa-btn-primary datanoa-btn-sm datanoa-add-conn-btn'
    this.addConnBtn.textContent = '+ Connect'
    this.addConnBtn.title = 'Add a new database connection'
    this.addConnBtn.addEventListener('click', () => {
      this.openConnectionModal()
    })

    this.editConnBtn = document.createElement('button')
    this.editConnBtn.type = 'button'
    this.editConnBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-edit-conn-btn'
    this.editConnBtn.textContent = 'Edit'
    this.editConnBtn.title = 'Edit active database connection'
    this.editConnBtn.disabled = true
    this.editConnBtn.addEventListener('click', () => {
      const active = this.getActiveConnection()
      if (active) this.openConnectionModal(active)
    })

    connCluster.appendChild(this.addConnBtn)
    connCluster.appendChild(this.editConnBtn)

    this.runBtn = document.createElement('button')
    this.runBtn.type = 'button'
    this.runBtn.className = 'datanoa-btn datanoa-btn-primary'
    this.runBtn.textContent = 'Execute (Ctrl+Enter)'
    this.runBtn.addEventListener('click', () => {
      void this.executeSql(false)
    })

    this.runAllBtn = document.createElement('button')
    this.runAllBtn.type = 'button'
    this.runAllBtn.className = 'datanoa-btn'
    this.runAllBtn.textContent = 'Execute All'
    this.runAllBtn.title = 'Execute all SQL statements in console (Ctrl+Shift+Enter)'
    this.runAllBtn.addEventListener('click', () => {
      void this.executeSql(true)
    })

    this.explainBtn = document.createElement('button')
    this.explainBtn.type = 'button'
    this.explainBtn.className = 'datanoa-btn'
    this.explainBtn.textContent = 'Explain'
    this.explainBtn.addEventListener('click', () => {
      void this.explainSql()
    })

    this.formatSqlBtn = document.createElement('button')
    this.formatSqlBtn.type = 'button'
    this.formatSqlBtn.className = 'datanoa-btn'
    this.formatSqlBtn.textContent = 'Format SQL'
    this.formatSqlBtn.title = 'Format SQL in console (Shift+Alt+F)'
    this.formatSqlBtn.addEventListener('click', () => {
      this.formatSqlInConsole()
    })

    this.cancelQueryBtn = document.createElement('button')
    this.cancelQueryBtn.type = 'button'
    this.cancelQueryBtn.className = 'datanoa-btn datanoa-btn-danger'
    this.cancelQueryBtn.textContent = 'Cancel'
    this.cancelQueryBtn.style.display = 'none'
    this.cancelQueryBtn.addEventListener('click', () => {
      void this.cancelActiveQuery()
    })

    this.historyBtn = document.createElement('button')
    this.historyBtn.type = 'button'
    this.historyBtn.className = 'datanoa-btn'
    this.historyBtn.textContent = 'Query History'
    this.historyBtn.addEventListener('click', () => {
      void this.toggleQueryHistory()
    })

    this.refreshBtn = document.createElement('button')
    this.refreshBtn.type = 'button'
    this.refreshBtn.className = 'datanoa-btn'
    this.refreshBtn.textContent = 'Refresh'
    this.refreshBtn.addEventListener('click', () => {
      void this.handleRefreshAction()
    })

    this.sqlToolbarEl = document.createElement('div')
    this.sqlToolbarEl.className = 'datanoa-sql-toolbar'
    this.sqlToolbarEl.appendChild(this.runBtn)
    this.sqlToolbarEl.appendChild(this.runAllBtn)
    this.sqlToolbarEl.appendChild(this.explainBtn)
    this.sqlToolbarEl.appendChild(this.formatSqlBtn)
    this.sqlToolbarEl.appendChild(this.cancelQueryBtn)
    this.sqlToolbarEl.appendChild(this.historyBtn)

    // Segmented Mode Tabs
    const tabsContainer = document.createElement('div')
    tabsContainer.className = 'datanoa-tabs'

    const splitTabBtn = document.createElement('button')
    splitTabBtn.type = 'button'
    splitTabBtn.className = 'datanoa-tab-btn active'
    splitTabBtn.textContent = 'Split View'

    const gridTabBtn = document.createElement('button')
    gridTabBtn.type = 'button'
    gridTabBtn.className = 'datanoa-tab-btn'
    gridTabBtn.textContent = 'Data Grid'

    const sqlTabBtn = document.createElement('button')
    sqlTabBtn.type = 'button'
    sqlTabBtn.className = 'datanoa-tab-btn'
    sqlTabBtn.textContent = 'SQL Console'

    const inspectorTabBtn = document.createElement('button')
    inspectorTabBtn.type = 'button'
    inspectorTabBtn.className = 'datanoa-tab-btn'
    inspectorTabBtn.textContent = 'Schema Inspector'

    this.tabButtons = {
      split: splitTabBtn,
      grid: gridTabBtn,
      sql: sqlTabBtn,
      inspector: inspectorTabBtn,
    }

    splitTabBtn.addEventListener('click', () => this.switchMode('split'))
    gridTabBtn.addEventListener('click', () => this.switchMode('grid'))
    sqlTabBtn.addEventListener('click', () => this.switchMode('sql'))
    inspectorTabBtn.addEventListener('click', () => this.switchMode('inspector'))

    tabsContainer.appendChild(splitTabBtn)
    tabsContainer.appendChild(gridTabBtn)
    tabsContainer.appendChild(sqlTabBtn)
    tabsContainer.appendChild(inspectorTabBtn)

    toolbar.appendChild(sidebarToggleBtn)
    toolbar.appendChild(brandPill)
    toolbar.appendChild(connCluster)
    toolbar.appendChild(this.refreshBtn)
    toolbar.appendChild(tabsContainer)

    // Caution strip for PROD / Read-Only connections
    this.cautionStripEl = document.createElement('div')
    this.cautionStripEl.className = 'datanoa-caution-strip'
    this.cautionStripEl.style.display = 'none'

    // 2. Three-Pane Studio Body (Left Sidebar + Center Workspace)
    const workspaceBody = document.createElement('div')
    workspaceBody.className = 'datanoa-workspace-body'

    // Left Explorer Sidebar
    this.sidebarEl = document.createElement('aside')
    this.sidebarEl.className = 'datanoa-sidebar'

    const sidebarHeader = document.createElement('div')
    sidebarHeader.className = 'datanoa-sidebar-header'

    this.searchInputEl = document.createElement('input')
    this.searchInputEl.className = 'datanoa-search-input'
    this.searchInputEl.type = 'search'
    this.searchInputEl.placeholder = 'Filter tables & views...'
    this.searchInputEl.addEventListener('input', () => {
      const rawVal = this.searchInputEl?.value || ''
      this.filterQuery = rawVal.toLowerCase()
      if (this.topbarFilterInputEl && this.topbarFilterInputEl.value !== rawVal) {
        this.topbarFilterInputEl.value = rawVal
      }
      this.renderSidebarObjects()
      this.saveStudioViewState(false)
    })

    this.newTableBtn = document.createElement('button')
    this.newTableBtn.type = 'button'
    this.newTableBtn.className = 'datanoa-btn datanoa-btn-sm'
    this.newTableBtn.textContent = '+ New Table'
    this.newTableBtn.title = 'Create a new table visually'
    this.newTableBtn.disabled = true
    this.newTableBtn.addEventListener('click', () => {
      this.openCreateTableModal()
    })

    sidebarHeader.appendChild(this.searchInputEl)
    sidebarHeader.appendChild(this.newTableBtn)

    this.sidebarListEl = document.createElement('div')
    this.sidebarListEl.className = 'datanoa-sidebar-list'
    this.sidebarListEl.addEventListener('scroll', () => {
      this.closeSidebarContextMenu()
      this.closeTopbarPopover()
    })

    this.sidebarEl.appendChild(sidebarHeader)
    this.sidebarEl.appendChild(this.sidebarListEl)

    // Main Center View
    const mainView = document.createElement('div')
    mainView.className = 'datanoa-main-view'
    this.mainViewEl = mainView

    // Horizontal Top Table Switcher Bar (Mode 2 when Sidebar is collapsed)
    this.tableTopbarEl = document.createElement('div')
    this.tableTopbarEl.className = 'datanoa-table-topbar'

    const topbarFilterWrap = document.createElement('div')
    topbarFilterWrap.className = 'datanoa-topbar-filter-wrap'

    this.topbarFilterInputEl = document.createElement('input')
    this.topbarFilterInputEl.className = 'datanoa-topbar-filter'
    this.topbarFilterInputEl.type = 'search'
    this.topbarFilterInputEl.placeholder = 'Filter tables...'
    this.topbarFilterInputEl.addEventListener('input', () => {
      const rawVal = this.topbarFilterInputEl?.value || ''
      this.filterQuery = rawVal.toLowerCase()
      if (this.searchInputEl && this.searchInputEl.value !== rawVal) {
        this.searchInputEl.value = rawVal
      }
      this.renderSidebarObjects()
      this.saveStudioViewState(false)
    })

    this.topbarCountEl = document.createElement('span')
    this.topbarCountEl.className = 'datanoa-topbar-count'
    this.topbarCountEl.textContent = '0'

    topbarFilterWrap.appendChild(this.topbarFilterInputEl)
    topbarFilterWrap.appendChild(this.topbarCountEl)

    const topbarPrevBtn = document.createElement('button')
    topbarPrevBtn.type = 'button'
    topbarPrevBtn.className = 'datanoa-topbar-nav-btn'
    topbarPrevBtn.title = 'Scroll tables left'
    topbarPrevBtn.textContent = '‹'
    topbarPrevBtn.addEventListener('click', () => {
      if (this.topbarTrackEl) {
        this.topbarTrackEl.scrollLeft -= 240
      }
    })

    this.topbarTrackEl = document.createElement('div')
    this.topbarTrackEl.className = 'datanoa-table-topbar-track'
    this.topbarTrackEl.addEventListener(
      'wheel',
      (e: WheelEvent) => {
        if (!this.topbarTrackEl) return
        const raw = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX
        if (!raw) return
        e.preventDefault()
        const step = e.deltaMode === 1 ? raw * 28 : e.deltaMode === 2 ? raw * 320 : raw * 1.1
        this.topbarTrackEl.scrollLeft += step
      },
      { passive: false }
    )

    const topbarNextBtn = document.createElement('button')
    topbarNextBtn.type = 'button'
    topbarNextBtn.className = 'datanoa-topbar-nav-btn'
    topbarNextBtn.title = 'Scroll tables right'
    topbarNextBtn.textContent = '›'
    topbarNextBtn.addEventListener('click', () => {
      if (this.topbarTrackEl) {
        this.topbarTrackEl.scrollLeft += 240
      }
    })

    this.topbarAllBtn = document.createElement('button')
    this.topbarAllBtn.type = 'button'
    this.topbarAllBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-topbar-all-btn'
    this.topbarAllBtn.textContent = 'All (0) ▾'
    this.topbarAllBtn.title = 'Browse all tables & views in a dropdown list'
    this.topbarAllBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.toggleTopbarAllTablesPopover()
    })

    this.topbarNewTableBtn = document.createElement('button')
    this.topbarNewTableBtn.type = 'button'
    this.topbarNewTableBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-topbar-new-table-btn'
    this.topbarNewTableBtn.textContent = '+ Table'
    this.topbarNewTableBtn.title = 'Create a new table visually'
    this.topbarNewTableBtn.disabled = true
    this.topbarNewTableBtn.addEventListener('click', () => {
      this.openCreateTableModal()
    })

    this.tableTopbarEl.appendChild(topbarFilterWrap)
    this.tableTopbarEl.appendChild(topbarPrevBtn)
    this.tableTopbarEl.appendChild(this.topbarTrackEl)
    this.tableTopbarEl.appendChild(topbarNextBtn)
    this.tableTopbarEl.appendChild(this.topbarAllBtn)
    this.tableTopbarEl.appendChild(this.topbarNewTableBtn)

    // SQL Console Area
    this.sqlAreaEl = document.createElement('div')
    this.sqlAreaEl.className = 'datanoa-sql-area'

    // Draggable Horizontal Split Resizer
    this.splitResizerEl = document.createElement('div')
    this.splitResizerEl.className = 'datanoa-split-resizer'
    this.splitResizerEl.title = 'Drag to resize SQL Console & Data Grid'
    this.splitResizerEl.addEventListener('mousedown', (e) => {
      this.startSplitResize(e)
    })

    // Collapsible Query History Drawer
    this.historyDrawerEl = document.createElement('div')
    this.historyDrawerEl.className = 'datanoa-history-drawer'
    this.historyDrawerEl.style.display = 'none'

    const historyHead = document.createElement('div')
    historyHead.className = 'datanoa-drawer-head'
    const historyTitle = document.createElement('span')
    historyTitle.textContent = 'Query History'

    this.historySearchEl = document.createElement('input')
    this.historySearchEl.type = 'search'
    this.historySearchEl.className = 'datanoa-history-search'
    this.historySearchEl.placeholder = 'Filter query history...'
    this.historySearchEl.addEventListener('input', () => {
      this.historySearchQuery = (this.historySearchEl?.value || '').trim().toLowerCase()
      this.renderQueryHistoryList()
    })

    const historyHeadActions = document.createElement('div')
    historyHeadActions.className = 'datanoa-btn-group'

    this.clearHistoryBtn = document.createElement('button')
    this.clearHistoryBtn.type = 'button'
    this.clearHistoryBtn.className = 'datanoa-btn datanoa-btn-sm'
    this.clearHistoryBtn.textContent = 'Clear'
    this.clearHistoryBtn.addEventListener('click', () => {
      void this.clearQueryHistory()
    })

    const closeHistoryBtn = document.createElement('button')
    closeHistoryBtn.type = 'button'
    closeHistoryBtn.className = 'datanoa-btn datanoa-btn-sm'
    closeHistoryBtn.textContent = 'Close'
    closeHistoryBtn.addEventListener('click', () => {
      this.isHistoryOpen = false
      if (this.historyDrawerEl) this.historyDrawerEl.style.display = 'none'
      this.historyBtn?.classList.remove('active')
      this.dataGrid?.handleViewportResize()
    })

    historyHeadActions.appendChild(this.historySearchEl)
    historyHeadActions.appendChild(this.clearHistoryBtn)
    historyHeadActions.appendChild(closeHistoryBtn)
    historyHead.appendChild(historyTitle)
    historyHead.appendChild(historyHeadActions)

    this.historyListEl = document.createElement('div')
    this.historyDrawerEl.appendChild(historyHead)
    this.historyDrawerEl.appendChild(this.historyListEl)

    // Grid Sub-bar (Table Summary + Primary Actions + Pagination)
    this.gridSubbarEl = document.createElement('div')
    this.gridSubbarEl.className = 'datanoa-grid-subbar'

    const subLeft = document.createElement('div')
    subLeft.className = 'datanoa-grid-subbar-left'
    this.gridSubbarTitleEl = document.createElement('span')
    this.gridSubbarTitleEl.className = 'datanoa-grid-subbar-title'
    this.gridSubbarTitleEl.textContent = 'Select a table'
    subLeft.appendChild(this.gridSubbarTitleEl)

    const gridActions = document.createElement('div')
    gridActions.className = 'datanoa-btn-group'

    this.addRowBtn = document.createElement('button')
    this.addRowBtn.type = 'button'
    this.addRowBtn.className = 'datanoa-btn datanoa-btn-sm'
    this.addRowBtn.textContent = '+ Row'
    this.addRowBtn.disabled = true
    this.addRowBtn.addEventListener('click', () => {
      this.dataGrid?.addBlankRow()
    })

    this.delRowBtn = document.createElement('button')
    this.delRowBtn.type = 'button'
    this.delRowBtn.className = 'datanoa-btn datanoa-btn-sm'
    this.delRowBtn.textContent = '− Row'
    this.delRowBtn.disabled = true
    this.delRowBtn.addEventListener('click', () => {
      this.dataGrid?.bulkMarkRowsDeleted()
    })

    this.cloneRowBtn = document.createElement('button')
    this.cloneRowBtn.type = 'button'
    this.cloneRowBtn.className = 'datanoa-btn datanoa-btn-sm'
    this.cloneRowBtn.textContent = 'Clone'
    this.cloneRowBtn.disabled = true
    this.cloneRowBtn.addEventListener('click', () => {
      this.dataGrid?.bulkCloneSelectedRows()
    })

    this.inspectCellBtn = document.createElement('button')
    this.inspectCellBtn.type = 'button'
    this.inspectCellBtn.className = 'datanoa-btn datanoa-btn-sm'
    this.inspectCellBtn.textContent = 'Edit Cell'
    this.inspectCellBtn.title = 'Open Value / JSON Inspector for the selected cell'
    this.inspectCellBtn.disabled = true
    this.inspectCellBtn.addEventListener('click', () => {
      this.toggleValueInspector()
    })

    this.dmlPreviewBtn = document.createElement('button')
    this.dmlPreviewBtn.type = 'button'
    this.dmlPreviewBtn.className = 'datanoa-btn datanoa-btn-sm'
    this.dmlPreviewBtn.textContent = 'DML Preview'
    this.dmlPreviewBtn.disabled = true
    this.dmlPreviewBtn.addEventListener('click', () => {
      void this.previewStagedChanges()
    })

    this.submitBtn = document.createElement('button')
    this.submitBtn.type = 'button'
    this.submitBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-btn-primary'
    this.submitBtn.textContent = 'Submit [0]'
    this.submitBtn.disabled = true
    this.submitBtn.addEventListener('click', () => {
      void this.submitStagedChanges()
    })

    this.revertBtn = document.createElement('button')
    this.revertBtn.type = 'button'
    this.revertBtn.className = 'datanoa-btn datanoa-btn-sm'
    this.revertBtn.textContent = 'Revert'
    this.revertBtn.disabled = true
    this.revertBtn.addEventListener('click', () => {
      this.dataGrid?.revertAllChanges()
      if (this.dmlPreviewEl) this.dmlPreviewEl.style.display = 'none'
      this.updateStatus('Reverted staged changes')
    })

    this.transposeBtn = document.createElement('button')
    this.transposeBtn.type = 'button'
    this.transposeBtn.className = 'datanoa-btn datanoa-btn-sm'
    this.transposeBtn.textContent = '⇄ Transpose'
    this.transposeBtn.addEventListener('click', () => {
      if (!this.dataGrid || !this.transposeBtn) return
      const next = !this.dataGrid.getTransposed()
      this.dataGrid.setTransposed(next)
      this.transposeBtn.classList.toggle('active', next)
      this.saveStudioViewState()
    })

    this.columnsBtn = document.createElement('button')
    this.columnsBtn.type = 'button'
    this.columnsBtn.className = 'datanoa-btn datanoa-btn-sm'
    this.columnsBtn.textContent = 'Columns'
    this.columnsBtn.title = 'Toggle column visibility and pin/freeze columns'
    this.columnsBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.toggleColumnsPopover()
    })

    this.editTableBtn = document.createElement('button')
    this.editTableBtn.type = 'button'
    this.editTableBtn.className = 'datanoa-btn datanoa-btn-sm'
    this.editTableBtn.textContent = 'Edit Table'
    this.editTableBtn.title = 'Open Schema Inspector & Edit Table Structure (ALTER TABLE)'
    this.editTableBtn.addEventListener('click', () => {
      this.switchMode('inspector')
    })

    this.exportSelectEl = document.createElement('select')
    this.exportSelectEl.className = 'datanoa-select datanoa-select-sm'
    this.exportSelectEl.setAttribute('aria-label', 'Export Data Format')
    this.updateExportDropdownOptions()
    this.exportSelectEl.addEventListener('change', () => {
      const val = this.exportSelectEl?.value || ''
      if (!val) return
      this.handleExportAction(val)
      if (this.exportSelectEl) this.exportSelectEl.value = ''
    })

    gridActions.appendChild(this.addRowBtn)
    gridActions.appendChild(this.delRowBtn)
    gridActions.appendChild(this.cloneRowBtn)
    gridActions.appendChild(this.inspectCellBtn)
    gridActions.appendChild(this.dmlPreviewBtn)
    gridActions.appendChild(this.submitBtn)
    gridActions.appendChild(this.revertBtn)
    gridActions.appendChild(this.transposeBtn)
    gridActions.appendChild(this.columnsBtn)
    gridActions.appendChild(this.editTableBtn)
    gridActions.appendChild(this.exportSelectEl)

    subLeft.appendChild(gridActions)

    const subRight = document.createElement('div')
    subRight.className = 'datanoa-grid-subbar-right'

    this.batchModeBtn = document.createElement('button')
    this.batchModeBtn.type = 'button'
    this.batchModeBtn.className = 'datanoa-btn datanoa-btn-sm active'
    this.batchModeBtn.textContent = 'Batch: Staged'
    this.batchModeBtn.title = 'Toggle between Staged Batch edits and immediate Auto-Commit'
    this.batchModeBtn.addEventListener('click', () => {
      if (!this.dataGrid || !this.batchModeBtn) return
      const next = !this.dataGrid.isBatchMode()
      this.dataGrid.setBatchMode(next)
      this.batchModeBtn.classList.toggle('active', next)
      this.batchModeBtn.textContent = next ? 'Batch: Staged' : 'Auto-Commit'
    })

    this.prevBtn = document.createElement('button')
    this.prevBtn.type = 'button'
    this.prevBtn.className = 'datanoa-btn datanoa-btn-sm'
    this.prevBtn.textContent = 'Prev'
    this.prevBtn.disabled = true
    this.prevBtn.addEventListener('click', () => {
      if (this.isShowingSqlResult || this.isTableLoading) return
      if (this.activeConnectionId && this.activeTable && this.currentPage > 1) {
        void this.loadTableData(this.activeConnectionId, this.activeTable, this.currentPage - 1)
      }
    })

    this.gridPageInfoEl = document.createElement('span')
    this.gridPageInfoEl.className = 'datanoa-page-info'
    this.gridPageInfoEl.textContent = 'Page 1'

    this.nextBtn = document.createElement('button')
    this.nextBtn.type = 'button'
    this.nextBtn.className = 'datanoa-btn datanoa-btn-sm'
    this.nextBtn.textContent = 'Next'
    this.nextBtn.disabled = true
    this.nextBtn.addEventListener('click', () => {
      if (this.isShowingSqlResult || this.isTableLoading) return
      if (
        this.activeConnectionId &&
        this.activeTable &&
        this.currentPage * this.pageSize < this.totalRows
      ) {
        void this.loadTableData(this.activeConnectionId, this.activeTable, this.currentPage + 1)
      }
    })

    this.pageSizeSelectEl = document.createElement('select')
    this.pageSizeSelectEl.className = 'datanoa-select datanoa-select-sm'
    this.pageSizeSelectEl.setAttribute('aria-label', 'Rows per page')
    this.pageSizeSelectEl.title = 'Rows per page'
    const pageSizeOptions: ReadonlyArray<{ value: string; label: string }> = [
      { value: '100', label: '100 / page' },
      { value: '500', label: '500 / page' },
      { value: '1000', label: '1,000 / page' },
      { value: '5000', label: '5,000 / page' },
      { value: '10000', label: '10,000 / page' },
    ]
    for (const optDef of pageSizeOptions) {
      const opt = document.createElement('option')
      opt.value = optDef.value
      opt.textContent = optDef.label
      if (optDef.value === String(this.pageSize)) {
        opt.selected = true
      }
      this.pageSizeSelectEl.appendChild(opt)
    }
    this.pageSizeSelectEl.value = String(this.pageSize)
    this.pageSizeSelectEl.addEventListener('change', () => {
      const nextSize = Number(this.pageSizeSelectEl?.value)
      if (!Number.isFinite(nextSize) || nextSize < 1) return
      this.pageSize = nextSize
      this.currentPage = 1
      this.saveStudioViewState()
      if (!this.isShowingSqlResult && this.activeConnectionId && this.activeTable) {
        void this.loadTableData(this.activeConnectionId, this.activeTable, 1)
      }
    })

    subRight.appendChild(this.batchModeBtn)
    subRight.appendChild(this.pageSizeSelectEl)
    subRight.appendChild(this.prevBtn)
    subRight.appendChild(this.gridPageInfoEl)
    subRight.appendChild(this.nextBtn)

    this.gridSubbarEl.appendChild(subLeft)
    this.gridSubbarEl.appendChild(subRight)

    // JetBrains Data Grid Filter Toolbar
    this.gridToolbarEl = document.createElement('div')
    this.gridToolbarEl.className = 'datanoa-grid-toolbar'

    const whereGroup = document.createElement('div')
    whereGroup.className = 'datanoa-filter-group'
    const whereLbl = document.createElement('span')
    whereLbl.className = 'datanoa-filter-label'
    whereLbl.textContent = 'WHERE'
    this.whereInputEl = document.createElement('input')
    this.whereInputEl.className = 'datanoa-filter-input'
    this.whereInputEl.type = 'text'
    this.whereInputEl.placeholder = "status = 'active' (Enter)"
    this.whereInputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        void this.applyServerFilters()
      }
    })
    whereGroup.appendChild(whereLbl)
    whereGroup.appendChild(this.whereInputEl)

    const orderGroup = document.createElement('div')
    orderGroup.className = 'datanoa-filter-group'
    const orderLbl = document.createElement('span')
    orderLbl.className = 'datanoa-filter-label'
    orderLbl.textContent = 'ORDER BY'
    this.orderByInputEl = document.createElement('input')
    this.orderByInputEl.className = 'datanoa-filter-input'
    this.orderByInputEl.type = 'text'
    this.orderByInputEl.placeholder = 'id DESC (Enter)'
    this.orderByInputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        void this.applyServerFilters()
      }
    })
    orderGroup.appendChild(orderLbl)
    orderGroup.appendChild(this.orderByInputEl)

    this.filterBtn = document.createElement('button')
    this.filterBtn.type = 'button'
    this.filterBtn.className = 'datanoa-btn datanoa-btn-sm'
    this.filterBtn.textContent = 'Filter'
    this.filterBtn.addEventListener('click', () => {
      void this.applyServerFilters()
    })

    this.clearFilterBtn = document.createElement('button')
    this.clearFilterBtn.type = 'button'
    this.clearFilterBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-filter-clear-btn'
    this.clearFilterBtn.textContent = '×'
    this.clearFilterBtn.title = 'Clear WHERE, ORDER BY, and client column filters'
    this.clearFilterBtn.setAttribute('aria-label', 'Clear Filters')
    this.clearFilterBtn.addEventListener('click', () => {
      void this.clearAllFilters()
    })

    const findNavWrap = document.createElement('div')
    findNavWrap.className = 'datanoa-find-nav'

    this.searchModeBtn = document.createElement('button')
    this.searchModeBtn.type = 'button'
    this.searchModeBtn.className = 'datanoa-btn datanoa-btn-sm'
    this.searchModeBtn.textContent = 'Mode: Filter'
    this.searchModeBtn.title = 'Toggle between Client Row Filter and Find & Highlight (Ctrl+F)'
    this.searchModeBtn.addEventListener('click', () => {
      this.setGridSearchMode(this.searchMode === 'filter' ? 'find' : 'filter')
    })

    this.clientSearchEl = document.createElement('input')
    this.clientSearchEl.className = 'datanoa-client-search'
    this.clientSearchEl.type = 'search'
    this.clientSearchEl.placeholder = 'Search rows...'
    this.clientSearchEl.addEventListener('input', () => {
      this.cancelClientSearchDebounce()
      this.clientSearchDebounceTimer = setTimeout(() => {
        this.clientSearchDebounceTimer = null
        this.applyClientSearchOrFind()
      }, 150)
    })
    this.clientSearchEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        if (this.searchMode === 'find') {
          e.preventDefault()
          if (this.clientSearchDebounceTimer !== null) {
            this.cancelClientSearchDebounce()
            this.applyClientSearchOrFind()
          } else {
            const state = this.dataGrid?.findNext(e.shiftKey ? -1 : 1)
            this.updateFindCounter(state)
          }
        } else if (this.clientSearchDebounceTimer !== null) {
          e.preventDefault()
          this.cancelClientSearchDebounce()
          this.applyClientSearchOrFind()
        }
      } else if (e.key === 'Escape') {
        this.cancelClientSearchDebounce()
        if (this.clientSearchEl && this.clientSearchEl.value) {
          this.clientSearchEl.value = ''
          this.applyClientSearchOrFind()
        }
      }
    })

    this.findCountEl = document.createElement('span')
    this.findCountEl.className = 'datanoa-page-info'
    this.findCountEl.style.display = 'none'
    this.findCountEl.textContent = '0 / 0'

    this.findPrevBtn = document.createElement('button')
    this.findPrevBtn.type = 'button'
    this.findPrevBtn.className = 'datanoa-btn datanoa-btn-sm'
    this.findPrevBtn.textContent = '▲'
    this.findPrevBtn.title = 'Previous match (Shift+Enter)'
    this.findPrevBtn.style.display = 'none'
    this.findPrevBtn.addEventListener('click', () => {
      const state = this.dataGrid?.findNext(-1)
      this.updateFindCounter(state)
    })

    this.findNextBtn = document.createElement('button')
    this.findNextBtn.type = 'button'
    this.findNextBtn.className = 'datanoa-btn datanoa-btn-sm'
    this.findNextBtn.textContent = '▼'
    this.findNextBtn.title = 'Next match (Enter)'
    this.findNextBtn.style.display = 'none'
    this.findNextBtn.addEventListener('click', () => {
      const state = this.dataGrid?.findNext(1)
      this.updateFindCounter(state)
    })

    findNavWrap.appendChild(this.searchModeBtn)
    findNavWrap.appendChild(this.clientSearchEl)
    findNavWrap.appendChild(this.findCountEl)
    findNavWrap.appendChild(this.findPrevBtn)
    findNavWrap.appendChild(this.findNextBtn)

    this.gridToolbarEl.appendChild(whereGroup)
    this.gridToolbarEl.appendChild(orderGroup)
    this.gridToolbarEl.appendChild(this.filterBtn)
    this.gridToolbarEl.appendChild(this.clearFilterBtn)
    this.gridToolbarEl.appendChild(findNavWrap)

    // Inline DML Preview Drawer
    this.dmlPreviewEl = document.createElement('div')
    this.dmlPreviewEl.className = 'datanoa-dml-preview'
    this.dmlPreviewEl.style.display = 'none'

    const dmlHead = document.createElement('div')
    dmlHead.className = 'datanoa-drawer-head'
    const dmlHeadTitle = document.createElement('span')
    dmlHeadTitle.textContent = 'Pending DML Preview'
    const dmlHeadBtns = document.createElement('div')
    dmlHeadBtns.className = 'datanoa-btn-group'
    this.dmlApplyBtn = document.createElement('button')
    this.dmlApplyBtn.type = 'button'
    this.dmlApplyBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-btn-primary'
    this.dmlApplyBtn.textContent = 'Apply'
    this.dmlApplyBtn.addEventListener('click', () => {
      void this.submitStagedChanges()
    })
    const dmlCloseBtn = document.createElement('button')
    dmlCloseBtn.type = 'button'
    dmlCloseBtn.className = 'datanoa-btn datanoa-btn-sm'
    dmlCloseBtn.textContent = 'Close'
    dmlCloseBtn.addEventListener('click', () => {
      if (this.dmlPreviewEl) this.dmlPreviewEl.style.display = 'none'
      this.dataGrid?.handleViewportResize()
    })
    dmlHeadBtns.appendChild(this.dmlApplyBtn)
    dmlHeadBtns.appendChild(dmlCloseBtn)
    dmlHead.appendChild(dmlHeadTitle)
    dmlHead.appendChild(dmlHeadBtns)

    this.dmlPreviewPreEl = document.createElement('pre')
    this.dmlPreviewPreEl.className = 'datanoa-dml-pre'
    this.dmlPreviewEl.appendChild(dmlHead)
    this.dmlPreviewEl.appendChild(this.dmlPreviewPreEl)

    // Query Execution Status / Error Feedback Banner
    this.queryBannerEl = document.createElement('div')
    this.queryBannerEl.className = 'datanoa-query-banner'
    this.queryBannerEl.style.display = 'none'

    const bannerBody = document.createElement('div')
    bannerBody.className = 'datanoa-query-banner-body'
    this.queryBannerTitleEl = document.createElement('span')
    this.queryBannerTitleEl.className = 'datanoa-query-banner-title'
    this.queryBannerDetailEl = document.createElement('div')
    this.queryBannerDetailEl.className = 'datanoa-query-banner-detail'
    bannerBody.appendChild(this.queryBannerTitleEl)
    bannerBody.appendChild(this.queryBannerDetailEl)

    const bannerActions = document.createElement('div')
    bannerActions.className = 'datanoa-query-banner-actions'

    this.queryBannerRetryBtn = document.createElement('button')
    this.queryBannerRetryBtn.type = 'button'
    this.queryBannerRetryBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-error-retry-btn'
    this.queryBannerRetryBtn.textContent = 'Retry'
    this.queryBannerRetryBtn.style.display = 'none'
    this.queryBannerRetryBtn.addEventListener('click', () => {
      const fn = this.queryBannerRetryHandler
      if (fn) fn()
    })

    this.queryBannerBackBtn = document.createElement('button')
    this.queryBannerBackBtn.type = 'button'
    this.queryBannerBackBtn.className = 'datanoa-btn datanoa-btn-sm'
    this.queryBannerBackBtn.textContent = 'Back to Table'
    this.queryBannerBackBtn.style.display = 'none'
    this.queryBannerBackBtn.addEventListener('click', () => {
      if (this.activeConnectionId && this.activeTable) {
        void this.loadTableData(this.activeConnectionId, this.activeTable, 1)
      }
    })

    this.queryBannerCopyBtn = document.createElement('button')
    this.queryBannerCopyBtn.type = 'button'
    this.queryBannerCopyBtn.className = 'datanoa-btn datanoa-btn-sm'
    this.queryBannerCopyBtn.textContent = 'Copy Error'
    this.queryBannerCopyBtn.style.display = 'none'
    this.queryBannerCopyBtn.addEventListener('click', () => {
      if (!this.lastQueryErrorText) return
      copyTextFallback(this.lastQueryErrorText, this.queryBannerCopyBtn)
      this.updateStatus('Copied query error to clipboard')
    })

    const bannerCloseBtn = document.createElement('button')
    bannerCloseBtn.type = 'button'
    bannerCloseBtn.className = 'datanoa-btn datanoa-btn-sm'
    bannerCloseBtn.textContent = 'Dismiss'
    bannerCloseBtn.addEventListener('click', () => {
      this.hideQueryBanner()
    })

    bannerActions.appendChild(this.queryBannerRetryBtn)
    bannerActions.appendChild(this.queryBannerBackBtn)
    bannerActions.appendChild(this.queryBannerCopyBtn)
    bannerActions.appendChild(bannerCloseBtn)
    this.queryBannerEl.appendChild(bannerBody)
    this.queryBannerEl.appendChild(bannerActions)

    // Grid Area
    this.gridAreaEl = document.createElement('div')
    this.gridAreaEl.className = 'datanoa-grid-area'

    // Collapsible Bottom Cell Value / JSON Inspector Drawer
    this.valueInspectorEl = document.createElement('div')
    this.valueInspectorEl.className = 'datanoa-value-inspector'
    this.valueInspectorEl.style.display = 'none'

    const valHead = document.createElement('div')
    valHead.className = 'datanoa-drawer-head'
    const valTitleWrap = document.createElement('div')
    valTitleWrap.style.display = 'inline-flex'
    valTitleWrap.style.alignItems = 'center'
    valTitleWrap.style.gap = '6px'
    this.valueInspectorTitleEl = document.createElement('span')
    this.valueInspectorTitleEl.textContent = 'Value Inspector'
    this.valueNullBadgeEl = document.createElement('span')
    this.valueNullBadgeEl.className = 'datanoa-null-badge'
    this.valueNullBadgeEl.textContent = 'NULL'
    this.valueNullBadgeEl.style.display = 'none'
    valTitleWrap.appendChild(this.valueInspectorTitleEl)
    valTitleWrap.appendChild(this.valueNullBadgeEl)

    const valActions = document.createElement('div')
    valActions.className = 'datanoa-btn-group'

    const valPrettyBtn = document.createElement('button')
    valPrettyBtn.type = 'button'
    valPrettyBtn.className = 'datanoa-btn datanoa-btn-sm'
    valPrettyBtn.textContent = 'Format JSON'
    valPrettyBtn.addEventListener('click', () => {
      if (!this.valueInspectorTextEl) return
      try {
        const parsed: unknown = JSON.parse(this.valueInspectorTextEl.value)
        this.valueInspectorTextEl.value = JSON.stringify(parsed, null, 2)
        this.updateValueInspectorMeta(false)
      } catch {
        this.updateStatus('Value is not valid JSON')
      }
    })

    const valMinifyBtn = document.createElement('button')
    valMinifyBtn.type = 'button'
    valMinifyBtn.className = 'datanoa-btn datanoa-btn-sm'
    valMinifyBtn.textContent = 'Minify JSON'
    valMinifyBtn.addEventListener('click', () => {
      if (!this.valueInspectorTextEl) return
      try {
        const parsed: unknown = JSON.parse(this.valueInspectorTextEl.value)
        this.valueInspectorTextEl.value = JSON.stringify(parsed)
        this.updateValueInspectorMeta(false)
      } catch {
        this.updateStatus('Value is not valid JSON')
      }
    })

    this.valueNullBtn = document.createElement('button')
    this.valueNullBtn.type = 'button'
    this.valueNullBtn.className = 'datanoa-btn datanoa-btn-sm'
    this.valueNullBtn.textContent = 'Set NULL'
    this.valueNullBtn.addEventListener('click', () => {
      void this.applyValueFromInspector(true)
    })

    this.valueApplyBtn = document.createElement('button')
    this.valueApplyBtn.type = 'button'
    this.valueApplyBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-btn-primary'
    this.valueApplyBtn.textContent = 'Apply'
    this.valueApplyBtn.title = 'Apply edit (Ctrl+Enter)'
    this.valueApplyBtn.addEventListener('click', () => {
      void this.applyValueFromInspector(false)
    })

    const valCopyBtn = document.createElement('button')
    valCopyBtn.type = 'button'
    valCopyBtn.className = 'datanoa-btn datanoa-btn-sm'
    valCopyBtn.textContent = 'Copy'
    valCopyBtn.addEventListener('click', () => {
      if (!this.valueInspectorTextEl) return
      copyTextFallback(this.valueInspectorTextEl.value, valCopyBtn)
      this.updateStatus('Copied cell value to clipboard')
    })

    const valCloseBtn = document.createElement('button')
    valCloseBtn.type = 'button'
    valCloseBtn.className = 'datanoa-btn datanoa-btn-sm'
    valCloseBtn.textContent = 'Close'
    valCloseBtn.addEventListener('click', () => {
      this.closeValueInspector()
    })

    valActions.appendChild(valPrettyBtn)
    valActions.appendChild(valMinifyBtn)
    valActions.appendChild(this.valueNullBtn)
    valActions.appendChild(this.valueApplyBtn)
    valActions.appendChild(valCopyBtn)
    valActions.appendChild(valCloseBtn)
    valHead.appendChild(valTitleWrap)
    valHead.appendChild(valActions)

    const valBody = document.createElement('div')
    valBody.className = 'datanoa-value-inspector-body'
    this.valueInspectorTextEl = document.createElement('textarea')
    this.valueInspectorTextEl.className = 'datanoa-value-textarea'
    this.valueInspectorTextEl.spellcheck = false
    this.valueInspectorTextEl.addEventListener('input', () => {
      this.updateValueInspectorMeta(false)
    })
    this.valueInspectorTextEl.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault()
        void this.applyValueFromInspector(false)
      }
    })
    this.valueInspectorStatusEl = document.createElement('div')
    this.valueInspectorStatusEl.className = 'datanoa-json-status'
    valBody.appendChild(this.valueInspectorTextEl)
    valBody.appendChild(this.valueInspectorStatusEl)

    this.valueInspectorEl.appendChild(valHead)
    this.valueInspectorEl.appendChild(valBody)

    // Schema Inspector Area (hidden by default)
    this.inspectorAreaEl = document.createElement('div')
    this.inspectorAreaEl.className = 'datanoa-inspector-view'
    this.inspectorAreaEl.style.display = 'none'

    mainView.appendChild(this.tableTopbarEl)
    if (this.sqlToolbarEl) {
      mainView.appendChild(this.sqlToolbarEl)
    }
    mainView.appendChild(this.sqlAreaEl)
    mainView.appendChild(this.splitResizerEl)
    mainView.appendChild(this.historyDrawerEl)
    mainView.appendChild(this.gridSubbarEl)
    mainView.appendChild(this.gridToolbarEl)
    mainView.appendChild(this.dmlPreviewEl)
    mainView.appendChild(this.queryBannerEl)
    mainView.appendChild(this.gridAreaEl)
    mainView.appendChild(this.valueInspectorEl)
    mainView.appendChild(this.inspectorAreaEl)

    workspaceBody.appendChild(this.sidebarEl)
    workspaceBody.appendChild(mainView)

    // 3. Status Bar
    const statusBar = document.createElement('div')
    statusBar.className = 'datanoa-status-bar'

    this.statusStateEl = document.createElement('span')
    this.statusStateEl.className = 'datanoa-status-state'
    this.statusStateEl.textContent = 'Ready'

    this.statusSelectionEl = document.createElement('button')
    this.statusSelectionEl.type = 'button'
    this.statusSelectionEl.className = 'datanoa-status-selection'
    this.statusSelectionEl.style.display = 'none'
    this.statusSelectionEl.title = 'Click to copy selection statistics to clipboard'
    this.statusSelectionEl.addEventListener('click', () => {
      const text = this.statusSelectionEl?.textContent || ''
      if (text) {
        copyTextFallback(text)
        this.updateStatus('Copied selection statistics to clipboard')
      }
    })

    this.shortcutHintEl = document.createElement('span')
    this.shortcutHintEl.className = 'datanoa-shortcut-hint'
    this.shortcutHintEl.textContent =
      'Ctrl + Scroll ↔ Pan · Ctrl+K Switcher · Ctrl+F Find · Shift+Alt+F Format · Ctrl+S Submit'

    this.statusMetricsEl = document.createElement('span')
    this.statusMetricsEl.className = 'datanoa-status-metrics'
    this.statusMetricsEl.textContent = '0 rows'

    this.shortcutsBtn = document.createElement('button')
    this.shortcutsBtn.type = 'button'
    this.shortcutsBtn.className = 'datanoa-btn datanoa-btn-sm'
    this.shortcutsBtn.textContent = '?'
    this.shortcutsBtn.title = 'Keyboard Shortcuts (Ctrl+/)'
    this.shortcutsBtn.setAttribute('aria-label', 'Keyboard Shortcuts')
    this.shortcutsBtn.addEventListener('click', () => {
      this.openShortcutsModal()
    })

    statusBar.appendChild(this.statusStateEl)
    statusBar.appendChild(this.statusSelectionEl)
    statusBar.appendChild(this.shortcutHintEl)
    statusBar.appendChild(this.statusMetricsEl)
    statusBar.appendChild(this.shortcutsBtn)

    // Assemble Root
    this.rootEl.appendChild(toolbar)
    this.rootEl.appendChild(this.cautionStripEl)
    this.rootEl.appendChild(workspaceBody)
    this.rootEl.appendChild(statusBar)

    document.body.appendChild(this.rootEl)

    // Mount CodeMirror SQL Console
    this.sqlConsole = new SqlConsoleController({
      parent: this.sqlAreaEl,
      initialDoc: '-- Datanoa SQL Console\nSELECT 1;\n',
      dialect: 'sqlite',
      schema: this.schemaMap,
      onExecute: () => {
        void this.executeSql(false)
      },
      onExecuteAll: () => {
        void this.executeSql(true)
      },
      onFormatSql: () => {
        this.formatSqlInConsole()
      },
      onChange: (doc) => {
        if (!this.suppressDocSync) {
          this.documentSession?.change?.(this.composeSerializedDocument(doc))
          this.saveStudioViewState(false)
        }
      },
    })

    // Mount Virtualized Data Grid
    this.dataGrid = new VirtualDataGrid({
      container: this.gridAreaEl,
      batchMode: true,
      onSort: (col, dir) => {
        void this.handleGridSort(col, dir)
      },
      onUpdateCell: (params) => {
        return this.handleUpdateCell(params)
      },
      onSelectCell: (info) => {
        this.handleCellSelectionChanged(info)
      },
      onSelectionChange: (summary) => {
        this.handleGridSelectionSummary(summary)
      },
      onInspectCell: (info) => {
        this.openValueInspector(info)
      },
      onQuickFilter: (predicateSql, mode) => {
        void this.handleQuickFilter(predicateSql, mode)
      },
      onNavigateForeignKey: (refTable, refColumn, value) => {
        void this.handleNavigateForeignKey(refTable, refColumn, value)
      },
      onColumnConfigChange: (config) => {
        this.handleColumnConfigChanged(config)
      },
      onFindStateChange: (state) => {
        this.updateFindCounter(state)
      },
      onStageChange: (count) => {
        this.updateStagedActionButtons(count)
      },
      onNotify: (msg) => {
        this.updateStatus(msg)
      },
    })

    // Mount Schema Inspector
    this.schemaInspector = new SchemaInspectorView(this.inspectorAreaEl, {
      dialect: 'sqlite',
      onInsertDdl: (ddl) => {
        this.sqlConsole?.insertText(ddl)
        if (this.activeViewMode === 'grid' || this.activeViewMode === 'inspector') {
          this.switchMode('split')
        }
        this.updateStatus('Inserted DDL into SQL Console')
      },
      onCopyDdl: () => {
        this.updateStatus('Copied DDL to clipboard')
      },
      onApplyMigration: (statements, draft) => {
        return this.handleApplyMigration(statements, draft)
      },
      onTruncateTable: () => {
        const activeObj = this.findActiveSchemaObject()
        if (activeObj && activeObj.kind === 'table') {
          this.openDangerTableModal('truncate', activeObj)
        }
      },
      onDropTable: () => {
        const activeObj = this.findActiveSchemaObject()
        if (activeObj) {
          this.openDangerTableModal('drop', activeObj)
        }
      },
    })
  }

  private composeSerializedDocument(visibleSql: string): string {
    if (this.preservedMetadataLines.length === 0) {
      return visibleSql
    }
    return `${this.preservedMetadataLines.join('\n')}\n${visibleSql}`
  }

  private updateMetadataHeader(key: 'connectionId' | 'table' | 'schema', value: string): void {
    const prefix = `-- datanoa: ${key}=`
    const idx = this.preservedMetadataLines.findIndex((l) =>
      l.toLowerCase().startsWith(prefix.toLowerCase())
    )
    const nextLine = `${prefix}${value}`
    if (idx >= 0) {
      this.preservedMetadataLines[idx] = nextLine
    } else {
      this.preservedMetadataLines.push(nextLine)
    }
    if (!this.suppressDocSync && this.sqlConsole) {
      this.documentSession?.change?.(this.composeSerializedDocument(this.sqlConsole.getText()))
    }
  }

  private startSplitResize(e: MouseEvent): void {
    if (!this.sqlAreaEl || !this.mainViewEl || !this.splitResizerEl || typeof window === 'undefined') {
      return
    }
    e.preventDefault()

    if (this.splitResizeListeners) {
      window.removeEventListener('mousemove', this.splitResizeListeners.move)
      window.removeEventListener('mouseup', this.splitResizeListeners.up)
      window.removeEventListener('blur', this.splitResizeListeners.blur)
      this.splitResizeListeners = null
    }

    const startY = e.clientY
    const startHeight = this.sqlAreaEl.getBoundingClientRect().height

    this.splitResizerEl.classList.add('resizing')
    if (typeof document !== 'undefined' && document.body) {
      document.body.style.cursor = 'row-resize'
      document.body.style.userSelect = 'none'
    }

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!this.sqlAreaEl) return
      const nextPx = this.getClampedSqlPanePx(startHeight + (moveEvent.clientY - startY))
      this.customSqlPanePx = nextPx
      this.sqlAreaEl.style.flex = `0 0 ${nextPx}px`
      if (typeof requestAnimationFrame === 'function') {
        if (this.splitResizeRafId === null) {
          this.splitResizeRafId = requestAnimationFrame(() => {
            this.splitResizeRafId = null
            this.dataGrid?.handleViewportResize()
          })
        }
      } else {
        this.dataGrid?.handleViewportResize()
      }
    }

    const finishSplitResize = () => {
      if (this.splitResizeRafId !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(this.splitResizeRafId)
        this.splitResizeRafId = null
      }
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', finishSplitResize)
      window.removeEventListener('blur', finishSplitResize)
      this.splitResizeListeners = null
      this.splitResizerEl?.classList.remove('resizing')
      if (typeof document !== 'undefined' && document.body) {
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
      this.dataGrid?.handleViewportResize()
      this.saveStudioViewState(true)
    }

    this.splitResizeListeners = {
      move: onMouseMove,
      up: finishSplitResize,
      blur: finishSplitResize,
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', finishSplitResize)
    window.addEventListener('blur', finishSplitResize)
  }

  private switchMode(mode: 'split' | 'grid' | 'sql' | 'inspector'): void {
    if (this.activeViewMode === 'inspector' && mode !== 'inspector') {
      if (this.schemaInspector?.isMigrationInFlight()) {
        this.updateStatus('Wait for schema migration to finish before switching views')
        return
      }
      this.schemaInspector?.closeConfirmModalIfIdle()
    }

    this.activeViewMode = mode
    if (this.tabButtons) {
      this.tabButtons.split.classList.toggle('active', mode === 'split')
      this.tabButtons.grid.classList.toggle('active', mode === 'grid')
      this.tabButtons.sql.classList.toggle('active', mode === 'sql')
      this.tabButtons.inspector.classList.toggle('active', mode === 'inspector')
    }

    if (!this.sqlAreaEl || !this.gridAreaEl || !this.inspectorAreaEl) return

    const showSqlChrome = mode === 'split' || mode === 'sql'
    const showGridChrome = mode !== 'inspector'
    if (this.sqlToolbarEl) {
      this.sqlToolbarEl.style.display = showSqlChrome ? 'flex' : 'none'
    }
    if (!showSqlChrome && this.historyDrawerEl) {
      this.historyDrawerEl.style.display = 'none'
      this.isHistoryOpen = false
      this.historyBtn?.classList.remove('active')
    }
    if (this.gridSubbarEl) {
      this.gridSubbarEl.style.display = showGridChrome ? 'flex' : 'none'
    }
    if (this.gridToolbarEl) {
      this.gridToolbarEl.style.display = showGridChrome ? 'flex' : 'none'
    }
    if (this.splitResizerEl) {
      this.splitResizerEl.style.display = mode === 'split' || mode === 'sql' ? 'block' : 'none'
    }

    if (mode === 'split') {
      this.sqlAreaEl.style.display = 'block'
      this.sqlAreaEl.style.flex =
        this.customSqlPanePx !== null
          ? `0 0 ${this.getClampedSqlPanePx(this.customSqlPanePx)}px`
          : '0 0 34%'
      this.gridAreaEl.style.display = 'block'
      this.inspectorAreaEl.style.display = 'none'
    } else if (mode === 'grid') {
      this.sqlAreaEl.style.display = 'none'
      this.gridAreaEl.style.display = 'block'
      this.inspectorAreaEl.style.display = 'none'
    } else if (mode === 'sql') {
      this.sqlAreaEl.style.display = 'block'
      this.sqlAreaEl.style.flex = '0 0 55%'
      this.gridAreaEl.style.display = 'block'
      this.inspectorAreaEl.style.display = 'none'
    } else {
      this.sqlAreaEl.style.display = 'none'
      this.gridAreaEl.style.display = 'none'
      this.closeValueInspector()
      if (this.dmlPreviewEl) this.dmlPreviewEl.style.display = 'none'
      this.inspectorAreaEl.style.display = 'flex'
      const targetKey = `${this.activeConnectionId || ''}:${this.activeSchema || ''}:${this.activeTable || ''}`
      if (this.lastInspectorLoadedKey !== targetKey) {
        void this.loadActiveTableSchema()
      }
    }

    if (showGridChrome) {
      this.dataGrid?.handleViewportResize()
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => {
          if (this.activeViewMode !== 'inspector') {
            this.dataGrid?.handleViewportResize()
          }
        })
      }
    }
    this.saveStudioViewState(true)
  }

  public setSidebarCollapsed(collapsed: boolean, persist = true): void {
    this.sidebarCollapsed = Boolean(collapsed)
    this.closeTopbarPopover()
    this.sidebarEl?.classList.toggle('collapsed', this.sidebarCollapsed)
    this.tableTopbarEl?.classList.toggle('visible', this.sidebarCollapsed)
    this.sidebarToggleBtn?.classList.toggle('active', this.sidebarCollapsed)
    if (this.sidebarToggleBtn) {
      this.sidebarToggleBtn.title = this.sidebarCollapsed
        ? 'Horizontal Top Table Bar Active — Click to switch back to Left Sidebar'
        : 'Left Sidebar Active — Click to collapse Sidebar & show Horizontal Top Table Bar'
    }
    if (this.sidebarCollapsed) {
      this.scrollActiveTopbarPillIntoView()
    }
    if (persist) {
      this.saveStudioViewState()
    }
  }

  private closeTopbarPopover(): void {
    if (this.topbarPopoverOutsideCleanup) {
      this.topbarPopoverOutsideCleanup()
      this.topbarPopoverOutsideCleanup = null
    }
    if (this.topbarPopoverEl) {
      this.topbarPopoverEl.remove()
      this.topbarPopoverEl = null
    }
  }

  private isObjectActive(name: string | undefined, schema: string | undefined): boolean {
    if (!this.activeTable || name !== this.activeTable) return false
    const curSchema = this.activeSchema || ''
    const itemSchema = schema || ''
    if (curSchema || itemSchema) {
      return curSchema === itemSchema
    }
    return true
  }

  private toggleTopbarAllTablesPopover(): void {
    if (this.topbarPopoverEl) {
      this.closeTopbarPopover()
      return
    }
    if (!this.topbarAllBtn || typeof document === 'undefined' || !document.body) return

    const filtered = this.schemaObjects.filter(
      (o) => !this.filterQuery || o.name.toLowerCase().includes(this.filterQuery)
    )
    const pop = document.createElement('div')
    pop.className = 'datanoa-topbar-popover'

    if (filtered.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'datanoa-cell-null'
      empty.style.padding = '8px 10px'
      empty.textContent = 'No matching tables or views'
      pop.appendChild(empty)
    } else {
      for (const item of filtered) {
        const btn = document.createElement('button')
        btn.type = 'button'
        const isActive = this.isObjectActive(item.name, item.schema)
        btn.className = `datanoa-context-item${isActive ? ' active' : ''}`
        if (isActive) {
          btn.style.color = 'var(--info)'
          btn.style.fontWeight = '600'
        }
        const nameSpan = document.createElement('span')
        nameSpan.textContent = item.schema ? `${item.schema}.${item.name}` : item.name
        const kindSpan = document.createElement('span')
        kindSpan.style.fontSize = '10px'
        kindSpan.style.color = 'var(--muted)'
        kindSpan.textContent = item.kind === 'view' ? 'VIEW' : 'TBL'
        btn.appendChild(nameSpan)
        btn.appendChild(kindSpan)
        btn.addEventListener('click', () => {
          this.closeTopbarPopover()
          this.selectSidebarObject(item)
        })
        pop.appendChild(btn)
      }
    }

    document.body.appendChild(pop)
    this.topbarPopoverEl = pop

    if (typeof this.topbarAllBtn.getBoundingClientRect === 'function') {
      const rect = this.topbarAllBtn.getBoundingClientRect()
      const vw = typeof window !== 'undefined' ? window.innerWidth || 1024 : 1024
      const left = Math.max(8, Math.min(Math.round(rect.right - 250), vw - 258))
      pop.style.top = `${Math.round(rect.bottom + 4)}px`
      pop.style.left = `${left}px`
    }

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      const onDocDown = (ev: MouseEvent) => {
        const target = ev.target as Node | null
        if (target && (this.topbarAllBtn?.contains?.(target) || pop.contains?.(target))) return
        this.closeTopbarPopover()
      }
      window.addEventListener('mousedown', onDocDown, true)
      this.topbarPopoverOutsideCleanup = () => {
        window.removeEventListener('mousedown', onDocDown, true)
      }
    }
  }

  private scrollActiveTopbarPillIntoView(): void {
    if (!this.topbarTrackEl) return
    const activePill = this.topbarTrackEl.querySelector?.('.datanoa-topbar-pill.active') as
      | HTMLElement
      | null
    activePill?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }

  private updateSelectedTableHighlight(): void {
    if (this.sidebarListEl) {
      const items = this.sidebarListEl.querySelectorAll('.datanoa-sidebar-item')
      items.forEach((el) => {
        const htmlEl = el as HTMLElement
        const tbl = htmlEl.dataset?.tableName
        const sch = htmlEl.dataset?.tableSchema
        el.classList.toggle('active', this.isObjectActive(tbl, sch))
      })
    }
    if (this.topbarTrackEl) {
      const pills = this.topbarTrackEl.querySelectorAll('.datanoa-topbar-pill')
      pills.forEach((el) => {
        const htmlEl = el as HTMLElement
        const tbl = htmlEl.dataset?.tableName
        const sch = htmlEl.dataset?.tableSchema
        el.classList.toggle('active', this.isObjectActive(tbl, sch))
      })
      if (this.sidebarCollapsed) {
        this.scrollActiveTopbarPillIntoView()
      }
    }
  }

  public applyDocumentMetadata(docText: string): void {
    const parsed = parseDatanoaDocument(docText)
    this.preservedMetadataLines = parsed.metadataLines

    this.suppressDocSync = true
    try {
      this.sqlConsole?.setText(parsed.cleanSql)
    } finally {
      this.suppressDocSync = false
    }

    const targetConnectionId = parsed.connectionId || this.activeConnectionId
    const isAlreadyLoadedSameConnection =
      Boolean(targetConnectionId) &&
      this.connections.length > 0 &&
      this.activeConnectionId === targetConnectionId &&
      this.hasLoadedActiveConnection

    if (isAlreadyLoadedSameConnection && targetConnectionId) {
      if (
        parsed.table &&
        (parsed.table !== this.activeTable ||
          (parsed.schema || '') !== (this.activeSchema || ''))
      ) {
        this.pendingDocConnectionId = null
        this.pendingDocTable = null
        this.pendingDocSchema = undefined
        this.activeTable = parsed.table
        this.activeSchema =
          parsed.schema ||
          this.schemaObjects.find((o) => o.name === parsed.table)?.schema ||
          undefined
        this.activeWhereClause = undefined
        this.activeOrderByClause = undefined
        this.restoredPageOnBoot = 1
        this.currentPage = 1
        if (this.whereInputEl) this.whereInputEl.value = ''
        if (this.orderByInputEl) this.orderByInputEl.value = ''
        this.dataGrid?.clearSortIndicator()
        this.dataGrid?.clearClientColumnFilters()
        this.lastInspectorLoadedKey = ''
        this.renderSidebarObjects()
        void this.loadTableData(targetConnectionId, this.activeTable, 1)
        if (this.activeViewMode === 'inspector') {
          void this.loadActiveTableSchema()
        }
      }
      return
    }

    // If document metadata specifies a different connection/table/schema than the local view-state
    // restored on boot, reset restored WHERE/ORDER BY/page so Table A's filters never leak onto Table B.
    const prevConnId = this.pendingDocConnectionId || this.activeConnectionId
    const prevTable = this.pendingDocTable || this.activeTable
    const prevSchema = this.pendingDocSchema ?? this.activeSchema
    const connDiffers = Boolean(
      parsed.connectionId && prevConnId && parsed.connectionId !== prevConnId
    )
    const tableDiffers = Boolean(parsed.table && prevTable && parsed.table !== prevTable)
    const schemaDiffers = Boolean(
      parsed.schema !== undefined &&
        prevSchema !== undefined &&
        (parsed.schema || '') !== (prevSchema || '')
    )
    if (connDiffers || tableDiffers || schemaDiffers || Boolean(parsed.table && !prevTable)) {
      this.activeWhereClause = undefined
      this.activeOrderByClause = undefined
      this.restoredPageOnBoot = 1
      this.currentPage = 1
      if (this.whereInputEl) this.whereInputEl.value = ''
      if (this.orderByInputEl) this.orderByInputEl.value = ''
      this.dataGrid?.clearSortIndicator()
      this.dataGrid?.clearClientColumnFilters()
      if (parsed.table && !parsed.schema) {
        this.pendingDocSchema = undefined
        this.activeSchema = undefined
      }
    }

    if (parsed.connectionId) {
      this.pendingDocConnectionId = parsed.connectionId
    }
    if (parsed.table) {
      this.pendingDocTable = parsed.table
      this.activeTable = parsed.table
    }
    if (parsed.schema) {
      this.pendingDocSchema = parsed.schema
      this.activeSchema = parsed.schema
    }

    if (this.connections.length > 0 && targetConnectionId) {
      const conn = this.connections.find((c) => c.id === targetConnectionId)
      if (conn) {
        this.handleConnectionChanged(conn.id, true)
      }
    }
  }

  public attachDocumentSession(session: DocumentSessionLike): void {
    this.replaceSub?.dispose()
    this.replaceSub = null
    this.documentSession = session
    if (typeof session.value === 'string' && session.value.length > 0) {
      this.applyDocumentMetadata(session.value)
    }
    if (typeof session.onReplace === 'function') {
      const sub = session.onReplace((next) => {
        if (typeof next === 'string') {
          this.applyDocumentMetadata(next)
        }
      })
      if (sub && typeof sub.dispose === 'function') {
        this.replaceSub = sub
      }
    }
  }

  private bindEvents(): void {
    const track = (sub: unknown) => {
      if (sub && typeof (sub as { dispose?: unknown }).dispose === 'function') {
        this.disposables.push(sub as { dispose(): void })
      }
    }

    if (this.inspectorAreaEl && typeof this.inspectorAreaEl.addEventListener === 'function') {
      const inspectorEl = this.inspectorAreaEl
      const onInspectorWheel = (e: WheelEvent) => {
        if (!e.ctrlKey && !e.metaKey) return
        const raw = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX
        if (!raw) return
        const step =
          e.deltaMode === 1 ? raw * 28 : e.deltaMode === 2 ? raw * 320 : raw * 1.25
        let scrollTarget: HTMLElement = inspectorEl
        if (e.target instanceof Element) {
          let cur: Element | null = e.target
          while (cur && cur !== inspectorEl) {
            if (cur instanceof HTMLElement && cur.scrollWidth > cur.clientWidth + 1) {
              scrollTarget = cur
              break
            }
            cur = cur.parentElement
          }
        }
        scrollTarget.scrollLeft += step
        e.preventDefault()
      }
      inspectorEl.addEventListener('wheel', onInspectorWheel, { passive: false })
      track({
        dispose: () => {
          inspectorEl.removeEventListener('wheel', onInspectorWheel)
        },
      })
    }

    if (typeof window !== 'undefined') {
      const onWindowMouseDown = (e: MouseEvent) => {
        if (
          this.sidebarContextMenuEl &&
          e.target instanceof Node &&
          !this.sidebarContextMenuEl.contains(e.target)
        ) {
          this.closeSidebarContextMenu()
          this.closeTopbarPopover()
        }
      }
      const onWindowKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          this.closeSidebarContextMenu()
          this.closeTopbarPopover()
          this.closeColumnsPopover()
          return
        }
        if (e.defaultPrevented) return
        const hasOpenModal = Boolean(
          this.activeModalBackdrop || this.schemaInspector?.isConfirmModalOpen()
        )
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
          const lowerKey = e.key.toLowerCase()
          if (lowerKey === 'k' || lowerKey === 'p') {
            if (hasOpenModal) return
            e.preventDefault()
            this.openCommandPalette()
            return
          }
          if (lowerKey === 'f') {
            if (hasOpenModal) return
            const targetInClientSearch = e.target === this.clientSearchEl
            if (!targetInClientSearch && isEditableShortcutTarget(e.target)) return
            if (this.clientSearchEl && this.activeViewMode !== 'inspector') {
              e.preventDefault()
              this.setGridSearchMode('find')
              this.clientSearchEl.focus()
              this.clientSearchEl.select?.()
            }
            return
          }
          if (e.key === '/' || e.key === '?') {
            if (hasOpenModal || isEditableShortcutTarget(e.target)) return
            e.preventDefault()
            this.openShortcutsModal()
            return
          }
          if (lowerKey === 's') {
            if (hasOpenModal) return
            if (
              this.activeViewMode === 'inspector' &&
              this.schemaInspector &&
              this.schemaInspector.getStagedChangeCount() > 0 &&
              !this.isActiveConnectionReadOnly()
            ) {
              e.preventDefault()
              void this.schemaInspector.applyStagedChanges()
              return
            }
            if (
              this.dataGrid &&
              this.dataGrid.getStagedCount() > 0 &&
              !this.isActiveConnectionReadOnly() &&
              !this.isShowingSqlResult &&
              this.currentCanEdit
            ) {
              e.preventDefault()
              void this.submitStagedChanges()
            }
          }
        } else if (e.shiftKey && e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'f') {
          if (hasOpenModal) return
          e.preventDefault()
          this.formatSqlInConsole()
        }
      }
      const onWindowResize = () => {
        this.applyClampedSplitPaneHeight()
        if (this.activeViewMode !== 'inspector') {
          this.dataGrid?.handleViewportResize()
        }
      }
      const onWindowPageHide = () => {
        this.flushStudioViewState()
        this.destroy()
      }
      window.addEventListener('mousedown', onWindowMouseDown)
      window.addEventListener('keydown', onWindowKeyDown)
      window.addEventListener('resize', onWindowResize)
      window.addEventListener('pagehide', onWindowPageHide)
      track({
        dispose: () => {
          window.removeEventListener('mousedown', onWindowMouseDown)
          window.removeEventListener('keydown', onWindowKeyDown)
          window.removeEventListener('resize', onWindowResize)
          window.removeEventListener('pagehide', onWindowPageHide)
        },
      })
    }

    if (typeof window === 'undefined' || !window.orca) return

    try {
      track(
        window.orca.on('theme', (payload) => {
          if (payload && payload.colorScheme) {
            document.documentElement.classList.toggle('light', payload.colorScheme === 'light')
            document.documentElement.classList.toggle('dark', payload.colorScheme === 'dark')
          }
        })
      )
    } catch {
      // Ignore if test mock omits theme event
    }

    try {
      const orcaAnyEvent = window.orca as unknown as {
        on?: (event: string, handler: (payload: EditorTypography) => void) => { dispose(): void } | void
      }
      track(
        orcaAnyEvent.on?.('editor.typography.changed', (payload) => {
          this.applyHostTypography(payload)
        })
      )
    } catch {
      // Optional in older Orca builds or test mocks
    }

    try {
      if (window.orca.host?.has?.('editor.readTypography')) {
        void window.orca.host
          .call('editor.readTypography')
          .then((typography) => {
            this.applyHostTypography(typography)
          })
          .catch(() => {})
      }
    } catch {
      // Ignore typography query errors
    }

    try {
      track(
        window.orca.plugin.on('connections.changed', () => {
          void this.refreshConnections()
        })
      )
      track(
        window.orca.plugin.on('data.cellUpdated', (payload) => {
          const sameConn =
            !payload.connectionId || payload.connectionId === this.activeConnectionId
          const sameTable =
            !payload.table ||
            (this.activeTable !== null &&
              payload.table.toLowerCase() === this.activeTable.toLowerCase())
          const sameSchema =
            payload.schema === undefined ||
            !this.activeSchema ||
            (payload.schema || '').toLowerCase() === this.activeSchema.toLowerCase()
          if (sameConn && sameTable && sameSchema && !this.isShowingSqlResult) {
            this.dataGrid?.handleCellUpdated(payload)
            this.updateStatus('Cell updated remotely')
          }
        })
      )
    } catch {
      // Ignore if plugin event bus is mocked minimally
    }

    void this.refreshConnections()
  }

  private getActiveConnection(): ConnectionProfile | undefined {
    if (!this.activeConnectionId) return undefined
    return this.connections.find((c) => c.id === this.activeConnectionId)
  }

  private isActiveConnectionReadOnly(): boolean {
    return Boolean(this.getActiveConnection()?.readOnly)
  }

  private applyActiveConnectionPresentation(conn?: ConnectionProfile): void {
    const driver: DatabaseDriverType = conn?.driver || 'sqlite'

    if (this.connLogoEl) {
      this.connLogoEl.innerHTML = ''
      this.connLogoEl.appendChild(createDbLogoSvg(driver))
      this.connLogoEl.title = driver.toUpperCase()
    }

    if (this.envPillEl) {
      const tag = conn?.colorTag
      if (tag && tag !== 'none') {
        this.envPillEl.textContent = tag.toUpperCase()
        this.envPillEl.className = `datanoa-env-pill env-${tag}`
        this.envPillEl.style.display = 'inline-flex'
      } else {
        this.envPillEl.style.display = 'none'
      }
    }

    if (this.roBadgeEl) {
      this.roBadgeEl.style.display = conn?.readOnly ? 'inline-flex' : 'none'
    }

    if (this.editConnBtn) {
      this.editConnBtn.disabled = !conn
    }

    if (this.cautionStripEl) {
      if (conn?.readOnly && conn?.colorTag === 'prod') {
        this.cautionStripEl.className = 'datanoa-caution-strip prod'
        this.cautionStripEl.textContent =
          'PRODUCTION (Read-Only) — Mutations and write SQL statements are locked.'
        this.cautionStripEl.style.display = 'flex'
      } else if (conn?.colorTag === 'prod') {
        this.cautionStripEl.className = 'datanoa-caution-strip prod'
        this.cautionStripEl.textContent =
          'PRODUCTION environment — Double-check WHERE clauses and DML changes before submitting.'
        this.cautionStripEl.style.display = 'flex'
      } else if (conn?.readOnly) {
        this.cautionStripEl.className = 'datanoa-caution-strip'
        this.cautionStripEl.textContent =
          'Read-Only connection — Inline edits, staged DML, and write statements are disabled.'
        this.cautionStripEl.style.display = 'flex'
      } else {
        this.cautionStripEl.style.display = 'none'
      }
    }

    this.sqlConsole?.setDialect(driver as SqlDialectType)
    this.schemaInspector?.setDialect(driver)
    this.schemaInspector?.setReadOnly(Boolean(conn?.readOnly))
    const canCreateTable = Boolean(conn && !conn.readOnly && driver !== 'redis')
    if (this.newTableBtn) {
      this.newTableBtn.disabled = !canCreateTable
    }
    if (this.topbarNewTableBtn) {
      this.topbarNewTableBtn.disabled = !canCreateTable
    }
    if (this.dataGrid) {
      this.dataGrid.setContextMeta(
        this.activeTable || 'table_name',
        driver,
        this.activeConnectionId || '',
        this.activeSchema || ''
      )
    }
    this.updateStagedActionButtons(this.dataGrid?.getStagedCount() ?? 0)
  }

  private updateStagedActionButtons(stagedCount: number): void {
    const canEdit =
      this.currentCanEdit &&
      !this.isActiveConnectionReadOnly() &&
      !this.isShowingSqlResult &&
      !this.isSubmittingChanges
    if (this.addRowBtn) this.addRowBtn.disabled = !canEdit
    if (this.cloneRowBtn) this.cloneRowBtn.disabled = !canEdit
    if (this.delRowBtn) this.delRowBtn.disabled = !canEdit
    if (this.submitBtn && !this.isSubmittingChanges) {
      this.submitBtn.textContent = `Submit [${stagedCount}]`
      this.submitBtn.disabled = stagedCount === 0 || !canEdit
    }
    if (this.dmlApplyBtn && !this.isSubmittingChanges) {
      this.dmlApplyBtn.disabled = stagedCount === 0 || !canEdit
    }
    if (this.revertBtn) this.revertBtn.disabled = stagedCount === 0 || this.isSubmittingChanges
    if (this.dmlPreviewBtn && !this.isPreviewingDml) {
      this.dmlPreviewBtn.disabled = stagedCount === 0 || !canEdit
    }
    if (this.statusMetricsEl && !this.isShowingSqlResult && this.activeTable) {
      this.statusMetricsEl.textContent =
        stagedCount > 0
          ? `${this.totalRows} rows (+${stagedCount} staged)`
          : `${this.totalRows} rows`
    }
  }

  private updatePaginationButtons(): void {
    const hasMore = this.currentPage * this.pageSize < this.totalRows
    const blocked = this.isTableLoading || this.isShowingSqlResult || !this.activeTable
    if (this.prevBtn) {
      this.prevBtn.disabled = blocked || this.currentPage <= 1
    }
    if (this.nextBtn) {
      this.nextBtn.disabled = blocked || !hasMore
    }
  }

  private async handleRefreshAction(): Promise<void> {
    if (this.isRefreshingSchema) return
    this.isRefreshingSchema = true
    setButtonLoading(this.refreshBtn, true, 'Refreshing...')
    try {
      if (this.activeConnectionId) {
        this.restoredPageOnBoot = this.currentPage
        await this.introspectSchema(this.activeConnectionId, true)
      } else {
        await this.refreshConnections()
      }
    } finally {
      this.isRefreshingSchema = false
      setButtonLoading(this.refreshBtn, false)
    }
  }

  public async refreshConnections(): Promise<void> {
    if (typeof window === 'undefined' || !window.orca?.plugin?.request) return
    const seq = ++this.connectionsSeq
    try {
      const conns = await this.requestPlugin<ConnectionProfile[]>('connections.list')
      if (seq !== this.connectionsSeq) return
      this.connections = conns || []
      if (typeof window.orca?.storage?.get === 'function') {
        if (!this.readLocalStudioViewState()) {
          try {
            const hostSaved = (await window.orca.storage.get(
              STUDIO_VIEW_STATE_STORAGE_KEY
            )) as StudioPersistedViewState | null
            if (seq !== this.connectionsSeq) return
            if (hostSaved && typeof hostSaved === 'object') {
              this.applyRestoredStudioViewState(hostSaved)
            }
          } catch {
            // Ignore host view state read errors
          }
        }
        if (
          !this.pendingDocConnectionId &&
          !this.activeConnectionId &&
          !this.storedActiveConnectionId
        ) {
          try {
            const stored = await window.orca.storage.get(ACTIVE_CONNECTION_STORAGE_KEY)
            if (seq !== this.connectionsSeq) return
            if (typeof stored === 'string' && stored.trim().length > 0) {
              this.storedActiveConnectionId = stored.trim()
            }
          } catch {
            // Ignore storage read errors in minimal test environments
          }
        }
      }
      if (seq !== this.connectionsSeq) return
      this.updateConnectionSelector()
    } catch {
      // Non-blocking in testing / offline environments
    }
  }

  private updateConnectionSelector(): void {
    if (!this.connSelectEl) return

    let targetId: string | null = null
    if (
      this.pendingDocConnectionId &&
      this.connections.some((c) => c.id === this.pendingDocConnectionId)
    ) {
      targetId = this.pendingDocConnectionId
    } else if (
      this.activeConnectionId &&
      this.connections.some((c) => c.id === this.activeConnectionId)
    ) {
      targetId = this.activeConnectionId
    } else if (
      this.storedActiveConnectionId &&
      this.connections.some((c) => c.id === this.storedActiveConnectionId)
    ) {
      targetId = this.storedActiveConnectionId
    } else if (this.connections.length > 0) {
      targetId = this.connections[0].id
    }

    this.connSelectEl.innerHTML = ''
    const defaultOpt = document.createElement('option')
    defaultOpt.value = ''
    defaultOpt.textContent = 'Select Connection...'
    this.connSelectEl.appendChild(defaultOpt)

    const connSel = this.connSelectEl
    if (!connSel) return
    this.connections.forEach((conn) => {
      const opt = document.createElement('option')
      opt.value = conn.id
      const envSuffix = conn.colorTag && conn.colorTag !== 'none' ? ` [${conn.colorTag.toUpperCase()}]` : ''
      const roSuffix = conn.readOnly ? ' [RO]' : ''
      opt.textContent = `${conn.name} (${conn.driver})${envSuffix}${roSuffix}`
      if (conn.id === (targetId || '')) {
        opt.selected = true
      }
      connSel.appendChild(opt)
    })

    connSel.value = targetId || ''
    const preservePending = Boolean(
      this.pendingDocConnectionId && targetId === this.pendingDocConnectionId
    )
    this.handleConnectionChanged(targetId, preservePending)
  }

  private handleConnectionChanged(
    connectionId: string | null,
    preservePendingTable = false
  ): void {
    const changed = connectionId !== this.activeConnectionId
    this.activeConnectionId = connectionId

    if (this.connSelectEl) {
      this.connSelectEl.value = connectionId || ''
    }

    if (changed && connectionId) {
      this.storedActiveConnectionId = connectionId
      if (typeof window !== 'undefined' && typeof window.orca?.storage?.set === 'function') {
        try {
          void Promise.resolve(
            window.orca.storage.set(ACTIVE_CONNECTION_STORAGE_KEY, connectionId)
          ).catch(() => {})
        } catch {
          // Ignore storage write errors
        }
      }
    }

    const shouldResetState = changed || !connectionId
    if (shouldResetState) {
      this.introspectToken++
      this.gridViewSeq++
      this.tableLoadToken++
      this.schemaLoadToken++
      this.querySeq++
      this.isTableLoading = false
      this.isCancellingQuery = false
      this.cancelledQueryIds.clear()
      setButtonLoading(this.runBtn, false)
      setButtonLoading(this.runAllBtn, false)
      setButtonLoading(this.explainBtn, false)
      this.setQueryRunningState(null)
      this.cancelClientSearchDebounce()
      this.closeSidebarContextMenu()
      this.closeTopbarPopover()
      this.hasLoadedActiveConnection = false
      this.activeTable = preservePendingTable ? this.pendingDocTable || this.activeTable : null
      this.activeSchema = preservePendingTable ? this.pendingDocSchema : undefined
      this.currentPage = preservePendingTable && this.restoredPageOnBoot ? this.restoredPageOnBoot : 1
      this.totalRows = 0
      this.isShowingSqlResult = false
      this.currentCanEdit = false
      if (!preservePendingTable) {
        this.activeWhereClause = undefined
        this.activeOrderByClause = undefined
        if (this.whereInputEl) this.whereInputEl.value = ''
        if (this.orderByInputEl) this.orderByInputEl.value = ''
        if (this.clientSearchEl) this.clientSearchEl.value = ''
        this.dataGrid?.setClientFilter('')
      }
      if (this.dmlPreviewEl) this.dmlPreviewEl.style.display = 'none'
      this.hideQueryBanner()
      this.selectedCell = null
      if (this.inspectCellBtn) this.inspectCellBtn.disabled = true
      this.closeValueInspector()

      this.schemaObjects = []
      this.schemaMap = {}
      this.tableDetailsCache.clear()
      this.inFlightTableDetails.clear()
      this.lastInspectorLoadedKey = ''
      this.currentPageRowCount = 0
      this.lastSelectionSummary = null
      this.updateSelectionStatusDisplay(null)
      this.sqlConsole?.updateSchema({}, '')
      if (connectionId) {
        this.isIntrospectingSchema = true
        this.renderSidebarSkeleton()
      } else {
        this.isIntrospectingSchema = false
        this.renderSidebarObjects()
      }
      this.dataGrid?.clearSortIndicator()
      this.dataGrid?.setForeignKeys([])
      this.dataGrid?.setEmptyMessage(
        connectionId ? 'Loading schema...' : 'Select a database connection to browse tables.'
      )
      this.dataGrid?.setData({
        columns: [],
        rows: [],
        totalRows: 0,
        page: 1,
        pageSize: this.pageSize,
        primaryKey: [],
        canEdit: false,
      })
      this.schemaInspector?.clear()
      if (this.gridPageInfoEl) {
        this.gridPageInfoEl.textContent = 'Page 1'
      }
      if (this.gridSubbarTitleEl) {
        this.gridSubbarTitleEl.textContent = 'Select a table'
      }
      this.updatePaginationButtons()
      this.updateExportDropdownOptions()
    }

    const conn = this.getActiveConnection()
    this.applyActiveConnectionPresentation(conn)
    if (!connectionId || !conn) {
      this.hasLoadedActiveConnection = false
      return
    }

    if (!this.hasLoadedActiveConnection) {
      this.hasLoadedActiveConnection = true
      this.pendingDocConnectionId = null
      this.pendingDocTable = null
      this.pendingDocSchema = undefined
      void this.introspectSchema(conn.id)
    }
  }

  private closeSidebarContextMenu(): void {
    if (this.sidebarContextMenuEl) {
      this.sidebarContextMenuEl.remove()
      this.sidebarContextMenuEl = null
    }
  }

  private selectSidebarObject(item: SchemaObject): void {
    const isSameTable =
      this.activeTable === item.name &&
      (this.activeSchema || '') === (item.schema || '') &&
      !this.isShowingSqlResult
    const hadActiveFilterOrPage = Boolean(
      this.activeWhereClause ||
        this.activeOrderByClause ||
        (this.whereInputEl?.value || '').trim() ||
        (this.orderByInputEl?.value || '').trim() ||
        this.currentPage !== 1
    )
    this.activeTable = item.name
    this.activeSchema = item.schema || undefined
    this.currentPage = 1
    this.restoredPageOnBoot = null
    this.activeWhereClause = undefined
    this.activeOrderByClause = undefined
    if (this.whereInputEl) this.whereInputEl.value = ''
    if (this.orderByInputEl) this.orderByInputEl.value = ''
    this.hideQueryBanner()
    this.closeValueInspector()
    this.closeColumnsPopover()
    this.dataGrid?.clearClientColumnFilters()
    this.dataGrid?.clearSortIndicator()
    this.updateSelectedTableHighlight()
    this.sqlConsole?.updateSchema(this.schemaMap, item.name)
    this.updateMetadataHeader('table', item.name)
    if (item.schema) {
      this.updateMetadataHeader('schema', item.schema)
    }
    this.saveStudioViewState(true)
    if (this.activeConnectionId && (!isSameTable || hadActiveFilterOrPage)) {
      if (this.activeQueryId) {
        this.querySeq++
        this.isCancellingQuery = false
        this.cancelledQueryIds.clear()
        setButtonLoading(this.runBtn, false)
        setButtonLoading(this.runAllBtn, false)
        setButtonLoading(this.explainBtn, false)
        this.setQueryRunningState(null)
      }
      this.lastInspectorLoadedKey = ''
      void this.loadTableData(this.activeConnectionId, item.name, 1)
      if (this.activeViewMode === 'inspector') {
        void this.loadActiveTableSchema()
      }
    }
  }

  private async fetchTableDetailsDeduped(
    connectionId: string,
    table: string,
    schema?: string,
    force = false
  ): Promise<TableDetails> {
    const cacheKey = `${connectionId}:${schema || ''}:${table}`
    if (!force) {
      const cached = this.tableDetailsCache.get(cacheKey)
      if (cached) return cached
      const inflight = this.inFlightTableDetails.get(cacheKey)
      if (inflight) return inflight
    }
    const promise = this.requestPlugin<TableDetails>(
      'schema.tableDetails',
      {
        connectionId,
        table,
        ...(schema ? { schema } : {}),
      },
      { timeoutMs: DEFAULT_RPC_TIMEOUT_MS }
    )
      .then((details) => {
        this.tableDetailsCache.set(cacheKey, details)
        return details
      })
      .finally(() => {
        if (this.inFlightTableDetails.get(cacheKey) === promise) {
          this.inFlightTableDetails.delete(cacheKey)
        }
      })
    this.inFlightTableDetails.set(cacheKey, promise)
    return promise
  }

  private formatQualifiedSqlTable(item: SchemaObject, driver: DatabaseDriverType): string {
    const quotedName = quoteIdentForDialect(item.name, driver)
    if (
      item.schema &&
      item.schema !== 'main' &&
      driver !== 'sqlite' &&
      driver !== 'libsql' &&
      driver !== 'redis'
    ) {
      return `${quoteIdentForDialect(item.schema, driver)}.${quotedName}`
    }
    return quotedName
  }

  private async getObjectColumnMeta(
    item: SchemaObject
  ): Promise<{ columns: TableDetails['columns']; primaryKey: string[] }> {
    if (
      this.activeConnectionId &&
      typeof window !== 'undefined' &&
      typeof window.orca?.plugin?.request === 'function'
    ) {
      try {
        const details = await this.fetchTableDetailsDeduped(
          this.activeConnectionId,
          item.name,
          item.schema,
          false
        )
        if (details && Array.isArray(details.columns) && details.columns.length > 0) {
          return {
            columns: details.columns,
            primaryKey: details.primaryKey || [],
          }
        }
      } catch {
        // Fallback to cached schemaMap below
      }
    }
    const cachedCols = this.schemaMap[item.name] || []
    return {
      columns: cachedCols.map((name, idx) => ({
        name,
        type: 'TEXT',
        nativeType: 'TEXT',
        nullable: true,
        defaultValue: null,
        isPrimaryKey: idx === 0,
        isAutoIncrement: false,
      })),
      primaryKey: cachedCols.length > 0 ? [cachedCols[0]] : [],
    }
  }

  private async generateSqlTemplateForObject(
    item: SchemaObject,
    kind: 'select' | 'insert' | 'update'
  ): Promise<void> {
    const driver: DatabaseDriverType = this.getActiveConnection()?.driver || 'sqlite'
    const tableRef = this.formatQualifiedSqlTable(item, driver)
    const { columns, primaryKey } = await this.getObjectColumnMeta(item)

    const colNames = columns.map((c) => c.name)
    let sqlText = ''

    if (kind === 'select') {
      const colList =
        colNames.length > 0
          ? colNames.map((name) => quoteIdentForDialect(name, driver)).join(', ')
          : '*'
      sqlText = `SELECT ${colList}\nFROM ${tableRef}\nLIMIT 100;`
    } else if (kind === 'insert') {
      const editableCols = columns.filter((c) => !c.isAutoIncrement)
      const targetCols = editableCols.length > 0 ? editableCols : columns
      if (targetCols.length > 0) {
        const colsSql = targetCols.map((c) => quoteIdentForDialect(c.name, driver)).join(', ')
        const valsSql = targetCols
          .map((c) =>
            /INT|REAL|FLOAT|NUMERIC|DECIMAL/i.test(c.type)
              ? '0'
              : /BOOL/i.test(c.type)
                ? 'false'
                : "''"
          )
          .join(', ')
        sqlText = `INSERT INTO ${tableRef} (${colsSql})\nVALUES (${valsSql});`
      } else {
        sqlText = `INSERT INTO ${tableRef} ()\nVALUES ();`
      }
    } else {
      const pkSet = new Set(primaryKey)
      const setCols = columns.filter((c) => !pkSet.has(c.name) && !c.isAutoIncrement)
      const effectiveSetCols = setCols.length > 0 ? setCols : columns
      const setSql =
        effectiveSetCols.length > 0
          ? effectiveSetCols
              .map((c) => {
                const val = /INT|REAL|FLOAT|NUMERIC|DECIMAL/i.test(c.type)
                  ? '0'
                  : /BOOL/i.test(c.type)
                    ? 'false'
                    : "''"
                return `${quoteIdentForDialect(c.name, driver)} = ${val}`
              })
              .join(',\n  ')
          : `${quoteIdentForDialect('column_name', driver)} = ''`
      const whereCols = primaryKey.length > 0 ? primaryKey : colNames.slice(0, 1)
      const whereSql =
        whereCols.length > 0
          ? whereCols.map((c) => `${quoteIdentForDialect(c, driver)} = ''`).join(' AND ')
          : '1 = 0'
      sqlText = `UPDATE ${tableRef}\nSET ${setSql}\nWHERE ${whereSql};`
    }

    this.sqlConsole?.insertText(sqlText)
    if (this.activeViewMode === 'grid' || this.activeViewMode === 'inspector') {
      this.switchMode('split')
    }
    this.updateStatus(`Generated ${kind.toUpperCase()} template for ${item.name}`)
  }

  private openSidebarContextMenu(clientX: number, clientY: number, item: SchemaObject): void {
    this.closeSidebarContextMenu()
    this.closeTopbarPopover()
    if (typeof document === 'undefined') return

    const menu = document.createElement('div')
    menu.className = 'datanoa-context-menu'

    const addItem = (label: string, onClick: () => void, opts?: { danger?: boolean; disabled?: boolean }) => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = `datanoa-context-item${opts?.danger ? ' danger' : ''}`
      btn.textContent = label
      if (opts?.disabled) {
        btn.disabled = true
      }
      btn.addEventListener('click', () => {
        if (opts?.disabled) return
        this.closeSidebarContextMenu()
        this.closeTopbarPopover()
        onClick()
      })
      menu.appendChild(btn)
    }

    const addSep = () => {
      const sep = document.createElement('div')
      sep.className = 'datanoa-context-sep'
      menu.appendChild(sep)
    }

    const driver: DatabaseDriverType = this.getActiveConnection()?.driver || 'sqlite'
    const isReadOnly = this.isActiveConnectionReadOnly()
    const isRedis = driver === 'redis'

    addItem('Open Data', () => {
      this.selectSidebarObject(item)
      if (this.activeViewMode === 'inspector') {
        this.switchMode('split')
      }
    })
    addItem('Count Rows', () => {
      void this.countRowsForObject(item)
    }, { disabled: isRedis })
    addSep()
    addItem('Generate SELECT', () => {
      void this.generateSqlTemplateForObject(item, 'select')
    })
    addItem('Generate INSERT', () => {
      void this.generateSqlTemplateForObject(item, 'insert')
    })
    addItem('Generate UPDATE', () => {
      void this.generateSqlTemplateForObject(item, 'update')
    })
    addSep()
    addItem('Inspect Schema & DDL', () => {
      this.selectSidebarObject(item)
      this.switchMode('inspector')
    })
    if (item.kind === 'table') {
      addItem('Edit Table Structure', () => {
        this.selectSidebarObject(item)
        this.switchMode('inspector')
      })
    }
    addItem('Copy Table Name', () => {
      copyTextFallback(item.name)
      this.updateStatus(`Copied "${item.name}" to clipboard`)
    })
    addItem('Copy SELECT *', () => {
      const tableRef = this.formatQualifiedSqlTable(item, driver)
      const selectSql = `SELECT * FROM ${tableRef} LIMIT 100;`
      copyTextFallback(selectSql)
      this.updateStatus(`Copied "${selectSql}" to clipboard`)
    }, { disabled: isRedis })

    if (!isRedis) {
      addSep()
      if (item.kind === 'table') {
        addItem(
          'Truncate Table...',
          () => {
            this.openDangerTableModal('truncate', item)
          },
          { danger: true, disabled: isReadOnly }
        )
      }
      addItem(
        item.kind === 'view' ? 'Drop View...' : 'Drop Table...',
        () => {
          this.openDangerTableModal('drop', item)
        },
        { danger: true, disabled: isReadOnly }
      )
    }

    document.body.appendChild(menu)
    this.sidebarContextMenuEl = menu

    const rect = menu.getBoundingClientRect()
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1024
    const vh = typeof window !== 'undefined' ? window.innerHeight : 768
    const left = Math.max(6, Math.min(clientX, vw - rect.width - 8))
    const top = Math.max(6, Math.min(clientY, vh - rect.height - 8))
    menu.style.left = `${left}px`
    menu.style.top = `${top}px`
  }

  private renderTopbarObjects(filtered: SchemaObject[]): void {
    if (this.topbarCountEl) {
      const total = this.schemaObjects.length
      this.topbarCountEl.textContent =
        this.filterQuery && filtered.length !== total
          ? `${filtered.length}/${total}`
          : String(total)
    }
    if (this.topbarAllBtn) {
      this.topbarAllBtn.textContent = `All (${filtered.length}) ▾`
    }
    if (!this.topbarTrackEl) return
    this.topbarTrackEl.innerHTML = ''

    if (filtered.length === 0) {
      const empty = document.createElement('span')
      empty.className = 'datanoa-cell-null'
      empty.style.padding = '0 8px'
      empty.textContent = this.filterQuery
        ? `No tables match "${this.filterQuery}"`
        : 'No tables or views'
      this.topbarTrackEl.appendChild(empty)
      return
    }

    const trackEl = this.topbarTrackEl
    for (const item of filtered) {
      const pill = document.createElement('button')
      pill.type = 'button'
      const isActive = this.isObjectActive(item.name, item.schema)
      pill.className = `datanoa-topbar-pill${isActive ? ' active' : ''}`
      if (pill.dataset) {
        pill.dataset.tableName = item.name
        pill.dataset.tableSchema = item.schema || ''
      }
      pill.title = `${item.schema ? `${item.schema}.` : ''}${item.name} (${item.kind.toUpperCase()})`

      const nameSpan = document.createElement('span')
      nameSpan.textContent = item.name
      pill.appendChild(nameSpan)

      if (item.kind === 'view') {
        const kindSpan = document.createElement('span')
        kindSpan.className = 'datanoa-topbar-pill-kind'
        kindSpan.textContent = 'VIEW'
        pill.appendChild(kindSpan)
      }

      pill.addEventListener('click', () => {
        this.selectSidebarObject(item)
      })
      pill.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        this.openSidebarContextMenu(e.clientX, e.clientY, item)
      })
      trackEl.appendChild(pill)
    }

    if (this.sidebarCollapsed) {
      this.scrollActiveTopbarPillIntoView()
    }
  }

  private renderSidebarSkeleton(): void {
    if (this.sidebarListEl) {
      this.sidebarListEl.innerHTML = ''
      const skelWrap = document.createElement('div')
      skelWrap.className = 'datanoa-sidebar-skeleton'
      const widths = [72, 58, 84, 64, 78, 52]
      for (const w of widths) {
        const bar = document.createElement('div')
        bar.className = 'datanoa-skeleton-bar'
        bar.style.width = `${w}%`
        skelWrap.appendChild(bar)
      }
      this.sidebarListEl.appendChild(skelWrap)
    }
    if (this.topbarTrackEl) {
      this.topbarTrackEl.innerHTML = ''
      const topSkel = document.createElement('div')
      topSkel.className = 'datanoa-sidebar-skeleton'
      topSkel.style.flexDirection = 'row'
      topSkel.style.padding = '0 4px'
      for (let i = 0; i < 4; i++) {
        const bar = document.createElement('div')
        bar.className = 'datanoa-skeleton-bar'
        bar.style.width = `${64 + (i % 3) * 18}px`
        bar.style.height = '18px'
        topSkel.appendChild(bar)
      }
      this.topbarTrackEl.appendChild(topSkel)
    }
    if (this.topbarCountEl) {
      this.topbarCountEl.textContent = '...'
    }
  }

  private renderSidebarObjects(): void {
    if (!this.sidebarListEl) return
    if (this.isIntrospectingSchema) {
      this.renderSidebarSkeleton()
      return
    }
    this.sidebarListEl.innerHTML = ''

    const filtered = this.schemaObjects.filter(
      (o) => !this.filterQuery || o.name.toLowerCase().includes(this.filterQuery)
    )
    this.renderTopbarObjects(filtered)

    const tables = filtered.filter((o) => o.kind === 'table')
    const views = filtered.filter((o) => o.kind === 'view')

    if (!this.activeConnectionId) {
      const emptyConnWrap = document.createElement('div')
      emptyConnWrap.className = 'datanoa-sidebar-empty-cta'
      const emptyConnText = document.createElement('div')
      emptyConnText.className = 'datanoa-cell-null'
      emptyConnText.textContent = 'No database connection selected'
      const connectBtn = document.createElement('button')
      connectBtn.type = 'button'
      connectBtn.className = 'datanoa-btn datanoa-btn-primary datanoa-btn-sm'
      connectBtn.textContent = '+ Connect Database'
      connectBtn.addEventListener('click', () => {
        this.openConnectionModal()
      })
      emptyConnWrap.appendChild(emptyConnText)
      emptyConnWrap.appendChild(connectBtn)
      this.sidebarListEl.appendChild(emptyConnWrap)
      return
    }

    if (tables.length === 0 && views.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'datanoa-cell-null'
      empty.style.padding = '12px'
      empty.textContent = this.filterQuery
        ? `No objects match "${this.filterQuery}"`
        : 'No tables or views'
      this.sidebarListEl.appendChild(empty)

      const conn = this.getActiveConnection()
      if (!this.filterQuery && conn && !conn.readOnly && conn.driver !== 'redis') {
        const ctaWrap = document.createElement('div')
        ctaWrap.style.padding = '0 12px 12px'
        const ctaBtn = document.createElement('button')
        ctaBtn.type = 'button'
        ctaBtn.className = 'datanoa-btn datanoa-btn-primary datanoa-btn-sm'
        ctaBtn.textContent = '+ New Table'
        ctaBtn.addEventListener('click', () => {
          this.openCreateTableModal()
        })
        ctaWrap.appendChild(ctaBtn)
        this.sidebarListEl.appendChild(ctaWrap)
      }
      return
    }

    const sidebarListEl = this.sidebarListEl
    if (!sidebarListEl) return
    const createGroup = (title: string, items: SchemaObject[], badgeText: string) => {
      const header = document.createElement('div')
      header.className = 'datanoa-sidebar-group-title'
      const labelSpan = document.createElement('span')
      labelSpan.textContent = title
      const countSpan = document.createElement('span')
      countSpan.textContent = String(items.length)
      header.appendChild(labelSpan)
      header.appendChild(countSpan)
      sidebarListEl.appendChild(header)

      for (const item of items) {
        const btn = document.createElement('button')
        btn.type = 'button'
        const isActive = this.isObjectActive(item.name, item.schema)
        btn.className = `datanoa-sidebar-item${isActive ? ' active' : ''}`
        if (btn.dataset) {
          btn.dataset.tableName = item.name
          btn.dataset.tableSchema = item.schema || ''
        }
        const nameSpan = document.createElement('span')
        nameSpan.className = 'datanoa-sidebar-item-name'
        nameSpan.textContent = item.name
        const kindSpan = document.createElement('span')
        kindSpan.className = 'datanoa-sidebar-item-kind'
        kindSpan.textContent = badgeText
        btn.appendChild(nameSpan)
        btn.appendChild(kindSpan)
        btn.addEventListener('click', () => {
          this.selectSidebarObject(item)
        })
        btn.addEventListener('contextmenu', (e) => {
          e.preventDefault()
          this.openSidebarContextMenu(e.clientX, e.clientY, item)
        })
        sidebarListEl.appendChild(btn)
      }
    }

    createGroup('Tables', tables, 'TBL')
    if (views.length > 0) {
      createGroup('Views', views, 'VIEW')
    }
  }

  private async prefetchAutocompleteSchema(
    connectionId: string,
    tableNames: string[],
    reqToken: number
  ): Promise<void> {
    const targets = tableNames.slice(0, 50)
    const schemaMap: Record<string, string[]> = { ...this.schemaMap }
    const batchSize = 4

    for (let i = 0; i < targets.length; i += batchSize) {
      if (reqToken !== this.introspectToken || this.activeConnectionId !== connectionId) {
        return
      }
      const chunk = targets.slice(i, i + batchSize)
      const results = await Promise.allSettled(
        chunk.map(async (t) => {
          const obj = this.schemaObjects.find((o) => o.name === t)
          const details = await this.fetchTableDetailsDeduped(
            connectionId,
            t,
            obj?.schema,
            false
          )
          if (
            this.activeConnectionId === connectionId &&
            this.activeTable === t &&
            !this.isShowingSqlResult
          ) {
            this.dataGrid?.setForeignKeys(details.foreignKeys || [])
          }
          return details.columns.map((c) => c.name)
        })
      )
      if (reqToken !== this.introspectToken || this.activeConnectionId !== connectionId) {
        return
      }
      for (let j = 0; j < chunk.length; j++) {
        const res = results[j]
        if (res.status === 'fulfilled') {
          schemaMap[chunk[j]] = res.value
        } else if (!schemaMap[chunk[j]]) {
          schemaMap[chunk[j]] = []
        }
      }
    }

    if (reqToken !== this.introspectToken || this.activeConnectionId !== connectionId) {
      return
    }
    this.schemaMap = schemaMap
    this.sqlConsole?.updateSchema(this.schemaMap, this.activeTable || undefined)
  }

  private async introspectSchema(connectionId: string, preservePage = false): Promise<void> {
    if (typeof window === 'undefined' || !window.orca?.plugin?.request) return
    const reqToken = ++this.introspectToken
    this.isIntrospectingSchema = true
    this.renderSidebarSkeleton()
    this.updateStatus('Loading schema...')
    this.dataGrid?.setEmptyMessage('Loading schema...')
    try {
      const objects = await this.requestPlugin<SchemaObject[]>(
        'schema.listObjects',
        { connectionId },
        { timeoutMs: DEFAULT_RPC_TIMEOUT_MS }
      )
      if (reqToken !== this.introspectToken || this.activeConnectionId !== connectionId) {
        return
      }

      this.isIntrospectingSchema = false
      this.schemaObjects = objects || []
      const tableNames = this.schemaObjects.filter((o) => o.kind === 'table').map((t) => t.name)
      this.schemaInspector?.setReferenceTables(tableNames)
      const fallbackNames =
        tableNames.length > 0 ? tableNames : this.schemaObjects.map((o) => o.name)

      if (this.activeTable) {
        const matchedObj =
          this.schemaObjects.find(
            (o) =>
              o.name === this.activeTable &&
              (o.schema || '') === (this.activeSchema || '')
          ) || this.schemaObjects.find((o) => o.name === this.activeTable)
        if (matchedObj) {
          this.activeSchema = matchedObj.schema || this.activeSchema
        } else if (fallbackNames.length > 0) {
          this.activeTable = fallbackNames[0]
          this.activeSchema =
            this.schemaObjects.find((o) => o.name === this.activeTable)?.schema || undefined
        } else {
          this.activeTable = null
          this.activeSchema = undefined
        }
      } else if (fallbackNames.length > 0) {
        this.activeTable = fallbackNames[0]
        this.activeSchema =
          this.schemaObjects.find((o) => o.name === this.activeTable)?.schema || undefined
      }

      const initialSchemaMap: Record<string, string[]> = {}
      for (const obj of this.schemaObjects) {
        initialSchemaMap[obj.name] = this.schemaMap[obj.name] || []
      }
      this.schemaMap = initialSchemaMap
      this.sqlConsole?.updateSchema(this.schemaMap, this.activeTable || undefined)

      this.renderSidebarObjects()

      if (this.schemaObjects.length === 0 || !this.activeTable) {
        this.currentPageRowCount = 0
        this.dataGrid?.setEmptyMessage('No tables or views found in this connection.')
        this.dataGrid?.setData({
          columns: [],
          rows: [],
          totalRows: 0,
          page: 1,
          pageSize: this.pageSize,
          primaryKey: [],
          canEdit: false,
        })
        this.schemaInspector?.clear()
        this.updatePaginationButtons()
        this.updateExportDropdownOptions()
        this.updateStatus('Connected · 0 tables', '0 rows')
        return
      }

      const initialPage =
        preservePage || this.restoredPageOnBoot
          ? Math.max(1, this.restoredPageOnBoot || this.currentPage || 1)
          : 1
      this.restoredPageOnBoot = null
      await this.loadTableData(connectionId, this.activeTable, initialPage)
      if (reqToken !== this.introspectToken || this.activeConnectionId !== connectionId) {
        return
      }

      if (this.activeViewMode === 'inspector') {
        void this.loadActiveTableSchema()
      }

      void this.prefetchAutocompleteSchema(connectionId, tableNames, reqToken)
    } catch (err: unknown) {
      if (reqToken !== this.introspectToken || this.activeConnectionId !== connectionId) {
        return
      }
      this.isIntrospectingSchema = false
      this.renderSidebarObjects()
      const msg = err instanceof Error ? err.message : String(err)
      this.dataGrid?.setEmptyMessage(`Failed to load schema: ${msg}`)
      this.showQueryBanner('error', 'Failed to Load Schema', msg, {
        onRetry: () => {
          void this.introspectSchema(connectionId, preservePage)
        },
      })
      this.updatePaginationButtons()
      this.updateStatus(`Schema error: ${msg}`)
    }
  }

  private showQueryBanner(
    kind: 'success' | 'error',
    title: string,
    detail = '',
    opts?: { onRetry?: () => void; showBackToTable?: boolean }
  ): void {
    if (!this.queryBannerEl || !this.queryBannerTitleEl || !this.queryBannerDetailEl) return
    this.queryBannerEl.className = `datanoa-query-banner ${kind}`
    this.queryBannerEl.setAttribute('role', kind === 'error' ? 'alert' : 'status')
    this.queryBannerTitleEl.textContent = title
    this.queryBannerDetailEl.textContent = detail
    this.queryBannerDetailEl.style.display = detail ? 'block' : 'none'
    if (this.queryBannerCopyBtn) {
      this.lastQueryErrorText = kind === 'error' ? detail || title : ''
      this.queryBannerCopyBtn.style.display = kind === 'error' ? 'inline-flex' : 'none'
    }
    this.queryBannerRetryHandler = opts?.onRetry ?? null
    if (this.queryBannerRetryBtn) {
      this.queryBannerRetryBtn.style.display = opts?.onRetry ? 'inline-flex' : 'none'
    }
    if (this.queryBannerBackBtn) {
      const canReturn = Boolean(
        opts?.showBackToTable && this.activeConnectionId && this.activeTable
      )
      this.queryBannerBackBtn.style.display = canReturn ? 'inline-flex' : 'none'
    }
    this.queryBannerEl.style.display = 'flex'
  }

  private hideQueryBanner(): void {
    this.lastQueryErrorText = ''
    this.queryBannerRetryHandler = null
    if (this.queryBannerRetryBtn) {
      this.queryBannerRetryBtn.style.display = 'none'
    }
    if (this.queryBannerBackBtn) {
      this.queryBannerBackBtn.style.display = 'none'
    }
    if (this.queryBannerEl) {
      const wasVisible = this.queryBannerEl.style.display !== 'none'
      this.queryBannerEl.style.display = 'none'
      if (wasVisible) {
        this.dataGrid?.handleViewportResize()
      }
    }
  }

  private async applyServerFilters(): Promise<void> {
    if (!this.activeConnectionId || !this.activeTable) {
      this.updateStatus('Select a table first to filter')
      return
    }
    const driver = this.getActiveConnection()?.driver || 'sqlite'
    try {
      this.activeWhereClause = sanitizeFilterClause(this.whereInputEl?.value, driver)
      this.activeOrderByClause = sanitizeFilterClause(this.orderByInputEl?.value, driver)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      this.showQueryBanner('error', 'Invalid Filter Clause', msg)
      this.updateStatus(msg)
      return
    }
    this.dataGrid?.clearSortIndicator()
    await this.loadTableData(this.activeConnectionId, this.activeTable, 1)
  }

  private async clearAllFilters(): Promise<void> {
    this.activeWhereClause = undefined
    this.activeOrderByClause = undefined
    if (this.whereInputEl) this.whereInputEl.value = ''
    if (this.orderByInputEl) this.orderByInputEl.value = ''
    this.dataGrid?.clearClientColumnFilters()
    this.dataGrid?.clearSortIndicator()
    if (!this.isShowingSqlResult && this.activeConnectionId && this.activeTable) {
      await this.loadTableData(this.activeConnectionId, this.activeTable, 1)
    } else {
      this.updateStatus('Cleared column filters')
    }
  }

  private getCurrentTableConfigKey(): string {
    return `${this.activeConnectionId || ''}:${this.activeSchema || ''}:${this.activeTable || ''}`
  }

  private async loadTableData(
    connectionId: string,
    table: string,
    page: number,
    sort?: { column: string; direction: 'ASC' | 'DESC' }
  ): Promise<void> {
    if (typeof window === 'undefined' || !window.orca?.plugin?.request) return
    const targetSchema = this.activeSchema
    const targetTableKey = `${connectionId}:${targetSchema || ''}:${table}`
    const isSameTable = this.lastLoadedTableKey === targetTableKey
    const preservedScrollLeft = isSameTable ? (this.dataGrid?.getScrollLeft() ?? 0) : 0
    const viewSeq = ++this.gridViewSeq
    const loadToken = ++this.tableLoadToken
    this.isTableLoading = true
    this.updatePaginationButtons()
    try {
      this.isShowingSqlResult = false
      this.hideQueryBanner()
      this.updateStatus(`Loading ${table}...`)
      if (this.gridSubbarTitleEl) {
        this.gridSubbarTitleEl.textContent = `Loading ${table}...`
      }
      this.dataGrid?.setLoading(true, `Loading ${table}...`)
      const payload: Record<string, unknown> = {
        connectionId,
        table,
        page,
        pageSize: this.pageSize,
      }
      if (targetSchema) payload.schema = targetSchema
      if (this.activeWhereClause) payload.whereClause = this.activeWhereClause
      if (this.activeOrderByClause) payload.orderByClause = this.activeOrderByClause
      if (sort) {
        payload.sortColumn = sort.column
        payload.sortDirection = sort.direction
      }

      const pageData = await this.requestPlugin<TableBrowseResult>('data.fetchPage', payload, {
        timeoutMs: DEFAULT_RPC_TIMEOUT_MS,
      })
      if (
        viewSeq !== this.gridViewSeq ||
        loadToken !== this.tableLoadToken ||
        this.activeConnectionId !== connectionId ||
        this.activeTable !== table
      ) {
        return
      }

      this.isTableLoading = false

      if (Array.isArray(pageData.columns) && pageData.columns.length > 0) {
        this.schemaMap = {
          ...this.schemaMap,
          [table]: pageData.columns.map((c) => c.name),
        }
        this.sqlConsole?.updateSchema(this.schemaMap, table)
      }

      const conn = this.getActiveConnection()
      const readOnly = Boolean(conn?.readOnly)
      this.currentCanEdit = Boolean(pageData.canEdit) && !readOnly

      this.currentPage = pageData.page || page
      this.totalRows = pageData.totalRows || 0
      this.currentPageRowCount = Array.isArray(pageData.rows) ? pageData.rows.length : 0
      if (this.pageSizeSelectEl) {
        this.pageSizeSelectEl.value = String(this.pageSize)
      }
      this.dataGrid?.setContextMeta(table, conn?.driver || 'sqlite', connectionId, targetSchema || '')
      const cachedKey = `${connectionId}:${targetSchema || ''}:${table}`
      const cachedDetails = this.tableDetailsCache.get(cachedKey)
      this.dataGrid?.setForeignKeys(cachedDetails?.foreignKeys || [])

      const savedColCfg = this.columnConfigByTable[cachedKey]
      this.dataGrid?.setColumnConfig(savedColCfg ? { ...savedColCfg } : { hidden: [], pinned: [] })

      this.dataGrid?.setEmptyMessage(
        this.activeWhereClause
          ? `No rows in "${table}" match the current WHERE filter.`
          : `Table "${table}" has no rows.`
      )
      this.dataGrid?.setData({
        ...pageData,
        canEdit: this.currentCanEdit,
      })
      this.lastLoadedTableKey = targetTableKey
      if (isSameTable && preservedScrollLeft > 0) {
        this.dataGrid?.setScrollLeft(preservedScrollLeft)
      }
      if (this.dmlPreviewEl) this.dmlPreviewEl.style.display = 'none'

      const totalPages = Math.max(1, Math.ceil(this.totalRows / this.pageSize))
      if (this.gridSubbarTitleEl) {
        this.gridSubbarTitleEl.textContent = readOnly
          ? `${table} · ${pageData.columns.length} cols · RO`
          : `${table} · ${pageData.columns.length} cols`
      }
      if (this.gridPageInfoEl) {
        this.gridPageInfoEl.textContent = `Page ${this.currentPage} / ${totalPages} (${this.totalRows} rows)`
      }
      this.updateStagedActionButtons(0)
      this.updatePaginationButtons()
      this.updateExportDropdownOptions()
      this.saveStudioViewState(true)
      this.updateStatus(`Loaded ${table}`, `${this.totalRows} rows`)

      if (!cachedDetails) {
        void this.prefetchSingleTableForeignKeys(connectionId, table, targetSchema, loadToken)
      }
    } catch (err: unknown) {
      if (
        viewSeq !== this.gridViewSeq ||
        loadToken !== this.tableLoadToken ||
        this.activeConnectionId !== connectionId ||
        this.activeTable !== table
      ) {
        return
      }
      this.isTableLoading = false
      const msg = err instanceof Error ? err.message : String(err)
      if (this.gridSubbarTitleEl) {
        this.gridSubbarTitleEl.textContent = `${table} · Error`
      }
      this.dataGrid?.setEmptyMessage(`Error loading ${table}: ${msg}`)
      this.dataGrid?.setData({
        columns: [],
        rows: [],
        totalRows: 0,
        page,
        pageSize: this.pageSize,
        primaryKey: [],
        canEdit: false,
      })
      this.showQueryBanner('error', `Failed to Load "${table}"`, msg, {
        onRetry: () => {
          void this.loadTableData(connectionId, table, page, sort)
        },
      })
      this.updatePaginationButtons()
      this.updateStatus(`Error loading ${table}: ${msg}`)
    }
  }

  private async prefetchSingleTableForeignKeys(
    connectionId: string,
    table: string,
    schema: string | undefined,
    expectedLoadToken: number
  ): Promise<void> {
    if (typeof window === 'undefined' || !window.orca?.plugin?.request) return
    try {
      const details = await this.fetchTableDetailsDeduped(connectionId, table, schema, false)
      if (
        expectedLoadToken === this.tableLoadToken &&
        this.activeConnectionId === connectionId &&
        this.activeTable === table &&
        !this.isShowingSqlResult
      ) {
        this.dataGrid?.setForeignKeys(details.foreignKeys || [])
      }
    } catch {
      // Non-blocking FK prefetch
    }
  }

  private async loadActiveTableSchema(force = false): Promise<void> {
    if (!this.activeConnectionId || !this.activeTable) {
      this.schemaInspector?.clear()
      return
    }
    if (typeof window === 'undefined' || !window.orca?.plugin?.request) return
    const connId = this.activeConnectionId
    const tableName = this.activeTable
    const targetSchema = this.activeSchema
    const targetKey = `${connId}:${targetSchema || ''}:${tableName}`
    if (!force && this.lastInspectorLoadedKey === targetKey) return

    const cached = !force ? this.tableDetailsCache.get(targetKey) : undefined
    if (cached) {
      if (!this.isShowingSqlResult) {
        this.dataGrid?.setForeignKeys(cached.foreignKeys || [])
      }
      const driver = this.getActiveConnection()?.driver || 'sqlite'
      this.schemaInspector?.setReadOnly(Boolean(this.isActiveConnectionReadOnly()))
      this.schemaInspector?.setReferenceTables(
        this.schemaObjects.filter((o) => o.kind === 'table').map((t) => t.name)
      )
      this.schemaInspector?.setDetails(cached, driver)
      this.lastInspectorLoadedKey = targetKey
      return
    }

    const schemaToken = ++this.schemaLoadToken
    this.schemaInspector?.setLoading(true, tableName)
    try {
      const details = await this.fetchTableDetailsDeduped(connId, tableName, targetSchema, force)
      if (
        schemaToken !== this.schemaLoadToken ||
        this.activeConnectionId !== connId ||
        this.activeTable !== tableName
      ) {
        return
      }
      if (!this.isShowingSqlResult) {
        this.dataGrid?.setForeignKeys(details.foreignKeys || [])
      }
      const driver = this.getActiveConnection()?.driver || 'sqlite'
      this.schemaInspector?.setReadOnly(Boolean(this.isActiveConnectionReadOnly()))
      this.schemaInspector?.setReferenceTables(
        this.schemaObjects.filter((o) => o.kind === 'table').map((t) => t.name)
      )
      this.schemaInspector?.setDetails(details, driver)
      this.lastInspectorLoadedKey = targetKey
    } catch (err: unknown) {
      if (
        schemaToken !== this.schemaLoadToken ||
        this.activeConnectionId !== connId ||
        this.activeTable !== tableName
      ) {
        return
      }
      const msg = err instanceof Error ? err.message : String(err)
      this.schemaInspector?.setError(msg, () => {
        void this.loadActiveTableSchema(true)
      })
    }
  }

  private setQueryRunningState(queryId: string | null): void {
    this.activeQueryId = queryId
    if (this.cancelQueryBtn) {
      if (queryId) {
        this.cancelQueryBtn.style.display = 'inline-flex'
        if (!this.isCancellingQuery) {
          this.cancelQueryBtn.disabled = false
        }
      } else if (!this.isCancellingQuery) {
        setButtonLoading(this.cancelQueryBtn, false)
        this.cancelQueryBtn.style.display = 'none'
      }
    }
  }

  public formatSqlInConsole(): void {
    if (!this.sqlConsole) return
    const raw = this.sqlConsole.getText()
    if (!raw.trim()) {
      this.updateStatus('No SQL text to format')
      return
    }
    const driver = this.getActiveConnection()?.driver || 'sqlite'
    const formatted = formatSql(raw, driver)
    if (formatted !== raw) {
      this.sqlConsole.setText(formatted)
    }
    this.updateStatus('Formatted SQL')
  }

  public async executeSql(executeAll = false): Promise<void> {
    if (
      !this.sqlConsole ||
      (this.activeQueryId !== null && !this.cancelledQueryIds.has(this.activeQueryId))
    ) {
      return
    }
    const driver = this.getActiveConnection()?.driver || 'sqlite'
    const sqlText = executeAll
      ? this.sqlConsole.getText().trim()
      : this.sqlConsole.getCaretStatementSql(driver)
    if (!sqlText) {
      this.updateStatus('No query text to execute')
      return
    }

    if (!this.activeConnectionId) {
      this.updateStatus('Please select an active connection first')
      return
    }

    if (typeof window === 'undefined' || !window.orca?.plugin?.request) {
      this.updateStatus('No runtime environment available')
      return
    }

    const seq = ++this.querySeq
    const viewSeq = ++this.gridViewSeq
    this.tableLoadToken++
    this.isTableLoading = false
    const targetConnId = this.activeConnectionId
    this.hideQueryBanner()
    this.updateStatus('Running 0.0s...')
    const queryId = `query_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    this.setQueryRunningState(queryId)

    const activeBtn = executeAll ? this.runAllBtn : this.runBtn
    setButtonLoading(this.runBtn, false)
    setButtonLoading(this.runAllBtn, false)
    setButtonLoading(this.explainBtn, false)
    if (this.runBtn) this.runBtn.disabled = true
    if (this.runAllBtn) this.runAllBtn.disabled = true
    if (this.explainBtn) this.explainBtn.disabled = true
    setButtonLoading(activeBtn, true, 'Running 0.0s...')
    this.dataGrid?.setLoading(true, 'Executing query...')

    const stopTimer = this.createElapsedTimer((elapsedText) => {
      if (seq !== this.querySeq || this.activeConnectionId !== targetConnId) return
      setButtonLoading(activeBtn, true, `Running ${elapsedText}...`)
      this.updateStatus(`Running ${elapsedText}...`)
    })

    try {
      const startTime = performance.now()
      const res = await this.requestPlugin<QueryResult>(
        'query.run',
        {
          connectionId: targetConnId,
          queryId,
          sql: sqlText,
        },
        { timeoutMs: DEFAULT_RPC_TIMEOUT_MS }
      )
      if (
        seq !== this.querySeq ||
        viewSeq !== this.gridViewSeq ||
        this.activeConnectionId !== targetConnId
      ) {
        return
      }

      const elapsed = Math.round(performance.now() - startTime)
      const queriedTable = extractQueriedTableName(sqlText)
      if (queriedTable) {
        const matchedObj = this.schemaObjects.find(
          (o) => o.name.toLowerCase() === queriedTable.toLowerCase()
        )
        if (matchedObj && !this.isObjectActive(matchedObj.name, matchedObj.schema)) {
          this.activeTable = matchedObj.name
          this.activeSchema = matchedObj.schema || this.activeSchema
          this.renderSidebarObjects()
          this.sqlConsole?.updateSchema(this.schemaMap, matchedObj.name)
        }
      }

      this.isShowingSqlResult = true
      this.currentCanEdit = false
      this.closeValueInspector()
      const contextTable = queriedTable || this.activeTable || 'query_result'
      this.dataGrid?.setContextMeta(
        contextTable,
        this.getActiveConnection()?.driver || 'sqlite',
        targetConnId,
        this.activeSchema || ''
      )
      this.dataGrid?.setForeignKeys([])
      const emptyMsg = res.isSelect
        ? queriedTable
          ? `Query on "${queriedTable}" returned no rows.`
          : 'Query returned no rows.'
        : `Statement executed successfully (${res.affectedRows ?? 0} affected rows).`
      this.dataGrid?.setEmptyMessage(emptyMsg)
      this.dataGrid?.setData(res)
      this.updateStagedActionButtons(0)

      const rowCount = res.rowCount ?? (res.rows ? res.rows.length : 0)
      const durationMs = res.executionTimeMs || elapsed
      this.currentPage = 1
      this.totalRows = rowCount
      this.currentPageRowCount = res.rows ? res.rows.length : 0
      this.updatePaginationButtons()
      this.updateExportDropdownOptions()
      if (this.gridSubbarTitleEl) {
        const tblLabel = queriedTable ? ` (${queriedTable})` : ''
        this.gridSubbarTitleEl.textContent = res.isSelect
          ? `SQL Result${tblLabel} · ${res.columns?.length ?? 0} cols`
          : `Executed · ${res.affectedRows ?? 0} affected`
      }
      if (this.gridPageInfoEl) {
        this.gridPageInfoEl.textContent = res.truncated
          ? `${rowCount} rows (truncated)`
          : `${rowCount} rows`
      }

      const compactSql = sqlText.replace(/\s+/g, ' ').trim()
      const sqlPreview = compactSql.length > 96 ? `${compactSql.slice(0, 93)}...` : compactSql
      if (res.isSelect) {
        const truncNote = res.truncated ? ' (truncated)' : ''
        this.showQueryBanner(
          'success',
          `Query OK · ${rowCount} rows returned in ${durationMs}ms${truncNote}`,
          sqlPreview
        )
      } else {
        this.showQueryBanner(
          'success',
          `Statement executed · ${res.affectedRows ?? 0} rows affected in ${durationMs}ms`,
          sqlPreview
        )
      }

      this.updateStatus(
        `Query executed in ${durationMs}ms`,
        res.truncated ? `${rowCount} rows (truncated)` : `${rowCount} rows`
      )
      if (containsDdlStatement(sqlText) && this.activeConnectionId === targetConnId) {
        void this.refreshSchemaObjectsOnly(targetConnId)
      }
      if (this.isHistoryOpen) {
        void this.loadQueryHistory()
      }
    } catch (err: unknown) {
      if (
        seq !== this.querySeq ||
        viewSeq !== this.gridViewSeq ||
        this.activeConnectionId !== targetConnId
      ) {
        return
      }
      const msg = err instanceof Error ? err.message : String(err)
      this.isShowingSqlResult = true
      this.currentCanEdit = false
      this.currentPageRowCount = 0
      this.closeValueInspector()
      this.showQueryBanner('error', 'SQL Execution Error', msg, { showBackToTable: true })
      this.dataGrid?.setEmptyMessage(`Query error: ${msg}`)
      this.dataGrid?.setData({
        columns: [],
        rows: [],
        rowCount: 0,
        executionTimeMs: 0,
        truncated: false,
        isSelect: true,
      })
      this.updateStagedActionButtons(0)
      this.updatePaginationButtons()
      this.updateExportDropdownOptions()
      if (this.gridSubbarTitleEl) {
        this.gridSubbarTitleEl.textContent = 'SQL Error'
      }
      if (this.gridPageInfoEl) {
        this.gridPageInfoEl.textContent = '0 rows'
      }
      this.updateStatus(`Query error: ${msg}`, '0 rows')
      if (this.isHistoryOpen) {
        void this.loadQueryHistory()
      }
    } finally {
      stopTimer()
      this.cancelledQueryIds.delete(queryId)
      if (seq === this.querySeq) {
        setButtonLoading(this.runBtn, false)
        setButtonLoading(this.runAllBtn, false)
        setButtonLoading(this.explainBtn, false)
        this.setQueryRunningState(null)
      }
    }
  }

  public async explainSql(): Promise<void> {
    if (
      !this.sqlConsole ||
      (this.activeQueryId !== null && !this.cancelledQueryIds.has(this.activeQueryId))
    ) {
      return
    }
    const driver = this.getActiveConnection()?.driver || 'sqlite'
    const sqlText =
      this.sqlConsole.getCaretStatementSql(driver) || this.sqlConsole.getExecutableSql()
    if (!sqlText) {
      this.updateStatus('No SQL statement to explain')
      return
    }
    if (!this.activeConnectionId) {
      this.updateStatus('Please select an active connection first')
      return
    }
    if (typeof window === 'undefined' || !window.orca?.plugin?.request) return

    const seq = ++this.querySeq
    const viewSeq = ++this.gridViewSeq
    this.tableLoadToken++
    this.isTableLoading = false
    const targetConnId = this.activeConnectionId
    const queryId = `explain_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    this.hideQueryBanner()
    this.updateStatus('Running EXPLAIN 0.0s...')
    this.setQueryRunningState(queryId)

    setButtonLoading(this.runBtn, false)
    setButtonLoading(this.runAllBtn, false)
    setButtonLoading(this.explainBtn, false)
    if (this.runBtn) this.runBtn.disabled = true
    if (this.runAllBtn) this.runAllBtn.disabled = true
    setButtonLoading(this.explainBtn, true, 'Explaining 0.0s...')
    this.dataGrid?.setLoading(true, 'Running EXPLAIN...')

    const stopTimer = this.createElapsedTimer((elapsedText) => {
      if (seq !== this.querySeq || this.activeConnectionId !== targetConnId) return
      setButtonLoading(this.explainBtn, true, `Explaining ${elapsedText}...`)
      this.updateStatus(`Running EXPLAIN ${elapsedText}...`)
    })

    try {
      const res = await this.requestPlugin<QueryResult>(
        'query.explain',
        {
          connectionId: targetConnId,
          queryId,
          sql: sqlText,
        },
        { timeoutMs: DEFAULT_RPC_TIMEOUT_MS }
      )
      if (
        seq !== this.querySeq ||
        viewSeq !== this.gridViewSeq ||
        this.activeConnectionId !== targetConnId
      ) {
        return
      }
      this.isShowingSqlResult = true
      this.currentCanEdit = false
      this.closeValueInspector()
      this.dataGrid?.setForeignKeys([])
      this.dataGrid?.setEmptyMessage('No execution plan rows returned.')
      this.dataGrid?.setData(res)
      this.updateStagedActionButtons(0)
      const rowCount = res.rowCount ?? res.rows.length
      this.currentPageRowCount = res.rows.length
      this.totalRows = rowCount
      this.updatePaginationButtons()
      this.updateExportDropdownOptions()
      if (this.gridSubbarTitleEl) {
        this.gridSubbarTitleEl.textContent = `Execution Plan · ${rowCount} steps`
      }
      if (this.gridPageInfoEl) {
        this.gridPageInfoEl.textContent = `${rowCount} rows`
      }
      this.showQueryBanner(
        'success',
        `EXPLAIN OK · ${rowCount} plan steps in ${res.executionTimeMs}ms`
      )
      this.updateStatus(`EXPLAIN completed in ${res.executionTimeMs}ms`, `${rowCount} rows`)
    } catch (err: unknown) {
      if (
        seq !== this.querySeq ||
        viewSeq !== this.gridViewSeq ||
        this.activeConnectionId !== targetConnId
      ) {
        return
      }
      const msg = err instanceof Error ? err.message : String(err)
      this.isShowingSqlResult = true
      this.currentCanEdit = false
      this.currentPageRowCount = 0
      this.showQueryBanner('error', 'EXPLAIN Error', msg, { showBackToTable: true })
      this.dataGrid?.setEmptyMessage(`EXPLAIN error: ${msg}`)
      this.dataGrid?.setData({
        columns: [],
        rows: [],
        rowCount: 0,
        executionTimeMs: 0,
        truncated: false,
        isSelect: true,
      })
      this.updatePaginationButtons()
      this.updateExportDropdownOptions()
      this.updateStatus(`EXPLAIN error: ${msg}`)
    } finally {
      stopTimer()
      this.cancelledQueryIds.delete(queryId)
      if (seq === this.querySeq) {
        setButtonLoading(this.runBtn, false)
        setButtonLoading(this.runAllBtn, false)
        setButtonLoading(this.explainBtn, false)
        this.setQueryRunningState(null)
      }
    }
  }

  private async cancelActiveQuery(): Promise<void> {
    if (
      !this.activeQueryId ||
      this.isCancellingQuery ||
      typeof window === 'undefined' ||
      !window.orca?.plugin?.request
    ) {
      return
    }
    const qid = this.activeQueryId
    this.isCancellingQuery = true
    setButtonLoading(this.cancelQueryBtn, true, 'Cancelling...')
    this.updateStatus('Cancelling query...')
    let cancelAccepted = false
    try {
      const res = await this.requestPlugin<{ ok: boolean }>('query.cancel', { queryId: qid })
      cancelAccepted = res?.ok !== false
      if (cancelAccepted) {
        this.cancelledQueryIds.add(qid)
        this.updateStatus('Query cancelled')
      } else {
        this.updateStatus('Cancel request was not acknowledged')
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      this.updateStatus(`Cancel failed: ${msg}`)
    } finally {
      this.isCancellingQuery = false
      setButtonLoading(this.cancelQueryBtn, false)
      // Do NOT clear this.activeQueryId here — let executeSql/explainSql's finally unwind cleanly
      if (this.cancelQueryBtn && (!this.activeQueryId || (cancelAccepted && this.activeQueryId === qid))) {
        this.cancelQueryBtn.style.display = 'none'
      }
    }
  }

  private async toggleQueryHistory(): Promise<void> {
    this.isHistoryOpen = !this.isHistoryOpen
    this.historyBtn?.classList.toggle('active', this.isHistoryOpen)
    if (!this.historyDrawerEl) return
    this.historyDrawerEl.style.display = this.isHistoryOpen ? 'flex' : 'none'
    if (this.isHistoryOpen) {
      await this.loadQueryHistory()
    }
  }

  private renderQueryHistoryList(): void {
    if (!this.historyListEl) return
    this.historyListEl.innerHTML = ''
    const q = this.historySearchQuery
    const entries = q
      ? this.cachedHistoryEntries.filter(
          (e) =>
            e.sql.toLowerCase().includes(q) ||
            (e.connectionName || '').toLowerCase().includes(q)
        )
      : this.cachedHistoryEntries

    if (entries.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'datanoa-cell-null'
      empty.style.padding = '10px 12px'
      empty.textContent = q
        ? `No query history matches "${q}".`
        : 'No executed queries in history yet.'
      this.historyListEl.appendChild(empty)
      return
    }

    for (const entry of entries) {
      const row = document.createElement('div')
      row.className = 'datanoa-history-row'

      const sqlSpan = document.createElement('span')
      sqlSpan.className = 'datanoa-history-sql'
      sqlSpan.textContent = entry.sql.replace(/\s+/g, ' ').trim()
      sqlSpan.title = entry.sql
      sqlSpan.style.cursor = 'pointer'
      sqlSpan.addEventListener('click', () => {
        this.sqlConsole?.setText(entry.sql)
        this.sqlConsole?.focus()
      })

      const relTime = formatRelativeTimestamp(entry.timestamp)
      const metaSpan = document.createElement('span')
      metaSpan.className = 'datanoa-history-meta'
      const baseMeta = entry.isError
        ? `${entry.connectionName} · ERROR`
        : `${entry.connectionName} · ${entry.durationMs}ms · ${entry.rowCount} rows`
      metaSpan.textContent = relTime ? `${baseMeta} · ${relTime}` : baseMeta

      const actions = document.createElement('div')
      actions.className = 'datanoa-btn-group'

      const insertBtn = document.createElement('button')
      insertBtn.type = 'button'
      insertBtn.className = 'datanoa-btn datanoa-btn-sm'
      insertBtn.textContent = 'Insert'
      insertBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        this.sqlConsole?.insertText(entry.sql)
        this.sqlConsole?.focus()
        this.updateStatus('Inserted history query into SQL Console')
      })

      const copyBtn = document.createElement('button')
      copyBtn.type = 'button'
      copyBtn.className = 'datanoa-btn datanoa-btn-sm'
      copyBtn.textContent = 'Copy'
      copyBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        copyTextFallback(entry.sql, copyBtn)
        this.updateStatus('Copied history SQL to clipboard')
      })

      actions.appendChild(insertBtn)
      actions.appendChild(copyBtn)

      row.appendChild(sqlSpan)
      row.appendChild(metaSpan)
      row.appendChild(actions)
      this.historyListEl.appendChild(row)
    }
  }

  private async loadQueryHistory(): Promise<void> {
    if (!this.historyListEl || typeof window === 'undefined' || !window.orca?.plugin?.request) return
    const seq = ++this.historySeq
    this.historyListEl.innerHTML = ''
    const loadingEl = document.createElement('div')
    loadingEl.className = 'datanoa-cell-null'
    loadingEl.style.padding = '10px 12px'
    loadingEl.style.display = 'flex'
    loadingEl.style.alignItems = 'center'
    loadingEl.style.gap = '6px'
    const spinner = document.createElement('span')
    spinner.className = 'datanoa-spinner'
    spinner.setAttribute('aria-hidden', 'true')
    const txt = document.createElement('span')
    txt.textContent = 'Loading query history...'
    loadingEl.appendChild(spinner)
    loadingEl.appendChild(txt)
    this.historyListEl.appendChild(loadingEl)

    try {
      const res = await this.requestPlugin<{ entries: QueryHistoryEntry[] }>('query.history.list', {
        limit: 50,
      })
      if (seq !== this.historySeq) return
      this.cachedHistoryEntries = res?.entries || []
      this.renderQueryHistoryList()
    } catch (err: unknown) {
      if (seq !== this.historySeq) return
      const msg = err instanceof Error ? err.message : String(err)
      if (this.historyListEl) {
        this.historyListEl.innerHTML = ''
        const errEl = document.createElement('div')
        errEl.style.padding = '10px 12px'
        errEl.style.color = 'var(--danger)'
        errEl.textContent = `Failed to load query history: ${msg}`
        this.historyListEl.appendChild(errEl)
      }
    }
  }

  private async clearQueryHistory(): Promise<void> {
    if (
      this.isClearingHistory ||
      typeof window === 'undefined' ||
      !window.orca?.plugin?.request
    ) {
      return
    }
    this.historySeq++
    this.isClearingHistory = true
    setButtonLoading(this.clearHistoryBtn, true, 'Clearing...')
    try {
      await this.requestPlugin<{ ok: boolean }>('query.history.clear')
      this.cachedHistoryEntries = []
      await this.loadQueryHistory()
      this.updateStatus('Query history cleared')
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      this.updateStatus(`Clear history failed: ${msg}`)
    } finally {
      this.isClearingHistory = false
      setButtonLoading(this.clearHistoryBtn, false)
    }
  }

  private async previewStagedChanges(): Promise<void> {
    if (
      this.isPreviewingDml ||
      !this.dataGrid ||
      !this.activeConnectionId ||
      !this.activeTable ||
      !this.dmlPreviewEl ||
      !this.dmlPreviewPreEl
    ) {
      return
    }
    const payload = this.dataGrid.getChangesPayload()
    if (payload.inserts.length === 0 && payload.updates.length === 0 && payload.deletes.length === 0) {
      this.updateStatus('No staged changes to preview')
      return
    }
    const seq = ++this.dmlPreviewSeq
    const targetConnId = this.activeConnectionId
    const targetTable = this.activeTable
    const targetSchema = this.activeSchema
    this.isPreviewingDml = true
    setButtonLoading(this.dmlPreviewBtn, true, 'Previewing...')
    try {
      const res = await this.requestPlugin<{ statements: string[] }>('data.previewChanges', {
        connectionId: targetConnId,
        table: targetTable,
        ...(targetSchema ? { schema: targetSchema } : {}),
        inserts: payload.inserts,
        updates: payload.updates,
        deletes: payload.deletes,
      })
      if (
        seq !== this.dmlPreviewSeq ||
        this.activeConnectionId !== targetConnId ||
        this.activeTable !== targetTable ||
        (this.activeSchema || '') !== (targetSchema || '')
      ) {
        return
      }
      const statements = res?.statements || []
      this.dmlPreviewPreEl.textContent = statements.join('\n') || '-- No SQL statements generated'
      this.dmlPreviewEl.style.display = 'block'
    } catch (err: unknown) {
      if (
        seq !== this.dmlPreviewSeq ||
        this.activeConnectionId !== targetConnId ||
        this.activeTable !== targetTable
      ) {
        return
      }
      const msg = err instanceof Error ? err.message : String(err)
      this.showQueryBanner('error', 'DML Preview Failed', msg)
      this.updateStatus(`Preview error: ${msg}`)
    } finally {
      this.isPreviewingDml = false
      setButtonLoading(this.dmlPreviewBtn, false)
      this.updateStagedActionButtons(this.dataGrid?.getStagedCount() ?? 0)
    }
  }

  private async submitStagedChanges(): Promise<void> {
    if (this.isSubmittingChanges || !this.dataGrid || !this.activeConnectionId || !this.activeTable) return
    if (this.isActiveConnectionReadOnly()) {
      this.updateStatus('Cannot submit changes on a Read-Only connection')
      return
    }
    const payload = this.dataGrid.getChangesPayload()
    const total = payload.inserts.length + payload.updates.length + payload.deletes.length
    if (total === 0) return

    const targetConnId = this.activeConnectionId
    const targetTable = this.activeTable
    const targetSchema = this.activeSchema
    const targetPage = this.currentPage
    const submitViewSeq = this.gridViewSeq

    this.isSubmittingChanges = true
    this.dataGrid.setInteractionLocked(true)
    if (this.revertBtn) this.revertBtn.disabled = true
    if (this.addRowBtn) this.addRowBtn.disabled = true
    if (this.cloneRowBtn) this.cloneRowBtn.disabled = true
    if (this.delRowBtn) this.delRowBtn.disabled = true
    if (this.dmlPreviewBtn) this.dmlPreviewBtn.disabled = true
    setButtonLoading(this.submitBtn, true, 'Submitting...')
    setButtonLoading(this.dmlApplyBtn, true, 'Submitting...')
    this.updateStatus(`Submitting ${total} staged change(s)...`)

    const stopTimer = this.createElapsedTimer((elapsedText) => {
      setButtonLoading(this.submitBtn, true, `Submitting ${elapsedText}...`)
    })

    try {
      const res = await this.requestPlugin<{
        ok: boolean
        inserted: number
        updated: number
        deleted: number
        statements: string[]
      }>(
        'data.applyChanges',
        {
          connectionId: targetConnId,
          table: targetTable,
          ...(targetSchema ? { schema: targetSchema } : {}),
          inserts: payload.inserts,
          updates: payload.updates,
          deletes: payload.deletes,
        },
        { timeoutMs: DEFAULT_RPC_TIMEOUT_MS }
      )
      const stillSameTarget =
        this.activeConnectionId === targetConnId &&
        this.activeTable === targetTable &&
        (this.activeSchema || '') === (targetSchema || '') &&
        this.gridViewSeq === submitViewSeq
      if (!stillSameTarget) {
        return
      }
      if (res?.ok) {
        if (this.dmlPreviewEl) this.dmlPreviewEl.style.display = 'none'
        this.updateStatus(
          `Committed +${res.inserted} inserted, ~${res.updated} updated, -${res.deleted} deleted`
        )
        await this.loadTableData(targetConnId, targetTable, targetPage)
      } else {
        this.showQueryBanner('error', 'Submit Changes Rejected', 'The database rejected one or more staged edits.')
        this.updateStatus('Submit changes rejected')
      }
    } catch (err: unknown) {
      if (
        this.activeConnectionId !== targetConnId ||
        this.activeTable !== targetTable ||
        this.gridViewSeq !== submitViewSeq
      ) {
        return
      }
      const msg = err instanceof Error ? err.message : String(err)
      this.showQueryBanner('error', 'Submit Changes Failed', msg)
      this.updateStatus(`Submit failed: ${msg}`)
    } finally {
      stopTimer()
      this.isSubmittingChanges = false
      this.dataGrid?.setInteractionLocked(false)
      setButtonLoading(this.submitBtn, false)
      setButtonLoading(this.dmlApplyBtn, false)
      this.updateStagedActionButtons(this.dataGrid?.getStagedCount() ?? 0)
    }
  }

  private updateExportDropdownOptions(): void {
    if (!this.exportSelectEl) return
    const sel = this.exportSelectEl
    sel.innerHTML = ''

    const placeholder = document.createElement('option')
    placeholder.value = ''
    placeholder.textContent = 'Export...'
    sel.appendChild(placeholder)

    const pageScopeLabel = this.isShowingSqlResult
      ? `Copy SQL Result (${this.currentPageRowCount} rows)`
      : `Copy Current Page (${this.currentPageRowCount} / ${this.totalRows} rows)`

    const addGroup = (
      label: string,
      items: ReadonlyArray<{ value: string; label: string }>
    ) => {
      const group = document.createElement('optgroup')
      group.label = label
      for (const optDef of items) {
        const opt = document.createElement('option')
        opt.value = optDef.value
        opt.textContent = optDef.label
        group.appendChild(opt)
      }
      sel.appendChild(group)
    }

    addGroup(pageScopeLabel, [
      { value: 'sql-insert', label: 'Copy SQL INSERT' },
      { value: 'sql-update', label: 'Copy SQL UPDATE' },
      { value: 'json', label: 'Copy JSON' },
      { value: 'ndjson', label: 'Copy NDJSON' },
      { value: 'csv', label: 'Copy CSV' },
      { value: 'tsv', label: 'Copy TSV' },
      { value: 'markdown', label: 'Copy Markdown' },
    ])

    addGroup('Download File (Current Page)', [
      { value: 'download:csv', label: 'Download .csv' },
      { value: 'download:json', label: 'Download .json' },
      { value: 'download:sql-insert', label: 'Download .sql (INSERT)' },
      { value: 'download:markdown', label: 'Download .md' },
    ])

    const summary = this.lastSelectionSummary
    if (summary && summary.cellCount > 1) {
      addGroup(`Export Selected (${summary.rowCount}×${summary.colCount} · ${summary.cellCount} cells)`, [
        { value: 'sel-copy:tsv', label: 'Copy Selected TSV' },
        { value: 'sel-copy:tsv-headers', label: 'Copy Selected TSV + Headers' },
        { value: 'sel-copy:csv', label: 'Copy Selected CSV' },
        { value: 'sel-copy:json', label: 'Copy Selected JSON' },
        { value: 'sel-copy:sql-in', label: 'Copy Selected SQL IN (...)' },
        { value: 'sel-copy:sql-insert', label: 'Copy Selected SQL INSERT' },
        { value: 'sel-download:csv', label: 'Download Selected .csv' },
        { value: 'sel-download:json', label: 'Download Selected .json' },
        { value: 'sel-download:sql-insert', label: 'Download Selected .sql' },
      ])
    }
  }

  private getExportFileMeta(
    format: string,
    tableName: string
  ): { filename: string; mimeType: string } {
    const safeName = tableName.replace(/[^A-Za-z0-9_-]/g, '_') || 'export'
    if (format === 'csv') return { filename: `${safeName}.csv`, mimeType: 'text/csv;charset=utf-8' }
    if (format === 'json')
      return { filename: `${safeName}.json`, mimeType: 'application/json;charset=utf-8' }
    if (format === 'markdown')
      return { filename: `${safeName}.md`, mimeType: 'text/markdown;charset=utf-8' }
    return { filename: `${safeName}.sql`, mimeType: 'text/sql;charset=utf-8' }
  }

  private handleExportAction(actionValue: string): void {
    if (!this.dataGrid || !actionValue) return
    const driver = this.getActiveConnection()?.driver || 'sqlite'
    const tableName = this.activeTable || 'query_result'

    if (actionValue.startsWith('sel-copy:') || actionValue.startsWith('sel-download:')) {
      const isDownload = actionValue.startsWith('sel-download:')
      const rawFmt = actionValue.slice(isDownload ? 'sel-download:'.length : 'sel-copy:'.length)
      if (
        rawFmt !== 'tsv' &&
        rawFmt !== 'tsv-headers' &&
        rawFmt !== 'csv' &&
        rawFmt !== 'json' &&
        rawFmt !== 'sql-in' &&
        rawFmt !== 'sql-insert'
      ) {
        return
      }
      const output = this.dataGrid.exportSelection(rawFmt)
      if (!output) {
        this.updateStatus('No selected cells to export')
        return
      }
      if (isDownload) {
        const meta = this.getExportFileMeta(rawFmt, `${tableName}_selected`)
        downloadTextFile(output, meta.filename, meta.mimeType)
        this.updateStatus(`Downloaded selected data as ${meta.filename}`)
      } else {
        copyTextFallback(output)
        this.updateStatus(`Copied selected cells as ${rawFmt.toUpperCase()}`)
      }
      return
    }

    const isDownload = actionValue.startsWith('download:')
    const rawFmt = actionValue.startsWith('copy:')
      ? actionValue.slice('copy:'.length)
      : isDownload
        ? actionValue.slice('download:'.length)
        : actionValue

    if (
      rawFmt !== 'sql-insert' &&
      rawFmt !== 'sql-update' &&
      rawFmt !== 'json' &&
      rawFmt !== 'ndjson' &&
      rawFmt !== 'csv' &&
      rawFmt !== 'tsv' &&
      rawFmt !== 'markdown'
    ) {
      return
    }

    if (isDownload) {
      const output = this.dataGrid.exportData(rawFmt, tableName, driver)
      if (!output) {
        this.updateStatus('No rows available to download')
        return
      }
      const meta = this.getExportFileMeta(rawFmt, tableName)
      downloadTextFile(output, meta.filename, meta.mimeType)
      this.updateStatus(`Downloaded ${meta.filename}`)
      return
    }

    this.handleExportFormat(rawFmt)
  }

  private handleExportFormat(format: ExportFormat): void {
    if (!this.dataGrid) return
    const driver = this.getActiveConnection()?.driver || 'sqlite'
    const tableName = this.activeTable || 'query_result'
    const output = this.dataGrid.exportData(format, tableName, driver)
    if (!output) {
      this.updateStatus('No rows available to export')
      return
    }
    copyTextFallback(output)
    this.updateStatus(`Exported as ${format.toUpperCase()} (copied to clipboard)`)
  }

  private handleGridSelectionSummary(summary: SelectionSummary): void {
    const prev = this.lastSelectionSummary
    const prevMulti = Boolean(prev && prev.cellCount > 1)
    this.lastSelectionSummary = summary
    const nextMulti = summary.cellCount > 1
    if (
      prevMulti !== nextMulti ||
      (nextMulti &&
        (prev?.rowCount !== summary.rowCount ||
          prev?.colCount !== summary.colCount ||
          prev?.cellCount !== summary.cellCount))
    ) {
      this.updateExportDropdownOptions()
    }
    if (this.delRowBtn) {
      this.delRowBtn.textContent = summary.rowCount > 1 ? `− ${summary.rowCount} Rows` : '− Row'
    }
    if (this.cloneRowBtn) {
      this.cloneRowBtn.textContent = summary.rowCount > 1 ? `Clone (${summary.rowCount})` : 'Clone'
    }
    this.updateSelectionStatusDisplay(summary)
  }

  private updateSelectionStatusDisplay(summary: SelectionSummary | null): void {
    if (!this.statusSelectionEl) return
    if (!summary || summary.cellCount === 0) {
      this.statusSelectionEl.style.display = 'none'
      this.statusSelectionEl.textContent = ''
      if (this.shortcutHintEl) this.shortcutHintEl.style.display = ''
      if (this.statusMetricsEl) this.statusMetricsEl.style.marginLeft = ''
      return
    }
    const rowWord = summary.rowCount === 1 ? 'row' : 'rows'
    const colWord = summary.colCount === 1 ? 'col' : 'cols'
    const cellWord = summary.cellCount === 1 ? 'cell' : 'cells'
    const parts: string[] = [
      `Selected: ${summary.rowCount} ${rowWord} × ${summary.colCount} ${colWord} (${summary.cellCount} ${cellWord})`,
      `Non-null: ${summary.nonNullCount}`,
    ]
    if (
      summary.numericCount > 0 &&
      summary.sum !== null &&
      summary.avg !== null &&
      summary.min !== null &&
      summary.max !== null
    ) {
      parts.push(`Sum: ${formatAggregateNumber(summary.sum)}`)
      parts.push(`Avg: ${formatAggregateNumber(summary.avg)}`)
      parts.push(`Min: ${formatAggregateNumber(summary.min)}`)
      parts.push(`Max: ${formatAggregateNumber(summary.max)}`)
    }
    if (summary.isTruncatedScan) {
      parts.push('first 50k')
    }
    this.statusSelectionEl.textContent = parts.join(' · ')
    this.statusSelectionEl.style.display = 'inline-flex'
    if (this.shortcutHintEl) this.shortcutHintEl.style.display = 'none'
    if (this.statusMetricsEl) this.statusMetricsEl.style.marginLeft = 'auto'
  }

  private setGridSearchMode(mode: 'filter' | 'find'): void {
    this.cancelClientSearchDebounce()
    this.searchMode = mode
    if (this.searchModeBtn) {
      this.searchModeBtn.textContent = mode === 'find' ? 'Mode: Find' : 'Mode: Filter'
      this.searchModeBtn.classList.toggle('active', mode === 'find')
    }
    if (this.clientSearchEl) {
      this.clientSearchEl.placeholder =
        mode === 'find' ? 'Find & highlight (Enter)...' : 'Search rows...'
    }
    const showFindControls = mode === 'find'
    if (this.findCountEl) this.findCountEl.style.display = showFindControls ? 'inline-flex' : 'none'
    if (this.findPrevBtn) this.findPrevBtn.style.display = showFindControls ? 'inline-flex' : 'none'
    if (this.findNextBtn) this.findNextBtn.style.display = showFindControls ? 'inline-flex' : 'none'
    this.applyClientSearchOrFind()
  }

  private updateFindCounter(state?: { total: number; activeIndex: number } | null): void {
    if (!this.findCountEl) return
    if (!state || state.total === 0) {
      this.findCountEl.textContent = '0 / 0'
      return
    }
    this.findCountEl.textContent = `${state.activeIndex + 1} / ${state.total}`
  }

  private applyClientSearchOrFind(): void {
    const val = this.clientSearchEl?.value || ''
    if (this.searchMode === 'find') {
      this.dataGrid?.setClientFilter('')
      const state = this.dataGrid?.setFindQuery(val)
      this.updateFindCounter(state)
    } else {
      this.dataGrid?.setFindQuery('')
      this.dataGrid?.setClientFilter(val)
      this.saveStudioViewState(false)
    }
  }

  private async handleQuickFilter(
    predicateSql: string,
    mode: 'replace' | 'and'
  ): Promise<void> {
    if (!predicateSql.trim()) return
    if (this.isShowingSqlResult) {
      const parsed = parseClientQuickFilterPredicate(predicateSql)
      if (parsed) {
        if (mode === 'replace') {
          this.dataGrid?.clearClientColumnFilters()
        }
        this.dataGrid?.addClientColumnFilter(parsed.column, parsed.value, parsed.op)
        this.updateStatus(`Filtered SQL result: ${predicateSql}`)
      }
      return
    }
    if (!this.whereInputEl) return
    const existing = this.whereInputEl.value.trim()
    this.whereInputEl.value =
      mode === 'and' && existing ? `(${existing}) AND (${predicateSql})` : predicateSql
    await this.applyServerFilters()
  }

  private async handleNavigateForeignKey(
    refTable: string,
    refColumn: string,
    value: unknown
  ): Promise<void> {
    if (!this.activeConnectionId || !refTable) return
    const cleanRef = refTable.trim()
    let targetSchema: string | undefined
    let targetTableName = cleanRef
    if (cleanRef.includes('.')) {
      const parts = cleanRef.split('.')
      targetSchema = parts[0]?.replace(/^["`[]|["`\]]$/g, '')
      targetTableName = (parts[parts.length - 1] || cleanRef).replace(/^["`[]|["`\]]$/g, '')
    } else {
      targetTableName = cleanRef.replace(/^["`[]|["`\]]$/g, '')
    }

    const matched = this.schemaObjects.find(
      (o) =>
        o.name.toLowerCase() === targetTableName.toLowerCase() &&
        (!targetSchema || (o.schema || '').toLowerCase() === targetSchema.toLowerCase())
    )
    const resolvedTable = matched ? matched.name : targetTableName
    const resolvedSchema = matched ? matched.schema : targetSchema

    const driver = this.getActiveConnection()?.driver || 'sqlite'
    const predicate = buildQuickFilterPredicate(
      refColumn,
      value,
      value === null || value === undefined ? 'is-null' : 'eq',
      driver
    )

    this.activeTable = resolvedTable
    this.activeSchema = resolvedSchema
    this.activeWhereClause = predicate
    this.activeOrderByClause = undefined
    this.currentPage = 1
    this.isShowingSqlResult = false
    if (this.whereInputEl) this.whereInputEl.value = predicate
    if (this.orderByInputEl) this.orderByInputEl.value = ''
    this.cancelClientSearchDebounce()
    if (this.clientSearchEl && this.clientSearchEl.value) {
      this.clientSearchEl.value = ''
    }
    this.dataGrid?.setClientFilter('')
    this.dataGrid?.setFindQuery('')
    this.updateFindCounter(null)
    this.dataGrid?.clearSortIndicator()
    this.updateSelectedTableHighlight()
    this.sqlConsole?.updateSchema(this.schemaMap, resolvedTable)
    this.updateMetadataHeader('table', resolvedTable)
    if (resolvedSchema) {
      this.updateMetadataHeader('schema', resolvedSchema)
    }
    if (this.activeViewMode === 'inspector') {
      this.switchMode('split')
    }
    this.lastInspectorLoadedKey = ''
    await this.loadTableData(this.activeConnectionId, resolvedTable, 1)
    this.updateStatus(`FK Jump → ${resolvedTable} WHERE ${predicate}`)
  }

  private handleColumnConfigChanged(config: TableColumnConfig): void {
    if (this.isShowingSqlResult || !this.activeTable) return
    const key = this.getCurrentTableConfigKey()
    if (config.hidden.length === 0 && config.pinned.length === 0) {
      delete this.columnConfigByTable[key]
    } else {
      this.columnConfigByTable[key] = {
        hidden: [...config.hidden],
        pinned: [...config.pinned],
      }
    }
    this.saveStudioViewState()
  }

  private closeColumnsPopover(): void {
    if (this.colsPopoverOutsideCleanup) {
      this.colsPopoverOutsideCleanup()
      this.colsPopoverOutsideCleanup = null
    }
    if (this.colsPopoverEl) {
      this.colsPopoverEl.remove()
      this.colsPopoverEl = null
    }
    this.columnsBtn?.classList.remove('active')
  }

  private toggleColumnsPopover(): void {
    if (this.colsPopoverEl) {
      this.closeColumnsPopover()
      return
    }
    if (!this.dataGrid || !this.columnsBtn || typeof document === 'undefined' || !document.body) {
      return
    }

    const pop = document.createElement('div')
    pop.className = 'datanoa-cols-popover'

    const head = document.createElement('div')
    head.className = 'datanoa-cols-popover-head'

    const searchInp = document.createElement('input')
    searchInp.type = 'search'
    searchInp.className = 'datanoa-search-input'
    searchInp.placeholder = 'Filter columns...'
    searchInp.style.flex = '1'

    const showAllBtn = document.createElement('button')
    showAllBtn.type = 'button'
    showAllBtn.className = 'datanoa-btn datanoa-btn-sm'
    showAllBtn.textContent = 'Show All'

    head.appendChild(searchInp)
    head.appendChild(showAllBtn)

    const listEl = document.createElement('div')
    listEl.className = 'datanoa-cols-popover-list'

    const renderList = () => {
      if (!this.dataGrid) return
      const cfg = this.dataGrid.getColumnConfig()
      const hiddenSet = new Set(cfg.hidden)
      const pinnedSet = new Set(cfg.pinned)
      const q = searchInp.value.trim().toLowerCase()
      const cols = q
        ? cfg.allColumns.filter((c) => c.toLowerCase().includes(q))
        : cfg.allColumns

      listEl.innerHTML = ''
      if (cols.length === 0) {
        const empty = document.createElement('div')
        empty.className = 'datanoa-cell-null'
        empty.style.padding = '8px'
        empty.textContent = cfg.allColumns.length === 0 ? 'No columns loaded' : 'No matching columns'
        listEl.appendChild(empty)
        return
      }

      for (const colName of cols) {
        const row = document.createElement('div')
        row.className = 'datanoa-cols-popover-row'

        const label = document.createElement('label')
        label.style.display = 'inline-flex'
        label.style.alignItems = 'center'
        label.style.gap = '6px'
        label.style.flex = '1'
        label.style.minWidth = '0'
        label.style.cursor = 'pointer'

        const cb = document.createElement('input')
        cb.type = 'checkbox'
        cb.checked = !hiddenSet.has(colName)
        cb.addEventListener('change', () => {
          this.dataGrid?.setColumnVisibility(colName, cb.checked)
          renderList()
        })

        const nameSpan = document.createElement('span')
        nameSpan.textContent = colName
        nameSpan.style.overflow = 'hidden'
        nameSpan.style.textOverflow = 'ellipsis'
        nameSpan.style.whiteSpace = 'nowrap'

        label.appendChild(cb)
        label.appendChild(nameSpan)

        const pinBtn = document.createElement('button')
        pinBtn.type = 'button'
        const isPinned = pinnedSet.has(colName)
        pinBtn.className = `datanoa-btn datanoa-btn-sm${isPinned ? ' active' : ''}`
        pinBtn.textContent = isPinned ? 'Unpin' : 'Pin'
        pinBtn.addEventListener('click', () => {
          this.dataGrid?.togglePinColumn(colName)
          renderList()
        })

        row.appendChild(label)
        row.appendChild(pinBtn)
        listEl.appendChild(row)
      }
    }

    searchInp.addEventListener('input', renderList)
    showAllBtn.addEventListener('click', () => {
      this.dataGrid?.showAllColumns()
      renderList()
    })

    renderList()
    pop.appendChild(head)
    pop.appendChild(listEl)
    document.body.appendChild(pop)
    this.colsPopoverEl = pop
    this.columnsBtn.classList.add('active')

    if (typeof this.columnsBtn.getBoundingClientRect === 'function') {
      const rect = this.columnsBtn.getBoundingClientRect()
      const vw = typeof window !== 'undefined' ? window.innerWidth || 1024 : 1024
      const vh = typeof window !== 'undefined' ? window.innerHeight || 768 : 768
      const popRect = pop.getBoundingClientRect?.()
      const popWidth = Math.max(268, Math.round(popRect?.width || 268))
      const naturalH = Math.min(360, Math.round(popRect?.height || 300))
      const spaceBelow = Math.max(0, vh - rect.bottom - 12)
      const spaceAbove = Math.max(0, rect.top - 12)
      const openUpward = spaceBelow < naturalH && spaceAbove > spaceBelow
      const clampedMaxH = Math.max(120, Math.min(360, openUpward ? spaceAbove : spaceBelow))
      pop.style.maxHeight = `${clampedMaxH}px`
      const renderedH = Math.min(naturalH, clampedMaxH)
      const top = openUpward
        ? Math.max(8, Math.round(rect.top - renderedH - 4))
        : Math.max(8, Math.min(Math.round(rect.bottom + 4), vh - renderedH - 8))
      const left = Math.max(8, Math.min(Math.round(rect.left), vw - popWidth - 8))
      pop.style.top = `${top}px`
      pop.style.left = `${left}px`
    }

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      const onDocDown = (ev: MouseEvent) => {
        const target = ev.target instanceof Node ? ev.target : null
        if (target && (this.columnsBtn?.contains?.(target) || pop.contains?.(target))) return
        this.closeColumnsPopover()
      }
      window.addEventListener('mousedown', onDocDown, true)
      this.colsPopoverOutsideCleanup = () => {
        window.removeEventListener('mousedown', onDocDown, true)
      }
    }

    searchInp.focus?.()
  }

  private openValueInspector(info?: SelectedCellInfo): void {
    const target = info ?? this.selectedCell
    if (!target) return
    this.selectedCell = target
    this.isInspectorOpen = true
    if (this.inspectCellBtn) {
      this.inspectCellBtn.disabled = false
      this.inspectCellBtn.classList.add('active')
    }
    this.renderValueInspector(target)
    this.valueInspectorTextEl?.focus()
  }

  private closeValueInspector(): void {
    const wasOpen = this.isInspectorOpen
    this.isInspectorOpen = false
    if (this.valueInspectorEl) {
      this.valueInspectorEl.style.display = 'none'
    }
    this.inspectCellBtn?.classList.remove('active')
    if (wasOpen) {
      this.dataGrid?.handleViewportResize()
    }
  }

  private toggleValueInspector(): void {
    if (this.isInspectorOpen) {
      this.closeValueInspector()
      return
    }
    this.openValueInspector()
  }

  private handleCellSelectionChanged(info: SelectedCellInfo | null): void {
    this.selectedCell = info
    if (this.inspectCellBtn) {
      this.inspectCellBtn.disabled = !info
      this.inspectCellBtn.classList.toggle('active', Boolean(info && this.isInspectorOpen))
    }
    if (!info) {
      this.closeValueInspector()
      return
    }
    if (!this.isInspectorOpen) {
      return
    }
    this.renderValueInspector(info)
  }

  private updateValueInspectorMeta(isNullValue: boolean): void {
    if (this.valueNullBadgeEl) {
      this.valueNullBadgeEl.style.display = isNullValue ? 'inline-flex' : 'none'
    }
    if (!this.valueInspectorStatusEl || !this.valueInspectorTextEl) return
    const text = this.valueInspectorTextEl.value
    const chars = text.length
    const lines = text.length === 0 ? 1 : text.split('\n').length
    const trimmed = text.trim()

    let jsonNote = ''
    let statusClass = 'datanoa-json-status'
    if (isNullValue) {
      jsonNote = 'NULL value (distinct from empty string "")'
    } else if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        JSON.parse(trimmed)
        jsonNote = 'Valid JSON'
        statusClass = 'datanoa-json-status valid'
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Invalid JSON'
        jsonNote = `Invalid JSON: ${msg}`
        statusClass = 'datanoa-json-status invalid'
      }
    }
    this.valueInspectorStatusEl.className = statusClass
    this.valueInspectorStatusEl.textContent = jsonNote
      ? `${chars} chars · ${lines} line${lines === 1 ? '' : 's'} · ${jsonNote}`
      : `${chars} chars · ${lines} line${lines === 1 ? '' : 's'}`
  }

  private renderValueInspector(info: SelectedCellInfo): void {
    if (!this.valueInspectorEl || !this.valueInspectorTitleEl || !this.valueInspectorTextEl) return
    this.valueInspectorEl.style.display = 'flex'
    const typeLabel = info.columnType ? ` (${info.columnType})` : ''
    this.valueInspectorTitleEl.textContent = `Value Inspector · ${info.columnName}${typeLabel} · Row ${info.rowIndex + 1}`

    const isNullVal = info.value === null || info.value === undefined
    let formattedText = ''
    if (isNullVal) {
      formattedText = ''
    } else if (typeof info.value === 'object') {
      try {
        formattedText = JSON.stringify(info.value, null, 2)
      } catch {
        formattedText = String(info.value)
      }
    } else if (typeof info.value === 'string') {
      const trimmed = info.value.trim()
      if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try {
          formattedText = JSON.stringify(JSON.parse(trimmed), null, 2)
        } catch {
          formattedText = info.value
        }
      } else {
        formattedText = info.value
      }
    } else {
      formattedText = String(info.value)
    }

    this.valueInspectorTextEl.value = formattedText
    this.valueInspectorTextEl.placeholder = isNullVal ? 'NULL (type to set text value)' : ''
    this.valueInspectorTextEl.readOnly = !info.isEditable
    const canSetNull = info.isEditable && info.isNullable !== false
    if (this.valueApplyBtn) this.valueApplyBtn.disabled = !info.isEditable || this.isSavingCell
    if (this.valueNullBtn) this.valueNullBtn.disabled = !canSetNull || this.isSavingCell
    this.updateValueInspectorMeta(isNullVal)
  }

  private async applyValueFromInspector(setNull: boolean): Promise<void> {
    if (this.isSavingCell || !this.selectedCell || !this.dataGrid || !this.valueInspectorTextEl) return
    const info = this.selectedCell
    if (!info.isEditable) return
    if (setNull && info.isNullable === false) return

    let nextValue: unknown = null
    if (!setNull) {
      nextValue = coerceCellInputValue(
        this.valueInspectorTextEl.value,
        info.value,
        info.columnType
      )
    }

    if (this.dataGrid.isBatchMode() || this.dataGrid.getStagedCount() > 0 || info.isInserted) {
      this.dataGrid.stageCellEdit(info.rowIndex, info.colIndex, nextValue)
      this.updateValueInspectorMeta(setNull)
      this.updateStatus(setNull ? `Staged NULL for ${info.columnName}` : `Staged edit for ${info.columnName}`)
      return
    }

    const model = this.dataGrid.getModel()
    if (!model || !this.activeConnectionId || !this.activeTable) return
    const targetConnId = this.activeConnectionId
    const targetTable = this.activeTable
    const targetSchema = this.activeSchema
    const targetPage = this.currentPage
    const saveViewSeq = this.gridViewSeq
    const row = model.rows[info.rowIndex]
    const primaryKeys: Record<string, unknown> = {}
    model.primaryKey.forEach((pk) => {
      const pkIdx = model.headers.indexOf(pk)
      primaryKeys[pk] = Array.isArray(row) ? row[pkIdx] : (row as Record<string, unknown>)[pk]
    })

    this.isSavingCell = true
    const triggerBtn = setNull ? this.valueNullBtn : this.valueApplyBtn
    if (this.valueApplyBtn) this.valueApplyBtn.disabled = true
    if (this.valueNullBtn) this.valueNullBtn.disabled = true
    setButtonLoading(triggerBtn, true, 'Saving...')

    try {
      const res = await this.handleUpdateCell({
        primaryKeys,
        column: info.columnName,
        newValue: nextValue,
        originalValue: info.value,
        rowIndex: info.rowIndex,
      })
      if (
        res.ok &&
        this.activeConnectionId === targetConnId &&
        this.activeTable === targetTable &&
        (this.activeSchema || '') === (targetSchema || '') &&
        this.gridViewSeq === saveViewSeq
      ) {
        await this.loadTableData(targetConnId, targetTable, targetPage)
      }
    } finally {
      this.isSavingCell = false
      setButtonLoading(triggerBtn, false)
      const editable = Boolean(this.selectedCell?.isEditable)
      const nullable = this.selectedCell?.isNullable !== false
      if (this.valueApplyBtn) this.valueApplyBtn.disabled = !editable
      if (this.valueNullBtn) this.valueNullBtn.disabled = !(editable && nullable)
    }
  }

  private findActiveSchemaObject(): SchemaObject | undefined {
    if (!this.activeTable) return undefined
    return (
      this.schemaObjects.find(
        (o) => o.name === this.activeTable && (o.schema || '') === (this.activeSchema || '')
      ) || this.schemaObjects.find((o) => o.name === this.activeTable)
    )
  }

  private async countRowsForObject(item: SchemaObject): Promise<void> {
    if (!this.activeConnectionId || typeof window === 'undefined' || !window.orca?.plugin?.request) {
      return
    }
    const driver = this.getActiveConnection()?.driver || 'sqlite'
    if (driver === 'redis') return
    const seq = ++this.countRowsSeq
    const targetConnId = this.activeConnectionId
    const tableRef = this.formatQualifiedSqlTable(item, driver)
    const sql = `SELECT COUNT(*) AS row_count FROM ${tableRef};`
    this.updateStatus(`Counting rows in ${item.name}...`)
    try {
      const res = await this.requestPlugin<QueryResult>(
        'query.run',
        {
          connectionId: targetConnId,
          queryId: `count_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          sql,
        },
        { timeoutMs: DEFAULT_RPC_TIMEOUT_MS }
      )
      if (seq !== this.countRowsSeq || this.activeConnectionId !== targetConnId) return
      const firstRow = res.rows?.[0]
      let countVal: unknown = 0
      if (Array.isArray(firstRow)) {
        countVal = firstRow[0]
      } else if (firstRow && typeof firstRow === 'object') {
        const vals = Object.values(firstRow)
        countVal = vals[0]
      }
      const numStr = String(countVal ?? 0)
      this.showQueryBanner(
        'success',
        `Row Count · ${item.name}: ${numStr} rows (${res.executionTimeMs}ms)`,
        sql
      )
      this.updateStatus(`${item.name}: ${numStr} rows`)
    } catch (err: unknown) {
      if (seq !== this.countRowsSeq || this.activeConnectionId !== targetConnId) return
      const msg = err instanceof Error ? err.message : String(err)
      this.showQueryBanner('error', `Count Rows Failed (${item.name})`, msg)
      this.updateStatus(`Count rows error: ${msg}`)
    }
  }

  private closeActiveModal(): void {
    if (this.activeModalKeyCleanup) {
      this.activeModalKeyCleanup()
      this.activeModalKeyCleanup = null
    }
    if (this.activeModalBackdrop) {
      this.activeModalBackdrop.remove()
      this.activeModalBackdrop = null
    }
  }

  private mountStudioModal(
    modalEl: HTMLElement,
    canClose: () => boolean = () => true
  ): HTMLDivElement | null {
    this.closeActiveModal()
    if (typeof document === 'undefined' || !document.body) return null
    const backdrop = document.createElement('div')
    backdrop.className = 'datanoa-modal-backdrop'
    backdrop.setAttribute('role', 'dialog')
    backdrop.setAttribute('aria-modal', 'true')
    backdrop.appendChild(modalEl)
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop && canClose()) {
        this.closeActiveModal()
      }
    })
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      const onKey = (ev: KeyboardEvent) => {
        if (ev.key === 'Escape') {
          ev.preventDefault()
          ev.stopPropagation()
          if (canClose()) {
            this.closeActiveModal()
          }
        }
      }
      window.addEventListener('keydown', onKey, true)
      this.activeModalKeyCleanup = () => {
        window.removeEventListener('keydown', onKey, true)
      }
    }
    this.activeModalBackdrop = backdrop
    document.body.appendChild(backdrop)
    return backdrop
  }

  private async activateSavedConnection(savedId: string): Promise<void> {
    if (savedId === this.activeConnectionId) {
      // Active profile changed (host, credentials, flags): force a full reset + re-introspection
      this.handleConnectionChanged(null)
    }
    this.pendingDocConnectionId = savedId
    this.pendingDocTable = null
    this.pendingDocSchema = undefined
    this.restoredPageOnBoot = 1
    await this.refreshConnections()
  }

  private openConnectionModal(editProfile?: ConnectionProfile): void {
    if (typeof document === 'undefined') return
    const isEdit = editProfile !== undefined
    const editId = editProfile?.id ?? ''

    let driver: DatabaseDriverType = editProfile ? editProfile.driver : 'sqlite'
    if (!isKnownConnectionDriver(driver)) driver = 'sqlite'
    let colorTag: ConnectionColorTag = editProfile?.colorTag ?? 'none'
    let hadPassword = Boolean(editProfile?.hasPassword)
    let hadAuthToken = Boolean(editProfile?.hasAuthToken)
    let lastParsedUri = ''
    let lastParsedPlaceholder = false
    let placeholderPending = false
    let lastAutoName = ''
    let isBusy = false
    let parseSeq = 0
    let detectSeq = 0
    let discoveredEnvs: DiscoveredEnvConnection[] = []
    let discoveredFiles: DiscoveredSqliteFile[] = []
    let discoveredFilter = ''
    let deleteArmed = false
    let deleteTimer: ReturnType<typeof setTimeout> | null = null
    let backdropRef: HTMLDivElement | null = null
    const isModalOpen = (): boolean =>
      backdropRef !== null && this.activeModalBackdrop === backdropRef

    const createInput = (placeholder: string, mono = false): HTMLInputElement => {
      const el = document.createElement('input')
      el.type = 'text'
      el.className = `datanoa-conn-input${mono ? ' is-mono' : ''}`
      el.placeholder = placeholder
      el.setAttribute('autocomplete', 'off')
      el.spellcheck = false
      return el
    }

    const createField = (labelText: string, control: HTMLElement, full = false): HTMLDivElement => {
      const wrap = document.createElement('div')
      wrap.className = `datanoa-conn-field${full ? ' is-full' : ''}`
      const label = document.createElement('label')
      label.textContent = labelText
      wrap.appendChild(label)
      wrap.appendChild(control)
      return wrap
    }

    const createCheck = (labelText: string): { wrap: HTMLLabelElement; input: HTMLInputElement } => {
      const wrap = document.createElement('label')
      wrap.className = 'datanoa-conn-check'
      const input = document.createElement('input')
      input.type = 'checkbox'
      const text = document.createElement('span')
      text.textContent = labelText
      wrap.appendChild(input)
      wrap.appendChild(text)
      return { wrap, input }
    }

    const createButton = (text: string, extraClass = ''): HTMLButtonElement => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = `datanoa-btn datanoa-btn-sm${extraClass ? ` ${extraClass}` : ''}`
      btn.textContent = text
      return btn
    }

    const showEl = (el: HTMLElement, visible: boolean): void => {
      el.style.display = visible ? '' : 'none'
    }

    // ---- Shell ----
    const modal = document.createElement('div')
    modal.className = 'datanoa-conn-modal'

    const head = document.createElement('div')
    head.className = 'datanoa-modal-head'
    const headTitle = document.createElement('span')
    headTitle.textContent = isEdit
      ? `Edit Connection — ${editProfile?.name ?? ''}`
      : 'New Database Connection'
    head.appendChild(headTitle)

    const body = document.createElement('div')
    body.className = 'datanoa-modal-body'

    const noticeBox = document.createElement('div')
    noticeBox.className = 'datanoa-modal-box'
    noticeBox.style.display = 'none'
    noticeBox.setAttribute('role', 'status')
    const showNotice = (kind: 'error' | 'success' | 'neutral', text: string): void => {
      noticeBox.className = `datanoa-modal-box${kind === 'neutral' ? '' : ` ${kind}`}`
      noticeBox.textContent = text
      noticeBox.style.display = 'block'
    }
    const clearNotice = (): void => {
      noticeBox.style.display = 'none'
      noticeBox.textContent = ''
    }
    body.appendChild(noticeBox)

    // ---- Quick URI bar & workspace auto-detect ----
    const uriBar = document.createElement('div')
    uriBar.className = 'datanoa-conn-uri-bar'
    const uriLabel = document.createElement('div')
    uriLabel.className = 'datanoa-conn-section-label'
    uriLabel.textContent = 'Quick Connect'
    const uriRow = document.createElement('div')
    uriRow.className = 'datanoa-conn-row'
    const uriInp = createInput(
      'Paste connection URI (postgres://, mysql://, redis://, libsql://, clickhouse://, sqlite://)...',
      true
    )
    uriInp.classList.add('datanoa-conn-uri-input')
    const parseBtn = createButton('Parse URI')
    uriRow.appendChild(uriInp)
    uriRow.appendChild(parseBtn)

    const detectRow = document.createElement('div')
    detectRow.className = 'datanoa-conn-row is-wrap'
    const detectBtn = createButton('Auto-Detect (.env & .db)')
    const folderInp = createInput('Optional folder path to scan...', true)
    folderInp.style.flex = '1 1 160px'
    const scanBtn = createButton('Scan Folder')
    detectRow.appendChild(detectBtn)
    detectRow.appendChild(folderInp)
    detectRow.appendChild(scanBtn)

    uriBar.appendChild(uriLabel)
    uriBar.appendChild(uriRow)
    uriBar.appendChild(detectRow)
    body.appendChild(uriBar)

    const discoveredBox = document.createElement('div')
    discoveredBox.className = 'datanoa-conn-discovered'
    discoveredBox.style.display = 'none'
    body.appendChild(discoveredBox)

    // ---- Engine grid ----
    const engineLabel = document.createElement('div')
    engineLabel.className = 'datanoa-conn-section-label'
    engineLabel.textContent = 'Database Engine'
    const engineGrid = document.createElement('div')
    engineGrid.className = 'datanoa-engine-grid'
    const engineTiles = new Map<DatabaseDriverType, HTMLButtonElement>()
    for (const eng of CONNECTION_ENGINES) {
      const tile = document.createElement('button')
      tile.type = 'button'
      tile.className = 'datanoa-engine-tile'
      tile.dataset.driver = eng.id
      tile.title = eng.label
      tile.appendChild(createDbLogoSvg(eng.id))
      const tileLabel = document.createElement('span')
      tileLabel.textContent = eng.label
      tile.appendChild(tileLabel)
      tile.addEventListener('click', () => {
        if (isBusy || driver === eng.id) return
        applyDriver(eng.id, true)
      })
      engineTiles.set(eng.id, tile)
      engineGrid.appendChild(tile)
    }
    body.appendChild(engineLabel)
    body.appendChild(engineGrid)

    // ---- Fields ----
    const nameInp = createInput('Connection name')
    const filePathInp = createInput('C:\\path\\to\\database.db', true)
    const libsqlUrlInp = createInput('libsql://your-db.turso.io', true)
    const authTokenInp = createInput('Optional Bearer token')
    authTokenInp.type = 'password'
    const libsqlDbInp = createInput('Database label (e.g. turso)')
    const hostInp = createInput('localhost', true)
    const portInp = createInput('Port', true)
    portInp.inputMode = 'numeric'
    const userInp = createInput('Optional')
    const passwordInp = createInput('Optional')
    passwordInp.type = 'password'
    passwordInp.setAttribute('autocomplete', 'new-password')
    const databaseInp = createInput('Database')
    const redisDbSel = document.createElement('select')
    redisDbSel.className = 'datanoa-conn-select'
    for (let i = 0; i <= 15; i++) {
      const opt = document.createElement('option')
      opt.value = String(i)
      opt.textContent = `db${i}`
      redisDbSel.appendChild(opt)
    }
    const chUrlInp = createInput('http://localhost:8123 (HTTP(S) endpoint)', true)
    const optionsInp = createInput('--cluster=my-cluster or endpoint=ep-abc123', true)
    const sslCheck = createCheck('SSL / TLS')
    const roCheck = createCheck('Read-Only Mode')
    roCheck.input.checked = Boolean(editProfile?.readOnly)

    const envPills = document.createElement('div')
    envPills.className = 'datanoa-conn-env-pills'
    const envPillBtns = new Map<ConnectionColorTag, HTMLButtonElement>()
    const syncEnvPills = (): void => {
      envPillBtns.forEach((btn, id) => btn.classList.toggle('active', id === colorTag))
    }
    for (const tag of CONNECTION_ENV_TAGS) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = `datanoa-conn-env-pill env-${tag.id}`
      btn.textContent = tag.label
      btn.addEventListener('click', () => {
        if (isBusy) return
        colorTag = tag.id
        syncEnvPills()
      })
      envPillBtns.set(tag.id, btn)
      envPills.appendChild(btn)
    }

    const fieldsGrid = document.createElement('div')
    fieldsGrid.className = 'datanoa-conn-fields'
    const rowName = createField('Connection Name', nameInp, true)
    const envRow = document.createElement('div')
    envRow.className = 'datanoa-conn-row is-wrap'
    envRow.appendChild(envPills)
    envRow.appendChild(roCheck.wrap)
    const rowEnv = createField('Environment Tag', envRow, true)
    const rowFilePath = createField('SQLite File Path', filePathInp, true)
    const rowLibsqlUrl = createField('LibSQL / Turso URL', libsqlUrlInp, true)
    const rowAuthToken = createField('Auth Token', authTokenInp)
    const rowLibsqlDb = createField('Database Label', libsqlDbInp)
    const rowHost = createField('Host', hostInp)
    const rowPort = createField('Port', portInp)
    const rowUser = createField('User', userInp)
    const rowPassword = createField('Password', passwordInp)
    const rowDatabase = createField('Database', databaseInp)
    const rowRedisDb = createField('Redis DB Index', redisDbSel)
    const rowSsl = createField('Security', sslCheck.wrap)
    const rowChUrl = createField('HTTP(S) Endpoint URL', chUrlInp, true)
    const rowOptions = createField('Options (Cluster / Endpoint)', optionsInp, true)
    for (const row of [
      rowName,
      rowEnv,
      rowFilePath,
      rowLibsqlUrl,
      rowAuthToken,
      rowLibsqlDb,
      rowHost,
      rowPort,
      rowUser,
      rowPassword,
      rowDatabase,
      rowRedisDb,
      rowSsl,
      rowChUrl,
      rowOptions,
    ]) {
      fieldsGrid.appendChild(row)
    }
    body.appendChild(fieldsGrid)

    // ---- Footer ----
    const actions = document.createElement('div')
    actions.className = 'datanoa-modal-actions'
    const deleteBtn = createButton('Delete Connection', 'datanoa-btn-danger')
    deleteBtn.style.marginRight = 'auto'
    const testBtn = createButton('Test Connection')
    const cancelBtn = createButton('Cancel')
    const saveBtn = createButton(
      isEdit ? 'Update Connection' : 'Save & Connect',
      'datanoa-btn-primary'
    )
    if (isEdit) actions.appendChild(deleteBtn)
    actions.appendChild(testBtn)
    actions.appendChild(cancelBtn)
    actions.appendChild(saveBtn)

    const busyControls: Array<HTMLInputElement | HTMLSelectElement | HTMLButtonElement> = [
      uriInp,
      parseBtn,
      detectBtn,
      folderInp,
      scanBtn,
      nameInp,
      filePathInp,
      libsqlUrlInp,
      authTokenInp,
      libsqlDbInp,
      hostInp,
      portInp,
      userInp,
      passwordInp,
      databaseInp,
      redisDbSel,
      chUrlInp,
      optionsInp,
      sslCheck.input,
      roCheck.input,
      deleteBtn,
      testBtn,
      cancelBtn,
      saveBtn,
      ...Array.from(engineTiles.values()),
    ]
    const setBusy = (busy: boolean): void => {
      isBusy = busy
      for (const ctrl of busyControls) {
        ctrl.disabled = busy
      }
    }

    // ---- Discovery rendering ----
    const renderDiscovered = (): void => {
      discoveredBox.innerHTML = ''
      const showFiles = driver === 'sqlite' && discoveredFiles.length > 0
      const showEnvs = discoveredEnvs.length > 0
      if (!showFiles && !showEnvs) {
        showEl(discoveredBox, false)
        return
      }
      showEl(discoveredBox, true)

      if (showEnvs) {
        const label = document.createElement('div')
        label.className = 'datanoa-conn-section-label'
        label.textContent = `Detected .env connections (${discoveredEnvs.length})`
        discoveredBox.appendChild(label)
        const list = document.createElement('div')
        list.className = 'datanoa-conn-chip-list'
        for (const item of discoveredEnvs) {
          const chip = document.createElement('button')
          chip.type = 'button'
          chip.className = 'datanoa-conn-chip'
          const masked = maskConnectionUriSecret(item.uri)
          chip.title = `${item.sourceFile} (${item.envKey}): ${masked}`
          const main = document.createElement('span')
          main.className = 'datanoa-conn-chip-main'
          const title = document.createElement('span')
          title.className = 'datanoa-conn-chip-title'
          if (isKnownConnectionDriver(item.driver)) title.appendChild(createDbLogoSvg(item.driver))
          const titleText = document.createElement('span')
          titleText.textContent = `${item.envKey} (${item.name || item.driver})`
          title.appendChild(titleText)
          const sub = document.createElement('span')
          sub.className = 'datanoa-conn-chip-sub'
          sub.textContent = masked
          main.appendChild(title)
          main.appendChild(sub)
          const badge = document.createElement('span')
          badge.className = 'datanoa-badge'
          badge.textContent = item.sourceFile || '.env'
          chip.appendChild(main)
          chip.appendChild(badge)
          chip.addEventListener('click', () => {
            if (isBusy) return
            uriInp.value = item.uri
            if (!nameInp.value.trim()) {
              nameInp.value = item.name || item.envKey
              lastAutoName = nameInp.value
            }
            void parseUri(item.uri, true)
          })
          list.appendChild(chip)
        }
        discoveredBox.appendChild(list)
      }

      if (showFiles) {
        const label = document.createElement('div')
        label.className = 'datanoa-conn-section-label'
        label.textContent = `Detected SQLite files (${discoveredFiles.length})`
        discoveredBox.appendChild(label)
        const filterInp = createInput('Filter discovered .db files...')
        filterInp.value = discoveredFilter
        filterInp.addEventListener('input', () => {
          discoveredFilter = filterInp.value
          renderDiscovered()
          const refocus = discoveredBox.querySelector('input')
          if (refocus instanceof HTMLInputElement) {
            refocus.focus()
            refocus.setSelectionRange?.(discoveredFilter.length, discoveredFilter.length)
          }
        })
        discoveredBox.appendChild(filterInp)
        const q = discoveredFilter.trim().toLowerCase()
        const filtered = q
          ? discoveredFiles.filter(
              (f) =>
                f.name.toLowerCase().includes(q) || f.filePath.toLowerCase().includes(q)
            )
          : discoveredFiles
        const list = document.createElement('div')
        list.className = 'datanoa-conn-chip-list'
        if (filtered.length === 0) {
          const empty = document.createElement('div')
          empty.className = 'datanoa-cell-null'
          empty.textContent = `No SQLite files match "${discoveredFilter}".`
          list.appendChild(empty)
        }
        for (const file of filtered) {
          const chip = document.createElement('button')
          chip.type = 'button'
          chip.className = `datanoa-conn-chip${filePathInp.value.trim() === file.filePath ? ' selected' : ''}`
          chip.title = file.filePath
          const main = document.createElement('span')
          main.className = 'datanoa-conn-chip-main'
          const title = document.createElement('span')
          title.className = 'datanoa-conn-chip-title'
          title.appendChild(createDbLogoSvg('sqlite'))
          const titleText = document.createElement('span')
          titleText.textContent = file.name
          title.appendChild(titleText)
          const sub = document.createElement('span')
          sub.className = 'datanoa-conn-chip-sub'
          sub.textContent = file.filePath
          main.appendChild(title)
          main.appendChild(sub)
          const size = document.createElement('span')
          size.className = 'datanoa-badge datanoa-badge-unique'
          size.textContent = file.sizeLabel || `${file.sizeBytes} B`
          chip.appendChild(main)
          chip.appendChild(size)
          chip.addEventListener('click', () => {
            if (isBusy) return
            filePathInp.value = file.filePath
            if (!nameInp.value.trim() || nameInp.value === lastAutoName) {
              nameInp.value = file.name
              lastAutoName = file.name
            }
            renderDiscovered()
          })
          list.appendChild(chip)
        }
        discoveredBox.appendChild(list)
      }
    }

    // ---- Driver switching ----
    const applyDriver = (next: DatabaseDriverType, applyDefaults: boolean): void => {
      const prevMeta = getConnectionEngineMeta(driver)
      driver = next
      const meta = getConnectionEngineMeta(next)
      engineTiles.forEach((tile, id) => tile.classList.toggle('active', id === next))
      const isSqlite = next === 'sqlite'
      const isLibsql = next === 'libsql'
      const isServer = !isSqlite && !isLibsql
      showEl(rowFilePath, isSqlite)
      showEl(rowLibsqlUrl, isLibsql)
      showEl(rowAuthToken, isLibsql)
      showEl(rowLibsqlDb, isLibsql)
      showEl(rowHost, isServer)
      showEl(rowPort, isServer)
      showEl(rowUser, isServer)
      showEl(rowPassword, isServer)
      showEl(rowDatabase, isServer && next !== 'redis')
      showEl(rowRedisDb, next === 'redis')
      showEl(rowSsl, isServer)
      showEl(rowChUrl, next === 'clickhouse')
      showEl(rowOptions, next === 'postgres' || next === 'cockroachdb')
      databaseInp.placeholder = meta.defaultDb
      userInp.placeholder = meta.defaultUser || 'Optional'
      if (applyDefaults) {
        const curPort = portInp.value.trim()
        if (!curPort || curPort === String(prevMeta.defaultPort)) {
          portInp.value = meta.defaultPort > 0 ? String(meta.defaultPort) : ''
        }
        sslCheck.input.checked = meta.defaultSsl
      }
      renderDiscovered()
    }

    // ---- Submission ----
    const buildSubmission = (id: string): ConnectionSubmission => {
      const name = nameInp.value.trim()
      const readOnly = roCheck.input.checked
      const sameDriverAsStored = isEdit && editProfile?.driver === driver

      if (driver === 'sqlite') {
        const filePath = filePathInp.value.trim()
        const baseName = filePath.split(/[\\/]/).filter(Boolean).pop() || 'database.db'
        return {
          profile: {
            id,
            name: name || baseName,
            driver: 'sqlite',
            database: baseName,
            filePath,
            readOnly,
            colorTag,
          },
        }
      }

      if (driver === 'libsql') {
        const url = libsqlUrlInp.value.trim()
        const authToken = authTokenInp.value
        const keepStoredToken = sameDriverAsStored && hadAuthToken
        const submission: ConnectionSubmission = {
          profile: {
            id,
            name: name || url || 'LibSQL',
            driver: 'libsql',
            database: libsqlDbInp.value.trim() || 'turso',
            url,
            ssl: /^(?:https|libsql|wss):\/\//i.test(url) || !/^http:\/\//i.test(url),
            readOnly,
            colorTag,
            hasAuthToken: Boolean(authToken) || keepStoredToken,
          },
        }
        if (authToken) submission.authToken = authToken
        return submission
      }

      const meta = getConnectionEngineMeta(driver)
      const host = hostInp.value.trim() || 'localhost'
      const parsedPort = Number.parseInt(portInp.value.trim(), 10)
      const port =
        Number.isFinite(parsedPort) && parsedPort >= 1 && parsedPort <= 65535
          ? parsedPort
          : meta.defaultPort
      const user = userInp.value.trim()
      const password = passwordInp.value
      const ssl = sslCheck.input.checked
      const keepStoredPassword = sameDriverAsStored && hadPassword

      const profile: ConnectionProfile = {
        id,
        name: name || `${driver}@${host}`,
        driver,
        database:
          driver === 'redis'
            ? String(Number.parseInt(redisDbSel.value || '0', 10) || 0)
            : databaseInp.value.trim() || meta.defaultDb,
        host,
        port,
        ssl,
        readOnly,
        colorTag,
        hasPassword: Boolean(password) || keepStoredPassword,
      }
      if (user) profile.user = user
      if (driver === 'redis') {
        const rdb = Number.parseInt(redisDbSel.value || '0', 10)
        profile.redisDb = Number.isFinite(rdb) && rdb >= 0 && rdb <= 15 ? rdb : 0
      }
      if (driver === 'postgres' || driver === 'cockroachdb') {
        const pgOptions = optionsInp.value.trim()
        if (pgOptions) profile.options = pgOptions
      }
      if (driver === 'clickhouse') {
        const chUrl = chUrlInp.value.trim()
        if (chUrl) {
          profile.url = chUrl
          try {
            const parsedCh = new URL(chUrl)
            if (parsedCh.hostname) profile.host = parsedCh.hostname
            if (parsedCh.port) {
              const chPort = Number.parseInt(parsedCh.port, 10)
              if (Number.isFinite(chPort) && chPort >= 1 && chPort <= 65535) profile.port = chPort
            } else if (parsedCh.protocol === 'https:') {
              profile.port = 8443
            } else if (parsedCh.protocol === 'http:') {
              profile.port = 8123
            }
            if (parsedCh.protocol === 'https:') profile.ssl = true
            else if (parsedCh.protocol === 'http:') profile.ssl = false
          } catch {
            // Keep the typed URL verbatim when it is not a valid absolute URL
          }
        } else {
          profile.url = `${ssl ? 'https' : 'http'}://${host}:${port}`
        }
      }
      const submission: ConnectionSubmission = { profile }
      if (password) submission.password = password
      return submission
    }

    // ---- URI parsing ----
    const parseUri = async (rawUri: string, clearMissingSecret = false): Promise<boolean> => {
      const uri = rawUri.trim()
      if (!uri) return false
      const seq = ++parseSeq
      setButtonLoading(parseBtn, true, 'Parsing...')
      try {
        const res = await this.requestPlugin<ParseUriResponse>('connection.parseUri', { uri })
        if (seq !== parseSeq || !isModalOpen()) return false
        if (!res.ok || !res.profile) {
          showNotice('error', res.error || 'Could not parse connection URI.')
          return false
        }
        const p = res.profile
        const nextDriver: DatabaseDriverType = isKnownConnectionDriver(p.driver) ? p.driver : 'sqlite'
        const prevDriver = driver
        const prevHost = hostInp.value.trim().toLowerCase()
        const prevUser = userInp.value.trim()
        const prevLibsqlUrl = libsqlUrlInp.value.trim().toLowerCase()
        const nextHost = String(p.host ?? '').trim().toLowerCase()
        const nextUser = String(p.user ?? '').trim()
        const nextLibsqlUrl = String(p.url ?? '').trim().toLowerCase()
        const targetChanged =
          nextDriver !== prevDriver ||
          (nextDriver === 'libsql'
            ? nextLibsqlUrl !== prevLibsqlUrl
            : nextDriver !== 'sqlite' && (nextHost !== prevHost || nextUser !== prevUser))

        // A manually parsed URI defines a fresh target: never inherit another target's stored secret
        const dropStored = clearMissingSecret || (isEdit && targetChanged)
        if (dropStored || res.password !== undefined || res.placeholderPassword) hadPassword = false
        if (dropStored || res.authToken !== undefined) hadAuthToken = false
        const nextPassword =
          res.password !== undefined ? res.password : dropStored ? '' : passwordInp.value
        const nextAuthToken =
          res.authToken !== undefined ? res.authToken : dropStored ? '' : authTokenInp.value

        filePathInp.value = ''
        libsqlUrlInp.value = ''
        authTokenInp.value = ''
        libsqlDbInp.value = ''
        hostInp.value = 'localhost'
        portInp.value = ''
        databaseInp.value = ''
        chUrlInp.value = ''
        optionsInp.value = ''
        redisDbSel.value = '0'
        passwordInp.value = ''
        applyDriver(nextDriver, true)
        if (p.name) nameInp.value = p.name
        if (p.readOnly !== undefined) roCheck.input.checked = Boolean(p.readOnly)
        if (nextDriver === 'sqlite') {
          filePathInp.value = p.filePath || ''
        } else if (nextDriver === 'libsql') {
          libsqlUrlInp.value = p.url || ''
          libsqlDbInp.value = p.database || ''
          authTokenInp.value = nextAuthToken
        } else {
          if (p.host) hostInp.value = p.host
          if (p.port) portInp.value = String(p.port)
          if (p.user !== undefined) userInp.value = p.user
          if (p.ssl !== undefined) sslCheck.input.checked = Boolean(p.ssl)
          if (nextDriver === 'redis') {
            redisDbSel.value = String(p.redisDb ?? 0)
          } else if (p.database !== undefined) {
            databaseInp.value = p.database
          }
          if (nextDriver === 'clickhouse' && p.url) chUrlInp.value = p.url
          if (
            (nextDriver === 'postgres' || nextDriver === 'cockroachdb') &&
            typeof p.options === 'string' &&
            p.options.trim()
          ) {
            optionsInp.value = p.options.trim()
          }
          passwordInp.value = nextPassword
        }
        authTokenInp.placeholder =
          hadAuthToken && isEdit ? 'Stored token preserved (type to replace)' : 'Optional Bearer token'
        lastParsedUri = uri
        lastParsedPlaceholder = Boolean(res.placeholderPassword)
        placeholderPending = lastParsedPlaceholder && !passwordInp.value
        const engineLabelText = getConnectionEngineMeta(nextDriver).label
        if (placeholderPending) {
          passwordInp.placeholder = 'Required (replace placeholder password)'
          showNotice(
            'error',
            `Parsed ${engineLabelText} URI — placeholder password was removed. Enter your actual Database Password below before testing.`
          )
          passwordInp.focus?.()
        } else {
          passwordInp.placeholder =
            hadPassword && isEdit ? 'Stored password preserved (type to replace)' : 'Optional'
          showNotice('success', `Parsed ${engineLabelText} URI`)
        }
        return true
      } catch (err: unknown) {
        if (seq !== parseSeq || !isModalOpen()) return false
        showNotice('error', `URI error: ${err instanceof Error ? err.message : String(err)}`)
        return false
      } finally {
        if (seq === parseSeq) {
          setButtonLoading(parseBtn, false)
          if (isBusy) parseBtn.disabled = true
        }
      }
    }

    const ensureUriParsed = async (): Promise<boolean> => {
      const raw = uriInp.value.trim()
      if (!raw || raw === lastParsedUri) return true
      return await parseUri(raw, false)
    }

    const validateRequiredFields = (): boolean => {
      if (driver === 'sqlite' && !filePathInp.value.trim()) {
        showNotice('error', 'Please enter a SQLite database file path.')
        return false
      }
      if (driver === 'libsql' && !libsqlUrlInp.value.trim()) {
        showNotice('error', 'Please enter a LibSQL / Turso URL.')
        return false
      }
      return true
    }

    const ensurePasswordBeforeSubmit = (): boolean => {
      if (driver === 'sqlite' || driver === 'libsql') return true
      const typed = passwordInp.value
      if (placeholderPending && !typed) {
        showNotice(
          'error',
          'Database Password is required — replace placeholder text like [YOUR-PASSWORD] by typing your actual Database Password.'
        )
        passwordInp.focus?.()
        return false
      }
      const keepStored = isEdit && editProfile?.driver === driver && hadPassword
      if (
        !typed &&
        !keepStored &&
        (driver === 'postgres' || driver === 'cockroachdb') &&
        /\.supabase\.(?:co|com)$/i.test(hostInp.value.trim())
      ) {
        showNotice(
          'error',
          'Database Password is required for Supabase PostgreSQL (Project Settings -> Database -> Database password, not your Supabase account login password).'
        )
        passwordInp.focus?.()
        return false
      }
      return true
    }

    // ---- Workspace discovery ----
    const detectWorkspace = async (folderPath: string, manual: boolean): Promise<void> => {
      const seq = ++detectSeq
      const activeBtn = folderPath ? scanBtn : detectBtn
      setButtonLoading(activeBtn, true, 'Scanning...')
      try {
        const folder = folderPath.trim()
        const [wsRes, folderRes] = await Promise.all([
          this.requestPlugin<WorkspaceDetectResponse>(
            'workspace.detectConnections',
            folder ? { folderPath: folder } : {}
          ),
          folder
            ? this.requestPlugin<{ files?: DiscoveredSqliteFile[] }>('sqlite.scanFolder', {
                folderPath: folder,
              }).catch(() => null)
            : Promise.resolve(null),
        ])
        if (seq !== detectSeq || !isModalOpen()) return
        discoveredEnvs = Array.isArray(wsRes?.envConnections) ? wsRes.envConnections : []
        const wsFiles = Array.isArray(wsRes?.sqliteFiles) ? wsRes.sqliteFiles : []
        const extraFiles = Array.isArray(folderRes?.files) ? folderRes.files : []
        const seen = new Set<string>()
        discoveredFiles = []
        for (const f of [...extraFiles, ...wsFiles]) {
          if (f?.filePath && !seen.has(f.filePath)) {
            seen.add(f.filePath)
            discoveredFiles.push(f)
          }
        }
        if (manual && discoveredEnvs.length === 0 && discoveredFiles.length === 0) {
          showNotice('neutral', 'No .env connections or SQLite database files found.')
        }
      } catch (err: unknown) {
        if (seq !== detectSeq || !isModalOpen()) return
        discoveredEnvs = []
        discoveredFiles = []
        if (manual) {
          showNotice(
            'error',
            `Workspace discovery failed: ${err instanceof Error ? err.message : String(err)}`
          )
        }
      } finally {
        if (seq === detectSeq) {
          setButtonLoading(activeBtn, false)
          if (isBusy) activeBtn.disabled = true
        }
      }
      if (isModalOpen()) renderDiscovered()
    }

    // ---- Actions ----
    const runTest = async (): Promise<void> => {
      if (isBusy) return
      setBusy(true)
      setButtonLoading(testBtn, true, 'Testing... 0.0s')
      const stopTimer = this.createElapsedTimer((elapsed) => {
        setButtonLoading(testBtn, true, `Testing... ${elapsed}`)
      })
      try {
        if (!(await ensureUriParsed())) return
        if (!validateRequiredFields() || !ensurePasswordBeforeSubmit()) return
        showNotice('neutral', 'Testing connection...')
        const sub = buildSubmission(editId || `conn_test_${Date.now()}`)
        const res = await this.requestPlugin<{ ok: boolean; message?: string }>(
          'connection.test',
          sub,
          { timeoutMs: DEFAULT_RPC_TIMEOUT_MS }
        )
        showNotice(
          res.ok ? 'success' : 'error',
          res.message ||
            (res.ok ? 'Connection verified successfully!' : 'Connection test failed.')
        )
      } catch (err: unknown) {
        showNotice('error', `Error: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        stopTimer()
        setButtonLoading(testBtn, false)
        setBusy(false)
      }
    }

    const runSave = async (): Promise<void> => {
      if (isBusy) return
      setBusy(true)
      let phase = 'Testing...'
      setButtonLoading(saveBtn, true, 'Testing... 0.0s')
      const stopTimer = this.createElapsedTimer((elapsed) => {
        setButtonLoading(saveBtn, true, `${phase} ${elapsed}`)
      })
      let savedId = ''
      try {
        if (!(await ensureUriParsed())) return
        if (!validateRequiredFields()) return
        const targetId = editId || `conn_${driver}_${Date.now()}`
        if (!ensurePasswordBeforeSubmit()) return
        showNotice('neutral', 'Verifying & saving connection...')
        const sub = buildSubmission(targetId)
        try {
          const testRes = await this.requestPlugin<{ ok: boolean; message?: string }>(
            'connection.test',
            sub,
            { timeoutMs: DEFAULT_RPC_TIMEOUT_MS }
          )
          if (!testRes.ok) {
            showNotice('error', testRes.message || 'Connection test failed.')
            return
          }
        } catch (testErr: unknown) {
          showNotice(
            'error',
            `Connection failed: ${testErr instanceof Error ? testErr.message : String(testErr)}`
          )
          return
        }
        phase = 'Saving...'
        const res = await this.requestPlugin<{ ok: boolean; id: string }>(
          'connection.save',
          sub,
          { timeoutMs: DEFAULT_RPC_TIMEOUT_MS }
        )
        if (!res.ok) {
          showNotice('error', 'Failed to save connection.')
          return
        }
        savedId = res.id || targetId
      } catch (err: unknown) {
        showNotice('error', `Error: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        stopTimer()
        setButtonLoading(saveBtn, false)
        setBusy(false)
      }
      if (!savedId) return
      if (isModalOpen()) this.closeActiveModal()
      this.updateStatus(`Connected to ${nameInp.value.trim() || savedId}`)
      await this.activateSavedConnection(savedId)
    }

    const runDelete = async (): Promise<void> => {
      if (isBusy || !isEdit) return
      if (!deleteArmed) {
        deleteArmed = true
        deleteBtn.textContent = 'Confirm Delete?'
        if (deleteTimer !== null) clearTimeout(deleteTimer)
        deleteTimer = setTimeout(() => {
          deleteArmed = false
          deleteTimer = null
          deleteBtn.textContent = 'Delete Connection'
        }, 4000)
        return
      }
      if (deleteTimer !== null) {
        clearTimeout(deleteTimer)
        deleteTimer = null
      }
      deleteArmed = false
      setBusy(true)
      setButtonLoading(deleteBtn, true, 'Deleting...')
      let deleted = false
      try {
        const res = await this.requestPlugin<{ ok: boolean }>('connection.delete', { id: editId })
        if (!res.ok) {
          showNotice('error', 'Failed to delete connection.')
          return
        }
        deleted = true
      } catch (err: unknown) {
        showNotice('error', `Delete failed: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        setButtonLoading(deleteBtn, false)
        setBusy(false)
      }
      if (!deleted) return
      if (isModalOpen()) this.closeActiveModal()
      if (this.storedActiveConnectionId === editId) this.storedActiveConnectionId = null
      if (this.pendingDocConnectionId === editId) this.pendingDocConnectionId = null
      if (this.activeConnectionId === editId) this.handleConnectionChanged(null)
      this.updateStatus('Connection deleted')
      await this.refreshConnections()
    }

    parseBtn.addEventListener('click', () => {
      if (isBusy) return
      if (!uriInp.value.trim()) {
        showNotice('error', 'Paste a connection URI first.')
        return
      }
      void parseUri(uriInp.value, false)
    })
    uriInp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        if (!isBusy && uriInp.value.trim()) void parseUri(uriInp.value, false)
      }
    })
    detectBtn.addEventListener('click', () => {
      if (!isBusy) void detectWorkspace('', true)
    })
    scanBtn.addEventListener('click', () => {
      if (isBusy) return
      if (!folderInp.value.trim()) {
        showNotice('error', 'Enter a folder path to scan.')
        return
      }
      void detectWorkspace(folderInp.value, true)
    })
    folderInp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        scanBtn.click()
      }
    })
    nameInp.addEventListener('input', () => {
      lastAutoName = ''
    })
    passwordInp.addEventListener('input', () => {
      placeholderPending = lastParsedPlaceholder && !passwordInp.value
      passwordInp.placeholder = placeholderPending
        ? 'Required (replace placeholder password)'
        : hadPassword && isEdit
          ? 'Stored password preserved (type to replace)'
          : 'Optional'
    })
    testBtn.addEventListener('click', () => {
      void runTest()
    })
    saveBtn.addEventListener('click', () => {
      void runSave()
    })
    deleteBtn.addEventListener('click', () => {
      void runDelete()
    })
    cancelBtn.addEventListener('click', () => {
      if (!isBusy) this.closeActiveModal()
    })

    // ---- Initial population ----
    if (editProfile) {
      nameInp.value = editProfile.name || ''
      const meta = getConnectionEngineMeta(driver)
      if (driver === 'sqlite') {
        filePathInp.value = editProfile.filePath || editProfile.database || ''
      } else if (driver === 'libsql') {
        libsqlUrlInp.value = editProfile.url || ''
        libsqlDbInp.value = editProfile.database || ''
        if (hadAuthToken) authTokenInp.placeholder = 'Stored token preserved (type to replace)'
      } else {
        hostInp.value = editProfile.host || 'localhost'
        portInp.value = String(editProfile.port || meta.defaultPort)
        userInp.value = editProfile.user || ''
        sslCheck.input.checked = Boolean(editProfile.ssl)
        if (driver === 'redis') {
          redisDbSel.value = String(editProfile.redisDb ?? 0)
        } else {
          databaseInp.value = editProfile.database || ''
        }
        if (driver === 'clickhouse') chUrlInp.value = editProfile.url || ''
        if (typeof editProfile.options === 'string') optionsInp.value = editProfile.options
        if (hadPassword) passwordInp.placeholder = 'Stored password preserved (type to replace)'
      }
      applyDriver(driver, false)
    } else {
      hostInp.value = 'localhost'
      applyDriver(driver, true)
    }
    syncEnvPills()

    modal.appendChild(head)
    modal.appendChild(body)
    modal.appendChild(actions)
    backdropRef = this.mountStudioModal(modal, () => !isBusy)
    if (!backdropRef) return
    if (isEdit) {
      nameInp.focus?.()
      nameInp.select?.()
    } else {
      uriInp.focus?.()
      void detectWorkspace('', false)
    }
  }

  private openCreateTableModal(): void {
    const conn = this.getActiveConnection()
    if (!conn || conn.readOnly || conn.driver === 'redis') {
      this.updateStatus('Cannot create tables on this connection')
      return
    }
    const driver = conn.driver
    let isCreating = false

    const columns: CreateTableColumnDraft[] = [
      {
        name: 'id',
        dataType: 'INTEGER',
        nullable: false,
        defaultValue: '',
        isPrimaryKey: true,
        isAutoIncrement: true,
      },
      {
        name: 'name',
        dataType: 'TEXT',
        nullable: false,
        defaultValue: '',
        isPrimaryKey: false,
        isAutoIncrement: false,
      },
    ]

    const modal = document.createElement('div')
    modal.className = 'datanoa-create-table-modal'

    const head = document.createElement('div')
    head.className = 'datanoa-modal-head'
    const headTitle = document.createElement('span')
    headTitle.textContent = 'Create New Table'
    const badge = document.createElement('span')
    badge.className = 'datanoa-badge datanoa-badge-pk'
    badge.textContent = driver.toUpperCase()
    head.appendChild(headTitle)
    head.appendChild(badge)

    const body = document.createElement('div')
    body.className = 'datanoa-modal-body'

    const execErrBox = document.createElement('div')
    execErrBox.className = 'datanoa-modal-box error'
    execErrBox.style.display = 'none'
    body.appendChild(execErrBox)

    const topFields = document.createElement('div')
    topFields.style.display = 'flex'
    topFields.style.gap = '8px'

    const tableNameInput = document.createElement('input')
    tableNameInput.type = 'text'
    tableNameInput.className = 'datanoa-filter-input'
    tableNameInput.placeholder = 'Table name (e.g. users)'
    tableNameInput.value = 'new_table'
    tableNameInput.style.flex = '2'

    const schemaInput = document.createElement('input')
    schemaInput.type = 'text'
    schemaInput.className = 'datanoa-filter-input'
    schemaInput.placeholder = 'Schema (optional)'
    schemaInput.value =
      driver !== 'sqlite' && driver !== 'libsql' ? this.activeSchema || '' : ''
    schemaInput.style.flex = '1'
    if (driver === 'sqlite' || driver === 'libsql') {
      schemaInput.style.display = 'none'
    }

    topFields.appendChild(tableNameInput)
    topFields.appendChild(schemaInput)
    body.appendChild(topFields)

    const colsHeader = document.createElement('div')
    colsHeader.style.display = 'flex'
    colsHeader.style.justifyContent = 'space-between'
    colsHeader.style.alignItems = 'center'
    const colsTitle = document.createElement('strong')
    colsTitle.textContent = 'Columns'
    const addColBtn = document.createElement('button')
    addColBtn.type = 'button'
    addColBtn.className = 'datanoa-btn datanoa-btn-sm'
    addColBtn.textContent = '+ Add Column'
    colsHeader.appendChild(colsTitle)
    colsHeader.appendChild(addColBtn)
    body.appendChild(colsHeader)

    const colTableWrap = document.createElement('div')
    colTableWrap.className = 'datanoa-matrix-scroll'
    const colTable = document.createElement('table')
    colTable.className = 'datanoa-matrix-table datanoa-struct-grid'
    colTable.innerHTML =
      '<thead><tr><th>Name</th><th>Type</th><th>PK</th><th>AI</th><th>Null</th><th>Default</th><th></th></tr></thead>'
    const colTbody = document.createElement('tbody')
    colTable.appendChild(colTbody)
    colTableWrap.appendChild(colTable)
    body.appendChild(colTableWrap)

    const ddlLabel = document.createElement('div')
    ddlLabel.style.fontWeight = '600'
    ddlLabel.textContent = 'Live CREATE TABLE Preview:'
    const ddlPre = document.createElement('pre')
    ddlPre.className = 'datanoa-modal-sql'
    body.appendChild(ddlLabel)
    body.appendChild(ddlPre)

    const actions = document.createElement('div')
    actions.className = 'datanoa-modal-actions'
    const cancelBtn = document.createElement('button')
    cancelBtn.type = 'button'
    cancelBtn.className = 'datanoa-btn datanoa-btn-sm'
    cancelBtn.textContent = 'Cancel'
    const createBtn = document.createElement('button')
    createBtn.type = 'button'
    createBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-btn-primary'
    createBtn.textContent = 'Create Table'
    actions.appendChild(cancelBtn)
    actions.appendChild(createBtn)

    let currentSql = ''
    const updatePreview = () => {
      try {
        currentSql = buildCreateTableSql(
          {
            tableName: tableNameInput.value,
            schema: schemaInput.value.trim() || undefined,
            columns,
          },
          driver
        )
        ddlPre.textContent = currentSql
        createBtn.disabled = isCreating || !currentSql
      } catch (err: unknown) {
        currentSql = ''
        const msg = err instanceof Error ? err.message : String(err)
        ddlPre.textContent = `-- ${msg}`
        createBtn.disabled = true
      }
    }

    const renderCols = () => {
      colTbody.innerHTML = ''
      columns.forEach((col, idx) => {
        const tr = document.createElement('tr')

        const tdName = document.createElement('td')
        const nameInp = document.createElement('input')
        nameInp.type = 'text'
        nameInp.className = 'datanoa-struct-cell-input'
        nameInp.value = col.name
        nameInp.placeholder = 'column_name'
        nameInp.addEventListener('input', () => {
          col.name = nameInp.value
          updatePreview()
        })
        tdName.appendChild(nameInp)

        const tdType = document.createElement('td')
        const typeInp = document.createElement('input')
        typeInp.type = 'text'
        typeInp.className = 'datanoa-struct-cell-input'
        typeInp.value = col.dataType
        typeInp.placeholder = 'TEXT / INTEGER'
        typeInp.addEventListener('input', () => {
          col.dataType = typeInp.value
          updatePreview()
        })
        tdType.appendChild(typeInp)

        const tdPk = document.createElement('td')
        const pkCb = document.createElement('input')
        pkCb.type = 'checkbox'
        pkCb.checked = Boolean(col.isPrimaryKey)
        pkCb.addEventListener('change', () => {
          col.isPrimaryKey = pkCb.checked
          if (col.isPrimaryKey) col.nullable = false
          renderCols()
          updatePreview()
        })
        tdPk.appendChild(pkCb)

        const tdAi = document.createElement('td')
        const aiCb = document.createElement('input')
        aiCb.type = 'checkbox'
        aiCb.checked = Boolean(col.isAutoIncrement)
        aiCb.addEventListener('change', () => {
          col.isAutoIncrement = aiCb.checked
          updatePreview()
        })
        tdAi.appendChild(aiCb)

        const tdNull = document.createElement('td')
        const nullCb = document.createElement('input')
        nullCb.type = 'checkbox'
        nullCb.checked = col.nullable !== false
        nullCb.disabled = Boolean(col.isPrimaryKey)
        nullCb.addEventListener('change', () => {
          col.nullable = nullCb.checked
          updatePreview()
        })
        tdNull.appendChild(nullCb)

        const tdDef = document.createElement('td')
        const defInp = document.createElement('input')
        defInp.type = 'text'
        defInp.className = 'datanoa-struct-cell-input'
        defInp.value = col.defaultValue || ''
        defInp.placeholder = 'Default...'
        defInp.addEventListener('input', () => {
          col.defaultValue = defInp.value
          updatePreview()
        })
        tdDef.appendChild(defInp)

        const tdAct = document.createElement('td')
        const rmBtn = document.createElement('button')
        rmBtn.type = 'button'
        rmBtn.className = 'datanoa-btn datanoa-btn-sm'
        rmBtn.textContent = '×'
        rmBtn.disabled = columns.length <= 1
        rmBtn.addEventListener('click', () => {
          if (columns.length <= 1) return
          columns.splice(idx, 1)
          renderCols()
          updatePreview()
        })
        tdAct.appendChild(rmBtn)

        tr.appendChild(tdName)
        tr.appendChild(tdType)
        tr.appendChild(tdPk)
        tr.appendChild(tdAi)
        tr.appendChild(tdNull)
        tr.appendChild(tdDef)
        tr.appendChild(tdAct)
        colTbody.appendChild(tr)
      })
    }

    addColBtn.addEventListener('click', () => {
      columns.push({
        name: `col_${columns.length + 1}`,
        dataType: 'TEXT',
        nullable: true,
        defaultValue: '',
        isPrimaryKey: false,
        isAutoIncrement: false,
      })
      renderCols()
      updatePreview()
    })

    tableNameInput.addEventListener('input', updatePreview)
    schemaInput.addEventListener('input', updatePreview)
    cancelBtn.addEventListener('click', () => {
      if (!isCreating) this.closeActiveModal()
    })

    createBtn.addEventListener('click', () => {
      if (isCreating || !currentSql || !this.activeConnectionId) return
      const connId = this.activeConnectionId
      const targetName = tableNameInput.value.trim()
      const targetSchema = schemaInput.value.trim() || undefined
      isCreating = true
      execErrBox.style.display = 'none'
      cancelBtn.disabled = true
      addColBtn.disabled = true
      setButtonLoading(createBtn, true, 'Creating... 0.0s')
      const stopTimer = this.createElapsedTimer((elapsedText) => {
        setButtonLoading(createBtn, true, `Creating... ${elapsedText}`)
      })

      void (async () => {
        try {
          await this.requestPlugin<QueryResult>(
            'query.run',
            {
              connectionId: connId,
              queryId: `create_tbl_${Date.now()}`,
              sql: currentSql,
            },
            { timeoutMs: DEFAULT_RPC_TIMEOUT_MS }
          )
          stopTimer()
          isCreating = false
          this.closeActiveModal()
          if (this.activeConnectionId !== connId) return
          this.activeTable = targetName
          this.activeSchema = targetSchema
          this.showQueryBanner('success', `Table "${targetName}" Created`, currentSql)
          await this.introspectSchema(connId, false)
        } catch (err: unknown) {
          stopTimer()
          isCreating = false
          setButtonLoading(createBtn, false)
          cancelBtn.disabled = false
          addColBtn.disabled = false
          updatePreview()
          const msg = err instanceof Error ? err.message : String(err)
          execErrBox.textContent = `Create Table failed: ${msg}`
          execErrBox.style.display = 'block'
        }
      })()
    })

    renderCols()
    updatePreview()

    modal.appendChild(head)
    modal.appendChild(body)
    modal.appendChild(actions)
    this.mountStudioModal(modal, () => !isCreating)
    tableNameInput.focus?.()
    tableNameInput.select?.()
  }

  private openDangerTableModal(action: 'truncate' | 'drop', item: SchemaObject): void {
    const conn = this.getActiveConnection()
    if (!conn || conn.readOnly || conn.driver === 'redis') {
      this.updateStatus('Cannot run destructive table operation on a Read-Only or Redis connection')
      return
    }
    const driver = conn.driver
    let sql = ''
    try {
      sql =
        action === 'truncate'
          ? buildTruncateTableSql(item.name, driver, item.schema)
          : buildDropTableSql(item.name, item.kind, driver, item.schema)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      this.showQueryBanner('error', 'Operation Unavailable', msg)
      return
    }

    let isExecuting = false
    const actionTitle =
      action === 'truncate'
        ? `Truncate Table "${item.name}"`
        : item.kind === 'view'
          ? `Drop View "${item.name}"`
          : `Drop Table "${item.name}"`

    const modal = document.createElement('div')
    modal.className = 'datanoa-danger-modal'

    const head = document.createElement('div')
    head.className = 'datanoa-modal-head'
    const titleEl = document.createElement('span')
    titleEl.textContent = actionTitle
    const badge = document.createElement('span')
    badge.className = 'datanoa-badge'
    badge.style.color = 'var(--danger)'
    badge.textContent = action === 'truncate' ? 'DELETE ALL ROWS' : 'PERMANENT DROP'
    head.appendChild(titleEl)
    head.appendChild(badge)

    const body = document.createElement('div')
    body.className = 'datanoa-modal-body'

    if (conn.colorTag === 'prod') {
      const prodWarn = document.createElement('div')
      prodWarn.className = 'datanoa-modal-box error'
      prodWarn.textContent =
        'PRODUCTION CONNECTION WARNING: This action is irreversible and will immediately affect production data!'
      body.appendChild(prodWarn)
    }

    const desc = document.createElement('div')
    desc.textContent =
      action === 'truncate'
        ? `This will permanently remove all rows from "${item.name}". Type the exact table name below to confirm.`
        : `This will permanently drop ${item.kind} "${item.name}" and its data. Type the exact name below to confirm.`
    body.appendChild(desc)

    const sqlPre = document.createElement('pre')
    sqlPre.className = 'datanoa-modal-sql'
    sqlPre.textContent = sql
    body.appendChild(sqlPre)

    const confirmInput = document.createElement('input')
    confirmInput.type = 'text'
    confirmInput.className = 'datanoa-filter-input'
    confirmInput.placeholder = `Type "${item.name}" to enable confirmation`
    body.appendChild(confirmInput)

    const execErrBox = document.createElement('div')
    execErrBox.className = 'datanoa-modal-box error'
    execErrBox.style.display = 'none'
    body.appendChild(execErrBox)

    const actions = document.createElement('div')
    actions.className = 'datanoa-modal-actions'
    const cancelBtn = document.createElement('button')
    cancelBtn.type = 'button'
    cancelBtn.className = 'datanoa-btn datanoa-btn-sm'
    cancelBtn.textContent = 'Cancel'
    const confirmBtn = document.createElement('button')
    confirmBtn.type = 'button'
    confirmBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-btn-danger-solid'
    confirmBtn.textContent = action === 'truncate' ? 'Truncate Table' : `Drop ${item.kind === 'view' ? 'View' : 'Table'}`
    confirmBtn.disabled = true
    actions.appendChild(cancelBtn)
    actions.appendChild(confirmBtn)

    confirmInput.addEventListener('input', () => {
      confirmBtn.disabled = isExecuting || confirmInput.value.trim() !== item.name
    })

    cancelBtn.addEventListener('click', () => {
      if (!isExecuting) this.closeActiveModal()
    })

    confirmBtn.addEventListener('click', () => {
      if (isExecuting || confirmInput.value.trim() !== item.name || !this.activeConnectionId) return
      const connId = this.activeConnectionId
      isExecuting = true
      execErrBox.style.display = 'none'
      cancelBtn.disabled = true
      confirmInput.disabled = true
      setButtonLoading(confirmBtn, true, 'Executing... 0.0s')
      const stopTimer = this.createElapsedTimer((elapsedText) => {
        setButtonLoading(confirmBtn, true, `Executing... ${elapsedText}`)
      })

      void (async () => {
        try {
          await this.requestPlugin<QueryResult>(
            'query.run',
            {
              connectionId: connId,
              queryId: `${action}_${Date.now()}`,
              sql,
            },
            { timeoutMs: DEFAULT_RPC_TIMEOUT_MS }
          )
          stopTimer()
          isExecuting = false
          this.closeActiveModal()
          if (this.activeConnectionId !== connId) return
          this.showQueryBanner('success', `${actionTitle} Succeeded`, sql)
          if (action === 'drop') {
            if (this.isObjectActive(item.name, item.schema)) {
              this.activeTable = null
              this.activeSchema = undefined
              this.lastInspectorLoadedKey = ''
            }
            await this.introspectSchema(connId, false)
          } else if (this.isObjectActive(item.name, item.schema)) {
            await this.loadTableData(connId, item.name, 1)
          }
        } catch (err: unknown) {
          stopTimer()
          isExecuting = false
          setButtonLoading(confirmBtn, false)
          cancelBtn.disabled = false
          confirmInput.disabled = false
          confirmBtn.disabled = confirmInput.value.trim() !== item.name
          const msg = err instanceof Error ? err.message : String(err)
          execErrBox.textContent = `Execution failed: ${msg}`
          execErrBox.style.display = 'block'
        }
      })()
    })

    modal.appendChild(head)
    modal.appendChild(body)
    modal.appendChild(actions)
    this.mountStudioModal(modal, () => !isExecuting)
    confirmInput.focus?.()
  }

  private openCommandPalette(): void {
    interface PaletteEntry {
      label: string
      category: string
      searchText: string
      run: () => void
    }

    const entries: PaletteEntry[] = []
    for (const obj of this.schemaObjects) {
      entries.push({
        label: obj.schema ? `${obj.schema}.${obj.name}` : obj.name,
        category: obj.kind === 'view' ? 'View' : 'Table',
        searchText: `${obj.name} ${obj.schema || ''} ${obj.kind}`,
        run: () => {
          this.selectSidebarObject(obj)
        },
      })
    }
    for (const conn of this.connections) {
      entries.push({
        label: `${conn.name} (${conn.driver})`,
        category: 'Connection',
        searchText: `${conn.name} ${conn.driver} connection`,
        run: () => {
          this.handleConnectionChanged(conn.id)
          this.updateMetadataHeader('connectionId', conn.id)
        },
      })
    }
    entries.push(
      {
        label: 'New Database Connection...',
        category: 'Command',
        searchText: 'new add connect database connection server uri',
        run: () => this.openConnectionModal(),
      },
      {
        label: 'Format SQL (Shift+Alt+F)',
        category: 'Command',
        searchText: 'format sql prettify',
        run: () => this.formatSqlInConsole(),
      },
      {
        label: 'New Table...',
        category: 'Command',
        searchText: 'new create table',
        run: () => this.openCreateTableModal(),
      },
      {
        label: 'Toggle Sidebar / Horizontal Top Bar',
        category: 'Command',
        searchText: 'toggle sidebar topbar layout',
        run: () => this.setSidebarCollapsed(!this.sidebarCollapsed, true),
      },
      {
        label: 'Switch View Mode: Split View',
        category: 'Command',
        searchText: 'view mode split',
        run: () => this.switchMode('split'),
      },
      {
        label: 'Switch View Mode: Data Grid',
        category: 'Command',
        searchText: 'view mode data grid',
        run: () => this.switchMode('grid'),
      },
      {
        label: 'Switch View Mode: SQL Console',
        category: 'Command',
        searchText: 'view mode sql console',
        run: () => this.switchMode('sql'),
      },
      {
        label: 'Switch View Mode: Schema Inspector',
        category: 'Command',
        searchText: 'view mode schema inspector structure',
        run: () => this.switchMode('inspector'),
      },
      {
        label: 'Toggle Query History',
        category: 'Command',
        searchText: 'query history drawer',
        run: () => {
          void this.toggleQueryHistory()
        },
      },
      {
        label: 'Refresh Schema',
        category: 'Command',
        searchText: 'refresh reload schema',
        run: () => {
          void this.handleRefreshAction()
        },
      },
      {
        label: 'Keyboard Shortcuts (?)',
        category: 'Command',
        searchText: 'keyboard shortcuts help cheatsheet',
        run: () => this.openShortcutsModal(),
      }
    )

    const paletteActiveConn = this.getActiveConnection()
    if (paletteActiveConn) {
      entries.push({
        label: 'Edit Active Connection...',
        category: 'Command',
        searchText: 'edit configure connection server',
        run: () => this.openConnectionModal(paletteActiveConn),
      })
    }

    const modal = document.createElement('div')
    modal.className = 'datanoa-cmd-palette'

    const searchInp = document.createElement('input')
    searchInp.type = 'search'
    searchInp.className = 'datanoa-cmd-palette-input datanoa-filter-input'
    searchInp.placeholder = 'Jump to table, connection, or command...'

    const listEl = document.createElement('div')
    listEl.className = 'datanoa-cmd-palette-list'

    let filtered: PaletteEntry[] = []
    let activeIdx = 0

    const renderMatches = (scrollActiveIntoView = false) => {
      const q = searchInp.value.trim()
      filtered = entries
        .map((e) => ({ entry: e, score: fuzzyMatchScore(q, `${e.label} ${e.searchText}`) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 40)
        .map((x) => x.entry)

      if (activeIdx >= filtered.length) activeIdx = 0
      listEl.innerHTML = ''
      if (filtered.length === 0) {
        const empty = document.createElement('div')
        empty.className = 'datanoa-cell-null'
        empty.style.padding = '10px'
        empty.textContent = 'No matching tables, connections, or commands.'
        listEl.appendChild(empty)
        return
      }

      filtered.forEach((item, idx) => {
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = `datanoa-cmd-palette-item${idx === activeIdx ? ' active' : ''}`
        const labelSpan = document.createElement('span')
        labelSpan.textContent = item.label
        const catSpan = document.createElement('span')
        catSpan.className = 'datanoa-badge'
        catSpan.textContent = item.category
        btn.appendChild(labelSpan)
        btn.appendChild(catSpan)
        btn.addEventListener('click', () => {
          this.closeActiveModal()
          item.run()
        })
        listEl.appendChild(btn)
        if (scrollActiveIntoView && idx === activeIdx) {
          btn.scrollIntoView?.({ block: 'nearest' })
        }
      })
    }

    searchInp.addEventListener('input', () => {
      activeIdx = 0
      renderMatches(false)
    })

    searchInp.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (filtered.length > 0) {
          activeIdx = (activeIdx + 1) % filtered.length
          renderMatches(true)
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (filtered.length > 0) {
          activeIdx = (activeIdx - 1 + filtered.length) % filtered.length
          renderMatches(true)
        }
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const target = filtered[activeIdx]
        if (target) {
          this.closeActiveModal()
          target.run()
        }
      }
    })

    renderMatches(false)
    modal.appendChild(searchInp)
    modal.appendChild(listEl)
    this.mountStudioModal(modal)
    searchInp.focus?.()
  }

  private openShortcutsModal(): void {
    const modal = document.createElement('div')
    modal.className = 'datanoa-shortcuts-modal'

    const head = document.createElement('div')
    head.className = 'datanoa-modal-head'
    const titleEl = document.createElement('span')
    titleEl.textContent = 'Keyboard Shortcuts'
    const closeBtn = document.createElement('button')
    closeBtn.type = 'button'
    closeBtn.className = 'datanoa-btn datanoa-btn-sm'
    closeBtn.textContent = 'Close'
    closeBtn.addEventListener('click', () => this.closeActiveModal())
    head.appendChild(titleEl)
    head.appendChild(closeBtn)

    const body = document.createElement('div')
    body.className = 'datanoa-modal-body'

    const groups: ReadonlyArray<{
      title: string
      items: ReadonlyArray<[string, string]>
    }> = [
      {
        title: 'SQL Console',
        items: [
          ['Ctrl+Enter / Cmd+Enter', 'Execute statement at caret (or selection)'],
          ['Ctrl+Shift+Enter', 'Execute all statements in console'],
          ['Shift+Alt+F', 'Format SQL in console'],
        ],
      },
      {
        title: 'Data Grid & Selection',
        items: [
          ['Arrow / Shift+Arrow', 'Navigate cells & extend rectangular selection'],
          ['Ctrl+A', 'Select all visible cells'],
          ['Ctrl+C / Ctrl+V', 'Copy selection as TSV / Paste TSV or CSV'],
          ['Enter / F2', 'Edit focused cell inline'],
          ['Delete / Backspace', 'Set selected cells to NULL'],
          ['Ctrl+F', 'Find & highlight cells in grid'],
          ['Ctrl+S', 'Submit staged data edits or schema migration'],
          ['Ctrl+Scroll', 'Horizontal pan across wide tables'],
          ['Ctrl+Click (FK cell)', 'Jump to referenced Foreign Key row'],
        ],
      },
      {
        title: 'Studio Navigation',
        items: [
          ['Ctrl+K / Ctrl+P', 'Open Quick Switcher / Command Palette'],
          ['Ctrl+/', 'Open Keyboard Shortcuts cheatsheet'],
          ['Escape', 'Close active menu, popover, or modal'],
        ],
      },
    ]

    for (const grp of groups) {
      const box = document.createElement('div')
      box.className = 'datanoa-modal-box'
      const grpTitle = document.createElement('strong')
      grpTitle.textContent = grp.title
      box.appendChild(grpTitle)

      const list = document.createElement('div')
      list.style.display = 'grid'
      list.style.gridTemplateColumns = '190px 1fr'
      list.style.gap = '4px 12px'
      list.style.marginTop = '6px'

      for (const [keys, desc] of grp.items) {
        const kbd = document.createElement('kbd')
        kbd.textContent = keys
        const descSpan = document.createElement('span')
        descSpan.style.color = 'var(--muted)'
        descSpan.textContent = desc
        list.appendChild(kbd)
        list.appendChild(descSpan)
      }
      box.appendChild(list)
      body.appendChild(box)
    }

    modal.appendChild(head)
    modal.appendChild(body)
    this.mountStudioModal(modal)
  }

  private async refreshSchemaObjectsOnly(connectionId: string): Promise<void> {
    if (typeof window === 'undefined' || !window.orca?.plugin?.request) return
    const reqToken = this.introspectToken
    try {
      const objects = await this.requestPlugin<SchemaObject[]>(
        'schema.listObjects',
        { connectionId },
        { timeoutMs: DEFAULT_RPC_TIMEOUT_MS }
      )
      if (reqToken !== this.introspectToken || this.activeConnectionId !== connectionId) return
      this.schemaObjects = objects || []
      const nextMap: Record<string, string[]> = {}
      for (const obj of this.schemaObjects) {
        nextMap[obj.name] = this.schemaMap[obj.name] || []
      }
      this.schemaMap = nextMap
      this.sqlConsole?.updateSchema(this.schemaMap, this.activeTable || undefined)
      this.renderSidebarObjects()
      if (this.activeViewMode === 'inspector' && this.activeTable) {
        void this.loadActiveTableSchema(true)
      }
    } catch {
      // Ignore background refresh error
    }
  }

  public async handleAlterTable(action: AlterTableAction): Promise<void> {
    if (!this.activeConnectionId) {
      this.updateStatus('Select a connection first')
      return
    }
    if (this.isActiveConnectionReadOnly()) {
      this.showQueryBanner('error', 'Read-Only Connection', 'Cannot alter table structure on a Read-Only connection.')
      this.updateStatus('Cannot alter table structure on a Read-Only connection')
      return
    }
    const driver: DatabaseDriverType = this.getActiveConnection()?.driver || 'sqlite'
    let sql = ''
    try {
      sql = buildAlterTableSql(action, driver)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      this.showQueryBanner('error', 'ALTER TABLE Validation Error', msg)
      this.updateStatus(`ALTER TABLE error: ${msg}`)
      return
    }

    const targetConnId = this.activeConnectionId
    const queryId = `alter_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    this.updateStatus(`Executing: ${sql}`)
    try {
      await this.requestPlugin<QueryResult>(
        'query.run',
        {
          connectionId: targetConnId,
          queryId,
          sql,
        },
        { timeoutMs: DEFAULT_RPC_TIMEOUT_MS }
      )
      if (this.activeConnectionId !== targetConnId) return
      if (action.kind === 'renameTable') {
        this.activeTable = action.newTableName.trim()
        this.updateMetadataHeader('table', this.activeTable)
      }
      this.tableDetailsCache.clear()
      this.inFlightTableDetails.clear()
      this.lastInspectorLoadedKey = ''
      this.showQueryBanner('success', 'Table Structure Updated', sql)
      this.updateStatus(`Executed: ${sql}`)
      this.saveStudioViewState(true)
      await this.introspectSchema(targetConnId, true)
      if (this.activeConnectionId === targetConnId && this.activeViewMode === 'inspector') {
        await this.loadActiveTableSchema(true)
      }
    } catch (err: unknown) {
      if (this.activeConnectionId !== targetConnId) return
      const msg = err instanceof Error ? err.message : String(err)
      this.showQueryBanner('error', 'ALTER TABLE Failed', msg)
      this.updateStatus(`ALTER TABLE error: ${msg}`)
    }
  }

  public async handleApplyMigration(
    statements: string[],
    draft: TableStructureDraft
  ): Promise<void> {
    if (!this.activeConnectionId) {
      const errMsg = 'Select a connection first'
      this.updateStatus(errMsg)
      throw new Error(errMsg)
    }
    if (this.isActiveConnectionReadOnly()) {
      const errMsg = 'Cannot apply schema changes on a Read-Only connection.'
      this.showQueryBanner('error', 'Read-Only Connection', errMsg)
      this.updateStatus(errMsg)
      throw new Error(errMsg)
    }
    if (!statements || statements.length === 0) {
      this.updateStatus('No schema changes to apply')
      return
    }

    const targetConnId = this.activeConnectionId
    const sqlBatch = statements.join('\n')
    const queryId = `migrate_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    this.updateStatus(`Applying ${statements.length} migration statement(s)...`)
    try {
      await this.requestPlugin<QueryResult>(
        'query.run',
        {
          connectionId: targetConnId,
          queryId,
          sql: sqlBatch,
        },
        { timeoutMs: DEFAULT_RPC_TIMEOUT_MS }
      )
      if (this.activeConnectionId !== targetConnId) return
      const nextTable = (draft.tableName || '').trim()
      if (nextTable && nextTable !== this.activeTable) {
        this.activeTable = nextTable
        this.updateMetadataHeader('table', nextTable)
      }
      this.tableDetailsCache.clear()
      this.inFlightTableDetails.clear()
      this.lastInspectorLoadedKey = ''
      this.showQueryBanner('success', 'Table Schema Migration Applied', sqlBatch)
      this.updateStatus(`Applied ${statements.length} migration statement(s)`)
      this.saveStudioViewState(true)
      await this.introspectSchema(targetConnId, true)
      if (this.activeConnectionId === targetConnId && this.activeViewMode === 'inspector') {
        await this.loadActiveTableSchema(true)
      }
    } catch (err: unknown) {
      if (this.activeConnectionId !== targetConnId) {
        throw err instanceof Error ? err : new Error(String(err))
      }
      const msg = err instanceof Error ? err.message : String(err)
      this.showQueryBanner('error', 'Schema Migration Failed', msg)
      this.updateStatus(`Schema migration error: ${msg}`)
      throw err instanceof Error ? err : new Error(msg)
    }
  }

  private async handleGridSort(column: string, direction: 'ASC' | 'DESC'): Promise<void> {
    if (this.isShowingSqlResult) {
      this.dataGrid?.sortInMemoryRows(column, direction)
      this.updateStatus(`Sorted query result by ${column} ${direction}`)
      return
    }
    if (
      !this.activeConnectionId ||
      !this.activeTable ||
      typeof window === 'undefined' ||
      !window.orca?.plugin?.request
    )
      return

    this.activeOrderByClause = undefined
    if (this.orderByInputEl) this.orderByInputEl.value = ''

    await this.loadTableData(this.activeConnectionId, this.activeTable, this.currentPage, {
      column,
      direction,
    })
  }

  private async handleUpdateCell(params: {
    primaryKeys: Record<string, unknown>
    column: string
    newValue: unknown
    originalValue: unknown
    rowIndex: number
  }): Promise<{ ok: boolean; affectedRows?: number; updatedRecord?: Record<string, unknown> }> {
    if (
      !this.activeConnectionId ||
      !this.activeTable ||
      this.isActiveConnectionReadOnly() ||
      typeof window === 'undefined' ||
      !window.orca?.plugin?.request
    ) {
      return { ok: false }
    }

    try {
      this.updateStatus(`Saving ${params.column}...`)
      const res = await this.requestPlugin<{
        ok: boolean
        affectedRows?: number
        updatedRecord?: Record<string, unknown>
      }>('data.updateCell', {
        connectionId: this.activeConnectionId,
        table: this.activeTable,
        ...(this.activeSchema ? { schema: this.activeSchema } : {}),
        primaryKeys: params.primaryKeys,
        column: params.column,
        newValue: params.newValue,
        originalValue: params.originalValue,
      })

      if (res.ok) {
        this.updateStatus(`Cell '${params.column}' saved successfully`)
        return res
      }
      this.updateStatus(`Conflict: cell '${params.column}' was modified concurrently`)
      return { ok: false }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      this.updateStatus(`Update failed: ${msg}`)
      return { ok: false }
    }
  }

  public updateStatus(stateText: string, metricsText?: string): void {
    if (this.statusStateEl) {
      this.statusStateEl.textContent = stateText
    }
    if (metricsText && this.statusMetricsEl) {
      this.statusMetricsEl.textContent = metricsText
    }
  }

  public getSqlConsole(): SqlConsoleController | null {
    return this.sqlConsole
  }

  public getDataGrid(): VirtualDataGrid | null {
    return this.dataGrid
  }

  public getSchemaInspector(): SchemaInspectorView | null {
    return this.schemaInspector
  }

  public destroy(): void {
    this.flushStudioViewState()
    this.cancelClientSearchDebounce()
    this.introspectToken++
    this.gridViewSeq++
    this.tableLoadToken++
    this.schemaLoadToken++
    this.querySeq++
    this.connectionsSeq++
    this.historySeq++
    this.dmlPreviewSeq++
    this.countRowsSeq++
    this.cancelledQueryIds.clear()
    this.inFlightTableDetails.clear()
    this.stopAllTimers()

    if (this.splitResizeRafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.splitResizeRafId)
      this.splitResizeRafId = null
    }
    if (this.splitResizeListeners && typeof window !== 'undefined') {
      window.removeEventListener('mousemove', this.splitResizeListeners.move)
      window.removeEventListener('mouseup', this.splitResizeListeners.up)
      window.removeEventListener('blur', this.splitResizeListeners.blur)
      this.splitResizeListeners = null
    }
    if (typeof document !== 'undefined' && document.body) {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    this.closeSidebarContextMenu()
    this.closeTopbarPopover()
    this.closeColumnsPopover()
    this.closeActiveModal()

    this.replaceSub?.dispose()
    this.replaceSub = null
    this.documentSession?.dispose?.()
    this.documentSession = null

    for (const sub of this.disposables) {
      try {
        sub.dispose()
      } catch {
        // Ignore disposal errors
      }
    }
    this.disposables.length = 0

    this.sqlConsole?.destroy()
    this.sqlConsole = null

    this.dataGrid?.destroy()
    this.dataGrid = null

    this.schemaInspector?.destroy()
    this.schemaInspector = null

    this.rootEl?.remove()
    this.rootEl = null

    this.styleEl?.remove()
    this.styleEl = null
  }
}

export function initializeEditor(): DatanoaStudioEditor | null {
  if (typeof document === 'undefined') return null
  return new DatanoaStudioEditor()
}

// Bootstrap custom editor frame with orca.document session attachment
if (
  typeof window !== 'undefined' &&
  (window as unknown as { orca?: { document?: { session: () => Promise<DocumentSessionLike> } } }).orca?.document
) {
  void (
    window as unknown as { orca: { document: { session: () => Promise<DocumentSessionLike> } } }
  ).orca.document
    .session()
    .then((session) => {
      const editor = initializeEditor()
      if (editor && session) {
        editor.attachDocumentSession(session)
      }
    })
    .catch(() => {
      initializeEditor()
    })
} else {
  initializeEditor()
}
