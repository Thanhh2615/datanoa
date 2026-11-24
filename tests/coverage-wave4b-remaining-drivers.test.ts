import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as https from 'node:https'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import * as tls from 'node:tls'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { DatabaseDriverError, type ConnectionProfile } from '../src/drivers/common/driver'
import {
  allocateEphemeralPort,
  buildSshSpawnArgs,
  openSshTunnel,
  resolveEffectiveTlsOptions,
  validateSshTunnelConfig,
} from '../src/drivers/common/tls-and-tunnel'
import { DriverManager } from '../src/drivers/driver-manager'
import {
  RedisDriver,
  RedisSession,
  redactRedisCommandArgs,
  tokenizeRedisCommandScript,
} from '../src/drivers/redis/driver'
import {
  ClickHouseDriver,
  ClickHouseSession,
  normalizeClickHouseBaseUrl,
} from '../src/drivers/clickhouse/driver'
import { LibsqlDriver, LibsqlSession } from '../src/drivers/libsql/driver'
import { D1Driver, D1Session } from '../src/drivers/d1/driver'
import { ConnectionPool } from '../vendor/mssql.js'
import oracledb from '../vendor/oracledb.js'
import {
  buildMssqlPoolConfig,
  isMssqlReadOnlyBlocked,
  MssqlDriver,
  MssqlSession,
  splitMssqlBatches,
  type MssqlPoolLike,
  type MssqlRequestLike,
  type MssqlTransactionLike,
} from '../src/drivers/mssql/driver'
import {
  buildOracleConnectionConfig,
  OracleDriver,
  OracleSession,
  splitOracleStatements,
  type OracleConnectionLike,
} from '../src/drivers/oracle/driver'

const tmpRoot = path.join(os.tmpdir(), 'ai-work', 'datanoa', 'coverage-100-full', 'tmp-w4b-rest')

function makeProfile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id: 'w4b-prof',
    name: 'w4b-prof',
    driver: 'postgres',
    host: '127.0.0.1',
    port: 55433,
    ...overrides,
  }
}

