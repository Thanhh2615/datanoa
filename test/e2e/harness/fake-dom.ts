/**
 * test/e2e/harness/fake-dom.ts
 *
 * Typed, zero-dependency in-memory Fake DOM harness for Datanoa E2E tests.
 * Zero `any`, zero `!` non-null assertions, strict TypeScript compliant.
 */

export interface TrackedListenerEntry {
  targetTag: string
  type: string
  listener: (event: unknown) => void
  passive?: boolean
}

export interface FakeClipboardData {
  getData(type: string): string
  setData?(type: string, data: string): void
}

export interface FakeEventInit {
  type: string
  key?: string
  code?: string
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
  button?: number
  buttons?: number
  deltaX?: number
  deltaY?: number
  deltaMode?: number
  clientX?: number
  clientY?: number
  bubbles?: boolean
  cancelable?: boolean
  detail?: number
  clipboardData?: FakeClipboardData
  target?: FakeNode | null
  relatedTarget?: FakeNode | null
}

export interface FakeDOMRectInit {
  top?: number
  left?: number
  right?: number
  bottom?: number
  width?: number
  height?: number
  x?: number
  y?: number
}

export interface FakeDOMRect {
  top: number
  left: number
  right: number
  bottom: number
  width: number
  height: number
  x: number
  y: number
  toJSON: () => Record<string, never>
}

export interface FakeStorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem?(key: string): void
  clear?(): void
}

export type FakeListenerOptions =
  | boolean
  | {
      passive?: boolean
      capture?: boolean
      once?: boolean
    }

export class FakeEvent {
  public readonly type: string
  public readonly key: string
  public readonly code: string
  public readonly ctrlKey: boolean
  public readonly metaKey: boolean
  public readonly shiftKey: boolean
  public readonly altKey: boolean
  public readonly button: number
  public readonly buttons: number
  public readonly deltaX: number
  public readonly deltaY: number
  public readonly deltaMode: number
  public readonly clientX: number
  public readonly clientY: number
  public readonly bubbles: boolean
  public readonly cancelable: boolean
  public readonly detail: number
  public readonly clipboardData?: FakeClipboardData
  public readonly relatedTarget: FakeNode | null
  public defaultPrevented = false
  public propagationStopped = false
  public immediatePropagationStopped = false
  public target: FakeNode | null
  public currentTarget: FakeNode | null = null

  constructor(init: FakeEventInit) {
    this.type = init.type
    this.key = init.key ?? ''
    this.code = init.code ?? ''
    this.ctrlKey = Boolean(init.ctrlKey)
    this.metaKey = Boolean(init.metaKey)
    this.shiftKey = Boolean(init.shiftKey)
    this.altKey = Boolean(init.altKey)
    this.button = init.button ?? 0
    this.buttons = init.buttons ?? 0
    this.deltaX = init.deltaX ?? 0
    this.deltaY = init.deltaY ?? 0
    this.deltaMode = init.deltaMode ?? 0
    this.clientX = init.clientX ?? 0
    this.clientY = init.clientY ?? 0
    this.bubbles = init.bubbles ?? false
    this.cancelable = init.cancelable ?? true
    this.detail = init.detail ?? 0
    this.clipboardData = init.clipboardData
    this.target = init.target ?? null
    this.relatedTarget = init.relatedTarget ?? null
  }

  public preventDefault(): void {
    this.defaultPrevented = true
  }

  public stopPropagation(): void {
    this.propagationStopped = true
  }

  public stopImmediatePropagation(): void {
    this.propagationStopped = true
    this.immediatePropagationStopped = true
  }

  public composedPath(): FakeNode[] {
    const pathNodes: FakeNode[] = []
    let cur: FakeNode | null = this.target
    while (cur) {
      pathNodes.push(cur)
      cur = cur.parentNode
    }
    return pathNodes
  }
}

function kebabToCamel(input: string): string {
  return input.replace(/-([a-z])/g, (_m, ch: string) => ch.toUpperCase())
}

function camelToKebab(input: string): string {
  return input.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)
}

function decodeBasicHtmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

function parsePxNumber(raw: string): number | undefined {
  if (!raw) return undefined
  const m = /^-?\d+(?:\.\d+)?(?=px$|$)/.exec(raw.trim())
  if (!m) return undefined
  const num = Number(m[0])
  return Number.isFinite(num) ? num : undefined
}

const styleCustomPropsMap = new WeakMap<FakeStyleDeclaration, Map<string, string>>()

export class FakeStyleDeclaration {
  [key: string]: unknown
  public width = ''
  public height = ''
  public display = ''
  public cursor = ''
  public userSelect = ''
  public flex = ''
  public left = ''
  public top = ''
  public right = ''
  public bottom = ''
  public position = ''
  public opacity = ''
  public visibility = ''
  public background = ''
  public color = ''
  public minWidth = ''
  public maxWidth = ''
  public minHeight = ''
  public maxHeight = ''
  public padding = ''
  public margin = ''
  public marginLeft = ''
  public marginTop = ''
  public border = ''
  public zIndex = ''
  public overflow = ''
  public overflowX = ''
  public overflowY = ''
  public pointerEvents = ''
  public transform = ''
  public whiteSpace = ''
  public fontWeight = ''

  public setProperty(name: string, value: string | null): void {
    let custom = styleCustomPropsMap.get(this)
    if (!custom) {
      custom = new Map<string, string>()
      styleCustomPropsMap.set(this, custom)
    }
    if (value === null || value === '') {
      custom.delete(name)
      Reflect.deleteProperty(this, name)
    } else {
      const str = String(value)
      custom.set(name, str)
      this[name] = str
    }
  }

  public getPropertyValue(name: string): string {
    const custom = styleCustomPropsMap.get(this)?.get(name)
    if (custom !== undefined) return custom
    const direct = this[name]
    return typeof direct === 'string' ? direct : ''
  }

  public removeProperty(name: string): string {
    const prev = this.getPropertyValue(name)
    styleCustomPropsMap.get(this)?.delete(name)
    Reflect.deleteProperty(this, name)
    return prev
  }
}

export class FakeNode {
  public readonly nodeType: number
  public parentNode: FakeNode | null = null
  public readonly childNodes: FakeNode[] = []
  public ownerDocument: FakeDocumentLike | null = null
  protected readonly listenerMap = new Map<string, Set<(event: unknown) => void>>()
  protected readonly tracker?: FakeDomHarness

