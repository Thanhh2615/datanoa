// src/editor/index.ts
// Datanoa Studio Editor: Full-Screen JetBrains DataGrip Custom Editor for .sql and .datanoa files
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
  formatGridStatusMetrics,
  type StudioViewMode,
} from './result-set-controller.js'
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
  analyzeDangerousSql,
  type DangerousSqlFinding,
  type DangerousSqlKind,
} from './sql-safety.js'
import {
  containsSensitiveSqlText,
  sanitizeSqlResultForStorage,
} from '../shared-sql-safety.js'
import { remapSqlTargetRange, resolveSqlReplacementSpan } from '../shared-sql-core.js'
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
  readLocalStudioViewState,
  writeStudioViewStateSnapshot,
  readLocalStudioWarmCache,
  writeLocalStudioWarmCache,
  syncInitialThemeFromHost as detectInitialThemeFromHost,
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
  type TableBrowseResult,
  type TableDetails,
  type SchemaObject,
  type SchemaObjectKind,
} from '../protocol.js'
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
    --surface: color-mix(in srgb, var(--text) 3.5%, var(--bg));
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
  private rememberedBindParams: Record<string, BindParamInput> = {}
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
  private queryBannerBackBtn: HTMLButtonElement | null = null
  private queryBannerFixAiBtn: HTMLButtonElement | null = null
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
  private importDataBtn: HTMLButtonElement | null = null
  private importModalOpenSeq = 0
  private exportSelectEl: HTMLSelectElement | null = null
  private batchModeBtn: HTMLButtonElement | null = null
  private editTableBtn: HTMLButtonElement | null = null
  private isRestoringViewState = false
  private hasRestoredBootState = false
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
  private aiBtn: HTMLButtonElement | null = null
  private aiStatus: AiStatusSnapshot | null = null
  private aiFixAbort: AbortController | null = null
  private aiFixSeq = 0
  private aiFixState: {
    phase: 'hidden' | 'loading' | 'ready' | 'error'
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

  private tabButtons: {
    split: HTMLButtonElement
    grid: HTMLButtonElement
    sql: HTMLButtonElement
    inspector: HTMLButtonElement
  } | null = null

  private connections: ConnectionProfile[] = []
  private schemaObjects: SchemaObject[] = []
  private filterQuery = ''
  private availableSchemas: string[] = []
  private selectedSchema: string | undefined = undefined
  private defaultSchema: string | undefined = undefined
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
  private connectionsSeq = 0
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
  private currentWorkspaceScope = ''
  private activeExecutedSql = ''
  private activeEditableStmtSql = ''
  private editableSqlTarget: {
    table: string
    schema?: string
    primaryKey: string[]
    columns: ColumnInfo[]
    originTabId?: string
    originResultSetIndex?: number
    originConnectionId?: string
  } | null = null
  private activeQueryId: string | null = null
  private currentCanEdit = false
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
  private activeModalDismiss: (() => void) | null = null
  private lastInspectorLoadedKey = ''

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
      if (
        saved.consoleTabs &&
        Array.isArray(saved.consoleTabs.tabs) &&
        saved.consoleTabs.tabs.length > 0 &&
        !this.documentSession
      ) {
        this.consoleTabs = new ConsoleTabsManager(saved.consoleTabs)
        const savedTab = this.consoleTabs.getActiveTab()
        this.suppressDocSync = true
        try {
          this.sqlConsole?.setText(savedTab.sql)
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
        (saved.activeViewMode === 'split' ||
          saved.activeViewMode === 'grid' ||
          saved.activeViewMode === 'sql' ||
          saved.activeViewMode === 'inspector')
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

  private hydrateWarmCacheIntoDom(warm: StudioWarmCacheSnapshot): boolean {
    const conns = Array.isArray(warm.connections) ? warm.connections : []
    const targetConnId = this.pendingDocConnectionId || this.activeConnectionId || warm.activeConnectionId || null
    if (!targetConnId || conns.length === 0) return false
    if (warm.activeConnectionId && warm.activeConnectionId !== targetConnId) return false
    const matchedConn = conns.find((c) => c.id === targetConnId)
    if (!matchedConn) return false

    this.connections = conns
    this.activeConnectionId = targetConnId
    this.pendingBootDataCache = warm
    this.warmBootUpdatedAt = Number.isFinite(warm.updatedAt) ? warm.updatedAt : 0

    if (Array.isArray(warm.availableSchemas)) {
      this.availableSchemas = warm.availableSchemas.filter((s) => typeof s === 'string' && s.length > 0)
    }
    if (typeof warm.defaultSchema === 'string' && warm.defaultSchema) {
      this.defaultSchema = warm.defaultSchema
    }
    if (typeof warm.selectedSchema === 'string' && warm.selectedSchema) {
      this.selectedSchema = warm.selectedSchema
    }
    if (Array.isArray(warm.schemaObjects)) {
      this.schemaObjects = warm.schemaObjects
    }
    if (warm.schemaMap && typeof warm.schemaMap === 'object') {
      this.schemaMap = warm.schemaMap
      this.sqlConsole?.updateSchema(this.schemaMap, this.activeTable || undefined)
    }
    if (!this.activeTable && warm.activeTable) {
      this.activeTable = warm.activeTable
    }
    if (!this.activeSchema && warm.activeSchema) {
      this.activeSchema = warm.activeSchema
    }
    if (warm.activeObjectKind) {
      this.activeObjectKind = warm.activeObjectKind
    }
    if (warm.activeReadOnlyObject) {
      this.activeReadOnlyObject = warm.activeReadOnlyObject
    }

    this.populateConnectionSelectDom(targetConnId)
    this.applyActiveConnectionPresentation(matchedConn)
    this.updateSchemaSwitcherDisplay()
    this.isIntrospectingSchema = false
    this.renderSidebarObjects()

    let hydratedGrid = false
    let isTruncatedWarmPage = false
    if (warm.isShowingSqlResult && warm.lastSqlResult) {
      this.isShowingSqlResult = true
      this.applyActiveQueryResult(warm.lastSqlResult)
      const cachedRes = warm.lastSqlResult
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
    } else if (this.doesWarmPageCacheMatchCurrentQuery(warm) && warm.pageData) {
      const cachedPage = warm.pageData
      const readOnly = Boolean(matchedConn.readOnly)
      this.lastPageData = cachedPage
      this.lastLoadedTableKey = `${targetConnId}:${this.activeSchema || ''}:${this.activeTable || ''}`
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
        matchedConn.driver || 'sqlite',
        targetConnId,
        this.activeSchema || ''
      )
      const cachedKey = `${targetConnId}:${this.activeSchema || ''}:${this.activeTable || ''}`
      const savedColCfg = this.columnConfigByTable[cachedKey]
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
    }

    this.updatePaginationButtons()
    this.updateExportDropdownOptions()
    this.consumePendingScrollState()

    if (hydratedGrid && this.schemaObjects.length > 0) {
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

  private restoreStudioViewStateFromLocal(): void {
    const saved = this.readLocalStudioViewState()
    if (saved) {
      this.applyRestoredStudioViewState(saved)
    }
    const warm = readLocalStudioWarmCache()
    if (warm) {
      this.hydrateWarmCacheIntoDom(warm)
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

  private writeStudioViewStateNow(): void {
    if (this.isRestoringViewState || this.isDestroyed || typeof window === 'undefined') return
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
    try {
      const cachedSchemaObjs = Array.isArray(this.schemaObjects)
        ? this.schemaObjects.slice(0, 400)
        : []
      const now = Date.now()
      const cachePayload: StudioWarmCacheSnapshot = {
        updatedAt: now,
        connections: this.connections,
        activeConnectionId: this.activeConnectionId || null,
        activeTable: this.activeTable || null,
        activeSchema: this.activeSchema || '',
        activeObjectKind: this.activeObjectKind || null,
        activeReadOnlyObject: this.activeReadOnlyObject || null,
        availableSchemas: this.availableSchemas.slice(0, 100),
        defaultSchema: this.defaultSchema || '',
        selectedSchema: this.selectedSchema || '',
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
    this.roBadgeEl = dom.roBadgeEl
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
    this.statusStateEl = dom.statusStateEl
    this.statusSelectionEl = dom.statusSelectionEl
    this.statusMetricsEl = dom.statusMetricsEl
    this.shortcutsBtn = dom.shortcutsBtn
    this.feedbackBtn = dom.feedbackBtn

    // Wire toolbar & header controls
    dom.sidebarToggleBtn.addEventListener('click', () => {
      this.setSidebarCollapsed(!this.sidebarCollapsed, true)
    })
    dom.connSelectEl.addEventListener('change', () => {
      const nextId = this.connSelectEl?.value || null
      this.pendingDocConnectionId = null
      this.pendingDocTable = null
      this.handleConnectionChanged(nextId)
      if (nextId) {
        this.updateMetadataHeader('connectionId', nextId)
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
    dom.schemaSelectEl.addEventListener('change', () => this.handleSchemaSelectionChanged())
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
        copyTextFallback(fullSql)
        this.updateStatus('Copied full DML SQL to clipboard')
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
      copyTextFallback(this.lastQueryErrorText, this.queryBannerCopyBtn)
      this.updateStatus('Copied query error to clipboard')
    })
    dom.queryBannerReportBtn.addEventListener('click', () => this.openFeedbackModal('bug'))
    dom.queryBannerCloseBtn.addEventListener('click', () => this.dismissActiveQueryBanner())
    dom.statusSelectionEl.addEventListener('click', () => {
      const text = this.statusSelectionEl?.textContent || ''
      if (text) {
        copyTextFallback(text)
        this.updateStatus('Copied selection statistics to clipboard')
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
          if (containsSensitiveSqlText(`${prefix}${suffix}`)) return null
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
              activeSchema: this.selectedSchema,
              activeTable: this.activeTable ?? undefined,
              schemaMap: this.schemaMap,
            },
            { signal, timeoutMs: 18_000 }
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
      onChange: (doc) => {
        if (!this.suppressDocSync) {
          this.consoleTabs.updateActiveSql(doc)
          this.documentSession?.change?.(this.composeSerializedDocument(doc))
          this.saveStudioViewState(false)
        }
      },
    })

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
        if (this.activeViewMode === 'grid' || this.activeViewMode === 'inspector') {
          this.switchMode('split')
        }
        this.updateStatus('Inserted DDL into SQL Console')
      },
      onCopyDdl: () => {
        this.updateStatus('Copied DDL to clipboard')
      },
      onOpenDdlInConsole: (ddl) => {
        this.sqlConsole?.insertText(ddl)
        if (this.activeViewMode === 'grid' || this.activeViewMode === 'inspector') {
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
    }

    if (!this.sqlAreaEl || !this.gridAreaEl || !this.inspectorAreaEl) return

    const showSqlChrome = mode === 'split' || mode === 'sql'
    const showGridChrome = mode !== 'inspector'
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

  public applyDocumentMetadata(
    docText: string,
    options?: { resetCautionDismissal?: boolean }
  ): void {
    const parsed = parseDatanoaDocument(docText)
    this.preservedMetadataLines = parsed.metadataLines
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
        parsed.table &&
        (parsed.table !== this.activeTable ||
          (parsed.schema || '') !== (this.activeSchema || ''))
      ) {
        this.pendingDocConnectionId = null
        this.pendingDocTable = null
        this.pendingDocSchema = undefined
        this.activeTable = parsed.table
        this.activeObjectKind = null
        this.activeReadOnlyObject = null
        this.activeSchema =
          parsed.schema ||
          this.schemaObjects.find((o) => o.name === parsed.table)?.schema ||
          undefined
        if (parsed.schema) this.selectedSchema = parsed.schema
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
              (!this.isShowingSqlResult || this.editableSqlTarget !== null) &&
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
        closeActiveStudioCollapsibleDropdown()
        this.closeTopbarPopover()
        this.closeColumnsPopover()
        this.applyClampedSplitPaneHeight()
        if (this.activeViewMode !== 'inspector') {
          this.dataGrid?.handleViewportResize()
        }
      }
      const onWindowPageHide = () => {
        this.saveStudioDataCache()
        this.destroy()
      }
      let lastVisibilityRefreshAt = 0
      const refreshOnFocusOrVisible = () => {
        if (this.isDestroyed) return
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
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
          if (payload && payload.colorScheme) {
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
        void window.orca.host
          .call('workspace.readContext')
          .then((result) => {
            if (this.isDestroyed) return
            const scope = typeof result?.workspaceId === 'string' ? result.workspaceId.trim() : ''
            this.currentWorkspaceScope = scope
            if (this.connections.length > 0) this.updateConnectionSelector()
          })
          .catch(() => {})
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
          void this.refreshConnections()
        })
      )
      if (typeof window.orca.storage?.onDidChange === 'function') {
        track(
          window.orca.storage.onDidChange((change) => {
            if (
              change?.key === SAVED_CONNECTIONS_STORAGE_KEY ||
              change?.key === 'connections'
            ) {
              void this.refreshConnections()
            }
          })
        )
      }
      track(
        window.orca.plugin.on('studio.opened', (payload) => {
          const openedConnId =
            payload &&
            typeof payload === 'object' &&
            'connectionId' in payload &&
            typeof (payload as { connectionId?: unknown }).connectionId === 'string'
              ? (payload as { connectionId: string }).connectionId
              : null
          if (!openedConnId || openedConnId === this.activeConnectionId) {
            this.dismissedCautionKey = null
            this.applyActiveConnectionPresentation(this.getActiveConnection())
          }
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
      track(
        window.orca.plugin.on('ai.status.changed', (snapshot) => {
          this.applyAiStatus(snapshot)
        })
      )
      if (typeof window.orca.settings?.onDidChange === 'function') {
        track(
          window.orca.settings.onDidChange((change) => {
            if (typeof change?.key === 'string' && change.key.startsWith('ai')) {
              void this.hydrateAiStatus()
            }
          })
        )
      }
    } catch {
      // Ignore if plugin event bus is mocked minimally
    }

    void this.hydrateAiStatus()
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

  public async refreshConnections(): Promise<void> {
    if (this.isDestroyed || typeof window === 'undefined' || !window.orca?.plugin?.request) return
    const seq = ++this.connectionsSeq
    const needsBootSnap = !this.hasRestoredBootState
    try {
      const [conns, workerSnap] = await Promise.all([
        this.requestPlugin<ConnectionProfile[]>('connections.list'),
        needsBootSnap
          ? this.requestPlugin<{
              viewState?: StudioPersistedViewState | null
              dataCache?: StudioWarmCacheSnapshot | null
              updatedAt?: number
            }>('ui.getSessionSnapshot', { surface: 'studio' }).catch(() => null)
          : Promise.resolve(null),
      ])
      if (seq !== this.connectionsSeq || this.isDestroyed) return
      const prevConnectionsSig = JSON.stringify(this.connections)
      this.connections = conns || []
      const connsChanged = prevConnectionsSig !== JSON.stringify(this.connections)
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
        if (!hasLocalState && workerSnap?.viewState && typeof workerSnap.viewState === 'object') {
          this.applyRestoredStudioViewState(workerSnap.viewState)
          restoredFromWorker = true
        }
        if (!hasLocalState && !restoredFromWorker && typeof window.orca?.storage?.get === 'function') {
          try {
            const hostSaved = (await window.orca.storage.get(
              STUDIO_VIEW_STATE_STORAGE_KEY
            )) as StudioPersistedViewState | null
            if (seq !== this.connectionsSeq || this.isDestroyed) return
            if (hostSaved && typeof hostSaved === 'object') {
              this.applyRestoredStudioViewState(hostSaved)
            }
          } catch {
            // Ignore host view state read errors
          }
        }
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
      } else if (connsChanged) {
        this.saveStudioDataCache()
      }
    } catch {
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
      const envSuffix = conn.colorTag && conn.colorTag !== 'none' ? ` [${conn.colorTag.toUpperCase()}]` : ''
      const roSuffix = conn.readOnly ? ' [RO]' : ''
      const sshSuffix = conn.sshEnabled ? ' [SSH]' : ''
      const folderTrimmed = (conn.folder || '').trim()
      const connScope = (conn.workspaceScope || '').trim()
      const isCurrentScope = Boolean(connScope && scope && connScope === scope)
      const mtlsSuffix =
        conn.sslCertPath || conn.sslKeyPath
          ? ' [mTLS]'
          : conn.sslCaPath ||
              (conn.sslMode && conn.sslMode !== 'auto' && conn.sslMode !== 'disable')
            ? ' [TLS]'
            : ''
      opt.textContent = `${conn.name} (${conn.driver})${envSuffix}${roSuffix}${sshSuffix}${mtlsSuffix}`
      if (opt.dataset) {
        opt.dataset.driver = conn.driver
        if (isCurrentScope) opt.dataset.isCurrent = '1'
        const sub = conn.filePath || (conn.host ? `${conn.host}:${conn.port || ''}/${conn.database || ''}` : conn.database || '')
        opt.dataset.fullTitle = `${opt.textContent}${folderTrimmed ? ` — Folder: ${folderTrimmed}` : ''}${isCurrentScope ? ' — Current Workspace' : ''}${sub ? ` — ${sub}` : ''}`
      }
      if (conn.id === (targetId || '')) opt.selected = true
      return opt
    }

    const { grouped, groups } = groupConnectionsForSelector(this.connections, this.currentWorkspaceScope)
    if (!grouped) {
      this.connections.forEach((conn) => connSel.appendChild(buildOption(conn)))
    } else {
      for (const grp of groups) {
        const group = document.createElement('optgroup')
        group.label = grp.label
        grp.items.forEach((conn) => group.appendChild(buildOption(conn)))
        connSel.appendChild(group)
      }
    }

    connSel.value = targetId || ''
    enhanceStudioCollapsibleSelect(connSel, {
      tooltipPrefix: 'Active Database Connection',
      searchPlaceholder: 'Search connections or folders...',
      onOpen: () => {
        void this.refreshConnections()
      },
    })
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

      this.schemaObjects = Array.isArray(matchingBootCache?.schemaObjects)
        ? matchingBootCache.schemaObjects
        : []
      this.schemaMap = {}
      this.availableSchemas = Array.isArray(matchingBootCache?.availableSchemas)
        ? matchingBootCache.availableSchemas.filter((s) => typeof s === 'string' && s.length > 0)
        : []
      this.selectedSchema = matchingBootCache?.selectedSchema || undefined
      this.defaultSchema = matchingBootCache?.defaultSchema || undefined
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
      this.currentPageRowCount = 0
      this.lastSelectionSummary = null
      this.updateSelectionStatusDisplay(null)
      this.sqlConsole?.updateSchema({}, '')
      if (connectionId && (!matchingBootCache || this.schemaObjects.length === 0)) {
        this.isIntrospectingSchema = true
        this.renderSidebarSkeleton()
      } else {
        this.isIntrospectingSchema = false
        this.renderSidebarObjects()
      }
      this.dataGrid?.clearSortIndicator()
      this.dataGrid?.setForeignKeys([])
      let hydratedFromWorkerCache = false
      let isTruncatedWorkerPage = false
      if (matchingBootCache?.schemaMap && typeof matchingBootCache.schemaMap === 'object') {
        this.schemaMap = matchingBootCache.schemaMap
        this.sqlConsole?.updateSchema(this.schemaMap, this.activeTable || undefined)
      }
      if (matchingBootCache?.isShowingSqlResult && matchingBootCache.lastSqlResult) {
        this.isShowingSqlResult = true
        this.applyActiveQueryResult(matchingBootCache.lastSqlResult)
        const cachedRes = matchingBootCache.lastSqlResult
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
        this.consumePendingScrollState()
        hydratedFromWorkerCache = true
      } else if (
        matchingBootCache?.pageData &&
        this.doesWarmPageCacheMatchCurrentQuery(matchingBootCache)
      ) {
        const cachedPage = matchingBootCache.pageData
        const connForCache = this.connections.find((c) => c.id === connectionId)
        const readOnly = Boolean(connForCache?.readOnly)
        if (!this.activeTable && matchingBootCache.activeTable) {
          this.activeTable = matchingBootCache.activeTable
          this.activeSchema = matchingBootCache.activeSchema || undefined
        }
        this.lastPageData = cachedPage
        this.lastLoadedTableKey = `${connectionId}:${this.activeSchema || ''}:${this.activeTable || ''}`
        this.currentPage = cachedPage.page || this.currentPage || 1
        this.totalRows = cachedPage.totalRows || 0
        this.currentColCount = cachedPage.columns.length
        this.currentMetricsTruncated = false
        this.currentPageRowCount = Array.isArray(cachedPage.rows) ? cachedPage.rows.length : 0
        const expectedPageRows = Math.min(
          Math.max(0, this.totalRows - (this.currentPage - 1) * this.pageSize),
          this.pageSize
        )
        isTruncatedWorkerPage = this.currentPageRowCount < expectedPageRows
        this.currentCanEdit = Boolean(cachedPage.canEdit) && !readOnly
        this.dataGrid?.setContextMeta(
          this.activeTable || '',
          connForCache?.driver || 'sqlite',
          connectionId || '',
          this.activeSchema || ''
        )
        const cachedKey = `${connectionId}:${this.activeSchema || ''}:${this.activeTable || ''}`
        const savedColCfg = this.columnConfigByTable[cachedKey]
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
        this.consumePendingScrollState()
        hydratedFromWorkerCache = true
      } else {
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

      if (
        hydratedFromWorkerCache &&
        !isTruncatedWorkerPage &&
        this.schemaObjects.length > 0 &&
        this.isWarmCacheFresh(matchingBootCache?.updatedAt)
      ) {
        this.hasLoadedActiveConnection = true
        this.pendingDocConnectionId = null
        this.pendingDocTable = null
        this.pendingDocSchema = undefined
        this.pendingBootDataCache = null
        this.saveStudioDataCache()
      }
    }

    const conn = this.getActiveConnection()
    this.applyActiveConnectionPresentation(conn)
    if (!connectionId || !conn) {
      this.hasLoadedActiveConnection = false
      this.txToolbar.resetLocalStateAndRender()
      return
    }

    void this.refreshTransactionState(conn.id)

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

  private updateSchemaSwitcherDisplay(): void {
    const el = this.schemaSelectEl
    if (!el) return
    const conn = this.getActiveConnection()
    const isSqlEngine = Boolean(conn && conn.driver !== 'redis')
    if (!isSqlEngine || this.availableSchemas.length === 0) {
      el.innerHTML = ''
      el.style.display = 'none'
      return
    }
    el.innerHTML = ''
    for (const schema of this.availableSchemas) {
      const opt = document.createElement('option')
      opt.value = schema
      opt.textContent = schema
      el.appendChild(opt)
    }
    const current =
      this.selectedSchema || this.defaultSchema || this.availableSchemas[0] || ''
    el.value = this.availableSchemas.includes(current) ? current : this.availableSchemas[0] || ''
    el.style.display = 'block'
    syncStudioSelectTooltip(el, 'Active Schema')
  }

  private handleSchemaSelectionChanged(): void {
    const nextSchema = this.schemaSelectEl?.value || undefined
    syncStudioSelectTooltip(this.schemaSelectEl, 'Active Schema')
    this.selectedSchema = nextSchema
    this.activeSchema = nextSchema
    this.activeTable = null
    this.activeObjectKind = null
    this.activeReadOnlyObject = null
    this.lastInspectorLoadedKey = ''
    this.tableLoadToken++
    this.schemaLoadToken++
    if (this.activeConnectionId) {
      void this.introspectSchema(this.activeConnectionId)
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
      copyTextFallback(ddl)
      this.updateStatus(`Copied DDL for ${item.name}`)
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
      if (this.activeViewMode === 'grid' || this.activeViewMode === 'inspector') {
        this.switchMode('split')
      }
      this.updateStatus(`Opened DDL for ${item.name} in SQL Console`)
    } catch (err: unknown) {
      if (this.activeConnectionId !== connId) return
      const msg = err instanceof Error ? err.message : String(err)
      this.updateStatus(`Failed to open DDL: ${msg}`)
    }
  }

  private selectSidebarObject(item: SchemaObject): void {
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
    if (this.activeViewMode === 'grid' || this.activeViewMode === 'inspector') {
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
      topbarCountEl: this.topbarCountEl,
      topbarAllBtn: this.topbarAllBtn,
      topbarTrackEl: this.topbarTrackEl,
      isObjectActive: (name, schema, kind) => this.isObjectActive(name, schema, kind),
      onActivateObject: (item) => this.activateSidebarObject(item),
      onOpenContextMenu: (x, y, item) => this.openSidebarContextMenu(x, y, item),
      onScrollActiveIntoView: () => this.scrollActiveTopbarPillIntoView(),
    })
  }

  private renderSidebarSkeleton(): void {
    renderStudioSidebarSkeleton(this.sidebarListEl, this.topbarTrackEl, this.topbarCountEl)
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
        filterQuery: this.filterQuery,
        activeConnectionId: this.activeConnectionId,
        activeConnection: this.getActiveConnection(),
        collapsedGroups: this.collapsedSidebarGroups,
        isObjectActive: (name, schema, kind) => this.isObjectActive(name, schema, kind),
        onOpenConnectionModal: () => this.openConnectionModal(),
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

  private async introspectSchema(connectionId: string, preservePage = false): Promise<void> {
    if (this.isDestroyed || typeof window === 'undefined' || !window.orca?.plugin?.request) return
    const reqToken = ++this.introspectToken
    const hasWarmCache = Boolean(
      this.pendingBootDataCache && this.pendingBootDataCache.activeConnectionId === connectionId
    )
    if (!hasWarmCache || this.schemaObjects.length === 0) {
      this.isIntrospectingSchema = true
      this.renderSidebarSkeleton()
      this.updateStatus('Loading schema...')
      if (!hasWarmCache) {
        this.dataGrid?.setEmptyMessage('Loading schema...')
      }
    }
    try {
      const schemasPromise = this.requestPlugin<{ schemas: string[]; defaultSchema: string }>(
        'schema.listSchemas',
        { connectionId },
        { timeoutMs: DEFAULT_RPC_TIMEOUT_MS }
      ).catch(() => null)
      const objectsPromise = this.requestPlugin<SchemaObject[]>(
        'schema.listObjects',
        {
          connectionId,
          ...(this.selectedSchema ? { schema: this.selectedSchema } : {}),
        },
        { timeoutMs: DEFAULT_RPC_TIMEOUT_MS }
      )
      const [schemasResult, objects] = await Promise.all([schemasPromise, objectsPromise])
      if (reqToken !== this.introspectToken || this.activeConnectionId !== connectionId) {
        return
      }

      this.isIntrospectingSchema = false
      this.schemaObjects = objects || []
      const listedSchemas =
        schemasResult && Array.isArray(schemasResult.schemas)
          ? schemasResult.schemas.filter((s) => typeof s === 'string' && s.length > 0)
          : []
      const derivedSchemas = Array.from(
        new Set(
          this.schemaObjects
            .map((o) => o.schema)
            .filter((s): s is string => typeof s === 'string' && s.length > 0)
        )
      )
      this.availableSchemas = listedSchemas.length > 0 ? listedSchemas : derivedSchemas
      this.defaultSchema =
        (schemasResult?.defaultSchema || '').trim() ||
        this.availableSchemas[0] ||
        undefined
      if (this.selectedSchema && !this.availableSchemas.includes(this.selectedSchema)) {
        this.selectedSchema = undefined
      }
      this.updateSchemaSwitcherDisplay()
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
        this.currentPageRowCount = 0
        this.currentColCount = 0
        this.currentMetricsTruncated = false
        this.dataGrid?.setEmptyMessage('No objects found in this connection.')
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
        if (reqToken !== this.introspectToken || this.activeConnectionId !== connectionId) {
          return
        }
        if (this.activeViewMode === 'inspector') {
          void this.loadActiveTableSchema()
        }
        void this.prefetchAutocompleteSchema(connectionId, tabularNames, reqToken)
        return
      }
      if (bootCache && bootCache.activeConnectionId === connectionId) {
        this.pendingBootDataCache = null
      }

      await this.loadTableData(connectionId, this.activeTable, initialPage)
      if (reqToken !== this.introspectToken || this.activeConnectionId !== connectionId) {
        return
      }

      if (this.activeViewMode === 'inspector') {
        void this.loadActiveTableSchema()
      }

      void this.prefetchAutocompleteSchema(connectionId, tabularNames, reqToken)
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
      this.queryBannerRetryBtn.style.display = onRetry ? 'inline-flex' : 'none'
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
    if (wasVisible !== visible && this.activeViewMode !== 'inspector') {
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
    this.aiStatus = snapshot
    if (this.aiBtn) {
      const badge = renderAiStatusButtonContent(this.aiBtn, snapshot)
      this.aiBtn.className = `datanoa-btn datanoa-btn-sm datanoa-ai-toolbar-btn datanoa-status-ai-btn tone-${badge.tone}`
    }
    this.syncAiBusyState()
    if (!this.isAiInlineReady()) {
      this.sqlConsole?.clearAiGhost()
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

    const originConnId = tab.executedConnectionId ?? this.activeConnectionId
    const explainConn = tab.executedConnectionId
      ? this.connections.find((c) => c.id === tab.executedConnectionId)
      : this.getActiveConnection()
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

    renderSharedExplainAiPanel(
      this.explainAiEl,
      {
        phase,
        aiEnabled: Boolean(explainRole?.enabled),
        aiReady: explainReady,
        explainLanguage: this.aiStatus?.explainLanguage || 'auto',
        dialect: explainConn?.driver || 'sqlite',
        destination: explainRole?.destination,
        host: explainRole?.host,
        result: rsState.explainAnalysis ?? null,
        error: rsState.explainAnalysisError ?? null,
        collapsed: Boolean(rsState.explainAnalysisCollapsed),
      },
      {
        onAnalyze: () => {
          void this.runExplainAiAnalysis(tab.id, idx)
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
        onCopyText: (text: string, label?: string) => {
          copyTextFallback(text)
          this.updateStatus(`Copied ${label || 'text'} to clipboard`)
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

  private async runExplainAiAnalysis(tabId: string, resultSetIndex: number): Promise<void> {
    const tab = this.consoleTabs.getTabs().find((t) => t.id === tabId)
    if (!tab?.lastResult) return
    const originLastResult = tab.lastResult
    const sets = getEffectiveResultSets(originLastResult, tab.executedSql || '')
    const rs = sets[resultSetIndex]
    const rsState = tab.resultStates?.[resultSetIndex]
    if (!rs || rs.isError || !rsState) return

    if (!this.isExplainAiConfiguredAndEnabled()) {
      this.explainAiSeq += 1
      this.explainAiAbort?.abort()
      this.explainAiAbort = null
      this.explainAiLoadingTarget = null
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
    this.consoleTabs.setResultTabState(
      resultSetIndex,
      { ...rsState, explainAnalysisError: null, explainAnalysisCollapsed: false },
      tabId
    )
    this.renderExplainAiForActiveTab()

    const connId = tab.executedConnectionId || this.activeConnectionId
    const conn = tab.executedConnectionId
      ? this.connections.find((c) => c.id === tab.executedConnectionId)
      : connId
        ? this.getActiveConnection()
        : undefined
    const uiLocale =
      typeof window !== 'undefined'
        ? (window.orca as unknown as { locale?: string } | undefined)?.locale
        : undefined

    try {
      const result = await this.requestPlugin<AiExplainAnalysisResult>(
        'ai.explainAnalyze',
        {
          connectionId: conn?.id,
          dialect: conn?.driver || 'sqlite',
          sql,
          planColumns: rs.columns.map((c) => ({ name: c.name, type: c.type || '' })),
          planRows: rs.rows,
          language: this.aiStatus?.explainLanguage || 'auto',
          uiLocale,
        },
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
        if (this.activeViewMode !== 'inspector') {
          this.dataGrid?.handleViewportResize()
        }
      }
      return
    }

    const fixDialect =
      this.connections.find(
        (c) => c.id === (current.executedConnectionId ?? current.originConnectionId)
      )?.driver ||
      this.getActiveConnection()?.driver ||
      'sqlite'
    renderSharedAiFixPanel(
      this.aiFixEl,
      {
        phase: current.phase,
        aiEnabled: Boolean(explainRole?.enabled),
        aiReady: explainReady,
        dialect: fixDialect,
        destination: explainRole?.destination,
        host: explainRole?.host,
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
        onCopySql: (sql: string) => {
          copyTextFallback(sql)
          this.updateStatus('Copied AI fixed SQL to clipboard')
        },
        onRetry: () => {
          void this.handleFixWithAiClick()
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

    if ((wasHidden || current.phase === 'ready' || current.phase === 'error') && this.activeViewMode !== 'inspector') {
      this.dataGrid?.handleViewportResize()
    }
  }

  private async handleFixWithAiClick(): Promise<void> {
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
    const conn = activeTab?.executedConnectionId
      ? (this.connections.find((c) => c.id === activeTab.executedConnectionId) ??
        this.getActiveConnection())
      : this.getActiveConnection()
    const executedConnectionId = conn?.id ?? originConnectionId

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
          connectionId: conn?.id,
          dialect: conn?.driver || 'sqlite',
          sql: failedSql,
          errorMessage,
          activeSchema: isSameActiveConn ? this.selectedSchema : undefined,
          activeTable: isSameActiveConn ? (this.activeTable ?? undefined) : undefined,
          schemaMap: isSameActiveConn ? this.schemaMap : {},
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
      showBackToTable?: boolean
      isExplain?: boolean
      failedSql?: string
      fixTargetRange?: SqlFixTargetRange | null
    }
  ): void {
    this.clearAiFixPanel()
    const banner: ResultBannerState = {
      kind,
      title,
      detail,
      dismissed: false,
      showBackToTable: opts?.showBackToTable,
      errorText: kind === 'error' ? detail || title : undefined,
      isExplain: opts?.isExplain,
      failedSql: opts?.failedSql,
      fixTargetRange: opts?.fixTargetRange ?? null,
    }
    this.activeResultBannerState = banner
    this.queryBannerRetryHandler = opts?.onRetry ?? null
    if (!this.queryBannerEl || !this.queryBannerTitleEl || !this.queryBannerDetailEl) return
    this.renderQueryBannerDom(banner, opts?.onRetry ?? null)
    this.setQueryBannerVisible(this.shouldShowActiveBannerInViewMode())
  }

  private hideQueryBanner(): void {
    this.activeResultBannerState = null
    this.lastQueryErrorText = ''
    this.queryBannerRetryHandler = null
    if (this.queryBannerFixAiBtn) {
      this.queryBannerFixAiBtn.style.display = 'none'
    }
    if (this.queryBannerReportBtn) {
      this.queryBannerReportBtn.style.display = 'none'
    }
    if (this.queryBannerRetryBtn) {
      this.queryBannerRetryBtn.style.display = 'none'
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
      const filteredSql =
        !sanitizedWhere && !sanitizedOrderBy
          ? cleanBase
          : `SELECT * FROM (${cleanBase}) AS _datanoa_filter${sanitizedWhere ? ` WHERE ${sanitizedWhere}` : ''}${sanitizedOrderBy ? ` ORDER BY ${sanitizedOrderBy}` : ''}`
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
    return `${this.activeConnectionId || ''}:${this.activeSchema || ''}:${this.activeTable || ''}`
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
    const targetTableKey = `${connectionId}:${targetSchema || ''}:${table}`
    const isSameTable = this.lastLoadedTableKey === targetTableKey
    const preservedScrollLeft = isSameTable ? (this.dataGrid?.getScrollLeft() ?? 0) : 0
    const viewSeq = ++this.gridViewSeq
    const loadToken = ++this.tableLoadToken
    this.isTableLoading = true
    this.updatePaginationButtons()
    try {
      const wasShowingSqlResult = this.isShowingSqlResult
      this.isShowingSqlResult = false
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
        this.dataGrid?.setData({
          ...pageData,
          canEdit: this.currentCanEdit,
        })
      }
      this.lastPageData = pageData
      this.lastLoadedTableKey = targetTableKey
      if (this.pendingScrollState) {
        this.consumePendingScrollState()
      } else if (isSameTable && preservedScrollLeft > 0) {
        this.dataGrid?.setScrollLeft(preservedScrollLeft)
      }
      if (this.dmlPreviewEl) this.dmlPreviewEl.style.display = 'none'

      const totalPages = Math.max(1, Math.ceil(this.totalRows / this.pageSize))
      this.currentColCount = pageData.columns.length
      this.currentMetricsTruncated = false
      if (this.gridSubbarTitleEl) {
        this.gridSubbarTitleEl.textContent = readOnly
          ? `${table} · RO`
          : table
      }
      if (this.gridPageInfoEl) {
        this.gridPageInfoEl.textContent = `Page ${this.currentPage} / ${totalPages} (${this.totalRows} rows)`
      }
      this.updateStagedActionButtons(0)
      this.updatePaginationButtons()
      this.updateExportDropdownOptions()
      this.saveStudioViewState(true)
      this.saveStudioDataCache()
      this.updateStatus(
        `Loaded ${table}`,
        formatGridStatusMetrics(this.totalRows, this.currentColCount)
      )

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
      this.currentColCount = 0
      this.currentMetricsTruncated = false
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
      this.updateStatus(`Error loading ${table}: ${msg}`, '0 rows')
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

    if (existingState?.gridSnapshot) {
      this.editableSqlTarget = existingState.editableSqlTarget
        ? { ...existingState.editableSqlTarget }
        : null
      this.activeEditableStmtSql = existingState.activeEditableStmtSql || ''
      this.currentCanEdit = Boolean(existingState.currentCanEdit)
      this.dataGrid?.restoreRuntimeState(existingState.gridSnapshot)
      this.updateFindCounter(this.dataGrid?.getFindState())
      if (this.gridSubbarTitleEl) {
        this.gridSubbarTitleEl.textContent = existingState.gridSubbarTitle || 'SQL Result'
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

    const isSameConnection = Boolean(
      tab.executedConnectionId &&
      this.activeConnectionId &&
      tab.executedConnectionId === this.activeConnectionId
    )
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
    if (this.isShowingSqlResult) {
      return this.editableSqlTarget
        ? { table: this.editableSqlTarget.table, schema: this.editableSqlTarget.schema }
        : null
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
          const direct = this.tableDetailsCache?.get(`${targetConnId}:${sch || ''}:${tbl}`)
          if (direct) return direct
          if (sch) return undefined
          return this.tableDetailsCache?.get(`${targetConnId}::${tbl}`)
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
    if (!res || !sets || sets.length <= 1 || this.activeViewMode === 'inspector') {
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

  private promptBindParams(
    sql: string,
    dialect: DatabaseDriverType,
    params: DetectedSqlParam[],
    onRun: (boundSql: string) => void
  ): void {
    const expectedConnId = this.activeConnectionId
    const ctx: StudioBindParamsModalContext = {
      mountModal: (modalEl, canClose) => this.mountStudioModal(modalEl, canClose),
      closeModal: () => this.closeActiveModal(),
      sql,
      dialect,
      params,
      rememberedValues: this.rememberedBindParams,
      onConfirm: (boundSql, nextValues) => {
        if (this.activeConnectionId !== expectedConnId) {
          this.updateStatus('Connection changed — query cancelled')
          return
        }
        this.rememberedBindParams = { ...this.rememberedBindParams, ...nextValues }
        onRun(boundSql)
      },
    }
    openStudioBindParamsModal(ctx)
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
    execRangeOverride?: SqlExecutionRange | null
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
        this.promptBindParams(sqlText, driver, detectedParams, (boundSql) => {
          void this.executeSql(executeAll, true, boundSql, skipDangerGuard, execRange)
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
            void this.executeSql(executeAll, true, sqlText, true, execRange)
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
    execRangeOverride?: SqlExecutionRange | null
  ): Promise<void> {
    if (
      !this.sqlConsole ||
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
    const explainStmts =
      driver === 'redis'
        ? [sqlText]
        : splitSqlStatements(sqlText, driver)
            .map((s) => s.text.trim())
            .filter(Boolean)
    if (explainStmts.length === 0) {
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
        this.promptBindParams(sqlText, driver, detectedParams, (boundSql) => {
          void this.explainSql(true, boundSql, skipDangerGuard, execRange)
        })
        return
      }
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
            void this.explainSql(true, sqlText, true, execRange)
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
      if (!tab || !tab.lastResult || this.activeConnectionId !== targetConnId) return
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
          this.dataGrid?.revertAllChanges()
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
      const baseSql = (this.activeExecutedSql || this.sqlConsole?.getText() || '').trim()
      const injected = injectSqlColumnFilter(baseSql, column, value, op, driver)
      if (injected.ok && this.sqlConsole) {
        this.sqlConsole.setText(injected.sql)
        await this.executeSql(false)
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
    const mounted = mountStudioColumnsPopover(this.dataGrid, this.columnsBtn, () => {
      this.closeColumnsPopover()
    })
    this.colsPopoverEl = mounted.popoverEl
    this.colsPopoverOutsideCleanup = mounted.outsideCleanup
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
    backdrop.appendChild(modalEl)
    this.activeModalDismiss = onDismiss ?? null
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop && canClose()) {
        this.closeActiveModal()
      }
    })
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      const onKey = (ev: KeyboardEvent) => {
        if (ev.key === 'Escape') {
          if (document.querySelector('.datanoa-fp-overlay')) return
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
          if (this.storedActiveConnectionId === deletedId) this.storedActiveConnectionId = null
          if (this.pendingDocConnectionId === deletedId) this.pendingDocConnectionId = null
          if (this.activeConnectionId === deletedId) this.handleConnectionChanged(null)
          this.updateStatus('Connection deleted')
          await this.refreshConnections()
        },
      },
      editProfile
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
    const cacheKey = `${connId}:${schemaName || ''}:${tableName}`
    let targetColumns: ColumnInfo[] = []
    const cachedDetails = this.tableDetailsCache.get(cacheKey)
    if (cachedDetails && cachedDetails.columns.length > 0) {
      targetColumns = cachedDetails.columns
    } else if (
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
      this.isObjectActive(tableName, schemaName) &&
      !this.isShowingSqlResult &&
      this.currentCanEdit &&
      this.dataGrid !== null

    openStudioImportModal({
      mountModal: (modalEl, canClose) => this.mountStudioModal(modalEl, canClose),
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
          !this.isObjectActive(tableName, schemaName) ||
          this.isShowingSqlResult ||
          !this.currentCanEdit
        ) {
          return 0
        }
        return this.dataGrid.stageImportedRows(records)
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
        this.handleConnectionChanged(connId)
        this.updateMetadataHeader('connectionId', connId)
      },
      openConnectionModal: (editProfile) => this.openConnectionModal(editProfile),
      formatSqlInConsole: () => this.formatSqlInConsole(),
      openCreateTableModal: () => this.openCreateTableModal(),
      openImportDataModal: () => {
        void this.openImportDataModal()
      },
      setSidebarCollapsed: (collapsed, persist) =>
        this.setSidebarCollapsed(collapsed, persist),
      switchMode: (mode) => this.switchMode(mode),
      toggleQueryHistory: () => this.toggleQueryHistory(),
      openSavedQueriesModal: () => this.openSavedQueriesModal(),
      handleRefreshAction: () => this.handleRefreshAction(),
      openShortcutsModal: () => this.openShortcutsModal(),
      openFeedbackModal: (initialKind) => this.openFeedbackModal(initialKind),
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
        activeViewMode: this.activeViewMode,
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
        this.updateStatus(`Cell '${params.column}' saved successfully`)
        return res
      }
      this.updateStatus(`Conflict: cell '${params.column}' was modified concurrently`)
      return { ok: false }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      this.updateStatus(`Update failed: ${msg}`)
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
    this.importModalOpenSeq++
    this.queryHistoryDrawer.bumpSeq()
    this.dmlPreviewSeq++
    this.countRowsSeq++
    this.txToolbar.rollbackOnUnload()
    this.txToolbar.destroy()
    this.activeConnectionId = null
    this.cancelledQueryIds.clear()
    this.inFlightTableDetails.clear()
    this.stopAllTimers()

    if (this.scrollRestoreRafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.scrollRestoreRafId)
      this.scrollRestoreRafId = null
    }

    this.valueInspector.destroy()
    this.queryHistoryDrawer.destroy()

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
