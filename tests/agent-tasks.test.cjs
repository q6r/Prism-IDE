const { test } = require('node:test')
const assert = require('node:assert/strict')
const load = require('./helpers/load-typescript.cjs')
const { create } = require('zustand')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const C1 = { id: 'c1', name: 'srv', host: 'h.example', port: 22, username: 'u', cwd: '/home/u' }
const C2 = { ...C1, id: 'c2' }
const RECENT = { id: 'r1', name: 'srv', host: 'h.example', port: 22, username: 'u' }

// Fresh module instance (mru/parked/initialized are module state) + fakes per scenario.
async function scenario(body) {
  const savedWindow = global.window
  const log = { toasts: [], reconnects: [], cwds: [], creates: [], saves: [] }
  let statusCb
  global.window = {
    prism: {
      tasks: { load: async () => ({ tasks: [], openIds: [], activeId: null }), save: async (...a) => log.saves.push(a), flush: () => ({ ok: true }) },
      chats: { save: async () => true },
      terminal: { setCwd: async (p) => { log.cwds.push(p) } },
      ssh: { onStatus: (cb) => { statusCb = cb } }
    },
    addEventListener: () => {}
  }
  const useStore = create(() => ({
    folderPath: null, folderName: '', workspaceFolders: [], workspaceFile: null, tabs: [], activePath: null,
    sidebarView: 'explorer', workspaceView: 'agents', remote: null, pendingChatAttachment: null, pendingClose: null,
    settings: { recentRemotes: [RECENT] },
    bumpTree: () => {},
    addToast: (kind, msg) => log.toasts.push([kind, msg]),
    requestReconnect: (r) => log.reconnects.push(r)
  }))
  let useAgentTasks
  const useAgentChats = create((set, get) => ({
    chats: [], activeId: null, init: async () => {},
    select: (id) => set({ activeId: id }),
    create: (cwd, remoteId) => {
      log.creates.push([cwd, remoteId])
      const c = { id: crypto.randomUUID(), cwd, remoteId, taskId: useAgentTasks.getState().activeId, updatedAt: Date.now() }
      set({ chats: [...get().chats, c], activeId: c.id })
    }
  }))
  try {
    useAgentTasks = load('src/renderer/src/lib/agentTasks.ts', { zustand: { create }, '../store': { useStore }, './agentChats': { useAgentChats } }).useAgentTasks
    await useAgentTasks.getState().init()
    await body({ useStore, useAgentChats, tasks: useAgentTasks, log, status: (e) => statusCb(e) })
  } finally {
    await sleep(450)
    global.window = savedWindow
  }
}
const T = (env) => env.tasks.getState()
const task = (env, id) => T(env).tasks.find((t) => t.id === id)
const tab = (path, content = 'x') => ({ path, content, savedContent: content })

test('open(cwd) on an empty active task adopts the folder and keeps dirty tabs', async () => {
  await scenario(async (env) => {
    const id = T(env).activeId
    const chatBefore = env.useAgentChats.getState().activeId
    const dirty = [tab('/p/a.ts', 'UNSAVED')]
    env.useStore.setState({ tabs: dirty, activePath: '/p/a.ts' })
    T(env).open('/p')
    const t = task(env, id)
    assert.equal(t.cwd, '/p')
    assert.equal(t.title, 'p')
    assert.equal(T(env).activeId, id)
    assert.equal(T(env).tasks.length, 1)
    assert.deepEqual(env.useStore.getState().tabs, dirty)
    assert.equal(env.useAgentChats.getState().activeId, chatBefore)
    assert.deepEqual(t.editor.tabs, dirty)
  })
})

test('adopting keeps a custom title', async () => {
  await scenario(async (env) => {
    const id = T(env).activeId
    T(env).rename(id, 'Minha tarefa')
    T(env).open('/p')
    assert.equal(task(env, id).title, 'Minha tarefa')
  })
})

