import type { SharedSegment, SubagentUpdate } from '../../shared/agents'

interface Origin { id: string; journal: boolean }
interface Child { id: string; parentId?: string; origin: Origin; status: string; turn?: string; segments: Map<string, SharedSegment> }
const STATUSES: Record<string, NonNullable<SubagentUpdate['status']>> = { pendingInit: 'pending', running: 'running', completed: 'completed', errored: 'failed', notFound: 'failed', interrupted: 'stopped', shutdown: 'stopped' }
const statusOf = (status: string): NonNullable<SubagentUpdate['status']> => STATUSES[status] ?? 'pending'

/** Child ownership comes from native spawn edges, never from an arbitrary notification. */
export class CodexSubagents {
  private children = new Map<string, Child>()
  private rootTurns = new Map<string, Origin>()
  constructor(private emit: (origin: Origin, agent: SubagentUpdate) => void, private nativeItem: (item: any, complete: boolean) => SharedSegment | undefined) {}
  belongsTo(id: string, turn: string): boolean { return this.children.get(id)?.origin.id === turn }
  rememberRootTurn(id: string, origin: Origin): void { if (id) this.rootTurns.set(id, { ...origin }) }
  private update(child: Child, patch: Omit<SubagentUpdate, 'id'>): void { this.emit(child.origin, { id: child.id, ...(child.parentId ? { parentId: child.parentId } : {}), ...patch }) }
  private status(child: Child, status: NonNullable<SubagentUpdate['status']>): void { if (child.status !== status) { child.status = status; this.update(child, { status }) } }
  private discover(root: string, parent: string, id: string, origin?: Origin): Child | undefined {
    if (!id || id === root) return undefined
    const existing = this.children.get(id)
    if (existing) return existing
    const owner = parent === root ? origin : this.children.get(parent)?.origin
    if (!owner) return undefined
    const child: Child = { id, ...(parent !== root ? { parentId: parent } : {}), origin: { ...owner }, status: 'pending', segments: new Map() }
    this.children.set(id, child); this.update(child, { status: 'pending' }); return child
  }
  handle(root: string, origin: Origin | undefined, message: any): boolean {
    const p = message.params || {}, method = message.method
    if (p.threadId === root && method === 'turn/started' && origin) this.rememberRootTurn(p.turn?.id, origin)
    if (p.threadId === root && typeof p.turnId === 'string') origin = this.rootTurns.get(p.turnId) || origin
    if (method === 'thread/started') {
      const thread = p.thread, source = thread?.source?.subAgent?.thread_spawn
      if (typeof source?.parent_thread_id === 'string' && typeof thread?.id === 'string') {
        const child = this.discover(root, source.parent_thread_id, thread.id, origin)
        if (child) { this.update(child, { ...(thread.agentNickname || source.agent_nickname || source.agent_path ? { name: thread.agentNickname || source.agent_nickname || source.agent_path } : {}), ...(thread.agentRole || source.agent_role ? { description: thread.agentRole || source.agent_role } : {}) }); return true }
      }
    }
    const thread = p.threadId || '', member = thread === root || this.children.has(thread)
    if (member && ['item/started', 'item/completed'].includes(method) && p.item?.type === 'collabAgentToolCall') {
      const item = p.item, parent = item.senderThreadId === root || this.children.has(item.senderThreadId) ? item.senderThreadId : thread
      for (const id of new Set([...(Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []), ...Object.keys(item.agentsStates || {})])) {
        if (typeof id !== 'string' || item.tool !== 'spawnAgent' && !this.children.has(id)) continue
        const child = this.discover(root, parent, id, origin)
        if (!child) continue
        if (item.tool === 'spawnAgent') this.update(child, { ...(typeof item.id === 'string' ? { spawnToolCallId: item.id } : {}), ...(typeof item.prompt === 'string' ? { description: item.prompt } : {}), ...(typeof item.model === 'string' ? { model: item.model } : {}) })
        const terminalSpawn = item.tool === 'spawnAgent' && ['completed', 'failed', 'stopped'].includes(child.status)
        if (typeof item.agentsStates?.[id]?.status === 'string') {
          const status = statusOf(item.agentsStates[id].status)
          if (!(terminalSpawn && ['pending', 'running'].includes(status))) this.status(child, status)
        } else if (!terminalSpawn && method === 'item/completed' && ['spawnAgent', 'sendInput', 'resumeAgent', 'followupTask'].includes(item.tool)) this.status(child, 'running')
        if (typeof item.agentsStates?.[id]?.message === 'string' && item.agentsStates[id].message) this.update(child, { summary: item.agentsStates[id].message })
      }
    }
    const child = this.children.get(thread)
    if (!child) return false
    if (message.id !== undefined) { this.status(child, 'waiting'); return false }
    const eventTurn = p.turnId || (method === 'turn/completed' ? p.turn?.id : undefined)
    if (eventTurn && child.turn && eventTurn !== child.turn) return true
    if (method === 'turn/started') { child.turn = p.turn?.id; child.segments.clear(); this.status(child, 'running') }
    else if (method === 'thread/status/changed') {
      if (p.status?.type === 'active') this.status(child, p.status.activeFlags?.length ? 'waiting' : 'running')
      else if (p.status?.type === 'systemError') this.status(child, 'failed')
    } else if (['item/started', 'item/completed'].includes(method)) {
      const segment = this.nativeItem(p.item, method === 'item/completed')
      if (segment) { child.segments.set(p.item.id, segment); this.update(child, { segment }) }
    } else if (['item/agentMessage/delta', 'item/reasoning/summaryTextDelta', 'item/reasoning/textDelta', 'item/commandExecution/outputDelta'].includes(method)) {
      const segment = child.segments.get(p.itemId) || { kind: method.includes('reasoning') ? 'thinking' : 'text', text: '', toolId: p.itemId } as SharedSegment
      const next = segment.kind === 'tool' ? { ...segment, result: (segment.result || '') + (p.delta || '') } : { ...segment, text: (segment.text || '') + (p.delta || '') }
      child.segments.set(p.itemId, next); this.update(child, { segment: next })
    } else if (method === 'turn/completed') {
      this.status(child, p.turn?.status === 'failed' ? 'failed' : p.turn?.status === 'interrupted' ? 'stopped' : 'completed')
      if (typeof p.turn?.error?.message === 'string') this.update(child, { summary: p.turn.error.message })
      child.turn = undefined
    } else if (method === 'error') {
      if (p.willRetry === false) this.status(child, 'failed')
      if (typeof p.error?.message === 'string') this.update(child, { summary: p.error.message })
    } else if (method === 'thread/closed') this.status(child, 'stopped')
    return true
  }
  close(): void { for (const child of this.children.values()) if (['pending', 'running', 'waiting'].includes(child.status)) this.status(child, 'stopped') }
}
