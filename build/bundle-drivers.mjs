/**
 * build/bundle-drivers.mjs
 * Bundles pg, mysql2, and @codemirror/* into standalone vendor modules.
 * Enforces Orca's 1 MiB per-file limit and CSP rules (zero eval / new Function).
 */
import esbuild from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')
const vendorDir = path.resolve(projectRoot, 'vendor')

const MAX_BYTES = 1024 * 1024 // 1,048,576 bytes (1 MiB Orca ceiling)

// Ensure vendor directory exists
if (!fs.existsSync(vendorDir)) {
  fs.mkdirSync(vendorDir, { recursive: true })
}

// Plugin to mock aws-ssl-profiles in mysql2 to prevent ~214 KB of unused RDS cert bloat
const mockAwsSslPlugin = {
  name: 'mock-aws-ssl',
  setup(build) {
    build.onResolve({ filter: /^aws-ssl-profiles$/ }, args => ({
      path: args.path,
      namespace: 'mock-aws-ssl',
    }))
    build.onLoad({ filter: /.*/, namespace: 'mock-aws-ssl' }, () => ({
      contents: 'module.exports = { ca: [] };',
      loader: 'js',
    }))
  },
}

// Node ESM banner to provide require for CommonJS modules referencing Node built-ins
const nodeEsmBanner = {
  js: `import { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);`,
}

/**
 * Validate bundle size and scan for prohibited dynamic code execution constructs.
 */
