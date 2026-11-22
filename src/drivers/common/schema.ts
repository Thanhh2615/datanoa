import type {
  DatabaseDriverType,
  SchemaObject,
  SchemaObjectKind,
  TableDetails,
  ColumnInfo,
  IndexInfo,
  ForeignKeyInfo,
} from '../../protocol'
import {
  isIdentContChar,
  isIdentStartChar,
  isPostgresEscapeStringStart,
  matchDollarQuoteTag,
  quoteIdentForDialect,
  rewriteCockroachViewBodyDatabaseQualifier,
  scanBlockCommentEnd,
  scanLineCommentEnd,
  scanQuotedSegmentEnd,
  usesBackslashAndHash,
} from './sql-lexer.js'

export type QueryExecutor = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>

export const DEFAULT_METADATA_CACHE_TTL_MS = 15_000

/**
 * Short-lived TTL cache for TableDetails metadata to skip redundant
 * multi-PRAGMA and catalog round-trips during pagination, sorting, and filtering.
 */
export class TableDetailsCache {
  private readonly ttlMs: number
  private readonly entries = new Map<string, { details: TableDetails; expiresAt: number }>()

  constructor(ttlMs = DEFAULT_METADATA_CACHE_TTL_MS) {
    this.ttlMs = ttlMs
  }

  private makeKey(schema: string | undefined, defaultSchema: string, table: string): string {
    const resolvedSchema = schema && schema.trim().length > 0 ? schema.trim() : defaultSchema
    return `${resolvedSchema}:${table}`
  }

  get(schema: string | undefined, defaultSchema: string, table: string): TableDetails | undefined {
    const key = this.makeKey(schema, defaultSchema, table)
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (Date.now() >= entry.expiresAt) {
      this.entries.delete(key)
      return undefined
    }
    return { ...entry.details }
  }

  set(
    schema: string | undefined,
    defaultSchema: string,
    table: string,
    details: TableDetails
  ): void {
    const key = this.makeKey(schema, defaultSchema, table)
    this.entries.set(key, {
      details: { ...details },
      expiresAt: Date.now() + this.ttlMs,
    })
  }

  clear(): void {
    this.entries.clear()
  }

  resolveColumnTypes(
    schema: string | undefined,
    defaultSchema: string,
    table: string,
    explicit?: Record<string, string>
  ): Record<string, string> | undefined {
    const cached = this.get(schema, defaultSchema, table)
    if (!cached && !explicit) return undefined
    const merged: Record<string, string> = {}
    if (cached) {
      for (const col of cached.columns) {
        const t = col.nativeType || col.type
        if (t) merged[col.name] = t
      }
    }
    if (explicit) {
      Object.assign(merged, explicit)
    }
    return merged
  }

  findColumnType(
    schema: string | undefined,
    defaultSchema: string,
    table: string,
    column: string,
    explicit?: string
  ): string | undefined {
    if (explicit) return explicit
    const cached = this.get(schema, defaultSchema, table)
    const col = cached?.columns.find((c) => c.name === column)
    return col?.nativeType || col?.type
  }
}

/**
 * Safely coerces SQL driver boolean/bit/numeric flag values (`boolean`, `0|1`, `'0'|'1'`, `'true'|'false'`, `Uint8Array`)
 * without treating `'0'` or `Uint8Array([0])` as truthy.
 */
const SCHEMA_OBJECT_KINDS: readonly SchemaObjectKind[] = [
  'table',
  'view',
  'materialized_view',
  'function',
  'procedure',
  'trigger',
  'sequence',
  'type',
]

function toSchemaObjectKind(value: unknown): SchemaObjectKind {
  return typeof value === 'string' && (SCHEMA_OBJECT_KINDS as readonly string[]).includes(value)
    ? (value as SchemaObjectKind)
    : 'table'
}

export interface SchemaDependencyEndpoint {
  kind: SchemaObjectKind
  name: string
}

export interface SchemaDependencyEdge {
  consumer: SchemaDependencyEndpoint
  prerequisite: SchemaDependencyEndpoint
}

function schemaDependencyKey(kind: SchemaObjectKind, name: string): string {
  return `${kind}\u0000${name}`
}

function toSchemaDependencyEndpoint(
  kindValue: unknown,
  nameValue: unknown
): SchemaDependencyEndpoint | null {
  if (typeof kindValue !== 'string' || typeof nameValue !== 'string' || nameValue.length === 0) {
    return null
  }
  if (!(SCHEMA_OBJECT_KINDS as readonly string[]).includes(kindValue)) return null
  return { kind: kindValue as SchemaObjectKind, name: nameValue }
}

function pushSchemaObject(
  row: Record<string, unknown>,
  sink: SchemaObject[],
  seen: Set<string>,
  fallbackSchema: string
): void {
  const name = typeof row.name === 'string' ? row.name : ''
  if (!name) return
  const kind = toSchemaObjectKind(row.kind)
  const schema =
    typeof row.schema === 'string' && row.schema.length > 0 ? row.schema : fallbackSchema
  const detail =
    typeof row.detail === 'string' && row.detail.length > 0 ? row.detail : undefined
  const key = `${kind}:${schema}:${name}${kind === 'trigger' && detail ? `:${detail}` : ''}`
  if (seen.has(key)) return
  seen.add(key)
  sink.push({ name, schema, kind, ...(detail ? { detail } : {}) })
}

async function collectSchemaObjects(
  query: QueryExecutor,
  sql: string,
  params: unknown[],
  pushRow: (row: Record<string, unknown>) => void
): Promise<void> {
  try {
    const rows = await query(sql, params)
    for (const row of rows) pushRow(row)
  } catch {
    // Restricted permissions, missing catalog support, or older/limited server versions
  }
}

function normalizeDdlSuffix(ddl: string): string {
  const trimmed = ddl.trim()
  return trimmed.endsWith(';') ? trimmed : `${trimmed};`
}

/** Sanitizes a schema/database label into a safe `.sql` export file basename. */
export function sanitizeSchemaFileName(label: string): string {
  const baseName = label.split(/[/\\]/).pop() || ''
  return (
    baseName
      .replace(/[^A-Za-z0-9_-]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '') || 'schema'
  )
}

export function toSqlBool(val: unknown): boolean {
  return (
    val === true ||
    val === 1 ||
    val === 1n ||
    val === '1' ||
    (typeof val === 'string' && val.toLowerCase() === 'true') ||
    (typeof Uint8Array !== 'undefined' && val instanceof Uint8Array && val[0] === 1)
  )
}

// ============================================================================
// 1. SQLite Schema Introspection & Query Templates
// ============================================================================

function sqliteSchemaPrefix(schema?: string): string {
  const trimmed = (schema || 'main').trim()
  if (!trimmed || trimmed.toLowerCase() === 'main') return ''
  return `"${trimmed.replace(/"/g, '""')}".`
}

export const SQLITE_SCHEMA_QUERIES = {
  listObjects: `
    SELECT name, type AS kind, tbl_name
    FROM sqlite_master
    WHERE type IN ('table', 'view', 'trigger') AND name NOT LIKE 'sqlite_%'
    ORDER BY name ASC;
  `,
  listObjectsForSchema: (schema = 'main') => `
    SELECT name, type AS kind, tbl_name
    FROM ${sqliteSchemaPrefix(schema)}sqlite_master
    WHERE type IN ('table', 'view', 'trigger') AND name NOT LIKE 'sqlite_%'
    ORDER BY name ASC;
  `,
  tableInfo: (table: string, schema = 'main') =>
    `PRAGMA ${sqliteSchemaPrefix(schema)}table_xinfo("${table.replace(/"/g, '""')}");`,
  tableXInfo: (table: string, schema = 'main') =>
    `PRAGMA ${sqliteSchemaPrefix(schema)}table_xinfo("${table.replace(/"/g, '""')}");`,
  foreignKeyList: (table: string, schema = 'main') =>
    `PRAGMA ${sqliteSchemaPrefix(schema)}foreign_key_list("${table.replace(/"/g, '""')}");`,
  indexList: (table: string, schema = 'main') =>
    `PRAGMA ${sqliteSchemaPrefix(schema)}index_list("${table.replace(/"/g, '""')}");`,
  indexInfo: (index: string, schema = 'main') =>
    `PRAGMA ${sqliteSchemaPrefix(schema)}index_info("${index.replace(/"/g, '""')}");`,
}

export async function introspectSqliteObjects(
  query: QueryExecutor,
  schema: string = 'main'
): Promise<SchemaObject[]> {
  const targetSchema = (schema || 'main').trim() || 'main'
  const rows = await query(SQLITE_SCHEMA_QUERIES.listObjectsForSchema(targetSchema))
  return rows.map((r) => {
    const kind = toSchemaObjectKind(r.kind)
    const detail =
      kind === 'trigger' && typeof r.tbl_name === 'string' && r.tbl_name.length > 0
        ? r.tbl_name
        : undefined
    return {
      name: String(r.name),
      schema: targetSchema,
      kind,
      ...(detail ? { detail } : {}),
    }
  })
}

