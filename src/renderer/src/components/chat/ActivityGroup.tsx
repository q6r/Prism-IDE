import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Box, ChevronRight } from 'lucide-react'
import { cn } from '../ui'
import { groupSummary, reasoningLabel, soleReasoning, toolSummary, type ActivityItem } from './activity'
import { reasoningDuration, toolStartedAt, useOpen } from './state'
import { LiveElapsed, Shimmer } from './primitives'
import { ReasoningSegment } from './Reasoning'
import { ToolSegmentView } from './ToolSegments'

const EXIT_MS = 300

/**
 * Bounded, tail-following viewport onto a live run (live-activity-window.tsx):
 * rows scroll up out of it instead of growing the turn, and it folds away
 * when the run settles.
 */
function LiveActivityWindow({ shown, children }: { shown: boolean; children: ReactNode }) {
  const [mounted, setMounted] = useState(shown)
  const scroller = useRef<HTMLDivElement | null>(null)
  const pinned = useRef(true)
  useEffect(() => {
    if (shown) { setMounted(true); return }
    const timer = setTimeout(() => setMounted(false), EXIT_MS)
    return () => clearTimeout(timer)
  }, [shown])
  const bind = useCallback((node: HTMLDivElement | null) => { scroller.current = node; if (node) pinned.current = true }, [])
  // Every render of the window means a row was added or grew: re-pin and re-measure.
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    el.dataset.overflowing = String(el.scrollHeight - el.clientHeight > 1)
    if (pinned.current) el.scrollTop = el.scrollHeight
  })
  if (!mounted && !shown) return null
  return <div className="ch-live" data-shown={String(shown)}>
    <div className="ch-live-clip">
      <div ref={bind} role="group" aria-label="Atividade ao vivo" className="ch-live-scroller tr-no-scrollbar"
        onScroll={() => { const el = scroller.current; if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 16 }}>
        {children}
      </div>
    </div>
  </div>
}

export interface ActivityGroupModel { key: string; items: ActivityItem[]; active: boolean }

/** Start of the currently running tool, for the group header heartbeat. */
function activeStartedAt(items: ActivityItem[], scope: string): number | null {
  let latest: number | null = null
  for (const item of items) {
    if (item.segment.kind !== 'tool' || !item.streaming) continue
    const at = toolStartedAt(`${scope}:${item.key}`)
    if (latest === null || at > latest) latest = at
  }
  return latest
}

/**
 * A run of tool calls and reasoning folded under one summary line
 * (activity-group-segment.tsx): "Pensou por 4s, leu 3 arquivos, executou 2
 * comandos". Collapsed by default; while live it shows a bounded window of
 * the rows instead.
 */
export const ActivityGroup = memo(function ActivityGroup({ group, scope, cwd, interrupted }: {
  group: ActivityGroupModel
  /** The turn id; scopes open state and live timing. */
  scope: string
  cwd?: string
  interrupted?: boolean
}) {
  const [open, setOpen] = useOpen(`${scope}:${group.key}`)
  const [reveal, setReveal] = useState<string | null>(null)
  const durations = new Map<string, number>()
  for (const item of group.items) {
    if (item.segment.kind !== 'thinking') continue
    const d = reasoningDuration(`${scope}:${item.key}`)
    if (d !== null) durations.set(item.key, d)
  }
  const label = groupSummary(group.items, durations)
  const headerless = soleReasoning(group.items)
  const startedAt = group.active ? activeStartedAt(group.items, scope) : null
  const liveShown = group.active && !open

  const renderChildren = (bounded: boolean): ReactNode => group.items.map((item) => {
    const openKey = `${scope}:${item.key}`
    const promote = bounded ? () => { setReveal(item.key); setOpen(true) } : null
    const row = item.segment.kind === 'thinking'
      ? <ReasoningSegment text={item.segment.text || ''} streaming={item.streaming} durationMs={reasoningDuration(openKey)}
        openKey={openKey} headerless={headerless} boundedByParent={bounded} onPromote={promote} />
      : <ToolSegmentView segment={item.segment} openKey={openKey} variant="row" interrupted={interrupted} cwd={cwd} onPromote={promote} />
    if (bounded || reveal !== item.key) return <div key={item.key}>{row}</div>
    return <div key={item.key} tabIndex={-1} role="group" className="ch-revealed"
      aria-label={item.segment.kind === 'thinking' ? reasoningLabel(item.streaming, reasoningDuration(openKey)) : toolSummary(item.segment.name || '', item.segment.input, cwd) || item.segment.name}
      ref={(node) => {
        if (!node) return
        const trigger = node.querySelector<HTMLElement>('[data-activity-row-trigger]')
        ;(trigger ?? node).focus({ preventScroll: true })
        node.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        setReveal(null)
      }}>{row}</div>
  })

  return <div className="ch-group">
    <button type="button" className="ch-group-trigger" data-state={open ? 'open' : 'closed'} aria-expanded={open} aria-label={label}
      onClick={() => { setOpen(!open); if (open) setReveal(null) }}>
      <Box size={14} aria-hidden className="ch-group-icon" />
      {group.active ? <Shimmer className="ch-group-label">{label}</Shimmer> : <span className="ch-group-label">{label}</span>}
      {startedAt !== null ? <LiveElapsed startedAt={startedAt} /> : null}
      <ChevronRight size={14} aria-hidden className={cn('ch-caret', open && 'open')} />
    </button>
    <LiveActivityWindow shown={liveShown}>{open ? null : renderChildren(true)}</LiveActivityWindow>
    {open ? <div className="ch-group-body">{renderChildren(false)}</div> : null}
  </div>
})
