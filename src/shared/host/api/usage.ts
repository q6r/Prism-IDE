import type { UsageRecordsResponse } from '../../usage'
import { LONG_CALL_MS, readWithFallback } from './call'

/**
 * `window.prism.usage.records` on the host (T08): Prism's turns (the chats
 * and their journal) and the Traycer turns the desktop imported. Importing
 * from Traycer, the image and the files stay on IPC (they are the desktop's).
 */
export interface UsageRecordsApi {
  records(): Promise<UsageRecordsResponse>
}

export function createHostUsage(client: { call<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> }, ipc: UsageRecordsApi): UsageRecordsApi {
  // Every turn of every chat: as long as reading every transcript.
  return { records: () => readWithFallback(() => client.call<UsageRecordsResponse>('usage.records', {}, LONG_CALL_MS), () => ipc.records()) }
}
