import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as connectionUriMod from '../src/drivers/common/connection-uri'
import { BUILTIN_ENGINE_CATALOG } from '../src/drivers/common/engine-catalog'
import { createDriver, getDriver } from '../src/drivers/index'
import {
  BYOD_DRIVER_IDS,
  BYOD_DRIVER_SLOTS,
  getByodDefaultPort,
} from '../src/drivers/driver-manager'
import { resolveEffectiveTlsOptions } from '../src/drivers/common/tls-and-tunnel'
import {
  detectRecognizableSqlCredential,
  scrubDriverErrorText,
} from '../src/drivers/common/sql-credentials'
import { LibsqlSession } from '../src/drivers/libsql/driver'
import { MysqlDriver } from '../src/drivers/mysql/driver'
import { RedisSession, redactRedisCommandArgs } from '../src/drivers/redis/driver'
import { detectDockerTargetLocality } from '../src/worker/docker-compose-discovery'
import {
  getDefaultByodDriverDirs,
  sanitizeConnectionProfile,
  scrubCredentialsInText,
} from '../src/worker/worker-utils'
import { registerConnectionHandlers } from '../src/worker/rpc-connections'
import {
  readLocalStudioViewState,
  scrubSensitiveStringForLocalStorage,
  writeLocalStudioWarmCache,
  writeStudioViewStateSnapshot,
} from '../src/editor/document-meta'
import { scrubSensitiveText } from '../src/shared-sql-safety.js'
import { maskUriSecret, openStudioConnectionModal } from '../src/editor/connection-modal'
import { BYOD_ENGINES, STUDIO_ENGINES } from '../src/editor/db-icons'
import { getByodNpmPackage } from '../src/editor/driver-manager-modal'
import { analyzeDangerousSql as studioAnalyzeDangerousSql } from '../src/editor/sql-safety'
import {
  openStudioCommandPalette,
  openStudioCreateTableModal,
  openStudioDangerTableModal,
  openStudioFeedbackModal,
  openStudioImportModal,
} from '../src/editor/studio-modals'
import {
  BYOD_LOGO_PATHS,
  DB_LOGO_PATHS,
  buildPanelDbSvgMarkupMap,
} from '../src/shared-db-icons.js'
import { parseJsonPreservingBigInts } from '../src/shared-grid-paste.js'
import * as panelCore from '../src/panel/panel-core.js'
import {
  createPanelConnectionFormController,
  formatConnSubtitle,
} from '../src/panel/panel-connection-form.js'
import { createPanelSqlController } from '../src/panel/panel-sql.js'
import type { ConnectionProfile } from '../src/protocol'

