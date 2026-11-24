import * as fs from 'node:fs'
import * as path from 'node:path'

const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])

const ENTITY_MAP: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  nbsp: '\u00a0',
}

export function decodeHtmlEntities(input: string): string {
  return String(input).replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z0-9]+);/g, (full, code: string) => {
    if (code in ENTITY_MAP) return ENTITY_MAP[code]
    if (code.startsWith('#x') || code.startsWith('#X')) {
      const cp = Number.parseInt(code.slice(2), 16)
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : full
    }
    if (code.startsWith('#')) {
      const cp = Number.parseInt(code.slice(1), 10)
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : full
    }
    return full
  })
}

export function escapeHtmlText(input: string): string {
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function escapeHtmlAttr(input: string): string {
  return escapeHtmlText(input).replace(/"/g, '&quot;')
}

function camelToKebab(prop: string): string {
  return prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)
}

function kebabToCamel(attr: string): string {
  return attr.replace(/-([a-z0-9])/g, (_m, c: string) => c.toUpperCase())
}

export interface EventListenerOptionsLike {
  capture?: boolean
  once?: boolean
  passive?: boolean
  signal?: { aborted: boolean; addEventListener?: (t: string, fn: () => void, o?: unknown) => void }
}

export interface RegisteredListener {
  fn: (event: FakeEvent) => void
  capture: boolean
  once: boolean
}

export class FakeDataTransfer {
  private store = new Map<string, string>()
  dropEffect = 'none'
  effectAllowed = 'all'
  files: unknown[] = []
  items: unknown[] = []
  get types(): string[] {
    return Array.from(this.store.keys())
  }
  setData(type: string, value: string): void {
    this.store.set(type, String(value))
  }
  getData(type: string): string {
    return this.store.get(type) ?? ''
  }
  clearData(type?: string): void {
    if (type === undefined) this.store.clear()
    else this.store.delete(type)
  }
}

export class FakeEvent {
  type: string
  bubbles: boolean
  cancelable: boolean
  composed: boolean
  defaultPrevented = false
  cancelBubble = false
  immediateCancelBubble = false
  eventPhase = 0
  target: unknown = null
  currentTarget: unknown = null
  relatedTarget: unknown = null
  detail: unknown = undefined
  timeStamp = Date.now()
  isTrusted = true

  constructor(type: string, init: Record<string, unknown> = {}) {
    this.type = String(type)
    this.bubbles = init.bubbles !== undefined ? Boolean(init.bubbles) : true
    this.cancelable = init.cancelable !== undefined ? Boolean(init.cancelable) : true
    this.composed = init.composed !== undefined ? Boolean(init.composed) : false
    Object.assign(this, init)
  }

  preventDefault(): void {
    if (this.cancelable) this.defaultPrevented = true
  }

  stopPropagation(): void {
    this.cancelBubble = true
  }

  stopImmediatePropagation(): void {
    this.cancelBubble = true
    this.immediateCancelBubble = true
  }
}

export class FakeCustomEvent extends FakeEvent {
  constructor(type: string, init: Record<string, unknown> = {}) {
    super(type, { detail: undefined, ...init })
  }
}

export class FakeMouseEvent extends FakeEvent {
  clientX = 0
  clientY = 0
  pageX = 0
  pageY = 0
  button = 0
  buttons = 1
  ctrlKey = false
  shiftKey = false
  altKey = false
  metaKey = false
  constructor(type: string, init: Record<string, unknown> = {}) {
    super(type, { bubbles: true, cancelable: true, ...init })
    Object.assign(this, init)
  }
}

export class FakePointerEvent extends FakeMouseEvent {
  pointerId = 1
  pointerType = 'mouse'
  isPrimary = true
  constructor(type: string, init: Record<string, unknown> = {}) {
    super(type, init)
    Object.assign(this, init)
  }
}

export class FakeKeyboardEvent extends FakeEvent {
  key = ''
  code = ''
  ctrlKey = false
  shiftKey = false
  altKey = false
  metaKey = false
  repeat = false
  isComposing = false
  constructor(type: string, init: Record<string, unknown> = {}) {
    super(type, { bubbles: true, cancelable: true, ...init })
    Object.assign(this, init)
  }
}

export class FakeInputEvent extends FakeEvent {
  data: string | null = null
  inputType = 'insertText'
  isComposing = false
  constructor(type: string, init: Record<string, unknown> = {}) {
    super(type, { bubbles: true, cancelable: false, ...init })
    Object.assign(this, init)
  }
}

export class FakeClipboardEvent extends FakeEvent {
  clipboardData: FakeDataTransfer
  constructor(type: string, init: Record<string, unknown> = {}) {
    super(type, { bubbles: true, cancelable: true, ...init })
    this.clipboardData =
      init.clipboardData instanceof FakeDataTransfer ? init.clipboardData : new FakeDataTransfer()
  }
}

export class FakeWheelEvent extends FakeMouseEvent {
  deltaX = 0
  deltaY = 0
  deltaZ = 0
  deltaMode = 0
  constructor(type: string, init: Record<string, unknown> = {}) {
    super(type, init)
    Object.assign(this, init)
  }
}

export class FakeFocusEvent extends FakeEvent {
  constructor(type: string, init: Record<string, unknown> = {}) {
    super(type, { bubbles: false, cancelable: false, ...init })
    Object.assign(this, init)
  }
}

export class FakeDragEvent extends FakeMouseEvent {
  dataTransfer: FakeDataTransfer
  constructor(type: string, init: Record<string, unknown> = {}) {
    super(type, { bubbles: true, cancelable: true, ...init })
    Object.assign(this, init)
    this.dataTransfer =
      init.dataTransfer instanceof FakeDataTransfer ? init.dataTransfer : new FakeDataTransfer()
  }
}

export class FakeClassList {
  private set = new Set<string>()
  constructor(private readonly el: FakeElement) {}

  add(...tokens: string[]): void {
    for (const t of tokens) {
      for (const p of String(t).split(/\s+/).filter(Boolean)) this.set.add(p)
    }
    this.el._syncClassFromList()
  }

  remove(...tokens: string[]): void {
    for (const t of tokens) {
      for (const p of String(t).split(/\s+/).filter(Boolean)) this.set.delete(p)
    }
    this.el._syncClassFromList()
  }

  toggle(token: string, force?: boolean): boolean {
    if (force === true) {
      this.add(token)
      return true
    }
    if (force === false) {
      this.remove(token)
      return false
    }
    if (this.set.has(token)) {
      this.remove(token)
      return false
    }
    this.add(token)
    return true
  }

  replace(oldToken: string, newToken: string): boolean {
    if (!this.set.has(oldToken)) return false
    this.set.delete(oldToken)
    if (newToken) this.set.add(newToken)
    this.el._syncClassFromList()
    return true
  }

  contains(token: string): boolean {
    return this.set.has(token)
  }

  item(index: number): string | null {
    return this.toArray()[index] ?? null
  }

  forEach(cb: (value: string, index: number, list: FakeClassList) => void): void {
    const arr = this.toArray()
    arr.forEach((v, i) => cb(v, i, this))
  }

  get length(): number {
    return this.set.size
  }

  get value(): string {
    return this.toArray().join(' ')
  }

  toArray(): string[] {
    return Array.from(this.set)
  }

  toString(): string {
    return this.value
  }

  _setFromString(raw: string): void {
    this.set = new Set(String(raw || '').split(/\s+/).filter(Boolean))
  }

  [Symbol.iterator](): IterableIterator<string> {
    return this.set.values()
  }
}

export class FakeEventTarget {
  private _listeners = new Map<string, Set<RegisteredListener>>()

  addEventListener(
    type: string,
    fn: ((ev: FakeEvent) => void) | { handleEvent?: (ev: FakeEvent) => void } | null,
    options?: boolean | EventListenerOptionsLike
  ): void {
    if (!fn) return
    const handler: (ev: FakeEvent) => void =
      typeof fn === 'function' ? fn : (ev: FakeEvent) => fn.handleEvent?.(ev)
    const opts: EventListenerOptionsLike =
      typeof options === 'boolean' ? { capture: options } : options || {}
    if (opts.signal?.aborted) return

    const entry: RegisteredListener = {
      fn: handler,
      capture: Boolean(opts.capture),
      once: Boolean(opts.once),
    }
    let set = this._listeners.get(type)
    if (!set) {
      set = new Set()
      this._listeners.set(type, set)
    }
    set.add(entry)

    if (opts.signal && typeof opts.signal.addEventListener === 'function') {
      opts.signal.addEventListener('abort', () => {
        set?.delete(entry)
      })
    }
  }

  removeEventListener(
    type: string,
    fn: ((ev: FakeEvent) => void) | { handleEvent?: (ev: FakeEvent) => void } | null,
    options?: boolean | EventListenerOptionsLike
  ): void {
    if (!fn) return
    const capture = typeof options === 'boolean' ? options : Boolean(options?.capture)
    const set = this._listeners.get(type)
    if (!set) return
    for (const item of Array.from(set)) {
      if (item.fn === fn && item.capture === capture) {
        set.delete(item)
      }
    }
  }

  _invokePhase(type: string, ev: FakeEvent, capture: boolean): void {
    const set = this._listeners.get(type)
    if (!set || set.size === 0) return
    for (const item of Array.from(set)) {
      if (item.capture !== capture) continue
      if (item.once) set.delete(item)
      ev.currentTarget = this
      item.fn.call(this, ev)
      if (ev.immediateCancelBubble) return
    }
  }

  _invokeAllAtTarget(type: string, ev: FakeEvent): void {
    const set = this._listeners.get(type)
    if (!set || set.size === 0) return
    for (const item of Array.from(set)) {
      if (item.once) set.delete(item)
      ev.currentTarget = this
      item.fn.call(this, ev)
      if (ev.immediateCancelBubble) return
    }
  }

  dispatchEvent(evOrType: FakeEvent | string): boolean {
    const ev = evOrType instanceof FakeEvent ? evOrType : new FakeEvent(String(evOrType))
    ev.target = ev.target ?? this
    const parentWin =
      this instanceof FakeDocument && this.defaultView ? this.defaultView : null
    if (parentWin) {
      ev.eventPhase = 1
      parentWin._invokePhase(ev.type, ev, true)
    }
    if (!ev.cancelBubble) {
      ev.eventPhase = 2
      this._invokeAllAtTarget(ev.type, ev)
    }
    if (parentWin && ev.bubbles && !ev.cancelBubble) {
      ev.eventPhase = 3
      parentWin._invokePhase(ev.type, ev, false)
    }
    return !ev.defaultPrevented
  }
}

export class FakeNode extends FakeEventTarget {
  nodeType = 1
  nodeName = '#node'
  parentElement: FakeElement | null = null
  childNodes: FakeNode[] = []
  _ownerDoc: FakeDocument | null = null
  _text = ''

  get parentNode(): FakeNode | null {
    return this.parentElement
  }

  get ownerDocument(): FakeDocument | null {
    return this._ownerDoc
  }

  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null
  }

  get lastChild(): FakeNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null
  }

  get previousSibling(): FakeNode | null {
    if (!this.parentElement) return null
    const i = this.parentElement.childNodes.indexOf(this)
    return i > 0 ? this.parentElement.childNodes[i - 1] : null
  }

  get nextSibling(): FakeNode | null {
    if (!this.parentElement) return null
    const i = this.parentElement.childNodes.indexOf(this)
    return i >= 0 && i + 1 < this.parentElement.childNodes.length
      ? this.parentElement.childNodes[i + 1]
      : null
  }

  get isConnected(): boolean {
    if (!this._ownerDoc) return false
    let cur: FakeNode | null = this
    while (cur) {
      if (cur === this._ownerDoc.documentElement) return true
      cur = cur.parentElement
    }
    return false
  }

  getRootNode(): FakeNode | FakeDocument {
    let cur: FakeNode = this
    while (cur.parentElement) cur = cur.parentElement
    return cur._ownerDoc && cur === cur._ownerDoc.documentElement ? cur._ownerDoc : cur
  }

  contains(other: FakeNode | null): boolean {
    let cur = other
    while (cur) {
      if (cur === this) return true
      cur = cur.parentElement
    }
    return false
  }

  get nodeValue(): string | null {
    return this.nodeType === 3 || this.nodeType === 8 ? this._text : null
  }

  set nodeValue(val: string | null) {
    if (this.nodeType === 3 || this.nodeType === 8) {
      this._text = val ?? ''
    }
  }

  get textContent(): string {
    if (this.nodeType === 3) return this._text
    if (this.nodeType === 8) return this._text
    return this.childNodes.map((c) => c.textContent).join('')
  }

  set textContent(val: string) {
    const str = String(val ?? '')
    for (const c of this.childNodes) c.parentElement = null
    this.childNodes = []
    if (this.nodeType === 3 || this.nodeType === 8) {
      this._text = str
    } else if (str.length > 0) {
      const textNode = new FakeText(str, this._ownerDoc)
      textNode.parentElement = this as unknown as FakeElement
      this.childNodes.push(textNode)
    }
  }

  appendChild<T extends FakeNode>(child: T): T {
    if (child instanceof FakeDocumentFragment) {
      for (const grand of [...child.childNodes]) this.appendChild(grand)
      return child
    }
    if (child.parentElement) child.parentElement.removeChild(child)
    child.parentElement = this as unknown as FakeElement
    if (this._ownerDoc) setOwnerDocRecursive(child, this._ownerDoc)
    this.childNodes.push(child)
    return child
  }

  removeChild<T extends FakeNode>(child: T): T {
    const idx = this.childNodes.indexOf(child)
    if (idx >= 0) {
      this.childNodes.splice(idx, 1)
      child.parentElement = null
    }
    return child
  }

  insertBefore<T extends FakeNode>(newChild: T, refChild: FakeNode | null): T {
    if (!refChild) return this.appendChild(newChild)
    if (newChild instanceof FakeDocumentFragment) {
      for (const grand of [...newChild.childNodes]) this.insertBefore(grand, refChild)
      return newChild
    }
    if (newChild.parentElement) newChild.parentElement.removeChild(newChild)
    const idx = this.childNodes.indexOf(refChild)
    if (idx < 0) return this.appendChild(newChild)
    newChild.parentElement = this as unknown as FakeElement
    if (this._ownerDoc) setOwnerDocRecursive(newChild, this._ownerDoc)
    this.childNodes.splice(idx, 0, newChild)
    return newChild
  }

  replaceChild<T extends FakeNode>(newChild: FakeNode, oldChild: T): T {
    const idx = this.childNodes.indexOf(oldChild)
    if (idx >= 0) {
      if (newChild instanceof FakeDocumentFragment) {
        const items = [...newChild.childNodes]
        for (const item of items) {
          item.parentElement = this as unknown as FakeElement
          if (this._ownerDoc) setOwnerDocRecursive(item, this._ownerDoc)
        }
        oldChild.parentElement = null
        this.childNodes.splice(idx, 1, ...items)
      } else {
        if (newChild.parentElement) newChild.parentElement.removeChild(newChild)
        newChild.parentElement = this as unknown as FakeElement
        if (this._ownerDoc) setOwnerDocRecursive(newChild, this._ownerDoc)
        oldChild.parentElement = null
        this.childNodes.splice(idx, 1, newChild)
      }
    }
    return oldChild
  }

  replaceChildren(...nodes: Array<FakeNode | string>): void {
    for (const c of this.childNodes) c.parentElement = null
    this.childNodes = []
    this.append(...nodes)
  }

  append(...nodes: Array<FakeNode | string>): void {
    for (const n of nodes) {
      if (typeof n === 'string') {
        this.appendChild(new FakeText(n, this._ownerDoc))
      } else {
        this.appendChild(n)
      }
    }
  }

  prepend(...nodes: Array<FakeNode | string>): void {
    const first = this.firstChild
    for (const n of nodes) {
      const node = typeof n === 'string' ? new FakeText(n, this._ownerDoc) : n
      this.insertBefore(node, first)
    }
  }

  remove(): void {
    this.parentElement?.removeChild(this)
  }

  replaceWith(...nodes: Array<FakeNode | string>): void {
    const parent = this.parentElement
    if (!parent) return
    const items = nodes.map((n) => (typeof n === 'string' ? new FakeText(n, this._ownerDoc) : n))
    if (items.length === 0) {
      parent.removeChild(this)
      return
    }
    const idx = parent.childNodes.indexOf(this)
    if (idx < 0) return
    const nextSibling = parent.childNodes[idx + 1] ?? null
    parent.removeChild(this)
    for (const item of items) {
      parent.insertBefore(item, nextSibling === item ? null : nextSibling)
    }
  }

  before(...nodes: Array<FakeNode | string>): void {
    const parent = this.parentElement
    if (!parent) return
    for (const n of nodes) {
      const node = typeof n === 'string' ? new FakeText(n, this._ownerDoc) : n
      parent.insertBefore(node, this)
    }
  }

  after(...nodes: Array<FakeNode | string>): void {
    const parent = this.parentElement
    if (!parent) return
    const idx = parent.childNodes.indexOf(this)
    if (idx < 0) return
    const nextSibling = parent.childNodes[idx + 1] ?? null
    for (const n of nodes) {
      const node = typeof n === 'string' ? new FakeText(n, this._ownerDoc) : n
      parent.insertBefore(node, nextSibling)
    }
  }

  cloneNode(_deep = false): FakeNode {
    return new FakeNode()
  }

  dispatchEvent(evOrType: FakeEvent | string): boolean {
    const ev =
      evOrType instanceof FakeEvent ? evOrType : new FakeEvent(String(evOrType))
    ev.target = ev.target ?? this
    const ancestors: FakeEventTarget[] = []
    let cur = this.parentElement
    while (cur) {
      ancestors.push(cur)
      cur = cur.parentElement
    }
    if (this._ownerDoc) {
      ancestors.push(this._ownerDoc)
      if (this._ownerDoc.defaultView) ancestors.push(this._ownerDoc.defaultView)
    }

    // Capturing phase (outermost -> target parent)
    ev.eventPhase = 1
    for (let i = ancestors.length - 1; i >= 0; i--) {
      if (ev.cancelBubble) break
      ancestors[i]._invokePhase(ev.type, ev, true)
    }

    // Target phase
    if (!ev.cancelBubble) {
      ev.eventPhase = 2
      this._invokeAllAtTarget(ev.type, ev)
    }

    // Bubbling phase
    if (ev.bubbles && !ev.cancelBubble) {
      ev.eventPhase = 3
      for (let i = 0; i < ancestors.length; i++) {
        if (ev.cancelBubble) break
        ancestors[i]._invokePhase(ev.type, ev, false)
      }
    }
    return !ev.defaultPrevented
  }
}

