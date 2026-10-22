const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const load = require('./helpers/load-typescript.cjs')

const lifecycle = load('src/main/ipc/claudeTurnLifecycle.ts')
const flush = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve)) }
const until = async (predicate, label) => {
  for (let i = 0; i < 30; i++) {
    if (predicate()) return
    await flush()
  }
  throw new Error(`Timed out waiting for ${label}`)
}
const system = (subtype, fields = {}) => ({ type: 'system', subtype, ...fields })
const init = () => system('init', { session_id: 'native-session', model: 'mock-model', tools: [] })
const state = value => system('session_state_changed', { state: value })
const started = id => system('task_started', { task_id: id, task_type: 'local_agent', is_backgrounded: true })
const notification = id => system('task_notification', { task_id: id, status: 'completed' })
const result = text => ({ type: 'result', subtype: 'success', session_id: 'native-session', result: text, num_turns: 1 })
const delta = (text, fields = {}) => ({ type: 'stream_event', event: {
  type: 'content_block_delta', delta: { type: 'text_delta', text }
}, ...fields })
const payload = fields => ({ id: 'turn-a', prompt: 'Original task', cwd: '/workspace',
  model: 'mock-model', permissionMode: 'acceptEdits', ...fields })

// Drive the real handler one SDK message at a time. This fake consumes the real
// input pump, so ending stdin at an interim result is observable without models.
function fakeQuery(args) {
  const pending = [], queue = []
  let stopped = false, failure
  const q = {
    args, inputs: [], inputDone: false, returnCalls: 0, interruptCalls: 0,
    [Symbol.asyncIterator]() { return this },
    next() {
      if (queue.length) return Promise.resolve({ value: queue.shift(), done: false })
      if (failure) return Promise.reject(failure)
      if (stopped) return Promise.resolve({ done: true })
      return new Promise((resolve, reject) => pending.push({ resolve, reject }))
    },
    push(...messages) {
      if (stopped) return
      for (const message of messages) {
        const waiter = pending.shift()
        if (waiter) waiter.resolve({ value: message, done: false })
        else queue.push(message)
      }
    },
    finish() {
      stopped = true
      for (const waiter of pending.splice(0)) waiter.resolve({ done: true })
    },
    fail(error) {
      stopped = true
      failure = error
      queue.length = 0
      for (const waiter of pending.splice(0)) waiter.reject(error)
    },
    return() {
      q.returnCalls++
      q.finish()
      return Promise.resolve({ done: true })
    },
    interrupt() { q.interruptCalls++; q.push({ type: 'result', subtype: 'interrupted' }) },
    setModel() {}, setPermissionMode() {}
  }
  q.inputTask = (async () => {
    assert.equal(typeof args.prompt, 'object', 'SDK input must remain a streaming prompt')
    assert.equal(typeof args.prompt[Symbol.asyncIterator], 'function')
    for await (const message of args.prompt) q.inputs.push(message)
    q.inputDone = true
  })()
  args.options.abortController.signal.addEventListener('abort', () => q.fail(new Error('Aborted fake query')), { once: true })
  return q
}

function fakeChannel() {
  const channel = Object.assign(new EventEmitter(), {
    stderr: new EventEmitter(), writes: [], ends: 0, signals: [],
    write(value) { this.writes.push(JSON.parse(value)); return true },
    end() { this.ends++ },
    signal(value) { this.signals.push(value) }
  })
  channel.json = (...messages) => channel.emit('data', Buffer.from(messages.map(message => JSON.stringify(message)).join('\n') + '\n'))
  return channel
}