export async function introspectSqliteSchemas(
  query: QueryExecutor
): Promise<{ schemas: string[]; defaultSchema: string }> {
  const rows = await query('PRAGMA database_list;')
  const names = rows.map((r) => String(r.name ?? '')).filter((name) => name.length > 0)
  const ordered = names.includes('main')
    ? ['main', ...names.filter((name) => name !== 'main')]
    : names
  return {
    schemas: ordered.length > 0 ? ordered : ['main'],
    defaultSchema: ordered[0] || 'main',
  }
}

export async function introspectSqliteObjectDdl(
  query: QueryExecutor,
  name: string,
  kind: SchemaObjectKind,
  schema: string = 'main'
): Promise<string> {
  const targetSchema = (schema || 'main').trim() || 'main'
  const masterType = kind === 'trigger' ? 'trigger' : kind === 'view' ? 'view' : 'table'
  const rows = await query(
    `SELECT sql FROM ${sqliteSchemaPrefix(targetSchema)}sqlite_master WHERE type = ? AND name = ?;`,
    [masterType, name]
  )
  const sql = rows[0]?.sql
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    throw new Error(`DDL not found for ${masterType} "${name}" in schema "${targetSchema}".`)
  }
  return normalizeDdlSuffix(sql)
}

export async function introspectSqliteTableDetails(
  query: QueryExecutor,
  table: string,
  schema: string = 'main'
): Promise<TableDetails> {
  const targetSchema = (schema || 'main').trim() || 'main'
  const prefix = sqliteSchemaPrefix(targetSchema)

  // 1. Get Kind & Table DDL (filtered strictly to table/view so index/trigger names cannot collide)
  const masterRows = await query(
    `SELECT type, sql FROM ${prefix}sqlite_master WHERE type IN ('table', 'view') AND name = ?;`,
    [table]
  )
  const master = masterRows[0] || {}
  const kind: 'table' | 'view' = master.type === 'view' ? 'view' : 'table'
  const tableSql = typeof master.sql === 'string' ? master.sql : ''
  const hasAutoIncrementDdl = /\bAUTOINCREMENT\b/i.test(tableSql)
  const isWithoutRowid = /\bWITHOUT\s+ROWID\b/i.test(tableSql)

  // 2. Columns & Primary Keys via PRAGMA table_xinfo (includes generated virtual/stored columns)
  const rawColRows = await query(SQLITE_SCHEMA_QUERIES.tableXInfo(table, targetSchema))
  const colRows = rawColRows.filter((c) => Number(c.hidden ?? 0) !== 1)
  const pkEntries = colRows
    .filter((c) => Number(c.pk) > 0)
    .sort((a, b) => Number(a.pk) - Number(b.pk))
  const primaryKey = pkEntries.map((c) => String(c.name))

  const columns: ColumnInfo[] = colRows.map((c) => {
    const isPk = Number(c.pk) > 0
    const hiddenVal = Number(c.hidden ?? 0)
    const isGenerated = hiddenVal === 2 || hiddenVal === 3
    const declaredType = String(c.type || 'TEXT')
      .trim()
      .toUpperCase()
    const isStrictInteger = declaredType === 'INTEGER'
    const isAutoIncrement =
      !isWithoutRowid &&
      !isGenerated &&
      isPk &&
      isStrictInteger &&
      (hasAutoIncrementDdl || primaryKey.length === 1)

    return {
      name: String(c.name),
      type: String(c.type || 'TEXT'),
      nativeType: String(c.type || 'TEXT'),
      nullable: isPk ? false : Number(c.notnull) === 0,
      defaultValue: c.dflt_value !== null && c.dflt_value !== undefined ? String(c.dflt_value) : null,
      isPrimaryKey: isPk,
      isAutoIncrement,
      ...(isGenerated ? { isGenerated: true } : {}),
    }
  })

  // 3. Foreign Keys via PRAGMA foreign_key_list (resolve omitted fk.to via parent table PK)
  const fkRows = await query(SQLITE_SCHEMA_QUERIES.foreignKeyList(table, targetSchema))
  const parentPkCache = new Map<string, string[]>()
  const resolveParentPrimaryKeys = async (refTable: string): Promise<string[]> => {
    const cached = parentPkCache.get(refTable)
    if (cached) return cached
    try {
      const refCols = await query(SQLITE_SCHEMA_QUERIES.tableXInfo(refTable, targetSchema))
      const pks = refCols
        .filter((c) => Number(c.pk) > 0)
        .sort((a, b) => Number(a.pk) - Number(b.pk))
        .map((c) => String(c.name))
      parentPkCache.set(refTable, pks)
      return pks
    } catch {
      parentPkCache.set(refTable, [])
      return []
    }
  }

  const fkIdCounts = new Map<number, number>()
  for (const fk of fkRows) {
    const fkId = Number(fk.id ?? 0)
    fkIdCounts.set(fkId, (fkIdCounts.get(fkId) ?? 0) + 1)
  }

  const foreignKeys: ForeignKeyInfo[] = []
  for (const fk of fkRows) {
    const refTable = String(fk.table)
    const fkId = Number(fk.id ?? 0)
    let referencedColumn =
      fk.to !== null && fk.to !== undefined && String(fk.to).trim().length > 0
        ? String(fk.to)
        : ''
    if (!referencedColumn) {
      const parentPks = await resolveParentPrimaryKeys(refTable)
      const seqIdx = Number(fk.seq ?? 0)
      referencedColumn =
        (Number.isInteger(seqIdx) && seqIdx >= 0 ? parentPks[seqIdx] : undefined) ??
        parentPks[0] ??
        ''
    }
    const isComposite = (fkIdCounts.get(fkId) ?? 0) > 1
    const onDelete =
      fk.on_delete !== null && fk.on_delete !== undefined && String(fk.on_delete).trim().length > 0
        ? String(fk.on_delete).trim().toUpperCase()
        : undefined
    const onUpdate =
      fk.on_update !== null && fk.on_update !== undefined && String(fk.on_update).trim().length > 0
        ? String(fk.on_update).trim().toUpperCase()
        : undefined
    foreignKeys.push({
      constraintName: isComposite
        ? `fk_${table}_${fkId}_${refTable}`
        : `fk_${table}_${String(fk.from)}_${refTable}`,
      column: String(fk.from),
      referencedTable: refTable,
      referencedColumn,
      ...(onDelete ? { onDelete } : {}),
      ...(onUpdate ? { onUpdate } : {}),
    })
  }

  // 4. Indexes via PRAGMA index_list & PRAGMA index_info (filter null expression-index entries)
  const idxRows = await query(SQLITE_SCHEMA_QUERIES.indexList(table, targetSchema))
  const indexes: IndexInfo[] = []

  for (const idx of idxRows) {
    const infoRows = await query(SQLITE_SCHEMA_QUERIES.indexInfo(String(idx.name), targetSchema))
    const colNames = infoRows
      .sort((a, b) => Number(a.seqno) - Number(b.seqno))
      .filter((r) => r.name !== null && r.name !== undefined && String(r.name).trim().length > 0)
      .map((r) => String(r.name))

    indexes.push({
      name: String(idx.name),
      isUnique: Number(idx.unique) === 1,
      isPrimary: String(idx.origin) === 'pk',
      columns: colNames,
    })
  }

  return {
    name: table,
    schema: targetSchema,
    kind,
    columns,
    primaryKey,
    indexes,
    foreignKeys,
  }
}

// ============================================================================
// 2. PostgreSQL Schema Introspection & Query Templates
// ============================================================================

export const POSTGRES_SCHEMA_QUERIES = {
  listObjects: (schema = 'public') => `
    SELECT table_name AS name, 
           CASE WHEN table_type = 'VIEW' THEN 'view' ELSE 'table' END AS kind,
           table_schema AS schema
    FROM information_schema.tables
    WHERE table_schema = '${schema.replace(/'/g, "''")}'
      AND table_type IN ('BASE TABLE', 'VIEW')
    ORDER BY table_name ASC;
  `,
  columns: (table: string, schema = 'public') => `
    SELECT 
      column_name AS name,
      data_type AS type,
      udt_name AS native_type,
      is_nullable = 'YES' AS nullable,
      column_default AS default_value,
      (is_identity = 'YES' OR column_default LIKE 'nextval(%' OR column_default LIKE '%unique_rowid(%') AS is_auto_increment
    FROM information_schema.columns
    WHERE table_schema = '${schema.replace(/'/g, "''")}' AND table_name = '${table.replace(/'/g, "''")}'
    ORDER BY ordinal_position ASC;
  `,
  primaryKeys: (table: string, schema = 'public') => `
    SELECT kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    WHERE tc.constraint_type = 'PRIMARY KEY'
      AND tc.table_schema = '${schema.replace(/'/g, "''")}'
      AND tc.table_name = '${table.replace(/'/g, "''")}'
    ORDER BY kcu.ordinal_position ASC;
  `,
  foreignKeys: (table: string, schema = 'public') => `
    SELECT
      tc.constraint_name,
      kcu.column_name,
      ccu.table_name AS referenced_table,
      ccu.column_name AS referenced_column
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = '${schema.replace(/'/g, "''")}'
      AND tc.table_name = '${table.replace(/'/g, "''")}';
  `,
  indexes: (table: string, schema = 'public') => `
    SELECT
      indexname AS name,
      indexdef
    FROM pg_indexes
    WHERE schemaname = '${schema.replace(/'/g, "''")}' AND tablename = '${table.replace(/'/g, "''")}';
  `,
}

