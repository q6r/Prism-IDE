import { useEffect, useMemo, useRef } from 'react'
import type { ActivityCalendar, ActivityCell, HourGrid, UsageMetric } from '../../lib/usageAnalytics/aggregate'
import {
  formatDayLong, formatHour, formatInteger, formatMetricValue, formatMonth, formatTokens, formatUsd, formatWeekday, METRIC_LONG_LABELS, monthAbbr, turnsLabel
} from '../../lib/usageAnalytics/format'
import { HoverPlate, useCellHover } from './parts'

const LEVELS = [0, 1, 2, 3, 4] as const
/** Sunday-first rows labelled like GitHub's calendar (seg, qua, sex). */
const ROW_LABELS: Readonly<Record<number, string>> = { 1: 'seg', 3: 'qua', 5: 'sex' }

/**
 * A day's figure under the metric. A day of real turns with no cost is not
 * "no usage": it says how many turns ran and that they carry no cost.
 */
function cellValueLabel(cell: ActivityCell, metric: UsageMetric): string {
  if (cell.turns === 0) return 'Sem uso'
  if (metric === 'cost' && cell.costUsd === 0) return `${turnsLabel(cell.turns)} · sem custo`
  return formatMetricValue(cell.value, metric)
}

/**
 * GitHub-style calendar of the last 365 days (Traycer's usage-activity-heatmap),
 * independent of the period picker but scoped by the filters. One hover plate
 * for the whole grid; the grid is hidden from assistive tech and a table
 * carries the same values.
 */
export function UsageActivityHeatmap({ calendar, metric }: { calendar: ActivityCalendar; metric: UsageMetric }) {
  const scroller = useRef<HTMLDivElement>(null)
  const { anchor, cell: hoveredDay, bind } = useCellHover()
  const byDay = useMemo(() => new Map(calendar.weeks.flatMap((w) => w.cells).filter((c): c is ActivityCell => c !== null).map((c) => [c.day, c])), [calendar])
  const hovered = hoveredDay ? byDay.get(hoveredDay) ?? null : null
  // A fresh scroller starts at the oldest week; the newest is what matters.
  const weekCount = calendar.weeks.length
  useEffect(() => { const node = scroller.current; if (node) node.scrollLeft = node.scrollWidth }, [weekCount])
  const months = new Map(calendar.monthLabels.map((m) => [m.weekIndex, monthAbbr(m.month)]))
  const active = [...byDay.values()].filter((c) => c.turns > 0)
  const s = calendar.stats
  return <div data-testid="usage-activity">
    <div className="usg-heat-frame" aria-hidden="true">
      <div className="usg-heat-days">{Array.from({ length: 7 }, (_, row) => <span key={row}>{ROW_LABELS[row] ?? ''}</span>)}</div>
      <div ref={scroller} className="usg-heat-scroller" data-usage-export-fit="">
        <div className="usg-heat">
          <div className="usg-heat-months">{calendar.weeks.map((w, i) => <span key={w.firstDay}>{months.get(i) ?? ''}</span>)}</div>
          <div className="usg-heat-grid" {...bind}>
            {calendar.weeks.map((week) => <div key={week.firstDay} className="usg-heat-week">
              {week.cells.map((c, slot) => c === null
                ? <span key={slot} className="usg-cell blank" />
                : <span key={slot} className="usg-cell" data-cell={c.day} data-level={c.level} />)}
            </div>)}
          </div>
        </div>
      </div>
    </div>
    <HoverPlate anchor={hovered ? anchor : null}>
      {hovered ? <>
        <span className="usg-plate-title">{formatDayLong(hovered.day)}</span>
        {hovered.turns === 0 ? <span>Sem uso</span> : <span className="usg-plate-grid">
          <span>Custo</span><span>{hovered.costUsd > 0 ? formatUsd(hovered.costUsd) : '—'}</span>
          <span>Tokens</span><span>{formatTokens(hovered.tokens)}</span>
          <span>Turnos</span><span>{formatInteger(hovered.turns)}</span>
          {metric !== 'cost' && metric !== 'tokens' && metric !== 'turns' ? <><span>{METRIC_LONG_LABELS[metric]}</span><span>{cellValueLabel(hovered, metric)}</span></> : null}
        </span>}
      </> : null}
    </HoverPlate>
    <table className="tr-sr-only">
      <caption>Uso diário nos últimos 12 meses</caption>
      <thead><tr><th scope="col">Dia</th><th scope="col">{METRIC_LONG_LABELS[metric]}</th><th scope="col">Turnos</th></tr></thead>
      <tbody>{active.map((c) => <tr key={c.day}><th scope="row">{formatDayLong(c.day)}</th><td>{cellValueLabel(c, metric)}</td><td>{c.turns}</td></tr>)}</tbody>
    </table>
    <div className="usg-heat-foot">
      <dl className="usg-stats">
        <div><dt>Mês mais ativo</dt><dd>{s.mostActiveMonth ? formatMonth(s.mostActiveMonth) : '—'}</dd></div>
        <div><dt>Dia mais ativo</dt><dd>{s.mostActiveDay ? formatDayLong(s.mostActiveDay) : '—'}</dd></div>
        <div><dt>Maior sequência</dt><dd>{s.longestStreakDays}d</dd></div>
        <div><dt>Sequência atual</dt><dd>{s.currentStreakDays}d</dd></div>
        <div><dt>Dias ativos</dt><dd>{formatInteger(s.activeDays)}</dd></div>
      </dl>
      <div className="usg-levels" aria-hidden="true">Menos{LEVELS.map((l) => <span key={l} className="usg-cell" data-level={l} />)}Mais</div>
    </div>
  </div>
}

