/**
 * test/e2e/harness/test-db-fixtures.ts
 *
 * Real SQLite database fixture generator using native Node 24 `node:sqlite` (`DatabaseSync`),
 * with strict Windows file locking teardown hygiene and realistic multi-dialect fixtures
 * for PostgreSQL and MySQL.
 */

import { DatabaseSync } from 'node:sqlite'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import type {
  TableDetails,
  SchemaObject,
  QueryResult,
  ConnectionProfile
} from './protocol-types.js'

export interface SqliteTestDatabase {
  db: DatabaseSync
  filePath?: string
  cleanup: () => void
}

/**
 * Rich E-Commerce & Boundary Fixture Schema SQL
 */
export const RICH_FIXTURE_SCHEMA_SQL = `
-- 1. Customers Table (Single PK, AutoIncrement, Unique Email, Unicode, JSON, Check Constraint)
CREATE TABLE customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  status TEXT DEFAULT 'active' CHECK(status IN ('active', 'inactive', 'suspended')),
  metadata JSON,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. Categories Table
CREATE TABLE categories (
  category_id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE
);

-- 3. Products Table (Text PK, Foreign Key, Numeric Types, Nullable)
CREATE TABLE products (
  sku TEXT PRIMARY KEY,
  category_id INTEGER,
  name TEXT NOT NULL,
  price REAL NOT NULL,
  stock INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  description TEXT,
  FOREIGN KEY (category_id) REFERENCES categories(category_id) ON DELETE SET NULL
);

-- 4. Orders Table
CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_number TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL,
  order_date DATETIME DEFAULT CURRENT_TIMESTAMP,
  total_amount REAL NOT NULL,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'completed', 'cancelled')),
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);

-- 5. Order Items Table (COMPOSITE PRIMARY KEY, Dual Foreign Keys)
CREATE TABLE order_items (
  order_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  product_sku TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL,
  PRIMARY KEY (order_id, item_id),
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  FOREIGN KEY (product_sku) REFERENCES products(sku)
);

-- 6. Audit Logs Table (NO PRIMARY KEY, relies on rowid, read-only inline editing)
CREATE TABLE audit_logs (
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  details TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 7. Types Matrix Table (Max Safe Integer, Real Floats, Blobs, Unicode, Nulls)
CREATE TABLE types_matrix (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  int_val INTEGER,
  real_val REAL,
  text_val TEXT,
  blob_val BLOB,
  json_val TEXT,
  null_val TEXT,
  unicode_val TEXT
);

-- 8. Special Identifiers Table (Escaped spaces, hyphens, reserved SQL keywords)
CREATE TABLE "special_order-items" (
  "order id" INTEGER PRIMARY KEY,
  "select" TEXT,
  "group by" TEXT,
  "from" TEXT
);

-- 9. View definition
CREATE VIEW v_customer_orders AS
SELECT 
  c.id AS customer_id,
  c.name AS customer_name,
  o.id AS order_id,
  o.order_number,
  o.total_amount,
  o.status AS order_status
FROM customers c
JOIN orders o ON c.id = o.customer_id;

-- Indexes
CREATE INDEX idx_products_category ON products(category_id);
CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE UNIQUE INDEX idx_customers_phone ON customers(phone) WHERE phone IS NOT NULL;
`

/**
 * Rich Seed Data SQL including Multi-Language Unicode and JSON
 */
