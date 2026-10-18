/** Claude's child frames must never become output or context of the main agent. */
type Frame = Record<string, any>
type Emit = (channel: string, payload: unknown) => void
type Child = { id: string; turn: string; parentId?: string; status: string }
type StreamBlock = { kind: string; text: string; consumed?: boolean }

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.filter(b => b?.type === 'text').map(b => b.text ?? '').join('')
  return ''
}

/** Kept for the lifetime of one CLI process, including background work between turns. */
export class ClaudeSubagents {
  private aliases = new Map<string, string>()
  private children = new Map<string, Child>()
  private streams = new Map<string, Map<number, StreamBlock>>()
  private messages = new Map<string, string>()
  private tools = new Map<string, Frame>()
  private runs = new Map<string, string>()

  private child(nativeId: string, turn: string | null | undefined, emit: Emit, metadata: Frame = {}): Child | undefined {
    const id = this.aliases.get(nativeId) ?? nativeId
    let child = this.children.get(id)
    if (!child && turn) {
      child = { id, turn, parentId: metadata.parentId, status: 'running' }
      this.children.set(id, child)
      this.update(child, { status: 'running', ...metadata }, emit)
    }
    return child
  }

  private update(child: Child, update: Frame, emit: Emit): void {
    if (update.status) child.status = update.status
    emit('agent:subagent', { id: child.turn, agent: { id: child.id, ...(child.parentId ? { parentId: child.parentId } : {}), ...update } })
  }

  private spawn(block: Frame, parent: Child | undefined, turn: string | null | undefined, emit: Emit): void {
    if (!['Agent', 'Task'].includes(block.name) || typeof block.id !== 'string') return
    const input = block.input ?? {}
    const existing = this.child(block.id, parent?.turn ?? turn, emit, {
      ...(parent ? { parentId: parent.id } : {}),
      spawnToolCallId: block.id,
      name: input.name || input.subagent_type || 'Claude',
      description: input.description || input.prompt || 'Subagente',
      ...(input.model ? { model: input.model } : {})
    })
    if (existing) this.aliases.set(block.id, existing.id)
  }

