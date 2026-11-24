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

function formatLatencySec(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return ''
  if (ms >= 10000) return `${Math.round(ms / 1000)}s`
  const tenths = Math.max(1, Math.round(ms / 100))
  return `${(tenths / 10).toFixed(1)}s`
}

function isLoopbackHostname(rawHost) {
  const host = String(rawHost || '').trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (!host) return false
  if (host === 'localhost' || host === '::1' || host.endsWith('.localhost')) return true
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (m) {
    return Number(m[1]) <= 255 && Number(m[2]) <= 255 && Number(m[3]) <= 255
  }
  return false
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

export function formatAiStatusBadge(snapshot) {
  if (!snapshot || !snapshot.enabled || snapshot.state === 'off') {
    return { tone: 'neutral', label: 'AI · Off', title: 'Configure AI SQL Assistant' }
  }
  if (snapshot.state === 'setup') {
    return {
      tone: 'warn',
      label: 'AI · Setup',
      title: snapshot.reason || 'Complete AI provider setup & API key',
    }
  }
  if (snapshot.state === 'error') {
    return {
      tone: 'danger',
      label: 'AI · Error',
      title: snapshot.reason || 'AI request error — click to inspect',
    }
  }
  const sec = formatLatencySec(snapshot.lastMs)
  const destSuffix =
    snapshot.destination === 'local'
      ? ` · Local (${snapshot.host || 'localhost'})`
      : snapshot.destination === 'remote'
        ? ` · Remote (${snapshot.host || 'external'})`
        : ''
  if (snapshot.state === 'slow') {
    return {
      tone: 'warn',
      label: sec ? `AI · ${sec}` : 'AI · Slow',
      title: `${snapshot.reason || 'AI responses are slow'}${destSuffix}`,
    }
  }
  return {
    tone: 'success',
    label: sec ? `AI · ${sec}` : 'AI · On',
    title: `AI SQL Assistant (${snapshot.model || 'active'})${destSuffix}`,
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

function createAiSparkleIcon() {
  const svg = createSvgNode('svg', {
    class: 'datanoa-ai-icon',
    width: '12',
    height: '12',
    viewBox: '0 0 16 16',
    fill: 'none',
    'aria-hidden': 'true',
    focusable: 'false',
  })
  svg.appendChild(
    createSvgNode('path', {
      d: 'M6.75 3L8.1 7.4L12.5 8.75L8.1 10.1L6.75 14.5L5.4 10.1L1 8.75L5.4 7.4L6.75 3Z',
      fill: 'currentColor',
    })
  )
  svg.appendChild(
    createSvgNode('path', {
      d: 'M12.75 1L13.35 2.65L15 3.25L13.35 3.85L12.75 5.5L12.15 3.85L10.5 3.25L12.15 2.65L12.75 1Z',
      fill: 'currentColor',
      opacity: '0.82',
    })
  )
  return svg
}

export function renderAiStatusButtonContent(buttonEl, snapshot) {
  const badge = formatAiStatusBadge(snapshot)
  if (!buttonEl) return badge
  clearNode(buttonEl)
  buttonEl.appendChild(createAiSparkleIcon())
  buttonEl.appendChild(el('span', 'datanoa-ai-label', badge.label))
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

function clearNode(node) {
  while (node.firstChild) {
    node.removeChild(node.firstChild)
  }
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
      `${Math.round(state.result.durationMs)} ms · ${String(state.result.language || 'auto').toUpperCase()}`
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
    const setupBtn = el('button', 'btn btn-primary btn-sm datanoa-ai-btn', 'Configure AI to Analyze')
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
        ? 'AI is turned off. Offline SQL completion stays active; enable AI to inspect query plans.'
        : 'AI provider setup is incomplete. Configure provider credentials to analyze this EXPLAIN plan.'
      scrollWrap.appendChild(el('p', 'datanoa-ai-hint', note))
      container.appendChild(scrollWrap)
    }
    return
  }

  if (state.phase === 'loading') {
    const scrollWrap = el('div', 'datanoa-ai-panel-scroll')
    scrollWrap.appendChild(el('div', 'datanoa-ai-loading', 'Analyzing execution plan and index opportunities...'))
    container.appendChild(scrollWrap)
    return
  }

  if (state.phase === 'error') {
    const scrollWrap = el('div', 'datanoa-ai-panel-scroll')
    const errWrap = el('div', 'datanoa-ai-error-box')
    errWrap.setAttribute('role', 'alert')
    errWrap.appendChild(el('div', 'datanoa-ai-error-text', state.error || 'Could not analyze execution plan.'))
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
      card.appendChild(el('pre', 'datanoa-ai-code', idx.ddl))
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
    sec.appendChild(el('pre', 'datanoa-ai-code', res.optimizedSql))
    body.appendChild(sec)
  }

  if (Array.isArray(res.caveats) && res.caveats.length > 0) {
    const sec = el('div', 'datanoa-ai-section')
    sec.appendChild(el('div', 'datanoa-ai-section-label', 'Caveats'))
    const ul = el('ul', 'datanoa-ai-caveats')
    for (const c of res.caveats) {
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
      pillParts.push(`${Math.round(res.durationMs)} ms`)
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
      el('div', 'datanoa-ai-loading', 'Analyzing SQL error and schema to suggest a fix...')
    )
    container.appendChild(scrollWrap)
    return
  }

  if (state.phase === 'error') {
    const scrollWrap = el('div', 'datanoa-ai-panel-scroll')
    const errWrap = el('div', 'datanoa-ai-error-box')
    errWrap.setAttribute('role', 'alert')
    errWrap.appendChild(
      el('div', 'datanoa-ai-error-text', state.error || 'Could not suggest a SQL fix.')
    )
    const errActions = el('div', 'datanoa-ai-row-actions')
    if (state.aiEnabled && state.aiReady) {
      const retryBtn = el('button', 'btn btn-ghost btn-sm datanoa-ai-btn', 'Retry')
      retryBtn.type = 'button'
      retryBtn.addEventListener('click', () => callbacks?.onRetry?.())
      errActions.appendChild(retryBtn)
    }
    const cfgLabel = state.aiEnabled && state.aiReady ? 'AI Settings' : 'Configure AI'
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

  body.appendChild(el('pre', 'datanoa-ai-code', fixedSql))

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

export async function openSharedAiConfigModal(options) {
  const { rpc, saveSettings, initialStatus, onStatusUpdated, mountModal, closeModal } = options
  const modalAbort = new AbortController()
  const modalUid = `datanoa-ai-modal-${++sharedAiModalSeq}`
  let snapshot = initialStatus || null
  try {
    snapshot = await rpc('ai.status.get', undefined, { signal: modalAbort.signal, timeoutMs: 3000 })
  } catch {
    // Keep initial snapshot on transient read error
  }

  const card = el('div', 'datanoa-ai-modal')
  card.setAttribute('role', 'dialog')
  card.setAttribute('aria-modal', 'true')

  let standaloneBackdrop = null
  let disposed = false

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
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      close()
    }
  })

  // Head
  const head = el('div', 'datanoa-ai-modal-head')
  const titleWrap = el('div', 'datanoa-ai-modal-title-wrap')
  const titleEl = el('h3', 'datanoa-ai-modal-title', 'AI SQL Assistant')
  titleEl.id = `${modalUid}-title`
  card.setAttribute('aria-labelledby', titleEl.id)
  titleWrap.appendChild(titleEl)
  const statusPill = el('span', 'datanoa-ai-pill', formatAiStatusBadge(snapshot).label)
  titleWrap.appendChild(statusPill)
  const destPill = el('span', 'datanoa-ai-pill datanoa-ai-dest-pill', '')
  destPill.setAttribute('data-destination', 'none')
  titleWrap.appendChild(destPill)
  head.appendChild(titleWrap)
  const closeX = el('button', 'btn btn-ghost btn-sm datanoa-ai-btn', '×')
  closeX.type = 'button'
  closeX.setAttribute('aria-label', 'Close AI SQL Assistant settings')
  closeX.addEventListener('click', close)
  head.appendChild(closeX)
  card.appendChild(head)

  // Body
  const body = el('div', 'datanoa-ai-modal-body')

  const toggleRow = el('label', 'datanoa-ai-toggle-row')
  const enabledId = `${modalUid}-enabled`
  toggleRow.htmlFor = enabledId
  toggleRow.setAttribute('for', enabledId)
  const enabledCheckbox = el('input')
  enabledCheckbox.type = 'checkbox'
  enabledCheckbox.id = enabledId
  enabledCheckbox.setAttribute('aria-label', 'Enable AI SQL inline autocomplete and EXPLAIN assistant')
  enabledCheckbox.checked = Boolean(snapshot?.enabled)
  const toggleTextWrap = el('div', 'datanoa-ai-toggle-text')
  toggleTextWrap.appendChild(el('strong', '', 'Enable AI SQL inline autocomplete & EXPLAIN assistant'))
  toggleTextWrap.appendChild(
    el('span', 'datanoa-ai-hint', 'When disabled, local schema/keyword autocomplete remains active.')
  )
  toggleRow.appendChild(enabledCheckbox)
  toggleRow.appendChild(toggleTextWrap)
  body.appendChild(toggleRow)

  body.appendChild(
    el(
      'p',
      'datanoa-ai-scope-note',
      'Sends table/column names, FK links, index metadata, and sanitized same-connection queries. Table rows and credentials are never transmitted.'
    )
  )

  const feedbackBox = el('div', 'datanoa-ai-feedback')
  feedbackBox.hidden = true

  const setFeedback = (text, tone) => {
    feedbackBox.hidden = !text
    feedbackBox.className = `datanoa-ai-feedback ${tone ? `tone-${tone}` : ''}`
    feedbackBox.textContent = text || ''
  }

  // Preset + URL
  const currentPresetId = resolveAiPresetId(snapshot?.format || 'openai', snapshot?.baseUrl || '')
  let currentFormat = snapshot?.format || 'openai'

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
    opt.selected = p.id === currentPresetId
    presetSelect.appendChild(opt)
  }
  presetField.appendChild(presetSelect)
  grid.appendChild(presetField)

  const urlInput = el('input', 'datanoa-ai-input')
  urlInput.type = 'url'
  urlInput.value = snapshot?.baseUrl || 'https://api.openai.com/v1'
  urlInput.placeholder = 'https://api.openai.com/v1'
  const urlField = createLabeledField('Base URL', 'base-url', urlInput)
  urlField.appendChild(urlInput)
  grid.appendChild(urlField)

  const modelInput = el('input', 'datanoa-ai-input')
  modelInput.type = 'text'
  modelInput.value = snapshot?.model || 'gpt-4o-mini'
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
  keyInput.placeholder = snapshot?.hasKey ? 'Saved in OS keyring — paste to replace' : 'Paste API key...'
  const keyField = createLabeledField('API Key (OS keyring)', 'api-key', keyInput, 'API Key (OS keyring)')
  const keyRow = el('div', 'datanoa-ai-inline-row')
  const clearKeyBtn = el('button', 'btn btn-ghost btn-sm datanoa-ai-btn', 'Clear')
  clearKeyBtn.type = 'button'
  clearKeyBtn.setAttribute('aria-label', 'Clear saved API key')
  clearKeyBtn.disabled = !snapshot?.hasKey
  keyRow.appendChild(keyInput)
  keyRow.appendChild(clearKeyBtn)
  keyField.appendChild(keyRow)
  grid.appendChild(keyField)

  const MAX_INLINE_TOKENS = 1024
  const DEFAULT_EXPLAIN_MAX_TOKENS = 2048
  const MIN_EXPLAIN_MAX_TOKENS = 256
  const MAX_EXPLAIN_MAX_TOKENS = 8192
  const INITIAL_VISIBLE_MODELS = 12
  const SEARCH_VISIBLE_CAP = 24

  const tokensInput = el('input', 'datanoa-ai-input')
  tokensInput.type = 'number'
  tokensInput.min = '16'
  tokensInput.max = String(MAX_INLINE_TOKENS)
  tokensInput.value = String(snapshot?.maxTokens || 96)
  const tokensField = createLabeledField('Inline max tokens', 'inline-max-tokens', tokensInput)
  tokensField.appendChild(tokensInput)
  grid.appendChild(tokensField)

  const explainTokensInput = el('input', 'datanoa-ai-input')
  explainTokensInput.type = 'number'
  explainTokensInput.min = String(MIN_EXPLAIN_MAX_TOKENS)
  explainTokensInput.max = String(MAX_EXPLAIN_MAX_TOKENS)
  explainTokensInput.value = String(snapshot?.explainMaxTokens || DEFAULT_EXPLAIN_MAX_TOKENS)
  const explainTokensField = createLabeledField('EXPLAIN max tokens', 'explain-max-tokens', explainTokensInput)
  explainTokensField.appendChild(explainTokensInput)
  grid.appendChild(explainTokensField)

  const langSelect = el('select', 'datanoa-ai-input')
  populateLanguageSelect(langSelect, snapshot?.explainLanguage || 'auto')
  const langField = createLabeledField('EXPLAIN language', 'explain-language', langSelect, 'EXPLAIN language', true)
  langField.appendChild(langSelect)
  grid.appendChild(langField)

  body.appendChild(grid)

  const modelsPanelEl = el('div', 'datanoa-ai-models-panel')
  modelsPanelEl.hidden = true

  const modelsBarEl = el('div', 'datanoa-ai-models-bar')
  const modelSearchInput = el('input', 'datanoa-ai-input datanoa-ai-model-search')
  modelSearchInput.id = `${modalUid}-model-search`
  modelSearchInput.type = 'search'
  modelSearchInput.placeholder = 'Search models by name...'
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
  body.appendChild(modelsPanelEl)
  body.appendChild(feedbackBox)

  // Stats strip
  const statsBox = el('div', 'datanoa-ai-stats-box')
  const statsValuesEl = el('div', 'datanoa-ai-stats-values', 'Loading telemetry...')
  const resetStatsBtn = el('button', 'btn btn-ghost btn-sm datanoa-ai-btn', 'Reset')
  resetStatsBtn.type = 'button'
  resetStatsBtn.setAttribute('aria-label', 'Reset AI telemetry statistics')
  statsBox.appendChild(statsValuesEl)
  statsBox.appendChild(resetStatsBtn)
  body.appendChild(statsBox)

  card.appendChild(body)

  // Actions
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

  const syncDestinationIndicator = (useSnapshotFallback = false) => {
    const info = describeEndpointDestination(
      urlInput.value,
      useSnapshotFallback ? snapshot?.destination : undefined,
      useSnapshotFallback ? snapshot?.host : undefined
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

  const applyPresetUi = (presetId, updateFields) => {
    const preset = AI_PRESET_OPTIONS.find((p) => p.id === presetId) || AI_PRESET_OPTIONS[0]
    currentFormat = preset.format
    urlInput.readOnly = !preset.editableUrl
    keyInput.placeholder = snapshot?.hasKey && preset.keyKind !== 'none'
      ? 'Saved in OS keyring — paste to replace'
      : preset.keyPlaceholder
    if (updateFields) {
      if (preset.baseUrl !== null && preset.baseUrl !== '') {
        urlInput.value = preset.baseUrl
      } else if (preset.baseUrl === '') {
        const currentAddr = normUrl(urlInput.value)
        if (AI_PRESET_OPTIONS.some((p) => p.baseUrl && normUrl(p.baseUrl) === currentAddr)) {
          urlInput.value = ''
        }
      }
      if (preset.model) {
        modelInput.value = preset.model
      }
    }
  }
  applyPresetUi(currentPresetId, false)
  syncDestinationIndicator(true)

  presetSelect.addEventListener('change', () => {
    applyPresetUi(presetSelect.value, true)
    syncDestinationIndicator(false)
    allModels = []
    showAllModels = false
    modelSearchInput.value = ''
    renderModelList()
  })

  urlInput.addEventListener('input', () => {
    syncDestinationIndicator(false)
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
  void refreshStats()

  const persistCurrentDraft = async () => {
    const rawTokens = Number(tokensInput.value)
    const maxTokens =
      Number.isFinite(rawTokens) && rawTokens > 0
        ? Math.min(MAX_INLINE_TOKENS, Math.max(16, Math.floor(rawTokens)))
        : 96
    const rawExplainTokens = Number(explainTokensInput.value)
    const explainMaxTokens =
      Number.isFinite(rawExplainTokens) && rawExplainTokens > 0
        ? Math.min(MAX_EXPLAIN_MAX_TOKENS, Math.max(MIN_EXPLAIN_MAX_TOKENS, Math.floor(rawExplainTokens)))
        : DEFAULT_EXPLAIN_MAX_TOKENS
    const baseUrl = urlInput.value.trim()
    await saveSettings({
      aiEnabled: enabledCheckbox.checked,
      aiFormat: currentFormat,
      aiBaseUrl: baseUrl,
      aiModel: modelInput.value.trim(),
      aiMaxTokens: maxTokens,
      aiExplainMaxTokens: explainMaxTokens,
      aiExplainLanguage: langSelect.value || 'auto',
    })
    if (disposed) return null
    const draftKey = keyInput.value.trim()
    if (draftKey) {
      const keyRes = await rpc('ai.key.set', { key: draftKey, baseUrl }, { signal: modalAbort.signal })
      if (disposed) return null
      keyInput.value = ''
      clearKeyBtn.disabled = !keyRes?.hasKey
    }
    const fresh = await rpc('ai.status.get', undefined, { signal: modalAbort.signal })
    if (disposed) return null
    snapshot = fresh
    statusPill.textContent = formatAiStatusBadge(fresh).label
    syncDestinationIndicator(true)
    onStatusUpdated?.(fresh)
    return fresh
  }

  clearKeyBtn.addEventListener('click', async () => {
    clearKeyBtn.disabled = true
    try {
      await rpc('ai.key.set', { key: '', baseUrl: urlInput.value.trim() }, { signal: modalAbort.signal })
      if (disposed) return
      keyInput.value = ''
      const fresh = await rpc('ai.status.get', undefined, { signal: modalAbort.signal })
      if (disposed) return
      snapshot = fresh
      statusPill.textContent = formatAiStatusBadge(fresh).label
      syncDestinationIndicator(true)
      onStatusUpdated?.(fresh)
      setFeedback('API key removed from OS keyring.', 'ok')
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

  let allModels = []
  let showAllModels = false
  let pinnedModel = modelInput.value.trim()

  const getSortedAndFilteredModels = () => {
    const tokens = modelSearchInput.value.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const sorted = [...allModels].sort((a, b) => {
      const aPinned = pinnedModel && a.model === pinnedModel ? 0 : 1
      const bPinned = pinnedModel && b.model === pinnedModel ? 0 : 1
      if (aPinned !== bPinned) return aPinned - bPinned
      const aHasMs = typeof a.ms === 'number'
      const bHasMs = typeof b.ms === 'number'
      if (aHasMs !== bHasMs) return aHasMs ? -1 : 1
      if (aHasMs && bHasMs && a.ms !== b.ms) return a.ms - b.ms
      return a.order - b.order
    })
    const filtered = tokens.length === 0
      ? sorted
      : sorted.filter((item) => {
          const lower = item.model.toLowerCase()
          return tokens.every((tok) => lower.includes(tok))
        })
    return { filtered, isSearching: tokens.length > 0 }
  }

  const renderModelList = () => {
    clearNode(modelsResultEl)
    if (allModels.length === 0) {
      modelsPanelEl.hidden = true
      return
    }
    modelsPanelEl.hidden = false
    const { filtered, isSearching } = getSortedAndFilteredModels()
    const cap = isSearching ? SEARCH_VISIBLE_CAP : INITIAL_VISIBLE_MODELS
    const visible = showAllModels ? filtered : filtered.slice(0, cap)
    const currentModel = modelInput.value.trim()

    if (filtered.length > cap) {
      toggleModelsBtn.hidden = false
      toggleModelsBtn.textContent = showAllModels ? 'Show less' : `Show all (${filtered.length})`
      toggleModelsBtn.setAttribute(
        'aria-label',
        showAllModels ? 'Show fewer models' : `Show all ${filtered.length} models`
      )
    } else {
      toggleModelsBtn.hidden = true
    }

    modelsCountEl.textContent = isSearching
      ? `${filtered.length}/${allModels.length} matched`
      : `${allModels.length} models`

    if (visible.length === 0) {
      modelsResultEl.appendChild(
        el('span', 'datanoa-ai-hint', `No models match "${modelSearchInput.value.trim()}".`)
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
        renderModelList()
      })
      modelsResultEl.appendChild(chip)
    }
  }

  modelSearchInput.addEventListener('input', () => {
    showAllModels = false
    renderModelList()
  })

  toggleModelsBtn.addEventListener('click', () => {
    showAllModels = !showAllModels
    renderModelList()
  })

  modelInput.addEventListener('input', () => {
    if (allModels.length > 0) renderModelList()
  })

  const loadModels = async (opts = {}) => {
    const silent = Boolean(opts.silent)
    const baseUrl = urlInput.value.trim()
    if (!/^https?:\/\//i.test(baseUrl)) {
      if (!silent) setFeedback('Enter a valid http:// or https:// base URL.', 'error')
      return
    }
    fetchModelsBtn.disabled = true
    if (!silent) setFeedback('Loading models...', 'neutral')
    try {
      const res = await rpc(
        'ai.models.list',
        { format: currentFormat, baseUrl, key: keyInput.value.trim() },
        { signal: modalAbort.signal }
      )
      if (disposed) return
      if (!res?.ok) {
        if (!silent) setFeedback(res?.message || 'Could not list models.', 'error')
        return
      }
      let usageMap = {}
      try {
        const usageRes = await rpc('ai.models.usage', { baseUrl }, { signal: modalAbort.signal })
        usageMap = usageRes?.usage || {}
      } catch {
        // Best-effort latency hints
      }
      if (disposed) return
      const rawModels = Array.isArray(res.models) ? res.models : []
      showAllModels = false
      pinnedModel = modelInput.value.trim()
      allModels = rawModels.map((model, idx) => ({
        model,
        order: idx,
        ms: typeof usageMap[model]?.ms === 'number' ? usageMap[model].ms : undefined,
      }))
      renderModelList()
      if (!silent) {
        setFeedback(
          allModels.length > 0
            ? `Loaded ${allModels.length} model(s). Search or click a model to select it.`
            : 'Provider returned 0 compatible models.',
          allModels.length > 0 ? 'ok' : 'neutral'
        )
      }
    } catch (err) {
      if (!disposed && !silent) setFeedback(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      if (!disposed) fetchModelsBtn.disabled = false
    }
  }

  fetchModelsBtn.addEventListener('click', () => {
    void loadModels({ silent: false })
  })

  const initialPreset = AI_PRESET_OPTIONS.find((p) => p.id === currentPresetId) || AI_PRESET_OPTIONS[0]
  if (
    /^https?:\/\//i.test(urlInput.value.trim()) &&
    (initialPreset.keyKind === 'none' || snapshot?.hasKey)
  ) {
    void loadModels({ silent: true })
  }

  benchBtn.addEventListener('click', async () => {
    benchBtn.disabled = true
    setFeedback('Benchmarking SQL completion speed...', 'neutral')
    try {
      const { filtered } = getSortedAndFilteredModels()
      const currentM = modelInput.value.trim()
      const candidates = allModels.length > 0
        ? [...new Set([currentM, ...filtered.map((x) => x.model)].filter(Boolean))].slice(0, 4)
        : [currentM].filter(Boolean)
      if (candidates.length === 0) {
        setFeedback('Enter a model or fetch models first.', 'error')
        return
      }
      const res = await rpc(
        'ai.models.bench',
        { format: currentFormat, baseUrl: urlInput.value.trim(), key: keyInput.value.trim(), models: candidates },
        { signal: modalAbort.signal }
      )
      if (disposed) return
      const rows = (res?.results || [])
        .filter((r) => r.ok)
        .sort((a, b) => (a.ms ?? 99999) - (b.ms ?? 99999))
      if (rows.length > 0) {
        const msMap = new Map(rows.map((r) => [r.model, r.ms]))
        if (allModels.length === 0) {
          allModels = rows.map((r, idx) => ({ model: r.model, order: idx, ms: r.ms }))
        } else {
          allModels = allModels.map((item) =>
            msMap.has(item.model) ? { ...item, ms: msMap.get(item.model) } : item
          )
        }
        modelInput.value = rows[0].model
        pinnedModel = rows[0].model
        renderModelList()
        setFeedback(`Fastest: ${rows[0].model} (${rows[0].ms} ms)`, 'ok')
      } else {
        setFeedback(res?.message || 'No candidate model passed SQL benchmark.', 'error')
      }
    } catch (err) {
      if (!disposed) setFeedback(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      if (!disposed) benchBtn.disabled = false
    }
  })

  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true
    setFeedback('Testing provider...', 'neutral')
    try {
      await persistCurrentDraft()
      if (disposed) return
      const res = await rpc('ai.provider.test', undefined, { signal: modalAbort.signal })
      if (disposed) return
      if (res?.ok) {
        setFeedback(`Connected cleanly in ${res.ms ?? 0} ms.`, 'ok')
      } else {
        setFeedback(res?.message || 'Connection test failed.', 'error')
      }
      const fresh = await rpc('ai.status.get', undefined, { signal: modalAbort.signal })
      if (disposed) return
      snapshot = fresh
      statusPill.textContent = formatAiStatusBadge(fresh).label
      syncDestinationIndicator(true)
      onStatusUpdated?.(fresh)
    } catch (err) {
      if (!disposed) setFeedback(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      if (!disposed) testBtn.disabled = false
    }
  })

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true
    try {
      await persistCurrentDraft()
      close()
    } catch (err) {
      if (!disposed) {
        setFeedback(err instanceof Error ? err.message : String(err), 'error')
        saveBtn.disabled = false
      }
    }
  })

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

export async function saveOrcaSettingsPatch(patch) {
  if (!patch || typeof window === 'undefined' || !window.orca) {
    return
  }
  const settingsApi = window.orca.settings
  const hostApi = window.orca.host
  for (const [key, value] of Object.entries(patch)) {
    if (settingsApi && typeof settingsApi.set === 'function') {
      await settingsApi.set(key, value)
    } else if (hostApi && typeof hostApi.call === 'function') {
      await hostApi.call('settings.set', { key, value })
    }
  }
}
