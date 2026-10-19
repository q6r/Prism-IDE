const assert = require('node:assert/strict')
const test = require('node:test')
const loadTypescript = require('./helpers/load-typescript.cjs')

const call = loadTypescript('src/shared/host/api/call.ts')
const { createHostChats } = loadTypescript('src/shared/host/api/chats.ts', { './call': call })

function setup() {
  const calls = []
  const pending = []
  const listeners = new Map()
  const statusListeners = new Set()
  const order = []
  const client = {
    call(method, params, timeout) {
      calls.push({ method, params, timeout })
      order.push(`call:${method}`)
      return new Promise((resolve, reject) => pending.push({ method, resolve, reject }))
    },
    onNotification(method, l) {
      order.push(`on:${method}`)
      if (!listeners.has(method)) listeners.set(method, new Set())
      listeners.get(method).add(l)
      return () => listeners.get(method).delete(l)
    },
    onStatus(l) { statusListeners.add(l); return () => statusListeners.delete(l) }
  }
  const api = createHostChats(client)
  const batch = (rev, deltas) => { for (const l of [...(listeners.get('chats.delta') ?? [])]) l({ rev, deltas }) }
  const status = (state) => statusListeners.forEach((l) => l({ state }))
  const tick = () => new Promise((r) => setImmediate(r))
  const subs = () => pending.filter((p) => p.method === 'chats.subscribe')
  return { api, calls, pending, order, batch, status, tick, subs, listeners, statusListeners }
}

const snap = (rev, ids = []) => ({ rev, chats: ids.map((id) => ({ id })), runtime: {} })
const d = (n) => ({ op: 'patch', chatId: 'c', patch: { n } })
const run = () => {
  const t = setup()
  const snapshots = [], deltas = []
  const stop = t.api.follow((s) => snapshots.push(s), (ds, rev) => deltas.push({ ds: ds.map((x) => x.patch.n), rev }))
  return { ...t, snapshots, deltas, stop }
}

// ---- follow ----

test('follow registers the chats.delta listener before it subscribes', async () => {
  const t = run()
  assert.equal(t.order.indexOf('on:chats.delta') >= 0, true)
  t.status('connected')
  assert.ok(t.order.indexOf('on:chats.delta') < t.order.indexOf('call:chats.subscribe'))
  assert.equal(t.calls[0].timeout, 120000)
  assert.deepEqual(t.calls[0].params, {})
})

test('nothing subscribes until the status is connected', () => {
  const t = run()
  assert.equal(t.calls.length, 0)
  t.status('connecting')
  assert.equal(t.calls.length, 0)
})

test('batches before the reply are held; only revs after the snapshot are delivered', async () => {
  const t = run()
  t.status('connected')
  t.batch(5, [d(1), d(2)])      // revs 4,5 — already in snapshot
  t.batch(8, [d(3), d(4), d(5)]) // revs 6,7,8
  t.subs()[0].resolve(snap(5))
  await t.tick()
  assert.equal(t.snapshots.length, 1)
  assert.deepEqual(t.deltas, [{ ds: [3, 4, 5], rev: 8 }])
})

test('a held batch that crosses the snapshot rev delivers only its newer part', async () => {
  const t = run()
  t.status('connected')
  t.batch(7, [d(1), d(2), d(3), d(4)]) // revs 4..7
  t.subs()[0].resolve(snap(5))
  await t.tick()
  assert.deepEqual(t.deltas, [{ ds: [3, 4], rev: 7 }]) // revs 6,7
})

test('batch exactly at the snapshot rev is dropped; the next one applies', async () => {
  const t = run()
  t.status('connected')
  t.subs()[0].resolve(snap(10))
  await t.tick()
  t.batch(10, [d(1)])
  assert.deepEqual(t.deltas, [])
  t.batch(11, [d(2)])
  assert.deepEqual(t.deltas, [{ ds: [2], rev: 11 }])
})

test('old batch after the snapshot is dropped; crossing live batch delivers its newer deltas', async () => {
  const t = run()
  t.status('connected')
  t.subs()[0].resolve(snap(10))
  await t.tick()
  t.batch(9, [d(1), d(2)])
  assert.deepEqual(t.deltas, [])
  t.batch(12, [d(3), d(4), d(5)]) // revs 10,11,12 → only 11,12
  assert.deepEqual(t.deltas, [{ ds: [4, 5], rev: 12 }])
  t.batch(13, [d(6)])
  assert.deepEqual(t.deltas.at(-1), { ds: [6], rev: 13 })
})

test('a gap in rev subscribes again and delivers the new snapshot', async () => {
  const t = run()
  t.status('connected')
  t.subs()[0].resolve(snap(10))
  await t.tick()
  t.batch(11, [d(1)])
  t.batch(14, [d(2)]) // first = 14 > 11 + 1 → gap
  assert.equal(t.subs().length, 2)
  assert.deepEqual(t.deltas, [{ ds: [1], rev: 11 }])
  // while resubscribing, batches are held again
  t.batch(15, [d(3)])
  t.subs()[1].resolve(snap(14, ['x']))
  await t.tick()
  assert.equal(t.snapshots.length, 2)
  assert.deepEqual(t.snapshots[1].chats, [{ id: 'x' }])
  assert.deepEqual(t.deltas.at(-1), { ds: [3], rev: 15 })
})