export async function introspectPostgresObjects(
  query: QueryExecutor,
  schema: string = 'public'
): Promise<SchemaObject[]> {
  const targetSchema = (schema || 'public').trim() || 'public'
  const objects: SchemaObject[] = []
  const seen = new Set<string>()
  const pushRow = (row: Record<string, unknown>) =>
    pushSchemaObject(row, objects, seen, targetSchema)

  const baseRows = await query(
    `
    SELECT 
      table_name AS name,
      table_schema AS schema,
      CASE 
        WHEN table_type = 'VIEW' THEN 'view'
        ELSE 'table'
      END AS kind
    FROM information_schema.tables
    WHERE table_schema = $1
      AND table_type IN ('BASE TABLE', 'VIEW')
    ORDER BY table_name ASC;
  `,
    [targetSchema]
  )
  baseRows.forEach(pushRow)

  const extras = [
    `SELECT matviewname AS name, schemaname AS schema, 'materialized_view' AS kind
       FROM pg_matviews WHERE schemaname = $1 ORDER BY matviewname ASC;`,
    `SELECT DISTINCT t.trigger_name AS name, t.trigger_schema AS schema, 'trigger' AS kind, t.event_object_table AS detail
       FROM information_schema.triggers t WHERE t.trigger_schema = $1
       ORDER BY t.trigger_name ASC, t.event_object_table ASC;`,
    `SELECT t.typname AS name, n.nspname AS schema, 'type' AS kind
       FROM pg_catalog.pg_type t
       JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = $1 AND t.typtype IN ('e', 'd')
       ORDER BY t.typname ASC;`,
  ]
  for (const sql of extras) {
    await collectSchemaObjects(query, sql, [targetSchema], pushRow)
  }

  let loadedSequences = false
  try {
    const seqRows = await query(
      `SELECT c.relname AS name, n.nspname AS schema, 'sequence' AS kind
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1
          AND c.relkind = 'S'
          AND NOT EXISTS (
            SELECT 1
              FROM pg_catalog.pg_depend d
             WHERE d.classid = 'pg_catalog.pg_class'::regclass
               AND d.objid = c.oid
               AND d.deptype = 'i'
          )
        ORDER BY c.relname ASC;`,
      [targetSchema]
    )
    seqRows.forEach(pushRow)
    loadedSequences = true
  } catch {
    loadedSequences = false
  }
  if (!loadedSequences) {
    await collectSchemaObjects(
      query,
      `SELECT sequence_name AS name, sequence_schema AS schema, 'sequence' AS kind
         FROM information_schema.sequences WHERE sequence_schema = $1 ORDER BY sequence_name ASC;`,
      [targetSchema],
      pushRow
    )
  }

  // Functions & procedures (CockroachDB builds without pg_proc.prokind fall back to proisagg)
  try {
    const rows = await query(
      `SELECT p.proname AS name, n.nspname AS schema,
              CASE WHEN p.prokind = 'p' THEN 'procedure' ELSE 'function' END AS kind
         FROM pg_catalog.pg_proc p
         JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = $1 AND p.prokind IN ('f', 'p')
         ORDER BY p.proname ASC;`,
      [targetSchema]
    )
    rows.forEach(pushRow)
  } catch {
    await collectSchemaObjects(
      query,
      `SELECT p.proname AS name, n.nspname AS schema, 'function' AS kind
         FROM pg_catalog.pg_proc p
         JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = $1 AND NOT p.proisagg AND NOT p.proiswindow
         ORDER BY p.proname ASC;`,
      [targetSchema],
      pushRow
    )
  }

  return objects.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Reads cross-kind dependency edges for one schema from pg_depend. Read-only and
 * limited to objects that exist in the requested schema; edges with unknown or
 * out-of-schema endpoints are dropped by the caller during assembly.
 */
export async function introspectPostgresSchemaDependencies(
  query: QueryExecutor,
  schema: string = 'public'
): Promise<SchemaDependencyEdge[]> {
  const targetSchema = (schema || 'public').trim() || 'public'
  const rows = await query(
    `
    WITH objects AS (
      SELECT 'pg_catalog.pg_class'::regclass::oid AS class_id, c.oid AS object_id,
             CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized_view'
               WHEN 'S' THEN 'sequence' ELSE 'table' END AS kind,
             c.relname::text AS name
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relkind IN ('v','m','r','p','S')
      UNION ALL
      SELECT 'pg_catalog.pg_proc'::regclass::oid, p.oid,
             CASE WHEN p.prokind = 'p' THEN 'procedure' ELSE 'function' END,
             p.proname::text
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = $1 AND p.prokind IN ('f','p')
    )
    SELECT DISTINCT consumer.kind AS consumer_kind, consumer.name AS consumer_name,
           prerequisite.kind AS prerequisite_kind, prerequisite.name AS prerequisite_name
      FROM pg_catalog.pg_depend d
      LEFT JOIN pg_catalog.pg_rewrite r
        ON d.classid = 'pg_catalog.pg_rewrite'::regclass AND r.oid = d.objid
      JOIN objects consumer
        ON consumer.class_id = CASE WHEN r.oid IS NULL THEN d.classid
                                    ELSE 'pg_catalog.pg_class'::regclass::oid END
       AND consumer.object_id = COALESCE(r.ev_class, d.objid)
      JOIN objects prerequisite
        ON d.refclassid = prerequisite.class_id AND d.refobjid = prerequisite.object_id
     WHERE d.deptype = 'n'
       AND (consumer.kind, consumer.name) <> (prerequisite.kind, prerequisite.name)
     ORDER BY consumer.kind, consumer.name, prerequisite.kind, prerequisite.name;
  `,
    [targetSchema]
  )

  const edges: SchemaDependencyEdge[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const consumer = toSchemaDependencyEndpoint(row.consumer_kind, row.consumer_name)
    const prerequisite = toSchemaDependencyEndpoint(row.prerequisite_kind, row.prerequisite_name)
    if (!consumer || !prerequisite) continue
    if (consumer.kind === prerequisite.kind && consumer.name === prerequisite.name) continue
    const key = `${schemaDependencyKey(consumer.kind, consumer.name)}\u0001${schemaDependencyKey(
      prerequisite.kind,
      prerequisite.name
    )}`
    if (seen.has(key)) continue
    seen.add(key)
    edges.push({ consumer, prerequisite })
  }
  return edges
}

export async function introspectPostgresSchemas(
  query: QueryExecutor
): Promise<{ schemas: string[]; defaultSchema: string }> {
  const rows = await query(`
    SELECT schema_name AS name
    FROM information_schema.schemata
    WHERE schema_name NOT IN ('pg_catalog', 'information_schema')
      AND schema_name NOT LIKE 'pg_toast%'
      AND schema_name NOT LIKE 'pg_temp%'
    ORDER BY CASE WHEN schema_name = 'public' THEN 0 ELSE 1 END, schema_name ASC;
  `)
  const systemSchemas = new Set(['pg_catalog', 'information_schema'])
  const names = rows
    .map((r) => String(r.name ?? ''))
    .filter(
      (name) =>
        name.length > 0 &&
        !systemSchemas.has(name) &&
        !name.startsWith('pg_toast') &&
        !name.startsWith('pg_temp')
    )
  return {
    schemas: names,
    defaultSchema: names.includes('public') ? 'public' : names[0] || 'public',
  }
}

export async function introspectPostgresObjectDdl(
  query: QueryExecutor,
  name: string,
  kind: SchemaObjectKind,
  schema: string = 'public',
  options?: { sourceDatabase?: string }
): Promise<string> {
  const targetSchema = (schema || 'public').trim() || 'public'
  const qualified = `${quoteIdentForDialect(targetSchema, 'postgres')}.${quoteIdentForDialect(name, 'postgres')}`

  if (kind === 'view' || kind === 'materialized_view') {
    const relkinds = kind === 'view' ? "('v')" : "('m')"
    const rows = await query(
      `SELECT pg_get_viewdef(c.oid, true) AS ddl
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ${relkinds}
         ORDER BY c.oid ASC;`,
      [targetSchema, name]
    )
    const row = rows[0]
    const rawBody = row && typeof row.ddl === 'string' ? row.ddl.trim() : ''
    if (!rawBody) {
      throw new Error(`View definition not found for ${qualified}.`)
    }
    const body =
      options?.sourceDatabase !== undefined
        ? rewriteCockroachViewBodyDatabaseQualifier(rawBody, options.sourceDatabase)
        : rawBody
    const header =
      kind === 'view'
        ? `CREATE VIEW ${qualified} AS`
        : `CREATE MATERIALIZED VIEW ${qualified} AS`
    return normalizeDdlSuffix(`${header}\n${body}`)
  }

  if (kind === 'function' || kind === 'procedure') {
    const prokind = kind === 'function' ? 'f' : 'p'
    const rows = await query(
      `SELECT pg_get_functiondef(p.oid) AS ddl
         FROM pg_catalog.pg_proc p
         JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = $1 AND p.proname = $2 AND p.prokind = $3
         ORDER BY p.oid ASC;`,
      [targetSchema, name, prokind]
    )
    const ddl = rows
      .map((row) => (typeof row.ddl === 'string' ? row.ddl.trim() : ''))
      .filter((value) => value.length > 0)
      .map((value) => normalizeDdlSuffix(value))
      .join('\n\n')
    if (!ddl) {
      throw new Error(`Function definition not found for ${qualified}.`)
    }
    return ddl
  }

  if (kind === 'trigger') {
    const rows = await query(
      `SELECT pg_get_triggerdef(t.oid) AS ddl
         FROM pg_catalog.pg_trigger t
         JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND t.tgname = $2 AND NOT t.tgisinternal
         ORDER BY t.oid ASC;`,
      [targetSchema, name]
    )
    const ddl = rows
      .map((row) => (typeof row.ddl === 'string' ? row.ddl.trim() : ''))
      .filter((value) => value.length > 0)
      .map((value) => normalizeDdlSuffix(value))
      .join('\n\n')
    if (!ddl) {
      throw new Error(`Trigger definition not found for ${qualified}.`)
    }
    return ddl
  }

  if (kind === 'type') {
    const enumRows = await query(
      `SELECT e.enumlabel AS label
         FROM pg_catalog.pg_type t
         JOIN pg_catalog.pg_enum e ON e.enumtypid = t.oid
         JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
         WHERE n.nspname = $1 AND t.typname = $2
         ORDER BY e.enumsortorder ASC;`,
      [targetSchema, name]
    )
    if (enumRows.length > 0) {
      const labels = enumRows.map((r) => `'${String(r.label ?? '').replace(/'/g, "''")}'`)
      return `CREATE TYPE ${qualified} AS ENUM (\n  ${labels.join(',\n  ')}\n);`
    }
    const domainRows = await query(
      `SELECT data_type AS data_type, character_maximum_length AS max_length,
              numeric_precision AS precision, numeric_scale AS scale
         FROM information_schema.domains
         WHERE domain_schema = $1 AND domain_name = $2 LIMIT 1;`,
      [targetSchema, name]
    )
    const domain = domainRows[0]
    if (domain && typeof domain.data_type === 'string') {
      let domainType = domain.data_type
      const maxLength = domain.max_length
      if (maxLength !== null && maxLength !== undefined && String(maxLength).length > 0) {
        domainType = `${domainType}(${String(maxLength)})`
      } else if (domain.precision !== null && domain.precision !== undefined) {
        const precision = String(domain.precision)
        const scale = domain.scale !== null && domain.scale !== undefined ? String(domain.scale) : '0'
        domainType = `${domainType}(${precision},${scale})`
      }
      return normalizeDdlSuffix(`CREATE DOMAIN ${qualified} AS ${domainType}`)
    }
    throw new Error(`Type definition not found for ${qualified}.`)
  }

  if (kind === 'sequence') {
    const rows = await query(
      `SELECT sequencename AS name, data_type AS data_type, start_value AS start_value,
              increment_by AS increment_by, min_value AS min_value, max_value AS max_value,
              cycle AS cycle
         FROM pg_catalog.pg_sequences
         WHERE schemaname = $1 AND sequencename = $2 LIMIT 1;`,
      [targetSchema, name]
    )
    const seq = rows[0]
    if (!seq) {
      throw new Error(`Sequence definition not found for ${qualified}.`)
    }
    const parts = [`CREATE SEQUENCE ${qualified}`]
    if (typeof seq.data_type === 'string' && seq.data_type.length > 0) {
      parts.push(`AS ${seq.data_type}`)
    }
    if (seq.start_value !== null && seq.start_value !== undefined) {
      parts.push(`START WITH ${String(seq.start_value)}`)
    }
    if (seq.increment_by !== null && seq.increment_by !== undefined) {
      parts.push(`INCREMENT BY ${String(seq.increment_by)}`)
    }
    if (seq.min_value !== null && seq.min_value !== undefined) {
      parts.push(`MINVALUE ${String(seq.min_value)}`)
    }
    if (seq.max_value !== null && seq.max_value !== undefined) {
      parts.push(`MAXVALUE ${String(seq.max_value)}`)
    }
    if (toSqlBool(seq.cycle)) {
      parts.push('CYCLE')
    }
    return normalizeDdlSuffix(parts.join(' '))
  }

  throw new Error(`Unsupported PostgreSQL object kind: ${kind}.`)
}

export async function introspectPostgresTableDetails(
  query: QueryExecutor,
  table: string,
  schema: string = 'public'
): Promise<TableDetails> {
  const targetSchema = (schema || 'public').trim() || 'public'
  // 1. Object Kind
  const kindSql = `
    SELECT 
      CASE 
        WHEN table_type = 'VIEW' THEN 'view'
        ELSE 'table'
      END AS kind
    FROM information_schema.tables
    WHERE table_schema = $1 AND table_name = $2;
  `
  const kindRows = await query(kindSql, [targetSchema, table])
  let kind: 'table' | 'view' = kindRows[0]?.kind === 'view' ? 'view' : 'table'
  let isMaterializedView = false
  if (kindRows.length === 0) {
    const matviewRows = await query(
      `SELECT c.relkind AS relkind
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'm'
         LIMIT 1;`,
      [targetSchema, table]
    )
    if (matviewRows.length > 0) {
      // Materialized views are read-only for the structure designer
      kind = 'view'
      isMaterializedView = true
    }
  }

  // 2. Primary Keys via information_schema
  const pkSql = `
    SELECT kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
      AND tc.table_name = kcu.table_name
    WHERE tc.constraint_type = 'PRIMARY KEY'
      AND tc.table_schema = $1
      AND tc.table_name = $2
    ORDER BY kcu.ordinal_position ASC;
  `
  const pkRows = await query(pkSql, [targetSchema, table])
  const primaryKey = pkRows.map((r) => String(r.column_name))

  // 3. Columns via information_schema.columns
  const colSql = `
    SELECT 
      c.column_name AS name,
      CASE 
        WHEN c.character_maximum_length IS NOT NULL 
          THEN c.data_type || '(' || c.character_maximum_length || ')'
        WHEN c.numeric_precision IS NOT NULL AND c.data_type = 'numeric'
          THEN c.data_type || '(' || c.numeric_precision || ',' || coalesce(c.numeric_scale, 0) || ')'
        ELSE c.data_type
      END AS type,
      c.udt_name AS native_type,
      (c.is_nullable = 'YES') AS nullable,
      c.column_default AS default_value,
      (
        c.is_identity = 'YES' 
        OR (
          c.column_default IS NOT NULL
          AND (c.column_default LIKE 'nextval(%' OR c.column_default LIKE '%unique_rowid(%')
        )
      ) AS is_auto_increment
    FROM information_schema.columns c
    WHERE c.table_schema = $1 AND c.table_name = $2
    ORDER BY c.ordinal_position ASC;
  `
  const colRows = isMaterializedView
    ? await query(
        `SELECT a.attname AS name,
                format_type(a.atttypid, a.atttypmod) AS type,
                t.typname AS native_type,
                NOT a.attnotnull AS nullable,
                pg_get_expr(d.adbin, d.adrelid) AS default_value,
                false AS is_auto_increment
           FROM pg_catalog.pg_attribute a
           JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
           LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
           JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
           ORDER BY a.attnum ASC;`,
        [targetSchema, table]
      )
    : await query(colSql, [targetSchema, table])
  const columns: ColumnInfo[] = colRows.map((c) => {
    const colName = String(c.name)
    const defaultValue =
      c.default_value !== null && c.default_value !== undefined ? String(c.default_value) : null
    const isAutoIncrement =
      toSqlBool(c.is_auto_increment) ||
      (defaultValue !== null && /unique_rowid\s*\(/i.test(defaultValue))
    return {
      name: colName,
      type: String(c.type),
      nativeType: String(c.native_type),
      nullable: toSqlBool(c.nullable),
      defaultValue,
      isPrimaryKey: primaryKey.includes(colName),
      isAutoIncrement,
    }
  })

  // 4. Foreign Keys (joined via referential_constraints + position_in_unique_constraint to avoid composite Cartesian product; replaces constraint_column_usage)
  const fkSql = `
    SELECT
      tc.constraint_name,
      kcu.column_name,
      ccu.table_schema AS referenced_schema,
      ccu.table_name AS referenced_table,
      ccu.column_name AS referenced_column,
      rc.delete_rule AS on_delete,
      rc.update_rule AS on_update
    FROM information_schema.table_constraints AS tc
    JOIN information_schema.key_column_usage AS kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
      AND tc.table_name = kcu.table_name
    JOIN information_schema.referential_constraints AS rc
      ON rc.constraint_name = tc.constraint_name
      AND rc.constraint_schema = tc.table_schema
    JOIN information_schema.key_column_usage AS ccu
      ON ccu.constraint_name = rc.unique_constraint_name
      AND ccu.table_schema = rc.unique_constraint_schema
      AND ccu.ordinal_position = kcu.position_in_unique_constraint
    /* constraint_column_usage */
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = $1
      AND tc.table_name = $2
    ORDER BY tc.constraint_name, kcu.ordinal_position;
  `
  const fkRows = await query(fkSql, [targetSchema, table])
  const foreignKeys: ForeignKeyInfo[] = fkRows.map((fk) => ({
    constraintName: String(fk.constraint_name),
    column: String(fk.column_name),
    referencedTable: String(fk.referenced_table),
    referencedColumn: String(fk.referenced_column),
    ...(fk.referenced_schema ? { referencedSchema: String(fk.referenced_schema) } : {}),
    ...(fk.on_delete ? { onDelete: String(fk.on_delete).toUpperCase() } : {}),
    ...(fk.on_update ? { onUpdate: String(fk.on_update).toUpperCase() } : {}),
  }))

  // 5. Indexes via pg_catalog.pg_index + pg_attribute
  const idxSql = `
    SELECT
      i_cls.relname AS index_name,
      idx.indisunique AS is_unique,
      idx.indisprimary AS is_primary,
      att.attname AS column_name
    FROM pg_catalog.pg_index idx
    JOIN pg_catalog.pg_class t_cls ON t_cls.oid = idx.indrelid
    JOIN pg_catalog.pg_namespace ns ON ns.oid = t_cls.relnamespace
    JOIN pg_catalog.pg_class i_cls ON i_cls.oid = idx.indexrelid
    JOIN LATERAL unnest(idx.indkey) WITH ORDINALITY AS pos(attnum, ord) ON true
    JOIN pg_catalog.pg_attribute att ON att.attrelid = t_cls.oid AND att.attnum = pos.attnum
    WHERE ns.nspname = $1
      AND t_cls.relname = $2
    ORDER BY i_cls.relname ASC, pos.ord ASC;
  `
  const idxRows = await query(idxSql, [targetSchema, table])
  const indexMap = new Map<string, IndexInfo>()
  for (const r of idxRows) {
    const idxName = String(r.index_name)
    let item = indexMap.get(idxName)
    if (!item) {
      item = {
        name: idxName,
        isUnique: toSqlBool(r.is_unique),
        isPrimary: toSqlBool(r.is_primary),
        columns: [],
      }
      indexMap.set(idxName, item)
    }
    item.columns.push(String(r.column_name))
  }
  const indexes = Array.from(indexMap.values())

  return {
    name: table,
    schema: targetSchema,
    kind,
    columns,
    primaryKey,
    indexes,
    foreignKeys,
  }
}

// ============================================================================
// 3. MySQL Schema Introspection & Query Templates
// ============================================================================

function escapeMysqlSqlLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "''")
}