function setOwnerDocRecursive(node: FakeNode, doc: FakeDocument): void {
  node._ownerDoc = doc
  for (const ch of node.childNodes) {
    setOwnerDocRecursive(ch, doc)
  }
}

export class FakeText extends FakeNode {
  constructor(text: string, ownerDoc: FakeDocument | null = null) {
    super()
    this.nodeType = 3
    this.nodeName = '#text'
    this._text = String(text ?? '')
    this._ownerDoc = ownerDoc
  }
  cloneNode(): FakeText {
    return new FakeText(this._text, this._ownerDoc)
  }
}

export class FakeComment extends FakeNode {
  constructor(text: string, ownerDoc: FakeDocument | null = null) {
    super()
    this.nodeType = 8
    this.nodeName = '#comment'
    this._text = String(text ?? '')
    this._ownerDoc = ownerDoc
  }
  cloneNode(): FakeComment {
    return new FakeComment(this._text, this._ownerDoc)
  }
}

export class FakeDocumentFragment extends FakeNode {
  constructor(ownerDoc: FakeDocument | null = null) {
    super()
    this.nodeType = 11
    this.nodeName = '#document-fragment'
    this._ownerDoc = ownerDoc
  }
  get children(): FakeElement[] {
    return this.childNodes.filter((c): c is FakeElement => c instanceof FakeElement)
  }
  querySelectorAll(sel: string): FakeElement[] {
    const out: FakeElement[] = []
    for (const c of this.children) {
      if (matchesSelector(c, sel)) out.push(c)
      out.push(...c.querySelectorAll(sel))
    }
    return out
  }
  querySelector(sel: string): FakeElement | null {
    return this.querySelectorAll(sel)[0] ?? null
  }
  cloneNode(deep = false): FakeDocumentFragment {
    const frag = new FakeDocumentFragment(this._ownerDoc)
    if (deep) {
      for (const ch of this.childNodes) frag.appendChild(ch.cloneNode(true))
    }
    return frag
  }
}

