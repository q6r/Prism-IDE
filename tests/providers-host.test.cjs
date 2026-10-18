const assert = require('node:assert/strict')
const test = require('node:test')
const path = require('node:path')
const os = require('node:os')
const load = require('./helpers/load-typescript.cjs')

// ipc/providers.ts com a fachada de chats simulada: o que muda quando o host é o dono dos chats e das tarefas.
const providerProfiles = load('src/main/ipc/providerProfiles.ts')
const flush = () => new Promise((resolve) => setImmediate(resolve))

const chat = (id, extra = {}) => ({ id, title: id, cwd: 'C:\\p', turns: [], selection: { provider: 'claude', profileId: 'p1' }, ...extra })
const task = (id) => ({ id, title: id, cwd: 'C:\\p', updatedAt: 1 })

function fixture({ binary = false } = {}) {
  const log = []
  const readdirCalls = []
  const handlers = {}, listeners = {}
  const emitted = []
  const state = {
    profiles: [
      { id: 'p1', provider: 'claude', name: 'Conta 1', enabled: true },
      { id: 'ambient-claude', provider: 'claude', name: 'Terminal', ambient: true, enabled: true }
    ],
    chats: [], tasks: { tasks: [], openIds: [], activeId: null }
  }
  const agentStore = {
    get: (key) => state[key],
    set(key, value) { log.push(`store.set:${key}`); state[key] = value }
  }
  // Fachada simulada: cada função registra a chamada; o teste ajusta o comportamento.
  const calls = {}
  const behavior = {
    listChats: async () => state.chats,
    listTasks: async () => state.tasks,
    saveTasks: async () => undefined,
    importChatDocs: async (chats) => ({ written: chats.length, skipped: [] }),
    removeChats: async () => undefined,
    reassignProfile: async () => 1,
    flushChatsNow: () => undefined,
    flushTasksNow: () => undefined
  }
  const hostChats = {}
  for (const name of Object.keys(behavior)) {
    calls[name] = []
    hostChats[name] = (...args) => { calls[name].push(args); log.push(`hostChats.${name}`); return behavior[name](...args) }
  }
  const ptyCalls = []
  const terminals = []
  const pty = {
    spawn(bin, args, options) {
      ptyCalls.push({ bin, args, options })
      const terminal = { write() {}, resize() {}, kill() {}, onData() {}, onExit() {} }
      terminals.push(terminal)
      return terminal
    }
  }
  const api = load('src/main/ipc/providers.ts', {
    electron: {
      ipcMain: { handle: (channel, fn) => { handlers[channel] = fn }, on: (channel, fn) => { listeners[channel] = fn } },
      app: { getPath: () => path.join(os.tmpdir(), 'prism-providers-host-never-written'), on() {}, emit: (...a) => { log.push(`emit:${a[0]}`); emitted.push(a) } }
    },
    child_process: { spawn: () => { throw new Error('CLI real proibida') } },
    crypto: { randomUUID: () => 'uuid-1' },
    'fs/promises': { readdir: async (dir) => { readdirCalls.push(dir); throw new Error('sem pasta') }, rename: async () => undefined, rm: async () => undefined },
    path,
    '@homebridge/node-pty-prebuilt-multiarch': pty,
    os,
    '../providers': {
      agentStore,
      createProfile: () => { throw new Error('não usado') },
      getProfile: (provider, id) => {
        const p = state.profiles.find((x) => x.id === id && x.provider === provider)
        if (!p) throw new Error('Conta não encontrada.')
        return p
      },
      profileEnvironment: () => ({}),
      providerCommand: () => ({ bin: 'cli', args: [] }),
      linkState: () => 'none',
      publicProfiles: () => state.profiles.filter((p) => !p.tombstoned).map((p) => ({ id: p.id }))
    },
    './providerProfiles': providerProfiles,
    '../hostChats': hostChats,
    // Com o binário do host, a lixeira de provider-profiles é do host (T08).
    '../host/supervisor': { hostBinaryPresent: () => binary }
  })
  api.registerProviderHandlers()
  const event = { sender: { id: 7, isDestroyed: () => false, send() {}, on() {}, once() {} }, returnValue: undefined }
  return { api, handlers, listeners, state, calls, behavior, log, emitted, ptyCalls, event, readdirCalls }
}

const running = (profileId = 'p1') => chat('busy', { pendingTurnId: 't1', selection: { provider: 'claude', profileId } })

/* ---------------- tarefas ---------------- */

