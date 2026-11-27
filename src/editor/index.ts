// src/editor/index.ts
// Datanoa Studio Editor: Full-Screen Datanoa Studio Custom Editor for .sql and .datanoa files
// Theme variables bound from Orca host: var(--orca-background), var(--orca-foreground), var(--orca-primary), var(--orca-border)

import {
  buildAlterTableSql,
  buildQuickFilterPredicate,
  buildTableMigrationSql,
  containsDdlStatement,
  countTableStructureChanges,
  createInitialTableDraft,
  formatSql,
  normalizeSqlDefaultExpression,
  requiresSqliteTableRebuild,
  sanitizeFilterClause,
  validateTableStructureDraft,
  type AlterTableAction,
  type DraftColumnItem,
  type DraftForeignKeyItem,
  type DraftIndexItem,
  type ReferentialAction,
  type TableMigrationPlan,
  type TableStructureDraft,
} from '../drivers/common/sql-tools.js'
import {
  SqlConsoleController,
  type SqlDialectType,
  type EditorTypography,
  type SqlExecutionRange,
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
  getCellValue,
  setCellValue,
  cloneRowData,
  isNativeDomElement,
  type SelectedCellInfo,
} from './grid.js'
import { copyTextToClipboardAsync } from './grid-formatters.js'
import {
  areTableDisplayStateEntriesEquivalent,
  normalizeTableDisplayStateEntry,
  rebaseTableDisplayStateEntry,
} from '../shared-table-display.js'
import {
  isActiveSqlStatementSensitive,
  type CmInlineAiRequestErrorContext,
} from '../shared-cm-inline-ai.js'
import {
  SchemaInspectorView,
  formatDdlForDisplay,
  COMMON_COLUMN_TYPES,
  REFERENTIAL_ACTIONS,
  DDL_KEYWORDS,
  DDL_TYPES,
  DDL_TOKEN_REGEX,
  appendFormattedDdl,
  escapeHtml,
  normalizeTableDetailsForDraft,
} from './schema-inspector.js'
import { EDITOR_STYLE as THEME_EDITOR_STYLE } from './theme.js'
import {
  DB_LOGO_COLORS,
  STUDIO_ENGINES,
  CONNECTION_ENGINES,
  CONNECTION_ENV_TAGS,
  getStudioEngineMeta,
  getConnectionEngineMeta,
  isKnownConnectionDriver,
  createSvgElement,
  createDbLogoSvg,
  setButtonLoading,
  formatAggregateNumber,
  formatRelativeTimestamp,
  downloadTextFile,
  extractPredicateColumnName,
  isEditableShortcutTarget,
  parseClientQuickFilterPredicate,
  fuzzyMatchScore,
  extractQueriedTableName,
  copyTextFallback,
  enhanceStudioCollapsibleSelect,
  groupConnectionsForSelector,
  syncStudioSelectTooltip,
  bindStudioSelectTooltipsInRoot,
  isStudioCollapsibleDropdownOpen,
  closeActiveStudioCollapsibleDropdown,
  type StudioEngineMeta,
  type ConnectionEngineMeta,
} from './db-icons.js'
import {
  openStudioConnectionModal,
  maskUriSecret,
  maskConnectionUriSecret,
  compactFilePath,
  type StudioConnectionModalContext,
  type ConnectionSubmission,
  type ParseUriResponse,
  type DiscoveredSqliteFile,
  type DiscoveredEnvConnection,
  type WorkspaceDetectResponse,
} from './connection-modal.js'
import {
  openStudioDriverManagerModal,
  openDriverManagerModal,
} from './driver-manager-modal.js'
import {
  openStudioCreateTableModal,
  openCreateTableModal,
  openStudioDangerTableModal,
  openDangerTableModal,
  openStudioCommandPalette,
  openCommandPalette,
  openStudioShortcutsModal,
  openShortcutsModal,
  openStudioFeedbackModal,
  openFeedbackModal,
  openStudioImportModal,
  openImportDataModal,
  sanitizeDiagnosticErrorText,
  buildStudioDiagnosticSummary,
  type StudioImportDataModalContext,
} from './studio-modals.js'
import {
  decodeImportBytes,
  detectImportFormat,
  detectImportDelimiter,
  parseDelimitedImportText,
  parseImportText,
  parseImportBytes,
  autoMapImportColumns,
  validateImportMapping,
  coerceImportCellValue,
  buildMappedImportRecords,
  buildImportPreviewSql,
} from './data-import.js'
import {
  ConsoleTabsManager,
  type SqlConsoleTabState,
  type PersistedConsoleTabsState,
  type ResultBannerState,
  type ResultSetTabRuntimeState,
  type EditableSqlTargetMeta,
  type SqlFixTargetRange,
} from './console-tabs.js'
import {
  compactSqlPreview,
  getEffectiveResultSets,
  getDefaultResultSetIndex,
  buildResultSetQueryResult,
  buildBannerForResultSet,
  buildInitialResultTabStates,
  buildCombinedExplainResult,
  shouldShowQueryBannerForMode,
  isGridVisibleMode,
  formatGridStatusMetrics,
} from './result-set-controller.js'
import { ErDiagramView } from './er-diagram-view.js'
import {
  extractSqlParameters,
  coerceBindParamValue,
  bindSqlParameters,
  type DetectedSqlParam,
  type BindParamInput,
  type BindParamValueType,
} from './sql-params.js'
import {
  openStudioBindParamsModal,
  type StudioBindParamsModalContext,
} from './bind-params-modal.js'
import {
  createRememberedBindParamsStore,
  openSharedBindParamsModal,
  type RememberedBindParamsStore,
} from '../shared-bind-params-modal.js'
import {
  analyzeDangerousSql,
  type DangerousSqlFinding,
  type DangerousSqlKind,
} from './sql-safety.js'
import {
  containsSensitiveSqlText,
  sanitizeSqlResultForStorage,
} from '../shared-sql-safety.js'
import {
  remapSqlTargetRange,
  resolveSqlReplacementSpan,
  splitExplainTargetStatements,
} from '../shared-sql-core.js'
import {
  normalizeShortcutSettings,
  parseShortcutBinding,
  type EditorKeymapSettings,
  type VimModeSnapshot,
} from '../shared-cm-keymap.js'
import {
  openSharedSshHostKeyModal,
  closeByChallengeId,
} from '../shared-ssh-hostkey-modal.js'
import { resolveExecutionErrorFixTarget } from '../shared-sql-diagnostics.js'
import {
  openStudioDangerSqlModal,
  type StudioDangerSqlModalContext,
} from './danger-sql-modal.js'
import {
  openStudioSavedQueriesModal,
  openSavedQueriesModal,
  type StudioSavedQueriesModalContext,
} from './saved-queries-modal.js'
import {
  analyzeEditableSelectQuery,
  type EditableSelectAnalysis,
} from './select-editability.js'
import {
  buildColumnHeaderPredicate,
  injectSqlColumnFilter,
  type ColumnHeaderFilterOp,
} from './sql-column-filter.js'
import { TransactionToolbarController } from './transaction-toolbar.js'
import { ValueInspectorController } from './value-inspector.js'
import { QueryHistoryDrawerController } from './query-history-drawer.js'
import {
  STUDIO_VIEW_STATE_STORAGE_KEY,
  parseDatanoaDocument,
  composeDatanoaDocument,
  upsertDatanoaMetadataHeader,
  removeDatanoaMetadataHeader,
  sanitizeNumberRecord,
  sanitizeStringRecord,
  sanitizeStringArrayRecord,
  readLocalStudioViewState,
  writeStudioViewStateSnapshot,
  readLocalStudioWarmCache,
  writeLocalStudioWarmCache,
  syncInitialThemeFromHost as detectInitialThemeFromHost,
  isValidStudioViewMode,
  stripDatanoaViewModeHeader,
  type DocumentSessionLike,
  type TableColumnConfig,
  type StudioPersistedViewState,
  type StudioWarmCacheSnapshot,
} from './document-meta.js'
import {
  populateExportDropdownOptions,
  executeStudioExportAction,
} from './studio-export.js'
import { createStudioDomTree } from './studio-dom.js'
import {
  isTabularObjectKind,
  formatQualifiedSqlTable,
  buildSqlTemplateForObject,
  createSidebarContextMenu,
  renderStudioSidebarSkeleton,
  renderStudioTopbarObjects,
  renderStudioTopbarObjectsPopover,
  renderStudioSidebarList,
} from './studio-sidebar.js'
import { mountStudioColumnsPopover } from './studio-columns-popover.js'
import { splitSqlStatements } from '../drivers/common/sql-lexer.js'
export { analyzeEditableSelectQuery, type EditableSelectAnalysis }
import {
  ACTIVE_CONNECTION_STORAGE_KEY,
  SAVED_CONNECTIONS_STORAGE_KEY,
  SAVED_FOLDER_ORDER_STORAGE_KEY,
  sanitizeJsonPayload,
  type AiExplainAnalysisResult,
  type AiFixQueryResult,
  type AiMetricKind,
  type AiRole,
  type AiRoleStatus,
  type AiStatusSnapshot,
  type ColumnInfo,
  type ConnectionProfile,
  type DatabaseDriverType,
  type QueryResult,
  type QueryResultSet,
  type SshHostKeyDecision,
  type StudioViewMode,
  type TableBrowseResult,
  type TableDetails,
  type TableDisplayStateEntry,
  type SchemaCatalogObjectsResult,
  type SchemaObject,
  type SchemaObjectKind,
} from '../protocol.js'
import type { CollapsibleSelectBadge } from '../shared-collapsible-select.js'
import {
  UNGROUPED_FOLDER_ORDER_KEY,
  getConnectionFolderOrderKeys,
  normalizeConnectionFolderKey,
  normalizeFolderOrder,
  reconcileFolderOrder,
  reorderConnectionsWithinFolder,
} from '../shared-connection-order.js'
import {
  openSharedAiConfigModal,
  renderAiStatusButtonContent,
  renderSharedAiFixPanel,
  renderSharedExplainAiPanel,
  resolveExplainAiPhase,
  saveOrcaSettingsPatch,
  type ExplainAiPanelState,
} from '../shared-ai-ui.js'
import { DEFAULT_RPC_TIMEOUT_MS } from '../shared-constants.js'

function extractFailedStatementMetaFromError(err: unknown): {
  failedStatementIndex: number | null
  statementCount: number | null
} {
  if (!err || typeof err !== 'object') {
    return { failedStatementIndex: null, statementCount: null }
  }
  const rawIdx =
    'failedStatementIndex' in err
      ? (err as { failedStatementIndex?: unknown }).failedStatementIndex
      : undefined
  const rawCount =
    'statementCount' in err ? (err as { statementCount?: unknown }).statementCount : undefined
  const failedStatementIndex =
    typeof rawIdx === 'number' && Number.isInteger(rawIdx) && rawIdx >= 0 ? rawIdx : null
  const statementCount =
    typeof rawCount === 'number' && Number.isInteger(rawCount) && rawCount > 0 ? rawCount : null
  return { failedStatementIndex, statementCount }
}

const BASE_EDITOR_TOKENS = `
  :root {
    --bg: var(--orca-background, #000000);
    --text: var(--orca-foreground, #e6e6e6);
    --surface: color-mix(in srgb, var(--text) 2%, var(--bg));
    --border: var(--orca-border, color-mix(in srgb, var(--text) 12%, var(--bg)));
    --muted: var(--orca-muted-foreground, color-mix(in srgb, var(--text) 68%, var(--bg)));
    --accent: var(--orca-accent, color-mix(in srgb, var(--text) 7%, var(--bg)));
    --accent-ring: var(--orca-ring, var(--orca-primary, #e6e6e6));
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
  COMMON_COLUMN_TYPES,
  REFERENTIAL_ACTIONS,
  DDL_KEYWORDS,
  DDL_TYPES,
  DDL_TOKEN_REGEX,
  appendFormattedDdl,
  escapeHtml,
  normalizeTableDetailsForDraft,
  extractExecutableSql,
  extractCaretStatementSql,
  computeSmartSqlCompletions,
  copyTextToClipboard,
  formatGridModel,
  formatCellValue,
  calculateVisibleWindow,
  checkCellEditGate,
  coerceCellInputValue,
  getCellValue,
  setCellValue,
  cloneRowData,
  isNativeDomElement,
  DB_LOGO_COLORS,
  STUDIO_ENGINES,
  CONNECTION_ENGINES,
  CONNECTION_ENV_TAGS,
  getStudioEngineMeta,
  getConnectionEngineMeta,
  isKnownConnectionDriver,
  createSvgElement,
  createDbLogoSvg,
  setButtonLoading,
  formatAggregateNumber,
  formatRelativeTimestamp,
  downloadTextFile,
  extractPredicateColumnName,
  isEditableShortcutTarget,
  parseClientQuickFilterPredicate,
  fuzzyMatchScore,
  extractQueriedTableName,
  copyTextFallback,
  openStudioConnectionModal,
  maskUriSecret,
  maskConnectionUriSecret,
  compactFilePath,
  openStudioCreateTableModal,
  openCreateTableModal,
  openStudioDangerTableModal,
  openDangerTableModal,
  openStudioCommandPalette,
  openCommandPalette,
  openStudioShortcutsModal,
  openShortcutsModal,
  openStudioFeedbackModal,
  openFeedbackModal,
  openStudioImportModal,
  openImportDataModal,
  decodeImportBytes,
  detectImportFormat,
  detectImportDelimiter,
  parseDelimitedImportText,
  parseImportText,
  parseImportBytes,
  autoMapImportColumns,
  validateImportMapping,
  coerceImportCellValue,
  buildMappedImportRecords,
  buildImportPreviewSql,
  sanitizeDiagnosticErrorText,
  buildStudioDiagnosticSummary,
  buildAlterTableSql,
  buildTableMigrationSql,
  createInitialTableDraft,
  countTableStructureChanges,
  normalizeSqlDefaultExpression,
  validateTableStructureDraft,
  type StudioEngineMeta,
  type ConnectionEngineMeta,
  type StudioConnectionModalContext,
  type StudioImportDataModalContext,
  type ConnectionSubmission,
  type ParseUriResponse,
  type DiscoveredSqliteFile,
  type DiscoveredEnvConnection,
  type WorkspaceDetectResponse,
  type TableMigrationPlan,
  type TableStructureDraft,
  type DraftColumnItem,
  type DraftIndexItem,
  type DraftForeignKeyItem,
  type ReferentialAction,
  ConsoleTabsManager,
  type SqlConsoleTabState,
  type PersistedConsoleTabsState,
  extractSqlParameters,
  coerceBindParamValue,
  bindSqlParameters,
  type DetectedSqlParam,
  type BindParamInput,
  type BindParamValueType,
  openStudioBindParamsModal,
  type StudioBindParamsModalContext,
  analyzeDangerousSql,
  type DangerousSqlFinding,
  type DangerousSqlKind,
  openStudioDangerSqlModal,
  type StudioDangerSqlModalContext,
  openStudioSavedQueriesModal,
  openSavedQueriesModal,
  type StudioSavedQueriesModalContext,
}

const V2_STUDIO_TABLE_KEY_COMPONENT_RE = /[:%|]|^\s|\s$/

function buildStudioTableKey(
  connectionId: string,
  schema: string | undefined,
  table: string
): string {
  const rawConn = connectionId == null ? '' : String(connectionId)
  const conn = rawConn.trim().length > 0 ? rawConn : 'none'
  const sch = schema == null ? '' : String(schema)
  const tbl = table == null ? '' : String(table)
  if (
    conn === 'v2' ||
    V2_STUDIO_TABLE_KEY_COMPONENT_RE.test(conn) ||
    V2_STUDIO_TABLE_KEY_COMPONENT_RE.test(sch) ||
    V2_STUDIO_TABLE_KEY_COMPONENT_RE.test(tbl)
  ) {
    return `v2:${encodeURIComponent(conn)}:${encodeURIComponent(sch)}:${encodeURIComponent(tbl)}`
  }
  return `${conn}:${sch}:${tbl}`
}

function buildLegacyStudioTableKey(
  connectionId: string,
  schema: string | undefined,
  table: string
): string {
  return `${connectionId || ''}:${schema || ''}:${table || ''}`
}

function canUseLegacyStudioTableKeyFallback(
  connectionId: string,
  schema: string | undefined,
  table: string
): boolean {
  const rawConn = connectionId == null ? '' : String(connectionId)
  const conn = rawConn.trim().length > 0 ? rawConn : 'none'
  const sch = schema == null ? '' : String(schema)
  const tbl = table == null ? '' : String(table)
  return (
    conn !== 'v2' &&
    !V2_STUDIO_TABLE_KEY_COMPONENT_RE.test(conn) &&
    !V2_STUDIO_TABLE_KEY_COMPONENT_RE.test(sch) &&
    !V2_STUDIO_TABLE_KEY_COMPONENT_RE.test(tbl)
  )
}

function normalizeStudioTableKey(rawKey: string): string {
  const raw = rawKey == null ? '' : String(rawKey)
  if (!raw.startsWith('v2:')) return raw
  const parts = raw.slice(3).split(':')
  if (parts.length !== 3) return raw
  try {
    return buildStudioTableKey(
      decodeURIComponent(parts[0]),
      decodeURIComponent(parts[1]),
      decodeURIComponent(parts[2])
    )
  } catch {
    return raw
  }
}

function studioTableKeyMatchesConnection(key: string, connectionId: string): boolean {
  if (!key || !connectionId) return false
  const conn = connectionId.trim()
  if (!conn) return false
  if (key.startsWith('v2:')) {
    const parts = key.slice(3).split(':')
    if (parts.length !== 3) return false
    try {
      const decodedConn = decodeURIComponent(parts[0])
      return decodedConn === connectionId || decodedConn === conn
    } catch {
      return false
    }
  }
  return key.startsWith(`${connectionId}:`) || key.startsWith(`${conn}:`)
}

function extractDatanoaDocumentAction(docText: string): 'import' | null {
  const lines = docText.split('\n')
  for (const line of lines) {
    const rawLine = line.replace(/\r$/, '')
    const match = /^--\s*datanoa:\s*(.+)$/i.exec(rawLine)
    if (!match) break
    const kv = /^([A-Za-z0-9_]+)=(.*)$/.exec(match[1].trim())
    if (kv && kv[1].toLowerCase() === 'action' && kv[2].trim().toLowerCase() === 'import') {
      return 'import'
    }
  }
  return null
}

function stripDatanoaActionHeader(metadataLines: readonly string[]): string[] {
  return metadataLines.filter((line) => !/^--\s*datanoa:\s*action=/i.test(line))
}

const CONSUMED_NAV_TOKENS_STORAGE_KEY = 'datanoa.consumedNavTokens'
const MAX_CONSUMED_NAV_TOKENS = 200

function extractDatanoaDocumentNavToken(docText: string): string | null {
  const lines = docText.split('\n')
  for (const line of lines) {
    const rawLine = line.replace(/\r$/, '')
    const match = /^--\s*datanoa:\s*(.+)$/i.exec(rawLine)
    if (!match) break
    const kv = /^([A-Za-z0-9_]+)=(.*)$/.exec(match[1].trim())
    if (kv && kv[1].toLowerCase() === 'navtoken') {
      const tok = kv[2].trim()
      return tok || null
    }
  }
  return null
}

function stripDatanoaNavTokenHeader(metadataLines: readonly string[]): string[] {
  return metadataLines.filter((line) => !/^--\s*datanoa:\s*navToken=/i.test(line))
}

function readStoredConsumedNavTokens(): string[] {
  if (typeof window === 'undefined' || !window.localStorage) return []
  try {
    const raw = window.localStorage.getItem(CONSUMED_NAV_TOKENS_STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((x): x is string => typeof x === 'string' && x.length > 0)
  } catch {
    return []
  }
}

function hasStoredConsumedNavToken(token: string): boolean {
  return readStoredConsumedNavTokens().includes(token)
}

function markStoredConsumedNavToken(localSet: Set<string>, token: string): void {
  localSet.add(token)
  if (localSet.size > MAX_CONSUMED_NAV_TOKENS) {
    const oldest = localSet.values().next().value
    if (oldest !== undefined) localSet.delete(oldest)
  }
  if (typeof window === 'undefined' || !window.localStorage) return
  try {
    const existing = readStoredConsumedNavTokens().filter((t) => t !== token)
    existing.push(token)
    const bounded =
      existing.length > MAX_CONSUMED_NAV_TOKENS
        ? existing.slice(existing.length - MAX_CONSUMED_NAV_TOKENS)
        : existing
    window.localStorage.setItem(CONSUMED_NAV_TOKENS_STORAGE_KEY, JSON.stringify(bounded))
  } catch {
    // Ignore storage quota/access errors
  }
}

function matchesKeyboardShortcut(e: KeyboardEvent, shortcut: string): boolean {
  const parsed = parseShortcutBinding(shortcut)
  if (!parsed.ok || !Array.isArray(parsed.mods) || typeof parsed.key !== 'string') return false
  const isMac =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || '')
  let wantCtrl = false
  let wantMeta = false
  let wantAlt = false
  let wantShift = false
  for (const mod of parsed.mods) {
    if (mod === 'Mod') {
      if (isMac) wantMeta = true
      else wantCtrl = true
    } else if (mod === 'Ctrl') wantCtrl = true
    else if (mod === 'Meta') wantMeta = true
    else if (mod === 'Alt') wantAlt = true
    else if (mod === 'Shift') wantShift = true
  }
  if (
    Boolean(e.ctrlKey) !== wantCtrl ||
    Boolean(e.metaKey) !== wantMeta ||
    Boolean(e.altKey) !== wantAlt ||
    Boolean(e.shiftKey) !== wantShift
  ) {
    return false
  }
  const eventKey = e.key === ' ' ? 'Space' : e.key
  return eventKey.toLowerCase() === parsed.key.toLowerCase()
}

export class DatanoaStudioEditor {
  private styleEl: HTMLStyleElement | null = null
  private rootEl: HTMLDivElement | null = null
  private sidebarEl: HTMLElement | null = null
  private sqlConsole: SqlConsoleController | null = null
  private dataGrid: VirtualDataGrid | null = null
  private schemaInspector: SchemaInspectorView | null = null
  private erDiagramView: ErDiagramView | null = null

  private connLogoEl: HTMLSpanElement | null = null
  private connSelectEl: HTMLSelectElement | null = null
  private envPillEl: HTMLSpanElement | null = null
  private roBadgeEl: HTMLSpanElement | null = null
  private addConnBtn: HTMLButtonElement | null = null
  private editConnBtn: HTMLButtonElement | null = null
  private cautionStripEl: HTMLDivElement | null = null
  private cautionStripTextEl: HTMLSpanElement | null = null
  private cautionStripCloseBtn: HTMLButtonElement | null = null
  private dismissedCautionKey: string | null = null
  private activeCautionKey: string | null = null
  private runBtn: HTMLButtonElement | null = null
  private runAllBtn: HTMLButtonElement | null = null
  private explainBtn: HTMLButtonElement | null = null
  private formatSqlBtn: HTMLButtonElement | null = null
  private cancelQueryBtn: HTMLButtonElement | null = null
  private historyBtn: HTMLButtonElement | null = null
  private readonly txToolbar: TransactionToolbarController
  private readonly valueInspector: ValueInspectorController
  private readonly queryHistoryDrawer: QueryHistoryDrawerController
  private refreshBtn: HTMLButtonElement | null = null
  private historyDrawerEl: HTMLDivElement | null = null
  private historySearchEl: HTMLInputElement | null = null
  private clearHistoryBtn: HTMLButtonElement | null = null
  private historyListEl: HTMLDivElement | null = null

  private sidebarListEl: HTMLDivElement | null = null
  private searchInputEl: HTMLInputElement | null = null
  private newTableBtn: HTMLButtonElement | null = null
  private topbarNewTableBtn: HTMLButtonElement | null = null
  private mainViewEl: HTMLDivElement | null = null
  private sqlToolbarEl: HTMLDivElement | null = null
  private sqlAreaEl: HTMLDivElement | null = null
  private consoleTabs = new ConsoleTabsManager()
  private consoleTabsBarEl: HTMLDivElement | null = null
  private resultSetsBarEl: HTMLDivElement | null = null
  private activeQueryResult: QueryResult | null = null
  private activeResultSetIndex = 0
  private activeResultBannerState: ResultBannerState | null = null
  private activeWorkerQueryId: string | null = null
  private readonly bindParamsMemoryStore: RememberedBindParamsStore = createRememberedBindParamsStore()
  private readonly explainMetaByResult = new WeakMap<
    QueryResult,
    {
      connectionId: string
      dialect: DatabaseDriverType
      activeSchema?: string
      colorTag?: ConnectionProfile['colorTag']
      aiPolicy?: ConnectionProfile['aiPolicy']
      rawPlanTexts: string[]
    }
  >()
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
  private queryBannerReportBtn: HTMLButtonElement | null = null
  private queryBannerRetryBtn: HTMLButtonElement | null = null
  private queryBannerEditConnBtn: HTMLButtonElement | null = null
  private queryBannerBackBtn: HTMLButtonElement | null = null
  private queryBannerFixAiBtn: HTMLButtonElement | null = null
  private queryBannerRetryHandler: (() => void) | null = null
  private queryBannerEditConnHandler: (() => void) | null = null
  private queryBannerRetryLabel = 'Retry'
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
  private importDataBtn: HTMLButtonElement | null = null
  private importModalOpenSeq = 0
  private exportSelectEl: HTMLSelectElement | null = null
  private batchModeBtn: HTMLButtonElement | null = null
  private editTableBtn: HTMLButtonElement | null = null
  private isRestoringViewState = false
  private hasRestoredBootState = false
  private hasRestoredLocalViewState = false
  private hasRestoredSqlState = false
  private restoredViewStateUpdatedAt = 0
  private hasUserInteraction = false
  private restoredPageOnBoot: number | null = null
  private pendingScrollState: { sidebarTop?: number; gridTop?: number; gridLeft?: number } | null = null

  private dmlPreviewEl: HTMLDivElement | null = null
  private dmlApplyBtn: HTMLButtonElement | null = null
  private dmlPreviewPreEl: HTMLPreElement | null = null
  private lastPreviewDmlText = ''

  private statusStateEl: HTMLSpanElement | null = null
  private statusSelectionEl: HTMLButtonElement | null = null
  private statusMetricsEl: HTMLSpanElement | null = null
  private shortcutsBtn: HTMLButtonElement | null = null
  private feedbackBtn: HTMLButtonElement | null = null
  private gridAreaEl: HTMLDivElement | null = null
  private aiFixEl: HTMLDivElement | null = null
  private explainAiEl: HTMLDivElement | null = null
  private inspectorAreaEl: HTMLDivElement | null = null
  private erAreaEl: HTMLDivElement | null = null
  private vimModePillEl: HTMLSpanElement | null = null
  private aiBtn: HTMLButtonElement | null = null
  private aiStatus: AiStatusSnapshot | null = null
  private aiFixAbort: AbortController | null = null
  private aiFixSeq = 0
  private pendingConfirmedInlineAi: {
    connectionId: string
    mode: 'complete' | 'edit'
    prefix: string
    suffix: string
  } | null = null
  private aiFixState: {
    phase: 'hidden' | 'idle' | 'loading' | 'ready' | 'error'
    pendingConfirm?: boolean
    result: AiFixQueryResult | null
    error: string | null
    failedSql: string
    errorMessage: string
    fixTargetRange: SqlFixTargetRange | null
    originTabId: string
    originResultSetIndex: number
    originConnectionId: string | null
    executedConnectionId?: string | null
    originLastResult: QueryResult | null
  } | null = null
  private explainAiAbort: AbortController | null = null
  private explainAiSeq = 0
  private explainAiLoadingTarget: {
    tabId: string
    resultSetIndex: number
    originLastResult: QueryResult
  } | null = null

  private tabButtons: Record<StudioViewMode, HTMLButtonElement> | null = null

  private connections: ConnectionProfile[] = []
  private folderOrder: string[] = []
  private reorderQueueChain: Promise<void> = Promise.resolve()
  private reorderSeq = 0
  private connReorderSeq = 0
  private folderReorderSeq = 0
  private pendingReorderCount = 0
  private expectedSelfChangedEvents = 0
  private consumedSelfChangedEvents = 0
  private refreshConnectionsAfterReorder = false
  private schemaObjects: SchemaObject[] = []
  private filterQuery = ''
  private availableSchemas: string[] = []
  private selectedSchema: string | undefined = undefined
  private defaultSchema: string | undefined = undefined
  private selectedSchemaByConn: Record<string, string> = {}
  private selectedSchemaUpdatedAtByConn: Record<string, number> = {}
  private availableSchemasByConn: Record<string, string[]> = {}
  private defaultSchemaByConn: Record<string, string> = {}
  private schemaObjectsByConnSchema = new Map<string, SchemaObject[]>()
  private schemaSelectEl: HTMLSelectElement | null = null
  private exportDdlBtn: HTMLButtonElement | null = null
  private collapsedSidebarGroups = new Set<SchemaObjectKind>()
  private collapsedTopbarGroups = new Set<SchemaObjectKind>()
  private isExportingSchemaDdl = false
  private activeConnectionId: string | null = null
  private activeTable: string | null = null
  private activeObjectKind: SchemaObjectKind | null = null
  private activeReadOnlyObject: SchemaObject | null = null
  private activeSchema: string | undefined = undefined
  private lastLoadedTableKey: string | null = null
  private loadedDataTableKey: string | null = null
  private readonly consumedNavTokens = new Set<string>()
  private readonly claimingNavTokens = new Set<string>()
  private activeWhereClause: string | undefined = undefined
  private activeOrderByClause: string | undefined = undefined

  private pendingDocConnectionId: string | null = null
  private pendingDocTable: string | null = null
  private pendingDocSchema: string | undefined = undefined
  private pendingDocAction: 'import' | null = null
  private pendingImportTarget: {
    connectionId?: string | null
    schema?: string
    table?: string
  } | null = null
  private storedActiveConnectionId: string | null = null
  private preservedMetadataLines: string[] = []
  private hasLoadedActiveConnection = false

  private currentPage = 1
  private totalRows = 0
  private currentColCount = 0
  private currentMetricsTruncated = false
  private currentPageRowCount = 0
  private pageSize = 100
  private activeViewMode: StudioViewMode = 'split'
  private customSqlPanePx: number | null = null
  private splitResizeListeners: {
    move: (e: MouseEvent) => void
    up: () => void
    blur: () => void
    keydown: (e: KeyboardEvent) => void
  } | null = null
  private splitResizeRafId: number | null = null
  private scrollRestoreRafId: number | null = null
  private isDestroyed = false
  private lastPageData: TableBrowseResult | null = null
  private pendingBootDataCache: StudioWarmCacheSnapshot | null = null
  private hasWarmBootHydrated = false
  private warmBootUpdatedAt = 0
  private introspectToken = 0
  private gridViewSeq = 0
  private tableLoadToken = 0
  private schemaLoadToken = 0
  private querySeq = 0
  private resultRefreshSeq = 0
  private connectionsSeq = 0
  private dmlPreviewSeq = 0
  private countRowsSeq = 0
  private cancelledQueryIds = new Set<string>()
  private clientSearchDebounceTimer: ReturnType<typeof setTimeout> | null = null
  private saveViewStateTimer: ReturnType<typeof setTimeout> | null = null
  private isIntrospectingSchema = false
  private schemaError: string | null = null
  private schemaStale = false
  private schemaStaleReason: string | undefined = undefined
  private schemaCachedAt: number | undefined = undefined
  private isTableLoading = false
  private isSubmittingChanges = false
  private isCancellingQuery = false
  private isRefreshingSchema = false
  private isPreviewingDml = false
  private isClearingHistory = false
  private schemaMap: Record<string, string[]> = {}
  private tableDetailsCache = new Map<string, TableDetails>()
  private inFlightTableDetails = new Map<string, Promise<TableDetails>>()
  private columnConfigByTable: Record<string, TableColumnConfig> = {}
  private lastSelectionSummary: SelectionSummary | null = null
  private documentSession: DocumentSessionLike | null = null
  private pendingInitialDocDecision: {
    docText: string
    navToken: string | null
    claimedPromise: Promise<boolean>
  } | null = null
  private stagedImportSeq = 0
  private activeImportModalKey: string | null = null
  private replaceSub: { dispose(): void } | null = null
  private disposables: Array<{ dispose(): void }> = []
  private activeTimerStops = new Set<() => void>()
  private suppressDocSync = false
  private isShowingSqlResult = false
  private currentWorkspaceScope = ''
  private currentWorkspaceRoot = ''
  private workspaceContextPromise: Promise<void> | null = null
  private activeExecutedSql = ''
  private activeEditableStmtSql = ''
  private editableSqlTarget: EditableSqlTargetMeta | null = null
  private activeQueryId: string | null = null
  private currentCanEdit = false
  private sidebarCollapsed = false
  private sidebarToggleBtn: HTMLButtonElement | null = null
  private tableTopbarEl: HTMLDivElement | null = null
  private topbarSchemaWrapEl: HTMLDivElement | null = null
  private topbarSchemaSelectEl: HTMLSelectElement | null = null
  private topbarFilterInputEl: HTMLInputElement | null = null
  private topbarCountEl: HTMLSpanElement | null = null
  private topbarTrackEl: HTMLDivElement | null = null
  private topbarAllBtn: HTMLButtonElement | null = null
  private topbarPopoverEl: HTMLDivElement | null = null
  private topbarPopoverOutsideCleanup: (() => void) | null = null
  private colsPopoverEl: HTMLDivElement | null = null
  private colsPopoverOutsideCleanup: (() => void) | null = null
  private colsPopoverSync: (() => void) | null = null
  private activeModalBackdrop: HTMLDivElement | null = null
  private activeModalKeyCleanup: (() => void) | null = null
  private activeModalDismiss: (() => void) | null = null
  private lastInspectorLoadedKey = ''
  private lastErLoadedKey = ''
  private suppressOneShotPersistViewMode = false
  private currentTableDisplayRevision = 0
  private currentTableDisplayKey = ''
  private tableDisplayReqGen = 0
  private tableDisplayRevisionByKey = new Map<string, number>()
  private tableDisplayPatchQueues = new Map<
    string,
    {
      inFlight: boolean
      dirty: boolean
      overwrittenByRemoteWhileInFlight: boolean
      inFlightSentNormalized: TableDisplayStateEntry | null
      latestLocalEntry: TableDisplayStateEntry | null
      hasPendingRemoteRebase: boolean
      pendingRemoteRebaseEntry: TableDisplayStateEntry | null
      pendingRemoteRebaseRev: number
      recentSelfRevisions: Set<number>
    }
  >()
  private tableDisplayChangedUnsub: (() => void) | null = null
  private currentKeymapSettings: EditorKeymapSettings = normalizeShortcutSettings()
  private explainViewModeByTab = new Map<string, 'visual' | 'raw' | 'ai'>()

  constructor() {
    this.txToolbar = new TransactionToolbarController({
      getActiveConnectionId: () => this.activeConnectionId,
      getActiveConnection: () => this.getActiveConnection(),
      isReadOnly: () => this.isActiveConnectionReadOnly(),
      isQueryRunning: () => this.activeQueryId !== null,
      isShowingSqlResult: () => this.isShowingSqlResult,
      getActiveTable: () => this.activeTable,
      getCurrentPage: () => this.currentPage,
      requestPlugin: (method, payload, options) => this.requestPlugin(method, payload, options),
      reloadTableData: (connId, table, page) => {
        void this.loadTableData(connId, table, page)
      },
      showErrorBanner: (title, detail) => {
        this.showQueryBanner('error', title, detail)
      },
      updateStatus: (stateText) => {
        this.updateStatus(stateText)
      },
    })
    this.valueInspector = new ValueInspectorController({
      getInspectButton: () => this.inspectCellBtn,
      getDataGrid: () => this.dataGrid,
      getActiveTarget: () => {
        const editable = this.resolveEditableTargetTable()
        return {
          connectionId: this.activeConnectionId,
          table: editable?.table ?? this.activeTable,
          schema: editable?.schema ?? this.activeSchema,
          page: this.currentPage,
          viewSeq: this.gridViewSeq,
          isShowingSqlResult: this.isShowingSqlResult,
        }
      },
      updateCell: (params) => this.handleUpdateCell(params),
      reloadTableData: (connId, table, page) => this.loadTableData(connId, table, page),
      updateStatus: (stateText) => this.updateStatus(stateText),
    })
    this.queryHistoryDrawer = new QueryHistoryDrawerController({
      getDrawerEl: () => this.historyDrawerEl,
      getListEl: () => this.historyListEl,
      getToggleBtn: () => this.historyBtn,
      setSqlText: (sql) => {
        this.sqlConsole?.setText(sql)
        this.sqlConsole?.focus()
      },
      insertSqlText: (sql) => {
        this.sqlConsole?.insertText(sql)
        this.sqlConsole?.focus()
      },
      requestPlugin: (method, payload, options) => this.requestPlugin(method, payload, options),
      updateStatus: (stateText) => this.updateStatus(stateText),
    })
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
    return readLocalStudioViewState()
  }

  private recordSelectedSchema(connectionId: string, schema: string, explicit: boolean): void {
    const cleanConn = connectionId.trim()
    const cleanSchema = schema.trim()
    if (!cleanConn || !cleanSchema) return
    this.selectedSchemaByConn[cleanConn] = cleanSchema
    if (explicit) {
      this.selectedSchemaUpdatedAtByConn[cleanConn] = Math.max(
        Date.now(),
        (this.selectedSchemaUpdatedAtByConn[cleanConn] || 0) + 1
      )
    } else if (!(cleanConn in this.selectedSchemaUpdatedAtByConn)) {
      this.selectedSchemaUpdatedAtByConn[cleanConn] = 0
    }
  }

  private reconcileSelectedSchemasFromSnapshot(
    saved: StudioPersistedViewState,
    forceOverwrite: boolean
  ): void {
    const savedSchemas = sanitizeStringRecord(saved.selectedSchemaByConn)
    const hasTsMap =
      saved.selectedSchemaUpdatedAtByConn !== undefined &&
      saved.selectedSchemaUpdatedAtByConn !== null &&
      typeof saved.selectedSchemaUpdatedAtByConn === 'object' &&
      !Array.isArray(saved.selectedSchemaUpdatedAtByConn)
    const savedTsMap = hasTsMap ? sanitizeNumberRecord(saved.selectedSchemaUpdatedAtByConn) : {}
    const fallbackTs =
      !hasTsMap &&
      typeof saved.updatedAt === 'number' &&
      Number.isFinite(saved.updatedAt) &&
      saved.updatedAt >= 0
        ? saved.updatedAt
        : 0
    const currentTargetConn = this.pendingDocConnectionId || this.activeConnectionId
    for (const [cid, schema] of Object.entries(savedSchemas)) {
      const savedTs = hasTsMap ? (savedTsMap[cid] ?? 0) : fallbackTs
      const currentTs = this.selectedSchemaUpdatedAtByConn[cid] ?? -1
      if (forceOverwrite || !this.selectedSchemaByConn[cid] || savedTs > currentTs) {
        this.selectedSchemaByConn[cid] = schema
        this.selectedSchemaUpdatedAtByConn[cid] = Math.max(0, savedTs)
        if (!this.hasUserInteraction && cid === currentTargetConn) {
          const currentResolved = (this.pendingDocSchema || this.selectedSchema || '').trim()
          if (currentResolved !== schema) {
            const hadDifferentSchema = currentResolved.length > 0
            this.selectedSchema = schema
            this.activeSchema = schema
            this.pendingDocSchema = schema
            if (hadDifferentSchema) {
              this.activeTable = null
              this.pendingDocTable = null
            }
            if (
              this.pendingBootDataCache?.activeConnectionId === cid &&
              (this.pendingBootDataCache.selectedSchema ||
                this.pendingBootDataCache.activeSchema ||
                '') !== schema
            ) {
              this.pendingBootDataCache = null
            }
            if (this.hasLoadedActiveConnection) {
              this.hasLoadedActiveConnection = false
            }
          }
        }
      }
    }
  }

  private applyRestoredStudioViewState(
    saved: StudioPersistedViewState | null,
    options?: { forceOverwritePending?: boolean }
  ): void {
    if (!saved || typeof saved !== 'object') return
    const forceOverwrite = Boolean(options?.forceOverwritePending)
    this.isRestoringViewState = true
    try {
      if (typeof saved.updatedAt === 'number' && Number.isFinite(saved.updatedAt)) {
        this.restoredViewStateUpdatedAt = Math.max(this.restoredViewStateUpdatedAt, saved.updatedAt)
      }
      if (
        saved.pageSize &&
        Number.isFinite(saved.pageSize) &&
        [100, 500, 1000, 5000, 10000].includes(Number(saved.pageSize))
      ) {
        this.pageSize = Number(saved.pageSize)
        if (this.pageSizeSelectEl) {
          this.pageSizeSelectEl.value = String(this.pageSize)
          syncStudioSelectTooltip(this.pageSizeSelectEl, 'Rows per page')
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
      if ((forceOverwrite || !this.pendingDocConnectionId) && saved.activeConnectionId) {
        this.storedActiveConnectionId = saved.activeConnectionId
        this.pendingDocConnectionId = saved.activeConnectionId
      }
      if ((forceOverwrite || !this.pendingDocTable) && saved.activeTable) {
        this.pendingDocTable = saved.activeTable
        this.activeTable = saved.activeTable
      } else if (forceOverwrite && !saved.activeTable) {
        this.pendingDocTable = null
        this.activeTable = null
      }
      const restoredConnId =
        (typeof saved.activeConnectionId === 'string' && saved.activeConnectionId) ||
        this.pendingDocConnectionId ||
        this.activeConnectionId ||
        null
      const savedSchemasRec = sanitizeStringRecord(saved.selectedSchemaByConn)
      const restoredSchema =
        (typeof saved.selectedSchema === 'string' && saved.selectedSchema.trim()) ||
        (restoredConnId ? savedSchemasRec[restoredConnId] || this.selectedSchemaByConn[restoredConnId] : undefined) ||
        (typeof saved.activeSchema === 'string' && saved.activeSchema.trim()
          ? saved.activeSchema.trim()
          : undefined)
      if ((forceOverwrite || !this.pendingDocSchema) && restoredSchema) {
        this.pendingDocSchema = restoredSchema
        this.activeSchema = restoredSchema
        this.selectedSchema = restoredSchema
      }
      this.reconcileSelectedSchemasFromSnapshot(saved, forceOverwrite)
      if (restoredConnId && restoredSchema && !this.selectedSchemaByConn[restoredConnId]) {
        const snapshotTs =
          typeof saved.updatedAt === 'number' && Number.isFinite(saved.updatedAt) && saved.updatedAt >= 0
            ? saved.updatedAt
            : 0
        this.selectedSchemaByConn[restoredConnId] = restoredSchema
        this.selectedSchemaUpdatedAtByConn[restoredConnId] = snapshotTs
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
        this.hasRestoredSqlState = true
        this.suppressDocSync = true
        try {
          if (this.sqlConsole && this.sqlConsole.getText() !== saved.sqlDraft) {
            this.sqlConsole.setText(saved.sqlDraft)
          }
        } finally {
          this.suppressDocSync = false
        }
      }
      if (
        saved.consoleTabs &&
        Array.isArray(saved.consoleTabs.tabs) &&
        saved.consoleTabs.tabs.length > 0 &&
        !this.documentSession
      ) {
        this.hasRestoredSqlState = true
        this.consoleTabs = new ConsoleTabsManager(saved.consoleTabs)
        const savedTab = this.consoleTabs.getActiveTab()
        this.suppressDocSync = true
        try {
          if (this.sqlConsole && this.sqlConsole.getText() !== savedTab.sql) {
            this.sqlConsole.setText(savedTab.sql)
          }
        } finally {
          this.suppressDocSync = false
        }
      } else if (typeof saved.sqlDraft === 'string') {
        this.consoleTabs.updateActiveSql(saved.sqlDraft)
      }
      this.renderConsoleTabs()
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
        isValidStudioViewMode(saved.activeViewMode)
      ) {
        this.switchMode(saved.activeViewMode)
      } else if (this.customSqlPanePx !== null) {
        this.applyClampedSplitPaneHeight()
      }
      if (saved.scrollState && typeof saved.scrollState === 'object') {
        this.pendingScrollState = saved.scrollState
        const sc = saved.scrollState
        const restoreScroll = () => {
          this.scrollRestoreRafId = null
          if (this.isDestroyed) return
          if (this.sidebarListEl && typeof sc.sidebarTop === 'number' && sc.sidebarTop > 0) {
            this.sidebarListEl.scrollTop = sc.sidebarTop
          }
          const gridScrollEl = this.gridAreaEl?.querySelector('.datanoa-grid-container')
          if (gridScrollEl instanceof HTMLElement) {
            if (typeof sc.gridTop === 'number' && sc.gridTop > 0) gridScrollEl.scrollTop = sc.gridTop
            if (typeof sc.gridLeft === 'number' && sc.gridLeft > 0) gridScrollEl.scrollLeft = sc.gridLeft
          }
        }
        if (typeof requestAnimationFrame === 'function') {
          if (this.scrollRestoreRafId !== null && typeof cancelAnimationFrame === 'function') {
            cancelAnimationFrame(this.scrollRestoreRafId)
          }
          this.scrollRestoreRafId = requestAnimationFrame(restoreScroll)
        } else {
          restoreScroll()
        }
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

  private static readonly WARM_CACHE_FRESH_MS = 60_000

  private isWarmCacheFresh(updatedAt?: number): boolean {
    if (!updatedAt || !Number.isFinite(updatedAt)) return false
    return Date.now() - updatedAt < DatanoaStudioEditor.WARM_CACHE_FRESH_MS
  }

  private doesWarmPageCacheMatchCurrentQuery(cache: StudioWarmCacheSnapshot | null): boolean {
    if (!cache?.pageData) return false
    if (this.activeTable && cache.activeTable && cache.activeTable !== this.activeTable) return false
    if (
      this.activeSchema &&
      cache.activeSchema &&
      cache.activeSchema !== this.activeSchema
    ) {
      return false
    }
    if ((cache.whereClause || '') !== (this.activeWhereClause || '')) return false
    if ((cache.orderByClause || '') !== (this.activeOrderByClause || '')) return false
    if (cache.page && cache.page !== this.currentPage) return false
    if (cache.pageSize && cache.pageSize !== this.pageSize) return false
    return true
  }

  private applyBootCacheMetadata(cache: StudioWarmCacheSnapshot): void {
    if (cache.selectedSchemaByConn && typeof cache.selectedSchemaByConn === 'object') {
      for (const [cid, sch] of Object.entries(sanitizeStringRecord(cache.selectedSchemaByConn))) {
        if (!this.selectedSchemaByConn[cid]) {
          this.recordSelectedSchema(cid, sch, false)
        }
      }
    }
    if (cache.availableSchemasByConn && typeof cache.availableSchemasByConn === 'object') {
      for (const [cid, list] of Object.entries(sanitizeStringArrayRecord(cache.availableSchemasByConn))) {
        if (!this.availableSchemasByConn[cid]) {
          this.availableSchemasByConn[cid] = list
        }
      }
    }
    if (cache.defaultSchemaByConn && typeof cache.defaultSchemaByConn === 'object') {
      for (const [cid, sch] of Object.entries(sanitizeStringRecord(cache.defaultSchemaByConn))) {
        if (!this.defaultSchemaByConn[cid]) {
          this.defaultSchemaByConn[cid] = sch
        }
      }
    }
    if (cache.schemaObjectsByKey && typeof cache.schemaObjectsByKey === 'object') {
      for (const [k, objs] of Object.entries(cache.schemaObjectsByKey)) {
        if (Array.isArray(objs) && !this.schemaObjectsByConnSchema.has(k)) {
          this.schemaObjectsByConnSchema.set(k, objs)
        }
      }
    }
  }

  private hydrateCachedGridAndSchemaFromSnapshot(
    targetConnId: string,
    matchedConn: ConnectionProfile | undefined,
    cache: StudioWarmCacheSnapshot
  ): { hydratedGrid: boolean; isTruncatedWarmPage: boolean; schemaMatches: boolean } {
    this.applyBootCacheMetadata(cache)
    const targetSchema = (this.pendingDocSchema || this.selectedSchema || this.activeSchema || '').trim()
    const cacheSchema = (cache.selectedSchema || cache.activeSchema || '').trim()
    const schemaMatches = !targetSchema || !cacheSchema || targetSchema === cacheSchema

    if (schemaMatches) {
      if (Array.isArray(cache.availableSchemas)) {
        this.availableSchemas = cache.availableSchemas.filter(
          (s) => typeof s === 'string' && s.length > 0
        )
        if (this.availableSchemas.length > 0) {
          this.availableSchemasByConn[targetConnId] = this.availableSchemas.slice()
        }
      }
      if (typeof cache.defaultSchema === 'string' && cache.defaultSchema) {
        this.defaultSchema = cache.defaultSchema
        this.defaultSchemaByConn[targetConnId] = cache.defaultSchema
      }
      if (!this.selectedSchema && typeof cache.selectedSchema === 'string' && cache.selectedSchema) {
        this.selectedSchema = cache.selectedSchema
        this.selectedSchemaByConn[targetConnId] = cache.selectedSchema
      }
      if (Array.isArray(cache.schemaObjects)) {
        this.schemaObjects = cache.schemaObjects
        const schKey = this.makeConnSchemaKey(
          targetConnId,
          this.selectedSchema || cache.selectedSchema || this.defaultSchema
        )
        if (!this.schemaObjectsByConnSchema.has(schKey)) {
          this.schemaObjectsByConnSchema.set(schKey, cache.schemaObjects)
        }
      }
      if (cache.schemaMap && typeof cache.schemaMap === 'object') {
        this.schemaMap = cache.schemaMap
        this.sqlConsole?.updateSchema(this.schemaMap, this.activeTable || undefined)
      }
      if (!this.activeTable && cache.activeTable) {
        this.activeTable = cache.activeTable
      }
      if (!this.activeSchema && cache.activeSchema) {
        this.activeSchema = cache.activeSchema
      }
      if (cache.activeObjectKind) {
        this.activeObjectKind = cache.activeObjectKind
      }
      if (cache.activeReadOnlyObject) {
        this.activeReadOnlyObject = cache.activeReadOnlyObject
      }
    } else {
      if (Array.isArray(this.availableSchemasByConn[targetConnId])) {
        this.availableSchemas = this.availableSchemasByConn[targetConnId].slice()
      }
      if (this.defaultSchemaByConn[targetConnId]) {
        this.defaultSchema = this.defaultSchemaByConn[targetConnId]
      }
      const cachedForTarget = this.schemaObjectsByConnSchema.get(
        this.makeConnSchemaKey(targetConnId, targetSchema)
      )
      if (cachedForTarget) {
        this.schemaObjects = cachedForTarget
      }
    }

    this.updateSchemaSwitcherDisplay()
    if (this.schemaObjects.length > 0 || (schemaMatches && Array.isArray(cache.schemaObjects))) {
      this.isIntrospectingSchema = false
      this.renderSidebarObjects()
    }

    let hydratedGrid = false
    let isTruncatedWarmPage = false
    if (schemaMatches && cache.isShowingSqlResult && cache.lastSqlResult) {
      this.isShowingSqlResult = true
      this.applyActiveQueryResult(cache.lastSqlResult)
      const cachedRes = cache.lastSqlResult
      const rowCount = cachedRes.rowCount ?? (cachedRes.rows ? cachedRes.rows.length : 0)
      this.currentPage = 1
      this.totalRows = rowCount
      this.currentColCount = cachedRes.isSelect ? (cachedRes.columns?.length ?? 0) : 0
      this.currentMetricsTruncated = Boolean(cachedRes.isSelect && cachedRes.truncated)
      this.currentPageRowCount = cachedRes.rows ? cachedRes.rows.length : 0
      if (this.gridSubbarTitleEl) {
        this.gridSubbarTitleEl.textContent = cachedRes.isSelect
          ? 'SQL Result'
          : `Executed · ${cachedRes.affectedRows ?? 0} affected`
      }
      if (this.gridPageInfoEl) {
        const rowLabel = `${rowCount} ${rowCount === 1 ? 'row' : 'rows'}`
        this.gridPageInfoEl.textContent = cachedRes.truncated ? `${rowLabel} (truncated)` : rowLabel
      }
      this.updateStatus(
        'Ready',
        formatGridStatusMetrics(
          cachedRes.isSelect ? rowCount : (cachedRes.affectedRows ?? 0),
          this.currentColCount,
          {
            truncated: this.currentMetricsTruncated,
            unit: cachedRes.isSelect ? 'row' : 'affected',
          }
        )
      )
      hydratedGrid = true
    } else if (schemaMatches && this.doesWarmPageCacheMatchCurrentQuery(cache) && cache.pageData) {
      const cachedPage = cache.pageData
      const readOnly = Boolean(matchedConn?.readOnly)
      if (!this.activeTable && cache.activeTable) {
        this.activeTable = cache.activeTable
        this.activeSchema = cache.activeSchema || undefined
      }
      this.lastPageData = cachedPage
      this.lastLoadedTableKey = buildStudioTableKey(
        targetConnId,
        this.activeSchema,
        this.activeTable || ''
      )
      this.loadedDataTableKey = this.lastLoadedTableKey
      this.currentPage = cachedPage.page || this.currentPage || 1
      this.totalRows = cachedPage.totalRows || 0
      this.currentColCount = cachedPage.columns.length
      this.currentMetricsTruncated = false
      this.currentPageRowCount = Array.isArray(cachedPage.rows) ? cachedPage.rows.length : 0
      const expectedPageRows = Math.min(
        Math.max(0, this.totalRows - (this.currentPage - 1) * this.pageSize),
        this.pageSize
      )
      isTruncatedWarmPage = this.currentPageRowCount < expectedPageRows
      this.currentCanEdit = Boolean(cachedPage.canEdit) && !readOnly
      this.dataGrid?.setContextMeta(
        this.activeTable || '',
        matchedConn?.driver || 'sqlite',
        targetConnId,
        this.activeSchema || ''
      )
      const cachedKey = buildStudioTableKey(
        targetConnId,
        this.activeSchema,
        this.activeTable || ''
      )
      const legacyCachedKey = canUseLegacyStudioTableKeyFallback(
        targetConnId,
        this.activeSchema,
        this.activeTable || ''
      )
        ? buildLegacyStudioTableKey(targetConnId, this.activeSchema, this.activeTable || '')
        : null
      const savedColCfg =
        this.columnConfigByTable[cachedKey] ??
        (legacyCachedKey ? this.columnConfigByTable[legacyCachedKey] : undefined)
      if (savedColCfg) {
        this.dataGrid?.setColumnConfig({ ...savedColCfg })
      }
      this.dataGrid?.setData({ ...cachedPage, canEdit: this.currentCanEdit })
      const totalPages = Math.max(1, Math.ceil(this.totalRows / this.pageSize))
      if (this.gridSubbarTitleEl && this.activeTable) {
        this.gridSubbarTitleEl.textContent = readOnly
          ? `${this.activeTable} · RO`
          : this.activeTable
      }
      if (this.gridPageInfoEl) {
        this.gridPageInfoEl.textContent = `Page ${this.currentPage} / ${totalPages} (${this.totalRows} rows)`
      }
      this.updateStatus(
        this.activeTable ? `Ready · ${this.activeTable}` : 'Ready',
        formatGridStatusMetrics(this.totalRows, this.currentColCount)
      )
      hydratedGrid = true
    } else if (
      schemaMatches &&
      Array.isArray(cache.schemaObjects) &&
      cache.schemaObjects.length === 0 &&
      !cache.activeTable &&
      !this.activeTable &&
      this.availableSchemas.length > 0
    ) {
      this.currentColCount = 0
      this.currentMetricsTruncated = false
      this.currentPageRowCount = 0
      const emptyMsg = this.selectedSchema
        ? `No objects found in "${this.selectedSchema}".`
        : 'No objects found in this connection.'
      this.dataGrid?.setEmptyMessage(emptyMsg)
      this.dataGrid?.setData({
        columns: [],
        rows: [],
        totalRows: 0,
        page: 1,
        pageSize: this.pageSize,
        primaryKey: [],
        canEdit: false,
      })
      if (this.gridSubbarTitleEl) {
        this.gridSubbarTitleEl.textContent = 'Select a table'
      }
      if (this.gridPageInfoEl) {
        this.gridPageInfoEl.textContent = 'Page 1'
      }
      this.updateStatus('Connected · 0 tables', '0 rows')
      hydratedGrid = true
    }

    this.updatePaginationButtons()
    this.updateExportDropdownOptions()
    this.consumePendingScrollState()

    return { hydratedGrid, isTruncatedWarmPage, schemaMatches }
  }

  private hydrateWarmCacheIntoDom(warm: StudioWarmCacheSnapshot): boolean {
    this.applyBootCacheMetadata(warm)
    const conns = Array.isArray(warm.connections) ? warm.connections : []
    const targetConnId =
      this.pendingDocConnectionId || this.activeConnectionId || warm.activeConnectionId || null
    if (!targetConnId || conns.length === 0) return false
    if (warm.activeConnectionId && warm.activeConnectionId !== targetConnId) return false
    const matchedConn = conns.find((c) => c.id === targetConnId)
    if (!matchedConn) return false

    this.connections = conns
    if (Array.isArray(warm.folderOrder)) {
      this.folderOrder = normalizeFolderOrder(warm.folderOrder)
    }
    const prevConnId = this.activeConnectionId
    this.activeConnectionId = targetConnId
    this.pendingBootDataCache = warm
    this.warmBootUpdatedAt = Number.isFinite(warm.updatedAt) ? warm.updatedAt : 0

    this.populateConnectionSelectDom(targetConnId)
    this.applyActiveConnectionPresentation(matchedConn)
    if (prevConnId !== targetConnId && this.isAiInlineReady()) {
      this.sqlConsole?.notifyAiAvailabilityChanged()
    }

    const { hydratedGrid, isTruncatedWarmPage, schemaMatches } =
      this.hydrateCachedGridAndSchemaFromSnapshot(targetConnId, matchedConn, warm)

    const hasValidCachedSchema =
      schemaMatches &&
      (this.schemaObjects.length > 0 ||
        (Array.isArray(warm.schemaObjects) &&
          warm.schemaObjects.length === 0 &&
          !warm.activeTable &&
          this.availableSchemas.length > 0))
    if (hydratedGrid && hasValidCachedSchema) {
      this.hasWarmBootHydrated = true
      if (this.isWarmCacheFresh(this.warmBootUpdatedAt) && !isTruncatedWarmPage) {
        this.hasLoadedActiveConnection = true
        this.pendingDocConnectionId = null
        this.pendingDocTable = null
        this.pendingDocSchema = undefined
        this.pendingBootDataCache = null
      }
      return true
    }
    return false
  }

  private tryHydratePendingBootCache(connectionId: string): {
    loaded: boolean
    hydratedGrid: boolean
  } {
    const cache =
      this.pendingBootDataCache && this.pendingBootDataCache.activeConnectionId === connectionId
        ? this.pendingBootDataCache
        : null
    if (!cache) return { loaded: false, hydratedGrid: false }
    const conn = this.connections.find((c) => c.id === connectionId)
    const { hydratedGrid, isTruncatedWarmPage, schemaMatches } =
      this.hydrateCachedGridAndSchemaFromSnapshot(connectionId, conn, cache)
    const hasValidCachedSchema =
      schemaMatches &&
      (this.schemaObjects.length > 0 ||
        (Array.isArray(cache.schemaObjects) &&
          cache.schemaObjects.length === 0 &&
          !cache.activeTable &&
          this.availableSchemas.length > 0))
    if (hydratedGrid && !isTruncatedWarmPage && hasValidCachedSchema && this.isWarmCacheFresh(cache.updatedAt)) {
      this.hasLoadedActiveConnection = true
      this.pendingDocConnectionId = null
      this.pendingDocTable = null
      this.pendingDocSchema = undefined
      this.pendingBootDataCache = null
      this.saveStudioDataCache()
      this.consumePendingImportAction()
      return { loaded: true, hydratedGrid: true }
    }
    return { loaded: false, hydratedGrid }
  }

  private restoreStudioViewStateFromLocal(): void {
    const saved = this.readLocalStudioViewState()
    if (saved) {
      this.hasRestoredLocalViewState = true
      this.applyRestoredStudioViewState(saved)
    }
    const warm = readLocalStudioWarmCache()
    if (warm) {
      this.hydrateWarmCacheIntoDom(warm)
    }
  }

  private getSplitPaneBounds(): { min: number; max: number } {
    const measuredMain = this.mainViewEl?.getBoundingClientRect?.().height || 0
    const fallbackMain =
      typeof window !== 'undefined' ? Math.max(240, (window.innerHeight || 680) - 80) : 600
    const mainHeight = measuredMain > 0 ? measuredMain : fallbackMain
    const maxByRatio = Math.floor(mainHeight * 0.72)
    const maxByGridMin = Math.max(80, Math.floor(mainHeight - 140))
    const maxPx = Math.max(80, Math.min(maxByRatio, maxByGridMin))
    return { min: 80, max: maxPx }
  }

  private getClampedSqlPanePx(
    desiredPx: number,
    bounds?: { min: number; max: number }
  ): number {
    const resolved = bounds ?? this.getSplitPaneBounds()
    return Math.max(resolved.min, Math.min(resolved.max, Math.round(desiredPx)))
  }

  private syncSplitResizerAria(
    currentPx: number | null,
    bounds?: { min: number; max: number }
  ): void {
    if (!this.splitResizerEl) return
    const resolved = bounds ?? this.getSplitPaneBounds()
    this.splitResizerEl.setAttribute('aria-valuemin', String(resolved.min))
    this.splitResizerEl.setAttribute('aria-valuemax', String(resolved.max))
    if (currentPx !== null && Number.isFinite(currentPx)) {
      this.splitResizerEl.setAttribute('aria-valuenow', String(Math.round(currentPx)))
    } else {
      this.splitResizerEl.removeAttribute('aria-valuenow')
    }
  }

  private applyClampedSplitPaneHeight(): void {
    if (
      (this.activeViewMode !== 'split' && this.activeViewMode !== 'sql') ||
      !this.sqlAreaEl ||
      this.customSqlPanePx === null
    ) {
      return
    }
    const bounds = this.getSplitPaneBounds()
    const clamped = this.getClampedSqlPanePx(this.customSqlPanePx, bounds)
    this.sqlAreaEl.style.flex = `0 0 ${clamped}px`
    this.syncSplitResizerAria(clamped, bounds)
  }

  private utf8ByteLength(value: unknown): number {
    try {
      const json = JSON.stringify(value) || ''
      return typeof TextEncoder === 'function'
        ? new TextEncoder().encode(json).length
        : json.length * 2
    } catch {
      return Infinity
    }
  }

  private makeConnSchemaKey(connectionId: string, schema?: string): string {
    return `${encodeURIComponent(connectionId)}:${encodeURIComponent((schema || '').trim())}`
  }

  private serializeSchemaObjectsByKey(): Record<string, SchemaObject[]> | undefined {
    if (this.schemaObjectsByConnSchema.size === 0) return undefined
    const entries = Array.from(this.schemaObjectsByConnSchema.entries())
    const recent = entries.slice(Math.max(0, entries.length - 8))
    const out: Record<string, SchemaObject[]> = {}
    for (const [k, list] of recent) {
      if (Array.isArray(list)) {
        out[k] = list.slice(0, 250)
      }
    }
    return Object.keys(out).length > 0 ? out : undefined
  }

  private hasPersistedSessionTarget(): boolean {
    return Boolean(
      this.activeConnectionId ||
        this.pendingDocConnectionId ||
        this.storedActiveConnectionId ||
        this.selectedSchema ||
        this.pendingDocSchema ||
        Object.keys(this.selectedSchemaByConn).length > 0
    )
  }

  private isManagedStudioDocument(hasMetadataHeaders: boolean): boolean {
    const docPath = this.getLocalDocumentPathSync().toLowerCase()
    if (docPath.endsWith('.datanoa')) return true
    if (docPath.endsWith('.sql')) return false
    return !docPath && hasMetadataHeaders
  }

  private shouldSyncMetadataHeaders(): boolean {
    return this.preservedMetadataLines.length > 0 || this.isManagedStudioDocument(false)
  }

  private writeStudioViewStateNow(): void {
    if (this.isRestoringViewState || this.isDestroyed || typeof window === 'undefined') return
    if (
      !this.hasRestoredBootState &&
      !this.hasRestoredLocalViewState &&
      !this.hasUserInteraction &&
      !this.activeConnectionId &&
      !this.selectedSchema
    ) {
      return
    }
    const persistedMode: StudioViewMode =
      this.suppressOneShotPersistViewMode && this.activeViewMode === 'er'
        ? readLocalStudioViewState()?.activeViewMode || 'split'
        : this.activeViewMode
    const snapshot: StudioPersistedViewState = {
      updatedAt: Date.now(),
      activeViewMode: persistedMode,
      activeConnectionId: this.activeConnectionId,
      activeTable: this.activeTable,
      activeSchema: this.activeSchema,
      selectedSchema: this.selectedSchema,
      selectedSchemaByConn: sanitizeStringRecord(this.selectedSchemaByConn),
      selectedSchemaUpdatedAtByConn: sanitizeNumberRecord(this.selectedSchemaUpdatedAtByConn),
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
      consoleTabs: this.consoleTabs.toPersistedState(),
      columnConfigByTable: this.columnConfigByTable,
      scrollState: (() => {
        const gridScrollEl = this.gridAreaEl?.querySelector('.datanoa-grid-container')
        return {
          sidebarTop: this.sidebarListEl ? Math.round(this.sidebarListEl.scrollTop) : 0,
          gridTop: gridScrollEl instanceof HTMLElement ? Math.round(gridScrollEl.scrollTop) : 0,
          gridLeft: gridScrollEl instanceof HTMLElement ? Math.round(gridScrollEl.scrollLeft) : 0,
        }
      })(),
    }
    writeStudioViewStateSnapshot(snapshot)
    const workerViewState: StudioPersistedViewState = { ...snapshot }
    if (this.utf8ByteLength(workerViewState) > 200_000) {
      delete workerViewState.consoleTabs
      delete workerViewState.columnConfigByTable
      if (typeof workerViewState.sqlDraft === 'string' && workerViewState.sqlDraft.length > 16_000) {
        workerViewState.sqlDraft = workerViewState.sqlDraft.slice(0, 16_000)
      }
    }
    try {
      void this.requestPlugin('ui.saveSessionSnapshot', {
        surface: 'studio',
        viewState: workerViewState,
      }).catch(() => {})
    } catch {
      // Ignore worker session save failure in minimal test contexts
    }
  }

  private consumePendingScrollState(): void {
    if (!this.pendingScrollState || this.isDestroyed) return
    const sc = this.pendingScrollState
    this.pendingScrollState = null
    const applyRestoredScroll = () => {
      this.scrollRestoreRafId = null
      if (this.isDestroyed) return
      if (this.sidebarListEl && typeof sc.sidebarTop === 'number' && sc.sidebarTop > 0) {
        this.sidebarListEl.scrollTop = sc.sidebarTop
      }
      if (typeof sc.gridLeft === 'number' && sc.gridLeft > 0) {
        this.dataGrid?.setScrollLeft(sc.gridLeft)
      }
      const gridScrollEl = this.gridAreaEl?.querySelector('.datanoa-grid-container')
      if (gridScrollEl instanceof HTMLElement) {
        if (typeof sc.gridTop === 'number' && sc.gridTop > 0) gridScrollEl.scrollTop = sc.gridTop
        if (typeof sc.gridLeft === 'number' && sc.gridLeft > 0) gridScrollEl.scrollLeft = sc.gridLeft
      }
    }
    if (typeof requestAnimationFrame === 'function') {
      if (this.scrollRestoreRafId !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(this.scrollRestoreRafId)
      }
      this.scrollRestoreRafId = requestAnimationFrame(applyRestoredScroll)
    } else {
      applyRestoredScroll()
    }
  }

  private saveStudioDataCache(): void {
    if (this.isDestroyed || typeof window === 'undefined') return
    if (
      !this.hasRestoredBootState &&
      !this.hasRestoredLocalViewState &&
      !this.hasUserInteraction &&
      !this.activeConnectionId &&
      this.connections.length === 0
    ) {
      return
    }
    try {
      const cachedSchemaObjs = Array.isArray(this.schemaObjects)
        ? this.schemaObjects.slice(0, 400)
        : []
      const now = Date.now()
      const schemaObjectsByKey = this.serializeSchemaObjectsByKey()
      const cachePayload: StudioWarmCacheSnapshot = {
        updatedAt: now,
        connections: this.connections,
        folderOrder: normalizeFolderOrder(this.folderOrder),
        activeConnectionId: this.activeConnectionId || null,
        activeTable: this.activeTable || null,
        activeSchema: this.activeSchema || '',
        activeObjectKind: this.activeObjectKind || null,
        activeReadOnlyObject: this.activeReadOnlyObject || null,
        availableSchemas: this.availableSchemas.slice(0, 100),
        defaultSchema: this.defaultSchema || '',
        selectedSchema: this.selectedSchema || '',
        selectedSchemaByConn: sanitizeStringRecord(this.selectedSchemaByConn),
        availableSchemasByConn: sanitizeStringArrayRecord(this.availableSchemasByConn),
        defaultSchemaByConn: sanitizeStringRecord(this.defaultSchemaByConn),
        ...(schemaObjectsByKey && this.utf8ByteLength(schemaObjectsByKey) < 160_000
          ? { schemaObjectsByKey }
          : {}),
        isShowingSqlResult: this.isShowingSqlResult,
        whereClause: containsSensitiveSqlText(this.activeWhereClause || '')
          ? ''
          : this.activeWhereClause || '',
        orderByClause: this.activeOrderByClause || '',
        page: this.currentPage,
        pageSize: this.pageSize,
        schemaMap: this.utf8ByteLength(this.schemaMap) < 40_000 ? this.schemaMap : null,
        schemaObjects: this.utf8ByteLength(cachedSchemaObjs) < 120_000 ? cachedSchemaObjs : null,
        pageData: null,
        lastSqlResult: null,
      }
      if (!this.isShowingSqlResult && this.lastPageData) {
        const candidate = {
          ...this.lastPageData,
          rows: Array.isArray(this.lastPageData.rows)
            ? this.lastPageData.rows.slice(0, 200)
            : [],
        }
        if (this.utf8ByteLength(candidate) < 360_000) {
          cachePayload.pageData = candidate
        }
      }
      if (this.isShowingSqlResult && this.activeQueryResult) {
        const candidate = sanitizeSqlResultForStorage({
          ...this.activeQueryResult,
          rows: Array.isArray(this.activeQueryResult.rows)
            ? this.activeQueryResult.rows.slice(0, 200)
            : [],
        })
        if (this.utf8ByteLength(candidate) < 360_000) {
          cachePayload.lastSqlResult = candidate
        }
      }
      writeLocalStudioWarmCache(cachePayload)

      const workerPayload: Record<string, unknown> = { ...cachePayload }
      delete workerPayload.connections
      if (this.utf8ByteLength(workerPayload) > 450_000 && workerPayload.schemaObjectsByKey) {
        delete workerPayload.schemaObjectsByKey
      }
      if (this.utf8ByteLength(workerPayload) > 450_000) {
        workerPayload.pageData = null
        workerPayload.lastSqlResult = null
      }
      void this.requestPlugin('ui.saveSessionSnapshot', {
        surface: 'studio',
        dataCache: workerPayload,
      }).catch(() => {})
    } catch {
      // Ignore worker dataCache persistence errors
    }
  }

  private saveStudioViewState(immediate = true): void {
    if (this.isRestoringViewState || this.isDestroyed || typeof window === 'undefined') return
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
    }
    this.writeStudioViewStateNow()
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
    options?: { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<T> {
    if (typeof window === 'undefined' || !window.orca?.plugin?.request) {
      throw new Error('Orca plugin bridge is not available')
    }
    const reqFn = window.orca.plugin.request as unknown as (
      reqName: string,
      reqInput?: unknown,
      reqOptions?: { timeoutMs?: number; signal?: AbortSignal }
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
    detectInitialThemeFromHost()
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

    const valueInspectorEl = this.valueInspector.buildElement()
    const dom = createStudioDomTree(
      this.pageSize,
      (parent) => this.buildTransactionToolbar(parent),
      valueInspectorEl
    )

    this.rootEl = dom.rootEl
    this.sidebarEl = dom.sidebarEl
    this.sidebarToggleBtn = dom.sidebarToggleBtn
    this.connLogoEl = dom.connLogoEl
    this.connSelectEl = dom.connSelectEl
    this.envPillEl = dom.envPillEl
    this.envPillEl.hidden = true
    this.envPillEl.style.display = 'none'
    this.roBadgeEl = dom.roBadgeEl
    this.roBadgeEl.hidden = true
    this.roBadgeEl.style.display = 'none'
    this.addConnBtn = dom.addConnBtn
    this.editConnBtn = dom.editConnBtn
    this.cautionStripEl = dom.cautionStripEl
    this.cautionStripTextEl = dom.cautionStripTextEl
    this.cautionStripCloseBtn = dom.cautionStripCloseBtn
    this.runBtn = dom.runBtn
    this.runAllBtn = dom.runAllBtn
    this.explainBtn = dom.explainBtn
    this.formatSqlBtn = dom.formatSqlBtn
    this.cancelQueryBtn = dom.cancelQueryBtn
    this.historyBtn = dom.historyBtn
    this.refreshBtn = dom.refreshBtn
    this.sqlToolbarEl = dom.sqlToolbarEl
    this.tabButtons = dom.tabButtons
    this.searchInputEl = dom.searchInputEl
    this.newTableBtn = dom.newTableBtn
    this.schemaSelectEl = dom.schemaSelectEl
    this.exportDdlBtn = dom.exportDdlBtn
    this.sidebarListEl = dom.sidebarListEl
    this.mainViewEl = dom.mainViewEl
    this.tableTopbarEl = dom.tableTopbarEl
    this.topbarSchemaWrapEl = dom.topbarSchemaWrapEl
    this.topbarSchemaSelectEl = dom.topbarSchemaSelectEl
    this.topbarFilterInputEl = dom.topbarFilterInputEl
    this.topbarCountEl = dom.topbarCountEl
    this.topbarTrackEl = dom.topbarTrackEl
    this.topbarAllBtn = dom.topbarAllBtn
    this.topbarNewTableBtn = dom.topbarNewTableBtn
    this.sqlAreaEl = dom.sqlAreaEl
    this.consoleTabsBarEl = dom.consoleTabsBarEl
    this.splitResizerEl = dom.splitResizerEl
    this.historyDrawerEl = dom.historyDrawerEl
    this.historySearchEl = dom.historySearchEl
    this.clearHistoryBtn = dom.clearHistoryBtn
    this.historyListEl = dom.historyListEl
    this.gridSubbarEl = dom.gridSubbarEl
    this.gridSubbarTitleEl = dom.gridSubbarTitleEl
    this.addRowBtn = dom.addRowBtn
    this.delRowBtn = dom.delRowBtn
    this.cloneRowBtn = dom.cloneRowBtn
    this.inspectCellBtn = dom.inspectCellBtn
    this.dmlPreviewBtn = dom.dmlPreviewBtn
    this.submitBtn = dom.submitBtn
    this.revertBtn = dom.revertBtn
    this.transposeBtn = dom.transposeBtn
    this.columnsBtn = dom.columnsBtn
    this.editTableBtn = dom.editTableBtn
    this.importDataBtn = dom.importDataBtn
    this.exportSelectEl = dom.exportSelectEl
    this.batchModeBtn = dom.batchModeBtn
    this.prevBtn = dom.prevBtn
    this.gridPageInfoEl = dom.gridPageInfoEl
    this.nextBtn = dom.nextBtn
    this.pageSizeSelectEl = dom.pageSizeSelectEl
    this.gridToolbarEl = dom.gridToolbarEl
    this.whereInputEl = dom.whereInputEl
    this.orderByInputEl = dom.orderByInputEl
    this.filterBtn = dom.filterBtn
    this.clearFilterBtn = dom.clearFilterBtn
    this.searchModeBtn = dom.searchModeBtn
    this.clientSearchEl = dom.clientSearchEl
    this.findCountEl = dom.findCountEl
    this.findPrevBtn = dom.findPrevBtn
    this.findNextBtn = dom.findNextBtn
    this.dmlPreviewEl = dom.dmlPreviewEl
    this.dmlApplyBtn = dom.dmlApplyBtn
    this.dmlPreviewPreEl = dom.dmlPreviewPreEl
    this.queryBannerEl = dom.queryBannerEl
    this.queryBannerTitleEl = dom.queryBannerTitleEl
    this.queryBannerDetailEl = dom.queryBannerDetailEl
    this.queryBannerRetryBtn = dom.queryBannerRetryBtn
    this.queryBannerEditConnBtn = dom.queryBannerEditConnBtn
    this.queryBannerBackBtn = dom.queryBannerBackBtn
    this.queryBannerFixAiBtn = dom.queryBannerFixAiBtn
    this.queryBannerCopyBtn = dom.queryBannerCopyBtn
    this.queryBannerReportBtn = dom.queryBannerReportBtn
    this.aiFixEl = dom.aiFixEl
    this.gridAreaEl = dom.gridAreaEl
    this.explainAiEl = dom.explainAiEl
    this.aiBtn = dom.aiBtn
    this.resultSetsBarEl = dom.resultSetsBarEl
    this.inspectorAreaEl = dom.inspectorAreaEl
    this.erAreaEl = dom.erAreaEl
    this.statusStateEl = dom.statusStateEl
    this.vimModePillEl = dom.vimModePillEl
    this.statusSelectionEl = dom.statusSelectionEl
    this.statusMetricsEl = dom.statusMetricsEl
    this.shortcutsBtn = dom.shortcutsBtn
    this.feedbackBtn = dom.feedbackBtn

    // Wire toolbar & header controls
    dom.sidebarToggleBtn.addEventListener('click', () => {
      this.setSidebarCollapsed(!this.sidebarCollapsed, true)
    })
    dom.connSelectEl.addEventListener('change', () => {
      this.hasUserInteraction = true
      const nextId = this.connSelectEl?.value || null
      this.pendingDocConnectionId = null
      this.pendingDocTable = null
      this.pendingDocSchema = undefined
      this.handleConnectionChanged(nextId)
      if (nextId) {
        if (this.shouldSyncMetadataHeaders()) {
          this.updateMetadataHeader('connectionId', nextId)
          if (this.selectedSchema) {
            this.updateMetadataHeader('schema', this.selectedSchema)
          } else {
            this.removeMetadataHeader('schema')
          }
          this.removeMetadataHeader('table')
        }
        this.saveStudioViewState(true)
      }
    })
    dom.addConnBtn.addEventListener('click', () => this.openConnectionModal())
    dom.editConnBtn.addEventListener('click', () => {
      const active = this.getActiveConnection()
      if (active) this.openConnectionModal(active)
    })
    dom.cautionStripCloseBtn.addEventListener('click', () => {
      if (this.activeCautionKey) {
        this.dismissedCautionKey = this.activeCautionKey
      }
      if (this.cautionStripEl) {
        this.cautionStripEl.style.display = 'none'
      }
    })
    dom.runBtn.addEventListener('click', () => {
      void this.executeSql(false)
    })
    dom.runAllBtn.addEventListener('click', () => {
      void this.executeSql(true)
    })
    dom.explainBtn.addEventListener('click', () => {
      void this.explainSql()
    })
    dom.formatSqlBtn.addEventListener('click', () => this.formatSqlInConsole())
    dom.cancelQueryBtn.addEventListener('click', () => {
      void this.cancelActiveQuery()
    })
    dom.historyBtn.addEventListener('click', () => {
      void this.toggleQueryHistory()
    })
    dom.savedQueriesBtn.addEventListener('click', () => this.openSavedQueriesModal())
    dom.findSqlBtn.addEventListener('click', () => this.sqlConsole?.openFindReplace())
    dom.aiBtn.addEventListener('click', () => {
      void this.openAiSettingsModal()
    })
    dom.refreshBtn.addEventListener('click', () => {
      void this.handleRefreshAction()
    })
    dom.tabButtons.split.addEventListener('click', () => this.switchMode('split'))
    dom.tabButtons.grid.addEventListener('click', () => this.switchMode('grid'))
    dom.tabButtons.sql.addEventListener('click', () => this.switchMode('sql'))
    dom.tabButtons.inspector.addEventListener('click', () => this.switchMode('inspector'))
    dom.tabButtons.er.addEventListener('click', () => this.switchMode('er'))

    // Wire sidebar & horizontal topbar controls
    dom.searchInputEl.addEventListener('input', () => {
      const rawVal = this.searchInputEl?.value || ''
      this.filterQuery = rawVal.toLowerCase()
      if (this.topbarFilterInputEl && this.topbarFilterInputEl.value !== rawVal) {
        this.topbarFilterInputEl.value = rawVal
      }
      this.renderSidebarObjects()
      this.saveStudioViewState(false)
    })
    dom.newTableBtn.addEventListener('click', () => this.openCreateTableModal())
    dom.schemaSelectEl.addEventListener('change', () => this.handleSchemaSelectionChanged('sidebar'))
    dom.topbarSchemaSelectEl.addEventListener('change', () =>
      this.handleSchemaSelectionChanged('topbar')
    )
    dom.exportDdlBtn.addEventListener('click', () => {
      void this.exportFullSchemaDdl()
    })
    dom.topbarFilterInputEl.addEventListener('input', () => {
      const rawVal = this.topbarFilterInputEl?.value || ''
      this.filterQuery = rawVal.toLowerCase()
      if (this.searchInputEl && this.searchInputEl.value !== rawVal) {
        this.searchInputEl.value = rawVal
      }
      this.renderSidebarObjects()
      this.saveStudioViewState(false)
    })
    dom.topbarPrevBtn.addEventListener('click', () => {
      if (this.topbarTrackEl) this.topbarTrackEl.scrollLeft -= 240
    })
    dom.topbarTrackEl.addEventListener(
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
    dom.topbarNextBtn.addEventListener('click', () => {
      if (this.topbarTrackEl) this.topbarTrackEl.scrollLeft += 240
    })
    dom.topbarAllBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.toggleTopbarAllTablesPopover()
    })
    dom.topbarNewTableBtn.addEventListener('click', () => this.openCreateTableModal())

    // Wire split resizer & query history drawer
    dom.splitResizerEl.addEventListener('mousedown', (e) => this.startSplitResize(e))
    dom.splitResizerEl.addEventListener('dblclick', () => this.resetSplitPaneHeight())
    dom.splitResizerEl.addEventListener('keydown', (e) => this.handleSplitResizerKeyDown(e))
    dom.historySearchEl.addEventListener('input', () => {
      this.queryHistoryDrawer.setSearchQuery(this.historySearchEl?.value || '')
    })
    dom.clearHistoryBtn.addEventListener('click', () => {
      void this.clearQueryHistory()
    })
    dom.closeHistoryBtn.addEventListener('click', () => {
      this.queryHistoryDrawer.close()
      this.dataGrid?.handleViewportResize()
    })

    // Wire grid subbar & pagination
    dom.addRowBtn.addEventListener('click', () => this.dataGrid?.addBlankRow())
    dom.delRowBtn.addEventListener('click', () => this.dataGrid?.bulkMarkRowsDeleted())
    dom.cloneRowBtn.addEventListener('click', () => this.dataGrid?.bulkCloneSelectedRows())
    dom.inspectCellBtn.addEventListener('click', () => this.toggleValueInspector())
    dom.dmlPreviewBtn.addEventListener('click', () => {
      void this.previewStagedChanges()
    })
    dom.submitBtn.addEventListener('click', () => {
      void this.submitStagedChanges()
    })
    dom.revertBtn.addEventListener('click', () => {
      this.dataGrid?.revertAllChanges()
      if (this.dmlPreviewEl) this.dmlPreviewEl.style.display = 'none'
      this.updateStatus('Reverted staged changes')
    })
    dom.transposeBtn.addEventListener('click', () => {
      if (!this.dataGrid || !this.transposeBtn) return
      const next = !this.dataGrid.getTransposed()
      this.dataGrid.setTransposed(next)
      this.transposeBtn.classList.toggle('active', next)
      this.saveStudioViewState()
    })
    dom.columnsBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.toggleColumnsPopover()
    })
    dom.editTableBtn.addEventListener('click', () => {
      if (this.activeObjectKind && !this.isTabularKind(this.activeObjectKind)) return
      this.switchMode('inspector')
    })
    dom.importDataBtn.addEventListener('click', () => {
      void this.openImportDataModal()
    })
    this.updateExportDropdownOptions()
    dom.exportSelectEl.addEventListener('change', () => {
      const val = this.exportSelectEl?.value || ''
      if (!val) return
      this.handleExportAction(val)
      if (this.exportSelectEl) {
        this.exportSelectEl.value = ''
        syncStudioSelectTooltip(this.exportSelectEl, 'Export Format')
      }
    })
    dom.batchModeBtn.addEventListener('click', () => {
      if (!this.dataGrid || !this.batchModeBtn) return
      const next = !this.dataGrid.isBatchMode()
      this.dataGrid.setBatchMode(next)
      this.batchModeBtn.classList.toggle('active', next)
      this.batchModeBtn.textContent = next ? 'Batch: Staged' : 'Auto-Commit'
    })
    dom.prevBtn.addEventListener('click', () => {
      if (this.isShowingSqlResult || this.isTableLoading) return
      if (this.activeConnectionId && this.activeTable && this.currentPage > 1) {
        void this.loadTableData(this.activeConnectionId, this.activeTable, this.currentPage - 1)
      }
    })
    dom.nextBtn.addEventListener('click', () => {
      if (this.isShowingSqlResult || this.isTableLoading) return
      if (
        this.activeConnectionId &&
        this.activeTable &&
        this.currentPage * this.pageSize < this.totalRows
      ) {
        void this.loadTableData(this.activeConnectionId, this.activeTable, this.currentPage + 1)
      }
    })
    dom.pageSizeSelectEl.addEventListener('change', () => {
      const nextSize = Number(this.pageSizeSelectEl?.value)
      if (!Number.isFinite(nextSize) || nextSize < 1) return
      this.pageSize = nextSize
      this.currentPage = 1
      syncStudioSelectTooltip(this.pageSizeSelectEl, 'Rows per page')
      this.saveStudioViewState()
      if (!this.isShowingSqlResult && this.activeConnectionId && this.activeTable) {
        void this.loadTableData(this.activeConnectionId, this.activeTable, 1)
      }
    })

    // Wire filter toolbar & find navigation
    dom.whereInputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        void this.applyServerFilters()
      }
    })
    dom.orderByInputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        void this.applyServerFilters()
      }
    })
    dom.filterBtn.addEventListener('click', () => {
      void this.applyServerFilters()
    })
    dom.clearFilterBtn.addEventListener('click', () => {
      void this.clearAllFilters()
    })
    dom.searchModeBtn.addEventListener('click', () => {
      this.setGridSearchMode(this.searchMode === 'filter' ? 'find' : 'filter')
    })
    dom.clientSearchEl.addEventListener('input', () => {
      this.cancelClientSearchDebounce()
      this.clientSearchDebounceTimer = setTimeout(() => {
        this.clientSearchDebounceTimer = null
        this.applyClientSearchOrFind()
      }, 150)
    })
    dom.clientSearchEl.addEventListener('keydown', (e) => {
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
    dom.findPrevBtn.addEventListener('click', () => {
      const state = this.dataGrid?.findNext(-1)
      this.updateFindCounter(state)
    })
    dom.findNextBtn.addEventListener('click', () => {
      const state = this.dataGrid?.findNext(1)
      this.updateFindCounter(state)
    })

    // Wire DML preview, query banner & status bar
    dom.dmlApplyBtn.addEventListener('click', () => {
      void this.submitStagedChanges()
    })
    dom.dmlCopyBtn.addEventListener('click', () => {
      const fullSql = this.lastPreviewDmlText || this.dmlPreviewPreEl?.textContent || ''
      if (fullSql) {
        void copyTextFallback(fullSql).then((copied) => {
          if (this.isDestroyed) return
          this.updateStatus(
            copied ? 'Copied full DML SQL to clipboard' : 'Failed to copy full DML SQL to clipboard'
          )
        })
      }
    })
    dom.dmlCloseBtn.addEventListener('click', () => {
      if (this.dmlPreviewEl) this.dmlPreviewEl.style.display = 'none'
      this.dataGrid?.handleViewportResize()
    })
    dom.queryBannerRetryBtn.addEventListener('click', () => {
      const fn = this.queryBannerRetryHandler
      if (fn) fn()
    })
    dom.queryBannerEditConnBtn.addEventListener('click', () => {
      const fn = this.queryBannerEditConnHandler
      if (fn) fn()
    })
    dom.queryBannerBackBtn.addEventListener('click', () => {
      if (this.activeConnectionId && this.activeTable) {
        void this.loadTableData(this.activeConnectionId, this.activeTable, 1)
      }
    })
    dom.queryBannerFixAiBtn.addEventListener('click', () => {
      void this.handleFixWithAiClick()
    })
    dom.queryBannerCopyBtn.addEventListener('click', () => {
      if (!this.lastQueryErrorText) return
      void copyTextFallback(this.lastQueryErrorText, this.queryBannerCopyBtn).then((copied) => {
        if (this.isDestroyed) return
        this.updateStatus(
          copied ? 'Copied query error to clipboard' : 'Failed to copy query error to clipboard'
        )
      })
    })
    dom.queryBannerReportBtn.addEventListener('click', () => this.openFeedbackModal('bug'))
    dom.queryBannerCloseBtn.addEventListener('click', () => this.dismissActiveQueryBanner())
    dom.statusSelectionEl.addEventListener('click', () => {
      const text = this.statusSelectionEl?.textContent || ''
      if (text) {
        void copyTextFallback(text).then((copied) => {
          if (this.isDestroyed) return
          this.updateStatus(
            copied
              ? 'Copied selection statistics to clipboard'
              : 'Failed to copy selection statistics to clipboard'
          )
        })
      }
    })
    dom.shortcutsBtn.addEventListener('click', () => this.openShortcutsModal())
    dom.feedbackBtn.addEventListener('click', () => this.openFeedbackModal())

    document.body.appendChild(this.rootEl)

    // Mount CodeMirror SQL Console
    this.sqlConsole = new SqlConsoleController({
      parent: this.sqlAreaEl,
      initialDoc: '-- Datanoa SQL Console\nSELECT 1;\n',
      dialect: 'sqlite',
      schema: this.schemaMap,
      aiInline: {
        isEnabled: () => this.isAiInlineReady() && Boolean(this.activeConnectionId),
        getConnectionId: () => this.activeConnectionId,
        requestCompletion: async ({
          prefix,
          suffix,
          signal,
          manual,
          mode,
        }: {
          prefix: string
          suffix: string
          offset: number
          signal: AbortSignal
          manual?: boolean
          mode?: 'auto' | 'complete' | 'edit'
        }) => {
          const conn = this.getActiveConnection()
          if (!conn) return null
          if (isActiveSqlStatementSensitive(prefix, suffix, conn.driver || 'sqlite', mode)) return null
          const reqMode: 'auto' | 'complete' | 'edit' =
            mode === 'edit' ? 'edit' : manual ? 'complete' : 'auto'
          const pending = this.pendingConfirmedInlineAi
          const isConfirmedManual = Boolean(
            manual &&
              (reqMode === 'edit' || reqMode === 'complete') &&
              pending &&
              pending.connectionId === conn.id &&
              pending.mode === reqMode &&
              pending.prefix === prefix &&
              pending.suffix === suffix
          )
          if (manual) {
            this.pendingConfirmedInlineAi = null
          }
          try {
            return await this.requestPlugin<{
              suggestion: string
              id: number
              replaceChars?: number
              edits?: Array<{ fromOffset: number; toOffset: number; insert: string }>
              mode?: 'complete' | 'edit'
            }>(
              'ai.complete',
              {
                connectionId: conn.id,
                dialect: conn.driver,
                prefix,
                suffix,
                ...(manual ? { manual: true } : {}),
                ...(mode && mode !== 'auto' ? { mode } : {}),
                ...(isConfirmedManual ? { confirmed: true } : {}),
                activeSchema: this.selectedSchema,
                activeTable: this.activeTable ?? undefined,
                schemaMap: this.schemaMap,
              },
              { signal, timeoutMs: 25_000 }
            )
          } catch (err) {
            if (!signal.aborted && !this.isDestroyed) {
              void this.hydrateAiStatus()
            }
            throw err
          }
        },
        onRequestError: (err: unknown, ctx?: CmInlineAiRequestErrorContext) => {
          if (this.isDestroyed) return
          const errMode: 'complete' | 'edit' = ctx?.mode === 'complete' ? 'complete' : 'edit'
          const msg =
            err instanceof Error
              ? err.message
              : String(err || (errMode === 'complete' ? 'AI completion failed' : 'Inline AI edit failed'))
          const targetConnId = ctx?.connectionId ?? this.activeConnectionId
          const conn = targetConnId ? this.connections.find((c) => c.id === targetConnId) : undefined
          const rawPolicy = conn?.aiPolicy
          const rawTag = String(conn?.colorTag || '').trim().toLowerCase()
          const effectivePolicy =
            rawPolicy === 'never' || rawPolicy === 'ask' || rawPolicy === 'allow'
              ? rawPolicy
              : rawTag === 'prod' || rawTag === 'production'
                ? 'ask'
                : 'allow'
          const isBlocked = /ai\.blocked/i.test(msg)
          const isNever =
            /\bpolicy:\s*never\b|disabled for this connection/i.test(msg) ||
            effectivePolicy === 'never'
          if (isBlocked && !isNever && targetConnId) {
            const bannerTitle =
              errMode === 'complete' ? 'Confirm AI Completion' : 'Confirm AI Inline Edit'
            const retryLabel =
              errMode === 'complete'
                ? 'Confirm & Retry AI Completion'
                : 'Confirm & Retry AI Edit'
            const boundPrefix = typeof ctx?.prefix === 'string' ? ctx.prefix : ''
            const boundSuffix = typeof ctx?.suffix === 'string' ? ctx.suffix : ''
            this.showQueryBanner('error', bannerTitle, msg, {
              connectionId: targetConnId,
              retryLabel,
              onRetry: () => {
                this.hideQueryBanner()
                this.pendingConfirmedInlineAi = {
                  connectionId: targetConnId,
                  mode: errMode,
                  prefix: boundPrefix,
                  suffix: boundSuffix,
                }
                this.sqlConsole?.focus()
                const cmContent = this.sqlAreaEl?.querySelector('.cm-content')
                cmContent?.dispatchEvent(
                  new KeyboardEvent(
                    'keydown',
                    errMode === 'complete'
                      ? { key: 'Tab', code: 'Tab', bubbles: true, cancelable: true }
                      : {
                          key: '\\',
                          code: 'Backslash',
                          altKey: true,
                          bubbles: true,
                          cancelable: true,
                        }
                  )
                )
              },
            })
            return
          }
          if (isBlocked) {
            this.showQueryBanner(
              'error',
              errMode === 'complete' ? 'AI Completion Blocked' : 'AI Inline Edit Blocked',
              msg,
              {
                connectionId: targetConnId ?? null,
              }
            )
            return
          }
          this.updateStatus(
            `${errMode === 'complete' ? 'AI completion' : 'Inline AI edit'} failed: ${msg}`
          )
        },
        onMetric: (id: number, kind: AiMetricKind) => {
          void this.requestPlugin('ai.metrics.event', { id, kind }).catch(() => {})
        },
      },
      onExecute: () => {
        void this.executeSql(false)
      },
      onExecuteAll: () => {
        void this.executeSql(true)
      },
      onFormatSql: () => {
        this.formatSqlInConsole()
      },
      keymapSettings: this.currentKeymapSettings,
      onVimModeChange: (snapshot) => {
        this.updateVimModePill(snapshot)
      },
      onChange: (doc) => {
        if (!this.suppressDocSync) {
          this.consoleTabs.updateActiveSql(doc)
          this.documentSession?.change?.(this.composeSerializedDocument(doc))
          this.saveStudioViewState(false)
        }
      },
    })
    this.updateVimModePill(this.sqlConsole.getVimModeSnapshot())

    this.consoleTabs = new ConsoleTabsManager(this.sqlConsole.getText())
    this.renderConsoleTabs()

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
      onColumnHeaderFilter: (column, value, op, mode) => {
        void this.handleColumnHeaderFilter(column, value, op, mode)
      },
      onNavigateForeignKey: (refTable, refColumn, value) => {
        void this.handleNavigateForeignKey(refTable, refColumn, value)
      },
      onColumnConfigChange: (config) => {
        this.handleColumnConfigChanged(config)
      },
      onTableDisplayStateChange: (entry) => {
        void this.handleTableDisplayStateChanged(entry)
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
      isManualTxActive: () => this.txToolbar.hasActiveOrManualTx(),
      onInsertDdl: (ddl) => {
        this.sqlConsole?.insertText(ddl)
        if (this.activeViewMode !== 'split' && this.activeViewMode !== 'sql') {
          this.switchMode('split')
        }
        this.updateStatus('Inserted DDL into SQL Console')
      },
      onCopyDdl: (_ddl, copied) => {
        this.updateStatus(
          copied === false ? 'Failed to copy DDL to clipboard' : 'Copied DDL to clipboard'
        )
      },
      onOpenDdlInConsole: (ddl) => {
        this.sqlConsole?.insertText(ddl)
        if (this.activeViewMode !== 'split' && this.activeViewMode !== 'sql') {
          this.switchMode('split')
        }
        this.updateStatus('Opened DDL in SQL Console')
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

    // Mount ER Diagram View
    if (this.erAreaEl) {
      this.erDiagramView = new ErDiagramView({
        container: this.erAreaEl,
        requestPlugin: (method, payload, opts) => this.requestPlugin(method, payload, opts),
        onOpenTable: (schema, table) => {
          const matched =
            this.schemaObjects.find(
              (o) =>
                o.name === table &&
                (!schema || !o.schema || o.schema.toLowerCase() === schema.toLowerCase())
            ) ?? {
              name: table,
              schema: schema || this.activeSchema || '',
              kind: 'table' as const,
            }
          this.selectSidebarObject(matched, { skipErFocus: true })
          this.switchMode('split')
        },
        onUpdateStatus: (stateText, metricsText) => this.updateStatus(stateText, metricsText),
      })
    }
  }

  private composeSerializedDocument(visibleSql: string): string {
    return composeDatanoaDocument(this.preservedMetadataLines, visibleSql)
  }

  private updateMetadataHeader(key: 'connectionId' | 'table' | 'schema', value: string): void {
    upsertDatanoaMetadataHeader(this.preservedMetadataLines, key, value)
    if (!this.suppressDocSync && this.sqlConsole) {
      this.documentSession?.change?.(this.composeSerializedDocument(this.sqlConsole.getText()))
    }
  }

  private removeMetadataHeader(key: 'connectionId' | 'table' | 'schema'): void {
    if (!removeDatanoaMetadataHeader(this.preservedMetadataLines, key)) return
    if (!this.suppressDocSync && this.sqlConsole) {
      this.documentSession?.change?.(this.composeSerializedDocument(this.sqlConsole.getText()))
    }
  }

  private resetSplitPaneHeight(): void {
    if (!this.sqlAreaEl) return
    this.customSqlPanePx = null
    this.sqlAreaEl.style.flex = this.activeViewMode === 'sql' ? '0 0 55%' : '0 0 34%'
    this.syncSplitResizerAria(null)
    this.dataGrid?.handleViewportResize()
    this.saveStudioViewState(true)
  }

  private handleSplitResizerKeyDown(e: KeyboardEvent): void {
    if (!this.sqlAreaEl) return
    const bounds = this.getSplitPaneBounds()
    const measuredH = this.sqlAreaEl.getBoundingClientRect?.().height || 0
    const currentH =
      this.customSqlPanePx !== null
        ? this.getClampedSqlPanePx(this.customSqlPanePx, bounds)
        : measuredH > 0
          ? this.getClampedSqlPanePx(measuredH, bounds)
          : Math.round((bounds.min + bounds.max) / 2)
    let targetPx: number | null = null
    if (e.key === 'ArrowDown') targetPx = currentH + 24
    else if (e.key === 'ArrowUp') targetPx = currentH - 24
    else if (e.key === 'Home') targetPx = bounds.min
    else if (e.key === 'End') targetPx = bounds.max
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      this.resetSplitPaneHeight()
      return
    }
    if (targetPx === null) return
    e.preventDefault()
    const clamped = this.getClampedSqlPanePx(targetPx, bounds)
    this.customSqlPanePx = clamped
    this.sqlAreaEl.style.flex = `0 0 ${clamped}px`
    this.syncSplitResizerAria(clamped, bounds)
    this.dataGrid?.handleViewportResize()
    this.saveStudioViewState(true)
  }

  private cancelSplitResize(): void {
    if (this.splitResizeRafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.splitResizeRafId)
      this.splitResizeRafId = null
    }
    if (this.splitResizeListeners && typeof window !== 'undefined') {
      window.removeEventListener('mousemove', this.splitResizeListeners.move)
      window.removeEventListener('mouseup', this.splitResizeListeners.up)
      window.removeEventListener('blur', this.splitResizeListeners.blur)
      window.removeEventListener('keydown', this.splitResizeListeners.keydown)
      this.splitResizeListeners = null
    }
    this.splitResizerEl?.classList.remove('resizing')
    this.mainViewEl?.classList.remove('datanoa-split-resizing')
    if (typeof document !== 'undefined' && document.body) {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    this.dataGrid?.setViewportResizing(false)
  }

  private startSplitResize(e: MouseEvent): void {
    if (e.button !== undefined && e.button !== 0) return
    if (!this.sqlAreaEl || !this.mainViewEl || !this.splitResizerEl || typeof window === 'undefined') {
      return
    }
    e.preventDefault()
    this.cancelSplitResize()

    const startY = e.clientY
    const bounds = this.getSplitPaneBounds()
    const rawStartHeight = this.sqlAreaEl.getBoundingClientRect().height
    const startHeight =
      Number.isFinite(rawStartHeight) && rawStartHeight > 0
        ? rawStartHeight
        : (this.customSqlPanePx ?? bounds.min)
    let pendingPx = this.getClampedSqlPanePx(startHeight, bounds)
    let lastAppliedPx = -1
    let rafPending = false

    this.syncSplitResizerAria(pendingPx, bounds)
    this.splitResizerEl.classList.add('resizing')
    this.mainViewEl.classList.add('datanoa-split-resizing')
    this.dataGrid?.setViewportResizing(true)
    if (typeof document !== 'undefined' && document.body) {
      document.body.style.cursor = 'row-resize'
      document.body.style.userSelect = 'none'
    }

    const applyPendingSplitHeight = () => {
      rafPending = false
      this.splitResizeRafId = null
      if (!this.sqlAreaEl || pendingPx === lastAppliedPx) return
      lastAppliedPx = pendingPx
      this.customSqlPanePx = pendingPx
      this.sqlAreaEl.style.flex = `0 0 ${pendingPx}px`
      this.splitResizerEl?.setAttribute('aria-valuenow', String(pendingPx))
      if (typeof ResizeObserver !== 'function') {
        this.dataGrid?.handleViewportResize()
      }
    }

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!this.sqlAreaEl) return
      if (moveEvent.isTrusted && moveEvent.buttons === 0) {
        finishSplitResize()
        return
      }
      const nextPx = this.getClampedSqlPanePx(startHeight + (moveEvent.clientY - startY), bounds)
      if (nextPx === pendingPx) return
      pendingPx = nextPx
      if (typeof requestAnimationFrame === 'function') {
        if (!rafPending) {
          rafPending = true
          const id = requestAnimationFrame(applyPendingSplitHeight)
          this.splitResizeRafId = rafPending ? id : null
        }
      } else {
        applyPendingSplitHeight()
      }
    }

    const onKeyDown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === 'Escape') {
        keyEvent.preventDefault()
        rafPending = false
        this.cancelSplitResize()
      }
    }

    const finishSplitResize = () => {
      rafPending = false
      if (this.splitResizeRafId !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(this.splitResizeRafId)
        this.splitResizeRafId = null
      }
      if (pendingPx !== lastAppliedPx) {
        applyPendingSplitHeight()
      }
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', finishSplitResize)
      window.removeEventListener('blur', finishSplitResize)
      window.removeEventListener('keydown', onKeyDown)
      this.splitResizeListeners = null
      this.splitResizerEl?.classList.remove('resizing')
      this.mainViewEl?.classList.remove('datanoa-split-resizing')
      if (typeof document !== 'undefined' && document.body) {
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
      this.dataGrid?.setViewportResizing(false)
      this.saveStudioViewState(true)
    }

    this.splitResizeListeners = {
      move: onMouseMove,
      up: finishSplitResize,
      blur: finishSplitResize,
      keydown: onKeyDown,
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', finishSplitResize)
    window.addEventListener('blur', finishSplitResize)
    window.addEventListener('keydown', onKeyDown)
  }

  private erKey(): string {
    return `${this.activeConnectionId || ''}:${this.selectedSchema || this.activeSchema || ''}`
  }

  /** Reloads ER Diagram when the ER tab is active and the connection/schema key changed. */
  private syncErDiagramIfActive(): void {
    if (this.activeViewMode !== 'er' || !this.activeConnectionId) return
    const targetErKey = this.erKey()
    if (this.lastErLoadedKey !== targetErKey) {
      this.lastErLoadedKey = targetErKey
      void this.erDiagramView?.load({
        connectionId: this.activeConnectionId,
        schema: this.selectedSchema || this.activeSchema,
      })
    }
  }

  private switchMode(
    mode: StudioViewMode,
    options?: { persistViewState?: boolean }
  ): void {
    this.cancelSplitResize()
    if (this.activeViewMode === 'er' && mode !== 'er') {
      this.erDiagramView?.flushPendingLayoutSave(false)
    }
    if (this.activeViewMode === 'inspector' && mode !== 'inspector') {
      if (this.schemaInspector?.isMigrationInFlight()) {
        this.updateStatus('Wait for schema migration to finish before switching views')
        return
      }
      this.schemaInspector?.closeConfirmModalIfIdle()
    }

    this.suppressOneShotPersistViewMode = options?.persistViewState === false && mode === 'er'
    this.activeViewMode = mode
    if (
      (mode === 'grid' || mode === 'inspector') &&
      this.isShowingSqlResult &&
      this.activeQueryResult === null &&
      this.activeConnectionId &&
      this.activeTable
    ) {
      this.isShowingSqlResult = false
      this.hideQueryBanner()
      void this.loadTableData(this.activeConnectionId, this.activeTable, this.currentPage)
    }
    if (this.tabButtons) {
      this.tabButtons.split.classList.toggle('active', mode === 'split')
      this.tabButtons.grid.classList.toggle('active', mode === 'grid')
      this.tabButtons.sql.classList.toggle('active', mode === 'sql')
      this.tabButtons.inspector.classList.toggle('active', mode === 'inspector')
      this.tabButtons.er.classList.toggle('active', mode === 'er')
    }

    if (!this.sqlAreaEl || !this.gridAreaEl || !this.inspectorAreaEl) return

    const showSqlChrome = mode === 'split' || mode === 'sql'
    const showGridChrome = isGridVisibleMode(mode)
    if (this.sqlToolbarEl) {
      this.sqlToolbarEl.style.display = showSqlChrome ? 'flex' : 'none'
    }
    if (this.consoleTabsBarEl) {
      this.consoleTabsBarEl.style.display = showSqlChrome ? 'flex' : 'none'
    }
    this.renderResultSetsBar()
    if (!showSqlChrome && this.historyDrawerEl) {
      this.queryHistoryDrawer.close()
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
      if (this.erAreaEl) this.erAreaEl.style.display = 'none'
    } else if (mode === 'grid') {
      this.sqlAreaEl.style.display = 'none'
      this.gridAreaEl.style.display = 'block'
      this.inspectorAreaEl.style.display = 'none'
      if (this.erAreaEl) this.erAreaEl.style.display = 'none'
    } else if (mode === 'sql') {
      this.sqlAreaEl.style.display = 'block'
      this.sqlAreaEl.style.flex = '0 0 55%'
      this.gridAreaEl.style.display = 'block'
      this.inspectorAreaEl.style.display = 'none'
      if (this.erAreaEl) this.erAreaEl.style.display = 'none'
    } else if (mode === 'er') {
      this.sqlAreaEl.style.display = 'none'
      this.gridAreaEl.style.display = 'none'
      this.inspectorAreaEl.style.display = 'none'
      this.closeValueInspector()
      if (this.dmlPreviewEl) this.dmlPreviewEl.style.display = 'none'
      if (this.erAreaEl) this.erAreaEl.style.display = 'flex'
      this.syncErDiagramIfActive()
    } else {
      this.sqlAreaEl.style.display = 'none'
      this.gridAreaEl.style.display = 'none'
      if (this.erAreaEl) this.erAreaEl.style.display = 'none'
      this.closeValueInspector()
      if (this.dmlPreviewEl) this.dmlPreviewEl.style.display = 'none'
      this.inspectorAreaEl.style.display = 'flex'
      const targetKey = this.inspectorKey()
      if (this.lastInspectorLoadedKey !== targetKey) {
        if (this.activeObjectKind && !this.isTabularKind(this.activeObjectKind)) {
          if (this.activeReadOnlyObject) {
            this.lastInspectorLoadedKey = targetKey
            void this.loadReadOnlyObjectDdl(this.activeReadOnlyObject)
          }
        } else {
          void this.loadActiveTableSchema()
        }
      }
    }

    this.syncQueryBannerForViewMode()

    if (showGridChrome) {
      this.dataGrid?.handleViewportResize()
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => {
          if (isGridVisibleMode(this.activeViewMode)) {
            this.dataGrid?.handleViewportResize()
          }
        })
      }
    }
    if (options?.persistViewState !== false) {
      this.saveStudioViewState(true)
    }
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
    if (this.topbarAllBtn) {
      this.topbarAllBtn.classList.remove('active')
      this.topbarAllBtn.setAttribute('aria-expanded', 'false')
    }
  }

  private isObjectActive(
    name: string | undefined,
    schema: string | undefined,
    kind?: SchemaObjectKind
  ): boolean {
    if (!name) return false
    const curKind = this.activeObjectKind
    if (kind && curKind && kind !== curKind) return false
    const readonly = curKind !== null && !this.isTabularKind(curKind)
    const currentName = readonly ? this.activeReadOnlyObject?.name : this.activeTable
    if (!currentName || name !== currentName) return false
    const curSchema = this.activeSchema || ''
    const itemSchema = schema || ''
    if (curSchema || itemSchema) {
      return curSchema === itemSchema
    }
    return true
  }

  private inspectorKey(): string {
    const kind = this.activeObjectKind
    const name =
      kind && !this.isTabularKind(kind)
        ? this.activeReadOnlyObject?.name || ''
        : this.activeTable || ''
    return `${this.activeConnectionId || ''}:${this.activeSchema || ''}:${kind || ''}:${name}`
  }

  private toggleTopbarAllTablesPopover(): void {
    if (this.topbarPopoverEl) {
      this.closeTopbarPopover()
      return
    }
    if (!this.topbarAllBtn || typeof document === 'undefined' || !document.body) return

    const pop = document.createElement('div')
    pop.className = 'datanoa-topbar-popover'

    const { focusSearch } = renderStudioTopbarObjectsPopover({
      popoverEl: pop,
      objects: this.schemaObjects,
      initialFilterQuery: this.topbarFilterInputEl?.value || '',
      collapsedGroups: this.collapsedTopbarGroups,
      isObjectActive: (name, schema, kind) => this.isObjectActive(name, schema, kind),
      onSelectObject: (item) => {
        this.closeTopbarPopover()
        this.activateSidebarObject(item)
      },
      onOpenContextMenu: (x, y, item) => {
        this.closeTopbarPopover()
        this.openSidebarContextMenu(x, y, item)
      },
      onClose: () => {
        this.closeTopbarPopover()
        this.topbarAllBtn?.focus?.()
      },
    })

    document.body.appendChild(pop)
    this.topbarPopoverEl = pop
    this.topbarAllBtn.classList.add('active')
    this.topbarAllBtn.setAttribute('aria-expanded', 'true')

    if (typeof this.topbarAllBtn.getBoundingClientRect === 'function') {
      const rect = this.topbarAllBtn.getBoundingClientRect()
      const vw = typeof window !== 'undefined' ? window.innerWidth || 1024 : 1024
      const vh = typeof window !== 'undefined' ? window.innerHeight || 768 : 768
      const popWidth = Math.min(300, Math.max(220, vw - 16))
      pop.style.width = `${popWidth}px`
      const left = Math.max(8, Math.min(Math.round(rect.right - popWidth), vw - popWidth - 8))
      pop.style.left = `${left}px`

      const spaceBelow = vh - rect.bottom - 10
      const spaceAbove = rect.top - 10
      if (spaceBelow < 220 && spaceAbove > spaceBelow) {
        const maxH = Math.max(160, Math.min(380, spaceAbove))
        pop.style.maxHeight = `${maxH}px`
        pop.style.top = 'auto'
        pop.style.bottom = `${Math.max(8, Math.round(vh - rect.top + 4))}px`
      } else {
        const maxH = Math.max(160, Math.min(380, spaceBelow))
        pop.style.maxHeight = `${maxH}px`
        pop.style.bottom = 'auto'
        pop.style.top = `${Math.round(rect.bottom + 4)}px`
      }
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

    focusSearch()
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
        const kind = htmlEl.dataset?.objectKind as SchemaObjectKind | undefined
        el.classList.toggle('active', this.isObjectActive(tbl, sch, kind))
      })
    }
    if (this.topbarTrackEl) {
      const pills = this.topbarTrackEl.querySelectorAll('.datanoa-topbar-pill')
      pills.forEach((el) => {
        const htmlEl = el as HTMLElement
        const tbl = htmlEl.dataset?.tableName
        const sch = htmlEl.dataset?.tableSchema
        const kind = htmlEl.dataset?.objectKind as SchemaObjectKind | undefined
        el.classList.toggle('active', this.isObjectActive(tbl, sch, kind))
      })
      if (this.sidebarCollapsed) {
        this.scrollActiveTopbarPillIntoView()
      }
    }
  }

  private async claimNavToken(token: string): Promise<boolean> {
    if (!token) return true
    if (
      this.consumedNavTokens.has(token) ||
      this.claimingNavTokens.has(token) ||
      hasStoredConsumedNavToken(token)
    ) {
      this.consumedNavTokens.add(token)
      return false
    }
    this.claimingNavTokens.add(token)
    try {
      if (
        typeof window !== 'undefined' &&
        typeof window.orca?.plugin?.request === 'function'
      ) {
        try {
          const res = await this.requestPlugin<{
            consumed?: boolean
            alreadyConsumed?: boolean
          }>('studio.navToken.consume', { navToken: token })
          if (this.isDestroyed) return false
          if (res && typeof res.consumed === 'boolean') {
            markStoredConsumedNavToken(this.consumedNavTokens, token)
            return Boolean(res.consumed && !res.alreadyConsumed)
          }
        } catch {
          // Fall back to localStorage/in-memory tracking when mock/host lacks studio.navToken.consume
        }
      }
      if (this.isDestroyed) return false
      markStoredConsumedNavToken(this.consumedNavTokens, token)
      return true
    } finally {
      this.claimingNavTokens.delete(token)
    }
  }

  private applySameConnectionNavigation(
    connectionId: string,
    schema: string | undefined,
    table: string | undefined
  ): void {
    this.pendingDocConnectionId = null
    this.pendingDocTable = null
    this.pendingDocSchema = undefined
    this.pendingBootDataCache = null
    if (schema && schema !== this.selectedSchema) {
      this.selectedSchema = schema
      this.activeSchema = schema
      this.recordSelectedSchema(connectionId, schema, true)
      this.activeTable = table || null
      this.activeObjectKind = null
      this.activeReadOnlyObject = null
      this.isShowingSqlResult = false
      this.activeQueryResult = null
      this.lastPageData = null
      this.activeWhereClause = undefined
      this.activeOrderByClause = undefined
      this.restoredPageOnBoot = 1
      this.currentPage = 1
      if (this.whereInputEl) this.whereInputEl.value = ''
      if (this.orderByInputEl) this.orderByInputEl.value = ''
      this.dataGrid?.clearSortIndicator()
      this.dataGrid?.clearClientColumnFilters()
      this.lastInspectorLoadedKey = ''
      this.lastErLoadedKey = ''
      this.updateSchemaSwitcherDisplay()
      if (this.shouldSyncMetadataHeaders()) {
        this.updateMetadataHeader('schema', schema)
        if (table) {
          this.updateMetadataHeader('table', table)
        } else {
          this.removeMetadataHeader('table')
        }
      }
      const cachedObjs = this.schemaObjectsByConnSchema.get(
        this.makeConnSchemaKey(connectionId, schema)
      )
      if (cachedObjs) {
        this.schemaObjects = cachedObjs
        this.isIntrospectingSchema = false
        this.renderSidebarObjects()
      }
      this.saveStudioViewState(true)
      void this.introspectSchema(connectionId, false)
      this.syncErDiagramIfActive()
      return
    }
    if (
      table &&
      (table !== this.activeTable || (schema || '') !== (this.activeSchema || ''))
    ) {
      this.activeTable = table
      this.activeObjectKind = null
      this.activeReadOnlyObject = null
      this.activeSchema =
        schema ||
        this.schemaObjects.find((o) => o.name === table)?.schema ||
        undefined
      if (schema) {
        this.selectedSchema = schema
        this.recordSelectedSchema(connectionId, schema, true)
      }
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
      this.saveStudioViewState(true)
      void this.loadTableData(connectionId, this.activeTable, 1)
      if (this.activeViewMode === 'inspector') {
        void this.loadActiveTableSchema()
      }
    }
  }

  public applyDocumentMetadata(
    docText: string,
    options?: {
      resetCautionDismissal?: boolean
      skipOneShotNav?: boolean
      preClaimedNavToken?: string
    }
  ): void {
    const parsed = parseDatanoaDocument(docText)
    const parsedAction = extractDatanoaDocumentAction(docText)
    const parsedNavToken = extractDatanoaDocumentNavToken(docText)
    this.preservedMetadataLines = stripDatanoaNavTokenHeader(
      stripDatanoaActionHeader(stripDatanoaViewModeHeader(parsed.metadataLines))
    )
    if (options?.resetCautionDismissal) {
      this.dismissedCautionKey = null
    }

    this.suppressDocSync = true
    try {
      if (this.sqlConsole && this.sqlConsole.getText() !== parsed.cleanSql) {
        this.sqlConsole.setText(parsed.cleanSql)
      }
      this.consoleTabs.updateActiveSql(parsed.cleanSql)
    } finally {
      this.suppressDocSync = false
    }

    const targetConnectionId = parsed.connectionId || this.activeConnectionId
    const applyOneShotNav = () => {
      if (this.isDestroyed || options?.skipOneShotNav) return
      if (parsed.viewMode) {
        this.lastErLoadedKey = ''
        this.switchMode(parsed.viewMode, { persistViewState: false })
      }
      if (parsedAction === 'import') {
        this.pendingDocAction = 'import'
        this.pendingImportTarget = {
          connectionId: targetConnectionId,
          schema: parsed.schema,
          table: parsed.table,
        }
        if (
          this.hasLoadedActiveConnection &&
          (!targetConnectionId || this.activeConnectionId === targetConnectionId)
        ) {
          this.consumePendingImportAction()
        }
      }
    }

    if (!options?.skipOneShotNav && !parsedNavToken && parsedAction === 'import') {
      this.pendingDocAction = 'import'
      this.pendingImportTarget = {
        connectionId: targetConnectionId,
        schema: parsed.schema,
        table: parsed.table,
      }
    }
    const isAlreadyLoadedSameConnection =
      Boolean(targetConnectionId) &&
      this.connections.length > 0 &&
      this.activeConnectionId === targetConnectionId &&
      this.hasLoadedActiveConnection

    if (isAlreadyLoadedSameConnection && targetConnectionId) {
      if (options?.resetCautionDismissal) {
        this.applyActiveConnectionPresentation(this.getActiveConnection())
      }
      if (
        parsed.table ||
        (parsed.schema && parsed.schema !== this.selectedSchema)
      ) {
        this.applySameConnectionNavigation(targetConnectionId, parsed.schema, parsed.table)
      }
      if (!options?.skipOneShotNav) {
        if (
          parsedNavToken &&
          options?.preClaimedNavToken !== parsedNavToken &&
          (parsed.viewMode || parsedAction === 'import')
        ) {
          void this.claimNavToken(parsedNavToken).then((claimed) => {
            if (claimed) applyOneShotNav()
          })
        } else {
          applyOneShotNav()
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
      if (connDiffers && !parsed.schema) {
        this.selectedSchema = undefined
        this.pendingDocSchema = undefined
        this.activeSchema = undefined
        this.availableSchemas = []
        this.defaultSchema = undefined
      } else if (parsed.table && !parsed.schema) {
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
      this.activeObjectKind = null
      this.activeReadOnlyObject = null
    }
    if (parsed.schema) {
      this.pendingDocSchema = parsed.schema
      this.activeSchema = parsed.schema
      this.selectedSchema = parsed.schema
    }

    if (this.connections.length > 0 && targetConnectionId) {
      const conn = this.connections.find((c) => c.id === targetConnectionId)
      if (conn) {
        this.handleConnectionChanged(conn.id, true)
      }
    }
    if (!options?.skipOneShotNav) {
      if (
        parsedNavToken &&
        options?.preClaimedNavToken !== parsedNavToken &&
        (parsed.viewMode || parsedAction === 'import')
      ) {
        void this.claimNavToken(parsedNavToken).then((claimed) => {
          if (claimed) applyOneShotNav()
        })
      } else {
        applyOneShotNav()
      }
    }
  }

  private normalizeStudioDocPath(raw: unknown): string {
    if (typeof raw !== 'string') return ''
    let norm = raw.trim().replace(/\\/g, '/')
    if (!norm) return ''
    const root = this.currentWorkspaceRoot
    if (root && norm.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
      norm = norm.slice(root.length + 1)
    }
    return norm.replace(/^\.\//, '')
  }

  private getLocalWorkspaceIdSync(): string {
    if (typeof window !== 'undefined') {
      const orcaAny = window.orca as
        | { context?: { workspace?: { id?: unknown } } }
        | undefined
      const ctxWsId = orcaAny?.context?.workspace?.id
      if (typeof ctxWsId === 'string' && ctxWsId.trim()) {
        return ctxWsId.trim()
      }
    }
    return this.currentWorkspaceScope.trim()
  }

  private getLocalDocumentPathSync(): string {
    const sess = this.documentSession as
      | (DocumentSessionLike & { docPath?: unknown; relPath?: unknown; path?: unknown })
      | null
    const fromSession =
      this.normalizeStudioDocPath(sess?.docPath) ||
      this.normalizeStudioDocPath(sess?.relPath) ||
      this.normalizeStudioDocPath(sess?.path)
    if (fromSession) return fromSession
    if (typeof window !== 'undefined') {
      const orcaAny = window.orca as
        | {
            context?: {
              document?: { relPath?: unknown; path?: unknown }
            }
          }
        | undefined
      return (
        this.normalizeStudioDocPath(orcaAny?.context?.document?.relPath) ||
        this.normalizeStudioDocPath(orcaAny?.context?.document?.path)
      )
    }
    return ''
  }

  private isStudioOpenedForCurrentContext(
    openedWorkspaceId: string,
    openedDocPath: string
  ): boolean {
    const localWorkspaceId = this.getLocalWorkspaceIdSync()
    if (openedWorkspaceId && localWorkspaceId && openedWorkspaceId !== localWorkspaceId) {
      return false
    }
    const localDocPath = this.getLocalDocumentPathSync()
    if (openedDocPath && localDocPath) {
      const docMatches =
        openedDocPath === localDocPath ||
        ((localDocPath.startsWith('/') || /^[a-zA-Z]:\//.test(localDocPath)) &&
          !openedDocPath.startsWith('/') &&
          !/^[a-zA-Z]:\//.test(openedDocPath) &&
          localDocPath.endsWith(`/${openedDocPath}`))
      if (!docMatches) return false
    }
    return true
  }

  private resolveInitialDocDecision(
    docText: string,
    parsedNavToken: string | null,
    claimed: boolean
  ): void {
    if (this.isDestroyed) return
    const shouldApplyInitialDoc = parsedNavToken ? claimed : claimed || !this.hasPersistedSessionTarget()
    if (shouldApplyInitialDoc) {
      if (parsedNavToken) {
        this.hasUserInteraction = true
      }
      this.applyDocumentMetadata(docText, {
        ...(parsedNavToken ? { preClaimedNavToken: parsedNavToken } : {}),
      })
      return
    }
    if (this.hasPersistedSessionTarget()) {
      const parsed = parseDatanoaDocument(docText)
      const parsedAction = extractDatanoaDocumentAction(docText)
      this.preservedMetadataLines = stripDatanoaNavTokenHeader(
        stripDatanoaActionHeader(stripDatanoaViewModeHeader(parsed.metadataLines))
      )
      const targetConnId = this.activeConnectionId || this.pendingDocConnectionId || this.storedActiveConnectionId
      if (targetConnId) {
        upsertDatanoaMetadataHeader(this.preservedMetadataLines, 'connectionId', targetConnId)
      }
      const targetSchema = this.selectedSchema || this.pendingDocSchema || this.activeSchema
      if (targetSchema) {
        upsertDatanoaMetadataHeader(this.preservedMetadataLines, 'schema', targetSchema)
      }
      const targetTable = this.activeTable || this.pendingDocTable
      if (targetTable) {
        upsertDatanoaMetadataHeader(this.preservedMetadataLines, 'table', targetTable)
      } else {
        removeDatanoaMetadataHeader(this.preservedMetadataLines, 'table')
      }
      if (!this.hasRestoredSqlState && this.sqlConsole && !this.sqlConsole.getText() && parsed.cleanSql) {
        this.suppressDocSync = true
        try {
          this.sqlConsole.setText(parsed.cleanSql)
          this.consoleTabs.updateActiveSql(parsed.cleanSql)
        } finally {
          this.suppressDocSync = false
        }
      }
      if (!parsedNavToken && (parsed.viewMode || parsedAction === 'import')) {
        const oneShotKey = `legacy-oneshot:${parsed.connectionId || ''}:${parsed.viewMode || ''}:${parsedAction || ''}`
        const alreadyUsed =
          this.consumedNavTokens.has(oneShotKey) || hasStoredConsumedNavToken(oneShotKey)
        if (!alreadyUsed) {
          markStoredConsumedNavToken(this.consumedNavTokens, oneShotKey)
          if (parsed.viewMode) {
            this.lastErLoadedKey = ''
            this.switchMode(parsed.viewMode, { persistViewState: false })
          }
          if (parsedAction === 'import') {
            this.pendingDocAction = 'import'
            this.pendingImportTarget = {
              connectionId: targetConnId,
              schema: targetSchema,
              table: targetTable || undefined,
            }
            if (this.hasLoadedActiveConnection) {
              this.consumePendingImportAction()
            }
          }
        }
      }
      return
    }
    this.applyDocumentMetadata(docText, {
      skipOneShotNav: Boolean(parsedNavToken),
    })
  }

  public attachDocumentSession(session: DocumentSessionLike): void {
    this.replaceSub?.dispose()
    this.replaceSub = null
    this.documentSession = session
    if (typeof session.value === 'string' && session.value.length > 0) {
      const docText = session.value
      const parsed = parseDatanoaDocument(docText)
      const parsedNavToken = extractDatanoaDocumentNavToken(docText)
      const isManaged = this.isManagedStudioDocument(parsed.metadataLines.length > 0)

      if (!parsedNavToken && !isManaged) {
        this.applyDocumentMetadata(docText)
      } else if (!parsedNavToken) {
        if (this.hasRestoredBootState || this.hasRestoredLocalViewState) {
          this.resolveInitialDocDecision(docText, null, !this.hasPersistedSessionTarget())
        } else {
          this.pendingInitialDocDecision = {
            docText,
            navToken: null,
            claimedPromise: Promise.resolve(false),
          }
        }
      } else if (typeof window === 'undefined' || !window.orca?.plugin?.request) {
        const alreadyConsumed =
          this.consumedNavTokens.has(parsedNavToken) || hasStoredConsumedNavToken(parsedNavToken)
        if (!alreadyConsumed) {
          markStoredConsumedNavToken(this.consumedNavTokens, parsedNavToken)
          this.resolveInitialDocDecision(docText, parsedNavToken, true)
        } else {
          this.resolveInitialDocDecision(docText, parsedNavToken, false)
        }
      } else {
        const syncConsumed =
          this.consumedNavTokens.has(parsedNavToken) || hasStoredConsumedNavToken(parsedNavToken)
        const claimedPromise = syncConsumed ? Promise.resolve(false) : this.claimNavToken(parsedNavToken)
        const decision = { docText, navToken: parsedNavToken, claimedPromise }
        this.pendingInitialDocDecision = decision
        void claimedPromise.then((claimed) => {
          if (this.isDestroyed) return
          if (
            this.pendingInitialDocDecision === decision &&
            (this.hasRestoredBootState || this.hasRestoredLocalViewState)
          ) {
            this.pendingInitialDocDecision = null
            this.resolveInitialDocDecision(decision.docText, decision.navToken, claimed)
          }
        })
      }
    }
    if (typeof session.onReplace === 'function') {
      const sub = session.onReplace((next) => {
        if (typeof next === 'string') {
          this.applyDocumentMetadata(next, { resetCautionDismissal: true })
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

    if (typeof document !== 'undefined') {
      track(bindStudioSelectTooltipsInRoot(document))
    }

    if (this.gridAreaEl && typeof this.gridAreaEl.addEventListener === 'function') {
      const gridArea = this.gridAreaEl
      const onGridAreaScroll = (e: Event) => {
        const tgt = e.target
        if (tgt instanceof Element && tgt.classList.contains('datanoa-grid-container')) {
          this.saveStudioViewState(false)
        }
      }
      gridArea.addEventListener('scroll', onGridAreaScroll, { passive: true, capture: true })
      track({
        dispose: () => {
          gridArea.removeEventListener('scroll', onGridAreaScroll, true)
        },
      })
    }

    if (this.sidebarListEl && typeof this.sidebarListEl.addEventListener === 'function') {
      const sidebarList = this.sidebarListEl
      const onSidebarScroll = () => {
        this.closeSidebarContextMenu()
        this.closeTopbarPopover()
        this.saveStudioViewState(false)
      }
      sidebarList.addEventListener('scroll', onSidebarScroll, { passive: true })
      track({
        dispose: () => {
          sidebarList.removeEventListener('scroll', onSidebarScroll)
        },
      })
    }

    if (typeof window !== 'undefined') {
      const onBeforeUnload = (): void => {
        this.erDiagramView?.flushPendingLayoutSave(true)
        this.flushStudioViewState()
        this.saveStudioDataCache()
        this.txToolbar.rollbackOnUnload()
      }
      window.addEventListener('beforeunload', onBeforeUnload)
      track({
        dispose: () => {
          window.removeEventListener('beforeunload', onBeforeUnload)
        },
      })

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
          if (isStudioCollapsibleDropdownOpen()) {
            e.preventDefault()
            e.stopPropagation()
            closeActiveStudioCollapsibleDropdown()
            return
          }
          if (
            this.sqlConsole?.isVimTargetEvent(e.target) ||
            (typeof document !== 'undefined' &&
              this.sqlConsole?.isVimTargetEvent(document.activeElement))
          ) {
            return
          }
          this.closeSidebarContextMenu()
          this.closeTopbarPopover()
          this.closeColumnsPopover()
          return
        }
        if (e.defaultPrevented) return
        const hasOpenModal = Boolean(
          this.activeModalBackdrop || this.schemaInspector?.isConfirmModalOpen()
        )
        if (matchesKeyboardShortcut(e, this.currentKeymapSettings.shortcutFormatSql)) {
          if (hasOpenModal || isEditableShortcutTarget(e.target)) return
          e.preventDefault()
          this.formatSqlInConsole()
          return
        }
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
            if (this.clientSearchEl && isGridVisibleMode(this.activeViewMode)) {
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
            if (hasOpenModal || isEditableShortcutTarget(e.target)) return
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
              (!this.isShowingSqlResult || this.editableSqlTarget !== null) &&
              this.currentCanEdit
            ) {
              e.preventDefault()
              void this.submitStagedChanges()
            }
          }
        }
      }
      let windowResizeRafId: number | null = null
      let windowResizeRafPending = false
      const applyWindowResize = () => {
        windowResizeRafPending = false
        windowResizeRafId = null
        if (this.isDestroyed) return
        this.applyClampedSplitPaneHeight()
        if (isGridVisibleMode(this.activeViewMode)) {
          this.dataGrid?.handleViewportResize()
        }
      }
      const onWindowResize = () => {
        closeActiveStudioCollapsibleDropdown()
        this.closeTopbarPopover()
        this.closeColumnsPopover()
        if (typeof requestAnimationFrame === 'function') {
          if (!windowResizeRafPending) {
            windowResizeRafPending = true
            const id = requestAnimationFrame(applyWindowResize)
            windowResizeRafId = windowResizeRafPending ? id : null
          }
        } else {
          applyWindowResize()
        }
      }
      const onWindowPageHide = () => {
        this.saveStudioDataCache()
        this.destroy()
      }
      let lastVisibilityRefreshAt = 0
      const refreshOnFocusOrVisible = () => {
        if (this.isDestroyed) return
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
          this.erDiagramView?.flushPendingLayoutSave(true)
          this.flushStudioViewState()
          this.saveStudioDataCache()
          return
        }
        const now = Date.now()
        if (now - lastVisibilityRefreshAt < 150) return
        lastVisibilityRefreshAt = now
        void this.refreshConnections()
      }
      window.addEventListener('mousedown', onWindowMouseDown)
      window.addEventListener('keydown', onWindowKeyDown)
      window.addEventListener('resize', onWindowResize)
      window.addEventListener('focus', refreshOnFocusOrVisible)
      window.addEventListener('pagehide', onWindowPageHide)
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', refreshOnFocusOrVisible)
      }
      track({
        dispose: () => {
          if (windowResizeRafId !== null && typeof cancelAnimationFrame === 'function') {
            cancelAnimationFrame(windowResizeRafId)
            windowResizeRafId = null
          }
          window.removeEventListener('mousedown', onWindowMouseDown)
          window.removeEventListener('keydown', onWindowKeyDown)
          window.removeEventListener('resize', onWindowResize)
          window.removeEventListener('focus', refreshOnFocusOrVisible)
          window.removeEventListener('pagehide', onWindowPageHide)
          if (typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', refreshOnFocusOrVisible)
          }
        },
      })
    }

    if (typeof window === 'undefined' || !window.orca) return

    try {
      track(
        window.orca.on('theme', (payload) => {
          document.documentElement.removeAttribute('data-theme-override')
          if (payload && (payload.colorScheme === 'light' || payload.colorScheme === 'dark')) {
            const isLight = payload.colorScheme === 'light'
            const isDark = payload.colorScheme === 'dark'
            document.documentElement.classList.toggle('light', isLight)
            document.documentElement.classList.toggle('dark', isDark)
            document.body?.classList.toggle('light', isLight)
            document.body?.classList.toggle('dark', isDark)
            this.sqlConsole?.setColorScheme(isLight)
          } else {
            const isLight = detectInitialThemeFromHost({ forceTokenProbe: true })
            if (isLight !== null) {
              this.sqlConsole?.setColorScheme(isLight)
            }
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
      if (window.orca.host?.has?.('workspace.readContext')) {
        const wsPromise = window.orca.host
          .call('workspace.readContext')
          .then((result) => {
            if (this.isDestroyed) return
            const scope = typeof result?.workspaceId === 'string' ? result.workspaceId.trim() : ''
            this.currentWorkspaceScope = scope
            const rawRoot = (result as { workspaceRoot?: unknown } | null | undefined)?.workspaceRoot
            if (typeof rawRoot === 'string' && rawRoot.trim()) {
              this.currentWorkspaceRoot = rawRoot.trim().replace(/\\/g, '/').replace(/\/+$/, '')
            }
            if (this.connections.length > 0 && this.hasRestoredBootState) {
              this.updateConnectionSelector()
            }
          })
          .catch(() => {})
          .finally(() => {
            if (this.workspaceContextPromise === wsPromise) {
              this.workspaceContextPromise = null
            }
          })
        this.workspaceContextPromise = wsPromise
      }
    } catch {
      // Optional workspace context
    }

    try {
      if (window.orca.host?.has?.('editor.readTypography')) {
        void window.orca.host
          .call('editor.readTypography')
          .then((typography) => {
            if (this.isDestroyed) return
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
          if (this.pendingReorderCount > 0 || this.expectedSelfChangedEvents > 0) {
            if (this.expectedSelfChangedEvents > 0) {
              this.expectedSelfChangedEvents--
              this.consumedSelfChangedEvents++
            } else {
              this.refreshConnectionsAfterReorder = true
            }
            return
          }
          void this.refreshConnections()
        })
      )
      if (typeof window.orca.storage?.onDidChange === 'function') {
        track(
          window.orca.storage.onDidChange((change) => {
            if (
              change?.key === SAVED_CONNECTIONS_STORAGE_KEY ||
              change?.key === SAVED_FOLDER_ORDER_STORAGE_KEY ||
              change?.key === 'connections'
            ) {
              if (this.pendingReorderCount > 0) {
                this.refreshConnectionsAfterReorder = true
                return
              }
              void this.refreshConnections()
            }
          })
        )
      }
      track(
        window.orca.plugin.on('studio.opened', (payload) => {
          const p =
            payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null
          const handleOpenedEvent = async (): Promise<void> => {
            if (this.isDestroyed) return
            const openedWorkspaceId =
              p && typeof p.workspaceId === 'string' && p.workspaceId.trim()
                ? p.workspaceId.trim()
                : ''
            const openedDocPath = this.normalizeStudioDocPath(p?.docPath)
            if (
              openedWorkspaceId &&
              !this.getLocalWorkspaceIdSync() &&
              this.workspaceContextPromise
            ) {
              await this.workspaceContextPromise
              if (this.isDestroyed) return
            }
            if (!this.isStudioOpenedForCurrentContext(openedWorkspaceId, openedDocPath)) {
              return
            }

            const openedConnId =
              p && typeof p.connectionId === 'string' && p.connectionId ? p.connectionId : null
            const openedTable = p && typeof p.table === 'string' && p.table ? p.table : undefined
            const openedSchema = p && typeof p.schema === 'string' && p.schema ? p.schema : undefined
            const openedViewMode = p ? p.viewMode : undefined
            const openedAction =
              p && (p.action === 'import' || p.openImport === true) ? 'import' : null
            const openedNavToken =
              p && typeof p.navToken === 'string' && p.navToken.trim() ? p.navToken.trim() : null
            if (openedNavToken) {
              const claimed = await this.claimNavToken(openedNavToken)
              if (this.isDestroyed || !claimed) return
              this.hasUserInteraction = true
            }
            const isSameActiveConn = !openedConnId || openedConnId === this.activeConnectionId
            if (isSameActiveConn) {
              this.dismissedCautionKey = null
              this.applyActiveConnectionPresentation(this.getActiveConnection())
            } else if (openedConnId) {
              this.pendingDocConnectionId = openedConnId
              this.pendingDocSchema = openedSchema
              this.pendingDocTable = openedTable || null
              if (openedSchema) {
                this.selectedSchema = openedSchema
                this.activeSchema = openedSchema
                this.recordSelectedSchema(openedConnId, openedSchema, true)
              }
            }
            if (isSameActiveConn) {
              if (this.hasLoadedActiveConnection && this.activeConnectionId) {
                if (openedSchema || openedTable) {
                  this.applySameConnectionNavigation(
                    this.activeConnectionId,
                    openedSchema,
                    openedTable
                  )
                }
              } else {
                if (openedSchema) {
                  this.selectedSchema = openedSchema
                  this.activeSchema = openedSchema
                  this.pendingDocSchema = openedSchema
                  if (openedConnId || this.activeConnectionId) {
                    this.recordSelectedSchema(
                      openedConnId || this.activeConnectionId || '',
                      openedSchema,
                      true
                    )
                  }
                }
                if (openedTable) {
                  this.activeTable = openedTable
                  this.pendingDocTable = openedTable
                }
              }
            } else if (openedTable) {
              this.pendingDocTable = openedTable
            }
            const applyOpenedOneShot = () => {
              if (this.isDestroyed) return
              if (isValidStudioViewMode(openedViewMode)) {
                this.lastErLoadedKey = ''
                this.switchMode(openedViewMode, { persistViewState: false })
              }
              if (openedAction === 'import') {
                this.pendingDocAction = 'import'
                this.pendingImportTarget = {
                  connectionId: openedConnId,
                  schema: openedSchema,
                  table: openedTable,
                }
                if (isSameActiveConn && this.hasLoadedActiveConnection) {
                  this.consumePendingImportAction()
                } else if (
                  openedConnId &&
                  !isSameActiveConn &&
                  this.connections.some((c) => c.id === openedConnId)
                ) {
                  this.handleConnectionChanged(openedConnId, true)
                }
              }
            }
            applyOpenedOneShot()
            void this.refreshConnections()
          }
          void handleOpenedEvent()
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
      track(
        window.orca.plugin.on('ai.status.changed', (snapshot) => {
          this.applyAiStatus(snapshot)
        })
      )
      track(
        window.orca.plugin.on('ui.tableDisplayState.changed', (payload) => {
          if (this.isDestroyed || !payload || typeof payload !== 'object') {
            return
          }
          const bulkReset = Boolean((payload as { bulkReset?: unknown }).bulkReset)
          if (bulkReset) {
            const p = payload as {
              all?: boolean
              connectionId?: string
              tableKeys?: string[]
              revision?: number
              revisions?: Record<string, number>
            }
            const curKey = this.getCurrentTableConfigKey()
            const resolveBulkRev = (key: string): number => {
              if (p.revisions && typeof p.revisions === 'object') {
                if (typeof p.revisions[key] === 'number' && Number.isFinite(p.revisions[key])) {
                  return p.revisions[key]
                }
                for (const [rk, rv] of Object.entries(p.revisions)) {
                  if (
                    normalizeStudioTableKey(rk) === key &&
                    typeof rv === 'number' &&
                    Number.isFinite(rv)
                  ) {
                    return rv
                  }
                }
              }
              return typeof p.revision === 'number' && Number.isFinite(p.revision) ? p.revision : 0
            }
            const prevCurRev = curKey ? this.getTableDisplayRevision(curKey) : 0
            let cacheCleared = false
            for (const [qKey, queue] of Array.from(this.tableDisplayPatchQueues.entries())) {
              const matchesQueue =
                Boolean(p.all) ||
                (typeof p.connectionId === 'string' &&
                  studioTableKeyMatchesConnection(qKey, p.connectionId)) ||
                (Array.isArray(p.tableKeys) &&
                  p.tableKeys.some((k) => typeof k === 'string' && normalizeStudioTableKey(k) === qKey))
              if (matchesQueue) {
                const rev = resolveBulkRev(qKey)
                const prevRev = qKey === curKey ? prevCurRev : this.getTableDisplayRevision(qKey)
                if (rev > 0 && rev <= prevRev) continue
                queue.dirty = false
                queue.overwrittenByRemoteWhileInFlight = false
                this.clearPendingRemoteRebase(queue)
                queue.latestLocalEntry = null
                queue.recentSelfRevisions.clear()
                if (rev > 0) {
                  this.setTableDisplayRevision(qKey, rev)
                }
                if (this.clearStudioColumnConfigCache(qKey)) {
                  cacheCleared = true
                }
              }
            }
            for (const cfgKey of Object.keys(this.columnConfigByTable)) {
              const normCfgKey = normalizeStudioTableKey(cfgKey)
              const matchesCfg =
                Boolean(p.all) ||
                (typeof p.connectionId === 'string' &&
                  studioTableKeyMatchesConnection(normCfgKey, p.connectionId)) ||
                (Array.isArray(p.tableKeys) &&
                  p.tableKeys.some(
                    (k) => typeof k === 'string' && normalizeStudioTableKey(k) === normCfgKey
                  ))
              if (!matchesCfg) continue
              const rev = resolveBulkRev(normCfgKey)
              const prevRev = normCfgKey === curKey ? prevCurRev : this.getTableDisplayRevision(normCfgKey)
              if (rev > 0 && rev <= prevRev) continue
              delete this.columnConfigByTable[cfgKey]
              cacheCleared = true
            }
            const matchesCurrent =
              Boolean(p.all) ||
              (typeof p.connectionId === 'string' && p.connectionId === this.activeConnectionId) ||
              (Array.isArray(p.tableKeys) &&
                p.tableKeys.some((k) => typeof k === 'string' && normalizeStudioTableKey(k) === curKey))
            if (matchesCurrent) {
              const curRev = resolveBulkRev(curKey)
              if (!(curRev > 0 && curRev <= prevCurRev)) {
                this.tableDisplayReqGen += 1
                if (curRev > 0) {
                  this.setTableDisplayRevision(curKey, curRev)
                }
                if (this.clearStudioColumnConfigCache(curKey)) {
                  cacheCleared = true
                }
                if (!this.isShowingSqlResult) {
                  this.dataGrid?.applyTableDisplayState(null)
                  this.colsPopoverSync?.()
                }
              }
            }
            if (cacheCleared) {
              this.saveStudioViewState(false)
            }
            return
          }
          const tableKey = (payload as { tableKey?: unknown }).tableKey
          const revision = (payload as { revision?: unknown }).revision
          const entry = (payload as { entry?: TableDisplayStateEntry | null }).entry ?? null
          if (typeof tableKey !== 'string') return
          const normKey = normalizeStudioTableKey(tableKey)
          const curKey = this.getCurrentTableConfigKey()
          const nextRev = typeof revision === 'number' && Number.isFinite(revision) ? revision : 0
          const queue = this.getTableDisplayPatchQueue(normKey)
          const knownRev = this.getTableDisplayRevision(normKey)
          if (nextRev > 0 && nextRev <= knownRev) {
            return
          }
          if (nextRev > 0 && queue.recentSelfRevisions.has(nextRev)) {
            this.setTableDisplayRevision(normKey, Math.max(knownRev, nextRev))
            return
          }
          if (normKey !== curKey) {
            if (!normalizeTableDisplayStateEntry(entry) && !queue.inFlight && !queue.dirty) {
              if (nextRev > 0) {
                this.setTableDisplayRevision(normKey, nextRev)
              }
              if (this.clearStudioColumnConfigCache(normKey)) {
                this.saveStudioViewState(false)
              }
            }
            return
          }
          if (queue.inFlight) {
            if (areTableDisplayStateEntriesEquivalent(entry, queue.inFlightSentNormalized)) {
              if (nextRev > 0) {
                this.recordSelfTableDisplayRevision(queue, nextRev)
                this.setTableDisplayRevision(normKey, Math.max(knownRev, nextRev))
              }
              return
            }
            if (queue.dirty) {
              if (nextRev > 0) {
                this.setTableDisplayRevision(normKey, Math.max(knownRev, nextRev))
              }
              this.setPendingRemoteRebase(queue, entry, nextRev)
              return
            }
          }
          this.tableDisplayReqGen += 1
          if (queue.inFlight) {
            queue.overwrittenByRemoteWhileInFlight = true
          }
          if (nextRev > 0) {
            this.setTableDisplayRevision(normKey, nextRev)
          }
          if (!normalizeTableDisplayStateEntry(entry) && this.clearStudioColumnConfigCache(normKey)) {
            this.saveStudioViewState(false)
          }
          if (!this.isShowingSqlResult) {
            this.dataGrid?.applyTableDisplayState(entry)
            this.colsPopoverSync?.()
          }
        })
      )
      track(
        window.orca.plugin.on('ssh.hostKeyChallenge', (challenge) => {
          if (this.isDestroyed || !challenge || typeof challenge !== 'object') return
          void openSharedSshHostKeyModal({
            challenge,
            panelId: 'studio',
            connectionId: challenge.connectionId,
            resolveDecision: async (input) => {
              const res = await this.requestPlugin<{
                ok: boolean
                decision: SshHostKeyDecision
                savedPath?: string
                retryToken?: string
              }>('ssh.hostKey.resolve', input)
              return {
                ok: Boolean(res?.ok),
                decision: res?.decision ?? input.decision,
                savedPath: res?.savedPath,
                ...(typeof res?.retryToken === 'string' && res.retryToken
                  ? { retryToken: res.retryToken }
                  : {}),
              }
            },
          })
        })
      )
      track(
        window.orca.plugin.on('ssh.hostKeyResolved', (ev) => {
          if (!ev || typeof ev !== 'object' || typeof ev.challengeId !== 'string') return
          closeByChallengeId(ev.challengeId, ev.decision)
        })
      )
      if (typeof window.orca.settings?.onDidChange === 'function') {
        track(
          window.orca.settings.onDidChange((change) => {
            const k = typeof change?.key === 'string' ? change.key : ''
            if (k.startsWith('ai')) {
              void this.hydrateAiStatus()
            }
            if (
              !k ||
              k === 'all' ||
              k === 'editorKeymap' ||
              k === 'shortcutRunStatement' ||
              k === 'shortcutRunAll' ||
              k === 'shortcutFormatSql' ||
              k.startsWith('datanoa.editorKeymap') ||
              k.startsWith('datanoa.shortcut')
            ) {
              void this.hydrateEditorKeymapSettings()
            }
          })
        )
      }
    } catch {
      // Ignore if plugin event bus is mocked minimally
    }

    void this.hydrateAiStatus()
    void this.hydrateEditorKeymapSettings()
    void this.refreshConnections()
  }

  private updateVimModePill(snapshot: VimModeSnapshot): void {
    if (!this.vimModePillEl) return
    if (snapshot.preset !== 'vim') {
      this.vimModePillEl.style.display = 'none'
      this.vimModePillEl.textContent = ''
      delete this.vimModePillEl.dataset.vimMode
      return
    }
    this.vimModePillEl.style.display = 'inline-flex'
    this.vimModePillEl.textContent = snapshot.badge || snapshot.mode.toUpperCase()
    this.vimModePillEl.dataset.vimMode = snapshot.mode
  }

  private async hydrateEditorKeymapSettings(): Promise<void> {
    if (typeof window === 'undefined' || typeof window.orca?.settings?.get !== 'function') {
      return
    }
    try {
      const [editorKeymap, shortcutRunStatement, shortcutRunAll, shortcutFormatSql] =
        await Promise.all([
          window.orca.settings.get('editorKeymap'),
          window.orca.settings.get('shortcutRunStatement'),
          window.orca.settings.get('shortcutRunAll'),
          window.orca.settings.get('shortcutFormatSql'),
        ])
      if (this.isDestroyed) return
      const raw: Record<string, unknown> = {}
      if (typeof editorKeymap === 'string') raw.editorKeymap = editorKeymap
      if (typeof shortcutRunStatement === 'string') raw.shortcutRunStatement = shortcutRunStatement
      if (typeof shortcutRunAll === 'string') raw.shortcutRunAll = shortcutRunAll
      if (typeof shortcutFormatSql === 'string') raw.shortcutFormatSql = shortcutFormatSql
      this.currentKeymapSettings = normalizeShortcutSettings(raw)
      this.sqlConsole?.applyKeymapSettings(this.currentKeymapSettings)
      if (this.sqlConsole) {
        this.updateVimModePill(this.sqlConsole.getVimModeSnapshot())
      }
    } catch {
      // Ignore if host settings are unavailable
    }
  }

  private getActiveConnection(): ConnectionProfile | undefined {
    if (!this.activeConnectionId) return undefined
    return this.connections.find((c) => c.id === this.activeConnectionId)
  }

  private isActiveConnectionReadOnly(): boolean {
    return Boolean(this.getActiveConnection()?.readOnly)
  }

  private applyActiveConnectionPresentation(conn?: ConnectionProfile): void {
    const driver: DatabaseDriverType = isKnownConnectionDriver(conn?.driver)
      ? conn.driver
      : 'sqlite'

    if (this.connLogoEl) {
      this.connLogoEl.innerHTML = ''
      this.connLogoEl.appendChild(createDbLogoSvg(driver))
      this.connLogoEl.title = driver.toUpperCase()
    }

    if (this.envPillEl) {
      this.envPillEl.textContent = ''
      this.envPillEl.className = 'datanoa-env-pill'
      this.envPillEl.style.display = 'none'
      this.envPillEl.hidden = true
    }

    if (this.roBadgeEl) {
      this.roBadgeEl.style.display = 'none'
      this.roBadgeEl.hidden = true
    }

    if (this.editConnBtn) {
      this.editConnBtn.disabled = !conn
    }

    if (this.cautionStripEl) {
      let cautionKind: 'prod-ro' | 'prod' | 'ro' | null = null
      let cautionClass = 'datanoa-caution-strip'
      let cautionText = ''
      if (conn?.readOnly && conn?.colorTag === 'prod') {
        cautionKind = 'prod-ro'
        cautionClass = 'datanoa-caution-strip prod'
        cautionText = 'PRODUCTION (Read-Only) — Mutations and write SQL statements are locked.'
      } else if (conn?.colorTag === 'prod') {
        cautionKind = 'prod'
        cautionClass = 'datanoa-caution-strip prod'
        cautionText =
          'PRODUCTION environment — Double-check WHERE clauses and DML changes before submitting.'
      } else if (conn?.readOnly) {
        cautionKind = 'ro'
        cautionClass = 'datanoa-caution-strip'
        cautionText =
          'Read-Only connection — Inline edits, staged DML, and write statements are disabled.'
      }

      const cautionKey = conn && cautionKind ? `${conn.id}:${cautionKind}` : null
      this.activeCautionKey = cautionKey

      if (!cautionKey) {
        this.cautionStripEl.style.display = 'none'
      } else {
        this.cautionStripEl.className = cautionClass
        if (this.cautionStripTextEl) {
          this.cautionStripTextEl.textContent = cautionText
        }
        this.cautionStripEl.style.display =
          this.dismissedCautionKey === cautionKey ? 'none' : 'flex'
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
    this.updateSchemaSwitcherDisplay()
    this.updateExportDdlBtnState()
    if (this.dataGrid) {
      this.dataGrid.setContextMeta(
        this.activeTable || 'table_name',
        driver,
        this.activeConnectionId || '',
        this.activeSchema || ''
      )
    }
    this.updateStagedActionButtons(this.dataGrid?.getStagedCount?.() ?? 0)
  }

  private isActiveObjectTable(): boolean {
    if (!this.activeTable) return false
    const match = this.schemaObjects.find(
      (obj) =>
        obj.name === this.activeTable &&
        (!this.activeSchema || !obj.schema || obj.schema === this.activeSchema)
    )
    if (match) {
      return match.kind === 'table'
    }
    return true
  }

  private updateStagedActionButtons(stagedCount: number): void {
    const conn = this.getActiveConnection()
    const isReadOnly = this.isActiveConnectionReadOnly()
    const canEdit =
      this.currentCanEdit &&
      !isReadOnly &&
      !this.isSubmittingChanges &&
      (!this.isShowingSqlResult || this.editableSqlTarget !== null)
    const canImport = Boolean(
      !this.isShowingSqlResult &&
        this.activeConnectionId &&
        this.isActiveObjectTable() &&
        conn &&
        !isReadOnly &&
        conn.driver !== 'redis' &&
        !this.isSubmittingChanges
    )
    if (this.addRowBtn) this.addRowBtn.disabled = !canEdit
    if (this.cloneRowBtn) this.cloneRowBtn.disabled = !canEdit
    if (this.delRowBtn) this.delRowBtn.disabled = !canEdit
    if (this.importDataBtn) this.importDataBtn.disabled = !canImport
    if (this.editTableBtn) {
      const canEditTableStruct = Boolean(
        !this.isShowingSqlResult &&
          this.activeConnectionId &&
          this.activeTable &&
          this.isActiveObjectTable() &&
          conn &&
          conn.driver !== 'redis'
      )
      this.editTableBtn.disabled = !canEditTableStruct
      this.editTableBtn.title =
        !this.isActiveObjectTable() && this.activeTable
          ? 'Views are read-only — inspect DDL in Schema Inspector'
          : 'Open Schema Inspector & Edit Table Structure (ALTER TABLE)'
    }
    if (this.submitBtn && !this.isSubmittingChanges) {
      this.submitBtn.textContent = `Submit [${stagedCount}]`
      this.submitBtn.disabled = stagedCount === 0 || !canEdit
      this.submitBtn.classList.toggle('has-staged', stagedCount > 0 && canEdit)
    }
    if (this.dmlApplyBtn && !this.isSubmittingChanges) {
      this.dmlApplyBtn.disabled = stagedCount === 0 || !canEdit
    }
    if (this.revertBtn) this.revertBtn.disabled = stagedCount === 0 || this.isSubmittingChanges
    if (this.dmlPreviewBtn && !this.isPreviewingDml) {
      this.dmlPreviewBtn.disabled = stagedCount === 0 || !canEdit
      this.dmlPreviewBtn.classList.toggle('active', stagedCount > 0 && canEdit)
    }
    if (
      this.statusMetricsEl &&
      ((this.isShowingSqlResult && this.editableSqlTarget) ||
        (!this.isShowingSqlResult && this.activeTable))
    ) {
      this.statusMetricsEl.textContent = formatGridStatusMetrics(
        this.totalRows,
        this.currentColCount,
        { stagedCount, truncated: this.currentMetricsTruncated }
      )
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
      await this.refreshConnections()
      if (this.activeConnectionId) {
        this.restoredPageOnBoot = this.currentPage
        await this.introspectSchema(this.activeConnectionId, true)
      }
    } finally {
      this.isRefreshingSchema = false
      setButtonLoading(this.refreshBtn, false)
    }
  }

  public async refreshConnections(options?: { bypassReorderGuard?: boolean }): Promise<void> {
    if (this.isDestroyed || typeof window === 'undefined' || !window.orca?.plugin?.request) return
    const seq = ++this.connectionsSeq
    const needsBootSnap = !this.hasRestoredBootState
    try {
      const [conns, folderOrderRes, workerSnap] = await Promise.all([
        this.requestPlugin<ConnectionProfile[]>('connections.list'),
        this.requestPlugin<{ folderOrder?: string[] }>('folders.order.get').catch(() => null),
        needsBootSnap
          ? this.requestPlugin<{
              viewState?: StudioPersistedViewState | null
              dataCache?: StudioWarmCacheSnapshot | null
              updatedAt?: number
            }>('ui.getSessionSnapshot', { surface: 'studio' }).catch(() => null)
          : Promise.resolve(null),
      ])
      if (seq !== this.connectionsSeq || this.isDestroyed) return
      if (!options?.bypassReorderGuard && this.pendingReorderCount > 0) {
        this.refreshConnectionsAfterReorder = true
        return
      }
      const prevConnectionsSig = JSON.stringify(this.connections)
      this.connections = conns || []
      const connsChanged = prevConnectionsSig !== JSON.stringify(this.connections)
      const prevFolderOrderSig = JSON.stringify(this.folderOrder)
      if (folderOrderRes && Array.isArray(folderOrderRes.folderOrder)) {
        this.folderOrder = normalizeFolderOrder(folderOrderRes.folderOrder)
      }
      const folderOrderChanged = prevFolderOrderSig !== JSON.stringify(this.folderOrder)
      if (needsBootSnap) {
        this.hasRestoredBootState = true
        const hasLocalState = Boolean(this.readLocalStudioViewState())
        let restoredFromWorker = false
        if (workerSnap?.dataCache && typeof workerSnap.dataCache === 'object') {
          const workerUpdatedAt =
            (typeof workerSnap.dataCache.updatedAt === 'number' && workerSnap.dataCache.updatedAt) ||
            (typeof workerSnap.updatedAt === 'number' && workerSnap.updatedAt) ||
            0
          if (!this.hasWarmBootHydrated || workerUpdatedAt > this.warmBootUpdatedAt) {
            this.pendingBootDataCache = {
              ...workerSnap.dataCache,
              updatedAt: workerUpdatedAt,
            }
          }
        }
        if (
          workerSnap?.viewState &&
          typeof workerSnap.viewState === 'object'
        ) {
          const workerViewUpdatedAt =
            typeof workerSnap.viewState.updatedAt === 'number' &&
            Number.isFinite(workerSnap.viewState.updatedAt)
              ? workerSnap.viewState.updatedAt
              : typeof workerSnap.updatedAt === 'number' && Number.isFinite(workerSnap.updatedAt)
                ? workerSnap.updatedAt
                : 0
          if (
            !hasLocalState ||
            (workerViewUpdatedAt > this.restoredViewStateUpdatedAt && !this.hasUserInteraction)
          ) {
            this.applyRestoredStudioViewState(workerSnap.viewState, {
              forceOverwritePending: true,
            })
            restoredFromWorker = true
          } else if (!this.hasUserInteraction) {
            this.reconcileSelectedSchemasFromSnapshot(workerSnap.viewState, false)
          }
        }
        if (!hasLocalState && !restoredFromWorker && typeof window.orca?.storage?.get === 'function') {
          try {
            const hostSaved = (await window.orca.storage.get(
              STUDIO_VIEW_STATE_STORAGE_KEY
            )) as StudioPersistedViewState | null
            if (seq !== this.connectionsSeq || this.isDestroyed) return
            if (hostSaved && typeof hostSaved === 'object') {
              this.applyRestoredStudioViewState(hostSaved, {
                forceOverwritePending: true,
              })
            }
          } catch {
            // Ignore host view state read errors
          }
        }
      }
      if (this.pendingInitialDocDecision) {
        const decision = this.pendingInitialDocDecision
        this.pendingInitialDocDecision = null
        const claimed = await decision.claimedPromise
        if (seq !== this.connectionsSeq || this.isDestroyed) return
        this.resolveInitialDocDecision(decision.docText, decision.navToken, claimed)
      }
      if (typeof window.orca?.storage?.get === 'function') {
        if (
          !this.pendingDocConnectionId &&
          !this.activeConnectionId &&
          !this.storedActiveConnectionId
        ) {
          try {
            const stored = await window.orca.storage.get(ACTIVE_CONNECTION_STORAGE_KEY)
            if (seq !== this.connectionsSeq || this.isDestroyed) return
            if (typeof stored === 'string' && stored.trim().length > 0) {
              this.storedActiveConnectionId = stored.trim()
            }
          } catch {
            // Ignore storage read errors in minimal test environments
          }
        }
      }
      if (seq !== this.connectionsSeq || this.isDestroyed) return
      this.updateConnectionSelector()
      if (this.activeConnectionId && this.hasLoadedActiveConnection) {
        if (
          this.activeViewMode === 'inspector' &&
          this.activeTable &&
          !this.lastInspectorLoadedKey
        ) {
          void this.loadActiveTableSchema()
        }
        if (Object.keys(this.schemaMap).length === 0 && this.schemaObjects.length > 0) {
          const seededMap: Record<string, string[]> = {}
          for (const obj of this.schemaObjects) {
            seededMap[obj.name] = []
          }
          this.schemaMap = seededMap
          this.sqlConsole?.updateSchema(this.schemaMap, this.activeTable || undefined)
        }
        this.saveStudioDataCache()
      } else if (connsChanged || folderOrderChanged) {
        this.saveStudioDataCache()
      }
    } catch {
      if (needsBootSnap && !this.isDestroyed) {
        this.hasRestoredBootState = true
        if (this.pendingInitialDocDecision) {
          const decision = this.pendingInitialDocDecision
          this.pendingInitialDocDecision = null
          try {
            const claimed = await decision.claimedPromise
            if (!this.isDestroyed) {
              this.resolveInitialDocDecision(decision.docText, decision.navToken, claimed)
            }
          } catch {
            // Ignore doc decision errors
          }
        }
      }
      // Non-blocking in testing / offline environments
    }
  }

  private populateConnectionSelectDom(targetId: string | null): void {
    const connSel = this.connSelectEl
    if (!connSel) return

    connSel.innerHTML = ''
    const defaultOpt = document.createElement('option')
    defaultOpt.value = ''
    defaultOpt.textContent = 'Select Connection...'
    connSel.appendChild(defaultOpt)

    const scope = this.currentWorkspaceScope.trim()
    const buildOption = (conn: ConnectionProfile): HTMLOptionElement => {
      const opt = document.createElement('option')
      opt.value = conn.id
      const hasEnvTag = Boolean(conn.colorTag && conn.colorTag !== 'none')
      const envUpper = hasEnvTag && conn.colorTag ? conn.colorTag.toUpperCase() : ''
      const envSuffix = envUpper ? ` [${envUpper}]` : ''
      const roSuffix = conn.readOnly ? ' [RO]' : ''
      const sshSuffix = conn.sshEnabled ? ' [SSH]' : ''
      const folderTrimmed = (conn.folder || '').trim()
      const connScope = (conn.workspaceScope || '').trim()
      const isCurrentScope = Boolean(connScope && scope && connScope === scope)
      const tlsLabel =
        conn.sslCertPath || conn.sslKeyPath
          ? 'mTLS'
          : conn.sslCaPath ||
              (conn.sslMode && conn.sslMode !== 'auto' && conn.sslMode !== 'disable') ||
              (conn.ssl && conn.sslMode !== 'disable')
            ? 'TLS'
            : ''
      const mtlsSuffix = tlsLabel ? ` [${tlsLabel}]` : ''
      const badges: CollapsibleSelectBadge[] = []
      if (conn.driver) {
        badges.push({ text: String(conn.driver).toUpperCase(), tone: 'neutral' })
      }
      if (tlsLabel) {
        badges.push({ text: tlsLabel, tone: 'info' })
      }
      if (conn.sshEnabled) {
        badges.push({ text: 'SSH', tone: 'neutral' })
      }
      if (conn.readOnly) {
        badges.push({ text: 'RO', tone: 'warn' })
      }
      if (conn.colorTag === 'dev' || conn.colorTag === 'staging' || conn.colorTag === 'prod') {
        badges.push({ text: conn.colorTag.toUpperCase(), tone: conn.colorTag })
      }
      opt.textContent = `${conn.name} (${conn.driver})${envSuffix}${roSuffix}${sshSuffix}${mtlsSuffix}`
      if (opt.dataset) {
        opt.dataset.driver = conn.driver
        opt.dataset.displayName = conn.name
        opt.dataset.badges = JSON.stringify(badges)
        if (isCurrentScope) opt.dataset.isCurrent = '1'
        const sub =
          conn.filePath ||
          (conn.host ? `${conn.host}:${conn.port || ''}/${conn.database || ''}` : conn.database || '')
        const engineMetaLabel = getStudioEngineMeta(conn.driver).label
        const searchTokens = [
          conn.name,
          conn.driver,
          engineMetaLabel,
          ...badges.map((b) => b.text),
          conn.readOnly ? 'readonly read-only' : '',
          folderTrimmed,
          isCurrentScope ? 'Current Workspace' : '',
          sub,
        ].filter((tok) => tok.length > 0)
        opt.dataset.searchText = searchTokens.join(' ')
        opt.dataset.fullTitle = `${opt.textContent}${folderTrimmed ? ` — Folder: ${folderTrimmed}` : ''}${isCurrentScope ? ' — Current Workspace' : ''}${sub ? ` — ${sub}` : ''}`
      }
      if (conn.id === (targetId || '')) opt.selected = true
      return opt
    }

    const { grouped, groups } = groupConnectionsForSelector(
      this.connections,
      this.currentWorkspaceScope,
      this.folderOrder
    )
    if (!grouped) {
      this.connections.forEach((conn) => connSel.appendChild(buildOption(conn)))
    } else {
      for (const grp of groups) {
        const group = document.createElement('optgroup')
        group.label = grp.label
        group.setAttribute('label', grp.label)
        const isUserFolder =
          grp.items.length > 0 &&
          grp.label.length > 0 &&
          grp.items.every((c) => normalizeConnectionFolderKey(c.folder) === grp.label)
        if (group.dataset) {
          if (isUserFolder) {
            group.dataset.folderKey = grp.label
            group.dataset.folderOrderKey = grp.label
            group.dataset.sectionKey = `folder:${grp.label}`
            group.dataset.reorderableFolder = '1'
            group.dataset.reorderableItems = '1'
          } else if (grp.label === 'General (Ungrouped)') {
            group.dataset.folderKey = ''
            group.dataset.folderOrderKey = UNGROUPED_FOLDER_ORDER_KEY
            group.dataset.sectionKey = `builtin:${UNGROUPED_FOLDER_ORDER_KEY}`
            group.dataset.reorderableFolder = '1'
            group.dataset.reorderableItems = '1'
          } else {
            group.dataset.folderKey = ''
            group.dataset.sectionKey = `builtin:${grp.label}`
            group.dataset.reorderableFolder = '0'
            group.dataset.reorderableItems = '0'
          }
        }
        grp.items.forEach((conn) => group.appendChild(buildOption(conn)))
        connSel.appendChild(group)
      }
    }

    connSel.value = targetId || ''
    enhanceStudioCollapsibleSelect(connSel, {
      tooltipPrefix: 'Active Database Connection',
      searchPlaceholder: 'Search connections or folders...',
      reorderConnections: true,
      reorderFolders: true,
      onReorderConnections: (folderKey, orderedIds) =>
        this.reorderStudioConnections(folderKey, orderedIds),
      onReorderFolders: (orderedFolders) => this.reorderStudioFolders(orderedFolders),
      onOpen: () => {
        void this.refreshConnections()
      },
    })
  }

  private reorderStudioConnections(
    folderKey: string,
    orderedIds: string[]
  ): Promise<{ ok: boolean; changed: boolean }> {
    if (this.isDestroyed) return Promise.resolve({ ok: false, changed: false })
    const plan = reorderConnectionsWithinFolder(this.connections, folderKey, orderedIds)
    if (!plan.ok || !plan.changed) {
      return Promise.resolve({ ok: plan.ok, changed: false })
    }

    const mySeq = ++this.reorderSeq
    const myConnSeq = ++this.connReorderSeq
    this.pendingReorderCount++
    const orderedSnapshot = orderedIds.slice()
    this.connections = plan.connections
    this.populateConnectionSelectDom(this.activeConnectionId)
    this.saveStudioDataCache()

    const runPersist = async (): Promise<{ ok: boolean; changed: boolean }> => {
      if (this.isDestroyed) {
        this.pendingReorderCount = Math.max(0, this.pendingReorderCount - 1)
        if (this.pendingReorderCount === 0) {
          this.expectedSelfChangedEvents = 0
          this.consumedSelfChangedEvents = 0
          this.refreshConnectionsAfterReorder = false
        }
        return { ok: false, changed: false }
      }
      const consumedBefore = this.consumedSelfChangedEvents
      this.expectedSelfChangedEvents++
      try {
        const res = await this.requestPlugin<{
          ok?: boolean
          changed?: boolean
          connections?: ConnectionProfile[]
        }>('connections.reorder', {
          folder: plan.folder,
          orderedIds: orderedSnapshot,
        })
        if (!res?.changed) {
          if (this.expectedSelfChangedEvents > 0) {
            this.expectedSelfChangedEvents--
          } else if (this.consumedSelfChangedEvents > consumedBefore) {
            this.refreshConnectionsAfterReorder = true
          }
        }
        if (myConnSeq === this.connReorderSeq && !this.isDestroyed && Array.isArray(res?.connections)) {
          const prevSig = JSON.stringify(this.connections)
          this.connections = res.connections
          if (prevSig !== JSON.stringify(this.connections)) {
            this.populateConnectionSelectDom(this.activeConnectionId)
            this.saveStudioDataCache()
          }
        }
        return { ok: true, changed: Boolean(res?.changed) }
      } catch (err) {
        if (this.expectedSelfChangedEvents > 0) {
          this.expectedSelfChangedEvents--
        } else if (this.consumedSelfChangedEvents > consumedBefore) {
          this.refreshConnectionsAfterReorder = true
        }
        const detail = err instanceof Error ? err.message : String(err)
        if (!this.isDestroyed) {
          this.showQueryBanner('error', 'Failed to reorder connections', detail)
        }
        if (mySeq === this.reorderSeq && !this.isDestroyed) {
          await this.refreshConnections({ bypassReorderGuard: true })
        } else if (!this.isDestroyed) {
          this.refreshConnectionsAfterReorder = true
        }
        return { ok: false, changed: false }
      } finally {
        this.pendingReorderCount = Math.max(0, this.pendingReorderCount - 1)
        if (this.pendingReorderCount === 0) {
          this.expectedSelfChangedEvents = 0
          this.consumedSelfChangedEvents = 0
          if (this.refreshConnectionsAfterReorder && !this.isDestroyed) {
            this.refreshConnectionsAfterReorder = false
            void this.refreshConnections()
          }
        }
      }
    }

    const task = this.reorderQueueChain.then(runPersist)
    this.reorderQueueChain = task.then(
      () => undefined,
      () => undefined
    )
    return task
  }

  private reorderStudioFolders(
    orderedFolders: string[]
  ): Promise<{ ok: boolean; changed: boolean }> {
    if (this.isDestroyed) return Promise.resolve({ ok: false, changed: false })
    const currentFolderNames = getConnectionFolderOrderKeys(this.connections)
    const plan = reconcileFolderOrder(this.folderOrder, orderedFolders, currentFolderNames)
    if (!plan.ok || !plan.changed) {
      return Promise.resolve({ ok: plan.ok, changed: false })
    }

    const mySeq = ++this.reorderSeq
    const myFolderSeq = ++this.folderReorderSeq
    this.pendingReorderCount++
    const orderedSnapshot = orderedFolders.slice()
    this.folderOrder = plan.folderOrder
    this.populateConnectionSelectDom(this.activeConnectionId)
    this.saveStudioDataCache()

    const runPersist = async (): Promise<{ ok: boolean; changed: boolean }> => {
      if (this.isDestroyed) {
        this.pendingReorderCount = Math.max(0, this.pendingReorderCount - 1)
        if (this.pendingReorderCount === 0) {
          this.expectedSelfChangedEvents = 0
          this.consumedSelfChangedEvents = 0
          this.refreshConnectionsAfterReorder = false
        }
        return { ok: false, changed: false }
      }
      const consumedBefore = this.consumedSelfChangedEvents
      this.expectedSelfChangedEvents++
      try {
        const res = await this.requestPlugin<{
          ok?: boolean
          changed?: boolean
          folderOrder?: string[]
        }>('folders.reorder', {
          orderedFolders: orderedSnapshot,
        })
        if (!res?.changed) {
          if (this.expectedSelfChangedEvents > 0) {
            this.expectedSelfChangedEvents--
          } else if (this.consumedSelfChangedEvents > consumedBefore) {
            this.refreshConnectionsAfterReorder = true
          }
        }
        if (myFolderSeq === this.folderReorderSeq && !this.isDestroyed && Array.isArray(res?.folderOrder)) {
          const nextOrder = normalizeFolderOrder(res.folderOrder)
          if (JSON.stringify(this.folderOrder) !== JSON.stringify(nextOrder)) {
            this.folderOrder = nextOrder
            this.populateConnectionSelectDom(this.activeConnectionId)
            this.saveStudioDataCache()
          }
        }
        return { ok: true, changed: Boolean(res?.changed) }
      } catch (err) {
        if (this.expectedSelfChangedEvents > 0) {
          this.expectedSelfChangedEvents--
        } else if (this.consumedSelfChangedEvents > consumedBefore) {
          this.refreshConnectionsAfterReorder = true
        }
        const detail = err instanceof Error ? err.message : String(err)
        if (!this.isDestroyed) {
          this.showQueryBanner('error', 'Failed to reorder folders', detail)
        }
        if (mySeq === this.reorderSeq && !this.isDestroyed) {
          await this.refreshConnections({ bypassReorderGuard: true })
        } else if (!this.isDestroyed) {
          this.refreshConnectionsAfterReorder = true
        }
        return { ok: false, changed: false }
      } finally {
        this.pendingReorderCount = Math.max(0, this.pendingReorderCount - 1)
        if (this.pendingReorderCount === 0) {
          this.expectedSelfChangedEvents = 0
          this.consumedSelfChangedEvents = 0
          if (this.refreshConnectionsAfterReorder && !this.isDestroyed) {
            this.refreshConnectionsAfterReorder = false
            void this.refreshConnections()
          }
        }
      }
    }

    const task = this.reorderQueueChain.then(runPersist)
    this.reorderQueueChain = task.then(
      () => undefined,
      () => undefined
    )
    return task
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

    this.populateConnectionSelectDom(targetId)
    syncStudioSelectTooltip(this.schemaSelectEl, 'Active Schema')
    syncStudioSelectTooltip(this.topbarSchemaSelectEl, 'Active Schema')
    syncStudioSelectTooltip(this.pageSizeSelectEl, 'Rows per page')
    syncStudioSelectTooltip(this.exportSelectEl, 'Export Format')
    const preservePending = Boolean(
      this.pendingDocConnectionId && targetId === this.pendingDocConnectionId
    )
    this.handleConnectionChanged(targetId, preservePending)
  }

  private handleConnectionChanged(
    connectionId: string | null,
    preservePendingTable = false
  ): void {
    const prevConnId = this.activeConnectionId
    const changed = connectionId !== this.activeConnectionId
    if (changed) {
      this.dismissedCautionKey = null
      this.closeActiveModal()
      this.txToolbar.resetForConnectionSwitch(prevConnId)
      this.sqlConsole?.clearAiGhost()
      this.sqlConsole?.clearDbSyntaxError?.()
      this.clearAiFixPanel()
      this.schemaError = null
    }
    this.activeConnectionId = connectionId

    if (this.connSelectEl) {
      this.connSelectEl.value = connectionId || ''
      syncStudioSelectTooltip(this.connSelectEl, 'Active Database Connection')
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
      this.pendingConfirmedInlineAi = null
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
      this.loadedDataTableKey = null
      this.isShowingSqlResult = false
      this.activeQueryResult = null
      this.lastPageData = null
      this.activeResultSetIndex = 0
      this.editableSqlTarget = null
      this.hideResultSetsBar()
      this.renderExplainAiForActiveTab()
      if (
        changed &&
        (!this.pendingBootDataCache ||
          this.pendingBootDataCache.activeConnectionId !== connectionId)
      ) {
        this.saveStudioDataCache()
      }
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
      this.valueInspector.clearSelection()

      const matchingBootCache =
        connectionId &&
        this.pendingBootDataCache &&
        this.pendingBootDataCache.activeConnectionId === connectionId
          ? this.pendingBootDataCache
          : null

      const restoredSelectedSchema =
        (preservePendingTable ? this.pendingDocSchema : undefined) ||
        (connectionId ? this.selectedSchemaByConn[connectionId] : undefined) ||
        matchingBootCache?.selectedSchema ||
        undefined
      this.selectedSchema = restoredSelectedSchema
      if (preservePendingTable && this.pendingDocSchema) {
        this.activeSchema = this.pendingDocSchema
      } else if (restoredSelectedSchema) {
        this.activeSchema = restoredSelectedSchema
      }
      this.availableSchemas =
        connectionId && Array.isArray(this.availableSchemasByConn[connectionId])
          ? this.availableSchemasByConn[connectionId].slice()
          : Array.isArray(matchingBootCache?.availableSchemas)
            ? matchingBootCache.availableSchemas.filter((s) => typeof s === 'string' && s.length > 0)
            : []
      this.defaultSchema =
        (connectionId && this.defaultSchemaByConn[connectionId]) ||
        matchingBootCache?.defaultSchema ||
        undefined
      const cachedSchemaObjs = connectionId
        ? this.schemaObjectsByConnSchema.get(
            this.makeConnSchemaKey(connectionId, this.selectedSchema || this.defaultSchema)
          )
        : undefined
      this.schemaObjects = Array.isArray(cachedSchemaObjs)
        ? cachedSchemaObjs.slice()
        : Array.isArray(matchingBootCache?.schemaObjects) &&
            (!this.selectedSchema ||
              !matchingBootCache.selectedSchema ||
              matchingBootCache.selectedSchema === this.selectedSchema)
          ? matchingBootCache.schemaObjects
          : []
      this.schemaMap = {}
      if (matchingBootCache?.activeObjectKind) {
        this.activeObjectKind = matchingBootCache.activeObjectKind
      }
      if (matchingBootCache?.activeReadOnlyObject) {
        this.activeReadOnlyObject = matchingBootCache.activeReadOnlyObject
      }
      this.updateSchemaSwitcherDisplay()
      this.tableDetailsCache.clear()
      this.inFlightTableDetails.clear()
      this.lastInspectorLoadedKey = ''
      this.lastErLoadedKey = ''
      this.erDiagramView?.clear()
      this.currentPageRowCount = 0
      this.lastSelectionSummary = null
      this.updateSelectionStatusDisplay(null)
      this.sqlConsole?.updateSchema({}, '')
      if (connectionId && this.schemaObjects.length === 0 && !matchingBootCache) {
        this.isIntrospectingSchema = true
        this.renderSidebarSkeleton()
      } else {
        this.isIntrospectingSchema = false
        this.renderSidebarObjects()
      }
      this.dataGrid?.clearSortIndicator()
      this.dataGrid?.setForeignKeys([])
      const hydrateRes =
        matchingBootCache && connectionId
          ? this.tryHydratePendingBootCache(connectionId)
          : { loaded: false, hydratedGrid: false }
      if (!hydrateRes.hydratedGrid) {
        this.currentColCount = 0
        this.currentMetricsTruncated = false
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
        if (this.gridPageInfoEl) {
          this.gridPageInfoEl.textContent = 'Page 1'
        }
        if (this.gridSubbarTitleEl) {
          this.gridSubbarTitleEl.textContent = 'Select a table'
        }
        this.updateStatus(
          connectionId ? 'Loading schema...' : 'Ready',
          formatGridStatusMetrics(0, 0)
        )
      }
      this.schemaInspector?.clear()
      this.updatePaginationButtons()
      this.updateExportDropdownOptions()
    }

    const conn = this.getActiveConnection()
    this.applyActiveConnectionPresentation(conn)
    if (!connectionId || !conn) {
      this.hasLoadedActiveConnection = false
      this.txToolbar.resetLocalStateAndRender()
      return
    }
    if (changed && this.isAiInlineReady()) {
      this.sqlConsole?.notifyAiAvailabilityChanged()
    }

    void this.refreshTransactionState(conn.id)

    if (!this.hasLoadedActiveConnection && !shouldResetState) {
      this.updateSchemaSwitcherDisplay()
      const hydrated =
        this.pendingBootDataCache && this.pendingBootDataCache.activeConnectionId === conn.id
          ? this.tryHydratePendingBootCache(conn.id).loaded
          : false
      if (!hydrated) {
        const targetCacheObjs = this.schemaObjectsByConnSchema.get(
          this.makeConnSchemaKey(conn.id, this.selectedSchema || this.defaultSchema)
        )
        if (targetCacheObjs) {
          this.schemaObjects = targetCacheObjs.slice()
          this.isIntrospectingSchema = false
          this.renderSidebarObjects()
        } else if (
          this.selectedSchema &&
          this.schemaObjects.some((o) => o.schema && o.schema !== this.selectedSchema)
        ) {
          this.schemaObjects = []
          this.isIntrospectingSchema = true
          this.renderSidebarSkeleton()
        }
      }
    }

    if (!this.hasLoadedActiveConnection) {
      this.hasLoadedActiveConnection = true
      this.pendingDocConnectionId = null
      this.pendingDocTable = null
      this.pendingDocSchema = undefined
      void this.introspectSchema(conn.id)
    }

    this.syncErDiagramIfActive()
  }

  private closeSidebarContextMenu(): void {
    if (this.sidebarContextMenuEl) {
      this.sidebarContextMenuEl.remove()
      this.sidebarContextMenuEl = null
    }
  }

  private updateSchemaSwitcherDisplay(): void {
    const selects = [this.schemaSelectEl, this.topbarSchemaSelectEl].filter(
      (sel): sel is HTMLSelectElement => sel !== null
    )
    const conn = this.getActiveConnection()
    const isSqlEngine = Boolean(conn && conn.driver !== 'redis')
    if (!isSqlEngine || this.availableSchemas.length === 0) {
      for (const sel of selects) {
        sel.innerHTML = ''
      }
      if (this.schemaSelectEl) {
        this.schemaSelectEl.style.display = 'none'
      }
      if (this.topbarSchemaWrapEl) {
        this.topbarSchemaWrapEl.style.display = 'none'
      }
      return
    }
    const current =
      this.selectedSchema || this.defaultSchema || this.availableSchemas[0] || ''
    const resolved = this.availableSchemas.includes(current)
      ? current
      : this.availableSchemas[0] || ''
    for (const sel of selects) {
      sel.innerHTML = ''
      for (const schema of this.availableSchemas) {
        const opt = document.createElement('option')
        opt.value = schema
        opt.textContent = schema
        sel.appendChild(opt)
      }
      sel.value = resolved
      syncStudioSelectTooltip(sel, 'Active Schema')
    }
    if (this.schemaSelectEl) {
      this.schemaSelectEl.style.display = 'block'
    }
    if (this.topbarSchemaWrapEl) {
      this.topbarSchemaWrapEl.style.display = 'inline-flex'
    }
  }

  private handleSchemaSelectionChanged(source: 'sidebar' | 'topbar' = 'sidebar'): void {
    this.hasUserInteraction = true
    const triggerEl = source === 'topbar' ? this.topbarSchemaSelectEl : this.schemaSelectEl
    const mirrorEl = source === 'topbar' ? this.schemaSelectEl : this.topbarSchemaSelectEl
    const nextSchema = triggerEl?.value || undefined
    if (mirrorEl) {
      mirrorEl.value = nextSchema || ''
      syncStudioSelectTooltip(mirrorEl, 'Active Schema')
    }
    syncStudioSelectTooltip(triggerEl, 'Active Schema')
    this.closeTopbarPopover()
    if (
      nextSchema === this.selectedSchema &&
      this.hasLoadedActiveConnection &&
      !this.schemaError
    ) {
      return
    }
    this.selectedSchema = nextSchema
    this.activeSchema = nextSchema
    if (this.activeConnectionId && nextSchema) {
      this.recordSelectedSchema(this.activeConnectionId, nextSchema, true)
    }
    this.pendingDocSchema = undefined
    this.pendingDocTable = null
    this.pendingBootDataCache = null
    this.activeTable = null
    this.activeObjectKind = null
    this.activeReadOnlyObject = null
    this.isShowingSqlResult = false
    this.activeQueryResult = null
    this.lastPageData = null
    this.activeWhereClause = undefined
    this.activeOrderByClause = undefined
    if (this.whereInputEl) this.whereInputEl.value = ''
    if (this.orderByInputEl) this.orderByInputEl.value = ''
    this.dataGrid?.clearSortIndicator()
    this.dataGrid?.clearClientColumnFilters()
    this.lastInspectorLoadedKey = ''
    this.lastErLoadedKey = ''
    this.tableLoadToken++
    this.schemaLoadToken++
    if (this.shouldSyncMetadataHeaders()) {
      if (nextSchema) {
        this.updateMetadataHeader('schema', nextSchema)
      }
      this.removeMetadataHeader('table')
    }
    if (this.activeConnectionId) {
      const cachedObjs = this.schemaObjectsByConnSchema.get(
        this.makeConnSchemaKey(this.activeConnectionId, nextSchema)
      )
      if (cachedObjs) {
        this.schemaObjects = cachedObjs
        this.isIntrospectingSchema = false
        this.renderSidebarObjects()
      }
    }
    this.saveStudioViewState(true)
    this.saveStudioDataCache()
    if (this.activeConnectionId) {
      void this.introspectSchema(this.activeConnectionId)
      this.syncErDiagramIfActive()
    }
  }

  private updateExportDdlBtnState(): void {
    if (!this.exportDdlBtn) return
    const conn = this.getActiveConnection()
    const disabled =
      !this.activeConnectionId ||
      !conn ||
      conn.driver === 'redis' ||
      this.isExportingSchemaDdl
    this.exportDdlBtn.disabled = disabled
    this.exportDdlBtn.title =
      conn && conn.driver === 'redis'
        ? 'Full schema DDL export is unavailable for Redis'
        : 'Export full schema DDL as a .sql file'
  }

  private async exportFullSchemaDdl(): Promise<void> {
    if (this.isExportingSchemaDdl) return
    const conn = this.getActiveConnection()
    if (!this.activeConnectionId || !conn || conn.driver === 'redis') {
      this.updateStatus('Select a SQL database connection to export schema DDL')
      return
    }
    const targetConnId = this.activeConnectionId
    this.isExportingSchemaDdl = true
    this.updateExportDdlBtnState()
    setButtonLoading(this.exportDdlBtn, true, 'Exporting...')
    this.updateStatus('Exporting full schema DDL...')
    try {
      const res = await this.requestPlugin<{
        ddl: string
        objectCount: number
        fileName: string
      }>(
        'schema.exportSchemaDdl',
        {
          connectionId: targetConnId,
          ...(this.selectedSchema ? { schema: this.selectedSchema } : {}),
        },
        { timeoutMs: DEFAULT_RPC_TIMEOUT_MS }
      )
      if (this.activeConnectionId !== targetConnId) return
      const fileName = res.fileName || 'schema.sql'
      const saveStatus = await downloadTextFile(res.ddl, fileName, 'text/sql;charset=utf-8')
      if (saveStatus === 'cancelled') {
        this.updateStatus('Schema DDL export cancelled')
        return
      }
      if (saveStatus === 'failed') {
        throw new Error('Could not save schema DDL file in this environment.')
      }
      const objectCount = Number.isFinite(res.objectCount) ? res.objectCount : 0
      this.showQueryBanner(
        'success',
        `Exported DDL for ${objectCount} objects`,
        `Saved ${fileName}`
      )
      this.updateStatus(`Exported DDL for ${objectCount} objects -> ${fileName}`)
    } catch (err: unknown) {
      if (this.activeConnectionId !== targetConnId) return
      const msg = err instanceof Error ? err.message : String(err)
      this.showQueryBanner('error', 'Failed to Export Schema DDL', msg)
      this.updateStatus(`Schema DDL export error: ${msg}`)
    } finally {
      this.isExportingSchemaDdl = false
      setButtonLoading(this.exportDdlBtn, false)
      this.updateExportDdlBtnState()
    }
  }

  private isTabularKind(kind: SchemaObjectKind): boolean {
    return isTabularObjectKind(kind)
  }

  private activateSidebarObject(item: SchemaObject): void {
    if (item.kind === 'materialized_view') {
      this.selectReadOnlyObject(item)
    } else if (this.isTabularKind(item.kind)) {
      this.selectSidebarObject(item)
    } else {
      this.selectReadOnlyObject(item)
    }
  }

  private selectReadOnlyObject(item: SchemaObject): void {
    if (this.schemaInspector?.isMigrationInFlight()) {
      this.updateStatus('Wait for active schema migration to finish')
      return
    }
    this.activeObjectKind = item.kind
    this.activeReadOnlyObject = { ...item }
    this.activeTable = null
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
    this.updateSelectedTableHighlight()
    this.sqlConsole?.updateSchema(this.schemaMap, item.name)
    this.updateMetadataHeader('table', item.name)
    if (item.schema) {
      this.updateMetadataHeader('schema', item.schema)
    }
    this.saveStudioViewState(true)
    this.lastInspectorLoadedKey = this.inspectorKey()
    this.switchMode('inspector')
    void this.loadReadOnlyObjectDdl(item)
  }

  private async loadReadOnlyObjectDdl(item: SchemaObject): Promise<void> {
    if (!this.activeConnectionId || typeof window === 'undefined' || !window.orca?.plugin?.request) {
      return
    }
    const connId = this.activeConnectionId
    const token = ++this.schemaLoadToken
    const driver = this.getActiveConnection()?.driver || 'sqlite'
    this.schemaInspector?.setLoading(true, item.name)
    try {
      const res = await this.requestObjectDdl(item)
      if (
        token !== this.schemaLoadToken ||
        this.activeConnectionId !== connId ||
        this.activeReadOnlyObject?.name !== item.name ||
        this.activeReadOnlyObject?.kind !== item.kind ||
        (this.activeSchema || '') !== (item.schema || '')
      ) {
        return
      }
      this.schemaInspector?.setReadOnlyObjectDdl(item, res, driver)
      this.lastInspectorLoadedKey = this.inspectorKey()
      this.updateStatus(`Loaded DDL for ${item.name}`)
    } catch (err: unknown) {
      if (
        token !== this.schemaLoadToken ||
        this.activeConnectionId !== connId ||
        this.activeReadOnlyObject?.name !== item.name ||
        this.activeReadOnlyObject?.kind !== item.kind
      ) {
        return
      }
      const msg = err instanceof Error ? err.message : String(err)
      this.schemaInspector?.setError(msg, () => {
        void this.loadReadOnlyObjectDdl(item)
      })
      this.updateStatus(`Failed to load DDL for ${item.name}: ${msg}`)
    }
  }

  private async requestObjectDdl(item: SchemaObject): Promise<string> {
    if (!this.activeConnectionId) {
      throw new Error('No active connection')
    }
    const res = await this.requestPlugin<{ ddl: string }>(
      'schema.getObjectDdl',
      {
        connectionId: this.activeConnectionId,
        name: item.name,
        kind: item.kind,
        ...(item.schema ? { schema: item.schema } : {}),
      },
      { timeoutMs: DEFAULT_RPC_TIMEOUT_MS }
    )
    return res.ddl || ''
  }

  private async copyObjectDdl(item: SchemaObject): Promise<void> {
    const connId = this.activeConnectionId
    try {
      const ddl = await this.requestObjectDdl(item)
      if (this.activeConnectionId !== connId) return
      const copied = await copyTextFallback(ddl)
      this.updateStatus(
        copied ? `Copied DDL for ${item.name}` : `Failed to copy DDL for ${item.name}`
      )
    } catch (err: unknown) {
      if (this.activeConnectionId !== connId) return
      const msg = err instanceof Error ? err.message : String(err)
      this.updateStatus(`Failed to copy DDL: ${msg}`)
    }
  }

  private async openObjectDdlInConsole(item: SchemaObject): Promise<void> {
    const connId = this.activeConnectionId
    try {
      const ddl = await this.requestObjectDdl(item)
      if (this.activeConnectionId !== connId) return
      this.sqlConsole?.insertText(ddl)
      if (this.activeViewMode !== 'split' && this.activeViewMode !== 'sql') {
        this.switchMode('split')
      }
      this.updateStatus(`Opened DDL for ${item.name} in SQL Console`)
    } catch (err: unknown) {
      if (this.activeConnectionId !== connId) return
      const msg = err instanceof Error ? err.message : String(err)
      this.updateStatus(`Failed to open DDL: ${msg}`)
    }
  }

  private selectSidebarObject(
    item: SchemaObject,
    options?: { skipErFocus?: boolean }
  ): void {
    const isSameTable =
      this.activeTable === item.name &&
      this.activeObjectKind === item.kind &&
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
    this.activeObjectKind = item.kind
    this.activeReadOnlyObject = null
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
    const shouldFocusEr = this.activeViewMode === 'er' && !options?.skipErFocus
    if (this.activeConnectionId && (!isSameTable || hadActiveFilterOrPage)) {
      if (this.activeQueryId) {
        const cancelTargetId = this.activeWorkerQueryId || this.activeQueryId
        this.cancelledQueryIds.add(this.activeQueryId)
        this.cancelledQueryIds.add(cancelTargetId)
        void this.requestPlugin('query.cancel', { queryId: cancelTargetId }).catch(() => {})
        this.querySeq++
        this.isCancellingQuery = false
        setButtonLoading(this.runBtn, false)
        setButtonLoading(this.runAllBtn, false)
        setButtonLoading(this.explainBtn, false)
        this.setQueryRunningState(null)
      }
      this.lastInspectorLoadedKey = ''
      void this.loadTableData(this.activeConnectionId, item.name, 1, undefined, shouldFocusEr)
      if (this.activeViewMode === 'inspector') {
        void this.loadActiveTableSchema()
      }
    }
    if (shouldFocusEr) {
      this.erDiagramView?.focusTable(item.name, item.schema)
    }
  }

  private async fetchTableDetailsDeduped(
    connectionId: string,
    table: string,
    schema?: string,
    force = false
  ): Promise<TableDetails> {
    const cacheKey = buildStudioTableKey(connectionId, schema, table)
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
    return formatQualifiedSqlTable(item, driver)
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
    const { columns, primaryKey } = await this.getObjectColumnMeta(item)
    const sqlText = buildSqlTemplateForObject(item, kind, driver, columns, primaryKey)

    this.sqlConsole?.insertText(sqlText)
    if (this.activeViewMode !== 'split' && this.activeViewMode !== 'sql') {
      this.switchMode('split')
    }
    this.updateStatus(`Generated ${kind.toUpperCase()} template for ${item.name}`)
  }

  private openSidebarContextMenu(clientX: number, clientY: number, item: SchemaObject): void {
    this.closeSidebarContextMenu()
    this.closeTopbarPopover()
    if (typeof document === 'undefined') return

    this.sidebarContextMenuEl = createSidebarContextMenu({
      clientX,
      clientY,
      item,
      driver: this.getActiveConnection()?.driver || 'sqlite',
      isReadOnly: this.isActiveConnectionReadOnly(),
      activeViewMode: this.activeViewMode,
      closeMenus: () => {
        this.closeSidebarContextMenu()
        this.closeTopbarPopover()
      },
      onSelectReadOnlyObject: (target) => this.selectReadOnlyObject(target),
      onSelectSidebarObject: (target) => this.selectSidebarObject(target),
      onSwitchMode: (mode) => this.switchMode(mode),
      onUpdateStatus: (msg) => this.updateStatus(msg),
      onCopyObjectDdl: (target) => {
        void this.copyObjectDdl(target)
      },
      onOpenObjectDdlInConsole: (target) => {
        void this.openObjectDdlInConsole(target)
      },
      onCountRows: (target) => {
        void this.countRowsForObject(target)
      },
      onGenerateSql: (target, kind) => {
        void this.generateSqlTemplateForObject(target, kind)
      },
      onOpenImportModal: (target) => {
        void this.openImportDataModal(target)
      },
      onOpenDangerModal: (action, target) => this.openDangerTableModal(action, target),
    })
  }

  private renderTopbarObjects(filtered: SchemaObject[]): void {
    const totalTableCount = this.schemaObjects.filter((o) => o.kind === 'table').length
    renderStudioTopbarObjects({
      filtered,
      totalCount: this.schemaObjects.length,
      totalTableCount,
      filterQuery: this.filterQuery,
      sidebarCollapsed: this.sidebarCollapsed,
      schemaError: this.schemaError,
      activeConnection: this.getActiveConnection(),
      topbarCountEl: this.topbarCountEl,
      topbarAllBtn: this.topbarAllBtn,
      topbarTrackEl: this.topbarTrackEl,
      isObjectActive: (name, schema, kind) => this.isObjectActive(name, schema, kind),
      onActivateObject: (item) => this.activateSidebarObject(item),
      onOpenContextMenu: (x, y, item) => this.openSidebarContextMenu(x, y, item),
      onScrollActiveIntoView: () => this.scrollActiveTopbarPillIntoView(),
      onRetrySchema: () => {
        if (this.activeConnectionId) {
          void this.introspectSchema(this.activeConnectionId, false)
        }
      },
      onEditConnection: (conn) => this.openConnectionModal(conn),
    })
  }

  private renderSidebarSkeleton(): void {
    renderStudioSidebarSkeleton(this.sidebarListEl, this.topbarTrackEl, this.topbarCountEl)
  }

  private formatConnectionLabel(connectionId?: string | null): string {
    const conn =
      (connectionId ? this.connections.find((c) => c.id === connectionId) : undefined) ||
      this.getActiveConnection()
    if (!conn) return ''
    const driverLabel = getConnectionEngineMeta(conn.driver)?.label || conn.driver
    return `${conn.name} (${driverLabel})`
  }

  private formatStudioBannerTitle(title: string, connectionId?: string | null): string {
    const conn =
      (connectionId ? this.connections.find((c) => c.id === connectionId) : undefined) ||
      this.getActiveConnection()
    if (!conn) return title
    const connLabel = this.formatConnectionLabel(conn.id)
    if (!connLabel || title.endsWith(` — ${connLabel}`) || title.includes(connLabel)) return title
    return `${title} — ${connLabel}`
  }

  private isActionableTlsErrorText(text: string): boolean {
    const s = text.toLowerCase()
    if (!s) return false
    return (
      s.includes('tls.ca_requires_verify') ||
      s.includes('ca_requires_verify') ||
      s.includes('verify-ca') ||
      s.includes('verify-full') ||
      s.includes('self_signed_cert') ||
      s.includes('self-signed certificate') ||
      s.includes('depth_zero_self_signed_cert') ||
      s.includes('unable_to_verify_leaf_signature') ||
      s.includes('unable to verify the first certificate') ||
      s.includes('unable to get local issuer certificate') ||
      s.includes('err_tls_cert_altname_invalid') ||
      s.includes('hostname/ip does not match') ||
      s.includes('cert_has_expired') ||
      s.includes('certificate has expired') ||
      s.includes('certificate verify failed') ||
      s.includes('custom ca')
    )
  }

  private renderSidebarObjects(): void {
    if (!this.sidebarListEl) return
    if (this.isIntrospectingSchema) {
      this.renderSidebarSkeleton()
      return
    }
    const filtered = this.schemaObjects.filter(
      (o) => !this.filterQuery || o.name.toLowerCase().includes(this.filterQuery)
    )
    this.renderTopbarObjects(filtered)
    renderStudioSidebarList(
      {
        sidebarListEl: this.sidebarListEl,
        schemaObjects: this.schemaObjects,
        schemaError: this.schemaError,
        schemaStale: this.schemaStale,
        schemaStaleReason: this.schemaStaleReason,
        schemaCachedAt: this.schemaCachedAt,
        filterQuery: this.filterQuery,
        activeConnectionId: this.activeConnectionId,
        activeConnection: this.getActiveConnection(),
        collapsedGroups: this.collapsedSidebarGroups,
        isObjectActive: (name, schema, kind) => this.isObjectActive(name, schema, kind),
        onOpenConnectionModal: () => this.openConnectionModal(),
        onEditConnection: (conn) => this.openConnectionModal(conn),
        onRetrySchema: () => {
          if (this.activeConnectionId) {
            void this.introspectSchema(this.activeConnectionId, true, true)
          }
        },
        onOpenCreateTableModal: () => this.openCreateTableModal(),
        onToggleGroup: (kind) => {
          if (this.collapsedSidebarGroups.has(kind)) {
            this.collapsedSidebarGroups.delete(kind)
          } else {
            this.collapsedSidebarGroups.add(kind)
          }
          this.renderSidebarObjects()
        },
        onActivateObject: (item) => this.activateSidebarObject(item),
        onOpenContextMenu: (x, y, item) => this.openSidebarContextMenu(x, y, item),
      },
      filtered
    )
  }

  private async prefetchAutocompleteSchema(
    connectionId: string,
    tableNames: string[],
    reqToken: number
  ): Promise<void> {
    const targets = tableNames.slice(0, 100)
    const schemaMap: Record<string, string[]> = { ...this.schemaMap }
    const batchSize = 4

    for (let i = 0; i < targets.length; i += batchSize) {
      if (reqToken !== this.introspectToken || this.activeConnectionId !== connectionId) {
        return
      }
      const chunk = targets.slice(i, i + batchSize)
      const results = await Promise.allSettled(
        chunk.map(async (t) => {
          const obj =
            this.schemaObjects.find((o) => this.isTabularKind(o.kind) && o.name === t) ||
            this.schemaObjects.find((o) => o.name === t)
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

  private async fetchCatalogObjects(
    connectionId: string,
    schema?: string,
    forceRefresh = false
  ): Promise<{
    objects: SchemaObject[]
    stale: boolean
    staleReason?: string
    cachedAt?: number
  }> {
    try {
      const cat = await this.requestPlugin<
        SchemaCatalogObjectsResult | SchemaObject[] | { ok?: boolean }
      >(
        'schema.listObjectsCatalog',
        {
          connectionId,
          ...(schema ? { schema } : {}),
          ...(forceRefresh ? { forceRefresh: true } : {}),
        },
        { timeoutMs: DEFAULT_RPC_TIMEOUT_MS }
      )
      if (
        cat &&
        typeof cat === 'object' &&
        !Array.isArray(cat) &&
        'data' in cat &&
        Array.isArray(cat.data)
      ) {
        return {
          objects: cat.data,
          stale: Boolean(cat.stale),
          staleReason: cat.staleReason,
          cachedAt: cat.cachedAt,
        }
      }
      if (Array.isArray(cat)) {
        return { objects: cat, stale: false }
      }
    } catch {
      // Fall back to schema.listObjects when catalog RPC is unsupported or errors
    }
    const raw = await this.requestPlugin<SchemaObject[]>(
      'schema.listObjects',
      {
        connectionId,
        ...(schema ? { schema } : {}),
      },
      { timeoutMs: DEFAULT_RPC_TIMEOUT_MS }
    )
    return { objects: Array.isArray(raw) ? raw : [], stale: false }
  }

  private async introspectSchema(
    connectionId: string,
    preservePage = false,
    forceRefresh = false
  ): Promise<void> {
    if (this.isDestroyed || typeof window === 'undefined' || !window.orca?.plugin?.request) return
    const reqToken = ++this.introspectToken
    this.schemaError = null
    const hasWarmCache = Boolean(
      this.pendingBootDataCache && this.pendingBootDataCache.activeConnectionId === connectionId
    )
    const hasCachedObjects = this.schemaObjects.length > 0
    if (!hasCachedObjects) {
      this.isIntrospectingSchema = true
      this.renderSidebarSkeleton()
      this.updateStatus('Loading schema...')
      if (!hasWarmCache) {
        this.dataGrid?.setEmptyMessage('Loading schema...')
      }
    }
    try {
      const initialRequestedSchema = this.selectedSchema
      type CatalogOutcome =
        | {
            ok: true
            value: {
              objects: SchemaObject[]
              stale: boolean
              staleReason?: string
              cachedAt?: number
            }
          }
        | { ok: false; error: unknown }
      const schemasPromise = this.requestPlugin<{ schemas: string[]; defaultSchema: string }>(
        'schema.listSchemas',
        { connectionId },
        { timeoutMs: DEFAULT_RPC_TIMEOUT_MS }
      ).catch(() => null)
      const objectsPromise: Promise<CatalogOutcome> = this.fetchCatalogObjects(
        connectionId,
        initialRequestedSchema,
        forceRefresh
      ).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error })
      )
      const [schemasResult, objectsOutcome] = await Promise.all([schemasPromise, objectsPromise])
      if (reqToken !== this.introspectToken || this.activeConnectionId !== connectionId) {
        return
      }

      const listedSchemas =
        schemasResult && Array.isArray(schemasResult.schemas)
          ? schemasResult.schemas.filter((s) => typeof s === 'string' && s.length > 0)
          : []
      const resolvedDefaultSchema =
        (schemasResult?.defaultSchema || '').trim() || listedSchemas[0] || undefined

      let objects: SchemaObject[]
      let stale = false
      let staleReason: string | undefined
      let cachedAt: number | undefined
      if (
        initialRequestedSchema &&
        listedSchemas.length > 0 &&
        !listedSchemas.includes(initialRequestedSchema)
      ) {
        this.selectedSchema = resolvedDefaultSchema
        if (this.activeSchema && !listedSchemas.includes(this.activeSchema)) {
          this.activeSchema = resolvedDefaultSchema
        }
        this.availableSchemas = listedSchemas
        this.defaultSchema = resolvedDefaultSchema
        this.updateSchemaSwitcherDisplay()
        const retryCatalog = await this.fetchCatalogObjects(
          connectionId,
          resolvedDefaultSchema,
          forceRefresh
        )
        if (reqToken !== this.introspectToken || this.activeConnectionId !== connectionId) {
          return
        }
        objects = retryCatalog.objects
        stale = retryCatalog.stale
        staleReason = retryCatalog.staleReason
        cachedAt = retryCatalog.cachedAt
      } else {
        if (!objectsOutcome.ok) {
          throw objectsOutcome.error
        }
        objects = objectsOutcome.value.objects
        stale = objectsOutcome.value.stale
        staleReason = objectsOutcome.value.staleReason
        cachedAt = objectsOutcome.value.cachedAt
      }

      this.isIntrospectingSchema = false
      this.schemaError = null
      this.schemaStale = stale
      this.schemaStaleReason = staleReason
      this.schemaCachedAt = cachedAt
      this.schemaObjects = objects
      if (
        this.activeResultBannerState?.kind === 'error' &&
        this.activeResultBannerState.source === 'schema'
      ) {
        this.hideQueryBanner()
      }
      const derivedSchemas = Array.from(
        new Set(
          this.schemaObjects
            .map((o) => o.schema)
            .filter((s): s is string => typeof s === 'string' && s.length > 0)
        )
      )
      this.availableSchemas = listedSchemas.length > 0 ? listedSchemas : derivedSchemas
      this.availableSchemasByConn[connectionId] = this.availableSchemas.slice()
      this.defaultSchema =
        (schemasResult?.defaultSchema || '').trim() ||
        this.availableSchemas[0] ||
        undefined
      if (this.defaultSchema) {
        this.defaultSchemaByConn[connectionId] = this.defaultSchema
      } else {
        delete this.defaultSchemaByConn[connectionId]
      }
      if (!this.selectedSchema && this.defaultSchema) {
        this.selectedSchema = this.defaultSchema
      }
      if (this.selectedSchema && !this.availableSchemas.includes(this.selectedSchema)) {
        this.selectedSchema = this.defaultSchema
      }
      if (this.selectedSchema) {
        this.recordSelectedSchema(connectionId, this.selectedSchema, false)
      } else {
        delete this.selectedSchemaByConn[connectionId]
        delete this.selectedSchemaUpdatedAtByConn[connectionId]
      }
      this.schemaObjectsByConnSchema.set(
        this.makeConnSchemaKey(connectionId, this.selectedSchema || this.defaultSchema),
        objects.slice()
      )
      if (
        this.activeSchema &&
        this.availableSchemas.length > 0 &&
        !this.availableSchemas.includes(this.activeSchema)
      ) {
        this.activeSchema = this.selectedSchema || this.defaultSchema || undefined
      } else if (!this.activeSchema && this.selectedSchema) {
        this.activeSchema = this.selectedSchema
      }
      this.updateSchemaSwitcherDisplay()
      this.syncErDiagramIfActive()
      this.updateExportDdlBtnState()
      const tableNames = this.schemaObjects.filter((o) => o.kind === 'table').map((t) => t.name)
      const tabularNames = this.schemaObjects
        .filter((o) => this.isTabularKind(o.kind))
        .map((o) => o.name)
      this.schemaInspector?.setReferenceTables(tableNames)
      const fallbackNames = tableNames.length > 0 ? tableNames : tabularNames

      if (this.activeReadOnlyObject) {
        const stillPresent = this.schemaObjects.find(
          (o) =>
            o.name === this.activeReadOnlyObject?.name &&
            o.kind === this.activeReadOnlyObject?.kind &&
            (o.schema || '') === (this.activeReadOnlyObject?.schema || '')
        )
        if (stillPresent) {
          this.activeReadOnlyObject = { ...stillPresent }
          this.activeObjectKind = stillPresent.kind
          this.activeSchema = stillPresent.schema || undefined
          this.renderSidebarObjects()
          void this.loadReadOnlyObjectDdl(stillPresent)
          return
        }
        this.activeReadOnlyObject = null
        this.activeObjectKind = null
      }

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
          this.activeSchema = this.selectedSchema || this.defaultSchema || undefined
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

      const bootCache = this.pendingBootDataCache
      if (
        bootCache &&
        bootCache.activeConnectionId === connectionId &&
        bootCache.isShowingSqlResult &&
        bootCache.lastSqlResult
      ) {
        this.pendingBootDataCache = null
        this.restoredPageOnBoot = null
        this.isShowingSqlResult = true
        this.currentCanEdit = false
        const cachedRes = bootCache.lastSqlResult
        const conn = this.getActiveConnection()
        this.dataGrid?.setContextMeta(
          this.activeTable || 'query_result',
          conn?.driver || 'sqlite',
          connectionId,
          this.activeSchema || ''
        )
        this.applyActiveQueryResult(cachedRes)
        const rowCount = cachedRes.rowCount ?? (cachedRes.rows ? cachedRes.rows.length : 0)
        this.currentPage = 1
        this.totalRows = rowCount
        this.currentColCount = cachedRes.isSelect ? (cachedRes.columns?.length ?? 0) : 0
        this.currentMetricsTruncated = Boolean(cachedRes.isSelect && cachedRes.truncated)
        this.currentPageRowCount = cachedRes.rows ? cachedRes.rows.length : 0
        if (this.gridSubbarTitleEl) {
          this.gridSubbarTitleEl.textContent = cachedRes.isSelect
            ? 'SQL Result'
            : `Executed · ${cachedRes.affectedRows ?? 0} affected`
        }
        if (this.gridPageInfoEl) {
          const rowLabel = `${rowCount} ${rowCount === 1 ? 'row' : 'rows'}`
          this.gridPageInfoEl.textContent = cachedRes.truncated
            ? `${rowLabel} (truncated)`
            : rowLabel
        }
        this.updatePaginationButtons()
        this.updateExportDropdownOptions()
        this.consumePendingScrollState()
        this.updateStatus(
          'Restored SQL result',
          formatGridStatusMetrics(
            cachedRes.isSelect ? rowCount : (cachedRes.affectedRows ?? 0),
            this.currentColCount,
            {
              truncated: this.currentMetricsTruncated,
              unit: cachedRes.isSelect ? 'row' : 'affected',
            }
          )
        )
        this.saveStudioDataCache()
        void this.prefetchAutocompleteSchema(connectionId, tabularNames, reqToken)
        return
      }

      if (this.schemaObjects.length === 0 || !this.activeTable) {
        this.pendingBootDataCache = null
        this.activeSchema = this.selectedSchema || this.defaultSchema || undefined
        this.currentPageRowCount = 0
        this.currentColCount = 0
        this.currentMetricsTruncated = false
        const emptyMsg = this.selectedSchema
          ? `No objects found in "${this.selectedSchema}".`
          : 'No objects found in this connection.'
        this.dataGrid?.setEmptyMessage(emptyMsg)
        this.dataGrid?.setData({
          columns: [],
          rows: [],
          totalRows: 0,
          page: 1,
          pageSize: this.pageSize,
          primaryKey: [],
          canEdit: false,
        })
        if (this.gridSubbarTitleEl) {
          this.gridSubbarTitleEl.textContent = 'Select a table'
        }
        if (this.gridPageInfoEl) {
          this.gridPageInfoEl.textContent = 'Page 1'
        }
        this.schemaInspector?.clear()
        this.updatePaginationButtons()
        this.updateExportDropdownOptions()
        this.updateStatus('Connected · 0 tables', '0 rows')
        if (this.shouldSyncMetadataHeaders()) {
          if (this.selectedSchema) {
            this.updateMetadataHeader('schema', this.selectedSchema)
          }
          this.removeMetadataHeader('table')
        }
        this.saveStudioViewState(true)
        this.saveStudioDataCache()
        return
      }

      const initialPage =
        preservePage || this.restoredPageOnBoot
          ? Math.max(1, this.restoredPageOnBoot || this.currentPage || 1)
          : 1
      this.restoredPageOnBoot = null

      if (
        bootCache &&
        bootCache.activeConnectionId === connectionId &&
        bootCache.pageData &&
        bootCache.activeTable === this.activeTable &&
        (bootCache.activeSchema || '') === (this.activeSchema || '')
      ) {
        this.pendingBootDataCache = null
        const cachedPage = bootCache.pageData
        const conn = this.getActiveConnection()
        const readOnly = Boolean(conn?.readOnly)
        this.lastPageData = cachedPage
        this.currentPage = cachedPage.page || initialPage
        this.totalRows = cachedPage.totalRows || 0
        this.currentColCount = cachedPage.columns.length
        this.currentMetricsTruncated = false
        this.currentPageRowCount = Array.isArray(cachedPage.rows) ? cachedPage.rows.length : 0
        this.currentCanEdit = Boolean(cachedPage.canEdit) && !readOnly
        this.dataGrid?.setContextMeta(
          this.activeTable,
          conn?.driver || 'sqlite',
          connectionId,
          this.activeSchema || ''
        )
        this.dataGrid?.setData({ ...cachedPage, canEdit: this.currentCanEdit })
        const totalPages = Math.max(1, Math.ceil(this.totalRows / this.pageSize))
        if (this.gridSubbarTitleEl) {
          this.gridSubbarTitleEl.textContent = readOnly
            ? `${this.activeTable} · RO`
            : this.activeTable
        }
        if (this.gridPageInfoEl) {
          this.gridPageInfoEl.textContent = `Page ${this.currentPage} / ${totalPages} (${this.totalRows} rows)`
        }
        this.updateStatus(
          this.activeTable ? `Ready · ${this.activeTable}` : 'Ready',
          formatGridStatusMetrics(this.totalRows, this.currentColCount)
        )
        this.updatePaginationButtons()
        this.consumePendingScrollState()
        await this.loadTableData(connectionId, this.activeTable, initialPage, undefined, true)
        if (this.isDestroyed || reqToken !== this.introspectToken || this.activeConnectionId !== connectionId) {
          return
        }
        if (this.activeViewMode === 'inspector') {
          void this.loadActiveTableSchema()
        }
        void this.prefetchAutocompleteSchema(connectionId, tabularNames, reqToken)
        this.consumePendingImportAction()
        return
      }
      if (bootCache && bootCache.activeConnectionId === connectionId) {
        this.pendingBootDataCache = null
      }

      if (this.shouldSyncMetadataHeaders()) {
        const resolvedHeaderSchema = this.selectedSchema || this.activeSchema
        if (resolvedHeaderSchema) {
          this.updateMetadataHeader('schema', resolvedHeaderSchema)
        }
        if (this.activeTable) {
          this.updateMetadataHeader('table', this.activeTable)
        }
      }
      this.saveStudioViewState(true)
      this.saveStudioDataCache()

      await this.loadTableData(connectionId, this.activeTable, initialPage)
      if (this.isDestroyed || reqToken !== this.introspectToken || this.activeConnectionId !== connectionId) {
        return
      }

      if (this.activeViewMode === 'inspector') {
        void this.loadActiveTableSchema()
      }

      void this.prefetchAutocompleteSchema(connectionId, tabularNames, reqToken)
      this.consumePendingImportAction()
    } catch (err: unknown) {
      if (this.isDestroyed || reqToken !== this.introspectToken || this.activeConnectionId !== connectionId) {
        return
      }
      this.isIntrospectingSchema = false
      const msg = err instanceof Error ? err.message : String(err)
      this.schemaError = msg
      this.renderSidebarObjects()
      const connLabel = this.formatConnectionLabel(connectionId)
      this.dataGrid?.setEmptyMessage(`Failed to load schema${connLabel ? ` (${connLabel})` : ''}: ${msg}`)
      this.showQueryBanner('error', 'Failed to Load Schema', msg, {
        source: 'schema',
        connectionId,
        onRetry: () => {
          void this.introspectSchema(connectionId, preservePage)
        },
      })
      this.updatePaginationButtons()
      this.updateStatus(`Schema error${connLabel ? ` (${connLabel})` : ''}: ${msg}`)
    }
  }

  private renderQueryBannerDom(banner: ResultBannerState, onRetry?: (() => void) | null): void {
    if (!this.queryBannerEl || !this.queryBannerTitleEl || !this.queryBannerDetailEl) return
    this.queryBannerEl.className = `datanoa-query-banner ${banner.kind}`
    this.queryBannerEl.setAttribute('role', banner.kind === 'error' ? 'alert' : 'status')
    this.queryBannerTitleEl.textContent = banner.title
    this.queryBannerDetailEl.textContent = banner.detail
    this.queryBannerDetailEl.style.display = banner.detail ? 'block' : 'none'
    if (this.queryBannerCopyBtn) {
      this.lastQueryErrorText = banner.kind === 'error' ? banner.errorText || banner.detail || banner.title : ''
      this.queryBannerCopyBtn.style.display = banner.kind === 'error' ? 'inline-flex' : 'none'
    }
    if (this.queryBannerReportBtn) {
      this.queryBannerReportBtn.style.display = banner.kind === 'error' ? 'inline-flex' : 'none'
    }
    this.queryBannerRetryHandler = onRetry ?? null
    if (this.queryBannerRetryBtn) {
      this.queryBannerRetryBtn.textContent = this.queryBannerRetryLabel || 'Retry'
      this.queryBannerRetryBtn.style.display = onRetry ? 'inline-flex' : 'none'
    }
    const targetConnId = banner.connectionId ?? this.activeConnectionId
    const canEditTargetConn = Boolean(
      banner.kind === 'error' &&
        targetConnId &&
        (banner.source === 'schema' || banner.source === 'connection' || banner.tlsRemedy) &&
        this.connections.some((c) => c.id === targetConnId)
    )
    this.queryBannerEditConnHandler =
      canEditTargetConn && targetConnId
        ? () => {
            const latestConn = this.connections.find((c) => c.id === targetConnId)
            if (latestConn) {
              this.openConnectionModal(
                latestConn,
                banner.tlsRemedy ? { focusSection: 'tls' } : undefined
              )
            }
          }
        : null
    if (this.queryBannerEditConnBtn) {
      this.queryBannerEditConnBtn.textContent = banner.tlsRemedy
        ? 'Change Encryption'
        : 'Edit Connection'
      this.queryBannerEditConnBtn.style.display = canEditTargetConn ? 'inline-flex' : 'none'
    }
    if (this.queryBannerBackBtn) {
      const canReturn = Boolean(
        banner.showBackToTable && this.activeConnectionId && this.activeTable
      )
      this.queryBannerBackBtn.style.display = canReturn ? 'inline-flex' : 'none'
    }
    if (this.queryBannerFixAiBtn) {
      const canFix = banner.kind === 'error' && Boolean(banner.failedSql?.trim())
      this.queryBannerFixAiBtn.style.display = canFix ? 'inline-flex' : 'none'
    }
  }

  private setQueryBannerVisible(visible: boolean): void {
    if (!this.queryBannerEl) return
    const wasVisible = this.queryBannerEl.style.display !== 'none'
    this.queryBannerEl.style.display = visible ? 'flex' : 'none'
    if (wasVisible !== visible && isGridVisibleMode(this.activeViewMode)) {
      this.dataGrid?.handleViewportResize()
    }
  }

  private shouldShowActiveBannerInViewMode(): boolean {
    return shouldShowQueryBannerForMode(
      this.activeViewMode,
      this.isShowingSqlResult,
      this.activeResultBannerState
    )
  }

  private syncQueryBannerForViewMode(): void {
    this.renderExplainAiForActiveTab()
    if (!this.queryBannerEl) {
      this.renderAiFixPanel()
      return
    }
    if (!this.shouldShowActiveBannerInViewMode() || !this.activeResultBannerState) {
      this.setQueryBannerVisible(false)
      this.renderAiFixPanel()
      return
    }
    this.renderQueryBannerDom(this.activeResultBannerState, this.queryBannerRetryHandler)
    this.setQueryBannerVisible(true)
    this.renderAiFixPanel()
  }

  private getAiRoleStatus(role: AiRole): AiRoleStatus | AiStatusSnapshot | null {
    const snap = this.aiStatus
    if (!snap) return null
    return snap.roles?.[role] ?? snap
  }

  private isAiInlineReady(): boolean {
    const auto = this.getAiRoleStatus('autocomplete')
    return Boolean(auto?.enabled && auto.state !== 'off' && auto.state !== 'setup')
  }

  private isExplainAiConfiguredAndEnabled(): boolean {
    const exp = this.getAiRoleStatus('explain')
    return Boolean(exp?.enabled && exp.state !== 'off' && exp.state !== 'setup')
  }

  private applyAiStatus(snapshot: AiStatusSnapshot | null): void {
    const wasReady = this.isAiInlineReady()
    this.aiStatus = snapshot
    if (this.aiBtn) {
      const badge = renderAiStatusButtonContent(this.aiBtn, snapshot)
      this.aiBtn.className = `datanoa-btn datanoa-btn-sm datanoa-ai-toolbar-btn datanoa-status-ai-btn tone-${badge.tone}`
    }
    this.syncAiBusyState()
    const nowReady = this.isAiInlineReady()
    if (!nowReady) {
      this.sqlConsole?.clearAiGhost()
    } else if (!wasReady && this.activeConnectionId) {
      this.sqlConsole?.notifyAiAvailabilityChanged()
    }
    this.renderExplainAiForActiveTab()
    if (this.aiFixState && this.aiFixState.phase !== 'hidden') {
      this.renderAiFixPanel()
    }
  }

  private async hydrateAiStatus(): Promise<void> {
    try {
      const snapshot = await this.requestPlugin<AiStatusSnapshot>('ai.status.get')
      if (!this.isDestroyed) {
        this.applyAiStatus(snapshot)
      }
    } catch {
      // Ignore if worker not ready or running under test mock
    }
  }

  private async openAiSettingsModal(initialRole?: AiRole): Promise<void> {
    await openSharedAiConfigModal({
      rpc: (name, input, opts) => this.requestPlugin(name, input, opts),
      saveSettings: saveOrcaSettingsPatch,
      initialStatus: this.aiStatus,
      ...(initialRole ? { initialRole } : {}),
      onStatusUpdated: (snapshot) => this.applyAiStatus(snapshot),
      mountModal: (modalEl, canClose, onDismiss) =>
        this.mountStudioModal(modalEl, canClose, onDismiss),
      closeModal: () => this.closeActiveModal(),
    })
  }

  private syncAiBusyState(): void {
    const busy = this.aiFixState?.phase === 'loading' || this.explainAiLoadingTarget !== null
    this.aiBtn?.classList.toggle('is-ai-busy', busy)
  }

  private renderExplainAiForActiveTab(): void {
    this.syncAiBusyState()
    if (!this.explainAiEl) return
    const wasHidden = this.explainAiEl.hidden
    const tab = this.consoleTabs?.getActiveTab()
    const idx = this.activeResultSetIndex
    const res = tab?.lastResult
    const sets = res ? getEffectiveResultSets(res, tab.executedSql || '') : []
    const rs = sets[idx]
    const rsState = tab?.resultStates?.[idx]
    const gridVisible = !this.gridAreaEl || this.gridAreaEl.style.display !== 'none'
    const isExplain = Boolean(
      this.isShowingSqlResult &&
        this.activeQueryResult !== null &&
        gridVisible &&
        tab &&
        res &&
        rs &&
        !rs.isError &&
        rsState?.banner?.isExplain
    )

    const explainRole = this.getAiRoleStatus('explain')
    const explainReady = this.isExplainAiConfiguredAndEnabled()

    if (!isExplain || !tab || !rsState) {
      this.gridAreaEl?.classList.remove('has-explain-ai-panel')
      if (!wasHidden) {
        renderSharedExplainAiPanel(
          this.explainAiEl,
          {
            phase: 'hidden',
            aiEnabled: Boolean(explainRole?.enabled),
            aiReady: explainReady,
            explainLanguage: this.aiStatus?.explainLanguage || 'auto',
          },
          {
            onAnalyze: () => {},
            onConfigureAi: () => {},
            onCancel: () => {},
            onApplySql: () => {},
            onOpenNewTab: () => {},
            onCopyText: () => {},
            onToggleCollapsed: () => {},
          }
        )
        this.dataGrid?.handleViewportResize()
      }
      return
    }

    const explainMeta = res ? this.explainMetaByResult.get(res) : undefined
    const originConnId = explainMeta?.connectionId ?? tab.executedConnectionId ?? this.activeConnectionId
    const explainConn = originConnId
      ? this.connections.find((c) => c.id === originConnId)
      : undefined
    const resolvedDialect = explainConn?.driver ?? explainMeta?.dialect ?? 'sqlite'
    const resolvedActiveSchema = explainMeta
      ? explainMeta.activeSchema
      : (this.selectedSchema || this.activeSchema)
    const rawPlanText =
      rs.explainPlan?.rawText ||
      explainMeta?.rawPlanTexts?.[idx] ||
      this.formatRawExplainRowsText(rs.columns || [], rs.rows || [])
    const isLoading = Boolean(
      this.explainAiLoadingTarget &&
        this.explainAiLoadingTarget.tabId === tab.id &&
        this.explainAiLoadingTarget.resultSetIndex === idx &&
        this.explainAiLoadingTarget.originLastResult === res
    )
    const phase: ExplainAiPanelState['phase'] = resolveExplainAiPhase(
      isLoading,
      rsState.explainAnalysisError,
      rsState.explainAnalysis
    )
    this.gridAreaEl?.classList.toggle('has-explain-ai-panel', !rsState.explainAnalysisCollapsed)

    const explainViewKey = `${tab.id}:${idx}`
    const explainViewMode =
      this.explainViewModeByTab.get(explainViewKey) ?? (rs.explainPlan ? 'visual' : 'raw')
    const explainPanelState: ExplainAiPanelState = {
      phase,
      aiEnabled: Boolean(explainRole?.enabled),
      aiReady: explainReady,
      explainLanguage: this.aiStatus?.explainLanguage || 'auto',
      dialect: resolvedDialect,
      destination: explainRole?.destination,
      host: explainRole?.host,
      colorTag: explainConn?.colorTag ?? explainMeta?.colorTag,
      aiPolicy: explainConn?.aiPolicy ?? explainMeta?.aiPolicy,
      activeSchema: resolvedActiveSchema,
      explainPlan: rs.explainPlan ?? null,
      rawPlanText,
      explainViewMode,
      result: rsState.explainAnalysis ?? null,
      error: rsState.explainAnalysisError ?? null,
      collapsed: Boolean(rsState.explainAnalysisCollapsed),
    }

    renderSharedExplainAiPanel(
      this.explainAiEl,
      explainPanelState,
      {
        onAnalyze: (opts) => {
          void this.runExplainAiAnalysis(tab.id, idx, opts)
        },
        onExplainViewChange: (view) => {
          explainPanelState.explainViewMode = view
          this.explainViewModeByTab.set(explainViewKey, view)
        },
        onConfigureAi: () => {
          void this.openAiSettingsModal('explain')
        },
        onCancel: () => {
          this.explainAiSeq += 1
          this.explainAiAbort?.abort()
          this.explainAiAbort = null
          this.explainAiLoadingTarget = null
          this.renderExplainAiForActiveTab()
        },
        onApplySql: (sql: string) => {
          const sqlConsole = this.sqlConsole
          if (
            !sqlConsole ||
            this.activeConnectionId !== originConnId ||
            this.consoleTabs.getActiveTabId() !== tab.id
          ) {
            return
          }
          const latestRsState = this.consoleTabs.getResultTabState(idx, tab.id) ?? rsState
          const replaceFn:
            | ((
                target: {
                  from: number
                  to: number
                  originalSlice?: string
                  fallbackSql?: string
                  statementIndex?: number
                  totalStatements?: number
                  preserveOtherStatements?: boolean
                },
                nextSql: string,
                dialect?: SqlDialectType
              ) => boolean)
            | undefined = sqlConsole.replaceSqlRange
          const target = {
            ...(latestRsState.explainTargetRange ?? { from: -1, to: -1 }),
            fallbackSql: latestRsState.statementSql,
            preserveOtherStatements: true,
          }
          const prevDoc = sqlConsole.getText()
          const dialect = explainConn?.driver || this.getActiveConnection()?.driver || 'sqlite'
          const expectedEdit = resolveSqlReplacementSpan(prevDoc, target, sql, dialect)
          if (typeof replaceFn === 'function') {
            const replaced = replaceFn.call(sqlConsole, target, sql, dialect)
            if (!replaced) {
              this.updateStatus(
                'Could not safely match target query in multi-statement script — use Copy SQL to apply manually'
              )
              return
            }
          } else {
            if (!expectedEdit) {
              this.updateStatus(
                'Could not safely match target query in multi-statement script — use Copy SQL to apply manually'
              )
              return
            }
            sqlConsole.setText(
              `${prevDoc.slice(0, expectedEdit.from)}${expectedEdit.insert}${prevDoc.slice(expectedEdit.to)}`
            )
          }
          if (expectedEdit) {
            this.remapTabResultTargetsAfterEdit(
              tab.id,
              expectedEdit.from,
              expectedEdit.to,
              expectedEdit.insert.length
            )
            if (!latestRsState.explainTargetRange) {
              const postState = this.consoleTabs.getResultTabState(idx, tab.id) ?? latestRsState
              const totalStmts =
                dialect === 'redis'
                  ? 1
                  : Math.max(sets.length, splitSqlStatements(prevDoc, dialect).length)
              this.consoleTabs.setResultTabState(
                idx,
                {
                  ...postState,
                  explainTargetRange: {
                    from: -1,
                    to: -1,
                    originalSlice: prevDoc.slice(expectedEdit.from, expectedEdit.to),
                    statementIndex: idx,
                    totalStatements: totalStmts,
                    preserveOtherStatements: true,
                  },
                },
                tab.id
              )
            }
          }
          this.saveActiveConsoleTabState()
          const latestDoc = sqlConsole.getText()
          this.documentSession?.change?.(this.composeSerializedDocument(latestDoc))
          this.saveStudioViewState(false)
          sqlConsole.focus()
          this.updateStatus('Replaced target query with optimized SQL (Ctrl+Z to undo)')
        },
        onOpenNewTab: (sql: string) => {
          this.addConsoleTab()
          this.sqlConsole?.setText(sql)
          this.saveActiveConsoleTabState()
          this.saveStudioViewState(false)
          this.sqlConsole?.focus()
          this.updateStatus('Opened optimized SQL in a new tab')
        },
        onCopyText: async (text: string, label?: string) => {
          const copied = await copyTextToClipboardAsync(text)
          if (this.isDestroyed) return
          const targetLabel = label || 'text'
          this.updateStatus(
            copied ? `Copied ${targetLabel} to clipboard` : `Failed to copy ${targetLabel} to clipboard`
          )
        },
        onToggleCollapsed: () => {
          const cur = this.consoleTabs.getResultTabState(idx, tab.id)
          if (!cur) return
          this.consoleTabs.setResultTabState(
            idx,
            { ...cur, explainAnalysisCollapsed: !cur.explainAnalysisCollapsed },
            tab.id
          )
          this.renderExplainAiForActiveTab()
          this.dataGrid?.handleViewportResize()
        },
        resizeEdge: 'top',
        onResize: () => {
          this.dataGrid?.handleViewportResize()
        },
      }
    )

    if (wasHidden || phase === 'ready' || phase === 'error') {
      this.dataGrid?.handleViewportResize()
    }
  }

  private async runExplainAiAnalysis(
    tabId: string,
    resultSetIndex: number,
    options?: { confirmed?: boolean; activeSchema?: string }
  ): Promise<void> {
    const tab = this.consoleTabs.getTabs().find((t) => t.id === tabId)
    if (!tab?.lastResult) return
    const originLastResult = tab.lastResult
    const sets = getEffectiveResultSets(originLastResult, tab.executedSql || '')
    const rs = sets[resultSetIndex]
    const rsState = tab.resultStates?.[resultSetIndex]
    if (!rs || rs.isError || !rsState) return

    const explainViewKey = `${tabId}:${resultSetIndex}`
    if (!this.isExplainAiConfiguredAndEnabled()) {
      this.explainAiSeq += 1
      this.explainAiAbort?.abort()
      this.explainAiAbort = null
      this.explainAiLoadingTarget = null
      this.explainViewModeByTab.set(explainViewKey, 'ai')
      this.consoleTabs.setResultTabState(
        resultSetIndex,
        {
          ...rsState,
          explainAnalysisError:
            'Explain & Fix AI is not configured or disabled. Enable Explain & Fix in AI Settings to analyze query plans.',
          explainAnalysisCollapsed: false,
        },
        tabId
      )
      this.renderExplainAiForActiveTab()
      return
    }

    const sql = rsState.statementSql || rs.sql || tab.executedSql || ''
    if (containsSensitiveSqlText(sql)) {
      this.explainAiSeq += 1
      this.explainAiAbort?.abort()
      this.explainAiAbort = null
      this.explainAiLoadingTarget = null
      this.explainViewModeByTab.set(explainViewKey, 'ai')
      this.consoleTabs.setResultTabState(
        resultSetIndex,
        {
          ...rsState,
          explainAnalysisError:
            'Query appears to contain sensitive credentials/secrets and was not sent to AI.',
          explainAnalysisCollapsed: false,
        },
        tabId
      )
      this.renderExplainAiForActiveTab()
      return
    }

    this.explainAiAbort?.abort()
    const ac = new AbortController()
    this.explainAiAbort = ac
    const seq = ++this.explainAiSeq
    this.explainAiLoadingTarget = { tabId, resultSetIndex, originLastResult }
    this.explainViewModeByTab.set(explainViewKey, 'ai')
    this.consoleTabs.setResultTabState(
      resultSetIndex,
      { ...rsState, explainAnalysisError: null, explainAnalysisCollapsed: false },
      tabId
    )
    this.renderExplainAiForActiveTab()

    const explainMeta = this.explainMetaByResult.get(originLastResult)
    const connId =
      explainMeta?.connectionId ?? tab.executedConnectionId ?? this.activeConnectionId ?? ''
    const conn = connId ? this.connections.find((c) => c.id === connId) : undefined
    const resolvedDialect = conn?.driver ?? explainMeta?.dialect ?? 'sqlite'
    const uiLocale =
      typeof window !== 'undefined'
        ? (window.orca as unknown as { locale?: string } | undefined)?.locale
        : undefined

    try {
      const resolvedActiveSchema =
        options?.activeSchema ??
        (explainMeta ? explainMeta.activeSchema : (this.selectedSchema ?? this.activeSchema))
      const explainPayload = {
        connectionId: connId,
        fromConnection: true,
        dialect: resolvedDialect,
        sql,
        planColumns: rs.columns.map((c) => ({ name: c.name, type: c.type || '' })),
        planRows: rs.rows,
        ...(rs.explainPlan ? { explainPlan: rs.explainPlan } : {}),
        ...(resolvedActiveSchema ? { activeSchema: resolvedActiveSchema } : {}),
        ...(options?.confirmed !== undefined ? { confirmed: options.confirmed } : {}),
        language: this.aiStatus?.explainLanguage || 'auto',
        uiLocale,
      }
      const result = await this.requestPlugin<AiExplainAnalysisResult>(
        'ai.explainAnalyze',
        explainPayload,
        { signal: ac.signal, timeoutMs: 65_000 }
      )
      if (this.isDestroyed || seq !== this.explainAiSeq || ac.signal.aborted) return
      const tabNow = this.consoleTabs.getTabs().find((t) => t.id === tabId)
      if (!tabNow || tabNow.lastResult !== originLastResult) return
      const latest = this.consoleTabs.getResultTabState(resultSetIndex, tabId) ?? rsState
      this.consoleTabs.setResultTabState(
        resultSetIndex,
        {
          ...latest,
          explainAnalysis: result,
          explainAnalysisError: null,
          explainAnalysisCollapsed: false,
        },
        tabId
      )
    } catch (err: unknown) {
      if (this.isDestroyed || seq !== this.explainAiSeq || ac.signal.aborted) return
      const tabNow = this.consoleTabs.getTabs().find((t) => t.id === tabId)
      if (!tabNow || tabNow.lastResult !== originLastResult) return
      const msg = err instanceof Error ? err.message : String(err)
      const latest = this.consoleTabs.getResultTabState(resultSetIndex, tabId) ?? rsState
      this.consoleTabs.setResultTabState(
        resultSetIndex,
        { ...latest, explainAnalysisError: msg, explainAnalysisCollapsed: false },
        tabId
      )
    } finally {
      if (this.explainAiAbort === ac) {
        this.explainAiAbort = null
      }
      if (
        this.explainAiLoadingTarget?.tabId === tabId &&
        this.explainAiLoadingTarget?.resultSetIndex === resultSetIndex &&
        this.explainAiLoadingTarget?.originLastResult === originLastResult
      ) {
        this.explainAiLoadingTarget = null
      }
      if (!this.isDestroyed) {
        this.renderExplainAiForActiveTab()
        if (!ac.signal.aborted) {
          void this.hydrateAiStatus()
        }
      }
    }
  }

  private clearAiFixPanel(): void {
    this.aiFixSeq += 1
    this.aiFixAbort?.abort()
    this.aiFixAbort = null
    this.aiFixState = null
    this.renderAiFixPanel()
  }

  private renderAiFixPanel(): void {
    this.syncAiBusyState()
    if (!this.aiFixEl) return
    const wasHidden = this.aiFixEl.hidden
    const current = this.aiFixState
    const visible = Boolean(
      current &&
        current.phase !== 'hidden' &&
        this.shouldShowActiveBannerInViewMode() &&
        this.activeResultBannerState?.kind === 'error'
    )

    const explainRole = this.getAiRoleStatus('explain')
    const explainReady = this.isExplainAiConfiguredAndEnabled()

    if (!visible || !current) {
      if (!wasHidden) {
        renderSharedAiFixPanel(
          this.aiFixEl,
          {
            phase: 'hidden',
            aiEnabled: Boolean(explainRole?.enabled),
            aiReady: explainReady,
          },
          {
            onReplaceQuery: () => {},
            onCopySql: () => {},
            onRetry: () => {},
            onCancel: () => {},
            onDismiss: () => {},
            onConfigureAi: () => {},
          }
        )
        if (isGridVisibleMode(this.activeViewMode)) {
          this.dataGrid?.handleViewportResize()
        }
      }
      return
    }

    const fixConnId = current.executedConnectionId ?? current.originConnectionId
    const fixConn = fixConnId
      ? this.connections.find((c) => c.id === fixConnId)
      : undefined
    const fixDialect = fixConn?.driver || 'sqlite'
    renderSharedAiFixPanel(
      this.aiFixEl,
      {
        phase: current.phase,
        aiEnabled: Boolean(explainRole?.enabled),
        aiReady: explainReady,
        dialect: fixDialect,
        destination: explainRole?.destination,
        host: explainRole?.host,
        colorTag: fixConn?.colorTag,
        aiPolicy: fixConn?.aiPolicy,
        pendingConfirm: Boolean(current.pendingConfirm),
        result: current.result,
        error: current.error,
      },
      {
        onReplaceQuery: (sql: string) => {
          if (
            !this.sqlConsole ||
            this.activeConnectionId !== current.originConnectionId ||
            this.consoleTabs.getActiveTabId() !== current.originTabId
          ) {
            this.clearAiFixPanel()
            return
          }
          const target = current.fixTargetRange
            ? { ...current.fixTargetRange, fallbackSql: current.failedSql, preserveOtherStatements: true }
            : { from: -1, to: -1, fallbackSql: current.failedSql, preserveOtherStatements: true }
          const prevDoc = this.sqlConsole.getText()
          const expectedEdit = resolveSqlReplacementSpan(prevDoc, target, sql, fixDialect)
          const replaced = this.sqlConsole.replaceSqlRange(target, sql, fixDialect)
          if (!replaced) {
            this.updateStatus(
              'Could not safely match failed statement in multi-statement script — use Copy SQL to apply manually'
            )
            return
          }
          if (expectedEdit) {
            this.remapTabResultTargetsAfterEdit(
              current.originTabId,
              expectedEdit.from,
              expectedEdit.to,
              expectedEdit.insert.length
            )
          }
          const nextDoc = this.sqlConsole.getText()
          this.consoleTabs.updateActiveSql(nextDoc, this.sqlConsole.getCursorOffset())
          this.documentSession?.change?.(this.composeSerializedDocument(nextDoc))
          this.saveStudioViewState(false)
          this.clearAiFixPanel()
          this.updateStatus('Replaced query with AI fix (Ctrl+Z to undo)')
        },
        onCopySql: async (sql: string) => {
          const copied = await copyTextFallback(sql)
          if (this.isDestroyed) return
          this.updateStatus(
            copied ? 'Copied AI fixed SQL to clipboard' : 'Failed to copy AI fixed SQL to clipboard'
          )
        },
        onFixQuery: (fixOpts) => {
          void this.handleFixWithAiClick(fixOpts)
        },
        onRetry: (fixOpts) => {
          void this.handleFixWithAiClick(fixOpts)
        },
        onCancel: () => {
          this.clearAiFixPanel()
        },
        onDismiss: () => {
          this.clearAiFixPanel()
        },
        onConfigureAi: () => {
          void this.openAiSettingsModal('explain')
        },
        resizeEdge: 'bottom',
        onResize: () => {
          this.dataGrid?.handleViewportResize()
        },
      }
    )

    if ((wasHidden || current.phase === 'ready' || current.phase === 'error') && isGridVisibleMode(this.activeViewMode)) {
      this.dataGrid?.handleViewportResize()
    }
  }

  private async handleFixWithAiClick(options?: { confirmed?: boolean }): Promise<void> {
    const banner = this.activeResultBannerState
    if (!banner || banner.kind !== 'error') return
    const failedSql = String(banner.failedSql || '').trim()
    if (!failedSql) return

    const errorMessage = banner.errorText || banner.detail || banner.title || 'Query failed'
    const fixTargetRange = banner.fixTargetRange ?? null
    const originTabId = this.consoleTabs.getActiveTabId()
    const originResultSetIndex = this.activeResultSetIndex
    const originConnectionId = this.activeConnectionId
    const originLastResult = this.activeQueryResult

    if (!this.isExplainAiConfiguredAndEnabled()) {
      this.aiFixSeq += 1
      this.aiFixAbort?.abort()
      this.aiFixAbort = null
      this.aiFixState = {
        phase: 'error',
        result: null,
        error:
          'Explain & Fix AI is not configured or disabled. Enable Explain & Fix in AI Settings to fix SQL errors.',
        failedSql,
        errorMessage,
        fixTargetRange,
        originTabId,
        originResultSetIndex,
        originConnectionId,
        originLastResult,
      }
      this.renderAiFixPanel()
      return
    }

    const activeTab = this.consoleTabs.getActiveTab()
    const recordedConnId =
      (activeTab?.executedConnectionId && activeTab.executedConnectionId.length > 0
        ? activeTab.executedConnectionId
        : undefined) ??
      (typeof banner.connectionId === 'string' && banner.connectionId.length > 0
        ? banner.connectionId
        : undefined)
    const lookupConnId = recordedConnId ?? originConnectionId
    const conn = lookupConnId
      ? this.connections.find((c) => c.id === lookupConnId)
      : undefined
    const executedConnectionId = recordedConnId ?? conn?.id ?? originConnectionId

    const rawPolicy = conn?.aiPolicy
    const rawTag = String(conn?.colorTag || '').trim().toLowerCase()
    const effectivePolicy =
      rawPolicy === 'never' || rawPolicy === 'ask' || rawPolicy === 'allow'
        ? rawPolicy
        : rawTag === 'prod' || rawTag === 'production'
          ? 'ask'
          : 'allow'

    if (effectivePolicy === 'never') {
      this.aiFixSeq += 1
      this.aiFixAbort?.abort()
      this.aiFixAbort = null
      this.aiFixState = {
        phase: 'error',
        result: null,
        error: 'AI assistance is disabled for this connection (policy: never).',
        failedSql,
        errorMessage,
        fixTargetRange,
        originTabId,
        originResultSetIndex,
        originConnectionId,
        executedConnectionId,
        originLastResult,
      }
      this.renderAiFixPanel()
      return
    }

    if (effectivePolicy === 'ask' && options?.confirmed !== true) {
      this.aiFixSeq += 1
      this.aiFixAbort?.abort()
      this.aiFixAbort = null
      this.aiFixState = {
        phase: 'idle',
        pendingConfirm: true,
        result: null,
        error: null,
        failedSql,
        errorMessage,
        fixTargetRange,
        originTabId,
        originResultSetIndex,
        originConnectionId,
        executedConnectionId,
        originLastResult,
      }
      this.renderAiFixPanel()
      return
    }

    if (containsSensitiveSqlText(failedSql) || containsSensitiveSqlText(errorMessage)) {
      this.aiFixSeq += 1
      this.aiFixAbort?.abort()
      this.aiFixAbort = null
      this.aiFixState = {
        phase: 'error',
        result: null,
        error:
          'Query or error message appears to contain sensitive credentials/secrets and was not sent to AI.',
        failedSql,
        errorMessage,
        fixTargetRange,
        originTabId,
        originResultSetIndex,
        originConnectionId,
        executedConnectionId,
        originLastResult,
      }
      this.renderAiFixPanel()
      return
    }

    this.aiFixAbort?.abort()
    const ac = new AbortController()
    this.aiFixAbort = ac
    const seq = ++this.aiFixSeq

    this.aiFixState = {
      phase: 'loading',
      result: null,
      error: null,
      failedSql,
      errorMessage,
      fixTargetRange,
      originTabId,
      originResultSetIndex,
      originConnectionId,
      executedConnectionId,
      originLastResult,
    }
    this.renderAiFixPanel()

    const isSameActiveConn = conn?.id === this.activeConnectionId
    const uiLocale =
      typeof window !== 'undefined'
        ? (window.orca as unknown as { locale?: string } | undefined)?.locale
        : undefined

    try {
      const result = await this.requestPlugin<AiFixQueryResult>(
        'ai.fixQuery',
        {
          connectionId: executedConnectionId ?? '',
          fromConnection: true,
          dialect: conn?.driver || 'sqlite',
          sql: failedSql,
          errorMessage,
          activeSchema: isSameActiveConn ? this.selectedSchema : undefined,
          activeTable: isSameActiveConn ? (this.activeTable ?? undefined) : undefined,
          schemaMap: isSameActiveConn ? this.schemaMap : {},
          ...(options?.confirmed === true ? { confirmed: true } : {}),
          language: this.aiStatus?.explainLanguage || 'auto',
          uiLocale,
        },
        { signal: ac.signal, timeoutMs: 65_000 }
      )
      if (
        this.isDestroyed ||
        seq !== this.aiFixSeq ||
        ac.signal.aborted ||
        this.activeConnectionId !== originConnectionId ||
        this.consoleTabs.getActiveTabId() !== originTabId ||
        this.activeResultSetIndex !== originResultSetIndex ||
        this.activeQueryResult !== originLastResult
      ) {
        return
      }
      this.aiFixState = {
        phase: 'ready',
        result,
        error: null,
        failedSql,
        errorMessage,
        fixTargetRange,
        originTabId,
        originResultSetIndex,
        originConnectionId,
        executedConnectionId,
        originLastResult,
      }
      if (originLastResult !== null) {
        const curState = this.consoleTabs.getResultTabState(originResultSetIndex, originTabId)
        if (curState) {
          this.consoleTabs.setResultTabState(
            originResultSetIndex,
            { ...curState, aiFixResult: result, aiFixError: null },
            originTabId
          )
        }
      }
      this.renderAiFixPanel()
    } catch (err: unknown) {
      if (
        this.isDestroyed ||
        seq !== this.aiFixSeq ||
        ac.signal.aborted ||
        this.activeConnectionId !== originConnectionId ||
        this.consoleTabs.getActiveTabId() !== originTabId ||
        this.activeResultSetIndex !== originResultSetIndex ||
        this.activeQueryResult !== originLastResult
      ) {
        return
      }
      const msg = err instanceof Error ? err.message : String(err)
      this.aiFixState = {
        phase: 'error',
        result: null,
        error: msg,
        failedSql,
        errorMessage,
        fixTargetRange,
        originTabId,
        originResultSetIndex,
        originConnectionId,
        executedConnectionId,
        originLastResult,
      }
      if (originLastResult !== null) {
        const curState = this.consoleTabs.getResultTabState(originResultSetIndex, originTabId)
        if (curState) {
          this.consoleTabs.setResultTabState(
            originResultSetIndex,
            { ...curState, aiFixResult: null, aiFixError: msg },
            originTabId
          )
        }
      }
      this.renderAiFixPanel()
    } finally {
      if (this.aiFixAbort === ac) {
        this.aiFixAbort = null
      }
      if (!this.isDestroyed && !ac.signal.aborted) {
        void this.hydrateAiStatus()
      }
    }
  }

  private remapTabResultTargetsAfterEdit(
    tabId: string,
    editFrom: number,
    editTo: number,
    insertLen: number
  ): void {
    const tab = this.consoleTabs.getTabs().find((t) => t.id === tabId)
    if (tab?.resultStates) {
      for (const [idxStr, st] of Object.entries(tab.resultStates)) {
        if (!st) continue
        let changed = false
        let nextBanner = st.banner
        if (st.banner?.fixTargetRange) {
          const remapped = remapSqlTargetRange(st.banner.fixTargetRange, editFrom, editTo, insertLen)
          if (remapped !== st.banner.fixTargetRange) {
            nextBanner = { ...st.banner, fixTargetRange: remapped }
            changed = true
          }
        }
        let nextExplainRange = st.explainTargetRange
        if (st.explainTargetRange) {
          const remapped = remapSqlTargetRange(st.explainTargetRange, editFrom, editTo, insertLen)
          if (remapped !== st.explainTargetRange) {
            nextExplainRange = remapped
            changed = true
          }
        }
        if (changed) {
          this.consoleTabs.setResultTabState(
            Number(idxStr),
            {
              ...st,
              banner: nextBanner,
              explainTargetRange: nextExplainRange,
            },
            tabId
          )
        }
      }
    }
    if (tabId === this.consoleTabs.getActiveTabId() && this.activeResultBannerState?.fixTargetRange) {
      this.activeResultBannerState = {
        ...this.activeResultBannerState,
        fixTargetRange: remapSqlTargetRange(
          this.activeResultBannerState.fixTargetRange,
          editFrom,
          editTo,
          insertLen
        ),
      }
    }
    if (this.aiFixState?.originTabId === tabId && this.aiFixState.fixTargetRange) {
      this.aiFixState = {
        ...this.aiFixState,
        fixTargetRange: remapSqlTargetRange(
          this.aiFixState.fixTargetRange,
          editFrom,
          editTo,
          insertLen
        ),
      }
    }
  }

  private resolveResultStatementRange(
    targetSql: string,
    idx: number,
    totalSets: number,
    stmtSlices: Array<{ text: string; start: number; end: number }>,
    execRange: SqlExecutionRange | null,
    resultIndex?: number
  ): SqlFixTargetRange | null {
    if (!execRange) return null
    const normStmt = (s: string): string => s.trim().replace(/;\s*$/, '').trim()
    const targetNorm = normStmt(targetSql)
    const hasValidResultIndex =
      typeof resultIndex === 'number' &&
      Number.isInteger(resultIndex) &&
      resultIndex >= 0 &&
      resultIndex < stmtSlices.length
    const preferredIdx = hasValidResultIndex ? resultIndex : idx
    const candidateSlice = stmtSlices[preferredIdx]
    const matchingSlice =
      candidateSlice &&
      (stmtSlices.length === totalSets ||
        normStmt(candidateSlice.text) === targetNorm ||
        !targetNorm ||
        (hasValidResultIndex && normStmt(execRange.sql) === targetNorm))
        ? candidateSlice
        : null
    if (matchingSlice) {
      return {
        from: execRange.from + matchingSlice.start,
        to: execRange.from + matchingSlice.end,
        originalSlice: execRange.sql.slice(matchingSlice.start, matchingSlice.end),
        statementIndex: preferredIdx,
        totalStatements: stmtSlices.length,
        preserveOtherStatements: stmtSlices.length > 1,
      }
    }
    if (totalSets === 1 && stmtSlices.length === 1 && stmtSlices[0]) {
      const onlySlice = stmtSlices[0]
      return {
        from: execRange.from + onlySlice.start,
        to: execRange.from + onlySlice.end,
        originalSlice: execRange.sql.slice(onlySlice.start, onlySlice.end),
        statementIndex: 0,
        totalStatements: 1,
        preserveOtherStatements: true,
      }
    }
    if (totalSets === 1 && stmtSlices.length === 0) {
      return {
        from: execRange.from,
        to: execRange.to,
        originalSlice: execRange.originalSlice,
        statementIndex: 0,
        totalStatements: 1,
        preserveOtherStatements: true,
      }
    }
    return null
  }

  private attachFixTargetsToResultStates(
    states: Record<number, ResultSetTabRuntimeState>,
    res: QueryResult,
    overallSql: string,
    driver: DatabaseDriverType,
    execRange: SqlExecutionRange | null
  ): void {
    const sets = getEffectiveResultSets(res, overallSql)
    const stmtSlices =
      driver === 'redis'
        ? []
        : splitSqlStatements(execRange ? execRange.sql : overallSql, driver)
    const execErrIdx =
      typeof res.executionError?.failedStatementIndex === 'number' &&
      Number.isInteger(res.executionError.failedStatementIndex) &&
      res.executionError.failedStatementIndex >= 0
        ? res.executionError.failedStatementIndex
        : null
    const execErrStmtCount =
      typeof res.executionError?.statementCount === 'number' &&
      Number.isInteger(res.executionError.statementCount) &&
      res.executionError.statementCount > 0
        ? res.executionError.statementCount
        : null
    sets.forEach((rs, idx) => {
      const st = states[idx]
      if (!st?.banner || st.banner.kind !== 'error') return
      let failedSql = (st.statementSql || rs.sql || overallSql).trim()
      if (!failedSql) return
      const errMsg = rs.errorMessage || st.banner.errorText || st.banner.detail || ''
      let fixTargetRange: SqlFixTargetRange | null
      if (sets.length === 1 && stmtSlices.length > 1) {
        const resolved = resolveExecutionErrorFixTarget(
          execRange,
          failedSql,
          errMsg,
          stmtSlices,
          driver,
          execErrIdx,
          execErrStmtCount
        )
        failedSql = resolved.failedSql
        fixTargetRange = resolved.fixTargetRange
      } else {
        fixTargetRange = this.resolveResultStatementRange(
          failedSql,
          idx,
          sets.length,
          stmtSlices,
          execRange,
          rs.index
        )
        if (
          fixTargetRange &&
          typeof fixTargetRange.statementIndex === 'number' &&
          stmtSlices[fixTargetRange.statementIndex]
        ) {
          failedSql = stmtSlices[fixTargetRange.statementIndex].text.trim() || failedSql
        }
      }
      st.banner = {
        ...st.banner,
        failedSql,
        fixTargetRange,
      }
    })
  }

  private attachExplainTargetsToResultStates(
    states: Record<number, ResultSetTabRuntimeState>,
    res: QueryResult,
    overallSql: string,
    driver: DatabaseDriverType,
    execRange: SqlExecutionRange | null
  ): void {
    const sets = getEffectiveResultSets(res, overallSql)
    const stmtSlices =
      execRange && driver !== 'redis' ? splitSqlStatements(execRange.sql, driver) : []
    sets.forEach((rs, idx) => {
      const st = states[idx]
      if (!st) return
      const stmtSql = (st.statementSql || rs.sql || overallSql).trim()
      if (!stmtSql) return
      st.explainTargetRange = this.resolveResultStatementRange(
        stmtSql,
        idx,
        sets.length,
        stmtSlices,
        execRange,
        rs.index
      )
    })
  }

  private dismissActiveQueryBanner(): void {
    if (this.activeResultBannerState) {
      this.activeResultBannerState = { ...this.activeResultBannerState, dismissed: true }
      if (this.isShowingSqlResult) {
        const curState = this.consoleTabs.getResultTabState(this.activeResultSetIndex)
        if (curState) {
          this.consoleTabs.setResultTabState(this.activeResultSetIndex, {
            ...curState,
            banner: { ...this.activeResultBannerState },
          })
        }
      }
    }
    this.clearAiFixPanel()
    this.setQueryBannerVisible(false)
  }

  private showQueryBanner(
    kind: 'success' | 'error',
    title: string,
    detail = '',
    opts?: {
      onRetry?: () => void
      retryLabel?: string
      showBackToTable?: boolean
      isExplain?: boolean
      failedSql?: string
      fixTargetRange?: SqlFixTargetRange | null
      connectionId?: string | null
      source?: ResultBannerState['source']
    }
  ): void {
    this.clearAiFixPanel()
    const resolvedConnId = opts?.connectionId ?? this.activeConnectionId
    const resolvedTitle =
      kind === 'error' ? this.formatStudioBannerTitle(title, resolvedConnId) : title
    const tlsRemedy = kind === 'error' && this.isActionableTlsErrorText(detail || title)
    const banner: ResultBannerState = {
      kind,
      title: resolvedTitle,
      detail,
      dismissed: false,
      showBackToTable: opts?.showBackToTable,
      errorText: kind === 'error' ? detail || resolvedTitle : undefined,
      isExplain: opts?.isExplain,
      failedSql: opts?.failedSql,
      fixTargetRange: opts?.fixTargetRange ?? null,
      source: opts?.source,
      connectionId: resolvedConnId,
      tlsRemedy,
    }
    this.activeResultBannerState = banner
    this.queryBannerRetryHandler = opts?.onRetry ?? null
    this.queryBannerRetryLabel = opts?.retryLabel || 'Retry'
    if (!this.queryBannerEl || !this.queryBannerTitleEl || !this.queryBannerDetailEl) return
    this.renderQueryBannerDom(banner, opts?.onRetry ?? null)
    this.setQueryBannerVisible(this.shouldShowActiveBannerInViewMode())
  }

  private hideQueryBanner(): void {
    this.activeResultBannerState = null
    this.lastQueryErrorText = ''
    this.queryBannerRetryHandler = null
    this.queryBannerRetryLabel = 'Retry'
    this.queryBannerEditConnHandler = null
    if (this.queryBannerFixAiBtn) {
      this.queryBannerFixAiBtn.style.display = 'none'
    }
    if (this.queryBannerReportBtn) {
      this.queryBannerReportBtn.style.display = 'none'
    }
    if (this.queryBannerRetryBtn) {
      this.queryBannerRetryBtn.style.display = 'none'
    }
    if (this.queryBannerEditConnBtn) {
      this.queryBannerEditConnBtn.style.display = 'none'
    }
    if (this.queryBannerBackBtn) {
      this.queryBannerBackBtn.style.display = 'none'
    }
    this.clearAiFixPanel()
    this.setQueryBannerVisible(false)
  }

  private async applyServerFilters(): Promise<void> {
    if (this.isShowingSqlResult) {
      if (!this.activeConnectionId) {
        this.updateStatus('Select an active connection first')
        return
      }
      const driver = this.getActiveConnection()?.driver || 'sqlite'
      let sanitizedWhere: string | undefined
      let sanitizedOrderBy: string | undefined
      try {
        sanitizedWhere = sanitizeFilterClause(this.whereInputEl?.value, driver)
        sanitizedOrderBy = sanitizeFilterClause(this.orderByInputEl?.value, driver)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        this.showQueryBanner('error', 'Invalid Filter Clause', msg)
        this.updateStatus(msg)
        return
      }
      const curState = this.consoleTabs.getResultTabState(this.activeResultSetIndex)
      if (curState) {
        curState.whereClause = sanitizedWhere || ''
        curState.orderByClause = sanitizedOrderBy || ''
        this.consoleTabs.setResultTabState(this.activeResultSetIndex, curState)
      }
      const rs = this.activeQueryResult?.resultSets?.[this.activeResultSetIndex]
      const baseSql = (curState?.baseStatementSql || this.activeExecutedSql || '').trim()
      const cleanBase = baseSql.replace(/;+\s*$/, '').trim()
      const isExplainTab = Boolean(curState?.banner?.isExplain)
      const isMssqlCte = driver === 'mssql' && /^\s*WITH\b/i.test(cleanBase)
      if (isMssqlCte && (sanitizedWhere || sanitizedOrderBy)) {
        this.updateStatus(
          'Server WHERE / ORDER BY cannot wrap MSSQL WITH CTEs — filter inside the query or use client filter'
        )
        return
      }
      const canWrapSelect =
        !isExplainTab &&
        (rs ? rs.isSelect : Boolean(this.activeQueryResult?.isSelect)) &&
        /^\s*(?:WITH\b|SELECT\b)/i.test(cleanBase) &&
        driver !== 'redis'
      if (!canWrapSelect || !cleanBase) {
        if (!sanitizedWhere && !sanitizedOrderBy) {
          this.updateStatus('Cleared WHERE / ORDER BY for current result tab')
        } else {
          this.updateStatus('Server WHERE / ORDER BY filter only applies to SELECT result tabs')
        }
        return
      }
      const subqueryAlias = driver === 'oracle' ? '_datanoa_filter' : 'AS _datanoa_filter'
      const filteredSql =
        !sanitizedWhere && !sanitizedOrderBy
          ? cleanBase
          : `SELECT * FROM (${cleanBase}) ${subqueryAlias}${sanitizedWhere ? ` WHERE ${sanitizedWhere}` : ''}${sanitizedOrderBy ? ` ORDER BY ${sanitizedOrderBy}` : ''}`
      await this.refreshSingleResultSet(
        this.consoleTabs.getActiveTabId(),
        this.activeResultSetIndex,
        this.activeConnectionId,
        filteredSql,
        {
          preserveWhere: sanitizedWhere || '',
          preserveOrderBy: sanitizedOrderBy || '',
          preserveSearchMode: this.searchMode,
          preserveClientSearch: this.clientSearchEl?.value || '',
        }
      )
      return
    }
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
    if (this.whereInputEl) this.whereInputEl.value = ''
    if (this.orderByInputEl) this.orderByInputEl.value = ''
    if (this.clientSearchEl) this.clientSearchEl.value = ''
    this.dataGrid?.setClientFilter('')
    this.dataGrid?.setFindQuery('')
    this.updateFindCounter({ total: 0, activeIndex: -1 })
    this.dataGrid?.clearClientColumnFilters()
    this.dataGrid?.clearSortIndicator()
    if (this.isShowingSqlResult) {
      const curState = this.consoleTabs.getResultTabState(this.activeResultSetIndex)
      const hadServerFilter = Boolean(curState?.whereClause || curState?.orderByClause)
      if (curState) {
        curState.whereClause = ''
        curState.orderByClause = ''
        curState.clientSearchText = ''
        curState.statementSql = curState.baseStatementSql
        this.consoleTabs.setResultTabState(this.activeResultSetIndex, curState)
      }
      if (hadServerFilter && curState?.baseStatementSql && this.activeConnectionId) {
        await this.refreshSingleResultSet(
          this.consoleTabs.getActiveTabId(),
          this.activeResultSetIndex,
          this.activeConnectionId,
          curState.baseStatementSql,
          {
            preserveWhere: '',
            preserveOrderBy: '',
            preserveSearchMode: this.searchMode,
            preserveClientSearch: '',
          }
        )
        return
      }
      this.captureActiveResultTabState()
      this.updateStatus('Cleared filters for current result tab')
      return
    }
    this.activeWhereClause = undefined
    this.activeOrderByClause = undefined
    if (this.activeConnectionId && this.activeTable) {
      await this.loadTableData(this.activeConnectionId, this.activeTable, 1)
    } else {
      this.updateStatus('Cleared column filters')
    }
  }

  private getCurrentTableConfigKey(): string {
    return buildStudioTableKey(
      this.activeConnectionId || '',
      this.activeSchema,
      this.activeTable || ''
    )
  }

  private async loadTableData(
    connectionId: string,
    table: string,
    page: number,
    sort?: { column: string; direction: 'ASC' | 'DESC' },
    silent = false
  ): Promise<void> {
    if (typeof window === 'undefined' || !window.orca?.plugin?.request || this.isDestroyed) return
    const targetSchema = this.activeSchema
    const targetTableKey = buildStudioTableKey(connectionId, targetSchema, table)
    const isSameTable = this.lastLoadedTableKey === targetTableKey
    const preservedScrollLeft = isSameTable ? (this.dataGrid?.getScrollLeft() ?? 0) : 0
    const viewSeq = ++this.gridViewSeq
    const loadToken = ++this.tableLoadToken
    const startImportSeq = this.stagedImportSeq
    const initialStagedCount = isSameTable ? (this.dataGrid?.getStagedCount?.() ?? 0) : 0
    this.isTableLoading = true
    this.updatePaginationButtons()
    try {
      const wasShowingSqlResult = this.isShowingSqlResult
      this.isShowingSqlResult = false
      if (!isSameTable) {
        this.loadedDataTableKey = null
      }
      this.activeQueryResult = null
      this.activeResultSetIndex = 0
      this.editableSqlTarget = null
      if (wasShowingSqlResult) {
        if (this.whereInputEl) this.whereInputEl.value = this.activeWhereClause || ''
        if (this.orderByInputEl) this.orderByInputEl.value = this.activeOrderByClause || ''
        if (this.clientSearchEl) this.clientSearchEl.value = ''
        this.dataGrid?.setClientFilter('')
        this.dataGrid?.setFindQuery('')
        this.updateFindCounter({ total: 0, activeIndex: -1 })
        this.dataGrid?.clearClientColumnFilters()
        this.dataGrid?.clearSortIndicator()
      }
      this.hideResultSetsBar()
      this.hideQueryBanner()
      this.renderExplainAiForActiveTab()
      if (!silent) {
        this.updateStatus(`Loading ${table}...`)
        if (this.gridSubbarTitleEl) {
          this.gridSubbarTitleEl.textContent = `Loading ${table}...`
        }
        this.dataGrid?.setLoading(true, `Loading ${table}...`)
      }
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
      const activeKind = this.findActiveSchemaObject()?.kind
      this.currentCanEdit =
        Boolean(pageData.canEdit) && !readOnly && activeKind !== 'materialized_view'

      this.currentPage = pageData.page || page
      this.totalRows = pageData.totalRows || 0
      this.currentPageRowCount = Array.isArray(pageData.rows) ? pageData.rows.length : 0
      if (this.pageSizeSelectEl) {
        this.pageSizeSelectEl.value = String(this.pageSize)
      }
      this.dataGrid?.setContextMeta(table, conn?.driver || 'sqlite', connectionId, targetSchema || '')
      const cachedKey = buildStudioTableKey(connectionId, targetSchema, table)
      const legacyCachedKey = canUseLegacyStudioTableKeyFallback(connectionId, targetSchema, table)
        ? buildLegacyStudioTableKey(connectionId, targetSchema, table)
        : null
      const cachedDetails =
        this.tableDetailsCache.get(cachedKey) ??
        (legacyCachedKey ? this.tableDetailsCache.get(legacyCachedKey) : undefined)
      this.dataGrid?.setForeignKeys(cachedDetails?.foreignKeys || [])

      const savedColCfg =
        this.columnConfigByTable[cachedKey] ??
        (legacyCachedKey ? this.columnConfigByTable[legacyCachedKey] : undefined)
      this.dataGrid?.setColumnConfig(savedColCfg ? { ...savedColCfg } : { hidden: [], pinned: [] })

      this.dataGrid?.setEmptyMessage(
        this.activeWhereClause
          ? `No rows in "${table}" match the current WHERE filter.`
          : `Table "${table}" has no rows.`
      )
      const isUnchangedSilentPayload = Boolean(
        silent &&
          isSameTable &&
          this.lastPageData &&
          this.lastPageData.totalRows === pageData.totalRows &&
          this.lastPageData.page === pageData.page &&
          this.lastPageData.pageSize === pageData.pageSize &&
          this.lastPageData.rows.length === pageData.rows.length &&
          JSON.stringify(this.lastPageData.columns) === JSON.stringify(pageData.columns) &&
          JSON.stringify(this.lastPageData.rows) === JSON.stringify(pageData.rows)
      )
      if (!isUnchangedSilentPayload) {
        const preserveStagedDeltas =
          this.loadedDataTableKey === targetTableKey &&
          (this.stagedImportSeq !== startImportSeq ||
            this.activeImportModalKey === targetTableKey ||
            (silent && initialStagedCount > 0))
        this.dataGrid?.setData(
          {
            ...pageData,
            canEdit: this.currentCanEdit,
          },
          preserveStagedDeltas ? { preserveStagedDeltas: true } : undefined
        )
      }
      if (!silent || this.currentTableDisplayKey !== cachedKey) {
        void this.hydrateTableDisplayState(cachedKey)
      }
      this.lastPageData = pageData
      this.lastLoadedTableKey = targetTableKey
      this.loadedDataTableKey = targetTableKey
      if (this.pendingScrollState) {
        this.consumePendingScrollState()
      } else if (isSameTable && preservedScrollLeft > 0) {
        this.dataGrid?.setScrollLeft(preservedScrollLeft)
      }
      if (this.dmlPreviewEl) this.dmlPreviewEl.style.display = 'none'

      const totalPages = Math.max(1, Math.ceil(this.totalRows / this.pageSize))
      this.currentColCount = pageData.columns.length
      this.currentMetricsTruncated = Boolean(pageData.truncated)
      if (this.gridSubbarTitleEl) {
        this.gridSubbarTitleEl.textContent = readOnly
          ? `${table} · RO`
          : table
      }
      if (this.gridPageInfoEl) {
        this.gridPageInfoEl.textContent = `Page ${this.currentPage} / ${totalPages} (${this.totalRows} rows${this.currentMetricsTruncated ? ' · truncated' : ''})`
      }
      this.updateStagedActionButtons(this.dataGrid?.getStagedCount?.() ?? 0)
      this.updatePaginationButtons()
      this.updateExportDropdownOptions()
      this.saveStudioViewState(true)
      this.saveStudioDataCache()
      if (this.activeViewMode !== 'er') {
        this.updateStatus(
          this.currentMetricsTruncated ? `Loaded ${table} (truncated)` : `Loaded ${table}`,
          formatGridStatusMetrics(this.totalRows, this.currentColCount, {
            truncated: this.currentMetricsTruncated,
          })
        )
      }

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
      this.loadedDataTableKey = null
      this.currentColCount = 0
      this.currentMetricsTruncated = false
      const msg = err instanceof Error ? err.message : String(err)
      const connLabel = this.formatConnectionLabel(connectionId)
      if (this.gridSubbarTitleEl) {
        this.gridSubbarTitleEl.textContent = `${table} · Error`
      }
      this.dataGrid?.setEmptyMessage(`Error loading ${table}${connLabel ? ` (${connLabel})` : ''}: ${msg}`)
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
        connectionId,
        onRetry: () => {
          void this.loadTableData(connectionId, table, page, sort)
        },
      })
      this.updatePaginationButtons()
      if (this.activeViewMode !== 'er') {
        this.updateStatus(`Error loading ${table}${connLabel ? ` (${connLabel})` : ''}: ${msg}`, '0 rows')
      }
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
    if (
      this.activeSchema &&
      this.availableSchemas.length > 0 &&
      !this.availableSchemas.includes(this.activeSchema)
    ) {
      this.activeSchema = this.selectedSchema || this.defaultSchema || undefined
    }
    const targetSchema = this.activeSchema
    if (!this.activeObjectKind) {
      const found = this.schemaObjects.find(
        (o) => o.name === tableName && (o.schema || '') === (targetSchema || '')
      )
      if (found) this.activeObjectKind = found.kind
    }
    if (this.activeObjectKind === 'materialized_view') {
      const obj =
        this.activeReadOnlyObject?.kind === 'materialized_view'
          ? this.activeReadOnlyObject
          : this.schemaObjects.find(
              (o) =>
                o.name === tableName &&
                o.kind === 'materialized_view' &&
                (o.schema || '') === (targetSchema || '')
            )
      if (obj) {
        await this.loadReadOnlyObjectDdl(obj)
        return
      }
    }
    const targetKey = this.inspectorKey()
    if (!force && this.lastInspectorLoadedKey === targetKey) return

    const detailsCacheKey = buildStudioTableKey(connId, targetSchema, tableName)
    const cached = !force ? this.tableDetailsCache.get(detailsCacheKey) : undefined
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
      this.lastInspectorLoadedKey = this.inspectorKey()
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
      this.lastInspectorLoadedKey = this.inspectorKey()
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
    this.updateTransactionToolbar()
  }

  private buildTransactionToolbar(parent: HTMLElement): void {
    this.txToolbar.mount(parent)
  }

  private async refreshTransactionState(connectionId?: string): Promise<void> {
    await this.txToolbar.refreshState(connectionId)
  }

  private updateTransactionToolbar(): void {
    this.txToolbar.updateToolbar()
  }

  private renderConsoleTabs(): void {
    const bar = this.consoleTabsBarEl
    if (!bar) return
    bar.setAttribute('role', 'tablist')
    bar.innerHTML = ''
    const tabs = this.consoleTabs.getTabs()
    const activeId = this.consoleTabs.getActiveTabId()
    let activeTabEl: HTMLDivElement | null = null
    for (const tab of tabs) {
      const isActive = tab.id === activeId
      const tabEl = document.createElement('div')
      tabEl.className = `datanoa-console-tab${isActive ? ' active' : ''}`
      tabEl.title = tab.title
      tabEl.setAttribute('role', 'tab')
      tabEl.setAttribute('aria-selected', String(isActive))
      tabEl.setAttribute('tabindex', isActive ? '0' : '-1')
      if (isActive) activeTabEl = tabEl
      tabEl.addEventListener('click', () => {
        this.switchConsoleTab(tab.id)
      })
      tabEl.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          this.switchConsoleTab(tab.id)
        } else if (e.key === 'F2') {
          e.preventDefault()
          if (isActive) {
            this.beginConsoleTabRename(tabEl, tab)
          } else {
            this.switchConsoleTab(tab.id)
            this.beginConsoleTabRenameById(tab.id)
          }
        }
      })
      const titleEl = document.createElement('span')
      titleEl.className = 'datanoa-console-tab-title'
      titleEl.textContent = tab.title
      titleEl.addEventListener('dblclick', (e: MouseEvent) => {
        e.stopPropagation()
        this.beginConsoleTabRename(tabEl, tab)
      })
      tabEl.appendChild(titleEl)

      const closeBtn = document.createElement('button')
      closeBtn.type = 'button'
      closeBtn.className = 'datanoa-console-tab-close'
      closeBtn.textContent = '×'
      closeBtn.setAttribute('aria-label', 'Close tab')
      closeBtn.addEventListener('click', (e: MouseEvent) => {
        e.stopPropagation()
        this.closeConsoleTab(tab.id)
      })
      tabEl.appendChild(closeBtn)
      bar.appendChild(tabEl)
    }

    const addBtn = document.createElement('button')
    addBtn.type = 'button'
    addBtn.className = 'datanoa-console-tab-add'
    addBtn.textContent = '+'
    addBtn.title = 'New SQL Console Tab'
    addBtn.setAttribute('aria-label', 'New SQL Console Tab')
    addBtn.addEventListener('click', () => {
      this.addConsoleTab()
    })
    bar.appendChild(addBtn)
    activeTabEl?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' })
  }

  private beginConsoleTabRenameById(tabId: string): void {
    const tabs = this.consoleTabs.getTabs()
    const idx = tabs.findIndex((t) => t.id === tabId)
    if (idx < 0) return
    const tabEls = this.consoleTabsBarEl?.querySelectorAll('.datanoa-console-tab')
    const tabEl = tabEls?.[idx] as HTMLElement | undefined
    const tab = tabs[idx]
    if (tabEl && tab) {
      this.beginConsoleTabRename(tabEl, tab)
    }
  }

  private beginConsoleTabRename(tabEl: HTMLElement, tab: SqlConsoleTabState): void {
    let done = false
    tabEl.innerHTML = ''
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'datanoa-console-tab-rename'
    input.value = tab.title
    const finish = (commit: boolean): void => {
      if (done) return
      done = true
      if (commit) {
        this.consoleTabs.renameTab(tab.id, input.value)
        this.saveStudioViewState(false)
      }
      this.renderConsoleTabs()
    }
    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        finish(true)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        finish(false)
      }
    })
    input.addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation()
    })
    input.addEventListener('mousedown', (e: MouseEvent) => {
      e.stopPropagation()
    })
    input.addEventListener('blur', () => {
      finish(true)
    })
    tabEl.appendChild(input)
    input.focus()
    input.select()
  }

  private loadActiveConsoleTab(): void {
    const tab = this.consoleTabs.getActiveTab()
    this.suppressDocSync = true
    try {
      this.sqlConsole?.setText(tab.sql)
      this.sqlConsole?.setCursorOffset?.(tab.cursorOffset ?? 0)
    } finally {
      this.suppressDocSync = false
    }
    this.renderConsoleTabs()
  }

  private saveActiveConsoleTabState(): void {
    const current = this.sqlConsole?.getText()
    if (current !== undefined) {
      this.consoleTabs.updateActiveSql(current, this.sqlConsole?.getCursorOffset?.())
    }
  }

  private clearSqlResultViewForEmptyTab(): void {
    this.loadedDataTableKey = null
    this.activeQueryResult = null
    this.activeResultSetIndex = 0
    this.activeExecutedSql = ''
    this.activeEditableStmtSql = ''
    this.editableSqlTarget = null
    this.currentCanEdit = false
    if (this.whereInputEl) this.whereInputEl.value = ''
    if (this.orderByInputEl) this.orderByInputEl.value = ''
    if (this.clientSearchEl) this.clientSearchEl.value = ''
    this.syncSearchModeUiOnly('filter')
    this.dataGrid?.setClientFilter('')
    this.dataGrid?.setFindQuery('')
    this.updateFindCounter({ total: 0, activeIndex: -1 })
    this.dataGrid?.clearClientColumnFilters()
    this.dataGrid?.clearSortIndicator()
    this.hideQueryBanner()
    this.hideResultSetsBar()
    this.renderExplainAiForActiveTab()
    this.dataGrid?.setEmptyMessage('Run a query in this tab to see results.')
    this.dataGrid?.setData({
      columns: [],
      rows: [],
      rowCount: 0,
      executionTimeMs: 0,
      truncated: false,
      isSelect: true,
    })
    this.updateStagedActionButtons(0)
    this.currentColCount = 0
    this.currentMetricsTruncated = false
    if (this.gridSubbarTitleEl) {
      this.gridSubbarTitleEl.textContent = 'SQL Result'
    }
    if (this.gridPageInfoEl) {
      this.gridPageInfoEl.textContent = '0 rows'
    }
    if (this.statusMetricsEl) {
      this.statusMetricsEl.textContent = '0 rows'
    }
  }

  private switchConsoleTab(tabId: string): void {
    if (tabId === this.consoleTabs.getActiveTabId()) return
    this.clearAiFixPanel()
    this.sqlConsole?.clearDbSyntaxError?.()
    this.captureActiveResultTabState()
    this.saveActiveConsoleTabState()
    if (!this.consoleTabs.switchTab(tabId)) return
    this.loadActiveConsoleTab()
    this.restoreConsoleTabResult()
    this.saveStudioViewState(false)
  }

  private addConsoleTab(): void {
    this.clearAiFixPanel()
    this.sqlConsole?.clearDbSyntaxError?.()
    this.captureActiveResultTabState()
    this.saveActiveConsoleTabState()
    this.consoleTabs.addTab('')
    this.loadActiveConsoleTab()
    if (this.isShowingSqlResult) {
      this.clearSqlResultViewForEmptyTab()
    }
    this.saveStudioViewState(false)
    this.sqlConsole?.focus()
  }

  private closeConsoleTab(tabId: string): void {
    this.clearAiFixPanel()
    this.sqlConsole?.clearDbSyntaxError?.()
    this.captureActiveResultTabState()
    this.saveActiveConsoleTabState()
    if (!this.consoleTabs.closeTab(tabId)) return
    this.loadActiveConsoleTab()
    this.restoreConsoleTabResult()
    this.saveStudioViewState(false)
  }

  private syncSearchModeUiOnly(mode: 'filter' | 'find'): void {
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
  }

  private captureActiveResultTabState(): void {
    if (!this.isShowingSqlResult || !this.activeQueryResult) return
    const idx = this.activeResultSetIndex
    const existing = this.consoleTabs.getResultTabState(idx)
    const fallbackStmt =
      existing?.statementSql ||
      this.activeQueryResult.resultSets?.[idx]?.sql ||
      this.activeQueryResult.resultSets?.[idx]?.sqlPreview ||
      this.activeExecutedSql ||
      ''
    const nextState: ResultSetTabRuntimeState = {
      resultSetIndex: idx,
      baseStatementSql: existing?.baseStatementSql || fallbackStmt,
      statementSql: existing?.statementSql || fallbackStmt,
      banner: this.activeResultBannerState ? { ...this.activeResultBannerState } : existing?.banner ?? null,
      whereClause: this.whereInputEl?.value ?? existing?.whereClause ?? '',
      orderByClause: this.orderByInputEl?.value ?? existing?.orderByClause ?? '',
      searchMode: this.searchMode,
      clientSearchText: this.clientSearchEl?.value ?? existing?.clientSearchText ?? '',
      gridSnapshot: this.dataGrid?.exportRuntimeState() ?? existing?.gridSnapshot ?? null,
      editableSqlTarget: this.editableSqlTarget ? { ...this.editableSqlTarget } : null,
      activeEditableStmtSql: this.activeEditableStmtSql,
      currentCanEdit: this.currentCanEdit,
      gridSubbarTitle: this.gridSubbarTitleEl?.textContent ?? existing?.gridSubbarTitle ?? 'SQL Result',
      gridPageInfo: this.gridPageInfoEl?.textContent ?? existing?.gridPageInfo ?? '0 rows',
      emptyMessage: existing?.emptyMessage ?? 'Query returned no rows.',
      explainTargetRange: existing?.explainTargetRange ?? null,
      explainAnalysis: existing?.explainAnalysis ?? null,
      explainAnalysisError: existing?.explainAnalysisError ?? null,
      explainAnalysisCollapsed: existing?.explainAnalysisCollapsed ?? false,
      aiFixResult: existing?.aiFixResult ?? null,
      aiFixError: existing?.aiFixError ?? null,
    }
    this.consoleTabs.setResultTabState(idx, nextState)
  }

  private applyResultTabState(
    index: number,
    tab: SqlConsoleTabState,
    opts?: { preserveScroll?: boolean }
  ): void {
    this.loadedDataTableKey = null
    this.clearAiFixPanel()
    const res = tab.lastResult
    if (!res) return
    const sets = getEffectiveResultSets(res, tab.executedSql || '')
    const rs = sets[index]
    if (!rs) return
    const existingState =
      tab.resultStates?.[index] ??
      buildInitialResultTabStates(
        res,
        [],
        tab.executedSql || '',
        res.executionTimeMs || 0,
        tab.lastResultMode ?? 'query'
      )[index]
    if (existingState?.banner?.kind === 'error' && !existingState.banner.failedSql) {
      const fallbackFailedSql = (existingState.statementSql || rs.sql || tab.executedSql || '').trim()
      if (fallbackFailedSql) {
        existingState.banner = { ...existingState.banner, failedSql: fallbackFailedSql }
      }
    }
    if (!tab.resultStates?.[index] && existingState) {
      this.consoleTabs.setResultTabState(index, existingState, tab.id)
    }

    this.activeResultSetIndex = index
    this.consoleTabs.setActiveResultSetIndex(index)
    this.activeExecutedSql = tab.executedSql || existingState?.statementSql || ''
    if (this.dmlPreviewEl) this.dmlPreviewEl.style.display = 'none'

    if (this.whereInputEl) this.whereInputEl.value = existingState?.whereClause ?? ''
    if (this.orderByInputEl) this.orderByInputEl.value = existingState?.orderByClause ?? ''
    if (this.clientSearchEl) this.clientSearchEl.value = existingState?.clientSearchText ?? ''
    this.syncSearchModeUiOnly(existingState?.searchMode ?? 'filter')

    const isSameConnection = Boolean(
      tab.executedConnectionId &&
      this.activeConnectionId &&
      tab.executedConnectionId === this.activeConnectionId
    )
    const isActiveReadOnly = this.isActiveConnectionReadOnly()

    if (existingState?.gridSnapshot) {
      const snap = existingState.gridSnapshot
      const snapOriginConnId =
        existingState.editableSqlTarget?.originConnectionId ||
        snap.originConnectionId ||
        snap.connectionId ||
        tab.executedConnectionId ||
        ''
      const allowSnapshotEdit = Boolean(
        isSameConnection &&
          !isActiveReadOnly &&
          snapOriginConnId &&
          snapOriginConnId === this.activeConnectionId &&
          existingState.currentCanEdit &&
          existingState.editableSqlTarget
      )
      this.editableSqlTarget = allowSnapshotEdit && existingState.editableSqlTarget
        ? { ...existingState.editableSqlTarget }
        : null
      this.activeEditableStmtSql = allowSnapshotEdit ? existingState.activeEditableStmtSql || '' : ''
      this.currentCanEdit = allowSnapshotEdit
      const guardedSnap =
        !allowSnapshotEdit && snap.model?.canEdit
          ? { ...snap, model: { ...snap.model, canEdit: false } }
          : snap
      this.dataGrid?.restoreRuntimeState(guardedSnap)
      this.updateFindCounter(this.dataGrid?.getFindState())
      if (this.gridSubbarTitleEl) {
        if (!isSameConnection && !existingState.banner?.isExplain && !rs.isError && tab.executedConnectionId) {
          this.gridSubbarTitleEl.textContent =
            sets.length > 1
              ? `Result ${index + 1} · Read-only (another connection)`
              : 'SQL Result · Read-only (another connection)'
        } else {
          this.gridSubbarTitleEl.textContent = existingState.gridSubbarTitle || 'SQL Result'
        }
      }
      if (this.gridPageInfoEl) {
        this.gridPageInfoEl.textContent = existingState.gridPageInfo || '0 rows'
      }
      this.currentPage = 1
      this.currentPageRowCount = existingState.gridSnapshot.model?.rows.length ?? rs.rows.length
      this.totalRows = rs.rowCount
      this.currentColCount = rs.isError || !rs.isSelect
        ? 0
        : (existingState.gridSnapshot.model?.headers.length ?? rs.columns?.length ?? 0)
      this.currentMetricsTruncated = Boolean(!rs.isError && rs.isSelect && rs.truncated)
      this.updatePaginationButtons()
      this.updateExportDropdownOptions()
      this.updateStagedActionButtons(this.dataGrid?.getStagedCount?.() ?? 0)
      if (this.statusMetricsEl && !this.editableSqlTarget) {
        this.statusMetricsEl.textContent = formatGridStatusMetrics(
          rs.isError ? 0 : rs.isSelect ? this.totalRows : (rs.affectedRows ?? 0),
          this.currentColCount,
          {
            truncated: this.currentMetricsTruncated,
            unit: !rs.isError && !rs.isSelect ? 'affected' : 'row',
          }
        )
      }
      this.renderResultSetsBar()
      this.activeResultBannerState = existingState.banner ? { ...existingState.banner } : null
      this.syncQueryBannerForViewMode()
      return
    }

    this.editableSqlTarget = null
    this.activeEditableStmtSql = ''
    this.currentCanEdit = false
    this.dataGrid?.setClientFilter('')
    this.dataGrid?.setFindQuery('')
    this.updateFindCounter({ total: 0, activeIndex: -1 })
    this.dataGrid?.clearClientColumnFilters()
    this.dataGrid?.clearSortIndicator()
    this.dataGrid?.setForeignKeys([])
    this.dataGrid?.setEmptyMessage(existingState?.emptyMessage || 'Query returned no rows.')

    const isExplain = Boolean(existingState?.banner?.isExplain)

    this.currentPage = 1
    this.currentPageRowCount = rs.isError ? 0 : rs.rows.length
    this.totalRows = rs.isError ? 0 : rs.rowCount
    this.currentColCount = rs.isError || !rs.isSelect ? 0 : (rs.columns?.length ?? 0)
    this.currentMetricsTruncated = Boolean(!rs.isError && rs.isSelect && rs.truncated)

    if (rs.isError) {
      this.dataGrid?.setData({
        columns: [],
        rows: [],
        rowCount: 0,
        executionTimeMs: 0,
        truncated: false,
        isSelect: true,
      })
    } else if (!isExplain && rs.isSelect && this.activeConnectionId && isSameConnection) {
      this.applySqlResultEditability(
        res,
        index,
        this.activeConnectionId,
        tab.id,
        this.querySeq
      )
    } else {
      this.dataGrid?.setData(buildResultSetQueryResult(res, index))
    }

    if (this.gridSubbarTitleEl && !this.editableSqlTarget) {
      if (!isSameConnection && !isExplain && !rs.isError && tab.executedConnectionId) {
        this.gridSubbarTitleEl.textContent =
          sets.length > 1
            ? `Result ${index + 1} · Read-only (another connection)`
            : 'SQL Result · Read-only (another connection)'
      } else if (existingState?.gridSubbarTitle) {
        this.gridSubbarTitleEl.textContent = existingState.gridSubbarTitle
      }
    }
    if (this.gridPageInfoEl && existingState?.gridPageInfo) {
      this.gridPageInfoEl.textContent = existingState.gridPageInfo
    }

    this.updatePaginationButtons()
    this.updateExportDropdownOptions()
    this.updateStagedActionButtons(this.dataGrid?.getStagedCount?.() ?? 0)
    if (this.statusMetricsEl && !this.editableSqlTarget) {
      this.statusMetricsEl.textContent = formatGridStatusMetrics(
        rs.isError ? 0 : rs.isSelect ? this.totalRows : (rs.affectedRows ?? 0),
        this.currentColCount,
        {
          truncated: this.currentMetricsTruncated,
          unit: !rs.isError && !rs.isSelect ? 'affected' : 'row',
        }
      )
    }
    this.renderResultSetsBar()
    this.activeResultBannerState = existingState?.banner ? { ...existingState.banner } : null
    this.syncQueryBannerForViewMode()
    if (!opts?.preserveScroll) {
      this.captureActiveResultTabState()
    }
  }

  private restoreConsoleTabResult(): void {
    if (!this.isShowingSqlResult) return
    this.editableSqlTarget = null
    this.currentCanEdit = false
    this.activeEditableStmtSql = ''
    const tab = this.consoleTabs.getActiveTab()
    this.activeExecutedSql = tab.executedSql || ''
    if (!tab.lastResult) {
      this.clearSqlResultViewForEmptyTab()
      return
    }
    this.activeQueryResult = tab.lastResult
    const sets = getEffectiveResultSets(tab.lastResult, tab.executedSql || '')
    const clampedIndex = Math.max(0, Math.min(tab.activeResultSetIndex || 0, Math.max(0, sets.length - 1)))
    this.applyResultTabState(clampedIndex, tab)
  }

  private applyActiveQueryResult(res: QueryResult, defaultIndex?: number): void {
    this.loadedDataTableKey = null
    this.editableSqlTarget = null
    this.activeEditableStmtSql = ''
    this.currentCanEdit = false
    this.activeQueryResult = res
    const idx = defaultIndex ?? getDefaultResultSetIndex(res)
    this.activeResultSetIndex = Math.max(0, idx)
    this.consoleTabs.setActiveResult(res, this.activeResultSetIndex)
    this.renderResultSetsBar()
    this.dataGrid?.setData(buildResultSetQueryResult(res, this.activeResultSetIndex))
  }

  /**
   * Resolves the table inline edits must target: the editable SQL result table when a
   * single-table SELECT is showing, otherwise the sidebar-selected table.
   */
  private resolveEditableTargetTable(): { table: string; schema?: string } | null {
    if (this.isActiveConnectionReadOnly()) return null
    if (this.isShowingSqlResult) {
      const target = this.editableSqlTarget
      if (!target) return null
      if (target.originConnectionId && target.originConnectionId !== this.activeConnectionId) {
        return null
      }
      const activeDriver = this.getActiveConnection()?.driver
      if (target.originDriver && activeDriver && target.originDriver !== activeDriver) {
        return null
      }
      return { table: target.table, schema: target.schema }
    }
    return this.activeTable ? { table: this.activeTable, schema: this.activeSchema } : null
  }

  private isEditableTargetCurrent(
    targetTable: string,
    targetSchema: string | undefined,
    inSqlResultMode: boolean
  ): boolean {
    const current = this.resolveEditableTargetTable()
    if (!current || current.table !== targetTable) return false
    if ((current.schema || '') !== (targetSchema || '')) return false
    if (!inSqlResultMode) return true
    if (!this.isShowingSqlResult || !this.editableSqlTarget) return false
    if (
      this.editableSqlTarget.originConnectionId &&
      this.editableSqlTarget.originConnectionId !== this.activeConnectionId
    ) {
      return false
    }
    if (
      this.editableSqlTarget.originTabId &&
      this.editableSqlTarget.originTabId !== this.consoleTabs.getActiveTabId()
    ) {
      return false
    }
    return (
      this.editableSqlTarget.originResultSetIndex === undefined ||
      this.editableSqlTarget.originResultSetIndex === this.activeResultSetIndex
    )
  }

  /**
   * Enables inline editing on a single-table SELECT result with a resolvable primary key
   * (Phase 5C); re-renders read-only rows otherwise.
   */
  private applySqlResultEditability(
    res: QueryResult,
    resultSetIndex: number,
    targetConnId: string,
    originTabId: string,
    seq: number,
    allowFetch = true
  ): void {
    const rs = res.resultSets?.[resultSetIndex]
    const columns = rs ? rs.columns || [] : res.columns || []
    const rows = rs ? rs.rows || [] : res.rows || []
    const isSelect = rs ? Boolean(rs.isSelect) : Boolean(res.isSelect)
    const driver = this.connections.find((c) => c.id === targetConnId)?.driver || 'sqlite'

    this.editableSqlTarget = null
    this.currentCanEdit = false
    this.activeEditableStmtSql = ''

    if (isSelect && columns.length > 0) {
      const rsState = this.consoleTabs.getResultTabState(resultSetIndex, originTabId)
      const stmts = splitSqlStatements(this.activeExecutedSql, driver)
      const stmtSql =
        rsState?.baseStatementSql ||
        rs?.sql ||
        (stmts[resultSetIndex] || stmts[0])?.text ||
        this.activeExecutedSql
      const resolvedSourceTable = rs ? rs.sourceTable : res.sourceTable
      const analysis: EditableSelectAnalysis = analyzeEditableSelectQuery({
        sql: stmtSql,
        dialect: driver,
        isReadOnly: this.isActiveConnectionReadOnly(),
        resultColumns: columns.map((c) => ({ name: c.name, type: c.type })),
        schemaObjects: this.schemaObjects || [],
        resolvedSourceTable,
        resolveTableDetails: (tbl, sch) => {
          const direct = this.tableDetailsCache?.get(buildStudioTableKey(targetConnId, sch, tbl))
          if (direct) return direct
          if (sch) return undefined
          return this.tableDetailsCache?.get(buildStudioTableKey(targetConnId, undefined, tbl))
        },
      })

      if (analysis.editable && analysis.table && analysis.primaryKey && analysis.columns) {
        const canonicalCols = analysis.columns
        const recordRows = rows.map((row) => {
          const rec: Record<string, unknown> = {}
          canonicalCols.forEach((colInfo, i) => {
            const key = colInfo?.name ?? columns[i]?.name
            if (key !== undefined) {
              rec[key] = row[i]
            }
          })
          return rec
        })
        this.editableSqlTarget = {
          table: analysis.table,
          schema: analysis.schema,
          primaryKey: analysis.primaryKey,
          columns: analysis.columns,
          originTabId,
          originResultSetIndex: resultSetIndex,
          originConnectionId: targetConnId,
          originDriver: driver,
          originSchema: analysis.schema,
          originTable: analysis.table,
        }
        this.activeEditableStmtSql = stmtSql
        this.currentCanEdit = true
        this.dataGrid?.setContextMeta(
          analysis.table,
          driver,
          targetConnId,
          analysis.schema || ''
        )
        const existingSnap = rsState?.gridSnapshot
        this.dataGrid?.setData({
          columns: analysis.columns,
          rows: recordRows,
          totalRows: recordRows.length,
          page: 1,
          pageSize: Math.max(1, recordRows.length),
          primaryKey: analysis.primaryKey,
          canEdit: true,
        })
        if (existingSnap) {
          if (existingSnap.sortColumn && existingSnap.sortDirection) {
            this.dataGrid?.sortInMemoryRows(existingSnap.sortColumn, existingSnap.sortDirection)
          }
          if (existingSnap.clientFilter) {
            this.dataGrid?.setClientFilter(existingSnap.clientFilter)
          }
          for (const cf of existingSnap.clientColumnFilters || []) {
            this.dataGrid?.addClientColumnFilter(cf.column, cf.value, cf.op)
          }
          if (existingSnap.findQuery) {
            this.dataGrid?.setFindQuery(existingSnap.findQuery)
          }
        }
        const totalSets = res.resultSets?.length ?? 1
        const nextSubbarTitle =
          totalSets > 1
            ? `Result ${resultSetIndex + 1} · Editable (${analysis.table})`
            : `SQL Result · Editable (${analysis.table})`
        if (this.gridSubbarTitleEl) {
          this.gridSubbarTitleEl.textContent = nextSubbarTitle
        }
        this.currentColCount = canonicalCols.length
        this.updateStagedActionButtons(this.dataGrid?.getStagedCount?.() ?? 0)
        if (rsState) {
          rsState.editableSqlTarget = { ...this.editableSqlTarget }
          rsState.activeEditableStmtSql = stmtSql
          rsState.currentCanEdit = true
          rsState.gridSubbarTitle = nextSubbarTitle
          rsState.gridSnapshot = this.dataGrid?.exportRuntimeState() ?? null
          this.consoleTabs.setResultTabState(resultSetIndex, rsState, originTabId)
        }
        return
      }

      // Table details not cached yet: fetch them once, then re-apply if still relevant.
      if (allowFetch && analysis.reason === 'missing_table_details' && analysis.table) {
        const targetTable = analysis.table
        const targetSchema = analysis.schema
        void this.fetchTableDetailsDeduped(targetConnId, targetTable, targetSchema)
          .then(() => {
            if (
              seq !== this.querySeq ||
              originTabId !== this.consoleTabs.getActiveTabId() ||
              resultSetIndex !== this.activeResultSetIndex ||
              this.activeConnectionId !== targetConnId ||
              !this.isShowingSqlResult ||
              (this.dataGrid?.getStagedCount() ?? 0) !== 0
            ) {
              return
            }
            this.applySqlResultEditability(
              res,
              resultSetIndex,
              targetConnId,
              originTabId,
              seq,
              false
            )
          })
          .catch(() => {})
      }
    }

    this.dataGrid?.setData(buildResultSetQueryResult(res, resultSetIndex))
    this.updateStagedActionButtons(this.dataGrid?.getStagedCount?.() ?? 0)
  }

  private renderResultSetsBar(): void {
    const bar = this.resultSetsBarEl
    if (!bar) return
    const res = this.activeQueryResult
    const sets = res?.resultSets
    if (!res || !sets || sets.length <= 1 || !isGridVisibleMode(this.activeViewMode)) {
      bar.innerHTML = ''
      bar.style.display = 'none'
      return
    }
    const activeTab = this.consoleTabs.getActiveTab()
    bar.innerHTML = ''
    sets.forEach((rs, idx) => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = `datanoa-result-set-btn${idx === this.activeResultSetIndex ? ' active' : ''}${rs.isError ? ' is-error' : ''}`
      const rsState = activeTab.resultStates?.[idx]
      btn.title = rsState?.statementSql || rs.sql || rs.sqlPreview || ''
      if (rs.isError) {
        btn.textContent = `Result ${idx + 1} · Error`
      } else if (rsState?.banner?.isExplain) {
        btn.textContent = `Result ${idx + 1} · ${rs.rowCount} ${rs.rowCount === 1 ? 'step' : 'steps'}`
      } else {
        btn.textContent = rs.isSelect
          ? `Result ${idx + 1} · ${rs.rowCount} ${rs.rowCount === 1 ? 'row' : 'rows'}`
          : `Result ${idx + 1} · ${rs.affectedRows ?? 0} affected`
      }
      btn.addEventListener('click', () => {
        this.selectResultSetIndex(idx)
      })
      bar.appendChild(btn)
    })
    bar.style.display = 'flex'
  }

  private selectResultSetIndex(index: number): void {
    const res = this.activeQueryResult
    const sets = res?.resultSets
    if (!res || !sets || index < 0 || index >= sets.length) return
    const rs = sets[index]
    if (!rs) return
    if (index === this.activeResultSetIndex && this.consoleTabs.getResultTabState(index)?.gridSnapshot) {
      return
    }
    this.captureActiveResultTabState()
    const activeTab = this.consoleTabs.getActiveTab()
    this.applyResultTabState(index, activeTab)
    const label = rs.isError
      ? 'Error'
      : formatGridStatusMetrics(
          rs.isSelect ? rs.rowCount : (rs.affectedRows ?? 0),
          rs.isSelect ? (rs.columns?.length ?? 0) : 0,
          {
            stagedCount: this.editableSqlTarget ? (this.dataGrid?.getStagedCount?.() ?? 0) : 0,
            truncated: Boolean(rs.isSelect && rs.truncated),
            unit: rs.isSelect ? 'row' : 'affected',
          }
        )
    this.updateStatus(`Result ${index + 1} of ${sets.length}`, label)
  }

  private hideResultSetsBar(): void {
    if (this.resultSetsBarEl) {
      this.resultSetsBarEl.innerHTML = ''
      this.resultSetsBarEl.style.display = 'none'
    }
  }

  private formatRawExplainRowsText(
    columns: readonly { name: string }[],
    rows: readonly unknown[][]
  ): string {
    if (!Array.isArray(rows) || rows.length === 0) return ''
    const formatCell = (cell: unknown): string => {
      if (cell === null || cell === undefined) return 'NULL'
      if (typeof cell === 'string') return cell
      if (typeof cell === 'object') {
        try {
          return JSON.stringify(cell)
        } catch {
          return String(cell)
        }
      }
      return String(cell)
    }
    if (columns.length <= 1 && rows.every((r) => Array.isArray(r) && r.length <= 1)) {
      return rows.map((r) => formatCell(r[0])).join('\n')
    }
    const headerLine = columns.map((c) => c.name).join('\t')
    const rowLines = rows.map((r) =>
      Array.isArray(r) ? r.map(formatCell).join('\t') : formatCell(r)
    )
    return headerLine ? `${headerLine}\n${rowLines.join('\n')}` : rowLines.join('\n')
  }

  private promptBindParams(
    sql: string,
    dialect: DatabaseDriverType,
    params: DetectedSqlParam[],
    onRun: (boundSql: string) => void,
    action: 'run' | 'explain' = 'run'
  ): void {
    const expectedConnId = this.activeConnectionId
    const scopeKey = expectedConnId || '__default__'
    let didSubmit = false
    void openSharedBindParamsModal({
      sql,
      dialect,
      params,
      action,
      memoryStore: this.bindParamsMemoryStore,
      scopeKey,
      rememberedValues: this.bindParamsMemoryStore.get(scopeKey),
      mountModal: (modalEl, canClose) => {
        const cancelBtn = modalEl.querySelector('.datanoa-modal-actions button')
        if (cancelBtn) {
          cancelBtn.addEventListener('click', () => {
            if (didSubmit) {
              this.closeActiveModal()
            }
          })
        }
        return this.mountStudioModal(modalEl, canClose)
      },
      closeModal: () => this.closeActiveModal(),
      onConfirm: (boundSql, nextValues, meta) => {
        didSubmit = true
        if (this.activeConnectionId !== expectedConnId) {
          this.updateStatus('Connection changed — query cancelled')
          return
        }
        if (meta?.rememberInRam === false) {
          this.bindParamsMemoryStore.clear(scopeKey)
        } else {
          this.bindParamsMemoryStore.set(scopeKey, nextValues)
        }
        onRun(boundSql)
      },
    })
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

  public async executeSql(
    executeAll = false,
    skipBindCheck = false,
    sqlOverride?: string,
    skipDangerGuard = false,
    execRangeOverride?: SqlExecutionRange | null,
    templateSqlOverride?: string
  ): Promise<void> {
    if (
      !this.sqlConsole ||
      (this.activeQueryId !== null && !this.cancelledQueryIds.has(this.activeQueryId))
    ) {
      return
    }
    if (this.txToolbar.isBusy()) {
      this.updateStatus('Wait for transaction operation to complete')
      return
    }
    const driver = this.getActiveConnection()?.driver || 'sqlite'
    const execRange =
      execRangeOverride !== undefined
        ? execRangeOverride
        : sqlOverride
          ? null
          : this.sqlConsole.getExecutionRange?.(executeAll ? 'all' : 'caret', driver) ?? null
    const sqlText =
      sqlOverride ??
      (executeAll
        ? this.sqlConsole.getText().trim()
        : this.sqlConsole.getCaretStatementSql(driver))
    if (!sqlText) {
      this.updateStatus('No query text to execute')
      return
    }

    if (!this.activeConnectionId) {
      this.updateStatus('Please select an active connection first')
      return
    }

    if (!skipBindCheck && driver !== 'redis') {
      const detectedParams = extractSqlParameters(sqlText, driver)
      if (detectedParams.length > 0) {
        const preBindTemplateSql = sqlText
        this.promptBindParams(sqlText, driver, detectedParams, (boundSql) => {
          void this.executeSql(
            executeAll,
            true,
            boundSql,
            skipDangerGuard,
            execRange,
            preBindTemplateSql
          )
        })
        return
      }
    }

    if (typeof window === 'undefined' || !window.orca?.plugin?.request) {
      this.updateStatus('No runtime environment available')
      return
    }

    if (!skipDangerGuard && !this.isActiveConnectionReadOnly()) {
      const conn = this.getActiveConnection()
      const activeFindings = analyzeDangerousSql(sqlText, driver)
      if (activeFindings.length > 0) {
        const expectedConnId = this.activeConnectionId
        const expectedTabId = this.consoleTabs.getActiveTabId()
        openStudioDangerSqlModal({
          mountModal: (modalEl, canClose) => this.mountStudioModal(modalEl, canClose),
          closeModal: () => this.closeActiveModal(),
          connectionName: conn?.name ?? 'Active Connection',
          colorTag: conn?.colorTag,
          findings: activeFindings,
          sql: sqlText,
          onConfirm: () => {
            if (
              this.activeConnectionId !== expectedConnId ||
              this.consoleTabs.getActiveTabId() !== expectedTabId
            ) {
              this.updateStatus('Connection or tab changed — query cancelled')
              return
            }
            void this.executeSql(
              executeAll,
              true,
              sqlText,
              true,
              execRange,
              templateSqlOverride
            )
          },
        })
        return
      }
    }

    const seq = ++this.querySeq
    const viewSeq = ++this.gridViewSeq
    this.tableLoadToken++
    this.isTableLoading = false
    const targetConnId = this.activeConnectionId
    const originTabId = this.consoleTabs.getActiveTabId()
    this.sqlConsole?.clearDbSyntaxError?.()
    this.hideQueryBanner()
    this.updateStatus('Running 0.0s...')
    const queryId = `query_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    this.activeWorkerQueryId = queryId
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

    const handleQueryExecutionError = (
      msg: string,
      failedStatementIndex: number | null,
      expectedStatementCount: number | null
    ): void => {
      this.consoleTabs?.setResultForTab?.(originTabId, null, 0, sqlText, targetConnId)
      if (originTabId !== this.consoleTabs.getActiveTabId()) {
        return
      }
      this.loadedDataTableKey = null
      this.isShowingSqlResult = true
      this.currentCanEdit = false
      this.currentPageRowCount = 0
      this.closeValueInspector()
      const errSlices =
        driver === 'redis'
          ? []
          : splitSqlStatements(execRange ? execRange.sql : sqlText, driver)
      const { failedSql: errFailedSql, fixTargetRange: errFixRange } =
        resolveExecutionErrorFixTarget(
          execRange,
          sqlText,
          msg,
          errSlices,
          driver,
          failedStatementIndex,
          expectedStatementCount
        )
      this.showQueryBanner('error', 'SQL Execution Error', msg, {
        showBackToTable: true,
        failedSql: errFailedSql,
        fixTargetRange: errFixRange,
        connectionId: targetConnId,
      })
      this.sqlConsole?.setDbSyntaxError?.(msg, errFixRange, driver)
      this.activeQueryResult = null
      this.activeResultSetIndex = 0
      this.hideResultSetsBar()
      this.renderExplainAiForActiveTab()
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
      this.currentColCount = 0
      this.currentMetricsTruncated = false
      this.updateStatus(`Query error: ${msg}`, '0 rows')
      if (this.queryHistoryDrawer?.isOpen?.()) {
        void this.queryHistoryDrawer.load()
      }
    }

    try {
      const startTime = performance.now()
      const res = await this.requestPlugin<QueryResult>(
        'query.run',
        {
          connectionId: targetConnId,
          queryId,
          sql: sqlText,
          ...(templateSqlOverride ? { templateSql: templateSqlOverride } : {}),
          structuredError: true,
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
      if (res?.executionError) {
        const execErrIdx =
          typeof res.executionError.failedStatementIndex === 'number' &&
          Number.isInteger(res.executionError.failedStatementIndex) &&
          res.executionError.failedStatementIndex >= 0
            ? res.executionError.failedStatementIndex
            : null
        const execErrCount =
          typeof res.executionError.statementCount === 'number' &&
          Number.isInteger(res.executionError.statementCount) &&
          res.executionError.statementCount > 0
            ? res.executionError.statementCount
            : null
        handleQueryExecutionError(
          res.executionError.message || 'Query execution failed',
          execErrIdx,
          execErrCount
        )
        return
      }

      const elapsed = Math.round(performance.now() - startTime)
      const durationMs = res.executionTimeMs || elapsed
      const rawStatements =
        driver === 'redis'
          ? [sqlText]
          : splitSqlStatements(sqlText, driver)
              .map((s) => s.text.trim())
              .filter(Boolean)
      const defaultIdx = getDefaultResultSetIndex(res)
      const initialStates = buildInitialResultTabStates(
        res,
        rawStatements,
        sqlText,
        durationMs,
        'query'
      )
      this.attachFixTargetsToResultStates(initialStates, res, sqlText, driver, execRange)
      this.consoleTabs.setResultForTab(
        originTabId,
        res,
        defaultIdx,
        sqlText,
        targetConnId,
        initialStates,
        'query'
      )
      if (originTabId !== this.consoleTabs.getActiveTabId()) {
        return
      }

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
      this.activeQueryResult = res
      this.activeExecutedSql = sqlText
      this.currentCanEdit = false
      this.activeEditableStmtSql = ''
      this.closeValueInspector()
      const contextTable = queriedTable || this.activeTable || 'query_result'
      this.dataGrid?.setContextMeta(
        contextTable,
        driver,
        targetConnId,
        this.activeSchema || ''
      )
      this.applyResultTabState(defaultIdx, this.consoleTabs.getActiveTab())

      const sets = getEffectiveResultSets(res, sqlText)
      const firstErrIdx = sets.findIndex((s) => Boolean(s.isError))
      if (firstErrIdx >= 0) {
        const errSet = sets[firstErrIdx]
        const errBanner = initialStates[firstErrIdx]?.banner
        const errMsg = errSet.errorMessage || errBanner?.errorText || errBanner?.detail || ''
        this.sqlConsole?.setDbSyntaxError?.(errMsg, errBanner?.fixTargetRange ?? null, driver)
      } else {
        this.sqlConsole?.clearDbSyntaxError?.()
      }
      const activeRs = sets[this.activeResultSetIndex] || sets[0]
      const isSelectSet = Boolean(activeRs ? activeRs.isSelect && !activeRs.isError : res.isSelect)
      const rowCount = activeRs
        ? activeRs.rowCount ?? activeRs.rows.length
        : (res.rowCount ?? res.rows.length)
      this.currentColCount = isSelectSet ? (activeRs?.columns?.length ?? res.columns?.length ?? 0) : 0
      this.currentMetricsTruncated = Boolean(isSelectSet && (activeRs?.truncated ?? res.truncated))
      const activeDuration = activeRs?.executionTimeMs ?? durationMs
      this.updateStatus(
        sets.length > 1
          ? `Executed ${sets.length} statements in ${durationMs}ms`
          : `Query executed in ${activeDuration}ms`,
        formatGridStatusMetrics(
          activeRs?.isError
            ? 0
            : isSelectSet
              ? rowCount
              : (activeRs?.affectedRows ?? res.affectedRows ?? 0),
          this.currentColCount,
          {
            stagedCount: this.editableSqlTarget ? (this.dataGrid?.getStagedCount?.() ?? 0) : 0,
            truncated: this.currentMetricsTruncated,
            unit: activeRs?.isError ? 'row' : isSelectSet ? 'row' : 'affected',
          }
        )
      )
      this.saveStudioViewState(true)
      this.saveStudioDataCache()
      if (containsDdlStatement(sqlText, driver) && this.activeConnectionId === targetConnId) {
        void this.refreshSchemaObjectsOnly(targetConnId)
      }
      if (this.queryHistoryDrawer.isOpen()) {
        void this.queryHistoryDrawer.load()
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
      const meta = extractFailedStatementMetaFromError(err)
      handleQueryExecutionError(msg, meta.failedStatementIndex, meta.statementCount)
    } finally {
      stopTimer()
      this.cancelledQueryIds.delete(queryId)
      if (seq === this.querySeq) {
        this.activeWorkerQueryId = null
        setButtonLoading(this.runBtn, false)
        setButtonLoading(this.runAllBtn, false)
        setButtonLoading(this.explainBtn, false)
        this.setQueryRunningState(null)
      }
      void this.refreshTransactionState(targetConnId)
    }
  }

  public async explainSql(
    skipBindCheck = false,
    sqlOverride?: string,
    skipDangerGuard = false,
    execRangeOverride?: SqlExecutionRange | null,
    templateSqlOverride?: string
  ): Promise<void> {
    if (
      !this.sqlConsole ||
      this.txToolbar?.isBusy() ||
      (this.activeQueryId !== null && !this.cancelledQueryIds.has(this.activeQueryId))
    ) {
      return
    }
    const driver = this.getActiveConnection()?.driver || 'sqlite'
    const execRange =
      execRangeOverride !== undefined
        ? execRangeOverride
        : sqlOverride
          ? null
          : this.sqlConsole.getExecutionRange?.('explain', driver) ?? null
    const selectedSql = sqlOverride ? '' : this.sqlConsole.getSelectedSql()
    const sqlText = sqlOverride ?? (selectedSql || this.sqlConsole.getText().trim())
    if (!sqlText) {
      this.updateStatus('No SQL statement to explain')
      return
    }
    if (!this.activeConnectionId) {
      this.updateStatus('Please select an active connection first')
      return
    }
    if (!skipBindCheck && driver !== 'redis') {
      const detectedParams = extractSqlParameters(sqlText, driver)
      if (detectedParams.length > 0) {
        const preBindTemplateSql = sqlText
        this.promptBindParams(
          sqlText,
          driver,
          detectedParams,
          (boundSql) => {
            void this.explainSql(
              true,
              boundSql,
              skipDangerGuard,
              execRange,
              preBindTemplateSql
            )
          },
          'explain'
        )
        return
      }
    }
    const explainStmts = splitExplainTargetStatements(sqlText, driver)
    if (explainStmts.length === 0) {
      this.updateStatus('No SQL statement to explain')
      return
    }
    if (!skipDangerGuard && !this.isActiveConnectionReadOnly()) {
      const conn = this.getActiveConnection()
      const findings = analyzeDangerousSql(sqlText, driver)
      if (findings.length > 0) {
        const expectedConnId = this.activeConnectionId
        const expectedTabId = this.consoleTabs.getActiveTabId()
        openStudioDangerSqlModal({
          mountModal: (modalEl, canClose) => this.mountStudioModal(modalEl, canClose),
          closeModal: () => this.closeActiveModal(),
          connectionName: conn?.name ?? 'Active Connection',
          colorTag: conn?.colorTag,
          findings,
          sql: sqlText,
          onConfirm: () => {
            if (
              this.activeConnectionId !== expectedConnId ||
              this.consoleTabs.getActiveTabId() !== expectedTabId
            ) {
              this.updateStatus('Connection or tab changed — explain cancelled')
              return
            }
            void this.explainSql(true, sqlText, true, execRange, templateSqlOverride)
          },
        })
        return
      }
    }
    if (typeof window === 'undefined' || !window.orca?.plugin?.request) return

    const seq = ++this.querySeq
    const viewSeq = ++this.gridViewSeq
    this.tableLoadToken++
    this.isTableLoading = false
    const targetConnId = this.activeConnectionId
    const executionSchema = this.selectedSchema || this.activeSchema || undefined
    const templateStmts = templateSqlOverride
      ? splitExplainTargetStatements(templateSqlOverride, driver)
      : []
    const originTabId = this.consoleTabs.getActiveTabId()
    const queryId = `explain_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    this.activeWorkerQueryId = queryId
    this.sqlConsole?.clearDbSyntaxError?.()
    this.hideQueryBanner()
    this.updateStatus(
      explainStmts.length > 1
        ? `Running EXPLAIN (1/${explainStmts.length}) 0.0s...`
        : 'Running EXPLAIN 0.0s...'
    )
    this.setQueryRunningState(queryId)

    setButtonLoading(this.runBtn, false)
    setButtonLoading(this.runAllBtn, false)
    setButtonLoading(this.explainBtn, false)
    if (this.runBtn) this.runBtn.disabled = true
    if (this.runAllBtn) this.runAllBtn.disabled = true
    setButtonLoading(this.explainBtn, true, 'Explaining 0.0s...')
    this.dataGrid?.setLoading(
      true,
      explainStmts.length > 1
        ? `Running EXPLAIN (${explainStmts.length} statements)...`
        : 'Running EXPLAIN...'
    )

    let currentIdx = 0
    const stopTimer = this.createElapsedTimer((elapsedText) => {
      if (seq !== this.querySeq || this.activeConnectionId !== targetConnId) return
      const label =
        explainStmts.length > 1
          ? `Explaining ${currentIdx + 1}/${explainStmts.length} (${elapsedText})...`
          : `Explaining ${elapsedText}...`
      setButtonLoading(this.explainBtn, true, label)
      this.updateStatus(label)
    })

    const subQueryIds: string[] = []
    try {
      const overallStart = performance.now()
      const collectedSets: QueryResultSet[] = []
      let firstNonError: QueryResult | null = null

      for (let i = 0; i < explainStmts.length; i++) {
        currentIdx = i
        if (
          seq !== this.querySeq ||
          viewSeq !== this.gridViewSeq ||
          this.activeConnectionId !== targetConnId ||
          this.cancelledQueryIds.has(queryId)
        ) {
          return
        }
        const stmtSql = explainStmts[i]
        const stmtTemplateSql = templateSqlOverride
          ? templateStmts.length === explainStmts.length
            ? templateStmts[i]
            : templateSqlOverride
          : undefined
        const workerQid = explainStmts.length === 1 ? queryId : `${queryId}_${i}`
        subQueryIds.push(workerQid)
        this.activeWorkerQueryId = workerQid
        const stmtStart = performance.now()
        try {
          const singleRes = await this.requestPlugin<QueryResult>(
            'query.explain',
            {
              connectionId: targetConnId,
              queryId: workerQid,
              sql: stmtSql,
              ...(stmtTemplateSql ? { templateSql: stmtTemplateSql } : {}),
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
          const stmtMs = singleRes.executionTimeMs || Math.round(performance.now() - stmtStart)
          if (!firstNonError) firstNonError = singleRes
          collectedSets.push({
            index: i,
            sqlPreview: compactSqlPreview(stmtSql),
            sql: stmtSql,
            executionTimeMs: stmtMs,
            columns: singleRes.columns || [],
            rows: singleRes.rows || [],
            rowCount: singleRes.rowCount ?? (singleRes.rows ? singleRes.rows.length : 0),
            truncated: Boolean(singleRes.truncated),
            isSelect: true,
            ...(singleRes.explainPlan ? { explainPlan: singleRes.explainPlan } : {}),
          })
        } catch (stmtErr: unknown) {
          if (
            seq !== this.querySeq ||
            viewSeq !== this.gridViewSeq ||
            this.activeConnectionId !== targetConnId ||
            this.cancelledQueryIds.has(queryId)
          ) {
            return
          }
          if (explainStmts.length === 1) {
            throw stmtErr
          }
          const stmtMsg = stmtErr instanceof Error ? stmtErr.message : String(stmtErr)
          collectedSets.push({
            index: i,
            sqlPreview: compactSqlPreview(stmtSql),
            sql: stmtSql,
            executionTimeMs: Math.round(performance.now() - stmtStart),
            isError: true,
            errorMessage: stmtMsg,
            columns: [],
            rows: [],
            rowCount: 0,
            truncated: false,
            isSelect: true,
          })
        }
      }

      const totalMs = Math.round(performance.now() - overallStart)
      const combinedRes = buildCombinedExplainResult(collectedSets, firstNonError, totalMs)
      const execConn = this.connections.find((c) => c.id === targetConnId)
      this.explainMetaByResult.set(combinedRes, {
        connectionId: targetConnId,
        dialect: driver,
        activeSchema: executionSchema,
        colorTag: execConn?.colorTag,
        aiPolicy: execConn?.aiPolicy,
        rawPlanTexts: collectedSets.map((s) =>
          this.formatRawExplainRowsText(s.columns || [], s.rows || [])
        ),
      })

      const initialStates = buildInitialResultTabStates(
        combinedRes,
        explainStmts,
        sqlText,
        totalMs,
        'explain'
      )
      this.attachFixTargetsToResultStates(initialStates, combinedRes, sqlText, driver, execRange)
      this.attachExplainTargetsToResultStates(
        initialStates,
        combinedRes,
        sqlText,
        driver,
        execRange
      )
      this.consoleTabs.setResultForTab(
        originTabId,
        combinedRes,
        0,
        sqlText,
        targetConnId,
        initialStates,
        'explain'
      )
      if (originTabId !== this.consoleTabs.getActiveTabId()) {
        return
      }

      this.isShowingSqlResult = true
      this.activeQueryResult = combinedRes
      this.activeExecutedSql = sqlText
      this.currentCanEdit = false
      this.editableSqlTarget = null
      this.activeEditableStmtSql = ''
      this.closeValueInspector()
      this.applyResultTabState(0, this.consoleTabs.getActiveTab())

      const firstErrIdx = collectedSets.findIndex((s) => Boolean(s.isError))
      if (firstErrIdx >= 0) {
        const errSet = collectedSets[firstErrIdx]
        const errBanner = initialStates[firstErrIdx]?.banner
        const errMsg = errSet.errorMessage || errBanner?.errorText || errBanner?.detail || ''
        this.sqlConsole?.setDbSyntaxError?.(errMsg, errBanner?.fixTargetRange ?? null, driver)
      } else {
        this.sqlConsole?.clearDbSyntaxError?.()
      }
      const firstSet = collectedSets[0]
      const errCount = collectedSets.filter((s) => s.isError).length
      this.currentColCount = firstSet && !firstSet.isError ? (firstSet.columns?.length ?? 0) : 0
      this.currentMetricsTruncated = false
      this.updateStatus(
        explainStmts.length > 1
          ? `EXPLAIN completed (${explainStmts.length} statements${errCount > 0 ? `, ${errCount} failed` : ''}) in ${totalMs}ms`
          : `EXPLAIN completed in ${firstSet?.executionTimeMs ?? totalMs}ms`,
        formatGridStatusMetrics(firstSet?.rowCount ?? 0, this.currentColCount)
      )
      this.saveStudioViewState(true)
      this.saveStudioDataCache()
    } catch (err: unknown) {
      if (
        seq !== this.querySeq ||
        viewSeq !== this.gridViewSeq ||
        this.activeConnectionId !== targetConnId
      ) {
        return
      }
      this.consoleTabs?.setResultForTab?.(originTabId, null, 0, sqlText, targetConnId)
      if (originTabId !== this.consoleTabs.getActiveTabId()) {
        return
      }
      const msg = err instanceof Error ? err.message : String(err)
      this.loadedDataTableKey = null
      this.isShowingSqlResult = true
      this.currentCanEdit = false
      this.currentPageRowCount = 0
      const errSlices =
        driver === 'redis'
          ? []
          : splitSqlStatements(execRange ? execRange.sql : sqlText, driver)
      const errMeta = extractFailedStatementMetaFromError(err)
      const { failedSql: errFailedSql, fixTargetRange: errFixRange } =
        resolveExecutionErrorFixTarget(
          execRange,
          sqlText,
          msg,
          errSlices,
          driver,
          errMeta.failedStatementIndex,
          errMeta.statementCount
        )
      this.showQueryBanner('error', 'EXPLAIN Error', msg, {
        showBackToTable: true,
        isExplain: true,
        failedSql: errFailedSql,
        fixTargetRange: errFixRange,
        connectionId: targetConnId,
      })
      this.sqlConsole?.setDbSyntaxError?.(msg, errFixRange, driver)
      this.activeQueryResult = null
      this.activeResultSetIndex = 0
      this.hideResultSetsBar()
      this.renderExplainAiForActiveTab()
      this.dataGrid?.setEmptyMessage(`EXPLAIN error: ${msg}`)
      this.dataGrid?.setData({
        columns: [],
        rows: [],
        rowCount: 0,
        executionTimeMs: 0,
        truncated: false,
        isSelect: true,
      })
      if (this.gridSubbarTitleEl) {
        this.gridSubbarTitleEl.textContent = 'EXPLAIN Error'
      }
      if (this.gridPageInfoEl) {
        this.gridPageInfoEl.textContent = '0 rows'
      }
      this.currentColCount = 0
      this.currentMetricsTruncated = false
      this.updatePaginationButtons()
      this.updateExportDropdownOptions()
      this.updateStatus(`EXPLAIN error: ${msg}`, '0 rows')
    } finally {
      stopTimer()
      this.cancelledQueryIds.delete(queryId)
      for (const sid of subQueryIds) {
        this.cancelledQueryIds.delete(sid)
      }
      if (seq === this.querySeq) {
        this.activeWorkerQueryId = null
        setButtonLoading(this.runBtn, false)
        setButtonLoading(this.runAllBtn, false)
        setButtonLoading(this.explainBtn, false)
        this.setQueryRunningState(null)
      }
      void this.refreshTransactionState(targetConnId)
    }
  }

  private async refreshSingleResultSet(
    originTabId: string,
    resultIdx: number,
    targetConnId: string,
    sqlText: string,
    opts?: {
      preserveWhere?: string
      preserveOrderBy?: string
      preserveSearchMode?: 'filter' | 'find'
      preserveClientSearch?: string
    }
  ): Promise<void> {
    if (typeof window === 'undefined' || !window.orca?.plugin?.request) return
    const refreshSeq = ++this.resultRefreshSeq
    const originTab = this.consoleTabs.getTabs().find((t) => t.id === originTabId)
    const originLastResult = originTab?.lastResult ?? null
    const queryId = `query_rs_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    const startTime = performance.now()
    try {
      const fresh = await this.requestPlugin<QueryResult>(
        'query.run',
        {
          connectionId: targetConnId,
          queryId,
          sql: sqlText,
        },
        { timeoutMs: DEFAULT_RPC_TIMEOUT_MS }
      )
      const tab = this.consoleTabs.getTabs().find((t) => t.id === originTabId)
      if (
        refreshSeq !== this.resultRefreshSeq ||
        !tab ||
        !tab.lastResult ||
        tab.lastResult !== originLastResult ||
        this.activeConnectionId !== targetConnId
      ) {
        return
      }
      const elapsed = fresh.executionTimeMs || Math.round(performance.now() - startTime)
      const existingSets = tab.lastResult.resultSets
      const existingState = this.consoleTabs.getResultTabState(resultIdx, originTabId)
      const baseStmtSql = existingState?.baseStatementSql || sqlText

      const updatedSet: QueryResultSet = {
        index: resultIdx,
        sqlPreview: compactSqlPreview(baseStmtSql),
        sql: baseStmtSql,
        executionTimeMs: elapsed,
        columns: fresh.columns || [],
        rows: fresh.rows || [],
        rowCount: fresh.rowCount ?? (fresh.rows ? fresh.rows.length : 0),
        affectedRows: fresh.affectedRows,
        truncated: Boolean(fresh.truncated),
        isSelect: Boolean(fresh.isSelect),
        ...(fresh.sourceTable ? { sourceTable: fresh.sourceTable } : {}),
      }

      let nextResult: QueryResult
      if (existingSets && existingSets.length > 0 && resultIdx >= 0 && resultIdx < existingSets.length) {
        const nextSets = existingSets.map((s, i) => (i === resultIdx ? updatedSet : s))
        nextResult = {
          ...tab.lastResult,
          ...(resultIdx === nextSets.length - 1 ? fresh : {}),
          resultSets: nextSets,
        }
      } else {
        nextResult = fresh
      }

      tab.lastResult = nextResult
      const nextBanner = buildBannerForResultSet(updatedSet, baseStmtSql, elapsed, 'query')
      const nextState: ResultSetTabRuntimeState = {
        resultSetIndex: resultIdx,
        baseStatementSql: baseStmtSql,
        statementSql: sqlText,
        banner: nextBanner,
        whereClause: opts?.preserveWhere ?? existingState?.whereClause ?? '',
        orderByClause: opts?.preserveOrderBy ?? existingState?.orderByClause ?? '',
        searchMode: opts?.preserveSearchMode ?? existingState?.searchMode ?? 'filter',
        clientSearchText: opts?.preserveClientSearch ?? existingState?.clientSearchText ?? '',
        gridSnapshot: null,
        editableSqlTarget: null,
        activeEditableStmtSql: '',
        currentCanEdit: false,
        gridSubbarTitle:
          nextResult.resultSets && nextResult.resultSets.length > 1
            ? `Result ${resultIdx + 1}`
            : 'SQL Result',
        gridPageInfo: `${updatedSet.rowCount} ${updatedSet.rowCount === 1 ? 'row' : 'rows'}${updatedSet.truncated ? ' (truncated)' : ''}`,
        emptyMessage: 'Query returned no rows.',
      }
      this.consoleTabs.setResultTabState(resultIdx, nextState, originTabId)

      if (
        originTabId === this.consoleTabs.getActiveTabId() &&
        this.isShowingSqlResult &&
        this.activeResultSetIndex === resultIdx
      ) {
        this.activeQueryResult = nextResult
        this.applyResultTabState(resultIdx, tab)
      }
    } catch (err: unknown) {
      if (
        originTabId === this.consoleTabs.getActiveTabId() &&
        this.isShowingSqlResult &&
        this.activeResultSetIndex === resultIdx
      ) {
        const msg = err instanceof Error ? err.message : String(err)
        this.showQueryBanner('error', 'Result Refresh Failed', msg)
        this.updateStatus(`Refresh failed: ${msg}`)
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
    const workerQid = this.activeWorkerQueryId || qid
    this.isCancellingQuery = true
    setButtonLoading(this.cancelQueryBtn, true, 'Cancelling...')
    this.updateStatus('Cancelling query...')
    let cancelAccepted = false
    try {
      const res = await this.requestPlugin<{ ok: boolean }>('query.cancel', { queryId: workerQid })
      cancelAccepted = res?.ok !== false
      if (cancelAccepted) {
        this.cancelledQueryIds.add(qid)
        this.cancelledQueryIds.add(workerQid)
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
    await this.queryHistoryDrawer.toggle()
  }

  private async clearQueryHistory(): Promise<void> {
    if (
      this.isClearingHistory ||
      typeof window === 'undefined' ||
      !window.orca?.plugin?.request
    ) {
      return
    }
    this.queryHistoryDrawer.bumpSeq()
    this.isClearingHistory = true
    setButtonLoading(this.clearHistoryBtn, true, 'Clearing...')
    try {
      await this.requestPlugin<{ ok: boolean }>('query.history.clear')
      this.queryHistoryDrawer.clearCached()
      await this.queryHistoryDrawer.load()
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
    const editTarget = this.resolveEditableTargetTable()
    if (
      this.isPreviewingDml ||
      !this.dataGrid ||
      !this.activeConnectionId ||
      !editTarget ||
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
    const targetTable = editTarget.table
    const targetSchema = editTarget.schema
    const inSqlResultMode = this.isShowingSqlResult
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
        ...(payload.deleteRows && payload.deleteRows.length > 0
          ? { deleteRows: payload.deleteRows }
          : {}),
      })
      if (
        seq !== this.dmlPreviewSeq ||
        this.activeConnectionId !== targetConnId ||
        !this.isEditableTargetCurrent(targetTable, targetSchema, inSqlResultMode)
      ) {
        return
      }
      const statements = res?.statements || []
      this.lastPreviewDmlText = statements.join('\n')
      const previewText =
        statements.length > 300
          ? `${statements.slice(0, 300).join('\n')}\n-- ... and ${statements.length - 300} more statements (click Copy SQL for full script)`
          : this.lastPreviewDmlText
      this.dmlPreviewPreEl.textContent = previewText || '-- No SQL statements generated'
      this.dmlPreviewEl.style.display = 'block'
    } catch (err: unknown) {
      if (
        seq !== this.dmlPreviewSeq ||
        this.activeConnectionId !== targetConnId ||
        !this.isEditableTargetCurrent(targetTable, targetSchema, inSqlResultMode)
      ) {
        return
      }
      const msg = err instanceof Error ? err.message : String(err)
      this.showQueryBanner('error', 'DML Preview Failed', msg)
      this.updateStatus(`Preview error: ${msg}`)
    } finally {
      this.isPreviewingDml = false
      setButtonLoading(this.dmlPreviewBtn, false)
      this.updateStagedActionButtons(this.dataGrid?.getStagedCount?.() ?? 0)
    }
  }

  private async submitStagedChanges(): Promise<void> {
    const editTarget = this.resolveEditableTargetTable()
    if (this.isSubmittingChanges || !this.dataGrid || !this.activeConnectionId || !editTarget) return
    if (this.isActiveConnectionReadOnly()) {
      this.updateStatus('Cannot submit changes on a Read-Only connection')
      return
    }
    const payload = this.dataGrid.getChangesPayload()
    const total = payload.inserts.length + payload.updates.length + payload.deletes.length
    if (total === 0) return

    const inSqlResultMode = this.isShowingSqlResult
    const targetConnId = this.activeConnectionId
    const targetTable = editTarget.table
    const targetSchema = editTarget.schema
    const targetPage = this.currentPage
    const submitViewSeq = this.gridViewSeq

    this.isSubmittingChanges = true
    this.dataGrid.setInteractionLocked(true)
    if (this.revertBtn) this.revertBtn.disabled = true
    if (this.addRowBtn) this.addRowBtn.disabled = true
    if (this.cloneRowBtn) this.cloneRowBtn.disabled = true
    if (this.delRowBtn) this.delRowBtn.disabled = true
    if (this.importDataBtn) this.importDataBtn.disabled = true
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
          ...(payload.deleteRows && payload.deleteRows.length > 0
            ? { deleteRows: payload.deleteRows }
            : {}),
        },
        { timeoutMs: DEFAULT_RPC_TIMEOUT_MS }
      )
      const stillSameTarget =
        this.activeConnectionId === targetConnId &&
        this.isEditableTargetCurrent(targetTable, targetSchema, inSqlResultMode) &&
        this.gridViewSeq === submitViewSeq
      if (!stillSameTarget) {
        return
      }
      if (res?.ok) {
        if (this.dmlPreviewEl) this.dmlPreviewEl.style.display = 'none'
        this.updateStatus(
          this.txToolbar.getState().active
            ? 'Staged edits applied inside open transaction'
            : `Committed +${res.inserted} inserted, ~${res.updated} updated, -${res.deleted} deleted`
        )
        void this.refreshTransactionState(targetConnId)
        if (inSqlResultMode) {
          this.dataGrid?.markStagedChangesCommitted()
          const targetTabId = this.editableSqlTarget?.originTabId || this.consoleTabs.getActiveTabId()
          const targetResultIdx =
            this.editableSqlTarget?.originResultSetIndex ?? this.activeResultSetIndex
          const stmtToRefresh = this.activeEditableStmtSql
          if (stmtToRefresh) {
            await this.refreshSingleResultSet(
              targetTabId,
              targetResultIdx,
              targetConnId,
              stmtToRefresh
            )
          }
        } else {
          await this.loadTableData(targetConnId, targetTable, targetPage)
        }
      } else {
        this.showQueryBanner('error', 'Submit Changes Rejected', 'The database rejected one or more staged edits.')
        this.updateStatus('Submit changes rejected')
      }
    } catch (err: unknown) {
      if (
        this.activeConnectionId !== targetConnId ||
        !this.isEditableTargetCurrent(targetTable, targetSchema, inSqlResultMode) ||
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
      this.updateStagedActionButtons(this.dataGrid?.getStagedCount?.() ?? 0)
    }
  }

  private updateExportDropdownOptions(): void {
    populateExportDropdownOptions(this.exportSelectEl, {
      isShowingSqlResult: this.isShowingSqlResult,
      currentPageRowCount: this.currentPageRowCount,
      totalRows: this.totalRows,
      lastSelectionSummary: this.lastSelectionSummary,
    })
    syncStudioSelectTooltip(this.exportSelectEl, 'Export Format')
  }

  private handleExportAction(actionValue: string): void {
    executeStudioExportAction(
      {
        dataGrid: this.dataGrid,
        driver: this.getActiveConnection()?.driver || 'sqlite',
        tableName: this.activeTable || 'query_result',
        updateStatus: (stateText) => this.updateStatus(stateText),
      },
      actionValue
    )
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
      (summary.sumFormatted != null || summary.sum !== null) &&
      (summary.avgFormatted != null || summary.avg !== null) &&
      (summary.minFormatted != null || summary.min !== null) &&
      (summary.maxFormatted != null || summary.max !== null)
    ) {
      parts.push(`Sum: ${summary.sumFormatted ?? formatAggregateNumber(summary.sum ?? 0)}`)
      parts.push(`Avg: ${summary.avgFormatted ?? formatAggregateNumber(summary.avg ?? 0)}`)
      parts.push(`Min: ${summary.minFormatted ?? formatAggregateNumber(summary.min ?? 0)}`)
      parts.push(`Max: ${summary.maxFormatted ?? formatAggregateNumber(summary.max ?? 0)}`)
    }
    if (summary.isTruncatedScan) {
      parts.push('first 50k')
    }
    this.statusSelectionEl.textContent = parts.join(' · ')
    this.statusSelectionEl.style.display = 'inline-flex'
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
    if (this.isShowingSqlResult) {
      this.captureActiveResultTabState()
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

  private async handleColumnHeaderFilter(
    column: string,
    value: string,
    op: ColumnHeaderFilterOp,
    mode: 'query' | 'client' | 'clear'
  ): Promise<void> {
    if (mode === 'clear') {
      this.dataGrid?.removeClientColumnFilter(column)
      this.updateStatus(`Cleared column filter on ${column}`)
      return
    }
    if (mode === 'client') {
      this.dataGrid?.addClientColumnFilter(column, value, op)
      this.updateStatus(`Filtered loaded rows on ${column}`)
      return
    }
    const driver = this.getActiveConnection()?.driver || 'sqlite'
    if (this.isShowingSqlResult) {
      const curState = this.consoleTabs.getResultTabState(this.activeResultSetIndex)
      const rs = this.activeQueryResult?.resultSets?.[this.activeResultSetIndex]
      const baseSql = (
        curState?.baseStatementSql ||
        rs?.sql ||
        this.activeExecutedSql ||
        ''
      ).trim()
      const injected = injectSqlColumnFilter(baseSql, column, value, op, driver)
      if (injected.ok && this.activeConnectionId) {
        await this.refreshSingleResultSet(
          this.consoleTabs.getActiveTabId(),
          this.activeResultSetIndex,
          this.activeConnectionId,
          injected.sql,
          {
            preserveWhere: curState?.whereClause ?? '',
            preserveOrderBy: curState?.orderByClause ?? '',
            preserveSearchMode: this.searchMode,
            preserveClientSearch: this.clientSearchEl?.value || '',
          }
        )
        return
      }
      this.dataGrid?.addClientColumnFilter(column, value, op)
      this.updateStatus(`Filtered loaded SQL rows on ${column}`)
      return
    }
    const predicate = buildColumnHeaderPredicate(column, value, op, driver)
    await this.handleQuickFilter(predicate, 'and')
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
    if (!isGridVisibleMode(this.activeViewMode)) {
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
    this.saveStudioViewState(false)
  }

  private getTableDisplayPatchQueue(tableKey: string) {
    let queue = this.tableDisplayPatchQueues.get(tableKey)
    if (!queue) {
      queue = {
        inFlight: false,
        dirty: false,
        overwrittenByRemoteWhileInFlight: false,
        inFlightSentNormalized: null,
        latestLocalEntry: null,
        hasPendingRemoteRebase: false,
        pendingRemoteRebaseEntry: null,
        pendingRemoteRebaseRev: 0,
        recentSelfRevisions: new Set<number>(),
      }
      this.tableDisplayPatchQueues.set(tableKey, queue)
    }
    return queue
  }

  private setPendingRemoteRebase(
    queue: {
      hasPendingRemoteRebase: boolean
      pendingRemoteRebaseEntry: TableDisplayStateEntry | null
      pendingRemoteRebaseRev: number
    },
    entry: TableDisplayStateEntry | null,
    rev: number
  ): void {
    const cleanRev = typeof rev === 'number' && Number.isFinite(rev) && rev > 0 ? Math.floor(rev) : 0
    if (!queue.hasPendingRemoteRebase || cleanRev >= queue.pendingRemoteRebaseRev) {
      queue.hasPendingRemoteRebase = true
      queue.pendingRemoteRebaseEntry = entry
      queue.pendingRemoteRebaseRev = cleanRev
    }
  }

  private clearPendingRemoteRebase(queue: {
    hasPendingRemoteRebase: boolean
    pendingRemoteRebaseEntry: TableDisplayStateEntry | null
    pendingRemoteRebaseRev: number
  }): void {
    queue.hasPendingRemoteRebase = false
    queue.pendingRemoteRebaseEntry = null
    queue.pendingRemoteRebaseRev = 0
  }

  private clearStudioColumnConfigCache(tableKey: string): boolean {
    let deleted = false
    if (Object.prototype.hasOwnProperty.call(this.columnConfigByTable, tableKey)) {
      delete this.columnConfigByTable[tableKey]
      deleted = true
    }
    if (
      this.activeConnectionId &&
      this.activeTable &&
      canUseLegacyStudioTableKeyFallback(this.activeConnectionId, this.activeSchema, this.activeTable)
    ) {
      const activeKey = buildStudioTableKey(this.activeConnectionId, this.activeSchema, this.activeTable)
      if (activeKey === tableKey) {
        const legacyKey = buildLegacyStudioTableKey(
          this.activeConnectionId,
          this.activeSchema,
          this.activeTable
        )
        if (legacyKey !== tableKey && Object.prototype.hasOwnProperty.call(this.columnConfigByTable, legacyKey)) {
          delete this.columnConfigByTable[legacyKey]
          deleted = true
        }
      }
    }
    return deleted
  }

  private recordSelfTableDisplayRevision(
    queue: { recentSelfRevisions: Set<number> },
    rev: number
  ): void {
    if (!(rev > 0)) return
    queue.recentSelfRevisions.delete(rev)
    queue.recentSelfRevisions.add(rev)
    while (queue.recentSelfRevisions.size > 16) {
      const oldest = queue.recentSelfRevisions.values().next().value
      if (oldest === undefined) break
      queue.recentSelfRevisions.delete(oldest)
    }
  }

  private getTableDisplayRevision(tableKey: string): number {
    return (
      this.tableDisplayRevisionByKey.get(tableKey) ??
      (tableKey === this.currentTableDisplayKey ? this.currentTableDisplayRevision : 0)
    )
  }

  private setTableDisplayRevision(tableKey: string, rev: number): void {
    this.tableDisplayRevisionByKey.set(tableKey, rev)
    if (tableKey === this.currentTableDisplayKey) {
      this.currentTableDisplayRevision = rev
    }
  }

  private async hydrateTableDisplayState(tableKey: string): Promise<void> {
    if (
      this.isDestroyed ||
      this.isShowingSqlResult ||
      !tableKey ||
      typeof window === 'undefined' ||
      !window.orca?.plugin?.request
    ) {
      return
    }
    const prevKey = this.currentTableDisplayKey
    const prevRev = this.tableDisplayRevisionByKey.get(tableKey) ?? 0
    this.currentTableDisplayKey = tableKey
    this.currentTableDisplayRevision = prevRev
    const reqGen = ++this.tableDisplayReqGen
    try {
      let res = await this.requestPlugin<{
        tableKey: string
        entry: TableDisplayStateEntry | null
        revision: number
      }>('ui.tableDisplayState.get', { tableKey })
      if (this.isDestroyed || this.isShowingSqlResult) return
      if (this.getCurrentTableConfigKey() !== tableKey || reqGen !== this.tableDisplayReqGen) {
        return
      }
      if (
        !res?.entry &&
        this.activeConnectionId &&
        this.activeTable &&
        canUseLegacyStudioTableKeyFallback(
          this.activeConnectionId,
          this.activeSchema,
          this.activeTable
        )
      ) {
        const legacyKey = buildLegacyStudioTableKey(
          this.activeConnectionId,
          this.activeSchema,
          this.activeTable
        )
        if (legacyKey !== tableKey) {
          const legacyRes = await this.requestPlugin<{
            tableKey: string
            entry: TableDisplayStateEntry | null
            revision: number
          }>('ui.tableDisplayState.get', { tableKey: legacyKey }).catch(() => null)
          if (this.isDestroyed || this.isShowingSqlResult) return
          if (this.getCurrentTableConfigKey() !== tableKey || reqGen !== this.tableDisplayReqGen) {
            return
          }
          if (legacyRes?.entry) {
            res = legacyRes
          }
        }
      }
      const queue = this.getTableDisplayPatchQueue(tableKey)
      if (queue.inFlight || queue.dirty) return
      const nextRev = typeof res?.revision === 'number' && Number.isFinite(res.revision) ? res.revision : 0
      const latestKnown = this.getTableDisplayRevision(tableKey)
      if (nextRev > 0 && nextRev < latestKnown) {
        return
      }
      if (nextRev > 0) {
        this.setTableDisplayRevision(tableKey, nextRev)
      }
      if (res?.entry) {
        this.dataGrid?.applyTableDisplayState(res.entry)
        this.colsPopoverSync?.()
      } else {
        if (nextRev === 0) {
          this.setTableDisplayRevision(tableKey, 0)
        }
        if (nextRev > 0 || prevRev > 0 || latestKnown > 0 || (prevKey && prevKey !== tableKey)) {
          if (
            (nextRev > 0 || prevRev > 0 || latestKnown > 0) &&
            this.clearStudioColumnConfigCache(tableKey)
          ) {
            this.saveStudioViewState(false)
          }
          this.dataGrid?.applyTableDisplayState(null)
          this.colsPopoverSync?.()
        }
      }
    } catch {
      // Best-effort table display hydration
    }
  }

  private async handleTableDisplayStateChanged(entry: TableDisplayStateEntry): Promise<void> {
    if (
      this.isDestroyed ||
      this.isShowingSqlResult ||
      !this.activeTable ||
      !this.activeConnectionId ||
      typeof window === 'undefined' ||
      !window.orca?.plugin?.request
    ) {
      return
    }
    const tableKey = this.getCurrentTableConfigKey()
    if (!tableKey) return
    this.currentTableDisplayKey = tableKey
    this.tableDisplayReqGen += 1
    const queue = this.getTableDisplayPatchQueue(tableKey)
    queue.latestLocalEntry = entry
    if (queue.inFlight) {
      queue.dirty = true
      return
    }
    await this.flushTableDisplayPatchQueue(tableKey)
  }

  private async flushTableDisplayPatchQueue(tableKey: string): Promise<void> {
    const queue = this.getTableDisplayPatchQueue(tableKey)
    if (queue.inFlight) return
    queue.inFlight = true
    let consecutiveFailures = 0
    try {
      while (!this.isDestroyed) {
        queue.dirty = false
        const isCurrentTable =
          !this.isShowingSqlResult && this.getCurrentTableConfigKey() === tableKey
        const sourceEntry =
          isCurrentTable && this.dataGrid
            ? this.dataGrid.exportTableDisplayStateEntry()
            : queue.latestLocalEntry
        if (!sourceEntry && !queue.hasPendingRemoteRebase) break

        let entryToSend = sourceEntry
        if (queue.hasPendingRemoteRebase) {
          const pendingEntry = queue.pendingRemoteRebaseEntry
          this.clearPendingRemoteRebase(queue)
          const rebased = rebaseTableDisplayStateEntry(
            queue.inFlightSentNormalized,
            sourceEntry,
            pendingEntry
          )
          if (rebased) {
            entryToSend = rebased
            if (isCurrentTable && this.dataGrid) {
              this.dataGrid.applyTableDisplayState(rebased)
              this.colsPopoverSync?.()
            }
          } else {
            entryToSend = {
              columnOrder: [],
              hiddenColumns: [],
              pinnedColumns: [],
              columnWidths: {},
              wrapCells: false,
              wrapMaxLines: 4,
              highlightRules: [],
              updatedAt: Date.now(),
              revision: this.getTableDisplayRevision(tableKey),
            }
            if (isCurrentTable && this.dataGrid) {
              if (this.clearStudioColumnConfigCache(tableKey)) {
                this.saveStudioViewState(false)
              }
              this.dataGrid.applyTableDisplayState(null)
              this.colsPopoverSync?.()
            }
          }
        }
        if (!entryToSend) break

        const sentNormalized = normalizeTableDisplayStateEntry(entryToSend)
        queue.inFlightSentNormalized = sentNormalized
        queue.overwrittenByRemoteWhileInFlight = false
        const baseRev = this.getTableDisplayRevision(tableKey)
        try {
          const res = await this.requestPlugin<{
            ok: boolean
            tableKey: string
            entry: TableDisplayStateEntry | null
            revision: number
          }>('ui.tableDisplayState.patch', {
            tableKey,
            patch: {
              columnOrder: entryToSend.columnOrder,
              hiddenColumns: entryToSend.hiddenColumns,
              pinnedColumns: entryToSend.pinnedColumns,
              columnWidths: entryToSend.columnWidths,
              wrapCells: entryToSend.wrapCells,
              wrapMaxLines: entryToSend.wrapMaxLines,
              highlightRules: entryToSend.highlightRules,
            },
            baseRevision: baseRev,
          })
          if (this.isDestroyed) break
          consecutiveFailures = 0
          const nextRev = typeof res?.revision === 'number' && Number.isFinite(res.revision) ? res.revision : 0
          const known = this.getTableDisplayRevision(tableKey)
          if (nextRev > 0) {
            this.recordSelfTableDisplayRevision(queue, nextRev)
            if (nextRev > known) {
              this.setTableDisplayRevision(tableKey, nextRev)
            }
          }
          if (!(nextRev > 0 && nextRev < known) && res && 'entry' in res) {
            const sameAsSent = areTableDisplayStateEntriesEquivalent(res.entry, sentNormalized)
            if (!sameAsSent || queue.overwrittenByRemoteWhileInFlight) {
              if (queue.dirty) {
                if (!sameAsSent) {
                  this.setPendingRemoteRebase(queue, res.entry, nextRev)
                }
              } else if (!this.isShowingSqlResult && this.getCurrentTableConfigKey() === tableKey) {
                if (!normalizeTableDisplayStateEntry(res.entry) && this.clearStudioColumnConfigCache(tableKey)) {
                  this.saveStudioViewState(false)
                }
                this.dataGrid?.applyTableDisplayState(res.entry)
                this.colsPopoverSync?.()
              }
            }
          }
          if (!queue.dirty) break
        } catch {
          consecutiveFailures += 1
          if (consecutiveFailures >= 2 || !queue.dirty) {
            queue.dirty = false
            this.clearPendingRemoteRebase(queue)
            break
          }
        }
      }
    } finally {
      queue.inFlight = false
      queue.overwrittenByRemoteWhileInFlight = false
      queue.inFlightSentNormalized = null
    }
  }

  private closeColumnsPopover(): void {
    this.colsPopoverSync = null
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
    const mounted = mountStudioColumnsPopover(this.dataGrid, this.columnsBtn, () => {
      this.closeColumnsPopover()
    })
    this.colsPopoverEl = mounted.popoverEl
    this.colsPopoverOutsideCleanup = mounted.outsideCleanup
    this.colsPopoverSync = mounted.syncState ?? null
  }

  private openValueInspector(info?: SelectedCellInfo): void {
    this.valueInspector.open(info)
  }

  private closeValueInspector(): void {
    this.valueInspector.close()
  }

  private toggleValueInspector(): void {
    this.valueInspector.toggle()
  }

  private handleCellSelectionChanged(info: SelectedCellInfo | null): void {
    this.valueInspector.handleSelectionChanged(info)
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
    const tableRef = driver === 'mongodb' ? '' : this.formatQualifiedSqlTable(item, driver)
    const sql =
      driver === 'mongodb'
        ? `db.getCollection(${JSON.stringify(item.name)}).countDocuments({});`
        : `SELECT COUNT(*) AS row_count FROM ${tableRef};`
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
    if (this.activeModalKeyCleanup || this.activeModalBackdrop) {
      closeActiveStudioCollapsibleDropdown()
    }
    if (this.activeModalKeyCleanup) {
      this.activeModalKeyCleanup()
      this.activeModalKeyCleanup = null
    }
    if (this.activeModalBackdrop) {
      this.activeModalBackdrop.remove()
      this.activeModalBackdrop = null
    }
    const dismiss = this.activeModalDismiss
    this.activeModalDismiss = null
    if (dismiss) {
      try {
        dismiss()
      } catch {
        // Ignore modal dismiss cleanup errors
      }
    }
  }

  private static modalTitleSeq = 0

  private mountStudioModal(
    modalEl: HTMLElement,
    canClose: () => boolean = () => true,
    onDismiss?: () => void
  ): HTMLDivElement | null {
    if (this.isDestroyed) {
      try {
        onDismiss?.()
      } catch {
        // Ignore modal dismiss cleanup errors
      }
      return null
    }
    this.closeActiveModal()
    closeActiveStudioCollapsibleDropdown()
    if (typeof document === 'undefined' || !document.body) {
      try {
        onDismiss?.()
      } catch {
        // Ignore modal dismiss cleanup errors
      }
      return null
    }
    const backdrop = document.createElement('div')
    backdrop.className = 'datanoa-modal-backdrop'
    backdrop.setAttribute('role', 'dialog')
    backdrop.setAttribute('aria-modal', 'true')
    const titleEl = modalEl.querySelector(
      'h1, h2, h3, .datanoa-modal-title, .datanoa-modal-head span, .datanoa-feedback-title, .datanoa-import-title, .datanoa-cmd-title, [role="heading"]'
    )
    if (titleEl && (titleEl.textContent || '').trim().length > 0) {
      if (!titleEl.id) {
        titleEl.id = `datanoa-modal-title-${++DatanoaStudioEditor.modalTitleSeq}`
      }
      backdrop.setAttribute('aria-labelledby', titleEl.id)
    } else if (
      !backdrop.hasAttribute('aria-label') &&
      !backdrop.hasAttribute('aria-labelledby')
    ) {
      backdrop.setAttribute('aria-label', modalEl.getAttribute('aria-label') || 'Dialog')
    }
    const rawActive = typeof document !== 'undefined' ? document.activeElement : null
    const previousFocus: HTMLElement | null =
      typeof HTMLElement === 'function' && rawActive instanceof HTMLElement
        ? rawActive
        : rawActive && typeof (rawActive as { focus?: unknown }).focus === 'function'
          ? (rawActive as HTMLElement)
          : null
    backdrop.appendChild(modalEl)
    this.activeModalDismiss = () => {
      try {
        onDismiss?.()
      } finally {
        if (
          !this.isDestroyed &&
          !this.activeModalBackdrop &&
          previousFocus &&
          previousFocus.isConnected !== false &&
          typeof previousFocus.focus === 'function'
        ) {
          try {
            previousFocus.focus({ preventScroll: true })
          } catch {
            previousFocus.focus()
          }
        }
      }
    }
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop && canClose()) {
        this.closeActiveModal()
      }
    })
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      const focusableSelector =
        'button:not(:disabled), [href], input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
      const isVisibleFocusable = (el: Element): el is HTMLElement => {
        const isHtmlEl =
          typeof HTMLElement === 'function'
            ? el instanceof HTMLElement
            : typeof el === 'object' && el !== null && typeof (el as { focus?: unknown }).focus === 'function'
        if (!isHtmlEl) return false
        const htmlEl = el as HTMLElement
        if (htmlEl.hidden) return false
        let node: HTMLElement | null = htmlEl
        while (node && node !== backdrop) {
          if (node.hidden) return false
          if (typeof window.getComputedStyle === 'function') {
            const st = window.getComputedStyle(node)
            if (st.display === 'none' || st.visibility === 'hidden') return false
          } else if (node.style?.display === 'none' || node.style?.visibility === 'hidden') {
            return false
          }
          node = node.parentElement
        }
        return true
      }
      const onKey = (ev: KeyboardEvent) => {
        if (ev.key === 'Escape') {
          if (document.querySelector('.datanoa-fp-overlay')) return
          ev.preventDefault()
          ev.stopPropagation()
          if (canClose()) {
            this.closeActiveModal()
          }
          return
        }
        if (ev.key === 'Tab') {
          if (document.querySelector('.datanoa-fp-overlay')) return
          const focusables = Array.from(modalEl.querySelectorAll(focusableSelector)).filter(
            isVisibleFocusable
          )
          if (focusables.length === 0) return
          const first = focusables[0]
          const last = focusables[focusables.length - 1]
          const active = document.activeElement
          const activeInside =
            active !== null &&
            typeof modalEl.contains === 'function' &&
            (typeof Node !== 'function' || active instanceof Node) &&
            modalEl.contains(active)
          if (ev.shiftKey) {
            if (active === first || !activeInside) {
              ev.preventDefault()
              last.focus()
            }
          } else if (active === last || !activeInside) {
            ev.preventDefault()
            first.focus()
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

  private clearConnectionSchemaState(connId: string): void {
    delete this.selectedSchemaByConn[connId]
    delete this.selectedSchemaUpdatedAtByConn[connId]
    delete this.availableSchemasByConn[connId]
    delete this.defaultSchemaByConn[connId]
    const prefix = `${encodeURIComponent(connId)}:`
    for (const k of Array.from(this.schemaObjectsByConnSchema.keys())) {
      if (k.startsWith(prefix)) {
        this.schemaObjectsByConnSchema.delete(k)
      }
    }
    if (this.pendingBootDataCache?.activeConnectionId === connId) {
      this.pendingBootDataCache = null
    }
    if (this.activeConnectionId === connId) {
      this.selectedSchema = undefined
      this.activeSchema = undefined
      this.availableSchemas = []
      this.defaultSchema = undefined
    }
  }

  private async activateSavedConnection(savedId: string): Promise<void> {
    this.hasUserInteraction = true
    this.clearConnectionSchemaState(savedId)
    if (savedId === this.activeConnectionId) {
      // Active profile changed (host, credentials, flags): force a full reset + re-introspection
      this.handleConnectionChanged(null)
    }
    this.pendingDocConnectionId = savedId
    this.pendingDocTable = null
    this.pendingDocSchema = undefined
    this.restoredPageOnBoot = 1
    this.saveStudioViewState(true)
    await this.refreshConnections()
  }

  private openConnectionModal(
    editProfile?: ConnectionProfile,
    options?: { focusSection?: 'tls' | 'ai' }
  ): void {
    openStudioConnectionModal(
      {
        isBackdropActive: (backdrop) =>
          backdrop !== null && this.activeModalBackdrop === backdrop,
        mountModal: (modalEl, canClose) => this.mountStudioModal(modalEl, canClose),
        closeModal: () => this.closeActiveModal(),
        requestPlugin: <T = unknown>(
          method: string,
          payload?: Record<string, unknown>,
          options?: { timeoutMs?: number }
        ) => this.requestPlugin<T>(method, payload, options),
        createElapsedTimer: (onTick) => this.createElapsedTimer(onTick),
        updateStatus: (stateText, metricsText) => this.updateStatus(stateText, metricsText),
        activateSavedConnection: (savedId) => this.activateSavedConnection(savedId),
        currentWorkspaceScope: this.currentWorkspaceScope,
        onConnectionDeleted: async (deletedId) => {
          this.hasUserInteraction = true
          this.clearConnectionSchemaState(deletedId)
          if (this.storedActiveConnectionId === deletedId) this.storedActiveConnectionId = null
          if (this.pendingDocConnectionId === deletedId) this.pendingDocConnectionId = null
          if (this.activeConnectionId === deletedId) this.handleConnectionChanged(null)
          this.saveStudioViewState(true)
          this.updateStatus('Connection deleted')
          await this.refreshConnections()
        },
      },
      editProfile,
      options
    )
  }

  private openCreateTableModal(): void {
    openStudioCreateTableModal({
      mountModal: (modalEl, canClose) => this.mountStudioModal(modalEl, canClose),
      closeModal: () => this.closeActiveModal(),
      activeConnection: this.getActiveConnection(),
      activeConnectionId: this.activeConnectionId,
      activeSchema: this.activeSchema,
      updateStatus: (stateText, metricsText) => this.updateStatus(stateText, metricsText),
      createElapsedTimer: (onTick) => this.createElapsedTimer(onTick),
      requestPlugin: <T = unknown>(
        method: string,
        payload?: Record<string, unknown>,
        options?: { timeoutMs?: number }
      ) => this.requestPlugin<T>(method, payload, options),
      onTableCreated: async (connId, targetName, targetSchema, currentSql) => {
        if (this.activeConnectionId !== connId) return
        this.activeTable = targetName
        this.activeSchema = targetSchema
        this.showQueryBanner('success', `Table "${targetName}" Created`, currentSql)
        await this.introspectSchema(connId, false)
      },
    })
  }

  private consumePendingImportAction(): void {
    if (this.isDestroyed || this.pendingDocAction !== 'import') return
    const target = this.pendingImportTarget
    if (
      target?.connectionId &&
      this.activeConnectionId &&
      target.connectionId !== this.activeConnectionId
    ) {
      return
    }
    this.pendingDocAction = null
    this.pendingImportTarget = null
    const targetTable = target?.table || this.activeTable
    const targetSchema = target?.schema ?? this.activeSchema
    let item: SchemaObject | undefined
    if (targetTable) {
      const matched = this.schemaObjects.find(
        (o) =>
          o.name === targetTable &&
          (targetSchema === undefined || (o.schema || '') === (targetSchema || ''))
      )
      item = matched ?? {
        name: targetTable,
        schema: targetSchema || '',
        kind: 'table',
      }
    }
    void this.openImportDataModal(item)
  }

  private async openImportDataModal(targetItem?: SchemaObject): Promise<void> {
    if (this.isDestroyed) return
    const conn = this.getActiveConnection()
    const connId = this.activeConnectionId
    if (!conn || !connId || conn.readOnly || conn.driver === 'redis') {
      this.updateStatus('Cannot import data on a Read-Only or Redis connection')
      return
    }

    const tableName = targetItem?.name || this.activeTable
    const schemaName = targetItem ? targetItem.schema || undefined : this.activeSchema
    if (!tableName) {
      this.updateStatus('Select a table before importing a file')
      return
    }
    if (targetItem?.kind === 'view' || (!targetItem && !this.isActiveObjectTable())) {
      this.updateStatus('Cannot import rows into a view — select a table')
      return
    }

    const openSeq = ++this.importModalOpenSeq
    const cacheKey = buildStudioTableKey(connId, schemaName, tableName)
    let targetColumns: ColumnInfo[] = []
    const cachedDetails = this.tableDetailsCache.get(cacheKey)
    if (cachedDetails && cachedDetails.columns.length > 0) {
      targetColumns = cachedDetails.columns
    } else if (
      this.loadedDataTableKey === cacheKey &&
      this.isObjectActive(tableName, schemaName) &&
      !this.isShowingSqlResult &&
      this.dataGrid
    ) {
      const modelCols = this.dataGrid.getModel()?.columns || []
      const fullCols = modelCols.filter(
        (col): col is ColumnInfo => 'nullable' in col && 'isPrimaryKey' in col
      )
      if (fullCols.length > 0) {
        targetColumns = fullCols
      }
    }

    if (targetColumns.length === 0) {
      try {
        this.updateStatus(`Loading schema for "${tableName}"...`)
        const details = await this.fetchTableDetailsDeduped(connId, tableName, schemaName, false)
        if (openSeq !== this.importModalOpenSeq || this.activeConnectionId !== connId) return
        if (details.kind === 'view') {
          this.updateStatus(`"${tableName}" is a view and cannot be imported into`)
          return
        }
        targetColumns = details.columns
      } catch (err: unknown) {
        if (openSeq !== this.importModalOpenSeq || this.activeConnectionId !== connId) return
        const msg = err instanceof Error ? err.message : String(err)
        this.showQueryBanner('error', 'Import Unavailable', `Failed to load schema for "${tableName}": ${msg}`)
        this.updateStatus(`Import unavailable: ${msg}`)
        return
      }
    }

    const canStageInGrid =
      this.loadedDataTableKey === cacheKey &&
      this.isObjectActive(tableName, schemaName) &&
      !this.isShowingSqlResult &&
      this.currentCanEdit &&
      this.dataGrid !== null

    this.activeImportModalKey = cacheKey
    openStudioImportModal({
      mountModal: (modalEl, canClose) =>
        this.mountStudioModal(modalEl, canClose, () => {
          if (this.activeImportModalKey === cacheKey) {
            this.activeImportModalKey = null
          }
        }),
      closeModal: () => this.closeActiveModal(),
      activeConnection: conn,
      activeConnectionId: connId,
      targetTable: tableName,
      targetSchema: schemaName,
      targetColumns,
      canStageInGrid,
      updateStatus: (stateText, metricsText) => this.updateStatus(stateText, metricsText),
      showQueryBanner: (kind, title, detail, opts) =>
        this.showQueryBanner(kind, title, detail, opts),
      createElapsedTimer: (onTick) => this.createElapsedTimer(onTick),
      requestPlugin: <T = unknown>(
        method: string,
        payload?: Record<string, unknown>,
        options?: { timeoutMs?: number }
      ) => this.requestPlugin<T>(method, payload, options),
      onStageRows: (records) => {
        if (
          !this.dataGrid ||
          this.activeConnectionId !== connId ||
          this.loadedDataTableKey !== cacheKey ||
          !this.isObjectActive(tableName, schemaName) ||
          this.isShowingSqlResult ||
          !this.currentCanEdit
        ) {
          return 0
        }
        const staged = this.dataGrid.stageImportedRows(records)
        if (staged > 0) {
          this.stagedImportSeq += 1
        }
        return staged
      },
      onDirectImportComplete: async (doneConnId, doneTable, doneSchema, insertedCount, options) => {
        if (this.activeConnectionId !== doneConnId) return
        if (this.isObjectActive(doneTable, doneSchema) && !this.isShowingSqlResult) {
          await this.loadTableData(doneConnId, doneTable, this.currentPage)
        }
        if (this.activeConnectionId !== doneConnId) return
        if (!options?.partial) {
          const qualified = doneSchema ? `${doneSchema}.${doneTable}` : doneTable
          this.showQueryBanner(
            'success',
            `Imported ${insertedCount} Row${insertedCount === 1 ? '' : 's'}`,
            `Inserted ${insertedCount} row${insertedCount === 1 ? '' : 's'} into "${qualified}".`
          )
          this.updateStatus(
            `Imported ${insertedCount} row${insertedCount === 1 ? '' : 's'} into ${doneTable}`
          )
        }
      },
    })
  }

  private openDangerTableModal(action: 'truncate' | 'drop', item: SchemaObject): void {
    openStudioDangerTableModal(
      {
        mountModal: (modalEl, canClose) => this.mountStudioModal(modalEl, canClose),
        closeModal: () => this.closeActiveModal(),
        activeConnection: this.getActiveConnection(),
        activeConnectionId: this.activeConnectionId,
        updateStatus: (stateText, metricsText) => this.updateStatus(stateText, metricsText),
        showQueryBanner: (kind, title, detail, opts) =>
          this.showQueryBanner(kind, title, detail, opts),
        createElapsedTimer: (onTick) => this.createElapsedTimer(onTick),
        requestPlugin: <T = unknown>(
          method: string,
          payload?: Record<string, unknown>,
          options?: { timeoutMs?: number }
        ) => this.requestPlugin<T>(method, payload, options),
        onDangerActionSucceeded: async (connId, act, obj, actionTitle, sql) => {
          if (this.activeConnectionId !== connId) return
          this.showQueryBanner('success', `${actionTitle} Succeeded`, sql)
          if (act === 'drop') {
            if (this.isObjectActive(obj.name, obj.schema)) {
              this.activeTable = null
              this.activeSchema = undefined
              this.lastInspectorLoadedKey = ''
      this.lastErLoadedKey = ''
      this.erDiagramView?.clear()
            }
            await this.introspectSchema(connId, false)
          } else if (this.isObjectActive(obj.name, obj.schema)) {
            await this.loadTableData(connId, obj.name, 1)
          }
        },
      },
      action,
      item
    )
  }

  private openSavedQueriesModal(): void {
    const conn = this.getActiveConnection()
    openStudioSavedQueriesModal({
      mountModal: (modalEl, canClose) => this.mountStudioModal(modalEl, canClose),
      closeModal: () => this.closeActiveModal(),
      currentSql: this.sqlConsole?.getText() ?? '',
      activeDialect: conn?.driver,
      requestPlugin: <T = unknown>(
        method: string,
        payload?: Record<string, unknown>,
        options?: { timeoutMs?: number }
      ) => this.requestPlugin<T>(method, payload, options),
      updateStatus: (stateText, metricsText) => this.updateStatus(stateText, metricsText),
      onInsertSql: (sql, mode, title) => {
        if (mode === 'replace') {
          this.sqlConsole?.setText(sql)
          this.consoleTabs.updateActiveSql(sql)
        } else {
          this.saveActiveConsoleTabState()
          this.consoleTabs.addTab(sql, title)
          this.loadActiveConsoleTab()
          if (this.isShowingSqlResult) {
            this.clearSqlResultViewForEmptyTab()
          }
        }
        if (this.activeViewMode !== 'sql' && this.activeViewMode !== 'split') {
          this.switchMode('sql')
        }
        this.saveStudioViewState(false)
        this.sqlConsole?.focus()
      },
    })
  }

  private openCommandPalette(): void {
    openStudioCommandPalette({
      mountModal: (modalEl, canClose) => this.mountStudioModal(modalEl, canClose),
      closeModal: () => this.closeActiveModal(),
      schemaObjects: this.schemaObjects,
      connections: this.connections,
      activeConnection: this.getActiveConnection(),
      sidebarCollapsed: this.sidebarCollapsed,
      selectSidebarObject: (obj) => this.activateSidebarObject(obj),
      openExportSchemaDdl: () => {
        void this.exportFullSchemaDdl()
      },
      selectConnection: (connId) => {
        this.hasUserInteraction = true
        this.pendingDocSchema = undefined
        this.pendingDocTable = null
        this.handleConnectionChanged(connId)
        if (this.shouldSyncMetadataHeaders()) {
          this.updateMetadataHeader('connectionId', connId)
          if (this.selectedSchema) {
            this.updateMetadataHeader('schema', this.selectedSchema)
          } else {
            this.removeMetadataHeader('schema')
          }
          this.removeMetadataHeader('table')
        }
        this.saveStudioViewState(true)
      },
      openConnectionModal: (editProfile) => this.openConnectionModal(editProfile),
      formatSqlInConsole: () => this.formatSqlInConsole(),
      openCreateTableModal: () => this.openCreateTableModal(),
      openImportDataModal: () => {
        void this.openImportDataModal()
      },
      openDriverManagerModal: () => this.openDriverManagerModal(),
      setSidebarCollapsed: (collapsed, persist) =>
        this.setSidebarCollapsed(collapsed, persist),
      switchMode: (mode) => this.switchMode(mode),
      toggleQueryHistory: () => this.toggleQueryHistory(),
      openSavedQueriesModal: () => this.openSavedQueriesModal(),
      handleRefreshAction: () => this.handleRefreshAction(),
      openShortcutsModal: () => this.openShortcutsModal(),
      openFeedbackModal: (initialKind) => this.openFeedbackModal(initialKind),
      onThemeToggled: (isLight) => {
        this.sqlConsole?.setColorScheme(isLight)
      },
    })
  }

  private openDriverManagerModal(onCloseReturn?: () => void): void {
    const returnIfAlive = onCloseReturn
      ? () => {
          if (!this.isDestroyed) onCloseReturn()
        }
      : undefined
    openStudioDriverManagerModal({
      mountModal: (modalEl, canClose) =>
        this.mountStudioModal(modalEl, canClose, returnIfAlive),
      closeModal: () => {
        this.closeActiveModal()
      },
      requestPlugin: <T = unknown>(
        method: string,
        payload?: Record<string, unknown>,
        options?: { timeoutMs?: number }
      ) => this.requestPlugin<T>(method, payload, options),
    })
  }

  private openShortcutsModal(): void {
    openStudioShortcutsModal({
      mountModal: (modalEl, canClose) => this.mountStudioModal(modalEl, canClose),
      closeModal: () => this.closeActiveModal(),
    })
  }

  public openFeedbackModal(initialKind: 'bug' | 'feature' = 'bug'): void {
    const conn = this.getActiveConnection()
    openStudioFeedbackModal(
      {
        mountModal: (modalEl, canClose) => this.mountStudioModal(modalEl, canClose),
        closeModal: () => this.closeActiveModal(),
        activeDriver: conn?.driver ?? null,
        activeViewMode: this.activeViewMode === 'er' ? 'inspector' : this.activeViewMode,
        isReadOnly: this.isActiveConnectionReadOnly(),
        lastQueryErrorText: this.lastQueryErrorText,
        updateStatus: (stateText, metricsText) => this.updateStatus(stateText, metricsText),
      },
      initialKind
    )
  }

  private async refreshSchemaObjectsOnly(connectionId: string): Promise<void> {
    if (typeof window === 'undefined' || !window.orca?.plugin?.request) return
    const reqToken = this.introspectToken
    try {
      const objects = await this.requestPlugin<SchemaObject[]>(
        'schema.listObjects',
        {
          connectionId,
          ...(this.selectedSchema ? { schema: this.selectedSchema } : {}),
        },
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
    if (this.isDestroyed) return
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
      this.lastErLoadedKey = ''
      this.erDiagramView?.clear()
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
    if (this.isDestroyed) return
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
    const activeConn = this.getActiveConnection()
    if (
      (activeConn?.driver === 'sqlite' || activeConn?.driver === 'libsql') &&
      this.txToolbar.hasActiveOrManualTx() &&
      requiresSqliteTableRebuild(draft)
    ) {
      const errMsg =
        'Cannot rebuild SQLite/LibSQL table while a manual transaction is active (SQLite ignores PRAGMA foreign_keys = OFF inside a transaction). Commit or rollback the transaction first.'
      this.showQueryBanner('error', 'Active Transaction Blocks Table Rebuild', errMsg)
      this.updateStatus(errMsg)
      throw new Error(errMsg)
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
      this.lastErLoadedKey = ''
      this.erDiagramView?.clear()
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
      this.captureActiveResultTabState()
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
    const editTarget = this.resolveEditableTargetTable()
    if (
      !this.activeConnectionId ||
      !editTarget ||
      this.isActiveConnectionReadOnly() ||
      typeof window === 'undefined' ||
      !window.orca?.plugin?.request
    ) {
      return { ok: false }
    }

    const targetConnId = this.activeConnectionId
    try {
      this.updateStatus(`Saving ${params.column}...`)
      const res = await this.requestPlugin<{
        ok: boolean
        affectedRows?: number
        updatedRecord?: Record<string, unknown>
      }>('data.updateCell', {
        connectionId: targetConnId,
        table: editTarget.table,
        ...(editTarget.schema ? { schema: editTarget.schema } : {}),
        primaryKeys: params.primaryKeys,
        column: params.column,
        newValue: params.newValue,
        originalValue: params.originalValue,
      })

      if (res.ok) {
        if (this.activeConnectionId === targetConnId) {
          this.updateStatus(`Cell '${params.column}' saved successfully`)
        }
        return res
      }
      if (this.activeConnectionId === targetConnId) {
        this.updateStatus(`Conflict: cell '${params.column}' was modified concurrently`)
      }
      return { ok: false }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (this.activeConnectionId === targetConnId) {
        this.updateStatus(`Update failed: ${msg}`)
      }
      return { ok: false }
    } finally {
      void this.refreshTransactionState(targetConnId)
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
    this.isDestroyed = true
    this.aiFixSeq += 1
    this.aiFixAbort?.abort()
    this.aiFixAbort = null
    this.aiFixState = null
    this.explainAiSeq += 1
    this.explainAiAbort?.abort()
    this.explainAiAbort = null
    this.explainAiLoadingTarget = null
    if (this.explainAiEl) {
      renderSharedExplainAiPanel(
        this.explainAiEl,
        {
          phase: 'hidden',
          aiEnabled: false,
          aiReady: false,
          explainLanguage: this.aiStatus?.explainLanguage || 'auto',
        },
        {
          onAnalyze: () => {},
          onConfigureAi: () => {},
          onCancel: () => {},
          onApplySql: () => {},
          onOpenNewTab: () => {},
          onCopyText: () => {},
          onToggleCollapsed: () => {},
        }
      )
    }
    if (this.aiFixEl) {
      renderSharedAiFixPanel(
        this.aiFixEl,
        {
          phase: 'hidden',
          aiEnabled: false,
          aiReady: false,
        },
        {
          onReplaceQuery: () => {},
          onCopySql: () => {},
          onRetry: () => {},
          onCancel: () => {},
          onDismiss: () => {},
          onConfigureAi: () => {},
        }
      )
    }
    this.cancelClientSearchDebounce()
    this.introspectToken++
    this.gridViewSeq++
    this.tableLoadToken++
    this.schemaLoadToken++
    this.querySeq++
    this.connectionsSeq++
    this.tableDisplayReqGen++
    this.importModalOpenSeq++
    this.queryHistoryDrawer.bumpSeq()
    this.dmlPreviewSeq++
    this.countRowsSeq++
    this.txToolbar.rollbackOnUnload()
    this.txToolbar.destroy()
    this.activeConnectionId = null
    this.cancelledQueryIds.clear()
    this.inFlightTableDetails.clear()
    this.tableDisplayPatchQueues.clear()
    this.tableDisplayRevisionByKey.clear()
    this.stopAllTimers()

    if (this.scrollRestoreRafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.scrollRestoreRafId)
      this.scrollRestoreRafId = null
    }

    this.valueInspector.destroy()
    this.queryHistoryDrawer.destroy()
    this.cancelSplitResize()

    closeActiveStudioCollapsibleDropdown()
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

    this.erDiagramView?.destroy()
    this.erDiagramView = null

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

// Bootstrap custom editor frame immediately (0ms warm-cache paint), then attach orca.document session
const editor = initializeEditor()
if (
  editor &&
  typeof window !== 'undefined' &&
  (window as unknown as { orca?: { document?: { session: () => Promise<DocumentSessionLike> } } }).orca?.document
) {
  void (
    window as unknown as { orca: { document: { session: () => Promise<DocumentSessionLike> } } }
  ).orca.document
    .session()
    .then((session) => {
      if (session) {
        editor.attachDocumentSession(session)
      }
    })
    .catch(() => {
      // Non-fatal if document session is unavailable
    })
}
