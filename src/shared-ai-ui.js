import { getDialectLexerRules, scanBlockCommentEnd, scanBracketIdentEnd, scanQuotedSegmentEnd } from './shared-sql-core.js'
import {
  DEFAULT_EXPLAIN_SVG_PALETTE,
  buildExplainNodePopoverData,
  clampExplainViewport,
  renderExplainPlanSvg,
} from './shared-explain-svg.js'

export const AI_EXPLAIN_LANGUAGE_OPTIONS = [
  { value: 'auto', label: 'Auto (IDE locale)' },
  { value: 'vi', label: 'Tiếng Việt' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'zh', label: '中文' },
  { value: 'ko', label: '한국어' },
  { value: 'es', label: 'Español' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' },
  { value: 'pt', label: 'Português' },
]

export const AI_PRESET_OPTIONS = [
  {
    id: 'openai',
    label: 'OpenAI',
    format: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    keyKind: 'required',
    keyPlaceholder: 'sk-...',
    editableUrl: false,
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    format: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-haiku-4-5',
    keyKind: 'required',
    keyPlaceholder: 'sk-ant-...',
    editableUrl: false,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    format: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'mistralai/codestral-2508',
    keyKind: 'required',
    keyPlaceholder: 'sk-or-...',
    editableUrl: false,
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    format: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5-coder:1.5b',
    keyKind: 'none',
    keyPlaceholder: 'Optional for local Ollama',
    editableUrl: true,
  },
  {
    id: 'mistral',
    label: 'Mistral Codestral',
    format: 'mistral-fim',
    baseUrl: 'https://api.mistral.ai/v1',
    model: 'codestral-latest',
    keyKind: 'required',
    keyPlaceholder: 'Mistral API key...',
    editableUrl: false,
  },
  {
    id: 'custom-openai',
    label: 'Custom (OpenAI compatible)',
    format: 'openai',
    baseUrl: '',
    model: '',
    keyKind: 'optional',
    keyPlaceholder: 'Optional API key...',
    editableUrl: true,
  },
  {
    id: 'custom-anthropic',
    label: 'Custom (Anthropic compatible)',
    format: 'anthropic',
    baseUrl: '',
    model: '',
    keyKind: 'optional',
    keyPlaceholder: 'Optional API key...',
    editableUrl: true,
  },
]

function normUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '').toLowerCase()
}

export function resolveAiPresetId(format, baseUrl) {
  const addr = normUrl(baseUrl)
  const exact = AI_PRESET_OPTIONS.find((p) => p.baseUrl && p.format === format && normUrl(p.baseUrl) === addr)
  if (exact) return exact.id
  if (format === 'ollama') return 'ollama'
  if (format === 'mistral-fim') return 'mistral'
  return format === 'anthropic' ? 'custom-anthropic' : 'custom-openai'
}

const FIM_ONLY_MODEL_RE =
  /(?:^|[:/_-])(base|fim)(?:$|[:_-])|(?:^|\/)(?:mellum|starcoder|sweep-next-edit)|-base$/i

export function isLikelyFimOnlyModel(format, model) {
  if (format === 'mistral-fim') return true
  const trimmed = String(model || '').trim()
  if (!trimmed) return false
  return FIM_ONLY_MODEL_RE.test(trimmed)
}

const STRICT_IPV4_OCTET_RE = /^(?:0|[1-9]\d{0,2})$/
const IPV6_HEXTET_RE = /^[0-9a-f]{1,4}$/i
const LOCALHOST_HOSTNAME_RE =
  /^(?:localhost|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.localhost)$/i

function parseStrictIpv4Octets(host) {
  const parts = host.split('.')
  if (parts.length !== 4) return null
  const out = []
  for (const p of parts) {
    if (!STRICT_IPV4_OCTET_RE.test(p)) return null
    const n = Number(p)
    if (n > 255) return null
    out.push(n)
  }
  return out
}

function parseIpv6GroupSlice(groups) {
  const out = []
  for (let i = 0; i < groups.length; i += 1) {
    const g = groups[i]
    if (!g) return null
    if (g.includes('.')) {
      if (i !== groups.length - 1) return null
      const v4 = parseStrictIpv4Octets(g)
      if (!v4) return null
      out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3])
    } else {
      if (!IPV6_HEXTET_RE.test(g)) return null
      out.push(Number.parseInt(g, 16))
    }
  }
  return out
}

function parseIpv6Hextets(rawIpv6) {
  if (!rawIpv6 || rawIpv6.includes('%')) return null
  const doubleColonParts = rawIpv6.split('::')
  if (doubleColonParts.length > 2) return null
  if (doubleColonParts.length === 1) {
    const hextets = parseIpv6GroupSlice(rawIpv6.split(':'))
    return hextets && hextets.length === 8 ? hextets : null
  }
  const [leftRaw, rightRaw] = doubleColonParts
  const leftGroups = leftRaw ? leftRaw.split(':') : []
  const rightGroups = rightRaw ? rightRaw.split(':') : []
  const left = parseIpv6GroupSlice(leftGroups)
  const right = parseIpv6GroupSlice(rightGroups)
  if (!left || !right) return null
  if (leftGroups.some((g) => g.includes('.'))) return null
  const zeros = 8 - (left.length + right.length)
  if (zeros < 1) return null
  return [...left, ...new Array(zeros).fill(0), ...right]
}

export function isLoopbackHostname(rawHost) {
  const trimmed = typeof rawHost === 'string' ? rawHost.trim() : ''
  if (!trimmed || /[\s/?#@%]/.test(trimmed)) return false

  let bare = trimmed
  let expectIpv6 = false
  if (trimmed.startsWith('[')) {
    const closeIdx = trimmed.indexOf(']')
    if (closeIdx <= 1) return false
    const rest = trimmed.slice(closeIdx + 1)
    if (rest && !/^:\d+$/.test(rest)) return false
    bare = trimmed.slice(1, closeIdx)
    if (bare.includes('[') || bare.includes(']')) return false
    expectIpv6 = true
  } else {
    if (trimmed.includes('[') || trimmed.includes(']')) return false
    const firstColon = trimmed.indexOf(':')
    if (firstColon !== -1) {
      const lastColon = trimmed.lastIndexOf(':')
      if (firstColon === lastColon) {
        if (!/^\d+$/.test(trimmed.slice(firstColon + 1))) return false
        bare = trimmed.slice(0, firstColon)
      } else {
        expectIpv6 = true
      }
    }
  }

  if (expectIpv6 || bare.includes(':')) {
    const h = parseIpv6Hextets(bare)
    if (!h) return false
    if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0 && h[6] === 0 && h[7] === 1) {
      return true
    }
    return (
      h[0] === 0 &&
      h[1] === 0 &&
      h[2] === 0 &&
      h[3] === 0 &&
      h[4] === 0 &&
      h[5] === 0xffff &&
      ((h[6] >> 8) & 0xff) === 127
    )
  }

  const normalizedName = bare.endsWith('.') ? bare.slice(0, -1) : bare
  if (LOCALHOST_HOSTNAME_RE.test(normalizedName)) return true
  const v4 = parseStrictIpv4Octets(normalizedName)
  return v4 !== null && v4[0] === 127
}

function describeEndpointDestination(baseUrl, fallbackDestination, fallbackHost) {
  const raw = String(baseUrl || '').trim()
  if (raw) {
    try {
      const parsed = new URL(raw)
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        const host = parsed.host || parsed.hostname
        const destination = isLoopbackHostname(parsed.hostname) ? 'local' : 'remote'
        return {
          destination,
          host,
          label: `${destination === 'local' ? 'Local' : 'Remote'} · ${host}`,
        }
      }
    } catch {
      // Fall through to fallback snapshot metadata
    }
  }
  if (fallbackDestination === 'local') {
    const host = String(fallbackHost || 'localhost')
    return { destination: 'local', host, label: `Local · ${host}` }
  }
  if (fallbackDestination === 'remote') {
    const host = String(fallbackHost || 'external')
    return { destination: 'remote', host, label: `Remote · ${host}` }
  }
  return { destination: 'none', host: '', label: 'No endpoint' }
}

function normalizeRoleState(role) {
  if (!role || !role.enabled || role.state === 'off') return 'off'
  if (role.state === 'setup') return 'setup'
  if (role.state === 'error') return 'error'
  if (role.state === 'slow') return 'slow'
  return 'on'
}

function roleStateToTone(state) {
  if (state === 'on') return 'success'
  if (state === 'setup' || state === 'slow') return 'warn'
  if (state === 'error') return 'danger'
  return 'neutral'
}

function resolveSnapshotRole(snapshot, role) {
  const explicit = snapshot?.roles?.[role]
  if (explicit && typeof explicit === 'object') {
    return {
      enabled: Boolean(explicit.enabled),
      state: normalizeRoleState(explicit),
      reason: explicit.reason ? String(explicit.reason) : null,
      format: explicit.format || 'openai',
      baseUrl: explicit.baseUrl !== undefined && explicit.baseUrl !== null ? String(explicit.baseUrl) : '',
      host: explicit.host ? String(explicit.host) : '',
      model: explicit.model !== undefined && explicit.model !== null ? String(explicit.model) : '',
      hasKey: Boolean(explicit.hasKey),
      usingSharedKey: Boolean(explicit.usingSharedKey),
      destination: explicit.destination || 'none',
    }
  }
  if (!snapshot || typeof snapshot !== 'object') {
    return {
      enabled: false,
      state: 'off',
      reason: null,
      format: 'openai',
      baseUrl: '',
      host: '',
      model: '',
      hasKey: false,
      usingSharedKey: false,
      destination: 'none',
    }
  }
  return {
    enabled: Boolean(snapshot.enabled),
    state: normalizeRoleState(snapshot),
    reason: snapshot.reason ? String(snapshot.reason) : null,
    format: snapshot.format || 'openai',
    baseUrl: snapshot.baseUrl !== undefined && snapshot.baseUrl !== null ? String(snapshot.baseUrl) : '',
    host: snapshot.host ? String(snapshot.host) : '',
    model: snapshot.model !== undefined && snapshot.model !== null ? String(snapshot.model) : '',
    hasKey: Boolean(snapshot.hasKey),
    usingSharedKey: false,
    destination: snapshot.destination || 'none',
  }
}

function formatRoleTitleSummary(role) {
  if (role.state === 'off') return 'Off'
  const dest = describeEndpointDestination(role.baseUrl, role.destination, role.host)
  const destLabel = dest.destination === 'none' ? '' : dest.label
  const modelName = role.model ? role.model.trim() : ''
  const meta = [modelName, destLabel].filter(Boolean).join(' · ')
  if (role.state === 'setup') {
    const detail = role.reason || meta
    return detail ? `Setup (${detail})` : 'Setup'
  }
  if (role.state === 'error') {
    const detail = role.reason || meta
    return detail ? `Error (${detail})` : 'Error'
  }
  if (role.state === 'slow') {
    const detail = meta || role.reason || ''
    return detail ? `Slow (${detail})` : 'Slow'
  }
  return meta ? `Connected (${meta})` : 'Connected'
}

export function formatAiStatusBadge(snapshot) {
  const autoRole = resolveSnapshotRole(snapshot, 'autocomplete')
  const explainRole = resolveSnapshotRole(snapshot, 'explain')
  const autocompleteState = autoRole.state
  const explainState = explainRole.state
  const autocompleteTone = roleStateToTone(autocompleteState)
  const explainTone = roleStateToTone(explainState)

  if (autocompleteState === 'off' && explainState === 'off') {
    return {
      tone: 'neutral',
      label: 'AI · Off',
      title: 'Configure AI SQL Assistant (Autocomplete: Off · Explain & Fix: Off)',
      autocompleteTone,
      explainTone,
      autocompleteState,
      explainState,
    }
  }

  let tone = 'success'
  if (autocompleteState === 'error' || explainState === 'error') {
    tone = 'danger'
  } else if (
    autocompleteState === 'setup' ||
    autocompleteState === 'slow' ||
    explainState === 'setup' ||
    explainState === 'slow'
  ) {
    tone = 'warn'
  }

  const title = `Autocomplete: ${formatRoleTitleSummary(autoRole)} | Explain & Fix: ${formatRoleTitleSummary(explainRole)}`
  return {
    tone,
    label: 'Autocomplete · Explain',
    title,
    autocompleteTone,
    explainTone,
    autocompleteState,
    explainState,
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg'

function createSvgNode(tag, attrs) {
  const node =
    typeof document.createElementNS === 'function'
      ? document.createElementNS(SVG_NS, tag)
      : document.createElement(tag)
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      node.setAttribute(k, v)
    }
  }
  return node
}

function createAiRobotIcon() {
  const svg = createSvgNode('svg', {
    class: 'datanoa-ai-robot',
    width: '15',
    height: '15',
    viewBox: '0 0 16 16',
    fill: 'none',
    'aria-hidden': 'true',
    focusable: 'false',
  })
  svg.appendChild(
    createSvgNode('path', {
      d: 'M8 2V4.25',
      stroke: 'currentColor',
      'stroke-width': '1.4',
      'stroke-linecap': 'round',
    })
  )
  svg.appendChild(
    createSvgNode('circle', {
      class: 'datanoa-ai-robot-antenna',
      cx: '8',
      cy: '1.5',
      r: '1',
      fill: 'currentColor',
    })
  )
  svg.appendChild(
    createSvgNode('rect', {
      x: '2.75',
      y: '4.25',
      width: '10.5',
      height: '8.75',
      rx: '2.25',
      stroke: 'currentColor',
      'stroke-width': '1.4',
    })
  )
  svg.appendChild(
    createSvgNode('path', {
      d: 'M1.25 7.5V9.5M14.75 7.5V9.5',
      stroke: 'currentColor',
      'stroke-width': '1.4',
      'stroke-linecap': 'round',
    })
  )
  svg.appendChild(
    createSvgNode('circle', {
      class: 'datanoa-ai-robot-eye',
      cx: '5.9',
      cy: '8.1',
      r: '1',
      fill: 'currentColor',
    })
  )
  svg.appendChild(
    createSvgNode('circle', {
      class: 'datanoa-ai-robot-eye',
      cx: '10.1',
      cy: '8.1',
      r: '1',
      fill: 'currentColor',
    })
  )
  svg.appendChild(
    createSvgNode('path', {
      d: 'M6 10.75H10',
      stroke: 'currentColor',
      'stroke-width': '1.35',
      'stroke-linecap': 'round',
    })
  )
  return svg
}

export function renderAiStatusButtonContent(buttonEl, snapshot) {
  const badge = formatAiStatusBadge(snapshot)
  if (!buttonEl) return badge
  clearNode(buttonEl)
  buttonEl.appendChild(createAiRobotIcon())

  if (badge.autocompleteState === 'off' && badge.explainState === 'off') {
    const item = el('span', 'datanoa-ai-role-item')
    const dot = el('span', 'datanoa-ai-dot tone-neutral')
    dot.setAttribute('aria-hidden', 'true')
    item.appendChild(dot)
    item.appendChild(el('span', 'datanoa-ai-label', badge.label))
    buttonEl.appendChild(item)
  } else {
    const autoItem = el('span', 'datanoa-ai-role-item is-autocomplete')
    if (autoItem.dataset) autoItem.dataset.state = badge.autocompleteState
    autoItem.setAttribute('data-state', badge.autocompleteState)
    const autoDot = el('span', `datanoa-ai-dot tone-${badge.autocompleteTone}`)
    autoDot.setAttribute('aria-hidden', 'true')
    const autoText = el('span', 'datanoa-ai-role-text')
    autoText.appendChild(el('span', 'datanoa-ai-role-full', 'Autocomplete'))
    autoText.appendChild(el('span', 'datanoa-ai-role-short', 'Auto'))
    autoItem.appendChild(autoDot)
    autoItem.appendChild(autoText)

    const sep = el('span', 'datanoa-ai-role-sep', '·')
    sep.setAttribute('aria-hidden', 'true')

    const explainItem = el('span', 'datanoa-ai-role-item is-explain')
    if (explainItem.dataset) explainItem.dataset.state = badge.explainState
    explainItem.setAttribute('data-state', badge.explainState)
    const explainDot = el('span', `datanoa-ai-dot tone-${badge.explainTone}`)
    explainDot.setAttribute('aria-hidden', 'true')
    const explainText = el('span', 'datanoa-ai-role-text', 'Explain')
    explainItem.appendChild(explainDot)
    explainItem.appendChild(explainText)

    buttonEl.appendChild(autoItem)
    buttonEl.appendChild(sep)
    buttonEl.appendChild(explainItem)
  }

  if (buttonEl.dataset) {
    buttonEl.dataset.autoState = badge.autocompleteState
    buttonEl.dataset.explainState = badge.explainState
  }
  buttonEl.setAttribute('data-auto-state', badge.autocompleteState)
  buttonEl.setAttribute('data-explain-state', badge.explainState)
  buttonEl.title = badge.title
  buttonEl.setAttribute('aria-label', badge.title)
  return badge
}

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined && text !== null) node.textContent = String(text)
  return node
}

const AI_LOADING_CLEANUPS = new WeakMap()

function runLoadingCleanupsDeep(node) {
  if (!node) return
  const cleanup = AI_LOADING_CLEANUPS.get(node)
  if (typeof cleanup === 'function') {
    try {
      cleanup()
    } catch {
      // Ignore teardown timer cleanup errors
    }
    AI_LOADING_CLEANUPS.delete(node)
  }
  const children = node.childNodes && node.childNodes.length > 0 ? node.childNodes : node.children
  if (children && children.length > 0) {
    for (let i = 0; i < children.length; i += 1) {
      runLoadingCleanupsDeep(children[i])
    }
  }
}

function clearNode(node) {
  while (node.firstChild) {
    const child = node.firstChild
    runLoadingCleanupsDeep(child)
    node.removeChild(child)
  }
}

const SQL_HIGHLIGHT_KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'AS', 'ON',
  'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'NATURAL', 'USING',
  'GROUP', 'BY', 'HAVING', 'ORDER', 'ASC', 'DESC', 'NULLS', 'FIRST', 'LAST',
  'LIMIT', 'OFFSET', 'FETCH', 'NEXT', 'ROW', 'ROWS', 'ONLY', 'TOP', 'PERCENT',
  'DISTINCT', 'ALL', 'UNION', 'INTERSECT', 'EXCEPT', 'MINUS',
  'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'MERGE', 'MATCHED',
  'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME', 'TABLE', 'INDEX', 'UNIQUE',
  'VIEW', 'MATERIALIZED', 'DATABASE', 'SCHEMA', 'TRIGGER', 'PROCEDURE', 'FUNCTION',
  'IF', 'EXISTS', 'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES', 'CHECK', 'DEFAULT',
  'CONSTRAINT', 'CASCADE', 'RESTRICT', 'WITH', 'RECURSIVE', 'CASE', 'WHEN',
  'THEN', 'ELSE', 'END', 'CAST', 'BETWEEN', 'LIKE', 'ILIKE', 'GLOB', 'REGEXP',
  'SIMILAR', 'TO', 'ESCAPE', 'OVER', 'PARTITION', 'WINDOW', 'RANGE', 'UNBOUNDED',
  'PRECEDING', 'FOLLOWING', 'CURRENT', 'RETURNING', 'CONFLICT', 'DO', 'NOTHING',
  'REPLACE', 'EXPLAIN', 'ANALYZE', 'QUERY', 'PLAN', 'PRAGMA', 'BEGIN', 'COMMIT',
  'ROLLBACK', 'TRANSACTION', 'SAVEPOINT', 'TRUE', 'FALSE', 'UNKNOWN',
  'AUTOINCREMENT', 'AUTO_INCREMENT', 'GENERATED', 'ALWAYS', 'STORED', 'VIRTUAL',
  'TEMP', 'TEMPORARY', 'SHOW', 'DESCRIBE', 'USE', 'COLLATE', 'COMMENT', 'ENGINE',
])

const SQL_HIGHLIGHT_TYPES = new Set([
  'INT', 'INTEGER', 'BIGINT', 'SMALLINT', 'TINYINT', 'MEDIUMINT', 'INT2', 'INT4', 'INT8',
  'INT64', 'UINT64', 'REAL', 'FLOAT', 'FLOAT4', 'FLOAT8', 'FLOAT64', 'DOUBLE',
  'PRECISION', 'NUMERIC', 'DECIMAL', 'NUMBER', 'BOOLEAN', 'BOOL', 'BIT',
  'CHAR', 'CHARACTER', 'VARYING', 'VARCHAR', 'NVARCHAR', 'NCHAR', 'VARCHAR2',
  'TEXT', 'CLOB', 'BLOB', 'BYTEA', 'BINARY', 'VARBINARY', 'BYTES',
  'DATE', 'TIME', 'DATETIME', 'DATETIME2', 'TIMESTAMP', 'TIMESTAMPTZ', 'INTERVAL',
  'JSON', 'JSONB', 'UUID', 'XML', 'SERIAL', 'BIGSERIAL', 'SMALLSERIAL',
  'MONEY', 'INET', 'CIDR', 'MACADDR', 'ARRAY', 'OBJECT', 'VARIANT', 'STRING',
])

const SQL_HIGHLIGHT_FUNCTIONS = new Set([
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'TOTAL', 'COALESCE', 'NULLIF', 'IFNULL',
  'NVL', 'IIF', 'LOWER', 'UPPER', 'TRIM', 'LTRIM', 'RTRIM', 'SUBSTR', 'SUBSTRING',
  'LENGTH', 'CHAR_LENGTH', 'CHARACTER_LENGTH', 'LEN', 'CONCAT', 'CONCAT_WS',
  'SPLIT_PART', 'ROUND', 'FLOOR', 'CEIL', 'CEILING', 'ABS', 'MOD', 'POWER', 'SQRT',
  'NOW', 'CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME', 'DATE_TRUNC',
  'DATE_PART', 'EXTRACT', 'STRFTIME', 'TO_CHAR', 'TO_DATE', 'TO_TIMESTAMP',
  'JSON_EXTRACT', 'JSON_VALUE', 'JSON_QUERY', 'JSON_OBJECT', 'JSON_ARRAY',
  'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'LAG', 'LEAD', 'FIRST_VALUE', 'LAST_VALUE',
  'ARRAY_AGG', 'STRING_AGG', 'GROUP_CONCAT', 'GREATEST', 'LEAST',
])

const MONGO_HIGHLIGHT_KEYWORDS = new Set([
  'db', 'true', 'false', 'null', 'undefined', 'new', 'ObjectId', 'ISODate',
  'NumberLong', 'NumberDecimal', 'UUID', 'Timestamp',
])

function createTextOrSpan(text) {
  return typeof document.createTextNode === 'function'
    ? document.createTextNode(text)
    : el('span', '', text)
}

function formatExplainDuration(durationMs) {
  const ms = Math.max(0, Math.round(Number(durationMs) || 0))
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
}

function formatExplainMetaBadge(durationMs, language) {
  const dur = formatExplainDuration(durationMs)
  const raw = String(language || 'auto').trim()
  let langLabel = 'AUTO'
  if (/^[a-z]{2,4}$/i.test(raw)) {
    langLabel = raw.toUpperCase()
  } else {
    const parenMatch = /^\S[^(]*\(([^)]+)\)\s*$/.exec(raw)
    langLabel = parenMatch ? parenMatch[1].trim() : raw || 'AUTO'
  }
  return `${dur} · ${langLabel}`
}

