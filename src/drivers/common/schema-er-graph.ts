// Shared types, normalizers, and fast-path 3-query ER graph builders across database drivers.

import type {
  SchemaErColumn,
  SchemaErEdge,
  SchemaErGraph,
  SchemaErNode,
  TableDetails,
} from '../../protocol'

export const ER_LITE_FALLBACK_MAX_TABLES = 100

export interface RawErTableRow {
  schema: string
  name: string
  kind?: 'table' | 'view'
}

export interface RawErColumnRow {
  schema: string
  table: string
  name: string
  type: string
  nullable: boolean
  isPrimaryKey?: boolean
  isUnique?: boolean
  ordinalPosition?: number
}

export interface RawErUniqueSetRow {
  schema: string
  table: string
  indexName?: string
  columns: string[]
}

export interface RawErForeignKeyRow {
  constraintName?: string
  fromSchema: string
  fromTable: string
  fromColumn: string
  toSchema: string
  toTable: string
  toColumn: string
  ordinalPosition?: number
  onDelete?: string
  onUpdate?: string
}

export interface BuildSchemaErGraphInput {
  connectionId: string
  schema?: string
  completeness?: 'full' | 'lite'
  tables: readonly RawErTableRow[]
  columns: readonly RawErColumnRow[]
  uniqueSets?: readonly RawErUniqueSetRow[]
  foreignKeys: readonly RawErForeignKeyRow[]
  maxTables?: number
  totalTableCount?: number
}

/**
 * Formats the canonical ER node identifier (`${schema}.${table}` for plain names,
 * or dot-safe `JSON.stringify([schema, table])` when either contains `.` or starts with `[`).
 */
export function makeErNodeId(schema: string, table: string): string {
  const s = String(schema ?? '')
  const t = String(table ?? '')
  if (!s.includes('.') && !t.includes('.') && !s.startsWith('[') && !t.startsWith('[')) {
    return `${s}.${t}`
  }
  return JSON.stringify([s, t])
}

function resolveIdentifierMatch(candidates: readonly string[], target: string): string | null {
  if (!target) return null
  if (candidates.includes(target)) return target
  const lower = target.toLowerCase()
  const matches = candidates.filter((c) => c.toLowerCase() === lower)
  return matches.length === 1 ? matches[0] : null
}

function isSubsetOfSet(subset: readonly string[], superset: ReadonlySet<string>): boolean {
  if (subset.length === 0) return false
  for (const item of subset) {
    if (!superset.has(item)) return false
  }
  return true
}

function inferEdgeUnique(node: SchemaErNode | undefined, fromColumns: readonly string[]): boolean {
  if (!node || fromColumns.length === 0) return false
  const colNames = node.columns.map((c) => c.name)
  const resolvedFrom = fromColumns.map((c) => resolveIdentifierMatch(colNames, c) ?? c)
  const resolvedFromSet = new Set(resolvedFrom)

  if (node.primaryKey.length > 0) {
    const resolvedPk = node.primaryKey.map((k) => resolveIdentifierMatch(colNames, k) ?? k)
    if (isSubsetOfSet(resolvedPk, resolvedFromSet)) return true
  }

  if (Array.isArray(node.uniqueColumnSets)) {
    for (const uSet of node.uniqueColumnSets) {
      const resolvedSet = uSet.map((k) => resolveIdentifierMatch(colNames, k) ?? k)
      if (isSubsetOfSet(resolvedSet, resolvedFromSet)) return true
    }
  }

  for (const colName of resolvedFrom) {
    const matchedName = resolveIdentifierMatch(colNames, colName)
    const col = node.columns.find((c) => c.name === matchedName)
    if (col && (col.isUnique || (col.isPrimaryKey && node.primaryKey.length <= 1))) {
      return true
    }
  }

  return false
}

