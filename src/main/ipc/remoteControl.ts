import { ipcMain, app, BrowserWindow, WebContents } from 'electron'
import { createServer, Server, IncomingMessage } from 'http'
import { randomBytes } from 'crypto'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { WebSocketServer, WebSocket } from 'ws'
import { Tunnel, use as useCloudflared, install as installCloudflared, bin as cfBin } from 'cloudflared'
import { mobilePage } from './remoteControlPage'
import { ChatGrants, listEntry, sameEntry, snapshotDelta, type ChatListEntry, type TurnCache } from './remoteControlState'

// ---------------------------------------------------------------------------
// Remote control: a local HTTP + WebSocket server, exposed to the internet via
// a Cloudflare quick tunnel, that lets the user drive a Prism chat from their
// phone — accept/deny permissions, answer questions, send messages, or stop the
// agent. One server/tunnel is shared, but every shared chat has its OWN token:
// a link opens a socket scoped to that one chat, which can neither read nor
// command any other. Stopping a chat revokes its token (and drops its phones);
// when no chat is shared the tunnel and server shut down, so every new share
// mints a fresh link. A reload, navigation or crash of the renderer stops it all.
// ---------------------------------------------------------------------------

interface ChatSnapshot {
  tabId: string
  title: string
  streaming: boolean
  contextPct: number
  // Trimmed turns the phone renders (built in the renderer to keep payload small).
  turns: { id: string; pendingPerm?: unknown; pendingQuestion?: unknown }[]
  updatedAt: number
}

interface RemoteState {
  server: Server | null
  wss: WebSocketServer | null
  tunnel: Tunnel | null
  port: number
  baseUrl: string | null
  starting: Promise<{ ok: boolean; baseUrl?: string; error?: string }> | null
  grants: ChatGrants
  titles: Map<string, string>
  // Latest snapshot per chat (what a newly connected phone gets), its per-turn
  // serialization (for deltas) and the list entry last sent.
  chats: Map<string, ChatSnapshot>
  caches: Map<string, TurnCache>
  entries: Map<string, ChatListEntry>
  // Each socket is scoped to the chat its token was minted for.
  clients: Map<WebSocket, string>
  wc: WebContents | null
}

const state: RemoteState = {
  server: null,
  wss: null,
  tunnel: null,
  port: 0,
  baseUrl: null,
  starting: null,
  grants: new ChatGrants(),
  titles: new Map(),
  chats: new Map(),
  caches: new Map(),
  entries: new Map(),
  clients: new Map(),
  wc: null
}

const enc = (o: unknown): string => JSON.stringify(o)
const mintToken = (): string => randomBytes(24).toString('hex')

function send(ws: WebSocket, obj: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return
  try {
    ws.send(enc(obj))
  } catch {
    /* a dead socket — the close handler cleans it up */
  }
}

/** Sends to the phones holding this chat's link, and to no one else. */
function sendToChat(tabId: string, obj: unknown): void {
  const msg = enc(obj)
  for (const [ws, scope] of state.clients) {
    if (scope !== tabId || ws.readyState !== WebSocket.OPEN) continue
    try {
      ws.send(msg)
    } catch {
      /* ignore */
    }
  }
}

// Send an event to the renderer. We hit every live window (not just the one that
// started the server) so a reload / multi-window setup can't strand commands.
function dispatchToRenderer(channel: string, payload: unknown): void {
  const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
  if (wins.length) {
    for (const w of wins) w.webContents.send(channel, payload)
  } else if (state.wc && !state.wc.isDestroyed()) {
    state.wc.send(channel, payload)
  }
}

function entryFor(tabId: string): ChatListEntry {
  const snap = state.chats.get(tabId)
  return snap ? listEntry(snap) : { tabId, title: state.titles.get(tabId) || 'Chat', streaming: false, pending: false }
}

function sendInitial(ws: WebSocket, tabId: string): void {
  send(ws, { t: 'chats', chats: [entryFor(tabId)] })
  const snap = state.chats.get(tabId)
  if (snap) send(ws, { t: 'state', chat: snap })
}

// Where we keep the cloudflared binary: userData is writable both in dev and in
// the packaged app (node_modules is read-only inside the asar).
function cloudflaredPath(): string {
  const dir = join(app.getPath('userData'), 'cloudflared')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared')
}

async function ensureCloudflared(): Promise<void> {
  const target = cloudflaredPath()
  useCloudflared(target) // make Tunnel.quick() spawn *our* binary path
  if (!existsSync(target)) {
    // Fall back to a bundled/cached copy if one already exists at the package default.
    if (cfBin && existsSync(cfBin) && cfBin !== target) {
      useCloudflared(cfBin)
      return
    }
    await installCloudflared(target)
    useCloudflared(target)
  }
}

