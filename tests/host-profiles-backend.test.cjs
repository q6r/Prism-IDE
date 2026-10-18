const assert = require('node:assert/strict')
const test = require('node:test')
const load = require('./helpers/load-typescript.cjs')

// A fachada de perfis do hostChats.ts (T08): profilesBackend, storedProfiles, importHostProfiles, setProfileLink, hostProfileList.
const providerProfiles = load('src/main/ipc/providerProfiles.ts')

function fakeClient(status, caps) {
  const client = {
    status: () => client.current, current: status, caps, calls: [], handlers: {}, listeners: new Set(),
    onStatus(fn) { client.listeners.add(fn); fn(client.current); return () => { client.listeners.delete(fn) } },
    serves(domain, major = 1) { return client.current.state === 'connected' && client.caps.includes(`${domain}@${major}`) },
    async call(method, params) {
      client.calls.push({ method, params })
      const handler = client.handlers[method]
      if (!handler) throw new Error(`sem handler para ${method}`)
      return handler(params)
    }
  }
  return client
}

const forbiddenStore = () => new Proxy({}, { get(_t, key) { throw new Error(`agentStore tocado (${String(key)})`) } })

function setup({ binary = true, hello = { capabilities: ['chats@1', 'providers@1'] }, caps = ['chats@1'], store = forbiddenStore(), status } = {}) {
  const client = fakeClient(status ?? (hello ? { state: 'connected', hello } : { state: 'connected' }), caps)
  const api = load('src/main/hostChats.ts', {
    './providers': { agentStore: store },
    './host/supervisor': { hostBinaryPresent: () => binary },
    './host/mainClient': { mainHostClient: () => client },
    './ipc/providerProfiles': providerProfiles
  })
  return { api, client, store }
}

test('profilesBackend: sem binário → ipc', async () => {
  const f = setup({ binary: false })
  assert.equal(await f.api.profilesBackend(), 'ipc')
  assert.equal(f.client.calls.length, 0)
})

test('profilesBackend: host com chats@1 e providers@1 → host', async () => {
  const f = setup()
  assert.equal(await f.api.profilesBackend(), 'host')
})

test('profilesBackend: host com chats@1 sem providers@1 → ipc (memorizado)', async () => {
  const f = setup({ hello: { capabilities: ['chats@1'] } })
  assert.equal(await f.api.profilesBackend(), 'ipc')
  f.client.current = { state: 'connected', hello: { capabilities: ['chats@1', 'providers@1'] } }
  assert.equal(await f.api.profilesBackend(), 'ipc')
})

test('profilesBackend: host sem chats@1 → ipc, mesmo anunciando providers@1', async () => {
  const f = setup({ caps: ['providers@1'], hello: { capabilities: ['providers@1'] } })
  assert.equal(await f.api.profilesBackend(), 'ipc')
})

test('profilesBackend: sem hello rejeita e a próxima tentativa decide', async () => {
  const f = setup({ hello: null })
  await assert.rejects(() => f.api.profilesBackend(), { message: 'O host do Prism não respondeu.' })
  f.client.current = { state: 'connected', hello: { capabilities: ['chats@1', 'providers@1'] } }
  assert.equal(await f.api.profilesBackend(), 'host')
})

test('profilesBackend: host memorizado não muda quando reconecta sem hello', async () => {
  const f = setup()
  assert.equal(await f.api.profilesBackend(), 'host')
  f.client.current = { state: 'disconnected' }
  assert.equal(await f.api.profilesBackend(), 'host')
})

test('storedProfiles no ipc lê o agentStore', async () => {
  const store = { get: (key) => (key === 'profiles' ? [{ id: 'a', traycerLink: { root: 'r' } }] : []) }
  const f = setup({ hello: { capabilities: ['chats@1'] }, store })
  assert.deepEqual(await f.api.storedProfiles(), [{ id: 'a', traycerLink: { root: 'r' } }])
  assert.equal(f.client.calls.length, 0)
})

test('storedProfiles no host chama providers.stored', async () => {
  const f = setup()
  f.client.handlers['providers.stored'] = () => ({ profiles: [{ id: 'h' }] })
  assert.deepEqual(await f.api.storedProfiles(), [{ id: 'h' }])
  assert.deepEqual(f.client.calls, [{ method: 'providers.stored', params: {} }])
})

test('hostProfileList chama providers.list e devolve .profiles', async () => {
  const f = setup()
  f.client.handlers['providers.list'] = () => ({ profiles: [{ id: 'p' }] })
  assert.deepEqual(await f.api.hostProfileList(), [{ id: 'p' }])
})

test('importHostProfiles([]) não chama nada; com perfis chama providers.importProfiles', async () => {
  const f = setup()
  f.client.handlers['providers.importProfiles'] = () => ({})
  await f.api.importHostProfiles([])
  assert.equal(f.client.calls.length, 0)
  await f.api.importHostProfiles([{ id: 'a' }])
  assert.deepEqual(f.client.calls, [{ method: 'providers.importProfiles', params: { profiles: [{ id: 'a' }] } }])
})

test('setProfileLink manda { id, link } (inclusive null) e devolve a lista', async () => {
  const f = setup()
  f.client.handlers['providers.setLink'] = () => ({ profiles: [{ id: 'a' }] })
  const link = { root: 'r', providerId: 'x', profileId: 'y' }
  assert.deepEqual(await f.api.setProfileLink('a', link), [{ id: 'a' }])
  assert.deepEqual(await f.api.setProfileLink('a', null), [{ id: 'a' }])
  assert.deepEqual(f.client.calls, [
    { method: 'providers.setLink', params: { id: 'a', link } },
    { method: 'providers.setLink', params: { id: 'a', link: null } }
  ])
})

test('setProfileLink propaga a recusa do host (busy)', async () => {
  const f = setup()
  f.client.handlers['providers.setLink'] = () => { throw Object.assign(new Error('Perfil em uso.'), { code: 'busy' }) }
  await assert.rejects(() => f.api.setProfileLink('a', null), { code: 'busy', message: 'Perfil em uso.' })
})
