import type { UsageFact, UsageTokens } from '../../../../shared/usage'
import { addDays, bucketKeyFor, dayInWindow, dayKey, dayRange, hourAndWeekday, weekdayOf, windowBuckets, type UsageWindow } from './time'

// Pure folds over usage facts: filters, totals, the chart's series and
// columns, breakdown tables, top chats, the hour x weekday grid and the
// activity calendar. No DOM, no clock: callers pass windows and zones.

export type UsageMetric = 'cost' | 'tokens' | 'input' | 'output' | 'cache' | 'reasoning' | 'turns' | 'duration'
export type UsageDimension = 'provider' | 'model' | 'profile' | 'project' | 'task' | 'source'
export type UsageFilters = Partial<Record<UsageDimension, readonly string[]>>

export const USAGE_DIMENSIONS: readonly UsageDimension[] = ['provider', 'model', 'profile', 'project', 'task', 'source']
export const TOKEN_METRICS: readonly UsageMetric[] = ['tokens', 'input', 'output', 'cache', 'reasoning']

export function isTokenMetric(metric: UsageMetric): boolean {
  return TOKEN_METRICS.includes(metric)
}

/** Every processed token: uncached input, cache reads, cache writes and output (reasoning is inside output). */
export function totalTokens(tokens: UsageTokens): number {
  return tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output
}

export function metricValue(fact: UsageFact, metric: UsageMetric): number {
  switch (metric) {
    case 'cost': return fact.costUsd ?? 0
    case 'tokens': return totalTokens(fact.tokens)
    case 'input': return fact.tokens.input
    case 'output': return fact.tokens.output
    case 'cache': return fact.tokens.cacheRead + fact.tokens.cacheWrite
    case 'reasoning': return fact.tokens.reasoning
    case 'turns': return 1
    case 'duration': return fact.durationMs ?? 0
  }
}

/* ---------------- Dimensions ---------------- */

export interface DimensionValue {
  readonly key: string
  readonly label: string
  /** Secondary line (a model's provider, a profile's provider). */
  readonly detail: string | null
}

const PROVIDERS: Readonly<Record<string, string>> = { claude: 'Claude', codex: 'Codex', traycer: 'Traycer', opencode: 'OpenCode' }
const providerName = (id: string): string => PROVIDERS[id] ?? (id ? id.charAt(0).toUpperCase() + id.slice(1) : 'Desconhecido')
const folded = (text: string): string => text.trim().toLocaleLowerCase('pt-BR')

/**
 * The group a fact belongs to under `dimension`. Accounts and tasks are keyed
 * by name, so the same account or task seen by Prism and by Traycer (whose
 * ids differ) is one row.
 */
export function dimensionValue(fact: UsageFact, dimension: UsageDimension): DimensionValue {
  switch (dimension) {
    case 'provider': return { key: fact.provider, label: providerName(fact.provider), detail: null }
    case 'model': {
      // By name, so aliases resolved to the same model are one group.
      const label = fact.modelLabel ?? (fact.model || 'Padrão')
      return { key: `${fact.provider}/${folded(label)}`, label, detail: providerName(fact.provider) }
    }
    case 'profile': return { key: `${fact.provider}/${folded(fact.profileName)}`, label: fact.profileName || 'Conta do terminal', detail: providerName(fact.provider) }
    case 'project': return fact.project ? { key: folded(fact.project), label: fact.project, detail: null } : { key: '', label: 'Sem projeto', detail: null }
    case 'task': return fact.taskTitle ? { key: folded(fact.taskTitle), label: fact.taskTitle, detail: null } : { key: '', label: 'Sem tarefa', detail: null }
    case 'source': return { key: fact.source, label: fact.source === 'traycer' ? 'Traycer' : 'Prism', detail: null }
  }
}

export function activeFilterCount(filters: UsageFilters): number {
  return USAGE_DIMENSIONS.reduce((n, d) => n + ((filters[d]?.length ?? 0) > 0 ? 1 : 0), 0)
}

