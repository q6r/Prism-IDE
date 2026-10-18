// Unit tests of the T03 TS façades (fs, search, git, workspace, sessions,
// commands, transfer, client.http, routing) against a fake HostClient.
const assert = require('node:assert/strict')
const test = require('node:test')
const loadTypescript = require('./helpers/load-typescript.cjs')

const version = loadTypescript('src/shared/host/version.ts')
const clientMod = loadTypescript('src/shared/host/client.ts', { './version': version })
const { HostClient, HostCallError } = clientMod
const callMod = loadTypescript('src/shared/host/api/call.ts')
const transferMod = loadTypescript('src/shared/host/api/transfer.ts', { '../client': clientMod })
const fsMod = loadTypescript('src/shared/host/api/fs.ts', { './call': callMod, './transfer': transferMod })
const searchMod = loadTypescript('src/shared/host/api/search.ts', { './call': callMod })
const gitMod = loadTypescript('src/shared/host/api/git.ts', { './call': callMod })
const workspaceMod = loadTypescript('src/shared/host/api/workspace.ts', { './call': callMod })
const sessionsMod = loadTypescript('src/shared/host/api/sessions.ts', { './call': callMod })
const commandsMod = loadTypescript('src/shared/host/api/commands.ts', { './call': callMod })
const { HOST_READY_DOMAINS } = loadTypescript('src/shared/host/routing.ts')

const disconnected = () => new HostCallError('disconnected', 'caiu')

/** A HostClient stand-in: records calls, answers from `handlers`, emits notifications. */
function fakeClient(handlers = {}) {
  const calls = []
  const listeners = new Map()
  const statusListeners = new Set()
  let state = 'connected'
  const client = {
    calls,
    call: async (method, params, timeoutMs) => {
      calls.push({ method, params, timeoutMs })
      const handler = handlers[method]
      if (!handler) return undefined
      if (handler instanceof Error) throw handler
      return typeof handler === 'function' ? handler(params) : handler
    },
    onNotification: (method, cb) => {
      if (!listeners.has(method)) listeners.set(method, new Set())
      listeners.get(method).add(cb)
      return () => listeners.get(method).delete(cb)
    },
    onStatus: (cb) => { statusListeners.add(cb); cb({ state, attempt: 0 }); return () => statusListeners.delete(cb) },
    status: () => ({ state, attempt: 0 }),
    emit: (method, params) => { for (const cb of [...(listeners.get(method) ?? [])]) cb(params) },
    setState: (next) => { state = next; for (const cb of [...statusListeners]) cb({ state, attempt: 0 }) }
  }
  return client
}

// ---------------------------------------------------------------- call.ts

test('readWithFallback only falls back on code "disconnected"', async () => {
  assert.equal(await callMod.readWithFallback(async () => 'host', async () => 'ipc'), 'host')
  assert.equal(await callMod.readWithFallback(async () => { throw disconnected() }, async () => 'ipc'), 'ipc')
  for (const code of ['not_found', 'timeout', 'internal', 'invalid']) {
    await assert.rejects(
      callMod.readWithFallback(async () => { throw new HostCallError(code, 'x') }, async () => 'ipc'),
      (err) => err.code === code
    )
  }
  await assert.rejects(callMod.readWithFallback(async () => { throw new Error('plain') }, async () => 'ipc'), /plain/)
  assert.equal(callMod.isDisconnected(null), false)
})

test('baseName handles both separators and trailing slashes', () => {
  assert.equal(callMod.baseName('/a/b/c.txt'), 'c.txt')
  assert.equal(callMod.baseName('C:\\a\\b\\c.txt'), 'c.txt')
  assert.equal(callMod.baseName('/a/b/dir/'), 'dir')
  assert.equal(callMod.baseName('C:\\a\\dir\\\\'), 'dir')
  assert.equal(callMod.baseName('plain'), 'plain')
})

// ------------------------------------------------------------------ fs.ts

