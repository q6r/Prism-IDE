import { create } from 'zustand'
import type { AgentSelection, ChatImage, ProviderProfile, QueuedMessage, SharedTurn, SharedSegment, SubagentUpdate, UnifiedChat } from '../../../shared/agents'
import type { ChatsReply } from '../../../shared/host/api/chats'
import type { ChatDelta } from '../../../shared/host/generated/ChatDelta'
import type { ChatsSnapshot } from '../../../shared/host/generated/ChatsSnapshot'
import { claudeMetrics } from '../../../shared/providerUsage'
import { continuationPrompt, effectiveServiceTier, routeKey, sameRemoteTarget } from '../../../shared/agents'
import { applyChatDeltas } from '../../../shared/chatDeltas'
import { projectSubagent, stoppedSubagents, subagentActive } from '../../../shared/subagents'
import type { PendingPerm, PendingQuestion } from '../types'
import { useStore } from '../store'
import { collectChatImages, imageAttachmentsForHistory, imageReferenceNumber, numberChatImages, numberNewImages, resolveImageReferences } from '../../../shared/imageReferences'
import { notifyTaskDone } from './notify'
import { useAgentTasks } from './agentTasks'
import { catalogKey, initialSelection, selectedModelFor, useModelCatalog } from './modelCatalog'
import { buildStructuredQuestionsReply, latestStructuredQuestions } from './asyncQuestions'

export interface ChatRuntime {
  turnId: string
  route: string
  busy: boolean
  permission?: PendingPerm
  question?: PendingQuestion
  /** Claude's last report on Fast for this route: served ('on'), 'off' (with why) or 'cooldown'. */
  fast?: { state: string; reason?: string }
  /** Host mode: this window runs the turn itself over IPC (SSH, Claude without `claude@1`), not the host. */
  local?: boolean
}

interface AgentChatsState {
  ready: boolean
  /**
   * Where the chats live, decided once per window by `init` (T07): `host`
   * when the host binary exists and serves `chats@1` (the host runs the
   * turns; this window follows its deltas), else `ipc` as before.
   */
  mode: 'host' | 'ipc' | null
  /** The host owns the chats but is not answering (pt-BR); shown where the agents load. */
  hostError: string | null
  chats: UnifiedChat[]
  profiles: ProviderProfile[]
  activeId: string | null
  runtime: Record<string, ChatRuntime>
  /** Compose-time image attachments, per chat (transient; never persisted). */
  attachments: Record<string, ChatImage[]>
  stopping: Record<string, boolean>
  editingQueue: Record<string, QueuedMessage | undefined>
  setEditingQueued: (id: string, item?: QueuedMessage) => void
  steering: Record<string, QueuedMessage | undefined>
  subagentSending: Record<string, boolean>
  historyLoading: Record<string, boolean>
  historyErrors: Record<string, string | undefined>
  loadHistory: (id: string) => Promise<boolean>
  messageSubagent: (id: string, text: string) => Promise<boolean>
  init: () => Promise<void>
  /** Reads the profile list again; `profiles` is one the host just announced (`providers.changed`). */
  refreshProfiles: (profiles?: ProviderProfile[]) => Promise<void>
  refreshImported: () => Promise<void>
  /** "Atualizar do Traycer": refresh one imported chat's history, unless continued here. */
  reimportFromTraycer: (id: string) => Promise<void>
  /** `parentChatId` creates a child agent chat under that parent (Traycer "Novo agente filho"). */
  create: (cwd: string, remoteId?: string, options?: { parentChatId?: string }) => void
  select: (id: string) => void
  configure: (id: string, selection: AgentSelection) => void
  confirmAccount: (id: string) => void
  bindWorkspace: (id: string, cwd: string, remoteId?: string) => void
  draft: (id: string, text: string) => void
  contextDraft: (id: string, text: string) => void
  rename: (id: string, title: string) => void
  /** Archives/unarchives a chat; refused while its agent runs. */
  archive: (id: string, archived: boolean) => void
  remove: (id: string) => Promise<void>
  /** Starts a turn; false when refused (busy, unbound import, wrong SSH route). Never touches the draft. */
  send: (id: string, text: string, context?: string, images?: ChatImage[], onRefused?: () => void) => boolean
  stop: (id: string) => void
  /** Add image attachments to the composer of a chat. */
  attachImages: (id: string, images: ChatImage[]) => void
  /** Remove one composer attachment by index. */
  removeImage: (id: string, index: number) => void
  /** Drop all composer attachments of a chat. */
  clearAttachments: (id: string) => void
  /** Queue a message typed while the agent was busy (Traycer's send queue). */
  enqueue: (id: string, msg: QueuedMessage, now?: boolean) => void
  /** Remove a queued message by index. */
  dequeue: (id: string, index: number) => void
  /** Send the next queued message when the chat is idle; called as a turn ends. */
  flushQueue: (id: string) => void
  pauseQueue: (id: string, paused: boolean) => void
  replaceQueued: (id: string, item: QueuedMessage, replacement: QueuedMessage) => void
  reorderQueued: (id: string, from: number, to: number) => void
  steerQueued: (id: string, index: number) => Promise<boolean>
  respondPermission: (id: string, decision: 'allow' | 'allow_always' | 'deny') => void
  respondQuestion: (id: string, answers?: Record<string, string>, response?: string) => Promise<boolean>
  /** Native asynchronous questions are answered as a message in this chat. */
  replyToQuestions: (id: string, sourceKey: string, answers: Record<string, string>) => Promise<boolean>
  importSession: (chat: UnifiedChat) => void
}

/* ---------- Host mode (T07) ----------
 * The host stores the chats and runs their turns; this window applies its
 * snapshot and deltas and sends it commands. Chats the host cannot run (the
 * old SSH mode, Claude while the host lacks `claude@1`) are still run here
 * over IPC, as in IPC mode, with their documents saved on the host (`put`).
 * Drafts never leave the device. */

const HOST_SILENT_MS = 15_000
const HOST_SILENT = 'O host do Prism não respondeu. Tentando de novo…'
const DRAFTS_KEY = 'prism.chatDrafts'

/** The connected host's capabilities (the last known while it reconnects). */
let hostCaps: readonly string[] = []
/** Chats created here that the host has not stored yet: a snapshot meanwhile keeps them. */
const creating = new Set<string>()
const historyRequests = new Map<string, Promise<boolean>>()
let historyEpoch = 0
const historyVisits = new Map<string, number>()
let historyVisit = 0
const HISTORY_CACHE_LIMIT = 3
/** Keep cleared/in-flight uploads reserved until their queue or turn delta arrives. */
const imageNumberHighWater = new Map<string, number>()
/** Retried answers reuse the same queued row, including while its delta is in flight. */
const queuedQuestionReplies = new Set<string>()
const questionRepliesInFlight = new Map<string, Promise<boolean>>()
let silence: ReturnType<typeof setTimeout> | undefined

function onHost(): boolean {
  return useAgentChats.getState().mode === 'host'
}
/** Bound renderer-only history without changing a byte in the host store. */
function trimHistories(chats: UnifiedChat[], runtime: Record<string, ChatRuntime>, activeId: string | null): UnifiedChat[] {
  if (!onHost() || !hostCaps.includes('chats.history@1')) return chats
  const full = chats.filter(chat => !chat.historyPending && chat.turns.length > 0)
  if (full.length <= HISTORY_CACHE_LIMIT) return chats
  const keep = new Set(full.filter(chat => chat.id === activeId || runtime[chat.id]?.busy || runtime[chat.id]?.local || creating.has(chat.id)).map(chat => chat.id))
  for (const chat of [...full].sort((a, b) => (historyVisits.get(b.id) ?? 0) - (historyVisits.get(a.id) ?? 0))) {
    if (keep.size >= HISTORY_CACHE_LIMIT) break
    keep.add(chat.id)
  }
  return chats.map(chat => !chat.historyPending && chat.turns.length > 0 && !keep.has(chat.id)
    ? { ...chat, turns: [], historyPending: true, historyTurnCount: chat.turns.length } : chat)
}
/** The host runs this chat's turns; otherwise this window does, over IPC. */
function hostDrives(chat: UnifiedChat): boolean {
  return onHost() && !chat.remoteId && hostCaps.includes(`${chat.selection.provider}@1`)
}
/** Host mode: a turn of this chat is running here, so the host's copy of it is behind. */
function runsHere(id: string): boolean {
  const run = useAgentChats.getState().runtime[id]
  return !!run?.busy && !!run.local
}
/** Waiting for the host to connect: after 15 s the agents panel says it is not answering. */
function waitHost(): void {
  silence ??= setTimeout(() => useAgentChats.setState({ hostError: HOST_SILENT }), HOST_SILENT_MS)
}
function hostAnswered(): void {
  clearTimeout(silence); silence = undefined
  if (useAgentChats.getState().hostError) useAgentChats.setState({ hostError: null })
}

