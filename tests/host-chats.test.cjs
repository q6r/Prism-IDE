const assert = require('node:assert/strict')
const test = require('node:test')
const load = require('./helpers/load-typescript.cjs')

// A fachada de chats e tarefas do processo main (T07): host com `chats@1` ou agentStore (ipc).
const providerProfiles = load('src/main/ipc/providerProfiles.ts')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const flush = () => new Promise((resolve) => setImmediate(resolve))

const connected = { state: 'connected' }
const hostError = (code, message = code) => Object.assign(new Error(message), { code })

/** `HostClient` falso: `onStatus` chama na hora com o status atual; `call` registra método e params. */
function fakeClient(status, caps) {
  const client = {
    status, caps, calls: [], timeouts: [], handlers: {}, listeners: new Set(), offs: 0,
    onStatus(fn) { client.listeners.add(fn); fn(client.status); return () => { client.listeners.delete(fn); client.offs++ } },
    serves(domain, major = 1) { return client.status.state === 'connected' && client.caps.includes(`${domain}@${major}`) },
    async call(method, params, timeoutMs) {
      client.timeouts.push(timeoutMs)
      client.calls.push({ method, params })
      const handler = client.handlers[method]
      if (!handler) throw new Error(`sem handler para ${method}`)
      return handler(params)
    },
    set(next) { client.status = next; for (const fn of [...client.listeners]) fn(next) }
  }
  return client
}

/** `agentStore` falso do modo ipc, com um registro das operações. */
function fakeStore(initial = {}) {
  const data = { chats: [], tasks: [], profiles: [], ...initial }
  const state = {}
  const store = {
    data, state, ops: [], failNext: null,
    get: (key) => data[key],
    set(key, value) { if (store.failNext) { const e = store.failNext; store.failNext = null; throw e } store.ops.push(['set', key]); data[key] = value },
    upsert(kind, item) { store.ops.push(['upsert', kind, item.id]); data[kind] = [...data[kind].filter((x) => x.id !== item.id), item] },
    readState: (key, fallback) => key in state ? state[key] : fallback,
    writeState(key, value) { store.ops.push(['writeState', key]); state[key] = value },
    removeChat(id) { store.ops.push(['removeChat', id]); data.chats = data.chats.filter((c) => c.id !== id) }
  }
  return store
}

/** Um agentStore que derruba o teste se for tocado: com binário presente nunca se cai para ele. */
const forbiddenStore = () => new Proxy({}, { get(_t, key) { throw new Error(`agentStore tocado (${String(key)})`) } })

function setup({ binary = true, status = { state: 'connecting' }, caps = ['chats@1'], store = fakeStore() } = {}) {
  const client = fakeClient(status, caps)
  const created = { count: 0 }
  const api = load('src/main/hostChats.ts', {
    './providers': { agentStore: store },
    './host/supervisor': { hostBinaryPresent: () => binary },
    './host/mainClient': { mainHostClient: () => { created.count++; return client } },
    './ipc/providerProfiles': providerProfiles
  })
  return { api, client, store, created }
}

const chat = (id, extra = {}) => ({ id, title: id, cwd: '', turns: [], selection: { provider: 'claude', profileId: 'p1' }, ...extra })
const task = (id) => ({ id, title: id, cwd: 'C:\\x', updatedAt: 1 })

/* ---------------- escolha do backend ---------------- */

test('sem binário: ipc, sem nem criar o cliente', async () => {
  const f = setup({ binary: false, store: forbiddenStore() })
  assert.equal(f.api.knownChatsBackend(), 'ipc')
  assert.equal(await f.api.chatsBackend(), 'ipc')
  assert.equal(f.created.count, 0)
})

