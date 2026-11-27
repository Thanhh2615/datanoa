/**
 * build/bundle-drivers.mjs
 * Bundles iconv-lite, big-integer, pg, mysql2, mongodb, mssql, oracledb, @codemirror/*, node-sql-parser, and ssh2 into standalone vendor modules.
 * Enforces Orca's 1 MiB per-file limit and CSP rules (zero eval / Function / escape runs).
 */
import esbuild from 'esbuild'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')
const vendorDir = path.resolve(projectRoot, 'vendor')
const nodeRequire = createRequire(import.meta.url)

const MAX_BYTES = 1024 * 1024 // 1,048,576 bytes (1 MiB Orca ceiling)

// Ensure vendor directory exists
if (!fs.existsSync(vendorDir)) {
  fs.mkdirSync(vendorDir, { recursive: true })
}

const PINNED_VENDOR_VERSIONS = {
  pg: '8.23.1',
  'pg-cursor': '2.22.1',
  mysql2: '3.24.6',
  'iconv-lite': '0.7.3',
  mongodb: '7.9.1',
  bson: '7.3.4',
  'mongodb-connection-string-url': '7.0.3',
  mssql: '12.8.1',
  tedious: '20.4.2',
  oracledb: '26.0.0',
  '@codemirror/autocomplete': '6.20.4',
  '@codemirror/commands': '6.11.1',
  '@codemirror/lang-sql': '6.10.0',
  '@codemirror/language': '6.13.1',
  '@codemirror/search': '6.7.2',
  '@codemirror/state': '6.7.6',
  '@codemirror/view': '6.43.15',
  '@lezer/highlight': '1.2.5',
  '@replit/codemirror-vim': '6.4.0',
  '@replit/codemirror-vim-core': '0.1.0',
  'node-sql-parser': '5.4.0',
  'big-integer': '1.6.52',
  ssh2: '1.17.0',
  asn1: '0.2.6',
  'bcrypt-pbkdf': '1.0.2',
  tweetnacl: '0.14.5',
}

function assertInstalledVersion(pkgName, expectedVersion = PINNED_VENDOR_VERSIONS[pkgName]) {
  const pkgJsonPath = path.join(projectRoot, 'node_modules', ...pkgName.split('/'), 'package.json')
  if (!fs.existsSync(pkgJsonPath)) {
    throw new Error(`[bundle-drivers] Missing installed package ${pkgName} at ${pkgJsonPath}`)
  }
  const actual = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')).version
  if (actual !== expectedVersion) {
    throw new Error(
      `[bundle-drivers] ${pkgName} version drift: expected ${expectedVersion}, found ${actual}. Refusing to bundle.`
    )
  }
}

// Plugin to mock aws-ssl-profiles in mysql2 to prevent ~214 KB of unused RDS cert bloat
function createMockAwsSslPlugin(state) {
  return {
    name: 'mock-aws-ssl',
    setup(build) {
      build.onResolve({ filter: /^aws-ssl-profiles$/ }, args => {
        state.replacements += 1
        return {
          path: args.path,
          namespace: 'mock-aws-ssl',
        }
      })
      build.onLoad({ filter: /.*/, namespace: 'mock-aws-ssl' }, () => ({
        contents: 'module.exports = { ca: [] };',
        loader: 'js',
      }))
    },
  }
}