test('sortEntries: folders first, then by name ignoring case', () => {
  const sorted = fsMod.sortEntries([
    { name: 'b.txt', isDir: false }, { name: 'Zeta', isDir: true }, { name: 'A.txt', isDir: false }, { name: 'alpha', isDir: true }
  ])
  assert.deepEqual(sorted.map((e) => e.name), ['alpha', 'Zeta', 'A.txt', 'b.txt'])
})

function fsFixture({ handlers = {}, transfer = {}, local, ipc = {} } = {}) {
  const client = fakeClient(handlers)
  const ipcCalls = []
  const ipcApi = new Proxy(ipc, {
    get: (target, key) => target[key] ?? ((...args) => { ipcCalls.push([key, args]); return Promise.resolve(`ipc:${String(key)}`) })
  })
  const api = fsMod.createHostFs({ client, transfer, local, ipc: ipcApi })
  return { client, api, ipcCalls }
}

test('fs reads fall back to IPC when disconnected; mutations do not', async () => {
  const { api, ipcCalls, client } = fsFixture({
    handlers: { 'fs.readDir': disconnected(), 'fs.listFiles': disconnected(), 'fs.readFile': disconnected(), 'fs.createFile': disconnected(), 'fs.delete': disconnected(), 'fs.move': disconnected() },
    transfer: { download: async () => { throw disconnected() } }
  })
  assert.equal(await api.readDir('/x'), 'ipc:readDir')
  assert.equal(await api.listFiles('/x'), 'ipc:listFiles')
  assert.equal(await api.readFile('/x'), 'ipc:readFile')
  assert.equal(await api.readFileBytes('/x'), 'ipc:readFileBytes')
  await assert.rejects(api.createFile('/x'), (e) => e.code === 'disconnected')
  await assert.rejects(api.delete('/x'), (e) => e.code === 'disconnected')
  await assert.rejects(api.move('/a', '/b'), (e) => e.code === 'disconnected')
  assert.deepEqual(ipcCalls.map(([k]) => k), ['readDir', 'listFiles', 'readFile', 'readFileBytes'])
  assert.equal(client.calls.find((c) => c.method === 'fs.readFile').timeoutMs, callMod.LONG_CALL_MS)
})

test('fs read errors other than disconnected propagate', async () => {
  const { api, ipcCalls } = fsFixture({ handlers: { 'fs.readFile': new HostCallError('not_found', 'Arquivo não encontrado: x') } })
  await assert.rejects(api.readFile('x'), /Arquivo não encontrado: x/)
  assert.equal(ipcCalls.length, 0)
})

test('fs.readDir sorts the host answer', async () => {
  const { api } = fsFixture({ handlers: { 'fs.readDir': [{ name: 'b', isDir: false }, { name: 'a', isDir: false }, { name: 'z', isDir: true }] } })
  assert.deepEqual((await api.readDir('/d')).map((e) => e.name), ['z', 'a', 'b'])
})

test('fs.writeFile: small text over JSON-RPC, more than the limit over transfer.upload', async () => {
  const uploads = []
  const { api, client } = fsFixture({
    handlers: { 'fs.writeFile': true },
    transfer: { upload: async (target, body) => { uploads.push({ target, body }); return target.path } }
  })
  assert.equal(await api.writeFile('/small', 'hi'), true)
  assert.deepEqual(client.calls.at(-1).params, { path: '/small', content: 'hi' })
  assert.equal(uploads.length, 0)

  assert.equal(await api.writeFile('/exact', 'x'.repeat(fsMod.WRITE_OVER_HTTP_CHARS)), true, 'exactly the limit stays on JSON-RPC')
  assert.equal(uploads.length, 0)

  const big = 'é'.repeat(fsMod.WRITE_OVER_HTTP_CHARS + 1)
  const callsBefore = client.calls.length
  assert.equal(await api.writeFile('/big', big), true)
  assert.equal(client.calls.length, callsBefore, 'no JSON-RPC call for big content')
  assert.deepEqual(uploads[0].target, { path: '/big' })
  assert.equal(new TextDecoder().decode(uploads[0].body), big)
})

