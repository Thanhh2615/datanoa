// src/shared-table-display.js
// Pure TableDisplayState normalization, duplicate column keys, 2/3 pinned viewport cap,
// 3-way multi-tab layout rebase, sensitive filter/rule scrubbing, and Conditional Highlighting engine.

import { clampWrapMaxLines } from './shared-row-height-index.js'
import { containsSensitiveSqlText, scrubSensitiveText } from './shared-sql-safety.js'

export const MAX_HIGHLIGHT_RULES_PER_TABLE = 20
export const MAX_REGEX_SUBJECT_CHARS = 10_000
export const MAX_REGEX_PATTERN_CHARS = 512
export const PINNED_VIEWPORT_MAX_RATIO = 2 / 3
export const MIN_COLUMN_WIDTH_PX = 48
export const MAX_COLUMN_WIDTH_PX = 2000
export const DEFAULT_PINNED_COLUMN_WIDTH_PX = 140
export const DEFAULT_ROW_NUM_WIDTH_PX = 44

export const HIGHLIGHT_TONES = Object.freeze(['info', 'ok', 'warn', 'danger', 'accent'])

export const HIGHLIGHT_CSS_CLASSES = Object.freeze({
  info: 'datanoa-hl-info',
  ok: 'datanoa-hl-ok',
  warn: 'datanoa-hl-warn',
  danger: 'datanoa-hl-danger',
  accent: 'datanoa-hl-accent',
})

export const CONDITIONAL_HIGHLIGHT_OPERATORS = Object.freeze([
  'eq',
  'neq',
  'contains',
  'not_contains',
  'starts_with',
  'ends_with',
  'like',
  'not_like',
  'ilike',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'in',
  'not_in',
  'is_null',
  'is_not_null',
  'regex',
])

const OPERATOR_SET = new Set(CONDITIONAL_HIGHLIGHT_OPERATORS)
const TONE_SET = new Set(HIGHLIGHT_TONES)
const OCCURRENCE_KEY_RE = /^([1-9]\d*)#(.*)$/
const BLOB_SENTINEL_RE = /^\[BLOB\s+\d+\s*B\]$/i
const EXACT_DECIMAL_RE = /^\s*([+-])?(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?\s*$/
const LEADING_ZERO_INT_RE = /^[+-]?0\d+$/
const SENSITIVE_COLUMN_NAME_RE =
  /(?:^|[-_])(?:pass(?:word|wd|phrase)?|pwd|secret|token|api[-_]?key|apikey|auth[-_]?token|private[-_]?key|credentials?|jwt|bearer|signing[-_]?key)$/i

// ---------------------------------------------------------------------------
// 1. Occurrence-indexed duplicate column keys ("${occurrence}#${name}")
// ---------------------------------------------------------------------------

/**
 * Maps an array of raw column headers to occurrence-indexed keys ("1#id", "2#id", ...).
 */
export function buildOccurrenceColumnKeys(headers) {
  if (!Array.isArray(headers) || headers.length === 0) return []
  const counts = new Map()
  const out = new Array(headers.length)
  for (let i = 0; i < headers.length; i++) {
    const name = String(headers[i] ?? '')
    const occ = (counts.get(name) ?? 0) + 1
    counts.set(name, occ)
    out[i] = `${occ}#${name}`
  }
  return out
}

/**
 * Parses an occurrence-indexed column key ("2#id" -> { occurrence: 2, name: 'id' }),
 * returning null for legacy bare column names.
 */
export function parseOccurrenceColumnKey(key) {
  if (typeof key !== 'string') return null
  const m = OCCURRENCE_KEY_RE.exec(key)
  if (!m) return null
  return { occurrence: Number(m[1]), name: m[2] }
}

/**
 * Builds an O(C) reusable lookup index for occurrence-indexed and bare legacy column keys.
 */
export function buildColumnKeyResolver(headers) {
  const safeHeaders = Array.isArray(headers) ? headers : []
  const occKeys = buildOccurrenceColumnKeys(safeHeaders)
  const occKeySet = new Set(occKeys)
  const indexByKey = new Map()
  const canonicalByKey = new Map()
  const nameCounts = new Map()
  for (let i = 0; i < occKeys.length; i++) {
    const occKey = occKeys[i]
    indexByKey.set(occKey, i)
    canonicalByKey.set(occKey, occKey)
  }
  for (let i = 0; i < safeHeaders.length; i++) {
    const name = String(safeHeaders[i] ?? '')
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1)
    if (!indexByKey.has(name)) {
      indexByKey.set(name, i)
      canonicalByKey.set(name, occKeys[i])
    }
  }
  return {
    occKeys,
    occKeySet,
    indexByKey,
    canonicalByKey,
    nameCounts,
    resolveKey(rawKey) {
      if (typeof rawKey !== 'string' || !rawKey) return null
      return canonicalByKey.get(rawKey) ?? null
    },
    resolveIndex(rawKey) {
      if (typeof rawKey !== 'string' || !rawKey) return -1
      const idx = indexByKey.get(rawKey)
      return idx === undefined ? -1 : idx
    },
  }
}

/**
 * Resolves a stored column key (occurrence-indexed or legacy bare name) to the canonical
 * occurrence key present in `headers`, or null when absent.
 */
export function resolveColumnKey(headers, rawKey) {
  if (!Array.isArray(headers) || headers.length === 0 || typeof rawKey !== 'string' || !rawKey) {
    return null
  }
  const keys = buildOccurrenceColumnKeys(headers)
  if (keys.includes(rawKey)) return rawKey
  const firstKey = `1#${rawKey}`
  return keys.includes(firstKey) ? firstKey : null
}

/**
 * Resolves a column key (occurrence-indexed or legacy bare name) to its 0-based index in `headers`.
 */
export function resolveColumnIndexByKey(headers, rawKey) {
  if (!Array.isArray(headers) || headers.length === 0 || typeof rawKey !== 'string' || !rawKey) {
    return -1
  }
  const keys = buildOccurrenceColumnKeys(headers)
  const exactIdx = keys.indexOf(rawKey)
  if (exactIdx >= 0) return exactIdx
  return keys.indexOf(`1#${rawKey}`)
}

// ---------------------------------------------------------------------------
// 2. Sensitive filter/rule scrubbing & entry normalization
// ---------------------------------------------------------------------------

/**
 * Returns true when a column name likely holds credentials or tokens.
 */
export function isSensitiveHighlightColumnName(columnKey) {
  if (typeof columnKey !== 'string' || !columnKey) return false
  const parsed = parseOccurrenceColumnKey(columnKey)
  const bare = (parsed ? parsed.name : columnKey).trim()
  if (!bare) return false
  return SENSITIVE_COLUMN_NAME_RE.test(bare)
}

/**
 * Scrubs persisted table filter / WHERE clause strings before saving to storage.
 * Clears clauses containing credential literals, URIs with passwords, or Redis auth tokens.
 */
export function scrubSensitiveTableFilterText(raw) {
  if (typeof raw !== 'string') return ''
  if (!raw.trim()) return ''
  if (containsSensitiveSqlText(raw)) return ''
  return scrubSensitiveText(raw, { stripOpaqueFragment: true })
}

function hasSensitiveRuleLiteral(rule) {
  const candidates = []
  if (typeof rule.value === 'string' && rule.value.trim()) candidates.push(rule.value)
  if (typeof rule.valueTo === 'string' && rule.valueTo.trim()) candidates.push(rule.valueTo)
  if (Array.isArray(rule.values)) {
    for (const v of rule.values) {
      if (typeof v === 'string' && v.trim()) candidates.push(v)
    }
  }
  if (candidates.length === 0) return false
  if (isSensitiveHighlightColumnName(rule.column)) return true
  return candidates.some((c) => containsSensitiveSqlText(c))
}

/**
 * Validates and normalizes a single ConditionalHighlightRule; returns null if invalid.
 */