// Plugin to replace whatwg-url with Node's native globalThis.URL / URLSearchParams (removing
// tr46 \uNNNN escape tables and whatwg-url's eval("(async function* () {})")), stub unused
// client-side-encryption (CSFLE) and GridFS submodules, replace dynamic import('os') with static
// require('os'), and guard bson against any eval("(async function* () {})") probes.
function createMongoCleanPlugin(state) {
  const expectedWhatwgImporter = path.resolve(
    projectRoot,
    'node_modules/mongodb-connection-string-url/lib/index.js'
  )
  const expectedCsfleDir = path.resolve(projectRoot, 'node_modules/mongodb/lib/client-side-encryption')
  const expectedGridfsDir = path.resolve(projectRoot, 'node_modules/mongodb/lib/gridfs')
  const expectedRuntimeAdaptersPath = path.resolve(
    projectRoot,
    'node_modules/mongodb/lib/runtime_adapters.js'
  )
  return {
    name: 'mongo-clean',
    setup(build) {
      build.onResolve({ filter: /^whatwg-url$/ }, args => {
        if (path.resolve(args.importer) !== expectedWhatwgImporter) {
          throw new Error(
            `[bundle-drivers] mongo-clean whatwg-url matched unexpected importer: ${args.importer} (expected ${expectedWhatwgImporter})`
          )
        }
        state.whatwgUrlReplacements += 1
        return {
          path: args.path,
          namespace: 'mongo-whatwg-url',
        }
      })
      build.onLoad({ filter: /.*/, namespace: 'mongo-whatwg-url' }, () => ({
        contents: 'module.exports = { URL: globalThis.URL, URLSearchParams: globalThis.URLSearchParams };',
        loader: 'js',
      }))
      build.onLoad(
        { filter: /[\\/]mongodb[\\/]lib[\\/]client-side-encryption[\\/].*\.js$/ },
        args => {
          const resolved = path.resolve(args.path)
          if (!resolved.startsWith(expectedCsfleDir + path.sep)) {
            throw new Error(
              `[bundle-drivers] mongo-clean client-side-encryption matched unexpected path: ${args.path}`
            )
          }
          state.csfleReplacements += 1
          const base = path.basename(resolved)
          if (base === 'errors.js') {
            return {
              contents: `'use strict';
class MongoCryptError extends Error { constructor(msg, opts) { super(msg, opts); this.name = 'MongoCryptError'; } }
class MongoCryptInvalidArgumentError extends MongoCryptError { constructor(msg) { super(msg); this.name = 'MongoCryptInvalidArgumentError'; } }
class MongoCryptAzureKMSRequestError extends MongoCryptError { constructor(msg, body) { super(msg); this.body = body; this.name = 'MongoCryptAzureKMSRequestError'; } }
class MongoCryptCreateDataKeyError extends MongoCryptError { constructor(dk, o) { super(o?.cause?.message ?? 'CreateDataKeyError'); this.encryptedFields = dk; this.name = 'MongoCryptCreateDataKeyError'; } }
class MongoCryptCreateEncryptedCollectionError extends MongoCryptError { constructor(ef, o) { super(o?.cause?.message ?? 'CreateEncryptedCollectionError'); this.encryptedFields = ef; this.name = 'MongoCryptCreateEncryptedCollectionError'; } }
class MongoCryptKMSRequestNetworkTimeoutError extends MongoCryptError { constructor(msg) { super(msg); this.name = 'MongoCryptKMSRequestNetworkTimeoutError'; } }
module.exports = { MongoCryptError, MongoCryptInvalidArgumentError, MongoCryptAzureKMSRequestError, MongoCryptCreateDataKeyError, MongoCryptCreateEncryptedCollectionError, MongoCryptKMSRequestNetworkTimeoutError };`,
              loader: 'js',
            }
          }
          if (base === 'auto_encrypter.js') {
            return {
              contents: `'use strict';
const AutoEncryptionLoggerLevel = Object.freeze({ FatalError: 0, Error: 1, Warning: 2, Info: 3, Trace: 4 });
class AutoEncrypter {
  constructor() { throw new Error('Datanoa bundled MongoDB driver does not support CSFLE / AutoEncrypter.'); }
  async init() { throw new Error('Datanoa bundled MongoDB driver does not support CSFLE / AutoEncrypter.'); }
  async close() {}
}
module.exports = { AutoEncrypter, AutoEncryptionLoggerLevel };`,
              loader: 'js',
            }
          }
          if (base === 'client_encryption.js') {
            return {
              contents: `'use strict';
class ClientEncryption {
  constructor() { throw new Error('Datanoa bundled MongoDB driver does not support CSFLE / ClientEncryption.'); }
}
module.exports = { ClientEncryption };`,
              loader: 'js',
            }
          }
          return {
            contents: `'use strict';
class MongocryptdManager {
  constructor() { throw new Error('Datanoa bundled MongoDB driver does not support CSFLE / mongocryptd.'); }
}
module.exports = { MongocryptdManager };`,
            loader: 'js',
          }
        }
      )
      build.onLoad({ filter: /[\\/]mongodb[\\/]lib[\\/]gridfs[\\/].*\.js$/ }, args => {
        const resolved = path.resolve(args.path)
        if (!resolved.startsWith(expectedGridfsDir + path.sep)) {
          throw new Error(
            `[bundle-drivers] mongo-clean gridfs matched unexpected path: ${args.path}`
          )
        }
        state.gridfsReplacements += 1
        const unsupported = `function unsupported(name) { return class { constructor() { throw new Error('Datanoa bundled MongoDB driver does not include ' + name + '.'); } }; }`
        const base = path.basename(resolved)
        if (base === 'download.js') {
          return {
            contents: `'use strict';\n${unsupported}\nmodule.exports = { GridFSBucketReadStream: unsupported('GridFSBucketReadStream') };`,
            loader: 'js',
          }
        }
        if (base === 'upload.js') {
          return {
            contents: `'use strict';\n${unsupported}\nmodule.exports = { GridFSBucketWriteStream: unsupported('GridFSBucketWriteStream') };`,
            loader: 'js',
          }
        }
        return {
          contents: `'use strict';\n${unsupported}\nmodule.exports = { GridFSBucket: unsupported('GridFSBucket') };`,
          loader: 'js',
        }
      })
      build.onLoad({ filter: /[\\/]mongodb[\\/]lib[\\/]runtime_adapters\.js$/ }, args => {
        if (path.resolve(args.path) !== expectedRuntimeAdaptersPath) {
          throw new Error(
            `[bundle-drivers] mongo-clean runtime_adapters matched unexpected path: ${args.path} (expected ${expectedRuntimeAdaptersPath})`
          )
        }
        const source = fs.readFileSync(args.path, 'utf8')
        if (!source.includes("await import('os')")) {
          throw new Error(
            `[bundle-drivers] mongo-clean expected await import('os') in ${expectedRuntimeAdaptersPath}`
          )
        }
        state.runtimeOsImportReplacements += 1
        return {
          contents: source.replace(/\(\s*await\s+import\(['"]os['"]\)\s*\)/g, "require('os')"),
          loader: 'js',
        }
      })
      build.onLoad({ filter: /[\\/]bson[\\/].*\.[cm]?js$/ }, args => {
        const source = fs.readFileSync(args.path, 'utf8')
        if (!source.includes('.eval("(async function* () {})")')) {
          return undefined
        }
        state.bsonEvalReplacements += 1
        return {
          contents: source.replace(/[\w$.]+\.eval\("\s*\(async function\* \(\) \{\}\)\s*"\)/g, '(async function* () {})'),
          loader: 'js',
        }
      })
    },
  }
}

// Plugin to stub tedious's unconditional top-level @azure/* requires so vendor/mssql.js remains
// under 1 MiB and loads cleanly when packaged without node_modules.
function createMockAzureTediousPlugin(state) {
  const expectedTediousImporter = path.resolve(
    projectRoot,
    'node_modules/tedious/lib/connection.js'
  )
  return {
    name: 'mock-azure-tedious',
    setup(build) {
      build.onResolve({ filter: /^@azure\/(identity|core-auth|keyvault-keys)$/ }, args => {
        if (
          (args.path === '@azure/identity' || args.path === '@azure/core-auth') &&
          path.resolve(args.importer) !== expectedTediousImporter
        ) {
          throw new Error(
            `[bundle-drivers] mock-azure-tedious matched unexpected importer for ${args.path}: ${args.importer} (expected ${expectedTediousImporter})`
          )
        }
        state.resolved.set(args.path, (state.resolved.get(args.path) ?? 0) + 1)
        return {
          path: args.path,
          namespace: 'mock-azure-tedious',
        }
      })
      build.onLoad({ filter: /.*/, namespace: 'mock-azure-tedious' }, args => {
        if (args.path === '@azure/core-auth') {
          return {
            contents: 'module.exports = { isTokenCredential: () => false };',
            loader: 'js',
          }
        }
        const unsupportedHelper = `function unsupported(name) { return class { constructor() { throw new Error("Datanoa bundled mssql does not include " + name + " (Azure AD / Key Vault auth requires external runtime support)."); } }; }`
        if (args.path === '@azure/identity') {
          return {
            contents: `${unsupportedHelper}
module.exports = {
  ClientSecretCredential: unsupported('@azure/identity ClientSecretCredential'),
  UsernamePasswordCredential: unsupported('@azure/identity UsernamePasswordCredential'),
  ManagedIdentityCredential: unsupported('@azure/identity ManagedIdentityCredential'),
  DefaultAzureCredential: unsupported('@azure/identity DefaultAzureCredential'),
};`,
            loader: 'js',
          }
        }
        return {
          contents: `${unsupportedHelper}
module.exports = {
  KeyClient: unsupported('@azure/keyvault-keys KeyClient'),
  CryptographyClient: unsupported('@azure/keyvault-keys CryptographyClient'),
};`,
          loader: 'js',
        }
      })
    },
  }
}

// Howard Hinnant proleptic Gregorian day count from 1970-01-01 (exact across years 0001..9999).
export function daysFromCivil(y, m, d) {
  const yr = y - (m <= 2 ? 1 : 0)
  const era = Math.floor(yr / 400)
  const yoe = yr - era * 400
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
  return era * 146097 + doe - 719468
}

export function createGregorianJodaShim() {
  const ChronoUnit = { DAYS: 'DAYS' }
  class LocalDate {
    constructor(epochDay) {
      this._d = epochDay
    }
    static of(y, m, d) {
      return new LocalDate(daysFromCivil(y, m, d))
    }
    static ofYearDay(y, doy) {
      return new LocalDate(daysFromCivil(y, 1, 1) + (doy - 1))
    }
    until(end, unit) {
      if (unit !== ChronoUnit.DAYS) {
        throw new Error('Datanoa Gregorian shim only supports ChronoUnit.DAYS.')
      }
      return end._d - this._d
    }
  }
  return { LocalDate, ChronoUnit }
}

// Locked-importer plugin replacing tedious's ~197 KB @js-joda/core dependency (used strictly in
// datetime.js and temporal.js for LocalDate.of / LocalDate.ofYearDay / until(..., ChronoUnit.DAYS)).
function createTediousJodaShimPlugin(state) {
  const allowedImporters = new Set([
    path.resolve(projectRoot, 'node_modules/tedious/lib/data-types/datetime.js'),
    path.resolve(projectRoot, 'node_modules/tedious/lib/data-types/temporal.js'),
  ])
  return {
    name: 'tedious-joda-shim',
    setup(build) {
      build.onResolve({ filter: /^@js-joda\/core$/ }, args => {
        const importer = path.resolve(args.importer)
        if (!allowedImporters.has(importer)) {
          throw new Error(
            `[bundle-drivers] tedious-joda-shim matched unexpected importer: ${args.importer}`
          )
        }
        state.replacements += 1
        return { path: args.path, namespace: 'tedious-joda-shim' }
      })
      build.onLoad({ filter: /.*/, namespace: 'tedious-joda-shim' }, () => ({
        contents: `'use strict';
function daysFromCivil(y, m, d) {
  const yr = y - (m <= 2 ? 1 : 0);
  const era = Math.floor(yr / 400);
  const yoe = yr - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}
const ChronoUnit = { DAYS: 'DAYS' };
class LocalDate {
  constructor(epochDay) { this._d = epochDay; }
  static of(y, m, d) { return new LocalDate(daysFromCivil(y, m, d)); }
  static ofYearDay(y, doy) { return new LocalDate(daysFromCivil(y, 1, 1) + (doy - 1)); }
  until(end, unit) {
    if (unit !== ChronoUnit.DAYS) throw new Error('Datanoa Gregorian shim only supports ChronoUnit.DAYS.');
    return end._d - this._d;
  }
}
module.exports = { LocalDate, ChronoUnit };`,
        loader: 'js',
      }))
    },
  }
}

// Lossless compact decoder for mysql2/lib/constants/errors.js (reconstructs all bidirectional
// numeric <-> ER_* mappings with 0 diffs while shrinking the table from ~145 KB to ~61 KB).
export function decodeCompactMysqlErrors(packed, overrides = {}) {
  const errors = {}
  for (const pair of packed.split(',')) {
    const colon = pair.indexOf(':')
    const code = +pair.slice(0, colon)
    const rawName = pair.slice(colon + 1)
    const name = rawName[0] === '!' ? rawName.slice(1) : 'ER_' + rawName
    errors[code] = name
    errors[name] = code
  }
  for (const [k, v] of Object.entries(overrides)) {
    errors[k] = v
  }
  return errors
}

function createCompactMysqlErrorsPlugin(state) {
  const target = path.resolve(projectRoot, 'node_modules/mysql2/lib/constants/errors.js')
  return {
    name: 'compact-mysql-errors',
    setup(build) {
      build.onLoad({ filter: /[\\/]mysql2[\\/]lib[\\/]constants[\\/]errors\.js$/ }, args => {
        if (path.resolve(args.path) !== target) {
          throw new Error(
            `[bundle-drivers] compact-mysql-errors matched unexpected module: ${args.path} (expected ${target})`
          )
        }
        const rawErrors = nodeRequire(target)
        const numEntries = Object.entries(rawErrors)
          .filter(([k]) => /^\d+$/.test(k))
          .sort((a, b) => Number(a[0]) - Number(b[0]))
        const packed = numEntries
          .map(([num, name]) => `${num}:${name.startsWith('ER_') ? name.slice(3) : '!' + name}`)
          .join(',')
        const preview = decodeCompactMysqlErrors(packed)
        const overrides = {}
        for (const [k, v] of Object.entries(rawErrors)) {
          if (preview[k] !== v) {
            overrides[k] = v
          }
        }
        const verified = decodeCompactMysqlErrors(packed, overrides)
        const rawKeys = Object.keys(rawErrors)
        if (
          Object.keys(verified).length !== rawKeys.length ||
          rawKeys.some(k => verified[k] !== rawErrors[k])
        ) {
          throw new Error('[bundle-drivers] compact-mysql-errors parity verification failed.')
        }
        state.replacements += 1
        state.totalKeys = rawKeys.length
        const overrideStmt =
          Object.keys(overrides).length > 0 ? `Object.assign(e,${JSON.stringify(overrides)});` : ''
        return {
          contents: `'use strict';
const e = module.exports = {};
for (const p of ${JSON.stringify(packed)}.split(',')) {
  const i = p.indexOf(':');
  const n = +p.slice(0, i);
  const r = p.slice(i + 1);
  const v = r[0] === '!' ? r.slice(1) : 'ER_' + r;
  e[n] = v;
  e[v] = n;
}
${overrideStmt}`,
          loader: 'js',
        }
      })
    },
  }
}

// Locked-path plugin stubbing unused SODA & AQ modules inside oracledb (Datanoa uses Thin Mode SQL only).
function createOracleThinCleanPlugin(state) {
  const oracledbLibDir = path.resolve(projectRoot, 'node_modules/oracledb/lib')
  const stubFiles = new Set([
    'aqDeqOptions.js',
    'aqEnqOptions.js',
    'aqMessage.js',
    'aqQueue.js',
    'sodaCollection.js',
    'sodaDatabase.js',
    'sodaDocCursor.js',
    'sodaDocument.js',
    'sodaOperation.js',
    'impl/aqDeqOptions.js',
    'impl/aqEnqOptions.js',
    'impl/aqMessage.js',
    'impl/aqQueue.js',
    'impl/sodaCollection.js',
    'impl/sodaDatabase.js',
    'impl/sodaDocCursor.js',
    'impl/sodaDocument.js',
    'impl/sodaOperation.js',
    'thin/aq.js',
  ])
  return {
    name: 'oracle-thin-clean',
    setup(build) {
      build.onLoad(
        { filter: /[\\/]oracledb[\\/]lib[\\/](?:(?:impl[\\/])?(?:aq|soda)[A-Za-z]*|thin[\\/]aq)\.js$/ },
        args => {
          const resolved = path.resolve(args.path)
          const rel = path.relative(oracledbLibDir, resolved).replace(/\\/g, '/')
          if (!stubFiles.has(rel)) {
            throw new Error(
              `[bundle-drivers] oracle-thin-clean matched unexpected path: ${args.path} (rel=${rel})`
            )
          }
          state.replacements += 1
          if (rel === 'thin/aq.js') {
            return {
              contents: `'use strict';
class ThinQueueImpl { constructor() { throw new Error('Datanoa bundled oracledb Thin Mode does not include AQ.'); } }
class ThinMsgPropsImpl { constructor() { throw new Error('Datanoa bundled oracledb Thin Mode does not include AQ.'); } }
module.exports = { ThinQueueImpl, ThinMsgPropsImpl };`,
              loader: 'js',
            }
          }
          return {
            contents: `'use strict';
class UnsupportedOracleFeature {
  constructor() { throw new Error('Datanoa bundled oracledb Thin Mode does not include SODA / AQ.'); }
}
module.exports = UnsupportedOracleFeature;`,
            loader: 'js',
          }
        }
      )
    },
  }
}

// Static ESM bridge to shared vendor/big-integer.js (mirrors shared-iconv-bridge so sql-parser bundles
// deduplicate big-integer without CJS require("./big-integer.js") / ERR_REQUIRE_ESM).
function createSharedBigIntBridgePlugin(state) {
  return {
    name: 'shared-bigint-bridge',
    setup(build) {
      build.onResolve({ filter: /^big-integer$/ }, () => {
        state.bridges += 1
        return { path: 'big-integer', namespace: 'shared-bigint-bridge' }
      })
      build.onLoad({ filter: /.*/, namespace: 'shared-bigint-bridge' }, () => ({
        contents: `import bigInt from './big-integer.js';\nmodule.exports = bigInt;\n`,
        loader: 'js',
        resolveDir: vendorDir,
      }))
      build.onResolve({ filter: /^\.\/big-integer\.js$/ }, () => ({
        path: './big-integer.js',
        external: true,
      }))
    },
  }
}

function assertStaticBigIntImport(outfile, bundleName) {
  const content = fs.readFileSync(outfile, 'utf8')
  if (!/import\s+[^;]*from\s*["']\.\/big-integer\.js["']/.test(content)) {
    throw new Error(
      `[bundle-drivers] ${bundleName} is missing static ESM import from "./big-integer.js".`
    )
  }
  if (content.includes('("./big-integer.js")') || content.includes("('./big-integer.js')")) {
    throw new Error(
      `[bundle-drivers] ${bundleName} contains forbidden CJS require("./big-integer.js").`
    )
  }
}

// Alias bl's readable-stream require to Node's native node:stream to remove 6 stream polyfill packages.
function createAliasReadableStreamPlugin(state) {
  const expectedBlImporter = path.resolve(projectRoot, 'node_modules/bl/bl.js')
  return {
    name: 'alias-readable-stream',
    setup(build) {
      build.onResolve({ filter: /^readable-stream(\/.*)?$/ }, args => {
        if (path.resolve(args.importer) !== expectedBlImporter) {
          throw new Error(
            `[bundle-drivers] alias-readable-stream matched unexpected importer: ${args.importer} (expected ${expectedBlImporter})`
          )
        }
        state.replacements += 1
        return { path: 'node:stream', external: true }
      })
    },
  }
}

// Static ESM bridge to shared vendor/iconv-lite.js so esbuild hoists a top-level ESM import
// instead of emitting CJS require("./iconv-lite.js") (avoids ERR_REQUIRE_ESM on Node 22.0-22.11).
function createSharedIconvBridgePlugin(state) {
  return {
    name: 'shared-iconv-bridge',
    setup(build) {
      build.onResolve({ filter: /^iconv-lite$/ }, () => {
        state.bridges += 1
        return { path: 'iconv-lite', namespace: 'shared-iconv-bridge' }
      })
      build.onLoad({ filter: /.*/, namespace: 'shared-iconv-bridge' }, () => ({
        contents: `import iconv from './iconv-lite.js';\nmodule.exports = iconv;\n`,
        loader: 'js',
        resolveDir: vendorDir,
      }))
      build.onResolve({ filter: /^\.\/iconv-lite\.js$/ }, () => ({
        path: './iconv-lite.js',
        external: true,
      }))
    },
  }
}

function assertStaticIconvImport(outfile, bundleName) {
  const content = fs.readFileSync(outfile, 'utf8')
  if (!/import\s+[^;]*from\s*["']\.\/iconv-lite\.js["']/.test(content)) {
    throw new Error(
      `[bundle-drivers] ${bundleName} is missing static ESM import from "./iconv-lite.js".`
    )
  }
  if (content.includes('("./iconv-lite.js")') || content.includes("('./iconv-lite.js')")) {
    throw new Error(
      `[bundle-drivers] ${bundleName} contains forbidden CJS require("./iconv-lite.js").`
    )
  }
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

  if (size >= MAX_BYTES) {
    throw new Error(
      `[FAIL] ${name} reaches or exceeds maximum allowed size of 1 MiB (${MAX_BYTES} bytes): got ${size} bytes!`
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

  const bareFunctionMatch = content.match(/(?<![.\w$])Function\s*\(/g)
  if (bareFunctionMatch) {
    throw new Error(
      `[FAIL] ${name} contains prohibited bare 'Function(' call (${bareFunctionMatch.length} occurrences)!`
    )
  }

  const childProcMatch = content.match(/\bchild_process\b/g)
  if (childProcMatch) {
    throw new Error(
      `[FAIL] ${name} contains unexpected 'child_process' reference (${childProcMatch.length} occurrences)!`
    )
  }

  const dynImportMatch = content.match(/\bimport\s*\(/g)
  if (dynImportMatch) {
    throw new Error(
      `[FAIL] ${name} contains unexpected dynamic 'import(' call (${dynImportMatch.length} occurrences)!`
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

async function bundleIconvLite() {
  assertInstalledVersion('iconv-lite')
  const code = `import iconv from 'iconv-lite';\nexport default iconv;\n`
  const outfile = path.join(vendorDir, 'iconv-lite.js')
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
    minify: true,
    charset: 'utf8',
    treeShaking: true,
    legalComments: 'none',
    banner: {
      js: `import { createRequire as __createRequire } from "node:module";\nimport { fileURLToPath as __fileURLToPath } from "node:url";\nimport { dirname as __pathDirname } from "node:path";\nconst require = __createRequire(import.meta.url);\nconst __filename = __fileURLToPath(import.meta.url);\nconst __dirname = __pathDirname(__filename);`,
    },
  })

  validateBundle(outfile, 'vendor/iconv-lite.js', { rejectEscapedRuns: true })
}

async function bundlePostgres() {
  assertInstalledVersion('pg')
  assertInstalledVersion('pg-cursor')
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
    banner: {
      js: `import { createRequire as __createRequire } from "node:module";\nimport { fileURLToPath as __fileURLToPath } from "node:url";\nimport { dirname as __pathDirname } from "node:path";\nconst require = __createRequire(import.meta.url);\nconst __filename = __fileURLToPath(import.meta.url);\nconst __dirname = __pathDirname(__filename);`,
    },
  })

  validateBundle(outfile, 'vendor/pg.js', { rejectEscapedRuns: true })

  // Emit companion TypeScript declaration
  const dtsContent = `
import type * as pgTypes from 'pg'
import type CursorType from 'pg-cursor'

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
export type Result<R extends pgTypes.QueryResultRow = pgTypes.QueryResultRow> = pgTypes.Result<R>
export const Cursor: typeof CursorType

export type {
  PoolConfig,
  PoolClient,
  ClientConfig,
  QueryResult as PgQueryResult,
  QueryResultRow,
  FieldDef,
} from 'pg'

declare const _default: typeof pgTypes & { Cursor: typeof CursorType }
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

  assertInstalledVersion('mysql2', MYSQL2_VERSION)
  assertInstalledVersion('iconv-lite')
  const awsSslState = { replacements: 0 }
  const mockAwsSslPlugin = createMockAwsSslPlugin(awsSslState)
  const iconvBridgeState = { bridges: 0 }
  const sharedIconvBridgePlugin = createSharedIconvBridgePlugin(iconvBridgeState)
  const tlsIpSanState = { loads: 0, replacements: 0 }
  const tlsIpSanPlugin = createMysqlTlsIpSanPlugin(tlsIpSanState)
  const compactErrorsState = { replacements: 0, totalKeys: 0 }
  const compactErrorsPlugin = createCompactMysqlErrorsPlugin(compactErrorsState)

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
    plugins: [mockAwsSslPlugin, sharedIconvBridgePlugin, tlsIpSanPlugin, compactErrorsPlugin],
    minify: true,
    // Keep non-ASCII text as UTF-8 so bundled strings stay literal UTF-8
    // instead of long \xNN / \uNNNN escape runs that trigger Orca directory under-review (code).
    charset: 'utf8',
    treeShaking: true,
    legalComments: 'none',
    banner: {
      js: `import { createRequire as __createRequire } from "node:module";\nimport { fileURLToPath as __fileURLToPath } from "node:url";\nimport { dirname as __pathDirname } from "node:path";\nconst require = __createRequire(import.meta.url);\nconst __filename = __fileURLToPath(import.meta.url);\nconst __dirname = __pathDirname(__filename);`,
    },
  })

  validateBundle(outfile, 'vendor/mysql2.js', { rejectEscapedRuns: true })

  if (awsSslState.replacements !== 1) {
    throw new Error(
      `[bundle-drivers] mock-aws-ssl expected 1 replacement in mysql2, got ${awsSslState.replacements}.`
    )
  }
  if (compactErrorsState.replacements !== 1 || compactErrorsState.totalKeys < 3900) {
    throw new Error(
      `[bundle-drivers] compact-mysql-errors expected 1 replacement (>=3900 keys), got ${JSON.stringify(compactErrorsState)}.`
    )
  }
  if (iconvBridgeState.bridges < 1) {
    throw new Error(
      `[bundle-drivers] shared-iconv-bridge expected >= 1 bridge in mysql2, got ${iconvBridgeState.bridges}.`
    )
  }
  assertStaticIconvImport(outfile, 'vendor/mysql2.js')

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
declare const _default: typeof mysqlTypes
export default _default
`
  fs.writeFileSync(path.join(vendorDir, 'mysql2.d.ts'), dtsContent.trim() + '\n', 'utf8')
}

async function bundleCodeMirror() {
  assertInstalledVersion('@codemirror/autocomplete')
  assertInstalledVersion('@codemirror/commands')
  assertInstalledVersion('@codemirror/lang-sql')
  assertInstalledVersion('@codemirror/language')
  assertInstalledVersion('@codemirror/search')
  assertInstalledVersion('@codemirror/state')
  assertInstalledVersion('@codemirror/view')
  assertInstalledVersion('@lezer/highlight')
  assertInstalledVersion('@replit/codemirror-vim')
  assertInstalledVersion('@replit/codemirror-vim-core')
  const code = `
export { EditorState, EditorSelection, Compartment, StateField, StateEffect, Prec } from '@codemirror/state';
export { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, Decoration, WidgetType, ViewPlugin, hoverTooltip, placeholder } from '@codemirror/view';
export { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
export { HighlightStyle, syntaxHighlighting, LanguageSupport, StreamLanguage, foldGutter, codeFolding, foldKeymap, bracketMatching } from '@codemirror/language';
export { autocompletion, completionKeymap, completionStatus, closeCompletion, acceptCompletion } from '@codemirror/autocomplete';
export { search, searchKeymap, highlightSelectionMatches, openSearchPanel } from '@codemirror/search';
export { sql, SQLite, PostgreSQL, MySQL, MariaSQL, schemaCompletionSource } from '@codemirror/lang-sql';
export { tags } from '@lezer/highlight';
export { vim, getCM, Vim } from '@replit/codemirror-vim';
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
    // Keep browser frame bundle UTF-8 so bundled Vim/CM strings contain zero long \xNN / \uNNNN escape runs.
    charset: 'utf8',
    treeShaking: true,
    legalComments: 'none',
  })

  validateBundle(outfile, 'vendor/codemirror.js', { rejectEscapedRuns: true })

  // Emit companion TypeScript declaration
  const dtsContent = `
export { EditorState, EditorSelection, Compartment, StateField, StateEffect, Prec, type Extension } from '@codemirror/state';
export { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, Decoration, WidgetType, ViewPlugin, hoverTooltip, placeholder, type DecorationSet, type ViewUpdate, type Tooltip } from '@codemirror/view';
export { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
export { HighlightStyle, syntaxHighlighting, LanguageSupport, StreamLanguage, foldGutter, codeFolding, foldKeymap, bracketMatching } from '@codemirror/language';
export { autocompletion, completionKeymap, completionStatus, closeCompletion, acceptCompletion } from '@codemirror/autocomplete';
export { search, searchKeymap, highlightSelectionMatches, openSearchPanel } from '@codemirror/search';
export { sql, SQLite, PostgreSQL, MySQL, MariaSQL, schemaCompletionSource, type SQLDialect } from '@codemirror/lang-sql';
export { tags } from '@lezer/highlight';
export { vim, getCM, Vim, type vimState, type CodeMirror } from '@replit/codemirror-vim';
`
  fs.writeFileSync(path.join(vendorDir, 'codemirror.d.ts'), dtsContent.trim() + '\n', 'utf8')
}

async function bundleMongoDB() {
  assertInstalledVersion('mongodb')
  assertInstalledVersion('bson')
  assertInstalledVersion('mongodb-connection-string-url')
  const mongoCleanState = {
    whatwgUrlReplacements: 0,
    bsonEvalReplacements: 0,
    csfleReplacements: 0,
    gridfsReplacements: 0,
    runtimeOsImportReplacements: 0,
  }
  const mongoCleanPlugin = createMongoCleanPlugin(mongoCleanState)
  const code = `
import * as mongodb from 'mongodb';

const {
  MongoClient,
  ObjectId,
  Decimal128,
  Long,
  Binary,
  UUID,
  Int32,
  Double,
  Timestamp,
  MinKey,
  MaxKey,
  BSONRegExp,
  Code,
  BSON,
} = mongodb;

const { EJSON } = BSON;

export {
  MongoClient,
  ObjectId,
  Decimal128,
  Long,
  Binary,
  UUID,
  Int32,
  Double,
  Timestamp,
  MinKey,
  MaxKey,
  BSONRegExp,
  Code,
  BSON,
  EJSON,
};

export default mongodb;
`

  const outfile = path.join(vendorDir, 'mongodb.js')
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
    plugins: [mongoCleanPlugin],
    external: [
      'kerberos',
      '@mongodb-js/zstd',
      '@aws-sdk/credential-providers',
      'gcp-metadata',
      'snappy',
      'socks',
      'mongodb-client-encryption',
    ],
    minify: true,
    charset: 'utf8',
    treeShaking: true,
    legalComments: 'none',
    banner: {
      js: `import { createRequire as __createRequire } from "node:module";\nimport { fileURLToPath as __fileURLToPath } from "node:url";\nimport { dirname as __pathDirname } from "node:path";\nconst require = __createRequire(import.meta.url);\nconst __filename = __fileURLToPath(import.meta.url);\nconst __dirname = __pathDirname(__filename);`,
    },
  })

  validateBundle(outfile, 'vendor/mongodb.js', { rejectEscapedRuns: true })

  if (mongoCleanState.whatwgUrlReplacements !== 1) {
    throw new Error(
      `[bundle-drivers] mongo-clean expected 1 whatwg-url replacement, got ${mongoCleanState.whatwgUrlReplacements}.`
    )
  }
  if (mongoCleanState.csfleReplacements < 1) {
    throw new Error(
      `[bundle-drivers] mongo-clean expected >= 1 client-side-encryption replacement, got ${mongoCleanState.csfleReplacements}.`
    )
  }
  if (mongoCleanState.gridfsReplacements < 1) {
    throw new Error(
      `[bundle-drivers] mongo-clean expected >= 1 gridfs replacement, got ${mongoCleanState.gridfsReplacements}.`
    )
  }
  if (mongoCleanState.runtimeOsImportReplacements !== 1) {
    throw new Error(
      `[bundle-drivers] mongo-clean expected 1 runtime_adapters os import replacement, got ${mongoCleanState.runtimeOsImportReplacements}.`
    )
  }

  const dtsContent = `
import type * as mongodbTypes from 'mongodb'

export {
  MongoClient,
  ObjectId,
  Decimal128,
  Long,
  Binary,
  UUID,
  Int32,
  Double,
  Timestamp,
  MinKey,
  MaxKey,
  BSONRegExp,
  Code,
  BSON,
} from 'mongodb'

export const EJSON: typeof mongodbTypes.BSON.EJSON

export type * from 'mongodb'

declare const _default: typeof mongodbTypes
export default _default
`
  fs.writeFileSync(path.join(vendorDir, 'mongodb.d.ts'), dtsContent.trim() + '\n', 'utf8')
}

async function bundleMSSQL() {
  assertInstalledVersion('mssql')
  assertInstalledVersion('tedious')
  assertInstalledVersion('iconv-lite')
  const azureTediousState = { resolved: new Map() }
  const mockAzureTediousPlugin = createMockAzureTediousPlugin(azureTediousState)
  const readableStreamState = { replacements: 0 }
  const aliasReadableStreamPlugin = createAliasReadableStreamPlugin(readableStreamState)
  const iconvBridgeState = { bridges: 0 }
  const sharedIconvBridgePlugin = createSharedIconvBridgePlugin(iconvBridgeState)
  const jodaShimState = { replacements: 0 }
  const tediousJodaShimPlugin = createTediousJodaShimPlugin(jodaShimState)
  const code = `
import mssql from 'mssql';

const {
  ConnectionPool,
  Transaction,
  Request,
  TYPES,
  ISOLATION_LEVEL,
  PreparedStatement,
  Table,
  NVarChar,
  VarChar,
  Int,
  BigInt,
  Float,
  Bit,
  DateTime,
  DateTime2,
  DateTimeOffset,
  UniqueIdentifier,
  VarBinary,
  Decimal,
} = mssql;

export {
  ConnectionPool,
  Transaction,
  Request,
  TYPES,
  ISOLATION_LEVEL,
  PreparedStatement,
  Table,
  NVarChar,
  VarChar,
  Int,
  BigInt,
  Float,
  Bit,
  DateTime,
  DateTime2,
  DateTimeOffset,
  UniqueIdentifier,
  VarBinary,
  Decimal,
};

export default mssql;
`

  const outfile = path.join(vendorDir, 'mssql.js')
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
    plugins: [
      mockAzureTediousPlugin,
      aliasReadableStreamPlugin,
      sharedIconvBridgePlugin,
      tediousJodaShimPlugin,
    ],
    minify: true,
    charset: 'utf8',
    treeShaking: true,
    legalComments: 'none',
    banner: {
      js: `import { createRequire as __createRequire } from "node:module";\nimport { fileURLToPath as __fileURLToPath } from "node:url";\nimport { dirname as __pathDirname } from "node:path";\nconst require = __createRequire(import.meta.url);\nconst __filename = __fileURLToPath(import.meta.url);\nconst __dirname = __pathDirname(__filename);`,
    },
  })

  validateBundle(outfile, 'vendor/mssql.js', { rejectEscapedRuns: true })

  if (
    azureTediousState.resolved.get('@azure/identity') !== 1 ||
    azureTediousState.resolved.get('@azure/core-auth') !== 1
  ) {
    throw new Error(
      `[bundle-drivers] mock-azure-tedious expected 1x @azure/identity and 1x @azure/core-auth, got identity=${azureTediousState.resolved.get('@azure/identity') ?? 0}, core-auth=${azureTediousState.resolved.get('@azure/core-auth') ?? 0}.`
    )
  }
  if (readableStreamState.replacements !== 1) {
    throw new Error(
      `[bundle-drivers] alias-readable-stream expected 1 replacement from bl/bl.js, got ${readableStreamState.replacements}.`
    )
  }
  if (iconvBridgeState.bridges < 1) {
    throw new Error(
      `[bundle-drivers] shared-iconv-bridge expected >= 1 bridge in mssql, got ${iconvBridgeState.bridges}.`
    )
  }
  if (jodaShimState.replacements !== 2) {
    throw new Error(
      `[bundle-drivers] tedious-joda-shim expected 2 replacements (datetime.js & temporal.js), got ${jodaShimState.replacements}.`
    )
  }
  assertStaticIconvImport(outfile, 'vendor/mssql.js')

  const dtsContent = `
import type * as mssqlTypes from 'mssql'

export {
  ConnectionPool,
  Transaction,
  Request,
  TYPES,
  ISOLATION_LEVEL,
  PreparedStatement,
  Table,
  NVarChar,
  VarChar,
  Int,
  BigInt,
  Float,
  Bit,
  DateTime,
  DateTime2,
  DateTimeOffset,
  UniqueIdentifier,
  VarBinary,
  Decimal,
} from 'mssql'

export type * from 'mssql'

declare const _default: typeof mssqlTypes
export default _default
`
  fs.writeFileSync(path.join(vendorDir, 'mssql.d.ts'), dtsContent.trim() + '\n', 'utf8')
}

async function bundleOracleDB() {
  assertInstalledVersion('oracledb')
  const code = `
import oracledb from 'oracledb';

const {
  getConnection,
  createPool,
  getPool,
  OUT_FORMAT_OBJECT,
  OUT_FORMAT_ARRAY,
  ARRAY,
  OBJECT,
  BIND_IN,
  BIND_OUT,
  BIND_INOUT,
  DB_TYPE_BFILE,
  DB_TYPE_BINARY_DOUBLE,
  DB_TYPE_BINARY_FLOAT,
  DB_TYPE_BINARY_INTEGER,
  DB_TYPE_BLOB,
  DB_TYPE_BOOLEAN,
  DB_TYPE_CHAR,
  DB_TYPE_CLOB,
  DB_TYPE_CURSOR,
  DB_TYPE_DATE,
  DB_TYPE_INTERVAL_DS,
  DB_TYPE_INTERVAL_YM,
  DB_TYPE_JSON,
  DB_TYPE_LONG,
  DB_TYPE_LONG_NVARCHAR,
  DB_TYPE_LONG_RAW,
  DB_TYPE_NCHAR,
  DB_TYPE_NCLOB,
  DB_TYPE_NUMBER,
  DB_TYPE_NVARCHAR,
  DB_TYPE_OBJECT,
  DB_TYPE_RAW,
  DB_TYPE_ROWID,
  DB_TYPE_TIMESTAMP,
  DB_TYPE_TIMESTAMP_LTZ,
  DB_TYPE_TIMESTAMP_TZ,
  DB_TYPE_VARCHAR,
  DB_TYPE_XMLTYPE,
  DB_TYPE_VECTOR,
  BLOB,
  BUFFER,
  CLOB,
  CURSOR,
  DATE,
  NCLOB,
  NUMBER,
  STRING,
  DEFAULT,
  STMT_TYPE_UNKNOWN,
  STMT_TYPE_SELECT,
  STMT_TYPE_UPDATE,
  STMT_TYPE_DELETE,
  STMT_TYPE_INSERT,
  STMT_TYPE_CREATE,
  STMT_TYPE_DROP,
  STMT_TYPE_ALTER,
  STMT_TYPE_BEGIN,
  STMT_TYPE_DECLARE,
  STMT_TYPE_CALL,
  STMT_TYPE_EXPLAIN_PLAN,
  STMT_TYPE_MERGE,
  STMT_TYPE_ROLLBACK,
  STMT_TYPE_COMMIT,
} = oracledb;

export {
  getConnection,
  createPool,
  getPool,
  OUT_FORMAT_OBJECT,
  OUT_FORMAT_ARRAY,
  ARRAY,
  OBJECT,
  BIND_IN,
  BIND_OUT,
  BIND_INOUT,
  DB_TYPE_BFILE,
  DB_TYPE_BINARY_DOUBLE,
  DB_TYPE_BINARY_FLOAT,
  DB_TYPE_BINARY_INTEGER,
  DB_TYPE_BLOB,
  DB_TYPE_BOOLEAN,
  DB_TYPE_CHAR,
  DB_TYPE_CLOB,
  DB_TYPE_CURSOR,
  DB_TYPE_DATE,
  DB_TYPE_INTERVAL_DS,
  DB_TYPE_INTERVAL_YM,
  DB_TYPE_JSON,
  DB_TYPE_LONG,
  DB_TYPE_LONG_NVARCHAR,
  DB_TYPE_LONG_RAW,
  DB_TYPE_NCHAR,
  DB_TYPE_NCLOB,
  DB_TYPE_NUMBER,
  DB_TYPE_NVARCHAR,
  DB_TYPE_OBJECT,
  DB_TYPE_RAW,
  DB_TYPE_ROWID,
  DB_TYPE_TIMESTAMP,
  DB_TYPE_TIMESTAMP_LTZ,
  DB_TYPE_TIMESTAMP_TZ,
  DB_TYPE_VARCHAR,
  DB_TYPE_XMLTYPE,
  DB_TYPE_VECTOR,
  BLOB,
  BUFFER,
  CLOB,
  CURSOR,
  DATE,
  NCLOB,
  NUMBER,
  STRING,
  DEFAULT,
  STMT_TYPE_UNKNOWN,
  STMT_TYPE_SELECT,
  STMT_TYPE_UPDATE,
  STMT_TYPE_DELETE,
  STMT_TYPE_INSERT,
  STMT_TYPE_CREATE,
  STMT_TYPE_DROP,
  STMT_TYPE_ALTER,
  STMT_TYPE_BEGIN,
  STMT_TYPE_DECLARE,
  STMT_TYPE_CALL,
  STMT_TYPE_EXPLAIN_PLAN,
  STMT_TYPE_MERGE,
  STMT_TYPE_ROLLBACK,
  STMT_TYPE_COMMIT,
};

export default oracledb;
`

  const oracleThinCleanState = { replacements: 0 }
  const oracleThinCleanPlugin = createOracleThinCleanPlugin(oracleThinCleanState)

  const outfile = path.join(vendorDir, 'oracledb.js')
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
    plugins: [oracleThinCleanPlugin],
    minify: true,
    charset: 'utf8',
    treeShaking: true,
    legalComments: 'none',
    banner: {
      js: `import { createRequire as __createRequire } from "node:module";\nimport { fileURLToPath as __fileURLToPath } from "node:url";\nimport { dirname as __pathDirname } from "node:path";\nconst require = __createRequire(import.meta.url);\nconst __filename = __fileURLToPath(import.meta.url);\nconst __dirname = __pathDirname(__filename);`,
    },
  })

  if (oracleThinCleanState.replacements !== 19) {
    throw new Error(
      `[bundle-drivers] oracle-thin-clean expected 19 SODA/AQ stub replacements, got ${oracleThinCleanState.replacements}.`
    )
  }

  validateBundle(outfile, 'vendor/oracledb.js', { rejectEscapedRuns: true })

  const dtsContent = `
import type OracleDB from 'oracledb'

export const getConnection: typeof OracleDB.getConnection
export const createPool: typeof OracleDB.createPool
export const getPool: typeof OracleDB.getPool
export const OUT_FORMAT_OBJECT: typeof OracleDB.OUT_FORMAT_OBJECT
export const OUT_FORMAT_ARRAY: typeof OracleDB.OUT_FORMAT_ARRAY
export const ARRAY: typeof OracleDB.OUT_FORMAT_ARRAY
export const OBJECT: typeof OracleDB.OUT_FORMAT_OBJECT
export const BIND_IN: typeof OracleDB.BIND_IN
export const BIND_OUT: typeof OracleDB.BIND_OUT
export const BIND_INOUT: typeof OracleDB.BIND_INOUT
export const DB_TYPE_BFILE: typeof OracleDB.DB_TYPE_BFILE
export const DB_TYPE_BINARY_DOUBLE: typeof OracleDB.DB_TYPE_BINARY_DOUBLE
export const DB_TYPE_BINARY_FLOAT: typeof OracleDB.DB_TYPE_BINARY_FLOAT
export const DB_TYPE_BINARY_INTEGER: typeof OracleDB.DB_TYPE_BINARY_INTEGER
export const DB_TYPE_BLOB: typeof OracleDB.DB_TYPE_BLOB
export const DB_TYPE_BOOLEAN: typeof OracleDB.DB_TYPE_BOOLEAN
export const DB_TYPE_CHAR: typeof OracleDB.DB_TYPE_CHAR
export const DB_TYPE_CLOB: typeof OracleDB.DB_TYPE_CLOB
export const DB_TYPE_CURSOR: typeof OracleDB.DB_TYPE_CURSOR
export const DB_TYPE_DATE: typeof OracleDB.DB_TYPE_DATE
export const DB_TYPE_INTERVAL_DS: typeof OracleDB.DB_TYPE_INTERVAL_DS
export const DB_TYPE_INTERVAL_YM: typeof OracleDB.DB_TYPE_INTERVAL_YM
export const DB_TYPE_JSON: typeof OracleDB.DB_TYPE_JSON
export const DB_TYPE_LONG: typeof OracleDB.DB_TYPE_LONG
export const DB_TYPE_LONG_NVARCHAR: typeof OracleDB.DB_TYPE_LONG_NVARCHAR
export const DB_TYPE_LONG_RAW: typeof OracleDB.DB_TYPE_LONG_RAW
export const DB_TYPE_NCHAR: typeof OracleDB.DB_TYPE_NCHAR
export const DB_TYPE_NCLOB: typeof OracleDB.DB_TYPE_NCLOB
export const DB_TYPE_NUMBER: typeof OracleDB.DB_TYPE_NUMBER
export const DB_TYPE_NVARCHAR: typeof OracleDB.DB_TYPE_NVARCHAR
export const DB_TYPE_OBJECT: typeof OracleDB.DB_TYPE_OBJECT
export const DB_TYPE_RAW: typeof OracleDB.DB_TYPE_RAW
export const DB_TYPE_ROWID: typeof OracleDB.DB_TYPE_ROWID
export const DB_TYPE_TIMESTAMP: typeof OracleDB.DB_TYPE_TIMESTAMP
export const DB_TYPE_TIMESTAMP_LTZ: typeof OracleDB.DB_TYPE_TIMESTAMP_LTZ
export const DB_TYPE_TIMESTAMP_TZ: typeof OracleDB.DB_TYPE_TIMESTAMP_TZ
export const DB_TYPE_VARCHAR: typeof OracleDB.DB_TYPE_VARCHAR
export const DB_TYPE_XMLTYPE: typeof OracleDB.DB_TYPE_XMLTYPE
export const DB_TYPE_VECTOR: typeof OracleDB.DB_TYPE_VECTOR
export const BLOB: typeof OracleDB.BLOB
export const BUFFER: typeof OracleDB.BUFFER
export const CLOB: typeof OracleDB.CLOB
export const CURSOR: typeof OracleDB.CURSOR
export const DATE: typeof OracleDB.DATE
export const NCLOB: typeof OracleDB.NCLOB
export const NUMBER: typeof OracleDB.NUMBER
export const STRING: typeof OracleDB.STRING
export const DEFAULT: typeof OracleDB.DEFAULT
export const STMT_TYPE_UNKNOWN: typeof OracleDB.STMT_TYPE_UNKNOWN
export const STMT_TYPE_SELECT: typeof OracleDB.STMT_TYPE_SELECT
export const STMT_TYPE_UPDATE: typeof OracleDB.STMT_TYPE_UPDATE
export const STMT_TYPE_DELETE: typeof OracleDB.STMT_TYPE_DELETE
export const STMT_TYPE_INSERT: typeof OracleDB.STMT_TYPE_INSERT
export const STMT_TYPE_CREATE: typeof OracleDB.STMT_TYPE_CREATE
export const STMT_TYPE_DROP: typeof OracleDB.STMT_TYPE_DROP
export const STMT_TYPE_ALTER: typeof OracleDB.STMT_TYPE_ALTER
export const STMT_TYPE_BEGIN: typeof OracleDB.STMT_TYPE_BEGIN
export const STMT_TYPE_DECLARE: typeof OracleDB.STMT_TYPE_DECLARE
export const STMT_TYPE_CALL: typeof OracleDB.STMT_TYPE_CALL
export const STMT_TYPE_EXPLAIN_PLAN: typeof OracleDB.STMT_TYPE_EXPLAIN_PLAN
export const STMT_TYPE_MERGE: typeof OracleDB.STMT_TYPE_MERGE
export const STMT_TYPE_ROLLBACK: typeof OracleDB.STMT_TYPE_ROLLBACK
export const STMT_TYPE_COMMIT: typeof OracleDB.STMT_TYPE_COMMIT

export type Connection = OracleDB.Connection
export type Pool = OracleDB.Pool
export type Lob = OracleDB.Lob
export type ResultSet<T = unknown> = OracleDB.ResultSet<T>
export type Result<T = unknown> = OracleDB.Result<T>
export type Results<T = unknown> = OracleDB.Results<T>
export type ExecuteOptions = OracleDB.ExecuteOptions
export type ExecuteManyOptions = OracleDB.ExecuteManyOptions
export type BindParameter = OracleDB.BindParameter
export type BindDefinition = OracleDB.BindDefinition
export type BindParameters = OracleDB.BindParameters
export type ConnectionAttributes = OracleDB.ConnectionAttributes
export type PoolAttributes = OracleDB.PoolAttributes
export type GetPooledConnectionOptions = OracleDB.GetPooledConnectionOptions
export type CloseConnectionOptions = OracleDB.CloseConnectionOptions
export type Metadata<T = unknown> = OracleDB.Metadata<T>
export type DBError = OracleDB.DBError
export type QueryStreamOptions = OracleDB.QueryStreamOptions
export type DbType = OracleDB.DbType
export type BaseDBObject = OracleDB.BaseDBObject
export type DBObjectClass<T = unknown> = OracleDB.DBObjectClass<T>
export type IntervalYM = OracleDB.IntervalYM
export type IntervalDS = OracleDB.IntervalDS
export type JsonId = OracleDB.JsonId
export type SparseVector = OracleDB.SparseVector
export type Pipeline = OracleDB.Pipeline

declare const _default: typeof OracleDB
export default _default
`
  fs.writeFileSync(path.join(vendorDir, 'oracledb.d.ts'), dtsContent.trim() + '\n', 'utf8')
}

async function bundleBigInteger() {
  assertInstalledVersion('big-integer')
  const code = `import bigInt from 'big-integer';\nexport default bigInt;\n`
  const outfile = path.join(vendorDir, 'big-integer.js')
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
    minify: true,
    charset: 'utf8',
    treeShaking: true,
    legalComments: 'none',
  })

  validateBundle(outfile, 'vendor/big-integer.js', { rejectEscapedRuns: true })

  const dts = `export interface BigIntegerInstance {
  toString(radix?: number, alphabet?: string): string
  valueOf(): number
}

export type BigIntegerValue = number | string | bigint | BigIntegerInstance

export interface BigIntegerStatic {
  (value?: BigIntegerValue, radix?: BigIntegerValue, alphabet?: string, caseSensitive?: boolean): BigIntegerInstance
}

declare const bigInt: BigIntegerStatic
export default bigInt
`
  fs.writeFileSync(path.join(vendorDir, 'big-integer.d.ts'), dts, 'utf8')
}

async function buildSqlParserBundle({ filename, dtsFilename, code, exportedClasses }) {
  const outfile = path.join(vendorDir, filename)
  const bigIntBridgeState = { bridges: 0 }
  const sharedBigIntBridgePlugin = createSharedBigIntBridgePlugin(bigIntBridgeState)
  await esbuild.build({
    stdin: { contents: code, resolveDir: projectRoot, loader: 'js' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: ['node22', 'es2022'],
    outfile,
    plugins: [sharedBigIntBridgePlugin],
    minify: true,
    charset: 'utf8',
    treeShaking: true,
    legalComments: 'none',
  })
  if (bigIntBridgeState.bridges < 1) {
    throw new Error(
      `[bundle-drivers] shared-bigint-bridge expected >= 1 bridge in ${filename}, got ${bigIntBridgeState.bridges}.`
    )
  }
  assertStaticBigIntImport(outfile, `vendor/${filename}`)
  validateBundle(outfile, `vendor/${filename}`, { rejectEscapedRuns: true })

  const classDecls = exportedClasses
    .map((cls) => `export declare class ${cls} implements SqlParserInstance {\n  astify(sql: string): unknown\n}`)
    .join('\n\n')
  const dts = `export interface SqlParserLocationPoint {
  offset: number
  line: number
  column: number
}

export interface SqlParserLocation {
  start: SqlParserLocationPoint
  end: SqlParserLocationPoint
}

export interface SqlParserInstance {
  astify(sql: string): unknown
}

${classDecls}
`
  fs.writeFileSync(path.join(vendorDir, dtsFilename), dts, 'utf8')
}

async function bundleSqlParsers() {
  assertInstalledVersion('node-sql-parser')
  assertInstalledVersion('big-integer')

  await buildSqlParserBundle({
    filename: 'sql-parser-pg-sqlite.js',
    dtsFilename: 'sql-parser-pg-sqlite.d.ts',
    code: `
import pg from 'node-sql-parser/build/postgresql';
import sqlite from 'node-sql-parser/build/sqlite';

export const PostgresParser = pg.Parser;
export const SqliteParser = sqlite.Parser;
`,
    exportedClasses: ['PostgresParser', 'SqliteParser'],
  })

  await buildSqlParserBundle({
    filename: 'sql-parser-mysql-mssql.js',
    dtsFilename: 'sql-parser-mysql-mssql.d.ts',
    code: `
import mysql from 'node-sql-parser/build/mysql';
import tsql from 'node-sql-parser/build/transactsql';

export const MysqlParser = mysql.Parser;
export const MssqlParser = tsql.Parser;
`,
    exportedClasses: ['MysqlParser', 'MssqlParser'],
  })
}

const SSH2_NODE_FS_COMPAT = 'node_modules/ssh2/lib/protocol/node-fs-compat.js'
const SSH2_NODE_FS_COMPAT_ANCHOR = "    return new Function('return 2n ** 32n')();"
const SSH2_NODE_FS_COMPAT_PATCH = '    return 2n ** 32n;'
const SSH2_AGENT_PATH = 'node_modules/ssh2/lib/agent.js'
const SSH2_AGENT_ANCHOR = "const { execFile, spawn } = require('child_process');"
const SSH2_AGENT_PATCH =
  "const execFile = (_f, _a, _o, cb) => { const fn = typeof _o === 'function' ? _o : cb; if (typeof fn === 'function') fn(new Error('External SSH agent process execution is disabled')); };\nconst spawn = () => { throw new Error('External SSH agent process execution is disabled'); };"
const SSH2_SFTP_PATH = 'node_modules/ssh2/lib/protocol/SFTP.js'

function createSsh2CleanPlugin(state) {
  const expectedFsCompatPath = path.resolve(projectRoot, SSH2_NODE_FS_COMPAT)
  const expectedAgentPath = path.resolve(projectRoot, SSH2_AGENT_PATH)
  const expectedSftpPath = path.resolve(projectRoot, SSH2_SFTP_PATH)
  return {
    name: 'ssh2-clean',
    setup(build) {
      build.onResolve({ filter: /^(?:cpu-features|.*\.node)$/ }, args => {
        state.nativeStubs += 1
        return { path: args.path, namespace: 'ssh2-native-stub' }
      })
      build.onLoad({ filter: /.*/, namespace: 'ssh2-native-stub' }, () => ({
        contents: 'module.exports = undefined;',
        loader: 'js',
      }))
      build.onLoad({ filter: /[\\/]ssh2[\\/]lib[\\/]protocol[\\/]SFTP\.js$/ }, args => {
        if (path.resolve(args.path) !== expectedSftpPath) {
          throw new Error(
            `[bundle-drivers] ssh2-clean matched unexpected SFTP.js: ${args.path}`
          )
        }
        state.sftpReplacements += 1
        return {
          contents: `'use strict';
class SFTP {
  constructor() {
    throw new Error('Datanoa bundled ssh2 does not include SFTP (TCP bastion tunnel only).');
  }
}
module.exports = { SFTP };`,
          loader: 'js',
        }
      })
      build.onLoad(
        { filter: /[\\/]ssh2[\\/]lib[\\/]protocol[\\/]node-fs-compat\.js$/ },
        args => {
          if (path.resolve(args.path) !== expectedFsCompatPath) {
            throw new Error(
              `[bundle-drivers] ssh2-clean matched unexpected node-fs-compat: ${args.path}`
            )
          }
          const source = fs.readFileSync(args.path, 'utf8')
          const count = source.split(SSH2_NODE_FS_COMPAT_ANCHOR).length - 1
          if (count !== 1) {
            throw new Error(
              `[bundle-drivers] ssh2-clean expected 1 new Function anchor in ${SSH2_NODE_FS_COMPAT}; found ${count}`
            )
          }
          state.nodeFsCompatReplacements += 1
          return {
            contents: source.replace(SSH2_NODE_FS_COMPAT_ANCHOR, SSH2_NODE_FS_COMPAT_PATCH),
            loader: 'js',
          }
        }
      )
      build.onLoad({ filter: /[\\/]ssh2[\\/]lib[\\/]agent\.js$/ }, args => {
        if (path.resolve(args.path) !== expectedAgentPath) {
          throw new Error(
            `[bundle-drivers] ssh2-clean matched unexpected agent.js: ${args.path}`
          )
        }
        const source = fs.readFileSync(args.path, 'utf8')
        const count = source.split(SSH2_AGENT_ANCHOR).length - 1
        if (count !== 1) {
          throw new Error(
            `[bundle-drivers] ssh2-clean expected 1 child_process anchor in ${SSH2_AGENT_PATH}; found ${count}`
          )
        }
        state.agentChildProcessReplacements += 1
        return {
          contents: source.replace(SSH2_AGENT_ANCHOR, SSH2_AGENT_PATCH),
          loader: 'js',
        }
      })
    },
  }
}

async function bundleSsh2() {
  assertInstalledVersion('ssh2')
  assertInstalledVersion('asn1')
  assertInstalledVersion('bcrypt-pbkdf')
  assertInstalledVersion('tweetnacl')

  const outfile = path.join(vendorDir, 'ssh2.js')
  const state = {
    nativeStubs: 0,
    nodeFsCompatReplacements: 0,
    agentChildProcessReplacements: 0,
    sftpReplacements: 0,
  }
  const code = `
import Client from 'ssh2/lib/client.js';
import { parseKey } from 'ssh2/lib/protocol/keyParser.js';

export { Client, parseKey };
export default { Client, parseKey };
`

  await esbuild.build({
    stdin: { contents: code, resolveDir: projectRoot, loader: 'js' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: ['node22', 'es2022'],
    outfile,
    minify: true,
    charset: 'utf8',
    treeShaking: true,
    legalComments: 'none',
    banner: {
      js: `import { createRequire as __createRequire } from "node:module";\nimport { fileURLToPath as __fileURLToPath } from "node:url";\nimport { dirname as __pathDirname } from "node:path";\nconst require = __createRequire(import.meta.url);\nconst __filename = __fileURLToPath(import.meta.url);\nconst __dirname = __pathDirname(__filename);`,
    },
    plugins: [createSsh2CleanPlugin(state)],
  })

  if (
    state.agentChildProcessReplacements !== 1 ||
    state.sftpReplacements !== 1
  ) {
    throw new Error(
      `[bundle-drivers] ssh2-clean expected 1 agent and 1 SFTP replacement; got ${JSON.stringify(state)}`
    )
  }

  validateBundle(outfile, 'vendor/ssh2.js', { rejectEscapedRuns: true })

  const dts = `import type { Duplex } from 'node:stream'

export interface Ssh2ConnectConfig {
  host?: string
  port?: number
  sock?: Duplex
  username?: string
  password?: string
  privateKey?: Buffer | string
  passphrase?: string
  agent?: string
  tryKeyboard?: boolean
  readyTimeout?: number
  keepaliveInterval?: number
  keepaliveCountMax?: number
  hostHash?: 'sha256' | 'md5'
  hostVerifier?: (key: Buffer | string, verify?: (valid: boolean) => void) => boolean | void
  algorithms?: {
    serverHostKey?: string[]
  }
}

export interface Ssh2ClientChannel extends Duplex {
  close(): void
}

export interface Ssh2KeyboardInteractivePrompt {
  prompt: string
  echo?: boolean
}

export declare class Client {
  constructor()
  connect(config: Ssh2ConnectConfig): this
  forwardOut(
    srcIP: string,
    srcPort: number,
    dstIP: string,
    dstPort: number,
    callback: (err: Error | undefined, channel: Ssh2ClientChannel) => void
  ): this
  end(): this
  destroy(): this
  on(event: 'ready' | 'close' | 'end', listener: () => void): this
  on(event: 'error', listener: (err: Error & { level?: string; code?: string }) => void): this
  on(
    event: 'keyboard-interactive',
    listener: (
      name: string,
      instructions: string,
      instructionsLang: string,
      prompts: Ssh2KeyboardInteractivePrompt[],
      finish: (responses: string[]) => void
    ) => void
  ): this
  on(event: string, listener: (...args: unknown[]) => void): this
  once(event: 'ready' | 'close' | 'end', listener: () => void): this
  once(event: 'error', listener: (err: Error & { level?: string; code?: string }) => void): this
  once(event: string, listener: (...args: unknown[]) => void): this
  removeAllListeners(event?: string): this
}

export interface Ssh2ParsedKey {
  type: string
  comment: string
  getPublicSSH(): Buffer
}

export declare function parseKey(
  data: Buffer | string,
  passphrase?: string
): Ssh2ParsedKey | Ssh2ParsedKey[] | Error

declare const _default: {
  Client: typeof Client
  parseKey: typeof parseKey
}
export default _default
`
  fs.writeFileSync(path.join(vendorDir, 'ssh2.d.ts'), dts, 'utf8')
}

async function main() {
  console.log('[bundle-drivers] Starting vendor drivers bundling...')
  const startTime = Date.now()

  try {
    await bundleIconvLite()
    await bundlePostgres()
    await bundleMySQL()
    await bundleMongoDB()
    await bundleMSSQL()
    await bundleOracleDB()
    await bundleCodeMirror()
    await bundleBigInteger()
    await bundleSqlParsers()
    await bundleSsh2()

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2)
    console.log(`[bundle-drivers] All vendor bundles built successfully in ${elapsed}s!`)
  } catch (err) {
    console.error(`[bundle-drivers] Build failed:`, err)
    process.exit(1)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main()
}
