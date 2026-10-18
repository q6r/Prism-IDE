import type { HostClient } from '../client'
import type { SessionMeta } from '../generated/SessionMeta'
import type { TranscriptTurn } from '../generated/TranscriptTurn'
import { LONG_CALL_MS, readWithFallback } from './call'

/** `window.prism.sessions`: the host's Claude transcripts; `remoteId` (SSH) stays on IPC. */
export interface SessionsApi {
  list(filterCwd?: string, remoteId?: string): Promise<SessionMeta[]>
  read(file: string, remoteId?: string): Promise<TranscriptTurn[]>
  delete(file: string, remoteId?: string): Promise<boolean>
}

export function createHostSessions(deps: { client: HostClient; ipc: SessionsApi }): SessionsApi {
  const { client, ipc } = deps
  return {
    list: (filterCwd, remoteId) => remoteId
      ? ipc.list(filterCwd, remoteId)
      : readWithFallback(() => client.call<SessionMeta[]>('sessions.list', { filterCwd }, LONG_CALL_MS), () => ipc.list(filterCwd, remoteId)),
    read: (file, remoteId) => remoteId
      ? ipc.read(file, remoteId)
      : readWithFallback(() => client.call<TranscriptTurn[]>('sessions.read', { file }, LONG_CALL_MS), () => ipc.read(file, remoteId)),
    delete: (file, remoteId) => remoteId ? ipc.delete(file, remoteId) : client.call<boolean>('sessions.delete', { file })
  }
}
