const assert = require('node:assert/strict')
const test = require('node:test')
const load = require('./helpers/load-typescript.cjs')
const { create } = require('zustand')

const tick = () => new Promise((r) => setImmediate(r))
const chat = (tabId, token = `tok-${tabId}`) => ({ tabId, title: `T ${tabId}`, streaming: false, pending: false, token, url: `https://x/${token}` })
const status = (chats, extra = {}) => ({ running: chats.length > 0, baseUrl: 'https://x', clients: 0, chats, ...extra })
const CLEAN = { rcEnabledTabs: [], rcChats: [], rcInfo: null, rcActiveTab: null, rcModalOpen: false }
const pick = (s) => ({ rcEnabledTabs: s.rcEnabledTabs, rcChats: s.rcChats, rcInfo: s.rcInfo, rcActiveTab: s.rcActiveTab, rcModalOpen: s.rcModalOpen })

/** Loads the real store with fake deps and a fake window.prism. */
function env({ route = 'host', rcStatus = status([]), statusFails = false } = {}) {
  const saved = global.window
  const log = { statusCalls: 0, stopCalls: 0, removed: [] }
  const e = { log, route, rcStatus, statusFails, changed: new Set(), hostStatus: new Set() }
  global.window = {
    prism: {
      settings: { getAll: async () => ({}), set() {} },
      ext: { list: async () => [], onStatus() {} },
      claude: { onAgentDone() {} },
      ssh: { onStatus() {} },
      host: {
        route: () => e.route,
        onStatus: (l) => { e.hostStatus.add(l); return () => e.hostStatus.delete(l) }
      },
      remoteControl: {
        status: async () => { log.statusCalls++; if (e.statusFails) throw new Error('sem host'); return e.rcStatus },
        stop: async () => { log.stopCalls++; return { ok: true } },
        remove: (id) => log.removed.push(id),
        onChanged: (cb) => { e.changed.add(cb); return () => e.changed.delete(cb) }
      }
    }
  }
  const mod = load('src/renderer/src/store.ts', {
    zustand: { create },
    './lib/agentTasks': { useAgentTasks: { getState: () => ({}) } },
    './types': {},
    './lib/lang': { basename: (p) => p, languageFromPath: () => 'text', mediaInfo: () => null },
    './lib/fsApi': { fsApi: {} },
    './lib/notify': { notifyTaskDone() {} }
  })
  e.store = mod.useStore
  e.get = () => mod.useStore.getState()
  e.toasts = () => e.get().toasts
  e.restore = () => { global.window = saved }
  e.emitChanged = (s) => { for (const l of [...e.changed]) l(s) }
  e.emitHost = (s) => { for (const l of [...e.hostStatus]) l(s) }
  return e
}

async function scenario(opts, body) {
  const e = env(opts)
  try { await body(e) } finally { e.restore() }
}

const toastKinds = (e) => e.get().toasts.map((t) => t.kind)

// ---- remoteControlSynced ----

test('synced: restaura os chats compartilhados, o ativo é o último, rcInfo usa o token dele; modal não abre', async () => {
  await scenario({}, async (e) => {
    e.get().remoteControlSynced(status([chat('a'), chat('b')]))
    const s = e.get()
    assert.deepEqual(s.rcEnabledTabs, ['a', 'b'])
    assert.deepEqual(s.rcChats, [{ tabId: 'a', title: 'T a', token: 'tok-a' }, { tabId: 'b', title: 'T b', token: 'tok-b' }])
    assert.equal(s.rcActiveTab, 'b')
    assert.deepEqual(s.rcInfo, { baseUrl: 'https://x', token: 'tok-b' })
    assert.equal(s.rcModalOpen, false)
  })
})

test('synced: mantém o ativo se ainda compartilhado e não mexe em rcModalOpen', async () => {
  await scenario({}, async (e) => {
    e.store.setState({ rcActiveTab: 'a', rcModalOpen: true })
    e.get().remoteControlSynced(status([chat('a'), chat('b')]))
    assert.equal(e.get().rcActiveTab, 'a')
    assert.deepEqual(e.get().rcInfo, { baseUrl: 'https://x', token: 'tok-a' })
    assert.equal(e.get().rcModalOpen, true)
  })
})

test('synced: ativo removido → o último; token do ativo muda junto', async () => {
  await scenario({}, async (e) => {
    e.get().remoteControlSynced(status([chat('a'), chat('b'), chat('c')]))
    e.store.setState({ rcActiveTab: 'b' })
    e.get().remoteControlSynced(status([chat('a'), chat('c')]))
    assert.equal(e.get().rcActiveTab, 'c')
    assert.deepEqual(e.get().rcEnabledTabs, ['a', 'c'])
    assert.equal(e.get().rcInfo.token, 'tok-c')
  })
})

test('synced: token novo do ativo (relink) atualiza rcInfo', async () => {
  await scenario({}, async (e) => {
    e.get().remoteControlSynced(status([chat('a', 'old')]))
    e.get().remoteControlSynced(status([chat('a', 'new')]))
    assert.equal(e.get().rcInfo.token, 'new')
    assert.equal(e.get().rcChats[0].token, 'new')
  })
})

