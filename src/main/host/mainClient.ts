import { app } from 'electron'
import { HostClient, type WebSocketCtor } from '../../shared/host/client'
import { ensureHost } from './supervisor'

/**
 * The main process's own connection to the Prism host, for what still lives
 * here and reads or writes the chats and tasks the host owns (T07): the task
 * IPC, the account checks, the Traycer import and the Usage panel. Created on
 * first use; it speaks through Node's global WebSocket (Electron 42, Node 24).
 */

let client: HostClient | null = null

export function mainHostClient(): HostClient {
  if (client) return client
  const WebSocket = (globalThis as unknown as { WebSocket?: WebSocketCtor }).WebSocket
  if (!WebSocket) console.warn('[host] este Electron não tem WebSocket no processo principal; o main não fala com o host.')
  client = new HostClient({
    client: { kind: 'desktop', version: app.getVersion() },
    resolve: async () => {
      if (!WebSocket) return null
      const connection = await ensureHost()
      return connection && { url: `ws://127.0.0.1:${connection.port}/rpc`, token: connection.token }
    },
    WebSocket
  })
  client.start()
  // After `will-quit`: the writes the windows fired while closing are drained first (index.ts).
  app.once('quit', () => client?.stop())
  return client
}
