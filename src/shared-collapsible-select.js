// src/shared-collapsible-select.js
// Shared searchable, collapsible-folder custom dropdown controller for Studio and Side Panel.

function parseOptionElements(optionList) {
  return Array.from(optionList).map((opt) => ({
    value: opt.value,
    label: (opt.textContent || '').trim(),
    driver: opt.dataset?.driver || '',
    subtitle: opt.dataset?.subtitle || '',
    fullTitle: opt.dataset?.fullTitle || (opt.textContent || '').trim(),
    isCurrent: opt.dataset?.isCurrent === '1',
    disabled: Boolean(opt.disabled),
  }))
}

function extractSelectModel(selectEl) {
  const topItems = []
  const groups = []
  for (const child of Array.from(selectEl.children || [])) {
    if (child.tagName === 'OPTGROUP') {
      const folderName = (child.getAttribute('label') || 'Folder').trim() || 'Folder'
      const items = parseOptionElements(child.querySelectorAll('option'))
      if (items.length > 0) groups.push({ folderName, items })
    } else if (child.tagName === 'OPTION') {
      topItems.push(...parseOptionElements([child]))
    }
  }
  return { topItems, groups }
}

/**
 * Builds an isolated collapsible dropdown controller with parameterized styles, icon renderers,
 * layout bounds, and lifecycle hooks so Panel and Studio preserve distinct DOM/CSS contracts.
 */