function inferEdgeOptional(node: SchemaErNode | undefined, fromColumns: readonly string[]): boolean {
  if (!node || fromColumns.length === 0) return true
  const colNames = node.columns.map((c) => c.name)
  for (const rawCol of fromColumns) {
    const resolved = resolveIdentifierMatch(colNames, rawCol) ?? rawCol
    const col = node.columns.find((c) => c.name === resolved)
    if (col && col.nullable) return true
  }
  return false
}

/**
 * Caps a list of tables to `maxTables` cleanly, reporting truncation metadata.
 */
export function capErTableList<T>(
  tables: readonly T[],
  maxTables = ER_LITE_FALLBACK_MAX_TABLES
): { items: T[]; truncated: boolean; totalTableCount: number } {
  const totalTableCount = tables.length
  if (maxTables > 0 && tables.length > maxTables) {
    return {
      items: tables.slice(0, maxTables),
      truncated: true,
      totalTableCount,
    }
  }
  return {
    items: [...tables],
    truncated: false,
    totalTableCount,
  }
}

/**
 * Builds a normalized `SchemaErGraph` from raw 3-query catalog rows
 * (tables/views, columns/PK/unique indexes, and foreign keys).
 */
export function buildSchemaErGraphFromCatalogRows(input: BuildSchemaErGraphInput): SchemaErGraph {
  const defaultSchema = input.schema?.trim() || 'public'
  const completeness = input.completeness ?? 'full'

  const capped =
    typeof input.maxTables === 'number' && input.maxTables > 0
      ? capErTableList(input.tables, input.maxTables)
      : { items: [...input.tables], truncated: false, totalTableCount: input.totalTableCount ?? input.tables.length }

  const nodeMap = new Map<string, SchemaErNode>()
  const columnsByNode = new Map<string, RawErColumnRow[]>()
  const uniqueSetsByNode = new Map<string, string[][]>()

  for (const tbl of capped.items) {
    const schema = tbl.schema?.trim() || defaultSchema
    const id = makeErNodeId(schema, tbl.name)
    if (nodeMap.has(id)) continue
    nodeMap.set(id, {
      id,
      schema,
      name: tbl.name,
      kind: tbl.kind === 'view' ? 'view' : 'table',
      columns: [],
      primaryKey: [],
    })
  }

  for (const col of input.columns) {
    const schema = col.schema?.trim() || defaultSchema
    const nodeId = makeErNodeId(schema, col.table)
    if (!nodeMap.has(nodeId)) continue
    const list = columnsByNode.get(nodeId) ?? []
    list.push(col)
    columnsByNode.set(nodeId, list)
  }

  for (const uSet of input.uniqueSets ?? []) {
    if (!Array.isArray(uSet.columns) || uSet.columns.length === 0) continue
    const schema = uSet.schema?.trim() || defaultSchema
    const nodeId = makeErNodeId(schema, uSet.table)
    if (!nodeMap.has(nodeId)) continue
    const list = uniqueSetsByNode.get(nodeId) ?? []
    list.push([...uSet.columns])
    uniqueSetsByNode.set(nodeId, list)
  }

  const fkColsByNode = new Map<string, string[]>()
  const groupedEdges = new Map<
    string,
    {
      id: string
      constraintName?: string
      fromNodeId: string
      toNodeId: string
      fromSchema: string
      fromTable: string
      toSchema: string
      toTable: string
      pairs: Array<{ fromColumn: string; toColumn: string; ordinal: number }>
      onDelete?: string
      onUpdate?: string
    }
  >()

  const sortedFks = [...input.foreignKeys].sort(
    (a, b) => (a.ordinalPosition ?? 0) - (b.ordinalPosition ?? 0)
  )

  const resolveColumnPairSignature = (
    fromColumn: string,
    toColumn: string,
    fromColNames: readonly string[] | undefined,
    toColNames: readonly string[] | undefined
  ): string => {
    const normFrom = fromColNames
      ? resolveIdentifierMatch(fromColNames, fromColumn) ?? fromColumn
      : fromColumn
    const normTo = toColNames
      ? resolveIdentifierMatch(toColNames, toColumn) ?? toColumn
      : toColumn
    return `${normFrom}\u0000${normTo}`
  }

  for (const fk of sortedFks) {
    const fromSchema = fk.fromSchema?.trim() || defaultSchema
    const toSchema = fk.toSchema?.trim() || fromSchema
    const fromNodeId = makeErNodeId(fromSchema, fk.fromTable)
    if (!nodeMap.has(fromNodeId)) continue
    const toNodeId = makeErNodeId(toSchema, fk.toTable)

    let fkColList = fkColsByNode.get(fromNodeId)
    if (!fkColList) {
      fkColList = []
      fkColsByNode.set(fromNodeId, fkColList)
    }
    fkColList.push(fk.fromColumn)

    const constraintKey = fk.constraintName?.trim() || `${fromNodeId}->${toNodeId}`
    const groupKey = JSON.stringify([fromNodeId, toNodeId, constraintKey])
    let group = groupedEdges.get(groupKey)
    if (!group) {
      group = {
        id: groupKey,
        ...(fk.constraintName ? { constraintName: fk.constraintName } : {}),
        fromNodeId,
        toNodeId,
        fromSchema,
        fromTable: fk.fromTable,
        toSchema,
        toTable: fk.toTable,
        pairs: [],
        ...(fk.onDelete ? { onDelete: fk.onDelete } : {}),
        ...(fk.onUpdate ? { onUpdate: fk.onUpdate } : {}),
      }
      groupedEdges.set(groupKey, group)
    }
    const fromColNames = columnsByNode.get(fromNodeId)?.map((c) => c.name)
    const toColNames = columnsByNode.get(toNodeId)?.map((c) => c.name)
    const nextSig = resolveColumnPairSignature(fk.fromColumn, fk.toColumn, fromColNames, toColNames)
    const dup = group.pairs.some(
      (p) => resolveColumnPairSignature(p.fromColumn, p.toColumn, fromColNames, toColNames) === nextSig
    )
    if (!dup) {
      group.pairs.push({
        fromColumn: fk.fromColumn,
        toColumn: fk.toColumn,
        ordinal: fk.ordinalPosition ?? group.pairs.length,
      })
    }
  }

  for (const [nodeId, node] of nodeMap.entries()) {
    const rawCols = (columnsByNode.get(nodeId) ?? []).slice().sort((a, b) => {
      if (a.ordinalPosition !== undefined && b.ordinalPosition !== undefined) {
        return a.ordinalPosition - b.ordinalPosition
      }
      return 0
    })
    const colNames = rawCols.map((c) => c.name)
    const uSets = uniqueSetsByNode.get(nodeId) ?? []
    const singleUnique = new Set<string>()
    for (const set of uSets) {
      if (set.length === 1) {
        const resolved = resolveIdentifierMatch(colNames, set[0])
        if (resolved !== null) {
          singleUnique.add(resolved)
        }
      }
    }
    const resolvedFkSet = new Set<string>()
    for (const fkCol of fkColsByNode.get(nodeId) ?? []) {
      const resolved = resolveIdentifierMatch(colNames, fkCol)
      if (resolved !== null) {
        resolvedFkSet.add(resolved)
      }
    }
    const pkCols: string[] = []

    node.columns = rawCols.map((c): SchemaErColumn => {
      const isPk = Boolean(c.isPrimaryKey)
      if (isPk) pkCols.push(c.name)
      const isFk = resolvedFkSet.has(c.name)
      const isUniq = Boolean(c.isUnique) || singleUnique.has(c.name)
      return {
        name: c.name,
        type: c.type || '',
        nullable: Boolean(c.nullable),
        isPrimaryKey: isPk,
        ...(isFk ? { isForeignKey: true } : {}),
        ...(isUniq ? { isUnique: true } : {}),
      }
    })
    node.primaryKey = pkCols
    if (uSets.length > 0) {
      node.uniqueColumnSets = uSets
    }
  }

  const edges: SchemaErEdge[] = []
  for (const group of groupedEdges.values()) {
    group.pairs.sort((a, b) => a.ordinal - b.ordinal)
    const columnPairs = group.pairs.map((p) => ({
      fromColumn: p.fromColumn,
      toColumn: p.toColumn,
    }))

    if (!nodeMap.has(group.toNodeId)) {
      nodeMap.set(group.toNodeId, {
        id: group.toNodeId,
        schema: group.toSchema,
        name: group.toTable,
        kind: 'external_stub',
        primaryKey: columnPairs.map((p) => p.toColumn),
        columns: columnPairs.map((p) => ({
          name: p.toColumn,
          type: 'ref',
          nullable: false,
          isPrimaryKey: true,
        })),
      })
    }

    const fromNode = nodeMap.get(group.fromNodeId)
    const fromCols = columnPairs.map((p) => p.fromColumn)
    edges.push({
      id: group.id,
      ...(group.constraintName ? { constraintName: group.constraintName } : {}),
      fromNodeId: group.fromNodeId,
      toNodeId: group.toNodeId,
      fromSchema: group.fromSchema,
      fromTable: group.fromTable,
      toSchema: group.toSchema,
      toTable: group.toTable,
      columnPairs,
      unique: inferEdgeUnique(fromNode, fromCols),
      optional: inferEdgeOptional(fromNode, fromCols),
      crossSchema: group.fromSchema !== group.toSchema,
      ...(group.onDelete ? { onDelete: group.onDelete } : {}),
      ...(group.onUpdate ? { onUpdate: group.onUpdate } : {}),
    })
  }

  return {
    connectionId: input.connectionId,
    ...(input.schema ? { schema: input.schema } : {}),
    completeness,
    ...(capped.truncated ? { truncated: true } : {}),
    ...(capped.totalTableCount !== undefined ? { totalTableCount: capped.totalTableCount } : {}),
    nodes: Array.from(nodeMap.values()),
    edges,
    generatedAt: Date.now(),
  }
}

