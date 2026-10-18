const loadTypescript = require('./load-typescript.cjs')
const routing = loadTypescript('src/shared/host/routing.ts')


/** Loads the real preload with a fake electron and HostClient; `binary` is what host:owns-chats answers. */
function boot({ binary = false } = {}) {
  const invokes = []
  const sends = []
  const ons = []
  const removed = []
  const results = new Map([['host:owns-chats', binary]])
  const exposed = {}
  const ipcRenderer = {
    invoke(channel, ...args) {
      invokes.push({ channel, args })
      const r = results.get(channel)
      return Promise.resolve(typeof r === 'function' ? r(...args) : r)
    },
    send(channel, ...args) { sends.push({ channel, args }) },
    sendSync(channel, ...args) { sends.push({ channel, args }); return { ok: true } },
    on(channel, l) { ons.push({ channel, l }) },
    removeListener(channel, l) { removed.push({ channel, l }) }
  }
  const state = { caps: [], calls: [], notifications: new Map(), status: null, statusListeners: new Set() }
  const emitStatus = (status) => { state.status = status; for (const l of [...state.statusListeners]) l(status) }
  class HostClient {
    constructor() { state.client = this }
    start() {}
    status() { return { state: 'connected' } }
    capabilities() { return state.caps }
    onStatus(l) { state.statusListeners.add(l); if (state.status) l(state.status); return () => state.statusListeners.delete(l) }
    http() { return null }
    serves(domain) { return state.caps.includes(`${domain}@1`) }
    call(method, params, timeout) {
      state.calls.push({ method, params, timeout })
      return Promise.resolve(state.answer ? state.answer(method, params) : { profiles: [] })
    }
    onNotification(method, l) {
      if (!state.notifications.has(method)) state.notifications.set(method, new Set())
      state.notifications.get(method).add(l)
      return () => state.notifications.get(method).delete(l)
    }
  }
  const empty = () => ({})
  const providersApi = loadTypescript('src/shared/host/api/providers.ts')
  const callApi = loadTypescript('src/shared/host/api/call.ts')
  const usageApi = loadTypescript('src/shared/host/api/usage.ts', { './call': callApi })
  const remoteApi = loadTypescript('src/shared/host/api/remote.ts')
  loadTypescript('src/preload/index.ts', {
    electron: { contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api } }, ipcRenderer, webUtils: { getPathForFile: () => '' } },
    '../shared/host/client': { HostClient },
    '../shared/host/routing': routing,
    '../shared/host/api/terminal': { createHostTerminal: empty, hostSettled: () => Promise.resolve(), routedTerminal: (ipc) => ipc },
    '../shared/host/api/fs': { createHostFs: empty },
    '../shared/host/api/search': { createHostNav: empty, createHostSearch: empty },
    '../shared/host/api/git': { createHostGit: empty },
    '../shared/host/api/workspace': { createHostWorkspace: empty },
    '../shared/host/api/sessions': { createHostSessions: empty },
    '../shared/host/api/commands': { createHostCommands: empty },
    '../shared/host/api/claude': { CLAUDE_EVENT_MEMBERS: [], createHostClaude: empty, hostCommitMessage: () => undefined },
    '../shared/host/api/codex': { createHostCodex: empty, hostCodexPrompts: () => ({ onQuestion: () => () => undefined, onPermission: () => () => undefined }) },
    '../shared/host/api/chats': { createHostChats: empty },
    '../shared/host/api/providers': providersApi,
    '../shared/host/api/usage': usageApi,
    '../shared/host/api/remote': remoteApi,
    './hostTransfer': { nodeLocalFiles: {}, nodeTransfer: () => ({}) }
  })
  return { api: exposed.prism, invokes, sends, ons, removed, results, state, emitStatus }
}


module.exports = { boot, routing }
