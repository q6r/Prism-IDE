import type { SharedTurn, UnifiedChat } from '../../../shared/agents'

interface UsageState {
  readonly chats: readonly UnifiedChat[]
  readonly runtime: Readonly<Record<string, { readonly busy: boolean; readonly turnId: string }>>
}

function lastAssistant(turns: readonly SharedTurn[]): SharedTurn | undefined {
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i].role === 'assistant') return turns[i]
}

/** A completed turn can be followed immediately by the next queued one. */
export function usageRecordsChanged(next: UsageState, prev: UsageState): boolean {
  for (const [id, before] of Object.entries(prev.runtime)) {
    if (!before.busy) continue
    const after = next.runtime[id]
    if (!after?.busy || before.turnId && after.turnId && before.turnId !== after.turnId) return true
  }
  if (next.chats === prev.chats) return false
  if (next.chats.length < prev.chats.length) return true
  const previous = new Map(prev.chats.map(chat => [chat.id, chat]))
  for (const chat of next.chats) {
    const before = previous.get(chat.id)
    if (before === chat) continue
    // Assistant turns are at the tail while streaming; no full-history scan.
    const turn = lastAssistant(chat.turns)
    if (!turn?.completedAt) continue
    const oldTurn = before && lastAssistant(before.turns)
    if (oldTurn?.id !== turn.id || oldTurn.completedAt !== turn.completedAt || oldTurn.metrics !== turn.metrics) return true
  }
  return false
}

/** Coalesce final metrics/runtime batches; release both subscription and timer. */
export function followUsageUpdates(
  subscribe: (listener: (next: UsageState, prev: UsageState) => void) => () => void,
  reload: () => void,
  delayMs = 1500
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const off = subscribe((next, prev) => {
    if (!usageRecordsChanged(next, prev)) return
    clearTimeout(timer)
    timer = setTimeout(reload, delayMs)
  })
  return () => { clearTimeout(timer); off() }
}
