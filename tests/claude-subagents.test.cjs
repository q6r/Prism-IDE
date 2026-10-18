const assert = require('node:assert/strict')
const test = require('node:test')
const load = require('./helpers/load-typescript.cjs')
const { ClaudeSubagents } = load('src/main/ipc/claudeSubagents.ts')

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
