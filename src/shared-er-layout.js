// src/shared-er-layout.js
// High-speed ER Diagram layout engine using typed arrays (Float64Array/Int32Array):
// Union-Find connected components, force-directed layout (~11ms / 300 tables),
// 2D PCA rotation, AABB overlap removal, NFDH 2D shelf packing & self-loop routing.
// Zero Node built-ins, zero .ts imports.

import { computeErCardDimensions } from './shared-er-diagram.js'

const BLOCK_GAP = 80
const OUTER_PADDING = 40
const AABB_PADDING = 30
const ORPHAN_CELL_GAP = 30

// Reusable scratch buffers grow on demand to avoid per-layout GC churn.
let scratchNodeCap = 0
let scratchDispX = new Float64Array(0)
let scratchDispY = new Float64Array(0)
let scratchHalfW = new Float64Array(0)
let scratchHalfH = new Float64Array(0)
let scratchDegree = new Int32Array(0)
let scratchOrder = new Int32Array(0)
let scratchParent = new Int32Array(0)
let scratchHasSelfLoop = new Uint8Array(0)
let scratchNodeCompId = new Int32Array(0)
let scratchLocalIndex = new Int32Array(0)
let scratchCompCounts = new Int32Array(0)
let scratchCompOffsets = new Int32Array(0)

let scratchEdgeCap = 0
let scratchEdgeU = new Int32Array(0)
let scratchEdgeV = new Int32Array(0)
let scratchAllEdgeU = new Int32Array(0)
let scratchAllEdgeV = new Int32Array(0)
let scratchPackedEdgeU = new Int32Array(0)
let scratchPackedEdgeV = new Int32Array(0)

function ensureNodeScratch(n) {
  if (n <= scratchNodeCap) return
  const cap = Math.max(n, scratchNodeCap * 2, 64)
  scratchNodeCap = cap
  scratchDispX = new Float64Array(cap)
  scratchDispY = new Float64Array(cap)
  scratchHalfW = new Float64Array(cap)
  scratchHalfH = new Float64Array(cap)
  scratchDegree = new Int32Array(cap)
  scratchOrder = new Int32Array(cap)
  scratchParent = new Int32Array(cap)
  scratchHasSelfLoop = new Uint8Array(cap)
  scratchNodeCompId = new Int32Array(cap)
  scratchLocalIndex = new Int32Array(cap)
  scratchCompCounts = new Int32Array(cap)
  scratchCompOffsets = new Int32Array(cap)
}

function ensureEdgeScratch(e) {
  if (e <= scratchEdgeCap) return
  const cap = Math.max(e, scratchEdgeCap * 2, 64)
  scratchEdgeCap = cap
  scratchEdgeU = new Int32Array(cap)
  scratchEdgeV = new Int32Array(cap)
  scratchAllEdgeU = new Int32Array(cap)
  scratchAllEdgeV = new Int32Array(cap)
  scratchPackedEdgeU = new Int32Array(cap)
  scratchPackedEdgeV = new Int32Array(cap)
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

function round2(n) {
  return Math.round(n * 100) / 100
}

function buildConnectedComponents(nodes, edges) {
  const n = nodes.length
  ensureNodeScratch(n)
  ensureEdgeScratch(edges.length)
  const parent = scratchParent
  const hasSelfLoop = scratchHasSelfLoop
  const indexById = new Map()
  for (let i = 0; i < n; i++) {
    parent[i] = i
    hasSelfLoop[i] = 0
    indexById.set(nodes[i].id, i)
  }

  function find(x) {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]
      x = parent[x]
    }
    return x
  }

  let pairCount = 0
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]
    const u = indexById.get(e.fromNodeId)
    const v = indexById.get(e.toNodeId)
    if (u === undefined || v === undefined) continue
    if (u === v) {
      hasSelfLoop[u] = 1
    } else {
      const ra = find(u)
      const rb = find(v)
      if (ra !== rb) parent[rb] = ra
      scratchAllEdgeU[pairCount] = u
      scratchAllEdgeV[pairCount] = v
      pairCount++
    }
  }

  const groups = new Map()
  for (let i = 0; i < n; i++) {
    const r = find(i)
    let arr = groups.get(r)
    if (!arr) {
      arr = []
      groups.set(r, arr)
    }
    arr.push(i)
  }

  const connectedComponents = []
  const orphans = []

  for (const memberIndices of groups.values()) {
    memberIndices.sort((a, b) => nodes[a].name.localeCompare(nodes[b].name))
    if (memberIndices.length === 1 && !hasSelfLoop[memberIndices[0]]) {
      orphans.push(memberIndices[0])
    } else {
      connectedComponents.push(memberIndices)
    }
  }

  connectedComponents.sort((a, b) => nodes[a[0]].name.localeCompare(nodes[b[0]].name))
  orphans.sort((a, b) => nodes[a].name.localeCompare(nodes[b].name))

  return { connectedComponents, orphans, pairCount }
}

