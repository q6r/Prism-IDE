const assert = require('node:assert/strict')
const test = require('node:test')
const { boot, routing } = require('./helpers/preload-boot.cjs')
const { firstHelloGate, gated, NO_HOST_ANSWER } = routing

const tick = () => new Promise((r) => setImmediate(r))
const channels = (t) => t.invokes.map((i) => i.channel)
const CONNECTED = { state: 'connected', hello: { capabilities: [] } }

// ---- o gate do primeiro hello, no preload de verdade ----

test('(a) com binário, a chamada antes do hello espera e vai ao host com providers@1', async () => {
  const t = boot({ binary: true })
  t.results.set('providers:list', [{ id: 'ipc' }])
  t.state.answer = () => ({ profiles: [{ id: 'host' }] })
  let result
  const pending = t.api.providers.list().then((r) => { result = r })
  await tick(); await tick()
  assert.equal(result, undefined)
  assert.equal(channels(t).includes('providers:list'), false)
  assert.equal(t.state.calls.length, 0)
  t.state.caps = ['host@1', 'providers@1']
  t.emitStatus({ state: 'connecting' })
  await tick()
  assert.equal(t.state.calls.length, 0)
  t.emitStatus(CONNECTED)
  await pending
  assert.deepEqual(result, [{ id: 'host' }])
  assert.deepEqual(t.state.calls.map((c) => c.method), ['providers.list'])
  assert.equal(channels(t).includes('providers:list'), false)
})

test('(b) sem binário a chamada vai ao IPC sem esperar o hello', async () => {
  const t = boot({ binary: false })
  t.results.set('providers:list', [{ id: 'ipc' }])
  assert.deepEqual(await t.api.providers.list(), [{ id: 'ipc' }])
  assert.equal(t.state.calls.length, 0)
})

test('(c) com binário e host sem providers@1, depois do hello vai ao IPC', async () => {
  const t = boot({ binary: true })
  t.results.set('providers:list', [{ id: 'ipc' }])
  const pending = t.api.providers.list()
  await tick()
  assert.equal(channels(t).includes('providers:list'), false)
  t.state.caps = ['host@1', 'chats@1']
  t.emitStatus(CONNECTED)
  assert.deepEqual(await pending, [{ id: 'ipc' }])
  assert.equal(t.state.calls.length, 0)
})

test('(d) com binário e sem hello, 30 s depois rejeita sem tocar no IPC', async (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] })
  const t = boot({ binary: true })
  const settled = assert.rejects(t.api.providers.list(), { message: 'O host do Prism não respondeu.' })
  await tick()
  ctx.mock.timers.tick(29_999)
  await tick()
  assert.equal(channels(t).includes('providers:list'), false)
  ctx.mock.timers.tick(1)
  await settled
  assert.equal(channels(t).includes('providers:list'), false)
  assert.equal(t.state.calls.length, 0)
})

test('já conectado antes da chamada não espera', async () => {
  const t = boot({ binary: true })
  t.state.caps = ['providers@1']
  t.emitStatus(CONNECTED)
  t.state.answer = () => ({ profiles: [] })
  await t.api.providers.list()
  assert.equal(t.state.calls.length, 1)
})

test('agentCommands.list passa pelo mesmo gate', async () => {
  const t = boot({ binary: true })
  t.state.answer = () => [{ name: 'host' }]
  const pending = t.api.agentCommands.list('claude', 'p', '/w')
  await tick()
  assert.equal(channels(t).includes('agents:commands'), false)
  assert.equal(t.state.calls.length, 0)
  t.state.caps = ['providers@1']
  t.emitStatus(CONNECTED)
  assert.deepEqual(await pending, [{ name: 'host' }])
  assert.equal(t.state.calls[0].method, 'providers.commands')
})

