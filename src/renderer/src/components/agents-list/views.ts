import { create } from 'zustand'
import { DEFAULT_VIEW, parseView, parseViews, viewFor, withView, type AgentView } from './model'

/**
 * The Agents view (ordering, Show, filters) per task - Traycer keeps it per
 * epic. Persisted; a task never configured starts at the default view, and a
 * view reset to the default is forgotten rather than stored.
 */
const KEY = 'prism.agents.views', LEGACY_KEY = 'prism.agents.view'

function read(key: string): unknown {
  try { const raw = globalThis.localStorage?.getItem(key); return raw ? JSON.parse(raw) : null } catch { return null }
}
function write(views: Record<string, AgentView>): void {
  try { globalThis.localStorage?.setItem(KEY, JSON.stringify(views)) } catch { /* storage unavailable: keep it in memory */ }
}

export const useAgentViews = create<{ views: Readonly<Record<string, AgentView>>; setView: (taskId: string, view: AgentView) => void }>((set, get) => ({
  views: parseViews(read(KEY)),
  setView: (taskId, view) => { const views = withView(get().views, taskId, view); set({ views }); write(views) }
}))

/**
 * The one-time move of the old window-wide view: it becomes the view of the
 * task that is open when it is first read, so nobody loses a choice they made.
 */
export function adoptLegacyView(taskId: string): void {
  let present = false
  try { present = globalThis.localStorage?.getItem(LEGACY_KEY) != null } catch { return }
  if (!present) return
  const legacy = read(LEGACY_KEY)
  // Removed even when unreadable, so a corrupt value is not carried forever.
  try { globalThis.localStorage?.removeItem(LEGACY_KEY) } catch { /* nothing to clean */ }
  if (legacy !== null && !useAgentViews.getState().views[taskId]) useAgentViews.getState().setView(taskId, parseView(legacy))
}

export function useTaskView(taskId: string | null): AgentView {
  return useAgentViews((s) => viewFor(s.views, taskId, DEFAULT_VIEW))
}
