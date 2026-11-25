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

  if (LOCALHOST_HOSTNAME_RE.test(bare)) return true
  const v4 = parseStrictIpv4Octets(bare)
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
    if (text.startsWith('--', i) || (isMongo && text.startsWith('//', i)) || ((isMysql || d === 'clickhouse') && ch === '#')) {
      const nl = text.indexOf('\n', i)
      const end = nl >= 0 ? nl : len
      emitToken('datanoa-sql-cmt', text.slice(i, end))
      i = end
      lineStart = false
      continue
    }

    if (text.startsWith('/*', i)) {
      const close = text.indexOf('*/', i + 2)
      const end = close >= 0 ? close + 2 : len
      emitToken('datanoa-sql-cmt', text.slice(i, end))
      i = end
      lineStart = false
      continue
    }

    // Dollar-quoted strings (PostgreSQL, DuckDB, etc.)
    if (!isMongo && !isRedis && ch === '$') {
      const dqEnd = scanDollarQuotedEnd(text, i)
      if (dqEnd > i) {
        emitToken('datanoa-sql-str', text.slice(i, dqEnd))
        i = dqEnd
        lineStart = false
        continue
      }
    }

    // Oracle alternate quote literals q'[...]' / q'(...)' / q'!...!'
    if (d === 'oracle' && (ch === 'q' || ch === 'Q') && text[i + 1] === '\'') {
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
      const allowBackslashInSingleQuote =
        isMysql || d === 'clickhouse' || d === 'bigquery' || quoteStart > i
      const end = scanQuotedSegment(text, quoteStart, '\'', allowBackslashInSingleQuote)
      emitToken('datanoa-sql-str', text.slice(i, end))
      i = end
      lineStart = false
      continue
    }

    // Double quotes: strings in MongoDB/Redis, identifiers in SQL
    if (ch === '"') {
      const end = scanQuotedSegment(text, i, '"', isMongo || isRedis)
      emitToken(isMongo || isRedis ? 'datanoa-sql-str' : 'datanoa-sql-ident', text.slice(i, end))
      i = end
      lineStart = false
      continue
    }

    // Backtick identifiers
    if (!isMongo && ch === '`') {
      const end = scanQuotedSegment(text, i, '`', false)
      emitToken('datanoa-sql-ident', text.slice(i, end))
      i = end
      lineStart = false
      continue
    }

    // MSSQL [bracketed] identifiers
    if (isMssql && ch === '[') {
      const closeBracket = text.indexOf(']', i + 1)
      const nl = text.indexOf('\n', i + 1)
      if (closeBracket > i && (nl < 0 || closeBracket < nl)) {
        emitToken('datanoa-sql-ident', text.slice(i, closeBracket + 1))
        i = closeBracket + 1
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

function clampAiPanelHeight(px, container, edge) {
  const maxH = getAiPanelMaxHeight(container, edge)
  return Math.max(AI_PANEL_MIN_HEIGHT, Math.min(maxH, Math.round(px)))
}

function clearContainerHeightStyle(container) {
  if (container.style) {
    container.style.height = ''
    container.style.maxHeight = ''
  }
}

function applyContainerUserHeight(container, px, edge) {
  const clamped = clampAiPanelHeight(px, container, edge)
  if (container.style) {
    container.style.height = `${clamped}px`
    container.style.maxHeight = 'none'
  }
  if (container.dataset) {
    container.dataset.userHeight = String(clamped)
  }
  return clamped
}

function restoreSavedContainerHeight(container, edge) {
  const raw = container.dataset?.userHeight
  const parsed = raw !== undefined && raw !== '' ? Number(raw) : Number.NaN
  if (Number.isFinite(parsed) && parsed > 0) {
    return applyContainerUserHeight(container, parsed, edge)
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

  const setHeight = (nextPx) => {
    const clamped = applyContainerUserHeight(container, nextPx, normalizedEdge)
    resizer.setAttribute('aria-valuemax', String(getAiPanelMaxHeight(container, normalizedEdge)))
    resizer.setAttribute('aria-valuenow', String(clamped))
    onResize?.()
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
    const startHeight = getCurrentContainerHeight(container)
    resizer.classList?.add?.('is-resizing')
    if (document.body?.style) {
      document.body.style.cursor = 'row-resize'
      document.body.style.userSelect = 'none'
    }
    const onMove = (moveEv) => {
      const curY = Number(moveEv.clientY) || 0
      const delta = normalizedEdge === 'top' ? startY - curY : curY - startY
      setHeight(startHeight + delta)
    }
    const stopDrag = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', stopDrag)
      window.removeEventListener('blur', stopDrag)
      resizer.classList?.remove?.('is-resizing')
      if (document.body?.style) {
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
      if (activeAiPanelResizeCleanups.get(container) === stopDrag) {
        activeAiPanelResizeCleanups.delete(container)
      }
    }
    activeAiPanelResizeCleanups.set(container, stopDrag)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', stopDrag)
    window.addEventListener('blur', stopDrag)
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

export function renderSharedExplainAiPanel(container, state, callbacks) {
  if (!container) return
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
      delete container.dataset.collapsed
    }
    clearContainerHeightStyle(container)
    clearNode(container)
    return
  }

  container.hidden = false
  container.className = 'datanoa-ai-explain-panel'
  if (container.dataset) {
    container.dataset.phase = String(state.phase || '')
    container.dataset.collapsed = state.collapsed ? 'true' : 'false'
  }
  clearNode(container)

  const resizeEdge = callbacks?.resizeEdge === 'bottom' ? 'bottom' : 'top'
  const isResizable = (state.phase === 'ready' || state.phase === 'error') && !state.collapsed
  if (isResizable) {
    restoreSavedContainerHeight(container, resizeEdge)
  } else {
    clearContainerHeightStyle(container)
  }

  if (isResizable && resizeEdge === 'top') {
    container.appendChild(createAiPanelResizer(container, resizeEdge, callbacks?.onResize))
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
  header.appendChild(titleGroup)

  const controls = el('div', 'datanoa-ai-explain-controls')

  if (state.phase === 'loading') {
    const cancelBtn = el('button', 'btn btn-ghost btn-sm datanoa-ai-btn', 'Cancel')
    cancelBtn.type = 'button'
    cancelBtn.addEventListener('click', () => callbacks?.onCancel?.())
    controls.appendChild(cancelBtn)
  } else if (!state.aiEnabled || !state.aiReady) {
    const setupBtn = el('button', 'btn btn-primary btn-sm datanoa-ai-btn', 'Configure Explain & Fix AI')
    setupBtn.type = 'button'
    setupBtn.addEventListener('click', () => callbacks?.onConfigureAi?.())
    controls.appendChild(setupBtn)
  } else {
    const label = state.phase === 'ready' || state.phase === 'error' ? 'Re-analyze' : 'Analyze with AI'
    const cls = state.phase === 'idle' ? 'btn btn-primary btn-sm datanoa-ai-btn' : 'btn btn-ghost btn-sm datanoa-ai-btn'
    const analyzeBtn = el('button', cls, label)
    analyzeBtn.type = 'button'
    analyzeBtn.addEventListener('click', () => callbacks?.onAnalyze?.())
    controls.appendChild(analyzeBtn)

    if (state.phase === 'ready') {
      const collapseBtn = el(
        'button',
        'btn btn-ghost btn-sm datanoa-ai-btn',
        state.collapsed ? 'Expand' : 'Collapse'
      )
      collapseBtn.type = 'button'
      collapseBtn.addEventListener('click', () => callbacks?.onToggleCollapsed?.())
      controls.appendChild(collapseBtn)
    }
  }

  header.appendChild(controls)
  container.appendChild(header)

  if (state.phase === 'idle') {
    if (!state.aiEnabled || !state.aiReady) {
      const scrollWrap = el('div', 'datanoa-ai-panel-scroll')
      const note = !state.aiEnabled
        ? 'Explain & Fix AI is turned off. Enable Explain & Fix in AI SQL Assistant settings to analyze execution plans.'
        : 'Explain & Fix AI setup is incomplete. Configure provider credentials in AI SQL Assistant settings to analyze this EXPLAIN plan.'
      scrollWrap.appendChild(el('p', 'datanoa-ai-hint', note))
      container.appendChild(scrollWrap)
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
    retryBtn.addEventListener('click', () => callbacks?.onAnalyze?.())
    const cfgBtn = el('button', 'btn btn-ghost btn-sm datanoa-ai-btn', 'AI Settings')
    cfgBtn.type = 'button'
    cfgBtn.addEventListener('click', () => callbacks?.onConfigureAi?.())
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

  if (state.collapsed || !state.result) {
    return
  }

  const scrollWrap = el('div', 'datanoa-ai-panel-scroll')
  const body = el('div', 'datanoa-ai-explain-body')
  const res = state.result

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
    const sec = el('div', 'datanoa-ai-section')
    sec.appendChild(el('div', 'datanoa-ai-section-label', 'Bottlenecks'))
    const list = el('div', 'datanoa-ai-list')
    for (const item of res.bottlenecks) {
      const sevRaw = String(item.severity || 'medium').toLowerCase()
      const sevLabel = sevRaw === 'high' ? 'High' : sevRaw === 'low' ? 'Low' : 'Medium'
      const card = el('div', `datanoa-ai-item sev-${sevRaw}`)
      const top = el('div', 'datanoa-ai-item-top')
      top.appendChild(el('span', `datanoa-ai-sev sev-${sevRaw}`, sevLabel))
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

  if (Array.isArray(res.indexSuggestions) && res.indexSuggestions.length > 0) {
    const sec = el('div', 'datanoa-ai-section')
    sec.appendChild(el('div', 'datanoa-ai-section-label', 'Suggested Indexes'))
    const list = el('div', 'datanoa-ai-list')
    for (const idx of res.indexSuggestions) {
      const card = el('div', 'datanoa-ai-item')
      const top = el('div', 'datanoa-ai-item-top')
      top.appendChild(el('span', 'datanoa-ai-item-detail', idx.reason || 'Suggested index'))
      const copyDdlBtn = el('button', 'btn btn-ghost btn-sm datanoa-ai-btn', 'Copy DDL')
      copyDdlBtn.type = 'button'
      copyDdlBtn.addEventListener('click', () => callbacks?.onCopyText?.(idx.ddl, 'DDL'))
      top.appendChild(copyDdlBtn)
      card.appendChild(top)
      card.appendChild(createHighlightedSqlPre(idx.ddl, state.dialect))
      list.appendChild(card)
    }
    sec.appendChild(list)
    body.appendChild(sec)
  }

  if (res.optimizedSql) {
    const sec = el('div', 'datanoa-ai-section')
    const top = el('div', 'datanoa-ai-item-top')
    top.appendChild(
      el('div', 'datanoa-ai-section-label', 'Optimized Equivalent SQL (review before executing)')
    )
    const actions = el('div', 'datanoa-ai-row-actions')

    const replaceBtn = el('button', 'btn btn-primary btn-sm datanoa-ai-btn', 'Replace Query')
    replaceBtn.type = 'button'
    replaceBtn.addEventListener('click', () => callbacks?.onApplySql?.(res.optimizedSql))

    const copyBtn = el('button', 'btn btn-ghost btn-sm datanoa-ai-btn', 'Copy SQL')
    copyBtn.type = 'button'
    copyBtn.addEventListener('click', () =>
      callbacks?.onCopyText?.(res.optimizedSql, 'Optimized SQL')
    )

    const newTabBtn = el('button', 'btn btn-ghost btn-sm datanoa-ai-btn', 'New Tab')
    newTabBtn.type = 'button'
    newTabBtn.addEventListener('click', () => callbacks?.onOpenNewTab?.(res.optimizedSql))

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

  scrollWrap.appendChild(body)
  container.appendChild(scrollWrap)
  if (isResizable && resizeEdge === 'bottom') {
    container.appendChild(createAiPanelResizer(container, resizeEdge, callbacks?.onResize))
  }
}

export function renderSharedAiFixPanel(container, state, callbacks) {
  if (!container) return
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
    }
    clearContainerHeightStyle(container)
    clearNode(container)
    return
  }

  container.hidden = false
  container.className = 'datanoa-ai-fix-panel'
  if (container.dataset) {
    container.dataset.phase = String(state.phase || '')
  }
  clearNode(container)

  const resizeEdge = callbacks?.resizeEdge === 'top' ? 'top' : 'bottom'
  const isResizable = state.phase === 'ready' || state.phase === 'error'
  if (isResizable) {
    restoreSavedContainerHeight(container, resizeEdge)
  } else {
    clearContainerHeightStyle(container)
  }

  if (isResizable && resizeEdge === 'top') {
    container.appendChild(createAiPanelResizer(container, resizeEdge, callbacks?.onResize))
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
  header.appendChild(titleGroup)

  const controls = el('div', 'datanoa-ai-explain-controls')
  if (state.phase === 'loading') {
    const cancelBtn = el('button', 'btn btn-ghost btn-sm datanoa-ai-btn', 'Cancel')
    cancelBtn.type = 'button'
    cancelBtn.addEventListener('click', () => callbacks?.onCancel?.())
    controls.appendChild(cancelBtn)
  }

  const dismissBtn = el('button', 'btn btn-ghost btn-sm datanoa-ai-btn', 'Dismiss')
  dismissBtn.type = 'button'
  dismissBtn.addEventListener('click', () => callbacks?.onDismiss?.())
  controls.appendChild(dismissBtn)

  header.appendChild(controls)
  container.appendChild(header)

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
    errWrap.appendChild(
      el('div', 'datanoa-ai-error-text', state.error || 'Could not suggest a SQL fix')
    )
    const errActions = el('div', 'datanoa-ai-row-actions')
    if (state.aiEnabled && state.aiReady) {
      const retryBtn = el('button', 'btn btn-ghost btn-sm datanoa-ai-btn', 'Retry')
      retryBtn.type = 'button'
      retryBtn.addEventListener('click', () => callbacks?.onRetry?.())
      errActions.appendChild(retryBtn)
    }
    const cfgLabel = state.aiEnabled && state.aiReady ? 'AI Settings' : 'Configure Explain & Fix AI'
    const cfgBtn = el('button', 'btn btn-ghost btn-sm datanoa-ai-btn', cfgLabel)
    cfgBtn.type = 'button'
    cfgBtn.addEventListener('click', () => callbacks?.onConfigureAi?.())
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
    if (hasFixedSql) callbacks?.onReplaceQuery?.(fixedSql)
  })

  const copyBtn = el('button', 'btn btn-ghost btn-sm datanoa-ai-btn', 'Copy SQL')
  copyBtn.type = 'button'
  copyBtn.disabled = !hasFixedSql
  copyBtn.addEventListener('click', () => {
    if (hasFixedSql) callbacks?.onCopySql?.(fixedSql)
  })

  const bodyDismissBtn = el('button', 'btn btn-ghost btn-sm datanoa-ai-btn', 'Dismiss')
  bodyDismissBtn.type = 'button'
  bodyDismissBtn.addEventListener('click', () => callbacks?.onDismiss?.())

  actions.appendChild(replaceBtn)
  actions.appendChild(copyBtn)
  actions.appendChild(bodyDismissBtn)

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

  const dispose = () => {
    if (disposed) return
    disposed = true
    modalAbort.abort()
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
  keyInput.autocomplete = 'off'
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
  feedbackBox.hidden = true
  body.appendChild(feedbackBox)

  const setFeedback = (text, tone) => {
    feedbackBox.hidden = !text
    feedbackBox.className = `datanoa-ai-feedback ${tone ? `tone-${tone}` : ''}`
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
      keyInput.placeholder = preset.keyPlaceholder
      clearKeyBtn.disabled = !draftHasPinnedOwnKey
      return
    }

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
    const cacheSignature = `${targetDraft.format}|${normUrl(baseUrl)}`
    fetchModelsBtn.disabled = true
    fetchModelsBtn.classList.add('is-loading')
    if (!silent) setFeedback('Loading models...', 'loading')
    try {
      const res = await rpc(
        'ai.models.list',
        {
          format: targetDraft.format,
          baseUrl,
          key: targetDraft.keyDraft.trim(),
          role: targetKey,
        },
        { signal: modalAbort.signal }
      )
      if (disposed) return
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
      if (disposed) return
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
      if (!disposed && !silent) setFeedback(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      if (!disposed) {
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
      drafts.explain.presetId = drafts.autocomplete.presetId
      drafts.explain.format = drafts.autocomplete.format
      drafts.explain.baseUrl = drafts.autocomplete.baseUrl
      drafts.explain.model = drafts.autocomplete.model
      drafts.explain.keyDraft = drafts.autocomplete.keyDraft
      if (!drafts.explain.hasOwnKey && drafts.autocomplete.hasKey) {
        drafts.explain.hasKey = true
        drafts.explain.usingSharedKey = true
      }
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

  presetSelect.addEventListener('change', () => {
    const draft = getActiveDraft()
    const preset = AI_PRESET_OPTIONS.find((p) => p.id === presetSelect.value) || AI_PRESET_OPTIONS[0]
    draft.presetId = preset.id
    draft.format = preset.format
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
    getActiveDraft().baseUrl = urlInput.value
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
      const draftKey = auto.keyDraft.trim()
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
      const autoDraftKey = auto.keyDraft.trim()
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
      const expDraftKey = drafts.explain.keyDraft.trim()
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
    const role = activeDraftKey()
    clearKeyBtn.disabled = true
    try {
      await rpc(
        'ai.key.set',
        { key: '', baseUrl: drafts[role].baseUrl.trim(), role },
        { signal: modalAbort.signal }
      )
      if (disposed) return
      drafts[role].keyDraft = ''
      keyInput.value = ''
      const fresh = await rpc('ai.status.get', undefined, { signal: modalAbort.signal })
      if (disposed) return
      snapshot = fresh
      syncKeyFlagsFromSnapshot(fresh)
      syncRoleTabDots(fresh)
      syncDestinationIndicator(true)
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
      if (!disposed) {
        setFeedback(err instanceof Error ? err.message : String(err), 'error')
        clearKeyBtn.disabled = false
      }
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
    captureFormIntoDrafts()
    const autoDraft = drafts.autocomplete
    const autoCache = modelCaches.autocomplete
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
          key: autoDraft.keyDraft.trim(),
          models: candidates,
          role: 'autocomplete',
        },
        { signal: modalAbort.signal }
      )
      if (disposed) return
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
      if (!disposed) setFeedback(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      if (!disposed) {
        benchBtn.disabled = false
        benchBtn.classList.remove('is-loading')
      }
    }
  })

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
    testBtn.disabled = true
    testBtn.classList.add('is-loading')
    setFeedback('Testing provider...', 'loading')
    try {
      await persistCurrentDraft()
      if (disposed) return
      if (syncMode) {
        const autoOn = drafts.autocomplete.enabled
        const expOn = drafts.explain.enabled
        if (!autoOn && expOn) {
          const expRes = await rpc('ai.provider.test', { role: 'explain' }, { signal: modalAbort.signal })
          if (disposed) return
          setFeedback(
            expRes?.ok
              ? `Explain & Fix connected in ${expRes.ms ?? 0}ms`
              : expRes?.message || 'Connection test failed',
            expRes?.ok ? 'ok' : 'error'
          )
        } else if (autoOn && expOn) {
          const autoRes = await rpc('ai.provider.test', { role: 'autocomplete' }, { signal: modalAbort.signal })
          if (disposed) return
          const expRes = await rpc('ai.provider.test', { role: 'explain' }, { signal: modalAbort.signal })
          if (disposed) return
          const summary = formatSyncTestFeedback(autoRes, expRes)
          setFeedback(summary.text, summary.tone)
        } else {
          const autoRes = await rpc('ai.provider.test', { role: 'autocomplete' }, { signal: modalAbort.signal })
          if (disposed) return
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
        const res = await rpc('ai.provider.test', { role }, { signal: modalAbort.signal })
        if (disposed) return
        setFeedback(
          res?.ok
            ? `${roleLabel} connected in ${res.ms ?? 0}ms`
            : res?.message || `${roleLabel} connection test failed`,
          res?.ok ? 'ok' : 'error'
        )
      }
      const fresh = await rpc('ai.status.get', undefined, { signal: modalAbort.signal })
      if (disposed) return
      snapshot = fresh
      syncKeyFlagsFromSnapshot(fresh)
      syncRoleTabDots(fresh)
      syncDestinationIndicator(true)
      syncKeyPlaceholderAndClearBtn()
      onStatusUpdated?.(fresh)
    } catch (err) {
      if (!disposed) setFeedback(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      if (!disposed) {
        testBtn.disabled = false
        testBtn.classList.remove('is-loading')
      }
    }
  })

  const triggerSave = async () => {
    if (saving || disposed) return
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

  card.addEventListener('keydown', (e) => {
    if (e.isComposing) return
    if (e.key === 'Escape') {
      e.stopPropagation()
      close()
      return
    }
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
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

  syncRoleTabDots(snapshot)
  syncViewFromDrafts(true)
  void refreshStats()
  maybeSilentLoadModelsForActiveRole()

  if (mountModal) {
    mountModal(card, undefined, dispose)
  } else {
    standaloneBackdrop = el('div', 'modal-backdrop datanoa-ai-backdrop')
    standaloneBackdrop._closeAiModal = close
    standaloneBackdrop.addEventListener('click', (e) => {
      if (e.target === standaloneBackdrop) close()
    })
    standaloneBackdrop.appendChild(card)
    document.body.appendChild(standaloneBackdrop)
    card.focus()
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