/**
 * Converts an array of `TableDetails` (used by lite fallback engines) into a canonical `SchemaErGraph`.
 */
export function buildSchemaErGraphFromTableDetails(
  connectionId: string,
  tables: readonly TableDetails[],
  options?: {
    schema?: string
    completeness?: 'full' | 'lite'
    maxTables?: number
    totalTableCount?: number
  }
): SchemaErGraph {
  const defaultSchema = options?.schema?.trim() || 'public'
  const rawTables: RawErTableRow[] = []
  const rawColumns: RawErColumnRow[] = []
  const rawUniqueSets: RawErUniqueSetRow[] = []
  const rawForeignKeys: RawErForeignKeyRow[] = []

  for (const tbl of tables) {
    const schema = tbl.schema?.trim() || defaultSchema
    rawTables.push({
      schema,
      name: tbl.name,
      kind: tbl.kind === 'view' ? 'view' : 'table',
    })
    const colNames = (tbl.columns ?? []).map((col) => col.name)
    const pkSet = new Set<string>()
    for (const pkCol of tbl.primaryKey ?? []) {
      const resolved = resolveIdentifierMatch(colNames, pkCol)
      if (resolved !== null) {
        pkSet.add(resolved)
      }
    }
    for (let i = 0; i < (tbl.columns ?? []).length; i++) {
      const col = tbl.columns[i]
      rawColumns.push({
        schema,
        table: tbl.name,
        name: col.name,
        type: col.type || col.nativeType || '',
        nullable: Boolean(col.nullable),
        isPrimaryKey: Boolean(col.isPrimaryKey) || pkSet.has(col.name),
        ordinalPosition: i,
      })
    }
    for (const idx of tbl.indexes ?? []) {
      if (!idx.isUnique || idx.partial || idx.isExpression) continue
      if (Array.isArray(idx.columns) && idx.columns.length > 0) {
        rawUniqueSets.push({
          schema,
          table: tbl.name,
          indexName: idx.name,
          columns: [...idx.columns],
        })
      }
    }
    for (let i = 0; i < (tbl.foreignKeys ?? []).length; i++) {
      const fk = tbl.foreignKeys[i]
      rawForeignKeys.push({
        constraintName: fk.constraintName,
        fromSchema: schema,
        fromTable: tbl.name,
        fromColumn: fk.column,
        toSchema: fk.referencedSchema?.trim() || schema,
        toTable: fk.referencedTable,
        toColumn: fk.referencedColumn,
        ordinalPosition: i,
        onDelete: fk.onDelete,
        onUpdate: fk.onUpdate,
      })
    }
  }

  return buildSchemaErGraphFromCatalogRows({
    connectionId,
    schema: options?.schema,
    completeness: options?.completeness ?? 'lite',
    tables: rawTables,
    columns: rawColumns,
    uniqueSets: rawUniqueSets,
    foreignKeys: rawForeignKeys,
    maxTables: options?.maxTables,
    totalTableCount: options?.totalTableCount ?? tables.length,
  })
}

