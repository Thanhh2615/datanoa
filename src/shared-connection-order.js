// src/shared-connection-order.js
// Pure folder-scoped connection reordering primitives shared by Worker, Side Panel, and Studio.

export const UNGROUPED_FOLDER_ORDER_KEY = '__ungrouped__'

const FOLDER_CONTROL_CHARS_RE = /[\u0000-\u001F\u007F]/g
const MAX_FOLDER_NAME_CHARS = 64
const MAX_FOLDER_ORDER_ENTRIES = 500

function sanitizeFolderOrderKey(raw) {
  if (typeof raw !== 'string') return ''
  const cleaned = raw.replace(FOLDER_CONTROL_CHARS_RE, '').trim()
  return cleaned.length > 0 ? cleaned.slice(0, MAX_FOLDER_NAME_CHARS) : ''
}

export function isReservedFolderName(folder) {
  return sanitizeFolderOrderKey(folder) === UNGROUPED_FOLDER_ORDER_KEY
}

export function normalizeConnectionFolderKey(folder) {
  const cleaned = sanitizeFolderOrderKey(folder)
  if (!cleaned || cleaned === UNGROUPED_FOLDER_ORDER_KEY) return ''
  return cleaned
}

export function getFolderConnectionIds(connections, folder) {
  const list = Array.isArray(connections) ? connections : []
  const targetFolder = normalizeConnectionFolderKey(folder)
  const ids = []
  for (const conn of list) {
    if (!conn || typeof conn.id !== 'string' || conn.id.length === 0) continue
    if (normalizeConnectionFolderKey(conn.folder) === targetFolder) {
      ids.push(conn.id)
    }
  }
  return ids
}

export function getConnectionReorderBounds(connections, connectionId) {
  const list = Array.isArray(connections) ? connections : []
  const id = typeof connectionId === 'string' ? connectionId.trim() : ''
  if (!id) {
    return { found: false, folder: '', index: -1, total: 0, canMoveUp: false, canMoveDown: false }
  }
  const target = list.find((c) => c && typeof c.id === 'string' && c.id === id)
  if (!target) {
    return { found: false, folder: '', index: -1, total: 0, canMoveUp: false, canMoveDown: false }
  }
  const folder = normalizeConnectionFolderKey(target.folder)
  const folderIds = getFolderConnectionIds(list, folder)
  const index = folderIds.indexOf(id)
  if (index < 0) {
    return { found: false, folder, index: -1, total: folderIds.length, canMoveUp: false, canMoveDown: false }
  }
  return {
    found: true,
    folder,
    index,
    total: folderIds.length,
    canMoveUp: index > 0,
    canMoveDown: index < folderIds.length - 1,
  }
}

export function computeMovedFolderIds(connections, connectionId, direction) {
  if (direction !== 'up' && direction !== 'down') {
    return { ok: false, changed: false, folder: '', orderedIds: [] }
  }
  const bounds = getConnectionReorderBounds(connections, connectionId)
  if (!bounds.found) {
    return { ok: false, changed: false, folder: '', orderedIds: [] }
  }
  const folderIds = getFolderConnectionIds(connections, bounds.folder)
  const delta = direction === 'up' ? -1 : 1
  const nextIdx = bounds.index + delta
  if (nextIdx < 0 || nextIdx >= folderIds.length) {
    return { ok: true, changed: false, folder: bounds.folder, orderedIds: folderIds }
  }
  const orderedIds = folderIds.slice()
  const moved = orderedIds[bounds.index]
  orderedIds[bounds.index] = orderedIds[nextIdx]
  orderedIds[nextIdx] = moved
  return { ok: true, changed: true, folder: bounds.folder, orderedIds }
}

export function computeReorderedFolderIds(connections, sourceId, targetId, placement) {
  const list = Array.isArray(connections) ? connections : []
  const srcId = typeof sourceId === 'string' ? sourceId.trim() : ''
  const tgtId = typeof targetId === 'string' ? targetId.trim() : ''
  if (!srcId || !tgtId || srcId === tgtId) {
    return { ok: false, changed: false, folder: '', orderedIds: [] }
  }
  if (placement !== 'before' && placement !== 'after') {
    return { ok: false, changed: false, folder: '', orderedIds: [] }
  }

  const source = list.find((c) => c && typeof c.id === 'string' && c.id === srcId)
  const target = list.find((c) => c && typeof c.id === 'string' && c.id === tgtId)
  if (!source || !target) {
    return { ok: false, changed: false, folder: '', orderedIds: [] }
  }

  const folder = normalizeConnectionFolderKey(source.folder)
  if (normalizeConnectionFolderKey(target.folder) !== folder) {
    return { ok: false, changed: false, folder, orderedIds: [] }
  }

  const currentIds = getFolderConnectionIds(list, folder)
  const withoutSource = currentIds.filter((id) => id !== srcId)
  const targetIdx = withoutSource.indexOf(tgtId)
  if (targetIdx < 0) {
    return { ok: false, changed: false, folder, orderedIds: currentIds }
  }

  const insertIdx = placement === 'before' ? targetIdx : targetIdx + 1
  const orderedIds = withoutSource.slice()
  orderedIds.splice(insertIdx, 0, srcId)

  const changed = orderedIds.some((id, idx) => id !== currentIds[idx])
  return { ok: true, changed, folder, orderedIds }
}

