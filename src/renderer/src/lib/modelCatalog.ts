import { create } from 'zustand'
import type { AgentModel, AgentSelection, Provider } from '../../../shared/agents'

/** Per provider+profile model catalog, shared by every picker instance. */
export interface CatalogEntry { readonly models: readonly AgentModel[]; readonly loading: boolean; readonly error?: string; readonly loadedAt?: number }

interface CatalogStore {
  entries: Record<string, CatalogEntry>
  load: (provider: Provider, profileId: string, force?: boolean) => void
}

export const catalogKey = (provider: Provider, profileId: string): string => `${provider}:${profileId}`

/** Traycer refetches the catalog when the picker opens on data older than this. */
export const CATALOG_STALE_MS = 5 * 60_000

export const useModelCatalog = create<CatalogStore>((set, get) => ({
  entries: {},
  load: (provider, profileId, force = false) => {
    const key = catalogKey(provider, profileId)
    const entry = get().entries[key]
    if (entry?.loading) return
    if (!force && entry?.loadedAt && !entry.error && Date.now() - entry.loadedAt < CATALOG_STALE_MS) return
    // Stale rows stay visible while the refetch runs.
    set((s) => ({ entries: { ...s.entries, [key]: { models: entry?.models || [], loading: true, loadedAt: entry?.loadedAt } } }))
    window.prism.providers.models(provider, profileId, force)
      .then((models) => set((s) => ({ entries: { ...s.entries, [key]: { models, loading: false, loadedAt: Date.now() } } })))
      .catch((err: Error) => set((s) => ({ entries: { ...s.entries, [key]: { models: entry?.models || [], loading: false, error: err.message || 'Falha ao consultar modelos.', loadedAt: Date.now() } } })))
  }
}))

export const EFFORT_LABELS: Record<AgentSelection['effort'], string> = {
  low: 'Baixo', medium: 'Médio', high: 'Alto', xhigh: 'Extra alto', max: 'Máximo', ultra: 'Ultra'
}

/** The row a selection points at: its model, or the catalog default for ''. */
export function selectedModelFor(selection: AgentSelection, models: readonly AgentModel[]): AgentModel | undefined {
  return selection.model ? models.find((m) => m.id === selection.model) : models.find((m) => m.default)
}

/** The effort a model starts on when nothing is remembered for it (Traycer's "" reasoning). */
export function defaultEffortFor(model: AgentModel | undefined, fallback: AgentSelection['effort'] = 'high'): AgentSelection['effort'] {
  if (!model?.efforts.length) return fallback
  return model.defaultEffort && model.efforts.includes(model.defaultEffort) ? model.defaultEffort
    : model.efforts.includes('high') ? 'high' : model.efforts[model.efforts.length - 1]
}

/**
 * normalizeReasoningForModel: keeps the stored effort inside what the model
 * honours. The Fast (service tier) preference is deliberately NOT normalized:
 * it is sticky, and the send path drops it for models without that tier
 * (`effectiveServiceTier`), as Traycer filters it in the adapter.
 */
export function normalizeForModel(selection: AgentSelection, model: AgentModel | undefined): Partial<AgentSelection> | null {
  if (!model?.efforts.length || model.efforts.includes(selection.effort)) return null
  return { effort: defaultEffortFor(model) }
}

/*
 * Composer memory (Traycer's composer-harness-memory-store): the last profile
 * and model per provider, effort + Fast per (provider, model), and the last
 * committed route new chats start from. Written only when the user commits a
 * change, never by merely viewing a chat.
 */
const MEMORY_KEY = 'prism.picker.memory.v2'
const LEGACY_MEMORY_KEY = 'prism.picker.memory.v1'
const MEMORY_CAP = 200
type Effort = AgentSelection['effort']
const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
const PERMISSIONS: readonly AgentSelection['permissionMode'][] = ['default', 'plan', 'acceptEdits', 'bypassPermissions']
const PROVIDERS: readonly Provider[] = ['claude', 'codex']

export interface EffortTier { readonly effort: Effort | null; readonly serviceTier: string | null }
interface EffortRecord extends EffortTier { readonly updatedAt: number }
export type RememberedRoute = Pick<AgentSelection, 'provider' | 'profileId' | 'model' | 'effort' | 'serviceTier' | 'permissionMode'>
export interface PickerMemory {
  lastProfile: Partial<Record<Provider, string>>
  lastModel: Partial<Record<Provider, string>>
  byModel: Record<string, EffortRecord>
  last?: RememberedRoute
}

const modelKey = (provider: Provider, model: string): string => `${provider} ${model}`
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isProvider = (v: unknown): v is Provider => PROVIDERS.includes(v as Provider)
const isEffort = (v: unknown): v is Effort => EFFORTS.includes(v as Effort)
const emptyMemory = (): PickerMemory => ({ lastProfile: {}, lastModel: {}, byModel: {} })

