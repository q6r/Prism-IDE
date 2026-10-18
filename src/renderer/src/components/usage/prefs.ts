import { useCallback, useMemo, useState } from 'react'
import type { BreakdownGroup, UsageDimension, UsageMetric } from '../../lib/usageAnalytics/aggregate'
import { isDayKey, type UsagePeriod } from '../../lib/usageAnalytics/time'
import type { UsageFact } from '../../../../shared/usage'

// The page's view choices, remembered per viewer. Filters are deliberately
// not remembered: returning to a silently filtered page misleads.

export type PeriodKey = 'today' | '7' | '30' | '90' | 'year' | 'all' | 'custom'
export type ChartKind = 'area' | 'bar'

export interface UsagePrefs {
  readonly period: PeriodKey
  readonly custom: { readonly from: string; readonly to: string } | null
  readonly metric: UsageMetric
  readonly chartGroup: UsageDimension
  readonly chartKind: ChartKind
  readonly breakdown: BreakdownGroup
  readonly compare: boolean
}

const KEY = 'prism.usage.prefs.v1'
const DEFAULTS: UsagePrefs = { period: '30', custom: null, metric: 'cost', chartGroup: 'provider', chartKind: 'area', breakdown: 'model', compare: true }
const PERIODS: readonly PeriodKey[] = ['today', '7', '30', '90', 'year', 'all', 'custom']
const METRICS: readonly UsageMetric[] = ['cost', 'tokens', 'input', 'output', 'cache', 'reasoning', 'turns', 'duration']
const DIMENSIONS: readonly UsageDimension[] = ['provider', 'model', 'profile', 'project', 'task', 'source']

interface StoredPrefs { readonly prefs: UsagePrefs; readonly metricChosen: boolean }

/** Without a saved choice, start with the measure the provider actually reports. */
export function initialUsageMetric(facts: readonly Pick<UsageFact, 'costUsd' | 'measured'>[]): UsageMetric {
  if (facts.some(f => typeof f.costUsd === 'number' && Number.isFinite(f.costUsd) && f.costUsd >= 0)) return 'cost'
  return facts.some(f => f.measured) ? 'tokens' : 'cost'
}

export function parseUsagePrefs(value: unknown): StoredPrefs {
  const raw = value && typeof value === 'object' ? value as Partial<UsagePrefs> : {}
  const custom = raw.custom && isDayKey(raw.custom.from) && isDayKey(raw.custom.to) ? { from: raw.custom.from, to: raw.custom.to } : null
  const metricChosen = METRICS.includes(raw.metric as UsageMetric)
  return {
    metricChosen,
    prefs: {
      period: PERIODS.includes(raw.period as PeriodKey) && (raw.period !== 'custom' || custom) ? raw.period as PeriodKey : DEFAULTS.period,
      custom,
      metric: metricChosen ? raw.metric as UsageMetric : DEFAULTS.metric,
      chartGroup: DIMENSIONS.includes(raw.chartGroup as UsageDimension) ? raw.chartGroup as UsageDimension : DEFAULTS.chartGroup,
      chartKind: raw.chartKind === 'bar' ? 'bar' : 'area',
      breakdown: raw.breakdown === 'day' || DIMENSIONS.includes(raw.breakdown as UsageDimension) ? raw.breakdown as BreakdownGroup : DEFAULTS.breakdown,
      compare: typeof raw.compare === 'boolean' ? raw.compare : DEFAULTS.compare
    }
  }
}

function read(): StoredPrefs {
  try { return parseUsagePrefs(JSON.parse(localStorage.getItem(KEY) || '{}')) }
  catch { return parseUsagePrefs(null) }
}

export function useUsagePrefs(initialMetric: UsageMetric = DEFAULTS.metric): [UsagePrefs, (patch: Partial<UsagePrefs>) => void] {
  const [stored, setStored] = useState(read)
  const prefs = useMemo(() => stored.metricChosen ? stored.prefs : { ...stored.prefs, metric: initialMetric }, [stored, initialMetric])
  const update = useCallback((patch: Partial<UsagePrefs>) => setStored((current) => {
    const next = { ...current.prefs, ...patch }
    const metricChosen = current.metricChosen || patch.metric !== undefined
    // Changing a period or chart layout does not turn the automatic measure
    // into a saved choice. Existing saved metrics, including cost, stay explicit.
    const { metric, ...rest } = next
    try { localStorage.setItem(KEY, JSON.stringify(metricChosen ? { ...rest, metric } : rest)) } catch { /* Private storage: the choice lasts for this visit. */ }
    return { prefs: next, metricChosen }
  }), [])
  return [prefs, update]
}

export function periodOf(prefs: UsagePrefs): UsagePeriod {
  switch (prefs.period) {
    case 'today': return { kind: 'today' }
    case '7': return { kind: 'last', days: 7 }
    case '30': return { kind: 'last', days: 30 }
    case '90': return { kind: 'last', days: 90 }
    case 'year': return { kind: 'year' }
    case 'all': return { kind: 'all' }
    case 'custom': return prefs.custom ? { kind: 'custom', from: prefs.custom.from, to: prefs.custom.to } : { kind: 'last', days: 30 }
  }
}