export const MYSQL_SCHEMA_QUERIES = {
  listObjects: (schema: string) => `
    SELECT TABLE_NAME AS name,
           CASE WHEN TABLE_TYPE = 'VIEW' THEN 'view' ELSE 'table' END AS kind,
           TABLE_SCHEMA AS \`schema\`
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = '${escapeMysqlSqlLiteral(schema)}'
    ORDER BY TABLE_NAME ASC;
  `,
  columns: (table: string, schema: string) => `
    SELECT
      COLUMN_NAME AS name,
      DATA_TYPE AS type,
      COLUMN_TYPE AS native_type,
      IS_NULLABLE = 'YES' AS nullable,
      COLUMN_DEFAULT AS default_value,
      COLUMN_KEY = 'PRI' AS is_primary,
      EXTRA LIKE '%auto_increment%' AS is_auto_increment
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = '${escapeMysqlSqlLiteral(schema)}' AND TABLE_NAME = '${escapeMysqlSqlLiteral(table)}'
    ORDER BY ORDINAL_POSITION ASC;
  `,
  foreignKeys: (table: string, schema: string) => `
    SELECT
      CONSTRAINT_NAME AS constraint_name,
      COLUMN_NAME AS column_name,
      REFERENCED_TABLE_NAME AS referenced_table,
      REFERENCED_COLUMN_NAME AS referenced_column
    FROM information_schema.KEY_COLUMN_USAGE
    WHERE TABLE_SCHEMA = '${escapeMysqlSqlLiteral(schema)}'
      AND TABLE_NAME = '${escapeMysqlSqlLiteral(table)}'
      AND REFERENCED_TABLE_NAME IS NOT NULL;
  `,
  indexes: (table: string, schema: string) => `
    SELECT
      INDEX_NAME AS name,
      NON_UNIQUE = 0 AS is_unique,
      INDEX_NAME = 'PRIMARY' AS is_primary,
      COLUMN_NAME AS column_name,
      SEQ_IN_INDEX AS seq
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = '${escapeMysqlSqlLiteral(schema)}' AND TABLE_NAME = '${escapeMysqlSqlLiteral(table)}'
    ORDER BY INDEX_NAME ASC, SEQ_IN_INDEX ASC;
  `,
}

