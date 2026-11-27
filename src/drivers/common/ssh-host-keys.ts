// OpenSSH known_hosts verification (all 4 files, global @revoked precedence, wildcards, ! negation, |1| HMAC-SHA1)
// and serialized atomic updates preserving comments, CRLF, markers, and unrelated multi-host entries byte-for-byte.

import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export const MAX_KNOWN_HOSTS_BYTES = 4 * 1024 * 1024

export type KnownHostsCheckResult = 'matched' | 'mismatch' | 'revoked' | 'unknown'

export interface KnownHostsFileSource {
  path: string
  content: Buffer | string
}

export interface KnownHostsTextSource {
  path: string
  text: Buffer | string
}

export interface KnownHostsDetailedResult {
  result: KnownHostsCheckResult
  knownHostsPath?: string
  line?: number
  existingKeyType?: string
  existingFingerprintSha256?: string
}

export interface SerializedQueue {
  run<T>(fn: () => Promise<T>): Promise<T>
  waitIdle(): Promise<void>
}

/**
 * Creates a FIFO async serialization queue (used to serialize atomic known_hosts writes).
 */
export function createSerializedQueue(): SerializedQueue {
  let chain: Promise<void> = Promise.resolve()
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      const task = chain.then(fn)
      chain = task.then(
        () => undefined,
        () => undefined
      )
      return task
    },
    waitIdle(): Promise<void> {
      return chain
    },
  }
}

const knownHostsWriteQueue = createSerializedQueue()

/**
 * Returns all 4 standard OpenSSH known_hosts file paths (user + system).
 */
export function getDefaultKnownHostsPaths(homeDir = os.homedir()): string[] {
  const sysDir =
    process.platform === 'win32'
      ? path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'ssh')
      : '/etc/ssh'
  return [
    path.join(homeDir, '.ssh', 'known_hosts'),
    path.join(homeDir, '.ssh', 'known_hosts2'),
    path.join(sysDir, 'ssh_known_hosts'),
    path.join(sysDir, 'ssh_known_hosts2'),
  ]
}

export function getPrimaryKnownHostsPath(homeDir = os.homedir()): string {
  return path.join(homeDir, '.ssh', 'known_hosts')
}

export function isSystemKnownHostsPath(filePath: string): boolean {
  const trimmed = filePath.trim()
  if (!trimmed) return false
  const posixNorm = path.posix.normalize(trimmed.replace(/\\/g, '/')).toLowerCase()
  if (
    posixNorm === '/etc/ssh/ssh_known_hosts' ||
    posixNorm === '/etc/ssh/ssh_known_hosts2' ||
    path.posix.dirname(posixNorm) === '/etc/ssh'
  ) {
    return true
  }
  const winSysDir = path.win32
    .normalize(path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'ssh'))
    .toLowerCase()
  const winNorm = path.win32.normalize(trimmed).toLowerCase()
  if (
    winNorm === path.win32.join(winSysDir, 'ssh_known_hosts') ||
    winNorm === path.win32.join(winSysDir, 'ssh_known_hosts2') ||
    path.win32.dirname(winNorm) === winSysDir
  ) {
    return true
  }
  const norm = (p: string) =>
    process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.posix.normalize(p)
  const resolved = norm(trimmed)
  const parent = process.platform === 'win32' ? path.dirname(resolved) : path.posix.dirname(resolved)
  return parent === norm('/etc/ssh') || parent === norm(winSysDir)
}

/**
 * Computes OpenSSH-style `SHA256:<base64-no-pad>` host key fingerprint from raw wire-format key blob.
 */
export function computeSshHostKeyFingerprintSha256(keyBlob: Buffer): string {
  const digest = crypto.createHash('sha256').update(keyBlob).digest('base64').replace(/=+$/, '')
  return `SHA256:${digest}`
}

/**
 * Extracts the SSH public key algorithm name from an OpenSSH wire-format host key blob.
 */
