// src/panel/panel-sql.js
// Side Panel CodeMirror SQL Console, Console Tabs, Multi-Result Tabs, Multi-EXPLAIN,
// virtualized SQL Result Grid, export, and Query History

import {
  splitSqlStatements,
  panelContainsDdlStatement,
  findStatementAtOffset,
  formatExportData,
  formatSelectionAsOutput,
  formatRelativeTime,
  analyzeDangerousSql,
  comparePanelCellValues,
} from './panel-core.js'
import {
  PANEL_SQL_EDITOR_MIN_HEIGHT,
  PANEL_SQL_EDITOR_DEFAULT_HEIGHT,
  PANEL_SQL_EDITOR_HARD_MAX_HEIGHT,
  clampPanelSqlEditorHeight,
  computePanelSqlEditorBounds,
  createPanelConsoleTabsManager,
} from './panel-sql-tabs.js'
import { createPanelCodeMirrorEditor } from './panel-cm.js'
import { isActiveSqlStatementSensitive } from '../shared-cm-inline-ai.js'
import {
  renderAiStatusButtonContent,
  renderSharedAiFixPanel,
  renderSharedExplainAiPanel,
  resolveExplainAiPhase,
} from '../shared-ai-ui.js'
import {
  remapSqlTargetRange,
  resolveSqlReplacementSpan,
  splitExplainTargetStatements,
} from '../shared-sql-core.js'
import { extractSqlParameters } from '../shared-sql-params.js'
import {
  createRememberedBindParamsStore,
  openSharedBindParamsModal,
} from '../shared-bind-params-modal.js'
import { resolveExecutionErrorFixTarget } from '../shared-sql-diagnostics.js'
import { containsSensitiveSqlText } from '../shared-sql-safety.js'
import {
  getEffectiveResultSets,
  getDefaultResultSetIndex,
  buildSingleSetQueryResult,
  buildInitialPanelResultStates,
  buildCombinedExplainResult,
  buildErrorQueryResult,
  compactSqlPreview,
} from './panel-result-sets.js'
import {
  $,
  setDbLogoElement,
  rpc,
  setButtonLoading,
  createElapsedTimer,
  downloadTextFile,
  createSortSvg,
  syncVirtualTableWindow,
} from './panel-utils.js'

const DEFAULT_PANEL_SQL = 'SELECT * FROM sqlite_master LIMIT 25;'

export function getPanelEditorPlaceholder(driver) {
  if (driver === 'redis') return 'SCAN 0 MATCH * COUNT 50'
  if (driver === 'mongodb') return 'db.getCollection("users").find({}).limit(25)'
  return 'SELECT * FROM table_name LIMIT 25;'
}

export function getPanelDangerFindingBadgeLabel(kind, driver) {
  if (driver === 'mongodb') {
    switch (kind) {
      case 'delete_without_where':
        return 'DELETE ALL DOCUMENTS'
      case 'update_without_where':
        return 'UPDATE ALL DOCUMENTS'
      case 'drop':
        return 'DROP COLLECTION / DB'
      default:
        return 'DESTRUCTIVE COMMAND'
    }
  }
  switch (kind) {
    case 'delete_without_where':
      return 'DELETE WITHOUT WHERE'
    case 'update_without_where':
      return 'UPDATE WITHOUT WHERE'
    case 'drop':
      return 'DROP OBJECT'
    case 'truncate':
      return 'TRUNCATE TABLE'
    default:
      return 'DESTRUCTIVE SQL'
  }
}

export function findMongoStatementAtOffset(script, offset) {
  const safeScript = String(script || '')
  if (!safeScript.trim()) return ''
  const pos = Math.max(
    0,
    Math.min(Number.isFinite(offset) ? offset : safeScript.length, safeScript.length)
  )
  return findStatementAtOffset(safeScript, pos, 'mongodb').trim()
}

export function splitPanelTargetStatements(sql, driver) {
  return splitExplainTargetStatements(sql, driver)
}

