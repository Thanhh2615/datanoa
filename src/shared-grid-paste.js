// src/shared-grid-paste.js
// Pure clipboard delimiter parsing, smart grid paste planning & privacy-safe diagnostic redaction
// shared between Fullscreen Studio and Docked Side Panel.

export function parseJsonPreservingBigInts(raw) {
  if (typeof raw !== 'string') {
    return JSON.parse(raw)
  }
  const source = raw.startsWith('\uFEFF') ? raw.slice(1) : raw
  if (!/\d{16}/.test(source)) {
    return JSON.parse(source)
  }

  const chunks = []
  let lastFlush = 0
  let i = 0
  const len = source.length

  while (i < len) {
    const ch = source[i]
    if (ch === '"') {
      i++
      while (i < len) {
        const sc = source[i]
        if (sc === '\\') {
          i += 2
          continue
        }
        if (sc === '"') {
          i++
          break
        }
        i++
      }
      continue
    }

    const isMinusDigit = ch === '-' && i + 1 < len && source[i + 1] >= '0' && source[i + 1] <= '9'
    const isDigit = ch >= '0' && ch <= '9'
    if (isMinusDigit || isDigit) {
      const start = i
      if (ch === '-') i++
      const digitsStart = i
      while (i < len && source[i] >= '0' && source[i] <= '9') {
        i++
      }
      const intEnd = i
      const digitCount = intEnd - digitsStart

      let hasDot = false
      let fracStart = -1
      let fracEnd = -1
      let fracAllZero = true
      if (i < len && source[i] === '.') {
        hasDot = true
        i++
        fracStart = i
        while (i < len && source[i] >= '0' && source[i] <= '9') {
          if (source[i] !== '0') fracAllZero = false
          i++
        }
        fracEnd = i
      }

      let hasExp = false
      let expDigitsStart = -1
      let expDigitsEnd = -1
      let expAllZero = true
      if (i < len && (source[i] === 'e' || source[i] === 'E')) {
        hasExp = true
        i++
        if (i < len && (source[i] === '+' || source[i] === '-')) i++
        expDigitsStart = i
        while (i < len && source[i] >= '0' && source[i] <= '9') {
          if (source[i] !== '0') expAllZero = false
          i++
        }
        expDigitsEnd = i
      }

      const hasLeadingZero = digitCount > 1 && source[digitsStart] === '0'
      const validFrac = !hasDot || (fracEnd > fracStart && fracAllZero)
      const validExp = !hasExp || (expDigitsEnd > expDigitsStart && expAllZero)

      if (!hasLeadingZero && digitCount >= 16 && validFrac && validExp) {
        const intStr = source.slice(start, intEnd)
        if (!Number.isSafeInteger(Number(intStr))) {
          chunks.push(source.slice(lastFlush, start), `"${intStr}"`)
          lastFlush = i
        }
      }
      continue
    }

    i++
  }

  if (chunks.length === 0) {
    return JSON.parse(source)
  }
  chunks.push(source.slice(lastFlush))
  return JSON.parse(chunks.join(''))
}

/**
 * Formats strict RFC 8259 JSON in a single O(n) pass without routing numeric literals
 * through IEEE-754 floats, preserving arbitrary-precision BigInt / decimal tokens losslessly.
 */
export function formatJsonPreservingNumbers(raw, indent = 2) {
  const source = typeof raw === 'string' && raw.startsWith('\uFEFF') ? raw.slice(1) : String(raw)
  parseJsonPreservingBigInts(source)

  const step =
    typeof indent === 'number' && indent > 0
      ? ' '.repeat(Math.min(indent, 10))
      : typeof indent === 'string'
        ? indent
        : ''
  const chunks = []
  const len = source.length
  let depth = 0
  let i = 0

  const skipWs = (pos) => {
    let k = pos
    while (
      k < len &&
      (source[k] === ' ' || source[k] === '\t' || source[k] === '\r' || source[k] === '\n')
    ) {
      k++
    }
    return k
  }

  while (i < len) {
    i = skipWs(i)
    if (i >= len) break
    const ch = source[i]

    if (ch === '"') {
      const start = i
      i++
      while (i < len) {
        const sc = source[i]
        if (sc === '\\') {
          i += 2
          continue
        }
        if (sc === '"') {
          i++
          break
        }
        i++
      }
      chunks.push(source.slice(start, i))
      continue
    }

    if (ch === '{' || ch === '[') {
      const closeChar = ch === '{' ? '}' : ']'
      const nextPos = skipWs(i + 1)
      if (nextPos < len && source[nextPos] === closeChar) {
        chunks.push(ch + closeChar)
        i = nextPos + 1
        continue
      }
      chunks.push(ch)
      depth++
      if (step) {
        chunks.push('\n' + step.repeat(depth))
      }
      i++
      continue
    }

    if (ch === '}' || ch === ']') {
      depth = Math.max(0, depth - 1)
      if (step) {
        chunks.push('\n' + step.repeat(depth))
      }
      chunks.push(ch)
      i++
      continue
    }

    if (ch === ':') {
      chunks.push(step ? ': ' : ':')
      i++
      continue
    }

    if (ch === ',') {
      chunks.push(step ? ',\n' + step.repeat(depth) : ',')
      i++
      continue
    }

    const start = i
    while (
      i < len &&
      source[i] !== ' ' &&
      source[i] !== '\t' &&
      source[i] !== '\r' &&
      source[i] !== '\n' &&
      source[i] !== '{' &&
      source[i] !== '}' &&
      source[i] !== '[' &&
      source[i] !== ']' &&
      source[i] !== ',' &&
      source[i] !== ':'
    ) {
      i++
    }
    chunks.push(source.slice(start, i))
  }

  return chunks.join('')
}

