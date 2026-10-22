type Message = Record<string, any>

const terminalStatuses = new Set(['completed', 'failed', 'stopped', 'killed'])

function activity(message: Message): boolean {
  return message.ambient !== true && message.skip_transcript !== true
}

function pendingAgent(task: Message): boolean {
  if (!activity(task) || task.is_backgrounded === false || terminalStatuses.has(task.status)) return false
  return task.task_type === 'local_agent' || task.task_type === 'subagent' ||
    task.task_type === 'local_workflow' || typeof task.subagent_type === 'string' || task.task_type === undefined
}

/** A result may yield to background agents. Only publish the root's final result. */
export function createClaudeTurnLifecycle(): {
  observe: (message: Message) => Message | undefined
  reset: () => void
} {
  let completed = false
  let sessionState: string | undefined
  let hasSnapshot = false
  let lastResult: Message | undefined
  const tasks = new Map<string, Message>()
  // Keep ended run IDs so a late bookend cannot revive a completed task.
  const runs = new Map<string, string>()
  const ended = new Set<string>()
  const finish = (): Message | undefined => {
    if (!lastResult) return undefined
    completed = true
    const result = lastResult
    lastResult = undefined
    return result
  }
  return {
    observe(message) {
      if (completed || !activity(message)) return undefined
      const taskSignal = message.type === 'system' && ['task_started', 'task_updated', 'task_notification', 'background_tasks_changed'].includes(message.subtype)
      if (typeof message.parent_tool_use_id === 'string' && !taskSignal) return undefined
      const rootContent = message.type === 'assistant' || (message.type === 'stream_event' &&
        ['message_start', 'content_block_start', 'content_block_delta'].includes(message.event?.type))
      if (rootContent || (message.type === 'system' && message.subtype === 'init')) lastResult = undefined
      if (message.type === 'system') {
        if (message.subtype === 'session_state_changed') {
          sessionState = message.state
          // The native protocol emits idle after its background-agent loop exits.
          if (sessionState === 'idle') return finish()
        } else if (message.subtype === 'background_tasks_changed' && Array.isArray(message.tasks)) {
          hasSnapshot = true
          tasks.clear()
          for (const task of message.tasks) {
            if (task && typeof task.task_id === 'string' && pendingAgent(task)) tasks.set(task.task_id, task)
          }
        } else if (!hasSnapshot && typeof message.task_id === 'string') {
          const id = message.task_id
          const run = typeof message.run_id === 'string' ? message.run_id : undefined
          const previousRun = runs.get(id)
          if (run && previousRun && run < previousRun) return undefined
          if (run && run !== previousRun) { runs.set(id, run); ended.delete(id) }
          if (message.subtype === 'task_started' && !ended.has(id)) tasks.set(id, message)
          else if (message.subtype === 'task_notification' && terminalStatuses.has(message.status)) {
            tasks.delete(id); ended.add(id)
          } else if (message.subtype === 'task_updated' && tasks.has(id)) {
            const updated = { ...tasks.get(id), ...message.patch }
            if (terminalStatuses.has(updated.status)) { tasks.delete(id); ended.add(id) }
            else tasks.set(id, updated)
          }
        }
        // A child completion is not the parent's answer: keep reading it.
        return undefined
      }
      if (message.type !== 'result') return undefined
      lastResult = message
      if (message.is_error || message.subtype !== 'success') return finish()
      if (sessionState === undefined && ![...tasks.values()].some(pendingAgent)) return finish()
      return undefined
    },
    reset() {
      completed = false; sessionState = undefined; hasSnapshot = false; lastResult = undefined
      tasks.clear(); runs.clear(); ended.clear()
    }
  }
}