const migratingQueues = new Set<string>()
const migrationRetry = new Map<string, number>()
function sharedQueue(chat: UnifiedChat | undefined): boolean {
  return !!chat && hostDrives(chat) && hostCaps.includes('chats.queue@1') && typeof window.prism.chats.host.queue === 'function'
}
function queueCommand(id: string, operation: string, payload: Record<string, unknown> = {}): void {
  hostCommand(window.prism.chats.host.queue(id, operation, payload))
}
type Drafts = Pick<UnifiedChat, 'draft' | 'contextDraft' | 'queued' | 'queuePaused'>
const DRAFT_KEYS = ['draft', 'contextDraft', 'queued', 'queuePaused'] as const
let drafts: Record<string, Drafts> | undefined
/** This device's drafts by chat id (host mode). */
function localDrafts(): Record<string, Drafts> {
  if (drafts) return drafts
  try {
    const saved: unknown = JSON.parse(globalThis.localStorage?.getItem(DRAFTS_KEY) || '{}')
    drafts = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved as Record<string, Drafts> : {}
  } catch { drafts = {} }
  return drafts
}
function writeDrafts(): void {
  try { globalThis.localStorage?.setItem(DRAFTS_KEY, JSON.stringify(localDrafts())) } catch { /* storage unavailable: keep them in memory */ }
}
function setDraft(id: string, patch: Drafts): void {
  const all = localDrafts()
  all[id] = { ...all[id], ...patch }
  writeDrafts()
  useAgentChats.setState((s) => ({ chats: s.chats.map((c) => c.id === id ? { ...c, ...patch } : c) }))
}
function forgetDrafts(id: string): void {
  const all = localDrafts()
  if (!(id in all)) return
  delete all[id]
  writeDrafts()
}
/** The device's drafts over the host's document; a draft only the document has (from 0.2) becomes the device's. */
function withDrafts(chat: UnifiedChat): UnifiedChat {
  const all = localDrafts()
  let mine = all[chat.id]
  // A shared queue always comes from the host, never an old localStorage copy.
  if (sharedQueue(chat) && mine) {
    if (mine.queued?.length && !migratingQueues.has(chat.id) && Date.now() >= (migrationRetry.get(chat.id) || 0)) {
      const messages = mine.queued.map(message => ({ ...message, id: message.id || crypto.randomUUID() }))
      all[chat.id] = { ...mine, queued: messages }; writeDrafts(); migratingQueues.add(chat.id)
      const paused = mine.queuePaused
      void (async () => {
        if (paused) {
          const reply = await window.prism.chats.host.queue(chat.id, 'pause', { paused: true })
          if (!reply.ok) throw new Error(reply.error)
        }
        for (const message of messages) {
          const reply = await window.prism.chats.host.queue(chat.id, 'add', { message })
          if (!reply.ok) throw new Error(reply.error)
          const saved = localDrafts()[chat.id]
          if (saved) { saved.queued = (saved.queued || []).filter(row => row.id !== message.id); writeDrafts() }
        }
      })().catch(error => {
        migrationRetry.set(chat.id, Date.now() + 30000)
        useStore.getState().addToast('error', `A fila antiga foi preservada neste computador: ${(error as Error).message}`)
      }).finally(() => migratingQueues.delete(chat.id))
    }
    const { queued: _queued, queuePaused: _paused, ...composer } = mine
    mine = composer // keep the legacy queue on disk until every item is acknowledged
  }
  for (const key of DRAFT_KEYS) {
    if (sharedQueue(chat) && (key === 'queued' || key === 'queuePaused')) continue
    if (mine?.[key] !== undefined || chat[key] === undefined) continue
    mine = { ...mine, [key]: chat[key] }
    all[chat.id] = mine
    writeDrafts()
  }
  if (!mine || DRAFT_KEYS.every((key) => mine![key] === undefined || mine![key] === chat[key])) return chat
  return { ...chat, ...Object.fromEntries(Object.entries(mine).filter(([, v]) => v !== undefined)) }
}
function withoutDrafts(chat: UnifiedChat): UnifiedChat {
  const { draft: _draft, contextDraft: _context, queued: _queued, queuePaused: _paused, ...doc } = chat
  return doc
}

/** A command the host refused, as a toast (its pt-BR message; `gone` gets `gone`). */
function hostCommand(reply: Promise<ChatsReply<object>>, gone?: string): void {
  void reply.then((r) => {
    if (!r.ok) useStore.getState().addToast('error', r.code === 'gone' && gone ? gone : r.error)
  }, (err) => useStore.getState().addToast('error', err.message))
}
function hostCreate(chat: UnifiedChat): void {
  creating.add(chat.id)
  void window.prism.chats.host.create(withoutDrafts(chat)).then((r) => {
    creating.delete(chat.id)
    if (!r.ok) useStore.getState().addToast('error', `Não foi possível criar o chat: ${r.error}`)
  }, (err) => {
    creating.delete(chat.id)
    useStore.getState().addToast('error', `Não foi possível criar o chat: ${err.message}`)
  })
}

/** The capabilities of the host that owns this window's chats, or null when they stay on IPC. */
async function hostOwnsChats(): Promise<readonly string[] | null> {
  let owned = false
  try { owned = (await window.prism.chats.hostOwned?.()) === true } catch { /* no host binary */ }
  if (!owned) return null
  // Never IPC while the host binary exists, even if the host is slow: two stores would diverge.
  waitHost()
  const caps = await new Promise<readonly string[]>((resolve) => {
    let done = false
    let off: (() => void) | undefined = undefined
    off = window.prism.host.onStatus((status) => {
      if (done || status.state !== 'connected') return
      done = true
      off?.()
      resolve(status.hello?.capabilities ?? window.prism.host.capabilities())
    })
    // Already connected: the listener ran before `off` existed.
    if (done) off()
  })
  if (!caps.includes('chats@1')) { hostAnswered(); return null }
  return caps
}

/** The snapshot is the truth, but turns this window runs keep its own copy, and so do chats it is creating. */
function applySnapshot(snapshot: ChatsSnapshot): void {
  historyEpoch++
  historyRequests.clear()
  const s = useAgentChats.getState()
  const here = (id: string): boolean => !!s.runtime[id]?.local && !!s.runtime[id]?.busy
  const docs = snapshot.chats.map((doc) => (here(doc.id) && s.chats.find((c) => c.id === doc.id)) || withDrafts(doc))
  const kept = s.chats.filter((c) => (creating.has(c.id) || here(c.id)) && !docs.some((d) => d.id === c.id))
  let chats = [...docs, ...kept].sort((a, b) => b.updatedAt - a.updatedAt)
  const runtime: Record<string, ChatRuntime> = {}
  for (const [id, run] of Object.entries(s.runtime)) if (run.local) runtime[id] = run
  for (const [id, run] of Object.entries(snapshot.runtime)) if (!here(id)) runtime[id] = run as ChatRuntime
  const activeId = s.activeId && chats.some((c) => c.id === s.activeId) ? s.activeId : chats[0]?.id ?? null
  if (activeId) historyVisits.set(activeId, ++historyVisit)
  chats = trimHistories(chats, runtime, activeId)
  const stopping = Object.fromEntries(Object.entries(s.stopping).filter(([id]) => runtime[id]?.busy))
  useAgentChats.setState({ chats, runtime, activeId, stopping, historyLoading: {}, historyErrors: {} })
  if (activeId) void useAgentChats.getState().loadHistory(activeId)
}

const deltaChat = (delta: ChatDelta): string => delta.op === 'chat' ? delta.chat.id : delta.chatId
/** The next chat after `gone` left: the most recent unarchived one of its task. */
function nextChat(chats: UnifiedChat[], gone: UnifiedChat | undefined): string | null {
  return chats.filter((c) => c.id !== gone?.id && !c.archived && c.taskId === gone?.taskId).sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id ?? null
}

function applyHostDeltas(deltas: ChatDelta[]): void {
  const before = useAgentChats.getState()
  // The host's copy of a chat running here is behind this window's.
  const here = (id: string): boolean => !!before.runtime[id]?.local && !!before.runtime[id]?.busy
  const accepted = deltas.filter((d) => d.op === 'remove' || !here(deltaChat(d)))
  if (!accepted.length) return
  const next = applyChatDeltas<ChatRuntime>({ chats: before.chats, runtime: before.runtime }, accepted)
  if (!next.changed.length) return
  const changed = new Set(next.changed)
  let chats = next.chats.map((c) => changed.has(c.id) ? withDrafts(c) : c)
  const activeId = before.activeId && !chats.some((c) => c.id === before.activeId)
    ? nextChat(chats, before.chats.find((c) => c.id === before.activeId)) : before.activeId
  for (const delta of accepted) if (delta.op === 'chat' && !delta.chat.historyPending) historyVisits.set(delta.chat.id, ++historyVisit)
  chats = trimHistories(chats, next.runtime, activeId)
  useAgentChats.setState({ chats, runtime: next.runtime, activeId })
  const loaded = chats.filter(c => changed.has(c.id) && !c.historyPending).map(c => c.id)
  if (loaded.length) useAgentChats.setState(s => ({
    historyLoading: { ...s.historyLoading, ...Object.fromEntries(loaded.map(id => [id, false])) },
    historyErrors: { ...s.historyErrors, ...Object.fromEntries(loaded.map(id => [id, undefined])) }
  }))
  for (const d of accepted) if (d.op === 'remove') { historyVisits.delete(d.chatId); forgetDrafts(d.chatId); clearTimeout(saveTimers.get(d.chatId)); saveTimers.delete(d.chatId) }
  for (const id of next.changed) liveEffects(id, before.runtime[id], next.runtime[id])
  if (activeId && activeId !== before.activeId) void useAgentChats.getState().loadHistory(activeId)
}

