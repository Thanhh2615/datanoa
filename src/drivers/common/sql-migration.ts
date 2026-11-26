import type {
  ColumnInfo,
  DatabaseDriverType,
  ForeignKeyInfo,
  IndexInfo,
  SchemaObjectKind,
  TableDetails,
} from '../../protocol'
import {
  isIdentContChar,
  isIdentStartChar,
  quoteIdentForDialect,
  quoteTableReference,
  scanBlockCommentEnd,
  scanLineCommentEnd,
  scanQuotedSegmentEnd,
} from './sql-lexer.js'
import {
  FORBIDDEN_DEFAULT_TOKENS,
  FORBIDDEN_SUBQUERY_VERBS,
  analyzeSqliteTriggerReferences,
  normalizeSqlDefaultExpression,
  validateColumnTypeSpec,
} from '../../shared-sql-core.js'

export { normalizeSqlDefaultExpression, validateColumnTypeSpec }

const MYSQL_TIMESTAMP_ON_UPDATE_DEFAULT_RE =
  /^CURRENT_TIMESTAMP(?:\(\d*\))?(?:\s+ON\s+UPDATE\s+CURRENT_TIMESTAMP(?:\(\d*\))?)?$/i
const MYSQL_BIT_LITERAL_DEFAULT_RE = /^b'[01]+'$/i
const MSSQL_NATIVE_DEFAULT_FUNC_RE =
  /^(?:GETDATE|GETUTCDATE|SYSDATETIME|SYSUTCDATETIME|SYSDATETIMEOFFSET|NEWSEQUENTIALID)\(\)$/i
const ORACLE_NATIVE_DEFAULT_EXPR_RE = /^(?:SYSDATE|SYSTIMESTAMP|SYS_GUID\(\))$/i
const SQLITE_NON_CONSTANT_DEFAULT_RE =
  /^(?:CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME)\b|\bON\s+UPDATE\b/i

function isSafeDdlIdentifierValue(raw: string): boolean {
  return !FORBIDDEN_DEFAULT_TOKENS.test(raw) && !raw.includes('\0')
}

function validateRawDdlExpression(
  rawExpr: string,
  label: string,
  options?: { requireCheckWrapper?: boolean }
): string {
  const trimmed = (rawExpr || '').trim()
  if (!trimmed) {
    throw new Error(`${label} cannot be empty.`)
  }
  if (trimmed.includes('\0') || trimmed.includes('\r') || trimmed.includes('\n')) {
    throw new Error(`${label} contains invalid control characters.`)
  }

  let unquotedText = ''
  for (const allowBs of [false, true]) {
    let i = 0
    const len = trimmed.length
    let depth = 0
    const parts: string[] = []
    while (i < len) {
      const ch = trimmed[i]
      if (ch === "'" || ch === '"' || ch === '`') {
        const seg = scanQuotedSegmentEnd(trimmed, i, ch, ch === "'" ? allowBs : false)
        if (!seg.closed) {
          throw new Error(`${label} contains an unterminated quote.`)
        }
        parts.push(' ')
        i = seg.end
        continue
      }
      if (ch === '[') {
        const closeIdx = trimmed.indexOf(']', i + 1)
        if (closeIdx === -1) {
          throw new Error(`${label} contains an unterminated bracket identifier.`)
        }
        parts.push(' ')
        i = closeIdx + 1
        continue
      }
      if (ch === ';' || ch === '#') {
        throw new Error(`${label} contains forbidden SQL delimiter or comment token.`)
      }
      if (ch === '-' && i + 1 < len && trimmed[i + 1] === '-') {
        throw new Error(`${label} contains forbidden SQL line comment.`)
      }
      if (ch === '/' && i + 1 < len && (trimmed[i + 1] === '*' || trimmed[i + 1] === '/')) {
        throw new Error(`${label} contains forbidden SQL comment.`)
      }
      if (ch === '*' && i + 1 < len && trimmed[i + 1] === '/') {
        throw new Error(`${label} contains forbidden SQL comment terminator.`)
      }
      if (ch === '(') {
        depth++
      } else if (ch === ')') {
        depth--
        if (depth < 0) {
          throw new Error(`${label} has unbalanced parentheses.`)
        }
      }
      parts.push(ch)
      i++
    }
    if (depth !== 0) {
      throw new Error(`${label} has unbalanced parentheses.`)
    }
    if (!allowBs) {
      unquotedText = parts.join('')
    }
  }

  if (FORBIDDEN_SUBQUERY_VERBS.test(unquotedText)) {
    throw new Error(`${label} cannot contain SQL query or DDL/DML statements.`)
  }

  if (options?.requireCheckWrapper) {
    const checkHeader =
      /^(?:CONSTRAINT\s+(?:"(?:[^"]|"")+"|`(?:[^`]|``)+`|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_$]*)\s+)?CHECK\s*\(/i.exec(
        trimmed
      )
    if (!checkHeader) {
      throw new Error(`${label} must be a valid CHECK (...) constraint.`)
    }
    const openParenIdx = checkHeader[0].length - 1
    let depth = 0
    let i = openParenIdx
    while (i < trimmed.length) {
      const ch = trimmed[i]
      if (ch === "'" || ch === '"' || ch === '`') {
        i = scanQuotedSegmentEnd(trimmed, i, ch, false).end
        continue
      }
      if (ch === '(') depth++
      else if (ch === ')') {
        depth--
        if (depth === 0 && i < trimmed.length - 1) {
          throw new Error(`${label} has unexpected trailing tokens after CHECK (...).`)
        }
      }
      i++
    }
  }

  return trimmed
}

function normalizeMigrationDefaultExpression(
  rawDefault: string,
  dataType = 'TEXT',
  dialect?: DatabaseDriverType
): string {
  const trimmed = (rawDefault ?? '').trim()
  if (!trimmed) return ''
  if (FORBIDDEN_DEFAULT_TOKENS.test(trimmed) || trimmed.includes('\0')) {
    throw new Error('Default value contains invalid SQL tokens (semicolons or comments).')
  }
  if (dialect === 'mysql' || dialect === 'mariadb') {
    if (MYSQL_TIMESTAMP_ON_UPDATE_DEFAULT_RE.test(trimmed) || MYSQL_BIT_LITERAL_DEFAULT_RE.test(trimmed)) {
      return trimmed
    }
  }
  if (dialect === 'mssql' && MSSQL_NATIVE_DEFAULT_FUNC_RE.test(trimmed)) {
    return trimmed
  }
  if (dialect === 'oracle' && ORACLE_NATIVE_DEFAULT_EXPR_RE.test(trimmed)) {
    return trimmed
  }
  return normalizeSqlDefaultExpression(trimmed, dataType)
}

function areDefaultsEquivalent(
  origDef: string,
  curDef: string,
  curType: string,
  dialect?: DatabaseDriverType
): boolean {
  const cleanOrig = (origDef ?? '').trim()
  const cleanCur = (curDef ?? '').trim()
  if (cleanOrig === cleanCur) return true
  if (cleanCur.length === 0) return false
  try {
    const normCur = normalizeMigrationDefaultExpression(cleanCur, curType, dialect)
    if (normCur === cleanOrig) return true
    if (cleanOrig.length > 0) {
      const normOrig = normalizeMigrationDefaultExpression(cleanOrig, curType, dialect)
      return normCur === normOrig
    }
  } catch {
    return false
  }
  return false
}

function isSqliteNonConstantDefault(rawDefault: string): boolean {
  const trimmed = (rawDefault ?? '').trim()
  if (!trimmed) return false
  if (SQLITE_NON_CONSTANT_DEFAULT_RE.test(trimmed)) return true
  if (trimmed.startsWith('(') && trimmed.endsWith(')')) return true
  if (/^[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(trimmed)) return true
  return false
}

export const SQLITE_FK_VIOLATION_SENTINEL = '__datanoa_fk_violation__'
export const SQLITE_FK_CHECK_ABORT_SQL = `SELECT json_extract('{}', '${SQLITE_FK_VIOLATION_SENTINEL}') FROM pragma_foreign_key_check LIMIT 1;`

const VALID_SQLITE_CONFLICT_ACTIONS: ReadonlySet<string> = new Set([
  'ROLLBACK',
  'ABORT',
  'FAIL',
  'IGNORE',
  'REPLACE',
])

function formatSqliteCollationClause(collate: string | undefined, dialect: DatabaseDriverType): string {
  const trimmed = (collate || '').trim()
  if (!trimmed || trimmed.toUpperCase() === 'BINARY') return ''
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
    return ` COLLATE ${trimmed}`
  }
  return ` COLLATE ${quoteIdentForDialect(trimmed, dialect)}`
}

function formatSqliteOnConflictClause(onConflict?: string): string {
  const upper = (onConflict || '').trim().toUpperCase()
  return VALID_SQLITE_CONFLICT_ACTIONS.has(upper) ? ` ON CONFLICT ${upper}` : ''
}

function formatSqliteIndexColumnSpec(
  spec: { name: string; collate?: string; desc?: boolean },
  dialect: DatabaseDriverType
): string {
  const quoted = quoteIdentForDialect(spec.name.trim(), dialect)
  const coll = formatSqliteCollationClause(spec.collate, dialect)
  const dir = spec.desc ? ' DESC' : ''
  return `${quoted}${coll}${dir}`
}

function buildQualifiedTableForDdl(
  schema: string | undefined,
  name: string,
  dialect: DatabaseDriverType
): string {
  const trimmedSchema = typeof schema === 'string' ? schema.trim() : ''
  const omitSchema =
    !trimmedSchema ||
    ((dialect === 'sqlite' || dialect === 'libsql' || dialect === 'd1') && trimmedSchema.toLowerCase() === 'main')
  return omitSchema
    ? quoteIdentForDialect(name, dialect)
    : `${quoteIdentForDialect(trimmedSchema, dialect)}.${quoteIdentForDialect(name, dialect)}`
}

function resolveColumnTypeForDisplay(col: ColumnInfo, dialect?: DatabaseDriverType): string {
  const typeTrimmed = (col.type || '').trim()
  const nativeTrimmed = (col.nativeType || '').trim()

  // PostgreSQL/CockroachDB array udt_name (_text -> text[]) and length/precision preservation (character varying(255), numeric(10,2))
  if (dialect === 'postgres' || dialect === 'cockroachdb' || nativeTrimmed.startsWith('_')) {
    if (nativeTrimmed.startsWith('_') && nativeTrimmed.length > 1) {
      if (typeTrimmed && typeTrimmed.toUpperCase() !== 'ARRAY' && typeTrimmed.endsWith('[]')) {
        return typeTrimmed
      }
      return `${nativeTrimmed.slice(1)}[]`
    }
    if (typeTrimmed.includes('(') && !nativeTrimmed.includes('(')) {
      return typeTrimmed
    }
  }

  // MySQL/MariaDB: preserve COLUMN_TYPE with length/enum (e.g. varchar(255), enum('a','b'))
  if (typeTrimmed.includes('(') && !nativeTrimmed.includes('(')) {
    return typeTrimmed
  }

  return nativeTrimmed || typeTrimmed || 'TEXT'
}

interface GroupedForeignKeyInput {
  constraintName?: string
  column: string
  referencedTable: string
  referencedSchema?: string
  referencedColumn: string
  onDelete?: string
  onUpdate?: string
}

function formatGroupedForeignKeyLines(
  fks: GroupedForeignKeyInput[],
  dialect: DatabaseDriverType,
  fallbackTableForName: string,
  indent = '  ',
  forceConstraintName = false
): string[] {
  interface FkGroup {
    constraintName?: string
    referencedTable: string
    referencedSchema?: string
    cols: string[]
    refCols: string[]
    seenPairs: Set<string>
    onDelete?: ReferentialAction
    onUpdate?: ReferentialAction
  }
  const groups: FkGroup[] = []
  const byKey = new Map<string, FkGroup>()

  for (const fk of fks) {
    const col = (fk.column || '').trim()
    const refTable = (fk.referencedTable || '').trim()
    const refCol = (fk.referencedColumn || '').trim()
    if (!col || !refTable || !refCol) continue
    const cname = (fk.constraintName || '').trim()
    const groupKey = `${cname}\u0000${fk.referencedSchema || ''}\u0000${refTable}`
    let group = byKey.get(groupKey)
    if (!group) {
      group = {
        constraintName: cname || undefined,
        referencedTable: refTable,
        referencedSchema: fk.referencedSchema,
        cols: [],
        refCols: [],
        seenPairs: new Set<string>(),
        onDelete: fk.onDelete ? sanitizeReferentialAction(fk.onDelete) : undefined,
        onUpdate: fk.onUpdate ? sanitizeReferentialAction(fk.onUpdate) : undefined,
      }
      byKey.set(groupKey, group)
      groups.push(group)
    }
    const pairKey = `${col}\u0000${refCol}`
    if (!group.seenPairs.has(pairKey)) {
      group.seenPairs.add(pairKey)
      group.cols.push(col)
      group.refCols.push(refCol)
    }
  }

  return groups.map((g) => {
    const localColsSql = g.cols.map((c) => quoteIdentForDialect(c, dialect)).join(', ')
    const targetColsSql = g.refCols.map((c) => quoteIdentForDialect(c, dialect)).join(', ')
    const refTableSql = g.referencedSchema
      ? qualifyAlterTarget(g.referencedTable, g.referencedSchema, dialect)
      : quoteTableReference(g.referencedTable, dialect)
    const effectiveName =
      g.constraintName ||
      `fk_${fallbackTableForName}_${g.cols[0]}_${g.referencedTable}`.replace(/[^A-Za-z0-9_]/g, '_')
    const constraintPrefix =
      g.constraintName || forceConstraintName || g.cols.length > 1
        ? `CONSTRAINT ${quoteIdentForDialect(effectiveName, dialect)} `
        : ''
    const effectiveOnDelete =
      g.onDelete &&
      g.onDelete !== 'NO ACTION' &&
      !((dialect === 'oracle' || dialect === 'mssql') && g.onDelete === 'RESTRICT') &&
      !(dialect === 'oracle' && g.onDelete === 'SET DEFAULT')
        ? g.onDelete
        : undefined
    const effectiveOnUpdate =
      dialect === 'oracle'
        ? undefined
        : g.onUpdate &&
            g.onUpdate !== 'NO ACTION' &&
            !(dialect === 'mssql' && g.onUpdate === 'RESTRICT')
          ? g.onUpdate
          : undefined
    const onDeleteClause = effectiveOnDelete ? ` ON DELETE ${effectiveOnDelete}` : ''
    const onUpdateClause = effectiveOnUpdate ? ` ON UPDATE ${effectiveOnUpdate}` : ''
    return `${indent}${constraintPrefix}FOREIGN KEY (${localColsSql}) REFERENCES ${refTableSql} (${targetColsSql})${onDeleteClause}${onUpdateClause}`
  })
}

/**
 * Reconstructs a dialect-appropriate CREATE TABLE DDL script including PK, FK, and CREATE [UNIQUE] INDEX statements.
 */