/** Facts matching every non-empty dimension filter (keys from `dimensionValue`). */
export function applyFilters(facts: readonly UsageFact[], filters: UsageFilters): UsageFact[] {
  const active = USAGE_DIMENSIONS.filter((d) => (filters[d]?.length ?? 0) > 0).map((d) => [d, new Set(filters[d])] as const)
  if (!active.length) return [...facts]
  return facts.filter((f) => active.every(([d, keys]) => keys.has(dimensionValue(f, d).key)))
}

export interface FilterOption extends DimensionValue {
  readonly turns: number
}

/** The values a dimension takes across `facts`, busiest first. */
export function filterOptions(facts: readonly UsageFact[], dimension: UsageDimension): FilterOption[] {
  const byKey = new Map<string, { value: DimensionValue; turns: number }>()
  for (const f of facts) {
    const value = dimensionValue(f, dimension)
    const entry = byKey.get(value.key)
    if (entry) entry.turns++
    else byKey.set(value.key, { value, turns: 1 })
  }
  return [...byKey.values()]
    .sort((a, b) => b.turns - a.turns || a.value.label.localeCompare(b.value.label, 'pt-BR'))
    .map(({ value, turns }) => ({ ...value, turns }))
}

/* ---------------- Windows ---------------- */

export function factsInWindow(facts: readonly UsageFact[], window: UsageWindow, timeZone: string): UsageFact[] {
  return facts.filter((f) => dayInWindow(dayKey(f.occurredAt, timeZone), window))
}

export function earliestOccurrence(facts: readonly UsageFact[]): number | null {
  let earliest: number | null = null
  for (const f of facts) if (earliest === null || f.occurredAt < earliest) earliest = f.occurredAt
  return earliest
}

/* ---------------- Totals ---------------- */

export interface UsageTotals {
  readonly turns: number
  /** Turns that reported any token counter. */
  readonly measuredTurns: number
  readonly pricedTurns: number
  readonly unpricedTurns: number
  readonly errorTurns: number
  readonly interruptedTurns: number
  /** Turns whose tokens are only the last model call (Traycer's record). */
  readonly lastCallTurns: number
  readonly tokens: UsageTokens
  readonly totalTokens: number
  readonly costUsd: number
  readonly durationMs: number
  readonly timedTurns: number
  readonly activeDays: number
  readonly chats: number
  readonly prismTurns: number
  readonly traycerTurns: number
}

export function summarize(facts: readonly UsageFact[], timeZone: string): UsageTotals {
  let input = 0, cacheRead = 0, cacheWrite = 0, output = 0, reasoning = 0, cost = 0, duration = 0
  let measured = 0, priced = 0, errors = 0, interrupted = 0, lastCall = 0, timed = 0, prism = 0
  const days = new Set<string>(), chats = new Set<string>()
  for (const f of facts) {
    input += f.tokens.input; cacheRead += f.tokens.cacheRead; cacheWrite += f.tokens.cacheWrite
    output += f.tokens.output; reasoning += f.tokens.reasoning
    if (f.measured) measured++
    if (f.costUsd !== null) { priced++; cost += f.costUsd }
    if (f.durationMs !== null) { timed++; duration += f.durationMs }
    if (f.outcome === 'error') errors++
    else if (f.outcome === 'interrupted') interrupted++
    if (f.tokenBasis === 'last-call') lastCall++
    if (f.source === 'prism') prism++
    days.add(dayKey(f.occurredAt, timeZone))
    chats.add(chatKeyOf(f))
  }
  const tokens: UsageTokens = { input, cacheRead, cacheWrite, output, reasoning }
  return {
    turns: facts.length, measuredTurns: measured, pricedTurns: priced, unpricedTurns: facts.length - priced,
    errorTurns: errors, interruptedTurns: interrupted, lastCallTurns: lastCall,
    tokens, totalTokens: totalTokens(tokens), costUsd: cost, durationMs: duration, timedTurns: timed,
    activeDays: days.size, chats: chats.size, prismTurns: prism, traycerTurns: facts.length - prism
  }
}

