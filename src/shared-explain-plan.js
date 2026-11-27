// src/shared-explain-plan.js
// Visual EXPLAIN metric normalization, bottleneck detection & pure-JS UTF-8 IPC compaction.
// Zero Node built-ins, zero .ts imports.

import {
  EXPLAIN_SIGNIFICANT_ZERO_KEYS,
  ExplainPlanParserRegistry,
  getReportedNodeTotals,
  parseRawExplainInput,
  parseXmlStrict,
} from './shared-explain-parsers.js'

export { EXPLAIN_SIGNIFICANT_ZERO_KEYS, ExplainPlanParserRegistry, parseXmlStrict }

export const EXPLAIN_IPC_TARGET_BYTES = 140 * 1024
export const EXPLAIN_IPC_HARD_CAP_BYTES = 150 * 1024

const SIGNIFICANT_ZERO_SET = new Set(EXPLAIN_SIGNIFICANT_ZERO_KEYS)

/**
 * Pure-JS UTF-8 byte counter (works identically in Worker, Browser Side Panel, and Node).
 */
export function utf8ByteLength(str) {
  if (typeof str !== 'string' || str.length === 0) return 0
  let bytes = 0
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i)
    if (code <= 0x7f) {
      bytes += 1
    } else if (code <= 0x7ff) {
      bytes += 2
    } else if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 < str.length) {
        const next = str.charCodeAt(i + 1)
        if (next >= 0xdc00 && next <= 0xdfff) {
          bytes += 4
          i++
          continue
        }
      }
      bytes += 3
    } else {
      bytes += 3
    }
  }
  return bytes
}

function addWarning(list, badge) {
  if (!list.includes(badge)) list.push(badge)
}

function detectNodeBottlenecks(node) {
  const warnings = Array.isArray(node.warnings) ? [...node.warnings] : []
  const op = String(node.nodeType || '')
  const detailsText = node.details ? Object.values(node.details).join(' ') : ''

  if (/\b(?:Seq Scan|Full Table Scan|TABLE ACCESS FULL|Table Scan)\b/i.test(op)) {
    addWarning(warnings, 'Full Table Scan')
  }
  if (/\bCOLLSCAN\b/i.test(op)) {
    addWarning(warnings, 'COLLSCAN')
  }
  if (/\b(?:Filesort|Sort)\b/i.test(op) && (/filesort/i.test(op) || /external/i.test(detailsText))) {
    addWarning(warnings, 'Filesort')
  }
  if (/\bNested Loop\b/i.test(op)) {
    addWarning(warnings, 'Nested Loop')
  }
  if (/\bTemp B-Tree\b/i.test(op) || /USE TEMP B-TREE/i.test(detailsText)) {
    addWarning(warnings, 'Temp B-Tree')
  }
  if (/\bSpill\b/i.test(op) || /External Merge|Disk/i.test(detailsText)) {
    addWarning(warnings, 'Disk Spill')
  }
  const tempWritten = node.details ? Number(node.details['Temp Written Blocks'] ?? 0) : 0
  if (Number.isFinite(tempWritten) && tempWritten > 0) {
    addWarning(warnings, 'Disk Spill')
  }

  const est = node.planRows
  const act = node.totalActualRows
  if (
    typeof est === 'number' &&
    typeof act === 'number' &&
    Number.isFinite(est) &&
    Number.isFinite(act) &&
    Math.max(est, act) >= 100
  ) {
    const ratio = Math.max(est, act) / Math.max(1, Math.min(est, act))
    if (ratio >= 100) {
      addWarning(warnings, 'Row estimate off ≥100× (critical)')
    } else if (ratio >= 10) {
      addWarning(warnings, 'Row estimate off ≥10×')
    }
  }

  return warnings
}

function classifyAdditiveFraction(fraction) {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return 'neutral'
  if (fraction > 0.5) return 'critical'
  if (fraction > 0.2) return 'high'
  if (fraction > 0.05) return 'moderate'
  return 'low'
}

