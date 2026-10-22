const { test } = require('node:test')
const assert = require('node:assert/strict')
const load = require('./helpers/load-typescript.cjs')
const { createCodexTurnLifecycle } = load('src/main/codexTurnLifecycle.ts')

function fixture() {
  const lifecycle = createCodexTurnLifecycle('root')
  const observe = (method, params) => lifecycle.observe(method, params)
  return { lifecycle, observe,
    start: (threadId = 'root', id = `${threadId}-turn`) => observe('turn/started', { threadId, turn: { id, status: 'inProgress' } }),
    done: (threadId = 'root', id = `${threadId}-turn`, status = 'completed', error) => observe('turn/completed', { threadId, turn: { id, status, error } }),
    thread: (id, parentThreadId = 'root', status = { type: 'idle' }) => observe('thread/started', { thread: { id, parentThreadId, status } }),
    status: (threadId, type) => observe('thread/status/changed', { threadId, status: { type, activeFlags: [] } }),
    item: (item, threadId = 'root', method = 'item/completed') => observe(method, { threadId, item }),
    text: (text = 'Main agent response') => observe('item/agentMessage/delta', { threadId: 'root', delta: text })
  }
}
const collab = (id, tool, states = {}, receivers = Object.keys(states), status = 'completed') => ({
  type: 'collabAgentToolCall', id, tool, status, receiverThreadIds: receivers,
  agentsStates: Object.fromEntries(Object.entries(states).map(([id, status]) => [id, { status, message: null }]))
})
const activity = (id, kind) => ({ type: 'subAgentActivity', agentThreadId: id, kind })

test('a later user task can reuse an established descendant without waiting on all old children',()=>{
 const l=createCodexTurnLifecycle('root',['known','old-completed'])
 l.observe('turn/started',{threadId:'root',turn:{id:'r'}})
 assert.deepEqual(l.pendingAgents,[])
 l.observe('item/completed',{threadId:'root',item:collab('followup','sendInput',{known:'running',stranger:'running'})})
 assert.deepEqual(l.pendingAgents,['known'])
 l.observe('turn/completed',{threadId:'root',turn:{id:'r',status:'completed'}})
 l.observe('turn/started',{threadId:'known',turn:{id:'new-child'}})
 l.observe('turn/completed',{threadId:'known',turn:{id:'new-child',status:'completed'}})
 assert.equal(l.needsContinuation,true)
})

test('a parent completion remains open until the child finishes and native root continuation completes', () => {
  const h = fixture(), l = h.lifecycle
  h.start()
  h.item(collab('spawn', 'spawnAgent', { child: 'running' }))
  h.done()
  assert.equal(l.canFinish, false)
  assert.equal(l.needsContinuation, false)
  h.item(activity('child', 'completed'))
  assert.equal(l.needsContinuation, true)
  assert.equal(l.canFinish, false)
  h.start('root', 'native-continuation')
  assert.equal(l.needsContinuation, false)
  assert.equal(l.rootActive, true)
  h.text()
  h.done('root', 'native-continuation')
  assert.equal(l.canFinish, true)
})

test('acknowledging a host continuation deduplicates wakeups and waits for a new completed turn', () => {
  const h = fixture(), l = h.lifecycle
  h.start()
  h.thread('child')
  h.done()
  h.item(activity('child', 'completed'))
  assert.equal(l.needsContinuation, true)
  l.acknowledgeContinuation()
  assert.equal(l.rootActive, true)
  assert.equal(l.needsContinuation, false)
  assert.equal(l.canFinish, false)
  h.done() // Duplicate completion of the old turn must not undo acknowledgement.
  assert.equal(l.rootActive, true)
  h.start('root', 'host-continuation')
  h.done('root', 'host-continuation')
  assert.equal(l.canFinish, true)
})

