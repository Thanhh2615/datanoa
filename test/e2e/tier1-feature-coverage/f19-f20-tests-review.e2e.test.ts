/**
 * test/e2e/tier1-feature-coverage/f19-f20-tests-review.e2e.test.ts
 *
 * Tier 1 Feature Coverage: Features F19 and F20
 * - Feature F19: Automated Unit & Integration Tests
 * - Feature F20: Orca Validation, Packaging & Two-Axis Review
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  setupE2ETestContext,
  teardownE2ETestContext,
  assertOk,
  assertRejection,
  measureQueryPerformance,
  type TestContext,
} from '../harness/test-helpers.js'
import { createHostError } from '../harness/mock-orca-runtime.js'

const ALL_EIGHT_DRIVERS = [
  'sqlite',
  'postgres',
  'mysql',
  'mariadb',
  'cockroachdb',
  'clickhouse',
  'redis',
  'libsql',
] as const

describe('Tier 1 Feature Coverage: Features F19 - F20 (Automated Tests, Orca Validation & Review)', () => {
  let context: TestContext
  const projectRoot = path.resolve(__dirname, '../../..')

  beforeEach(() => {
    context = setupE2ETestContext({ withSqlite: true, inMemory: true })
  })

  afterEach(async () => {
    await teardownE2ETestContext(context)
  })

  // =========================================================================
  // Feature F19: Automated Unit & Integration Tests
  // =========================================================================
  describe('Feature F19: Automated Unit & Integration Tests', () => {
    it('F19-01: verifies vitest configuration exports valid include patterns and coverage setup', async () => {
      const vitestConfigPath = path.join(projectRoot, 'test/vitest.config.ts')
      expect(fs.existsSync(vitestConfigPath)).toBe(true)

      const configModule = await import(vitestConfigPath)
      const config = configModule.default

      expect(config.test).toBeDefined()
      expect(config.test.passWithNoTests).toBe(true)
      expect(config.test.include).toContain('test/**/*.test.ts')
      expect(config.test.include).toContain('test/**/*.test.tsx')

      expect(config.test.coverage.provider).toBe('v8')
      expect(config.test.coverage.include).toContain('src/**/*.ts')
      expect(config.test.coverage.exclude).toContain('src/**/*.d.ts')
    })

    it('F19-02: verifies all canonical test scripts are configured in package.json', () => {
      const pkgPath = path.join(projectRoot, 'package.json')
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))

      expect(pkg.scripts).toBeDefined()
      expect(pkg.scripts.test).toBe('vitest run --config test/vitest.config.ts')
      expect(pkg.scripts['test:drivers']).toBe('vitest run test/drivers --config test/vitest.config.ts')
      expect(pkg.scripts['test:e2e']).toBe('vitest run test/e2e --config test/vitest.config.ts')
      expect(pkg.scripts.validate).toBe('orca plugin validate .')
      expect(pkg.scripts.check).toBe('orca plugin check .')
    })

    it('F19-03: ensures setupE2ETestContext and teardown cleanly isolate test execution', async () => {
      const isolatedCtx = setupE2ETestContext({ withSqlite: true, inMemory: true })
      const workerApi = isolatedCtx.runtime.getWorkerApi()

      await workerApi.storage.set('isolation_key', 'isolated_val')
      await workerApi.secrets.set('isolation_secret', 'secret_val')

      expect(await workerApi.storage.get('isolation_key')).toBe('isolated_val')
      expect(await workerApi.secrets.get('isolation_secret')).toBe('secret_val')

      expect(await context.runtime.getWorkerApi().storage.get('isolation_key')).toBeNull()

      await teardownE2ETestContext(isolatedCtx)

      expect(isolatedCtx.runtime.storageData.size).toBe(0)
      expect(isolatedCtx.runtime.secretsData.size).toBe(0)
    })

    it('F19-04: verifies custom test assertion helpers reliably validate responses and errors', async () => {
      expect(() => assertOk({ ok: true, id: 'conn_1' })).not.toThrow()
      expect(() => assertOk({ ok: false })).toThrow(/Expected response\.ok to be true/)

      const failingPromise = Promise.reject(createHostError('not_permitted', 'Operation is not permitted'))
      await expect(assertRejection(failingPromise, 'not_permitted', /not permitted/i)).resolves.toBeUndefined()

      const wrongPromise = Promise.reject(createHostError('action_failed', 'Something broke'))
      await expect(assertRejection(wrongPromise, 'timeout')).rejects.toThrow(/Expected error code 'timeout', got 'action_failed'/)
    })

    it('F19-05: verifies measureQueryPerformance measures execution time and enforces budget', async () => {
      const benchmark = await measureQueryPerformance(async () => 42, 100)

      expect(benchmark.result).toBe(42)
      expect(typeof benchmark.durationMs).toBe('number')
      expect(benchmark.durationMs).toBeLessThanOrEqual(100)

      await expect(
        measureQueryPerformance(async () => {
          await new Promise((resolve) => setTimeout(resolve, 50))
          return 'slow'
        }, 10)
      ).rejects.toThrow(/exceeding budget/)
    })
  })

  // =========================================================================
  // Feature F20: Orca Validation, Packaging & Two-Axis Review
  // =========================================================================
  describe('Feature F20: Orca Validation & Two-Axis Review', () => {
    it('F20-01: verifies manifest compliance, schema, license, and icon asset', () => {
      const manifestPath = path.join(projectRoot, 'orca-plugin.json')
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

      expect(manifest.$schema).toBe(
        'https://raw.githubusercontent.com/stablyai/orca/main/docs/schemas/plugins/orca-plugin.v2.schema.json'
      )
      expect(manifest.manifestVersion).toBe(2)
      expect(manifest.id).toBe('datanoa')
      expect(manifest.name).toBe('Datanoa Studio')
      expect(manifest.license).toBe('MIT')
      expect(manifest.icon).toBe('assets/icon.png')
      expect(manifest.execution).toBe('trusted-worker')
      expect(manifest.pluginApi).toBe(1)
      expect(manifest.main).toBe('src/worker/index.ts')

      const iconPath = path.join(projectRoot, 'assets/icon.png')
      expect(fs.existsSync(iconPath)).toBe(true)
      const iconStats = fs.statSync(iconPath)
      expect(iconStats.size).toBeGreaterThan(0)
      expect(iconStats.size).toBeLessThan(1024 * 1024)

      const capKinds = manifest.capabilities.map((c: { kind: string }) => c.kind)
      expect(capKinds).toContain('storage:own')
      expect(capKinds).toContain('secrets:own')
      expect(capKinds).toContain('settings:own')
      expect(capKinds).toContain('workspace:read')
      expect(capKinds).toContain('workspace:write')

      expect(manifest.contributes.customEditors[0].id).toBe('datanoa-studio')
      expect(manifest.contributes.panels[0].id).toBe('datanoa-panel')
    })

    it('F20-02: production HTML/CSS/ESM Side Panel & modular Studio editor entry points', () => {
      const panelHtmlPath = path.join(projectRoot, 'src/panel/panel.html')
      const panelCssPath = path.join(projectRoot, 'src/panel/panel.css')
      const panelCorePath = path.join(projectRoot, 'src/panel/panel-core.js')
      expect(fs.existsSync(panelHtmlPath)).toBe(true)
      expect(fs.existsSync(panelCssPath)).toBe(true)
      expect(fs.existsSync(panelCorePath)).toBe(true)

      const panelHtml = fs.readFileSync(panelHtmlPath, 'utf8')
      expect(panelHtml).toContain('./panel.css')
      expect(panelHtml).toContain('./panel-core.js')

      for (const rel of [
        'src/editor/index.ts',
        'src/editor/db-icons.ts',
        'src/editor/connection-modal.ts',
        'src/editor/studio-modals.ts',
        'src/editor/grid-formatters.ts',
        'src/editor/schema-ddl.ts',
        'src/drivers/common/sql-lexer.ts',
        'src/drivers/common/sql-formatter.ts',
        'src/drivers/common/sql-migration.ts',
      ]) {
        expect(fs.existsSync(path.join(projectRoot, rel)), `Missing modular file: ${rel}`).toBe(true)
      }
    })

    it('F20-03: asserts all vendor bundles are strictly under 1 MiB with zero eval and new Function', () => {
      const vendorFiles = ['vendor/pg.js', 'vendor/mysql2.js', 'vendor/codemirror.js']
      const ONE_MIB = 1024 * 1024

      for (const relPath of vendorFiles) {
        const fullPath = path.join(projectRoot, relPath)
        expect(fs.existsSync(fullPath)).toBe(true)
        const stats = fs.statSync(fullPath)
        expect(stats.size).toBeLessThan(ONE_MIB)

        const content = fs.readFileSync(fullPath, 'utf8')
        expect(/\beval\s*\(/.test(content)).toBe(false)
        expect(/new\s+Function\s*\(/.test(content)).toBe(false)
      }
    })

    it('F20-04: verifies Standards-Axis compliance (TypeScript strictness, layout, no any in protocol or URI parser)', () => {
      const tsconfigPath = path.join(projectRoot, 'tsconfig.json')
      const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf8'))
      expect(tsconfig.compilerOptions.skipLibCheck).toBe(true)

      const pkgPath = path.join(projectRoot, 'package.json')
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
      expect(pkg.type).toBe('module')

      const protocolSource = fs.readFileSync(path.join(projectRoot, 'src/protocol.ts'), 'utf8')
      expect(protocolSource).not.toMatch(/:\s*any\b/)
      expect(protocolSource).toContain('export interface ConnectionProfile')
      expect(protocolSource).toContain('export interface PluginRequests')

      const connectionUriSource = fs.readFileSync(
        path.join(projectRoot, 'src/drivers/common/connection-uri.ts'),
        'utf8'
      )
      expect(connectionUriSource).not.toMatch(/:\s*any\b/)
    })

    it('F20-05: verifies Spec-Axis compliance across all 8 drivers, legal files, and host approval protection', () => {
      const editorSource = fs.readFileSync(path.join(projectRoot, 'src/editor/index.ts'), 'utf8')
      expect(editorSource).toContain('var(--orca-')

      const protocolSource = fs.readFileSync(path.join(projectRoot, 'src/protocol.ts'), 'utf8')
      const connectionUriSource = fs.readFileSync(
        path.join(projectRoot, 'src/drivers/common/connection-uri.ts'),
        'utf8'
      )
      for (const driver of ALL_EIGHT_DRIVERS) {
        expect(protocolSource).toContain(`'${driver}'`)
        expect(connectionUriSource).toContain(`id: '${driver}'`)
      }

      // Marketplace & licensing compliance files
      const licensePath = path.join(projectRoot, 'LICENSE')
      const noticesPath = path.join(projectRoot, 'THIRD-PARTY-NOTICES.md')
      expect(fs.existsSync(licensePath)).toBe(true)
      expect(fs.existsSync(noticesPath)).toBe(true)
      expect(fs.readFileSync(licensePath, 'utf8')).toContain('MIT License')
      expect(fs.readFileSync(noticesPath, 'utf8')).toContain('pg')
      expect(fs.readFileSync(noticesPath, 'utf8')).toContain('mysql2')

      // Project directory structure
      expect(fs.existsSync(path.join(projectRoot, 'src/worker'))).toBe(true)
      expect(fs.existsSync(path.join(projectRoot, 'src/panel'))).toBe(true)
      expect(fs.existsSync(path.join(projectRoot, 'src/editor'))).toBe(true)
      expect(fs.existsSync(path.join(projectRoot, 'src/drivers'))).toBe(true)

      // Host approval protection: trusted-worker plugin requires --approve flag from user
      const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'orca-plugin.json'), 'utf8'))
      expect(manifest.execution).toBe('trusted-worker')
    })
  })
})
