// src/editor/db-icons.ts
// 8-Engine vector SVG icon generators, engine metadata catalog, and pure Studio DOM/text helpers

import type { ConnectionColorTag, DatabaseDriverType } from '../protocol.js'

export const DB_LOGO_COLORS: Readonly<Record<DatabaseDriverType, string>> = {
  sqlite: '#38bdf8',
  postgres: '#60a5fa',
  mysql: '#fb923c',
  mariadb: '#c084fc',
  cockroachdb: '#4ade80',
  clickhouse: '#facc15',
  redis: '#f87171',
  libsql: '#2dd4bf',
}

export interface StudioEngineMeta {
  id: DatabaseDriverType
  label: string
  defaultPort: number
  defaultDb: string
  defaultUser: string
  defaultSsl: boolean
}

export type ConnectionEngineMeta = StudioEngineMeta

export const STUDIO_ENGINES: ReadonlyArray<StudioEngineMeta> = [
  { id: 'sqlite', label: 'SQLite', defaultPort: 0, defaultDb: 'main.db', defaultUser: '', defaultSsl: false },
  { id: 'postgres', label: 'PostgreSQL', defaultPort: 5432, defaultDb: 'postgres', defaultUser: 'postgres', defaultSsl: false },
  { id: 'mysql', label: 'MySQL', defaultPort: 3306, defaultDb: 'mysql', defaultUser: 'root', defaultSsl: false },
  { id: 'mariadb', label: 'MariaDB', defaultPort: 3306, defaultDb: 'mysql', defaultUser: 'root', defaultSsl: false },
  { id: 'cockroachdb', label: 'CockroachDB', defaultPort: 26257, defaultDb: 'defaultdb', defaultUser: 'root', defaultSsl: true },
  { id: 'clickhouse', label: 'ClickHouse', defaultPort: 8123, defaultDb: 'default', defaultUser: 'default', defaultSsl: false },
  { id: 'redis', label: 'Redis', defaultPort: 6379, defaultDb: '0', defaultUser: '', defaultSsl: false },
  { id: 'libsql', label: 'LibSQL / Turso', defaultPort: 443, defaultDb: 'turso', defaultUser: '', defaultSsl: true },
]

export const CONNECTION_ENGINES = STUDIO_ENGINES

export const CONNECTION_ENV_TAGS: ReadonlyArray<{ id: ConnectionColorTag; label: string }> = [
  { id: 'none', label: 'None' },
  { id: 'dev', label: 'Dev' },
  { id: 'staging', label: 'Staging' },
  { id: 'prod', label: 'Prod' },
]

export function getStudioEngineMeta(driver: DatabaseDriverType): StudioEngineMeta {
  return STUDIO_ENGINES.find((e) => e.id === driver) ?? STUDIO_ENGINES[0]
}

export const getConnectionEngineMeta = getStudioEngineMeta

export function isKnownConnectionDriver(value: unknown): value is DatabaseDriverType {
  return typeof value === 'string' && STUDIO_ENGINES.some((e) => e.id === value)
}

export function createSvgElement(tag: string, attrs: Record<string, string>): SVGElement {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag)
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, v)
  }
  return el
}