const MYSQL_SYSTEM_SCHEMAS = ['information_schema', 'performance_schema', 'mysql', 'sys'] as const

function isMysqlSystemSchema(schemaName: string): boolean {
  return (MYSQL_SYSTEM_SCHEMAS as readonly string[]).includes(schemaName.toLowerCase())
}

export async function introspectMysqlObjects(
  query: QueryExecutor,
  schema: string
): Promise<SchemaObject[]> {
  const trimmedSchema = (schema || '').trim()
  const objects: SchemaObject[] = []
  const seen = new Set<string>()
  const pushRow = (row: Record<string, unknown>) =>
    pushSchemaObject(row, objects, seen, trimmedSchema)

  if (!trimmedSchema) {
    const rows = await query(
      `
      SELECT
        table_name AS name,
        table_schema AS \`schema\`,
        CASE
          WHEN table_type = 'VIEW' THEN 'view'
          ELSE 'table'
        END AS kind
      FROM information_schema.tables
      WHERE table_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
        AND table_type IN ('BASE TABLE', 'VIEW')
      ORDER BY table_schema ASC, table_name ASC;
    `,
      []
    )
    rows.forEach(pushRow)

    await collectSchemaObjects(
      query,
      `SELECT routine_name AS name, routine_schema AS \`schema\`,
              CASE WHEN routine_type = 'PROCEDURE' THEN 'procedure' ELSE 'function' END AS kind
         FROM information_schema.routines
         WHERE routine_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
         ORDER BY routine_schema ASC, routine_name ASC;`,
      [],
      pushRow
    )
    await collectSchemaObjects(
      query,
      `SELECT trigger_name AS name, trigger_schema AS \`schema\`, 'trigger' AS kind,
              event_object_table AS detail
         FROM information_schema.triggers
         WHERE trigger_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
         ORDER BY trigger_schema ASC, trigger_name ASC;`,
      [],
      pushRow
    )
  } else {
    const rows = await query(
      `
      SELECT
        table_name AS name,
        table_schema AS \`schema\`,
        CASE
          WHEN table_type = 'VIEW' THEN 'view'
          ELSE 'table'
        END AS kind
      FROM information_schema.tables
      WHERE table_schema = ?
        AND table_type IN ('BASE TABLE', 'VIEW')
      ORDER BY table_name ASC;
    `,
      [trimmedSchema]
    )
    rows.forEach(pushRow)

    await collectSchemaObjects(
      query,
      `SELECT routine_name AS name, routine_schema AS \`schema\`,
              CASE WHEN routine_type = 'PROCEDURE' THEN 'procedure' ELSE 'function' END AS kind
         FROM information_schema.routines
         WHERE routine_schema = ?
         ORDER BY routine_name ASC;`,
      [trimmedSchema],
      pushRow
    )
    await collectSchemaObjects(
      query,
      `SELECT trigger_name AS name, trigger_schema AS \`schema\`, 'trigger' AS kind,
              event_object_table AS detail
         FROM information_schema.triggers
         WHERE trigger_schema = ?
         ORDER BY trigger_name ASC;`,
      [trimmedSchema],
      pushRow
    )
  }

  return objects.sort((a, b) => a.name.localeCompare(b.name))
}

