// src/shared-explain-svg.js
// Pure zero-foreignObject Visual EXPLAIN SVG layout, Copy SVG & external HTML popover data.
// Zero Node built-ins, zero .ts imports.

export const EXPLAIN_SVG_NODE_WIDTH = 196
export const EXPLAIN_SVG_NODE_HEIGHT = 56
export const EXPLAIN_SVG_NODE_HEIGHT_WITH_SUB = 68
export const EXPLAIN_SVG_H_GAP = 20
export const EXPLAIN_SVG_V_GAP = 28
export const EXPLAIN_SVG_PADDING = 20

export const DEFAULT_EXPLAIN_SVG_PALETTE = Object.freeze({
  bg: '#141415',
  cardBg: '#19191b',
  cardBorder: '#2c2c30',
  textPrimary: '#ededed',
  textMuted: '#8e8e95',
  edgeStroke: '#46464d',
  critical: '#e5484d',
  high: '#f0883e',
  moderate: '#d4a72c',
  low: '#4cc38a',
  neutral: '#71717a',
})

function escapeXml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function truncateLabel(text, maxChars) {
  const s = String(text ?? '')
  return s.length > maxChars ? `${s.slice(0, maxChars - 1)}…` : s
}

function round2(n) {
  return Math.round(n * 100) / 100
}

function getNodeSubtitle(node) {
  return String(node?.relation || node?.indexName || node?.joinType || '').trim()
}

function resolveNodeHeight(node, explicitNodeHeight) {
  if (typeof explicitNodeHeight === 'number' && Number.isFinite(explicitNodeHeight) && explicitNodeHeight > 0) {
    return explicitNodeHeight
  }
  return getNodeSubtitle(node) ? EXPLAIN_SVG_NODE_HEIGHT_WITH_SUB : EXPLAIN_SVG_NODE_HEIGHT
}

/**
 * Computes a compact top-down tree layout (nodeWidth=196, dynamic nodeHeight=56/68, hGap=20, vGap=28).
 */
export function layoutExplainPlanTree(root, options) {
  const nodeWidth = options?.nodeWidth ?? EXPLAIN_SVG_NODE_WIDTH
  const explicitNodeHeight = options?.nodeHeight
  const hGap = options?.hGap ?? EXPLAIN_SVG_H_GAP
  const vGap = options?.vGap ?? EXPLAIN_SVG_V_GAP
  const padding = options?.padding ?? EXPLAIN_SVG_PADDING

  if (!root) {
    return { width: padding * 2, height: padding * 2, nodes: [], edges: [] }
  }

  const subtreeWidthMap = new WeakMap()
  const depthMaxHeight = []
  function measureSubtree(node, depth) {
    const h = resolveNodeHeight(node, explicitNodeHeight)
    if (depthMaxHeight[depth] === undefined || h > depthMaxHeight[depth]) {
      depthMaxHeight[depth] = h
    }
    const children = Array.isArray(node.children) ? node.children : []
    if (children.length === 0) {
      subtreeWidthMap.set(node, nodeWidth)
      return nodeWidth
    }
    let total = 0
    for (let i = 0; i < children.length; i++) {
      if (i > 0) total += hGap
      total += measureSubtree(children[i], depth + 1)
    }
    const w = Math.max(nodeWidth, total)
    subtreeWidthMap.set(node, w)
    return w
  }
  measureSubtree(root, 0)

  const depthTopY = []
  let yCursor = padding
  for (let d = 0; d < depthMaxHeight.length; d++) {
    depthTopY[d] = round2(yCursor)
    yCursor += (depthMaxHeight[d] ?? EXPLAIN_SVG_NODE_HEIGHT) + vGap
  }

  const layoutNodes = []
  const layoutEdges = []
  let maxRight = padding
  let maxBottom = padding

  function assignPositions(node, leftX, depth) {
    const subW = subtreeWidthMap.get(node) || nodeWidth
    const nodeHeight = resolveNodeHeight(node, explicitNodeHeight)
    const x = round2(leftX + (subW - nodeWidth) / 2)
    const y = depthTopY[depth] ?? round2(padding + depth * (EXPLAIN_SVG_NODE_HEIGHT + vGap))
    maxRight = Math.max(maxRight, x + nodeWidth)
    maxBottom = Math.max(maxBottom, y + nodeHeight)

    const placed = {
      id: node.id,
      x,
      y,
      width: nodeWidth,
      height: nodeHeight,
      node,
    }
    layoutNodes.push(placed)

    const children = Array.isArray(node.children) ? node.children : []
    let cursorX = leftX
    for (const child of children) {
      const childSubW = subtreeWidthMap.get(child) || nodeWidth
      const childPlaced = assignPositions(child, cursorX, depth + 1)
      const x1 = round2(x + nodeWidth / 2)
      const y1 = round2(y + nodeHeight)
      const x2 = round2(childPlaced.x + nodeWidth / 2)
      const y2 = round2(childPlaced.y)
      const cy = round2((y1 + y2) / 2)
      layoutEdges.push({
        fromId: node.id,
        toId: child.id,
        x1,
        y1,
        x2,
        y2,
        pathD: `M ${x1} ${round2(y1 + 2)} C ${x1} ${cy}, ${x2} ${cy}, ${x2} ${y2}`,
      })
      cursorX += childSubW + hGap
    }
    return placed
  }

  assignPositions(root, padding, 0)

  return {
    width: round2(maxRight + padding),
    height: round2(maxBottom + padding),
    nodes: layoutNodes,
    edges: layoutEdges,
  }
}