export class FakeElement extends FakeNode {
  tagName: string
  classList: FakeClassList
  style: Record<string, string> & {
    cssText: string
    setProperty: (prop: string, val: string) => void
    getPropertyValue: (prop: string) => string
    removeProperty: (prop: string) => string
  }
  dataset: Record<string, string>
  private _attrs = new Map<string, string>()
  private _styles = new Map<string, string>()
  private _value: string | undefined = undefined
  private _checked: boolean | undefined = undefined
  private _selected: boolean | undefined = undefined
  private _disabled: boolean | undefined = undefined
  private _readOnly: boolean | undefined = undefined
  private _hidden: boolean | undefined = undefined
  tabIndex = 0
  scrollTop = 0
  scrollLeft = 0
  scrollHeight = 400
  scrollWidth = 800
  clientWidth = 800
  clientHeight = 600
  offsetWidth = 800
  offsetHeight = 400
  selectionStart: number | null = 0
  selectionEnd: number | null = 0
  files: unknown[] | null = null
  _rect = { left: 16, top: 40, right: 256, bottom: 68, width: 240, height: 28 }

  constructor(tag: string, ownerDoc: FakeDocument | null = null) {
    super()
    this.nodeType = 1
    this.tagName = tag.toUpperCase()
    this.nodeName = this.tagName
    this._ownerDoc = ownerDoc
    this.classList = new FakeClassList(this)

    const styleTarget = {
      setProperty: (prop: string, val: string) => {
        const key = String(prop)
        if (val === undefined || val === null || val === '') {
          this._styles.delete(key)
        } else {
          this._styles.set(key, String(val))
        }
        this._syncStyleAttr()
      },
      getPropertyValue: (prop: string) => this._styles.get(String(prop)) ?? '',
      removeProperty: (prop: string) => {
        const prev = this._styles.get(String(prop)) ?? ''
        this._styles.delete(String(prop))
        this._syncStyleAttr()
        return prev
      },
    }

    this.style = new Proxy(styleTarget as FakeElement['style'], {
      get: (target, prop) => {
        if (typeof prop === 'symbol') return undefined
        if (prop === 'cssText') {
          return Array.from(this._styles.entries())
            .map(([k, v]) => `${k}: ${v};`)
            .join(' ')
        }
        if (prop in target) return Reflect.get(target, prop)
        return this._styles.get(prop) ?? this._styles.get(camelToKebab(prop)) ?? ''
      },
      set: (_target, prop, val) => {
        if (typeof prop === 'symbol') return false
        if (prop === 'cssText') {
          this._parseStyleText(String(val ?? ''))
          this._syncStyleAttr()
          return true
        }
        const cssKey = prop.startsWith('--') ? prop : camelToKebab(prop)
        if (val === undefined || val === null || val === '') {
          this._styles.delete(cssKey)
        } else {
          this._styles.set(cssKey, String(val))
        }
        this._syncStyleAttr()
        return true
      },
    })

    this.dataset = new Proxy(
      {},
      {
        get: (_t, prop) => {
          if (typeof prop !== 'string') return undefined
          return this._attrs.get(`data-${camelToKebab(prop)}`)
        },
        set: (_t, prop, val) => {
          if (typeof prop !== 'string') return false
          this.setAttribute(`data-${camelToKebab(prop)}`, String(val))
          return true
        },
        deleteProperty: (_t, prop) => {
          if (typeof prop !== 'string') return false
          this.removeAttribute(`data-${camelToKebab(prop)}`)
          return true
        },
        has: (_t, prop) => {
          if (typeof prop !== 'string') return false
          return this._attrs.has(`data-${camelToKebab(prop)}`)
        },
        ownKeys: () => {
          return Array.from(this._attrs.keys())
            .filter((k) => k.startsWith('data-'))
            .map((k) => kebabToCamel(k.slice(5)))
        },
        getOwnPropertyDescriptor: (_t, prop) => {
          if (typeof prop !== 'string') return undefined
          const key = `data-${camelToKebab(prop)}`
          if (!this._attrs.has(key)) return undefined
          return {
            enumerable: true,
            configurable: true,
            value: this._attrs.get(key),
          }
        },
      }
    ) as Record<string, string>
  }

  private _parseStyleText(cssText: string): void {
    this._styles.clear()
    for (const part of String(cssText || '').split(';')) {
      const idx = part.indexOf(':')
      if (idx <= 0) continue
      const k = part.slice(0, idx).trim()
      const v = part.slice(idx + 1).trim()
      if (k && v) this._styles.set(k, v)
    }
  }

  private _syncStyleAttr(): void {
    const serialized = Array.from(this._styles.entries())
      .map(([k, v]) => `${k}: ${v}`)
      .join('; ')
    if (serialized) this._attrs.set('style', serialized)
    else this._attrs.delete('style')
  }

  _syncClassFromList(): void {
    const cls = this.classList.value
    if (cls) this._attrs.set('class', cls)
    else this._attrs.delete('class')
  }