function createAiLoadingNode(text, extraClass = '') {
  const message = String(text ?? '')
  const isCompact = extraClass.includes('is-compact')

  const box = document.createElement('div')
  box.className = extraClass ? `datanoa-ai-loading-box ${extraClass}` : 'datanoa-ai-loading-box'

  const row = document.createElement('div')
  row.className = 'datanoa-ai-loading-row'

  const wrap = document.createElement('div')
  wrap.className = extraClass ? `datanoa-ai-loading ${extraClass}` : 'datanoa-ai-loading'
  wrap.setAttribute('role', 'status')
  wrap.setAttribute('aria-live', 'polite')
  wrap.setAttribute('aria-label', message)

  // Geometric robot head activity icon instead of generic circular spinner
  wrap.appendChild(createAiRobotIcon())

  const textWrap = document.createElement('span')
  textWrap.className = 'datanoa-ai-loading-text'
  textWrap.setAttribute('aria-hidden', 'true')
  let charIndex = 0
  for (const ch of message) {
    if (/\s/.test(ch)) {
      textWrap.appendChild(createTextOrSpan(ch))
      continue
    }
    const span = document.createElement('span')
    span.className = 'datanoa-ai-loading-char'
    span.style.setProperty('--datanoa-char-delay', `${charIndex * 22}ms`)
    span.textContent = ch
    textWrap.appendChild(span)
    charIndex += 1
  }
  const totalCycleMs = Math.max(1350, charIndex * 22 + 480)
  textWrap.style.setProperty('--datanoa-wave-duration', `${totalCycleMs}ms`)
  wrap.appendChild(textWrap)
  row.appendChild(wrap)

  const elapsedEl = document.createElement('span')
  elapsedEl.className = 'datanoa-ai-loading-elapsed'
  elapsedEl.setAttribute('aria-hidden', 'true')
  elapsedEl.textContent = '0.0s'
  row.appendChild(elapsedEl)

  box.appendChild(row)

  if (!isCompact) {
    const track = document.createElement('div')
    track.className = 'datanoa-ai-progress-track'
    track.setAttribute('aria-hidden', 'true')
    const progressBar = document.createElement('span')
    progressBar.className = 'datanoa-ai-progress-bar'
    track.appendChild(progressBar)
    box.appendChild(track)
  }

  if (typeof setInterval === 'function') {
    const startedAt = Date.now()
    const timer = setInterval(() => {
      if (!box.parentNode || box.isConnected === false) {
        clearInterval(timer)
        AI_LOADING_CLEANUPS.delete(box)
        return
      }
      const sec = Math.max(0, (Date.now() - startedAt) / 1000)
      elapsedEl.textContent = `${sec.toFixed(1)}s`
    }, 200)
    if (typeof timer === 'object' && timer !== null && typeof timer.unref === 'function') {
      timer.unref()
    }
    AI_LOADING_CLEANUPS.set(box, () => clearInterval(timer))
  }

  return box
}

function scanQuotedSegment(text, start, quoteChar, allowBackslashEscape) {
  const len = text.length
  let i = start + 1
  while (i < len) {
    const c = text[i]
    if (allowBackslashEscape && c === '\\' && i + 1 < len) {
      i += 2
      continue
    }
    if (c === quoteChar) {
      if (text[i + 1] === quoteChar) {
        i += 2
        continue
      }
      return i + 1
    }
    i += 1
  }
  return len
}

function scanDollarQuotedEnd(text, start) {
  const match = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(start))
  if (!match) return -1
  const tag = match[0]
  const closeIdx = text.indexOf(tag, start + tag.length)
  return closeIdx >= 0 ? closeIdx + tag.length : text.length
}

function scanOracleQuoteLiteralEnd(text, start) {
  if (start + 3 >= text.length) return -1
  const openDelim = text[start + 2]
  if (/\s/.test(openDelim)) return -1
  const pairedClose =
    openDelim === '['
      ? ']'
      : openDelim === '('
        ? ')'
        : openDelim === '{'
          ? '}'
          : openDelim === '<'
            ? '>'
            : openDelim
  const closeIdx = text.indexOf(`${pairedClose}'`, start + 3)
  return closeIdx >= 0 ? closeIdx + 2 : text.length
}

function renderHighlightedSqlCode(preEl, sqlText, dialect) {
  const text = String(sqlText ?? '')
  clearNode(preEl)
  if (!text) return

  const d = String(dialect || 'sqlite').toLowerCase()
  const isMongo = d === 'mongodb' || d === 'mongo'
  const isRedis = d === 'redis'
  const isMysql = d === 'mysql' || d === 'mariadb'
  const isMssql = d === 'mssql' || d === 'sqlserver'

  let plainBuf = ''
  const flushPlain = () => {
    if (!plainBuf) return
    preEl.appendChild(document.createTextNode(plainBuf))
    plainBuf = ''
  }
  const emitToken = (cls, slice) => {
    flushPlain()
    const span = document.createElement('span')
    span.className = cls
    span.textContent = slice
    preEl.appendChild(span)
  }

  let i = 0
  const len = text.length
  let lineStart = true

  while (i < len) {
    const ch = text[i]

    if (ch === '\n' || ch === '\r') {
      plainBuf += ch
      i += 1
      lineStart = true
      continue
    }

    if (/\s/.test(ch)) {
      plainBuf += ch
      i += 1
      continue
    }

    // Comments
    const rules = getDialectLexerRules(d)
    if (
      (rules.lineCommentDash && text.startsWith('--', i)) ||
      (rules.lineCommentSlash && text.startsWith('//', i)) ||
      (rules.lineCommentHash && ch === '#')
    ) {
      const nl = text.indexOf('\n', i)
      const end = nl >= 0 ? nl : len
      emitToken('datanoa-sql-cmt', text.slice(i, end))
      i = end
      lineStart = false
      continue
    }

    if (text.startsWith('/*', i)) {
      const end = scanBlockCommentEnd(text, i, rules.nestedBlockComments)
      emitToken('datanoa-sql-cmt', text.slice(i, end))
      i = end
      lineStart = false
      continue
    }

    // Dollar-quoted strings (PostgreSQL, DuckDB, etc.)
    if (rules.dollarQuoting && ch === '$') {
      const dqEnd = scanDollarQuotedEnd(text, i)
      if (dqEnd > i) {
        emitToken('datanoa-sql-str', text.slice(i, dqEnd))
        i = dqEnd
        lineStart = false
        continue
      }
    }

    // Oracle alternate quote literals q'[...]' / q'(...)' / q'!...!'
    if (rules.oracleQQuote && (ch === 'q' || ch === 'Q') && text[i + 1] === '\'') {
      const qEnd = scanOracleQuoteLiteralEnd(text, i)
      if (qEnd > i) {
        emitToken('datanoa-sql-str', text.slice(i, qEnd))
        i = qEnd
        lineStart = false
        continue
      }
    }

    // Prefixed or standard single-quoted string
    if (
      ch === '\'' ||
      (!isRedis &&
        (ch === 'e' || ch === 'E' || ch === 'n' || ch === 'N' || ch === 'b' || ch === 'B' || ch === 'x' || ch === 'X') &&
        text[i + 1] === '\'')
    ) {
      const quoteStart = ch === '\'' ? i : i + 1
      const isPgEscape = rules.postgresEscapeString && (ch === 'e' || ch === 'E') && quoteStart > i
      const allowBackslashInSingleQuote =
        rules.backslashEscapesSingleQuote || d === 'bigquery' || isPgEscape
      const end = scanQuotedSegmentEnd(text, quoteStart, '\'', allowBackslashInSingleQuote).end
      emitToken('datanoa-sql-str', text.slice(i, end))
      i = end
      lineStart = false
      continue
    }

    // Double quotes: strings in MongoDB/Redis, identifiers in SQL
    if (ch === '"') {
      const end = scanQuotedSegmentEnd(text, i, '"', rules.backslashEscapesDoubleQuote || isMongo || isRedis).end
      emitToken(isMongo || isRedis ? 'datanoa-sql-str' : 'datanoa-sql-ident', text.slice(i, end))
      i = end
      lineStart = false
      continue
    }

    // Backtick identifiers
    if (!isMongo && ch === '`') {
      const end = scanQuotedSegmentEnd(text, i, '`', false).end
      emitToken('datanoa-sql-ident', text.slice(i, end))
      i = end
      lineStart = false
      continue
    }

    // MSSQL / SQLite [bracketed] identifiers
    if ((isMssql || rules.bracketIdentifiers !== 'none') && ch === '[') {
      const br = scanBracketIdentEnd(text, i, isMssql || rules.bracketIdentifiers === 'doubling')
      if (br.closed && !text.slice(i, br.end).includes('\n')) {
        emitToken('datanoa-sql-ident', text.slice(i, br.end))
        i = br.end
        lineStart = false
        continue
      }
    }

    // MongoDB $stage / $operator
    if (isMongo && ch === '$' && /[A-Za-z0-9_]/.test(text[i + 1] || '')) {
      let end = i + 2
      while (end < len && /[A-Za-z0-9_]/.test(text[end])) end += 1
      emitToken('datanoa-sql-kw', text.slice(i, end))
      i = end
      lineStart = false
      continue
    }

    // Numbers
    if (
      (i === 0 || (!/[A-Za-z0-9_$]/.test(text[i - 1]) && !(isRedis && text[i - 1] === ':'))) &&
      (/\d/.test(ch) || (ch === '.' && /\d/.test(text[i + 1] || '')))
    ) {
      const numMatch = /^(?:0[xX][0-9a-fA-F]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/.exec(text.slice(i))
      if (numMatch) {
        emitToken('datanoa-sql-num', numMatch[0])
        i += numMatch[0].length
        lineStart = false
        continue
      }
    }

    // Words: keywords, types, functions, Redis commands
    if (/[A-Za-z_]/.test(ch)) {
      let end = i + 1
      while (end < len && /[A-Za-z0-9_$]/.test(text[end])) end += 1
      const word = text.slice(i, end)
      let j = end
      while (j < len && /[ \t\r\n]/.test(text[j])) j += 1
      const followedByParen = text[j] === '('
      const precededByDot = i > 0 && text[i - 1] === '.'

      if (isRedis) {
        if (lineStart) {
          emitToken('datanoa-sql-kw', word)
        } else {
          plainBuf += word
        }
      } else if (isMongo) {
        if (!precededByDot && MONGO_HIGHLIGHT_KEYWORDS.has(word)) {
          emitToken('datanoa-sql-kw', word)
        } else if (followedByParen) {
          emitToken('datanoa-sql-fn', word)
        } else {
          plainBuf += word
        }
      } else if (precededByDot) {
        if (followedByParen) {
          emitToken('datanoa-sql-fn', word)
        } else {
          plainBuf += word
        }
      } else {
        const upper = word.toUpperCase()
        if (SQL_HIGHLIGHT_KEYWORDS.has(upper)) {
          emitToken('datanoa-sql-kw', word)
        } else if (SQL_HIGHLIGHT_TYPES.has(upper)) {
          emitToken('datanoa-sql-type', word)
        } else if (SQL_HIGHLIGHT_FUNCTIONS.has(upper) || followedByParen) {
          emitToken('datanoa-sql-fn', word)
        } else {
          plainBuf += word
        }
      }
      i = end
      lineStart = false
      continue
    }

    // Operators
    if (/[=<>!+\-*/%&|^~:?]/.test(ch)) {
      let end = i + 1
      while (end < len && /[=<>!+\-*/%&|^~:?]/.test(text[end])) {
        if (text.startsWith('--', end) || text.startsWith('/*', end) || (isMongo && text.startsWith('//', end))) {
          break
        }
        end += 1
      }
      emitToken('datanoa-sql-op', text.slice(i, end))
      i = end
      lineStart = false
      continue
    }

    plainBuf += ch
    i += 1
    lineStart = false
  }

  flushPlain()
}

function createHighlightedSqlPre(sqlText, dialect) {
  const pre = document.createElement('pre')
  pre.className = 'datanoa-ai-code'
  renderHighlightedSqlCode(pre, sqlText, dialect)
  return pre
}

function populateLanguageSelect(select, selected) {
  clearNode(select)
  for (const opt of AI_EXPLAIN_LANGUAGE_OPTIONS) {
    const o = el('option', '', opt.label)
    o.value = opt.value
    o.selected = opt.value === selected
    select.appendChild(o)
  }
  select.value = selected || 'auto'
}

const AI_PANEL_MIN_HEIGHT = 110
const activeAiPanelResizeCleanups = new WeakMap()

function cleanupAiPanelResize(container) {
  if (!container) return
  const stop = activeAiPanelResizeCleanups.get(container)
  if (typeof stop === 'function') {
    stop()
  }
}

export function resolveExplainAiPhase(isLoading, error, analysis) {
  if (isLoading) return 'loading'
  if (error) return 'error'
  if (analysis) return 'ready'
  return 'idle'
}

export function getAiPanelMaxHeight(container, edge = 'bottom') {
  const vh =
    typeof window !== 'undefined' && Number.isFinite(window.innerHeight) && window.innerHeight > 0
      ? window.innerHeight
      : 800
  const windowMax = Math.max(280, Math.floor(vh * 0.72))
  const parentEl = container?.parentElement
  const parentRect =
    parentEl && typeof parentEl.getBoundingClientRect === 'function'
      ? parentEl.getBoundingClientRect()
      : null
  if (!parentRect || !Number.isFinite(parentRect.height) || parentRect.height <= 180) {
    return windowMax
  }
  const selfRect =
    typeof container?.getBoundingClientRect === 'function'
      ? container.getBoundingClientRect()
      : null
  if (!selfRect || !Number.isFinite(selfRect.height) || selfRect.height < 0) {
    return windowMax
  }
  const normalizedEdge = edge === 'top' ? 'top' : 'bottom'
  const available =
    normalizedEdge === 'top'
      ? Math.floor(selfRect.bottom - parentRect.top - 8)
      : Math.floor(parentRect.bottom - selfRect.top - 8)
  if (!Number.isFinite(available)) {
    return windowMax
  }
  return Math.max(AI_PANEL_MIN_HEIGHT, Math.min(windowMax, available))
}

function clampAiPanelHeight(px, container, edge, cachedMaxH = null) {
  const maxH = cachedMaxH !== null ? cachedMaxH : getAiPanelMaxHeight(container, edge)
  return Math.max(AI_PANEL_MIN_HEIGHT, Math.min(maxH, Math.round(px)))
}

function clearContainerHeightStyle(container) {
  if (container.style) {
    container.style.height = ''
    container.style.maxHeight = ''
  }
}

function applyContainerUserHeight(container, px, edge, persistDataset = true, cachedMaxH = null) {
  const clamped = clampAiPanelHeight(px, container, edge, cachedMaxH)
  if (container.style) {
    container.style.height = `${clamped}px`
    container.style.maxHeight = 'none'
  }
  if (persistDataset && container.dataset) {
    container.dataset.userHeight = String(clamped)
  }
  return clamped
}

function restoreSavedContainerHeight(container, edge) {
  const raw = container.dataset?.userHeight
  const parsed = raw !== undefined && raw !== '' ? Number(raw) : Number.NaN
  if (Number.isFinite(parsed) && parsed > 0) {
    const selfRect =
      typeof container.getBoundingClientRect === 'function' ? container.getBoundingClientRect() : null
    const isMeasured = Boolean(selfRect && Number.isFinite(selfRect.height) && selfRect.height > 0)
    return applyContainerUserHeight(container, parsed, edge, isMeasured)
  }
  clearContainerHeightStyle(container)
  return null
}

function getCurrentContainerHeight(container) {
  const rectH = container.getBoundingClientRect?.().height
  if (Number.isFinite(rectH) && rectH > 0) return Math.round(rectH)
  const offsetH = Number(container.offsetHeight)
  if (Number.isFinite(offsetH) && offsetH > 0) return Math.round(offsetH)
  const styleH = Number.parseFloat(container.style?.height || '')
  if (Number.isFinite(styleH) && styleH > 0) return Math.round(styleH)
  const saved = Number(container.dataset?.userHeight)
  if (Number.isFinite(saved) && saved > 0) return Math.round(saved)
  return 200
}

function createAiPanelResizer(container, edge, onResize) {
  const normalizedEdge = edge === 'bottom' ? 'bottom' : 'top'
  const resizer = el('div', `datanoa-ai-resizer is-${normalizedEdge}`)
  resizer.setAttribute('role', 'separator')
  resizer.setAttribute('aria-orientation', 'horizontal')
  resizer.setAttribute('aria-label', 'Resize AI result panel vertically')
  resizer.setAttribute('aria-valuemin', String(AI_PANEL_MIN_HEIGHT))
  resizer.setAttribute('aria-valuemax', String(getAiPanelMaxHeight(container, normalizedEdge)))
  if (container.dataset?.userHeight) {
    resizer.setAttribute('aria-valuenow', container.dataset.userHeight)
  }
  resizer.tabIndex = 0
  resizer.title = 'Drag to resize vertically (double-click to reset)'

  const grip = el('span', 'datanoa-ai-resizer-grip')
  grip.setAttribute('aria-hidden', 'true')
  resizer.appendChild(grip)

  const setHeight = (nextPx, { cachedMaxH = null, notifyResize = true } = {}) => {
    const resolvedMaxH =
      cachedMaxH !== null ? cachedMaxH : getAiPanelMaxHeight(container, normalizedEdge)
    const clamped = applyContainerUserHeight(container, nextPx, normalizedEdge, true, resolvedMaxH)
    resizer.setAttribute('aria-valuemax', String(resolvedMaxH))
    resizer.setAttribute('aria-valuenow', String(clamped))
    if (notifyResize) {
      onResize?.()
    }
    return clamped
  }

  const resetHeight = () => {
    if (container.dataset) {
      delete container.dataset.userHeight
    }
    clearContainerHeightStyle(container)
    resizer.removeAttribute?.('aria-valuenow')
    onResize?.()
  }

  resizer.addEventListener('mousedown', (ev) => {
    if (ev.button !== undefined && ev.button !== 0) return
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
    ev.preventDefault?.()
    cleanupAiPanelResize(container)
    const startY = Number(ev.clientY) || 0
    const parentEl = container.parentElement
    const cachedMaxH = getAiPanelMaxHeight(container, normalizedEdge)
    const startHeight = getCurrentContainerHeight(container)
    let pendingHeight = clampAiPanelHeight(startHeight, container, normalizedEdge, cachedMaxH)
    let lastAppliedHeight = pendingHeight
    let hasMoved = false
    let didResize = false
    let rafId = null
    let rafPending = false

    resizer.setAttribute('aria-valuemax', String(cachedMaxH))
    resizer.classList?.add?.('is-resizing')
    parentEl?.classList?.add?.('datanoa-split-resizing', 'is-split-resizing')
    if (document.body?.style) {
      document.body.style.cursor = 'row-resize'
      document.body.style.userSelect = 'none'
    }

    const flushPendingHeight = (notifyResize) => {
      rafPending = false
      rafId = null
      if (!container.parentNode || container.isConnected === false) return
      if (pendingHeight === lastAppliedHeight) return
      lastAppliedHeight = pendingHeight
      didResize = true
      setHeight(pendingHeight, { cachedMaxH, notifyResize })
    }

    const onMove = (moveEv) => {
      if (!container.parentNode || container.isConnected === false || container.hidden) {
        stopDrag(false)
        return
      }
      if (moveEv.isTrusted && moveEv.buttons === 0) {
        stopDrag(true)
        return
      }
      const curY = Number(moveEv.clientY) || 0
      const delta = normalizedEdge === 'top' ? startY - curY : curY - startY
      const nextH = clampAiPanelHeight(startHeight + delta, container, normalizedEdge, cachedMaxH)
      if (nextH === pendingHeight) return
      hasMoved = true
      pendingHeight = nextH
      if (typeof requestAnimationFrame === 'function') {
        if (!rafPending) {
          rafPending = true
          const id = requestAnimationFrame(() =>
            flushPendingHeight(typeof ResizeObserver !== 'function')
          )
          rafId = rafPending ? id : null
        }
      } else {
        flushPendingHeight(true)
      }
    }

    const stopDrag = (shouldFlush = true) => {
      rafPending = false
      if (rafId !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(rafId)
        rafId = null
      }
      if (shouldFlush && hasMoved && pendingHeight !== lastAppliedHeight) {
        flushPendingHeight(false)
      }
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onEnd)
      window.removeEventListener('blur', onEnd)
      resizer.classList?.remove?.('is-resizing')
      parentEl?.classList?.remove?.('datanoa-split-resizing', 'is-split-resizing')
      if (document.body?.style) {
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
      if (activeAiPanelResizeCleanups.get(container) === cancelDrag) {
        activeAiPanelResizeCleanups.delete(container)
      }
      if (shouldFlush && didResize) {
        onResize?.()
      }
    }

    const onEnd = () => stopDrag(true)
    const cancelDrag = () => stopDrag(false)

    activeAiPanelResizeCleanups.set(container, cancelDrag)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onEnd)
    window.addEventListener('blur', onEnd)
  })

  resizer.addEventListener('dblclick', () => {
    resetHeight()
  })

  resizer.addEventListener('keydown', (ev) => {
    const currentH = getCurrentContainerHeight(container)
    const step = 24
    if (ev.key === 'ArrowUp') {
      ev.preventDefault?.()
      setHeight(normalizedEdge === 'top' ? currentH + step : currentH - step)
    } else if (ev.key === 'ArrowDown') {
      ev.preventDefault?.()
      setHeight(normalizedEdge === 'top' ? currentH - step : currentH + step)
    } else if (ev.key === 'Home') {
      ev.preventDefault?.()
      setHeight(AI_PANEL_MIN_HEIGHT)
    } else if (ev.key === 'End') {
      ev.preventDefault?.()
      setHeight(getAiPanelMaxHeight(container, normalizedEdge))
    } else if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault?.()
      resetHeight()
    }
  })

  return resizer
}

const explainPanelCallbacksMap = new WeakMap()
const explainPanelViewStateMap = new WeakMap()
const explainViewportCleanupMap = new WeakMap()
const fixPanelCallbacksMap = new WeakMap()
const fixPanelViewStateMap = new WeakMap()

const EXPLAIN_VISUAL_STYLE_ID = 'datanoa-shared-explain-visual-styles'