export function totalsValue(totals: UsageTotals, metric: UsageMetric): number {
  switch (metric) {
    case 'cost': return totals.costUsd
    case 'tokens': return totals.totalTokens
    case 'input': return totals.tokens.input
    case 'output': return totals.tokens.output
    case 'cache': return totals.tokens.cacheRead + totals.tokens.cacheWrite
    case 'reasoning': return totals.tokens.reasoning
    case 'turns': return totals.turns
    case 'duration': return totals.durationMs
  }
}

/** Change from `previous` to `current` in percent; null when there is no base to compare with. */
export function percentChange(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) return null
  return ((current - previous) / previous) * 100
}

export interface StatTiles {
  readonly processed: { readonly total: number; readonly perActiveDay: number | null }
  readonly cached: { readonly cacheRead: number; readonly percentOfInput: number | null }
  readonly uncached: { readonly input: number; readonly cacheWrite: number }
  readonly output: { readonly output: number; readonly reasoning: number | null }
  readonly turns: { readonly turns: number; readonly errors: number; readonly interrupted: number; readonly chats: number }
  readonly duration: { readonly total: number; readonly perTurn: number | null }
}

/** The stat tiles; a null secondary figure means "not reported", never zero. */
export function buildStatTiles(totals: UsageTotals): StatTiles {
  const observedInput = totals.tokens.input + totals.tokens.cacheRead
  return {
    processed: { total: totals.totalTokens, perActiveDay: totals.activeDays > 0 ? totals.totalTokens / totals.activeDays : null },
    cached: { cacheRead: totals.tokens.cacheRead, percentOfInput: observedInput > 0 ? (totals.tokens.cacheRead / observedInput) * 100 : null },
    uncached: { input: totals.tokens.input, cacheWrite: totals.tokens.cacheWrite },
    output: { output: totals.tokens.output, reasoning: totals.tokens.reasoning > 0 ? totals.tokens.reasoning : null },
    turns: { turns: totals.turns, errors: totals.errorTurns, interrupted: totals.interruptedTurns, chats: totals.chats },
    duration: { total: totals.durationMs, perTurn: totals.timedTurns > 0 ? totals.durationMs / totals.timedTurns : null }
  }
}

/* ---------------- Series scale ---------------- */

export const OTHER_SERIES_KEY = '__usage_other__'
/** Categorical slots in usage.css (`--usg-series-1..N`). */
export const SERIES_SLOT_COUNT = 10

export interface SeriesScale {
  /** Series keys in stacking order, "Other" last when the tail was folded. */
  readonly order: readonly string[]
  readonly labelFor: (key: string) => string
  readonly detailFor: (key: string) => string | null
  /** CSS custom property holding the series color (`--usg-series-3`). */
  readonly tokenFor: (key: string) => string
}

/** Brand anchors for known identities, and the generic slot each one shadows. */
const BRAND_TOKENS: Readonly<Partial<Record<UsageDimension, Readonly<Record<string, { token: string; shadows: number }>>>>> = {
  provider: { claude: { token: '--usg-brand-claude', shadows: 2 }, codex: { token: '--usg-brand-codex', shadows: 1 } },
  source: { prism: { token: '--usg-brand-prism', shadows: 7 }, traycer: { token: '--usg-brand-traycer', shadows: 3 } }
}

/**
 * Which keys get a color, and which color. Selection is by the metric's total
 * (so "Outros" is always the long tail); among the selected keys the order is
 * alphabetical, so a key keeps its color when a refetch only reorders
 * magnitudes ("color follows the entity, never its rank").
 */
