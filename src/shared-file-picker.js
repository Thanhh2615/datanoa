// src/shared-file-picker.js
// Shared in-app file and folder picker modal used by both Fullscreen Studio and Docked Side Panel.
// Zero OS shell calls: lists directories through the worker's pure node:fs `fs.listDir` handler.

const SVG_NS = 'http://www.w3.org/2000/svg'
const FOLDER_PATHS = [
  'M2 4.5A1.5 1.5 0 0 1 3.5 3h2.8l1.2 1.5h5A1.5 1.5 0 0 1 14 6v5.5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5z',
]
const FILE_PATHS = ['M4 2.5h5.2L12.5 5.8V13.5H4z', 'M9 2.5V6h3.5']
const UP_PATHS = ['M8 12.5V4', 'M4.5 7.5 8 4l3.5 3.5']
const FOCUSABLE_SELECTOR = 'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])'

export function formatPickerBytes(size) {
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`
  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export function compactPickerRootLabel(rootPath) {
  const raw = String(rootPath || '')
  const clean = raw.replace(/[\\/]+$/, '')
  if (!clean) return raw
  if (/^[A-Za-z]:$/.test(clean)) return `${clean}\\`
  const parts = clean.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || raw
}

function normalizeRootKey(rawPath) {
  const norm = String(rawPath || '').replace(/\\/g, '/').replace(/\/+$/, '')
  return (norm || '/').toLowerCase()
}

function createLineSvg(paths) {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.5')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, 'path')
    p.setAttribute('d', d)
    svg.appendChild(p)
  }
  return svg
}

function buildPickerShell(title, mode, cls) {
  const overlay = document.createElement('div')
  overlay.className = cls.overlay
  overlay.tabIndex = -1

  const modal = document.createElement('div')
  modal.className = cls.modal
  modal.setAttribute('role', 'dialog')
  modal.setAttribute('aria-modal', 'true')
  modal.setAttribute('aria-label', title)

  const head = document.createElement('div')
  head.className = cls.head
  const titleEl = document.createElement('span')
  titleEl.className = cls.title
  titleEl.textContent = title
  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = cls.btnSm
  closeBtn.textContent = 'Close'
  head.append(titleEl, closeBtn)

  const rootsBar = document.createElement('div')
  rootsBar.className = cls.roots

  const navRow = document.createElement('div')
  navRow.className = cls.nav
  const upBtn = document.createElement('button')
  upBtn.type = 'button'
  upBtn.className = cls.upBtn
  upBtn.title = 'Parent folder'
  upBtn.append(createLineSvg(UP_PATHS), Object.assign(document.createElement('span'), { textContent: 'Up' }))
  const pathInput = document.createElement('input')
  pathInput.type = 'text'
  pathInput.className = cls.pathInput
  pathInput.placeholder = 'Enter folder path'
  pathInput.setAttribute('aria-label', 'Current folder path')
  const goBtn = document.createElement('button')
  goBtn.type = 'button'
  goBtn.className = cls.btnSm
  goBtn.textContent = 'Go'
  navRow.append(upBtn, pathInput, goBtn)

  const filterInput = document.createElement('input')
  filterInput.type = 'text'
  filterInput.className = cls.filterInput
  filterInput.placeholder = mode === 'folder' ? 'Filter folders' : 'Filter files and folders'
  filterInput.setAttribute('aria-label', 'Filter entries')

  const listEl = document.createElement('div')
  listEl.className = cls.list
  listEl.setAttribute('role', 'listbox')

  const statusEl = document.createElement('div')
  statusEl.className = cls.status

  const foot = document.createElement('div')
  foot.className = cls.foot
  const previewEl = document.createElement('div')
  previewEl.className = cls.selected
  const actionsEl = document.createElement('div')
  actionsEl.className = cls.actions
  const cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.className = cls.btnSm
  cancelBtn.textContent = 'Cancel'
  const confirmBtn = document.createElement('button')
  confirmBtn.type = 'button'
  confirmBtn.className = cls.btnPrimarySm
  confirmBtn.textContent = mode === 'folder' ? 'Select folder' : 'Select file'
  actionsEl.append(cancelBtn, confirmBtn)
  foot.append(previewEl, actionsEl)

  if (cls.body) {
    const body = document.createElement('div')
    body.className = cls.body
    body.append(rootsBar, navRow, filterInput, listEl, statusEl)
    modal.append(head, body, foot)
  } else {
    modal.append(head, rootsBar, navRow, filterInput, listEl, statusEl, foot)
  }
  overlay.appendChild(modal)

  return {
    overlay,
    modal,
    closeBtn,
    rootsBar,
    upBtn,
    pathInput,
    goBtn,
    filterInput,
    listEl,
    statusEl,
    previewEl,
    cancelBtn,
    confirmBtn,
  }
}

export function openSharedFilePickerModal(config) {
  const mode = config.mode === 'folder' ? 'folder' : 'file'
  const title = config.title || (mode === 'folder' ? 'Select folder' : 'Select file')
  const extensions = Array.isArray(config.extensions) ? config.extensions : undefined
  const maxRoots = typeof config.maxRoots === 'number' ? config.maxRoots : 10
  const cls = config.classes

  return new Promise((resolve) => {
    const prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const dom = buildPickerShell(title, mode, cls)

    let closed = false
    let loadSeq = 0
    let currentDir = ''
    let parentDir = null
    let allEntries = []
    let visibleEntries = []
    let rowEls = []
    let selectedEntry = null

    const finish = (result) => {
      if (closed) return
      closed = true
      window.removeEventListener('keydown', onKeyDown, true)
      dom.overlay.remove()
      if (prevFocus && prevFocus.isConnected) prevFocus.focus()
      resolve(result)
    }

    const resolveChoice = () => {
      if (mode === 'folder') {
        return selectedEntry?.kind === 'dir' ? selectedEntry.path : currentDir
      }
      return selectedEntry?.kind === 'file' ? selectedEntry.path : ''
    }

    const syncConfirm = () => {
      const chosen = resolveChoice()
      dom.previewEl.textContent = chosen || (mode === 'file' ? 'Select a file to continue' : '')
      dom.previewEl.title = chosen || ''
      dom.confirmBtn.disabled = !chosen
    }

    // Update selection classes in place so double-click targets stay attached and focus is preserved
    const syncSelectionUi = () => {
      const selPath = selectedEntry?.path || ''
      for (let i = 0; i < rowEls.length; i++) {
        const isSel = visibleEntries[i]?.path === selPath
        rowEls[i].classList.toggle('is-selected', isSel)
        rowEls[i].setAttribute('aria-selected', isSel ? 'true' : 'false')
      }
      syncConfirm()
    }

    const renderEntries = () => {
      const q = dom.filterInput.value.trim().toLowerCase()
      visibleEntries = q
        ? allEntries.filter((e) => e.name.toLowerCase().includes(q))
        : allEntries
      if (selectedEntry && !visibleEntries.some((e) => e.path === selectedEntry.path)) {
        selectedEntry = null
      }
      dom.listEl.innerHTML = ''
      rowEls = []
      if (visibleEntries.length === 0) {
        const empty = document.createElement('div')
        empty.className = cls.empty
        empty.textContent = q
          ? 'No matching entries'
          : mode === 'folder'
            ? 'No subfolders in this directory'
            : 'No matching files in this directory'
        dom.listEl.appendChild(empty)
        syncConfirm()
        return
      }

      const frag = document.createDocumentFragment()
      for (const entry of visibleEntries) {
        const isSel = selectedEntry?.path === entry.path
        const row = document.createElement('button')
        row.type = 'button'
        row.className = `${cls.row}${isSel ? ' is-selected' : ''}`
        row.setAttribute('role', 'option')
        row.setAttribute('aria-selected', isSel ? 'true' : 'false')
        row.title = entry.path

        const iconBox = document.createElement('span')
        iconBox.className = cls.icon
        iconBox.appendChild(createLineSvg(entry.kind === 'dir' ? FOLDER_PATHS : FILE_PATHS))

        const nameEl = document.createElement('span')
        nameEl.className = cls.name
        nameEl.textContent = entry.name

        const metaEl = document.createElement('span')
        metaEl.className = cls.meta
        metaEl.textContent = entry.kind === 'dir' ? 'Folder' : formatPickerBytes(entry.size)

        row.append(iconBox, nameEl, metaEl)
        row.addEventListener('click', () => {
          selectedEntry = entry
          syncSelectionUi()
        })
        row.addEventListener('dblclick', () => {
          if (entry.kind === 'dir') void loadDir(entry.path, true)
          else if (mode === 'file') finish({ ok: true, path: entry.path })
        })
        rowEls.push(row)
        frag.appendChild(row)
      }
      dom.listEl.appendChild(frag)
      syncConfirm()
    }

    const renderRoots = (roots) => {
      dom.rootsBar.innerHTML = ''
      const curKey = normalizeRootKey(currentDir)
      for (const rootPath of (roots || []).slice(0, maxRoots)) {
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = `${cls.root}${normalizeRootKey(rootPath) === curKey ? ' is-active' : ''}`
        btn.textContent = compactPickerRootLabel(rootPath)
        btn.title = rootPath
        btn.addEventListener('click', () => void loadDir(rootPath, true))
        dom.rootsBar.appendChild(btn)
      }
    }

    const loadDir = async (dir, strictDir = false) => {
      const seq = ++loadSeq
      dom.statusEl.textContent = 'Loading...'
      dom.statusEl.className = cls.status
      selectedEntry = null
      syncConfirm()
      try {
        const res = await config.listDir({ dir, mode, extensions, strictDir })
        if (closed || seq !== loadSeq) return
        if (!res?.ok) {
          if (res?.currentDir && !currentDir) {
            currentDir = res.currentDir
            parentDir = res.parentDir ?? null
            dom.pathInput.value = currentDir
            dom.upBtn.disabled = !parentDir
          }
          if (Array.isArray(res?.roots) && dom.rootsBar.childElementCount === 0) {
            renderRoots(res.roots)
          }
          dom.statusEl.textContent = res?.error || 'Cannot open directory'
          dom.statusEl.className = `${cls.status} is-error`
          return
        }
        currentDir = res.currentDir || ''
        parentDir = res.parentDir ?? null
        dom.pathInput.value = currentDir
        dom.upBtn.disabled = !parentDir
        allEntries = Array.isArray(res.entries) ? res.entries : []
        renderRoots(res.roots)
        dom.filterInput.value = ''
        renderEntries()
        const countLabel = res.truncated
          ? `${allEntries.length}+ items (showing first ${allEntries.length})`
          : `${allEntries.length} item${allEntries.length === 1 ? '' : 's'}`
        dom.statusEl.textContent = countLabel
      } catch (err) {
        if (closed || seq !== loadSeq) return
        dom.statusEl.textContent = err instanceof Error ? err.message : String(err)
        dom.statusEl.className = `${cls.status} is-error`
      }
    }

    const moveSelection = (delta) => {
      if (visibleEntries.length === 0) return
      const curIdx = selectedEntry
        ? visibleEntries.findIndex((e) => e.path === selectedEntry.path)
        : -1
      const nextIdx =
        curIdx < 0
          ? delta > 0
            ? 0
            : visibleEntries.length - 1
          : Math.max(0, Math.min(visibleEntries.length - 1, curIdx + delta))
      selectedEntry = visibleEntries[nextIdx]
      syncSelectionUi()
      const activeRow = rowEls[nextIdx]
      if (activeRow) activeRow.scrollIntoView({ block: 'nearest' })
    }

    const trapTabFocus = (e) => {
      const focusables = Array.from(dom.modal.querySelectorAll(FOCUSABLE_SELECTOR)).filter(
        (el) => el instanceof HTMLElement && el.offsetParent !== null
      )
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement
      if (e.shiftKey && (active === first || !dom.modal.contains(active))) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (active === last || !dom.modal.contains(active))) {
        e.preventDefault()
        first.focus()
      }
    }

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()
        finish({ ok: false, cancelled: true })
        return
      }
      if (e.key === 'Tab') {
        trapTabFocus(e)
        return
      }
      const active = document.activeElement
      const inListContext =
        active === dom.filterInput || active === dom.overlay || dom.listEl.contains(active)
      if (!inListContext) return

      if (e.key === 'ArrowDown') {
        e.preventDefault()
        moveSelection(1)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        moveSelection(-1)
      } else if (e.key === 'Enter' && selectedEntry) {
        e.preventDefault()
        if (selectedEntry.kind === 'dir') void loadDir(selectedEntry.path, true)
        else if (mode === 'file') finish({ ok: true, path: selectedEntry.path })
      }
    }

    dom.closeBtn.addEventListener('click', () => finish({ ok: false, cancelled: true }))
    dom.cancelBtn.addEventListener('click', () => finish({ ok: false, cancelled: true }))
    dom.overlay.addEventListener('click', (e) => {
      if (e.target === dom.overlay) finish({ ok: false, cancelled: true })
    })
    dom.upBtn.addEventListener('click', () => {
      if (parentDir) void loadDir(parentDir, true)
    })
    const goToTypedPath = () => {
      const target = dom.pathInput.value.trim()
      if (target) void loadDir(target, true)
    }
    dom.goBtn.addEventListener('click', goToTypedPath)
    dom.pathInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        goToTypedPath()
      }
    })
    dom.filterInput.addEventListener('input', () => renderEntries())
    dom.confirmBtn.addEventListener('click', () => {
      const chosen = resolveChoice()
      if (chosen) finish({ ok: true, path: chosen })
    })

    window.addEventListener('keydown', onKeyDown, true)
    document.body.appendChild(dom.overlay)
    dom.filterInput.focus()
    void loadDir(config.initialDir, false)
  })
}
