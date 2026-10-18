import type { RemoteStatus } from '../generated/RemoteStatus'
import type { RemoteStopReason } from '../generated/RemoteStopReason'
import type { ShareResult } from '../generated/ShareResult'

/**
 * `window.prism.remoteControl` on the host (T09): the host serves the phone's
 * page, builds the snapshots of the shared chats and runs the phone's
 * commands, so sharing outlives the window. Same signatures and answers as
 * the IPC side, so the renderer barely changes.
 *
 * `enable` answers `{ ok: false, error }` with the host's pt-BR message, as
 * IPC does. `remove` returns nothing and drops a refusal. `pushState` and
 * `ack` do nothing here (the host builds the snapshots and answers the
 * phone); `onCommand` is left to IPC, where nothing arrives while the host
 * shares (a subscription must not wait at the first-hello gate).
 *
 * `onClients`, `onStopped` and `onChanged` hear `remote.changed` and IPC.
 */

type Unsub = () => void

/** The slice of `HostClient` this needs. */
export interface RemoteHostClient {
  call<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>
  onNotification(method: string, listener: (params: unknown) => void): () => void
}

/** Why sharing stopped; `renderer` comes only from IPC (the window that owned it went away). */
export type RemoteControlStopReason = RemoteStopReason | 'renderer'

/** A shared chat. On the host it also carries its link and token, so a window can restore it. */
export interface RemoteControlChat {
  tabId: string
  title: string
  streaming: boolean
  pending: boolean
  token?: string
  url?: string
}

export interface RemoteControlStatus {
  running: boolean
  baseUrl: string | null
  /** Phones connected, all chats together. */
  clients: number
  chats: RemoteControlChat[]
  /** On the change that says it stopped: why. */
  reason?: RemoteControlStopReason
}

export type RemoteControlEnableResult = { ok: boolean; url?: string; baseUrl?: string; token?: string; error?: string }
export type RemoteControlAck = { tabId: string; action: string; ok: boolean; reason?: string }

/** The IPC members the host side wraps (the `remoteControl` block of src/preload/index.ts). */
export interface RemoteControlIpc {
  onClients(cb: (d: { count: number }) => void): Unsub
  onStopped(cb: (d: { reason: RemoteControlStopReason }) => void): Unsub
  onChanged(cb: (status: RemoteControlStatus) => void): Unsub
}

/** The members served by the host. */
export interface HostRemoteControlApi {
  enable(p: { tabId: string; title: string }): Promise<RemoteControlEnableResult>
  pushState(snap: unknown): void
  remove(tabId: string): void
  ack(p: RemoteControlAck): void
  status(): Promise<RemoteControlStatus>
  stop(): Promise<{ ok: boolean }>
  onClients(cb: (d: { count: number }) => void): Unsub
  onStopped(cb: (d: { reason: RemoteControlStopReason }) => void): Unsub
  onChanged(cb: (status: RemoteControlStatus) => void): Unsub
}

/** The first share may download `cloudflared` (the host allows it 10 min) and wait for the tunnel's URL. */
export const SHARE_MS = 12 * 60_000
/** Closing the last link also closes the tunnel. */
const STOP_MS = 30_000

/** The host's status in the shape the renderer already knows (`clients`, `tabId`), plus each chat's link. */
export function toRemoteControlStatus(status: RemoteStatus): RemoteControlStatus {
  return {
    running: status.running,
    baseUrl: status.baseUrl ?? null,
    clients: status.phones,
    chats: status.chats.map((c) => ({ tabId: c.chatId, title: c.title, streaming: c.streaming, pending: c.pending, token: c.token, url: c.url })),
    ...(status.reason ? { reason: status.reason } : {})
  }
}

const isStatus = (params: unknown): params is RemoteStatus => {
  const s = params as RemoteStatus | null
  return !!s && typeof s.running === 'boolean' && typeof s.phones === 'number' && Array.isArray(s.chats)
}

export function createHostRemote<T extends RemoteControlIpc>(client: RemoteHostClient, ipc: T): HostRemoteControlApi {
  const changed = (cb: (status: RemoteStatus) => void): Unsub =>
    client.onNotification('remote.changed', (params) => { if (isStatus(params)) cb(params) })
  // `onChanged` listeners, so a failed unshare can put the host's truth back on screen.
  const listeners = new Set<(status: RemoteControlStatus) => void>()

  return {
    enable: async ({ tabId }) => {
      try {
        const { url, baseUrl, token } = await client.call<ShareResult>('remote.share', { chatId: tabId }, SHARE_MS)
        return { ok: true, url, baseUrl, token }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
    pushState: () => undefined,
    remove: (tabId) => {
      void client.call('remote.unshare', { chatId: tabId }, STOP_MS).catch(async () => {
        // The window already shows it unshared while its link may still work: show what the host has.
        try {
          const status = toRemoteControlStatus(await client.call<RemoteStatus>('remote.status', {}))
          for (const cb of listeners) cb(status)
        } catch { /* the host is unreachable: its reconnection reads the status again */ }
      })
    },
    ack: () => undefined,
    status: async () => toRemoteControlStatus(await client.call<RemoteStatus>('remote.status', {})),
    stop: async () => {
      await client.call('remote.stop', {}, STOP_MS)
      return { ok: true }
    },
    onClients: (cb) => {
      const offHost = changed((status) => cb({ count: status.phones }))
      const offIpc = ipc.onClients(cb)
      return () => { offHost(); offIpc() }
    },
    onStopped: (cb) => {
      const offHost = changed((status) => { if (!status.running && status.reason) cb({ reason: status.reason }) })
      const offIpc = ipc.onStopped(cb)
      return () => { offHost(); offIpc() }
    },
    onChanged: (cb) => {
      listeners.add(cb)
      const offHost = changed((status) => cb(toRemoteControlStatus(status)))
      const offIpc = ipc.onChanged(cb)
      return () => { listeners.delete(cb); offHost(); offIpc() }
    }
  }
}