export function buildSeriesScale(facts: readonly UsageFact[], dimension: UsageDimension, metric: UsageMetric, maxSeries = 8): SeriesScale {
  const stats = new Map<string, { value: DimensionValue; total: number; turns: number }>()
  for (const f of facts) {
    const value = dimensionValue(f, dimension)
    const entry = stats.get(value.key)
    if (entry) { entry.total += metricValue(f, metric); entry.turns++ }
    else stats.set(value.key, { value, total: metricValue(f, metric), turns: 1 })
  }
  const ranked = [...stats.entries()].sort(([ka, a], [kb, b]) => b.total - a.total || b.turns - a.turns || ka.localeCompare(kb))
  const limit = Math.max(1, Math.min(maxSeries, SERIES_SLOT_COUNT))
  const folds = ranked.length > limit
  const selected = ranked.slice(0, folds ? limit - 1 : limit).map(([key]) => key)
    .sort((a, b) => (stats.get(a)!.value.label).localeCompare(stats.get(b)!.value.label, 'pt-BR') || a.localeCompare(b))
  const tokens = new Map<string, string>()
  const brands = BRAND_TOKENS[dimension] ?? {}
  const reserved = new Set<number>()
  for (const key of selected) {
    const brand = brands[key]
    if (brand) { tokens.set(key, brand.token); reserved.add(brand.shadows) }
  }
  let slot = 1
  for (const key of selected) {
    if (tokens.has(key)) continue
    while (reserved.has(slot) && slot <= SERIES_SLOT_COUNT) slot++
    tokens.set(key, `--usg-series-${Math.min(slot, SERIES_SLOT_COUNT)}`)
    slot++
  }
  const order = folds ? [...selected, OTHER_SERIES_KEY] : selected
  return {
    order,
    labelFor: (key) => key === OTHER_SERIES_KEY ? 'Outros' : stats.get(key)?.value.label ?? key,
    detailFor: (key) => key === OTHER_SERIES_KEY ? null : stats.get(key)?.value.detail ?? null,
    tokenFor: (key) => tokens.get(key) ?? '--usg-series-other'
  }
}

/** The scale key a fact stacks under (its own, or "Outros"). */
export function seriesKeyOf(fact: UsageFact, dimension: UsageDimension, scale: SeriesScale): string {
  const key = dimensionValue(fact, dimension).key
  return scale.order.includes(key) ? key : OTHER_SERIES_KEY
}

/* ---------------- Chart columns ---------------- */

export interface ChartColumn {
  readonly key: string
  /** First and last day the column covers. */
  readonly from: string
  readonly to: string
  /** One value per `scale.order` entry. */
  readonly segments: readonly number[]
  readonly total: number
  /** The same position in the previous window, when comparing. */
  readonly previous: number | null
}

export function buildChartColumns(input: {
  readonly facts: readonly UsageFact[]
  readonly window: UsageWindow
  readonly timeZone: string
  readonly scale: SeriesScale
  readonly dimension: UsageDimension
  readonly metric: UsageMetric
  /** Facts of `previousWindow`, aligned to the columns by position. */
  readonly previousFacts?: readonly UsageFact[] | null
  readonly previousWindow?: UsageWindow | null
}): ChartColumn[] {
  const { facts, window, timeZone, scale, dimension, metric } = input
  const buckets = windowBuckets(window)
  const index = new Map(buckets.map((b, i) => [b.key, i]))
  const slot = new Map(scale.order.map((key, i) => [key, i]))
  const values = buckets.map(() => new Array<number>(scale.order.length).fill(0))
  for (const f of facts) {
    const day = dayKey(f.occurredAt, timeZone)
    if (!dayInWindow(day, window)) continue
    const at = index.get(bucketKeyFor(f.occurredAt, window, timeZone))
    const series = slot.get(seriesKeyOf(f, dimension, scale))
    if (at === undefined || series === undefined) continue
    values[at][series] += metricValue(f, metric)
  }
  let previous: (number | null)[] = buckets.map(() => null)
  if (input.previousFacts && input.previousWindow) {
    const prior = input.previousWindow
    const priorBuckets = windowBuckets(prior)
    const priorIndex = new Map(priorBuckets.map((b, i) => [b.key, i]))
    const totals = priorBuckets.map(() => 0)
    for (const f of input.previousFacts) {
      if (!dayInWindow(dayKey(f.occurredAt, timeZone), prior)) continue
      const at = priorIndex.get(bucketKeyFor(f.occurredAt, prior, timeZone))
      if (at !== undefined) totals[at] += metricValue(f, metric)
    }
    // Weeks can differ by one column between two equal-length windows; align from the end.
    const offset = totals.length - buckets.length
    previous = buckets.map((_, i) => totals[i + offset] ?? null)
  }
  return buckets.map((b, i) => ({
    key: b.key, from: b.from, to: b.to, segments: values[i],
    total: values[i].reduce((sum, v) => sum + v, 0), previous: previous[i]
  }))
}