export function buildExplainNodePopoverData(node) {
  const details = []
  if (node.details) {
    for (const [k, v] of Object.entries(node.details)) {
      details.push({ key: k, value: String(v) })
    }
  }
  return {
    id: node.id,
    title: node.nodeType,
    subtitle: [node.relation, node.indexName ? `via ${node.indexName}` : ''].filter(Boolean).join(' '),
    severity: node.severity || 'neutral',
    warnings: Array.isArray(node.warnings) ? [...node.warnings] : [],
    metrics: {
      exclusiveCost: node.exclusiveCost ?? null,
      totalCost: node.totalCost ?? null,
      costFraction: node.costFraction ?? null,
      exclusiveTimeMs: node.exclusiveTimeMs ?? null,
      actualTotalTimeMs: node.actualTotalTimeMs ?? null,
      timeFraction: node.timeFraction ?? null,
      planRows: node.planRows ?? null,
      totalActualRows: node.totalActualRows ?? null,
      actualLoops: node.actualLoops ?? null,
      processCount: node.processCount ?? 1,
    },
    details,
  }
}

export function clampExplainViewport(viewport, contentWidth, contentHeight, containerSize) {
  const scale = Math.min(4, Math.max(0.2, Number.isFinite(viewport?.scale) ? viewport.scale : 1))
  const viewW = containerSize?.width ?? contentWidth
  const viewH = containerSize?.height ?? contentHeight
  const minX = -Math.max(contentWidth * scale, viewW)
  const maxX = Math.max(viewW, contentWidth * scale)
  const minY = -Math.max(contentHeight * scale, viewH)
  const maxY = Math.max(viewH, contentHeight * scale)
  const rawX = Number.isFinite(viewport?.x) ? viewport.x : 0
  const rawY = Number.isFinite(viewport?.y) ? viewport.y : 0
  return {
    x: round2(Math.min(maxX, Math.max(minX, rawX))),
    y: round2(Math.min(maxY, Math.max(minY, rawY))),
    scale: round2(scale),
  }
}

/**
 * Generates pure zero-foreignObject SVG markup for Visual EXPLAIN.
 */