function getLocalToken(req: IncomingMessage): string | null {
  try {
    const url = new URL(req.url || '/', 'http://localhost')
    return url.searchParams.get('t')
  } catch {
    return null
  }
}

async function startTunnel(localPort: number): Promise<string> {
  await ensureCloudflared()
  const t = Tunnel.quick(`http://localhost:${localPort}`)
  state.tunnel = t
  const url = await new Promise<string>((resolve, reject) => {
    const to = setTimeout(() => {
      reject(new Error('Tempo esgotado ao abrir o túnel (cloudflared não respondeu).'))
    }, 45000)
    t.once('url', (found: string) => {
      clearTimeout(to)
      resolve(found.replace(/\/$/, ''))
    })
    t.once('error', (err: Error) => {
      clearTimeout(to)
      reject(err)
    })
    t.once('exit', (code) => {
      clearTimeout(to)
      reject(new Error(`cloudflared encerrou (código ${code}).`))
    })
  })
  // The tunnel dying later leaves phones with nothing to reach: shut down
  // cleanly so the desktop stops claiming the chats are shared.
  t.on('exit', () => {
    if (state.tunnel === t) void stopServer('tunnel')
  })
  return url
}

function onConnection(ws: WebSocket, scope: string): void {
  state.clients.set(ws, scope)
  sendInitial(ws, scope)
  dispatchToRenderer('rc:clients', { count: state.clients.size })

  ws.on('message', (raw) => {
    let msg: { t?: string; tabId?: string; action?: string; payload?: unknown }
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (msg.t === 'cmd' && msg.tabId && msg.action) {
      // The link only speaks for its own chat, and that chat must still be shared.
      const reason = msg.tabId !== scope ? 'forbidden' : state.grants.has(scope) ? '' : 'no-chat'
      send(ws, { t: 'ack', stage: 'pc', action: msg.action, ok: !reason, reason })
      if (reason) return
      // Forward to the renderer, where RemoteControlBridge runs it against the
      // shared agent chat. Hit every window for robustness.
      dispatchToRenderer('rc:command', { tabId: scope, action: msg.action, payload: msg.payload ?? {} })
    } else if (msg.t === 'ping') {
      send(ws, { t: 'pong' })
    }
  })

  ws.on('close', () => {
    state.clients.delete(ws)
    dispatchToRenderer('rc:clients', { count: state.clients.size })
  })
  ws.on('error', () => {
    state.clients.delete(ws)
  })
}

async function startServer(wc: WebContents): Promise<{ ok: boolean; baseUrl?: string; error?: string }> {
  state.wc = wc
  if (state.baseUrl) return { ok: true, baseUrl: state.baseUrl }
  if (state.starting) return state.starting

  state.starting = (async () => {
    try {
      const server = createServer((req, res) => {
        const url = (req.url || '/').split('?')[0]
        if (url === '/' || url === '/index.html') {
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store'
          })
          res.end(mobilePage())
          return
        }
        if (url === '/health') {
          res.writeHead(200, { 'Content-Type': 'text/plain' })
          res.end('ok')
          return
        }
        res.writeHead(404)
        res.end()
      })

      const wss = new WebSocketServer({ noServer: true })

      server.on('upgrade', (req, socket, head) => {
        const scope = state.grants.chatFor(getLocalToken(req))
        if (!scope) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
          socket.destroy()
          return
        }
        wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, scope))
      })

      const port = await new Promise<number>((resolve, reject) => {
        server.on('error', reject)
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address()
          if (!addr || typeof addr === 'string') return reject(new Error('sem endereço'))
          resolve(addr.port)
        })
      })

      state.server = server
      state.wss = wss
      state.port = port

      const baseUrl = await startTunnel(port)
      state.baseUrl = baseUrl
      return { ok: true, baseUrl }
    } catch (err) {
      await stopServer('error')
      return { ok: false, error: (err as Error).message }
    } finally {
      state.starting = null
    }
  })()

  return state.starting
}

type StopReason = 'user' | 'empty' | 'renderer' | 'tunnel' | 'error' | 'quit'

async function stopServer(reason: StopReason = 'user'): Promise<void> {
  const wasRunning = !!state.baseUrl || state.grants.size > 0
  for (const ws of state.clients.keys()) {
    send(ws, { t: 'stopped' })
    try {
      ws.close()
    } catch {
      /* ignore */
    }
  }
  state.clients.clear()
  const tunnel = state.tunnel
  state.tunnel = null
  try {
    tunnel?.stop()
  } catch {
    /* ignore */
  }
  try {
    state.wss?.close()
  } catch {
    /* ignore */
  }
  try {
    state.server?.close()
  } catch {
    /* ignore */
  }
  state.wss = null
  state.server = null
  state.baseUrl = null
  state.port = 0
  // Every token dies with the server: the next share mints a new link.
  state.grants.clear()
  state.titles.clear()
  state.chats.clear()
  state.caches.clear()
  state.entries.clear()
  if (wasRunning && reason !== 'quit') dispatchToRenderer('rc:stopped', { reason })
}