test('reconnecting → connected subscribes again with a new snapshot', async () => {
  const t = run()
  t.status('connected')
  t.subs()[0].resolve(snap(3))
  await t.tick()
  t.status('reconnecting')
  t.batch(4, [d(1)]) // while down: held/ignored, never delivered before a snapshot
  assert.equal(t.subs().length, 1)
  t.status('connected')
  assert.equal(t.subs().length, 2)
  t.subs()[1].resolve(snap(9))
  await t.tick()
  assert.equal(t.snapshots.length, 2)
  assert.equal(t.snapshots[1].rev, 9)
  assert.deepEqual(t.deltas, [])
})

test('repeated connected statuses do not subscribe twice', () => {
  const t = run()
  t.status('connected')
  t.status('connected')
  assert.equal(t.subs().length, 1)
})

test('the reply of an older subscribe is ignored', async () => {
  const t = run()
  t.status('connected')
  t.status('reconnecting')
  t.status('connected')
  assert.equal(t.subs().length, 2)
  t.subs()[0].resolve(snap(1, ['old']))
  await t.tick()
  assert.equal(t.snapshots.length, 0)
  t.subs()[1].resolve(snap(2, ['new']))
  await t.tick()
  assert.deepEqual(t.snapshots.map((s) => s.rev), [2])
})

test('an older subscribe reply after a gap resubscribe is ignored', async () => {
  const t = run()
  t.status('connected')
  t.subs()[0].resolve(snap(10))
  await t.tick()
  t.batch(20, [d(1)])
  assert.equal(t.subs().length, 2)
  t.subs()[1].resolve(snap(20))
  await t.tick()
  assert.deepEqual(t.snapshots.map((s) => s.rev), [10, 20])
})

test('a non-disconnected failure retries after 2s', async (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] })
  const t = run()
  t.status('connected')
  t.subs()[0].reject(Object.assign(new Error('boom'), { code: 'internal' }))
  await t.tick()
  ctx.mock.timers.tick(1999)
  assert.equal(t.subs().length, 1)
  ctx.mock.timers.tick(1)
  assert.equal(t.subs().length, 2)
  t.subs()[1].resolve(snap(1))
  await t.tick()
  assert.equal(t.snapshots.length, 1)
})

test('a disconnected failure does not retry on a timer', async (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] })
  const t = run()
  t.status('connected')
  t.subs()[0].reject(Object.assign(new Error('x'), { code: 'disconnected' }))
  await t.tick()
  ctx.mock.timers.tick(10_000)
  assert.equal(t.subs().length, 1)
})

test('the retry is not made when the connection went down meanwhile or after stop', async (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] })
  const a = run()
  a.status('connected')
  a.subs()[0].reject(new Error('boom'))
  await a.tick()
  a.status('reconnecting')
  ctx.mock.timers.tick(5000)
  assert.equal(a.subs().length, 1)

  const b = run()
  b.status('connected')
  b.subs()[0].reject(new Error('boom'))
  await b.tick()
  b.stop()
  ctx.mock.timers.tick(5000)
  assert.equal(b.subs().length, 1)
})

test('stop removes listeners and unsubscribes when subscribed', async () => {
  const t = run()
  t.status('connected')
  t.subs()[0].resolve(snap(1))
  await t.tick()
  t.stop()
  assert.equal(t.listeners.get('chats.delta').size, 0)
  assert.equal(t.statusListeners.size, 0)
  const unsub = t.calls.filter((c) => c.method === 'chats.unsubscribe')
  assert.equal(unsub.length, 1)
  assert.deepEqual(unsub[0].params, {})
  t.stop() // idempotent
  assert.equal(t.calls.filter((c) => c.method === 'chats.unsubscribe').length, 1)
})

test('stop without a completed subscribe, or while down, does not call unsubscribe', async () => {
  const a = run()
  a.status('connected')
  a.stop()
  assert.equal(a.calls.some((c) => c.method === 'chats.unsubscribe'), false)
  // late reply after stop is dropped
  a.subs()[0].resolve(snap(1))
  await a.tick()
  assert.equal(a.snapshots.length, 0)

  const b = run()
  b.status('connected')
  b.subs()[0].resolve(snap(1))
  await b.tick()
  b.status('disconnected')
  b.stop()
  assert.equal(b.calls.some((c) => c.method === 'chats.unsubscribe'), false)
})

test('malformed notifications are ignored', async () => {
  const t = run()
  t.status('connected')
  t.subs()[0].resolve(snap(1))
  await t.tick()
  for (const l of t.listeners.get('chats.delta')) { l(null); l({}); l({ rev: 'x', deltas: [] }); l({ rev: 3, deltas: 'no' }) }
  assert.deepEqual(t.deltas, [])
  t.batch(2, [d(1)])
  assert.equal(t.deltas.length, 1)
})