function validateBundle(filePath, name) {
  const stat = fs.statSync(filePath)
  const size = stat.size
  const content = fs.readFileSync(filePath, 'utf8')

  console.log(`[bundle-drivers] ${name}: ${size} bytes (${(size / 1024).toFixed(1)} KB)`)

  if (size > MAX_BYTES) {
    throw new Error(
      `[FAIL] ${name} exceeds maximum allowed size of 1 MiB (${MAX_BYTES} bytes): got ${size} bytes!`
    )
  }

  const evalMatch = content.match(/\beval\s*\(/g)
  if (evalMatch) {
    throw new Error(
      `[FAIL] ${name} contains prohibited 'eval(' call (${evalMatch.length} occurrences)!`
    )
  }

  const newFunctionMatch = content.match(/new\s+Function\s*\(/g)
  if (newFunctionMatch) {
    throw new Error(
      `[FAIL] ${name} contains prohibited 'new Function(' call (${newFunctionMatch.length} occurrences)!`
    )
  }

  console.log(`[bundle-drivers] ${name}: Validated OK (< 1 MiB, 0 eval, 0 new Function).`)
}

async function bundlePostgres() {
  const code = `
import pg from 'pg';
import Cursor from 'pg-cursor';

const {
  Client,
  Pool,
  Query,
  types,
  defaults,
  Connection,
  DatabaseError,
  TypeOverrides,
  escapeIdentifier,
  escapeLiteral,
  Result,
  utils,
} = pg;

export {
  Client,
  Pool,
  Query,
  types,
  defaults,
  Connection,
  DatabaseError,
  TypeOverrides,
  escapeIdentifier,
  escapeLiteral,
  Result,
  utils,
  Cursor,
};

export default pg;
`

  const outfile = path.join(vendorDir, 'pg.js')
  await esbuild.build({
    stdin: {
      contents: code,
      resolveDir: projectRoot,
      loader: 'js',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: ['node22', 'es2022'],
    outfile,
    external: ['pg-native', 'pg-cloudflare'],
    minify: true,
    treeShaking: true,
    legalComments: 'none',
    banner: nodeEsmBanner,
  })

  validateBundle(outfile, 'vendor/pg.js')

  // Emit companion TypeScript declaration
  const dtsContent = `
import type * as pgTypes from 'pg'
import type Cursor from 'pg-cursor'

export const Client: typeof pgTypes.Client
export type Client = pgTypes.Client
export const Pool: typeof pgTypes.Pool
export type Pool = pgTypes.Pool
export const Query: typeof pgTypes.Query
export type Query = pgTypes.Query
export const types: typeof pgTypes.types
export const defaults: typeof pgTypes.defaults
export const Connection: typeof pgTypes.Connection
export type Connection = pgTypes.Connection
export const DatabaseError: typeof pgTypes.DatabaseError
export type DatabaseError = pgTypes.DatabaseError
export const escapeIdentifier: typeof pgTypes.escapeIdentifier
export const escapeLiteral: typeof pgTypes.escapeLiteral
export const Result: typeof pgTypes.Result
export type Result<R = any> = pgTypes.Result<R>
export const Cursor: any

export type {
  PoolConfig,
  PoolClient,
  ClientConfig,
  QueryResult as PgQueryResult,
  QueryResultRow,
  FieldDef,
} from 'pg'

declare const _default: typeof pgTypes & { Cursor: any }
export default _default
`
  fs.writeFileSync(path.join(vendorDir, 'pg.d.ts'), dtsContent.trim() + '\n', 'utf8')
}

async function bundleMySQL() {
  const code = `
import mysql from 'mysql2';
import * as mysqlPromise from 'mysql2/promise';

const {
  createConnection,
  connect,
  Connection,
  ConnectionConfig,
  createPool,
  createPoolCluster,
  createQuery,
  Pool,
  PoolCluster,
  createServer,
  PoolConnection,
  authPlugins,
  escape,
  escapeId,
  format,
  raw,
  createConnectionPromise,
  createPoolPromise,
  createPoolClusterPromise,
  Types,
  TypedParameter,
  Charsets,
  CharsetToEncoding,
  setMaxParserCache,
  clearParserCache,
} = mysql;

export {
  createConnection,
  connect,
  Connection,
  ConnectionConfig,
  createPool,
  createPoolCluster,
  createQuery,
  Pool,
  PoolCluster,
  createServer,
  PoolConnection,
  authPlugins,
  escape,
  escapeId,
  format,
  raw,
  createConnectionPromise,
  createPoolPromise,
  createPoolClusterPromise,
  Types,
  TypedParameter,
  Charsets,
  CharsetToEncoding,
  setMaxParserCache,
  clearParserCache,
  mysqlPromise,
};

export default mysql;
`

  const outfile = path.join(vendorDir, 'mysql2.js')
  await esbuild.build({
    stdin: {
      contents: code,
      resolveDir: projectRoot,
      loader: 'js',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: ['node22', 'es2022'],
    outfile,
    plugins: [mockAwsSslPlugin],
    minify: true,
    treeShaking: true,
    legalComments: 'none',
    banner: nodeEsmBanner,
  })

  validateBundle(outfile, 'vendor/mysql2.js')

  // Emit companion TypeScript declaration
  const dtsContent = `
import type * as mysqlTypes from 'mysql2'
import type * as mysqlPromiseTypes from 'mysql2/promise'

export * from 'mysql2'
export const mysqlPromise: typeof mysqlPromiseTypes
declare const _default: any
export default _default
`
  fs.writeFileSync(path.join(vendorDir, 'mysql2.d.ts'), dtsContent.trim() + '\n', 'utf8')
}

async function bundleCodeMirror() {
  const code = `
export * from '@codemirror/state';
export * from '@codemirror/view';
export * from '@codemirror/commands';
export * from '@codemirror/language';
export * from '@codemirror/autocomplete';
export * from '@codemirror/lang-sql';
export { tags } from '@lezer/highlight';
`

  const outfile = path.join(vendorDir, 'codemirror.js')
  await esbuild.build({
    stdin: {
      contents: code,
      resolveDir: projectRoot,
      loader: 'js',
    },
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: ['es2022'],
    outfile,
    minify: true,
    treeShaking: true,
    legalComments: 'none',
  })

  validateBundle(outfile, 'vendor/codemirror.js')

  // Emit companion TypeScript declaration
  const dtsContent = `
export * from '@codemirror/state';
export * from '@codemirror/view';
export * from '@codemirror/commands';
export * from '@codemirror/language';
export * from '@codemirror/autocomplete';
export * from '@codemirror/lang-sql';
export { tags } from '@lezer/highlight';
`
  fs.writeFileSync(path.join(vendorDir, 'codemirror.d.ts'), dtsContent.trim() + '\n', 'utf8')
}

async function main() {
  console.log('[bundle-drivers] Starting vendor drivers bundling...')
  const startTime = Date.now()

  try {
    await bundlePostgres()
    await bundleMySQL()
    await bundleCodeMirror()

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2)
    console.log(`[bundle-drivers] All vendor bundles built successfully in ${elapsed}s!`)
  } catch (err) {
    console.error(`[bundle-drivers] Build failed:`, err)
    process.exit(1)
  }
}

main()
