// Model names the way Traycer shows them, shared by the model picker (main
// process catalogs) and Settings ▸ Uso (raw ids recorded on turns). Pure.

const claudeFamily = /\b(?:Claude\s+)?(Opus|Sonnet|Haiku)\s+(\d+(?:\.\d+)?)/i
/**
 * Traycer's Claude label: the CLI's display name, carrying the family version
 * its description (or id) names - "Default (recommended)" becomes
 * "Default (Opus 5.5)", "Opus (1M context)" becomes "Opus 5.5 (1M context)".
 */
export function claudeModelLabel(m: { value: string; displayName: string; description?: string }): string {
  const match = claudeFamily.exec(m.description || '') || claudeFamily.exec(m.value)
  if (!match) return m.displayName
  const family = match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase(), version = `${family} ${match[2]}`
  const name = m.displayName, lower = name.toLowerCase()
  if (lower.includes(version.toLowerCase())) return name
  if (lower.startsWith('default')) return `Default (${version})`
  if (lower.startsWith(family.toLowerCase())) return version + name.slice(family.length)
  return `${name} (${version})`
}

/** Traycer's Codex label: "gpt-6.1-sol" reads "GPT-6.1-Sol"; other ids keep their display name. */
export function codexModelLabel(id: string, displayName?: string): string {
  if (!id.startsWith('gpt-')) return displayName || id
  return id.split('-').map((part, i) => i === 0 ? part.toUpperCase() : /^[0-9.]+$/.test(part) ? part
    : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()).join('-')
}

const LONG_CONTEXT = /\[1m\]$/i
const capitalize = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()

/**
 * A Claude model id as a name when no catalog row names it: the resolved ids
 * a run reports ("claude-opus-5-5" → "Opus 5.5", "claude-3-5-sonnet-20241022"
 * → "Sonnet 3.5", "claude-haiku-4-5-20251001" → "Haiku 4.5"), with "[1m]"
 * read as Traycer writes it ("Opus 5.5 (1M context)"). Aliases without a
 * version ("opus") are capitalized; anything else is returned as is.
 */
export function claudeIdLabel(id: string): string {
  const longContext = LONG_CONTEXT.test(id)
  const base = id.replace(LONG_CONTEXT, '')
  const modern = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/i.exec(base)
  const legacy = /^claude-(\d+)(?:-(\d{1,2}))?-([a-z]+)(?:-\d{8})?$/i.exec(base)
  const name = modern ? `${capitalize(modern[1])} ${modern[2]}${modern[3] ? `.${modern[3]}` : ''}`
    : legacy ? `${capitalize(legacy[3])} ${legacy[1]}${legacy[2] ? `.${legacy[2]}` : ''}`
    : /^[a-z]+$/i.test(base) && base.toLowerCase() !== 'default' ? capitalize(base) : base
  return longContext ? `${name} (1M context)` : name
}
