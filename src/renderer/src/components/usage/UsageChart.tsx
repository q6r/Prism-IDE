import { useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'
import type { BarSeriesOption, LineSeriesOption } from 'echarts/charts'
import type { GridComponentOption, TooltipComponentOption } from 'echarts/components'
import type { ComposeOption } from 'echarts/core'
import { hideSeries, type ChartColumn, type SeriesScale, type UsageMetric } from '../../lib/usageAnalytics/aggregate'
import { formatDayLong, formatDayRange, formatDayShort, formatHour, formatMetricValue, METRIC_LONG_LABELS } from '../../lib/usageAnalytics/format'
import type { UsageGranularity } from '../../lib/usageAnalytics/time'
import { EChartsView } from './EChartsView'
import { prefersReducedMotion, usePalette, withAlpha } from './palette'
import type { ChartKind } from './prefs'

type ChartOption = ComposeOption<LineSeriesOption | BarSeriesOption | GridComponentOption | TooltipComponentOption>

const CHROME = ['--usg-chart-axis', '--usg-chart-grid', '--usg-chart-previous', '--tr-popover', '--tr-border', '--tr-popover-foreground'] as const

function columnLabel(column: ChartColumn, granularity: UsageGranularity): string {
  return granularity === 'hour' ? formatHour(column.key) : formatDayShort(granularity === 'week' ? column.from : column.key)
}

function columnTitle(column: ChartColumn, granularity: UsageGranularity): string {
  if (granularity === 'hour') return `${formatHour(column.key)} – ${formatHour((Number(column.key) + 1) % 24)}`
  if (granularity === 'week') return `Semana de ${formatDayRange(column.from, column.to)}`
  return formatDayLong(column.key)
}

const escapeHtml = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * The option, with every color already resolved (rgba): gradients and the
 * export clone both need real colors, and a theme switch rebuilds it.
 */
export function buildChartOption(input: {
  readonly columns: readonly ChartColumn[]
  readonly scale: SeriesScale
  readonly metric: UsageMetric
  readonly granularity: UsageGranularity
  readonly kind: ChartKind
  readonly hidden: ReadonlySet<string>
  readonly compare: boolean
  readonly colors: Readonly<Record<string, string>>
  readonly animate: boolean
}): ChartOption {
  const { columns, scale, metric, granularity, kind, hidden, compare, colors, animate } = input
  const color = (key: string): string => colors[scale.tokenFor(key)] ?? 'rgba(128, 128, 128, 1)'
  const axis = colors['--usg-chart-axis'] ?? 'rgba(140, 140, 140, 1)'
  const grid = colors['--usg-chart-grid'] ?? 'rgba(128, 128, 128, 0.15)'
  const previousColor = colors['--usg-chart-previous'] ?? axis
  const single = columns.length === 1
  // The topmost visible segment of each bar gets the rounded cap.
  const tops = columns.map((c) => { for (let i = scale.order.length - 1; i >= 0; i--) if (c.segments[i] > 0) return i; return -1 })
  const series: (LineSeriesOption | BarSeriesOption)[] = scale.order.map((key, index) => {
    const c = color(key)
    const silent = hidden.has(key) || columns.every((col) => col.segments[index] === 0)
    const data = columns.map((col) => col.segments[index])
    if (kind === 'bar') {
      return {
        name: scale.labelFor(key), type: 'bar', stack: 'usage', barMaxWidth: 26, color: c,
        itemStyle: { color: c }, emphasis: { focus: 'none', itemStyle: { color: c } },
        data: data.map((value, i) => tops[i] === index ? { value, itemStyle: { color: c, borderRadius: [3, 3, 0, 0] } } : value)
      } satisfies BarSeriesOption
    }
    const area = { color: { type: 'linear' as const, x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: withAlpha(c, 0.42) }, { offset: 1, color: withAlpha(c, 0.04) }] }, opacity: silent ? 0 : 1 }
    return {
      name: scale.labelFor(key), type: 'line', stack: 'usage', smooth: 0.3, showSymbol: single && !silent, symbolSize: 6, color: c,
      lineStyle: { width: silent ? 0 : 2, color: c }, areaStyle: area,
      // Explicit emphasis colors: without them ECharts' hover "lift" blanks the fills.
      emphasis: { focus: 'none', lineStyle: { width: silent ? 0 : 2, color: c }, areaStyle: area, itemStyle: { color: c } },
      data
    } satisfies LineSeriesOption
  })
  if (compare) {
    series.push({
      name: 'Período anterior', type: 'line', smooth: 0.3, showSymbol: single, symbolSize: 5, z: 10, color: previousColor,
      lineStyle: { width: 1.5, type: 'dashed', color: previousColor }, itemStyle: { color: previousColor },
      emphasis: { focus: 'none', lineStyle: { width: 1.5, type: 'dashed', color: previousColor } },
      data: columns.map((c) => c.previous ?? 0)
    })
  }
  return {
    animation: animate, animationDuration: 420, animationEasing: 'cubicOut', animationDurationUpdate: 320,
    grid: { left: 4, right: 12, top: 14, bottom: 4, containLabel: true },
    xAxis: {
      type: 'category', boundaryGap: kind === 'bar', data: columns.map((c) => columnLabel(c, granularity)),
      axisLabel: { color: axis, fontSize: 11, hideOverlap: true }, axisLine: { lineStyle: { color: grid } }, axisTick: { show: false }
    },
    yAxis: {
      type: 'value', axisLabel: { color: axis, fontSize: 11, formatter: (value: number) => formatMetricValue(value, metric) },
      splitLine: { lineStyle: { color: grid, type: 'dashed' } }
    },
    tooltip: {
      trigger: 'axis', appendTo: 'body', confine: false, className: 'usg-echarts-tip', padding: [8, 10],
      backgroundColor: colors['--tr-popover'] ?? 'rgba(30, 30, 30, 1)', borderColor: colors['--tr-border'] ?? grid, borderWidth: 1,
      textStyle: { color: colors['--tr-popover-foreground'] ?? '#fff', fontSize: 12 },
      extraCssText: 'border-radius: 8px; box-shadow: 0 10px 15px -3px rgb(0 0 0 / 0.3);',
      axisPointer: kind === 'bar' ? { type: 'shadow', shadowStyle: { color: withAlpha(axis, 0.08) } } : { type: 'line', lineStyle: { color: withAlpha(axis, 0.5) } },
      formatter: (params) => {
        const list = Array.isArray(params) ? params : [params]
        const column = columns[list[0]?.dataIndex ?? 0]
        if (!column) return ''
        const rows = scale.order.map((key, i) => ({ key, value: column.segments[i] })).filter((r) => r.value > 0 && !hidden.has(r.key))
        const head = `<div class="usg-tip-head">${escapeHtml(columnTitle(column, granularity))}</div>`
        const body = rows.length
          ? rows.map((r) => `<div class="usg-tip-row"><span class="usg-tip-name"><i style="background:${color(r.key)}"></i>${escapeHtml(scale.labelFor(r.key))}</span><span class="usg-tip-value">${escapeHtml(formatMetricValue(r.value, metric))}</span></div>`).join('')
          : '<div class="usg-tip-muted">Sem uso</div>'
        const total = rows.length > 1 ? `<div class="usg-tip-row usg-tip-total"><span class="usg-tip-name">Total</span><span class="usg-tip-value">${escapeHtml(formatMetricValue(column.total, metric))}</span></div>` : ''
        const previous = compare && column.previous !== null ? `<div class="usg-tip-row${rows.length > 1 ? '' : ' usg-tip-total'}"><span class="usg-tip-name"><i style="background:${previousColor}"></i>Período anterior</span><span class="usg-tip-value">${escapeHtml(formatMetricValue(column.previous, metric))}</span></div>` : ''
        return `<div class="usg-tip">${head}${body}${total}${previous}</div>`
      }
    },
    series
  }
}

