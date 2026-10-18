import { useStore } from '../store'
import { useAgentChats } from './agentChats'
import { buildRemoteSnapshot, remoteTitle, runRemoteCommand, type RemoteResult } from './remoteControlModel'

export { buildRemoteSnapshot } from './remoteControlModel'

/**
 * /remote-control for a unified agent chat: opens (or reuses) the private
 * Cloudflare tunnel, gets this chat its OWN link (it reads and commands only
 * this chat) and shows the connection panel (RemoteControlModal). Already
 * shared: just reopen the panel on this chat's link.
 */
export async function startRemoteControl(chatId: string): Promise<void> {
  const store = useStore.getState()
  const chat = useAgentChats.getState().chats.find((c) => c.id === chatId)
  if (!chat) return
  if (store.rcEnabledTabs.includes(chatId) && store.rcInfo) {
    store.openRcModal(chatId)
    return
  }
  store.addToast('info', 'Abrindo o túnel de controle remoto… (pode levar alguns segundos na 1ª vez)')
  const title = remoteTitle(chat)
  let res: Awaited<ReturnType<Window['prism']['remoteControl']['enable']>>
  try {
    res = await window.prism.remoteControl.enable({ tabId: chatId, title })
  } catch (err) {
    // Refused only when the host never answered the first `hello`.
    res = { ok: false, error: (err as Error).message }
  }
  if (!res.ok || !res.url || !res.baseUrl || !res.token) {
    useStore.getState().addToast('error', `Não consegui abrir o túnel: ${res.error || 'erro desconhecido'}`)
    return
  }
  useStore.getState().enableRemoteControl(chatId, title, { baseUrl: res.baseUrl, token: res.token })
  // The bridge pushes on every change; push once now so the phone has the
  // chat before anything else happens in it. The host builds its own.
  if (!remoteOnHost()) pushRemoteSnapshot(chatId, true)
  useStore.getState().addToast('success', 'Controle remoto ativo. O link deste chat controla só esta conversa — não compartilhe.')
}

/** Stops sharing one chat: its link stops working; the last one also closes the tunnel. */
export function stopRemoteControl(chatId: string): void {
  forgetRemoteSnapshot(chatId)
  useStore.getState().disableRemoteControl(chatId)
}

export function isRemoteControlled(chatId: string): boolean {
  return useStore.getState().rcEnabledTabs.includes(chatId)
}

/**
 * The host serves `remote@1` (T09): it builds the shared chats' snapshots,
 * runs the phone's commands and revokes the links of deleted or archived
 * chats, so this window pushes nothing and its bridge stays off.
 */
export function remoteOnHost(): boolean {
  return window.prism.host.route('remote') === 'host'
}

// Last snapshot sent per chat: identical pushes (a re-render that changed
// nothing the phone shows) never cross the IPC at all.
const lastPushed = new Map<string, string>()

export function forgetRemoteSnapshot(chatId?: string): void {
  if (chatId === undefined) lastPushed.clear()
  else lastPushed.delete(chatId)
}

/** Sends the chat's current snapshot to main (which forwards only the delta to phones). */
export function pushRemoteSnapshot(chatId: string, force = false): void {
  const state = useAgentChats.getState()
  const chat = state.chats.find((c) => c.id === chatId)
  if (!chat) return
  const snap = buildRemoteSnapshot(chat, state.runtime[chatId])
  const json = JSON.stringify(snap)
  if (!force && lastPushed.get(chatId) === json) return
  lastPushed.set(chatId, json)
  window.prism.remoteControl.pushState(snap)
}

/** Runs one phone command against the chat's store actions and returns the ack. */
export function handleRemoteCommand(chatId: string, action: string, payload: Record<string, unknown>): RemoteResult {
  const state = useAgentChats.getState()
  return runRemoteCommand(state.chats.find((c) => c.id === chatId), state.runtime[chatId], action, payload || {}, {
    send: (text) => state.send(chatId, text),
    stop: () => state.stop(chatId),
    respondPermission: (decision) => state.respondPermission(chatId, decision),
    respondQuestion: (answers, response) => state.respondQuestion(chatId, answers, response),
    isBusy: () => !!useAgentChats.getState().runtime[chatId]?.busy
  })
}
