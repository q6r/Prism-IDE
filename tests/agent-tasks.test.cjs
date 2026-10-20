const { test } = require('node:test')
const assert = require('node:assert/strict')
const load = require('./helpers/load-typescript.cjs')
const { create } = require('zustand')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const C1 = { id: 'c1', name: 'srv', host: 'h.example', port: 22, username: 'u', cwd: '/home/u' }
const C2 = { ...C1, id: 'c2' }
const RECENT = { id: 'r1', name: 'srv', host: 'h.example', port: 22, username: 'u' }

// Fresh module instance (mru/parked/initialized are module state) + fakes per scenario.
async function scenario(body, { initialize = true } = {}) {
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
    ready: true, chats: [], activeId: null, init: async () => {},
    select: (id) => set({ activeId: id }),
    create: (cwd, remoteId) => {
      log.creates.push([cwd, remoteId])
      const c = { id: crypto.randomUUID(), cwd, remoteId, taskId: useAgentTasks.getState().activeId, updatedAt: Date.now() }
      set({ chats: [...get().chats, c], activeId: c.id })
    }
  }))
  try {
    useAgentTasks = load('src/renderer/src/lib/agentTasks.ts', { zustand: { create }, '../store': { useStore }, './agentChats': { useAgentChats } }).useAgentTasks
    if (initialize) await useAgentTasks.getState().init()
    await body({ useStore, useAgentChats, tasks: useAgentTasks, log, status: (e) => statusCb(e) })
  } finally {
    await sleep(450)
    global.window = savedWindow
  }
}
const T = (env) => env.tasks.getState()
const task = (env, id) => T(env).tasks.find((t) => t.id === id)
const tab = (path, content = 'x') => ({ path, content, savedContent: content })

test('saved tasks and folders load before chat history without creating replacements or losing a task switch', async () => {
  await scenario(async env => {
    let complete
    const history = new Promise(resolve => { complete = resolve })
    window.prism.tasks.load = async () => ({ tasks: [
      { id: 'a', title: 'A', cwd: '/a', activeChatId: 'chat-a', updatedAt: 1 },
      { id: 'b', title: 'B', cwd: '/b', activeChatId: 'chat-b', updatedAt: 2 }
    ], openIds: ['a', 'b'], activeId: 'a' })
    env.useAgentChats.setState({ ready: false, init: async () => {
      await history
      env.useAgentChats.setState({ ready: true, chats: [
        { id: 'chat-a', cwd: '/a', taskId: 'a', updatedAt: 1 },
        { id: 'chat-b', cwd: '/b', taskId: 'b', updatedAt: 2 }
      ] })
    } })
    const loading = T(env).init()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(T(env).ready, true)
    assert.equal(T(env).restoringChats, true)
    assert.equal(env.useStore.getState().folderPath, '/a')
    assert.deepEqual(env.log.creates, [])
    T(env).activate('b')
    assert.equal(env.useStore.getState().folderPath, '/b')
    assert.equal(task(env, 'a').activeChatId, 'chat-a')
    assert.deepEqual(env.log.creates, [])
    env.useStore.setState({ tabs: [tab('/b/dirty.ts', 'UNSAVED WHILE LOADING')], activePath: '/b/dirty.ts' })
    complete()
    await loading
    assert.equal(T(env).activeId, 'b')
    assert.equal(T(env).restoringChats, false)
    assert.equal(env.useAgentChats.getState().activeId, 'chat-b')
    assert.deepEqual(env.log.creates, [])
    assert.equal(env.useStore.getState().tabs[0].content, 'UNSAVED WHILE LOADING')
  }, { initialize: false })
})

test('a task load timeout waits for the host snapshot and retries without saving an empty replacement', async () => {
  await scenario(async env => {
    let complete, reads = 0
    const history = new Promise(resolve => { complete = resolve })
    window.prism.tasks.load = async () => {
      reads++
      if (reads === 1) throw new Error('RPC timeout while store initializes')
      return { tasks: [{ id: 'saved-task', title: 'Preserved task', cwd: '/saved', activeChatId: 'saved-chat', updatedAt: 1 }], openIds: ['saved-task'], activeId: 'saved-task' }
    }
    env.useAgentChats.setState({ ready: false, init: async () => {
      await history
      env.useAgentChats.setState({ ready: true, chats: [{ id: 'saved-chat', taskId: 'saved-task', cwd: '/saved', updatedAt: 1 }] })
    } })
    const loading = T(env).init()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(reads, 1)
    assert.equal(T(env).ready, false)
    assert.deepEqual(env.log.creates, [])
    assert.deepEqual(env.log.saves, [])
    complete()
    await loading
    assert.equal(reads, 2)
    assert.equal(T(env).ready, true)
    assert.equal(T(env).activeId, 'saved-task')
    assert.equal(env.useAgentChats.getState().activeId, 'saved-chat')
    assert.deepEqual(env.log.creates, [])
    await sleep(425)
    assert.equal(env.log.saves.length, 1)
    assert.deepEqual(env.log.saves[0][0].map(task => task.id), ['saved-task'])
  }, { initialize: false })
})

test('a repeated task load failure does not cache a rejected initialization or write empty tasks', async () => {
  await scenario(async env => {
    let reads = 0
    window.prism.tasks.load = async () => { reads++; throw new Error('Temporarily unavailable') }
    await assert.rejects(T(env).init(), /Temporarily unavailable/)
    assert.equal(reads, 2)
    assert.equal(T(env).ready, false)
    assert.deepEqual(env.log.creates, [])
    assert.deepEqual(env.log.saves, [])
    window.prism.tasks.load = async () => ({ tasks: [{ id: 'recovered', title: 'Recovered task', cwd: '/recovered', activeChatId: 'recovered-chat', updatedAt: 1 }], openIds: ['recovered'], activeId: 'recovered' })
    env.useAgentChats.setState({ chats: [{ id: 'recovered-chat', taskId: 'recovered', cwd: '/recovered', updatedAt: 1 }] })
    await T(env).init()
    assert.equal(T(env).activeId, 'recovered')
    assert.equal(env.useAgentChats.getState().activeId, 'recovered-chat')
    assert.deepEqual(env.log.creates, [])
  }, { initialize: false })
})

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