/**
 * Normalizes EXPLAIN metrics:
 * - exclusiveCost & costFraction (divided by totalExclusiveCost, null when no cost)
 * - Parallel processCount (Gather/Gather Merge keeps 1, descendants divide by workersLaunched + 1, InitPlan resets to 1)
 * - Loop & thread timing correction + dual-denominator severity
 * - Non-destructive bottleneck warnings & significant zero key preservation
 */
export function computeExplainPlanMetrics(plan) {
  if (!plan || !plan.root) {
    return {
      format: plan?.format || 'raw-text',
      ...(plan?.dialect ? { dialect: plan.dialect } : {}),
      planningTimeMs: plan?.planningTimeMs ?? null,
      executionTimeMs: plan?.executionTimeMs ?? null,
      totalCost: plan?.totalCost ?? null,
      totalExclusiveCost: null,
      totalActualTimeMs: plan?.executionTimeMs ?? null,
      nodeCount: 0,
      ...(plan?.warnings ? { warnings: plan.warnings } : {}),
      ...(plan?.missingIndexes ? { missingIndexes: plan.missingIndexes } : {}),
      root: null,
      ...(plan?.rawText !== undefined ? { rawText: plan.rawText } : {}),
    }
  }

  const effectiveTimeMap = new WeakMap()
  const allNodes = []

  function pass1(node, inheritedProcessCount) {
    const isInitPlan = Boolean(node.isInitPlan)
    const processCount = isInitPlan ? 1 : Math.max(1, inheritedProcessCount)
    node.processCount = processCount

    const isGather = /^Gather(?:\s+Merge)?$/i.test(String(node.nodeType || '').trim())
    const childWorkers =
      isGather && typeof node.workersLaunched === 'number' && node.workersLaunched > 0
        ? node.workersLaunched + 1
        : processCount

    const reported = getReportedNodeTotals(node)
    const loops = typeof node.actualLoops === 'number' && Number.isFinite(node.actualLoops)
      ? Math.max(0, node.actualLoops)
      : 1

    if (reported && reported.totalActualRows !== undefined) {
      node.totalActualRows = reported.totalActualRows
    } else if (typeof node.actualRows === 'number' && Number.isFinite(node.actualRows)) {
      node.totalActualRows = node.actualRows * loops
    } else if (node.totalActualRows === undefined) {
      node.totalActualRows = null
    }

    let effTime = null
    if (reported && reported.totalActualTimeMs !== undefined) {
      effTime = Math.max(0, reported.totalActualTimeMs)
    } else if (typeof node.actualTotalTimeMs === 'number' && Number.isFinite(node.actualTotalTimeMs)) {
      effTime = Math.max(0, (node.actualTotalTimeMs * loops) / processCount)
    }
    effectiveTimeMap.set(node, effTime)

    allNodes.push(node)
    const children = Array.isArray(node.children) ? node.children : []
    node.children = children
    for (const child of children) {
      pass1(child, childWorkers)
    }
  }

  pass1(plan.root, 1)

  // Bottom-up / local child sum for exclusiveCost and exclusiveTimeMs
  let totalExclusiveCost = 0
  let hasAnyCost = false
  let totalExclusiveTimeMs = 0
  let hasAnyTime = false

  for (const node of allNodes) {
    if (typeof node.totalCost === 'number' && Number.isFinite(node.totalCost)) {
      hasAnyCost = true
      const childCostSum = node.children.reduce(
        (acc, ch) => acc + (typeof ch.totalCost === 'number' && Number.isFinite(ch.totalCost) ? ch.totalCost : 0),
        0
      )
      node.exclusiveCost = Math.max(0, node.totalCost - childCostSum)
      totalExclusiveCost += node.exclusiveCost
    } else {
      node.exclusiveCost = null
      node.costFraction = null
    }

    const effTime = effectiveTimeMap.get(node)
    if (effTime !== null && effTime !== undefined) {
      hasAnyTime = true
      const childTimeSum = node.children.reduce((acc, ch) => {
        const ct = effectiveTimeMap.get(ch)
        return acc + (typeof ct === 'number' && Number.isFinite(ct) ? ct : 0)
      }, 0)
      node.exclusiveTimeMs = Math.max(0, effTime - childTimeSum)
      totalExclusiveTimeMs += node.exclusiveTimeMs
    } else {
      node.exclusiveTimeMs = null
      node.timeFraction = null
    }
  }

  for (const node of allNodes) {
    if (hasAnyCost && totalExclusiveCost > 0 && node.exclusiveCost !== null) {
      node.costFraction = node.exclusiveCost / totalExclusiveCost
    } else {
      node.costFraction = null
    }

    if (hasAnyTime && totalExclusiveTimeMs > 0 && node.exclusiveTimeMs !== null) {
      node.timeFraction = node.exclusiveTimeMs / totalExclusiveTimeMs
    } else {
      node.timeFraction = null
    }

    const primaryFrac =
      node.timeFraction !== null && node.timeFraction !== undefined
        ? node.timeFraction
        : node.costFraction
    node.severity = classifyAdditiveFraction(primaryFrac)

    const warnings = detectNodeBottlenecks(node)
    if (warnings.length > 0) {
      node.warnings = warnings
    } else {
      delete node.warnings
    }
  }

  const rootEffTime = effectiveTimeMap.get(plan.root)
  const resolvedTotalTime =
    plan.executionTimeMs ?? rootEffTime ?? (hasAnyTime ? totalExclusiveTimeMs : null)

  return {
    ...plan,
    totalCost: plan.totalCost ?? plan.root.totalCost ?? null,
    totalExclusiveCost: hasAnyCost ? totalExclusiveCost : null,
    totalActualTimeMs: resolvedTotalTime,
    nodeCount: allNodes.length,
  }
}