export function extractSshKeyTypeFromBlob(keyBlob: Buffer): string {
  if (keyBlob.length < 4) return 'unknown'
  const len = keyBlob.readUInt32BE(0)
  if (len <= 0 || len > 128 || 4 + len > keyBlob.length) return 'unknown'
  const rawType = keyBlob.subarray(4, 4 + len).toString('ascii')
  return /^[A-Za-z0-9@._-]+$/.test(rawType) ? rawType : 'unknown'
}

/**
 * Non-backtracking linear wildcard matcher supporting `*` (0+ chars) and `?` (1 char).
 */
function matchWildcardCaseInsensitive(pattern: string, text: string): boolean {
  const p = pattern.toLowerCase()
  const t = text.toLowerCase()
  let pi = 0
  let ti = 0
  let starPi = -1
  let starTi = 0

  while (ti < t.length) {
    if (pi < p.length && (p[pi] === '?' || p[pi] === t[ti])) {
      pi += 1
      ti += 1
    } else if (pi < p.length && p[pi] === '*') {
      starPi = pi
      starTi = ti
      pi += 1
    } else if (starPi !== -1) {
      pi = starPi + 1
      starTi += 1
      ti = starTi
    } else {
      return false
    }
  }

  while (pi < p.length && p[pi] === '*') {
    pi += 1
  }
  return pi === p.length
}

function normalizeHostForKnownHosts(host: string): string {
  const trimmed = host.trim().toLowerCase()
  return trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed
}

function buildKnownHostsCandidates(host: string, port: number): string[] {
  const normalized = normalizeHostForKnownHosts(host)
  return port === 22 ? [normalized, `[${normalized}]:22`] : [`[${normalized}]:${port}`]
}

function matchKnownHostsPattern(pattern: string, targetHost: string, targetPort: number): boolean {
  const candidates = buildKnownHostsCandidates(targetHost, targetPort)
  if (pattern.startsWith('|1|')) {
    const parts = pattern.split('|')
    if (parts.length !== 4 || !parts[2] || !parts[3]) return false
    let salt: Buffer
    let expectedHash: Buffer
    try {
      salt = Buffer.from(parts[2], 'base64')
      expectedHash = Buffer.from(parts[3], 'base64')
    } catch {
      return false
    }
    if (salt.length === 0 || expectedHash.length === 0) return false
    for (const candidate of candidates) {
      const digest = crypto.createHmac('sha1', salt).update(candidate, 'utf8').digest()
      if (digest.length === expectedHash.length && crypto.timingSafeEqual(digest, expectedHash)) {
        return true
      }
    }
    return false
  }
  return candidates.some((candidate) => matchWildcardCaseInsensitive(pattern, candidate))
}

interface ParsedKnownHostsLine {
  lineNumber: number
  marker: '' | '@revoked' | '@cert-authority'
  patterns: string[]
  keyType: string
  keyBlob: Buffer
}

function splitBufferLinesPreservingEol(raw: Buffer): Array<{ lineBytes: Buffer; eolBytes: Buffer }> {
  const out: Array<{ lineBytes: Buffer; eolBytes: Buffer }> = []
  let start = 0
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === 0x0a) {
      const hasCr = i > start && raw[i - 1] === 0x0d
      const lineEnd = hasCr ? i - 1 : i
      const eolStart = hasCr ? i - 1 : i
      out.push({
        lineBytes: raw.subarray(start, lineEnd),
        eolBytes: raw.subarray(eolStart, i + 1),
      })
      start = i + 1
    }
  }
  if (start < raw.length) {
    out.push({
      lineBytes: raw.subarray(start),
      eolBytes: Buffer.alloc(0),
    })
  }
  return out
}

function decodeLineSafe(lineBytes: Buffer): string | null {
  try {
    // Reject lines containing NUL bytes; tolerate non-UTF-8 sequences using latin1/utf8 replacement safely
    if (lineBytes.includes(0x00)) return null
    return lineBytes.toString('utf8')
  } catch {
    return null
  }
}

