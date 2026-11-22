// src/panel/panel-structure.js
// Side Panel Visual Table Structure Designer, combobox popover, and migration confirmation controller

import {
  PANEL_COL_TYPES,
  PANEL_TYPE_SUGGESTIONS_BY_DRIVER,
  formatDdlForDisplay,
  createPanelStructDraft,
  getIndexColNames,
  getFkColName,
  countPanelStructChanges,
  buildPanelMigrationSql as coreBuildPanelMigrationSql,
  validatePanelStructDraft as coreValidatePanelStructDraft,
} from './panel-core.js'
import {
  $,
  rpc,
  makeTableKey,
  setButtonLoading,
  updateButtonLoadingLabel,
  createElapsedTimer,
  syncSelectTooltip,
} from './panel-utils.js'

export function createPanelStructureController(ctx) {
  const {
    state,
    QUERY_TIMEOUT_MS,
    getActiveConn,
    getConnById,
    showBanner,
    savePanelViewState,
    loadSchema,
    loadTableDetails,
    loadTablePage,
  } = ctx

  let activePanelComboPop = null
  let activePanelComboOwner = null
  let activePanelComboCleanup = null
  let pendingMigrationPlan = null

  function closePanelComboPopover() {
    if (activePanelComboCleanup) {
      activePanelComboCleanup()
      activePanelComboCleanup = null
    }
    if (activePanelComboPop) {
      activePanelComboPop.remove()
      activePanelComboPop = null
    }
    activePanelComboOwner = null
  }

  function createPanelComboInput(initialVal, items, disabled, onChange) {
    const wrap = document.createElement('div')
    wrap.className = 'struct-combo-wrap'
    const inp = document.createElement('input')
    inp.type = 'text'
    inp.className = 'struct-cell-input'
    inp.value = initialVal
    inp.disabled = Boolean(disabled)
    inp.addEventListener('input', () => onChange(inp.value))

    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'struct-combo-toggle'
    btn.tabIndex = -1
    btn.disabled = Boolean(disabled)
    btn.title = 'Choose type'
    btn.textContent = '▾'

    const openPop = () => {
      if (inp.disabled) return
      if (activePanelComboPop) {
        const wasSameOwner = activePanelComboOwner === wrap
        closePanelComboPopover()
        if (wasSameOwner) return
      }
      const pop = document.createElement('div')
      pop.className = 'struct-combo-popover'
      const curUpper = inp.value.trim().toUpperCase()
      for (const item of items) {
        const optBtn = document.createElement('button')
        optBtn.type = 'button'
        optBtn.className = `struct-combo-item${item.toUpperCase() === curUpper ? ' active' : ''}`
        optBtn.textContent = item
        optBtn.title = item
        optBtn.addEventListener('mousedown', (e) => {
          e.preventDefault()
          e.stopPropagation()
          inp.value = item
          onChange(item)
          closePanelComboPopover()
        })
        pop.appendChild(optBtn)
      }
      pop.style.visibility = 'hidden'
      pop.style.left = '6px'
      pop.style.top = '6px'
      document.body.appendChild(pop)
      activePanelComboPop = pop
      activePanelComboOwner = wrap

      const rect = wrap.getBoundingClientRect()
      const vh = window.innerHeight || 600
      const vw = window.innerWidth || 400
      const minW = Math.min(Math.max(136, Math.round(rect.width)), Math.max(120, vw - 12))
      pop.style.minWidth = `${minW}px`
      pop.style.maxWidth = `${Math.max(120, vw - 12)}px`

      const popRect = pop.getBoundingClientRect()
      const actualW = Math.min(Math.ceil(popRect.width || minW), Math.max(120, vw - 12))
      const desiredH = Math.min(210, Math.ceil(popRect.height || items.length * 25 + 8))
      const spaceBelow = Math.max(0, Math.floor(vh - rect.bottom - 8))
      const spaceAbove = Math.max(0, Math.floor(rect.top - 8))
      const openAbove = spaceBelow < desiredH && spaceAbove > spaceBelow
      const availH = openAbove ? spaceAbove : spaceBelow
      const maxH = Math.max(56, Math.min(210, availH))
      const usedH = Math.min(desiredH, maxH)
      const top = openAbove
        ? Math.max(6, Math.round(rect.top - usedH - 2))
        : Math.max(6, Math.min(Math.round(rect.bottom + 2), Math.max(6, vh - usedH - 6)))
      const left = Math.max(6, Math.min(Math.round(rect.left), Math.max(6, vw - actualW - 6)))
      pop.style.maxHeight = `${maxH}px`
      pop.style.top = `${top}px`
      pop.style.left = `${left}px`
      pop.style.visibility = ''

      const onDocDown = (ev) => {
        if (wrap.contains(ev.target) || pop.contains(ev.target)) return
        closePanelComboPopover()
      }
      const onAnyScroll = (ev) => {
        if (
          ev.target &&
          (ev.target === pop || (ev.target instanceof Node && pop.contains(ev.target)))
        ) {
          return
        }
        closePanelComboPopover()
      }
      const onWinResize = () => closePanelComboPopover()
      window.addEventListener('mousedown', onDocDown, true)
      document.addEventListener('scroll', onAnyScroll, true)
      window.addEventListener('resize', onWinResize)
      activePanelComboCleanup = () => {
        window.removeEventListener('mousedown', onDocDown, true)
        document.removeEventListener('scroll', onAnyScroll, true)
        window.removeEventListener('resize', onWinResize)
      }
    }

    btn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      openPop()
    })
    wrap.append(inp, btn)
    return { wrap, inp }
  }

  function buildPanelMigrationSql(draft, driver) {
    return coreBuildPanelMigrationSql(draft, driver)
  }

  function validatePanelStructDraft(draft, driver) {
    const knownTables = (
      (state.activeConnectionId && state.schemaObjects[state.activeConnectionId]) ||
      []
    )
      .filter((o) => o.kind === 'table')
      .map((o) => o.name)
    return coreValidatePanelStructDraft(draft, driver, knownTables)
  }

  function syncPanelColRename(colId, newName) {
    const draft = state.structDraft
    if (!draft || !colId) return
    const next = String(newName || '').trim()
    for (const idx of draft.indexes) {
      if (Array.isArray(idx.columnRefs)) {
        idx.columns = getIndexColNames(draft, idx)
      }
    }
    for (const fk of draft.foreignKeys) {
      if (fk.columnId === colId) fk.column = next
    }
    const displayLabel = next || '(unnamed)'
    document.querySelectorAll('#structureIdxList .struct-col-pill').forEach((p) => {
      if (p.dataset.colId === colId) p.textContent = displayLabel
    })
    document.querySelectorAll('#structureFkList select.struct-fk-col-select option').forEach((o) => {
      if (o.dataset.colId === colId) {
        o.value = next
        o.textContent = displayLabel
      }
    })
    document.querySelectorAll('#structureFkList select.struct-fk-col-select').forEach((sel) => {
      if (sel instanceof HTMLSelectElement) syncSelectTooltip(sel)
    })
  }

  function refreshPanelStructStageBar() {
    const draft = state.structDraft
    const count = countPanelStructChanges(draft)
    const activeConn = getActiveConn()
    const driver = activeConn?.driver || 'sqlite'
    const plan = validatePanelStructDraft(draft, driver)
    const titleInp = $('structureTableNameInput')
    if (titleInp && draft) {
      titleInp.classList.toggle(
        'dirty',
        titleInp.value.trim().length > 0 &&
          titleInp.value.trim() !== draft.originalTableName.trim()
      )
    }
    const applyBtn = $('btnStructApply')
    if (applyBtn) {
      applyBtn.textContent =
        count > 0 && plan.errors.length > 0
          ? `Fix Errors (${plan.errors.length}) [${count}]`
          : `Review & Apply [${count}]`
      applyBtn.disabled = count === 0
    }
    const revertBtn = $('btnStructRevert')
    if (revertBtn) revertBtn.disabled = count === 0
    const valBanner = $('structValidationBanner')
    const valText = $('structValidationText')
    if (valBanner && valText) {
      const showErr = count > 0 && plan.errors.length > 0
      valBanner.hidden = !showErr
      valText.textContent = showErr ? `Validation Error(s):\n• ${plan.errors.join('\n• ')}` : ''
    }
    const previewDrawer = $('structPreviewDrawer')
    const previewCode = $('structPreviewCode')
    const previewBtn = $('btnStructPreview')
    if (previewBtn) previewBtn.classList.toggle('btn-active', Boolean(state.structPreviewOpen))
    if (previewDrawer && previewCode) {
      previewDrawer.hidden = !state.structPreviewOpen
      if (state.structPreviewOpen && draft) {
        previewCode.textContent = plan.errors.length
          ? plan.errors.map((e) => `-- Validation Error: ${e}`).join('\n')
          : plan.statements.length
            ? plan.statements.join('\n\n')
            : '-- No staged structure changes yet.'
      }
    }
  }

  function closeMigrationConfirmModal(force = false) {
    if (state.isMigrating && !force) return
    $('confirmMigrationModal').hidden = true
    pendingMigrationPlan = null
  }

  function applyPanelStructChanges() {
    if (state.isMigrating || !state.activeConnectionId || !state.structDraft) return
    const conn = getActiveConn()
    if (conn?.readOnly) {
      showBanner('Read-Only connection — cannot alter table structure.', 'danger')
      return
    }
    const driver = conn?.driver || 'sqlite'
    const count = countPanelStructChanges(state.structDraft)
    if (count === 0) return
    const plan = validatePanelStructDraft(state.structDraft, driver)
    pendingMigrationPlan = plan
    $('confirmMigrationTitle').textContent = plan.valid
      ? `Confirm Migration — ${state.structDraft.originalTableName}`
      : 'Fix Invalid Schema Changes'
    $('confirmMigrationBadge').textContent = `${driver.toUpperCase()} · ${count} change(s)`

    const errEl = $('confirmMigrationErrors')
    errEl.hidden = plan.errors.length === 0
    errEl.textContent = plan.errors.length ? `Blocking Errors:\n• ${plan.errors.join('\n• ')}` : ''

    const warnEl = $('confirmMigrationWarnings')
    warnEl.hidden = plan.warnings.length === 0
    warnEl.textContent = plan.warnings.length
      ? `Safety Warnings:\n• ${plan.warnings.join('\n• ')}`
      : ''

    const diffEl = $('confirmMigrationDiffs')
    diffEl.textContent = plan.diffs.join('\n')
    diffEl.style.whiteSpace = 'pre-wrap'

    $('confirmMigrationSql').textContent = plan.statements.length
      ? plan.statements.join('\n\n')
      : '-- Resolve errors above to generate valid migration SQL.'

    const execBtn = $('confirmMigrationExecuteBtn')
    const hasDestructive =
      state.structDraft.columns.some((c) => c.status === 'deleted') ||
      state.structDraft.foreignKeys.some((f) => f.status === 'deleted')
    setButtonLoading(execBtn, false)
    execBtn.disabled = !plan.valid || plan.statements.length === 0
    execBtn.textContent = plan.valid ? 'Confirm & Execute' : 'Fix Errors to Apply'
    execBtn.className = `btn btn-sm ${hasDestructive ? 'btn-danger-solid' : 'btn-primary'}`
    if ($('cancelMigrationBtn')) $('cancelMigrationBtn').disabled = false
    if ($('copyMigrationSqlModalBtn')) $('copyMigrationSqlModalBtn').disabled = false
    $('confirmMigrationModal').hidden = false
  }

  async function executeConfirmedPanelMigration() {
    const plan = pendingMigrationPlan
    if (
      state.isMigrating ||
      !plan ||
      !plan.valid ||
      !plan.statements.length ||
      !state.activeConnectionId ||
      !state.structDraft
    ) {
      return
    }
    const targetConnId = state.activeConnectionId
    const targetTable = state.activeTable
    const targetSchema = state.activeSchema
    const nextTable = state.structDraft.tableName.trim()
    state.isMigrating = true
    const execBtn = $('confirmMigrationExecuteBtn')
    const cancelBtn = $('cancelMigrationBtn')
    const copyBtn = $('copyMigrationSqlModalBtn')
    const errEl = $('confirmMigrationErrors')
    if (errEl) {
      errEl.hidden = true
      errEl.textContent = ''
    }
    setButtonLoading(execBtn, true, 'Applying migration... (0.0s)')
    if (cancelBtn) cancelBtn.disabled = true
    if (copyBtn) copyBtn.disabled = true
    if ($('btnStructApply')) $('btnStructApply').disabled = true
    if ($('btnStructRevert')) $('btnStructRevert').disabled = true

    const stopTimer = createElapsedTimer((elapsed) => {
      updateButtonLoadingLabel(execBtn, `Applying migration... (${elapsed})`)
    })
    const sql = plan.statements.join('\n')
    try {
      const queryId = `panel_migrate_${Date.now()}`
      await rpc(
        'query.run',
        { connectionId: targetConnId, queryId, sql },
        { timeoutMs: QUERY_TIMEOUT_MS }
      )
      stopTimer()
      delete state.tableDetails[makeTableKey(targetConnId, targetTable, targetSchema)]
      state.isMigrating = false
      setButtonLoading(execBtn, false)
      if (cancelBtn) cancelBtn.disabled = false
      if (copyBtn) copyBtn.disabled = false
      closeMigrationConfirmModal(true)

      const stillSameContext =
        state.activeConnectionId === targetConnId &&
        state.activeTable === targetTable &&
        (state.activeSchema || '') === (targetSchema || '')
      if (stillSameContext) {
        if (nextTable && nextTable !== state.activeTable) {
          state.activeTable = nextTable
        }
        state.structDraftKey = null
        state.structDraft = null
        state.structPreviewOpen = false
        showBanner(`Applied ${plan.statements.length} schema change(s)`, 'success')
        savePanelViewState()
        await loadSchema(targetConnId)
        if (state.activeConnectionId === targetConnId && state.activeTable) {
          await loadTableDetails(targetConnId, state.activeTable, state.activeSchema)
          await loadTablePage(targetConnId, state.activeTable, 1, state.activeSchema)
        }
      } else if (getConnById(targetConnId)) {
        showBanner(`Applied ${plan.statements.length} schema change(s)`, 'success')
        void loadSchema(targetConnId)
      }
    } catch (err) {
      stopTimer()
      state.isMigrating = false
      setButtonLoading(execBtn, false)
      if (cancelBtn) cancelBtn.disabled = false
      if (copyBtn) copyBtn.disabled = false
      refreshPanelStructStageBar()
      const msg = err?.message || String(err)
      if (errEl) {
        errEl.hidden = false
        errEl.textContent = `Migration Failed:\n${msg}`
      }
      showBanner(`Schema migration failed: ${msg}`, 'danger')
    }
  }

  function renderStructure() {
    closePanelComboPopover()
    const detailsKey =
      state.activeConnectionId && state.activeTable
        ? makeTableKey(state.activeConnectionId, state.activeTable, state.activeSchema)
        : null
    const details = detailsKey ? state.tableDetails[detailsKey] : null
    if (!details) {
      if (state.structureLoading && state.activeTable) {
        $('structureEmpty').hidden = true
        $('structureContent').hidden = false
        const structToolbar = $('structureToolbar')
        if (structToolbar) structToolbar.hidden = true
        const valBanner = $('structValidationBanner')
        if (valBanner) valBanner.hidden = true
        const previewDrawer = $('structPreviewDrawer')
        if (previewDrawer) previewDrawer.hidden = true
        const kv = $('structureKv')
        if (kv) {
          kv.textContent = ''
          for (const w of ['65%', '50%', '72%']) {
            const card = document.createElement('div')
            card.className = 'kv-item'
            const bar1 = document.createElement('div')
            bar1.className = 'panel-skeleton-bar'
            bar1.style.width = '45%'
            bar1.style.height = '9px'
            bar1.style.marginBottom = '5px'
            const bar2 = document.createElement('div')
            bar2.className = 'panel-skeleton-bar'
            bar2.style.width = w
            bar2.style.height = '12px'
            card.append(bar1, bar2)
            kv.appendChild(card)
          }
        }
        const colTbl = $('structureColTable')
        if (colTbl) {
          colTbl.textContent = ''
          const thead = document.createElement('thead')
          const hr = document.createElement('tr')
          for (const h of ['Column', 'Type', 'PK', 'Null', 'Default']) {
            const th = document.createElement('th')
            th.textContent = h
            hr.appendChild(th)
          }
          thead.appendChild(hr)
          colTbl.appendChild(thead)
          const tbody = document.createElement('tbody')
          for (let r = 0; r < 6; r++) {
            const tr = document.createElement('tr')
            for (let c = 0; c < 5; c++) {
              const td = document.createElement('td')
              const bar = document.createElement('div')
              bar.className = 'panel-skeleton-bar'
              bar.style.width = `${48 + ((r * 13 + c * 17) % 38)}%`
              td.appendChild(bar)
              tr.appendChild(td)
            }
            tbody.appendChild(tr)
          }
          colTbl.appendChild(tbody)
        }
        $('structureIdxWrap').hidden = true
        $('structureFkWrap').hidden = true
        $('structureDdlCode').textContent = `-- Loading schema for ${state.activeTable}...`
        return
      }
      const emptyBox = $('structureEmpty')
      emptyBox.hidden = false
      $('structureContent').hidden = true
      emptyBox.textContent = ''
      if (state.structureError && state.activeTable) {
        const t = document.createElement('div')
        t.className = 'empty-title'
        t.style.color = 'var(--danger)'
        t.textContent = `Failed to load schema for "${state.activeTable}"`
        const d = document.createElement('div')
        d.className = 'empty-desc'
        d.textContent = state.structureError
        const retryBtn = document.createElement('button')
        retryBtn.type = 'button'
        retryBtn.className = 'btn btn-primary btn-sm'
        retryBtn.textContent = 'Retry'
        retryBtn.addEventListener('click', () => {
          if (state.activeConnectionId && state.activeTable) {
            void loadTableDetails(state.activeConnectionId, state.activeTable, state.activeSchema)
          }
        })
        emptyBox.append(t, d, retryBtn)
      } else {
        const t = document.createElement('div')
        t.className = 'empty-title'
        t.textContent = 'No Table Selected'
        const d = document.createElement('div')
        d.className = 'empty-desc'
        d.textContent =
          'Select a table in Explorer to inspect columns, primary keys, indexes, foreign keys, and live CREATE DDL.'
        emptyBox.append(t, d)
      }
      return
    }
    $('structureEmpty').hidden = true
    $('structureContent').hidden = false

    if (state.structDraftKey !== detailsKey || !state.structDraft) {
      state.structDraftKey = detailsKey
      state.structDraft = createPanelStructDraft(details)
      state.structPreviewOpen = false
    }

    const activeConn = getActiveConn()
    const canEditStructure =
      details.kind !== 'view' && activeConn?.driver !== 'redis' && !activeConn?.readOnly

    const structToolbar = $('structureToolbar')
    const titleInp = $('structureTableNameInput')
    if (structToolbar) structToolbar.hidden = !canEditStructure
    if (titleInp && state.structDraft) {
      titleInp.value = state.structDraft.tableName
    }

    const kv = $('structureKv')
    kv.textContent = ''
    const kvData = [
      ['Table', details.name],
      ['Primary Key', (details.primaryKey || []).join(', ') || 'None'],
      [
        'Cols / Idx / FK',
        `${details.columns.length} / ${(details.indexes || []).length} / ${(details.foreignKeys || []).length}`,
      ],
    ]
    for (const [k, v] of kvData) {
      const card = document.createElement('div')
      card.className = 'kv-item'
      const lbl = document.createElement('span')
      lbl.className = 'kv-label'
      lbl.textContent = k
      const val = document.createElement('span')
      val.className = 'kv-value'
      val.textContent = v
      card.append(lbl, val)
      kv.appendChild(card)
    }

    $('structureDdlCode').textContent = details.ddl
      ? formatDdlForDisplay(details.ddl)
      : '-- DDL unavailable for this object.'

    const colTbl = $('structureColTable')
    colTbl.textContent = ''
    const thead = document.createElement('thead')
    const hr = document.createElement('tr')
    const colHeaders = canEditStructure
      ? ['Column', 'Type', 'PK', 'Null', 'Default', 'Act']
      : ['Column', 'Type', 'Key', 'Null', 'Default']
    for (const h of colHeaders) {
      const th = document.createElement('th')
      th.textContent = h
      hr.appendChild(th)
    }
    thead.appendChild(hr)
    colTbl.appendChild(thead)

    const tbody = document.createElement('tbody')
    const draft = state.structDraft

    if (!canEditStructure) {
      for (const c of details.columns) {
        const tr = document.createElement('tr')
        const vals = [
          c.name,
          c.nativeType || c.type,
          c.isPrimaryKey ? 'PK' : '',
          c.nullable ? 'YES' : 'NO',
          c.defaultValue ?? 'NULL',
        ]
        for (const v of vals) {
          const td = document.createElement('td')
          td.textContent = v
          tr.appendChild(td)
        }
        tbody.appendChild(tr)
      }
    } else {
      for (const col of draft.columns) {
        const tr = document.createElement('tr')
        if (col.status === 'new') tr.classList.add('row-inserted')
        if (col.status === 'deleted') tr.classList.add('row-deleted')
        const isDel = col.status === 'deleted'

        const nameTd = document.createElement('td')
        nameTd.className = 'struct-td-input'
        const nameInp = document.createElement('input')
        nameInp.type = 'text'
        nameInp.className = 'struct-cell-input'
        nameInp.value = col.name
        nameInp.disabled = isDel
        nameInp.addEventListener('input', () => {
          col.name = nameInp.value
          syncPanelColRename(col.id, col.name.trim())
          nameTd.classList.toggle(
            'cell-edited',
            col.status === 'existing' && col.name.trim() !== (col.originalName || '').trim()
          )
          refreshPanelStructStageBar()
        })
        if (col.status === 'existing' && col.name.trim() !== (col.originalName || '').trim()) {
          nameTd.classList.add('cell-edited')
        }
        nameTd.appendChild(nameInp)
        tr.appendChild(nameTd)

        const typeTd = document.createElement('td')
        typeTd.className = 'struct-td-input'
        const { wrap: typeComboWrap } = createPanelComboInput(
          col.dataType,
          PANEL_TYPE_SUGGESTIONS_BY_DRIVER[getActiveConn()?.driver || 'sqlite'] || PANEL_COL_TYPES,
          isDel,
          (nextVal) => {
            col.dataType = nextVal
            typeTd.classList.toggle(
              'cell-edited',
              col.status === 'existing' &&
                col.dataType.trim().toUpperCase() !==
                  (col.originalDataType || 'TEXT').trim().toUpperCase()
            )
            refreshPanelStructStageBar()
          }
        )
        if (
          col.status === 'existing' &&
          col.dataType.trim().toUpperCase() !==
            (col.originalDataType || 'TEXT').trim().toUpperCase()
        ) {
          typeTd.classList.add('cell-edited')
        }
        typeTd.appendChild(typeComboWrap)
        tr.appendChild(typeTd)

        const pkTd = document.createElement('td')
        pkTd.style.textAlign = 'center'
        const pkCb = document.createElement('input')
        pkCb.type = 'checkbox'
        pkCb.className = 'struct-checkbox'
        pkCb.checked = col.isPrimaryKey
        pkCb.disabled = isDel
        pkTd.appendChild(pkCb)
        tr.appendChild(pkTd)

        const nullTd = document.createElement('td')
        nullTd.style.textAlign = 'center'
        const nullCb = document.createElement('input')
        nullCb.type = 'checkbox'
        nullCb.className = 'struct-checkbox'
        nullCb.checked = col.nullable
        nullCb.disabled = isDel || col.isPrimaryKey
        nullTd.appendChild(nullCb)
        tr.appendChild(nullTd)

        pkCb.addEventListener('change', () => {
          col.isPrimaryKey = Boolean(pkCb.checked)
          if (col.isPrimaryKey) {
            col.nullable = false
            nullCb.checked = false
          }
          nullCb.disabled = isDel || col.isPrimaryKey
          pkTd.classList.toggle(
            'cell-edited',
            col.status === 'existing' && col.isPrimaryKey !== Boolean(col.originalIsPrimaryKey)
          )
          nullTd.classList.toggle(
            'cell-edited',
            col.status === 'existing' && col.nullable !== Boolean(col.originalNullable)
          )
          refreshPanelStructStageBar()
        })

        nullCb.addEventListener('change', () => {
          col.nullable = Boolean(nullCb.checked)
          nullTd.classList.toggle(
            'cell-edited',
            col.status === 'existing' && col.nullable !== Boolean(col.originalNullable)
          )
          refreshPanelStructStageBar()
        })

        const defTd = document.createElement('td')
        const defWrap = document.createElement('div')
        defWrap.className = 'struct-default-wrap'
        const defInp = document.createElement('input')
        defInp.type = 'text'
        defInp.className = 'struct-cell-input'
        defInp.value = col.defaultValue
        defInp.disabled = isDel
        defInp.placeholder = col.nullable ? 'NULL' : 'None'
        const clrBtn = document.createElement('button')
        clrBtn.type = 'button'
        clrBtn.className = 'struct-clear-btn'
        clrBtn.textContent = '×'
        clrBtn.title = 'Clear Default'
        clrBtn.hidden = !col.defaultValue || isDel

        const syncDef = () => {
          clrBtn.hidden = !col.defaultValue || isDel
          defTd.classList.toggle(
            'cell-edited',
            col.status === 'existing' &&
              col.defaultValue.trim() !== (col.originalDefaultValue || '').trim()
          )
          refreshPanelStructStageBar()
        }
        defInp.addEventListener('input', () => {
          col.defaultValue = defInp.value
          syncDef()
        })
        clrBtn.addEventListener('click', () => {
          col.defaultValue = ''
          defInp.value = ''
          syncDef()
        })
        if (
          col.status === 'existing' &&
          col.defaultValue.trim() !== (col.originalDefaultValue || '').trim()
        ) {
          defTd.classList.add('cell-edited')
        }
        defWrap.append(defInp, clrBtn)
        defTd.appendChild(defWrap)
        tr.appendChild(defTd)

        const actTd = document.createElement('td')
        const actBtn = document.createElement('button')
        actBtn.type = 'button'
        actBtn.className = 'btn btn-sm'
        if (col.status === 'new') {
          actBtn.textContent = '×'
          actBtn.title = 'Remove staged column'
          actBtn.addEventListener('click', () => {
            const p = draft.columns.indexOf(col)
            if (p !== -1) draft.columns.splice(p, 1)
            renderStructure()
          })
        } else if (col.status === 'deleted') {
          actBtn.textContent = 'Undo'
          actBtn.addEventListener('click', () => {
            col.status = 'existing'
            renderStructure()
          })
        } else {
          actBtn.textContent = 'Drop'
          actBtn.classList.add('btn-danger')
          actBtn.addEventListener('click', () => {
            col.status = 'deleted'
            renderStructure()
          })
        }
        actTd.appendChild(actBtn)
        tr.appendChild(actTd)
        tbody.appendChild(tr)
      }
    }
    colTbl.appendChild(tbody)

    const idxWrap = $('structureIdxWrap')
    const idxList = $('structureIdxList')
    idxList.textContent = ''
    const showIdx = canEditStructure || (details.indexes && details.indexes.length > 0)
    idxWrap.hidden = !showIdx
    if (showIdx) {
      const items = canEditStructure ? draft.indexes : details.indexes || []
      const activeCols = canEditStructure
        ? draft.columns.filter((c) => c.status !== 'deleted')
        : []
      if (items.length === 0) {
        const note = document.createElement('div')
        note.className = 'muted'
        note.style.fontSize = '12px'
        note.textContent = 'No indexes yet. Click + Index above to create an INDEX or UNIQUE KEY.'
        idxList.appendChild(note)
      }
      for (const idx of items) {
        const item = document.createElement('div')
        item.className = `struct-item-card${idx.status === 'new' ? ' inserted' : idx.status === 'deleted' ? ' deleted' : ''}`
        if (canEditStructure && idx.status === 'new') {
          const topRow = document.createElement('div')
          topRow.className = 'input-group'
          topRow.style.gap = '6px'
          const idxNameInp = document.createElement('input')
          idxNameInp.type = 'text'
          idxNameInp.className = 'struct-cell-input'
          idxNameInp.value = idx.name
          idxNameInp.addEventListener('input', () => {
            idx.name = idxNameInp.value
            refreshPanelStructStageBar()
          })
          const kindSel = document.createElement('select')
          kindSel.className = 'struct-cell-select'
          kindSel.style.width = 'auto'
          const o1 = new Option('INDEX', 'index', !idx.unique, !idx.unique)
          const o2 = new Option('UNIQUE', 'unique', Boolean(idx.unique), Boolean(idx.unique))
          kindSel.append(o1, o2)
          syncSelectTooltip(kindSel)
          kindSel.addEventListener('change', () => {
            idx.unique = kindSel.value === 'unique'
            syncSelectTooltip(kindSel)
            refreshPanelStructStageBar()
          })
          const remBtn = document.createElement('button')
          remBtn.type = 'button'
          remBtn.className = 'btn btn-sm'
          remBtn.textContent = '×'
          remBtn.addEventListener('click', () => {
            const p = draft.indexes.indexOf(idx)
            if (p !== -1) draft.indexes.splice(p, 1)
            renderStructure()
          })
          topRow.append(idxNameInp, kindSel, remBtn)

          const pillsRow = document.createElement('div')
          pillsRow.className = 'struct-col-pills'
          if (!Array.isArray(idx.columnRefs)) {
            idx.columnRefs = (idx.columns || []).map((cn) => ({
              colId: activeCols.find((ac) => ac.name === cn)?.id || null,
              fallbackName: cn,
            }))
          }
          const selectedIds = new Set(idx.columnRefs.map((r) => r.colId).filter(Boolean))
          for (const c of activeCols) {
            const pill = document.createElement('button')
            pill.type = 'button'
            const isSelected = selectedIds.has(c.id)
            pill.className = `struct-col-pill${isSelected ? ' active' : ''}`
            pill.dataset.colId = c.id
            pill.textContent = c.name.trim() || '(unnamed)'
            pill.addEventListener('click', () => {
              const pos = idx.columnRefs.findIndex((r) => r.colId === c.id)
              if (pos !== -1) {
                if (idx.columnRefs.length > 1) idx.columnRefs.splice(pos, 1)
              } else {
                idx.columnRefs.push({ colId: c.id, fallbackName: c.name })
              }
              idx.columns = getIndexColNames(draft, idx)
              pill.classList.toggle(
                'active',
                idx.columnRefs.some((r) => r.colId === c.id)
              )
              refreshPanelStructStageBar()
            })
            pillsRow.appendChild(pill)
          }
          item.append(topRow, pillsRow)
        } else {
          const top = document.createElement('div')
          top.className = 'file-chip-top'
          const n = document.createElement('span')
          n.className = 'file-chip-name'
          n.textContent = idx.name
          const grp = document.createElement('div')
          grp.className = 'input-group'
          grp.style.gap = '4px'
          const b = document.createElement('span')
          b.className = idx.isUnique || idx.unique ? 'badge badge-ok' : 'badge badge-neutral'
          b.textContent = idx.isPrimary
            ? 'PRIMARY'
            : idx.isUnique || idx.unique
              ? 'UNIQUE'
              : 'INDEX'
          grp.appendChild(b)
          if (canEditStructure && !idx.isPrimary && !/^sqlite_autoindex_/i.test(idx.name)) {
            const dropBtn = document.createElement('button')
            dropBtn.type = 'button'
            dropBtn.className = 'btn btn-sm'
            dropBtn.textContent = idx.status === 'deleted' ? 'Undo' : 'Drop'
            dropBtn.addEventListener('click', () => {
              idx.status = idx.status === 'deleted' ? 'existing' : 'deleted'
              renderStructure()
            })
            grp.appendChild(dropBtn)
          }
          top.append(n, grp)
          const sub = document.createElement('div')
          sub.className = 'file-chip-path'
          sub.textContent = (
            canEditStructure ? getIndexColNames(draft, idx) : idx.columns || []
          ).join(', ')
          item.append(top, sub)
        }
        idxList.appendChild(item)
      }
    }

    const fkWrap = $('structureFkWrap')
    const fkList = $('structureFkList')
    fkList.textContent = ''
    const fks = canEditStructure
      ? draft.foreignKeys
      : Array.isArray(details.foreignKeys)
        ? details.foreignKeys
        : []
    const showFk = canEditStructure || fks.length > 0
    fkWrap.hidden = !showFk
    if (showFk) {
      const activeCols = canEditStructure
        ? draft.columns.filter((c) => c.status !== 'deleted')
        : []
      const connTables = (
        (state.activeConnectionId && state.schemaObjects[state.activeConnectionId]) ||
        []
      )
        .filter((o) => o.kind === 'table')
        .map((o) => o.name)
      if (fks.length === 0) {
        const note = document.createElement('div')
        note.className = 'muted'
        note.style.fontSize = '12px'
        note.textContent = 'No foreign keys yet. Click + FK above to link to another table.'
        fkList.appendChild(note)
      }
      for (const fk of fks) {
        const item = document.createElement('div')
        item.className = `struct-item-card${fk.status === 'new' ? ' inserted' : fk.status === 'deleted' ? ' deleted' : ''}`
        if (canEditStructure && fk.status === 'new') {
          const row1 = document.createElement('div')
          row1.className = 'input-group'
          row1.style.gap = '6px'
          const colSel = document.createElement('select')
          colSel.className = 'struct-cell-select struct-fk-col-select'
          for (const c of activeCols) {
            const isMatch = fk.columnId ? c.id === fk.columnId : c.name === fk.column
            const opt = new Option(c.name.trim() || '(unnamed)', c.name, isMatch, isMatch)
            opt.dataset.colId = c.id
            colSel.appendChild(opt)
          }
          syncSelectTooltip(colSel)
          colSel.addEventListener('change', () => {
            const selOpt = colSel.selectedOptions?.[0]
            fk.columnId =
              selOpt?.dataset?.colId || activeCols.find((c) => c.name === colSel.value)?.id || null
            fk.column = colSel.value
            syncSelectTooltip(colSel)
            refreshPanelStructStageBar()
          })

          const { wrap: refTblComboWrap, inp: refTblInp } = createPanelComboInput(
            fk.foreignTable || '',
            connTables,
            false,
            (nextVal) => {
              fk.foreignTable = nextVal
              refreshPanelStructStageBar()
            }
          )
          refTblComboWrap.style.flex = '1'
          refTblInp.placeholder = connTables[0] ? `Target (${connTables[0]})` : 'Target table'

          const refColInp = document.createElement('input')
          refColInp.type = 'text'
          refColInp.className = 'struct-cell-input'
          refColInp.value = fk.foreignColumn || 'id'
          refColInp.placeholder = 'Target col'
          refColInp.addEventListener('input', () => {
            fk.foreignColumn = refColInp.value
            refreshPanelStructStageBar()
          })

          row1.append(colSel, refTblComboWrap, refColInp)

          const row2 = document.createElement('div')
          row2.className = 'input-group'
          row2.style.gap = '6px'
          const onDelSel = document.createElement('select')
          onDelSel.className = 'struct-cell-select'
          for (const act of ['NO ACTION', 'CASCADE', 'SET NULL', 'RESTRICT']) {
            onDelSel.appendChild(
              new Option(`ON DELETE ${act}`, act, act === fk.onDelete, act === fk.onDelete)
            )
          }
          syncSelectTooltip(onDelSel)
          onDelSel.addEventListener('change', () => {
            fk.onDelete = onDelSel.value
            syncSelectTooltip(onDelSel)
            refreshPanelStructStageBar()
          })

          const remBtn = document.createElement('button')
          remBtn.type = 'button'
          remBtn.className = 'btn btn-sm'
          remBtn.textContent = '×'
          remBtn.addEventListener('click', () => {
            const p = draft.foreignKeys.indexOf(fk)
            if (p !== -1) draft.foreignKeys.splice(p, 1)
            renderStructure()
          })
          row2.append(onDelSel, remBtn)
          item.append(row1, row2)
        } else {
          const top = document.createElement('div')
          top.className = 'file-chip-top'
          const n = document.createElement('span')
          n.className = 'file-chip-name'
          const fkColLabel = canEditStructure ? getFkColName(draft, fk) : fk.column
          n.textContent = `${fkColLabel} → ${fk.foreignTable || fk.referencedTable}.${fk.foreignColumn || fk.referencedColumn}`
          const grp = document.createElement('div')
          grp.className = 'input-group'
          grp.style.gap = '4px'
          const b = document.createElement('span')
          b.className = 'badge badge-warn'
          b.textContent = 'FK'
          grp.appendChild(b)
          if (canEditStructure) {
            const dropBtn = document.createElement('button')
            dropBtn.type = 'button'
            dropBtn.className = 'btn btn-sm'
            dropBtn.textContent = fk.status === 'deleted' ? 'Undo' : 'Drop'
            dropBtn.addEventListener('click', () => {
              fk.status = fk.status === 'deleted' ? 'existing' : 'deleted'
              renderStructure()
            })
            grp.appendChild(dropBtn)
          }
          top.append(n, grp)
          const sub = document.createElement('div')
          sub.className = 'file-chip-path'
          sub.textContent = fk.constraintName || `${fk.column}_fk`
          item.append(top, sub)
        }
        fkList.appendChild(item)
      }
    }

    refreshPanelStructStageBar()
  }

  function isPanelComboOpen() {
    return Boolean(activePanelComboPop)
  }

  return {
    isPanelComboOpen,
    closePanelComboPopover,
    createPanelComboInput,
    buildPanelMigrationSql,
    validatePanelStructDraft,
    syncPanelColRename,
    refreshPanelStructStageBar,
    closeMigrationConfirmModal,
    applyPanelStructChanges,
    executeConfirmedPanelMigration,
    renderStructure,
  }
}