test('fs.saveTempImage: jpeg becomes jpg, other types lower-cased, bad data URL rejected', async () => {
  const uploads = []
  const { api } = fsFixture({ transfer: { upload: async (target, body) => { uploads.push({ target, body }); return '/tmp/prism-img-1' } } })
  assert.equal(await api.saveTempImage('data:image/jpeg;base64,AQID'), '/tmp/prism-img-1')
  assert.deepEqual(uploads[0].target, { temp: 'jpg' })
  assert.deepEqual([...uploads[0].body], [1, 2, 3])
  await api.saveTempImage('data:image/PNG;base64,AQ==')
  assert.deepEqual(uploads[1].target, { temp: 'png' })
  await assert.rejects(api.saveTempImage('not a data url'), /Formato de imagem inválido\./)
  await assert.rejects(api.saveTempImage('data:text/plain;base64,AAAA'), /Formato de imagem inválido\./)
  assert.equal(uploads.length, 2)
})

test('fs.importPaths copies files and folders (recursively), skips missing items and failures', async () => {
  const disk = {
    '/src/a.txt': 'file', '/src/bad.txt': 'file', '/src/dir': 'dir', '/src/dir/x.txt': 'file', '/src/dir/sub': 'dir',
    '/src/dir/sub/y.txt': 'file', '/src/dir/link': null
  }
  const children = { '/src/dir': ['x.txt', 'sub', 'link'], '/src/dir/sub': ['y.txt'] }
  const kindCalls = []
  const local = {
    kind: async (p, follow) => { kindCalls.push([p, follow]); return disk[p] ?? null },
    list: async (d) => children[d]
  }
  const uploaded = []
  const transfer = {
    uploadLocal: async (target, src) => {
      if (src === '/src/bad.txt') throw new Error('EACCES')
      uploaded.push([src, target.path])
      return target.path
    }
  }
  const created = []
  const { api, client } = fsFixture({
    local, transfer,
    handlers: {
      'fs.uniquePath': ({ dir, name }) => `${dir}/${name}`,
      'fs.createDir': ({ path }) => { created.push(path); return { name: path, isDir: true } }
    }
  })
  const out = await api.importPaths(['/src/a.txt', '/src/missing', '/src/bad.txt', '', '/src/dir'], '/dest')
  assert.deepEqual(out, ['/dest/a.txt', '/dest/dir'])
  assert.deepEqual(created, ['/dest/dir', '/dest/dir/sub'])
  assert.deepEqual(uploaded, [
    ['/src/a.txt', '/dest/a.txt'], ['/src/dir/x.txt', '/dest/dir/x.txt'], ['/src/dir/sub/y.txt', '/dest/dir/sub/y.txt']
  ])
  assert.ok(kindCalls.some(([p, f]) => p === '/src/a.txt' && f === true), 'dragged item resolves links')
  assert.ok(kindCalls.some(([p, f]) => p === '/src/dir/x.txt' && f === false), 'children do not follow links')
  assert.ok(client.calls.some((c) => c.method === 'fs.uniquePath' && c.params.name === 'a.txt' && c.params.dir === '/dest'))
})

test('fs.importPaths falls back to IPC without local or uploadLocal', async () => {
  const a = fsFixture({ transfer: { uploadLocal: async () => '' } })
  assert.equal(await a.api.importPaths(['/x'], '/d'), 'ipc:importPaths')
  const b = fsFixture({ local: { kind: async () => 'file', list: async () => [] }, transfer: {} })
  assert.equal(await b.api.importPaths(['/x'], '/d'), 'ipc:importPaths')
  assert.deepEqual(a.client.calls, [])
})

test('fs mutations map to the protocol params', async () => {
  const { api, client } = fsFixture({})
  await api.rename('/a', '/b'); await api.move('/s', '/d'); await api.copyPath('/s', '/d'); await api.duplicate('/s')
  assert.deepEqual(client.calls.map((c) => [c.method, c.params]), [
    ['fs.rename', { from: '/a', to: '/b' }], ['fs.move', { src: '/s', destDir: '/d' }],
    ['fs.copyPath', { src: '/s', destDir: '/d' }], ['fs.duplicate', { path: '/s' }]
  ])
})

