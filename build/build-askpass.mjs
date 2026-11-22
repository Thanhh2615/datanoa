/**
 * build/build-askpass.mjs
 * Compiles build/ssh-askpass/askpass.cs into a minimal AnyCPU Windows PE (.NET Framework 4.x)
 * and writes its base64 payload + SHA-256 digest to src/drivers/common/ssh-askpass-win-bin.ts.
 * No compiler is required on customer machines; pass --check to verify integrity without recompiling.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const root = path.resolve(__dirname, '..')
const csPath = path.join(root, 'build', 'ssh-askpass', 'askpass.cs')
const outTsPath = path.join(root, 'src', 'drivers', 'common', 'ssh-askpass-win-bin.ts')

if (process.argv.includes('--check')) {
  const src = fs.readFileSync(outTsPath, 'utf8')
  const shaMatch = /WIN_ASKPASS_EXE_SHA256\s*=\s*'([a-f0-9]{64})'/.exec(src)
  const b64Match = /WIN_ASKPASS_EXE_BASE64\s*=\s*\n?\s*'([A-Za-z0-9+/=]+)'/.exec(src)
  if (!shaMatch || !b64Match) {
    console.error('[build-askpass] FAIL: missing embedded payload or digest')
    process.exit(1)
  }
  const bytes = Buffer.from(b64Match[1], 'base64')
  const actualSha = createHash('sha256').update(bytes).digest('hex')
  if (bytes.length < 1024 || bytes[0] !== 0x4d || bytes[1] !== 0x5a || actualSha !== shaMatch[1]) {
    console.error('[build-askpass] FAIL: payload integrity mismatch')
    process.exit(1)
  }
  console.log(`[build-askpass] OK: ${bytes.length} bytes, sha256=${actualSha}`)
  process.exit(0)
}

const cscPath = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe'
if (!fs.existsSync(cscPath)) {
  console.error(`[build-askpass] Compiler not found at ${cscPath}`)
  process.exit(1)
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'datanoa-askpass-build-'))
try {
  const exePath = path.join(tmpDir, 'askpass.exe')
  execFileSync(
    cscPath,
    ['/nologo', '/target:exe', '/platform:anycpu', '/optimize+', '/debug-', `/out:${exePath}`, csPath],
    { stdio: 'inherit' }
  )
  const bytes = fs.readFileSync(exePath)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const b64 = bytes.toString('base64')
  const ts = [
    '// Auto-generated from build/ssh-askpass/askpass.cs via build/build-askpass.mjs.',
    '// Direct Windows PE helper for OpenSSH SSH_ASKPASS (zero cmd.exe / PowerShell shell parsing).',
    `export const WIN_ASKPASS_EXE_SHA256 = '${sha256}'`,
    `export const WIN_ASKPASS_EXE_BASE64 = '${b64}'`,
    '',
  ].join('\n')
  fs.writeFileSync(outTsPath, ts, 'utf8')
  console.log(`[build-askpass] Built ${bytes.length} bytes (sha256=${sha256}) -> ${path.relative(root, outTsPath)}`)
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true })
}
