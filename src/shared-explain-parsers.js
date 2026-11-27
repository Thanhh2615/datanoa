// src/shared-explain-parsers.js
// Pure-JS EXPLAIN plan parsers (8+ formats) shared across Worker, Studio, and Side Panel.
// Zero Node built-ins, zero .ts imports, zero DOM/eval.

export const EXPLAIN_SIGNIFICANT_ZERO_KEYS = Object.freeze([
  'Workers Launched',
  'Actual Rows',
  'Actual Loops',
  'Heap Fetches',
])

const REPORTED_TOTALS = new WeakMap()

export function getReportedNodeTotals(node) {
  return node && typeof node === 'object' ? REPORTED_TOTALS.get(node) ?? null : null
}

function setReportedNodeTotals(node, totals) {
  if (node && typeof node === 'object' && totals) {
    REPORTED_TOTALS.set(node, totals)
  }
}

function toFiniteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    const num = Number(trimmed)
    return Number.isFinite(num) ? num : null
  }
  return null
}

function parseTimeWithUnitMs(rawText) {
  if (typeof rawText !== 'string') return null
  const m = /(-?\d+(?:\.\d+)?)\s*(ns|µs|us|ms|s)\b/i.exec(rawText.trim())
  if (!m) return null
  const val = Number(m[1])
  if (!Number.isFinite(val)) return null
  const unit = m[2].toLowerCase()
  if (unit === 's') return val * 1000
  if (unit === 'ms') return val
  if (unit === 'µs' || unit === 'us') return val / 1000
  if (unit === 'ns') return val / 1_000_000
  return null
}

function createIdFactory() {
  let seq = 0
  return () => `node_${++seq}`
}

function countTreeNodes(root) {
  if (!root) return 0
  let count = 0
  const stack = [root]
  while (stack.length > 0) {
    const cur = stack.pop()
    if (!cur) continue
    count++
    for (let i = cur.children.length - 1; i >= 0; i--) {
      stack.push(cur.children[i])
    }
  }
  return count
}

function makeBaseNode(fields) {
  return {
    id: fields.id,
    parentId: fields.parentId ?? null,
    nodeType: fields.nodeType || 'Operation',
    ...(fields.relation ? { relation: fields.relation } : {}),
    ...(fields.alias ? { alias: fields.alias } : {}),
    ...(fields.indexName ? { indexName: fields.indexName } : {}),
    ...(fields.joinType ? { joinType: fields.joinType } : {}),
    ...(fields.startupCost !== undefined ? { startupCost: fields.startupCost } : {}),
    ...(fields.totalCost !== undefined ? { totalCost: fields.totalCost } : {}),
    ...(fields.planRows !== undefined ? { planRows: fields.planRows } : {}),
    ...(fields.planWidth !== undefined ? { planWidth: fields.planWidth } : {}),
    ...(fields.actualStartupTimeMs !== undefined
      ? { actualStartupTimeMs: fields.actualStartupTimeMs }
      : {}),
    ...(fields.actualTotalTimeMs !== undefined
      ? { actualTotalTimeMs: fields.actualTotalTimeMs }
      : {}),
    ...(fields.actualRows !== undefined ? { actualRows: fields.actualRows } : {}),
    ...(fields.actualLoops !== undefined ? { actualLoops: fields.actualLoops } : {}),
    ...(fields.workersPlanned !== undefined ? { workersPlanned: fields.workersPlanned } : {}),
    ...(fields.workersLaunched !== undefined ? { workersLaunched: fields.workersLaunched } : {}),
    ...(fields.isInitPlan ? { isInitPlan: true } : {}),
    ...(fields.warnings && fields.warnings.length > 0 ? { warnings: fields.warnings } : {}),
    ...(fields.details && Object.keys(fields.details).length > 0 ? { details: fields.details } : {}),
    children: fields.children || [],
  }
}

function decodeXmlEntities(str) {
  return str.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (_m, ent) => {
    if (ent === 'lt') return '<'
    if (ent === 'gt') return '>'
    if (ent === 'amp') return '&'
    if (ent === 'quot') return '"'
    if (ent === 'apos') return "'"
    if (ent.startsWith('#x') || ent.startsWith('#X')) {
      const cp = Number.parseInt(ent.slice(2), 16)
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ''
    }
    if (ent.startsWith('#')) {
      const cp = Number.parseInt(ent.slice(1), 10)
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ''
    }
    return ''
  })
}

const XML_MAX_DEPTH = 512

/**
 * Pure-JS strict XML parser blocking XXE (DOCTYPE/ENTITY) and enforcing max nesting depth <= 512.
 */
export function parseXmlStrict(xml, options) {
  const maxDepth =
    options && typeof options.maxDepth === 'number' && options.maxDepth > 0
      ? Math.min(options.maxDepth, XML_MAX_DEPTH)
      : XML_MAX_DEPTH
  if (typeof xml !== 'string') {
    throw new Error('XML input must be a string')
  }
  const src = xml.replace(/^\uFEFF/, '')
  if (/<!(?:DOCTYPE|ENTITY)\b/i.test(src)) {
    throw new Error('XML DOCTYPE/ENTITY (XXE) declarations are blocked')
  }

  const stack = []
  let root = null
  let i = 0
  const len = src.length

  while (i < len) {
    const lt = src.indexOf('<', i)
    if (lt === -1) break
    if (lt > i && stack.length > 0) {
      const textChunk = src.slice(i, lt).trim()
      if (textChunk) {
        const cur = stack[stack.length - 1]
        cur.text = cur.text ? `${cur.text} ${decodeXmlEntities(textChunk)}` : decodeXmlEntities(textChunk)
      }
    }

    if (src.startsWith('<!--', lt)) {
      const endComment = src.indexOf('-->', lt + 4)
      if (endComment === -1) throw new Error('Unterminated XML comment')
      i = endComment + 3
      continue
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const endCdata = src.indexOf(']]>', lt + 9)
      if (endCdata === -1) throw new Error('Unterminated CDATA section')
      if (stack.length > 0) {
        const cur = stack[stack.length - 1]
        const cdata = src.slice(lt + 9, endCdata)
        cur.text = cur.text ? `${cur.text}${cdata}` : cdata
      }
      i = endCdata + 3
      continue
    }
    if (src.startsWith('<?', lt)) {
      const endPi = src.indexOf('?>', lt + 2)
      if (endPi === -1) throw new Error('Unterminated XML processing instruction')
      i = endPi + 2
      continue
    }
    if (src.startsWith('<!', lt)) {
      throw new Error('Unsupported or blocked XML declaration (XXE guard)')
    }

    // Parse tag end respecting attribute quotes
    let j = lt + 1
    let quote = ''
    while (j < len) {
      const ch = src[j]
      if (quote) {
        if (ch === quote) quote = ''
      } else if (ch === '"' || ch === "'") {
        quote = ch
      } else if (ch === '>') {
        break
      }
      j++
    }
    if (j >= len) throw new Error('Unterminated XML tag')
    const rawTag = src.slice(lt + 1, j).trim()
    i = j + 1

    if (!rawTag) continue
    if (rawTag.startsWith('/')) {
      const rawCloseName = rawTag.slice(1).trim()
      const closeName = rawCloseName.includes(':')
        ? rawCloseName.slice(rawCloseName.indexOf(':') + 1)
        : rawCloseName
      const popped = stack.pop()
      if (!popped || popped.name !== closeName) {
        throw new Error(`Mismatched XML closing tag </${rawCloseName}>`)
      }
      continue
    }

    const selfClosing = rawTag.endsWith('/')
    const tagBody = selfClosing ? rawTag.slice(0, -1).trim() : rawTag
    const spaceIdx = tagBody.search(/[\s\r\n\t]/)
    const name = spaceIdx === -1 ? tagBody : tagBody.slice(0, spaceIdx)
    const attrStr = spaceIdx === -1 ? '' : tagBody.slice(spaceIdx + 1)
    const attrs = {}
    const attrRe = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
    let am = attrRe.exec(attrStr)
    while (am) {
      const rawKey = am[1]
      const cleanKey = rawKey.includes(':') ? rawKey.slice(rawKey.indexOf(':') + 1) : rawKey
      attrs[cleanKey] = decodeXmlEntities(am[2] ?? am[3] ?? '')
      am = attrRe.exec(attrStr)
    }

    const localName = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name
    const el = { name: localName, attrs, children: [], text: '' }
    if (stack.length > 0) {
      stack[stack.length - 1].children.push(el)
    } else {
      root = el
    }
    if (!selfClosing) {
      if (stack.length + 1 > maxDepth) {
        throw new Error(`XML nesting depth exceeds limit of ${maxDepth}`)
      }
      stack.push(el)
    }
  }

  if (stack.length > 0) {
    const unclosed = stack[stack.length - 1].name
    throw new Error(`Unclosed XML tag <${unclosed}>`)
  }

  return { root }
}

