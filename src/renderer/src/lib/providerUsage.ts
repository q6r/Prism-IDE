import { create } from 'zustand'
import type { Provider, ProfileDetails, ProfileStatus, ProviderProfile } from '../../../shared/agents'

/**
 * Per-profile usage + login cache for the model picker and Settings, shaped
 * after Traycer's profile usage comparison: one entry per profile, automatic
 * non-forced checks (`ensure`) and an explicit forced `refresh`.
 */
export type Severity = 'healthy' | 'running_low' | 'limited'

export interface UsageEntry {
  readonly details?: ProfileDetails
  readonly status?: ProfileStatus
  readonly fetching: boolean
  readonly checkedAt?: number
  /** When the last check began; `ensure` paces from here, not from its end. */
  readonly startedAt?: number
  readonly statusAt?: number
}

/** Traycer's PROVIDER_RATE_LIMITS_STALE_TIME_MS equivalent. */
export const USAGE_STALE_MS = 5 * 60_000
const ENSURE_AFTER_MS = 60_000
const STATUS_TTL_MS = 5 * 60_000

interface UsageStore {
  entries: Record<string, UsageEntry>
  ensure: (profile: ProviderProfile) => void
  refresh: (profile: ProviderProfile) => Promise<void>
}

const inflight = new Map<string, Promise<void>>()

async function load(profile: ProviderProfile, force: boolean, set: (fn: (s: UsageStore) => Partial<UsageStore>) => void, get: () => UsageStore): Promise<void> {
  const key = profile.id
  const running = inflight.get(key)
  if (running && !force) return running
  const task = (async () => {
    const before = get().entries[key]
    const startedAt = Date.now()
    set((s) => ({ entries: { ...s.entries, [key]: { ...before, fetching: true, startedAt } } }))
    const wantStatus = force || !before?.statusAt || Date.now() - before.statusAt > STATUS_TTL_MS
    const [details, status] = await Promise.all([
      window.prism.providers.details(profile.provider as Provider, profile.id, force)
        .catch((): ProfileDetails => ({ ...(before?.details || { limits: [] }), stale: !!before?.details?.limits.length, error: 'Não foi possível consultar o uso.' })),
      wantStatus ? window.prism.providers.status(profile.provider as Provider, profile.id).catch(() => before?.status) : Promise.resolve(before?.status)
    ])
    const now = Date.now()
    set((s) => ({ entries: { ...s.entries, [key]: { details, status, fetching: false, checkedAt: now, startedAt, statusAt: wantStatus ? now : before?.statusAt } } }))
  })().finally(() => { if (inflight.get(key) === task) inflight.delete(key) })
  inflight.set(key, task)
  return task
}

export const useProviderUsage = create<UsageStore>((set, get) => ({
  entries: {},
  ensure: (profile) => {
    if (profile.enabled === false || profile.tombstoned) return
    const entry = get().entries[profile.id]
    // Paced from the start of the last check (with a little slack for timer
    // jitter), so a once-a-minute poller really refreshes once a minute.
    const since = entry?.startedAt ?? entry?.checkedAt
    if (entry?.fetching || (since && Date.now() - since < ENSURE_AFTER_MS - 2000)) return
    void load(profile, false, set, get)
  },
  refresh: (profile) => profile.enabled === false ? Promise.resolve() : load(profile, true, set, get)
}))

/* ---------------- Projection (lib/rate-limits/profile-usage-projection) ---------------- */

export interface UsageWindow {
  readonly id: string
  readonly label: string
  readonly usedPercent: number
  /** epoch ms */
  readonly resetsAt?: number
  readonly minutes?: number
  readonly severity: Severity
}

export type UsageProjection =
  | { readonly kind: 'detail' | 'stale'; readonly windows: readonly UsageWindow[]; readonly compact: UsageWindow; readonly severity: Severity; readonly checkedAt: number | null; readonly failed: boolean }
  | { readonly kind: 'not_checked'; readonly checkedAt: null }
  | { readonly kind: 'unavailable'; readonly failed: boolean; readonly checkedAt: number | null; readonly message?: string }

const RANK: Record<Severity, number> = { healthy: 0, running_low: 1, limited: 2 }