export function reorderConnectionsWithinFolder(connections, folder, orderedIds) {
  const list = Array.isArray(connections) ? connections.slice() : []
  const targetFolder = normalizeConnectionFolderKey(folder)
  if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
    return {
      ok: false,
      changed: false,
      folder: targetFolder,
      connections: list,
      error: 'orderedIds must be a non-empty array of connection IDs',
    }
  }

  const normalizedIds = []
  const seen = new Set()
  for (const rawId of orderedIds) {
    if (typeof rawId !== 'string' || rawId.trim().length === 0) {
      return {
        ok: false,
        changed: false,
        folder: targetFolder,
        connections: list,
        error: 'orderedIds must contain non-empty string connection IDs',
      }
    }
    const id = rawId.trim()
    if (seen.has(id)) {
      return {
        ok: false,
        changed: false,
        folder: targetFolder,
        connections: list,
        error: `Duplicate connection ID in reorder request: ${id}`,
      }
    }
    seen.add(id)
    normalizedIds.push(id)
  }

  const byId = new Map()
  const matchedSlots = []
  for (let i = 0; i < list.length; i++) {
    const conn = list[i]
    if (!conn || typeof conn.id !== 'string') continue
    const connId = conn.id.trim()
    if (!seen.has(connId)) continue
    if (byId.has(connId)) {
      return {
        ok: false,
        changed: false,
        folder: targetFolder,
        connections: list,
        error: `Duplicate connection ID in folder: ${connId}`,
      }
    }
    if (normalizeConnectionFolderKey(conn.folder) !== targetFolder) {
      return {
        ok: false,
        changed: false,
        folder: targetFolder,
        connections: list,
        error: 'Cannot reorder connections across different folders',
      }
    }
    byId.set(connId, conn)
    matchedSlots.push(i)
  }

  if (byId.size !== normalizedIds.length) {
    return {
      ok: false,
      changed: false,
      folder: targetFolder,
      connections: list,
      error: 'Reorder request contains unknown connection IDs',
    }
  }

  let changed = false
  for (let i = 0; i < matchedSlots.length; i++) {
    const slotIdx = matchedSlots[i]
    const nextConn = byId.get(normalizedIds[i])
    if (list[slotIdx]?.id !== nextConn.id) {
      changed = true
    }
    list[slotIdx] = nextConn
  }

  return {
    ok: true,
    changed,
    folder: targetFolder,
    connections: list,
  }
}

export function getConnectionFolderOrderKeys(connections) {
  const list = Array.isArray(connections) ? connections : []
  const seen = new Set()
  const keys = []
  let hasUngrouped = false
  for (const conn of list) {
    if (!conn || typeof conn !== 'object') continue
    const folder = normalizeConnectionFolderKey(conn.folder)
    if (!folder) {
      hasUngrouped = true
      continue
    }
    if (seen.has(folder)) continue
    seen.add(folder)
    keys.push(folder)
  }
  if (hasUngrouped && !seen.has(UNGROUPED_FOLDER_ORDER_KEY)) {
    keys.push(UNGROUPED_FOLDER_ORDER_KEY)
  }
  return keys
}

export function normalizeFolderOrder(folderOrder) {
  if (!Array.isArray(folderOrder)) return []
  const seen = new Set()
  const result = []
  for (const raw of folderOrder) {
    const name = sanitizeFolderOrderKey(raw)
    if (!name || seen.has(name)) continue
    seen.add(name)
    result.push(name)
    if (result.length >= MAX_FOLDER_ORDER_ENTRIES) break
  }
  return result
}

function compareUnrankedFolderKeys(a, b) {
  const aIsUngrouped = a === UNGROUPED_FOLDER_ORDER_KEY
  const bIsUngrouped = b === UNGROUPED_FOLDER_ORDER_KEY
  if (aIsUngrouped !== bIsUngrouped) return aIsUngrouped ? 1 : -1
  return a.localeCompare(b)
}

export function sortFoldersByOrder(folderNames, folderOrder) {
  const distinct = normalizeFolderOrder(folderNames)
  if (distinct.length <= 1) return distinct
  const normalizedOrder = normalizeFolderOrder(folderOrder)
  if (normalizedOrder.length === 0) {
    return distinct.sort(compareUnrankedFolderKeys)
  }
  const rank = new Map()
  for (let i = 0; i < normalizedOrder.length; i++) {
    rank.set(normalizedOrder[i], i)
  }
  return distinct.sort((a, b) => {
    const rankA = rank.has(a) ? rank.get(a) : Number.MAX_SAFE_INTEGER
    const rankB = rank.has(b) ? rank.get(b) : Number.MAX_SAFE_INTEGER
    if (rankA !== rankB) return rankA - rankB
    return compareUnrankedFolderKeys(a, b)
  })
}