function harness({ remote = false } = {}) {
  const handlers = new Map(), events = [], queries = [], commands = [], channels = []
  const ipcMain = { on: (name, fn) => handlers.set(name, fn), handle: (name, fn) => handlers.set(name, fn) }
  const app = new EventEmitter()
  const sender = Object.assign(new EventEmitter(), { id: 7, isDestroyed: () => false,
    send: (channel, event) => events.push({ channel, ...event }) })
  const client = { exec(command, options, callback) {
    if (typeof options === 'function') {
      const stream = fakeChannel()
      options(null, stream)
      queueMicrotask(() => { stream.emit('data', Buffer.from('/usr/local/bin/claude\n')); stream.emit('close', 0) })
      return
    }
    commands.push(command)
    const stream = fakeChannel()
    channels.push(stream)
    callback(null, stream)
  } }
  const module = load('src/main/ipc/claudeAgent.ts', {
    '../../shared/providerUsage': load('src/shared/providerUsage.ts'),
    electron: { ipcMain, app },
    child_process: { execSync: () => Buffer.from('/mock/claude\n'), spawn: () => { throw new Error('Unexpected real CLI spawn') } },
    fs: { existsSync: () => false },
    'fs/promises': { readdir: async () => [], readFile: async () => '' },
    os: { homedir: () => '/mock/home' }, path: require('node:path'),
    '../providers': { profileEnvironment: () => ({ MOCK_CLAUDE: '1' }), providerCommand: () => null },
    './ssh': { getSshClient: () => remote ? client : null, matchesSshTarget: () => true },
    './claudeTurnLifecycle': lifecycle,
    './claudeSubagents': load('src/main/ipc/claudeSubagents.ts'),
    '@anthropic-ai/claude-agent-sdk': { query: args => {
      const q = fakeQuery(args)
      queries.push(q)
      return q
    } }
  })
  module.registerClaudeAgentHandlers()
  const dispatch = (name, value) => handlers.get(name)({ sender }, value)
  const send = value => dispatch('agent:send', payload(value))
  const on = channel => events.filter(event => event.channel === channel)
  const start = async value => {
    const completion = send(value)
    await until(() => remote ? channels.length : queries.length, 'query startup')
    return { q: queries[0], channel: channels[0], completion }
  }
  return { events, queries, channels, commands, dispatch, send, on, start }
}

test('single-shot handler keeps input open through background completion and returns only the final root answer', { timeout: 4000 }, async () => {
  const h = harness(), { q, completion } = await h.start({ contextNote: 'Context for this task' })
  q.push(init(), state('running'), started('agent-a'), delta('I will wait'), result('Waiting for the subagent'))
  await flush()
  assert.deepEqual(q.inputs.map(message => message.message.content), ['Original task\n\nContext for this task'])
  assert.equal(q.inputDone, false)
  assert.equal(q.returnCalls, 0)
  assert.equal(h.on('agent:result').length, 0)
  assert.equal(h.on('agent:done').length, 0)

  q.push(notification('agent-a'), init(), delta('Private child text', { parent_tool_use_id: 'child-tool' }),
    { type: 'assistant', parent_tool_use_id: 'child-tool', message: { content: [{ type: 'tool_use', id: 'private-tool', name: 'Read', input: {} }] } },
    delta('Final answer after checking the child output'), result('Final consolidated answer'))
  await flush()
  assert.equal(h.on('agent:result').length, 0, 'The final result must still wait for authoritative idle')
  assert.equal(q.returnCalls, 0)
  q.push(state('idle'))
  await completion
  await q.inputTask

  assert.deepEqual(h.on('agent:text').map(event => event.text), ['I will wait', 'Final answer after checking the child output'])
  assert.equal(h.on('agent:tool').length, 0, 'Child tools must not appear as root tool calls')
  assert.deepEqual(h.on('agent:result').map(event => event.resultText), ['Final consolidated answer'])
  assert.equal(h.on('agent:done').length, 1)
  assert.equal(h.on('agent:error').length, 0)
  assert.equal(q.returnCalls, 1, 'Close the SDK iterator only after the final answer')
  assert.equal(q.inputDone, true)
  assert.equal(h.queries.length, 1, 'Continuation must use the existing query without synthetic user input')
})

test('aborting while a single-shot handler awaits its subagent completes once and ignores late child output', { timeout: 4000 }, async () => {
  const h = harness(), { q, completion } = await h.start()
  q.push(init(), state('running'), started('agent-a'), result('Waiting'))
  await flush()
  h.dispatch('agent:abort', 'turn-a')
  await completion
  await q.inputTask
  q.push(notification('agent-a'), delta('Must not resume'), result('Must not finish again'), state('idle'))
  await flush()
  assert.equal(q.args.options.abortController.signal.aborted, true)
  assert.deepEqual(h.on('agent:done').map(({ id, aborted }) => ({ id, aborted })), [{ id: 'turn-a', aborted: true }])
  assert.equal(h.on('agent:result').length, 0)
  assert.equal(h.on('agent:text').length, 0)
  assert.equal(h.on('agent:error').length, 0)
  assert.equal(h.queries.length, 1)
  assert.equal(q.inputs.length, 1)
})