export function sanitizeHighlightRule(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const id = typeof raw.id === 'string' ? raw.id.trim().slice(0, 80) : ''
  const column = typeof raw.column === 'string' ? raw.column.trim().slice(0, 260) : ''
  const operator = typeof raw.operator === 'string' ? raw.operator : ''
  const target = raw.target === 'row' || raw.target === 'cell' ? raw.target : null
  const tone = typeof raw.tone === 'string' && TONE_SET.has(raw.tone) ? raw.tone : null

  if (!id || !column || !OPERATOR_SET.has(operator) || !target || !tone) {
    return null
  }

  const out = {
    id,
    enabled: raw.enabled !== false,
    column,
    operator,
    target,
    tone,
  }
  if (typeof raw.value === 'string') out.value = raw.value.slice(0, 1024)
  if (typeof raw.valueTo === 'string') out.valueTo = raw.valueTo.slice(0, 1024)
  if (Array.isArray(raw.values)) {
    const cleanVals = []
    for (let i = 0; i < raw.values.length && cleanVals.length < 200; i++) {
      if (typeof raw.values[i] === 'string') {
        cleanVals.push(raw.values[i].slice(0, 512))
      }
    }
    out.values = cleanVals
  }
  if (typeof raw.caseSensitive === 'boolean') {
    out.caseSensitive = raw.caseSensitive
  }
  return out
}

function sanitizeStringList(list, maxLen = 500) {
  if (!Array.isArray(list) || list.length === 0) return []
  const seen = new Set()
  const out = []
  for (let i = 0; i < list.length && out.length < maxLen; i++) {
    const item = list[i]
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

/**
 * Keeps only valid user-adjusted column widths (finite positive px within [48, 2000]).
 */
export function sanitizeColumnWidths(rawWidths) {
  if (!rawWidths || typeof rawWidths !== 'object' || Array.isArray(rawWidths)) return {}
  const out = {}
  for (const [k, v] of Object.entries(rawWidths)) {
    const key = typeof k === 'string' ? k.trim() : ''
    if (!key) continue
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) continue
    const clamped = Math.round(Math.max(MIN_COLUMN_WIDTH_PX, Math.min(MAX_COLUMN_WIDTH_PX, v)))
    out[key] = clamped
  }
  return out
}

/**
 * Strips sensitive highlight rules (targeting credential columns with literals or carrying
 * sensitive tokens/URIs) before persisting a TableDisplayStateEntry.
 */
export function scrubSensitiveTableDisplayEntry(raw) {
  const normalized = normalizeTableDisplayStateEntry(raw)
  if (!normalized) return null
  if (!normalized.highlightRules || normalized.highlightRules.length === 0) {
    return normalized
  }
  const safeRules = normalized.highlightRules.filter((r) => !hasSensitiveRuleLiteral(r))
  return normalizeTableDisplayStateEntry({
    ...normalized,
    highlightRules: safeRules,
  })
}

/**
 * Normalizes a TableDisplayStateEntry and strips empty default entries (returning null
 * when no non-default display customization remains).
 */
export function normalizeTableDisplayStateEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null

  const columnOrder = sanitizeStringList(raw.columnOrder)
  const hiddenColumns = sanitizeStringList(raw.hiddenColumns)
  const pinnedColumns = sanitizeStringList(raw.pinnedColumns).filter(
    (k) => !hiddenColumns.includes(k)
  )
  const columnWidths = sanitizeColumnWidths(raw.columnWidths)
  const wrapCells = raw.wrapCells === true
  const hasExplicitMaxLines =
    typeof raw.wrapMaxLines === 'number' && Number.isFinite(raw.wrapMaxLines)
  const wrapMaxLines = hasExplicitMaxLines ? clampWrapMaxLines(raw.wrapMaxLines) : undefined

  const rawRules = Array.isArray(raw.highlightRules) ? raw.highlightRules : []
  const highlightRules = []
  const seenRuleIds = new Set()
  for (let i = 0; i < rawRules.length && highlightRules.length < MAX_HIGHLIGHT_RULES_PER_TABLE; i++) {
    const clean = sanitizeHighlightRule(rawRules[i])
    if (!clean || seenRuleIds.has(clean.id)) continue
    seenRuleIds.add(clean.id)
    highlightRules.push(clean)
  }

  const hasWidthOverrides = Object.keys(columnWidths).length > 0
  const hasNonDefaultWrap = wrapCells || (wrapMaxLines !== undefined && wrapMaxLines !== 4)
  if (
    columnOrder.length === 0 &&
    hiddenColumns.length === 0 &&
    pinnedColumns.length === 0 &&
    !hasWidthOverrides &&
    !hasNonDefaultWrap &&
    highlightRules.length === 0
  ) {
    return null
  }

  const out = {
    updatedAt:
      typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) && raw.updatedAt > 0
        ? Math.trunc(raw.updatedAt)
        : 0,
    revision:
      typeof raw.revision === 'number' && Number.isFinite(raw.revision) && raw.revision >= 0
        ? Math.trunc(raw.revision)
        : 0,
  }
  if (columnOrder.length > 0) out.columnOrder = columnOrder
  if (hiddenColumns.length > 0) out.hiddenColumns = hiddenColumns
  if (pinnedColumns.length > 0) out.pinnedColumns = pinnedColumns
  if (hasWidthOverrides) out.columnWidths = columnWidths
  if (wrapCells) out.wrapCells = true
  if (wrapMaxLines !== undefined && (wrapCells || wrapMaxLines !== 4)) {
    out.wrapMaxLines = wrapMaxLines
  }
  if (highlightRules.length > 0) out.highlightRules = highlightRules
  return out
}

export function isEmptyDefaultTableDisplayEntry(entry) {
  return normalizeTableDisplayStateEntry(entry) === null
}

// ---------------------------------------------------------------------------
// 3. 3-way multi-tab layout rebase
// ---------------------------------------------------------------------------

function stringArraysEqual(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function mergeThreeWaySetList(baseList, localList, remoteList) {
  const baseSet = new Set(baseList)
  const localSet = new Set(localList)
  const remoteSet = new Set(remoteList)

  const localAdded = localList.filter((k) => !baseSet.has(k))
  const localRemoved = new Set(baseList.filter((k) => !localSet.has(k)))

  const merged = []
  const seen = new Set()
  for (const k of remoteList) {
    if (localRemoved.has(k) || seen.has(k)) continue
    seen.add(k)
    merged.push(k)
  }
  for (const k of localAdded) {
    if (seen.has(k)) continue
    // If remote explicitly removed what base didn't have? Impossible since k not in base.
    if (!remoteSet.has(k) || !seen.has(k)) {
      seen.add(k)
      merged.push(k)
    }
  }
  return merged
}

function mergeThreeWayWidths(baseW, localW, remoteW) {
  const keys = new Set([...Object.keys(baseW), ...Object.keys(localW), ...Object.keys(remoteW)])
  const merged = {}
  for (const k of keys) {
    const bVal = baseW[k]
    const lVal = localW[k]
    const rVal = remoteW[k]
    if (lVal !== bVal) {
      if (lVal !== undefined) merged[k] = lVal
    } else if (rVal !== undefined) {
      merged[k] = rVal
    }
  }
  return merged
}

function widthsObjectsEqual(a, b) {
  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) return false
  for (let i = 0; i < keysA.length; i++) {
    const k = keysA[i]
    if (a[k] !== b[k]) return false
  }
  return true
}

function rulesEqual(a, b) {
  if (a === b) return true
  if (!a || !b) return false
  if (a.id !== b.id) return false
  if ((a.enabled !== false) !== (b.enabled !== false)) return false
  if (a.column !== b.column) return false
  if (a.operator !== b.operator) return false
  if (a.target !== b.target) return false
  if (a.tone !== b.tone) return false
  if ((a.value ?? undefined) !== (b.value ?? undefined)) return false
  if ((a.valueTo ?? undefined) !== (b.valueTo ?? undefined)) return false
  if (Boolean(a.caseSensitive) !== Boolean(b.caseSensitive)) return false
  return stringArraysEqual(
    Array.isArray(a.values) ? a.values : [],
    Array.isArray(b.values) ? b.values : []
  )
}