  /** True means the frame belongs solely to a child/lifecycle and is fully consumed. */
  handle(msg: Frame, turn: string | null | undefined, emit: Emit): boolean {
    if (msg.type === 'system' && ['task_started', 'task_progress', 'task_notification', 'task_updated'].includes(msg.subtype)) {
      if (msg.ambient || msg.skip_transcript) return true
      const native = msg.tool_use_id || msg.task_id
      if (typeof native !== 'string' || !native) return true
      // Shell/monitor tasks use the same envelope and are not separate agents.
      const known = this.aliases.has(native) || this.children.has(native) || this.aliases.has(msg.task_id)
      if (!known && !['local_agent', 'subagent'].includes(msg.task_type) && !msg.subagent_type) return true
      const parentId = this.aliases.get(msg.parent_task_id) ?? (this.children.has(msg.parent_task_id) ? msg.parent_task_id : undefined)
      const child = this.child(native, turn, emit, { ...(parentId ? { parentId } : {}), ...(msg.subagent_type ? { name: msg.subagent_type } : {}), ...(msg.description ? { description: msg.description } : {}) })
      if (!child) return true
      if (msg.task_id) this.aliases.set(msg.task_id, child.id)
      if (msg.tool_use_id) this.aliases.set(msg.tool_use_id, child.id)
      const previousRun = this.runs.get(child.id)
      if (msg.run_id && previousRun && msg.run_id < previousRun) return true
      if (msg.run_id) this.runs.set(child.id, msg.run_id)
      const patch = msg.patch ?? {}
      const status = msg.subtype === 'task_notification' ? msg.status : patch.status
      const update: Frame = {}
      if (status) update.status = status === 'killed' ? 'stopped' : status === 'paused' ? 'waiting' : status
      else if (msg.subtype === 'task_started' || !['completed', 'failed', 'stopped'].includes(child.status)) update.status = 'running'
      if (msg.tool_use_id) update.spawnToolCallId = msg.tool_use_id
      if (msg.description || patch.description) update.description = msg.description || patch.description
      if (msg.summary || patch.error) update.summary = msg.summary || patch.error
      if (msg.last_tool_name) update.description = `${msg.description || 'Trabalhando'} · ${msg.last_tool_name}`
      this.update(child, update, emit)
      return true
    }

    const parentTool = typeof msg.parent_tool_use_id === 'string' ? msg.parent_tool_use_id : undefined
    const alias = typeof msg.agent_id === 'string' ? this.aliases.get(msg.agent_id) : undefined
    const knownParent = parentTool && (this.aliases.has(parentTool) || this.children.has(parentTool))
    const native = knownParent ? parentTool : alias || parentTool
    const child = native ? this.child(native, turn, emit, { ...(msg.subagent_type ? { name: msg.subagent_type } : {}), ...(msg.task_description ? { description: msg.task_description } : {}) }) : undefined
    if (child && msg.agent_id) this.aliases.set(msg.agent_id, child.id)
    if (child && parentTool) this.aliases.set(parentTool, child.id)

    if (msg.type === 'assistant') {
      for (const block of msg.message?.content ?? []) this.spawn(block, child, turn, emit)
    }

    if (msg.type === 'user') {
      for (const block of msg.message?.content ?? []) {
        if (block.type !== 'tool_result') continue
        const spawnedId = this.aliases.get(block.tool_use_id) ?? block.tool_use_id
        const spawned = this.children.get(spawnedId)
        const output = msg.tool_use_result ?? {}
        if (spawned) {
          if (output.agentId) this.aliases.set(output.agentId, spawned.id)
          const background = output.status === 'async_launched' || output.isAsync || /running in the background|launched successfully|agent is running/i.test(contentText(block.content))
          this.update(spawned, {
            status: block.is_error ? 'failed' : background ? ['completed', 'failed', 'stopped'].includes(spawned.status) ? spawned.status : 'running' : 'completed',
            ...(output.resolvedModel ? { model: output.resolvedModel } : {}),
            ...(!background ? { summary: contentText(output.content) || contentText(block.content) } : {})
          }, emit)
        }
      }
    }
    if (!child) return !!parentTool

    if (msg.type === 'stream_event') {
      const ev = msg.event ?? {}
      if (ev.type === 'message_start' && ev.message?.id) this.messages.set(child.id, ev.message.id)
      const message = this.messages.get(child.id) || ''
      const streamKey = `${child.id}:${message}`
      if (!this.streams.has(streamKey)) this.streams.set(streamKey, new Map())
      const blocks = this.streams.get(streamKey)!
      if (ev.type === 'content_block_delta') {
        const kind = ev.delta?.type === 'text_delta' ? 'text' : ev.delta?.type === 'thinking_delta' ? 'thinking' : undefined
        if (kind) {
          const text = kind === 'text' ? ev.delta.text : ev.delta.thinking
          const previous = blocks.get(ev.index ?? 0) ?? { kind, text: '' }
          previous.text += text ?? ''; blocks.set(ev.index ?? 0, previous)
          if (text) this.update(child, { [kind]: text }, emit)
        }
      }
    } else if (msg.type === 'assistant') {
      for (const block of msg.message?.content ?? []) {
        if (block.type === 'text' || block.type === 'thinking') {
          const text = block.type === 'text' ? block.text : block.thinking
          const blocks = this.streams.get(`${child.id}:${msg.message?.id || ''}`)
          const streamed = [...(blocks?.values() ?? [])].find(b => !b.consumed && b.kind === block.type && typeof text === 'string' && text.startsWith(b.text))
          if (streamed) streamed.consumed = true
          const rest = streamed ? text.slice(streamed.text.length) : text
          if (rest) this.update(child, { [block.type]: rest }, emit)
        } else if (block.type === 'tool_use') {
          const segment = { kind: 'tool', toolId: block.id, name: block.name, input: block.input, status: 'running' }
          this.tools.set(block.id, segment)
          this.update(child, { segment }, emit)
        }
      }
    } else if (msg.type === 'user') {
      for (const block of msg.message?.content ?? []) {
        if (block.type !== 'tool_result') continue
        const previous = this.tools.get(block.tool_use_id) ?? { kind: 'tool', toolId: block.tool_use_id, name: 'Ferramenta' }
        const segment = { ...previous, status: block.is_error ? 'error' : 'done', result: contentText(block.content), resultIsError: !!block.is_error }
        this.tools.set(block.tool_use_id, segment)
        this.update(child, { segment }, emit)
      }
    }
    return true
  }

  close(emit: Emit): void {
    for (const child of this.children.values()) {
      if (!['completed', 'failed', 'stopped'].includes(child.status)) this.update(child, { status: 'stopped' }, emit)
    }
  }
}
