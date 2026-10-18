import type { SharedSegment, SharedTurn, UnifiedChat } from './agents'
import type { ChatDelta } from './host/generated/ChatDelta'
import type { ChatRuntime } from './host/generated/ChatRuntime'

/**
 * The renderer's chats and runtime after the host's `chats.delta` deltas
 * (T07; host/crates/prism-protocol/src/chats.rs documents each `op`). The
 * same edits `foldJournal` (agentJournal.ts) makes for the same events, so a
 * chat followed delta by delta matches the chat folded from the journal.
 *
 * Immutable: the result shares every chat, turn and segment the deltas did
 * not touch, and nothing the caller passed in is mutated (deltas included).
 */

export interface ChatsState<R = ChatRuntime> {
  chats: UnifiedChat[]
  runtime: Record<string, R>
}

export interface ChatsApplied<R = ChatRuntime> extends ChatsState<R> {
  /** Ids of the chats whose document or runtime changed, in first-change order. */
  changed: string[]
}

export function applyChatDeltas<R = ChatRuntime>(state: ChatsState<R>, deltas: readonly ChatDelta[]): ChatsApplied<R> {
  let chats = state.chats
  let runtime = state.runtime
  const changed = new Set<string>()
  // Copies made by this call, safe to edit again within the same batch.
  const fresh = new WeakSet<object>()
  const own = <T extends object>(value: T, copy: (v: T) => T): T => {
    if (fresh.has(value)) return value
    const next = copy(value)
    fresh.add(next)
    return next
  }

  const chatAt = (chatId: string): number => chats.findIndex((c) => c.id === chatId)
  const editChat = (chatId: string, fn: (chat: UnifiedChat) => boolean): void => {
    const i = chatAt(chatId)
    if (i < 0) return
    const list = own(chats, (a) => [...a])
    const chat = own(list[i], (c) => ({ ...c }))
    if (!fn(chat)) return
    list[i] = chat
    chats = list
    changed.add(chatId)
  }
  const editTurn = (chatId: string, turnId: string, fn: (turn: SharedTurn) => void): void => editChat(chatId, (chat) => {
    const j = chat.turns.findIndex((t) => t.id === turnId)
    if (j < 0) return false
    const turns = own(chat.turns, (a) => [...a])
    const turn = own(turns[j], (t) => ({ ...t }))
    fn(turn)
    turns[j] = turn
    chat.turns = turns
    return true
  })
  const segmentsOf = (turn: SharedTurn): SharedSegment[] => (turn.segments = own(turn.segments ?? [], (a) => [...a]))

  for (const delta of deltas) {
    switch (delta.op) {
      case 'chat': {
        const doc = delta.chat
        const i = chatAt(doc.id)
        const list = own(chats, (a) => [...a])
        if (i >= 0) list[i] = doc
        else list.push(doc)
        chats = list
        changed.add(doc.id)
        break
      }
      case 'remove': {
        const had = chatAt(delta.chatId) >= 0
        if (had) chats = chats.filter((c) => c.id !== delta.chatId)
        const ran = Object.hasOwn(runtime, delta.chatId)
        if (ran) {
          runtime = own(runtime, (r) => ({ ...r }))
          delete runtime[delta.chatId]
        }
        if (had || ran) changed.add(delta.chatId)
        break
      }
      case 'patch':
        editChat(delta.chatId, (chat) => {
          const fields = chat as unknown as Record<string, unknown>
          for (const [key, value] of Object.entries(delta.patch)) {
            if (key === 'turns' || key === 'id') continue
            if (value === null) delete fields[key]
            else fields[key] = value
          }
          return true
        })
        break
      case 'turn':
        editChat(delta.chatId, (chat) => {
          const turns = own(chat.turns, (a) => [...a])
          const j = turns.findIndex((t) => t.id === delta.turn.id)
          if (j >= 0) turns[j] = delta.turn
          else turns.push(delta.turn)
          chat.turns = turns
          return true
        })
        break
      case 'append':
        editTurn(delta.chatId, delta.turnId, (turn) => {
          const segments = segmentsOf(turn)
          const last = segments.at(-1)
          if (last?.kind === delta.kind) segments[segments.length - 1] = { ...last, text: (last.text || '') + delta.text }
          else segments.push({ kind: delta.kind, text: delta.text })
        })
        break
      case 'segment':
        editTurn(delta.chatId, delta.turnId, (turn) => {
          const segments = segmentsOf(turn)
          const i = delta.segment.toolId ? segments.findIndex((s) => s.toolId === delta.segment.toolId) : -1
          if (i >= 0) segments[i] = { ...delta.segment }
          else segments.push({ ...delta.segment })
        })
        break
      case 'metrics':
        editTurn(delta.chatId, delta.turnId, (turn) => { turn.metrics = { ...turn.metrics, ...delta.metrics } })
        break
      case 'runtime': {
        if (delta.runtime === null && !Object.hasOwn(runtime, delta.chatId)) break
        runtime = own(runtime, (r) => ({ ...r }))
        if (delta.runtime === null) delete runtime[delta.chatId]
        else runtime[delta.chatId] = delta.runtime as unknown as R
        changed.add(delta.chatId)
        break
      }
    }
  }
  return { chats, runtime, changed: [...changed] }
}