function parseKnownHostsLine(rawLine: string, lineNumber: number): ParsedKnownHostsLine | null {
  const line = rawLine.trim()
  if (!line || line.startsWith('#')) return null
  const parts = line.split(/\s+/)
  let idx = 0
  let marker: '' | '@revoked' | '@cert-authority' = ''
  if (parts[0] === '@revoked' || parts[0] === '@cert-authority') {
    marker = parts[0]
    idx = 1
  }
  if (parts.length < idx + 3) return null

  const hostField = parts[idx]
  const keyType = parts[idx + 1]
  const keyBase64 = parts[idx + 2]
  if (!hostField || !keyType || !keyBase64) return null

  // Validate strict base64 characters to reject corrupted / non-UTF-8 garbage lines cleanly
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(keyBase64)) return null

  let keyBlob: Buffer
  try {
    keyBlob = Buffer.from(keyBase64, 'base64')
  } catch {
    return null
  }
  if (keyBlob.length === 0) return null

  const patterns = hostField.split(',').filter(Boolean)
  if (patterns.length === 0) return null

  return { lineNumber, marker, patterns, keyType, keyBlob }
}

function doesPatternListMatchHost(patterns: readonly string[], host: string, port: number): boolean {
  let matched = false
  let negated = false
  for (const pat of patterns) {
    if (pat.startsWith('!')) {
      if (matchKnownHostsPattern(pat.slice(1), host, port)) {
        negated = true
      }
    } else if (matchKnownHostsPattern(pat, host, port)) {
      matched = true
    }
  }
  return matched && !negated
}

function toBuffer(content: Buffer | string): Buffer {
  return Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
}

function parseEntriesFromContent(content: Buffer | string): ParsedKnownHostsLine[] {
  const buf = toBuffer(content)
  const lines = splitBufferLinesPreservingEol(buf)
  const parsed: ParsedKnownHostsLine[] = []
  for (let i = 0; i < lines.length; i++) {
    const decoded = decodeLineSafe(lines[i].lineBytes)
    if (decoded === null) continue
    const entry = parseKnownHostsLine(decoded, i + 1)
    if (entry) parsed.push(entry)
  }
  return parsed
}

/**
 * Verifies an SSH server host key across multiple `known_hosts` sources.
 * Scans `@revoked` across ALL files BEFORE concluding `'matched'` (`revoked > matched > mismatch > unknown`).
 */
export function verifySshHostKeyAcrossFiles(
  host: string,
  port: number,
  serverHostKey: Buffer,
  sources: ReadonlyArray<KnownHostsFileSource | KnownHostsTextSource>
): KnownHostsDetailedResult {
  const normalizedHost = normalizeHostForKnownHosts(host)
  let firstMatch: KnownHostsDetailedResult | null = null
  let firstMismatch: KnownHostsDetailedResult | null = null

  for (const src of sources) {
    const rawContent = 'content' in src ? src.content : src.text
    const entries = parseEntriesFromContent(rawContent)

    for (const entry of entries) {
      if (entry.marker === '@cert-authority') continue
      if (!doesPatternListMatchHost(entry.patterns, normalizedHost, port)) continue

      const keyEquals =
        entry.keyBlob.length === serverHostKey.length &&
        crypto.timingSafeEqual(entry.keyBlob, serverHostKey)

      if (entry.marker === '@revoked') {
        if (keyEquals) {
          return {
            result: 'revoked',
            knownHostsPath: src.path,
            line: entry.lineNumber,
            existingKeyType: entry.keyType,
            existingFingerprintSha256: computeSshHostKeyFingerprintSha256(entry.keyBlob),
          }
        }
        continue
      }

      if (keyEquals) {
        if (!firstMatch) {
          firstMatch = {
            result: 'matched',
            knownHostsPath: src.path,
            line: entry.lineNumber,
            existingKeyType: entry.keyType,
            existingFingerprintSha256: computeSshHostKeyFingerprintSha256(entry.keyBlob),
          }
        }
      } else if (!firstMismatch) {
        firstMismatch = {
          result: 'mismatch',
          knownHostsPath: src.path,
          line: entry.lineNumber,
          existingKeyType: entry.keyType,
          existingFingerprintSha256: computeSshHostKeyFingerprintSha256(entry.keyBlob),
        }
      }
    }
  }

  if (firstMatch) return firstMatch
  if (firstMismatch) return firstMismatch
  return { result: 'unknown' }
}