test('com binário e host com chats@1: host, memorizado depois de decidido', async () => {
  const f = setup({ status: connected })
  assert.equal(f.api.knownChatsBackend(), null)
  assert.equal(await f.api.chatsBackend(), 'host')
  assert.equal(f.api.knownChatsBackend(), 'host')
  assert.equal(f.client.listeners.size, 0)
  const subscriptions = f.client.offs
  // A decisão não muda com o status depois, nem assina de novo.
  f.client.set({ state: 'disconnected' })
  assert.equal(await f.api.chatsBackend(), 'host')
  assert.equal(f.client.offs, subscriptions)
})

test('host antigo (conectado sem chats@1): ipc, e a decisão é memorizada', async () => {
  const f = setup({ status: connected, caps: ['host@1', 'files@1'] })
  assert.equal(await f.api.chatsBackend(), 'ipc')
  assert.equal(f.api.knownChatsBackend(), 'ipc')
  f.client.caps = ['chats@1']
  assert.equal(await f.api.chatsBackend(), 'ipc')
})

test('espera a conexão e decide quando ela chega', async () => {
  const f = setup()
  const pending = f.api.chatsBackend()
  await flush()
  assert.equal(f.api.knownChatsBackend(), null)
  f.client.set({ state: 'connecting' })
  f.client.set(connected)
  assert.equal(await pending, 'host')
})

test('prazo de 20 s: rejeita, não toca no agentStore e a próxima chamada tenta de novo', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = setup({ store: forbiddenStore() })
  let settled = false
  const first = f.api.chatsBackend().finally(() => { settled = true })
  const rejected = assert.rejects(first, /O host do Prism não respondeu\./)
  t.mock.timers.tick(19_999)
  await flush()
  assert.equal(settled, false)
  t.mock.timers.tick(1)
  await rejected
  assert.equal(f.api.knownChatsBackend(), null)
  assert.equal(f.client.listeners.size, 0)
  // Sem memorizar: depois que o host conecta, a mesma fachada funciona.
  const second = f.api.chatsBackend()
  f.client.set(connected)
  assert.equal(await second, 'host')
  f.client.handlers['chats.list'] = () => ({ chats: [] })
  assert.deepEqual(await f.api.listChats(), [])
})

test('incompatible rejeita sem esperar o prazo, mesmo já incompatível ao começar; nada é memorizado', async () => {
  const f = setup({ store: forbiddenStore() })
  const waiting = f.api.chatsBackend()
  const first = assert.rejects(waiting, /O host do Prism não respondeu\./)
  f.client.set({ state: 'incompatible' })
  await first
  assert.equal(f.client.listeners.size, 0)
  await assert.rejects(f.api.chatsBackend(), /O host do Prism não respondeu\./) // já incompatível
  assert.equal(f.api.knownChatsBackend(), null)
  f.client.set({ state: 'connecting' })
  const later = f.api.chatsBackend()
  f.client.set(connected)
  assert.equal(await later, 'host')
})

test('chamadas concorrentes compartilham a mesma espera', async () => {
  const f = setup()
  const a = f.api.chatsBackend(), b = f.api.chatsBackend()
  assert.equal(a, b)
  assert.equal(f.client.listeners.size, 1)
  f.client.set(connected)
  assert.deepEqual(await Promise.all([a, b, f.api.chatsBackend()]), ['host', 'host', 'host'])
})

/* ---------------- modo host ---------------- */

async function hostSetup() {
  const f = setup({ status: connected, store: forbiddenStore() })
  await f.api.chatsBackend()
  return f
}
const last = (f) => f.client.calls.at(-1)

test('host: listChats e listTasks', async () => {
  const f = await hostSetup()
  f.client.handlers['chats.list'] = () => ({ chats: [chat('a')], generation: 3 })
  assert.deepEqual(await f.api.listChats(), [chat('a')])
  assert.deepEqual(last(f), { method: 'chats.list', params: {} })
  const state = { tasks: [task('t')], openIds: ['t'], activeId: 't' }
  f.client.handlers['tasks.load'] = () => state
  assert.equal(await f.api.listTasks(), state)
  assert.deepEqual(last(f), { method: 'tasks.load', params: {} })
})