test('streaming handler preserves one turn across automatic continuation, then opens a new turn for the next user input', { timeout: 4000 }, async () => {
  const h = harness(), { q } = await h.start({ chatId: 'chat-a' })
  q.push(init(), state('running'), started('agent-a'), delta('Waiting'), result('Interim'))
  await flush()
  assert.equal(h.on('agent:turn-start').length, 1)
  const firstId = h.on('agent:turn-start')[0].id
  assert.equal(h.on('agent:done').length, 0)
  assert.equal(h.on('agent:result').length, 0)

  q.push(notification('agent-a'), init(), delta('Child secret', { parent_tool_use_id: 'child-tool' }),
    delta('Resumed root answer'), result('Consolidated'))
  await flush()
  assert.equal(h.on('agent:turn-start').length, 1, 'Repeated init during continuation must keep the existing bubble')
  assert.equal(h.on('agent:result').length, 0)
  q.push(state('idle'))
  await flush()
  assert.deepEqual(h.on('agent:text').map(({ id, text }) => ({ id, text })), [
    { id: firstId, text: 'Waiting' }, { id: firstId, text: 'Resumed root answer' }
  ])
  assert.deepEqual(h.on('agent:result').map(({ id, chatId, resultText }) => ({ id, chatId, resultText })), [
    { id: firstId, chatId: 'chat-a', resultText: 'Consolidated' }
  ])
  assert.deepEqual(h.on('agent:done').map(event => event.id), [firstId])
  assert.equal(q.inputDone, false, 'A streaming chat remains available after its completed turn')
  assert.equal(q.returnCalls, 0)

  await h.send({ chatId: 'chat-a', id: 'next-user-message', prompt: 'Next user task' })
  await flush()
  assert.equal(h.queries.length, 1)
  assert.deepEqual(q.inputs.map(message => message.message.content), ['Original task', 'Next user task'])
  q.push(init(), state('running'), delta('Second answer'), result('Second final'), state('idle'))
  await flush()
  assert.equal(h.on('agent:turn-start').length, 2)
  const secondId = h.on('agent:turn-start')[1].id
  assert.notEqual(secondId, firstId)
  assert.deepEqual(h.on('agent:done').map(event => event.id), [firstId, secondId])
  h.dispatch('agent:end', 'chat-a')
  await q.inputTask
  await flush()
  assert.equal(h.on('agent:done').length, 2, 'Ending an idle session must not add another completion')
})

test('legacy CLI result without pending subagents still finishes the single-shot query', { timeout: 4000 }, async () => {
  const h = harness(), { q, completion } = await h.start()
  q.push(init(), delta('Legacy answer'), result('Legacy final'))
  await completion
  await q.inputTask
  assert.deepEqual(h.on('agent:result').map(event => event.resultText), ['Legacy final'])
  assert.equal(h.on('agent:done').length, 1)
  assert.equal(q.returnCalls, 1)
})

test('SSH stream keeps stdin open through subagent completion and waits for remote close after final idle', { timeout: 4000 }, async () => {
  const h = harness({ remote: true }), { channel, completion } = await h.start({ remote: 'remote-a' })
  assert.equal(h.queries.length, 0, 'Remote execution must not start the local SDK')
  assert.equal(h.commands.length, 1)
  assert.deepEqual(channel.writes.map(message => message.message.content), [[{ type: 'text', text: 'Original task' }]])
  channel.json(init(), state('running'), started('agent-a'), result('Waiting'))
  assert.equal(channel.ends, 0)
  assert.equal(h.on('agent:result').length, 0)
  assert.equal(h.on('agent:done').length, 0)
  channel.json(notification('agent-a'), delta('Private remote child', { parent_tool_use_id: 'child-tool' }),
    delta('Resumed remote root'), result('Final remote answer'))
  assert.equal(channel.ends, 0)
  assert.equal(h.on('agent:result').length, 0)
  channel.json(state('idle'))
  assert.equal(channel.ends, 1)
  assert.deepEqual(h.on('agent:result').map(event => event.resultText), ['Final remote answer'])
  assert.equal(h.on('agent:done').length, 0, 'Keep the UI busy until the remote process has closed')
  channel.emit('close', 0)
  await completion
  assert.deepEqual(h.on('agent:text').map(event => event.text), ['Resumed remote root'])
  assert.equal(h.on('agent:done').length, 1)
  assert.equal(h.on('agent:error').length, 0)
})

test('aborting SSH while waiting must not publish late automatic continuation after done', { timeout: 4000 }, async () => {
  const h = harness({ remote: true }), { channel, completion } = await h.start({ remote: 'remote-a' })
  channel.json(init(), state('running'), started('agent-a'), result('Waiting'))
  h.dispatch('agent:abort', 'turn-a')
  await completion
  assert.deepEqual(channel.signals, ['TERM'])
  assert.deepEqual(h.on('agent:done').map(({ id, aborted }) => ({ id, aborted })), [{ id: 'turn-a', aborted: true }])
  channel.json(notification('agent-a'), delta('Late unwanted continuation'), result('Late answer'), state('idle'))
  channel.emit('close', 0)
  assert.equal(h.on('agent:text').length, 0)
  assert.equal(h.on('agent:result').length, 0)
  assert.equal(h.on('agent:done').length, 1)
})
