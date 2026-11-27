// src/shared-collapsible-select.js
// Shared searchable, collapsible-folder custom dropdown controller for Studio and Side Panel.

const VALID_BADGE_TONES = new Set(['neutral', 'dev', 'staging', 'prod', 'info', 'warn'])

function parseOptionBadges(raw) {
  if (typeof raw !== 'string') return []
  const trimmed = raw.trim()
  if (!trimmed) return []
  try {
    const parsed = JSON.parse(trimmed)
    if (!Array.isArray(parsed)) return []
    const out = []
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue
      const text = typeof entry.text === 'string' ? entry.text.trim() : ''
      if (!text) continue
      const tone =
        typeof entry.tone === 'string' && VALID_BADGE_TONES.has(entry.tone)
          ? entry.tone
          : 'neutral'
      out.push({ text, tone })
    }
    return out
  } catch {
    return []
  }
}

function parseOptionElements(optionList) {
  return Array.from(optionList).map((opt) => {
    const rawLabel = (opt.textContent || '').trim()
    const displayName = (opt.dataset?.displayName || '').trim() || rawLabel
    const badges = parseOptionBadges(opt.dataset?.badges)
    const searchText = (opt.dataset?.searchText || '').trim()
    return {
      value: opt.value,
      label: displayName,
      rawLabel,
      badges,
      searchText,
      driver: opt.dataset?.driver || '',
      subtitle: opt.dataset?.subtitle || '',
      fullTitle: opt.dataset?.fullTitle || rawLabel || displayName,
      isCurrent: opt.dataset?.isCurrent === '1',
      disabled: Boolean(opt.disabled),
    }
  })
}

function extractSelectModel(selectEl) {
  const topItems = []
  const groups = []
  for (const child of Array.from(selectEl.children || [])) {
    if (child.tagName === 'OPTGROUP') {
      const folderName = (child.getAttribute('label') || 'Folder').trim() || 'Folder'
      const hasFolderKey = typeof child.dataset?.folderKey === 'string'
      const folderKey = hasFolderKey ? child.dataset.folderKey.trim() : folderName
      const folderOrderKey =
        typeof child.dataset?.folderOrderKey === 'string' &&
        child.dataset.folderOrderKey.trim().length > 0
          ? child.dataset.folderOrderKey.trim()
          : folderKey
      const rawCollapseKey =
        typeof child.dataset?.sectionKey === 'string' && child.dataset.sectionKey.trim().length > 0
          ? child.dataset.sectionKey.trim()
          : typeof child.dataset?.groupKey === 'string' && child.dataset.groupKey.trim().length > 0
            ? child.dataset.groupKey.trim()
            : ''
      const collapseKey = rawCollapseKey || folderName
      const reorderableFolder = child.dataset?.reorderableFolder === '1'
      const reorderableItems = child.dataset?.reorderableItems === '1'
      const items = parseOptionElements(child.querySelectorAll('option'))
      if (items.length > 0) {
        groups.push({
          folderName,
          folderKey,
          folderOrderKey,
          collapseKey,
          hasExplicitCollapseKey: rawCollapseKey.length > 0,
          reorderableFolder,
          reorderableItems,
          items,
        })
      }
    } else if (child.tagName === 'OPTION') {
      topItems.push(...parseOptionElements([child]))
    }
  }
  return { topItems, groups }
}

function itemMatchesQuery(item, q) {
  if (!q) return true
  if (item.label.toLowerCase().includes(q)) return true
  if (item.rawLabel && item.rawLabel.toLowerCase().includes(q)) return true
  if (item.fullTitle && item.fullTitle.toLowerCase().includes(q)) return true
  if (item.subtitle && item.subtitle.toLowerCase().includes(q)) return true
  if (item.searchText && item.searchText.toLowerCase().includes(q)) return true
  if (item.badges.some((b) => b.text.toLowerCase().includes(q))) return true
  return false
}

