import type { AgentTask, ProviderProfile, UnifiedChat } from '../shared/agents'
import type { ChatsWritten } from '../shared/host/generated/ChatsWritten'
import type { ChatsSnapshot } from '../shared/host/generated/ChatsSnapshot'
import type { CredentialLink } from '../shared/host/generated/CredentialLink'
import type { ProfilesList } from '../shared/host/generated/ProfilesList'
import type { Reassigned } from '../shared/host/generated/Reassigned'
import type { StoredProfilesList } from '../shared/host/generated/StoredProfilesList'
import type { TasksState } from '../shared/host/generated/TasksState'
import { agentStore, type StoredProfile } from './providers'
import { hostBinaryPresent } from './host/supervisor'
import { mainHostClient } from './host/mainClient'
import { moveChatsToTerminal } from './ipc/providerProfiles'

/**
 * Where the main process reads and writes chats and tasks (T07). With a host
 * binary, the host owns them as soon as it serves `chats@1`; an older host,
 * or no binary at all, leaves them in `prism-agents.db` (`agentStore`) as in
 * 0.2. With a binary present this never falls back to `agentStore` on its
 * own: two databases would drift apart, so an unreachable host is an error.
 */

export type ChatsBackend = 'host' | 'ipc'

const CONNECT_TIMEOUT_MS = 20_000
const NO_HOST = 'O host do Prism não respondeu.'

let decided: ChatsBackend | null = null
let deciding: Promise<ChatsBackend> | null = null

/** The backend, once known without waiting: decided, or `ipc` without a binary. */
export function knownChatsBackend(): ChatsBackend | null {
  return decided ?? (hostBinaryPresent() ? null : 'ipc')
}

/**
 * `host` when the connected host serves `chats@1`, `ipc` without a binary or
 * with an older host. Waits for the connection; rejects when the host does
 * not answer in time (a later call tries again). Settled once per app run.
 */
export function chatsBackend(): Promise<ChatsBackend> {
  const known = knownChatsBackend()
  if (known) return Promise.resolve(known)
  deciding ??= connected(CONNECT_TIMEOUT_MS)
    .then(() => (decided = mainHostClient().serves('chats') ? 'host' : 'ipc'))
    .finally(() => { deciding = null })
  return deciding
}

function connected(ms: number): Promise<void> {
  const client = mainHostClient()
  return new Promise((resolve, reject) => {
    let settled = false
    let off: (() => void) | undefined
    const settle = (ok: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      off?.()
      if (ok) resolve()
      else reject(new Error(NO_HOST))
    }
    const timer = setTimeout(() => settle(false), ms)
    // An incompatible host stays refused: no point waiting for it.
    off = client.onStatus((status) => {
      if (status.state === 'connected') settle(true)
      else if (status.state === 'incompatible') settle(false)
    })
    if (settled) off()
  })
}

// A new host imports 0.2's data on its first storage access: the calls wait
// longer until one has answered.
const FIRST_CALL_MS = 120_000
let answered = false
async function host<T>(method: string, params: unknown): Promise<T> {
  const result = await mainHostClient().call<T>(method, params, answered ? undefined : FIRST_CALL_MS)
  answered = true
  return result
}

/** Every chat, folded as the UI shows it; a running one has `pendingTurnId`. */
export async function listChats(): Promise<UnifiedChat[]> {
  if (await chatsBackend() === 'ipc') return agentStore.get('chats')
  return (await host<ChatsSnapshot>('chats.list', {})).chats
}

export async function listTasks(): Promise<TasksState> {
  if (await chatsBackend() === 'ipc') return { tasks: agentStore.get('tasks'), ...agentStore.readState('task-tabs', { openIds: [] as string[], activeId: null as string | null }) }
  return host<TasksState>('tasks.load', {})
}

/** Replaces every task and the open tabs. */
export async function saveTasks(tasks: AgentTask[], openIds: string[], activeId: string | null): Promise<void> {
  if (await chatsBackend() === 'host') await host('tasks.save', { tasks, openIds, activeId })
  else storeTasks(tasks, openIds, activeId)
}

function storeTasks(tasks: AgentTask[], openIds: string[], activeId: string | null): void {
  agentStore.set('tasks', tasks)
  agentStore.writeState('task-tabs', { openIds, activeId })
}

/** Inserts or replaces these tasks only. */
export async function mergeTasks(tasks: AgentTask[]): Promise<void> {
  if (!tasks.length) return
  if (await chatsBackend() === 'host') {
    await host('tasks.merge', { tasks })
    return
  }
  for (const task of tasks) agentStore.upsert('tasks', task)
}

/**
 * Chats created or changed outside a window (Traycer import, login links, a
 * single save). The host skips those it is running and lists them; the
 * repository refuses them (throws), as in 0.2.
 */
export async function importChatDocs(chats: UnifiedChat[]): Promise<ChatsWritten> {
  if (!chats.length) return { written: 0, skipped: [] }
  if (await chatsBackend() === 'host') return host<ChatsWritten>('chats.importDocs', { chats })
  for (const chat of chats) agentStore.upsert('chats', chat)
  return { written: chats.length, skipped: [] }
}