export function createDbLogoSvg(driver: DatabaseDriverType): SVGElement {
  const color = DB_LOGO_COLORS[driver] || '#e6e6e6'
  const isClickHouse = driver === 'clickhouse'
  const strokeWidth = driver === 'postgres' || driver === 'mariadb' || driver === 'redis' ? '1.8' : '1.9'
  const svg = createSvgElement('svg', {
    width: '14',
    height: '14',
    viewBox: '0 0 24 24',
    fill: isClickHouse ? color : 'none',
    stroke: isClickHouse ? 'none' : color,
    'stroke-width': strokeWidth,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  })

  switch (driver) {
    case 'sqlite': {
      svg.appendChild(createSvgElement('ellipse', { cx: '10', cy: '6', rx: '7', ry: '2.5' }))
      svg.appendChild(
        createSvgElement('path', { d: 'M3 6v12c0 1.4 3.1 2.5 7 2.5 1.8 0 3.4-.2 4.7-.6' })
      )
      svg.appendChild(createSvgElement('path', { d: 'M3 12c0 1.4 3.1 2.5 7 2.5' }))
      svg.appendChild(
        createSvgElement('path', {
          d: 'M21 4c-4.5 1-7.5 4.8-8.2 11.2l3.8-1.4c2.4-2.1 4-5.4 4.4-9.8z',
        })
      )
      break
    }
    case 'postgres': {
      svg.appendChild(
        createSvgElement('path', {
          d: 'M7 11c-2.5 0-4-1.8-4-4.2C3 4.6 5 3 7.5 3c2 0 3.5 1 4.5 2.4C13 4 14.5 3 16.5 3 19 3 21 4.6 21 6.8c0 2.4-1.5 4.2-4 4.2',
        })
      )
      svg.appendChild(
        createSvgElement('path', {
          d: 'M7 11v4.5c0 2.5 2 4 4.5 4 1.6 0 2.8-.8 3.5-2.1.5 1.6 1.5 3.6 3.5 3.6 1.2 0 2-.9 2-2.2 0-1.1-.8-1.8-1.5-2.2-.8-.5-1.2-1.4-1.2-2.8V11',
        })
      )
      svg.appendChild(createSvgElement('circle', { cx: '9.5', cy: '9', r: '0.8', fill: color }))
      svg.appendChild(createSvgElement('circle', { cx: '14.5', cy: '9', r: '0.8', fill: color }))
      break
    }
    case 'mysql': {
      svg.appendChild(
        createSvgElement('path', {
          d: 'M3 16c2.5-5 6.8-8.5 12-9.5-1.4 2.4-1.4 4.8.2 6.7 1.2 1.4 3.4 2.1 5.8 1.8-2.6 2.1-6.2 2.8-9.5 1.8-1.9-.6-3.4-2-4.6-3.7',
        })
      )
      svg.appendChild(createSvgElement('path', { d: 'M9.5 8.5L11 5l2.8 2' }))
      svg.appendChild(createSvgElement('path', { d: 'M3 19.5c3-1 6-1 9 0s6 1 9 0' }))
      break
    }
    case 'mariadb': {
      svg.appendChild(
        createSvgElement('path', {
          d: 'M4 18c1-4 3-7 6-9 2-1.4 5-1.4 6.8.5 1.2 1.3 1.4 3.5 3.2 4.5-1.4 1.5-3.2 2-5.2 1.6-1.4-.3-2.5.4-3 1.8L10.5 20H4v-2z',
        })
      )
      svg.appendChild(createSvgElement('circle', { cx: '14', cy: '10.2', r: '0.8', fill: color }))
      svg.appendChild(createSvgElement('path', { d: 'M18.5 12.2l2.5-.7' }))
      svg.appendChild(createSvgElement('path', { d: 'M18.5 14l2.5.6' }))
      break
    }
    case 'cockroachdb': {
      svg.appendChild(
        createSvgElement('polygon', {
          points: '12 3 19 8.5 16.5 19.5 12 21 7.5 19.5 5 8.5',
        })
      )
      svg.appendChild(createSvgElement('line', { x1: '12', y1: '3', x2: '12', y2: '21' }))
      svg.appendChild(createSvgElement('path', { d: 'M5 8.5l7 4 7-4' }))
      svg.appendChild(createSvgElement('path', { d: 'M8.5 5.5L6 2.5' }))
      svg.appendChild(createSvgElement('path', { d: 'M15.5 5.5L18 2.5' }))
      break
    }
    case 'clickhouse': {
      svg.appendChild(
        createSvgElement('rect', { x: '3', y: '4', width: '2.8', height: '16', rx: '0.8', fill: color, stroke: 'none' })
      )
      svg.appendChild(
        createSvgElement('rect', { x: '7.5', y: '4', width: '2.8', height: '16', rx: '0.8', fill: color, stroke: 'none' })
      )
      svg.appendChild(
        createSvgElement('rect', { x: '12', y: '4', width: '2.8', height: '16', rx: '0.8', fill: color, stroke: 'none' })
      )
      svg.appendChild(
        createSvgElement('rect', { x: '16.5', y: '4', width: '2.8', height: '12.5', rx: '0.8', fill: color, stroke: 'none' })
      )
      svg.appendChild(
        createSvgElement('rect', {
          x: '16.5',
          y: '18',
          width: '2.8',
          height: '2',
          rx: '0.6',
          opacity: '0.65',
          fill: color,
          stroke: 'none',
        })
      )
      break
    }
    case 'redis': {
      svg.appendChild(createSvgElement('polygon', { points: '12 3 21 7.5 12 12 3 7.5' }))
      svg.appendChild(createSvgElement('polyline', { points: '3 12 12 16.5 21 12' }))
      svg.appendChild(createSvgElement('polyline', { points: '3 16.5 12 21 21 16.5' }))
      break
    }
    case 'libsql': {
      svg.appendChild(
        createSvgElement('polygon', {
          points: '12 2.5 20.5 7.5 20.5 16.5 12 21.5 3.5 16.5 3.5 7.5',
        })
      )
      svg.appendChild(createSvgElement('path', { d: 'M7.5 12.5c1.5-2 3-2 4.5 0s3 2 4.5 0' }))
      svg.appendChild(createSvgElement('path', { d: 'M12.8 7.5l-2 4h3l-1.8 4' }))
      break
    }
  }

  return svg
}