/** Short (≤24h) windows warn at 80%, long or undated ones at 95%; 100% is limited. */
export function windowSeverity(usedPercent: number, minutes?: number): Severity {
  if (usedPercent >= 100) return 'limited'
  return usedPercent >= (minutes !== undefined && minutes <= 1440 ? 80 : 95) ? 'running_low' : 'healthy'
}

/** "Sessão atual", "Semanal", "Opus · Semanal"… (formatWindowDuration + name). */
export function windowLabel(limit: ProfileDetails['limits'][number]): string {
  const m = limit.windowMinutes
  const duration = !m ? 'Uso' : m === 10080 ? 'Semanal' : m === 300 ? 'Sessão atual'
    : m % 1440 === 0 ? `${m / 1440}d` : m % 60 === 0 ? `${m / 60}h` : `${m}m`
  return limit.name ? `${limit.name} · ${duration}` : duration
}

export function usageWindows(details?: ProfileDetails): UsageWindow[] {
  return (details?.limits || []).map((l, i) => ({ id: l.id || String(i), label: windowLabel(l), usedPercent: l.usedPercent,
    resetsAt: l.resetsAt ? l.resetsAt * 1000 : undefined, minutes: l.windowMinutes, severity: windowSeverity(l.usedPercent, l.windowMinutes) }))
}

export function projectUsage(entry: UsageEntry | undefined, now: number): UsageProjection {
  const details = entry?.details
  if (!details) return { kind: 'not_checked', checkedAt: null }
  const checkedAt = details.updatedAt ?? entry?.checkedAt ?? null
  const windows = usageWindows(details).filter((w) => !w.resetsAt || w.resetsAt > now || w.usedPercent > 0)
  const failed = !!details.error
  if (!windows.length) return { kind: 'unavailable', failed, checkedAt, message: details.error || details.unavailable }
  const compact = [...windows].sort((a, b) => RANK[b.severity] - RANK[a.severity] || b.usedPercent - a.usedPercent)[0]
  const stale = failed || !!details.stale || (checkedAt !== null && now - checkedAt > USAGE_STALE_MS)
  return { kind: stale ? 'stale' : 'detail', windows, compact, severity: compact.severity, checkedAt, failed }
}

/* ---------------- Formatting (lib/relative-time) ---------------- */

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR

/** "agora mesmo", "há 19 min", "há 3 h", "ontem", "5 de out." */
export function relativeTime(ts: number, now: number): string {
  const diff = Math.max(0, now - ts)
  if (diff < MINUTE) return 'agora mesmo'
  if (diff < HOUR) return `há ${Math.floor(diff / MINUTE)} min`
  if (diff < DAY) return `há ${Math.floor(diff / HOUR)} h`
  if (diff < 2 * DAY) return 'ontem'
  return new Date(ts).toLocaleDateString('pt-BR', { day: 'numeric', month: 'short' })
}

/** "2h 13m", "45m", "3d" (formatResetCountdown). */
export function resetCountdown(resetsAt: number, now: number): string {
  const diff = Math.max(0, resetsAt - now), minutes = Math.floor(diff / MINUTE)
  if (minutes < 1) return diff === 0 ? '0s' : `${Math.max(1, Math.floor(diff / 1000))}s`
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60), rest = minutes % 60
  if (hours < 24) return rest ? `${hours}h ${rest}m` : `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/** "Renova sex. 9:00" when a day or more away, else "Renova em 2h 13m". */
export function resetLabel(resetsAt: number | undefined, now: number): string | null {
  if (!resetsAt) return null
  if (resetsAt - now >= DAY) {
    const d = new Date(resetsAt)
    return `Renova ${d.toLocaleDateString('pt-BR', { weekday: 'short' })} ${d.toLocaleTimeString('pt-BR', { hour: 'numeric', minute: '2-digit' })}`
  }
  return `Renova em ${resetCountdown(resetsAt, now)}`
}

/** Row status suffix for the profile dropdown (profileRowStatusSuffix). */
export function profileStatusSuffix(profile: ProviderProfile, entry?: UsageEntry): string | null {
  if (profile.enabled === false) return null
  const status = entry?.status
  if (!status) return null
  if (!status.installed) return 'Indisponível'
  if (!status.loggedIn) return 'Sem login'
  return null
}
