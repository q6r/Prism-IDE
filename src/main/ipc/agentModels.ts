import type { EventEmitter } from 'events'
import { ipcMain, app } from 'electron'
import { CodexServer } from '../codexServer'
import { profileEnvironment, providerCommand } from '../providers'
import { profileUsage, invalidateUsage, consumeCodexResetCredit } from '../providerUsage'
import type { AgentModel, AgentSelection, Provider, ProfileDetails } from '../../shared/agents'
import { claudeModelLabel, codexModelLabel } from '../../shared/modelLabels'

const levels = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
const cache = new Map<string, { expires: number; result: Promise<AgentModel[]> }>()
export function registerModelHandlers(): void {
  ;(app as unknown as EventEmitter).on('prism:profile-changed', (id: unknown) => {
    invalidateUsage(String(id))
    for(const key of cache.keys()) if(key.endsWith(`:${id}`)) cache.delete(key)
  })
  ipcMain.handle('providers:details', (_e, provider: Provider, profileId: string, refresh = false): Promise<ProfileDetails> => profileUsage(provider, profileId, refresh))
  // Spends a real Codex manual reset: only ever sent from the confirmed dialog in Settings.
  ipcMain.handle('providers:codex-reset', async (_e, profileId: unknown, idempotencyKey: unknown, creditId: unknown) =>
    ({ outcome: await consumeCodexResetCredit(profileId, idempotencyKey, creditId) }))
  ipcMain.handle('providers:models', (_e, provider: Provider, profileId: string, refresh = false) => {
    const key = `${provider}:${profileId}`, hit = cache.get(key)
    if (!refresh && hit && hit.expires > Date.now()) return hit.result
    const result = discoverModels(provider, profileId).catch((err) => { cache.delete(key); throw err })
    cache.set(key, { expires: Date.now() + 300000, result })
    return result
  })
}
export async function discoverModels(provider: Provider, profileId: string): Promise<AgentModel[]> {
  if (provider === 'codex') {
    const server = new CodexServer(profileId)
    try {
      await server.ready
      const rows: any[] = []
      let cursor: string | undefined
      do {
        const page = await server.request('model/list', { limit: 100, ...(cursor ? { cursor } : {}) })
        rows.push(...page.data)
        cursor = page.nextCursor || undefined
      } while (cursor)
      return codexModels(rows)
    } finally { server.close() }
  }
  if (provider !== 'claude') throw new Error('Agente inválido.')
  const command = providerCommand('claude', profileId)
  if (!command) throw new Error('Instale o Claude Code para consultar seus modelos.')
  const sdk = await import('@anthropic-ai/claude-agent-sdk')
  const controller = new AbortController()
  // Empty input: initialize the native control protocol and query metadata,
  // without creating a paid model request or reading credentials in the UI.
  async function* input(): AsyncGenerator<any> { await new Promise<void>((resolve) => controller.signal.addEventListener('abort', () => resolve(), { once: true })) }
  const query = sdk.query({ prompt: input(), options: { abortController: controller,
    pathToClaudeCodeExecutable: command.args[0] || command.bin, env: profileEnvironment(provider, profileId), persistSession: false } })
  const timer = setTimeout(() => controller.abort(), 25000)
  try {
    return claudeModels(await query.supportedModels())
  } finally { clearTimeout(timer); controller.abort(); query.close() }
}

const knownEfforts = (ids: unknown[]): AgentSelection['effort'][] =>
  [...new Set(ids.filter((e): e is AgentSelection['effort'] => typeof e === 'string' && levels.has(e)))]

/** Claude rows in CLI order, labelled the way Traycer labels them. */
export function claudeModels(rows: { value: string; displayName: string; description: string; supportedEffortLevels?: string[]; supportsFastMode?: boolean }[]): AgentModel[] {
  return rows.map((m) => ({ provider: 'claude', id: m.value, label: claudeModelLabel(m), description: m.description,
    efforts: knownEfforts(m.supportedEffortLevels || []), defaultEffort: 'high', default: m.value === 'default',
    fast: m.supportsFastMode ? { id: 'fast', label: 'Fast' } : null }))
}

// The labels live in shared/modelLabels.ts (Settings ▸ Uso names recorded ids with them too).
export { claudeModelLabel, codexModelLabel }

/** Visible Codex rows, the catalog default first (as Traycer orders them). */
export function codexModels(rows: any[]): AgentModel[] {
  const visible = rows.filter((m) => m && typeof m.model === 'string' && m.model && !m.hidden)
  const first = visible.findIndex((m) => m.isDefault === true)
  const ordered = first > 0 ? [visible[first], ...visible.filter((_, i) => i !== first)] : visible
  return ordered.map((m) => ({ provider: 'codex', id: m.model, label: codexModelLabel(m.model, m.displayName), description: m.description || '',
    efforts: knownEfforts((m.supportedReasoningEfforts || []).map((e: any) => e?.reasoningEffort)),
    defaultEffort: levels.has(m.defaultReasoningEffort) ? m.defaultReasoningEffort : undefined, default: m.isDefault === true,
    fast: codexUpgradeTier(m) }))
}

/**
 * The tier Traycer's Fast toggle flips to: the first advertised tier that is
 * not the model's default (`serviceTiers`, or the deprecated
 * `additionalSpeedTiers`), else the first one.
 */
export function codexUpgradeTier(model: any): { id: string; label: string } | null {
  const tiers: { id: string; name?: string }[] = Array.isArray(model.serviceTiers) && model.serviceTiers.length
    ? model.serviceTiers : (model.additionalSpeedTiers || []).filter((id: unknown) => typeof id === 'string' && id !== 'default').map((id: string) => ({ id }))
  if (!tiers.length) return null
  // A catalog that names no default can still list the baseline tier itself.
  const baseline = new Set([model.defaultServiceTier, 'default', 'standard', 'auto'].filter(Boolean))
  const upgrade = tiers.find((t) => !baseline.has(t.id)) || tiers.find((t) => t.id !== model.defaultServiceTier) || tiers[0]
  return { id: upgrade.id, label: upgrade.name && upgrade.name.length <= 12 ? upgrade.name : 'Fast' }
}