test('a root answer without child work finishes normally, and root idle alone never finishes', () => {
  const h = fixture(), l = h.lifecycle
  h.status('root', 'idle')
  assert.equal(l.canFinish, false)
  h.start()
  h.status('root', 'idle')
  assert.equal(l.canFinish, false)
  h.done()
  assert.equal(l.canFinish, true)
  assert.equal(l.needsContinuation, false)
  assert.equal(l.rootTurnId, 'root-turn')
})

test('multiple children and descendants stay pending independently', () => {
  const h = fixture(), l = h.lifecycle
  h.start()
  h.thread('parent')
  h.thread('nested', 'parent')
  h.thread('sibling')
  h.start('parent')
  h.start('nested')
  h.start('sibling')
  h.done()
  h.done('parent')
  h.done('sibling')
  assert.deepEqual(l.pendingAgents, ['nested'])
  assert.equal(l.needsContinuation, false)
  h.done('nested')
  assert.deepEqual(l.pendingAgents, [])
  assert.equal(l.needsContinuation, true)
})

test('parent links can arrive in reverse order without admitting unrelated thread trees', () => {
  const h = fixture(), l = h.lifecycle
  h.thread('nested', 'parent')
  h.thread('foreign', 'unrelated')
  h.thread('parent')
  assert.deepEqual(l.childThreads.sort(), ['nested', 'parent'])
  h.done('foreign')
  assert.deepEqual(l.pendingAgents.sort(), ['nested', 'parent'])
})

test('legacy source subAgent.thread_spawn provides child ancestry when parentThreadId is missing', () => {
  const h = fixture()
  h.observe('thread/started', { thread: { id: 'child', source: { subAgent: { thread_spawn: { parent_thread_id: 'root' } } } } })
  assert.deepEqual(h.lifecycle.childThreads, ['child'])
})

test('completed collab tool calls do not mean their agents are completed', () => {
  const h = fixture(), l = h.lifecycle
  h.start()
  h.item(collab('spawn', 'spawnAgent', { child: 'pendingInit' }))
  h.done()
  assert.deepEqual(l.pendingAgents, ['child'])
  assert.equal(l.canFinish, false)
  assert.equal(l.needsContinuation, false)
})

for (const status of ['completed', 'interrupted', 'errored', 'shutdown', 'notFound']) {
  test(`terminal agent state ${status} requests one continuation after the parent has stopped`, () => {
    const h = fixture(), l = h.lifecycle
    h.start()
    h.item(collab('spawn', 'spawnAgent', { child: 'running' }))
    h.done()
    h.item(collab('wait', 'wait', { child: status }))
    assert.equal(l.needsContinuation, true)
    l.acknowledgeContinuation()
    h.item(collab('wait', 'wait', { child: status }))
    h.start('root', 'resumed')
    h.done('root', 'resumed')
    assert.equal(l.canFinish, true)
    assert.equal(l.needsContinuation, false)
  })
}

for (const status of ['completed', 'failed', 'interrupted']) {
  test(`a child turn ${status} is terminal but does not end the root task`, () => {
    const h = fixture(), l = h.lifecycle
    h.start()
    h.thread('child')
    h.start('child')
    h.done()
    h.done('child', 'child-turn', status)
    assert.equal(l.needsContinuation, true)
    assert.equal(l.canFinish, false)
  })
}

test('a new child turn can finish again after a prior completion was already handled', () => {
  const h = fixture(), l = h.lifecycle
  h.start()
  h.thread('child')
  h.start('child', 'child-1')
  h.done('child', 'child-1')
  h.text()
  h.start('child', 'child-2')
  h.done()
  h.done('child', 'child-1') // Stale completion must not close child-2.
  assert.deepEqual(l.pendingAgents, ['child'])
  h.done('child', 'child-2')
  assert.equal(l.needsContinuation, true)
})