/**
 * Assembles non-partial, non-expression SQLite/D1/LibSQL unique index rows into `RawErUniqueSetRow[]`.
 */
export function assembleSqliteUniqueSets(
  schema: string,
  rawUniqRows: readonly Record<string, unknown>[]
): RawErUniqueSetRow[] {
  const uniqueGroups = new Map<
    string,
    { table: string; indexName: string; invalid: boolean; cols: Array<{ name: string; seq: number }> }
  >()
  for (const u of rawUniqRows) {
    const tableName = String(u.table_name || '')
    const indexName = String(u.index_name || '')
    if (!tableName || !indexName) continue
    const uKey = `${tableName}\u0000${indexName}`
    let grp = uniqueGroups.get(uKey)
    if (!grp) {
      grp = { table: tableName, indexName, invalid: Number(u.is_partial ?? 0) !== 0, cols: [] }
      uniqueGroups.set(uKey, grp)
    }
    if (Number(u.is_partial ?? 0) !== 0) {
      grp.invalid = true
      continue
    }
    const cid = Number(u.cid ?? 0)
    const colName = typeof u.col_name === 'string' && u.col_name.length > 0 ? u.col_name : ''
    if (cid < 0 || !colName) {
      grp.invalid = true
      continue
    }
    const seq = Number(u.seqno ?? grp.cols.length)
    if (!grp.cols.some((c) => c.name === colName)) {
      grp.cols.push({ name: colName, seq: Number.isFinite(seq) ? seq : grp.cols.length })
    }
  }
  return Array.from(uniqueGroups.values())
    .filter((grp) => !grp.invalid && grp.cols.length > 0)
    .map((grp) => ({
      schema,
      table: grp.table,
      indexName: grp.indexName,
      columns: grp.cols.sort((a, b) => a.seq - b.seq).map((c) => c.name),
    }))
}