// ---------------------------------------------------------------- search.ts

function searchFixture(clientHandlers = {}) {
  const client = fakeClient(clientHandlers)
  const ipcCalls = []
  const ipcResult = new Set(); const ipcDone = new Set()
  const ipc = {
    run: (p) => ipcCalls.push(['run', p]),
    cancel: () => ipcCalls.push(['cancel']),
    onResult: (cb) => { ipcResult.add(cb); return () => ipcResult.delete(cb) },
    onDone: (cb) => { ipcDone.add(cb); return () => ipcDone.delete(cb) }
  }
  const api = searchMod.createHostSearch({ client, ipc })
  return { client, api, ipcCalls, ipcResult, ipcDone }
}
const tick = () => new Promise((r) => setImmediate(r))

test('search.run: remoteId goes to IPC; otherwise search.run without remoteId', () => {
  const { api, client, ipcCalls } = searchFixture()
  api.run({ id: 1, root: '/r', query: 'q', caseSensitive: false, remoteId: 'ssh1' })
  assert.equal(ipcCalls.length, 1)
  assert.equal(client.calls.length, 0)
  api.run({ id: 2, root: '/r', query: 'q', caseSensitive: true })
  assert.deepEqual(client.calls[0], { method: 'search.run', params: { id: 2, root: '/r', query: 'q', caseSensitive: true }, timeoutMs: undefined })
  assert.equal(ipcCalls.length, 1)
})

test('search.run rejecting runs the search on IPC', async () => {
  const { api, ipcCalls } = searchFixture({ 'search.run': new HostCallError('internal', 'boom') })
  const payload = { id: 3, root: '/r', query: 'q', caseSensitive: false }
  api.run(payload)
  await tick()
  assert.deepEqual(ipcCalls, [['run', payload]])
})

test('onResult/onDone listen to both host and IPC; unsubscribe removes both', () => {
  const { api, client, ipcResult, ipcDone } = searchFixture()
  const results = []; const dones = []
  const offR = api.onResult((r) => results.push(r)); const offD = api.onDone((d) => dones.push(d))
  client.emit('search.result', { id: 1, matches: [] })
  for (const cb of ipcResult) cb({ id: 2, matches: [] })
  client.emit('search.done', { id: 1, files: 0, matches: 0, truncated: false })
  for (const cb of ipcDone) cb({ id: 2, files: 0, matches: 0, truncated: false })
  assert.deepEqual(results.map((r) => r.id), [1, 2])
  assert.deepEqual(dones.map((d) => d.id), [1, 2])
  offR(); offD()
  client.emit('search.result', { id: 9, matches: [] })
  client.emit('search.done', { id: 9, files: 0, matches: 0, truncated: false })
  assert.equal(results.length, 2); assert.equal(dones.length, 2)
  assert.equal(ipcResult.size, 0); assert.equal(ipcDone.size, 0)
})

test('a search in flight gets a synthetic truncated done with partial counts when the connection leaves "connected"', () => {
  const { api, client } = searchFixture()
  const dones = []
  api.onDone((d) => dones.push(d))
  api.run({ id: 5, root: '/r', query: 'q', caseSensitive: false })
  client.emit('search.result', { id: 5, path: 'a', rel: 'a', name: 'a', matches: [{}, {}] })
  client.emit('search.result', { id: 5, path: 'b', rel: 'b', name: 'b', matches: [{}] })
  client.setState('reconnecting')
  assert.deepEqual(dones, [{ id: 5, files: 2, matches: 3, truncated: true }])
  client.setState('connected'); client.setState('reconnecting')
  assert.equal(dones.length, 1, 'only once')
})

test('a finished search does not get a synthetic done', () => {
  const { api, client } = searchFixture()
  const dones = []
  api.onDone((d) => dones.push(d))
  api.run({ id: 6, root: '/r', query: 'q', caseSensitive: false })
  client.emit('search.done', { id: 6, files: 0, matches: 0, truncated: false })
  client.setState('unavailable')
  assert.equal(dones.filter((d) => d.truncated).length, 0)
})