/** What a live change of a host-run chat means for this window (never a snapshot: nothing happens while it reconnects). */
function liveEffects(chatId: string, prev: ChatRuntime | undefined, next: ChatRuntime | undefined): void {
  const settings = useStore.getState().settings
  if (prev?.busy && !prev.local && !next?.busy) turnEnded(chatId, next?.turnId || prev.turnId)
  if (next?.permission && next.permission.permId !== prev?.permission?.permId && settings.notifyOnAsk) {
    window.prism.app.notify('Prism · permissão necessária', next.permission.title || next.permission.toolName)
  }
  if (next?.question && next.question.dialogId !== prev?.question?.dialogId && settings.notifyOnAsk) {
    window.prism.app.notify('Prism · resposta necessária', next.question.questions?.[0]?.question || 'O agente fez uma pergunta.')
  }
}
/** `finish`'s effects on the UI, for a turn the host ran (its final state came in the same batch). */
function turnEnded(chatId: string, turnId: string): void {
  const state = useAgentChats.getState(), store = useStore.getState()
  const chat = state.chats.find((c) => c.id === chatId)
  if (chat?.nativeAgent) return
  const turn = chat?.turns.find((t) => t.id === turnId)
  useAgentChats.setState((s) => ({ stopping: { ...s.stopping, [chatId]: false } }))
  const ok = !turn?.error && !turn?.interrupted
  store.bumpTree()
  void store.reloadOpenFiles()
  if (ok && store.settings.notifyOnDone && (!document.hasFocus() || state.activeId !== chatId || !store.chatOpen)) {
    window.prism.app.notify('Prism · tarefa concluída', chat?.title || 'O agente terminou.')
  }
  // store.ts says this on Claude's agent:done when the chat panel is closed; the host's turns never reach it.
  if (ok && (turn?.provider ?? chat?.selection.provider) === 'claude' && !store.chatOpen && store.settings.notifyOnDone) {
    notifyTaskDone('Claude · tarefa concluída', 'O agente terminou.')
    store.addToast('success', '✓ Claude terminou a tarefa')
  }
  // The host ran this turn; a clean finish sends the next queued message.
  if (ok) useAgentChats.getState().flushQueue(chatId)
}

/* ---------- Turns this window runs (IPC mode, and the IPC chats of host mode) ---------- */

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>()
function save(chat: UnifiedChat): Promise<boolean> {
  if (chat.historyPending) return Promise.reject(new Error('Aguarde o histórico desta conversa carregar antes de salvá-la.'))
  if (!onHost()) return window.prism.chats.save(chat)
  return window.prism.chats.host.put(withoutDrafts(chat)).then((r) => {
    if (!r.ok) throw new Error(r.error)
    return true
  })
}
function persist(id: string): void {
  if (useAgentChats.getState().chats.find(chat => chat.id === id)?.historyPending) return
  // A fixed maximum interval, not a trailing debounce: continuous token output
  // must never postpone saving the prompt and visible transcript indefinitely.
  if (saveTimers.has(id)) return
  saveTimers.set(id, setTimeout(() => {
    saveTimers.delete(id)
    const chat = useAgentChats.getState().chats.find((c) => c.id === id)
    if (chat) void save(chat).catch((err) => useStore.getState().addToast('error', `Não foi possível salvar o chat: ${err.message}`))
  }, 750))
}
function persistNow(id: string): Promise<boolean> {
  clearTimeout(saveTimers.get(id)); saveTimers.delete(id)
  const chat = useAgentChats.getState().chats.find((c) => c.id === id)
  return chat ? save(chat) : Promise.resolve(true)
}
function editChat(id: string, fn: (chat: UnifiedChat) => UnifiedChat): void {
  useAgentChats.setState((s) => ({ chats: s.chats.map((c) => c.id === id ? fn(c) : c) }))
  persist(id)
}
/** IPC imports are numbered at load; this also supports older/manual local queue state. */
function stableLocalImages(id: string): UnifiedChat | undefined {
  const before = useAgentChats.getState().chats.find(chat => chat.id === id)
  if (before?.historyPending) return undefined
  if (!before || sharedQueue(before)) return before
  const numbered = numberChatImages(before)
  imageNumberHighWater.set(id, collectChatImages(numbered).reduce((max, image) => Math.max(max, image.number), imageNumberHighWater.get(id) || 0))
  if (numbered === before) return before
  const tracked = (item: QueuedMessage | undefined): QueuedMessage | undefined => {
    const index = item ? before.queued?.indexOf(item) ?? -1 : -1
    return index >= 0 ? numbered.queued?.[index] : item
  }
  useAgentChats.setState(state => ({
    chats: state.chats.map(chat => chat.id === id ? numbered : chat),
    editingQueue: { ...state.editingQueue, [id]: tracked(state.editingQueue[id]) },
    steering: { ...state.steering, [id]: tracked(state.steering[id]) }
  }))
  if (onHost() && numbered.queued !== before.queued) setDraft(id, { queued: numbered.queued })
  persist(id)
  return numbered
}
function owned(id: string): [string, ChatRuntime] | undefined {
  // In host mode the host's own runs are not this window's to edit.
  const host = onHost()
  return Object.entries(useAgentChats.getState().runtime).find(([, r]) => r.busy && r.turnId === id && (!host || r.local))
}
const turnUpdates = new Map<string, ((turn: SharedTurn) => SharedTurn)[]>()
const localSubagentOrigins = new Set<string>()