interface SqliteErTableFlags {
  withoutRowid: boolean
  strict: boolean
  hasInlinePkDesc: boolean
}

function skipSqliteQuotedOrComment(sql: string, i: number): number {
  const len = sql.length
  const ch = sql[i]
  if (ch === '-' && i + 1 < len && sql[i + 1] === '-') {
    const nl = sql.indexOf('\n', i + 2)
    return nl < 0 ? len : nl + 1
  }
  if (ch === '/' && i + 1 < len && sql[i + 1] === '*') {
    const close = sql.indexOf('*/', i + 2)
    return close < 0 ? len : close + 2
  }
  if (ch === "'" || ch === '"' || ch === '`') {
    let j = i + 1
    while (j < len) {
      if (sql[j] === ch) {
        if (j + 1 < len && sql[j + 1] === ch) {
          j += 2
          continue
        }
        return j + 1
      }
      j += 1
    }
    return len
  }
  if (ch === '[') {
    const close = sql.indexOf(']', i + 1)
    return close < 0 ? len : close + 1
  }
  return i
}

function stripSqliteSqlComments(sql: string): string {
  let out = ''
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]
    if ((ch === '-' && sql[i + 1] === '-') || (ch === '/' && sql[i + 1] === '*')) {
      out += ' '
      i = skipSqliteQuotedOrComment(sql, i)
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
      const next = skipSqliteQuotedOrComment(sql, i)
      out += sql.slice(i, next)
      i = next
      continue
    }
    out += ch
    i += 1
  }
  return out
}

