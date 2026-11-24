import esbuild from 'esbuild'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DATANOA_APP_VERSION } from '../src/shared-constants'
import {
  AI_MAX_IPC_PREFIX_CHARS,
  AI_MAX_IPC_SUFFIX_CHARS,
} from '../src/shared-cm-inline-ai.js'
import {
  AI_RPC_MAX_PREFIX_CHARS,
  AI_RPC_MAX_SUFFIX_CHARS,
} from '../src/worker/ai-client'

const PROJECT_ROOT = process.cwd()
const EXPECTED_VERSION = '1.2.0'
const MAX_VENDOR_BYTES = 1024 * 1024

const EXPECTED_VENDOR_DEV_DEPS = [
  '@codemirror/autocomplete',
  '@codemirror/commands',
  '@codemirror/lang-sql',
  '@codemirror/language',
  '@codemirror/search',
  '@codemirror/state',
  '@codemirror/view',
  '@lezer/highlight',
  'mongodb',
  'mssql',
  'mysql2',
  'oracledb',
  'pg',
  'pg-cursor',
] as const

const VENDOR_JS_BUNDLES = [
  'iconv-lite.js',
  'pg.js',
  'mysql2.js',
  'mongodb.js',
  'mssql.js',
  'oracledb.js',
  'codemirror.js',
] as const

