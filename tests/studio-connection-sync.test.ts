import * as fs from 'node:fs'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { JsonValue, OrcaWorkerApi, PanelRequestContext } from 'orca/worker'

const isolatedHomeState = vi.hoisted(() => ({
  isolatedHomedir: '',
}))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  const fsMod = await import('node:fs')
  const pathMod = await import('node:path')
  isolatedHomeState.isolatedHomedir = fsMod.mkdtempSync(
    pathMod.join(actual.tmpdir(), 'datanoa-studio-sync-home-')
  )
  const homedir = () => isolatedHomeState.isolatedHomedir
  return {
    ...actual,
    homedir,
    default: {
      ...actual,
      homedir,
    },
  }
})

import activateWorker, { deactivate as deactivateWorker } from '../src/worker/index'

type Listener = (payload: unknown) => void

function createInMemoryWorkerHarness() {
  const storage = new Map<string, JsonValue>()
  const secrets = new Map<string, string>()
  const settings = new Map<string, JsonValue>([
    ['maxRows', 1000],
    ['queryTimeoutSeconds', 30],
    ['aiEnabled', false],
  ])
  const handlers = new Map<string, (input: unknown, ctx: PanelRequestContext) => Promise<unknown>>()
  const posts: Array<{ event: string; payload: unknown }> = []

  const orcaApi = {
    storage: {
      get: async (k: string) => (storage.has(k) ? (storage.get(k) ?? null) : null),
      set: async (k: string, v: JsonValue) => {
        storage.set(k, v)
      },
      delete: async (k: string) => {
        storage.delete(k)
      },
    },
    secrets: {
      get: async (k: string) => (secrets.has(k) ? (secrets.get(k) ?? null) : null),
      set: async (k: string, v: string) => {
        secrets.set(k, v)
      },
      delete: async (k: string) => {
        secrets.delete(k)
      },
      protection: async () => 'os-keyring',
    },
    settings: {
      get: async (k?: string) => {
        if (!k) return Object.fromEntries(settings.entries()) as unknown as JsonValue
        return settings.has(k) ? (settings.get(k) ?? null) : null
      },
      onDidChange: () => ({ dispose: () => {} }),
    },
    panels: {
      handle: (name: string, fn: (input: unknown, ctx: PanelRequestContext) => Promise<unknown>) => {
        handlers.set(name, fn)
        return { dispose: () => handlers.delete(name) }
      },
      post: (event: string, payload?: unknown) => {
        posts.push({ event, payload })
      },
    },
    commands: {
      register: () => ({ dispose: () => {} }),
    },
    host: {
      has: () => false,
      call: async () => null,
    },
    workspace: {
      folders: [],
    },
    log: () => {},
  } as unknown as OrcaWorkerApi

  activateWorker(orcaApi)

  return {
    storage,
    posts,
    request: async (name: string, input?: unknown, ctx: { panel?: string } = {}) => {
      const handler = handlers.get(name)
      if (!handler) throw new Error(`No worker handler registered for ${name}`)
      const panelCtx = { panel: ctx.panel ?? 'datanoa-panel' } as unknown as PanelRequestContext
      return await handler(input, panelCtx)
    },
    deactivate: async () => {
      await deactivateWorker()
    },
  }
}

