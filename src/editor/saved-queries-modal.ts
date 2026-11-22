// src/editor/saved-queries-modal.ts
// Saved Queries / SQL Snippets library modal (openStudioSavedQueriesModal)

import type { DatabaseDriverType, SavedQueryEntry } from '../protocol.js'
import type { StudioRpcModalContext } from './studio-modals.js'

export interface StudioSavedQueriesModalContext extends StudioRpcModalContext {
  currentSql: string
  activeDialect?: DatabaseDriverType
  onInsertSql: (sql: string, mode: 'replace' | 'new-tab', title?: string) => void
}

type NoticeKind = 'status' | 'alert'

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function openStudioSavedQueriesModal(ctx: StudioSavedQueriesModalContext): void {
  let entries: SavedQueryEntry[] = []
  let isLoading = true
  let isBusy = false
  let isClosed = false
  let editingId: string | undefined
  let editingDialect: DatabaseDriverType | undefined
  let confirmDeleteId: string | undefined
  let loadSeq = 0
  let confirmDeleteTimer: ReturnType<typeof setTimeout> | undefined
  let focusTimer: ReturnType<typeof setTimeout> | undefined
  let confirmDeleteButton: HTMLButtonElement | undefined
  let confirmDeleteEntry: SavedQueryEntry | undefined

  const clearConfirmDeleteTimer = (): void => {
    if (confirmDeleteTimer !== undefined) {
      clearTimeout(confirmDeleteTimer)
      confirmDeleteTimer = undefined
    }
  }

  const dispose = (): void => {
    isClosed = true
    clearConfirmDeleteTimer()
    if (focusTimer !== undefined) {
      clearTimeout(focusTimer)
      focusTimer = undefined
    }
  }

  const closeModalSafe = (): void => {
    dispose()
    ctx.closeModal()
  }

  const modal = document.createElement('div')
  modal.className = 'datanoa-create-table-modal datanoa-saved-queries-modal'

  const head = document.createElement('div')
  head.className = 'datanoa-modal-head'

  const titleSpan = document.createElement('span')
  titleSpan.textContent = 'Saved Queries / SQL Snippets'

  const countBadge = document.createElement('span')
  countBadge.className = 'datanoa-badge'
  countBadge.textContent = '0'

  head.appendChild(titleSpan)
  head.appendChild(countBadge)
  modal.appendChild(head)

  const body = document.createElement('div')
  body.className = 'datanoa-modal-body'

  const noticeEl = document.createElement('div')
  noticeEl.className = 'datanoa-saved-notice'
  noticeEl.setAttribute('role', 'status')
  noticeEl.style.display = 'none'
  body.appendChild(noticeEl)

  const setNotice = (kind: NoticeKind, text: string): void => {
    noticeEl.setAttribute('role', kind)
    noticeEl.classList.remove('error')
    if (kind === 'alert') {
      noticeEl.classList.add('error')
    }
    noticeEl.textContent = text
    noticeEl.style.display = text ? 'block' : 'none'
  }

  // Quick Save / Edit form
  const form = document.createElement('div')
  form.className = 'datanoa-saved-form'

  const nameField = document.createElement('div')
  nameField.className = 'datanoa-saved-field'
  const nameLabel = document.createElement('label')
  nameLabel.className = 'datanoa-saved-label'
  nameLabel.htmlFor = 'datanoa-saved-query-name'
  nameLabel.textContent = 'Name'
  const nameInput = document.createElement('input')
  nameInput.type = 'text'
  nameInput.id = 'datanoa-saved-query-name'
  nameInput.className = 'datanoa-filter-input'
  nameInput.placeholder = 'Query name'
  nameInput.maxLength = 120
  nameInput.setAttribute('aria-label', 'Saved query name')
  nameField.appendChild(nameLabel)
  nameField.appendChild(nameInput)

  const tagsField = document.createElement('div')
  tagsField.className = 'datanoa-saved-field'
  const tagsLabel = document.createElement('label')
  tagsLabel.className = 'datanoa-saved-label'
  tagsLabel.htmlFor = 'datanoa-saved-query-tags'
  tagsLabel.textContent = 'Tags'
  const tagsInput = document.createElement('input')
  tagsInput.type = 'text'
  tagsInput.id = 'datanoa-saved-query-tags'
  tagsInput.className = 'datanoa-filter-input'
  tagsInput.placeholder = 'analytics, report (comma separated)'
  tagsInput.setAttribute('aria-label', 'Saved query tags')
  tagsField.appendChild(tagsLabel)
  tagsField.appendChild(tagsInput)

  form.appendChild(nameField)
  form.appendChild(tagsField)

  const sqlField = document.createElement('div')
  sqlField.className = 'datanoa-saved-field'
  const sqlLabel = document.createElement('label')
  sqlLabel.className = 'datanoa-saved-label'
  sqlLabel.htmlFor = 'datanoa-saved-query-sql'
  sqlLabel.textContent = 'SQL'
  const sqlInput = document.createElement('textarea')
  sqlInput.id = 'datanoa-saved-query-sql'
  sqlInput.className = 'datanoa-saved-sql-input'
  sqlInput.placeholder = 'SQL to save...'
  sqlInput.value = ctx.currentSql
  sqlInput.setAttribute('aria-label', 'Saved query SQL')
  sqlField.appendChild(sqlLabel)
  sqlField.appendChild(sqlInput)
  form.appendChild(sqlField)

  const formActions = document.createElement('div')
  formActions.className = 'datanoa-saved-form-actions'

  const saveBtn = document.createElement('button')
  saveBtn.type = 'button'
  saveBtn.className = 'datanoa-btn datanoa-btn-primary'
  saveBtn.textContent = 'Save Query'

  const resetBtn = document.createElement('button')
  resetBtn.type = 'button'
  resetBtn.className = 'datanoa-btn'
  resetBtn.textContent = 'Reset'

  formActions.appendChild(resetBtn)
  formActions.appendChild(saveBtn)
  form.appendChild(formActions)
  body.appendChild(form)

  // Live filter
  const filterInput = document.createElement('input')
  filterInput.type = 'search'
  filterInput.className = 'datanoa-filter-input datanoa-saved-filter'
  filterInput.placeholder = 'Filter saved queries...'
  filterInput.setAttribute('aria-label', 'Filter saved queries')
  body.appendChild(filterInput)

  const listEl = document.createElement('div')
  listEl.className = 'datanoa-saved-list'
  body.appendChild(listEl)

  modal.appendChild(body)

  const actions = document.createElement('div')
  actions.className = 'datanoa-modal-actions'

  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'datanoa-btn'
  closeBtn.textContent = 'Close'

  actions.appendChild(closeBtn)
  modal.appendChild(actions)

  const resetForm = (): void => {
    editingId = undefined
    editingDialect = undefined
    nameInput.value = ''
    tagsInput.value = ''
    sqlInput.value = ctx.currentSql
  }

  const updateDeleteButton = (
    btn: HTMLButtonElement,
    entry: SavedQueryEntry
  ): void => {
    const isConfirming = confirmDeleteId === entry.id
    btn.textContent = isConfirming ? 'Confirm?' : 'Delete'
    btn.classList.toggle('datanoa-btn-danger-solid', isConfirming)
    btn.classList.toggle('datanoa-btn-danger', !isConfirming)
    btn.setAttribute(
      'aria-label',
      isConfirming
        ? `Confirm delete ${entry.name}`
        : `Delete saved query ${entry.name}`
    )
  }

  const clearConfirmInPlace = (): void => {
    const btn = confirmDeleteButton
    const entry = confirmDeleteEntry
    confirmDeleteButton = undefined
    confirmDeleteEntry = undefined
    confirmDeleteId = undefined
    if (btn && entry) updateDeleteButton(btn, entry)
  }

  const renderList = (): void => {
    confirmDeleteButton = undefined
    confirmDeleteEntry = undefined

    const controlsDisabled = isBusy || isLoading
    saveBtn.disabled = controlsDisabled
    resetBtn.disabled = controlsDisabled
    filterInput.disabled = controlsDisabled
    resetBtn.textContent = editingId !== undefined ? 'Cancel Edit' : 'Reset'
    saveBtn.textContent = isBusy
      ? editingId !== undefined
        ? 'Updating...'
        : 'Saving...'
      : editingId !== undefined
        ? 'Update Query'
        : 'Save Query'

    listEl.textContent = ''
    countBadge.textContent = String(entries.length)

    if (isLoading) {
      const loading = document.createElement('div')
      loading.className = 'datanoa-saved-empty'
      loading.textContent = 'Loading saved queries...'
      listEl.appendChild(loading)
      return
    }

    const query = filterInput.value.trim().toLowerCase()
    const filtered = query
      ? entries.filter((entry) =>
          `${entry.name} ${(entry.tags ?? []).join(' ')} ${entry.dialect ?? ''} ${entry.sql}`
            .toLowerCase()
            .includes(query)
        )
      : entries

    if (filtered.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'datanoa-saved-empty'
      empty.textContent = query
        ? 'No saved queries match your filter.'
        : 'No saved queries yet. Save the current SQL to get started.'
      listEl.appendChild(empty)
      return
    }

    for (const entry of filtered) {
      const item = document.createElement('div')
      item.className = 'datanoa-saved-item'
      if (editingId === entry.id) {
        item.classList.add('is-editing')
      }

      const itemHead = document.createElement('div')
      itemHead.className = 'datanoa-saved-item-head'

      const nameEl = document.createElement('span')
      nameEl.className = 'datanoa-saved-item-name'
      nameEl.textContent = entry.name
      itemHead.appendChild(nameEl)

      if (entry.dialect) {
        const dialectBadge = document.createElement('span')
        dialectBadge.className = 'datanoa-badge datanoa-badge-pk'
        dialectBadge.textContent = entry.dialect.toUpperCase()
        itemHead.appendChild(dialectBadge)
      }

      for (const tag of entry.tags ?? []) {
        const tagEl = document.createElement('span')
        tagEl.className = 'datanoa-saved-tag'
        tagEl.textContent = tag
        itemHead.appendChild(tagEl)
      }
      item.appendChild(itemHead)

      const preview = document.createElement('div')
      preview.className = 'datanoa-saved-preview'
      const compact = entry.sql.replace(/\s+/g, ' ').trim()
      preview.textContent = compact.length > 120 ? `${compact.slice(0, 117)}...` : compact
      preview.title = entry.sql
      item.appendChild(preview)

      const itemActions = document.createElement('div')
      itemActions.className = 'datanoa-saved-item-actions'

      const loadBtn = document.createElement('button')
      loadBtn.type = 'button'
      loadBtn.className = 'datanoa-btn datanoa-btn-sm'
      loadBtn.textContent = 'Load'
      loadBtn.title = 'Replace active SQL tab'
      loadBtn.disabled = controlsDisabled
      loadBtn.addEventListener('click', () => {
        if (isBusy || isLoading || isClosed) return
        ctx.onInsertSql(entry.sql, 'replace', entry.name)
        closeModalSafe()
      })

      const newTabBtn = document.createElement('button')
      newTabBtn.type = 'button'
      newTabBtn.className = 'datanoa-btn datanoa-btn-sm'
      newTabBtn.textContent = 'New Tab'
      newTabBtn.title = 'Open in new SQL tab'
      newTabBtn.disabled = controlsDisabled
      newTabBtn.addEventListener('click', () => {
        if (isBusy || isLoading || isClosed) return
        ctx.onInsertSql(entry.sql, 'new-tab', entry.name)
        closeModalSafe()
      })

      const editBtn = document.createElement('button')
      editBtn.type = 'button'
      editBtn.className = 'datanoa-btn datanoa-btn-sm'
      editBtn.textContent = 'Edit'
      editBtn.disabled = controlsDisabled
      editBtn.addEventListener('click', () => {
        if (isBusy || isLoading || isClosed) return
        clearConfirmDeleteTimer()
        clearConfirmInPlace()
        editingId = entry.id
        editingDialect = entry.dialect
        nameInput.value = entry.name
        tagsInput.value = (entry.tags ?? []).join(', ')
        sqlInput.value = entry.sql
        renderList()
        nameInput.focus()
      })

      const deleteBtn = document.createElement('button')
      deleteBtn.type = 'button'
      deleteBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-btn-danger'
      deleteBtn.disabled = controlsDisabled
      updateDeleteButton(deleteBtn, entry)
      deleteBtn.addEventListener('click', () => {
        if (isBusy || isLoading || isClosed) return
        if (confirmDeleteId !== entry.id) {
          clearConfirmDeleteTimer()
          clearConfirmInPlace()
          confirmDeleteId = entry.id
          confirmDeleteButton = deleteBtn
          confirmDeleteEntry = entry
          updateDeleteButton(deleteBtn, entry)
          confirmDeleteTimer = setTimeout(() => {
            confirmDeleteTimer = undefined
            if (isClosed) return
            clearConfirmInPlace()
          }, 4000)
          return
        }
        clearConfirmDeleteTimer()
        clearConfirmInPlace()
        void deleteEntry(entry)
      })
      deleteBtn.addEventListener('blur', () => {
        if (confirmDeleteId !== entry.id) return
        clearConfirmDeleteTimer()
        clearConfirmInPlace()
      })

      itemActions.appendChild(loadBtn)
      itemActions.appendChild(newTabBtn)
      itemActions.appendChild(editBtn)
      itemActions.appendChild(deleteBtn)
      item.appendChild(itemActions)
      listEl.appendChild(item)
    }
  }

  const deleteEntry = async (entry: SavedQueryEntry): Promise<void> => {
    if (isBusy || isLoading || isClosed) return
    isBusy = true
    renderList()
    try {
      await ctx.requestPlugin('queries.saved.delete', { id: entry.id })
      if (isClosed) return
      entries = entries.filter((item) => item.id !== entry.id)
      confirmDeleteId = undefined
      if (editingId === entry.id) {
        resetForm()
      }
      setNotice('status', `Deleted "${entry.name}"`)
      ctx.updateStatus(`Deleted saved query "${entry.name}"`)
    } catch (err: unknown) {
      if (isClosed) return
      setNotice('alert', `Delete failed: ${describeError(err)}`)
    } finally {
      isBusy = false
      if (!isClosed) renderList()
    }
  }

  const saveEntry = async (): Promise<void> => {
    if (isBusy || isLoading || isClosed) return
    const name = nameInput.value.trim()
    const sql = sqlInput.value.trim()
    if (!name) {
      setNotice('alert', 'Query name is required.')
      nameInput.focus()
      return
    }
    if (!sql) {
      setNotice('alert', 'SQL text is required.')
      sqlInput.focus()
      return
    }

    const tags = tagsInput.value
      .split(',')
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0)

    const dialect = editingDialect ?? ctx.activeDialect

    isBusy = true
    renderList()
    try {
      const res = await ctx.requestPlugin<{ ok: boolean; entry: SavedQueryEntry }>(
        'queries.saved.save',
        {
          id: editingId,
          name,
          sql,
          dialect,
          tags,
        }
      )
      if (isClosed) return
      const saved = res.entry
      const idx = entries.findIndex((item) => item.id === saved.id)
      if (idx >= 0) {
        entries[idx] = saved
      } else {
        entries.unshift(saved)
      }
      entries = entries
        .slice()
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 200)
      resetForm()
      setNotice('status', `Saved "${saved.name}"`)
      ctx.updateStatus(`Saved query "${saved.name}"`)
    } catch (err: unknown) {
      if (isClosed) return
      setNotice('alert', `Save failed: ${describeError(err)}`)
    } finally {
      isBusy = false
      if (!isClosed) renderList()
    }
  }

  const loadEntries = async (): Promise<void> => {
    const seq = ++loadSeq
    isLoading = true
    renderList()
    try {
      const res = await ctx.requestPlugin<{ entries: SavedQueryEntry[] }>(
        'queries.saved.list',
        {}
      )
      if (isClosed || seq !== loadSeq) return
      entries = Array.isArray(res.entries) ? res.entries : []
      isLoading = false
      setNotice('status', '')
    } catch (err: unknown) {
      if (isClosed || seq !== loadSeq) return
      isLoading = false
      setNotice('alert', `Failed to load saved queries: ${describeError(err)}`)
    }
    if (!isClosed && seq === loadSeq) renderList()
  }

  filterInput.addEventListener('input', () => {
    if (isClosed) return
    if (confirmDeleteId !== undefined) {
      clearConfirmDeleteTimer()
      clearConfirmInPlace()
    }
    renderList()
  })

  saveBtn.addEventListener('click', () => {
    void saveEntry()
  })

  resetBtn.addEventListener('click', () => {
    if (isBusy || isLoading || isClosed) return
    clearConfirmDeleteTimer()
    clearConfirmInPlace()
    resetForm()
    setNotice('status', '')
    renderList()
    nameInput.focus()
  })

  closeBtn.addEventListener('click', () => {
    if (isBusy || isLoading || isClosed) return
    closeModalSafe()
  })

  modal.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Enter') return
    const target = e.target as HTMLElement | null
    if (target !== nameInput && target !== tagsInput) return
    e.preventDefault()
    void saveEntry()
  })

  ctx.mountModal(modal, () => {
    if (isBusy) return false
    dispose()
    return true
  })
  renderList()
  void loadEntries()
  focusTimer = setTimeout(() => {
    focusTimer = undefined
    if (isClosed) return
    nameInput.focus()
  }, 50)
}

export const openSavedQueriesModal = openStudioSavedQueriesModal