test('synced: sem chats, sem baseUrl ou sem token limpa tudo (inclusive o modal)', async () => {
  for (const s of [status([]), { ...status([chat('a')]), baseUrl: null }, status([{ ...chat('a'), token: undefined }])]) {
    await scenario({}, async (e) => {
      e.get().remoteControlSynced(status([chat('a')]))
      e.store.setState({ rcModalOpen: true })
      e.get().remoteControlSynced(s)
      assert.deepEqual(pick(e.get()), CLEAN)
    })
  }
})

test('synced: só os chats com token entram', async () => {
  await scenario({}, async (e) => {
    e.get().remoteControlSynced(status([chat('a'), { ...chat('b'), token: undefined }]))
    assert.deepEqual(e.get().rcEnabledTabs, ['a'])
  })
})

test('synced: parou com reason tunnel/error e havia chat → limpa e mostra toast de erro', async () => {
  for (const reason of ['tunnel', 'error']) {
    await scenario({}, async (e) => {
      e.get().remoteControlSynced(status([chat('a')]))
      e.get().remoteControlSynced({ running: false, baseUrl: null, clients: 0, chats: [], reason })
      assert.deepEqual(pick(e.get()), CLEAN)
      assert.deepEqual(toastKinds(e), ['error'])
    })
  }
})

test('synced: parou com reason empty/user não mostra toast; tunnel sem chat compartilhado também não', async () => {
  for (const reason of ['empty', 'user']) {
    await scenario({}, async (e) => {
      e.get().remoteControlSynced(status([chat('a')]))
      e.get().remoteControlSynced({ running: false, baseUrl: null, clients: 0, chats: [], reason })
      assert.deepEqual(pick(e.get()), CLEAN)
      assert.deepEqual(toastKinds(e), [])
    })
  }
  await scenario({}, async (e) => {
    e.get().remoteControlSynced({ running: false, baseUrl: null, clients: 0, chats: [], reason: 'tunnel' })
    assert.deepEqual(toastKinds(e), [])
  })
})

test('synced: running:true com reason não é parada', async () => {
  await scenario({}, async (e) => {
    e.get().remoteControlSynced(status([chat('a')], { reason: 'tunnel' }))
    assert.deepEqual(e.get().rcEnabledTabs, ['a'])
    assert.deepEqual(toastKinds(e), [])
  })
})

// ---- fiação do init ----

test('init: na rota host aplica o status do host', async () => {
  await scenario({ route: 'host', rcStatus: status([chat('a')]) }, async (e) => {
    await e.get().init()
    await tick()
    assert.equal(e.log.statusCalls, 1)
    assert.deepEqual(e.get().rcEnabledTabs, ['a'])
  })
})

test('init: na rota ipc o status é lido mas não aplicado', async () => {
  await scenario({ route: 'ipc', rcStatus: status([chat('a')]) }, async (e) => {
    await e.get().init()
    await tick()
    assert.deepEqual(pick(e.get()), CLEAN)
  })
})

test('init: status que rejeita é engolido', async () => {
  const unhandled = []
  const on = (x) => unhandled.push(x)
  process.on('unhandledRejection', on)
  try {
    await scenario({ statusFails: true }, async (e) => {
      await e.get().init()
      await tick(); await tick()
      assert.deepEqual(pick(e.get()), CLEAN)
    })
  } finally { process.off('unhandledRejection', on) }
  assert.deepEqual(unhandled, [])
})

test('init: onChanged sincroniza o store', async () => {
  await scenario({ route: 'host' }, async (e) => {
    await e.get().init()
    await tick()
    assert.equal(e.changed.size, 1)
    e.emitChanged(status([chat('a'), chat('b')]))
    assert.deepEqual(e.get().rcEnabledTabs, ['a', 'b'])
    e.emitChanged({ running: false, baseUrl: null, clients: 0, chats: [], reason: 'tunnel' })
    assert.deepEqual(e.get().rcEnabledTabs, [])
    assert.deepEqual(toastKinds(e), ['error'])
  })
})

test('init: reconexão (connected → não-connected → connected) relê o status na rota host', async () => {
  await scenario({ route: 'host', rcStatus: status([chat('a')]) }, async (e) => {
    await e.get().init()
    await tick()
    assert.equal(e.log.statusCalls, 1)
    e.emitHost({ state: 'connected' })
    assert.equal(e.log.statusCalls, 1, 'o primeiro connected não relê')
    e.emitHost({ state: 'connecting' })
    e.emitHost({ state: 'connected' })
    await tick()
    assert.equal(e.log.statusCalls, 2)
    e.rcStatus = status([chat('a'), chat('b')])
    e.emitHost({ state: 'disconnected' })
    e.emitHost({ state: 'connected' })
    await tick()
    assert.equal(e.log.statusCalls, 3)
    assert.deepEqual(e.get().rcEnabledTabs, ['a', 'b'])
  })
})

