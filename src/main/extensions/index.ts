import type Store from 'electron-store'
import { PrismSettings, ExtensionState } from '../store'
import { Extension, EditorState, ExtensionStatus, ExtensionContext } from './types'
import { createDiscordPresence } from './discordPresence'

interface Loaded {
  ext: Extension
  enabled: boolean
  status: ExtensionStatus
  detail?: string
  config: Record<string, unknown>
}

let store: Store<PrismSettings>
let broadcast: (channel: string, payload: unknown) => void = () => {}
const loaded = new Map<string, Loaded>()
let lastEditorState: EditorState = { file: null, language: null, workspace: null, dirty: false }

function persist(): void {
  const obj: Record<string, ExtensionState> = {}
  for (const [id, l] of loaded) obj[id] = { enabled: l.enabled, config: l.config }
  store.set('extensionsState', obj)
}

function makeContext(l: Loaded): ExtensionContext {
  return {
    config: l.config,
    setStatus: (status, detail) => {
      l.status = status
      l.detail = detail
      broadcast('ext:status', { id: l.ext.meta.id, status, detail })
    }
  }
}

export function initExtensions(
  s: Store<PrismSettings>,
  bc: (channel: string, payload: unknown) => void
): void {
  store = s
  broadcast = bc
  const saved = store.get('extensionsState') ?? {}
  const builtins: Extension[] = [createDiscordPresence()]

  for (const ext of builtins) {
    const persisted = saved[ext.meta.id]
    const config = { ...ext.meta.defaultConfig, ...(persisted?.config ?? {}) }
    const enabled = persisted?.enabled ?? false
    const l: Loaded = { ext, enabled, status: enabled ? 'connecting' : 'disabled', config }
    loaded.set(ext.meta.id, l)
    if (enabled) {
      Promise.resolve(ext.activate(makeContext(l))).then(() => ext.onEditorState?.(lastEditorState))
    }
  }
}

export function listExtensions(): unknown[] {
  return [...loaded.values()].map((l) => ({
    ...l.ext.meta,
    enabled: l.enabled,
    status: l.status,
    detail: l.detail,
    config: l.config
  }))
}

export async function setExtensionEnabled(id: string, enabled: boolean): Promise<unknown[]> {
  const l = loaded.get(id)
  if (!l || l.enabled === enabled) return listExtensions()
  l.enabled = enabled
  if (enabled) {
    l.status = 'connecting'
    await l.ext.activate(makeContext(l))
    l.ext.onEditorState?.(lastEditorState)
  } else {
    await l.ext.deactivate()
    l.status = 'disabled'
    l.detail = undefined
  }
  persist()
  return listExtensions()
}

export async function setExtensionConfig(
  id: string,
  config: Record<string, unknown>
): Promise<unknown[]> {
  const l = loaded.get(id)
  if (!l) return listExtensions()
  l.config = { ...l.config, ...config }
  if (l.enabled) l.ext.onConfig?.(l.config)
  persist()
  return listExtensions()
}

export function pushEditorState(state: EditorState): void {
  lastEditorState = state
  for (const l of loaded.values()) {
    if (l.enabled) l.ext.onEditorState?.(state)
  }
}