/**
 * Backwards-compatible single-text verifier supporting Buffer/string, wildcards, `!` negation, and `@revoked`.
 */
export function verifySshHostKeyAgainstKnownHosts(
  host: string,
  port: number,
  serverHostKey: Buffer,
  knownHostsContent: Buffer | string
): KnownHostsCheckResult {
  return verifySshHostKeyAcrossFiles(host, port, serverHostKey, [
    { path: 'known_hosts', content: knownHostsContent },
  ]).result
}

const SAFE_DEFAULT_SERVER_HOST_KEYS: readonly string[] = [
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'rsa-sha2-512',
  'rsa-sha2-256',
  'ssh-rsa',
]

function expandHostKeyGroup(keyType: string): string[] {
  const lower = keyType.trim().toLowerCase()
  if (lower === 'ssh-dss') return []
  if (lower === 'ssh-rsa' || lower === 'rsa-sha2-256' || lower === 'rsa-sha2-512') {
    return ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa']
  }
  if (SAFE_DEFAULT_SERVER_HOST_KEYS.includes(lower)) {
    return [lower]
  }
  return []
}

/**
 * Derives `algorithms.serverHostKey` priority order from existing `known_hosts` entries
 * for `(host, port)`, grouping `ssh-rsa`/`rsa-sha2-256`/`rsa-sha2-512` and forbidding `ssh-dss`.
 */
export function resolvePreferredServerHostKeyAlgorithms(
  host: string,
  port: number,
  sources: ReadonlyArray<KnownHostsFileSource | KnownHostsTextSource>
): string[] {
  const normalizedHost = normalizeHostForKnownHosts(host)
  const ordered: string[] = []
  const seen = new Set<string>()
  const push = (algo: string): void => {
    if (algo === 'ssh-dss' || seen.has(algo)) return
    seen.add(algo)
    ordered.push(algo)
  }

  for (const src of sources) {
    const rawContent = 'content' in src ? src.content : src.text
    const entries = parseEntriesFromContent(rawContent)
    for (const entry of entries) {
      if (entry.marker === '@revoked' || entry.marker === '@cert-authority') continue
      if (!doesPatternListMatchHost(entry.patterns, normalizedHost, port)) continue
      for (const algo of expandHostKeyGroup(entry.keyType)) {
        push(algo)
      }
    }
  }

  for (const algo of SAFE_DEFAULT_SERVER_HOST_KEYS) {
    push(algo)
  }
  return ordered
}

async function readKnownHostFileSafe(filePath: string): Promise<Buffer | null> {
  let lst: fs.Stats
  try {
    lst = await fs.promises.lstat(filePath)
  } catch {
    return null
  }
  if (lst.isSymbolicLink() || !lst.isFile() || lst.size > MAX_KNOWN_HOSTS_BYTES) {
    return null
  }
  const openFlags =
    fs.constants.O_RDONLY |
    (typeof fs.constants.O_NONBLOCK === 'number' ? fs.constants.O_NONBLOCK : 0)
  let handle: fs.promises.FileHandle | undefined
  try {
    handle = await fs.promises.open(filePath, openFlags)
    const st = await handle.stat()
    if (!st.isFile() || st.size > MAX_KNOWN_HOSTS_BYTES) return null
    const chunks: Buffer[] = []
    let total = 0
    const buf = Buffer.allocUnsafe(65_536)
    for (;;) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, null)
      if (bytesRead === 0) break
      total += bytesRead
      if (total > MAX_KNOWN_HOSTS_BYTES) return null
      chunks.push(Buffer.from(buf.subarray(0, bytesRead)))
    }
    return Buffer.concat(chunks, total)
  } catch {
    return null
  } finally {
    if (handle) await handle.close().catch(() => {})
  }
}