test('search.cancel cancels IPC and, when connected, the host', () => {
  const { api, client, ipcCalls } = searchFixture()
  api.cancel()
  assert.deepEqual(ipcCalls, [['cancel']])
  assert.deepEqual(client.calls.map((c) => [c.method, c.params]), [['search.cancel', {}]])
  client.setState('reconnecting')
  const dones = []
  api.onDone((d) => dones.push(d))
  api.cancel()
  assert.equal(client.calls.length, 1, 'no host call while disconnected')
  assert.equal(ipcCalls.length, 2)
})

test('cancel clears the in-flight set, so no truncated done follows', () => {
  const { api, client } = searchFixture()
  const dones = []
  api.onDone((d) => dones.push(d))
  api.run({ id: 7, root: '/r', query: 'q', caseSensitive: false })
  api.cancel()
  client.setState('reconnecting')
  assert.deepEqual(dones, [])
})

test('nav.findDef: remoteId → IPC; host result puts the current file first; IPC result is left alone', async () => {
  const match = (path) => ({ path, rel: path, name: path, line: 1, col: 1, preview: '' })
  const client = fakeClient({ 'search.findDef': { matches: [match('/a'), match('/b'), match('/cur'), match('/c')] } })
  const ipcResult = { matches: [match('/z'), match('/cur')] }
  const ipcCalls = []
  const nav = searchMod.createHostNav({ client, ipc: { findDef: async (p) => { ipcCalls.push(p); return ipcResult } } })
  const out = await nav.findDef({ root: '/r', word: 'w', fromPath: '/cur' })
  assert.equal(out.matches[0].path, '/cur')
  assert.equal(out.matches.length, 4)
  assert.deepEqual(client.calls[0].params, { root: '/r', word: 'w', fromPath: '/cur' })
  assert.equal(client.calls[0].timeoutMs, callMod.LONG_CALL_MS)

  const remote = await nav.findDef({ root: '/r', word: 'w', remoteId: 's', fromPath: '/cur' })
  assert.equal(remote, ipcResult)
  assert.deepEqual(remote.matches.map((m) => m.path), ['/z', '/cur'], 'not reordered')

  const dropped = searchMod.createHostNav({ client: fakeClient({ 'search.findDef': disconnected() }), ipc: { findDef: async () => ipcResult } })
  assert.equal(await dropped.findDef({ root: '/r', word: 'w' }), ipcResult)
})

// ------------------------------------------------------------------ git.ts

const GIT_CASES = [
  ['status', ['/d', 'ssh', undefined], 'git.status', { dir: '/d', stats: undefined }, true],
  ['statusAll', [['/a'], 'ssh', undefined], 'git.statusAll', { folders: ['/a'], stats: undefined }, true],
  ['branches', ['/r', 'ssh'], 'git.branches', { root: '/r' }, true],
  ['checkout', ['/r', 'main', 'ssh'], 'git.checkout', { root: '/r', branch: 'main' }, false],
  ['createBranch', ['/r', 'feat', 'ssh'], 'git.createBranch', { root: '/r', branch: 'feat' }, false],
  ['fetch', ['/r', 'ssh'], 'git.fetch', { root: '/r' }, false],
  ['pull', ['/r', 'ssh'], 'git.pull', { root: '/r' }, false],
  ['push', ['/r', 'ssh'], 'git.push', { root: '/r' }, false],
  ['stage', ['/r', 'f', 'ssh'], 'git.stage', { root: '/r', file: 'f' }, false],
  ['unstage', ['/r', 'f', 'ssh'], 'git.unstage', { root: '/r', file: 'f' }, false],
  ['stageAll', ['/r', 'ssh'], 'git.stageAll', { root: '/r' }, false],
  ['unstageAll', ['/r', 'ssh'], 'git.unstageAll', { root: '/r' }, false],
  ['discard', ['/r', 'f', true, 'ssh'], 'git.discard', { root: '/r', file: 'f', untracked: true }, false],
  ['commit', ['/r', 'msg', 'ssh'], 'git.commit', { root: '/r', message: 'msg' }, false],
  ['init', ['/d', 'ssh'], 'git.init', { dir: '/d' }, false],
  ['diff', ['/r', 'f', false, 'ssh', 'staged', 'o'], 'git.diff', { root: '/r', file: 'f', untracked: false, scope: 'staged', origPath: 'o' }, true]
]