function extractTabularInput(input) {
  if (
    input &&
    typeof input === 'object' &&
    !Array.isArray(input) &&
    Array.isArray(input.columns) &&
    Array.isArray(input.rows)
  ) {
    const colNames = input.columns.map((c) =>
      typeof c === 'string' ? c : c && typeof c.name === 'string' ? c.name : ''
    )
    return { columns: colNames, rows: input.rows }
  }
  return null
}

function extractTextFromInput(input) {
  if (typeof input === 'string') return input
  const tab = extractTabularInput(input)
  if (tab && tab.columns.length <= 1 && tab.rows.length > 0) {
    return tab.rows
      .map((r) => (Array.isArray(r) && r.length > 0 && r[0] != null ? String(r[0]) : ''))
      .join('\n')
  }
  return null
}

function tryParseJson(input) {
  if (typeof input === 'object' && input !== null && !extractTabularInput(input)) {
    return input
  }
  const text = extractTextFromInput(input)
  if (!text) return null
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 1. PostgreSQL JSON Parser
// ---------------------------------------------------------------------------

function collectPgDetails(rawPlan) {
  const details = {}
  const skip = new Set([
    'Node Type',
    'Relation Name',
    'Alias',
    'Index Name',
    'Join Type',
    'Startup Cost',
    'Total Cost',
    'Plan Rows',
    'Plan Width',
    'Actual Startup Time',
    'Actual Total Time',
    'Actual Rows',
    'Actual Loops',
    'Workers Planned',
    'Workers Launched',
    'Plans',
    'Parent Relationship',
  ])

  for (const [k, v] of Object.entries(rawPlan)) {
    if (skip.has(k) || v === undefined || v === null) continue
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      details[k] = typeof v === 'number' && k === 'Heap Fetches' ? String(v) : v
    } else if (Array.isArray(v)) {
      details[k] = v.map((x) => String(x)).join(', ')
    }
  }

  for (const key of EXPLAIN_SIGNIFICANT_ZERO_KEYS) {
    if (Object.hasOwn(rawPlan, key) && rawPlan[key] !== undefined && rawPlan[key] !== null) {
      details[key] = String(rawPlan[key])
    }
  }

  return details
}

function convertPgNode(rawPlan, parentId, nextId) {
  const id = nextId()
  const parentRel = typeof rawPlan['Parent Relationship'] === 'string' ? rawPlan['Parent Relationship'] : ''
  const subplanName = typeof rawPlan['Subplan Name'] === 'string' ? rawPlan['Subplan Name'] : ''
  const isInitPlan = parentRel === 'InitPlan' || /^InitPlan\b/i.test(subplanName)

  const node = makeBaseNode({
    id,
    parentId,
    nodeType: typeof rawPlan['Node Type'] === 'string' ? rawPlan['Node Type'] : 'Unknown',
    relation: typeof rawPlan['Relation Name'] === 'string' ? rawPlan['Relation Name'] : undefined,
    alias: typeof rawPlan['Alias'] === 'string' ? rawPlan['Alias'] : undefined,
    indexName: typeof rawPlan['Index Name'] === 'string' ? rawPlan['Index Name'] : undefined,
    joinType: typeof rawPlan['Join Type'] === 'string' ? rawPlan['Join Type'] : undefined,
    startupCost: toFiniteNumber(rawPlan['Startup Cost']),
    totalCost: toFiniteNumber(rawPlan['Total Cost']),
    planRows: toFiniteNumber(rawPlan['Plan Rows']),
    planWidth: toFiniteNumber(rawPlan['Plan Width']),
    actualStartupTimeMs: toFiniteNumber(rawPlan['Actual Startup Time']),
    actualTotalTimeMs: toFiniteNumber(rawPlan['Actual Total Time']),
    actualRows: toFiniteNumber(rawPlan['Actual Rows']),
    actualLoops: toFiniteNumber(rawPlan['Actual Loops']),
    workersPlanned: toFiniteNumber(rawPlan['Workers Planned']),
    workersLaunched: toFiniteNumber(rawPlan['Workers Launched']),
    isInitPlan,
    details: collectPgDetails(rawPlan),
    children: [],
  })

  if (Array.isArray(rawPlan.Plans)) {
    node.children = rawPlan.Plans.filter((c) => c && typeof c === 'object').map((c) =>
      convertPgNode(c, id, nextId)
    )
  }
  return node
}

export function parsePostgresJsonExplain(input) {
  const parsed = tryParseJson(input)
  if (!parsed) return null
  const envelope = Array.isArray(parsed) ? parsed[0] : parsed
  if (!envelope || typeof envelope !== 'object' || !envelope.Plan || typeof envelope.Plan !== 'object') {
    return null
  }
  const nextId = createIdFactory()
  const root = convertPgNode(envelope.Plan, null, nextId)
  const planningTimeMs = toFiniteNumber(envelope['Planning Time'])
  const executionTimeMs = toFiniteNumber(envelope['Execution Time'] ?? envelope['Total Runtime'])
  const rawText = typeof input === 'string' ? input : JSON.stringify(parsed)
  return {
    format: 'postgres-json',
    dialect: 'postgres',
    planningTimeMs,
    executionTimeMs,
    totalCost: root.totalCost ?? null,
    nodeCount: countTreeNodes(root),
    root,
    rawText,
  }
}

// ---------------------------------------------------------------------------
// 2. MySQL / MariaDB Composite Parser (JSON + MariaDB ANALYZE + TREE + 12-col)
// ---------------------------------------------------------------------------

function extractMysqlCost(obj) {
  if (!obj || typeof obj !== 'object') return null
  const info = obj.cost_info && typeof obj.cost_info === 'object' ? obj.cost_info : obj
  const readCost = toFiniteNumber(info.read_cost)
  const evalCost = toFiniteNumber(info.eval_cost)
  if (readCost !== null || evalCost !== null) {
    return (readCost ?? 0) + (evalCost ?? 0)
  }
  const direct = toFiniteNumber(info.query_cost ?? info.prefix_cost ?? info.sort_cost ?? info.cost)
  if (direct !== null) return direct
  return null
}

function buildMysqlJsonChildren(obj, parentId, nextId) {
  const children = []
  if (!obj || typeof obj !== 'object') return children

  const pushWrapped = (label, val, extraDetails) => {
    if (!val || typeof val !== 'object') return
    const id = nextId()
    const subChildren = buildMysqlJsonChildren(val, id, nextId)
    const warnings = []
    if (/filesort/i.test(label)) warnings.push('Filesort')
    const node = makeBaseNode({
      id,
      parentId,
      nodeType: label,
      totalCost: extractMysqlCost(val),
      actualRows: toFiniteNumber(val.r_rows),
      actualLoops: toFiniteNumber(val.r_loops),
      actualTotalTimeMs: toFiniteNumber(val.r_total_time_ms),
      warnings,
      details: extraDetails,
      children: subChildren,
    })
    children.push(node)
  }

  if (Array.isArray(obj.nested_loop)) {
    for (const item of obj.nested_loop) {
      if (item && typeof item === 'object') {
        if (item.table) {
          children.push(convertMysqlTableNode(item.table, parentId, nextId))
        } else {
          children.push(...buildMysqlJsonChildren(item, parentId, nextId))
        }
      }
    }
  }
  if (obj.table && typeof obj.table === 'object') {
    children.push(convertMysqlTableNode(obj.table, parentId, nextId))
  }
  if (obj.filesort && typeof obj.filesort === 'object') {
    const details = obj.filesort.sort_key ? { 'Sort Key': String(obj.filesort.sort_key) } : undefined
    pushWrapped('Filesort', obj.filesort, details)
  }
  if (obj.temporary_table && typeof obj.temporary_table === 'object') {
    pushWrapped('Temporary Table', obj.temporary_table)
  }
  if (obj.ordering_operation && typeof obj.ordering_operation === 'object') {
    const label = obj.ordering_operation.using_filesort ? 'Ordering (Filesort)' : 'Ordering'
    pushWrapped(label, obj.ordering_operation)
  }
  if (obj.grouping_operation && typeof obj.grouping_operation === 'object') {
    pushWrapped('Grouping', obj.grouping_operation)
  }
  if (obj.duplicates_removal && typeof obj.duplicates_removal === 'object') {
    pushWrapped('Duplicates Removal', obj.duplicates_removal)
  }
  if (obj.union_result && typeof obj.union_result === 'object') {
    pushWrapped('Union Result', obj.union_result)
  }
  if (obj.materialized_from_subquery && typeof obj.materialized_from_subquery === 'object') {
    const sub = obj.materialized_from_subquery.query_block ?? obj.materialized_from_subquery
    pushWrapped('Materialized Subquery', sub)
  }
  if (Array.isArray(obj.query_specifications)) {
    for (const spec of obj.query_specifications) {
      if (spec && typeof spec === 'object') {
        pushWrapped('Query Specification', spec.query_block ?? spec)
      }
    }
  }
  if (Array.isArray(obj.attached_subqueries)) {
    for (const sub of obj.attached_subqueries) {
      if (sub && typeof sub === 'object') {
        pushWrapped('Attached Subquery', sub.query_block ?? sub)
      }
    }
  }
  if (Array.isArray(obj.optimized_away_subqueries)) {
    for (const sub of obj.optimized_away_subqueries) {
      if (sub && typeof sub === 'object') {
        pushWrapped('Optimized Away Subquery', sub.query_block ?? sub)
      }
    }
  }
  return children
}

