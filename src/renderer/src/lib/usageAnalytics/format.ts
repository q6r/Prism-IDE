import type { UsageDimension, UsageMetric } from './aggregate'

// pt-BR formatting for every usage surface. Day keys are split as strings,
// never parsed through Date, so a label can't drift a day across zones.

const USD = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'USD' })
const COMPACT = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 })
const INTEGER = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 })
const DECIMAL = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 })

const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']
const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb']

/**
 * "US$ 1,23". A real but sub-half-cent amount reads "<US$ 0,01" instead of
 * rounding to "US$ 0,00", which reads as free; 0 itself is a measured zero.
 */
export function formatUsd(amount: number): string {
  if (amount > 0 && amount < 0.005) return `<${USD.format(0.01)}`
  return USD.format(amount)
}

/** "1,2 mi", "12 mil", "850". */
export function formatTokens(value: number): string {
  return COMPACT.format(value)
}

/** "1.234.567". */
export function formatInteger(value: number): string {
  return INTEGER.format(value)
}

/** "<1s", "45s", "12min", "2h 13min", "3d 4h"; null reads "—". */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—'
  if (ms < 1000) return ms > 0 ? '<1s' : '0s'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}min`
  const hours = Math.floor(minutes / 60), restMinutes = minutes % 60
  if (hours < 24) return restMinutes ? `${hours}h ${restMinutes}min` : `${hours}h`
  const days = Math.floor(hours / 24), restHours = hours % 24
  return restHours ? `${days}d ${restHours}h` : `${days}d`
}

export function formatMetricValue(value: number, metric: UsageMetric): string {
  switch (metric) {
    case 'cost': return formatUsd(value)
    case 'turns': return formatInteger(value)
    case 'duration': return formatDuration(value)
    default: return formatTokens(value)
  }
}

/** "+12%", "−8,5%", "0%" (a real minus sign). */
export function formatPercentChange(percent: number): string {
  const rounded = Math.abs(percent) < 10 ? Math.round(percent * 10) / 10 : Math.round(percent)
  if (rounded === 0) return '0%'
  return `${rounded > 0 ? '+' : '−'}${DECIMAL.format(Math.abs(rounded))}%`
}

/** "42%" or "42,5%" for a 0..100 share. */
export function formatPercent(percent: number): string {
  return `${DECIMAL.format(percent)}%`
}

function dayParts(day: string): { y: string; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  return match ? { y: match[1], m: Number(match[2]), d: Number(match[3]) } : null
}

/** "9 out". */
export function formatDayShort(day: string): string {
  const p = dayParts(day)
  return p ? `${p.d} ${MONTHS[p.m - 1] ?? p.m}` : day
}

/** "9 out 2026". */
export function formatDayLong(day: string): string {
  const p = dayParts(day)
  return p ? `${p.d} ${MONTHS[p.m - 1] ?? p.m} ${p.y}` : day
}

/** "10 set – 9 out 2026", "30 dez 2025 – 9 jan 2026", or one day alone. */
export function formatDayRange(from: string, to: string): string {
  if (from === to) return formatDayLong(from)
  const a = dayParts(from), b = dayParts(to)
  if (!a || !b) return `${from} – ${to}`
  return a.y === b.y ? `${formatDayShort(from)} – ${formatDayLong(to)}` : `${formatDayLong(from)} – ${formatDayLong(to)}`
}

/** "mar 2026" from "2026-03". */
export function formatMonth(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month)
  return match ? `${MONTHS[Number(match[2]) - 1] ?? match[2]} ${match[1]}` : month
}

export function monthAbbr(month: number): string {
  return MONTHS[month - 1] ?? String(month)
}

/** "seg" for Sunday-first index 1. */
export function formatWeekday(weekday: number): string {
  return WEEKDAYS[weekday] ?? String(weekday)
}

/** "14h" for an hour bucket key or number. */
export function formatHour(hour: number | string): string {
  return `${Number(hour)}h`
}

const DATE_TIME = new Map<string, Intl.DateTimeFormat>()
/** "9 de out., 14:32" in `timeZone`. */
export function formatDateTime(ms: number, timeZone: string): string {
  let formatter = DATE_TIME.get(timeZone)
  if (!formatter) {
    try { formatter = new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone }) }
    catch { formatter = new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) }
    DATE_TIME.set(timeZone, formatter)
  }
  return formatter.format(new Date(ms))
}

export const METRIC_LABELS: Readonly<Record<UsageMetric, string>> = {
  cost: 'Custo',
  tokens: 'Tokens',
  input: 'Entrada',
  output: 'Saída',
  cache: 'Cache',
  reasoning: 'Raciocínio',
  turns: 'Turnos',
  duration: 'Tempo de execução'
}

/** What the metric reads as in a sentence or a subheading ("Tokens de entrada"). */
export const METRIC_LONG_LABELS: Readonly<Record<UsageMetric, string>> = {
  cost: 'Custo',
  tokens: 'Tokens',
  input: 'Tokens de entrada',
  output: 'Tokens de saída',
  cache: 'Tokens de cache',
  reasoning: 'Tokens de raciocínio',
  turns: 'Turnos',
  duration: 'Tempo de execução'
}

export const DIMENSION_LABELS: Readonly<Record<UsageDimension, string>> = {
  provider: 'Provedor',
  model: 'Modelo',
  profile: 'Conta',
  project: 'Projeto',
  task: 'Tarefa',
  source: 'Origem'
}

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', traycer: 'Traycer', cursor: 'Cursor', grok: 'Grok',
  qwen: 'Qwen', kiro: 'Kiro', droid: 'Droid', kimi: 'Kimi', copilot: 'Copilot', amp: 'Amp', gemini: 'Gemini'
}

export function providerLabel(id: string): string {
  return PROVIDER_LABELS[id] ?? (id ? id.charAt(0).toUpperCase() + id.slice(1) : 'Desconhecido')
}

export function sourceLabel(source: string): string {
  return source === 'traycer' ? 'Traycer' : 'Prism'
}

/** Turn count with its noun: "1 turno", "3 turnos". */
export function turnsLabel(count: number): string {
  return `${formatInteger(count)} ${count === 1 ? 'turno' : 'turnos'}`
}

/** Glance-proof email for shared images: "a•••@d…". */
export function redactEmail(email: string): string {
  const at = email.indexOf('@')
  if (at <= 0) return '•••'
  return `${email.slice(0, 1)}•••@${email.slice(at + 1, at + 2)}…`
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
/** Every email in `text` redacted. */
export function redactEmails(text: string): string {
  return text.replace(EMAIL, (email) => redactEmail(email))
}