/**
 * Compares two highlight rule arrays structurally (order and fields).
 */
export function areHighlightRulesEqual(a, b) {
  const listA = Array.isArray(a) ? a : []
  const listB = Array.isArray(b) ? b : []
  if (listA.length !== listB.length) return false
  for (let i = 0; i < listA.length; i++) {
    if (!rulesEqual(listA[i], listB[i])) return false
  }
  return true
}

/**
 * Returns true when two TableDisplayStateEntry values normalize to the exact same
 * display configuration (ignoring volatile `updatedAt` and `revision` fields).
 */
export function areTableDisplayStateEntriesEquivalent(a, b) {
  const na = normalizeTableDisplayStateEntry(a)
  const nb = normalizeTableDisplayStateEntry(b)
  if (!na && !nb) return true
  if (!na || !nb) return false
  if (!stringArraysEqual(na.columnOrder ?? [], nb.columnOrder ?? [])) return false
  if (!stringArraysEqual(na.hiddenColumns ?? [], nb.hiddenColumns ?? [])) return false
  if (!stringArraysEqual(na.pinnedColumns ?? [], nb.pinnedColumns ?? [])) return false
  if (!widthsObjectsEqual(na.columnWidths ?? {}, nb.columnWidths ?? {})) return false
  if (Boolean(na.wrapCells) !== Boolean(nb.wrapCells)) return false
  if ((na.wrapMaxLines ?? 4) !== (nb.wrapMaxLines ?? 4)) return false
  return areHighlightRulesEqual(na.highlightRules ?? [], nb.highlightRules ?? [])
}

function mergeThreeWayRules(baseRules, localRules, remoteRules) {
  const baseMap = new Map(baseRules.map((r) => [r.id, r]))
  const localMap = new Map(localRules.map((r) => [r.id, r]))
  const remoteMap = new Map(remoteRules.map((r) => [r.id, r]))

  const merged = []
  const seen = new Set()
  for (const r of remoteRules) {
    const bRule = baseMap.get(r.id)
    const lRule = localMap.get(r.id)
    if (bRule && !lRule) {
      // Deleted locally
      continue
    }
    if (lRule && !rulesEqual(lRule, bRule)) {
      merged.push(lRule)
    } else {
      merged.push(r)
    }
    seen.add(r.id)
  }
  for (const l of localRules) {
    if (seen.has(l.id)) continue
    if (!baseMap.has(l.id) || remoteMap.has(l.id)) {
      merged.push(l)
      seen.add(l.id)
    }
  }
  return merged.slice(0, MAX_HIGHLIGHT_RULES_PER_TABLE)
}

/**
 * Performs a deterministic 3-way rebase between `baseEntry`, `localEntry`, and `remoteEntry`
 * so concurrent multi-tab edits on disjoint columns or display settings are preserved.
 */
export function rebaseTableDisplayStateEntry(baseEntry, localEntry, remoteEntry) {
  const b = normalizeTableDisplayStateEntry(baseEntry)
  const l = normalizeTableDisplayStateEntry(localEntry)
  const r = normalizeTableDisplayStateEntry(remoteEntry)

  if (!l && !r) return null
  if (!b) {
    // No common base: prefer local while merging disjoint widths/rules from remote
    if (!r) return l
    if (!l) return r
  }

  const baseOrder = b?.columnOrder ?? []
  const localOrder = l?.columnOrder ?? []
  const remoteOrder = r?.columnOrder ?? []
  const columnOrder = !stringArraysEqual(localOrder, baseOrder) ? localOrder : remoteOrder

  const hiddenColumns = mergeThreeWaySetList(
    b?.hiddenColumns ?? [],
    l?.hiddenColumns ?? [],
    r?.hiddenColumns ?? []
  )
  const hiddenSet = new Set(hiddenColumns)

  const pinnedColumns = mergeThreeWaySetList(
    b?.pinnedColumns ?? [],
    l?.pinnedColumns ?? [],
    r?.pinnedColumns ?? []
  ).filter((k) => !hiddenSet.has(k))

  const columnWidths = mergeThreeWayWidths(
    b?.columnWidths ?? {},
    l?.columnWidths ?? {},
    r?.columnWidths ?? {}
  )

  const baseWrap = b?.wrapCells === true
  const localWrap = l?.wrapCells === true
  const remoteWrap = r?.wrapCells === true
  const wrapCells = localWrap !== baseWrap ? localWrap : remoteWrap

  const baseMax = b?.wrapMaxLines ?? 4
  const localMax = l?.wrapMaxLines ?? 4
  const remoteMax = r?.wrapMaxLines ?? 4
  const wrapMaxLines = localMax !== baseMax ? localMax : remoteMax

  const highlightRules = mergeThreeWayRules(
    b?.highlightRules ?? [],
    l?.highlightRules ?? [],
    r?.highlightRules ?? []
  )

  const maxRevision = Math.max(b?.revision ?? 0, l?.revision ?? 0, r?.revision ?? 0)
  const maxUpdatedAt = Math.max(b?.updatedAt ?? 0, l?.updatedAt ?? 0, r?.updatedAt ?? 0)

  return normalizeTableDisplayStateEntry({
    columnOrder,
    hiddenColumns,
    pinnedColumns,
    columnWidths,
    wrapCells,
    wrapMaxLines,
    highlightRules,
    updatedAt: maxUpdatedAt,
    revision: maxRevision + 1,
  })
}

// ---------------------------------------------------------------------------
// 4. Column layout resolution, visibility guard & 2/3 pinned viewport cap
// ---------------------------------------------------------------------------

/**
 * Resolves effective column layout from raw headers and TableDisplayStateEntry.
 * Guarantees >= 1 visible column when `headers.length > 0` and isolates user width overrides.
 */
export function resolveEffectiveColumnLayout({ headers, entry, defaultWidthsByKey }) {
  const resolver = buildColumnKeyResolver(headers)
  const columnKeys = resolver.occKeys
  if (columnKeys.length === 0) {
    return {
      columnKeys: [],
      orderedKeys: [],
      visibleKeys: [],
      pinnedKeys: [],
      unpinnedKeys: [],
      displayKeys: [],
      hiddenSet: new Set(),
      widthsByKey: {},
    }
  }

  const keySet = resolver.occKeySet
  const normalized = normalizeTableDisplayStateEntry(entry)

  const orderedKeys = []
  const seenOrder = new Set()
  for (const rawKey of normalized?.columnOrder ?? []) {
    const resolved = resolver.resolveKey(rawKey)
    if (resolved && keySet.has(resolved) && !seenOrder.has(resolved)) {
      seenOrder.add(resolved)
      orderedKeys.push(resolved)
    }
  }
  for (const k of columnKeys) {
    if (!seenOrder.has(k)) {
      seenOrder.add(k)
      orderedKeys.push(k)
    }
  }

  const hiddenSet = new Set()
  for (const rawKey of normalized?.hiddenColumns ?? []) {
    const resolved = resolver.resolveKey(rawKey)
    if (resolved && keySet.has(resolved)) {
      hiddenSet.add(resolved)
    }
  }
  // Invariant: always >= 1 visible column
  if (hiddenSet.size >= orderedKeys.length) {
    hiddenSet.delete(orderedKeys[0])
  }

  const visibleKeys = orderedKeys.filter((k) => !hiddenSet.has(k))
  const visibleSet = new Set(visibleKeys)

  const pinnedKeys = []
  const pinnedSet = new Set()
  for (const rawKey of normalized?.pinnedColumns ?? []) {
    const resolved = resolver.resolveKey(rawKey)
    if (resolved && visibleSet.has(resolved) && !pinnedSet.has(resolved)) {
      pinnedSet.add(resolved)
      pinnedKeys.push(resolved)
    }
  }

  const unpinnedKeys = visibleKeys.filter((k) => !pinnedSet.has(k))
  const displayKeys = [...pinnedKeys, ...unpinnedKeys]

  const widthsByKey = {}
  const userWidths = normalized?.columnWidths ?? {}
  for (const k of columnKeys) {
    if (typeof userWidths[k] === 'number') {
      widthsByKey[k] = userWidths[k]
    } else if (defaultWidthsByKey && typeof defaultWidthsByKey[k] === 'number') {
      widthsByKey[k] = defaultWidthsByKey[k]
    }
  }

  return {
    columnKeys,
    orderedKeys,
    visibleKeys,
    pinnedKeys,
    unpinnedKeys,
    displayKeys,
    hiddenSet,
    widthsByKey,
  }
}

