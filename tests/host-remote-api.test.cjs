const assert = require('node:assert/strict')
const test = require('node:test')
const loadTypescript = require('./helpers/load-typescript.cjs')
const { boot, routing } = require('./helpers/preload-boot.cjs')

const { createHostRemote, toRemoteControlStatus, SHARE_MS } = loadTypescript('src/shared/host/api/remote.ts')

const tick = () => new Promise((r) => setImmediate(r))
const channels = (t) => t.invokes.map((i) => i.channel)
const CONNECTED = { state: 'connected', hello: { capabilities: [] } }

function fake(answer) {
  const calls = []
  const listeners = new Map()
  const client = {
    call(method, params, timeout) {
      calls.push({ method, params, timeout })
      try { return Promise.resolve(answer ? answer(method, params) : undefined) } catch (e) { return Promise.reject(e) }
    },
    onNotification(method, l) {
      if (!listeners.has(method)) listeners.set(method, new Set())
      listeners.get(method).add(l)
      return () => listeners.get(method).delete(l)
    }
  }
  const ipcLs = { clients: new Set(), stopped: new Set(), changed: new Set() }
  const reg = (set) => (cb) => { set.add(cb); return () => set.delete(cb) }
  const ipc = { onClients: reg(ipcLs.clients), onStopped: reg(ipcLs.stopped), onChanged: reg(ipcLs.changed) }
  const notify = (params) => { for (const l of [...(listeners.get('remote.changed') ?? [])]) l(params) }
  return { calls, client, ipc, ipcLs, notify, hostCount: () => listeners.get('remote.changed')?.size ?? 0 }
}

const CHAT = { chatId: 'c1', title: 'Chat', token: 'tok', url: 'https://x/r/tok', phones: 1, streaming: true, pending: false }
const STATUS = { running: true, baseUrl: 'https://x', phones: 2, chats: [CHAT] }

// ---- API ----

test('SHARE_MS cobre o download do cloudflared (12 min)', () => assert.equal(SHARE_MS, 12 * 60_000))

test('toRemoteControlStatus mapeia o status e só inclui reason quando veio', () => {
  assert.deepEqual(toRemoteControlStatus(STATUS), {
    running: true, baseUrl: 'https://x', clients: 2,
    chats: [{ tabId: 'c1', title: 'Chat', streaming: true, pending: false, token: 'tok', url: 'https://x/r/tok' }]
  })
  const stopped = toRemoteControlStatus({ running: false, baseUrl: null, phones: 0, chats: [], reason: 'tunnel' })
  assert.deepEqual(stopped, { running: false, baseUrl: null, clients: 0, chats: [], reason: 'tunnel' })
  assert.equal('reason' in toRemoteControlStatus(STATUS), false)
  assert.equal(toRemoteControlStatus({ running: false, phones: 0, chats: [] }).baseUrl, null)
})

test('enable ok: remote.share com SHARE_MS', async () => {
  const f = fake(() => ({ url: 'u', baseUrl: 'b', token: 't' }))
  const api = createHostRemote(f.client, f.ipc)
  assert.deepEqual(await api.enable({ tabId: 'c1', title: 'T' }), { ok: true, url: 'u', baseUrl: 'b', token: 't' })
  assert.deepEqual(f.calls, [{ method: 'remote.share', params: { chatId: 'c1' }, timeout: SHARE_MS }])
})

test('enable com erro: devolve ok:false e não rejeita', async () => {
  const f = fake(() => { throw new Error('Túnel indisponível') })
  const api = createHostRemote(f.client, f.ipc)
  assert.deepEqual(await api.enable({ tabId: 'c1', title: 'T' }), { ok: false, error: 'Túnel indisponível' })
  const g = fake(() => { throw 'texto' })
  assert.deepEqual(await createHostRemote(g.client, g.ipc).enable({ tabId: 'c1', title: 'T' }), { ok: false, error: 'texto' })
})

test('remove: remote.unshare com 30 000 ms, void, sem unhandled rejection', async () => {
  const unhandled = []
  const on = (e) => unhandled.push(e)
  process.on('unhandledRejection', on)
  try {
    const f = fake(() => { throw new Error('recusou') })
    const api = createHostRemote(f.client, f.ipc)
    assert.equal(api.remove('c1'), undefined)
    await tick(); await tick(); await tick()
    // The failure re-reads the host (which also fails here: nothing else happens).
    assert.deepEqual(f.calls, [
      { method: 'remote.unshare', params: { chatId: 'c1' }, timeout: 30_000 },
      { method: 'remote.status', params: {}, timeout: undefined }
    ])
  } finally { process.off('unhandledRejection', on) }
  assert.deepEqual(unhandled, [])
})