test('init: reconexão na rota ipc não relê o status', async () => {
  await scenario({ route: 'ipc' }, async (e) => {
    await e.get().init()
    await tick()
    const before = e.log.statusCalls
    e.emitHost({ state: 'connected' })
    e.emitHost({ state: 'connecting' })
    e.emitHost({ state: 'connected' })
    await tick()
    assert.equal(e.log.statusCalls, before)
  })
})

test('init: perder a conexão antes do primeiro connected não conta como reconexão', async () => {
  await scenario({ route: 'host' }, async (e) => {
    await e.get().init()
    await tick()
    const before = e.log.statusCalls
    e.emitHost({ state: 'connecting' })
    e.emitHost({ state: 'connected' })
    await tick()
    assert.equal(e.log.statusCalls, before)
  })
})

// ---- lib/remoteControl.ts no modo host ----

function libEnv({ route, enable }) {
  const saved = global.window
  const log = { push: [], enable: [], toasts: [], enabled: [], opened: [], disabled: [] }
  const chats = [{ id: 'c1', title: 'x' }]
  const state = {
    rcEnabledTabs: [], rcInfo: null,
    addToast: (kind, msg) => log.toasts.push([kind, msg]),
    openRcModal: (id) => log.opened.push(id),
    enableRemoteControl: (...a) => log.enabled.push(a),
    disableRemoteControl: (id) => log.disabled.push(id)
  }
  global.window = {
    prism: {
      host: { route: () => route.value },
      remoteControl: {
        enable: async (p) => { log.enable.push(p); return enable(p) },
        pushState: (s) => log.push.push(s)
      }
    }
  }
  const mod = load('src/renderer/src/lib/remoteControl.ts', {
    '../store': { useStore: { getState: () => state } },
    './agentChats': { useAgentChats: { getState: () => ({ chats, runtime: {} }) } },
    './remoteControlModel': {
      buildRemoteSnapshot: (c) => ({ tabId: c.id }),
      remoteTitle: (c) => c.title,
      runRemoteCommand: () => ({ ok: true })
    }
  })
  return { mod, log, state, restore: () => { global.window = saved } }
}

const OK = { ok: true, url: 'https://x/t', baseUrl: 'https://x', token: 't' }

test('remoteOnHost segue a rota de remote', () => {
  const route = { value: 'host' }
  const l = libEnv({ route, enable: async () => OK })
  try {
    assert.equal(l.mod.remoteOnHost(), true)
    route.value = 'ipc'
    assert.equal(l.mod.remoteOnHost(), false)
  } finally { l.restore() }
})

test('startRemoteControl no modo host não faz pushState', async () => {
  const l = libEnv({ route: { value: 'host' }, enable: async () => OK })
  try {
    await l.mod.startRemoteControl('c1')
    assert.deepEqual(l.log.enable, [{ tabId: 'c1', title: 'x' }])
    assert.deepEqual(l.log.enabled, [['c1', 'x', { baseUrl: 'https://x', token: 't' }]])
    assert.deepEqual(l.log.push, [])
    assert.equal(l.log.toasts.at(-1)[0], 'success')
  } finally { l.restore() }
})

test('startRemoteControl no modo IPC empurra o snapshot uma vez', async () => {
  const l = libEnv({ route: { value: 'ipc' }, enable: async () => OK })
  try {
    await l.mod.startRemoteControl('c1')
    assert.deepEqual(l.log.push, [{ tabId: 'c1' }])
  } finally { l.restore() }
})

test('startRemoteControl: enable que rejeita (gate sem hello) mostra o toast de erro e não estoura', async () => {
  const l = libEnv({ route: { value: 'host' }, enable: async () => { throw new Error('O host do Prism não respondeu.') } })
  try {
    await l.mod.startRemoteControl('c1')
    assert.equal(l.log.enabled.length, 0)
    assert.deepEqual(l.log.push, [])
    const last = l.log.toasts.at(-1)
    assert.equal(last[0], 'error')
    assert.match(last[1], /O host do Prism não respondeu\./)
  } finally { l.restore() }
})

test('startRemoteControl: ok:false do host mostra o erro e não registra o chat', async () => {
  const l = libEnv({ route: { value: 'host' }, enable: async () => ({ ok: false, error: 'Túnel indisponível' }) })
  try {
    await l.mod.startRemoteControl('c1')
    assert.equal(l.log.enabled.length, 0)
    assert.match(l.log.toasts.at(-1)[1], /Túnel indisponível/)
  } finally { l.restore() }
})

test('startRemoteControl: chat já compartilhado só reabre o painel', async () => {
  const l = libEnv({ route: { value: 'host' }, enable: async () => OK })
  try {
    l.state.rcEnabledTabs = ['c1']
    l.state.rcInfo = { baseUrl: 'b', token: 't' }
    await l.mod.startRemoteControl('c1')
    assert.deepEqual(l.log.opened, ['c1'])
    assert.equal(l.log.enable.length, 0)
  } finally { l.restore() }
})
