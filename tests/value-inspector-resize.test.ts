import { afterEach, describe, expect, it } from 'vitest'

function installInspectorDom() {
  const prev = {
    window: (globalThis as Record<string, unknown>).window,
    document: (globalThis as Record<string, unknown>).document,
    localStorage: (globalThis as Record<string, unknown>).localStorage,
    requestAnimationFrame: (globalThis as Record<string, unknown>).requestAnimationFrame,
    cancelAnimationFrame: (globalThis as Record<string, unknown>).cancelAnimationFrame,
  }

  class MiniClassList {
    private s = new Set<string>()
    constructor(private el: MiniEl) {}
    add(...ns: string[]) {
      for (const n of ns) for (const p of n.split(/\s+/).filter(Boolean)) this.s.add(p)
      this.el.className = Array.from(this.s).join(' ')
    }
    remove(...ns: string[]) {
      for (const n of ns) for (const p of n.split(/\s+/).filter(Boolean)) this.s.delete(p)
      this.el.className = Array.from(this.s).join(' ')
    }
    toggle(n: string, force?: boolean) {
      if (force === true) this.add(n)
      else if (force === false) this.remove(n)
      else if (this.s.has(n)) this.remove(n)
      else this.add(n)
    }
    contains(n: string) {
      return this.s.has(n)
    }
  }

  class MiniEl {
    tagName: string
    children: MiniEl[] = []
    parentElement: MiniEl | null = null
    style: Record<string, string> = {}
    className = ''
    classList: MiniClassList
    attrs = new Map<string, string>()
    listeners = new Map<string, Set<(e: unknown) => void>>()
    tabIndex = 0
    disabled = false
    readOnly = false
    spellcheck = true
    value = ''
    placeholder = ''
    title = ''
    type = ''
    textContent = ''
    mockRect = { height: 220, width: 600, top: 400, bottom: 620 }

    constructor(tag: string) {
      this.tagName = tag.toUpperCase()
      this.classList = new MiniClassList(this)
    }
    appendChild<T extends MiniEl>(c: T): T {
      c.parentElement = this
      this.children.push(c)
      return c
    }
    setAttribute(k: string, v: string) {
      this.attrs.set(k, String(v))
    }
    getAttribute(k: string) {
      return this.attrs.get(k) ?? null
    }
    addEventListener(t: string, fn: (e: unknown) => void) {
      let s = this.listeners.get(t)
      if (!s) {
        s = new Set()
        this.listeners.set(t, s)
      }
      s.add(fn)
    }
    removeEventListener(t: string, fn: (e: unknown) => void) {
      this.listeners.get(t)?.delete(fn)
    }
    dispatch(ev: Record<string, unknown>) {
      const e = { preventDefault() {}, stopPropagation() {}, ...ev }
      for (const fn of Array.from(this.listeners.get(String(ev.type)) ?? [])) fn(e)
    }
    getBoundingClientRect() {
      const h = parseInt(this.style.height || '', 10)
      return { ...this.mockRect, height: Number.isFinite(h) ? h : this.mockRect.height }
    }
    focus() {}
    querySelector(sel: string): MiniEl | null {
      const wantClass = sel.startsWith('.') ? sel.slice(1) : null
      for (const c of this.children) {
        if (wantClass && (c.className.split(/\s+/).includes(wantClass) || c.classList.contains(wantClass))) {
          return c
        }
        const hit = c.querySelector(sel)
        if (hit) return hit
      }
      return null
    }
  }

  const winListeners = new Map<string, Set<(e: unknown) => void>>()
  const ls = new Map<string, string>()
  const body = new MiniEl('body')
  const doc = {
    body,
    createElement: (t: string) => new MiniEl(t),
  }
  const win = {
    document: doc,
    innerHeight: 800,
    localStorage: {
      getItem: (k: string) => ls.get(k) ?? null,
      setItem: (k: string, v: string) => ls.set(k, String(v)),
    },
    addEventListener: (t: string, fn: (e: unknown) => void) => {
      let s = winListeners.get(t)
      if (!s) {
        s = new Set()
        winListeners.set(t, s)
      }
      s.add(fn)
    },
    removeEventListener: (t: string, fn: (e: unknown) => void) => {
      winListeners.get(t)?.delete(fn)
    },
    dispatch: (ev: Record<string, unknown>) => {
      for (const fn of Array.from(winListeners.get(String(ev.type)) ?? [])) fn(ev)
    },
  }
  Object.assign(globalThis, {
    window: win,
    document: doc,
    localStorage: win.localStorage,
    requestAnimationFrame: (fn: () => void) => {
      fn()
      return 1
    },
    cancelAnimationFrame: () => {},
  })

  return {
    win,
    ls,
    winListeners,
    MiniEl,
    restore: () => Object.assign(globalThis, prev),
  }
}