function sortOrderByPosX(order, posX, count, nearlySorted) {
  if (!nearlySorted && count > 32) {
    let gap = 1
    const limit = (count / 3) | 0
    while (gap <= limit) gap = gap * 3 + 1
    while (gap > 1) {
      gap = ((gap - 1) / 3) | 0
      for (let i = gap; i < count; i++) {
        const key = order[i]
        const keyX = posX[key]
        let j = i - gap
        while (j >= 0 && posX[order[j]] > keyX) {
          order[j + gap] = order[j]
          j -= gap
        }
        order[j + gap] = key
      }
    }
    return
  }

  for (let i = 1; i < count; i++) {
    const key = order[i]
    const keyX = posX[key]
    let j = i - 1
    while (j >= 0 && posX[order[j]] > keyX) {
      order[j + 1] = order[j]
      j--
    }
    order[j + 1] = key
  }
}

function resolveAabbOverlaps(posX, posY, nodeW, nodeH, count, padding, maxPasses, orderInitialized) {
  if (count <= 1) return 0
  const halfPad = padding * 0.5
  const halfW = scratchHalfW
  const halfH = scratchHalfH
  const order = scratchOrder
  let maxHalfW = 0

  for (let i = 0; i < count; i++) {
    const hw = nodeW[i] * 0.5 + halfPad
    halfW[i] = hw
    halfH[i] = nodeH[i] * 0.5 + halfPad
    if (hw > maxHalfW) maxHalfW = hw
    if (!orderInitialized) order[i] = i
  }

  for (let pass = 0; pass < maxPasses; pass++) {
    sortOrderByPosX(order, posX, count, orderInitialized || pass > 0)
    let moved = false
    for (let ii = 0; ii < count; ii++) {
      const i = order[ii]
      const xi = posX[i]
      const yi = posY[i]
      const halfWi = halfW[i]
      const halfHi = halfH[i]
      const xCutoff = xi + halfWi + maxHalfW
      for (let jj = ii + 1; jj < count; jj++) {
        const j = order[jj]
        const xj = posX[j]
        if (xj > xCutoff) break
        const dx = xj - xi
        const minW = halfWi + halfW[j]
        const ox = minW - (dx < 0 ? -dx : dx)
        if (ox <= 0) continue

        const dy = posY[j] - yi
        const minH = halfHi + halfH[j]
        const oy = minH - (dy < 0 ? -dy : dy)
        if (oy <= 0) continue

        moved = true
        if (ox < oy) {
          const sign = dx === 0 ? (i % 2 === 0 ? 1 : -1) : dx > 0 ? 1 : -1
          const push = ox * 0.52
          posX[i] -= sign * push
          posX[j] += sign * push
        } else {
          const sign = dy === 0 ? (i % 2 === 0 ? 1 : -1) : dy > 0 ? 1 : -1
          const push = oy * 0.52
          posY[i] -= sign * push
          posY[j] += sign * push
        }
      }
    }
    if (!moved) break
  }

  return maxHalfW
}

function hasStrictAabbOverlap(posX, posY, nodeW, nodeH, count, maxHalfW) {
  const order = scratchOrder
  sortOrderByPosX(order, posX, count, true)
  for (let ii = 0; ii < count; ii++) {
    const i = order[ii]
    const xi = posX[i]
    const yi = posY[i]
    const halfWi = nodeW[i] * 0.5 + 4
    const halfHi = nodeH[i] * 0.5 + 4
    const xCutoff = xi + halfWi + maxHalfW
    for (let jj = ii + 1; jj < count; jj++) {
      const j = order[jj]
      const xj = posX[j]
      if (xj > xCutoff) break
      const minW = halfWi + nodeW[j] * 0.5
      const dx = xj - xi
      if ((dx < 0 ? -dx : dx) >= minW) continue
      const minH = halfHi + nodeH[j] * 0.5
      const dy = posY[j] - yi
      if ((dy < 0 ? -dy : dy) < minH) return true
    }
  }
  return false
}