test('host: saveTasks, mergeTasks (vazio não chama) e reassignProfile', async () => {
  const f = await hostSetup()
  f.client.handlers['tasks.save'] = () => ({})
  f.client.handlers['tasks.merge'] = () => ({})
  f.client.handlers['chats.reassignProfile'] = () => ({ moved: 4 })
  await f.api.saveTasks([task('t')], ['t'], null)
  assert.deepEqual(last(f), { method: 'tasks.save', params: { tasks: [task('t')], openIds: ['t'], activeId: null } })
  await f.api.mergeTasks([])
  assert.equal(f.client.calls.length, 1)
  await f.api.mergeTasks([task('u')])
  assert.deepEqual(last(f), { method: 'tasks.merge', params: { tasks: [task('u')] } })
  assert.equal(await f.api.reassignProfile('p1'), 4)
  assert.deepEqual(last(f), { method: 'chats.reassignProfile', params: { profileId: 'p1' } })
})

test('host: reassignProfile propaga o erro busy do host', async () => {
  const f = await hostSetup()
  f.client.handlers['chats.reassignProfile'] = () => { throw hostError('busy', 'Pare as tarefas desta conta.') }
  await assert.rejects(f.api.reassignProfile('p1'), (err) => err.code === 'busy' && /Pare as tarefas/.test(err.message))
})

test('host: importChatDocs e flushChats (vazio não chama; devolvem o resultado do host)', async () => {
  const f = await hostSetup()
  assert.deepEqual(await f.api.importChatDocs([]), { written: 0, skipped: [] })
  assert.deepEqual(await f.api.flushChats([]), { written: 0, skipped: [] })
  assert.equal(f.client.calls.length, 0)
  f.client.handlers['chats.importDocs'] = () => ({ written: 1, skipped: ['b'] })
  f.client.handlers['chats.flush'] = () => ({ written: 2, skipped: [] })
  assert.deepEqual(await f.api.importChatDocs([chat('a'), chat('b')]), { written: 1, skipped: ['b'] })
  assert.deepEqual(last(f), { method: 'chats.importDocs', params: { chats: [chat('a'), chat('b')] } })
  assert.deepEqual(await f.api.flushChats([chat('a')]), { written: 2, skipped: [] })
  assert.deepEqual(last(f), { method: 'chats.flush', params: { chats: [chat('a')] } })
})

test('host: removeChats apaga um a um, ignora not_found e propaga outros erros', async () => {
  const f = await hostSetup()
  await f.api.removeChats([])
  assert.equal(f.client.calls.length, 0)
  f.client.handlers['chats.remove'] = ({ chatId }) => {
    if (chatId === 'gone') throw hostError('not_found')
    if (chatId === 'running') throw hostError('busy', 'Pare a tarefa antes de excluir a conversa.')
    return {}
  }
  await f.api.removeChats(['a', 'gone', 'c'])
  assert.deepEqual(f.client.calls.map((c) => [c.method, c.params]), [
    ['chats.remove', { chatId: 'a' }], ['chats.remove', { chatId: 'gone' }], ['chats.remove', { chatId: 'c' }]
  ])
  f.client.calls.length = 0
  await assert.rejects(f.api.removeChats(['a', 'running', 'c']), (err) => err.code === 'busy')
  assert.deepEqual(f.client.calls.map((c) => c.params.chatId), ['a', 'running']) // para no erro
  // Um erro sem código também sobe.
  f.client.handlers['chats.remove'] = () => { throw new Error('rede') }
  await assert.rejects(f.api.removeChats(['x']), /rede/)
})

