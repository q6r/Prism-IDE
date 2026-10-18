const assert = require('node:assert/strict')
const test = require('node:test')
const loadTypescript = require('./helpers/load-typescript.cjs')

const routing = loadTypescript('src/shared/host/routing.ts')
const { routeFor, stickyRoute, HOST_READY_DOMAINS, HOST_STICKY_DOMAINS } = routing

// ---- routing.ts ----

test('providers e usage estão em HOST_READY_DOMAINS; providers e remote são sticky', () => {
  assert.ok(HOST_READY_DOMAINS.includes('providers'))
  assert.ok(HOST_READY_DOMAINS.includes('usage'))
  assert.deepEqual([...HOST_STICKY_DOMAINS], ['providers', 'remote'])
  assert.equal(routeFor('providers', ['providers@1']), 'host')
  assert.equal(routeFor('usage', ['usage@1']), 'host')
  assert.equal(routeFor('providers', ['usage@1']), 'ipc')
})

test('stickyRoute: um domínio sticky que o host serviu continua no host', () => {
  let caps = []
  const route = stickyRoute((d) => routeFor(d, caps))
  assert.equal(route('providers'), 'ipc', 'nunca serviu')
  caps = ['providers@1', 'usage@1']
  assert.equal(route('providers'), 'host')
  caps = []
  assert.equal(route('providers'), 'host', 'reconectando continua no host')
  assert.equal(route('usage'), 'ipc', 'usage não é sticky')
  caps = ['usage@1']
  assert.equal(route('usage'), 'host')
  caps = []
  assert.equal(route('usage'), 'ipc')
})

test('stickyRoute: lista sticky customizada e estado por instância', () => {
  const a = stickyRoute((d) => (d === 'x' ? 'host' : 'ipc'), ['x'])
  assert.equal(a('x'), 'host')
  const b = stickyRoute(() => 'ipc', ['x'])
  assert.equal(b('x'), 'ipc')
  let side = 'host'
  const c = stickyRoute(() => side, [])
  c('y')
  side = 'ipc'
  assert.equal(c('y'), 'ipc')
})

const { boot } = require('./helpers/preload-boot.cjs')

const tick = () => new Promise((r) => setImmediate(r))
const channels = (t) => t.invokes.map((i) => i.channel)

test('sem providers@1, providers.list vai ao IPC', async () => {
  const t = boot()
  t.results.set('providers:list', [{ id: 'ipc' }])
  assert.deepEqual(await t.api.providers.list(), [{ id: 'ipc' }])
  assert.ok(channels(t).includes('providers:list'))
  assert.equal(t.state.calls.length, 0)
})

test('com providers@1, providers.list vai ao host; reconectando (caps vazias) continua no host', async () => {
  const t = boot()
  t.state.caps = ['host@1', 'providers@1']
  t.state.answer = () => ({ profiles: [{ id: 'host' }] })
  assert.deepEqual(await t.api.providers.list(), [{ id: 'host' }])
  assert.equal(t.state.calls[0].method, 'providers.list')
  assert.equal(channels(t).includes('providers:list'), false)
  t.state.caps = []
  assert.deepEqual(await t.api.providers.list(), [{ id: 'host' }])
  assert.equal(t.state.calls.length, 2)
  assert.equal(channels(t).includes('providers:list'), false)
})

test('IPC e host: update/remove/login mapeiam canais e métodos', async () => {
  const t = boot()
  t.api.providers.loginInput('p', 'x')
  t.api.providers.loginCancel('p', 's')
  await tick()
  assert.deepEqual(t.sends.map((s) => s.channel), ['providers:login-input', 'providers:login-cancel'])
  assert.equal(t.state.calls.length, 0)
  t.state.caps = ['providers@1']
  t.state.answer = () => ({ session: 'S' })
  assert.equal(await t.api.providers.login('claude', 'p'), 'S')
  assert.equal(t.sends.length, 2, 'nada novo no IPC')
})

test('usage.records só vai ao host com usage@1 e não é sticky', async () => {
  const t = boot()
  t.results.set('usage:records', { from: 'ipc' })
  t.state.answer = () => ({ from: 'host' })
  assert.deepEqual(await t.api.usage.records(), { from: 'ipc' })
  t.state.caps = ['usage@1']
  assert.deepEqual(await t.api.usage.records(), { from: 'host' })
  assert.equal(t.state.calls.at(-1).method, 'usage.records')
  t.state.caps = []
  assert.deepEqual(await t.api.usage.records(), { from: 'ipc' })
})