test('loginInput antes do hello com binário não vai ao IPC; depois vai ao host', async () => {
  const t = boot({ binary: true })
  t.api.providers.loginInput('p', 'x')
  await tick(); await tick()
  assert.equal(t.sends.length, 0)
  t.state.caps = ['providers@1']
  t.emitStatus(CONNECTED)
  await tick(); await tick()
  assert.equal(t.sends.length, 0)
  assert.deepEqual(t.state.calls.map((c) => c.method), ['providers.loginInput'])
})

test('loginInput cuja espera expira não gera unhandled rejection', async (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] })
  const unhandled = []
  const on = (e) => unhandled.push(e)
  process.on('unhandledRejection', on)
  try {
    const t = boot({ binary: true })
    t.api.providers.loginInput('p', 'x')
    await tick()
    ctx.mock.timers.tick(30_000)
    await tick(); await tick()
    assert.equal(t.sends.length, 0)
  } finally { process.off('unhandledRejection', on) }
  assert.deepEqual(unhandled, [])
})

test('traycerLinks/linkTraycer/unlinkTraycer vão ao IPC na hora, com binário e sem hello', () => {
  const t = boot({ binary: true })
  t.api.providers.traycerLinks()
  t.api.providers.linkTraycer('a')
  t.api.providers.unlinkTraycer('b')
  assert.deepEqual(channels(t).filter((c) => c.startsWith('traycer:')), ['traycer:pending-links', 'traycer:link-login', 'traycer:unlink-login'])
})

test('onLogin/onChanged registram na hora, com binário e sem hello', () => {
  const t = boot({ binary: true })
  t.api.providers.onLogin(() => undefined)
  t.api.providers.onChanged(() => undefined)
  assert.equal(t.state.notifications.get('providers.login').size, 1)
  assert.equal(t.state.notifications.get('providers.changed').size, 1)
  assert.equal(t.ons.filter((o) => o.channel === 'providers:login-event').length, 1)
})

test('usage.records não espera', () => {
  const t = boot({ binary: true })
  t.api.usage.records()
  assert.ok(channels(t).includes('usage:records'))
})

// ---- firstHelloGate ----

function gateEnv({ owned = true, status = null, ms = 1000 } = {}) {
  const listeners = new Set()
  const env = { listeners, ownedCalls: 0, owned, emit(s) { for (const l of [...listeners]) l(s) } }
  env.gate = firstHelloGate({
    owned: () => { env.ownedCalls++; return typeof env.owned === 'function' ? env.owned() : Promise.resolve(env.owned) },
    onStatus: (l) => { listeners.add(l); if (status) l(status); return () => listeners.delete(l) },
    ms
  })
  return env
}

test('NO_HOST_ANSWER', () => {
  assert.equal(NO_HOST_ANSWER, 'O host do Prism não respondeu.')
})

test('firstHelloGate: sem binário devolve uma Promise uma vez e depois null', async () => {
  const g = gateEnv({ owned: false })
  const first = g.gate()
  assert.ok(first && typeof first.then === 'function')
  await first
  assert.equal(g.gate(), null)
  assert.equal(g.ownedCalls, 1)
  g.emit({ state: 'connected' })
  assert.equal(g.gate(), null)
})

test('firstHelloGate: já conectado devolve null sem perguntar pelo binário', () => {
  const g = gateEnv({ status: { state: 'connected' } })
  assert.equal(g.gate(), null)
  assert.equal(g.ownedCalls, 0)
})

test('firstHelloGate: com binário espera o primeiro connected; connecting não libera', async () => {
  const g = gateEnv()
  let done = false
  const wait = g.gate().then(() => { done = true })
  await tick()
  g.emit({ state: 'connecting' })
  await tick()
  assert.equal(done, false)
  g.emit({ state: 'connected' })
  await wait
  assert.equal(g.gate(), null)
  assert.equal(g.listeners.size, 1, 'só o listener permanente fica')
})