  get children(): FakeElement[] {
    return this.childNodes.filter((c): c is FakeElement => c instanceof FakeElement)
  }

  get childElementCount(): number {
    return this.children.length
  }

  get firstElementChild(): FakeElement | null {
    return this.children[0] ?? null
  }

  get lastElementChild(): FakeElement | null {
    return this.children[this.children.length - 1] ?? null
  }

  get previousElementSibling(): FakeElement | null {
    if (!this.parentElement) return null
    const siblings = this.parentElement.children
    const i = siblings.indexOf(this)
    return i > 0 ? siblings[i - 1] : null
  }

  get nextElementSibling(): FakeElement | null {
    if (!this.parentElement) return null
    const siblings = this.parentElement.children
    const i = siblings.indexOf(this)
    return i >= 0 && i + 1 < siblings.length ? siblings[i + 1] : null
  }

  get id(): string {
    return this._attrs.get('id') ?? ''
  }
  set id(v: string) {
    this.setAttribute('id', v)
  }

  get className(): string {
    return this.classList.value
  }
  set className(v: string) {
    this.setAttribute('class', v)
  }

  get attributes(): Array<{ name: string; value: string }> {
    return Array.from(this._attrs.entries()).map(([name, value]) => ({ name, value }))
  }

  setAttribute(name: string, value: string): void {
    const key = String(name)
    const strVal = String(value ?? '')
    this._attrs.set(key, strVal)
    if (key === 'class') this.classList._setFromString(strVal)
    else if (key === 'style') this._parseStyleText(strVal)
    else if (key === 'checked') this._checked = true
    else if (key === 'selected') this._selected = true
    else if (key === 'disabled') this._disabled = true
    else if (key === 'readonly') this._readOnly = true
    else if (key === 'hidden') this._hidden = true
    else if (key === 'tabindex') {
      const n = Number(strVal)
      if (Number.isFinite(n)) this.tabIndex = n
    } else if (key === 'value' && this._value === undefined) {
      this._value = strVal
    }
  }

  getAttribute(name: string): string | null {
    return this._attrs.get(String(name)) ?? null
  }

  removeAttribute(name: string): void {
    const key = String(name)
    this._attrs.delete(key)
    if (key === 'class') this.classList._setFromString('')
    else if (key === 'style') this._styles.clear()
    else if (key === 'checked') this._checked = false
    else if (key === 'selected') this._selected = false
    else if (key === 'disabled') this._disabled = false
    else if (key === 'readonly') this._readOnly = false
    else if (key === 'hidden') this._hidden = false
  }

  hasAttribute(name: string): boolean {
    return this._attrs.has(String(name))
  }

  getAttributeNames(): string[] {
    return Array.from(this._attrs.keys())
  }

  toggleAttribute(name: string, force?: boolean): boolean {
    const exists = this.hasAttribute(name)
    const next = force === undefined ? !exists : force
    if (next) this.setAttribute(name, '')
    else this.removeAttribute(name)
    return next
  }

  get type(): string {
    return this._attrs.get('type') ?? (this.tagName === 'BUTTON' ? 'submit' : this.tagName === 'INPUT' ? 'text' : '')
  }
  set type(v: string) {
    this.setAttribute('type', v)
  }

  get name(): string {
    return this._attrs.get('name') ?? ''
  }
  set name(v: string) {
    this.setAttribute('name', v)
  }

  get placeholder(): string {
    return this._attrs.get('placeholder') ?? ''
  }
  set placeholder(v: string) {
    this.setAttribute('placeholder', v)
  }

  get title(): string {
    return this._attrs.get('title') ?? ''
  }
  set title(v: string) {
    this.setAttribute('title', v)
  }

  get href(): string {
    return this._attrs.get('href') ?? ''
  }
  set href(v: string) {
    this.setAttribute('href', v)
  }

  get src(): string {
    return this._attrs.get('src') ?? ''
  }
  set src(v: string) {
    this.setAttribute('src', v)
  }

  get download(): string {
    return this._attrs.get('download') ?? ''
  }
  set download(v: string) {
    this.setAttribute('download', v)
  }

  get disabled(): boolean {
    return this._disabled !== undefined ? this._disabled : this.hasAttribute('disabled')
  }
  set disabled(v: boolean) {
    this._disabled = Boolean(v)
    if (v) this._attrs.set('disabled', '')
    else this._attrs.delete('disabled')
  }

  get readOnly(): boolean {
    return this._readOnly !== undefined ? this._readOnly : this.hasAttribute('readonly')
  }
  set readOnly(v: boolean) {
    this._readOnly = Boolean(v)
    if (v) this._attrs.set('readonly', '')
    else this._attrs.delete('readonly')
  }

  get hidden(): boolean {
    return this._hidden !== undefined ? this._hidden : this.hasAttribute('hidden')
  }
  set hidden(v: boolean) {
    this._hidden = Boolean(v)
    if (v) this._attrs.set('hidden', '')
    else this._attrs.delete('hidden')
  }

  get offsetParent(): FakeElement | null {
    if (this.hidden || this.style.display === 'none' || !this.isConnected) return null
    return this.parentElement ?? this._ownerDoc?.body ?? null
  }

  get checked(): boolean {
    return this._checked !== undefined ? this._checked : this.hasAttribute('checked')
  }
  set checked(v: boolean) {
    this._checked = Boolean(v)
  }

  get selected(): boolean {
    return this._selected !== undefined ? this._selected : this.hasAttribute('selected')
  }
  set selected(v: boolean) {
    this._selected = Boolean(v)
  }

  get options(): FakeElement[] {
    return this.querySelectorAll('option')
  }

  get selectedIndex(): number {
    const opts = this.options
    if (this._value !== undefined) {
      const byVal = opts.findIndex((o) => o.value === this._value)
      if (byVal >= 0) return byVal
    }
    const bySel = opts.findIndex((o) => o.selected)
    if (bySel >= 0) return bySel
    return opts.length > 0 ? 0 : -1
  }
  set selectedIndex(idx: number) {
    const opts = this.options
    if (idx >= 0 && idx < opts.length) {
      for (let i = 0; i < opts.length; i++) opts[i].selected = i === idx
      this._value = opts[idx].value
    } else {
      for (const o of opts) o.selected = false
      this._value = ''
    }
  }

  get selectedOptions(): FakeElement[] {
    return this.options.filter((o) => o.selected || o.value === this.value)
  }

  get value(): string {
    if (this.tagName === 'SELECT') {
      if (this._value !== undefined) return this._value
      const opts = this.options
      const sel = opts.find((o) => o.selected) ?? opts[0]
      return sel ? sel.value : ''
    }
    if (this.tagName === 'OPTION') {
      if (this._value !== undefined) return this._value
      if (this._attrs.has('value')) return this._attrs.get('value') ?? ''
      return this.textContent
    }
    if (this._value !== undefined) return this._value
    return this._attrs.get('value') ?? ''
  }

  set value(v: string) {
    const str = String(v ?? '')
    this._value = str
    if (this.tagName === 'SELECT') {
      const opts = this.options
      for (const o of opts) o.selected = o.value === str
    }
  }

  get innerText(): string {
    return this.textContent
  }
  set innerText(v: string) {
    this.textContent = v
  }

  get innerHTML(): string {
    return this.childNodes.map((c) => serializeNode(c)).join('')
  }

  set innerHTML(html: string) {
    for (const c of this.childNodes) c.parentElement = null
    this.childNodes = []
    const frag = parseHtmlFragment(String(html ?? ''), this._ownerDoc)
    this.appendChild(frag)
  }

  get outerHTML(): string {
    return serializeNode(this)
  }

  insertAdjacentHTML(position: 'beforebegin' | 'afterbegin' | 'beforeend' | 'afterend', html: string): void {
    const frag = parseHtmlFragment(String(html ?? ''), this._ownerDoc)
    if (position === 'beforeend') {
      this.appendChild(frag)
    } else if (position === 'afterbegin') {
      this.insertBefore(frag, this.firstChild)
    } else if (position === 'beforebegin' && this.parentElement) {
      this.parentElement.insertBefore(frag, this)
    } else if (position === 'afterend' && this.parentElement) {
      this.parentElement.insertBefore(frag, this.nextSibling)
    }
  }

  insertAdjacentElement(
    position: 'beforebegin' | 'afterbegin' | 'beforeend' | 'afterend',
    el: FakeElement
  ): FakeElement {
    if (position === 'beforeend') this.appendChild(el)
    else if (position === 'afterbegin') this.insertBefore(el, this.firstChild)
    else if (position === 'beforebegin' && this.parentElement) this.parentElement.insertBefore(el, this)
    else if (position === 'afterend' && this.parentElement) {
      this.parentElement.insertBefore(el, this.nextSibling)
    }
    return el
  }