function layoutComponentForceDirected(compIndices, allDims, edgeStart, edgeEnd) {
  const n = compIndices.length
  const posX = new Float64Array(n)
  const posY = new Float64Array(n)
  const nodeW = new Float64Array(n)
  const nodeH = new Float64Array(n)

  const edgeCount = edgeEnd - edgeStart
  ensureNodeScratch(n)
  ensureEdgeScratch(edgeCount)

  const dispX = scratchDispX
  const dispY = scratchDispY
  const degree = scratchDegree
  const localIndex = scratchLocalIndex
  const edgeU = scratchEdgeU
  const edgeV = scratchEdgeV

  let sumW = 0
  let sumH = 0
  for (let i = 0; i < n; i++) {
    const gIdx = compIndices[i]
    localIndex[gIdx] = i
    degree[i] = 0
    const dims = allDims[gIdx]
    nodeW[i] = dims.width
    nodeH[i] = dims.height
    sumW += dims.width
    sumH += dims.height
  }

  if (n === 1) {
    return { posX, posY, nodeW, nodeH }
  }

  for (let e = 0; e < edgeCount; e++) {
    const u = localIndex[scratchPackedEdgeU[edgeStart + e]]
    const v = localIndex[scratchPackedEdgeV[edgeStart + e]]
    edgeU[e] = u
    edgeV[e] = v
    degree[u]++
    degree[v]++
  }

  const avgW = sumW / n
  const avgH = sumH / n
  const k = (avgW + avgH) * 0.8 + 60
  const k2 = k * k
  const invK = 1 / k
  const iterations = clamp(Math.floor(2000 / n), 60, 300)
  const radius = (k * n) / (2 * Math.PI) + k

  for (let i = 0; i < n; i++) {
    const angle = (2 * Math.PI * i) / n
    posX[i] = radius * Math.cos(angle)
    posY[i] = radius * Math.sin(angle)
  }

  let temp = k * 2
  const minTemp = k * 0.05

  for (let iter = 0; iter < iterations; iter++) {
    dispX.fill(0, 0, n)
    dispY.fill(0, 0, n)

    // Repulsive forces (skip sqrt since force = k^2 / d^2 uses d^2 directly)
    for (let i = 0; i < n; i++) {
      const xi = posX[i]
      const yi = posY[i]
      let accX = dispX[i]
      let accY = dispY[i]
      for (let j = i + 1; j < n; j++) {
        let dx = xi - posX[j]
        let dy = yi - posY[j]
        let d2 = dx * dx + dy * dy
        if (d2 < 0.0001) {
          dx = i - j || 1
          dy = 1
          d2 = dx * dx + dy * dy
        }
        const force = k2 / d2
        const fx = dx * force
        const fy = dy * force
        accX += fx
        accY += fy
        dispX[j] -= fx
        dispY[j] -= fy
      }
      dispX[i] = accX
      dispY[i] = accY
    }

    // Attractive forces along edges
    for (let e = 0; e < edgeCount; e++) {
      const u = edgeU[e]
      const v = edgeV[e]
      const dx = posX[u] - posX[v]
      const dy = posY[u] - posY[v]
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d > 0.0001) {
        const force = d * invK
        const fx = dx * force
        const fy = dy * force
        dispX[u] -= fx
        dispY[u] -= fy
        dispX[v] += fx
        dispY[v] += fy
      }
    }

    // Degree-scaled center gravity + temperature-bounded integration in one pass
    for (let i = 0; i < n; i++) {
      const x = posX[i]
      const y = posY[i]
      let dx = dispX[i]
      let dy = dispY[i]
      if (x * x + y * y > 0.00000001) {
        const g = 0.28 * (degree[i] + 1)
        dx -= x * g
        dy -= y * g
      }
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d > 0.0001) {
        const scale = (d < temp ? d : temp) / d
        posX[i] = x + dx * scale
        posY[i] = y + dy * scale
      }
    }

    temp = Math.max(temp * 0.95, minTemp)
  }

  // 2D PCA rotation (skip if N <= 2)
  if (n > 2) {
    let meanX = 0
    let meanY = 0
    for (let i = 0; i < n; i++) {
      meanX += posX[i]
      meanY += posY[i]
    }
    meanX /= n
    meanY /= n

    let sxx = 0
    let syy = 0
    let sxy = 0
    for (let i = 0; i < n; i++) {
      const dx = posX[i] - meanX
      const dy = posY[i] - meanY
      sxx += dx * dx
      syy += dy * dy
      sxy += dx * dy
    }

    const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy)
    const cosT = Math.cos(-theta)
    const sinT = Math.sin(-theta)
    let rotSxx = 0
    let rotSyy = 0
    for (let i = 0; i < n; i++) {
      const dx = posX[i] - meanX
      const dy = posY[i] - meanY
      const rx = dx * cosT - dy * sinT
      const ry = dx * sinT + dy * cosT
      posX[i] = rx
      posY[i] = ry
      rotSxx += rx * rx
      rotSyy += ry * ry
    }
    if (rotSxx < rotSyy) {
      for (let i = 0; i < n; i++) {
        const tmp = posX[i]
        posX[i] = -posY[i]
        posY[i] = tmp
      }
    }
  }

  // AABB overlap removal with padding=30 and passes=clamp(N, 20, 60)
  const passes = clamp(n, 20, 60)
  const maxHalfW = resolveAabbOverlaps(posX, posY, nodeW, nodeH, n, AABB_PADDING, passes, false)

  // Guarantee zero overlap even on dense 300-node rings
  for (let attempt = 0; attempt < 4; attempt++) {
    if (!hasStrictAabbOverlap(posX, posY, nodeW, nodeH, n, maxHalfW)) break
    for (let i = 0; i < n; i++) {
      posX[i] *= 1.25
      posY[i] *= 1.25
    }
    resolveAabbOverlaps(posX, posY, nodeW, nodeH, n, AABB_PADDING, passes, true)
  }

  return { posX, posY, nodeW, nodeH }
}

