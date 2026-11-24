import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TransactionToolbarController } from '../src/editor/transaction-toolbar'

class MiniClassList {
  private readonly set = new Set<string>()
  constructor(private readonly el: MiniElement) {}
  add(...names: string[]) {
    for (const n of names) {
      for (const p of String(n).split(/\s+/).filter(Boolean)) this.set.add(p)
    }
    this.el._syncClass()
  }
  remove(...names: string[]) {
    for (const n of names) {
      for (const p of String(n).split(/\s+/).filter(Boolean)) this.set.delete(p)
    }
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
  _set(val: string) {
    this.set.clear()
    this.add(val)
  }
  toString() {
    return Array.from(this.set).join(' ')
  }
}

class MiniElement {
  tagName: string
  children: MiniElement[] = []
  parentElement: MiniElement | null = null
  style: Record<string, string> = {}
  attributes = new Map<string, string>()
  listeners = new Map<string, Set<() => void>>()
  classList: MiniClassList
  type = ''
  title = ''
  disabled = false
  private _text = ''

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase()
    this.classList = new MiniClassList(this)
  }

  get className() {
    return this.classList.toString()
  }
  set className(v: string) {
    this.classList._set(v)
  }
  _syncClass() {
    this.attributes.set('class', this.className)
  }
  get textContent(): string {
    if (this.children.length === 0) return this._text
    return this._text + this.children.map((c) => c.textContent).join('')
  }
  set textContent(v: string) {
    this._text = String(v ?? '')
    this.children = []
  }
  setAttribute(k: string, v: string) {
    this.attributes.set(k, String(v))
    if (k === 'class') this.classList._set(v)
  }
  getAttribute(k: string): string | null {
    return this.attributes.get(k) ?? null
  }
  appendChild<T extends MiniElement>(child: T): T {
    child.parentElement = this
    this.children.push(child)
    return child
  }
  append(...nodes: MiniElement[]) {
    for (const n of nodes) this.appendChild(n)
  }
  addEventListener(type: string, fn: () => void) {
    let set = this.listeners.get(type)
    if (!set) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(fn)
  }
  removeEventListener(type: string, fn: () => void) {
    this.listeners.get(type)?.delete(fn)
  }
  click() {
    if (this.disabled) return
    for (const fn of Array.from(this.listeners.get('click') || [])) {
      fn()
    }
  }
  querySelector(selector: string): MiniElement | null {
    return this.querySelectorAll(selector)[0] ?? null
  }
  querySelectorAll(selector: string): MiniElement[] {
    const out: MiniElement[] = []
    const cls = selector.startsWith('.') ? selector.slice(1) : null
    const visit = (node: MiniElement) => {
      for (const c of node.children) {
        if (cls ? c.classList.contains(cls) : c.tagName.toLowerCase() === selector.toLowerCase()) {
          out.push(c)
        }
        visit(c)
      }
    }
    visit(this)
    return out
  }
}

const g = globalThis as Record<string, unknown>
let prevDocument: unknown = undefined
let hasPrevDocument = false

function setupMiniDocument() {
  if (!hasPrevDocument) {
    hasPrevDocument = 'document' in g
    prevDocument = g.document
  }
  g.document = {
    createElement: (tag: string) => new MiniElement(tag),
    createElementNS: (_ns: string, tag: string) => new MiniElement(tag),
  }
}

afterEach(() => {
  if (hasPrevDocument) {
    g.document = prevDocument
  } else {
    delete g.document
  }
  hasPrevDocument = false
  prevDocument = undefined
})

function createControllerHarness() {
  setupMiniDocument()
  let txState = { supported: true, autoCommit: true, active: false, statementCount: 0 }
  const rpcCalls: Array<{ method: string; payload?: Record<string, unknown> }> = []

  const ctrl = new TransactionToolbarController({
    getActiveConnectionId: () => 'conn_1',
    getActiveConnection: () => ({ id: 'conn_1', name: 'main', driver: 'postgres', database: 'app' }),
    isReadOnly: () => false,
    isQueryRunning: () => false,
    isShowingSqlResult: () => false,
    getActiveTable: () => null,
    getCurrentPage: () => 1,
    requestPlugin: async <T>(method: string, payload?: Record<string, unknown>) => {
      rpcCalls.push({ method, payload })
      if (method === 'tx.status') return txState as unknown as T
      if (method === 'tx.setAutoCommit') {
        txState = { ...txState, autoCommit: Boolean(payload?.enabled) }
        return txState as unknown as T
      }
      if (method === 'tx.begin') {
        txState = { ...txState, active: true, autoCommit: false }
        return txState as unknown as T
      }
      if (method === 'tx.commit' || method === 'tx.rollback') {
        txState = { ...txState, active: false, statementCount: 0 }
        return txState as unknown as T
      }
      return txState as unknown as T
    },
    reloadTableData: () => {},
    showErrorBanner: () => {},
    updateStatus: () => {},
  })

  const parent = new MiniElement('div')
  ctrl.mount(parent as unknown as HTMLElement)
  return { ctrl, parent, rpcCalls }
}

