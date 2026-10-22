const { test } = require('node:test')
const assert = require('node:assert/strict')
const load = require('./helpers/load-typescript.cjs')
const { createClaudeTurnLifecycle } = load('src/main/ipc/claudeTurnLifecycle.ts')

const system = (subtype, fields = {}) => ({ type: 'system', subtype, ...fields })
const state = (value) => system('session_state_changed', { state: value })
const started = (id, fields = {}) => system('task_started', { task_id: id, task_type: 'local_agent', ...fields })
const notification = (id, status = 'completed', fields = {}) => system('task_notification', { task_id: id, status, ...fields })
const snapshot = (tasks) => system('background_tasks_changed', { tasks })
const task = (id, fields = {}) => ({ task_id: id, task_type: 'local_agent', ...fields })
const result = (text = 'done', fields = {}) => ({ type: 'result', subtype: 'success', result: text, ...fields })
const assistant = (fields = {}) => ({ type: 'assistant', message: { content: [{ type: 'text', text: 'continuing' }] }, ...fields })
const delta = (fields = {}) => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'continuing' } }, ...fields })

test('an interim result stays open through task completion and the main agent automatic continuation', () => {
  const lifecycle = createClaudeTurnLifecycle()
  const interim = result('I will wait'), final = result('Reviewed the subagent output')
  for (const message of [state('running'), started('a'), interim, notification('a'), assistant(), final]) {
    assert.equal(lifecycle.observe(message), undefined)
  }
  assert.equal(lifecycle.observe(state('idle')), final)
  assert.equal(lifecycle.observe(state('idle')), undefined)
  assert.equal(lifecycle.observe(final), undefined)
})

test('session idle after a successful result is authoritative even before the final task snapshot', () => {
  const lifecycle = createClaudeTurnLifecycle(), final = result()
  lifecycle.observe(state('running'))
  lifecycle.observe(snapshot([task('still-in-snapshot')]))
  assert.equal(lifecycle.observe(final), undefined)
  assert.equal(lifecycle.observe(state('idle')), final)
})

test('idle before a result cannot complete a later result without a new idle', () => {
  const lifecycle = createClaudeTurnLifecycle(), final = result()
  assert.equal(lifecycle.observe(state('idle')), undefined)
  assert.equal(lifecycle.observe(final), undefined)
  assert.equal(lifecycle.observe(state('requires_action')), undefined)
  assert.equal(lifecycle.observe(state('idle')), final)
})

test('multiple interim results return only the latest result at idle', () => {
  const lifecycle = createClaudeTurnLifecycle(), final = result('latest')
  lifecycle.observe(state('running'))
  lifecycle.observe(result('first'))
  lifecycle.observe(result('second'))
  lifecycle.observe(final)
  assert.equal(lifecycle.observe(state('idle')), final)
})

for (const continuation of [assistant(), delta(), { type: 'stream_event', event: { type: 'message_start' } }, system('init')]) {
  test(`a root ${continuation.type}/${continuation.subtype || continuation.event?.type || 'message'} invalidates an interim result`, () => {
    const lifecycle = createClaudeTurnLifecycle(), final = result('new final')
    lifecycle.observe(state('running'))
    lifecycle.observe(result('old interim'))
    lifecycle.observe(continuation)
    assert.equal(lifecycle.observe(state('idle')), undefined)
    assert.equal(lifecycle.observe(final), undefined)
    assert.equal(lifecycle.observe(state('idle')), final)
  })
}

test('subagent content and nested init/result cannot replace or invalidate the main result', () => {
  const lifecycle = createClaudeTurnLifecycle(), final = result('root result')
  lifecycle.observe(state('running'))
  lifecycle.observe(final)
  for (const message of [assistant(), delta(), system('init'), result('nested')]) {
    assert.equal(lifecycle.observe({ ...message, parent_tool_use_id: 'tool-parent' }), undefined)
  }
  assert.equal(lifecycle.observe(state('idle')), final)
})

