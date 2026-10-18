import { useMemo, useState, type CSSProperties } from 'react'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { sortBreakdown, type BreakdownGroup, type BreakdownRow, type BreakdownSortKey, type SeriesScale, type UsageMetric } from '../../lib/usageAnalytics/aggregate'
import {
  DIMENSION_LABELS, formatDayLong, formatDuration, formatInteger, formatMetricValue, formatPercent, formatTokens, formatUsd, METRIC_LABELS
} from '../../lib/usageAnalytics/format'

interface Column { readonly key: BreakdownSortKey; readonly label: string; readonly numeric: boolean }

/**
 * The breakdown table (Traycer's usage-breakdown-table + day table): always
 * every figure (turns, tokens, cost, time) whatever the metric, so exact
 * values never sit behind a hover; the share column follows the metric.
 * Headers sort.
 */
export function UsageBreakdownTable({ rows, group, metric, scale }: { rows: readonly BreakdownRow[]; group: BreakdownGroup; metric: UsageMetric; scale: SeriesScale | null }) {
  const [sort, setSort] = useState<{ key: BreakdownSortKey; direction: 'asc' | 'desc' } | null>(null)
  const sorted = useMemo(() => sort ? sortBreakdown(rows, sort.key, sort.direction) : rows, [rows, sort])
  if (!rows.length) return <p className="usg-empty">Nenhum uso neste período.</p>
  const name = group === 'day' ? 'Dia' : DIMENSION_LABELS[group]
  const columns: Column[] = [
    { key: 'label', label: name, numeric: false },
    { key: 'turns', label: 'Turnos', numeric: true },
    { key: 'tokens', label: 'Tokens', numeric: true },
    { key: 'cost', label: 'Custo', numeric: true },
    { key: 'duration', label: 'Tempo', numeric: true },
    { key: 'value', label: `Participação · ${METRIC_LABELS[metric]}`, numeric: false }
  ]
  const toggle = (key: BreakdownSortKey): void => setSort((s) => !s || s.key !== key ? { key, direction: key === 'label' ? 'asc' : 'desc' }
    : s.direction === 'desc' ? { key, direction: 'asc' } : null)
  return <div className="usg-table-wrap">
    <table className="usg-table">
      <thead><tr>
        {columns.map((c) => {
          const active = sort?.key === c.key
          return <th key={c.key} scope="col" className={c.numeric ? 'num' : undefined} aria-sort={active ? (sort!.direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
            <button type="button" className="usg-sort" onClick={() => toggle(c.key)}>
              {c.label}{active ? sort!.direction === 'asc' ? <ArrowUp aria-hidden="true" /> : <ArrowDown aria-hidden="true" /> : null}
            </button>
          </th>
        })}
      </tr></thead>
      <tbody>{sorted.map((row) => {
        const swatch = scale && group !== 'day' ? { '--swatch': `var(${scale.tokenFor(row.key)})` } as CSSProperties : null
        return <tr key={row.key}>
          <td>
            <span className="usg-cell-name">
              {swatch ? <span className="usg-dot" style={swatch} aria-hidden="true" /> : null}
              <span className="usg-cell-name-text">
                <span>{group === 'day' ? formatDayLong(row.key) : row.label}</span>
                {row.detail ? <span className="usg-cell-detail">{row.detail}</span> : null}
              </span>
            </span>
          </td>
          <td className="num">{formatInteger(row.turns)}</td>
          <td className="num" title={`${formatInteger(row.totalTokens)} tokens`}>{formatTokens(row.totalTokens)}</td>
          <td className="num">{row.pricedTurns ? formatUsd(row.costUsd) : <span className="usg-dim" title="Nenhum turno deste grupo informou custo.">—</span>}</td>
          <td className="num">{formatDuration(row.durationMs)}</td>
          <td>
            <span className="usg-share">
              <span className="usg-bar"><span style={{ '--swatch': swatch ? `var(${scale!.tokenFor(row.key)})` : 'var(--usg-series-1)', width: `${Math.min(100, row.share * 100)}%` } as CSSProperties} /></span>
              <span className="usg-share-pct" title={formatMetricValue(row.value, metric)}>{formatPercent(row.share * 100)}</span>
            </span>
          </td>
        </tr>
      })}</tbody>
    </table>
  </div>
}