test('remove que falha relê o status e o entrega a quem ouve onChanged', async () => {
  const f = fake((method) => { if (method === 'remote.unshare') throw new Error('recusou'); return STATUS })
  const api = createHostRemote(f.client, f.ipc)
  const seen = []
  const off = api.onChanged((status) => seen.push(status))
  api.remove('c1')
  await tick(); await tick(); await tick()
  assert.equal(seen.length, 1)
  assert.equal(seen[0].chats[0].tabId, 'c1', 'the chat is still shared on the host')
  off()
  api.remove('c1')
  await tick(); await tick(); await tick()
  assert.equal(seen.length, 1, 'no longer listening')
})

test('status: remote.status {} mapeado', async () => {
  const f = fake(() => STATUS)
  const s = await createHostRemote(f.client, f.ipc).status()
  assert.deepEqual(f.calls, [{ method: 'remote.status', params: {}, timeout: undefined }])
  assert.equal(s.clients, 2)
  assert.equal(s.chats[0].tabId, 'c1')
})

test('stop: remote.stop com 30 000 ms; rejeita se o host rejeita', async () => {
  const f = fake(() => ({}))
  assert.deepEqual(await createHostRemote(f.client, f.ipc).stop(), { ok: true })
  assert.deepEqual(f.calls, [{ method: 'remote.stop', params: {}, timeout: 30_000 }])
  const g = fake(() => { throw new Error('não deu') })
  await assert.rejects(createHostRemote(g.client, g.ipc).stop(), { message: 'não deu' })
})

test('pushState e ack são no-ops; onCommand não existe', () => {
  const f = fake()
  const api = createHostRemote(f.client, f.ipc)
  assert.equal(api.pushState({ a: 1 }), undefined)
  assert.equal(api.ack({ tabId: 'c1', action: 'send', ok: true }), undefined)
  assert.equal(f.calls.length, 0)
  assert.equal('onCommand' in api, false)
})

test('onClients: remote.changed válido → {count: phones}; também ouve o IPC; unsub desfaz os dois', () => {
  const f = fake()
  const got = []
  const off = createHostRemote(f.client, f.ipc).onClients((d) => got.push(d))
  f.notify(STATUS)
  assert.deepEqual(got, [{ count: 2 }])
  for (const l of f.ipcLs.clients) l({ count: 7 })
  assert.deepEqual(got, [{ count: 2 }, { count: 7 }])
  off()
  assert.equal(f.hostCount(), 0)
  assert.equal(f.ipcLs.clients.size, 0)
  f.notify(STATUS)
  assert.equal(got.length, 2)
})

test('onStopped: só com running:false e reason; também ouve o IPC; unsub', () => {
  const f = fake()
  const got = []
  const off = createHostRemote(f.client, f.ipc).onStopped((d) => got.push(d))
  f.notify({ ...STATUS, running: false })
  f.notify({ ...STATUS, running: true, reason: 'tunnel' })
  assert.deepEqual(got, [])
  f.notify({ running: false, baseUrl: null, phones: 0, chats: [], reason: 'tunnel' })
  assert.deepEqual(got, [{ reason: 'tunnel' }])
  for (const l of f.ipcLs.stopped) l({ reason: 'renderer' })
  assert.deepEqual(got[1], { reason: 'renderer' })
  off()
  assert.equal(f.hostCount(), 0)
  assert.equal(f.ipcLs.stopped.size, 0)
})

test('onChanged: status mapeado; inválidas ignoradas; IPC; unsub', () => {
  const f = fake()
  const got = []
  const off = createHostRemote(f.client, f.ipc).onChanged((s) => got.push(s))
  f.notify(null)
  f.notify({})
  f.notify({ running: true, chats: [] })
  f.notify({ running: true, phones: 1 })
  f.notify({ running: 'sim', phones: 1, chats: [] })
  assert.deepEqual(got, [])
  f.notify(STATUS)
  assert.deepEqual(got, [toRemoteControlStatus(STATUS)])
  for (const l of f.ipcLs.changed) l({ running: false, baseUrl: null, clients: 0, chats: [] })
  assert.equal(got.length, 2)
  off()
  assert.equal(f.hostCount(), 0)
  assert.equal(f.ipcLs.changed.size, 0)
})

// ---- roteamento com o gate (preload de verdade) ----

const HOST_ANSWER = (method) => {
  if (method === 'remote.share') return { url: 'u', baseUrl: 'b', token: 't' }
  if (method === 'remote.status') return STATUS
  return {}
}

test('routing: remote é ready e sticky', () => {
  assert.ok(routing.HOST_READY_DOMAINS.includes('remote'))
  assert.ok(routing.HOST_STICKY_DOMAINS.includes('remote'))
  assert.equal(routing.routeFor('remote', ['remote@1']), 'host')
  assert.equal(routing.routeFor('remote', ['providers@1']), 'ipc')
})