/**
 * Loads all readable, non-symlink, <= 4 MiB known_hosts files from the 4 standard locations (or overrides).
 */
export async function loadKnownHostsFiles(
  overridePaths?: readonly string[]
): Promise<KnownHostsFileSource[]> {
  const candidates =
    overridePaths && overridePaths.length > 0 ? [...overridePaths] : getDefaultKnownHostsPaths()
  const out: KnownHostsFileSource[] = []
  for (const filePath of candidates) {
    const content = await readKnownHostFileSafe(filePath)
    if (content !== null) {
      out.push({ path: filePath, content })
    }
  }
  return out
}

function formatKnownHostsHostToken(host: string, port: number): string {
  const clean = normalizeHostForKnownHosts(host)
  return port === 22 ? clean : `[${clean}]:${port}`
}

function detectDominantEol(raw: Buffer): Buffer {
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === 0x0a) {
      if (i > 0 && raw[i - 1] === 0x0d) {
        return Buffer.from('\r\n', 'ascii')
      }
      return Buffer.from('\n', 'ascii')
    }
  }
  return Buffer.from('\n', 'ascii')
}

function rewriteMatchingMultiHostLine(
  lineText: string,
  host: string,
  port: number
): string | null {
  const leadingMatch = /^(\s*)(.*)$/.exec(lineText)
  const leadingWs = leadingMatch ? leadingMatch[1] : ''
  const body = leadingMatch ? leadingMatch[2] : lineText
  const firstWsIdx = body.search(/\s/)
  if (firstWsIdx <= 0) return null
  const hostField = body.slice(0, firstWsIdx)
  const remainder = body.slice(firstWsIdx)
  const patterns = hostField.split(',').filter(Boolean)
  const hostToken = formatKnownHostsHostToken(host, port)
  let matchedWildcard = false
  const kept: string[] = []
  for (const pat of patterns) {
    if (pat.startsWith('!')) {
      kept.push(pat)
      continue
    }
    if (!matchKnownHostsPattern(pat, host, port)) {
      kept.push(pat)
      continue
    }
    if (pat.includes('*') || pat.includes('?')) {
      kept.push(pat)
      matchedWildcard = true
    }
  }
  if (matchedWildcard) {
    const neg = `!${hostToken}`
    if (!kept.some((p) => p.toLowerCase() === neg.toLowerCase())) {
      kept.push(neg)
    }
  }
  const hasPositive = kept.some((p) => !p.startsWith('!'))
  if (!hasPositive) return null
  return `${leadingWs}${kept.join(',')}${remainder}`
}

function isRetryableRenameError(err: unknown): boolean {
  if (!err || typeof err !== 'object' || !('code' in err)) return false
  const code = String((err as { code?: unknown }).code)
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES'
}

async function renameWithWindowsBackoff(tmpPath: string, targetPath: string): Promise<void> {
  const delays = [15, 30, 60, 120, 240]
  let attempt = 0
  for (;;) {
    try {
      await fs.promises.rename(tmpPath, targetPath)
      return
    } catch (err: unknown) {
      if (process.platform !== 'win32' || !isRetryableRenameError(err) || attempt >= delays.length) {
        throw err
      }
      const waitMs = delays[attempt]
      attempt += 1
      await new Promise<void>((resolve) => setTimeout(resolve, waitMs))
    }
  }
}