export const RICH_FIXTURE_SEED_SQL = `
INSERT INTO customers (name, email, phone, metadata) VALUES
  ('Nguyễn Văn An', 'an.nguyen@example.com', '+84901234567', '{"tier": "gold", "preferences": {"newsletter": true}}'),
  ('佐藤 健 (Ken Sato)', 'ken.sato@example.jp', '+819012345678', '{"tier": "silver", "locale": "ja_JP"}'),
  ('John Doe 🚀', 'john.doe@example.com', NULL, '{"tier": "bronze"}');

INSERT INTO categories (name, slug) VALUES
  ('Electronics', 'electronics'),
  ('Books', 'books');

INSERT INTO products (sku, category_id, name, price, stock, is_active, description) VALUES
  ('PROD-001', 1, 'Mechanical Keyboard RGB', 129.99, 50, 1, 'Cherry MX Brown switches'),
  ('PROD-002', 1, 'Wireless Gaming Mouse', 79.50, 100, 1, '16000 DPI optical sensor'),
  ('PROD-003', 2, 'Designing Data-Intensive Applications', 45.00, 30, 1, 'By Martin Kleppmann');

INSERT INTO orders (order_number, customer_id, total_amount, status) VALUES
  ('ORD-2026-001', 1, 209.49, 'completed'),
  ('ORD-2026-002', 2, 45.00, 'processing');

INSERT INTO order_items (order_id, item_id, product_sku, quantity, unit_price) VALUES
  (1, 1, 'PROD-001', 1, 129.99),
  (1, 2, 'PROD-002', 1, 79.50),
  (2, 1, 'PROD-003', 1, 45.00);

INSERT INTO audit_logs (action, actor, details) VALUES
  ('INITIALIZE', 'system', 'Database seeded successfully'),
  ('USER_LOGIN', 'an.nguyen@example.com', 'Login from IP 192.168.1.1');

INSERT INTO types_matrix (int_val, real_val, text_val, unicode_val) VALUES
  (9007199254740991, 3.14159265359, 'Standard ASCII Text', 'Tiếng Việt có dấu - 🇻🇳 - 日本語 - 漢字');

INSERT INTO "special_order-items" ("order id", "select", "group by", "from") VALUES
  (1, 'val_select', 'val_group', 'val_from');
`

/**
 * Creates a real SQLite database instance using Node 24 native DatabaseSync.
 * Supports in-memory (:memory:) or isolated temporary file on disk.
 */
export function createTestSqliteDatabase(options?: {
  inMemory?: boolean
  prefix?: string
  seed?: boolean
}): SqliteTestDatabase {
  const inMemory = options?.inMemory ?? true
  const prefix = options?.prefix ?? 'datanoa_test'
  const seed = options?.seed ?? true

  let db: DatabaseSync
  let filePath: string | undefined
  let tempDir: string | undefined

  if (inMemory) {
    db = new DatabaseSync(':memory:')
  } else {
    tempDir = fs.mkdtempSync(
      path.join(
        os.tmpdir(),
        `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}_`
      )
    )
    filePath = path.join(tempDir, 'fixture.db')
    db = new DatabaseSync(filePath)
  }

  // Execute DDL Schema
  db.exec(RICH_FIXTURE_SCHEMA_SQL)

  // Seed Initial Data
  if (seed) {
    db.exec(RICH_FIXTURE_SEED_SQL)
  }

  // Safe Teardown with Windows file locking protection
  const cleanup = () => {
    try {
      db.close()
    } catch {}

    if (filePath) {
      const filesToDelete = [filePath, `${filePath}-wal`, `${filePath}-shm`]
      for (const f of filesToDelete) {
        if (fs.existsSync(f)) {
          try {
            fs.unlinkSync(f)
          } catch {}
        }
      }
    }

    if (tempDir && fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true })
      } catch {}
    }
  }

  return { db, filePath, cleanup }
}

/**
 * Dialect Quoting Helpers
 */
export function quoteIdentifier(
  driver: 'sqlite' | 'postgres' | 'mysql',
  identifier: string,
  schema?: string
): string {
  if (driver === 'mysql') {
    const escaped = identifier.replace(/`/g, '``')
    return schema ? `\`${schema.replace(/`/g, '``')}\`.\`${escaped}\`` : `\`${escaped}\``
  }
  // SQLite and PostgreSQL use standard SQL double quotes
  const escaped = identifier.replace(/"/g, '""')
  return schema ? `"${schema.replace(/"/g, '""')}"."${escaped}"` : `"${escaped}"`
}

/**
 * Dialect Parameter Placeholder Generator
 */
export function makePlaceholder(
  driver: 'sqlite' | 'postgres' | 'mysql',
  paramIndex: number
): string {
  if (driver === 'postgres') {
    return `$${paramIndex}`
  }
  return '?'
}

/**
 * Builds a safe parameterized UPDATE SQL statement with optimistic concurrency control.
 */