const BUTTON_ORIG_LABELS = new WeakMap<HTMLButtonElement, string>()

export function setButtonLoading(
  btn: HTMLButtonElement | null,
  busy: boolean,
  loadingLabel?: string
): void {
  if (!btn) return
  if (busy) {
    if (!BUTTON_ORIG_LABELS.has(btn)) {
      BUTTON_ORIG_LABELS.set(btn, btn.textContent || '')
    }
    btn.disabled = true
    btn.classList?.add?.('is-loading')
    const labelText = loadingLabel ?? BUTTON_ORIG_LABELS.get(btn) ?? ''
    let timerEl = btn.querySelector?.('.datanoa-live-timer')
    if (!timerEl) {
      btn.innerHTML = ''
      const spinner = document.createElement('span')
      spinner.className = 'datanoa-spinner'
      spinner.setAttribute('aria-hidden', 'true')
      timerEl = document.createElement('span')
      timerEl.className = 'datanoa-live-timer'
      btn.appendChild(spinner)
      btn.appendChild(timerEl)
    }
    timerEl.textContent = labelText
  } else {
    btn.classList?.remove?.('is-loading')
    if (BUTTON_ORIG_LABELS.has(btn)) {
      btn.textContent = BUTTON_ORIG_LABELS.get(btn) ?? ''
      BUTTON_ORIG_LABELS.delete(btn)
    }
    btn.disabled = false
  }
}

export function formatAggregateNumber(value: number): string {
  if (!Number.isFinite(value)) return '0'
  if (Number.isInteger(value)) return String(value)
  return String(Number(value.toFixed(4)))
}

export function formatRelativeTimestamp(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return ''
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (diffSec < 10) return 'just now'
  if (diffSec < 60) return `${diffSec}s ago`
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.floor(diffHr / 24)
  return `${diffDay}d ago`
}

export function downloadTextFile(content: string, filename: string, mimeType: string): void {
  if (typeof document === 'undefined' || !document.body || typeof Blob === 'undefined') return
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.style.display = 'none'
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => {
    URL.revokeObjectURL?.(url)
  }, 1000)
}

export function extractPredicateColumnName(
  rawHead: string
): { column: string; rest: string } | null {
  const s = rawHead.trimStart()
  if (!s) return null
  const q = s[0]
  if (q === '"' || q === '`') {
    let i = 1
    let col = ''
    while (i < s.length) {
      if (s[i] === q) {
        if (s[i + 1] === q) {
          col += q
          i += 2
          continue
        }
        return col ? { column: col, rest: s.slice(i + 1).trimStart() } : null
      }
      col += s[i]
      i++
    }
    return null
  }
  if (q === '[') {
    const closeIdx = s.indexOf(']', 1)
    if (closeIdx <= 1) return null
    return { column: s.slice(1, closeIdx), rest: s.slice(closeIdx + 1).trimStart() }
  }
  const m = /^([^\s=!<>]+)\s*(.*)$/.exec(s)
  if (!m || !m[1]) return null
  return { column: m[1], rest: m[2].trimStart() }
}

export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName.toUpperCase()
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (target.isContentEditable === true) return true
  if (typeof target.closest === 'function' && target.closest('.cm-editor, .cm-content')) {
    return true
  }
  return false
}

