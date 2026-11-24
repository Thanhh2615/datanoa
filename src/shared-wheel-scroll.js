// src/shared-wheel-scroll.js
// Shared Ctrl/Meta + wheel horizontal panning for SQL consoles, data grids and table wrappers.
// The convention everywhere in Datanoa: hold Ctrl (or Cmd) and scroll to pan horizontally.

export function bindCtrlWheelHorizontalScroll(el) {
  if (!el || typeof el.addEventListener !== 'function') return () => {}
  const onWheel = (event) => {
    if (!event.ctrlKey && !event.metaKey) return
    const raw = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX
    if (!raw) return
    event.preventDefault()
    let scale = 1.25
    if (event.deltaMode === 1) scale = 28
    else if (event.deltaMode === 2) scale = 320
    el.scrollLeft += raw * scale
  }
  el.addEventListener('wheel', onWheel, { passive: false })
  return () => el.removeEventListener('wheel', onWheel)
}
