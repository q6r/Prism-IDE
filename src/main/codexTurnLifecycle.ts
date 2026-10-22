type Fields = Record<string, any>
type Agent = {
  pending: boolean
  active: boolean
  terminal: boolean
  turnId?: string
  completedEpoch?: number
  completedTurns: Set<string>
}

const pendingStatuses = new Set(['pendingInit', 'running'])
const terminalStatuses = new Set(['completed', 'interrupted', 'errored', 'shutdown', 'notFound'])
const activatingTools = new Set(['spawnAgent', 'sendInput', 'resumeAgent', 'followupTask'])

/** Tracks a user task across root turns and the child turns that outlive them. */
export function createCodexTurnLifecycle(rootThreadId: string, knownChildren: Iterable<string> = []) {
  const descendants = new Set(knownChildren)
  const agents = new Map<string, Agent>()
  const parents = new Map<string, string>()
  const threadMetadata = new Map<string, Fields>()
  const activatedCalls = new Set<string>()
  const completedRootTurns = new Set<string>()
  let rootActive = false
  let rootTurnId: string | undefined
  let rootCompleted = false
  let error: string | undefined
  let interrupted = false
  let completionEpoch = 0
  let handledEpoch = 0

  const owned = (id: unknown): id is string => typeof id === 'string' &&
    (id === rootThreadId || agents.has(id))

  const ensureChild = (id: unknown): Agent | undefined => {
    if (typeof id !== 'string' || !id || id === rootThreadId) return undefined
    let agent = agents.get(id)
    if (!agent) {
      agent = { pending: true, active: false, terminal: false, completedTurns: new Set() }
      agents.set(id, agent)
    }
    return agent
  }

  const finishChild = (id: string, turnId?: string): void => {
    const agent = agents.get(id)
    if (!agent) return
    if (turnId) {
      if (agent.completedTurns.has(turnId)) return
      agent.completedTurns.add(turnId)
      if (agent.turnId && agent.turnId !== turnId) return
    }
    if (agent.terminal) return
    agent.pending = false
    agent.active = false
    agent.terminal = true
    agent.completedEpoch = ++completionEpoch
  }

  const startChild = (id: string, turnId?: string, force = false, active = true): void => {
    const agent = agents.get(id)
    if (!agent || (turnId && agent.completedTurns.has(turnId))) return
    if (agent.terminal && !force && (!turnId || turnId === agent.turnId)) return
    if (turnId) agent.turnId = turnId
    agent.pending = true
    agent.active = active || agent.active && !agent.terminal
    agent.terminal = false
  }

  const applyChildStatus = (id: string, status: Fields | undefined): void => {
    const agent = agents.get(id)
    if (!agent) return
    if (status?.type === 'active') startChild(id, undefined, true)
    else if (status?.type === 'systemError' || (status?.type === 'idle' && agent.active)) finishChild(id)
  }

  const adoptLinkedChildren = (): void => {
    let changed = true
    while (changed) {
      changed = false
      for (const [id, parent] of parents) {
        if (id === rootThreadId || agents.has(id) || !owned(parent)) continue
        ensureChild(id)
        applyChildStatus(id, threadMetadata.get(id)?.status)
        changed = true
      }
    }
  }

  const isCurrentRootTurn = (params: Fields): boolean => (!params.turnId ||
    !completedRootTurns.has(params.turnId)) && (!params.turnId || !rootTurnId || params.turnId === rootTurnId)

  const observeItem = (method: string, params: Fields): void => {
    const source = params.threadId
    const item = params.item
    if (!owned(source) || !item) return
    if (item.type === 'collabAgentToolCall') {
      const states = item.agentsStates && typeof item.agentsStates === 'object' ? item.agentsStates : {}
      const ids = new Set<string>([
        ...(Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.filter((id: unknown) => typeof id === 'string') : []),
        ...Object.keys(states)
      ])
      const callKey = typeof item.id === 'string' ? `${source}:${item.id}` : undefined
      const activating = activatingTools.has(item.tool) && item.status !== 'failed' && item.status !== 'interrupted' &&
        !!callKey && !activatedCalls.has(callKey)
      if (activating) activatedCalls.add(callKey!)
      for (const id of ids) {
        // A wait/list can mention unrelated threads. Only spawn establishes an
        // ownership edge; later calls may update children already discovered.
        if (item.tool !== 'spawnAgent' && !agents.has(id) && !descendants.has(id)) continue
        if ((item.status === 'failed' || item.status === 'interrupted') && !agents.has(id) && !states[id]) continue
        if (!ensureChild(id)) continue
        if (!parents.has(id)) parents.set(id, source)
        if (activating) startChild(id, undefined, true, false)
        if (pendingStatuses.has(states[id]?.status)) startChild(id, undefined, false, states[id].status === 'running')
        else if (terminalStatuses.has(states[id]?.status)) finishChild(id)
      }
      adoptLinkedChildren()
      if (source === rootThreadId && rootActive && isCurrentRootTurn(params) &&
        method === 'item/completed' && item.status === 'completed' &&
        (item.tool === 'wait' || item.tool === 'listAgents')) {
        // A completed wait/list result proves the root received these states.
        // Text finishing after a child notification can still belong to an
        // earlier "I will wait" response, so ordinary output is not proof.
        const everyCompletionReturned = [...agents].every(([id, agent]) =>
          !agent.completedEpoch || agent.completedEpoch <= handledEpoch || terminalStatuses.has(states[id]?.status))
        if (everyCompletionReturned) handledEpoch = completionEpoch
      }
    } else if (item.type === 'subAgentActivity') {
      const id = item.agentThreadId
      if (!ensureChild(id)) return
      if (!parents.has(id)) parents.set(id, source)
      if (item.kind === 'started') startChild(id, undefined, true, false)
      else if (item.kind === 'interacted') startChild(id, undefined, false, false)
      else if (item.kind === 'completed' || item.kind === 'interrupted') finishChild(id)
      adoptLinkedChildren()
      // This is a notification *to* the root, not evidence the root consumed it.
      return
    }

  }

  return {
    observe(method: string, params: Fields): void {
      if (method === 'thread/started') {
        const thread = params.thread
        if (!thread || typeof thread.id !== 'string' || thread.id === rootThreadId) return
        const parent = thread.parentThreadId || thread.source?.subAgent?.thread_spawn?.parent_thread_id
        if (typeof parent !== 'string') return
        parents.set(thread.id, parent)
        threadMetadata.set(thread.id, thread)
        adoptLinkedChildren()
        return
      }
      if (!owned(params.threadId)) return
      if (method === 'turn/started') {
        const id = params.turn?.id
        if (typeof id !== 'string') return
        if (params.threadId !== rootThreadId) startChild(params.threadId, id, true)
        else if (!completedRootTurns.has(id)) {
          rootTurnId = id
          rootActive = true
          rootCompleted = false
          error = undefined
          interrupted = false
          handledEpoch = completionEpoch
        }
      } else if (method === 'turn/completed') {
        const turn = params.turn
        if (!turn || typeof turn.id !== 'string' || !['completed', 'failed', 'interrupted'].includes(turn.status)) return
        if (params.threadId !== rootThreadId) finishChild(params.threadId, turn.id)
        else if (!completedRootTurns.has(turn.id) && (!rootActive || !rootTurnId || rootTurnId === turn.id)) {
          completedRootTurns.add(turn.id)
          rootTurnId = turn.id
          rootActive = false
          rootCompleted = true
          error = turn.status === 'failed' ? turn.error?.message || 'Falha no Codex.' : undefined
          interrupted = turn.status === 'interrupted'
        }
      } else if (method === 'thread/status/changed') {
        if (params.threadId !== rootThreadId) applyChildStatus(params.threadId, params.status)
        else if (params.status?.type === 'systemError') {
          error = 'A conversa do Codex encontrou um erro no App Server.'
          rootActive = false
          rootCompleted = true
        }
        else if (params.status?.type === 'active' && !rootActive) {
          // A metadata read can recover a missed native turn/started. Repeated
          // active snapshots during that turn must preserve its known id and
          // cannot consume child completions that arrived while it was running.
          rootActive = true
          rootCompleted = false
          rootTurnId = undefined
          error = undefined
          interrupted = false
          handledEpoch = completionEpoch
        }
      } else if (method === 'item/started' || method === 'item/completed') {
        observeItem(method, params)
      } else if (method === 'thread/closed') {
        if (params.threadId !== rootThreadId) finishChild(params.threadId)
        else {
          error = 'A conversa do Codex foi encerrada antes de concluir a tarefa.'
          rootActive = false
          rootCompleted = true
        }
      }
    },
    get rootActive(): boolean { return rootActive },
    get rootTurnId(): string | undefined { return rootTurnId },
    get pendingAgents(): string[] { return [...agents].filter(([, agent]) => agent.pending).map(([id]) => id) },
    get childThreads(): string[] { return [...agents.keys()] },
    childState(id: string): string | undefined {
      const agent = agents.get(id)
      return agent && JSON.stringify([agent.pending, agent.active, agent.turnId, agent.completedEpoch])
    },
    get canFinish(): boolean {
      return rootCompleted && (!!error || interrupted || ![...agents.values()].some(agent => agent.pending) && completionEpoch === handledEpoch)
    },
    get needsContinuation(): boolean {
      return rootCompleted && !error && !interrupted && !rootActive &&
        ![...agents.values()].some(agent => agent.pending) && completionEpoch > handledEpoch
    },
    get error(): string | undefined { return error },
    get interrupted(): boolean { return interrupted },
    acknowledgeContinuation(): void {
      handledEpoch = completionEpoch
      rootActive = true
      rootCompleted = false
      rootTurnId = undefined
      error = undefined
      interrupted = false
    }
  }
}
