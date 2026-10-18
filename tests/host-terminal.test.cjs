const assert = require('node:assert/strict')
const test = require('node:test')
const loadTypescript = require('./helpers/load-typescript.cjs')

const { createHostTerminal, routedTerminal, hostSettled } = loadTypescript('src/shared/host/api/terminal.ts')

const tick = () => new Promise((resolve) => setImmediate(resolve))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function codeError(code, message = code) {
  const err = new Error(message)
  err.code = code
  return err
}

function fakeClient(initial = 'connected') {
  const calls = []
  const notes = new Map()
  const statusListeners = new Set()
  let status = { state: initial, attempt: 0 }
  const client = {
    calls,
    call(method, params) {
      return new Promise((resolve, reject) => calls.push({ method, params, resolve, reject }))
    },
    onNotification(method, cb) {
      if (!notes.has(method)) notes.set(method, new Set())
      notes.get(method).add(cb)
      return () => notes.get(method).delete(cb)
    },
    onStatus(cb) {
      statusListeners.add(cb)
      cb(status)
      return () => statusListeners.delete(cb)
    },
    notify(method, params) { for (const cb of [...(notes.get(method) ?? [])]) cb(params) },
    setStatus(state) {
      status = { state, attempt: 0 }
      for (const cb of [...statusListeners]) cb(status)
    },
    listenerCount: () => statusListeners.size,
    of: (method) => calls.filter((c) => c.method === method),
    data: (id, seq, data = 'x') => client.notify('terminal.data', { id, seq, data })
  }
  return client
}

function collect(api) {
  const data = []
  const exits = []
  api.onData((d) => data.push(d))
  api.onExit((e) => exits.push(e))
  return { data, exits }
}

async function created(client, api, id = 't1', seq = 0) {
  const p = api.create({ id })
  client.of('terminal.create').at(-1).resolve({ created: true, seq })
  assert.deepEqual(await p, { ok: true, persistent: true })
}

test('create calls terminal.create and resolves persistent; errors become ok:false', async () => {
  const c = fakeClient()
  const api = createHostTerminal(c)
  const p = api.create({ id: 't1', cols: 80, rows: 24 })
  assert.deepEqual(c.calls[0].method, 'terminal.create')
  assert.deepEqual(c.calls[0].params, { id: 't1', cols: 80, rows: 24 })
  c.calls[0].resolve({ created: true, seq: 0 })
  assert.deepEqual(await p, { ok: true, persistent: true })

  const q = api.create({ id: 't2' })
  c.calls[1].reject(new Error('boom'))
  assert.deepEqual(await q, { ok: false, error: 'boom' })
  const out = collect(api)
  c.data('t2', 1)
  assert.deepEqual(out.data, [])
})

test('terminal.data reaches onData; stale seq and unknown ids are dropped', async () => {
  const c = fakeClient()
  const api = createHostTerminal(c)
  const out = collect(api)
  await created(c, api)
  c.data('t1', 3, 'abc')
  c.data('t1', 3, 'dup')
  c.data('t1', 2, 'old')
  c.data('t1', 5, 'de')
  c.data('nope', 9, 'zzz')
  assert.deepEqual(out.data, [{ id: 't1', data: 'abc' }, { id: 't1', data: 'de' }])
})

test('create of an existing terminal resumes from the host seq', async () => {
  const c = fakeClient()
  const api = createHostTerminal(c)
  const out = collect(api)
  const p = api.create({ id: 't1' })
  c.calls[0].resolve({ created: false, seq: 10 })
  await p
  c.data('t1', 8, 'old')
  c.data('t1', 12, 'new')
  assert.deepEqual(out.data, [{ id: 't1', data: 'new' }])
})

test('kill calls terminal.kill and later data/exit for that id are ignored', async () => {
  const c = fakeClient()
  const api = createHostTerminal(c)
  const out = collect(api)
  await created(c, api)
  api.kill('t1')
  assert.deepEqual(c.of('terminal.kill')[0].params, { id: 't1' })
  c.data('t1', 4, 'late')
  c.notify('terminal.exit', { id: 't1', code: 0 })
  assert.deepEqual(out.data, [])
  assert.deepEqual(out.exits, [])
})

test('terminal.exit of a tracked id fires onExit once', async () => {
  const c = fakeClient()
  const api = createHostTerminal(c)
  const out = collect(api)
  await created(c, api)
  c.notify('terminal.exit', { id: 't1', code: 3 })
  c.notify('terminal.exit', { id: 't1', code: 3 })
  assert.deepEqual(out.exits, [{ id: 't1', code: 3 }])
})