function ensureExplainVisualStyles() {
  if (typeof document === 'undefined' || !document.head) return
  if (typeof document.getElementById === 'function' && document.getElementById(EXPLAIN_VISUAL_STYLE_ID)) {
    return
  }
  const style = document.createElement('style')
  style.id = EXPLAIN_VISUAL_STYLE_ID
  style.textContent = `
.datanoa-ai-prod-pill[data-color-tag='prod'] {
  color: var(--danger, var(--orca-destructive, #f87171));
  border-color: color-mix(in srgb, var(--danger, var(--orca-destructive, #f87171)) 48%, var(--border, rgba(148, 163, 184, 0.25)));
  background: color-mix(in srgb, var(--danger, var(--orca-destructive, #f87171)) 12%, transparent);
  font-weight: 700;
  letter-spacing: 0.03em;
}
.datanoa-ai-policy-pill[data-policy='never'] {
  color: var(--danger, var(--orca-destructive, #f87171));
  border-color: color-mix(in srgb, var(--danger, var(--orca-destructive, #f87171)) 42%, var(--border, rgba(148, 163, 184, 0.25)));
  background: color-mix(in srgb, var(--danger, var(--orca-destructive, #f87171)) 10%, transparent);
}
.datanoa-ai-policy-pill[data-policy='ask'] {
  color: var(--warn, #fbbf24);
  border-color: color-mix(in srgb, var(--warn, #fbbf24) 42%, var(--border, rgba(148, 163, 184, 0.25)));
  background: color-mix(in srgb, var(--warn, #fbbf24) 10%, transparent);
}
.datanoa-ai-confirm-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border, var(--orca-border, rgba(148, 163, 184, 0.2)));
  background: color-mix(in srgb, var(--warn, #fbbf24) 9%, var(--surface, var(--card, #14181f)));
  font-size: 12px;
  color: var(--text, var(--t1, var(--fg, #e6e6e6)));
}
.datanoa-ai-confirm-text {
  flex: 1 1 240px;
  min-width: 0;
  line-height: 1.4;
}
.datanoa-explain-view-switcher {
  display: inline-flex;
  align-items: center;
  padding: 2px;
  border-radius: var(--radius-control, 6px);
  border: 1px solid var(--border, var(--orca-border, rgba(148, 163, 184, 0.2)));
  background: var(--card, color-mix(in srgb, var(--text, var(--t1, #e6e6e6)) 4%, var(--bg, #000000)));
  gap: 2px;
}
.datanoa-explain-view-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 8px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--muted, var(--t2, #94a3b8));
  font: inherit;
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 140ms cubic-bezier(0.22, 1, 0.36, 1), color 140ms cubic-bezier(0.22, 1, 0.36, 1), border-color 140ms cubic-bezier(0.22, 1, 0.36, 1);
}
.datanoa-explain-view-tab:hover:not([aria-selected='true']) {
  color: var(--text, var(--t1, var(--fg, #e6e6e6)));
  background: var(--hover, color-mix(in srgb, var(--text, var(--t1, #e6e6e6)) 6%, transparent));
}
.datanoa-explain-view-tab[aria-selected='true'] {
  background: var(--raised, color-mix(in srgb, var(--text, var(--t1, #e6e6e6)) 10%, var(--bg, #000000)));
  border-color: var(--border-hi, var(--border, rgba(148, 163, 184, 0.25)));
  color: var(--text, var(--t1, var(--fg, #e6e6e6)));
  font-weight: 500;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);
}
.datanoa-explain-view-tab:focus-visible {
  outline: 1.5px solid var(--accent-ring, var(--orca-ring, #38bdf8));
  outline-offset: -1px;
}
.datanoa-explain-tab-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  flex-shrink: 0;
  background: var(--muted, var(--t2, #94a3b8));
}
.datanoa-explain-tab-dot[data-tone='ok'] {
  background: var(--ok, #4cc38a);
}
.datanoa-explain-tab-dot[data-tone='info'] {
  background: var(--info, #38bdf8);
  animation: datanoa-ai-robot-pulse 1100ms cubic-bezier(0.22, 1, 0.36, 1) infinite;
}
.datanoa-explain-tab-dot[data-tone='danger'] {
  background: var(--danger, var(--orca-destructive, #e5484d));
}
.datanoa-explain-collapse-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 8px;
  color: var(--muted, var(--t2, #94a3b8));
}
.datanoa-explain-collapse-btn:hover {
  color: var(--text, var(--t1, var(--fg, #e6e6e6)));
}
.datanoa-explain-collapse-chevron {
  display: block;
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  transition: transform 160ms cubic-bezier(0.22, 1, 0.36, 1);
}
.datanoa-explain-collapse-btn[aria-expanded='false'] .datanoa-explain-collapse-chevron {
  transform: rotate(-90deg);
}
.datanoa-explain-visual-wrap,
.datanoa-explain-raw-wrap {
  display: flex;
  flex-direction: column;
  gap: 8px;
  position: relative;
  flex-shrink: 0;
  padding-bottom: 4px;
}
.datanoa-explain-frame {
  border: 1px solid var(--border, var(--orca-border, rgba(148, 163, 184, 0.2)));
  border-radius: var(--radius, 8px);
  background: var(--bg, var(--orca-background, #0d1117));
  overflow: hidden;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
}
.datanoa-explain-popover-slot {
  flex-shrink: 0;
}
.datanoa-explain-summary-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
  min-height: 32px;
  padding: 4px 12px;
  border-bottom: 1px solid var(--border, var(--orca-border, rgba(148, 163, 184, 0.16)));
  background: var(--surface, var(--card, color-mix(in srgb, var(--text, var(--t1, #e6e6e6)) 4%, var(--bg, #000000))));
  font-size: 11px;
}
.datanoa-explain-summary-pills {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-family: var(--mono-font, var(--mono, ui-monospace, monospace));
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--muted, var(--t2, #94a3b8));
}
.datanoa-explain-meta-item {
  white-space: nowrap;
}
.datanoa-explain-meta-sep {
  opacity: 0.45;
  user-select: none;
}
.datanoa-explain-meta-warn {
  color: var(--warn, #fbbf24);
  font-weight: 500;
}
.datanoa-explain-summary-actions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}
.datanoa-explain-zoom-group {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--border, var(--orca-border, rgba(148, 163, 184, 0.2)));
  border-radius: var(--radius-control, 6px);
  overflow: hidden;
  background: var(--bg, var(--orca-background, #0d1117));
}
.datanoa-explain-zoom-group .datanoa-ai-btn {
  border: 0;
  border-radius: 0;
  height: 22px;
  min-width: 24px;
  padding: 0 6px;
  font-family: var(--mono-font, var(--mono, ui-monospace, monospace));
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.datanoa-explain-zoom-group .datanoa-ai-btn + .datanoa-ai-btn {
  border-left: 1px solid var(--border, var(--orca-border, rgba(148, 163, 184, 0.16)));
}
.datanoa-explain-svg-viewport {
  position: relative;
  min-height: 140px;
  max-height: 320px;
  overflow: hidden;
  background-color: var(--bg, var(--orca-background, #0d1117));
  background-image: radial-gradient(color-mix(in srgb, var(--text, var(--t1, #e6e6e6)) 9%, transparent) 1px, transparent 1px);
  background-size: 16px 16px;
  cursor: grab;
  user-select: none;
}
.datanoa-explain-svg-viewport.is-panning {
  cursor: grabbing;
}
.datanoa-explain-svg-viewport svg .datanoa-explain-svg-bg {
  fill: transparent;
}
.datanoa-explain-svg-stage {
  transform-origin: 0 0;
  display: inline-block;
}
.datanoa-explain-svg-stage .datanoa-explain-node {
  cursor: pointer;
}
.datanoa-explain-svg-stage .datanoa-explain-node .datanoa-explain-node-card {
  transition: stroke 140ms cubic-bezier(0.22, 1, 0.36, 1), fill 140ms cubic-bezier(0.22, 1, 0.36, 1);
}
.datanoa-explain-svg-stage .datanoa-explain-node:hover .datanoa-explain-node-card {
  stroke: var(--border-strong, var(--border-hi, rgba(148, 163, 184, 0.48)));
}
.datanoa-explain-svg-stage .datanoa-explain-node:focus-visible {
  outline: none;
}
.datanoa-explain-svg-stage .datanoa-explain-node:focus-visible .datanoa-explain-node-card,
.datanoa-explain-svg-stage .datanoa-explain-node[data-selected='true'] rect:first-of-type {
  stroke: var(--accent-ring, var(--orca-ring, #38bdf8));
  stroke-width: 1.75;
}
.datanoa-explain-frame .datanoa-explain-raw-pre {
  border: 0;
  border-radius: 0;
  padding: 12px;
  max-height: 300px;
  overflow: auto;
}
.datanoa-explain-ai-empty {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 12px 16px;
  border: 1px solid var(--border, var(--orca-border, rgba(148, 163, 184, 0.2)));
  border-radius: var(--radius, 8px);
  background: var(--card, color-mix(in srgb, var(--text, var(--t1, #e6e6e6)) 4%, var(--bg, #000000)));
}
.datanoa-explain-node-popover {
  position: relative;
  border: 1px solid var(--border-strong, var(--border, rgba(148, 163, 184, 0.3)));
  border-radius: var(--radius, 8px);
  background: var(--popover, var(--orca-popover, var(--surface, #14181f)));
  color: var(--text, var(--t1, var(--fg, #e6e6e6)));
  padding: 12px;
  box-shadow: var(--menu-shadow, 0 8px 24px rgba(0, 0, 0, 0.4));
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 12px;
}
.datanoa-explain-popover-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}
.datanoa-explain-popover-metrics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 8px;
}
.datanoa-explain-popover-metric {
  padding: 6px 8px;
  border-radius: 6px;
  border: 1px solid var(--border, var(--orca-border, rgba(148, 163, 184, 0.2)));
  background: var(--card, color-mix(in srgb, var(--text, var(--t1, #e6e6e6)) 5%, var(--bg, #000000)));
}
.datanoa-explain-popover-metric-label {
  display: block;
  font-size: 10px;
  color: var(--muted, var(--t2, #94a3b8));
}
.datanoa-explain-popover-metric-val {
  font-family: var(--mono-font, var(--mono, ui-monospace, monospace));
  font-size: 12px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}
.datanoa-explain-popover-details {
  display: grid;
  grid-template-columns: minmax(110px, auto) 1fr;
  gap: 4px 12px;
  font-size: 12px;
}
.datanoa-explain-popover-detail-key {
  color: var(--muted, var(--t2, #94a3b8));
}
.datanoa-explain-popover-detail-val {
  font-family: var(--mono-font, var(--mono, ui-monospace, monospace));
  overflow-wrap: anywhere;
}
@media (prefers-reduced-motion: reduce) {
  .datanoa-explain-tab-dot[data-tone='info'] {
    animation: none;
  }
}
`
  document.head.appendChild(style)
}

export function resolveEffectiveExplainAiPolicy(state) {
  const raw = state?.aiPolicy
  if (raw === 'never' || raw === 'ask' || raw === 'allow') {
    return raw
  }
  const tag = typeof state?.colorTag === 'string' ? state.colorTag.trim().toLowerCase() : ''
  if (tag === 'prod' || tag === 'production') {
    return 'ask'
  }
  return 'allow'
}

function appendAiPolicyPill(titleGroup, effectivePolicy) {
  if (effectivePolicy === 'never') {
    const policyPill = el('span', 'datanoa-ai-pill datanoa-ai-policy-pill', 'AI Blocked · Never')
    policyPill.setAttribute('data-policy', 'never')
    policyPill.title = 'AI assistance is disabled for this connection (policy: never)'
    titleGroup.appendChild(policyPill)
  } else if (effectivePolicy === 'ask') {
    const policyPill = el('span', 'datanoa-ai-pill datanoa-ai-policy-pill', 'Policy · Ask')
    policyPill.setAttribute('data-policy', 'ask')
    policyPill.title = 'Explicit confirmation required before sending SQL/plan to AI'
    titleGroup.appendChild(policyPill)
  }
}

function getOrCreateFixViewState(container, state, effectivePolicy) {
  let vs = fixPanelViewStateMap.get(container)
  if (!vs) {
    vs = {
      lastStateRef: null,
      pendingAskConfirm: false,
    }
    fixPanelViewStateMap.set(container, vs)
  }
  if (state !== vs.lastStateRef) {
    vs.lastStateRef = state
    if (
      state?.pendingConfirm === true &&
      effectivePolicy === 'ask' &&
      (state.phase === 'idle' || state.phase === 'error')
    ) {
      vs.pendingAskConfirm = true
    } else if (
      !state ||
      state.phase === 'hidden' ||
      state.phase === 'loading' ||
      state.phase === 'ready' ||
      effectivePolicy !== 'ask'
    ) {
      vs.pendingAskConfirm = false
    }
  }
  return vs
}

function createChevronDownIcon() {
  const svg = createSvgNode('svg', {
    class: 'datanoa-explain-collapse-chevron',
    width: '14',
    height: '14',
    viewBox: '0 0 16 16',
    fill: 'none',
    'aria-hidden': 'true',
    focusable: 'false',
  })
  svg.appendChild(
    createSvgNode('path', {
      d: 'M4 6L8 10L12 6',
      stroke: 'currentColor',
      'stroke-width': '1.5',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    })
  )
  return svg
}

function getOrCreateExplainViewState(container, state) {
  let vs = explainPanelViewStateMap.get(container)
  const plan = state?.explainPlan ?? null
  const phase = state?.phase || 'idle'
  if (!vs || vs.planRef !== plan) {
    const defaultView = !plan
      ? 'ai'
      : phase === 'loading' || phase === 'ready' || phase === 'error'
        ? 'ai'
        : plan.root
          ? 'visual'
          : 'raw'
    vs = {
      planRef: plan,
      activeView: defaultView,
      lastPhase: phase,
      selectedNodeId: null,
      viewport: { x: 0, y: 0, scale: 1 },
      viewportInitialized: false,
      pendingAskConfirm: false,
    }
    explainPanelViewStateMap.set(container, vs)
  }
  if (!plan) {
    vs.activeView = 'ai'
  } else if (
    state?.explainViewMode === 'visual' ||
    state?.explainViewMode === 'raw' ||
    state?.explainViewMode === 'ai'
  ) {
    vs.activeView = state.explainViewMode
  } else if (
    vs.lastPhase === 'idle' &&
    (phase === 'loading' || phase === 'ready' || phase === 'error')
  ) {
    vs.activeView = 'ai'
  }
  vs.lastPhase = phase
  return vs
}

function resolveExplainSvgPaletteFromDom(container) {
  if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function' || !container) {
    return DEFAULT_EXPLAIN_SVG_PALETTE
  }
  try {
    const cs = window.getComputedStyle(container)
    const pick = (names, fallback) => {
      for (const n of names) {
        const val = cs.getPropertyValue(n)?.trim()
        if (val) return val
      }
      return fallback
    }
    return {
      bg: pick(['--bg', '--orca-background'], DEFAULT_EXPLAIN_SVG_PALETTE.bg),
      cardBg: pick(['--card', '--surface', '--orca-popover'], DEFAULT_EXPLAIN_SVG_PALETTE.cardBg),
      cardBorder: pick(['--border', '--orca-border'], DEFAULT_EXPLAIN_SVG_PALETTE.cardBorder),
      textPrimary: pick(['--text', '--t1', '--fg', '--orca-foreground'], DEFAULT_EXPLAIN_SVG_PALETTE.textPrimary),
      textMuted: pick(['--muted', '--t2', '--orca-muted-foreground'], DEFAULT_EXPLAIN_SVG_PALETTE.textMuted),
      edgeStroke: pick(['--border-strong', '--border', '--orca-border'], DEFAULT_EXPLAIN_SVG_PALETTE.edgeStroke),
      critical: pick(['--danger', '--orca-destructive'], DEFAULT_EXPLAIN_SVG_PALETTE.critical),
      high: pick(['--warn'], DEFAULT_EXPLAIN_SVG_PALETTE.high),
      moderate: pick(['--info'], DEFAULT_EXPLAIN_SVG_PALETTE.moderate),
      low: pick(['--ok'], DEFAULT_EXPLAIN_SVG_PALETTE.low),
      neutral: pick(['--muted', '--t2'], DEFAULT_EXPLAIN_SVG_PALETTE.neutral),
    }
  } catch {
    return DEFAULT_EXPLAIN_SVG_PALETTE
  }
}

function parseSvgMarkupSafe(svgMarkup) {
  if (!svgMarkup || typeof document === 'undefined') return null
  if (typeof DOMParser === 'function') {
    try {
      const parsed = new DOMParser().parseFromString(svgMarkup, 'image/svg+xml')
      const rootSvg =
        parsed?.documentElement?.tagName?.toLowerCase() === 'svg'
          ? parsed.documentElement
          : parsed?.body?.querySelector?.('svg')
      if (rootSvg) {
        return typeof document.importNode === 'function' ? document.importNode(rootSvg, true) : rootSvg
      }
    } catch {
      // Fall through to safe fragment fallback
    }
  }
  const host = document.createElement('div')
  host.innerHTML = svgMarkup
  return host.querySelector ? host.querySelector('svg') : host.firstElementChild
}

function cleanupExplainViewportListeners(container) {
  const fn = explainViewportCleanupMap.get(container)
  if (typeof fn === 'function') {
    try {
      fn()
    } catch {
      // Ignore viewport listener cleanup errors
    }
    explainViewportCleanupMap.delete(container)
  }
}

function appendPanelPrivacyPills(titleGroup, state) {
  if (!state) return
  if (state.destination === 'local' || state.destination === 'remote') {
    const host = typeof state.host === 'string' ? state.host.trim() : ''
    const prefix = state.destination === 'local' ? 'Local' : 'Remote'
    const label = host ? `${prefix} · ${host}` : prefix
    const destPill = el('span', 'datanoa-ai-pill datanoa-ai-dest-pill', label)
    destPill.setAttribute('data-destination', state.destination)
    destPill.title =
      state.destination === 'local'
        ? `AI requests stay on local host ${host || 'localhost'}`
        : `AI requests are sent to external host ${host || 'remote endpoint'}`
    titleGroup.appendChild(destPill)
  }
  const colorTag = typeof state.colorTag === 'string' ? state.colorTag.trim().toLowerCase() : ''
  if (colorTag === 'prod' || colorTag === 'production') {
    const prodPill = el('span', 'datanoa-ai-pill datanoa-ai-prod-pill', 'PROD')
    prodPill.setAttribute('data-color-tag', 'prod')
    prodPill.title = 'Production connection — review AI requests carefully'
    titleGroup.appendChild(prodPill)
  }
  const activeSchema = typeof state.activeSchema === 'string' ? state.activeSchema.trim() : ''
  if (activeSchema) {
    const schemaPill = el('span', 'datanoa-ai-pill datanoa-ai-schema-pill', `schema: ${activeSchema}`)
    schemaPill.title = `Active schema: ${activeSchema}`
    titleGroup.appendChild(schemaPill)
  }
}

function formatPopoverMetric(val, suffix = '') {
  if (val === null || val === undefined || !Number.isFinite(Number(val))) return '—'
  const num = Number(val)
  const rounded = Math.abs(num) >= 100 ? Math.round(num) : Math.round(num * 100) / 100
  return `${rounded}${suffix}`
}

function renderExplainNodePopover(node, onClose) {
  const data = buildExplainNodePopoverData(node)
  const popover = el('div', 'datanoa-explain-node-popover')
  popover.setAttribute('role', 'region')
  popover.setAttribute('aria-label', `Plan node details: ${data.title}`)
  popover.setAttribute('data-node-id', data.id)

  const head = el('div', 'datanoa-explain-popover-head')
  const headLeft = el('div', 'datanoa-ai-explain-title-group')
  headLeft.appendChild(el('strong', 'datanoa-ai-item-title', data.title))
  if (data.subtitle) {
    headLeft.appendChild(el('span', 'datanoa-ai-pill', data.subtitle))
  }
  const sevBadge = el('span', `datanoa-ai-sev sev-${data.severity}`, data.severity)
  headLeft.appendChild(sevBadge)

  const closeBtn = el('button', 'btn btn-ghost btn-sm datanoa-ai-btn', '×')
  closeBtn.type = 'button'
  closeBtn.setAttribute('aria-label', 'Close node details')
  closeBtn.addEventListener('click', onClose)
  head.appendChild(headLeft)
  head.appendChild(closeBtn)
  popover.appendChild(head)

  if (data.warnings.length > 0) {
    const warnStrip = el('div', 'datanoa-ai-inline-warn', data.warnings.join(' · '))
    warnStrip.setAttribute('role', 'note')
    popover.appendChild(warnStrip)
  }

  const metricsGrid = el('div', 'datanoa-explain-popover-metrics')
  const metricItems = [
    ['Exclusive Cost', formatPopoverMetric(data.metrics.exclusiveCost)],
    ['Total Cost', formatPopoverMetric(data.metrics.totalCost)],
    [
      'Cost Share',
      data.metrics.costFraction !== null ? `${Math.round(data.metrics.costFraction * 100)}%` : '—',
    ],
    ['Exclusive Time', formatPopoverMetric(data.metrics.exclusiveTimeMs, 'ms')],
    ['Total Time', formatPopoverMetric(data.metrics.actualTotalTimeMs, 'ms')],
    [
      'Time Share',
      data.metrics.timeFraction !== null ? `${Math.round(data.metrics.timeFraction * 100)}%` : '—',
    ],
    ['Est. Rows', formatPopoverMetric(data.metrics.planRows)],
    ['Actual Rows', formatPopoverMetric(data.metrics.totalActualRows)],
    ['Loops', formatPopoverMetric(data.metrics.actualLoops)],
    ['Workers', formatPopoverMetric(data.metrics.processCount)],
  ]
  for (const [label, val] of metricItems) {
    const box = el('div', 'datanoa-explain-popover-metric')
    box.appendChild(el('span', 'datanoa-explain-popover-metric-label', label))
    box.appendChild(el('span', 'datanoa-explain-popover-metric-val', val))
    metricsGrid.appendChild(box)
  }
  popover.appendChild(metricsGrid)

  if (data.details.length > 0) {
    const detGrid = el('div', 'datanoa-explain-popover-details')
    for (const entry of data.details) {
      detGrid.appendChild(el('div', 'datanoa-explain-popover-detail-key', entry.key))
      detGrid.appendChild(el('div', 'datanoa-explain-popover-detail-val', entry.value))
    }
    popover.appendChild(detGrid)
  }

  return popover
}

function execCommandCopyFallback(value) {
  if (typeof document === 'undefined' || !document.body) return false
  const prevActive =
    document.activeElement && typeof document.activeElement.focus === 'function'
      ? document.activeElement
      : null
  const ta = document.createElement('textarea')
  ta.value = value
  ta.setAttribute?.('readonly', '')
  if (ta.style) {
    ta.style.position = 'fixed'
    ta.style.top = '-9999px'
    ta.style.left = '-9999px'
    ta.style.width = '1px'
    ta.style.height = '1px'
    ta.style.opacity = '0'
    ta.style.pointerEvents = 'none'
  }
  let copied = false
  try {
    document.body.appendChild(ta)
    try {
      ta.focus?.({ preventScroll: true })
    } catch {
      try {
        ta.focus?.()
      } catch {
        // Ignore minimal DOM focus errors
      }
    }
    try {
      ta.select?.()
    } catch {
      // Ignore minimal DOM select errors
    }
    try {
      ta.setSelectionRange?.(0, value.length)
    } catch {
      // Ignore minimal DOM selection errors
    }
    try {
      if (typeof document.execCommand === 'function') {
        copied = Boolean(document.execCommand('copy'))
      }
    } catch {
      copied = false
    }
  } finally {
    try {
      if (typeof ta.remove === 'function') {
        ta.remove()
      } else if (ta.parentNode) {
        ta.parentNode.removeChild(ta)
      }
    } catch {
      // Ignore cleanup errors
    }
    if (prevActive && prevActive.isConnected !== false) {
      try {
        prevActive.focus({ preventScroll: true })
      } catch {
        try {
          prevActive.focus()
        } catch {
          // Ignore focus restore errors
        }
      }
    }
  }
  return copied
}

async function copyTextWithButtonFeedback(btn, text, label, callbacks) {
  const value = String(text ?? '')
  const seq = btn ? (btn._copyFeedbackSeq = (btn._copyFeedbackSeq || 0) + 1) : 0
  // Preserve synchronous user gesture in restricted/isolated frames while also
  // attempting async Clipboard API writeText within the click turn.
  const syncExecCopied = execCommandCopyFallback(value)
  let clipOk = false
  if (typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(value)
      clipOk = true
    } catch {
      clipOk = false
    }
  }
  const ok = clipOk || syncExecCopied
  if (btn && btn._copyFeedbackSeq !== seq) {
    return ok
  }
  const statusMsg = ok ? `Copied ${label || 'text'}` : 'Clipboard write failed'
  if (typeof callbacks?.onStatus === 'function') {
    callbacks.onStatus(statusMsg)
  }
  if (!btn) return ok
  if (btn._copyResetTimer !== undefined) {
    clearTimeout(btn._copyResetTimer)
    btn._copyResetTimer = undefined
  }
  const orig = btn.dataset?.origLabel || btn._copyOrigLabel || btn.textContent || 'Copy'
  btn._copyOrigLabel = orig
  if (btn.dataset) {
    btn.dataset.origLabel = orig
    btn.dataset.copyState = ok ? 'copied' : 'failed'
  }
  btn.textContent = ok ? 'Copied' : 'Clipboard write failed'
  btn.title = statusMsg
  btn.setAttribute?.('aria-label', statusMsg)
  if (typeof setTimeout === 'function') {
    const t = setTimeout(() => {
      if (btn._copyFeedbackSeq !== seq) return
      btn._copyResetTimer = undefined
      if (btn.isConnected !== false) {
        btn.textContent = orig
      }
      if (btn.dataset) {
        delete btn.dataset.copyState
      }
    }, 1500)
    if (typeof t === 'object' && t !== null && typeof t.unref === 'function') {
      t.unref()
    }
    btn._copyResetTimer = t
  }
  return ok
}