test('sem binário, os membros vão ao IPC na hora', async () => {
  const t = boot({ binary: false })
  t.results.set('rc:enable', { ok: true, url: 'ipc' })
  t.results.set('rc:status', { running: false, baseUrl: null, clients: 0, chats: [] })
  t.results.set('rc:stop', { ok: true })
  assert.deepEqual(await t.api.remoteControl.enable({ tabId: 'c1', title: 'T' }), { ok: true, url: 'ipc' })
  await t.api.remoteControl.status()
  await t.api.remoteControl.stop()
  t.api.remoteControl.remove('c1')
  t.api.remoteControl.pushState({ tabId: 'c1' })
  t.api.remoteControl.ack({ tabId: 'c1', action: 'a', ok: true })
  await tick()
  assert.deepEqual(channels(t).filter((c) => c.startsWith('rc:')), ['rc:enable', 'rc:status', 'rc:stop'])
  assert.deepEqual(t.sends.map((s) => [s.channel, s.args[0]]), [
    ['rc:remove', { tabId: 'c1' }], ['rc:state', { tabId: 'c1' }], ['rc:ack', { tabId: 'c1', action: 'a', ok: true }]
  ])
  assert.equal(t.state.calls.length, 0)
})

test('com binário, enable/status/stop/remove esperam o hello e depois vão ao host', async () => {
  const t = boot({ binary: true })
  t.state.answer = HOST_ANSWER
  const enable = t.api.remoteControl.enable({ tabId: 'c1', title: 'T' })
  const status = t.api.remoteControl.status()
  const stop = t.api.remoteControl.stop()
  t.api.remoteControl.remove('c1')
  await tick(); await tick()
  assert.equal(channels(t).some((c) => c.startsWith('rc:')), false)
  assert.equal(t.sends.length, 0)
  assert.equal(t.state.calls.length, 0)
  t.state.caps = ['host@1', 'remote@1']
  t.emitStatus(CONNECTED)
  assert.deepEqual(await enable, { ok: true, url: 'u', baseUrl: 'b', token: 't' })
  assert.equal((await status).clients, 2)
  assert.deepEqual(await stop, { ok: true })
  await tick(); await tick()
  assert.deepEqual(t.state.calls.map((c) => c.method).sort(), ['remote.share', 'remote.status', 'remote.stop', 'remote.unshare'])
  assert.equal(channels(t).some((c) => c.startsWith('rc:')), false)
  assert.equal(t.sends.length, 0)
})

test('com binário e host sem remote@1, depois do hello vai ao IPC', async () => {
  const t = boot({ binary: true })
  t.results.set('rc:status', { running: false, baseUrl: null, clients: 0, chats: [] })
  const status = t.api.remoteControl.status()
  await tick()
  assert.equal(channels(t).includes('rc:status'), false)
  t.state.caps = ['host@1', 'providers@1']
  t.emitStatus(CONNECTED)
  assert.equal((await status).running, false)
  assert.ok(channels(t).includes('rc:status'))
  assert.equal(t.state.calls.length, 0)
})

test('onClients/onStopped/onChanged/onCommand registram na hora e devolvem função, com binário e sem hello', () => {
  const t = boot({ binary: true })
  const rc = t.api.remoteControl
  const offs = [rc.onClients(() => {}), rc.onStopped(() => {}), rc.onChanged(() => {}), rc.onCommand(() => {})]
  for (const off of offs) {
    assert.equal(typeof off, 'function')
    assert.equal(typeof off.then, 'undefined')
  }
  assert.equal(t.state.notifications.get('remote.changed').size, 3)
  const chans = t.ons.map((o) => o.channel)
  assert.ok(chans.includes('rc:clients'))
  assert.ok(chans.includes('rc:stopped'))
  assert.ok(chans.includes('rc:command'))
  assert.equal(t.state.calls.length, 0)
  offs.forEach((o) => o())
  assert.equal(t.state.notifications.get('remote.changed').size, 0)
})

test('as notificações do host chegam aos callbacks do preload', () => {
  const t = boot({ binary: true })
  const seen = []
  t.api.remoteControl.onChanged((s) => seen.push(['changed', s.clients]))
  t.api.remoteControl.onClients((d) => seen.push(['clients', d.count]))
  for (const l of t.state.notifications.get('remote.changed')) l(STATUS)
  assert.deepEqual(seen.sort(), [['changed', 2], ['clients', 2]])
})

test('remote é sticky: reconectando com caps vazias continua no host', async () => {
  const t = boot({ binary: false })
  t.state.caps = ['host@1', 'remote@1']
  t.state.answer = HOST_ANSWER
  await t.api.remoteControl.status()
  assert.equal(t.state.calls.length, 1)
  t.state.caps = []
  await t.api.remoteControl.status()
  assert.equal(t.state.calls.length, 2)
  assert.equal(channels(t).includes('rc:status'), false)
  assert.equal(t.api.host.route('remote'), 'host')
})