export function renderExplainPlanSvg(plan, options) {
  const palette = { ...DEFAULT_EXPLAIN_SVG_PALETTE, ...(options?.palette || {}) }
  const layout = layoutExplainPlanTree(plan?.root ?? null, options)

  const summary = {
    format: plan?.format || 'raw-text',
    nodeCount: plan?.nodeCount ?? layout.nodes.length,
    planningTimeMs: plan?.planningTimeMs ?? null,
    executionTimeMs: plan?.executionTimeMs ?? null,
    totalCost: plan?.totalCost ?? null,
    totalActualTimeMs: plan?.totalActualTimeMs ?? null,
    warningCount: layout.nodes.reduce((n, item) => n + (item.node.warnings?.length ?? 0), 0),
  }

  const edgeSvg = layout.edges
    .map((e) => {
      const axL = round2(e.x1 - 3.5)
      const axR = round2(e.x1 + 3.5)
      const ayTip = round2(e.y1 + 1.5)
      const ayBase = round2(e.y1 + 6)
      return [
        `<g class="datanoa-explain-edge">`,
        `<path d="${e.pathD}" fill="none" stroke="${palette.edgeStroke}" stroke-width="1.25" stroke-linecap="round"/>`,
        `<path d="M ${axL} ${ayBase} L ${e.x1} ${ayTip} L ${axR} ${ayBase}" fill="none" stroke="${palette.edgeStroke}" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>`,
        `<circle cx="${e.x2}" cy="${e.y2}" r="2" fill="${palette.edgeStroke}"/>`,
        `</g>`,
      ].join('')
    })
    .join('')

  const nodeSvg = layout.nodes
    .map(({ x, y, width, height, node }) => {
      const sev = node.severity || 'neutral'
      const accent = palette[sev] || palette.neutral
      const frac = node.timeFraction ?? node.costFraction
      const pctNum = typeof frac === 'number' && Number.isFinite(frac) ? Math.round(frac * 100) : null
      const pctStr = pctNum !== null ? `${pctNum}%` : ''
      const isHot = sev === 'critical' || sev === 'high' || sev === 'moderate'
      const dotColor = isHot ? accent : pctNum && pctNum > 0 ? accent : palette.neutral
      const pctColor = isHot ? accent : palette.textMuted
      const rawSub = getNodeSubtitle(node)
      const hasSub = rawSub.length > 0
      const title = escapeXml(truncateLabel(node.nodeType, pctStr ? 18 : 23))
      const sub = hasSub ? escapeXml(truncateLabel(rawSub, 26)) : ''
      const metricLine = escapeXml(
        truncateLabel(
          [
            node.exclusiveTimeMs != null ? `${round2(node.exclusiveTimeMs)}ms` : '',
            node.totalCost != null ? `cost ${round2(node.totalCost)}` : '',
            node.totalActualRows != null ? `rows ${Math.round(node.totalActualRows)}` : '',
          ]
            .filter(Boolean)
            .join(' · '),
          node.warnings?.length ? 22 : 27
        )
      )
      const barTrackWidth = Math.max(0, width - 24)
      const barRatio = typeof frac === 'number' && Number.isFinite(frac) ? Math.min(1, Math.max(0, frac)) : 0
      const barWidth = barRatio > 0 ? Math.max(3, round2(barTrackWidth * barRatio)) : 0
      const barY = round2(height - 9)
      const metricY = hasSub ? 50 : 37
      const warnCount = node.warnings?.length ?? 0
      const ariaLabel = escapeXml(
        [
          node.nodeType || 'Plan node',
          rawSub,
          pctStr,
          warnCount > 0 ? `${warnCount} warning${warnCount === 1 ? '' : 's'}` : '',
        ]
          .filter(Boolean)
          .join(' · ')
      )

      return [
        `<g class="datanoa-explain-node" data-node-id="${escapeXml(node.id)}" data-severity="${escapeXml(sev)}" tabindex="0" role="button" aria-label="${ariaLabel}" transform="translate(${x},${y})">`,
        `<rect class="datanoa-explain-node-card" x="0.5" y="0.5" width="${round2(width - 1)}" height="${round2(height - 1)}" rx="8" fill="${palette.cardBg}" stroke="${palette.cardBorder}" stroke-width="1"/>`,
        `<circle cx="15" cy="16" r="3" fill="${dotColor}"/>`,
        `<text x="24" y="20" fill="${palette.textPrimary}" font-family="'Geist',system-ui,-apple-system,sans-serif" font-size="12" font-weight="500">${title}</text>`,
        pctStr
          ? `<text x="${width - 12}" y="20" text-anchor="end" fill="${pctColor}" font-family="'SF Mono',ui-monospace,monospace" font-size="11" font-weight="500">${escapeXml(pctStr)}</text>`
          : '',
        sub
          ? `<text x="12" y="35" fill="${palette.textMuted}" font-family="'Geist',system-ui,-apple-system,sans-serif" font-size="11">${sub}</text>`
          : '',
        metricLine
          ? `<text x="12" y="${metricY}" fill="${palette.textMuted}" font-family="'SF Mono',ui-monospace,monospace" font-size="10.5">${metricLine}</text>`
          : '',
        warnCount > 0
          ? `<circle cx="${width - 15}" cy="${round2(metricY - 3.5)}" r="3.5" fill="${palette.high}"><title>${escapeXml(node.warnings.join(', '))}</title></circle>`
          : '',
        `<rect x="12" y="${barY}" width="${barTrackWidth}" height="3" rx="1.5" fill="${palette.cardBorder}" opacity="0.65"/>`,
        barWidth > 0
          ? `<rect x="12" y="${barY}" width="${barWidth}" height="3" rx="1.5" fill="${accent}"/>`
          : '',
        `</g>`,
      ].join('')
    })
    .join('')

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}">`,
    `<rect class="datanoa-explain-svg-bg" x="0" y="0" width="${layout.width}" height="${layout.height}" fill="${palette.bg}"/>`,
    `<g class="datanoa-explain-edges">${edgeSvg}</g>`,
    `<g class="datanoa-explain-nodes">${nodeSvg}</g>`,
    `</svg>`,
  ].join('')

  return {
    svg,
    width: layout.width,
    height: layout.height,
    summary,
    nodes: layout.nodes,
    edges: layout.edges,
  }
}
