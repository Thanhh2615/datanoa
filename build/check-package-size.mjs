/**
 * build/check-package-size.mjs
 * Audits the Datanoa plugin footprint (files, raw MB, top 10 largest files, < 1 MiB vendor ceiling, and 25 MB total budget).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')

const EXCLUDED_DIRS = new Set([
  '.git',
  'node_modules',
  '.orca',
  '.serena',
  '.datanoa',
  '.vite',
  'dist',
  'release',
])
const MAX_VENDOR_FILE_BYTES = 1024 * 1024 // 1 MiB
const MAX_TOTAL_BYTES = 25_000_000 // 25 MB package budget, inclusive

function collectFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDED_DIRS.has(entry.name)) continue
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      collectFiles(fullPath, out)
    } else if (entry.isFile()) {
      const stat = fs.statSync(fullPath)
      const rel = path.relative(projectRoot, fullPath).replace(/\\/g, '/')
      out.push({ rel, bytes: stat.size })
    }
  }
  return out
}

const files = collectFiles(projectRoot)
const totalBytes = files.reduce((sum, item) => sum + item.bytes, 0)
const sorted = [...files].sort((a, b) => b.bytes - a.bytes)

let vendorViolation = false
for (const item of files) {
  if (item.rel.startsWith('vendor/') && item.bytes >= MAX_VENDOR_FILE_BYTES) {
    console.error(
      `[package-size] FAIL: ${item.rel} (${(item.bytes / 1024).toFixed(1)} KB) reaches or exceeds 1 MiB ceiling`
    )
    vendorViolation = true
  }
}

const totalViolation = totalBytes > MAX_TOTAL_BYTES
if (totalViolation) {
  console.error(
    `[package-size] FAIL: workspace payload is ${totalBytes} bytes, exceeding the ${MAX_TOTAL_BYTES} byte (25 MB) budget`
  )
}

console.log(
  `[package-size] Workspace payload: ${files.length} files, ${(totalBytes / 1_000_000).toFixed(2)} MB (${totalBytes} bytes)`
)
console.log('[package-size] Top 10 largest files:')
for (const item of sorted.slice(0, 10)) {
  console.log(`  ${(item.bytes / 1024).toFixed(1).padStart(7)} KB  ${item.rel}`)
}

if (vendorViolation || totalViolation) {
  process.exit(1)
}