/**
 * Updates column visibility while enforcing the >= 1 visible column invariant.
 */
export function setColumnVisibilityInEntry(entry, columnKey, visible, headers) {
  const layout = resolveEffectiveColumnLayout({ headers, entry })
  const columnKeys = layout.columnKeys
  const resolver = buildColumnKeyResolver(headers)
  const resolved = resolver.resolveKey(columnKey)
  if (!resolved) {
    return { entry: normalizeTableDisplayStateEntry(entry), changed: false }
  }

  const nextHidden = new Set(layout.hiddenSet)
  let nextPinned = [...layout.pinnedKeys]

  if (!visible) {
    const remainingVisible = columnKeys.filter((k) => k !== resolved && !nextHidden.has(k))
    if (remainingVisible.length === 0) {
      return {
        entry: normalizeTableDisplayStateEntry(entry),
        changed: false,
        blockedReason: 'at_least_one_visible',
      }
    }
    if (nextHidden.has(resolved)) {
      return { entry: normalizeTableDisplayStateEntry(entry), changed: false }
    }
    nextHidden.add(resolved)
    nextPinned = nextPinned.filter((k) => k !== resolved)
  } else {
    if (!nextHidden.has(resolved)) {
      return { entry: normalizeTableDisplayStateEntry(entry), changed: false }
    }
    nextHidden.delete(resolved)
  }

  const prev = normalizeTableDisplayStateEntry(entry) ?? { updatedAt: 0, revision: 0 }
  const next = normalizeTableDisplayStateEntry({
    ...prev,
    hiddenColumns: Array.from(nextHidden),
    pinnedColumns: nextPinned,
  })
  return { entry: next, changed: true }
}

/**
 * Reorders `fromKey` before or after `toKey` within the table's column order.
 */
export function reorderColumnInEntry(entry, fromKey, toKey, placement, headers) {
  const resolver = buildColumnKeyResolver(headers)
  const src = resolver.resolveKey(fromKey)
  const dst = resolver.resolveKey(toKey)
  if (!src || !dst || src === dst || (placement !== 'before' && placement !== 'after')) {
    return normalizeTableDisplayStateEntry(entry)
  }
  const layout = resolveEffectiveColumnLayout({ headers, entry })
  const without = layout.orderedKeys.filter((k) => k !== src)
  const targetIdx = without.indexOf(dst)
  if (targetIdx < 0) return normalizeTableDisplayStateEntry(entry)
  const insertIdx = placement === 'before' ? targetIdx : targetIdx + 1
  without.splice(insertIdx, 0, src)

  const isDefaultOrder = stringArraysEqual(without, layout.columnKeys)
  const prev = normalizeTableDisplayStateEntry(entry) ?? { updatedAt: 0, revision: 0 }
  return normalizeTableDisplayStateEntry({
    ...prev,
    columnOrder: isDefaultOrder ? [] : without,
  })
}

/**
 * Sets or clears a user-adjusted width for a single column key (never stores auto-widths).
 */
export function setUserColumnWidthInEntry(entry, columnKey, widthPx) {
  const key = typeof columnKey === 'string' ? columnKey.trim() : ''
  if (!key) return normalizeTableDisplayStateEntry(entry)

  const prev = normalizeTableDisplayStateEntry(entry) ?? { updatedAt: 0, revision: 0 }
  const nextWidths = { ...(prev.columnWidths ?? {}) }
  if (typeof widthPx === 'number' && Number.isFinite(widthPx) && widthPx > 0) {
    nextWidths[key] = Math.round(Math.max(MIN_COLUMN_WIDTH_PX, Math.min(MAX_COLUMN_WIDTH_PX, widthPx)))
  } else {
    delete nextWidths[key]
  }
  return normalizeTableDisplayStateEntry({
    ...prev,
    columnWidths: nextWidths,
  })
}

/**
 * Caps sticky pinned columns at 2/3 of the viewport width and returns sticky left offsets.
 */
export function computePinnedColumnsViewportCap({
  pinnedKeys,
  widthsByKey = {},
  viewportWidthPx,
  rowNumWidthPx = DEFAULT_ROW_NUM_WIDTH_PX,
  defaultColWidthPx = DEFAULT_PINNED_COLUMN_WIDTH_PX,
  maxRatio = PINNED_VIEWPORT_MAX_RATIO,
}) {
  const safeViewport =
    typeof viewportWidthPx === 'number' && Number.isFinite(viewportWidthPx) && viewportWidthPx > 0
      ? viewportWidthPx
      : 0
  const safeRowNum =
    typeof rowNumWidthPx === 'number' && Number.isFinite(rowNumWidthPx) && rowNumWidthPx >= 0
      ? rowNumWidthPx
      : DEFAULT_ROW_NUM_WIDTH_PX
  const safeDefaultCol =
    typeof defaultColWidthPx === 'number' && Number.isFinite(defaultColWidthPx) && defaultColWidthPx > 0
      ? defaultColWidthPx
      : DEFAULT_PINNED_COLUMN_WIDTH_PX

  const maxPinnedWidthPx = Math.floor(safeViewport * maxRatio)
  const activePinnedKeys = []
  const overflowPinnedKeys = []
  const stickyLeftByKey = {}

  let usedWidthPx = safeRowNum
  const list = Array.isArray(pinnedKeys) ? pinnedKeys : []
  for (let i = 0; i < list.length; i++) {
    const key = list[i]
    if (typeof key !== 'string' || !key) continue
    const rawW = widthsByKey[key]
    const w = typeof rawW === 'number' && Number.isFinite(rawW) && rawW > 0 ? rawW : safeDefaultCol
    if (overflowPinnedKeys.length === 0 && usedWidthPx + w <= maxPinnedWidthPx) {
      stickyLeftByKey[key] = usedWidthPx
      usedWidthPx += w
      activePinnedKeys.push(key)
    } else {
      overflowPinnedKeys.push(key)
    }
  }

  return {
    maxPinnedWidthPx,
    activePinnedKeys,
    overflowPinnedKeys,
    stickyLeftByKey,
    totalPinnedWidthPx: usedWidthPx,
    capped: overflowPinnedKeys.length > 0,
  }
}

/**
 * Adjusts horizontal scrollLeft so an unpinned focused/edited cell is never hidden beneath
 * the sticky pinned column zone or clipped off the right edge of the viewport.
 */
export function computeScrollLeftForFocusedCell({
  cellLeftPx,
  cellWidthPx,
  scrollLeftPx,
  viewportWidthPx,
  totalPinnedWidthPx,
}) {
  const left = Number.isFinite(cellLeftPx) ? cellLeftPx : 0
  const width = Number.isFinite(cellWidthPx) && cellWidthPx > 0 ? cellWidthPx : 0
  const currentScroll = Number.isFinite(scrollLeftPx) && scrollLeftPx > 0 ? scrollLeftPx : 0
  const viewportW = Number.isFinite(viewportWidthPx) && viewportWidthPx > 0 ? viewportWidthPx : 0
  const pinnedW = Number.isFinite(totalPinnedWidthPx) && totalPinnedWidthPx > 0 ? totalPinnedWidthPx : 0

  if (left < currentScroll + pinnedW) {
    return Math.max(0, left - pinnedW)
  }
  const cellRight = left + width
  if (viewportW > 0 && cellRight > currentScroll + viewportW) {
    return Math.max(0, cellRight - viewportW)
  }
  return currentScroll
}

// ---------------------------------------------------------------------------
// 5. Conditional Highlighting: 4-state model, exact Decimal, O(M*N) LIKE, ReDoS guard
// ---------------------------------------------------------------------------

