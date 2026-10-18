import { SegmentedControl, Select } from '../ui'
import { isTokenMetric, type UsageMetric } from '../../lib/usageAnalytics/aggregate'
import { formatDayRange } from '../../lib/usageAnalytics/format'
import { isDayKey, type UsageWindow } from '../../lib/usageAnalytics/time'
import type { PeriodKey, UsagePrefs } from './prefs'

const PERIODS: readonly { value: PeriodKey; label: string }[] = [
  { value: 'today', label: 'Hoje' },
  { value: '7', label: '7 dias' },
  { value: '30', label: '30 dias' },
  { value: '90', label: '90 dias' },
  { value: 'year', label: 'Ano' },
  { value: 'all', label: 'Tudo' },
  { value: 'custom', label: 'Personalizado' }
]

/** Period presets, a custom range, and the window it resolved to. */
export function PeriodPicker({ prefs, window, today, onChange }: { prefs: UsagePrefs; window: UsageWindow; today: string; onChange: (patch: Partial<UsagePrefs>) => void }) {
  const custom = prefs.custom ?? { from: window.from, to: window.to }
  const setRange = (from: string, to: string): void => {
    if (!isDayKey(from) || !isDayKey(to)) return
    onChange({ period: 'custom', custom: from <= to ? { from, to } : { from: to, to: from } })
  }
  return <>
    <SegmentedControl ariaLabel="Período" value={prefs.period} options={PERIODS}
      onChange={(period) => onChange(period === 'custom' ? { period, custom } : { period })} />
    {prefs.period === 'custom' ? <span className="usg-custom-range">
      <label htmlFor="usg-from">De</label>
      <input id="usg-from" type="date" className="tr-input s-xs usg-date" value={custom.from} max={today} onChange={(e) => setRange(e.target.value, custom.to)} />
      <label htmlFor="usg-to">até</label>
      <input id="usg-to" type="date" className="tr-input s-xs usg-date" value={custom.to} max={today} onChange={(e) => setRange(custom.from, e.target.value)} />
    </span> : null}
    <span className="usg-range-label" data-testid="usage-date-range-label"
      title={prefs.period === 'year' ? 'Últimos 365 dias' : undefined}>{formatDayRange(window.from, window.to)}</span>
  </>
}

const METRIC_GROUPS: readonly { value: 'cost' | 'tokens' | 'turns' | 'duration'; label: string }[] = [
  { value: 'cost', label: 'Custo' },
  { value: 'tokens', label: 'Tokens' },
  { value: 'turns', label: 'Turnos' },
  { value: 'duration', label: 'Tempo' }
]

const TOKEN_KINDS: readonly { value: UsageMetric; label: string }[] = [
  { value: 'tokens', label: 'Todos os tokens' },
  { value: 'input', label: 'Entrada' },
  { value: 'output', label: 'Saída' },
  { value: 'cache', label: 'Cache' },
  { value: 'reasoning', label: 'Raciocínio' }
]

/** Cost · Tokens · Turns · Time, and which tokens when it is tokens. */
export function MetricPicker({ metric, onChange }: { metric: UsageMetric; onChange: (metric: UsageMetric) => void }) {
  const group = isTokenMetric(metric) ? 'tokens' : metric as 'cost' | 'turns' | 'duration'
  return <>
    <SegmentedControl ariaLabel="Métrica" value={group} options={METRIC_GROUPS}
      onChange={(next) => onChange(next === 'tokens' && isTokenMetric(metric) ? metric : next)} />
    {isTokenMetric(metric) ? <Select size="sm" ariaLabel="Tipo de token" value={metric} options={TOKEN_KINDS} onValueChange={onChange} /> : null}
  </>
}