function installMinimalDom() {
  const g = globalThis as Record<string, unknown>
  const prev = {
    Window: g.Window,
    window: g.window,
    document: g.document,
    Element: g.Element,
    HTMLElement: g.HTMLElement,
    HTMLSelectElement: g.HTMLSelectElement,
    HTMLOptionElement: g.HTMLOptionElement,
    Node: g.Node,
    Event: g.Event,
    localStorage: g.localStorage,
    MutationObserver: g.MutationObserver,
    requestAnimationFrame: g.requestAnimationFrame,
    cancelAnimationFrame: g.cancelAnimationFrame,
    getComputedStyle: g.getComputedStyle,
    orca: g.orca,
  }

  const docListeners = new Map<string, Set<(ev: unknown) => void>>()
  const winListeners = new Map<string, Set<(ev: unknown) => void>>()

  class FakeClassList {
    private set = new Set<string>()
    constructor(private el: FakeEl) {}
    add(...names: string[]) {
      for (const n of names) for (const p of String(n).split(/\s+/).filter(Boolean)) this.set.add(p)
      this.el._syncClass()
    }
    remove(...names: string[]) {
      for (const n of names) for (const p of String(n).split(/\s+/).filter(Boolean)) this.set.delete(p)
      this.el._syncClass()
    }
    toggle(name: string, force?: boolean) {
      if (force === true) this.add(name)
      else if (force === false) this.remove(name)
      else if (this.set.has(name)) this.remove(name)
      else this.add(name)
      return this.set.has(name)
    }
    contains(name: string) {
      return this.set.has(name)
    }
    toArray() {
      return Array.from(this.set)
    }
    _setFrom(v: string) {
      this.set = new Set(String(v || '').split(/\s+/).filter(Boolean))
    }
  }

  class FakeEl {
    tagName: string
    nodeType = 1
    children: FakeEl[] = []
    parentElement: FakeEl | null = null
    style: Record<string, string> = {}
    dataset: Record<string, string> = {}
    classList: FakeClassList
    value = ''
    disabled = false
    selected = false
    type = ''
    title = ''
    placeholder = ''
    name = ''
    alt = ''
    src = ''
    tabIndex = 0
    scrollTop = 0
    scrollLeft = 0
    clientWidth = 800
    clientHeight = 600
    private _attrs = new Map<string, string>()
    private _listeners = new Map<string, Set<(e: unknown) => void>>()
    private _text = ''
    private _id = ''

    constructor(tag: string) {
      this.tagName = tag.toUpperCase()
      this.classList = new FakeClassList(this)
    }
    get attributes() {
      return Array.from(this._attrs.entries()).map(([name, value]) => ({ name, value }))
    }
    get id() {
      return this._id
    }
    set id(v: string) {
      this._id = String(v)
      this._attrs.set('id', this._id)
    }
    get className() {
      return this.classList.toArray().join(' ')
    }
    set className(v: string) {
      this.classList._setFrom(v)
      this._attrs.set('class', this.className)
    }
    _syncClass() {
      this._attrs.set('class', this.className)
    }
    get nodeValue() {
      return this.nodeType === 3 ? this._text : null
    }
    get childNodes() {
      return this.children
    }
    get firstChild() {
      return this.children[0] ?? null
    }
    get lastChild() {
      return this.children[this.children.length - 1] ?? null
    }
    get nextSibling() {
      if (!this.parentElement) return null
      const i = this.parentElement.children.indexOf(this)
      return i >= 0 ? (this.parentElement.children[i + 1] ?? null) : null
    }
    get textContent(): string {
      return this.nodeType === 3 ? this._text : this._text + this.children.map((c) => c.textContent).join('')
    }
    set textContent(v: string) {
      const str = String(v ?? '')
      for (const c of this.children) c.parentElement = null
      this.children = []
      if (this.nodeType === 3) {
        this._text = str
      } else {
        this._text = ''
        if (str) {
          const t = new FakeEl('#text')
          t.nodeType = 3
          t._text = str
          t.parentElement = this
          this.children.push(t)
        }
      }
    }
    get innerHTML() {
      return ''
    }
    set innerHTML(_v: string) {
      this._text = ''
      for (const c of this.children) c.parentElement = null
      this.children = []
    }
    get options() {
      return this.querySelectorAll('option')
    }
    get selectedIndex() {
      const opts = this.options
      const idx = opts.findIndex((o) => o.value === this.value)
      return idx >= 0 ? idx : opts.length > 0 ? 0 : -1
    }
    setAttribute(k: string, v: string) {
      const sv = String(v)
      this._attrs.set(k, sv)
      if (k === 'class') this.className = sv
      if (k === 'id') this._id = sv
    }
    getAttribute(k: string) {
      return this._attrs.get(k) ?? null
    }
    removeAttribute(k: string) {
      this._attrs.delete(k)
    }
    hasAttribute(k: string) {
      return this._attrs.has(k)
    }
    appendChild<T extends FakeEl>(c: T): T {
      if (c.parentElement) c.remove()
      c.parentElement = this
      this.children.push(c)
      return c
    }
    append(...nodes: Array<FakeEl | string>) {
      for (const n of nodes) {
        if (typeof n === 'string') {
          const t = new FakeEl('#text')
          t.nodeType = 3
          t.textContent = n
          this.appendChild(t)
        } else {
          this.appendChild(n)
        }
      }
    }
    prepend(...nodes: Array<FakeEl | string>) {
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i]
        if (typeof n !== 'string') {
          if (n.parentElement) n.remove()
          n.parentElement = this
          this.children.unshift(n)
        }
      }
    }
    insertBefore<T extends FakeEl>(n: T, r: FakeEl | null): T {
      if (!r) return this.appendChild(n)
      if (n.parentElement) n.remove()
      const i = this.children.indexOf(r)
      if (i < 0) return this.appendChild(n)
      n.parentElement = this
      this.children.splice(i, 0, n)
      return n
    }
    removeChild<T extends FakeEl>(c: T): T {
      const i = this.children.indexOf(c)
      if (i >= 0) {
        this.children.splice(i, 1)
        c.parentElement = null
      }
      return c
    }
    remove() {
      this.parentElement?.removeChild(this)
    }
    cloneNode(deep = false): FakeEl {
      const c = new FakeEl(this.tagName)
      c.nodeType = this.nodeType
      c._text = this._text
      c.className = this.className
      if (deep) for (const ch of this.children) c.appendChild(ch.cloneNode(true))
      return c
    }
    addEventListener(t: string, fn: (e: unknown) => void) {
      let s = this._listeners.get(t)
      if (!s) {
        s = new Set()
        this._listeners.set(t, s)
      }
      s.add(fn)
    }
    removeEventListener(t: string, fn: (e: unknown) => void) {
      this._listeners.get(t)?.delete(fn)
    }
    dispatchEvent(ev: { type: string; target?: unknown }) {
      const obj = { stopPropagation() {}, preventDefault() {}, ...ev, target: ev.target ?? this, currentTarget: this }
      for (const fn of Array.from(this._listeners.get(ev.type) ?? [])) fn(obj)
      return true
    }
    click() {
      this.dispatchEvent({ type: 'click', target: this })
    }
    focus() {}
    select() {}
    scrollIntoView() {}
    getBoundingClientRect() {
      return { left: 16, top: 40, right: 256, bottom: 68, width: 240, height: 28 }
    }
    getClientRects() {
      return [this.getBoundingClientRect()]
    }
    contains(o: FakeEl | null) {
      let cur = o
      while (cur) {
        if (cur === this) return true
        cur = cur.parentElement
      }
      return false
    }
    closest(sel: string): FakeEl | null {
      let cur: FakeEl | null = this
      while (cur) {
        if (matches(cur, sel)) return cur
        cur = cur.parentElement
      }
      return null
    }
    querySelectorAll(sel: string): FakeEl[] {
      const out: FakeEl[] = []
      const walk = (node: FakeEl) => {
        for (const c of node.children) {
          if (matches(c, sel)) out.push(c)
          walk(c)
        }
      }
      walk(this)
      return out
    }
    querySelector(sel: string) {
      return this.querySelectorAll(sel)[0] ?? null
    }
  }

  function matches(el: FakeEl, sel: string) {
    return sel.split(',').some((raw) => {
      const s = raw.trim()
      if (s.startsWith('.')) return el.classList.contains(s.slice(1))
      if (s.startsWith('#')) return el.id === s.slice(1)
      return el.tagName.toLowerCase() === s.toLowerCase()
    })
  }

  const html = new FakeEl('html')
  const head = new FakeEl('head')
  const body = new FakeEl('body')
  html.append(head, body)
  const doc: Record<string, unknown> = {
    documentElement: html,
    head,
    body,
    activeElement: null,
    visibilityState: 'visible',
    createElement: (t: string) => new FakeEl(t),
    createElementNS: (_ns: string, t: string) => new FakeEl(t),
    createTextNode: (t: string) => Object.assign(new FakeEl('#text'), { nodeType: 3, textContent: t }),
    createRange: () => ({
      setStart() {},
      setEnd() {},
      setStartBefore() {},
      setEndAfter() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 8, bottom: 14, width: 8, height: 14 }),
      getClientRects: () => [{ left: 0, top: 0, right: 8, bottom: 14, width: 8, height: 14 }],
    }),
    getElementById: (id: string) => body.querySelector(`#${id}`) ?? head.querySelector(`#${id}`),
    querySelector: (s: string) => body.querySelector(s) ?? head.querySelector(s),
    querySelectorAll: (s: string) => [...head.querySelectorAll(s), ...body.querySelectorAll(s)],
    getSelection: () => ({ rangeCount: 0, removeAllRanges() {}, addRange() {} }),
    hasFocus: () => false,
    addEventListener: (type: string, fn: (ev: unknown) => void) => {
      let s = docListeners.get(type)
      if (!s) {
        s = new Set()
        docListeners.set(type, s)
      }
      s.add(fn)
    },
    removeEventListener: (type: string, fn: (ev: unknown) => void) => {
      docListeners.get(type)?.delete(fn)
    },
  }
  const localStore = new Map<string, string>()
  const localStorageShim = {
    getItem: (k: string) => localStore.get(k) ?? null,
    setItem: (k: string, v: string) => {
      localStore.set(String(k), String(v))
    },
    removeItem: (k: string) => {
      localStore.delete(k)
    },
    clear: () => localStore.clear(),
  }
  class FakeMutationObserver {
    observe() {}
    disconnect() {}
    takeRecords() {
      return []
    }
  }
  class FakeWindow {}
  const win: Record<string, unknown> = Object.assign(new FakeWindow(), {
    document: doc,
    innerWidth: 1280,
    innerHeight: 800,
    localStorage: localStorageShim,
    MutationObserver: FakeMutationObserver,
    addEventListener: (type: string, fn: (ev: unknown) => void) => {
      let s = winListeners.get(type)
      if (!s) {
        s = new Set()
        winListeners.set(type, s)
      }
      s.add(fn)
    },
    removeEventListener: (type: string, fn: (ev: unknown) => void) => {
      winListeners.get(type)?.delete(fn)
    },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    getSelection: doc.getSelection,
    requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0) as unknown as number,
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    setTimeout,
    clearTimeout,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  })
  doc.defaultView = win
  ;(FakeEl.prototype as unknown as Record<string, unknown>).ownerDocument = doc
  ;(FakeEl.prototype as unknown as Record<string, unknown>).getRootNode = () => doc

  Object.assign(globalThis, {
    Window: FakeWindow,
    window: win,
    document: doc,
    Element: FakeEl,
    HTMLElement: FakeEl,
    HTMLSelectElement: FakeEl,
    HTMLOptionElement: FakeEl,
    Node: FakeEl,
    Event: class {
      type: string
      bubbles: boolean
      constructor(t: string, init?: { bubbles?: boolean }) {
        this.type = t
        this.bubbles = Boolean(init?.bubbles)
      }
    },
    localStorage: localStorageShim,
    MutationObserver: FakeMutationObserver,
    requestAnimationFrame: win.requestAnimationFrame,
    cancelAnimationFrame: win.cancelAnimationFrame,
    getComputedStyle: win.getComputedStyle,
  })
  if (!g.navigator) {
    Object.defineProperty(g, 'navigator', {
      value: { platform: 'Win32', userAgent: 'node-test' },
      configurable: true,
    })
  }

  return {
    body,
    doc: doc as {
      createElement: (t: string) => FakeEl
      body: FakeEl
      querySelector: (s: string) => FakeEl | null
      querySelectorAll: (s: string) => FakeEl[]
    },
    win,
    localStore,
    restore: () => Object.assign(globalThis, prev),
  }
}