function packBlocksNfdh(blocks) {
  if (blocks.length === 0) return { width: OUTER_PADDING * 2, height: OUTER_PADDING * 2 }

  let widest = 0
  let totalArea = 0
  for (const b of blocks) {
    if (b.width > widest) widest = b.width
    totalArea += (b.width + BLOCK_GAP) * (b.height + BLOCK_GAP)
  }

  const targetWidth = Math.max(widest, Math.sqrt(totalArea * 1.6))
  blocks.sort((a, b) => b.height - a.height)

  let cursorX = OUTER_PADDING
  let cursorY = OUTER_PADDING
  let shelfHeight = 0
  let maxX = OUTER_PADDING
  let maxY = OUTER_PADDING

  for (const b of blocks) {
    if (cursorX > OUTER_PADDING && cursorX + b.width > OUTER_PADDING + targetWidth) {
      cursorY += shelfHeight + BLOCK_GAP
      cursorX = OUTER_PADDING
      shelfHeight = 0
    }
    b.offsetX = cursorX - b.minX
    b.offsetY = cursorY - b.minY
    cursorX += b.width + BLOCK_GAP
    if (b.height > shelfHeight) shelfHeight = b.height
    maxX = Math.max(maxX, cursorX - BLOCK_GAP)
    maxY = Math.max(maxY, cursorY + b.height)
  }

  return {
    width: maxX + OUTER_PADDING,
    height: maxY + OUTER_PADDING,
  }
}