/** Hidden series keep their slot (and color) but contribute zero. */
export function hideSeries(columns: readonly ChartColumn[], scale: SeriesScale, hidden: ReadonlySet<string>): ChartColumn[] {
  if (!hidden.size) return [...columns]
  const mask = scale.order.map((key) => hidden.has(key))
  return columns.map((c) => {
    const segments = c.segments.map((v, i) => mask[i] ? 0 : v)
    return { ...c, segments, total: segments.reduce((sum, v) => sum + v, 0) }
  })
}

/* ---------------- Breakdown ---------------- */

export type BreakdownGroup = UsageDimension | 'day'

export interface BreakdownRow {
  readonly key: string
  readonly label: string
  readonly detail: string | null
  readonly turns: number
  readonly tokens: UsageTokens
  readonly totalTokens: number
  readonly costUsd: number
  readonly pricedTurns: number
  readonly durationMs: number
  /** The selected metric's total for the row. */
  readonly value: number
  /** Share of the metric across all rows, 0..1 (0 when the total is 0). */
  readonly share: number
  readonly lastAt: number
}

/** One row per group, by the metric descending (days: newest first). */
export function buildBreakdown(facts: readonly UsageFact[], group: BreakdownGroup, metric: UsageMetric, timeZone: string): BreakdownRow[] {
  const rows = new Map<string, { key: string; label: string; detail: string | null; turns: number; input: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number; cost: number; priced: number; duration: number; value: number; lastAt: number }>()
  for (const f of facts) {
    const dim: DimensionValue = group === 'day' ? { key: dayKey(f.occurredAt, timeZone), label: '', detail: null } : dimensionValue(f, group)
    let row = rows.get(dim.key)
    if (!row) {
      row = { key: dim.key, label: dim.label, detail: dim.detail, turns: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, cost: 0, priced: 0, duration: 0, value: 0, lastAt: 0 }
      rows.set(dim.key, row)
    }
    row.turns++
    row.input += f.tokens.input; row.cacheRead += f.tokens.cacheRead; row.cacheWrite += f.tokens.cacheWrite
    row.output += f.tokens.output; row.reasoning += f.tokens.reasoning
    if (f.costUsd !== null) { row.cost += f.costUsd; row.priced++ }
    row.duration += f.durationMs ?? 0
    row.value += metricValue(f, metric)
    if (f.occurredAt > row.lastAt) row.lastAt = f.occurredAt
  }
  const total = [...rows.values()].reduce((sum, r) => sum + r.value, 0)
  const list = [...rows.values()].map((r): BreakdownRow => {
    const tokens: UsageTokens = { input: r.input, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite, output: r.output, reasoning: r.reasoning }
    return { key: r.key, label: r.label, detail: r.detail, turns: r.turns, tokens, totalTokens: totalTokens(tokens), costUsd: r.cost,
      pricedTurns: r.priced, durationMs: r.duration, value: r.value, share: total > 0 ? r.value / total : 0, lastAt: r.lastAt }
  })
  return group === 'day'
    ? list.sort((a, b) => b.key.localeCompare(a.key))
    : list.sort((a, b) => b.value - a.value || b.turns - a.turns || a.label.localeCompare(b.label, 'pt-BR'))
}