export async function introspectMysqlSchemas(
  query: QueryExecutor,
  defaultDb: string
): Promise<{ schemas: string[]; defaultSchema: string }> {
  const rows = await query('SHOW DATABASES;', [])
  const current = (defaultDb || '').trim()
  const names: string[] = []
  for (const row of rows) {
    const firstValue = row.Database ?? row.database ?? Object.values(row)[0]
    const name = String(firstValue ?? '').trim()
    if (!name) continue
    if (isMysqlSystemSchema(name) && name !== current) continue
    names.push(name)
  }
  const ordered = current && names.includes(current)
    ? [current, ...names.filter((name) => name !== current)]
    : names
  return {
    schemas: ordered,
    defaultSchema: current || ordered[0] || '',
  }
}

export async function introspectMysqlObjectDdl(
  query: QueryExecutor,
  name: string,
  kind: SchemaObjectKind,
  schema: string
): Promise<string> {
  const targetSchema = (schema || '').trim()
  if (!targetSchema) {
    throw new Error('A database/schema name is required to fetch MySQL object DDL.')
  }
  const qualified = `${quoteIdentForDialect(targetSchema, 'mysql')}.${quoteIdentForDialect(name, 'mysql')}`
  const keyword =
    kind === 'view'
      ? 'VIEW'
      : kind === 'procedure'
        ? 'PROCEDURE'
        : kind === 'function'
          ? 'FUNCTION'
          : kind === 'trigger'
            ? 'TRIGGER'
            : kind === 'table'
              ? 'TABLE'
              : ''
  if (!keyword) {
    throw new Error(`MySQL does not support DDL export for object kind '${kind}'.`)
  }
  const rows = await query(`SHOW CREATE ${keyword} ${qualified};`, [])
  const row = rows[0]
  if (row) {
    const expectedKeys = [`create ${keyword.toLowerCase()}`]
    if (kind === 'trigger') {
      expectedKeys.push('sql original statement')
    }
    for (const [key, value] of Object.entries(row)) {
      if (!expectedKeys.includes(key.toLowerCase())) continue
      if (typeof value === 'string' && value.trim().length > 0) {
        return normalizeDdlSuffix(value)
      }
    }
  }
  throw new Error(`DDL not found for ${keyword} ${qualified}.`)
}

export async function introspectMysqlTableDetails(
  query: QueryExecutor,
  table: string,
  schema: string
): Promise<TableDetails> {
  // 1. Kind
  const kindSql = `
    SELECT 
      CASE 
        WHEN table_type = 'VIEW' THEN 'view'
        ELSE 'table'
      END AS kind
    FROM information_schema.tables
    WHERE table_schema = ? AND table_name = ?;
  `
  const kindRows = await query(kindSql, [schema, table])
  const kind: 'table' | 'view' = kindRows[0]?.kind === 'view' ? 'view' : 'table'

  // 2. Columns (preserve full COLUMN_TYPE including length/enum in both type & nativeType for DDL/drafts)
  const colSql = `
    SELECT 
      column_name AS name,
      column_type AS type,
      column_type AS native_type,
      (is_nullable = 'YES') AS nullable,
      column_default AS default_value,
      (column_key = 'PRI') AS is_primary_key,
      (extra LIKE '%auto_increment%') AS is_auto_increment
    FROM information_schema.columns
    WHERE table_schema = ? AND table_name = ?
    ORDER BY ordinal_position ASC;
  `
  const colRows = await query(colSql, [schema, table])
  const columns: ColumnInfo[] = colRows.map((c) => {
    const colType = String(c.type || '')
    const rawNative = String(c.native_type || '')
    const effectiveNativeType =
      colType.includes('(') && !rawNative.includes('(') ? colType : rawNative || colType
    return {
      name: String(c.name),
      type: colType,
      nativeType: effectiveNativeType,
      nullable: toSqlBool(c.nullable),
      defaultValue: c.default_value !== null && c.default_value !== undefined ? String(c.default_value) : null,
      isPrimaryKey: toSqlBool(c.is_primary_key),
      isAutoIncrement: toSqlBool(c.is_auto_increment),
    }
  })

  // 3. Primary Key
  const pkSql = `
    SELECT column_name AS column_name
    FROM information_schema.key_column_usage
    WHERE table_schema = ? 
      AND table_name = ? 
      AND constraint_name = 'PRIMARY'
    ORDER BY ordinal_position ASC;
  `
  const pkRows = await query(pkSql, [schema, table])
  const primaryKey = pkRows.map((r) => String(r.column_name ?? r.COLUMN_NAME))

  // 4. Foreign Keys (include referential ON DELETE / ON UPDATE actions & cross-schema target)
  const fkSql = `
    SELECT 
      kcu.constraint_name AS constraint_name,
      kcu.column_name AS \`column\`,
      kcu.referenced_table_schema AS referenced_schema,
      kcu.referenced_table_name AS referenced_table,
      kcu.referenced_column_name AS referenced_column,
      rc.delete_rule AS on_delete,
      rc.update_rule AS on_update
    FROM information_schema.key_column_usage kcu
    LEFT JOIN information_schema.referential_constraints rc
      ON rc.constraint_schema = kcu.table_schema
      AND rc.table_name = kcu.table_name
      AND rc.constraint_name = kcu.constraint_name
    WHERE kcu.table_schema = ?
      AND kcu.table_name = ?
      AND kcu.referenced_table_name IS NOT NULL
    ORDER BY kcu.constraint_name ASC, kcu.ordinal_position ASC;
  `
  const fkRows = await query(fkSql, [schema, table])
  const foreignKeys: ForeignKeyInfo[] = fkRows.map((fk) => ({
    constraintName: String(fk.constraint_name),
    column: String(fk.column),
    referencedTable: String(fk.referenced_table),
    referencedColumn: String(fk.referenced_column),
    ...(fk.referenced_schema &&
    String(fk.referenced_schema).toLowerCase() !== schema.toLowerCase()
      ? { referencedSchema: String(fk.referenced_schema) }
      : {}),
    ...(fk.on_delete ? { onDelete: String(fk.on_delete).toUpperCase() } : {}),
    ...(fk.on_update ? { onUpdate: String(fk.on_update).toUpperCase() } : {}),
  }))

  // 5. Indexes
  const idxSql = `
    SELECT 
      index_name AS name,
      (non_unique = 0) AS is_unique,
      (index_name = 'PRIMARY') AS is_primary,
      column_name AS column_name,
      seq_in_index AS seq_in_index
    FROM information_schema.statistics
    WHERE table_schema = ? AND table_name = ?
    ORDER BY index_name ASC, seq_in_index ASC;
  `
  const idxRows = await query(idxSql, [schema, table])
  const indexMap = new Map<string, IndexInfo>()
  for (const r of idxRows) {
    const idxName = String(r.name ?? r.INDEX_NAME)
    let item = indexMap.get(idxName)
    if (!item) {
      item = {
        name: idxName,
        isUnique: toSqlBool(r.is_unique),
        isPrimary: toSqlBool(r.is_primary),
        columns: [],
      }
      indexMap.set(idxName, item)
    }
    item.columns.push(String(r.column_name ?? r.COLUMN_NAME))
  }
  const indexes = Array.from(indexMap.values())

  return {
    name: table,
    schema,
    kind,
    columns,
    primaryKey,
    indexes,
    foreignKeys,
  }
}

// ============================================================================
// 4. Full Schema DDL Export Assembly
// ============================================================================

const SCHEMA_DDL_KIND_ORDER: readonly SchemaObjectKind[] = [
  'type',
  'sequence',
  'table',
  'view',
  'materialized_view',
  'function',
  'procedure',
  'trigger',
]

interface SchemaDdlSection {
  kind: SchemaObjectKind
  name: string
  ddl: string
  failed?: boolean
  dependsOn?: string[]
}

interface DdlToken {
  text: string
  kind: 'word' | 'ident' | 'punct'
}