/** Stops sharing one chat: its token stops working and its phones are dropped. */
function revoke(tabId: string): void {
  state.grants.revoke(tabId)
  for (const [ws, scope] of [...state.clients]) {
    if (scope !== tabId) continue
    send(ws, { t: 'revoked', tabId })
    try {
      ws.close()
    } catch {
      /* ignore */
    }
    state.clients.delete(ws)
  }
  state.titles.delete(tabId)
  state.chats.delete(tabId)
  state.caches.delete(tabId)
  state.entries.delete(tabId)
  dispatchToRenderer('rc:clients', { count: state.clients.size })
  // Nothing left to share: take the tunnel down instead of leaving it open.
  if (state.grants.size === 0) void stopServer('empty')
}

// The renderer owns which chats are shared; if it reloads, navigates away or
// dies, that knowledge is gone — and so is the sharing.
const watched = new WeakSet<WebContents>()
function watchRenderer(wc: WebContents): void {
  if (watched.has(wc)) return
  watched.add(wc)
  const stop = (): void => {
    if (state.wc === wc && (state.baseUrl || state.starting || state.grants.size)) void stopServer('renderer')
  }
  wc.on('did-navigate', stop)
  wc.on('render-process-gone', stop)
  wc.once('destroyed', stop)
}

export function registerRemoteControlHandlers(): void {
  // Start (idempotent) and share a chat. Returns that chat's own deep-link.
  ipcMain.handle(
    'rc:enable',
    async (e, payload: { tabId: string; title: string }): Promise<{
      ok: boolean
      url?: string
      baseUrl?: string
      token?: string
      error?: string
    }> => {
      if (!payload?.tabId) return { ok: false, error: 'chat inválido' }
      watchRenderer(e.sender)
      const res = await startServer(e.sender)
      if (!res.ok || !res.baseUrl) return { ok: false, error: res.error }
      const token = state.grants.grant(payload.tabId, mintToken)
      state.titles.set(payload.tabId, payload.title || 'Chat')
      const url = `${res.baseUrl}/#t=${token}&c=${encodeURIComponent(payload.tabId)}`
      return { ok: true, url, baseUrl: res.baseUrl, token }
    }
  )

  // The latest snapshot of a shared chat: send its phones only what changed.
  ipcMain.on('rc:state', (_e, snap: ChatSnapshot) => {
    if (!snap || !snap.tabId || !state.grants.has(snap.tabId)) return
    const prev = state.chats.get(snap.tabId)
    const delta = snapshotDelta(prev, state.caches.get(snap.tabId), snap)
    state.caches.set(snap.tabId, delta.cache)
    snap.updatedAt = Date.now()
    state.chats.set(snap.tabId, snap)
    if (!delta.changed) return
    if (!prev) sendToChat(snap.tabId, { t: 'state', chat: snap })
    else {
      sendToChat(snap.tabId, {
        t: 'delta',
        tabId: snap.tabId,
        title: snap.title,
        streaming: snap.streaming,
        contextPct: snap.contextPct,
        selection: (snap as any).selection,
        queued: (snap as any).queued,
        queuePaused: (snap as any).queuePaused,
        ids: delta.ids,
        turns: delta.turns
      })
    }
    // The list reflects title/streaming/pending: refresh it only when those move.
    const entry = listEntry(snap)
    if (!sameEntry(state.entries.get(snap.tabId), entry)) {
      state.entries.set(snap.tabId, entry)
      sendToChat(snap.tabId, { t: 'chats', chats: [entry] })
    }
  })

  // The renderer finished (or refused) a phone command — relay the result so the
  // phone can confirm/explain. Helps the user see that control is actually wired.
  ipcMain.on('rc:ack', (_e, p: { tabId: string; action: string; ok: boolean; reason?: string }) => {
    if (!p?.tabId) return
    sendToChat(p.tabId, { t: 'ack', stage: 'done', action: p.action, ok: p.ok, reason: p.reason || '' })
  })

  // A chat stopped sharing (menu, modal, deleted chat): revoke its link.
  ipcMain.on('rc:remove', (_e, payload: { tabId: string }) => {
    if (payload?.tabId && state.grants.has(payload.tabId)) revoke(payload.tabId)
  })

  ipcMain.handle('rc:status', () => ({
    running: !!state.baseUrl,
    baseUrl: state.baseUrl,
    clients: state.clients.size,
    chats: [...state.titles.keys()].filter((id) => state.grants.has(id)).map(entryFor)
  }))

  ipcMain.handle('rc:stop', async () => {
    await stopServer('user')
    return { ok: true }
  })
}

app.on('before-quit', () => {
  void stopServer('quit')
})
