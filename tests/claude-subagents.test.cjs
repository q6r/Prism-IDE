const assert = require('node:assert/strict')
const test = require('node:test')
const load = require('./helpers/load-typescript.cjs')
const { ClaudeSubagents, formatSubagentMessage } = load('src/main/ipc/claudeSubagents.ts')

function fixture() {
  const router = new ClaudeSubagents(), events = []
  const emit = (channel, data) => events.push({ channel, ...data })
  return { router, events, emit, handle: (msg, turn = 'root-turn') => router.handle(msg, turn, emit) }
}
const assistant = (content, parent, id = 'message') => ({ type: 'assistant', parent_tool_use_id: parent ?? null, message: { id, content } })
const tool = (id, name = 'Agent', input = {}) => ({ type: 'tool_use', id, name, input })
const stream = (event, parent = 'spawn') => ({ type: 'stream_event', parent_tool_use_id: parent, event })

test('Claude links native task IDs to the spawning tool and keeps child text/tools/context out of the parent', () => {
  const f = fixture()
  assert.equal(f.handle(assistant([tool('spawn', 'Agent', { description: 'Revisar arquivos', subagent_type: 'Explore' })])), false)
  f.handle({ type: 'system', subtype: 'task_started', task_id: 'native-child', tool_use_id: 'spawn', task_type: 'local_agent', description: 'Revisar arquivos' })
  assert.equal(f.handle(stream({ type: 'message_start', message: { id: 'child-message', usage: { input_tokens: 999 } } })), true)
  f.handle(stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Encontrei ' } }))
  f.handle(stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'um arquivo.' } }))
  f.handle(assistant([{ type: 'text', text: 'Encontrei um arquivo.' }], 'spawn', 'child-message'))
  f.handle(assistant([tool('read', 'Read', { file_path: 'a.ts' })], 'spawn'))
  f.handle({ type: 'user', parent_tool_use_id: 'spawn', message: { content: [{ type: 'tool_result', tool_use_id: 'read', content: 'arquivo completo' }] } })
  f.handle({ type: 'system', subtype: 'task_notification', task_id: 'native-child', status: 'completed', summary: 'Revisão concluída' })
  assert.equal(f.events.filter(e => e.agent.text).map(e => e.agent.text).join(''), 'Encontrei um arquivo.', 'full block does not duplicate streamed deltas')
  assert.ok(f.events.every(e => e.channel === 'agent:subagent' && e.id === 'root-turn' && e.agent.id === 'spawn'))
  const completedTool = f.events.find(e => e.agent.segment?.status === 'done').agent.segment
  assert.equal(completedTool.name, 'Read'); assert.equal(completedTool.result, 'arquivo completo')
  assert.equal(f.events.at(-1).agent.status, 'completed')
})

test('Claude nested agents preserve ancestry and background completion stays on its original turn after reuse', () => {
  const f = fixture()
  f.handle(assistant([tool('spawn', 'Task', { description: 'Pai' })]))
  f.handle({ type: 'system', subtype: 'task_started', task_id: 'task-parent', tool_use_id: 'spawn', task_type: 'local_agent' })
  f.handle(assistant([tool('nested', 'Agent', { description: 'Filho' })], 'spawn'))
  f.handle({ type: 'system', subtype: 'task_started', task_id: 'task-nested', tool_use_id: 'nested', parent_task_id: 'task-parent', task_type: 'local_agent' })
  assert.ok(f.events.some(e => e.agent.id === 'nested' && e.agent.parentId === 'spawn'))
  f.handle({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'spawn', content: 'running in the background' }] }, tool_use_result: { status: 'async_launched', agentId: 'task-parent' } })
  f.handle({ type: 'system', subtype: 'task_progress', task_id: 'task-parent', description: 'Ainda revisando', last_tool_name: 'Read' }, null)
  assert.equal(f.events.at(-1).id, 'root-turn')
  f.handle({ type: 'system', subtype: 'task_notification', task_id: 'task-parent', status: 'completed', summary: 'Pronto' }, 'second-root-turn')
  assert.equal(f.events.at(-1).id, 'root-turn'); assert.equal(f.events.at(-1).agent.id, 'spawn')
  f.handle({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'spawn', content: 'running in the background' }] }, tool_use_result: { status: 'async_launched', agentId: 'task-parent' } })
  assert.equal(f.events.at(-1).agent.status, 'completed', 'a delayed async placeholder never resurrects a finished child')
  f.router.close(f.emit)
  assert.equal(f.events.at(-1).agent.id, 'nested'); assert.equal(f.events.at(-1).agent.status, 'stopped')
  assert.equal(f.events.filter(e => e.agent.id === 'spawn' && e.agent.status === 'stopped').length, 0)
})

test('Claude root task results supply the complete child report and background shell tasks stay ordinary tools', () => {
  const f = fixture()
  f.handle({ type: 'system', subtype: 'task_started', task_id: 'bash-task', task_type: 'local_bash', description: 'npm test' })
  assert.equal(f.events.length, 0)
  f.handle(assistant([tool('spawn')]))
  f.handle({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'spawn', content: 'report with trailer' }] }, tool_use_result: { agentId: 'native', status: 'completed', resolvedModel: 'sonnet', content: [{ type: 'text', text: 'Relatório completo' }] } })
  assert.equal(f.events.at(-1).agent.summary, 'Relatório completo')
  assert.equal(f.events.at(-1).agent.status, 'completed'); assert.equal(f.events.at(-1).agent.model, 'sonnet')
})