test('open(cwd) of a folder bound to another task activates it; the previous one keeps its tabs', async () => {
  await scenario(async (env) => {
    const a = T(env).activeId
    T(env).open('/a')
    const aTabs = [tab('/a/1.ts', 'A')]
    env.useStore.setState({ tabs: aTabs, activePath: '/a/1.ts' })
    T(env).create()
    const b = T(env).activeId
    T(env).open('/b')
    const bTabs = [tab('/b/2.ts', 'B')]
    env.useStore.setState({ tabs: bTabs, activePath: '/b/2.ts' })
    T(env).open('/a')
    assert.equal(T(env).activeId, a)
    assert.equal(T(env).tasks.length, 2)
    assert.deepEqual(task(env, b).editor.tabs, bTabs)
    assert.deepEqual(env.useStore.getState().tabs, aTabs)
    assert.equal(env.useStore.getState().folderPath, '/a')
  })
})

test('open(cwd) of a new folder creates a task with empty tabs and does not rewrite the previous snapshot', async () => {
  await scenario(async (env) => {
    const a = T(env).activeId
    T(env).open('/a')
    env.useStore.setState({ tabs: [tab('/a/1.ts', 'A')], activePath: '/a/1.ts' })
    // what openFolder does: the store already shows the new folder when open() runs
    env.useStore.setState({ folderPath: '/new', folderName: 'new', workspaceFolders: ['/new'] })
    env.log.creates.length = 0
    T(env).open('/new')
    const n = task(env, T(env).activeId)
    assert.notEqual(n.id, a)
    assert.equal(n.cwd, '/new')
    assert.equal(n.title, 'new')
    assert.deepEqual(env.useStore.getState().tabs, [])
    assert.deepEqual(env.log.creates, [['/new', undefined]])
    assert.equal(task(env, a).editor.folderPath, '/a')
    assert.deepEqual(T(env).openIds, [a, n.id])
  })
})

test('remote task parks its connection while another task is active and gets it back', async () => {
  await scenario(async (env) => {
    const id = T(env).activeId
    env.useStore.setState({ remote: C1, folderPath: '/home/u', folderName: 'u', workspaceFolders: ['/home/u'] })
    T(env).open('/home/u', { remote: C1 })
    env.useStore.setState({ tabs: [tab('/home/u/r.ts', 'REMOTE')], activePath: '/home/u/r.ts' })
    T(env).create()
    assert.equal(env.useStore.getState().remote, null)
    assert.deepEqual(env.useStore.getState().tabs, [])
    T(env).activate(id)
    assert.equal(env.useStore.getState().remote, C1)
    assert.equal(env.useStore.getState().tabs[0].content, 'REMOTE')
    assert.equal(env.useStore.getState().folderPath, '/home/u')
    assert.ok(!env.log.cwds.includes('/home/u'), 'remote path never goes to the local terminal')
  })
})

test('remote task without a live connection shows nothing and asks to reconnect', async () => {
  await scenario(async (env) => {
    const id = T(env).activeId
    env.useStore.setState({ remote: C1, folderPath: '/home/u', folderName: 'u', workspaceFolders: ['/home/u'] })
    T(env).open('/home/u', { remote: C1 })
    env.useStore.setState({ tabs: [tab('/home/u/r.ts', 'REMOTE')], activePath: '/home/u/r.ts' })
    T(env).create()
    env.status({ id: 'c1', status: 'closed' })
    env.log.cwds.length = 0
    T(env).activate(id)
    const s = env.useStore.getState()
    assert.equal(s.folderPath, null)
    assert.deepEqual(s.tabs, [])
    assert.equal(s.remote, null)
    assert.ok(env.log.toasts.some(([k]) => k === 'info'))
    assert.deepEqual(env.log.reconnects, [RECENT])
    assert.ok(!env.log.cwds.includes('/home/u'))
  })
})