test('tasks:load, tasks:save e tasks:flush passam pela fachada', async () => {
  const f = fixture()
  f.state.tasks = { tasks: [task('t')], openIds: ['t'], activeId: 't' }
  assert.equal(await f.handlers['tasks:load'](), f.state.tasks)
  assert.throws(() => f.handlers['tasks:save'](f.event, [{ id: 1 }], [], null), /Projeto inválido/)
  assert.equal(f.calls.saveTasks.length, 0)
  await f.handlers['tasks:save'](f.event, [task('a'), task('b')], ['a', 'gone'], 'b')
  assert.deepEqual(f.calls.saveTasks, [[[task('a'), task('b')], ['a'], 'b']]) // abas só de tarefas existentes
  f.listeners['tasks:flush'](f.event, [task('a')], ['a'], 'a')
  assert.deepEqual(f.event.returnValue, { ok: true })
  assert.deepEqual(f.calls.flushTasksNow, [[[task('a')], ['a'], 'a']])
  f.behavior.flushTasksNow = () => { throw new Error('disco cheio') }
  f.listeners['tasks:flush'](f.event, [], [], null)
  assert.deepEqual(f.event.returnValue, { ok: false })
})

/* ---------------- chats ---------------- */

test('chats:list e chats:delete passam pela fachada', async () => {
  const f = fixture()
  f.state.chats = [chat('a')]
  assert.deepEqual(await f.handlers['chats:list'](), [chat('a')])
  assert.equal(await f.handlers['chats:delete'](f.event, 'a'), true)
  assert.deepEqual(f.calls.removeChats, [[['a']]])
  f.behavior.removeChats = async () => { throw Object.assign(new Error('Pare a tarefa antes de excluir a conversa.'), { code: 'busy' }) }
  await assert.rejects(f.handlers['chats:delete'](f.event, 'a'), /Pare a tarefa/)
})

test('chats:save valida, confere a conta e recusa conversa em execução', async () => {
  const f = fixture()
  await assert.rejects(f.handlers['chats:save'](f.event, { id: 'x' }), /Conversa inválida/)
  await assert.rejects(f.handlers['chats:save'](f.event, chat('a', { selection: { provider: 'claude', profileId: 'nada' } })), /Conta não encontrada/)
  assert.equal(f.calls.importChatDocs.length, 0)
  assert.equal(await f.handlers['chats:save'](f.event, chat('a')), true)
  assert.deepEqual(f.calls.importChatDocs, [[[chat('a')]]])
  f.behavior.importChatDocs = async () => ({ written: 0, skipped: ['a'] })
  await assert.rejects(f.handlers['chats:save'](f.event, chat('a')), /Esta conversa está em execução/)
})

test('chats:flush responde {ok:true} por returnValue e {ok:false} em erro', () => {
  const f = fixture()
  f.listeners['chats:flush'](f.event, [chat('a'), chat('b')])
  assert.deepEqual(f.event.returnValue, { ok: true })
  assert.deepEqual(f.calls.flushChatsNow, [[[chat('a'), chat('b')]]])
  f.listeners['chats:flush'](f.event, 'lixo')
  assert.deepEqual(f.event.returnValue, { ok: false, error: 'Snapshot inválido.' })
  f.listeners['chats:flush'](f.event, [{ id: 'x' }])
  assert.deepEqual(f.event.returnValue, { ok: false, error: 'Conversa inválida.' })
  f.listeners['chats:flush'](f.event, [chat('a', { selection: { provider: 'claude', profileId: 'nada' } })])
  assert.equal(f.event.returnValue.ok, false)
  assert.equal(f.calls.flushChatsNow.length, 1) // nada inválido chegou à fachada
  f.behavior.flushChatsNow = () => { throw new Error('disco cheio') }
  f.listeners['chats:flush'](f.event, [chat('a')])
  assert.deepEqual(f.event.returnValue, { ok: false, error: 'disco cheio' })
})

/* ---------------- contas ---------------- */