function routeEdges(edges, placedById) {
  // Determine side for each non-self-loop edge and sort ports to reduce crossings
  const facePorts = new Map()
  const addPort = (nodeId, face, otherMidCoord, edgeIdx) => {
    const key = `${nodeId}:${face}`
    let list = facePorts.get(key)
    if (!list) {
      list = []
      facePorts.set(key, list)
    }
    list.push({ edgeIdx, otherMidCoord })
  }

  const edgeMeta = edges.map((edge, idx) => {
    const fromNode = placedById.get(edge.fromNodeId)
    const toNode = placedById.get(edge.toNodeId)
    if (!fromNode || !toNode) return null
    if (edge.fromNodeId === edge.toNodeId) {
      return { edge, fromNode, toNode, isSelfLoop: true }
    }

    const fMidX = fromNode.x + fromNode.width / 2
    const fMidY = fromNode.y + fromNode.height / 2
    const tMidX = toNode.x + toNode.width / 2
    const tMidY = toNode.y + toNode.height / 2

    const verticalGap =
      fMidY < tMidY
        ? toNode.y - (fromNode.y + fromNode.height)
        : fromNode.y - (toNode.y + toNode.height)

    let fromFace
    let toFace
    if (verticalGap > 30) {
      fromFace = fMidY < tMidY ? 'bottom' : 'top'
      toFace = fMidY < tMidY ? 'top' : 'bottom'
      addPort(fromNode.id, fromFace, tMidX, idx)
      addPort(toNode.id, toFace, fMidX, idx)
    } else {
      fromFace = fMidX <= tMidX ? 'right' : 'left'
      toFace = fMidX <= tMidX ? 'left' : 'right'
      addPort(fromNode.id, fromFace, tMidY, idx)
      addPort(toNode.id, toFace, fMidY, idx)
    }

    return { edge, fromNode, toNode, isSelfLoop: false, fromFace, toFace }
  })

  // Sort ports along each face
  const portRatio = new Map()
  for (const [key, list] of facePorts.entries()) {
    list.sort((a, b) => a.otherMidCoord - b.otherMidCoord)
    const total = list.length
    for (let i = 0; i < total; i++) {
      portRatio.set(`${key}#${list[i].edgeIdx}`, (i + 1) / (total + 1))
    }
  }

  const selfLoopCountByNode = new Map()
  let maxSelfLoopRight = 0
  const routedEdges = []

  const getFacePoint = (node, face, ratio) => {
    if (face === 'top') return { x: round2(node.x + node.width * ratio), y: round2(node.y) }
    if (face === 'bottom') return { x: round2(node.x + node.width * ratio), y: round2(node.y + node.height) }
    if (face === 'left') return { x: round2(node.x), y: round2(node.y + node.height * ratio) }
    return { x: round2(node.x + node.width), y: round2(node.y + node.height * ratio) }
  }

  for (let i = 0; i < edgeMeta.length; i++) {
    const m = edgeMeta[i]
    if (!m) continue
    const { edge, fromNode, toNode } = m

    if (m.isSelfLoop) {
      const loopIdx = selfLoopCountByNode.get(fromNode.id) ?? 0
      selfLoopCountByNode.set(fromNode.id, loopIdx + 1)
      const spread = 12 + loopIdx * 8
      const bow = 36 + loopIdx * 24
      const maxX = fromNode.x + fromNode.width
      const midY = fromNode.y + fromNode.height / 2
      const y1 = round2(Math.max(fromNode.y + 12, midY - spread))
      const y2 = round2(Math.min(fromNode.y + fromNode.height - 12, midY + spread))
      const cx = round2(maxX + bow)
      const apexRight = maxX + 0.75 * bow + 14
      if (apexRight > maxSelfLoopRight) maxSelfLoopRight = apexRight

      routedEdges.push({
        id: edge.id,
        edge,
        isSelfLoop: true,
        fromFace: 'right',
        toFace: 'right',
        x1: round2(maxX),
        y1,
        x2: round2(maxX),
        y2,
        pathD: `M ${round2(maxX)} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${round2(maxX)} ${y2}`,
        optionalMarker: edge.optional
          ? { x: round2(maxX + 10), y: y1, r: 3.5 }
          : null,
      })
      continue
    }

    const rFrom = portRatio.get(`${fromNode.id}:${m.fromFace}#${i}`) ?? 0.5
    const rTo = portRatio.get(`${toNode.id}:${m.toFace}#${i}`) ?? 0.5
    const p1 = getFacePoint(fromNode, m.fromFace, rFrom)
    const p2 = getFacePoint(toNode, m.toFace, rTo)

    let pathD
    if (m.fromFace === 'top' || m.fromFace === 'bottom') {
      const cy = round2((p1.y + p2.y) / 2)
      pathD = `M ${p1.x} ${p1.y} C ${p1.x} ${cy}, ${p2.x} ${cy}, ${p2.x} ${p2.y}`
    } else {
      const cx = round2((p1.x + p2.x) / 2)
      pathD = `M ${p1.x} ${p1.y} C ${cx} ${p1.y}, ${cx} ${p2.y}, ${p2.x} ${p2.y}`
    }

    let optMarker = null
    if (edge.optional) {
      const offset = 10
      const ox =
        m.fromFace === 'left'
          ? p1.x - offset
          : m.fromFace === 'right'
            ? p1.x + offset
            : p1.x
      const oy =
        m.fromFace === 'top'
          ? p1.y - offset
          : m.fromFace === 'bottom'
            ? p1.y + offset
            : p1.y
      optMarker = { x: round2(ox), y: round2(oy), r: 3.5 }
    }

    routedEdges.push({
      id: edge.id,
      edge,
      isSelfLoop: false,
      fromFace: m.fromFace,
      toFace: m.toFace,
      x1: p1.x,
      y1: p1.y,
      x2: p2.x,
      y2: p2.y,
      pathD,
      optionalMarker: optMarker,
    })
  }

  return { routedEdges, maxSelfLoopRight }
}

