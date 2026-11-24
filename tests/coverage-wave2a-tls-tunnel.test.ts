import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import * as fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ConnectionProfile } from '../src/drivers/common/driver'
import {
  allocateEphemeralPort,
  buildSshSpawnArgs,
  buildTlsConnectionOptions,
  openSshTunnel,
  resolveEffectiveTlsOptions,
  validateSshTunnelConfig,
} from '../src/drivers/common/tls-and-tunnel'
import { PostgresDriver } from '../src/drivers/postgres/driver'

const tmpRoot = path.join(os.tmpdir(), 'ai-work', 'datanoa', 'coverage-100-full', 'tmp-tls-ssh')
const tmpTlsDir = path.join(tmpRoot, 'pem')
const tmpSshDir = path.join(tmpRoot, 'scripts')

function baseProfile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id: 'tls-ssh-prof',
    name: 'tls-ssh-prof',
    driver: 'postgres',
    host: '127.0.0.1',
    port: 55433,
    ...overrides,
  }
}

describe('Wave 2A-2a: TLS & Live OpenSSH Tunnel (src/drivers/common/tls-and-tunnel.ts)', () => {
  let caPath = ''
  let certPath = ''
  let keyPath = ''
  let forwarderScript = ''
  let exitErrScript = ''
  let hangScript = ''
  let askpassKeyScript = ''

  beforeAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
    fs.mkdirSync(tmpTlsDir, { recursive: true })
    fs.mkdirSync(tmpSshDir, { recursive: true })

    caPath = path.join(tmpTlsDir, 'ca.pem')
    certPath = path.join(tmpTlsDir, 'client-cert.pem')
    keyPath = path.join(tmpTlsDir, 'client-key.pem')
    fs.writeFileSync(caPath, '-----BEGIN CERTIFICATE-----\nFAKECA\n-----END CERTIFICATE-----\n', 'utf8')
    fs.writeFileSync(certPath, '-----BEGIN CERTIFICATE-----\nFAKECERT\n-----END CERTIFICATE-----\n', 'utf8')
    fs.writeFileSync(keyPath, '-----BEGIN PRIVATE KEY-----\nFAKEKEY\n-----END PRIVATE KEY-----\n', 'utf8')

    // Forwarder `.mjs` script: parses `-L 127.0.0.1:<local>:<targetHost>:<targetPort>`, exercises SSH_ASKPASS helper,
    // and relays live TCP sockets to targetHost:targetPort until SIGTERM.
    forwarderScript = path.join(tmpSshDir, 'ssh-forwarder.mjs')
    fs.writeFileSync(
      forwarderScript,
      `
import * as net from 'node:net';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const lIdx = args.indexOf('-L');
const spec = lIdx >= 0 ? args[lIdx + 1] : '';
const parts = spec.split(':');
const localPort = Number(parts[1]);
const targetPort = Number(parts[parts.length - 1]);
const targetHost = parts.slice(2, parts.length - 1).join(':').replace(/^\\[|\\]$/g, '');

function invokeAskpass(prompt) {
  const askpass = process.env.SSH_ASKPASS;
  if (!askpass) return Promise.resolve({ code: 0, out: '' });
  return new Promise((resolve) => {
    const child = process.platform === 'win32'
      ? spawn('cmd.exe', ['/c', askpass, prompt], { windowsHide: true })
      : spawn(askpass, [prompt], { windowsHide: true });
    let out = '';
    child.stdout?.on('data', (c) => { out += String(c); });
    child.on('exit', (code) => resolve({ code, out }));
    child.on('error', () => resolve({ code: 1, out: '' }));
  });
}

(async () => {
  if (process.env.SSH_ASKPASS) {
    const mode = process.env.DATANOA_SSH_AUTH_MODE;
    const validPrompt = mode === 'passphrase' ? 'Enter passphrase for key:' : "datanoa@127.0.0.1's password:";
    const okRes = await invokeAskpass(validPrompt);
    if (okRes.code !== 0 || okRes.out !== process.env.DATANOA_SSH_SECRET) {
      process.stderr.write('askpass mismatch mode=' + mode + ' code=' + okRes.code + '\\n');
      process.exit(2);
    }
    const rejectHostKey = await invokeAskpass('Are you sure you want to continue connecting (yes/no)?');
    if (rejectHostKey.code === 0) process.exit(3);
    const rejectOtp = await invokeAskpass('Verification code:');
    if (rejectOtp.code === 0) process.exit(4);
  }

  const sockets = new Set();
  const srv = net.createServer((client) => {
    sockets.add(client);
    const upstream = net.connect({ host: targetHost, port: targetPort });
    sockets.add(upstream);
    client.pipe(upstream);
    upstream.pipe(client);
    const cleanup = () => {
      sockets.delete(client);
      sockets.delete(upstream);
      client.destroy();
      upstream.destroy();
    };
    client.on('error', cleanup);
    upstream.on('error', cleanup);
    client.on('close', cleanup);
    upstream.on('close', cleanup);
  });
  srv.listen(localPort, '127.0.0.1');
  process.on('SIGTERM', () => {
    for (const s of sockets) s.destroy();
    srv.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 200).unref();
  });
})();
      `,
      'utf8'
    )

    exitErrScript = path.join(tmpSshDir, 'ssh-exit-err.mjs')
    fs.writeFileSync(
      exitErrScript,
      `
process.stderr.write('Permission denied for secret_ssh_token_12345 on bastion\\n');
process.exit(255);
      `,
      'utf8'
    )

    hangScript = path.join(tmpSshDir, 'ssh-hang.mjs')
    fs.writeFileSync(
      hangScript,
      `
// Never opens listening port; waits until terminated
setInterval(() => {}, 1000);
      `,
      'utf8'
    )

    askpassKeyScript = path.join(tmpSshDir, 'ssh-key-askpass.mjs')
    fs.writeFileSync(
      askpassKeyScript,
      `
process.stderr.write('bad passphrase_secret_abc on key\\n');
process.exit(1);
      `,
      'utf8'
    )
  })

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('resolves effective TLS options across disabled/default/custom PEMs, SNI IPv4/IPv6 rules, and modes', async () => {
    expect(await resolveEffectiveTlsOptions(baseProfile({ sslMode: 'disable' }))).toBe(false)
    expect(await buildTlsConnectionOptions(baseProfile())).toBeUndefined()
    expect(
      await resolveEffectiveTlsOptions(
        baseProfile({ ssl: false, sslRejectUnauthorized: true, sslMode: 'auto' })
      )
    ).toBeUndefined()

    const reqOpts = await resolveEffectiveTlsOptions(
      baseProfile({
        sslCaPath: `  ${caPath}  `,
        sslCertPath: certPath,
        sslKeyPath: keyPath,
        sslMode: 'require',
      }),
      { sslKeyPassphrase: 'my-key-passphrase' },
      'db.internal.example'
    )
    expect(reqOpts && typeof reqOpts === 'object').toBe(true)
    if (reqOpts && typeof reqOpts === 'object') {
      expect(reqOpts.ca).toContain('FAKECA')
      expect(reqOpts.cert).toContain('FAKECERT')
      expect(reqOpts.key).toContain('FAKEKEY')
      expect(reqOpts.passphrase).toBe('my-key-passphrase')
      expect(reqOpts.servername).toBe('db.internal.example')
      expect(reqOpts.rejectUnauthorized).toBe(false)
    }

    const verifyCa = await resolveEffectiveTlsOptions(
      baseProfile({ sslMode: 'verify-ca' }),
      undefined,
      '10.0.0.5'
    )
    if (verifyCa && typeof verifyCa === 'object') {
      expect(verifyCa.servername).toBeUndefined()
      expect(verifyCa.checkServerIdentity?.('10.0.0.5', {} as never)).toBeUndefined()
    }

    const verifyFullIpv6 = await resolveEffectiveTlsOptions(
      baseProfile({ sslMode: 'verify-full' }),
      undefined,
      '[::1]'
    )
    if (verifyFullIpv6 && typeof verifyFullIpv6 === 'object') {
      expect(verifyFullIpv6.servername).toBeUndefined()
      expect(verifyFullIpv6.rejectUnauthorized).toBe(true)
      expect(verifyFullIpv6.checkServerIdentity?.('127.0.0.1', {} as never)).toBeInstanceOf(Error)
    }

    const defaultAutoVerify = await resolveEffectiveTlsOptions(
      baseProfile({ sslRejectUnauthorized: true }),
      undefined,
      'db.example.com'
    )
    if (defaultAutoVerify && typeof defaultAutoVerify === 'object') {
      expect(defaultAutoVerify.rejectUnauthorized).toBe(true)
      expect(defaultAutoVerify.checkServerIdentity?.('db.example.com', {} as never)).toBeInstanceOf(Error)
    }

    const missingPem = path.join(tmpTlsDir, 'missing-ca.pem')
    await expect(
      resolveEffectiveTlsOptions(
        baseProfile({ sslCaPath: missingPem }),
        { sslKeyPassphrase: 'secret-never-shown' }
      )
    ).rejects.toThrow(/Cannot read SSL CA certificate/)
  })

  it('validates SSH tunnel configs & spawn args via fast-check PBT and rejects injection payloads', () => {
    const safeTokenArb = fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9._]{0,14}$/)
    fc.assert(
      fc.property(
        safeTokenArb,
        safeTokenArb,
        fc.integer({ min: 1, max: 65535 }),
        fc.integer({ min: 1, max: 65535 }),
        fc.integer({ min: 1024, max: 65535 }),
        (sshHost, sshUser, sshPort, targetPort, localPort) => {
          const prof = baseProfile({ sshHost, sshUser, sshPort, sshAuthMethod: 'agent' })
          const cfg = validateSshTunnelConfig(prof, 'db.internal', targetPort)
          expect(cfg.sshHost).toBe(sshHost)
          expect(cfg.sshPort).toBe(sshPort)
          const argv = buildSshSpawnArgs(prof, localPort, '::1', targetPort, { useAskpass: false })
          expect(argv).toContain(`127.0.0.1:${localPort}:[::1]:${targetPort}`)
          expect(argv).toContain('BatchMode=yes')
          expect(argv[argv.length - 1]).toBe(`${sshUser}@${sshHost}`)
          expect(argv[argv.length - 2]).toBe('--')
        }
      )
    )

    // Bracketed IPv6 host & target host + key auth path with spaces
    const keyProf = baseProfile({
      sshHost: '[::1]',
      sshUser: 'ops_user',
      sshAuthMethod: 'key',
      sshPrivateKeyPath: 'C:\\Users\\My Name\\.ssh\\id_ed25519',
    })
    const keyArgs = buildSshSpawnArgs(keyProf, 15432, '[::1]', 5432, { useAskpass: true })
    expect(keyArgs).toContain('IdentitiesOnly=yes')
    expect(keyArgs).toContain('PreferredAuthentications=publickey')
    expect(keyArgs).toContain('C:\\Users\\My Name\\.ssh\\id_ed25519')

    const pwdArgs = buildSshSpawnArgs(
      baseProfile({ sshHost: 'bastion.local', sshUser: 'u', sshAuthMethod: 'password' }),
      15433,
      '127.0.0.1',
      5432,
      { useAskpass: true }
    )
    expect(pwdArgs).toContain('PreferredAuthentications=password')

    // Default ssh port fallback when omitted
    expect(validateSshTunnelConfig(baseProfile({ sshHost: 'b', sshUser: 'u' }), 'db', 5432).sshPort).toBe(22)

    // Security injection & malformed boundary assertions
    expect(() => validateSshTunnelConfig(baseProfile({ sshHost: '', sshUser: 'u' }), 'db', 5432)).toThrow()
    expect(() => validateSshTunnelConfig(baseProfile({ sshHost: 123 as never, sshUser: 'u' }), 'db', 5432)).toThrow()
    expect(() => validateSshTunnelConfig(baseProfile({ sshHost: '-oProxyCommand=id', sshUser: 'u' }), 'db', 5432)).toThrow(/option injection/)
    expect(() => validateSshTunnelConfig(baseProfile({ sshHost: 'bad host', sshUser: 'u' }), 'db', 5432)).toThrow(/whitespace/)
    expect(() => validateSshTunnelConfig(baseProfile({ sshHost: 'evil@host', sshUser: 'u' }), 'db', 5432)).toThrow(/"@"/)
    expect(() => validateSshTunnelConfig(baseProfile({ sshHost: '[not-ipv6]', sshUser: 'u' }), 'db', 5432)).toThrow(/IPv6/)
    expect(() => validateSshTunnelConfig(baseProfile({ sshHost: 'host:22', sshUser: 'u' }), 'db', 5432)).toThrow(/valid IPv6/)
    expect(() => validateSshTunnelConfig(baseProfile({ sshHost: 'h', sshUser: 'u' }), '[bad-target]', 5432)).toThrow(/IPv6/)
    expect(() => validateSshTunnelConfig(baseProfile({ sshHost: 'h', sshUser: 'u' }), 'db:5432', 5432)).toThrow(/valid IPv6/)
    expect(() => validateSshTunnelConfig(baseProfile({ sshHost: 'h', sshUser: 'u', sshPort: 70000 }), 'db', 5432)).toThrow(/between 1 and 65535/)
    expect(() => validateSshTunnelConfig(baseProfile({ sshHost: 'h', sshUser: 'u' }), 'db', 0)).toThrow(/between 1 and 65535/)
    expect(() =>
      validateSshTunnelConfig(baseProfile({ sshHost: 'h', sshUser: 'u', sshAuthMethod: 'key', sshPrivateKeyPath: '-oBad' }), 'db', 5432)
    ).toThrow(/option injection/)
    expect(() =>
      validateSshTunnelConfig(baseProfile({ sshHost: 'h', sshUser: 'u', sshAuthMethod: 'key', sshPrivateKeyPath: 'bad\npath' }), 'db', 5432)
    ).toThrow(/control characters/)
    expect(() =>
      validateSshTunnelConfig(baseProfile({ sshHost: 'h', sshUser: 'u', sshAuthMethod: 'key', sshPrivateKeyPath: '' }), 'db', 5432)
    ).toThrow(/required/)
    expect(() =>
      validateSshTunnelConfig(baseProfile({ sshHost: 'h', sshUser: 'u', sshAuthMethod: 'key' }), 'db', 5432)
    ).toThrow(/required/)
  })

  it('allocates ephemeral ports, executes real openSshTunnel + askpass forwarding to live Postgres, and exercises live ssh.exe + error paths', async () => {
    const ephPort = await allocateEphemeralPort()
    expect(Number.isInteger(ephPort) && ephPort > 0 && ephPort <= 65535).toBe(true)

    // Missing SSH password when method='password'
    await expect(
      openSshTunnel(
        baseProfile({ sshHost: '127.0.0.1', sshUser: 'datanoa', sshAuthMethod: 'password' }),
        '127.0.0.1',
        55433
      )
    ).rejects.toThrow(/SSH password is required/)

    // 1) Live tunnel with Node `.mjs` forwarder + SSH_ASKPASS password mode -> real PostgreSQL connection through tunnel
    const tunnelPwd = await openSshTunnel(
      baseProfile({
        sshHost: '127.0.0.1',
        sshPort: 52222,
        sshUser: 'datanoa',
        sshAuthMethod: 'password',
      }),
      '127.0.0.1',
      55433,
      {
        sshBinary: forwarderScript,
        secrets: { sshPassword: 'tunnel_pwd_secret' },
        timeoutMs: 8000,
      }
    )
    expect(tunnelPwd.isAlive()).toBe(true)
    try {
      const pgDriver = new PostgresDriver()
      const res = await pgDriver.testConnection(
        {
          id: 'pg-via-tunnel',
          name: 'pg-via-tunnel',
          driver: 'postgres',
          host: tunnelPwd.localHost,
          port: tunnelPwd.localPort,
          database: 'datanoa_test',
          user: 'datanoa',
          sslMode: 'disable',
        },
        'datanoa_pass'
      )
      expect(res).toEqual({ ok: true, message: 'PostgreSQL connection valid' })
    } finally {
      await Promise.all([tunnelPwd.close(), tunnelPwd.close()])
    }
    expect(tunnelPwd.isAlive()).toBe(false)

    // 2) Live tunnel with key passphrase + SSH_ASKPASS passphrase mode
    const dummyKey = path.join(tmpTlsDir, 'dummy_id_ed25519')
    fs.writeFileSync(dummyKey, 'DUMMY_KEY', 'utf8')
    const tunnelKey = await openSshTunnel(
      baseProfile({
        sshHost: '127.0.0.1',
        sshUser: 'datanoa',
        sshAuthMethod: 'key',
        sshPrivateKeyPath: dummyKey,
      }),
      '127.0.0.1',
      55433,
      {
        sshBinary: forwarderScript,
        secrets: { sshPassphrase: 'key_passphrase_secret' },
        timeoutMs: 8000,
      }
    )
    expect(tunnelKey.isAlive()).toBe(true)
    await tunnelKey.close()
    expect(tunnelKey.isAlive()).toBe(false)

    // 3) Real OS `ssh` against live `datanoa-cov-ssh` (127.0.0.1:52222) — verifies real ssh spawn + StrictHostKeyChecking=yes failure + secret redaction
    let realSshErr = ''
    try {
      await openSshTunnel(
        baseProfile({
          sshHost: '127.0.0.1',
          sshPort: 52222,
          sshUser: 'datanoa',
          sshAuthMethod: 'password',
        }),
        '127.0.0.1',
        55433,
        {
          secrets: { sshPassword: 'datanoa_ssh_pass' },
          timeoutMs: 5000,
        }
      )
    } catch (err: unknown) {
      realSshErr = err instanceof Error ? err.message : String(err)
    }
    expect(realSshErr).toContain('Verify the SSH password')
    expect(realSshErr).not.toContain('datanoa_ssh_pass')

    // 4) Early exit error + secret redaction in stderr (password & key hints)
    await expect(
      openSshTunnel(
        baseProfile({ sshHost: '127.0.0.1', sshUser: 'datanoa', sshAuthMethod: 'password' }),
        '127.0.0.1',
        55433,
        { sshBinary: exitErrScript, secrets: { sshPassword: 'secret_ssh_token_12345' }, timeoutMs: 2000 }
      )
    ).rejects.toThrow(/\[REDACTED\][\s\S]*Verify the SSH password/)

    await expect(
      openSshTunnel(
        baseProfile({
          sshHost: '127.0.0.1',
          sshUser: 'datanoa',
          sshAuthMethod: 'key',
          sshPrivateKeyPath: dummyKey,
        }),
        '127.0.0.1',
        55433,
        { sshBinary: askpassKeyScript, secrets: { sshPassphrase: 'passphrase_secret_abc' }, timeoutMs: 2000 }
      )
    ).rejects.toThrow(/Verify the private key path/)

    // 5) Timeout when ssh process hangs without binding forwarding port
    await expect(
      openSshTunnel(
        baseProfile({ sshHost: '127.0.0.1', sshUser: 'datanoa', sshAuthMethod: 'agent' }),
        '127.0.0.1',
        55433,
        { sshBinary: hangScript, timeoutMs: 220 }
      )
    ).rejects.toThrow(/did not open local forwarding port/)

    // 6) Spawn ENOENT error handling when ssh binary does not exist
    await expect(
      openSshTunnel(
        baseProfile({ sshHost: '127.0.0.1', sshUser: 'datanoa', sshAuthMethod: 'agent' }),
        '127.0.0.1',
        55433,
        { sshBinary: 'datanoa-nonexistent-ssh-binary-xyz', timeoutMs: 1500 }
      )
    ).rejects.toThrow(/failed to start/)
  }, 15000)
})
