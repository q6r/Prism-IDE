import { create } from 'zustand'
import { useAgentChats } from '../../lib/agentChats'
import { useStore } from '../../store'

/**
 * Finished runs the user has not seen - Traycer's unread "done" / "needs
 * attention" tones on chat rows and task tabs. A run that ends while its chat
 * is not on screen stays unread until the chat is on screen again; persisted,
 * so a reload keeps it.
 */
type Outcome = 'done' | 'failure'
const KEY = 'prism.agents.unread'

function load(): Record<string, Outcome> {
  try {
    const raw: unknown = JSON.parse(globalThis.localStorage?.getItem(KEY) || '{}')
    if (!raw || typeof raw !== 'object') return {}
    return Object.fromEntries(Object.entries(raw).filter((e): e is [string, Outcome] => e[1] === 'done' || e[1] === 'failure'))
  } catch { return {} }
}
export const useUnreadOutcomes = create<{ outcomes: Readonly<Record<string, Outcome>> }>(() => ({ outcomes: load() }))
function commit(next: Record<string, Outcome>): void {
  useUnreadOutcomes.setState({ outcomes: next })
  try { globalThis.localStorage?.setItem(KEY, JSON.stringify(next)) } catch { /* storage unavailable: keep it in memory */ }
}

/** The chat is on screen: the open chat of a visible agents surface, in a focused window. */
function onScreen(id: string): boolean {
  const store = useStore.getState()
  return useAgentChats.getState().activeId === id && document.hasFocus() && !document.hidden
    && (store.workspaceView === 'agents' || (store.workspaceView === 'editor' && store.chatOpen))
}
/** Seeing a chat is what reads it. */
function readVisible(): void {
  const id = useAgentChats.getState().activeId, outcomes = useUnreadOutcomes.getState().outcomes
  if (!id || !outcomes[id] || !onScreen(id)) return
  const next = { ...outcomes }
  delete next[id]
  commit(next)
}

let started = false
export function trackUnreadOutcomes(): void {
  if (started) return
  started = true
  useAgentChats.subscribe((state, prev) => {
    if (state.runtime !== prev.runtime || state.chats.length !== prev.chats.length) {
      const outcomes = useUnreadOutcomes.getState().outcomes
      const next: Record<string, Outcome> = { ...outcomes }
      for (const [id, run] of Object.entries(state.runtime)) {
        const was = prev.runtime[id]
        if (run.busy && !was?.busy) delete next[id]
        if (run.busy || !was?.busy) continue
        const turn = state.chats.find((c) => c.id === id)?.turns.find((t) => t.id === run.turnId)
        if (!turn?.interrupted && !onScreen(id)) next[id] = turn?.error ? 'failure' : 'done'
      }
      // Deleted chats leave nothing behind.
      if (state.ready) for (const id of Object.keys(next)) if (!state.chats.some((c) => c.id === id)) delete next[id]
      const keys = Object.keys(next)
      if (keys.length !== Object.keys(outcomes).length || keys.some((k) => next[k] !== outcomes[k])) commit(next)
    }
    if (state.activeId !== prev.activeId) readVisible()
  })
  useStore.subscribe((state, old) => { if (state.workspaceView !== old.workspaceView || state.chatOpen !== old.chatOpen) readVisible() })
  window.addEventListener('focus', readVisible)
  document.addEventListener('visibilitychange', readVisible)
  readVisible()
}