describe('v1.2.0 build, legal notices, version sync & release hygiene', () => {
  it('synchronizes version 1.2.0 across all 5 canonical release locations', () => {
    const orcaPlugin = JSON.parse(
      fs.readFileSync(path.join(PROJECT_ROOT, 'orca-plugin.json'), 'utf8')
    ) as { version?: string }
    const pkgJson = JSON.parse(
      fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')
    ) as { version?: string }
    const panelCoreSrc = fs.readFileSync(
      path.join(PROJECT_ROOT, 'src', 'panel', 'panel-core.js'),
      'utf8'
    )
    const readmeSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'README.md'), 'utf8')

    expect(orcaPlugin.version).toBe(EXPECTED_VERSION)
    expect(pkgJson.version).toBe(EXPECTED_VERSION)
    expect(DATANOA_APP_VERSION).toBe(EXPECTED_VERSION)
    expect(panelCoreSrc).toMatch(/export\s+const\s+DATANOA_VERSION\s*=\s*['"]1\.2\.0['"]/)
    expect(readmeSrc).toContain(`#v${EXPECTED_VERSION}`)
    expect(readmeSrc).not.toContain('#v1.1.2')
  })

  it('exact-pins all 14 bundled vendor devDependencies in package.json without ^ or ~', () => {
    const pkgJson = JSON.parse(
      fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')
    ) as { devDependencies?: Record<string, string> }
    const devDeps = pkgJson.devDependencies ?? {}

    for (const pkgName of EXPECTED_VENDOR_DEV_DEPS) {
      const range = devDeps[pkgName]
      expect(range, `Missing vendor devDependency ${pkgName}`).toBeDefined()
      expect(range, `${pkgName} must be exact-pinned without ^ or ~`).toMatch(/^\d+\.\d+\.\d+$/)

      const installedPkg = JSON.parse(
        fs.readFileSync(
          path.join(PROJECT_ROOT, 'node_modules', ...pkgName.split('/'), 'package.json'),
          'utf8'
        )
      ) as { version: string }
      expect(range, `${pkgName} pin should match installed node_modules version`).toBe(
        installedPkg.version
      )
    }
  })

  it('keeps build/check-package-size.mjs and build/bundle-drivers.mjs guards strict and clean', () => {
    const checkSizeSrc = fs.readFileSync(
      path.join(PROJECT_ROOT, 'build', 'check-package-size.mjs'),
      'utf8'
    )
    expect(checkSizeSrc).toContain("'.datanoa'")
    expect(checkSizeSrc).toContain("'.vite'")
    expect(checkSizeSrc).toContain('MAX_TOTAL_BYTES = 25_000_000')
    expect(checkSizeSrc).toContain('MAX_VENDOR_FILE_BYTES = 1024 * 1024')
    expect(checkSizeSrc).toContain('>= MAX_VENDOR_FILE_BYTES')

    const bundleSrc = fs.readFileSync(
      path.join(PROJECT_ROOT, 'build', 'bundle-drivers.mjs'),
      'utf8'
    )
    expect(bundleSrc).toContain('size >= MAX_BYTES')
    expect(bundleSrc).toContain('\\beval\\s*\\(')
    expect(bundleSrc).toContain('new\\s+Function\\s*\\(')
    expect(bundleSrc).toContain('assertStaticIconvImport')
  })

  it('verifies all 7 vendor bundles are strictly < 1 MiB, CSP-clean, and use static ESM iconv-lite import', () => {
    const vendorDir = path.join(PROJECT_ROOT, 'vendor')

    for (const file of VENDOR_JS_BUNDLES) {
      const fullPath = path.join(vendorDir, file)
      expect(fs.existsSync(fullPath), `Expected vendor/${file} to exist`).toBe(true)
      const stat = fs.statSync(fullPath)
      expect(stat.size, `vendor/${file} must be strictly < 1 MiB`).toBeLessThan(MAX_VENDOR_BYTES)

      const content = fs.readFileSync(fullPath, 'utf8')
      expect(content, `vendor/${file} must contain zero eval(`).not.toMatch(/\beval\s*\(/)
      expect(content, `vendor/${file} must contain zero new Function(`).not.toMatch(
        /new\s+Function\s*\(/
      )
    }

    for (const sharedConsumer of ['mysql2.js', 'mssql.js']) {
      const content = fs.readFileSync(path.join(vendorDir, sharedConsumer), 'utf8')
      expect(
        content,
        `vendor/${sharedConsumer} must hoist static ESM import from ./iconv-lite.js`
      ).toMatch(/import\s+[^;]*from\s*["']\.\/iconv-lite\.js["']/)
      expect(content).not.toContain('("./iconv-lite.js")')
      expect(content).not.toContain("('./iconv-lite.js')")
    }

    const dtsFiles = fs.readdirSync(vendorDir).filter((name) => name.endsWith('.d.ts'))
    expect(dtsFiles.length).toBeGreaterThanOrEqual(6)
    for (const file of dtsFiles) {
      const content = fs.readFileSync(path.join(vendorDir, file), 'utf8')
      expect(content, `vendor/${file} must not contain ': any'`).not.toMatch(/:\s*any\b/)
      expect(content, `vendor/${file} must not contain 'as any'`).not.toMatch(/\bas\s+any\b/)
    }
  })

  it('smoke-imports Node vendor bundles cleanly via ESM', async () => {
    const [iconvMod, pgMod, mysqlMod, mongoMod, mssqlMod, oracleMod] = await Promise.all([
      import('../vendor/iconv-lite.js'),
      import('../vendor/pg.js'),
      import('../vendor/mysql2.js'),
      import('../vendor/mongodb.js'),
      import('../vendor/mssql.js'),
      import('../vendor/oracledb.js'),
    ])

    expect(typeof iconvMod.default?.encode).toBe('function')
    expect(typeof pgMod.Pool).toBe('function')
    expect(typeof mysqlMod.createPool).toBe('function')
    expect(typeof mongoMod.MongoClient).toBe('function')
    expect(typeof mssqlMod.ConnectionPool).toBe('function')
    expect(typeof oracleMod.getConnection).toBe('function')
  })

  it('covers 100% of all esbuild-bundled npm packages and required upstream notices in THIRD-PARTY-NOTICES.md', async () => {
    const notices = fs.readFileSync(path.join(PROJECT_ROOT, 'THIRD-PARTY-NOTICES.md'), 'utf8')

    const mockAws: esbuild.Plugin = {
      name: 'mock-aws-ssl',
      setup(build) {
        build.onResolve({ filter: /^aws-ssl-profiles$/ }, (args) => ({
          path: args.path,
          namespace: 'mock-aws',
        }))
        build.onLoad({ filter: /.*/, namespace: 'mock-aws' }, () => ({
          contents: 'module.exports = { ca: [] }',
          loader: 'js',
        }))
      },
    }
    const mongoClean: esbuild.Plugin = {
      name: 'mongo-clean',
      setup(build) {
        build.onResolve({ filter: /^whatwg-url$/ }, (args) => ({
          path: args.path,
          namespace: 'mock-whatwg',
        }))
        build.onLoad({ filter: /.*/, namespace: 'mock-whatwg' }, () => ({
          contents: 'module.exports = { URL: globalThis.URL, URLSearchParams: globalThis.URLSearchParams }',
          loader: 'js',
        }))
      },
    }
    const mockAzure: esbuild.Plugin = {
      name: 'mock-azure',
      setup(build) {
        build.onResolve({ filter: /^@azure\/(identity|core-auth|keyvault-keys)$/ }, (args) => ({
          path: args.path,
          namespace: 'mock-azure',
        }))
        build.onLoad({ filter: /.*/, namespace: 'mock-azure' }, () => ({
          contents: 'module.exports = {}',
          loader: 'js',
        }))
      },
    }
    const aliasStream: esbuild.Plugin = {
      name: 'alias-stream',
      setup(build) {
        build.onResolve({ filter: /^readable-stream(\/.*)?$/ }, () => ({
          path: 'node:stream',
          external: true,
        }))
      },
    }
    const sharedIconv: esbuild.Plugin = {
      name: 'shared-iconv',
      setup(build) {
        build.onResolve({ filter: /^iconv-lite$/ }, () => ({
          path: './iconv-lite.js',
          external: true,
        }))
      },
    }

    const specs: Array<{
      code: string
      platform: 'node' | 'browser'
      plugins: esbuild.Plugin[]
      external: string[]
    }> = [
      {
        code: 'import iconv from "iconv-lite"; export default iconv;',
        platform: 'node',
        plugins: [],
        external: [],
      },
      {
        code: 'import pg from "pg"; import Cursor from "pg-cursor"; export { pg, Cursor };',
        platform: 'node',
        plugins: [],
        external: ['pg-native', 'pg-cloudflare'],
      },
      {
        code: 'import mysql from "mysql2"; import * as mp from "mysql2/promise"; export { mysql, mp };',
        platform: 'node',
        plugins: [mockAws, sharedIconv],
        external: [],
      },
      {
        code: 'export { EditorState } from "@codemirror/state"; export { EditorView } from "@codemirror/view"; export { defaultKeymap } from "@codemirror/commands"; export { HighlightStyle } from "@codemirror/language"; export { autocompletion } from "@codemirror/autocomplete"; export { search } from "@codemirror/search"; export { sql } from "@codemirror/lang-sql"; export { tags } from "@lezer/highlight";',
        platform: 'browser',
        plugins: [],
        external: [],
      },
      {
        code: 'import * as mongodb from "mongodb"; export default mongodb;',
        platform: 'node',
        plugins: [mongoClean],
        external: [
          'kerberos',
          '@mongodb-js/zstd',
          '@aws-sdk/credential-providers',
          'gcp-metadata',
          'snappy',
          'socks',
          'mongodb-client-encryption',
        ],
      },
      {
        code: 'import mssql from "mssql"; export default mssql;',
        platform: 'node',
        plugins: [mockAzure, aliasStream, sharedIconv],
        external: [],
      },
      {
        code: 'import oracledb from "oracledb"; export default oracledb;',
        platform: 'node',
        plugins: [],
        external: [],
      },
    ]

    const discoveredPackages = new Map<string, string>()
    for (const spec of specs) {
      const result = await esbuild.build({
        stdin: { contents: spec.code, resolveDir: PROJECT_ROOT, loader: 'js' },
        bundle: true,
        write: false,
        metafile: true,
        platform: spec.platform,
        format: 'esm',
        plugins: spec.plugins,
        external: spec.external,
      })
      for (const inputPath of Object.keys(result.metafile.inputs)) {
        const normalized = inputPath.replace(/\\/g, '/')
        const match = normalized.match(/node_modules\/(@[^/]+\/[^/]+|[^/]+)\//)
        if (!match) continue
        const pkgName = match[1]
        if (!discoveredPackages.has(pkgName)) {
          const pkgJson = JSON.parse(
            fs.readFileSync(
              path.join(PROJECT_ROOT, 'node_modules', ...pkgName.split('/'), 'package.json'),
              'utf8'
            )
          ) as { version: string }
          discoveredPackages.set(pkgName, pkgJson.version)
        }
      }
    }

    expect(discoveredPackages.size).toBe(58)

    for (const [pkgName, version] of discoveredPackages.entries()) {
      expect(
        notices,
        `THIRD-PARTY-NOTICES.md is missing bundled package ${pkgName}@${version}`
      ).toContain(`${pkgName}@${version}`)
    }

    // Critical verbatim legal notices
    expect(notices).toContain('Copyright (c) 2015, 2026, Oracle and/or its affiliates.')
    expect(notices).toContain('The Universal Permissive License (UPL), Version 1.0')
    expect(notices).toContain('Copyright Node.js contributors. All rights reserved.')
    expect(notices).toContain('Copyright Joyent, Inc. and other Node contributors. All rights reserved.')
    expect(notices).toContain('Apache License')
    expect(notices).toContain('Version 2.0, January 2004')
    expect(notices).toContain('Copyright (c) 2016, Philipp Thürwächter & Pattrick Hüper')
    expect(notices).toContain('Neither the name of js-joda nor the names of its contributors')
    expect(notices).toContain('mongodb@7.9.1')
    expect(notices).toContain('bson@7.3.4')
    expect(notices).toContain('mssql@12.8.1')
    expect(notices).toContain('tedious@20.4.2')
    expect(notices).toContain('iconv-lite@0.7.3')
    expect(notices).toContain('long@5.3.2')
    expect(notices).toContain('SIL OPEN FONT LICENSE Version 1.1')
  }, 20000)

  it('keeps client and worker AI IPC prefix/suffix caps in exact parity (8000 / 4000)', () => {
    expect(AI_MAX_IPC_PREFIX_CHARS).toBe(8000)
    expect(AI_MAX_IPC_SUFFIX_CHARS).toBe(4000)
    expect(AI_RPC_MAX_PREFIX_CHARS).toBe(AI_MAX_IPC_PREFIX_CHARS)
    expect(AI_RPC_MAX_SUFFIX_CHARS).toBe(AI_MAX_IPC_SUFFIX_CHARS)
  })
})