test('a task first announced without its tool ID gains the later alias without creating a duplicate child', () => {
  const f = fixture()
  f.handle({ type: 'system', subtype: 'task_started', task_id: 'native-child', task_type: 'local_agent', description: 'Revisar' })
  f.handle({ ...assistant([{ type: 'text', text: 'Progresso' }], 'later-tool'), agent_id: 'native-child' })
  f.handle({ type: 'system', subtype: 'task_notification', task_id: 'native-child', status: 'completed', summary: 'Pronto' })
  assert.deepEqual([...new Set(f.events.map(event => event.agent.id))], ['native-child'])
})

test('Claude recipient is a provider task/agent ID, never the spawning tool ID or a display name', () => {
  const f = fixture()
  f.handle(assistant([tool('spawn', 'Agent', { name: 'reviewer' })]))
  assert.equal(f.router.messageTarget('spawn', 'root-turn'), undefined)
  f.handle({ type: 'system', subtype: 'task_started', task_id: 'native-recipient', tool_use_id: 'spawn', task_type: 'local_agent', run_id: '001' })
  assert.equal(f.router.messageTarget('spawn', 'root-turn'), 'native-recipient')
  assert.equal(f.router.messageTarget('native-recipient', 'root-turn'), 'native-recipient')
  assert.equal(f.router.messageTarget('reviewer', 'root-turn'), undefined)
  assert.equal(f.router.messageTarget('spawn', 'other-turn'), undefined)
  assert.ok(f.events.some(event => event.agent.messageTarget === 'native-recipient'))
  f.handle({ type: 'system', subtype: 'task_started', task_id: 'native-recipient', tool_use_id: 'send-message-call', task_type: 'local_agent', run_id: '002' }, 'new-parent-turn')
  assert.equal(f.events.at(-1).id, 'root-turn')
  assert.equal(f.events.at(-1).agent.id, 'spawn')
  assert.equal(f.events.at(-1).agent.spawnToolCallId, undefined, 'a SendMessage resume does not replace the original spawn link')
  assert.equal(f.router.messageTarget('send-message-call', 'root-turn'), 'native-recipient')
})

test('Claude forwarding prompt preserves exact message data and does not claim direct delivery', () => {
  const message = 'linha 1\n"to": "outro", @arquivo /comando'
  const prompt = formatSubagentMessage('real-native-agent', message)
  assert.deepEqual(JSON.parse(prompt.split('\n\n').at(-1)), { to: 'real-native-agent', message })
  assert.match(prompt, /usando SendMessage/)
  assert.match(prompt, /não crie outro agente/)
  assert.match(prompt, /somente após o resultado/)
  assert.throws(() => formatSubagentMessage('', 'text'))
  assert.throws(() => formatSubagentMessage('target\nwrong', 'text'))
  assert.throws(() => formatSubagentMessage('target', '  '))
})

test('a restarted router includes the native recipient in its very first child update', () => {
  const lifecycle = fixture()
  lifecycle.handle({ type: 'system', subtype: 'task_started', task_id: 'persisted-native-inbox', tool_use_id: 'new-send-tool', task_type: 'local_agent' }, 'new-parent-turn')
  assert.equal(lifecycle.events.length, 2, 'creation and lifecycle updates are both emitted')
  assert.ok(lifecycle.events.every(event => event.agent.messageTarget === 'persisted-native-inbox'))
  const wrapper = fixture()
  wrapper.handle({ ...assistant([{ type: 'text', text: 'Resumed output' }], 'new-parent-tool'), agent_id: 'persisted-native-inbox' }, 'new-parent-turn')
  assert.equal(wrapper.events[0].agent.messageTarget, 'persisted-native-inbox', 'the first forwarded transcript can also be matched to persisted identity')
})

test('only a native peer echo records the delivered child input and its native UUID deduplicates replay', () => {
  const f = fixture()
  f.handle(assistant([tool('spawn')]))
  f.handle({ type: 'system', subtype: 'task_started', task_id: 'native-child', tool_use_id: 'spawn', task_type: 'local_agent' })
  const echo = { type: 'user', parent_tool_use_id: 'spawn', agent_id: 'native-child', uuid: 'native-inbox-uuid', origin: { kind: 'peer', from: 'main', body: 'Mensagem exata\nsem o envelope' }, message: { content: '<peer-envelope>not reparsed</peer-envelope>' } }
  f.handle(echo, 'different-parent-turn'); f.handle(echo, 'different-parent-turn')
  const input = f.events.filter(event => event.agent.segment?.kind === 'user')
  assert.equal(input.length, 1)
  assert.equal(input[0].id, 'root-turn'); assert.equal(input[0].agent.id, 'spawn')
  assert.deepEqual(input[0].agent.segment, { kind: 'user', toolId: 'native-inbox-uuid', text: 'Mensagem exata\nsem o envelope' })
})