export type BreakdownSortKey = 'label' | 'turns' | 'tokens' | 'cost' | 'duration' | 'value'
export function sortBreakdown(rows: readonly BreakdownRow[], key: BreakdownSortKey, direction: 'asc' | 'desc'): BreakdownRow[] {
  const sign = direction === 'asc' ? 1 : -1
  const pick = (r: BreakdownRow): number | string => key === 'label' ? r.label || r.key : key === 'turns' ? r.turns : key === 'tokens' ? r.totalTokens
    : key === 'cost' ? r.costUsd : key === 'duration' ? r.durationMs : r.value
  return [...rows].sort((a, b) => {
    const x = pick(a), y = pick(b)
    const order = typeof x === 'string' && typeof y === 'string' ? x.localeCompare(y, 'pt-BR') : (x as number) - (y as number)
    return sign * order || a.key.localeCompare(b.key)
  })
}

/* ---------------- Chats ---------------- */

/**
 * The conversation a fact belongs to. A Traycer chat imported into Prism and
 * continued there is one conversation: the Traycer turns name the Prism copy
 * (`prismChatId`), so both sides share its key.
 */
export function chatKeyOf(fact: UsageFact): string {
  return fact.prismChatId ? `prism:${fact.prismChatId}` : `${fact.source}:${fact.chatId}`
}

export interface ChatUsageRow {
  /** `chatKeyOf` of its turns. */
  readonly key: string
  /** The newest turn's origin. */
  readonly source: UsageFact['source']
  /** Every origin of its turns (both, for a Traycer chat continued in Prism). */
  readonly sources: readonly UsageFact['source'][]
  readonly chatId: string
  readonly title: string
  readonly taskTitle: string | null
  readonly project: string | null
  readonly providers: readonly string[]
  readonly profileName: string
  readonly prismChatId: string | null
  readonly turns: number
  readonly tokens: UsageTokens
  readonly totalTokens: number
  readonly costUsd: number
  readonly unpricedTurns: number
  readonly durationMs: number
  readonly value: number
  readonly lastAt: number
  /** The chat's turns in the window, newest first. */
  readonly facts: readonly UsageFact[]
}

/** Chats ranked by the metric (ties: most recent first). */
export function buildChatRows(facts: readonly UsageFact[], metric: UsageMetric): ChatUsageRow[] {
  const byChat = new Map<string, UsageFact[]>()
  for (const f of facts) {
    const key = chatKeyOf(f)
    const list = byChat.get(key)
    if (list) list.push(f)
    else byChat.set(key, [f])
  }
  const rows: ChatUsageRow[] = []
  for (const [key, list] of byChat) {
    list.sort((a, b) => b.occurredAt - a.occurredAt)
    const latest = list[0]
    let input = 0, cacheRead = 0, cacheWrite = 0, output = 0, reasoning = 0, cost = 0, unpriced = 0, duration = 0, value = 0
    const providers = new Set<string>(), sources = new Set<UsageFact['source']>()
    for (const f of list) {
      sources.add(f.source)
      input += f.tokens.input; cacheRead += f.tokens.cacheRead; cacheWrite += f.tokens.cacheWrite; output += f.tokens.output; reasoning += f.tokens.reasoning
      if (f.costUsd === null) unpriced++
      else cost += f.costUsd
      duration += f.durationMs ?? 0
      value += metricValue(f, metric)
      providers.add(f.provider)
    }
    const tokens: UsageTokens = { input, cacheRead, cacheWrite, output, reasoning }
    // The Prism side names the merged conversation (it is the one that opens).
    const named = list.find((f) => f.source === 'prism') ?? latest
    rows.push({ key, source: latest.source, sources: [...sources].sort(), chatId: named.chatId, title: named.chatTitle || 'Chat sem título', taskTitle: named.taskTitle, project: named.project,
      providers: [...providers], profileName: latest.profileName, prismChatId: named.prismChatId, turns: list.length, tokens, totalTokens: totalTokens(tokens),
      costUsd: cost, unpricedTurns: unpriced, durationMs: duration, value, lastAt: latest.occurredAt, facts: list })
  }
  return rows.sort((a, b) => b.value - a.value || b.lastAt - a.lastAt)
}