function createBadgePill(badge, badgeCls) {
  const pill = document.createElement('span')
  pill.className = `${badgeCls} is-${badge.tone}`
  if (pill.dataset) pill.dataset.tone = badge.tone
  pill.textContent = badge.text
  return pill
}

function createDragGripSvg() {
  const make = (tag, attrs) => {
    const el =
      typeof document.createElementNS === 'function'
        ? document.createElementNS('http://www.w3.org/2000/svg', tag)
        : document.createElement(tag)
    for (const [k, v] of Object.entries(attrs)) {
      el.setAttribute(k, v)
    }
    return el
  }
  const svg = make('svg', {
    width: '10',
    height: '12',
    viewBox: '0 0 10 12',
    fill: 'currentColor',
    'aria-hidden': 'true',
  })
  const dots = [
    ['3', '2'],
    ['7', '2'],
    ['3', '6'],
    ['7', '6'],
    ['3', '10'],
    ['7', '10'],
  ]
  for (const [cx, cy] of dots) {
    svg.appendChild(make('circle', { cx, cy, r: '1' }))
  }
  return svg
}

function computeOrderedListAfterDrop(orderedKeys, sourceKey, targetKey, placement) {
  if (!sourceKey || !targetKey || sourceKey === targetKey) {
    return { ok: false, changed: false, ordered: orderedKeys }
  }
  if (placement !== 'before' && placement !== 'after') {
    return { ok: false, changed: false, ordered: orderedKeys }
  }
  if (!orderedKeys.includes(sourceKey) || !orderedKeys.includes(targetKey)) {
    return { ok: false, changed: false, ordered: orderedKeys }
  }
  const withoutSource = orderedKeys.filter((k) => k !== sourceKey)
  const targetIdx = withoutSource.indexOf(targetKey)
  if (targetIdx < 0) {
    return { ok: false, changed: false, ordered: orderedKeys }
  }
  const insertIdx = placement === 'before' ? targetIdx : targetIdx + 1
  const ordered = withoutSource.slice()
  ordered.splice(insertIdx, 0, sourceKey)
  const changed = ordered.some((k, idx) => k !== orderedKeys[idx])
  return { ok: true, changed, ordered }
}

function resolveDropPlacement(el, clientY) {
  const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null
  const midpoint = rect ? rect.top + rect.height / 2 : 0
  return clientY < midpoint ? 'before' : 'after'
}

/**
 * Builds an isolated collapsible dropdown controller with parameterized styles, icon renderers,
 * layout bounds, and lifecycle hooks so Panel and Studio preserve distinct DOM/CSS contracts.
 */
