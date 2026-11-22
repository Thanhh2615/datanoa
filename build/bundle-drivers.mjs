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

// Narrow, locked-source patch for mysql2's TLS identity check.
// startTLS() forwards Node's raw checkServerIdentity, which validates against the TLS
// servername (DNS-only) and therefore falls back to 'localhost' for IP hosts, rejecting a
// correctly CA-signed IP-SAN-only certificate during the handshake. Datanoa already chooses
// config.host as the intended DNS/IP identity (including tunnel identity), so bind the check
// to config.host. DNS-only SNI, TLS materials, rejectUnauthorized, async guards, cache keys and
// error wiring stay untouched. node_modules is never modified: the patch lives only in memory
// while bundling the locked module.
const MYSQL2_VERSION = '3.24.6'
const MYSQL2_CONNECTION = 'node_modules/mysql2/lib/base/connection.js'
const TLS_IDENTITY_ANCHOR = `        checkServerIdentity: verifyIdentity
          ? Tls.checkServerIdentity
          : function () {
              return undefined;
            },`
const TLS_IDENTITY_PATCH = `        checkServerIdentity: verifyIdentity
          ? (hostname, cert) => Tls.checkServerIdentity(this.config.host, cert)
          : function () {
              return undefined;
            },`

function createMysqlTlsIpSanPlugin(state) {
  const target = path.resolve(projectRoot, MYSQL2_CONNECTION)
  return {
    name: 'mysql-tls-ip-san',
    setup(build) {
      build.onLoad({ filter: /[\\/]mysql2[\\/]lib[\\/]base[\\/]connection\.js$/ }, args => {
        if (path.resolve(args.path) !== target) {
          throw new Error(
            `[bundle-drivers] mysql-tls-ip-san matched unexpected module: ${args.path} (expected ${target})`
          )
        }
        state.loads += 1
        const source = fs.readFileSync(args.path, 'utf8')
        const anchorCount = source.split(TLS_IDENTITY_ANCHOR).length - 1
        if (anchorCount !== 1) {
          throw new Error(
            `[bundle-drivers] mysql-tls-ip-san expected exactly one TLS identity anchor in ${MYSQL2_CONNECTION} (mysql2 ${MYSQL2_VERSION}); found ${anchorCount}. Refusing to bundle.`
          )
        }
        const patched = source.replace(TLS_IDENTITY_ANCHOR, TLS_IDENTITY_PATCH)
        const replacementCount = patched.split(TLS_IDENTITY_PATCH).length - 1
        if (patched === source || replacementCount !== 1) {
          throw new Error(
            `[bundle-drivers] mysql-tls-ip-san replacement failed for ${MYSQL2_CONNECTION}: expected exactly one patched anchor, got ${replacementCount}. Refusing to bundle.`
          )
        }
        state.replacements += 1
        return { contents: patched, loader: 'js' }
      })
    },
  }
}

// Node ESM banner to provide require for CommonJS modules referencing Node built-ins
const nodeEsmBanner = {
  js: `import { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);`,
}

/**
 * Validate bundle size and scan for prohibited dynamic code execution constructs
 * as well as obfuscation-like hex/unicode escape runs in worker bundles.
 */