/**
 * Classifies a raw grid cell value into the 4-state model:
 * 'Unavailable' | 'Null' | 'NonText' | 'Text'.
 */
export function classifyCellValue(raw) {
  if (raw === undefined) {
    return { state: 'Unavailable', text: '' }
  }
  if (raw === null) {
    return { state: 'Null', text: '' }
  }
  if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) {
    return { state: 'NonText', text: '' }
  }
  if (typeof raw === 'object') {
    if (
      'type' in raw &&
      raw.type === 'Buffer' &&
      'data' in raw &&
      Array.isArray(raw.data)
    ) {
      return { state: 'NonText', text: '' }
    }
    if (raw instanceof Date) {
      return {
        state: 'Text',
        text: Number.isNaN(raw.getTime()) ? '' : raw.toISOString(),
      }
    }
    try {
      return { state: 'Text', text: JSON.stringify(raw) }
    } catch {
      return { state: 'Text', text: String(raw) }
    }
  }
  if (typeof raw === 'string') {
    if (BLOB_SENTINEL_RE.test(raw.trim())) {
      return { state: 'NonText', text: '' }
    }
    return { state: 'Text', text: raw }
  }
  return { state: 'Text', text: String(raw) }
}

function parseExactDecimal(input) {
  if (typeof input === 'bigint') {
    const s = input.toString()
    return parseExactDecimal(s)
  }
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null
    return parseExactDecimal(Object.is(input, -0) ? '0' : String(input))
  }
  if (typeof input !== 'string') return null

  const m = EXACT_DECIMAL_RE.exec(input)
  if (!m) return null

  const sign = m[1] === '-' ? -1 : 1
  const intPart = m[2] ?? ''
  const fracPart = m[3] ?? m[4] ?? ''
  const exp = m[5] ? Number.parseInt(m[5], 10) : 0
  if (!Number.isSafeInteger(exp)) return null

  const rawDigits = intPart + fracPart
  let firstNonZero = 0
  while (firstNonZero < rawDigits.length && rawDigits.charCodeAt(firstNonZero) === 48) {
    firstNonZero++
  }
  if (firstNonZero === rawDigits.length) {
    return { sign: 0, coeff: 0n, exp: 0, digitsLen: 1 }
  }

  let lastNonZero = rawDigits.length - 1
  while (lastNonZero > firstNonZero && rawDigits.charCodeAt(lastNonZero) === 48) {
    lastNonZero--
  }

  const trimmed = rawDigits.slice(firstNonZero, lastNonZero + 1)
  const trailingStripped = rawDigits.length - 1 - lastNonZero
  const adjExp = exp - fracPart.length + trailingStripped
  return {
    sign,
    coeff: BigInt(trimmed),
    exp: adjExp,
    digitsLen: trimmed.length,
  }
}

/**
 * Compares two numeric/BigInt/decimal-string values with arbitrary precision.
 * Returns -1, 0, or 1, or null if either value is not a finite decimal literal.
 */
export function compareExactDecimal(a, b) {
  const pa = parseExactDecimal(a)
  const pb = parseExactDecimal(b)
  if (!pa || !pb) return null
  if (pa.sign !== pb.sign) return pa.sign < pb.sign ? -1 : 1
  if (pa.sign === 0) return 0

  const orderA = pa.digitsLen + pa.exp
  const orderB = pb.digitsLen + pb.exp
  let cmpMag = 0
  if (orderA !== orderB) {
    cmpMag = orderA < orderB ? -1 : 1
  } else {
    const minExp = Math.min(pa.exp, pb.exp)
    const scaledA = pa.exp > minExp ? pa.coeff * 10n ** BigInt(pa.exp - minExp) : pa.coeff
    const scaledB = pb.exp > minExp ? pb.coeff * 10n ** BigInt(pb.exp - minExp) : pb.coeff
    cmpMag = scaledA < scaledB ? -1 : scaledA > scaledB ? 1 : 0
  }
  return pa.sign === -1 ? -cmpMag : cmpMag
}

function parseSqlLikePattern(pattern, caseSensitive) {
  const scalars = Array.from(caseSensitive ? pattern : pattern.toLowerCase())
  const tokens = []
  let i = 0
  while (i < scalars.length) {
    const ch = scalars[i]
    if (ch === '\\' && i + 1 < scalars.length) {
      tokens.push({ kind: 'lit', char: scalars[i + 1] })
      i += 2
      continue
    }
    if (ch === '%') {
      if (tokens.length === 0 || tokens[tokens.length - 1].kind !== 'wildcard') {
        tokens.push({ kind: 'wildcard' })
      }
      i++
      continue
    }
    if (ch === '_') {
      tokens.push({ kind: 'any1' })
      i++
      continue
    }
    tokens.push({ kind: 'lit', char: ch })
    i++
  }
  return tokens
}

/**
 * Evaluates SQL LIKE / ILIKE patterns using O(M*N) 1D Dynamic Programming (zero regex, zero ReDoS).
 * Operates on Unicode scalar code points and supports `%`, `_`, and backslash escapes (`\%`, `\_`, `\\`).
 */
export function matchSqlLike(subject, pattern, caseSensitive = true) {
  if (typeof subject !== 'string' || typeof pattern !== 'string') return false
  const textScalars = Array.from(caseSensitive ? subject : subject.toLowerCase())
  const tokens = parseSqlLikePattern(pattern, caseSensitive)
  const m = tokens.length

  let prev = new Uint8Array(m + 1)
  let curr = new Uint8Array(m + 1)
  prev[0] = 1
  for (let j = 1; j <= m; j++) {
    if (tokens[j - 1].kind === 'wildcard') {
      prev[j] = prev[j - 1]
    }
  }

  for (let i = 0; i < textScalars.length; i++) {
    const ch = textScalars[i]
    curr.fill(0)
    for (let j = 1; j <= m; j++) {
      const tok = tokens[j - 1]
      if (tok.kind === 'wildcard') {
        curr[j] = prev[j] | curr[j - 1]
      } else if (tok.kind === 'any1') {
        curr[j] = prev[j - 1]
      } else {
        curr[j] = prev[j - 1] && ch === tok.char ? 1 : 0
      }
    }
    const tmp = prev
    prev = curr
    curr = tmp
  }

  return prev[m] === 1
}

function parseBracedQuantifierEnd(pattern, startIdx) {
  let j = startIdx + 1
  while (j < pattern.length && pattern[j] >= '0' && pattern[j] <= '9') j++
  if (j === startIdx + 1) return null
  const minCount = Number.parseInt(pattern.slice(startIdx + 1, j), 10)
  let maxCount = minCount
  if (j < pattern.length && pattern[j] === ',') {
    j++
    const maxStart = j
    while (j < pattern.length && pattern[j] >= '0' && pattern[j] <= '9') j++
    maxCount = j === maxStart ? Number.POSITIVE_INFINITY : Number.parseInt(pattern.slice(maxStart, j), 10)
  }
  if (j >= pattern.length || pattern[j] !== '}') return null
  return {
    endIdx: j,
    minCount,
    maxCount,
    repeatable: maxCount > 1,
    isVariable: minCount !== maxCount,
  }
}

const REGEX_CHARSET_LEN = 129
const NON_ASCII_SLOT = 128

function createCharSet(fill = 0) {
  const s = new Uint8Array(REGEX_CHARSET_LEN)
  if (fill) s.fill(1)
  return s
}

function setCharCodeInSet(set, code, ignoreCase) {
  if (code < 0) return
  if (code >= 128) {
    set[NON_ASCII_SLOT] = 1
    return
  }
  set[code] = 1
  if (ignoreCase) {
    if (code >= 65 && code <= 90) set[code + 32] = 1
    else if (code >= 97 && code <= 122) set[code - 32] = 1
  }
}

function setCharRangeInSet(set, startCode, endCode, ignoreCase) {
  const lo = Math.max(0, startCode)
  const hi = Math.min(127, endCode)
  for (let c = lo; c <= hi; c++) {
    setCharCodeInSet(set, c, ignoreCase)
  }
  if (endCode >= 128) set[NON_ASCII_SLOT] = 1
}

