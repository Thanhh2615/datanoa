// src/editor/grid-icons.ts
// Shared DOM traversal helpers, SVG icon builders, and fixed popup clamping for VirtualDataGrid

export function isEditableInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName.toUpperCase()
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return target.isContentEditable === true
}

export function findClosestTableCell(target: EventTarget | null): HTMLTableCellElement | null {
  if (!(target instanceof Node)) return null
  let cur: Node | null = target
  while (cur) {
    if (cur instanceof HTMLTableCellElement) {
      return cur
    }
    cur = cur.parentNode
  }
  return null
}

export function findClosestFkBadge(target: EventTarget | null): HTMLButtonElement | null {
  if (!(target instanceof Node)) return null
  let cur: Node | null = target
  while (cur) {
    if (cur instanceof HTMLButtonElement && cur.classList.contains('datanoa-fk-badge')) {
      return cur
    }
    cur = cur.parentNode
  }
  return null
}

export function createSvgEl(tag: string, attrs: Record<string, string>): Element {
  const el =
    typeof document.createElementNS === 'function'
      ? document.createElementNS('http://www.w3.org/2000/svg', tag)
      : document.createElement(tag)
  for (const [key, val] of Object.entries(attrs)) {
    el.setAttribute(key, val)
  }
  return el
}

export function createSortArrowSvg(direction: 'ASC' | 'DESC'): Element {
  const svg = createSvgEl('svg', {
    width: '11',
    height: '11',
    viewBox: '0 0 12 12',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.6',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  })
  svg.appendChild(createSvgEl('path', { d: 'M6 9.5V2.5' }))
  svg.appendChild(
    createSvgEl('path', {
      d: direction === 'ASC' ? 'M2.75 5.75L6 2.5L9.25 5.75' : 'M2.75 6.25L6 9.5L9.25 6.25',
    })
  )
  return svg
}

export function createColSelectSvg(): Element {
  const svg = createSvgEl('svg', {
    width: '10',
    height: '10',
    viewBox: '0 0 12 12',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.5',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  })
  svg.appendChild(createSvgEl('path', { d: 'M3 4.5L6 7.5L9 4.5' }))
  return svg
}

export function createPinSvg(): Element {
  const svg = createSvgEl('svg', {
    width: '10',
    height: '10',
    viewBox: '0 0 12 12',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.4',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  })
  svg.appendChild(createSvgEl('path', { d: 'M4 2h4l-.5 3.5L9 7H3l1.5-1.5L4 2z' }))
  svg.appendChild(createSvgEl('path', { d: 'M6 7v3.5' }))
  return svg
}

export function createFkJumpSvg(): Element {
  const svg = createSvgEl('svg', {
    width: '10',
    height: '10',
    viewBox: '0 0 12 12',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.5',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  })
  svg.appendChild(createSvgEl('path', { d: 'M3.5 8.5L8.5 3.5' }))
  svg.appendChild(createSvgEl('path', { d: 'M4.5 3.5h4v4' }))
  return svg
}

export function createColFilterSvg(): Element {
  const svg = createSvgEl('svg', {
    viewBox: '0 0 12 12',
    width: '10',
    height: '10',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.3',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  })
  svg.appendChild(createSvgEl('path', { d: 'M1.5 2.25h9L7.2 6.1v3.4l-2.4 1V6.1L1.5 2.25z' }))
  return svg
}

export function clampFixedPopup(el: HTMLElement, clientX: number, clientY: number): void {
  const rect = el.getBoundingClientRect()
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1024
  let vh = typeof window !== 'undefined' ? window.innerHeight : 768
  if (typeof document !== 'undefined') {
    const inspector = document.querySelector('.datanoa-value-inspector') as HTMLElement | null
    if (inspector && inspector.style.display !== 'none') {
      const inspRect = inspector.getBoundingClientRect()
      if (inspRect.height > 0 && inspRect.top > 140) {
        vh = Math.min(vh, inspRect.top)
      }
    }
  }
  const maxH = Math.max(120, vh - 14)
  el.style.maxHeight = `${maxH}px`
  const effHeight = Math.min(rect.height, maxH)
  const left = Math.max(6, Math.min(clientX, vw - rect.width - 8))
  const top = Math.max(6, Math.min(clientY, vh - effHeight - 8))
  el.style.left = `${left}px`
  el.style.top = `${top}px`
}
