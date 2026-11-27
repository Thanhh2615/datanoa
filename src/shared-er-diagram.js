// src/shared-er-diagram.js
// Pure ER graph normalization: composite FK merging, cardinality & unique/optional inference,
// cross-schema stubs, M:N junction collapse & CJK-aware card dimensioning.
// Zero Node built-ins, zero .ts imports.

const CJK_OR_FULLWIDTH_RE =
  /[\u1100-\u11FF\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFE10-\uFE6F\uFF00-\uFFEF]/

export const ER_CARD_MIN_WIDTH = 168
export const ER_CARD_MAX_WIDTH = 380
export const ER_CARD_HEADER_HEIGHT = 32
export const ER_CARD_ROW_HEIGHT = 22
export const ER_CARD_PADDING_X = 14

/**
 * Estimates rendered text width in px, applying ~1.8x factor for CJK/fullwidth characters.
 */
export function estimateErTextWidth(text, fontSizePx = 12) {
  const s = String(text ?? '')
  if (!s) return 0
  const baseCharW = fontSizePx * 0.56
  let width = 0
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
      width += baseCharW * 1.8
      i++
      continue
    }
    const ch = s[i]
    width += CJK_OR_FULLWIDTH_RE.test(ch) ? baseCharW * 1.8 : baseCharW
  }
  return Math.ceil(width)
}

function encodeErNodeId(schema, table) {
  return JSON.stringify([String(schema ?? ''), String(table ?? '')])
}

function resolveIdentifierMatch(candidates, target) {
  if (!target) return null
  if (candidates.includes(target)) return target
  const lower = target.toLowerCase()
  const ciMatches = candidates.filter((c) => c.toLowerCase() === lower)
  return ciMatches.length === 1 ? ciMatches[0] : null
}

function setsCover(superset, subset) {
  if (subset.length === 0) return false
  for (const item of subset) {
    if (!superset.includes(item)) return false
  }
  return true
}

function inferEdgeUnique(fromNode, fromColumns) {
  if (!fromNode || fromColumns.length === 0) return false
  const colNames = fromNode.columns.map((c) => c.name)
  const resolvedFrom = fromColumns
    .map((c) => resolveIdentifierMatch(colNames, c) || c)
  const uniqueCheck = (keySet) => {
    if (!Array.isArray(keySet) || keySet.length === 0) return false
    const resolvedSet = keySet.map((k) => resolveIdentifierMatch(colNames, k) || k)
    return setsCover(resolvedFrom, resolvedSet)
  }

  if (uniqueCheck(fromNode.primaryKey)) return true
  if (Array.isArray(fromNode.uniqueColumnSets)) {
    for (const uSet of fromNode.uniqueColumnSets) {
      if (uniqueCheck(uSet)) return true
    }
  }
  const hasSingleColPk = !Array.isArray(fromNode.primaryKey) || fromNode.primaryKey.length <= 1
  for (const matchedName of resolvedFrom) {
    const col = fromNode.columns.find((c) => c.name === matchedName)
    if (col && (col.isUnique || (col.isPrimaryKey && hasSingleColPk))) {
      return true
    }
  }
  return false
}

function inferEdgeOptional(fromNode, fromColumns) {
  if (!fromNode || fromColumns.length === 0) return true
  const colNames = fromNode.columns.map((c) => c.name)
  for (const rawCol of fromColumns) {
    const resolved = resolveIdentifierMatch(colNames, rawCol) || rawCol
    const col = fromNode.columns.find((c) => c.name === resolved)
    if (col && col.nullable) return true
  }
  return false
}

export function computeErCardDimensions(node, options) {
  const compactMode = Boolean(options?.compactMode)
  const cols = Array.isArray(node.columns) ? node.columns : []
  const visibleColumns = compactMode
    ? cols.filter((c) => c.isPrimaryKey || c.isForeignKey || c.isUnique)
    : cols

  let maxLineW = estimateErTextWidth(node.name, 13) + (node.kind === 'external_stub' ? 56 : 24)
  for (const col of visibleColumns) {
    const badgeW = (col.isPrimaryKey ? 24 : 0) + (col.isForeignKey ? 24 : 0) + (col.isUnique ? 24 : 0)
    const labelW =
      estimateErTextWidth(col.name, 11.5) +
      16 +
      estimateErTextWidth(col.type || '', 11) +
      badgeW
    if (labelW > maxLineW) maxLineW = labelW
  }

  const width = Math.min(
    ER_CARD_MAX_WIDTH,
    Math.max(ER_CARD_MIN_WIDTH, maxLineW + ER_CARD_PADDING_X * 2)
  )
  const bodyRows = Math.max(1, visibleColumns.length)
  const height = ER_CARD_HEADER_HEIGHT + bodyRows * ER_CARD_ROW_HEIGHT + 8

  return {
    width,
    height,
    headerHeight: ER_CARD_HEADER_HEIGHT,
    rowHeight: ER_CARD_ROW_HEIGHT,
    visibleColumns,
  }
}