function gitIpc(log) {
  return new Proxy({}, { get: (_, key) => (...args) => { log.push([key, args]); return Promise.resolve(`ipc:${String(key)}`) } })
}

test('git: remoteId routes every method to IPC without touching the host', async () => {
  for (const [method, args] of GIT_CASES) {
    const log = []; const client = fakeClient()
    const api = gitMod.createHostGit({ client, ipc: gitIpc(log) })
    assert.equal(await api[method](...args), `ipc:${method}`, method)
    assert.equal(client.calls.length, 0, method)
    assert.equal(log.length, 1, method)
  }
})

test('git: without remoteId each method calls git.<verb> with the protocol params and the long timeout', async () => {
  for (const [method, args, rpc, params] of GIT_CASES) {
    const noRemote = args.map((a) => (a === 'ssh' ? undefined : a))
    const log = []; const client = fakeClient({ [rpc]: 'host' })
    const api = gitMod.createHostGit({ client, ipc: gitIpc(log) })
    assert.equal(await api[method](...noRemote), 'host', method)
    assert.deepEqual(client.calls, [{ method: rpc, params, timeoutMs: callMod.LONG_CALL_MS }], method)
    assert.equal(log.length, 0)
  }
})

test('git: reads fall back to IPC when disconnected, mutations reject', async () => {
  for (const [method, args, rpc, , isRead] of GIT_CASES) {
    const noRemote = args.map((a) => (a === 'ssh' ? undefined : a))
    const log = []
    const api = gitMod.createHostGit({ client: fakeClient({ [rpc]: disconnected() }), ipc: gitIpc(log) })
    if (isRead) {
      assert.equal(await api[method](...noRemote), `ipc:${method}`, method)
      assert.equal(log.length, 1)
    } else {
      await assert.rejects(api[method](...noRemote), (e) => e.code === 'disconnected', method)
      assert.equal(log.length, 0, method)
    }
  }
})

test('git: no aiCommitMessage on the host side', () => {
  const api = gitMod.createHostGit({ client: fakeClient(), ipc: gitIpc([]) })
  assert.equal('aiCommitMessage' in api, false)
})

// -------------------------------------------------------------- workspace.ts

test('workspace: picker returning null yields null without calling the host', async () => {
  const client = fakeClient()
  const api = workspaceMod.createHostWorkspace({ client, picker: { savePath: async () => null, openPath: async () => null }, ipc: {} })
  assert.equal(await api.save(['/a']), null)
  assert.equal(await api.open(), null)
  assert.equal(client.calls.length, 0)
})

test('workspace: save → workspace.write, open → workspace.read, read falls back on disconnect', async () => {
  const client = fakeClient({ 'workspace.write': '/w.prism-workspace', 'workspace.read': { folders: ['/a'] } })
  const picker = { savePath: async (f) => `/w-${f.length}.prism-workspace`, openPath: async () => '/o.prism-workspace' }
  const api = workspaceMod.createHostWorkspace({ client, picker, ipc: {} })
  assert.equal(await api.save(['/a', '/b']), '/w.prism-workspace')
  assert.deepEqual(client.calls[0].params, { file: '/w-2.prism-workspace', folders: ['/a', '/b'] })
  assert.deepEqual(await api.open(), { folders: ['/a'] })
  assert.deepEqual(client.calls[1], { method: 'workspace.read', params: { file: '/o.prism-workspace' }, timeoutMs: undefined })
  const dropped = workspaceMod.createHostWorkspace({ client: fakeClient({ 'workspace.read': disconnected() }), picker, ipc: { read: async () => 'ipc' } })
  assert.equal(await dropped.read('/x'), 'ipc')
  assert.equal(await dropped.open(), 'ipc')
})