/**
 * Dual-denominator bar scaling:
 * - Bar width scales by v / max(all) (minimum 2px when v > 0)
 * - Severity scales by v / sum(all) for additive metrics (cost/time); rows are neutral.
 */
export function computeExplainBarMetrics(plan) {
  if (!plan || !plan.root) return []
  const nodes = []
  const stack = [plan.root]
  while (stack.length > 0) {
    const cur = stack.pop()
    if (!cur) continue
    nodes.push(cur)
    for (let i = cur.children.length - 1; i >= 0; i--) stack.push(cur.children[i])
  }

  let maxCost = 0
  let maxTime = 0
  let maxRows = 0
  for (const n of nodes) {
    if (typeof n.exclusiveCost === 'number' && n.exclusiveCost > maxCost) maxCost = n.exclusiveCost
    if (typeof n.exclusiveTimeMs === 'number' && n.exclusiveTimeMs > maxTime) maxTime = n.exclusiveTimeMs
    if (typeof n.totalActualRows === 'number' && n.totalActualRows > maxRows) maxRows = n.totalActualRows
  }

  return nodes.map((n) => {
    const c = typeof n.exclusiveCost === 'number' && n.exclusiveCost > 0 ? n.exclusiveCost : 0
    const t = typeof n.exclusiveTimeMs === 'number' && n.exclusiveTimeMs > 0 ? n.exclusiveTimeMs : 0
    const r = typeof n.totalActualRows === 'number' && n.totalActualRows > 0 ? n.totalActualRows : 0

    return {
      id: n.id,
      costBarRatio: maxCost > 0 ? c / maxCost : 0,
      costBarMinPx: c > 0 ? 2 : 0,
      timeBarRatio: maxTime > 0 ? t / maxTime : 0,
      timeBarMinPx: t > 0 ? 2 : 0,
      rowsBarRatio: maxRows > 0 ? r / maxRows : 0,
      rowsBarMinPx: r > 0 ? 2 : 0,
      rowsTone: 'neutral',
      severity: n.severity || 'neutral',
    }
  })
}

function isHotNode(node) {
  return (
    node.severity === 'critical' ||
    node.severity === 'high' ||
    (Array.isArray(node.warnings) && node.warnings.length > 0)
  )
}

function markCriticalAncestors(node, keepSet) {
  let hasHot = isHotNode(node)
  for (const child of node.children || []) {
    if (markCriticalAncestors(child, keepSet)) hasHot = true
  }
  if (hasHot) keepSet.add(node.id)
  return hasHot
}