function receiveSubagent(turnId: string, agent: SubagentUpdate): void {
  flushTurns()
  const state = useAgentChats.getState()
  const root = state.chats.find(chat => !chat.nativeAgent && chat.turns.some(turn => turn.id === turnId))
  if (!root || (onHost() && !state.runtime[root.id]?.local && !localSubagentOrigins.has(turnId))) return
  localSubagentOrigins.add(turnId)
  const known = state.chats.find(c => c.nativeAgent?.rootChatId === root.id && (c.nativeAgent.controlId === agent.id || (agent.messageTarget && c.nativeAgent.messageTarget === agent.messageTarget)))
  const parent = agent.parentId ? state.chats.find(c => c.nativeAgent?.rootChatId === root.id && (c.nativeAgent.id === agent.parentId || c.nativeAgent.controlId === agent.parentId)) : undefined
  const update = { ...agent, ...(known?.nativeAgent ? { id: known.nativeAgent.id } : {}), ...(parent?.nativeAgent ? { parentId: parent.nativeAgent.id } : {}), controlId: agent.id, controlTurnId: turnId }
  const projected = projectSubagent(state.chats, root.id, known?.nativeAgent?.rootTurnId ?? parent?.nativeAgent?.rootTurnId ?? turnId, update)
  if (!projected.length) return
  const replacements = new Map(projected.map(chat => [chat.id, chat]))
  const child = projected.find(chat => chat.nativeAgent?.id === update.id)
  useAgentChats.setState(current => ({
    chats: [...current.chats.map(chat => replacements.get(chat.id) ?? chat), ...projected.filter(chat => !current.chats.some(before => before.id === chat.id))],
    ...(child?.nativeAgent ? { runtime: { ...current.runtime, [child.id]: {
      turnId: child.pendingTurnId ?? child.turns.at(-1)!.id, route: routeKey(child.selection),
      busy: subagentActive(child.nativeAgent.status), local: true,
      permission: subagentActive(child.nativeAgent.status)
        ? agent.permission === undefined ? current.runtime[child.id]?.permission : (agent.permission ?? undefined) as unknown as PendingPerm | undefined : undefined,
      question: subagentActive(child.nativeAgent.status)
        ? agent.question === undefined ? current.runtime[child.id]?.question : (agent.question ?? undefined) as unknown as PendingQuestion | undefined : undefined
    } } } : {})
  }))
  for (const chat of projected) persist(chat.id)
}
let renderTimer: ReturnType<typeof setTimeout> | undefined
function flushTurns(): void {
  clearTimeout(renderTimer); renderTimer = undefined
  if (!turnUpdates.size) return
  const updates = new Map(turnUpdates); turnUpdates.clear()
  const changed = new Set<string>()
  useAgentChats.setState(state => ({ chats: state.chats.map(chat => {
    const run = state.runtime[chat.id]
    if (!run?.busy || !updates.has(run.turnId)) return chat
    changed.add(chat.id)
    return { ...chat, turns: chat.turns.map(turn => turn.id === run.turnId
      ? updates.get(turn.id)!.reduce((current, update) => update(current), turn) : turn) }
  }) }))
  for (const id of changed) persist(id)
}
function editTurn(turnId: string, fn: (turn: SharedTurn) => SharedTurn): void {
  if (!owned(turnId)) return
  const queue = turnUpdates.get(turnId) || []
  queue.push(fn); turnUpdates.set(turnId, queue)
  // Batch native deltas across chats without delaying completion or unload.
  renderTimer ||= setTimeout(flushTurns, 40)
}
function append(turnId: string, kind: 'text' | 'thinking', text: string): void {
  editTurn(turnId, (t) => {
    const segments = [...(t.segments || [])]
    const last = segments.at(-1)
    if (last?.kind === kind) segments[segments.length - 1] = { ...last, text: (last.text || '') + text }
    else segments.push({ kind, text })
    return { ...t, segments }
  })
}
function session(turnId: string, sessionId: string): void {
  const entry = owned(turnId)
  if (entry && sessionId) editChat(entry[0], (c) => ({ ...c, resume: { route: entry[1].route, sessionId } }))
}
function fastReport(turnId: string, fast?: ChatRuntime['fast']): void {
  const entry = owned(turnId)
  if (!entry || !fast || (entry[1].fast?.state === fast.state && entry[1].fast?.reason === fast.reason)) return
  useAgentChats.setState((s) => ({ runtime: { ...s.runtime, [entry[0]]: { ...s.runtime[entry[0]], fast } } }))
}
/** `errorCode`: why it failed, when the provider said (`cli_auth` offers "Entrar novamente"), as the journal's fold keeps it. */
function finish(turnId: string, error?: string, aborted = false, errorCode?: string): void {
  flushTurns()
  const entry = owned(turnId)
  if (!entry) return
  const [chatId, run] = entry
  editChat(chatId, (c) => ({ ...c, updatedAt: Date.now(),
    pendingTurnId: undefined,
    // Failed/interrupted native runs are not resumed; transfer their visible
    // transcript on the next request instead of assuming completion.
    resume: error || aborted ? undefined : c.resume,
    turns: c.turns.map((t) => t.id === turnId ? { ...t, completedAt: Date.now(), durationMs: t.startedAt ? Math.max(0, Date.now() - t.startedAt) : undefined, error: !!error, interrupted: aborted,
      ...(error && errorCode ? { errorCode } : {}),
      segments: [...(t.segments || []), ...(error ? [{ kind: 'text' as const, text: error }] : [])].map((s) =>
        s.kind === 'tool' && !s.subagent && (s.status === 'running' || s.status === 'awaiting')
          ? { ...s, status: error || aborted ? 'error' as const : 'done' as const } : s) } : t) }))
  useAgentChats.setState((s) => ({ runtime: { ...s.runtime, [chatId]: { ...run, busy: false, permission: undefined, question: undefined } }, stopping: { ...s.stopping, [chatId]: false } }))
  void persistNow(chatId).catch((err) => useStore.getState().addToast('error', `Falha ao salvar: ${err.message}`))
  useStore.getState().bumpTree()
  void useStore.getState().reloadOpenFiles()
  if (!error && !aborted && useStore.getState().settings.notifyOnDone &&
    (!document.hasFocus() || useAgentChats.getState().activeId !== chatId || !useStore.getState().chatOpen)) {
    window.prism.app.notify('Prism · tarefa concluída', useAgentChats.getState().chats.find((c) => c.id === chatId)?.title || 'O agente terminou.')
  }
  // A clean finish sends the next queued message, if any (the send queue).
  if (!error && !aborted) useAgentChats.getState().flushQueue(chatId)
}

