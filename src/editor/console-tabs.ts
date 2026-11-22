// src/editor/console-tabs.ts
// Pure state manager for Phase 2: Multi-Tab SQL Console
// Zero-DOM, zero-dependency, manages independent SQL docs, cursors, and multi-result sets

import type { QueryResult } from '../protocol.js'

export interface SqlConsoleTabState {
  id: string
  title: string
  sql: string
  cursorOffset?: number
  lastResult?: QueryResult | null
  activeResultSetIndex: number
  executedSql?: string
  executedConnectionId?: string
}

export interface PersistedConsoleTabsState {
  activeTabId: string
  tabs: Array<{ id: string; title: string; sql: string }>
}

const MAX_PERSISTED_TABS = 20
const MAX_PERSISTED_SQL_LENGTH = 50_000

function generateTabId(): string {
  return `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

export class ConsoleTabsManager {
  private tabs: SqlConsoleTabState[] = []
  private activeTabId: string

  constructor(initial?: PersistedConsoleTabsState | string) {
    if (typeof initial === 'string') {
      const firstTab: SqlConsoleTabState = {
        id: generateTabId(),
        title: 'Console 1',
        sql: initial,
        activeResultSetIndex: 0,
      }
      this.tabs = [firstTab]
      this.activeTabId = firstTab.id
    } else if (initial && Array.isArray(initial.tabs) && initial.tabs.length > 0) {
      this.tabs = initial.tabs.slice(0, MAX_PERSISTED_TABS).map((t, idx) => ({
        id: t.id || generateTabId(),
        title: t.title?.trim() || `Console ${idx + 1}`,
        sql: typeof t.sql === 'string' ? t.sql.slice(0, MAX_PERSISTED_SQL_LENGTH) : '',
        activeResultSetIndex: 0,
      }))
      const exists = this.tabs.some((t) => t.id === initial.activeTabId)
      this.activeTabId = exists ? initial.activeTabId : this.tabs[0].id
    } else {
      const defaultTab: SqlConsoleTabState = {
        id: generateTabId(),
        title: 'Console 1',
        sql: '',
        activeResultSetIndex: 0,
      }
      this.tabs = [defaultTab]
      this.activeTabId = defaultTab.id
    }
  }

  getTabs(): SqlConsoleTabState[] {
    return [...this.tabs]
  }

  getActiveTabId(): string {
    return this.activeTabId
  }

  getActiveTab(): SqlConsoleTabState {
    const tab = this.tabs.find((t) => t.id === this.activeTabId)
    if (tab) {
      return tab
    }
    // Fallback safety guard
    return this.tabs[0]
  }

  /**
   * Generates next default title `Console N` that does not collide with existing titles.
   */
  private generateNextDefaultTitle(): string {
    const existingTitles = new Set(this.tabs.map((t) => t.title.toLowerCase()))
    let counter = 1
    while (existingTitles.has(`console ${counter}`)) {
      counter++
    }
    return `Console ${counter}`
  }

  /**
   * Adds a new tab with optional initial SQL and title.
   * Auto-activates the newly added tab.
   */
  addTab(initialSql = '', title?: string): SqlConsoleTabState {
    const finalTitle = title?.trim() || this.generateNextDefaultTitle()
    const newTab: SqlConsoleTabState = {
      id: generateTabId(),
      title: finalTitle,
      sql: initialSql,
      activeResultSetIndex: 0,
    }
    this.tabs.push(newTab)
    this.activeTabId = newTab.id
    return newTab
  }

  /**
   * Switches active tab to the specified ID.
   */
  switchTab(tabId: string): boolean {
    const exists = this.tabs.some((t) => t.id === tabId)
    if (!exists) {
      return false
    }
    this.activeTabId = tabId
    return true
  }

  /**
   * Closes the tab with the specified ID.
   * If closing the last remaining tab, resets it to empty `Console 1` instead of leaving 0 tabs.
   */
  closeTab(tabId: string): boolean {
    const targetIdx = this.tabs.findIndex((t) => t.id === tabId)
    if (targetIdx === -1) {
      return false
    }

    if (this.tabs.length === 1) {
      // Reset only remaining tab instead of removing it
      const onlyTab = this.tabs[0]
      onlyTab.title = 'Console 1'
      onlyTab.sql = ''
      onlyTab.cursorOffset = 0
      onlyTab.lastResult = null
      onlyTab.activeResultSetIndex = 0
      onlyTab.executedSql = ''
      onlyTab.executedConnectionId = undefined
      return true
    }

    const wasActive = this.activeTabId === tabId
    this.tabs.splice(targetIdx, 1)

    if (wasActive) {
      // Pick adjacent tab
      const nextIdx = Math.min(targetIdx, this.tabs.length - 1)
      this.activeTabId = this.tabs[nextIdx].id
    }

    return true
  }

  /**
   * Renames a tab with validation (rejects empty or whitespace-only names).
   */
  renameTab(tabId: string, newTitle: string): boolean {
    const trimmed = newTitle.trim()
    if (!trimmed) {
      return false
    }
    const tab = this.tabs.find((t) => t.id === tabId)
    if (!tab) {
      return false
    }
    tab.title = trimmed
    return true
  }

  /**
   * Updates SQL text and optional cursor offset for the active tab.
   */
  updateActiveSql(sql: string, cursorOffset?: number): void {
    const tab = this.getActiveTab()
    tab.sql = sql
    if (cursorOffset !== undefined) {
      tab.cursorOffset = cursorOffset
    }
  }

  /**
   * Caches query execution result and active result set index on the active tab.
   */
  setActiveResult(
    result: QueryResult | null,
    activeResultSetIndex = 0,
    executedSql?: string,
    executedConnectionId?: string
  ): void {
    const tab = this.getActiveTab()
    tab.lastResult = result
    tab.activeResultSetIndex = Math.max(0, activeResultSetIndex)
    if (executedSql !== undefined) tab.executedSql = executedSql
    if (result === null) {
      tab.executedConnectionId = undefined
    } else if (executedConnectionId !== undefined) {
      tab.executedConnectionId = executedConnectionId
    }
  }

  /**
   * Caches a query result on a specific tab without changing the active tab.
   * Returns false if the tab does not exist.
   */
  setResultForTab(
    tabId: string,
    result: QueryResult | null,
    activeResultSetIndex = 0,
    executedSql?: string,
    executedConnectionId?: string
  ): boolean {
    const tab = this.tabs.find((t) => t.id === tabId)
    if (!tab) {
      return false
    }
    tab.lastResult = result
    tab.activeResultSetIndex = Math.max(0, activeResultSetIndex)
    if (executedSql !== undefined) tab.executedSql = executedSql
    if (result === null) {
      tab.executedConnectionId = undefined
    } else if (executedConnectionId !== undefined) {
      tab.executedConnectionId = executedConnectionId
    }
    return true
  }

  /**
   * Switches the active result-set tab index on the active console tab.
   */
  setActiveResultSetIndex(index: number): void {
    const tab = this.getActiveTab()
    tab.activeResultSetIndex = Math.max(0, index)
  }

  /**
   * Serializes console tabs for storage persistence (bounded at 20 tabs, caps SQL length).
   */
  toPersistedState(): PersistedConsoleTabsState {
    return {
      activeTabId: this.activeTabId,
      tabs: this.tabs.slice(0, MAX_PERSISTED_TABS).map((t) => ({
        id: t.id,
        title: t.title,
        sql: t.sql.slice(0, MAX_PERSISTED_SQL_LENGTH),
      })),
    }
  }
}