export function reconstructTableDdl(details: TableDetails, dialect: DatabaseDriverType): string {
  const qualifiedTable = buildQualifiedTableForDdl(details.schema, details.name, dialect)
  const pkCols =
    details.primaryKey.length > 0
      ? details.primaryKey
      : details.columns.filter((c) => c.isPrimaryKey).map((c) => c.name)

  const isSqliteDialect = dialect === 'sqlite' || dialect === 'libsql' || dialect === 'd1'
  const isMysqlDialect = dialect === 'mysql' || dialect === 'mariadb'
  const isPgDialect = dialect === 'postgres' || dialect === 'cockroachdb'
  const isMssqlDialect = dialect === 'mssql'
  const isOracleDialect = dialect === 'oracle'

  let inlinePkHandled = false
  const bodyLines: string[] = []

  for (const col of details.columns) {
    const colType = resolveColumnTypeForDisplay(col, dialect)
    const parts: string[] = [quoteIdentForDialect(col.name, dialect), colType]

    if (isSqliteDialect && col.isGenerated && col.generatedExpression?.trim()) {
      const storage = col.generatedStorage === 'STORED' ? 'STORED' : 'VIRTUAL'
      parts.push(`GENERATED ALWAYS AS (${col.generatedExpression.trim()}) ${storage}`)
      if (!col.nullable) {
        parts.push('NOT NULL')
      }
      if (col.collate) {
        const collClause = formatSqliteCollationClause(col.collate, dialect).trim()
        if (collClause) parts.push(collClause)
      }
      bodyLines.push(`  ${parts.join(' ')}`)
      continue
    }

    const hasSequenceOrRowidDefault =
      typeof col.defaultValue === 'string' &&
      /(?:\.nextval\b|nextval\s*\(|unique_rowid\s*\()/i.test(col.defaultValue)

    const useInlineSqliteAutoInc =
      isSqliteDialect &&
      col.isAutoIncrement &&
      colType.trim().toUpperCase() === 'INTEGER' &&
      pkCols.length === 1 &&
      pkCols[0] === col.name

    if (useInlineSqliteAutoInc) {
      parts.push('PRIMARY KEY AUTOINCREMENT')
      inlinePkHandled = true
    } else if (
      isOracleDialect &&
      col.isAutoIncrement &&
      !/identity/i.test(colType)
    ) {
      parts.push('GENERATED BY DEFAULT AS IDENTITY')
    } else if (
      isPgDialect &&
      col.isAutoIncrement &&
      !/serial|identity/i.test(colType) &&
      !hasSequenceOrRowidDefault
    ) {
      parts.push('GENERATED BY DEFAULT AS IDENTITY')
    } else if (isMssqlDialect && col.isAutoIncrement && !/identity/i.test(colType)) {
      parts.push('IDENTITY(1,1)')
    }

    const defaultValStr =
      !(isOracleDialect && col.isAutoIncrement) &&
      col.defaultValue !== null &&
      col.defaultValue !== undefined &&
      col.defaultValue !== ''
        ? (() => {
            if (!isMysqlDialect) return col.defaultValue
            try {
              return normalizeSqlDefaultExpression(col.defaultValue, colType)
            } catch {
              return col.defaultValue
            }
          })()
        : ''

    // Oracle requires DEFAULT before NOT NULL in column definitions (ORA-00907 otherwise)
    if (isOracleDialect && defaultValStr) {
      parts.push(`DEFAULT ${defaultValStr}`)
    }

    if (!col.nullable) {
      parts.push('NOT NULL')
    }

    if (!isOracleDialect && defaultValStr) {
      parts.push(`DEFAULT ${defaultValStr}`)
    }

    if (isMysqlDialect && col.isAutoIncrement) {
      parts.push('AUTO_INCREMENT')
    }

    if (isSqliteDialect && col.collate) {
      const collClause = formatSqliteCollationClause(col.collate, dialect).trim()
      if (collClause) parts.push(collClause)
    }

    bodyLines.push(`  ${parts.join(' ')}`)
  }

  if (pkCols.length > 0 && !inlinePkHandled) {
    const quotedPks = pkCols.map((pk) => quoteIdentForDialect(pk, dialect)).join(', ')
    bodyLines.push(`  PRIMARY KEY (${quotedPks})`)
  }

  const seenUniqueConstraints = new Set<string>()
  for (const idx of details.indexes) {
    const isTableUniqueConstraint =
      !idx.isPrimary &&
      (idx.origin === 'u' || (idx.isUnique && /^sqlite_autoindex_/i.test(idx.name)))
    if (!isTableUniqueConstraint) continue
    const rawSpecs: Array<{ name: string; collate?: string; desc?: boolean }> =
      Array.isArray(idx.columnSpecs) && idx.columnSpecs.length > 0
        ? idx.columnSpecs
            .map((s): { name: string; collate?: string; desc?: boolean } => ({
              name: (s.name || '').trim(),
              ...(s.collate ? { collate: s.collate.trim() } : {}),
              ...(s.desc ? { desc: true } : {}),
            }))
            .filter((s) => Boolean(s.name))
        : (idx.columns || [])
            .map((c) => c.trim())
            .filter(Boolean)
            .map((name) => ({ name }))
    if (rawSpecs.length === 0) continue
    const conflictClause = isSqliteDialect ? formatSqliteOnConflictClause(idx.onConflict) : ''
    const sig =
      rawSpecs
        .map(
          (s) =>
            `${s.name.toLowerCase()}:${(s.collate || '').toUpperCase()}:${s.desc ? 'DESC' : 'ASC'}`
        )
        .join('\0') + `\0${conflictClause}`
    if (seenUniqueConstraints.has(sig)) continue
    seenUniqueConstraints.add(sig)
    const formattedCols = rawSpecs
      .map((s) =>
        isSqliteDialect
          ? formatSqliteIndexColumnSpec(s, dialect)
          : quoteIdentForDialect(s.name, dialect)
      )
      .join(', ')
    bodyLines.push(`  UNIQUE (${formattedCols})${conflictClause}`)
  }

  bodyLines.push(...formatGroupedForeignKeyLines(details.foreignKeys, dialect, details.name, '  '))

  if (isSqliteDialect && Array.isArray(details.checkConstraints)) {
    for (const chk of details.checkConstraints) {
      const trimmedChk = (chk || '').trim()
      if (trimmedChk) {
        bodyLines.push(`  ${trimmedChk}`)
      }
    }
  }

  const sqliteTableOpts = isSqliteDialect
    ? [details.withoutRowid ? 'WITHOUT ROWID' : '', details.strict ? 'STRICT' : '']
        .filter(Boolean)
        .join(', ')
    : ''
  const sqliteTableOptsSuffix = sqliteTableOpts ? ` ${sqliteTableOpts}` : ''

  const createTableStmt =
    bodyLines.length > 0
      ? `CREATE TABLE ${qualifiedTable} (\n${bodyLines.join(',\n')}\n)${sqliteTableOptsSuffix};`
      : `CREATE TABLE ${qualifiedTable} ()${sqliteTableOptsSuffix};`

  const statements: string[] = [createTableStmt]

  for (const idx of details.indexes) {
    if (
      idx.isPrimary ||
      idx.columns.length === 0 ||
      idx.origin === 'u' ||
      /^sqlite_autoindex_/i.test(idx.name)
    ) {
      continue
    }
    const uniqueKw = idx.isUnique ? 'UNIQUE ' : ''
    const specs: Array<{ name: string; collate?: string; desc?: boolean }> =
      Array.isArray(idx.columnSpecs) && idx.columnSpecs.length > 0
        ? idx.columnSpecs
        : idx.columns.map((c): { name: string; collate?: string; desc?: boolean } => ({ name: c }))
    const idxCols = specs
      .map((s) =>
        isSqliteDialect
          ? formatSqliteIndexColumnSpec(s, dialect)
          : `${quoteIdentForDialect(s.name, dialect)}${s.desc ? ' DESC' : ''}`
      )
      .join(', ')
    const whereSuffix =
      isSqliteDialect && typeof idx.whereClause === 'string' && idx.whereClause.trim().length > 0
        ? ` WHERE ${idx.whereClause.trim()}`
        : ''
    if (isSqliteDialect) {
      const qualifiedIdx = buildQualifiedTableForDdl(details.schema, idx.name, dialect)
      const bareTable = quoteIdentForDialect(details.name, dialect)
      statements.push(
        `CREATE ${uniqueKw}INDEX ${qualifiedIdx} ON ${bareTable} (${idxCols})${whereSuffix};`
      )
    } else {
      statements.push(
        `CREATE ${uniqueKw}INDEX ${quoteIdentForDialect(idx.name, dialect)} ON ${qualifiedTable} (${idxCols})${whereSuffix};`
      )
    }
  }

  if (Array.isArray(details.triggers)) {
    for (const trg of details.triggers) {
      const sql = (trg?.sql || '').trim()
      if (!sql) continue
      statements.push(sql.endsWith(';') ? sql : `${sql};`)
    }
  }

  return statements.join('\n\n')
}

export type AlterTableAction =
  | {
      kind: 'addColumn'
      table: string
      schema?: string
      columnName: string
      dataType: string
      nullable?: boolean
      defaultValue?: string
    }
  | {
      kind: 'renameColumn'
      table: string
      schema?: string
      oldColumnName?: string
      newColumnName?: string
      oldName?: string
      newName?: string
    }
  | {
      kind: 'dropColumn'
      table: string
      schema?: string
      columnName: string
      previousDefaultValue?: string | null
      defaultDropSeq?: number
    }
  | {
      kind: 'renameTable'
      table: string
      schema?: string
      newTableName: string
    }
  | {
      kind: 'alterColumn'
      table: string
      schema?: string
      columnName: string
      dataType?: string
      nullable?: boolean
      previousNullable?: boolean
      isAutoIncrement?: boolean
      defaultValue?: string | null
      previousDefaultValue?: string | null
      defaultDropSeq?: number
    }
  | {
      kind: 'addIndex'
      table: string
      schema?: string
      indexName?: string
      columns: string[]
      unique?: boolean
    }
  | {
      kind: 'dropIndex'
      table: string
      schema?: string
      indexName: string
    }
  | {
      kind: 'addForeignKey'
      table: string
      schema?: string
      constraintName?: string
      column: string
      foreignTable: string
      foreignSchema?: string
      foreignColumn: string
      onDelete?: ReferentialAction
      onUpdate?: ReferentialAction
    }
  | {
      kind: 'dropForeignKey'
      table: string
      schema?: string
      constraintName: string
    }

export type ReferentialAction = 'NO ACTION' | 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'SET DEFAULT'

export interface DraftColumnItem {
  id: string
  originalName?: string
  name: string
  dataType: string
  nullable: boolean
  defaultValue: string
  isPrimaryKey: boolean
  isAutoIncrement?: boolean
  isGenerated?: boolean
  generatedExpression?: string
  generatedStorage?: 'STORED' | 'VIRTUAL'
  collate?: string
  status: 'existing' | 'new' | 'deleted'
  originalDataType?: string
  originalNullable?: boolean
  originalDefaultValue?: string
  originalIsPrimaryKey?: boolean
}

export interface DraftIndexItem {
  id: string
  originalName?: string
  name: string
  columns: string[]
  unique: boolean
  isPrimary?: boolean
  origin?: 'c' | 'u' | 'pk'
  columnSpecs?: Array<{ name: string; collate?: string; desc?: boolean }>
  onConflict?: string
  whereClause?: string
  partial?: boolean
  isExpression?: boolean
  status: 'existing' | 'new' | 'deleted'
}

export interface DraftForeignKeyItem {
  id: string
  constraintName?: string
  column: string
  foreignTable: string
  foreignSchema?: string
  foreignColumn: string
  onDelete: ReferentialAction
  onUpdate: ReferentialAction
  status: 'existing' | 'new' | 'deleted'
}

export interface TableStructureDraft {
  originalTableName: string
  tableName: string
  schema?: string
  columns: DraftColumnItem[]
  indexes: DraftIndexItem[]
  foreignKeys: DraftForeignKeyItem[]
  inboundForeignKeys?: Array<{
    fromTable: string
    fromColumn: string
    toColumn: string
    onDelete?: string
  }>
  triggers?: Array<{ name: string; sql: string }>
  checkConstraints?: string[]
  strict?: boolean
  withoutRowid?: boolean
}

export interface TableMigrationPlan {
  valid: boolean
  errors: string[]
  warnings: string[]
  changeSummaries: string[]
  statements: string[]
  isRebuild: boolean
}

export interface CreateTableColumnDraft {
  name: string
  dataType: string
  nullable?: boolean
  defaultValue?: string
  isPrimaryKey?: boolean
  isAutoIncrement?: boolean
}

const VALID_REFERENTIAL_ACTIONS: ReadonlySet<ReferentialAction> = new Set([
  'NO ACTION',
  'CASCADE',
  'SET NULL',
  'RESTRICT',
  'SET DEFAULT',
])

function sanitizeReferentialAction(action?: string): ReferentialAction {
  const upper = (action || 'NO ACTION').trim().toUpperCase() as ReferentialAction
  if (VALID_REFERENTIAL_ACTIONS.has(upper)) {
    return upper
  }
  return 'NO ACTION'
}

function hashColumnNameBase36(name: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36)
}

function buildMssqlDefaultConstraintName(tableName: string, colName: string): string {
  const hash = hashColumnNameBase36(`${tableName}\u0000${colName}`)
  const sanitize = (value: string): string =>
    value.replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+|_+$/g, '') || 'col'
  const safeTable = sanitize(tableName).slice(0, 48)
  const safeCol = sanitize(colName).slice(0, 48)
  const rawName = `DF_${safeTable}_${safeCol}_${hash}`.slice(0, 128)
  return quoteIdentForDialect(rawName, 'mssql')
}