function looksLikeJsonLiteral(trimmed) {
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      const parsed = JSON.parse(trimmed)
      return parsed !== null && typeof parsed === 'object'
    } catch {
      return false
    }
  }
  return false
}

function detectClipboardDelimiter(text) {
  let inQuotes = false
  let atFieldStart = true
  let hasQuotedCommaBoundary = false
  const lineCommaCounts = []
  let currentCommas = 0
  let currentLineHasChars = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          i++
          continue
        }
        inQuotes = false
        if (i + 1 < text.length && text[i + 1] === ',') {
          hasQuotedCommaBoundary = true
        }
        continue
      }
      continue
    }

    if (atFieldStart && ch === '"') {
      inQuotes = true
      atFieldStart = false
      currentLineHasChars = true
      continue
    }

    if (ch === '\t') {
      return '\t'
    }

    if (ch === ',') {
      currentCommas++
      atFieldStart = true
      currentLineHasChars = true
      continue
    }

    if (ch === '\r' || ch === '\n') {
      if (currentLineHasChars) {
        lineCommaCounts.push(currentCommas)
      }
      currentCommas = 0
      currentLineHasChars = false
      atFieldStart = true
      if (ch === '\r' && i + 1 < text.length && text[i + 1] === '\n') {
        i++
      }
      continue
    }

    atFieldStart = false
    currentLineHasChars = true
  }

  if (currentLineHasChars) {
    lineCommaCounts.push(currentCommas)
  }

  if (lineCommaCounts.length === 0) {
    return '\t'
  }

  if (lineCommaCounts.length >= 2) {
    const first = lineCommaCounts[0]
    if (first >= 1 && lineCommaCounts.every((count) => count === first)) {
      return ','
    }
    return '\t'
  }

  if (hasQuotedCommaBoundary && lineCommaCounts[0] >= 1) {
    return ','
  }

  return '\t'
}

/**
 * RFC-4180 compliant clipboard parser. Auto-detects `\t` vs `,` without splitting
 * single-cell prose/addresses/JSON on commas or newlines, preserves quoted newlines & `""`.
 */
export function parseDelimitedClipboard(text, options) {
  const raw = String(text ?? '')
  if (!raw) return []

  if (!options?.delimiter) {
    const trimmed = raw.trim()
    if (looksLikeJsonLiteral(trimmed)) {
      return [[trimmed]]
    }
  }

  const delimiter = options?.delimiter ?? detectClipboardDelimiter(raw)
  const rows = []
  let currentRow = []
  let field = ''
  let inQuotes = false
  let atFieldStart = true
  let i = 0
  const len = raw.length

  while (i < len) {
    const ch = raw[i]
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < len && raw[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }

    if (atFieldStart && ch === '"') {
      inQuotes = true
      atFieldStart = false
      i++
      continue
    }

    if (ch === delimiter) {
      currentRow.push(field)
      field = ''
      atFieldStart = true
      i++
      continue
    }

    if (ch === '\r' || ch === '\n') {
      currentRow.push(field)
      rows.push(currentRow)
      currentRow = []
      field = ''
      atFieldStart = true
      if (ch === '\r' && i + 1 < len && raw[i + 1] === '\n') {
        i += 2
      } else {
        i++
      }
      continue
    }

    field += ch
    atFieldStart = false
    i++
  }

  if (!atFieldStart || currentRow.length > 0) {
    currentRow.push(field)
    rows.push(currentRow)
  }

  if (rows.length === 1 && rows[0].length === 1 && rows[0][0] === '' && /^[\r\n]+$/.test(raw)) {
    return []
  }

  return rows
}

function isAutoOrGeneratedColumn(col) {
  return Boolean(col && (col.isAutoIncrement === true || col.isGenerated === true))
}

function buildColumnNameLookup(allColumns) {
  const lookup = new Map()
  allColumns.forEach((col, idx) => lookup.set(String(col.name || '').trim().toLowerCase(), idx))
  return lookup
}

