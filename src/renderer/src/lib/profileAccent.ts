// Traycer's selectable profile accent palette (PROVIDER_PROFILE_ACCENT_COLORS).
export const PROFILE_ACCENT_COLORS = ['#ef4444', '#f97316', '#f59e0b', '#84cc16', '#10b981', '#14b8a6',
  '#06b6d4', '#3b82f6', '#8b5cf6', '#a855f7', '#d946ef', '#ec4899'] as const

/** The profile's chosen color, or a deterministic FNV-1a pick from the palette (resolveProfileAccentColor). */
export function profileAccentColor(profileId: string, color?: string | null): string {
  if (color) return color
  let hash = 0x811c9dc5
  for (let i = 0; i < profileId.length; i++) { hash ^= profileId.charCodeAt(i); hash = Math.imul(hash, 0x01000193) }
  return PROFILE_ACCENT_COLORS[(hash >>> 0) % PROFILE_ACCENT_COLORS.length]
}
