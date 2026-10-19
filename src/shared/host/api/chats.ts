import type { AgentSelection, SteerMessage, SubagentMessageResult, UnifiedChat } from '../../agents'
import type { HostCallErrorCode, HostStatus } from '../client'
import type { BindWorkspaceParams } from '../generated/BindWorkspaceParams'
import type { ChatDelta } from '../generated/ChatDelta'
import type { ChatsDeltaBatch } from '../generated/ChatsDeltaBatch'
import type { ChatsSnapshot } from '../generated/ChatsSnapshot'
import type { OkResult } from '../generated/OkResult'
import type { PermissionParams } from '../generated/PermissionParams'
import type { QuestionParams } from '../generated/QuestionParams'
import type { SendParams } from '../generated/SendParams'
import type { SendResult } from '../generated/SendResult'
import { isDisconnected } from './call'

/**
 * `window.prism.chats.host` (T07): the host owns the agent chats and runs
 * their turns, so they go on with every window closed. `follow` keeps a
 * window's copy: a snapshot of every chat, then the `chats.delta` batches
 * after it (applied with applyChatDeltas, src/shared/chatDeltas.ts), and a
 * fresh snapshot after each reconnection or a gap in `rev`.
 *
 * Commands resolve with `{ ok: false, code, error }` when the host refuses
 * them (`busy`, `gone`, `invalid`, a dropped connection…): an Error crossing
 * the context bridge keeps only its message, and the renderer needs the code.
 */

type Unsub = () => void

/** The slice of `HostClient` this needs. */
export interface ChatsHostClient {
  call<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>
  onNotification(method: string, listener: (params: unknown) => void): () => void
  onStatus(listener: (status: HostStatus) => void): () => void
  serves?(domain: string, major?: number): boolean
}

/** A command's answer: its result, or the host's refusal (pt-BR message). */
export type ChatsReply<T extends object = OkResult> = (T & { ok: true }) | { ok: false; code: HostCallErrorCode; error: string }

export interface HostChatsApi {
  /** Every chat and runtime; from then on this connection receives `chats.delta` (use `follow`). */
  subscribe(): Promise<ChatsSnapshot>
  unsubscribe(): Promise<OkResult>
  /** A snapshot without subscribing. */
  list(): Promise<ChatsSnapshot>
  create(chat: UnifiedChat): Promise<ChatsReply>
  /** Stores a chat this window runs itself (the old SSH mode, Claude without `claude@1`). */
  put(chat: UnifiedChat): Promise<ChatsReply>
  queue(chatId: string, operation: string, payload?: Record<string, unknown>): Promise<ChatsReply>
  configure(chatId: string, selection: AgentSelection): Promise<ChatsReply>
  confirmAccount(chatId: string): Promise<ChatsReply>
  bindWorkspace(params: BindWorkspaceParams): Promise<ChatsReply>
  rename(chatId: string, title: string): Promise<ChatsReply>
  archive(chatId: string, archived: boolean): Promise<ChatsReply>
  /** Allowed while the chat runs; no `taskId` takes the chat out of its task. */
  setTask(chatId: string, taskId?: string): Promise<ChatsReply>
  remove(chatId: string): Promise<ChatsReply>
  send(params: SendParams): Promise<ChatsReply<SendResult>>
  stop(chatId: string): Promise<ChatsReply>
  steer(params: SteerMessage): Promise<ChatsReply>
  messageSubagent(chatId: string, text: string): Promise<ChatsReply<SubagentMessageResult>>
  respondPermission(params: PermissionParams): Promise<ChatsReply>
  respondQuestion(params: QuestionParams): Promise<ChatsReply>
  /**
   * Follows every chat: `onSnapshot` with the whole state (first, and again
   * after a reconnection or a gap), then `onDeltas` with each delta after
   * it, once and in order. Returns the stop.
   */
  follow(onSnapshot: (snapshot: ChatsSnapshot) => void, onDeltas: (deltas: ChatDelta[], rev: number) => void): Unsub
}

/** A snapshot holds every chat with every turn; a new host first imports the 0.2 data. */
const SNAPSHOT_MS = 120_000
/** A send may wait for the chat's previous process to close. */
const SEND_MS = 60_000
/** Before subscribing again after a refusal that was not a dropped connection. */
const RETRY_MS = 2_000