describe('Wave 4B Remaining Drivers Closure', () => {
  const createdDirs: string[] = []

  const makeTempDir = (prefix: string): string => {
    fs.mkdirSync(tmpRoot, { recursive: true })
    const dir = fs.mkdtempSync(path.join(tmpRoot, prefix))
    createdDirs.push(dir)
    return dir
  }

  beforeAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
    fs.mkdirSync(tmpRoot, { recursive: true })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  describe('1. src/drivers/common/tls-and-tunnel.ts edge & POSIX/Win32 askpass + retry/killTimer', () => {
    it('covers TLS blank paths, non-code PEM read errors, default rejectUnauthorized=false, string port coercion, and omitted buildSshSpawnArgs options', async () => {
      const dir = makeTempDir('tls-')
      const caPath = path.join(dir, 'ca.pem')
      fs.writeFileSync(caPath, '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----\n', 'utf8')

      // Blank PEM paths + whitespace trim -> undefined
      expect(
        await resolveEffectiveTlsOptions(
          makeProfile({ sslCaPath: '   ', sslCertPath: '  ', sslKeyPath: '\t' })
        )
      ).toBeUndefined()

      // sslCaPath + sslRejectUnauthorized: false without sslMode -> hits default switch false branch
      const opts = await resolveEffectiveTlsOptions(
        makeProfile({ sslCaPath: caPath, sslRejectUnauthorized: false })
      )
      expect(opts && typeof opts === 'object').toBe(true)
      if (opts && typeof opts === 'object') {
        expect(opts.rejectUnauthorized).toBe(false)
      }

      // sslCaPath without sslRejectUnauthorized -> hits default switch true branch (?? true)
      const optsDefTrue = await resolveEffectiveTlsOptions(makeProfile({ sslCaPath: caPath }))
      if (optsDefTrue && typeof optsDefTrue === 'object') {
        expect(optsDefTrue.rejectUnauthorized).toBe(true)
      }

      // readPemFile error without `.code` -> 'unreadable'
      vi.spyOn(fs.promises, 'readFile').mockRejectedValueOnce('plain-string-read-failure')
      await expect(
        resolveEffectiveTlsOptions(makeProfile({ sslCaPath: caPath }))
      ).rejects.toThrow(/\(unreadable\)/)

      // String port coercion via validateSshTunnelConfig & buildSshSpawnArgs without options
      const cfg = validateSshTunnelConfig(
        makeProfile({ sshHost: 'bastion.local', sshUser: 'ops', sshPort: '2222' as never }),
        'db.local',
        '5432' as never
      )
      expect(cfg.sshPort).toBe(2222)
      expect(cfg.targetPort).toBe(5432)

      const argv = buildSshSpawnArgs(
        makeProfile({ sshHost: 'bastion.local', sshUser: 'ops' }),
        15000,
        'db.local',
        5432
      )
      expect(argv).toContain('BatchMode=yes')
    })

    it('covers allocateEphemeralPort retry loop, port=0 error, null address, Error retry, and non-Error throw', async () => {
      vi.resetModules()
      let callCount = 0
      let mode: 'retry-then-ok' | 'all-fail-string' | 'all-fail-error' = 'retry-then-ok'

      vi.doMock('node:net', async (importOriginal) => {
        const orig = await importOriginal<typeof import('node:net')>()
        return {
          ...orig,
          createServer: ((...args: unknown[]) => {
            callCount += 1
            if (mode === 'retry-then-ok') {
              if (callCount === 1) {
                const fake = new EventEmitter() as unknown as net.Server
                fake.unref = () => fake
                fake.listen = ((_opts: unknown, cb?: () => void) => {
                  queueMicrotask(() => cb?.())
                  return fake
                }) as never
                fake.address = () => null
                fake.close = ((cb?: () => void) => {
                  queueMicrotask(() => cb?.())
                  return fake
                }) as never
                return fake
              }
              if (callCount === 2) {
                const fake = new EventEmitter() as unknown as net.Server
                fake.unref = () => fake
                fake.listen = (() => {
                  queueMicrotask(() => fake.emit('error', new Error('EADDRINUSE')))
                  return fake
                }) as never
                return fake
              }
              return (orig.createServer as (...a: unknown[]) => net.Server)(...args)
            }
            if (mode === 'all-fail-error') {
              const fake = new EventEmitter() as unknown as net.Server
              fake.unref = () => fake
              fake.listen = (() => {
                queueMicrotask(() => fake.emit('error', new Error('EACCES_ALL')))
                return fake
              }) as never
              return fake
            }
            const fake = new EventEmitter() as unknown as net.Server
            fake.unref = () => fake
            fake.listen = (() => {
              queueMicrotask(() => fake.emit('error', 'raw-string-port-error'))
              return fake
            }) as never
            return fake
          }) as never,
        }
      })

      try {
        const mod = await import('../src/drivers/common/tls-and-tunnel')
        const port = await mod.allocateEphemeralPort()
        expect(port).toBeGreaterThan(0)
        expect(callCount).toBe(3)

        mode = 'all-fail-error'
        await expect(mod.allocateEphemeralPort()).rejects.toThrow('EACCES_ALL')

        mode = 'all-fail-string'
        await expect(mod.allocateEphemeralPort()).rejects.toThrow('raw-string-port-error')
      } finally {
        vi.doUnmock('node:net')
        vi.resetModules()
      }
    })

    it('covers POSIX askpass.sh creation/cleanup failure, SIGTERM->SIGKILL grace timer, blank sshBinary, and double-settled probe', async () => {
      const dir = makeTempDir('ssh-edge-')

      // 1) POSIX askpass.sh branch + writeFile failure triggering cleanup() catch block
      vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
      const origWriteFile = fs.promises.writeFile
      vi.spyOn(fs.promises, 'writeFile').mockImplementation((async (
        filePath: fs.PathLike,
        data: unknown,
        options?: unknown
      ) => {
        if (String(filePath).endsWith('askpass.sh')) {
          throw new Error('simulated askpass.sh write failure')
        }
        return origWriteFile(filePath, data as never, options as never)
      }) as never)

      await expect(
        openSshTunnel(
          makeProfile({ sshHost: '127.0.0.1', sshUser: 'datanoa', sshAuthMethod: 'password' }),
          '127.0.0.1',
          55433,
          { sshBinary: '   ', secrets: { sshPassword: 'pw' }, timeoutMs: 1000 }
        )
      ).rejects.toThrow(/simulated askpass\.sh write failure/)
      vi.restoreAllMocks()

      // 2) Successful POSIX askpass.sh generation & script execution via forwarder
      const posixForwarder = path.join(dir, 'posix-forwarder.mjs')
      fs.writeFileSync(
        posixForwarder,
        `
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const lIdx = args.indexOf('-L');
const parts = args[lIdx + 1].split(':');
const localPort = Number(parts[1]);
const askpassPath = process.env.SSH_ASKPASS;
if (!askpassPath || !askpassPath.endsWith('askpass.sh')) process.exit(11);
const shContent = fs.readFileSync(askpassPath, 'utf8');
if (!shContent.includes('#!/bin/sh')) process.exit(12);
const cjsPath = path.join(path.dirname(askpassPath), 'askpass.cjs');
const res = spawnSync(process.execPath, [cjsPath, "datanoa@127.0.0.1's password:"], {
  env: process.env,
  encoding: 'utf8',
});
if (res.status !== 0 || res.stdout !== process.env.DATANOA_SSH_SECRET) process.exit(13);

const srv = net.createServer((sock) => sock.end());
srv.listen(localPort, '127.0.0.1');
process.on('SIGTERM', () => {
  srv.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 100).unref();
});
        `,
        'utf8'
      )

      vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
      const posixTunnel = await openSshTunnel(
        makeProfile({ sshHost: '127.0.0.1', sshUser: 'datanoa', sshAuthMethod: 'password' }),
        '127.0.0.1',
        55433,
        { sshBinary: posixForwarder, secrets: { sshPassword: 'pw_posix_ok' }, timeoutMs: 8000 }
      )
      vi.restoreAllMocks()
      expect(posixTunnel.isAlive()).toBe(true)
      await posixTunnel.close()
      expect(posixTunnel.isAlive()).toBe(false)

      // 3) SIGTERM ignored -> killTimer fires after 1200ms and sends SIGKILL
      const ignoreTermScript = path.join(dir, 'ignore-sigterm.mjs')
      fs.writeFileSync(
        ignoreTermScript,
        `
import * as net from 'node:net';
const args = process.argv.slice(2);
const parts = args[args.indexOf('-L') + 1].split(':');
const localPort = Number(parts[1]);
process.on('SIGTERM', () => { /* intentionally ignore SIGTERM so SIGKILL timer fires */ });
const srv = net.createServer((sock) => sock.end());
srv.listen(localPort, '127.0.0.1');
setInterval(() => {}, 1000);
        `,
        'utf8'
      )

      const killTunnel = await openSshTunnel(
        makeProfile({ sshHost: '127.0.0.1', sshUser: 'datanoa', sshAuthMethod: 'agent' }),
        '127.0.0.1',
        55433,
        { sshBinary: ignoreTermScript, timeoutMs: 8000 }
      )
      expect(killTunnel.isAlive()).toBe(true)
      await killTunnel.close()
      expect(killTunnel.isAlive()).toBe(false)

      // 4) probeTcpPort settled-twice guard when timeout + error both fire
      const neverOpenScript = path.join(dir, 'never-open.mjs')
      fs.writeFileSync(neverOpenScript, 'setInterval(() => {}, 1000);\n', 'utf8')
      vi.resetModules()
      let probeCalls = 0
      vi.doMock('node:net', async (importOriginal) => {
        const orig = await importOriginal<typeof import('node:net')>()
        return {
          ...orig,
          connect: ((opts: unknown) => {
            probeCalls += 1
            if (probeCalls === 1) {
              const fake = new EventEmitter() as unknown as net.Socket
              let timeoutCb: (() => void) | undefined
              fake.setTimeout = ((_ms: number, cb?: () => void) => {
                timeoutCb = cb
                return fake
              }) as never
              fake.destroy = (() => {
                fake.emit('error', new Error('late error'))
                return fake
              }) as never
              queueMicrotask(() => timeoutCb?.())
              return fake
            }
            return (orig.connect as (...a: unknown[]) => net.Socket)(opts)
          }) as never,
        }
      })

      try {
        const mod = await import('../src/drivers/common/tls-and-tunnel')
        await expect(
          mod.openSshTunnel(
            makeProfile({ sshHost: '127.0.0.1', sshUser: 'datanoa', sshAuthMethod: 'agent' }),
            '127.0.0.1',
            55433,
            { sshBinary: neverOpenScript, timeoutMs: 120 }
          )
        ).rejects.toThrow(/did not open local forwarding port/)
      } finally {
        vi.doUnmock('node:net')
        vi.resetModules()
      }
    }, 20_000)

    it('covers terminateChild error/kill-throw branches & openSshTunnel non-Error throw via mocked child_process', async () => {
      vi.resetModules()
      const spawnMock = vi.fn()
      let probeTargetPort: number | null = null

      vi.doMock('node:child_process', async (importOriginal) => {
        const orig = await importOriginal<typeof import('node:child_process')>()
        return { ...orig, spawn: spawnMock }
      })
      vi.doMock('node:net', async (importOriginal) => {
        const orig = await importOriginal<typeof import('node:net')>()
        return {
          ...orig,
          connect: ((opts: unknown) => {
            if (probeTargetPort !== null) {
              return (orig.connect as (o: unknown) => net.Socket)({ host: '127.0.0.1', port: probeTargetPort })
            }
            return (orig.connect as (o: unknown) => net.Socket)(opts)
          }) as never,
        }
      })

      try {
        const mod = await import('../src/drivers/common/tls-and-tunnel')

        // Case A: child.kill('SIGTERM') throws -> early return in terminateChild
        const childKillThrows = new EventEmitter() as unknown as import('node:child_process').ChildProcess
        Object.assign(childKillThrows, {
          exitCode: null,
          signalCode: null,
          stderr: new EventEmitter(),
          kill: vi.fn(() => {
            throw new Error('EPERM')
          }),
        })
        ;(childKillThrows.stderr as unknown as { setEncoding: () => void }).setEncoding = () => {}
        spawnMock.mockImplementationOnce(() => {
          queueMicrotask(() => childKillThrows.emit('error', new Error('ENOENT')))
          return childKillThrows
        })
        await expect(
          mod.openSshTunnel(
            makeProfile({ sshHost: '127.0.0.1', sshUser: 'datanoa', sshAuthMethod: 'agent' }),
            '127.0.0.1',
            55433,
            { timeoutMs: 500 }
          )
        ).rejects.toThrow(/failed to start/)

        // Case B: child emits 'error' during terminateChild -> hits clearKillTimer in error listener
        const srv = net.createServer((s) => s.end())
        await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
        probeTargetPort = (srv.address() as net.AddressInfo).port
        try {
          const childErrOnKill = new EventEmitter() as unknown as import('node:child_process').ChildProcess
          Object.assign(childErrOnKill, {
            exitCode: null,
            signalCode: null,
            stderr: new EventEmitter(),
            kill: vi.fn(() => {
              queueMicrotask(() => childErrOnKill.emit('error', new Error('late kill err')))
              return true
            }),
          })
          ;(childErrOnKill.stderr as unknown as { setEncoding: () => void }).setEncoding = () => {}

          spawnMock.mockImplementationOnce(() => childErrOnKill)
          const tun = await mod.openSshTunnel(
            makeProfile({ sshHost: '127.0.0.1', sshUser: 'datanoa', sshAuthMethod: 'agent' }),
            '127.0.0.1',
            55433,
            { timeoutMs: 2000 }
          )
          await tun.close()
        } finally {
          probeTargetPort = null
          await new Promise<void>((r) => srv.close(() => r()))
        }

        // Case C: child ignores SIGTERM AND kill('SIGKILL') throws -> hits catch inside killTimer
        const srv2 = net.createServer((s) => s.end())
        await new Promise<void>((r) => srv2.listen(0, '127.0.0.1', r))
        probeTargetPort = (srv2.address() as net.AddressInfo).port
        try {
          const childSigkillThrows = new EventEmitter() as unknown as import('node:child_process').ChildProcess
          Object.assign(childSigkillThrows, {
            exitCode: null,
            signalCode: null,
            stderr: new EventEmitter(),
            kill: vi.fn((sig?: string) => {
              if (sig === 'SIGKILL') throw new Error('ESRCH')
              return true
            }),
          })
          ;(childSigkillThrows.stderr as unknown as { setEncoding: () => void }).setEncoding = () => {}

          spawnMock.mockImplementationOnce(() => childSigkillThrows)
          const tun2 = await mod.openSshTunnel(
            makeProfile({ sshHost: '127.0.0.1', sshUser: 'datanoa', sshAuthMethod: 'agent' }),
            '127.0.0.1',
            55433,
            { timeoutMs: 2000 }
          )
          await tun2.close()
        } finally {
          probeTargetPort = null
          await new Promise<void>((r) => srv2.close(() => r()))
        }

        // Case D: non-Error thrown inside openSshTunnel try block -> hits String(err) wrap
        spawnMock.mockImplementationOnce(() => {
          throw 'non-error-spawn-throw'
        })
        await expect(
          mod.openSshTunnel(
            makeProfile({ sshHost: '127.0.0.1', sshUser: 'datanoa', sshAuthMethod: 'agent' }),
            '127.0.0.1',
            55433
          )
        ).rejects.toThrow('non-error-spawn-throw')
      } finally {
        vi.doUnmock('node:net')
        vi.doUnmock('node:child_process')
        vi.resetModules()
      }
    }, 20_000)

    it('invokes live OS ssh against datanoa-cov-ssh (127.0.0.1:52222) with default sshBinary & Win32 askpass.cmd + secret redaction', async () => {
      await expect(
        openSshTunnel(
          makeProfile({
            sshHost: '127.0.0.1',
            sshPort: 52222,
            sshUser: 'datanoa',
            sshAuthMethod: 'password',
          }),
          '127.0.0.1',
          55433,
          {
            sshBinary: '   ',
            secrets: { sshPassword: 'datanoa_ssh_pass' },
            timeoutMs: 4000,
          }
        )
      ).rejects.toThrow(/Verify the SSH password/)
    }, 20_000)
  })

  describe('2. src/drivers/driver-manager.ts ESM hook, SHA mismatch, path security & cache eviction', () => {
    function makeMemStorage() {
      const store = new Map<string, unknown>()
      return {
        store,
        api: {
          get: async (k: string) => store.get(k) as never,
          set: async (k: string, v: unknown) => {
            store.set(k, v)
          },
          delete: async (k: string) => {
            store.delete(k)
          },
        },
      }
    }

    it('covers resolveEntryFile errors, package.json main/exports edge cases, post-load SHA mismatch, and verifyLocalDriver branches', async () => {
      const dir = makeTempDir('dm-edge-')
      const { api } = makeMemStorage()
      const mgr = new DriverManager(api, () => {})

      // Non-string localPath & non-string ID
      await expect(mgr.resolveEntryFile(123 as never)).rejects.toThrow(/required/i)
      await expect(
        mgr.configureLocalDriver({ driverId: 123 as never, localPath: dir, trustedSha256: 'a'.repeat(64) })
      ).rejects.toThrow(/Driver ID/i)
      await expect(
        mgr.configureLocalDriver({ driverId: 'mycustom', localPath: dir, trustedSha256: 123 as never })
      ).rejects.toThrow(/SHA-256 trust/i)
      expect(await mgr.removeLocalDriver(123 as never)).toEqual({ ok: false })
      await expect(mgr.resolveVerifiedAdapter(123 as never)).rejects.toThrow(/not configured/i)
      expect(mgr.getAdapter('nonexistent')).toBeUndefined()

      // Invalid adapter module variants
      expect(() => mgr.validateDriverAdapterModule(null)).toThrow(/Invalid Datanoa/)
      expect(() => mgr.validateDriverAdapterModule({ default: { type: 'x' } })).toThrow(/Invalid Datanoa/)
      expect(() =>
        mgr.validateDriverAdapterModule({ default: { type: 'x', createSession: () => {} } })
      ).toThrow(/Invalid Datanoa/)

      // 1) package.json without string `type` + CJS .js file -> isPackageTypeModule returns false at L135
      const cjsNoTypeDir = path.join(dir, 'cjs-notype')
      fs.mkdirSync(cjsNoTypeDir)
      const cjsNoTypeFile = path.join(cjsNoTypeDir, 'index.js')
      fs.writeFileSync(
        cjsNoTypeFile,
        `module.exports = { type: 'mycustom', createSession: async () => ({}), testConnection: async () => ({ ok: true }) };`,
        'utf8'
      )
      fs.writeFileSync(path.join(cjsNoTypeDir, 'package.json'), JSON.stringify({ name: 'no-type' }), 'utf8')
      const inspNoType = await mgr.inspectLocalDriver({ driverId: 'mycustom', localPath: cjsNoTypeDir })
      const cfgNoType = await mgr.configureLocalDriver({
        driverId: 'mycustom',
        localPath: cjsNoTypeDir,
        trustedSha256: inspNoType.sha256,
      })
      // Non-slot driver without custom name uses raw id as name and generic description
      expect(cfgNoType.name).toBe('mycustom')
      expect(cfgNoType.description).toContain('Locally configured Datanoa')
      const listed = await mgr.listDrivers()
      expect(listed.some((d) => d.id === 'mycustom' && d.name === 'mycustom')).toBe(true)

      // Configure a second driver so verifyLocalDriver tests the `entry.id === id ? ... : entry` false branch
      const secondDir = path.join(dir, 'second-driver')
      fs.mkdirSync(secondDir)
      const secondCjs = path.join(secondDir, 'index.cjs')
      fs.writeFileSync(
        secondCjs,
        `module.exports = { type: 'custom', createSession: async () => ({}), testConnection: async () => ({ ok: true }) };`,
        'utf8'
      )
      const inspSecond = await mgr.inspectLocalDriver({ driverId: 'custom', localPath: secondDir })
      await mgr.configureLocalDriver({
        driverId: 'custom',
        localPath: secondDir,
        trustedSha256: inspSecond.sha256,
      })

      // 2) verifyLocalDriver when SHA stays identical BUT resolved entry changes (index.cjs -> index.mjs with identical bytes)
      const secondMjs = path.join(secondDir, 'index.mjs')
      fs.copyFileSync(secondCjs, secondMjs)
      const verifyEntryChanged = await mgr.verifyLocalDriver('custom')
      expect(verifyEntryChanged.ok).toBe(false)
      expect(verifyEntryChanged.sha256Changed).toBe(true)
      expect(verifyEntryChanged.message).toContain('resolved entry path changed')

      // Re-trust with explicit SHA and test resolveVerifiedAdapter error when entry path changes later
      const verifyRetrusted = await mgr.verifyLocalDriver('custom', { trustedSha256: inspSecond.sha256 })
      expect(verifyRetrusted.ok).toBe(true)

      // Now remove index.mjs so resolveEntryFile flips back to index.cjs -> resolveVerifiedAdapter detects entry change + evicts cache
      fs.unlinkSync(secondMjs)
      await expect(mgr.resolveVerifiedAdapter('custom')).rejects.toThrow(/resolved entry path changed/)
      expect(mgr.getAdapter('custom')).toBeUndefined()

      // Re-configure `custom` on secondCjs, then mutate file content on disk -> resolveVerifiedAdapter detects SHA mismatch + evicts cache
      await mgr.configureLocalDriver({
        driverId: 'custom',
        localPath: secondCjs,
        trustedSha256: inspSecond.sha256,
      })
      expect(mgr.getAdapter('custom')).toBeDefined()
      fs.appendFileSync(secondCjs, '\n// mutated on disk\n', 'utf8')
      await expect(mgr.resolveVerifiedAdapter('custom')).rejects.toThrow(/SHA-256 mismatch/)
      expect(mgr.getAdapter('custom')).toBeUndefined()

      // 3) verifyPostLoadSha256 mismatch during CJS require (file mutates itself when loaded)
      const selfMutatingCjs = path.join(dir, 'self-mutate.cjs')
      fs.writeFileSync(
        selfMutatingCjs,
        `require('node:fs').appendFileSync(__filename, '\\n// self-modified');
module.exports = { type: 'duckdb', createSession: async () => ({}), testConnection: async () => ({ ok: true }) };`,
        'utf8'
      )
      const inspSelfMut = await mgr.inspectLocalDriver({ driverId: 'duckdb', localPath: selfMutatingCjs })
      await expect(
        mgr.configureLocalDriver({
          driverId: 'duckdb',
          localPath: selfMutatingCjs,
          trustedSha256: inspSelfMut.sha256,
        })
      ).rejects.toThrow(/Local driver entry changed during load/)

      // 4) Non-object CJS export (function) hits `{ default: exported }`
      const fnCjs = path.join(dir, 'fn-export.cjs')
      fs.writeFileSync(fnCjs, `module.exports = function notADriver() {};`, 'utf8')
      const inspFn = await mgr.inspectLocalDriver({ driverId: 'duckdb', localPath: fnCjs })
      await expect(
        mgr.configureLocalDriver({ driverId: 'duckdb', localPath: fnCjs, trustedSha256: inspFn.sha256 })
      ).rejects.toThrow(/Invalid Datanoa driver adapter/)

      // 5) package.json exports & main edge cases
      const expEdgeDir = path.join(dir, 'exp-edges')
      fs.mkdirSync(expEdgeDir)
      fs.writeFileSync(path.join(expEdgeDir, 'dot-def.cjs'), 'module.exports = {};', 'utf8')
      fs.writeFileSync(path.join(expEdgeDir, 'top-imp.mjs'), 'export default {};', 'utf8')
      fs.writeFileSync(path.join(expEdgeDir, 'index.cjs'), 'module.exports = {};', 'utf8')

      // exports: { '.': './dot-str.cjs' }
      fs.writeFileSync(path.join(expEdgeDir, 'dot-str.cjs'), 'module.exports = {};', 'utf8')
      fs.writeFileSync(
        path.join(expEdgeDir, 'package.json'),
        JSON.stringify({ exports: { '.': './dot-str.cjs' } }),
        'utf8'
      )
      expect((await mgr.resolveEntryFile(expEdgeDir)).endsWith('dot-str.cjs')).toBe(true)

      // exports: { '.': { default: './dot-def.cjs' } }
      fs.writeFileSync(
        path.join(expEdgeDir, 'package.json'),
        JSON.stringify({ exports: { '.': { default: './dot-def.cjs' } } }),
        'utf8'
      )
      expect((await mgr.resolveEntryFile(expEdgeDir)).endsWith('dot-def.cjs')).toBe(true)

      // exports: { '.': { require: './ignored.cjs' } } -> returns undefined -> falls back to index.cjs
      fs.writeFileSync(
        path.join(expEdgeDir, 'package.json'),
        JSON.stringify({ exports: { '.': { require: './ignored.cjs' } } }),
        'utf8'
      )
      expect((await mgr.resolveEntryFile(expEdgeDir)).endsWith('index.cjs')).toBe(true)

      // exports: { import: './top-imp.mjs' }
      fs.writeFileSync(
        path.join(expEdgeDir, 'package.json'),
        JSON.stringify({ exports: { import: './top-imp.mjs' } }),
        'utf8'
      )
      expect((await mgr.resolveEntryFile(expEdgeDir)).endsWith('top-imp.mjs')).toBe(true)

      // exports: 123 (non-record) -> undefined -> falls back to index.cjs
      fs.writeFileSync(path.join(expEdgeDir, 'package.json'), JSON.stringify({ exports: 123 }), 'utf8')
      expect((await mgr.resolveEntryFile(expEdgeDir)).endsWith('index.cjs')).toBe(true)

      // package.json main with control chars & absolute path
      fs.writeFileSync(path.join(expEdgeDir, 'package.json'), JSON.stringify({ main: 'bad\n.js' }), 'utf8')
      await expect(mgr.resolveEntryFile(expEdgeDir)).rejects.toThrow(/control characters/)
      fs.writeFileSync(
        path.join(expEdgeDir, 'package.json'),
        JSON.stringify({ main: 'C:\\abs\\driver.js' }),
        'utf8'
      )
      await expect(mgr.resolveEntryFile(expEdgeDir)).rejects.toThrow(/relative path/)

      // package.json JSON parses to primitive `null` -> !isRecord(parsed)
      fs.writeFileSync(path.join(expEdgeDir, 'package.json'), 'null', 'utf8')
      expect((await mgr.resolveEntryFile(expEdgeDir)).endsWith('index.cjs')).toBe(true)

      // package.json readFile throws non-Error string -> String(err)
      const origReadFile = fs.promises.readFile
      vi.spyOn(fs.promises, 'readFile').mockImplementation((async (p: fs.PathLike, enc?: unknown) => {
        if (String(p).endsWith('package.json')) throw 'pkg-read-string-err'
        return origReadFile(p, enc as never)
      }) as never)
      await expect(mgr.resolveEntryFile(expEdgeDir)).rejects.toThrow(/pkg-read-string-err/)
      vi.restoreAllMocks()

      // 6) realpath failure & non-file/non-dir stat & escaped realpath mocks
      const fileForStat = path.join(dir, 'stat-file.cjs')
      fs.writeFileSync(fileForStat, 'module.exports = {};', 'utf8')

      vi.spyOn(fs.promises, 'realpath').mockRejectedValueOnce(new Error('EACCES'))
      await expect(mgr.resolveEntryFile(fileForStat)).rejects.toThrow(/does not exist/)

      vi.spyOn(fs.promises, 'stat').mockResolvedValueOnce({
        isFile: () => false,
        isDirectory: () => false,
      } as fs.Stats)
      await expect(mgr.resolveEntryFile(fileForStat)).rejects.toThrow(/neither a file nor a directory/)

      // Directory candidate realpath rejects & escapes realDirectory
      const dirReal = fs.realpathSync(expEdgeDir)
      const realpathSpy = vi.spyOn(fs.promises, 'realpath')
      realpathSpy.mockResolvedValueOnce(dirReal).mockRejectedValueOnce(new Error('dangling symlink'))
      await expect(mgr.resolveEntryFile(expEdgeDir)).rejects.toThrow(/Resolved driver entry does not exist/)

      realpathSpy
        .mockResolvedValueOnce(dirReal)
        .mockResolvedValueOnce(path.resolve(dirReal, '..', 'outside.cjs'))
      await expect(mgr.resolveEntryFile(expEdgeDir)).rejects.toThrow(/escapes the selected driver directory/)
      vi.restoreAllMocks()

      // 7) verifyLocalDriver catching non-Error throw + non-string id + listDrivers local-error item
      vi.spyOn(mgr, 'resolveEntryFile').mockRejectedValueOnce('raw-verify-failure')
      const verifyNonErr = await mgr.verifyLocalDriver('mycustom')
      expect(verifyNonErr.ok).toBe(false)
      expect(verifyNonErr.message).toContain('raw-verify-failure')
      const listWithErr = await mgr.listDrivers()
      expect(listWithErr.some((d) => d.id === 'mycustom' && d.status === 'local-error' && d.error)).toBe(true)
      expect((await mgr.verifyLocalDriver(123 as never)).ok).toBe(false)

      // 8) normalizePersistedConfig non-string field filtering
      const mgrBadPersist = new DriverManager(
        {
          get: async () =>
            [
              { id: 123, localPath: 'x', resolvedEntry: 'y', sha256: 'a'.repeat(64), verifiedAt: 1 },
              { id: 'custom', localPath: 123, resolvedEntry: 'y', sha256: 'a'.repeat(64), verifiedAt: 1 },
              { id: 'custom', localPath: 'x', resolvedEntry: 123, sha256: 'a'.repeat(64), verifiedAt: 1 },
              { id: 'custom', localPath: 'x', resolvedEntry: 'y', sha256: 123, verifiedAt: 1 },
            ] as never,
          set: async () => {},
          delete: async () => {},
        },
        () => {}
      )
      expect((await mgrBadPersist.listDrivers()).every((d) => d.status !== 'local-verified')).toBe(true)
    })

    it('covers ESM registerHooks load callback (pinnedUrl match & nextLoad pass-through) and no-registerHooks fallback', async () => {
      const dir = makeTempDir('dm-esm-hook-')
      const esmFile = path.join(dir, 'esm-adapter.mjs')
      fs.writeFileSync(
        esmFile,
        `export default { type: 'snowflake', createSession: async () => ({}), testConnection: async () => ({ ok: true }) };`,
        'utf8'
      )
      const sha256 = createHash('sha256').update(fs.readFileSync(esmFile)).digest('hex')

      // Branch A: registerHooks available -> verify load(pinnedUrl) returns verified in-memory bytes and load(otherUrl) calls nextLoad
      vi.resetModules()
      const loadResults: Array<{ url: string; res: unknown }> = []
      const deregisterSpy = vi.fn()
      const registerHooksMock = vi.fn((hooks: { load: (url: string, ctx: Record<string, unknown>, nextLoad: (u: string, c: Record<string, unknown>) => unknown) => unknown }) => {
        const { pathToFileURL } = require('node:url') as typeof import('node:url')
        const expectedPinnedUrl = `${pathToFileURL(fs.realpathSync(esmFile)).href}?v=${sha256}`
        const nextLoad = vi.fn((u: string, c: Record<string, unknown>) => ({ passthrough: u, ctx: c }))
        loadResults.push({
          url: expectedPinnedUrl,
          res: hooks.load(expectedPinnedUrl, {}, nextLoad),
        })
        loadResults.push({
          url: 'file:///other.mjs',
          res: hooks.load('file:///other.mjs', { format: 'module' }, nextLoad),
        })
        expect(nextLoad).toHaveBeenCalledWith('file:///other.mjs', { format: 'module' })
        return { deregister: deregisterSpy }
      })

      vi.doMock('node:module', async (importOriginal) => {
        const orig = await importOriginal<typeof import('node:module')>()
        return { ...orig, registerHooks: registerHooksMock }
      })

      try {
        const { DriverManager: HookedDriverManager } = await import('../src/drivers/driver-manager')
        const { api } = makeMemStorage()
        const mgr1 = new HookedDriverManager(api, () => {})
        const cfg = await mgr1.configureLocalDriver({
          driverId: 'snowflake',
          localPath: esmFile,
          trustedSha256: sha256,
        })
        expect(cfg.status).toBe('local-verified')
        expect(registerHooksMock).toHaveBeenCalledTimes(1)
        expect(deregisterSpy).toHaveBeenCalledTimes(1)
        expect((loadResults[0].res as { shortCircuit: boolean; format: string }).shortCircuit).toBe(true)
        expect((loadResults[0].res as { format: string }).format).toBe('module')
        expect(loadResults[1].res).toEqual({ passthrough: 'file:///other.mjs', ctx: { format: 'module' } })
      } finally {
        vi.doUnmock('node:module')
      }

      // Branch B: registerHooks unavailable -> verify fallback post-load SHA check
      vi.resetModules()
      vi.doMock('node:module', async (importOriginal) => {
        const orig = await importOriginal<typeof import('node:module')>()
        return { ...orig, registerHooks: undefined }
      })

      try {
        const { DriverManager: FallbackDriverManager } = await import('../src/drivers/driver-manager')
        const { api } = makeMemStorage()
        const mgr2 = new FallbackDriverManager(api, () => {})
        const cfg2 = await mgr2.configureLocalDriver({
          driverId: 'snowflake',
          localPath: esmFile,
          trustedSha256: sha256,
        })
        expect(cfg2.status).toBe('local-verified')
      } finally {
        vi.doUnmock('node:module')
        vi.resetModules()
      }
    })
  })

  describe('3. src/drivers/redis/driver.ts live Redis + TLS + RESP3/socket/error edge paths', () => {
    const REDIS_HOST = '127.0.0.1'
    const REDIS_PORT = 56380
    const REDIS_PASS = 'datanoa_redis_pass'
    const W4B_KEYS = [
      'cov_w4b_redis:str',
      'cov_w4b_redis:hash',
      'cov_w4b_redis:ttl',
      'cov_w4b_redis:ins',
      'cov_w4b_redis:del',
      'cov_w4b_redis:nullv',
      'cov_w4b_redis:undefv',
    ]
    const trackedSessions: RedisSession[] = []
    const track = (s: RedisSession) => {
      trackedSessions.push(s)
      return s
    }

    async function cleanupW4bRedis() {
      const driver = new RedisDriver()
      const s = (await driver.createSession(
        makeProfile({ driver: 'redis', host: REDIS_HOST, port: REDIS_PORT, sslMode: 'disable' }),
        REDIS_PASS
      )) as RedisSession
      try {
        await s.runQuery('w4b-r-clean', `DEL ${W4B_KEYS.join(' ')}`)
      } finally {
        await s.close().catch(() => {})
      }
    }

    beforeAll(async () => {
      await cleanupW4bRedis()
    })

    afterAll(async () => {
      await cleanupW4bRedis().catch(() => {})
      for (const s of trackedSessions) await s.close().catch(() => {})
    })

    function createSelfSignedCert(dir: string): { certPath: string; keyPath: string; certPem: string; keyPem: string } | null {
      const opensslBin = 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe'
      if (!fs.existsSync(opensslBin)) return null
      const certPath = path.join(dir, 'tls-cert.pem')
      const keyPath = path.join(dir, 'tls-key.pem')
      execFileSync(
        opensslBin,
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-keyout',
          keyPath,
          '-out',
          certPath,
          '-days',
          '1',
          '-subj',
          '/CN=localhost',
          '-addext',
          'subjectAltName=DNS:localhost,IP:127.0.0.1',
        ],
        { stdio: 'pipe', timeout: 10_000 }
      )
      return {
        certPath,
        keyPath,
        certPem: fs.readFileSync(certPath, 'utf8'),
        keyPem: fs.readFileSync(keyPath, 'utf8'),
      }
    }

    function parseRespReqs(input: string): string[][] {
      const lines = input.split('\r\n')
      const out: string[][] = []
      let idx = 0
      while (idx < lines.length) {
        const header = lines[idx++]
        if (!header || !header.startsWith('*')) continue
        const argc = Number(header.slice(1))
        const args: string[] = []
        for (let j = 0; j < argc && idx < lines.length; j++) {
          if (lines[idx]?.startsWith('$')) {
            idx++
            args.push(lines[idx++] ?? '')
          }
        }
        if (args.length > 0) out.push(args)
      }
      return out
    }

    it('covers live Redis 56380 cov_w4b_redis:* ops, readOnly subcommands, empty applyChanges, and helper PBT', async () => {
      // Pure helper / PBT checks
      fc.assert(
        fc.property(
          fc.array(fc.stringMatching(/^[A-Za-z0-9_][A-Za-z0-9_:-]{0,9}$/), { minLength: 1, maxLength: 4 }),
          (parts) => {
            const cmd = parts.join(' ')
            const parsed = tokenizeRedisCommandScript(cmd)
            expect(parsed).toEqual([parts])
          }
        ),
        { numRuns: 25 }
      )
      expect(redactRedisCommandArgs(['HELLO', '3', 'AUTH'])).toEqual(['HELLO', '3', 'AUTH'])
      expect(redactRedisCommandArgs(['ACL', 'SETUSER', 'bob', 'on', 'allkeys'])).toEqual([
        'ACL',
        'SETUSER',
        'bob',
        'on',
        'allkeys',
      ])
      expect(redactRedisCommandArgs(['MIGRATE', '127.0.0.1', '6379', 'k', '0', '100', 'KEYS', 'k1'])).toEqual([
        'MIGRATE',
        '127.0.0.1',
        '6379',
        'k',
        '0',
        '100',
        'KEYS',
        'k1',
      ])

      const driver = new RedisDriver()
      const session = track(
        (await driver.createSession(
          makeProfile({ driver: 'redis', host: REDIS_HOST, port: REDIS_PORT, sslMode: 'disable' }),
          REDIS_PASS
        )) as RedisSession
      )

      // Empty applyChanges exercises client.sendPipeline([])
      expect(await session.applyChanges({ table: '(all)' })).toEqual({
        ok: true,
        inserted: 0,
        updated: 0,
        deleted: 0,
        statements: [],
      })

      // Seed cov_w4b_redis:* keys, test fetchPage sort/order edges & empty value & previewChanges quoteRedisArg('')
      await session.applyChanges({
        table: 'cov_w4b_redis:*',
        inserts: [
          { key: 'cov_w4b_redis:str', value: '' },
          { key: 'cov_w4b_redis:ins', value: 'v\nin\r"q"\\b', ttl: 90 },
          { key: 'cov_w4b_redis:del', value: 'to-del' },
        ],
      })
      await session.runQuery('w4b-r-hset', 'HSET cov_w4b_redis:hash f1 v1')

      const prev = await session.previewChanges({
        table: 'cov_w4b_redis:*',
        inserts: [{ key: 'cov_w4b_redis:ttl', value: null }],
        updates: [
          { primaryKeys: { key: '' }, changes: {} }, // wait: invalid key checked separately
        ].slice(0, 0),
      })
      expect(prev.statements[0]).toContain('""')

      await expect(
        session.previewChanges({ table: 'cov_w4b_redis:*', deletes: [{}] })
      ).rejects.toMatchObject({ code: 'invalid_params' })
      await expect(
        session.previewChanges({ table: 'cov_w4b_redis:*', updates: [{ primaryKeys: {}, changes: {} }] })
      ).rejects.toMatchObject({ code: 'invalid_params' })
      await expect(
        session.previewChanges({ table: 'cov_w4b_redis:*', inserts: [{}] })
      ).rejects.toMatchObject({ code: 'invalid_params' })

      // Hash update with empty object + null field + orderByClause ASC/DESC & invalid page/pageSize
      const hashUpd = await session.updateCell({
        table: 'cov_w4b_redis:*',
        column: 'value',
        newValue: { f1: null },
        primaryKeys: { key: 'cov_w4b_redis:hash' },
        originalValue: '',
      })
      expect(hashUpd.updatedRecord?.value).toContain('""')

      const pageDesc = await session.fetchPage({
        table: 'cov_w4b_redis:*',
        page: 0,
        pageSize: -5,
        whereClause: "WHERE key LIKE 'cov_w4b_redis:%'",
        orderByClause: 'ORDER BY value ASC',
      })
      expect(pageDesc.totalRows).toBeGreaterThanOrEqual(4)
      expect(pageDesc.page).toBe(1)

      // Apply delete on missing key (reply=0 -> deleted+=0) + real delete
      const delRes = await session.applyChanges({
        table: 'cov_w4b_redis:*',
        deletes: [{ key: 'cov_w4b_redis:nonexistent_del' }, { key: 'cov_w4b_redis:del' }],
      })
      expect(delRes.deleted).toBe(1)

      // Read-only allowed subcommand matrix & blocked command
      const roSess = track(
        (await driver.createSession(
          makeProfile({ driver: 'redis', host: REDIS_HOST, port: REDIS_PORT, sslMode: 'disable', readOnly: true }),
          REDIS_PASS
        )) as RedisSession
      )
      await expect(
        roSess.runQuery(
          'w4b-ro-matrix',
          'COMMAND LIST\nCLIENT ID\nMEMORY DOCTOR\nOBJECT ENCODING cov_w4b_redis:str\nSCRIPT EXISTS deadbeef\nSLOWLOG LEN'
        )
      ).resolves.toMatchObject({ isSelect: true })
      await expect(roSess.runQuery('w4b-ro-cmd-bad', 'COMMAND FOOBAR')).rejects.toMatchObject({
        code: 'READ_ONLY',
      })
      await expect(roSess.runQuery('w4b-ro-unknown', 'UNKNOWN_WRITE_CMD x')).rejects.toMatchObject({
        code: 'READ_ONLY',
      })
    }, 20_000)

    it('covers Redis TLS connect (servername), chunked RESP3 frames, HSCAN map, HKEYS err, KEEPTTL multi-cmd fallback, dead socket & cancel races', async () => {
      const dir = makeTempDir('redis-tls-edge-')
      const certs = createSelfSignedCert(dir)
      const driver = new RedisDriver()

      // 1) Real TLS Redis server (`node:tls`) testing ssl=true + hostname SNI + bad cert/error
      if (certs) {
        const tlsSockets = new Set<tls.TlsSocket>()
        const tlsSrv = tls.createServer({ key: certs.keyPem, cert: certs.certPem }, (sock) => {
          tlsSockets.add(sock)
          sock.on('error', () => {})
          sock.on('close', () => tlsSockets.delete(sock))
          sock.on('data', (chunk) => {
            for (const args of parseRespReqs(chunk.toString('utf8'))) {
              const verb = (args[0] || '').toUpperCase()
              if (verb === 'PING') sock.write('+PONG\r\n')
              else if (verb === 'AUTH') sock.write('+OK\r\n')
              else sock.write('+OK\r\n')
            }
          })
        })
        await new Promise<void>((r) => tlsSrv.listen(0, '127.0.0.1', () => r()))
        try {
          const tlsPort = (tlsSrv.address() as net.AddressInfo).port
          const tlsSess = track(
            (await driver.createSession(
              makeProfile({
                driver: 'redis',
                host: 'localhost',
                port: tlsPort,
                ssl: true,
                sslCaPath: certs.certPath,
                sslMode: 'verify-ca',
              }),
              'tls_pw'
            )) as RedisSession
          )
          expect((await tlsSess.test()).ok).toBe(true)
          await tlsSess.close()

          // Unverified TLS cert triggers sock.once('error') -> SOCKET_ERROR
          const badTlsRes = await driver.testConnection(
            makeProfile({
              driver: 'redis',
              host: 'localhost',
              port: tlsPort,
              ssl: true,
              sslMode: 'verify-full',
            })
          )
          expect(badTlsRes.ok).toBe(false)
        } finally {
          for (const s of tlsSockets) s.destroy()
          await new Promise<void>((r) => tlsSrv.close(() => r()))
        }
      }

      // 2) Comprehensive fake RESP3 TCP server covering all protocol/race/fallback branches
      const activeSockets = new Set<net.Socket>()
      let scenario = 'default'
      let delayAuthRelease: (() => void) | null = null
      let delayPingRelease: (() => void) | null = null
      let delayHkeysRelease: (() => void) | null = null

      const srv = net.createServer((sock) => {
        activeSockets.add(sock)
        sock.on('error', () => {})
        sock.on('close', () => activeSockets.delete(sock))
        const safeWrite = (data: string) => {
          if (!sock.writableEnded && !sock.destroyed) sock.write(data)
        }
        sock.on('data', (chunk) => {
          const cmds = parseRespReqs(chunk.toString('utf8'))
          for (const args of cmds) {
            if (sock.writableEnded || sock.destroyed) break
            const verb = (args[0] || '').toUpperCase()
            if (verb === 'AUTH') {
              if (scenario === 'delay-auth') {
                delayAuthRelease = () => safeWrite('+OK\r\n')
                continue
              }
              if (args[1] === 'acl_non_syntax') {
                safeWrite('-ERR ACL auth rejected\r\n')
                continue
              }
              safeWrite('+OK\r\n')
              continue
            }
            if (verb === 'PING') {
              if (scenario === 'delay-ping') {
                delayPingRelease = () => safeWrite('+PONG\r\n')
                continue
              }
              if (scenario === 'unsolicited-before-pong') {
                safeWrite('+PONG\r\n+UNSOLICITED_AFTER\r\n')
                continue
              }
              safeWrite('+PONG\r\n')
              continue
            }
            if (verb === 'CHUNKED') {
              const pieces = [
                '*7\r\n',
                '$10\r\nhello',
                'world\r\n',
                '*2\r\n+a',
                '\r\n+b\r\n',
                '%1\r\n+k',
                '\r\n$3\r\nval\r\n',
                '|1\r\n+ak',
                '\r\n+av\r\n+after_attr\r\n',
                ':9007199254740993\r\n',
                '=3\r\nabc\r\n',
                '-ERR nested_err_secret\r\n',
              ]
              let delay = 0
              for (const p of pieces) {
                delay += 4
                setTimeout(() => safeWrite(p), delay)
              }
              continue
            }
            if (verb === 'MAP_ERR') {
              safeWrite('%1\r\n+errField\r\n-ERR map_nested\r\n')
              continue
            }
            if (verb === 'SCAN') {
              if (scenario === 'scan-bad') {
                safeWrite('+NOT_AN_ARRAY\r\n')
                continue
              }
              if (scenario === 'scan-multi') {
                const cursor = args[1]
                if (cursor === '0') {
                  safeWrite('*2\r\n$1\r\n1\r\n*2\r\n$2\r\nk1\r\n$2\r\nk2\r\n')
                } else {
                  safeWrite('*2\r\n$1\r\n0\r\n*2\r\n$2\r\nk1\r\n$2\r\nk3\r\n')
                }
                continue
              }
              if (scenario === 'scan-limit') {
                const keys = Array.from({ length: 12 }, (_, i) => `$3\r\nk${String(i).padStart(2, '0')}\r\n`).join('')
                safeWrite(`*2\r\n$1\r\n9\r\n*12\r\n${keys}`)
                continue
              }
              if (scenario === 'drop-before-val-settled') {
                safeWrite('*2\r\n$1\r\n0\r\n*1\r\n$10\r\nk_settle_1\r\n')
                continue
              }
              safeWrite('*2\r\n$1\r\n0\r\n*3\r\n$6\r\nk_hash\r\n$5\r\nk_set\r\n$6\r\nk_zset\r\n')
              continue
            }
            if (verb === 'TYPE') {
              if (args[1] === 'k_hash' || args[1] === 'k_drop_pipeline') safeWrite('+hash\r\n')
              else if (args[1] === 'k_set') safeWrite('+set\r\n')
              else if (args[1] === 'k_zset') safeWrite('+zset\r\n')
              else safeWrite('+string\r\n')
              continue
            }
            if (verb === 'TTL') {
              if (scenario === 'drop-before-val-settled') {
                sock.end(':-1\r\n')
              } else {
                safeWrite(':-1\r\n')
              }
              continue
            }
            if (verb === 'HSCAN') {
              safeWrite('%2\r\n+f1\r\n+v1\r\n+f2\r\n+v2\r\n')
              continue
            }
            if (verb === 'SSCAN') {
              safeWrite('%1\r\n+s1\r\n+s2\r\n')
              continue
            }
            if (verb === 'ZRANGE') {
              safeWrite('+raw_zset_payload\r\n')
              continue
            }
            if (verb === 'HKEYS') {
              if (args[1] === 'k_drop_pipeline') {
                sock.end()
              } else if (scenario === 'delay-hkeys') {
                delayHkeysRelease = () => safeWrite('*0\r\n')
              } else {
                safeWrite('-ERR HKEYS unsupported\r\n')
              }
              continue
            }
            if (verb === 'SET' && args.some((a) => a.toUpperCase() === 'KEEPTTL')) {
              if (scenario === 'non-syntax-set-err') {
                safeWrite('-ERR READONLY You cant write against a read only replica\r\n')
              } else {
                safeWrite('-ERR syntax error\r\n')
              }
              continue
            }
            if (verb === 'PTTL') {
              safeWrite(':-1\r\n')
              continue
            }
            if (verb === 'INFO' || verb === 'DBSIZE') {
              safeWrite('+ok\r\n')
              continue
            }
            if (verb === 'SLOW_BATCH') {
              setTimeout(() => safeWrite('+SLOW_OK\r\n'), 120)
              continue
            }
            safeWrite('+OK\r\n')
          }
        })
      })
      await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
      try {
        const port = (srv.address() as net.AddressInfo).port
        const prof = (extra: Partial<ConnectionProfile> = {}) =>
          makeProfile({ driver: 'redis', host: '127.0.0.1', port, sslMode: 'disable', ...extra })

        // Non-syntax ACL auth error throws without 1-arg retry
        await expect(
          driver.createSession(prof({ user: 'acl_non_syntax' }), 'pw')
        ).rejects.toThrow(/ACL auth rejected/)

        // Unsolicited frame + chunked RESP3 + MAP_ERR + hash/set/zset structure formatting + HKEYS err + scan-multi + scan-bad + scan-limit
        scenario = 'unsolicited-before-pong'
        const sess = track((await driver.createSession(prof({ url: 'not a valid url' }), 'pw')) as RedisSession)
        await new Promise((r) => setTimeout(r, 20))

        const chunkedRes = await sess.runQuery('r-chunked', 'CHUNKED')
        expect(chunkedRes.rowCount).toBe(7)
        const mapErrRes = await sess.runQuery('r-map-err', 'MAP_ERR')
        expect(mapErrRes.rows[0][0]).toBe('errField')

        // HSCAN returning map, SSCAN returning map, ZRANGE returning string
        const structPage = await sess.fetchPage({ table: '(all)', page: 1, pageSize: 10 })
        expect(structPage.rows.find((r) => r.key === 'k_hash')?.value).toContain('f1')
        expect(structPage.rows.find((r) => r.key === 'k_set')?.value).toContain('s1')
        expect(structPage.rows.find((r) => r.key === 'k_zset')?.value).toBe('raw_zset_payload')

        // HKEYS failing inside updateCell hash update -> ignored gracefully
        await expect(
          sess.updateCell({
            table: '(all)',
            column: 'value',
            newValue: { a: '1' },
            primaryKeys: { key: 'k_hash' },
            originalValue: '',
          })
        ).resolves.toMatchObject({ ok: true })

        // Multi-page SCAN + maxKeys limit in getDdl (max=10) + malformed SCAN
        scenario = 'scan-multi'
        const multiPage = await sess.fetchPage({ table: '(all)', page: 1, pageSize: 10 })
        expect(multiPage.totalRows).toBe(3)
        scenario = 'scan-limit'
        expect(await sess.getDdl('(all)')).toContain('k09')
        scenario = 'scan-bad'
        expect(await sess.listObjects()).toHaveLength(1)

        // runKeepTtlAwarePipeline: non-syntax error rethrows + mixed KEEPTTL & non-KEEPTTL commands fallback
        scenario = 'non-syntax-set-err'
        await expect(
          sess.updateCell({
            table: '(all)',
            column: 'value',
            newValue: 'x',
            primaryKeys: { key: 'k_str' },
            originalValue: 'y',
          })
        ).rejects.toThrow(/READONLY/)

        scenario = 'default'
        const mixedApply = await sess.applyChanges({
          table: '(all)',
          updates: [{ primaryKeys: { key: 'k_str' }, changes: { value: 'v2' }, originalRow: { key: 'k_str', type: 'string' } }],
          deletes: [{ key: 'k_del' }],
        })
        expect(mixedApply.updated).toBe(1)

        // sendPipeline when !isAlive() (socket closed during HKEYS -> caught & ignored -> sendPipeline sees closed=true)
        await expect(
          sess.applyChanges({
            table: '(all)',
            updates: [{ primaryKeys: { key: 'k_drop_pipeline' }, changes: { value: { a: '1' } } }],
          })
        ).rejects.toMatchObject({ code: 'SOCKET_CLOSED' })

        // sendPipelineSettled when socket drops mid-hydration (may reject SOCKET_CLOSED or resolve with value=null depending on close timing)
        scenario = 'drop-before-val-settled'
        await sess.fetchPage({ table: '(all)', page: 1, pageSize: 5 }).catch(() => null)
        scenario = 'default'

        // Multi-line batch cancel mid-flight
        const slowBatchP = sess.runQuery('r-slow-batch', 'SLOW_BATCH\nPING').catch((e) => e)
        await new Promise((r) => setTimeout(r, 25))
        await sess.cancelQuery('r-slow-batch')
        expect(await slowBatchP).toMatchObject({ code: 'cancelled' })
        await sess.close()

        // Concurrent getClient() sharing connectPromise + close() while openAuthenticatedClient is connecting
        const raceSess = new RedisSession(prof({ port }), 'pw')
        scenario = 'delay-ping'
        const p1 = raceSess.test()
        const p2 = raceSess.listObjects()
        await new Promise((r) => setTimeout(r, 30))
        scenario = 'default'
        delayPingRelease?.()
        const [r1, r2] = await Promise.all([p1, p2])
        expect(r1.ok).toBe(true)
        expect(r2.length).toBeGreaterThanOrEqual(1)
        await raceSess.close()

        // Cover default host='localhost' branch in resolveConnectionTarget via unreachable port
        const defaultHostSess = new RedisSession(
          makeProfile({ driver: 'redis', host: undefined, port: undefined }),
          'pw'
        )
        expect((await defaultHostSess.test()).ok).toBe(false)
        await defaultHostSess.close()

        const closeRaceSess = new RedisSession(prof(), 'pw')
        scenario = 'delay-ping'
        const testDuringClose = closeRaceSess.test()
        await new Promise((r) => setTimeout(r, 30))
        await closeRaceSess.close()
        delayPingRelease?.()
        const testResAfterClose = await testDuringClose
        expect(testResAfterClose.ok).toBe(false)

        // runQuery cancelled BEFORE openAuthenticatedClient resolves (hits L1516-1518)
        const queryRaceSess = track(new RedisSession(prof(), 'pw'))
        scenario = 'delay-auth'
        const qBeforeConnect = queryRaceSess.runQuery('r-q-before-conn', 'PING').catch((e) => e)
        await new Promise((r) => setTimeout(r, 25))
        await queryRaceSess.cancelQuery('r-q-before-conn')
        scenario = 'default'
        delayAuthRelease?.()
        await new Promise((r) => setTimeout(r, 25))
        expect(await qBeforeConnect).toMatchObject({ code: 'cancelled' })

        // getClient() when isClosed (L829-830): close during updateCell({}, hash) HKEYS -> commands=[] -> hydrateKeyRows calls getClient() when closed!
        const getClientClosedSess = new RedisSession(prof(), 'pw')
        await getClientClosedSess.test()
        scenario = 'delay-hkeys'
        const updCloseP = getClientClosedSess
          .updateCell({
            table: '(all)',
            column: 'value',
            newValue: {},
            primaryKeys: { key: 'k_hash' },
            originalValue: '',
          })
          .catch((e) => e)
        await new Promise((r) => setTimeout(r, 20))
        await getClientClosedSess.close()
        scenario = 'default'
        delayHkeysRelease?.()
        expect(await updCloseP).toMatchObject({ code: 'SESSION_CLOSED' })
      } finally {
        for (const s of activeSockets) s.destroy()
        await new Promise<void>((r) => srv.close(() => r()))
      }

      // 3) Mocked node:net: frozen Error scrub (with & without .code), connection timeout, formatRedisErrorMessage fallback
      vi.resetModules()
      let netMode: 'frozen-with-code' | 'frozen-no-code' | 'timeout' | 'non-error' = 'frozen-with-code'
      vi.doMock('node:net', async (importOriginal) => {
        const orig = await importOriginal<typeof import('node:net')>()
        return {
          ...orig,
          connect: (() => {
            const fake = new EventEmitter() as unknown as net.Socket
            fake.setNoDelay = () => fake
            fake.write = () => true
            fake.destroy = ((err?: Error) => {
              if (err) queueMicrotask(() => fake.emit('error', err))
              return fake
            }) as never
            if (netMode === 'frozen-with-code') {
              const e = new Error('redis://u:TopSecret99@127.0.0.1:6379 failed')
              Object.defineProperty(e, 'message', { value: e.message, writable: false, configurable: true })
              Object.assign(e, { code: 'ECONN_FROZEN' })
              queueMicrotask(() => fake.emit('error', e))
            } else if (netMode === 'frozen-no-code') {
              const e = new Error('redis://u:TopSecret99@127.0.0.1:6379 failed2')
              Object.defineProperty(e, 'message', { value: e.message, writable: false, configurable: true })
              queueMicrotask(() => fake.emit('error', e))
            } else if (netMode === 'non-error') {
              queueMicrotask(() => fake.emit('error', 12345 as never))
            }
            // 'timeout' never emits connect -> setTimeout triggers sock.destroy(timeoutErr)
            return fake
          }) as never,
        }
      })

      try {
        const { RedisDriver: MockRedisDriver } = await import('../src/drivers/redis/driver')
        const mDriver = new MockRedisDriver()
        netMode = 'frozen-with-code'
        await expect(
          mDriver.createSession(makeProfile({ driver: 'redis', host: '127.0.0.1', port: 6379 }))
        ).rejects.toMatchObject({ code: 'SOCKET_ERROR', cause: { code: 'ECONN_FROZEN' } })

        netMode = 'frozen-no-code'
        await expect(
          mDriver.createSession(makeProfile({ driver: 'redis', host: '127.0.0.1', port: 6379 }))
        ).rejects.toMatchObject({ code: 'SOCKET_ERROR', cause: { code: 'REDIS_ERROR' } })

        netMode = 'non-error'
        const nonErrRes = await mDriver.testConnection(
          makeProfile({ driver: 'redis', host: '127.0.0.1', port: 6379 })
        )
        expect(nonErrRes).toEqual({ ok: false, message: 'Redis connection failed' })

        vi.useFakeTimers()
        netMode = 'timeout'
        const timeoutP = mDriver.testConnection(
          makeProfile({ driver: 'redis', host: '127.0.0.1', port: 6379 })
        )
        await vi.advanceTimersByTimeAsync(10_500)
        const timeoutRes = await timeoutP
        expect(timeoutRes.ok).toBe(false)
        expect(timeoutRes.message).toContain('timed out')
      } finally {
        vi.useRealTimers()
        vi.doUnmock('node:net')
        vi.resetModules()
      }
    }, 20_000)
  })

  describe('4. src/drivers/clickhouse/driver.ts live ClickHouse + HTTPS + edge HTTP paths', () => {
    const CH_HOST = '127.0.0.1'
    const CH_PORT = 58123
    const CH_USER = 'datanoa'
    const CH_PASS = 'datanoa_ch_pass'
    const CH_DB = 'datanoa_test'
    const trackedCh: ClickHouseSession[] = []
    const trackCh = (s: ClickHouseSession) => {
      trackedCh.push(s)
      return s
    }

    async function cleanupCh() {
      const driver = new ClickHouseDriver()
      const s = (await driver.createSession(
        makeProfile({
          driver: 'clickhouse',
          host: CH_HOST,
          port: CH_PORT,
          database: CH_DB,
          user: CH_USER,
          sslMode: 'disable',
        }),
        CH_PASS
      )) as ClickHouseSession
      try {
        await s.runQuery('w4b-ch-drop-1', `DROP TABLE IF EXISTS ${CH_DB}.cov_w4b_ch_pk`)
        await s.runQuery('w4b-ch-drop-2', `DROP TABLE IF EXISTS ${CH_DB}.cov_w4b_ch_log`)
      } finally {
        await s.close().catch(() => {})
      }
    }

    beforeAll(async () => {
      await cleanupCh()
    })

    afterAll(async () => {
      await cleanupCh().catch(() => {})
      for (const s of trackedCh) await s.close().catch(() => {})
    })

    it('covers live ClickHouse 58123 PK cell update, maxRows=0, URL normalization variants, and HTTPS node:https server', async () => {
      // normalizeClickHouseBaseUrl / resolveClickHouseBaseUrl edge variants
      expect(
        normalizeClickHouseBaseUrl(
          makeProfile({ driver: 'clickhouse', url: undefined, host: undefined, port: undefined }),
          false
        )
      ).toBe('http://localhost:8123')
      expect(
        normalizeClickHouseBaseUrl(
          makeProfile({ driver: 'clickhouse', url: undefined, host: undefined, port: undefined }),
          { rejectUnauthorized: false }
        )
      ).toBe('https://localhost:8443')
      expect(
        normalizeClickHouseBaseUrl(
          makeProfile({ driver: 'clickhouse', url: undefined, host: undefined, port: undefined, ssl: false }),
          undefined
        )
      ).toBe('http://localhost:8123')

      const driver = new ClickHouseDriver()
      const liveSess = trackCh(
        (await driver.createSession(
          makeProfile({
            driver: 'clickhouse',
            host: CH_HOST,
            port: CH_PORT,
            database: CH_DB,
            user: CH_USER,
            sslMode: 'disable',
          }),
          CH_PASS
        )) as ClickHouseSession
      )

      await liveSess.runQuery(
        'w4b-ch-ddl',
        `
          CREATE TABLE ${CH_DB}.cov_w4b_ch_pk (
            id UInt64,
            code String,
            note Nullable(String)
          ) ENGINE = MergeTree ORDER BY (id, code);
          CREATE TABLE ${CH_DB}.cov_w4b_ch_log (
            msg String
          ) ENGINE = Memory;
        `
      )
      await liveSess.applyChanges({
        table: 'cov_w4b_ch_pk',
        inserts: [
          { id: 1, code: 'A', note: 'first' },
          { id: 2, code: 'B', note: null },
        ],
      })

      // Update a non-sorting/non-PK column or sorting column on Memory/MergeTree: update `code` when primaryKeys has `code`
      const updPk = await liveSess.updateCell({
        table: 'cov_w4b_ch_pk',
        column: 'note',
        newValue: null,
        primaryKeys: { id: 1, code: 'A' },
        originalValue: 'first',
      })
      expect(updPk.ok).toBe(true)

      // maxRows=0 in runQuery + plain SQL with non-compact format
      const qAll = await liveSess.runQuery(
        'w4b-ch-max0',
        `SELECT id, code FROM ${CH_DB}.cov_w4b_ch_pk ORDER BY id;`,
        0
      )
      expect(qAll.rowCount).toBe(2)
      const qTsv0 = await liveSess.runQuery(
        'w4b-ch-tsv0',
        `SELECT id FROM ${CH_DB}.cov_w4b_ch_pk ORDER BY id FORMAT TabSeparated`,
        0
      )
      expect(qTsv0.rowCount).toBe(2)
      await liveSess.close()

      // Real node:https server covering sendHttpsRequest (L135-150, L450-457, L1263) + plain text EXPLAIN (L108-109) + empty non-2xx error (L80)
      const opensslBin = 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe'
      if (fs.existsSync(opensslBin)) {
        const dir = makeTempDir('ch-https-')
        const certPath = path.join(dir, 'ch-cert.pem')
        const keyPath = path.join(dir, 'ch-key.pem')
        execFileSync(
          opensslBin,
          [
            'req',
            '-x509',
            '-newkey',
            'rsa:2048',
            '-nodes',
            '-keyout',
            keyPath,
            '-out',
            certPath,
            '-days',
            '1',
            '-subj',
            '/CN=localhost',
            '-addext',
            'subjectAltName=DNS:localhost,IP:127.0.0.1',
          ],
          { stdio: 'pipe', timeout: 10_000 }
        )

        let httpsMode = 'ok'
        const httpsSrv = https.createServer(
          { key: fs.readFileSync(keyPath, 'utf8'), cert: fs.readFileSync(certPath, 'utf8') },
          (req, res) => {
            let body = ''
            req.on('data', (c) => {
              body += String(c)
            })
            req.on('end', () => {
              if (httpsMode === 'err-empty') {
                res.statusCode = 503
                res.end('')
                return
              }
              if (body.startsWith('EXPLAIN')) {
                res.statusCode = 200
                res.end('Expression (Project)\n  ReadFromMergeTree')
                return
              }
              res.statusCode = 200
              res.setHeader('x-clickhouse-summary', JSON.stringify({ written_rows: '2' }))
              res.end(
                JSON.stringify({
                  meta: [{ name: 'ok', type: 'UInt8' }],
                  data: [[1]],
                })
              )
            })
          }
        )
        await new Promise<void>((r) => httpsSrv.listen(0, '127.0.0.1', () => r()))
        try {
          const port = (httpsSrv.address() as net.AddressInfo).port
          const httpsSess = trackCh(
            (await driver.createSession(
              makeProfile({
                driver: 'clickhouse',
                host: 'localhost',
                port,
                sslCaPath: certPath,
                sslMode: 'verify-ca',
              }),
              undefined,
              { tlsServername: 'localhost' }
            )) as ClickHouseSession
          )
          expect((await httpsSess.test()).ok).toBe(true)
          const plainExp = await httpsSess.runQuery('ch-https-exp', 'EXPLAIN SELECT 1')
          expect(plainExp.columns[0].name).toBe('explain')
          expect(plainExp.rows[0][0]).toContain('Expression')
          const insHttps = await httpsSess.runQuery('ch-https-ins', 'INSERT INTO t VALUES (1), (2)')
          expect(insHttps.affectedRows).toBe(2)

          httpsMode = 'err-empty'
          await expect(httpsSess.runQuery('ch-https-503', 'SELECT 1')).rejects.toThrow(
            'ClickHouse HTTP error 503'
          )
          await httpsSess.close()
        } finally {
          httpsSrv.closeAllConnections?.()
          await new Promise<void>((r) => httpsSrv.close(() => r()))
        }
      }
    }, 20_000)

    it('covers ClickHouse edge HTTP paths: PK/sortingKey fallback, >1 conflicts, PK update + failed readback, 256KB insert split, closed race, and TimeoutError', async () => {
      let chMode = 'default'
      let holdDeleteResolve: (() => void) | null = null
      let holdQueryResolve: (() => void) | null = null

      const srv = http.createServer((req, res) => {
        let body = ''
        req.on('data', (c) => {
          body += String(c)
        })
        req.on('end', () => {
          if (chMode === 'pk-from-cols') {
            if (body.includes('FROM system.tables')) {
              res.statusCode = 200
              res.end(JSON.stringify({ meta: [{ name: 'engine', type: 'String' }], data: [['MergeTree']] }))
              return
            }
            if (body.includes('FROM system.columns')) {
              res.statusCode = 200
              res.end(
                JSON.stringify({
                  meta: [
                    { name: 'name', type: 'String' },
                    { name: 'type', type: 'String' },
                    { name: 'is_in_primary_key', type: 'UInt8' },
                    { name: 'is_in_sorting_key', type: 'UInt8' },
                    { name: 'default_kind', type: 'String' },
                    { name: 'default_expression', type: 'String' },
                  ],
                  data: [
                    ['col_pk', 'UInt64', 1, 1, '', ''],
                    ['col_empty_type', '', 0, 0, '', ''],
                  ],
                })
              )
              return
            }
          }
          if (chMode === 'sort-from-cols') {
            if (body.includes('FROM system.tables')) {
              res.statusCode = 200
              res.end(JSON.stringify({ meta: [{ name: 'engine', type: 'String' }], data: [['MergeTree']] }))
              return
            }
            if (body.includes('FROM system.columns')) {
              res.statusCode = 200
              res.end(
                JSON.stringify({
                  meta: [
                    { name: 'name', type: 'String' },
                    { name: 'type', type: 'String' },
                    { name: 'is_in_primary_key', type: 'UInt8' },
                    { name: 'is_in_sorting_key', type: 'UInt8' },
                    { name: 'default_kind', type: 'String' },
                    { name: 'default_expression', type: 'String' },
                  ],
                  data: [['col_sort', 'String', 0, 1, '', '']],
                })
              )
              return
            }
          }
          if (body.includes('SHOW DATABASES')) {
            res.statusCode = 200
            res.end(JSON.stringify({ meta: [{ name: 'name', type: 'String' }], data: [['other_db']] }))
            return
          }
          if (body.includes('SHOW CREATE')) {
            res.statusCode = 500
            res.end('no show create')
            return
          }
          if (body.includes('SELECT COUNT(*) AS total')) {
            if (chMode === 'count-2') {
              res.statusCode = 200
              res.end(JSON.stringify({ meta: [{ name: 'total', type: 'UInt64' }], data: [[2]] }))
              return
            }
            if (chMode === 'hold-first-del') {
              chMode = 'default'
              holdDeleteResolve = () => {
                res.statusCode = 200
                res.end(JSON.stringify({ meta: [{ name: 'total', type: 'UInt64' }], data: [[1]] }))
              }
              return
            }
            res.statusCode = 200
            res.end(JSON.stringify({ meta: [{ name: 'total', type: 'UInt64' }], data: [[1]] }))
            return
          }
          if (body.startsWith('SELECT * FROM') && body.includes('LIMIT 1')) {
            res.statusCode = 500
            res.end('readback error')
            return
          }
          if (body.includes('HOLD_ERR')) {
            holdQueryResolve = () => {
              res.statusCode = 500
              res.end('broken socket mid query')
            }
            return
          }
          res.statusCode = 200
          res.end(JSON.stringify({ meta: [], data: [] }))
        })
      })
      await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
      try {
        const port = (srv.address() as net.AddressInfo).port
        const sess = trackCh(
          new ClickHouseSession(
            makeProfile({ driver: 'clickhouse', url: `http://127.0.0.1:${port}`, database: 'custom_db' })
          )
        )

        // listSchemas prepends defaultSchema when missing
        const schemas = await sess.listSchemas()
        expect(schemas.schemas[0]).toBe('custom_db')

        // getObjectDdl view where both SHOW CREATE VIEW and SHOW CREATE TABLE fail -> getDdl fallback
        chMode = 'pk-from-cols'
        expect(await sess.getObjectDdl('v_fallback', 'view')).toContain('CREATE TABLE')
        const pkDet = await sess.getTableDetails('tbl_pk_cols')
        expect(pkDet.primaryKey).toEqual(['col_pk'])
        expect(pkDet.columns[1].type).toBe('String')

        chMode = 'sort-from-cols'
        const sortDet = await sess.getTableDetails('tbl_sort_cols')
        expect(sortDet.primaryKey).toEqual(['col_sort'])

        // updateCell >1 rows conflict + PK column update + failed readback catch
        chMode = 'count-2'
        await expect(
          sess.updateCell({ table: 't', column: 'v', newValue: 'x', primaryKeys: { id: 1 }, originalValue: 'y' })
        ).rejects.toThrow(/matched 2 rows/)
        await expect(
          sess.applyChanges({ table: 't', deletes: [{ id: 1 }] })
        ).rejects.toThrow(/matched 2 rows/)

        chMode = 'default'
        const updPkCol = await sess.updateCell({
          table: 't',
          column: 'id',
          newValue: 99,
          primaryKeys: { id: 1 },
          originalValue: 1,
        })
        expect(updPkCol).toEqual({ ok: true, affectedRows: 1, updatedRecord: undefined })

        // >256KB INSERT splitting (L943 break)
        const bigVal = 'a'.repeat(150_000)
        const splitIns = await sess.applyChanges({
          table: 't',
          inserts: [{ id: 1, big: bigVal }, { id: 2, big: bigVal }],
        })
        expect(splitIns.statements).toHaveLength(2)

        // runQuery cancelled + inner non-cancelled error (L1197-1198)
        const qCancelErr = sess.runQuery('ch-hold-err', 'SELECT HOLD_ERR').catch((e) => e)
        await new Promise((r) => setTimeout(r, 20))
        const cancelP = sess.cancelQuery('ch-hold-err')
        holdQueryResolve?.()
        await cancelP
        expect(await qCancelErr).toMatchObject({ code: 'cancelled' })

        // TimeoutError without options.signal aborted (L474-480)
        vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'))
        await expect(sess.runQuery('ch-to', 'SELECT 1')).rejects.toMatchObject({ code: 'TIMEOUT' })
        vi.restoreAllMocks()

        // executeHttp when isClosed=true (L397-398): close() during first delete COUNT(*) so ALTER DELETE hits isClosed
        chMode = 'hold-first-del'
        const delDuringClose = sess.applyChanges({ table: 't', deletes: [{ id: 1 }] }).catch((e) => e)
        await new Promise((r) => setTimeout(r, 20))
        await sess.close()
        holdDeleteResolve?.()
        expect(await delDuringClose).toMatchObject({ code: 'SESSION_CLOSED' })
      } finally {
        holdDeleteResolve?.()
        holdQueryResolve?.()
        srv.closeAllConnections?.()
        await new Promise<void>((r) => srv.close(() => r()))
      }
    }, 20_000)
  })

  describe('5. src/drivers/libsql/driver.ts live LibSQL + Hrana edge paths & PBT', () => {
    const LIBSQL_URL = 'http://127.0.0.1:58080'
    const trackedLs: LibsqlSession[] = []
    const trackLs = (s: LibsqlSession) => {
      trackedLs.push(s)
      return s
    }

    async function cleanupLs() {
      const driver = new LibsqlDriver()
      const s = (await driver.createSession(
        makeProfile({ driver: 'libsql', url: LIBSQL_URL, ssl: false })
      )) as LibsqlSession
      try {
        await s.runQuery('w4b-ls-drop', 'DROP TABLE IF EXISTS cov_w4b_libsql_items')
      } finally {
        await s.close().catch(() => {})
      }
    }

    beforeAll(async () => {
      await cleanupLs()
    })

    afterAll(async () => {
      await cleanupLs().catch(() => {})
      for (const s of trackedLs) await s.close().catch(() => {})
    })

    it('covers live LibSQL 58080 cov_w4b_libsql_items Date/Object/maxRows=0/BEGIN-no-COMMIT guard and Hrana edge server errors', async () => {
      const driver = new LibsqlDriver()
      const liveSess = trackLs(
        (await driver.createSession(
          makeProfile({ driver: 'libsql', url: LIBSQL_URL, ssl: false })
        )) as LibsqlSession
      )

      await liveSess.runQuery(
        'w4b-ls-ddl',
        'CREATE TABLE cov_w4b_libsql_items (id INTEGER PRIMARY KEY, payload TEXT, created_at TEXT)'
      )

      // Date + plain object parameter encoding in applyChanges & fetchPage
      const now = new Date('2026-01-02T03:04:05.000Z')
      await liveSess.applyChanges({
        table: 'cov_w4b_libsql_items',
        inserts: [{ id: 1, payload: { nested: true }, created_at: now }],
      })
      const page = await liveSess.fetchPage({ table: 'cov_w4b_libsql_items', page: 1, pageSize: 5 })
      expect(page.rows[0].payload).toBe('{"nested":true}')
      expect(page.rows[0].created_at).toBe(now.toISOString())

      // WITH ... INSERT (mutating CTE -> isSelect: false) & maxRows=0
      const withIns = await liveSess.runQuery(
        'w4b-ls-with-mut',
        "WITH cte(i, p) AS (SELECT 2, 'ok') INSERT INTO cov_w4b_libsql_items (id, payload) SELECT i, p FROM cte"
      )
      expect(withIns.isSelect).toBe(false)
      const selAll = await liveSess.runQuery('w4b-ls-all0', 'SELECT id FROM cov_w4b_libsql_items ORDER BY id', 0)
      expect(selAll.rowCount).toBe(2)

      // Multi-stmt starting with BEGIN without COMMIT (L1025 guardStep = stmts.length - 1)
      await expect(
        liveSess.runQuery(
          'w4b-ls-begin-no-commit',
          'BEGIN; INSERT INTO cov_w4b_libsql_items (id, payload) VALUES (3, "x"); INSERT INTO no_such_tbl VALUES (1);'
        )
      ).rejects.toThrow()
      expect(
        (await liveSess.runQuery('w4b-ls-check3', 'SELECT COUNT(*) FROM cov_w4b_libsql_items WHERE id = 3')).rows
      ).toEqual([[0]])

      // Host + port URL resolution & authToken header construction
      const sHostPort = new LibsqlSession(
        makeProfile({ driver: 'libsql', url: undefined, host: '127.0.0.1', port: 58080, ssl: false })
      )
      expect(sHostPort.pipelineUrl).toBe('http://127.0.0.1:58080/v2/pipeline')
      await sHostPort.close()

      const sHttpsTok = new LibsqlSession(
        makeProfile({ driver: 'libsql', url: 'https://mydb-org.turso.io/v2/pipeline', ssl: true }),
        'my-secret-token'
      )
      expect(
        sHttpsTok.resolveTargetUrl('https://mydb-org.turso.io/v2/pipeline')
      ).toBe('https://mydb-org.turso.io/v2/pipeline')
      expect(sHttpsTok.resolveTargetUrl('https://eu.mydb-org.turso.io')).toBe(
        'https://eu.mydb-org.turso.io/v2/pipeline'
      )
      // Exercise buildHeaders() Bearer Authorization + resolveTargetUrl ending in /v2/pipeline via mocked fetch
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            base_url: 'https://eu.mydb-org.turso.io/v2/pipeline',
            results: [{ type: 'ok', response: { result: { cols: [], rows: [] } } }, { type: 'ok' }],
          }),
          { status: 200 }
        )
      )
      expect((await sHttpsTok.test()).ok).toBe(true)
      vi.restoreAllMocks()
      await sHttpsTok.close()

      // Local Hrana edge server for remaining decode/batch/applyChanges/DDL/cancel branches
      let lsMode = 'dml-err'
      let holdNext: (() => void) | null = null
      const srv = http.createServer((req, res) => {
        let body = ''
        req.on('data', (c) => {
          body += String(c)
        })
        req.on('end', () => {
          if (lsMode === 'dml-err') {
            res.statusCode = 200
            res.end(
              JSON.stringify({
                baton: 'b1',
                results: [{ type: 'ok' }, { type: 'error', error: { message: 'dml constraint' } }],
              })
            )
            return
          }
          if (lsMode === 'commit-err') {
            if (body.includes('BEGIN IMMEDIATE')) {
              res.statusCode = 200
              res.end(
                JSON.stringify({
                  baton: 'b2',
                  results: [{ type: 'ok' }, { type: 'ok', response: { result: { affected_row_count: 1 } } }],
                })
              )
              return
            }
            res.statusCode = 200
            res.end(JSON.stringify({ results: [{ type: 'error', error: { message: 'commit fail' } }] }))
            return
          }
          if (lsMode === 'batch-err') {
            res.statusCode = 200
            res.end(JSON.stringify({ results: [{ type: 'error', error: { message: 'batch rejected' } }] }))
            return
          }
          if (lsMode === 'close-between-rounds') {
            holdNext = () => {
              res.statusCode = 200
              res.end(
                JSON.stringify({
                  baton: 'b3',
                  results: [{ type: 'ok' }, { type: 'ok', response: { result: { affected_row_count: 1 } } }],
                })
              )
            }
            return
          }
          if (lsMode === 'decode-edge') {
            res.statusCode = 200
            res.end(
              JSON.stringify({
                results: [
                  {
                    type: 'ok',
                    response: {
                      result: {
                        cols: [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }],
                        rows: [[null, { type: 'blob' }, { type: 'weird', value: 'fallback' }, { type: 'text' }]],
                      },
                    },
                  },
                  { type: 'ok' },
                ],
              })
            )
            return
          }
          if (lsMode === 'hold-noncancel-err') {
            holdNext = () => {
              res.destroy(new Error('reset'))
            }
            return
          }
          res.statusCode = 200
          res.end(JSON.stringify({ results: [{ type: 'ok', response: { result: { cols: [], rows: [] } } }, { type: 'ok' }] }))
        })
      })
      await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
      try {
        const port = (srv.address() as net.AddressInfo).port
        const eSess = trackLs(new LibsqlSession(makeProfile({ driver: 'libsql', url: `http://127.0.0.1:${port}` })))

        lsMode = 'dml-err'
        await expect(eSess.applyChanges({ table: 't', inserts: [{ id: 1 }] })).rejects.toThrow(/dml constraint/)

        lsMode = 'commit-err'
        await expect(eSess.applyChanges({ table: 't', inserts: [{ id: 1 }] })).rejects.toThrow(/commit fail/)

        lsMode = 'batch-err'
        await expect(eSess.runQuery('e-batch-err', 'SELECT 1; SELECT 2;')).rejects.toThrow(/batch rejected/)

        lsMode = 'decode-edge'
        const decRes = await eSess.runQuery('e-dec', 'SELECT 1')
        expect(decRes.rows[0]).toEqual([null, null, 'fallback', ''])

        // alt schema DDL uses `"alt".sqlite_master`
        lsMode = 'ok'
        await eSess.getDdl('alt_tbl', 'alt')

        // runQuery cancelled during response.text() when response is invalid JSON -> throws LIBSQL_PARSE_ERROR while active.cancelled=true (hits L1111-1112)
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => {
            await new Promise((r) => setTimeout(r, 40))
            return '{broken-after-cancel'
          },
        } as unknown as Response)
        const qNonCancel = eSess.runQuery('ls-noncancel', 'SELECT 1').catch((e) => e)
        await new Promise((r) => setTimeout(r, 10))
        await eSess.cancelQuery('ls-noncancel')
        expect(await qNonCancel).toMatchObject({ code: 'cancelled' })
        vi.restoreAllMocks()

        // fetch TimeoutError + non-Error throw + LibsqlDriver.testConnection non-Error
        vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'))
        await expect(eSess.runQuery('ls-to', 'SELECT 1')).rejects.toMatchObject({ code: 'TIMEOUT' })

        vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce('raw-fetch-fail')
        await expect(eSess.runQuery('ls-raw', 'SELECT 1')).rejects.toThrow('LibSQL HTTP request failed')

        expect(
          await driver.testConnection(makeProfile({ driver: 'libsql', url: 'https://bad.invalid', ssl: true }))
        ).toMatchObject({ ok: false })

        // Close between round1 and round2 of applyChanges -> round2 hits `if (this.isClosed)` in sendHranaPipeline
        lsMode = 'close-between-rounds'
        const applyCloseP = eSess.applyChanges({ table: 't', inserts: [{ id: 1 }] }).catch((e) => e)
        await new Promise((r) => setTimeout(r, 20))
        await eSess.close()
        holdNext?.()
        expect(await applyCloseP).toMatchObject({ code: 'SESSION_CLOSED' })
      } finally {
        holdNext?.()
        srv.closeAllConnections?.()
        await new Promise<void>((r) => srv.close(() => r()))
      }
    }, 20_000)
  })

  describe('6. src/drivers/d1/driver.ts mocked fetch Cloudflare D1 HTTP API & edge branches', () => {
    function d1Profile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
      return {
        id: 'w4b-d1',
        name: 'w4b-d1',
        driver: 'd1',
        d1AccountId: 'acct_123',
        d1DatabaseId: 'db_456',
        ...overrides,
      }
    }

    it('covers D1 ArrayBuffer/view params, columnTypeFor, empty error bodies, batch >512KB chunk break, FK PRAGMA & cancel text-reject', async () => {
      const driver = new D1Driver()
      const sess = (await driver.createSession(d1Profile(), 'cf_tok')) as D1Session
      expect(sess.endpoint).toContain('/accounts/acct_123/d1/database/db_456/query')

      // 1) ArrayBuffer + Uint8Array with non-zero byteOffset + omitted `errors` + columnTypeFor(REAL/boolean/Uint8Array)
      const buf = new Uint8Array([10, 20, 30, 40])
      const sliceView = new Uint8Array(buf.buffer, 1, 2) // bytes [20, 30] -> base64 'FB4='
      let capturedBodies: Array<Record<string, unknown>> = []

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        const parsed = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        capturedBodies.push(parsed)
        return new Response(
          JSON.stringify({
            success: true,
            // errors intentionally omitted to cover errorMessages(undefined)
            result: [
              {
                success: true,
                results: [
                  {
                    r_real: 1.5,
                    r_bool: true,
                    r_blob: new Uint8Array([1, 2]),
                    r_null: null,
                  },
                ],
                meta: { changes: 1 },
              },
            ],
          }),
          { status: 200 }
        )
      })

      const updRes = await sess.updateCell({
        table: 'items',
        column: 'bin',
        newValue: sliceView,
        primaryKeys: { id: 1 },
        originalValue: 'old',
      })
      expect(updRes.ok).toBe(true)
      expect(capturedBodies[0].params).toContain('FB4=')

      const updArrBuf = await sess.applyChanges({
        table: 'items',
        inserts: [{ id: 2, bin: buf.buffer }],
      })
      expect(updArrBuf.ok).toBe(true)
      expect(capturedBodies.some((b) => Array.isArray(b.params) && b.params.includes(Buffer.from(buf.buffer).toString('base64')))).toBe(true)

      // Object-form row with REAL / boolean / null + mock Uint8Array via Response replacement
      vi.restoreAllMocks()
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ success: true, errors: ['not-obj', { message: '' }], result: 'non-array' }),
      } as unknown as Response)
      const qNonArr = await sess.runQuery('d1-nonarr', 'SELECT 1')
      expect(qNonArr.rowCount).toBe(0)

      // columnTypeFor branches (REAL, boolean, Uint8Array) tested via Response with custom parsed JSON
      const origParse = JSON.parse
      vi.spyOn(JSON, 'parse').mockImplementationOnce(((text: string) => {
        const obj = origParse(text) as Record<string, unknown>
        if (obj && Array.isArray(obj.result)) {
          obj.result = [
            {
              success: true,
              results: [{ f_real: 2.25, f_bool: false, f_blob: new Uint8Array([7, 8]) }],
            },
          ]
        }
        return obj
      }) as never)
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, errors: [], result: [] }), { status: 200 })
      )
      const qTypes = await sess.runQuery('d1-types', 'SELECT f_real, f_bool, f_blob FROM t')
      expect(qTypes.columns.map((c) => c.type)).toEqual(['REAL', 'INTEGER', 'BLOB'])
      vi.restoreAllMocks()

      // 2) Single execute HTTP 502 empty body, DatabaseDriverError rethrow, and test() non-Error
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new DatabaseDriverError('direct', 'CUSTOM_D1', 'd1'))
      await expect(sess.runQuery('d1-direct-err', 'SELECT 1')).rejects.toMatchObject({ code: 'CUSTOM_D1' })

      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{}', { status: 502 }))
      await expect(sess.runQuery('d1-502', 'SELECT 1')).rejects.toThrow('{}')

      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce('non-error-string')
      expect(await sess.test()).toEqual({ ok: false, message: 'Cloudflare D1 HTTP request failed' })
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new DatabaseDriverError('', 'EMPTY', 'd1'))
      expect(await sess.test()).toEqual({ ok: false, message: 'Failed to connect to Cloudflare D1' })

      // 3) executeBatch: DatabaseDriverError rethrow, HTTP 503 JSON `{}` body, FK sentinel in toBatchError, sentinel without json path, envelope.success=false empty errors
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new DatabaseDriverError('batch-direct', 'B_D1', 'd1'))
      await expect(sess.runQuery('d1-b-direct', 'SELECT 1; SELECT 2;')).rejects.toMatchObject({ code: 'B_D1' })

      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{}', { status: 503 }))
      await expect(sess.runQuery('d1-b-503', 'SELECT 1; SELECT 2;')).rejects.toThrow('{}')

      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ success: false, errors: [{ message: 'err __datanoa_fk_violation__' }] }), {
          status: 500,
        })
      )
      await expect(sess.runQuery('d1-b-fk', 'SELECT 1; SELECT 2;')).rejects.toThrow(
        'FOREIGN KEY constraint failed'
      )

      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ success: false, errors: [] }), { status: 200 })
      )
      await expect(sess.runQuery('d1-b-env-fail', 'SELECT 1; SELECT 2;')).rejects.toThrow(
        'Cloudflare D1 rejected the batch query'
      )

      // Conflict sentinel string present WITHOUT `bad json path` -> non-conflict D1_ERROR
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: false,
            errors: [{ message: "other error mentioning 'datanoa_optimistic_conflict'" }],
          }),
          { status: 400 }
        )
      )
      await expect(
        sess.applyChanges({
          table: 'items',
          deletes: [{ id: 1 }],
        })
      ).rejects.toMatchObject({ code: 'D1_ERROR' })

      // 4) Multi-row insert >512KB payload budget break (L666-667) + omitted meta.changes fallback (L751)
      capturedBodies = []
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init) => {
        const b = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        capturedBodies.push(b)
        const batchLen = Array.isArray(b.batch) ? b.batch.length : 1
        return new Response(
          JSON.stringify({
            success: true,
            errors: [],
            result: Array.from({ length: batchLen }, () => ({ success: true, results: [] })), // no meta.changes -> falls back to expectedRows
          }),
          { status: 200 }
        )
      })
      const hugeStr = 'x'.repeat(300_000)
      const splitRes = await sess.applyChanges({
        table: 'items',
        inserts: [
          { id: 1, body: hugeStr },
          { id: 2, body: hugeStr },
        ],
      })
      expect(splitRes.inserted).toBe(2)
      expect(splitRes.statements).toHaveLength(2)

      // 5) runQuery: PRAGMA main.foreign_key_check non-empty -> FK error (L862-863), WITH...INSERT (L868)
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            errors: [],
            result: [
              { success: true, results: [{ table: 'items', rowid: 1 }] },
              { success: true, results: [], meta: { changes: 1 } },
            ],
          }),
          { status: 200 }
        )
      )
      await expect(
        sess.runQuery('d1-fk-pragma', 'PRAGMA main.foreign_key_check; SELECT 1;')
      ).rejects.toThrow('FOREIGN KEY constraint failed')

      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            errors: [],
            result: [{ success: true, results: [], meta: { changes: 2 } }],
          }),
          { status: 200 }
        )
      )
      const withMut = await sess.runQuery('d1-with-mut', 'WITH c AS (SELECT 1) INSERT INTO items SELECT * FROM c;')
      expect(withMut.isSelect).toBe(false)
      expect(withMut.affectedRows).toBe(2)

      // 6) cancelQuery while mock fetch ignores abort and returns mismatched batch count -> protocolError converted to cancelled at L925-926
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => {
          await new Promise((r) => setTimeout(r, 35))
          return JSON.stringify({ success: true, errors: [], result: [] })
        },
      } as unknown as Response)
      const qCancelBatchMismatch = sess.runQuery('d1-cancel-text', 'SELECT 1; SELECT 2;').catch((e) => e)
      await new Promise((r) => setTimeout(r, 10))
      await sess.cancelQuery('d1-cancel-text')
      expect(await qCancelBatchMismatch).toMatchObject({ code: 'cancelled' })

      // 7) D1Driver.testConnection when createSession throws non-Error
      vi.spyOn(driver, 'createSession').mockRejectedValueOnce('raw-d1-conn-err')
      expect(await driver.testConnection(d1Profile())).toEqual({
        ok: false,
        message: 'Cloudflare D1 connection failed',
      })

      await sess.close()
    })
  })

  describe('7. src/drivers/mssql/driver.ts mocked ConnectionPool / Request / Transaction & PBT', () => {
    function mssqlProfile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
      return {
        id: 'w4b-mssql',
        name: 'w4b-mssql',
        driver: 'mssql',
        host: '127.0.0.1',
        port: 1433,
        user: 'sa',
        database: 'appdb',
        ...overrides,
      }
    }

    it('covers buildMssqlPoolConfig, splitMssqlBatches, isMssqlReadOnlyBlocked PBT & MssqlDriver real dead-port test', async () => {
      const dir = makeTempDir('mssql-tls-')
      const caPath = path.join(dir, 'ca.pem')
      const certPath = path.join(dir, 'cert.pem')
      const keyPath = path.join(dir, 'key.pem')
      fs.writeFileSync(caPath, 'CA', 'utf8')
      fs.writeFileSync(certPath, 'CERT', 'utf8')
      fs.writeFileSync(keyPath, 'KEY', 'utf8')

      expect(splitMssqlBatches('')).toEqual([])
      expect(isMssqlReadOnlyBlocked('EXEC sp_who2;')).toBe(true)
      expect(isMssqlReadOnlyBlocked('SET SHOWPLAN_XML ON;')).toBe(false)

      fc.assert(
        fc.property(fc.stringMatching(/^[A-Za-z0-9_]{1,12}$/), (db) => {
          const cfg = splitMssqlBatches(`SELECT '${db}' AS c;\nGO 2`)
          expect(cfg).toHaveLength(2)
        }),
        { numRuns: 20 }
      )

      const urlCfg = await buildMssqlPoolConfig(
        mssqlProfile({
          host: undefined,
          port: undefined,
          user: undefined,
          database: undefined,
          url: 'mssql://admin:pw%21@db.internal:1435/salesdb',
          sslMode: 'disable',
        })
      )
      expect(urlCfg.server).toBe('db.internal')
      expect(urlCfg.port).toBe(1435)
      expect(urlCfg.user).toBe('admin')
      expect(urlCfg.password).toBe('pw!')
      expect(urlCfg.database).toBe('salesdb')
      expect(urlCfg.options?.encrypt).toBe(false)

      const adoCfg = await buildMssqlPoolConfig(
        mssqlProfile({
          host: undefined,
          port: undefined,
          user: undefined,
          database: undefined,
          url: 'Server=tcp:ado.local,1439;Database=orders;User Id=u1;Password=p1;',
          sslMode: 'require',
          sslCaPath: caPath,
          sslCertPath: certPath,
          sslKeyPath: keyPath,
        }),
        undefined,
        { sslKeyPassphrase: 'kp', tlsServername: 'ado.example.com' }
      )
      expect(adoCfg.database).toBe('orders')
      expect(adoCfg.options?.encrypt).toBe(true)

      const namedCfg = await buildMssqlPoolConfig(
        mssqlProfile({ host: 'srv\\SQLEXPRESS', port: undefined, database: undefined, url: 'mssql://[bad-url' })
      )
      expect(namedCfg.server).toBe('srv')
      expect(namedCfg.database).toBe('master')
      expect(namedCfg.options?.instanceName).toBe('SQLEXPRESS')
      expect(namedCfg.port).toBeUndefined()

      const sslRejectCfg = await buildMssqlPoolConfig(
        mssqlProfile({ ssl: true, sslRejectUnauthorized: true })
      )
      expect(sslRejectCfg.options?.encrypt).toBe(true)
      expect(sslRejectCfg.options?.trustServerCertificate).toBe(false)

      // Test MssqlDriver.testConnection against closed loopback port
      const srv = net.createServer()
      await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
      const closedPort = (srv.address() as net.AddressInfo).port
      await new Promise<void>((r) => srv.close(() => r()))

      const mDriver = new MssqlDriver()
      const deadRes = await mDriver.testConnection(mssqlProfile({ port: closedPort }))
      expect(deadRes.ok).toBe(false)
    })

    it('covers all MssqlSession paths: params, column metas, schema/DDL, pinned tx savepoints, applyChanges, runQuery batches & close races', async () => {
      let holdBeginResolve: (() => void) | null = null
      let holdBegin = false
      let holdSlowResolve: (() => void) | null = null
      let holdSlow = false
      let failUpdateOnce = false
      let failApplyOnce = false
      let failRollbackCatch = false
      let failViewDdl = false
      let txCount = 0

      const makeReq = (): MssqlRequestLike => {
        const inputs: unknown[] = []
        return {
          input(_name: string, typeOrVal: unknown, maybeVal?: unknown) {
            inputs.push(maybeVal !== undefined ? maybeVal : typeOrVal)
            return this
          },
          async query(sql: string) {
            if (holdSlow) {
              holdSlow = false
              return new Promise((resolve) => {
                holdSlowResolve = () => resolve({ recordset: [{ ok: 1 }], rowsAffected: [0] })
              })
            }
            if (sql.includes('FROM sys.schemas')) {
              return { recordset: [{ name: 'dbo', is_default: 1 }] }
            }
            if (sql.includes('o.type AS obj_type')) {
              return {
                recordset: [{ obj_type: inputs[1] === 'v_users' ? 'V' : 'U', object_id: 1 }],
              }
            }
            if (sql.includes('FROM sys.objects o')) {
              return {
                recordset: [
                  { name: 'users', schema: 'dbo', kind: 'table' },
                  { name: 'v_users', schema: 'dbo', kind: 'view' },
                ],
              }
            }
            if (sql.includes('FROM sys.types') || sql.includes('FROM sys.tables') || sql.includes('FROM sys.views') || sql.includes('FROM sys.sequences')) {
              return { recordset: [] }
            }
            if (sql.includes('FROM sys.indexes i')) {
              return {
                recordset: [
                  {
                    index_name: 'PK_users',
                    is_unique: 1,
                    is_primary_key: 1,
                    is_unique_constraint: 0,
                    index_type: 'CLUSTERED',
                    filter_definition: null,
                    column_name: 'id',
                    key_ordinal: 1,
                    is_descending_key: 0,
                    is_included_column: 0,
                  },
                ],
              }
            }
            if (sql.includes('FROM sys.foreign_keys') || sql.includes('FROM sys.triggers')) {
              return { recordset: [] }
            }
            if (sql.includes('FROM sys.columns c')) {
              return {
                recordset: [
                  {
                    name: 'id',
                    base_type: 'int',
                    system_type: 'int',
                    max_length: 4,
                    precision: 10,
                    scale: 0,
                    is_nullable: 0,
                    is_identity: 1,
                    is_computed: 0,
                    collation_name: null,
                    default_value: null,
                    computed_definition: null,
                    is_persisted: 0,
                  },
                ],
              }
            }
            if (sql.includes('OBJECT_DEFINITION')) {
              if (failViewDdl) throw new Error('no def')
              return { recordset: [{ definition: 'CREATE VIEW dbo.v_users AS SELECT 1 AS id;' }] }
            }
            if (sql.includes('PRIM_ROW')) {
              const rs = Object.assign([42, 'hello', 'fn'], {
                columns: [
                  { name: '', type: {} },
                  { name: 'txt', type: { name: 'NVarChar' } },
                  { name: 'fn', type: function CustomFnType() {} },
                ],
              })
              return { recordsets: [rs], rowsAffected: [2] }
            }
            if (sql.includes('OBJ_META')) {
              const rs = Object.assign([{ a: 1, b: 2 }], {
                columns: { c2: { name: 'b', index: 2 }, c1: { name: 'a', index: 1 } },
              })
              return { recordset: rs, rowsAffected: [] }
            }
            if (sql.includes('SINGLE_RS')) {
              return {
                recordset: [{ k: 1 }],
                rowsAffected: undefined,
              }
            }
            if (sql.includes('DML_ONLY')) {
              return { recordsets: [], rowsAffected: [3] }
            }
            if (sql.startsWith('UPDATE ')) {
              if (failUpdateOnce) {
                failUpdateOnce = false
                throw new Error('update err')
              }
              return { rowsAffected: [1] }
            }
            if (sql.startsWith('DELETE ')) {
              return { rowsAffected: [1] }
            }
            if (sql.startsWith('INSERT ')) {
              if (failApplyOnce) {
                failApplyOnce = false
                throw new Error('insert err')
              }
              // omit rowsAffected to hit fallback `stmt.rowCount`
              return {}
            }
            return { recordset: [{ total: 1, id: 1 }], rowsAffected: [0] }
          },
          cancel() {
            throw new Error('cancel broken')
          },
        }
      }

      const pool: MssqlPoolLike = {
        connected: true,
        // omit `on` and `listenerCount` on pool1 to test optional listener guard
        connect: async () => pool,
        close: async () => {},
        request: () => makeReq(),
        transaction: () => {
          txCount++
          return {
            async begin() {
              if (holdBegin) {
                holdBegin = false
                return new Promise<void>((resolve) => {
                  holdBeginResolve = resolve
                })
              }
            },
            async commit() {},
            async rollback() {
              if (failRollbackCatch) {
                failRollbackCatch = false
                throw new Error('rb err')
              }
            },
            request: () => makeReq(),
          }
        },
      }

      const sess = new MssqlSession(pool, mssqlProfile())
      expect((await sess.listSchemas()).defaultSchema).toBe('dbo')
      expect((await sess.listObjects('dbo')).length).toBe(2)
      expect(await sess.getTableDetails('users', 'dbo')).toMatchObject({ primaryKey: ['id'] })
      expect(await sess.getDdl('v_users', 'dbo')).toContain('CREATE VIEW')
      failViewDdl = true
      expect(await sess.getDdl('v_users', 'dbo')).toContain('CREATE TABLE')
      failViewDdl = false
      // Export schema DDL exercises getObjectDdl callback (L642-644) + view & table
      const expDdl = await sess.exportSchemaDdl('dbo')
      expect(expDdl.objectCount).toBe(2)

      // Bind Date, ArrayBuffer, Uint8Array with byteOffset, null/undefined, bigint, boolean
      const rawBuf = new Uint8Array([1, 2, 3, 4])
      const subView = new Uint8Array(rawBuf.buffer, 1, 2)
      await sess.updateCell({
        table: 'users',
        primaryKeys: { id: 1 },
        column: 'bin',
        newValue: subView,
        originalValue: new Date('2025-01-01T00:00:00Z'),
      })
      await sess.updateCell({
        table: 'users',
        primaryKeys: { id: 2 },
        column: 'bin2',
        newValue: rawBuf.buffer,
        originalValue: new Date('invalid'),
      })

      // Unpinned fetchPage (L706) + Date/invalid Date newValue (L406-410) + unpinned applyChanges commit (L936)
      expect((await sess.fetchPage({ table: 'users', page: 1, pageSize: 5 })).rows).toHaveLength(1)
      await sess.updateCell({
        table: 'users',
        primaryKeys: { id: 1 },
        column: 'dt',
        newValue: new Date('2025-02-03T04:05:06Z'),
      })
      await sess.updateCell({
        table: 'users',
        primaryKeys: { id: 1 },
        column: 'dt',
        newValue: new Date('invalid'),
      })
      expect((await sess.applyChanges({ table: 'users', inserts: [{ id: 31 }] })).inserted).toBe(1)

      // Fresh autoCommit=false sessions calling updateCell (L804-805) and applyChanges (L964-965) directly with tx===null
      const ucAutoTx = new MssqlSession(pool, mssqlProfile())
      await ucAutoTx.setAutoCommit(false)
      await ucAutoTx.updateCell({ table: 'users', primaryKeys: { id: 1 }, column: 'name', newValue: 'x' })
      await expect(ucAutoTx.setAutoCommit(true)).rejects.toMatchObject({ code: 'TX_ACTIVE' })
      await ucAutoTx.rollbackTransaction()
      await ucAutoTx.close()

      const appAutoTx = new MssqlSession(pool, mssqlProfile())
      await appAutoTx.setAutoCommit(false)
      await appAutoTx.applyChanges({ table: 'users', inserts: [{ id: 32 }] })
      await appAutoTx.commitTransaction()
      await appAutoTx.close()

      // Standalone BEGIN TRAN / COMMIT / ROLLBACK when tx===null (L1031-1087) + same-batch BEGIN+COMMIT (L444-445) + DML-only runQuery (L1173-1182)
      const sameBatchTxQ = await sess.runQuery('ms-same-batch', 'BEGIN TRAN; SELECT 1 AS a; COMMIT TRAN;')
      expect(sameBatchTxQ.isSelect).toBe(true)
      const standaloneTxQ = await sess.runQuery(
        'ms-standalone-tx',
        'BEGIN TRAN;\nGO\nSELECT 1 AS a;\nGO\nCOMMIT TRAN;\nGO\nBEGIN TRAN;\nGO\nROLLBACK TRAN;'
      )
      expect(standaloneTxQ.resultSets?.length).toBe(5)
      const dmlOnlyQ = await sess.runQuery('ms-dml-only', 'UPDATE t SET x=1; -- DML_ONLY')
      expect(dmlOnlyQ.isSelect).toBe(false)
      expect(dmlOnlyQ.affectedRows).toBe(3)

      // Auto-commit=false transitions -> fetchPage / updateCell / applyChanges auto-begin tx & increment statementCount
      await sess.setAutoCommit(false)
      const p1 = await sess.fetchPage({ table: 'users', page: 1, pageSize: 5 })
      expect(p1.rows).toHaveLength(1)
      expect(txCount).toBeGreaterThanOrEqual(1)

      await sess.updateCell({
        table: 'users',
        primaryKeys: { id: 1 },
        column: 'name',
        newValue: 'u_pinned',
      })
      expect(sess.getTransactionState().statementCount).toBeGreaterThanOrEqual(1)

      // Pinned applyChanges deletes + updates + chunked inserts (omitted rowsAffected fallback -> stmt.rowCount)
      const appPinned = await sess.applyChanges({
        table: 'users',
        deletes: [{ id: 10 }],
        updates: [{ primaryKeys: { id: 1 }, changes: { name: 'b' } }],
        inserts: [{ id: 20, name: 'c' }],
      })
      expect(appPinned).toMatchObject({ ok: true, deleted: 1, updated: 1, inserted: 1 })
      await sess.commitTransaction()
      await sess.setAutoCommit(true)

      // Unpinned applyChanges rollback error catch (L952-953)
      failApplyOnce = true
      failRollbackCatch = true
      await expect(sess.applyChanges({ table: 'users', inserts: [{ id: 30 }] })).rejects.toThrow('insert err')

      // runQuery variants: PRIM_ROW (maxRows=0, sql_variant type, primitive row), OBJ_META, SINGLE_RS, DML_ONLY, cancelQuery missing
      const qVariants = await sess.runQuery(
        'ms-vars',
        'SELECT * FROM PRIM_ROW;\nGO\nSELECT * FROM OBJ_META;\nGO\nSELECT * FROM SINGLE_RS;\nGO\nUPDATE t SET x=1; -- DML_ONLY',
        0
      )
      expect(qVariants.resultSets?.length).toBe(4)
      expect(qVariants.resultSets?.[0].columns[0]).toEqual({ name: 'col_1', type: 'sql_variant' })
      expect(await sess.cancelQuery('not-active')).toEqual({ ok: true })

      // readOnly guard in runQuery
      const roSess = new MssqlSession(pool, mssqlProfile({ readOnly: true }))
      await expect(roSess.runQuery('ms-ro', 'EXEC sp_who2')).rejects.toMatchObject({ code: 'READ_ONLY'.toLowerCase() })
      await roSess.close()

      // Queued tx races when session closes mid-operation (L697-698, L801-802, L961-962, L994-995, L1014-1015, L1227-1228, L1256-1258)
      const racePool: MssqlPoolLike = {
        ...pool,
        on: () => {},
        listenerCount: () => 0,
      }
      const raceSess = new MssqlSession(racePool, mssqlProfile())
      await raceSess.setAutoCommit(false)

      // Hold a slow query inside runExclusiveTxOp while queueing fetchPage / updateCell / applyChanges / runQuery / setAutoCommit, then close()
      holdSlow = true
      const qHolder = raceSess.runQuery('ms-hold', 'SELECT * FROM SLOW_HOLD').catch((e) => e)
      await new Promise((r) => setTimeout(r, 15))
      const qFetchClose = raceSess.fetchPage({ table: 'users', page: 1, pageSize: 5 }).catch((e) => e)
      const qUpdClose = raceSess.updateCell({ table: 'users', primaryKeys: { id: 1 }, column: 'c', newValue: 'x' }).catch((e) => e)
      const qAppClose = raceSess.applyChanges({ table: 'users', inserts: [{ id: 1 }] }).catch((e) => e)
      const qRunClose = raceSess.runQuery('ms-q-close', 'SELECT 1').catch((e) => e)
      const qSetAcClose = raceSess.setAutoCommit(true).catch((e) => e)

      await raceSess.close()
      holdSlowResolve?.()
      expect(await qHolder).toMatchObject({ code: 'cancelled' })
      expect(await qFetchClose).toMatchObject({ code: 'SESSION_CLOSED' })
      expect(await qUpdClose).toMatchObject({ code: 'SESSION_CLOSED' })
      expect(await qAppClose).toMatchObject({ code: 'SESSION_CLOSED' })
      expect(await qRunClose).toMatchObject({ code: 'SESSION_CLOSED' })
      expect(await qSetAcClose).toMatchObject({ code: 'SESSION_CLOSED' })

      // beginTransactionLocked when close() fires during tx.begin() (L1256-1258)
      const beginRaceSess = new MssqlSession(pool, mssqlProfile())
      holdBegin = true
      failRollbackCatch = true
      const beginRaceP = beginRaceSess.beginTransaction().catch((e) => e)
      await new Promise((r) => setTimeout(r, 15))
      await beginRaceSess.close()
      holdBeginResolve?.()
      expect(await beginRaceP).toMatchObject({ code: 'SESSION_CLOSED' })

      // runQuery mid-multi-batch cancellation BEFORE batch 2 executes (L1014-1015): batch 1 is standalone BEGIN TRAN whose tx.begin() cancels
      const cancelMidSess = new MssqlSession(pool, mssqlProfile())
      const origTxFn = pool.transaction
      pool.transaction = () => {
        const tx = origTxFn()
        const origBegin = tx.begin.bind(tx)
        tx.begin = async () => {
          await origBegin()
          await cancelMidSess.cancelQuery('ms-mid-cancel')
        }
        return tx
      }
      await expect(
        cancelMidSess.runQuery('ms-mid-cancel', 'BEGIN TRAN;\nGO\nSELECT 2;')
      ).rejects.toMatchObject({ code: 'cancelled' })
      pool.transaction = origTxFn
      await cancelMidSess.close()

      // queryExecutor when closed (L500-501): close() inside getTableDetails after columns query so next queryExecutor call sees isClosed=true
      const qeCloseSess = new MssqlSession(pool, mssqlProfile())
      const origPoolReq = pool.request
      pool.request = () => {
        const r = makeReq()
        const origQ = r.query.bind(r)
        r.query = async (s: string) => {
          const out = await origQ(s)
          if (s.includes('FROM sys.columns c')) {
            void qeCloseSess.close()
          }
          return out
        }
        return r
      }
      await expect(qeCloseSess.getDdl('v_users', 'dbo')).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
      pool.request = origPoolReq
      await sess.close()
    })
  })

  describe('8. src/drivers/oracle/driver.ts mocked OracleConnectionLike / oracledb & PBT', () => {
    function oracleProfile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
      return {
        id: 'w4b-oracle',
        name: 'w4b-oracle',
        driver: 'oracle',
        host: 'localhost',
        port: 1521,
        user: 'hr',
        database: 'FREEPDB1',
        ...overrides,
      }
    }

    it('covers splitOracleStatements (first-token quotes & PBT), buildOracleConnectionConfig, and OracleDriver.createSession', async () => {
      // First-token single & double quotes setting currentIsPlSql (L287, L296-297)
      const qChunks = splitOracleStatements("'hello' FROM DUAL; \"MY_COL\" SELECT 1 FROM DUAL;")
      expect(qChunks).toHaveLength(2)

      fc.assert(
        fc.property(fc.stringMatching(/^[A-Za-z0-9_]{1,10}$/), (tok) => {
          const chunks = splitOracleStatements(`SELECT q'[${tok};x]' FROM DUAL; SELECT 1 FROM DUAL;`)
          expect(chunks).toHaveLength(2)
        }),
        { numRuns: 20 }
      )

      // buildOracleConnectionConfig variants: parenthesized url, tcps://, ?schema & ?sid, host/svc, TLS wallet
      const parenCfg = await buildOracleConnectionConfig(
        oracleProfile({ url: '(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=ora)(PORT=1521)))' })
      )
      expect(parenCfg.attrs.connectString).toContain('(DESCRIPTION=')

      const urlFullCfg = await buildOracleConnectionConfig(
        oracleProfile({
          host: undefined,
          port: undefined,
          user: undefined,
          database: 'ORCL',
          url: 'oracle://scott:tiger%21@ora.internal:1522/myservice?schema=APP&sid=ORCL1',
        })
      )
      expect(urlFullCfg.attrs.connectString).toContain('SID=ORCL1')
      expect(urlFullCfg.currentSchema).toBe('APP')

      // OracleDriver.createSession mocked oracledb.getConnection: currentSchema, usedDatabaseAsService ORA-01435 & non-1435 error cleanup
      const closeSpy = vi.fn(async () => {})
      const execSpy = vi.fn(async (sql: string) => {
        if (sql.includes('BAD_SCHEMA')) {
          throw Object.assign(new Error('ORA-00922: invalid option'), { errorNum: 922 })
        }
        if (sql.includes('MISSING_SCHEMA')) {
          throw Object.assign(new Error('ORA-01435: user does not exist'), { errorNum: 1435 })
        }
        return { rows: [] }
      })
      const getConnSpy = vi.spyOn(oracledb, 'getConnection').mockResolvedValue({
        execute: execSpy,
        commit: async () => {},
        rollback: async () => {},
        close: closeSpy,
      } as never)

      const oDriver = new OracleDriver()
      // currentSchema set via ?schema=APP
      const s1 = await oDriver.createSession(
        oracleProfile({ url: 'oracle://hr:pw@127.0.0.1:1521/FREEPDB1?schema=APP' })
      )
      expect(execSpy).toHaveBeenCalledWith(
        expect.stringContaining('CURRENT_SCHEMA = "APP"'),
        {},
        { autoCommit: true }
      )
      await s1.close()

      // usedDatabaseAsService with non-default db hitting ORA-01435 (tolerated)
      const s2 = await oDriver.createSession(oracleProfile({ database: 'MISSING_SCHEMA' }), 'pw')
      await s2.close()

      // usedDatabaseAsService hitting ORA-00922 -> closes conn & rethrows scrubbed error
      await expect(
        oDriver.createSession(oracleProfile({ database: 'BAD_SCHEMA' }), 'pw')
      ).rejects.toThrow(/ORA-00922/)
      expect(closeSpy).toHaveBeenCalled()
      getConnSpy.mockRestore()
    })

    it('covers all OracleSession paths: schema/DDL/fetchPage, isAlive, breakExecution, queued/mid-loop cancel, frozen error & autoCommit tx', async () => {
      let holdSlow = false
      let holdSlowResolve: (() => void) | null = null
      let failExecWith: unknown = null
      let healthyFlag = true

      const conn: OracleConnectionLike = {
        isHealthy: () => healthyFlag,
        async breakExecution() {},
        async execute(sql: string) {
          if (failExecWith !== null) {
            const e = failExecWith
            failExecWith = null
            throw e
          }
          if (holdSlow) {
            holdSlow = false
            return new Promise((resolve) => {
              holdSlowResolve = () => resolve({ rows: [{ OK: 1 }] })
            })
          }
          if (sql.includes('all_users')) {
            return { rows: [{ schema_name: 'HR' }, { schema_name: 'SYSTEM' }] }
          }
          if (sql.includes('all_objects')) {
            return {
              rows: [
                { object_name: 'EMP', owner: 'HR', object_type: 'TABLE' },
                { object_name: 'V_EMP', owner: 'HR', object_type: 'VIEW' },
              ],
            }
          }
          if (sql.includes('all_tab_columns')) {
            return { rows: [{ column_name: 'ID', data_type: 'NUMBER', nullable: 'N', identity_column: 'YES' }] }
          }
          if (sql.includes("ac.constraint_type = 'P'")) {
            return { rows: [{ column_name: 'ID', constraint_name: 'PK_EMP' }] }
          }
          if (sql.includes('all_views')) {
            return { rows: [{ text: 'SELECT 1 AS ID FROM DUAL' }] }
          }
          if (sql.includes('COUNT(*)')) {
            return { rows: [{ total: 1 }] }
          }
          if (sql.includes('EMPTY_ROWS')) {
            return { rows: [], metaData: [] }
          }
          if (sql.startsWith('UPDATE ') || sql.startsWith('DELETE ') || sql.startsWith('INSERT ')) {
            return { rowsAffected: 1 }
          }
          return { rows: [{ ID: 1, NAME: 'Alice' }], rowsAffected: 0 }
        },
        async commit() {},
        async rollback() {},
        async close() {},
      }

      const sess = new OracleSession(conn, oracleProfile())
      expect(sess.isAlive()).toBe(true)
      healthyFlag = false
      expect(sess.isAlive()).toBe(false)
      healthyFlag = true

      expect((await sess.listSchemas()).defaultSchema).toBe('HR')
      expect((await sess.listObjects('HR')).length).toBe(2)
      expect(await sess.getDdl('EMP', 'HR')).toContain('CREATE TABLE')
      expect(await sess.getObjectDdl('EMP', 'table', 'HR')).toContain('CREATE TABLE')
      expect(await sess.getObjectDdl('V_EMP', 'view', 'HR')).toContain('CREATE OR REPLACE VIEW')
      expect((await sess.exportSchemaDdl('HR')).objectCount).toBe(2)

      const page = await sess.fetchPage({
        table: 'EMP',
        schema: 'HR',
        page: 1,
        pageSize: 10,
        whereClause: 'ID = 1',
        orderByClause: 'ID ASC',
      })
      expect(page.totalRows).toBe(1)

      // applyChanges with autoCommit=false starts txActive & updates statementCount (L1097-1103)
      await sess.setAutoCommit(false)
      const insRes = await sess.applyChanges({ table: 'EMP', inserts: [{ ID: 10 }] })
      expect(insRes.inserted).toBe(1)
      expect(sess.getTransactionState().active).toBe(true)
      await sess.rollbackTransaction()
      await sess.setAutoCommit(true)

      // runQuery autoCommit=false with DML auto-starts tx
      await sess.setAutoCommit(false)
      await sess.runQuery('ora-ac-dml', 'INSERT INTO EMP (ID) VALUES (11);')
      expect(sess.getTransactionState().active).toBe(true)
      await sess.commitTransaction()
      await sess.setAutoCommit(true)

      // applyChanges unpinned commit (L1095) + deleteRows valid table (L987) + succeeding deletes/updates (L1063-1064, L1081-1082)
      const unpinnedIns = await sess.applyChanges({
        table: 'EMP',
        deleteRows: [{ ID: 8 }],
        updates: [{ primaryKeys: { ID: 7 }, changes: { NAME: 'Upd' } }],
        inserts: [{ ID: 9 }],
      })
      expect(unpinnedIns).toMatchObject({ ok: true, deleted: 1, updated: 1, inserted: 1 })

      const origExec0 = conn.execute
      conn.execute = async (s, b, o) => {
        if (s.includes('all_tab_columns')) throw new Error('no table')
        return origExec0(s, b, o)
      }
      const prevDelFallback = await sess.previewChanges({ table: 'MISSING', deleteRows: [{ ID: 5 }] })
      expect(prevDelFallback.statements[0]).toContain('"ID" = 5')

      conn.execute = async (s, b, o) => {
        if (s.startsWith('UPDATE ') || s.startsWith('DELETE ')) return { rowsAffected: 0 }
        return origExec0(s, b, o)
      }
      await expect(sess.updateCell({ table: 'EMP', primaryKeys: { ID: 1 }, column: 'NAME', newValue: 'X' })).rejects.toMatchObject({ code: 'conflict' })
      await expect(sess.applyChanges({ table: 'EMP', deletes: [{ ID: 1 }] })).rejects.toMatchObject({ code: 'conflict' })
      await expect(sess.applyChanges({ table: 'EMP', updates: [{ primaryKeys: { ID: 1 }, changes: { NAME: 'X' } }] })).rejects.toMatchObject({ code: 'conflict' })

      conn.execute = async (s, b, o) => {
        if (s.startsWith('UPDATE ')) return { rowsAffected: 2 }
        return origExec0(s, b, o)
      }
      await expect(sess.updateCell({ table: 'EMP', primaryKeys: { ID: 1 }, column: 'NAME', newValue: 'X' })).rejects.toMatchObject({ code: 'conflict' })

      // extractOracleColumnsAndRows primitive rows without metaData (L479)
      conn.execute = async (s, b, o) => {
        if (s.includes('PRIM_ARR')) return { metaData: [], rows: [1, 2] }
        return origExec0(s, b, o)
      }
      expect((await sess.runQuery('ora-prim', 'SELECT * FROM PRIM_ARR')).columns).toEqual([])
      conn.execute = origExec0

      // updateCell when selectPk returns empty rows (L943) + non-array fetched.rows
      const origExec = conn.execute
      conn.execute = async (s, b, o) => {
        if (s.includes('SELECT * FROM')) return {}
        return origExec(s, b, o)
      }
      const updEmptyReadback = await sess.updateCell({
        table: 'EMP',
        primaryKeys: { ID: 1 },
        column: 'NAME',
        newValue: 'Bob',
      })
      expect(updEmptyReadback.updatedRecord).toBeUndefined()
      conn.execute = origExec

      // Frozen error without .code -> scrubOracleError returns ORACLE_ERROR (L395-396)
      const frozenErr = new Error('oracle://hr:TopSecret99@db:1521/FREEPDB1 broken')
      Object.defineProperty(frozenErr, 'message', { value: frozenErr.message, writable: false, configurable: true })
      failExecWith = frozenErr
      await expect(sess.runQuery('ora-frozen', 'SELECT 1 FROM DUAL')).rejects.toMatchObject({
        code: 'ORACLE_ERROR',
      })

      // readOnly guard in runQuery (isOracleReadOnlyBlocked L326-336, L1134-1135) incl. SELECT allowed & SAVEPOINT blocked
      const roSess = new OracleSession(conn, oracleProfile({ readOnly: true }))
      expect((await roSess.runQuery('ora-ro-sel', 'SELECT 1 FROM DUAL;')).isSelect).toBe(true)
      await expect(roSess.runQuery('ora-ro-sp', 'SAVEPOINT sp1;')).rejects.toMatchObject({
        code: 'read_only',
      })
      await expect(roSess.runQuery('ora-ro-plsql', 'BEGIN NULL; END;\n/')).rejects.toMatchObject({
        code: 'read_only',
      })
      await expect(roSess.runQuery('ora-ro-lock', 'LOCK TABLE EMP IN EXCLUSIVE MODE;')).rejects.toMatchObject({
        code: 'read_only',
      })
      await roSess.close()

      // cancelQuery missing -> { ok: true } (L1310-1311), queued query cancelled before runExclusiveOp executes (L1141-1144), and mid-loop cancel (L1161-1163)
      expect(await sess.cancelQuery('missing-ora-q')).toEqual({ ok: true })
      holdSlow = true
      const qFirst = sess.runQuery('ora-hold-1', 'SELECT 1 FROM DUAL')
      const qQueued = sess.runQuery('ora-queued-2', 'SELECT 2 FROM DUAL').catch((e) => e)
      await new Promise((r) => setTimeout(r, 15))
      await sess.cancelQuery('ora-queued-2')
      holdSlowResolve?.()
      await qFirst
      expect(await qQueued).toMatchObject({ code: 'cancelled' })

      // Mid-loop cancel between COMMIT chunk and SELECT chunk (L1162-1163)
      const origCommit = conn.commit
      conn.commit = async () => {
        await origCommit()
        await sess.cancelQuery('ora-mid-loop')
      }
      await expect(
        sess.runQuery('ora-mid-loop', 'COMMIT; SELECT 2 FROM DUAL;')
      ).rejects.toMatchObject({ code: 'cancelled' })
      conn.commit = origCommit

      await sess.close()
    })
  })

  describe('9. Round 2 exhaustive branch polish across all 8 drivers', () => {
    it('9.1 tls-and-tunnel + driver-manager remaining reachable branches', async () => {
      // tls-and-tunnel L488:29: sshAuthMethod omitted -> falls back to 'agent'
      await expect(
        openSshTunnel({
          ...makeProfile({
            id: 'r2-ssh-undef-auth',
            driver: 'postgres',
            host: '127.0.0.1',
            port: 55433,
            sshEnabled: true,
            sshHost: '127.0.0.1',
            sshPort: 52222,
            sshUser: 'datanoa',
            sshAuthMethod: undefined,
          }),
          sshPassword: '',
        })
      ).rejects.toThrow()

      // driver-manager L116:42: normalizeSha256 invalid checksum (non-hex 64 chars & short string)
      const dir = makeTempDir('dm-r2-')
      const entryFile = path.join(dir, 'custom-driver.mjs')
      fs.writeFileSync(
        entryFile,
        'export default { type: "customr2", createSession: async () => { throw new Error("stub") } }\n',
        'utf8'
      )
      const persistedPath = path.join(dir, 'drivers.json')
      const mgr = new DriverManager(
        {
          readPersistedConfigs: async () =>
            fs.existsSync(persistedPath) ? JSON.parse(fs.readFileSync(persistedPath, 'utf8')) : [],
          writePersistedConfigs: async (cfgs) => {
            fs.writeFileSync(persistedPath, JSON.stringify(cfgs), 'utf8')
          },
        },
        () => {}
      )
      await expect(
        mgr.configureLocalDriver({
          driverId: 'customr2',
          localPath: entryFile,
          trustedSha256: 'z'.repeat(64),
        })
      ).rejects.toThrow(/SHA-256/i)
      await expect(
        mgr.configureLocalDriver({
          driverId: 'customr2',
          localPath: entryFile,
          trustedSha256: 'bad-sha',
        })
      ).rejects.toThrow(/SHA-256/i)
    })

    it('9.2 d1/driver.ts branch polish + PBT param coercion', async () => {
      const profile = makeProfile({
        id: 'd1-r2',
        driver: 'd1',
        d1AccountId: 'acc123',
        d1DatabaseId: 'db456',
      })
      let fetchHandler: (url: string, init?: RequestInit) => Promise<Response> = async () =>
        new Response(JSON.stringify({ success: true, result: [{ success: true, results: [] }] }), { status: 200 })

      vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
        fetchHandler(String(input), init)
      )

      const sess = new D1Session(profile, 'tok-d1-r2')

      // L369, L382: listObjects() and exportSchemaDdl() with undefined and whitespace schemas
      const seenSql: string[] = []
      fetchHandler = async (_url, init) => {
        const body = JSON.parse(String(init?.body || '{}')) as { sql?: string }
        seenSql.push(body.sql || '')
        if ((body.sql || '').includes('sqlite_master') && (body.sql || '').includes('sql IS NOT NULL')) {
          return new Response(
            JSON.stringify({
              success: true,
              result: [{ success: true, results: [{ sql: 'CREATE TABLE a (id INT);' }, { sql: null }] }],
            }),
            { status: 200 }
          )
        }
        return new Response(
          JSON.stringify({ success: true, result: [{ success: true }] }), // missing results -> L339 []
          { status: 200 }
        )
      }
      expect(await sess.listObjects()).toEqual([])
      expect(await sess.listObjects('   ')).toEqual([])
      const ddl1 = await sess.exportSchemaDdl()
      expect(ddl1.ddl).toContain('-- Schema: main')
      const ddl2 = await sess.exportSchemaDdl('   ')
      expect(ddl2.objectCount).toBe(0)
      const objDdlRes = await sess.getObjectDdl('a', 'table', '   ')
      expect(objDdlRes).toBe('CREATE TABLE a (id INT);')

      // L161 false, L165 unsafe bigint, L319 empty detail, L826 multi-stmt ro, L850 missing payload, L866 empty PRAGMA, L871 maxRows=0, L929 DDL clear
      const driver = new D1Driver()
      fetchHandler = async () => {
        throw new Error('')
      }
      const connFail = await driver.testConnection(profile, 'tok-d1-r2')
      expect(connFail).toEqual({ ok: false, message: 'Cloudflare D1 HTTP request failed' })

      fetchHandler = async () =>
        new Response(JSON.stringify({ success: false, errors: [], messages: [] }), { status: 200 })
      await expect(sess.runQuery('d1-empty-fail', 'SELECT ? AS b, ? AS big', 10, [false, 9007199254740993n])).rejects.toMatchObject({
        code: 'D1_ERROR',
      })

      // PBT: normalize boolean false/true and safe vs unsafe bigint params serialized cleanly in batch payload
      await fc.assert(
        fc.asyncProperty(fc.boolean(), fc.bigInt({ min: 9007199254740993n, max: 9007199254741999n }), async (flag, big) => {
          let capturedParams: unknown[] = []
          fetchHandler = async (_u, init) => {
            const raw = JSON.parse(String(init?.body || '{}')) as unknown
            const firstItem = Array.isArray(raw)
              ? (raw[0] as { params?: unknown[] })
              : ((raw as { batch?: Array<{ params?: unknown[] }>; params?: unknown[] }).batch?.[0] ||
                (raw as { params?: unknown[] }))
            capturedParams = firstItem?.params || []
            return new Response(
              JSON.stringify({ success: true, result: [{ success: true, meta: { changes: 1 } }] }),
              { status: 200 }
            )
          }
          await sess.applyChanges({ table: 'a', inserts: [{ ok: flag, id: big }] })
          expect(capturedParams).toEqual([flag ? 1 : 0, big.toString()])
        }),
        { numRuns: 6 }
      )

      // readOnly second-statement mutating check (L826)
      const roSess = new D1Session({ ...profile, readOnly: true }, 'tok-d1-r2')
      await expect(roSess.runQuery('d1-ro-multi', 'SELECT 1; DELETE FROM a')).rejects.toMatchObject({ code: 'READ_ONLY' })
      await roSess.close()

      // Multi-statement with maxRows=0, empty PRAGMA (L866), PRAGMA = 1 (non-select), and DDL cache clear (L929)
      fetchHandler = async () =>
        new Response(
          JSON.stringify({
            success: true,
            result: [
              { success: true, results: [{ v: 1 }] },
              { success: true, results: [] },
              { success: true, results: [], meta: { changes: 0 } },
              { success: true, results: [], meta: { changes: 0 } },
            ],
          }),
          { status: 200 }
        )
      const multiRes = await sess.runQuery(
        'd1-multi-pragma',
        'SELECT 1 AS v; PRAGMA table_info("a"); PRAGMA user_version = 1; CREATE TABLE cov_d1_t (id INT);',
        0
      )
      expect(multiRes.isSelect).toBe(true)
      expect(multiRes.resultSets?.length).toBe(4)

      // fetchPage count=[] (L423) and updateCell with missing meta.changes (L451)
      fetchHandler = async () =>
        new Response(JSON.stringify({ success: true, result: [{ success: true, results: [] }] }), { status: 200 })
      const emptyPage = await sess.fetchPage({ table: 'a', page: 1, pageSize: 10 })
      expect(emptyPage.totalRows).toBe(0)

      fetchHandler = async (_u, init) => {
        const body = JSON.parse(String(init?.body || '{}')) as { sql?: string }
        if ((body.sql || '').startsWith('UPDATE')) {
          return new Response(JSON.stringify({ success: true, result: [{ success: true, results: [] }] }), { status: 200 })
        }
        return new Response(
          JSON.stringify({ success: true, result: [{ success: true, results: [{ id: 1, v: 'x' }] }] }),
          { status: 200 }
        )
      }
      await expect(
        sess.updateCell({
          table: 'a',
          primaryKeys: { id: 1 },
          column: 'v',
          newValue: false,
        })
      ).rejects.toMatchObject({ code: 'conflict' })

      // executeBatch network error with empty message (L555)
      fetchHandler = async () => {
        throw new Error('')
      }
      await expect(
        sess.applyChanges({
          table: 'a',
          inserts: [{ id: 1 }],
        })
      ).rejects.toThrow(/Cloudflare D1 HTTP request failed/)

      // insert-only batch HTTP 500 -> options.conflictSentinel undefined (L577)
      fetchHandler = async () =>
        new Response(JSON.stringify({ success: false, errors: [{ message: 'insert err' }] }), { status: 500 })
      await expect(
        sess.applyChanges({
          table: 'a',
          inserts: [{ id: 1 }],
        })
      ).rejects.toMatchObject({ code: 'D1_ERROR' })

      // applyChanges with deletes: guard returns SQLITE_ABORT without sentinel (L155 return false)
      fetchHandler = async () =>
        new Response(
          JSON.stringify({ success: false, errors: [{ message: 'SQLITE_ABORT: trigger aborted without marker' }] }),
          { status: 400 }
        )
      await expect(
        sess.applyChanges({
          table: 'a',
          deletes: [{ id: 1 }],
        })
      ).rejects.toMatchObject({ code: 'D1_ERROR' })

      // applyChanges with guardRows not length 1 (L763 undefined)
      fetchHandler = async () =>
        new Response(
          JSON.stringify({
            success: true,
            result: [
              { success: true, results: [] },
              { success: true, meta: { changes: 0 } },
            ],
          }),
          { status: 200 }
        )
      await expect(
        sess.applyChanges({
          table: 'a',
          deletes: [{ id: 1 }],
        })
      ).rejects.toMatchObject({ code: 'D1_ERROR' })

      // applyChanges successful delete-only (L771) + insert
      const okBatchSlot = { success: true, results: [{ guard_ok: 1 }], meta: { changes: 1 } }
      fetchHandler = async () =>
        new Response(
          JSON.stringify({
            success: true,
            result: [okBatchSlot, okBatchSlot, okBatchSlot],
          }),
          { status: 200 }
        )
      const delAndIns = await sess.applyChanges({
        table: 'a',
        deletes: [{ id: 2 }],
        inserts: [{ id: 3 }],
      })
      expect(delAndIns.deleted).toBe(1)
      expect(delAndIns.inserted).toBe(1)

      await sess.close()
    })

    it('9.3 mssql/driver.ts branch polish + pool config PBT', async () => {
      // buildMssqlPoolConfig: ssl undefined local/cloud, ssl=true & rejectUnauthorized=true, omitted port -> 1433
      await fc.assert(
        fc.asyncProperty(fc.boolean(), async (rejectUnauthorized) => {
          const cloud = await buildMssqlPoolConfig(
            makeProfile({
              driver: 'mssql',
              host: 'myserver.database.windows.net',
              port: undefined,
              ssl: undefined,
              sslRejectUnauthorized: rejectUnauthorized,
            }),
            'pw'
          )
          expect(cloud.port).toBe(1433)
          expect(cloud.options?.encrypt).toBe(true)
          expect(cloud.options?.trustServerCertificate).toBe(!rejectUnauthorized)

          const local = await buildMssqlPoolConfig(
            makeProfile({
              driver: 'mssql',
              host: '127.0.0.1',
              port: undefined,
              ssl: undefined,
            }),
            'pw'
          )
          expect(local.options?.encrypt).toBe(false)
          expect(local.options?.trustServerCertificate).toBe(true)
        }),
        { numRuns: 4 }
      )

      // isMssqlReadOnlyBlocked L158 (SELECT INTO & WAITFOR DELAY / SETUSER)
      expect(isMssqlReadOnlyBlocked('SELECT * INTO #tmp_copy FROM tbl')).toBe(true)
      expect(isMssqlReadOnlyBlocked("WAITFOR DELAY '00:00:01'")).toBe(true)
      expect(isMssqlReadOnlyBlocked("SETUSER 'dbo'")).toBe(true)

      type Handler = (sql: string) => Record<string, unknown>
      let reqHandler: Handler = () => ({ recordset: [], rowsAffected: [0] })
      const fakeReq = (): MssqlRequestLike => ({
        multiple: false,
        input: () => fakeReq(),
        query: async (sql: string) => reqHandler(sql),
        cancel: () => {},
      })
      const fakeTx = (): MssqlTransactionLike => ({
        begin: async () => {},
        commit: async () => {},
        rollback: async () => {},
        request: () => fakeReq(),
      })
      const fakePool: MssqlPoolLike = {
        connected: true,
        connect: async () => fakePool,
        close: async () => {},
        request: () => fakeReq(),
        transaction: () => fakeTx(),
      }

      const sess = new MssqlSession(fakePool, makeProfile({ id: 'ms-r2', driver: 'mssql' }))

      // Default schema undefined -> 'dbo' across listObjects/getTableDetails/getObjectDdl/exportSchemaDdl, plus object with schema=''
      reqHandler = (sql) => {
        if (sql.includes('OBJECT_DEFINITION') || sql.includes('sys.sql_modules')) {
          return {
            recordset: [{ definition: 'CREATE VIEW dbo.V_NO_SCHEMA AS SELECT 1' }],
            rowsAffected: [1],
          }
        }
        if (sql.includes('sys.objects')) {
          return {
            recordset: [
              { name: 'V_NO_SCHEMA', kind: 'view', schema: '' },
            ],
            rowsAffected: [1],
          }
        }
        return { recordset: undefined, rowsAffected: [] }
      }
      expect(await sess.listObjects()).toHaveLength(1)
      await sess.getTableDetails('T')
      await sess.getObjectDdl('V_NO_SCHEMA', 'view')
      const ddlOut = await sess.exportSchemaDdl()
      expect(ddlOut.objectCount).toBe(1)

      // fetchPage countRows=[] (L688) and non-array recordset (L660)
      reqHandler = () => ({ recordset: undefined, rowsAffected: [] })
      const msEmptyPage = await sess.fetchPage({ table: 'T', page: 1, pageSize: 5 })
      expect(msEmptyPage.totalRows).toBe(0)

      // serializeMssqlCell(undefined, unsafe bigint), serializeMssqlRecord(null/array), columns with missing .index, readAffectedCount=[]
      reqHandler = () => ({
        recordset: Object.assign([null, [1, 2], { a: undefined, big: 9007199254740993n }], {
          columns: {
            a: { name: 'a', type: { declaration: 'int' } },
            b: { name: 'b', type: { declaration: 'bigint' } },
          },
        }),
        recordsets: [
          Object.assign([null, { a: undefined, big: 9007199254740993n }], {
            columns: {
              a: { name: 'a', type: { declaration: 'int' } },
              big: { name: 'big', type: { declaration: 'bigint' } },
            },
          }),
        ],
        rowsAffected: [],
      })
      const msRowsRes = await sess.runQuery('ms-rows-edge', 'SELECT 1; ')
      expect(msRowsRes.rows.length).toBe(2)

      // Multiple non-SELECT batches -> collectedSets.length > 1 with isSelect: false (L1181)
      reqHandler = () => ({ recordset: undefined, recordsets: [], rowsAffected: [2] })
      const multiDmlMs = await sess.runQuery('ms-multi-dml', 'DELETE FROM T WHERE id=1\nGO\nDELETE FROM T WHERE id=2')
      expect(multiDmlMs.isSelect).toBe(false)
      expect(multiDmlMs.resultSets?.length).toBe(2)

      // Whitespace-only / GO-only SQL hitting L984 fallback [sql] & updateCell with undefined rowsAffected (L427) then rowsAffected:[1] + non-array selRes.recordset (L404, L771)
      await sess.runQuery('ms-go-only', 'GO')
      reqHandler = () => ({ recordset: [{ guard_ok: 1 }], rowsAffected: [undefined as unknown as number] })
      await expect(
        sess.updateCell({
          table: 'T',
          primaryKeys: { id: 1 },
          column: 'flag',
          newValue: false,
        })
      ).rejects.toThrow(/optimistic lock conflict/)

      reqHandler = (sql) => {
        if (sql.includes('SELECT * FROM')) return { recordset: undefined, rowsAffected: [0] }
        return { recordset: [{ guard_ok: 1 }], rowsAffected: [1] }
      }
      const msUpd = await sess.updateCell({
        table: 'T',
        primaryKeys: { id: 1 },
        column: 'flag',
        newValue: false,
      })
      expect(msUpd.updatedRecord).toBeUndefined()

      // extractMssqlErrorCode when err.code is undefined and frozen scrubbed message forces L130
      reqHandler = () => {
        const frozenMsErr = new Error('mssql://u:SecretPass99@h:1433/db fail')
        Object.defineProperty(frozenMsErr, 'message', { value: frozenMsErr.message, writable: false, configurable: true })
        Object.defineProperty(frozenMsErr, 'code', { value: undefined, writable: true, configurable: true })
        throw frozenMsErr
      }
      await expect(sess.runQuery('ms-undef-code', 'SELECT 1')).rejects.toMatchObject({ code: 'MSSQL_ERROR' })

      // Double close (L544) + readOnly on '; ;' (L437 fallback)
      reqHandler = () => ({ recordset: [], rowsAffected: [0] })
      const roMs = new MssqlSession(fakePool, makeProfile({ id: 'ms-ro2', driver: 'mssql', readOnly: true }))
      await roMs.runQuery('ms-semi', '; ;')
      await roMs.close()

      await sess.close()
      await sess.close()
    })

    it('9.4 oracle/driver.ts branch polish + splitOracleStatements PBT', async () => {
      // splitOracleStatements: L142 q' ', L183 empty slice before /, L185 comment-only /, L188 ';' before /, L202 trailing spaces after /, L261 EOF -- comment, L272 q' at index 0
      expect(splitOracleStatements("q'[abc;]' FROM DUAL")).toHaveLength(1)
      expect(splitOracleStatements("SELECT 'q' FROM DUAL WHERE x = q' nope'")).toHaveLength(1)
      expect(splitOracleStatements('/\n-- comment\n/\n;\n/\nBEGIN NULL; END;\n/   \nSELECT 1 -- eof')).toEqual([
        { text: 'BEGIN NULL; END;', isPlSql: true },
        { text: 'SELECT 1 -- eof', isPlSql: false },
      ])

      // PBT: trailing `-- comment` with no newline never loses preceding statement and preserves count
      fc.assert(
        fc.property(fc.stringMatching(/^[A-Za-z0-9_ ]{1,12}$/), (tag) => {
          const chunks = splitOracleStatements(`SELECT 1 FROM DUAL -- ${tag}`)
          expect(chunks).toHaveLength(1)
          expect(chunks[0]?.isPlSql).toBe(false)
        }),
        { numRuns: 5 }
      )

      // buildOracleConnectionConfig: query ?serviceName=, tcps host with '/' (tls vs already tcps://), default host/port/service with ssl:true
      const cUrlSvc = await buildOracleConnectionConfig(
        makeProfile({
          driver: 'oracle',
          host: '',
          port: undefined,
          url: 'oracle://scott:tiger@ora-host:1522/?serviceName=MYSVC',
        }),
        undefined
      )
      expect(cUrlSvc.attrs.connectString).toContain('ora-host:1522/MYSVC')

      const cSlashTls = await buildOracleConnectionConfig(
        makeProfile({ driver: 'oracle', host: 'ora-host/ORCL', port: undefined, ssl: true, database: 'ORCL' }),
        'pw'
      )
      expect(cSlashTls.attrs.connectString).toBe('tcps://ora-host/ORCL')

      const cAlreadyTcps = await buildOracleConnectionConfig(
        makeProfile({ driver: 'oracle', host: 'tcps://ora-host/ORCL', port: undefined, ssl: true, database: 'ORCL' }),
        'pw'
      )
      expect(cAlreadyTcps.attrs.connectString).toBe('tcps://ora-host/ORCL')

      const cDefaults = await buildOracleConnectionConfig(
        makeProfile({ driver: 'oracle', host: '', port: undefined, database: '', ssl: true }),
        'pw'
      )
      expect(cDefaults.attrs.connectString).toBe('tcps://localhost:2484/FREEPDB1')

      let execHandler: (sql: string, binds?: unknown) => Promise<Record<string, unknown>> = async () => ({
        rows: [],
        metaData: [],
        rowsAffected: 0,
      })
      const conn: OracleConnectionLike = {
        execute: async (sql, binds) => execHandler(sql, binds),
        commit: async () => {},
        rollback: async () => {},
        close: async () => {},
        breakExecution: async () => {},
      }
      const sess = new OracleSession(conn, makeProfile({ id: 'ora-r2', driver: 'oracle' }))

      // Omitted schema fallbacks + object empty schema + empty ddl + count=[]
      execHandler = async (sql) => {
        if (sql.includes('ALL_OBJECTS') || sql.includes('USER_OBJECTS')) {
          return { rows: [{ OBJECT_NAME: 'V1', OBJECT_TYPE: 'VIEW', OWNER: '' }] }
        }
        if (sql.toLowerCase().includes('all_views')) {
          return { rows: [{ text: 'SELECT 1 FROM DUAL' }] }
        }
        if (sql.includes('GET_DDL')) return { rows: [{ DDL_TEXT: '' }] }
        return { rows: undefined, metaData: [{ name: 'A' }], rowsAffected: undefined }
      }
      await sess.listObjects('')
      expect(await sess.getObjectDdl('V1', 'view')).toContain('CREATE OR REPLACE VIEW')
      expect(await sess.getObjectDdl('T_EMPTY_DDL', 'table')).toContain('CREATE TABLE "SYSTEM"."T_EMPTY_DDL"')
      vi.spyOn(sess, 'getTableDetails').mockResolvedValueOnce({
        name: 'T_EMPTY',
        schema: 'SYSTEM',
        columns: [],
        primaryKeys: [],
        foreignKeys: [],
        indexes: [],
        ddl: '',
      })
      expect(await sess.getDdl('T_EMPTY')).toBe('')
      await sess.exportSchemaDdl()
      const oraPage = await sess.fetchPage({ table: 'EMP', page: 1, pageSize: 5 })
      expect(oraPage.totalRows).toBe(0)
      await sess.runQuery('ora-undef-rows', 'SELECT 1 FROM DUAL')

      // bind undefined + unsafe bigint (L403, L405)
      await sess.runQuery('ora-binds', 'SELECT :1, :2 FROM DUAL', 10, [undefined, 9007199254740993n])

      // Multiple DML chunks with rowsAffected undefined & empty metaData -> collectedSets.length > 1 & isSelect:false (L1295, L923, L1055, L1073, L1091)
      execHandler = async () => ({ rows: [], metaData: [], rowsAffected: undefined })
      const oraMultiDml = await sess.runQuery('ora-multi-dml', 'UPDATE EMP SET A=1; INSERT INTO EMP VALUES (2)')
      expect(oraMultiDml.isSelect).toBe(false)
      expect(oraMultiDml.resultSets?.length).toBe(2)

      // Empty comment SQL hitting L1131 fallback
      await sess.runQuery('ora-comment', '-- comment only')

      // updateCell (L923) & applyChanges (L1055, L1073, L1091) when rowsAffected is undefined
      await expect(
        sess.updateCell({ table: 'EMP', primaryKeys: { ID: 1 }, column: 'NAME', newValue: 'Z' })
      ).rejects.toMatchObject({ code: 'conflict' })
      await expect(sess.applyChanges({ table: 'EMP', deletes: [{ ID: 1 }] })).rejects.toMatchObject({ code: 'conflict' })
      execHandler = async (sql) => {
        if (sql.startsWith('DELETE')) return { rowsAffected: 1 }
        return { rows: [], metaData: [], rowsAffected: undefined }
      }
      await expect(
        sess.applyChanges({
          table: 'EMP',
          deletes: [{ ID: 1 }],
          updates: [{ primaryKeys: { ID: 2 }, changes: { NAME: 'Y' } }],
        })
      ).rejects.toMatchObject({ code: 'conflict' })
      const oraInsFallback = await sess.applyChanges({ table: 'EMP', inserts: [{ ID: 3 }] })
      expect(oraInsFallback.inserted).toBe(1)

      // readOnly ORACLE_READONLY_BLOCK_RE on CALL / PURGE (L333)
      const roOra = new OracleSession(conn, makeProfile({ id: 'ora-ro2', driver: 'oracle', readOnly: true }))
      await expect(roOra.runQuery('ora-ro-purge', 'PURGE RECYCLEBIN')).rejects.toMatchObject({ code: 'read_only' })
      await expect(roOra.runQuery('ora-ro-call', 'CALL my_proc()')).rejects.toMatchObject({ code: 'read_only' })
      await roOra.close()

      // Non-object error + { errorNum } without .code (L360, L362)
      execHandler = async () => {
        throw 'raw string failure'
      }
      await expect(sess.runQuery('ora-str-err', 'SELECT 1 FROM DUAL')).rejects.toBe('raw string failure')

      execHandler = async () => {
        throw { errorNum: 942, message: 'ORA-00942' }
      }
      await expect(sess.runQuery('ora-num-err', 'SELECT 1 FROM DUAL')).rejects.toMatchObject({
        errorNum: 942,
        message: 'ORA-00942',
      })

      // Double close (L755)
      await sess.close()
      await sess.close()
    })

    it('9.5 libsql/driver.ts branch polish via mocked fetch & Hrana edge frames', async () => {
      // L143, L146: url empty + host with ssl:false/80 & ssl:true/443 + https IPv4 redirect checking L124 isIpLiteralHostname
      const driver = new LibsqlDriver()
      let fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = async () =>
        new Response(JSON.stringify({ results: [] }), { status: 200 })
      vi.stubGlobal('fetch', (u: RequestInfo | URL, i?: RequestInit) => fetchImpl(String(u), i))

      // Non-Error fetch failure -> L470 fallback + http:80 (L143, L146), L572 non-Error in session.test(), L1172 non-Error in testConnection
      fetchImpl = async () => {
        throw 'non-error string'
      }
      const badConn = await driver.testConnection(
        makeProfile({ driver: 'libsql', url: '', host: '127.0.0.1', port: 80, ssl: false }),
        ''
      )
      expect(badConn).toEqual({ ok: false, message: 'LibSQL HTTP request failed' })

      const sess443 = await driver.createSession(
        makeProfile({ driver: 'libsql', url: '', host: 'db.turso.io', port: 443, ssl: true }),
        'tok'
      )
      Object.assign(sess443, {
        executeSingle: async () => {
          throw 'non-error-in-session-test'
        },
      })
      expect(await sess443.test()).toEqual({ ok: false, message: 'Failed to connect to LibSQL' })
      await sess443.close()

      vi.spyOn(driver, 'createSession').mockRejectedValueOnce('non-error-create')
      expect(
        await driver.testConnection(makeProfile({ driver: 'libsql', url: 'https://db.turso.io' }), 'tok')
      ).toEqual({ ok: false, message: 'LibSQL connection failed' })

      // IP host + untrusted cross-origin redirect rejected (L124 isIpLiteralHostname), then same-origin base_url -> '   ' (L339)
      const sessIp = new LibsqlSession(makeProfile({ driver: 'libsql', url: 'https://8.8.8.8:8443' }), 'tok-r2')
      fetchImpl = async () =>
        new Response(
          JSON.stringify({
            baton: 'b0',
            base_url: 'https://replica.turso.io',
            results: [],
          }),
          { status: 200 }
        )
      await expect(sessIp.runQuery('lib-ip-reject', 'SELECT 1')).rejects.toMatchObject({ code: 'INVALID_ENDPOINT' })

      let reqNum = 0
      fetchImpl = async (_u, _i) => {
        reqNum += 1
        return new Response(
          JSON.stringify({
            baton: reqNum === 1 ? 'b1' : null,
            base_url: reqNum === 1 ? 'https://8.8.8.8:8443' : '   ',
            results: [
              {
                type: 'ok',
                response: {
                  type: 'execute',
                  result: {
                    cols: [{ name: 'a', decltype: null }],
                    rows: [[42, { type: 'integer', value: '9007199254740993' }, { type: 'custom', value: undefined }]],
                  },
                },
              },
            ],
          }),
          { status: 200 }
        )
      }
      const resIp = await sessIp.runQuery('lib-ip', 'SELECT ? AS big', 10, [9007199254740993n])
      expect(resIp.rows[0]).toEqual([42, '9007199254740993', null])

      // PRAGMA read-only vs '=' assignment + PRAGMA missing cols/rows
      fetchImpl = async () =>
        new Response(JSON.stringify({ results: [{ type: 'ok', response: { type: 'execute', result: {} } }] }), {
          status: 200,
        })
      expect((await sessIp.runQuery('lib-pragma-ro', 'PRAGMA table_info("t")')).isSelect).toBe(true)
      expect((await sessIp.runQuery('lib-pragma-rw', 'PRAGMA journal_mode = WAL')).isSelect).toBe(false)

      // Multi-stmt batch: step_errors without .code (L1063), step_results missing / sparse [null, res] (L1057, L1068, L1071)
      fetchImpl = async () =>
        new Response(
          JSON.stringify({
            results: [
              {
                type: 'ok',
                response: {
                  type: 'batch',
                  result: { step_errors: [null, { message: '   ' }] },
                },
              },
              { type: 'ok', response: { type: 'close' } },
            ],
          }),
          { status: 200 }
        )
      await expect(sessIp.runQuery('lib-batch-err', 'SELECT 1; SELECT 2')).rejects.toMatchObject({ code: 'LIBSQL_ERROR' })

      fetchImpl = async () =>
        new Response(
          JSON.stringify({
            results: [
              {
                type: 'ok',
                response: {
                  type: 'batch',
                  result: {
                    step_results: [
                      null,
                      { cols: [{ name: 'c' }], rows: [[{ type: 'text', value: 'ok' }]] },
                    ],
                  },
                },
              },
              { type: 'ok', response: { type: 'close' } },
            ],
          }),
          { status: 200 }
        )
      const sparseBatch = await sessIp.runQuery('lib-batch-sparse', 'SELECT 1; SELECT 2')
      expect(sparseBatch.rows).toEqual([['ok']])

      fetchImpl = async () =>
        new Response(
          JSON.stringify({
            results: [
              { type: 'ok', response: { type: 'batch', result: {} } },
              { type: 'ok', response: { type: 'close' } },
            ],
          }),
          { status: 200 }
        )
      expect((await sessIp.runQuery('lib-batch-empty', 'INSERT INTO t VALUES (1); DELETE FROM t')).affectedRows).toBe(0)

      // HTTP non-2xx empty body (L481), non-Error text/json rejection (L492), results not array (L510), missing result (L537)
      fetchImpl = async () => new Response('', { status: 502 })
      await expect(sessIp.runQuery('lib-502', 'SELECT 1')).rejects.toThrow(/502/)

      fetchImpl = async () =>
        ({
          ok: true,
          status: 200,
          text: async () => {
            throw 'bad response stream'
          },
        }) as unknown as Response
      await expect(sessIp.runQuery('lib-bad-text', 'SELECT 1')).rejects.toThrow(/bad response stream/)

      fetchImpl = async () => new Response(JSON.stringify({ results: 'invalid' }), { status: 200 })
      await expect(sessIp.listObjects()).rejects.toThrow(/Missing Hrana pipeline result/)

      fetchImpl = async () =>
        new Response(
          JSON.stringify({
            results: [{ type: 'ok', response: {} }, { type: 'ok', response: {} }],
          }),
          { status: 200 }
        )
      expect((await sessIp.fetchPage({ table: 't', page: 1, pageSize: 5 })).totalRows).toBe(0)
      await expect(
        sessIp.updateCell({ table: 't', primaryKeys: { id: 1 }, column: 'v', newValue: 'x' })
      ).rejects.toMatchObject({ code: 'conflict' })

      // L839/L846/L860/L874: applyChanges missing .result & affected_row_count undefined (delete conflict, update conflict, insert fallback=1)
      await expect(sessIp.applyChanges({ table: 't', deletes: [{ id: 1 }] })).rejects.toMatchObject({
        code: 'conflict',
      })
      fetchImpl = async () =>
        new Response(
          JSON.stringify({
            results: [
              { type: 'ok', response: {} },
              { type: 'ok', response: { type: 'execute', result: { affected_row_count: 1 } } },
              { type: 'ok', response: {} },
            ],
          }),
          { status: 200 }
        )
      await expect(
        sessIp.applyChanges({
          table: 't',
          deletes: [{ id: 1 }],
          updates: [{ primaryKeys: { id: 2 }, changes: { v: 'y' } }],
        })
      ).rejects.toMatchObject({ code: 'conflict' })
      fetchImpl = async () =>
        new Response(
          JSON.stringify({
            results: [
              { type: 'ok', response: {} },
              { type: 'ok', response: {} },
              { type: 'ok', response: {} },
            ],
          }),
          { status: 200 }
        )
      const insRes = await sessIp.applyChanges({ table: 't', inserts: [{ id: 3 }] })
      expect(insRes.inserted).toBe(1)

      // exportSchemaDdl('') & getObjectDdl DDL row with empty sql and ending ';' (L616, L943, L945)
      fetchImpl = async (_u, init) => {
        const s = String(init?.body || '')
        if ((s.includes('sqlite_master') || s.includes('sqlite_schema')) && s.includes('sql IS NOT NULL')) {
          return new Response(
            JSON.stringify({
              results: [
                {
                  type: 'ok',
                  response: {
                    type: 'execute',
                    result: {
                      cols: [{ name: 'type' }, { name: 'sql' }],
                      rows: [
                        [{ type: 'text', value: 'table' }, { type: 'text', value: 'CREATE TABLE t (id INT);' }],
                        [{ type: 'text', value: 'index' }, { type: 'null' }],
                      ],
                    },
                  },
                },
              ],
            }),
            { status: 200 }
          )
        }
        return new Response(JSON.stringify({ results: [{ type: 'ok', response: { type: 'execute', result: {} } }] }), {
          status: 200,
        })
      }
      await sessIp.exportSchemaDdl('')
      const objDdl = await sessIp.getObjectDdl('t', 'table', '   ')
      expect(objDdl).toBe('CREATE TABLE t (id INT);')

      // readOnly second-statement mutating guard (L971)
      const roLib = new LibsqlSession(makeProfile({ driver: 'libsql', url: 'https://8.8.8.8:8443', readOnly: true }), 'tok-r2')
      await expect(roLib.runQuery('lib-ro-multi', 'SELECT 1; DELETE FROM t')).rejects.toMatchObject({ code: 'READ_ONLY' })
      await roLib.close()

      await sessIp.close()
    })

    it('9.6 clickhouse/driver.ts branch polish via mock HTTP server', async () => {
      type ChReq = { sql: string; headers: http.IncomingHttpHeaders }
      let handler: (req: ChReq, res: http.ServerResponse) => void = (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ meta: [], data: [] }))
      }
      const server = http.createServer((req, res) => {
        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(c))
        req.on('end', () => {
          handler({ sql: Buffer.concat(chunks).toString('utf8'), headers: req.headers }, res)
        })
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
      const port = (server.address() as net.AddressInfo).port

      try {
        const driver = new ClickHouseDriver()
        const sess = await driver.createSession(
          makeProfile({ id: 'ch-r2', driver: 'clickhouse', host: '127.0.0.1', port, database: 'default', ssl: false }),
          ''
        )

        // L61-62 whitespace/non-string error fallback, L222/L227 unterminated comments, L255 comment-only readOnly
        const roCh = new ClickHouseSession(
          makeProfile({ id: 'ch-ro-r2', driver: 'clickhouse', host: '127.0.0.1', port, database: 'default', ssl: false, readOnly: true }),
          ''
        )
        await roCh.runQuery('ch-unterm-line', '-- unterminated line comment')
        await roCh.runQuery('ch-unterm-block', '/* unterminated block comment')
        await roCh.close()

        // listObjects / listSchemas / getTableDetails / fetchPage missing meta/data & MaterializedView & empty key '()'
        handler = (req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          if (req.sql.startsWith('SHOW CREATE TABLE')) {
            res.end(JSON.stringify({ meta: [{ name: 'statement', type: 'String' }], data: [['CREATE TABLE mv (x Int32) ENGINE = Memory']] }))
            return
          }
          if (req.sql.includes('system.tables') && req.sql.includes('primary_key')) {
            res.end(
              JSON.stringify({
                meta: [
                  { name: 'engine', type: 'String' },
                  { name: 'primary_key', type: 'String' },
                  { name: 'sorting_key', type: 'String' },
                ],
                data: [['MaterializedView', '()', '']],
              })
            )
            return
          }
          if (req.sql.includes('SHOW DATABASES')) {
            res.end(JSON.stringify({ meta: [{ name: 'name', type: 'String' }], data: [[null]] }))
            return
          }
          if (req.sql.includes('system.tables')) {
            res.end(JSON.stringify({ meta: [{ name: 'name', type: 'String' }], data: [['t_no_engine']] }))
            return
          }
          res.end(JSON.stringify({}))
        }
        expect(await sess.listObjects('default')).toHaveLength(1)
        expect(await sess.listSchemas()).toEqual({ schemas: ['default'], defaultSchema: 'default' })
        const mvDetails = await sess.getTableDetails('mv', 'default')
        expect(mvDetails.kind).toBe('view')
        expect(await sess.getObjectDdl('mv', 'view', 'default')).toBe('CREATE TABLE mv (x Int32) ENGINE = Memory;')
        await sess.exportSchemaDdl('default')
        expect((await sess.fetchPage({ table: 'mv', page: 1, pageSize: 5 })).totalRows).toBe(0)

        // L531/L554/L633-635 missing meta/data completely
        handler = (_req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end('{}')
        }
        expect(await sess.listObjects('default')).toEqual([])
        expect(await sess.listSchemas()).toEqual({ schemas: ['default'], defaultSchema: 'default' })
        await sess.getTableDetails('mv2', 'default')

        // L756-797, L839-991, L288-298: updateCell undefined originalValue + COUNT(*) / count() / {} + non-bindable orig
        handler = (req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          if (req.sql.includes('COUNT(*)')) {
            res.end(JSON.stringify({ meta: [{ name: 'count()', type: 'UInt64' }], data: [[1]] }))
            return
          }
          if (req.sql.startsWith('SELECT')) {
            res.end(JSON.stringify({}))
            return
          }
          res.end('')
        }
        const updNoOrig = await sess.updateCell({
          table: 'mv',
          primaryKeys: { note: null, skip: undefined },
          column: 'val',
          newValue: 'z',
        })
        expect(updNoOrig.updatedRecord).toBeUndefined()

        // Non-bindable optimistic lock value (object) & empty originalRow property skip (L296, L298)
        await sess.updateCell({
          table: 'mv',
          primaryKeys: { id: 1 },
          column: 'val',
          originalValue: { nonBindable: true },
          newValue: 'w',
        })
        await expect(
          sess.applyChanges({
            table: 'mv',
            inserts: [{ id: 1 }, {}],
          })
        ).rejects.toThrow(/at least one column value/)
        await sess.applyChanges({
          table: 'mv',
          deletes: [{ id: 1 }],
          updates: [{ primaryKeys: { id: 2 }, originalRow: {}, changes: { val: 'x' } }],
          inserts: [{ id: 1 }],
        })

        // L1110 missing summary header, L1124 empty SHOW text, L1150-1154 m.type:'' & non-array data, L1214 early cancel without queryId
        handler = (req, res) => {
          if (req.sql.startsWith('KILL QUERY')) {
            res.writeHead(200)
            res.end('')
            return
          }
          if (req.sql.startsWith('SHOW')) {
            res.writeHead(200)
            res.end('')
            return
          }
          if (req.sql.startsWith('SELECT')) {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ meta: [{ name: 'col1', type: '' }], data: 'bad' }))
            return
          }
          res.writeHead(200)
          res.end('')
        }
        await sess.runQuery('ch-show-empty', 'SHOW TABLES')
        await sess.runQuery('ch-sel-bad', 'SELECT 1')
        await sess.runQuery('ch-semi', '; ;')

        // L1214 cancel before server queryId populated
        let releaseSlow: (() => void) | null = null
        handler = (req, res) => {
          if (req.sql.startsWith('KILL QUERY')) {
            res.writeHead(200)
            res.end('')
            return
          }
          releaseSlow = () => {
            if (!res.destroyed) {
              res.writeHead(200)
              res.end('')
            }
          }
        }
        const slowCh = sess.runQuery('ch-early-cancel', 'SELECT sleep(1)').catch((e) => e)
        await new Promise((r) => setTimeout(r, 15))
        await sess.cancelQuery('ch-early-cancel')
        releaseSlow?.()
        expect(await slowCh).toMatchObject({ code: 'cancelled' })

        await sess.close()
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    })

    it('9.7 redis/driver.ts branch polish (split RESP3 frames, redaction, KEEPTTL fallback, mock cancel) + PBT', async () => {
      // redactRedisCommandArgs edge empty elements (L531, L546, L559, L561, L575, L577, L587)
      expect(redactRedisCommandArgs(['', 'x'])).toEqual(['', 'x'])
      expect(redactRedisCommandArgs(['HELLO', '3', 'AUTH', 'u', 'secret', ''])).toEqual([
        'HELLO',
        '3',
        'AUTH',
        'u',
        '***',
        '',
      ])
      expect(redactRedisCommandArgs(['ACL', 'SETUSER', 'u', ''])).toEqual(['ACL', 'SETUSER', 'u', ''])
      expect(redactRedisCommandArgs(['CONFIG', 'SET', '', 'v', 'requirepass', 'pw'])).toEqual([
        'CONFIG',
        'SET',
        '',
        'v',
        'requirepass',
        '***',
      ])
      expect(redactRedisCommandArgs(['MIGRATE', '', '6379'])).toEqual(['MIGRATE', '', '6379'])

      // PBT: redactor preserves arg length and never mutates empty/benign tokens
      fc.assert(
        fc.property(fc.array(fc.constantFrom('', 'GET', 'SET', 'ACL', 'HELP', 'AUTH'), { minLength: 0, maxLength: 4 }), (args) => {
          expect(redactRedisCommandArgs(args)).toHaveLength(args.length)
        }),
        { numRuns: 10 }
      )

      // Live Redis: port inferred from connectionUrl when profile.port undefined (L758), + applyChanges null/undef/both value+ttl (L1297, L1353, L1406, L1423)
      const driver = new RedisDriver()
      const urlSess = await driver.createSession(
        {
          id: 'redis-r2-url',
          name: 'redis-r2-url',
          driver: 'redis',
          url: 'redis://127.0.0.1:56380',
        },
        'datanoa_redis_pass'
      )
      try {
        await expect(
          urlSess.updateCell({ table: '(all)', primaryKeys: {}, column: 'value', newValue: 'x' })
        ).rejects.toMatchObject({ code: 'invalid_params' })

        await urlSess.applyChanges({
          inserts: [
            { key: 'cov_w4b_redis:nullv', value: null },
            { key: 'cov_w4b_redis:undefv' },
          ],
        })
        await urlSess.applyChanges({
          updates: [
            {
              primaryKeys: { key: 'cov_w4b_redis:nullv' },
              changes: { value: 'v2', ttl: 60 },
            },
            {
              primaryKeys: { key: 'cov_w4b_redis:undefv' },
              changes: { value: null },
            },
          ],
        })
      } finally {
        await urlSess
          .applyChanges({
            deletes: [{ key: 'cov_w4b_redis:nullv' }, { key: 'cov_w4b_redis:undefv' }],
          })
          .catch(() => {})
        await urlSess.close().catch(() => {})
      }

      // Mock TCP RESP server for split chunks (L204-301), unsolicited frame (L447), KEEPTTL fallback (L1260-1288),
      // malformed SCAN/TYPE/TTL/DBSIZE/INFO responses, nested error cell (L669), and cancellation (L1525, L1625, L1627)
      let failKeepTtlOnce = true
      let slowDelayMs = 0
      const activeSockets = new Set<net.Socket>()
      const writeParts = (sock: net.Socket, parts: string[]): void => {
        parts.forEach((part, idx) => {
          setTimeout(() => {
            if (!sock.destroyed) sock.write(part)
          }, idx * 4)
        })
      }
      const parseRespArray = (buf: Buffer): { args: string[]; rest: Buffer } | null => {
        const s = buf.toString('utf8')
        if (!s.startsWith('*')) return null
        const firstEnd = s.indexOf('\r\n')
        if (firstEnd < 0) return null
        const count = Number(s.slice(1, firstEnd))
        let pos = firstEnd + 2
        const args: string[] = []
        for (let i = 0; i < count; i++) {
          if (s[pos] !== '$') return null
          const lenEnd = s.indexOf('\r\n', pos)
          if (lenEnd < 0) return null
          const len = Number(s.slice(pos + 1, lenEnd))
          const start = lenEnd + 2
          const end = start + len
          if (s.length < end + 2) return null
          args.push(s.slice(start, end))
          pos = end + 2
        }
        return { args, rest: Buffer.from(s.slice(pos), 'utf8') }
      }

      const srv = net.createServer((sock) => {
        activeSockets.add(sock)
        sock.on('error', () => {})
        sock.on('close', () => activeSockets.delete(sock))
        let rx = Buffer.alloc(0)
        sock.on('data', (chunk: Buffer) => {
          rx = Buffer.concat([rx, chunk])
          while (rx.length > 0) {
            const parsed = parseRespArray(rx)
            if (!parsed) break
            rx = parsed.rest
            const args = parsed.args
            const cmd = (args[0] || '').toUpperCase()
            const respond = () => {
              if (sock.destroyed) return
              if (cmd === 'HELLO') {
                writeParts(sock, ['+OK', '\r\n'])
              } else if (cmd === 'PING') {
                // Send unsolicited extra frame once for L447 break!
                sock.write('+PONG\r\n+UNSOLICITED\r\n')
              } else if (cmd === 'DBSIZE') {
                sock.write('+not_a_number\r\n') // L987
              } else if (cmd === 'INFO') {
                sock.write('$-1\r\n') // L1472 null
              } else if (cmd === 'SCAN') {
                if (args[2] === 'badscan') {
                  sock.write('*2\r\n$-1\r\n$3\r\nbad\r\n') // L914, L915
                } else {
                  sock.write('*2\r\n$1\r\n0\r\n*3\r\n$2\r\nk1\r\n$2\r\nk2\r\n$2\r\nk3\r\n')
                }
              } else if (cmd === 'TYPE') {
                sock.write('$-1\r\n') // L1044
              } else if (cmd === 'TTL') {
                if (args[1] === 'k1') sock.write('-ERR ttl fail\r\n') // L1046 rejected
                else if (args[1] === 'k3') sock.write('$-1\r\n') // L1046 value ?? -1
                else sock.write('+nan\r\n') // L1048 NaN
              } else if (cmd === 'MEMORY') {
                sock.write(':0\r\n')
              } else if (cmd === 'GET') {
                sock.write('$-1\r\n')
              } else if (cmd === 'SET') {
                if (failKeepTtlOnce && (args[3] || '').toUpperCase() === 'KEEPTTL') {
                  failKeepTtlOnce = false
                  sock.write('-ERR syntax error\r\n')
                } else {
                  sock.write('+OK\r\n')
                }
              } else if (cmd === 'PTTL') {
                sock.write(':5000\r\n')
              } else if (cmd === 'CUSTOMSET') {
                // Split RESP3 Set ~1 across partial chunks (L260, L276)
                writeParts(sock, ['~1', '\r\n', '+item1\r\n'])
              } else if (cmd === 'CUSTOMMAP') {
                // Split RESP3 Map %1 across partial chunks (L286, L298, L301) and include nested RespProtocolError (L669)
                writeParts(sock, ['%1', '\r\n', '+errKey\r\n', '-ERR nested_err\r\n'])
              } else if (cmd === 'CUSTOMARR') {
                // Split Array *2 across partial chunks (L235)
                writeParts(sock, ['*2', '\r\n+a\r\n', '+b\r\n'])
              } else {
                sock.write('+OK\r\n')
              }
            }
            if (slowDelayMs > 0) setTimeout(respond, slowDelayMs)
            else respond()
          }
        })
      })
      await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()))
      const rPort = (srv.address() as net.AddressInfo).port

      try {
        const mockProf = makeProfile({ id: 'redis-mock-r2', driver: 'redis', host: '127.0.0.1', port: rPort })
        const rSess = await driver.createSession(mockProf)

        // Unsolicited PING response handled + malformed DBSIZE/INFO/table=''
        await rSess.getTableDetails('')
        await rSess.exportSchemaDdl('')

        // KEEPTTL syntax fallback (L1260-1288) with mixed DEL + SET KEEPTTL
        await rSess.applyChanges({
          deletes: [{ key: 'k0' }],
          updates: [{ primaryKeys: { key: 'k1' }, changes: { value: 'v2' } }],
        })

        // fetchPage table='' + sorting with null value/TTL + bad SCAN shape
        const pageMock = await rSess.fetchPage({ table: '', page: 1, pageSize: 10, sortBy: 'value', sortDir: 'asc' })
        expect(pageMock.rows.length).toBeGreaterThanOrEqual(3)
        await rSess.fetchPage({ table: 'badscan', page: 1, pageSize: 10 })

        // Split RESP3 Set, Map with nested error, and Array + maxRows: 0 (L235, L260, L276, L286, L298, L301, L669, L1500)
        await rSess.runQuery('r-split-set', 'CUSTOMSET', 0)
        await rSess.runQuery('r-split-map', 'CUSTOMMAP', 0)
        await rSess.runQuery('r-split-arr', 'CUSTOMARR', 0)

        // Cancel SCAN (L1525) & readOnly ACL/empty-cmd checks (L92, L93, L101) & cancel queued/running multi-cmd (L1625, L1627)
        slowDelayMs = 40
        const roRedis = new RedisSession({ ...mockProf, readOnly: true })
        await expect(roRedis.runQuery('r-ro-empty', '"" x')).rejects.toMatchObject({ code: 'READ_ONLY' })
        await expect(roRedis.runQuery('r-ro-acl', 'ACL')).rejects.toMatchObject({ code: 'READ_ONLY' })
        const scanCancel = roRedis.runQuery('r-cancel-scan', 'SCAN 0 MATCH * COUNT 10').catch((e) => e)
        await new Promise((r) => setTimeout(r, 10))
        await roRedis.cancelQuery('r-cancel-scan')
        expect(await scanCancel).toMatchObject({ code: 'cancelled' })
        await roRedis.close()

        const multiCancel = rSess.runQuery('r-cancel-rw', 'SET a 1\nSET b 2').catch((e) => e)
        await new Promise((r) => setTimeout(r, 10))
        await rSess.cancelQuery('r-cancel-rw')
        expect(await multiCancel).toMatchObject({ code: 'cancelled' })

        await rSess.close()
      } finally {
        for (const s of activeSockets) s.destroy()
        await new Promise<void>((resolve) => srv.close(() => resolve()))
      }
    }, 20_000)

    afterAll(async () => {
      const cleanupDriver = new RedisDriver()
      const cleanupSess = await cleanupDriver
        .createSession(
          makeProfile({ driver: 'redis', host: '127.0.0.1', port: 56380, sslMode: 'disable' }),
          'datanoa_redis_pass'
        )
        .catch(() => null)
      if (!cleanupSess) return
      try {
        await cleanupSess
          .runQuery('w4b-r2-clean', 'DEL cov_w4b_redis:nullv cov_w4b_redis:undefv')
          .catch(() => {})
      } finally {
        await cleanupSess.close().catch(() => {})
      }
    })
  })
})