test('a real followup task reopens a completed child; repeated call events cannot revive it', () => {
  const h = fixture(), l = h.lifecycle
  h.start()
  h.item(collab('spawn', 'spawnAgent', { child: 'completed' }))
  h.item(collab('followup', 'followupTask', { child: 'running' }))
  h.done()
  assert.deepEqual(l.pendingAgents, ['child'])
  h.item(activity('child', 'completed'))
  assert.equal(l.needsContinuation, true)
  h.item(collab('followup', 'followupTask', { child: 'running' }))
  assert.deepEqual(l.pendingAgents, [])
})

test('child completed before the root consumes wait output does not cause an extra wakeup', () => {
  const h = fixture(), l = h.lifecycle
  h.start()
  h.thread('child')
  h.item(activity('child', 'completed'))
  h.item(collab('wait', 'wait', { child: 'completed' }))
  h.done()
  assert.equal(l.canFinish, true)
  assert.equal(l.needsContinuation, false)
})

for (const activityKind of ['delta', 'agentMessage', 'commandExecution', 'functionCallOutput']) {
  test(`ordinary root ${activityKind} from the turn already in flight cannot absorb a child completion`, () => {
    const h = fixture(), l = h.lifecycle
    h.start()
    h.thread('child')
    h.item(activity('child', 'completed'))
    if (activityKind === 'delta') h.text()
    else h.item({ type: activityKind, id: 'root-item', text: 'Root response', status: 'completed' })
    h.done()
    assert.equal(l.canFinish, false)
    assert.equal(l.needsContinuation, true)
  })
}

test('a waiting message spanning child completion cannot masquerade as the native continuation', () => {
  const h = fixture(), l = h.lifecycle
  h.start()
  h.thread('child')
  h.item({ type: 'agentMessage', id: 'waiting', text: '' }, 'root', 'item/started')
  h.text('I will wait for the ')
  h.item(activity('child', 'completed'))
  h.text('subagent to finish.')
  h.item({ type: 'agentMessage', id: 'waiting', text: 'I will wait for the subagent to finish.' })
  h.done()
  assert.equal(l.canFinish, false)
  assert.equal(l.needsContinuation, true)
  h.start('root', 'native-continuation')
  h.done('root', 'native-continuation')
  assert.equal(l.canFinish, true)
})

test('a wait must return every unhandled terminal child state before absorbing their completions', () => {
  const h = fixture(), l = h.lifecycle
  h.start()
  h.thread('first')
  h.thread('second')
  h.item(activity('first', 'completed'))
  h.item(activity('second', 'completed'))
  h.item(collab('partial-wait', 'wait', { first: 'completed' }))
  h.done()
  assert.equal(l.needsContinuation, true)
})

test('a completed listAgents result with terminal child states also absorbs the completion', () => {
  const h = fixture(), l = h.lifecycle
  h.start()
  h.thread('child')
  h.item(activity('child', 'completed'))
  h.item(collab('list', 'listAgents', { child: 'completed' }))
  h.done()
  assert.equal(l.canFinish, true)
})

test('root active metadata recovers a native continuation whose turn start was missed', () => {
  const h = fixture(), l = h.lifecycle
  h.start()
  h.thread('child')
  h.done()
  h.item(activity('child', 'completed'))
  assert.equal(l.needsContinuation, true)
  h.status('root', 'active')
  assert.equal(l.rootActive, true)
  assert.equal(l.rootTurnId, undefined)
  assert.equal(l.needsContinuation, false)
  assert.equal(l.canFinish, false)
  h.status('root', 'idle')
  assert.equal(l.canFinish, false)
  h.done('root', 'native-without-start')
  assert.equal(l.canFinish, true)
})

test('duplicate active metadata preserves a known root turn id and cannot consume a later child completion', () => {
  const h = fixture(), l = h.lifecycle
  h.start()
  h.thread('child')
  h.item(activity('child', 'completed'))
  h.status('root', 'active')
  assert.equal(l.rootTurnId, 'root-turn')
  h.done()
  assert.equal(l.needsContinuation, true)
})

