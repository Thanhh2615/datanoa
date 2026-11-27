// src/shared-er-exporters.js
// Pure ER Diagram exporters: Mermaid 11.6+ (.mmd), Graphviz DOT (.gv),
// zero-foreignObject SVG (.svg), and clamped/cleaned PNG rasterization helpers.
// Zero Node built-ins, zero .ts imports.

import { computeErCardDimensions } from './shared-er-diagram.js'
import { computeErLayout } from './shared-er-layout.js'

export const DEFAULT_ER_DARK_PALETTE = Object.freeze({
  bg: '#14171d',
  cardBg: '#1c212b',
  headerBg: '#242b38',
  stubBg: '#19202a',
  border: '#334155',
  textPrimary: '#e6ebf2',
  textMuted: '#94a3b8',
  pkColor: '#fbbf24',
  fkColor: '#60a5fa',
  ukColor: '#34d399',
  edgeStroke: '#64748b',
  crossSchemaStroke: '#a78bfa',
})

export const DEFAULT_ER_LIGHT_PALETTE = Object.freeze({
  bg: '#f8fafc',
  cardBg: '#ffffff',
  headerBg: '#f1f5f9',
  stubBg: '#f8fafc',
  border: '#cbd5e1',
  textPrimary: '#0f172a',
  textMuted: '#475569',
  pkColor: '#b45309',
  fkColor: '#2563eb',
  ukColor: '#059669',
  edgeStroke: '#64748b',
  crossSchemaStroke: '#7c3aed',
})

function round2(n) {
  return Math.round(n * 100) / 100
}

function stripXmlIllegalScalars(text) {
  let out = ''
  const s = String(text ?? '')
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    // Skip lone surrogates cleanly
    if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 < s.length) {
        const next = s.charCodeAt(i + 1)
        if (next >= 0xdc00 && next <= 0xdfff) {
          out += s[i] + s[i + 1]
          i++
          continue
        }
      }
      continue
    }
    if (code >= 0xdc00 && code <= 0xdfff) continue
    // XML 1.0 valid scalars: 0x9, 0xA, 0xD, >= 0x20 excluding 0xFFFE/0xFFFF
    if (
      code === 0x9 ||
      code === 0xa ||
      code === 0xd ||
      (code >= 0x20 && code !== 0xfffe && code !== 0xffff)
    ) {
      out += s[i]
    }
  }
  return out
}