export function createCollapsibleSelectController(adapter) {
  let activeClose = null
  let docClickHandler = null

  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    const triggerSel = `.${adapter.classes.trigger.split(/\s+/)[0]}`
    const popoverSel = `.${adapter.classes.popover.split(/\s+/)[0]}`
    docClickHandler = (e) => {
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
    }
    document.addEventListener('click', docClickHandler)
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

  function destroy() {
    closeActive()
    if (docClickHandler && typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
      document.removeEventListener('click', docClickHandler)
      docClickHandler = null
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
      selectEl[adapter.apiProp].refresh(options)
      return selectEl[adapter.apiProp]
    }
    if (adapter.mountedProp) {
      if (selectEl[adapter.mountedProp]) {
        selectEl[adapter.syncProp]?.(options)
        return null
      }
      selectEl[adapter.mountedProp] = true
    }

    let currentOptions = options || {}
    const c = adapter.classes
    const triggerBadgesCls = c.triggerBadges || 'custom-select-trigger-badges'
    const itemBadgesCls = c.itemBadges || 'custom-select-item-badges'
    const badgeCls = c.badge || 'cs-badge'
    const dragHandleCls = c.dragHandle || 'custom-select-drag-handle'
    const dragSpacerCls = c.dragSpacer || 'custom-select-drag-spacer'
    const tooltipPrefix = currentOptions.tooltipPrefix || selectEl.getAttribute?.('aria-label') || 'Select'
    const searchPlaceholder = currentOptions.searchPlaceholder || 'Search...'
    const collapsedFolders = currentOptions.collapsedFolders || new Set()
    const defaultCollapseNonActive = Boolean(currentOptions.defaultCollapseNonActiveFolders)
    const onFolderToggle = typeof currentOptions.onFolderToggle === 'function' ? currentOptions.onFolderToggle : null
    const leadingIconType = currentOptions.leadingIconType || 'none'

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

    const triggerBadgesSpan = document.createElement('span')
    triggerBadgesSpan.className = triggerBadgesCls

    const chevSpan = document.createElement('span')
    chevSpan.className = c.chev
    adapter.renderTriggerChevron(chevSpan)

    triggerBtn.append(leadIconSpan, labelSpan, chevSpan)
    selectEl.parentElement.insertBefore(triggerBtn, selectEl.nextSibling)

    let popoverEl = null
    let refreshOpenPopover = null
    let searchQuery = ''
    let initializedDefaults = false
    let focusTimer = null
    let scrollCloseHandler = null
    let cleanupDragState = null

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
      const rawText = (selectedOpt?.textContent || '').trim()
      const displayText = (selectedOpt?.dataset?.displayName || '').trim() || rawText
      labelSpan.textContent = displayText || 'Select...'
      const fullDetail = (selectedOpt?.dataset?.fullTitle || rawText || displayText || 'None').trim()
      const activePrefix = currentOptions.tooltipPrefix || tooltipPrefix
      const fullTip = `${activePrefix}: ${fullDetail}`
      triggerBtn.title = fullTip
      selectEl.title = fullTip
      triggerBtn.disabled = Boolean(selectEl.disabled)
      adapter.syncLeadIcon(leadIconSpan, leadingIconType, selectedOpt)

      const showTriggerBadges = currentOptions.showTriggerBadges !== false
      const selectedBadges = showTriggerBadges ? parseOptionBadges(selectedOpt?.dataset?.badges) : []
      triggerBadgesSpan.textContent = ''
      if (selectedBadges.length > 0) {
        for (const badge of selectedBadges) {
          triggerBadgesSpan.appendChild(createBadgePill(badge, badgeCls))
        }
        if (triggerBadgesSpan.parentElement !== triggerBtn) {
          triggerBtn.insertBefore(triggerBadgesSpan, chevSpan)
        }
      } else if (triggerBadgesSpan.parentElement === triggerBtn) {
        triggerBadgesSpan.remove()
      }
    }

    const closePopover = () => {
      cleanupDragState?.()
      cleanupDragState = null
      refreshOpenPopover = null
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

      let model = extractSelectModel(selectEl)
      if (defaultCollapseNonActive && !initializedDefaults && model.groups.length > 1) {
        initializedDefaults = true
        const curVal = selectEl.value
        for (const grp of model.groups) {
          if (!grp.items.some((i) => i.value === curVal || i.isCurrent)) {
            collapsedFolders.add(grp.collapseKey)
          }
        }
      }

      popoverEl = document.createElement('div')
      popoverEl.className = c.popover
      popoverEl.setAttribute('role', 'listbox')

      const headerRow = document.createElement('div')
      headerRow.className = c.head

      const activePlaceholder = currentOptions.searchPlaceholder || searchPlaceholder
      const activeSearchAriaLabel =
        currentOptions.searchAriaLabel ||
        selectEl.dataset?.searchAriaLabel ||
        activePlaceholder ||
        'Search options'

      const searchInp = document.createElement('input')
      searchInp.type = 'search'
      searchInp.className = c.search
      searchInp.placeholder = activePlaceholder
      searchInp.setAttribute('aria-label', activeSearchAriaLabel)
      searchInp.value = searchQuery
      headerRow.appendChild(searchInp)

      let expandBtn = null
      let collapseBtn = null
      const notifyFolderToggle = () => {
        const cb =
          typeof currentOptions.onFolderToggle === 'function'
            ? currentOptions.onFolderToggle
            : onFolderToggle
        cb?.(collapsedFolders)
      }
      const syncGroupButtons = () => {
        if (model.groups.length > 0 && !expandBtn) {
          expandBtn = document.createElement('button')
          expandBtn.type = 'button'
          expandBtn.className = c.actionBtn
          expandBtn.title = adapter.expandTitle
          if (adapter.setActionAriaLabel) expandBtn.setAttribute('aria-label', adapter.expandTitle)
          adapter.renderExpandIcon(expandBtn)
          expandBtn.addEventListener('click', (e) => {
            e.stopPropagation()
            collapsedFolders.clear()
            notifyFolderToggle()
            renderList()
          })

          collapseBtn = document.createElement('button')
          collapseBtn.type = 'button'
          collapseBtn.className = c.actionBtn
          collapseBtn.title = adapter.collapseTitle
          if (adapter.setActionAriaLabel) collapseBtn.setAttribute('aria-label', adapter.collapseTitle)
          adapter.renderCollapseIcon(collapseBtn)
          collapseBtn.addEventListener('click', (e) => {
            e.stopPropagation()
            for (const g of model.groups) collapsedFolders.add(g.collapseKey)
            notifyFolderToggle()
            renderList()
          })
          headerRow.append(expandBtn, collapseBtn)
        } else if (model.groups.length === 0 && expandBtn) {
          expandBtn.remove()
          collapseBtn?.remove()
          expandBtn = null
          collapseBtn = null
        }
      }
      syncGroupButtons()

      const listBox = document.createElement('div')
      listBox.className = c.list
      popoverEl.append(headerRow, listBox)

      let activeDrag = null
      let dropIndicator = null
      let suppressClick = false
      let suppressClickTimer = null
      let pendingRefreshAfterDrag = false

      const clearSuppressClickTimer = () => {
        if (suppressClickTimer !== null) {
          clearTimeout(suppressClickTimer)
          suppressClickTimer = null
        }
      }

      const armSuppressClickReset = () => {
        clearSuppressClickTimer()
        suppressClickTimer = setTimeout(() => {
          suppressClickTimer = null
          suppressClick = false
        }, 0)
      }

      const consumeSuppressedClick = () => {
        if (!suppressClick) return false
        suppressClick = false
        clearSuppressClickTimer()
        return true
      }

      const clearDropIndicator = () => {
        if (!dropIndicator) return
        dropIndicator.el.classList?.remove('is-drop-before', 'is-drop-after')
        dropIndicator = null
      }

      const clearActiveDrag = () => {
        clearDropIndicator()
        if (activeDrag?.el) {
          activeDrag.el.classList?.remove('is-dragging')
        }
        activeDrag = null
      }

      const flushPendingRefreshAfterDrag = () => {
        if (!pendingRefreshAfterDrag || !popoverEl || activeDrag) return
        pendingRefreshAfterDrag = false
        refreshOpenPopover?.()
      }

      const setDropIndicator = (el, placement) => {
        if (dropIndicator && dropIndicator.el === el && dropIndicator.placement === placement) {
          return
        }
        clearDropIndicator()
        el.classList?.add(placement === 'before' ? 'is-drop-before' : 'is-drop-after')
        dropIndicator = { el, placement }
      }

      cleanupDragState = () => {
        clearActiveDrag()
        pendingRefreshAfterDrag = false
        suppressClick = false
        clearSuppressClickTimer()
      }

      const createOptionRow = (item, indented, dragCtx) => {
        const btn = document.createElement('button')
        btn.type = 'button'
        const isSelected = item.value === selectEl.value
        btn.className = `${c.item}${isSelected ? ' active' : ''}${indented ? ' is-indented' : ''}`
        btn.disabled = item.disabled
        btn.title = item.fullTitle || item.label
        if (btn.dataset) {
          btn.dataset.value = item.value
          btn.dataset.folderKey = dragCtx.folderKey
        }

        if (dragCtx.canDrag) {
          btn.draggable = true
          btn.setAttribute('draggable', 'true')
          const grip = document.createElement('span')
          grip.className = dragHandleCls
          grip.setAttribute('aria-hidden', 'true')
          grip.title = 'Drag to reorder within folder'
          grip.appendChild(createDragGripSvg())
          btn.appendChild(grip)
        } else if (dragCtx.showSpacer) {
          const spacer = document.createElement('span')
          spacer.className = dragSpacerCls
          spacer.setAttribute('aria-hidden', 'true')
          btn.appendChild(spacer)
        }

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

        if (item.badges.length > 0) {
          const badgesWrap = document.createElement('span')
          badgesWrap.className = itemBadgesCls
          for (const badge of item.badges) {
            badgesWrap.appendChild(createBadgePill(badge, badgeCls))
          }
          btn.appendChild(badgesWrap)
        }

        if (isSelected) {
          const chk = document.createElement('span')
          chk.className = c.itemCheck
          chk.textContent = '✓'
          btn.appendChild(chk)
        }

        btn.addEventListener('click', (e) => {
          e.stopPropagation()
          if (consumeSuppressedClick()) return
          selectValue(item.value)
        })

        if (dragCtx.dndEnabled) {
          if (dragCtx.canDrag) {
            btn.addEventListener('dragstart', (e) => {
              if (searchQuery.trim().length > 0) {
                e.preventDefault()
                return
              }
              clearActiveDrag()
              clearSuppressClickTimer()
              suppressClick = true
              activeDrag = {
                kind: 'connection',
                id: item.value,
                folderKey: dragCtx.folderKey,
                el: btn,
              }
              btn.classList.add('is-dragging')
              if (e.dataTransfer) {
                e.dataTransfer.effectAllowed = 'move'
                try {
                  e.dataTransfer.setData('application/x-datanoa-connection-id', item.value)
                  e.dataTransfer.setData('text/plain', item.value)
                } catch {
                  // Ignore synthetic DataTransfer restrictions
                }
              }
            })

            btn.addEventListener('dragend', () => {
              clearActiveDrag()
              armSuppressClickReset()
              flushPendingRefreshAfterDrag()
            })
          }

          btn.addEventListener('dragover', (e) => {
            if (!activeDrag || searchQuery.trim().length > 0) return
            if (
              activeDrag.kind !== 'connection' ||
              !dragCtx.canDrag ||
              activeDrag.folderKey !== dragCtx.folderKey ||
              activeDrag.id === item.value
            ) {
              if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'
              clearDropIndicator()
              return
            }
            const placement = resolveDropPlacement(btn, e.clientY)
            const plan = computeOrderedListAfterDrop(
              dragCtx.siblingIds,
              activeDrag.id,
              item.value,
              placement
            )
            if (!plan.ok || !plan.changed) {
              if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'
              clearDropIndicator()
              return
            }
            e.preventDefault()
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
            setDropIndicator(btn, placement)
          })

          btn.addEventListener('dragleave', (e) => {
            if (
              e.relatedTarget &&
              typeof btn.contains === 'function' &&
              btn.contains(e.relatedTarget)
            ) {
              return
            }
            if (dropIndicator?.el === btn) {
              clearDropIndicator()
            }
          })

          btn.addEventListener('drop', (e) => {
            if (!activeDrag || searchQuery.trim().length > 0) return
            if (
              activeDrag.kind !== 'connection' ||
              !dragCtx.canDrag ||
              activeDrag.folderKey !== dragCtx.folderKey
            ) {
              clearDropIndicator()
              return
            }
            const sourceId = activeDrag.id
            const placement = resolveDropPlacement(btn, e.clientY)
            const plan = computeOrderedListAfterDrop(
              dragCtx.siblingIds,
              sourceId,
              item.value,
              placement
            )
            clearActiveDrag()
            armSuppressClickReset()
            if (!plan.ok || !plan.changed) {
              flushPendingRefreshAfterDrag()
              return
            }
            e.preventDefault()
            e.stopPropagation()
            if (typeof currentOptions.onReorderConnections === 'function') {
              void currentOptions.onReorderConnections(dragCtx.folderKey, plan.ordered)
            }
            flushPendingRefreshAfterDrag()
          })
        }

        return btn
      }

      function renderList() {
        clearActiveDrag()
        listBox.textContent = ''
        const q = searchQuery.trim().toLowerCase()
        const isSearching = q.length > 0
        const allowConnReorder =
          !isSearching &&
          Boolean(currentOptions.reorderConnections) &&
          typeof currentOptions.onReorderConnections === 'function'
        const allowFolderReorder =
          !isSearching &&
          Boolean(currentOptions.reorderFolders) &&
          typeof currentOptions.onReorderFolders === 'function'
        const dndEnabled = allowConnReorder || allowFolderReorder

        const reorderableTopIds = allowConnReorder
          ? model.topItems.filter((i) => i.value !== '' && !i.disabled).map((i) => i.value)
          : []
        const canReorderTopItems = reorderableTopIds.length > 1

        const reorderableFolderKeys = allowFolderReorder
          ? model.groups
              .filter((g) => g.reorderableFolder && g.folderOrderKey.length > 0)
              .map((g) => g.folderOrderKey)
          : []
        const canReorderFolders = reorderableFolderKeys.length > 1

        const hasAnyDraggableConnection =
          canReorderTopItems ||
          (allowConnReorder &&
            model.groups.some(
              (g) =>
                g.reorderableItems &&
                g.items.filter((i) => i.value !== '' && !i.disabled).length > 1
            ))

        let matchCount = 0

        for (const item of model.topItems) {
          if (!itemMatchesQuery(item, q)) continue
          matchCount++
          const canDrag = canReorderTopItems && item.value !== '' && !item.disabled
          const showSpacer = !canDrag && hasAnyDraggableConnection && item.value !== ''
          listBox.appendChild(
            createOptionRow(item, false, {
              dndEnabled,
              canDrag,
              showSpacer,
              folderKey: '',
              siblingIds: canDrag ? reorderableTopIds : [],
            })
          )
        }

        for (const grp of model.groups) {
          const folderMatches = !q || grp.folderName.toLowerCase().includes(q)
          const matchingItems = grp.items.filter((i) => folderMatches || itemMatchesQuery(i, q))
          if (matchingItems.length === 0) continue
          matchCount += matchingItems.length

          const isCollapsed = !q && collapsedFolders.has(grp.collapseKey)
          const canDragFolder =
            canReorderFolders && grp.reorderableFolder && grp.folderOrderKey.length > 0
          const grpHead = document.createElement('button')
          grpHead.type = 'button'
          grpHead.className = `${c.folderHead}${isCollapsed ? ' is-collapsed' : ''}`
          grpHead.title = `${isCollapsed ? 'Expand' : 'Collapse'} folder "${grp.folderName}" (${matchingItems.length})`
          if (grpHead.dataset) {
            grpHead.dataset.folderKey = grp.folderKey
            grpHead.dataset.folderOrderKey = grp.folderOrderKey
            grpHead.dataset.folderName = grp.folderName
            if (grp.hasExplicitCollapseKey) {
              grpHead.dataset.sectionKey = grp.collapseKey
            }
          }

          if (canDragFolder) {
            grpHead.draggable = true
            grpHead.setAttribute('draggable', 'true')
            const grip = document.createElement('span')
            grip.className = dragHandleCls
            grip.setAttribute('aria-hidden', 'true')
            grip.title = 'Drag to reorder folder'
            grip.appendChild(createDragGripSvg())
            grpHead.appendChild(grip)
          } else if (canReorderFolders) {
            const spacer = document.createElement('span')
            spacer.className = dragSpacerCls
            spacer.setAttribute('aria-hidden', 'true')
            grpHead.appendChild(spacer)
          }

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
            if (consumeSuppressedClick()) return
            if (collapsedFolders.has(grp.collapseKey)) collapsedFolders.delete(grp.collapseKey)
            else collapsedFolders.add(grp.collapseKey)
            notifyFolderToggle()
            renderList()
          })

          if (dndEnabled) {
            if (canDragFolder) {
              grpHead.addEventListener('dragstart', (e) => {
                if (searchQuery.trim().length > 0) {
                  e.preventDefault()
                  return
                }
                clearActiveDrag()
                clearSuppressClickTimer()
                suppressClick = true
                activeDrag = {
                  kind: 'folder',
                  folderKey: grp.folderOrderKey,
                  el: grpHead,
                }
                grpHead.classList.add('is-dragging')
                if (e.dataTransfer) {
                  e.dataTransfer.effectAllowed = 'move'
                  try {
                    e.dataTransfer.setData('application/x-datanoa-folder-name', grp.folderOrderKey)
                    e.dataTransfer.setData('text/plain', grp.folderOrderKey)
                  } catch {
                    // Ignore synthetic DataTransfer restrictions
                  }
                }
              })

              grpHead.addEventListener('dragend', () => {
                clearActiveDrag()
                armSuppressClickReset()
                flushPendingRefreshAfterDrag()
              })
            }

            grpHead.addEventListener('dragover', (e) => {
              if (!activeDrag || searchQuery.trim().length > 0) return
              if (
                activeDrag.kind !== 'folder' ||
                !canDragFolder ||
                activeDrag.folderKey === grp.folderOrderKey
              ) {
                if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'
                clearDropIndicator()
                return
              }
              const placement = resolveDropPlacement(grpHead, e.clientY)
              const plan = computeOrderedListAfterDrop(
                reorderableFolderKeys,
                activeDrag.folderKey,
                grp.folderOrderKey,
                placement
              )
              if (!plan.ok || !plan.changed) {
                if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'
                clearDropIndicator()
                return
              }
              e.preventDefault()
              if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
              setDropIndicator(grpHead, placement)
            })

            grpHead.addEventListener('dragleave', (e) => {
              if (
                e.relatedTarget &&
                typeof grpHead.contains === 'function' &&
                grpHead.contains(e.relatedTarget)
              ) {
                return
              }
              if (dropIndicator?.el === grpHead) {
                clearDropIndicator()
              }
            })

            grpHead.addEventListener('drop', (e) => {
              if (!activeDrag || searchQuery.trim().length > 0) return
              if (activeDrag.kind !== 'folder' || !canDragFolder) {
                clearDropIndicator()
                return
              }
              const sourceFolder = activeDrag.folderKey
              const placement = resolveDropPlacement(grpHead, e.clientY)
              const plan = computeOrderedListAfterDrop(
                reorderableFolderKeys,
                sourceFolder,
                grp.folderOrderKey,
                placement
              )
              clearActiveDrag()
              armSuppressClickReset()
              if (!plan.ok || !plan.changed) {
                flushPendingRefreshAfterDrag()
                return
              }
              e.preventDefault()
              e.stopPropagation()
              if (typeof currentOptions.onReorderFolders === 'function') {
                void currentOptions.onReorderFolders(plan.ordered)
              }
              flushPendingRefreshAfterDrag()
            })
          }

          listBox.appendChild(grpHead)

          if (!isCollapsed) {
            const grpReorderIds =
              allowConnReorder && grp.reorderableItems
                ? grp.items.filter((i) => i.value !== '' && !i.disabled).map((i) => i.value)
                : []
            const grpCanReorderItems = grpReorderIds.length > 1
            for (const item of matchingItems) {
              const canDrag = grpCanReorderItems && item.value !== '' && !item.disabled
              const showSpacer = !canDrag && hasAnyDraggableConnection && item.value !== ''
              listBox.appendChild(
                createOptionRow(item, true, {
                  dndEnabled,
                  canDrag,
                  showSpacer,
                  folderKey: grp.folderKey,
                  siblingIds: canDrag ? grpReorderIds : [],
                })
              )
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
        clearActiveDrag()
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
      refreshOpenPopover = () => {
        if (activeDrag) {
          pendingRefreshAfterDrag = true
          return
        }
        pendingRefreshAfterDrag = false
        const prevScroll = listBox.scrollTop || 0
        model = extractSelectModel(selectEl)
        syncGroupButtons()
        renderList()
        listBox.scrollTop = prevScroll
      }
      document.body.appendChild(popoverEl)
      triggerBtn.setAttribute('aria-expanded', 'true')

      const l = adapter.layout
      const optMinW = Number(currentOptions.popoverMinWidth)
      const optMaxH = Number(currentOptions.popoverMaxHeight)
      const effectiveMinWidth = Number.isFinite(optMinW) && optMinW > 0 ? optMinW : l.minWidth
      const effectiveMaxHeight = Number.isFinite(optMaxH) && optMaxH > 0 ? optMaxH : l.maxHeight
      const rect = triggerBtn.getBoundingClientRect?.() || l.rectFallback
      const vw = (typeof window !== 'undefined' ? window.innerWidth : 0) || l.vwFallback
      const vh = (typeof window !== 'undefined' ? window.innerHeight : 0) || l.vhFallback
      const maxViewportWidth = Math.max(160, vw - l.margin * 2)
      const desiredWidth = Math.max(rect.width || l.rectFallback.width, effectiveMinWidth)
      const width = Math.min(desiredWidth, maxViewportWidth)
      const left = Math.max(l.margin, Math.min(rect.left, vw - width - l.margin))
      popoverEl.style.width = `${width}px`
      popoverEl.style.left = `${left}px`

      const spaceBelow = Math.max(0, vh - rect.bottom - l.gap)
      const spaceAbove = Math.max(0, rect.top - l.gap)
      const maxViewportHeight = Math.max(80, vh - l.margin * 2)
      if (spaceBelow < 180 && spaceAbove > spaceBelow) {
        const maxH = Math.min(maxViewportHeight, Math.max(140, Math.min(effectiveMaxHeight, spaceAbove)))
        popoverEl.style.maxHeight = `${maxH}px`
        popoverEl.style.top = 'auto'
        popoverEl.style.bottom = `${Math.max(l.margin, Math.round(vh - rect.top + 4))}px`
      } else {
        const maxH = Math.min(maxViewportHeight, Math.max(140, Math.min(effectiveMaxHeight, spaceBelow)))
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
      if (typeof currentOptions?.onOpen === 'function') {
        currentOptions.onOpen()
      }
    }

    const onTriggerClick = (e) => {
      e.stopPropagation()
      openPopover()
    }
    const onSelectChange = () => {
      syncTriggerDisplay()
    }
    triggerBtn.addEventListener('click', onTriggerClick)
    selectEl.addEventListener('change', onSelectChange)

    const syncAll = (nextOpts) => {
      if (nextOpts && typeof nextOpts === 'object') {
        currentOptions = { ...currentOptions, ...nextOpts }
      }
      syncTriggerDisplay()
      if (popoverEl && selectEl.disabled) {
        closePopover()
        return
      }
      if (popoverEl && !adapter.closeOnRefresh && refreshOpenPopover) {
        refreshOpenPopover()
      }
    }

    selectEl[adapter.syncProp] = syncAll
    const api = {
      refresh: (nextOpts) => {
        syncAll(nextOpts)
        if (adapter.closeOnRefresh && popoverEl) {
          closePopover()
        }
      },
      close: closePopover,
      destroy: () => {
        closePopover()
        triggerBtn.removeEventListener('click', onTriggerClick)
        selectEl.removeEventListener('change', onSelectChange)
        triggerBtn.remove()
        selectEl.classList.remove(c.srOnly)
        if (adapter.apiProp && selectEl[adapter.apiProp] === api) {
          delete selectEl[adapter.apiProp]
        }
        if (adapter.mountedProp) {
          delete selectEl[adapter.mountedProp]
        }
        if (selectEl[adapter.syncProp] === syncAll) {
          delete selectEl[adapter.syncProp]
        }
      },
      triggerBtn,
    }
    if (adapter.apiProp) {
      selectEl[adapter.apiProp] = api
    }
    syncTriggerDisplay()
    return api
  }

  return { enhance, isOpen, closeActive, destroy }
}
