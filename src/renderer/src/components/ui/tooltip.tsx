import { cloneElement, isValidElement, useEffect, useMemo, useRef, useState, type FocusEvent, type PointerEvent, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useFloating, type Align, type Side } from './floating'
import { mergeRefs } from './primitives'

// Shared skip-delay window: once one tooltip has shown, the next one opens
// instantly (Radix TooltipProvider's skipDelayDuration).
let lastClosedAt = 0

type ChildProps = {
  ref?: unknown
  onPointerEnter?: (e: PointerEvent) => void
  onPointerLeave?: (e: PointerEvent) => void
  onPointerDown?: (e: PointerEvent) => void
  onFocus?: (e: FocusEvent) => void
  onBlur?: (e: FocusEvent) => void
}

/**
 * Traycer's label tooltip: inverted foreground plate, 12px text, arrow, 500ms
 * delay, never interactive. `label` null/''/undefined renders the child alone.
 * The child must be a single element that forwards its ref to a DOM node.
 */
export function Tooltip({ label, side = 'top', align = 'center', sideOffset = 4, delay = 500, children, open: forced, className }: {
  label: ReactNode
  side?: Side
  align?: Align
  sideOffset?: number
  delay?: number
  /** Controlled visibility; `false` suppresses the tooltip entirely. */
  open?: boolean
  className?: string
  children: ReactElement
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [hovered, setHovered] = useState(false)
  const [bubble, setBubble] = useState<HTMLDivElement | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const enabled = label !== null && label !== undefined && label !== '' && label !== false
  const visible = enabled && (forced ?? hovered)
  const placement = useFloating(anchor, bubble, { open: visible, side, align, sideOffset: sideOffset + 6, collisionPadding: 8 })
  useEffect(() => () => clearTimeout(timer.current), [])
  useEffect(() => {
    if (!visible) return
    const hide = (): void => { setHovered(false) }
    window.addEventListener('scroll', hide, true)
    window.addEventListener('blur', hide)
    return () => { window.removeEventListener('scroll', hide, true); window.removeEventListener('blur', hide) }
  }, [visible])
  // A stable merged ref: a fresh one per render would detach and re-attach
  // on every commit, re-rendering the tooltip (and its anchor's owner) each time.
  const childRef = isValidElement<ChildProps>(children) ? children.props.ref : undefined
  const ref = useMemo(() => mergeRefs(childRef as never, setAnchor), [childRef])
  if (!isValidElement<ChildProps>(children)) return children
  const props = children.props
  const show = (): void => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setHovered(true), Date.now() - lastClosedAt < 300 ? 0 : delay)
  }
  const hide = (): void => {
    clearTimeout(timer.current)
    setHovered((was) => { if (was) lastClosedAt = Date.now(); return false })
  }
  const child = enabled ? cloneElement(children, {
    ref,
    onPointerEnter: (e: PointerEvent) => { props.onPointerEnter?.(e); if (e.pointerType !== 'touch') show() },
    onPointerLeave: (e: PointerEvent) => { props.onPointerLeave?.(e); hide() },
    onPointerDown: (e: PointerEvent) => { props.onPointerDown?.(e); hide() },
    onFocus: (e: FocusEvent) => { props.onFocus?.(e); if ((e.currentTarget as HTMLElement).matches?.(':focus-visible')) show() },
    onBlur: (e: FocusEvent) => { props.onBlur?.(e); hide() }
  } as ChildProps) : children
  // The arrow points at the anchor's centre even when the plate was shifted
  // to stay inside the viewport.
  const rect = visible && placement.ready && anchor ? anchor.getBoundingClientRect() : null
  const plateLeft = Number(placement.style.left) || 0, plateTop = Number(placement.style.top) || 0
  const clampTo = (v: number, size: number): number => Math.max(6, Math.min(v, size - 16))
  const arrow = placement.side === 'top' || placement.side === 'bottom'
    ? { [placement.side === 'top' ? 'bottom' : 'top']: -4, left: rect ? clampTo(rect.left + rect.width / 2 - plateLeft - 5, bubble?.offsetWidth ?? 0) : 'calc(50% - 5px)' }
    : { [placement.side === 'left' ? 'right' : 'left']: -4, top: rect ? clampTo(rect.top + rect.height / 2 - plateTop - 5, bubble?.offsetHeight ?? 0) : 'calc(50% - 5px)' }
  return <>
    {child}
    {visible && anchor && createPortal(
      <div ref={setBubble} role="tooltip" data-side={placement.side} className={'tr-tooltip' + (className ? ` ${className}` : '')}
        style={{ ...placement.style, visibility: placement.ready ? undefined : 'hidden' }}>
        {label}
        <span className="tr-tooltip-arrow" style={arrow} />
      </div>, document.body)}
  </>
}
