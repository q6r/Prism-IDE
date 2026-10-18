// Pure helpers for Settings ▸ Provedores that the shared usage cache
// (lib/providerUsage.ts) does not already own: the Settings variant of the
// reset line (a full calendar date for far windows), profile login words,
// email redaction and accent-color choice. The only runtime import is the pure
// palette module, so tests load this file without the renderer.
import type { ProfileStatus, ProviderProfile } from '../../../../shared/agents'
import { PROFILE_ACCENT_COLORS } from '../../lib/profileAccent'

const MINUTE_MS = 60_000
const DAY_MS = 24 * 60 * MINUTE_MS

/** "45s", "12m", "4h 7m", "3d"; a past reset clamps to "0s" (formatResetCountdown). */
export function formatResetCountdown(resetsAtMs: number, now: number): string {
  const diff = Math.max(0, resetsAtMs - now)
  const minutes = Math.floor(diff / MINUTE_MS)
  if (minutes < 1) return diff === 0 ? '0s' : `${Math.max(1, Math.floor(diff / 1000))}s`
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours < 24) return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/** A day or more away reads better as a calendar date than as "Renova em 3d". */
export function isFarReset(resetsAtMs: number, now: number): boolean {
  return resetsAtMs - now >= DAY_MS
}

/** "sáb., 18 de jul. de 2026, 03:35" - the roomy form Settings uses (formatResetFullDateTime). */
export function formatResetFullDateTime(resetsAtMs: number): string {
  return new Date(resetsAtMs).toLocaleString('pt-BR', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
  })
}

/**
 * The meter's right-hand detail in Settings: "62% usado · Renova em 4h 7m",
 * or the full date for a far reset, or the rolled-over note once the window
 * has already ended and waits for the next check.
 */
export function settingsWindowDetail(usedPercent: number, resetsAtMs: number | undefined, now: number): string {
  const used = `${Math.round(Math.min(100, Math.max(0, usedPercent)))}% usado`
  if (!resetsAtMs) return used
  if (resetsAtMs <= now) return `${used} · Janela encerrada, aguardando nova consulta`
  if (isFarReset(resetsAtMs, now)) return `${used} · Renova ${formatResetFullDateTime(resetsAtMs)}`
  return `${used} · Renova em ${formatResetCountdown(resetsAtMs, now)}`
}

/** Glance-proof email: first letter, a mask, the domain's first letter ("a•••@d…"). */
export function redactEmail(email: string): string {
  const at = email.indexOf('@')
  if (at <= 0) return '•••'
  return `${email.slice(0, 1)}•••@${email.slice(at + 1, at + 2)}…`
}

export type ProfileAuthState = 'checking' | 'signed-in' | 'signed-out' | 'unavailable'

/** What the badge beside a profile says about its login. */
export function profileAuthState(status: ProfileStatus | undefined, checking: boolean): ProfileAuthState {
  if (!status) return checking ? 'checking' : 'signed-out'
  if (status.loggedIn) return 'signed-in'
  return status.installed ? 'signed-out' : 'unavailable'
}

export const PROFILE_AUTH_TEXT: Record<ProfileAuthState, string> = {
  checking: 'Verificando',
  'signed-in': 'Conectado',
  'signed-out': 'Desconectado',
  unavailable: 'Indisponível'
}

/** Another live profile of the same provider already wearing `color`, if any. */
export function duplicateColorProfile(profiles: readonly ProviderProfile[], self: ProviderProfile | null, provider: string, color: string | null): ProviderProfile | null {
  if (!color) return null
  const target = color.toLowerCase()
  return profiles.find((p) => p.provider === provider && p.id !== self?.id && !p.tombstoned && p.color?.toLowerCase() === target) ?? null
}

/** The palette's first color no other live profile of this provider wears (palette[0] once all are taken). */
export function nextAccentColor(profiles: readonly ProviderProfile[], provider: string, palette: readonly string[] = PROFILE_ACCENT_COLORS): string {
  const taken = new Set(profiles.filter((p) => p.provider === provider && !p.tombstoned && p.color).map((p) => p.color!.toLowerCase()))
  return palette.find((c) => !taken.has(c.toLowerCase())) ?? palette[0]
}

/** One provider's profiles: the terminal (ambient) account first, removed ones hidden. */
export function providerProfiles(profiles: readonly ProviderProfile[], provider: string): ProviderProfile[] {
  return profiles.filter((p) => p.provider === provider && !p.tombstoned)
    .sort((a, b) => Number(!!b.ambient) - Number(!!a.ambient))
}

/**
 * Why a CLI login cannot start for `profile`, or null (the old AccountsModal
 * guards plus the missing-CLI case): the terminal account is the terminal's,
 * a disabled profile must be enabled first, the CLI must be installed, only
 * one login runs at a time, and a running chat must not switch account mid-turn.
 */
export function signInBlockedReason(profile: ProviderProfile, state: { loginOpen: boolean; busy: boolean; cliMissing: string | null }): string | null {
  if (profile.ambient) return 'A conta do terminal é gerenciada pelo terminal.'
  if (profile.enabled === false) return 'Ative o perfil para entrar.'
  if (state.cliMissing) return state.cliMissing
  if (state.loginOpen) return 'Conclua o login em andamento primeiro.'
  if (state.busy) return 'Há uma conversa em andamento com este perfil.'
  return null
}

/** Why a Prism sign-in cannot start on a profile that runs on (or lost) Traycer's login, or null. */
export function traycerLinkSignInBlock(profile: ProviderProfile): string | null {
  return profile.traycerLink ? 'Este perfil usa o login do Traycer. Desvincule-o para entrar pelo Prism.' : null
}

/**
 * The warning Settings ▸ Provedores shows when the installed CLI is not a
 * version Prism verified (`providers.available`, from the host): its pt-BR
 * text, or null when verified or unknown (absent `verified`, the IPC side).
 */
export function cliVersionWarning(availability: { version: string; verified?: boolean; warning?: string } | null | undefined): string | null {
  if (availability?.verified !== false) return null
  return availability.warning || `A versão ${availability.version || 'instalada'} do CLI não foi verificada com o Prism.`
}

/** Latest check time across `times` (ms), or null when none has landed yet. */
export function latestCheckedAt(times: readonly (number | undefined)[]): number | null {
  let latest: number | null = null
  for (const t of times) if (t !== undefined && (latest === null || t > latest)) latest = t
  return latest
}