export function createHostChats(client: ChatsHostClient): HostChatsApi {
  const call = <T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> => client.call<T>(`chats.${method}`, params, timeoutMs)
  const command = async <T extends object = OkResult>(method: string, params: unknown, timeoutMs?: number): Promise<ChatsReply<T>> => {
    try {
      return { ...(await call<T>(method, params, timeoutMs)), ok: true as const }
    } catch (err) {
      const code = (err as { code?: HostCallErrorCode } | null)?.code ?? 'internal'
      return { ok: false, code, error: (err as Error)?.message || String(err) }
    }
  }

  const follow: HostChatsApi['follow'] = (onSnapshot, onDeltas) => {
    let stopped = false
    /** The last rev applied; null while (re)subscribing, when batches wait in `held`. */
    let rev: number | null = null
    let held: ChatsDeltaBatch[] = []
    /** Answers of an older subscribe are dropped. */
    let generation = 0
    let subscribed = false
    let down = true
    let retry: ReturnType<typeof setTimeout> | undefined

    const deliver = (batch: ChatsDeltaBatch): void => {
      if (rev === null) return
      if (batch.rev <= rev) return
      const first = batch.rev - batch.deltas.length + 1
      // Deltas were lost (a batch never arrived): start over from a snapshot.
      if (first > rev + 1) return subscribe()
      const fresh = batch.deltas.slice(rev + 1 - first)
      rev = batch.rev
      if (fresh.length) onDeltas(fresh, batch.rev)
    }

    const subscribe = (): void => {
      clearTimeout(retry)
      const mine = ++generation
      rev = null
      held = []
      call<ChatsSnapshot>('subscribe', {}, SNAPSHOT_MS).then((snapshot) => {
        if (stopped || mine !== generation) return
        subscribed = true
        rev = snapshot.rev
        onSnapshot(snapshot)
        const waiting = held
        held = []
        for (const batch of waiting) {
          // Every batch received before the snapshot's own is already in it.
          if (mine !== generation) break
          deliver(batch)
        }
      }, (err: unknown) => {
        if (stopped || mine !== generation) return
        // A dropped connection subscribes again when it comes back.
        if (!isDisconnected(err)) retry = setTimeout(() => { if (!stopped && !down) subscribe() }, RETRY_MS)
      })
    }

    // Listening before subscribing: batches the host sends before its answer wait in `held`.
    const offDelta = client.onNotification('chats.delta', (params) => {
      if (stopped) return
      const batch = params as ChatsDeltaBatch | null
      if (!batch || typeof batch.rev !== 'number' || !Array.isArray(batch.deltas)) return
      if (rev === null) held.push(batch)
      else deliver(batch)
    })
    const offStatus = client.onStatus((status) => {
      if (stopped) return
      if (status.state === 'connected') {
        if (!down) return
        down = false
        subscribe()
      } else if (!down) {
        // The host forgets this connection's subscription; the next one starts from a snapshot.
        down = true
        subscribed = false
        generation++
        rev = null
        held = []
        clearTimeout(retry)
      }
    })

    return () => {
      if (stopped) return
      stopped = true
      clearTimeout(retry)
      offDelta()
      offStatus()
      if (subscribed && !down) void call('unsubscribe', {}).catch(() => undefined)
    }
  }

  return {
    subscribe: () => call<ChatsSnapshot>('subscribe', {}, SNAPSHOT_MS),
    unsubscribe: () => call<OkResult>('unsubscribe', {}),
    list: () => call<ChatsSnapshot>('list', {}, SNAPSHOT_MS),
    create: (chat) => command('create', { chat }),
    put: (chat) => command('put', { chat }),
    queue: (chatId, operation, payload = {}) => command('queue', { chatId, operation, ...payload }),
    configure: (chatId, selection) => command('configure', { chatId, selection }),
    confirmAccount: (chatId) => command('confirmAccount', { chatId }),
    bindWorkspace: (params) => command('bindWorkspace', params),
    rename: (chatId, title) => command('rename', { chatId, title }),
    archive: (chatId, archived) => command('archive', { chatId, archived }),
    setTask: (chatId, taskId) => command('setTask', taskId ? { chatId, taskId } : { chatId }),
    remove: (chatId) => command('remove', { chatId }),
    send: (params) => command<SendResult>('send', params, SEND_MS),
    stop: (chatId) => command('stop', { chatId }),
    steer: (params) => command('steer', params),
    messageSubagent: (chatId, text) => command('messageSubagent', { chatId, text }),
    respondPermission: (params) => command('respondPermission', params),
    respondQuestion: (params) => command('respondQuestion', params),
    follow
  }
}
