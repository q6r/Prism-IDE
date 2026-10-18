const assert = require('node:assert/strict')
const test = require('node:test')
const loadTypescript = require('./helpers/load-typescript.cjs')

const call = loadTypescript('src/shared/host/api/call.ts')
const { createHostProviders, createHostAgentCommands } = loadTypescript('src/shared/host/api/providers.ts')
const { createHostUsage } = loadTypescript('src/shared/host/api/usage.ts', { './call': call })

function setup(answer = () => ({})) {
  const calls = []
  const listeners = new Map()
  const client = {
    call(method, params, timeout) {
      calls.push({ method, params, timeout })
      try { return Promise.resolve(answer(method, params)) } catch (e) { return Promise.reject(e) }
    },
    onNotification(method, l) {
      if (!listeners.has(method)) listeners.set(method, new Set())
      listeners.get(method).add(l)
      return () => listeners.get(method).delete(l)
    }
  }
  const ipcLogin = new Set()
  const ipcChanged = new Set()
  const ipc = {
    onLogin(cb) { ipcLogin.add(cb); return () => ipcLogin.delete(cb) },
    onChanged(cb) { ipcChanged.add(cb); return () => ipcChanged.delete(cb) }
  }
  const api = createHostProviders(client, ipc)
  const emit = (method, params) => [...(listeners.get(method) ?? [])].forEach((l) => l(params))
  return { api, calls, listeners, ipcLogin, ipcChanged, emit }
}

const tick = () => new Promise((r) => setImmediate(r))

test('details e models: refresh padrão false, timeout 60000', async () => {
  const t = setup(() => ({ x: 1 }))
  await t.api.details('claude', 'p1')
  await t.api.details('codex', 'p2', true)
  await t.api.models('claude', 'p1')
  await t.api.models('codex', 'p1', true)
  assert.deepEqual(t.calls, [
    { method: 'providers.details', params: { provider: 'claude', profileId: 'p1', refresh: false }, timeout: 60000 },
    { method: 'providers.details', params: { provider: 'codex', profileId: 'p2', refresh: true }, timeout: 60000 },
    { method: 'providers.models', params: { provider: 'claude', profileId: 'p1', refresh: false }, timeout: 60000 },
    { method: 'providers.models', params: { provider: 'codex', profileId: 'p1', refresh: true }, timeout: 60000 }
  ])
})

test('list/update/rename/remove devolvem .profiles; update mescla o id', async () => {
  const t = setup(() => ({ profiles: [{ id: 'a' }] }))
  assert.deepEqual(await t.api.list(), [{ id: 'a' }])
  assert.deepEqual(await t.api.update('a', { name: 'N', enabled: false }), [{ id: 'a' }])
  assert.deepEqual(await t.api.rename('a', 'Novo'), [{ id: 'a' }])
  assert.deepEqual(await t.api.remove('a'), [{ id: 'a' }])
  assert.deepEqual(t.calls, [
    { method: 'providers.list', params: {}, timeout: undefined },
    { method: 'providers.update', params: { name: 'N', enabled: false, id: 'a' }, timeout: undefined },
    { method: 'providers.rename', params: { id: 'a', name: 'Novo' }, timeout: undefined },
    { method: 'providers.remove', params: { id: 'a' }, timeout: 60000 }
  ])
})

test('update: o id do argumento vence um id no patch', async () => {
  const t = setup(() => ({ profiles: [] }))
  await t.api.update('real', { id: 'fake', name: 'x' })
  assert.equal(t.calls[0].params.id, 'real')
})

test('create devolve o perfil, status/available usam 60000', async () => {
  const t = setup((m) => (m === 'providers.create' ? { id: 'n' } : m === 'providers.status' ? { loggedIn: true } : { available: true }))
  assert.deepEqual(await t.api.create('claude', 'Conta'), { id: 'n' })
  assert.deepEqual(await t.api.status('codex', 'p'), { loggedIn: true })
  assert.deepEqual(await t.api.available('claude'), { available: true })
  assert.deepEqual(t.calls, [
    { method: 'providers.create', params: { provider: 'claude', name: 'Conta' }, timeout: undefined },
    { method: 'providers.status', params: { provider: 'codex', id: 'p' }, timeout: 60000 },
    { method: 'providers.available', params: { provider: 'claude' }, timeout: 60000 }
  ])
})

test('login omite session/cols/rows ausentes e devolve .session', async () => {
  const t = setup(() => ({ session: 's1' }))
  assert.equal(await t.api.login('claude', 'p'), 's1')
  assert.equal(await t.api.login('claude', 'p', {}), 's1')
  assert.equal(await t.api.login('codex', 'p', { session: 'x', cols: 80, rows: 24 }), 's1')
  assert.equal(await t.api.login('codex', 'p', { session: 5, cols: '80' }), 's1')
  assert.deepEqual(t.calls.map((c) => c.params), [
    { provider: 'claude', id: 'p' },
    { provider: 'claude', id: 'p' },
    { provider: 'codex', id: 'p', session: 'x', cols: 80, rows: 24 },
    { provider: 'codex', id: 'p' }
  ])
  assert.equal(t.calls[0].timeout, undefined)
})