function installDom() {
  const prev = {
    Window: (globalThis as Record<string, unknown>).Window,
    window: (globalThis as Record<string, unknown>).window,
    document: (globalThis as Record<string, unknown>).document,
    Element: (globalThis as Record<string, unknown>).Element,
    HTMLElement: (globalThis as Record<string, unknown>).HTMLElement,
    HTMLInputElement: (globalThis as Record<string, unknown>).HTMLInputElement,
    HTMLSelectElement: (globalThis as Record<string, unknown>).HTMLSelectElement,
    HTMLButtonElement: (globalThis as Record<string, unknown>).HTMLButtonElement,
    Node: (globalThis as Record<string, unknown>).Node,
    Event: (globalThis as Record<string, unknown>).Event,
    localStorage: (globalThis as Record<string, unknown>).localStorage,
    MutationObserver: (globalThis as Record<string, unknown>).MutationObserver,
    requestAnimationFrame: (globalThis as Record<string, unknown>).requestAnimationFrame,
    cancelAnimationFrame: (globalThis as Record<string, unknown>).cancelAnimationFrame,
    getComputedStyle: (globalThis as Record<string, unknown>).getComputedStyle,
  }

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
    checked = false
    disabled = false
    selected = false
    hidden = false
    readOnly = false
    type = ''
    title = ''
    placeholder = ''
    htmlFor = ''
    tabIndex = 0
    maxLength = 524288
    inputMode = ''
    scrollTop = 0
    scrollLeft = 0
    clientWidth = 800
    clientHeight = 600
    innerHTMLUsed = false
    private _attrs = new Map<string, string>()
    private _listeners = new Map<string, Set<(e: unknown) => void>>()
    private _text = ''
    private _id = ''

    constructor(tag: string) {
      this.tagName = tag.toUpperCase()
      this.classList = new FakeClassList(this)
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
    get childNodes() {
      return this.children
    }
    get childElementCount() {
      return this.children.filter((c) => c.nodeType === 1).length
    }
    get firstChild() {
      return this.children[0] ?? null
    }
    get lastChild() {
      return this.children[this.children.length - 1] ?? null
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
    set innerHTML(v: string) {
      if (String(v ?? '').length > 0) this.innerHTMLUsed = true
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
    removeChild<T extends FakeEl>(c: T): T {
      const i = this.children.indexOf(c)
      if (i >= 0) {
        this.children.splice(i, 1)
        c.parentElement = null
      }
      return c
    }
    insertBefore<T extends FakeEl>(c: T, ref: FakeEl | null): T {
      if (c.parentElement) c.remove()
      c.parentElement = this
      if (!ref) {
        this.children.push(c)
      } else {
        const idx = this.children.indexOf(ref)
        if (idx >= 0) this.children.splice(idx, 0, c)
        else this.children.push(c)
      }
      return c
    }
    remove() {
      this.parentElement?.removeChild(this)
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
      const obj = {
        stopPropagation() {},
        preventDefault() {},
        ...ev,
        target: ev.target ?? this,
        currentTarget: this,
      }
      for (const fn of Array.from(this._listeners.get(ev.type) ?? [])) fn(obj)
      return true
    }
    click() {
      if (this.disabled) return
      if (this.tagName === 'INPUT' && this.type === 'checkbox') {
        this.checked = !this.checked
        this.dispatchEvent({ type: 'change', target: this })
      }
      this.dispatchEvent({ type: 'click', target: this })
    }
    focus() {}
    select() {}
    scrollIntoView() {}
    getBoundingClientRect() {
      return { left: 16, top: 40, right: 256, bottom: 68, width: 240, height: 28 }
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

  function matchesSingle(el: FakeEl, rawSelector: string): boolean {
    let s = rawSelector.trim()
    if (!s) return false
    const attrMatches = Array.from(s.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g))
    s = s.replace(/\[[^\]]+\]/g, '').trim()
    for (const m of attrMatches) {
      const attr = m[1]
      const expected = m[2]
      const actual = attr.startsWith('data-') ? el.dataset[attr.slice(5)] ?? el.getAttribute(attr) : el.getAttribute(attr)
      if (expected !== undefined ? actual !== expected : actual === null) return false
    }
    if (!s) return true
    if (s.startsWith('.')) return el.classList.contains(s.slice(1))
    if (s.startsWith('#')) return el.id === s.slice(1)
    return el.tagName.toLowerCase() === s.toLowerCase()
  }

  function matches(el: FakeEl, sel: string) {
    return sel.split(',').some((part) => matchesSingle(el, part))
  }

  const html = new FakeEl('html')
  const head = new FakeEl('head')
  const body = new FakeEl('body')
  html.append(head, body)
  const ls = new Map<string, string>()
  const doc = {
    documentElement: html,
    head,
    body,
    activeElement: null,
    createElement: (t: string) => new FakeEl(t),
    createElementNS: (_ns: string, t: string) => new FakeEl(t),
    createTextNode: (t: string) => Object.assign(new FakeEl('#text'), { nodeType: 3, textContent: t }),
    getElementById: (id: string) => body.querySelector(`#${id}`) ?? head.querySelector(`#${id}`),
    querySelector: (s: string) => body.querySelector(s) ?? head.querySelector(s),
    querySelectorAll: (s: string) => [...head.querySelectorAll(s), ...body.querySelectorAll(s)],
    addEventListener() {},
    removeEventListener() {},
  }
  const win = {
    document: doc,
    innerWidth: 1280,
    innerHeight: 800,
    localStorage: {
      getItem: (k: string) => ls.get(k) ?? null,
      setItem: (k: string, v: string) => ls.set(k, String(v)),
      removeItem: (k: string) => ls.delete(k),
    },
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle: () => ({ backgroundColor: 'rgb(0, 0, 0)', getPropertyValue: () => '' }),
    requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0) as unknown as number,
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    setTimeout,
    clearTimeout,
  }
  ;(FakeEl.prototype as unknown as Record<string, unknown>).ownerDocument = doc

  Object.assign(globalThis, {
    Window: class {},
    window: win,
    document: doc,
    Element: FakeEl,
    HTMLElement: FakeEl,
    HTMLInputElement: FakeEl,
    HTMLSelectElement: FakeEl,
    HTMLButtonElement: FakeEl,
    Node: FakeEl,
    Event: class {
      type: string
      constructor(t: string) {
        this.type = t
      }
    },
    localStorage: win.localStorage,
    requestAnimationFrame: win.requestAnimationFrame,
    cancelAnimationFrame: win.cancelAnimationFrame,
    getComputedStyle: win.getComputedStyle,
  })

  return {
    FakeEl,
    body,
    doc,
    win,
    ls,
    restore: () => Object.assign(globalThis, prev),
  }
}

let cleanupDom: (() => void) | undefined
afterEach(() => {
  cleanupDom?.()
  cleanupDom = undefined
  vi.restoreAllMocks()
})

describe('Issue #2 Security & UI Audit Fixes', () => {
  describe('Item 8: PG-family & MySQL-family URI TLS verification', () => {
    it('maps sslmode and ssl-mode into ssl, sslMode, and sslRejectUnauthorized via resolveTlsSettings and parseConnectionUri', () => {
      const resolveTlsSettings = (
        connectionUriMod as unknown as {
          resolveTlsSettings?: (
            params: URLSearchParams,
            defaultSsl: boolean
          ) => { ssl: boolean; sslMode?: string; sslRejectUnauthorized?: boolean }
        }
      ).resolveTlsSettings
      expect(typeof resolveTlsSettings).toBe('function')

      expect(resolveTlsSettings?.(new URLSearchParams('sslmode=verify-full'), false)).toEqual({
        ssl: true,
        sslMode: 'verify-full',
        sslRejectUnauthorized: true,
      })
      expect(resolveTlsSettings?.(new URLSearchParams('ssl-mode=VERIFY_IDENTITY'), false)).toEqual({
        ssl: true,
        sslMode: 'verify-full',
        sslRejectUnauthorized: true,
      })
      expect(resolveTlsSettings?.(new URLSearchParams('sslmode=verify-ca'), false)).toEqual({
        ssl: true,
        sslMode: 'verify-ca',
        sslRejectUnauthorized: true,
      })
      expect(resolveTlsSettings?.(new URLSearchParams('ssl-mode=verify_ca'), false)).toEqual({
        ssl: true,
        sslMode: 'verify-ca',
        sslRejectUnauthorized: true,
      })
      expect(resolveTlsSettings?.(new URLSearchParams('sslmode=require'), false)).toEqual({
        ssl: true,
        sslMode: 'require',
        sslRejectUnauthorized: false,
      })
      expect(resolveTlsSettings?.(new URLSearchParams('ssl-mode=REQUIRED'), false)).toEqual({
        ssl: true,
        sslMode: 'require',
        sslRejectUnauthorized: false,
      })
      expect(resolveTlsSettings?.(new URLSearchParams('sslmode=disable'), true)).toEqual({
        ssl: false,
        sslMode: 'disable',
      })
      expect(resolveTlsSettings?.(new URLSearchParams('sslmode=prefer'), false)).toEqual({
        ssl: true,
      })

      const pgFull = connectionUriMod.parseConnectionUri(
        'postgres://app:secret@db.example.com:5432/prod?sslmode=verify-full'
      )
      expect(pgFull.ok).toBe(true)
      expect(pgFull.profile?.ssl).toBe(true)
      expect(pgFull.profile?.sslMode).toBe('verify-full')
      expect(pgFull.profile?.sslRejectUnauthorized).toBe(true)

      const myCa = connectionUriMod.parseConnectionUri(
        'mysql://app:secret@db.example.com:3306/prod?ssl-mode=verify_ca'
      )
      expect(myCa.ok).toBe(true)
      expect(myCa.profile?.ssl).toBe(true)
      expect(myCa.profile?.sslMode).toBe('verify-ca')
      expect(myCa.profile?.sslRejectUnauthorized).toBe(true)

      const pgReq = connectionUriMod.parseConnectionUri(
        'postgresql://app:secret@db.example.com:5432/prod?sslmode=require'
      )
      expect(pgReq.profile?.sslMode).toBe('require')
      expect(pgReq.profile?.sslRejectUnauthorized).toBe(false)
    })

    it('enforces rejectUnauthorized: true for verify-full and verify-ca even without custom CA file paths', async () => {
      const fullOpts = await resolveEffectiveTlsOptions({
        id: 'c1',
        name: 'pg',
        driver: 'postgres',
        database: 'app',
        host: 'db.example.com',
        ssl: true,
        sslMode: 'verify-full',
      })
      expect(fullOpts && typeof fullOpts === 'object' ? fullOpts.rejectUnauthorized : null).toBe(true)

      const caOpts = await resolveEffectiveTlsOptions({
        id: 'c2',
        name: 'my',
        driver: 'mysql',
        database: 'app',
        host: 'db.example.com',
        ssl: true,
        sslMode: 'verify-ca',
      })
      expect(caOpts && typeof caOpts === 'object' ? caOpts.rejectUnauthorized : null).toBe(true)
    })

    it('preserves parsed sslMode & sslRejectUnauthorized in Studio and Side Panel when importing a URI into a fresh profile', async () => {
      const env = installDom()
      cleanupDom = env.restore

      let studioSaved: unknown = null
      let mountedModal: InstanceType<typeof env.FakeEl> | null = null
      openStudioConnectionModal({
        isBackdropActive: () => true,
        mountModal: (el) => {
          mountedModal = el as unknown as InstanceType<typeof env.FakeEl>
          env.body.appendChild(mountedModal)
          return env.doc.createElement('div') as unknown as HTMLDivElement
        },
        closeModal: () => {},
        createElapsedTimer: () => () => {},
        updateStatus: () => {},
        activateSavedConnection: async () => {},
        requestPlugin: async (method: string, payload?: unknown) => {
          if (method === 'connection.parseUri') {
            const { uri } = payload as { uri: string }
            return connectionUriMod.parseConnectionUri(uri)
          }
          if (method === 'connection.test') return { ok: true }
          if (method === 'connection.save') {
            studioSaved = payload
            return { ok: true, id: 'conn_1' }
          }
          if (method === 'connections.list') return []
          if (method === 'drivers.list') return { drivers: [] }
          if (method === 'workspace.listScopes') return { workspaces: [] }
          return {}
        },
        onSaved: async () => {},
        onDeleted: async () => {},
      })

      const uriInp = mountedModal?.querySelector('.datanoa-conn-uri-input')
      expect(uriInp).toBeTruthy()
      if (uriInp) {
        uriInp.value = 'postgres://alice:secret@pg.example.com:5432/appdb?sslmode=verify-full'
      }
      const buttons = mountedModal?.querySelectorAll('button') ?? []
      const parseBtn = buttons.find((b) => b.textContent === 'Parse URI')
      parseBtn?.click()
      await new Promise((r) => setTimeout(r, 20))

      const saveBtn = buttons.find((b) => b.textContent === 'Save & Connect')
      saveBtn?.click()
      await new Promise((r) => setTimeout(r, 30))

      const savedStudioProfile = (studioSaved as { profile?: ConnectionProfile } | null)?.profile
      expect(savedStudioProfile?.ssl).toBe(true)
      expect(savedStudioProfile?.sslMode).toBe('verify-full')
      expect(savedStudioProfile?.sslRejectUnauthorized).toBe(true)

      // Side Panel fresh form URI import
      const panelIds = [
        'uriInput',
        'parseUriBtn',
        'formName',
        'formFolder',
        'formWorkspaceScope',
        'formFilePath',
        'formLibsqlUrl',
        'formAuthToken',
        'formLibsqlDb',
        'formHost',
        'formPort',
        'formDatabase',
        'formUser',
        'formPassword',
        'formClickhouseUrl',
        'formOptions',
        'formRedisDb',
        'formSsl',
        'formReadOnly',
        'sqliteFields',
        'libsqlFields',
        'serverFields',
        'clickhouseUrlRow',
        'pgOptionsRow',
        'sqlDbRow',
        'redisDbRow',
        'connFormTitle',
        'saveFormBtn',
      ]
      for (const id of panelIds) {
        const tag = id === 'formWorkspaceScope' || id === 'formRedisDb' ? 'select' : 'input'
        const el = env.doc.createElement(tag)
        el.id = id
        if (id === 'formSsl' || id === 'formReadOnly') el.type = 'checkbox'
        env.body.appendChild(el)
      }
      ;(globalThis as unknown as { window: Record<string, unknown> }).window.orca = {
        plugin: {
          request: async (method: string, payload?: unknown) => {
            if (method === 'connection.parseUri') {
              return connectionUriMod.parseConnectionUri((payload as { uri: string }).uri)
            }
            return {}
          },
        },
      }
      const panelState: Record<string, unknown> = {
        formDriver: 'sqlite',
        formColorTag: 'none',
        editingId: null,
        connections: [],
      }
      const formCtrl = createPanelConnectionFormController({
        state: panelState,
        showBanner: () => {},
        showFormNotice: () => {},
        clearFormNotice: () => {},
        setFormOpen: () => {},
        updateViewportLayout: () => {},
        savePanelViewState: () => {},
      })
      await formCtrl.handleParseUri('mysql://bob:pass@my.example.com:3306/shop?ssl-mode=verify_ca')
      const sub = formCtrl.buildFormSubmission('conn_new_mysql')
      expect(sub.profile.ssl).toBe(true)
      expect(sub.profile.sslMode).toBe('verify-ca')
      expect(sub.profile.sslRejectUnauthorized).toBe(true)
    })
  })

  describe('Item 10: LibSQL encrypted trusted destinations & Hrana base_url', () => {
    it('validates LibSQL endpoint URLs matching D1 security policy', () => {
      const validateLibsqlEndpointUrl = (
        connectionUriMod as unknown as {
          validateLibsqlEndpointUrl?: (
            rawUrl: string,
            options?: { hasAuthToken?: boolean }
          ) => { ok: boolean; url?: string; error?: string }
        }
      ).validateLibsqlEndpointUrl
      expect(typeof validateLibsqlEndpointUrl).toBe('function')

      expect(validateLibsqlEndpointUrl?.('https://my-db.turso.io', { hasAuthToken: true })?.ok).toBe(true)
      expect(validateLibsqlEndpointUrl?.('libsql://my-db.turso.io', { hasAuthToken: true })?.ok).toBe(true)
      expect(validateLibsqlEndpointUrl?.('http://localhost:8080', { hasAuthToken: false })?.ok).toBe(true)
      expect(validateLibsqlEndpointUrl?.('http://127.0.0.1:8080', { hasAuthToken: false })?.ok).toBe(true)
      expect(validateLibsqlEndpointUrl?.('http://[::1]:8080', { hasAuthToken: false })?.ok).toBe(true)

      // Plain HTTP rejected with auth token or non-loopback host
      expect(validateLibsqlEndpointUrl?.('http://localhost:8080', { hasAuthToken: true })?.ok).toBe(false)
      expect(validateLibsqlEndpointUrl?.('http://remote.example.com:8080', { hasAuthToken: false })?.ok).toBe(
        false
      )
      // Embedded userinfo & credential query params rejected
      expect(validateLibsqlEndpointUrl?.('https://user:pass@my-db.turso.io')?.ok).toBe(false)
      expect(validateLibsqlEndpointUrl?.('https://my-db.turso.io?jwt=secret')?.ok).toBe(false)
      expect(validateLibsqlEndpointUrl?.('https://my-db.turso.io?authToken=secret')?.ok).toBe(false)
      expect(validateLibsqlEndpointUrl?.('https://my-db.turso.io\u0000')?.ok).toBe(false)

      // parseConnectionUri enforces validateLibsqlEndpointUrl
      expect(
        connectionUriMod.parseConnectionUri('libsql://my-db.turso.io?authToken=eyJ123').ok
      ).toBe(true)
      expect(
        connectionUriMod.parseConnectionUri('http://127.0.0.1:8080?authToken=eyJ123').ok
      ).toBe(false)
      expect(
        connectionUriMod.parseConnectionUri('http://remote.turso.io').ok
      ).toBe(false)
    })

    it('enforces Hrana base_url origin/subdomain validation and redirect: error in LibsqlSession', async () => {
      expect(
        () =>
          new LibsqlSession(
            {
              id: 'l1',
              name: 'bad',
              driver: 'libsql',
              database: 'main',
              url: 'http://localhost:8080',
            },
            'secret-token'
          )
      ).toThrow(/HTTP/i)

      const session = new LibsqlSession(
        {
          id: 'l2',
          name: 'turso',
          driver: 'libsql',
          database: 'main',
          url: 'https://db.turso.io',
        },
        'secret-token'
      )
      const resolveTargetUrl = (
        session as unknown as { resolveTargetUrl: (baseUrl?: string | null) => string }
      ).resolveTargetUrl.bind(session)

      expect(resolveTargetUrl('https://db.turso.io')).toBe('https://db.turso.io/v2/pipeline')
      expect(resolveTargetUrl('https://shard-1.db.turso.io')).toBe(
        'https://shard-1.db.turso.io/v2/pipeline'
      )

      // Protocol downgrade, userinfo, query, hash, suffix spoof, different port must throw INVALID_ENDPOINT
      for (const badBase of [
        'http://db.turso.io',
        'http://shard-1.db.turso.io',
        'https://user:pass@db.turso.io',
        'https://db.turso.io?jwt=1',
        'https://db.turso.io#frag',
        'https://evildb.turso.io',
        'https://evil.com',
        'https://shard-1.db.turso.io:8443',
      ]) {
        expect(() => resolveTargetUrl(badBase)).toThrow()
      }

      // IP literal initial host must never allow subdomain spoofing
      const ipSession = new LibsqlSession({
        id: 'l3',
        name: 'local',
        driver: 'libsql',
        database: 'main',
        url: 'https://127.0.0.1:8443',
      })
      const resolveIpTarget = (
        ipSession as unknown as { resolveTargetUrl: (baseUrl?: string | null) => string }
      ).resolveTargetUrl.bind(ipSession)
      expect(() => resolveIpTarget('https://sub.127.0.0.1:8443')).toThrow()

      // Verify sendHranaPipeline passes redirect: 'error'
      let capturedInit: RequestInit | undefined
      vi.spyOn(globalThis, 'fetch').mockImplementation((async (_input: unknown, init?: RequestInit) => {
        capturedInit = init
        return new Response(
          JSON.stringify({
            baton: null,
            base_url: null,
            results: [{ type: 'ok', response: { type: 'execute', result: { cols: [], rows: [] } } }],
          }),
          { status: 200 }
        )
      }) as typeof fetch)

      await session.test()
      expect(capturedInit?.redirect).toBe('error')

      // Verify LibsqlSession.getDdl includes triggers alongside table, view, and index
      let capturedDdlSql = ''
      vi.spyOn(globalThis, 'fetch').mockImplementation((async (_input: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body || '{}')) as {
          requests?: Array<{ stmt?: { sql?: string } }>
        }
        capturedDdlSql = body.requests?.[0]?.stmt?.sql || ''
        return new Response(
          JSON.stringify({
            baton: null,
            base_url: null,
            results: [
              {
                type: 'ok',
                response: {
                  type: 'execute',
                  result: {
                    cols: [{ name: 'type' }, { name: 'sql' }],
                    rows: [
                      [{ type: 'text', value: 'table' }, { type: 'text', value: 'CREATE TABLE t (id INT)' }],
                      [
                        { type: 'text', value: 'trigger' },
                        { type: 'text', value: 'CREATE TRIGGER trg AFTER INSERT ON t BEGIN SELECT 1; END' },
                      ],
                    ],
                  },
                },
              },
            ],
          }),
          { status: 200 }
        )
      }) as typeof fetch)
      const ddl = await session.getDdl('t')
      expect(capturedDdlSql).toMatch(/type\s+IN\s*\(\s*'index'\s*,\s*'trigger'\s*\)/i)
      expect(ddl).toContain('CREATE TRIGGER trg')
    })

    it('enforces validateLibsqlEndpointUrl in rpc-connections connection.save and connection.test', async () => {
      const handlers = new Map<string, (input: unknown) => Promise<unknown>>()
      registerConnectionHandlers({
        orca: {
          storage: { get: async () => null, set: async () => {}, delete: async () => {} },
          panels: { post: () => {} },
        } as never,
        registerHandler: ((name: string, fn: (input: unknown) => Promise<unknown>) => {
          handlers.set(name, fn)
        }) as never,
        sessionManager: {
          getStoredConnections: async () => [],
          saveStoredConnections: async () => {},
          getSecret: async () => 'stored-libsql-token',
          getExtendedSecrets: async () => ({}),
          saveSecret: async () => {},
          copySecret: async () => {},
          closeSession: async () => {},
          testConnection: async () => ({ ok: true }),
        } as never,
        driverManager: { setBackupLoader: () => {} } as never,
      })

      const saveHandler = handlers.get('connection.save')
      const testHandler = handlers.get('connection.test')

      await expect(
        saveHandler?.({
          profile: {
            id: 'conn_libsql_bad',
            name: 'Bad LibSQL',
            driver: 'libsql',
            database: 'main',
            url: 'http://remote.example.com',
          },
        })
      ).rejects.toThrow(/HTTPS/i)

      await expect(
        saveHandler?.({
          profile: {
            id: 'conn_libsql_loopback_tok',
            name: 'Loopback Token',
            driver: 'libsql',
            database: 'main',
            url: 'http://localhost:8080',
          },
          authToken: 'my-secret-token',
        })
      ).rejects.toThrow(/HTTP/i)

      await expect(
        testHandler?.({
          profile: {
            id: 'conn_libsql_saved',
            name: 'Saved Loopback With Stored Token',
            driver: 'libsql',
            database: 'main',
            url: 'http://127.0.0.1:8080',
            hasAuthToken: true,
          },
        })
      ).rejects.toThrow(/HTTP/i)
    })
  })

  describe('Item 11: Redis AUTH/credentials blocked from local history & redacted', () => {
    it('detects Redis credential commands in detectRecognizableSqlCredential', () => {
      const positives = [
        'AUTH my_super_secret',
        'auth "my quoted secret"',
        'AUTH default s3cr3tPass',
        'HELLO 3 AUTH default s3cr3tPass',
        'hello 3 setname app auth admin "top secret"',
        'ACL SETUSER alice on >PlainPass123 ~* +@all',
        'ACL SETUSER bob on #0123456789abcdef0123456789abcdef',
        'CONFIG SET requirepass "redis-pass-1"',
        'config set maxmemory 100mb masterauth ReplicaSecret99',
        'MIGRATE 10.0.0.2 6379 mykey 0 5000 COPY AUTH migrateSecret',
        'MIGRATE 10.0.0.2 6379 "" 0 5000 AUTH2 default migrateSecret2 KEYS k1 k2',
      ]
      for (const cmd of positives) {
        expect(detectRecognizableSqlCredential(cmd, 'redis')).toBe('sql-auth-literal')
        expect(detectRecognizableSqlCredential(cmd)).toBe('sql-auth-literal')
      }

      const negatives = [
        'GET auth',
        'SET user:auth "ok"',
        'ACL SETUSER alice on nopass ~* +@all',
        'CONFIG SET maxmemory 256mb',
        'CONFIG GET requirepass',
        'HELLO 3 SETNAME myclient',
        'MIGRATE 10.0.0.2 6379 "" 0 5000 KEYS AUTH AUTH2',
        'AUTH <PASSWORD>',
      ]
      for (const cmd of negatives) {
        expect(detectRecognizableSqlCredential(cmd, 'redis')).toBeNull()
      }
    })

    it('blocks Redis credential drafts from Studio local view state', () => {
      const env = installDom()
      cleanupDom = env.restore

      writeStudioViewStateSnapshot({
        sqlDraft: 'HELLO 3 AUTH default my_redis_secret',
        consoleTabs: {
          activeTabId: 't1',
          tabs: [
            { id: 't1', title: 'Query 1', sql: 'ACL SETUSER bob on >my_acl_secret' },
            { id: 't2', title: 'Query 2', sql: 'CONFIG SET requirepass my_req_pass' },
            { id: 't3', title: 'Query 3', sql: 'GET safe_key' },
          ],
        },
      })
      const saved = readLocalStudioViewState()
      expect(saved?.sqlDraft).toBeUndefined()
      expect(saved?.consoleTabs?.tabs[0]?.sql).toBe('')
      expect(saved?.consoleTabs?.tabs[1]?.sql).toBe('')
      expect(saved?.consoleTabs?.tabs[2]?.sql).toBe('GET safe_key')
    })

    it('redacts sensitive arguments in RedisSession multi-line batch execution echo', async () => {
      const session = new RedisSession({
        id: 'r1',
        name: 'redis',
        driver: 'redis',
        database: '0',
        host: '127.0.0.1',
        port: 6379,
      })
      vi.spyOn(
        session as unknown as { openAuthenticatedClient: () => Promise<unknown> },
        'openAuthenticatedClient'
      ).mockResolvedValue({
        sendCommand: async () => 'OK',
        destroy: () => {},
      })

      const script = [
        'AUTH default SuperSecret1',
        'HELLO 3 AUTH admin SuperSecret2 SETNAME cli',
        'ACL SETUSER alice on >SuperSecret3 #DeadBeefHash4',
        'CONFIG SET requirepass SuperSecret5',
        'CONFIG SET masterauth SuperSecret6',
        'MIGRATE 127.0.0.1 6380 k 0 1000 AUTH SuperSecret7',
        'MIGRATE 127.0.0.1 6380 k 0 1000 AUTH2 admin SuperSecret8',
        'PING',
      ].join('\n')

      const res = await session.runQuery('q_batch', script)
      const echoed = res.rows.map((r) => String(r[0]))
      const joined = echoed.join('\n')
      for (let i = 1; i <= 7; i++) {
        expect(joined).not.toContain(`SuperSecret${i}`)
      }
      expect(joined).not.toContain('DeadBeefHash4')
      expect(echoed[0]).toContain('***')
      expect(echoed[1]).toContain('***')
      expect(echoed[2]).toContain('***')
      expect(echoed[3]).toContain('***')
      expect(echoed[4]).toContain('***')
      expect(echoed[5]).toContain('***')
      expect(echoed[6]).toContain('***')
    })
  })

  describe('Item 12 & 13: URL credential scrubbing, LibSQL display names, full URI masking & Auto-Detect scope', () => {
    it('scrubs jwt query parameters across all URL scrubbers and sanitizeConnectionProfile', () => {
      expect(
        connectionUriMod.scrubUrlCredentials('https://db.turso.io/v2?jwt=eyJSecret&mode=ro')
      ).toBe('https://db.turso.io/v2?mode=ro')
      expect(scrubCredentialsInText('libsql://db.turso.io?jwt=eyJSecret')).not.toContain('eyJSecret')

      const sanitized = sanitizeConnectionProfile({
        id: 'c_lib',
        name: 'https://user:pass123@db.turso.io?jwt=eyJToken99',
        driver: 'libsql',
        database: 'main',
        url: 'https://user:pass123@db.turso.io?jwt=eyJToken99',
      })
      expect(sanitized.name).not.toContain('pass123')
      expect(sanitized.name).not.toContain('eyJToken99')
      expect(sanitized.url).not.toContain('pass123')
      expect(sanitized.url).not.toContain('eyJToken99')

      const env = installDom()
      cleanupDom = env.restore
      writeLocalStudioWarmCache({
        updatedAt: Date.now(),
        connections: [
          {
            id: 'c1',
            name: 'turso',
            driver: 'libsql',
            database: 'main',
            url: 'https://db.turso.io?jwt=eyJWarmSecret',
          },
        ],
      })
      const rawWarm = env.ls.get('datanoa.studioWarmCache') || ''
      expect(rawWarm).not.toContain('eyJWarmSecret')
    })

    it('masks passwords containing @ and all sensitive query params in maskUriSecret / maskConnectionUriSecret and formatConnSubtitle', () => {
      const uriWithAtInPass =
        'postgres://admin:p@ss@w0rd!@db.internal.net:5432/prod?sslmode=verify-full&password=qp1&jwt=eyJ2&authToken=at3&api_key=ak4'
      const maskedStudio = maskUriSecret(uriWithAtInPass)
      const maskedPanel = panelCore.maskConnectionUriSecret(uriWithAtInPass)

      expect(maskedStudio).toBe(
        'postgres://admin:***@db.internal.net:5432/prod?sslmode=verify-full&password=***&jwt=***&authToken=***&api_key=***'
      )
      expect(maskedPanel).toBe(maskedStudio)

      const subtitle = formatConnSubtitle({
        driver: 'libsql',
        url: 'libsql://user:s3cr3t@my-org.turso.io?jwt=eyJToken',
        database: 'main',
      })
      expect(subtitle).toBe('libsql://user:***@my-org.turso.io?jwt=***')
    })

    it('derives default LibSQL name from hostname (never raw URL) and strips credentials from saved LibSQL url', () => {
      const env = installDom()
      cleanupDom = env.restore

      const panelIds = [
        'uriInput',
        'formName',
        'formFolder',
        'formWorkspaceScope',
        'formFilePath',
        'formLibsqlUrl',
        'formAuthToken',
        'formLibsqlDb',
        'formHost',
        'formPort',
        'formDatabase',
        'formUser',
        'formPassword',
        'formClickhouseUrl',
        'formOptions',
        'formRedisDb',
        'formSsl',
        'formReadOnly',
      ]
      for (const id of panelIds) {
        const el = env.doc.createElement('input')
        el.id = id
        env.body.appendChild(el)
      }
      const libsqlInp = env.doc.getElementById('formLibsqlUrl')
      if (libsqlInp) {
        libsqlInp.value = 'libsql://user: leakedPass@my-app-org.turso.io?jwt=leakedJwt&authToken=leakedTok'.replace(
          ' ',
          ''
        )
      }

      const formCtrl = createPanelConnectionFormController({
        state: { formDriver: 'libsql', formColorTag: 'none', editingId: null },
        showBanner: () => {},
        showFormNotice: () => {},
        clearFormNotice: () => {},
        setFormOpen: () => {},
        updateViewportLayout: () => {},
        savePanelViewState: () => {},
      })
      const sub = formCtrl.buildFormSubmission('conn_libsql_1')
      expect(sub.profile.name).toBe('my-app-org.turso.io')
      expect(sub.profile.url).not.toContain('leakedPass')
      expect(sub.profile.url).not.toContain('leakedJwt')
      expect(sub.profile.url).not.toContain('leakedTok')
    })

    it('displays only masked URI in #uriInput when clicking an .env chip and shows "Other Local Docker" badge when workspaceMatched is false', async () => {
      const env = installDom()
      cleanupDom = env.restore

      let mountedModal: InstanceType<typeof env.FakeEl> | null = null
      openStudioConnectionModal({
        isBackdropActive: () => true,
        mountModal: (el) => {
          mountedModal = el as unknown as InstanceType<typeof env.FakeEl>
          env.body.appendChild(mountedModal)
          return env.doc.createElement('div') as unknown as HTMLDivElement
        },
        closeModal: () => {},
        createElapsedTimer: () => () => {},
        updateStatus: () => {},
        activateSavedConnection: async () => {},
        requestPlugin: async (method: string, payload?: unknown) => {
          if (method === 'workspace.detectConnections') {
            return {
              scannedDirs: ['D:\\workspace\\app'],
              sqliteFiles: [],
              envConnections: [
                {
                  envKey: 'DATABASE_URL',
                  sourceFile: '.env',
                  driver: 'postgres',
                  name: 'app-db',
                  uri: 'postgres://admin:p@ssSecret@localhost:5432/app?token=secTok',
                },
              ],
              dockerComposeConnections: [
                {
                  id: 'dc_other',
                  project: 'other-proj',
                  service: 'postgres',
                  driver: 'postgres',
                  name: 'other-proj-pg',
                  host: '127.0.0.1',
                  port: 5439,
                  database: 'otherdb',
                  sourceKind: 'live',
                  sourceFile: 'docker ps',
                  status: 'running',
                  workspaceMatched: false,
                },
              ],
            }
          }
          if (method === 'connection.parseUri') {
            return connectionUriMod.parseConnectionUri((payload as { uri: string }).uri)
          }
          if (method === 'connections.list') return []
          if (method === 'drivers.list') return { drivers: [] }
          if (method === 'workspace.listScopes') return { workspaces: [] }
          return {}
        },
        onSaved: async () => {},
        onDeleted: async () => {},
      })

      const buttons = mountedModal?.querySelectorAll('button') ?? []
      const detectBtn = buttons.find((b) => b.textContent.includes('Auto-Detect'))
      detectBtn?.click()
      await new Promise((r) => setTimeout(r, 30))

      const allBadges = mountedModal?.querySelectorAll('.datanoa-badge') ?? []
      expect(allBadges.some((b) => b.textContent === 'Other Local Docker')).toBe(true)

      const chips = mountedModal?.querySelectorAll('.datanoa-conn-chip') ?? []
      const envChip = chips.find((c) => c.textContent.includes('DATABASE_URL'))
      expect(envChip).toBeTruthy()
      envChip?.click()
      await new Promise((r) => setTimeout(r, 20))

      const uriInp = mountedModal?.querySelector('.datanoa-conn-uri-input')
      expect(uriInp?.value).toBe('postgres://admin:***@localhost:5432/app?token=***')
      expect(uriInp?.value).not.toContain('p@ssSecret')
      expect(uriInp?.value).not.toContain('secTok')
    })
  })

  describe('Item 14 + Item 1 & 4: Shared analyzeDangerousSql, Panel migration parity, and Side Panel #dangerSqlModal', () => {
    it('shares analyzeDangerousSql between Studio sql-safety.ts and Side Panel panel-core.js', () => {
      const panelAnalyze = (
        panelCore as unknown as {
          analyzeDangerousSql?: typeof studioAnalyzeDangerousSql
        }
      ).analyzeDangerousSql
      expect(typeof panelAnalyze).toBe('function')
      expect(panelAnalyze).toBe(studioAnalyzeDangerousSql)

      const findings = panelAnalyze?.('DELETE FROM users; DROP TABLE logs;', 'postgres') ?? []
      expect(findings.map((f) => f.kind)).toEqual(['delete_without_where', 'drop'])
    })

    it('supports d1, UNIQUE autoindexes, triggers, PRAGMA defer_foreign_keys, and PRAGMA foreign_key_check in buildPanelMigrationSql & validatePanelStructDraft', () => {
      const draft = panelCore.createPanelStructDraft({
        name: 'users',
        schema: 'main',
        kind: 'table',
        primaryKey: ['id'],
        columns: [
          {
            name: 'id',
            type: 'INTEGER',
            nativeType: 'INTEGER',
            nullable: false,
            defaultValue: null,
            isPrimaryKey: true,
            isAutoIncrement: false,
          },
          {
            name: 'email',
            type: 'TEXT',
            nativeType: 'TEXT',
            nullable: true,
            defaultValue: null,
            isPrimaryKey: false,
            isAutoIncrement: false,
          },
        ],
        indexes: [
          {
            name: 'sqlite_autoindex_users_1',
            isUnique: true,
            isPrimary: false,
            origin: 'u',
            columns: ['email'],
          },
        ],
        foreignKeys: [],
        triggers: [
          {
            name: 'trg_users_audit',
            sql: 'CREATE TRIGGER trg_users_audit AFTER UPDATE ON users BEGIN SELECT 1; END',
          },
        ],
      } as never)

      // Modify email to NOT NULL and default value (no trigger column rename) to trigger rebuild
      draft.columns[1].nullable = false
      draft.columns[1].defaultValue = "'nobody@example.com'"

      const sqliteStmts = panelCore.buildPanelMigrationSql(draft, 'sqlite')
      const sqliteJoined = sqliteStmts.join('\n')
      expect(sqliteJoined).toContain('PRAGMA defer_foreign_keys = ON;')
      expect(sqliteJoined).toContain('UNIQUE ("email")')
      expect(sqliteJoined).toContain('CREATE TRIGGER trg_users_audit')
      const fkCheckStmt =
        "SELECT json_extract('{}', '__datanoa_fk_violation__') FROM pragma_foreign_key_check LIMIT 1;"
      expect(sqliteJoined).toContain(fkCheckStmt)
      expect(sqliteStmts.indexOf(fkCheckStmt)).toBeLessThan(sqliteStmts.indexOf('COMMIT;'))

      const d1Plan = panelCore.validatePanelStructDraft(draft, 'd1')
      expect(d1Plan.valid).toBe(true)
      const d1Joined = d1Plan.statements.join('\n')
      expect(d1Joined).toContain('PRAGMA defer_foreign_keys = ON;')
      expect(d1Joined).toContain('UNIQUE ("email")')
      expect(d1Joined).toContain('CREATE TRIGGER trg_users_audit')
      expect(d1Joined).toContain(fkCheckStmt)
      expect(d1Joined).not.toContain('BEGIN IMMEDIATE;')
      expect(d1Joined).not.toContain('COMMIT;')
      expect(d1Plan.warnings.some((w: string) => /D1/i.test(w))).toBe(true)
    })

    it('gates destructive SQL in Side Panel runSql() with #dangerSqlModal and enforces checkbox + CONFIRM on prod connections', async () => {
      const env = installDom()
      cleanupDom = env.restore

      for (const id of [
        'runSqlBtn',
        'runAllSqlBtn',
        'explainSqlBtn',
        'formatSqlBtn',
        'cancelSqlBtn',
        'sqlSuccessBanner',
        'sqlErrorBanner',
        'sqlResultSetsBar',
        'sqlMetaBadge',
        'sqlResultWrap',
        'sqlHistoryList',
        'refreshHistoryBtn',
        'dangerSqlModal',
        'dangerSqlTitle',
        'dangerSqlBadge',
        'dangerSqlEnvWarn',
        'dangerSqlFindings',
        'dangerSqlPreview',
        'dangerSqlProdGate',
        'dangerSqlConfirmCheck',
        'dangerSqlConfirmInput',
        'dangerSqlCancelBtn',
        'dangerSqlExecuteBtn',
      ]) {
        const tag = id.endsWith('Btn') ? 'button' : id.endsWith('Input') || id.endsWith('Check') ? 'input' : 'div'
        const el = env.doc.createElement(tag)
        el.id = id
        if (id === 'dangerSqlConfirmCheck') el.type = 'checkbox'
        if (id === 'dangerSqlModal' || id === 'dangerSqlProdGate' || id === 'dangerSqlEnvWarn') {
          el.hidden = true
        }
        env.body.appendChild(el)
      }

      let executedQueries = 0
      ;(globalThis as unknown as { window: Record<string, unknown> }).window.orca = {
        plugin: {
          request: async (method: string) => {
            if (method === 'query.run') {
              executedQueries += 1
              return {
                columns: [],
                rows: [],
                rowCount: 0,
                affectedRows: 5,
                executionTimeMs: 4,
                truncated: false,
                isSelect: false,
              }
            }
            return {}
          },
        },
      }

      const activeConn: ConnectionProfile = {
        id: 'conn_prod_1',
        name: 'Prod DB',
        driver: 'postgres',
        database: 'app',
        colorTag: 'prod',
      }
      const sqlCtrl = createPanelSqlController({
        state: {
          activeConnectionId: 'conn_prod_1',
          activeQueryId: null,
          activeWorkerQueryId: null,
          historyOpen: false,
          historyEntries: [],
        },
        QUERY_TIMEOUT_MS: 5000,
        VIRT_ROW_HEIGHT_PX: 26,
        getActiveConn: () => activeConn,
        getConnById: () => activeConn,
        getSqlGridSel: () => null,
        getSuppressSortClickUntil: () => 0,
        setLastPanelCopiedText: () => {},
        computeVirtualRange: () => ({ start: 0, end: 0 }),
        attachColumnResizeHandle: () => {},
        copyText: async () => {},
        showBanner: () => {},
        loadSchema: async () => {},
        savePanelViewState: () => {},
        scheduleSavePanelViewState: () => {},
        savePanelDataCache: () => {},
      })

      sqlCtrl.setSqlText('DELETE FROM users;')
      void sqlCtrl.runSql('caret')
      await new Promise((r) => setTimeout(r, 10))

      const modal = env.doc.getElementById('dangerSqlModal')
      const execBtn = env.doc.getElementById('dangerSqlExecuteBtn')
      const checkInp = env.doc.getElementById('dangerSqlConfirmCheck')
      const textInp = env.doc.getElementById('dangerSqlConfirmInput')

      expect(modal?.hidden).toBe(false)
      expect(executedQueries).toBe(0)
      expect(execBtn?.disabled).toBe(true)

      if (checkInp) {
        checkInp.checked = true
        checkInp.dispatchEvent({ type: 'change', target: checkInp })
      }
      expect(execBtn?.disabled).toBe(true)

      if (textInp) {
        textInp.value = 'CONFIRM'
        textInp.dispatchEvent({ type: 'input', target: textInp })
      }
      expect(execBtn?.disabled).toBe(false)

      execBtn?.click()
      await new Promise((r) => setTimeout(r, 25))
      expect(modal?.hidden).toBe(true)
      expect(executedQueries).toBe(1)
    })
  })

  describe('Codex #12 Hardening Refinements (Items 1-5)', () => {
    it('#14: fail-closed when modal DOM is missing, executes immutable snapshot, aborts on connection/tab switch, and requires checkbox on non-prod + guards Explain', async () => {
      const env = installDom()
      cleanupDom = env.restore

      const executedSqls: string[] = []
      const banners: string[] = []
      ;(globalThis as unknown as { window: Record<string, unknown> }).window.orca = {
        plugin: {
          request: async (method: string, payload?: unknown) => {
            if (method === 'query.run' || method === 'query.explain') {
              executedSqls.push(`${method}:${String((payload as { sql?: string })?.sql || '')}`)
              return {
                columns: [],
                rows: [],
                rowCount: 0,
                affectedRows: 1,
                executionTimeMs: 2,
                truncated: false,
                isSelect: method === 'query.explain',
              }
            }
            return {}
          },
        },
      }

      const stateObj: Record<string, unknown> = {
        activeConnectionId: 'conn_dev',
        activeQueryId: null,
        activeWorkerQueryId: null,
        historyOpen: false,
        historyEntries: [],
      }
      const devConn: ConnectionProfile = {
        id: 'conn_dev',
        name: 'Dev DB',
        driver: 'postgres',
        database: 'app',
        colorTag: 'dev',
      }
      for (const id of [
        'runSqlBtn',
        'runAllSqlBtn',
        'explainSqlBtn',
        'formatSqlBtn',
        'cancelSqlBtn',
        'sqlSuccessBanner',
        'sqlErrorBanner',
        'sqlResultSetsBar',
        'sqlMetaBadge',
        'sqlResultWrap',
        'sqlHistoryList',
        'refreshHistoryBtn',
      ]) {
        const el = env.doc.createElement(id.endsWith('Btn') ? 'button' : 'div')
        el.id = id
        env.body.appendChild(el)
      }

      const sqlCtrlMissing = createPanelSqlController({
        state: stateObj,
        QUERY_TIMEOUT_MS: 5000,
        VIRT_ROW_HEIGHT_PX: 26,
        getActiveConn: () => devConn,
        getConnById: () => devConn,
        getSqlGridSel: () => null,
        getSuppressSortClickUntil: () => 0,
        setLastPanelCopiedText: () => {},
        computeVirtualRange: () => ({ start: 0, end: 0 }),
        attachColumnResizeHandle: () => {},
        copyText: async () => {},
        showBanner: (msg: string) => banners.push(msg),
        loadSchema: async () => {},
        savePanelViewState: () => {},
        scheduleSavePanelViewState: () => {},
        savePanelDataCache: () => {},
      })

      // Fail-closed: #dangerSqlModal missing -> must NOT execute!
      sqlCtrlMissing.setSqlText('DELETE FROM users;')
      await sqlCtrlMissing.runSql('caret')
      expect(executedSqls).toHaveLength(0)
      expect(banners.some((b) => /confirm|abort|modal/i.test(b))).toBe(true)

      // Mount full modal DOM
      for (const id of [
        'dangerSqlModal',
        'dangerSqlTitle',
        'dangerSqlBadge',
        'dangerSqlEnvWarn',
        'dangerSqlFindings',
        'dangerSqlPreview',
        'dangerSqlProdGate',
        'dangerSqlConfirmCheck',
        'dangerSqlConfirmInputWrap',
        'dangerSqlConfirmInput',
        'dangerSqlCancelBtn',
        'dangerSqlExecuteBtn',
      ]) {
        const tag = id.endsWith('Btn') ? 'button' : id.endsWith('Input') || id.endsWith('Check') ? 'input' : 'div'
        const el = env.doc.createElement(tag)
        el.id = id
        if (id === 'dangerSqlConfirmCheck') el.type = 'checkbox'
        if (id === 'dangerSqlModal') el.hidden = true
        env.body.appendChild(el)
      }

      // Non-prod still requires checkbox, and executes exact snapshotted SQL even if editor changes
      sqlCtrlMissing.setSqlText('DELETE FROM orders;')
      await sqlCtrlMissing.runSql('caret')
      const modal = env.doc.getElementById('dangerSqlModal')
      const execBtn = env.doc.getElementById('dangerSqlExecuteBtn')
      const checkInp = env.doc.getElementById('dangerSqlConfirmCheck')
      expect(modal?.hidden).toBe(false)
      expect(execBtn?.disabled).toBe(true)

      // Mutate editor text while modal is open
      sqlCtrlMissing.setSqlText('SELECT 1;')
      if (checkInp) {
        checkInp.checked = true
        checkInp.dispatchEvent({ type: 'change', target: checkInp })
      }
      expect(execBtn?.disabled).toBe(false)
      execBtn?.click()
      await new Promise((r) => setTimeout(r, 25))
      expect(executedSqls).toEqual(['query.run:DELETE FROM orders'])

      // Connection switch before confirm -> cancel with banner and 0 RPCs
      executedSqls.length = 0
      banners.length = 0
      sqlCtrlMissing.setSqlText('DROP TABLE temp_audit;')
      await sqlCtrlMissing.runSql('caret')
      stateObj.activeConnectionId = 'conn_other'
      if (checkInp) {
        checkInp.checked = true
        checkInp.dispatchEvent({ type: 'change', target: checkInp })
      }
      execBtn?.click()
      await new Promise((r) => setTimeout(r, 25))
      expect(executedSqls).toHaveLength(0)
      expect(
        banners.some((b) =>
          b.includes('Execution cancelled: active connection or tab changed before confirmation.')
        )
      ).toBe(true)

      // Tab switch before confirm -> cancel with banner and 0 RPCs
      stateObj.activeConnectionId = 'conn_dev'
      executedSqls.length = 0
      banners.length = 0
      sqlCtrlMissing.setSqlText('DROP TABLE tab_switch_audit;')
      await sqlCtrlMissing.runSql('caret')
      sqlCtrlMissing.restoreConsoleTabsState(
        {
          activeTabId: 'tab_new',
          tabs: [
            { id: 'tab_old', title: 'Console 1', sql: 'DROP TABLE tab_switch_audit;' },
            { id: 'tab_new', title: 'Console 2', sql: 'SELECT 1;' },
          ],
        },
        ''
      )
      if (checkInp) {
        checkInp.checked = true
        checkInp.dispatchEvent({ type: 'change', target: checkInp })
      }
      execBtn?.click()
      await new Promise((r) => setTimeout(r, 25))
      expect(executedSqls).toHaveLength(0)
      expect(
        banners.some((b) =>
          b.includes('Execution cancelled: active connection or tab changed before confirmation.')
        )
      ).toBe(true)

      // Explain mode with leading comment + EXPLAIN ANALYZE DELETE must be gated; plain EXPLAIN passes
      stateObj.activeConnectionId = 'conn_dev'
      sqlCtrlMissing.setSqlText('-- comment\nEXPLAIN ANALYZE DELETE FROM orders;')
      await sqlCtrlMissing.runSql('explain')
      expect(modal?.hidden).toBe(false)
      expect(executedSqls).toHaveLength(0)
      env.doc.getElementById('dangerSqlCancelBtn')?.click()

      sqlCtrlMissing.setSqlText('EXPLAIN DELETE FROM orders;')
      await sqlCtrlMissing.runSql('explain')
      expect(executedSqls).toEqual(['query.explain:EXPLAIN DELETE FROM orders'])
    })

    it('#1/#4: panel-core preserves COLLATE/DESC/ON CONFLICT, blocks composite UNIQUE partial drop, trigger conflicts, and D1 inbound FK rebuilds', () => {
      const details = {
        name: 'accounts',
        schema: 'main',
        kind: 'table',
        primaryKey: ['id'],
        columns: [
          {
            name: 'id',
            type: 'INTEGER',
            nativeType: 'INTEGER',
            nullable: false,
            defaultValue: null,
            isPrimaryKey: true,
            isAutoIncrement: false,
          },
          {
            name: 'org_id',
            type: 'INTEGER',
            nativeType: 'INTEGER',
            nullable: false,
            defaultValue: null,
            isPrimaryKey: false,
            isAutoIncrement: false,
          },
          {
            name: 'email',
            type: 'TEXT',
            nativeType: 'TEXT',
            nullable: false,
            defaultValue: null,
            isPrimaryKey: false,
            isAutoIncrement: false,
            collate: 'NOCASE',
          },
        ],
        indexes: [
          {
            name: 'sqlite_autoindex_accounts_1',
            isUnique: true,
            isPrimary: false,
            origin: 'u',
            columns: ['org_id', 'email'],
            columnSpecs: [
              { name: 'org_id' },
              { name: 'email', collate: 'NOCASE', desc: true },
            ],
            onConflict: 'REPLACE',
          },
        ],
        foreignKeys: [],
        triggers: [
          {
            name: 'trg_email_log',
            sql: 'CREATE TRIGGER trg_email_log AFTER UPDATE OF email ON accounts BEGIN INSERT INTO log VALUES (OLD.email, NEW.email); END',
          },
        ],
        inboundForeignKeys: [
          { fromTable: 'memberships', fromColumn: 'account_id', toColumn: 'id', onDelete: 'CASCADE' },
        ],
      }

      // 1. Safe rebuild preserves COLLATE, DESC, ON CONFLICT, and server-side FK check
      const safeDraft = panelCore.createPanelStructDraft(details as never)
      safeDraft.columns[1].defaultValue = '0'
      const safeStmts = panelCore.buildPanelMigrationSql(safeDraft, 'sqlite')
      const safeSql = safeStmts.join('\n')
      expect(safeSql).toContain('"email" TEXT NOT NULL COLLATE NOCASE')
      expect(safeSql).toContain('UNIQUE ("org_id", "email" COLLATE NOCASE DESC) ON CONFLICT REPLACE')
      expect(safeSql).toContain(
        "SELECT json_extract('{}', '__datanoa_fk_violation__') FROM pragma_foreign_key_check LIMIT 1;"
      )

      // 2. D1 blocked when inboundForeignKeys exist
      const d1Blocked = panelCore.validatePanelStructDraft(safeDraft, 'd1')
      expect(d1Blocked.valid).toBe(false)
      expect(d1Blocked.errors.some((e: string) => /foreign key|inbound|D1/i.test(e))).toBe(true)
      expect(() => panelCore.buildPanelMigrationSql(safeDraft, 'd1')).toThrow(/foreign key|inbound|D1/i)

      // 3. Composite UNIQUE partial column drop blocked without deleting constraint
      const dropUniqueColDraft = panelCore.createPanelStructDraft({
        ...details,
        triggers: [],
        inboundForeignKeys: [],
      } as never)
      dropUniqueColDraft.columns[2].status = 'deleted'
      const dropUniquePlan = panelCore.validatePanelStructDraft(dropUniqueColDraft, 'sqlite')
      expect(dropUniquePlan.valid).toBe(false)
      expect(dropUniquePlan.errors.some((e: string) => /UNIQUE/i.test(e))).toBe(true)

      // 4. Trigger referencing renamed column blocks; ON accounts header rewrites safely while body ref to accounts blocks
      const renameColDraft = panelCore.createPanelStructDraft({
        ...details,
        inboundForeignKeys: [],
      } as never)
      renameColDraft.columns[2].name = 'email_addr'
      renameColDraft.columns[2].nullable = true
      const renameColPlan = panelCore.validatePanelStructDraft(renameColDraft, 'sqlite')
      expect(renameColPlan.valid).toBe(false)
      expect(renameColPlan.errors.some((e: string) => /trigger/i.test(e))).toBe(true)

      const renameTblHeaderOnlyDraft = panelCore.createPanelStructDraft({
        ...details,
        inboundForeignKeys: [],
      } as never)
      renameTblHeaderOnlyDraft.tableName = 'accounts_v2'
      renameTblHeaderOnlyDraft.columns[1].defaultValue = '1'
      const renameTblHeaderOnlyPlan = panelCore.validatePanelStructDraft(renameTblHeaderOnlyDraft, 'sqlite')
      expect(renameTblHeaderOnlyPlan.valid).toBe(true)
      expect(renameTblHeaderOnlyPlan.statements.join('\n')).toContain('ON "accounts_v2"')

      const renameTblBodyRefDraft = panelCore.createPanelStructDraft({
        ...details,
        triggers: [
          {
            name: 'trg_body_ref',
            sql: 'CREATE TRIGGER trg_body_ref AFTER UPDATE ON accounts BEGIN UPDATE accounts SET org_id = NEW.org_id; END',
          },
        ],
        inboundForeignKeys: [],
      } as never)
      renameTblBodyRefDraft.tableName = 'accounts_v2'
      renameTblBodyRefDraft.columns[1].defaultValue = '1'
      const renameTblPlan = panelCore.validatePanelStructDraft(renameTblBodyRefDraft, 'sqlite')
      expect(renameTblPlan.valid).toBe(false)
      expect(renameTblPlan.errors.some((e: string) => /trigger/i.test(e))).toBe(true)
    })

    it('ROUND_1_BUGS=1: pure column rename is blocked by a surviving trigger in validatePanelStructDraft and buildPanelMigrationSql', () => {
      const draft = panelCore.createPanelStructDraft({
        name: 'accounts',
        schema: 'main',
        kind: 'table',
        primaryKey: ['id'],
        columns: [
          {
            name: 'id',
            type: 'INTEGER',
            nativeType: 'INTEGER',
            nullable: false,
            defaultValue: null,
            isPrimaryKey: true,
            isAutoIncrement: false,
          },
          {
            name: 'email',
            type: 'TEXT',
            nativeType: 'TEXT',
            nullable: false,
            defaultValue: null,
            isPrimaryKey: false,
            isAutoIncrement: false,
          },
        ],
        indexes: [],
        foreignKeys: [],
        triggers: [
          {
            name: 'trg_email_log',
            sql: 'CREATE TRIGGER trg_email_log AFTER UPDATE OF email ON accounts BEGIN INSERT INTO log VALUES (OLD.email, NEW.email); END',
          },
        ],
      } as never)

      // Pure rename only: no type/default/nullability change, so no SQLite rebuild is required.
      draft.columns[1].name = 'contact_email'
      expect(panelCore.requiresPanelSqliteRebuild(draft)).toBe(false)

      for (const driver of ['sqlite', 'libsql', 'd1']) {
        const plan = panelCore.validatePanelStructDraft(draft, driver)
        expect(plan.valid).toBe(false)
        expect(plan.errors.some((e: string) => /trigger/i.test(e))).toBe(true)
        expect(() => panelCore.buildPanelMigrationSql(draft, driver)).toThrow(/trigger/i)
      }
    })

    it('#8: resolveEffectiveTlsOptions honors sslRejectUnauthorized without explicit sslMode, MySQL sets verifyIdentity on main & cancelConnOptions, and unknown sslmode fails safely', async () => {
      const autoVerified = await resolveEffectiveTlsOptions({
        id: 't1',
        name: 'pg-auto-strict',
        driver: 'postgres',
        database: 'app',
        host: 'db.example.com',
        ssl: true,
        sslMode: 'auto',
        sslRejectUnauthorized: true,
      })
      expect(autoVerified && typeof autoVerified === 'object' ? autoVerified.rejectUnauthorized : null).toBe(
        true
      )

      const plainLocal = await resolveEffectiveTlsOptions({
        id: 't2',
        name: 'pg-plain',
        driver: 'postgres',
        database: 'app',
        host: 'localhost',
        ssl: false,
        sslMode: 'auto',
        sslRejectUnauthorized: true,
      })
      expect(plainLocal).toBeUndefined()

      // MySQL main & cancelConnOptions get verifyIdentity: true
      const mysqlDriver = new MysqlDriver('mysql')
      const mySession = await mysqlDriver.createSession({
        id: 't3',
        name: 'mysql-strict',
        driver: 'mysql',
        database: 'app',
        host: 'db.example.com',
        ssl: true,
        sslRejectUnauthorized: true,
      })
      const cancelOpts = (
        mySession as unknown as {
          cancelConnOptions?: { ssl?: { rejectUnauthorized?: boolean; verifyIdentity?: boolean } }
        }
      ).cancelConnOptions
      expect(cancelOpts?.ssl?.rejectUnauthorized).toBe(true)
      expect(cancelOpts?.ssl?.verifyIdentity).toBe(true)
      await mySession.close()

      // sslmode precedence over generic ssl=false & conservative unknown sslmode handling
      expect(
        connectionUriMod.resolveTlsSettings(new URLSearchParams('sslmode=verify-full&ssl=false'), false)
      ).toEqual({ ssl: true, sslMode: 'verify-full', sslRejectUnauthorized: true })
      expect(
        connectionUriMod.resolveTlsSettings(new URLSearchParams('sslmode=unknown_strict_mode&ssl=false'), false)
      ).toEqual({
        ssl: true,
        sslMode: 'verify-full',
        sslRejectUnauthorized: true,
        error: 'Unsupported sslmode: unknown_strict_mode',
      })
    })

    it('#10/#12: LibSQL defaults strictly to same-origin (Turso single-label replica only), redacts errors, translates FK violation, and scrubs URL #fragments', async () => {
      const genericSession = new LibsqlSession(
        {
          id: 'l_gen',
          name: 'generic',
          driver: 'libsql',
          database: 'main',
          url: 'https://db.example.com',
        },
        'tok'
      )
      expect(genericSession.resolveTargetUrl('https://db.example.com')).toBe(
        'https://db.example.com/v2/pipeline'
      )
      // Generic non-Turso domain must reject subdomains!
      expect(() => genericSession.resolveTargetUrl('https://sub.db.example.com')).toThrow()
      // Thrown error must NEVER echo embedded secret or query token
      try {
        genericSession.resolveTargetUrl('https://u:HiddenSecret777@evil.com?jwt=HiddenJwt888')
        expect.fail('Expected resolveTargetUrl to throw')
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        expect(msg).not.toContain('HiddenSecret777')
        expect(msg).not.toContain('HiddenJwt888')
      }

      // Turso managed host allows single-label HTTPS port 443 replica subdomain, rejects multi-label
      const tursoSession = new LibsqlSession(
        {
          id: 'l_turso',
          name: 'turso',
          driver: 'libsql',
          database: 'main',
          url: 'https://my-app.turso.io',
        },
        'tok'
      )
      expect(tursoSession.resolveTargetUrl('https://replica1.my-app.turso.io')).toBe(
        'https://replica1.my-app.turso.io/v2/pipeline'
      )
      expect(() => tursoSession.resolveTargetUrl('https://a.b.my-app.turso.io')).toThrow()

      // LibsqlSession.runQuery translates __datanoa_fk_violation__ into clean FOREIGN KEY constraint failed
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [
              {
                type: 'error',
                error: { message: 'bad JSON path: "__datanoa_fk_violation__"' },
              },
            ],
          }),
          { status: 200 }
        )
      )
      await expect(
        tursoSession.runQuery(
          'q_fk',
          "SELECT json_extract('{}', '__datanoa_fk_violation__') FROM pragma_foreign_key_check LIMIT 1;"
        )
      ).rejects.toThrow('FOREIGN KEY constraint failed')

      // Fragment credential scrubbing & masking
      const fragUrl = 'https://db.turso.io/v2#authToken=FragSecret1&jwt=FragJwt2&password=FragPwd3&keep=ok'
      const scrubbed = connectionUriMod.scrubUrlCredentials(fragUrl) || ''
      expect(scrubbed).not.toContain('FragSecret1')
      expect(scrubbed).not.toContain('FragJwt2')
      expect(scrubbed).not.toContain('FragPwd3')
      expect(scrubCredentialsInText(fragUrl)).not.toContain('FragSecret1')
      expect(scrubCredentialsInText(fragUrl)).not.toContain('FragJwt2')
      const maskedFrag = maskUriSecret(fragUrl)
      expect(maskedFrag).toBe('https://db.turso.io/v2#authToken=***&jwt=***&password=***&keep=ok')
    })

    it('#11/#13: unified Redis tokenizer handles quotes/escapes and ACL </!, and Auto-Detect reports accurate folder-scoped and Docker Context labels', async () => {
      const safetyMod = await import('../src/shared-sql-safety.js')
      expect(typeof (safetyMod as Record<string, unknown>).tokenizeRedisCommandLine).toBe('function')
      const tokFn = (
        safetyMod as unknown as { tokenizeRedisCommandLine: (line: string) => string[] }
      ).tokenizeRedisCommandLine
      expect(tokFn('ACL SETUSER alice "<old \\"pass\\"" !deadbeefhash')).toEqual([
        'ACL',
        'SETUSER',
        'alice',
        '<old "pass"',
        '!deadbeefhash',
      ])

      expect(detectRecognizableSqlCredential('ACL SETUSER alice <oldSecretPass', 'redis')).toBe(
        'sql-auth-literal'
      )
      expect(detectRecognizableSqlCredential('ACL SETUSER alice !0123456789abcdef', 'redis')).toBe(
        'sql-auth-literal'
      )
      expect(redactRedisCommandArgs(['ACL', 'SETUSER', 'alice', '<oldSecretPass', '!deadbeef'])).toEqual([
        'ACL',
        'SETUSER',
        'alice',
        '<***',
        '!***',
      ])

      // Docker locality detection
      expect(detectDockerTargetLocality({ DOCKER_HOST: 'ssh://ops@prod-host' })).toMatchObject({
        isLocal: false,
        contextLabel: 'Docker Context',
      })
      expect(detectDockerTargetLocality({ DOCKER_CONTEXT: 'remote-prod' })).toMatchObject({
        isLocal: false,
        contextLabel: 'Docker Context',
      })
      expect(detectDockerTargetLocality({ DOCKER_HOST: 'unix:///var/run/docker.sock' })).toMatchObject({
        isLocal: true,
        contextLabel: 'Local Docker',
      })

      // Studio Auto-Detect renders "Other Docker Context" when dockerScopeLabel is 'Docker Context'
      const env = installDom()
      cleanupDom = env.restore
      let mountedModal: InstanceType<typeof env.FakeEl> | null = null
      openStudioConnectionModal({
        isBackdropActive: () => true,
        mountModal: (el) => {
          mountedModal = el as unknown as InstanceType<typeof env.FakeEl>
          env.body.appendChild(mountedModal)
          return env.doc.createElement('div') as unknown as HTMLDivElement
        },
        closeModal: () => {},
        createElapsedTimer: () => () => {},
        updateStatus: () => {},
        activateSavedConnection: async () => {},
        requestPlugin: async (method: string, payload?: Record<string, unknown>) => {
          if (method === 'workspace.detectConnections') {
            if (payload && typeof payload.folderPath === 'string' && payload.folderPath.trim()) {
              return {
                scannedDirs: [payload.folderPath],
                folderScoped: true,
                dockerIsLocal: true,
                dockerScopeLabel: 'Local Docker',
                sqliteFiles: [],
                envConnections: [],
                dockerComposeConnections: [],
              }
            }
            return {
              scannedDirs: ['D:\\workspace\\app'],
              folderScoped: false,
              dockerIsLocal: false,
              dockerScopeLabel: 'Docker Context',
              sqliteFiles: [],
              envConnections: [],
              dockerComposeConnections: [
                {
                  id: 'dc_ctx',
                  project: 'remote-proj',
                  service: 'postgres',
                  driver: 'postgres',
                  name: 'remote-pg',
                  host: '127.0.0.1',
                  port: 5432,
                  database: 'app',
                  sourceKind: 'live',
                  sourceFile: 'docker ps',
                  status: 'running',
                  workspaceMatched: false,
                },
              ],
            }
          }
          if (method === 'connections.list') return []
          if (method === 'drivers.list') return { drivers: [] }
          if (method === 'workspace.listScopes') return { workspaces: [] }
          return {}
        },
        onSaved: async () => {},
        onDeleted: async () => {},
      })

      const detectBtn = (mountedModal?.querySelectorAll('button') ?? []).find((b) =>
        b.textContent.includes('Auto-Detect')
      )
      detectBtn?.click()
      await new Promise((r) => setTimeout(r, 30))
      const badges = (mountedModal?.querySelectorAll('.datanoa-badge') ?? []).map((b) => b.textContent)
      expect(badges).toContain('Other Docker Context')
      expect(badges).not.toContain('Other Local Docker')

      // Explicit folder scan must reflect folder-scoped wording (not claim other local Docker containers)
      const folderInp = (mountedModal?.querySelectorAll('input') ?? []).find((i) =>
        i.placeholder.includes('folder path')
      )
      const scanFolderBtn = (mountedModal?.querySelectorAll('button') ?? []).find(
        (b) => b.textContent === 'Scan Folder'
      )
      if (folderInp) folderInp.value = 'D:\\custom\\only-folder'
      scanFolderBtn?.click()
      await new Promise((r) => setTimeout(r, 30))
      const hints = (mountedModal?.querySelectorAll('.datanoa-conn-hint') ?? []).map((h) => h.textContent)
      expect(hints.some((h) => h.includes('inside this folder only'))).toBe(true)
      expect(hints.some((h) => h.includes('Plus local Docker containers'))).toBe(false)
    })
  })

  describe('Phase 1 & #32 Hardening: R2#3-6, R4#3, #21 SQLite Rebuild, 12 Engines + 7 BYOD, MSSQL/Oracle Panel Migration', () => {
    it('R2#3: rejects unknown sslmode / ssl-mode values cleanly in parseConnectionUri', () => {
      const pgRes = connectionUriMod.parseConnectionUri(
        'postgres://alice:secret@pg.example.com:5432/app?sslmode=bogus_mode'
      )
      expect(pgRes.ok).toBe(false)
      expect(pgRes.error).toBe('Unsupported sslmode: bogus_mode')

      const myRes = connectionUriMod.parseConnectionUri(
        'mysql://bob:secret@my.example.com:3306/app?ssl-mode=invalid_val'
      )
      expect(myRes.ok).toBe(false)
      expect(myRes.error).toBe('Unsupported sslmode: invalid_val')

      const crdbRes = connectionUriMod.parseConnectionUri(
        'cockroachdb://root:secret@crdb.example.com:26257/app?sslmode=typo'
      )
      expect(crdbRes.ok).toBe(false)
      expect(crdbRes.error).toBe('Unsupported sslmode: typo')
    })

    it('R2#4: parses JSON ?ssl={"rejectUnauthorized":...} and ?tls={"rejectUnauthorized":...} in resolveTlsSettings & URIs', () => {
      expect(
        connectionUriMod.resolveTlsSettings(new URLSearchParams('ssl={"rejectUnauthorized":true}'), false)
      ).toEqual({
        ssl: true,
        sslMode: 'verify-full',
        sslRejectUnauthorized: true,
      })
      expect(
        connectionUriMod.resolveTlsSettings(new URLSearchParams('tls={"rejectUnauthorized":false}'), false)
      ).toEqual({
        ssl: true,
        sslMode: 'require',
        sslRejectUnauthorized: false,
      })

      const mysqlStrict = connectionUriMod.parseConnectionUri(
        'mysql://bob:secret@my.example.com:3306/app?ssl=%7B%22rejectUnauthorized%22%3Atrue%7D'
      )
      expect(mysqlStrict.ok).toBe(true)
      expect(mysqlStrict.profile?.ssl).toBe(true)
      expect(mysqlStrict.profile?.sslMode).toBe('verify-full')
      expect(mysqlStrict.profile?.sslRejectUnauthorized).toBe(true)

      const pgRelaxed = connectionUriMod.parseConnectionUri(
        'postgres://alice:secret@pg.example.com:5432/app?tls=%7B%22rejectUnauthorized%22%3Afalse%7D'
      )
      expect(pgRelaxed.ok).toBe(true)
      expect(pgRelaxed.profile?.ssl).toBe(true)
      expect(pgRelaxed.profile?.sslMode).toBe('require')
      expect(pgRelaxed.profile?.sslRejectUnauthorized).toBe(false)
    })

    it('R2#5: LibsqlSession scrubs userinfo, authToken, jwt, and #fragment from fetch rejection errors and HTTP error bodies', async () => {
      const prevFetch = globalThis.fetch
      try {
        const session = new LibsqlSession(
          {
            id: 'l_scrub',
            name: 'turso',
            driver: 'libsql',
            database: 'main',
            url: 'https://db.turso.io',
          },
          'TopSecretToken'
        )

        globalThis.fetch = vi.fn(async () => {
          throw new Error(
            'connect failed at https://alice:SuperSecretPw@db.turso.io/v2/pipeline?authToken=LeakTok&jwt=LeakJwt#LeakyFrag'
          )
        }) as unknown as typeof fetch

        let errMsg1 = ''
        try {
          await session.runQuery('q_scrub_1', 'SELECT 1')
        } catch (err) {
          errMsg1 = err instanceof Error ? err.message : String(err)
        }
        expect(errMsg1).toContain('[REDACTED]')
        expect(errMsg1).not.toContain('SuperSecretPw')
        expect(errMsg1).not.toContain('LeakTok')
        expect(errMsg1).not.toContain('LeakJwt')
        expect(errMsg1).not.toContain('LeakyFrag')

        globalThis.fetch = vi.fn(async () => ({
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
          text: async () =>
            'upstream error on libsql://bob:HiddenPass@db.turso.io?token=BadTok&jwt=BadJwt#BodyFrag',
        })) as unknown as typeof fetch

        let errMsg2 = ''
        try {
          await session.runQuery('q_scrub_2', 'SELECT 1')
        } catch (err) {
          errMsg2 = err instanceof Error ? err.message : String(err)
        }
        expect(errMsg2).toContain('[REDACTED]')
        expect(errMsg2).not.toContain('HiddenPass')
        expect(errMsg2).not.toContain('BadTok')
        expect(errMsg2).not.toContain('BadJwt')
        expect(errMsg2).not.toContain('BodyFrag')
      } finally {
        globalThis.fetch = prevFetch
      }
    })

    it('R2#6: Studio & Side Panel preserve raw .env URI behind masked #uriInput until manually edited', async () => {
      const env = installDom()
      cleanupDom = env.restore

      const rawEnvUri = 'postgres://admin:RealS3cr3t@localhost:5432/app?token=TokSecret'
      const parsedPayloads: string[] = []
      let mountedModal: InstanceType<typeof env.FakeEl> | null = null
      openStudioConnectionModal({
        isBackdropActive: () => true,
        mountModal: (el) => {
          mountedModal = el as unknown as InstanceType<typeof env.FakeEl>
          env.body.appendChild(mountedModal)
          return env.doc.createElement('div') as unknown as HTMLDivElement
        },
        closeModal: () => {},
        createElapsedTimer: () => () => {},
        updateStatus: () => {},
        activateSavedConnection: async () => {},
        requestPlugin: async (method: string, payload?: unknown) => {
          if (method === 'workspace.detectConnections') {
            return {
              scannedDirs: ['D:\\workspace\\app'],
              sqliteFiles: [],
              envConnections: [
                {
                  envKey: 'DATABASE_URL',
                  sourceFile: '.env',
                  driver: 'postgres',
                  name: 'app-db',
                  uri: rawEnvUri,
                },
              ],
              dockerComposeConnections: [],
            }
          }
          if (method === 'connection.parseUri') {
            const uri = (payload as { uri: string }).uri
            parsedPayloads.push(uri)
            return connectionUriMod.parseConnectionUri(uri)
          }
          if (method === 'connections.list') return []
          if (method === 'drivers.list') return { drivers: [] }
          if (method === 'workspace.listScopes') return { workspaces: [] }
          return {}
        },
        onSaved: async () => {},
        onDeleted: async () => {},
      })

      const buttons = mountedModal?.querySelectorAll('button') ?? []
      buttons.find((b) => b.textContent.includes('Auto-Detect'))?.click()
      await new Promise((r) => setTimeout(r, 30))

      const envChip = (mountedModal?.querySelectorAll('.datanoa-conn-chip') ?? []).find((c) =>
        c.textContent.includes('DATABASE_URL')
      )
      expect(envChip).toBeTruthy()
      envChip?.click()
      await new Promise((r) => setTimeout(r, 20))

      const uriInp = mountedModal?.querySelector('.datanoa-conn-uri-input')
      expect(uriInp?.value).toBe('postgres://admin:***@localhost:5432/app?token=***')
      expect(uriInp?.dataset.rawAutoUri).toBeUndefined()
      expect(parsedPayloads[0]).toBe(rawEnvUri)

      // Parse URI without editing should parse the real raw URI, not the masked display text
      const parseBtn = buttons.find((b) => b.textContent === 'Parse URI')
      parseBtn?.click()
      await new Promise((r) => setTimeout(r, 20))
      expect(parsedPayloads[1]).toBe(rawEnvUri)
      const pwInput = (mountedModal?.querySelectorAll('input') ?? []).find(
        (i) => i.type === 'password' && i.value === 'RealS3cr3t'
      )
      expect(pwInput).toBeTruthy()

      // Editing #uriInput manually clears rawAutoUri so user's typed URI wins
      if (uriInp) {
        uriInp.value = 'postgres://admin:ManualPw@localhost:5432/app'
        uriInp.dispatchEvent({ type: 'input' })
      }
      expect(uriInp?.dataset.rawAutoUri).toBeUndefined()
      parseBtn?.click()
      await new Promise((r) => setTimeout(r, 20))
      expect(parsedPayloads[2]).toBe('postgres://admin:ManualPw@localhost:5432/app')

      // Side Panel controller preserves rawAutoUri behind masked #uriInput too
      env.body.children.length = 0
      const panelDomIds = [
        ['uriInput', 'input'],
        ['parseUriBtn', 'button'],
        ['formName', 'input'],
        ['formFolder', 'input'],
        ['formWorkspaceScope', 'select'],
        ['formFilePath', 'input'],
        ['formLibsqlUrl', 'input'],
        ['formAuthToken', 'input'],
        ['formLibsqlDb', 'input'],
        ['formHost', 'input'],
        ['formPort', 'input'],
        ['formDatabase', 'input'],
        ['formUser', 'input'],
        ['formPassword', 'input'],
        ['formClickhouseUrl', 'input'],
        ['formOptions', 'input'],
        ['formRedisDb', 'select'],
        ['formSsl', 'input'],
        ['formReadOnly', 'input'],
        ['sqliteFields', 'div'],
        ['libsqlFields', 'div'],
        ['serverFields', 'div'],
        ['clickhouseUrlRow', 'div'],
        ['pgOptionsRow', 'div'],
        ['sqlDbRow', 'div'],
        ['redisDbRow', 'div'],
        ['connFormTitle', 'div'],
        ['saveFormBtn', 'button'],
        ['discoveredScopeHint', 'div'],
        ['discoveredBox', 'div'],
        ['discoveredSearchInput', 'input'],
        ['discoveredGroupsWrap', 'div'],
        ['discoveredEnvGroup', 'div'],
        ['discoveredEnvToggle', 'button'],
        ['discoveredEnvBody', 'div'],
        ['discoveredEnvCount', 'span'],
        ['discoveredEnvList', 'div'],
        ['discoveredDockerGroup', 'div'],
        ['discoveredDockerToggle', 'button'],
        ['discoveredDockerBody', 'div'],
        ['discoveredDockerCount', 'span'],
        ['discoveredDockerList', 'div'],
        ['discoveredFileGroup', 'div'],
        ['discoveredFileToggle', 'button'],
        ['discoveredFileBody', 'div'],
        ['discoveredCount', 'span'],
        ['discoveredList', 'div'],
      ] as const
      for (const [id, tag] of panelDomIds) {
        const el = env.doc.createElement(tag)
        el.id = id
        if (id === 'formSsl' || id === 'formReadOnly') el.type = 'checkbox'
        env.body.appendChild(el)
      }
      const panelParsedUris: string[] = []
      ;(globalThis as unknown as { window: Record<string, unknown> }).window.orca = {
        plugin: {
          request: async (method: string, payload?: unknown) => {
            if (method === 'workspace.detectConnections') {
              return {
                scannedDirs: ['D:\\workspace\\app'],
                sqliteFiles: [],
                envConnections: [
                  {
                    envKey: 'DATABASE_URL',
                    sourceFile: '.env',
                    driver: 'postgres',
                    name: 'panel-env',
                    uri: rawEnvUri,
                  },
                ],
                dockerComposeConnections: [],
              }
            }
            if (method === 'connection.parseUri') {
              const uri = (payload as { uri: string }).uri
              panelParsedUris.push(uri)
              return connectionUriMod.parseConnectionUri(uri)
            }
            return {}
          },
        },
      }
      const formCtrl = createPanelConnectionFormController({
        state: {
          formDriver: 'sqlite',
          formColorTag: 'none',
          editingId: null,
          connections: [],
          discoveredEnvs: [],
          discoveredDocker: [],
          discoveredFiles: [],
        },
        showBanner: () => {},
        showFormNotice: () => {},
        clearFormNotice: () => {},
        setFormOpen: () => {},
        updateViewportLayout: () => {},
        savePanelViewState: () => {},
      })
      await formCtrl.detectWorkspace()
      const panelEnvChip = env.doc.getElementById('discoveredEnvList')?.querySelector('.file-chip')
      expect(panelEnvChip).toBeTruthy()
      panelEnvChip?.click()
      await new Promise((r) => setTimeout(r, 20))
      const panelUriInp = env.doc.getElementById('uriInput')
      expect(panelUriInp?.value).toBe('postgres://admin:***@localhost:5432/app?token=***')
      expect(panelUriInp?.dataset.rawAutoUri).toBeUndefined()
      expect(panelParsedUris[0]).toBe(rawEnvUri)

      await formCtrl.handleParseUri()
      expect(panelParsedUris[1]).toBe(rawEnvUri)
      expect(env.doc.getElementById('formPassword')?.value).toBe('RealS3cr3t')

      // ensureUriParsedBeforeAction skips redundant re-parse when already parsed, and parses manual edit directly
      await formCtrl.ensureUriParsedBeforeAction()
      expect(panelParsedUris).toHaveLength(2)

      // Manual replacement in Side Panel without firing external input clears stale rawAutoUri on parse
      panelEnvChip?.click()
      await new Promise((r) => setTimeout(r, 20))
      if (panelUriInp) {
        panelUriInp.value = 'postgres://admin:EditedPass@localhost:5432/app'
      }
      await formCtrl.handleParseUri()
      expect(panelParsedUris[3]).toBe('postgres://admin:EditedPass@localhost:5432/app')
      expect(panelUriInp?.dataset.rawAutoUri).toBeUndefined()
    })

    it('R4#3: parseJsonPreservingBigInts handles UTF-8 BOM prefix safely without corrupting BigInt precision', () => {
      const parsed = parseJsonPreservingBigInts(
        '\uFEFF{"neg":-9223372036854775807,"pos":9007199254740993,"small":42}'
      ) as Record<string, unknown>
      expect(parsed.neg).toBe('-9223372036854775807')
      expect(parsed.pos).toBe('9007199254740993')
      expect(parsed.small).toBe(42)
    })

    it('12 built-in engines and 7 BYOD slots align across catalog, icons, worker dirs, and URI parsing', () => {
      const expectedBuiltins = [
        'sqlite',
        'postgres',
        'mysql',
        'mariadb',
        'cockroachdb',
        'clickhouse',
        'redis',
        'libsql',
        'd1',
        'mssql',
        'oracle',
        'mongodb',
      ]
      const expectedByod = [
        'duckdb',
        'snowflake',
        'bigquery',
        'cassandra',
        'elasticsearch',
        'neo4j',
        'custom',
      ]

      expect(BUILTIN_ENGINE_CATALOG.map((e) => e.id)).toEqual(expectedBuiltins)
      expect(STUDIO_ENGINES.map((e) => e.id)).toEqual(expectedBuiltins)
      expect(BYOD_ENGINES.map((e) => e.id)).toEqual(expectedByod)
      expect([...BYOD_DRIVER_IDS]).toEqual(expectedByod)
      expect(BYOD_DRIVER_SLOTS.map((s) => s.id)).toEqual(expectedByod)
      expect(getByodDefaultPort('duckdb')).toBe(0)
      expect(getByodDefaultPort('snowflake')).toBe(443)
      expect(getByodDefaultPort('bigquery')).toBe(443)
      expect(getByodDefaultPort('cassandra')).toBe(9042)
      expect(getByodDefaultPort('elasticsearch')).toBe(9200)
      expect(getByodDefaultPort('neo4j')).toBe(7687)
      expect(getByodDefaultPort('custom')).toBe(5432)

      expect(getByodNpmPackage('duckdb')).toBe('@duckdb/node-api')
      expect(getByodNpmPackage('snowflake')).toBe('snowflake-sdk')
      expect(getByodNpmPackage('bigquery')).toBe('@google-cloud/bigquery')
      expect(getByodNpmPackage('cassandra')).toBe('cassandra-driver')
      expect(getByodNpmPackage('elasticsearch')).toBe('@elastic/elasticsearch')
      expect(getByodNpmPackage('neo4j')).toBe('neo4j-driver')
      expect(getByodNpmPackage('custom')).toBe('')

      const dirs = getDefaultByodDriverDirs()
      expect(Object.keys(dirs.paths)).toEqual(expectedByod)

      const svgMap = buildPanelDbSvgMarkupMap()
      for (const id of expectedBuiltins) {
        expect(typeof svgMap[id]).toBe('string')
        if (id !== 'clickhouse') expect(typeof DB_LOGO_PATHS[id]).toBe('string')
      }
      for (const id of expectedByod) {
        expect(typeof svgMap[id]).toBe('string')
        expect(typeof BYOD_LOGO_PATHS[id]?.d).toBe('string')
      }
      expect(panelCore.ENGINES.filter((e) => e.id === 'mssql' || e.id === 'oracle' || e.id === 'mongodb')).toHaveLength(
        3
      )
      expect(expectedByod.every((id) => panelCore.ENGINES.some((e) => e.id === id))).toBe(true)

      for (const builtinId of expectedBuiltins) {
        expect(getDriver(builtinId).type).toBe(builtinId)
        expect(createDriver(builtinId)).toBe(getDriver(builtinId))
      }

      // Built-in mssql://, sqlserver://, oracle://, oracledb://, mongodb://, mongodb+srv:// parsing
      const mssqlUri = connectionUriMod.parseConnectionUri(
        'mssql://sa:Pass123@sql.example.com:1433/AppDb?encrypt=true&trustServerCertificate=false'
      )
      expect(mssqlUri.ok).toBe(true)
      expect(mssqlUri.profile?.driver).toBe('mssql')
      expect(mssqlUri.profile?.port).toBe(1433)
      expect(mssqlUri.profile?.database).toBe('AppDb')
      expect(mssqlUri.profile?.ssl).toBe(true)
      expect(mssqlUri.profile?.sslMode).toBe('verify-full')
      expect(mssqlUri.profile?.sslRejectUnauthorized).toBe(true)

      const sqlserverTrust = connectionUriMod.parseConnectionUri(
        'sqlserver://sa:Pass123@sql.example.com/AppDb?encrypt=true&trustServerCertificate=true'
      )
      expect(sqlserverTrust.ok).toBe(true)
      expect(sqlserverTrust.profile?.driver).toBe('mssql')
      expect(sqlserverTrust.profile?.ssl).toBe(true)
      expect(sqlserverTrust.profile?.sslMode).toBe('require')
      expect(sqlserverTrust.profile?.sslRejectUnauthorized).toBe(false)

      const oracleUri = connectionUriMod.parseConnectionUri('oracledb://system:OraPw@ora.example.com:1521/FREEPDB1')
      expect(oracleUri.ok).toBe(true)
      expect(oracleUri.profile?.driver).toBe('oracle')
      expect(oracleUri.profile?.port).toBe(1521)
      expect(oracleUri.profile?.database).toBe('FREEPDB1')

      const mongoSrvUri = connectionUriMod.parseConnectionUri(
        'mongodb+srv://appuser:MongoSecret@cluster0.example.mongodb.net/analytics?authSource=admin&token=LeakTok'
      )
      expect(mongoSrvUri.ok).toBe(true)
      expect(mongoSrvUri.profile?.driver).toBe('mongodb')
      expect(mongoSrvUri.profile?.url).toContain('mongodb+srv://')
      expect(mongoSrvUri.profile?.url).not.toContain('MongoSecret')
      expect(mongoSrvUri.profile?.url).not.toContain('LeakTok')
    })

    it('#21 Bugs 1-2: analyzeSqliteTriggerReferences precision and origin="c" composite UNIQUE partial-drop guard in panel-core.js', () => {
      // Composite CREATE UNIQUE INDEX (origin: 'c') must be blocked from silent narrowing when one column drops
      const compositeCRes = panelCore.validatePanelStructDraft(
        {
          originalTableName: 'memberships',
          tableName: 'memberships',
          columns: [
            {
              id: 'c1',
              originalName: 'org_id',
              name: 'org_id',
              originalDataType: 'INTEGER',
              dataType: 'INTEGER',
              originalNullable: false,
              nullable: false,
              originalIsPrimaryKey: true,
              isPrimaryKey: true,
              originalDefaultValue: '',
              defaultValue: '',
              status: 'existing',
            },
            {
              id: 'c2',
              originalName: 'user_id',
              name: 'user_id',
              originalDataType: 'INTEGER',
              dataType: 'INTEGER',
              originalNullable: false,
              nullable: false,
              originalIsPrimaryKey: false,
              isPrimaryKey: false,
              originalDefaultValue: '',
              defaultValue: '',
              status: 'deleted',
            },
            {
              id: 'c3',
              originalName: 'role',
              name: 'role',
              originalDataType: 'TEXT',
              dataType: 'TEXT',
              originalNullable: false,
              nullable: false,
              originalIsPrimaryKey: false,
              isPrimaryKey: false,
              originalDefaultValue: '',
              defaultValue: '',
              status: 'existing',
            },
          ],
          indexes: [
            {
              name: 'idx_memberships_user_role',
              unique: true,
              isPrimary: false,
              origin: 'c',
              columns: ['user_id', 'role'],
              status: 'existing',
            },
          ],
          foreignKeys: [],
        },
        'sqlite'
      )
      expect(compositeCRes.valid).toBe(false)
      expect(compositeCRes.errors.some((e) => e.includes('composite UNIQUE'))).toBe(true)

      // Trigger body with NEW.<origTable> field must NOT falsely block rebuild+rename; body table/header column ref MUST block
      const baseTriggerDraft = {
        originalTableName: 'account',
        tableName: 'accounts',
        columns: [
          {
            id: 'c1',
            originalName: 'id',
            name: 'id',
            originalDataType: 'INTEGER',
            dataType: 'INTEGER',
            originalNullable: false,
            nullable: false,
            originalIsPrimaryKey: true,
            isPrimaryKey: true,
            originalDefaultValue: '',
            defaultValue: '',
            status: 'existing',
          },
          {
            id: 'c2',
            originalName: 'account',
            name: 'account',
            originalDataType: 'TEXT',
            dataType: 'TEXT',
            originalNullable: false,
            nullable: false,
            originalIsPrimaryKey: false,
            isPrimaryKey: false,
            originalDefaultValue: '',
            defaultValue: "'n/a'",
            status: 'existing',
          },
        ],
        indexes: [],
        foreignKeys: [],
        triggers: [
          {
            name: 'trg_account_audit',
            sql: "CREATE TRIGGER trg_account_audit AFTER UPDATE ON account BEGIN INSERT INTO audit_log(val) VALUES (NEW.account); END",
          },
        ],
      }
      const nonBlockingRename = panelCore.validatePanelStructDraft(baseTriggerDraft, 'sqlite')
      expect(nonBlockingRename.valid).toBe(true)
      expect(nonBlockingRename.statements.join('\n')).toContain('ON "accounts"')

      const bodyRefDraft = {
        ...baseTriggerDraft,
        triggers: [
          {
            name: 'trg_account_self_ref',
            sql: 'CREATE TRIGGER trg_account_self_ref AFTER UPDATE ON account BEGIN UPDATE account SET account = NEW.account; END',
          },
        ],
      }
      const blockedSelfRef = panelCore.validatePanelStructDraft(bodyRefDraft, 'sqlite')
      expect(blockedSelfRef.valid).toBe(false)
      expect(blockedSelfRef.errors.some((e) => e.includes('references renamed table "account"'))).toBe(true)

      const updateOfDeletedDraft = {
        originalTableName: 'users',
        tableName: 'users',
        columns: [
          {
            id: 'c1',
            originalName: 'id',
            name: 'id',
            originalDataType: 'INTEGER',
            dataType: 'INTEGER',
            originalNullable: false,
            nullable: false,
            originalIsPrimaryKey: true,
            isPrimaryKey: true,
            originalDefaultValue: '',
            defaultValue: '',
            status: 'existing',
          },
          {
            id: 'c2',
            originalName: 'email',
            name: 'email',
            originalDataType: 'TEXT',
            dataType: 'TEXT',
            originalNullable: true,
            nullable: true,
            originalIsPrimaryKey: false,
            isPrimaryKey: false,
            originalDefaultValue: '',
            defaultValue: '',
            status: 'deleted',
          },
        ],
        indexes: [],
        foreignKeys: [],
        triggers: [
          {
            name: 'trg_users_email',
            sql: 'CREATE TRIGGER trg_users_email BEFORE UPDATE OF email ON users BEGIN SELECT 1; END',
          },
        ],
      }
      const blockedUpdateOf = panelCore.validatePanelStructDraft(updateOfDeletedDraft, 'sqlite')
      expect(blockedUpdateOf.valid).toBe(false)
      expect(blockedUpdateOf.errors.some((e) => e.includes('trg_users_email'))).toBe(true)
    })

    it('#32: Panel migration SQL generates valid MSSQL & Oracle DDL and cleanly blocks MongoDB', () => {
      const baseDraft = {
        originalTableName: 'users',
        tableName: 'accounts',
        schema: 'dbo',
        columns: [
          {
            id: 'c1',
            originalName: 'id',
            name: 'id',
            originalDataType: 'INT',
            dataType: 'INT',
            originalNullable: false,
            nullable: false,
            originalIsPrimaryKey: true,
            isPrimaryKey: true,
            originalDefaultValue: '',
            defaultValue: '',
            status: 'existing',
          },
          {
            id: 'c2',
            originalName: 'uname',
            name: 'username',
            originalDataType: 'VARCHAR(50)',
            dataType: 'VARCHAR(100)',
            originalNullable: true,
            nullable: false,
            originalIsPrimaryKey: false,
            isPrimaryKey: false,
            originalDefaultValue: '',
            defaultValue: 'guest',
            status: 'existing',
          },
          {
            id: 'c3',
            originalName: 'legacy',
            name: 'legacy',
            originalDataType: 'INT',
            dataType: 'INT',
            originalNullable: true,
            nullable: true,
            originalIsPrimaryKey: false,
            isPrimaryKey: false,
            originalDefaultValue: '',
            defaultValue: '',
            status: 'deleted',
          },
          {
            id: 'c4',
            originalName: '',
            name: 'bio',
            originalDataType: '',
            dataType: 'VARCHAR(255)',
            originalNullable: true,
            nullable: false,
            originalIsPrimaryKey: false,
            isPrimaryKey: false,
            originalDefaultValue: '',
            defaultValue: 'none',
            status: 'new',
          },
        ],
        indexes: [{ name: 'idx_legacy', unique: false, isPrimary: false, columns: ['legacy'], status: 'deleted' }],
        foreignKeys: [],
      }

      const mssqlRes = panelCore.validatePanelStructDraft(baseDraft, 'mssql')
      expect(mssqlRes.valid).toBe(true)
      expect(mssqlRes.statements).toContain('DROP INDEX [idx_legacy] ON [dbo].[users];')
      expect(mssqlRes.statements).toContain('ALTER TABLE [dbo].[users] DROP COLUMN [legacy];')
      expect(mssqlRes.statements).toContain("EXEC sp_rename '[dbo].[users].[uname]', 'username', 'COLUMN';")
      expect(mssqlRes.statements).toContain(
        'ALTER TABLE [dbo].[users] ALTER COLUMN [username] VARCHAR(100) NOT NULL;'
      )
      expect(mssqlRes.statements).toContain(
        "ALTER TABLE [dbo].[users] ADD DEFAULT 'guest' FOR [username];"
      )
      expect(mssqlRes.statements).toContain(
        "ALTER TABLE [dbo].[users] ADD [bio] VARCHAR(255) NOT NULL DEFAULT 'none';"
      )
      expect(mssqlRes.statements).toContain("EXEC sp_rename '[dbo].[users]', 'accounts';")

      const oracleDraft = { ...baseDraft, schema: 'APP' }
      const oracleRes = panelCore.validatePanelStructDraft(oracleDraft, 'oracle')
      expect(oracleRes.valid).toBe(true)
      expect(oracleRes.statements).toContain('DROP INDEX "APP"."idx_legacy";')
      expect(oracleRes.statements).toContain('ALTER TABLE "APP"."users" DROP COLUMN "legacy";')
      expect(oracleRes.statements).toContain('ALTER TABLE "APP"."users" RENAME COLUMN "uname" TO "username";')
      expect(oracleRes.statements).toContain(
        'ALTER TABLE "APP"."users" MODIFY ("username" VARCHAR(100) DEFAULT \'guest\' NOT NULL);'
      )
      expect(oracleRes.statements).toContain(
        'ALTER TABLE "APP"."users" ADD ("bio" VARCHAR(255) DEFAULT \'none\' NOT NULL);'
      )
      expect(oracleRes.statements).toContain('ALTER TABLE "APP"."users" RENAME TO "accounts";')

      const mongoRes = panelCore.validatePanelStructDraft(baseDraft, 'mongodb')
      expect(mongoRes.valid).toBe(false)
      expect(mongoRes.errors[0]).toContain('mongodb')
      expect(panelCore.buildPanelMigrationSql(baseDraft, 'mongodb')).toEqual([])
      expect(() =>
        panelCore.buildCreateTableSql('docs', [{ name: 'id', dataType: 'TEXT' }], 'mongodb')
      ).toThrow(/CREATE TABLE SQL is not supported on mongodb/)
    })
  })

  describe('#57 & #50 Bug 12 Fixes: ensureUriParsed, #fragment scrub, ADO.NET scrub, LibSQL applyChanges, MSSQL default drop, pure-rename trigger guard, Mongo URL, BYOD fields, Panel types/Mongo DDL & A11y', () => {
    it('#47 Bug 2 & #49 Bug 5: Studio ensureUriParsed resolves rawAutoUri on Docker/env chips before save, and malformed LibSQL URLs strip #token/#authToken', async () => {
      const env = installDom()
      cleanupDom = env.restore

      let savedPayload: { profile?: ConnectionProfile; password?: string } | null = null
      let mountedModal: InstanceType<typeof env.FakeEl> | null = null
      const dockerUri = 'postgres://docker_u:DockerS3cr3t@127.0.0.1:5439/appdb?token=DockTok'

      openStudioConnectionModal({
        isBackdropActive: () => true,
        mountModal: (el) => {
          mountedModal = el as unknown as InstanceType<typeof env.FakeEl>
          env.body.appendChild(mountedModal)
          return env.doc.createElement('div') as unknown as HTMLDivElement
        },
        closeModal: () => {},
        createElapsedTimer: () => () => {},
        updateStatus: () => {},
        activateSavedConnection: async () => {},
        requestPlugin: async (method: string, payload?: unknown) => {
          if (method === 'workspace.detectConnections') {
            return {
              scannedDirs: ['D:\\workspace\\app'],
              sqliteFiles: [],
              envConnections: [],
              dockerComposeConnections: [
                {
                  id: 'dc_1',
                  project: 'proj',
                  service: 'postgres',
                  driver: 'postgres',
                  name: 'proj-pg',
                  host: '127.0.0.1',
                  port: 5439,
                  database: 'appdb',
                  user: 'docker_u',
                  url: dockerUri,
                  sourceKind: 'live',
                  sourceFile: 'docker ps',
                  status: 'running',
                  workspaceMatched: true,
                },
              ],
            }
          }
          if (method === 'connection.parseUri') {
            return connectionUriMod.parseConnectionUri((payload as { uri: string }).uri)
          }
          if (method === 'connection.test') return { ok: true }
          if (method === 'connection.save') {
            savedPayload = payload as { profile?: ConnectionProfile; password?: string }
            return { ok: true, id: 'conn_dc_1' }
          }
          if (method === 'connections.list') return []
          if (method === 'drivers.list') return { drivers: [] }
          if (method === 'workspace.listScopes') return { workspaces: [] }
          return {}
        },
        onSaved: async () => {},
        onDeleted: async () => {},
      })

      const buttons = mountedModal?.querySelectorAll('button') ?? []
      buttons.find((b) => b.textContent.includes('Auto-Detect'))?.click()
      await new Promise((r) => setTimeout(r, 30))

      const dockerChip = (mountedModal?.querySelectorAll('.datanoa-conn-chip') ?? []).find((c) =>
        c.textContent.includes('proj-pg')
      )
      expect(dockerChip).toBeTruthy()
      dockerChip?.click()
      const uriInp = mountedModal?.querySelector('.datanoa-conn-uri-input')
      expect(uriInp?.value).toBe('postgres://docker_u:***@127.0.0.1:5439/appdb?token=***')
      expect(uriInp?.dataset.rawAutoUri).toBeUndefined()

      // Save immediately after clicking Docker chip: ensureUriParsed() must use rawAutoUri, NEVER '***'
      buttons.find((b) => b.textContent === 'Save & Connect')?.click()
      await new Promise((r) => setTimeout(r, 40))
      expect(savedPayload?.password).toBe('DockerS3cr3t')
      expect(savedPayload?.password).not.toBe('***')

      // #49 Bug 5: malformed LibSQL URL with #token=... & #authToken=... stripped in Studio & Side Panel
      const libsqlTile = mountedModal?.querySelector('.datanoa-engine-tile[data-driver="libsql"]')
      libsqlTile?.click()
      const libsqlInputs = mountedModal?.querySelectorAll('input') ?? []
      const libsqlUrlField = libsqlInputs.find((i) => i.placeholder.includes('libsql://your-db.turso.io'))
      if (libsqlUrlField) {
        libsqlUrlField.value = 'not a valid url://host/db#token=FragSec&authToken=FragAuth'
      }
      if (uriInp) uriInp.value = ''
      savedPayload = null
      buttons.find((b) => b.textContent === 'Save & Connect')?.click()
      await new Promise((r) => setTimeout(r, 30))
      expect(savedPayload?.profile?.url).not.toContain('FragSec')
      expect(savedPayload?.profile?.url).not.toContain('FragAuth')

      // Side Panel #49 Bug 5 fallback regex
      env.body.children.length = 0
      for (const [id, tag] of [
        ['uriInput', 'input'],
        ['formName', 'input'],
        ['formFolder', 'input'],
        ['formWorkspaceScope', 'select'],
        ['formLibsqlUrl', 'input'],
        ['formAuthToken', 'input'],
        ['formLibsqlDb', 'input'],
        ['formReadOnly', 'input'],
      ] as const) {
        const el = env.doc.createElement(tag)
        el.id = id
        if (id === 'formReadOnly') el.type = 'checkbox'
        env.body.appendChild(el)
      }
      const pLibsql = env.doc.getElementById('formLibsqlUrl')
      if (pLibsql) pLibsql.value = 'not a valid url://host/db#token=PanelFrag&jwt=PanelJwt'
      const formCtrl = createPanelConnectionFormController({
        state: { formDriver: 'libsql', formColorTag: 'none', editingId: null },
        showBanner: () => {},
        showFormNotice: () => {},
        clearFormNotice: () => {},
        setFormOpen: () => {},
        updateViewportLayout: () => {},
        savePanelViewState: () => {},
      })
      const panelSub = formCtrl.buildFormSubmission('conn_frag')
      expect(panelSub.profile.url).not.toContain('PanelFrag')
      expect(panelSub.profile.url).not.toContain('PanelJwt')
    })

    it('#49 Bug 2: worker-utils scrubs ADO.NET Password=/Pwd= and URL #fragment secrets from profiles and text', () => {
      const sanitized = sanitizeConnectionProfile({
        id: 'ms_ado',
        name: 'Server=sql.local;User Id=sa;Password=NameSecret!;Pwd=NamePwd!',
        driver: 'mssql',
        database: 'app',
        url: 'Server=sql.local,1433;Database=app;User Id=sa;Password=AdoSecret123;Pwd="Quoted;Pwd";Encrypt=true',
        ssl: true,
        readOnly: false,
      })
      expect(sanitized.url).not.toContain('AdoSecret123')
      expect(sanitized.url).not.toContain('Quoted;Pwd')
      expect(sanitized.url).toContain('Server=sql.local,1433')
      expect(sanitized.name).not.toContain('NameSecret!')
      expect(sanitized.name).not.toContain('NamePwd!')

      const scrubbed = scrubCredentialsInText(
        "ADO fail Server=db;Pwd='SingleSec';Password=PlainSec; https://h/db#FragSec"
      )
      expect(scrubbed).not.toContain('SingleSec')
      expect(scrubbed).not.toContain('PlainSec')
      expect(scrubbed).not.toContain('FragSec')
      expect(scrubbed).toContain('[REDACTED]')
    })

    it('#51 Bug 3: LibsqlSession.applyChanges scrubs Hrana BEGIN/DML/COMMIT error credentials & translates FK sentinel', async () => {
      const prevFetch = globalThis.fetch
      try {
        const session = new LibsqlSession(
          {
            id: 'l_apply',
            name: 'turso',
            driver: 'libsql',
            database: 'main',
            url: 'https://db.turso.io',
          },
          'SecretTok'
        )
        const changes = {
          table: 'users',
          inserts: [{ id: 1, name: 'alice' }],
          updates: [],
          deletes: [],
        }

        // 1. BEGIN error scrubs URL creds + #fragment
        globalThis.fetch = vi.fn(async () =>
          new Response(
            JSON.stringify({
              baton: null,
              base_url: null,
              results: [
                {
                  type: 'error',
                  error: {
                    message:
                      'begin failed on https://u:BeginPw@db.turso.io?authToken=BeginTok#BeginFrag',
                    code: 'SQLITE_BUSY',
                  },
                },
              ],
            }),
            { status: 200 }
          )
        ) as unknown as typeof fetch

        await expect(session.applyChanges(changes)).rejects.toThrow(/\[REDACTED\]/)
        try {
          await session.applyChanges(changes)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          expect(msg).not.toContain('BeginPw')
          expect(msg).not.toContain('BeginTok')
          expect(msg).not.toContain('BeginFrag')
        }

        // 2. DML error scrubs creds + translates __datanoa_fk_violation__
        let callNum = 0
        globalThis.fetch = vi.fn(async () => {
          callNum++
          if (callNum === 1) {
            return new Response(
              JSON.stringify({
                baton: 'b1',
                base_url: null,
                results: [
                  { type: 'ok', response: { type: 'execute', result: { cols: [], rows: [] } } },
                  {
                    type: 'error',
                    error: {
                      message:
                        'dml failed at https://u:DmlPw@db.turso.io?jwt=DmlJwt#DmlFrag',
                      code: 'SQLITE_CONSTRAINT',
                    },
                  },
                ],
              }),
              { status: 200 }
            )
          }
          return new Response(
            JSON.stringify({ baton: null, base_url: null, results: [] }),
            { status: 200 }
          )
        }) as unknown as typeof fetch

        try {
          await session.applyChanges(changes)
          expect.unreachable('should reject')
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          expect(msg).not.toContain('DmlPw')
          expect(msg).not.toContain('DmlJwt')
          expect(msg).not.toContain('DmlFrag')
          expect(msg).toContain('[REDACTED]')
        }

        // 3. COMMIT error scrubs creds & translates FK sentinel
        let round = 0
        globalThis.fetch = vi.fn(async () => {
          round++
          if (round === 1) {
            return new Response(
              JSON.stringify({
                baton: 'b2',
                base_url: null,
                results: [
                  { type: 'ok', response: { type: 'execute', result: { cols: [], rows: [] } } },
                  {
                    type: 'ok',
                    response: {
                      type: 'execute',
                      result: { affected_row_count: 1, cols: [], rows: [] },
                    },
                  },
                ],
              }),
              { status: 200 }
            )
          }
          return new Response(
            JSON.stringify({
              baton: null,
              base_url: null,
              results: [
                {
                  type: 'error',
                  error: {
                    message:
                      'commit failed __datanoa_fk_violation__ https://u:CommitPw@db.turso.io?token=CommitTok#CommitFrag',
                  },
                },
              ],
            }),
            { status: 200 }
          )
        }) as unknown as typeof fetch

        await expect(session.applyChanges(changes)).rejects.toThrow(
          'FOREIGN KEY constraint failed'
        )
      } finally {
        globalThis.fetch = prevFetch
      }
    })

    it('#50 Bug 9 & #51 Bug 1: panel-core emits MSSQL DROP CONSTRAINT when clearing defaults and blocks pure SQLite table rename with surviving trigger', () => {
      // #50 Bug 9: clearing existing MSSQL default with unchanged type/nullability emits non-empty DROP CONSTRAINT DDL
      const mssqlClearDefaultDraft = {
        originalTableName: 'users',
        tableName: 'users',
        schema: 'dbo',
        columns: [
          {
            id: 'c1',
            originalName: 'id',
            name: 'id',
            originalDataType: 'INT',
            dataType: 'INT',
            originalNullable: false,
            nullable: false,
            originalIsPrimaryKey: true,
            isPrimaryKey: true,
            originalDefaultValue: '',
            defaultValue: '',
            status: 'existing',
          },
          {
            id: 'c2',
            originalName: 'role',
            name: 'role',
            originalDataType: 'VARCHAR(50)',
            dataType: 'VARCHAR(50)',
            originalNullable: false,
            nullable: false,
            originalIsPrimaryKey: false,
            isPrimaryKey: false,
            originalDefaultValue: "'guest'",
            defaultValue: '',
            status: 'existing',
          },
          {
            id: 'c3',
            originalName: 'tier',
            name: 'tier',
            originalDataType: 'INT',
            dataType: 'INT',
            originalNullable: false,
            nullable: false,
            originalIsPrimaryKey: false,
            isPrimaryKey: false,
            originalDefaultValue: '1',
            defaultValue: '',
            status: 'existing',
          },
        ],
        indexes: [],
        foreignKeys: [],
      }
      const clearPlan = panelCore.validatePanelStructDraft(mssqlClearDefaultDraft, 'mssql')
      expect(clearPlan.valid).toBe(true)
      expect(clearPlan.statements.length).toBeGreaterThanOrEqual(2)
      const clearSql = clearPlan.statements.join('\n')
      expect(clearSql).toContain('DROP CONSTRAINT')
      expect(clearSql).toContain('sys.default_constraints')
      // Clearing two defaults in one batch must use distinct T-SQL variable names
      expect(clearSql).toContain('@df_1')
      expect(clearSql).toContain('@df_2')

      // Replacing an existing default drops old constraint BEFORE adding new default
      const mssqlReplaceDraft = {
        ...mssqlClearDefaultDraft,
        columns: [
          mssqlClearDefaultDraft.columns[0],
          { ...mssqlClearDefaultDraft.columns[1], defaultValue: "'member'" },
        ],
      }
      const replaceStmts = panelCore.buildPanelMigrationSql(mssqlReplaceDraft, 'mssql')
      const dropIdx = replaceStmts.findIndex((s) => s.includes('DROP CONSTRAINT'))
      const addIdx = replaceStmts.findIndex((s) => s.includes("ADD DEFAULT 'member' FOR [role]"))
      expect(dropIdx).toBeGreaterThanOrEqual(0)
      expect(addIdx).toBeGreaterThan(dropIdx)

      // #51 Bug 1: pure SQLite table rename without rebuild MUST block when trigger exists
      const pureRenameTriggerDraft = {
        originalTableName: 'accounts',
        tableName: 'accounts_v2',
        schema: 'main',
        columns: [
          {
            id: 'c1',
            originalName: 'id',
            name: 'id',
            originalDataType: 'INTEGER',
            dataType: 'INTEGER',
            originalNullable: false,
            nullable: false,
            originalIsPrimaryKey: true,
            isPrimaryKey: true,
            originalDefaultValue: '',
            defaultValue: '',
            status: 'existing',
          },
        ],
        indexes: [],
        foreignKeys: [],
        triggers: [
          {
            name: 'trg_accounts_audit',
            sql: 'CREATE TRIGGER trg_accounts_audit AFTER INSERT ON accounts BEGIN INSERT INTO log VALUES (NEW.id); END',
          },
        ],
      }
      expect(panelCore.requiresPanelSqliteRebuild(pureRenameTriggerDraft)).toBe(false)
      const pureRenamePlan = panelCore.validatePanelStructDraft(pureRenameTriggerDraft, 'sqlite')
      expect(pureRenamePlan.valid).toBe(false)
      expect(pureRenamePlan.errors.some((e) => /trigger/i.test(e))).toBe(true)
    })

    it('#53 Bugs 6-7, #52 Bug 1, #50 Bug 12: preserves scrubbed url for mongodb://, mongodb+srv://, and oracle:// query params across URI & UI', async () => {
      // #53 Bug 6: mongodb:// preserves scrubbed url & authSource/replicaSet
      const mongoTcp = connectionUriMod.parseConnectionUri(
        'mongodb://appuser:Pass123@db1.local:27017/orders?authSource=admin&replicaSet=rs0&token=SecretTok'
      )
      expect(mongoTcp.ok).toBe(true)
      expect(mongoTcp.profile?.url).toBe('mongodb://db1.local:27017/orders?authSource=admin&replicaSet=rs0')
      expect(mongoTcp.profile?.url).not.toContain('Pass123')
      expect(mongoTcp.profile?.url).not.toContain('SecretTok')

      // #50 Bug 12: oracle:// preserves scrubbed url with schema/sid/serviceName
      const oracleQuery = connectionUriMod.parseConnectionUri(
        'oracle://scott:OraPw@ora.local:1521/ORCLPDB1?schema=SALES&serviceName=SALESVC&sid=ORCL&password=Leak'
      )
      expect(oracleQuery.ok).toBe(true)
      expect(oracleQuery.profile?.url).toBe(
        'oracle://ora.local:1521/ORCLPDB1?schema=SALES&serviceName=SALESVC&sid=ORCL'
      )
      expect(oracleQuery.profile?.url).not.toContain('OraPw')
      expect(oracleQuery.profile?.url).not.toContain('Leak')

      // #52 Bug 1 & #53 Bug 7: Studio & Side Panel preserve profile.url on mongodb:// and mongodb+srv:// parse/edit/save
      const env = installDom()
      cleanupDom = env.restore

      let studioSaved: { profile?: ConnectionProfile } | null = null
      let mountedModal: InstanceType<typeof env.FakeEl> | null = null
      openStudioConnectionModal({
        isBackdropActive: () => true,
        mountModal: (el) => {
          mountedModal = el as unknown as InstanceType<typeof env.FakeEl>
          env.body.appendChild(mountedModal)
          return env.doc.createElement('div') as unknown as HTMLDivElement
        },
        closeModal: () => {},
        createElapsedTimer: () => () => {},
        updateStatus: () => {},
        activateSavedConnection: async () => {},
        requestPlugin: async (method: string, payload?: unknown) => {
          if (method === 'connection.parseUri') {
            return connectionUriMod.parseConnectionUri((payload as { uri: string }).uri)
          }
          if (method === 'connection.test') return { ok: true }
          if (method === 'connection.save') {
            studioSaved = payload as { profile?: ConnectionProfile }
            return { ok: true, id: 'conn_mongo_1' }
          }
          if (method === 'connections.list') return []
          if (method === 'drivers.list') return { drivers: [] }
          if (method === 'workspace.listScopes') return { workspaces: [] }
          return {}
        },
        onSaved: async () => {},
        onDeleted: async () => {},
      })

      const uriInp = mountedModal?.querySelector('.datanoa-conn-uri-input')
      if (uriInp) {
        uriInp.value =
          'mongodb+srv://atlas:MongoPw@cluster0.example.mongodb.net/prod?retryWrites=true&authSource=admin'
      }
      const buttons = mountedModal?.querySelectorAll('button') ?? []
      buttons.find((b) => b.textContent === 'Parse URI')?.click()
      await new Promise((r) => setTimeout(r, 25))
      buttons.find((b) => b.textContent === 'Save & Connect')?.click()
      await new Promise((r) => setTimeout(r, 25))
      expect(studioSaved?.profile?.driver).toBe('mongodb')
      expect(studioSaved?.profile?.url).toBe(
        'mongodb+srv://cluster0.example.mongodb.net/prod?retryWrites=true&authSource=admin'
      )

      // Side Panel MongoDB URI parse & edit preserves profile.url
      env.body.children.length = 0
      for (const [id, tag] of [
        ['uriInput', 'input'],
        ['parseUriBtn', 'button'],
        ['formName', 'input'],
        ['formFolder', 'input'],
        ['formWorkspaceScope', 'select'],
        ['formFilePath', 'input'],
        ['formLibsqlUrl', 'input'],
        ['formAuthToken', 'input'],
        ['formLibsqlDb', 'input'],
        ['formHost', 'input'],
        ['formPort', 'input'],
        ['formDatabase', 'input'],
        ['formUser', 'input'],
        ['formPassword', 'input'],
        ['formClickhouseUrl', 'input'],
        ['formOptions', 'input'],
        ['formRedisDb', 'select'],
        ['formSsl', 'input'],
        ['formReadOnly', 'input'],
        ['sqliteFields', 'div'],
        ['libsqlFields', 'div'],
        ['serverFields', 'div'],
        ['clickhouseUrlRow', 'div'],
        ['pgOptionsRow', 'div'],
        ['sqlDbRow', 'div'],
        ['redisDbRow', 'div'],
        ['connFormTitle', 'div'],
        ['saveFormBtn', 'button'],
      ] as const) {
        const el = env.doc.createElement(tag)
        el.id = id
        if (id === 'formSsl' || id === 'formReadOnly') el.type = 'checkbox'
        env.body.appendChild(el)
      }
      ;(globalThis as unknown as { window: Record<string, unknown> }).window.orca = {
        plugin: {
          request: async (method: string, payload?: unknown) => {
            if (method === 'connection.parseUri') {
              return connectionUriMod.parseConnectionUri((payload as { uri: string }).uri)
            }
            return {}
          },
        },
      }
      const panelState: Record<string, unknown> = {
        formDriver: 'sqlite',
        formColorTag: 'none',
        editingId: null,
        connections: [],
      }
      const formCtrl = createPanelConnectionFormController({
        state: panelState,
        showBanner: () => {},
        showFormNotice: () => {},
        clearFormNotice: () => {},
        setFormOpen: () => {},
        updateViewportLayout: () => {},
        savePanelViewState: () => {},
      })
      await formCtrl.handleParseUri(
        'mongodb://app:MongoPass@db1.local:27017/shop?authSource=admin&replicaSet=rs0'
      )
      const panelSub = formCtrl.buildFormSubmission('conn_mongo_panel')
      expect(panelSub.profile.driver).toBe('mongodb')
      expect(panelSub.profile.url).toBe('mongodb://db1.local:27017/shop?authSource=admin&replicaSet=rs0')

      // Repopulate edit profile for mongodb+srv preserves url
      formCtrl.populateFormFromProfile(
        {
          id: 'conn_srv_edit',
          name: 'Atlas',
          driver: 'mongodb',
          host: 'cluster0.example.mongodb.net',
          port: 27017,
          database: 'prod',
          url: 'mongodb+srv://cluster0.example.mongodb.net/prod?retryWrites=true',
          ssl: true,
          readOnly: false,
        },
        'edit'
      )
      expect(env.doc.getElementById('formClickhouseUrl')?.value).toBe(
        'mongodb+srv://cluster0.example.mongodb.net/prod?retryWrites=true'
      )
      const editedSub = formCtrl.buildFormSubmission('conn_srv_edit')
      expect(editedSub.profile.url).toBe(
        'mongodb+srv://cluster0.example.mongodb.net/prod?retryWrites=true'
      )
    })

    it('#52 Bug 3 & #53 Bug 12: Studio & Side Panel show filePath for duckdb (hiding server/SSL/SSH) and options for snowflake/bigquery/cassandra', async () => {
      const env = installDom()
      cleanupDom = env.restore

      let studioSaved: { profile?: ConnectionProfile } | null = null
      let mountedModal: InstanceType<typeof env.FakeEl> | null = null
      openStudioConnectionModal({
        isBackdropActive: () => true,
        mountModal: (el) => {
          mountedModal = el as unknown as InstanceType<typeof env.FakeEl>
          env.body.appendChild(mountedModal)
          return env.doc.createElement('div') as unknown as HTMLDivElement
        },
        closeModal: () => {},
        createElapsedTimer: () => () => {},
        updateStatus: () => {},
        activateSavedConnection: async () => {},
        requestPlugin: async (method: string, payload?: unknown) => {
          if (method === 'connection.test') return { ok: true }
          if (method === 'connection.save') {
            studioSaved = payload as { profile?: ConnectionProfile }
            return { ok: true, id: 'byod_1' }
          }
          if (method === 'connections.list') return []
          if (method === 'drivers.list') return { drivers: [] }
          if (method === 'workspace.listScopes') return { workspaces: [] }
          return {}
        },
        onSaved: async () => {},
        onDeleted: async () => {},
      })

      const buttons = mountedModal?.querySelectorAll('button') ?? []
      // Select DuckDB tile in Studio
      const duckdbTile = mountedModal?.querySelector('.datanoa-engine-tile[data-driver="duckdb"]')
      expect(duckdbTile).toBeTruthy()
      duckdbTile?.click()

      const inputs = mountedModal?.querySelectorAll('input') ?? []
      const fileInp = inputs.find((i) => i.placeholder.includes('analytics.duckdb'))
      expect(fileInp).toBeTruthy()
      const fileRow = fileInp?.closest('.datanoa-conn-field')
      expect(fileRow?.style.display).not.toBe('none')
      const hostInp = inputs.find((i) => i.placeholder.includes('localhost'))
      expect(hostInp?.closest('.datanoa-conn-field')?.style.display).toBe('none')
      if (fileInp) fileInp.value = 'D:\\data\\metrics.duckdb'
      buttons.find((b) => b.textContent === 'Save & Connect')?.click()
      await new Promise((r) => setTimeout(r, 30))
      expect(studioSaved?.profile?.driver).toBe('duckdb')
      expect(studioSaved?.profile?.filePath).toBe('D:\\data\\metrics.duckdb')

      // Select Snowflake tile in Studio -> Options field visible and persisted
      const snowflakeTile = mountedModal?.querySelector('.datanoa-engine-tile[data-driver="snowflake"]')
      snowflakeTile?.click()
      const optInp = (mountedModal?.querySelectorAll('input') ?? []).find((i) =>
        i.placeholder.includes('--cluster') || i.placeholder.includes('account=')
      )
      expect(optInp?.closest('.datanoa-conn-field')?.style.display).not.toBe('none')
      if (optInp) optInp.value = 'account=acme,warehouse=compute_wh'
      studioSaved = null
      buttons.find((b) => b.textContent === 'Save & Connect')?.click()
      await new Promise((r) => setTimeout(r, 30))
      expect(studioSaved?.profile?.driver).toBe('snowflake')
      expect(studioSaved?.profile?.options).toBe('account=acme,warehouse=compute_wh')

      // Side Panel DuckDB + Snowflake/BigQuery/Cassandra fields
      env.body.children.length = 0
      for (const [id, tag] of [
        ['uriInput', 'input'],
        ['engineGrid', 'div'],
        ['formName', 'input'],
        ['formFolder', 'input'],
        ['formWorkspaceScope', 'select'],
        ['formFilePath', 'input'],
        ['formLibsqlUrl', 'input'],
        ['formAuthToken', 'input'],
        ['formLibsqlDb', 'input'],
        ['formHost', 'input'],
        ['formPort', 'input'],
        ['formDatabase', 'input'],
        ['formUser', 'input'],
        ['formPassword', 'input'],
        ['formClickhouseUrl', 'input'],
        ['formOptions', 'input'],
        ['formRedisDb', 'select'],
        ['formSsl', 'input'],
        ['formReadOnly', 'input'],
        ['sqliteFields', 'div'],
        ['libsqlFields', 'div'],
        ['serverFields', 'div'],
        ['clickhouseUrlRow', 'div'],
        ['pgOptionsRow', 'div'],
        ['sqlDbRow', 'div'],
        ['redisDbRow', 'div'],
        ['quickBrowseDbFileBtn', 'button'],
        ['connFormTitle', 'div'],
        ['saveFormBtn', 'button'],
      ] as const) {
        const el = env.doc.createElement(tag)
        el.id = id
        if (id === 'formSsl' || id === 'formReadOnly') el.type = 'checkbox'
        env.body.appendChild(el)
      }
      const formCtrl = createPanelConnectionFormController({
        state: { formDriver: 'sqlite', formColorTag: 'none', editingId: null, connections: [] },
        showBanner: () => {},
        showFormNotice: () => {},
        clearFormNotice: () => {},
        setFormOpen: () => {},
        updateViewportLayout: () => {},
        savePanelViewState: () => {},
      })

      formCtrl.setFormDriver('duckdb', true)
      expect(env.doc.getElementById('sqliteFields')?.hidden).toBe(false)
      expect(env.doc.getElementById('serverFields')?.hidden).toBe(true)
      const fPathEl = env.doc.getElementById('formFilePath')
      if (fPathEl) fPathEl.value = 'D:\\analytics\\warehouse.duckdb'
      const duckSub = formCtrl.buildFormSubmission('conn_duck')
      expect(duckSub.profile.driver).toBe('duckdb')
      expect(duckSub.profile.filePath).toBe('D:\\analytics\\warehouse.duckdb')

      for (const optDriver of ['snowflake', 'bigquery', 'cassandra']) {
        formCtrl.setFormDriver(optDriver, true)
        expect(env.doc.getElementById('pgOptionsRow')?.hidden).toBe(false)
        const optEl = env.doc.getElementById('formOptions')
        if (optEl) optEl.value = `env=${optDriver}`
        const sub = formCtrl.buildFormSubmission(`conn_${optDriver}`)
        expect(sub.profile.options).toBe(`env=${optDriver}`)
      }
    })

    it('#52 Bug 2, #52 Bug 4, and #53 Bugs 8 & 10: panel.css CockroachDB var, panel.html/connection-modal a11y labels, PANEL_TYPE_SUGGESTIONS, D1 ENGINES & Mongo collection commands', () => {
      const repoRoot = path.resolve(__dirname, '..')
      const cssText = fs.readFileSync(path.join(repoRoot, 'src/panel/panel.css'), 'utf8')
      expect(cssText).toContain('--db-cockroachdb: #8b5cf6;')
      expect(cssText).toContain('--db-cockroachdb: #6933ff;')
      expect(cssText).toContain('var(--db-cockroachdb)')

      const htmlText = fs.readFileSync(path.join(repoRoot, 'src/panel/panel.html'), 'utf8')
      for (const controlId of [
        'uriInput',
        'panelByodFolderInput',
        'panelByodCmdInput',
        'discoveredSearchInput',
        'formFolder',
        'formFilePath',
        'schemaFilter',
        'valueInspectorText',
        'historySearchInput',
        'dataColsSearchInput',
        'cmdPaletteInput',
      ]) {
        const tagMatch = new RegExp(`<(?:input|textarea)\\b[^>]*\\bid="${controlId}"[^>]*>`, 'i').exec(htmlText)
        expect(tagMatch, `missing element #${controlId}`).toBeTruthy()
        expect(tagMatch?.[0], `#${controlId} missing aria-label`).toMatch(/\baria-label="[^"]+"/i)
      }

      // Studio connection-modal labels must NOT point `for` to <div> wrappers, and uriInp / discoverySearchInp must have aria-label
      const env = installDom()
      cleanupDom = env.restore
      let mountedModal: InstanceType<typeof env.FakeEl> | null = null
      openStudioConnectionModal({
        isBackdropActive: () => true,
        mountModal: (el) => {
          mountedModal = el as unknown as InstanceType<typeof env.FakeEl>
          env.body.appendChild(mountedModal)
          return env.doc.createElement('div') as unknown as HTMLDivElement
        },
        closeModal: () => {},
        createElapsedTimer: () => () => {},
        updateStatus: () => {},
        activateSavedConnection: async () => {},
        requestPlugin: async (method: string) => {
          if (method === 'connections.list') return []
          if (method === 'drivers.list') return { drivers: [] }
          if (method === 'workspace.listScopes') return { workspaces: [] }
          return {}
        },
        onSaved: async () => {},
        onDeleted: async () => {},
      })
      const uriInp = mountedModal?.querySelector('.datanoa-conn-uri-input')
      expect(uriInp?.getAttribute('aria-label')).toBeTruthy()
      const searchInp = mountedModal?.querySelector('.datanoa-discovery-search')
      expect(searchInp?.getAttribute('aria-label')).toBeTruthy()
      for (const lbl of mountedModal?.querySelectorAll('label') ?? []) {
        const forId = lbl.getAttribute('for')
        if (forId) {
          const target = env.doc.getElementById(forId)
          expect(['INPUT', 'SELECT', 'TEXTAREA']).toContain(target?.tagName)
        }
      }

      // #53 Bugs 8 & 10: panel-core type suggestions & engine lookup & MongoDB collection commands
      expect(Array.isArray(panelCore.PANEL_TYPE_SUGGESTIONS_BY_DRIVER.d1)).toBe(true)
      expect(Array.isArray(panelCore.PANEL_TYPE_SUGGESTIONS_BY_DRIVER.mssql)).toBe(true)
      expect(Array.isArray(panelCore.PANEL_TYPE_SUGGESTIONS_BY_DRIVER.oracle)).toBe(true)
      expect(panelCore.ENGINE_BY_ID.d1?.label).toBe('Cloudflare D1')

      expect(panelCore.buildCreateObjectCommand('audit_events', [], 'mongodb')).toBe(
        'db.createCollection("audit_events");'
      )
      expect(
        panelCore.buildTruncateOrDropSql('truncate', { name: 'audit_events', kind: 'table' }, 'mongodb')
      ).toBe('db.getCollection("audit_events").deleteMany({});')
      expect(
        panelCore.buildTruncateOrDropSql('drop', { name: 'audit_events', kind: 'table' }, 'mongodb')
      ).toBe('db.getCollection("audit_events").drop();')
    })
  })

  describe('#78 Wave 2 Fixes: #69 Bugs 1-3 & #73 Bugs 5-6', () => {
    it('#69 Bugs 1-2: preserves authSource/authMechanism, scrubs #fragment secret pairs cleanly, and preserves delimiter on malformed fallback URLs', async () => {
      const env = installDom()
      cleanupDom = env.restore

      let studioSaved: { profile?: ConnectionProfile } | null = null
      let mountedModal: InstanceType<typeof env.FakeEl> | null = null
      openStudioConnectionModal({
        isBackdropActive: () => true,
        mountModal: (el) => {
          mountedModal = el as unknown as InstanceType<typeof env.FakeEl>
          env.body.appendChild(mountedModal)
          return env.doc.createElement('div') as unknown as HTMLDivElement
        },
        closeModal: () => {},
        createElapsedTimer: () => () => {},
        updateStatus: () => {},
        activateSavedConnection: async () => {},
        requestPlugin: async (method: string, payload?: unknown) => {
          if (method === 'connection.test') return { ok: true }
          if (method === 'connection.save') {
            studioSaved = payload as { profile?: ConnectionProfile }
            return { ok: true, id: 'conn_wave2_mongo' }
          }
          if (method === 'connections.list') return []
          if (method === 'drivers.list') return { drivers: [] }
          if (method === 'workspace.listScopes') return { workspaces: [] }
          return {}
        },
        onSaved: async () => {},
        onDeleted: async () => {},
      })

      // Select MongoDB tile and type a direct URL with authSource, authMechanism, token, and #fragment secrets
      mountedModal?.querySelector('.datanoa-engine-tile[data-driver="mongodb"]')?.click()
      const mongoUrlInp = (mountedModal?.querySelectorAll('input') ?? []).find((i) =>
        i.placeholder.includes('mongodb+srv://')
      )
      expect(mongoUrlInp).toBeTruthy()
      if (mongoUrlInp) {
        mongoUrlInp.value =
          'mongodb+srv://atlas:SecretPw@cluster0.example.mongodb.net/prod?authSource=admin&authMechanism=SCRAM-SHA-256&token=LeakQ&passphrase=Pp&credential=Cr&authorization=Az#token=FragSecret&jwt=JwtSecret&sig=Sg&signature=Sgn&x=1'
      }
      const buttons = mountedModal?.querySelectorAll('button') ?? []
      buttons.find((b) => b.textContent === 'Save & Connect')?.click()
      await new Promise((r) => setTimeout(r, 30))
      expect(studioSaved?.profile?.url).toBe(
        'mongodb+srv://cluster0.example.mongodb.net/prod?authSource=admin&authMechanism=SCRAM-SHA-256#x=1'
      )

      // Malformed LibSQL fallback preserves ?authSource and # delimiter before surviving fragment params
      mountedModal?.querySelector('.datanoa-engine-tile[data-driver="libsql"]')?.click()
      const libsqlUrlField = (mountedModal?.querySelectorAll('input') ?? []).find((i) =>
        i.placeholder.includes('libsql://your-db.turso.io')
      )
      if (libsqlUrlField) {
        libsqlUrlField.value =
          'not a valid url://host/db?authSource=admin&authType=iam&sig=LeakSig#token=FragSec&signature=LeakSign&x=1'
      }
      studioSaved = null
      buttons.find((b) => b.textContent === 'Save & Connect')?.click()
      await new Promise((r) => setTimeout(r, 30))
      expect(studioSaved?.profile?.url).toBe(
        'not a valid url://host/db?authSource=admin&authType=iam#x=1'
      )

      // Side Panel scrubPanelNetworkFormUrl & fallback regex parity
      env.body.children.length = 0
      for (const [id, tag] of [
        ['uriInput', 'input'],
        ['formName', 'input'],
        ['formFolder', 'input'],
        ['formWorkspaceScope', 'select'],
        ['formFilePath', 'input'],
        ['formLibsqlUrl', 'input'],
        ['formAuthToken', 'input'],
        ['formLibsqlDb', 'input'],
        ['formHost', 'input'],
        ['formPort', 'input'],
        ['formDatabase', 'input'],
        ['formUser', 'input'],
        ['formPassword', 'input'],
        ['formClickhouseUrl', 'input'],
        ['formOptions', 'input'],
        ['formRedisDb', 'select'],
        ['formSsl', 'input'],
        ['formReadOnly', 'input'],
        ['sqliteFields', 'div'],
        ['libsqlFields', 'div'],
        ['serverFields', 'div'],
        ['clickhouseUrlRow', 'div'],
        ['pgOptionsRow', 'div'],
        ['sqlDbRow', 'div'],
        ['redisDbRow', 'div'],
        ['connFormTitle', 'div'],
        ['saveFormBtn', 'button'],
      ] as const) {
        const el = env.doc.createElement(tag)
        el.id = id
        if (id === 'formSsl' || id === 'formReadOnly') el.type = 'checkbox'
        env.body.appendChild(el)
      }
      const formCtrl = createPanelConnectionFormController({
        state: { formDriver: 'mongodb', formColorTag: 'none', editingId: null, connections: [] },
        showBanner: () => {},
        showFormNotice: () => {},
        clearFormNotice: () => {},
        setFormOpen: () => {},
        updateViewportLayout: () => {},
        savePanelViewState: () => {},
      })
      formCtrl.setFormDriver('mongodb', true)
      const panelMongoUrl = env.doc.getElementById('formClickhouseUrl')
      if (panelMongoUrl) {
        panelMongoUrl.value =
          'mongodb://u:Pw@h:27017/db?authSource=admin&authMechanism=SCRAM-SHA-256&authMechanismProperties=SERVICE_NAME:mongo&authorization=LeakAz#token=FragSecret&passphrase=FragPp&credential=FragCr&x=1'
      }
      const panelMongoSub = formCtrl.buildFormSubmission('conn_panel_frag')
      expect(panelMongoSub.profile.url).toBe(
        'mongodb://h:27017/db?authSource=admin&authMechanism=SCRAM-SHA-256&authMechanismProperties=SERVICE_NAME%3Amongo#x=1'
      )

      formCtrl.setFormDriver('libsql', true)
      const panelLibsqlInp = env.doc.getElementById('formLibsqlUrl')
      if (panelLibsqlInp) {
        panelLibsqlInp.value =
          'not a valid url://host/db?authMechanismProperties=A:B#authToken=FragAuth&sig=Sg&keep=1'
      }
      const panelLibsqlSub = formCtrl.buildFormSubmission('conn_panel_libsql_frag')
      expect(panelLibsqlSub.profile.url).toBe(
        'not a valid url://host/db?authMechanismProperties=A:B#keep=1'
      )
    })

    it('#69 Bug 3: panel.html icon-only close buttons and Studio connection-modal folder/BYOD inputs have accessible labels', () => {
      const repoRoot = path.resolve(__dirname, '..')
      const htmlText = fs.readFileSync(path.join(repoRoot, 'src/panel/panel.html'), 'utf8')

      // Check closeInspectorBtn, closeHistoryBtn, and all controls in panel.html
      for (const btnId of ['closeInspectorBtn', 'closeHistoryBtn']) {
        const m = new RegExp(`<button\\b[^>]*\\bid="${btnId}"[^>]*>`, 'i').exec(htmlText)
        expect(m, `missing button #${btnId}`).toBeTruthy()
        expect(m?.[0], `#${btnId} missing aria-label`).toMatch(/\baria-label="[^"]+"/i)
      }
      for (const m of htmlText.matchAll(/<(button|input|select|textarea)\b[^>]*>/gi)) {
        const tagText = m[0]
        const tag = m[1].toLowerCase()
        const hasAria = /\baria-label(?:ledby)?="[^"]+"/i.test(tagText)
        if (tag === 'button') {
          const innerStart = (m.index ?? 0) + tagText.length
          const innerEnd = htmlText.indexOf('</button>', innerStart)
          const innerText = htmlText.slice(innerStart, innerEnd).replace(/<[^>]+>/g, '').trim()
          if (!hasAria) {
            expect(innerText && innerText !== '&times;' && innerText !== '×', `unlabeled button: ${tagText}`).toBeTruthy()
          }
        } else {
          const idMatch = /\bid="([^"]+)"/i.exec(tagText)
          const id = idMatch ? idMatch[1] : ''
          const hasLabelFor = id ? new RegExp(`<label\\b[^>]*\\bfor="${id}"`, 'i').test(htmlText) : false
          const lookback = htmlText.slice(Math.max(0, (m.index ?? 0) - 240), m.index ?? 0)
          const inLabel = /<label\b[^>]*>(?:(?!<\/label>).)*$/is.test(lookback)
          expect(hasAria || hasLabelFor || inLabel, `unlabeled control: ${tagText}`).toBe(true)
        }
      }

      // Studio folderInp + BYOD folderPathInp & cmdInp
      const env = installDom()
      cleanupDom = env.restore
      let mountedModal: InstanceType<typeof env.FakeEl> | null = null
      openStudioConnectionModal({
        isBackdropActive: () => true,
        mountModal: (el) => {
          mountedModal = el as unknown as InstanceType<typeof env.FakeEl>
          env.body.appendChild(mountedModal)
          return env.doc.createElement('div') as unknown as HTMLDivElement
        },
        closeModal: () => {},
        createElapsedTimer: () => () => {},
        updateStatus: () => {},
        activateSavedConnection: async () => {},
        requestPlugin: async (method: string) => {
          if (method === 'connections.list') return []
          if (method === 'drivers.list') return { drivers: [] }
          if (method === 'workspace.listScopes') return { workspaces: [] }
          return {}
        },
        onSaved: async () => {},
        onDeleted: async () => {},
      })

      mountedModal?.querySelector('.datanoa-engine-tile[data-driver="duckdb"]')?.click()
      const allInputs = mountedModal?.querySelectorAll('input') ?? []
      const folderInp = allInputs.find((i) => i.placeholder.includes('folder path to scan'))
      const byodFolderInp = allInputs.find((i) => i.placeholder.includes('datanoa-drivers'))
      const byodCmdInp = allInputs.find((i) => i.readOnly && !i.placeholder)
      expect(folderInp?.getAttribute('aria-label')).toBeTruthy()
      expect(byodFolderInp?.getAttribute('aria-label')).toBeTruthy()
      expect(byodCmdInp?.getAttribute('aria-label')).toBeTruthy()
    })

    it('#73 Bug 5: Side Panel setFormDriver defaults formSsl to true for snowflake & bigquery matching Studio', () => {
      const env = installDom()
      cleanupDom = env.restore
      for (const [id, tag] of [
        ['uriInput', 'input'],
        ['formName', 'input'],
        ['formFolder', 'input'],
        ['formWorkspaceScope', 'select'],
        ['formFilePath', 'input'],
        ['formLibsqlUrl', 'input'],
        ['formAuthToken', 'input'],
        ['formLibsqlDb', 'input'],
        ['formHost', 'input'],
        ['formPort', 'input'],
        ['formDatabase', 'input'],
        ['formUser', 'input'],
        ['formPassword', 'input'],
        ['formClickhouseUrl', 'input'],
        ['formOptions', 'input'],
        ['formRedisDb', 'select'],
        ['formSsl', 'input'],
        ['formReadOnly', 'input'],
        ['sqliteFields', 'div'],
        ['libsqlFields', 'div'],
        ['serverFields', 'div'],
        ['clickhouseUrlRow', 'div'],
        ['pgOptionsRow', 'div'],
        ['sqlDbRow', 'div'],
        ['redisDbRow', 'div'],
        ['connFormTitle', 'div'],
        ['saveFormBtn', 'button'],
      ] as const) {
        const el = env.doc.createElement(tag)
        el.id = id
        if (id === 'formSsl' || id === 'formReadOnly') el.type = 'checkbox'
        env.body.appendChild(el)
      }
      const formCtrl = createPanelConnectionFormController({
        state: { formDriver: 'sqlite', formColorTag: 'none', editingId: null, connections: [] },
        showBanner: () => {},
        showFormNotice: () => {},
        clearFormNotice: () => {},
        setFormOpen: () => {},
        updateViewportLayout: () => {},
        savePanelViewState: () => {},
      })

      const sslEl = env.doc.getElementById('formSsl')
      formCtrl.setFormDriver('snowflake', true)
      expect(sslEl?.checked).toBe(true)
      formCtrl.setFormDriver('bigquery', true)
      expect(sslEl?.checked).toBe(true)
      formCtrl.setFormDriver('cockroachdb', true)
      expect(sslEl?.checked).toBe(true)
      formCtrl.setFormDriver('postgres', true)
      expect(sslEl?.checked).toBe(false)
    })

    it('#73 Bug 6: panel.css defines dark & light --db-* tokens for all 12 built-ins + BYOD and panel.html lists all engines accurately', () => {
      const repoRoot = path.resolve(__dirname, '..')
      const cssText = fs.readFileSync(path.join(repoRoot, 'src/panel/panel.css'), 'utf8')
      const htmlText = fs.readFileSync(path.join(repoRoot, 'src/panel/panel.html'), 'utf8')

      const lightIdx = cssText.indexOf('html.light, body.light')
      expect(lightIdx).toBeGreaterThan(0)
      const darkSection = cssText.slice(0, lightIdx)
      const lightSection = cssText.slice(lightIdx)

      for (const engineId of [
        'mssql',
        'oracle',
        'mongodb',
        'duckdb',
        'snowflake',
        'bigquery',
        'cassandra',
        'elasticsearch',
        'neo4j',
        'custom',
      ]) {
        expect(darkSection, `missing dark --db-${engineId}`).toContain(`--db-${engineId}:`)
        expect(lightSection, `missing light --db-${engineId}`).toContain(`--db-${engineId}:`)
        expect(cssText, `missing .db-${engineId}`).toContain(`.db-${engineId}`)
      }

      expect(htmlText).not.toContain('Inline BYOD Local Driver Setup (SQL Server / Oracle / MongoDB')
      expect(htmlText).toContain('SQL Server')
      expect(htmlText).toContain('Oracle')
      expect(htmlText).toContain('MongoDB')
      expect(htmlText).toContain('DuckDB')
    })
  })

  describe('#99 Wave 3 Fixes: #94 Bug 1, #93 Bug 2, #90 Bug 3 & BYOD empty-state Custom', () => {
    it('#94 Bug 1 & #93 Bug 2: redacts all #79/#99 secret query/hash keys, handles / and # in passwords, and avoids greedy @ crossing on slash-less query URIs', async () => {
      const env = installDom()
      cleanupDom = env.restore

      let studioSaved: { profile?: ConnectionProfile } | null = null
      let mountedModal: InstanceType<typeof env.FakeEl> | null = null
      openStudioConnectionModal({
        isBackdropActive: () => true,
        mountModal: (el) => {
          mountedModal = el as unknown as InstanceType<typeof env.FakeEl>
          env.body.appendChild(mountedModal)
          return env.doc.createElement('div') as unknown as HTMLDivElement
        },
        closeModal: () => {},
        createElapsedTimer: () => () => {},
        updateStatus: () => {},
        activateSavedConnection: async () => {},
        requestPlugin: async (method: string, payload?: unknown) => {
          if (method === 'connection.test') return { ok: true }
          if (method === 'connection.save') {
            studioSaved = payload as { profile?: ConnectionProfile }
            return { ok: true, id: 'conn_w3_scrub' }
          }
          if (method === 'connections.list') return []
          if (method === 'drivers.list') return { drivers: [] }
          if (method === 'workspace.listScopes') return { workspaces: [] }
          return {}
        },
        onSaved: async () => {},
        onDeleted: async () => {},
      })

      const buttons = mountedModal?.querySelectorAll('button') ?? []

      // 1. All #79/#99 hyphen/underscore/plural secret params scrubbed, non-secrets & #tab=indexes preserved
      mountedModal?.querySelector('.datanoa-engine-tile[data-driver="mongodb"]')?.click()
      const mongoUrlInp = (mountedModal?.querySelectorAll('input') ?? []).find((i) =>
        i.placeholder.includes('mongodb+srv://')
      )
      expect(mongoUrlInp).toBeTruthy()
      if (mongoUrlInp) {
        mongoUrlInp.value =
          'mongodb+srv://u:Pw@host/db?authSource=admin&authMechanismProperties=A%3AB&authType=iam&api-key=k2&auth-token=k3&access-token=k3b&refresh_token=k4&refresh-token=k4b&client_secret=k5&client-secret=k5b&credentials=k6&private_key=k7&private-key=k7b&id_token=k8&id-token=k8b#refresh_token=f1&client-secret=f2&tab=indexes'
      }
      buttons.find((b) => b.textContent === 'Save & Connect')?.click()
      await new Promise((r) => setTimeout(r, 30))
      expect(studioSaved?.profile?.url).toBe(
        'mongodb+srv://host/db?authSource=admin&authMechanismProperties=A%3AB&authType=iam#tab=indexes'
      )

      // 2. LibSQL fallback: slash + # in password AND ?password=Sec99 both stripped
      mountedModal?.querySelector('.datanoa-engine-tile[data-driver="libsql"]')?.click()
      const libsqlUrlField = (mountedModal?.querySelectorAll('input') ?? []).find((i) =>
        i.placeholder.includes('libsql://your-db.turso.io')
      )
      if (libsqlUrlField) {
        libsqlUrlField.value = 'redis://u:Pass/Slash#99@127.0.0.1:56379/0?password=Sec99'
      }
      studioSaved = null
      buttons.find((b) => b.textContent === 'Save & Connect')?.click()
      await new Promise((r) => setTimeout(r, 30))
      expect(studioSaved?.profile?.url).toBe('redis://127.0.0.1:56379/0')

      // 3. Slash-less URI with @ inside query param keeps host & query param intact (both parsed & fallback)
      mountedModal?.querySelector('.datanoa-engine-tile[data-driver="mongodb"]')?.click()
      if (mongoUrlInp) {
        mongoUrlInp.value = 'mongodb+srv://u:p@host?authSource=admin&email=a@b&api-key=k1'
      }
      studioSaved = null
      buttons.find((b) => b.textContent === 'Save & Connect')?.click()
      await new Promise((r) => setTimeout(r, 30))
      expect(studioSaved?.profile?.url).toBe('mongodb+srv://host?authSource=admin&email=a%40b')

      if (mongoUrlInp) {
        mongoUrlInp.value = 'mongodb+srv://u:P#1@host?authSource=admin&email=a@b&api-key=k1'
      }
      studioSaved = null
      buttons.find((b) => b.textContent === 'Save & Connect')?.click()
      await new Promise((r) => setTimeout(r, 30))
      expect(studioSaved?.profile?.url).toBe('mongodb+srv://host?authSource=admin&email=a@b')

      // 4. Side Panel parity for #94 Bug 1 & #93 Bug 2 (plus @ in password + /users/@alice)
      env.body.children.length = 0
      for (const [id, tag] of [
        ['uriInput', 'input'],
        ['formName', 'input'],
        ['formFolder', 'input'],
        ['formWorkspaceScope', 'select'],
        ['formFilePath', 'input'],
        ['formLibsqlUrl', 'input'],
        ['formAuthToken', 'input'],
        ['formLibsqlDb', 'input'],
        ['formHost', 'input'],
        ['formPort', 'input'],
        ['formDatabase', 'input'],
        ['formUser', 'input'],
        ['formPassword', 'input'],
        ['formClickhouseUrl', 'input'],
        ['formOptions', 'input'],
        ['formRedisDb', 'select'],
        ['formSsl', 'input'],
        ['formReadOnly', 'input'],
        ['sqliteFields', 'div'],
        ['libsqlFields', 'div'],
        ['serverFields', 'div'],
        ['clickhouseUrlRow', 'div'],
        ['pgOptionsRow', 'div'],
        ['sqlDbRow', 'div'],
        ['redisDbRow', 'div'],
        ['connFormTitle', 'div'],
        ['saveFormBtn', 'button'],
      ] as const) {
        const el = env.doc.createElement(tag)
        el.id = id
        if (id === 'formSsl' || id === 'formReadOnly') el.type = 'checkbox'
        env.body.appendChild(el)
      }
      const formCtrl = createPanelConnectionFormController({
        state: { formDriver: 'mongodb', formColorTag: 'none', editingId: null, connections: [] },
        showBanner: () => {},
        showFormNotice: () => {},
        clearFormNotice: () => {},
        setFormOpen: () => {},
        updateViewportLayout: () => {},
        savePanelViewState: () => {},
      })
      formCtrl.setFormDriver('mongodb', true)
      const panelMongoUrl = env.doc.getElementById('formClickhouseUrl')
      if (panelMongoUrl) {
        panelMongoUrl.value =
          'mongodb+srv://admin:M#1?2@3:4/5@cluster0.example.net/db?authSource=admin&refresh-token=rt&private-key=pk#client-secret=cs&tab=indexes'
      }
      const mongoSub1 = formCtrl.buildFormSubmission('conn_w3_p1')
      expect(mongoSub1.profile.url).toBe('mongodb+srv://cluster0.example.net/db?authSource=admin#tab=indexes')

      if (panelMongoUrl) {
        panelMongoUrl.value = 'mongodb+srv://u:p@host?authSource=admin&email=a@b&refresh_token=rt'
      }
      const mongoSub2 = formCtrl.buildFormSubmission('conn_w3_p2')
      expect(mongoSub2.profile.url).toBe('mongodb+srv://host?authSource=admin&email=a%40b')

      if (panelMongoUrl) {
        panelMongoUrl.value = 'mongodb+srv://u:P#1@host?authSource=admin&email=a@b&refresh_token=rt'
      }
      const mongoSub2b = formCtrl.buildFormSubmission('conn_w3_p2b')
      expect(mongoSub2b.profile.url).toBe('mongodb+srv://host?authSource=admin&email=a@b')

      formCtrl.setFormDriver('libsql', true)
      const panelLibsqlInp = env.doc.getElementById('formLibsqlUrl')
      if (panelLibsqlInp) {
        panelLibsqlInp.value = 'redis://u:Pass/Slash#99@127.0.0.1:56379/0?password=Sec99'
      }
      const libsqlSub = formCtrl.buildFormSubmission('conn_w3_p3')
      expect(libsqlSub.profile.url).toBe('redis://127.0.0.1:56379/0')

      if (panelLibsqlInp) {
        panelLibsqlInp.value = 'https://example.com:8443/users/@alice?token=secret'
      }
      const libsqlSubAlice = formCtrl.buildFormSubmission('conn_w3_p4')
      expect(libsqlSubAlice.profile.url).toBe('https://example.com:8443/users/@alice')
    })

    it('#90 Bug 3 & panel.html Custom empty-state: Side Panel rejects studioOnly drivers (d1) in populateFormFromProfile, handleParseUri, and Docker apply; panel.html lists Custom', async () => {
      const env = installDom()
      cleanupDom = env.restore
      for (const [id, tag] of [
        ['uriInput', 'input'],
        ['formName', 'input'],
        ['formFolder', 'input'],
        ['formWorkspaceScope', 'select'],
        ['formFilePath', 'input'],
        ['formLibsqlUrl', 'input'],
        ['formAuthToken', 'input'],
        ['formLibsqlDb', 'input'],
        ['formHost', 'input'],
        ['formPort', 'input'],
        ['formDatabase', 'input'],
        ['formUser', 'input'],
        ['formPassword', 'input'],
        ['formClickhouseUrl', 'input'],
        ['formOptions', 'input'],
        ['formRedisDb', 'select'],
        ['formSsl', 'input'],
        ['formReadOnly', 'input'],
        ['sqliteFields', 'div'],
        ['libsqlFields', 'div'],
        ['serverFields', 'div'],
        ['clickhouseUrlRow', 'div'],
        ['pgOptionsRow', 'div'],
        ['sqlDbRow', 'div'],
        ['redisDbRow', 'div'],
        ['discoveredScopeHint', 'div'],
        ['discoveredBox', 'div'],
        ['discoveredSearchInput', 'input'],
        ['discoveredGroupsWrap', 'div'],
        ['discoveredEnvGroup', 'div'],
        ['discoveredEnvToggle', 'button'],
        ['discoveredEnvBody', 'div'],
        ['discoveredEnvCount', 'span'],
        ['discoveredEnvList', 'div'],
        ['discoveredDockerGroup', 'div'],
        ['discoveredDockerToggle', 'button'],
        ['discoveredDockerBody', 'div'],
        ['discoveredDockerCount', 'span'],
        ['discoveredDockerList', 'div'],
        ['discoveredFileGroup', 'div'],
        ['discoveredFileToggle', 'button'],
        ['discoveredFileBody', 'div'],
        ['discoveredCount', 'span'],
        ['discoveredList', 'div'],
        ['connFormTitle', 'div'],
        ['saveFormBtn', 'button'],
      ] as const) {
        const el = env.doc.createElement(tag)
        el.id = id
        if (id === 'formSsl' || id === 'formReadOnly') el.type = 'checkbox'
        env.body.appendChild(el)
      }

      const banners: string[] = []
      const notices: string[] = []
      let formOpened = false
      const panelState: Record<string, unknown> = {
        formDriver: 'sqlite',
        formColorTag: 'none',
        editingId: null,
        connections: [],
      }
      ;(globalThis as unknown as { window: Record<string, unknown> }).window.orca = {
        plugin: {
          request: async (method: string) => {
            if (method === 'connection.parseUri') {
              return {
                ok: true,
                profile: {
                  id: '',
                  name: 'D1',
                  driver: 'd1',
                  database: 'main',
                  d1AccountId: 'acct',
                  d1DatabaseId: 'db1',
                  ssl: true,
                  readOnly: false,
                },
              }
            }
            if (method === 'workspace.detectConnections') {
              return {
                scannedDirs: ['D:\\app'],
                sqliteFiles: [],
                envConnections: [],
                dockerComposeConnections: [
                  {
                    id: 'dc_d1',
                    project: 'app',
                    service: 'd1',
                    driver: 'd1',
                    name: 'local-d1',
                    host: '127.0.0.1',
                    port: 443,
                    database: 'main',
                    sourceKind: 'live',
                    sourceFile: 'docker ps',
                    status: 'running',
                    workspaceMatched: true,
                  },
                ],
              }
            }
            return {}
          },
        },
      }
      const formCtrl = createPanelConnectionFormController({
        state: panelState,
        showBanner: (msg: string) => banners.push(msg),
        showFormNotice: (msg: string) => notices.push(msg),
        clearFormNotice: () => {},
        setFormOpen: (open: boolean) => {
          formOpened = open
        },
        updateViewportLayout: () => {},
        savePanelViewState: () => {},
      })

      // 1. populateFormFromProfile blocks studioOnly driver 'd1'
      formCtrl.populateFormFromProfile(
        {
          id: 'conn_d1',
          name: 'My D1',
          driver: 'd1',
          database: 'main',
          d1AccountId: 'acct',
          d1DatabaseId: 'db1',
          ssl: true,
          readOnly: false,
        },
        'edit'
      )
      expect(formOpened).toBe(false)
      expect(banners.some((b) => b.includes('Fullscreen Studio'))).toBe(true)

      // 2. handleParseUri blocks studioOnly driver 'd1'
      const uriParsed = await formCtrl.handleParseUri('d1://acct/db1?apiToken=tok')
      expect(uriParsed).toBe(false)
      expect(panelState.formDriver).toBe('sqlite')
      expect(notices.some((n) => n.includes('Fullscreen Studio'))).toBe(true)

      // 3. applyDiscoveredDockerCompose blocks studioOnly driver 'd1'
      await formCtrl.detectWorkspace()
      const dockerChip = env.doc.getElementById('discoveredDockerList')?.querySelector('.file-chip')
      expect(dockerChip).toBeTruthy()
      dockerChip?.click()
      expect(panelState.formDriver).toBe('sqlite')
      expect(notices.filter((n) => n.includes('Fullscreen Studio')).length).toBeGreaterThanOrEqual(2)

      // 4. panel.html empty-state includes Custom inside BYOD (...)
      const repoRoot = path.resolve(__dirname, '..')
      const htmlText = fs.readFileSync(path.join(repoRoot, 'src/panel/panel.html'), 'utf8')
      expect(htmlText).toContain(
        'BYOD (DuckDB, Snowflake, BigQuery, Cassandra, Elasticsearch, Neo4j, Custom)'
      )
    })
  })

  describe('#119 Wave 4 Fixes: #114 Bug 1 (credentials plural & ClickHouse URL scrub), #111 authority sync, and #110 Bug 1 (setFormDriver studioOnly)', () => {
    let cleanupDom: (() => void) | null = null

    afterEach(() => {
      cleanupDom?.()
      cleanupDom = null
    })

    it('#114 Bug 1 & #111 sync: scrubs credentials plural, ClickHouse client URLs on save/populate, and fallback single-label/fragment/@-password URLs across Studio & Panel', async () => {
      const env = installDom()
      cleanupDom = env.restore

      let studioSaved: { profile?: ConnectionProfile } | null = null
      let mountedModal: InstanceType<typeof env.FakeEl> | null = null
      openStudioConnectionModal(
        {
          isBackdropActive: () => true,
          mountModal: (el) => {
            mountedModal = el as unknown as InstanceType<typeof env.FakeEl>
            env.body.appendChild(mountedModal)
            return env.doc.createElement('div') as unknown as HTMLDivElement
          },
          closeModal: () => {},
          createElapsedTimer: () => () => {},
          updateStatus: () => {},
          activateSavedConnection: async () => {},
          requestPlugin: async (method: string, payload?: unknown) => {
            if (method === 'connection.test') return { ok: true }
            if (method === 'connection.save') {
              studioSaved = payload as { profile?: ConnectionProfile }
              return { ok: true, id: 'conn_w4_studio' }
            }
            if (method === 'connections.list') return []
            if (method === 'drivers.list') return { drivers: [] }
            if (method === 'workspace.listScopes') return { workspaces: [] }
            return {}
          },
          onConnectionDeleted: async () => {},
        },
        {
          id: 'conn_ch_edit',
          name: 'CH Edit',
          driver: 'clickhouse',
          host: 'ch.example.com',
          port: 8443,
          database: 'analytics',
          url: 'https://ch_user:ChPass#1@ch.example.com:8443/analytics?credentials=k6&readonly=1#tab=overview',
          ssl: true,
          readOnly: false,
        }
      )
      mountedModal = env.body.children[env.body.children.length - 1]
      const chUrlField = (mountedModal?.querySelectorAll('input') ?? []).find((i) =>
        i.placeholder.includes('http://localhost:8123')
      )
      expect(chUrlField?.value).toBe(
        'https://ch.example.com:8443/analytics?readonly=1#tab=overview'
      )

      const buttons = mountedModal?.querySelectorAll('button') ?? []
      if (chUrlField) {
        chUrlField.value =
          'https://ch_user:ChPass#1@ch.example.com:8443/analytics?token=secret&credentials=k6&readonly=1#credentials=f1&tab=indexes'
      }
      await new Promise((r) => setTimeout(r, 10))
      buttons.find((b) => b.textContent === 'Update Connection')?.click()
      await new Promise((r) => setTimeout(r, 30))
      expect(studioSaved?.profile?.driver).toBe('clickhouse')
      expect(studioSaved?.profile?.url).toBe(
        'https://ch.example.com:8443/analytics?readonly=1#tab=indexes'
      )

      // Exercise fallback URL scrubber in Studio for plural credentials + single-label/#/@-in-password cases
      mountedModal?.querySelector('.datanoa-engine-tile[data-driver="mongodb"]')?.click()
      if (chUrlField) {
        chUrlField.value = [
          'mongodb+srv://u:Pw/Sl#1@host/db?authSource=admin&credentials=k6#credentials=f1&tab=indexes',
          'https://u:p@myhost/users/@alice.dev?token=secret&credentials=k1',
          'mongodb://u:p@mongo-primary/db#section=a@b.com',
          'mongodb+srv://u:p@host#section=a@b.com',
          'https://api-server:8443/users/@alice?token=secret',
          'mongodb+srv://admin:pass?a=1@cluster0.example.net/w4_r3_db?email=x@y.com',
          'mongodb+srv://admin:pass?a=1@myhost/w4_r3_db?email=x@y.com',
        ].join(' ')
      }
      studioSaved = null
      buttons.find((b) => b.textContent === 'Update Connection')?.click()
      await new Promise((r) => setTimeout(r, 30))
      expect(studioSaved?.profile?.url).toBe(
        [
          'mongodb+srv://host/db?authSource=admin#tab=indexes',
          'https://myhost/users/@alice.dev',
          'mongodb://mongo-primary/db#section=a@b.com',
          'mongodb+srv://host#section=a@b.com',
          'https://api-server:8443/users/@alice',
          'mongodb+srv://cluster0.example.net/w4_r3_db?email=x@y.com',
          'mongodb+srv://myhost/w4_r3_db?email=x@y.com',
        ].join(' ')
      )

      // Side Panel parity for ClickHouse + plural credentials + single-label / #section=a@b.com / pass?a=1
      env.body.children.length = 0
      for (const [id, tag] of [
        ['uriInput', 'input'],
        ['formName', 'input'],
        ['formFolder', 'input'],
        ['formWorkspaceScope', 'select'],
        ['formFilePath', 'input'],
        ['formLibsqlUrl', 'input'],
        ['formAuthToken', 'input'],
        ['formLibsqlDb', 'input'],
        ['formHost', 'input'],
        ['formPort', 'input'],
        ['formDatabase', 'input'],
        ['formUser', 'input'],
        ['formPassword', 'input'],
        ['formClickhouseUrl', 'input'],
        ['formOptions', 'input'],
        ['formRedisDb', 'select'],
        ['formSsl', 'input'],
        ['formReadOnly', 'input'],
        ['sqliteFields', 'div'],
        ['libsqlFields', 'div'],
        ['serverFields', 'div'],
        ['clickhouseUrlRow', 'div'],
        ['pgOptionsRow', 'div'],
        ['sqlDbRow', 'div'],
        ['redisDbRow', 'div'],
        ['connFormTitle', 'div'],
        ['saveFormBtn', 'button'],
      ] as const) {
        const el = env.doc.createElement(tag)
        el.id = id
        if (id === 'formSsl' || id === 'formReadOnly') el.type = 'checkbox'
        env.body.appendChild(el)
      }
      const formCtrl = createPanelConnectionFormController({
        state: { formDriver: 'sqlite', formColorTag: 'none', editingId: null, connections: [] },
        showBanner: () => {},
        showFormNotice: () => {},
        clearFormNotice: () => {},
        setFormOpen: () => {},
        updateViewportLayout: () => {},
        savePanelViewState: () => {},
      })

      formCtrl.populateFormFromProfile(
        {
          id: 'conn_panel_ch_edit',
          name: 'Panel CH',
          driver: 'clickhouse',
          host: 'ch.example.com',
          port: 8443,
          database: 'analytics',
          url: 'https://ch_user:ChPass#1@ch.example.com:8443/analytics?credentials=k6&readonly=1#tab=overview',
          ssl: true,
          readOnly: false,
        },
        'edit'
      )
      const panelUrlInp = env.doc.getElementById('formClickhouseUrl')
      expect(panelUrlInp?.value).toBe(
        'https://ch.example.com:8443/analytics?readonly=1#tab=overview'
      )

      if (panelUrlInp) {
        panelUrlInp.value =
          'https://ch_user:ChPass#1@ch.example.com:8443/analytics?token=secret&credentials=k6&readonly=1#credentials=f1&tab=indexes'
      }
      const chSub = formCtrl.buildFormSubmission('conn_w4_p_ch')
      expect(chSub.profile.url).toBe(
        'https://ch.example.com:8443/analytics?readonly=1#tab=indexes'
      )

      formCtrl.setFormDriver('mongodb', true)
      if (panelUrlInp) {
        panelUrlInp.value = [
          'mongodb+srv://u:Pw/Sl#1@host/db?authSource=admin&credentials=k6#credentials=f1&tab=indexes',
          'https://u:p@myhost/users/@alice.dev?token=secret&credentials=k1',
          'mongodb://u:p@mongo-primary/db#section=a@b.com',
          'mongodb+srv://u:p@host#section=a@b.com',
          'https://api-server:8443/users/@alice?token=secret',
          'mongodb+srv://admin:pass?a=1@cluster0.example.net/w4_r3_db?email=x@y.com',
          'mongodb+srv://admin:pass?a=1@myhost/w4_r3_db?email=x@y.com',
        ].join(' ')
      }
      const fallbackSub = formCtrl.buildFormSubmission('conn_w4_p_fb')
      expect(fallbackSub.profile.url).toBe(
        [
          'mongodb+srv://host/db?authSource=admin#tab=indexes',
          'https://myhost/users/@alice.dev',
          'mongodb://mongo-primary/db#section=a@b.com',
          'mongodb+srv://host#section=a@b.com',
          'https://api-server:8443/users/@alice',
          'mongodb+srv://cluster0.example.net/w4_r3_db?email=x@y.com',
          'mongodb+srv://myhost/w4_r3_db?email=x@y.com',
        ].join(' ')
      )
    })

    it('#110 Bug 1: Side Panel setFormDriver rejects studioOnly driver (d1) and falls back cleanly to sqlite without opening serverFields', () => {
      const env = installDom()
      cleanupDom = env.restore

      for (const [id, tag] of [
        ['uriInput', 'input'],
        ['formName', 'input'],
        ['formFolder', 'input'],
        ['formWorkspaceScope', 'select'],
        ['formFilePath', 'input'],
        ['formLibsqlUrl', 'input'],
        ['formAuthToken', 'input'],
        ['formLibsqlDb', 'input'],
        ['formHost', 'input'],
        ['formPort', 'input'],
        ['formDatabase', 'input'],
        ['formUser', 'input'],
        ['formPassword', 'input'],
        ['formClickhouseUrl', 'input'],
        ['formOptions', 'input'],
        ['formRedisDb', 'select'],
        ['formSsl', 'input'],
        ['formReadOnly', 'input'],
        ['sqliteFields', 'div'],
        ['libsqlFields', 'div'],
        ['serverFields', 'div'],
        ['clickhouseUrlRow', 'div'],
        ['pgOptionsRow', 'div'],
        ['sqlDbRow', 'div'],
        ['redisDbRow', 'div'],
        ['connFormTitle', 'div'],
        ['saveFormBtn', 'button'],
      ] as const) {
        const el = env.doc.createElement(tag)
        el.id = id
        if (id === 'formSsl' || id === 'formReadOnly') el.type = 'checkbox'
        env.body.appendChild(el)
      }

      const panelState = {
        formDriver: 'sqlite',
        formColorTag: 'none',
        editingId: null,
        connections: [],
      }
      const formCtrl = createPanelConnectionFormController({
        state: panelState,
        showBanner: () => {},
        showFormNotice: () => {},
        clearFormNotice: () => {},
        setFormOpen: () => {},
        updateViewportLayout: () => {},
        savePanelViewState: () => {},
      })

      formCtrl.setFormDriver('d1', true)
      expect(panelState.formDriver).toBe('sqlite')
      expect(env.doc.getElementById('sqliteFields')?.hidden).toBe(false)
      expect(env.doc.getElementById('serverFields')?.hidden).toBe(true)

      const sub = formCtrl.buildFormSubmission('conn_w4_d1_fallback')
      expect(sub.profile.driver).toBe('sqlite')
    })
  })

  describe('#155 Wave 6 Fixes: worker-utils R2 Bug 3, form numeric-?/@-handle & libsql/d1 scrub R4 Bugs 1b/2/3, and custom-select search A11y R4 Bug 6', () => {
    let cleanupDom: (() => void) | null = null

    afterEach(() => {
      cleanupDom?.()
      cleanupDom = null
    })

    it('R2 Bug 3: worker-utils scrubCredentialsInText strips ?key=val passwords before @host, preserves JSON closing "}, and keeps single-label host:port /@handle paths intact', () => {
      expect(
        scrubCredentialsInText(
          '{"err":"oracle://w6_u:k9?env=dev&x=1@ora.internal:1521/w6?owner=dev@team.io&credentials=Tok88&Pwd={w6@pass;2}"}'
        )
      ).toBe(
        '{"err":"oracle://w6_u@ora.internal:1521/w6?owner=dev@team.io&credentials=[REDACTED]&Pwd=[REDACTED]"}'
      )

      expect(
        scrubCredentialsInText(
          '{"err":"Connect https://api.internal:8443/v2/@bob?token=LeakMe"}'
        )
      ).toBe('{"err":"Connect https://api.internal:8443/v2/@bob?token=[REDACTED]"}')

      expect(scrubCredentialsInText('{"err":"Server=db;Pwd=PlainSecretW6"}')).toBe(
        '{"err":"Server=db;Pwd=[REDACTED]"}'
      )

      expect(
        scrubCredentialsInText(
          'Err https://apihost:8443/v2/@bob?token=LeakMe&authSource=admin'
        )
      ).toBe('Err https://apihost:8443/v2/@bob?token=[REDACTED]&authSource=admin')

      expect(
        scrubCredentialsInText(
          'Err https://apihost:8443/v2/@bob.dev?token=LeakMe&authSource=admin'
        )
      ).toBe('Err https://apihost:8443/v2/@bob.dev?token=[REDACTED]&authSource=admin')

      expect(
        scrubCredentialsInText('redis://svc:9981/sub@redis-node/2?password=Top99')
      ).toBe('redis://svc@redis-node/2?password=[REDACTED]')

      expect(
        scrubCredentialsInText(
          'https://ops:1234?k=1@ch.internal:8443/v1?notify=ops@corp.io&token=Sec7'
        )
      ).toBe('https://ops@ch.internal:8443/v1?notify=ops@corp.io&token=[REDACTED]')
    })

    it('R4 Bugs 1b, 2 & 3: Studio & Side Panel recover numeric-?/# passwords, guard /@handle paths on singlehost, and scrub libsql + d1 URLs across Edit Populate, Docker Compose Apply, and Save', async () => {
      const env = installDom()
      cleanupDom = env.restore

      let studioSaved: { profile?: ConnectionProfile } | null = null
      let mountedModal: InstanceType<typeof env.FakeEl> | null = null
      openStudioConnectionModal(
        {
          isBackdropActive: () => true,
          mountModal: (el) => {
            mountedModal = el as unknown as InstanceType<typeof env.FakeEl>
            env.body.appendChild(mountedModal)
            return env.doc.createElement('div') as unknown as HTMLDivElement
          },
          closeModal: () => {},
          createElapsedTimer: () => () => {},
          updateStatus: () => {},
          activateSavedConnection: async () => {},
          requestPlugin: async (method: string, payload?: unknown) => {
            if (method === 'connection.test') return { ok: true }
            if (method === 'connection.save') {
              studioSaved = payload as { profile?: ConnectionProfile }
              return { ok: true, id: 'conn_w6_studio' }
            }
            if (method === 'connections.list') return []
            if (method === 'drivers.list') return { drivers: [] }
            if (method === 'workspace.listScopes') return { workspaces: [] }
            if (method === 'workspace.detectConnections') {
              return {
                envConnections: [],
                sqliteFiles: [],
                dockerComposeConnections: [
                  {
                    id: 'dc_libsql_w6',
                    name: 'docker-libsql',
                    project: 'proj',
                    service: 'libsql',
                    driver: 'libsql',
                    host: 'db.turso.io',
                    port: 443,
                    database: 'main',
                    url: 'libsql://tu:LibSec9@db.turso.io:443/main?authToken=TursoSecret9&owner=lead@corp.io',
                  },
                  {
                    id: 'dc_ch_w6',
                    name: 'docker-ch',
                    project: 'proj',
                    service: 'clickhouse',
                    driver: 'clickhouse',
                    host: 'ch.internal',
                    port: 8443,
                    database: 'analytics',
                    url: 'https://ops:1234?k=1@ch.internal:8443/v1?notify=ops@corp.io',
                  },
                ],
              }
            }
            return {}
          },
          onConnectionDeleted: async () => {},
        },
        {
          id: 'conn_d1_w6_edit',
          name: 'W6 D1 Edit',
          driver: 'd1',
          database: 'main',
          d1AccountId: 'acc1',
          d1DatabaseId: 'db1',
          url: 'https://d1u:D1Secret9@api.cloudflare.com/client/v4/accounts/acc1/d1/database/db1?apiKey=CfKey9',
          ssl: true,
          readOnly: false,
          hasAuthToken: true,
        }
      )

      mountedModal = env.body.children[env.body.children.length - 1]
      const inputs = mountedModal?.querySelectorAll('input') ?? []
      const buttons = mountedModal?.querySelectorAll('button') ?? []
      const d1UrlInp = inputs.find((i) => i.placeholder.includes('Optional custom endpoint'))
      const libsqlUrlInp = inputs.find((i) => i.placeholder.includes('libsql://your-db.turso.io'))
      const chUrlInp = inputs.find((i) => i.placeholder.includes('http://localhost:8123'))

      // D1 Edit Populate + Save must scrub d1Endpoint URL
      expect(d1UrlInp?.value).toBe(
        'https://api.cloudflare.com/client/v4/accounts/acc1/d1/database/db1'
      )
      if (d1UrlInp) {
        d1UrlInp.value =
          'https://d1u:D1Secret9@api.cloudflare.com/client/v4/accounts/acc1/d1/database/db1?apiKey=CfKey9'
      }
      studioSaved = null
      buttons.find((b) => b.textContent === 'Update Connection')?.click()
      await new Promise((r) => setTimeout(r, 30))
      expect(studioSaved?.profile?.driver).toBe('d1')
      expect(studioSaved?.profile?.url).toBe(
        'https://api.cloudflare.com/client/v4/accounts/acc1/d1/database/db1'
      )

      // Docker Compose Apply scrubs LibSQL & numeric-? ClickHouse URLs on Studio
      buttons.find((b) => b.textContent.includes('Auto-Detect'))?.click()
      await new Promise((r) => setTimeout(r, 30))
      const dcChips = mountedModal?.querySelectorAll('.datanoa-conn-chip') ?? []
      const dcLibsqlChip = dcChips.find((b) => b.textContent.includes('docker-libsql'))
      const dcChChip = dcChips.find((b) => b.textContent.includes('docker-ch'))
      expect(dcLibsqlChip).toBeTruthy()
      expect(dcChChip).toBeTruthy()

      dcLibsqlChip?.click()
      expect(libsqlUrlInp?.value).not.toContain('LibSec9')
      expect(libsqlUrlInp?.value).not.toContain('TursoSecret9')
      expect(libsqlUrlInp?.value).toBe('libsql://db.turso.io:443/main?owner=lead%40corp.io')

      dcChChip?.click()
      expect(chUrlInp?.value).toBe('https://ch.internal:8443/v1?notify=ops@corp.io')

      // Studio numeric-?/# password + /@handle on singlehost across Save
      const studioUriInp = inputs.find((i) => i.placeholder.includes('Paste connection URI'))
      if (studioUriInp) {
        studioUriInp.value = ''
        delete studioUriInp.dataset.rawAutoUri
      }
      mountedModal?.querySelector('.datanoa-engine-tile[data-driver="mongodb"]')?.click()
      if (chUrlInp) {
        chUrlInp.value = 'mongodb://u:1234?k=1@cluster.net/db?email=a@b.io'
      }
      studioSaved = null
      buttons.find((b) => b.textContent === 'Update Connection')?.click()
      await new Promise((r) => setTimeout(r, 30))
      expect(studioSaved?.profile?.url).toBe('mongodb://cluster.net/db?email=a@b.io')

      if (chUrlInp) {
        chUrlInp.value = 'https://u:p/2@singlehost/users/@dev.user?token=Sec'
      }
      studioSaved = null
      buttons.find((b) => b.textContent === 'Update Connection')?.click()
      await new Promise((r) => setTimeout(r, 30))
      expect(studioSaved?.profile?.url).toBe('https://singlehost/users/@dev.user')

      // Re-test Studio Edit Populate for LibSQL
      env.body.children.length = 0
      openStudioConnectionModal(
        {
          isBackdropActive: () => true,
          mountModal: (el) => {
            mountedModal = el as unknown as InstanceType<typeof env.FakeEl>
            env.body.appendChild(mountedModal)
            return env.doc.createElement('div') as unknown as HTMLDivElement
          },
          closeModal: () => {},
          createElapsedTimer: () => () => {},
          updateStatus: () => {},
          activateSavedConnection: async () => {},
          requestPlugin: async (method: string) => {
            if (method === 'connections.list') return []
            if (method === 'drivers.list') return { drivers: [] }
            if (method === 'workspace.listScopes') return { workspaces: [] }
            if (method === 'workspace.detectConnections') {
              return { envCandidates: [], dbFiles: [], dockerComposeCandidates: [] }
            }
            return {}
          },
          onConnectionDeleted: async () => {},
        },
        {
          id: 'conn_libsql_w6_edit',
          name: 'W6 LibSQL Edit',
          driver: 'libsql',
          database: 'main',
          url: 'libsql://tu:LibSec9@db.turso.io:443/main?authToken=TursoSecret9&owner=lead@corp.io',
          ssl: true,
          readOnly: false,
          hasAuthToken: true,
        }
      )
      mountedModal = env.body.children[env.body.children.length - 1]
      const libsqlEditField = (mountedModal?.querySelectorAll('input') ?? []).find((i) =>
        i.placeholder.includes('libsql://your-db.turso.io')
      )
      expect(libsqlEditField?.value).not.toContain('LibSec9')
      expect(libsqlEditField?.value).not.toContain('TursoSecret9')
      expect(libsqlEditField?.value).toBe('libsql://db.turso.io:443/main?owner=lead%40corp.io')

      // Side Panel parity across Edit Populate, Docker Compose Apply, and Save
      env.body.children.length = 0
      for (const [id, tag] of [
        ['uriInput', 'input'],
        ['formName', 'input'],
        ['formFolder', 'input'],
        ['formWorkspaceScope', 'select'],
        ['formFilePath', 'input'],
        ['formLibsqlUrl', 'input'],
        ['formAuthToken', 'input'],
        ['formLibsqlDb', 'input'],
        ['formHost', 'input'],
        ['formPort', 'input'],
        ['formDatabase', 'input'],
        ['formUser', 'input'],
        ['formPassword', 'input'],
        ['formClickhouseUrl', 'input'],
        ['formOptions', 'input'],
        ['formRedisDb', 'select'],
        ['formSsl', 'input'],
        ['formReadOnly', 'input'],
        ['sqliteFields', 'div'],
        ['libsqlFields', 'div'],
        ['serverFields', 'div'],
        ['clickhouseUrlRow', 'div'],
        ['pgOptionsRow', 'div'],
        ['sqlDbRow', 'div'],
        ['redisDbRow', 'div'],
        ['discoveredScopeHint', 'div'],
        ['discoveredBox', 'div'],
        ['discoveredSearchInput', 'input'],
        ['discoveredGroupsWrap', 'div'],
        ['discoveredEnvGroup', 'div'],
        ['discoveredEnvToggle', 'button'],
        ['discoveredEnvBody', 'div'],
        ['discoveredEnvCount', 'span'],
        ['discoveredEnvList', 'div'],
        ['discoveredDockerGroup', 'div'],
        ['discoveredDockerToggle', 'button'],
        ['discoveredDockerBody', 'div'],
        ['discoveredDockerCount', 'span'],
        ['discoveredDockerList', 'div'],
        ['discoveredFileGroup', 'div'],
        ['discoveredFileToggle', 'button'],
        ['discoveredFileBody', 'div'],
        ['discoveredCount', 'span'],
        ['discoveredList', 'div'],
        ['connFormTitle', 'div'],
        ['saveFormBtn', 'button'],
      ] as const) {
        const el = env.doc.createElement(tag)
        el.id = id
        if (id === 'formSsl' || id === 'formReadOnly') el.type = 'checkbox'
        env.body.appendChild(el)
      }
      ;(globalThis as unknown as { window: Record<string, unknown> }).window.orca = {
        plugin: {
          request: async (method: string) => {
            if (method === 'workspace.detectConnections') {
              return {
                envConnections: [],
                sqliteFiles: [],
                dockerComposeConnections: [
                  {
                    id: 'dc_panel_libsql_w6',
                    name: 'docker-libsql-panel',
                    project: 'proj',
                    service: 'libsql',
                    driver: 'libsql',
                    host: 'db.turso.io',
                    port: 443,
                    database: 'main',
                    url: 'libsql://tu:LibSec9@db.turso.io:443/main?authToken=TursoSecret9&owner=lead@corp.io',
                  },
                  {
                    id: 'dc_panel_ch_w6',
                    name: 'docker-ch-panel',
                    project: 'proj',
                    service: 'clickhouse',
                    driver: 'clickhouse',
                    host: 'ch.internal',
                    port: 8443,
                    database: 'analytics',
                    url: 'https://ops:1234?k=1@ch.internal:8443/v1?notify=ops@corp.io',
                  },
                ],
              }
            }
            return {}
          },
        },
      }

      const formCtrl = createPanelConnectionFormController({
        state: { formDriver: 'sqlite', formColorTag: 'none', editingId: null, connections: [] },
        showBanner: () => {},
        showFormNotice: () => {},
        clearFormNotice: () => {},
        setFormOpen: () => {},
        updateViewportLayout: () => {},
        savePanelViewState: () => {},
      })

      formCtrl.populateFormFromProfile(
        {
          id: 'conn_panel_libsql_w6',
          name: 'Panel LibSQL',
          driver: 'libsql',
          database: 'main',
          url: 'libsql://tu:LibSec9@db.turso.io:443/main?authToken=TursoSecret9&owner=lead@corp.io',
          ssl: true,
          readOnly: false,
          hasAuthToken: true,
        },
        'edit'
      )
      expect(env.doc.getElementById('formLibsqlUrl')?.value).toBe(
        'libsql://db.turso.io:443/main?owner=lead%40corp.io'
      )

      formCtrl.populateFormFromProfile(
        {
          id: 'conn_panel_ch_w6',
          name: 'Panel CH',
          driver: 'clickhouse',
          host: 'ch.internal',
          port: 8443,
          database: 'analytics',
          url: 'https://ops:1234?k=1@ch.internal:8443/v1?notify=ops@corp.io',
          ssl: true,
          readOnly: false,
        },
        'edit'
      )
      expect(env.doc.getElementById('formClickhouseUrl')?.value).toBe(
        'https://ch.internal:8443/v1?notify=ops@corp.io'
      )

      await formCtrl.detectWorkspace()
      const panelDcChips =
        env.doc.getElementById('discoveredDockerList')?.querySelectorAll('.file-chip') ?? []
      panelDcChips.find((c) => c.textContent.includes('docker-libsql-panel'))?.click()
      expect(env.doc.getElementById('formLibsqlUrl')?.value).toBe(
        'libsql://db.turso.io:443/main?owner=lead%40corp.io'
      )

      panelDcChips.find((c) => c.textContent.includes('docker-ch-panel'))?.click()
      expect(env.doc.getElementById('formClickhouseUrl')?.value).toBe(
        'https://ch.internal:8443/v1?notify=ops@corp.io'
      )

      formCtrl.setFormDriver('mongodb', true)
      const panelUrl = env.doc.getElementById('formClickhouseUrl')
      if (panelUrl) panelUrl.value = 'https://u:p/2@singlehost/users/@dev.user?token=Sec'
      expect(formCtrl.buildFormSubmission('conn_w6_p_handle').profile.url).toBe(
        'https://singlehost/users/@dev.user'
      )
      if (panelUrl) panelUrl.value = 'mongodb://u:1234?k=1@cluster.net/db?email=a@b.io'
      expect(formCtrl.buildFormSubmission('conn_w6_p_numq').profile.url).toBe(
        'mongodb://cluster.net/db?email=a@b.io'
      )
    })

    it('R4 Bug 6: Studio and Side Panel custom-select search inputs carry aria-label when popover opens', async () => {
      const env = installDom()
      cleanupDom = env.restore

      const { enhanceStudioCollapsibleSelect } = await import('../src/editor/db-icons')
      const { enhanceCollapsibleSelectDropdown } = await import('../src/panel/panel-utils.js')

      const studioWrap = env.doc.createElement('div')
      const studioSelect = env.doc.createElement('select')
      studioSelect.setAttribute('aria-label', 'Workspace Scope')
      studioSelect.dataset.searchAriaLabel = 'Search workspaces'
      const opt1 = env.doc.createElement('option')
      opt1.value = ''
      opt1.textContent = 'Global'
      studioSelect.appendChild(opt1)
      studioWrap.appendChild(studioSelect)
      env.body.appendChild(studioWrap)

      enhanceStudioCollapsibleSelect(studioSelect as unknown as HTMLSelectElement, {
        tooltipPrefix: 'Workspace Scope',
        searchPlaceholder: 'Search workspaces by name, branch, or project folder...',
      })
      const studioTrigger = studioWrap.querySelector('.datanoa-custom-select-trigger')
      studioTrigger?.click()
      const studioSearch = env.body.querySelector('.datanoa-custom-select-search')
      expect(studioSearch).toBeTruthy()
      expect(studioSearch?.getAttribute('aria-label')).toBe('Search workspaces')

      const panelWrap = env.doc.createElement('div')
      const panelSelect = env.doc.createElement('select')
      panelSelect.setAttribute('aria-label', 'Workspace Scope')
      const pOpt = env.doc.createElement('option')
      pOpt.value = ''
      pOpt.textContent = 'Global'
      panelSelect.appendChild(pOpt)
      panelWrap.appendChild(panelSelect)
      env.body.appendChild(panelWrap)

      enhanceCollapsibleSelectDropdown(panelSelect as unknown as HTMLSelectElement, {
        tooltipPrefix: 'Workspace Scope',
        searchPlaceholder: 'Search workspaces...',
      })
      const panelTrigger = panelWrap.querySelector('.custom-select-trigger')
      panelTrigger?.click()
      const panelSearch = env.body.querySelector('.custom-select-search')
      expect(panelSearch).toBeTruthy()
      expect(panelSearch?.getAttribute('aria-label')).toBe('Search workspaces...')
    })
  })

  describe('#177 Wave 7 Fixes: unified findCredentialAuthorityAtIndex, double-escaped ClickHouse & \\" preservation, and Docker Compose ClickHouse -> MongoDB chUrlInp reset', () => {
    let cleanupDom: (() => void) | null = null

    afterEach(() => {
      cleanupDom?.()
      cleanupDom = null
    })

    it('unifies authority selection across worker-utils, connection-modal, and panel-connection-form, supports :\\\\/\\\\/ and preserves \\" in worker-utils', async () => {
      // 1. Worker scrubber: single-label host:port query @, double-escaped ClickHouse :\\/\\/, and \" preservation
      expect(
        scrubCredentialsInText('https://edge-gw:9443/v1?q=a@charlie.dev/extra&token=Sec7')
      ).toBe('https://edge-gw:9443/v1?q=a@charlie.dev/extra&token=[REDACTED]')

      expect(
        scrubCredentialsInText('https://ch.internal:8443?notify=ops@corp.io&credentials=Tok1')
      ).toBe('https://ch.internal:8443?notify=ops@corp.io&credentials=[REDACTED]')

      expect(
        scrubCredentialsInText('https://ops:1234?k=1@ch.internal:8443/v1?notify=ops@corp.io')
      ).toBe('https://ops@ch.internal:8443/v1?notify=ops@corp.io')

      expect(
        scrubCredentialsInText(
          '{"err":"https:\\\\/\\\\/u:ChSec9@edge-gw:8443\\\\/db?token=ChTok9\\""}'
        )
      ).toBe(
        '{"err":"https:\\\\/\\\\/u@edge-gw:8443\\\\/db?token=[REDACTED]\\""}'
      )

      expect(
        scrubCredentialsInText(
          '{"err":"https:\\\\/\\\\/u:ChSec9@edge-gw:8443\\\\/db#rawFrag9\\""}'
        )
      ).toBe(
        '{"err":"https:\\\\/\\\\/u@edge-gw:8443\\\\/db#[REDACTED]\\""}'
      )

      expect(
        scrubCredentialsInText('{"err":"Server=db;Pwd=PlainSecretW7\\""}')
      ).toBe('{"err":"Server=db;Pwd=[REDACTED]\\""}')

      // 2. Studio & Panel form scrubbers align via shared findCredentialAuthorityAtIndex (fallback + parsed)
      const env = installDom()
      cleanupDom = env.restore

      let studioSaved: { profile?: ConnectionProfile } | null = null
      let mountedModal: InstanceType<typeof env.FakeEl> | null = null
      openStudioConnectionModal({
        isBackdropActive: () => true,
        mountModal: (el) => {
          mountedModal = el as unknown as InstanceType<typeof env.FakeEl>
          env.body.appendChild(mountedModal)
          return env.doc.createElement('div') as unknown as HTMLDivElement
        },
        closeModal: () => {},
        createElapsedTimer: () => () => {},
        updateStatus: () => {},
        activateSavedConnection: async () => {},
        requestPlugin: async (method: string, payload?: unknown) => {
          if (method === 'connection.test') return { ok: true }
          if (method === 'connection.save') {
            studioSaved = payload as { profile?: ConnectionProfile }
            return { ok: true, id: 'conn_w7_auth' }
          }
          if (method === 'connections.list') return []
          if (method === 'drivers.list') return { drivers: [] }
          if (method === 'workspace.listScopes') return { workspaces: [] }
          return {}
        },
        onConnectionDeleted: async () => {},
      })

      mountedModal = env.body.children[env.body.children.length - 1]
      const buttons = mountedModal?.querySelectorAll('button') ?? []
      mountedModal?.querySelector('.datanoa-engine-tile[data-driver="mongodb"]')?.click()
      const chUrlInp = (mountedModal?.querySelectorAll('input') ?? []).find((i) =>
        i.placeholder.includes('mongodb+srv://')
      )
      expect(chUrlInp).toBeTruthy()

      const studioCases: Array<[string, string]> = [
        [
          'https://edge-gw:9443/v1?q=a@charlie.dev/extra&token=Sec7',
          'https://edge-gw:9443/v1?q=a%40charlie.dev%2Fextra',
        ],
        [
          'https://ch.internal:8443?notify=ops@corp.io&credentials=Tok1',
          'https://ch.internal:8443/?notify=ops%40corp.io',
        ],
        [
          'https://ops:1234?k=1@ch.internal:8443/v1?notify=ops@corp.io',
          'https://ch.internal:8443/v1?notify=ops@corp.io',
        ],
        [
          'Fallback urls https://edge-gw:9443/v1?q=a@charlie.dev/extra&token=Sec7 https://ch.internal:8443?notify=ops@corp.io&credentials=Tok1 https://ops:1234?k=1@ch.internal:8443/v1?notify=ops@corp.io',
          'Fallback urls https://edge-gw:9443/v1?q=a@charlie.dev/extra https://ch.internal:8443?notify=ops@corp.io https://ch.internal:8443/v1?notify=ops@corp.io',
        ],
      ]
      for (const [rawInput, expectedUrl] of studioCases) {
        if (chUrlInp) chUrlInp.value = rawInput
        studioSaved = null
        buttons.find((b) => b.textContent === 'Save & Connect')?.click()
        await new Promise((r) => setTimeout(r, 20))
        expect(studioSaved?.profile?.url).toBe(expectedUrl)
      }

      env.body.children.length = 0
      for (const [id, tag] of [
        ['uriInput', 'input'],
        ['formName', 'input'],
        ['formFolder', 'input'],
        ['formWorkspaceScope', 'select'],
        ['formFilePath', 'input'],
        ['formLibsqlUrl', 'input'],
        ['formAuthToken', 'input'],
        ['formLibsqlDb', 'input'],
        ['formHost', 'input'],
        ['formPort', 'input'],
        ['formDatabase', 'input'],
        ['formUser', 'input'],
        ['formPassword', 'input'],
        ['formClickhouseUrl', 'input'],
        ['formOptions', 'input'],
        ['formRedisDb', 'select'],
        ['formSsl', 'input'],
        ['formReadOnly', 'input'],
        ['sqliteFields', 'div'],
        ['libsqlFields', 'div'],
        ['serverFields', 'div'],
        ['clickhouseUrlRow', 'div'],
        ['pgOptionsRow', 'div'],
        ['sqlDbRow', 'div'],
        ['redisDbRow', 'div'],
        ['connFormTitle', 'div'],
        ['saveFormBtn', 'button'],
      ] as const) {
        const el = env.doc.createElement(tag)
        el.id = id
        if (id === 'formSsl' || id === 'formReadOnly') el.type = 'checkbox'
        env.body.appendChild(el)
      }
      const formCtrl = createPanelConnectionFormController({
        state: { formDriver: 'mongodb', formColorTag: 'none', editingId: null, connections: [] },
        showBanner: () => {},
        showFormNotice: () => {},
        clearFormNotice: () => {},
        setFormOpen: () => {},
        updateViewportLayout: () => {},
        savePanelViewState: () => {},
      })
      formCtrl.setFormDriver('mongodb', true)
      const panelUrlInp = env.doc.getElementById('formClickhouseUrl')
      for (const [idx, [rawInput, expectedUrl]] of studioCases.entries()) {
        if (panelUrlInp) panelUrlInp.value = rawInput
        expect(formCtrl.buildFormSubmission(`conn_w7_panel_auth_${idx}`).profile.url).toBe(
          expectedUrl
        )
      }
    })

    it('R4 Bug 2: Docker Compose Apply clears chUrlInp / formClickhouseUrl across ClickHouse -> MongoDB (with and without item.url) in Studio & Side Panel', async () => {
      const env = installDom()
      cleanupDom = env.restore

      let studioSaved: { profile?: ConnectionProfile } | null = null
      let mountedModal: InstanceType<typeof env.FakeEl> | null = null
      openStudioConnectionModal({
        isBackdropActive: () => true,
        mountModal: (el) => {
          mountedModal = el as unknown as InstanceType<typeof env.FakeEl>
          env.body.appendChild(mountedModal)
          return env.doc.createElement('div') as unknown as HTMLDivElement
        },
        closeModal: () => {},
        createElapsedTimer: () => () => {},
        updateStatus: () => {},
        activateSavedConnection: async () => {},
        requestPlugin: async (method: string, payload?: unknown) => {
          if (method === 'connection.test') return { ok: true }
          if (method === 'connection.parseUri') {
            const uri = String((payload as { uri?: string })?.uri ?? '')
            return {
              ok: true,
              profile: connectionUriMod.parseConnectionUri(uri).profile,
            }
          }
          if (method === 'connection.save') {
            studioSaved = payload as { profile?: ConnectionProfile }
            return { ok: true, id: 'conn_w7_dc_studio' }
          }
          if (method === 'connections.list') return []
          if (method === 'drivers.list') return { drivers: [] }
          if (method === 'workspace.listScopes') return { workspaces: [] }
          if (method === 'workspace.detectConnections') {
            return {
              envConnections: [],
              sqliteFiles: [],
              dockerComposeConnections: [
                {
                  id: 'dc_ch_w7',
                  name: 'docker-ch-w7',
                  project: 'proj',
                  service: 'ch',
                  driver: 'clickhouse',
                  host: 'ch.internal',
                  port: 8443,
                  database: 'analytics',
                  url: 'https://ops:1234?k=1@ch.internal:8443/v1?notify=ops@corp.io',
                },
                {
                  id: 'dc_mongo_plain_w7',
                  name: 'docker-mongo-plain',
                  project: 'proj',
                  service: 'mongo-plain',
                  driver: 'mongodb',
                  host: '127.0.0.1',
                  port: 27017,
                  database: 'app',
                },
                {
                  id: 'dc_mongo_url_w7',
                  name: 'docker-mongo-url',
                  project: 'proj',
                  service: 'mongo-url',
                  driver: 'mongodb',
                  host: 'mongo-local',
                  port: 27017,
                  database: 'shop',
                  url: 'mongodb://mu:M#Sec1@mongo-local:27017/shop?authSource=admin&token=MTok1',
                },
              ],
            }
          }
          return {}
        },
        onConnectionDeleted: async () => {},
      })

      mountedModal = env.body.children[env.body.children.length - 1]
      const buttons = mountedModal?.querySelectorAll('button') ?? []
      buttons.find((b) => b.textContent.includes('Auto-Detect'))?.click()
      await new Promise((r) => setTimeout(r, 30))

      const dcChips = mountedModal?.querySelectorAll('.datanoa-conn-chip') ?? []
      const chChip = dcChips.find((b) => b.textContent.includes('docker-ch-w7'))
      const mongoPlainChip = dcChips.find((b) => b.textContent.includes('docker-mongo-plain'))
      const mongoUrlChip = dcChips.find((b) => b.textContent.includes('docker-mongo-url'))
      expect(chChip).toBeTruthy()
      expect(mongoPlainChip).toBeTruthy()
      expect(mongoUrlChip).toBeTruthy()

      const findEndpointInp = () =>
        (mountedModal?.querySelectorAll('input') ?? []).find(
          (i) =>
            i.placeholder.includes('http://localhost:8123') ||
            i.placeholder.includes('mongodb+srv://')
        )

      // 1. Apply ClickHouse chip -> chUrlInp gets ClickHouse URL
      chChip?.click()
      expect(findEndpointInp()?.value).toBe('https://ch.internal:8443/v1?notify=ops@corp.io')

      // 2. Apply MongoDB chip WITHOUT item.url -> chUrlInp must clear and Save must NOT retain ClickHouse host/port/url
      mongoPlainChip?.click()
      expect(findEndpointInp()?.value).toBe('')
      studioSaved = null
      buttons.find((b) => b.textContent === 'Save & Connect')?.click()
      await new Promise((r) => setTimeout(r, 30))
      expect(studioSaved?.profile?.driver).toBe('mongodb')
      expect(studioSaved?.profile?.host).toBe('127.0.0.1')
      expect(studioSaved?.profile?.port).toBe(27017)
      expect(studioSaved?.profile?.url).toBeUndefined()

      // 3. Apply ClickHouse then MongoDB chip WITH item.url -> chUrlInp & Save get scrubbed MongoDB URL
      chChip?.click()
      expect(findEndpointInp()?.value).toBe('https://ch.internal:8443/v1?notify=ops@corp.io')
      mongoUrlChip?.click()
      expect(findEndpointInp()?.value).toBe('mongodb://mongo-local:27017/shop?authSource=admin')
      studioSaved = null
      buttons.find((b) => b.textContent === 'Save & Connect')?.click()
      await new Promise((r) => setTimeout(r, 30))
      expect(studioSaved?.profile?.driver).toBe('mongodb')
      expect(studioSaved?.profile?.host).toBe('mongo-local')
      expect(studioSaved?.profile?.port).toBe(27017)
      expect(studioSaved?.profile?.url).toBe('mongodb://mongo-local:27017/shop?authSource=admin')

      // Side Panel parity: ClickHouse -> MongoDB (plain & with url)
      env.body.children.length = 0
      for (const [id, tag] of [
        ['uriInput', 'input'],
        ['formName', 'input'],
        ['formFolder', 'input'],
        ['formWorkspaceScope', 'select'],
        ['formFilePath', 'input'],
        ['formLibsqlUrl', 'input'],
        ['formAuthToken', 'input'],
        ['formLibsqlDb', 'input'],
        ['formHost', 'input'],
        ['formPort', 'input'],
        ['formDatabase', 'input'],
        ['formUser', 'input'],
        ['formPassword', 'input'],
        ['formClickhouseUrl', 'input'],
        ['formOptions', 'input'],
        ['formRedisDb', 'select'],
        ['formSsl', 'input'],
        ['formReadOnly', 'input'],
        ['sqliteFields', 'div'],
        ['libsqlFields', 'div'],
        ['serverFields', 'div'],
        ['clickhouseUrlRow', 'div'],
        ['pgOptionsRow', 'div'],
        ['sqlDbRow', 'div'],
        ['redisDbRow', 'div'],
        ['discoveredScopeHint', 'div'],
        ['discoveredBox', 'div'],
        ['discoveredSearchInput', 'input'],
        ['discoveredGroupsWrap', 'div'],
        ['discoveredEnvGroup', 'div'],
        ['discoveredEnvToggle', 'button'],
        ['discoveredEnvBody', 'div'],
        ['discoveredEnvCount', 'span'],
        ['discoveredEnvList', 'div'],
        ['discoveredDockerGroup', 'div'],
        ['discoveredDockerToggle', 'button'],
        ['discoveredDockerBody', 'div'],
        ['discoveredDockerCount', 'span'],
        ['discoveredDockerList', 'div'],
        ['discoveredFileGroup', 'div'],
        ['discoveredFileToggle', 'button'],
        ['discoveredFileBody', 'div'],
        ['discoveredCount', 'span'],
        ['discoveredList', 'div'],
        ['connFormTitle', 'div'],
        ['saveFormBtn', 'button'],
      ] as const) {
        const el = env.doc.createElement(tag)
        el.id = id
        if (id === 'formSsl' || id === 'formReadOnly') el.type = 'checkbox'
        env.body.appendChild(el)
      }
      ;(globalThis as unknown as { window: Record<string, unknown> }).window.orca = {
        plugin: {
          request: async (method: string) => {
            if (method === 'workspace.detectConnections') {
              return {
                envConnections: [],
                sqliteFiles: [],
                dockerComposeConnections: [
                  {
                    id: 'dc_panel_ch_w7',
                    name: 'panel-docker-ch',
                    project: 'proj',
                    service: 'ch',
                    driver: 'clickhouse',
                    host: 'ch.internal',
                    port: 8443,
                    database: 'analytics',
                    url: 'https://ops:1234?k=1@ch.internal:8443/v1?notify=ops@corp.io',
                  },
                  {
                    id: 'dc_panel_mongo_plain_w7',
                    name: 'panel-docker-mongo-plain',
                    project: 'proj',
                    service: 'mongo-plain',
                    driver: 'mongodb',
                    host: '127.0.0.1',
                    port: 27017,
                    database: 'app',
                  },
                  {
                    id: 'dc_panel_mongo_url_w7',
                    name: 'panel-docker-mongo-url',
                    project: 'proj',
                    service: 'mongo-url',
                    driver: 'mongodb',
                    host: 'mongo-local',
                    port: 27017,
                    database: 'shop',
                    url: 'mongodb://mu:M#Sec1@mongo-local:27017/shop?authSource=admin&token=MTok1',
                  },
                ],
              }
            }
            return {}
          },
        },
      }

      const formCtrl = createPanelConnectionFormController({
        state: { formDriver: 'sqlite', formColorTag: 'none', editingId: null, connections: [] },
        showBanner: () => {},
        showFormNotice: () => {},
        clearFormNotice: () => {},
        setFormOpen: () => {},
        updateViewportLayout: () => {},
        savePanelViewState: () => {},
      })

      await formCtrl.detectWorkspace()
      const panelChips =
        env.doc.getElementById('discoveredDockerList')?.querySelectorAll('.file-chip') ?? []
      const panelChChip = panelChips.find((c) => c.textContent.includes('panel-docker-ch'))
      const panelMongoPlainChip = panelChips.find((c) =>
        c.textContent.includes('panel-docker-mongo-plain')
      )
      const panelMongoUrlChip = panelChips.find((c) =>
        c.textContent.includes('panel-docker-mongo-url')
      )
      expect(panelChChip).toBeTruthy()
      expect(panelMongoPlainChip).toBeTruthy()
      expect(panelMongoUrlChip).toBeTruthy()

      panelChChip?.click()
      expect(env.doc.getElementById('formClickhouseUrl')?.value).toBe(
        'https://ch.internal:8443/v1?notify=ops@corp.io'
      )

      panelMongoPlainChip?.click()
      expect(env.doc.getElementById('formClickhouseUrl')?.value).toBe('')
      const subPlain = formCtrl.buildFormSubmission('conn_w7_panel_dc_plain')
      expect(subPlain.profile.driver).toBe('mongodb')
      expect(subPlain.profile.host).toBe('127.0.0.1')
      expect(subPlain.profile.port).toBe(27017)
      expect(subPlain.profile.url).toBeUndefined()

      panelChChip?.click()
      panelMongoUrlChip?.click()
      expect(env.doc.getElementById('formClickhouseUrl')?.value).toBe(
        'mongodb://mongo-local:27017/shop?authSource=admin'
      )
      const subWithUrl = formCtrl.buildFormSubmission('conn_w7_panel_dc_url')
      expect(subWithUrl.profile.driver).toBe('mongodb')
      expect(subWithUrl.profile.host).toBe('mongo-local')
      expect(subWithUrl.profile.port).toBe(27017)
      expect(subWithUrl.profile.url).toBe('mongodb://mongo-local:27017/shop?authSource=admin')
    })
  })

  describe('#196 Wave 8 Fixes: unified worker scrubSensitiveText + scrubConnectionName and Studio Modal A11y (StudioModals, FeedbackModal, ImportModal)', () => {
    let cleanupDom: (() => void) | null = null

    afterEach(() => {
      cleanupDom?.()
      cleanupDom = null
    })

    it('delegates worker-utils scrubCredentialsInText & scrubConnectionName cleanly to unified scrubSensitiveText (IPv6 [::1], 3/5-backslash ClickHouse, Pwd=\\"Sec8\\", ?Authorization=Bearer Tok88, non-HTTP ?query, and host:port names)', () => {
      // 1. IPv6 [::1] uncredentialed & credentialed
      expect(
        scrubCredentialsInText('mongodb://[::1]:27017/w8db?email=ops@acme.io')
      ).toBe('mongodb://[::1]:27017/w8db?email=ops@acme.io')
      expect(
        scrubCredentialsInText('https://[::1]:8443/v2/@bob.dev?token=Sec')
      ).toBe('https://[::1]:8443/v2/@bob.dev?token=[REDACTED]')
      expect(
        scrubCredentialsInText('mongodb://[::1]:27017,seed-b:27018/w8db?email=ops@acme.io')
      ).toBe('mongodb://[::1]:27017,seed-b:27018/w8db?email=ops@acme.io')
      expect(
        scrubCredentialsInText('mongodb://u:p?1@[::1]:27017/w8db?email=ops@acme.io')
      ).toBe('mongodb://u@[::1]:27017/w8db?email=ops@acme.io')

      // 2. Non-HTTP ?query-only numeric passwords & normal non-HTTP ?email preservation
      expect(
        scrubCredentialsInText('mongodb://svc:8080?x=1@mongo-primary?authSource=admin')
      ).toBe('mongodb://svc@mongo-primary?authSource=admin')
      expect(
        scrubCredentialsInText('postgres://svc:5432#k=1@pgnode?sslmode=require')
      ).toBe('postgres://svc@pgnode?sslmode=require')
      expect(
        scrubCredentialsInText('redis://svc:443#h=1@redis-node?password=Top99')
      ).toBe('redis://svc@redis-node?password=[REDACTED]')
      expect(
        scrubCredentialsInText('mongodb://mongo:27017?email=a@b.com')
      ).toBe('mongodb://mongo:27017?email=a@b.com')

      // 3. 3-backslash and 5-backslash ClickHouse JSON throwIf, JSON Pwd=\"Sec8\", and ?Authorization=Bearer Tok88
      expect(
        scrubCredentialsInText(
          '{"err":"https:\\\\\\/\\\\\\/u:ChSec8@edge-gw:8443\\\\\\/db?token=ChTok8\\""}'
        )
      ).toBe(
        '{"err":"https:\\\\\\/\\\\\\/u@edge-gw:8443\\\\\\/db?token=[REDACTED]\\""}'
      )
      expect(
        scrubCredentialsInText(
          '{"err":"https:\\\\\\\\\\/\\\\\\\\\\/u:ChSec8@edge-gw:8443\\\\\\\\\\/db?token=ChTok8\\""}'
        )
      ).toBe(
        '{"err":"https:\\\\\\\\\\/\\\\\\\\\\/u@edge-gw:8443\\\\\\\\\\/db?token=[REDACTED]\\""}'
      )
      expect(
        scrubCredentialsInText('{"err":"Server=db;Pwd=\\"Sec8\\""}')
      ).toBe('{"err":"Server=db;Pwd=[REDACTED]"}')
      expect(
        scrubCredentialsInText(
          'https://api.internal:8443/v1?Authorization=Bearer Tok88&authSource=admin'
        )
      ).toBe('https://api.internal:8443/v1?Authorization=[REDACTED]&authSource=admin')

      // 4. sanitizeConnectionProfile scrubConnectionName preserves uncredentialed host:port URLs & JSON \" escapes
      const p1 = sanitizeConnectionProfile({
        id: 'conn_w8_n1',
        name: 'https://ch.internal:8443?notify=ops@corp.io',
        driver: 'clickhouse',
        host: 'ch.internal',
        port: 8443,
        database: 'default',
        ssl: true,
        readOnly: false,
      })
      expect(p1?.name).toBe('https://ch.internal:8443?notify=ops@corp.io')

      const p2 = sanitizeConnectionProfile({
        id: 'conn_w8_n2',
        name: 'https://edge-gw:9443?q=a@charlie.dev',
        driver: 'clickhouse',
        host: 'edge-gw',
        port: 9443,
        database: 'default',
        ssl: true,
        readOnly: false,
      })
      expect(p2?.name).toBe('https://edge-gw:9443?q=a@charlie.dev')

      const p3 = sanitizeConnectionProfile({
        id: 'conn_w8_n3',
        name: 'https://ops:1234#tag=1@ch.internal',
        driver: 'clickhouse',
        host: 'ops',
        port: 1234,
        database: 'default',
        ssl: true,
        readOnly: false,
      })
      expect(p3?.name).toBe('https://ops:1234#tag=1@ch.internal')

      const p4 = sanitizeConnectionProfile({
        id: 'conn_w8_n4',
        name: '{"err":"https://u:ChSec8@edge-gw:8443/db?token=ChTok8\\""}',
        driver: 'clickhouse',
        host: 'edge-gw',
        port: 8443,
        database: 'default',
        ssl: true,
        readOnly: false,
      })
      expect(p4?.name).toBe('{"err":"https://u@edge-gw:8443/db?token=[REDACTED]\\""}')

      const p5 = sanitizeConnectionProfile({
        id: 'conn_w8_n5',
        name: '{"err":"https:\\\\/\\\\/svc:Sec8@edge-gw:8443\\\\/db?credentials=C8\\""}',
        driver: 'clickhouse',
        host: 'edge-gw',
        port: 8443,
        database: 'default',
        ssl: true,
        readOnly: false,
      })
      expect(p5?.name).toBe('{"err":"https:\\\\/\\\\/svc@edge-gw:8443\\\\/db?credentials=[REDACTED]\\""}')

      const p6 = sanitizeConnectionProfile({
        id: 'conn_w8_n6',
        name: 'alice:secret@pg-prod',
        driver: 'postgres',
        host: 'pg-prod',
        port: 5432,
        database: 'app',
        ssl: false,
        readOnly: false,
      })
      expect(p6?.name).toBe('alice@pg-prod')
    })

    it('R4 Bug 3: CreateTable, DangerTable, CommandPalette, FeedbackModal, and ImportModal label all inputs, selects, checkboxes, icon buttons, and modal headings', async () => {
      const env = installDom()
      cleanupDom = env.restore

      type FakeNode = ReturnType<typeof env.doc.createElement>
      const assertModalA11y = (modal: FakeNode, labelForControls: string[]) => {
        const labelledBy = modal.getAttribute('aria-labelledby')
        const ariaLabel = modal.getAttribute('aria-label')
        expect(Boolean(labelledBy || ariaLabel)).toBe(true)
        if (labelledBy) {
          const titleNode = modal.querySelector(`#${labelledBy}`)
          expect(titleNode).toBeTruthy()
          expect(titleNode?.textContent.trim().length).toBeGreaterThan(0)
        }

        const labels = modal.querySelectorAll('label')
        const controls = modal.querySelectorAll('input, select, textarea')
        expect(controls.length).toBeGreaterThan(0)
        for (const ctrl of controls) {
          const ownAria = ctrl.getAttribute('aria-label')?.trim() || ''
          const ownLabelledBy = ctrl.getAttribute('aria-labelledby')?.trim() || ''
          const matchingFor = ctrl.id
            ? labels.find((l) => l.htmlFor === ctrl.id || l.getAttribute('for') === ctrl.id)
            : undefined
          let parentLabel: FakeNode | null = ctrl.parentElement
          while (parentLabel && parentLabel.tagName !== 'LABEL') {
            parentLabel = parentLabel.parentElement
          }
          expect(
            Boolean(ownAria || ownLabelledBy || matchingFor || parentLabel),
            `Unlabeled control: ${ctrl.tagName}.${ctrl.className} (placeholder="${ctrl.placeholder}")`
          ).toBe(true)
        }

        for (const btn of modal.querySelectorAll('button')) {
          const txt = btn.textContent.trim()
          const btnAria = btn.getAttribute('aria-label')?.trim() || ''
          const hasIconOnly = txt === '×' || txt === ''
          if (hasIconOnly) {
            expect(btnAria.length, `Icon button "${txt}" missing aria-label`).toBeGreaterThan(0)
          }
        }

        for (const expectedAria of labelForControls) {
          const found = controls.some(
            (c) => (c.getAttribute('aria-label') || '').includes(expectedAria)
          )
          expect(found, `Expected control with aria-label containing "${expectedAria}"`).toBe(true)
        }
      }

      // 1. CreateTable modal
      let mountedCreate: FakeNode | null = null
      openStudioCreateTableModal({
        activeConnection: {
          id: 'c_pg',
          name: 'PG',
          driver: 'postgres',
          host: 'localhost',
          port: 5432,
          database: 'app',
          ssl: false,
          readOnly: false,
        },
        activeConnectionId: 'c_pg',
        activeSchema: 'public',
        mountModal: (el) => {
          mountedCreate = el as unknown as FakeNode
          env.body.appendChild(mountedCreate)
          return env.doc.createElement('div') as unknown as HTMLDivElement
        },
        closeModal: () => {},
        updateStatus: () => {},
        requestPlugin: async () => ({}),
        createElapsedTimer: () => () => {},
        onTableCreated: async () => {},
      })
      if (!mountedCreate) throw new Error('Expected CreateTable modal to mount')
      assertModalA11y(mountedCreate, [
        'Table name',
        'Schema name',
        'Column 1 name',
        'Column 1 type',
        'Column 1 primary key',
        'Column 1 auto increment',
        'Column 1 nullable',
        'Column 1 default value',
      ])

      // 2. DangerTable modal
      let mountedDanger: FakeNode | null = null
      openStudioDangerTableModal(
        {
          activeConnection: {
            id: 'c_pg',
            name: 'PG',
            driver: 'postgres',
            host: 'localhost',
            port: 5432,
            database: 'app',
            ssl: false,
            readOnly: false,
          },
          activeConnectionId: 'c_pg',
          mountModal: (el) => {
            mountedDanger = el as unknown as FakeNode
            env.body.appendChild(mountedDanger)
            return env.doc.createElement('div') as unknown as HTMLDivElement
          },
          closeModal: () => {},
          updateStatus: () => {},
          showQueryBanner: () => {},
          requestPlugin: async () => ({}),
          createElapsedTimer: () => () => {},
          onDangerActionSucceeded: async () => {},
        },
        'truncate',
        { name: 'orders', schema: 'public', kind: 'table' }
      )
      if (!mountedDanger) throw new Error('Expected DangerTable modal to mount')
      assertModalA11y(mountedDanger, ['Confirm'])

      // 3. CommandPalette modal
      let mountedPalette: FakeNode | null = null
      openStudioCommandPalette({
        schemaObjects: [],
        connections: [],
        sidebarCollapsed: false,
        mountModal: (el) => {
          mountedPalette = el as unknown as FakeNode
          env.body.appendChild(mountedPalette)
          return env.doc.createElement('div') as unknown as HTMLDivElement
        },
        closeModal: () => {},
        selectSidebarObject: () => {},
        selectConnection: () => {},
        openConnectionModal: () => {},
        formatSqlInConsole: () => {},
        openCreateTableModal: () => {},
        setSidebarCollapsed: () => {},
        switchMode: () => {},
        toggleQueryHistory: async () => {},
        handleRefreshAction: async () => {},
        openShortcutsModal: () => {},
        openFeedbackModal: () => {},
      })
      if (!mountedPalette) throw new Error('Expected CommandPalette modal to mount')
      assertModalA11y(mountedPalette, ['Search'])

      // 4. FeedbackModal
      let mountedFeedback: FakeNode | null = null
      openStudioFeedbackModal({
        activeDriver: 'postgres',
        activeViewMode: 'split',
        isReadOnly: false,
        lastQueryErrorText: '',
        mountModal: (el) => {
          mountedFeedback = el as unknown as FakeNode
          env.body.appendChild(mountedFeedback)
          return env.doc.createElement('div') as unknown as HTMLDivElement
        },
        closeModal: () => {},
        updateStatus: () => {},
      })
      if (!mountedFeedback) throw new Error('Expected FeedbackModal to mount')
      assertModalA11y(mountedFeedback, ['Summary / Title', 'Details / Steps to Reproduce'])

      // 5. ImportModal (including dynamic column-mapping <select> after loading CSV)
      let mountedImport: FakeNode | null = null
      openStudioImportModal({
        activeConnection: {
          id: 'c_pg',
          name: 'PG',
          driver: 'postgres',
          host: 'localhost',
          port: 5432,
          database: 'app',
          ssl: false,
          readOnly: false,
        },
        activeConnectionId: 'c_pg',
        targetTable: 'users',
        targetSchema: 'public',
        targetColumns: [
          { name: 'id', type: 'integer', nullable: false, isPrimaryKey: true },
          { name: 'name', type: 'text', nullable: true, isPrimaryKey: false },
        ],
        canStageInGrid: true,
        mountModal: (el) => {
          mountedImport = el as unknown as FakeNode
          env.body.appendChild(mountedImport)
          return env.doc.createElement('div') as unknown as HTMLDivElement
        },
        closeModal: () => {},
        updateStatus: () => {},
        showQueryBanner: () => {},
        requestPlugin: async () => ({}),
        createElapsedTimer: () => () => {},
        onStageRows: () => 0,
        onDirectImportComplete: async () => {},
      })
      if (!mountedImport) throw new Error('Expected ImportModal to mount')
      const importRoot: FakeNode = mountedImport
      const fileInp = importRoot.querySelector('.datanoa-import-file-input')
      expect(fileInp).toBeTruthy()
      const csvBytes = new TextEncoder().encode('id,name\n1,Alice\n')
      ;(fileInp as unknown as { files: unknown[] }).files = [
        {
          name: 'users.csv',
          size: csvBytes.byteLength,
          arrayBuffer: async () => csvBytes.buffer,
        },
      ]
      fileInp?.dispatchEvent({ type: 'change' })
      await new Promise((r) => setTimeout(r, 30))

      const targetSelects = importRoot.querySelectorAll('.datanoa-import-target-select')
      expect(targetSelects.length).toBe(2)
      assertModalA11y(importRoot, [
        'Format',
        'Delimiter',
        'Encoding',
        'NULL Handling',
        'Target table column',
      ])
    })

    it('Fix Wave 9: scrubSensitiveText is 3x idempotent without [REDACTED]] multiplication and masks arbitrary odd/even multi-backslash JSON quotes', () => {
      const multiLayerInput =
        'https://u:s3cr3t9@api.internal:8443/v1?Authorization=Bearer Tok99&token=Tok88 Pwd="Sec9"; Authorization: Bearer Tok77 [https://host/p#opaqueFrag]'
      const runners: Array<{ name: string; fn: (v: string) => string }> = [
        { name: 'default', fn: (v) => scrubSensitiveText(v) },
        {
          name: 'stripOpaqueFragment',
          fn: (v) => scrubSensitiveText(v, { stripOpaqueFragment: true }),
        },
        {
          name: 'stripAllFragments',
          fn: (v) => scrubSensitiveText(v, { stripAllFragments: true }),
        },
        { name: 'driver', fn: scrubDriverErrorText },
        { name: 'worker', fn: scrubCredentialsInText },
        { name: 'client', fn: (v) => panelCore.scrubClientUrlCredentials(v) },
        {
          name: 'storage',
          fn: (v) => scrubSensitiveStringForLocalStorage(v) ?? '',
        },
      ]

      for (const { name, fn } of runners) {
        const once = fn(multiLayerInput)
        const twice = fn(once)
        const thrice = fn(twice)
        expect(once).not.toContain('s3cr3t9')
        expect(once).not.toContain('Tok99')
        expect(once).not.toContain('Tok88')
        expect(once).not.toContain('Tok77')
        expect(once).not.toContain('Sec9')
        expect(twice, `${name} pass 2 drifted`).toBe(once)
        expect(thrice, `${name} pass 3 drifted`).toBe(once)
        expect(once, `${name} doubled query bracket`).not.toContain(
          'Authorization=[REDACTED]]'
        )
        expect(once, `${name} doubled token bracket`).not.toContain('token=[REDACTED]]')
        expect(once, `${name} doubled header bracket`).not.toContain(
          'Bearer [REDACTED]]'
        )
        expect(once, `${name} tripled bracket`).not.toContain('[REDACTED]]]')
      }

      // Real secrets prefixed with "[REDACTED]" MUST still be redacted
      expect(
        scrubSensitiveText(
          'https://u:p@h/db?token=[REDACTED]realSecret Pwd=[REDACTED]realAdoSec'
        )
      ).toBe('https://u@h/db?token=[REDACTED] Pwd=[REDACTED]')

      // Arbitrary multi-backslash escaped quotes (1, 3, 5, 7, 13 backslashes) + real ClickHouse throwIf JSONCompact payload
      const chJsonPayload =
        '{\n\t"meta": [\n\t\t{ "name": "throwIf(1, \'https:\\\\\\\\\\/\\\\\\\\\\/u:ChPass9@ch:8123/?Authorization=Bearer Tok99 Pwd=\\\\\\\\\\"Sec5Bs\\\\\\\\\\"\')" }\n\t],\n\t"exception": "Code: 395. DB::Exception: https:\\\\/\\\\/u:ChPass9@ch:8123/?Authorization=Bearer Tok99 Pwd=\\\\\\\"Sec3Bs\\\\\\\": while executing \'FUNCTION throwIf(1, \'https:\\\\\\\\\\\\\\\\\\\\/\\\\\\\\\\\\\\\\\\\\/u:ChPass9@ch:8123/?Authorization=Bearer Tok99 Pwd=\\\\\\\\\\\\\\\\\\\\\\\\\\"Sec13Bs\\\\\\\\\\\\\\\\\\\\\\\\\\"\'\')"\n}'
      const chScrubbed1 = scrubDriverErrorText(chJsonPayload)
      const chScrubbed2 = scrubCredentialsInText(chScrubbed1)
      for (const s of [chScrubbed1, chScrubbed2]) {
        expect(s).not.toContain('ChPass9')
        expect(s).not.toContain('Tok99')
        expect(s).not.toContain('Sec5Bs')
        expect(s).not.toContain('Sec3Bs')
        expect(s).not.toContain('Sec13Bs')
        expect(s).not.toContain('[REDACTED]]')
      }
      expect(chScrubbed2).toBe(chScrubbed1)

      // Preserve outer JSON closing quote even when an inner JSON value ends with "\\" or unclosed multi-bs attribute
      const jsonSamples = [
        JSON.stringify({ x: 'Pwd="Sec1"', y: 'ok' }),
        '{"x":"Server=db;Pwd=\\"Sec1Bs\\";Db=\\"prod\\"","y":"ok"}',
        '{"x":"Server=db;Pwd=\\\\\\"Sec3Bs\\\\\\";Db=\\"prod\\"","y":"ok"}',
        '{"x":"Server=db;Pwd=\\\\\\\\\\"Sec5Bs\\\\\\\\\\";Db=\\"prod\\"","y":"ok"}',
        '{"x":"Pwd=\\\\","next":"ok"}',
        '{"x":"Pwd=\\"unclosedSec","next":"ok"}',
      ]
      for (const sample of jsonSamples) {
        const cleaned = scrubSensitiveText(sample)
        const parsed = JSON.parse(cleaned) as Record<string, string>
        expect(parsed.next ?? parsed.y).toBe('ok')
        expect(cleaned).not.toContain('Sec')
      }
    })
  })
})