/**
 * Stacked usage over the window (Traycer's usage-daily-chart): one band per
 * series of the scale, an optional dashed line for the previous period, the
 * legend doubling as a series filter, and the same values as a hidden table.
 * Mount with `key` = the grouping, so the hidden set resets with it.
 */
export function UsageChart({ columns, scale, metric, granularity, kind, compare, rootRef }: {
  columns: readonly ChartColumn[]
  scale: SeriesScale
  metric: UsageMetric
  granularity: UsageGranularity
  kind: ChartKind
  compare: boolean
  rootRef: RefObject<HTMLElement | null>
}) {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set())
  const tokens = useMemo(() => [...new Set([...scale.order.map((k) => scale.tokenFor(k)), ...CHROME])], [scale])
  const colors = usePalette(rootRef, tokens)
  const visible = useMemo(() => hideSeries(columns, scale, hidden), [columns, scale, hidden])
  const animate = useRef(!prefersReducedMotion()).current
  const option = useMemo(() => Object.keys(colors).length
    ? buildChartOption({ columns: visible, scale, metric, granularity, kind, hidden, compare, colors, animate }) : null,
  [visible, scale, metric, granularity, kind, hidden, compare, colors, animate])
  const toggle = (key: string): void => setHidden((prev) => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })
  const unit = granularity === 'hour' ? 'hora' : granularity === 'week' ? 'semana' : 'dia'
  const visibleKeys = scale.order.filter((k) => !hidden.has(k))
  return <div className="usg-chart" data-testid="usage-chart">
    <EChartsView option={option} className="usg-echarts" ariaLabel={`${METRIC_LONG_LABELS[metric]} por ${unit}`} />
    <table className="tr-sr-only">
      <caption>{`${METRIC_LONG_LABELS[metric]} por ${unit}`}</caption>
      <thead><tr><th scope="col">Período</th>{visibleKeys.map((k) => <th key={k} scope="col">{scale.labelFor(k)}</th>)}{compare ? <th scope="col">Período anterior</th> : null}</tr></thead>
      <tbody>{visible.map((c) => <tr key={c.key}>
        <th scope="row">{columnTitle(c, granularity)}</th>
        {visibleKeys.map((k) => <td key={k}>{formatMetricValue(c.segments[scale.order.indexOf(k)] ?? 0, metric)}</td>)}
        {compare ? <td>{c.previous === null ? '—' : formatMetricValue(c.previous, metric)}</td> : null}
      </tr>)}</tbody>
    </table>
    {/* A one-series chart has nothing to filter, unless its only series is the hidden one. */}
    {scale.order.length >= 2 || compare || scale.order.some((k) => hidden.has(k)) ? <ul className="usg-legend" aria-label="Séries">
      {scale.order.length >= 2 || scale.order.some((k) => hidden.has(k)) ? scale.order.map((key) => <li key={key}>
        <button type="button" aria-pressed={!hidden.has(key)} onClick={() => toggle(key)}
          title={scale.detailFor(key) ?? undefined}>
          <span className="usg-dot" style={{ '--swatch': `var(${scale.tokenFor(key)})` } as CSSProperties} aria-hidden="true" />
          {scale.labelFor(key)}
        </button>
      </li>) : null}
      {compare ? <li className="usg-legend-previous">Período anterior</li> : null}
    </ul> : null}
  </div>
}