test('loginInput/Resize/Cancel: params e timeout 5000', async () => {
  const t = setup()
  assert.equal(t.api.loginInput('p', 'abc'), undefined)
  t.api.loginResize('p', { cols: 100, rows: 30 })
  t.api.loginCancel('p')
  t.api.loginCancel('p', 's')
  assert.deepEqual(t.calls, [
    { method: 'providers.loginInput', params: { id: 'p', text: 'abc' }, timeout: 5000 },
    { method: 'providers.loginResize', params: { id: 'p', cols: 100, rows: 30 }, timeout: 5000 },
    { method: 'providers.loginCancel', params: { id: 'p' }, timeout: 5000 },
    { method: 'providers.loginCancel', params: { id: 'p', session: 's' }, timeout: 5000 }
  ])
})

test('codexReset devolve { outcome } e usa 60000', async () => {
  const t = setup(() => ({ outcome: 'reset', extra: 1 }))
  assert.deepEqual(await t.api.codexReset('p', 'key', null), { outcome: 'reset' })
  assert.deepEqual(t.calls[0], { method: 'providers.codexReset', params: { profileId: 'p', idempotencyKey: 'key', creditId: null }, timeout: 60000 })
})

test('rejeição do host rejeita com a mesma mensagem', async () => {
  const t = setup(() => { throw Object.assign(new Error('Perfil ocupado.'), { code: 'busy' }) })
  await assert.rejects(() => t.api.remove('p'), { message: 'Perfil ocupado.', code: 'busy' })
  await assert.rejects(() => t.api.list(), /Perfil ocupado\./)
  await assert.rejects(() => t.api.login('claude', 'p'), /Perfil ocupado\./)
  const plain = setup(() => { throw { code: 'busy', message: 'ocupado' } })
  await assert.rejects(() => plain.api.rename('p', 'x'), { code: 'busy', message: 'ocupado' })
})

test('membros void engolem a rejeição', async () => {
  const unhandled = []
  const on = (e) => unhandled.push(e)
  process.on('unhandledRejection', on)
  try {
    const t = setup(() => { throw { code: 'busy', message: 'x' } })
    t.api.loginInput('p', 'a')
    t.api.loginResize('p', { cols: 1, rows: 1 })
    t.api.loginCancel('p')
    await tick(); await tick()
  } finally { process.off('unhandledRejection', on) }
  assert.deepEqual(unhandled, [])
})

test('onLogin ouve host e ipc, ignora malformada, unsub desfaz os dois', () => {
  const t = setup()
  const got = []
  const off = t.api.onLogin((e) => got.push(e))
  assert.equal(t.listeners.get('providers.login').size, 1)
  assert.equal(t.ipcLogin.size, 1)
  t.emit('providers.login', { profileId: 'p', type: 'url' })
  t.emit('providers.login', null)
  t.emit('providers.login', {})
  t.emit('providers.login', { profileId: 5 })
  ;[...t.ipcLogin].forEach((l) => l({ profileId: 'q' }))
  assert.deepEqual(got, [{ profileId: 'p', type: 'url' }, { profileId: 'q' }])
  off()
  assert.equal(t.listeners.get('providers.login').size, 0)
  assert.equal(t.ipcLogin.size, 0)
})

test('onChanged entrega params.profiles, ignora malformada, unsub desfaz os dois', () => {
  const t = setup()
  const got = []
  const off = t.api.onChanged((l) => got.push(l))
  assert.equal(t.listeners.get('providers.changed').size, 1)
  assert.equal(t.ipcChanged.size, 1)
  t.emit('providers.changed', { profiles: [{ id: 'a' }] })
  t.emit('providers.changed', null)
  t.emit('providers.changed', {})
  t.emit('providers.changed', { profiles: 'x' })
  ;[...t.ipcChanged].forEach((l) => l([{ id: 'b' }]))
  assert.deepEqual(got, [[{ id: 'a' }], [{ id: 'b' }]])
  off()
  assert.equal(t.listeners.get('providers.changed').size, 0)
  assert.equal(t.ipcChanged.size, 0)
})

test('createHostAgentCommands.list → providers.commands com timeout 60000', async () => {
  const calls = []
  const api = createHostAgentCommands({ call: async (m, p, t) => { calls.push({ m, p, t }); return [{ name: 'x' }] } })
  assert.deepEqual(await api.list('claude', 'p', '/w'), [{ name: 'x' }])
  await api.list('codex', 'p', '/w', true)
  assert.deepEqual(calls, [
    { m: 'providers.commands', p: { provider: 'claude', profileId: 'p', cwd: '/w', refresh: false }, t: 60000 },
    { m: 'providers.commands', p: { provider: 'codex', profileId: 'p', cwd: '/w', refresh: true }, t: 60000 }
  ])
})

test('createHostUsage.records: usage.records, LONG_CALL_MS, fallback só em disconnected', async () => {
  const calls = []
  let ipcCalls = 0
  const ipc = { records: async () => { ipcCalls++; return { from: 'ipc' } } }
  const make = (fn) => createHostUsage({ call: (m, p, t) => { calls.push({ m, p, t }); return fn() } }, ipc)
  assert.deepEqual(await make(async () => ({ from: 'host' })).records(), { from: 'host' })
  assert.deepEqual(calls[0], { m: 'usage.records', p: {}, t: call.LONG_CALL_MS })
  assert.equal(call.LONG_CALL_MS, 600000)
  assert.equal(ipcCalls, 0)
  assert.deepEqual(await make(async () => { throw { code: 'disconnected' } }).records(), { from: 'ipc' })
  assert.equal(ipcCalls, 1)
  await assert.rejects(() => make(async () => { throw { code: 'timeout', message: 't' } }).records(), { code: 'timeout' })
  assert.equal(ipcCalls, 1)
})