export function getFolderReorderBounds(folderNames, folderName, folderOrder) {
  const orderedFolders = sortFoldersByOrder(folderNames, folderOrder)
  const target = sanitizeFolderOrderKey(folderName)
  if (!target) {
    return {
      found: false,
      index: -1,
      total: orderedFolders.length,
      canMoveUp: false,
      canMoveDown: false,
      orderedFolders,
    }
  }
  const index = orderedFolders.indexOf(target)
  if (index < 0) {
    return {
      found: false,
      index: -1,
      total: orderedFolders.length,
      canMoveUp: false,
      canMoveDown: false,
      orderedFolders,
    }
  }
  return {
    found: true,
    index,
    total: orderedFolders.length,
    canMoveUp: index > 0,
    canMoveDown: index < orderedFolders.length - 1,
    orderedFolders,
  }
}

export function computeReorderedFolders(
  folderNames,
  sourceFolder,
  targetFolder,
  placement,
  folderOrder
) {
  const src = sanitizeFolderOrderKey(sourceFolder)
  const tgt = sanitizeFolderOrderKey(targetFolder)
  if (!src || !tgt || src === tgt) {
    return { ok: false, changed: false, orderedFolders: [] }
  }
  if (placement !== 'before' && placement !== 'after') {
    return { ok: false, changed: false, orderedFolders: [] }
  }

  const currentFolders = sortFoldersByOrder(folderNames, folderOrder)
  if (!currentFolders.includes(src) || !currentFolders.includes(tgt)) {
    return { ok: false, changed: false, orderedFolders: [] }
  }

  const withoutSource = currentFolders.filter((folder) => folder !== src)
  const targetIdx = withoutSource.indexOf(tgt)
  if (targetIdx < 0) {
    return { ok: false, changed: false, orderedFolders: currentFolders }
  }

  const insertIdx = placement === 'before' ? targetIdx : targetIdx + 1
  const orderedFolders = withoutSource.slice()
  orderedFolders.splice(insertIdx, 0, src)
  const changed = orderedFolders.some((folder, idx) => folder !== currentFolders[idx])
  return { ok: true, changed, orderedFolders }
}

export function computeMovedFolders(folderNames, folderName, direction, folderOrder) {
  if (direction !== 'up' && direction !== 'down') {
    return { ok: false, changed: false, orderedFolders: [] }
  }
  const bounds = getFolderReorderBounds(folderNames, folderName, folderOrder)
  if (!bounds.found) {
    return { ok: false, changed: false, orderedFolders: [] }
  }
  const delta = direction === 'up' ? -1 : 1
  const nextIdx = bounds.index + delta
  if (nextIdx < 0 || nextIdx >= bounds.orderedFolders.length) {
    return { ok: true, changed: false, orderedFolders: bounds.orderedFolders }
  }
  const orderedFolders = bounds.orderedFolders.slice()
  const moved = orderedFolders[bounds.index]
  orderedFolders[bounds.index] = orderedFolders[nextIdx]
  orderedFolders[nextIdx] = moved
  return { ok: true, changed: true, orderedFolders }
}

export function reconcileFolderOrder(existingOrder, requestedOrderedFolders, currentFolderNames) {
  const normalizedExisting = normalizeFolderOrder(existingOrder)
  const currentFolders = normalizeFolderOrder(currentFolderNames)
  if (!Array.isArray(requestedOrderedFolders) || requestedOrderedFolders.length === 0) {
    return {
      ok: false,
      changed: false,
      folderOrder: normalizedExisting,
      error: 'orderedFolders must be a non-empty array of folder names',
    }
  }

  const currentSet = new Set(currentFolders)
  const seen = new Set()
  const normalizedRequested = []
  for (const rawFolder of requestedOrderedFolders) {
    if (typeof rawFolder !== 'string' || rawFolder.trim().length === 0) {
      return {
        ok: false,
        changed: false,
        folderOrder: normalizedExisting,
        error: 'orderedFolders must contain non-empty string folder names',
      }
    }
    const folder = rawFolder.trim()
    if (seen.has(folder)) {
      return {
        ok: false,
        changed: false,
        folderOrder: normalizedExisting,
        error: `Duplicate folder name in reorder request: ${folder}`,
      }
    }
    if (!currentSet.has(folder)) {
      return {
        ok: false,
        changed: false,
        folderOrder: normalizedExisting,
        error: `Unknown folder name in reorder request: ${folder}`,
      }
    }
    seen.add(folder)
    normalizedRequested.push(folder)
  }

  const effectiveCurrentOrder = sortFoldersByOrder(currentFolders, normalizedExisting)
  const matchedSlots = []
  for (let i = 0; i < effectiveCurrentOrder.length; i++) {
    if (seen.has(effectiveCurrentOrder[i])) {
      matchedSlots.push(i)
    }
  }

  const nextOrder = effectiveCurrentOrder.slice()
  let changed = false
  for (let i = 0; i < matchedSlots.length; i++) {
    const slotIdx = matchedSlots[i]
    const nextFolder = normalizedRequested[i]
    if (nextOrder[slotIdx] !== nextFolder) {
      changed = true
    }
    nextOrder[slotIdx] = nextFolder
  }

  return {
    ok: true,
    changed,
    folderOrder: nextOrder,
  }
}