  setSelectionRange(start: number, end: number): void {
    this.selectionStart = start
    this.selectionEnd = end
  }

  focus(): void {
    if (this._ownerDoc) {
      const prev = this._ownerDoc.activeElement
      if (prev && prev !== this) {
        prev.dispatchEvent(new FakeFocusEvent('blur', { relatedTarget: this }))
      }
      this._ownerDoc.activeElement = this
      this.dispatchEvent(new FakeFocusEvent('focus', { relatedTarget: prev }))
    }
  }

  blur(): void {
    if (this._ownerDoc && this._ownerDoc.activeElement === this) {
      this._ownerDoc.activeElement = null
      this.dispatchEvent(new FakeFocusEvent('blur'))
    }
  }

  select(): void {
    this.selectionStart = 0
    this.selectionEnd = this.value.length
  }

  scrollIntoView(): void {}

  click(): void {
    if (this.disabled) return
    if (this.tagName === 'INPUT' && (this.type === 'checkbox' || this.type === 'radio')) {
      if (this.type === 'checkbox') this.checked = !this.checked
      else this.checked = true
    }
    const ev = new FakeMouseEvent('click', { bubbles: true, cancelable: true })
    this.dispatchEvent(ev)
    if (this.tagName === 'INPUT' && (this.type === 'checkbox' || this.type === 'radio') && !ev.defaultPrevented) {
      this.dispatchEvent(new FakeEvent('change', { bubbles: true }))
    }
    if (this.type === 'submit' && !ev.defaultPrevented) {
      const form = this.closest('form')
      if (form) form.dispatchEvent(new FakeEvent('submit', { bubbles: true, cancelable: true }))
    }
  }

  getBoundingClientRect(): typeof this._rect {
    return { ...this._rect }
  }

  getClientRects(): Array<typeof this._rect> {
    return [this.getBoundingClientRect()]
  }

  matches(selector: string): boolean {
    return matchesSelector(this, selector)
  }

  closest(selector: string): FakeElement | null {
    let cur: FakeElement | null = this
    while (cur) {
      if (matchesSelector(cur, selector)) return cur
      cur = cur.parentElement
    }
    return null
  }

  querySelectorAll(selector: string): FakeElement[] {
    const compiled = compileSelector(selector)
    if (compiled.length === 0) return []
    const out: FakeElement[] = []
    const walk = (root: FakeElement): void => {
      const nodes = root.childNodes
      for (let i = 0; i < nodes.length; i++) {
        const ch = nodes[i]
        if (ch instanceof FakeElement) {
          if (matchesCompiled(ch, compiled)) out.push(ch)
          walk(ch)
        }
      }
    }
    walk(this)
    return out
  }

  querySelector(selector: string): FakeElement | null {
    const compiled = compileSelector(selector)
    if (compiled.length === 0) return null
    const walk = (root: FakeElement): FakeElement | null => {
      const nodes = root.childNodes
      for (let i = 0; i < nodes.length; i++) {
        const ch = nodes[i]
        if (ch instanceof FakeElement) {
          if (matchesCompiled(ch, compiled)) return ch
          const found = walk(ch)
          if (found) return found
        }
      }
      return null
    }
    return walk(this)
  }

  getElementsByTagName(tagName: string): FakeElement[] {
    const target = String(tagName).toUpperCase()
    const out: FakeElement[] = []
    const walk = (root: FakeElement): void => {
      for (const ch of root.children) {
        if (target === '*' || ch.tagName === target) out.push(ch)
        walk(ch)
      }
    }
    walk(this)
    return out
  }

  getElementsByClassName(names: string): FakeElement[] {
    const wanted = String(names).split(/\s+/).filter(Boolean)
    const out: FakeElement[] = []
    const walk = (root: FakeElement): void => {
      for (const ch of root.children) {
        if (wanted.every((w) => ch.classList.contains(w))) out.push(ch)
        walk(ch)
      }
    }
    walk(this)
    return out
  }

  cloneNode(deep = false): FakeElement {
    const copy = createFakeElement(this.tagName, this._ownerDoc, this instanceof FakeSVGElement)
    for (const [k, v] of this._attrs.entries()) copy.setAttribute(k, v)
    if (this._value !== undefined) copy._value = this._value
    if (this._checked !== undefined) copy._checked = this._checked
    if (this._selected !== undefined) copy._selected = this._selected
    if (deep) {
      for (const ch of this.childNodes) copy.appendChild(ch.cloneNode(true))
    }
    return copy
  }
}

export class FakeHTMLInputElement extends FakeElement {}
export class FakeHTMLTextAreaElement extends FakeElement {}
export class FakeHTMLSelectElement extends FakeElement {}
export class FakeHTMLOptionElement extends FakeElement {
  get text(): string {
    return this.textContent
  }
  set text(v: string) {
    this.textContent = String(v ?? '')
  }
}
export class FakeHTMLButtonElement extends FakeElement {}
export class FakeHTMLFormElement extends FakeElement {}
export class FakeHTMLTableElement extends FakeElement {}
export class FakeHTMLTableRowElement extends FakeElement {}
export class FakeHTMLTableCellElement extends FakeElement {}
export class FakeHTMLAnchorElement extends FakeElement {}
export class FakeSVGElement extends FakeElement {}

export function createFakeElement(tagName: string, ownerDoc: FakeDocument | null, isSvg = false): FakeElement {
  const tag = String(tagName).toUpperCase()
  if (isSvg || tag === 'SVG') {
    return new FakeSVGElement(tagName, ownerDoc)
  }
  switch (tag) {
    case 'INPUT':
      return new FakeHTMLInputElement(tagName, ownerDoc)
    case 'TEXTAREA':
      return new FakeHTMLTextAreaElement(tagName, ownerDoc)
    case 'SELECT':
      return new FakeHTMLSelectElement(tagName, ownerDoc)
    case 'OPTION':
      return new FakeHTMLOptionElement(tagName, ownerDoc)
    case 'BUTTON':
      return new FakeHTMLButtonElement(tagName, ownerDoc)
    case 'FORM':
      return new FakeHTMLFormElement(tagName, ownerDoc)
    case 'TABLE':
      return new FakeHTMLTableElement(tagName, ownerDoc)
    case 'TR':
      return new FakeHTMLTableRowElement(tagName, ownerDoc)
    case 'TD':
    case 'TH':
      return new FakeHTMLTableCellElement(tagName, ownerDoc)
    case 'A':
      return new FakeHTMLAnchorElement(tagName, ownerDoc)
    default:
      return new FakeElement(tagName, ownerDoc)
  }
}

function serializeNode(node: FakeNode): string {
  if (node instanceof FakeText) return escapeHtmlText(node._text)
  if (node instanceof FakeComment) return `<!--${node._text}-->`
  if (!(node instanceof FakeElement)) return ''
  const tag = node.tagName.toLowerCase()
  const attrsStr = node.attributes
    .map(({ name, value }) => (value === '' && (name === 'disabled' || name === 'checked' || name === 'selected' || name === 'readonly' || name === 'hidden') ? name : `${name}="${escapeHtmlAttr(value)}"`))
    .join(' ')
  const open = attrsStr ? `<${tag} ${attrsStr}>` : `<${tag}>`
  if (VOID_TAGS.has(tag)) return open
  const inner = node.childNodes.map((c) => serializeNode(c)).join('')
  return `${open}${inner}</${tag}>`
}

