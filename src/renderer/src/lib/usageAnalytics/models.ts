import type { AgentModel } from '../../../../shared/agents'
import { claudeIdLabel, codexModelLabel } from '../../../../shared/modelLabels'
import type { UsageFact } from '../../../../shared/usage'

// Model names for usage: the catalog's Traycer labels for the ids a turn
// recorded, with aliases ("opus", "default", "") read as the model they
// resolve to, so "opus" and "claude-opus-5-5" are one row. Pure.

/** Labels by `${provider}:${id}`; `${provider}:` is the provider's default model. */
export type ModelNames = ReadonlyMap<string, string>

/** The names every loaded catalog row gives (first catalog wins on a clash). */
export function buildModelNames(models: readonly AgentModel[]): Map<string, string> {
  const names = new Map<string, string>()
  for (const m of models) {
    if (!names.has(`${m.provider}:${m.id}`)) names.set(`${m.provider}:${m.id}`, m.label)
    if (m.default && !names.has(`${m.provider}:`)) names.set(`${m.provider}:`, m.label)
  }
  return names
}

/** "Default (Opus 5.5)" is Opus 5.5 running as the default, so it reads (and groups) as "Opus 5.5". */
export function canonicalModelLabel(label: string): string {
  const match = /^default \((.+)\)$/i.exec(label.trim())
  return match ? match[1] : label.trim()
}

const LONG_CONTEXT = /\[1m\]$/i

/** The name a recorded model id reads as; "Padrão" for an unresolved default. */
export function modelLabel(provider: string, id: string, names: ModelNames): string {
  const known = names.get(`${provider}:${id}`)
  if (known) return canonicalModelLabel(known)
  if (provider === 'claude') {
    if (LONG_CONTEXT.test(id)) {
      const base = names.get(`claude:${id.replace(LONG_CONTEXT, '')}`)
      if (base) return `${canonicalModelLabel(base)} (1M context)`
    }
    return !id || id.toLowerCase() === 'default' ? 'Padrão' : claudeIdLabel(id)
  }
  if (provider === 'codex') return id ? codexModelLabel(id) : 'Padrão'
  return id || 'Padrão'
}

/** Facts carrying their model's display name (`modelLabel`), which the model dimension groups by. */
export function labelModels(facts: readonly UsageFact[], names: ModelNames): UsageFact[] {
  const cache = new Map<string, string>()
  return facts.map((f) => {
    const key = `${f.provider}:${f.model}`
    let label = cache.get(key)
    if (label === undefined) { label = modelLabel(f.provider, f.model, names); cache.set(key, label) }
    return { ...f, modelLabel: label }
  })
}