async function fsyncDirectoryPosix(dirPath: string): Promise<void> {
  if (process.platform === 'win32') return
  let dirHandle: fs.promises.FileHandle | undefined
  try {
    dirHandle = await fs.promises.open(dirPath, fs.constants.O_RDONLY)
    await dirHandle.sync()
  } catch {
    // Some filesystems do not support fsync on directories; best-effort
  } finally {
    if (dirHandle) await dirHandle.close().catch(() => {})
  }
}

async function assertSafeKnownHostsTarget(filePath: string): Promise<Buffer> {
  if (isSystemKnownHostsPath(filePath)) {
    throw new Error(`Refusing to modify system known_hosts file "${filePath}"; write to user ~/.ssh/known_hosts instead`)
  }
  const dir = path.dirname(filePath)
  const userSshDir = path.resolve(path.join(os.homedir(), '.ssh'))
  const isUserSshDir = path.resolve(dir) === userSshDir
  try {
    const dirStat = await fs.promises.lstat(dir)
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
      throw new Error(`known_hosts directory "${dir}" is not a safe regular directory`)
    }
    if (process.platform !== 'win32' && isUserSshDir) {
      await fs.promises.chmod(dir, 0o700).catch(() => {})
    }
  } catch (err: unknown) {
    const code =
      err && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code) : ''
    if (code === 'ENOENT') {
      await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 })
      if (process.platform !== 'win32') {
        await fs.promises.chmod(dir, 0o700).catch(() => {})
      }
    } else {
      throw err
    }
  }

  let existingStat: fs.Stats | null = null
  try {
    existingStat = await fs.promises.lstat(filePath)
  } catch (err: unknown) {
    const code =
      err && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code) : ''
    if (code !== 'ENOENT') throw err
  }

  if (!existingStat) {
    return Buffer.alloc(0)
  }
  if (existingStat.isSymbolicLink()) {
    throw new Error(`Refusing to write known_hosts symlink "${filePath}"`)
  }
  if (!existingStat.isFile()) {
    throw new Error(`known_hosts path "${filePath}" is not a regular file`)
  }
  if (existingStat.size > MAX_KNOWN_HOSTS_BYTES) {
    throw new Error(`known_hosts file "${filePath}" exceeds 4 MiB limit`)
  }

  const openFlags =
    fs.constants.O_RDONLY |
    (typeof fs.constants.O_NONBLOCK === 'number' ? fs.constants.O_NONBLOCK : 0) |
    (typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0)
  let handle: fs.promises.FileHandle | undefined
  try {
    handle = await fs.promises.open(filePath, openFlags)
    const st = await handle.stat()
    if (!st.isFile()) {
      throw new Error(`known_hosts path "${filePath}" is not a regular file`)
    }
    if (st.size > MAX_KNOWN_HOSTS_BYTES) {
      throw new Error(`known_hosts file "${filePath}" exceeds 4 MiB limit`)
    }
    const chunks: Buffer[] = []
    let total = 0
    const buf = Buffer.allocUnsafe(65_536)
    for (;;) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, null)
      if (bytesRead === 0) break
      total += bytesRead
      if (total > MAX_KNOWN_HOSTS_BYTES) {
        throw new Error(`known_hosts file "${filePath}" exceeds 4 MiB limit`)
      }
      chunks.push(Buffer.from(buf.subarray(0, bytesRead)))
    }
    return Buffer.concat(chunks, total)
  } finally {
    if (handle) await handle.close().catch(() => {})
  }
}

export interface UpdateKnownHostsOptions {
  filePath?: string
  mode: 'save' | 'replace'
  host: string
  port: number
  keyType: string
  keyBlob: Buffer
}