test('providers:update: só desativar consulta os chats em execução', async () => {
  const f = fixture()
  f.state.chats = [running()]
  const rename = await f.handlers['providers:update'](f.event, 'p1', { name: ' Novo ' })
  await f.handlers['providers:update'](f.event, 'p1', { color: '#aabbcc' })
  await f.handlers['providers:update'](f.event, 'p1', { enabled: true })
  assert.equal(f.calls.listChats.length, 0)
  assert.deepEqual(rename, [{ id: 'p1' }, { id: 'ambient-claude' }])
  assert.equal(f.state.profiles[0].name, 'Novo'); assert.equal(f.state.profiles[0].color, '#aabbcc')
  await assert.rejects(f.handlers['providers:update'](f.event, 'p1', { enabled: false }), /Pare as tarefas desta conta antes de alterá-la/)
  assert.equal(f.calls.listChats.length, 1)
  assert.equal(f.state.profiles[0].enabled, true)
  assert.equal(f.emitted.length, 0)
  // Outra conta rodando não impede; desativa e avisa.
  f.state.chats = [running('outra')]
  await f.handlers['providers:update'](f.event, 'p1', { enabled: false })
  assert.equal(f.state.profiles[0].enabled, false)
  assert.deepEqual(f.emitted, [['prism:profile-changed', 'p1']])
  await assert.rejects(f.handlers['providers:update'](f.event, 'ambient-claude', { name: 'x' }), /conta do terminal/i)
})

test('providers:login recusa com chat rodando (lido pela fachada) e abre o terminal sem ele', async () => {
  const f = fixture()
  f.state.chats = [running()]
  await assert.rejects(f.handlers['providers:login'](f.event, 'claude', 'p1'), /Pare as tarefas desta conta antes de fazer login novamente/)
  assert.equal(f.calls.listChats.length, 1)
  assert.equal(f.ptyCalls.length, 0)
  f.state.chats = []
  assert.equal(await f.handlers['providers:login'](f.event, 'claude', 'p1', { session: 'minha-sessao' }), 'minha-sessao')
  assert.equal(f.ptyCalls.length, 1)
  assert.deepEqual(f.ptyCalls[0].args, ['auth', 'login', '--claudeai'])
  // Já aberto: a segunda tentativa é recusada.
  await assert.rejects(f.handlers['providers:login'](f.event, 'claude', 'p1'), /já está aberto/)
})

test('providers:remove recusa com chat rodando sem tocar no host nem no perfil', async () => {
  const f = fixture()
  f.state.chats = [running()]
  await assert.rejects(f.handlers['providers:remove'](f.event, 'p1'), /Pare as tarefas desta conta antes de removê-la/)
  assert.equal(f.calls.reassignProfile.length, 0)
  assert.equal(f.state.profiles[0].tombstoned, undefined)
  await assert.rejects(f.handlers['providers:remove'](f.event, 'ambient-claude'), /conta do terminal/i)
  await assert.rejects(f.handlers['providers:remove'](f.event, 'inexistente'), /Conta não encontrada/)
})

test('providers:remove: busy do host rejeita com a mensagem dele e o perfil NÃO é marcado como removido', async () => {
  const f = fixture()
  f.behavior.reassignProfile = async () => { throw Object.assign(new Error('Pare as tarefas desta conta (host).'), { code: 'busy' }) }
  await assert.rejects(f.handlers['providers:remove'](f.event, 'p1'), (err) => err.message === 'Pare as tarefas desta conta (host).')
  assert.deepEqual(f.calls.reassignProfile, [['p1']])
  assert.equal(f.state.profiles[0].tombstoned, undefined)
  assert.equal(f.state.profiles[0].enabled, true)
  assert.equal(f.log.includes('store.set:profiles'), false)
  assert.equal(f.emitted.length, 0)
})

test('providers:remove: sucesso move os chats (reassignProfile) antes do tombstone', async () => {
  const f = fixture()
  const result = await f.handlers['providers:remove'](f.event, 'p1')
  assert.deepEqual(f.calls.reassignProfile, [['p1']])
  const order = f.log.filter((l) => ['hostChats.reassignProfile', 'store.set:profiles', 'emit:prism:profile-changed'].includes(l))
  assert.deepEqual(order, ['hostChats.reassignProfile', 'store.set:profiles', 'emit:prism:profile-changed'])
  assert.equal(f.state.profiles[0].tombstoned, true)
  assert.equal(f.state.profiles[0].enabled, false)
  assert.deepEqual(result, [{ id: 'ambient-claude' }])
  await flush()
})

/* ---------------- lixeira de provider-profiles (T08) ---------------- */

test('sem binário do host a lixeira de provider-profiles é limpa', () => {
  const f = fixture({ binary: false })
  assert.equal(f.readdirCalls.length, 1)
  assert.equal(path.basename(f.readdirCalls[0]), 'provider-profiles')
})

test('com binário do host a lixeira não é tocada (o host purga as suas)', () => {
  const f = fixture({ binary: true })
  assert.deepEqual(f.readdirCalls, [])
})
