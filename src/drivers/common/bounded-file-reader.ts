import * as fs from 'node:fs'

/**
 * Safely opens and reads a regular file using a single bounded FileHandle.
 * Uses `O_NONBLOCK` on POSIX to prevent hanging on FIFOs/named pipes, verifies
 * `stat.isFile()`, fails closed if size exceeds `maxBytes`, and zeroizes
 * intermediate scratch and chunk buffers in `finally`.
 */
export async function readRegularFileBounded(
  filePath: string,
  maxBytes: number,
  label: string
): Promise<Buffer> {
  const openFlags =
    fs.constants.O_RDONLY |
    (typeof fs.constants.O_NONBLOCK === 'number' ? fs.constants.O_NONBLOCK : 0)
  let handle: fs.promises.FileHandle | undefined
  const chunks: Buffer[] = []
  const chunkBuf = Buffer.allocUnsafe(Math.min(65_536, Math.max(1024, maxBytes + 1)))
  try {
    handle = await fs.promises.open(filePath, openFlags)
    const stat = await handle.stat()
    if (!stat.isFile()) {
      throw new Error(`${label} "${filePath}" is not a regular file`)
    }
    if (stat.size > maxBytes) {
      throw new Error(
        `${label} "${filePath}" exceeds maximum allowed size of ${maxBytes} bytes`
      )
    }
    let total = 0
    for (;;) {
      const { bytesRead } = await handle.read(chunkBuf, 0, chunkBuf.length, null)
      if (bytesRead === 0) break
      total += bytesRead
      if (total > maxBytes) {
        throw new Error(
          `${label} "${filePath}" exceeds maximum allowed size of ${maxBytes} bytes`
        )
      }
      chunks.push(Buffer.from(chunkBuf.subarray(0, bytesRead)))
    }
    return Buffer.concat(chunks, total)
  } finally {
    chunkBuf.fill(0)
    for (const chunk of chunks) {
      chunk.fill(0)
    }
    if (handle) {
      await handle.close().catch(() => {})
    }
  }
}
