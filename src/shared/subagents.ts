import type { SharedSegment, SharedTurn, SubagentInfo, SubagentStatus, SubagentUpdate, UnifiedChat } from './agents'

export const subagentChatId = (rootChatId: string, nativeId: string): string => `subagent:${rootChatId}:${nativeId}`
export const subagentTurnId = (rootTurnId: string, nativeId: string): string => `subagent:${rootTurnId}:${nativeId}`
export const subagentActive = (status: SubagentStatus): boolean => ['pending', 'running', 'waiting'].includes(status)

function snippet(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(-240)
}

/** One stable card, independent of the parent turn's completion. */
export function subagentLink(rootChatId: string, update: SubagentUpdate, previous?: SharedSegment, at = Date.now()): SharedSegment {
  const old = previous?.subagent
  const status = update.status ?? old?.status ?? 'running'
  const segment = update.segment
  const activity = segment?.kind === 'tool' ? [segment.name, typeof segment.input === 'string' ? segment.input : ''].filter(Boolean).join(' · ')
    : snippet(segment?.text || update.text || update.thinking || '')
  const info: SubagentInfo = {
    ...old, id: update.id, chatId: subagentChatId(rootChatId, update.id), name: update.name || old?.name || 'Agente',
    status, startedAt: old?.startedAt ?? at, updatedAt: at,
    ...(update.description ? { description: update.description } : {}),
    ...(update.model ? { model: update.model } : {}),
    ...(update.spawnToolCallId ? { spawnToolCallId: update.spawnToolCallId } : {}),
    ...(activity ? { activity } : {}),
    ...(update.summary !== undefined ? { summary: update.summary.slice(0, 16000) } : {})
  }
  return { kind: 'tool', toolId: `subagent:${update.id}`, name: 'Agent',
    status: subagentActive(status) ? status === 'waiting' ? 'awaiting' : 'running' : status === 'failed' || status === 'stopped' ? 'error' : 'done',
    subagent: info }
}

function replaceSegment(segments: readonly SharedSegment[], segment: SharedSegment): SharedSegment[] {
  const index = segment.toolId ? segments.findIndex(s => s.toolId === segment.toolId) : -1
  return index < 0 ? [...segments, segment] : segments.map((s, i) => i === index ? segment : s)
}

function append(segments: SharedSegment[], kind: 'text' | 'thinking', text?: string): SharedSegment[] {
  if (!text) return segments
  const last = segments.at(-1)
  return last?.kind === kind ? [...segments.slice(0, -1), { ...last, text: (last.text || '') + text }] : [...segments, { kind, text }]
}

/** IPC fallback: the host engine applies the same projection to its journal. */
export function projectSubagent(chats: readonly UnifiedChat[], rootChatId: string, rootTurnId: string, update: SubagentUpdate, at = Date.now()): UnifiedChat[] {
  const root = chats.find(c => c.id === rootChatId)
  const origin = root?.turns.find(t => t.id === rootTurnId && t.role === 'assistant')
  if (!root || !origin || !update.id || update.id === update.parentId) return []
  const childId = subagentChatId(rootChatId, update.id)
  const before = chats.find(c => c.id === childId)
  if (before?.nativeAgent && before.nativeAgent.rootTurnId !== rootTurnId) return []
  const parentId = before?.nativeAgent ? before.nativeAgent.parentId : update.parentId
  const parent = parentId ? chats.find(c => c.id === subagentChatId(rootChatId, parentId)) : root
  if (parentId && (!parent?.nativeAgent || parent.nativeAgent.rootTurnId !== rootTurnId)) return []
  const parentTurnId = parentId ? subagentTurnId(rootTurnId, parentId) : rootTurnId
  const parentTurn = parent?.turns.find(t => t.id === parentTurnId)
  const oldLink = parentTurn?.segments?.find(s => s.subagent?.id === update.id)
  const link = subagentLink(rootChatId, update, oldLink, at)
  const info = link.subagent!
  const turnId = subagentTurnId(before?.nativeAgent?.rootTurnId ?? rootTurnId, update.id)
  const childTurn: SharedTurn = before?.turns.find(t => t.id === turnId) ?? {
    id: turnId, role: 'assistant', text: '', segments: [], startedAt: at,
    provider: origin.provider ?? root.selection.provider, profileName: origin.profileName, model: update.model || origin.model || root.selection.model
  }
  let segments = append(append([...(childTurn.segments || [])], 'text', update.text), 'thinking', update.thinking)
  if (update.segment) segments = replaceSegment(segments, update.segment)
  const result = update.summary?.trim()
  if (result && !subagentActive(info.status) && !segments.some(s => s.kind === 'text' && s.text?.includes(result))) segments.push({ kind: 'text', text: result })
  const active = subagentActive(info.status)
  if (!active) segments = segments.map(segment => !segment.subagent && (segment.status === 'running' || segment.status === 'awaiting')
    ? { ...segment, status: info.status === 'completed' ? 'done' : 'error' } : segment)
  const turn: SharedTurn = { ...childTurn, segments, ...(update.model ? { model: update.model } : {}),
    ...(active ? { completedAt: undefined, durationMs: undefined, error: false, interrupted: false }
      : { completedAt: childTurn.completedAt ?? at, durationMs: Math.max(0, (childTurn.completedAt ?? at) - (childTurn.startedAt ?? at)),
        error: info.status === 'failed', interrupted: info.status === 'stopped' }) }
  const child: UnifiedChat = {
    ...(before ?? { id: childId, cwd: root.cwd, taskId: root.taskId, createdAt: at, turns: [], selection: { ...(origin.selection ?? root.selection), provider: turn.provider ?? root.selection.provider } }),
    selection: { ...(before?.selection ?? origin.selection ?? root.selection), provider: turn.provider ?? root.selection.provider, model: turn.model ?? root.selection.model },
    title: info.name === 'Agente' ? (info.description || 'Subagente').slice(0, 100) : info.name,
    readOnly: true, sourceHarness: turn.provider, parentChatId: parentId ? subagentChatId(rootChatId, parentId) : rootChatId,
    nativeAgent: { id: update.id, rootChatId, rootTurnId: before?.nativeAgent?.rootTurnId ?? rootTurnId, ...(parentId ? { parentId } : {}),
      status: info.status, name: info.name, description: info.description, summary: info.summary, updatedAt: at },
    pendingTurnId: active ? turnId : undefined, updatedAt: at,
    turns: before?.turns.some(t => t.id === turnId) ? before.turns.map(t => t.id === turnId ? turn : t) : [...(before?.turns || []), turn]
  }
  if (!parent || !parentTurn) return [child]
  return [child, { ...parent, turns: parent.turns.map(t => t.id === parentTurnId ? { ...t, segments: replaceSegment(t.segments || [], link) } : t) }]
}

/** Persisted child sessions cannot survive the process that owned them. */
export function stoppedSubagents(chats: readonly UnifiedChat[]): UnifiedChat[] {
  return chats.map(chat => {
    const native = chat.nativeAgent
    return { ...chat,
      ...(native && subagentActive(native.status) ? { nativeAgent: { ...native, status: 'stopped' as const } } : {}),
      turns: chat.turns.map(turn => ({ ...turn, segments: turn.segments?.map(segment => segment.subagent && subagentActive(segment.subagent.status)
        ? { ...segment, status: 'error' as const, subagent: { ...segment.subagent, status: 'stopped' as const } } : segment) })) }
  })
}
