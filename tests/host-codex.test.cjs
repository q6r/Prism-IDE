const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const loadTypescript = require('./helpers/load-typescript.cjs')

const { createHostCodex, hostCodexPrompts, createHostCodexQueries, CODEX_DROPPED } = loadTypescript('src/shared/host/api/codex.ts')
const routing = loadTypescript('src/shared/host/routing.ts')

function setup() {
  const calls = []
  const pending = []
  const notifications = new Map()
  const statusListeners = []
  const client = {
    call(method, params, timeout) {
      const entry = { method, params, timeout }
      calls.push(entry)
      return new Promise((resolve, reject) => pending.push({ resolve, reject }))
    },
    onNotification(method, listener) {
      if (!notifications.has(method)) notifications.set(method, new Set())
      notifications.get(method).add(listener)
      return () => notifications.get(method).delete(listener)
    },
    onStatus(listener) { statusListeners.push(listener); return () => {} }
  }
  const ipcLog = []
  const ipcListeners = new Set()
  const ipc = {
    send: (p) => ipcLog.push(['send', p]),
    abort: (...a) => ipcLog.push(['abort', ...a]),
    permission: (...a) => ipcLog.push(['permission', ...a]),
    question: (...a) => ipcLog.push(['question', ...a]),
    onEvent: (cb) => { ipcListeners.add(cb); return () => ipcListeners.delete(cb) }
  }
  let profileCb = null
  const bridge = {
    onProfileChanged: (cb) => { profileCb = cb; return () => {} }
  }
  const host = createHostCodex(client, ipc, bridge)
  const notify = (method, params) => { for (const l of [...(notifications.get(method) ?? [])]) l(params) }
  const status = (state) => statusListeners.forEach((l) => l({ state }))
  const tick = () => new Promise((r) => setImmediate(r))
  return { host, client, calls, pending, notify, status, ipcLog, ipcListeners, tick, profile: (id) => profileCb(id) }
}

const payload = (extra = {}) => ({ id: 't1', chatId: 'c1', cwd: '/x', prompt: 'hi', selection: { provider: 'codex' }, ...extra })

test('send calls codex.send without chat, with the 60s timeout', () => {
  const t = setup()
  t.host.send(payload({ chat: { id: 'c1' } }))
  assert.equal(t.calls.length, 1)
  assert.equal(t.calls[0].method, 'codex.send')
  assert.equal(t.calls[0].timeout, 60000)
  assert.equal('chat' in t.calls[0].params, false)
  assert.equal(t.calls[0].params.id, 't1')
  assert.equal(t.calls[0].params.prompt, 'hi')
})

test('events before the reply reach listeners right away', async () => {
  const t = setup()
  const seen = []
  t.host.onEvent((e) => seen.push(e.kind))
  t.host.send(payload({ chat: { id: 'c1' } }))
  t.notify('codex.event', { id: 't1', kind: 'session', sessionId: 's' })
  t.notify('codex.event', { id: 't1', kind: 'metrics', metrics: {} })
  assert.deepEqual(seen, ['session', 'metrics'])
  t.pending[0].resolve({})
  await t.tick()
  t.notify('codex.event', { id: 't1', kind: 'done' })
  assert.deepEqual(seen, ['session', 'metrics', 'done'])
})

test('a rejected send delivers an error to listeners', async () => {
  const t = setup()
  const seen = []
  t.host.onEvent((e) => seen.push(e))
  t.host.send(payload({ chat: { id: 'c1' } }))
  t.pending[0].reject(new Error('busy'))
  await t.tick()
  assert.deepEqual(seen, [{ id: 't1', kind: 'error', message: 'busy' }])
})

test('abort, permission and question go to IPC and to the host', async () => {
  const t = setup()
  t.host.abort('c1')
  t.host.permission('c1', 'r1', 'allow')
  t.host.question('c1', 'r2', { Q: 'A' })
  t.host.question('c1', 'r3')
  assert.deepEqual(t.ipcLog, [['abort', 'c1'], ['permission', 'c1', 'r1', 'allow'], ['question', 'c1', 'r2', { Q: 'A' }], ['question', 'c1', 'r3', undefined]])
  assert.deepEqual(t.calls.map((c) => [c.method, c.params]), [
    ['codex.abort', { chatId: 'c1' }],
    ['codex.permission', { chatId: 'c1', requestId: 'r1', decision: 'allow' }],
    ['codex.question', { chatId: 'c1', requestId: 'r2', answers: { Q: 'A' } }],
    ['codex.question', { chatId: 'c1', requestId: 'r3' }]
  ])
  assert.equal('answers' in t.calls[3].params, false)
  t.pending.forEach((p) => p.reject(new Error('down')))
  await t.tick() // an unhandled rejection would fail the run
})