/** A window's last save before closing; the host skips the chats it runs. */
export async function flushChats(chats: UnifiedChat[]): Promise<ChatsWritten> {
  if (!chats.length) return { written: 0, skipped: [] }
  if (await chatsBackend() === 'host') return host<ChatsWritten>('chats.flush', { chats })
  storeChats(chats)
  return { written: chats.length, skipped: [] }
}

function storeChats(chats: UnifiedChat[]): void {
  const ids = new Set(chats.map((c) => c.id))
  agentStore.set('chats', [...agentStore.get('chats').filter((c) => !ids.has(c.id)), ...chats])
}

/** Deletes chats and their journal; a missing one is not an error. */
export async function removeChats(ids: string[]): Promise<void> {
  if (!ids.length) return
  if (await chatsBackend() === 'ipc') {
    for (const id of ids) agentStore.removeChat(id)
    return
  }
  for (const chatId of ids) {
    try {
      await host('chats.remove', { chatId })
    } catch (err) {
      if ((err as { code?: unknown }).code !== 'not_found') throw err
    }
  }
}

/**
 * Chats of a removed profile move to its provider's terminal account; how
 * many moved. The host answers `busy` when one of them is running.
 */
export async function reassignProfile(profileId: string): Promise<number> {
  if (await chatsBackend() === 'host') return (await host<Reassigned>('chats.reassignProfile', { profileId })).moved
  const chats = agentStore.get('chats')
  const moved = moveChatsToTerminal(chats, profileId)
  if (!moved) return 0
  agentStore.set('chats', moved)
  return chats.filter((c) => c.selection.profileId === profileId).length
}

/*
 * The provider profiles (T08). The host owns them once it serves
 * `providers@1`, with their logins and Traycer links; an older host, or no
 * binary, leaves them in `prism-agents.db` as before. Decided with the chats:
 * a host without `chats@1` has no `providers@1` either.
 */

let profilesDecided: ChatsBackend | null = null

export async function profilesBackend(): Promise<ChatsBackend> {
  if (profilesDecided) return profilesDecided
  if (await chatsBackend() === 'ipc') return (profilesDecided = 'ipc')
  // The capabilities of the host chatsBackend connected to (kept while it reconnects).
  const hello = mainHostClient().status().hello
  if (!hello) throw new Error(NO_HOST)
  return (profilesDecided = hello.capabilities.includes('providers@1') ? 'host' : 'ipc')
}

/** The profiles as stored, Traycer links included: the host's, or prism-agents.db's. */
export async function storedProfiles(): Promise<StoredProfile[]> {
  if (await profilesBackend() === 'ipc') return agentStore.get('profiles') as StoredProfile[]
  return (await host<StoredProfilesList>('providers.stored', {})).profiles as StoredProfile[]
}

/** The list the renderer sees, from the host (`publicProfiles()` without it). */
export async function hostProfileList(): Promise<ProviderProfile[]> {
  return (await host<ProfilesList>('providers.list', {})).profiles
}

/** Inserts or replaces these profiles on the host (the Traycer import); their links go through `setProfileLink`. */
export async function importHostProfiles(profiles: StoredProfile[]): Promise<void> {
  if (profiles.length) await host('providers.importProfiles', { profiles })
}

/**
 * Links a profile to a Traycer account's login, or unlinks it (`null`), on
 * the host: it answers `busy` while the profile runs, forgets the native
 * sessions of its chats and retires the old copy of the login itself.
 */
export async function setProfileLink(id: string, link: CredentialLink | null): Promise<ProviderProfile[]> {
  return (await host<ProfilesList>('providers.setLink', { id, link })).profiles
}

/*
 * The windows' last saves while closing come by synchronous IPC
 * (`chats:flush`, `tasks:flush`). Without a host they are written right away;
 * to the host they answer before it does, so the writes are tracked and the
 * app waits for them before quitting (index.ts).
 */

/** `chats:flush`. Throws only when writing to `prism-agents.db`. */
export function flushChatsNow(chats: UnifiedChat[]): void {
  if (knownChatsBackend() === 'ipc') storeChats(chats)
  else trackHostWrite(flushChats(chats), 'chats.flush')
}

/** `tasks:flush`. Throws only when writing to `prism-agents.db`. */
export function flushTasksNow(tasks: AgentTask[], openIds: string[], activeId: string | null): void {
  if (knownChatsBackend() === 'ipc') storeTasks(tasks, openIds, activeId)
  else trackHostWrite(saveTasks(tasks, openIds, activeId), 'tasks.save')
}

const pendingWrites = new Set<Promise<void>>()

export function trackHostWrite(write: Promise<unknown>, label: string): void {
  const tracked: Promise<void> = write
    .then(() => undefined, (err) => { console.warn(`[host] ${label}:`, (err as Error)?.message ?? err) })
    .finally(() => { pendingWrites.delete(tracked) })
  pendingWrites.add(tracked)
}

export function pendingHostWrites(): number {
  return pendingWrites.size
}

/** Resolves once every tracked write settled, or after `ms`. */
export async function drainHostWrites(ms: number): Promise<void> {
  const deadline = Date.now() + ms
  while (pendingWrites.size && Date.now() < deadline) {
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      Promise.allSettled([...pendingWrites]),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, Math.max(0, deadline - Date.now())) })
    ])
    clearTimeout(timer)
  }
}