// ---- commands ----

test('subscribe, list and unsubscribe call chats.* with their timeouts', () => {
  const t = setup()
  t.api.subscribe()
  t.api.list()
  t.api.unsubscribe()
  assert.deepEqual(t.calls.map((c) => [c.method, c.params, c.timeout]), [
    ['chats.subscribe', {}, 120000],
    ['chats.list', {}, 120000],
    ['chats.unsubscribe', {}, undefined]
  ])
})

test('each command calls chats.<method> with the right params', async () => {
  const t = setup()
  const chat = { id: 'c' }
  const sel = { provider: 'claude' }
  const sends = [
    [() => t.api.create(chat), 'chats.create', { chat }],
    [() => t.api.put(chat), 'chats.put', { chat }],
    [() => t.api.configure('c', sel), 'chats.configure', { chatId: 'c', selection: sel }],
    [() => t.api.confirmAccount('c'), 'chats.confirmAccount', { chatId: 'c' }],
    [() => t.api.bindWorkspace({ chatId: 'c', cwd: '/x' }), 'chats.bindWorkspace', { chatId: 'c', cwd: '/x' }],
    [() => t.api.rename('c', 'T'), 'chats.rename', { chatId: 'c', title: 'T' }],
    [() => t.api.archive('c', true), 'chats.archive', { chatId: 'c', archived: true }],
    [() => t.api.setTask('c', 'k'), 'chats.setTask', { chatId: 'c', taskId: 'k' }],
    [() => t.api.setTask('c'), 'chats.setTask', { chatId: 'c' }],
    [() => t.api.remove('c'), 'chats.remove', { chatId: 'c' }],
    [() => t.api.send({ chatId: 'c', text: 'hi' }), 'chats.send', { chatId: 'c', text: 'hi' }],
    [() => t.api.stop('c'), 'chats.stop', { chatId: 'c' }],
    [() => t.api.respondPermission({ chatId: 'c', permId: 'p', decision: 'allow' }), 'chats.respondPermission', { chatId: 'c', permId: 'p', decision: 'allow' }],
    [() => t.api.respondQuestion({ chatId: 'c', questionId: 'q', answers: {} }), 'chats.respondQuestion', { chatId: 'c', questionId: 'q', answers: {} }]
  ]
  for (const [fn, method, params] of sends) {
    const before = t.calls.length
    const p = fn()
    assert.equal(t.calls.length, before + 1, method)
    const last = t.calls.at(-1)
    assert.equal(last.method, method)
    assert.deepEqual(last.params, params)
    if (method === 'chats.send') assert.equal(last.timeout, 60000)
    else assert.equal(last.timeout, undefined, method)
    assert.equal('taskId' in last.params, 'taskId' in params)
    t.pending.at(-1).resolve({})
    assert.deepEqual(await p, { ok: true })
  }
})

test('a successful result is spread with ok: true', async () => {
  const t = setup()
  const p = t.api.send({ chatId: 'c', text: 'x' })
  t.pending[0].resolve({ turnId: 't9' })
  assert.deepEqual(await p, { turnId: 't9', ok: true })
})

test('messageSubagent targets the selected child and preserves direct or parent-mediated delivery results', async () => {
  const t = setup()
  const direct = t.api.messageSubagent('child-chat', 'Confira os testes')
  assert.deepEqual(t.calls.at(-1), { method: 'chats.messageSubagent', params: { chatId: 'child-chat', text: 'Confira os testes' }, timeout: undefined })
  t.pending.at(-1).resolve({ delivery: 'direct', nativeTurnId: 'native-child-turn', steered: true })
  assert.deepEqual(await direct, { ok: true, delivery: 'direct', nativeTurnId: 'native-child-turn', steered: true })
  const viaParent = t.api.messageSubagent('child-chat', 'Reveja o log')
  t.pending.at(-1).resolve({ delivery: 'parent' })
  assert.deepEqual(await viaParent, { ok: true, delivery: 'parent' })
  const refused = t.api.messageSubagent('child-chat', 'Tente novamente')
  t.pending.at(-1).reject(Object.assign(new Error('Subagente desconectado'), { code: 'gone' }))
  assert.deepEqual(await refused, { ok: false, code: 'gone', error: 'Subagente desconectado' })
})

test('an error with a code becomes { ok: false, code, error } and never rejects', async () => {
  const t = setup()
  const p = t.api.stop('c')
  t.pending[0].reject(Object.assign(new Error('Ocupado'), { code: 'busy' }))
  assert.deepEqual(await p, { ok: false, code: 'busy', error: 'Ocupado' })
  const q = t.api.rename('c', 'x')
  t.pending[1].reject(new Error('sem código'))
  assert.deepEqual(await q, { ok: false, code: 'internal', error: 'sem código' })
  const r = t.api.remove('c')
  t.pending[2].reject('texto')
  assert.deepEqual(await r, { ok: false, code: 'internal', error: 'texto' })
})