test('host: a primeira chamada espera 120 s; depois de um sucesso usa o padrão do cliente; falha mantém 120 s', async () => {
  const f = await hostSetup()
  f.client.handlers['chats.list'] = () => ({ chats: [] })
  f.client.handlers['tasks.load'] = () => ({ tasks: [], openIds: [], activeId: null })
  let fail = true
  f.client.handlers['chats.remove'] = () => { if (fail) throw hostError('busy'); return {} }
  await assert.rejects(f.api.removeChats(['a']), (err) => err.code === 'busy')
  await assert.rejects(f.api.removeChats(['a']), (err) => err.code === 'busy')
  assert.deepEqual(f.client.timeouts, [120000, 120000])
  fail = false
  await f.api.removeChats(['a'])
  await f.api.listChats()
  await f.api.listTasks()
  assert.deepEqual(f.client.timeouts, [120000, 120000, 120000, undefined, undefined])
})

/* ---------------- modo ipc ---------------- */

const ipcSetup = (initial) => { const store = fakeStore(initial); return { ...setup({ binary: false, store }), store } }

test('ipc: listChats e listTasks leem o agentStore (tabs padrão sem estado salvo)', async () => {
  const f = ipcSetup({ chats: [chat('a')], tasks: [task('t')] })
  assert.deepEqual(await f.api.listChats(), [chat('a')])
  assert.deepEqual({ ...(await f.api.listTasks()) }, { tasks: [task('t')], openIds: [], activeId: null })
  f.store.state['task-tabs'] = { openIds: ['t'], activeId: 't' }
  assert.deepEqual({ ...(await f.api.listTasks()) }, { tasks: [task('t')], openIds: ['t'], activeId: 't' })
})

test('ipc: saveTasks, mergeTasks e importChatDocs gravam no agentStore', async () => {
  const f = ipcSetup({ chats: [chat('a', { title: 'velha' })], tasks: [task('old')] })
  await f.api.saveTasks([task('t')], ['t'], 't')
  assert.deepEqual(f.store.data.tasks, [task('t')])
  assert.deepEqual(f.store.state['task-tabs'], { openIds: ['t'], activeId: 't' })
  f.store.ops.length = 0
  await f.api.mergeTasks([])
  assert.deepEqual(f.store.ops, [])
  await f.api.mergeTasks([task('t'), task('u')])
  assert.deepEqual(f.store.ops, [['upsert', 'tasks', 't'], ['upsert', 'tasks', 'u']])
  f.store.ops.length = 0
  assert.deepEqual(await f.api.importChatDocs([]), { written: 0, skipped: [] })
  assert.deepEqual(f.store.ops, [])
  assert.deepEqual(await f.api.importChatDocs([chat('a', { title: 'nova' }), chat('b')]), { written: 2, skipped: [] })
  assert.deepEqual(f.store.ops, [['upsert', 'chats', 'a'], ['upsert', 'chats', 'b']])
  assert.equal(f.store.data.chats.find((c) => c.id === 'a').title, 'nova')
})

test('ipc: importChatDocs propaga a recusa do repositório (conversa em execução)', async () => {
  const f = ipcSetup()
  f.store.upsert = () => { throw new Error('Esta conversa está em execução. Aguarde antes de substituir seu histórico.') }
  await assert.rejects(f.api.importChatDocs([chat('a')]), /em execução/)
})

test('ipc: flushChats troca só os chats enviados', async () => {
  const f = ipcSetup({ chats: [chat('a', { title: 'velha' }), chat('keep')] })
  assert.deepEqual(await f.api.flushChats([]), { written: 0, skipped: [] })
  assert.deepEqual(f.store.ops, [])
  assert.deepEqual(await f.api.flushChats([chat('a', { title: 'nova' })]), { written: 1, skipped: [] })
  assert.deepEqual(f.store.data.chats.map((c) => [c.id, c.title]), [['keep', 'keep'], ['a', 'nova']])
})

test('ipc: removeChats usa removeChat e propaga o erro de chat em execução', async () => {
  const f = ipcSetup({ chats: [chat('a'), chat('b')] })
  await f.api.removeChats([])
  assert.deepEqual(f.store.ops, [])
  await f.api.removeChats(['a'])
  assert.deepEqual(f.store.data.chats.map((c) => c.id), ['b'])
  f.store.removeChat = () => { throw new Error('Pare a tarefa antes de excluir a conversa.') }
  await assert.rejects(f.api.removeChats(['b']), /Pare a tarefa/)
})

