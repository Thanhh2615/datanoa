import type {
  SchemaObject,
  TableDetails,
  ColumnInfo,
  IndexInfo,
  ForeignKeyInfo,
} from '../../protocol'

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
}

/**
 * Safely coerces SQL driver boolean/bit/numeric flag values (`boolean`, `0|1`, `'0'|'1'`, `'true'|'false'`, `Uint8Array`)
 * without treating `'0'` or `Uint8Array([0])` as truthy.
 */
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
    SELECT name, type AS kind 
    FROM sqlite_master 
    WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
    ORDER BY name ASC;
  `,
  listObjectsForSchema: (schema = 'main') => `
    SELECT name, type AS kind
    FROM ${sqliteSchemaPrefix(schema)}sqlite_master
    WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
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
  return rows.map((r) => ({
    name: String(r.name),
    schema: targetSchema,
    kind: r.kind === 'view' ? 'view' : 'table',
  }))
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

  const foreignKeys: ForeignKeyInfo[] = []
  for (const fk of fkRows) {
    const refTable = String(fk.table)
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
    foreignKeys.push({
      constraintName: `fk_${table}_${String(fk.from)}_${refTable}`,
      column: String(fk.from),
      referencedTable: refTable,
      referencedColumn,
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
  const sql = `
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
  `
  const rows = await query(sql, [schema])
  return rows.map((r) => ({
    name: String(r.name),
    schema: String(r.schema),
    kind: r.kind === 'view' ? 'view' : 'table',
  }))
}

export async function introspectPostgresTableDetails(
  query: QueryExecutor,
  table: string,
  schema: string = 'public'
): Promise<TableDetails> {
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
  const kindRows = await query(kindSql, [schema, table])
  const kind: 'table' | 'view' = kindRows[0]?.kind === 'view' ? 'view' : 'table'

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
  const pkRows = await query(pkSql, [schema, table])
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
  const colRows = await query(colSql, [schema, table])
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
      ccu.table_name AS referenced_table,
      ccu.column_name AS referenced_column
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
  const fkRows = await query(fkSql, [schema, table])
  const foreignKeys: ForeignKeyInfo[] = fkRows.map((fk) => ({
    constraintName: String(fk.constraint_name),
    column: String(fk.column_name),
    referencedTable: String(fk.referenced_table),
    referencedColumn: String(fk.referenced_column),
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
  const idxRows = await query(idxSql, [schema, table])
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
    schema,
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

export async function introspectMysqlObjects(
  query: QueryExecutor,
  schema: string
): Promise<SchemaObject[]> {
  const trimmedSchema = (schema || '').trim()
  if (!trimmedSchema) {
    const sql = `
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
    `
    const rows = await query(sql, [])
    return rows.map((r) => ({
      name: String(r.name),
      schema: String(r.schema),
      kind: r.kind === 'view' ? 'view' : 'table',
    }))
  }

  const sql = `
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
  `
  const rows = await query(sql, [trimmedSchema])
  return rows.map((r) => ({
    name: String(r.name),
    schema: String(r.schema),
    kind: r.kind === 'view' ? 'view' : 'table',
  }))
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

  // 4. Foreign Keys
  const fkSql = `
    SELECT 
      constraint_name AS constraint_name,
      column_name AS \`column\`,
      referenced_table_name AS referenced_table,
      referenced_column_name AS referenced_column
    FROM information_schema.key_column_usage
    WHERE table_schema = ? 
      AND table_name = ? 
      AND referenced_table_name IS NOT NULL
    ORDER BY constraint_name ASC, ordinal_position ASC;
  `
  const fkRows = await query(fkSql, [schema, table])
  const foreignKeys: ForeignKeyInfo[] = fkRows.map((fk) => ({
    constraintName: String(fk.constraint_name),
    column: String(fk.column),
    referencedTable: String(fk.referenced_table),
    referencedColumn: String(fk.referenced_column),
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
