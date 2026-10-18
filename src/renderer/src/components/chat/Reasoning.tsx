import { useEffect, useRef } from 'react'
import { Brain, ChevronRight } from 'lucide-react'
import { cn } from '../ui'
import { reasoningLabel } from './activity'
import { useOpen } from './state'
import { Shimmer } from './primitives'
import { Markdown } from './Markdown'

/**
 * Fixed-height tail of a streaming thought that stays pinned to the newest
 * text; the top fades once it overflows (reasoning-segment.tsx ReasoningTail).
 */
function ReasoningTail({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.dataset.overflowing = String(el.scrollHeight - el.clientHeight > 1)
    if (pinned.current) el.scrollTop = el.scrollHeight
  }, [text])
  return <div ref={ref} className="ch-reasoning-tail tr-no-scrollbar"
    onScroll={() => { const el = ref.current; if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 16 }}>
    <Markdown text={text} size="compact" muted streaming />
  </div>
}

/**
 * One reasoning block inside an activity group (reasoning-segment.tsx). The
 * collapsed, finished block renders no markdown at all; the trace mounts only
 * while it streams (as a bounded tail) or once the reader opens it.
 */
export function ReasoningSegment({ text, streaming, durationMs, openKey, headerless, boundedByParent, onPromote }: {
  text: string
  streaming: boolean
  durationMs: number | null
  openKey: string
  /** The group header already carries this block's label (it is the group's only member). */
  headerless: boolean
  /** Rendered inside the live window, which caps the height itself. */
  boundedByParent: boolean
  onPromote?: (() => void) | null
}) {
  const [expanded, setExpanded] = useOpen(openKey)
  const label = reasoningLabel(streaming, durationMs)
  const toggle = (): void => { if (onPromote) { setExpanded(true); onPromote() } else setExpanded(!expanded) }
  const showTail = streaming && !expanded && !boundedByParent
  const bodyShown = headerless || streaming || expanded
  const actionable = !!onPromote || showTail || (expanded && streaming)
  return <div className="ch-reasoning">
    {headerless && !actionable ? null : <button type="button" data-activity-row-trigger=""
      className={cn('ch-reasoning-head', headerless && 'tr-sr-only', expanded && 'expanded')}
      aria-expanded={onPromote ? undefined : expanded} onClick={toggle}>
      <Brain size={14} aria-hidden className="ch-reasoning-icon" />
      {streaming ? <Shimmer className={cn('ch-reasoning-label', expanded && 'lit')}>{label}</Shimmer> : <span className="ch-reasoning-label">{label}</span>}
      <ChevronRight size={14} className={cn('ch-caret', expanded && 'open')} aria-hidden />
    </button>}
    {bodyShown && text.trim() ? <div role="group" aria-label={label} className={cn('ch-reasoning-body', (showTail || onPromote) && 'clickable')}
      onClick={(e) => {
        if ((e.target as Element).closest('a, button, input, summary')) return
        const sel = window.getSelection()
        if (sel && !sel.isCollapsed && sel.anchorNode && e.currentTarget.contains(sel.anchorNode)) return
        if (headerless && !streaming && !onPromote) { setExpanded(true); return }
        toggle()
      }}>
      {showTail ? <ReasoningTail text={text} /> : <Markdown text={text} size="compact" muted streaming={streaming} className="ch-reasoning-text" />}
    </div> : null}
  </div>
}