/** Monday-first rows: the working week reads first. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]

/** When the work happens: hour of day × weekday, in the viewer's zone. */
export function UsageHourGrid({ grid, metric }: { grid: HourGrid; metric: UsageMetric }) {
  const { anchor, cell, bind } = useCellHover()
  const [weekday, hour] = cell ? cell.split(':').map(Number) : [NaN, NaN]
  const hovered = cell ? { weekday, hour, value: grid.values[weekday]?.[hour] ?? 0, turns: grid.turns[weekday]?.[hour] ?? 0 } : null
  const busiestHour = grid.byHour.reduce((best, v, h) => v > grid.byHour[best] ? h : best, 0)
  const busiestDay = grid.byWeekday.reduce((best, v, d) => v > grid.byWeekday[best] ? d : best, 0)
  const any = grid.peak !== null || grid.turns.some((row) => row.some((t) => t > 0))
  return <div data-testid="usage-hours">
    <div className="usg-hours" aria-hidden="true" {...bind}>
      <span />
      {Array.from({ length: 24 }, (_, h) => <span key={h} className="usg-hours-label hour">{h % 3 === 0 ? formatHour(h) : ''}</span>)}
      {WEEK_ORDER.map((d) => [
        <span key={`l${d}`} className="usg-hours-label day">{formatWeekday(d)}</span>,
        ...Array.from({ length: 24 }, (_, h) => <span key={`${d}:${h}`} className="usg-cell" data-cell={`${d}:${h}`} data-level={grid.levels[d][h]} />)
      ])}
    </div>
    <HoverPlate anchor={hovered ? anchor : null}>
      {hovered ? <>
        <span className="usg-plate-title">{`${formatWeekday(hovered.weekday)}, ${formatHour(hovered.hour)} – ${formatHour((hovered.hour + 1) % 24)}`}</span>
        {hovered.turns === 0 ? <span>Sem uso</span> : <span className="usg-plate-grid">
          <span>{METRIC_LONG_LABELS[metric]}</span><span>{metric === 'cost' && hovered.value === 0 ? 'sem custo' : formatMetricValue(hovered.value, metric)}</span>
          <span>Turnos</span><span>{formatInteger(hovered.turns)}</span>
        </span>}
      </> : null}
    </HoverPlate>
    <table className="tr-sr-only">
      <caption>{`${METRIC_LONG_LABELS[metric]} por dia da semana e hora`}</caption>
      <thead><tr><th scope="col">Dia</th>{Array.from({ length: 24 }, (_, h) => <th key={h} scope="col">{formatHour(h)}</th>)}</tr></thead>
      <tbody>{WEEK_ORDER.map((d) => <tr key={d}><th scope="row">{formatWeekday(d)}</th>
        {grid.values[d].map((v, h) => <td key={h}>{grid.turns[d][h] ? formatMetricValue(v, metric) : '—'}</td>)}</tr>)}</tbody>
    </table>
    {any ? <div className="usg-peak">
      {grid.peak ? <span>Pico: <strong>{`${formatWeekday(grid.peak.weekday)}, ${formatHour(grid.peak.hour)}`}</strong> · {formatMetricValue(grid.peak.value, metric)}</span> : null}
      <span>Hora mais ativa: <strong>{formatHour(busiestHour)}</strong></span>
      <span>Dia mais ativo: <strong>{formatWeekday(busiestDay)}</strong></span>
    </div> : <p className="usg-note">Sem uso neste período.</p>}
  </div>
}
