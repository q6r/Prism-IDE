// Calendar math for usage windows. A day is a `YYYY-MM-DD` key in the
// viewer's IANA zone, resolved ONCE through Intl (DST included); everything
// after that is pure date arithmetic through Date.UTC, so a 23h or 25h local
// day never drops or doubles a column.

const FALLBACK_TIME_ZONE = 'UTC'
const DAY_MS = 86_400_000

const dayFormatters = new Map<string, Intl.DateTimeFormat>()
const partFormatters = new Map<string, Intl.DateTimeFormat>()

/** The viewer's zone, or UTC when the runtime cannot name one. */
export function viewerTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || FALLBACK_TIME_ZONE } catch { return FALLBACK_TIME_ZONE }
}

function cached(map: Map<string, Intl.DateTimeFormat>, timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const hit = map.get(timeZone)
  if (hit) return hit
  let formatter: Intl.DateTimeFormat
  // An unknown zone name throws RangeError; degrade to UTC rather than fail.
  try { formatter = new Intl.DateTimeFormat('en-CA', { ...options, timeZone }) } catch { formatter = new Intl.DateTimeFormat('en-CA', { ...options, timeZone: FALLBACK_TIME_ZONE }) }
  map.set(timeZone, formatter)
  return formatter
}

/** `YYYY-MM-DD` of `ms` in `timeZone`. */
export function dayKey(ms: number, timeZone: string): string {
  return cached(dayFormatters, timeZone, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms))
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

/** Local hour (0-23) and Sunday-first weekday (0-6) of `ms` in `timeZone`. */
export function hourAndWeekday(ms: number, timeZone: string): { hour: number; weekday: number } {
  const parts = cached(partFormatters, timeZone, { weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(ms))
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24
  const weekday = WEEKDAY_INDEX[parts.find((p) => p.type === 'weekday')?.value ?? 'Sun'] ?? 0
  return { hour, weekday }
}

function parseDay(day: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!match) return null
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) }
}

const pad = (value: number, width: number): string => String(value).padStart(width, '0')
function fromUtc(ms: number): string {
  const date = new Date(ms)
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}`
}
function utcOf(day: string): number {
  const p = parseDay(day)
  return p ? Date.UTC(p.y, p.m - 1, p.d) : Number.NaN
}

export function isDayKey(value: unknown): value is string {
  return typeof value === 'string' && parseDay(value) !== null && fromUtc(utcOf(value)) === value
}

/** `day` moved by `amount` calendar days (negative goes back). */
export function addDays(day: string, amount: number): string {
  const base = utcOf(day)
  return Number.isNaN(base) ? day : fromUtc(base + amount * DAY_MS)
}

/** Calendar days from `from` to `to`, both included (0 when `to` is before `from`). */
export function daysInclusive(from: string, to: string): number {
  const a = utcOf(from), b = utcOf(to)
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return 0
  return Math.round((b - a) / DAY_MS) + 1
}

/** Every day key from `from` to `to`, inclusive, oldest first. */
export function dayRange(from: string, to: string): string[] {
  const count = daysInclusive(from, to)
  const days: string[] = []
  for (let i = 0; i < count; i++) days.push(addDays(from, i))
  return days
}

/** Sunday-first weekday of a day key, without any zone re-interpretation. */
export function weekdayOf(day: string): number {
  const base = utcOf(day)
  return Number.isNaN(base) ? 0 : new Date(base).getUTCDay()
}

/** The Sunday that starts `day`'s week. */
export function weekStart(day: string): string {
  return addDays(day, -weekdayOf(day))
}

/* ---------------- Periods ---------------- */

export type UsagePeriod =
  | { readonly kind: 'today' }
  | { readonly kind: 'last'; readonly days: 7 | 30 | 90 }
  | { readonly kind: 'year' }
  | { readonly kind: 'all' }
  | { readonly kind: 'custom'; readonly from: string; readonly to: string }

export type UsageGranularity = 'hour' | 'day' | 'week'

export interface UsageWindow {
  /** First day included. */
  readonly from: string
  /** Last day included. */
  readonly to: string
  readonly days: number
  readonly granularity: UsageGranularity
}

/** Days per window above which the chart folds days into weeks. */
export const WEEKLY_CHART_AFTER_DAYS = 120
/** The year window and the activity calendar's span. */
export const YEAR_DAYS = 365

export function granularityFor(days: number): UsageGranularity {
  if (days <= 1) return 'hour'
  return days <= WEEKLY_CHART_AFTER_DAYS ? 'day' : 'week'
}

function windowOf(from: string, to: string): UsageWindow {
  const days = Math.max(1, daysInclusive(from, to))
  return { from, to, days, granularity: granularityFor(days) }
}

/**
 * The concrete days a period covers, ending today in `timeZone`. "Tudo"
 * starts at the earliest recorded turn; a custom range is ordered and never
 * reaches past today.
 */
export function resolvePeriod(period: UsagePeriod, nowMs: number, timeZone: string, earliestMs: number | null): UsageWindow {
  const today = dayKey(nowMs, timeZone)
  switch (period.kind) {
    case 'today': return windowOf(today, today)
    case 'last': return windowOf(addDays(today, -(period.days - 1)), today)
    case 'year': return windowOf(addDays(today, -(YEAR_DAYS - 1)), today)
    case 'all': {
      const first = earliestMs === null ? today : dayKey(earliestMs, timeZone)
      return windowOf(first < today ? first : today, today)
    }
    case 'custom': {
      let from = isDayKey(period.from) ? period.from : today
      let to = isDayKey(period.to) ? period.to : today
      if (to < from) [from, to] = [to, from]
      if (to > today) to = today
      if (from > to) from = to
      return windowOf(from, to)
    }
  }
}

/** The window of the same length that ends the day before `window` starts. */
export function previousWindow(window: UsageWindow): UsageWindow {
  const to = addDays(window.from, -1)
  return windowOf(addDays(to, -(window.days - 1)), to)
}

export function dayInWindow(day: string, window: UsageWindow): boolean {
  return day >= window.from && day <= window.to
}

export interface UsageBucket {
  /** `HH` for hours, a day key for days, the week's Sunday for weeks. */
  readonly key: string
  /** For weeks: the first and last in-window day. */
  readonly from: string
  readonly to: string
}

/** The chart's x-axis for a window: every hour, day or week, empty ones included. */
export function windowBuckets(window: UsageWindow): UsageBucket[] {
  if (window.granularity === 'hour') {
    return Array.from({ length: 24 }, (_, hour) => ({ key: pad(hour, 2), from: window.from, to: window.to }))
  }
  if (window.granularity === 'day') return dayRange(window.from, window.to).map((day) => ({ key: day, from: day, to: day }))
  const buckets: UsageBucket[] = []
  for (let start = weekStart(window.from); start <= window.to; start = addDays(start, 7)) {
    const end = addDays(start, 6)
    buckets.push({ key: start, from: start < window.from ? window.from : start, to: end > window.to ? window.to : end })
  }
  return buckets
}

/** Which bucket of `window` an instant falls in (only meaningful for instants inside it). */
export function bucketKeyFor(ms: number, window: UsageWindow, timeZone: string): string {
  if (window.granularity === 'hour') return pad(hourAndWeekday(ms, timeZone).hour, 2)
  const day = dayKey(ms, timeZone)
  return window.granularity === 'day' ? day : weekStart(day)
}