/**
 * Builds a SchemaErGraph from an array of TableDetails (merging composite FKs and inferring cardinality).
 */
export function buildErGraphFromTableDetails(connectionId, tables, options) {
  const schemaFilter = options?.schema
  const nodeById = new Map()
  const nodes = []

  for (const tbl of tables) {
    const schema = tbl.schema || schemaFilter || 'public'
    const id = encodeErNodeId(schema, tbl.name)
    const colNames = (tbl.columns || []).map((c) => c.name)
    const fkColSet = new Set()
    for (const fk of tbl.foreignKeys || []) {
      const matched = resolveIdentifierMatch(colNames, fk.column)
      if (matched) fkColSet.add(matched)
    }
    const uniqueSets = []
    const singleUniqueSet = new Set()
    for (const idx of tbl.indexes || []) {
      if (!idx.isUnique || idx.partial || idx.isExpression) continue
      if (Array.isArray(idx.columns) && idx.columns.length > 0) {
        uniqueSets.push([...idx.columns])
        if (idx.columns.length === 1) {
          const matched = resolveIdentifierMatch(colNames, idx.columns[0])
          if (matched) singleUniqueSet.add(matched)
        }
      }
    }

    const node = {
      id,
      schema,
      name: tbl.name,
      kind: tbl.kind === 'view' ? 'view' : 'table',
      primaryKey: Array.isArray(tbl.primaryKey) ? [...tbl.primaryKey] : [],
      ...(uniqueSets.length > 0 ? { uniqueColumnSets: uniqueSets } : {}),
      columns: (tbl.columns || []).map((c) => ({
        name: c.name,
        type: c.type || c.nativeType || '',
        nullable: Boolean(c.nullable),
        isPrimaryKey: Boolean(c.isPrimaryKey),
        ...(fkColSet.has(c.name) ? { isForeignKey: true } : {}),
        ...(singleUniqueSet.has(c.name) ? { isUnique: true } : {}),
      })),
    }
    nodeById.set(id, node)
    nodes.push(node)
  }

  const resolveColumnPairSignature = (fromColumn, toColumn, fromNode, toNode) => {
    const fromColNames = fromNode ? fromNode.columns.map((c) => c.name) : null
    const toColNames = toNode ? toNode.columns.map((c) => c.name) : null
    const normFrom = fromColNames
      ? resolveIdentifierMatch(fromColNames, fromColumn) || fromColumn
      : fromColumn
    const normTo = toColNames
      ? resolveIdentifierMatch(toColNames, toColumn) || toColumn
      : toColumn
    return `${normFrom}\u0000${normTo}`
  }

  // Group composite FKs into single edges
  const groupedEdges = new Map()
  for (const tbl of tables) {
    const fromSchema = tbl.schema || schemaFilter || 'public'
    const fromNodeId = encodeErNodeId(fromSchema, tbl.name)
    const fromNode = nodeById.get(fromNodeId)
    for (const fk of tbl.foreignKeys || []) {
      const toSchema = fk.referencedSchema || fromSchema
      const toNodeId = encodeErNodeId(toSchema, fk.referencedTable)
      const toNode = nodeById.get(toNodeId)
      const cName = fk.constraintName || `${fromNodeId}->${toNodeId}`
      const groupKey = JSON.stringify([fromNodeId, toNodeId, cName])
      let group = groupedEdges.get(groupKey)
      if (!group) {
        group = {
          id: groupKey,
          constraintName: fk.constraintName,
          fromNodeId,
          toNodeId,
          fromSchema,
          fromTable: tbl.name,
          toSchema,
          toTable: fk.referencedTable,
          columnPairs: [],
          onDelete: fk.onDelete,
          onUpdate: fk.onUpdate,
        }
        groupedEdges.set(groupKey, group)
      }
      const nextSig = resolveColumnPairSignature(fk.column, fk.referencedColumn, fromNode, toNode)
      const dup = group.columnPairs.some(
        (p) => resolveColumnPairSignature(p.fromColumn, p.toColumn, fromNode, toNode) === nextSig
      )
      if (!dup) {
        group.columnPairs.push({
          fromColumn: fk.column,
          toColumn: fk.referencedColumn,
        })
      }
    }
  }

  const edges = []
  for (const raw of groupedEdges.values()) {
    const fromNode = nodeById.get(raw.fromNodeId)
    const fromCols = raw.columnPairs.map((p) => p.fromColumn)
    edges.push({
      ...raw,
      unique: inferEdgeUnique(fromNode, fromCols),
      optional: inferEdgeOptional(fromNode, fromCols),
      crossSchema: raw.fromSchema !== raw.toSchema,
    })
  }

  return {
    connectionId,
    ...(schemaFilter ? { schema: schemaFilter } : {}),
    completeness: 'full',
    nodes,
    edges,
    generatedAt: Date.now(),
  }
}