let initialization: Promise<void> | undefined
export const useAgentChats = create<AgentChatsState>((set, get) => ({
  ready: false, mode: null, hostError: null, chats: [], profiles: [], activeId: null, runtime: {}, attachments: {}, stopping: {}, steering: {}, editingQueue: {}, subagentSending: {}, historyLoading: {}, historyErrors: {},
  loadHistory: (id) => {
    const chat = get().chats.find(chat => chat.id === id)
    if (!chat?.historyPending) return Promise.resolve(!!chat)
    const pending = historyRequests.get(id)
    if (pending) return pending
    if (!onHost() || !hostCaps.includes('chats.history@1') || typeof window.prism.chats.host.loadHistory !== 'function') {
      set(s => ({ historyErrors: { ...s.historyErrors, [id]: 'Atualize o host para carregar o histórico desta conversa.' } }))
      return Promise.resolve(false)
    }
    const epoch = historyEpoch
    set(s => ({ historyLoading: { ...s.historyLoading, [id]: true }, historyErrors: { ...s.historyErrors, [id]: undefined } }))
    const request = (async () => {
      try {
        await Promise.resolve() // install the deduplication entry even if a bridge throws synchronously
        const reply = await window.prism.chats.host.loadHistory(id)
        if (epoch !== historyEpoch || !get().chats.some(chat => chat.id === id)) return false
        if (!reply.ok) throw new Error(reply.error)
        // The host sends/flushes its authoritative Chat delta before ack.
        // Never replace it from a second response or write a metadata stub.
        if (get().chats.find(chat => chat.id === id)?.historyPending) throw new Error('O host ainda não entregou o histórico. Tente novamente.')
        return true
      } catch (error) {
        if (epoch === historyEpoch && get().activeId === id && get().chats.some(chat => chat.id === id && chat.historyPending)) {
          set(s => ({ historyErrors: { ...s.historyErrors, [id]: (error as Error).message || 'Não foi possível carregar o histórico.' } }))
        }
        return false
      } finally {
        if (epoch === historyEpoch) {
          historyRequests.delete(id)
          set(s => ({ historyLoading: { ...s.historyLoading, [id]: false } }))
        }
      }
    })()
    historyRequests.set(id, request)
    return request
  },
  setEditingQueued: (id, item) => {
    const chat = get().chats.find(c => c.id === id)
    if (item && sharedQueue(chat) && !chat?.queuePaused) {
      void window.prism.chats.host.queue(id, 'pause', { paused: true }).then(reply => {
        if (!reply.ok) useStore.getState().addToast('error', reply.error)
      })
    }
    set(s => ({ editingQueue: { ...s.editingQueue, [id]: item } }))
  },
  init: () => initialization ||= (async () => {
    const caps = await hostOwnsChats()
    if (caps) {
      hostCaps = caps
      set({ mode: 'host' })
      window.prism.host.onStatus((status) => {
        if (status.state !== 'connected') return waitHost()
        hostCaps = status.hello?.capabilities ?? hostCaps
        // A successful hello says nothing about the history still loading.
        if (get().ready) hostAnswered()
        else waitHost()
      })
      // The snapshot is the truth: a turn may really be running, so nothing is normalized.
      // The first one may take a while (a new host imports the 0.2 data): still loading meanwhile.
      const first = new Promise<void>((resolve) => {
        window.prism.chats.host.follow((snapshot) => { applySnapshot(snapshot); hostAnswered(); resolve() }, applyHostDeltas, (progress) => {
          if (progress.state === 'ready') hostAnswered()
          else if (progress.state === 'error') {
            clearTimeout(silence); silence = undefined
            set({ hostError: `Não foi possível carregar as conversas: ${progress.error} Tentando novamente…` })
          } else waitHost()
        })
      })
      // Accounts can be used while a large history is still loading. A
      // failed account read must not discard a successful chat snapshot.
      const readProfiles = async (): Promise<void> => { set({ profiles: await window.prism.providers.list() }) }
      void readProfiles().catch(async () => {
        // Initial host maintenance can hold the database longer than a
        // profile RPC's deadline. The first snapshot proves it is usable;
        // retry once then rather than leaving the account list empty forever.
        await first
        await readProfiles()
      }).catch(error => {
        useStore.getState().addToast('error', `Falha ao carregar contas: ${(error as Error).message}`)
      })
      await first
      set({ ready: true })
    } else {
      const [chats, profiles] = await Promise.all([window.prism.chats.list(), window.prism.providers.list()])
      // There is no live process after restarting. Clear transient tool states.
      const numbered = new Set<string>()
      const restored = stoppedSubagents(chats).map((c) => {
        const clean = { ...c, resume: c.pendingTurnId ? undefined : c.resume, pendingTurnId: undefined,
          turns: c.turns.map((t) => ({ ...t, interrupted: t.id === c.pendingTurnId || t.interrupted, segments: t.segments?.map((s) =>
          s.status === 'running' || s.status === 'awaiting' ? { ...s, status: 'error' as const } : s) })) }
        const stable = numberChatImages(clean)
        if (stable !== clean) numbered.add(c.id)
        return stable
      })
      set({ mode: 'ipc', chats: restored, profiles, activeId: restored.sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id || null, ready: true })
      for (const id of numbered) persist(id)
    }
    // The host announces every change to the accounts, from any window or client (T08).
    window.prism.providers.onChanged?.((profiles) => { void get().refreshProfiles(profiles) })
    window.addEventListener('beforeunload', (e) => {
      flushTurns()
      // Host mode: only the chats this window runs; the host keeps the rest and drafts stay on the device.
      const host = onHost()
      const pending = get().chats.filter((c) => !c.historyPending && (saveTimers.has(c.id) || get().runtime[c.id]?.busy && (!host || get().runtime[c.id]?.local)))
      if (!pending.length) return
      const result = window.prism.chats.flush(host ? pending.map(withoutDrafts) : pending)
      if (!result.ok) {
        e.preventDefault()
        ;(e as unknown as { returnValue: boolean }).returnValue = false
        useStore.getState().addToast('error', `Não foi possível salvar antes de fechar: ${result.error}`)
      }
    })
    const api = window.prism.claude
    api.onAgentSystem(({ id, sessionId, fastMode }) => { session(id, sessionId); fastReport(id, fastMode) })
    api.onAgentText(({ id, text }) => append(id, 'text', text))
    api.onAgentThinking(({ id, text }) => append(id, 'thinking', text))
    api.onAgentSubagent?.(({ id, agent }) => receiveSubagent(id, agent))
    api.onAgentTool(({ id, toolId, name, input }) => editTurn(id, (t) => ({ ...t,
      segments: [...(t.segments || []), { kind: 'tool', toolId, name, input, status: 'running' }] })))
    api.onAgentToolResult(({ id, toolId, content, isError }) => editTurn(id, (t) => ({ ...t,
      segments: t.segments?.map((s) => s.toolId === toolId ? { ...s, result: content, resultIsError: isError, status: isError ? 'error' : 'done' } : s) })))
    api.onAgentPermission((p) => {
      const entry = owned(p.id); if (!entry) return
      set((s) => ({ runtime: { ...s.runtime, [entry[0]]: { ...entry[1], permission: p } } }))
      editTurn(p.id, (t) => ({ ...t, segments: t.segments?.map((s) => s.toolId === p.toolUseId ? { ...s, status: 'awaiting' } : s) }))
      if (useStore.getState().settings.notifyOnAsk) window.prism.app.notify('Prism · permissão necessária', p.title || p.toolName)
    })
    api.onAgentQuestion((q) => {
      const entry = owned(q.id); if (!entry) return
      set((s) => ({ runtime: { ...s.runtime, [entry[0]]: { ...entry[1], question: q } } }))
      if (useStore.getState().settings.notifyOnAsk) window.prism.app.notify('Prism · resposta necessária', q.questions[0]?.question || 'O agente fez uma pergunta.')
    })
    api.onAgentResult((result) => {
      const { id, sessionId, isError, resultText, subtype } = result
      editTurn(id, t => ({ ...t, metrics: claudeMetrics(result) }))
      session(id, sessionId)
      fastReport(id, result.fastMode)
      if (isError) finish(id, resultText || `Claude encerrou com erro: ${subtype}`, false, typeof result.code === 'string' ? result.code : undefined)
    })
    api.onAgentDone(({ id, aborted }) => finish(id, undefined, aborted))
    api.onAgentError(({ id, message }) => finish(id, message))
    window.prism.codex.onEvent((e) => {
      if (e.kind === 'subagent') receiveSubagent(e.id, e.agent)
      else if (e.kind === 'metrics') editTurn(e.id, t => ({ ...t, metrics: e.metrics }))
      else if (e.kind === 'session') session(e.id, e.sessionId)
      else if (e.kind === 'done') finish(e.id, undefined, e.aborted)
      else if (e.kind === 'error') finish(e.id, e.message)
      else editTurn(e.id, (t) => {
        const segments: SharedSegment[] = [...(t.segments || [])]
        const i = segments.findIndex((s) => s.toolId && s.toolId === e.segment.toolId)
        if (i >= 0) segments[i] = e.segment
        else segments.push(e.segment)
        return { ...t, segments }
      })
    })
  })().catch((err) => {
    initialization = undefined
    useStore.getState().addToast('error', `Falha ao carregar conversas: ${err.message}`)
    throw err
  }),
  refreshProfiles: async (profiles) => set({ profiles: Array.isArray(profiles) ? profiles : await window.prism.providers.list() }),
  refreshImported: async () => {
    if (onHost()) {
      // The main process wrote the imported chats on the host: they arrive as deltas.
      const [snapshot, profiles, saved] = await Promise.all([window.prism.chats.host.list(), window.prism.providers.list(), window.prism.tasks.load()])
      useAgentTasks.setState(s => ({ tasks: [...s.tasks.filter(t => !saved.tasks.some(r => r.id === t.id)), ...saved.tasks] }))
      // One whose delta is still on its way is shown from the list (the delta replaces it).
      set(s => ({ profiles, chats: [...s.chats, ...snapshot.chats.filter(c => !s.chats.some(local => local.id === c.id)).map(withDrafts)] }))
      const imported = snapshot.chats.find(c => c.traycerSource)
      if (imported?.taskId) { useAgentTasks.getState().activate(imported.taskId); get().select(imported.id) }
      return
    }
    const [chats, profiles, saved] = await Promise.all([window.prism.chats.list(), window.prism.providers.list(), window.prism.tasks.load()])
    useAgentTasks.setState(s => ({ tasks: [...s.tasks.filter(t => !saved.tasks.some(r => r.id === t.id)), ...saved.tasks] }))
    set(s => ({ profiles, chats: [...s.chats.map(local => {
      const imported = chats.find(c => c.id === local.id)
      return imported?.traycerSource ? { ...local, taskId: imported.taskId, parentChatId: imported.parentChatId, archived: imported.archived, readOnly: imported.readOnly, sourceHarness: imported.sourceHarness, traycerSource: imported.traycerSource } : local
    }), ...chats.filter(c => !s.chats.some(local => local.id === c.id)).map(numberChatImages)] }))
    const imported = chats.find(c => c.traycerSource)
    if (imported?.taskId) { useAgentTasks.getState().activate(imported.taskId); get().select(imported.id) }
  },
  reimportFromTraycer: async (id) => {
    const chat = get().chats.find((c) => c.id === id)
    if (!chat?.traycerSource) return
    const toast = useStore.getState().addToast
    try {
      const result = await window.prism.traycer.reimportChat(id)
      // On the host the refreshed turns and resume arrive as a delta; in IPC mode
      // pull the updated chat in, keeping the active selection where it is.
      if (!onHost()) {
        const fresh = (await window.prism.chats.list()).find((c) => c.id === id)
        if (fresh) set((s) => ({ chats: s.chats.map((c) => c.id === id ? numberChatImages(withDrafts(fresh)) : c) }))
      }
      if (result.updated) toast('success', 'Histórico atualizado do Traycer.')
      else if (result.warnings.length) toast('error', result.warnings[0])
      else toast('info', 'Nada novo no Traycer; já está atualizado.')
    } catch (err) {
      toast('error', (err as Error).message)
    }
  },
  create: (cwd, remoteId, options) => {
    const parent = options?.parentChatId ? get().chats.find((c) => c.id === options.parentChatId) : undefined
    const legacyModel = useStore.getState().settings.model
    // A child agent inherits its parent's workspace and route (Traycer forks
    // the parent's run settings); a new chat starts from the last committed
    // route. SSH chats always run the server's terminal Claude.
    const workspace = parent ? { cwd: parent.cwd, remoteId: parent.remoteId, remoteTarget: parent.remoteTarget }
      : { cwd, remoteId, remoteTarget: remoteId ? remoteTargetNow() : undefined }
    const remembered: AgentSelection = parent ? { ...parent.selection }
      : workspace.remoteId ? { ...initialSelection(legacyModel), provider: 'claude', profileId: 'ambient-claude', model: legacyModel, serviceTier: '' }
      : initialSelection(legacyModel === 'claude-opus-4-8' ? '' : legacyModel)
    // A remembered profile may since have been removed or disabled.
    const profiles = get().profiles
    const usable = !profiles.length || profiles.some((p) => p.id === remembered.profileId && p.provider === remembered.provider && !p.tombstoned && p.enabled !== false)
    const selection: AgentSelection = usable ? remembered : { ...remembered, profileId: `ambient-${remembered.provider}` }
    const chat: UnifiedChat = { id: crypto.randomUUID(), title: 'Novo chat', taskId: parent?.taskId || useAgentTasks.getState().activeId || undefined, ...workspace,
      parentChatId: parent?.id, createdAt: Date.now(), selection, turns: [], updatedAt: Date.now() }
    // Host mode: shown at once, so the active chat always exists; the host's copy replaces it.
    set((s) => ({ chats: [...s.chats, chat], activeId: chat.id }))
    if (onHost()) hostCreate(chat)
    else persist(chat.id)
  },
  select: (id) => {
    const chat = get().chats.find(c => c.id === id)
    if (chat?.taskId) useAgentTasks.getState().activate(chat.taskId)
    historyVisits.set(id, ++historyVisit)
    set(s => ({ activeId: id, chats: trimHistories(s.chats, s.runtime, id) }))
    void get().loadHistory(id)
  },
  configure: (id, selection) => {
    const run = get().runtime[id]
    // The active run keeps its own route; this selection also applies to the queue.
    // Claude's Fast report describes the previous route; a new one starts unknown.
    const before = get().chats.find((c) => c.id === id)?.selection
    if (run?.fast && before && (routeKey(before) !== routeKey(selection) || before.model !== selection.model || (before.serviceTier || '') !== (selection.serviceTier || ''))) {
      set((s) => ({ runtime: { ...s.runtime, [id]: { ...run, fast: undefined } } }))
    }
    if (onHost()) return hostCommand(window.prism.chats.host.configure(id, selection))
    editChat(id, (c) => ({ ...c, selection,
      accountNeedsSelection: routeKey(c.selection) !== routeKey(selection) ? false : c.accountNeedsSelection,
      lastRunId: routeKey(c.selection) === routeKey(selection) ? c.lastRunId : undefined,
      resume: routeKey(c.selection) === routeKey(selection) ? c.resume : undefined }))
  },
  confirmAccount: (id) => {
    if (get().runtime[id]?.busy) return
    if (onHost()) hostCommand(window.prism.chats.host.confirmAccount(id))
    else editChat(id, (c) => ({ ...c, accountNeedsSelection: false }))
  },
  draft: (id, text) => onHost() ? setDraft(id, { draft: text }) : editChat(id, c => ({...c,draft:text})),
  contextDraft: (id, text) => onHost() ? setDraft(id, { contextDraft: text }) : editChat(id, c => ({...c,contextDraft:text})),
  rename: (id, title) => {
    if (!title.trim()) return
    // A chat running here is saved whole by this window: edit its own copy.
    if (onHost() && !runsHere(id)) hostCommand(window.prism.chats.host.rename(id, title.trim().slice(0, 100)))
    else editChat(id, (c) => ({ ...c, title: title.trim().slice(0, 100) }))
  },
  // Archiving waits for the run to stop; bringing a chat back never has to (as in Traycer).
  archive: (id, archived) => {
    if (archived && get().runtime[id]?.busy) return
    if (onHost() && !runsHere(id)) hostCommand(window.prism.chats.host.archive(id, archived))
    else editChat(id, (c) => ({ ...c, archived: archived || undefined }))
  },
  bindWorkspace: (id, cwd, remoteId) => {
    if (get().runtime[id]?.busy) return
    if (onHost()) {
      hostCommand(window.prism.chats.host.bindWorkspace({ chatId: id, cwd, remoteId, remoteTarget: remoteId ? remoteTargetNow() : undefined, model: useStore.getState().settings.model }))
      return
    }
    editChat(id, (c) => c.turns.length && !c.workspaceNeedsBinding ? c : { ...c, cwd, remoteId, workspaceNeedsBinding: false,
      remoteTarget: remoteId ? remoteTargetNow() : undefined, resume: undefined,
      selection: remoteId ? { ...c.selection, provider: 'claude', profileId: 'ambient-claude', model: useStore.getState().settings.model } : c.selection })
  },
  remove: async (id) => {
    if (get().runtime[id]?.busy) throw new Error('Pare a tarefa antes de excluir o chat.')
    clearTimeout(saveTimers.get(id)); saveTimers.delete(id)
    get().clearAttachments(id)
    if (onHost()) {
      const reply = await window.prism.chats.host.remove(id)
      // `not_found`: a chat the host never stored (its creation failed).
      if (!reply.ok && reply.code !== 'not_found') throw new Error(reply.error)
      forgetDrafts(id)
    } else await window.prism.chats.delete(id)
    // The next chat comes from the same task (most recent, not archived); with
    // none left the workspace creates a fresh one in the task's folder.
    set((s) => {
      if (s.activeId !== id) return { chats: s.chats.filter((c) => c.id !== id) }
      const gone = s.chats.find((c) => c.id === id)
      const next = s.chats.filter((c) => c.id !== id && !c.archived && c.taskId === gone?.taskId).sort((a, b) => b.updatedAt - a.updatedAt)[0]
      return { chats: s.chats.filter((c) => c.id !== id), activeId: next?.id ?? null }
    })
    if (get().activeId) void get().loadHistory(get().activeId!)
  },
  messageSubagent: async (id, text) => {
    const chat = get().chats.find(c => c.id === id)
    const native = chat?.nativeAgent
    if (!chat || chat.historyPending || !native || !text.trim() || get().subagentSending[id]) return false
    const admittedTurn = get().runtime[id]?.turnId ?? native.turnId ?? chat.turns.at(-1)?.id
    set(s => ({ subagentSending: { ...s.subagentSending, [id]: true } }))
    try {
      let delivery: string
      if (hostDrives(chat) && !get().runtime[id]?.local) {
        if (!hostCaps.includes('chats.subagents.message@1')) throw new Error('Atualize o host do Prism para enviar mensagens a subagentes.')
        const reply = await window.prism.chats.host.messageSubagent(id, text.trim())
        if (!reply.ok) throw new Error(reply.error)
        delivery = reply.delivery
      } else {
        const payload = { rootChatId: native.rootChatId, rootTurnId: native.controlTurnId ?? native.rootTurnId, agentId: native.controlId ?? native.id, text: text.trim() }
        const result = chat.selection.provider === 'codex'
          ? await window.prism.codex.messageSubagent(payload) : await window.prism.claude.agentMessageSubagent(payload)
        delivery = result.delivery
        if (delivery === 'direct') editChat(id, c => {
          const turnId = result.nativeTurnId && c.nativeAgent?.nativeTurns?.[result.nativeTurnId]
            || (result.steered ? admittedTurn : c.pendingTurnId ?? c.turns.at(-1)?.id)
          return { ...c, turns: c.turns.map(t => t.id === turnId ? { ...t, segments: [...(t.segments || []), { kind: 'user', toolId: crypto.randomUUID(), text: text.trim(), sentAt: Date.now() }] } : t) }
        })
      }
      useStore.getState().addToast('success', delivery === 'parent' ? 'Instrução encaminhada ao agente principal para entregar ao subagente.' : 'Mensagem enviada ao subagente.')
      return true
    } catch (error) {
      const message = (error as Error).message?.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
      useStore.getState().addToast('error', message || 'Não foi possível enviar ao subagente. Seu rascunho foi mantido.')
      return false
    } finally { set(s => ({ subagentSending: { ...s.subagentSending, [id]: false } })) }
  },
  send: (id, text, context, images, onRefused) => {
    const chat = stableLocalImages(id)
    if (!chat || chat.nativeAgent || (!text.trim() && !images?.length) || get().runtime[id]?.busy) return false
    const referenced = resolveImageReferences(chat, text, images)
    if (!referenced.ok) { useStore.getState().addToast('error', referenced.error); return false }
    const displayImages = imageAttachmentsForHistory(chat, images || [], referenced.images)
    if (chat.workspaceNeedsBinding || chat.accountNeedsSelection) {
      useStore.getState().addToast('error', 'Confirme a pasta e a conta deste chat importado antes de continuar.'); return false
    }
    if (chat.remoteId && (chat.selection.provider !== 'claude' || chat.selection.profileId !== 'ambient-claude')) {
      useStore.getState().addToast('error', 'No SSH, selecione Claude e a conta do terminal do servidor.'); return false
    }
    if (chat.remoteId && !sameRemoteTarget(chat.remoteTarget, remoteTargetNow())) {
      useStore.getState().addToast('error', 'Reconecte o servidor antes de continuar este chat.'); return false
    }
    const profile = get().profiles.find((p) => p.id === chat.selection.profileId)
    // Fast is a sticky preference; only a model that offers that tier gets it
    // (Traycer filters it in the adapter, not in the picker).
    const catalog = useModelCatalog.getState().entries[catalogKey(chat.remoteId ? 'claude' : chat.selection.provider, chat.remoteId ? 'ambient-claude' : chat.selection.profileId)]
    const serviceTier = effectiveServiceTier(chat.selection, catalog?.models.length ? selectedModelFor(chat.selection, catalog.models) ?? null : undefined)
    if (hostDrives(chat)) {
      // Busy at once (the host's runtime replaces this); the host builds the turns and runs them.
      const pending: ChatRuntime = { turnId: '', route: routeKey(chat.selection), busy: true, fast: get().runtime[id]?.fast }
      const previous = get().runtime[id]
      const recover = (): void => {
        if (onRefused) return onRefused()
        const current = get().chats.find(c => c.id === id)
        if (!current) return
        if (current.draft || current.contextDraft || get().attachments[id]?.length) {
          get().enqueue(id, { text, context, images })
        } else {
          get().draft(id, text); get().contextDraft(id, context || '')
          if (images?.length) get().attachImages(id, images)
        }
      }
      set((s) => ({ runtime: { ...s.runtime, [id]: pending }, stopping: { ...s.stopping, [id]: false } }))
      const undo = (): void => set((s) => {
        if (s.runtime[id] !== pending) return {}
        const runtime = { ...s.runtime }
        if (previous) runtime[id] = previous
        else delete runtime[id]
        return { runtime }
      })
      void window.prism.chats.host.send({ chatId: id, text, context: context || undefined, serviceTier: serviceTier || undefined, profileName: profile?.name, ...(images?.length ? { images } : {}) }).then((r) => {
        if (r.ok) set((s) => s.runtime[id] === pending ? { runtime: { ...s.runtime, [id]: { ...pending, turnId: r.turnId } } } : {})
        else { undo(); recover(); useStore.getState().addToast('error', r.error) }
      }, (err) => { undo(); recover(); useStore.getState().addToast('error', err.message) })
      return true
    }
    const turnId = crypto.randomUUID()
    const request = continuationPrompt(chat, referenced.prompt)
    const prompt = context ? `${request.prompt}\n\nArquivo aberto como contexto:\n${context}` : request.prompt
    // The last Fast report stays until this turn's own init replaces it.
    set((s) => ({ stopping: { ...s.stopping, [id]: false }, runtime: { ...s.runtime, [id]: { turnId, route: routeKey(chat.selection), busy: true, fast: s.runtime[id]?.fast, ...(onHost() ? { local: true } : {}) } } }))
    editChat(id, (c) => ({ ...c, pendingTurnId: turnId, lastRunId: turnId, title: c.turns.length ? c.title : (text.trim() || 'Imagem').slice(0, 48), updatedAt: Date.now(), turns: [...c.turns,
      { id: crypto.randomUUID(), role: 'user', text: context ? `${text}\n\n${context}` : text, ...(displayImages.length ? { images: displayImages } : {}) },
      { id: turnId, role: 'assistant', text: '', segments: [], provider: chat.selection.provider, selection: { ...chat.selection }, profileName: profile?.name, model: chat.selection.model, startedAt: Date.now() }] }))
    void persistNow(id).catch((err) => useStore.getState().addToast('error', `Falha ao salvar: ${err.message}`))
    const current = (): UnifiedChat | undefined => { const c = get().chats.find(c => c.id === id); return c && onHost() ? withoutDrafts(c) : c }
    if (chat.selection.provider === 'codex') window.prism.codex.send({ id: turnId, chatId: id, prompt, cwd: chat.cwd, resume: request.resume,
      selection: { ...chat.selection, serviceTier: serviceTier || '' }, chat: current(), images: referenced.images.length ? referenced.images : undefined })
    else window.prism.claude.agentSend({ id: turnId, prompt, cwd: chat.cwd || undefined, resume: request.resume,
      model: chat.selection.model, effort: chat.selection.effort, serviceTier,
      permissionMode: chat.selection.permissionMode, profileId: chat.selection.profileId, permissionScope: id, chat: current(),
      images: referenced.images.length ? referenced.images : undefined,
      remote: chat.remoteId ? useStore.getState().remote?.id : undefined, remoteTarget: chat.remoteTarget })
    return true
  },
  stop: (id) => {
    const run = get().runtime[id]
    const chat = get().chats.find((c) => c.id === id)
    if (!run?.busy || !chat || chat.nativeAgent || get().stopping[id]) return
    set((s) => ({ stopping: { ...s.stopping, [id]: true } }))
    if (onHost() && !run.local) {
      void window.prism.chats.host.stop(id).then((r) => {
        if (!r.ok) { set((s) => ({ stopping: { ...s.stopping, [id]: false } })); useStore.getState().addToast('error', r.error) }
      }, (err) => { set((s) => ({ stopping: { ...s.stopping, [id]: false } })); useStore.getState().addToast('error', err.message) })
      return
    }
    if (chat.selection.provider === 'codex') window.prism.codex.abort(id)
    else window.prism.claude.agentAbort(run.turnId)
  },
  respondPermission: (id, decision) => {
    const r = get().runtime[id]; if (!r?.permission) return
    if (onHost() && !r.local) {
      // The host's runtime brings the next pending permission, if any.
      set((s) => ({ runtime: { ...s.runtime, [id]: { ...r, permission: undefined } } }))
      return hostCommand(window.prism.chats.host.respondPermission({ chatId: id, permId: r.permission.permId, decision }), 'Esta permissão já foi respondida.')
    }
    const chat = get().chats.find(c => c.id === id)
    if (chat?.selection.provider === 'codex') window.prism.codex.permission(chat.nativeAgent?.rootChatId ?? id,r.permission.permId,decision)
    else window.prism.claude.agentRespondPermission({ id: chat?.nativeAgent?.rootTurnId ?? r.turnId, permId: r.permission.permId, decision })
    editTurn(r.turnId, (t) => ({ ...t, segments: t.segments?.map((s) => s.toolId === r.permission?.toolUseId
      ? { ...s, status: decision === 'deny' ? 'denied' : 'running' } : s) }))
    set((s) => ({ runtime: { ...s.runtime, [id]: { ...r, permission: undefined } } }))
  },
  respondQuestion: async (id, answers, response) => {
    const r = get().runtime[id]
    const question = r?.question
    const chat = get().chats.find(c => c.id === id)
    if (!r || !question || !chat) return false
    try {
      if (onHost() && !r.local) {
        const reply = await window.prism.chats.host.respondQuestion({ chatId: id, dialogId: question.dialogId, answers, response })
        if (!reply.ok) {
          useStore.getState().addToast('error', reply.code === 'gone' ? 'Esta pergunta já foi respondida.' : reply.error)
          return false
        }
      } else if (chat.selection.provider === 'codex') window.prism.codex.question(chat.nativeAgent?.rootChatId ?? id, question.dialogId, answers)
      else window.prism.claude.agentRespondQuestion({ id: chat.nativeAgent?.rootTurnId ?? r.turnId, dialogId: question.dialogId, answers, response, cancelled: !answers })
      // A host delta may already have removed this question or delivered the next
      // one. Clear only the answered dialog, retaining the latest runtime fields.
      set(s => {
        const current = s.runtime[id]
        if (current?.turnId !== r.turnId || current.question?.dialogId !== question.dialogId) return {}
        return { runtime: { ...s.runtime, [id]: { ...current, question: undefined } } }
      })
      return true
    } catch (error) {
      useStore.getState().addToast('error', (error as Error).message || 'Não foi possível enviar a resposta. Tente novamente.')
      return false
    }
  },
  replyToQuestions: async (id, sourceKey, answers) => {
    const chat = get().chats.find(c => c.id === id)
    const source = chat && latestStructuredQuestions(chat.turns)
    if (!chat || chat.historyPending || chat.readOnly || !source || source.key !== sourceKey) return false
    const text = buildStructuredQuestionsReply(source, answers)
    if (!text) return false
    const message: QueuedMessage = { id: `question:${source.key}`, text }
    const replyKey = `${id}:${source.key}`
    const existingReply = questionRepliesInFlight.get(replyKey)
    if (existingReply) return existingReply
    const work = (async (): Promise<boolean> => {
      try {
        if (sharedQueue(chat)) {
          const existing = get().chats.find(c => c.id === id)?.queued?.some(row => row.id === message.id) || queuedQuestionReplies.has(replyKey)
          const added = await window.prism.chats.host.queue(id, existing ? 'replace' : 'add', { id: message.id, message })
          if (!added.ok) {
            if (added.code === 'gone') queuedQuestionReplies.delete(replyKey)
            useStore.getState().addToast('error', added.error)
            return false
          }
          queuedQuestionReplies.add(replyKey)
          const run = get().runtime[id]
          if (run?.busy && (run.permission || run.question || !run.turnId || get().steering[id] || get().stopping[id])) {
            useStore.getState().addToast('info', 'Resposta adicionada à fila. Ela será enviada quando o agente puder continuar.')
            return true
          }
          const sent = await window.prism.chats.host.queue(id, 'send', { id: message.id })
          if (!sent.ok) { useStore.getState().addToast('error', sent.error); return false }
          queuedQuestionReplies.delete(replyKey)
          return true
        }
        const current = get().chats.find(c => c.id === id)
        const run = get().runtime[id]
        if (!current) return false
        const existing = current.queued?.find(row => row.id === message.id)
        if (!run?.busy) {
          if (!get().send(id, text)) return false
          if (existing) get().dequeue(id, get().chats.find(c => c.id === id)?.queued?.findIndex(row => row.id === message.id) ?? -1)
          return true
        }
        if (existing) get().replaceQueued(id, existing, message)
        else get().enqueue(id, message)
        if (current.remoteId || run.permission || run.question || !run.turnId || get().steering[id] || get().stopping[id]) {
          useStore.getState().addToast('info', 'Resposta adicionada à fila. Ela será enviada quando o agente puder continuar.')
          return true
        }
        const index = get().chats.find(c => c.id === id)?.queued?.findIndex(row => row.id === message.id) ?? -1
        return await get().steerQueued(id, index)
      } catch (error) {
        useStore.getState().addToast('error', (error as Error).message || 'Não foi possível enviar a resposta. Ela continua disponível para tentar novamente.')
        return false
      }
    })()
    questionRepliesInFlight.set(replyKey, work)
    try { return await work }
    finally { questionRepliesInFlight.delete(replyKey) }
  },
  attachImages: (id, images) => {
    if (!images.length) return
    set((s) => {
      const chat = s.chats.find(c => c.id === id)
      if (!chat || chat.historyPending) return {}
      const pending = s.attachments[id] || []
      const numbered = numberNewImages(chat, pending, images, imageNumberHighWater.get(id))
      imageNumberHighWater.set(id, numbered.reduce((max, image) => Math.max(max, image.number || 0), imageNumberHighWater.get(id) || 0))
      return { attachments: { ...s.attachments, [id]: [...pending, ...numbered] } }
    })
  },
  removeImage: (id, index) => set((s) => {
    const list = (s.attachments[id] || []).filter((_, i) => i !== index)
    const next = { ...s.attachments }
    if (list.length) next[id] = list; else delete next[id]
    return { attachments: next }
  }),
  clearAttachments: (id) => set((s) => {
    if (!s.attachments[id]) return {}
    const next = { ...s.attachments }; delete next[id]
    return { attachments: next }
  }),
  enqueue: (id, msg, now) => {
    if (!msg.text.trim() && !msg.images?.length) return
    const chat = stableLocalImages(id); if (!chat) return
    if (sharedQueue(chat)) {
      void window.prism.chats.host.queue(id, 'add', { message: msg }).then(reply => {
        if (!reply.ok) { useStore.getState().addToast('error', reply.error); return }
        if (now) queueCommand(id, 'send', { id: (reply as { id?: string }).id })
      })
      return
    }
    const queued = [...(chat.queued || []), msg]
    if (onHost()) setDraft(id, { queued }); else editChat(id, (c) => ({ ...c, queued }))
    if (now) void get().steerQueued(id, queued.length - 1)
  },
  dequeue: (id, index) => {
    const chat = stableLocalImages(id); if (!chat?.queued) return
    if (sharedQueue(chat)) { queueCommand(id, 'remove', { id: chat.queued[index]?.id }); return }
    const queued = chat.queued.filter((_, i) => i !== index)
    if (onHost()) setDraft(id, { queued }); else editChat(id, (c) => ({ ...c, queued }))
  },
  pauseQueue: (id, paused) => {
    if (sharedQueue(get().chats.find(c => c.id === id))) { queueCommand(id, 'pause', { paused }); return }
    if (onHost()) setDraft(id, { queuePaused: paused }); else editChat(id, c => ({ ...c, queuePaused: paused }))
    if (!paused) get().flushQueue(id)
  },
  replaceQueued: (id, item, replacement) => {
    const original = get().chats.find(c => c.id === id)
    const index = original?.queued?.indexOf(item) ?? -1
    const chat = stableLocalImages(id); if (!chat) return
    if (sharedQueue(chat)) { queueCommand(id, 'replace', { id: item.id, message: replacement }); return }
    const catalog = collectChatImages(chat)
    const images = replacement.images?.map(image => {
      const number = imageReferenceNumber(catalog, image)
      return number === undefined ? image : { ...image, number }
    })
    const numbered = images ? numberNewImages(chat, [], images, imageNumberHighWater.get(id)) : undefined
    const updated = numbered ? { ...replacement, images: numbered } : replacement
    const queued = (chat.queued || []).map((q, position) => position === index ? updated : q)
    if (onHost()) setDraft(id, { queued }); else editChat(id, c => ({ ...c, queued }))
  },
  reorderQueued: (id, from, to) => {
    const chat = stableLocalImages(id); if (!chat?.queued || get().steering[id]) return
    if (sharedQueue(chat)) { queueCommand(id, 'move', { id: chat.queued[from]?.id, to }); return }
    const queued = [...chat.queued]
    if (from < 0 || to < 0 || from >= queued.length || to >= queued.length || from === to) return
    queued.splice(to, 0, queued.splice(from, 1)[0])
    if (onHost()) setDraft(id, { queued }); else editChat(id, c => ({ ...c, queued }))
  },
  steerQueued: async (id, index) => {
    const chat = stableLocalImages(id), state = get(), item = chat?.queued?.[index], run = state.runtime[id]
    if (!chat || !item || chat.readOnly || state.steering[id] || state.stopping[id]) return false
    if (sharedQueue(chat)) {
      set(s => ({ steering: { ...s.steering, [id]: item } }))
      try { const reply = await window.prism.chats.host.queue(id, 'send', { id: item.id }); if (!reply.ok) useStore.getState().addToast('error', reply.error); return reply.ok }
      finally { set(s => ({ steering: { ...s.steering, [id]: undefined } })) }
    }
    const remove = (): void => {
      const queued = (get().chats.find(c => c.id === id)?.queued || []).filter(q => q !== item)
      if (onHost()) setDraft(id, { queued }); else editChat(id, c => ({ ...c, queued }))
    }
    if (!run?.busy) {
      const restore = (): void => {
        const queued = [...(get().chats.find(c => c.id === id)?.queued || [])]
        queued.splice(Math.min(index, queued.length), 0, item)
        if (onHost()) setDraft(id, { queued }); else editChat(id, c => ({ ...c, queued }))
      }
      if (!state.send(id, item.text, item.context, item.images, restore)) return false
      remove(); return true
    }
    if (chat.remoteId || run.permission || run.question || !run.turnId) {
      useStore.getState().addToast('info', chat.remoteId ? 'Envio durante o turno não está disponível nesta conexão SSH.' : 'Aguarde o início do turno ou responda à aprovação/pergunta antes de enviar agora.')
      return false
    }
    const referenced = resolveImageReferences(chat, item.text, item.images)
    if (!referenced.ok) { useStore.getState().addToast('error', referenced.error); return false }
    const displayImages = imageAttachmentsForHistory(chat, item.images || [], referenced.images)
    set(s => ({ steering: { ...s.steering, [id]: item } }))
    try {
      const payload = { messageId: crypto.randomUUID(), chatId: id, turnId: run.turnId, text: item.text, context: item.context, images: item.images }
      if (onHost() && !run.local) {
        const reply = await window.prism.chats.host.steer(payload)
        if (!reply.ok) throw new Error(reply.error)
      } else {
        const nativePayload = { ...payload, text: referenced.prompt, images: referenced.images.length ? referenced.images : undefined }
        if (chat.selection.provider === 'codex') await window.prism.codex.steer(nativePayload)
        else await window.prism.claude.agentSteer(nativePayload)
        flushTurns()
        const segment: SharedSegment = { kind: 'user', toolId: payload.messageId, text: item.context ? `${item.text}\n\n${item.context}` : item.text, images: displayImages.length ? displayImages : undefined, sentAt: Date.now() }
        editChat(id, c => ({ ...c, turns: c.turns.map(t => t.id === run.turnId ? { ...t, segments: [...(t.segments || []), segment] } : t) }))
      }
      remove()
      return true
    } catch (error) {
      useStore.getState().addToast('error', (error as Error).message || 'Não foi possível enviar agora. A mensagem continua na fila.')
      return false
    } finally {
      set(s => ({ steering: { ...s.steering, [id]: undefined } }))
      // Completion may arrive while the native steering acknowledgement is in flight.
      // Its normal queue flush was held by steering; resume only after a clean finish.
      const finished = get().chats.find(c => c.id === id)?.turns.find(t => t.id === run.turnId)
      if (!get().runtime[id]?.busy && finished?.completedAt && !finished.error && !finished.interrupted) get().flushQueue(id)
    }
  },
  flushQueue: (id) => {
    stableLocalImages(id)
    const state = get()
    if (sharedQueue(state.chats.find(c => c.id === id))) return // the engine advances once, even with multiple windows
    const run = state.runtime[id]
    if (run?.busy || run?.permission || run?.question || state.steering[id]) return
    const chat = state.chats.find((c) => c.id === id)
    const next = chat?.queued?.[0]
    if (!chat || !next || chat.queuePaused || state.editingQueue[id] === next) return
    // Send first; only drop it from the queue if the turn was accepted.
    const restore = (): void => {
      const c = get().chats.find(c => c.id === id); if (!c) return
      const queued = [next, ...(c.queued || [])]
      if (onHost()) setDraft(id, { queued }); else editChat(id, c => ({ ...c, queued }))
    }
    if (!state.send(id, next.text, next.context, next.images, restore)) return
    const rest = (get().chats.find((c) => c.id === id)?.queued || []).slice(1)
    if (onHost()) setDraft(id, { queued: rest }); else editChat(id, (c) => ({ ...c, queued: rest }))
  },
  importSession: (chat) => {
    chat = numberChatImages(chat)
    chat = { ...chat, taskId: chat.taskId || useAgentTasks.getState().activeId || undefined }
    const existing = get().chats.find((c) => c.resume?.sessionId === chat.resume?.sessionId && c.remoteId === chat.remoteId)
    if (existing) { get().select(existing.id); return }
    set((s) => ({ chats: [...s.chats, chat], activeId: chat.id }))
    if (onHost()) hostCreate(chat)
    else persist(chat.id)
  }
}))

export function remoteTargetNow(): UnifiedChat['remoteTarget'] {
  const remote = useStore.getState().remote
  return remote ? { host: remote.host, port: remote.port, username: remote.username } : undefined
}