function convertMysqlTableNode(tbl, parentId, nextId) {
  const id = nextId()
  const accessType = typeof tbl.access_type === 'string' ? tbl.access_type : ''
  const tableName = typeof tbl.table_name === 'string' ? tbl.table_name : undefined
  const indexName = typeof tbl.key === 'string' ? tbl.key : undefined
  const details = {}
  if (accessType) details['Access Type'] = accessType
  if (tbl.r_filtered !== undefined) details['r_filtered'] = String(tbl.r_filtered)
  if (tbl.filtered !== undefined) details['filtered'] = String(tbl.filtered)
  if (tbl.attached_condition) details['Condition'] = String(tbl.attached_condition)
  if (Array.isArray(tbl.possible_keys)) details['Possible Keys'] = tbl.possible_keys.join(', ')

  const warnings = []
  if (accessType.toUpperCase() === 'ALL') warnings.push('Full Table Scan')
  if (tbl.using_filesort) warnings.push('Filesort')

  const nodeType =
    accessType.toUpperCase() === 'ALL'
      ? 'Full Table Scan'
      : indexName
        ? `Index Scan (${accessType || 'ref'})`
        : accessType
          ? `Table Access (${accessType})`
          : 'Table Scan'

  const node = makeBaseNode({
    id,
    parentId,
    nodeType,
    relation: tableName,
    indexName,
    totalCost: extractMysqlCost(tbl),
    planRows: toFiniteNumber(tbl.rows_examined_per_scan ?? tbl.rows),
    actualRows: toFiniteNumber(tbl.r_rows),
    actualLoops: toFiniteNumber(tbl.r_loops),
    actualTotalTimeMs: toFiniteNumber(tbl.r_total_time_ms),
    warnings,
    details,
    children: buildMysqlJsonChildren(tbl, id, nextId),
  })
  return node
}