/**
 * Atomically saves or replaces a host key in `known_hosts` inside a serialized queue:
 * - Rejects symlinks, non-regular files, and files > 4 MiB via `lstat`
 * - Uses `0o700` directory and `0o600` `O_CREAT|O_EXCL` temp file in the same directory
 * - `fsync`s temp file, renames with Windows `EBUSY`/`EPERM` backoff, `fsync`s dir on POSIX
 * - Preserves comments, CRLF endings, `@revoked`, `@cert-authority`, and multi-host entries byte-for-byte
 */
export async function updateKnownHostsAtomically(
  options: UpdateKnownHostsOptions
): Promise<string> {
  const targetPath = options.filePath?.trim() || getPrimaryKnownHostsPath()
  return await knownHostsWriteQueue.run(async () => {
    const existingBuf = await assertSafeKnownHostsTarget(targetPath)
    const dir = path.dirname(targetPath)
    const eol = detectDominantEol(existingBuf)
    const hostToken = formatKnownHostsHostToken(options.host, options.port)
    const keyBase64 = options.keyBlob.toString('base64')
    const newEntryBytes = Buffer.from(`${hostToken} ${options.keyType} ${keyBase64}`, 'utf8')

    let nextBuf: Buffer
    if (options.mode === 'save') {
      const parts: Buffer[] = []
      if (existingBuf.length > 0) {
        parts.push(existingBuf)
        if (existingBuf[existingBuf.length - 1] !== 0x0a) {
          parts.push(eol)
        }
      }
      parts.push(newEntryBytes, eol)
      nextBuf = Buffer.concat(parts)
    } else {
      const lines = splitBufferLinesPreservingEol(existingBuf)
      const outParts: Buffer[] = []
      let replacedInPlace = false

      for (let i = 0; i < lines.length; i++) {
        const { lineBytes, eolBytes } = lines[i]
        const decoded = decodeLineSafe(lineBytes)
        const parsed = decoded !== null ? parseKnownHostsLine(decoded, i + 1) : null
        const lineEol = eolBytes.length > 0 ? eolBytes : eol

        if (
          !parsed ||
          parsed.marker === '@revoked' ||
          parsed.marker === '@cert-authority' ||
          !doesPatternListMatchHost(parsed.patterns, options.host, options.port)
        ) {
          outParts.push(lineBytes, eolBytes)
          continue
        }

        const rewritten = decoded !== null ? rewriteMatchingMultiHostLine(decoded, options.host, options.port) : null
        if (rewritten !== null) {
          outParts.push(Buffer.from(rewritten, 'utf8'), lineEol)
        } else if (!replacedInPlace) {
          outParts.push(newEntryBytes, lineEol)
          replacedInPlace = true
        }
      }

      if (!replacedInPlace) {
        if (outParts.length > 0) {
          const last = outParts[outParts.length - 1]
          if (last.length === 0) {
            outParts.push(eol)
          }
        }
        outParts.push(newEntryBytes, eol)
      }
      nextBuf = Buffer.concat(outParts)
    }

    if (nextBuf.length > MAX_KNOWN_HOSTS_BYTES) {
      throw new Error(`known_hosts update for "${targetPath}" exceeds 4 MiB limit`)
    }

    const tmpPath = path.join(
      dir,
      `.known_hosts.tmp.${process.pid}.${crypto.randomBytes(8).toString('hex')}`
    )
    const createFlags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
    let tmpHandle: fs.promises.FileHandle | undefined
    let renamed = false
    try {
      tmpHandle = await fs.promises.open(tmpPath, createFlags, 0o600)
      await tmpHandle.writeFile(nextBuf)
      await tmpHandle.sync()
      await tmpHandle.close()
      tmpHandle = undefined

      await renameWithWindowsBackoff(tmpPath, targetPath)
      renamed = true
      await fsyncDirectoryPosix(dir)
      return targetPath
    } finally {
      if (tmpHandle) {
        await tmpHandle.close().catch(() => {})
      }
      if (!renamed) {
        await fs.promises.unlink(tmpPath).catch(() => {})
      }
    }
  })
}
