const assert = require('node:assert/strict')
const test = require('node:test')
const loadTypescript = require('./helpers/load-typescript.cjs')

const { createHostClaude, hostCommitMessage, CLAUDE_EVENT_CHANNELS, CLAUDE_EVENT_MEMBERS } = loadTypescript('src/shared/host/api/claude.ts')

const tick = () => new Promise((resolve) => setImmediate(resolve))

function fixture({ reject = new Set(), profileChanges } = {}) {
  const notifications = new Map()
  const statusListeners = new Set()
  const calls = []
  const pending = []
  let manual = false
  const client = {
    call(method, params, timeoutMs) {
      calls.push({ method, params, timeoutMs })
      if (reject.has(method)) return Promise.reject(new Error('boom'))
      if (manual && method === 'claude.send') return new Promise((resolve, reject2) => pending.push({ resolve, reject: reject2 }))
      return Promise.resolve({ started: true })
    },
    onNotification(method, listener) { notifications.set(method, listener); return () => notifications.delete(method) },
    onStatus(listener) { statusListeners.add(listener); return () => statusListeners.delete(listener) }
  }
  const ipcCalls = []
  const ipcSubs = []
  const ipc = {}
  for (const name of ['agentSend', 'agentAbort', 'agentInterrupt', 'agentEnd', 'agentRespondPermission', 'agentRespondQuestion']) {
    ipc[name] = (...args) => ipcCalls.push([name, ...args])
  }
  for (const member of CLAUDE_EVENT_MEMBERS) {
    ipc[member] = (cb) => { const rec = { member, cb, off: false }; ipcSubs.push(rec); return () => { rec.off = true } }
  }
  const api = createHostClaude(client, ipc, profileChanges)
  return {
    api, calls, ipcCalls, ipcSubs, pending,
    holdSend: () => { manual = true },
    emit: (channel, data) => notifications.get('claude.event')({ channel, data }),
    status: (state) => { for (const l of [...statusListeners]) l({ state }) }
  }
}

test('events reach subscribers of the right channel, and each subscription also hits IPC', () => {
  assert.equal(CLAUDE_EVENT_MEMBERS.length, 13)
  assert.equal(CLAUDE_EVENT_CHANNELS.onAgentSubagent, 'agent:subagent')
  const f = fixture()
  const got = {}
  for (const member of CLAUDE_EVENT_MEMBERS) {
    got[member] = []
    f.api[member]((d) => got[member].push(d))
  }
  assert.equal(f.ipcSubs.length, 13)
  for (const member of CLAUDE_EVENT_MEMBERS) assert.ok(f.ipcSubs.some((s) => s.member === member))
  for (const member of CLAUDE_EVENT_MEMBERS) f.emit(CLAUDE_EVENT_CHANNELS[member], { member })
  for (const member of CLAUDE_EVENT_MEMBERS) assert.deepEqual(got[member], [{ member }], member)
})

test('unsubscribing undoes both the host listener and the IPC one', () => {
  const f = fixture()
  const seen = []
  const off = f.api.onAgentText((d) => seen.push(d))
  f.emit('agent:text', { n: 1 })
  off()
  f.emit('agent:text', { n: 2 })
  assert.deepEqual(seen, [{ n: 1 }])
  assert.equal(f.ipcSubs.find((s) => s.member === 'onAgentText').off, true)
})

test('events for other channels are not delivered to a listener', () => {
  const f = fixture()
  const seen = []
  f.api.onAgentText((d) => seen.push(d))
  f.emit('agent:thinking', { a: 1 })
  assert.deepEqual(seen, [])
})

test('agentSend with remote goes only to IPC', async () => {
  const f = fixture()
  const payload = { id: 't1', remote: 'ssh', chat: { id: 'c' } }
  f.api.agentSend(payload)
  await tick()
  assert.deepEqual(f.ipcCalls, [['agentSend', payload]])
  assert.equal(f.calls.length, 0)
})

test('local agentSend calls claude.send and the turn events reach listeners', async () => {
  const f = fixture()
  const seen = []
  f.api.onAgentText((d) => seen.push(d.text))
  f.api.agentSend({ id: 't1', chat: { id: 'c' } })
  assert.equal(f.calls[0].method, 'claude.send')
  assert.equal(f.calls[0].timeoutMs, 60000)
  assert.equal(f.ipcCalls.length, 0)
  await tick()
  f.emit('agent:text', { id: 't1', text: 'a' })
  f.emit('agent:text', { id: 't1', text: 'b' })
  assert.deepEqual(seen, ['a', 'b'])
})

test('a rejected claude.send raises agent:error to the renderer', async () => {
  const f = fixture({ reject: new Set(['claude.send']) })
  const errors = []
  f.api.onAgentError((d) => errors.push(d))
  f.api.agentSend({ id: 't1', chat: { id: 'c' } })
  await tick()
  assert.equal(errors.length, 1)
  assert.equal(errors[0].id, 't1')
  assert.match(errors[0].message, /boom/)
})