export function parseHtmlFragment(html: string, ownerDoc: FakeDocument | null = null): FakeDocumentFragment {
  const root = new FakeDocumentFragment(ownerDoc)
  const stack: FakeNode[] = [root]
  const src = String(html ?? '')
  let i = 0
  const len = src.length

  while (i < len) {
    const lt = src.indexOf('<', i)
    if (lt < 0) {
      const tail = decodeHtmlEntities(src.slice(i))
      if (tail) stack[stack.length - 1].appendChild(new FakeText(tail, ownerDoc))
      break
    }
    if (lt > i) {
      const txt = decodeHtmlEntities(src.slice(i, lt))
      if (txt) stack[stack.length - 1].appendChild(new FakeText(txt, ownerDoc))
    }

    if (src.startsWith('<!--', lt)) {
      const endComment = src.indexOf('-->', lt + 4)
      const closeIdx = endComment < 0 ? len : endComment
      stack[stack.length - 1].appendChild(new FakeComment(src.slice(lt + 4, closeIdx), ownerDoc))
      i = endComment < 0 ? len : endComment + 3
      continue
    }

    if (src.startsWith('<!', lt) || src.startsWith('<?', lt)) {
      const gt = src.indexOf('>', lt + 2)
      i = gt < 0 ? len : gt + 1
      continue
    }

    // Closing tag
    if (src[lt + 1] === '/') {
      const gt = src.indexOf('>', lt + 2)
      if (gt < 0) break
      const closeTag = src.slice(lt + 2, gt).trim().toUpperCase()
      for (let s = stack.length - 1; s >= 1; s--) {
        const cand = stack[s]
        if (cand instanceof FakeElement && cand.tagName === closeTag) {
          stack.length = s
          break
        }
      }
      i = gt + 1
      continue
    }

    // Parse opening tag & attributes respecting quotes
    let pos = lt + 1
    while (pos < len && !/[\s/>]/.test(src[pos])) pos++
    const rawTag = src.slice(lt + 1, pos)
    if (!rawTag || !/^[A-Za-z][A-Za-z0-9:-]*$/.test(rawTag)) {
      stack[stack.length - 1].appendChild(new FakeText('<', ownerDoc))
      i = lt + 1
      continue
    }

    const el = createFakeElement(
      rawTag,
      ownerDoc,
      rawTag.toLowerCase() === 'svg' || stack.some((n) => n instanceof FakeSVGElement)
    )
    let selfClosing = false
    while (pos < len) {
      while (pos < len && /\s/.test(src[pos])) pos++
      if (pos >= len) break
      if (src[pos] === '/' && src[pos + 1] === '>') {
        selfClosing = true
        pos += 2
        break
      }
      if (src[pos] === '>') {
        pos++
        break
      }

      const attrStart = pos
      while (pos < len && !/[\s=/>]/.test(src[pos])) pos++
      const attrName = src.slice(attrStart, pos)
      if (!attrName) {
        pos++
        continue
      }
      while (pos < len && /\s/.test(src[pos])) pos++
      let attrVal = ''
      if (src[pos] === '=') {
        pos++
        while (pos < len && /\s/.test(src[pos])) pos++
        const q = src[pos]
        if (q === '"' || q === "'") {
          pos++
          const vStart = pos
          while (pos < len && src[pos] !== q) pos++
          attrVal = decodeHtmlEntities(src.slice(vStart, pos))
          if (pos < len && src[pos] === q) pos++
        } else {
          const vStart = pos
          while (pos < len && !/[\s>]/.test(src[pos])) {
            if (src[pos] === '/' && src[pos + 1] === '>') break
            pos++
          }
          attrVal = decodeHtmlEntities(src.slice(vStart, pos))
        }
      }
      el.setAttribute(attrName, attrVal)
    }

    stack[stack.length - 1].appendChild(el)
    const lowerTag = rawTag.toLowerCase()
    if (lowerTag === 'script' || lowerTag === 'style') {
      if (!selfClosing) {
        const endRe = new RegExp(`</${rawTag}\\s*>`, 'i')
        const m = endRe.exec(src.slice(pos))
        if (m) {
          el.textContent = src.slice(pos, pos + m.index)
          i = pos + m.index + m[0].length
          continue
        }
      }
    }
    if (!selfClosing && !VOID_TAGS.has(lowerTag)) {
      stack.push(el)
    }
    i = pos
  }
  return root
}

// ---------- CSS Selector Matching ----------
function splitTopLevelSelectors(sel: string, sep: ',' | 'combinator'): string[] {
  const out: string[] = []
  let depthParen = 0
  let depthBracket = 0
  let quote: string | null = null
  let buf = ''
  for (let i = 0; i < sel.length; i++) {
    const ch = sel[i]
    if (quote) {
      buf += ch
      if (ch === quote && sel[i - 1] !== '\\') quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      buf += ch
      continue
    }
    if (ch === '(') depthParen++
    else if (ch === ')' && depthParen > 0) depthParen--
    else if (ch === '[') depthBracket++
    else if (ch === ']' && depthBracket > 0) depthBracket--

    if (depthParen === 0 && depthBracket === 0 && sep === ',' && ch === ',') {
      if (buf.trim()) out.push(buf.trim())
      buf = ''
      continue
    }
    buf += ch
  }
  if (buf.trim()) out.push(buf.trim())
  return out
}

interface CombinatorPart {
  combinator: '' | ' ' | '>' | '+' | '~'
  compound: string
}

function parseComplexSelector(selector: string): CombinatorPart[] {
  const parts: CombinatorPart[] = []
  let depthParen = 0
  let depthBracket = 0
  let quote: string | null = null
  let buf = ''
  let pendingComb: '' | ' ' | '>' | '+' | '~' = ''
  let sawSpace = false

  const flush = () => {
    if (buf.trim()) {
      parts.push({ combinator: parts.length === 0 ? '' : pendingComb || ' ', compound: buf.trim() })
      buf = ''
      pendingComb = ''
      sawSpace = false
    }
  }

  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i]
    if (quote) {
      buf += ch
      if (ch === quote && selector[i - 1] !== '\\') quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      if (sawSpace && buf) {
        flush()
        pendingComb = ' '
      }
      sawSpace = false
      quote = ch
      buf += ch
      continue
    }
    if (ch === '(') depthParen++
    else if (ch === ')' && depthParen > 0) depthParen--
    else if (ch === '[') depthBracket++
    else if (ch === ']' && depthBracket > 0) depthBracket--

    if (depthParen === 0 && depthBracket === 0) {
      if (ch === '>' || ch === '+' || ch === '~') {
        flush()
        pendingComb = ch
        continue
      }
      if (/\s/.test(ch)) {
        if (buf) sawSpace = true
        continue
      }
      if (sawSpace) {
        flush()
        pendingComb = pendingComb || ' '
      }
    }
    buf += ch
  }
  flush()
  return parts
}

