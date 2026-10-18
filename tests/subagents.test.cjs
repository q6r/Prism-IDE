const test = require('node:test')
const assert = require('node:assert/strict')
const load = require('./helpers/load-typescript.cjs')
const subagents = load('src/shared/subagents.ts')
const { projectSubagent, subagentChatId, stoppedSubagents } = subagents
const { foldJournal } = load('src/shared/agentJournal.ts', { './agents': load('src/shared/agents.ts'), './subagents': subagents })
const root = () => ({ id: 'root', title: 'Parent', cwd: 'C:\\QA', taskId: 'task', updatedAt: 1,
  selection: { provider: 'codex', profileId: 'work', model: 'model', effort: 'high', permissionMode: 'default' },
  turns: [{ id: 'first', role: 'assistant', text: '', provider: 'codex', model: 'actual-model', startedAt: 100, segments: [] }] })
function fixture() {
  let chats = [root()]
  return { get chats() { return chats }, update(agent, turn = 'first', at = 200) {
    const changes = projectSubagent(chats, 'root', turn, agent, at)
    const changed = new Map(changes.map(chat => [chat.id, chat]))
    chats = [...chats.map(chat => changed.get(chat.id) ?? chat), ...changes.filter(chat => !chats.some(c => c.id === chat.id))]
    return changes
  }, get(nativeId) { return chats.find(chat => chat.id === subagentChatId('root', nativeId)) } }
}
test('native child snapshots preserve output, nesting and parent links without mixing transcripts', () => {
  const f = fixture()
  f.update({ id: 'a', name: 'Explore', description: 'Inspect code', spawnToolCallId: 'spawn', status: 'running' })
  f.update({ id: 'a', text: 'Reading ' })
  f.update({ id: 'a', text: 'files' })
  f.update({ id: 'a', segment: { kind: 'tool', toolId: 'read', name: 'Read', status: 'running' } })
  f.update({ id: 'a', segment: { kind: 'tool', toolId: 'read', name: 'Read', status: 'done', result: 'contents' } })
  f.update({ id: 'nested', parentId: 'a', name: 'Tests', text: 'Nested output' })
  const child = f.get('a'), nested = f.get('nested')
  assert.equal(child.parentChatId, 'root'); assert.equal(nested.parentChatId, child.id)
  assert.equal(child.taskId, 'task'); assert.equal(child.readOnly, true); assert.equal(child.turns[0].model, 'actual-model')
  assert.equal(child.turns[0].segments[0].text, 'Reading files')
  assert.equal(child.turns[0].segments.filter(s => s.toolId === 'read').length, 1)
  assert.equal(child.turns[0].segments.find(s => s.toolId === 'read').result, 'contents')
  assert.equal(child.turns[0].segments.at(-1).subagent.chatId, nested.id)
  f.update({ id: 'a', segment: { kind: 'tool', toolId: 'pending', name: 'Bash', status: 'running' } })
  f.update({ id: 'a', status: 'completed' })
  assert.equal(f.get('a').turns[0].segments.find(s => s.toolId === 'pending').status, 'done')
  assert.equal(f.get('a').turns[0].segments.find(s => s.subagent).subagent.status, 'running')
  const parentSegments = f.chats[0].turns[0].segments
  assert.equal(parentSegments.length, 1); assert.equal(parentSegments[0].subagent.spawnToolCallId, 'spawn')
  assert.ok(!JSON.stringify(parentSegments).includes('Nested output'))
})
test('late completion targets the creating turn; a repeated summary is not duplicated', () => {
  const f = fixture()
  f.update({ id: 'a', text: 'Final output' })
  f.chats[0].turns[0].completedAt = 250
  f.chats[0].turns.push({ id: 'second', role: 'assistant', text: '', segments: [], startedAt: 300 })
  f.update({ id: 'a', status: 'completed', summary: 'Final output' }, 'first', 400)
  assert.equal(f.chats[0].turns[0].segments[0].subagent.status, 'completed')
  assert.deepEqual(f.chats[0].turns[1].segments, [])
  assert.deepEqual(f.update({ id: 'a', status: 'running', text: 'Wrong turn' }, 'second'), [])
  assert.deepEqual(f.update({ id: 'orphan', parentId: 'missing', text: 'Orphan' }), [])
  assert.equal(f.get('a').turns[0].segments.length, 1)
  assert.equal(f.get('a').turns[0].completedAt, 400)
  assert.equal(f.get('a').pendingTurnId, undefined)
  assert.deepEqual(f.update({ id: 'unrelated', text: 'foreign' }, 'missing'), [])
})
test('parent completion leaves background cards active and journal completion updates that same card', () => {
  const chat = root()
  const records = [
    { turnId: 'first', event: { kind: 'begin', turn: chat.turns[0], route: 'codex:work' } },
    { turnId: 'first', event: { kind: 'subagent', agent: { id: 'a', status: 'running' }, recordedAt: 200 } },
    { turnId: 'first', event: { kind: 'done', at: 250 } }
  ]
  assert.equal(foldJournal(chat, records).turns[0].segments[0].status, 'running')
  records.push({ turnId: 'first', event: { kind: 'subagent', agent: { id: 'a', status: 'completed', summary: 'Done' }, recordedAt: 400 } })
  const segments = foldJournal(chat, records).turns[0].segments
  assert.equal(segments.length, 1); assert.equal(segments[0].subagent.status, 'completed')
})
test('restarting an IPC renderer marks stale native activity as stopped', () => {
  const f = fixture(); f.update({ id: 'a', status: 'running' })
  const restored = stoppedSubagents(f.chats)
  assert.equal(restored[0].turns[0].segments[0].subagent.status, 'stopped')
  assert.equal(restored[1].nativeAgent.status, 'stopped')
  assert.equal(f.get('a').nativeAgent.status, 'running', 'input documents remain immutable')
})