let cleanup: (() => void) | undefined
afterEach(() => {
  cleanup?.()
  cleanup = undefined
})

describe('ValueInspectorController vertical resize', () => {
  it('supports drag resize, clamping, persistence, keyboard arrows, double-click reset, and cleanup', async () => {
    const env = installInspectorDom()
    cleanup = env.restore

    let resizeCalls = 0
    const { ValueInspectorController } = await import('../src/editor/value-inspector.js')
    const ctrl = new ValueInspectorController({
      getInspectButton: () => null,
      getDataGrid: () => ({ handleViewportResize: () => { resizeCalls += 1 } } as never),
      getActiveTarget: () => ({ connectionId: 'c1', table: 'users', page: 1, viewSeq: 1 }),
      updateCell: async () => ({ ok: true }),
      reloadTableData: async () => {},
      updateStatus: () => {},
    })

    const container = new env.MiniEl('div')
    container.mockRect = { height: 640, width: 800, top: 0, bottom: 640 }
    const root = ctrl.buildElement() as unknown as InstanceType<typeof env.MiniEl>
    container.appendChild(root)

    const resizer = root.querySelector('.datanoa-value-inspector-resizer')
    expect(resizer).toBeTruthy()
    expect(resizer?.getAttribute('role')).toBe('separator')
    expect(resizer?.getAttribute('aria-orientation')).toBe('horizontal')
    expect(resizer?.tabIndex).toBe(0)
    expect(root.children[0]).toBe(resizer)

    ctrl.open({
      rowIndex: 0,
      colIndex: 0,
      columnName: 'payload',
      columnType: 'TEXT',
      value: '{"a":1}',
      isEditable: true,
      isNullable: true,
    })
    expect(root.style.height).toBe('220px')

    // Drag up 180px -> 400px
    resizer?.dispatch({ type: 'mousedown', clientY: 500 })
    env.win.dispatch({ type: 'mousemove', clientY: 320 })
    expect(root.style.height).toBe('400px')
    expect(resizeCalls).toBeGreaterThan(0)

    // Extreme drag up -> clamped to 75% of 640 = 480px
    env.win.dispatch({ type: 'mousemove', clientY: 50 })
    expect(root.style.height).toBe('480px')
    env.win.dispatch({ type: 'mouseup' })
    expect(env.ls.get('datanoa.studioValueInspectorPx')).toBe('480')

    // Double-click resets to 220px
    resizer?.dispatch({ type: 'dblclick' })
    expect(root.style.height).toBe('220px')

    // Keyboard ArrowUp / ArrowDown
    resizer?.dispatch({ type: 'keydown', key: 'ArrowUp' })
    expect(root.style.height).toBe('244px')
    resizer?.dispatch({ type: 'keydown', key: 'ArrowDown' })
    expect(root.style.height).toBe('220px')

    // Mid-drag destroy must remove window listeners cleanly
    resizer?.dispatch({ type: 'mousedown', clientY: 500 })
    ctrl.destroy()
    expect(env.winListeners.get('mousemove')?.size ?? 0).toBe(0)
    expect(env.winListeners.get('mouseup')?.size ?? 0).toBe(0)
  })
})