function detectHeaderColumnMapping(firstRow, allColumns, rowCount, explicitHasHeaders) {
  if (rowCount < 2 || !Array.isArray(firstRow) || firstRow.length === 0) return null
  const lookup = buildColumnNameLookup(allColumns)
  const mapped = []
  for (const cell of firstRow) {
    if (typeof cell !== 'string') return null
    const key = cell.trim().toLowerCase()
    if (!key) return null
    const idx = lookup.get(key)
    if (idx === undefined) return null
    mapped.push(idx)
  }
  if (mapped.length === 1 && !explicitHasHeaders) return null
  return mapped
}

function resolveSourceHeaderMapping(sourceHeaders, clipWidth, allColumns) {
  if (!Array.isArray(sourceHeaders) || sourceHeaders.length === 0 || sourceHeaders.length < clipWidth) {
    return null
  }
  const lookup = buildColumnNameLookup(allColumns)
  const mapped = []
  for (let i = 0; i < sourceHeaders.length; i++) {
    const idx = lookup.get(String(sourceHeaders[i] || '').trim().toLowerCase())
    if (idx === undefined) return null
    mapped.push(idx)
  }
  if (!mapped.some((idx) => !isAutoOrGeneratedColumn(allColumns[idx]))) {
    return null
  }
  return mapped
}

function makeModelIndexResolver(mapping, allColumns, visColPosByModelIdx) {
  return (dc) => {
    const modelColIdx = mapping[dc]
    if (modelColIdx === undefined) {
      return null
    }
    return { modelColIdx, visColIdx: visColPosByModelIdx.get(modelColIdx) ?? -1 }
  }
}

/**
 * Pure smart paste planner shared by Studio and Side Panel across all 5 paste modes.
 */