test('host continuation accepts completion before the turn start response or notification arrives', () => {
  const h = fixture(), l = h.lifecycle
  h.start()
  h.thread('child')
  h.done()
  h.item(activity('child', 'completed'))
  l.acknowledgeContinuation()
  assert.equal(l.rootTurnId, undefined)
  h.done('root', 'host-without-start')
  assert.equal(l.canFinish, true)
  assert.equal(l.rootTurnId, 'host-without-start')
})

test('pendingInit and spawn registration do not make initial child idle metadata terminal', () => {
  for (const states of [{ child: 'pendingInit' }, {}]) {
    const h = fixture(), l = h.lifecycle
    h.start()
    h.item(collab('spawn', 'spawnAgent', states, ['child']))
    h.done()
    h.status('child', 'idle')
    assert.deepEqual(l.pendingAgents, ['child'])
    assert.equal(l.needsContinuation, false)
    h.status('child', 'active')
    h.status('child', 'idle')
    assert.equal(l.needsContinuation, true)
  }
})

test('failed collab calls without a real agent state cannot create phantom pending agents', () => {
  const h = fixture(), l = h.lifecycle
  h.start()
  h.item(collab('failed-spawn', 'spawnAgent', {}, ['never-created'], 'failed'))
  h.done()
  assert.deepEqual(l.pendingAgents, [])
  assert.deepEqual(l.childThreads, [])
  assert.equal(l.canFinish, true)
})

test('subAgentActivity is a notification and cannot absorb a child completion on the root behalf', () => {
  const h = fixture(), l = h.lifecycle
  h.start()
  h.thread('child')
  h.item(activity('child', 'completed'))
  h.done()
  assert.equal(l.needsContinuation, true)
})

test('child idle is terminal only after that child was active; empty active flags do not finish root', () => {
  const h = fixture(), l = h.lifecycle
  h.start()
  h.thread('child')
  h.status('child', 'idle')
  assert.deepEqual(l.pendingAgents, ['child'])
  h.status('child', 'active')
  h.done()
  h.status('root', 'idle')
  assert.equal(l.needsContinuation, false)
  h.status('child', 'idle')
  assert.equal(l.needsContinuation, true)
})

test('child systemError is terminal, while errors and interrupts on the root finish immediately', () => {
  const h = fixture(), l = h.lifecycle
  h.start()
  h.thread('child')
  h.done()
  h.status('child', 'systemError')
  assert.equal(l.needsContinuation, true)
  for (const status of ['failed', 'interrupted']) {
    const other = fixture(), lifecycle = other.lifecycle
    other.start()
    other.thread('pending')
    other.done('root', 'root-turn', status, { message: 'Provider error' })
    assert.equal(lifecycle.canFinish, true)
    assert.equal(lifecycle.needsContinuation, false)
    assert.equal(lifecycle.interrupted, status === 'interrupted')
    assert.equal(lifecycle.error, status === 'failed' ? 'Provider error' : undefined)
  }
})

test('unrelated thread and item events never create pending work or root activity', () => {
  const h = fixture(), l = h.lifecycle
  h.start('foreign')
  h.item(collab('foreign-spawn', 'spawnAgent', { stranger: 'running' }), 'foreign')
  h.item(activity('stranger', 'completed'), 'foreign')
  h.done('foreign')
  assert.equal(l.rootActive, false)
  assert.deepEqual(l.childThreads, [])
  assert.equal(l.canFinish, false)
})

test('duplicate child completions and old root activity cannot trigger another continuation', () => {
  const h = fixture(), l = h.lifecycle
  h.start()
  h.thread('child')
  h.start('child')
  h.done()
  h.done('child')
  assert.equal(l.needsContinuation, true)
  h.start('root', 'continuation')
  h.done('root', 'continuation')
  h.done('child')
  h.item(activity('child', 'completed'))
  h.start('child') // A duplicate start for an already completed turn is stale.
  h.start('root', 'root-turn')
  assert.equal(l.canFinish, true)
  assert.equal(l.needsContinuation, false)
  assert.deepEqual(l.pendingAgents, [])
})