test('connection drop after the turn began emits agent:error once', async () => {
  const f = fixture()
  const errors = []
  f.api.onAgentError((d) => errors.push(d))
  f.api.agentSend({ id: 't1', chat: { id: 'c' } })
  await tick()
  f.status('connected')
  assert.equal(errors.length, 0)
  f.status('reconnecting')
  assert.equal(errors.length, 1)
  assert.equal(errors[0].id, 't1')
  assert.ok(errors[0].message)
  f.status('disconnected')
  assert.equal(errors.length, 1, 'turn already finished')
})

test('a drop leaves alone turns that ended, never started or still wait for the send reply', async () => {
  const f = fixture()
  const errors = []
  f.api.onAgentError((d) => errors.push(d.id))
  f.api.agentSend({ id: 'done', chat: { id: 'c' } })
  await tick()
  f.emit('agent:done', { id: 'done' })
  f.holdSend()
  f.api.agentSend({ id: 'early', chat: { id: 'c' } })
  f.emit('agent:done', { id: 'early' })
  f.pending[0].resolve({ started: true })
  f.api.agentSend({ id: 'refused', chat: { id: 'c' } })
  f.pending[1].resolve({ started: false })
  f.api.agentSend({ id: 'waiting', chat: { id: 'c' } })
  await tick()
  f.status('reconnecting')
  assert.deepEqual(errors, [])
})

test('control members call IPC and the host; rejected host calls do not throw', async () => {
  const f = fixture({ reject: new Set(['claude.abort', 'claude.interrupt', 'claude.end', 'claude.permissionResponse', 'claude.questionResponse']) })
  const perm = { id: 'a', permId: 'p' }
  const q = { id: 'a', answer: 'x' }
  f.api.agentAbort('a')
  f.api.agentInterrupt('chat')
  f.api.agentEnd('chat')
  f.api.agentRespondPermission(perm)
  f.api.agentRespondQuestion(q)
  await tick()
  assert.deepEqual(f.ipcCalls, [['agentAbort', 'a'], ['agentInterrupt', 'chat'], ['agentEnd', 'chat'], ['agentRespondPermission', perm], ['agentRespondQuestion', q]])
  assert.deepEqual(f.calls.map((c) => [c.method, c.params]), [
    ['claude.abort', { id: 'a' }], ['claude.interrupt', { chatId: 'chat' }], ['claude.end', { chatId: 'chat' }],
    ['claude.permissionResponse', perm], ['claude.questionResponse', q]
  ])
})

test('checkpoint, fork, rewind and available map to host methods', async () => {
  const f = fixture()
  await f.api.agentCheckpointIds('s1')
  await f.api.agentFork({ sessionId: 's1', upToMessageId: 'm' })
  await f.api.agentRewind({ sessionId: 's1', userMessageId: 'u', dryRun: true })
  await f.api.agentAvailable()
  assert.deepEqual(f.calls.map((c) => [c.method, c.params]), [
    ['claude.checkpointIds', { sessionId: 's1' }],
    ['claude.fork', { sessionId: 's1', upToMessageId: 'm' }],
    ['claude.rewind', { sessionId: 's1', userMessageId: 'u', dryRun: true }],
    ['claude.available', undefined]
  ])
})

test('hostCommitMessage uses IPC for remote roots or hosts without claude, else the host', async () => {
  const hostCalls = []
  const ipcCalls = []
  const ipc = async (root, remoteId) => { ipcCalls.push([root, remoteId]); return { ok: true, message: 'ipc' } }
  const client = { call: async (m, p) => { hostCalls.push([m, p]); return { ok: true, message: 'host' } }, serves: () => true }
  const fn = hostCommitMessage(client, ipc)
  assert.equal((await fn('/r')).message, 'host')
  assert.deepEqual(hostCalls, [['claude.commitMessage', { root: '/r' }]])
  assert.equal((await fn('/r', 'ssh1')).message, 'ipc')
  const noClaude = hostCommitMessage({ ...client, serves: (d) => d !== 'claude' }, ipc)
  assert.equal((await noClaude('/x')).message, 'ipc')
  assert.deepEqual(ipcCalls, [['/r', 'ssh1'], ['/x', undefined]])
  assert.equal(hostCalls.length, 1)
})

test('profileChanges: a non-empty id calls claude.profileChanged; empty or non-string ids do not; rejection does not throw', async () => {
  let listener
  const f = fixture({ profileChanges: (l) => { listener = l } })
  listener('acct')
  listener('')
  listener(undefined)
  listener(5)
  assert.deepEqual(f.calls.map((c) => [c.method, c.params]), [['claude.profileChanged', { profileId: 'acct' }]])
  const g = fixture({ reject: new Set(['claude.profileChanged']), profileChanges: (l) => { listener = l } })
  listener('acct')
  await tick()
  assert.equal(g.calls.length, 1)
})

test('profileChanges is optional', () => {
  assert.doesNotThrow(() => fixture())
})