function tokenizeDdlForDeps(ddl: string, dialect: DatabaseDriverType): DdlToken[] {
  const tokens: DdlToken[] = []
  const len = ddl.length
  const backslashAndHash = usesBackslashAndHash(dialect)
  let i = 0
  while (i < len) {
    const ch = ddl[i]
    if (ch === '-' && i + 1 < len && ddl[i + 1] === '-') {
      i = scanLineCommentEnd(ddl, i)
      continue
    }
    if (ch === '#' && backslashAndHash) {
      let j = i + 1
      while (j < len && ddl[j] !== '\n') j++
      i = j < len ? j + 1 : len
      continue
    }
    if (ch === '/' && i + 1 < len && ddl[i + 1] === '*') {
      i = scanBlockCommentEnd(ddl, i)
      continue
    }
    if (isPostgresEscapeStringStart(ddl, i, dialect)) {
      i = scanQuotedSegmentEnd(ddl, i + 1, "'", true).end
      continue
    }
    if (ch === "'") {
      i = scanQuotedSegmentEnd(ddl, i, "'", backslashAndHash).end
      continue
    }
    if (ch === '$') {
      const tag = matchDollarQuoteTag(ddl, i)
      if (tag !== null) {
        const closeIdx = ddl.indexOf(tag, i + tag.length)
        i = closeIdx >= 0 ? closeIdx + tag.length : len
        continue
      }
    }
    if (ch === '"') {
      const seg = scanQuotedSegmentEnd(ddl, i, '"', false)
      const raw = ddl.slice(i + 1, seg.closed ? seg.end - 1 : seg.end)
      tokens.push({ text: raw.replace(/""/g, '"'), kind: 'ident' })
      i = seg.end
      continue
    }
    if (ch === '`') {
      const seg = scanQuotedSegmentEnd(ddl, i, '`', false)
      const raw = ddl.slice(i + 1, seg.closed ? seg.end - 1 : seg.end)
      tokens.push({ text: raw.replace(/``/g, '`'), kind: 'ident' })
      i = seg.end
      continue
    }
    if (ch === '[') {
      let j = i + 1
      while (j < len) {
        if (ddl[j] === ']') {
          if (j + 1 < len && ddl[j + 1] === ']') {
            j += 2
            continue
          }
          break
        }
        j++
      }
      tokens.push({ text: ddl.slice(i + 1, j).replace(/]]/g, ']'), kind: 'ident' })
      i = j < len ? j + 1 : len
      continue
    }
    if (ch === '.') {
      tokens.push({ text: '.', kind: 'punct' })
      i++
      continue
    }
    if (ch === ',' || ch === '(' || ch === ')' || ch === ';') {
      tokens.push({ text: ch, kind: 'punct' })
      i++
      continue
    }
    if (isIdentStartChar(ddl.charCodeAt(i))) {
      let j = i + 1
      while (j < len && isIdentContChar(ddl.charCodeAt(j))) j++
      tokens.push({ text: ddl.slice(i, j), kind: 'word' })
      i = j
      continue
    }
    i++
  }
  return tokens
}

function extractReferencedTablesFromDdl(ddl: string, dialect: DatabaseDriverType): string[] {
  const tokens = tokenizeDdlForDeps(ddl, dialect)
  const refs: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    if (tok.kind === 'word' && tok.text.toUpperCase() === 'REFERENCES') {
      const first = tokens[i + 1]
      if (!first || first.kind === 'punct') continue
      if (tokens[i + 2]?.text === '.' && tokens[i + 3] && tokens[i + 3].kind !== 'punct') {
        refs.push(tokens[i + 3].text)
        i += 3
      } else {
        refs.push(first.text)
        i += 1
      }
    }
  }
  return refs
}

const NON_RELATION_FROM_FUNCS = new Set(['EXTRACT', 'TRIM', 'SUBSTRING', 'OVERLAY', 'POSITION'])
const VIEW_CLAUSE_END_WORDS = new Set([
  'WHERE',
  'ON',
  'USING',
  'GROUP',
  'HAVING',
  'ORDER',
  'LIMIT',
  'OFFSET',
  'FETCH',
  'UNION',
  'INTERSECT',
  'EXCEPT',
  'WINDOW',
  'FOR',
  'LOCK',
  'SETTINGS',
  'FORMAT',
  'PREWHERE',
])

function extractReferencedRelationsFromViewDdl(ddl: string, dialect: DatabaseDriverType): string[] {
  const tokens = tokenizeDdlForDeps(ddl, dialect)
  const refs: string[] = []
  let startIdx = 0
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.kind === 'word' && t.text.toUpperCase() === 'AS') {
      startIdx = i + 1
      break
    }
  }

  let parenDepth = 0
  const suppressedFromDepths: number[] = []
  for (let i = startIdx; i < tokens.length; i++) {
    const tok = tokens[i]
    if (tok.kind === 'punct') {
      if (tok.text === '(') {
        parenDepth++
        const prev = tokens[i - 1]
        if (prev?.kind === 'word' && NON_RELATION_FROM_FUNCS.has(prev.text.toUpperCase())) {
          suppressedFromDepths.push(parenDepth)
        }
      } else if (tok.text === ')') {
        while (
          suppressedFromDepths.length > 0 &&
          suppressedFromDepths[suppressedFromDepths.length - 1] >= parenDepth
        ) {
          suppressedFromDepths.pop()
        }
        parenDepth = Math.max(0, parenDepth - 1)
      }
      continue
    }

    if (tok.kind !== 'word') continue
    const upper = tok.text.toUpperCase()
    const inSuppressedFunc =
      suppressedFromDepths.length > 0 &&
      suppressedFromDepths[suppressedFromDepths.length - 1] === parenDepth
    if ((upper === 'FROM' && !inSuppressedFunc) || upper === 'JOIN') {
      let j = i + 1
      while (j < tokens.length) {
        const cur = tokens[j]
        if (cur?.kind === 'word' && (cur.text.toUpperCase() === 'ONLY' || cur.text.toUpperCase() === 'LATERAL')) {
          j++
          continue
        }
        if (!cur || cur.kind === 'punct') break
        let relName = cur.text
        if (tokens[j + 1]?.text === '.' && tokens[j + 2] && tokens[j + 2].kind !== 'punct') {
          relName = tokens[j + 2].text
          j += 3
          if (tokens[j]?.text === '.' && tokens[j + 1] && tokens[j + 1].kind !== 'punct') {
            relName = tokens[j + 1].text
            j += 2
          }
        } else {
          j += 1
        }
        refs.push(relName)

        if (upper !== 'FROM') break
        // Skip optional alias in comma-separated FROM list: FROM t1 [AS] a, t2 b
        if (tokens[j]?.kind === 'word' && tokens[j].text.toUpperCase() === 'AS') {
          j += 2
        } else if (
          tokens[j] &&
          tokens[j].kind !== 'punct' &&
          !VIEW_CLAUSE_END_WORDS.has(tokens[j].text.toUpperCase()) &&
          tokens[j].text.toUpperCase() !== 'JOIN' &&
          tokens[j].text.toUpperCase() !== 'LEFT' &&
          tokens[j].text.toUpperCase() !== 'RIGHT' &&
          tokens[j].text.toUpperCase() !== 'INNER' &&
          tokens[j].text.toUpperCase() !== 'FULL' &&
          tokens[j].text.toUpperCase() !== 'CROSS' &&
          tokens[j].text.toUpperCase() !== 'NATURAL'
        ) {
          j += 1
        }
        if (tokens[j]?.text === ',') {
          j += 1
          continue
        }
        break
      }
      i = Math.max(i, j - 1)
    }
  }
  return refs
}

function sectionLookupKey(name: string, dialect: DatabaseDriverType): string {
  return dialect === 'postgres' || dialect === 'cockroachdb' ? name : name.toLowerCase()
}

function toposortSectionsWithinKind(
  group: SchemaDdlSection[],
  dialect: DatabaseDriverType
): { ordered: SchemaDdlSection[]; hadCycle: boolean } {
  if (group.length <= 1) return { ordered: [...group], hadCycle: false }
  const sortedNodes = [...group].sort((a, b) => a.name.localeCompare(b.name))
  const keyToIdx = new Map<string, number>()
  sortedNodes.forEach((node, idx) => {
    const key = sectionLookupKey(node.name, dialect)
    if (!keyToIdx.has(key)) keyToIdx.set(key, idx)
  })

  const depsOf: Set<number>[] = sortedNodes.map(() => new Set<number>())
  const dependentsOf: Set<number>[] = sortedNodes.map(() => new Set<number>())

  sortedNodes.forEach((node, idx) => {
    const rawDeps: string[] = [...(node.dependsOn ?? [])]
    if (node.kind === 'table' && !node.failed) {
      rawDeps.push(...extractReferencedTablesFromDdl(node.ddl, dialect))
    } else if ((node.kind === 'view' || node.kind === 'materialized_view') && !node.failed) {
      rawDeps.push(...extractReferencedRelationsFromViewDdl(node.ddl, dialect))
    }
    for (const depName of rawDeps) {
      const depIdx = keyToIdx.get(sectionLookupKey(depName, dialect))
      if (depIdx !== undefined && depIdx !== idx) {
        depsOf[idx].add(depIdx)
        dependentsOf[depIdx].add(idx)
      }
    }
  })

  const inDegree = depsOf.map((set) => set.size)
  const emitted = new Array<boolean>(sortedNodes.length).fill(false)
  const result: SchemaDdlSection[] = []
  let hadCycle = false

  while (result.length < sortedNodes.length) {
    let pick = -1
    for (let i = 0; i < sortedNodes.length; i++) {
      if (!emitted[i] && inDegree[i] === 0) {
        pick = i
        break
      }
    }
    if (pick === -1) {
      hadCycle = true
      // Deterministic cycle break: lowest alphabetical unemitted node
      for (let i = 0; i < sortedNodes.length; i++) {
        if (!emitted[i]) {
          pick = i
          break
        }
      }
    }
    if (pick === -1) break
    emitted[pick] = true
    result.push(sortedNodes[pick])
    for (const childIdx of dependentsOf[pick]) {
      if (!emitted[childIdx] && inDegree[childIdx] > 0) {
        inDegree[childIdx] -= 1
      }
    }
  }
  return { ordered: result, hadCycle }
}

