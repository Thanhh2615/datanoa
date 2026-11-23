// src/panel/panel-sql-tabs.js
// Side Panel SQL Console tab state manager, schema-aware SQL/Redis completion engine,
// and grouped schema-table dropdown value helpers.

import { findStatementAtCaret } from './panel-core.js'

const MAX_PANEL_CONSOLE_TABS = 20
const MAX_PANEL_CONSOLE_SQL_LEN = 50000

function generatePanelTabId() {
  return `ptab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

function buildEmptyTab(id, title, sql = '') {
  return {
    id,
    title,
    sql: String(sql || '').slice(0, MAX_PANEL_CONSOLE_SQL_LEN),
    cursorOffset: 0,
    lastResult: null,
    lastResultMode: 'query',
    activeResultSetIndex: 0,
    executedSql: '',
    executedConnectionId: undefined,
    resultStates: {},
  }
}

/**
 * Creates a multi-tab state manager for Side Panel SQL consoles and per-tab result caches.
 */
export function createPanelConsoleTabsManager(initial) {
  let tabs = []
  let activeTabId = ''

  if (typeof initial === 'string') {
    const first = buildEmptyTab(generatePanelTabId(), 'Console 1', initial)
    tabs = [first]
    activeTabId = first.id
  } else if (initial && Array.isArray(initial.tabs) && initial.tabs.length > 0) {
    tabs = initial.tabs
      .slice(0, MAX_PANEL_CONSOLE_TABS)
      .map((t, idx) =>
        buildEmptyTab(
          typeof t?.id === 'string' && t.id ? t.id : generatePanelTabId(),
          typeof t?.title === 'string' && t.title.trim() ? t.title.trim() : `Console ${idx + 1}`,
          typeof t?.sql === 'string' ? t.sql : ''
        )
      )
    const exists = tabs.some((t) => t.id === initial.activeTabId)
    activeTabId = exists ? initial.activeTabId : tabs[0].id
  } else {
    const first = buildEmptyTab(generatePanelTabId(), 'Console 1', '')
    tabs = [first]
    activeTabId = first.id
  }

  function getTabs() {
    return [...tabs]
  }

  function getActiveTabId() {
    return activeTabId
  }

  function getActiveTab() {
    return tabs.find((t) => t.id === activeTabId) || tabs[0]
  }

  function generateNextTitle() {
    const used = new Set(tabs.map((t) => t.title.toLowerCase()))
    let n = 1
    while (used.has(`console ${n}`)) n++
    return `Console ${n}`
  }

  function switchTab(tabId) {
    const found = tabs.find((t) => t.id === tabId)
    if (!found) return false
    activeTabId = tabId
    return true
  }

  function addTab(initialSql = '', customTitle) {
    const title = (customTitle && customTitle.trim()) || generateNextTitle()
    const newTab = buildEmptyTab(generatePanelTabId(), title, initialSql)
    if (tabs.length >= MAX_PANEL_CONSOLE_TABS) {
      tabs[tabs.length - 1] = newTab
    } else {
      tabs.push(newTab)
    }
    activeTabId = newTab.id
    return newTab
  }

  function closeTab(tabId) {
    if (tabs.length <= 1) return false
    const idx = tabs.findIndex((t) => t.id === tabId)
    if (idx < 0) return false
    const wasActive = tabs[idx].id === activeTabId
    tabs.splice(idx, 1)
    if (wasActive) {
      const nextIdx = Math.min(idx, tabs.length - 1)
      activeTabId = tabs[nextIdx].id
    }
    return true
  }

  function renameTab(tabId, newTitle) {
    const trimmed = String(newTitle || '').trim()
    if (!trimmed) return false
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab) return false
    tab.title = trimmed.slice(0, 40)
    return true
  }

  function updateActiveSql(sql, cursorOffset) {
    const tab = getActiveTab()
    tab.sql = String(sql ?? '')
    if (cursorOffset !== undefined) {
      tab.cursorOffset = cursorOffset
    }
  }

  function setResultForTab(
    tabId,
    result,
    activeResultSetIndex = 0,
    executedSql,
    executedConnectionId,
    resultStates,
    mode = 'query'
  ) {
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab) return false
    tab.lastResult = result
    tab.activeResultSetIndex = Math.max(0, activeResultSetIndex)
    if (executedSql !== undefined) tab.executedSql = executedSql
    if (result === null) {
      tab.lastResultMode = 'query'
      tab.executedConnectionId = undefined
      tab.resultStates = {}
    } else {
      tab.lastResultMode = mode === 'explain' ? 'explain' : 'query'
      if (executedConnectionId !== undefined) tab.executedConnectionId = executedConnectionId
      tab.resultStates = resultStates ? { ...resultStates } : {}
    }
    return true
  }

  function setActiveResultSetIndex(index) {
    const tab = getActiveTab()
    tab.activeResultSetIndex = Math.max(0, index)
  }

  function getResultTabState(resultIndex, tabId) {
    const tab = tabId ? tabs.find((t) => t.id === tabId) : getActiveTab()
    return tab?.resultStates?.[resultIndex]
  }

  function setResultTabState(resultIndex, stateObj, tabId) {
    const tab = tabId ? tabs.find((t) => t.id === tabId) : getActiveTab()
    if (!tab) return
    if (!tab.resultStates) tab.resultStates = {}
    tab.resultStates[resultIndex] = stateObj
  }

  function toPersistedState(isSensitiveFn) {
    return {
      activeTabId,
      tabs: tabs.slice(0, MAX_PANEL_CONSOLE_TABS).map((t) => {
        const raw = String(t.sql || '').slice(0, MAX_PANEL_CONSOLE_SQL_LEN)
        const safeSql = typeof isSensitiveFn === 'function' && isSensitiveFn(raw) ? '' : raw
        return {
          id: t.id,
          title: t.title,
          sql: safeSql,
        }
      }),
    }
  }

  return {
    getTabs,
    getActiveTabId,
    getActiveTab,
    switchTab,
    addTab,
    closeTab,
    renameTab,
    updateActiveSql,
    setResultForTab,
    setActiveResultSetIndex,
    getResultTabState,
    setResultTabState,
    toPersistedState,
  }
}

const PANEL_SQL_KEYWORD_COMPLETIONS = [
  { label: 'SELECT', detail: 'SQL clause', boost: 40 },
  { label: 'SELECT * FROM ', detail: 'SQL snippet', boost: 45 },
  { label: 'FROM', detail: 'SQL clause', boost: 42 },
  { label: 'WHERE', detail: 'SQL clause', boost: 42 },
  { label: 'ORDER BY', detail: 'SQL clause', boost: 40 },
  { label: 'GROUP BY', detail: 'SQL clause', boost: 38 },
  { label: 'LIMIT', detail: 'SQL clause', boost: 40 },
  { label: 'OFFSET', detail: 'SQL clause', boost: 35 },
  { label: 'HAVING', detail: 'SQL clause', boost: 34 },
  { label: 'LEFT JOIN', detail: 'SQL join', boost: 36 },
  { label: 'INNER JOIN', detail: 'SQL join', boost: 36 },
  { label: 'INSERT INTO', detail: 'SQL DML', boost: 34 },
  { label: 'VALUES', detail: 'SQL DML', boost: 32 },
  { label: 'UPDATE', detail: 'SQL DML', boost: 34 },
  { label: 'SET', detail: 'SQL DML', boost: 34 },
  { label: 'DELETE FROM', detail: 'SQL DML', boost: 32 },
  { label: 'EXPLAIN', detail: 'SQL plan', boost: 32 },
  { label: 'EXPLAIN QUERY PLAN', detail: 'SQLite plan', boost: 31 },
  { label: 'DISTINCT', detail: 'SQL keyword', boost: 30 },
  { label: 'AND', detail: 'SQL operator', boost: 35 },
  { label: 'OR', detail: 'SQL operator', boost: 34 },
  { label: 'NOT', detail: 'SQL operator', boost: 30 },
  { label: 'IS NULL', detail: 'SQL predicate', boost: 34 },
  { label: 'IS NOT NULL', detail: 'SQL predicate', boost: 35 },
  { label: 'LIKE', detail: 'SQL predicate', boost: 34 },
  { label: 'IN', detail: 'SQL predicate', boost: 33 },
  { label: 'BETWEEN', detail: 'SQL predicate', boost: 32 },
  { label: 'ASC', detail: 'sort order', boost: 35 },
  { label: 'DESC', detail: 'sort order', boost: 36 },
  { label: 'COUNT(*)', detail: 'aggregate', boost: 38 },
  { label: 'SUM()', detail: 'aggregate', boost: 34 },
  { label: 'AVG()', detail: 'aggregate', boost: 34 },
  { label: 'MIN()', detail: 'aggregate', boost: 34 },
  { label: 'MAX()', detail: 'aggregate', boost: 34 },
  { label: 'COALESCE()', detail: 'scalar fn', boost: 32 },
]

const PANEL_REDIS_COMPLETIONS = [
  { label: 'SCAN 0 MATCH * COUNT 50', detail: 'cursor scan', boost: 95 },
  { label: 'GET', detail: 'string read', boost: 90 },
  { label: 'SET', detail: 'string write', boost: 85 },
  { label: 'HGETALL', detail: 'hash read', boost: 88 },
  { label: 'HGET', detail: 'hash field', boost: 84 },
  { label: 'HSET', detail: 'hash write', boost: 82 },
  { label: 'LRANGE', detail: 'list read', boost: 84 },
  { label: 'LPUSH', detail: 'list write', boost: 80 },
  { label: 'SMEMBERS', detail: 'set read', boost: 84 },
  { label: 'SADD', detail: 'set write', boost: 80 },
  { label: 'ZRANGE', detail: 'zset read', boost: 84 },
  { label: 'TTL', detail: 'key expiry', boost: 82 },
  { label: 'TYPE', detail: 'key type', boost: 82 },
  { label: 'DEL', detail: 'key delete', boost: 75 },
  { label: 'KEYS *', detail: 'key pattern', boost: 78 },
  { label: 'INFO', detail: 'server info', boost: 76 },
  { label: 'DBSIZE', detail: 'key count', boost: 76 },
]

function matchesCompletionWord(candidate, lowerWord) {
  if (!lowerWord) return { ok: true, starts: true }
  const lc = candidate.toLowerCase()
  if (lc.startsWith(lowerWord)) return { ok: true, starts: true }
  if (lc.includes(lowerWord)) return { ok: true, starts: false }
  return { ok: false, starts: false }
}

/**
 * Computes schema-aware SQL/Redis completion candidates for the Side Panel editor.
 */
export function computePanelSqlCompletions(
  docText,
  pos,
  dialect = 'sqlite',
  schema = {},
  defaultTable,
  explicit = false
) {
  const safeText = String(docText || '')
  const safePos = Math.max(0, Math.min(pos, safeText.length))
  const before = safeText.slice(0, safePos)
  const safeSchema = schema && typeof schema === 'object' ? schema : {}

  // Dot-qualified completion: `tableOrAlias.colPrefix` or `schema.tablePrefix`
  const dotMatch = /([A-Za-z0-9_"`[\]]+)\.([A-Za-z0-9_]*)$/.exec(before)
  if (dotMatch) {
    const rawQualifier = dotMatch[1].replace(/^["`[]|["`\]]$/g, '')
    const prefix = dotMatch[2]
    const from = safePos - prefix.length
    const stmtText = findStatementAtCaret(safeText, safePos, dialect) || safeText

    let resolvedTable = Object.keys(safeSchema).find(
      (t) => t.toLowerCase() === rawQualifier.toLowerCase()
    )
    if (!resolvedTable) {
      const aliasRegex =
        /\b(?:FROM|JOIN|UPDATE|INTO)\s+(?:["`[]?[A-Za-z0-9_]+["`\]]?\.)?["`[]?([A-Za-z0-9_]+)["`\]]?(?:\s+AS)?\s+["`[]?([A-Za-z0-9_]+)["`\]]?/gi
      let m
      while ((m = aliasRegex.exec(stmtText)) !== null) {
        const rawTbl = m[1]
        const rawAlias = m[2]
        if (rawTbl && rawAlias && rawAlias.toLowerCase() === rawQualifier.toLowerCase()) {
          const found = Object.keys(safeSchema).find((t) => t.toLowerCase() === rawTbl.toLowerCase())
          if (found) {
            resolvedTable = found
            break
          }
        }
      }
    }

    if (resolvedTable && Array.isArray(safeSchema[resolvedTable])) {
      const lowerPrefix = prefix.toLowerCase()
      const options = safeSchema[resolvedTable]
        .filter((col) => !lowerPrefix || col.toLowerCase().includes(lowerPrefix))
        .map((col) => ({
          label: col,
          type: 'property',
          detail: `${resolvedTable} col`,
          boost: col.toLowerCase().startsWith(lowerPrefix) ? 99 : 88,
        }))
      if (options.length > 0) {
        return { from, options }
      }
    }

    const schemaPrefix = `${rawQualifier.toLowerCase()}.`
    const schemaTables = Object.keys(safeSchema).filter((k) =>
      k.toLowerCase().startsWith(schemaPrefix)
    )
    if (schemaTables.length > 0) {
      const lowerPrefix = prefix.toLowerCase()
      const options = []
      for (const fullKey of schemaTables) {
        const bareName = fullKey.slice(schemaPrefix.length)
        if (!lowerPrefix || bareName.toLowerCase().includes(lowerPrefix)) {
          options.push({
            label: bareName,
            type: 'class',
            detail: `${rawQualifier} table`,
            boost: bareName.toLowerCase().startsWith(lowerPrefix) ? 96 : 84,
          })
        }
      }
      if (options.length > 0) {
        return { from, options }
      }
    }
  }

  const wordMatch = /[A-Za-z0-9_]*$/.exec(before)
  const word = wordMatch ? wordMatch[0] : ''
  const from = safePos - word.length
  const lowerWord = word.toLowerCase()

  if (dialect === 'redis') {
    if (!word && !explicit) return null
    const options = PANEL_REDIS_COMPLETIONS.filter(
      (item) => !lowerWord || item.label.toLowerCase().includes(lowerWord)
    ).map((item) => ({
      label: item.label,
      type: 'keyword',
      detail: item.detail,
      boost: item.boost,
    }))
    return options.length > 0 ? { from, options } : null
  }

  const textBeforeWord = before.slice(0, from).trimEnd()
  const prevTokenMatch = /([A-Za-z0-9_]+)\s*$/.exec(textBeforeWord)
  const prevToken = prevTokenMatch ? prevTokenMatch[1].toUpperCase() : ''

  const isTableContext =
    prevToken === 'FROM' ||
    prevToken === 'JOIN' ||
    prevToken === 'UPDATE' ||
    prevToken === 'INTO' ||
    prevToken === 'TABLE' ||
    prevToken === 'DESCRIBE'

  if (!word && !isTableContext && !explicit) {
    return null
  }

  const stmtText = findStatementAtCaret(safeText, safePos, dialect) || safeText
  const referencedTables = new Set()
  const tableRefRegex =
    /\b(?:FROM|JOIN|UPDATE|INTO)\s+(?:["`[]?[A-Za-z0-9_]+["`\]]?\.)?["`[]?([A-Za-z0-9_]+)["`\]]?/gi
  let refMatch
  while ((refMatch = tableRefRegex.exec(stmtText)) !== null) {
    const rawRef = refMatch[1]
    if (rawRef) {
      const matchedName = Object.keys(safeSchema).find(
        (t) => t.toLowerCase() === rawRef.toLowerCase()
      )
      if (matchedName) referencedTables.add(matchedName)
    }
  }
  if (referencedTables.size === 0 && defaultTable && safeSchema[defaultTable]) {
    referencedTables.add(defaultTable)
  }

  const options = []
  const seenLabels = new Set()

  for (const tableName of Object.keys(safeSchema)) {
    const tblKey = `tbl:${tableName.toLowerCase()}`
    if (seenLabels.has(tblKey)) continue
    const m = matchesCompletionWord(tableName, lowerWord)
    if (!m.ok) continue
    const colCount = Array.isArray(safeSchema[tableName]) ? safeSchema[tableName].length : 0
    const baseBoost = isTableContext ? 98 : 68
    options.push({
      label: tableName,
      type: 'class',
      detail: colCount > 0 ? `table (${colCount} cols)` : 'table',
      boost: m.starts ? baseBoost : baseBoost - 12,
    })
    seenLabels.add(tblKey)
  }

  if (!isTableContext) {
    const orderedTables = [
      ...Array.from(referencedTables),
      ...Object.keys(safeSchema).filter((t) => !referencedTables.has(t)),
    ]
    for (const tableName of orderedTables) {
      const cols = safeSchema[tableName] || []
      const isPrimaryTable = referencedTables.has(tableName)
      for (const col of cols) {
        const m = matchesCompletionWord(col, lowerWord)
        if (!m.ok) continue
        const colKey = `col:${col.toLowerCase()}`
        if (!seenLabels.has(colKey)) {
          seenLabels.add(colKey)
          const baseBoost = isPrimaryTable ? 94 : 62
          options.push({
            label: col,
            type: 'property',
            detail: isPrimaryTable ? `${tableName} col` : `col (${tableName})`,
            boost: m.starts ? baseBoost : baseBoost - 10,
          })
        }
      }
    }
  }

  if (!isTableContext && (lowerWord.length > 0 || explicit)) {
    const isLowerInput =
      word.length > 0 && word === word.toLowerCase() && word !== word.toUpperCase()
    for (const kw of PANEL_SQL_KEYWORD_COMPLETIONS) {
      const m = matchesCompletionWord(kw.label, lowerWord)
      if (!m.ok) continue
      const isFunc = kw.detail === 'aggregate' || kw.detail === 'scalar fn'
      const applyText = isLowerInput && !isFunc ? kw.label.toLowerCase() : kw.label
      options.push({
        label: kw.label,
        apply: applyText,
        type: isFunc ? 'function' : 'keyword',
        detail: kw.detail,
        boost: m.starts ? kw.boost : kw.boost - 12,
      })
    }
  }

  return options.length > 0 ? { from, options } : null
}

/**
 * Encodes (schema, tableName) pair for the Side Panel grouped table dropdown.
 */
export function encodePanelTableSelectValue(schema, name) {
  return JSON.stringify([typeof schema === 'string' ? schema : '', String(name || '')])
}

export const PANEL_SQL_EDITOR_MIN_HEIGHT = 92
export const PANEL_SQL_EDITOR_DEFAULT_HEIGHT = 132
export const PANEL_SQL_EDITOR_HARD_MAX_HEIGHT = 520
export const PANEL_SQL_EDITOR_MIN_RESULTS_RESERVE = 180

/**
 * Computes safe vertical height bounds for the Side Panel SQL editor given `#tabSql` height.
 */
export function computePanelSqlEditorBounds(containerHeight = 0) {
  const avail = Number(containerHeight)
  const dynamicMax =
    Number.isFinite(avail) && avail > 0
      ? Math.min(
          PANEL_SQL_EDITOR_HARD_MAX_HEIGHT,
          Math.floor(Math.min(avail * 0.62, avail - PANEL_SQL_EDITOR_MIN_RESULTS_RESERVE))
        )
      : 380
  return {
    min: PANEL_SQL_EDITOR_MIN_HEIGHT,
    max: Math.max(PANEL_SQL_EDITOR_MIN_HEIGHT + 40, dynamicMax),
  }
}

/**
 * Clamps a requested Side Panel SQL editor height in pixels to safe container bounds.
 */
export function clampPanelSqlEditorHeight(desiredPx, containerHeight = 0) {
  const bounds = computePanelSqlEditorBounds(containerHeight)
  const parsed = Number(desiredPx)
  const target = Number.isFinite(parsed)
    ? Math.round(parsed)
    : PANEL_SQL_EDITOR_DEFAULT_HEIGHT
  return Math.max(bounds.min, Math.min(bounds.max, target))
}

/**
 * Decodes a value produced by encodePanelTableSelectValue.
 */
export function decodePanelTableSelectValue(rawValue) {
  if (!rawValue || typeof rawValue !== 'string') return null
  try {
    const parsed = JSON.parse(rawValue)
    if (Array.isArray(parsed) && typeof parsed[1] === 'string' && parsed[1]) {
      return {
        schema: typeof parsed[0] === 'string' && parsed[0] ? parsed[0] : undefined,
        name: parsed[1],
      }
    }
  } catch {}
  return null
}