function invertCharSet(src) {
  const out = new Uint8Array(REGEX_CHARSET_LEN)
  for (let i = 0; i < 128; i++) out[i] = src[i] ? 0 : 1
  out[NON_ASCII_SLOT] = 1
  return out
}

function makeDotCharSet(dotAll) {
  const s = createCharSet(1)
  if (!dotAll) {
    s[10] = 0
    s[13] = 0
  }
  return s
}

function makeSingleCharSet(ch, ignoreCase) {
  const s = createCharSet(0)
  setCharCodeInSet(s, ch.codePointAt(0) ?? 0, ignoreCase)
  return s
}

function makeEscapeCharSet(esc, ignoreCase) {
  const s = createCharSet(0)
  if (esc === 'd' || esc === 'D') {
    setCharRangeInSet(s, 48, 57, false)
    return esc === 'D' ? invertCharSet(s) : s
  }
  if (esc === 'w' || esc === 'W') {
    setCharRangeInSet(s, 48, 57, false)
    setCharRangeInSet(s, 65, 90, false)
    setCharRangeInSet(s, 97, 122, false)
    s[95] = 1
    return esc === 'W' ? invertCharSet(s) : s
  }
  if (esc === 's' || esc === 'S') {
    for (const c of [9, 10, 11, 12, 13, 32]) s[c] = 1
    s[NON_ASCII_SLOT] = 1
    return esc === 'S' ? invertCharSet(s) : s
  }
  if (esc === 'n') {
    s[10] = 1
    return s
  }
  if (esc === 'r') {
    s[13] = 1
    return s
  }
  if (esc === 't') {
    s[9] = 1
    return s
  }
  if (esc === 'f') {
    s[12] = 1
    return s
  }
  if (esc === 'v') {
    s[11] = 1
    return s
  }
  if (esc === '0') {
    s[0] = 1
    return s
  }
  setCharCodeInSet(s, esc.codePointAt(0) ?? 0, ignoreCase)
  return s
}

function parseCharClassCharSet(pattern, startIdx, ignoreCase) {
  let i = startIdx + 1
  let negated = false
  if (i < pattern.length && pattern[i] === '^') {
    negated = true
    i++
  }
  let s = createCharSet(0)
  let prevCode = null
  let pendingRange = false

  while (i < pattern.length) {
    const ch = pattern[i]
    if (ch === ']') {
      if (pendingRange && prevCode !== null) {
        setCharCodeInSet(s, prevCode, ignoreCase)
        setCharCodeInSet(s, 45, false)
      }
      if (negated) s = invertCharSet(s)
      return { endIdx: i, charSet: s }
    }
    if (ch === '\\' && i + 1 < pattern.length) {
      const next = pattern[i + 1]
      if (next === 'd' || next === 'D' || next === 'w' || next === 'W' || next === 's' || next === 'S') {
        const es = makeEscapeCharSet(next, ignoreCase)
        for (let k = 0; k < REGEX_CHARSET_LEN; k++) s[k] |= es[k]
        prevCode = null
        pendingRange = false
      } else {
        const code =
          next === 'n'
            ? 10
            : next === 'r'
              ? 13
              : next === 't'
                ? 9
                : next === 'f'
                  ? 12
                  : next === 'v'
                    ? 11
                    : next === '0'
                      ? 0
                      : (next.codePointAt(0) ?? 0)
        if (pendingRange && prevCode !== null && prevCode <= code) {
          setCharRangeInSet(s, prevCode, code, ignoreCase)
          prevCode = null
          pendingRange = false
        } else {
          setCharCodeInSet(s, code, ignoreCase)
          prevCode = code
        }
      }
      i += 2
      continue
    }
    if (ch === '-' && prevCode !== null && i + 1 < pattern.length && pattern[i + 1] !== ']') {
      pendingRange = true
      i++
      continue
    }
    const code = ch.codePointAt(0) ?? 0
    if (pendingRange && prevCode !== null && prevCode <= code) {
      setCharRangeInSet(s, prevCode, code, ignoreCase)
      prevCode = null
      pendingRange = false
    } else {
      setCharCodeInSet(s, code, ignoreCase)
      prevCode = code
    }
    i++
  }
  return null
}

function charSetsOverlap(a, b) {
  for (let i = 0; i < REGEX_CHARSET_LEN; i++) {
    if (a[i] && b[i]) return true
  }
  return false
}

function mergeCharSetsInto(dst, src) {
  for (let i = 0; i < REGEX_CHARSET_LEN; i++) {
    dst[i] |= src[i]
  }
}

/**
 * Statically validates user-provided highlight regex patterns against ReDoS hazards
 * (nested quantifiers, quantified alternations, chained quantifiers, adjacent/overlapping
 * variable quantifiers, backreferences, lookarounds).
 */