function triggerExplainCopy(container, btn, fallbackCallbacks, text, label) {
  const cb = (container && explainPanelCallbacksMap.get(container)) || fallbackCallbacks
  if (typeof cb?.onCopyText === 'function') {
    cb.onCopyText(text, label)
    return
  }
  void copyTextWithButtonFeedback(btn, text, label, cb)
}

function appendExplainMetaSegments(containerEl, segments) {
  let emitted = 0
  for (const seg of segments) {
    if (!seg || !seg.text) continue
    if (emitted > 0) {
      const sep = el('span', 'datanoa-explain-meta-sep', '·')
      sep.setAttribute('aria-hidden', 'true')
      containerEl.appendChild(sep)
    }
    const cls = seg.warn
      ? 'datanoa-explain-meta-item datanoa-explain-meta-warn'
      : 'datanoa-explain-meta-item'
    containerEl.appendChild(el('span', cls, seg.text))
    emitted += 1
  }
}

function buildExplainVisualOrRawSection(container, state, callbacks, viewState) {
  const plan = state.explainPlan
  if (!plan) return null

  if (viewState.activeView === 'raw') {
    const rawWrap = el('div', 'datanoa-explain-raw-wrap')
    const hasPlanRawText = typeof plan.rawText === 'string' && plan.rawText.length > 0
    const hasPassedRawText =
      typeof state.rawPlanText === 'string' && state.rawPlanText.length > 0
    const isNormalizedFallback = !hasPlanRawText && !hasPassedRawText
    const rawText = hasPlanRawText
      ? plan.rawText
      : hasPassedRawText
        ? state.rawPlanText
        : JSON.stringify(plan, null, 2)
    const frame = el('div', 'datanoa-explain-frame')
    const rawBar = el('div', 'datanoa-explain-summary-bar')
    const pills = el('div', 'datanoa-explain-summary-pills')
    appendExplainMetaSegments(pills, [
      { text: plan.format || 'raw-text' },
      { text: `${plan.nodeCount ?? 0} nodes` },
      ...(isNormalizedFallback ? [{ text: 'Normalized JSON', warn: true }] : []),
    ])
    const acts = el('div', 'datanoa-explain-summary-actions')
    const copyBtnLabel = isNormalizedFallback ? 'Copy Normalized Plan' : 'Copy Raw Plan'
    const copyToastLabel = isNormalizedFallback
      ? 'Summarized / Normalized Plan'
      : 'Raw EXPLAIN plan'
    const copyRawBtn = el(
      'button',
      'btn btn-ghost btn-sm datanoa-ai-btn datanoa-explain-copy-raw-btn',
      copyBtnLabel
    )
    copyRawBtn.type = 'button'
    copyRawBtn.addEventListener('click', () => {
      triggerExplainCopy(container, copyRawBtn, callbacks, rawText, copyToastLabel)
    })
    acts.appendChild(copyRawBtn)
    rawBar.appendChild(pills)
    rawBar.appendChild(acts)
    frame.appendChild(rawBar)

    if (isNormalizedFallback) {
      const notice = el(
        'div',
        'datanoa-ai-inline-warn',
        'Summarized / Normalized Plan (raw output truncated for size)'
      )
      notice.setAttribute('role', 'note')
      rawWrap.appendChild(notice)
    }

    const pre = el('pre', 'datanoa-ai-code datanoa-explain-raw-pre', rawText)
    frame.appendChild(pre)
    rawWrap.appendChild(frame)
    return rawWrap
  }

  const wrap = el('div', 'datanoa-explain-visual-wrap')
  const palette = resolveExplainSvgPaletteFromDom(container)
  const svgRes = renderExplainPlanSvg(plan, { palette })

  const frame = el('div', 'datanoa-explain-frame')
  const summaryBar = el('div', 'datanoa-explain-summary-bar')
  const pills = el('div', 'datanoa-explain-summary-pills')
  const metaSegments = [
    { text: svgRes.summary.format },
    { text: `${svgRes.summary.nodeCount} node${svgRes.summary.nodeCount === 1 ? '' : 's'}` },
  ]
  if (svgRes.summary.planningTimeMs !== null) {
    metaSegments.push({ text: `Plan ${formatExplainDuration(svgRes.summary.planningTimeMs)}` })
  }
  if (svgRes.summary.executionTimeMs !== null) {
    metaSegments.push({ text: `Exec ${formatExplainDuration(svgRes.summary.executionTimeMs)}` })
  }
  if (svgRes.summary.totalCost !== null) {
    metaSegments.push({ text: `Cost ${formatPopoverMetric(svgRes.summary.totalCost)}` })
  }
  if (svgRes.summary.warningCount > 0) {
    metaSegments.push({
      text: `${svgRes.summary.warningCount} warning${svgRes.summary.warningCount === 1 ? '' : 's'}`,
      warn: true,
    })
  }
  appendExplainMetaSegments(pills, metaSegments)

  const actions = el('div', 'datanoa-explain-summary-actions')
  const zoomGroup = el('div', 'datanoa-explain-zoom-group')
  const zoomOutBtn = el('button', 'btn btn-ghost btn-sm datanoa-ai-btn', '−')
  zoomOutBtn.type = 'button'
  zoomOutBtn.setAttribute('aria-label', 'Zoom out EXPLAIN tree')
  const zoomResetBtn = el('button', 'btn btn-ghost btn-sm datanoa-ai-btn', '100%')
  zoomResetBtn.type = 'button'
  zoomResetBtn.setAttribute('aria-label', 'Reset EXPLAIN tree zoom to 100%')
  const zoomInBtn = el('button', 'btn btn-ghost btn-sm datanoa-ai-btn', '+')
  zoomInBtn.type = 'button'
  zoomInBtn.setAttribute('aria-label', 'Zoom in EXPLAIN tree')
  const zoomFitBtn = el('button', 'btn btn-ghost btn-sm datanoa-ai-btn datanoa-explain-fit-btn', 'Fit')
  zoomFitBtn.type = 'button'
  zoomFitBtn.setAttribute('aria-label', 'Fit EXPLAIN tree to view')
  zoomGroup.appendChild(zoomOutBtn)
  zoomGroup.appendChild(zoomResetBtn)
  zoomGroup.appendChild(zoomInBtn)
  zoomGroup.appendChild(zoomFitBtn)

  const copySvgBtn = el('button', 'btn btn-ghost btn-sm datanoa-ai-btn datanoa-explain-copy-svg-btn', 'Copy SVG')
  copySvgBtn.type = 'button'
  copySvgBtn.addEventListener('click', () => {
    triggerExplainCopy(container, copySvgBtn, callbacks, svgRes.svg, 'SVG')
  })
  actions.appendChild(zoomGroup)
  actions.appendChild(copySvgBtn)
  summaryBar.appendChild(pills)
  summaryBar.appendChild(actions)
  frame.appendChild(summaryBar)

  if (!plan.root || svgRes.nodes.length === 0) {
    wrap.appendChild(frame)
    wrap.appendChild(
      el(
        'p',
        'datanoa-ai-hint',
        'No structured tree nodes could be extracted for this plan. Switch to Raw Plan to inspect the raw output.'
      )
    )
    return wrap
  }

  const viewportEl = el('div', 'datanoa-explain-svg-viewport')
  const idealHeight = Math.min(320, Math.max(140, Math.ceil(svgRes.height) + 12))
  if (viewportEl.style) {
    viewportEl.style.height = `${idealHeight}px`
  }
  const stageEl = el('div', 'datanoa-explain-svg-stage')
  const svgNode = parseSvgMarkupSafe(svgRes.svg)
  if (svgNode) {
    stageEl.appendChild(svgNode)
  }
  viewportEl.appendChild(stageEl)

  const computeCenteredViewport = (rectWidth, rectHeight, scaleOverride) => {
    const viewW = rectWidth > 0 ? rectWidth : svgRes.width
    const viewH = rectHeight > 0 ? rectHeight : idealHeight
    const fitScale =
      scaleOverride !== undefined
        ? scaleOverride
        : Math.min(
            1,
            Math.max(
              0.35,
              Math.min(
                Math.max(80, viewW - 16) / Math.max(1, svgRes.width),
                Math.max(80, viewH - 8) / Math.max(1, svgRes.height)
              )
            )
          )
    const x = Math.max(0, (viewW - svgRes.width * fitScale) / 2)
    const y = Math.max(0, (viewH - svgRes.height * fitScale) / 2)
    return { x, y, scale: fitScale }
  }

  const syncStageTransform = () => {
    const rect = viewportEl.getBoundingClientRect?.()
    viewState.viewport = clampExplainViewport(
      viewState.viewport,
      svgRes.width,
      svgRes.height,
      rect && rect.width > 0 && rect.height > 0 ? { width: rect.width, height: rect.height } : undefined
    )
    if (stageEl.style) {
      stageEl.style.transform = `translate(${viewState.viewport.x}px, ${viewState.viewport.y}px) scale(${viewState.viewport.scale})`
    }
    zoomResetBtn.textContent = `${Math.round(viewState.viewport.scale * 100)}%`
  }

  const syncSelectedSvgNodeAttr = () => {
    if (typeof stageEl.querySelectorAll !== 'function') return
    for (const g of stageEl.querySelectorAll('.datanoa-explain-node')) {
      const id = g.getAttribute?.('data-node-id') || g.dataset?.nodeId || ''
      if (id && id === viewState.selectedNodeId) {
        g.setAttribute?.('data-selected', 'true')
        g.setAttribute?.('aria-pressed', 'true')
      } else {
        g.removeAttribute?.('data-selected')
        g.setAttribute?.('aria-pressed', 'false')
      }
    }
  }

  const initialRect = viewportEl.getBoundingClientRect?.()
  if (!viewState.viewportInitialized && initialRect && initialRect.width > 0) {
    viewState.viewport = computeCenteredViewport(initialRect.width, initialRect.height || idealHeight)
    viewState.viewportInitialized = true
  }

  syncStageTransform()
  syncSelectedSvgNodeAttr()

  zoomOutBtn.addEventListener('click', () => {
    viewState.viewportInitialized = true
    viewState.viewport = { ...viewState.viewport, scale: viewState.viewport.scale / 1.2 }
    syncStageTransform()
  })
  zoomInBtn.addEventListener('click', () => {
    viewState.viewportInitialized = true
    viewState.viewport = { ...viewState.viewport, scale: viewState.viewport.scale * 1.2 }
    syncStageTransform()
  })
  zoomResetBtn.addEventListener('click', () => {
    viewState.viewportInitialized = true
    const rect = viewportEl.getBoundingClientRect?.()
    viewState.viewport =
      rect && rect.width > 0
        ? computeCenteredViewport(rect.width, rect.height || idealHeight, 1)
        : { x: 0, y: 0, scale: 1 }
    syncStageTransform()
  })
  zoomFitBtn.addEventListener('click', () => {
    viewState.viewportInitialized = true
    const rect = viewportEl.getBoundingClientRect?.()
    viewState.viewport =
      rect && rect.width > 0
        ? computeCenteredViewport(rect.width, rect.height || idealHeight)
        : { x: 0, y: 0, scale: 1 }
    syncStageTransform()
  })

  viewportEl.addEventListener('wheel', (ev) => {
    if (!ev.ctrlKey && !ev.metaKey) return
    ev.preventDefault?.()
    viewState.viewportInitialized = true
    const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12
    viewState.viewport = { ...viewState.viewport, scale: viewState.viewport.scale * factor }
    syncStageTransform()
  }, { passive: false })

  let isPanning = false
  let panMoved = false
  let panStartX = 0
  let panStartY = 0
  let originX = 0
  let originY = 0

  const onWindowMove = (moveEv) => {
    if (!isPanning) return
    const dx = (Number(moveEv.clientX) || 0) - panStartX
    const dy = (Number(moveEv.clientY) || 0) - panStartY
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      panMoved = true
    }
    viewState.viewportInitialized = true
    viewState.viewport = { ...viewState.viewport, x: originX + dx, y: originY + dy }
    syncStageTransform()
  }

  const onWindowUp = () => {
    if (!isPanning) return
    isPanning = false
    viewportEl.classList?.remove?.('is-panning')
  }

  viewportEl.addEventListener('mousedown', (ev) => {
    if (ev.button !== undefined && ev.button !== 0) return
    if (ev.target?.closest?.('.datanoa-explain-node')) return
    isPanning = true
    panMoved = false
    panStartX = Number(ev.clientX) || 0
    panStartY = Number(ev.clientY) || 0
    originX = viewState.viewport.x
    originY = viewState.viewport.y
    viewportEl.classList?.add?.('is-panning')
  })

  let rafId = null
  if (
    !viewState.viewportInitialized &&
    typeof requestAnimationFrame === 'function'
  ) {
    rafId = requestAnimationFrame(() => {
      rafId = null
      if (viewState.viewportInitialized || viewportEl.isConnected === false) return
      const rect = viewportEl.getBoundingClientRect?.()
      if (!rect || rect.width <= 0) return
      viewState.viewport = computeCenteredViewport(rect.width, rect.height || idealHeight)
      viewState.viewportInitialized = true
      syncStageTransform()
    })
  }

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('mousemove', onWindowMove)
    window.addEventListener('mouseup', onWindowUp)
    explainViewportCleanupMap.set(container, () => {
      window.removeEventListener('mousemove', onWindowMove)
      window.removeEventListener('mouseup', onWindowUp)
      if (rafId !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(rafId)
        rafId = null
      }
    })
  } else if (rafId !== null && typeof cancelAnimationFrame === 'function') {
    explainViewportCleanupMap.set(container, () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId)
        rafId = null
      }
    })
  }

  const popoverSlot = el('div', 'datanoa-explain-popover-slot')
  const renderPopoverSlot = () => {
    clearNode(popoverSlot)
    if (!viewState.selectedNodeId) return
    const match = svgRes.nodes.find((item) => item.id === viewState.selectedNodeId)
    if (!match) return
    popoverSlot.appendChild(
      renderExplainNodePopover(match.node, () => {
        viewState.selectedNodeId = null
        syncSelectedSvgNodeAttr()
        renderPopoverSlot()
      })
    )
  }

  const toggleSvgNodeSelection = (nodeGroup) => {
    if (!nodeGroup) return
    const nodeId = nodeGroup.getAttribute?.('data-node-id') || nodeGroup.dataset?.nodeId || ''
    if (!nodeId) return
    viewState.selectedNodeId = viewState.selectedNodeId === nodeId ? null : nodeId
    syncSelectedSvgNodeAttr()
    renderPopoverSlot()
  }

  viewportEl.addEventListener('click', (ev) => {
    if (panMoved) return
    const nodeGroup = ev.target?.closest?.('.datanoa-explain-node')
    toggleSvgNodeSelection(nodeGroup)
  })

  viewportEl.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return
    const nodeGroup = ev.target?.closest?.('.datanoa-explain-node')
    if (!nodeGroup) return
    ev.preventDefault?.()
    toggleSvgNodeSelection(nodeGroup)
  })

  frame.appendChild(viewportEl)
  wrap.appendChild(frame)
  renderPopoverSlot()
  wrap.appendChild(popoverSlot)

  if (Array.isArray(plan.missingIndexes) && plan.missingIndexes.length > 0) {
    const idxSec = el('div', 'datanoa-ai-section datanoa-explain-missing-indexes')
    idxSec.appendChild(el('div', 'datanoa-ai-section-label', 'Missing Index Hints (from EXPLAIN plan)'))
    const list = el('div', 'datanoa-ai-list')
    for (const mi of plan.missingIndexes) {
      if (!mi?.ddl) continue
      const card = el('div', 'datanoa-ai-item')
      const top = el('div', 'datanoa-ai-item-top')
      const reasonText =
        typeof mi.impact === 'number'
          ? `${mi.table} · Impact ${mi.impact}%`
          : mi.table || 'Suggested index'
      top.appendChild(el('span', 'datanoa-ai-item-detail', reasonText))
      const copyDdlBtn = el('button', 'btn btn-ghost btn-sm datanoa-ai-btn', 'Copy DDL')
      copyDdlBtn.type = 'button'
      copyDdlBtn.addEventListener('click', () => {
        triggerExplainCopy(container, copyDdlBtn, callbacks, mi.ddl, 'DDL')
      })
      top.appendChild(copyDdlBtn)
      card.appendChild(top)
      card.appendChild(createHighlightedSqlPre(mi.ddl, state.dialect || plan.dialect))
      list.appendChild(card)
    }
    if (list.childNodes.length > 0) {
      idxSec.appendChild(list)
      wrap.appendChild(idxSec)
    }
  }

  return wrap
}

function buildExplainAiReadyBody(container, state, callbacks) {
  const body = el('div', 'datanoa-ai-explain-body')
  const res = state.result
  if (!res) return body

  const rawCaveats = Array.isArray(res.caveats) ? res.caveats : []
  const unstructuredCaveat = rawCaveats.find((c) => /unstructured/i.test(String(c)))
  const isUnstructuredFallback =
    Boolean(unstructuredCaveat) &&
    (!Array.isArray(res.bottlenecks) || res.bottlenecks.length === 0) &&
    (!Array.isArray(res.indexSuggestions) || res.indexSuggestions.length === 0) &&
    !res.optimizedSql

  if (isUnstructuredFallback) {
    const notice = el(
      'div',
      'datanoa-ai-inline-warn',
      'Model returned unstructured text instead of a structured plan analysis. Review carefully or switch Explain & Fix to a chat/instruct model.'
    )
    notice.setAttribute('role', 'note')
    body.appendChild(notice)
  }

  if (res.summary) {
    const summarySec = el('div', 'datanoa-ai-section')
    summarySec.appendChild(el('p', 'datanoa-ai-summary', res.summary))
    body.appendChild(summarySec)
  }

  if (Array.isArray(res.bottlenecks) && res.bottlenecks.length > 0) {
    const validBottlenecks = res.bottlenecks.filter((item) => item && typeof item === 'object')
    if (validBottlenecks.length > 0) {
      const sec = el('div', 'datanoa-ai-section')
      sec.appendChild(el('div', 'datanoa-ai-section-label', 'Bottlenecks'))
      const list = el('div', 'datanoa-ai-list')
      for (const item of validBottlenecks) {
        const rawSev = String(item.severity || 'medium').toLowerCase()
        const sevSafe = rawSev === 'high' || rawSev === 'low' ? rawSev : 'medium'
        const sevLabel = sevSafe === 'high' ? 'High' : sevSafe === 'low' ? 'Low' : 'Medium'
        const card = el('div', `datanoa-ai-item sev-${sevSafe}`)
        const top = el('div', 'datanoa-ai-item-top')
        top.appendChild(el('span', `datanoa-ai-sev sev-${sevSafe}`, sevLabel))
        top.appendChild(el('strong', 'datanoa-ai-item-title', item.title || 'Bottleneck'))
        card.appendChild(top)
        if (item.detail) {
          card.appendChild(el('p', 'datanoa-ai-item-detail', item.detail))
        }
        list.appendChild(card)
      }
      sec.appendChild(list)
      body.appendChild(sec)
    }
  }

  if (Array.isArray(res.indexSuggestions) && res.indexSuggestions.length > 0) {
    const validIndexes = res.indexSuggestions.filter(
      (idx) => idx && typeof idx === 'object' && typeof idx.ddl === 'string' && idx.ddl.trim().length > 0
    )
    if (validIndexes.length > 0) {
      const sec = el('div', 'datanoa-ai-section')
      sec.appendChild(el('div', 'datanoa-ai-section-label', 'Suggested Indexes'))
      const list = el('div', 'datanoa-ai-list')
      for (const idx of validIndexes) {
        const card = el('div', 'datanoa-ai-item')
        const top = el('div', 'datanoa-ai-item-top')
        top.appendChild(el('span', 'datanoa-ai-item-detail', idx.reason || 'Suggested index'))
        const copyDdlBtn = el('button', 'btn btn-ghost btn-sm datanoa-ai-btn', 'Copy DDL')
        copyDdlBtn.type = 'button'
        copyDdlBtn.addEventListener('click', () => {
          triggerExplainCopy(container, copyDdlBtn, callbacks, idx.ddl, 'DDL')
        })
        top.appendChild(copyDdlBtn)
        card.appendChild(top)
        card.appendChild(createHighlightedSqlPre(idx.ddl, state.dialect))
        list.appendChild(card)
      }
      sec.appendChild(list)
      body.appendChild(sec)
    }
  }

  const trimmedOptSql = typeof res.optimizedSql === 'string' ? res.optimizedSql.trim() : ''
  if (trimmedOptSql) {
    const sec = el('div', 'datanoa-ai-section')
    const top = el('div', 'datanoa-ai-item-top')
    top.appendChild(
      el('div', 'datanoa-ai-section-label', 'Optimized Equivalent SQL (review before executing)')
    )
    const actions = el('div', 'datanoa-ai-row-actions')

    const replaceBtn = el('button', 'btn btn-primary btn-sm datanoa-ai-btn', 'Replace Query')
    replaceBtn.type = 'button'
    replaceBtn.addEventListener('click', () => explainPanelCallbacksMap.get(container)?.onApplySql?.(res.optimizedSql))

    const copyBtn = el('button', 'btn btn-ghost btn-sm datanoa-ai-btn', 'Copy SQL')
    copyBtn.type = 'button'
    copyBtn.addEventListener('click', () => {
      triggerExplainCopy(container, copyBtn, callbacks, res.optimizedSql, 'Optimized SQL')
    })

    const newTabBtn = el('button', 'btn btn-ghost btn-sm datanoa-ai-btn', 'New Tab')
    newTabBtn.type = 'button'
    newTabBtn.addEventListener('click', () => explainPanelCallbacksMap.get(container)?.onOpenNewTab?.(res.optimizedSql))

    actions.appendChild(replaceBtn)
    actions.appendChild(copyBtn)
    actions.appendChild(newTabBtn)
    top.appendChild(actions)
    sec.appendChild(top)
    sec.appendChild(createHighlightedSqlPre(res.optimizedSql, state.dialect))
    body.appendChild(sec)
  }

  const remainingCaveats = isUnstructuredFallback
    ? rawCaveats.filter((c) => c !== unstructuredCaveat)
    : rawCaveats
  if (remainingCaveats.length > 0) {
    const sec = el('div', 'datanoa-ai-section')
    sec.appendChild(el('div', 'datanoa-ai-section-label', 'Caveats'))
    const ul = el('ul', 'datanoa-ai-caveats')
    for (const c of remainingCaveats) {
      ul.appendChild(el('li', '', c))
    }
    sec.appendChild(ul)
    body.appendChild(sec)
  }

  return body
}