function matchesCompound(el: FakeElement, compound: string): boolean {
  let i = 0
  const len = compound.length
  while (i < len) {
    const ch = compound[i]
    if (ch === '*') {
      i++
      continue
    }
    if (ch === '#') {
      let j = i + 1
      while (j < len && !/[#.\[:\s]/.test(compound[j])) j++
      if (el.id !== compound.slice(i + 1, j)) return false
      i = j
      continue
    }
    if (ch === '.') {
      let j = i + 1
      while (j < len && !/[#.\[:\s]/.test(compound[j])) j++
      if (!el.classList.contains(compound.slice(i + 1, j))) return false
      i = j
      continue
    }
    if (ch === '[') {
      let j = i + 1
      let q: string | null = null
      while (j < len) {
        const c = compound[j]
        if (q) {
          if (c === q && compound[j - 1] !== '\\') q = null
        } else if (c === '"' || c === "'") {
          q = c
        } else if (c === ']') {
          break
        }
        j++
      }
      const expr = compound.slice(i + 1, j).trim()
      i = j + 1
      const m = /^([^\s~|^$*=]+)\s*(?:([~|^$*]?=)\s*(.*))?$/.exec(expr)
      if (!m) return false
      const attrName = m[1]
      const op = m[2]
      let expected = m[3]?.trim() ?? ''
      if (
        (expected.startsWith('"') && expected.endsWith('"')) ||
        (expected.startsWith("'") && expected.endsWith("'"))
      ) {
        expected = expected.slice(1, -1)
      }
      if (!op) {
        if (!el.hasAttribute(attrName)) return false
      } else {
        const actual = el.getAttribute(attrName)
        if (actual === null) return false
        if (op === '=' && actual !== expected) return false
        if (op === '^=' && (!expected || !actual.startsWith(expected))) return false
        if (op === '$=' && (!expected || !actual.endsWith(expected))) return false
        if (op === '*=' && (!expected || !actual.includes(expected))) return false
        if (op === '~=' && !actual.split(/\s+/).includes(expected)) return false
        if (op === '|=' && actual !== expected && !actual.startsWith(`${expected}-`)) return false
      }
      continue
    }
    if (ch === ':') {
      let j = i + 1
      while (j < len && /[A-Za-z0-9-]/.test(compound[j])) j++
      const pseudo = compound.slice(i + 1, j).toLowerCase()
      let arg = ''
      if (compound[j] === '(') {
        let depth = 1
        let k = j + 1
        let q: string | null = null
        while (k < len && depth > 0) {
          const c = compound[k]
          if (q) {
            if (c === q) q = null
          } else if (c === '"' || c === "'") q = c
          else if (c === '(') depth++
          else if (c === ')') depth--
          k++
        }
        arg = compound.slice(j + 1, k - 1).trim()
        j = k
      }
      i = j
      if (pseudo === 'not') {
        if (matchesSelector(el, arg)) return false
      } else if (pseudo === 'checked') {
        if (!el.checked) return false
      } else if (pseudo === 'disabled') {
        if (!el.disabled) return false
      } else if (pseudo === 'enabled') {
        if (el.disabled) return false
      } else if (pseudo === 'empty') {
        if (el.childNodes.length > 0) return false
      } else if (pseudo === 'focus') {
        if (!el._ownerDoc || el._ownerDoc.activeElement !== el) return false
      } else if (pseudo === 'first-child') {
        if (!el.parentElement || el.parentElement.firstElementChild !== el) return false
      } else if (pseudo === 'last-child') {
        if (!el.parentElement || el.parentElement.lastElementChild !== el) return false
      } else if (pseudo === 'nth-child') {
        if (!el.parentElement) return false
        const idx = el.parentElement.children.indexOf(el) + 1
        const n = Number.parseInt(arg, 10)
        if (Number.isFinite(n) && idx !== n) return false
      } else if (pseudo === 'hover' || pseudo === 'focus-visible' || pseudo === 'is' || pseudo === 'where') {
        if ((pseudo === 'is' || pseudo === 'where') && !matchesSelector(el, arg)) return false
      } else {
        return false
      }
      continue
    }

    let j = i
    while (j < len && !/[#.\[:\s]/.test(compound[j])) j++
    const tag = compound.slice(i, j).toUpperCase()
    if (el.tagName !== tag) return false
    i = j
  }
  return true
}

function matchComplexRightToLeft(el: FakeElement, parts: CombinatorPart[], idx: number): boolean {
  if (!matchesCompound(el, parts[idx].compound)) return false
  if (idx === 0) return true
  const comb = parts[idx].combinator
  if (comb === '>') {
    return el.parentElement ? matchComplexRightToLeft(el.parentElement, parts, idx - 1) : false
  }
  if (comb === ' ') {
    let anc = el.parentElement
    while (anc) {
      if (matchComplexRightToLeft(anc, parts, idx - 1)) return true
      anc = anc.parentElement
    }
    return false
  }
  if (comb === '+') {
    const prev = el.previousElementSibling
    return prev ? matchComplexRightToLeft(prev, parts, idx - 1) : false
  }
  if (comb === '~') {
    let prev = el.previousElementSibling
    while (prev) {
      if (matchComplexRightToLeft(prev, parts, idx - 1)) return true
      prev = prev.previousElementSibling
    }
    return false
  }
  return false
}

const compiledSelectorCache = new Map<string, CombinatorPart[][]>()

function compileSelector(selector: string): CombinatorPart[][] {
  const key = String(selector || '')
  let compiled = compiledSelectorCache.get(key)
  if (!compiled) {
    compiled = []
    for (const branch of splitTopLevelSelectors(key, ',')) {
      const parts = parseComplexSelector(branch)
      if (parts.length > 0) compiled.push(parts)
    }
    if (compiledSelectorCache.size >= 2000) compiledSelectorCache.clear()
    compiledSelectorCache.set(key, compiled)
  }
  return compiled
}

function matchesCompiled(el: FakeElement, compiled: CombinatorPart[][]): boolean {
  for (let i = 0; i < compiled.length; i++) {
    const parts = compiled[i]
    if (matchComplexRightToLeft(el, parts, parts.length - 1)) return true
  }
  return false
}

export function matchesSelector(el: FakeElement, selector: string): boolean {
  return matchesCompiled(el, compileSelector(selector))
}

export class FakeDocument extends FakeEventTarget {
  defaultView: FakeWindow | null = null
  documentElement: FakeElement
  head: FakeElement
  body: FakeElement
  activeElement: FakeElement | null = null
  visibilityState = 'visible'
  title = 'Datanoa Test'

  constructor() {
    super()
    this.documentElement = new FakeElement('html', this)
    this.head = new FakeElement('head', this)
    this.body = new FakeElement('body', this)
    this.documentElement.append(this.head, this.body)
  }

  createElement(tagName: string): FakeElement {
    return createFakeElement(tagName, this, false)
  }

  createElementNS(_ns: string, tagName: string): FakeElement {
    return createFakeElement(tagName, this, String(_ns).toLowerCase().includes('svg'))
  }

  createTextNode(text: string): FakeText {
    return new FakeText(text, this)
  }

  createComment(text: string): FakeComment {
    return new FakeComment(text, this)
  }

  createDocumentFragment(): FakeDocumentFragment {
    return new FakeDocumentFragment(this)
  }

  createRange() {
    return {
      setStart() {},
      setEnd() {},
      setStartBefore() {},
      setEndAfter() {},
      collapse() {},
      selectNodeContents() {},
      cloneRange() {
        return this
      },
      compareBoundaryPoints: () => 0,
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 8, bottom: 14, width: 8, height: 14 }),
      getClientRects: () => [{ left: 0, top: 0, right: 8, bottom: 14, width: 8, height: 14 }],
    }
  }

  getSelection() {
    const createFallbackRange = () => this.createRange()
    return {
      anchorNode: null,
      anchorOffset: 0,
      focusNode: null,
      focusOffset: 0,
      isCollapsed: true,
      rangeCount: 0,
      removeAllRanges() {},
      addRange() {},
      collapse() {},
      collapseToStart() {},
      collapseToEnd() {},
      selectAllChildren() {},
      extend() {},
      setBaseAndExtent() {},
      containsNode: () => false,
      getRangeAt: createFallbackRange,
      toString: () => '',
    }
  }

  hasFocus(): boolean {
    return true
  }

  execCommand = (): boolean => true

  getElementById(id: string): FakeElement | null {
    const target = String(id ?? '')
    if (!target) return null
    const walkPreOrder = (root: FakeElement): FakeElement | null => {
      const nodes = root.childNodes
      for (let i = 0; i < nodes.length; i++) {
        const ch = nodes[i]
        if (ch instanceof FakeElement) {
          if (ch.id === target) return ch
          if (ch.childNodes.length > 0) {
            const hit = walkPreOrder(ch)
            if (hit) return hit
          }
        }
      }
      return null
    }
    return walkPreOrder(this.body) ?? walkPreOrder(this.head)
  }

  querySelector(selector: string): FakeElement | null {
    return this.body.querySelector(selector) ?? this.head.querySelector(selector)
  }

  querySelectorAll(selector: string): FakeElement[] {
    return [...this.head.querySelectorAll(selector), ...this.body.querySelectorAll(selector)]
  }

  getElementsByTagName(tagName: string): FakeElement[] {
    return [...this.head.getElementsByTagName(tagName), ...this.body.getElementsByTagName(tagName)]
  }

  getElementsByClassName(cls: string): FakeElement[] {
    return [...this.head.getElementsByClassName(cls), ...this.body.getElementsByClassName(cls)]
  }
}

export class FakeStorage {
  private map = new Map<string, string>()
  get length(): number {
    return this.map.size
  }
  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null
  }
  getItem(k: string): string | null {
    return this.map.get(String(k)) ?? null
  }
  setItem(k: string, v: string): void {
    this.map.set(String(k), String(v))
  }
  removeItem(k: string): void {
    this.map.delete(String(k))
  }
  clear(): void {
    this.map.clear()
  }
}

export class FakeWindow extends FakeEventTarget {
  document: FakeDocument
  innerWidth = 1280
  innerHeight = 800
  devicePixelRatio = 1
  localStorage = new FakeStorage()
  sessionStorage = new FakeStorage()
  closedWindows: unknown[] = []
  openedUrls: Array<{ url: string; target?: string }> = []
  confirmResult = true
  promptResult: string | null = 'ok'
  alertMessages: string[] = []
  private _rafSeq = 1
  private _rafQueue = new Map<number, (ts: number) => void>()

  constructor(doc: FakeDocument) {
    super()
    this.document = doc
    doc.defaultView = this
  }

  getComputedStyle = (el: FakeElement) => ({
    getPropertyValue: (prop: string) => el.style.getPropertyValue(prop),
    display: el.style.getPropertyValue('display') || 'block',
    visibility: el.style.getPropertyValue('visibility') || 'visible',
  })

  getSelection = () => this.document.getSelection()

  requestAnimationFrame = (cb: (ts: number) => void): number => {
    const id = this._rafSeq++
    this._rafQueue.set(id, cb)
    return id
  }

  cancelAnimationFrame = (id: number): void => {
    this._rafQueue.delete(id)
  }

  setTimeout = (...args: Parameters<typeof globalThis.setTimeout>) => globalThis.setTimeout(...args)
  clearTimeout = (id?: ReturnType<typeof globalThis.setTimeout>) => globalThis.clearTimeout(id)
  setInterval = (...args: Parameters<typeof globalThis.setInterval>) => globalThis.setInterval(...args)
  clearInterval = (id?: ReturnType<typeof globalThis.setInterval>) => globalThis.clearInterval(id)
  queueMicrotask = (cb: VoidFunction) => globalThis.queueMicrotask(cb)

  runRaf(maxFrames = 10): number {
    let executed = 0
    while (this._rafQueue.size > 0 && executed < maxFrames) {
      const entries = Array.from(this._rafQueue.entries())
      this._rafQueue.clear()
      for (const [, cb] of entries) {
        cb(performance.now())
        executed++
      }
    }
    return executed
  }

  matchMedia = (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  })

  open = (url = '', target = '') => {
    this.openedUrls.push({ url: String(url), target })
    return { focus() {}, close() {} }
  }

  confirm = () => this.confirmResult
  prompt = () => this.promptResult
  alert = (msg: string) => {
    this.alertMessages.push(String(msg ?? ''))
  }
}

export interface DomHarness {
  window: FakeWindow
  document: FakeDocument
  body: FakeElement
  head: FakeElement
  localStorage: FakeStorage
  sessionStorage: FakeStorage
  clipboardWrites: string[]
  clipboardReadText: string
  setClipboardReadText: (v: string) => void
  createdObjectUrls: string[]
  revokedObjectUrls: string[]
  mountPanelHtml: () => void
  fireKey: (
    target: FakeNode | FakeDocument | FakeWindow,
    key: string,
    opts?: Record<string, unknown>
  ) => boolean
  click: (target: FakeElement) => void
  setInput: (el: FakeElement, value: string | boolean, eventName?: string) => void
  flushMicrotasks: () => Promise<void>
  runRaf: () => number
  teardown: () => void
}

export function installDomHarness(): DomHarness {
  const doc = new FakeDocument()
  const win = new FakeWindow(doc)

  let clipboardReadText = ''
  const clipboardWrites: string[] = []
  const createdObjectUrls: string[] = []
  const revokedObjectUrls: string[] = []

  class FakeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return []
    }
  }

  class FakeDOMParser {
    parseFromString(str: string) {
      const parsedDoc = new FakeDocument()
      const m = /<body[^>]*>([\s\S]*)<\/body>/i.exec(str)
      parsedDoc.body.innerHTML = m ? m[1] : str
      return parsedDoc
    }
  }

  const savedDescriptors = new Map<string, PropertyDescriptor | undefined>()
  const g = globalThis as Record<string, unknown>

  const setGlobal = (key: string, val: unknown): void => {
    if (!savedDescriptors.has(key)) {
      savedDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    }
    try {
      Object.defineProperty(globalThis, key, {
        configurable: true,
        writable: true,
        value: val,
      })
    } catch {
      g[key] = val
    }
  }

  const origCreateObjUrl = URL.createObjectURL
  const origRevokeObjUrl = URL.revokeObjectURL
  let urlSeq = 1
  URL.createObjectURL = ((_blob: unknown) => {
    const u = `blob:datanoa-test-${urlSeq++}`
    createdObjectUrls.push(u)
    return u
  }) as typeof URL.createObjectURL
  URL.revokeObjectURL = ((u: string) => {
    revokedObjectUrls.push(String(u))
  }) as typeof URL.revokeObjectURL

  const navObj = {
    userAgent: 'DatanoaTest/1.0',
    platform: 'Win32',
    clipboard: {
      writeText: async (txt: string) => {
        clipboardWrites.push(String(txt))
        clipboardReadText = String(txt)
      },
      readText: async () => clipboardReadText,
    },
  }

  const globalsToInstall: Record<string, unknown> = {
    Window: FakeWindow,
    window: win,
    self: win,
    document: doc,
    Document: FakeDocument,
    Node: FakeNode,
    Text: FakeText,
    Comment: FakeComment,
    DocumentFragment: FakeDocumentFragment,
    Element: FakeElement,
    HTMLElement: FakeElement,
    HTMLInputElement: FakeHTMLInputElement,
    HTMLTextAreaElement: FakeHTMLTextAreaElement,
    HTMLSelectElement: FakeHTMLSelectElement,
    HTMLOptionElement: FakeHTMLOptionElement,
    Option: class FakeOption extends FakeHTMLOptionElement {
      constructor(
        text = '',
        value?: string,
        defaultSelected = false,
        selected?: boolean,
      ) {
        super('option', doc)
        if (text !== undefined && text !== null) {
          this.textContent = String(text)
        }
        if (value !== undefined) {
          this.value = String(value)
        } else {
          this.value = String(text ?? '')
        }
        if (defaultSelected) {
          this.setAttribute('selected', '')
        }
        if (selected !== undefined) {
          this.selected = Boolean(selected)
        }
      }
    },
    HTMLButtonElement: FakeHTMLButtonElement,
    HTMLFormElement: FakeHTMLFormElement,
    HTMLTableElement: FakeHTMLTableElement,
    HTMLTableRowElement: FakeHTMLTableRowElement,
    HTMLTableCellElement: FakeHTMLTableCellElement,
    HTMLAnchorElement: FakeHTMLAnchorElement,
    SVGElement: FakeSVGElement,
    Event: FakeEvent,
    CustomEvent: FakeCustomEvent,
    MouseEvent: FakeMouseEvent,
    PointerEvent: FakePointerEvent,
    KeyboardEvent: FakeKeyboardEvent,
    InputEvent: FakeInputEvent,
    ClipboardEvent: FakeClipboardEvent,
    WheelEvent: FakeWheelEvent,
    FocusEvent: FakeFocusEvent,
    DragEvent: FakeDragEvent,
    DataTransfer: FakeDataTransfer,
    localStorage: win.localStorage,
    sessionStorage: win.sessionStorage,
    navigator: navObj,
    MutationObserver: FakeObserver,
    ResizeObserver: FakeObserver,
    IntersectionObserver: FakeObserver,
    DOMParser: FakeDOMParser,
    requestAnimationFrame: win.requestAnimationFrame,
    cancelAnimationFrame: win.cancelAnimationFrame,
    getComputedStyle: win.getComputedStyle,
    matchMedia: win.matchMedia,
    alert: win.alert,
    confirm: win.confirm,
    prompt: win.prompt,
    CSS: { escape: (s: string) => String(s).replace(/([^\w-])/g, '\\$1') },
  }

  for (const [k, v] of Object.entries(globalsToInstall)) {
    setGlobal(k, v)
  }

  return {
    window: win,
    document: doc,
    body: doc.body,
    head: doc.head,
    localStorage: win.localStorage,
    sessionStorage: win.sessionStorage,
    clipboardWrites,
    get clipboardReadText() {
      return clipboardReadText
    },
    setClipboardReadText(v: string) {
      clipboardReadText = String(v)
    },
    createdObjectUrls,
    revokedObjectUrls,
    mountPanelHtml() {
      const panelHtmlPath = path.resolve(process.cwd(), 'src', 'panel', 'panel.html')
      const rawHtml = fs.readFileSync(panelHtmlPath, 'utf8')
      const bodyMatch = /<body[^>]*>([\s\S]*)<\/body>/i.exec(rawHtml)
      doc.body.innerHTML = bodyMatch ? bodyMatch[1] : rawHtml
    },
    fireKey(target, key, opts = {}) {
      const ev = new FakeKeyboardEvent('keydown', { key, ...opts })
      return target.dispatchEvent(ev)
    },
    click(target) {
      target.click()
    },
    setInput(el, value, eventName = 'input') {
      if (typeof value === 'boolean') {
        el.checked = value
        el.dispatchEvent(new FakeEvent(eventName === 'input' ? 'change' : eventName, { bubbles: true }))
      } else {
        el.value = value
        el.dispatchEvent(new FakeEvent(eventName, { bubbles: true }))
      }
    },
    async flushMicrotasks() {
      await Promise.resolve()
      await new Promise((r) => setTimeout(r, 0))
    },
    runRaf() {
      return win.runRaf()
    },
    teardown() {
      URL.createObjectURL = origCreateObjUrl
      URL.revokeObjectURL = origRevokeObjUrl
      for (const [key, desc] of savedDescriptors.entries()) {
        if (desc === undefined) {
          delete g[key]
        } else {
          try {
            Object.defineProperty(globalThis, key, desc)
          } catch {
            // Best-effort restore
          }
        }
      }
    },
  }
}
