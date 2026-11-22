// src/editor/studio-columns-popover.ts
// Floating column visibility and pinning popover for DatanoaStudioEditor

import type { VirtualDataGrid } from './grid.js'

export interface MountedColumnsPopover {
  popoverEl: HTMLDivElement
  outsideCleanup: (() => void) | null
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

  const renderList = (): void => {
    const cfg = dataGrid.getColumnConfig()
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

      row.appendChild(label)
      row.appendChild(pinBtn)
      listEl.appendChild(row)
    }
  }

  searchInp.addEventListener('input', renderList)
  showAllBtn.addEventListener('click', () => {
    dataGrid.showAllColumns()
    renderList()
  })

  renderList()
  pop.appendChild(head)
  pop.appendChild(listEl)
  document.body.appendChild(pop)
  anchorBtn.classList.add('active')

  if (typeof anchorBtn.getBoundingClientRect === 'function') {
    const rect = anchorBtn.getBoundingClientRect()
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
  return { popoverEl: pop, outsideCleanup }
}