function mergeCompositeEdges(rawEdges, nodeById) {
  const merged = new Map()
  const pairSignature = (fromColumn, toColumn, fromNode, toNode) => {
    const fromColNames = fromNode ? fromNode.columns.map((c) => c.name) : null
    const toColNames = toNode ? toNode.columns.map((c) => c.name) : null
    const normFrom = fromColNames
      ? resolveIdentifierMatch(fromColNames, fromColumn) || fromColumn
      : fromColumn
    const normTo = toColNames
      ? resolveIdentifierMatch(toColNames, toColumn) || toColumn
      : toColumn
    return `${normFrom}\u0000${normTo}`
  }

  for (const edge of rawEdges) {
    const key = edge.constraintName
      ? JSON.stringify([edge.fromNodeId, edge.toNodeId, edge.constraintName])
      : edge.id
    let existing = merged.get(key)
    if (!existing) {
      existing = {
        ...edge,
        columnPairs: [...(edge.columnPairs || [])],
      }
      merged.set(key, existing)
    } else {
      const fromNode = nodeById.get(edge.fromNodeId)
      const toNode = nodeById.get(edge.toNodeId)
      for (const pair of edge.columnPairs || []) {
        const nextSig = pairSignature(pair.fromColumn, pair.toColumn, fromNode, toNode)
        const dup = existing.columnPairs.some(
          (p) => pairSignature(p.fromColumn, p.toColumn, fromNode, toNode) === nextSig
        )
        if (!dup) existing.columnPairs.push(pair)
      }
    }
  }

  const out = []
  for (const edge of merged.values()) {
    const fromNode = nodeById.get(edge.fromNodeId)
    const fromCols = edge.columnPairs.map((p) => p.fromColumn)
    const unique =
      fromNode && edge.columnPairs.length > 0
        ? inferEdgeUnique(fromNode, fromCols) || Boolean(edge.unique)
        : Boolean(edge.unique)
    const optional =
      fromNode && edge.columnPairs.length > 0
        ? inferEdgeOptional(fromNode, fromCols)
        : Boolean(edge.optional)
    const crossSchema =
      Boolean(edge.crossSchema) || edge.fromSchema !== edge.toSchema
    out.push({
      ...edge,
      unique,
      optional,
      crossSchema,
    })
  }
  return out
}

function findJunctionParentEdges(node, outgoingEdges, incomingCountByNodeId) {
  if (node.kind !== 'table') return null
  if (!Array.isArray(node.primaryKey) || node.primaryKey.length < 2) return null
  if ((incomingCountByNodeId.get(node.id) ?? 0) > 0) return null

  const colNames = node.columns.map((c) => c.name)
  const pkResolved = node.primaryKey.map((pk) => resolveIdentifierMatch(colNames, pk) || pk)
  const relevantEdges = outgoingEdges.filter((e) => e.toNodeId !== node.id)
  if (relevantEdges.length < 2) return null

  const parentTargets = new Map()
  const coveredPkCols = new Set()

  for (const edge of relevantEdges) {
    const edgePkCols = []
    for (const pair of edge.columnPairs) {
      const resolved = resolveIdentifierMatch(colNames, pair.fromColumn) || pair.fromColumn
      if (pkResolved.includes(resolved)) {
        coveredPkCols.add(resolved)
        edgePkCols.push(resolved)
      }
    }
    if (edgePkCols.length > 0) {
      if (!parentTargets.has(edge.toNodeId)) {
        parentTargets.set(edge.toNodeId, edge)
      }
    }
  }

  if (coveredPkCols.size !== pkResolved.length || parentTargets.size !== 2) {
    return null
  }
  const parents = Array.from(parentTargets.values())
  return [parents[0], parents[1]]
}

/**
 * Normalizes a SchemaErGraph for layout & export:
 * - Merges composite FKs & infers cardinality
 * - Synthesizes or filters external_stub nodes for cross-schema FKs
 * - Optionally collapses M:N junction tables and hides orphans
 */