// ------------------------------------------------- sessions.ts / commands.ts

test('sessions: remoteId → IPC; host params; reads fall back, delete does not', async () => {
  const ipc = { list: async () => 'ipc-list', read: async () => 'ipc-read', delete: async () => 'ipc-delete' }
  const client = fakeClient({ 'sessions.list': [1], 'sessions.read': [2], 'sessions.delete': true })
  const api = sessionsMod.createHostSessions({ client, ipc })
  assert.equal(await api.list('/c', 'ssh'), 'ipc-list')
  assert.equal(await api.read('f', 'ssh'), 'ipc-read')
  assert.equal(await api.delete('f', 'ssh'), 'ipc-delete')
  assert.equal(client.calls.length, 0)
  assert.deepEqual(await api.list('/c'), [1]); assert.deepEqual(await api.read('f'), [2]); assert.equal(await api.delete('f'), true)
  assert.deepEqual(client.calls.map((c) => [c.method, c.params]), [
    ['sessions.list', { filterCwd: '/c' }], ['sessions.read', { file: 'f' }], ['sessions.delete', { file: 'f' }]
  ])
  const dropped = sessionsMod.createHostSessions({ client: fakeClient({ 'sessions.list': disconnected(), 'sessions.read': disconnected(), 'sessions.delete': disconnected() }), ipc })
  assert.equal(await dropped.list(), 'ipc-list'); assert.equal(await dropped.read('f'), 'ipc-read')
  await assert.rejects(dropped.delete('f'), (e) => e.code === 'disconnected')
})

test('commands.list sorts by localeCompare and falls back on disconnect', async () => {
  const mk = (name) => ({ name, description: '', source: 'user' })
  const client = fakeClient({ 'commands.list': [mk('/zeta'), mk('/alpha'), mk('/Beta')] })
  const api = commandsMod.createHostCommands({ client, ipc: { list: async () => 'ipc' } })
  const names = (await api.list('/p')).map((c) => c.name)
  assert.deepEqual(names, ['/alpha', '/Beta', '/zeta'].sort((a, b) => a.localeCompare(b)))
  assert.deepEqual(client.calls[0].params, { projectDir: '/p' })
  const dropped = commandsMod.createHostCommands({ client: fakeClient({ 'commands.list': disconnected() }), ipc: { list: async () => 'ipc' } })
  assert.equal(await dropped.list(), 'ipc')
})

// -------------------------------------------------------------- transfer.ts

function fakeFetch(respond) {
  const requests = []
  const impl = async (url, init) => { requests.push({ url, init }); return respond(url, init) }
  impl.requests = requests
  return impl
}
const resp = (status, body) => new Response(body, { status })

test('fetchTransfer: URL with encoded query, Bearer header, download and upload', async () => {
  const fetchImpl = fakeFetch((url, init) => (init.method === 'GET' ? resp(200, Buffer.from([9, 8, 7])) : resp(200, JSON.stringify({ path: '/written' }))))
  const t = transferMod.fetchTransfer(() => ({ base: 'http://h:1', token: 'tok' }), fetchImpl)
  assert.deepEqual([...await t.download('/a b/ç&x=1.txt')], [9, 8, 7])
  assert.equal(fetchImpl.requests[0].url, `http://h:1/files?path=${new URLSearchParams({ path: '/a b/ç&x=1.txt' }).get('path') && new URLSearchParams({ path: '/a b/ç&x=1.txt' }).toString().slice(5)}`)
  assert.equal(fetchImpl.requests[0].init.headers.Authorization, 'Bearer tok')
  assert.equal(fetchImpl.requests[0].init.method, 'GET')
  assert.equal(await t.upload({ temp: 'png' }, new Uint8Array([1])), '/written')
  assert.equal(fetchImpl.requests[1].url, 'http://h:1/files?temp=png')
  assert.equal(fetchImpl.requests[1].init.method, 'PUT')
  assert.equal(fetchImpl.requests[1].init.headers['Content-Type'], 'application/octet-stream')
  assert.equal(t.uploadLocal, undefined)
})