function escapeXml(text) {
  return stripXmlIllegalScalars(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// ---------------------------------------------------------------------------
// 1. Mermaid 11.6+ (.mmd)
// ---------------------------------------------------------------------------

function neutralizeMermaidDirection(text) {
  return String(text ?? '').replace(/(direction)\s+(TB|BT|RL|LR)/gi, '$1_$2')
}

function formatMermaidEntityBase(node) {
  const base = node.schema && node.schema !== 'public' ? `${node.schema}.${node.name}` : node.name
  return (
    neutralizeMermaidDirection(stripXmlIllegalScalars(base))
      .replace(/"/g, "'")
      .replace(/[\r\n]+/g, ' ')
      .trim() || 'entity'
  )
}

function sanitizeMermaidAttrType(rawType) {
  const clean = neutralizeMermaidDirection(stripXmlIllegalScalars(rawType || 'any'))
    .replace(/[^A-Za-z0-9_(),.-]/g, '_')
    .replace(/^_+|_+$/g, '')
  return clean || 'any'
}

function sanitizeMermaidAttrName(rawName, seen) {
  let clean = neutralizeMermaidDirection(stripXmlIllegalScalars(rawName || 'col'))
    .replace(/[^A-Za-z0-9_]/g, '_')
  if (!clean) clean = 'col'
  if (/^(?:pk|fk|uk)/i.test(clean)) {
    clean = `_${clean}`
  }
  let candidate = clean
  let suffix = 2
  while (seen.has(candidate.toLowerCase())) {
    candidate = `${clean}_${suffix}`
    suffix++
  }
  seen.add(candidate.toLowerCase())
  return candidate
}

function mermaidCardinality(edge) {
  if (edge.isManyToMany) return '}o--o{'
  if (edge.unique && !edge.optional) return '||--||'
  if (edge.unique && edge.optional) return '||--o|'
  if (!edge.unique && !edge.optional) return '||--|{'
  return '||--o{'
}

export function exportErToMermaid(graph) {
  const lines = ['erDiagram']
  const nodes = graph?.nodes || []
  const edges = graph?.edges || []
  const entityById = new Map()
  const seenEntities = new Set()

  for (const node of nodes) {
    const baseEntity = formatMermaidEntityBase(node)
    let uniqueEntity = baseEntity
    let suffix = 2
    while (seenEntities.has(uniqueEntity)) {
      uniqueEntity = `${baseEntity}_${suffix}`
      suffix++
    }
    seenEntities.add(uniqueEntity)
    const qName = `"${uniqueEntity}"`
    entityById.set(node.id, qName)
    lines.push(`  ${qName} {`)
    const seenCols = new Set()
    for (const col of node.columns || []) {
      const t = sanitizeMermaidAttrType(col.type)
      const name = sanitizeMermaidAttrName(col.name, seenCols)
      const keys = []
      if (col.isPrimaryKey) keys.push('PK')
      if (col.isForeignKey) keys.push('FK')
      if (col.isUnique && !col.isPrimaryKey) keys.push('UK')
      const keyStr = keys.length > 0 ? ` ${keys.join(',')}` : ''
      lines.push(`    ${t} ${name}${keyStr}`)
    }
    lines.push('  }')
  }

  for (const edge of edges) {
    const toName = entityById.get(edge.toNodeId)
    const fromName = entityById.get(edge.fromNodeId)
    if (!toName || !fromName) continue
    const card = mermaidCardinality(edge)
    const rawLabel = edge.junctionTable
      ? edge.junctionTable
      : edge.columnPairs.map((p) => p.fromColumn).join(', ')
    const safeLabel = neutralizeMermaidDirection(stripXmlIllegalScalars(rawLabel))
      .replace(/"/g, "'")
      .replace(/[\r\n]+/g, ' ')
      .trim() || 'rel'
    lines.push(`  ${toName} ${card} ${fromName} : "${safeLabel}"`)
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// 2. Graphviz DOT (.gv)
// ---------------------------------------------------------------------------

function escapeDotHtmlLabel(text) {
  return escapeXml(stripXmlIllegalScalars(text)).replace(/\\/g, '\\\\')
}

function sanitizeDotNodeId(id) {
  return `n_${String(id).replace(/[^A-Za-z0-9_]/g, '_')}`
}

function sanitizeDotPort(colName) {
  return `p_${stripXmlIllegalScalars(colName).replace(/:/g, '_').replace(/[^A-Za-z0-9_]/g, '_')}`
}

function dotArrowForEdge(edge) {
  if (edge.isManyToMany) {
    return { arrowhead: 'crowodot', arrowtail: 'crowodot' }
  }
  const childArrow = edge.unique
    ? edge.optional
      ? 'teeodot'
      : 'teetee'
    : edge.optional
      ? 'crowodot'
      : 'crowtee'
  return { arrowhead: childArrow, arrowtail: 'teetee' }
}

function allocateUniqueDotId(baseId, seen) {
  let candidate = baseId
  let suffix = 2
  while (seen.has(candidate)) {
    candidate = `${baseId}_${suffix}`
    suffix++
  }
  seen.add(candidate)
  return candidate
}

function resolveMappedDotPort(portMap, colName) {
  if (!colName) return ''
  if (portMap) {
    if (portMap.has(colName)) return portMap.get(colName)
    const lower = colName.toLowerCase()
    const ciMatches = []
    for (const [k, v] of portMap.entries()) {
      if (k.toLowerCase() === lower) ciMatches.push(v)
    }
    if (ciMatches.length === 1) return ciMatches[0]
  }
  return sanitizeDotPort(colName)
}

export function exportErToGraphvizDot(graph) {
  const nodes = graph?.nodes || []
  const edges = graph?.edges || []
  const lines = [
    'digraph ER {',
    '  graph [rankdir=LR, splines=ortho, nodesep=0.5, ranksep=0.8];',
    '  node [shape=plaintext, fontname="Helvetica"];',
    '  edge [dir=both, fontname="Helvetica", fontsize=10];',
  ]

  const dotNodeIdByNodeId = new Map()
  const seenDotNodeIds = new Set()
  const dotPortMapByNodeId = new Map()

  for (const node of nodes) {
    const dotId = allocateUniqueDotId(sanitizeDotNodeId(node.id), seenDotNodeIds)
    dotNodeIdByNodeId.set(node.id, dotId)
    const seenPorts = new Set()
    const portMap = new Map()
    dotPortMapByNodeId.set(node.id, portMap)

    const title = escapeDotHtmlLabel(
      node.schema && node.schema !== 'public' ? `${node.schema}.${node.name}` : node.name
    )
    const rowsHtml = (node.columns || [])
      .map((col) => {
        const port = allocateUniqueDotId(sanitizeDotPort(col.name), seenPorts)
        if (!portMap.has(col.name)) {
          portMap.set(col.name, port)
        }
        const prefix = col.isPrimaryKey ? 'PK ' : col.isForeignKey ? 'FK ' : ''
        const label = escapeDotHtmlLabel(`${prefix}${col.name}`)
        const typeStr = escapeDotHtmlLabel(col.type || '')
        return `<TR><TD ALIGN="LEFT" PORT="${port}">${label}</TD><TD ALIGN="RIGHT">${typeStr}</TD></TR>`
      })
      .join('')
    lines.push(
      `  ${dotId} [label=<<TABLE BORDER="1" CELLBORDER="0" CELLSPACING="0" CELLPADDING="4"><TR><TD COLSPAN="2" BGCOLOR="#1f2937"><FONT COLOR="#f8fafc"><B>${title}</B></FONT></TD></TR>${rowsHtml}</TABLE>>];`
    )
  }

  for (const edge of edges) {
    const fromId = dotNodeIdByNodeId.get(edge.fromNodeId)
    const toId = dotNodeIdByNodeId.get(edge.toNodeId)
    if (!fromId || !toId) continue
    const firstPair = edge.columnPairs?.[0]
    const fromPort = firstPair
      ? `:${resolveMappedDotPort(dotPortMapByNodeId.get(edge.fromNodeId), firstPair.fromColumn)}`
      : ''
    const toPort = firstPair
      ? `:${resolveMappedDotPort(dotPortMapByNodeId.get(edge.toNodeId), firstPair.toColumn)}`
      : ''
    const arrows = dotArrowForEdge(edge)
    const label = escapeDotHtmlLabel(edge.constraintName || '')
    lines.push(
      `  ${toId}${toPort} -> ${fromId}${fromPort} [arrowhead=${arrows.arrowhead}, arrowtail=${arrows.arrowtail}, label="${label}"];`
    )
  }

  lines.push('}')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// 3. Pure Zero-foreignObject SVG (.svg)
// ---------------------------------------------------------------------------

function layoutNeedsFullDetailRelayout(layout, graph) {
  const layoutNodes = Array.isArray(layout?.nodes) ? layout.nodes : []
  const graphNodes = Array.isArray(graph?.nodes) ? graph.nodes : []
  if (graphNodes.length > 0 && layoutNodes.length === 0) {
    return true
  }
  for (const ln of layoutNodes) {
    if (!ln?.node) continue
    const fullDims = computeErCardDimensions(ln.node, { compactMode: false })
    const totalCols = Array.isArray(ln.node.columns) ? ln.node.columns.length : 0
    const visibleCols = Array.isArray(ln.visibleColumns) ? ln.visibleColumns.length : totalCols
    if (fullDims.width > ln.width || fullDims.height > ln.height || visibleCols < totalCols) {
      return true
    }
  }
  return false
}

function resolveSvgExportLayout(graph, layout, options) {
  if (layoutNeedsFullDetailRelayout(layout, graph) && graph && Array.isArray(graph.nodes)) {
    const manualPositions = options?.manualPositions ?? options?.layoutOptions?.manualPositions
    return computeErLayout(graph, {
      ...(options?.layoutOptions || {}),
      ...(manualPositions ? { manualPositions } : {}),
      compactMode: false,
    })
  }
  return layout
}

export function exportErToSvg(graph, layout, options) {
  const palette = { ...DEFAULT_ER_DARK_PALETTE, ...(options?.palette || {}) }
  const resolvedLayout = resolveSvgExportLayout(graph, layout, options)
  const layoutNodes = resolvedLayout?.nodes || []
  const rawBounds = resolvedLayout?.bounds || { minX: 0, minY: 0, maxX: 400, maxY: 300 }

  let minXRaw = Number.isFinite(rawBounds.minX) ? rawBounds.minX : 0
  let minYRaw = Number.isFinite(rawBounds.minY) ? rawBounds.minY : 0
  let maxXRaw = Number.isFinite(rawBounds.maxX) ? rawBounds.maxX : 400
  let maxYRaw = Number.isFinite(rawBounds.maxY) ? rawBounds.maxY : 300

  const renderedNodes = layoutNodes.map((ln) => {
    const node = ln.node
    const fullDims = computeErCardDimensions(node, { compactMode: false })
    const w = round2(Math.max(ln.width, fullDims.width))
    const h = round2(Math.max(ln.height, fullDims.height))
    const x = round2(ln.x)
    const y = round2(ln.y)
    if (x - 24 < minXRaw) minXRaw = x - 24
    if (y - 24 < minYRaw) minYRaw = y - 24
    if (x + w + 24 > maxXRaw) maxXRaw = x + w + 24
    if (y + h + 24 > maxYRaw) maxYRaw = y + h + 24
    return { ln, node, fullDims, w, h, x, y }
  })

  const width = round2(Math.max(100, maxXRaw - minXRaw))
  const height = round2(Math.max(100, maxYRaw - minYRaw))
  const minX = round2(minXRaw)
  const minY = round2(minYRaw)

  const edgesSvg = (resolvedLayout?.edges || [])
    .map((re) => {
      const stroke = re.edge.crossSchema ? palette.crossSchemaStroke : palette.edgeStroke
      const dash = re.edge.crossSchema ? ' stroke-dasharray="5,3"' : ''
      const marker = re.optionalMarker
        ? `<circle cx="${round2(re.optionalMarker.x)}" cy="${round2(re.optionalMarker.y)}" r="${round2(re.optionalMarker.r)}" fill="${palette.bg}" stroke="${stroke}" stroke-width="1.5"/>`
        : ''
      return `<path d="${re.pathD}" fill="none" stroke="${stroke}" stroke-width="1.5"${dash}/>${marker}`
    })
    .join('')

  // Export always renders detail=true (all columns)
  const nodesSvg = renderedNodes
    .map(({ node, fullDims, w, h, x, y }) => {
      const isStub = node.kind === 'external_stub'
      const cardFill = isStub ? palette.stubBg : palette.cardBg
      const dashAttr = isStub ? ' stroke-dasharray="4,3"' : ''
      const title = escapeXml(
        node.schema && node.schema !== 'public' ? `${node.schema}.${node.name}` : node.name
      )

      const colsSvg = (node.columns || [])
        .map((col, idx) => {
          const ry = round2(fullDims.headerHeight + 16 + idx * fullDims.rowHeight)
          const badge = col.isPrimaryKey ? 'PK' : col.isForeignKey ? 'FK' : col.isUnique ? 'UK' : ''
          const badgeColor = col.isPrimaryKey
            ? palette.pkColor
            : col.isForeignKey
              ? palette.fkColor
              : palette.ukColor
          return [
            badge
              ? `<text x="10" y="${ry}" fill="${badgeColor}" font-family="ui-monospace,monospace" font-size="10" font-weight="700">${badge}</text>`
              : '',
            `<text x="${badge ? 32 : 10}" y="${ry}" fill="${palette.textPrimary}" font-family="system-ui,sans-serif" font-size="11.5">${escapeXml(col.name)}</text>`,
            col.type
              ? `<text x="${round2(w - 10)}" y="${ry}" text-anchor="end" fill="${palette.textMuted}" font-family="ui-monospace,monospace" font-size="10.5">${escapeXml(col.type)}</text>`
              : '',
          ].join('')
        })
        .join('')

      return [
        `<g class="datanoa-er-card" data-node-id="${escapeXml(node.id)}" transform="translate(${x},${y})">`,
        `<rect x="0" y="0" width="${w}" height="${h}" rx="6" fill="${cardFill}" stroke="${palette.border}" stroke-width="1.2"${dashAttr}/>`,
        `<rect x="0" y="0" width="${w}" height="${fullDims.headerHeight}" rx="6" fill="${palette.headerBg}"/>`,
        `<text x="10" y="20" fill="${palette.textPrimary}" font-family="system-ui,sans-serif" font-size="12.5" font-weight="700">${title}</text>`,
        colsSvg,
        `</g>`,
      ].join('')
    })
    .join('')

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${minX} ${minY} ${width} ${height}">`,
    `<rect x="${minX}" y="${minY}" width="${width}" height="${height}" fill="${palette.bg}"/>`,
    `<g class="datanoa-er-edges">${edgesSvg}</g>`,
    `<g class="datanoa-er-nodes">${nodesSvg}</g>`,
    `</svg>`,
  ].join('')
}

// ---------------------------------------------------------------------------
// 4. PNG Scale Clamp & Canvas Cleanup Helpers (.png)
// ---------------------------------------------------------------------------

export function computeErPngExportScale(width, height) {
  const w = Number(width)
  const h = Number(height)
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return { scale: 1, targetWidth: 1, targetHeight: 1 }
  }
  const scale = Math.min(
    2.0,
    16384 / w,
    16384 / h,
    Math.sqrt(33_554_432 / (w * h))
  )
  const targetWidth = Math.max(1, Math.floor(w * scale))
  const targetHeight = Math.max(1, Math.floor(h * scale))
  return { scale, targetWidth, targetHeight }
}

/**
 * Rasterizes pure SVG to PNG ArrayBuffer with strict canvas & objectURL cleanup in finally.
 */
export async function rasterizeErSvgToPngArrayBuffer(svgString, width, height, env) {
  const { targetWidth, targetHeight } = computeErPngExportScale(width, height)
  const createCanvas =
    env?.createCanvas || (() => document.createElement('canvas'))
  const createImage =
    env?.createImage || (() => new Image())
  const createObjectURL =
    env?.createObjectURL || ((blob) => URL.createObjectURL(blob))
  const revokeObjectURL =
    env?.revokeObjectURL || ((url) => URL.revokeObjectURL(url))

  const canvas = createCanvas()
  canvas.width = targetWidth
  canvas.height = targetHeight
  let objectUrl = ''

  try {
    const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' })
    objectUrl = createObjectURL(svgBlob)

    await new Promise((resolve, reject) => {
      const img = createImage()
      img.onload = () => {
        try {
          const ctx = canvas.getContext('2d')
          if (!ctx) {
            reject(new Error('Canvas 2D context unavailable'))
            return
          }
          ctx.drawImage(img, 0, 0, targetWidth, targetHeight)
          resolve()
        } catch (err) {
          reject(err)
        }
      }
      img.onerror = () => reject(new Error('Failed to load SVG into Image for PNG export'))
      img.src = objectUrl
    })

    const pngBlob = await new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob)
          else reject(new Error('Canvas toBlob returned null'))
        },
        'image/png'
      )
    })

    return await pngBlob.arrayBuffer()
  } finally {
    canvas.width = 0
    canvas.height = 0
    if (objectUrl) {
      revokeObjectURL(objectUrl)
    }
  }
}
