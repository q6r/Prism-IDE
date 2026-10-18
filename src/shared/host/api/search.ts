import type { HostClient } from '../client'
import type { DefinitionMatch } from '../generated/DefinitionMatch'
import type { FindDefResult } from '../generated/FindDefResult'
import type { SearchDone } from '../generated/SearchDone'
import type { SearchFileResult } from '../generated/SearchFileResult'
import { LONG_CALL_MS, readWithFallback } from './call'

type Unsub = () => void

export interface SearchRunPayload {
  id: number
  root: string
  query: string
  caseSensitive: boolean
  remoteId?: string
}

/** `window.prism.search`. */
export interface SearchApi {
  run(payload: SearchRunPayload): void
  cancel(): void
  onResult(cb: (data: SearchFileResult) => void): Unsub
  onDone(cb: (data: SearchDone) => void): Unsub
}

/** `window.prism.nav`. */
export interface NavApi {
  findDef(payload: { root: string; word: string; remoteId?: string; fromPath?: string }): Promise<{ matches: DefinitionMatch[] }>
}

/**
 * Search on the host: `search.run` answers at once and the matches stream as
 * `search.result`/`search.done` notifications with the panel's id. The
 * panel subscribes once, so `onResult`/`onDone` listen to both sides (a run
 * goes to one side only). A search cut by a dropped connection still ends:
 * it gets a `done` with what had arrived, marked truncated.
 */
export function createHostSearch(deps: { client: HostClient; ipc: SearchApi }): SearchApi {
  const { client, ipc } = deps
  const inflight = new Map<number, { files: number; matches: number }>()
  const doneListeners = new Set<(data: SearchDone) => void>()

  client.onNotification('search.result', (params) => {
    const result = params as SearchFileResult
    const seen = inflight.get(result.id)
    if (seen) {
      seen.files++
      seen.matches += result.matches.length
    }
  })
  client.onNotification('search.done', (params) => { inflight.delete((params as SearchDone).id) })
  client.onStatus((status) => {
    if (status.state === 'connected') return
    for (const [id, seen] of [...inflight]) {
      inflight.delete(id)
      for (const listener of [...doneListeners]) listener({ id, ...seen, truncated: true })
    }
  })

  return {
    run: (payload) => {
      if (payload.remoteId) return ipc.run(payload)
      const { id, root, query, caseSensitive } = payload
      inflight.set(id, { files: 0, matches: 0 })
      client.call('search.run', { id, root, query, caseSensitive }).catch(() => {
        inflight.delete(id)
        ipc.run(payload)
      })
    },
    cancel: () => {
      ipc.cancel()
      inflight.clear()
      if (client.status().state === 'connected') client.call('search.cancel', {}).catch(() => {})
    },
    onResult: (cb) => {
      const offHost = client.onNotification('search.result', (params) => cb(params as SearchFileResult))
      const offIpc = ipc.onResult(cb)
      return () => { offHost(); offIpc() }
    },
    onDone: (cb) => {
      doneListeners.add(cb)
      const offHost = client.onNotification('search.done', (params) => cb(params as SearchDone))
      const offIpc = ipc.onDone(cb)
      return () => { doneListeners.delete(cb); offHost(); offIpc() }
    }
  }
}

export function createHostNav(deps: { client: HostClient; ipc: NavApi }): NavApi {
  const { client, ipc } = deps
  return {
    findDef: async (payload) => {
      if (payload.remoteId) return ipc.findDef(payload)
      const { root, word, fromPath } = payload
      return readWithFallback(async () => {
        const { matches } = await client.call<FindDefResult>('search.findDef', { root, word, fromPath }, LONG_CALL_MS)
        // The IPC side's ordering, comparator included: the current file first.
        matches.sort((a, b) => (a.path === fromPath ? -1 : b.path === fromPath ? 1 : 0))
        return { matches }
      }, () => ipc.findDef(payload))
    }
  }
}