export function buildTestUpdateSql(options: {
  driver: 'sqlite' | 'postgres' | 'mysql'
  table: string
  schema?: string
  column: string
  newValue: unknown
  primaryKeys: Record<string, unknown>
  originalValue?: unknown
}): { sql: string; params: unknown[] } {
  const { driver, table, schema, column, newValue, primaryKeys, originalValue } = options
  const params: unknown[] = []
  let paramIdx = 1

  const quotedTable = quoteIdentifier(driver, table, schema)
  const quotedCol = quoteIdentifier(driver, column)

  params.push(newValue)
  const setClause = `${quotedCol} = ${makePlaceholder(driver, paramIdx++)}`

  const whereClauses: string[] = []

  // Primary key matching
  for (const [pkCol, pkVal] of Object.entries(primaryKeys)) {
    const quotedPk = quoteIdentifier(driver, pkCol)
    whereClauses.push(`${quotedPk} = ${makePlaceholder(driver, paramIdx++)}`)
    params.push(pkVal)
  }

  // Optimistic concurrency locking
  if (originalValue !== undefined) {
    if (originalValue === null) {
      whereClauses.push(`${quotedCol} IS NULL`)
    } else {
      whereClauses.push(`${quotedCol} = ${makePlaceholder(driver, paramIdx++)}`)
      params.push(originalValue)
    }
  }

  if (whereClauses.length === 0) {
    throw new Error('Cannot generate UPDATE without WHERE conditions')
  }

  const sql = `UPDATE ${quotedTable} SET ${setClause} WHERE ${whereClauses.join(' AND ')}`
  return { sql, params }
}

/**
 * PostgreSQL Mock Dialect Fixtures and Introspection Samples
 */
export const POSTGRES_MOCK_FIXTURES = {
  connectionSuccess: { ok: true, version: 'PostgreSQL 16.2 on x86_64-pc-linux-gnu' },
  authFailure: { code: '28P01', message: 'password authentication failed for user "testuser"' },
  connectionRefused: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:5432' },
  undefinedTable: { code: '42P01', message: 'relation "unknown_table" does not exist' },
  uniqueViolation: { code: '23505', message: 'duplicate key value violates unique constraint "users_email_key"' },

  sampleTableDetails: {
    name: 'users',
    schema: 'public',
    kind: 'table' as const,
    columns: [
      {
        name: 'id',
        type: 'integer',
        nativeType: 'int4',
        nullable: false,
        defaultValue: "nextval('users_id_seq'::regclass)",
        isPrimaryKey: true,
        isAutoIncrement: true
      },
      {
        name: 'username',
        type: 'character varying(50)',
        nativeType: 'varchar',
        nullable: false,
        defaultValue: null,
        isPrimaryKey: false,
        isAutoIncrement: false
      },
      {
        name: 'email',
        type: 'character varying(255)',
        nativeType: 'varchar',
        nullable: false,
        defaultValue: null,
        isPrimaryKey: false,
        isAutoIncrement: false
      },
      {
        name: 'created_at',
        type: 'timestamp with time zone',
        nativeType: 'timestamptz',
        nullable: false,
        defaultValue: 'now()',
        isPrimaryKey: false,
        isAutoIncrement: false
      }
    ],
    primaryKey: ['id'],
    indexes: [
      { name: 'users_pkey', isUnique: true, isPrimary: true, columns: ['id'] },
      { name: 'users_email_key', isUnique: true, isPrimary: false, columns: ['email'] }
    ],
    foreignKeys: []
  } satisfies TableDetails,

  expectedUpdateSql: 'UPDATE "public"."users" SET "username" = $1 WHERE "id" = $2 AND "username" = $3',
  expectedUpdateParams: ['new_user', 1, 'old_user'],
  cancelQuerySql: 'SELECT pg_cancel_backend($1)'
}

/**
 * MySQL Mock Dialect Fixtures and Introspection Samples
 */