test('ipc: reassignProfile move para a conta do terminal e devolve quantos', async () => {
  const f = ipcSetup({ chats: [chat('a'), chat('b', { selection: { provider: 'codex', profileId: 'p1' }, resume: { route: 'codex:p1' } }), chat('c', { selection: { provider: 'claude', profileId: 'other' } })] })
  assert.equal(await f.api.reassignProfile('p1'), 2)
  const byId = Object.fromEntries(f.store.data.chats.map((c) => [c.id, c]))
  assert.equal(byId.a.selection.profileId, 'ambient-claude')
  assert.equal(byId.b.selection.profileId, 'ambient-codex'); assert.equal(byId.b.resume, undefined)
  assert.equal(byId.c.selection.profileId, 'other')
  f.store.ops.length = 0
  assert.equal(await f.api.reassignProfile('ninguem'), 0)
  assert.deepEqual(f.store.ops, [])
})

test('binário presente com host sem chats@1: as funções usam o agentStore', async () => {
  const store = fakeStore({ chats: [chat('a')] })
  const f = setup({ status: connected, caps: ['host@1'], store })
  assert.deepEqual(await f.api.listChats(), [chat('a')])
  await f.api.removeChats(['a'])
  assert.deepEqual(store.data.chats, [])
  assert.equal(f.client.calls.length, 0)
})

/* ---------------- escritas síncronas do fechamento ---------------- */

test('flushChatsNow/flushTasksNow no ipc gravam na hora e lançam se a gravação falhar', () => {
  const f = ipcSetup({ chats: [chat('a', { title: 'velha' })] })
  f.api.flushChatsNow([chat('a', { title: 'nova' })])
  assert.equal(f.store.data.chats[0].title, 'nova')
  f.api.flushTasksNow([task('t')], ['t'], 't')
  assert.deepEqual(f.store.data.tasks, [task('t')])
  assert.deepEqual(f.store.state['task-tabs'], { openIds: ['t'], activeId: 't' })
  assert.equal(f.api.pendingHostWrites(), 0)
  f.store.failNext = new Error('disco cheio')
  assert.throws(() => f.api.flushChatsNow([chat('a')]), /disco cheio/)
  f.store.failNext = new Error('disco cheio')
  assert.throws(() => f.api.flushTasksNow([task('t')], [], null), /disco cheio/)
  assert.equal(f.api.pendingHostWrites(), 0)
})

test('flushChatsNow/flushTasksNow no host rastreiam a escrita até o host responder', async () => {
  const f = await hostSetup()
  const flushed = deferred(), saved = deferred()
  f.client.handlers['chats.flush'] = () => flushed.promise
  f.client.handlers['tasks.save'] = () => saved.promise
  f.api.flushChatsNow([chat('a')])
  assert.equal(f.api.pendingHostWrites(), 1)
  f.api.flushTasksNow([task('t')], ['t'], 't')
  assert.equal(f.api.pendingHostWrites(), 2)
  await flush()
  assert.deepEqual(f.client.calls.map((c) => c.method), ['chats.flush', 'tasks.save'])
  assert.deepEqual(f.client.calls[1].params, { tasks: [task('t')], openIds: ['t'], activeId: 't' })
  flushed.resolve({ written: 1, skipped: [] }); await flush()
  assert.equal(f.api.pendingHostWrites(), 1)
  saved.resolve({}); await flush()
  assert.equal(f.api.pendingHostWrites(), 0)
})

test('com binário e backend indefinido: rastreia e só escreve depois de decidir (host)', async () => {
  const f = setup({ store: forbiddenStore() })
  f.client.handlers['chats.flush'] = () => ({ written: 1, skipped: [] })
  f.api.flushChatsNow([chat('a')])
  assert.equal(f.api.pendingHostWrites(), 1)
  await flush()
  assert.equal(f.client.calls.length, 0)
  f.client.set(connected)
  await f.api.drainHostWrites(1000)
  assert.equal(f.api.pendingHostWrites(), 0)
  assert.deepEqual(f.client.calls.map((c) => c.method), ['chats.flush'])
})