export function renderSharedExplainAiPanel(container, state, callbacks) {
  if (!container) return
  explainPanelCallbacksMap.set(container, callbacks)

  if (!state || state.phase === 'hidden') {
    cleanupAiPanelResize(container)
    cleanupExplainViewportListeners(container)
    container.hidden = true
    if (container.dataset) {
      delete container.dataset.phase
      delete container.dataset.collapsed
      delete container.dataset.aiPolicy
      delete container.dataset.explainView
    }
    clearContainerHeightStyle(container)
    clearNode(container)
    return
  }

  const collapsedFlag = Boolean(state.collapsed)
  const hasExplainPlan = Boolean(state.explainPlan)
  const viewState = getOrCreateExplainViewState(container, state)

  if (
    state.phase === 'loading' &&
    !collapsedFlag &&
    viewState.activeView === 'ai' &&
    !container.hidden &&
    container.dataset?.phase === 'loading' &&
    container.dataset?.collapsed === 'false' &&
    container.dataset?.explainView === 'ai' &&
    typeof container.querySelector === 'function' &&
    container.querySelector('.datanoa-ai-loading-box')
  ) {
    return
  }

  cleanupAiPanelResize(container)
  cleanupExplainViewportListeners(container)
  ensureExplainVisualStyles()
  const effectivePolicy = resolveEffectiveExplainAiPolicy(state)

  container.hidden = false
  container.className = 'datanoa-ai-explain-panel'
  if (container.dataset) {
    container.dataset.phase = String(state.phase || '')
    container.dataset.collapsed = collapsedFlag ? 'true' : 'false'
    container.dataset.aiPolicy = effectivePolicy
    container.dataset.explainView = viewState.activeView
  }
  clearNode(container)

  const resizeEdge = callbacks?.resizeEdge === 'bottom' ? 'bottom' : 'top'
  const isResizable =
    (state.phase === 'ready' || state.phase === 'error' || hasExplainPlan) && !collapsedFlag
  if (isResizable) {
    restoreSavedContainerHeight(container, resizeEdge)
  } else {
    clearContainerHeightStyle(container)
  }

  if (isResizable && resizeEdge === 'top') {
    container.appendChild(createAiPanelResizer(container, resizeEdge, callbacks?.onResize))
  }

  const switchExplainView = (nextView) => {
    const cb = explainPanelCallbacksMap.get(container)
    if (viewState.activeView === nextView && !collapsedFlag) return
    viewState.activeView = nextView
    cb?.onExplainViewChange?.(nextView)
    if (collapsedFlag && typeof cb?.onToggleCollapsed === 'function') {
      cb.onToggleCollapsed()
      if (container.dataset?.collapsed === 'true') {
        renderSharedExplainAiPanel(container, { ...state, explainViewMode: nextView, collapsed: false }, cb)
      }
      return
    }
    renderSharedExplainAiPanel(container, { ...state, explainViewMode: nextView }, cb)
  }

  const header = el('div', 'datanoa-ai-explain-bar')
  const titleGroup = el('div', 'datanoa-ai-explain-title-group')
  titleGroup.appendChild(el('span', 'datanoa-ai-explain-title', 'Execution Plan Analysis'))

  if (state.phase === 'ready' && state.result && typeof state.result.durationMs === 'number') {
    const metaPill = el(
      'span',
      'datanoa-ai-pill',
      formatExplainMetaBadge(state.result.durationMs, state.result.language)
    )
    titleGroup.appendChild(metaPill)
  }
  appendPanelPrivacyPills(titleGroup, state)
  appendAiPolicyPill(titleGroup, effectivePolicy)
  header.appendChild(titleGroup)

  const controls = el('div', 'datanoa-ai-explain-controls')

  if (hasExplainPlan) {
    const switcher = el('div', 'datanoa-explain-view-switcher')
    switcher.setAttribute('role', 'tablist')
    switcher.setAttribute('aria-label', 'EXPLAIN view mode')

    const visualTab = el('button', 'datanoa-explain-view-tab', 'Visual Tree')
    visualTab.type = 'button'
    visualTab.setAttribute('role', 'tab')
    visualTab.setAttribute('data-explain-view', 'visual')
    visualTab.setAttribute('aria-selected', viewState.activeView === 'visual' ? 'true' : 'false')
    visualTab.addEventListener('click', () => switchExplainView('visual'))

    const rawTab = el('button', 'datanoa-explain-view-tab', 'Raw Plan')
    rawTab.type = 'button'
    rawTab.setAttribute('role', 'tab')
    rawTab.setAttribute('data-explain-view', 'raw')
    rawTab.setAttribute('aria-selected', viewState.activeView === 'raw' ? 'true' : 'false')
    rawTab.addEventListener('click', () => switchExplainView('raw'))

    const aiTab = el('button', 'datanoa-explain-view-tab')
    aiTab.type = 'button'
    aiTab.setAttribute('role', 'tab')
    aiTab.setAttribute('data-explain-view', 'ai')
    aiTab.setAttribute('aria-selected', viewState.activeView === 'ai' ? 'true' : 'false')
    aiTab.appendChild(createTextOrSpan('AI Analysis'))
    if (state.phase === 'loading' || state.phase === 'ready' || state.phase === 'error') {
      const dotTone = state.phase === 'loading' ? 'info' : state.phase === 'ready' ? 'ok' : 'danger'
      const dot = el('span', 'datanoa-explain-tab-dot')
      dot.setAttribute('data-tone', dotTone)
      dot.setAttribute('aria-hidden', 'true')
      aiTab.appendChild(dot)
    }
    aiTab.addEventListener('click', () => switchExplainView('ai'))

    switcher.appendChild(visualTab)
    switcher.appendChild(rawTab)
    switcher.appendChild(aiTab)
    controls.appendChild(switcher)
  }

  const triggerAnalyze = () => {
    const cb = explainPanelCallbacksMap.get(container)
    if (effectivePolicy === 'never') return
    if (hasExplainPlan) {
      viewState.activeView = 'ai'
      cb?.onExplainViewChange?.('ai')
    }
    if (effectivePolicy === 'ask') {
      viewState.pendingAskConfirm = true
      if (collapsedFlag && typeof cb?.onToggleCollapsed === 'function') {
        cb.onToggleCollapsed()
      }
      renderSharedExplainAiPanel(
        container,
        {
          ...state,
          ...(hasExplainPlan ? { explainViewMode: 'ai' } : {}),
          collapsed: false,
        },
        cb
      )
      return
    }
    cb?.onAnalyze?.({
      confirmed: true,
      ...(state.activeSchema ? { activeSchema: state.activeSchema } : {}),
    })
  }

  if (state.phase === 'loading') {
    const cancelBtn = el('button', 'btn btn-ghost btn-sm datanoa-ai-btn', 'Cancel')
    cancelBtn.type = 'button'
    cancelBtn.addEventListener('click', () => explainPanelCallbacksMap.get(container)?.onCancel?.())
    controls.appendChild(cancelBtn)
  } else if (effectivePolicy === 'never') {
    const label = state.phase === 'ready' || state.phase === 'error' ? 'Re-analyze' : 'Analyze with AI'
    const disabledBtn = el('button', 'btn btn-ghost btn-sm datanoa-ai-btn', label)
    disabledBtn.type = 'button'
    disabledBtn.disabled = true
    disabledBtn.setAttribute('aria-disabled', 'true')
    disabledBtn.setAttribute('data-ai-policy', 'never')
    disabledBtn.title = 'AI assistance is disabled for this connection (policy: never). Visual EXPLAIN Tree remains available offline.'
    controls.appendChild(disabledBtn)
  } else if (!state.aiEnabled || !state.aiReady) {
    const setupBtn = el('button', 'btn btn-primary btn-sm datanoa-ai-btn', 'Configure Explain & Fix AI')
    setupBtn.type = 'button'
    setupBtn.addEventListener('click', () => explainPanelCallbacksMap.get(container)?.onConfigureAi?.())
    controls.appendChild(setupBtn)
  } else {
    const label = state.phase === 'ready' || state.phase === 'error' ? 'Re-analyze' : 'Analyze with AI'
    const cls =
      state.phase === 'idle' && (!hasExplainPlan || viewState.activeView !== 'ai')
        ? 'btn btn-primary btn-sm datanoa-ai-btn'
        : 'btn btn-ghost btn-sm datanoa-ai-btn'
    const analyzeBtn = el('button', cls, label)
    analyzeBtn.type = 'button'
    analyzeBtn.addEventListener('click', triggerAnalyze)
    controls.appendChild(analyzeBtn)
  }

  const canCollapse = hasExplainPlan || state.phase === 'ready' || collapsedFlag
  if (canCollapse) {
    const collapseBtn = el('button', 'btn btn-ghost btn-sm datanoa-ai-btn datanoa-explain-collapse-btn')
    collapseBtn.type = 'button'
    collapseBtn.setAttribute('aria-expanded', collapsedFlag ? 'false' : 'true')
    collapseBtn.setAttribute(
      'aria-label',
      collapsedFlag ? 'Expand Execution Plan panel' : 'Collapse Execution Plan panel'
    )
    collapseBtn.title = collapsedFlag ? 'Expand Execution Plan' : 'Collapse Execution Plan'
    collapseBtn.appendChild(createChevronDownIcon())
    collapseBtn.appendChild(el('span', 'datanoa-explain-collapse-label', collapsedFlag ? 'Expand' : 'Collapse'))
    collapseBtn.addEventListener('click', () => explainPanelCallbacksMap.get(container)?.onToggleCollapsed?.())
    controls.appendChild(collapseBtn)
  }

  header.appendChild(controls)
  container.appendChild(header)

  if (collapsedFlag) {
    return
  }

  if (viewState.pendingAskConfirm && effectivePolicy === 'ask' && state.phase !== 'loading') {
    const confirmBar = el('div', 'datanoa-ai-confirm-bar')
    confirmBar.setAttribute('role', 'region')
    confirmBar.setAttribute('aria-label', 'Confirm AI EXPLAIN request')
    const schemaNote = state.activeSchema ? ` (schema: ${state.activeSchema})` : ''
    const hostNote = state.host ? ` to ${state.host}` : ''
    const prodNote =
      state.colorTag === 'prod' || String(state.colorTag).toLowerCase() === 'production'
        ? ' [PROD connection]'
        : ''
    confirmBar.appendChild(
      el(
        'span',
        'datanoa-ai-confirm-text',
        `Confirm sending sanitized SQL, schema${schemaNote}, and EXPLAIN plan${hostNote}${prodNote}?`
      )
    )
    const confirmActions = el('div', 'datanoa-ai-row-actions')
    const confirmBtn = el(
      'button',
      'btn btn-primary btn-sm datanoa-ai-btn datanoa-ai-confirm-analyze-btn',
      'Confirm & Analyze'
    )
    confirmBtn.type = 'button'
    confirmBtn.addEventListener('click', () => {
      viewState.pendingAskConfirm = false
      if (hasExplainPlan) {
        viewState.activeView = 'ai'
        explainPanelCallbacksMap.get(container)?.onExplainViewChange?.('ai')
      }
      explainPanelCallbacksMap.get(container)?.onAnalyze?.({
        confirmed: true,
        ...(state.activeSchema ? { activeSchema: state.activeSchema } : {}),
      })
    })
    const cancelConfirmBtn = el(
      'button',
      'btn btn-ghost btn-sm datanoa-ai-btn datanoa-ai-confirm-cancel-btn',
      'Cancel'
    )
    cancelConfirmBtn.type = 'button'
    cancelConfirmBtn.addEventListener('click', () => {
      viewState.pendingAskConfirm = false
      renderSharedExplainAiPanel(container, state, explainPanelCallbacksMap.get(container))
    })
    confirmActions.appendChild(confirmBtn)
    confirmActions.appendChild(cancelConfirmBtn)
    confirmBar.appendChild(confirmActions)
    container.appendChild(confirmBar)
  }

  if (hasExplainPlan && (viewState.activeView === 'visual' || viewState.activeView === 'raw')) {
    const scrollWrap = el('div', 'datanoa-ai-panel-scroll')
    const visualNode = buildExplainVisualOrRawSection(container, state, callbacks, viewState)
    if (visualNode) {
      scrollWrap.appendChild(visualNode)
    }
    container.appendChild(scrollWrap)
    if (isResizable && resizeEdge === 'bottom') {
      container.appendChild(createAiPanelResizer(container, resizeEdge, callbacks?.onResize))
    }
    return
  }

  // Dedicated AI Analysis view (activeView === 'ai' or no structured explainPlan)
  if (state.phase === 'idle') {
    if (effectivePolicy === 'never') {
      const scrollWrap = el('div', 'datanoa-ai-panel-scroll')
      scrollWrap.appendChild(
        el(
          'p',
          'datanoa-ai-hint',
          hasExplainPlan
            ? 'AI assistance is disabled for this connection (policy: never). Switch to Visual Tree or Raw Plan to inspect offline.'
            : 'AI assistance is disabled for this connection (policy: never).'
        )
      )
      container.appendChild(scrollWrap)
      if (isResizable && resizeEdge === 'bottom') {
        container.appendChild(createAiPanelResizer(container, resizeEdge, callbacks?.onResize))
      }
      return
    }
    if (!state.aiEnabled || !state.aiReady) {
      const scrollWrap = el('div', 'datanoa-ai-panel-scroll')
      const note = !state.aiEnabled
        ? 'Explain & Fix AI is turned off. Enable Explain & Fix in AI SQL Assistant settings to analyze execution plans.'
        : 'Explain & Fix AI setup is incomplete. Configure provider credentials in AI SQL Assistant settings to analyze this EXPLAIN plan.'
      scrollWrap.appendChild(el('p', 'datanoa-ai-hint', note))
      container.appendChild(scrollWrap)
      if (isResizable && resizeEdge === 'bottom') {
        container.appendChild(createAiPanelResizer(container, resizeEdge, callbacks?.onResize))
      }
      return
    }
    if (hasExplainPlan) {
      const scrollWrap = el('div', 'datanoa-ai-panel-scroll')
      const emptyBox = el('div', 'datanoa-explain-ai-empty')
      emptyBox.appendChild(
        el(
          'p',
          'datanoa-ai-hint',
          'Run AI Analysis to detect bottlenecks, suggest indexes, and rewrite this query.'
        )
      )
      const runBtn = el('button', 'btn btn-primary btn-sm datanoa-ai-btn', 'Analyze with AI')
      runBtn.type = 'button'
      runBtn.addEventListener('click', triggerAnalyze)
      emptyBox.appendChild(runBtn)
      scrollWrap.appendChild(emptyBox)
      container.appendChild(scrollWrap)
      if (isResizable && resizeEdge === 'bottom') {
        container.appendChild(createAiPanelResizer(container, resizeEdge, callbacks?.onResize))
      }
    }
    return
  }

  if (state.phase === 'loading') {
    const scrollWrap = el('div', 'datanoa-ai-panel-scroll')
    scrollWrap.appendChild(createAiLoadingNode('Analyzing execution plan and index opportunities...'))
    container.appendChild(scrollWrap)
    return
  }

  if (state.phase === 'error') {
    const scrollWrap = el('div', 'datanoa-ai-panel-scroll')
    const errWrap = el('div', 'datanoa-ai-error-box')
    errWrap.setAttribute('role', 'alert')
    errWrap.appendChild(el('div', 'datanoa-ai-error-text', state.error || 'Could not analyze execution plan'))
    const errActions = el('div', 'datanoa-ai-row-actions')
    const retryBtn = el('button', 'btn btn-ghost btn-sm datanoa-ai-btn', 'Retry')
    retryBtn.type = 'button'
    retryBtn.disabled = effectivePolicy === 'never'
    retryBtn.addEventListener('click', triggerAnalyze)
    const cfgBtn = el('button', 'btn btn-ghost btn-sm datanoa-ai-btn', 'AI Settings')
    cfgBtn.type = 'button'
    cfgBtn.addEventListener('click', () => explainPanelCallbacksMap.get(container)?.onConfigureAi?.())
    errActions.appendChild(retryBtn)
    errActions.appendChild(cfgBtn)
    errWrap.appendChild(errActions)
    scrollWrap.appendChild(errWrap)
    container.appendChild(scrollWrap)
    if (isResizable && resizeEdge === 'bottom') {
      container.appendChild(createAiPanelResizer(container, resizeEdge, callbacks?.onResize))
    }
    return
  }

  if (!state.result) {
    return
  }

  const scrollWrap = el('div', 'datanoa-ai-panel-scroll')
  scrollWrap.appendChild(buildExplainAiReadyBody(container, state, callbacks))
  container.appendChild(scrollWrap)
  if (isResizable && resizeEdge === 'bottom') {
    container.appendChild(createAiPanelResizer(container, resizeEdge, callbacks?.onResize))
  }
}

export function renderSharedAiFixPanel(container, state, callbacks) {
  if (!container) return
  fixPanelCallbacksMap.set(container, callbacks)
  if (
    state?.phase === 'loading' &&
    !container.hidden &&
    container.dataset?.phase === 'loading' &&
    typeof container.querySelector === 'function' &&
    container.querySelector('.datanoa-ai-loading-box')
  ) {
    return
  }
  cleanupAiPanelResize(container)
  if (!state || state.phase === 'hidden') {
    container.hidden = true
    if (container.dataset) {
      delete container.dataset.phase
      delete container.dataset.aiPolicy
    }
    fixPanelViewStateMap.delete(container)
    clearContainerHeightStyle(container)
    clearNode(container)
    return
  }

  ensureExplainVisualStyles()
  const effectivePolicy = resolveEffectiveExplainAiPolicy(state)
  const viewState = getOrCreateFixViewState(container, state, effectivePolicy)

  container.hidden = false
  container.className = 'datanoa-ai-fix-panel'
  if (container.dataset) {
    container.dataset.phase = String(state.phase || '')
    container.dataset.aiPolicy = effectivePolicy
  }
  clearNode(container)

  const resizeEdge = callbacks?.resizeEdge === 'top' ? 'top' : 'bottom'
  const isResizable = state.phase === 'ready' || state.phase === 'error' || state.phase === 'idle'
  if (isResizable) {
    restoreSavedContainerHeight(container, resizeEdge)
  } else {
    clearContainerHeightStyle(container)
  }

  if (isResizable && resizeEdge === 'top') {
    container.appendChild(createAiPanelResizer(container, resizeEdge, callbacks?.onResize))
  }

  const dispatchFixRequest = (cb, triggerOptions) => {
    if (typeof cb?.onFixQuery === 'function') {
      cb.onFixQuery(triggerOptions)
    } else {
      cb?.onRetry?.(triggerOptions)
    }
  }

  const triggerFix = () => {
    const cb = fixPanelCallbacksMap.get(container)
    if (effectivePolicy === 'never') return
    if (effectivePolicy === 'ask') {
      viewState.pendingAskConfirm = true
      renderSharedAiFixPanel(container, state, cb)
      return
    }
    dispatchFixRequest(cb, { confirmed: true })
  }

  const header = el('div', 'datanoa-ai-explain-bar')
  const titleGroup = el('div', 'datanoa-ai-explain-title-group')
  titleGroup.appendChild(el('span', 'datanoa-ai-explain-title', 'AI Query Fix'))

  if (state.phase === 'ready' && state.result) {
    const res = state.result
    const pillParts = []
    if (typeof res.durationMs === 'number' && Number.isFinite(res.durationMs)) {
      pillParts.push(formatExplainDuration(res.durationMs))
    }
    const modelName = String(res.model || '').trim()
    if (modelName) {
      pillParts.push(modelName)
    }
    if (pillParts.length > 0) {
      titleGroup.appendChild(el('span', 'datanoa-ai-pill', pillParts.join(' · ')))
    }
  }
  appendPanelPrivacyPills(titleGroup, state)
  appendAiPolicyPill(titleGroup, effectivePolicy)
  header.appendChild(titleGroup)

  const controls = el('div', 'datanoa-ai-explain-controls')
  if (state.phase === 'loading') {
    const cancelBtn = el('button', 'btn btn-ghost btn-sm datanoa-ai-btn', 'Cancel')
    cancelBtn.type = 'button'
    cancelBtn.addEventListener('click', () => fixPanelCallbacksMap.get(container)?.onCancel?.())
    controls.appendChild(cancelBtn)
  } else if (state.phase === 'idle') {
    if (effectivePolicy === 'never') {
      const disabledBtn = el('button', 'btn btn-ghost btn-sm datanoa-ai-btn datanoa-ai-fix-trigger-btn', 'Fix with AI')
      disabledBtn.type = 'button'
      disabledBtn.disabled = true
      disabledBtn.setAttribute('aria-disabled', 'true')
      disabledBtn.setAttribute('data-ai-policy', 'never')
      disabledBtn.title = 'AI assistance is disabled for this connection (policy: never).'
      controls.appendChild(disabledBtn)
    } else if (!state.aiEnabled || !state.aiReady) {
      const setupBtn = el('button', 'btn btn-primary btn-sm datanoa-ai-btn', 'Configure Explain & Fix AI')
      setupBtn.type = 'button'
      setupBtn.addEventListener('click', () => fixPanelCallbacksMap.get(container)?.onConfigureAi?.())
      controls.appendChild(setupBtn)
    } else {
      const fixBtn = el('button', 'btn btn-primary btn-sm datanoa-ai-btn datanoa-ai-fix-trigger-btn', 'Fix with AI')
      fixBtn.type = 'button'
      fixBtn.addEventListener('click', triggerFix)
      controls.appendChild(fixBtn)
    }
  }

  if (state.phase !== 'ready') {
    const dismissBtn = el('button', 'btn btn-ghost btn-sm datanoa-ai-btn', 'Dismiss')
    dismissBtn.type = 'button'
    dismissBtn.addEventListener('click', () => fixPanelCallbacksMap.get(container)?.onDismiss?.())
    controls.appendChild(dismissBtn)
  }

  header.appendChild(controls)
  container.appendChild(header)

  if (viewState.pendingAskConfirm && effectivePolicy === 'ask' && state.phase !== 'loading') {
    const confirmBar = el('div', 'datanoa-ai-confirm-bar')
    confirmBar.setAttribute('role', 'region')
    confirmBar.setAttribute('aria-label', 'Confirm AI Query Fix request')
    const hostNote = state.host ? ` to ${state.host}` : ''
    const prodNote =
      state.colorTag === 'prod' || String(state.colorTag).toLowerCase() === 'production'
        ? ' [PROD connection]'
        : ''
    confirmBar.appendChild(
      el(
        'span',
        'datanoa-ai-confirm-text',
        `Confirm sending sanitized SQL, error message, and schema${hostNote}${prodNote}?`
      )
    )
    const confirmActions = el('div', 'datanoa-ai-row-actions')
    const confirmBtn = el(
      'button',
      'btn btn-primary btn-sm datanoa-ai-btn datanoa-ai-confirm-fix-btn',
      'Confirm & Fix (send SQL)'
    )
    confirmBtn.type = 'button'
    confirmBtn.addEventListener('click', () => {
      viewState.pendingAskConfirm = false
      dispatchFixRequest(fixPanelCallbacksMap.get(container), { confirmed: true })
    })
    const cancelConfirmBtn = el(
      'button',
      'btn btn-ghost btn-sm datanoa-ai-btn datanoa-ai-confirm-cancel-btn',
      'Cancel'
    )
    cancelConfirmBtn.type = 'button'
    cancelConfirmBtn.addEventListener('click', () => {
      viewState.pendingAskConfirm = false
      renderSharedAiFixPanel(container, state, fixPanelCallbacksMap.get(container))
    })
    confirmActions.appendChild(confirmBtn)
    confirmActions.appendChild(cancelConfirmBtn)
    confirmBar.appendChild(confirmActions)
    container.appendChild(confirmBar)
  }

  if (state.phase === 'idle') {
    const scrollWrap = el('div', 'datanoa-ai-panel-scroll')
    if (effectivePolicy === 'never') {
      scrollWrap.appendChild(
        el(
          'p',
          'datanoa-ai-hint datanoa-ai-policy-blocked-msg',
          'AI assistance is disabled for this connection (policy: never).'
        )
      )
    } else if (!state.aiEnabled || !state.aiReady) {
      const note = !state.aiEnabled
        ? 'Explain & Fix AI is turned off. Enable Explain & Fix in AI SQL Assistant settings to suggest SQL fixes.'
        : 'Explain & Fix AI setup is incomplete. Configure provider credentials in AI SQL Assistant settings to suggest SQL fixes.'
      scrollWrap.appendChild(el('p', 'datanoa-ai-hint', note))
    } else if (effectivePolicy === 'ask' && !viewState.pendingAskConfirm) {
      scrollWrap.appendChild(
        el(
          'p',
          'datanoa-ai-hint',
          'Explicit confirmation is required before sending SQL from this connection to AI (policy: ask).'
        )
      )
    }
    container.appendChild(scrollWrap)
    if (isResizable && resizeEdge === 'bottom') {
      container.appendChild(createAiPanelResizer(container, resizeEdge, callbacks?.onResize))
    }
    return
  }

  if (state.phase === 'loading') {
    const scrollWrap = el('div', 'datanoa-ai-panel-scroll')
    scrollWrap.appendChild(
      createAiLoadingNode('Analyzing SQL error and schema to suggest a fix...')
    )
    container.appendChild(scrollWrap)
    return
  }

  if (state.phase === 'error') {
    const scrollWrap = el('div', 'datanoa-ai-panel-scroll')
    const errWrap = el('div', 'datanoa-ai-error-box')
    errWrap.setAttribute('role', 'alert')
    const errText =
      effectivePolicy === 'never'
        ? state.error || 'AI assistance is disabled for this connection (policy: never).'
        : state.error || 'Could not suggest a SQL fix'
    errWrap.appendChild(el('div', 'datanoa-ai-error-text', errText))
    if (effectivePolicy === 'never') {
      errWrap.appendChild(
        el(
          'div',
          'datanoa-ai-hint datanoa-ai-policy-blocked-msg',
          'AI Query Fix is blocked by connection policy (policy: never).'
        )
      )
    }
    const errActions = el('div', 'datanoa-ai-row-actions')
    if (effectivePolicy === 'never') {
      const retryBtn = el('button', 'btn btn-ghost btn-sm datanoa-ai-btn datanoa-ai-fix-trigger-btn', 'Retry')
      retryBtn.type = 'button'
      retryBtn.disabled = true
      retryBtn.setAttribute('aria-disabled', 'true')
      retryBtn.setAttribute('data-ai-policy', 'never')
      retryBtn.title = 'AI assistance is disabled for this connection (policy: never).'
      errActions.appendChild(retryBtn)
    } else if (state.aiEnabled && state.aiReady) {
      const retryBtn = el('button', 'btn btn-ghost btn-sm datanoa-ai-btn datanoa-ai-fix-trigger-btn', 'Retry')
      retryBtn.type = 'button'
      retryBtn.addEventListener('click', triggerFix)
      errActions.appendChild(retryBtn)
    }
    const cfgLabel = state.aiEnabled && state.aiReady ? 'AI Settings' : 'Configure Explain & Fix AI'
    const cfgBtn = el('button', 'btn btn-ghost btn-sm datanoa-ai-btn', cfgLabel)
    cfgBtn.type = 'button'
    cfgBtn.addEventListener('click', () => fixPanelCallbacksMap.get(container)?.onConfigureAi?.())
    errActions.appendChild(cfgBtn)
    errWrap.appendChild(errActions)
    scrollWrap.appendChild(errWrap)
    container.appendChild(scrollWrap)
    if (isResizable && resizeEdge === 'bottom') {
      container.appendChild(createAiPanelResizer(container, resizeEdge, callbacks?.onResize))
    }
    return
  }

  if (state.phase !== 'ready' || !state.result) {
    return
  }

  const res = state.result
  const scrollWrap = el('div', 'datanoa-ai-panel-scroll')
  const body = el('div', 'datanoa-ai-explain-body')
  const explanationText = String(res.explanation || '').trim()
  const changesText = String(res.changesSummary || '').trim()
  const fixedSql = String(res.fixedSql || '')

  if (explanationText) {
    body.appendChild(el('p', 'datanoa-ai-summary', explanationText))
  }
  if (changesText && changesText !== explanationText) {
    body.appendChild(el('div', 'datanoa-ai-hint datanoa-ai-fix-changes', changesText))
  }

  body.appendChild(createHighlightedSqlPre(fixedSql, state.dialect))

  const actions = el('div', 'datanoa-ai-row-actions datanoa-ai-fix-footer')
  const hasFixedSql = fixedSql.trim().length > 0

  const replaceBtn = el('button', 'btn btn-primary btn-sm datanoa-ai-btn', 'Replace Query')
  replaceBtn.type = 'button'
  replaceBtn.disabled = !hasFixedSql
  replaceBtn.addEventListener('click', () => {
    if (hasFixedSql) fixPanelCallbacksMap.get(container)?.onReplaceQuery?.(fixedSql)
  })

  const copyBtn = el('button', 'btn btn-ghost btn-sm datanoa-ai-btn', 'Copy SQL')
  copyBtn.type = 'button'
  copyBtn.disabled = !hasFixedSql
  copyBtn.addEventListener('click', () => {
    if (hasFixedSql) fixPanelCallbacksMap.get(container)?.onCopySql?.(fixedSql)
  })

  const footerDismissBtn = el('button', 'btn btn-ghost btn-sm datanoa-ai-btn', 'Dismiss')
  footerDismissBtn.type = 'button'
  footerDismissBtn.addEventListener('click', () => fixPanelCallbacksMap.get(container)?.onDismiss?.())

  actions.appendChild(replaceBtn)
  actions.appendChild(copyBtn)
  actions.appendChild(footerDismissBtn)

  scrollWrap.appendChild(body)
  container.appendChild(scrollWrap)
  container.appendChild(actions)
  if (isResizable && resizeEdge === 'bottom') {
    container.appendChild(createAiPanelResizer(container, resizeEdge, callbacks?.onResize))
  }
}

