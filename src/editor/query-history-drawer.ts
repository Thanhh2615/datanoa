// src/editor/query-history-drawer.ts
// Query History Drawer controller: async fetch, search filtering, insert & copy actions.

import type { QueryHistoryEntry } from '../protocol.js'
import { copyTextFallback, formatRelativeTimestamp } from './db-icons.js'

export interface QueryHistoryDrawerHost {
  getDrawerEl: () => HTMLDivElement | null
  getListEl: () => HTMLDivElement | null
  getToggleBtn: () => HTMLButtonElement | null
  setSqlText: (sql: string) => void
  insertSqlText: (sql: string) => void
  requestPlugin: <T = unknown>(
    method: string,
    payload?: Record<string, unknown>,
    options?: { timeoutMs?: number }
  ) => Promise<T>
  updateStatus: (stateText: string) => void
}

export class QueryHistoryDrawerController {
  private readonly host: QueryHistoryDrawerHost
  private entries: QueryHistoryEntry[] = []
  private searchQuery = ''
  private openState = false
  private seq = 0

  constructor(host: QueryHistoryDrawerHost) {
    this.host = host
  }

  public isOpen(): boolean {
    return this.openState
  }

  public setSearchQuery(rawQuery: string): void {
    this.searchQuery = rawQuery.trim().toLowerCase()
    this.render()
  }

  public clearCached(): void {
    this.entries = []
    this.render()
  }

  public bumpSeq(): void {
    this.seq++
  }

  public async toggle(): Promise<void> {
    this.openState = !this.openState
    this.host.getToggleBtn()?.classList.toggle('active', this.openState)
    const drawer = this.host.getDrawerEl()
    if (!drawer) return
    drawer.style.display = this.openState ? 'flex' : 'none'
    if (this.openState) {
      await this.load()
    }
  }

  public close(): void {
    this.seq++
    this.openState = false
    const drawer = this.host.getDrawerEl()
    if (drawer) drawer.style.display = 'none'
    this.host.getToggleBtn()?.classList.remove('active')
  }

  public destroy(): void {
    this.close()
    this.entries = []
    this.searchQuery = ''
  }

  public render(): void {
    const listEl = this.host.getListEl()
    if (!listEl) return
    listEl.innerHTML = ''
    const q = this.searchQuery
    const filtered = q
      ? this.entries.filter(
          (e) =>
            e.sql.toLowerCase().includes(q) ||
            (e.connectionName || '').toLowerCase().includes(q)
        )
      : this.entries

    if (filtered.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'datanoa-cell-null'
      empty.style.padding = '10px 12px'
      empty.textContent = q
        ? `No query history matches "${q}".`
        : 'No executed queries in history yet.'
      listEl.appendChild(empty)
      return
    }

    for (const entry of filtered) {
      const row = document.createElement('div')
      row.className = 'datanoa-history-row'

      const sqlSpan = document.createElement('span')
      sqlSpan.className = 'datanoa-history-sql'
      sqlSpan.textContent = entry.sql.replace(/\s+/g, ' ').trim()
      sqlSpan.title = entry.sql
      sqlSpan.style.cursor = 'pointer'
      sqlSpan.addEventListener('click', () => {
        this.host.setSqlText(entry.sql)
      })

      const relTime = formatRelativeTimestamp(entry.timestamp)
      const metaSpan = document.createElement('span')
      metaSpan.className = 'datanoa-history-meta'
      const baseMeta = entry.isError
        ? `${entry.connectionName} · ERROR`
        : `${entry.connectionName} · ${entry.durationMs}ms · ${entry.rowCount} rows`
      metaSpan.textContent = relTime ? `${baseMeta} · ${relTime}` : baseMeta

      const actions = document.createElement('div')
      actions.className = 'datanoa-btn-group'

      const insertBtn = document.createElement('button')
      insertBtn.type = 'button'
      insertBtn.className = 'datanoa-btn datanoa-btn-sm'
      insertBtn.textContent = 'Insert'
      insertBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        this.host.insertSqlText(entry.sql)
        this.host.updateStatus('Inserted history query into SQL Console')
      })

      const copyBtn = document.createElement('button')
      copyBtn.type = 'button'
      copyBtn.className = 'datanoa-btn datanoa-btn-sm'
      copyBtn.textContent = 'Copy'
      copyBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        copyTextFallback(entry.sql, copyBtn)
        this.host.updateStatus('Copied history SQL to clipboard')
      })

      actions.appendChild(insertBtn)
      actions.appendChild(copyBtn)

      row.appendChild(sqlSpan)
      row.appendChild(metaSpan)
      row.appendChild(actions)
      listEl.appendChild(row)
    }
  }

  public async load(): Promise<void> {
    const listEl = this.host.getListEl()
    if (!listEl) return
    const seq = ++this.seq
    listEl.innerHTML = ''

    const loadingEl = document.createElement('div')
    loadingEl.className = 'datanoa-cell-null'
    loadingEl.style.padding = '10px 12px'
    loadingEl.style.display = 'flex'
    loadingEl.style.alignItems = 'center'
    loadingEl.style.gap = '6px'
    const spinner = document.createElement('span')
    spinner.className = 'datanoa-spinner'
    spinner.setAttribute('aria-hidden', 'true')
    const txt = document.createElement('span')
    txt.textContent = 'Loading query history...'
    loadingEl.appendChild(spinner)
    loadingEl.appendChild(txt)
    listEl.appendChild(loadingEl)

    try {
      const res = await this.host.requestPlugin<{ entries: QueryHistoryEntry[] }>(
        'query.history.list',
        { limit: 50 }
      )
      if (seq !== this.seq) return
      this.entries = res?.entries || []
      this.render()
    } catch (err: unknown) {
      if (seq !== this.seq) return
      const msg = err instanceof Error ? err.message : String(err)
      const latestList = this.host.getListEl()
      if (latestList) {
        latestList.innerHTML = ''
        const errEl = document.createElement('div')
        errEl.style.padding = '10px 12px'
        errEl.style.color = 'var(--danger)'
        errEl.textContent = `Failed to load query history: ${msg}`
        latestList.appendChild(errEl)
      }
    }
  }
}