function parseSqliteErTableFlags(tableSql: string): SqliteErTableFlags {
  if (!tableSql) {
    return { withoutRowid: false, strict: false, hasInlinePkDesc: false }
  }
  const len = tableSql.length
  let i = 0
  let openParen = -1
  while (i < len) {
    const ch = tableSql[i]
    if (
      (ch === '-' && tableSql[i + 1] === '-') ||
      (ch === '/' && tableSql[i + 1] === '*') ||
      ch === "'" ||
      ch === '"' ||
      ch === '`' ||
      ch === '['
    ) {
      i = skipSqliteQuotedOrComment(tableSql, i)
      continue
    }
    if (ch === '(') {
      openParen = i
      break
    }
    i += 1
  }
  if (openParen < 0) {
    return { withoutRowid: false, strict: false, hasInlinePkDesc: false }
  }

  let depth = 1
  let j = openParen + 1
  let closeParen = -1
  while (j < len && depth > 0) {
    const ch = tableSql[j]
    if (
      (ch === '-' && tableSql[j + 1] === '-') ||
      (ch === '/' && tableSql[j + 1] === '*') ||
      ch === "'" ||
      ch === '"' ||
      ch === '`' ||
      ch === '['
    ) {
      j = skipSqliteQuotedOrComment(tableSql, j)
      continue
    }
    if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth === 0) {
        closeParen = j
        break
      }
    }
    j += 1
  }

  const body = closeParen > openParen ? tableSql.slice(openParen + 1, closeParen) : ''
  const tail = closeParen >= 0 ? stripSqliteSqlComments(tableSql.slice(closeParen + 1)) : ''
  const withoutRowid = /\bWITHOUT\s+ROWID\b/i.test(tail)
  const strict = /\bSTRICT\b/i.test(tail)

  let hasInlinePkDesc = false
  if (body) {
    // Check top-level column clauses for inline `PRIMARY KEY DESC` (not a rowid alias in SQLite)
    const clauses: string[] = []
    let start = 0
    let cDepth = 0
    let k = 0
    while (k < body.length) {
      const ch = body[k]
      if (
        (ch === '-' && body[k + 1] === '-') ||
        (ch === '/' && body[k + 1] === '*') ||
        ch === "'" ||
        ch === '"' ||
        ch === '`' ||
        ch === '['
      ) {
        k = skipSqliteQuotedOrComment(body, k)
        continue
      }
      if (ch === '(') cDepth += 1
      else if (ch === ')' && cDepth > 0) cDepth -= 1
      else if (ch === ',' && cDepth === 0) {
        clauses.push(body.slice(start, k))
        start = k + 1
      }
      k += 1
    }
    clauses.push(body.slice(start))

    const tblConstraintStarts = new Set(['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'CHECK', 'FOREIGN'])
    for (const clause of clauses) {
      const words: Array<{ upper: string; quoted: boolean }> = []
      let p = 0
      while (p < clause.length) {
        const ch = clause[p]
        if (/\s/.test(ch)) {
          p += 1
          continue
        }
        if ((ch === '-' && clause[p + 1] === '-') || (ch === '/' && clause[p + 1] === '*')) {
          p = skipSqliteQuotedOrComment(clause, p)
          continue
        }
        if (ch === '"' || ch === '`' || ch === '[') {
          const next = skipSqliteQuotedOrComment(clause, p)
          words.push({ upper: clause.slice(p, next).toUpperCase(), quoted: true })
          p = next
          continue
        }
        if (ch === "'" || ch === '(') {
          if (ch === '(') {
            let pDepth = 1
            let q = p + 1
            while (q < clause.length && pDepth > 0) {
              const qc = clause[q]
              if (
                (qc === '-' && clause[q + 1] === '-') ||
                (qc === '/' && clause[q + 1] === '*') ||
                qc === "'" ||
                qc === '"' ||
                qc === '`' ||
                qc === '['
              ) {
                q = skipSqliteQuotedOrComment(clause, q)
                continue
              }
              if (qc === '(') pDepth += 1
              else if (qc === ')') pDepth -= 1
              q += 1
            }
            p = q
          } else {
            p = skipSqliteQuotedOrComment(clause, p)
          }
          continue
        }
        if (/[A-Za-z_]/.test(ch)) {
          let e = p + 1
          while (e < clause.length && /[A-Za-z0-9_$]/.test(clause[e])) e += 1
          words.push({ upper: clause.slice(p, e).toUpperCase(), quoted: false })
          p = e
          continue
        }
        p += 1
      }
      if (words.length === 0) continue
      if (!words[0].quoted && tblConstraintStarts.has(words[0].upper)) continue
      for (let w = 1; w + 2 < words.length; w += 1) {
        if (
          !words[w].quoted &&
          words[w].upper === 'PRIMARY' &&
          !words[w + 1].quoted &&
          words[w + 1].upper === 'KEY' &&
          !words[w + 2].quoted &&
          words[w + 2].upper === 'DESC'
        ) {
          hasInlinePkDesc = true
          break
        }
      }
      if (hasInlinePkDesc) break
    }
  }

  return { withoutRowid, strict, hasInlinePkDesc }
}

/**
 * Shared SQLite/D1/LibSQL ER column & foreign-key assembly:
 * - Preserves actual nullability on `TEXT PRIMARY KEY` / non-`INTEGER PRIMARY KEY` / composite PKs
 *   unless `notnull > 0`, `WITHOUT ROWID`, `STRICT`, or single-column `INTEGER PRIMARY KEY` rowid alias.
 * - Resolves `fk.table` case-insensitively against catalog tables, resolves implicit `fk.to` from
 *   the resolved parent's primary key, and never trims spaces inside column names.
 */
export function assembleSqliteErColumnsAndForeignKeys(params: {
  schema: string
  tables: readonly RawErTableRow[]
  tableSqlByName: ReadonlyMap<string, string>
  rawColRows: readonly Record<string, unknown>[]
  rawFkRows: readonly Record<string, unknown>[]
}): { columns: RawErColumnRow[]; foreignKeys: RawErForeignKeyRow[] } {
  const { schema, tables, tableSqlByName, rawColRows, rawFkRows } = params
  const tableNames = tables.map((t) => t.name)

  const parsedCols: Array<{
    tableName: string
    colName: string
    colType: string
    notnull: number
    pkOrder: number
  }> = []
  const pkByTable = new Map<string, Array<{ name: string; pkOrder: number }>>()
  const colNamesByTable = new Map<string, string[]>()

  for (const c of rawColRows) {
    if (Number(c.col_hidden ?? 0) === 1) continue
    const tableName = typeof c.table_name === 'string' ? c.table_name : String(c.table_name ?? '')
    const colName = typeof c.col_name === 'string' ? c.col_name : String(c.col_name ?? '')
    if (!tableName || colName.length === 0) continue
    const pkOrder = Number(c.col_pk ?? 0)
    const notnull = Number(c.col_notnull ?? 0)
    const colType = typeof c.col_type === 'string' && c.col_type.length > 0 ? c.col_type : 'TEXT'

    parsedCols.push({ tableName, colName, colType, notnull, pkOrder })
    const nameList = colNamesByTable.get(tableName) ?? []
    nameList.push(colName)
    colNamesByTable.set(tableName, nameList)

    if (pkOrder > 0) {
      const pkList = pkByTable.get(tableName) ?? []
      pkList.push({ name: colName, pkOrder })
      pkByTable.set(tableName, pkList)
    }
  }

  const orderedPkByTable = new Map<string, string[]>()
  for (const [tbl, list] of pkByTable.entries()) {
    list.sort((a, b) => a.pkOrder - b.pkOrder)
    orderedPkByTable.set(tbl, list.map((x) => x.name))
  }

  const tableFlagsCache = new Map<string, SqliteErTableFlags>()
  const getFlags = (tableName: string): SqliteErTableFlags => {
    let cached = tableFlagsCache.get(tableName)
    if (!cached) {
      cached = parseSqliteErTableFlags(tableSqlByName.get(tableName) ?? '')
      tableFlagsCache.set(tableName, cached)
    }
    return cached
  }

  const columns: RawErColumnRow[] = parsedCols.map((c) => {
    const isPk = c.pkOrder > 0
    let nullable: boolean
    if (c.notnull > 0) {
      nullable = false
    } else if (!isPk) {
      nullable = true
    } else {
      const pkCount = orderedPkByTable.get(c.tableName)?.length ?? 0
      const flags = getFlags(c.tableName)
      const declaredUpper = c.colType.trim().toUpperCase()
      const isRowidAlias =
        !flags.withoutRowid && !flags.hasInlinePkDesc && pkCount === 1 && declaredUpper === 'INTEGER'
      nullable = !(flags.withoutRowid || flags.strict || isRowidAlias)
    }
    return {
      schema,
      table: c.tableName,
      name: c.colName,
      type: c.colType,
      nullable,
      isPrimaryKey: isPk,
    }
  })

  const foreignKeys: RawErForeignKeyRow[] = []
  for (const fk of rawFkRows) {
    const rawFromTable =
      typeof fk.table_name === 'string' ? fk.table_name : String(fk.table_name ?? '')
    const rawToTable = typeof fk.to_table === 'string' ? fk.to_table : String(fk.to_table ?? '')
    const rawFromCol =
      typeof fk.from_col === 'string'
        ? fk.from_col
        : fk.from_col !== null && fk.from_col !== undefined
          ? String(fk.from_col)
          : ''
    if (!rawFromTable || !rawToTable || rawFromCol.length === 0) continue

    const fromTable = resolveIdentifierMatch(tableNames, rawFromTable) ?? rawFromTable
    const toTable = resolveIdentifierMatch(tableNames, rawToTable) ?? rawToTable
    const fromColNames = colNamesByTable.get(fromTable)
    const fromCol = fromColNames
      ? (resolveIdentifierMatch(fromColNames, rawFromCol) ?? rawFromCol)
      : rawFromCol

    const seq = Number(fk.seq ?? 0)
    const rawToCol =
      typeof fk.to_col === 'string'
        ? fk.to_col
        : fk.to_col !== null && fk.to_col !== undefined
          ? String(fk.to_col)
          : ''
    let toCol = ''
    if (rawToCol.length > 0) {
      const toColNames = colNamesByTable.get(toTable)
      toCol = toColNames ? (resolveIdentifierMatch(toColNames, rawToCol) ?? rawToCol) : rawToCol
    } else {
      const targetPks = orderedPkByTable.get(toTable) ?? []
      toCol = (Number.isInteger(seq) && seq >= 0 ? targetPks[seq] : undefined) ?? targetPks[0] ?? ''
    }
    if (toCol.length === 0) continue

    const fkId = Number(fk.fk_id ?? 0)
    const onDelete =
      typeof fk.on_delete === 'string' && fk.on_delete.trim()
        ? fk.on_delete.trim().toUpperCase()
        : undefined
    const onUpdate =
      typeof fk.on_update === 'string' && fk.on_update.trim()
        ? fk.on_update.trim().toUpperCase()
        : undefined
    foreignKeys.push({
      constraintName: `fk_${fromTable}_${fkId}_${toTable}`,
      fromSchema: schema,
      fromTable,
      fromColumn: fromCol,
      toSchema: schema,
      toTable,
      toColumn: toCol,
      ordinalPosition: Number.isFinite(seq) ? seq : 0,
      ...(onDelete ? { onDelete } : {}),
      ...(onUpdate ? { onUpdate } : {}),
    })
  }

  return { columns, foreignKeys }
}
