import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Check, ChevronDown, ChevronRight, Copy } from 'lucide-react'
import { cn } from '../ui'
import { useRunClock } from '../AgentMonitor'
import { formatClock } from './activity'

/** Clipboard copy with a transient "copied" flag (Traycer useClipboardCopy). */
export function useCopy(resetMs = 1600): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = useCallback((text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), resetMs)
    }).catch(() => {})
  }, [resetMs])
  return [copied, copy]
}

/** A highlight band sweeping across a live step's label (ui/shimmer.tsx). */
export function Shimmer({ children, className }: { children: string; className?: string }) {
  return <span className={cn('ch-shimmer', className)} style={{ '--ch-spread': `${children.length}px` } as CSSProperties}>{children}</span>
}

/** The in-progress verb with a foreground sweep (ui/working-shimmer-text.tsx). */
export function WorkingText({ children }: { children: string }) {
  return <span className="ch-working-text">{children}</span>
}

/** Three sequentially pulsing dots (AgentSpinningDots variant="typing"). */
export function WorkingDots() {
  return <span className="ch-working-dots" aria-hidden="true"><span /><span /><span /></span>
}

/** Live status dot with a ping ring (ui/live-pulse.tsx, size xs). */
export function LivePulse({ label, tone = 'active' }: { label: string; tone?: 'active' | 'idle' }) {
  return <span className={cn('ch-pulse', tone)} role="img" aria-label={label}>
    {tone === 'active' && <span className="ch-pulse-ring" />}
    <span className="ch-pulse-dot" />
  </span>
}

/** Live-ticking elapsed since `startedAt` (segment-elapsed.tsx). */
export function LiveElapsed({ startedAt, className }: { startedAt: number; className?: string }) {
  const now = useRunClock(true)
  return <span className={cn('ch-elapsed', className)}>{formatClock((now - startedAt) / 1000)}</span>
}

/** Small uppercase state chip: `erro`, `negado`, `interrompido`… */
export function StateBadge({ label, tone }: { label: string; tone: 'muted' | 'destructive' }) {
  return <span className={cn('ch-state-badge', tone)}>{label}</span>
}

/** The muted 24px copy button used by segment panels and the reply footer. */
export function CopyButton({ text, label, className }: { text: string; label: string; className?: string }) {
  const [copied, copy] = useCopy()
  return <button type="button" className={cn('ch-copy', className)} aria-label={copied ? 'Copiado' : label}
    onClick={(e) => { e.stopPropagation(); copy(text) }}>
    {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
  </button>
}

/**
 * Labelled panel inside an expanded segment (segment-panel.tsx): uppercase
 * overline, hover-revealed copy, framed body capped at 40vh.
 */
export function SegmentPanel({ label, copyValue, tone = 'default', children }: {
  label: string
  copyValue?: string | null
  tone?: 'default' | 'destructive'
  children: ReactNode
}) {
  return <div className="ch-panel">
    <div className="ch-panel-head">
      <span className={cn('ch-panel-label', tone === 'destructive' && 'destructive')}>{label}</span>
      {copyValue ? <CopyButton text={copyValue} label={`Copiar ${label.toLowerCase()}`} className="ch-panel-copy" /> : null}
    </div>
    <div className="ch-panel-body">{children}</div>
  </div>
}

/** `$ command` / pre body used inside panels. */
export function PanelPre({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'destructive' }) {
  return <pre className={cn('ch-panel-pre', tone === 'destructive' && 'destructive')}>{children}</pre>
}

/**
 * Bare collapsible row for activity inside a group (segment-row.tsx): no box,
 * trailing caret revealed on hover/focus/open, body indented under the row.
 * Inside the live window `onPromote` replaces the disclosure.
 */
export function SegmentRow({ open, onOpenChange, header, body, tone = 'default', expandable, footer, onPromote }: {
  open: boolean
  onOpenChange: (next: boolean) => void
  header: ReactNode
  body: ReactNode
  tone?: 'default' | 'destructive'
  expandable: boolean
  footer?: ReactNode
  onPromote?: (() => void) | null
}) {
  const destructive = tone === 'destructive'
  if (!expandable) {
    return <div className="ch-row">
      <div className="ch-row-head">
        <div className={cn('ch-row-static', destructive && 'destructive')}><span className="ch-row-header">{header}</span></div>
      </div>
      {footer ? <div className="ch-row-footer">{footer}</div> : null}
    </div>
  }
  const promoting = !!onPromote
  return <div className="ch-row" data-state={open ? 'open' : 'closed'}>
    <div className={cn('ch-row-head', open && !promoting && 'sticky')}>
      <button type="button" className={cn('ch-row-trigger', destructive && 'destructive')} data-activity-row-trigger=""
        data-state={!promoting && open ? 'open' : 'closed'} aria-expanded={promoting ? undefined : open}
        onClick={() => { if (onPromote) { onOpenChange(true); onPromote() } else onOpenChange(!open) }}>
        <span className="ch-row-header">{header}</span>
        <ChevronRight size={14} className="ch-caret" aria-hidden />
      </button>
    </div>
    {open && !promoting && body ? <div className="ch-row-body">{body}</div> : null}
    {footer ? <div className="ch-row-footer">{footer}</div> : null}
  </div>
}

/**
 * Bordered, collapsible segment shell (segment-card.tsx): the whole header is
 * the trigger; tone tints live work and failures.
 */
export function SegmentCard({ open, onOpenChange, header, body, tone = 'default', expandable, collapsedPreview, stickyHeader }: {
  open: boolean
  onOpenChange: (next: boolean) => void
  header: ReactNode
  body: ReactNode
  tone?: 'default' | 'destructive' | 'primary'
  expandable: boolean
  collapsedPreview?: ReactNode
  stickyHeader?: boolean
}) {
  if (!expandable) {
    return <div className={cn('ch-card', tone)}>
      <div className="ch-card-static"><span className="ch-card-header">{header}</span></div>
      {collapsedPreview ? <div className="ch-card-preview">{collapsedPreview}</div> : null}
    </div>
  }
  return <div className={cn('ch-card', tone)} data-state={open ? 'open' : 'closed'}>
    <div className={cn('ch-card-head', open && 'open', open && stickyHeader && 'sticky')}>
      <button type="button" className="ch-card-trigger" aria-expanded={open} onClick={() => onOpenChange(!open)}>
        <span className="ch-card-header">{header}</span>
        <ChevronDown size={14} className="ch-card-chevron" aria-hidden />
      </button>
    </div>
    {!open && collapsedPreview ? <div className="ch-card-preview">{collapsedPreview}</div> : null}
    {open ? <div className="ch-card-body">{body}</div> : null}
  </div>
}