export function validateHighlightRegex(pattern, flags = '') {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    return { valid: false, reason: 'empty_pattern' }
  }
  if (pattern.length > MAX_REGEX_PATTERN_CHARS) {
    return { valid: false, reason: 'pattern_too_long' }
  }

  const ignoreCase = typeof flags === 'string' && flags.includes('i')
  const dotAll = typeof flags === 'string' && flags.includes('s')

  const makeFrame = () => ({
    hasQuantifier: false,
    hasAlternation: false,
    activeQs: [],
    branchSet: createCharSet(0),
    unionSet: createCharSet(0),
    lastAtom: null,
  })

  const commitPendingAtom = (frame) => {
    const atom = frame.lastAtom
    if (!atom) return
    frame.lastAtom = null
    if (!atom.charSet) return
    mergeCharSetsInto(frame.branchSet, atom.charSet)
    if (atom.minCount >= 1) {
      frame.activeQs = frame.activeQs.filter((q) => charSetsOverlap(q.charSet, atom.charSet))
    }
    if (atom.isVariableQuantified) {
      frame.activeQs.push({ charSet: atom.charSet })
    }
  }

  const stack = [makeFrame()]
  let prevAtomQuantified = false
  let prevAtomWasQuantifier = false
  let justClosedQuantifiable = false

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    const frame = stack[stack.length - 1]

    if (ch === '\\') {
      if (i + 1 >= pattern.length) {
        return { valid: false, reason: 'dangling_escape' }
      }
      const next = pattern[i + 1]
      if ((next >= '1' && next <= '9') || next === 'k') {
        return { valid: false, reason: 'backreference_disallowed' }
      }
      commitPendingAtom(frame)
      const isAssertion = next === 'b' || next === 'B'
      frame.lastAtom = isAssertion
        ? null
        : {
            charSet: makeEscapeCharSet(next, ignoreCase),
            minCount: 1,
            isVariableQuantified: false,
          }
      i++
      prevAtomWasQuantifier = false
      prevAtomQuantified = false
      justClosedQuantifiable = !isAssertion
      continue
    }

    if (ch === '[') {
      commitPendingAtom(frame)
      const parsedClass = parseCharClassCharSet(pattern, i, ignoreCase)
      if (!parsedClass) {
        return { valid: false, reason: 'unterminated_construct' }
      }
      frame.lastAtom = {
        charSet: parsedClass.charSet,
        minCount: 1,
        isVariableQuantified: false,
      }
      i = parsedClass.endIdx
      prevAtomWasQuantifier = false
      prevAtomQuantified = false
      justClosedQuantifiable = true
      continue
    }

    if (ch === '(') {
      commitPendingAtom(frame)
      stack.push(makeFrame())
      prevAtomWasQuantifier = false
      prevAtomQuantified = false
      justClosedQuantifiable = false
      if (pattern[i + 1] === '?') {
        const afterQ = pattern[i + 2]
        if (afterQ === '=' || afterQ === '!') {
          return { valid: false, reason: 'lookaround_disallowed' }
        }
        if (afterQ === '<') {
          if (pattern[i + 3] === '=' || pattern[i + 3] === '!') {
            return { valid: false, reason: 'lookaround_disallowed' }
          }
          const closeAngle = pattern.indexOf('>', i + 3)
          if (closeAngle < 0) {
            return { valid: false, reason: 'invalid_group_name' }
          }
          i = closeAngle
        } else if (afterQ === ':') {
          i += 2
        } else {
          return { valid: false, reason: 'unsupported_group_modifier' }
        }
      }
      continue
    }

    if (ch === ')') {
      if (stack.length <= 1) {
        return { valid: false, reason: 'unbalanced_parens' }
      }
      commitPendingAtom(frame)
      mergeCharSetsInto(frame.unionSet, frame.branchSet)
      const closed = stack.pop()
      const parent = stack[stack.length - 1]
      if (closed.hasQuantifier) parent.hasQuantifier = true

      // Check immediate quantifier following group
      let qRepeatable = false
      let qFound = false
      if (i + 1 < pattern.length) {
        const q = pattern[i + 1]
        if (q === '*' || q === '+') {
          qFound = true
          qRepeatable = true
        } else if (q === '?') {
          qFound = true
          qRepeatable = false
        } else if (q === '{') {
          const braced = parseBracedQuantifierEnd(pattern, i + 1)
          if (braced) {
            qFound = true
            qRepeatable = braced.repeatable
          }
        }
      }

      if (qFound && qRepeatable && (closed.hasQuantifier || closed.hasAlternation)) {
        return { valid: false, reason: 'nested_quantifier_redos' }
      }

      if (closed.hasQuantifier && !qFound) {
        for (const activeQ of parent.activeQs) {
          if (charSetsOverlap(activeQ.charSet, closed.unionSet)) {
            return { valid: false, reason: 'overlapping_quantifier_redos' }
          }
        }
      }

      parent.lastAtom = {
        charSet: closed.unionSet,
        minCount: 1,
        isVariableQuantified: closed.hasQuantifier && !qFound,
      }
      prevAtomQuantified = false
      prevAtomWasQuantifier = false
      justClosedQuantifiable = true
      continue
    }

    if (ch === '|') {
      commitPendingAtom(frame)
      mergeCharSetsInto(frame.unionSet, frame.branchSet)
      frame.branchSet = createCharSet(0)
      frame.activeQs = []
      frame.hasAlternation = true
      prevAtomQuantified = false
      prevAtomWasQuantifier = false
      justClosedQuantifiable = false
      continue
    }

    if (ch === '*' || ch === '+' || ch === '?' || ch === '{') {
      let endIdx = i
      let isQuantifier = true
      let repeatable = ch === '*' || ch === '+'
      let isVariable = ch === '*' || ch === '+' || ch === '?'
      let minCount = ch === '+' ? 1 : 0
      if (ch === '{') {
        const braced = parseBracedQuantifierEnd(pattern, i)
        if (!braced) {
          isQuantifier = false
        } else {
          endIdx = braced.endIdx
          repeatable = braced.repeatable
          isVariable = braced.isVariable
          minCount = braced.minCount
        }
      }

      if (isQuantifier) {
        if (ch === '?' && prevAtomWasQuantifier) {
          // Lazy modifier after quantifier (e.g. *?, +?)
          prevAtomWasQuantifier = false
          prevAtomQuantified = true
          justClosedQuantifiable = false
          continue
        }
        if (prevAtomQuantified || !justClosedQuantifiable) {
          return { valid: false, reason: 'chained_quantifier' }
        }
        if (isVariable && frame.lastAtom?.charSet) {
          for (const activeQ of frame.activeQs) {
            if (charSetsOverlap(activeQ.charSet, frame.lastAtom.charSet)) {
              return { valid: false, reason: 'overlapping_quantifier_redos' }
            }
          }
          frame.lastAtom.isVariableQuantified = true
        }
        if (frame.lastAtom) {
          frame.lastAtom.minCount = minCount
        }
        if (repeatable || isVariable) {
          frame.hasQuantifier = true
        }
        prevAtomQuantified = true
        prevAtomWasQuantifier = true
        justClosedQuantifiable = false
        i = endIdx
        continue
      }
    }

    commitPendingAtom(frame)
    if (ch === '^' || ch === '$') {
      frame.lastAtom = null
      justClosedQuantifiable = false
    } else {
      frame.lastAtom = {
        charSet: ch === '.' ? makeDotCharSet(dotAll) : makeSingleCharSet(ch, ignoreCase),
        minCount: 1,
        isVariableQuantified: false,
      }
      justClosedQuantifiable = true
    }
    prevAtomQuantified = false
    prevAtomWasQuantifier = false
  }

  if (stack.length !== 1) {
    return { valid: false, reason: 'unterminated_construct' }
  }
  commitPendingAtom(stack[0])

  try {
    const regex = new RegExp(pattern, flags)
    return { valid: true, regex }
  } catch {
    return { valid: false, reason: 'invalid_regex_syntax' }
  }
}

/**
 * Returns the static CSS class name for a highlight tone, failing closed on any unknown value.
 */
export function getHighlightClassName(tone) {
  if (typeof tone !== 'string') return null
  return Object.prototype.hasOwnProperty.call(HIGHLIGHT_CSS_CLASSES, tone)
    ? HIGHLIGHT_CSS_CLASSES[tone]
    : null
}

function hasDistinctLeadingZero(rawVal, ruleVal) {
  const a = typeof rawVal === 'string' ? rawVal.trim() : ''
  const b = typeof ruleVal === 'string' ? ruleVal.trim() : ''
  return LEADING_ZERO_INT_RE.test(a) || LEADING_ZERO_INT_RE.test(b)
}

function compareValuesForEquality(rawValue, textValue, targetValue, caseSensitive) {
  if (typeof targetValue !== 'string') return false
  if (!hasDistinctLeadingZero(rawValue, targetValue)) {
    const decCmp = compareExactDecimal(
      typeof rawValue === 'number' || typeof rawValue === 'bigint' ? rawValue : textValue,
      targetValue
    )
    if (decCmp !== null) return decCmp === 0
  }
  return caseSensitive
    ? textValue === targetValue
    : textValue.toLowerCase() === targetValue.toLowerCase()
}

function compareValuesForOrder(rawValue, textValue, targetValue, caseSensitive) {
  if (typeof targetValue !== 'string' || targetValue === '') return null
  const decCmp = compareExactDecimal(
    typeof rawValue === 'number' || typeof rawValue === 'bigint' ? rawValue : textValue,
    targetValue
  )
  if (decCmp !== null) return decCmp
  const a = caseSensitive ? textValue : textValue.toLowerCase()
  const b = caseSensitive ? targetValue : targetValue.toLowerCase()
  return a < b ? -1 : a > b ? 1 : 0
}

function resolveInValuesList(rule) {
  if (Array.isArray(rule.values)) return rule.values
  if (typeof rule.value === 'string' && rule.value.length > 0) {
    return rule.value.split(',').map((s) => s.trim())
  }
  return []
}