test('reconnecting restores the waiting remote task instead of creating a new one', async () => {
  await scenario(async (env) => {
    const id = T(env).activeId
    env.useStore.setState({ remote: C1, folderPath: '/home/u', folderName: 'u', workspaceFolders: ['/home/u'] })
    T(env).open('/home/u', { remote: C1 })
    env.useStore.setState({ tabs: [tab('/home/u/r.ts', 'REMOTE')], activePath: '/home/u/r.ts' })
    T(env).create()
    env.status({ id: 'c1', status: 'closed' })
    T(env).activate(id)
    const count = T(env).tasks.length
    env.useStore.setState({ remote: C2 })
    T(env).open('/home/u', { remote: C2 })
    assert.equal(T(env).tasks.length, count)
    assert.equal(T(env).activeId, id)
    const s = env.useStore.getState()
    assert.equal(s.remote, C2)
    assert.equal(s.folderPath, '/home/u')
    assert.equal(s.tabs[0].content, 'REMOTE')
  })
})

test('close(active) goes to the most recently used tab, not the last in the strip', async () => {
  await scenario(async (env) => {
    const a = T(env).activeId
    T(env).create(); const b = T(env).activeId
    T(env).create(); const c = T(env).activeId
    T(env).activate(a); T(env).activate(c); T(env).activate(b); T(env).activate(a)
    T(env).close(a)
    assert.equal(T(env).activeId, b) // strip is [a,b,c]; last would be c
    assert.deepEqual(T(env).closedIds, [a])
    assert.deepEqual(T(env).openIds, [b, c])
  })
})

test('close(A) after A,B,C,A visits goes to C', async () => {
  await scenario(async (env) => {
    const a = T(env).activeId
    T(env).create(); const b = T(env).activeId
    T(env).create(); const c = T(env).activeId
    T(env).activate(a); T(env).activate(b); T(env).activate(c); T(env).activate(a)
    T(env).close(a)
    assert.equal(T(env).activeId, c)
  })
})

test('reopenClosed brings back the last closed tab and pops it', async () => {
  await scenario(async (env) => {
    const a = T(env).activeId
    T(env).create(); const b = T(env).activeId
    T(env).create()
    T(env).close(a); T(env).close(b)
    assert.deepEqual(T(env).closedIds, [a, b])
    T(env).reopenClosed()
    assert.equal(T(env).activeId, b)
    assert.deepEqual(T(env).closedIds, [a])
    assert.ok(T(env).openIds.includes(b))
    T(env).reopenClosed()
    assert.equal(T(env).activeId, a)
    assert.deepEqual(T(env).closedIds, [])
    T(env).reopenClosed() // nothing left: no-op
    assert.equal(T(env).activeId, a)
  })
})

test('arrange applies only permutations of the open tabs', async () => {
  await scenario(async (env) => {
    const a = T(env).activeId
    T(env).create(); const b = T(env).activeId
    T(env).create(); const c = T(env).activeId
    T(env).arrange([a, b]); assert.deepEqual(T(env).openIds, [a, b, c])
    T(env).arrange([a, b, c, 'x']); assert.deepEqual(T(env).openIds, [a, b, c])
    T(env).arrange([a, a, b]); assert.deepEqual(T(env).openIds, [a, b, c])
    T(env).arrange([a, b, 'x']); assert.deepEqual(T(env).openIds, [a, b, c])
    T(env).arrange([c, a, b]); assert.deepEqual(T(env).openIds, [c, a, b])
    T(env).arrange([b, c, a]); assert.deepEqual(T(env).openIds, [b, c, a])
  })
})

test('open(cwd,{remote}) records the connection in the task snapshot', async () => {
  await scenario(async (env) => {
    const id = T(env).activeId
    env.useStore.setState({ remote: C1, folderPath: '/home/u', folderName: 'u', workspaceFolders: ['/home/u'] })
    T(env).open('/home/u', { remote: C1 })
    assert.equal(task(env, id).editor?.remote?.id, 'c1')
  })
})