test('a legacy successful result without pending agents finishes immediately, exactly once', () => {
  const lifecycle = createClaudeTurnLifecycle(), final = result()
  assert.equal(lifecycle.observe(final), final)
  assert.equal(lifecycle.observe(final), undefined)
  assert.equal(lifecycle.observe(notification('unknown')), undefined)
})

test('legacy multiple and nested agents remain pending until every agent finishes and a new main result arrives', () => {
  const lifecycle = createClaudeTurnLifecycle(), final = result('all agents reviewed')
  lifecycle.observe(started('parent'))
  lifecycle.observe(started('child', { parent_task_id: 'parent', parent_tool_use_id: 'parent-tool', spawn_depth: 2 }))
  lifecycle.observe(started('sibling'))
  assert.equal(lifecycle.observe(result('waiting')), undefined)
  assert.equal(lifecycle.observe(notification('parent')), undefined)
  assert.equal(lifecycle.observe(notification('sibling')), undefined)
  assert.equal(lifecycle.observe(result('still waiting')), undefined)
  assert.equal(lifecycle.observe(notification('child', 'completed', { parent_tool_use_id: 'parent-tool' })), undefined)
  lifecycle.observe(delta())
  assert.equal(lifecycle.observe(final), final)
})

for (const status of ['completed', 'failed', 'stopped']) {
  test(`a legacy ${status} notification releases its task without completing the old result`, () => {
    const lifecycle = createClaudeTurnLifecycle(), final = result()
    lifecycle.observe(started('a'))
    lifecycle.observe(result('waiting'))
    assert.equal(lifecycle.observe(notification('a', status)), undefined)
    assert.equal(lifecycle.observe(final), final)
  })
}

test('legacy agents without task_type, explicit subagent types, and workflows block interim completion', () => {
  for (const fields of [{ task_type: undefined }, { task_type: 'custom', subagent_type: 'reviewer' }, { task_type: 'local_workflow' }]) {
    const lifecycle = createClaudeTurnLifecycle(), final = result()
    lifecycle.observe(started('work', fields))
    assert.equal(lifecycle.observe(result('waiting')), undefined)
    lifecycle.observe(notification('work'))
    assert.equal(lifecycle.observe(final), final)
  }
})

test('background shells, servers, foreground agents, and ambient tasks cannot hold a legacy turn open', () => {
  const lifecycle = createClaudeTurnLifecycle(), final = result()
  for (const fields of [{ task_type: 'local_bash' }, { task_type: 'local_server' }, { is_backgrounded: false }, { ambient: true }, { skip_transcript: true }]) {
    lifecycle.observe(started(JSON.stringify(fields), fields))
  }
  assert.equal(lifecycle.observe(final), final)
})

test('a legacy foreground agent moved to background is tracked; a terminal update removes it', () => {
  const lifecycle = createClaudeTurnLifecycle(), final = result()
  lifecycle.observe(started('a', { is_backgrounded: false }))
  lifecycle.observe(system('task_updated', { task_id: 'a', patch: { is_backgrounded: true } }))
  assert.equal(lifecycle.observe(result('waiting')), undefined)
  lifecycle.observe(system('task_updated', { task_id: 'a', patch: { status: 'killed' } }))
  assert.equal(lifecycle.observe(final), final)
})

test('a late notification for an older run cannot release a resumed legacy agent', () => {
  const lifecycle = createClaudeTurnLifecycle(), final = result()
  lifecycle.observe(started('a', { run_id: '002' }))
  lifecycle.observe(notification('a', 'completed', { run_id: '001' }))
  assert.equal(lifecycle.observe(result('waiting')), undefined)
  lifecycle.observe(notification('a', 'completed', { run_id: '002' }))
  assert.equal(lifecycle.observe(final), final)
})

test('snapshots replace task membership and ignore all later task edges regardless of ordering', () => {
  const lifecycle = createClaudeTurnLifecycle(), final = result()
  lifecycle.observe(started('stale'))
  lifecycle.observe(snapshot([task('a'), task('nested', { parent_task_id: 'a' })]))
  lifecycle.observe(notification('a'))
  lifecycle.observe(notification('nested'))
  assert.equal(lifecycle.observe(result('snapshot still has active agents')), undefined)
  assert.equal(lifecycle.observe(snapshot([])), undefined)
  lifecycle.observe(started('a'))
  lifecycle.observe(started('nested'))
  lifecycle.observe(started('stale'))
  assert.equal(lifecycle.observe(final), final)
})