let sharedAiModalSeq = 0

const MAX_INLINE_TOKENS = 1024
const DEFAULT_INLINE_TOKENS = 96
const DEFAULT_EXPLAIN_MAX_TOKENS = 2048
const MIN_EXPLAIN_MAX_TOKENS = 256
const MAX_EXPLAIN_MAX_TOKENS = 8192
const INITIAL_VISIBLE_MODELS = 12
const SEARCH_VISIBLE_CAP = 24

function clampInlineTokens(raw) {
  const num = Number(raw)
  return Number.isFinite(num) && num > 0
    ? Math.min(MAX_INLINE_TOKENS, Math.max(16, Math.floor(num)))
    : DEFAULT_INLINE_TOKENS
}

function clampExplainTokens(raw) {
  const num = Number(raw)
  return Number.isFinite(num) && num > 0
    ? Math.min(MAX_EXPLAIN_MAX_TOKENS, Math.max(MIN_EXPLAIN_MAX_TOKENS, Math.floor(num)))
    : DEFAULT_EXPLAIN_MAX_TOKENS
}

function createInitialRoleDraft(snapshot, role) {
  const explicit = snapshot?.roles?.[role]
  const hasExplicit = Boolean(explicit && typeof explicit === 'object')
  const src = hasExplicit ? explicit : snapshot
  const format = src?.format || 'openai'
  const baseUrl =
    src && src.baseUrl !== undefined && src.baseUrl !== null
      ? String(src.baseUrl)
      : 'https://api.openai.com/v1'
  const model =
    src && src.model !== undefined && src.model !== null
      ? String(src.model)
      : 'gpt-4o-mini'
  const hasKey = Boolean(src?.hasKey)
  const usingSharedKey = role === 'explain' && hasExplicit ? Boolean(explicit.usingSharedKey) : false
  const hasOwnKey = role === 'explain' ? Boolean(hasKey && !usingSharedKey) : hasKey
  return {
    enabled: Boolean(src?.enabled),
    presetId: resolveAiPresetId(format, baseUrl),
    format,
    baseUrl,
    pinnedBaseUrl: hasOwnKey ? baseUrl : '',
    model,
    keyDraft: '',
    hasKey,
    hasOwnKey,
    usingSharedKey,
  }
}