test('firstHelloGate: várias chamadas compartilham a mesma espera', async () => {
  const g = gateEnv()
  const a = g.gate(), b = g.gate()
  assert.equal(a, b)
  await tick()
  g.emit({ state: 'connected' })
  await a
  assert.equal(g.ownedCalls, 1)
})

test('firstHelloGate: incompatible rejeita na hora e a próxima chamada espera de novo', async () => {
  const g = gateEnv()
  const first = g.gate()
  const rejected = assert.rejects(first, { message: NO_HOST_ANSWER })
  await tick()
  g.emit({ state: 'incompatible' })
  await rejected
  const second = g.gate()
  assert.ok(second, 'espera de novo')
  assert.notEqual(second, first)
  const ok = second.then(() => 'ok')
  await tick()
  g.emit({ state: 'connected' })
  assert.equal(await ok, 'ok')
})

test('firstHelloGate: timeout de ms rejeita com NO_HOST_ANSWER e reinicia', async (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] })
  const g = gateEnv({ ms: 500 })
  const rejected = assert.rejects(g.gate(), { message: NO_HOST_ANSWER })
  await tick()
  ctx.mock.timers.tick(499)
  await tick()
  ctx.mock.timers.tick(1)
  await rejected
  assert.equal(g.listeners.size, 1, 'o listener da espera foi desfeito')
  const again = g.gate()
  assert.ok(again)
  again.catch(() => undefined)
})

test('firstHelloGate: owned() rejeitando rejeita e reinicia', async () => {
  let calls = 0
  let fail = true
  const g = gateEnv({ owned: () => { calls++; return fail ? Promise.reject(new Error('ipc caiu')) : Promise.resolve(false) } })
  await assert.rejects(g.gate(), { message: 'ipc caiu' })
  fail = false
  await g.gate()
  assert.equal(g.gate(), null)
  assert.equal(calls, 2)
})

// ---- gated ----

test('gated: só os membros em keys passam pelo gate; gate null roda síncrono', () => {
  const ran = []
  const api = { a: (x) => { ran.push(['a', x]); return 'A' }, b: (x) => { ran.push(['b', x]); return 'B' }, n: 5 }
  const open = gated(api, ['a', 'n'], () => null)
  assert.equal(open.a(1), 'A')
  assert.equal(open.b(2), 'B')
  assert.equal(open.n, 5)
  assert.deepEqual(ran, [['a', 1], ['b', 2]])
})

test('gated: com espera roda depois e devolve a Promise do resultado; o resto não espera', async () => {
  const ran = []
  const api = { a: (x) => { ran.push(['a', x]); return 'A' }, b: (x) => { ran.push(['b', x]); return 'B' } }
  let open
  const wait = new Promise((r) => { open = r })
  const g = gated(api, ['a'], () => wait)
  const p = g.a(1)
  assert.equal(g.b(2), 'B')
  assert.deepEqual(ran, [['b', 2]])
  open()
  assert.equal(await p, 'A')
  assert.deepEqual(ran, [['b', 2], ['a', 1]])
})

test('gated: a recusa do gate rejeita o chamador; um membro void ignorado não gera unhandled rejection', async () => {
  const unhandled = []
  const on = (e) => unhandled.push(e)
  process.on('unhandledRejection', on)
  let ran = 0
  try {
    const api = { a: () => { ran++ }, v: () => { ran++ } }
    const g = gated(api, ['a', 'v'], () => Promise.reject(new Error('sem host')))
    await assert.rejects(g.a(), { message: 'sem host' })
    g.v()
    await tick(); await tick()
  } finally { process.off('unhandledRejection', on) }
  assert.equal(ran, 0)
  assert.deepEqual(unhandled, [])
})

test('gated: não altera o objeto original', () => {
  const api = { a: () => 1 }
  const g = gated(api, ['a'], () => Promise.resolve())
  assert.notEqual(g, api)
  assert.equal(api.a(), 1)
})