test('a snapshot arriving before a task start cannot be overwritten by the edge stream', () => {
  const lifecycle = createClaudeTurnLifecycle(), final = result()
  lifecycle.observe(snapshot([]))
  lifecycle.observe(started('late-edge'))
  assert.equal(lifecycle.observe(final), final)
})

test('snapshot activity excludes ambient work and shells while preserving workflow and agent work', () => {
  const lifecycle = createClaudeTurnLifecycle(), final = result()
  lifecycle.observe(snapshot([
    task('ambient', { ambient: true }), task('hidden', { skip_transcript: true }),
    task('shell', { task_type: 'local_bash' }), task('workflow', { task_type: 'local_workflow' }), task('agent')
  ]))
  assert.equal(lifecycle.observe(result('waiting')), undefined)
  lifecycle.observe(snapshot([task('ambient', { ambient: true }), task('shell', { task_type: 'local_bash' })]))
  assert.equal(lifecycle.observe(final), final)
})

test('ambient and skipped messages do not invalidate a result or signal session completion', () => {
  const lifecycle = createClaudeTurnLifecycle(), final = result()
  lifecycle.observe(state('running'))
  lifecycle.observe(final)
  for (const flags of [{ ambient: true }, { skip_transcript: true }]) {
    lifecycle.observe({ ...assistant(), ...flags })
    lifecycle.observe({ ...system('init'), ...flags })
    assert.equal(lifecycle.observe({ ...state('idle'), ...flags }), undefined)
  }
  assert.equal(lifecycle.observe(state('idle')), final)
})

for (const fields of [{ is_error: true }, { subtype: 'error_during_execution' }, { subtype: 'error_max_turns' }, { subtype: 'interrupted' }]) {
  test(`an error or stopped result ${JSON.stringify(fields)} finishes immediately with pending agents`, () => {
    const lifecycle = createClaudeTurnLifecycle(), stopped = result('stopped', fields)
    lifecycle.observe(state('running'))
    lifecycle.observe(started('a'))
    assert.equal(lifecycle.observe(stopped), stopped)
    assert.equal(lifecycle.observe(state('idle')), undefined)
  })
}

test('reset clears completion, capability detection, results, snapshots and previous pending tasks', () => {
  const lifecycle = createClaudeTurnLifecycle(), first = result('first'), second = result('second')
  lifecycle.observe(state('running'))
  lifecycle.observe(snapshot([task('old')]))
  lifecycle.observe(first)
  lifecycle.reset()
  assert.equal(lifecycle.observe(second), second)
  lifecycle.reset()
  lifecycle.observe(started('new'))
  assert.equal(lifecycle.observe(result('waiting')), undefined)
  lifecycle.observe(notification('new'))
  assert.equal(lifecycle.observe(result('third')).result, 'third')
})


test('late task starts and old run notifications cannot resurrect completed runs', () => {
  const lifecycle = createClaudeTurnLifecycle(), final = result()
  lifecycle.observe(started('a', { run_id: '002' }))
  lifecycle.observe(notification('a', 'completed', { run_id: '002' }))
  lifecycle.observe(started('a', { run_id: '001' }))
  lifecycle.observe(started('a', { run_id: '002' }))
  assert.equal(lifecycle.observe(final), final)
})

test('a newer resumed run remains pending after an older completion', () => {
  const lifecycle = createClaudeTurnLifecycle(), final = result()
  lifecycle.observe(started('a', { run_id: '001' }))
  lifecycle.observe(notification('a', 'completed', { run_id: '001' }))
  lifecycle.observe(started('a', { run_id: '002' }))
  lifecycle.observe(notification('a', 'completed', { run_id: '001' }))
  assert.equal(lifecycle.observe(final), undefined)
  lifecycle.observe(notification('a', 'completed', { run_id: '002' }))
  assert.equal(lifecycle.observe(final), final)
})