/* ---------------- Intensity levels ---------------- */

export type HeatLevel = 0 | 1 | 2 | 3 | 4

/** Quartiles over the NONZERO values, so one huge day can't wash every other one out. */
export function quartileThresholds(values: readonly number[]): readonly [number, number, number] | null {
  const sorted = values.filter((v) => v > 0).sort((a, b) => a - b)
  if (!sorted.length) return null
  const at = (fraction: number): number => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? 0
  return [at(0.25), at(0.5), at(0.75)]
}

/** Level 0 only for no activity; activity with no measurable value still shows the faintest step. */
export function heatLevel(value: number, activity: number, thresholds: readonly [number, number, number] | null): HeatLevel {
  if (value <= 0) return activity > 0 ? 1 : 0
  if (thresholds === null) return 0
  const [q1, q2, q3] = thresholds
  if (value >= q3) return 4
  if (value >= q2) return 3
  if (value >= q1) return 2
  return 1
}

/* ---------------- Hour x weekday ---------------- */

export interface HourGrid {
  /** `values[weekday][hour]`, Sunday-first. */
  readonly values: readonly (readonly number[])[]
  readonly turns: readonly (readonly number[])[]
  readonly levels: readonly (readonly HeatLevel[])[]
  readonly peak: { readonly weekday: number; readonly hour: number; readonly value: number } | null
  /** Totals per hour of day and per weekday. */
  readonly byHour: readonly number[]
  readonly byWeekday: readonly number[]
}

export function buildHourGrid(facts: readonly UsageFact[], metric: UsageMetric, timeZone: string): HourGrid {
  const values = Array.from({ length: 7 }, () => new Array<number>(24).fill(0))
  const turns = Array.from({ length: 7 }, () => new Array<number>(24).fill(0))
  for (const f of facts) {
    const { hour, weekday } = hourAndWeekday(f.occurredAt, timeZone)
    values[weekday][hour] += metricValue(f, metric)
    turns[weekday][hour]++
  }
  const thresholds = quartileThresholds(values.flat())
  const levels = values.map((row, w) => row.map((v, h) => heatLevel(v, turns[w][h], thresholds)))
  let peak: HourGrid['peak'] = null
  for (let w = 0; w < 7; w++) for (let h = 0; h < 24; h++) {
    if (values[w][h] > 0 && (peak === null || values[w][h] > peak.value)) peak = { weekday: w, hour: h, value: values[w][h] }
  }
  const byHour = Array.from({ length: 24 }, (_, h) => values.reduce((sum, row) => sum + row[h], 0))
  const byWeekday = values.map((row) => row.reduce((sum, v) => sum + v, 0))
  return { values, turns, levels, peak, byHour, byWeekday }
}

/* ---------------- Activity calendar ---------------- */

export interface ActivityCell {
  readonly day: string
  readonly value: number
  readonly costUsd: number
  readonly tokens: number
  readonly turns: number
  readonly level: HeatLevel
}

export interface ActivityWeek {
  readonly firstDay: string
  /** Always 7 slots, Sunday-first; null pads partial weeks. */
  readonly cells: readonly (ActivityCell | null)[]
}

export interface ActivityStats {
  /** `YYYY-MM` */
  readonly mostActiveMonth: string | null
  readonly mostActiveDay: string | null
  readonly longestStreakDays: number
  readonly currentStreakDays: number
  readonly activeDays: number
}