test('attach: replay first, then held notifications past the replay seq', async () => {
  const c = fakeClient()
  const api = createHostTerminal(c)
  const out = collect(api)
  const p = api.attach('t1')
  assert.deepEqual(c.calls[0].method, 'terminal.attach')
  assert.deepEqual(c.calls[0].params, { id: 't1', since: 0 })
  c.data('t1', 4, 'dup-of-replay')
  c.data('t1', 10, 'live')
  assert.deepEqual(out.data, [], 'held while the attach is pending')
  c.calls[0].resolve({ data: 'replay', seq: 6, truncated: true })
  assert.deepEqual(await p, { ok: true, truncated: true })
  assert.deepEqual(out.data, [{ id: 't1', data: 'replay' }, { id: 't1', data: 'live' }])
  c.data('t1', 12, 'more')
  assert.equal(out.data.length, 3)
})

test('attach not_found on adoption: ok:false and no onExit', async () => {
  const c = fakeClient()
  const api = createHostTerminal(c)
  const out = collect(api)
  const p = api.attach('gone')
  c.calls[0].reject(codeError('not_found', 'sem terminal'))
  const res = await p
  assert.equal(res.ok, false)
  assert.deepEqual(out.exits, [])
  c.data('gone', 1)
  assert.deepEqual(out.data, [])
})

test('reconnect re-attaches confirmed terminals since the last seq', async () => {
  const c = fakeClient()
  const api = createHostTerminal(c)
  const out = collect(api)
  await created(c, api)
  c.data('t1', 7, 'seven')
  c.setStatus('reconnecting')
  assert.equal(c.of('terminal.attach').length, 0)
  c.setStatus('connected')
  const att = c.of('terminal.attach')
  assert.equal(att.length, 1)
  assert.deepEqual(att[0].params, { id: 't1', since: 7 })
  att[0].resolve({ data: 'missed', seq: 11, truncated: false })
  await tick()
  assert.deepEqual(out.data.at(-1), { id: 't1', data: 'missed' })
  c.data('t1', 11, 'dup')
  c.data('t1', 13, 'next')
  assert.deepEqual(out.data.at(-1), { id: 't1', data: 'next' })
  assert.equal(out.data.length, 3)
})

test('reconnect attach failing with not_found reports lost', async () => {
  const c = fakeClient()
  const api = createHostTerminal(c)
  const out = collect(api)
  await created(c, api)
  c.setStatus('reconnecting')
  c.setStatus('connected')
  c.of('terminal.attach')[0].reject(codeError('not_found'))
  await tick()
  assert.deepEqual(out.exits, [{ id: 't1', lost: true }])
})

test('a terminal whose create is still pending is not re-attached on connect', async () => {
  const c = fakeClient('connecting')
  const api = createHostTerminal(c)
  collect(api)
  void api.create({ id: 't1' })
  c.setStatus('connected')
  assert.equal(c.of('terminal.attach').length, 0)
})