export function parseClientQuickFilterPredicate(
  predicateSql: string
): { column: string; op: 'eq' | 'neq' | 'is-null' | 'is-not-null'; value: unknown } | null {
  const parsedCol = extractPredicateColumnName(predicateSql.trim())
  if (!parsedCol) return null
  const { column, rest } = parsedCol
  const nullMatch = /^IS\s+(NOT\s+)?NULL$/i.exec(rest)
  if (nullMatch) {
    return {
      column,
      op: nullMatch[1] ? 'is-not-null' : 'is-null',
      value: null,
    }
  }
  const cmpMatch = /^(=|!=|<>)\s*(.+)$/.exec(rest)
  if (cmpMatch && cmpMatch[2]) {
    const op: 'eq' | 'neq' = cmpMatch[1] === '=' ? 'eq' : 'neq'
    const rawVal = cmpMatch[2].trim()
    let parsedVal: unknown = rawVal
    if (rawVal.startsWith("'") && rawVal.endsWith("'") && rawVal.length >= 2) {
      parsedVal = rawVal.slice(1, -1).replace(/''/g, "'")
    } else if (/^true$/i.test(rawVal)) {
      parsedVal = true
    } else if (/^false$/i.test(rawVal)) {
      parsedVal = false
    } else if (/^[+-]?\d+(?:\.\d+)?$/.test(rawVal)) {
      parsedVal = Number(rawVal)
    }
    return { column, op, value: parsedVal }
  }
  return null
}

export function fuzzyMatchScore(query: string, candidate: string): number {
  const q = query.trim().toLowerCase()
  if (!q) return 1
  const c = candidate.toLowerCase()
  if (c === q) return 100
  if (c.startsWith(q)) return 80
  const idx = c.indexOf(q)
  if (idx >= 0) return 60 - Math.min(idx, 30)
  let qi = 0
  let consecutive = 0
  let score = 0
  for (let ci = 0; ci < c.length && qi < q.length; ci++) {
    if (c[ci] === q[qi]) {
      qi++
      consecutive++
      score += 2 + consecutive
    } else {
      consecutive = 0
    }
  }
  return qi === q.length ? score : 0
}

export function extractQueriedTableName(sqlText: string): string | null {
  const cleaned = sqlText
    .replace(/--[^\r\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\b(?:EXTRACT|TRIM)\s*\([^()]*\bFROM\b[^()]*\)/gi, ' ')
    .trim()
  if (!/^\s*(?:WITH\b[\s\S]+?\bSELECT|SELECT)\b/i.test(cleaned)) {
    return null
  }
  const match = /\bFROM\s+(?:["`[\]]?[A-Za-z0-9_]+["`[\]]?\s*\.\s*)?["`[]?([A-Za-z0-9_]+)["`\]]?/i.exec(
    cleaned
  )
  if (!match || !match[1]) return null
  const candidate = match[1]
  if (/^(?:SELECT|WHERE|VALUES|LATERAL|UNNEST)$/i.test(candidate)) return null
  return candidate
}

export function copyTextFallback(text: string, triggerBtn?: HTMLButtonElement | null): void {
  if (typeof document !== 'undefined' && document.body) {
    const prevActive =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '-9999px'
    ta.style.left = '-9999px'
    ta.style.width = '1px'
    ta.style.height = '1px'
    ta.style.opacity = '0'
    ta.style.pointerEvents = 'none'
    document.body.appendChild(ta)
    try {
      ta.focus({ preventScroll: true })
    } catch {
      ta.focus()
    }
    ta.select()
    try {
      if (typeof ta.setSelectionRange === 'function') {
        ta.setSelectionRange(0, text.length)
      }
    } catch {
      // Ignore in minimal test DOM
    }
    try {
      document.execCommand?.('copy')
    } catch {
      // Ignore fallback failure
    }
    ta.remove()
    if (prevActive && typeof prevActive.focus === 'function') {
      try {
        prevActive.focus({ preventScroll: true })
      } catch {
        prevActive.focus()
      }
    }
  }
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    void Promise.resolve(navigator.clipboard.writeText(text)).catch(() => {})
  }
  if (triggerBtn) {
    const orig = triggerBtn.dataset.origLabel || triggerBtn.textContent || 'Copy'
    triggerBtn.dataset.origLabel = orig
    triggerBtn.textContent = 'Copied!'
    setTimeout(() => {
      triggerBtn.textContent = orig
    }, 1200)
  }
}