test('onEvent subscribes to IPC and notifications; unsub undoes both', () => {
  const t = setup()
  const seen = []
  const off = t.host.onEvent((e) => seen.push(e.id))
  assert.equal(t.ipcListeners.size, 1)
  t.notify('codex.event', { id: 'a', kind: 'done' })
  t.notify('codex.event', { kind: 'done' })
  t.notify('codex.event', { id: 5, kind: 'done' })
  t.notify('codex.event', null)
  assert.deepEqual(seen, ['a'])
  off()
  assert.equal(t.ipcListeners.size, 0)
  t.notify('codex.event', { id: 'b', kind: 'done' })
  assert.deepEqual(seen, ['a'])
})

test('a dropped connection errors accepted runs that have not ended, once', async () => {
  const t = setup()
  const seen = []
  t.host.onEvent((e) => seen.push(e))
  t.host.send(payload({ id: 'acc', chatId: 'c1', chat: { id: 'c1' } }))
  t.host.send(payload({ id: 'nochat', chatId: 'c2' }))
  t.host.send(payload({ id: 'starting', chatId: 'c3', chat: { id: 'c3' } }))
  t.host.send(payload({ id: 'over', chatId: 'c4' }))
  t.host.send(payload({ id: 'early', chatId: 'c5' }))
  t.notify('codex.event', { id: 'early', kind: 'done' })
  t.pending[0].resolve({})
  t.pending[1].resolve({})
  t.pending[3].resolve({})
  t.pending[4].resolve({})
  await t.tick()
  t.notify('codex.event', { id: 'over', kind: 'done' })
  seen.length = 0
  t.status('connected')
  assert.deepEqual(seen, [])
  t.status('reconnecting')
  const dropped = seen.map((e) => [e.id, e.kind, e.message]).sort()
  assert.deepEqual(dropped, [['acc', 'error', CODEX_DROPPED], ['nochat', 'error', CODEX_DROPPED]])
  t.status('disconnected')
  assert.equal(seen.length, 2)
})

test('bridge.onProfileChanged forwards to codex.profileChanged and swallows failures', async () => {
  const t = setup()
  t.profile('p1')
  assert.equal(t.calls.length, 1)
  assert.equal(t.calls[0].method, 'codex.profileChanged')
  assert.deepEqual(t.calls[0].params, { profileId: 'p1' })
  assert.equal(t.calls[0].timeout, 5000)
  t.pending[0].reject(new Error('x'))
  await t.tick()
})

test('hostCodexPrompts subscribes to codex.permission / codex.question', () => {
  const t = setup()
  const got = []
  const prompts = hostCodexPrompts(t.client)
  const offP = prompts.onPermission((p) => got.push(['p', p]))
  const offQ = prompts.onQuestion((p) => got.push(['q', p]))
  t.notify('codex.permission', 1)
  t.notify('codex.question', 2)
  assert.deepEqual(got, [['p', 1], ['q', 2]])
  offP(); offQ()
  t.notify('codex.permission', 3)
  assert.equal(got.length, 2)
})

test('createHostCodexQueries maps to codex.* calls with refresh=false by default', () => {
  const t = setup()
  const q = createHostCodexQueries(t.client)
  q.models('p'); q.models('p', true)
  q.skills('p', '/w'); q.skills('p', '/w', true)
  q.details('p'); q.details('p', true)
  q.reset('p', 'key', 'credit'); q.reset('p', 'key2', null)
  assert.deepEqual(t.calls.map((c) => [c.method, c.params]), [
    ['codex.models', { profileId: 'p', refresh: false }], ['codex.models', { profileId: 'p', refresh: true }],
    ['codex.skills', { profileId: 'p', cwd: '/w', refresh: false }], ['codex.skills', { profileId: 'p', cwd: '/w', refresh: true }],
    ['codex.details', { profileId: 'p', refresh: false }], ['codex.details', { profileId: 'p', refresh: true }],
    ['codex.reset', { profileId: 'p', idempotencyKey: 'key', creditId: 'credit' }], ['codex.reset', { profileId: 'p', idempotencyKey: 'key2', creditId: null }]
  ])
})

test('routing: codex is host-ready and routes to the host when advertised', () => {
  assert.ok(routing.HOST_READY_DOMAINS.includes('codex'))
  assert.equal(routing.routeFor('codex', ['codex@1']), 'host')
  assert.equal(routing.routeFor('codex', ['claude@1']), 'ipc')
})

test('preload wiring (static): codex block, onEvent host member, codex prompts in claude block', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/preload/index.ts'), 'utf8')
  assert.match(src, /codex: withHost\('codex'/)
  assert.match(src, /\['onEvent'\]/)
  assert.match(src, /hostCodexPrompts\(hostClient\)\.onPermission/)
  assert.match(src, /hostCodexPrompts\(hostClient\)\.onQuestion/)
  assert.match(src, /onAgentPermission/)
  assert.match(src, /onAgentQuestion/)
})