function validateBundle(filePath, name, { rejectEscapedRuns = false } = {}) {
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

  if (rejectEscapedRuns) {
    const hexRuns = content.match(/(?:\\x[0-9a-fA-F]{2}){16,}/g)
    if (hexRuns) {
      throw new Error(
        `[FAIL] ${name} contains ${hexRuns.length} long \\xNN escape runs (set esbuild charset: 'utf8')!`
      )
    }
    const unicodeRuns = content.match(/(?:\\u[0-9a-fA-F]{4}){16,}/g)
    if (unicodeRuns) {
      throw new Error(
        `[FAIL] ${name} contains ${unicodeRuns.length} long \\uNNNN escape runs (set esbuild charset: 'utf8')!`
      )
    }
  }

  const escapeSummary = rejectEscapedRuns ? ', 0 escaped runs' : ''
  console.log(
    `[bundle-drivers] ${name}: Validated OK (< 1 MiB, 0 eval, 0 new Function${escapeSummary}).`
  )
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
    // Keep non-ASCII text as UTF-8 so Node ESM worker bundles never emit long \xNN / \uNNNN runs
    // that trigger Orca plugin directory obfuscation review (see oscarbotteri/orca-db-studio#68).
    charset: 'utf8',
    treeShaking: true,
    legalComments: 'none',
    banner: nodeEsmBanner,
  })

  validateBundle(outfile, 'vendor/pg.js', { rejectEscapedRuns: true })

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

  const mysql2Version = JSON.parse(
    fs.readFileSync(path.join(projectRoot, 'node_modules/mysql2/package.json'), 'utf8')
  ).version
  if (mysql2Version !== MYSQL2_VERSION) {
    throw new Error(
      `[bundle-drivers] mysql2 version drift: expected ${MYSQL2_VERSION}, found ${mysql2Version}. Refusing to bundle the locked TLS patch.`
    )
  }
  const tlsIpSanState = { loads: 0, replacements: 0 }
  const tlsIpSanPlugin = createMysqlTlsIpSanPlugin(tlsIpSanState)

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
    plugins: [mockAwsSslPlugin, tlsIpSanPlugin],
    minify: true,
    // Keep non-ASCII text as UTF-8 so iconv-lite codepage tables inside mysql2 stay literal UTF-8
    // instead of long \xNN / \uNNNN escape runs that trigger Orca directory under-review (code).
    charset: 'utf8',
    treeShaking: true,
    legalComments: 'none',
    banner: nodeEsmBanner,
  })

  validateBundle(outfile, 'vendor/mysql2.js', { rejectEscapedRuns: true })

  // The patch must have actually executed on the locked module exactly once (not merely be
  // capable of matching), and the generated vendor must carry exactly one rebound identity check.
  if (tlsIpSanState.loads !== 1 || tlsIpSanState.replacements !== 1) {
    throw new Error(
      `[bundle-drivers] mysql-tls-ip-san did not run exactly once for ${MYSQL2_CONNECTION} (loads=${tlsIpSanState.loads}, replacements=${tlsIpSanState.replacements}). Refusing to continue.`
    )
  }
  const bundledMysql = fs.readFileSync(outfile, 'utf8')
  const reboundChecks = bundledMysql.match(/\.checkServerIdentity\(this\.config\.host\s*,/g)
  if (!reboundChecks || reboundChecks.length !== 1) {
    throw new Error(
      `[bundle-drivers] generated vendor/mysql2.js is missing the single config.host identity check (found ${reboundChecks ? reboundChecks.length : 0}). Refusing to continue.`
    )
  }

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
export { EditorState, EditorSelection, Compartment } from '@codemirror/state';
export { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view';
export { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
export { HighlightStyle, syntaxHighlighting, LanguageSupport, StreamLanguage, foldGutter, codeFolding, foldKeymap, bracketMatching } from '@codemirror/language';
export { autocompletion, completionKeymap } from '@codemirror/autocomplete';
export { search, searchKeymap, highlightSelectionMatches, openSearchPanel } from '@codemirror/search';
export { sql, SQLite, PostgreSQL, MySQL, MariaSQL, schemaCompletionSource } from '@codemirror/lang-sql';
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
    // Keep browser frame bundle ASCII (no iconv codepage tables; safe across HTML/iframe contexts).
    charset: 'ascii',
    treeShaking: true,
    legalComments: 'none',
  })

  validateBundle(outfile, 'vendor/codemirror.js')

  // Emit companion TypeScript declaration
  const dtsContent = `
export { EditorState, EditorSelection, Compartment, type Extension } from '@codemirror/state';
export { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view';
export { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
export { HighlightStyle, syntaxHighlighting, LanguageSupport, StreamLanguage, foldGutter, codeFolding, foldKeymap, bracketMatching } from '@codemirror/language';
export { autocompletion, completionKeymap } from '@codemirror/autocomplete';
export { search, searchKeymap, highlightSelectionMatches, openSearchPanel } from '@codemirror/search';
export { sql, SQLite, PostgreSQL, MySQL, MariaSQL, schemaCompletionSource, type SQLDialect } from '@codemirror/lang-sql';
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