let cleanup: (() => void) | undefined
afterEach(async () => {
  await deactivateWorker()
  cleanup?.()
  cleanup = undefined
})

afterAll(() => {
  if (isolatedHomeState.isolatedHomedir) {
    try {
      fs.rmSync(isolatedHomeState.isolatedHomedir, { recursive: true, force: true })
    } catch {
      // ignore temp cleanup errors
    }
  }
})

describe('Studio connection selector live sync', () => {
  it('re-renders an already-open popover and invokes onOpen to pull Side Panel connections', async () => {
    const env = installMinimalDom()
    cleanup = env.restore

    const { enhanceStudioCollapsibleSelect } = await import('../src/editor/db-icons')

    const wrap = env.doc.createElement('div')
    const selectEl = env.doc.createElement('select') as unknown as HTMLSelectElement
    const opt0 = env.doc.createElement('option')
    opt0.value = ''
    opt0.textContent = 'Select Connection...'
    selectEl.appendChild(opt0 as unknown as Node)
    wrap.appendChild(selectEl as unknown as Node)
    env.body.appendChild(wrap)

    let openCalls = 0
    enhanceStudioCollapsibleSelect(selectEl, {
      tooltipPrefix: 'Active Database Connection',
      onOpen: () => {
        openCalls += 1
      },
    })

    const trigger = wrap.querySelector('.datanoa-custom-select-trigger')
    expect(trigger).toBeTruthy()
    trigger?.click()
    expect(openCalls).toBe(1)

    // Side Panel saves a new grouped Redis connection while Studio's popover is already open
    const grp = env.doc.createElement('optgroup')
    grp.setAttribute('label', 'Production')
    const optRedis = env.doc.createElement('option')
    optRedis.value = 'conn_redis_1'
    optRedis.textContent = 'redis-16858 (redis)'
    optRedis.dataset.driver = 'redis'
    grp.appendChild(optRedis)
    selectEl.appendChild(grp as unknown as Node)

    enhanceStudioCollapsibleSelect(selectEl, {
      tooltipPrefix: 'Active Database Connection',
      onOpen: () => {
        openCalls += 1
      },
    })

    const labels = env.body.querySelectorAll('.datanoa-custom-select-item-label').map((n) => n.textContent.trim())
    expect(labels).toContain('redis-16858 (redis)')
  })

  it('mounts Studio SQL console + connection selector cleanly and pulls newly added Side Panel Redis connection on dropdown click even without push events', async () => {
    const { DatanoaStudioEditor } = await import('../src/editor/index')
    const env = installMinimalDom()
    cleanup = env.restore

    const conns: Array<{ id: string; name: string; driver: string; host?: string }> = []
    env.win.orca = (globalThis as Record<string, unknown>).orca = {
      locale: 'en-US',
      host: { has: () => false, call: async () => null },
      on: () => ({ dispose() {} }),
      plugin: {
        request: async (name: string) => {
          if (name === 'connections.list') return [...conns]
          if (name === 'ai.status.get') {
            return {
              enabled: false,
              state: 'off',
              lastMs: null,
              suggested: 0,
              reason: null,
              format: 'openai',
              baseUrl: 'https://api.openai.com/v1',
              host: 'api.openai.com',
              model: 'gpt-4o-mini',
              maxTokens: 96,
              explainLanguage: 'auto',
              hasKey: false,
              destination: 'none',
            }
          }
          if (name === 'schema.introspect') return { objects: [], schemas: [], defaultSchema: '' }
          return null
        },
        on: () => ({ dispose() {} }),
      },
      storage: { get: async () => null, set: async () => {}, delete: async () => {} },
    }

    const editor = new DatanoaStudioEditor()
    await new Promise((r) => setTimeout(r, 40))

    expect(env.body.querySelector('.cm-editor')).toBeTruthy()
    const trigger = env.body.querySelector('.datanoa-custom-select-trigger')
    expect(trigger?.textContent).toContain('Select Connection...')

    // Side Panel adds Redis connection, WITHOUT emitting connections.changed event
    conns.push({ id: 'conn_redis_1', name: 'redis-16858.crce194', driver: 'redis', host: 'redis-16858' })
    trigger?.click()
    await new Promise((r) => setTimeout(r, 40))

    const labels = env.body.querySelectorAll('.datanoa-custom-select-item-label').map((n) => n.textContent.trim())
    expect(labels).toContain('redis-16858.crce194 (redis)')
    editor.destroy()
  }, 15000)
})

