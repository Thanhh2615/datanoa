// src/editor/studio-columns-popover.ts
// Floating column visibility, ordering, pinning, wrap & conditional highlighting popover

import type { ConditionalHighlightOperator, ConditionalHighlightRule, ConditionalHighlightTone } from '../protocol.js'
import {
  CONDITIONAL_HIGHLIGHT_OPERATORS,
  HIGHLIGHT_TONES,
  areHighlightRulesEqual,
} from '../shared-table-display.js'
import type { VirtualDataGrid } from './grid.js'

export interface MountedColumnsPopover {
  popoverEl: HTMLDivElement
  outsideCleanup: (() => void) | null
  syncState?: () => void
}

export function mountStudioColumnsPopover(
  dataGrid: VirtualDataGrid,
  anchorBtn: HTMLButtonElement,
  onClose: () => void
): MountedColumnsPopover {
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

  let draggedColName: string | null = null
  let pendingFocusColName: string | null = null
  const rowViews = new Map<
    string,
    { row: HTMLDivElement; cb: HTMLInputElement; pinBtn: HTMLButtonElement }
  >()
  let renderedColOrder: string[] = []
  let lastRenderedHlRules: ConditionalHighlightRule[] = []

  const syncRowsInPlace = (
    cols: readonly string[],
    hiddenSet: ReadonlySet<string>,
    pinnedSet: ReadonlySet<string>
  ): boolean => {
    if (cols.length === 0 || rowViews.size !== cols.length || renderedColOrder.length !== cols.length) {
      return false
    }
    for (let i = 0; i < cols.length; i++) {
      if (renderedColOrder[i] !== cols[i]) return false
      const view = rowViews.get(cols[i])
      if (!view || view.row.parentElement !== listEl) return false
    }
    for (let i = 0; i < cols.length; i++) {
      const colName = cols[i]
      const view = rowViews.get(colName)
      if (!view) continue
      const nextChecked = !hiddenSet.has(colName)
      if (view.cb.checked !== nextChecked) {
        view.cb.checked = nextChecked
      }
      const isPinned = pinnedSet.has(colName)
      view.pinBtn.classList.toggle('active', isPinned)
      const nextPinText = isPinned ? 'Unpin' : 'Pin'
      if (view.pinBtn.textContent !== nextPinText) {
        view.pinBtn.textContent = nextPinText
      }
    }
    return true
  }

  const renderList = (forceRebuild = false): void => {
    const cfg = dataGrid.getColumnConfig()
    const hiddenSet = new Set(cfg.hidden)
    const pinnedSet = new Set(cfg.pinned)
    const q = searchInp.value.trim().toLowerCase()
    const cols = q
      ? cfg.allColumns.filter((c) => c.toLowerCase().includes(q))
      : cfg.allColumns

    if (!forceRebuild && syncRowsInPlace(cols, hiddenSet, pinnedSet)) {
      return
    }

    rowViews.clear()
    renderedColOrder = [...cols]
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
      row.tabIndex = 0
      row.draggable = true
      row.dataset.colName = colName
      row.title = 'Drag to reorder or press Alt+ArrowUp / Alt+ArrowDown'

      row.addEventListener('keydown', (e) => {
        if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
        e.preventDefault()
        e.stopPropagation()
        const delta: -1 | 1 = e.key === 'ArrowUp' ? -1 : 1
        if (dataGrid.moveColumnOrderByOffset?.(colName, delta)) {
          pendingFocusColName = colName
          renderList(true)
        }
      })

      row.addEventListener('dragstart', (e) => {
        draggedColName = colName
        e.dataTransfer?.setData('text/plain', colName)
      })
      row.addEventListener('dragover', (e) => {
        if (draggedColName && draggedColName !== colName) {
          e.preventDefault()
          row.classList.add('datanoa-cols-row-drop-target')
        }
      })
      row.addEventListener('dragleave', () => {
        row.classList.remove('datanoa-cols-row-drop-target')
      })
      row.addEventListener('drop', (e) => {
        e.preventDefault()
        row.classList.remove('datanoa-cols-row-drop-target')
        const from = draggedColName || e.dataTransfer?.getData('text/plain') || ''
        draggedColName = null
        if (from && from !== colName) {
          dataGrid.reorderColumn?.(from, colName, 'before')
          renderList(true)
        }
      })

      const grip = document.createElement('span')
      grip.className = 'datanoa-cols-grip'
      grip.textContent = '::'
      grip.setAttribute('aria-hidden', 'true')

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
        dataGrid.setColumnVisibility(colName, cb.checked)
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
        dataGrid.togglePinColumn(colName)
        renderList()
      })

      row.appendChild(grip)
      row.appendChild(label)
      row.appendChild(pinBtn)
      listEl.appendChild(row)
      rowViews.set(colName, { row, cb, pinBtn })

      if (pendingFocusColName === colName) {
        pendingFocusColName = null
        row.focus?.()
      }
    }
  }

  // Wrap Cells toggle + Max Lines control
  const wrapSection = document.createElement('div')
  wrapSection.className = 'datanoa-cols-popover-section'

  const wrapCfg = dataGrid.getWrapCellsConfig?.() ?? { wrapCells: false, wrapMaxLines: 4 }
  const wrapLabel = document.createElement('label')
  wrapLabel.className = 'datanoa-cols-wrap-label'
  const wrapCb = document.createElement('input')
  wrapCb.type = 'checkbox'
  wrapCb.dataset.colsWrapToggle = 'true'
  wrapCb.checked = wrapCfg.wrapCells
  const wrapText = document.createElement('span')
  wrapText.textContent = 'Wrap cells'
  wrapLabel.appendChild(wrapCb)
  wrapLabel.appendChild(wrapText)

  const maxLinesLabel = document.createElement('label')
  maxLinesLabel.className = 'datanoa-cols-wrap-lines'
  maxLinesLabel.textContent = 'Max lines'
  const maxLinesInp = document.createElement('input')
  maxLinesInp.type = 'number'
  maxLinesInp.min = '1'
  maxLinesInp.max = '10'
  maxLinesInp.value = String(wrapCfg.wrapMaxLines)
  maxLinesInp.className = 'datanoa-input datanoa-cols-lines-input'
  maxLinesInp.dataset.colsWrapMaxLines = 'true'
  maxLinesLabel.appendChild(maxLinesInp)

  const syncWrap = (): void => {
    const parsedLines = Number.parseInt(maxLinesInp.value, 10)
    dataGrid.setWrapCells?.(wrapCb.checked, Number.isFinite(parsedLines) ? parsedLines : 4)
  }
  wrapCb.addEventListener('change', syncWrap)
  maxLinesInp.addEventListener('change', syncWrap)

  wrapSection.appendChild(wrapLabel)
  wrapSection.appendChild(maxLinesLabel)

  // Conditional Highlighting section
  const hlSection = document.createElement('div')
  hlSection.className = 'datanoa-cols-popover-section datanoa-cols-hl-section'

  const hlHeader = document.createElement('div')
  hlHeader.className = 'datanoa-cols-hl-head'
  const hlTitle = document.createElement('span')
  hlTitle.textContent = 'Conditional Highlighting'
  const hlAddBtn = document.createElement('button')
  hlAddBtn.type = 'button'
  hlAddBtn.className = 'datanoa-btn datanoa-btn-sm'
  hlAddBtn.dataset.colsHlAdd = 'true'
  hlAddBtn.textContent = '+ Rule'
  hlHeader.appendChild(hlTitle)
  hlHeader.appendChild(hlAddBtn)

  const hlListEl = document.createElement('div')
  hlListEl.className = 'datanoa-cols-hl-list'

  const renderHighlightRules = (): void => {
    hlListEl.innerHTML = ''
    const rules = dataGrid.getHighlightRules?.() ?? []
    lastRenderedHlRules = rules.map((r) => ({ ...r }))
    const cols = dataGrid.getColumnConfig().allColumns
    for (let idx = 0; idx < rules.length; idx++) {
      const rule = rules[idx]
      const item = document.createElement('div')
      item.className = 'datanoa-cols-hl-row'

      const colSel = document.createElement('select')
      colSel.className = 'datanoa-select datanoa-cols-hl-col'
      for (const c of cols.length > 0 ? cols : [rule.column]) {
        const opt = document.createElement('option')
        opt.value = c
        opt.textContent = c
        if (c === rule.column) opt.selected = true
        colSel.appendChild(opt)
      }

      const opSel = document.createElement('select')
      opSel.className = 'datanoa-select datanoa-cols-hl-op'
      for (const op of CONDITIONAL_HIGHLIGHT_OPERATORS) {
        const opt = document.createElement('option')
        opt.value = op
        opt.textContent = op
        if (op === rule.operator) opt.selected = true
        opSel.appendChild(opt)
      }

      const valInp = document.createElement('input')
      valInp.type = 'text'
      valInp.className = 'datanoa-input datanoa-cols-hl-val'
      valInp.placeholder = 'Value'
      valInp.value = rule.value ?? ''

      const targetSel = document.createElement('select')
      targetSel.className = 'datanoa-select datanoa-cols-hl-target'
      for (const t of ['cell', 'row'] as const) {
        const opt = document.createElement('option')
        opt.value = t
        opt.textContent = t
        if (t === rule.target) opt.selected = true
        targetSel.appendChild(opt)
      }

      const toneSel = document.createElement('select')
      toneSel.className = 'datanoa-select datanoa-cols-hl-tone'
      for (const tone of HIGHLIGHT_TONES) {
        const opt = document.createElement('option')
        opt.value = tone
        opt.textContent = tone
        if (tone === rule.tone) opt.selected = true
        toneSel.appendChild(opt)
      }

      const delBtn = document.createElement('button')
      delBtn.type = 'button'
      delBtn.className = 'datanoa-btn datanoa-btn-sm'
      delBtn.textContent = '×'
      delBtn.title = 'Delete rule'

      const commitRuleEdit = (): void => {
        const nextRules = (dataGrid.getHighlightRules?.() ?? []).map((r, rIdx): ConditionalHighlightRule => {
          if (rIdx !== idx) return r
          const opVal = opSel.value as ConditionalHighlightOperator
          const targetVal = targetSel.value === 'row' ? 'row' : 'cell'
          const toneVal = toneSel.value as ConditionalHighlightTone
          return {
            ...r,
            column: colSel.value,
            operator: opVal,
            value: valInp.value,
            target: targetVal,
            tone: toneVal,
          }
        })
        dataGrid.setHighlightRules?.(nextRules)
      }

      colSel.addEventListener('change', commitRuleEdit)
      opSel.addEventListener('change', commitRuleEdit)
      valInp.addEventListener('change', commitRuleEdit)
      targetSel.addEventListener('change', commitRuleEdit)
      toneSel.addEventListener('change', commitRuleEdit)
      delBtn.addEventListener('click', () => {
        const nextRules = (dataGrid.getHighlightRules?.() ?? []).filter((_, rIdx) => rIdx !== idx)
        dataGrid.setHighlightRules?.(nextRules)
        renderHighlightRules()
      })

      item.appendChild(colSel)
      item.appendChild(opSel)
      item.appendChild(valInp)
      item.appendChild(targetSel)
      item.appendChild(toneSel)
      item.appendChild(delBtn)
      hlListEl.appendChild(item)
    }
  }

  hlAddBtn.addEventListener('click', () => {
    const cols = dataGrid.getColumnConfig().allColumns
    const firstCol = cols[0] ?? ''
    if (!firstCol) return
    const nextRules = [
      ...(dataGrid.getHighlightRules?.() ?? []),
      {
        id: `hl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        enabled: true,
        column: firstCol,
        operator: 'eq' as const,
        value: '',
        target: 'cell' as const,
        tone: 'info' as const,
      },
    ]
    dataGrid.setHighlightRules?.(nextRules)
    renderHighlightRules()
  })

  hlSection.appendChild(hlHeader)
  hlSection.appendChild(hlListEl)

  searchInp.addEventListener('input', () => renderList(true))
  showAllBtn.addEventListener('click', () => {
    dataGrid.showAllColumns()
    renderList()
  })

  const syncState = (): void => {
    renderList()
    const nextWrap = dataGrid.getWrapCellsConfig?.() ?? { wrapCells: false, wrapMaxLines: 4 }
    wrapCb.checked = nextWrap.wrapCells
    maxLinesInp.value = String(nextWrap.wrapMaxLines)
    const nextRules = dataGrid.getHighlightRules?.() ?? []
    if (!areHighlightRulesEqual(lastRenderedHlRules, nextRules)) {
      renderHighlightRules()
    }
  }

  renderList(true)
  renderHighlightRules()
  pop.appendChild(head)
  pop.appendChild(listEl)
  pop.appendChild(wrapSection)
  pop.appendChild(hlSection)
  document.body.appendChild(pop)
  anchorBtn.classList.add('active')

  if (typeof anchorBtn.getBoundingClientRect === 'function') {
    const rect = anchorBtn.getBoundingClientRect()
    const vw = typeof window !== 'undefined' ? window.innerWidth || 1024 : 1024
    const vh = typeof window !== 'undefined' ? window.innerHeight || 768 : 768
    const popRect = pop.getBoundingClientRect?.()
    const popWidth = Math.max(300, Math.round(popRect?.width || 300))
    const naturalH = Math.min(440, Math.round(popRect?.height || 360))
    const spaceBelow = Math.max(0, vh - rect.bottom - 12)
    const spaceAbove = Math.max(0, rect.top - 12)
    const openUpward = spaceBelow < naturalH && spaceAbove > spaceBelow
    const clampedMaxH = Math.max(140, Math.min(440, openUpward ? spaceAbove : spaceBelow))
    pop.style.maxHeight = `${clampedMaxH}px`
    const renderedH = Math.min(naturalH, clampedMaxH)
    const top = openUpward
      ? Math.max(8, Math.round(rect.top - renderedH - 4))
      : Math.max(8, Math.min(Math.round(rect.bottom + 4), vh - renderedH - 8))
    const left = Math.max(8, Math.min(Math.round(rect.left), vw - popWidth - 8))
    pop.style.top = `${top}px`
    pop.style.left = `${left}px`
  }

  let outsideCleanup: (() => void) | null = null
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    const onDocDown = (ev: MouseEvent): void => {
      const target = ev.target instanceof Node ? ev.target : null
      if (target && (anchorBtn.contains?.(target) || pop.contains?.(target))) return
      onClose()
    }
    window.addEventListener('mousedown', onDocDown, true)
    outsideCleanup = () => {
      window.removeEventListener('mousedown', onDocDown, true)
    }
  }

  searchInp.focus?.()
  return { popoverEl: pop, outsideCleanup, syncState }
}