export interface ActivityCalendar {
  readonly weeks: readonly ActivityWeek[]
  /** Week columns where a month begins (the window's first month gets none). */
  readonly monthLabels: readonly { readonly weekIndex: number; readonly month: number }[]
  readonly stats: ActivityStats
}

/** A GitHub-style calendar of the `days` days ending on `endDay`. */
export function buildActivityCalendar(facts: readonly UsageFact[], endDay: string, metric: UsageMetric, timeZone: string, days = 365): ActivityCalendar {
  const window = dayRange(addDays(endDay, -(days - 1)), endDay)
  const first = window[0]
  const byDay = new Map<string, { value: number; cost: number; tokens: number; turns: number }>()
  for (const f of facts) {
    const day = dayKey(f.occurredAt, timeZone)
    if (day < first || day > endDay) continue
    const entry = byDay.get(day) ?? { value: 0, cost: 0, tokens: 0, turns: 0 }
    entry.value += metricValue(f, metric); entry.cost += f.costUsd ?? 0; entry.tokens += totalTokens(f.tokens); entry.turns++
    byDay.set(day, entry)
  }
  const thresholds = quartileThresholds([...byDay.values()].map((e) => e.value))
  const cells: ActivityCell[] = window.map((day) => {
    const e = byDay.get(day)
    return { day, value: e?.value ?? 0, costUsd: e?.cost ?? 0, tokens: e?.tokens ?? 0, turns: e?.turns ?? 0, level: heatLevel(e?.value ?? 0, e?.turns ?? 0, thresholds) }
  })
  const weeks: { firstDay: string; cells: (ActivityCell | null)[] }[] = []
  const monthLabels: { weekIndex: number; month: number }[] = []
  let current: (ActivityCell | null)[] | null = null
  let lastMonth: string | null = null
  for (const cell of cells) {
    const weekday = weekdayOf(cell.day)
    if (current === null || weekday === 0) {
      current = new Array<ActivityCell | null>(7).fill(null)
      weeks.push({ firstDay: cell.day, cells: current })
    }
    current[weekday] = cell
    const month = cell.day.slice(0, 7)
    if (lastMonth !== null && month !== lastMonth) monthLabels.push({ weekIndex: weeks.length - 1, month: Number(month.slice(5, 7)) })
    lastMonth = month
  }
  return { weeks, monthLabels, stats: activityStats(cells) }
}

function activityStats(cells: readonly ActivityCell[]): ActivityStats {
  const months = new Map<string, { value: number; turns: number }>()
  let best: ActivityCell | null = null, longest = 0, run = 0, active = 0
  for (const cell of cells) {
    if (cell.turns > 0) {
      active++
      const month = cell.day.slice(0, 7)
      const prior = months.get(month) ?? { value: 0, turns: 0 }
      months.set(month, { value: prior.value + cell.value, turns: prior.turns + cell.turns })
      if (best === null || cell.value > best.value || (best.value === 0 && cell.value === 0 && cell.turns > best.turns)) best = cell
      run++
      if (run > longest) longest = run
    } else run = 0
  }
  // Today not being over yet doesn't break the current streak.
  let currentStreak = 0
  for (let i = cells.length - 1; i >= 0; i--) {
    if (cells[i].turns > 0) currentStreak++
    else if (i === cells.length - 1) continue
    else break
  }
  let mostActiveMonth: string | null = null, bestMonth = { value: 0, turns: 0 }
  for (const [month, totals] of months) {
    const wins = totals.value > bestMonth.value || (bestMonth.value === 0 && totals.value === 0 && totals.turns > bestMonth.turns)
    if (wins) { bestMonth = totals; mostActiveMonth = month }
  }
  return { mostActiveMonth, mostActiveDay: best?.day ?? null, longestStreakDays: longest, currentStreakDays: currentStreak, activeDays: active }
}