export const MYSQL_MOCK_FIXTURES = {
  connectionSuccess: { ok: true, version: '8.0.36 MySQL Community Server - GPL' },
  authFailure: { code: 'ER_ACCESS_DENIED_ERROR', errno: 1045, message: "Access denied for user 'testuser'@'localhost'" },
  connectionRefused: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:3306' },
  tableNotFound: { code: 'ER_NO_SUCH_TABLE', errno: 1146, message: "Table 'shop.unknown_table' doesn't exist" },
  duplicateEntry: { code: 'ER_DUP_ENTRY', errno: 1062, message: "Duplicate entry 'order-001' for key 'orders.order_number'" },

  sampleTableDetails: {
    name: 'orders',
    schema: 'shop',
    kind: 'table' as const,
    columns: [
      {
        name: 'order_id',
        type: 'int',
        nativeType: 'int',
        nullable: false,
        defaultValue: null,
        isPrimaryKey: true,
        isAutoIncrement: true
      },
      {
        name: 'order_status',
        type: 'varchar(20)',
        nativeType: 'varchar',
        nullable: false,
        defaultValue: "'pending'",
        isPrimaryKey: false,
        isAutoIncrement: false
      },
      {
        name: 'total',
        type: 'decimal(10,2)',
        nativeType: 'decimal',
        nullable: false,
        defaultValue: '0.00',
        isPrimaryKey: false,
        isAutoIncrement: false
      }
    ],
    primaryKey: ['order_id'],
    indexes: [
      { name: 'PRIMARY', isUnique: true, isPrimary: true, columns: ['order_id'] }
    ],
    foreignKeys: []
  } satisfies TableDetails,

  expectedUpdateSql: 'UPDATE `shop`.`orders` SET `order_status` = ? WHERE `order_id` = ? AND `order_status` = ?',
  expectedUpdateParams: ['completed', 101, 'pending'],
  cancelQuerySql: 'KILL QUERY ?'
}

/**
 * Introspects an active DatabaseSync SQLite database directly
 * to generate expected SchemaObject list and TableDetails.
 */
export function introspectSqliteDatabase(db: DatabaseSync): {
  objects: SchemaObject[]
  tables: Record<string, TableDetails>
} {
  // Query all tables and views
  const stmt = db.prepare(`
    SELECT name, type AS kind 
    FROM sqlite_master 
    WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
    ORDER BY name ASC
  `)
  const rows = stmt.all() as { name: string; kind: 'table' | 'view' }[]

  const objects: SchemaObject[] = rows.map((r) => ({
    name: r.name,
    schema: 'main',
    kind: r.kind
  }))

  const tables: Record<string, TableDetails> = {}

  for (const obj of objects) {
    // Columns info via PRAGMA table_info
    const colStmt = db.prepare(`PRAGMA table_info("${obj.name.replace(/"/g, '""')}")`)
    const colRows = colStmt.all() as {
      cid: number
      name: string
      type: string
      notnull: number
      dflt_value: string | null
      pk: number
    }[]

    const primaryKeyCols: string[] = []
    const columns = colRows.map((c) => {
      const isPk = c.pk > 0
      if (isPk) {
        primaryKeyCols.push(c.name)
      }
      return {
        name: c.name,
        type: c.type || 'TEXT',
        nativeType: c.type || 'TEXT',
        nullable: c.notnull === 0,
        defaultValue: c.dflt_value,
        isPrimaryKey: isPk,
        isAutoIncrement: isPk && c.type.toUpperCase().includes('INTEGER')
      }
    })

    // Foreign Keys via PRAGMA foreign_key_list
    const fkStmt = db.prepare(`PRAGMA foreign_key_list("${obj.name.replace(/"/g, '""')}")`)
    const fkRows = fkStmt.all() as {
      id: number
      seq: number
      table: string
      from: string
      to: string
    }[]

    const foreignKeys = fkRows.map((fk) => ({
      constraintName: `fk_${obj.name}_${fk.from}_${fk.table}`,
      column: fk.from,
      referencedTable: fk.table,
      referencedColumn: fk.to
    }))

    // Indexes via PRAGMA index_list
    const idxStmt = db.prepare(`PRAGMA index_list("${obj.name.replace(/"/g, '""')}")`)
    const idxRows = idxStmt.all() as {
      seq: number
      name: string
      unique: number
      origin: string
      partial: number
    }[]

    const indexes = idxRows.map((idx) => {
      const infoStmt = db.prepare(`PRAGMA index_info("${idx.name.replace(/"/g, '""')}")`)
      const infoRows = infoStmt.all() as { seqno: number; cid: number; name: string }[]
      return {
        name: idx.name,
        isUnique: idx.unique === 1,
        isPrimary: idx.origin === 'pk',
        columns: infoRows.map((i) => i.name)
      }
    })

    tables[obj.name] = {
      name: obj.name,
      schema: 'main',
      kind: obj.kind,
      columns,
      primaryKey: primaryKeyCols,
      indexes,
      foreignKeys
    }
  }

  return { objects, tables }
}