describe('Studio connection sync E2E with real worker', () => {
  it('updates Studio connection dropdown after deleting old connections and renaming in worker', async () => {
    const env = installMinimalDom()
    cleanup = env.restore
    const worker = createInMemoryWorkerHarness()

    const initialConnections = [
      {
        id: 'conn_prod_1',
        name: 'aws-1-ap-southeast-1.pooler.supab...',
        driver: 'postgres',
        folder: 'Production',
        colorTag: 'prod',
        host: 'aws-1-ap-southeast-1.pooler.supabase.com',
        port: 6543,
        database: 'postgres',
      },
      {
        id: 'conn_old_sqlite',
        name: 'datadb',
        driver: 'sqlite',
        filePath: './data.db',
      },
      {
        id: 'conn_old_test',
        name: 'hanami-test',
        driver: 'postgres',
        host: 'localhost',
        port: 5432,
        database: 'hanami_test',
      },
    ]

    for (const profile of initialConnections) {
      await worker.request('connection.save', { profile })
    }

    const pluginListeners = new Map<string, Set<Listener>>()
    const frameListeners = new Map<string, Set<Listener>>()

    let deliveredPostsIdx = 0
    const flushWorkerPosts = () => {
      while (deliveredPostsIdx < worker.posts.length) {
        const p = worker.posts[deliveredPostsIdx++]
        for (const fn of Array.from(pluginListeners.get(p.event) || [])) {
          fn(p.payload)
        }
      }
    }

    const orcaFrameMock = {
      locale: 'en-US',
      host: { has: () => false, call: async () => null },
      on: (ev: string, fn: Listener) => {
        let s = frameListeners.get(ev)
        if (!s) {
          s = new Set()
          frameListeners.set(ev, s)
        }
        s.add(fn)
        return { dispose: () => s?.delete(fn) }
      },
      plugin: {
        request: async (name: string, input?: unknown) => {
          const res = await worker.request(name, input, { panel: 'datanoa-studio' })
          flushWorkerPosts()
          return res
        },
        on: (ev: string, fn: Listener) => {
          let s = pluginListeners.get(ev)
          if (!s) {
            s = new Set()
            pluginListeners.set(ev, s)
          }
          s.add(fn)
          return { dispose: () => s?.delete(fn) }
        },
      },
      storage: {
        get: async (k: string) => worker.storage.get(k) ?? null,
        set: async (k: string, v: JsonValue) => {
          worker.storage.set(k, v)
        },
        delete: async (k: string) => {
          worker.storage.delete(k)
        },
      },
    }
    env.win.orca = orcaFrameMock
    ;(globalThis as Record<string, unknown>).orca = orcaFrameMock

    const { initializeEditor } = await import('../src/editor/index')
    const editor = initializeEditor()
    expect(editor, 'Studio editor should initialize').toBeTruthy()
    if (!editor) throw new Error('Studio editor did not initialize')

    await new Promise((r) => setTimeout(r, 50))
    await editor.refreshConnections()

    const triggerBtn = env.body.querySelector('.datanoa-custom-select-trigger')
    expect(triggerBtn, 'Custom connection selector trigger should be mounted').toBeTruthy()
    if (!triggerBtn) throw new Error('Custom selector trigger missing')

    // Open dropdown initially and check all 3 connections appear
    triggerBtn.click()
    const initialLabels = env.body
      .querySelectorAll('.datanoa-custom-select-item-label')
      .map((el) => el.textContent.trim())
      .filter((label) => label !== 'Select Connection...')
    expect(initialLabels).toHaveLength(3)
    // Close dropdown
    triggerBtn.click()

    // Delete old connections from worker (as Side Panel does) and rename prod connection
    await worker.request('connection.delete', { id: 'conn_old_sqlite' })
    await worker.request('connection.delete', { id: 'conn_old_test' })
    await worker.request('connection.save', {
      profile: {
        id: 'conn_prod_1',
        name: 'hanami production',
        driver: 'postgres',
        folder: 'Production',
        colorTag: 'prod',
        host: 'aws-1-ap-southeast-1.pooler.supabase.com',
        port: 6543,
        database: 'postgres',
      },
    })
    flushWorkerPosts()
    await new Promise((r) => setTimeout(r, 50))

    // Check custom dropdown after deletion & rename
    triggerBtn.click()
    const updatedLabels = env.body
      .querySelectorAll('.datanoa-custom-select-item-label')
      .map((el) => el.textContent.trim())
      .filter((label) => label !== 'Select Connection...')

    expect(updatedLabels).toEqual(['hanami production (postgres) [PROD]'])

    editor.destroy()
    await worker.deactivate()
  }, 15000)

  it('refreshes connection list via Studio Refresh button even when a connection is active without push events', async () => {
    const env = installMinimalDom()
    cleanup = env.restore
    const worker = createInMemoryWorkerHarness()

    await worker.request('connection.save', {
      profile: { id: 'conn_prod_1', name: 'old-prod', driver: 'postgres', folder: 'Production', colorTag: 'prod' },
    })
    await worker.request('connection.save', {
      profile: { id: 'conn_old_sqlite', name: 'datadb', driver: 'sqlite', filePath: './data.db' },
    })

    const pluginListeners = new Map<string, Set<Listener>>()
    const orcaFrameMock = {
      locale: 'en-US',
      host: { has: () => false, call: async () => null },
      on: () => ({ dispose() {} }),
      plugin: {
        request: async (name: string, input?: unknown) => {
          if (name === 'schema.introspect') {
            return { objects: [{ name: 'users', kind: 'table' }], schemas: ['public'], defaultSchema: 'public' }
          }
          return await worker.request(name, input, { panel: 'datanoa-studio' })
        },
        on: (ev: string, fn: Listener) => {
          let s = pluginListeners.get(ev)
          if (!s) {
            s = new Set()
            pluginListeners.set(ev, s)
          }
          s.add(fn)
          return { dispose: () => s?.delete(fn) }
        },
      },
      storage: {
        get: async (k: string) => worker.storage.get(k) ?? null,
        set: async (k: string, v: JsonValue) => {
          worker.storage.set(k, v)
        },
        delete: async (k: string) => {
          worker.storage.delete(k)
        },
      },
    }
    env.win.orca = orcaFrameMock
    ;(globalThis as Record<string, unknown>).orca = orcaFrameMock

    const { initializeEditor } = await import('../src/editor/index')
    const editor = initializeEditor()
    expect(editor).toBeTruthy()
    if (!editor) throw new Error('Studio editor did not initialize')

    await new Promise((r) => setTimeout(r, 50))
    await editor.refreshConnections()

    // Delete old connection & rename active connection WITHOUT forwarding panels.post to editor
    await worker.request('connection.delete', { id: 'conn_old_sqlite' })
    await worker.request('connection.save', {
      profile: { id: 'conn_prod_1', name: 'hanami production', driver: 'postgres', folder: 'Production', colorTag: 'prod' },
    })

    // Click Studio's Refresh button
    const refreshBtn = env.body.querySelectorAll('button').find((b) => b.textContent.trim() === 'Refresh')
    expect(refreshBtn, 'Studio Refresh button should exist').toBeTruthy()
    refreshBtn?.click()
    await new Promise((r) => setTimeout(r, 80))

    const triggerBtn = env.body.querySelector('.datanoa-custom-select-trigger')
    expect(triggerBtn).toBeTruthy()
    triggerBtn?.click()
    const labelsAfterRefresh = env.body
      .querySelectorAll('.datanoa-custom-select-item-label')
      .map((el) => el.textContent.trim())
      .filter((label) => label !== 'Select Connection...')

    expect(labelsAfterRefresh).toEqual(['hanami production (postgres) [PROD]'])

    editor.destroy()
    await worker.deactivate()
  }, 15000)

  it('syncs Studio connections when host storage changes even if panels.post is not delivered to customEditor', async () => {
    const env = installMinimalDom()
    cleanup = env.restore
    const worker = createInMemoryWorkerHarness()

    await worker.request('connection.save', {
      profile: { id: 'conn_prod_1', name: 'old-prod', driver: 'postgres', folder: 'Production', colorTag: 'prod' },
    })
    await worker.request('connection.save', {
      profile: { id: 'conn_old_test', name: 'hanami-test', driver: 'postgres' },
    })

    const storageListeners = new Set<(change: { key: string; area?: string }) => void>()
    const orcaFrameMock = {
      locale: 'en-US',
      host: { has: () => false, call: async () => null },
      on: () => ({ dispose() {} }),
      plugin: {
        request: async (name: string, input?: unknown) => {
          if (name === 'schema.introspect') {
            return { objects: [], schemas: ['public'], defaultSchema: 'public' }
          }
          return await worker.request(name, input, { panel: 'datanoa-studio' })
        },
        on: () => ({ dispose() {} }),
      },
      storage: {
        get: async (k: string) => worker.storage.get(k) ?? null,
        set: async (k: string, v: JsonValue) => {
          worker.storage.set(k, v)
        },
        delete: async (k: string) => {
          worker.storage.delete(k)
        },
        onDidChange: (fn: (change: { key: string; area?: string }) => void) => {
          storageListeners.add(fn)
          return { dispose: () => storageListeners.delete(fn) }
        },
      },
    }
    env.win.orca = orcaFrameMock
    ;(globalThis as Record<string, unknown>).orca = orcaFrameMock

    const { initializeEditor } = await import('../src/editor/index')
    const editor = initializeEditor()
    expect(editor).toBeTruthy()
    if (!editor) throw new Error('Studio editor did not initialize')

    await new Promise((r) => setTimeout(r, 50))
    await editor.refreshConnections()

    // Delete connection in worker (Side Panel flow) and emit storage.onDidChange
    await worker.request('connection.delete', { id: 'conn_old_test' })
    for (const fn of storageListeners) {
      fn({ key: 'datanoa.savedConnections' })
    }
    await new Promise((r) => setTimeout(r, 80))

    const triggerBtn = env.body.querySelector('.datanoa-custom-select-trigger')
    expect(triggerBtn).toBeTruthy()
    triggerBtn?.click()
    const labels = env.body
      .querySelectorAll('.datanoa-custom-select-item-label')
      .map((el) => el.textContent.trim())
      .filter((label) => label !== 'Select Connection...')

    expect(labels).toEqual(['old-prod (postgres) [PROD]'])

    editor.destroy()
    await worker.deactivate()
  }, 15000)

  it('purges stale deleted connections from localStorage warm cache when worker list becomes empty', async () => {
    const env = installMinimalDom()
    cleanup = env.restore
    const worker = createInMemoryWorkerHarness()

    await worker.request('connection.save', {
      profile: { id: 'conn_old_1', name: 'old-sqlite', driver: 'sqlite', filePath: ':memory:' },
    })

    const orcaFrameMock = {
      locale: 'en-US',
      host: { has: () => false, call: async () => null },
      on: () => ({ dispose() {} }),
      plugin: {
        request: async (name: string, input?: unknown) => {
          if (name === 'schema.introspect') {
            return { objects: [], schemas: ['main'], defaultSchema: 'main' }
          }
          return await worker.request(name, input, { panel: 'datanoa-studio' })
        },
        on: () => ({ dispose() {} }),
      },
      storage: {
        get: async (k: string) => worker.storage.get(k) ?? null,
        set: async (k: string, v: JsonValue) => {
          worker.storage.set(k, v)
        },
        delete: async (k: string) => {
          worker.storage.delete(k)
        },
      },
    }
    env.win.orca = orcaFrameMock
    ;(globalThis as Record<string, unknown>).orca = orcaFrameMock

    const { initializeEditor } = await import('../src/editor/index')
    const editor = initializeEditor()
    expect(editor).toBeTruthy()
    if (!editor) throw new Error('Studio editor did not initialize')

    await new Promise((r) => setTimeout(r, 50))
    await editor.refreshConnections()

    // Seed warm cache as Studio does after loading data
    env.localStore.set(
      'datanoa.studioWarmCache',
      JSON.stringify({
        updatedAt: Date.now(),
        connections: [{ id: 'conn_old_1', name: 'old-sqlite', driver: 'sqlite' }],
        activeConnectionId: 'conn_old_1',
      })
    )

    // Delete the last remaining connection and refresh Studio
    await worker.request('connection.delete', { id: 'conn_old_1' })
    await editor.refreshConnections()

    const cachedRaw = env.localStore.get('datanoa.studioWarmCache')
    const cached = cachedRaw ? (JSON.parse(cachedRaw) as { connections?: unknown[] }) : null
    expect(cached?.connections ?? []).toEqual([])

    editor.destroy()
    await worker.deactivate()
  }, 15000)
})