  constructor(nodeType = 1, tracker?: FakeDomHarness) {
    this.nodeType = nodeType
    this.tracker = tracker
    this.ownerDocument = tracker?.document ?? null
  }

  public get parentElement(): FakeElement | null {
    return this.parentNode instanceof FakeElement ? this.parentNode : null
  }

  public get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null
  }

  public get lastChild(): FakeNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null
  }

  public get nextSibling(): FakeNode | null {
    if (!this.parentNode) return null
    const idx = this.parentNode.childNodes.indexOf(this)
    return idx >= 0 ? (this.parentNode.childNodes[idx + 1] ?? null) : null
  }

  public get previousSibling(): FakeNode | null {
    if (!this.parentNode) return null
    const idx = this.parentNode.childNodes.indexOf(this)
    return idx > 0 ? (this.parentNode.childNodes[idx - 1] ?? null) : null
  }

  public get isConnected(): boolean {
    let cur: FakeNode | null = this
    while (cur) {
      if (
        this.tracker &&
        (cur === this.tracker.body ||
          cur === this.tracker.head ||
          cur === this.tracker.documentElement)
      ) {
        return true
      }
      cur = cur.parentNode
    }
    return false
  }

  public get textContent(): string {
    return ''
  }

  public set textContent(_value: string | null) {
    // Overridden by subclasses
  }

  public get nodeValue(): string | null {
    return null
  }

  public set nodeValue(_value: string | null) {
    // Overridden by FakeTextNode
  }

  public contains(other: FakeNode | null): boolean {
    if (!other) return false
    let cur: FakeNode | null = other
    while (cur) {
      if (cur === this) return true
      cur = cur.parentNode
    }
    return false
  }

  public appendChild<T extends FakeNode>(child: T): T {
    return this.insertBefore(child, null)
  }

  public insertBefore<T extends FakeNode>(newNode: T, refNode: FakeNode | null): T {
    if (newNode instanceof FakeDocumentFragment) {
      const items = [...newNode.childNodes]
      for (const item of items) {
        this.insertBefore(item, refNode)
      }
      return newNode
    }
    if (newNode.parentNode) {
      const prevIdx = newNode.parentNode.childNodes.indexOf(newNode)
      if (prevIdx >= 0) newNode.parentNode.childNodes.splice(prevIdx, 1)
    }
    newNode.parentNode = this
    if (refNode) {
      const refIdx = this.childNodes.indexOf(refNode)
      if (refIdx >= 0) {
        this.childNodes.splice(refIdx, 0, newNode)
        return newNode
      }
    }
    this.childNodes.push(newNode)
    return newNode
  }

  public removeChild<T extends FakeNode>(child: T): T {
    const idx = this.childNodes.indexOf(child)
    if (idx >= 0) {
      this.childNodes.splice(idx, 1)
      child.parentNode = null
    }
    return child
  }

  public replaceChild<T extends FakeNode>(newChild: FakeNode, oldChild: T): T {
    this.insertBefore(newChild, oldChild)
    this.removeChild(oldChild)
    return oldChild
  }

  public remove(): void {
    if (this.parentNode) {
      const idx = this.parentNode.childNodes.indexOf(this)
      if (idx >= 0) this.parentNode.childNodes.splice(idx, 1)
      this.parentNode = null
    }
  }

  public cloneNode(_deep?: boolean): FakeNode {
    return new FakeNode(this.nodeType, this.tracker)
  }
}

export class FakeTextNode extends FakeNode {
  public data: string

  constructor(data: string, tracker?: FakeDomHarness) {
    super(3, tracker)
    this.data = String(data ?? '')
  }

  public override get textContent(): string {
    return this.data
  }

  public override set textContent(value: string | null) {
    this.data = value === null || value === undefined ? '' : String(value)
  }

  public override get nodeValue(): string {
    return this.data
  }

  public override set nodeValue(value: string | null) {
    this.data = value === null || value === undefined ? '' : String(value)
  }

  public override cloneNode(): FakeTextNode {
    return new FakeTextNode(this.data, this.tracker)
  }
}

export class FakeDocumentFragment extends FakeNode {
  constructor(tracker?: FakeDomHarness) {
    super(11, tracker)
  }

  public override cloneNode(deep?: boolean): FakeDocumentFragment {
    const frag = new FakeDocumentFragment(this.tracker)
    if (deep) {
      for (const child of this.childNodes) {
        frag.appendChild(child.cloneNode(true))
      }
    }
    return frag
  }
}

type AttrOperator = '=' | '^=' | '$=' | '*=' | '~='

interface AttrMatcher {
  name: string
  op?: AttrOperator
  value?: string
}

interface CompoundSelectorPart {
  tag?: string
  id?: string
  classes: string[]
  attrs: AttrMatcher[]
  pseudos: string[]
  notParts: CompoundSelectorPart[]
}

