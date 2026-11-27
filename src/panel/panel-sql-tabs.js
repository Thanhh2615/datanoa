// src/panel/panel-sql-tabs.js
// Side Panel SQL Console tab state manager, schema-aware SQL/Redis completion engine,
// and grouped schema-table dropdown value helpers.

import { findStatementAtCaret } from './panel-core.js'
import { isSqlClauseColumnContext } from '../shared-sql-core.js'

const MAX_PANEL_CONSOLE_TABS = 20
const MAX_PANEL_CONSOLE_SQL_LEN = 50000
const MAX_INACTIVE_PANEL_RESULT_BYTES = 12_000_000

const SQL_ALIAS_KEYWORDS = new Set([
  'where',
  'join',
  'inner',
  'left',
  'right',
  'full',
  'cross',
  'outer',
  'natural',
  'on',
  'using',
  'set',
  'group',
  'order',
  'having',
  'limit',
  'offset',
  'fetch',
  'union',
  'except',
  'intersect',
  'values',
  'into',
  'select',
  'from',
  'and',
  'or',
  'when',
  'then',
  'else',
  'end',
  'returning',
  'for',
  'window',
  'qualify',
])

function estimatePanelResultBytes(result) {
  if (!result || typeof result !== 'object') return 0
  const sets = Array.isArray(result.resultSets) && result.resultSets.length > 0 ? result.resultSets : [result]
  let bytes = 0
  for (const rs of sets) {
    const rows = Array.isArray(rs?.rows) ? rs.rows : []
    if (rows.length === 0) continue
    const sample = Math.min(rows.length, 16)
    let sampleLen = 0
    for (let i = 0; i < sample; i++) {
      try {
        sampleLen += JSON.stringify(rows[i])?.length ?? 64
      } catch {
        sampleLen += 128
      }
    }
    bytes += Math.ceil((sampleLen / sample) * rows.length * 2)
  }
  return bytes
}

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

  let accessClock = 1

  function touchTab(tab) {
    if (tab) tab.lastAccessedAt = ++accessClock
  }

  function evictInactivePanelResultsIfNeeded(budgetBytes = MAX_INACTIVE_PANEL_RESULT_BYTES) {
    const inactive = tabs
      .filter((t) => t.id !== activeTabId && t.lastResult)
      .map((t) => ({ tab: t, bytes: estimatePanelResultBytes(t.lastResult) }))
      .filter((x) => x.bytes > 0)
    let total = inactive.reduce((acc, x) => acc + x.bytes, 0)
    if (total <= budgetBytes) return
    inactive.sort((a, b) => (a.tab.lastAccessedAt || 0) - (b.tab.lastAccessedAt || 0))
    for (const item of inactive) {
      if (total <= budgetBytes) break
      item.tab.lastResult = null
      item.tab.resultStates = {}
      total -= item.bytes
    }
  }

  function switchTab(tabId) {
    const found = tabs.find((t) => t.id === tabId)
    if (!found) return false
    activeTabId = tabId
    touchTab(found)
    evictInactivePanelResultsIfNeeded()
    return true
  }

  function addTab(initialSql = '', customTitle) {
    if (tabs.length >= MAX_PANEL_CONSOLE_TABS) {
      const oldestInactive = tabs
        .filter((t) => t.id !== activeTabId)
        .sort((a, b) => (a.lastAccessedAt || 0) - (b.lastAccessedAt || 0))[0]
      if (oldestInactive) {
        const idx = tabs.indexOf(oldestInactive)
        if (idx >= 0) tabs.splice(idx, 1)
      } else {
        return getActiveTab()
      }
    }
    const title = (customTitle && customTitle.trim()) || generateNextTitle()
    const newTab = buildEmptyTab(generatePanelTabId(), title, initialSql)
    touchTab(newTab)
    tabs.push(newTab)
    activeTabId = newTab.id
    evictInactivePanelResultsIfNeeded()
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
    touchTab(tab)
    evictInactivePanelResultsIfNeeded()
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

const PANEL_MSSQL_COMPLETIONS = [
  { label: 'TOP 100', detail: 'T-SQL limit', boost: 46 },
  { label: 'OFFSET 0 ROWS FETCH NEXT 50 ROWS ONLY', detail: 'T-SQL paging', boost: 40 },
  { label: 'WITH (NOLOCK)', detail: 'T-SQL hint', boost: 34 },
  { label: 'CROSS APPLY', detail: 'T-SQL join', boost: 36 },
  { label: 'GETDATE()', detail: 'scalar fn', boost: 38 },
  { label: 'SYSDATETIME()', detail: 'scalar fn', boost: 34 },
  { label: 'NEWID()', detail: 'scalar fn', boost: 34 },
  { label: 'ISNULL()', detail: 'scalar fn', boost: 38 },
  { label: 'TRY_CAST()', detail: 'scalar fn', boost: 34 },
  { label: 'STRING_AGG()', detail: 'aggregate', boost: 34 },
]

const PANEL_ORACLE_COMPLETIONS = [
  { label: 'FETCH FIRST 100 ROWS ONLY', detail: 'Oracle paging', boost: 44 },
  { label: 'DUAL', detail: 'Oracle table', boost: 40 },
  { label: 'ROWNUM', detail: 'Oracle pseudo', boost: 38 },
  { label: 'CONNECT BY PRIOR', detail: 'Oracle tree', boost: 34 },
  { label: 'SYSDATE', detail: 'Oracle date', boost: 40 },
  { label: 'SYSTIMESTAMP', detail: 'Oracle time', boost: 36 },
  { label: 'NVL()', detail: 'scalar fn', boost: 40 },
  { label: 'NVL2()', detail: 'scalar fn', boost: 36 },
  { label: 'DECODE()', detail: 'scalar fn', boost: 36 },
  { label: 'TO_DATE()', detail: 'scalar fn', boost: 36 },
  { label: 'TO_CHAR()', detail: 'scalar fn', boost: 36 },
  { label: 'LISTAGG()', detail: 'aggregate', boost: 34 },
  { label: 'EXPLAIN PLAN FOR', detail: 'Oracle plan', boost: 34 },
]

const PANEL_MONGO_COMPLETIONS = [
  { label: 'db.getCollection("")', type: 'function', detail: 'MQL collection', boost: 95 },
  { label: 'find({})', type: 'function', detail: 'MQL query', boost: 94 },
  { label: 'findOne({})', type: 'function', detail: 'MQL query', boost: 92 },
  { label: 'aggregate([])', type: 'function', detail: 'MQL pipeline', boost: 93 },
  { label: 'countDocuments({})', type: 'function', detail: 'MQL count', boost: 90 },
  { label: 'distinct("")', type: 'function', detail: 'MQL distinct', boost: 86 },
  { label: 'insertOne({})', type: 'function', detail: 'MQL write', boost: 85 },
  { label: 'updateOne({}, { $set: {} })', type: 'function', detail: 'MQL write', boost: 85 },
  { label: 'deleteOne({})', type: 'function', detail: 'MQL delete', boost: 84 },
  { label: 'explain("queryPlanner")', type: 'function', detail: 'MQL explain', boost: 86 },
  { label: '$match', type: 'keyword', detail: 'MQL stage', boost: 92 },
  { label: '$group', type: 'keyword', detail: 'MQL stage', boost: 91 },
  { label: '$project', type: 'keyword', detail: 'MQL stage', boost: 90 },
  { label: '$lookup', type: 'keyword', detail: 'MQL stage', boost: 89 },
  { label: '$unwind', type: 'keyword', detail: 'MQL stage', boost: 88 },
  { label: '$sort', type: 'keyword', detail: 'MQL stage', boost: 88 },
  { label: '$limit', type: 'keyword', detail: 'MQL stage', boost: 87 },
  { label: '$set', type: 'keyword', detail: 'MQL operator', boost: 88 },
  { label: '$eq', type: 'keyword', detail: 'MQL operator', boost: 86 },
  { label: '$gt', type: 'keyword', detail: 'MQL operator', boost: 86 },
  { label: '$in', type: 'keyword', detail: 'MQL operator', boost: 86 },
  { label: '$and', type: 'keyword', detail: 'MQL operator', boost: 85 },
  { label: '$or', type: 'keyword', detail: 'MQL operator', boost: 85 },
  { label: 'ObjectId()', type: 'function', detail: 'BSON helper', boost: 89 },
  { label: 'ISODate()', type: 'function', detail: 'BSON helper', boost: 88 },
]

function computePanelMongoCompletions(before, safePos, safeSchema, explicit) {
  const dbDotMatch = /\bdb\.([A-Za-z0-9_$-]*)$/.exec(before)
  if (dbDotMatch) {
    const prefix = dbDotMatch[1].toLowerCase()
    const from = safePos - dbDotMatch[1].length
    const options = []
    if (!prefix || 'getcollection'.includes(prefix)) {
      options.push({
        label: 'getCollection',
        apply: 'getCollection("")',
        type: 'function',
        detail: 'MongoDB collection',
        boost: 99,
      })
    }
    for (const colName of Object.keys(safeSchema)) {
      const m = matchesCompletionWord(colName, prefix)
      if (m.ok) {
        options.push({
          label: colName,
          type: 'class',
          detail: 'collection',
          boost: m.starts ? 95 : 84,
        })
      }
    }
    return options.length > 0 ? { from, options } : null
  }

  const colMethodMatch =
    /\bdb\.(?:getCollection\(\s*["'][^"']+["']\s*\)|[A-Za-z_][A-Za-z0-9_$-]*)\.([A-Za-z0-9_]*)$/.exec(
      before
    )
  if (colMethodMatch) {
    const prefix = colMethodMatch[1].toLowerCase()
    const from = safePos - colMethodMatch[1].length
    const options = PANEL_MONGO_COMPLETIONS.filter(
      (item) =>
        item.type === 'function' &&
        !item.label.startsWith('db.') &&
        !item.label.startsWith('ObjectId') &&
        !item.label.startsWith('ISODate') &&
        matchesCompletionWord(item.label, prefix).ok
    )
    return options.length > 0 ? { from, options } : null
  }

  const wordMatch = /\$?[A-Za-z0-9_]*$/.exec(before)
  const word = wordMatch ? wordMatch[0] : ''
  const lowerWord = word.toLowerCase()
  const from = safePos - word.length
  if (!word && !explicit) return null

  const options = []
  const seen = new Set()
  for (const colName of Object.keys(safeSchema)) {
    const m = matchesCompletionWord(colName, lowerWord)
    if (m.ok) {
      seen.add(colName)
      options.push({
        label: colName,
        type: 'class',
        detail: 'collection',
        boost: m.starts ? 94 : 80,
      })
    }
    for (const field of safeSchema[colName] || []) {
      if (seen.has(field)) continue
      const fm = matchesCompletionWord(field, lowerWord)
      if (fm.ok) {
        seen.add(field)
        options.push({
          label: field,
          type: 'property',
          detail: `${colName} field`,
          boost: fm.starts ? 88 : 74,
        })
      }
    }
  }
  for (const item of PANEL_MONGO_COMPLETIONS) {
    const m = matchesCompletionWord(item.label, lowerWord)
    if (m.ok) {
      options.push({
        ...item,
        boost: m.starts ? item.boost : item.boost - 10,
      })
    }
  }
  return options.length > 0 ? { from, options } : null
}

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

  if (dialect === 'mongodb') {
    return computePanelMongoCompletions(before, safePos, safeSchema, explicit)
  }

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
        if (
          rawTbl &&
          rawAlias &&
          !SQL_ALIAS_KEYWORDS.has(rawAlias.toLowerCase()) &&
          rawAlias.toLowerCase() === rawQualifier.toLowerCase()
        ) {
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

  const hasSchemaColumns = Object.values(safeSchema).some(
    (cols) => Array.isArray(cols) && cols.length > 0
  )
  const isClauseColContext =
    !word &&
    !isTableContext &&
    !explicit &&
    hasSchemaColumns &&
    isSqlClauseColumnContext(before, dialect)

  if (!word && !isTableContext && !isClauseColContext && !explicit) {
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

  if (dialect === 'oracle' && !seenLabels.has('tbl:dual')) {
    const dualMatch = matchesCompletionWord('DUAL', lowerWord)
    if (dualMatch.ok) {
      const baseBoost = isTableContext ? 95 : 64
      options.push({
        label: 'DUAL',
        type: 'class',
        detail: 'Oracle table',
        boost: dualMatch.starts ? baseBoost : baseBoost - 12,
      })
      seenLabels.add('tbl:dual')
    }
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
    const dialectExtras =
      dialect === 'mssql'
        ? PANEL_MSSQL_COMPLETIONS
        : dialect === 'oracle'
          ? PANEL_ORACLE_COMPLETIONS
          : []
    for (const kw of [...PANEL_SQL_KEYWORD_COMPLETIONS, ...dialectExtras]) {
      const m = matchesCompletionWord(kw.label, lowerWord)
      if (!m.ok) continue
      const isFunc = kw.detail === 'aggregate' || kw.detail === 'scalar fn'
      const applyText = isLowerInput && !isFunc ? kw.label.toLowerCase() : kw.label
      options.push({
        label: kw.label,
        apply: applyText,
        type: isFunc ? 'function' : kw.detail === 'Oracle table' ? 'class' : 'keyword',
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
