import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import type { AgentSelection } from '../../../../shared/agents'
import { cn, Tooltip } from '../ui'
import { EFFORT_LABELS } from '../../lib/modelCatalog'

type Effort = AgentSelection['effort']

/**
 * Traycer's thinking-effort pill slider (harness-model-picker-footers.tsx):
 * one stop per catalog level, a solid fill up to the thumb, and the "max"
 * treatment (primary → violet gradient, fine edge, twinkling field) on the
 * last level. The thumb is the slider; the dots are direct picks.
 */
export default function EffortSlider({ value, levels, disabled, onChange, open }: {
  value: Effort
  levels: readonly Effort[]
  disabled: boolean
  onChange: (next: Effort) => void
  /** The picker is visible; sparkles only run while it is. */
  open: boolean
}) {
  const last = levels.length - 1
  const selected = Math.max(0, levels.indexOf(value))
  const [drag, setDrag] = useState<number | null>(null)
  const [pressed, setPressed] = useState(false)
  const track = useRef<HTMLDivElement>(null)
  const position = drag ?? selected
  const fraction = last <= 0 ? 0 : position / last
  const atMax = levels.length > 1 && levels.indexOf(value) === last
  const indexAt = (clientX: number): number => {
    const rect = track.current!.getBoundingClientRect()
    const inner = Math.max(1, rect.width - 24)
    const f = Math.min(1, Math.max(0, (clientX - rect.left - 12) / inner))
    return Math.round(f * last)
  }
  const commit = (index: number): void => { const next = levels[index]; if (next && next !== value) onChange(next) }
  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (disabled || e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    setPressed(true)
    const index = indexAt(e.clientX)
    setDrag(index); commit(index)
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    if (drag === null) return
    const index = indexAt(e.clientX)
    if (index !== drag) { setDrag(index); commit(index) }
  }
  const finish = (): void => { setDrag(null); setPressed(false) }
  const onKeyDown = (e: KeyboardEvent<HTMLSpanElement>): void => {
    if (disabled) return
    const to = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? selected + 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? selected - 1
      : e.key === 'Home' ? 0 : e.key === 'End' ? last : null
    if (to === null) return
    e.preventDefault()
    commit(Math.min(last, Math.max(0, to)))
  }
  const label = EFFORT_LABELS[value] ?? value
  return <div className="tmp-slider-wrap">
    <div className="tmp-slider" data-max={atMax || undefined} data-dragging={drag !== null || undefined} data-pressed={pressed || undefined}
      aria-disabled={disabled || undefined} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}>
      <div ref={track} className={cn('tmp-slider-track', atMax && 'max')}>
        <span className={cn('tmp-slider-range', atMax && 'max')} style={{ width: `calc(12px + ${fraction} * (100% - 24px))` }} />
        {atMax && open && !disabled ? <Sparkles /> : null}
      </div>
      <div className="tmp-slider-stops" aria-hidden="true">
        <div className="tmp-slider-stops-inner">
          {levels.map((level, index) => <Tooltip key={level} label={EFFORT_LABELS[level] ?? level} side="top" sideOffset={6}>
            <button type="button" tabIndex={-1} disabled={disabled} className={cn('tmp-slider-stop', index === position && 'selected')}
              style={{ left: `${last === 0 ? 0 : (index / last) * 100}%` }}
              onPointerDown={(e) => { e.stopPropagation(); if (!disabled) commit(index) }}>
              <span className={cn('tmp-slider-dot', index < position && 'over')} />
            </button>
          </Tooltip>)}
        </div>
      </div>
      <span role="slider" tabIndex={disabled ? -1 : 0} aria-label="Esforço de raciocínio" aria-valuemin={0} aria-valuemax={last} aria-valuenow={selected}
        aria-valuetext={label} aria-disabled={disabled || undefined} className="tmp-slider-thumb" style={{ left: `calc(${fraction} * (100% - 24px))` }} onKeyDown={onKeyDown} />
    </div>
    <Tooltip label={label} side="top" sideOffset={4} align="end">
      <span className="tmp-effort-label" data-max={atMax || undefined}>{label}</span>
    </Tooltip>
  </div>
}

/** Fixed constellation (left%, top%, size px; null = ✦ glint) twinkling over the max fill. */
const SPARKLES: readonly [number, number, number | null, number][] = [
  [8, 30, 1.5, 0], [15, 64, 1, 0.19], [22, 22, null, 0.42], [34, 52, 2, 0.12], [41, 26, 1, 0.62], [49, 60, null, 0.31],
  [57, 34, 1.5, 0.77], [63, 66, 1, 0.5], [71, 40, 2, 0.08], [78, 24, null, 0.69], [85, 58, 1, 0.35]
]
function Sparkles() {
  return <span className="tmp-sparkles" aria-hidden="true">
    {SPARKLES.map(([left, top, size, phase]) => <span key={`${left}-${top}`} className={size === null ? 'tmp-glint' : 'tmp-sparkle'}
      style={{ left: `${left}%`, top: `${top}%`, animationDelay: `${-phase * 2400}ms`, ...(size === null ? {} : { width: size, height: size }) }}>{size === null ? '✦' : null}</span>)}
  </span>
}
