import { useAgentTasks } from './lib/agentTasks'
import { create } from 'zustand'
import {
  Tab,
  Settings,
  SidebarView,
  Toast,
  LayoutKey,
  ExtInfo,
  SessionRef,
  RemoteState,
  RecentRemote,
  CodeAttachment
} from './types'
import { basename, languageFromPath, mediaInfo } from './lib/lang'
import { fsApi } from './lib/fsApi'
import { notifyTaskDone } from './lib/notify'

/** Path equality across separators and (on Windows) letter case. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')
  const x = norm(a), y = norm(b)
  return x === y || (/^[a-z]:\//i.test(x) && x.toLowerCase() === y.toLowerCase())
}

let toastSeq = 0

interface PrismState {
  workspaceView: 'agents' | 'editor' | 'browser'
  setWorkspaceView: (view: 'agents' | 'editor' | 'browser') => void
  folderPath: string | null
  folderName: string
  workspaceFolders: string[]
  workspaceFile: string | null
  tabs: Tab[]
  activePath: string | null

  sidebarView: SidebarView
  sidebarOpen: boolean
  terminalOpen: boolean
  pendingTermCmd: string | null
  pendingChatAttachment: CodeAttachment | null
  chatOpen: boolean
  settingsOpen: boolean
  settingsSection: string
  paletteOpen: boolean
  quickOpenOpen: boolean

  settings: Settings
  extensions: ExtInfo[]
  cursor: { line: number; col: number }
  treeVersion: number
  toasts: Toast[]
  pendingClose: string | null
  openSessionReq: SessionRef | null
  remote: RemoteState | null
  pendingRemoteConnect: RecentRemote | null

  // Remote control (phone tunnel): which chats are shared (each with its own
  // link token), the tunnel and the link shown for the active chat, and the
  // connection modal. `rcInfo.token` is always the ACTIVE chat's token.
  rcEnabledTabs: string[]
  rcChats: { tabId: string; title: string; token: string }[]
  rcInfo: { baseUrl: string; token: string } | null
  rcActiveTab: string | null
  rcModalOpen: boolean

  init: () => Promise<void>
  setRemote: (r: RemoteState | null) => void
  disconnectRemote: () => void
  connectRemote: (
    cfg: Parameters<Window['prism']['ssh']['connect']>[0] & { hostId?: string }
  ) => Promise<{
    ok: boolean
    error?: string
  }>
  requestReconnect: (r: RecentRemote) => void
  consumeReconnect: () => void
  refreshSettings: () => Promise<void>
  updateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void
  loadExtensions: () => Promise<void>
  setExtEnabled: (id: string, enabled: boolean) => Promise<void>
  setExtConfig: (id: string, config: Record<string, unknown>) => Promise<void>
  openFolderDialog: () => Promise<void>
  openFolder: (path: string) => Promise<void>
  openWorkspaceFolders: (folders: string[], file: string | null) => Promise<void>
  openWorkspaceFile: (file: string) => Promise<void>
  openFile: (path: string) => Promise<void>
  openFileAsText: (path: string) => Promise<void>
  openDiff: (absPath: string, name: string, original: string, modified: string, language: string) => void
  closeTab: (path: string) => void
  closeTabsUnder: (target: string) => void
  requestCloseTab: (path: string) => void
  closeOthers: (path: string) => void
  closeAll: () => void
  closeSaved: () => void
  confirmCloseSave: () => Promise<void>
  confirmCloseDiscard: () => void
  cancelClose: () => void
  setActive: (path: string) => void
  cycleTab: (dir: number) => void
  updateContent: (path: string, content: string) => void
  saveTab: (path: string) => Promise<void>
  saveActive: () => Promise<void>
  saveAll: () => Promise<void>
  reloadOpenFiles: () => Promise<void>

  setSidebarView: (v: SidebarView) => void
  toggleSidebar: () => void
  toggleTerminal: () => void
  openTerminal: () => void
  runInTerminal: (cmd: string) => void
  consumeTermCmd: () => void
  toggleChat: () => void
  sendChatAttachment: (att: CodeAttachment) => void
  consumeChatAttachment: () => void
  enableRemoteControl: (
    tabId: string,
    title: string,
    info: { baseUrl: string; token: string }
  ) => void
  disableRemoteControl: (tabId: string) => void
  openRcModal: (tabId: string) => void
  closeRcModal: () => void
  stopRemoteControl: () => Promise<void>
  /** Main stopped the tunnel on its own (rc:stopped): forget every shared chat. */
  remoteControlStopped: (reason: string) => void
  /**
   * The host's sharing state (T09: `remote.status` or `remote.changed`): the
   * chats shared from any window, with their links; a stop forgets them all.
   */
  remoteControlSynced: (status: Awaited<ReturnType<Window['prism']['remoteControl']['status']>>) => void
  openSession: (ref: SessionRef) => void
  consumeOpenSession: () => void
  setSettingsOpen: (v: boolean) => void
  /** Opens Settings on a section (e.g. 'providers'); omitted keeps the last one. */
  openSettings: (section?: string) => void
  setSettingsSection: (section: string) => void
  traycerImportOpen: boolean
  setTraycerImportOpen: (open: boolean) => void
  togglePalette: () => void
  toggleQuickOpen: () => void
  toggleWordWrap: () => void
  setCursor: (line: number, col: number) => void
  bumpTree: () => void

  setLayout: (key: LayoutKey, value: number) => void
  persistLayout: () => void

  addToast: (kind: Toast['kind'], message: string) => void
  removeToast: (id: string) => void
}