export function normalizeErGraph(graph, options) {
  const showExternalStubs = options?.showExternalStubs !== false
  const collapseJunctions = Boolean(options?.collapseJunctions)
  const hideOrphans = Boolean(options?.hideOrphans)

  const nodeById = new Map()
  let nodes = (graph.nodes || []).map((n) => {
    const copy = {
      ...n,
      columns: [...(n.columns || [])],
      primaryKey: [...(n.primaryKey || [])],
    }
    nodeById.set(copy.id, copy)
    return copy
  })

  if (!showExternalStubs) {
    nodes = nodes.filter((n) => n.kind !== 'external_stub')
    for (const id of Array.from(nodeById.keys())) {
      if (nodeById.get(id).kind === 'external_stub') nodeById.delete(id)
    }
  }

  let edges = mergeCompositeEdges(graph.edges || [], nodeById)

  // Synthesize external_stub nodes for cross-schema edges whose target isn't in nodeById
  if (showExternalStubs) {
    for (const edge of edges) {
      if (!nodeById.has(edge.toNodeId)) {
        const stubNode = {
          id: edge.toNodeId,
          schema: edge.toSchema || 'external',
          name: edge.toTable,
          kind: 'external_stub',
          primaryKey: edge.columnPairs.map((p) => p.toColumn),
          columns: edge.columnPairs.map((p) => ({
            name: p.toColumn,
            type: 'ref',
            nullable: false,
            isPrimaryKey: true,
          })),
        }
        nodeById.set(stubNode.id, stubNode)
        nodes.push(stubNode)
      }
    }
  } else {
    edges = edges.filter((e) => nodeById.has(e.fromNodeId) && nodeById.has(e.toNodeId))
  }

  // Filter any dangling edges
  edges = edges.filter((e) => nodeById.has(e.fromNodeId) && nodeById.has(e.toNodeId))

  const collapsedJunctions = []
  if (collapseJunctions) {
    const outgoingByNode = new Map()
    const incomingCount = new Map()
    for (const e of edges) {
      if (!outgoingByNode.has(e.fromNodeId)) outgoingByNode.set(e.fromNodeId, [])
      outgoingByNode.get(e.fromNodeId).push(e)
      if (e.toNodeId !== e.fromNodeId) {
        incomingCount.set(e.toNodeId, (incomingCount.get(e.toNodeId) ?? 0) + 1)
      }
    }

    const removedNodeIds = new Set()
    const removedEdgeIds = new Set()
    const syntheticEdges = []

    for (const node of nodes) {
      const pair = findJunctionParentEdges(
        node,
        outgoingByNode.get(node.id) || [],
        incomingCount
      )
      if (!pair) continue
      const [edgeA, edgeB] = pair
      removedNodeIds.add(node.id)
      for (const oe of outgoingByNode.get(node.id) || []) {
        removedEdgeIds.add(oe.id)
      }
      const targetA = nodeById.get(edgeA.toNodeId)
      const targetB = nodeById.get(edgeB.toNodeId)
      if (targetA && targetB) {
        collapsedJunctions.push(node.id)
        syntheticEdges.push({
          id: `mn_${node.id}`,
          constraintName: node.name,
          fromNodeId: targetA.id,
          toNodeId: targetB.id,
          fromSchema: targetA.schema,
          fromTable: targetA.name,
          toSchema: targetB.schema,
          toTable: targetB.name,
          columnPairs: [
            ...edgeA.columnPairs.map((p) => ({
              fromColumn: p.toColumn,
              toColumn: edgeB.columnPairs[0]?.toColumn || p.toColumn,
            })),
          ],
          unique: false,
          optional: true,
          crossSchema: targetA.schema !== targetB.schema,
          isManyToMany: true,
          junctionTable: node.name,
        })
      }
    }

    if (removedNodeIds.size > 0) {
      nodes = nodes.filter((n) => !removedNodeIds.has(n.id))
      edges = edges.filter((e) => !removedEdgeIds.has(e.id)).concat(syntheticEdges)
    }
  }

  if (hideOrphans) {
    const connected = new Set()
    for (const e of edges) {
      connected.add(e.fromNodeId)
      connected.add(e.toNodeId)
    }
    nodes = nodes.filter((n) => connected.has(n.id))
  }

  return {
    connectionId: graph.connectionId,
    ...(graph.schema ? { schema: graph.schema } : {}),
    completeness: graph.completeness || 'full',
    ...(graph.truncated ? { truncated: true } : {}),
    ...(graph.totalTableCount !== undefined ? { totalTableCount: graph.totalTableCount } : {}),
    nodes,
    edges,
    collapsedJunctions,
    generatedAt: graph.generatedAt || Date.now(),
  }
}