function splitSelectorBranches(selector: string): string[] {
  const branches: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let bracketDepth = 0
  let parenDepth = 0

  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i]
    if (quote) {
      current += ch
      if (ch === '\\' && i + 1 < selector.length) {
        current += selector[++i]
      } else if (ch === quote) {
        quote = null
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    if (ch === '[') bracketDepth++
    else if (ch === ']' && bracketDepth > 0) bracketDepth--
    else if (ch === '(') parenDepth++
    else if (ch === ')' && parenDepth > 0) parenDepth--

    if (ch === ',' && bracketDepth === 0 && parenDepth === 0) {
      if (current.trim()) branches.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }

  if (current.trim()) branches.push(current.trim())
  return branches
}

function tokenizeComplexSelector(branch: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let bracketDepth = 0
  let parenDepth = 0

  for (let i = 0; i < branch.length; i++) {
    const ch = branch[i]
    if (quote) {
      current += ch
      if (ch === '\\' && i + 1 < branch.length) {
        current += branch[++i]
      } else if (ch === quote) {
        quote = null
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    if (ch === '[') {
      bracketDepth++
      current += ch
      continue
    }
    if (ch === ']' && bracketDepth > 0) {
      bracketDepth--
      current += ch
      continue
    }
    if (ch === '(') {
      parenDepth++
      current += ch
      continue
    }
    if (ch === ')' && parenDepth > 0) {
      parenDepth--
      current += ch
      continue
    }

    if (bracketDepth === 0 && parenDepth === 0) {
      if (/\s/.test(ch)) {
        if (current) {
          tokens.push(current)
          current = ''
        }
        continue
      }
      if (ch === '>') {
        if (current) {
          tokens.push(current)
          current = ''
        }
        tokens.push('>')
        continue
      }
    }
    current += ch
  }

  if (current) tokens.push(current)
  return tokens
}

function parseCompoundSelector(part: string): CompoundSelectorPart {
  let rest = part.trim()
  let tag: string | undefined
  let id: string | undefined
  const classes: string[] = []
  const attrs: AttrMatcher[] = []
  const pseudos: string[] = []
  const notParts: CompoundSelectorPart[] = []

  if (rest.startsWith('*')) {
    rest = rest.slice(1)
  } else {
    const tagMatch = /^[a-zA-Z][a-zA-Z0-9_-]*/.exec(rest)
    if (tagMatch) {
      tag = tagMatch[0].toLowerCase()
      rest = rest.slice(tagMatch[0].length)
    }
  }

  while (rest.length > 0) {
    if (rest.startsWith('#')) {
      const m = /^#([a-zA-Z0-9_-]+)/.exec(rest)
      if (!m) break
      id = m[1]
      rest = rest.slice(m[0].length)
    } else if (rest.startsWith('.')) {
      const m = /^\.([a-zA-Z0-9_-]+)/.exec(rest)
      if (!m) break
      classes.push(m[1])
      rest = rest.slice(m[0].length)
    } else if (rest.startsWith('[')) {
      const m =
        /^\[\s*([a-zA-Z0-9_:-]+)\s*(?:(\^=|\$=|\*=|~=|=)\s*(?:"([^"]*)"|'([^']*)'|([^\]]*?))\s*)?\]/.exec(
          rest
        )
      if (!m) break
      const op = m[2] as AttrOperator | undefined
      const val = m[3] ?? m[4] ?? m[5]
      attrs.push({ name: m[1], op, value: val })
      rest = rest.slice(m[0].length)
    } else if (rest.startsWith(':not(')) {
      let depth = 0
      let endIdx = -1
      for (let i = 4; i < rest.length; i++) {
        if (rest[i] === '(') depth++
        else if (rest[i] === ')') {
          depth--
          if (depth === 0) {
            endIdx = i
            break
          }
        }
      }
      if (endIdx < 0) break
      const inner = rest.slice(5, endIdx).trim()
      if (inner) {
        notParts.push(parseCompoundSelector(inner))
      }
      rest = rest.slice(endIdx + 1)
    } else if (rest.startsWith(':')) {
      const m = /^:([a-zA-Z0-9_-]+)/.exec(rest)
      if (!m) break
      pseudos.push(m[1].toLowerCase())
      rest = rest.slice(m[0].length)
    } else {
      break
    }
  }

  return { tag, id, classes, attrs, pseudos, notParts }
}

function matchesAttr(actual: string | null, attr: AttrMatcher): boolean {
  if (actual === null) return false
  if (attr.value === undefined) return true
  const op = attr.op ?? '='
  if (op === '=') return actual === attr.value
  if (op === '^=') return actual.startsWith(attr.value)
  if (op === '$=') return actual.endsWith(attr.value)
  if (op === '*=') return actual.includes(attr.value)
  if (op === '~=') return actual.split(/\s+/).includes(attr.value)
  return false
}

function isElementDisabled(el: FakeElement): boolean {
  if (
    el instanceof FakeHTMLButtonElement ||
    el instanceof FakeHTMLInputElement ||
    el instanceof FakeHTMLSelectElement
  ) {
    return el.disabled
  }
  return el.hasAttribute('disabled')
}

function matchesCompound(el: FakeElement, sel: CompoundSelectorPart): boolean {
  if (sel.tag && el.tagName.toLowerCase() !== sel.tag) return false
  if (sel.id && el.id !== sel.id) return false
  for (const cls of sel.classes) {
    if (!el.classList.contains(cls)) return false
  }
  for (const attr of sel.attrs) {
    if (!matchesAttr(el.getAttribute(attr.name), attr)) return false
  }
  for (const pseudo of sel.pseudos) {
    if (pseudo === 'disabled') {
      if (!isElementDisabled(el)) return false
    } else if (pseudo === 'enabled') {
      if (isElementDisabled(el)) return false
    } else if (pseudo === 'checked') {
      if (!(el instanceof FakeHTMLInputElement) || !el.checked) return false
    } else if (pseudo === 'focus') {
      if (!el.ownerDocument || el.ownerDocument.activeElement !== el) return false
    } else {
      return false
    }
  }
  for (const negated of sel.notParts) {
    if (matchesCompound(el, negated)) return false
  }
  return true
}

type SelectorStep = { combinator: ' ' | '>'; part: CompoundSelectorPart }

function parseComplexSelector(selector: string): SelectorStep[] {
  const rawTokens = tokenizeComplexSelector(selector.trim())
  const steps: SelectorStep[] = []
  let pendingCombinator: ' ' | '>' = ' '

  for (const tok of rawTokens) {
    if (tok === '>') {
      pendingCombinator = '>'
      continue
    }
    steps.push({ combinator: pendingCombinator, part: parseCompoundSelector(tok) })
    pendingCombinator = ' '
  }
  return steps
}

function matchesComplexSelector(el: FakeElement, steps: SelectorStep[]): boolean {
  if (steps.length === 0) return false
  const last = steps[steps.length - 1]
  if (!matchesCompound(el, last.part)) return false

  let current: FakeElement | null = el
  for (let i = steps.length - 2; i >= 0; i--) {
    const combinator = steps[i + 1].combinator
    const targetPart = steps[i].part
    if (combinator === '>') {
      const parent: FakeElement | null = current?.parentElement ?? null
      if (!parent || !matchesCompound(parent, targetPart)) return false
      current = parent
    } else {
      let ancestor: FakeElement | null = current?.parentElement ?? null
      let matched = false
      while (ancestor) {
        if (matchesCompound(ancestor, targetPart)) {
          matched = true
          current = ancestor
          break
        }
        ancestor = ancestor.parentElement
      }
      if (!matched) return false
    }
  }
  return true
}

export class FakeClassList {
  private readonly owner: FakeElement
  private readonly tokens = new Set<string>()

  constructor(owner: FakeElement) {
    this.owner = owner
  }

  public syncFromString(raw: string): void {
    this.tokens.clear()
    for (const part of raw.split(/\s+/)) {
      if (part) this.tokens.add(part)
    }
  }

  public toString(): string {
    return Array.from(this.tokens).join(' ')
  }

  public add(...names: string[]): void {
    for (const name of names) {
      for (const part of String(name).split(/\s+/)) {
        if (part) this.tokens.add(part)
      }
    }
  }

  public remove(...names: string[]): void {
    for (const name of names) {
      this.tokens.delete(name)
    }
  }

  public contains(name: string): boolean {
    return this.tokens.has(name)
  }

  public toggle(name: string, force?: boolean): boolean {
    const shouldAdd = force !== undefined ? force : !this.tokens.has(name)
    if (shouldAdd) {
      this.tokens.add(name)
      return true
    }
    this.tokens.delete(name)
    return false
  }
}

export interface FakeDocumentLike {
  body: FakeHTMLElement
  head: FakeHTMLElement
  documentElement: FakeHTMLElement
  defaultView: FakeWindow
  activeElement: FakeElement | null
  styleSheets: unknown[]
  adoptedStyleSheets: unknown[]
  createElement: (tagName: string) => FakeElement
  createElementNS: (_ns: string, tagName: string) => FakeElement
  createTextNode: (data: string) => FakeTextNode
  createDocumentFragment: () => FakeDocumentFragment
  createRange: () => {
    setStart: () => void
    setEnd: () => void
    collapse: () => void
    selectNodeContents: () => void
    getClientRects: () => unknown[]
    getBoundingClientRect: () => {
      top: number
      left: number
      right: number
      bottom: number
      width: number
      height: number
      x: number
      y: number
    }
  }
  querySelector: <T extends FakeElement = FakeElement>(selector: string) => T | null
  querySelectorAll: <T extends FakeElement = FakeElement>(selector: string) => T[]
  getElementById: (id: string) => FakeElement | null
  hasFocus: () => boolean
  getSelection: () => {
    rangeCount: number
    anchorNode: FakeNode | null
    focusNode: FakeNode | null
    removeAllRanges: () => void
    addRange: () => void
  }
  addEventListener: (
    type: string,
    listener: (event: unknown) => void,
    options?: FakeListenerOptions
  ) => void
  removeEventListener: (
    type: string,
    listener: (event: unknown) => void,
    options?: FakeListenerOptions
  ) => void
  dispatchEvent: (event: FakeEvent) => boolean
  execCommand: (cmd: string) => boolean
}

export class FakeElement extends FakeNode {
  public readonly tagName: string
  public id = ''
  public readonly classList: FakeClassList
  public readonly style: FakeStyleDeclaration = new FakeStyleDeclaration()
  public readonly attributes = new Map<string, string>()
  public readonly dataset: Record<string, string>
  public colSpan = 1
  public rowSpan = 1
  public scrollLeft = 0
  public scrollTop = 0
  public scrollHeight = 1200
  public scrollWidth = 4800
  public clientHeight = 600
  public clientWidth = 800
  public offsetWidth = 150
  public offsetHeight = 28
  public offsetLeft = 0
  public offsetTop = 0
  private _hidden = false
  private _tabIndex = 0
  private _text = ''
  private _rawInnerHtml = ''
  private customRect: FakeDOMRectInit | null = null
  private readonly onceListeners = new Map<string, WeakSet<(event: unknown) => void>>()

  constructor(tagName: string, tracker?: FakeDomHarness) {
    super(1, tracker)
    this.tagName = tagName.toUpperCase()
    this.classList = new FakeClassList(this)
    const attrs = this.attributes
    this.dataset = new Proxy<Record<string, string>>(
      {},
      {
        get(_target, prop): string | undefined {
          if (typeof prop !== 'string') return undefined
          return attrs.get(`data-${camelToKebab(prop)}`)
        },
        set(_target, prop, value): boolean {
          if (typeof prop !== 'string') return false
          attrs.set(`data-${camelToKebab(prop)}`, String(value))
          return true
        },
        deleteProperty(_target, prop): boolean {
          if (typeof prop !== 'string') return false
          return attrs.delete(`data-${camelToKebab(prop)}`)
        },
        has(_target, prop): boolean {
          if (typeof prop !== 'string') return false
          return attrs.has(`data-${camelToKebab(prop)}`)
        },
        ownKeys(): string[] {
          const keys: string[] = []
          for (const key of attrs.keys()) {
            if (key.startsWith('data-')) {
              keys.push(kebabToCamel(key.slice(5)))
            }
          }
          return keys
        },
        getOwnPropertyDescriptor(_target, prop): PropertyDescriptor | undefined {
          if (typeof prop !== 'string') return undefined
          const val = attrs.get(`data-${camelToKebab(prop)}`)
          if (val === undefined) return undefined
          return { enumerable: true, configurable: true, writable: true, value: val }
        },
      }
    )
  }

  public get hidden(): boolean {
    return this._hidden
  }

  public set hidden(value: boolean) {
    this._hidden = Boolean(value)
    if (this._hidden) {
      this.attributes.set('hidden', '')
    } else {
      this.attributes.delete('hidden')
    }
  }

  public get tabIndex(): number {
    return this._tabIndex
  }

  public set tabIndex(value: number) {
    const num = Number(value)
    this._tabIndex = Number.isFinite(num) ? Math.trunc(num) : 0
    this.attributes.set('tabindex', String(this._tabIndex))
  }

  public get className(): string {
    return this.classList.toString()
  }

  public set className(value: string) {
    this.classList.syncFromString(value || '')
  }

  public get title(): string {
    return this.attributes.get('title') ?? ''
  }

  public set title(value: string) {
    this.attributes.set('title', String(value))
  }

  public get children(): FakeElement[] {
    return this.childNodes.filter((c): c is FakeElement => c instanceof FakeElement)
  }

  public override get textContent(): string {
    if (this.childNodes.length > 0) {
      return this.childNodes.map((c) => c.textContent).join('')
    }
    if (this._rawInnerHtml) {
      const stripped = this._rawInnerHtml.replace(/<[^>]+>/g, ' ')
      return decodeBasicHtmlEntities(stripped)
    }
    return this._text
  }

  public override set textContent(value: string | null) {
    this.clearChildren()
    this._rawInnerHtml = ''
    this._text = value === null || value === undefined ? '' : String(value)
  }

  public get innerText(): string {
    return this.textContent
  }

  public set innerText(value: string) {
    this.textContent = value
  }

  public get innerHTML(): string {
    if (this.childNodes.length > 0) {
      return this.childNodes
        .map((c) => {
          if (c instanceof FakeElement) {
            const tag = c.tagName.toLowerCase()
            const cls = c.className ? ` class="${c.className}"` : ''
            return `<${tag}${cls}>${c.innerHTML}</${tag}>`
          }
          return c.textContent
        })
        .join('')
    }
    if (this._rawInnerHtml) {
      return this._rawInnerHtml
    }
    return this._text
  }

  public set innerHTML(value: string) {
    this.clearChildren()
    this._text = ''
    this._rawInnerHtml = value || ''
  }

  private clearChildren(): void {
    for (const child of this.childNodes) {
      child.parentNode = null
    }
    this.childNodes.length = 0
  }

  public append(...nodes: Array<FakeNode | string>): void {
    for (const item of nodes) {
      if (typeof item === 'string') {
        this.appendChild(new FakeTextNode(item, this.tracker))
      } else {
        this.appendChild(item)
      }
    }
  }

  public prepend(...nodes: Array<FakeNode | string>): void {
    const first = this.firstChild
    for (const item of nodes) {
      if (typeof item === 'string') {
        this.insertBefore(new FakeTextNode(item, this.tracker), first)
      } else {
        this.insertBefore(item, first)
      }
    }
  }

  public replaceChildren(...nodes: Array<FakeNode | string>): void {
    this.clearChildren()
    this._text = ''
    this._rawInnerHtml = ''
    this.append(...nodes)
  }

  public override cloneNode(deep?: boolean): FakeElement {
    const clone = this.tracker
      ? this.tracker.createElement(this.tagName)
      : new FakeElement(this.tagName)
    clone.id = this.id
    clone.className = this.className
    for (const [k, v] of this.attributes.entries()) {
      clone.attributes.set(k, v)
    }
    if (deep) {
      for (const child of this.childNodes) {
        clone.appendChild(child.cloneNode(true))
      }
    }
    return clone
  }

  public setAttribute(name: string, value: string): void {
    if (name === 'class') {
      this.className = String(value)
      return
    }
    if (name === 'id') {
      this.id = String(value)
      return
    }
    if (name === 'tabindex') {
      const num = Number(value)
      this._tabIndex = Number.isFinite(num) ? Math.trunc(num) : 0
      this.attributes.set('tabindex', String(value))
      return
    }
    if (name === 'hidden') {
      this._hidden = true
      this.attributes.set('hidden', String(value))
      return
    }
    this.attributes.set(name, String(value))
  }

  public getAttribute(name: string): string | null {
    if (name === 'class') return this.className || null
    if (name === 'id') return this.id || null
    return this.attributes.get(name) ?? null
  }

  public removeAttribute(name: string): void {
    if (name === 'class') {
      this.className = ''
      return
    }
    if (name === 'id') {
      this.id = ''
      return
    }
    if (name === 'tabindex') {
      this._tabIndex = 0
      this.attributes.delete('tabindex')
      return
    }
    if (name === 'hidden') {
      this._hidden = false
      this.attributes.delete('hidden')
      return
    }
    this.attributes.delete(name)
  }

  public hasAttribute(name: string): boolean {
    if (name === 'class') return this.className.length > 0
    if (name === 'id') return this.id.length > 0
    return this.attributes.has(name)
  }

  public getAttributeNames(): string[] {
    const names = new Set<string>(this.attributes.keys())
    if (this.className.length > 0) names.add('class')
    if (this.id.length > 0) names.add('id')
    return Array.from(names)
  }

  public focus(_options?: { preventScroll?: boolean }): void {
    if (this.ownerDocument) {
      const prev = this.ownerDocument.activeElement
      if (prev && prev !== this && prev instanceof FakeHTMLInputElement) {
        prev.focused = false
      }
      this.ownerDocument.activeElement = this
    }
  }

  public blur(): void {
    if (this.ownerDocument && this.ownerDocument.activeElement === this) {
      this.ownerDocument.activeElement = null
    }
  }

  public click(): void {
    this.dispatchEvent(new FakeEvent({ type: 'click', bubbles: true, cancelable: true }))
  }

  public setBoundingClientRect(rect: FakeDOMRectInit | null): void {
    this.customRect = rect ? { ...rect } : null
  }

  public getBoundingClientRect(): FakeDOMRect {
    const x =
      this.customRect?.left ??
      this.customRect?.x ??
      parsePxNumber(this.style.left) ??
      this.offsetLeft
    const y =
      this.customRect?.top ??
      this.customRect?.y ??
      parsePxNumber(this.style.top) ??
      this.offsetTop
    const width =
      this.customRect?.width ??
      parsePxNumber(this.style.width) ??
      (this.clientWidth || 800)
    const height =
      this.customRect?.height ??
      parsePxNumber(this.style.height) ??
      (this.clientHeight || 600)
    const right = this.customRect?.right ?? x + width
    const bottom = this.customRect?.bottom ?? y + height

    return {
      top: y,
      left: x,
      right,
      bottom,
      width,
      height,
      x,
      y,
      toJSON: () => ({}),
    }
  }

  public getClientRects(): unknown[] {
    return [this.getBoundingClientRect()]
  }

  public scrollIntoView(_opts?: { block?: string; inline?: string }): void {
    // No-op in headless harness
  }

  public addEventListener(
    type: string,
    listener: (event: unknown) => void,
    options?: FakeListenerOptions
  ): void {
    let set = this.listenerMap.get(type)
    if (!set) {
      set = new Set()
      this.listenerMap.set(type, set)
    }
    set.add(listener)
    if (typeof options === 'object' && options.once) {
      let onceSet = this.onceListeners.get(type)
      if (!onceSet) {
        onceSet = new WeakSet()
        this.onceListeners.set(type, onceSet)
      }
      onceSet.add(listener)
    }
    this.tracker?.recordAddListener({
      targetTag: this.tagName,
      type,
      listener,
      passive: typeof options === 'object' ? options.passive : undefined,
    })
  }

  public removeEventListener(
    type: string,
    listener: (event: unknown) => void,
    _options?: FakeListenerOptions
  ): void {
    const set = this.listenerMap.get(type)
    if (set) {
      set.delete(listener)
    }
    this.onceListeners.get(type)?.delete(listener)
    this.tracker?.recordRemoveListener(type, listener)
  }

  public dispatchEvent(event: FakeEvent): boolean {
    if (!event.target) {
      event.target = this
    }
    let current: FakeElement | null = this
    while (current) {
      event.currentTarget = current
      const listeners = current.listenerMap.get(event.type)
      if (listeners) {
        const onceSet = current.onceListeners.get(event.type)
        for (const fn of Array.from(listeners)) {
          if (onceSet?.has(fn)) {
            current.removeEventListener(event.type, fn)
          }
          fn(event)
          if (event.immediatePropagationStopped) break
        }
      }
      if (!event.bubbles || event.propagationStopped) break
      current = current.parentElement
    }

    if (event.bubbles && !event.propagationStopped && this.isConnected && this.ownerDocument) {
      this.ownerDocument.dispatchEvent(event)
    }

    return !event.defaultPrevented
  }

  public matches(selector: string): boolean {
    const branches = splitSelectorBranches(selector)
      .map((s) => parseComplexSelector(s))
      .filter((b) => b.length > 0)
    return branches.some((steps) => matchesComplexSelector(this, steps))
  }

  public closest(selector: string): FakeElement | null {
    let cur: FakeElement | null = this
    while (cur) {
      if (cur.matches(selector)) return cur
      cur = cur.parentElement
    }
    return null
  }

  public querySelectorAll<T extends FakeElement = FakeElement>(selector: string): T[] {
    const branches = splitSelectorBranches(selector)
      .map((s) => parseComplexSelector(s))
      .filter((b) => b.length > 0)
    const results: T[] = []

    const walk = (node: FakeElement): void => {
      for (const child of node.childNodes) {
        if (!(child instanceof FakeElement)) continue
        if (branches.some((steps) => matchesComplexSelector(child, steps))) {
          results.push(child as T)
        }
        walk(child)
      }
    }
    walk(this)
    return results
  }

  public querySelector<T extends FakeElement = FakeElement>(selector: string): T | null {
    return this.querySelectorAll<T>(selector)[0] ?? null
  }
}

export class FakeHTMLElement extends FakeElement {}
export class FakeHTMLDivElement extends FakeHTMLElement {}
export class FakeHTMLTableCellElement extends FakeHTMLElement {}
export class FakeHTMLTableColElement extends FakeHTMLElement {
  public span = 1
}

export class FakeHTMLAnchorElement extends FakeHTMLElement {
  public href = ''
  public download = ''
  public target = ''
  public rel = ''
}

export class FakeHTMLSelectElement extends FakeHTMLElement {
  public value = ''
  private _name = ''
  private _disabled = false

  public get name(): string {
    return this._name
  }

  public set name(val: string) {
    this._name = String(val)
    this.attributes.set('name', this._name)
  }

  public get disabled(): boolean {
    return this._disabled
  }

  public set disabled(val: boolean) {
    this._disabled = Boolean(val)
    if (this._disabled) {
      this.attributes.set('disabled', '')
    } else {
      this.attributes.delete('disabled')
    }
  }

  public get options(): FakeHTMLOptionElement[] {
    return this.querySelectorAll<FakeHTMLOptionElement>('option')
  }

  public override setAttribute(name: string, value: string): void {
    if (name === 'disabled') {
      this.disabled = true
      return
    }
    if (name === 'name') {
      this.name = value
      return
    }
    super.setAttribute(name, value)
  }

  public override removeAttribute(name: string): void {
    if (name === 'disabled') {
      this.disabled = false
      return
    }
    if (name === 'name') {
      this._name = ''
    }
    super.removeAttribute(name)
  }
}

export class FakeHTMLOptionElement extends FakeHTMLElement {
  public value = ''
  public selected = false

  public override setAttribute(name: string, value: string): void {
    if (name === 'value') {
      this.value = String(value)
    }
    super.setAttribute(name, value)
  }

  public override getAttribute(name: string): string | null {
    if (name === 'value') {
      return this.attributes.get('value') ?? (this.value || null)
    }
    return super.getAttribute(name)
  }
}

export class FakeHTMLButtonElement extends FakeHTMLElement {
  private _type = 'button'
  private _disabled = false

  public get type(): string {
    return this._type
  }

  public set type(val: string) {
    this._type = String(val)
    this.attributes.set('type', this._type)
  }

  public get disabled(): boolean {
    return this._disabled
  }

  public set disabled(val: boolean) {
    this._disabled = Boolean(val)
    if (this._disabled) {
      this.attributes.set('disabled', '')
    } else {
      this.attributes.delete('disabled')
    }
  }

  public override setAttribute(name: string, value: string): void {
    if (name === 'disabled') {
      this.disabled = true
      return
    }
    if (name === 'type') {
      this.type = value
      return
    }
    super.setAttribute(name, value)
  }

  public override removeAttribute(name: string): void {
    if (name === 'disabled') {
      this.disabled = false
      return
    }
    if (name === 'type') {
      this._type = 'button'
    }
    super.removeAttribute(name)
  }
}

export class FakeHTMLStyleElement extends FakeHTMLElement {
  public readonly sheet = {
    cssRules: [] as unknown[],
    insertRule: (): number => 0,
  }
}

export class FakeHTMLImageElement extends FakeHTMLElement {
  public src = ''
  public alt = ''
}

export class FakeHTMLInputElement extends FakeHTMLElement {
  public value = ''
  private _type = 'text'
  private _name = ''
  private _placeholder = ''
  public checked = false
  public focused = false
  public selected = false
  public readOnly = false
  public selectionStart: number | null = 0
  public selectionEnd: number | null = 0
  private _disabled = false

  public get type(): string {
    return this._type
  }

  public set type(val: string) {
    this._type = String(val)
    this.attributes.set('type', this._type)
  }

  public get name(): string {
    return this._name
  }

  public set name(val: string) {
    this._name = String(val)
    this.attributes.set('name', this._name)
  }

  public get placeholder(): string {
    return this._placeholder
  }

  public set placeholder(val: string) {
    this._placeholder = String(val)
    this.attributes.set('placeholder', this._placeholder)
  }

  public get disabled(): boolean {
    return this._disabled
  }

  public set disabled(val: boolean) {
    this._disabled = Boolean(val)
    if (this._disabled) {
      this.attributes.set('disabled', '')
    } else {
      this.attributes.delete('disabled')
    }
  }

  public override setAttribute(name: string, value: string): void {
    if (name === 'disabled') {
      this.disabled = true
      return
    }
    if (name === 'type') {
      this.type = value
      return
    }
    if (name === 'name') {
      this.name = value
      return
    }
    if (name === 'placeholder') {
      this.placeholder = value
      return
    }
    super.setAttribute(name, value)
  }

  public override removeAttribute(name: string): void {
    if (name === 'disabled') {
      this.disabled = false
      return
    }
    if (name === 'type') {
      this._type = 'text'
    } else if (name === 'name') {
      this._name = ''
    } else if (name === 'placeholder') {
      this._placeholder = ''
    }
    super.removeAttribute(name)
  }

  public override focus(options?: { preventScroll?: boolean }): void {
    super.focus(options)
    this.focused = true
  }

  public override blur(): void {
    super.blur()
    this.focused = false
  }

  public select(): void {
    this.selected = true
    this.selectionStart = 0
    this.selectionEnd = this.value.length
  }

  public setSelectionRange(start: number, end: number): void {
    this.selectionStart = start
    this.selectionEnd = end
  }
}

export class FakeHTMLTextAreaElement extends FakeHTMLInputElement {
  public spellcheck = false
}

export class FakeObserver {
  public observe(): void {}
  public unobserve(): void {}
  public disconnect(): void {}
  public takeRecords(): unknown[] {
    return []
  }
}

export class FakeWindow {
  public orca: unknown = undefined
  public localStorage?: FakeStorageLike
  public innerWidth = 1280
  public innerHeight = 800
  public scrollX = 0
  public scrollY = 0
  public document: FakeDocumentLike | null = null
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>()
  private readonly tracker?: FakeDomHarness

  constructor(tracker?: FakeDomHarness) {
    this.tracker = tracker
  }

  public setTimeout = globalThis.setTimeout.bind(globalThis)
  public clearTimeout = globalThis.clearTimeout.bind(globalThis)
  public queueMicrotask = globalThis.queueMicrotask.bind(globalThis)

  public scrollBy = (x = 0, y = 0): void => {
    this.scrollX += x
    this.scrollY += y
  }

  public getComputedStyle = (): {
    backgroundColor: string
    fontSize: string
    lineHeight: string
    fontFamily: string
    getPropertyValue: () => string
  } => ({
    backgroundColor: 'rgb(0, 0, 0)',
    fontSize: '12.5px',
    lineHeight: '18px',
    fontFamily: 'monospace',
    getPropertyValue: () => '',
  })

  public getSelection = () => ({
    rangeCount: 0,
    anchorNode: null as FakeNode | null,
    focusNode: null as FakeNode | null,
    removeAllRanges: (): void => {},
    addRange: (): void => {},
  })

  public requestAnimationFrame = (callback: (timestamp: number) => void): number => {
    if (!this.tracker) return 0
    return this.tracker.scheduleRaf(callback)
  }

  public cancelAnimationFrame = (handle: number): void => {
    this.tracker?.cancelRaf(handle)
  }

  public matchMedia = (_query: string) => ({
    matches: false,
    media: _query,
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
  })

  public addEventListener(
    type: string,
    listener: (event: unknown) => void,
    _options?: FakeListenerOptions
  ): void {
    let set = this.listeners.get(type)
    if (!set) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(listener)
  }

  public removeEventListener(
    type: string,
    listener: (event: unknown) => void,
    _options?: FakeListenerOptions
  ): void {
    this.listeners.get(type)?.delete(listener)
  }

  public dispatchEvent(event: FakeEvent): boolean {
    const set = this.listeners.get(event.type)
    if (set) {
      for (const fn of Array.from(set)) {
        fn(event)
        if (event.immediatePropagationStopped) break
      }
    }
    return !event.defaultPrevented
  }
}

export class FakeDomHarness {
  public readonly window: FakeWindow
  public readonly body: FakeHTMLElement
  public readonly head: FakeHTMLElement
  public readonly documentElement: FakeHTMLElement
  public readonly document: FakeDocumentLike
  public readonly activeWheelListeners = new Set<(event: unknown) => void>()
  public readonly wheelAttachments: TrackedListenerEntry[] = []

  private readonly savedGlobals = new Map<string, PropertyDescriptor | undefined>()
  private readonly docListeners = new Map<string, Set<(event: unknown) => void>>()
  private readonly rafTimers = new Map<number, ReturnType<typeof setTimeout>>()
  private nextRafId = 1

  constructor() {
    this.window = new FakeWindow(this)
    this.document = {
      body: null as unknown as FakeHTMLElement,
      head: null as unknown as FakeHTMLElement,
      documentElement: null as unknown as FakeHTMLElement,
      defaultView: this.window,
      activeElement: null,
      styleSheets: [],
      adoptedStyleSheets: [],
      createElement: (tagName: string) => this.createElement(tagName),
      createElementNS: (_ns: string, tagName: string) => this.createElement(tagName),
      createTextNode: (data: string) => new FakeTextNode(data, this),
      createDocumentFragment: () => new FakeDocumentFragment(this),
      createRange: () => ({
        setStart: () => {},
        setEnd: () => {},
        collapse: () => {},
        selectNodeContents: () => {},
        getClientRects: () => [],
        getBoundingClientRect: () => ({
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          width: 0,
          height: 0,
          x: 0,
          y: 0,
        }),
      }),
      querySelector: <T extends FakeElement = FakeElement>(selector: string): T | null => {
        if (this.documentElement.matches(selector)) {
          return this.documentElement as unknown as T
        }
        return this.documentElement.querySelector<T>(selector)
      },
      querySelectorAll: <T extends FakeElement = FakeElement>(selector: string): T[] => {
        const results: T[] = []
        if (this.documentElement.matches(selector)) {
          results.push(this.documentElement as unknown as T)
        }
        results.push(...this.documentElement.querySelectorAll<T>(selector))
        return results
      },
      getElementById: (id: string): FakeElement | null => {
        if (!id) return null
        return this.findById(this.documentElement, id)
      },
      hasFocus: () => this.document.activeElement !== null,
      getSelection: () => this.window.getSelection(),
      addEventListener: (
        type: string,
        listener: (event: unknown) => void,
        _options?: FakeListenerOptions
      ) => {
        let set = this.docListeners.get(type)
        if (!set) {
          set = new Set()
          this.docListeners.set(type, set)
        }
        set.add(listener)
      },
      removeEventListener: (
        type: string,
        listener: (event: unknown) => void,
        _options?: FakeListenerOptions
      ) => {
        this.docListeners.get(type)?.delete(listener)
      },
      dispatchEvent: (event: FakeEvent) => {
        const set = this.docListeners.get(event.type)
        if (set) {
          for (const fn of Array.from(set)) {
            fn(event)
            if (event.immediatePropagationStopped) break
          }
        }
        if (event.bubbles && !event.propagationStopped) {
          this.window.dispatchEvent(event)
        }
        return !event.defaultPrevented
      },
      execCommand: () => false,
    }

    this.documentElement = new FakeHTMLElement('html', this)
    this.head = new FakeHTMLElement('head', this)
    this.body = new FakeHTMLElement('body', this)
    this.documentElement.appendChild(this.head)
    this.documentElement.appendChild(this.body)
    this.document.documentElement = this.documentElement
    this.document.head = this.head
    this.document.body = this.body
    this.window.document = this.document
  }

  private findById(root: FakeElement, id: string): FakeElement | null {
    if (root.id === id) return root
    for (const child of root.childNodes) {
      if (child instanceof FakeElement) {
        const found = this.findById(child, id)
        if (found) return found
      }
    }
    return null
  }

  public scheduleRaf(callback: (timestamp: number) => void): number {
    const id = this.nextRafId++
    const timer = setTimeout(() => {
      this.rafTimers.delete(id)
      try {
        callback(Date.now())
      } catch {
        // Ignore CodeMirror layout measure calls in minimal test DOM
      }
    }, 0)
    this.rafTimers.set(id, timer)
    return id
  }

  public cancelRaf(id: number): void {
    const timer = this.rafTimers.get(id)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.rafTimers.delete(id)
    }
  }

  public recordAddListener(entry: TrackedListenerEntry): void {
    if (entry.type === 'wheel') {
      this.activeWheelListeners.add(entry.listener)
      this.wheelAttachments.push(entry)
    }
  }

  public recordRemoveListener(type: string, listener: (event: unknown) => void): void {
    if (type === 'wheel') {
      this.activeWheelListeners.delete(listener)
    }
  }

  public createElement(tagName: string): FakeElement {
    const lower = tagName.toLowerCase()
    if (lower === 'td' || lower === 'th') return new FakeHTMLTableCellElement(lower, this)
    if (lower === 'col' || lower === 'colgroup') return new FakeHTMLTableColElement(lower, this)
    if (lower === 'input') return new FakeHTMLInputElement(lower, this)
    if (lower === 'textarea') return new FakeHTMLTextAreaElement(lower, this)
    if (lower === 'select') return new FakeHTMLSelectElement(lower, this)
    if (lower === 'option') return new FakeHTMLOptionElement(lower, this)
    if (lower === 'button') return new FakeHTMLButtonElement(lower, this)
    if (lower === 'style') return new FakeHTMLStyleElement(lower, this)
    if (lower === 'img') return new FakeHTMLImageElement(lower, this)
    if (lower === 'a') return new FakeHTMLAnchorElement(lower, this)
    if (lower === 'div') return new FakeHTMLDivElement(lower, this)
    return new FakeHTMLElement(lower, this)
  }

  public install(): void {
    this.window.orca = undefined
    const entries: Array<[string, unknown]> = [
      ['Node', FakeNode],
      ['Text', FakeTextNode],
      ['DocumentFragment', FakeDocumentFragment],
      ['Element', FakeElement],
      ['HTMLElement', FakeHTMLElement],
      ['HTMLDivElement', FakeHTMLDivElement],
      ['HTMLTableCellElement', FakeHTMLTableCellElement],
      ['HTMLTableColElement', FakeHTMLTableColElement],
      ['HTMLAnchorElement', FakeHTMLAnchorElement],
      ['HTMLInputElement', FakeHTMLInputElement],
      ['HTMLTextAreaElement', FakeHTMLTextAreaElement],
      ['HTMLSelectElement', FakeHTMLSelectElement],
      ['HTMLOptionElement', FakeHTMLOptionElement],
      ['HTMLButtonElement', FakeHTMLButtonElement],
      ['HTMLStyleElement', FakeHTMLStyleElement],
      ['HTMLImageElement', FakeHTMLImageElement],
      ['SVGElement', FakeElement],
      ['MutationObserver', FakeObserver],
      ['ResizeObserver', FakeObserver],
      ['IntersectionObserver', FakeObserver],
      ['getComputedStyle', this.window.getComputedStyle],
      ['requestAnimationFrame', this.window.requestAnimationFrame],
      ['cancelAnimationFrame', this.window.cancelAnimationFrame],
      ['document', this.document],
      ['window', this.window],
      ['Window', FakeWindow],
    ]

    for (const [key, val] of entries) {
      if (!this.savedGlobals.has(key)) {
        this.savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
      }
      Object.defineProperty(globalThis, key, {
        configurable: true,
        writable: true,
        value: val,
      })
    }
  }

  public uninstall(): void {
    for (const timer of this.rafTimers.values()) {
      clearTimeout(timer)
    }
    this.rafTimers.clear()
    this.docListeners.clear()
    this.activeWheelListeners.clear()

    for (const [key, prev] of this.savedGlobals.entries()) {
      if (prev) {
        Object.defineProperty(globalThis, key, prev)
      } else {
        Reflect.deleteProperty(globalThis, key)
      }
    }
    this.savedGlobals.clear()
  }
}

export async function flushMicrotasks(ticks = 4): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve()
  }
}