describe('Transaction toolbar & Studio Find/Replace CSS invariants', () => {
  it('starts collapsed showing 1 toggle button, expands on click, stays open across TX actions, and collapses on second click', async () => {
    const { ctrl, parent, rpcCalls } = createControllerHarness()
    await ctrl.refreshState('conn_1')

    const group = parent.querySelector('.datanoa-tx-group')
    expect(group, 'TX group should mount').toBeTruthy()
    if (!group) throw new Error('TX group missing')

    const toggleBtn = parent.querySelector('.datanoa-tx-toggle-btn')
    expect(toggleBtn, 'Single TX toggle button should mount').toBeTruthy()
    if (!toggleBtn) throw new Error('TX toggle button missing')

    const chevSvg = toggleBtn.querySelector('svg')
    expect(
      chevSvg,
      'TX toggle chevron should render an optically centered SVG icon instead of a baseline-shifted text glyph'
    ).toBeTruthy()

    const tray = parent.querySelector('.datanoa-tx-tray')
    expect(tray, 'Collapsible TX tray should mount').toBeTruthy()
    if (!tray) throw new Error('TX tray missing')

    // Initially collapsed: only 1 button visible, tray hidden
    expect(group.classList.contains('is-expanded')).toBe(false)
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('false')
    expect(tray.getAttribute('aria-hidden')).toBe('true')

    // First click expands tray
    toggleBtn.click()
    expect(group.classList.contains('is-expanded')).toBe(true)
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('true')
    expect(tray.getAttribute('aria-hidden')).toBe('false')
    expect(
      rpcCalls.some((c) => c.method === 'tx.setAutoCommit'),
      'Expanding tray should not mutate DB autoCommit'
    ).toBe(false)

    // Clicking actions inside the expanded tray stays expanded
    const autoCommitBtn = tray.querySelector('.datanoa-tx-autocommit-btn')
    const beginBtn = tray.querySelector('.datanoa-tx-begin-btn')
    const commitBtn = tray.querySelector('.datanoa-tx-commit-btn')
    expect(autoCommitBtn).toBeTruthy()
    expect(beginBtn).toBeTruthy()
    expect(commitBtn).toBeTruthy()
    if (!autoCommitBtn || !beginBtn || !commitBtn) throw new Error('TX action buttons missing')

    autoCommitBtn.click()
    await new Promise((r) => setTimeout(r, 10))
    expect(group.classList.contains('is-expanded')).toBe(true)

    beginBtn.click()
    await new Promise((r) => setTimeout(r, 10))
    expect(group.classList.contains('is-expanded')).toBe(true)

    // Even while TX is active, clicking toggle button collapses back to 1 button
    toggleBtn.click()
    expect(group.classList.contains('is-expanded')).toBe(false)
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('false')
    expect(tray.getAttribute('aria-hidden')).toBe('true')

    // Clicking toggle button again re-expands and COMMIT remains available
    toggleBtn.click()
    expect(group.classList.contains('is-expanded')).toBe(true)
    expect(commitBtn.disabled).toBe(false)
    commitBtn.click()
    await new Promise((r) => setTimeout(r, 10))
    expect(group.classList.contains('is-expanded')).toBe(true)

    ctrl.destroy()
  })

  it('eliminates crooked layout, double focus ring, and mismatched button height in Studio Find/Replace & SQL toolbar CSS', () => {
    const themeSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'editor', 'theme.ts'), 'utf8')
    const panelCss = fs.readFileSync(path.join(process.cwd(), 'src', 'panel', 'panel.css'), 'utf8')
    const studioDomSrc = fs.readFileSync(
      path.join(process.cwd(), 'src', 'editor', 'studio-dom.ts'),
      'utf8'
    )

    // Studio Find button should match toolbar button height (not shrunk via datanoa-btn-sm)
    expect(studioDomSrc).not.toMatch(/findSqlBtn\.className\s*=\s*'datanoa-btn datanoa-btn-sm'/)

    // Studio CodeMirror Find bar must avoid double border+outline focus halo and align close button + <br>
    expect(themeSrc).not.toMatch(/\.cm-textfield:focus-visible\s*\{[^}]*outline:\s*2px/)
    expect(themeSrc).toMatch(/\.cm-search\s+br\s*\{[^}]*display:\s*none/)
    expect(themeSrc).toMatch(/\.cm-search\s+\[name='close'\][^}]*position:\s*static/)
    expect(themeSrc).toMatch(/\.cm-search\s+input\[type='checkbox'\][^}]*appearance:\s*none/)
    expect(themeSrc).toMatch(/\.cm-search\s+\[name='prev'\][^}]*margin-left:\s*-1px/)
    expect(themeSrc).toMatch(/\.cm-search\s+label\s*\+\s*label[^}]*margin-left:\s*-1px/)

    // Side Panel CodeMirror Find bar should also style .cm-search consistently
    expect(panelCss).toMatch(/\.cm-search\b/)
    expect(panelCss).toMatch(/\.cm-search\s+\[name='prev'\][^}]*margin-left:\s*-1px/)

    // Selected table pill in topbar should use clear semantic accent color instead of faint neutral grey
    expect(themeSrc).toMatch(/\.datanoa-topbar-pill\.active[\s\S]*?var\(--info\)/)

    // Table topbar and SQL toolbar keep uniform --surface background with a crisp 28% hairline divider between rows
    expect(themeSrc).toMatch(
      /\.datanoa-table-topbar\s*\{[\s\S]*?background:\s*var\(--surface\)[\s\S]*?border-bottom:\s*1px solid color-mix\(in srgb,\s*var\(--text\)\s*28%,\s*var\(--bg\)\)/
    )
    expect(themeSrc).toMatch(/\.datanoa-sql-toolbar\s*\{[\s\S]*?background:\s*var\(--surface\)/)
  })
})
