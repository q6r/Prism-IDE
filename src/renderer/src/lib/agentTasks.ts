import { create } from 'zustand'
import { useStore } from '../store'
import { useAgentChats } from './agentChats'
import type { AgentTask } from '../../../shared/agents'
import type { RemoteState } from '../types'

export interface OpenTaskOptions {
  /** The SSH connection the store now shows `cwd` through; omit for a local folder. */
  remote?: RemoteState | null
}
interface TasksState {
  ready: boolean; tasks: AgentTask[]; openIds: string[]; activeId: string | null
  /** Task metadata is usable while the first chat snapshot is still pending. */
  restoringChats: boolean
  /** Tabs closed in this window, newest last ("Reabrir aba fechada"). Persisted. */
  closedIds: string[]
  init: () => Promise<void>; activate: (id: string) => void
  /**
   * Binds a folder to a task. Call it once the store shows `cwd` (after
   * openFolder / openWorkspaceFolders / connectRemote); called alone it also
   * shows `cwd`. The active task waiting to reconnect to this server gets its
   * workspace back; an empty active task adopts the folder; a task already
   * bound to it (same server) becomes active; otherwise a new task opens.
   */
  open: (cwd: string, options?: OpenTaskOptions) => void
  create: () => void; close: (id: string) => void; reopenClosed: () => void; rename: (id: string, title: string) => void
  pin: (id: string) => void; reorder: (from: string, to: string) => void
  /** Replaces the strip order; ignored unless it holds exactly the open tabs. */
  arrange: (openIds: string[]) => void
  cycle: (direction: number) => void
}

const DEFAULT_TITLE = 'Nova tarefa'
const editorKeys = ['folderPath', 'folderName', 'workspaceFolders', 'workspaceFile', 'tabs', 'activePath', 'sidebarView', 'workspaceView'] as const
const MRU_KEY = 'prism.tasks.mru', CLOSED_KEY = 'prism.tasks.closed'
const basename = (path: string): string => path.split(/[\\/]/).filter(Boolean).at(-1) || path

function readList(key: string): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(key)
    const list: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []
  } catch { return [] }
}
function writeList(key: string, list: readonly string[]): void {
  try { globalThis.localStorage?.setItem(key, JSON.stringify(list)) } catch { /* storage unavailable: keep it in memory */ }
}
// Most recently used first, for closing the active tab.
let mru: string[] = []
function touch(id: string): void { mru = [id, ...mru.filter((x) => x !== id)].slice(0, 200); writeList(MRU_KEY, mru) }

/* ---------- SSH-aware snapshots ----------
 * A task's editor snapshot carries the connection it was captured through.
 * Its paths only mean something through that server: they are restored with
 * the same live connection (the store's, or one parked when the user switched
 * away), and never applied to the local file system. */
type RemoteRef = Pick<RemoteState, 'id' | 'name' | 'host' | 'port' | 'username'>
export function remoteKey(remote: Pick<RemoteState, 'host' | 'port' | 'username'> | null | undefined): string {
  return remote ? `${remote.username}@${remote.host}:${remote.port}` : ''
}
function taskRemote(task: AgentTask): RemoteRef | null {
  const r = task.editor?.remote as Partial<RemoteRef> | null | undefined
  return r && typeof r === 'object' && typeof r.host === 'string' && typeof r.id === 'string' ? r as RemoteRef : null
}
function samePath(a: unknown, b: string, remote: boolean): boolean {
  if (typeof a !== 'string' || !b) return false
  const norm = (p: string): string => { const n = p.replace(/\\/g, '/').replace(/\/+$/, ''); return remote ? n : n.toLowerCase() }
  return norm(a) === norm(b)
}
function liveRemote(): RemoteState | null {
  return (useStore.getState() as { remote?: RemoteState | null }).remote ?? null
}
// Connections of tasks in the background, by remoteKey.
const parked = new Map<string, RemoteState>()