test('usage: os outros membros continuam no IPC mesmo com usage@1', async () => {
  const t = boot()
  t.state.caps = ['usage@1']
  await t.api.usage.fontCss()
  assert.ok(channels(t).includes('usage:font-css'))
  assert.equal(t.state.calls.length, 0)
})

test('agentCommands.list → providers.commands com providers@1, IPC sem', async () => {
  const t = boot()
  t.results.set('agents:commands', [{ name: 'ipc' }])
  assert.deepEqual(await t.api.agentCommands.list('claude', 'p', '/w'), [{ name: 'ipc' }])
  assert.deepEqual(t.invokes.at(-1), { channel: 'agents:commands', args: ['claude', 'p', '/w', false] })
  t.state.caps = ['providers@1']
  t.state.answer = () => [{ name: 'host' }]
  assert.deepEqual(await t.api.agentCommands.list('claude', 'p', '/w', true), [{ name: 'host' }])
  assert.equal(t.state.calls[0].method, 'providers.commands')
  assert.equal(t.state.calls[0].params.refresh, true)
})

test('traycerLinks/linkTraycer/unlinkTraycer sempre vão ao IPC', async () => {
  const t = boot()
  t.state.caps = ['providers@1']
  await t.api.providers.traycerLinks()
  await t.api.providers.linkTraycer('a')
  await t.api.providers.unlinkTraycer('b')
  assert.deepEqual(t.invokes.map((i) => [i.channel, ...i.args]), [
    ['traycer:pending-links'],
    ['traycer:link-login', 'a'],
    ['traycer:unlink-login', 'b']
  ])
  assert.equal(t.state.calls.length, 0)
})

test('available no IPC: claude → agent:available', async () => {
  const t = boot()
  t.results.set('agent:available', { available: true, version: '1.2.3' })
  assert.deepEqual(await t.api.providers.available('claude'), { available: true, version: '1.2.3' })
  assert.deepEqual(t.invokes.at(-1), { channel: 'agent:available', args: [] })
})

test('available no IPC: codex → providers:status(codex, ambient-codex)', async () => {
  const t = boot()
  t.results.set('providers:status', { installed: true, loggedIn: false })
  assert.deepEqual(await t.api.providers.available('codex'), { available: true, version: '' })
  assert.deepEqual(t.invokes.at(-1), { channel: 'providers:status', args: ['codex', 'ambient-codex'] })
  t.results.set('providers:status', { installed: false })
  assert.deepEqual(await t.api.providers.available('codex'), { available: false, version: '' })
})

test('available com providers@1 vai ao host', async () => {
  const t = boot()
  t.state.caps = ['providers@1']
  t.state.answer = () => ({ available: true, version: '9', verified: true })
  assert.deepEqual(await t.api.providers.available('codex'), { available: true, version: '9', verified: true })
  assert.equal(t.state.calls[0].method, 'providers.available')
  assert.equal(channels(t).includes('providers:status'), false)
})

test('onLogin e onChanged registram os dois lados mesmo sem host', () => {
  const t = boot()
  const logins = []
  const offLogin = t.api.providers.onLogin((e) => logins.push(e))
  assert.equal(t.state.notifications.get('providers.login').size, 1)
  const ipcLogin = t.ons.filter((o) => o.channel === 'providers:login-event')
  assert.equal(ipcLogin.length, 1)
  ipcLogin[0].l({}, { profileId: 'p' })
  ;[...t.state.notifications.get('providers.login')].forEach((l) => l({ profileId: 'q' }))
  assert.deepEqual(logins, [{ profileId: 'p' }, { profileId: 'q' }])
  offLogin()
  assert.equal(t.state.notifications.get('providers.login').size, 0)
  assert.equal(t.removed.filter((o) => o.channel === 'providers:login-event').length, 1)

  const changed = []
  const offChanged = t.api.providers.onChanged((l) => changed.push(l))
  assert.equal(t.state.notifications.get('providers.changed').size, 1)
  ;[...t.state.notifications.get('providers.changed')].forEach((l) => l({ profiles: [{ id: 'a' }] }))
  assert.deepEqual(changed, [[{ id: 'a' }]])
  offChanged()
  assert.equal(t.state.notifications.get('providers.changed').size, 0)
})