const DEFAULT_SETTINGS: Settings = {
  model: '',
  oneMillionContext: true,
  effort: 'high',
  thinkingEnabled: true,
  chatEngine: 'agent',
  permissionMode: 'default',
  animations: true,
  notifyOnAsk: true,
  notifyOnDone: true,
  fontSize: 14,
  tabSize: 2,
  theme: 'prism-dark',
  wordWrap: false,
  autoSave: false,
  recentFolders: [],
  recentWorkspaces: [],
  recentRemotes: [],
  sidebarWidth: 252,
  chatWidth: 380,
  terminalHeight: 250,
  apiKeyConfigured: false
}

export const useStore = create<PrismState>((set, get) => ({
  workspaceView: 'agents',
  setWorkspaceView: (workspaceView) => set({ workspaceView, sidebarOpen: workspaceView === 'editor' }),
  folderPath: null,
  folderName: '',
  workspaceFolders: [],
  workspaceFile: null,
  tabs: [],
  activePath: null,

  sidebarView: 'explorer',
  sidebarOpen: false,
  terminalOpen: false,
  pendingTermCmd: null,
  pendingChatAttachment: null,
  chatOpen: true,
  settingsOpen: false,
  settingsSection: 'general',
  paletteOpen: false,
  quickOpenOpen: false,

  settings: DEFAULT_SETTINGS,
  extensions: [],
  cursor: { line: 1, col: 1 },
  treeVersion: 0,
  toasts: [],
  pendingClose: null,
  openSessionReq: null,
  remote: null,
  pendingRemoteConnect: null,

  rcEnabledTabs: [],
  rcChats: [],
  rcInfo: null,
  rcActiveTab: null,
  rcModalOpen: false,

  init: async () => {
    await get().refreshSettings()
    await get().loadExtensions()
    window.prism.ext.onStatus(({ id, status, detail }) => {
      set((st) => ({
        extensions: st.extensions.map((e) => (e.id === id ? { ...e, status, detail } : e))
      }))
    })
    // Safety net: when the chat panel is *closed*, its in-component listener is
    // unmounted, so notify here that a background task finished. (When the chat
    // is open, the ChatSession handles the ping — gated on chatOpen, no double.)
    window.prism.claude.onAgentDone(({ aborted }) => {
      if (!aborted && !get().chatOpen && get().settings.notifyOnDone) {
        notifyTaskDone('Claude · tarefa concluída', 'O agente terminou.')
        get().addToast('success', '✓ Claude terminou a tarefa')
      }
    })
    // Drop the remote state if the SSH connection drops or errors.
    window.prism.ssh.onStatus(({ id, status, message }) => {
      const r = get().remote
      if (r && r.id === id && (status === 'closed' || status === 'error')) {
        set({
          remote: null,
          folderPath: null,
          folderName: '',
          workspaceFolders: [],
          tabs: [],
          activePath: null
        })
        get().addToast(
          status === 'error' ? 'error' : 'info',
          status === 'error' ? `SSH: ${message || 'erro'}` : `Desconectado de ${r.host}`
        )
      }
    })
    // With `remote@1` the host owns the sharing (T09) and it outlives the
    // window: restore it now, follow it from any window (`remote.changed`) and
    // read it again after a reconnect (a restarted host forgot every link).
    const rc = window.prism.remoteControl
    const onHost = (): boolean => window.prism.host.route('remote') === 'host'
    const resync = (): void => {
      void rc.status().then((status) => { if (onHost()) get().remoteControlSynced(status) }, () => undefined)
    }
    rc.onChanged((status) => get().remoteControlSynced(status))
    resync()
    let seen = false
    let lost = false
    window.prism.host.onStatus(({ state }) => {
      if (state !== 'connected') { lost = seen; return }
      if (lost && onHost()) resync()
      seen = true
      lost = false
    })
  },

  setRemote: (r) => set({ remote: r }),
  disconnectRemote: () => {
    const r = get().remote
    if (r) window.prism.ssh.disconnect(r.id)
    set({
      remote: null,
      folderPath: null,
      folderName: '',
      workspaceFolders: [],
      workspaceFile: null,
      tabs: [],
      activePath: null
    })
    get().addToast('info', 'Desconectado do servidor')
  },
  connectRemote: async (cfg) => {
    const res = await window.prism.ssh.connect(cfg)
    if (!res.ok || !res.id) return { ok: false, error: res.error }
    const home = (await window.prism.ssh.home(res.id)) || '.'
    // The window becomes remote: open the remote home as the workspace and
    // drop local tabs (avoid mixing local & remote files).
    set({
      remote: { id: res.id, name: cfg.name || cfg.host, host: cfg.host, port: cfg.port || 22, username: cfg.username, cwd: home },
      folderPath: home,
      folderName: basename(home) || cfg.host,
      workspaceFolders: [home],
      workspaceFile: null,
      tabs: [],
      activePath: null,
      sidebarOpen: get().workspaceView === 'editor',
      sidebarView: 'explorer'
    })
    // Record it in "recents" so it can be reopened from the welcome screen.
    const recentRemotes = await window.prism.app.addRecentRemote({
      hostId: cfg.hostId,
      name: cfg.name || cfg.host,
      host: cfg.host,
      port: cfg.port || 22,
      username: cfg.username,
      authType: cfg.authType,
      keyPath: cfg.keyPath
    })
    set((st) => ({ settings: { ...st.settings, recentRemotes } }))
    get().bumpTree()
    // The connection becomes (or returns to) a task of its own.
    useAgentTasks.getState().open(home, { remote: get().remote })
    get().addToast('success', `Conectado a ${cfg.host}`)
    return { ok: true }
  },
  requestReconnect: (r) =>
    set({ pendingRemoteConnect: r, sidebarOpen: true, sidebarView: 'remote' }),
  consumeReconnect: () => set({ pendingRemoteConnect: null }),

  refreshSettings: async () => {
    const s = await window.prism.settings.getAll()
    set({ settings: { ...DEFAULT_SETTINGS, ...s } })
  },

  updateSetting: (key, value) => {
    set((st) => ({ settings: { ...st.settings, [key]: value } as Settings }))
    window.prism.settings.set(key, value)
  },

  loadExtensions: async () => {
    const list = await window.prism.ext.list()
    set({ extensions: list })
  },

  setExtEnabled: async (id, enabled) => {
    const list = await window.prism.ext.setEnabled(id, enabled)
    set({ extensions: list })
  },

  setExtConfig: async (id, config) => {
    const list = await window.prism.ext.setConfig(id, config)
    set({ extensions: list })
  },

  openFolderDialog: async () => {
    const path = await window.prism.dialog.openFolder()
    if (path) await get().openFolder(path)
  },

  openFolder: async (path: string) => {
    // Validate the folder is readable before switching — guards against stale
    // recents, missing folders, or relative paths that would break the explorer.
    try {
      await fsApi.readDir(path)
    } catch {
      get().addToast('error', `Não foi possível abrir a pasta: ${path}`)
      const recents = await window.prism.app.getRecents()
      set((st) => ({ settings: { ...st.settings, recentFolders: recents } }))
      return
    }
    set({
      folderPath: path,
      folderName: basename(path),
      workspaceFolders: [path],
      workspaceFile: null,
      sidebarOpen: get().workspaceView === 'editor',
      sidebarView: 'explorer'
    })
    await window.prism.terminal.setCwd(path)
    const recents = await window.prism.app.addRecent(path)
    set((st) => ({ settings: { ...st.settings, recentFolders: recents } }))
    get().bumpTree()
    // Bind the folder to a task: adopt it in an empty task, switch to the
    // task that already has it, or start a new one.
    useAgentTasks.getState().open(path, get().remote ? { remote: get().remote } : undefined)
  },

  openWorkspaceFolders: async (folders: string[], file: string | null) => {
    if (!folders.length) {
      get().addToast('error', 'O workspace não tem nenhuma pasta válida.')
      return
    }
    const primary = folders[0]
    set({
      folderPath: primary,
      folderName: basename(primary),
      workspaceFolders: folders,
      workspaceFile: file,
      sidebarOpen: get().workspaceView === 'editor',
      sidebarView: 'explorer'
    })
    await window.prism.terminal.setCwd(primary)
    const recents = await window.prism.app.addRecent(primary)
    set((st) => ({ settings: { ...st.settings, recentFolders: recents } }))
    // Track the workspace file itself so it can be reopened (all folders) later.
    if (file) {
      const recentWorkspaces = await window.prism.app.addRecentWorkspace(file)
      set((st) => ({ settings: { ...st.settings, recentWorkspaces } }))
    }
    get().bumpTree()
    useAgentTasks.getState().open(primary, get().remote ? { remote: get().remote } : undefined)
  },

  openWorkspaceFile: async (file: string) => {
    const ws = await window.prism.workspace.read(file)
    if (ws && ws.folders.length) {
      await get().openWorkspaceFolders(ws.folders, ws.file)
    } else {
      get().addToast('error', 'Não foi possível abrir o workspace (arquivo inválido ou sem pastas).')
    }
  },

  openFile: async (path: string) => {
    set({ workspaceView: 'editor' })
    // Same file through another spelling (git toplevel "C:/x" vs explorer
    // "C:\\x", drive-letter case) must reuse its tab, never open a second one
    // whose save could overwrite unsaved edits in the first.
    const existing = get().tabs.find((t) => (!t.kind || t.kind === 'file' || t.kind === 'media') && samePath(t.path, path))
    if (existing) {
      set({ activePath: existing.path })
      return
    }
    try {
      // Media files open in a preview/player instead of the text editor.
      const media = mediaInfo(path)
      if (media) {
        const b64 = await fsApi.readFileBytes(path)
        const tab: Tab = {
          path,
          name: basename(path),
          language: '',
          content: '',
          savedContent: '',
          kind: 'media',
          mediaKind: media.kind,
          mediaUrl: `data:${media.mime};base64,${b64}`
        }
        set((st) => ({ tabs: [...st.tabs, tab], activePath: path }))
        return
      }
      const content = await fsApi.readFile(path)
      const tab: Tab = {
        path,
        name: basename(path),
        language: languageFromPath(path),
        content,
        savedContent: content
      }
      set((st) => ({ tabs: [...st.tabs, tab], activePath: path }))
    } catch {
      get().addToast('error', `Não foi possível abrir ${basename(path)}`)
    }
  },

  openFileAsText: async (path: string) => {
    try {
      const content = await fsApi.readFile(path)
      set((st) => ({
        tabs: st.tabs.map((t) =>
          t.path === path
            ? {
                ...t,
                kind: 'file',
                language: languageFromPath(path),
                content,
                savedContent: content,
                mediaUrl: undefined,
                mediaKind: undefined
              }
            : t
        ),
        activePath: path
      }))
    } catch {
      get().addToast('error', `Não foi possível abrir ${basename(path)} como texto`)
    }
  },

  openDiff: (absPath, name, original, modified, language) => {
    const id = `diff:${absPath}`
    set((st) => {
      const tab: Tab = {
        path: id,
        name: `${name} (diff)`,
        language,
        content: modified,
        savedContent: modified,
        kind: 'diff',
        original
      }
      // Refreshing an open diff updates it in place instead of moving it last.
      const at = st.tabs.findIndex((t) => t.path === id)
      return { tabs: at >= 0 ? st.tabs.map((t, i) => (i === at ? tab : t)) : [...st.tabs, tab], activePath: id }
    })
  },

  closeTab: (path: string) => {
    set((st) => {
      const idx = st.tabs.findIndex((t) => t.path === path)
      const tabs = st.tabs.filter((t) => t.path !== path)
      let activePath = st.activePath
      if (st.activePath === path) {
        activePath = tabs.length ? tabs[Math.max(0, idx - 1)].path : null
      }
      return { tabs, activePath }
    })
  },

  // Close the tab for `target` and, when it's a folder, every open tab inside it
  // (also matches diff tabs, whose path is prefixed with "diff:"). Used after a
  // delete so removed files don't linger in the editor and spam read errors.
  closeTabsUnder: (target: string) =>
    set((st) => {
      const t = target.replace(/[\\/]+$/, '')
      const isUnder = (p: string): boolean => {
        const real = p.startsWith('diff:') ? p.slice(5) : p
        return real === t || real.startsWith(t + '/') || real.startsWith(t + '\\')
      }
      const tabs = st.tabs.filter((tab) => !isUnder(tab.path))
      let activePath = st.activePath
      if (activePath && isUnder(activePath)) {
        activePath = tabs.length ? tabs[tabs.length - 1].path : null
      }
      return { tabs, activePath }
    }),

  requestCloseTab: (path: string) => {
    const tab = get().tabs.find((t) => t.path === path)
    if (tab && tab.content !== tab.savedContent) {
      set({ pendingClose: path, activePath: path })
    } else {
      get().closeTab(path)
    }
  },

  closeOthers: (path: string) =>
    set((st) => ({ tabs: st.tabs.filter((t) => t.path === path), activePath: path })),

  closeAll: () => set({ tabs: [], activePath: null }),

  closeSaved: () =>
    set((st) => {
      const tabs = st.tabs.filter((t) => t.content !== t.savedContent)
      const activePath = tabs.find((t) => t.path === st.activePath)
        ? st.activePath
        : tabs[0]?.path ?? null
      return { tabs, activePath }
    }),

  confirmCloseSave: async () => {
    const path = get().pendingClose
    if (!path) return
    await get().saveTab(path)
    get().closeTab(path)
    set({ pendingClose: null })
  },

  confirmCloseDiscard: () => {
    const path = get().pendingClose
    if (path) get().closeTab(path)
    set({ pendingClose: null })
  },

  cancelClose: () => set({ pendingClose: null }),

  setActive: (path: string) => set({ activePath: path }),

  cycleTab: (dir: number) => {
    const { tabs, activePath } = get()
    if (tabs.length < 2) return
    const idx = tabs.findIndex((t) => t.path === activePath)
    const next = (idx + dir + tabs.length) % tabs.length
    set({ activePath: tabs[next].path })
  },

  updateContent: (path: string, content: string) =>
    set((st) => ({
      tabs: st.tabs.map((t) => (t.path === path ? { ...t, content } : t))
    })),

  saveTab: async (path: string) => {
    const tab = get().tabs.find((t) => t.path === path)
    if (!tab) return
    try {
      await fsApi.writeFile(path, tab.content)
      set((st) => ({
        tabs: st.tabs.map((t) => (t.path === path ? { ...t, savedContent: t.content } : t))
      }))
    } catch {
      get().addToast('error', `Falha ao salvar ${tab.name}`)
    }
  },

  saveActive: async () => {
    const active = get().activePath
    if (active) await get().saveTab(active)
  },

  saveAll: async () => {
    const dirty = get().tabs.filter((t) => t.kind !== 'diff' && t.content !== t.savedContent)
    await Promise.all(dirty.map((t) => get().saveTab(t.path)))
  },

  // Re-read open file tabs from disk (e.g. after the agent rewinds the code).
  reloadOpenFiles: async () => {
    const tabs = get().tabs
    const next = await Promise.all(
      tabs.map(async (t) => {
        if (t.kind && t.kind !== 'file') return t
        try {
          const content = await fsApi.readFile(t.path)
          return { ...t, content, savedContent: content }
        } catch {
          return t
        }
      })
    )
    set({ tabs: next })
  },

  setSidebarView: (v) =>
    set((st) => ({ sidebarView: v, sidebarOpen: st.sidebarView === v ? !st.sidebarOpen : true })),
  toggleSidebar: () => set((st) => ({ sidebarOpen: !st.sidebarOpen })),
  toggleTerminal: () => set((st) => ({ terminalOpen: !st.terminalOpen })),
  openTerminal: () => set({ terminalOpen: true }),
  runInTerminal: (cmd) => set({ terminalOpen: true, pendingTermCmd: cmd }),
  consumeTermCmd: () => set({ pendingTermCmd: null }),
  toggleChat: () => set((st) => ({ chatOpen: !st.chatOpen })),
  sendChatAttachment: (att) => set({ chatOpen: true, pendingChatAttachment: att, workspaceView: 'agents' }),
  consumeChatAttachment: () => set({ pendingChatAttachment: null }),

  enableRemoteControl: (tabId, title, info) =>
    set((st) => ({
      rcEnabledTabs: st.rcEnabledTabs.includes(tabId)
        ? st.rcEnabledTabs
        : [...st.rcEnabledTabs, tabId],
      rcChats: [...st.rcChats.filter((c) => c.tabId !== tabId), { tabId, title, token: info.token }],
      rcInfo: info,
      rcActiveTab: tabId,
      rcModalOpen: true
    })),
  disableRemoteControl: (tabId) => {
    // Revokes this chat's link in main; the last shared chat also takes the
    // tunnel down, so the next share always gets a brand-new link.
    window.prism.remoteControl.remove(tabId)
    set((st) => {
      const rcChats = st.rcChats.filter((c) => c.tabId !== tabId)
      if (!rcChats.length) return { rcEnabledTabs: [], rcChats: [], rcInfo: null, rcActiveTab: null, rcModalOpen: false }
      const rcActiveTab = st.rcActiveTab === tabId || !rcChats.some((c) => c.tabId === st.rcActiveTab)
        ? rcChats[rcChats.length - 1].tabId : st.rcActiveTab
      const active = rcChats.find((c) => c.tabId === rcActiveTab)
      return {
        rcEnabledTabs: st.rcEnabledTabs.filter((id) => id !== tabId),
        rcChats,
        rcActiveTab,
        rcInfo: st.rcInfo && active ? { baseUrl: st.rcInfo.baseUrl, token: active.token } : st.rcInfo
      }
    })
  },
  openRcModal: (tabId) =>
    set((st) => {
      const chat = st.rcChats.find((c) => c.tabId === tabId)
      return {
        rcModalOpen: true,
        rcActiveTab: tabId,
        // The QR/link always carry the token of the chat being shown.
        rcInfo: st.rcInfo && chat ? { baseUrl: st.rcInfo.baseUrl, token: chat.token } : st.rcInfo
      }
    }),
  closeRcModal: () => set({ rcModalOpen: false }),
  stopRemoteControl: async () => {
    await window.prism.remoteControl.stop()
    set({ rcEnabledTabs: [], rcChats: [], rcInfo: null, rcActiveTab: null, rcModalOpen: false })
    get().addToast('info', 'Controle remoto encerrado')
  },
  remoteControlStopped: (reason) => {
    const had = get().rcEnabledTabs.length > 0
    set({ rcEnabledTabs: [], rcChats: [], rcInfo: null, rcActiveTab: null, rcModalOpen: false })
    // A user stop or the last unshare already said so; only an unexpected end needs a word.
    if (had && (reason === 'tunnel' || reason === 'error')) {
      get().addToast('error', 'O túnel do controle remoto caiu. Os links foram encerrados.')
    }
  },
  remoteControlSynced: (status) => {
    if (!status.running && status.reason) return get().remoteControlStopped(status.reason)
    const baseUrl = status.baseUrl
    const rcChats = status.chats.flatMap((c) => (c.token ? [{ tabId: c.tabId, title: c.title, token: c.token }] : []))
    if (!baseUrl || !rcChats.length) {
      set({ rcEnabledTabs: [], rcChats: [], rcInfo: null, rcActiveTab: null, rcModalOpen: false })
      return
    }
    set((st) => {
      // The modal stays on the chat it shows while that chat is still shared.
      const rcActiveTab = st.rcActiveTab && rcChats.some((c) => c.tabId === st.rcActiveTab)
        ? st.rcActiveTab : rcChats[rcChats.length - 1].tabId
      const active = rcChats.find((c) => c.tabId === rcActiveTab) ?? rcChats[rcChats.length - 1]
      return { rcEnabledTabs: rcChats.map((c) => c.tabId), rcChats, rcActiveTab, rcInfo: { baseUrl, token: active.token } }
    })
  },
  openSession: (ref) => set({ chatOpen: true, openSessionReq: ref, workspaceView: 'agents' }),
  consumeOpenSession: () => set({ openSessionReq: null }),
  setSettingsOpen: (v) => set({ settingsOpen: v }),
  openSettings: (section) => set((st) => ({ settingsOpen: true, settingsSection: section || st.settingsSection })),
  setSettingsSection: (settingsSection) => set({ settingsSection }),
  traycerImportOpen: false,
  setTraycerImportOpen: (traycerImportOpen) => set({ traycerImportOpen }),
  togglePalette: () => set((st) => ({ paletteOpen: !st.paletteOpen })),
  toggleQuickOpen: () => set((st) => ({ quickOpenOpen: !st.quickOpenOpen })),
  toggleWordWrap: () => {
    const wordWrap = !get().settings.wordWrap
    set((st) => ({ settings: { ...st.settings, wordWrap } }))
    window.prism.settings.set('wordWrap', wordWrap)
  },
  setCursor: (line, col) => set({ cursor: { line, col } }),
  bumpTree: () => set((st) => ({ treeVersion: st.treeVersion + 1 })),

  setLayout: (key, value) => set((st) => ({ settings: { ...st.settings, [key]: value } })),
  persistLayout: () => {
    const { sidebarWidth, chatWidth, terminalHeight } = get().settings
    window.prism.settings.set('sidebarWidth', sidebarWidth)
    window.prism.settings.set('chatWidth', chatWidth)
    window.prism.settings.set('terminalHeight', terminalHeight)
  },

  addToast: (kind, message) => {
    const id = `toast${toastSeq++}`
    set((st) => ({ toasts: [...st.toasts, { id, kind, message }] }))
    setTimeout(() => get().removeToast(id), 3800)
  },
  removeToast: (id) => set((st) => ({ toasts: st.toasts.filter((t) => t.id !== id) }))
}))

// Debug hook (used by dev tooling / screenshots).
;(window as unknown as { __prismStore: typeof useStore }).__prismStore = useStore