function parseMysqlTreeText(text, dialect) {
  const rawLines = text.split(/\r?\n/)
  const arrowLines = []
  for (const rawLine of rawLines) {
    if (!rawLine.trim()) continue
    const m = /^(\s*(?:\|\s*)*)->\s*(.+)$/.exec(rawLine)
    if (m) {
      arrowLines.push({ indent: m[1].length, text: m[2].trim() })
    } else if (arrowLines.length > 0) {
      arrowLines[arrowLines.length - 1].text += ` ${rawLine.trim()}`
    }
  }
  if (arrowLines.length === 0) return null

  const nextId = createIdFactory()
  const stack = []
  let root = null

  for (const entry of arrowLines) {
    let body = entry.text
    const neverExecuted = /\(never executed\)/i.test(body)
    body = body.replace(/\(never executed\)/gi, '').trim()

    let actualStartupTimeMs = null
    let actualTotalTimeMs = null
    let actualRows = null
    let actualLoops = neverExecuted ? 0 : null

    const actMatch = /\(actual time=(\d+(?:\.\d+)?)\.\.(\d+(?:\.\d+)?)\s+rows=(\d+(?:\.\d+)?)\s+loops=(\d+(?:\.\d+)?)\)/i.exec(body)
    if (actMatch) {
      actualStartupTimeMs = Number(actMatch[1])
      actualTotalTimeMs = Number(actMatch[2])
      actualRows = Number(actMatch[3])
      actualLoops = Number(actMatch[4])
      body = body.replace(actMatch[0], '').trim()
    } else if (neverExecuted) {
      actualRows = 0
      actualLoops = 0
    }

    let totalCost = null
    let planRows = null
    const costMatch = /\(cost=(\d+(?:\.\d+)?)\s+rows=(\d+(?:\.\d+)?)\)/i.exec(body)
    if (costMatch) {
      totalCost = Number(costMatch[1])
      planRows = Number(costMatch[2])
      body = body.replace(costMatch[0], '').trim()
    }

    let relation
    let indexName
    const onUsingMatch = /\bon\s+([`"\w.$]+)\s+using\s+([`"\w.$]+)/i.exec(body)
    if (onUsingMatch) {
      relation = onUsingMatch[1].replace(/[`"]/g, '')
      indexName = onUsingMatch[2].replace(/[`"]/g, '')
    } else {
      const onOnlyMatch = /\bon\s+([`"\w.$]+)/i.exec(body)
      if (onOnlyMatch) relation = onOnlyMatch[1].replace(/[`"]/g, '')
    }

    const opLabel = body.split(/\s+\(/)[0].trim() || 'Operation'
    while (stack.length > 0 && stack[stack.length - 1].indent >= entry.indent) {
      stack.pop()
    }
    const parent = stack.length > 0 ? stack[stack.length - 1].node : null
    const node = makeBaseNode({
      id: nextId(),
      parentId: parent ? parent.id : null,
      nodeType: opLabel,
      relation,
      indexName,
      totalCost,
      planRows,
      actualStartupTimeMs,
      actualTotalTimeMs,
      actualRows,
      actualLoops,
      children: [],
    })
    if (parent) {
      parent.children.push(node)
    } else if (!root) {
      root = node
    } else {
      const synth = makeBaseNode({
        id: nextId(),
        parentId: null,
        nodeType: 'Query Plan',
        children: [root, node],
      })
      root.parentId = synth.id
      node.parentId = synth.id
      root = synth
    }
    stack.push({ indent: entry.indent, node })
  }

  if (!root) return null
  return {
    format: 'mysql-tree',
    dialect: dialect || 'mysql',
    totalCost: root.totalCost ?? null,
    nodeCount: countTreeNodes(root),
    root,
    rawText: text,
  }
}

function parseMysqlTableResult(tab, dialect) {
  const colsLower = tab.columns.map((c) => c.toLowerCase())
  const idx = {
    id: colsLower.indexOf('id'),
    selectType: colsLower.indexOf('select_type'),
    table: colsLower.indexOf('table'),
    type: colsLower.indexOf('type'),
    possibleKeys: colsLower.indexOf('possible_keys'),
    key: colsLower.indexOf('key'),
    rows: colsLower.indexOf('rows'),
    filtered: colsLower.indexOf('filtered'),
    extra: colsLower.indexOf('extra'),
  }
  if (idx.id === -1 || idx.selectType === -1 || idx.table === -1) return null

  const nextId = createIdFactory()
  const nodes = tab.rows.map((row) => {
    const accessType = idx.type >= 0 && row[idx.type] != null ? String(row[idx.type]) : ''
    const tableName = row[idx.table] != null ? String(row[idx.table]) : undefined
    const keyName = idx.key >= 0 && row[idx.key] != null ? String(row[idx.key]) : undefined
    const extra = idx.extra >= 0 && row[idx.extra] != null ? String(row[idx.extra]) : ''
    const selectType = row[idx.selectType] != null ? String(row[idx.selectType]) : 'SIMPLE'
    const warnings = []
    if (accessType.toUpperCase() === 'ALL') warnings.push('Full Table Scan')
    if (/using filesort/i.test(extra)) warnings.push('Filesort')
    if (/using temporary/i.test(extra)) warnings.push('Temporary Table')

    const details = { 'Select Type': selectType }
    if (accessType) details['Access Type'] = accessType
    if (idx.filtered >= 0 && row[idx.filtered] != null) details['filtered'] = String(row[idx.filtered])
    if (extra) details['Extra'] = extra

    return makeBaseNode({
      id: nextId(),
      parentId: null,
      nodeType: accessType ? `${selectType} (${accessType})` : selectType,
      relation: tableName,
      indexName: keyName,
      planRows: idx.rows >= 0 ? toFiniteNumber(row[idx.rows]) : null,
      warnings,
      details,
      children: [],
    })
  })

  if (nodes.length === 0) return null
  let root = nodes[0]
  if (nodes.length > 1) {
    root = makeBaseNode({
      id: nextId(),
      parentId: null,
      nodeType: 'Query Execution',
      children: nodes,
    })
    for (const n of nodes) n.parentId = root.id
  }

  return {
    format: 'mysql-table',
    dialect: dialect || 'mysql',
    nodeCount: countTreeNodes(root),
    root,
  }
}

export function parseMysqlCompositeExplain(input, dialect = 'mysql') {
  const parsed = tryParseJson(input)
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.query_block) {
    const nextId = createIdFactory()
    const qb = parsed.query_block
    const rootId = nextId()
    const children = buildMysqlJsonChildren(qb, rootId, nextId)
    const root = makeBaseNode({
      id: rootId,
      parentId: null,
      nodeType: `Query Block #${qb.select_id ?? 1}`,
      totalCost: extractMysqlCost(qb),
      actualLoops: toFiniteNumber(qb.r_loops),
      actualTotalTimeMs: toFiniteNumber(qb.r_total_time_ms),
      children,
    })
    return {
      format: 'mysql-json',
      dialect,
      totalCost: root.totalCost ?? null,
      executionTimeMs: toFiniteNumber(qb.r_total_time_ms),
      nodeCount: countTreeNodes(root),
      root,
      rawText: typeof input === 'string' ? input : JSON.stringify(parsed),
    }
  }

  const text = extractTextFromInput(input)
  if (text && /^\s*(?:\|\s*)*->/m.test(text)) {
    const treePlan = parseMysqlTreeText(text, dialect)
    if (treePlan) return treePlan
  }

  const tab = extractTabularInput(input)
  if (tab) {
    const tabPlan = parseMysqlTableResult(tab, dialect)
    if (tabPlan) return tabPlan
  }

  return null
}

// ---------------------------------------------------------------------------
// 3. SQLite / LibSQL / D1 EXPLAIN QUERY PLAN Parser
// ---------------------------------------------------------------------------

function parseSqliteDetail(detail) {
  const trimmed = String(detail || '').trim()
  let nodeType = trimmed || 'Plan Step'
  let relation
  let indexName
  const warnings = []

  const scanMatch = /^SCAN(?:\s+TABLE)?\s+([^\s(]+)(?:\s+USING\s+(?:COVERING\s+)?INDEX\s+([^\s(]+))?/i.exec(
    trimmed
  )
  const searchMatch = /^SEARCH(?:\s+TABLE)?\s+([^\s(]+)\s+USING\s+(?:COVERING\s+)?INDEX\s+([^\s(]+)/i.exec(
    trimmed
  )
  const autoIdxMatch = /^SEARCH(?:\s+TABLE)?\s+([^\s(]+)\s+USING\s+AUTOMATIC\s+(?:COVERING\s+)?INDEX/i.exec(
    trimmed
  )

  if (searchMatch) {
    relation = searchMatch[1]
    indexName = searchMatch[2]
    nodeType = /COVERING\s+INDEX/i.test(trimmed) ? 'Covering Index Search' : 'Index Search'
  } else if (autoIdxMatch) {
    relation = autoIdxMatch[1]
    nodeType = 'Automatic Index Search'
  } else if (scanMatch) {
    relation = scanMatch[1]
    if (scanMatch[2]) {
      indexName = scanMatch[2]
      nodeType = /COVERING\s+INDEX/i.test(trimmed) ? 'Covering Index Scan' : 'Index Scan'
    } else {
      nodeType = 'Table Scan'
      warnings.push('Full Table Scan')
    }
  } else if (/USE\s+TEMP\s+B-TREE/i.test(trimmed)) {
    nodeType = 'Temp B-Tree'
    warnings.push('Temp B-Tree')
  }

  return { nodeType, relation, indexName, warnings, detail: trimmed }
}

export function parseSqliteEqpExplain(input) {
  const tab = extractTabularInput(input)
  if (tab) {
    const cols = tab.columns.map((c) => c.toLowerCase())
    const idIdx = cols.indexOf('id')
    const parentIdx = cols.indexOf('parent')
    const detailIdx = cols.indexOf('detail')
    if (idIdx !== -1 && parentIdx !== -1 && detailIdx !== -1) {
      const nodeMap = new Map()
      const ordered = []
      for (const row of tab.rows) {
        const rawId = Number(row[idIdx])
        const rawParent = Number(row[parentIdx])
        const parsed = parseSqliteDetail(row[detailIdx])
        const node = makeBaseNode({
          id: `eqp_${rawId}`,
          parentId: rawParent > 0 ? `eqp_${rawParent}` : null,
          nodeType: parsed.nodeType,
          relation: parsed.relation,
          indexName: parsed.indexName,
          warnings: parsed.warnings,
          details: { Detail: parsed.detail },
          children: [],
        })
        nodeMap.set(rawId, { rawParent, node })
        ordered.push({ rawId, rawParent, node })
      }

      const roots = []
      for (const item of ordered) {
        const p = nodeMap.get(item.rawParent)
        if (p) {
          p.node.children.push(item.node)
        } else {
          item.node.parentId = null
          roots.push(item.node)
        }
      }

      if (roots.length === 0) return null
      let root = roots[0]
      if (roots.length > 1) {
        root = makeBaseNode({
          id: 'eqp_root',
          parentId: null,
          nodeType: 'QUERY PLAN',
          children: roots,
        })
        for (const r of roots) r.parentId = root.id
      }

      return {
        format: 'sqlite-eqp',
        dialect: 'sqlite',
        nodeCount: countTreeNodes(root),
        root,
      }
    }
  }

  const text = extractTextFromInput(input)
  if (text && /(?:SCAN|SEARCH|USE TEMP B-TREE|QUERY PLAN)/i.test(text)) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim() && !/^\s*QUERY PLAN\s*$/i.test(l))
    if (lines.length === 0) return null
    const nextId = createIdFactory()
    const stack = []
    const roots = []
    for (const line of lines) {
      const prefixMatch = /^([|\s`-]*)(.*)$/.exec(line)
      const indent = prefixMatch ? prefixMatch[1].length : 0
      const clean = (prefixMatch ? prefixMatch[2] : line).trim()
      const parsed = parseSqliteDetail(clean)
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
        stack.pop()
      }
      const parent = stack.length > 0 ? stack[stack.length - 1].node : null
      const node = makeBaseNode({
        id: nextId(),
        parentId: parent ? parent.id : null,
        nodeType: parsed.nodeType,
        relation: parsed.relation,
        indexName: parsed.indexName,
        warnings: parsed.warnings,
        details: { Detail: parsed.detail },
        children: [],
      })
      if (parent) parent.children.push(node)
      else roots.push(node)
      stack.push({ indent, node })
    }
    if (roots.length === 0) return null
    let root = roots[0]
    if (roots.length > 1) {
      root = makeBaseNode({ id: nextId(), parentId: null, nodeType: 'QUERY PLAN', children: roots })
      for (const r of roots) r.parentId = root.id
    }
    return {
      format: 'sqlite-eqp',
      dialect: 'sqlite',
      nodeCount: countTreeNodes(root),
      root,
      rawText: text,
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// 4. CockroachDB Text Parser
// ---------------------------------------------------------------------------

export function parseCockroachTextExplain(input) {
  const text = extractTextFromInput(input)
  if (!text || !text.includes('•')) return null

  const lines = text.split(/\r?\n/)
  const nextId = createIdFactory()
  const stack = []
  let root = null
  let currentNode = null

  for (const line of lines) {
    const bulletMatch = /^([^•]*)•\s*(.+)$/.exec(line)
    if (bulletMatch) {
      const indent = bulletMatch[1].length
      const opName = bulletMatch[2].trim()
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
        stack.pop()
      }
      const parent = stack.length > 0 ? stack[stack.length - 1].node : null
      const node = makeBaseNode({
        id: nextId(),
        parentId: parent ? parent.id : null,
        nodeType: opName,
        details: {},
        warnings: [],
        children: [],
      })
      if (parent) parent.children.push(node)
      else if (!root) root = node
      stack.push({ indent, node })
      currentNode = node
      continue
    }

    if (currentNode) {
      const cleaned = line.replace(/^[\s│├└─]+/, '').trim()
      if (!cleaned) continue
      const kv = /^([^:]+):\s*(.+)$/.exec(cleaned)
      if (!kv) continue
      const key = kv[1].trim()
      const val = kv[2].trim()
      const keyLower = key.toLowerCase()
      currentNode.details = currentNode.details || {}
      currentNode.details[key] = val

      if (keyLower === 'table') {
        const parts = val.split('@')
        currentNode.relation = parts[0].trim()
        if (parts[1]) currentNode.indexName = parts[1].trim()
      } else if (keyLower === 'estimated row count') {
        currentNode.planRows = toFiniteNumber(val)
      } else if (keyLower === 'actual row count') {
        currentNode.actualRows = toFiniteNumber(val)
      } else if (keyLower === 'actual time') {
        currentNode.actualTotalTimeMs = parseTimeWithUnitMs(val)
      } else if (keyLower === 'spans' && /FULL SCAN/i.test(val)) {
        currentNode.warnings = currentNode.warnings || []
        if (!currentNode.warnings.includes('Full Table Scan')) {
          currentNode.warnings.push('Full Table Scan')
        }
      }
    }
  }

  if (!root) return null
  return {
    format: 'cockroach-text',
    dialect: 'cockroachdb',
    nodeCount: countTreeNodes(root),
    root,
    rawText: text,
  }
}

// ---------------------------------------------------------------------------
// 5. Oracle PLAN_TABLE Rows + DBMS_XPLAN Fallback
// ---------------------------------------------------------------------------

export function parseOraclePlanRowsExplain(input) {
  const tab = extractTabularInput(input)
  if (!tab) return null
  const cols = tab.columns.map((c) => c.toUpperCase())
  const idx = {
    id: cols.indexOf('ID'),
    parentId: cols.indexOf('PARENT_ID'),
    operation: cols.indexOf('OPERATION'),
    options: cols.indexOf('OPTIONS'),
    objectName: cols.indexOf('OBJECT_NAME'),
    objectAlias: cols.indexOf('OBJECT_ALIAS'),
    objectType: cols.indexOf('OBJECT_TYPE'),
    cost: cols.indexOf('COST'),
    cardinality: cols.indexOf('CARDINALITY'),
    bytes: cols.indexOf('BYTES'),
    accessPred: cols.indexOf('ACCESS_PREDICATES'),
    filterPred: cols.indexOf('FILTER_PREDICATES'),
    lastStarts: cols.indexOf('LAST_STARTS'),
    lastOutputRows: cols.indexOf('LAST_OUTPUT_ROWS'),
    lastElapsedTime: cols.indexOf('LAST_ELAPSED_TIME'),
  }
  if (idx.id === -1 || idx.operation === -1) return null

  const nodeMap = new Map()
  const ordered = []
  for (const row of tab.rows) {
    const rawId = Number(row[idx.id])
    const rawParent =
      idx.parentId >= 0 && row[idx.parentId] !== null && row[idx.parentId] !== undefined
        ? Number(row[idx.parentId])
        : null
    const op = row[idx.operation] != null ? String(row[idx.operation]) : 'OPERATION'
    const opt = idx.options >= 0 && row[idx.options] != null ? String(row[idx.options]) : ''
    const nodeType = opt ? `${op} ${opt}` : op
    const objName = idx.objectName >= 0 && row[idx.objectName] != null ? String(row[idx.objectName]) : undefined
    const objType = idx.objectType >= 0 && row[idx.objectType] != null ? String(row[idx.objectType]) : ''
    const isIndexOp = /INDEX/i.test(op) || /INDEX/i.test(objType)

    const lastStarts = idx.lastStarts >= 0 ? toFiniteNumber(row[idx.lastStarts]) : null
    const lastOutputRows = idx.lastOutputRows >= 0 ? toFiniteNumber(row[idx.lastOutputRows]) : null
    const lastElapsedUs = idx.lastElapsedTime >= 0 ? toFiniteNumber(row[idx.lastElapsedTime]) : null
    const starts = lastStarts !== null && lastStarts > 0 ? lastStarts : 1

    const totalElapsedMs = lastElapsedUs !== null ? lastElapsedUs / 1000 : null
    const perStartTimeMs = totalElapsedMs !== null ? totalElapsedMs / starts : null
    const perStartRows = lastOutputRows !== null ? lastOutputRows / starts : null

    const details = {}
    if (idx.accessPred >= 0 && row[idx.accessPred]) details['Access'] = String(row[idx.accessPred])
    if (idx.filterPred >= 0 && row[idx.filterPred]) details['Filter'] = String(row[idx.filterPred])
    if (idx.bytes >= 0 && row[idx.bytes] != null) details['Bytes'] = String(row[idx.bytes])

    const warnings = []
    if (/TABLE ACCESS/i.test(op) && /FULL/i.test(opt)) {
      warnings.push('Full Table Scan')
    }

    const node = makeBaseNode({
      id: `ora_${rawId}`,
      parentId: rawParent !== null && Number.isFinite(rawParent) ? `ora_${rawParent}` : null,
      nodeType,
      relation: !isIndexOp ? objName : undefined,
      indexName: isIndexOp ? objName : undefined,
      alias: idx.objectAlias >= 0 && row[idx.objectAlias] ? String(row[idx.objectAlias]) : undefined,
      totalCost: idx.cost >= 0 ? toFiniteNumber(row[idx.cost]) : null,
      planRows: idx.cardinality >= 0 ? toFiniteNumber(row[idx.cardinality]) : null,
      actualLoops: lastStarts,
      actualRows: perStartRows,
      actualTotalTimeMs: perStartTimeMs,
      warnings,
      details,
      children: [],
    })

    if (lastOutputRows !== null || totalElapsedMs !== null) {
      setReportedNodeTotals(node, {
        ...(lastOutputRows !== null ? { totalActualRows: lastOutputRows } : {}),
        ...(totalElapsedMs !== null ? { totalActualTimeMs: totalElapsedMs } : {}),
      })
    }

    nodeMap.set(rawId, node)
    ordered.push({ rawId, rawParent, node })
  }

  let root = null
  for (const item of ordered) {
    if (item.rawParent !== null && nodeMap.has(item.rawParent)) {
      nodeMap.get(item.rawParent).children.push(item.node)
    } else if (!root) {
      item.node.parentId = null
      root = item.node
    }
  }
  if (!root) return null

  return {
    format: 'oracle-plan-rows',
    dialect: 'oracle',
    totalCost: root.totalCost ?? null,
    nodeCount: countTreeNodes(root),
    root,
  }
}

export function parseOracleXplanExplain(input) {
  const text = extractTextFromInput(input)
  if (!text || !/\|\s*Id\s*\|\s*Operation\s*\|/i.test(text)) return null

  const lines = text.split(/\r?\n/)
  const rowRe = /^\|\s*(\*?\s*\d+)\s*\|([^|]+)\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|/
  const stack = []
  const byOpId = new Map()
  let root = null
  let inPredicates = false

  for (const line of lines) {
    if (/Predicate Information/i.test(line)) {
      inPredicates = true
      continue
    }
    if (inPredicates) {
      const pm = /^\s*(\d+)\s*-\s*(access|filter)\((.+)\)\s*$/i.exec(line)
      if (pm) {
        const target = byOpId.get(Number(pm[1]))
        if (target) {
          target.details = target.details || {}
          const key = pm[2][0].toUpperCase() + pm[2].slice(1).toLowerCase()
          target.details[key] = pm[3].trim()
        }
      }
      continue
    }

    const m = rowRe.exec(line)
    if (!m) continue
    const rawOpId = Number(m[1].replace('*', '').trim())
    const opRaw = m[2].replace(/^ /, '')
    const indent = opRaw.length - opRaw.trimStart().length
    const opLabel = opRaw.trim()
    const objName = m[3].trim() || undefined
    const rows = toFiniteNumber(m[4].replace(/[^\d.]/g, ''))
    const costMatch = /(\d+)/.exec(m[6])
    const cost = costMatch ? Number(costMatch[1]) : null
    const isIndexOp = /INDEX/i.test(opLabel)

    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop()
    }
    const parent = stack.length > 0 ? stack[stack.length - 1].node : null
    const warnings = /TABLE ACCESS FULL/i.test(opLabel) ? ['Full Table Scan'] : []

    const node = makeBaseNode({
      id: `xplan_${rawOpId}`,
      parentId: parent ? parent.id : null,
      nodeType: opLabel,
      relation: !isIndexOp ? objName : undefined,
      indexName: isIndexOp ? objName : undefined,
      totalCost: cost,
      planRows: rows,
      warnings,
      details: {},
      children: [],
    })
    byOpId.set(rawOpId, node)
    if (parent) parent.children.push(node)
    else if (!root) root = node
    stack.push({ indent, node })
  }

  if (!root) return null
  return {
    format: 'oracle-xplan',
    dialect: 'oracle',
    totalCost: root.totalCost ?? null,
    nodeCount: countTreeNodes(root),
    root,
    rawText: text,
  }
}

// ---------------------------------------------------------------------------
// 6. MSSQL SHOWPLAN_XML + SHOWPLAN_ALL Parsers
// ---------------------------------------------------------------------------

function unbracketIdent(name) {
  if (!name) return ''
  const trimmed = name.trim()
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1).replace(/\]\]/g, ']')
  }
  return trimmed
}

function escapeMssqlBracketIdent(name) {
  return String(name || '').replace(/\]/g, ']]')
}

function findXmlDescendants(el, tagName, out = []) {
  if (!el) return out
  if (el.name === tagName) out.push(el)
  for (const child of el.children) {
    findXmlDescendants(child, tagName, out)
  }
  return out
}

function findDirectChild(el, tagName) {
  return el.children.find((c) => c.name === tagName) || null
}

function extractMssqlMissingIndexes(queryPlanEl) {
  const missingGroups = findXmlDescendants(queryPlanEl, 'MissingIndexGroup')
  const out = []
  for (const grp of missingGroups) {
    const impact = toFiniteNumber(grp.attrs.Impact)
    for (const mi of findXmlDescendants(grp, 'MissingIndex')) {
      const schema = unbracketIdent(mi.attrs.Schema) || 'dbo'
      const table = unbracketIdent(mi.attrs.Table)
      if (!table) continue
      const equalityColumns = []
      const inequalityColumns = []
      const includeColumns = []

      for (const cg of mi.children) {
        if (cg.name !== 'ColumnGroup') continue
        const usage = (cg.attrs.Usage || '').toUpperCase()
        const cols = cg.children
          .filter((c) => c.name === 'Column' && c.attrs.Name)
          .map((c) => unbracketIdent(c.attrs.Name))
        if (usage === 'EQUALITY') equalityColumns.push(...cols)
        else if (usage === 'INEQUALITY') inequalityColumns.push(...cols)
        else if (usage === 'INCLUDE') includeColumns.push(...cols)
      }

      const keyCols = [...equalityColumns, ...inequalityColumns]
      const rawIdxName = `IX_${table}_${keyCols.join('_')}`.replace(/\s+/g, '_').slice(0, 128)
      const safeIdx = escapeMssqlBracketIdent(rawIdxName)
      const safeSchema = escapeMssqlBracketIdent(schema)
      const safeTable = escapeMssqlBracketIdent(table)
      const keySql = keyCols.map((c) => `[${escapeMssqlBracketIdent(c)}]`).join(', ')
      const incSql =
        includeColumns.length > 0
          ? ` INCLUDE (${includeColumns.map((c) => `[${escapeMssqlBracketIdent(c)}]`).join(', ')})`
          : ''
      const ddl = `CREATE NONCLUSTERED INDEX [${safeIdx}] ON [${safeSchema}].[${safeTable}] (${keySql})${incSql};`

      out.push({
        table: `${schema}.${table}`,
        ...(equalityColumns.length > 0 ? { equalityColumns } : {}),
        ...(inequalityColumns.length > 0 ? { inequalityColumns } : {}),
        ...(includeColumns.length > 0 ? { includeColumns } : {}),
        ...(impact !== null ? { impact } : {}),
        ddl,
      })
    }
  }
  return out
}

function findRelOpScopedDescendants(relOpEl, tagName, out = []) {
  if (!relOpEl) return out
  for (const child of relOpEl.children) {
    if (child.name === 'RelOp') continue
    if (child.name === tagName) out.push(child)
    findRelOpScopedDescendants(child, tagName, out)
  }
  return out
}

function convertMssqlRelOp(relOpEl, parentId, nextId) {
  const id = relOpEl.attrs.NodeId ? `ms_${relOpEl.attrs.NodeId}` : nextId()
  const physicalOp = relOpEl.attrs.PhysicalOp || 'RelOp'
  const logicalOp = relOpEl.attrs.LogicalOp || physicalOp
  const warnings = []
  const details = {}
  if (logicalOp && logicalOp !== physicalOp) details['Logical Op'] = logicalOp

  let relation
  let indexName
  const directObj = findRelOpScopedDescendants(relOpEl, 'Object').find((obj) =>
    Boolean(obj.attrs.Table)
  )
  if (directObj) {
    const schema = unbracketIdent(directObj.attrs.Schema)
    const table = unbracketIdent(directObj.attrs.Table)
    relation = schema && table ? `${schema}.${table}` : table || undefined
    if (directObj.attrs.Index) indexName = unbracketIdent(directObj.attrs.Index)
  }

  // Warnings child (direct child only)
  const warnEl = findDirectChild(relOpEl, 'Warnings')
  if (warnEl) {
    if (warnEl.attrs.SpillToTempDb || findDirectChild(warnEl, 'SpillToTempDb')) {
      warnings.push('Disk Spill')
    }
    if (warnEl.attrs.NoJoinPredicate) warnings.push('No Join Predicate')
    for (const key of ['PlanAffectingConvert', 'ColumnsWithNoStatistics', 'UnmatchedIndexes']) {
      if (warnEl.attrs[key] || findDirectChild(warnEl, key)) warnings.push(key)
    }
  }

  if (/Table Scan/i.test(physicalOp)) warnings.push('Full Table Scan')

  // Runtime per-thread counters: MAX(ActualElapsedms), SUM(ActualRows / ActualExecutions / ActualLogicalReads)
  let actualRowsSum = null
  let actualExecSum = null
  let maxElapsedMs = null
  let logicalReadsSum = 0
  let hasReads = false

  const rti = findDirectChild(relOpEl, 'RunTimeInformation')
  if (rti) {
    const threads = rti.children.filter((c) => c.name === 'RunTimeCountersPerThread')
    for (const th of threads) {
      const r = toFiniteNumber(th.attrs.ActualRows)
      if (r !== null) actualRowsSum = (actualRowsSum ?? 0) + r
      const ex = toFiniteNumber(th.attrs.ActualExecutions)
      if (ex !== null) actualExecSum = (actualExecSum ?? 0) + ex
      const elMs = toFiniteNumber(th.attrs.ActualElapsedms)
      if (elMs !== null) maxElapsedMs = maxElapsedMs === null ? elMs : Math.max(maxElapsedMs, elMs)
      const reads = toFiniteNumber(th.attrs.ActualLogicalReads)
      if (reads !== null) {
        logicalReadsSum += reads
        hasReads = true
      }
    }
  }
  if (hasReads) details['Actual Logical Reads'] = logicalReadsSum

  // Direct nested RelOp children (avoid skipping intermediate wrappers like Filter/NestedLoops)
  const childRelOps = []
  const collectChildRelOps = (el) => {
    for (const ch of el.children) {
      if (ch.name === 'RelOp') childRelOps.push(ch)
      else collectChildRelOps(ch)
    }
  }
  collectChildRelOps(relOpEl)

  const node = makeBaseNode({
    id,
    parentId,
    nodeType: physicalOp,
    relation,
    indexName,
    totalCost: toFiniteNumber(relOpEl.attrs.EstimatedTotalSubtreeCost),
    planRows: toFiniteNumber(relOpEl.attrs.EstimateRows),
    planWidth: toFiniteNumber(relOpEl.attrs.AvgRowSize),
    actualTotalTimeMs: maxElapsedMs,
    actualRows: actualRowsSum,
    actualLoops: actualExecSum,
    warnings,
    details,
    children: childRelOps.map((ch) => convertMssqlRelOp(ch, id, nextId)),
  })

  if (actualRowsSum !== null || maxElapsedMs !== null) {
    setReportedNodeTotals(node, {
      ...(actualRowsSum !== null ? { totalActualRows: actualRowsSum } : {}),
      ...(maxElapsedMs !== null ? { totalActualTimeMs: maxElapsedMs } : {}),
    })
  }
  return node
}

export function parseMssqlShowplanXmlExplain(input) {
  const text = extractTextFromInput(input)
  if (!text || !/<(?:[A-Za-z_][\w.-]*:)?ShowPlanXML\b/i.test(text)) return null

  let xmlRoot = null
  try {
    xmlRoot = parseXmlStrict(text).root
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return {
      format: 'raw-text',
      dialect: 'mssql',
      nodeCount: 0,
      warnings: [`MSSQL Showplan XML could not be parsed (${reason}); showing raw output.`],
      root: null,
      rawText: text,
    }
  }
  if (!xmlRoot) return null
  const queryPlan = findXmlDescendants(xmlRoot, 'QueryPlan')[0]
  if (!queryPlan) return null

  const topRelOps = []
  for (const ch of queryPlan.children) {
    if (ch.name === 'RelOp') topRelOps.push(ch)
  }
  if (topRelOps.length === 0) return null

  const nextId = createIdFactory()
  const root = convertMssqlRelOp(topRelOps[0], null, nextId)
  const missingIndexes = extractMssqlMissingIndexes(queryPlan)

  return {
    format: 'mssql-showplan-xml',
    dialect: 'mssql',
    totalCost: root.totalCost ?? null,
    nodeCount: countTreeNodes(root),
    ...(missingIndexes.length > 0 ? { missingIndexes } : {}),
    root,
    rawText: text,
  }
}

export function parseMssqlShowplanAllExplain(input) {
  const tab = extractTabularInput(input)
  if (!tab) return null
  const cols = tab.columns.map((c) => c.toLowerCase())
  const idx = {
    stmtText: cols.indexOf('stmttext'),
    nodeId: cols.indexOf('nodeid'),
    parent: cols.indexOf('parent'),
    physicalOp: cols.indexOf('physicalop'),
    logicalOp: cols.indexOf('logicalop'),
    estRows: cols.indexOf('estimaterows'),
    totalCost: cols.indexOf('totalsubtreecost'),
    avgRowSize: cols.indexOf('avgrowsize'),
    warnings: cols.indexOf('warnings'),
  }
  if (idx.nodeId === -1 || idx.parent === -1 || idx.physicalOp === -1) return null

  const nodeMap = new Map()
  const ordered = []
  for (const row of tab.rows) {
    const rawId = Number(row[idx.nodeId])
    const rawParent = Number(row[idx.parent])
    const phys = row[idx.physicalOp] ? String(row[idx.physicalOp]) : ''
    const logi = idx.logicalOp >= 0 && row[idx.logicalOp] ? String(row[idx.logicalOp]) : ''
    const stmt = idx.stmtText >= 0 && row[idx.stmtText] ? String(row[idx.stmtText]) : ''
    const nodeType = phys || logi || 'SELECT'
    const warnings =
      idx.warnings >= 0 && row[idx.warnings] ? [String(row[idx.warnings])] : []
    if (/Table Scan/i.test(nodeType)) warnings.push('Full Table Scan')

    const node = makeBaseNode({
      id: `msall_${rawId}`,
      parentId: rawParent > 0 ? `msall_${rawParent}` : null,
      nodeType,
      totalCost: idx.totalCost >= 0 ? toFiniteNumber(row[idx.totalCost]) : null,
      planRows: idx.estRows >= 0 ? toFiniteNumber(row[idx.estRows]) : null,
      planWidth: idx.avgRowSize >= 0 ? toFiniteNumber(row[idx.avgRowSize]) : null,
      warnings,
      details: stmt ? { Statement: stmt.trim() } : undefined,
      children: [],
    })
    nodeMap.set(rawId, node)
    ordered.push({ rawId, rawParent, node })
  }

  let root = null
  for (const item of ordered) {
    if (nodeMap.has(item.rawParent)) {
      nodeMap.get(item.rawParent).children.push(item.node)
    } else if (!root) {
      item.node.parentId = null
      root = item.node
    }
  }
  if (!root) return null

  return {
    format: 'mssql-showplan-all',
    dialect: 'mssql',
    totalCost: root.totalCost ?? null,
    nodeCount: countTreeNodes(root),
    root,
  }
}

// ---------------------------------------------------------------------------
// 7. Indented Text (Postgres / ClickHouse / DuckDB) + Dameng Text
// ---------------------------------------------------------------------------

export function parseDamengTextExplain(input) {
  const text = extractTextFromInput(input)
  if (!text) return null
  const lines = text.split(/\r?\n/)
  const dmRe = /^(\d+)(\s+)#([A-Z0-9_]+)\s*:\s*\[([^\]]+)\](.*)$/
  const matched = []
  for (const line of lines) {
    const m = dmRe.exec(line.trimEnd())
    if (m) matched.push(m)
  }
  if (matched.length === 0) return null

  const stack = []
  let root = null
  for (const m of matched) {
    const lineNo = m[1]
    const indent = m[2].length
    const op = `#${m[3]}`
    const nums = m[4].split(',').map((s) => toFiniteNumber(s))
    const rest = m[5].replace(/^;\s*/, '').trim()
    const tblMatch = /^([A-Za-z0-9_.$]+)\(/.exec(rest)

    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop()
    }
    const parent = stack.length > 0 ? stack[stack.length - 1].node : null
    const node = makeBaseNode({
      id: `dm_${lineNo}`,
      parentId: parent ? parent.id : null,
      nodeType: op,
      relation: tblMatch ? tblMatch[1] : undefined,
      totalCost: nums[0] ?? null,
      planRows: nums[1] ?? null,
      planWidth: nums[2] ?? null,
      details: rest ? { Detail: rest } : undefined,
      children: [],
    })
    if (parent) parent.children.push(node)
    else if (!root) root = node
    stack.push({ indent, node })
  }

  if (!root) return null
  return {
    format: 'dameng-text',
    totalCost: root.totalCost ?? null,
    nodeCount: countTreeNodes(root),
    root,
    rawText: text,
  }
}

export function parseIndentedTextExplain(input, dialect) {
  const text = extractTextFromInput(input)
  if (!text || !text.trim()) return null

  const lines = text.split(/\r?\n/)
  const nextId = createIdFactory()
  const stack = []
  let root = null
  let planningTimeMs = null
  let executionTimeMs = null

  for (const rawLine of lines) {
    const trimmed = rawLine.trim()
    if (!trimmed) continue
    const planTime = /^Planning Time:\s*(\d+(?:\.\d+)?)\s*ms/i.exec(trimmed)
    if (planTime) {
      planningTimeMs = Number(planTime[1])
      continue
    }
    const execTime = /^(?:Execution Time|Total Runtime):\s*(\d+(?:\.\d+)?)\s*ms/i.exec(trimmed)
    if (execTime) {
      executionTimeMs = Number(execTime[1])
      continue
    }
    if (/^[+-]{3,}$/.test(trimmed) || /^QUERY PLAN$/i.test(trimmed)) continue

    const isAttrLine =
      /^(?:Filter|Index Cond|Hash Cond|Merge Cond|Recheck Cond|Sort Key|Sort Method|Buffers|Output|Workers Planned|Workers Launched|Heap Fetches):/i.test(
        trimmed
      )
    if (isAttrLine && stack.length > 0) {
      const cur = stack[stack.length - 1].node
      const colonIdx = trimmed.indexOf(':')
      const k = trimmed.slice(0, colonIdx).trim()
      const v = trimmed.slice(colonIdx + 1).trim()
      cur.details = cur.details || {}
      cur.details[k] = v
      if (k === 'Workers Planned') cur.workersPlanned = toFiniteNumber(v)
      if (k === 'Workers Launched') cur.workersLaunched = toFiniteNumber(v)
      continue
    }

    const leadMatch = /^(\s*(?:->\s*)?)/.exec(rawLine)
    const indent = leadMatch ? leadMatch[1].length : 0
    const body = rawLine.replace(/^\s*(?:->\s*)?/, '').trim()

    let startupCost = null
    let totalCost = null
    let planRows = null
    let planWidth = null
    const costMatch = /\(cost=(\d+(?:\.\d+)?)\.\.(\d+(?:\.\d+)?)\s+rows=(\d+(?:\.\d+)?)\s+width=(\d+)\)/.exec(
      body
    )
    if (costMatch) {
      startupCost = Number(costMatch[1])
      totalCost = Number(costMatch[2])
      planRows = Number(costMatch[3])
      planWidth = Number(costMatch[4])
    }

    let actualStartupTimeMs = null
    let actualTotalTimeMs = null
    let actualRows = null
    let actualLoops = null
    const actMatch = /\(actual time=(\d+(?:\.\d+)?)\.\.(\d+(?:\.\d+)?)\s+rows=(\d+(?:\.\d+)?)\s+loops=(\d+(?:\.\d+)?)\)/.exec(
      body
    )
    if (actMatch) {
      actualStartupTimeMs = Number(actMatch[1])
      actualTotalTimeMs = Number(actMatch[2])
      actualRows = Number(actMatch[3])
      actualLoops = Number(actMatch[4])
    }

    const opPart = body.replace(/\s*\(cost=.*$/, '').trim()
    const onMatch = /^(.+?)\s+on\s+([^\s(]+)/i.exec(opPart)
    const nodeType = (onMatch ? onMatch[1] : opPart).trim() || 'Operation'
    const relation = onMatch ? onMatch[2].replace(/[`"]/g, '') : undefined

    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop()
    }
    const parent = stack.length > 0 ? stack[stack.length - 1].node : null
    const node = makeBaseNode({
      id: nextId(),
      parentId: parent ? parent.id : null,
      nodeType,
      relation,
      startupCost,
      totalCost,
      planRows,
      planWidth,
      actualStartupTimeMs,
      actualTotalTimeMs,
      actualRows,
      actualLoops,
      details: {},
      children: [],
    })
    if (parent) parent.children.push(node)
    else if (!root) root = node
    stack.push({ indent, node })
  }

  if (!root) return null
  return {
    format: 'indented-text',
    ...(dialect ? { dialect } : {}),
    planningTimeMs,
    executionTimeMs,
    totalCost: root.totalCost ?? null,
    nodeCount: countTreeNodes(root),
    root,
    rawText: text,
  }
}

// ---------------------------------------------------------------------------
// 8. MongoDB Explain Parser
// ---------------------------------------------------------------------------

function convertMongoStage(stageObj, parentId, nextId) {
  const id = nextId()
  const stageName = typeof stageObj.stage === 'string' ? stageObj.stage : 'STAGE'
  const ns = typeof stageObj.namespace === 'string' ? stageObj.namespace : undefined
  const indexName = typeof stageObj.indexName === 'string' ? stageObj.indexName : undefined
  const warnings = []
  if (stageName === 'COLLSCAN') warnings.push('COLLSCAN')
  if (stageName === 'SORT' || stageName === 'SORT_KEY_GENERATOR') warnings.push('Filesort')

  const details = {}
  for (const key of ['works', 'advanced', 'docsExamined', 'keysExamined', 'direction']) {
    if (stageObj[key] !== undefined) details[key] = String(stageObj[key])
  }

  const children = []
  if (stageObj.inputStage && typeof stageObj.inputStage === 'object') {
    children.push(convertMongoStage(stageObj.inputStage, id, nextId))
  }
  if (Array.isArray(stageObj.inputStages)) {
    for (const child of stageObj.inputStages) {
      if (child && typeof child === 'object') {
        children.push(convertMongoStage(child, id, nextId))
      }
    }
  }
  if (Array.isArray(stageObj.shards)) {
    for (const shard of stageObj.shards) {
      const shardStage = shard?.executionStages ?? shard?.winningPlan
      if (shardStage && typeof shardStage === 'object') {
        children.push(convertMongoStage(shardStage, id, nextId))
      }
    }
  }

  return makeBaseNode({
    id,
    parentId,
    nodeType: stageName,
    relation: ns,
    indexName,
    actualTotalTimeMs: toFiniteNumber(
      stageObj.executionTimeMillisEstimate ?? stageObj.executionTimeMillis
    ),
    actualRows: toFiniteNumber(stageObj.nReturned),
    actualLoops: stageObj.nReturned !== undefined ? 1 : null,
    warnings,
    details,
    children,
  })
}

export function parseMongoExplain(input) {
  const parsed = tryParseJson(input)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const execStage = parsed.executionStats?.executionStages
  const winStage = parsed.queryPlanner?.winningPlan
  const topStage = execStage || winStage
  if (!topStage || typeof topStage !== 'object' || typeof topStage.stage !== 'string') {
    return null
  }
  const nextId = createIdFactory()
  const root = convertMongoStage(topStage, null, nextId)
  const executionTimeMs = toFiniteNumber(parsed.executionStats?.executionTimeMillis)
  return {
    format: 'mongodb-explain',
    dialect: 'mongodb',
    executionTimeMs,
    nodeCount: countTreeNodes(root),
    root,
    rawText: typeof input === 'string' ? input : JSON.stringify(parsed),
  }
}

// ---------------------------------------------------------------------------
// Parser Registry & Auto-Detection Dispatcher
// ---------------------------------------------------------------------------

const PARSER_MAP = new Map([
  ['postgres-json', (input) => parsePostgresJsonExplain(input)],
  ['mysql-composite', (input, opts) => parseMysqlCompositeExplain(input, opts?.dialect || 'mysql')],
  ['sqlite-eqp', (input) => parseSqliteEqpExplain(input)],
  ['cockroach-text', (input) => parseCockroachTextExplain(input)],
  ['oracle-plan-rows', (input) => parseOraclePlanRowsExplain(input)],
  ['oracle-xplan', (input) => parseOracleXplanExplain(input)],
  ['mssql-showplan-xml', (input) => parseMssqlShowplanXmlExplain(input)],
  ['mssql-showplan-all', (input) => parseMssqlShowplanAllExplain(input)],
  ['dameng-text', (input) => parseDamengTextExplain(input)],
  ['indented-text', (input, opts) => parseIndentedTextExplain(input, opts?.dialect)],
  ['mongodb-explain', (input) => parseMongoExplain(input)],
])

export const ExplainPlanParserRegistry = {
  register(id, parserFn) {
    if (typeof id === 'string' && id.trim() && typeof parserFn === 'function') {
      PARSER_MAP.set(id.trim(), parserFn)
    }
  },
  get(id) {
    return PARSER_MAP.get(id) || null
  },
  listIds() {
    return Array.from(PARSER_MAP.keys())
  },
  parse(input, options) {
    return parseRawExplainInput(input, options)
  },
}

const DIALECT_ORDER = {
  postgres: ['postgres-json', 'indented-text'],
  mysql: ['mysql-composite', 'indented-text'],
  mariadb: ['mysql-composite', 'indented-text'],
  sqlite: ['sqlite-eqp', 'indented-text'],
  libsql: ['sqlite-eqp', 'indented-text'],
  d1: ['sqlite-eqp', 'indented-text'],
  cockroachdb: ['cockroach-text', 'postgres-json', 'indented-text'],
  oracle: ['oracle-plan-rows', 'oracle-xplan', 'indented-text'],
  mssql: ['mssql-showplan-xml', 'mssql-showplan-all', 'indented-text'],
  mongodb: ['mongodb-explain'],
  clickhouse: ['indented-text'],
  redis: ['indented-text'],
}

export function parseRawExplainInput(input, options) {
  const opts = options || {}
  if (opts.format && PARSER_MAP.has(opts.format)) {
    const parser = PARSER_MAP.get(opts.format)
    const hit = parser(input, opts)
    if (hit) return hit
  }

  const preferred = opts.dialect && DIALECT_ORDER[opts.dialect] ? DIALECT_ORDER[opts.dialect] : []
  const tried = new Set()

  for (const id of preferred) {
    tried.add(id)
    const parser = PARSER_MAP.get(id)
    if (!parser) continue
    const res = parser(input, opts)
    if (res) {
      if (opts.dialect && !res.dialect) res.dialect = opts.dialect
      return res
    }
  }

  for (const [id, parser] of PARSER_MAP.entries()) {
    if (tried.has(id)) continue
    const res = parser(input, opts)
    if (res) {
      if (opts.dialect && !res.dialect) res.dialect = opts.dialect
      return res
    }
  }

  const fallbackText = extractTextFromInput(input)
  return {
    format: 'raw-text',
    ...(opts.dialect ? { dialect: opts.dialect } : {}),
    nodeCount: 0,
    root: null,
    ...(fallbackText ? { rawText: fallbackText } : {}),
  }
}