export function createCollapsibleSelectController(adapter) {
  let activeClose = null

  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    const triggerSel = `.${adapter.classes.trigger.split(/\s+/)[0]}`
    const popoverSel = `.${adapter.classes.popover.split(/\s+/)[0]}`
    document.addEventListener('click', (e) => {
      if (!activeClose) return
      const tgt = e.target
      if (
        tgt instanceof Element &&
        typeof tgt.closest === 'function' &&
        (tgt.closest(popoverSel) || tgt.closest(triggerSel))
      ) {
        return
      }
      activeClose()
      activeClose = null
    })
  }

  function isOpen() {
    return typeof activeClose === 'function'
  }

  function closeActive() {
    if (typeof activeClose === 'function') {
      activeClose()
      activeClose = null
    }
  }

  function enhance(selectEl, options = {}) {
    adapter.beforeEnhance?.(selectEl, options)

    if (
      !selectEl ||
      typeof document === 'undefined' ||
      !selectEl.parentElement ||
      typeof selectEl.parentElement.insertBefore !== 'function' ||
      typeof selectEl.querySelectorAll !== 'function'
    ) {
      return null
    }

    if (adapter.apiProp && selectEl[adapter.apiProp]) {
      selectEl[adapter.apiProp].refresh()
      return selectEl[adapter.apiProp]
    }
    if (adapter.mountedProp) {
      if (selectEl[adapter.mountedProp]) {
        selectEl[adapter.syncProp]?.()
        return null
      }
      selectEl[adapter.mountedProp] = true
    }

    const c = adapter.classes
    const tooltipPrefix = options?.tooltipPrefix || selectEl.getAttribute?.('aria-label') || 'Select'
    const searchPlaceholder = options?.searchPlaceholder || 'Search...'
    const collapsedFolders = options?.collapsedFolders || new Set()
    const defaultCollapseNonActive = Boolean(options?.defaultCollapseNonActiveFolders)
    const onFolderToggle = typeof options?.onFolderToggle === 'function' ? options.onFolderToggle : null
    const leadingIconType = options?.leadingIconType || 'none'

    selectEl.classList.add(c.srOnly)
    const triggerBtn = document.createElement('button')
    triggerBtn.type = 'button'
    triggerBtn.className = c.trigger
    triggerBtn.setAttribute('aria-haspopup', 'listbox')
    triggerBtn.setAttribute('aria-expanded', 'false')

    const leadIconSpan = document.createElement('span')
    leadIconSpan.className = c.leadIcon
    adapter.setLeadIconVisible(leadIconSpan, leadingIconType !== 'none')

    const labelSpan = document.createElement('span')
    labelSpan.className = c.label

    const chevSpan = document.createElement('span')
    chevSpan.className = c.chev
    adapter.renderTriggerChevron(chevSpan)

    triggerBtn.append(leadIconSpan, labelSpan, chevSpan)
    selectEl.parentElement.insertBefore(triggerBtn, selectEl.nextSibling)

    let popoverEl = null
    let searchQuery = ''
    let initializedDefaults = false
    let focusTimer = null
    let scrollCloseHandler = null

    const getSelectedOption = () => {
      const opts = selectEl.options
      if (opts && typeof selectEl.selectedIndex === 'number' && selectEl.selectedIndex >= 0) {
        return opts[selectEl.selectedIndex] ?? null
      }
      if (adapter.fallbackQuerySelected) {
        return Array.from(selectEl.querySelectorAll('option')).find((o) => o.value === selectEl.value) || null
      }
      return null
    }

    const syncTriggerDisplay = () => {
      const selectedOpt = getSelectedOption()
      const cleanText = (selectedOpt?.textContent || '').trim()
      labelSpan.textContent = cleanText || 'Select...'
      const fullDetail = (selectedOpt?.dataset?.fullTitle || cleanText || 'None').trim()
      const fullTip = `${tooltipPrefix}: ${fullDetail}`
      triggerBtn.title = fullTip
      selectEl.title = fullTip
      triggerBtn.disabled = Boolean(selectEl.disabled)
      adapter.syncLeadIcon(leadIconSpan, leadingIconType, selectedOpt)
    }

    const closePopover = () => {
      if (focusTimer !== null) {
        clearTimeout(focusTimer)
        focusTimer = null
      }
      if (scrollCloseHandler && typeof document !== 'undefined') {
        document.removeEventListener('scroll', scrollCloseHandler, true)
        scrollCloseHandler = null
      }
      if (popoverEl) {
        popoverEl.remove()
        popoverEl = null
      }
      triggerBtn.setAttribute('aria-expanded', 'false')
      if (activeClose === closePopover) {
        activeClose = null
      }
    }

    const selectValue = (val) => {
      if (selectEl.value !== val) {
        selectEl.value = val
        selectEl.dispatchEvent(new Event('change', { bubbles: true }))
      }
      syncTriggerDisplay()
      closePopover()
    }

    const openPopover = () => {
      if (selectEl.disabled) return
      if (popoverEl) {
        closePopover()
        return
      }
      closeActive()
      activeClose = closePopover
      searchQuery = ''

      const model = extractSelectModel(selectEl)
      if (defaultCollapseNonActive && !initializedDefaults && model.groups.length > 1) {
        initializedDefaults = true
        const curVal = selectEl.value
        for (const grp of model.groups) {
          if (!grp.items.some((i) => i.value === curVal || i.isCurrent)) {
            collapsedFolders.add(grp.folderName)
          }
        }
      }

      popoverEl = document.createElement('div')
      popoverEl.className = c.popover
      popoverEl.setAttribute('role', 'listbox')

      const headerRow = document.createElement('div')
      headerRow.className = c.head

      const searchInp = document.createElement('input')
      searchInp.type = 'search'
      searchInp.className = c.search
      searchInp.placeholder = searchPlaceholder
      searchInp.value = searchQuery
      headerRow.appendChild(searchInp)

      if (model.groups.length > 0) {
        const expandBtn = document.createElement('button')
        expandBtn.type = 'button'
        expandBtn.className = c.actionBtn
        expandBtn.title = adapter.expandTitle
        if (adapter.setActionAriaLabel) expandBtn.setAttribute('aria-label', adapter.expandTitle)
        adapter.renderExpandIcon(expandBtn)
        expandBtn.addEventListener('click', (e) => {
          e.stopPropagation()
          collapsedFolders.clear()
          onFolderToggle?.(collapsedFolders)
          renderList()
        })

        const collapseBtn = document.createElement('button')
        collapseBtn.type = 'button'
        collapseBtn.className = c.actionBtn
        collapseBtn.title = adapter.collapseTitle
        if (adapter.setActionAriaLabel) collapseBtn.setAttribute('aria-label', adapter.collapseTitle)
        adapter.renderCollapseIcon(collapseBtn)
        collapseBtn.addEventListener('click', (e) => {
          e.stopPropagation()
          for (const g of model.groups) collapsedFolders.add(g.folderName)
          onFolderToggle?.(collapsedFolders)
          renderList()
        })
        headerRow.append(expandBtn, collapseBtn)
      }

      const listBox = document.createElement('div')
      listBox.className = c.list
      popoverEl.append(headerRow, listBox)

      const createOptionRow = (item, indented) => {
        const btn = document.createElement('button')
        btn.type = 'button'
        const isSelected = item.value === selectEl.value
        btn.className = `${c.item}${isSelected ? ' active' : ''}${indented ? ' is-indented' : ''}`
        btn.disabled = item.disabled
        btn.title = item.fullTitle || item.label

        if (item.driver || leadingIconType === 'workspace') {
          const ico = document.createElement('span')
          ico.className = c.itemIcon
          adapter.renderItemIcon(ico, item.driver, leadingIconType)
          btn.appendChild(ico)
        }

        const txtWrap = document.createElement('div')
        txtWrap.className = c.itemText
        const mainLbl = document.createElement('span')
        mainLbl.className = c.itemLabel
        mainLbl.textContent = item.label
        txtWrap.appendChild(mainLbl)
        if (item.subtitle) {
          const subLbl = document.createElement('span')
          subLbl.className = c.itemSub
          subLbl.textContent = item.subtitle
          txtWrap.appendChild(subLbl)
        }
        btn.appendChild(txtWrap)

        if (isSelected) {
          const chk = document.createElement('span')
          chk.className = c.itemCheck
          chk.textContent = '✓'
          btn.appendChild(chk)
        }

        btn.addEventListener('click', (e) => {
          e.stopPropagation()
          selectValue(item.value)
        })
        return btn
      }

      function renderList() {
        listBox.textContent = ''
        const q = searchQuery.trim().toLowerCase()
        let matchCount = 0

        for (const item of model.topItems) {
          const matches =
            !q ||
            item.label.toLowerCase().includes(q) ||
            (item.fullTitle && item.fullTitle.toLowerCase().includes(q))
          if (!matches) continue
          matchCount++
          listBox.appendChild(createOptionRow(item, false))
        }

        for (const grp of model.groups) {
          const folderMatches = !q || grp.folderName.toLowerCase().includes(q)
          const matchingItems = grp.items.filter(
            (i) =>
              !q ||
              folderMatches ||
              i.label.toLowerCase().includes(q) ||
              (i.fullTitle && i.fullTitle.toLowerCase().includes(q)) ||
              (i.subtitle && i.subtitle.toLowerCase().includes(q))
          )
          if (matchingItems.length === 0) continue
          matchCount += matchingItems.length

          const isCollapsed = !q && collapsedFolders.has(grp.folderName)
          const grpHead = document.createElement('button')
          grpHead.type = 'button'
          grpHead.className = `${c.folderHead}${isCollapsed ? ' is-collapsed' : ''}`
          grpHead.title = `${isCollapsed ? 'Expand' : 'Collapse'} folder "${grp.folderName}" (${matchingItems.length})`

          const chev = document.createElement('span')
          adapter.applyFolderChevron(chev, isCollapsed)

          const fIcon = document.createElement('span')
          fIcon.className = c.folderIcon
          adapter.renderFolderIcon(fIcon, !isCollapsed)

          const fName = document.createElement('span')
          fName.className = c.folderName
          fName.textContent = grp.folderName

          const fCount = document.createElement('span')
          fCount.className = c.folderCount
          fCount.textContent = String(matchingItems.length)

          grpHead.append(chev, fIcon, fName, fCount)
          grpHead.addEventListener('click', (e) => {
            e.stopPropagation()
            if (collapsedFolders.has(grp.folderName)) collapsedFolders.delete(grp.folderName)
            else collapsedFolders.add(grp.folderName)
            onFolderToggle?.(collapsedFolders)
            renderList()
          })
          listBox.appendChild(grpHead)

          if (!isCollapsed) {
            for (const item of matchingItems) {
              listBox.appendChild(createOptionRow(item, true))
            }
          }
        }

        if (matchCount === 0) {
          const emptyEl = document.createElement('div')
          emptyEl.className = c.empty
          emptyEl.textContent = q ? `No matches for "${searchQuery}"` : 'No options available'
          listBox.appendChild(emptyEl)
        }
      }

      searchInp.addEventListener('input', () => {
        searchQuery = searchInp.value
        renderList()
      })
      searchInp.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          closePopover()
          triggerBtn.focus()
        }
      })

      renderList()
      document.body.appendChild(popoverEl)
      triggerBtn.setAttribute('aria-expanded', 'true')

      const l = adapter.layout
      const rect = triggerBtn.getBoundingClientRect?.() || l.rectFallback
      const vw = (typeof window !== 'undefined' ? window.innerWidth : 0) || l.vwFallback
      const vh = (typeof window !== 'undefined' ? window.innerHeight : 0) || l.vhFallback
      const desiredWidth = Math.max(rect.width || l.rectFallback.width, l.minWidth)
      const width = Math.min(desiredWidth, vw - l.margin * 2)
      const left = Math.max(l.margin, Math.min(rect.left, vw - width - l.margin))
      popoverEl.style.width = `${width}px`
      popoverEl.style.left = `${left}px`

      const spaceBelow = vh - rect.bottom - l.gap
      const spaceAbove = rect.top - l.gap
      if (spaceBelow < 180 && spaceAbove > spaceBelow) {
        const maxH = Math.max(140, Math.min(l.maxHeight, spaceAbove))
        popoverEl.style.maxHeight = `${maxH}px`
        popoverEl.style.top = 'auto'
        popoverEl.style.bottom = `${Math.max(l.margin, Math.round(vh - rect.top + 4))}px`
      } else {
        const maxH = Math.max(140, Math.min(l.maxHeight, spaceBelow))
        popoverEl.style.maxHeight = `${maxH}px`
        popoverEl.style.bottom = 'auto'
        popoverEl.style.top = `${Math.round(rect.bottom + 4)}px`
      }

      scrollCloseHandler = (ev) => {
        if (!popoverEl) return
        const tgt = ev.target
        if (
          tgt &&
          (tgt === popoverEl ||
            (typeof Node !== 'undefined' && tgt instanceof Node && popoverEl.contains(tgt)))
        ) {
          return
        }
        closePopover()
      }
      if (typeof document !== 'undefined') {
        document.addEventListener('scroll', scrollCloseHandler, true)
      }

      focusTimer = setTimeout(() => {
        focusTimer = null
        if (popoverEl && (model.groups.length > 0 || model.topItems.length > 4)) {
          searchInp.focus?.()
        }
      }, 10)
    }

    triggerBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      openPopover()
    })
    selectEl.addEventListener('change', () => {
      syncTriggerDisplay()
    })

    selectEl[adapter.syncProp] = syncTriggerDisplay
    const api = {
      refresh: () => {
        syncTriggerDisplay()
        if (adapter.closeOnRefresh && popoverEl) {
          closePopover()
        }
      },
      close: closePopover,
      triggerBtn,
    }
    if (adapter.apiProp) {
      selectEl[adapter.apiProp] = api
    }
    syncTriggerDisplay()
    return api
  }

  return { enhance, isOpen, closeActive }
}