test('com binário e backend indefinido: se o host decidir ipc, grava no agentStore depois', async () => {
  const store = fakeStore({ chats: [chat('a', { title: 'velha' })] })
  const f = setup({ store })
  f.api.flushChatsNow([chat('a', { title: 'nova' })])
  f.api.flushTasksNow([task('t')], ['t'], null)
  assert.equal(f.api.pendingHostWrites(), 2)
  assert.equal(store.data.chats[0].title, 'velha')
  f.client.set({ state: 'connected' }); f.client.caps = ['host@1']
  f.client.set(connected)
  await f.api.drainHostWrites(1000)
  assert.equal(f.api.pendingHostWrites(), 0)
  assert.equal(store.data.chats[0].title, 'nova')
  assert.deepEqual(store.data.tasks, [task('t')])
})

test('escrita rastreada que falha vira só console.warn', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  const f = await hostSetup()
  f.client.handlers['chats.flush'] = () => { throw hostError('busy', 'ocupado') }
  f.api.flushChatsNow([chat('a')])
  await f.api.drainHostWrites(1000)
  assert.equal(f.api.pendingHostWrites(), 0)
  assert.equal(warn.mock.callCount(), 1)
  assert.deepEqual(warn.mock.calls[0].arguments, ['[host] chats.flush:', 'ocupado'])
})

/* ---------------- drainHostWrites ---------------- */

test('drainHostWrites: sem escritas pendentes resolve na hora', async () => {
  const f = setup({ binary: false })
  const started = Date.now()
  await f.api.drainHostWrites(5000)
  assert.ok(Date.now() - started < 500)
})

test('drainHostWrites espera as escritas pendentes', async () => {
  const f = setup({ binary: false })
  const a = deferred(), b = deferred()
  f.api.trackHostWrite(a.promise, 'a'); f.api.trackHostWrite(b.promise, 'b')
  let done = false
  const draining = f.api.drainHostWrites(5000).then(() => { done = true })
  await sleep(20)
  assert.equal(done, false)
  a.resolve(); await sleep(20)
  assert.equal(done, false)
  b.resolve()
  await draining
  assert.equal(f.api.pendingHostWrites(), 0)
})

test('drainHostWrites respeita o prazo com uma escrita que nunca termina', async () => {
  const f = setup({ binary: false })
  f.api.trackHostWrite(new Promise(() => {}), 'eterna')
  const started = Date.now()
  await f.api.drainHostWrites(60)
  const elapsed = Date.now() - started
  assert.ok(elapsed >= 40 && elapsed < 2000, `levou ${elapsed} ms`)
  assert.equal(f.api.pendingHostWrites(), 1)
})

test('drainHostWrites inclui escritas rastreadas durante o dreno', async () => {
  const f = setup({ binary: false })
  const a = deferred(), b = deferred()
  f.api.trackHostWrite(a.promise, 'a')
  let done = false
  const draining = f.api.drainHostWrites(5000).then(() => { done = true })
  await sleep(10)
  f.api.trackHostWrite(b.promise, 'b') // nasce depois do início do dreno
  a.resolve(); await sleep(30)
  assert.equal(done, false)
  b.resolve()
  await draining
  assert.equal(f.api.pendingHostWrites(), 0)
})

test('drainHostWrites não rejeita quando uma escrita falha', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  const f = setup({ binary: false })
  const ok = deferred()
  f.api.trackHostWrite(Promise.reject(new Error('x')), 'falha')
  f.api.trackHostWrite(ok.promise, 'ok')
  const draining = f.api.drainHostWrites(5000)
  ok.resolve()
  await draining
  assert.equal(f.api.pendingHostWrites(), 0)
  assert.deepEqual(warn.mock.calls.map((c) => c.arguments), [['[host] falha:', 'x']])
})
