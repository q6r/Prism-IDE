import { useLayoutEffect, useState, type CSSProperties } from 'react'

export type Side = 'top' | 'bottom' | 'left' | 'right'
export type Align = 'start' | 'center' | 'end'

export interface FloatingOptions {
  open: boolean
  side?: Side
  align?: Align
  sideOffset?: number
  alignOffset?: number
  /** Viewport gutter the surface never crosses (Radix collisionPadding). */
  collisionPadding?: number
  /** Never flip to the opposite side. */
  avoidFlip?: boolean
}

export interface FloatingPlacement {
  readonly style: CSSProperties
  readonly side: Side
  /** Room on the chosen side; also exposed as --tr-available-height/width. */
  readonly available: number
  readonly anchorWidth: number
  readonly ready: boolean
}

interface Box { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number; readonly width: number; readonly height: number }

/** Radix-like placement: preferred side, flip when the other side has more room, shift into the viewport. */
export function computePlacement(anchor: Box, size: { width: number; height: number }, viewport: { width: number; height: number },
  o: Required<Omit<FloatingOptions, 'open'>>): { left: number; top: number; side: Side; available: number } {
  const pad = o.collisionPadding, off = o.sideOffset
  let side = o.side
  const room = (s: Side): number => s === 'bottom' ? viewport.height - anchor.bottom - off - pad : s === 'top' ? anchor.top - off - pad
    : s === 'right' ? viewport.width - anchor.right - off - pad : anchor.left - off - pad
  const opposite: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }
  const need = side === 'top' || side === 'bottom' ? size.height : size.width
  if (!o.avoidFlip && need > room(side) && room(opposite[side]) > room(side)) side = opposite[side]
  const available = Math.max(0, room(side))
  let left: number, top: number
  if (side === 'top' || side === 'bottom') {
    top = side === 'bottom' ? anchor.bottom + off : anchor.top - off - Math.min(size.height, available)
    left = o.align === 'start' ? anchor.left + o.alignOffset : o.align === 'end' ? anchor.right - size.width - o.alignOffset
      : anchor.left + anchor.width / 2 - size.width / 2
    left = Math.max(pad, Math.min(left, viewport.width - pad - size.width))
    top = Math.max(pad, top)
  } else {
    left = side === 'right' ? anchor.right + off : anchor.left - off - size.width
    top = o.align === 'start' ? anchor.top + o.alignOffset : o.align === 'end' ? anchor.bottom - size.height - o.alignOffset
      : anchor.top + anchor.height / 2 - size.height / 2
    top = Math.max(pad, Math.min(top, viewport.height - pad - size.height))
    left = Math.max(pad, left)
  }
  return { left: Math.round(left), top: Math.round(top), side, available: Math.floor(available) }
}

/**
 * Positions `floating` (rendered `position: fixed`) against `anchor` while open.
 * Size is read from layout (offset/scroll size), never from a transformed rect,
 * so the 95% zoom-in entrance never skews the measurement.
 */
export function useFloating(anchor: Element | null, floating: HTMLElement | null, options: FloatingOptions): FloatingPlacement {
  const { open, side = 'bottom', align = 'center', sideOffset = 4, alignOffset = 0, collisionPadding = 8, avoidFlip = false } = options
  const [placement, setPlacement] = useState<FloatingPlacement>({ style: { left: 0, top: 0 }, side, available: 0, anchorWidth: 0, ready: false })
  useLayoutEffect(() => {
    if (!open || !anchor || !floating) {
      setPlacement((p) => (p.ready ? { ...p, ready: false } : p))
      return
    }
    let frame = 0
    const update = (): void => {
      const a = anchor.getBoundingClientRect()
      const size = { width: floating.offsetWidth, height: Math.max(floating.offsetHeight, floating.scrollHeight) }
      const next = computePlacement(a, size, { width: window.innerWidth, height: window.innerHeight },
        { side, align, sideOffset, alignOffset, collisionPadding, avoidFlip })
      setPlacement((p) => p.ready && p.side === next.side && p.available === next.available && p.anchorWidth === Math.round(a.width)
        && p.style.left === next.left && p.style.top === next.top ? p : {
        side: next.side, available: next.available, anchorWidth: Math.round(a.width), ready: true,
        style: { left: next.left, top: next.top, ['--tr-available-height' as string]: `${next.available}px`,
          ['--tr-available-width' as string]: `${next.available}px`, ['--tr-anchor-width' as string]: `${Math.round(a.width)}px` }
      })
    }
    update()
    const schedule = (): void => { cancelAnimationFrame(frame); frame = requestAnimationFrame(update) }
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    const observer = new ResizeObserver(schedule)
    observer.observe(anchor)
    observer.observe(floating)
    return () => { cancelAnimationFrame(frame); window.removeEventListener('resize', schedule); window.removeEventListener('scroll', schedule, true); observer.disconnect() }
  }, [open, anchor, floating, side, align, sideOffset, alignOffset, collisionPadding, avoidFlip])
  return placement
}
