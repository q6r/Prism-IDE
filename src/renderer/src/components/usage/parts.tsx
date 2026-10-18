import { useCallback, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ArrowDownRight, ArrowRight, ArrowUpRight, LineChart, type LucideIcon } from 'lucide-react'
import { cn, Tooltip, useFloating } from '../ui'
import { formatPercentChange } from '../../lib/usageAnalytics/format'

/** A titled section card of the usage page. */
export function UsageCard({ title, icon: Icon, subtitle, actions, delay = 0, className, children, ...rest }: {
  title?: ReactNode
  icon?: LucideIcon
  subtitle?: ReactNode
  actions?: ReactNode
  /** Entrance stagger, ms. */
  delay?: number
  className?: string
  children: ReactNode
} & Record<`data-${string}`, string | undefined>) {
  return <section className={cn('usg-card', className)} style={{ '--usg-delay': `${delay}ms` } as CSSProperties} {...rest}>
    {title !== undefined || actions ? <header className="usg-card-head">
      <div>
        {title !== undefined ? <h3 className="usg-card-title">{Icon ? <Icon aria-hidden="true" /> : null}{title}</h3> : null}
        {subtitle ? <p className="usg-card-sub">{subtitle}</p> : null}
      </div>
      {actions ? <div className="usg-card-actions">{actions}</div> : null}
    </header> : null}
    {children}
  </section>
}

/**
 * Change against the previous period. Neutral by design: more spend or more
 * turns is not good or bad by itself, so the arrow carries the direction and
 * the tooltip names the base.
 */
export function ChangePill({ percent, previousLabel, size }: { percent: number | null; previousLabel: string; size?: 'small' }) {
  if (percent === null) {
    return <Tooltip label={`Sem uso em ${previousLabel} para comparar`}>
      <span className={cn('usg-change new', size)}>novo</span>
    </Tooltip>
  }
  const direction = Math.abs(percent) < 0.05 ? 'flat' : percent > 0 ? 'up' : 'down'
  const Icon = direction === 'up' ? ArrowUpRight : direction === 'down' ? ArrowDownRight : ArrowRight
  return <Tooltip label={`Comparado a ${previousLabel}`}>
    <span className={cn('usg-change', direction, size)}><Icon aria-hidden="true" />{formatPercentChange(percent)}</span>
  </Tooltip>
}

/** An idle or failed state in place of the dashboard (Traycer's UsageNotice). */
export function UsageNotice({ title, detail, tone = 'idle', icon: Icon = LineChart, action }: { title: string; detail: ReactNode; tone?: 'idle' | 'error'; icon?: LucideIcon; action?: ReactNode }) {
  return <div role={tone === 'error' ? 'alert' : 'status'} className={cn('usg-notice', tone === 'error' && 'error')}>
    <span className="usg-notice-icon"><Icon aria-hidden="true" /></span>
    <div>
      <p className="usg-notice-title">{title}</p>
      <p className="usg-notice-text">{detail}</p>
    </div>
    {action}
  </div>
}

/** One tooltip plate for a whole grid of marks, anchored to the hovered one. */
export function HoverPlate({ anchor, children }: { anchor: HTMLElement | null; children: ReactNode }) {
  const [bubble, setBubble] = useState<HTMLDivElement | null>(null)
  const placement = useFloating(anchor, bubble, { open: !!anchor, side: 'top', sideOffset: 8, collisionPadding: 8 })
  if (!anchor) return null
  return createPortal(<div ref={setBubble} role="tooltip" className="tr-tooltip usg-plate"
    style={{ ...placement.style, visibility: placement.ready ? undefined : 'hidden' }}>{children}</div>, document.body)
}

/**
 * Hover tracking for a grid of `[data-cell]` marks: one listener on the grid
 * rather than one per mark (a year calendar has 365).
 */
export function useCellHover(): {
  readonly anchor: HTMLElement | null
  readonly cell: string | null
  readonly bind: { onPointerOver: (e: ReactPointerEvent) => void; onPointerLeave: () => void }
} {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const onPointerOver = useCallback((e: ReactPointerEvent) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-cell]')
    setAnchor((prev) => {
      if (prev === target) return prev
      prev?.removeAttribute('data-hover')
      target?.setAttribute('data-hover', 'true')
      return target
    })
  }, [])
  const onPointerLeave = useCallback(() => setAnchor((prev) => { prev?.removeAttribute('data-hover'); return null }), [])
  return { anchor, cell: anchor?.dataset.cell ?? null, bind: { onPointerOver, onPointerLeave } }
}