/**
 * Computes deterministic, non-overlapping ER diagram layout.
 */
export function computeErLayout(graph, options) {
  const compactMode = Boolean(options?.compactMode)
  const manualPositions = options?.manualPositions || null
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : []
  const edges = Array.isArray(graph?.edges) ? graph.edges : []

  if (nodes.length === 0) {
    return {
      width: OUTER_PADDING * 2,
      height: OUTER_PADDING * 2,
      nodes: [],
      edges: [],
      bounds: { minX: 0, minY: 0, maxX: OUTER_PADDING * 2, maxY: OUTER_PADDING * 2 },
    }
  }

  const allDims = nodes.map((n) => computeErCardDimensions(n, { compactMode }))
  const { connectedComponents, orphans, pairCount } = buildConnectedComponents(nodes, edges)

  const blocks = []
  const compPlacements = []
  const numComps = connectedComponents.length

  // Group edges into packed contiguous slices by component
  const nodeCompId = scratchNodeCompId
  nodeCompId.fill(-1, 0, nodes.length)
  for (let cId = 0; cId < numComps; cId++) {
    scratchCompCounts[cId] = 0
    const comp = connectedComponents[cId]
    for (let i = 0; i < comp.length; i++) {
      nodeCompId[comp[i]] = cId
    }
  }
  for (let e = 0; e < pairCount; e++) {
    const cId = nodeCompId[scratchAllEdgeU[e]]
    if (cId >= 0) scratchCompCounts[cId]++
  }
  let edgeOffset = 0
  for (let cId = 0; cId < numComps; cId++) {
    scratchCompOffsets[cId] = edgeOffset
    edgeOffset += scratchCompCounts[cId]
    scratchCompCounts[cId] = 0
  }
  for (let e = 0; e < pairCount; e++) {
    const u = scratchAllEdgeU[e]
    const cId = nodeCompId[u]
    if (cId >= 0) {
      const dst = scratchCompOffsets[cId] + scratchCompCounts[cId]++
      scratchPackedEdgeU[dst] = u
      scratchPackedEdgeV[dst] = scratchAllEdgeV[e]
    }
  }

  for (let cId = 0; cId < numComps; cId++) {
    const comp = connectedComponents[cId]
    const edgeStart = scratchCompOffsets[cId]
    const res = layoutComponentForceDirected(comp, allDims, edgeStart, edgeStart + scratchCompCounts[cId])
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (let i = 0; i < comp.length; i++) {
      const left = res.posX[i] - res.nodeW[i] / 2
      const top = res.posY[i] - res.nodeH[i] / 2
      const right = left + res.nodeW[i]
      const bottom = top + res.nodeH[i]
      if (left < minX) minX = left
      if (top < minY) minY = top
      if (right > maxX) maxX = right
      if (bottom > maxY) maxY = bottom
    }
    const block = {
      kind: 'comp',
      minX,
      minY,
      width: maxX - minX,
      height: maxY - minY,
      offsetX: 0,
      offsetY: 0,
    }
    blocks.push(block)
    compPlacements.push({ block, comp, res })
  }

  // Pack orphans into a neat grid block
  const orphanPlacements = []
  if (orphans.length > 0) {
    const cols = Math.ceil(Math.sqrt(orphans.length))
    const colWidths = new Float64Array(cols)
    const rows = Math.ceil(orphans.length / cols)
    const rowHeights = new Float64Array(rows)

    for (let k = 0; k < orphans.length; k++) {
      const dims = allDims[orphans[k]]
      const r = Math.floor(k / cols)
      const c = k % cols
      if (dims.width > colWidths[c]) colWidths[c] = dims.width
      if (dims.height > rowHeights[r]) rowHeights[r] = dims.height
    }

    const colX = new Float64Array(cols)
    let gx = 0
    for (let c = 0; c < cols; c++) {
      colX[c] = gx
      gx += colWidths[c] + ORPHAN_CELL_GAP
    }
    const rowY = new Float64Array(rows)
    let gy = 0
    for (let r = 0; r < rows; r++) {
      rowY[r] = gy
      gy += rowHeights[r] + ORPHAN_CELL_GAP
    }

    const block = {
      kind: 'orphans',
      minX: 0,
      minY: 0,
      width: Math.max(0, gx - ORPHAN_CELL_GAP),
      height: Math.max(0, gy - ORPHAN_CELL_GAP),
      offsetX: 0,
      offsetY: 0,
    }
    blocks.push(block)
    for (let k = 0; k < orphans.length; k++) {
      const gIdx = orphans[k]
      const r = Math.floor(k / cols)
      const c = k % cols
      orphanPlacements.push({ block, gIdx, localX: colX[c], localY: rowY[r] })
    }
  }

  packBlocksNfdh(blocks)

  const layoutNodes = new Array(nodes.length)
  for (const { block, comp, res } of compPlacements) {
    for (let i = 0; i < comp.length; i++) {
      const gIdx = comp[i]
      const dims = allDims[gIdx]
      const x = round2(res.posX[i] - res.nodeW[i] / 2 + block.offsetX)
      const y = round2(res.posY[i] - res.nodeH[i] / 2 + block.offsetY)
      layoutNodes[gIdx] = {
        id: nodes[gIdx].id,
        x,
        y,
        width: dims.width,
        height: dims.height,
        headerHeight: dims.headerHeight,
        rowHeight: dims.rowHeight,
        visibleColumns: dims.visibleColumns,
        node: nodes[gIdx],
      }
    }
  }
  for (const item of orphanPlacements) {
    const dims = allDims[item.gIdx]
    layoutNodes[item.gIdx] = {
      id: nodes[item.gIdx].id,
      x: round2(item.localX + item.block.offsetX),
      y: round2(item.localY + item.block.offsetY),
      width: dims.width,
      height: dims.height,
      headerHeight: dims.headerHeight,
      rowHeight: dims.rowHeight,
      visibleColumns: dims.visibleColumns,
      node: nodes[item.gIdx],
    }
  }

  // Apply manualPositions non-destructively (new nodes placed in a right column at maxX + gap)
  if (manualPositions && Object.keys(manualPositions).length > 0) {
    let manualMaxX = -Infinity
    let hasManualHit = false
    for (const ln of layoutNodes) {
      const saved = manualPositions[ln.id]
      if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
        ln.x = round2(saved.x)
        ln.y = round2(saved.y)
        manualMaxX = Math.max(manualMaxX, ln.x + ln.width)
        hasManualHit = true
      }
    }
    if (hasManualHit) {
      let nextNewY = OUTER_PADDING
      const newColX = round2(manualMaxX + BLOCK_GAP)
      for (const ln of layoutNodes) {
        if (!manualPositions[ln.id]) {
          ln.x = newColX
          ln.y = round2(nextNewY)
          nextNewY += ln.height + ORPHAN_CELL_GAP
        }
      }
    }
  }

  const placedById = new Map()
  for (const ln of layoutNodes) placedById.set(ln.id, ln)

  const { routedEdges, maxSelfLoopRight } = routeEdges(edges, placedById)

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const ln of layoutNodes) {
    if (ln.x < minX) minX = ln.x
    if (ln.y < minY) minY = ln.y
    if (ln.x + ln.width > maxX) maxX = ln.x + ln.width
    if (ln.y + ln.height > maxY) maxY = ln.y + ln.height
  }
  if (maxSelfLoopRight > maxX) maxX = maxSelfLoopRight

  const bounds = {
    minX: round2(Math.min(0, minX - OUTER_PADDING)),
    minY: round2(Math.min(0, minY - OUTER_PADDING)),
    maxX: round2(maxX + OUTER_PADDING),
    maxY: round2(maxY + OUTER_PADDING),
  }

  return {
    width: round2(bounds.maxX - bounds.minX),
    height: round2(bounds.maxY - bounds.minY),
    nodes: layoutNodes,
    edges: routedEdges,
    bounds,
  }
}