export function planGridPaste(input) {
  const {
    matrix,
    hasSelection,
    selectionBBox,
    selectedCellCount,
    existingRowCount,
    visibleColIndices,
    allColumns,
    forceNewRows,
    explicitHasHeaders = false,
    sourceHeaders,
  } = input

  if (!Array.isArray(matrix) || matrix.length === 0 || !visibleColIndices?.length || !allColumns?.length) {
    return {
      mode: 'empty',
      hadHeaders: false,
      overwrites: [],
      inserts: [],
      startVisRow: 0,
      startVisCol: 0,
    }
  }

  const headerColMapping = detectHeaderColumnMapping(
    matrix[0],
    allColumns,
    matrix.length,
    Boolean(explicitHasHeaders)
  )
  const hadHeaders = headerColMapping !== null
  const dataRows = hadHeaders ? matrix.slice(1) : matrix

  const visColPosByModelIdx = new Map()
  visibleColIndices.forEach((modelColIdx, visIdx) => visColPosByModelIdx.set(modelColIdx, visIdx))

  let maxClipCols = 0
  for (const row of dataRows) {
    if (row.length > maxClipCols) maxClipCols = row.length
  }

  const isSingleScalar = dataRows.length === 1 && dataRows[0].length === 1
  if (
    !forceNewRows &&
    hasSelection &&
    existingRowCount > 0 &&
    !hadHeaders &&
    isSingleScalar &&
    selectedCellCount > 1
  ) {
    return {
      mode: 'fill',
      hadHeaders: false,
      fillValue: dataRows[0][0],
      overwrites: [],
      inserts: [],
      startVisRow: selectionBBox?.startRow ?? 0,
      startVisCol: selectionBBox?.startCol ?? 0,
    }
  }

  const buildInsertCells = (rowCells, colResolver) => {
    const cells = []
    for (let dc = 0; dc < rowCells.length; dc++) {
      const target = colResolver(dc)
      if (!target) continue
      const col = allColumns[target.modelColIdx]
      if (!col || isAutoOrGeneratedColumn(col)) continue
      cells.push({
        modelColIdx: target.modelColIdx,
        visColIdx: target.visColIdx,
        rawValue: rowCells[dc],
      })
    }
    return cells
  }

  if (!hasSelection || !selectionBBox || forceNewRows || existingRowCount <= 0) {
    let insertColResolver
    if (headerColMapping) {
      insertColResolver = makeModelIndexResolver(headerColMapping, allColumns, visColPosByModelIdx)
    } else {
      const anchorCol =
        hasSelection && selectionBBox && maxClipCols < visibleColIndices.length
          ? Math.max(0, selectionBBox.startCol)
          : 0
      const canUseSourceMapping =
        !hasSelection ||
        !selectionBBox ||
        (forceNewRows && anchorCol === 0 && maxClipCols < visibleColIndices.length)
      const sourceMapping = canUseSourceMapping
        ? resolveSourceHeaderMapping(sourceHeaders, maxClipCols, allColumns)
        : null

      if (sourceMapping) {
        insertColResolver = makeModelIndexResolver(sourceMapping, allColumns, visColPosByModelIdx)
      } else {
        const writableVisibleCols = visibleColIndices.filter(
          (modelColIdx) => !isAutoOrGeneratedColumn(allColumns[modelColIdx])
        )
        const shouldSkipLeadingAuto =
          anchorCol === 0 &&
          maxClipCols < visibleColIndices.length &&
          writableVisibleCols.length > 0 &&
          isAutoOrGeneratedColumn(allColumns[visibleColIndices[0]])
        if (shouldSkipLeadingAuto) {
          insertColResolver = (dc) => {
            const modelColIdx = writableVisibleCols[dc]
            if (modelColIdx === undefined) return null
            return { modelColIdx, visColIdx: visColPosByModelIdx.get(modelColIdx) }
          }
        } else {
          insertColResolver = (dc) => {
            const visColIdx = anchorCol + dc
            const modelColIdx = visibleColIndices[visColIdx]
            if (modelColIdx === undefined) return null
            return { modelColIdx, visColIdx }
          }
        }
      }
    }

    const inserts = dataRows.map((rowCells) => ({
      cells: buildInsertCells(rowCells, insertColResolver),
    }))

    return {
      mode: 'insert',
      hadHeaders,
      overwrites: [],
      inserts,
      startVisRow: existingRowCount,
      startVisCol: 0,
    }
  }

  const startVisRow = Math.max(0, selectionBBox.startRow)
  const effectiveStartCol = headerColMapping
    ? 0
    : maxClipCols >= visibleColIndices.length
      ? 0
      : Math.max(0, selectionBBox.startCol)

  const headerLookup = headerColMapping
    ? makeModelIndexResolver(headerColMapping, allColumns, visColPosByModelIdx)
    : null

  const resolveColumn = (dc) => {
    if (headerLookup) return headerLookup(dc)
    const visColIdx = effectiveStartCol + dc
    const modelColIdx = visibleColIndices[visColIdx]
    if (modelColIdx === undefined) return null
    return { modelColIdx, visColIdx }
  }

  const overwrites = []
  const inserts = []

  for (let dr = 0; dr < dataRows.length; dr++) {
    const targetVisRow = startVisRow + dr
    const rowCells = dataRows[dr]
    if (targetVisRow < existingRowCount) {
      const cells = []
      for (let dc = 0; dc < rowCells.length; dc++) {
        const target = resolveColumn(dc)
        if (!target) continue
        cells.push({
          modelColIdx: target.modelColIdx,
          visColIdx: target.visColIdx,
          rawValue: rowCells[dc],
        })
      }
      overwrites.push({ targetVisRow, cells })
    } else {
      inserts.push({ cells: buildInsertCells(rowCells, resolveColumn) })
    }
  }

  const mode =
    overwrites.length > 0 && inserts.length > 0
      ? 'overwrite-and-insert'
      : overwrites.length > 0
        ? 'overwrite'
        : 'insert'

  return {
    mode,
    hadHeaders,
    overwrites,
    inserts,
    startVisRow,
    startVisCol: effectiveStartCol,
  }
}

/**
 * Strips URI credentials, secrets, hostnames, IPs, and filesystem paths from an error string.
 */
export function sanitizeDiagnosticErrorText(rawError, options = {}) {
  const stripControlChars = Boolean(options?.stripControlChars)
  const ellipsis = Boolean(options?.ellipsis)
  let raw = String(rawError || '')
  if (stripControlChars) {
    raw = raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
  }
  raw = raw.trim()
  if (!raw) return ''

  let clean = raw
    .replace(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s'"<>]+/g, '<redacted-uri>')
    .replace(
      /\b(?:password|passwd|pwd|user|username|token|secret|authToken|api_?key)\s*[:=]\s*[^\s,;'"<>]+/gi,
      '<redacted-secret>'
    )
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted-token>')
    .replace(/[A-Za-z]:\\[^\s'"<>]+/g, '<redacted-path>')
    .replace(/\/(?:Users|home|var|tmp|etc|opt|private|mnt|srv)\/[^\s'"<>]+/g, '<redacted-path>')
    .replace(/[^\s@'"<>]+@[^\s@'"<>]+\.[^\s@'"<>]+/g, '<redacted-endpoint>')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '<redacted-ip>')
    .replace(
      /\b[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\.(?:co|com|io|net|org|dev|tech|cloud|app|local|internal|lan)(?::\d+)?\b/gi,
      '<redacted-host>'
    )
    .replace(/\s+/g, ' ')

  if (stripControlChars) {
    clean = clean.trim()
  }
  if (ellipsis && clean.length > 280) {
    return `${clean.slice(0, 277)}...`
  }
  return clean.slice(0, 280)
}