function snapshot(): Record<string, unknown> {
  const editor = useStore.getState() as unknown as Record<string, unknown>
  return { ...Object.fromEntries(editorKeys.map((k) => [k, editor[k]])), remote: liveRemote() }
}
/** The store still shows this task's workspace. Once it moved on (a folder opened, SSH dropped), the task's snapshot must not absorb another workspace. */
function showsTask(task: AgentTask): boolean {
  if (!task.cwd) return true
  const store = useStore.getState(), live = liveRemote()
  if (remoteKey(live) !== remoteKey(taskRemote(task))) return false
  return samePath(store.folderPath, task.cwd, !!live) || (store.workspaceFolders || []).some((p) => samePath(p, task.cwd, !!live))
}
function showWorkspace(cwd: string, remote: RemoteState | null): void {
  if (samePath(useStore.getState().folderPath, cwd, !!remote)) return
  useStore.setState({ folderPath: cwd, folderName: basename(cwd), workspaceFolders: [cwd], workspaceFile: null, ...(remote ? { remote } : {}) })
  if (!remote) void window.prism.terminal.setCwd(cwd)
  useStore.getState().bumpTree()
}

let timer: ReturnType<typeof setTimeout> | undefined
function save(): void {
  clearTimeout(timer)
  timer = setTimeout(() => {
    const s = useAgentTasks.getState()
    void window.prism.tasks.save(s.tasks, s.openIds, s.activeId).catch(err => useStore.getState().addToast('error', `Falha ao salvar as tarefas: ${err.message}`))
  }, 400)
}
/** Saves the active task's chat and, while the store still shows its workspace, its editor snapshot. `bind` writes the snapshot unconditionally: `open` has just made the store's workspace (and connection) this task's. */
function capture(bind = false): void {
  const s = useAgentTasks.getState()
  if (!s.activeId) return
  const chats = useAgentChats.getState()
  const chatId = chats.ready === false || s.restoringChats ? s.tasks.find(t => t.id === s.activeId)?.activeChatId : chats.activeId || undefined
  useAgentTasks.setState({ tasks: s.tasks.map(t => t.id !== s.activeId ? t : bind || showsTask(t) ? { ...t, activeChatId: chatId, editor: snapshot() } : { ...t, activeChatId: chatId }) })
}
function askReconnect(remote: RemoteRef): void {
  const store = useStore.getState()
  store.addToast('info', `Reconecte-se a ${remote.name || remote.host} para continuar esta tarefa.`)
  const recent = store.settings?.recentRemotes?.find((r) => remoteKey(r) === remoteKey(remote))
  if (recent) store.requestReconnect(recent)
}
function restore(task: AgentTask): void {
  const store = useStore.getState(), live = liveRemote(), wanted = taskRemote(task)
  const snap = (task.editor || {}) as Record<string, unknown>
  // The current connection outlives a switch to a task that does not use it.
  if (live && remoteKey(live) !== remoteKey(wanted)) parked.set(remoteKey(live), live)
  const connection = !wanted ? null : live && remoteKey(live) === remoteKey(wanted) ? live : parked.get(remoteKey(wanted)) ?? null
  if (connection) parked.delete(remoteKey(connection))
  const reset = { tabs: [], activePath: null, workspaceFile: null, pendingChatAttachment: null, pendingClose: null }
  if (wanted && !connection) {
    // Remote paths must never be read or saved through the local disk: show nothing until reconnected.
    useStore.setState({ ...reset, remote: null, folderPath: null, folderName: task.title, workspaceFolders: [],
      sidebarView: (snap.sidebarView as typeof store.sidebarView | undefined) ?? store.sidebarView,
      workspaceView: (snap.workspaceView as typeof store.workspaceView | undefined) ?? store.workspaceView })
    askReconnect(wanted)
  } else {
    const editor = Object.fromEntries(editorKeys.filter((k) => k in snap).map((k) => [k, snap[k]]))
    useStore.setState({ ...reset, remote: connection, folderPath: task.cwd || null, folderName: task.title, workspaceFolders: task.cwd ? [task.cwd] : [], ...editor } as never)
    if (task.cwd && !connection) void window.prism.terminal.setCwd(task.cwd)
  }
  useStore.getState().bumpTree()
  const chats = useAgentChats.getState()
  // Task metadata and its folder can open before the transcript snapshot.
  // Do not invent a replacement conversation while its saved chat is loading.
  if (chats.ready === false || useAgentTasks.getState().restoringChats) return
  const selected = chats.chats.find(c => c.id === task.activeChatId && c.taskId === task.id) || chats.chats.filter(c => c.taskId === task.id).sort((a,b) => b.updatedAt-a.updatedAt)[0]
  if (selected) chats.select(selected.id)
  else chats.create(wanted && !connection ? '' : task.cwd, connection?.id)
}