export function createPanelSqlController(ctx) {
  const {
    state,
    QUERY_TIMEOUT_MS,
    VIRT_ROW_HEIGHT_PX,
    getActiveConn,
    getConnById,
    getSqlGridSel,
    getSuppressSortClickUntil,
    setLastPanelCopiedText,
    computeVirtualRange,
    attachColumnResizeHandle,
    copyText,
    showBanner,
    loadSchema,
    savePanelViewState,
    scheduleSavePanelViewState,
    savePanelDataCache,
    onFormatSql,
    getAiStatus,
    openAiSettingsModal,
    onRefreshAiStatus,
  } = ctx

  let sqlRunSeq = 0
  let cancelledSqlRunSeq = 0
  let historySeq = 0
  let sqlStopTimer = null
  let sortedSqlRowsCache = { res: null, colIdx: null, dir: 'ASC', rows: [] }
  let dismissedSqlBannerKey = null
  let explainAiAbort = null
  let explainAiSeq = 0
  let explainAiLoadingTarget = null
  let aiFixAbort = null
  let aiFixSeq = 0
  let aiFixState = null
  let pendingConfirmedInlineAi = null
  let boundFixAiBtn = null
  let activeSqlBannerKey = null
  let lastSqlBannerConnId = null
  let pendingDangerSqlConfirm = null
  let boundDangerSqlModal = null

  function getDangerFindingBadgeLabel(kind, driver) {
    return getPanelDangerFindingBadgeLabel(kind, driver)
  }

  function closePanelDangerSqlModal() {
    pendingDangerSqlConfirm = null
    const modal = $('dangerSqlModal')
    if (modal) modal.hidden = true
  }

  function ensureDangerSqlModalListeners() {
    const modal = $('dangerSqlModal')
    const checkEl = $('dangerSqlConfirmCheck')
    const inputEl = $('dangerSqlConfirmInput')
    const cancelBtn = $('dangerSqlCancelBtn')
    const execBtn = $('dangerSqlExecuteBtn')
    if (!modal || !cancelBtn || !execBtn || !checkEl) return false
    if (boundDangerSqlModal === modal) return true
    boundDangerSqlModal = modal

    const syncGate = () => {
      if (!pendingDangerSqlConfirm) return
      const curCheck = $('dangerSqlConfirmCheck')
      const curInput = $('dangerSqlConfirmInput')
      const checked = Boolean(curCheck?.checked)
      if (!pendingDangerSqlConfirm.isProd) {
        execBtn.disabled = !checked
        return
      }
      const matched = String(curInput?.value || '').trim() === 'CONFIRM'
      execBtn.disabled = !(checked && matched)
    }

    checkEl.addEventListener('change', syncGate)
    inputEl?.addEventListener('input', syncGate)
    inputEl?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !execBtn.disabled) {
        e.preventDefault()
        execBtn.click()
      }
    })
    cancelBtn.addEventListener('click', () => {
      closePanelDangerSqlModal()
    })
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closePanelDangerSqlModal()
    })
    execBtn.addEventListener('click', () => {
      if (execBtn.disabled || !pendingDangerSqlConfirm) return
      const confirmFn = pendingDangerSqlConfirm.onConfirm
      closePanelDangerSqlModal()
      confirmFn?.()
    })
    return true
  }

  function openPanelDangerSqlModal({ conn, findings, sql, onConfirm }) {
    const modal = $('dangerSqlModal')
    const cancelBtn = $('dangerSqlCancelBtn')
    const execBtn = $('dangerSqlExecuteBtn')
    const checkEl = $('dangerSqlConfirmCheck')
    const inputEl = $('dangerSqlConfirmInput')
    const envTag = String(conn?.colorTag || '').trim().toLowerCase()
    const isProd = envTag === 'prod' || envTag === 'production'
    const isStaging = envTag === 'staging'
    const connName = conn?.name || 'Active Connection'

    // Fail-closed: never auto-confirm if required confirmation modal DOM is missing
    if (!modal || !cancelBtn || !execBtn || !checkEl || (isProd && !inputEl)) {
      pendingDangerSqlConfirm = null
      showBanner?.(
        'Cannot open destructive SQL confirmation modal — execution aborted for safety.',
        'danger'
      )
      return
    }
    if (!ensureDangerSqlModalListeners()) {
      pendingDangerSqlConfirm = null
      showBanner?.(
        'Cannot open destructive SQL confirmation modal — execution aborted for safety.',
        'danger'
      )
      return
    }

    pendingDangerSqlConfirm = { isProd, onConfirm }

    const badgeEl = $('dangerSqlBadge')
    if (badgeEl) {
      badgeEl.textContent = `${findings.length} ${findings.length === 1 ? 'warning' : 'warnings'}`
    }

    const envWarnEl = $('dangerSqlEnvWarn')
    if (envWarnEl) {
      if (isProd) {
        envWarnEl.className = 'banner danger'
        envWarnEl.textContent = `[PRODUCTION CONNECTION]: "${connName}". Any destructive changes directly affect live production data!`
        envWarnEl.hidden = false
      } else if (isStaging) {
        envWarnEl.className = 'banner warn'
        envWarnEl.textContent = `[STAGING CONNECTION]: "${connName}".`
        envWarnEl.hidden = false
      } else {
        envWarnEl.hidden = true
        envWarnEl.textContent = ''
      }
    }

    const findingsEl = $('dangerSqlFindings')
    if (findingsEl) {
      findingsEl.textContent = ''
      for (const finding of findings) {
        const row = document.createElement('div')
        row.className = 'banner danger danger-sql-finding-item'
        const b = document.createElement('span')
        b.className = 'badge badge-danger'
        b.style.flexShrink = '0'
        b.textContent = getDangerFindingBadgeLabel(finding.kind, conn?.driver)
        const msg = document.createElement('span')
        msg.className = 'banner-text'
        msg.textContent = finding.message
        row.append(b, msg)
        findingsEl.appendChild(row)
      }
    }

    const previewEl = $('dangerSqlPreview')
    if (previewEl) {
      previewEl.textContent = String(sql || '').trim()
    }

    const gateEl = $('dangerSqlProdGate')
    const checkTextEl = $('dangerSqlConfirmCheckText')
    const inputWrapEl = $('dangerSqlConfirmInputWrap')
    if (gateEl) gateEl.hidden = false
    if (checkTextEl) {
      checkTextEl.textContent = isProd
        ? 'I understand this query modifies live production data'
        : 'I understand this query may permanently modify or delete data'
    }
    if (inputWrapEl) {
      inputWrapEl.hidden = !isProd
    } else if (inputEl) {
      inputEl.hidden = !isProd
    }
    checkEl.checked = false
    if (inputEl) inputEl.value = ''
    execBtn.disabled = true

    modal.hidden = false
    cancelBtn.focus?.()
  }
  let suppressCmSync = false
  let currentSchemaMap = {}
  let currentSchemaTable = undefined

  let consoleTabs = createPanelConsoleTabsManager(DEFAULT_PANEL_SQL)

  const sqlVirt = {
    active: false,
    columns: [],
    sortedRows: [],
    tbody: null,
    topSpacerTr: null,
    topSpacerTd: null,
    bottomSpacerTr: null,
    bottomSpacerTd: null,
    start: -1,
    end: -1,
    rafId: null,
  }

  const mountEl = $('sqlEditorMount')
  const resizerEl = $('sqlEditorResizer')
  let customSqlEditorHeight = null
  let activeResizerCleanup = null
  let cmEditor = null

  function syncSqlVimModePill(snap) {
    const pill = $('sqlVimModePill')
    if (!pill) return
    if (!snap || snap.preset !== 'vim' || !snap.badge) {
      pill.hidden = true
      pill.dataset.vimMode = 'normal'
      pill.textContent = 'NORMAL'
      return
    }
    pill.hidden = false
    pill.dataset.vimMode = snap.mode || 'normal'
    pill.textContent = snap.badge
  }

  function applySqlKeymapSettings(nextSettings) {
    cmEditor?.applyKeymapSettings?.(nextSettings)
    syncSqlVimModePill(cmEditor?.getVimModeSnapshot?.())
  }

  function isSqlVimEscapeTarget(target) {
    return Boolean(cmEditor?.isVimTargetEvent?.(target))
  }

  if (mountEl) {
    try {
      cmEditor = createPanelCodeMirrorEditor({
        parent: mountEl,
        initialDoc: DEFAULT_PANEL_SQL,
        dialect: getActiveConn()?.driver || 'sqlite',
        schema: currentSchemaMap,
        isLightTheme: Boolean(
          typeof document !== 'undefined' &&
            (document.documentElement.classList.contains('light') ||
              document.body?.classList.contains('light'))
        ),
        onVimModeChange: (snap) => syncSqlVimModePill(snap),
        aiInline: {
          isEnabled: () => isPanelAiReady() && Boolean(getActiveConn()),
          getConnectionId: () => state.activeConnectionId,
          requestCompletion: async ({ prefix, suffix, signal, manual, mode }) => {
            const conn = getActiveConn()
            if (!conn) return null
            if (isActiveSqlStatementSensitive(prefix, suffix, conn.driver || 'sqlite', mode)) return null
            const reqMode = mode === 'edit' ? 'edit' : manual ? 'complete' : 'auto'
            const pending = pendingConfirmedInlineAi
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
              pendingConfirmedInlineAi = null
            }
            try {
              return await rpc(
                'ai.complete',
                {
                  connectionId: conn.id,
                  dialect: conn.driver || 'sqlite',
                  prefix,
                  suffix,
                  ...(manual ? { manual: true } : {}),
                  ...(mode && mode !== 'auto' ? { mode } : {}),
                  ...(isConfirmedManual ? { confirmed: true } : {}),
                  activeSchema: state.activeSchema || undefined,
                  activeTable: state.activeTable || undefined,
                  schemaMap: currentSchemaMap,
                },
                { signal, timeoutMs: 25000 }
              )
            } catch (err) {
              if (!signal?.aborted) {
                void onRefreshAiStatus?.()
              }
              throw err
            }
          },
          onRequestError: (err, ctx) => {
            const errMode = ctx?.mode === 'complete' ? 'complete' : 'edit'
            const msg =
              err instanceof Error
                ? err.message
                : String(err || (errMode === 'complete' ? 'AI completion failed' : 'Inline AI edit failed'))
            const targetConnId = ctx?.connectionId ?? state.activeConnectionId
            const conn = targetConnId ? getConnById?.(targetConnId) || null : null
            const rawPolicy = conn?.aiPolicy
            const rawTag = String(conn?.colorTag || '').trim().toLowerCase()
            const effectivePolicy =
              rawPolicy === 'never' || rawPolicy === 'ask' || rawPolicy === 'allow'
                ? rawPolicy
                : rawTag === 'prod' || rawTag === 'production'
                  ? 'ask'
                  : 'allow'
            const isBlocked = /ai\.blocked/i.test(msg)
            const isNever = /\bpolicy:\s*never\b|disabled for this connection/i.test(msg) || effectivePolicy === 'never'
            if (isBlocked && !isNever && targetConnId) {
              const retryLabel =
                errMode === 'complete' ? 'Confirm & Retry AI Completion' : 'Confirm & Retry AI Edit'
              const boundPrefix = typeof ctx?.prefix === 'string' ? ctx.prefix : ''
              const boundSuffix = typeof ctx?.suffix === 'string' ? ctx.suffix : ''
              showBanner(msg, 'warn', {
                retryLabel,
                onRetry: () => {
                  pendingConfirmedInlineAi = {
                    connectionId: targetConnId,
                    mode: errMode,
                    prefix: boundPrefix,
                    suffix: boundSuffix,
                  }
                  cmEditor?.focus?.()
                  cmEditor?.view?.contentDOM?.dispatchEvent(
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
            showBanner(msg, 'danger')
          },
          onMetric: (id, kind) => {
            void rpc('ai.metrics.event', { id, kind }).catch(() => {})
          },
        },
        onExecute: () => void runSql('caret'),
        onExecuteAll: () => void runSql('all'),
        onFormatSql: () => onFormatSql?.(),
        onChange: (doc) => {
          if (suppressCmSync) return
          consoleTabs.updateActiveSql(doc, cmEditor?.getCursorOffset?.())
          scheduleSavePanelViewState?.(350)
        },
      })
      syncSqlVimModePill(cmEditor?.getVimModeSnapshot?.())
    } catch {
      cmEditor = null
    }
  }

  function getSqlContainerHeight() {
    const tabSql = $('tabSql')
    if (!tabSql) return 0
    const rectH = tabSql.getBoundingClientRect?.().height
    if (Number.isFinite(rectH) && rectH > 0) return rectH
    return Number(tabSql.clientHeight) || 0
  }

  function applySqlEditorHeight(
    desiredPx,
    { persist = false, preservePreferred = false, cachedContainerH = null, skipMeasure = false } = {}
  ) {
    if (!mountEl) return PANEL_SQL_EDITOR_DEFAULT_HEIGHT
    const parsed = Number(desiredPx)
    const preferredClamped = Number.isFinite(parsed)
      ? Math.max(
          PANEL_SQL_EDITOR_MIN_HEIGHT,
          Math.min(PANEL_SQL_EDITOR_HARD_MAX_HEIGHT, Math.round(parsed))
        )
      : PANEL_SQL_EDITOR_DEFAULT_HEIGHT
    const containerH = cachedContainerH !== null ? cachedContainerH : getSqlContainerHeight()
    const bounds = computePanelSqlEditorBounds(containerH)
    const clamped = clampPanelSqlEditorHeight(preferredClamped, containerH)
    if (!preservePreferred) {
      customSqlEditorHeight = containerH > 0 ? clamped : preferredClamped
    }
    mountEl.style.height = `${clamped}px`
    if (resizerEl) {
      resizerEl.setAttribute('aria-valuemin', String(bounds.min))
      resizerEl.setAttribute('aria-valuemax', String(bounds.max))
      resizerEl.setAttribute('aria-valuenow', String(clamped))
    }
    if (!skipMeasure) {
      cmEditor?.view?.requestMeasure?.()
    }
    if (persist) {
      scheduleSavePanelViewState?.(150)
    }
    return clamped
  }

  function applyClampedSqlEditorHeight() {
    if (customSqlEditorHeight === null) {
      if (resizerEl) {
        const bounds = computePanelSqlEditorBounds(getSqlContainerHeight())
        resizerEl.setAttribute('aria-valuemin', String(bounds.min))
        resizerEl.setAttribute('aria-valuemax', String(bounds.max))
      }
      return
    }
    applySqlEditorHeight(customSqlEditorHeight, { persist: false, preservePreferred: true })
  }

  function setSqlEditorHeight(heightPx, { persist = false } = {}) {
    if (!Number.isFinite(Number(heightPx))) return null
    return applySqlEditorHeight(Number(heightPx), { persist })
  }

  function getSqlEditorHeight() {
    return customSqlEditorHeight
  }

  let activeSqlDragCancel = null

  if (mountEl && resizerEl && typeof window !== 'undefined') {
    let activeDrag = null
    let windowResizeRafId = null
    let windowResizeRafPending = false

    const stopDrag = (shouldPersist) => {
      if (!activeDrag) return
      const { kind, onMove, onEnd, onKeyDown, flushPending, cancelRaf, tabSql } = activeDrag
      activeDrag = null
      cancelRaf()
      if (shouldPersist) {
        flushPending()
      }
      if (kind === 'pointer') {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onEnd)
        window.removeEventListener('pointercancel', onEnd)
      } else {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onEnd)
      }
      window.removeEventListener('blur', onEnd)
      window.removeEventListener('keydown', onKeyDown)
      resizerEl.classList.remove('is-resizing')
      tabSql?.classList?.remove('is-split-resizing')
      if (document.body) {
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
      ctx.setPanelViewportResizing?.(false)
      cmEditor?.view?.requestMeasure?.()
      if (shouldPersist) {
        scheduleSavePanelViewState?.(150)
      }
    }
    activeSqlDragCancel = () => stopDrag(false)

    const startDrag = (e) => {
      if (e.button !== undefined && e.button !== 0) return
      if (activeDrag) return
      e.preventDefault()
      const kind = e.type === 'pointerdown' ? 'pointer' : 'mouse'
      const startY = Number(e.clientY) || 0
      const tabSql = $('tabSql')
      const cachedContainerH = getSqlContainerHeight()
      const bounds = computePanelSqlEditorBounds(cachedContainerH)
      const rectH = mountEl.getBoundingClientRect?.().height
      const startH =
        Number.isFinite(rectH) && rectH > 0
          ? rectH
          : clampPanelSqlEditorHeight(
              customSqlEditorHeight ?? PANEL_SQL_EDITOR_DEFAULT_HEIGHT,
              cachedContainerH
            )
      let pendingH = clampPanelSqlEditorHeight(startH, cachedContainerH)
      let lastAppliedH = -1
      let dragRafId = null
      let dragRafPending = false

      resizerEl.setAttribute('aria-valuemin', String(bounds.min))
      resizerEl.setAttribute('aria-valuemax', String(bounds.max))
      resizerEl.classList.add('is-resizing')
      tabSql?.classList?.add('is-split-resizing')
      ctx.setPanelViewportResizing?.(true)
      if (document.body) {
        document.body.style.cursor = 'row-resize'
        document.body.style.userSelect = 'none'
      }

      const flushPending = () => {
        dragRafPending = false
        dragRafId = null
        if (pendingH === lastAppliedH) return
        lastAppliedH = pendingH
        applySqlEditorHeight(pendingH, {
          persist: false,
          cachedContainerH,
          skipMeasure: true,
        })
      }

      const cancelRaf = () => {
        dragRafPending = false
        if (dragRafId !== null && typeof cancelAnimationFrame === 'function') {
          cancelAnimationFrame(dragRafId)
          dragRafId = null
        }
      }

      const onMove = (moveEv) => {
        if (moveEv.isTrusted && typeof moveEv.buttons === 'number' && moveEv.buttons === 0) {
          stopDrag(true)
          return
        }
        const dy = (Number(moveEv.clientY) || 0) - startY
        const nextH = Math.max(bounds.min, Math.min(bounds.max, Math.round(startH + dy)))
        if (nextH === pendingH) return
        pendingH = nextH
        if (typeof requestAnimationFrame === 'function') {
          if (!dragRafPending) {
            dragRafPending = true
            const id = requestAnimationFrame(flushPending)
            dragRafId = dragRafPending ? id : null
          }
        } else {
          flushPending()
        }
      }
      const onEnd = () => stopDrag(true)
      const onKeyDown = (keyEv) => {
        if (keyEv.key === 'Escape') {
          keyEv.preventDefault()
          stopDrag(false)
        }
      }
      activeDrag = { kind, onMove, onEnd, onKeyDown, flushPending, cancelRaf, tabSql }
      if (kind === 'pointer') {
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onEnd)
        window.addEventListener('pointercancel', onEnd)
      } else {
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onEnd)
      }
      window.addEventListener('blur', onEnd)
      window.addEventListener('keydown', onKeyDown)
    }

    const onDblClick = () => {
      applySqlEditorHeight(PANEL_SQL_EDITOR_DEFAULT_HEIGHT, { persist: true })
    }

    const onKeyDown = (e) => {
      const containerH = getSqlContainerHeight()
      const bounds = computePanelSqlEditorBounds(containerH)
      const rectH = mountEl.getBoundingClientRect?.().height
      const currentH =
        Number.isFinite(rectH) && rectH > 0
          ? Math.round(rectH)
          : clampPanelSqlEditorHeight(
              customSqlEditorHeight ?? PANEL_SQL_EDITOR_DEFAULT_HEIGHT,
              containerH
            )
      let targetH = null
      if (e.key === 'ArrowDown') targetH = currentH + 24
      else if (e.key === 'ArrowUp') targetH = currentH - 24
      else if (e.key === 'Home') targetH = bounds.min
      else if (e.key === 'End') targetH = bounds.max
      else if (e.key === 'Enter' || e.key === ' ') targetH = PANEL_SQL_EDITOR_DEFAULT_HEIGHT
      if (targetH === null) return
      e.preventDefault()
      applySqlEditorHeight(targetH, { persist: true })
    }

    const onWindowResize = () => {
      if (typeof requestAnimationFrame === 'function') {
        if (!windowResizeRafPending) {
          windowResizeRafPending = true
          const id = requestAnimationFrame(() => {
            windowResizeRafPending = false
            windowResizeRafId = null
            applyClampedSqlEditorHeight()
          })
          windowResizeRafId = windowResizeRafPending ? id : null
        }
      } else {
        applyClampedSqlEditorHeight()
      }
    }
    resizerEl.addEventListener('pointerdown', startDrag)
    resizerEl.addEventListener('mousedown', startDrag)
    resizerEl.addEventListener('dblclick', onDblClick)
    resizerEl.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', onWindowResize)

    activeResizerCleanup = () => {
      stopDrag(false)
      windowResizeRafPending = false
      if (windowResizeRafId !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(windowResizeRafId)
        windowResizeRafId = null
      }
      resizerEl.removeEventListener('pointerdown', startDrag)
      resizerEl.removeEventListener('mousedown', startDrag)
      resizerEl.removeEventListener('dblclick', onDblClick)
      resizerEl.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', onWindowResize)
    }
  }

  function getSqlText() {
    if (cmEditor) return cmEditor.getValue()
    return consoleTabs.getActiveTab()?.sql ?? ''
  }

  function setSqlText(nextSql, opts = {}) {
    const val = String(nextSql ?? '')
    consoleTabs.updateActiveSql(val)
    if (cmEditor) {
      suppressCmSync = true
      try {
        cmEditor.setValue(val)
        if (typeof opts.cursorOffset === 'number') {
          cmEditor.setCursorOffset(opts.cursorOffset)
        }
      } finally {
        suppressCmSync = false
      }
    }
    if (!opts.skipSave) {
      savePanelViewState?.()
    }
    if (opts.focus) {
      focusSqlEditor()
    }
  }

  function focusSqlEditor() {
    cmEditor?.focus?.()
  }

  function setSqlDialect(driver) {
    cmEditor?.setDialect?.(driver || 'sqlite')
  }

  function setSqlSchema(schemaMap, activeTable) {
    currentSchemaMap = schemaMap && typeof schemaMap === 'object' ? schemaMap : {}
    currentSchemaTable = activeTable || undefined
    cmEditor?.setSchema?.(currentSchemaMap, currentSchemaTable)
    if (isPanelAiReady() && getActiveConn()) {
      cmEditor?.notifyAiAvailabilityChanged?.()
    }
  }

  function setSqlColorScheme(isLight) {
    cmEditor?.setColorScheme?.(Boolean(isLight))
  }

  function setSqlTypography(typo) {
    cmEditor?.setTypography?.(typo)
  }

  function openSqlFindReplace() {
    cmEditor?.openFindReplace?.()
  }

  function destroySqlEditor() {
    clearAiFixPanel()
    if (boundFixAiBtn) {
      boundFixAiBtn.removeEventListener('click', handleFixWithAiClick)
      boundFixAiBtn = null
    }
    explainAiSeq += 1
    explainAiAbort?.abort()
    explainAiAbort = null
    explainAiLoadingTarget = null
    const explainPanel = $('sqlExplainAiPanel')
    if (explainPanel) {
      renderSharedExplainAiPanel(
        explainPanel,
        {
          phase: 'hidden',
          aiEnabled: false,
          aiReady: false,
          explainLanguage: getAiStatus?.()?.explainLanguage || 'auto',
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
    if (activeResizerCleanup) {
      activeResizerCleanup()
      activeResizerCleanup = null
    }
    cmEditor?.destroy?.()
    cmEditor = null
  }

  function resetSqlSafetyBannerDismissal() {
    dismissedSqlBannerKey = null
  }

  function dismissSqlSafetyBanner() {
    if (activeSqlBannerKey) {
      dismissedSqlBannerKey = activeSqlBannerKey
    }
    const banner = $('sqlProdBanner')
    if (banner) banner.hidden = true
  }

  function renderSqlSafetyBanner() {
    const conn = getActiveConn()
    const banner = $('sqlProdBanner')
    const connId = conn?.id || null
    if (connId !== lastSqlBannerConnId) {
      lastSqlBannerConnId = connId
      dismissedSqlBannerKey = null
    }
    if (!conn) {
      activeSqlBannerKey = null
      if (banner) banner.hidden = true
      return
    }
    let kind = null
    let cls = 'banner warn'
    let msg = ''
    const normColorTag = String(conn.colorTag || '').trim().toLowerCase()
    const isProdConn = normColorTag === 'prod' || normColorTag === 'production'
    if (conn.readOnly && isProdConn) {
      kind = 'prod-ro'
      cls = 'banner warn'
      msg = 'PROD + READ-ONLY — Mutating SQL, MQL, and Redis commands are blocked by worker policy.'
    } else if (isProdConn) {
      kind = 'prod'
      cls = 'banner warn'
      msg = 'PROD environment — review statements carefully before executing.'
    } else if (conn.readOnly) {
      kind = 'ro'
      cls = 'banner warn'
      msg = 'READ-ONLY connection — mutating commands and DDL are blocked.'
    }

    const bannerKey = kind ? `${conn.id}:${kind}` : null
    activeSqlBannerKey = bannerKey

    if (banner) {
      if (!bannerKey) {
        banner.hidden = true
      } else {
        banner.className = cls
        const textEl = $('sqlProdBannerText')
        if (textEl) textEl.textContent = msg
        banner.hidden = dismissedSqlBannerKey === bannerKey
      }
    }

    cmEditor?.setPlaceholder?.(getPanelEditorPlaceholder(conn.driver))
    setSqlDialect(conn.driver || 'sqlite')
    if (isPanelAiReady()) {
      cmEditor?.notifyAiAvailabilityChanged?.()
    }
  }

  function renderConsoleTabs() {
    const bar = $('sqlConsoleTabsBar')
    if (!bar) return
    const tabs = consoleTabs.getTabs()
    const activeId = consoleTabs.getActiveTabId()
    bar.textContent = ''

    tabs.forEach((tab) => {
      const tabEl = document.createElement('div')
      tabEl.className = `sql-console-tab${tab.id === activeId ? ' active' : ''}`
      tabEl.setAttribute('role', 'tab')
      tabEl.setAttribute('aria-selected', String(tab.id === activeId))
      tabEl.tabIndex = 0

      const titleSpan = document.createElement('span')
      titleSpan.className = 'sql-console-tab-title'
      titleSpan.textContent = tab.title
      titleSpan.title = `${tab.title} (Double-click or press F2 to rename)`

      const startRename = (e) => {
        e.stopPropagation()
        if (tabEl.querySelector('.sql-console-tab-rename')) return
        const input = document.createElement('input')
        input.type = 'text'
        input.className = 'sql-console-tab-rename'
        input.value = tab.title
        input.maxLength = 40
        titleSpan.replaceWith(input)
        let committed = false
        const commit = () => {
          if (committed) return
          committed = true
          if (input.value.trim()) {
            consoleTabs.renameTab(tab.id, input.value)
            savePanelViewState?.()
          }
          renderConsoleTabs()
        }
        input.addEventListener('blur', commit)
        input.addEventListener('keydown', (ke) => {
          if (ke.key === 'Enter') {
            ke.preventDefault()
            commit()
          } else if (ke.key === 'Escape') {
            committed = true
            renderConsoleTabs()
          }
        })
        input.focus()
        input.select()
      }

      tabEl.addEventListener('click', () => switchConsoleTab(tab.id))
      tabEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          switchConsoleTab(tab.id)
        } else if (e.key === 'F2') {
          startRename(e)
        }
      })
      titleSpan.addEventListener('dblclick', startRename)
      tabEl.appendChild(titleSpan)

      if (tabs.length > 1) {
        const closeBtn = document.createElement('button')
        closeBtn.type = 'button'
        closeBtn.className = 'sql-console-tab-close'
        closeBtn.textContent = '×'
        closeBtn.title = `Close ${tab.title}`
        closeBtn.setAttribute('aria-label', `Close ${tab.title}`)
        closeBtn.addEventListener('click', (e) => {
          e.stopPropagation()
          closeConsoleTab(tab.id)
        })
        tabEl.appendChild(closeBtn)
      }

      bar.appendChild(tabEl)
    })

    const addBtn = document.createElement('button')
    addBtn.type = 'button'
    addBtn.className = 'sql-console-tab-add'
    addBtn.textContent = '+'
    addBtn.title = 'New SQL Console Tab'
    addBtn.setAttribute('aria-label', 'New SQL Console Tab')
    addBtn.addEventListener('click', () => addConsoleTab())
    bar.appendChild(addBtn)
  }

  function saveActiveConsoleTabState() {
    if (cmEditor) {
      consoleTabs.updateActiveSql(cmEditor.getValue(), cmEditor.getCursorOffset())
    }
    captureActiveResultTabState()
  }

  function captureActiveResultTabState() {
    const activeTab = consoleTabs.getActiveTab()
    if (!activeTab?.lastResult) return
    const idx = activeTab.activeResultSetIndex || 0
    const curState = consoleTabs.getResultTabState(idx, activeTab.id)
    if (!curState) return
    curState.sortColIdx = state.sqlSortColIdx ?? null
    curState.sortDir = state.sqlSortDir || 'ASC'
    curState.colWidths = Array.isArray(state.sqlColWidths) ? [...state.sqlColWidths] : []
    curState.scrollTop = $('sqlResultWrap')?.scrollTop ?? curState.scrollTop ?? 0
    consoleTabs.setResultTabState(idx, curState, activeTab.id)
  }

  function loadActiveConsoleTabEditor() {
    const tab = consoleTabs.getActiveTab()
    suppressCmSync = true
    try {
      if (cmEditor) {
        cmEditor.setValue(tab.sql || '')
        cmEditor.setCursorOffset(tab.cursorOffset ?? 0)
      }
    } finally {
      suppressCmSync = false
    }
    renderConsoleTabs()
  }

  function clearSqlResultDisplay() {
    state.lastSqlResult = null
    state.sqlSortColIdx = null
    state.sqlSortDir = 'ASC'
    state.sqlColWidths = []
    sortedSqlRowsCache = { res: null, colIdx: null, dir: 'ASC', rows: [] }
    sqlVirt.active = false
    sqlVirt.sortedRows = []
    sqlVirt.columns = []
    sqlVirt.start = -1
    sqlVirt.end = -1
    getSqlGridSel()?.clear(true)
    const bar = $('sqlResultSetsBar')
    if (bar) {
      bar.hidden = true
      bar.textContent = ''
    }
    if ($('sqlSuccessBanner')) $('sqlSuccessBanner').hidden = true
    if ($('sqlErrorBanner')) $('sqlErrorBanner').hidden = true
    if ($('sqlFixAiBtn')) $('sqlFixAiBtn').hidden = true
    if ($('sqlMetaBadge')) $('sqlMetaBadge').hidden = true
    if ($('sqlResultWrap')) $('sqlResultWrap').hidden = true
    if ($('sqlResultMeta')) $('sqlResultMeta').hidden = true
    clearAiGhost()
    clearDbSyntaxError()
    clearAiFixPanel()
    renderExplainAiForActiveTab()
  }

  function clearAiGhost() {
    cmEditor?.clearAiGhost?.()
  }

  function setDbSyntaxError(errorMessage, targetRange, driver) {
    cmEditor?.setDbSyntaxError?.(errorMessage, targetRange ?? null, driver)
  }

  function clearDbSyntaxError() {
    cmEditor?.clearDbSyntaxError?.()
  }

  function getAiRoleStatus(role) {
    const s = getAiStatus?.()
    if (!s) return null
    return s.roles?.[role] ?? s
  }

  function isPanelAiReady() {
    const auto = getAiRoleStatus('autocomplete')
    return Boolean(auto?.enabled && auto.state !== 'off' && auto.state !== 'setup')
  }

  function syncPanelAiButton() {
    const btn = $('sqlAiBtn')
    if (!btn) return
    const badge = renderAiStatusButtonContent(btn, getAiStatus?.())
    btn.className = `btn btn-ghost btn-sm datanoa-ai-toolbar-btn tone-${badge.tone}`
    syncPanelAiBusyState()
  }

  function syncPanelAiBusyState() {
    const busy = aiFixState?.phase === 'loading' || explainAiLoadingTarget !== null
    $('sqlAiBtn')?.classList.toggle('is-ai-busy', busy)
  }

  function isExplainAiConfiguredAndEnabled() {
    const exp = getAiRoleStatus('explain')
    return Boolean(exp?.enabled && exp.state !== 'off' && exp.state !== 'setup')
  }

  function clearAiFixPanel() {
    aiFixSeq += 1
    aiFixAbort?.abort()
    aiFixAbort = null
    aiFixState = null
    renderAiFixPanel()
  }

  function renderAiFixPanel() {
    syncPanelAiBusyState()
    const panel = $('sqlAiFixPanel')
    if (!panel) return
    const exp = getAiRoleStatus('explain')
    const explainReady = isExplainAiConfiguredAndEnabled()
    const current = aiFixState
    if (!current || current.phase === 'hidden') {
      renderSharedAiFixPanel(
        panel,
        {
          phase: 'hidden',
          aiEnabled: Boolean(exp?.enabled),
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
      return
    }

    const fixConnId = current.executedConnId ?? current.originConnId
    const fixConn = fixConnId ? getConnById?.(fixConnId) || null : null
    const fixDialect = fixConn?.driver || 'sqlite'
    renderSharedAiFixPanel(
      panel,
      {
        phase: current.phase,
        aiEnabled: Boolean(exp?.enabled),
        aiReady: explainReady,
        dialect: fixDialect,
        destination: exp?.destination,
        host: exp?.host,
        colorTag: fixConn?.colorTag,
        aiPolicy: fixConn?.aiPolicy,
        pendingConfirm: Boolean(current.pendingConfirm),
        result: current.result || null,
        error: current.error || null,
      },
      {
        onReplaceQuery: (sql) => {
          if (
            state.activeConnectionId !== current.originConnId ||
            consoleTabs.getActiveTabId() !== current.originTabId
          ) {
            clearAiFixPanel()
            return
          }
          const target = current.fixTargetRange
            ? { ...current.fixTargetRange, fallbackSql: current.failedSql, preserveOtherStatements: true }
            : { from: -1, to: -1, fallbackSql: current.failedSql, preserveOtherStatements: true }
          const prevDoc = getSqlText()
          const expectedEdit = resolveSqlReplacementSpan(prevDoc, target, sql, fixDialect)
          if (cmEditor?.replaceSqlRange) {
            const replaced = cmEditor.replaceSqlRange(target, sql, fixDialect)
            if (!replaced) {
              showBanner(
                'Could not safely match failed statement in multi-statement script — use Copy SQL to apply manually.',
                'warn'
              )
              return
            }
            consoleTabs.updateActiveSql(cmEditor.getValue(), cmEditor.getCursorOffset())
            savePanelViewState?.()
          } else {
            if (!expectedEdit) {
              showBanner(
                'Could not safely match failed statement in multi-statement script — use Copy SQL to apply manually.',
                'warn'
              )
              return
            }
            setSqlText(
              `${prevDoc.slice(0, expectedEdit.from)}${expectedEdit.insert}${prevDoc.slice(expectedEdit.to)}`,
              { focus: true }
            )
          }
          if (expectedEdit) {
            remapPanelTabResultTargetsAfterEdit(
              current.originTabId,
              expectedEdit.from,
              expectedEdit.to,
              expectedEdit.insert.length
            )
          }
          clearAiFixPanel()
          showBanner('Replaced query with AI fix (Ctrl+Z to undo)', 'success')
        },
        onCopySql: (sql) => {
          void copyText(sql, 'Fixed SQL copied')
        },
        onFixQuery: (fixOpts) => {
          void handleFixWithAiClick(fixOpts)
        },
        onRetry: (fixOpts) => {
          void handleFixWithAiClick(fixOpts)
        },
        onCancel: () => {
          clearAiFixPanel()
        },
        onDismiss: () => {
          clearAiFixPanel()
        },
        onConfigureAi: () => {
          void openAiSettingsModal?.('explain')
        },
        resizeEdge: 'bottom',
      }
    )
  }

  async function handleFixWithAiClick(options = {}) {
    const tab = consoleTabs.getActiveTab()
    const idx = tab?.activeResultSetIndex || 0
    const rsState = tab?.resultStates?.[idx]
    const b = rsState?.banner
    if (!tab || !b || b.kind !== 'error') return

    const failedSql = String(b.failedSql || rsState?.statementSql || tab.executedSql || '').trim()
    if (!failedSql) return

    const errorMessage = String(b.errorMessage || b.text || 'Query failed')
    const fixTargetRange = b.fixTargetRange || null
    const originTabId = tab.id
    const originResultSetIndex = idx
    const originConnId = state.activeConnectionId
    const originLastResult = tab.lastResult

    if (!isExplainAiConfiguredAndEnabled()) {
      aiFixSeq += 1
      aiFixAbort?.abort()
      aiFixAbort = null
      aiFixState = {
        phase: 'error',
        result: null,
        error:
          'Explain & Fix AI is not configured or disabled. Enable Explain & Fix in AI Settings to fix SQL errors.',
        failedSql,
        errorMessage,
        fixTargetRange,
        originTabId,
        originResultSetIndex,
        originConnId,
        originLastResult,
      }
      renderAiFixPanel()
      return
    }

    const recordedConnId =
      typeof tab.executedConnectionId === 'string' && tab.executedConnectionId.length > 0
        ? tab.executedConnectionId
        : typeof b.connectionId === 'string' && b.connectionId.length > 0
          ? b.connectionId
          : undefined
    const lookupConnId = recordedConnId ?? originConnId
    const conn = lookupConnId ? getConnById?.(lookupConnId) || null : null
    const executedConnId = recordedConnId ?? conn?.id ?? originConnId

    const rawPolicy = conn?.aiPolicy
    const rawTag = String(conn?.colorTag || '').trim().toLowerCase()
    const effectivePolicy =
      rawPolicy === 'never' || rawPolicy === 'ask' || rawPolicy === 'allow'
        ? rawPolicy
        : rawTag === 'prod' || rawTag === 'production'
          ? 'ask'
          : 'allow'

    if (effectivePolicy === 'never') {
      aiFixSeq += 1
      aiFixAbort?.abort()
      aiFixAbort = null
      aiFixState = {
        phase: 'error',
        result: null,
        error: 'AI assistance is disabled for this connection (policy: never).',
        failedSql,
        errorMessage,
        fixTargetRange,
        originTabId,
        originResultSetIndex,
        originConnId,
        executedConnId,
        originLastResult,
      }
      renderAiFixPanel()
      return
    }

    if (effectivePolicy === 'ask' && options?.confirmed !== true) {
      aiFixSeq += 1
      aiFixAbort?.abort()
      aiFixAbort = null
      aiFixState = {
        phase: 'idle',
        pendingConfirm: true,
        result: null,
        error: null,
        failedSql,
        errorMessage,
        fixTargetRange,
        originTabId,
        originResultSetIndex,
        originConnId,
        executedConnId,
        originLastResult,
      }
      renderAiFixPanel()
      return
    }

    if (containsSensitiveSqlText(failedSql) || containsSensitiveSqlText(errorMessage)) {
      aiFixSeq += 1
      aiFixAbort?.abort()
      aiFixAbort = null
      aiFixState = {
        phase: 'error',
        result: null,
        error:
          'Query or error message appears to contain sensitive credentials/secrets and was not sent to AI.',
        failedSql,
        errorMessage,
        fixTargetRange,
        originTabId,
        originResultSetIndex,
        originConnId,
        executedConnId,
        originLastResult,
      }
      renderAiFixPanel()
      return
    }

    aiFixAbort?.abort()
    const ac = new AbortController()
    aiFixAbort = ac
    const seq = ++aiFixSeq

    aiFixState = {
      phase: 'loading',
      result: null,
      error: null,
      failedSql,
      errorMessage,
      fixTargetRange,
      originTabId,
      originResultSetIndex,
      originConnId,
      executedConnId,
      originLastResult,
    }
    renderAiFixPanel()

    const ai = getAiStatus?.()
    const isSameActiveConn = conn?.id === state.activeConnectionId

    try {
      const result = await rpc(
        'ai.fixQuery',
        {
          connectionId: executedConnId ?? '',
          fromConnection: true,
          dialect: conn?.driver || 'sqlite',
          sql: failedSql,
          errorMessage,
          activeSchema: isSameActiveConn ? state.activeSchema || undefined : undefined,
          activeTable: isSameActiveConn ? state.activeTable || undefined : undefined,
          schemaMap: isSameActiveConn ? currentSchemaMap : {},
          ...(options?.confirmed === true ? { confirmed: true } : {}),
          language: ai?.explainLanguage || 'auto',
          uiLocale: typeof window !== 'undefined' ? window.orca?.locale : undefined,
        },
        { signal: ac.signal, timeoutMs: 65000 }
      )
      const tabNow = consoleTabs.getActiveTab()
      if (
        seq !== aiFixSeq ||
        ac.signal.aborted ||
        state.activeConnectionId !== originConnId ||
        !tabNow ||
        tabNow.id !== originTabId ||
        (tabNow.activeResultSetIndex || 0) !== originResultSetIndex ||
        tabNow.lastResult !== originLastResult
      ) {
        return
      }
      aiFixState = {
        phase: 'ready',
        result,
        error: null,
        failedSql,
        errorMessage,
        fixTargetRange,
        originTabId,
        originResultSetIndex,
        originConnId,
        executedConnId,
        originLastResult,
      }
      const latest = consoleTabs.getResultTabState(originResultSetIndex, originTabId)
      if (latest) {
        consoleTabs.setResultTabState(
          originResultSetIndex,
          { ...latest, aiFixResult: result, aiFixError: null },
          originTabId
        )
      }
      renderAiFixPanel()
    } catch (err) {
      const tabNow = consoleTabs.getActiveTab()
      if (
        seq !== aiFixSeq ||
        ac.signal.aborted ||
        state.activeConnectionId !== originConnId ||
        !tabNow ||
        tabNow.id !== originTabId ||
        (tabNow.activeResultSetIndex || 0) !== originResultSetIndex ||
        tabNow.lastResult !== originLastResult
      ) {
        return
      }
      const msg = err instanceof Error ? err.message : String(err)
      aiFixState = {
        phase: 'error',
        result: null,
        error: msg,
        failedSql,
        errorMessage,
        fixTargetRange,
        originTabId,
        originResultSetIndex,
        originConnId,
        executedConnId,
        originLastResult,
      }
      const latest = consoleTabs.getResultTabState(originResultSetIndex, originTabId)
      if (latest) {
        consoleTabs.setResultTabState(
          originResultSetIndex,
          { ...latest, aiFixResult: null, aiFixError: msg },
          originTabId
        )
      }
      renderAiFixPanel()
    } finally {
      if (aiFixAbort === ac) {
        aiFixAbort = null
      }
      if (!ac.signal.aborted) {
        void onRefreshAiStatus?.()
      }
    }
  }

  function remapPanelTabResultTargetsAfterEdit(tabId, editFrom, editTo, insertLen) {
    const tab = consoleTabs.getTabs().find((t) => t.id === tabId)
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
          consoleTabs.setResultTabState(
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
    if (aiFixState?.originTabId === tabId && aiFixState.fixTargetRange) {
      aiFixState = {
        ...aiFixState,
        fixTargetRange: remapSqlTargetRange(aiFixState.fixTargetRange, editFrom, editTo, insertLen),
      }
    }
  }

  function resolvePanelStatementRange(
    targetSql,
    idx,
    totalSets,
    stmtSlices,
    execRange,
    resultIndex
  ) {
    if (!execRange) return null
    const normStmt = (s) => String(s || '').trim().replace(/;\s*$/, '').trim()
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

  function attachPanelFixTargets(
    resultStates,
    res,
    overallSql,
    driver,
    execRange,
    failedStatementIndex = null,
    expectedStatementCount = null
  ) {
    const sets = getEffectiveResultSets(res, overallSql)
    const stmtSlices =
      driver === 'redis'
        ? []
        : splitSqlStatements(execRange ? execRange.sql : overallSql, driver)
    const resolvedFailedIdx =
      typeof failedStatementIndex === 'number' &&
      Number.isInteger(failedStatementIndex) &&
      failedStatementIndex >= 0
        ? failedStatementIndex
        : typeof res?.executionError?.failedStatementIndex === 'number' &&
            Number.isInteger(res.executionError.failedStatementIndex) &&
            res.executionError.failedStatementIndex >= 0
          ? res.executionError.failedStatementIndex
          : null
    const resolvedStmtCount =
      typeof expectedStatementCount === 'number' &&
      Number.isInteger(expectedStatementCount) &&
      expectedStatementCount > 0
        ? expectedStatementCount
        : typeof res?.executionError?.statementCount === 'number' &&
            Number.isInteger(res.executionError.statementCount) &&
            res.executionError.statementCount > 0
          ? res.executionError.statementCount
          : null
    sets.forEach((rs, idx) => {
      const st = resultStates[idx]
      if (!st?.banner || st.banner.kind !== 'error') return
      let failedSql = String(st.statementSql || rs.sql || overallSql || '').trim()
      if (!failedSql) return
      const errMsg = rs.errorMessage || st.banner.text || ''
      let fixTargetRange
      if (sets.length === 1 && stmtSlices.length > 1) {
        const resolved = resolveExecutionErrorFixTarget(
          execRange,
          failedSql,
          errMsg,
          stmtSlices,
          driver,
          resolvedFailedIdx,
          resolvedStmtCount
        )
        failedSql = resolved.failedSql
        fixTargetRange = resolved.fixTargetRange
      } else {
        fixTargetRange = resolvePanelStatementRange(
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
        errorMessage: errMsg,
        fixTargetRange,
      }
    })
  }

  function formatExplainRawRowsText(rs) {
    if (!rs || !Array.isArray(rs.rows) || rs.rows.length === 0) return ''
    const cols = Array.isArray(rs.columns) ? rs.columns : []
    const formatCell = (val) => {
      if (val === null || val === undefined) return ''
      if (typeof val === 'string') return val
      try {
        return JSON.stringify(val, null, 2)
      } catch {
        return String(val)
      }
    }
    if (cols.length <= 1) {
      const colName = cols[0]?.name
      const lines = []
      for (const row of rs.rows) {
        if (Array.isArray(row)) {
          lines.push(formatCell(row[0]))
        } else if (row && typeof row === 'object') {
          const val = colName && colName in row ? row[colName] : Object.values(row)[0]
          lines.push(formatCell(val))
        } else {
          lines.push(formatCell(row))
        }
      }
      return lines.join('\n')
    }
    const header = cols.map((c) => String(c.name ?? '')).join('\t')
    const body = rs.rows.map((row) =>
      cols
        .map((c, idx) => {
          const raw = Array.isArray(row) ? row[idx] : row?.[c.name]
          return raw === null || raw === undefined
            ? 'NULL'
            : typeof raw === 'object'
              ? JSON.stringify(raw)
              : String(raw)
        })
        .join('\t')
    )
    return [header, ...body].join('\n')
  }

  function attachPanelExplainTargets(resultStates, res, overallSql, driver, execRange, meta = {}) {
    const sets = getEffectiveResultSets(res, overallSql)
    const stmtSlices =
      execRange && driver !== 'redis' ? splitSqlStatements(execRange.sql, driver) : []
    sets.forEach((rs, idx) => {
      const st = resultStates[idx]
      if (!st) return
      st.connectionId = meta.connectionId
      st.dialect = meta.dialect || driver
      st.activeSchema = meta.activeSchema
      if (meta.colorTag !== undefined) st.colorTag = meta.colorTag
      if (meta.aiPolicy !== undefined) st.aiPolicy = meta.aiPolicy
      const rawRowsText = formatExplainRawRowsText(rs)
      if (rawRowsText) {
        st.rawPlanText = rawRowsText
        rs.rawPlanText = rawRowsText
      }
      const stmtSql = String(st.statementSql || rs.sql || overallSql || '').trim()
      if (!stmtSql) return
      st.explainTargetRange = resolvePanelStatementRange(
        stmtSql,
        idx,
        sets.length,
        stmtSlices,
        execRange,
        rs.index
      )
    })
  }

  function renderExplainAiForActiveTab() {
    syncPanelAiBusyState()
    const panel = $('sqlExplainAiPanel')
    if (!panel) return
    const tab = consoleTabs.getActiveTab()
    const idx = tab?.activeResultSetIndex || 0
    const res = tab?.lastResult
    const sets = res ? getEffectiveResultSets(res, tab.executedSql || '') : []
    const rs = sets[idx]
    const rsState = tab?.resultStates?.[idx]
    const ai = getAiStatus?.()
    const exp = getAiRoleStatus('explain')
    const explainReady = isExplainAiConfiguredAndEnabled()
    const show = Boolean(tab && res && rs && !rs.isError && rsState?.isExplain)

    if (!show) {
      $('sqlResultWrap')?.classList?.remove?.('has-explain-ai-panel')
      renderSharedExplainAiPanel(
        panel,
        {
          phase: 'hidden',
          aiEnabled: Boolean(exp?.enabled),
          aiReady: explainReady,
          explainLanguage: ai?.explainLanguage || 'auto',
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
      return
    }

    const isLoading = Boolean(
      explainAiLoadingTarget &&
        explainAiLoadingTarget.tabId === tab.id &&
        explainAiLoadingTarget.resultSetIndex === idx &&
        explainAiLoadingTarget.originLastResult === res
    )
    const phase = resolveExplainAiPhase(
      isLoading,
      rsState.explainAnalysisError,
      rsState.explainAnalysis
    )

    const explainConnId = rsState.connectionId ?? tab.executedConnectionId
    const explainConn = explainConnId ? getConnById?.(explainConnId) : getActiveConn()
    $('sqlResultWrap')?.classList?.toggle?.(
      'has-explain-ai-panel',
      !rsState.explainAnalysisCollapsed
    )
    const resolvedSchema =
      'activeSchema' in rsState ? rsState.activeSchema : state.activeSchema || undefined
    const explainPanelState = {
      phase,
      aiEnabled: Boolean(exp?.enabled),
      aiReady: explainReady,
      explainLanguage: ai?.explainLanguage || 'auto',
      dialect: explainConn?.driver || rsState.dialect || 'sqlite',
      destination: exp?.destination,
      host: exp?.host,
      colorTag: explainConn?.colorTag ?? rsState.colorTag,
      aiPolicy: explainConn?.aiPolicy ?? rsState.aiPolicy,
      activeSchema: resolvedSchema,
      explainPlan: rs.explainPlan ?? null,
      rawPlanText: rsState.rawPlanText || rs.rawPlanText || null,
      ...(rsState.explainViewMode === 'visual' ||
      rsState.explainViewMode === 'raw' ||
      rsState.explainViewMode === 'ai'
        ? { explainViewMode: rsState.explainViewMode }
        : {}),
      result: rsState.explainAnalysis || null,
      error: rsState.explainAnalysisError || null,
      collapsed: Boolean(rsState.explainAnalysisCollapsed),
    }
    renderSharedExplainAiPanel(
      panel,
      explainPanelState,
      {
        onAnalyze: (analyzeOpts) => void runExplainAiAnalysis(tab.id, idx, analyzeOpts),
        onExplainViewChange: (nextView) => {
          explainPanelState.explainViewMode = nextView
          const cur = consoleTabs.getResultTabState(idx, tab.id)
          if (!cur) return
          consoleTabs.setResultTabState(idx, { ...cur, explainViewMode: nextView }, tab.id)
        },
        onConfigureAi: () => {
          void openAiSettingsModal?.('explain')
        },
        onCancel: () => {
          explainAiSeq += 1
          explainAiAbort?.abort()
          explainAiAbort = null
          explainAiLoadingTarget = null
          renderExplainAiForActiveTab()
        },
        onApplySql: (sql) => {
          if (
            (tab.executedConnectionId && state.activeConnectionId !== tab.executedConnectionId) ||
            consoleTabs.getActiveTabId() !== tab.id
          ) {
            return
          }
          const latestRsState = consoleTabs.getResultTabState(idx, tab.id) || rsState
          const target = {
            ...(latestRsState.explainTargetRange ?? { from: -1, to: -1 }),
            fallbackSql: latestRsState.statementSql,
            preserveOtherStatements: true,
          }
          const conn = tab.executedConnectionId
            ? getConnById?.(tab.executedConnectionId)
            : getActiveConn()
          const dialect = conn?.driver || 'sqlite'
          const prevDoc = getSqlText()
          const expectedEdit = resolveSqlReplacementSpan(prevDoc, target, sql, dialect)
          if (cmEditor?.replaceSqlRange) {
            const replaced = cmEditor.replaceSqlRange(target, sql, dialect)
            if (!replaced) {
              showBanner(
                'Could not safely match target query in multi-statement script — use Copy SQL to apply manually.',
                'warn'
              )
              return
            }
            consoleTabs.updateActiveSql(cmEditor.getValue(), cmEditor.getCursorOffset())
            savePanelViewState?.()
          } else {
            if (!expectedEdit) {
              showBanner(
                'Could not safely match target query in multi-statement script — use Copy SQL to apply manually.',
                'warn'
              )
              return
            }
            setSqlText(
              `${prevDoc.slice(0, expectedEdit.from)}${expectedEdit.insert}${prevDoc.slice(expectedEdit.to)}`
            )
          }
          if (expectedEdit) {
            remapPanelTabResultTargetsAfterEdit(
              tab.id,
              expectedEdit.from,
              expectedEdit.to,
              expectedEdit.insert.length
            )
            if (!latestRsState.explainTargetRange) {
              const postState = consoleTabs.getResultTabState(idx, tab.id) || latestRsState
              const totalStmts =
                dialect === 'redis'
                  ? 1
                  : Math.max(sets.length, splitSqlStatements(prevDoc, dialect).length)
              consoleTabs.setResultTabState(
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
          saveActiveConsoleTabState()
          cmEditor?.focus()
          showBanner('Replaced target query with optimized SQL (Ctrl+Z to undo)', 'neutral')
        },
        onOpenNewTab: (sql) => {
          addConsoleTab()
          setSqlText(sql)
          saveActiveConsoleTabState()
          cmEditor?.focus()
          showBanner('Opened optimized SQL in a new tab', 'neutral')
        },
        onCopyText: (text, label) => {
          void copyText(text, `${label || 'Text'} copied`)
        },
        onToggleCollapsed: () => {
          const cur = consoleTabs.getResultTabState(idx, tab.id)
          if (!cur) return
          consoleTabs.setResultTabState(
            idx,
            { ...cur, explainAnalysisCollapsed: !cur.explainAnalysisCollapsed },
            tab.id
          )
          renderExplainAiForActiveTab()
        },
        resizeEdge: 'top',
      }
    )
  }

  async function runExplainAiAnalysis(tabId, resultSetIndex, analyzeOpts = {}) {
    const tab = consoleTabs.getTabs().find((t) => t.id === tabId)
    if (!tab?.lastResult) return
    const originLastResult = tab.lastResult
    const sets = getEffectiveResultSets(originLastResult, tab.executedSql || '')
    const rs = sets[resultSetIndex]
    const rsState = tab.resultStates?.[resultSetIndex]
    if (!rs || rs.isError || !rsState) return

    if (!isExplainAiConfiguredAndEnabled()) {
      explainAiSeq += 1
      explainAiAbort?.abort()
      explainAiAbort = null
      explainAiLoadingTarget = null
      consoleTabs.setResultTabState(
        resultSetIndex,
        {
          ...rsState,
          explainAnalysisError:
            'Explain & Fix AI is not configured or disabled. Enable Explain & Fix in AI Settings to analyze query plans.',
          explainAnalysisCollapsed: false,
          explainViewMode: 'ai',
        },
        tabId
      )
      renderExplainAiForActiveTab()
      return
    }

    const sql = rsState.statementSql || rs.sql || tab.executedSql || ''
    if (containsSensitiveSqlText(sql)) {
      explainAiSeq += 1
      explainAiAbort?.abort()
      explainAiAbort = null
      explainAiLoadingTarget = null
      consoleTabs.setResultTabState(
        resultSetIndex,
        {
          ...rsState,
          explainAnalysisError:
            'Query appears to contain sensitive credentials/secrets and was not sent to AI.',
          explainAnalysisCollapsed: false,
          explainViewMode: 'ai',
        },
        tabId
      )
      renderExplainAiForActiveTab()
      return
    }

    explainAiAbort?.abort()
    const ac = new AbortController()
    explainAiAbort = ac
    const seq = ++explainAiSeq
    explainAiLoadingTarget = { tabId, resultSetIndex, originLastResult }
    consoleTabs.setResultTabState(
      resultSetIndex,
      { ...rsState, explainAnalysisError: null, explainAnalysisCollapsed: false, explainViewMode: 'ai' },
      tabId
    )
    renderExplainAiForActiveTab()

    const explainConnId = rsState.connectionId ?? tab.executedConnectionId
    const conn = explainConnId ? getConnById?.(explainConnId) || null : getActiveConn()
    const ai = getAiStatus?.()
    const activeSchema =
      analyzeOpts?.activeSchema ??
      ('activeSchema' in rsState ? rsState.activeSchema : state.activeSchema || undefined)

    try {
      const result = await rpc(
        'ai.explainAnalyze',
        {
          connectionId: conn?.id ?? explainConnId ?? '',
          fromConnection: true,
          dialect: conn?.driver || rsState.dialect || 'sqlite',
          sql,
          planColumns: (rs.columns || []).map((c) => ({ name: c.name, type: c.type || '' })),
          planRows: rs.rows || [],
          ...(rs.explainPlan ? { explainPlan: rs.explainPlan } : {}),
          ...(activeSchema ? { activeSchema } : {}),
          ...(analyzeOpts?.confirmed !== undefined
            ? { confirmed: Boolean(analyzeOpts.confirmed) }
            : {}),
          language: ai?.explainLanguage || 'auto',
          uiLocale: typeof window !== 'undefined' ? window.orca?.locale : undefined,
        },
        { signal: ac.signal, timeoutMs: 65000 }
      )
      if (seq !== explainAiSeq || ac.signal.aborted) return
      const tabNow = consoleTabs.getTabs().find((t) => t.id === tabId)
      if (!tabNow || tabNow.lastResult !== originLastResult) return
      const latest = consoleTabs.getResultTabState(resultSetIndex, tabId) || rsState
      consoleTabs.setResultTabState(
        resultSetIndex,
        {
          ...latest,
          explainAnalysis: result,
          explainAnalysisError: null,
          explainAnalysisCollapsed: false,
        },
        tabId
      )
    } catch (err) {
      if (seq !== explainAiSeq || ac.signal.aborted) return
      const tabNow = consoleTabs.getTabs().find((t) => t.id === tabId)
      if (!tabNow || tabNow.lastResult !== originLastResult) return
      const latest = consoleTabs.getResultTabState(resultSetIndex, tabId) || rsState
      const msg = err instanceof Error ? err.message : String(err)
      consoleTabs.setResultTabState(
        resultSetIndex,
        { ...latest, explainAnalysisError: msg, explainAnalysisCollapsed: false },
        tabId
      )
    } finally {
      if (explainAiAbort === ac) {
        explainAiAbort = null
      }
      if (
        explainAiLoadingTarget?.tabId === tabId &&
        explainAiLoadingTarget?.resultSetIndex === resultSetIndex &&
        explainAiLoadingTarget?.originLastResult === originLastResult
      ) {
        explainAiLoadingTarget = null
      }
      renderExplainAiForActiveTab()
      if (!ac.signal.aborted) {
        void onRefreshAiStatus?.()
      }
    }
  }

  function onAiStatusChanged() {
    syncPanelAiButton()
    if (!isPanelAiReady()) {
      cmEditor?.clearAiGhost?.()
    } else if (getActiveConn()) {
      cmEditor?.notifyAiAvailabilityChanged?.()
    }
    if (aiFixState && aiFixState.phase !== 'hidden') {
      renderAiFixPanel()
    }
    renderExplainAiForActiveTab()
  }

  function renderResultSetsBar(tab) {
    const bar = $('sqlResultSetsBar')
    if (!bar) return
    const sets = tab?.lastResult?.resultSets
    if (!sets || sets.length <= 1) {
      bar.hidden = true
      bar.textContent = ''
      return
    }
    const activeIdx = tab.activeResultSetIndex || 0
    bar.hidden = false
    bar.textContent = ''
    sets.forEach((rs, idx) => {
      const rsState = tab.resultStates?.[idx]
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = `sql-result-tab${idx === activeIdx ? ' active' : ''}${rs.isError ? ' is-error' : ''}`
      btn.setAttribute('role', 'tab')
      btn.setAttribute('aria-selected', String(idx === activeIdx))
      btn.title = rsState?.statementSql || rs.sql || rs.sqlPreview || ''
      if (rs.isError) {
        btn.textContent = `Result ${idx + 1} · Error`
      } else if (rsState?.isExplain) {
        const n = rs.rowCount ?? rs.rows?.length ?? 0
        btn.textContent = `Result ${idx + 1} · ${n} ${n === 1 ? 'step' : 'steps'}`
      } else if (rs.isSelect) {
        const n = rs.rowCount ?? rs.rows?.length ?? 0
        btn.textContent = `Result ${idx + 1} · ${n} ${n === 1 ? 'row' : 'rows'}`
      } else {
        btn.textContent = `Result ${idx + 1} · ${rs.affectedRows ?? 0} affected`
      }
      btn.addEventListener('click', () => selectPanelResultSetIndex(idx))
      bar.appendChild(btn)
    })
  }

  function applyBannerForResultTab(rsState) {
    const meta = $('sqlMetaBadge')
    const okBanner = $('sqlSuccessBanner')
    const okText = $('sqlSuccessText')
    const okDetail = $('sqlSuccessDetail')
    const errBanner = $('sqlErrorBanner')
    const errText = $('sqlErrorText')
    const fixAiBtn = $('sqlFixAiBtn')
    const scopeLbl = $('sqlResultScopeLabel')
    const b = rsState?.banner
    if (!b) {
      if (meta) meta.hidden = true
      if (okBanner) okBanner.hidden = true
      if (errBanner) errBanner.hidden = true
      if (fixAiBtn) fixAiBtn.hidden = true
      return
    }
    if (meta) {
      meta.className = b.badgeClass || 'badge badge-ok'
      meta.textContent = b.badgeText || ''
      meta.hidden = !b.dismissed
    }
    if (scopeLbl && b.scopeLabel) {
      scopeLbl.textContent = b.scopeLabel
    }
    if (b.kind === 'error') {
      if (okBanner) okBanner.hidden = true
      if (errText) {
        errText.textContent = b.detail ? `${b.text}\n${b.detail}` : b.text
      }
      if (fixAiBtn) {
        const hasSql = Boolean(String(b.failedSql || rsState?.statementSql || '').trim())
        fixAiBtn.hidden = !hasSql
      }
      if (errBanner) errBanner.hidden = Boolean(b.dismissed)
      state.lastError = b.text
    } else {
      if (errBanner) errBanner.hidden = true
      if (fixAiBtn) fixAiBtn.hidden = true
      if (okText) okText.textContent = b.text || ''
      if (okDetail) {
        const detailStr = b.detail || ''
        okDetail.textContent = detailStr
        okDetail.hidden = !detailStr
      }
      if (okBanner) okBanner.hidden = Boolean(b.dismissed)
    }
  }

  function applyPanelResultTab(index, tab, opts = {}) {
    clearAiFixPanel()
    if (!tab?.lastResult) {
      clearSqlResultDisplay()
      return
    }
    const sets = getEffectiveResultSets(tab.lastResult, tab.executedSql || '')
    const clampedIdx = Math.max(0, Math.min(index, Math.max(0, sets.length - 1)))
    tab.activeResultSetIndex = clampedIdx
    const rsState =
      tab.resultStates?.[clampedIdx] ||
      buildInitialPanelResultStates(
        tab.lastResult,
        [],
        tab.executedSql || '',
        tab.lastResult.executionTimeMs || 0,
        tab.lastResultMode || 'query'
      )[clampedIdx]
    if (rsState?.banner?.kind === 'error' && !rsState.banner.failedSql) {
      const fallbackFailedSql = String(rsState.statementSql || sets[clampedIdx]?.sql || tab.executedSql || '').trim()
      if (fallbackFailedSql) {
        rsState.banner = {
          ...rsState.banner,
          failedSql: fallbackFailedSql,
          errorMessage: sets[clampedIdx]?.errorMessage || rsState.banner.errorMessage || rsState.banner.text,
        }
      }
    }
    if (!tab.resultStates) tab.resultStates = {}
    if (rsState && !tab.resultStates[clampedIdx]) {
      tab.resultStates[clampedIdx] = rsState
    }

    const singleRes = buildSingleSetQueryResult(tab.lastResult, clampedIdx)
    state.lastSqlResult = singleRes?.isError ? null : singleRes
    state.sqlSortColIdx = rsState?.sortColIdx ?? null
    state.sqlSortDir = rsState?.sortDir || 'ASC'
    state.sqlColWidths = Array.isArray(rsState?.colWidths) ? [...rsState.colWidths] : []
    sortedSqlRowsCache = { res: null, colIdx: null, dir: 'ASC', rows: [] }
    getSqlGridSel()?.clear(true)

    renderResultSetsBar(tab)
    applyBannerForResultTab(rsState)
    renderSqlResultTableOnly()
    renderExplainAiForActiveTab()

    const wrap = $('sqlResultWrap')
    if (wrap && !opts.preserveScroll) {
      wrap.scrollTop = rsState?.scrollTop ?? 0
    }
  }

  function selectPanelResultSetIndex(index) {
    const tab = consoleTabs.getActiveTab()
    if (!tab?.lastResult) return
    const sets = tab.lastResult.resultSets
    if (!sets || index < 0 || index >= sets.length) return
    if (index === tab.activeResultSetIndex) return
    captureActiveResultTabState()
    applyPanelResultTab(index, tab)
  }

  function restoreActiveConsoleTabResult() {
    const tab = consoleTabs.getActiveTab()
    if (!tab?.lastResult) {
      clearSqlResultDisplay()
      return
    }
    applyPanelResultTab(tab.activeResultSetIndex || 0, tab, { preserveScroll: true })
  }

  function switchConsoleTab(tabId) {
    if (tabId === consoleTabs.getActiveTabId()) return
    clearAiFixPanel()
    clearDbSyntaxError()
    saveActiveConsoleTabState()
    if (!consoleTabs.switchTab(tabId)) return
    loadActiveConsoleTabEditor()
    restoreActiveConsoleTabResult()
    savePanelViewState?.()
  }

  function addConsoleTab() {
    clearAiFixPanel()
    clearDbSyntaxError()
    saveActiveConsoleTabState()
    consoleTabs.addTab('')
    loadActiveConsoleTabEditor()
    clearSqlResultDisplay()
    savePanelViewState?.()
    focusSqlEditor()
  }

  function closeConsoleTab(tabId) {
    clearAiFixPanel()
    clearDbSyntaxError()
    saveActiveConsoleTabState()
    if (!consoleTabs.closeTab(tabId)) return
    loadActiveConsoleTabEditor()
    restoreActiveConsoleTabResult()
    savePanelViewState?.()
  }

  function restoreConsoleTabsState(persistedTabs, fallbackDraft = '') {
    if (persistedTabs && Array.isArray(persistedTabs.tabs) && persistedTabs.tabs.length > 0) {
      consoleTabs = createPanelConsoleTabsManager(persistedTabs)
    } else if (typeof fallbackDraft === 'string' && fallbackDraft.trim()) {
      consoleTabs = createPanelConsoleTabsManager(fallbackDraft)
    } else {
      consoleTabs = createPanelConsoleTabsManager(DEFAULT_PANEL_SQL)
    }
    loadActiveConsoleTabEditor()
    restoreActiveConsoleTabResult()
  }

  function getConsoleTabsPersistedState(isSensitiveFn) {
    if (cmEditor) {
      consoleTabs.updateActiveSql(cmEditor.getValue(), cmEditor.getCursorOffset())
    }
    return consoleTabs.toPersistedState(isSensitiveFn)
  }

  function dismissActiveSqlSuccessBanner() {
    const tab = consoleTabs.getActiveTab()
    const rsState = consoleTabs.getResultTabState(tab?.activeResultSetIndex || 0, tab?.id)
    if (rsState?.banner) rsState.banner.dismissed = true
    if ($('sqlSuccessBanner')) $('sqlSuccessBanner').hidden = true
    if ($('sqlMetaBadge') && rsState?.banner?.badgeText) $('sqlMetaBadge').hidden = false
  }

  function dismissActiveSqlErrorBanner() {
    const tab = consoleTabs.getActiveTab()
    const rsState = consoleTabs.getResultTabState(tab?.activeResultSetIndex || 0, tab?.id)
    if (rsState?.banner) rsState.banner.dismissed = true
    if ($('sqlErrorBanner')) $('sqlErrorBanner').hidden = true
    if ($('sqlMetaBadge') && rsState?.banner?.badgeText) $('sqlMetaBadge').hidden = false
    clearAiFixPanel()
  }

  function getSortedSqlRows() {
    const res = state.lastSqlResult
    if (!res || !Array.isArray(res.rows)) return []
    if (
      sortedSqlRowsCache.res === res &&
      sortedSqlRowsCache.colIdx === state.sqlSortColIdx &&
      sortedSqlRowsCache.dir === state.sqlSortDir
    ) {
      return sortedSqlRowsCache.rows
    }
    const rows = state.sqlSortColIdx === null ? res.rows : [...res.rows]
    if (
      state.sqlSortColIdx !== null &&
      state.sqlSortColIdx >= 0 &&
      state.sqlSortColIdx < (res.columns?.length || 0)
    ) {
      const idx = state.sqlSortColIdx
      const dir = state.sqlSortDir === 'DESC' ? -1 : 1
      rows.sort((a, b) => comparePanelCellValues(a[idx], b[idx], dir))
    }
    sortedSqlRowsCache = { res, colIdx: state.sqlSortColIdx, dir: state.sqlSortDir, rows }
    return rows
  }

  function renderSqlSelectionStats() {
    const strip = $('sqlSelectionStats')
    if (!strip) return
    const sqlGridSel = getSqlGridSel()
    if (!sqlGridSel || !sqlGridSel.hasSelection()) {
      strip.hidden = true
      strip.textContent = ''
      return
    }
    const txt = sqlGridSel.formatStatsText()
    if (!txt) {
      strip.hidden = true
      strip.textContent = ''
      return
    }
    strip.hidden = false
    strip.textContent = txt
  }

  function copySqlSelection(format = 'tsv', includeHeaders = false) {
    const res = state.lastSqlResult
    const sqlGridSel = getSqlGridSel()
    if (!res || !res.columns || !sqlGridSel || !sqlGridSel.hasSelection()) return false
    const sortedRows = getSortedSqlRows()
    const coords = sqlGridSel.getSelectedCoords(50000)
    if (coords.length === 0) return false
    const text = formatSelectionAsOutput(
      res.columns,
      sortedRows,
      coords,
      format,
      includeHeaders,
      'query_result',
      null,
      getActiveConn()?.driver || 'sqlite',
      []
    )
    if (!text) return false
    setLastPanelCopiedText(text)
    const cnt = coords.length
    void copyText(text, `Copied ${cnt} cell${cnt === 1 ? '' : 's'} as ${format.toUpperCase()}`)
    return true
  }

  function exportCurrentSqlResult(format, asDownload, ext, mime) {
    const res = state.lastSqlResult
    if (!res || !Array.isArray(res.columns) || res.columns.length === 0) {
      showBanner('Execute a query returning rows before exporting.', 'warn')
      return
    }
    const conn = getActiveConn()
    const cols = res.columns
    const sortedRows = getSortedSqlRows()
    const sqlGridSel = getSqlGridSel()
    let exportRows = sortedRows
    let selectionPrefix = ''
    if (sqlGridSel && sqlGridSel.hasSelection()) {
      const rowIndices = sqlGridSel.getSelectedRowIndices()
      if (rowIndices.length > 0 && rowIndices.length < sortedRows.length) {
        exportRows = rowIndices.map((i) => sortedRows[i]).filter(Boolean)
        selectionPrefix = 'Selected '
      }
    }
    const content = formatExportData({
      columns: cols,
      rows: exportRows,
      format,
      tableName: 'query_result',
      driver: conn?.driver || 'sqlite',
    })
    if (asDownload) {
      downloadTextFile(`query_result.${ext}`, content, mime)
      showBanner(
        `Downloaded ${selectionPrefix}query_result.${ext} (${exportRows.length} rows)`,
        'success'
      )
    } else {
      void copyText(
        content,
        `Copied ${selectionPrefix}${exportRows.length} SQL result row(s) as ${format.toUpperCase()}`
      )
    }
  }

  function createSqlVirtualRow(rowIdx) {
    const res = state.lastSqlResult
    const sqlGridSel = getSqlGridSel()
    const tr = document.createElement('tr')
    tr.dataset.rowIdx = String(rowIdx)
    if (rowIdx % 2 === 1) tr.classList.add('row-even')
    const row = sqlVirt.sortedRows[rowIdx]

    const tdIdx = document.createElement('td')
    tdIdx.className = 'td-rownum'
    tdIdx.dataset.rowIdx = String(rowIdx)
    tdIdx.textContent = String(rowIdx + 1)
    tdIdx.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || !sqlGridSel) return
      e.preventDefault()
      e.stopPropagation()
      $('sqlResultWrap')?.focus({ preventScroll: true })
      sqlGridSel.selectRow(rowIdx, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })
    })
    tr.appendChild(tdIdx)

    for (let colIdx = 0; colIdx < sqlVirt.columns.length; colIdx++) {
      const val = row[colIdx]
      const td = document.createElement('td')
      td.dataset.rowIdx = String(rowIdx)
      td.dataset.colIdx = String(colIdx)
      if (val === null || val === undefined) {
        td.textContent = 'NULL'
        td.className = 'cell-null'
      } else if (typeof val === 'object') {
        const s = JSON.stringify(val)
        td.textContent = s
        td.title = s
      } else {
        td.textContent = String(val)
        td.title = String(val)
      }
      tr.appendChild(td)
    }
    if (sqlGridSel) sqlGridSel.applyClassesToRow(tr, rowIdx)
    return tr
  }

  function renderSqlVirtualWindow(force = false) {
    const wrap = $('sqlResultWrap')
    const res = state.lastSqlResult
    if (!sqlVirt.active || !res || !sqlVirt.tbody || !wrap) return
    const total = sqlVirt.sortedRows.length
    const { start, end } = computeVirtualRange(wrap.scrollTop, wrap.clientHeight, total)
    syncVirtualTableWindow({
      virt: sqlVirt,
      total,
      start,
      end,
      colSpan: sqlVirt.columns.length + 1,
      rowHeightPx: VIRT_ROW_HEIGHT_PX,
      force,
      createRow: createSqlVirtualRow,
      selectionController: getSqlGridSel(),
    })
  }

  function ensureSqlVirtualRowVisible(rowIdx) {
    const wrap = $('sqlResultWrap')
    if (!wrap || !sqlVirt.active) return
    const total = sqlVirt.sortedRows.length
    if (rowIdx < 0 || rowIdx >= total) return
    const topPx = rowIdx * VIRT_ROW_HEIGHT_PX
    const botPx = topPx + VIRT_ROW_HEIGHT_PX
    const hdrH = 26
    if (topPx < wrap.scrollTop) {
      wrap.scrollTop = topPx
    } else if (botPx > wrap.scrollTop + wrap.clientHeight - hdrH) {
      wrap.scrollTop = Math.max(0, botPx - (wrap.clientHeight - hdrH))
    }
    renderSqlVirtualWindow(false)
  }

  function renderSqlResultSkeleton() {
    if (sqlVirt.rafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(sqlVirt.rafId)
      sqlVirt.rafId = null
    }
    const wrap = $('sqlResultWrap')
    const tbl = $('sqlResultTable')
    const metaBar = $('sqlResultMeta')
    if (!wrap || !tbl) return
    sqlVirt.active = false
    sqlVirt.sortedRows = []
    sqlVirt.columns = []
    sqlVirt.start = -1
    sqlVirt.end = -1
    wrap.hidden = false
    if (metaBar) metaBar.hidden = true
    tbl.textContent = ''
    tbl.style.width = '100%'
    const thead = document.createElement('thead')
    const hr = document.createElement('tr')
    for (const w of ['36px', '30%', '35%', '35%']) {
      const th = document.createElement('th')
      th.style.width = w
      const bar = document.createElement('div')
      bar.className = 'panel-skeleton-bar'
      bar.style.width = w === '36px' ? '16px' : '58%'
      th.appendChild(bar)
      hr.appendChild(th)
    }
    thead.appendChild(hr)
    tbl.appendChild(thead)
    const tbody = document.createElement('tbody')
    for (let r = 0; r < 6; r++) {
      const tr = document.createElement('tr')
      for (let c = 0; c < 4; c++) {
        const td = document.createElement('td')
        const bar = document.createElement('div')
        bar.className = 'panel-skeleton-bar'
        bar.style.width = c === 0 ? '18px' : `${48 + ((r * 19 + c * 13) % 40)}%`
        td.appendChild(bar)
        tr.appendChild(td)
      }
      tbody.appendChild(tr)
    }
    tbl.appendChild(tbody)
  }

  function renderSqlResultTableOnly() {
    if (sqlVirt.rafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(sqlVirt.rafId)
      sqlVirt.rafId = null
    }
    const sqlGridSel = getSqlGridSel()
    const res = state.lastSqlResult
    const wrap = $('sqlResultWrap')
    const tbl = $('sqlResultTable')
    const metaBar = $('sqlResultMeta')
    if (!tbl || !wrap) return
    tbl.textContent = ''
    if (!res || !res.columns || res.columns.length === 0) {
      sqlVirt.active = false
      sqlVirt.sortedRows = []
      sqlVirt.columns = []
      sqlVirt.start = -1
      sqlVirt.end = -1
      wrap.hidden = true
      if (metaBar) metaBar.hidden = true
      return
    }
    wrap.hidden = false
    if (metaBar) metaBar.hidden = false
    const sortedRows = getSortedSqlRows()
    if (!Array.isArray(state.sqlColWidths) || state.sqlColWidths.length !== res.columns.length) {
      state.sqlColWidths = res.columns.map((col, idx) => {
        let maxLen = col.name.length + 2
        const sampleLen = Math.min(25, sortedRows.length)
        for (let r = 0; r < sampleLen; r++) {
          const v = sortedRows[r][idx]
          const len =
            v == null ? 4 : (typeof v === 'object' ? JSON.stringify(v) : String(v)).length
          if (len > maxLen) maxLen = len
        }
        return Math.max(84, Math.min(280, Math.round(Math.min(40, Math.max(7, maxLen)) * 7.4 + 26)))
      })
    }
    const colWidths = state.sqlColWidths
    const colgroup = document.createElement('colgroup')
    const rowNumColEl = document.createElement('col')
    rowNumColEl.style.width = `${state.sqlRowNumWidth}px`
    colgroup.appendChild(rowNumColEl)
    const colEls = colWidths.map((w) => {
      const c = document.createElement('col')
      c.style.width = `${w}px`
      colgroup.appendChild(c)
      return c
    })
    tbl.appendChild(colgroup)

    const syncSqlTableWidth = () => {
      const total = state.sqlRowNumWidth + colWidths.reduce((s, w) => s + w, 0)
      tbl.style.width = `${total}px`
    }
    syncSqlTableWidth()

    const thead = document.createElement('thead')
    const hr = document.createElement('tr')

    const thIdx = document.createElement('th')
    thIdx.style.width = `${state.sqlRowNumWidth}px`
    thIdx.style.left = '0px'
    thIdx.dataset.cornerSelect = '1'
    thIdx.title = 'Click to Select All (Ctrl+A)'
    const idxInner = document.createElement('div')
    idxInner.className = 'th-inner'
    const idxLbl = document.createElement('span')
    idxLbl.className = 'th-label'
    idxLbl.style.textAlign = 'right'
    idxLbl.textContent = '#'
    idxInner.appendChild(idxLbl)
    const idxResize = document.createElement('div')
    idxResize.className = 'col-resize-handle'
    attachColumnResizeHandle(
      idxResize,
      rowNumColEl,
      thIdx,
      true,
      -1,
      colWidths,
      syncSqlTableWidth,
      null,
      'sqlRowNumWidth'
    )
    thIdx.append(idxInner, idxResize)
    thIdx.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || Date.now() < getSuppressSortClickUntil()) return
      if (!sqlGridSel || sortedRows.length === 0 || res.columns.length === 0) return
      e.preventDefault()
      $('sqlResultWrap')?.focus({ preventScroll: true })
      sqlGridSel.selectAll()
    })
    hr.appendChild(thIdx)

    res.columns.forEach((col, colIdx) => {
      const th = document.createElement('th')
      th.style.width = `${colWidths[colIdx]}px`
      const inner = document.createElement('div')
      inner.className = 'th-inner'
      const lbl = document.createElement('span')
      lbl.className = 'th-label'
      lbl.textContent = col.name
      lbl.title = `${col.name}${col.type ? ` (${col.type})` : ''}`
      inner.appendChild(lbl)
      if (state.sqlSortColIdx === colIdx) {
        const ind = document.createElement('span')
        ind.className = 'th-sort'
        ind.appendChild(createSortSvg(state.sqlSortDir))
        inner.appendChild(ind)
      }

      const resizeHandle = document.createElement('div')
      resizeHandle.className = 'col-resize-handle'
      attachColumnResizeHandle(
        resizeHandle,
        colEls[colIdx],
        th,
        false,
        colIdx,
        colWidths,
        syncSqlTableWidth,
        () => {
          const curRows = getSortedSqlRows()
          let maxLen = col.name.length + 2
          const limit = Math.min(curRows.length, 500)
          for (let r = 0; r < limit; r++) {
            const v = curRows[r]?.[colIdx]
            const len =
              v == null ? 4 : (typeof v === 'object' ? JSON.stringify(v) : String(v)).length
            if (len > maxLen) maxLen = len
          }
          return Math.max(64, Math.min(440, Math.round(maxLen * 7.5 + 26)))
        },
        'sqlRowNumWidth'
      )

      th.append(inner, resizeHandle)
      th.addEventListener('click', (e) => {
        if (Date.now() < getSuppressSortClickUntil()) return
        if (e.shiftKey || e.ctrlKey || e.metaKey) {
          e.preventDefault()
          sqlGridSel?.selectCol(colIdx, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })
          $('sqlResultWrap')?.focus({ preventScroll: true })
          return
        }
        if (state.sqlSortColIdx === colIdx) {
          state.sqlSortDir = state.sqlSortDir === 'ASC' ? 'DESC' : 'ASC'
        } else {
          state.sqlSortColIdx = colIdx
          state.sqlSortDir = 'ASC'
        }
        captureActiveResultTabState()
        sqlGridSel?.clear(true)
        renderSqlResultTableOnly()
      })
      hr.appendChild(th)
    })
    thead.appendChild(hr)
    tbl.appendChild(thead)

    const tbody = document.createElement('tbody')
    if (sortedRows.length === 0) {
      sqlVirt.active = false
      sqlVirt.columns = res.columns
      sqlVirt.sortedRows = []
      sqlVirt.start = -1
      sqlVirt.end = -1
      const emptyTr = document.createElement('tr')
      const emptyTd = document.createElement('td')
      emptyTd.colSpan = res.columns.length + 1
      emptyTd.className = 'cell-null'
      emptyTd.style.textAlign = 'center'
      emptyTd.style.padding = '16px 12px'
      emptyTd.textContent = 'Query returned no rows.'
      emptyTr.appendChild(emptyTd)
      tbody.appendChild(emptyTr)
      tbl.appendChild(tbody)
    } else {
      const topSpacerTr = document.createElement('tr')
      topSpacerTr.className = 'virt-spacer-row'
      topSpacerTr.style.display = 'none'
      const topSpacerTd = document.createElement('td')
      topSpacerTd.colSpan = res.columns.length + 1
      topSpacerTr.appendChild(topSpacerTd)

      const bottomSpacerTr = document.createElement('tr')
      bottomSpacerTr.className = 'virt-spacer-row'
      bottomSpacerTr.style.display = 'none'
      const bottomSpacerTd = document.createElement('td')
      bottomSpacerTd.colSpan = res.columns.length + 1
      bottomSpacerTr.appendChild(bottomSpacerTd)

      tbody.append(topSpacerTr, bottomSpacerTr)
      tbl.appendChild(tbody)

      sqlVirt.active = true
      sqlVirt.columns = res.columns
      sqlVirt.sortedRows = sortedRows
      sqlVirt.tbody = tbody
      sqlVirt.topSpacerTr = topSpacerTr
      sqlVirt.topSpacerTd = topSpacerTd
      sqlVirt.bottomSpacerTr = bottomSpacerTr
      sqlVirt.bottomSpacerTd = bottomSpacerTd
      sqlVirt.start = -1
      sqlVirt.end = -1

      renderSqlVirtualWindow(true)
    }
    renderSqlSelectionStats()
  }

  function renderQueryResult(res, opts = {}) {
    const mode = opts.mode || 'query'
    const targetTabId = opts.originTabId || consoleTabs.getActiveTabId()
    const overallSql = opts.overallSql ?? getSqlText().trim()
    const rawStatements = Array.isArray(opts.rawStatements) ? opts.rawStatements : []
    const fallbackMs = Number.isFinite(Number(res?.executionTimeMs))
      ? Number(res.executionTimeMs)
      : 0
    const defaultIdx =
      typeof opts.defaultIndex === 'number'
        ? opts.defaultIndex
        : getDefaultResultSetIndex(res, mode)
    const resultStates = buildInitialPanelResultStates(
      res,
      rawStatements,
      overallSql,
      fallbackMs,
      mode
    )
    const resolvedDriver = opts.runDriver || getActiveConn()?.driver || 'sqlite'
    const failedStatementIndex =
      typeof opts.failedStatementIndex === 'number' &&
      Number.isInteger(opts.failedStatementIndex) &&
      opts.failedStatementIndex >= 0
        ? opts.failedStatementIndex
        : res?.executionError?.failedStatementIndex ?? null
    const expectedStatementCount =
      typeof opts.expectedStatementCount === 'number' &&
      Number.isInteger(opts.expectedStatementCount) &&
      opts.expectedStatementCount > 0
        ? opts.expectedStatementCount
        : res?.executionError?.statementCount ?? null
    attachPanelFixTargets(
      resultStates,
      res,
      overallSql,
      resolvedDriver,
      opts.execRange || null,
      failedStatementIndex,
      expectedStatementCount
    )
    if (mode === 'explain') {
      const execConnId = opts.connId ?? state.activeConnectionId ?? undefined
      const execConn = execConnId ? getConnById?.(execConnId) : getActiveConn()
      attachPanelExplainTargets(
        resultStates,
        res,
        overallSql,
        resolvedDriver,
        opts.execRange || null,
        {
          connectionId: execConnId,
          dialect: resolvedDriver,
          activeSchema:
            'executedActiveSchema' in opts
              ? opts.executedActiveSchema
              : state.activeSchema || undefined,
          colorTag: execConn?.colorTag,
          aiPolicy: execConn?.aiPolicy,
        }
      )
    }
    consoleTabs.setResultForTab(
      targetTabId,
      res,
      defaultIdx,
      overallSql,
      opts.connId ?? state.activeConnectionId ?? undefined,
      resultStates,
      mode
    )

    if (targetTabId === consoleTabs.getActiveTabId()) {
      const tab = consoleTabs.getActiveTab()
      applyPanelResultTab(defaultIdx, tab, { preserveScroll: Boolean(opts.preserveScroll) })
      if (!opts.preserveScroll) {
        const sets = getEffectiveResultSets(res, overallSql)
        const errIdx = sets.findIndex((s) => Boolean(s?.isError))
        if (errIdx >= 0) {
          const errRs = sets[errIdx]
          const errState = resultStates[errIdx]
          const errMsg =
            errRs?.errorMessage || errState?.banner?.errorMessage || errState?.banner?.text || ''
          setDbSyntaxError(errMsg, errState?.banner?.fixTargetRange || null, resolvedDriver)
        } else {
          clearDbSyntaxError()
        }
      }
    }
    if (!opts.skipCache) {
      savePanelDataCache?.()
    }
  }

  function resolveTargetSql(mode, rawScript, runDriver) {
    const selectedSql = cmEditor ? cmEditor.getSelectedText() : ''
    const execRange = cmEditor?.getExecutionRange
      ? cmEditor.getExecutionRange(mode, runDriver)
      : null
    let sql = rawScript.trim()
    if (mode === 'explain') {
      sql = selectedSql || rawScript.trim()
    } else if (mode === 'caret') {
      if (selectedSql) {
        sql = selectedSql
      } else if (runDriver === 'mongodb') {
        const cursorOffset = cmEditor?.getCursorOffset?.() ?? rawScript.length
        sql = findMongoStatementAtOffset(rawScript, cursorOffset)
      } else if (runDriver !== 'redis') {
        sql = cmEditor
          ? cmEditor.getCaretStatementSql(runDriver)
          : findStatementAtOffset(rawScript, rawScript.length, runDriver).trim()
      }
    }
    if (!sql) return null
    const statements = splitPanelTargetStatements(sql, runDriver)
    return statements.length > 0 ? { sql, statements, execRange } : null
  }

  function setSqlRunToolbarBusy(busy, cancelBtn) {
    $('runSqlBtn').disabled = busy
    $('runAllSqlBtn').disabled = busy
    $('explainSqlBtn').disabled = busy
    if ($('formatSqlBtn')) $('formatSqlBtn').disabled = busy
    if (cancelBtn) {
      setButtonLoading(cancelBtn, false)
      cancelBtn.hidden = !busy
    }
  }

  async function executeExplainBatch({
    statements,
    templateSql,
    templateStatements,
    runConnId,
    queryId,
    runSeq,
    onProgress,
  }) {
    const overallStart = performance.now()
    const collectedSets = []
    let firstNonError = null
    for (let i = 0; i < statements.length; i++) {
      if (runSeq !== sqlRunSeq || state.activeConnectionId !== runConnId) return null
      if (cancelledSqlRunSeq === runSeq) {
        const cancelErr = new Error('EXPLAIN execution was cancelled')
        cancelErr.code = 'cancelled'
        throw cancelErr
      }
      const stmtSql = statements[i]
      const stmtTemplateSql =
        statements.length === 1
          ? templateSql || undefined
          : Array.isArray(templateStatements) && templateStatements.length === statements.length
            ? templateStatements[i]
            : undefined
      const workerQid = statements.length === 1 ? queryId : `${queryId}_${i}`
      state.activeWorkerQueryId = workerQid
      onProgress(statements.length > 1 ? `Explaining ${i + 1}/${statements.length}` : 'Explaining')
      const stmtStart = performance.now()
      try {
        const singleRes = await rpc(
          'query.explain',
          {
            connectionId: runConnId,
            queryId: workerQid,
            sql: stmtSql,
            ...(stmtTemplateSql ? { templateSql: stmtTemplateSql } : {}),
          },
          { timeoutMs: QUERY_TIMEOUT_MS }
        )
        if (runSeq !== sqlRunSeq || state.activeConnectionId !== runConnId) return null
        if (cancelledSqlRunSeq === runSeq) {
          const cancelErr = new Error('EXPLAIN execution was cancelled')
          cancelErr.code = 'cancelled'
          throw cancelErr
        }
        const stmtMs = singleRes?.executionTimeMs || Math.round(performance.now() - stmtStart)
        if (!firstNonError) firstNonError = singleRes
        collectedSets.push({
          index: i,
          sqlPreview: compactSqlPreview(stmtSql),
          sql: stmtSql,
          executionTimeMs: stmtMs,
          columns: singleRes?.columns || [],
          rows: singleRes?.rows || [],
          rowCount: singleRes?.rowCount ?? (singleRes?.rows ? singleRes.rows.length : 0),
          truncated: Boolean(singleRes?.truncated),
          isSelect: true,
          ...(singleRes?.explainPlan ? { explainPlan: singleRes.explainPlan } : {}),
        })
      } catch (stmtErr) {
        if (runSeq !== sqlRunSeq || state.activeConnectionId !== runConnId) return null
        const errText = String(stmtErr?.message || '')
        const isCancelled =
          cancelledSqlRunSeq === runSeq ||
          stmtErr?.code === 'cancelled' ||
          stmtErr?.name === 'AbortError' ||
          /\b(?:query|explain)\s+(?:execution\s+)?(?:was\s+)?cancell?ed\b/i.test(errText)
        if (statements.length === 1 || isCancelled) throw stmtErr
        collectedSets.push({
          index: i,
          sqlPreview: compactSqlPreview(stmtSql),
          sql: stmtSql,
          executionTimeMs: Math.round(performance.now() - stmtStart),
          isError: true,
          errorMessage: stmtErr?.message || String(stmtErr),
          columns: [],
          rows: [],
          rowCount: 0,
          truncated: false,
          isSelect: true,
        })
      }
    }
    const totalMs = Math.round(performance.now() - overallStart)
    return buildCombinedExplainResult(collectedSets, firstNonError, totalMs)
  }

  async function executeSingleQueryRun({ sql, templateSql, runConnId, queryId, runSeq }) {
    let configuredMaxRows
    if (typeof window.orca?.settings?.get === 'function') {
      try {
        const rawMax = Number(await window.orca.settings.get('maxRows'))
        if (Number.isFinite(rawMax) && rawMax > 0) {
          configuredMaxRows = Math.max(1, Math.min(50000, Math.floor(rawMax)))
        }
      } catch {}
      if (
        runSeq !== sqlRunSeq ||
        cancelledSqlRunSeq === runSeq ||
        state.activeConnectionId !== runConnId
      ) {
        return { stale: true }
      }
    }
    if (
      runSeq !== sqlRunSeq ||
      cancelledSqlRunSeq === runSeq ||
      state.activeConnectionId !== runConnId
    ) {
      return { stale: true }
    }
    const payload = {
      connectionId: runConnId,
      queryId,
      sql,
      ...(templateSql ? { templateSql } : {}),
      structuredError: true,
      ...(configuredMaxRows ? { maxRows: configuredMaxRows } : {}),
    }
    const res = await rpc('query.run', payload, { timeoutMs: QUERY_TIMEOUT_MS })
    return { stale: false, res }
  }

  async function executeResolvedSql(snapshot) {
    if (!snapshot || !snapshot.runConnId || state.activeQueryId) return
    const {
      sql,
      templateSql,
      templateStatements,
      statements,
      mode,
      runConnId,
      runDriver,
      originTabId,
      execRange,
      executedActiveSchema,
    } = snapshot
    if (state.activeConnectionId !== runConnId) return

    clearAiFixPanel()
    clearDbSyntaxError()
    const runSeq = ++sqlRunSeq
    const queryId = `panel_sql_${Date.now()}`
    state.activeQueryId = queryId
    state.activeWorkerQueryId = queryId
    $('sqlSuccessBanner').hidden = true
    $('sqlErrorBanner').hidden = true
    if ($('sqlFixAiBtn')) $('sqlFixAiBtn').hidden = true
    if ($('sqlResultSetsBar')) $('sqlResultSetsBar').hidden = true
    const cancelBtn = $('cancelSqlBtn')
    setSqlRunToolbarBusy(true, cancelBtn)

    const meta = $('sqlMetaBadge')
    meta.hidden = false
    meta.className = 'badge badge-info'
    let explainProgressText = ''
    const phaseWord = mode === 'explain' ? 'Explaining' : 'Running'
    const setRunningBadge = (elapsed) => {
      if (
        runSeq !== sqlRunSeq ||
        state.activeConnectionId !== runConnId ||
        consoleTabs.getActiveTabId() !== originTabId
      ) {
        return
      }
      meta.hidden = false
      meta.className = 'badge badge-info'
      meta.textContent = ''
      const sp = document.createElement('span')
      sp.className = 'btn-spinner btn-spinner-sm'
      sp.style.marginRight = '5px'
      sp.setAttribute('aria-hidden', 'true')
      const lbl = document.createElement('span')
      lbl.textContent = explainProgressText
        ? `${explainProgressText} ${elapsed}...`
        : `${phaseWord} ${elapsed}...`
      meta.append(sp, lbl)
    }
    if (sqlStopTimer) {
      sqlStopTimer()
      sqlStopTimer = null
    }
    const stopTimer = createElapsedTimer(setRunningBadge)
    sqlStopTimer = stopTimer
    renderSqlResultSkeleton()

    try {
      if (mode === 'explain') {
        const combinedRes = await executeExplainBatch({
          statements,
          templateSql,
          templateStatements,
          runConnId,
          queryId,
          runSeq,
          onProgress: (text) => {
            explainProgressText = text
          },
        })
        stopTimer()
        if (!combinedRes) return
        renderQueryResult(combinedRes, {
          mode: 'explain',
          originTabId,
          connId: runConnId,
          runDriver,
          executedActiveSchema,
          execRange,
          rawStatements: templateStatements || statements,
          overallSql: templateSql || sql,
          defaultIndex: 0,
        })
        return
      }

      const outcome = await executeSingleQueryRun({ sql, templateSql, runConnId, queryId, runSeq })
      stopTimer()
      if (outcome.stale || runSeq !== sqlRunSeq || state.activeConnectionId !== runConnId) {
        if (panelContainsDdlStatement(sql, runDriver) && getConnById(runConnId)) {
          void loadSchema(runConnId)
        }
        return
      }
      if (outcome.res?.executionError) {
        const execErrMsg = outcome.res.executionError.message || 'Query execution failed'
        renderQueryResult(buildErrorQueryResult(sql, execErrMsg), {
          mode: 'query',
          originTabId,
          connId: runConnId,
          runDriver,
          execRange,
          rawStatements: statements,
          overallSql: sql,
          defaultIndex: 0,
          skipCache: true,
          failedStatementIndex: outcome.res.executionError.failedStatementIndex,
          expectedStatementCount: outcome.res.executionError.statementCount,
        })
        if (state.historyOpen) void loadQueryHistory()
        return
      }
      renderQueryResult(outcome.res, {
        mode: 'query',
        originTabId,
        connId: runConnId,
        runDriver,
        execRange,
        rawStatements: statements,
        overallSql: sql,
      })
      if (panelContainsDdlStatement(sql, runDriver)) {
        void loadSchema(runConnId)
      }
      if (state.historyOpen) void loadQueryHistory()
    } catch (err) {
      stopTimer()
      if (runSeq !== sqlRunSeq || state.activeConnectionId !== runConnId) return
      const errMsg = err?.message || String(err)
      const failedStatementIndex =
        typeof err?.failedStatementIndex === 'number' &&
        Number.isInteger(err.failedStatementIndex) &&
        err.failedStatementIndex >= 0
          ? err.failedStatementIndex
          : null
      const expectedStatementCount =
        typeof err?.statementCount === 'number' &&
        Number.isInteger(err.statementCount) &&
        err.statementCount > 0
          ? err.statementCount
          : null
      renderQueryResult(buildErrorQueryResult(sql, errMsg), {
        mode: mode === 'explain' ? 'explain' : 'query',
        originTabId,
        connId: runConnId,
        runDriver,
        execRange,
        rawStatements: statements,
        overallSql: sql,
        defaultIndex: 0,
        skipCache: true,
        failedStatementIndex,
        expectedStatementCount,
      })
    } finally {
      stopTimer()
      if (sqlStopTimer === stopTimer) sqlStopTimer = null
      if (runSeq === sqlRunSeq) {
        state.activeQueryId = null
        state.activeWorkerQueryId = null
        setSqlRunToolbarBusy(false, cancelBtn)
      }
    }
  }

  const bindParamsMemoryStore = createRememberedBindParamsStore()

  async function runResolvedSnapshotWithDangerGuard(snapshot, options = {}) {
    const conn = getConnById?.(snapshot.runConnId) || getActiveConn()
    if (!options?.skipDangerGuard && !conn?.readOnly) {
      const findings = analyzeDangerousSql(snapshot.sql, snapshot.runDriver)
      if (findings.length > 0) {
        openPanelDangerSqlModal({
          conn,
          findings,
          sql: snapshot.sql,
          onConfirm: () => {
            if (
              state.activeConnectionId !== snapshot.runConnId ||
              consoleTabs.getActiveTabId() !== snapshot.originTabId
            ) {
              showBanner?.(
                'Execution cancelled: active connection or tab changed before confirmation.',
                'warn'
              )
              return
            }
            void executeResolvedSql(snapshot)
          },
        })
        return
      }
    }

    await executeResolvedSql(snapshot)
  }

  async function runSql(mode = 'caret', options = {}) {
    if (!state.activeConnectionId || state.activeQueryId) return
    const conn = getActiveConn()
    const runConnId = state.activeConnectionId
    const runDriver = conn?.driver || 'sqlite'
    const executedActiveSchema = state.activeSchema || undefined
    const originTabId = consoleTabs.getActiveTabId()
    const resolved = resolveTargetSql(mode, getSqlText(), runDriver)
    if (!resolved) return

    if (!options?.skipBindCheck && runDriver !== 'redis') {
      const detectedParams = extractSqlParameters(resolved.sql, runDriver)
      if (detectedParams.length > 0) {
        const bindRes = await openSharedBindParamsModal({
          sql: resolved.sql,
          dialect: runDriver,
          params: detectedParams,
          action: mode === 'explain' ? 'explain' : 'run',
          memoryStore: bindParamsMemoryStore,
          scopeKey: runConnId || 'default',
        })
        if (!bindRes || typeof bindRes.boundSql !== 'string') return
        if (
          state.activeConnectionId !== runConnId ||
          consoleTabs.getActiveTabId() !== originTabId
        ) {
          showBanner?.(
            'Execution cancelled: active connection or tab changed before confirmation.',
            'warn'
          )
          return
        }
        const boundStatements = splitPanelTargetStatements(bindRes.boundSql, runDriver)
        if (boundStatements.length === 0) return
        const boundSnapshot = Object.freeze({
          sql: bindRes.boundSql,
          templateSql: resolved.sql,
          templateStatements: Object.freeze([...resolved.statements]),
          statements: Object.freeze([...boundStatements]),
          execRange: resolved.execRange || null,
          mode,
          runConnId,
          runDriver,
          originTabId,
          executedActiveSchema,
        })
        await runResolvedSnapshotWithDangerGuard(boundSnapshot, options)
        return
      }
    }

    const snapshot = Object.freeze({
      sql: resolved.sql,
      statements: Object.freeze([...resolved.statements]),
      execRange: resolved.execRange || null,
      mode,
      runConnId,
      runDriver,
      originTabId,
      executedActiveSchema,
    })
    await runResolvedSnapshotWithDangerGuard(snapshot, options)
  }

  async function loadQueryHistory() {
    const reqSeq = ++historySeq
    const list = $('sqlHistoryList')
    const refBtn = $('refreshHistoryBtn')
    if (list && (!state.historyEntries || state.historyEntries.length === 0)) {
      state.historyLoading = true
      renderQueryHistory()
    }
    setButtonLoading(refBtn, true, 'Loading...')
    try {
      const res = await rpc('query.history.list', { limit: 50 })
      if (reqSeq !== historySeq) return
      state.historyEntries = Array.isArray(res?.entries) ? res.entries : []
    } catch {
      if (reqSeq !== historySeq) return
      state.historyEntries = []
    } finally {
      if (reqSeq === historySeq) {
        state.historyLoading = false
        setButtonLoading(refBtn, false)
        renderQueryHistory()
      }
    }
  }

  function renderQueryHistory() {
    const list = $('sqlHistoryList')
    if (!list) return
    list.textContent = ''
    if (state.historyLoading) {
      for (let i = 0; i < 3; i++) {
        const sk = document.createElement('div')
        sk.className = 'history-card'
        const b1 = document.createElement('div')
        b1.className = 'panel-skeleton-bar'
        b1.style.width = `${45 + i * 12}%`
        const b2 = document.createElement('div')
        b2.className = 'panel-skeleton-bar'
        b2.style.width = '88%'
        sk.append(b1, b2)
        list.appendChild(sk)
      }
      return
    }
    const q = (state.historyFilter || '').trim().toLowerCase()
    const filtered = q
      ? state.historyEntries.filter(
          (e) =>
            String(e.sql || '').toLowerCase().includes(q) ||
            String(e.connectionName || '').toLowerCase().includes(q) ||
            String(e.driver || '').toLowerCase().includes(q)
        )
      : state.historyEntries

    if (filtered.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'col-leaf'
      empty.textContent =
        state.historyEntries.length === 0
          ? 'No executed queries recorded yet.'
          : `No queries match "${state.historyFilter}".`
      list.appendChild(empty)
      return
    }
    for (const entry of filtered) {
      const item = document.createElement('div')
      item.className = 'history-card'
      item.title = entry.sql

      const top = document.createElement('div')
      top.className = 'file-chip-top'
      const title = document.createElement('span')
      title.className = 'file-chip-title'
      const ico = document.createElement('span')
      setDbLogoElement(ico, entry.driver, 13)
      const nm = document.createElement('span')
      nm.className = 'file-chip-name'
      nm.textContent = entry.connectionName || entry.driver
      title.append(ico, nm)

      const status = document.createElement('span')
      status.className = `badge ${entry.isError ? 'badge-danger' : 'badge-ok'}`
      status.textContent = entry.isError
        ? 'ERR'
        : `${entry.rowCount}r · ${Math.round(entry.durationMs)}ms`
      top.append(title, status)

      const sub = document.createElement('div')
      sub.className = 'file-chip-path'
      sub.textContent = entry.sql.replace(/\s+/g, ' ').trim()

      const foot = document.createElement('div')
      foot.className = 'history-card-foot'
      const timeEl = document.createElement('span')
      timeEl.className = 'history-time'
      timeEl.textContent = formatRelativeTime(entry.timestamp)

      const acts = document.createElement('div')
      acts.className = 'input-group'
      acts.style.gap = '4px'
      const insBtn = document.createElement('button')
      insBtn.type = 'button'
      insBtn.className = 'mini-btn'
      insBtn.textContent = 'Insert'
      insBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        setSqlText(entry.sql, { focus: true })
      })
      const cpyBtn = document.createElement('button')
      cpyBtn.type = 'button'
      cpyBtn.className = 'mini-btn'
      cpyBtn.textContent = 'Copy'
      cpyBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        void copyText(entry.sql, 'History SQL copied', cpyBtn)
      })
      acts.append(insBtn, cpyBtn)
      foot.append(timeEl, acts)

      item.append(top, sub, foot)
      list.appendChild(item)
    }
  }

  function markSqlRunCancelled() {
    cancelledSqlRunSeq = sqlRunSeq
  }

  function cancelPendingSqlRun() {
    cancelledSqlRunSeq = sqlRunSeq
    sqlRunSeq++
    if (sqlStopTimer) {
      sqlStopTimer()
      sqlStopTimer = null
    }
  }

  function bumpHistorySeq() {
    historySeq++
  }

  const fixAiBtnEl = $('sqlFixAiBtn')
  if (fixAiBtnEl) {
    boundFixAiBtn = fixAiBtnEl
    fixAiBtnEl.addEventListener('click', handleFixWithAiClick)
  }

  renderConsoleTabs()
  syncPanelAiButton()

  return {
    sqlVirt,
    getSqlText,
    setSqlText,
    focusSqlEditor,
    setSqlDialect,
    setSqlSchema,
    setSqlColorScheme,
    setSqlTypography,
    applySqlKeymapSettings,
    isSqlVimEscapeTarget,
    openSqlFindReplace,
    destroySqlEditor,
    renderConsoleTabs,
    restoreConsoleTabsState,
    getConsoleTabsPersistedState,
    clearSqlResultDisplay,
    clearAiGhost,
    clearAiFixPanel,
    clearDbSyntaxError,
    selectPanelResultSetIndex,
    renderSqlSafetyBanner,
    resetSqlSafetyBannerDismissal,
    dismissSqlSafetyBanner,
    dismissActiveSqlSuccessBanner,
    dismissActiveSqlErrorBanner,
    getSortedSqlRows,
    renderSqlSelectionStats,
    copySqlSelection,
    exportCurrentSqlResult,
    renderSqlVirtualWindow,
    ensureSqlVirtualRowVisible,
    renderSqlResultSkeleton,
    renderSqlResultTableOnly,
    renderQueryResult,
    runSql,
    loadQueryHistory,
    renderQueryHistory,
    markSqlRunCancelled,
    cancelPendingSqlRun,
    bumpHistorySeq,
    getSqlEditorHeight,
    setSqlEditorHeight,
    applyClampedSqlEditorHeight,
    cancelSqlEditorDrag: () => activeSqlDragCancel?.(),
    onAiStatusChanged,
    notifyAiAvailabilityChanged: onAiStatusChanged,
  }
}
