// Text-layout properties a mirror needs to wrap exactly like the textarea.
const MIRRORED = [
  'direction', 'font-family', 'font-size', 'font-style', 'font-variant', 'font-weight', 'font-stretch', 'font-size-adjust',
  'font-feature-settings', 'font-variation-settings', 'line-height', 'letter-spacing', 'word-spacing', 'text-align',
  'text-transform', 'text-indent', 'tab-size', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left'
] as const

/**
 * Viewport rect of the caret at `position` inside a textarea — the anchor the
 * `/` and `@` menus open from (Traycer anchors them to the editor caret). A
 * hidden mirror with the same width and text metrics is laid out up to the
 * position; the marker that follows lands where the caret is.
 */
export function caretClientRect(el: HTMLTextAreaElement, position: number): DOMRect {
  const style = getComputedStyle(el)
  const mirror = document.createElement('div')
  for (const prop of MIRRORED) mirror.style.setProperty(prop, style.getPropertyValue(prop))
  Object.assign(mirror.style, {
    position: 'fixed', top: '0', left: '-10000px', visibility: 'hidden', overflow: 'hidden', border: '0',
    boxSizing: 'border-box', width: `${el.clientWidth}px`, height: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', wordBreak: style.wordBreak
  })
  mirror.textContent = el.value.slice(0, position)
  const marker = document.createElement('span')
  // Non-empty, or a caret at the very end would have no box to measure.
  marker.textContent = el.value.slice(position, position + 1) || '​'
  mirror.appendChild(marker)
  document.body.appendChild(mirror)
  const top = marker.offsetTop, left = marker.offsetLeft
  document.body.removeChild(mirror)
  const box = el.getBoundingClientRect()
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2
  const x = box.left + el.clientLeft + left - el.scrollLeft
  const y = box.top + el.clientTop + top - el.scrollTop
  // Clamped to the field: a caret scrolled out of view still anchors at its edge.
  const clampedY = Math.min(Math.max(y, box.top), Math.max(box.top, box.bottom - lineHeight))
  return new DOMRect(Math.min(x, box.right), clampedY, 1, lineHeight)
}