function cloneNodeFiltered(node, options) {
  const { keepSet, maxDepth, maxChildren, stripDetails, keepSignificantZeros, depth } = options
  let nextDetails
  if (!stripDetails && node.details) {
    nextDetails = {}
    for (const [k, v] of Object.entries(node.details)) {
      if (typeof v === 'string' && v.length > 256) {
        nextDetails[k] = `${v.slice(0, 253)}...`
      } else {
        nextDetails[k] = v
      }
    }
  } else if (keepSignificantZeros && node.details) {
    const sig = {}
    for (const key of SIGNIFICANT_ZERO_SET) {
      if (Object.hasOwn(node.details, key)) sig[key] = node.details[key]
    }
    if (Object.keys(sig).length > 0) nextDetails = sig
  }

  let children = []
  if (depth < maxDepth && Array.isArray(node.children) && node.children.length > 0) {
    const sorted = [...node.children].sort((a, b) => {
      const aKeep = keepSet.has(a.id) ? 1 : 0
      const bKeep = keepSet.has(b.id) ? 1 : 0
      return bKeep - aKeep
    })
    const hotCount = sorted.filter((c) => keepSet.has(c.id)).length
    const takeCount = Math.max(maxChildren, hotCount)
    children = sorted.slice(0, takeCount).map((c) =>
      cloneNodeFiltered(c, {
        ...options,
        depth: depth + 1,
      })
    )
  }

  return {
    ...node,
    ...(nextDetails ? { details: nextDetails } : { details: undefined }),
    children,
  }
}

/**
 * Pure-JS UTF-8 IPC compaction targeting <= 140 KB (hard cap 150 KB),
 * prioritizing critical/warning nodes and their ancestors.
 */
export function compactExplainPlanForIpc(plan, options) {
  const targetBytes = options?.targetBytes ?? EXPLAIN_IPC_TARGET_BYTES
  const hardCapBytes = options?.hardCapBytes ?? EXPLAIN_IPC_HARD_CAP_BYTES

  const initialSerialized = JSON.stringify(plan)
  if (utf8ByteLength(initialSerialized) <= targetBytes) {
    return plan
  }

  const out = { ...plan, truncated: true }
  if (typeof out.rawText === 'string' && out.rawText.length > 2048) {
    out.rawText = `${out.rawText.slice(0, 2048)}\n-- [Truncated]`
  }
  if (utf8ByteLength(JSON.stringify(out)) <= targetBytes) return out

  delete out.rawText
  if (utf8ByteLength(JSON.stringify(out)) <= targetBytes) return out

  if (out.root) {
    const keepSet = new Set()
    markCriticalAncestors(out.root, keepSet)

    const passes = [
      { maxDepth: 64, maxChildren: 64, stripDetails: false, keepSignificantZeros: true },
      { maxDepth: 48, maxChildren: 32, stripDetails: true, keepSignificantZeros: true },
      { maxDepth: 24, maxChildren: 12, stripDetails: true, keepSignificantZeros: true },
      { maxDepth: 12, maxChildren: 6, stripDetails: true, keepSignificantZeros: false },
      { maxDepth: 6, maxChildren: 3, stripDetails: true, keepSignificantZeros: false },
      { maxDepth: 2, maxChildren: 2, stripDetails: true, keepSignificantZeros: false },
    ]

    for (const pass of passes) {
      out.root = cloneNodeFiltered(plan.root, {
        keepSet,
        ...pass,
        depth: 0,
      })
      if (utf8ByteLength(JSON.stringify(out)) <= targetBytes) {
        return out
      }
    }

    // Last-resort hard cap enforcement
    if (utf8ByteLength(JSON.stringify(out)) > hardCapBytes) {
      out.root = cloneNodeFiltered(plan.root, {
        keepSet,
        maxDepth: 1,
        maxChildren: 1,
        stripDetails: true,
        keepSignificantZeros: false,
        depth: 0,
      })
    }
  }

  if (utf8ByteLength(JSON.stringify(out)) > hardCapBytes) {
    out.root = null
    delete out.missingIndexes
  }
  return out
}

export function parseExplainPlan(input, options) {
  const rawPlan = parseRawExplainInput(input, options)
  const normalized = computeExplainPlanMetrics(rawPlan)
  return compactExplainPlanForIpc(normalized)
}