test('fetchTransfer: JSON error body → HostCallError; non-JSON uses status; no connection → disconnected', async () => {
  const jsonErr = transferMod.fetchTransfer(() => ({ base: 'http://h', token: 't' }), fakeFetch(() => resp(404, JSON.stringify({ code: 'not_found', message: 'Arquivo não encontrado: x' }))))
  await assert.rejects(jsonErr.download('x'), (e) => e instanceof HostCallError && e.code === 'not_found' && e.message === 'Arquivo não encontrado: x')
  const plain404 = transferMod.fetchTransfer(() => ({ base: 'http://h', token: 't' }), fakeFetch(() => resp(404, 'nope')))
  await assert.rejects(plain404.download('x'), (e) => e.code === 'not_found')
  const plain500 = transferMod.fetchTransfer(() => ({ base: 'http://h', token: 't' }), fakeFetch(() => resp(500, 'x')))
  await assert.rejects(plain500.download('x'), (e) => e.code === 'internal')
  const noHttp = transferMod.fetchTransfer(() => null, fakeFetch(() => assert.fail('must not fetch')))
  await assert.rejects(noHttp.download('x'), (e) => e.code === 'disconnected')
  const netDown = transferMod.fetchTransfer(() => ({ base: 'http://h', token: 't' }), async () => { throw new TypeError('fetch failed') })
  await assert.rejects(netDown.upload({ path: 'p' }, new Uint8Array()), (e) => e.code === 'disconnected')
})

test('toBase64/fromBase64 round trip every byte value', () => {
  const bytes = new Uint8Array(256).map((_, i) => i)
  const text = transferMod.toBase64(bytes)
  assert.equal(text, Buffer.from(bytes).toString('base64'))
  assert.deepEqual([...transferMod.fromBase64(text)], [...bytes])
  assert.equal(transferMod.toBase64(new Uint8Array()), '')
  assert.deepEqual([...transferMod.fromBase64('')], [])
})

// --------------------------------------------------------------- client.ts

test('HostClient.http() is null outside connected; base derives from the ws URL', async () => {
  const sockets = []
  class FakeSocket {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this) }
    send(d) { this.sent.push(JSON.parse(d)) }
    close() { this.readyState = 3; this.onclose?.({}) }
  }
  const HELLO = { hostId: 'h', hostName: 'pc', version: '0', protocol: { major: 1, minor: 0 }, capabilities: ['host@1'], user: { id: 'o', name: 'q', role: 'owner' } }
  async function connectTo(url) {
    const client = new HostClient({ resolve: async () => ({ url, token: 'secret' }), client: { kind: 'desktop', version: 't' }, WebSocket: FakeSocket, backoffMs: [5] })
    assert.equal(client.http(), null, 'idle')
    client.start()
    while (sockets.length === 0 || sockets.at(-1).url !== url) await new Promise((r) => setTimeout(r, 2))
    const ws = sockets.at(-1)
    ws.readyState = 1; ws.onopen({})
    assert.equal(client.http(), null, 'connecting')
    ws.onmessage({ data: JSON.stringify({ jsonrpc: '2.0', id: ws.sent[0].id, result: HELLO }) })
    return { client, ws }
  }
  const a = await connectTo('ws://h:1/rpc')
  assert.deepEqual(a.client.http(), { base: 'http://h:1', token: 'secret' })
  a.ws.close()
  assert.equal(a.client.http(), null, 'reconnecting')
  a.client.stop()
  assert.equal(a.client.http(), null, 'stopped')
  const b = await connectTo('wss://host.example:8443/rpc')
  assert.deepEqual(b.client.http(), { base: 'https://host.example:8443', token: 'secret' })
  b.client.stop()
})

// --------------------------------------------------------------- routing.ts

test('HOST_READY_DOMAINS includes the T03 domains', () => {
  for (const d of ['fs', 'search', 'git', 'workspace', 'sessions', 'commands']) assert.ok(HOST_READY_DOMAINS.includes(d), d)
})
