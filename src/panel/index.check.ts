import { defineCheck } from 'orca/testing'
import type { ConnectionProfile, SchemaObject, TableDetails } from '../protocol'

const MOCK_CONNECTIONS: ConnectionProfile[] = [
  {
    id: 'conn_sqlite_local',
    name: 'Local Store',
    driver: 'sqlite',
    database: 'store.db',
    filePath: '/workspace/store.db',
    readOnly: false,
  },
  {
    id: 'conn_pg_dev',
    name: 'Dev Postgres',
    driver: 'postgres',
    database: 'app_dev',
    host: 'localhost',
    port: 5432,
    user: 'postgres',
    ssl: false,
  },
  {
    id: 'conn_mysql_prod',
    name: 'Production MySQL',
    driver: 'mysql',
    database: 'inventory',
    host: 'db.internal',
    port: 3306,
    user: 'app_user',
  },
]

const MOCK_TABLES: SchemaObject[] = [
  { name: 'users', schema: 'public', kind: 'table' },
  { name: 'orders', schema: 'public', kind: 'table' },
  { name: 'products', schema: 'public', kind: 'table' },
  { name: 'active_orders', schema: 'public', kind: 'view' },
]

const MOCK_TABLE_DETAILS: TableDetails = {
  name: 'users',
  schema: 'public',
  kind: 'table',
  columns: [
    {
      name: 'id',
      type: 'INTEGER',
      nativeType: 'INTEGER',
      nullable: false,
      defaultValue: null,
      isPrimaryKey: true,
      isAutoIncrement: true,
    },
    {
      name: 'name',
      type: 'TEXT',
      nativeType: 'VARCHAR(255)',
      nullable: false,
      defaultValue: null,
      isPrimaryKey: false,
      isAutoIncrement: false,
    },
    {
      name: 'email',
      type: 'TEXT',
      nativeType: 'VARCHAR(255)',
      nullable: true,
      defaultValue: null,
      isPrimaryKey: false,
      isAutoIncrement: false,
    },
  ],
  primaryKey: ['id'],
  indexes: [
    {
      name: 'users_pkey',
      isUnique: true,
      isPrimary: true,
      columns: ['id'],
    },
  ],
  foreignKeys: [],
}

const MOCK_PAGE_RESULT = {
  columns: MOCK_TABLE_DETAILS.columns,
  rows: [
    { id: 1, name: 'Alice Nguyen', email: 'alice@example.com' },
    { id: 2, name: 'Tran Minh', email: 'minh@example.com' },
  ],
  totalRows: 2,
  page: 1,
  pageSize: 50,
  primaryKey: ['id'],
  canEdit: true,
}

export default defineCheck({
  empty: {
    requests: {
      'connections.list': [],
    },
  },
  tree: {
    requests: {
      'connections.list': MOCK_CONNECTIONS,
      'schema.listObjects': MOCK_TABLES,
      'schema.tableDetails': MOCK_TABLE_DETAILS,
      'data.fetchPage': MOCK_PAGE_RESULT,
    },
  },
  'tree-dark': {
    theme: 'dark',
    requests: {
      'connections.list': MOCK_CONNECTIONS,
      'schema.listObjects': MOCK_TABLES,
      'schema.tableDetails': MOCK_TABLE_DETAILS,
      'data.fetchPage': MOCK_PAGE_RESULT,
    },
  },
  form: {
    requests: {
      'connections.list': MOCK_CONNECTIONS,
      'connection.test': { ok: true, message: 'Connection test succeeded' },
      'connection.save': { ok: true, id: 'conn_sqlite_local' },
      'schema.listObjects': MOCK_TABLES,
      'schema.tableDetails': MOCK_TABLE_DETAILS,
      'data.fetchPage': MOCK_PAGE_RESULT,
    },
  },
})