function evaluateRuleWithCompiledCache(rule, rawValue, regexCache) {
  if (!rule || rule.enabled === false) return false
  const classified = classifyCellValue(rawValue)

  if (classified.state === 'Unavailable') return false
  if (classified.state === 'Null') {
    return rule.operator === 'is_null'
  }
  if (classified.state === 'NonText') {
    return rule.operator === 'is_not_null'
  }

  const text = classified.text
  const op = rule.operator
  if (op === 'is_null') return false
  if (op === 'is_not_null') return true

  const defaultCs = op === 'like' || op === 'not_like' || op === 'regex'
  const caseSensitive = op === 'ilike' ? false : (rule.caseSensitive ?? defaultCs)

  switch (op) {
    case 'eq':
      return compareValuesForEquality(rawValue, text, rule.value, caseSensitive)
    case 'neq':
      return !compareValuesForEquality(rawValue, text, rule.value, caseSensitive)
    case 'contains':
    case 'not_contains': {
      if (typeof rule.value !== 'string') return false
      const hay = caseSensitive ? text : text.toLowerCase()
      const needle = caseSensitive ? rule.value : rule.value.toLowerCase()
      const hit = hay.includes(needle)
      return op === 'contains' ? hit : !hit
    }
    case 'starts_with': {
      if (typeof rule.value !== 'string') return false
      return caseSensitive
        ? text.startsWith(rule.value)
        : text.toLowerCase().startsWith(rule.value.toLowerCase())
    }
    case 'ends_with': {
      if (typeof rule.value !== 'string') return false
      return caseSensitive
        ? text.endsWith(rule.value)
        : text.toLowerCase().endsWith(rule.value.toLowerCase())
    }
    case 'like':
      return typeof rule.value === 'string' && matchSqlLike(text, rule.value, caseSensitive)
    case 'not_like':
      return typeof rule.value === 'string' && !matchSqlLike(text, rule.value, caseSensitive)
    case 'ilike':
      return typeof rule.value === 'string' && matchSqlLike(text, rule.value, false)
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const cmp = compareValuesForOrder(rawValue, text, rule.value, caseSensitive)
      if (cmp === null) return false
      if (op === 'gt') return cmp > 0
      if (op === 'gte') return cmp >= 0
      if (op === 'lt') return cmp < 0
      return cmp <= 0
    }
    case 'between': {
      const cmpLow = compareValuesForOrder(rawValue, text, rule.value, caseSensitive)
      const cmpHigh = compareValuesForOrder(rawValue, text, rule.valueTo, caseSensitive)
      if (cmpLow === null || cmpHigh === null) return false
      return cmpLow >= 0 && cmpHigh <= 0
    }
    case 'in':
    case 'not_in': {
      const list = resolveInValuesList(rule)
      let hit = false
      for (let i = 0; i < list.length; i++) {
        if (compareValuesForEquality(rawValue, text, list[i], caseSensitive)) {
          hit = true
          break
        }
      }
      return op === 'in' ? hit : !hit
    }
    case 'regex': {
      if (typeof rule.value !== 'string' || !rule.value) return false
      const flags = caseSensitive ? '' : 'i'
      const cacheKey = `${flags}\u0000${rule.value}`
      let compiled = regexCache?.get(cacheKey)
      if (!compiled) {
        compiled = validateHighlightRegex(rule.value, flags)
        regexCache?.set(cacheKey, compiled)
      }
      if (!compiled.valid || !compiled.regex) return false
      const subject =
        text.length > MAX_REGEX_SUBJECT_CHARS ? text.slice(0, MAX_REGEX_SUBJECT_CHARS) : text
      return compiled.regex.test(subject)
    }
    default:
      return false
  }
}

/**
 * Evaluates a single ConditionalHighlightRule against a raw cell value.
 */
export function evaluateHighlightRule(rule, rawValue) {
  return evaluateRuleWithCompiledCache(rule, rawValue, null)
}

function readRowCellByIndex(row, colIndex, headers) {
  if (colIndex < 0) return undefined
  if (Array.isArray(row)) {
    return colIndex < row.length ? row[colIndex] : undefined
  }
  if (row && typeof row === 'object') {
    const header = headers[colIndex]
    return Object.prototype.hasOwnProperty.call(row, header) ? row[header] : undefined
  }
  return undefined
}

function evaluateRowInternal({ row, columns, rules, regexCache, resolver }) {
  const headers = Array.isArray(columns) ? columns : []
  const keyResolver = resolver ?? buildColumnKeyResolver(headers)
  const keyToIndex = keyResolver.indexByKey

  let rowTone = null
  const cellTonesByKey = {}
  const cellClassesByKey = {}

  const list = Array.isArray(rules) ? rules : []
  const limit = Math.min(list.length, MAX_HIGHLIGHT_RULES_PER_TABLE)
  for (let i = 0; i < limit; i++) {
    const rule = list[i]
    if (!rule || rule.enabled === false) continue
    const cls = getHighlightClassName(rule.tone)
    if (!cls) continue

    const resolvedKey = keyResolver.resolveKey(rule.column)
    if (!resolvedKey) continue
    const colIndex = keyToIndex.get(resolvedKey)
    if (colIndex === undefined) continue

    if (rule.target === 'row' && rowTone !== null) continue
    if (rule.target === 'cell' && cellTonesByKey[resolvedKey] !== undefined) continue

    const cellVal = readRowCellByIndex(row, colIndex, headers)
    if (!evaluateRuleWithCompiledCache(rule, cellVal, regexCache)) continue

    if (rule.target === 'row') {
      rowTone = rule.tone
    } else if (rule.target === 'cell') {
      cellTonesByKey[resolvedKey] = rule.tone
      cellClassesByKey[resolvedKey] = cls
    }
  }

  return {
    rowTone,
    rowClass: rowTone ? getHighlightClassName(rowTone) : null,
    cellTonesByKey,
    cellClassesByKey,
  }
}

/**
 * Evaluates row & cell highlights for a single row (up to 20 rules, 5 static classes).
 */
export function evaluateRowHighlights({ row, columns, rules }) {
  return evaluateRowInternal({ row, columns, rules, regexCache: null, resolver: null })
}

/**
 * Resolves the winning display highlight for a cell enforcing: selection > cell > row > zebra.
 */
export function resolveCellDisplayHighlight({ isSelected, rowTone, cellTone }) {
  if (isSelected) {
    return { className: null, source: 'selection', tone: null }
  }
  const cellClass = getHighlightClassName(cellTone)
  if (cellClass) {
    return { className: cellClass, source: 'cell', tone: cellTone }
  }
  const rowClass = getHighlightClassName(rowTone)
  if (rowClass) {
    return { className: rowClass, source: 'row', tone: rowTone }
  }
  return { className: null, source: 'none', tone: null }
}

/**
 * Creates a memoized highlight evaluator caching row results by (rowRevision, rulesRef)
 * and compiled safe regexes across rows.
 */
export function createHighlightEvaluator(maxCachedRowsPerRuleset = 4096) {
  let byRulesRef = new WeakMap()
  const regexCache = new Map()
  let cachedColsRef = null
  let cachedColsLen = -1
  let cachedColsFirst = undefined
  let cachedColsLast = undefined
  let cachedResolver = null
  let hits = 0
  let misses = 0

  const getResolver = (columns) => {
    const arr = Array.isArray(columns) ? columns : []
    const len = arr.length
    const first = len > 0 ? arr[0] : undefined
    const last = len > 0 ? arr[len - 1] : undefined
    if (
      cachedResolver &&
      cachedColsRef === arr &&
      cachedColsLen === len &&
      cachedColsFirst === first &&
      cachedColsLast === last
    ) {
      return cachedResolver
    }
    cachedColsRef = arr
    cachedColsLen = len
    cachedColsFirst = first
    cachedColsLast = last
    cachedResolver = buildColumnKeyResolver(arr)
    return cachedResolver
  }

  return {
    evaluateRow({ row, columns, rules, rowKey = 0, rowRevision = 0 }) {
      const hasRulesObj = Array.isArray(rules)
      const revKey = `${String(rowKey)}:${String(rowRevision)}`
      let revMap = hasRulesObj ? byRulesRef.get(rules) : undefined
      if (revMap) {
        const cached = revMap.get(revKey)
        if (cached) {
          hits++
          return cached
        }
      }
      misses++
      const result = evaluateRowInternal({
        row,
        columns,
        rules,
        regexCache,
        resolver: getResolver(columns),
      })
      if (hasRulesObj) {
        if (!revMap) {
          revMap = new Map()
          byRulesRef.set(rules, revMap)
        }
        if (revMap.size >= maxCachedRowsPerRuleset) {
          const oldestKey = revMap.keys().next().value
          if (oldestKey !== undefined) revMap.delete(oldestKey)
        }
        revMap.set(revKey, result)
      }
      return result
    },
    clear() {
      byRulesRef = new WeakMap()
      regexCache.clear()
      cachedColsRef = null
      cachedColsLen = -1
      cachedColsFirst = undefined
      cachedColsLast = undefined
      cachedResolver = null
      hits = 0
      misses = 0
    },
    getStats() {
      return { hits, misses, regexCacheSize: regexCache.size }
    },
  }
}