export async function openSharedAiConfigModal(options) {
  const { rpc, saveSettings, initialStatus, initialRole, onStatusUpdated, mountModal, closeModal } = options
  const modalAbort = new AbortController()
  const modalUid = `datanoa-ai-modal-${++sharedAiModalSeq}`
  let snapshot = initialStatus || null
  try {
    snapshot = await rpc('ai.status.get', undefined, { signal: modalAbort.signal, timeoutMs: 3000 })
  } catch {
    // Keep initial snapshot on transient read error
  }

  let syncMode =
    snapshot?.sync !== undefined
      ? Boolean(snapshot.sync)
      : initialRole === 'explain'
        ? false
        : true
  let activeRole = initialRole === 'explain' ? 'explain' : 'autocomplete'

  const drafts = {
    autocomplete: {
      ...createInitialRoleDraft(snapshot, 'autocomplete'),
      maxTokens: clampInlineTokens(snapshot?.maxTokens),
    },
    explain: {
      ...createInitialRoleDraft(snapshot, 'explain'),
      explainMaxTokens: clampExplainTokens(snapshot?.explainMaxTokens),
      explainLanguage: snapshot?.explainLanguage || 'auto',
    },
  }

  const modelCaches = {
    autocomplete: {
      items: [],
      showAll: false,
      search: '',
      pinned: drafts.autocomplete.model.trim(),
      loadedKey: '',
    },
    explain: {
      items: [],
      showAll: false,
      search: '',
      pinned: drafts.explain.model.trim(),
      loadedKey: '',
    },
  }

  const activeDraftKey = () => (syncMode ? 'autocomplete' : activeRole)
  const getActiveDraft = () => drafts[activeDraftKey()]
  const getActiveCache = () => modelCaches[activeDraftKey()]

  const card = el('div', 'datanoa-ai-modal')
  card.setAttribute('role', 'dialog')
  card.setAttribute('aria-modal', 'true')

  let standaloneBackdrop = null
  let disposed = false
  let saving = false
  let mutating = false
  let loadModelsSeq = 0
  let actionSeq = 0
  let savedSplitExplainDraft = null
  const previousActiveElement =
    typeof document !== 'undefined' && document.activeElement ? document.activeElement : null
  let windowEscHandler = null

  const clearDraftSecrets = () => {
    drafts.autocomplete.keyDraft = ''
    drafts.explain.keyDraft = ''
    if (typeof keyInput !== 'undefined' && keyInput) {
      keyInput.value = ''
    }
  }

  const dispose = () => {
    if (disposed) return
    disposed = true
    modalAbort.abort()
    clearDraftSecrets()
    if (typeof feedbackBox !== 'undefined' && feedbackBox) {
      clearNode(feedbackBox)
    }
    if (windowEscHandler && typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('keydown', windowEscHandler)
      windowEscHandler = null
    }
    if (previousActiveElement && typeof previousActiveElement.focus === 'function') {
      try {
        if (previousActiveElement.isConnected !== false) {
          previousActiveElement.focus()
        }
      } catch {
        // Ignore focus restoration errors in minimal/detached DOMs
      }
    }
  }

  const close = () => {
    if (disposed) return
    dispose()
    if (closeModal) {
      closeModal()
    } else if (standaloneBackdrop && standaloneBackdrop.parentNode) {
      standaloneBackdrop.parentNode.removeChild(standaloneBackdrop)
    }
  }

  card.tabIndex = -1

  // Header: clean title + close button only
  const head = el('div', 'datanoa-ai-modal-head')
  const titleWrap = el('div', 'datanoa-ai-modal-title-wrap')
  const titleEl = el('h3', 'datanoa-ai-modal-title', 'AI SQL Assistant')
  titleEl.id = `${modalUid}-title`
  card.setAttribute('aria-labelledby', titleEl.id)
  titleWrap.appendChild(titleEl)
  head.appendChild(titleWrap)

  const closeX = el('button', 'btn btn-ghost btn-sm datanoa-ai-btn', '×')
  closeX.type = 'button'
  closeX.setAttribute('aria-label', 'Close AI SQL Assistant settings')
  closeX.addEventListener('click', close)
  head.appendChild(closeX)
  card.appendChild(head)

  // Body
  const body = el('div', 'datanoa-ai-modal-body')

  // Top Role & Sync Control Bar
  const roleBar = el('div', 'datanoa-ai-role-bar')
  const roleTabs = el('div', 'datanoa-ai-role-tabs')
  roleTabs.setAttribute('role', 'tablist')
  roleTabs.setAttribute('aria-label', 'AI task configuration')

  const createRoleTab = (role, label, ariaLabel) => {
    const tab = el('button', 'datanoa-ai-role-tab')
    tab.type = 'button'
    tab.id = `${modalUid}-tab-${role}`
    tab.setAttribute('role', 'tab')
    tab.setAttribute('data-role', role)
    if (tab.dataset) tab.dataset.role = role
    tab.setAttribute('aria-label', ariaLabel)
    tab.setAttribute('aria-controls', `${modalUid}-role-panel`)
    const dot = el('span', 'datanoa-ai-dot tone-neutral')
    dot.setAttribute('aria-hidden', 'true')
    const text = el('span', '', label)
    tab.appendChild(dot)
    tab.appendChild(text)
    return { tab, dot }
  }

  const autoTabParts = createRoleTab('autocomplete', 'Autocomplete', 'Autocomplete settings')
  const explainTabParts = createRoleTab('explain', 'Explain & Fix', 'Explain and Fix settings')
  roleTabs.appendChild(autoTabParts.tab)
  roleTabs.appendChild(explainTabParts.tab)

  const syncBtn = el('button', 'datanoa-ai-sync-btn')
  syncBtn.type = 'button'
  syncBtn.setAttribute('aria-pressed', syncMode ? 'true' : 'false')
  syncBtn.setAttribute('aria-label', 'Sync provider across Autocomplete and Explain and Fix')
  const syncIndicator = el('span', 'datanoa-ai-sync-indicator')
  syncIndicator.setAttribute('aria-hidden', 'true')
  const syncText = el('span', '', 'Sync both')
  syncBtn.appendChild(syncIndicator)
  syncBtn.appendChild(syncText)

  roleBar.appendChild(roleTabs)
  roleBar.appendChild(syncBtn)
  body.appendChild(roleBar)

  // Role Card
  const roleCard = el('div', 'datanoa-ai-role-card')
  roleCard.id = `${modalUid}-role-panel`
  roleCard.setAttribute('role', 'tabpanel')

  const roleCardHead = el('div', 'datanoa-ai-role-card-head')

  // Split mode single toggle
  const splitToggleRow = el('label', 'datanoa-ai-toggle-row')
  const splitEnabledId = `${modalUid}-role-enabled`
  splitToggleRow.htmlFor = splitEnabledId
  splitToggleRow.setAttribute('for', splitEnabledId)
  const splitEnabledCheckbox = el('input')
  splitEnabledCheckbox.type = 'checkbox'
  splitEnabledCheckbox.id = splitEnabledId
  splitEnabledCheckbox.setAttribute('aria-label', 'Enable inline SQL autocomplete')
  const splitToggleTextWrap = el('div', 'datanoa-ai-toggle-text')
  const splitToggleTitle = el('strong', '', 'Enable inline SQL autocomplete')
  const splitToggleHint = el(
    'span',
    'datanoa-ai-hint',
    'Local schema and keyword completion remains active when disabled'
  )
  splitToggleTextWrap.appendChild(splitToggleTitle)
  splitToggleTextWrap.appendChild(splitToggleHint)
  splitToggleRow.appendChild(splitEnabledCheckbox)
  splitToggleRow.appendChild(splitToggleTextWrap)

  // Sync mode dual independent toggles
  const syncTogglesWrap = el('div', 'datanoa-ai-sync-toggles')

  const createSyncToggle = (idSuffix, titleText, hintText, ariaLabel) => {
    const row = el('label', 'datanoa-ai-toggle-row')
    const cbId = `${modalUid}-${idSuffix}`
    row.htmlFor = cbId
    row.setAttribute('for', cbId)
    const cb = el('input')
    cb.type = 'checkbox'
    cb.id = cbId
    cb.setAttribute('aria-label', ariaLabel)
    const textWrap = el('div', 'datanoa-ai-toggle-text')
    textWrap.appendChild(el('strong', '', titleText))
    textWrap.appendChild(el('span', 'datanoa-ai-hint', hintText))
    row.appendChild(cb)
    row.appendChild(textWrap)
    return { row, cb }
  }

  const syncAutoToggle = createSyncToggle(
    'sync-auto-enabled',
    'Autocomplete',
    'Inline SQL ghost text',
    'Enable inline SQL autocomplete'
  )
  const syncExplainToggle = createSyncToggle(
    'sync-explain-enabled',
    'Explain & Fix',
    'Plan analysis and error fixes',
    'Enable EXPLAIN analysis and Fix with AI'
  )
  syncTogglesWrap.appendChild(syncAutoToggle.row)
  syncTogglesWrap.appendChild(syncExplainToggle.row)

  const destPill = el('span', 'datanoa-ai-pill datanoa-ai-dest-pill', 'No endpoint')
  destPill.setAttribute('data-destination', 'none')

  roleCardHead.appendChild(splitToggleRow)
  roleCardHead.appendChild(syncTogglesWrap)
  roleCardHead.appendChild(destPill)
  roleCard.appendChild(roleCardHead)

  const syncBanner = el(
    'div',
    'datanoa-ai-sync-banner',
    'Both tasks share one provider — click a tab above or turn off Sync both to configure separately'
  )
  syncBanner.hidden = !syncMode
  roleCard.appendChild(syncBanner)

  roleCard.appendChild(
    el(
      'p',
      'datanoa-ai-scope-note',
      'Sends table and column names, foreign keys, index metadata, and sanitized queries on the active connection. Table rows and credentials are never transmitted.'
    )
  )

  const grid = el('div', 'datanoa-ai-form-grid')

  const createLabeledField = (labelText, idSuffix, controlEl, ariaLabel = labelText, fullWidth = false) => {
    const controlId = `${modalUid}-${idSuffix}`
    const field = el('div', fullWidth ? 'datanoa-ai-field datanoa-ai-field-full' : 'datanoa-ai-field')
    const label = el('label', 'datanoa-ai-label', labelText)
    label.htmlFor = controlId
    label.setAttribute('for', controlId)
    controlEl.id = controlId
    controlEl.setAttribute('aria-label', ariaLabel)
    field.appendChild(label)
    return field
  }

  const presetSelect = el('select', 'datanoa-ai-input')
  const presetField = createLabeledField('Provider', 'provider', presetSelect)
  for (const p of AI_PRESET_OPTIONS) {
    const opt = el('option', '', p.label)
    opt.value = p.id
    presetSelect.appendChild(opt)
  }
  presetField.appendChild(presetSelect)
  grid.appendChild(presetField)

  const urlInput = el('input', 'datanoa-ai-input')
  urlInput.type = 'url'
  urlInput.placeholder = 'https://api.openai.com/v1'
  const urlField = createLabeledField('Base URL', 'base-url', urlInput)
  urlField.appendChild(urlInput)
  grid.appendChild(urlField)

  const modelInput = el('input', 'datanoa-ai-input')
  modelInput.type = 'text'
  modelInput.placeholder = 'e.g. gpt-4o-mini'
  const modelField = createLabeledField('Model', 'model', modelInput)
  const modelRow = el('div', 'datanoa-ai-inline-row')
  const fetchModelsBtn = el('button', 'btn btn-ghost btn-sm datanoa-ai-btn', 'Models')
  fetchModelsBtn.type = 'button'
  fetchModelsBtn.setAttribute('aria-label', 'Fetch available models')
  modelRow.appendChild(modelInput)
  modelRow.appendChild(fetchModelsBtn)
  modelField.appendChild(modelRow)
  grid.appendChild(modelField)

  const keyInput = el('input', 'datanoa-ai-input')
  keyInput.type = 'password'
  keyInput.autocomplete = 'new-password'
  keyInput.spellcheck = false
  const keyField = createLabeledField('API Key (OS keyring)', 'api-key', keyInput, 'API Key (OS keyring)')
  const keyRow = el('div', 'datanoa-ai-inline-row')
  const clearKeyBtn = el('button', 'btn btn-ghost btn-sm datanoa-ai-btn', 'Clear')
  clearKeyBtn.type = 'button'
  clearKeyBtn.setAttribute('aria-label', 'Clear saved API key')
  keyRow.appendChild(keyInput)
  keyRow.appendChild(clearKeyBtn)
  keyField.appendChild(keyRow)
  grid.appendChild(keyField)

  const tokensInput = el('input', 'datanoa-ai-input')
  tokensInput.type = 'number'
  tokensInput.min = '16'
  tokensInput.max = String(MAX_INLINE_TOKENS)
  tokensInput.value = String(drafts.autocomplete.maxTokens)
  const tokensField = createLabeledField('Inline max tokens', 'inline-max-tokens', tokensInput)
  tokensField.appendChild(tokensInput)
  grid.appendChild(tokensField)

  const explainTokensInput = el('input', 'datanoa-ai-input')
  explainTokensInput.type = 'number'
  explainTokensInput.min = String(MIN_EXPLAIN_MAX_TOKENS)
  explainTokensInput.max = String(MAX_EXPLAIN_MAX_TOKENS)
  explainTokensInput.value = String(drafts.explain.explainMaxTokens)
  const explainTokensField = createLabeledField(
    'EXPLAIN & Fix max tokens',
    'explain-max-tokens',
    explainTokensInput
  )
  explainTokensField.appendChild(explainTokensInput)
  grid.appendChild(explainTokensField)

  const langSelect = el('select', 'datanoa-ai-input')
  populateLanguageSelect(langSelect, drafts.explain.explainLanguage)
  const langField = createLabeledField('Response language', 'explain-language', langSelect, 'Response language', true)
  langField.appendChild(langSelect)
  grid.appendChild(langField)

  roleCard.appendChild(grid)

  // Autocomplete model capability guidance
  const autoTipEl = el('div', 'datanoa-ai-inline-tip')
  autoTipEl.setAttribute('role', 'note')
  autoTipEl.appendChild(el('strong', 'datanoa-ai-inline-tip-title', 'Recommended for autocomplete:'))
  autoTipEl.appendChild(
    createTextOrSpan(
      ' Base/FIM-only models only insert at the cursor and cannot rewrite broken SQL. Pick an instruction or chat model with FIM support for both inline completions and fixes, or set an instruction/chat model on EXPLAIN for Fix with AI.'
    )
  )
  autoTipEl.hidden = syncMode || activeRole !== 'autocomplete'
  roleCard.appendChild(autoTipEl)

  // Non-blocking FIM-only model warning
  const fimWarnEl = el('div', 'datanoa-ai-inline-warn')
  fimWarnEl.setAttribute('role', 'note')
  fimWarnEl.hidden = true
  roleCard.appendChild(fimWarnEl)

  // Model picker panel
  const modelsPanelEl = el('div', 'datanoa-ai-models-panel')
  modelsPanelEl.hidden = true

  const modelsBarEl = el('div', 'datanoa-ai-models-bar')
  const modelSearchInput = el('input', 'datanoa-ai-input datanoa-ai-model-search')
  modelSearchInput.id = `${modalUid}-model-search`
  modelSearchInput.type = 'search'
  modelSearchInput.placeholder = 'Search models'
  modelSearchInput.setAttribute('aria-label', 'Search loaded models')
  const modelsCountEl = el('span', 'datanoa-ai-models-count')
  const toggleModelsBtn = el('button', 'btn btn-ghost btn-sm datanoa-ai-btn', 'Show all')
  toggleModelsBtn.type = 'button'
  toggleModelsBtn.setAttribute('aria-label', 'Show all models')
  toggleModelsBtn.hidden = true
  modelsBarEl.appendChild(modelSearchInput)
  modelsBarEl.appendChild(modelsCountEl)
  modelsBarEl.appendChild(toggleModelsBtn)

  const modelsResultEl = el('div', 'datanoa-ai-models-strip')
  modelsPanelEl.appendChild(modelsBarEl)
  modelsPanelEl.appendChild(modelsResultEl)
  roleCard.appendChild(modelsPanelEl)

  body.appendChild(roleCard)

  const feedbackBox = el('div', 'datanoa-ai-feedback')
  feedbackBox.setAttribute('role', 'status')
  feedbackBox.setAttribute('aria-live', 'polite')
  feedbackBox.hidden = true
  body.appendChild(feedbackBox)

  const setFeedback = (text, tone) => {
    feedbackBox.hidden = !text
    feedbackBox.className = `datanoa-ai-feedback ${tone ? `tone-${tone}` : ''}`
    feedbackBox.setAttribute('role', tone === 'error' ? 'alert' : 'status')
    clearNode(feedbackBox)
    if (!text) return
    if (tone === 'loading') {
      feedbackBox.appendChild(createAiLoadingNode(text, 'is-compact'))
    } else {
      feedbackBox.textContent = text
    }
  }

  // Telemetry strip (Autocomplete & Sync mode only)
  const statsBox = el('div', 'datanoa-ai-stats-box')
  const statsValuesEl = el('div', 'datanoa-ai-stats-values', 'Loading telemetry...')
  const resetStatsBtn = el('button', 'btn btn-ghost btn-sm datanoa-ai-btn', 'Reset')
  resetStatsBtn.type = 'button'
  resetStatsBtn.setAttribute('aria-label', 'Reset AI telemetry statistics')
  statsBox.appendChild(statsValuesEl)
  statsBox.appendChild(resetStatsBtn)
  body.appendChild(statsBox)

  card.appendChild(body)

  // Footer Actions
  const actions = el('div', 'datanoa-ai-modal-actions')
  const testBtn = el('button', 'btn btn-ghost btn-sm datanoa-ai-btn', 'Test Connection')
  testBtn.type = 'button'
  testBtn.setAttribute('aria-label', 'Test Connection')
  const benchBtn = el('button', 'btn btn-ghost btn-sm datanoa-ai-btn', 'Benchmark')
  benchBtn.type = 'button'
  benchBtn.setAttribute('aria-label', 'Benchmark')
  const spacer = el('div', 'datanoa-ai-spacer')
  const cancelBtn = el('button', 'btn btn-ghost btn-sm datanoa-ai-btn', 'Cancel')
  cancelBtn.type = 'button'
  cancelBtn.setAttribute('aria-label', 'Cancel')
  cancelBtn.addEventListener('click', close)

  const saveBtn = el('button', 'btn btn-primary btn-sm datanoa-ai-btn', 'Save')
  saveBtn.type = 'button'
  saveBtn.setAttribute('aria-label', 'Save')

  actions.appendChild(testBtn)
  actions.appendChild(benchBtn)
  actions.appendChild(spacer)
  actions.appendChild(cancelBtn)
  actions.appendChild(saveBtn)
  card.appendChild(actions)

  const syncRoleTabDots = (snap) => {
    const badge = formatAiStatusBadge(snap)
    autoTabParts.dot.className = `datanoa-ai-dot tone-${badge.autocompleteTone}`
    explainTabParts.dot.className = `datanoa-ai-dot tone-${badge.explainTone}`
  }

  const syncDestinationIndicator = (useSnapshotFallback = false) => {
    const roleKey = activeDraftKey()
    const snapRole = useSnapshotFallback ? resolveSnapshotRole(snapshot, roleKey) : null
    const info = describeEndpointDestination(
      urlInput.value,
      snapRole ? snapRole.destination : undefined,
      snapRole ? snapRole.host : undefined
    )
    destPill.setAttribute('data-destination', info.destination)
    destPill.textContent = info.label
    destPill.title =
      info.destination === 'local'
        ? `Requests stay on local host ${info.host}`
        : info.destination === 'remote'
          ? `Requests are sent to external host ${info.host}`
          : 'No AI endpoint URL configured'
  }

  const syncKeyPlaceholderAndClearBtn = () => {
    const draft = getActiveDraft()
    const preset = AI_PRESET_OPTIONS.find((p) => p.id === draft.presetId) || AI_PRESET_OPTIONS[0]
    const isSplitExplain = !syncMode && activeRole === 'explain'
    const currentNormUrl = normUrl(draft.baseUrl)
    const autoHasPinnedKeyForUrl =
      Boolean(drafts.autocomplete.hasKey) &&
      Boolean(currentNormUrl) &&
      currentNormUrl === normUrl(drafts.autocomplete.pinnedBaseUrl)
    const draftHasPinnedOwnKey =
      Boolean(isSplitExplain ? draft.hasOwnKey : draft.hasKey) &&
      Boolean(currentNormUrl) &&
      currentNormUrl === normUrl(draft.pinnedBaseUrl)

    if (isSplitExplain && !draftHasPinnedOwnKey) {
      draft.usingSharedKey = autoHasPinnedKeyForUrl
      draft.hasKey = autoHasPinnedKeyForUrl
    }

    if (preset.keyKind === 'none') {
      draft.keyDraft = ''
      keyInput.value = ''
      keyInput.disabled = true
      keyInput.placeholder = preset.keyPlaceholder
      clearKeyBtn.disabled = !draftHasPinnedOwnKey
      return
    }
    keyInput.disabled = false

    if (isSplitExplain && draft.usingSharedKey && !draftHasPinnedOwnKey) {
      keyInput.placeholder = 'Reusing Autocomplete key on this host — paste to override'
      clearKeyBtn.disabled = true
      return
    }

    const hasStoredOwnKey = draftHasPinnedOwnKey
    keyInput.placeholder = hasStoredOwnKey
      ? 'Saved in OS keyring — paste to replace'
      : preset.keyPlaceholder
    clearKeyBtn.disabled = !hasStoredOwnKey
  }

  const syncFimWarning = () => {
    const draft = getActiveDraft()
    const checkExplain = (!syncMode && activeRole === 'explain') || (syncMode && drafts.explain.enabled)
    if (checkExplain && isLikelyFimOnlyModel(draft.format, draft.model)) {
      fimWarnEl.hidden = false
      fimWarnEl.textContent = syncMode
        ? 'Base and FIM models work best for inline autocomplete. For EXPLAIN and Fix with AI, pick an instruction or chat model or disable Sync both.'
        : 'Base and FIM models work best for inline autocomplete. Pick an instruction or chat model for EXPLAIN analysis and Fix with AI.'
    } else {
      fimWarnEl.hidden = true
      fimWarnEl.textContent = ''
    }
  }

  const getSortedAndFilteredModels = (cache) => {
    const tokens = modelSearchInput.value.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const sorted = [...cache.items].sort((a, b) => {
      const aPinned = cache.pinned && a.model === cache.pinned ? 0 : 1
      const bPinned = cache.pinned && b.model === cache.pinned ? 0 : 1
      if (aPinned !== bPinned) return aPinned - bPinned
      const aHasMs = typeof a.ms === 'number'
      const bHasMs = typeof b.ms === 'number'
      if (aHasMs !== bHasMs) return aHasMs ? -1 : 1
      if (aHasMs && bHasMs && a.ms !== b.ms) return a.ms - b.ms
      return a.order - b.order
    })
    const filtered =
      tokens.length === 0
        ? sorted
        : sorted.filter((item) => {
            const lower = item.model.toLowerCase()
            return tokens.every((tok) => lower.includes(tok))
          })
    return { filtered, isSearching: tokens.length > 0 }
  }

  const renderModelList = () => {
    const cache = getActiveCache()
    clearNode(modelsResultEl)
    if (cache.items.length === 0) {
      modelsPanelEl.hidden = true
      toggleModelsBtn.hidden = true
      return
    }
    modelsPanelEl.hidden = false
    const { filtered, isSearching } = getSortedAndFilteredModels(cache)
    const cap = isSearching ? SEARCH_VISIBLE_CAP : INITIAL_VISIBLE_MODELS
    const visible = cache.showAll ? filtered : filtered.slice(0, cap)
    const currentModel = modelInput.value.trim()

    if (filtered.length > cap) {
      toggleModelsBtn.hidden = false
      toggleModelsBtn.textContent = cache.showAll ? 'Show less' : `Show all (${filtered.length})`
      toggleModelsBtn.setAttribute(
        'aria-label',
        cache.showAll ? 'Show fewer models' : `Show all ${filtered.length} models`
      )
    } else {
      toggleModelsBtn.hidden = true
    }

    modelsCountEl.textContent = isSearching
      ? `${filtered.length}/${cache.items.length} matched`
      : `${cache.items.length} models`

    if (visible.length === 0) {
      modelsResultEl.appendChild(
        el('span', 'datanoa-ai-hint', `No models match "${modelSearchInput.value.trim()}"`)
      )
      return
    }

    for (const item of visible) {
      const label = typeof item.ms === 'number' ? `${item.model} (${item.ms}ms)` : item.model
      const isSelected = item.model === currentModel
      const chip = el('button', `datanoa-ai-chip${isSelected ? ' is-selected' : ''}`, label)
      chip.type = 'button'
      chip.title = item.model
      chip.setAttribute('aria-label', `Select model ${item.model}`)
      chip.addEventListener('click', () => {
        modelInput.value = item.model
        getActiveDraft().model = item.model
        syncFimWarning()
        renderModelList()
      })
      modelsResultEl.appendChild(chip)
    }
  }

  const captureFormIntoDrafts = () => {
    const draft = getActiveDraft()
    draft.presetId = presetSelect.value || draft.presetId
    const preset = AI_PRESET_OPTIONS.find((p) => p.id === draft.presetId) || AI_PRESET_OPTIONS[0]
    draft.format = preset.format
    draft.baseUrl = urlInput.value
    draft.model = modelInput.value
    draft.keyDraft = keyInput.value
    getActiveCache().search = modelSearchInput.value

    if (syncMode) {
      drafts.autocomplete.enabled = syncAutoToggle.cb.checked
      drafts.explain.enabled = syncExplainToggle.cb.checked
      drafts.autocomplete.maxTokens = clampInlineTokens(tokensInput.value)
      drafts.explain.explainMaxTokens = clampExplainTokens(explainTokensInput.value)
      drafts.explain.explainLanguage = langSelect.value || 'auto'
    } else if (activeRole === 'autocomplete') {
      drafts.autocomplete.enabled = splitEnabledCheckbox.checked
      drafts.autocomplete.maxTokens = clampInlineTokens(tokensInput.value)
    } else {
      drafts.explain.enabled = splitEnabledCheckbox.checked
      drafts.explain.explainMaxTokens = clampExplainTokens(explainTokensInput.value)
      drafts.explain.explainLanguage = langSelect.value || 'auto'
    }
  }

  const syncViewFromDrafts = (useSnapshotFallback = false) => {
    const isSplitExplain = !syncMode && activeRole === 'explain'
    const draft = getActiveDraft()
    const preset = AI_PRESET_OPTIONS.find((p) => p.id === draft.presetId) || AI_PRESET_OPTIONS[0]

    roleTabs.classList.toggle('is-synced', syncMode)
    autoTabParts.tab.setAttribute('aria-selected', !syncMode && activeRole === 'autocomplete' ? 'true' : 'false')
    explainTabParts.tab.setAttribute('aria-selected', isSplitExplain ? 'true' : 'false')

    syncBtn.setAttribute('aria-pressed', syncMode ? 'true' : 'false')
    syncBtn.classList.toggle('is-active', syncMode)

    roleCard.setAttribute('data-mode', syncMode ? 'sync' : activeRole)
    roleCard.setAttribute(
      'aria-labelledby',
      syncMode ? titleEl.id : activeRole === 'explain' ? explainTabParts.tab.id : autoTabParts.tab.id
    )

    syncBanner.hidden = !syncMode
    splitToggleRow.hidden = syncMode
    syncTogglesWrap.hidden = !syncMode

    if (syncMode) {
      syncAutoToggle.cb.checked = drafts.autocomplete.enabled
      syncExplainToggle.cb.checked = drafts.explain.enabled
    } else if (isSplitExplain) {
      splitEnabledCheckbox.checked = drafts.explain.enabled
      splitEnabledCheckbox.setAttribute('aria-label', 'Enable EXPLAIN analysis and Fix with AI')
      splitToggleTitle.textContent = 'Enable EXPLAIN analysis & Fix with AI'
      splitToggleHint.textContent = 'Used for query plan analysis and SQL error fixes'
    } else {
      splitEnabledCheckbox.checked = drafts.autocomplete.enabled
      splitEnabledCheckbox.setAttribute('aria-label', 'Enable inline SQL autocomplete')
      splitToggleTitle.textContent = 'Enable inline SQL autocomplete'
      splitToggleHint.textContent = 'Local schema and keyword completion remains active when disabled'
    }

    presetSelect.value = preset.id
    urlInput.readOnly = !preset.editableUrl
    urlInput.value = draft.baseUrl
    modelInput.value = draft.model
    keyInput.value = draft.keyDraft

    tokensInput.value = String(drafts.autocomplete.maxTokens)
    explainTokensInput.value = String(drafts.explain.explainMaxTokens)
    langSelect.value = drafts.explain.explainLanguage || 'auto'

    tokensField.hidden = isSplitExplain
    explainTokensField.hidden = !syncMode && activeRole === 'autocomplete'
    langField.hidden = !syncMode && activeRole === 'autocomplete'
    langField.classList.toggle('datanoa-ai-field-full', syncMode)

    statsBox.hidden = isSplitExplain
    benchBtn.hidden = isSplitExplain

    const testLabel = syncMode
      ? 'Test Connection'
      : isSplitExplain
        ? 'Test Explain & Fix'
        : 'Test Autocomplete'
    testBtn.textContent = testLabel
    testBtn.setAttribute('aria-label', testLabel)

    modelSearchInput.value = getActiveCache().search
    autoTipEl.hidden = syncMode || activeRole !== 'autocomplete'
    syncDestinationIndicator(useSnapshotFallback)
    syncKeyPlaceholderAndClearBtn()
    syncFimWarning()
    renderModelList()
  }

  const loadModels = async (opts = {}) => {
    const silent = Boolean(opts.silent)
    const targetKey = activeDraftKey()
    const targetDraft = drafts[targetKey]
    const targetCache = modelCaches[targetKey]
    const baseUrl = targetDraft.baseUrl.trim()
    if (!/^https?:\/\//i.test(baseUrl)) {
      if (!silent) setFeedback('Enter a valid http:// or https:// base URL', 'error')
      return
    }
    const preset = AI_PRESET_OPTIONS.find((p) => p.id === targetDraft.presetId) || AI_PRESET_OPTIONS[0]
    const cacheSignature = `${targetDraft.format}|${normUrl(baseUrl)}`
    const mySeq = ++loadModelsSeq
    fetchModelsBtn.disabled = true
    fetchModelsBtn.classList.add('is-loading')
    if (!silent) setFeedback('Loading models...', 'loading')
    try {
      const res = await rpc(
        'ai.models.list',
        {
          format: targetDraft.format,
          baseUrl,
          key: preset.keyKind === 'none' ? '' : targetDraft.keyDraft.trim(),
          role: targetKey,
        },
        { signal: modalAbort.signal }
      )
      if (disposed || mySeq !== loadModelsSeq) return
      const curSig = `${drafts[targetKey].format}|${normUrl(drafts[targetKey].baseUrl)}`
      if (curSig !== cacheSignature) return
      if (!res?.ok) {
        if (!silent) setFeedback(res?.message || 'Could not list models', 'error')
        return
      }
      let usageMap = {}
      try {
        const usageRes = await rpc(
          'ai.models.usage',
          { baseUrl },
          { signal: modalAbort.signal }
        )
        usageMap = usageRes?.usage || {}
      } catch {
        // Best-effort latency hints
      }
      if (disposed || mySeq !== loadModelsSeq) return
      const curSigAfter = `${drafts[targetKey].format}|${normUrl(drafts[targetKey].baseUrl)}`
      if (curSigAfter !== cacheSignature) return
      const rawModels = Array.isArray(res.models) ? res.models : []
      targetCache.showAll = false
      targetCache.pinned = targetDraft.model.trim()
      targetCache.loadedKey = cacheSignature
      targetCache.items = rawModels.map((model, idx) => ({
        model,
        order: idx,
        ms: typeof usageMap[model]?.ms === 'number' ? usageMap[model].ms : undefined,
      }))
      if (activeDraftKey() === targetKey) {
        renderModelList()
      }
      if (!silent) {
        setFeedback(
          targetCache.items.length > 0
            ? `Loaded ${targetCache.items.length} model(s). Search or click a model to select it.`
            : 'Provider returned 0 compatible models',
          targetCache.items.length > 0 ? 'ok' : 'neutral'
        )
      }
    } catch (err) {
      if (!disposed && mySeq === loadModelsSeq && !silent) {
        setFeedback(err instanceof Error ? err.message : String(err), 'error')
      }
    } finally {
      if (!disposed && mySeq === loadModelsSeq) {
        fetchModelsBtn.disabled = false
        fetchModelsBtn.classList.remove('is-loading')
      }
    }
  }

  const maybeSilentLoadModelsForActiveRole = () => {
    const draft = getActiveDraft()
    const isRoleEnabled = syncMode
      ? Boolean(drafts.autocomplete.enabled || drafts.explain.enabled)
      : Boolean(draft.enabled)
    if (!isRoleEnabled) {
      return
    }
    const cache = getActiveCache()
    const preset = AI_PRESET_OPTIONS.find((p) => p.id === draft.presetId) || AI_PRESET_OPTIONS[0]
    const baseUrl = draft.baseUrl.trim()
    const currentNormUrl = normUrl(baseUrl)
    const sig = `${draft.format}|${currentNormUrl}`
    const hasPinnedKeyForUrl =
      Boolean(currentNormUrl) &&
      ((Boolean(draft.hasOwnKey) && currentNormUrl === normUrl(draft.pinnedBaseUrl)) ||
        (Boolean(draft.usingSharedKey) &&
          Boolean(drafts.autocomplete.hasKey) &&
          currentNormUrl === normUrl(drafts.autocomplete.pinnedBaseUrl)) ||
        (syncMode && Boolean(draft.hasKey) && currentNormUrl === normUrl(draft.pinnedBaseUrl)))
    if (
      cache.items.length === 0 &&
      cache.loadedKey !== sig &&
      /^https?:\/\//i.test(baseUrl) &&
      (preset.keyKind === 'none' || hasPinnedKeyForUrl)
    ) {
      void loadModels({ silent: true })
    }
  }

  const setSyncMode = (nextSync, targetRole) => {
    if (nextSync === syncMode) {
      if (!syncMode && targetRole && targetRole !== activeRole) {
        captureFormIntoDrafts()
        activeRole = targetRole
        setFeedback('', '')
        syncViewFromDrafts(false)
        maybeSilentLoadModelsForActiveRole()
      }
      return
    }
    captureFormIntoDrafts()
    if (nextSync) {
      savedSplitExplainDraft = {
        presetId: drafts.explain.presetId,
        format: drafts.explain.format,
        baseUrl: drafts.explain.baseUrl,
        model: drafts.explain.model,
        hasKey: drafts.explain.hasKey,
        hasOwnKey: drafts.explain.hasOwnKey,
        usingSharedKey: drafts.explain.usingSharedKey,
        pinnedBaseUrl: drafts.explain.pinnedBaseUrl,
      }
      const src = drafts[activeRole]
      const srcNormUrl = normUrl(src.baseUrl)
      drafts.autocomplete.presetId = src.presetId
      drafts.autocomplete.format = src.format
      drafts.autocomplete.baseUrl = src.baseUrl
      drafts.autocomplete.model = src.model
      drafts.autocomplete.keyDraft = src.keyDraft
      if (activeRole === 'explain') {
        const autoKeptOwnKey =
          Boolean(drafts.autocomplete.hasOwnKey) &&
          Boolean(srcNormUrl) &&
          srcNormUrl === normUrl(drafts.autocomplete.pinnedBaseUrl)
        const explainHasHostKey =
          Boolean(src.hasOwnKey) &&
          Boolean(srcNormUrl) &&
          srcNormUrl === normUrl(src.pinnedBaseUrl)
        const explainReusesAutoKey =
          Boolean(src.usingSharedKey) &&
          Boolean(drafts.autocomplete.hasKey) &&
          Boolean(srcNormUrl) &&
          srcNormUrl === normUrl(drafts.autocomplete.pinnedBaseUrl)
        const hasHostKey = Boolean(autoKeptOwnKey || explainHasHostKey || explainReusesAutoKey)
        drafts.autocomplete.hasKey = hasHostKey
        drafts.autocomplete.usingSharedKey = Boolean(!autoKeptOwnKey && explainHasHostKey)
        if (hasHostKey && !autoKeptOwnKey) {
          drafts.autocomplete.pinnedBaseUrl = src.baseUrl
        }
      }
      if (activeRole === 'explain' && modelCaches.explain.items.length > 0) {
        modelCaches.autocomplete.items = modelCaches.explain.items.map((item) => ({ ...item }))
        modelCaches.autocomplete.pinned = src.model.trim()
        modelCaches.autocomplete.loadedKey = modelCaches.explain.loadedKey
        modelCaches.autocomplete.showAll = false
      }
      syncMode = true
    } else {
      if (savedSplitExplainDraft) {
        drafts.explain.presetId = savedSplitExplainDraft.presetId
        drafts.explain.format = savedSplitExplainDraft.format
        drafts.explain.baseUrl = savedSplitExplainDraft.baseUrl
        drafts.explain.model = savedSplitExplainDraft.model
        drafts.explain.hasKey = savedSplitExplainDraft.hasKey
        drafts.explain.hasOwnKey = savedSplitExplainDraft.hasOwnKey
        drafts.explain.usingSharedKey = savedSplitExplainDraft.usingSharedKey
        drafts.explain.pinnedBaseUrl = savedSplitExplainDraft.pinnedBaseUrl
        savedSplitExplainDraft = null
      } else {
        drafts.explain.presetId = drafts.autocomplete.presetId
        drafts.explain.format = drafts.autocomplete.format
        drafts.explain.baseUrl = drafts.autocomplete.baseUrl
        drafts.explain.model = drafts.autocomplete.model
        if (!drafts.explain.hasOwnKey && drafts.autocomplete.hasKey) {
          drafts.explain.hasKey = true
          drafts.explain.usingSharedKey = true
        }
      }
      // Never copy typed unsaved API key across roles when splitting Sync mode
      drafts.explain.keyDraft = ''
      if (modelCaches.explain.items.length === 0 && modelCaches.autocomplete.items.length > 0) {
        modelCaches.explain.items = modelCaches.autocomplete.items.map((item) => ({ ...item }))
        modelCaches.explain.pinned = drafts.explain.model.trim()
        modelCaches.explain.loadedKey = modelCaches.autocomplete.loadedKey
        modelCaches.explain.showAll = false
      }
      syncMode = false
      if (targetRole === 'autocomplete' || targetRole === 'explain') {
        activeRole = targetRole
      }
    }
    setFeedback('', '')
    syncViewFromDrafts(false)
    maybeSilentLoadModelsForActiveRole()
  }

  const selectRoleTab = (role) => {
    if (syncMode) {
      setSyncMode(false, role)
      return
    }
    if (activeRole === role) return
    captureFormIntoDrafts()
    activeRole = role
    setFeedback('', '')
    syncViewFromDrafts(false)
    maybeSilentLoadModelsForActiveRole()
  }

  const toggleSyncMode = () => {
    setSyncMode(!syncMode)
  }

  autoTabParts.tab.addEventListener('click', () => selectRoleTab('autocomplete'))
  explainTabParts.tab.addEventListener('click', () => selectRoleTab('explain'))
  syncBtn.addEventListener('click', toggleSyncMode)

  splitEnabledCheckbox.addEventListener('change', () => {
    drafts[activeRole].enabled = splitEnabledCheckbox.checked
    syncFimWarning()
  })
  syncAutoToggle.cb.addEventListener('change', () => {
    drafts.autocomplete.enabled = syncAutoToggle.cb.checked
  })
  syncExplainToggle.cb.addEventListener('change', () => {
    drafts.explain.enabled = syncExplainToggle.cb.checked
    syncFimWarning()
  })

  const originOfUrl = (raw) => {
    try {
      const parsed = new URL(String(raw || '').trim())
      return parsed.origin.toLowerCase()
    } catch {
      return ''
    }
  }

  roleTabs.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      const nextRole =
        e.key === 'Home'
          ? 'autocomplete'
          : e.key === 'End'
            ? 'explain'
            : activeRole === 'autocomplete'
              ? 'explain'
              : 'autocomplete'
      selectRoleTab(nextRole)
      const targetTab = nextRole === 'explain' ? explainTabParts.tab : autoTabParts.tab
      targetTab.focus?.()
    }
  })

  presetSelect.addEventListener('change', () => {
    const draft = getActiveDraft()
    const preset = AI_PRESET_OPTIONS.find((p) => p.id === presetSelect.value) || AI_PRESET_OPTIONS[0]
    draft.presetId = preset.id
    draft.format = preset.format
    // Always clear any unsaved typed API key when switching providers to prevent cross-host exfiltration
    draft.keyDraft = ''
    keyInput.value = ''
    urlInput.readOnly = !preset.editableUrl
    if (preset.baseUrl !== null && preset.baseUrl !== '') {
      draft.baseUrl = preset.baseUrl
      urlInput.value = preset.baseUrl
    } else if (preset.baseUrl === '') {
      const currentAddr = normUrl(urlInput.value)
      if (AI_PRESET_OPTIONS.some((p) => p.baseUrl && normUrl(p.baseUrl) === currentAddr)) {
        draft.baseUrl = ''
        urlInput.value = ''
      }
    }
    if (preset.model) {
      draft.model = preset.model
      modelInput.value = preset.model
    }
    const cache = getActiveCache()
    cache.items = []
    cache.showAll = false
    cache.search = ''
    cache.loadedKey = ''
    modelSearchInput.value = ''
    syncDestinationIndicator(false)
    syncKeyPlaceholderAndClearBtn()
    syncFimWarning()
    renderModelList()
  })

  urlInput.addEventListener('input', () => {
    const draft = getActiveDraft()
    const prevOrigin = originOfUrl(draft.baseUrl)
    const nextOrigin = originOfUrl(urlInput.value)
    if (prevOrigin && nextOrigin && prevOrigin !== nextOrigin && draft.keyDraft) {
      // Clear unsaved typed API key when host/origin changes so a key is never sent to a different host
      draft.keyDraft = ''
      keyInput.value = ''
    }
    draft.baseUrl = urlInput.value
    syncDestinationIndicator(false)
    syncKeyPlaceholderAndClearBtn()
    syncFimWarning()
  })

  modelInput.addEventListener('input', () => {
    getActiveDraft().model = modelInput.value
    syncFimWarning()
    if (getActiveCache().items.length > 0) renderModelList()
  })

  keyInput.addEventListener('input', () => {
    getActiveDraft().keyDraft = keyInput.value
  })

  tokensInput.addEventListener('input', () => {
    drafts.autocomplete.maxTokens = clampInlineTokens(tokensInput.value)
  })

  explainTokensInput.addEventListener('input', () => {
    drafts.explain.explainMaxTokens = clampExplainTokens(explainTokensInput.value)
  })

  langSelect.addEventListener('change', () => {
    drafts.explain.explainLanguage = langSelect.value || 'auto'
  })

  modelSearchInput.addEventListener('input', () => {
    const cache = getActiveCache()
    cache.search = modelSearchInput.value
    cache.showAll = false
    renderModelList()
  })

  toggleModelsBtn.addEventListener('click', () => {
    const cache = getActiveCache()
    cache.showAll = !cache.showAll
    renderModelList()
  })

  const refreshStats = async () => {
    try {
      const s = await rpc('ai.stats.get', undefined, { signal: modalAbort.signal })
      if (disposed) return
      const sum = s?.summary || {}
      const p50 = typeof sum.p50 === 'number' ? `${sum.p50}ms` : '—'
      const p95 = typeof sum.p95 === 'number' ? `${sum.p95}ms` : '—'
      statsValuesEl.textContent =
        `Shown ${sum.shown ?? 0} · Accepted ${sum.accepted ?? 0} · Kept ${sum.kept ?? 0} · p50 ${p50} · p95 ${p95}`
    } catch {
      if (!disposed) statsValuesEl.textContent = 'Stats unavailable'
    }
  }

  const syncKeyFlagsFromSnapshot = (fresh) => {
    if (!fresh) return
    const autoSnap = resolveSnapshotRole(fresh, 'autocomplete')
    const expSnap = resolveSnapshotRole(fresh, 'explain')
    drafts.autocomplete.hasKey = autoSnap.hasKey
    drafts.autocomplete.usingSharedKey = autoSnap.usingSharedKey
    drafts.autocomplete.hasOwnKey = Boolean(autoSnap.hasKey && !autoSnap.usingSharedKey)
    drafts.autocomplete.pinnedBaseUrl = autoSnap.hasKey ? autoSnap.baseUrl : ''
    drafts.explain.hasKey = expSnap.hasKey
    drafts.explain.usingSharedKey = expSnap.usingSharedKey
    drafts.explain.hasOwnKey = Boolean(expSnap.hasKey && !expSnap.usingSharedKey)
    drafts.explain.pinnedBaseUrl = drafts.explain.hasOwnKey ? expSnap.baseUrl : ''
  }

  const persistCurrentDraft = async () => {
    captureFormIntoDrafts()
    const auto = drafts.autocomplete
    const exp = syncMode
      ? {
          ...drafts.explain,
          format: auto.format,
          baseUrl: auto.baseUrl,
          model: auto.model,
        }
      : drafts.explain

    const autoUrl = auto.baseUrl.trim()
    const expUrl = exp.baseUrl.trim()
    const maxTokens = clampInlineTokens(auto.maxTokens)
    const explainMaxTokens = clampExplainTokens(exp.explainMaxTokens)
    const forceKeys = exp.enabled !== snapshot?.roles?.explain?.enabled ? ['aiExplainEnabled'] : []
    const settingsPatch = {
      aiEnabled: auto.enabled,
      aiFormat: auto.format,
      aiBaseUrl: autoUrl,
      aiModel: auto.model.trim(),
      aiMaxTokens: maxTokens,
      aiSync: syncMode,
      aiExplainEnabled: exp.enabled,
      aiExplainFormat: exp.format,
      aiExplainBaseUrl: expUrl,
      aiExplainModel: exp.model.trim(),
      aiExplainMaxTokens: explainMaxTokens,
      aiExplainLanguage: exp.explainLanguage || 'auto',
    }

    await (forceKeys.length > 0 ? saveSettings(settingsPatch, { forceKeys }) : saveSettings(settingsPatch))
    if (disposed) return null

    if (syncMode) {
      const autoPreset = AI_PRESET_OPTIONS.find((p) => p.id === auto.presetId) || AI_PRESET_OPTIONS[0]
      const draftKey = autoPreset.keyKind === 'none' ? '' : auto.keyDraft.trim()
      if (draftKey) {
        const keyRes = await rpc(
          'ai.key.set',
          { key: draftKey, baseUrl: autoUrl, role: 'autocomplete' },
          { signal: modalAbort.signal }
        )
        if (disposed) return null
        auto.keyDraft = ''
        keyInput.value = ''
        auto.hasKey = Boolean(keyRes?.hasKey)
        auto.hasOwnKey = auto.hasKey
        auto.pinnedBaseUrl = auto.hasKey ? autoUrl : ''
      }
    } else {
      const autoPreset = AI_PRESET_OPTIONS.find((p) => p.id === auto.presetId) || AI_PRESET_OPTIONS[0]
      const autoDraftKey = autoPreset.keyKind === 'none' ? '' : auto.keyDraft.trim()
      if (autoDraftKey) {
        const keyRes = await rpc(
          'ai.key.set',
          { key: autoDraftKey, baseUrl: autoUrl, role: 'autocomplete' },
          { signal: modalAbort.signal }
        )
        if (disposed) return null
        auto.keyDraft = ''
        auto.hasKey = Boolean(keyRes?.hasKey)
        auto.hasOwnKey = auto.hasKey
        auto.pinnedBaseUrl = auto.hasKey ? autoUrl : ''
      }
      const expPreset = AI_PRESET_OPTIONS.find((p) => p.id === drafts.explain.presetId) || AI_PRESET_OPTIONS[0]
      const expDraftKey = expPreset.keyKind === 'none' ? '' : drafts.explain.keyDraft.trim()
      if (expDraftKey) {
        const keyRes = await rpc(
          'ai.key.set',
          { key: expDraftKey, baseUrl: expUrl, role: 'explain' },
          { signal: modalAbort.signal }
        )
        if (disposed) return null
        drafts.explain.keyDraft = ''
        drafts.explain.hasKey = Boolean(keyRes?.hasKey)
        drafts.explain.hasOwnKey = Boolean(keyRes?.hasKey)
        drafts.explain.usingSharedKey = false
        drafts.explain.pinnedBaseUrl = drafts.explain.hasOwnKey ? expUrl : ''
      }
      keyInput.value = ''
    }

    const fresh = await rpc('ai.status.get', undefined, { signal: modalAbort.signal })
    if (disposed) return null
    snapshot = fresh
    syncKeyFlagsFromSnapshot(fresh)
    syncRoleTabDots(fresh)
    syncDestinationIndicator(true)
    syncKeyPlaceholderAndClearBtn()
    onStatusUpdated?.(fresh)
    return fresh
  }

  clearKeyBtn.addEventListener('click', async () => {
    if (mutating || saving || disposed) return
    mutating = true
    const mySeq = ++actionSeq
    const role = activeDraftKey()
    const clearSynced = syncMode
    clearKeyBtn.disabled = true
    try {
      await rpc(
        'ai.key.set',
        { key: '', baseUrl: drafts[role].baseUrl.trim(), role, clearSynced },
        { signal: modalAbort.signal }
      )
      if (disposed || mySeq !== actionSeq) return
      drafts[role].keyDraft = ''
      if (clearSynced) {
        drafts.autocomplete.keyDraft = ''
        drafts.explain.keyDraft = ''
      }
      keyInput.value = ''
      const fresh = await rpc('ai.status.get', undefined, { signal: modalAbort.signal })
      if (disposed || mySeq !== actionSeq) return
      snapshot = fresh
      syncKeyFlagsFromSnapshot(fresh)
      syncRoleTabDots(fresh)
      syncDestinationIndicator(false)
      syncKeyPlaceholderAndClearBtn()
      onStatusUpdated?.(fresh)
      const roleSnap = fresh?.roles?.[role]
      const stillHasKey = roleSnap ? Boolean(roleSnap.hasKey) : Boolean(fresh?.hasKey)
      if (!stillHasKey) {
        setFeedback('API key removed from OS keyring', 'ok')
      } else if (role === 'explain' && roleSnap?.usingSharedKey) {
        setFeedback(
          'Explain & Fix key removed; still reusing shared Autocomplete key on this host',
          'neutral'
        )
      } else {
        setFeedback('Saved API key is still present in OS keyring for this endpoint', 'error')
      }
    } catch (err) {
      if (!disposed && mySeq === actionSeq) {
        setFeedback(err instanceof Error ? err.message : String(err), 'error')
        clearKeyBtn.disabled = false
      }
    } finally {
      mutating = false
    }
  })

  resetStatsBtn.addEventListener('click', async () => {
    try {
      await rpc('ai.stats.reset', undefined, { signal: modalAbort.signal })
      if (!disposed) await refreshStats()
    } catch {
      // Ignore stats reset failure
    }
  })

  fetchModelsBtn.addEventListener('click', () => {
    captureFormIntoDrafts()
    void loadModels({ silent: false })
  })

  benchBtn.addEventListener('click', async () => {
    if (mutating || saving || disposed) return
    captureFormIntoDrafts()
    const autoDraft = drafts.autocomplete
    const autoCache = modelCaches.autocomplete
    const autoPreset = AI_PRESET_OPTIONS.find((p) => p.id === autoDraft.presetId) || AI_PRESET_OPTIONS[0]
    const startSig = `${autoDraft.format}|${normUrl(autoDraft.baseUrl)}`
    const mySeq = ++actionSeq
    mutating = true
    benchBtn.disabled = true
    benchBtn.classList.add('is-loading')
    setFeedback('Benchmarking SQL completion speed...', 'loading')
    try {
      const { filtered } = getSortedAndFilteredModels(autoCache)
      const currentM = autoDraft.model.trim()
      const candidates =
        autoCache.items.length > 0
          ? [...new Set([currentM, ...filtered.map((x) => x.model)].filter(Boolean))].slice(0, 4)
          : [currentM].filter(Boolean)
      if (candidates.length === 0) {
        setFeedback('Enter a model or fetch models first', 'error')
        return
      }
      const res = await rpc(
        'ai.models.bench',
        {
          format: autoDraft.format,
          baseUrl: autoDraft.baseUrl.trim(),
          key: autoPreset.keyKind === 'none' ? '' : autoDraft.keyDraft.trim(),
          models: candidates,
          role: 'autocomplete',
        },
        { signal: modalAbort.signal }
      )
      if (disposed || mySeq !== actionSeq) return
      if (`${drafts.autocomplete.format}|${normUrl(drafts.autocomplete.baseUrl)}` !== startSig) return
      const rows = (res?.results || [])
        .filter((r) => r.ok)
        .sort((a, b) => (a.ms ?? 99999) - (b.ms ?? 99999))
      if (rows.length > 0) {
        const msMap = new Map(rows.map((r) => [r.model, r.ms]))
        if (autoCache.items.length === 0) {
          autoCache.items = rows.map((r, idx) => ({ model: r.model, order: idx, ms: r.ms }))
        } else {
          autoCache.items = autoCache.items.map((item) =>
            msMap.has(item.model) ? { ...item, ms: msMap.get(item.model) } : item
          )
        }
        autoDraft.model = rows[0].model
        autoCache.pinned = rows[0].model
        if (activeDraftKey() === 'autocomplete') {
          modelInput.value = rows[0].model
          syncFimWarning()
          renderModelList()
        }
        setFeedback(`Fastest: ${rows[0].model} (${rows[0].ms}ms)`, 'ok')
      } else {
        setFeedback(res?.message || 'No candidate model passed SQL benchmark', 'error')
      }
    } catch (err) {
      if (!disposed && mySeq === actionSeq) {
        setFeedback(err instanceof Error ? err.message : String(err), 'error')
      }
    } finally {
      mutating = false
      if (!disposed && mySeq === actionSeq) {
        benchBtn.disabled = false
        benchBtn.classList.remove('is-loading')
      }
    }
  })

  const buildDraftTestInput = (role, draft) => {
    const preset = AI_PRESET_OPTIONS.find((p) => p.id === draft.presetId) || AI_PRESET_OPTIONS[0]
    const payload = {
      role,
      format: draft.format,
      baseUrl: draft.baseUrl.trim(),
      model: draft.model.trim(),
    }
    const trimmedKey = preset.keyKind === 'none' ? '' : draft.keyDraft.trim()
    if (trimmedKey) {
      payload.key = trimmedKey
    }
    return payload
  }

  const formatSyncTestFeedback = (autoRes, expRes) => {
    if (autoRes?.ok && expRes?.ok) {
      return {
        text: `Connected (Autocomplete ${autoRes.ms ?? 0}ms · Explain & Fix ${expRes.ms ?? 0}ms)`,
        tone: 'ok',
      }
    }
    const autoMsg = String(autoRes?.message || '').trim()
    const expMsg = String(expRes?.message || '').trim()
    if (!autoRes?.ok && !expRes?.ok) {
      if (autoMsg && expMsg && autoMsg === expMsg) return { text: autoMsg, tone: 'error' }
      if (autoMsg || expMsg) {
        return {
          text: `Autocomplete failed: ${autoMsg || 'connection test failed'} · Explain & Fix failed: ${expMsg || 'connection test failed'}`,
          tone: 'error',
        }
      }
      return { text: 'Connection test failed', tone: 'error' }
    }
    if (!autoRes?.ok) {
      return {
        text: `Autocomplete failed: ${autoMsg || 'connection test failed'} · Explain & Fix ok (${expRes?.ms ?? 0}ms)`,
        tone: 'error',
      }
    }
    return {
      text: `Autocomplete ok (${autoRes.ms ?? 0}ms), Explain & Fix failed: ${expMsg || 'incompatible model'}`,
      tone: 'error',
    }
  }

  testBtn.addEventListener('click', async () => {
    if (mutating || saving || disposed) return
    captureFormIntoDrafts()
    const mySeq = ++actionSeq
    mutating = true
    testBtn.disabled = true
    testBtn.classList.add('is-loading')
    setFeedback('Testing provider...', 'loading')
    try {
      // Test the unsaved draft directly WITHOUT persisting broken settings/keys to config or keyring
      if (syncMode) {
        const autoDraft = drafts.autocomplete
        const autoOn = drafts.autocomplete.enabled
        const expOn = drafts.explain.enabled
        if (!autoOn && expOn) {
          const expRes = await rpc(
            'ai.provider.test',
            buildDraftTestInput('explain', autoDraft),
            { signal: modalAbort.signal }
          )
          if (disposed || mySeq !== actionSeq) return
          setFeedback(
            expRes?.ok
              ? `Explain & Fix connected in ${expRes.ms ?? 0}ms`
              : expRes?.message || 'Connection test failed',
            expRes?.ok ? 'ok' : 'error'
          )
        } else if (autoOn && expOn) {
          const autoRes = await rpc(
            'ai.provider.test',
            buildDraftTestInput('autocomplete', autoDraft),
            { signal: modalAbort.signal }
          )
          if (disposed || mySeq !== actionSeq) return
          const expRes = await rpc(
            'ai.provider.test',
            buildDraftTestInput('explain', autoDraft),
            { signal: modalAbort.signal }
          )
          if (disposed || mySeq !== actionSeq) return
          const summary = formatSyncTestFeedback(autoRes, expRes)
          setFeedback(summary.text, summary.tone)
        } else {
          const autoRes = await rpc(
            'ai.provider.test',
            buildDraftTestInput('autocomplete', autoDraft),
            { signal: modalAbort.signal }
          )
          if (disposed || mySeq !== actionSeq) return
          setFeedback(
            autoRes?.ok
              ? `Connected in ${autoRes.ms ?? 0}ms`
              : autoRes?.message || 'Connection test failed',
            autoRes?.ok ? 'ok' : 'error'
          )
        }
      } else {
        const role = activeRole
        const roleLabel = role === 'explain' ? 'Explain & Fix' : 'Autocomplete'
        const res = await rpc(
          'ai.provider.test',
          buildDraftTestInput(role, drafts[role]),
          { signal: modalAbort.signal }
        )
        if (disposed || mySeq !== actionSeq) return
        setFeedback(
          res?.ok
            ? `${roleLabel} connected in ${res.ms ?? 0}ms`
            : res?.message || `${roleLabel} connection test failed`,
          res?.ok ? 'ok' : 'error'
        )
      }
      const fresh = await rpc('ai.status.get', undefined, { signal: modalAbort.signal })
      if (disposed || mySeq !== actionSeq) return
      snapshot = fresh
      syncKeyFlagsFromSnapshot(fresh)
      syncRoleTabDots(fresh)
      syncDestinationIndicator(false)
      syncKeyPlaceholderAndClearBtn()
      onStatusUpdated?.(fresh)
    } catch (err) {
      if (!disposed && mySeq === actionSeq) {
        setFeedback(err instanceof Error ? err.message : String(err), 'error')
      }
    } finally {
      mutating = false
      if (!disposed && mySeq === actionSeq) {
        testBtn.disabled = false
        testBtn.classList.remove('is-loading')
      }
    }
  })

  const triggerSave = async () => {
    if (saving || mutating || disposed) return
    saving = true
    saveBtn.disabled = true
    saveBtn.classList.add('is-loading')
    try {
      await persistCurrentDraft()
      close()
    } catch (err) {
      if (!disposed) {
        setFeedback(err instanceof Error ? err.message : String(err), 'error')
        saveBtn.disabled = false
        saveBtn.classList.remove('is-loading')
      }
    } finally {
      saving = false
    }
  }

  saveBtn.addEventListener('click', () => {
    void triggerSave()
  })

  const getModalFocusableElements = () => {
    if (typeof card.querySelectorAll !== 'function') return []
    const raw = Array.from(
      card.querySelectorAll('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])')
    )
    return raw.filter((node) => {
      if (!node || node.disabled || node.hidden) return false
      let cur = node
      while (cur && cur !== card) {
        if (cur.hidden) return false
        cur = cur.parentElement
      }
      return true
    })
  }

  card.addEventListener('keydown', (e) => {
    if (e.isComposing) return
    if (e.key === 'Tab') {
      const focusables = getModalFocusableElements()
      if (focusables.length > 0) {
        const first = focusables[0]
        const last = focusables[focusables.length - 1]
        const active = typeof document !== 'undefined' ? document.activeElement : null
        if (e.shiftKey) {
          if (active === first || active === card || !focusables.includes(active)) {
            e.preventDefault()
            last.focus?.()
          }
        } else if (active === last || !focusables.includes(active)) {
          e.preventDefault()
          first.focus?.()
        }
      }
      return
    }
    if (e.key === 'Escape') {
      e.stopPropagation()
      close()
      return
    }
    const targetTag = String(e.target?.tagName || '').toUpperCase()
    const inFormControl = targetTag === 'INPUT' || targetTag === 'TEXTAREA' || targetTag === 'SELECT'
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && !inFormControl) {
      const lowerKey = typeof e.key === 'string' ? e.key.toLowerCase() : ''
      if (e.key === '1' || e.code === 'Digit1') {
        e.preventDefault()
        e.stopPropagation()
        selectRoleTab('autocomplete')
        return
      }
      if (e.key === '2' || e.code === 'Digit2') {
        e.preventDefault()
        e.stopPropagation()
        selectRoleTab('explain')
        return
      }
      if (lowerKey === 's' || e.code === 'KeyS') {
        e.preventDefault()
        e.stopPropagation()
        toggleSyncMode()
        return
      }
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      void triggerSave()
    }
  })

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    windowEscHandler = (ev) => {
      if (ev.isComposing) return
      if (ev.key === 'Escape' && !disposed) {
        close()
      }
    }
    window.addEventListener('keydown', windowEscHandler)
  }

  syncRoleTabDots(snapshot)
  syncViewFromDrafts(true)
  void refreshStats()
  maybeSilentLoadModelsForActiveRole()

  if (mountModal) {
    mountModal(card, undefined, dispose)
    card.focus?.()
  } else {
    // Prevent duplicate stacked standalone AI config modals
    if (typeof document.querySelectorAll === 'function') {
      for (const stale of Array.from(document.querySelectorAll('.datanoa-ai-backdrop'))) {
        if (typeof stale._closeAiModal === 'function') {
          stale._closeAiModal()
        } else if (stale.parentNode) {
          stale.parentNode.removeChild(stale)
        }
      }
    }
    standaloneBackdrop = el('div', 'modal-backdrop datanoa-ai-backdrop')
    standaloneBackdrop._closeAiModal = close
    standaloneBackdrop.addEventListener('click', (e) => {
      if (e.target === standaloneBackdrop) close()
    })
    standaloneBackdrop.appendChild(card)
    document.body.appendChild(standaloneBackdrop)
    card.focus?.()
  }
}

export async function saveOrcaSettingsPatch(patch, options) {
  if (!patch || typeof window === 'undefined' || !window.orca) {
    return
  }
  const forceKeys =
    options && options.forceKeys
      ? new Set(Array.isArray(options.forceKeys) ? options.forceKeys : options.forceKeys)
      : null
  const settingsApi = window.orca.settings
  const hostApi = window.orca.host
  let currentSettings = null
  if (settingsApi && typeof settingsApi.get === 'function') {
    try {
      const snapshot = await settingsApi.get()
      if (snapshot && typeof snapshot === 'object') {
        currentSettings = snapshot
      }
    } catch {
      currentSettings = null
    }
  }
  for (const [key, value] of Object.entries(patch)) {
    const forceWrite = Boolean(forceKeys && forceKeys.has(key))
    if (
      !forceWrite &&
      currentSettings &&
      Object.prototype.hasOwnProperty.call(currentSettings, key) &&
      currentSettings[key] === value
    ) {
      continue
    }
    if (settingsApi && typeof settingsApi.set === 'function') {
      await settingsApi.set(key, value)
    } else if (hostApi && typeof hostApi.call === 'function') {
      await hostApi.call('settings.set', { key, value })
    }
  }
}