function orderSectionsWithExplicitDependencies(
  base: SchemaDdlSection[],
  dependencies: SchemaDependencyEdge[]
): SchemaDdlSection[] {
  if (base.length <= 1 || dependencies.length === 0) return base
  const indexByKey = new Map<string, number>()
  base.forEach((section, index) => {
    indexByKey.set(schemaDependencyKey(section.kind, section.name), index)
  })

  const depsOf: Set<number>[] = base.map(() => new Set<number>())
  const dependentsOf: Set<number>[] = base.map(() => new Set<number>())
  for (const edge of dependencies) {
    const consumerIdx = indexByKey.get(
      schemaDependencyKey(edge.consumer.kind, edge.consumer.name)
    )
    const prerequisiteIdx = indexByKey.get(
      schemaDependencyKey(edge.prerequisite.kind, edge.prerequisite.name)
    )
    if (consumerIdx === undefined || prerequisiteIdx === undefined) continue
    if (consumerIdx === prerequisiteIdx) continue
    depsOf[consumerIdx].add(prerequisiteIdx)
    dependentsOf[prerequisiteIdx].add(consumerIdx)
  }

  const inDegree = depsOf.map((set) => set.size)
  const emitted = new Array<boolean>(base.length).fill(false)
  const result: SchemaDdlSection[] = []

  while (result.length < base.length) {
    // Existing ordering is the deterministic tie-breaker for ready nodes.
    let pick = -1
    for (let i = 0; i < base.length; i++) {
      if (!emitted[i] && inDegree[i] === 0) {
        pick = i
        break
      }
    }
    if (pick === -1) {
      // Deterministic cycle/unresolved break: lowest existing-order node
      for (let i = 0; i < base.length; i++) {
        if (!emitted[i]) {
          pick = i
          break
        }
      }
    }
    if (pick === -1) break
    emitted[pick] = true
    result.push(base[pick])
    for (const childIdx of dependentsOf[pick]) {
      if (!emitted[childIdx] && inDegree[childIdx] > 0) {
        inDegree[childIdx] -= 1
      }
    }
  }
  return result
}

function extractCyclicPgForeignKeys(
  section: SchemaDdlSection
): { cleanedDdl: string; deferredAlters: string[] } {
  const match = /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s(]+)/i.exec(section.ddl)
  if (!match || !match[1]) {
    return { cleanedDdl: section.ddl, deferredAlters: [] }
  }
  const qualifiedTable = match[1]
  const rawLines = section.ddl.split(/\r?\n/)
  const keptLines: string[] = []
  const deferredAlters: string[] = []
  let inCreateBody = false

  for (const line of rawLines) {
    if (!inCreateBody) {
      keptLines.push(line)
      if (/^\s*CREATE\s+TABLE\b/i.test(line) && line.includes('(')) {
        inCreateBody = true
      }
      continue
    }
    if (/^\s*\)\s*;?\s*$/.test(line)) {
      // Remove trailing comma from the previous surviving column/constraint line if needed
      if (keptLines.length > 0 && /,\s*$/.test(keptLines[keptLines.length - 1])) {
        keptLines[keptLines.length - 1] = keptLines[keptLines.length - 1].replace(/,\s*$/, '')
      }
      keptLines.push(line)
      inCreateBody = false
      continue
    }
    const trimmedLine = line.trim()
    const isFkLine = /^(?:CONSTRAINT\s+(?:"[^"]*"|[A-Za-z_][A-Za-z0-9_$]*)\s+)?FOREIGN\s+KEY\s*\(/i.test(
      trimmedLine
    )
    if (isFkLine) {
      const fkClause = trimmedLine.replace(/,\s*$/, '')
      deferredAlters.push(`ALTER TABLE ${qualifiedTable} ADD ${fkClause};`)
      continue
    }
    keptLines.push(line)
  }

  return { cleanedDdl: keptLines.join('\n'), deferredAlters }
}

/**
 * Orders schema objects by dependency (including FK topological sort for tables)
 * and renders a single executable `.sql` script with clean header comments.
 */
export function assembleFullSchemaDdl(params: {
  dialect: DatabaseDriverType
  schemaName: string
  sections: SchemaDdlSection[]
  dependencies?: SchemaDependencyEdge[]
}): { ddl: string; objectCount: number } {
  const byKind = new Map<SchemaObjectKind, SchemaDdlSection[]>()
  for (const section of params.sections) {
    const list = byKind.get(section.kind)
    if (list) list.push(section)
    else byKind.set(section.kind, [section])
  }

  const ordered: SchemaDdlSection[] = []
  let hadTableCycle = false
  for (const kind of SCHEMA_DDL_KIND_ORDER) {
    const group = byKind.get(kind)
    if (!group || group.length === 0) continue
    const sorted = toposortSectionsWithinKind(group, params.dialect)
    if (kind === 'table' && sorted.hadCycle) hadTableCycle = true
    ordered.push(...sorted.ordered)
  }
  for (const [kind, group] of byKind.entries()) {
    if (!SCHEMA_DDL_KIND_ORDER.includes(kind)) {
      const sorted = toposortSectionsWithinKind(group, params.dialect)
      ordered.push(...sorted.ordered)
    }
  }

  const finalOrder =
    params.dialect === 'postgres' && params.dependencies && params.dependencies.length > 0
      ? orderSectionsWithExplicitDependencies(ordered, params.dependencies)
      : ordered

  const isMysqlDialect = params.dialect === 'mysql' || params.dialect === 'mariadb'
  const isSqliteDialect =
    params.dialect === 'sqlite' || params.dialect === 'libsql' || params.dialect === 'd1'
  const isPgDialect = params.dialect === 'postgres' || params.dialect === 'cockroachdb'

  const lines: string[] = [
    '-- Datanoa Full Schema DDL Export',
    `-- Dialect: ${params.dialect}`,
    `-- Schema: ${params.schemaName}`,
    '',
  ]

  if (hadTableCycle && isMysqlDialect) {
    lines.push('SET FOREIGN_KEY_CHECKS = 0;', '')
  } else if (hadTableCycle && isSqliteDialect) {
    lines.push('PRAGMA foreign_keys = OFF;', '')
  }

  const deferredPgFkAlters: string[] = []
  let objectCount = 0
  for (const section of finalOrder) {
    const body = section.ddl.trim()
    if (!body) continue
    if (!section.failed) {
      objectCount += 1
    }
    lines.push(`-- ${section.kind}: ${section.name}`)

    if (
      hadTableCycle &&
      isPgDialect &&
      section.kind === 'table' &&
      !section.failed
    ) {
      const extracted = extractCyclicPgForeignKeys(section)
      lines.push(normalizeDdlSuffix(extracted.cleanedDdl))
      deferredPgFkAlters.push(...extracted.deferredAlters)
    } else if (
      isMysqlDialect &&
      !section.failed &&
      (section.kind === 'function' || section.kind === 'procedure' || section.kind === 'trigger') &&
      (body.includes(';') || /\bBEGIN\b/i.test(body))
    ) {
      const withoutTrailingSemi = body.replace(/;\s*$/, '')
      lines.push('DELIMITER $$', `${withoutTrailingSemi}$$`, 'DELIMITER ;')
    } else {
      lines.push(normalizeDdlSuffix(body))
    }
    lines.push('')
  }

  if (deferredPgFkAlters.length > 0) {
    lines.push('-- Deferred Foreign Keys (cyclic references)', ...deferredPgFkAlters, '')
  }

  if (hadTableCycle && isMysqlDialect) {
    lines.push('SET FOREIGN_KEY_CHECKS = 1;', '')
  } else if (hadTableCycle && isSqliteDialect) {
    lines.push('PRAGMA foreign_keys = ON;', '')
  }

  return { ddl: `${lines.join('\n').trimEnd()}\n`, objectCount }
}

/**
 * Sequentially collects deduplicated object DDLs (falling back to comment lines on errors)
 * and assembles them into a dependency-ordered schema export script.
 */
export async function collectAndAssembleSchemaDdl(options: {
  dialect: DatabaseDriverType
  schemaName: string
  objects: SchemaObject[]
  getObjectDdl: (object: SchemaObject) => Promise<string>
  dependencies?: SchemaDependencyEdge[]
}): Promise<{ ddl: string; objectCount: number }> {
  const sections: SchemaDdlSection[] = []
  const seen = new Set<string>()
  for (const object of options.objects) {
    const key = `${object.kind}:${object.name}`
    if (seen.has(key)) continue
    seen.add(key)
    try {
      const ddl = await options.getObjectDdl(object)
      sections.push({ kind: object.kind, name: object.name, ddl })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      sections.push({
        kind: object.kind,
        name: object.name,
        ddl: `-- Failed to export ${object.kind} ${object.name}: ${msg}`,
        failed: true,
      })
    }
  }
  return assembleFullSchemaDdl({
    dialect: options.dialect,
    schemaName: options.schemaName,
    sections,
    dependencies: options.dependencies,
  })
}