function buildMssqlDropDefaultConstraintSql(
  qualifiedTable: string,
  colName: string,
  seqIndex?: number
): string {
  const prefix = `df_${colName.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 32) || 'col'}`
  const suffix =
    seqIndex !== undefined ? `${seqIndex}_${hashColumnNameBase36(colName)}` : hashColumnNameBase36(colName)
  const safeVar = `${prefix}_${suffix}`
  const escapedTableLiteral = qualifiedTable.replace(/'/g, "''")
  const escapedColLiteral = colName.replace(/'/g, "''")
  return (
    `DECLARE @${safeVar} NVARCHAR(256); ` +
    `SELECT @${safeVar} = dc.name FROM sys.default_constraints dc ` +
    `INNER JOIN sys.columns c ON dc.object_id = c.default_object_id ` +
    `WHERE c.object_id = OBJECT_ID(N'${escapedTableLiteral}') AND c.name = N'${escapedColLiteral}'; ` +
    `IF @${safeVar} IS NOT NULL EXEC(N'ALTER TABLE ${escapedTableLiteral} DROP CONSTRAINT ' + QUOTENAME(@${safeVar}));`
  )
}

function qualifyAlterTarget(
  table: string,
  schema: string | undefined,
  dialect: DatabaseDriverType
): string {
  const quotedTable = quoteIdentForDialect(table.trim(), dialect)
  const trimmedSchema = (schema ?? '').trim()
  const lowerSchema = trimmedSchema.toLowerCase()
  const isSqliteFamily = dialect === 'sqlite' || dialect === 'libsql' || dialect === 'd1'
  if (
    trimmedSchema.length > 0 &&
    !(isSqliteFamily && (lowerSchema === 'main' || lowerSchema === 'public')) &&
    dialect !== 'redis'
  ) {
    return `${quoteIdentForDialect(trimmedSchema, dialect)}.${quotedTable}`
  }
  return quotedTable
}

const SQLITE_CASE_RENAME_TEMP_TABLE = '__datanoa_case_rename_tmp'
const SQLITE_CASE_RENAME_TEMP_TABLE_ALT = '__datanoa_case_rename_tmp_2'

/**
 * Builds `ALTER TABLE ... RENAME TO` statements. SQLite-family engines compare table names
 * case-insensitively and reject a single-step case-only rename, so those go through a temp name.
 */
function buildRenameTableStatements(
  table: string,
  newTable: string,
  schema: string | undefined,
  dialect: DatabaseDriverType
): string[] {
  const isSqliteFamily = dialect === 'sqlite' || dialect === 'libsql' || dialect === 'd1'
  const isCaseOnly = table !== newTable && table.toLowerCase() === newTable.toLowerCase()
  if (!isSqliteFamily || !isCaseOnly) {
    return [
      `ALTER TABLE ${qualifyAlterTarget(table, schema, dialect)} RENAME TO ${quoteIdentForDialect(newTable, dialect)};`,
    ]
  }
  const tmpRename =
    table.toLowerCase() === SQLITE_CASE_RENAME_TEMP_TABLE
      ? SQLITE_CASE_RENAME_TEMP_TABLE_ALT
      : SQLITE_CASE_RENAME_TEMP_TABLE
  return [
    `ALTER TABLE ${qualifyAlterTarget(table, schema, dialect)} RENAME TO ${quoteIdentForDialect(tmpRename, dialect)};`,
    `ALTER TABLE ${qualifyAlterTarget(tmpRename, schema, dialect)} RENAME TO ${quoteIdentForDialect(newTable, dialect)};`,
  ]
}

export function buildAlterTableSql(
  action: AlterTableAction,
  dialect: DatabaseDriverType = 'sqlite'
): string {
  if (dialect === 'redis') {
    throw new Error('ALTER TABLE is not supported on Redis keyspaces.')
  }
  const tableName = (action.table || '').trim()
  if (!tableName) {
    throw new Error('Table name is required for ALTER TABLE.')
  }
  const qualifiedTable = qualifyAlterTarget(tableName, action.schema, dialect)

  switch (action.kind) {
    case 'addColumn': {
      const colName = (action.columnName || '').trim()
      if (!colName) {
        throw new Error('Column name is required to add a column.')
      }
      const rawType = validateColumnTypeSpec(action.dataType || 'TEXT')
      const quotedCol = quoteIdentForDialect(colName, dialect)
      const isNullable = action.nullable !== false
      const rawDef = (action.defaultValue ?? '').trim()
      let defaultClause = ''
      if (rawDef.length > 0) {
        const normalizedDef = normalizeMigrationDefaultExpression(rawDef, rawType, dialect)
        defaultClause = ` DEFAULT ${normalizedDef}`
      } else if (!isNullable && (dialect === 'sqlite' || dialect === 'libsql' || dialect === 'd1')) {
        // SQLite requires a DEFAULT value when adding a NOT NULL column to an existing table
        defaultClause = /INT|REAL|FLOAT|NUMERIC|DECIMAL|BOOL/i.test(rawType)
          ? ' DEFAULT 0'
          : " DEFAULT ''"
      }
      const nullClause = isNullable ? '' : ' NOT NULL'
      if (dialect === 'mssql') {
        return `ALTER TABLE ${qualifiedTable} ADD ${quotedCol} ${rawType}${nullClause}${defaultClause};`
      }
      if (dialect === 'oracle') {
        return `ALTER TABLE ${qualifiedTable} ADD (${quotedCol} ${rawType}${defaultClause}${nullClause});`
      }
      return `ALTER TABLE ${qualifiedTable} ADD COLUMN ${quotedCol} ${rawType}${nullClause}${defaultClause};`
    }
    case 'renameColumn': {
      const oldCol = (action.oldColumnName || action.oldName || '').trim()
      const newCol = (action.newColumnName || action.newName || '').trim()
      if (!oldCol || !newCol) {
        throw new Error('Both current and new column names are required.')
      }
      if (oldCol === newCol) {
        throw new Error('New column name must be different from the current column name.')
      }
      if (dialect === 'mssql') {
        const schemaPrefix = action.schema?.trim()
          ? `${quoteIdentForDialect(action.schema.trim(), 'mssql')}.`
          : ''
        const fullOldCol = `${schemaPrefix}${quoteIdentForDialect(tableName, 'mssql')}.${quoteIdentForDialect(oldCol, 'mssql')}`
        const oldPrefix = /[^\x00-\x7F]/.test(fullOldCol) ? 'N' : ''
        const newPrefix = /[^\x00-\x7F]/.test(newCol) ? 'N' : ''
        return `EXEC sp_rename ${oldPrefix}'${fullOldCol.replace(/'/g, "''")}', ${newPrefix}'${newCol.replace(/'/g, "''")}', 'COLUMN';`
      }
      return `ALTER TABLE ${qualifiedTable} RENAME COLUMN ${quoteIdentForDialect(oldCol, dialect)} TO ${quoteIdentForDialect(newCol, dialect)};`
    }
    case 'dropColumn': {
      const colName = (action.columnName || '').trim()
      if (!colName) {
        throw new Error('Column name is required to drop a column.')
      }
      const dropStmt = `ALTER TABLE ${qualifiedTable} DROP COLUMN ${quoteIdentForDialect(colName, dialect)};`
      if (dialect === 'mssql') {
        const prevDef = (action.previousDefaultValue ?? '').trim()
        if (action.previousDefaultValue === undefined || prevDef.length > 0) {
          const dropDefaultSql = buildMssqlDropDefaultConstraintSql(
            qualifiedTable,
            colName,
            action.defaultDropSeq
          )
          return `${dropDefaultSql}\n${dropStmt}`
        }
      }
      return dropStmt
    }
    case 'renameTable': {
      const newTbl = (action.newTableName || '').trim()
      if (!newTbl) {
        throw new Error('New table name is required.')
      }
      if (newTbl === tableName) {
        throw new Error('New table name must be different from the current table name.')
      }
      if (dialect === 'mysql' || dialect === 'mariadb' || dialect === 'clickhouse') {
        const qualifiedNew = qualifyAlterTarget(newTbl, action.schema, dialect)
        return `RENAME TABLE ${qualifiedTable} TO ${qualifiedNew};`
      }
      if (dialect === 'mssql') {
        const oldPrefix = /[^\x00-\x7F]/.test(qualifiedTable) ? 'N' : ''
        const newPrefix = /[^\x00-\x7F]/.test(newTbl) ? 'N' : ''
        return `EXEC sp_rename ${oldPrefix}'${qualifiedTable.replace(/'/g, "''")}', ${newPrefix}'${newTbl.replace(/'/g, "''")}';`
      }
      return buildRenameTableStatements(tableName, newTbl, action.schema, dialect).join('\n')
    }
    case 'alterColumn': {
      const colName = (action.columnName || '').trim()
      if (!colName) {
        throw new Error('Column name is required to alter a column.')
      }
      const quotedCol = quoteIdentForDialect(colName, dialect)
      const rawType = action.dataType ? validateColumnTypeSpec(action.dataType) : undefined
      const hasDefaultChange = action.defaultValue !== undefined
      const rawDef = (action.defaultValue ?? '').trim()

      if (dialect === 'postgres' || dialect === 'cockroachdb') {
        const clauses: string[] = []
        if (rawType) {
          clauses.push(`ALTER COLUMN ${quotedCol} TYPE ${rawType}`)
        }
        if (action.nullable !== undefined) {
          clauses.push(`ALTER COLUMN ${quotedCol} ${action.nullable ? 'DROP NOT NULL' : 'SET NOT NULL'}`)
        }
        if (hasDefaultChange) {
          if (rawDef.length > 0) {
            clauses.push(
              `ALTER COLUMN ${quotedCol} SET DEFAULT ${normalizeMigrationDefaultExpression(rawDef, rawType || 'TEXT', dialect)}`
            )
          } else {
            clauses.push(`ALTER COLUMN ${quotedCol} DROP DEFAULT`)
          }
        }
        if (clauses.length === 0) {
          throw new Error('No column modifications specified.')
        }
        return `ALTER TABLE ${qualifiedTable} ${clauses.join(', ')};`
      }

      if (dialect === 'mysql' || dialect === 'mariadb') {
        const effectiveType = rawType || 'VARCHAR(255)'
        const isAutoInc = Boolean(action.isAutoIncrement)
        const nullClause = action.nullable === false || isAutoInc ? ' NOT NULL' : ' NULL'
        const defClause = isAutoInc
          ? ''
          : rawDef.length > 0
            ? ` DEFAULT ${normalizeMigrationDefaultExpression(rawDef, effectiveType, dialect)}`
            : action.nullable !== false
              ? ' DEFAULT NULL'
              : ''
        const autoIncClause = isAutoInc ? ' AUTO_INCREMENT' : ''
        return `ALTER TABLE ${qualifiedTable} MODIFY COLUMN ${quotedCol} ${effectiveType}${nullClause}${defClause}${autoIncClause};`
      }

      if (dialect === 'mssql') {
        const effectiveType = rawType || 'NVARCHAR(255)'
        const nullClause =
          action.nullable !== undefined ? (action.nullable ? ' NULL' : ' NOT NULL') : ''
        const prevDef = (action.previousDefaultValue ?? '').trim()
        const altersColDef = Boolean(rawType || action.nullable !== undefined)
        const shouldDropDefault =
          (hasDefaultChange && (rawDef.length === 0 || prevDef.length > 0)) ||
          (altersColDef && prevDef.length > 0)
        const defaultToAdd = hasDefaultChange
          ? rawDef
          : altersColDef && prevDef.length > 0
            ? prevDef
            : ''
        const stmts: string[] = []
        if (shouldDropDefault) {
          stmts.push(buildMssqlDropDefaultConstraintSql(qualifiedTable, colName, action.defaultDropSeq))
        }
        if (altersColDef) {
          stmts.push(`ALTER TABLE ${qualifiedTable} ALTER COLUMN ${quotedCol} ${effectiveType}${nullClause};`)
        }
        if (defaultToAdd.length > 0) {
          const defConstraintName = buildMssqlDefaultConstraintName(tableName, colName)
          stmts.push(
            `ALTER TABLE ${qualifiedTable} ADD CONSTRAINT ${defConstraintName} DEFAULT ${normalizeMigrationDefaultExpression(defaultToAdd, effectiveType, dialect)} FOR ${quotedCol};`
          )
        }
        if (stmts.length === 0) {
          throw new Error('No column modifications specified.')
        }
        return stmts.join('\n')
      }

      if (dialect === 'oracle') {
        const parts: string[] = [quotedCol]
        if (rawType) parts.push(rawType)
        if (hasDefaultChange) {
          if (rawDef.length > 0) {
            parts.push(
              `DEFAULT ${normalizeMigrationDefaultExpression(rawDef, rawType || 'VARCHAR2(255)', dialect)}`
            )
          } else if (
            action.previousDefaultValue === undefined ||
            (action.previousDefaultValue !== null &&
              action.previousDefaultValue.trim().length > 0)
          ) {
            parts.push('DEFAULT NULL')
          }
        }
        if (
          action.nullable !== undefined &&
          (action.previousNullable === undefined || action.previousNullable !== action.nullable)
        ) {
          parts.push(action.nullable ? 'NULL' : 'NOT NULL')
        }
        if (parts.length <= 1) {
          throw new Error('No column modifications specified.')
        }
        return `ALTER TABLE ${qualifiedTable} MODIFY (${parts.join(' ')});`
      }

      if (dialect === 'clickhouse') {
        const effectiveType = rawType || 'String'
        const defClause =
          rawDef.length > 0
            ? ` DEFAULT ${normalizeMigrationDefaultExpression(rawDef, effectiveType, dialect)}`
            : ''
        return `ALTER TABLE ${qualifiedTable} MODIFY COLUMN ${quotedCol} ${effectiveType}${defClause};`
      }

      throw new Error(
        'Direct ALTER COLUMN is not supported by SQLite syntax; use buildTableMigrationSql for atomic table rebuild.'
      )
    }
    case 'addIndex': {
      const cols = (action.columns || []).map((c) => c.trim()).filter(Boolean)
      if (cols.length === 0) {
        throw new Error('At least one column is required to create an index.')
      }
      const rawIndexName =
        (action.indexName || '').trim() ||
        `idx_${tableName}_${cols.join('_')}`.replace(/[^A-Za-z0-9_]/g, '_')
      const quotedIdx = quoteIdentForDialect(rawIndexName, dialect)
      const quotedCols = cols.map((c) => quoteIdentForDialect(c, dialect)).join(', ')
      const uniqueKw = action.unique ? 'UNIQUE ' : ''
      if (dialect === 'clickhouse') {
        return `ALTER TABLE ${qualifiedTable} ADD INDEX ${quotedIdx} (${quotedCols}) TYPE minmax GRANULARITY 1;`
      }
      if (dialect === 'sqlite' || dialect === 'libsql' || dialect === 'd1') {
        const qualifiedIdx = qualifyAlterTarget(rawIndexName, action.schema, dialect)
        return `CREATE ${uniqueKw}INDEX ${qualifiedIdx} ON ${quoteIdentForDialect(tableName, dialect)} (${quotedCols});`
      }
      return `CREATE ${uniqueKw}INDEX ${quotedIdx} ON ${qualifiedTable} (${quotedCols});`
    }
    case 'dropIndex': {
      const idxName = (action.indexName || '').trim()
      if (!idxName) {
        throw new Error('Index name is required to drop an index.')
      }
      const quotedIdx = quoteIdentForDialect(idxName, dialect)
      if (dialect === 'mysql' || dialect === 'mariadb' || dialect === 'mssql') {
        return `DROP INDEX ${quotedIdx} ON ${qualifiedTable};`
      }
      if (dialect === 'clickhouse') {
        return `ALTER TABLE ${qualifiedTable} DROP INDEX ${quotedIdx};`
      }
      if (
        dialect === 'postgres' ||
        dialect === 'cockroachdb' ||
        dialect === 'oracle' ||
        dialect === 'sqlite' ||
        dialect === 'libsql' ||
        dialect === 'd1'
      ) {
        const qualifiedIdx = qualifyAlterTarget(idxName, action.schema, dialect)
        return `DROP INDEX ${qualifiedIdx};`
      }
      return `DROP INDEX ${quotedIdx};`
    }
    case 'addForeignKey': {
      const col = (action.column || '').trim()
      const refTable = (action.foreignTable || '').trim()
      const refCol = (action.foreignColumn || '').trim()
      if (!col || !refTable || !refCol) {
        throw new Error('Local column, target table, and target column are required for a foreign key.')
      }
      const fkName =
        (action.constraintName || '').trim() ||
        `fk_${tableName}_${col}_${refTable}`.replace(/[^A-Za-z0-9_]/g, '_')
      const onDelete = sanitizeReferentialAction(action.onDelete)
      const onUpdate = sanitizeReferentialAction(action.onUpdate)
      const qualifiedRef = qualifyAlterTarget(refTable, action.foreignSchema || action.schema, dialect)
      const effectiveOnDelete =
        onDelete !== 'NO ACTION' &&
        !((dialect === 'oracle' || dialect === 'mssql') && onDelete === 'RESTRICT') &&
        !(dialect === 'oracle' && onDelete === 'SET DEFAULT')
          ? onDelete
          : undefined
      const effectiveOnUpdate =
        dialect === 'oracle'
          ? undefined
          : onUpdate !== 'NO ACTION' && !(dialect === 'mssql' && onUpdate === 'RESTRICT')
            ? onUpdate
            : undefined
      const onDeleteClause = effectiveOnDelete ? ` ON DELETE ${effectiveOnDelete}` : ''
      const onUpdateClause = effectiveOnUpdate ? ` ON UPDATE ${effectiveOnUpdate}` : ''
      return `ALTER TABLE ${qualifiedTable} ADD CONSTRAINT ${quoteIdentForDialect(fkName, dialect)} FOREIGN KEY (${quoteIdentForDialect(col, dialect)}) REFERENCES ${qualifiedRef} (${quoteIdentForDialect(refCol, dialect)})${onDeleteClause}${onUpdateClause};`
    }
    case 'dropForeignKey': {
      const fkName = (action.constraintName || '').trim()
      if (!fkName) {
        throw new Error('Constraint name is required to drop a foreign key.')
      }
      const quotedFk = quoteIdentForDialect(fkName, dialect)
      if (dialect === 'mysql' || dialect === 'mariadb') {
        return `ALTER TABLE ${qualifiedTable} DROP FOREIGN KEY ${quotedFk};`
      }
      return `ALTER TABLE ${qualifiedTable} DROP CONSTRAINT ${quotedFk};`
    }
  }
}

export function createInitialTableDraft(details: TableDetails): TableStructureDraft {
  const pkSet = new Set(details.primaryKey || [])
  const columns: DraftColumnItem[] = (details.columns || []).map((col: ColumnInfo, idx: number) => {
    const defVal = col.defaultValue !== undefined && col.defaultValue !== null ? String(col.defaultValue) : ''
    const resolvedType = resolveColumnTypeForDisplay(col)
    const isPk = Boolean(col.isPrimaryKey || pkSet.has(col.name))
    return {
      id: `col_${idx}_${col.name}`,
      originalName: col.name,
      name: col.name,
      dataType: resolvedType,
      nullable: col.nullable !== false,
      defaultValue: defVal,
      isPrimaryKey: isPk,
      isAutoIncrement: Boolean(col.isAutoIncrement),
      ...(col.isGenerated ? { isGenerated: true } : {}),
      ...(col.generatedExpression ? { generatedExpression: col.generatedExpression } : {}),
      ...(col.generatedStorage ? { generatedStorage: col.generatedStorage } : {}),
      ...(col.collate ? { collate: col.collate } : {}),
      status: 'existing',
      originalDataType: resolvedType,
      originalNullable: col.nullable !== false,
      originalDefaultValue: defVal,
      originalIsPrimaryKey: isPk,
    }
  })

  const indexes: DraftIndexItem[] = (details.indexes || []).map((idxInfo: IndexInfo, idx: number) => ({
    id: `idx_${idx}_${idxInfo.name}`,
    originalName: idxInfo.name,
    name: idxInfo.name,
    columns: [...(idxInfo.columns || [])],
    unique: Boolean(idxInfo.isUnique),
    isPrimary: Boolean(idxInfo.isPrimary),
    ...(idxInfo.origin ? { origin: idxInfo.origin } : {}),
    ...(Array.isArray(idxInfo.columnSpecs)
      ? { columnSpecs: idxInfo.columnSpecs.map((s) => ({ ...s })) }
      : {}),
    ...(idxInfo.onConflict ? { onConflict: idxInfo.onConflict } : {}),
    ...(idxInfo.whereClause ? { whereClause: idxInfo.whereClause } : {}),
    ...(idxInfo.partial ? { partial: true } : {}),
    ...(idxInfo.isExpression ? { isExpression: true } : {}),
    status: 'existing',
  }))

  const foreignKeys: DraftForeignKeyItem[] = (details.foreignKeys || []).map(
    (fk: ForeignKeyInfo, idx: number) => {
      const refTable = fk.referencedTable || ''
      const refCol = fk.referencedColumn || 'id'
      return {
        id: `fk_${idx}_${fk.column}_${refTable}`,
        constraintName: fk.constraintName || `fk_${details.name}_${fk.column}`,
        column: fk.column,
        foreignTable: refTable,
        ...(fk.referencedSchema ? { foreignSchema: fk.referencedSchema } : {}),
        foreignColumn: refCol,
        onDelete: sanitizeReferentialAction(fk.onDelete),
        onUpdate: sanitizeReferentialAction(fk.onUpdate),
        status: 'existing',
      }
    }
  )

  return {
    originalTableName: details.name,
    tableName: details.name,
    schema: details.schema,
    columns,
    indexes,
    foreignKeys,
    ...(Array.isArray(details.inboundForeignKeys)
      ? { inboundForeignKeys: details.inboundForeignKeys.map((fk) => ({ ...fk })) }
      : {}),
    ...(Array.isArray(details.triggers)
      ? { triggers: details.triggers.map((t) => ({ name: t.name, sql: t.sql })) }
      : {}),
    ...(Array.isArray(details.checkConstraints) && details.checkConstraints.length > 0
      ? { checkConstraints: [...details.checkConstraints] }
      : {}),
    ...(details.strict ? { strict: true } : {}),
    ...(details.withoutRowid ? { withoutRowid: true } : {}),
  }
}

export function isDraftColumnDirty(col: DraftColumnItem): boolean {
  if (col.status !== 'existing') return true
  const origName = (col.originalName ?? '').trim()
  const curName = (col.name ?? '').trim()
  const origType = (col.originalDataType ?? 'TEXT').trim().toUpperCase()
  const curType = (col.dataType ?? 'TEXT').trim().toUpperCase()
  const isDefEqual = areDefaultsEquivalent(
    col.originalDefaultValue ?? '',
    col.defaultValue ?? '',
    curType
  )
  return (
    origName !== curName ||
    origType !== curType ||
    Boolean(col.originalNullable) !== Boolean(col.nullable) ||
    Boolean(col.originalIsPrimaryKey) !== Boolean(col.isPrimaryKey) ||
    !isDefEqual
  )
}

export function requiresSqliteTableRebuild(draft: TableStructureDraft): boolean {
  const hasColumnDefinitionChange = draft.columns.some((col) => {
    if (col.status !== 'existing') return false
    const origType = (col.originalDataType ?? 'TEXT').trim().toUpperCase()
    const curType = (col.dataType ?? 'TEXT').trim().toUpperCase()
    const isDefEqual = areDefaultsEquivalent(
      col.originalDefaultValue ?? '',
      col.defaultValue ?? '',
      curType,
      'sqlite'
    )
    const curDef = (col.defaultValue ?? '').trim()
    const hasIncompatibleDefaultEdit = !isDefEqual && /\bON\s+UPDATE\b/i.test(curDef)
    return (
      origType !== curType ||
      Boolean(col.originalNullable) !== Boolean(col.nullable) ||
      Boolean(col.originalIsPrimaryKey) !== Boolean(col.isPrimaryKey) ||
      !isDefEqual ||
      hasIncompatibleDefaultEdit
    )
  })
  const hasNewRebuildCol = draft.columns.some(
    (col) =>
      col.status === 'new' &&
      (col.isPrimaryKey ||
        col.isAutoIncrement ||
        col.isGenerated ||
        isSqliteNonConstantDefault(col.defaultValue ?? ''))
  )
  const droppedColMap = new Map<string, string>()
  for (const col of draft.columns) {
    if (col.status === 'deleted') {
      const name = (col.originalName || col.name).trim()
      if (name) droppedColMap.set(name.toLowerCase(), name)
    }
  }
  const hasDroppedPkColumn = draft.columns.some(
    (col) => col.status === 'deleted' && col.originalIsPrimaryKey
  )
  const hasDroppedColInSurvivingIndex = draft.indexes.some((idx) => {
    if (idx.status === 'deleted') return false
    const colNames = [
      ...(idx.columns || []),
      ...(Array.isArray(idx.columnSpecs) ? idx.columnSpecs.map((s) => s.name) : []),
    ]
    if (colNames.some((c) => droppedColMap.has((c || '').trim().toLowerCase()))) {
      return true
    }
    if (
      droppedColMap.size > 0 &&
      idx.whereClause &&
      findReferencedSqliteColumns(idx.whereClause, droppedColMap).length > 0
    ) {
      return true
    }
    return false
  })
  const hasDroppedUniqueAutoIndex = draft.indexes.some(
    (idx) =>
      idx.status === 'deleted' &&
      (idx.origin === 'u' || /^sqlite_autoindex_/i.test(idx.name))
  )
  const hasDroppedColInCheckOrGenerated =
    droppedColMap.size > 0 &&
    ((Array.isArray(draft.checkConstraints) &&
      draft.checkConstraints.some(
        (chk) => Boolean(chk?.trim()) && findReferencedSqliteColumns(chk, droppedColMap).length > 0
      )) ||
      draft.columns.some(
        (c) =>
          c.status !== 'deleted' &&
          c.isGenerated &&
          Boolean(c.generatedExpression?.trim()) &&
          findReferencedSqliteColumns(c.generatedExpression ?? '', droppedColMap).length > 0
      ))
  const hasFkChanges = draft.foreignKeys.some((fk) => fk.status === 'new' || fk.status === 'deleted')
  const hasDroppedColInActiveFk = draft.foreignKeys.some(
    (fk) => fk.status !== 'deleted' && droppedColMap.has((fk.column || '').trim().toLowerCase())
  )
  return (
    hasColumnDefinitionChange ||
    hasNewRebuildCol ||
    hasDroppedPkColumn ||
    hasDroppedColInSurvivingIndex ||
    hasDroppedUniqueAutoIndex ||
    hasDroppedColInCheckOrGenerated ||
    hasFkChanges ||
    hasDroppedColInActiveFk
  )
}

export function countTableStructureChanges(draft: TableStructureDraft): number {
  let count = 0
  if (draft.tableName.trim() && draft.tableName.trim() !== draft.originalTableName.trim()) {
    count += 1
  }
  for (const col of draft.columns) {
    if (col.status === 'new' || col.status === 'deleted' || isDraftColumnDirty(col)) {
      count += 1
    }
  }
  for (const idx of draft.indexes) {
    if (idx.status === 'new' || idx.status === 'deleted') {
      count += 1
    }
  }
  for (const fk of draft.foreignKeys) {
    if (fk.status === 'new' || fk.status === 'deleted') {
      count += 1
    }
  }
  return count
}

function findReferencedSqliteColumns(
  exprSql: string,
  candidateCols: ReadonlyMap<string, string>
): string[] {
  if (!exprSql || candidateCols.size === 0) return []
  const found: string[] = []
  const seen = new Set<string>()
  const record = (rawIdent: string): void => {
    const key = rawIdent.trim().toLowerCase()
    const canonical = candidateCols.get(key)
    if (canonical && !seen.has(key)) {
      seen.add(key)
      found.push(canonical)
    }
  }

  const len = exprSql.length
  let i = 0
  while (i < len) {
    const ch = exprSql[i]
    if (ch === '-' && i + 1 < len && exprSql[i + 1] === '-') {
      i = scanLineCommentEnd(exprSql, i)
      continue
    }
    if (ch === '/' && i + 1 < len && exprSql[i + 1] === '*') {
      i = scanBlockCommentEnd(exprSql, i, false)
      continue
    }
    if (ch === "'") {
      i = scanQuotedSegmentEnd(exprSql, i, "'", false).end
      continue
    }
    if (ch === '"' || ch === '`') {
      const seg = scanQuotedSegmentEnd(exprSql, i, ch, false)
      const inner = exprSql.slice(i + 1, seg.closed ? seg.end - 1 : seg.end)
      record(ch === '"' ? inner.replace(/""/g, '"') : inner.replace(/``/g, '`'))
      i = seg.end
      continue
    }
    if (ch === '[') {
      const closeBracket = exprSql.indexOf(']', i + 1)
      const end = closeBracket < 0 ? len : closeBracket + 1
      record(exprSql.slice(i + 1, closeBracket < 0 ? len : closeBracket))
      i = end
      continue
    }
    if (isIdentStartChar(exprSql.charCodeAt(i))) {
      let end = i + 1
      while (end < len && isIdentContChar(exprSql.charCodeAt(end))) end++
      record(exprSql.slice(i, end))
      i = end
      continue
    }
    i++
  }
  return found
}

function collectSqliteMigrationSafetyErrors(
  draft: TableStructureDraft,
  dialect: DatabaseDriverType,
  isRebuild: boolean
): string[] {
  if (dialect !== 'sqlite' && dialect !== 'libsql' && dialect !== 'd1') {
    return []
  }
  const errors: string[] = []
  const origTable = (draft.originalTableName || '').trim()
  const nextTable = (draft.tableName || origTable).trim()
  const activeCols = draft.columns.filter((c) => c.status !== 'deleted')

  const droppedColMap = new Map<string, string>()
  for (const col of draft.columns) {
    if (col.status === 'deleted') {
      const orig = (col.originalName || col.name).trim()
      if (orig) droppedColMap.set(orig.toLowerCase(), orig)
    }
  }

  const renamedColMap = new Map<string, string>()
  const survivingOldLower = new Set<string>()
  for (const col of activeCols) {
    const cur = (col.name || '').trim()
    if (cur) survivingOldLower.add(cur.toLowerCase())
    if (col.status === 'existing' && col.originalName) {
      const orig = col.originalName.trim()
      if (orig) {
        survivingOldLower.add(orig.toLowerCase())
        if (orig !== cur) {
          renamedColMap.set(orig.toLowerCase(), orig)
        }
      }
    }
  }

  // 1. Block partial column drops on ANY composite UNIQUE constraint or unique index (both origin='u' and origin='c')
  for (const idx of draft.indexes) {
    if (idx.status === 'deleted' || idx.isPrimary) continue
    const isUniqueConstraintOrIndex = Boolean(idx.unique || idx.origin === 'u')
    if (!isUniqueConstraintOrIndex) continue
    const origCols = (
      Array.isArray(idx.columnSpecs) && idx.columnSpecs.length > 0
        ? idx.columnSpecs.map((s) => s.name)
        : idx.columns || []
    )
      .map((c) => c.trim())
      .filter(Boolean)
    if (origCols.length > 1) {
      const lostCols = origCols.filter(
        (c) => droppedColMap.has(c.toLowerCase()) || !survivingOldLower.has(c.toLowerCase())
      )
      const keptColsCount = origCols.length - lostCols.length
      if (keptColsCount > 0 && keptColsCount < origCols.length) {
        errors.push(
          `Composite UNIQUE constraint/index "${idx.name}" references dropped column(s) (${lostCols.join(', ')}). Delete the composite UNIQUE constraint/index explicitly before dropping its column(s).`
        )
      }
    }
  }

  // 2. Block triggers referencing renamed/deleted columns (UPDATE OF, NEW., OLD., body)
  //    and handle table renames: pure renames block any trigger on origTable; rebuilds block only if body references origTable.
  if (Array.isArray(draft.triggers) && draft.triggers.length > 0) {
    const changedColMap = new Map<string, string>([...droppedColMap, ...renamedColMap])
    const identCandidates = Array.from(changedColMap.values())
    const tableRenamed = Boolean(origTable && nextTable && origTable !== nextTable)

    for (const trg of draft.triggers) {
      const trgName = (trg?.name || 'trigger').trim()
      const trgSql = (trg?.sql || '').trim()
      if (!trgSql) continue

      const analysis = analyzeSqliteTriggerReferences(trgSql, origTable, identCandidates)

      if (analysis.referencedIdents.length > 0) {
        errors.push(
          `Trigger "${trgName}" references renamed or dropped column(s) (${analysis.referencedIdents.join(', ')}); update or drop the trigger before migrating this table.`
        )
      }
      if (tableRenamed) {
        if (!isRebuild) {
          errors.push(
            `Trigger "${trgName}" exists on "${origTable}". Direct table rename to "${nextTable}" does not recreate triggers; update or drop the trigger before renaming.`
          )
        } else if (analysis.referencesOrigTableInBody || !analysis.onTargetMatchesOrigTable) {
          errors.push(
            `Trigger "${trgName}" references old table "${origTable}" in its SQL body; update or drop the trigger before renaming the table to "${nextTable}".`
          )
        }
      }
    }
  }

  // 3. Block D1 rebuild when external inbound OR active self-referencing foreign keys exist
  if (dialect === 'd1' && isRebuild) {
    const origLower = origTable.toLowerCase()
    const deletedSelfRefCols = new Set(
      draft.foreignKeys
        .filter(
          (fk) =>
            fk.status === 'deleted' && fk.foreignTable.trim().toLowerCase() === origLower
        )
        .map((fk) => fk.column.trim().toLowerCase())
        .filter(Boolean)
    )
    const externalInbound = (draft.inboundForeignKeys || []).filter(
      (fk) => fk.fromTable.trim().toLowerCase() !== origLower
    )
    const activeSelfRefCols = new Map<string, string>()
    for (const fk of draft.foreignKeys) {
      if (fk.status !== 'deleted' && fk.foreignTable.trim().toLowerCase() === origLower) {
        const col = fk.column.trim()
        if (col) activeSelfRefCols.set(col.toLowerCase(), `${origTable}.${col}`)
      }
    }
    for (const fk of draft.inboundForeignKeys || []) {
      if (fk.fromTable.trim().toLowerCase() !== origLower) continue
      const col = fk.fromColumn.trim()
      if (col && !deletedSelfRefCols.has(col.toLowerCase())) {
        activeSelfRefCols.set(col.toLowerCase(), `${origTable}.${col}`)
      }
    }
    const blockingRefs = [
      ...externalInbound.map((fk) => `${fk.fromTable}.${fk.fromColumn}`),
      ...Array.from(activeSelfRefCols.values()),
    ]
    if (blockingRefs.length > 0) {
      const fkKindLabel =
        externalInbound.length > 0 && activeSelfRefCols.size > 0
          ? 'inbound and self-referencing foreign key(s)'
          : activeSelfRefCols.size > 0
            ? 'self-referencing foreign key(s)'
            : 'inbound foreign key(s)'
      errors.push(
        `Cannot rebuild Cloudflare D1 table "${origTable}" while referenced by ${fkKindLabel} (${blockingRefs.join(', ')}). D1 HTTP batches cannot disable PRAGMA foreign_keys outside a transaction.`
      )
    }
  }

  // 4. SQLite/D1 rebuild fidelity guards for generated columns, CHECK constraints, partial & expression indexes
  if (isRebuild) {
    const changedColMap = new Map<string, string>([...droppedColMap, ...renamedColMap])

    for (const col of activeCols) {
      if (!col.isGenerated) continue
      const expr = (col.generatedExpression || '').trim()
      if (!expr) {
        errors.push(
          `Generated column "${col.name}" is missing its SQL expression and cannot be safely preserved during table rebuild.`
        )
        continue
      }
      const refs = findReferencedSqliteColumns(expr, changedColMap)
      if (refs.length > 0) {
        errors.push(
          `Generated column "${col.name}" references renamed or dropped column(s) (${refs.join(', ')}); update or drop the generated column before rebuilding this table.`
        )
      }
    }

    if (Array.isArray(draft.checkConstraints) && changedColMap.size > 0) {
      for (const chk of draft.checkConstraints) {
        const trimmedChk = (chk || '').trim()
        if (!trimmedChk) continue
        const refs = findReferencedSqliteColumns(trimmedChk, changedColMap)
        if (refs.length > 0) {
          errors.push(
            `CHECK constraint "${trimmedChk}" references renamed or dropped column(s) (${refs.join(', ')}); update table constraints before rebuilding this table.`
          )
        }
      }
    }

    for (const idx of draft.indexes) {
      if (idx.status === 'deleted' || idx.isPrimary) continue
      if (idx.isExpression) {
        errors.push(
          `Expression index "${idx.name}" cannot be reconstructed safely during a SQLite table rebuild. Drop the expression index before rebuilding and recreate it afterwards.`
        )
        continue
      }
      if (idx.partial) {
        const whereSql = (idx.whereClause || '').trim()
        if (!whereSql) {
          errors.push(
            `Partial index "${idx.name}" is missing its WHERE predicate and cannot be preserved safely during table rebuild.`
          )
          continue
        }
        const refs = findReferencedSqliteColumns(whereSql, changedColMap)
        if (refs.length > 0) {
          errors.push(
            `Partial index "${idx.name}" WHERE clause references renamed or dropped column(s) (${refs.join(', ')}); drop or update the index before rebuilding this table.`
          )
        }
      }
    }
  }

  return errors
}

function findFirstUnquotedBeginKeywordIndex(sql: string): number {
  let i = 0
  const len = sql.length
  while (i < len) {
    const ch = sql[i]
    if (ch === '-' && i + 1 < len && sql[i + 1] === '-') {
      i = scanLineCommentEnd(sql, i)
      continue
    }
    if (ch === '/' && i + 1 < len && sql[i + 1] === '*') {
      i = scanBlockCommentEnd(sql, i, false)
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      i = scanQuotedSegmentEnd(sql, i, ch, false).end
      continue
    }
    if (ch === '[') {
      let k = i + 1
      while (k < len) {
        if (sql[k] === ']') {
          if (k + 1 < len && sql[k + 1] === ']') {
            k += 2
            continue
          }
          k++
          break
        }
        k++
      }
      i = k
      continue
    }
    if (isIdentStartChar(sql.charCodeAt(i))) {
      let end = i + 1
      while (end < len && isIdentContChar(sql.charCodeAt(end))) end++
      if (sql.slice(i, end).toUpperCase() === 'BEGIN') {
        return i
      }
      i = end
      continue
    }
    i++
  }
  return len
}

function scanTriggerHeaderToken(
  sql: string,
  start: number,
  limit: number
): { kind: 'word' | 'ident' | 'punct'; start: number; end: number; value: string; upper: string } | null {
  let i = start
  while (i < limit) {
    const ch = sql[i]
    if (/\s/.test(ch)) {
      i++
      continue
    }
    if (ch === '-' && i + 1 < limit && sql[i + 1] === '-') {
      i = Math.min(limit, scanLineCommentEnd(sql, i))
      continue
    }
    if (ch === '/' && i + 1 < limit && sql[i + 1] === '*') {
      i = Math.min(limit, scanBlockCommentEnd(sql, i, false))
      continue
    }
    if (ch === '"' || ch === '`' || ch === "'") {
      const seg = scanQuotedSegmentEnd(sql, i, ch, false)
      const inner = sql.slice(i + 1, Math.max(i + 1, seg.end - 1))
      const unescaped = ch === '"' ? inner.replace(/""/g, '"') : ch === '`' ? inner.replace(/``/g, '`') : inner
      return { kind: 'ident', start: i, end: Math.min(limit, seg.end), value: unescaped, upper: unescaped.toUpperCase() }
    }
    if (ch === '[') {
      let k = i + 1
      let val = ''
      while (k < limit) {
        if (sql[k] === ']') {
          if (k + 1 < limit && sql[k + 1] === ']') {
            val += ']'
            k += 2
            continue
          }
          k++
          break
        }
        val += sql[k]
        k++
      }
      return { kind: 'ident', start: i, end: k, value: val, upper: val.toUpperCase() }
    }
    if (isIdentStartChar(sql.charCodeAt(i))) {
      let end = i + 1
      while (end < limit && isIdentContChar(sql.charCodeAt(end))) end++
      const word = sql.slice(i, end)
      return { kind: 'word', start: i, end, value: word, upper: word.toUpperCase() }
    }
    return { kind: 'punct', start: i, end: i + 1, value: ch, upper: ch }
  }
  return null
}

function rewriteSqliteTriggerTargetTable(
  rawSql: string,
  oldTable: string,
  newTable: string,
  dialect: 'sqlite' | 'libsql' | 'd1'
): string {
  const trimmed = rawSql.trim()
  if (!trimmed) return ''
  const withSemi = trimmed.endsWith(';') ? trimmed : `${trimmed};`
  if (oldTable === newTable) return withSemi

  const headerEnd = findFirstUnquotedBeginKeywordIndex(withSemi)
  const quotedNew = quoteIdentForDialect(newTable, dialect)
  const oldLower = oldTable.toLowerCase()

  let cursor = 0
  while (cursor < headerEnd) {
    const tok = scanTriggerHeaderToken(withSemi, cursor, headerEnd)
    if (!tok) break
    cursor = tok.end
    if (tok.kind !== 'word' || tok.upper !== 'ON') continue

    const firstTarget = scanTriggerHeaderToken(withSemi, cursor, headerEnd)
    if (!firstTarget || (firstTarget.kind !== 'word' && firstTarget.kind !== 'ident')) continue

    let targetTok = firstTarget
    const afterFirst = scanTriggerHeaderToken(withSemi, firstTarget.end, headerEnd)
    if (afterFirst && afterFirst.kind === 'punct' && afterFirst.value === '.') {
      const secondTarget = scanTriggerHeaderToken(withSemi, afterFirst.end, headerEnd)
      if (!secondTarget || (secondTarget.kind !== 'word' && secondTarget.kind !== 'ident')) continue
      targetTok = secondTarget
    }

    if (targetTok.value.toLowerCase() !== oldLower) continue

    const afterTarget = scanTriggerHeaderToken(withSemi, targetTok.end, headerEnd)
    const validFollower =
      !afterTarget ||
      (afterTarget.kind === 'word' &&
        (afterTarget.upper === 'FOR' || afterTarget.upper === 'WHEN' || afterTarget.upper === 'BEGIN'))
    if (validFollower) {
      return `${withSemi.slice(0, targetTok.start)}${quotedNew}${withSemi.slice(targetTok.end)}`
    }
  }

  return withSemi
}

function buildSqliteTableRebuildStatements(
  draft: TableStructureDraft,
  dialect: 'sqlite' | 'libsql' | 'd1'
): string[] {
  const origTable = draft.originalTableName.trim()
  const finalTable = (draft.tableName || origTable).trim()
  if (!origTable || !finalTable) {
    throw new Error('Table name is required for table migration.')
  }
  if (!isSafeDdlIdentifierValue(origTable) || !isSafeDdlIdentifierValue(finalTable)) {
    throw new Error('Table name contains invalid characters.')
  }
  const cleanSchema = (draft.schema ?? '').trim()
  if (cleanSchema && !isSafeDdlIdentifierValue(cleanSchema)) {
    throw new Error('Schema name contains invalid characters.')
  }

  const activeCols = draft.columns.filter((c) => c.status !== 'deleted')
  if (activeCols.length === 0) {
    throw new Error('Table must have at least one active column.')
  }

  const seenNames = new Set<string>()
  for (const col of activeCols) {
    const cleanName = col.name.trim()
    if (!cleanName) {
      throw new Error('Every column must have a valid non-empty name.')
    }
    if (!isSafeDdlIdentifierValue(cleanName)) {
      throw new Error(`Column "${cleanName}" contains invalid SQL characters.`)
    }
    const lower = cleanName.toLowerCase()
    if (seenNames.has(lower)) {
      throw new Error(`Duplicate column name "${cleanName}".`)
    }
    seenNames.add(lower)
  }

  const safetyErrors = collectSqliteMigrationSafetyErrors(draft, dialect, true)
  if (safetyErrors.length > 0) {
    throw new Error(safetyErrors[0])
  }

  const colRenameMap = new Map<string, string>()
  for (const col of activeCols) {
    const nextName = col.name.trim()
    colRenameMap.set(nextName.toLowerCase(), nextName)
  }
  for (const col of activeCols) {
    if (col.status === 'existing' && col.originalName) {
      colRenameMap.set(col.originalName.trim().toLowerCase(), col.name.trim())
    }
  }

  const pkCols = activeCols.filter((c) => c.isPrimaryKey)
  const singleInlinePk = pkCols.length === 1
  const colDefs: string[] = []

  for (const col of activeCols) {
    const quotedCol = quoteIdentForDialect(col.name.trim(), dialect)
    const cleanType = validateColumnTypeSpec(col.dataType || 'TEXT')
    if (col.isGenerated) {
      const genExpr = validateRawDdlExpression(
        col.generatedExpression || '',
        `Generated column "${col.name}" expression`
      )
      const genStorage = col.generatedStorage === 'STORED' ? 'STORED' : 'VIRTUAL'
      let def = `${quotedCol} ${cleanType} GENERATED ALWAYS AS (${genExpr}) ${genStorage}`
      if (!col.nullable) {
        def += ' NOT NULL'
      }
      if (col.collate) {
        def += formatSqliteCollationClause(col.collate, dialect)
      }
      colDefs.push(def)
      continue
    }
    const useSqliteAutoInc = Boolean(
      singleInlinePk &&
        col.isPrimaryKey &&
        col.isAutoIncrement &&
        !draft.withoutRowid &&
        /INT/i.test(cleanType)
    )
    const effectiveType = useSqliteAutoInc ? 'INTEGER' : cleanType
    let def = `${quotedCol} ${effectiveType}`
    if (singleInlinePk && col.isPrimaryKey) {
      def += ' PRIMARY KEY'
      if (useSqliteAutoInc) {
        def += ' AUTOINCREMENT'
      }
    }
    // Only `INTEGER PRIMARY KEY` on a rowid table is implicitly NOT NULL in SQLite.
    // Non-INTEGER PKs (TEXT/BLOB/BIGINT) and WITHOUT ROWID PKs must retain explicit NOT NULL.
    const isImplicitNotNullRowidPk =
      singleInlinePk &&
      col.isPrimaryKey &&
      !draft.withoutRowid &&
      effectiveType.trim().toUpperCase() === 'INTEGER'
    if (!col.nullable && !isImplicitNotNullRowidPk) {
      def += ' NOT NULL'
    }
    const rawDef = (col.defaultValue ?? '').trim()
    if (rawDef.length > 0) {
      def += ` DEFAULT ${normalizeMigrationDefaultExpression(rawDef, effectiveType, dialect)}`
    } else if (col.status === 'new' && !col.nullable && !useSqliteAutoInc) {
      def += /INT|REAL|FLOAT|NUMERIC|DECIMAL|BOOL/i.test(effectiveType)
        ? ' DEFAULT 0'
        : " DEFAULT ''"
    }
    if (col.collate) {
      def += formatSqliteCollationClause(col.collate, dialect)
    }
    colDefs.push(def)
  }

  if (pkCols.length > 1) {
    const pkList = pkCols.map((c) => quoteIdentForDialect(c.name.trim(), dialect)).join(', ')
    colDefs.push(`PRIMARY KEY (${pkList})`)
  }

  // Re-emit surviving table-level UNIQUE constraints (origin === 'u' or unique sqlite_autoindex_*)
  const seenUniqueConstraintSigs = new Set<string>()
  for (const idx of draft.indexes) {
    const isUniqueTableConstraint =
      idx.status !== 'deleted' &&
      !idx.isPrimary &&
      (idx.origin === 'u' || (idx.unique && /^sqlite_autoindex_/i.test(idx.name)))
    if (!isUniqueTableConstraint) continue
    const rawSpecs: Array<{ name: string; collate?: string; desc?: boolean }> =
      Array.isArray(idx.columnSpecs) && idx.columnSpecs.length > 0
        ? idx.columnSpecs
        : (idx.columns || []).map((name): { name: string } => ({ name }))
    const mappedSpecs = rawSpecs
      .map((spec) => {
        const trimmed = (spec.name || '').trim()
        const mappedName =
          colRenameMap.get(trimmed.toLowerCase()) ||
          (seenNames.has(trimmed.toLowerCase()) ? trimmed : '')
        if (!mappedName) return null
        return {
          name: mappedName,
          ...(spec.collate ? { collate: spec.collate } : {}),
          ...(spec.desc ? { desc: true } : {}),
        }
      })
      .filter((s): s is { name: string; collate?: string; desc?: boolean } => s !== null)
    if (mappedSpecs.length === 0) continue
    const conflictClause = formatSqliteOnConflictClause(idx.onConflict)
    const sig =
      mappedSpecs
        .map(
          (s) =>
            `${s.name.toLowerCase()}:${(s.collate || '').toUpperCase()}:${s.desc ? 'DESC' : 'ASC'}`
        )
        .join('\0') + `\0${conflictClause}`
    if (seenUniqueConstraintSigs.has(sig)) continue
    seenUniqueConstraintSigs.add(sig)
    const formattedUniqueCols = mappedSpecs
      .map((s) => formatSqliteIndexColumnSpec(s, dialect))
      .join(', ')
    colDefs.push(`UNIQUE (${formattedUniqueCols})${conflictClause}`)
  }

  const activeFks = draft.foreignKeys.filter((fk) => fk.status !== 'deleted')
  const remappedFks: GroupedForeignKeyInput[] = []
  const origTableLower = origTable.toLowerCase()
  const draftSchemaLower = cleanSchema.toLowerCase()
  for (const fk of activeFks) {
    const rawCol = (fk.column || '').trim()
    const rawRefTable = (fk.foreignTable || '').trim()
    const rawRefCol = (fk.foreignColumn || '').trim()
    const rawCname = (fk.constraintName || '').trim()
    const rawRefSchema = (fk.foreignSchema || '').trim()
    if (!rawCol || !rawRefTable || !rawRefCol) {
      throw new Error('Foreign key requires local column, target table, and target column.')
    }
    if (
      (rawCname && !isSafeDdlIdentifierValue(rawCname)) ||
      !isSafeDdlIdentifierValue(rawCol) ||
      !isSafeDdlIdentifierValue(rawRefTable) ||
      !isSafeDdlIdentifierValue(rawRefCol) ||
      (rawRefSchema && !isSafeDdlIdentifierValue(rawRefSchema))
    ) {
      throw new Error('Foreign key contains invalid SQL identifier characters.')
    }
    const mappedLocalCol = colRenameMap.get(rawCol.toLowerCase())
    if (!mappedLocalCol) {
      throw new Error(
        `Foreign key "${rawCname || rawCol}" references dropped or missing column "${rawCol}".`
      )
    }
    const isSameSchemaSelfRef =
      rawRefTable.toLowerCase() === origTableLower &&
      (!rawRefSchema || rawRefSchema.toLowerCase() === draftSchemaLower)
    const mappedRefTable = isSameSchemaSelfRef ? finalTable : rawRefTable
    const mappedRefCol = isSameSchemaSelfRef
      ? colRenameMap.get(rawRefCol.toLowerCase())
      : rawRefCol
    if (!mappedRefCol) {
      throw new Error(
        `Self-referencing foreign key "${rawCname || rawCol}" references dropped column "${rawRefCol}".`
      )
    }
    remappedFks.push({
      constraintName: fk.constraintName,
      column: mappedLocalCol,
      referencedTable: mappedRefTable,
      referencedSchema: fk.foreignSchema,
      referencedColumn: mappedRefCol,
      onDelete: fk.onDelete,
      onUpdate: fk.onUpdate,
    })
  }
  colDefs.push(...formatGroupedForeignKeyLines(remappedFks, dialect, finalTable, '', true))

  if (Array.isArray(draft.checkConstraints)) {
    for (const chk of draft.checkConstraints) {
      const trimmedChk = (chk || '').trim()
      if (trimmedChk) {
        colDefs.push(
          validateRawDdlExpression(trimmedChk, 'CHECK constraint', { requireCheckWrapper: true })
        )
      }
    }
  }

  const tempTableName = `__datanoa_new_${origTable.replace(/[^A-Za-z0-9_]/g, '_')}`
  const qualifiedOrig = qualifyAlterTarget(origTable, draft.schema, dialect)
  const qualifiedTemp = qualifyAlterTarget(tempTableName, draft.schema, dialect)
  const quotedFinal = quoteIdentForDialect(finalTable, dialect)

  const tableOptions = [
    draft.withoutRowid ? 'WITHOUT ROWID' : '',
    draft.strict ? 'STRICT' : '',
  ]
    .filter(Boolean)
    .join(', ')
  const tableOptionsSuffix = tableOptions ? ` ${tableOptions}` : ''
  const createTempStmt = `CREATE TABLE ${qualifiedTemp} (\n  ${colDefs.join(',\n  ')}\n)${tableOptionsSuffix};`

  const stmts: string[] =
    dialect === 'd1'
      ? ['PRAGMA defer_foreign_keys = ON;', createTempStmt]
      : [
          'PRAGMA foreign_keys = OFF;',
          'BEGIN IMMEDIATE;',
          'PRAGMA defer_foreign_keys = ON;',
          createTempStmt,
        ]

  // Map surviving existing non-generated columns from old table to new table
  const survivingCols = activeCols.filter(
    (c) => c.status === 'existing' && Boolean(c.originalName) && !c.isGenerated
  )
  if (survivingCols.length > 0) {
    const targetColList = survivingCols
      .map((c) => quoteIdentForDialect(c.name.trim(), dialect))
      .join(', ')
    const sourceExprList = survivingCols
      .map((c) => {
        const prevColName = (c.originalName ?? c.name).trim()
        const quotedOld = quoteIdentForDialect(prevColName, dialect)
        const rawDef = (c.defaultValue ?? '').trim()
        // If column became NOT NULL and has a default value, coalesce existing NULLs
        if (!c.nullable && c.originalNullable && rawDef.length > 0) {
          const normDef = normalizeSqlDefaultExpression(rawDef, c.dataType || 'TEXT')
          return `COALESCE(${quotedOld}, ${normDef}) AS ${quoteIdentForDialect(c.name.trim(), dialect)}`
        }
        return quotedOld
      })
      .join(', ')
    stmts.push(
      `INSERT INTO ${qualifiedTemp} (${targetColList}) SELECT ${sourceExprList} FROM ${qualifiedOrig};`
    )
  }

  stmts.push(`DROP TABLE ${qualifiedOrig};`)
  stmts.push(`ALTER TABLE ${qualifiedTemp} RENAME TO ${quotedFinal};`)

  // Recreate surviving & new user indexes on the rebuilt table
  const activeIndexes = draft.indexes.filter(
    (idx) =>
      idx.status !== 'deleted' &&
      !idx.isPrimary &&
      idx.origin !== 'u' &&
      !/^sqlite_autoindex_/i.test(idx.name)
  )

  for (const idx of activeIndexes) {
    const rawSpecs: Array<{ name: string; collate?: string; desc?: boolean }> =
      Array.isArray(idx.columnSpecs) && idx.columnSpecs.length > 0
        ? idx.columnSpecs
        : (idx.columns || []).map((name): { name: string } => ({ name }))
    const mappedSpecs = rawSpecs
      .map((spec) => {
        const trimmed = (spec.name || '').trim()
        const mappedName =
          colRenameMap.get(trimmed.toLowerCase()) ||
          (seenNames.has(trimmed.toLowerCase()) ? trimmed : '')
        if (!mappedName) return null
        return {
          name: mappedName,
          ...(spec.collate ? { collate: spec.collate } : {}),
          ...(spec.desc ? { desc: true } : {}),
        }
      })
      .filter((s): s is { name: string; collate?: string; desc?: boolean } => s !== null)
    if (mappedSpecs.length === 0) continue
    const idxName =
      (idx.name || '').trim() ||
      `idx_${finalTable}_${mappedSpecs.map((s) => s.name).join('_')}`.replace(/[^A-Za-z0-9_]/g, '_')
    if (!isSafeDdlIdentifierValue(idxName)) {
      throw new Error(`Index "${idxName}" contains invalid SQL identifier characters.`)
    }
    const uniqueKw = idx.unique ? 'UNIQUE ' : ''
    const quotedCols = mappedSpecs
      .map((s) => formatSqliteIndexColumnSpec(s, dialect))
      .join(', ')
    const qualifiedIdx = qualifyAlterTarget(idxName, draft.schema, dialect)
    const whereSuffix =
      typeof idx.whereClause === 'string' && idx.whereClause.trim().length > 0
        ? ` WHERE ${validateRawDdlExpression(idx.whereClause, `Partial index "${idxName}" WHERE clause`)}`
        : ''
    stmts.push(
      `CREATE ${uniqueKw}INDEX IF NOT EXISTS ${qualifiedIdx} ON ${quotedFinal} (${quotedCols})${whereSuffix};`
    )
  }

  if (Array.isArray(draft.triggers)) {
    for (const trg of draft.triggers) {
      const rewritten = rewriteSqliteTriggerTargetTable(
        trg?.sql || '',
        origTable,
        finalTable,
        dialect
      )
      if (rewritten) {
        stmts.push(rewritten)
      }
    }
  }

  stmts.push(SQLITE_FK_CHECK_ABORT_SQL)
  if (dialect !== 'd1') {
    stmts.push('COMMIT;')
    stmts.push('PRAGMA foreign_keys = ON;')
  }
  return stmts
}

export function buildTableMigrationSql(
  draft: TableStructureDraft,
  dialect: DatabaseDriverType = 'sqlite'
): string[] {
  if (dialect === 'redis') {
    throw new Error('Table schema migration is not supported on Redis keyspaces.')
  }

  const origTable = (draft.originalTableName || '').trim()
  const finalTable = (draft.tableName || origTable).trim()
  if (!origTable || !finalTable) {
    throw new Error('Table name is required.')
  }

  if (countTableStructureChanges(draft) === 0) {
    return []
  }

  // Enforce unique non-empty column names across ALL active columns in ALL dialects
  const activeCols = draft.columns.filter((c) => c.status !== 'deleted')
  if (activeCols.length === 0) {
    throw new Error('Table must keep at least one active column.')
  }
  const seenColNames = new Set<string>()
  for (const col of activeCols) {
    const cleanName = (col.name || '').trim()
    if (!cleanName) {
      throw new Error('Every column must have a non-empty name.')
    }
    const lower = cleanName.toLowerCase()
    if (seenColNames.has(lower)) {
      throw new Error(`Duplicate column name "${cleanName}".`)
    }
    seenColNames.add(lower)
  }

  const isSqliteFamily = dialect === 'sqlite' || dialect === 'libsql' || dialect === 'd1'
  const needsRebuild = isSqliteFamily && requiresSqliteTableRebuild(draft)
  if (isSqliteFamily) {
    const safetyErrors = collectSqliteMigrationSafetyErrors(draft, dialect, needsRebuild)
    if (safetyErrors.length > 0) {
      throw new Error(safetyErrors[0])
    }
  }

  // Check if SQLite/LibSQL requires full 12-step atomic rebuild
  if (needsRebuild) {
    return buildSqliteTableRebuildStatements(draft, dialect)
  }

  const stmts: string[] = []
  let workingTable = origTable

  // 1. Drop removed Foreign Keys
  for (const fk of draft.foreignKeys) {
    if (fk.status === 'deleted' && fk.constraintName) {
      stmts.push(
        buildAlterTableSql(
          {
            kind: 'dropForeignKey',
            table: workingTable,
            schema: draft.schema,
            constraintName: fk.constraintName,
          },
          dialect
        )
      )
    }
  }

  // 2. Drop removed Indexes
  for (const idx of draft.indexes) {
    if (idx.status === 'deleted' && (idx.originalName || idx.name)) {
      stmts.push(
        buildAlterTableSql(
          {
            kind: 'dropIndex',
            table: workingTable,
            schema: draft.schema,
            indexName: idx.originalName || idx.name,
          },
          dialect
        )
      )
    }
  }

  const pkMembershipChanged =
    draft.columns.some((col) => col.status === 'new' && col.isPrimaryKey) ||
    draft.columns.some((col) => col.status === 'deleted' && col.originalIsPrimaryKey) ||
    draft.columns.some(
      (col) => col.status === 'existing' && Boolean(col.isPrimaryKey) !== Boolean(col.originalIsPrimaryKey)
    )
  const hadOrigPk = draft.columns.some((c) => c.status !== 'new' && c.originalIsPrimaryKey)

  if (pkMembershipChanged && dialect === 'clickhouse') {
    throw new Error('Modifying PRIMARY KEY columns in place is not supported on ClickHouse.')
  }

  // 2.5 Drop existing Primary Key BEFORE dropping columns (avoids MSSQL Msg 5074 / Oracle ORA-12991)
  if (pkMembershipChanged && hadOrigPk) {
    const qTbl = qualifyAlterTarget(workingTable, draft.schema, dialect)
    if (dialect === 'postgres' || dialect === 'cockroachdb') {
      const pkIdx = draft.indexes.find((i) => i.isPrimary)
      const pkConstraint = pkIdx?.name || `${workingTable}_pkey`
      stmts.push(
        `ALTER TABLE ${qTbl} DROP CONSTRAINT IF EXISTS ${quoteIdentForDialect(pkConstraint, dialect)};`
      )
    } else if (dialect === 'mysql' || dialect === 'mariadb') {
      stmts.push(`ALTER TABLE ${qTbl} DROP PRIMARY KEY;`)
    } else if (dialect === 'mssql') {
      const pkIdx = draft.indexes.find((i) => i.isPrimary)
      const pkConstraint = pkIdx?.name || `PK_${workingTable}`
      stmts.push(
        `ALTER TABLE ${qTbl} DROP CONSTRAINT ${quoteIdentForDialect(pkConstraint, dialect)};`
      )
    } else if (dialect === 'oracle') {
      const pkIdx = draft.indexes.find((i) => i.isPrimary)
      const pkConstraint = pkIdx?.name
      stmts.push(
        pkConstraint
          ? `ALTER TABLE ${qTbl} DROP CONSTRAINT ${quoteIdentForDialect(pkConstraint, dialect)};`
          : `ALTER TABLE ${qTbl} DROP PRIMARY KEY;`
      )
    }
  }

  // 3. Drop removed Columns
  let mssqlDefaultDropSeq = 0
  for (const col of draft.columns) {
    if (col.status === 'deleted' && (col.originalName || col.name)) {
      const origDef = (col.originalDefaultValue ?? '').trim()
      stmts.push(
        buildAlterTableSql(
          {
            kind: 'dropColumn',
            table: workingTable,
            schema: draft.schema,
            columnName: col.originalName || col.name,
            ...(dialect === 'mssql'
              ? {
                  previousDefaultValue: origDef,
                  defaultDropSeq: ++mssqlDefaultDropSeq,
                }
              : {}),
          },
          dialect
        )
      )
    }
  }

  // 4a. Rename Existing Columns in safe dependency order (chains & cycles never collide)
  const pendingRenames: Array<{ oldName: string; newName: string }> = []
  for (const col of draft.columns) {
    if (col.status !== 'existing') continue
    const oldName = (col.originalName || col.name).trim()
    const newName = col.name.trim()
    if (!newName) {
      throw new Error('Column name cannot be empty.')
    }
    if (oldName !== newName) {
      pendingRenames.push({ oldName, newName })
    }
  }
  if (pendingRenames.length > 0) {
    const remaining = [...pendingRenames]
    const occupied = new Set<string>(
      draft.columns
        .filter((c) => c.status === 'existing')
        .map((c) => (c.originalName || c.name).trim().toLowerCase())
    )
    let tmpCounter = 0
    while (remaining.length > 0) {
      let progressed = false
      for (let idx = 0; idx < remaining.length; idx++) {
        const pair = remaining[idx]
        const targetLower = pair.newName.toLowerCase()
        const oldLower = pair.oldName.toLowerCase()
        if (!occupied.has(targetLower) || targetLower === oldLower) {
          stmts.push(
            buildAlterTableSql(
              {
                kind: 'renameColumn',
                table: workingTable,
                schema: draft.schema,
                oldColumnName: pair.oldName,
                newColumnName: pair.newName,
              },
              dialect
            )
          )
          occupied.delete(oldLower)
          occupied.add(targetLower)
          remaining.splice(idx, 1)
          progressed = true
          break
        }
      }
      if (!progressed) {
        // Break rename cycle using a unique temporary column name
        const first = remaining[0]
        let tmpName = `__datanoa_tmp_col_${++tmpCounter}`
        while (occupied.has(tmpName.toLowerCase())) {
          tmpName = `__datanoa_tmp_col_${++tmpCounter}`
        }
        stmts.push(
          buildAlterTableSql(
            {
              kind: 'renameColumn',
              table: workingTable,
              schema: draft.schema,
              oldColumnName: first.oldName,
              newColumnName: tmpName,
            },
            dialect
          )
        )
        occupied.delete(first.oldName.toLowerCase())
        occupied.add(tmpName.toLowerCase())
        first.oldName = tmpName
      }
    }
  }

  // 4b. Alter Existing Columns
  for (const col of draft.columns) {
    if (col.status !== 'existing') continue
    const newName = col.name.trim()
    const origType = (col.originalDataType ?? 'TEXT').trim().toUpperCase()
    const curType = validateColumnTypeSpec(col.dataType || 'TEXT').toUpperCase()
    const origDef = (col.originalDefaultValue ?? '').trim()
    const curDef = (col.defaultValue ?? '').trim()
    const isDefEqual = areDefaultsEquivalent(origDef, curDef, curType, dialect)
    const typeChanged = origType !== curType
    const nullChanged = Boolean(col.originalNullable) !== Boolean(col.nullable)
    const defChanged = !isDefEqual

    if (typeChanged || nullChanged || defChanged) {
      const requiresFullColumnType =
        dialect === 'mysql' ||
        dialect === 'mariadb' ||
        dialect === 'clickhouse'
      const mssqlTypeOrNull = dialect === 'mssql' && (typeChanged || nullChanged)
      const needsMssqlDefaultDrop =
        dialect === 'mssql' && (defChanged || (origDef.length > 0 && typeChanged))
      stmts.push(
        buildAlterTableSql(
          {
            kind: 'alterColumn',
            table: workingTable,
            schema: draft.schema,
            columnName: newName,
            dataType:
              typeChanged || requiresFullColumnType || mssqlTypeOrNull
                ? col.dataType.trim()
                : undefined,
            nullable:
              nullChanged || requiresFullColumnType || mssqlTypeOrNull ? col.nullable : undefined,
            ...(dialect === 'oracle' ? { previousNullable: Boolean(col.originalNullable) } : {}),
            ...(dialect === 'mysql' || dialect === 'mariadb'
              ? { isAutoIncrement: Boolean(col.isAutoIncrement) }
              : {}),
            defaultValue: defChanged || requiresFullColumnType ? curDef : undefined,
            ...(needsMssqlDefaultDrop
              ? { previousDefaultValue: origDef, defaultDropSeq: ++mssqlDefaultDropSeq }
              : dialect === 'oracle' && defChanged
                ? { previousDefaultValue: origDef }
                : {}),
          },
          dialect
        )
      )
    }
  }

  // 5. Add New Columns
  for (const col of draft.columns) {
    if (col.status === 'new') {
      stmts.push(
        buildAlterTableSql(
          {
            kind: 'addColumn',
            table: workingTable,
            schema: draft.schema,
            columnName: col.name.trim(),
            dataType: validateColumnTypeSpec(col.dataType || 'TEXT'),
            nullable: col.nullable,
            defaultValue: col.defaultValue,
          },
          dialect
        )
      )
    }
  }

  // 6. Add new Primary Key constraint (after DROP PK, DROP COLUMN, ALTER COLUMN, ADD COLUMN)
  if (pkMembershipChanged) {
    const nextPkCols = activeCols
      .filter((c) => c.isPrimaryKey)
      .map((c) => quoteIdentForDialect(c.name.trim(), dialect))
    if (nextPkCols.length > 0) {
      const qTbl = qualifyAlterTarget(workingTable, draft.schema, dialect)
      stmts.push(`ALTER TABLE ${qTbl} ADD PRIMARY KEY (${nextPkCols.join(', ')});`)
    }
  }

  // 7. Add New Indexes
  for (const idx of draft.indexes) {
    if (idx.status === 'new') {
      stmts.push(
        buildAlterTableSql(
          {
            kind: 'addIndex',
            table: workingTable,
            schema: draft.schema,
            indexName: idx.name.trim(),
            columns: idx.columns,
            unique: idx.unique,
          },
          dialect
        )
      )
    }
  }

  // 8. Add New Foreign Keys
  for (const fk of draft.foreignKeys) {
    if (fk.status === 'new') {
      stmts.push(
        buildAlterTableSql(
          {
            kind: 'addForeignKey',
            table: workingTable,
            schema: draft.schema,
            constraintName: fk.constraintName,
            column: fk.column,
            foreignTable: fk.foreignTable,
            foreignSchema: fk.foreignSchema,
            foreignColumn: fk.foreignColumn,
            onDelete: fk.onDelete,
            onUpdate: fk.onUpdate,
          },
          dialect
        )
      )
    }
  }

  // 9. Rename Table last so all column/index/FK operations target the known table name
  if (finalTable !== workingTable) {
    if (dialect === 'sqlite' || dialect === 'libsql' || dialect === 'd1') {
      stmts.push(...buildRenameTableStatements(workingTable, finalTable, draft.schema, dialect))
    } else {
      stmts.push(
        buildAlterTableSql(
          {
            kind: 'renameTable',
            table: workingTable,
            schema: draft.schema,
            newTableName: finalTable,
          },
          dialect
        )
      )
    }
    workingTable = finalTable
  }

  return stmts
}

export function validateTableStructureDraft(
  draft: TableStructureDraft,
  dialect: DatabaseDriverType = 'sqlite',
  availableTables: string[] = []
): TableMigrationPlan {
  const errors: string[] = []
  const warnings: string[] = []
  const changeSummaries: string[] = []

  const origTable = (draft.originalTableName || '').trim()
  const nextTable = (draft.tableName || '').trim()
  const schemaName = (draft.schema ?? '').trim()
  if (schemaName && !isSafeDdlIdentifierValue(schemaName)) {
    errors.push('Schema name contains invalid characters.')
  }
  if (!nextTable) {
    errors.push('Table name cannot be empty.')
  } else if (!isSafeDdlIdentifierValue(nextTable)) {
    errors.push('Table name contains invalid characters.')
  } else if (nextTable !== origTable) {
    changeSummaries.push(`Rename table: "${origTable}" -> "${nextTable}"`)
    warnings.push(`Renaming "${origTable}" to "${nextTable}" may break saved SQL queries referencing the old name.`)
  }

  const activeCols = draft.columns.filter((c) => c.status !== 'deleted')
  if (activeCols.length === 0) {
    errors.push('Table must have at least one remaining column.')
  }

  const seenCols = new Map<string, number>()
  for (const col of draft.columns) {
    const colLabel = (col.name || col.originalName || '(unnamed)').trim()
    if (col.status === 'deleted') {
      const targetName = (col.originalName || col.name).trim()
      changeSummaries.push(`- Drop column "${targetName}"`)
      warnings.push(`Dropping column "${targetName}" permanently destroys all data stored in it.`)
      continue
    }

    const cleanName = (col.name || '').trim()
    if (!cleanName) {
      errors.push('Column name cannot be empty.')
    } else if (!isSafeDdlIdentifierValue(cleanName)) {
      errors.push(`Column "${cleanName}" contains invalid SQL characters.`)
    } else {
      const key = cleanName.toLowerCase()
      const count = (seenCols.get(key) ?? 0) + 1
      seenCols.set(key, count)
      if (count === 2) {
        errors.push(`Duplicate column name "${cleanName}". Each column must have a unique name.`)
      }
    }

    try {
      validateColumnTypeSpec(col.dataType || '')
    } catch (err: unknown) {
      errors.push(err instanceof Error ? err.message : `Invalid type on column "${colLabel}".`)
    }

    if (col.isGenerated && col.generatedExpression?.trim()) {
      try {
        validateRawDdlExpression(col.generatedExpression, `Generated column "${colLabel}" expression`)
      } catch (err: unknown) {
        errors.push(
          err instanceof Error ? err.message : `Invalid generated expression on column "${colLabel}".`
        )
      }
    }

    const rawDef = (col.defaultValue ?? '').trim()
    const origDef = (col.originalDefaultValue ?? '').trim()
    const isUntouchedExistingDefault =
      col.status === 'existing' &&
      rawDef === origDef &&
      (col.dataType ?? '').trim().toUpperCase() === (col.originalDataType ?? '').trim().toUpperCase()
    if (rawDef.length > 0 && !isUntouchedExistingDefault) {
      try {
        normalizeMigrationDefaultExpression(rawDef, col.dataType || 'TEXT', dialect)
      } catch (err: unknown) {
        errors.push(err instanceof Error ? err.message : `Invalid default on column "${colLabel}".`)
      }
    }

    if (col.status === 'new') {
      const defSummary = rawDef.length > 0 ? ` DEFAULT ${rawDef}` : ''
      changeSummaries.push(
        `+ Add column "${cleanName || '(unnamed)'}" ${col.dataType || 'TEXT'}${col.nullable ? '' : ' NOT NULL'}${defSummary}`
      )
      if (!col.nullable && rawDef.length === 0 && (dialect === 'sqlite' || dialect === 'libsql' || dialect === 'd1')) {
        warnings.push(`Adding NOT NULL column "${cleanName}" without default auto-fills '' / 0 on SQLite.`)
      }
    } else if (isDraftColumnDirty(col)) {
      const diffs: string[] = []
      const origName = (col.originalName ?? '').trim()
      if (origName !== cleanName) diffs.push(`name "${origName}" -> "${cleanName}"`)
      if ((col.originalDataType ?? '').trim().toUpperCase() !== (col.dataType ?? '').trim().toUpperCase()) {
        diffs.push(`type ${col.originalDataType ?? 'TEXT'} -> ${col.dataType}`)
      }
      if (Boolean(col.originalIsPrimaryKey) !== Boolean(col.isPrimaryKey)) {
        diffs.push(`PK ${col.originalIsPrimaryKey ? 'YES' : 'NO'} -> ${col.isPrimaryKey ? 'YES' : 'NO'}`)
        warnings.push(`Changing Primary Key on "${cleanName}" alters row identity constraints.`)
      }
      if (Boolean(col.originalNullable) !== Boolean(col.nullable)) {
        diffs.push(`${col.originalNullable ? 'NULL' : 'NOT NULL'} -> ${col.nullable ? 'NULL' : 'NOT NULL'}`)
        if (!col.nullable && col.originalNullable && rawDef.length === 0) {
          warnings.push(`Setting "${cleanName}" to NOT NULL without a default fails if existing rows contain NULL.`)
        }
      }
      if (!areDefaultsEquivalent(origDef, rawDef, col.dataType || 'TEXT', dialect)) {
        diffs.push(`default ${origDef || 'NULL'} -> ${rawDef || 'NULL'}`)
      }
      changeSummaries.push(`~ Modify column "${cleanName || origName}": ${diffs.join(', ')}`)
    }
  }

  if (Array.isArray(draft.checkConstraints)) {
    for (const chk of draft.checkConstraints) {
      const trimmedChk = (chk || '').trim()
      if (!trimmedChk) continue
      try {
        validateRawDdlExpression(trimmedChk, 'CHECK constraint', { requireCheckWrapper: true })
      } catch (err: unknown) {
        errors.push(err instanceof Error ? err.message : 'Invalid CHECK constraint.')
      }
    }
  }

  const activeColSet = new Set(activeCols.map((c) => c.name.trim()).filter(Boolean))
  const activeColOrOrigLowerSet = new Set<string>()
  for (const col of activeCols) {
    const cur = (col.name || '').trim()
    if (cur) activeColOrOrigLowerSet.add(cur.toLowerCase())
    if (col.status === 'existing' && col.originalName?.trim()) {
      activeColOrOrigLowerSet.add(col.originalName.trim().toLowerCase())
    }
  }
  const seenIdx = new Map<string, number>()
  for (const idx of draft.indexes) {
    const idxName = (idx.name || '').trim()
    if (idx.status === 'deleted') {
      changeSummaries.push(`- Drop index "${idx.originalName || idxName}"`)
      warnings.push(`Dropping index "${idx.originalName || idxName}" removes query index optimization / uniqueness check.`)
      continue
    }
    if (idxName && !isSafeDdlIdentifierValue(idxName)) {
      errors.push(`Index name "${idxName}" contains invalid SQL characters.`)
    }
    if (typeof idx.whereClause === 'string' && idx.whereClause.trim().length > 0) {
      try {
        validateRawDdlExpression(idx.whereClause, `Index "${idxName || 'partial'}" WHERE clause`)
      } catch (err: unknown) {
        errors.push(err instanceof Error ? err.message : `Invalid WHERE clause on index "${idxName}".`)
      }
    }
    const count = (seenIdx.get(idxName.toLowerCase()) ?? 0) + 1
    seenIdx.set(idxName.toLowerCase(), count)
    if (idx.status === 'new') {
      if (!idxName) {
        errors.push('New index must have a name.')
      } else if (count === 2) {
        errors.push(`Duplicate index name "${idxName}".`)
      }
      if (!idx.columns || idx.columns.length === 0) {
        errors.push(`Index "${idxName || 'new'}" must include at least one column.`)
      } else {
        const missing = idx.columns.filter((c) => !activeColSet.has(c))
        if (missing.length > 0) {
          errors.push(`Index "${idxName}" references missing/dropped column(s): ${missing.join(', ')}.`)
        }
      }
      changeSummaries.push(
        `+ Create ${idx.unique ? 'UNIQUE ' : ''}index "${idxName}" (${(idx.columns || []).join(', ')})`
      )
    }
  }

  const knownTableSet = new Set(availableTables.map((t) => t.trim().toLowerCase()).filter(Boolean))
  for (const fk of draft.foreignKeys) {
    if (fk.status === 'deleted') {
      changeSummaries.push(`- Drop Foreign Key "${fk.constraintName || fk.column}"`)
      warnings.push(`Dropping Foreign Key "${fk.constraintName || fk.column}" disables referential integrity checking.`)
      continue
    }
    const col = (fk.column || '').trim()
    const refTbl = (fk.foreignTable || '').trim()
    const refCol = (fk.foreignColumn || '').trim()
    const cname = (fk.constraintName || '').trim()
    const refSchema = (fk.foreignSchema || '').trim()
    if (
      (cname && !isSafeDdlIdentifierValue(cname)) ||
      (col && !isSafeDdlIdentifierValue(col)) ||
      (refTbl && !isSafeDdlIdentifierValue(refTbl)) ||
      (refCol && !isSafeDdlIdentifierValue(refCol)) ||
      (refSchema && !isSafeDdlIdentifierValue(refSchema))
    ) {
      errors.push(`Foreign Key "${cname || col || '(unnamed)'}" contains invalid SQL characters.`)
    }
    if (fk.status === 'existing') {
      if (col && !activeColOrOrigLowerSet.has(col.toLowerCase())) {
        errors.push(
          `Foreign Key "${cname || col}" references dropped column "${col}". Delete the Foreign Key before dropping this column.`
        )
      }
      if (
        origTable &&
        refTbl.toLowerCase() === origTable.toLowerCase() &&
        refCol &&
        !activeColOrOrigLowerSet.has(refCol.toLowerCase())
      ) {
        errors.push(
          `Self-referencing Foreign Key "${cname || col}" references dropped column "${refCol}".`
        )
      }
      continue
    }
    if (fk.status === 'new') {
      if (!col || !activeColSet.has(col)) {
        errors.push(`Foreign Key local column "${col || '(none)'}" does not exist among active columns.`)
      }
      if (!refTbl) {
        errors.push('Foreign Key target table is required.')
      } else if (knownTableSet.size > 0 && !knownTableSet.has(refTbl.toLowerCase())) {
        errors.push(`Foreign Key target table "${refTbl}" was not found in this connection.`)
      }
      if (!refCol) {
        errors.push('Foreign Key target column is required.')
      }
      if (dialect === 'clickhouse') {
        errors.push('ClickHouse does not support FOREIGN KEY constraints.')
      }
      changeSummaries.push(
        `+ Add Foreign Key "${col}" -> "${refTbl}"("${refCol}") ON DELETE ${sanitizeReferentialAction(fk.onDelete)}`
      )
    }
  }

  const isRebuild =
    (dialect === 'sqlite' || dialect === 'libsql' || dialect === 'd1') &&
    countTableStructureChanges(draft) > 0 &&
    requiresSqliteTableRebuild(draft)

  if (isRebuild) {
    if (dialect === 'd1') {
      warnings.push(
        'Cloudflare D1 12-Step Table Rebuild executes in one batched HTTP request using PRAGMA defer_foreign_keys = ON (not a local SQLite transaction).'
      )
    } else {
      warnings.push(
        'SQLite 12-Step Table Rebuild will recreate the table and migrate existing rows atomically inside a transaction.'
      )
    }
  }

  const sqliteSafetyErrors = collectSqliteMigrationSafetyErrors(draft, dialect, isRebuild)
  for (const safetyErr of sqliteSafetyErrors) {
    if (!errors.includes(safetyErr)) {
      errors.push(safetyErr)
    }
  }

  if (
    isRebuild &&
    sqliteSafetyErrors.length === 0 &&
    Array.isArray(draft.triggers) &&
    draft.triggers.length > 0 &&
    nextTable &&
    origTable &&
    nextTable !== origTable
  ) {
    for (const trg of draft.triggers) {
      const trgName = (trg?.name || 'trigger').trim()
      warnings.push(
        `Trigger "${trgName}" will be recreated on renamed table "${nextTable}".`
      )
    }
  }

  let statements: string[] = []
  if (errors.length === 0 && changeSummaries.length > 0) {
    try {
      statements = buildTableMigrationSql(draft, dialect)
    } catch (err: unknown) {
      errors.push(err instanceof Error ? err.message : String(err))
    }
  }

  return {
    valid: errors.length === 0 && changeSummaries.length > 0,
    errors,
    warnings,
    changeSummaries,
    statements,
    isRebuild,
  }
}

/**
 * Builds a validated, dialect-aware `CREATE TABLE` DDL statement from a visual table draft.
 */
export function buildCreateTableSql(
  draft: { tableName: string; schema?: string; columns: CreateTableColumnDraft[] },
  dialect: DatabaseDriverType
): string {
  if (dialect === 'redis') {
    throw new Error('CREATE TABLE is not supported on Redis keyspaces.')
  }
  const tableName = (draft.tableName ?? '').trim()
  if (!tableName) {
    throw new Error('Table name is required.')
  }
  if (FORBIDDEN_DEFAULT_TOKENS.test(tableName) || tableName.includes('\0')) {
    throw new Error('Table name contains invalid characters.')
  }
  const schemaName = (draft.schema ?? '').trim()
  if (schemaName && (FORBIDDEN_DEFAULT_TOKENS.test(schemaName) || schemaName.includes('\0'))) {
    throw new Error('Schema name contains invalid characters.')
  }
  if (!Array.isArray(draft.columns) || draft.columns.length === 0) {
    throw new Error('Table must have at least one column.')
  }

  const seenNames = new Set<string>()
  const normalizedCols = draft.columns.map((col) => {
    const cleanName = (col.name ?? '').trim()
    if (!cleanName) {
      throw new Error('Every column must have a non-empty name.')
    }
    if (FORBIDDEN_DEFAULT_TOKENS.test(cleanName) || cleanName.includes('\0')) {
      throw new Error(`Column "${cleanName}" contains invalid SQL characters.`)
    }
    const lower = cleanName.toLowerCase()
    if (seenNames.has(lower)) {
      throw new Error(`Duplicate column name "${cleanName}".`)
    }
    seenNames.add(lower)

    const cleanType = validateColumnTypeSpec(col.dataType)
    const rawDef = (col.defaultValue ?? '').trim()
    const normalizedDef = rawDef.length > 0 ? normalizeSqlDefaultExpression(rawDef, cleanType) : ''
    return {
      name: cleanName,
      dataType: cleanType,
      nullable: col.nullable !== false,
      defaultValue: normalizedDef,
      isPrimaryKey: Boolean(col.isPrimaryKey),
      isAutoIncrement: Boolean(col.isAutoIncrement),
    }
  })

  const isSqlite = dialect === 'sqlite' || dialect === 'libsql' || dialect === 'd1'
  const isMysql = dialect === 'mysql' || dialect === 'mariadb'
  const isPg = dialect === 'postgres' || dialect === 'cockroachdb'
  const isMssql = dialect === 'mssql'
  const isOracle = dialect === 'oracle'
  const isClickHouse = dialect === 'clickhouse'

  const pkCols = normalizedCols.filter((c) => c.isPrimaryKey)
  let inlinePkHandled = false
  const bodyLines: string[] = []

  for (const col of normalizedCols) {
    const useSqliteAutoInc =
      isSqlite &&
      col.isAutoIncrement &&
      col.isPrimaryKey &&
      pkCols.length === 1 &&
      /INT/i.test(col.dataType)

    const effectiveType = useSqliteAutoInc ? 'INTEGER' : col.dataType
    const parts: string[] = [quoteIdentForDialect(col.name, dialect), effectiveType]

    const emitsIdentity =
      ((isPg || isOracle) && col.isAutoIncrement && !/serial|identity/i.test(effectiveType)) ||
      (isMssql && col.isAutoIncrement && !/identity/i.test(effectiveType))

    if (useSqliteAutoInc) {
      parts.push('PRIMARY KEY AUTOINCREMENT')
      inlinePkHandled = true
    } else if ((isPg || isOracle) && col.isAutoIncrement && !/serial|identity/i.test(effectiveType)) {
      parts.push('GENERATED BY DEFAULT AS IDENTITY')
    } else if (isMssql && col.isAutoIncrement && !/identity/i.test(effectiveType)) {
      parts.push('IDENTITY(1,1)')
    }

    if (isOracle && !emitsIdentity && col.defaultValue.length > 0) {
      parts.push(`DEFAULT ${col.defaultValue}`)
    }

    if (!col.nullable && !useSqliteAutoInc) {
      parts.push('NOT NULL')
    }

    if (!isOracle && !emitsIdentity && col.defaultValue.length > 0) {
      parts.push(`DEFAULT ${col.defaultValue}`)
    }

    if (isMysql && col.isAutoIncrement) {
      parts.push('AUTO_INCREMENT')
    }

    bodyLines.push(`  ${parts.join(' ')}`)
  }

  if (pkCols.length > 0 && !inlinePkHandled && !isClickHouse) {
    const quotedPks = pkCols.map((c) => quoteIdentForDialect(c.name, dialect)).join(', ')
    bodyLines.push(`  PRIMARY KEY (${quotedPks})`)
  }

  const qualifiedTable = qualifyAlterTarget(tableName, schemaName || undefined, dialect)
  if (isClickHouse) {
    const orderBy =
      pkCols.length > 0
        ? `(${pkCols.map((c) => quoteIdentForDialect(c.name, dialect)).join(', ')})`
        : 'tuple()'
    return `CREATE TABLE ${qualifiedTable} (\n${bodyLines.join(',\n')}\n) ENGINE = MergeTree() ORDER BY ${orderBy};`
  }

  return `CREATE TABLE ${qualifiedTable} (\n${bodyLines.join(',\n')}\n);`
}

/**
 * Builds a dialect-aware `TRUNCATE TABLE` statement (`DELETE FROM` on SQLite/LibSQL).
 */
export function buildTruncateTableSql(
  table: string,
  dialect: DatabaseDriverType,
  schema?: string
): string {
  if (dialect === 'redis') {
    throw new Error('TRUNCATE TABLE is not supported on Redis keyspaces.')
  }
  const tableName = (table ?? '').trim()
  if (!tableName) {
    throw new Error('Table name is required.')
  }
  if (FORBIDDEN_DEFAULT_TOKENS.test(tableName) || tableName.includes('\0')) {
    throw new Error('Table name contains invalid characters.')
  }
  const schemaName = (schema ?? '').trim()
  if (schemaName && (FORBIDDEN_DEFAULT_TOKENS.test(schemaName) || schemaName.includes('\0'))) {
    throw new Error('Schema name contains invalid characters.')
  }
  const qualified = qualifyAlterTarget(tableName, schemaName || undefined, dialect)
  if (dialect === 'sqlite' || dialect === 'libsql' || dialect === 'd1') {
    return `DELETE FROM ${qualified};`
  }
  return `TRUNCATE TABLE ${qualified};`
}

/**
 * Builds a dialect-aware `DROP TABLE` or `DROP VIEW` statement.
 */
export function buildDropTableSql(
  table: string,
  kind: SchemaObjectKind,
  dialect: DatabaseDriverType,
  schema?: string,
  ifExists = false
): string {
  if (dialect === 'redis') {
    throw new Error('DROP TABLE/VIEW is not supported on Redis keyspaces.')
  }
  const tableName = (table ?? '').trim()
  if (!tableName) {
    throw new Error('Table or view name is required.')
  }
  if (FORBIDDEN_DEFAULT_TOKENS.test(tableName) || tableName.includes('\0')) {
    throw new Error('Table or view name contains invalid characters.')
  }
  const schemaName = (schema ?? '').trim()
  if (schemaName && (FORBIDDEN_DEFAULT_TOKENS.test(schemaName) || schemaName.includes('\0'))) {
    throw new Error('Schema name contains invalid characters.')
  }
  const targetKind = kind === 'view' ? 'VIEW' : 'TABLE'
  const existsClause = ifExists ? 'IF EXISTS ' : ''
  const qualified = qualifyAlterTarget(tableName, schemaName || undefined, dialect)
  return `DROP ${targetKind} ${existsClause}${qualified};`
}