function readStored(key: string): unknown {
  try { return JSON.parse(localStorage.getItem(key) || 'null') as unknown } catch { return null }
}

function parseMemory(raw: unknown): PickerMemory {
  const memory = emptyMemory()
  if (!isObject(raw)) return memory
  for (const [map, target] of [[raw.lastProfile, memory.lastProfile], [raw.lastModel, memory.lastModel]] as const) {
    if (isObject(map)) for (const [p, v] of Object.entries(map)) if (isProvider(p) && typeof v === 'string') target[p] = v
  }
  if (isObject(raw.byModel)) for (const [k, v] of Object.entries(raw.byModel)) {
    if (!isObject(v) || typeof v.updatedAt !== 'number') continue
    memory.byModel[k] = { effort: isEffort(v.effort) ? v.effort : null, serviceTier: typeof v.serviceTier === 'string' && v.serviceTier ? v.serviceTier : null, updatedAt: v.updatedAt }
  }
  const last = raw.last
  if (isObject(last) && isProvider(last.provider) && typeof last.profileId === 'string' && typeof last.model === 'string' && isEffort(last.effort)) {
    memory.last = { provider: last.provider, profileId: last.profileId, model: last.model, effort: last.effort,
      serviceTier: typeof last.serviceTier === 'string' ? last.serviceTier : '',
      permissionMode: PERMISSIONS.includes(last.permissionMode as AgentSelection['permissionMode']) ? last.permissionMode as AgentSelection['permissionMode'] : 'default' }
  }
  return memory
}

/** v1 kept one route per provider; it seeds the v2 maps once. */
function migrateLegacy(raw: unknown): PickerMemory {
  const memory = emptyMemory()
  if (!isObject(raw)) return memory
  for (const [provider, route] of Object.entries(raw)) {
    if (!isProvider(provider) || !isObject(route)) continue
    if (typeof route.profileId === 'string') memory.lastProfile[provider] = route.profileId
    if (typeof route.model === 'string' && route.model) {
      memory.lastModel[provider] = route.model
      memory.byModel[modelKey(provider, route.model)] = { effort: isEffort(route.effort) ? route.effort : null,
        serviceTier: typeof route.serviceTier === 'string' && route.serviceTier ? route.serviceTier : null, updatedAt: 0 }
    }
  }
  return memory
}

export function readPickerMemory(): PickerMemory {
  const stored = readStored(MEMORY_KEY)
  return stored !== null ? parseMemory(stored) : migrateLegacy(readStored(LEGACY_MEMORY_KEY))
}

/** The commit funnel: called when the user changes the route, effort, Fast or access mode. */
export function recordSelection(selection: AgentSelection): void {
  try {
    const memory = readPickerMemory()
    memory.lastProfile[selection.provider] = selection.profileId
    if (selection.model) {
      memory.lastModel[selection.provider] = selection.model
      memory.byModel[modelKey(selection.provider, selection.model)] = { effort: selection.effort, serviceTier: selection.serviceTier || null, updatedAt: Date.now() }
      const keys = Object.keys(memory.byModel)
      if (keys.length > MEMORY_CAP) {
        keys.sort((a, b) => memory.byModel[b].updatedAt - memory.byModel[a].updatedAt)
        for (const key of keys.slice(MEMORY_CAP)) delete memory.byModel[key]
      }
    }
    memory.last = { provider: selection.provider, profileId: selection.profileId, model: selection.model, effort: selection.effort,
      serviceTier: selection.serviceTier || '', permissionMode: selection.permissionMode }
    localStorage.setItem(MEMORY_KEY, JSON.stringify(memory))
  } catch { /* storage unavailable: memory is a convenience */ }
}

/** An explicit model pick restores only that pair's effort/Fast (null = the model's own default). */
export function resolveModelPick(provider: Provider, model: string, memory = readPickerMemory()): EffortTier {
  const record = memory.byModel[modelKey(provider, model)]
  return record ? { effort: record.effort, serviceTier: record.serviceTier } : { effort: null, serviceTier: null }
}

/** A provider switch restores that provider's last profile and model, with the pair's effort/Fast. */
export function resolveProviderSwitch(provider: Provider): EffortTier & { profileId?: string; model: string } {
  const memory = readPickerMemory()
  const model = memory.lastModel[provider]
  return model === undefined ? { profileId: memory.lastProfile[provider], model: '', effort: null, serviceTier: null }
    : { profileId: memory.lastProfile[provider], model, ...resolveModelPick(provider, model, memory) }
}

/** New chats start from the last committed route (Traycer's last run settings). */
export function initialSelection(fallbackModel: string): AgentSelection {
  const last = readPickerMemory().last
  return last ? { ...last } : { provider: 'claude', profileId: 'ambient-claude', model: fallbackModel, effort: 'high', permissionMode: 'default' }
}
