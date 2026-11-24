import { describe, expect, it } from 'vitest'
import { bindCtrlWheelHorizontalScroll } from '../src/shared-wheel-scroll.js'

interface FakeWheelEvent {
  ctrlKey: boolean
  metaKey: boolean
  deltaX: number
  deltaY: number
  deltaMode: number
  defaultPrevented: boolean
  preventDefault: () => void
}

function createScrollTarget() {
  const listeners = new Set<(event: FakeWheelEvent) => void>()
  const el = {
    scrollLeft: 0,
    addEventListener(type: string, fn: (event: FakeWheelEvent) => void) {
      if (type === 'wheel') listeners.add(fn)
    },
    removeEventListener(type: string, fn: (event: FakeWheelEvent) => void) {
      if (type === 'wheel') listeners.delete(fn)
    },
  }

  const wheel = (init: Partial<FakeWheelEvent> = {}): FakeWheelEvent => {
    const event = {
      ctrlKey: false,
      metaKey: false,
      deltaX: 0,
      deltaY: 0,
      deltaMode: 0,
      defaultPrevented: false,
      preventDefault() {
        event.defaultPrevented = true
      },
      ...init,
    }
    for (const fn of Array.from(listeners)) fn(event)
    return event
  }

  return {
    el: el as unknown as HTMLElement,
    wheel,
    listenerCount: () => listeners.size,
  }
}

describe('shared Ctrl+wheel horizontal panning', () => {
  it('pans horizontally and cancels ctrl+wheel when deltaY is dominant', () => {
    const { el, wheel } = createScrollTarget()
    bindCtrlWheelHorizontalScroll(el)

    const event = wheel({ ctrlKey: true, deltaY: 100 })

    expect(el.scrollLeft).toBe(125)
    expect(event.defaultPrevented).toBe(true)
  })

  it('supports Cmd on macOS', () => {
    const { el, wheel } = createScrollTarget()
    bindCtrlWheelHorizontalScroll(el)

    const event = wheel({ metaKey: true, deltaY: 80 })

    expect(el.scrollLeft).toBe(100)
    expect(event.defaultPrevented).toBe(true)
  })

  it('leaves plain wheel input untouched', () => {
    const { el, wheel } = createScrollTarget()
    bindCtrlWheelHorizontalScroll(el)

    const event = wheel({ deltaY: 120 })

    expect(el.scrollLeft).toBe(0)
    expect(event.defaultPrevented).toBe(false)
  })

  it('uses the dominant delta axis and keeps negative direction', () => {
    const { el, wheel } = createScrollTarget()
    bindCtrlWheelHorizontalScroll(el)

    wheel({ ctrlKey: true, deltaX: -200, deltaY: 10 })

    expect(el.scrollLeft).toBe(-250)
  })

  it('scales line and page delta modes like the grid listeners', () => {
    const { el, wheel } = createScrollTarget()
    bindCtrlWheelHorizontalScroll(el)
    el.scrollLeft = 0

    wheel({ ctrlKey: true, deltaY: 3, deltaMode: 1 })
    expect(el.scrollLeft).toBe(84)

    wheel({ ctrlKey: true, deltaY: 1, deltaMode: 2 })
    expect(el.scrollLeft).toBe(404)
  })

  it('detaches its listener and tolerates missing elements', () => {
    const { el, wheel, listenerCount } = createScrollTarget()
    const detach = bindCtrlWheelHorizontalScroll(el)
    expect(listenerCount()).toBe(1)

    detach()
    expect(listenerCount()).toBe(0)

    wheel({ ctrlKey: true, deltaY: 100 })
    expect(el.scrollLeft).toBe(0)

    expect(bindCtrlWheelHorizontalScroll(null)()).toBeUndefined()
  })
})
