import type { RunMetrics, SharedSegment, SharedTurn, SubagentUpdate, UnifiedChat } from './agents'
import { routeKey } from './agents'
import { subagentLink } from './subagents'

export type JournalEvent =
  | { kind: 'begin'; turn: SharedTurn; route: string }
  | { kind: 'text' | 'thinking'; text: string }
  | { kind: 'metrics'; metrics: RunMetrics }
  | { kind: 'segment'; segment: SharedSegment }
  | { kind: 'subagent'; agent: SubagentUpdate; recordedAt?: number }
  | { kind: 'session'; sessionId: string }
  | { kind: 'done'; aborted?: boolean; at?: number }
  /** `code`: why, when the provider said (`cli_auth`: the login is gone); kept as the turn's `errorCode`. */
  | { kind: 'error'; message: string; at?: number; code?: string }

export function foldJournal(chat: UnifiedChat, records: { turnId: string; event: JournalEvent }[]): UnifiedChat {
  let resume = chat.resume, pendingTurnId = chat.pendingTurnId
  const turns = new Map<string, SharedTurn>(), routes = new Map<string, string>()
  for (const { turnId, event: ev } of records) {
    if (ev.kind === 'begin') { turns.set(turnId, { ...ev.turn, segments: [] }); routes.set(turnId, ev.route); continue }
    const turn = turns.get(turnId)
    if (!turn) continue
    const current = chat.lastRunId === turnId && routeKey(chat.selection) === routes.get(turnId)
    if (ev.kind === 'text' || ev.kind === 'thinking') {
      const last = turn.segments?.at(-1)
      if (last?.kind === ev.kind) last.text = (last.text || '') + ev.text
      else turn.segments!.push({ kind: ev.kind, text: ev.text })
    } else if (ev.kind === 'metrics') turn.metrics = { ...turn.metrics, ...ev.metrics }
    else if (ev.kind === 'segment') {
      const i = ev.segment.toolId ? turn.segments!.findIndex((s) => s.toolId === ev.segment.toolId) : -1
      if (i >= 0) turn.segments![i] = { ...ev.segment }
      else turn.segments!.push({ ...ev.segment })
    } else if (ev.kind === 'subagent' && !ev.agent.parentId) {
      const index = turn.segments!.findIndex(segment => segment.subagent?.id === ev.agent.id)
      const segment = subagentLink(chat.id, ev.agent, turn.segments![index], ev.recordedAt ?? turn.startedAt)
      if (index >= 0) turn.segments![index] = segment
      else turn.segments!.push(segment)
    } else if (ev.kind === 'session' && current) resume = { route: routes.get(turnId)!, sessionId: ev.sessionId }
    else if (ev.kind === 'done' || ev.kind === 'error') {
      turn.completedAt = ev.at || turn.completedAt
      if (turn.startedAt && turn.completedAt) turn.durationMs = Math.max(0, turn.completedAt - turn.startedAt)
      turn.error = ev.kind === 'error'
      turn.interrupted = ev.kind === 'done' && !!ev.aborted
      if (ev.kind === 'error' && ev.code) turn.errorCode = ev.code
      if (ev.kind === 'error') turn.segments!.push({ kind: 'text', text: ev.message })
      turn.segments = turn.segments!.map((s) => !s.subagent && (s.status === 'running' || s.status === 'awaiting')
        ? { ...s, status: turn.error || turn.interrupted ? 'error' : 'done' } : s)
      if (chat.pendingTurnId === turnId) pendingTurnId = undefined
      if (current && (turn.error || turn.interrupted)) resume = undefined
    }
  }
  return { ...chat, resume, pendingTurnId, turns: chat.turns.map((t) => turns.get(t.id) || t) }
}