let initialized: Promise<void> | undefined
export const useAgentTasks = create<TasksState>((set, get) => ({
  ready: false, restoringChats: true, tasks: [], openIds: [], activeId: null, closedIds: [],
  init: () => initialized ||= (async () => {
    // Start both reads independently: a large chat history must not hide
    // the saved task strip or prevent opening its workspace.
    const loadingChats = useAgentChats.getState().init().then(() => ({ ok: true as const }), error => ({ ok: false as const, error }))
    let saved: Awaited<ReturnType<typeof window.prism.tasks.load>>
    try { saved = await window.prism.tasks.load() }
    catch {
      // Opening/maintaining a large host store may exceed the task RPC's
      // deadline. Wait for actual chat data before one fresh read. Never
      // synthesize or save an empty task list after a failed load.
      const loaded = await loadingChats
      if (!loaded.ok) throw loaded.error
      saved = await window.prism.tasks.load()
    }
    if (saved.tasks.length) {
      const openIds = saved.openIds.filter(id => saved.tasks.some(t => t.id === id))
      if (!openIds.length) openIds.push(saved.tasks[0].id)
      const activeId = openIds.includes(saved.activeId || '') ? saved.activeId! : openIds[0]
      mru = readList(MRU_KEY).filter(id => saved.tasks.some(t => t.id === id))
      const closedIds = readList(CLOSED_KEY).filter(id => saved.tasks.some(t => t.id === id) && !openIds.includes(id))
      set({ tasks: [...saved.tasks], openIds, activeId, closedIds, ready: true })
      restore(saved.tasks.find(t => t.id === activeId)!)
    }
    const loaded = await loadingChats
    if (!loaded.ok) throw loaded.error
    let tasks = [...get().tasks]
    const chats = useAgentChats.getState().chats
    for (const chat of chats) {
      if (chat.taskId && tasks.some(t => t.id === chat.taskId)) continue
      let task = tasks.find(t => t.cwd === chat.cwd)
      if (!task) { task = { id: crypto.randomUUID(), title: chat.cwd.split(/[\\/]/).filter(Boolean).at(-1) || DEFAULT_TITLE, cwd: chat.cwd, updatedAt: Date.now() }; tasks.push(task) }
      chat.taskId = task.id
      // Host mode: the host's `setTask` (allowed while the chat runs); its delta follows.
      if (useAgentChats.getState().mode === 'host') {
        const reply = await window.prism.chats.host.setTask(chat.id, task.id)
        if (!reply.ok) useStore.getState().addToast('error', `Falha ao salvar a tarefa do chat: ${reply.error}`)
      } else await window.prism.chats.save(chat)
    }
    // Task tabs were usable during loading. Preserve edits, dirty editor tabs
    // and a new active task made while orphan associations were being saved.
    if (get().ready) capture()
    const current = get()
    tasks = [...current.tasks, ...tasks.filter(t => !current.tasks.some(existing => existing.id === t.id))]
    if (!tasks.length) tasks.push({ id: crypto.randomUUID(), title: DEFAULT_TITLE, cwd: '', updatedAt: Date.now() })
    const openIds = (current.ready ? current.openIds : saved.openIds).filter(id => tasks.some(t => t.id === id))
    if (!openIds.length) openIds.push(tasks[0].id)
    const wantedActive = current.ready ? current.activeId : saved.activeId
    const activeId = openIds.includes(wantedActive || '') ? wantedActive! : openIds[0]
    mru = readList(MRU_KEY).filter(id => tasks.some(t => t.id === id))
    const closedIds = readList(CLOSED_KEY).filter(id => tasks.some(t => t.id === id) && !openIds.includes(id))
    set({ tasks, openIds, activeId, closedIds, ready: true, restoringChats: false }); touch(activeId); restore(tasks.find(t => t.id === activeId)!); save()
    // A parked connection that drops can no longer serve its task.
    window.prism.ssh?.onStatus?.(({ id, status }) => {
      if (status !== 'closed' && status !== 'error') return
      for (const [key, r] of parked) if (r.id === id) parked.delete(key)
    })
    const unsub = useStore.subscribe((state, old) => {
      if (state.tabs !== old.tabs || state.activePath !== old.activePath || state.workspaceView !== old.workspaceView) { capture(); save() }
    })
    window.addEventListener('beforeunload', (e) => {
      capture(); clearTimeout(timer); const s = get()
      if (!window.prism.tasks.flush(s.tasks, s.openIds, s.activeId).ok) {
        e.preventDefault(); (e as unknown as {returnValue:boolean}).returnValue=false
        useStore.getState().addToast('error','Não foi possível salvar as tarefas antes de fechar.')
      }
    })
    void unsub
  })().catch(error => {
    initialized = undefined
    throw error
  }),
  activate: (id) => {
    const task = get().tasks.find(t => t.id === id)
    if (!task || get().activeId === id && get().openIds.includes(id)) return
    capture()
    set(s => ({ activeId: id, openIds: s.openIds.includes(id) ? s.openIds : [...s.openIds, id], closedIds: s.closedIds.filter(x => x !== id) }))
    writeList(CLOSED_KEY, get().closedIds); touch(id); restore(task); save()
  },
  open: (cwd, options = {}) => {
    if (!get().ready || !cwd) return
    const remote = options.remote ?? null, key = remoteKey(remote)
    const active = get().tasks.find(t => t.id === get().activeId)
    const waiting = active ? taskRemote(active) : null
    // The active task was waiting for exactly this server: its workspace comes back.
    if (remote && active && waiting && remoteKey(waiting) === key && waiting.id !== remote.id) { restore(active); capture(true); save(); return }
    // An empty active task adopts the folder (two tasks may share one folder this way).
    if (active && !active.cwd) {
      showWorkspace(cwd, remote)
      set(s => ({ tasks: s.tasks.map(t => t.id === active.id ? { ...t, cwd, title: !t.title || t.title === DEFAULT_TITLE ? basename(cwd) : t.title, updatedAt: Date.now() } : t) }))
      capture(true); save(); return
    }
    const existing = get().tasks.find(t => samePath(t.cwd, cwd, !!remote) && remoteKey(taskRemote(t)) === key)
    if (existing && existing.id === active?.id) { showWorkspace(cwd, remote); capture(true); save(); return }
    if (existing) { get().activate(existing.id); return }
    capture()
    const task: AgentTask = { id: crypto.randomUUID(), title: basename(cwd), cwd, updatedAt: Date.now() }
    set(s => ({ tasks: [...s.tasks, task], openIds: [...s.openIds, task.id], activeId: task.id }))
    touch(task.id)
    useStore.setState({ tabs: [], activePath: null, pendingChatAttachment: null, pendingClose: null })
    showWorkspace(cwd, remote)
    capture(true)
    useAgentChats.getState().create(cwd, remote?.id)
    save()
  },
  create: () => {
    capture(); const task: AgentTask = { id: crypto.randomUUID(), title: DEFAULT_TITLE, cwd: '', updatedAt: Date.now() }
    set(s => ({ tasks: [...s.tasks, task], openIds: [...s.openIds, task.id], activeId: task.id })); touch(task.id); restore(task); save()
  },
  close: (id) => {
    if (!get().openIds.includes(id)) return
    capture(); const ids = get().openIds.filter(x => x !== id), wasActive = get().activeId === id
    set(s => ({ openIds: ids, closedIds: [...s.closedIds.filter(x => x !== id), id].slice(-20), ...(wasActive ? { activeId: null } : {}) }))
    writeList(CLOSED_KEY, get().closedIds)
    if (wasActive) {
      const next = mru.find(x => ids.includes(x)) ?? ids.at(-1)
      if (next) get().activate(next); else get().create()
    }
    save()
  },
  reopenClosed: () => {
    const s = get(), stack = [...s.closedIds]
    while (stack.length) {
      const id = stack.pop()!
      if (s.tasks.some(t => t.id === id) && !s.openIds.includes(id)) { set({ closedIds: stack }); get().activate(id); return }
    }
    set({ closedIds: [] }); writeList(CLOSED_KEY, [])
  },
  rename: (id, title) => { if (title.trim()) { set(s => ({tasks: s.tasks.map(t => t.id === id ? {...t, title: title.trim().slice(0,100)} : t)})); save() } },
  pin: (id) => { set(s => ({tasks: s.tasks.map(t => t.id === id ? {...t,pinned:!t.pinned} : t)})); save() },
  reorder: (from,to) => { const ids = get().openIds.filter(id => id !== from); ids.splice(ids.indexOf(to),0,from); set({openIds:ids}); save() },
  arrange: (openIds) => {
    const current = get().openIds
    if (openIds.length !== current.length || new Set(openIds).size !== openIds.length || !openIds.every(id => current.includes(id))) return
    set({ openIds: [...openIds] }); save()
  },
  cycle: (direction) => { const s = get(); if (s.openIds.length) s.activate(s.openIds[(s.openIds.indexOf(s.activeId || '')+direction+s.openIds.length)%s.openIds.length]) }
}))