test('input/resize call the right methods and swallow rejections', async () => {
  const c = fakeClient()
  const api = createHostTerminal(c)
  const unhandled = []
  const onUnhandled = (e) => unhandled.push(e)
  process.on('unhandledRejection', onUnhandled)
  try {
    api.input({ id: 't1', data: 'ls' })
    api.resize({ id: 't1', cols: 90, rows: 30 })
    api.kill('t1')
    assert.deepEqual(c.calls.map((x) => x.method), ['terminal.input', 'terminal.resize', 'terminal.kill'])
    assert.deepEqual(c.calls[0].params, { id: 't1', data: 'ls' })
    assert.deepEqual(c.calls[1].params, { id: 't1', cols: 90, rows: 30 })
    for (const call of c.calls) call.reject(new Error('down'))
    await sleep(10)
    assert.deepEqual(unhandled, [])
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

// routedTerminal

function sideApi(name, log) {
  const dataCbs = new Set()
  const exitCbs = new Set()
  return {
    dataCbs,
    exitCbs,
    init: async () => name,
    setCwd: async () => name,
    create: async (o) => { log.push([name, 'create', o.id]); return { ok: true, persistent: name === 'host' } },
    input: (p) => log.push([name, 'input', p.id, p.data]),
    resize: (p) => log.push([name, 'resize', p.id]),
    kill: (id) => log.push([name, 'kill', id]),
    onData: (cb) => { dataCbs.add(cb); return () => dataCbs.delete(cb) },
    onExit: (cb) => { exitCbs.add(cb); return () => exitCbs.delete(cb) },
    list: async () => [{ id: name }],
    attach: async (id) => { log.push([name, 'attach', id]); return { ok: true, truncated: false } }
  }
}

test('routed: a terminal stays on the side that created it', async () => {
  const log = []
  const ipc = sideApi('ipc', log)
  const host = sideApi('host', log)
  let route = 'host'
  const api = routedTerminal(ipc, host, () => route, async () => {})
  await api.create({ id: 'a' })
  route = 'ipc'
  await api.create({ id: 'b' })
  api.input({ id: 'a', data: 'x' })
  api.resize({ id: 'a', cols: 1, rows: 1 })
  route = 'host'
  api.input({ id: 'b', data: 'y' })
  api.kill('a')
  api.kill('b')
  await tick()
  assert.deepEqual(log.slice(2), [
    ['host', 'input', 'a', 'x'],
    ['host', 'resize', 'a'],
    ['ipc', 'input', 'b', 'y'],
    ['host', 'kill', 'a'],
    ['ipc', 'kill', 'b']
  ])
})

test('routed: ops wait for settle and go out after create, in order', async () => {
  const log = []
  const ipc = sideApi('ipc', log)
  const host = sideApi('host', log)
  let release
  const gate = new Promise((r) => { release = r })
  const api = routedTerminal(ipc, host, () => 'host', () => gate)
  const p = api.create({ id: 'a' })
  api.input({ id: 'a', data: 'a' })
  api.input({ id: 'a', data: 'b' })
  api.kill('a')
  await tick()
  assert.deepEqual(log, [])
  release()
  await p
  await tick()
  assert.deepEqual(log, [
    ['host', 'create', 'a'],
    ['host', 'input', 'a', 'a'],
    ['host', 'input', 'a', 'b'],
    ['host', 'kill', 'a']
  ])
})

test('routed list: [] on ipc, host list on host, [] on host error', async () => {
  const log = []
  const ipc = sideApi('ipc', log)
  const host = sideApi('host', log)
  let route = 'ipc'
  const api = routedTerminal(ipc, host, () => route, async () => {})
  assert.deepEqual(await api.list(), [])
  route = 'host'
  assert.deepEqual(await api.list(), [{ id: 'host' }])
  host.list = async () => { throw new Error('x') }
  assert.deepEqual(await api.list(), [])
})

test('routed attach: ipc route fails without calling the host; host route delegates and pins the side', async () => {
  const log = []
  const ipc = sideApi('ipc', log)
  const host = sideApi('host', log)
  let route = 'ipc'
  const api = routedTerminal(ipc, host, () => route, async () => {})
  assert.equal((await api.attach('a')).ok, false)
  assert.deepEqual(log, [])
  route = 'host'
  assert.equal((await api.attach('a')).ok, true)
  route = 'ipc'
  api.input({ id: 'a', data: 'q' })
  assert.deepEqual(log, [['host', 'attach', 'a'], ['host', 'input', 'a', 'q']])
})

test('routed onData/onExit subscribe both sides and unsub undoes both', () => {
  const ipc = sideApi('ipc', [])
  const host = sideApi('host', [])
  const api = routedTerminal(ipc, host, () => 'host', async () => {})
  const off1 = api.onData(() => {})
  const off2 = api.onExit(() => {})
  assert.deepEqual([ipc.dataCbs.size, host.dataCbs.size, ipc.exitCbs.size, host.exitCbs.size], [1, 1, 1, 1])
  off1()
  off2()
  assert.deepEqual([ipc.dataCbs.size, host.dataCbs.size, ipc.exitCbs.size, host.exitCbs.size], [0, 0, 0, 0])
})

// hostSettled

test('hostSettled resolves at once when connected or unavailable', async () => {
  for (const state of ['connected', 'unavailable']) {
    const c = fakeClient(state)
    await hostSettled(c, 5000)
    assert.equal(c.listenerCount(), 0, 'unsubscribed')
  }
})

test('hostSettled waits while connecting/reconnecting and resolves on change', async () => {
  for (const state of ['connecting', 'reconnecting']) {
    const c = fakeClient(state)
    let done = false
    const p = hostSettled(c, 5000).then(() => { done = true })
    await sleep(10)
    assert.equal(done, false)
    c.setStatus('connected')
    await p
    assert.equal(c.listenerCount(), 0)
  }
})

test('hostSettled resolves on timeout', async () => {
  const c = fakeClient('connecting')
  const start = Date.now()
  await hostSettled(c, 50)
  assert.ok(Date.now() - start >= 40)
  assert.equal(c.listenerCount(), 0)
})
