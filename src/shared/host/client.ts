import type { ErrorCode } from './generated/ErrorCode'
import type { HelloResult } from './generated/HelloResult'
import type { RpcError } from './generated/RpcError'
import { HOST_PROTOCOL } from './version'

/**
 * The UI's connection to a Prism host: one WebSocket speaking JSON-RPC 2.0,
 * `host.hello` first, reconnecting with backoff. Runs wherever there is a
 * WebSocket (the desktop preload today, the web UI in T11), so it takes the
 * endpoint resolver and the WebSocket constructor as inputs.
 */

export type HostState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'unavailable' | 'incompatible' | 'unauthorized'

export interface HostStatus {
  readonly state: HostState
  readonly hello?: HelloResult
  /** pt-BR, from the host when it refused us. */
  readonly error?: string
  /** Consecutive failed attempts since the last good connection. */
  readonly attempt: number
}

export interface HostEndpoint {
  readonly url: string
  readonly token: string
  /** The app version to announce, when only the resolver knows it. */
  readonly clientVersion?: string
}

export type HostCallErrorCode = ErrorCode | 'disconnected' | 'timeout'

export class HostCallError extends Error {
  readonly code: HostCallErrorCode
  constructor(code: HostCallErrorCode, message: string) {
    super(message)
    this.name = 'HostCallError'
    this.code = code
  }
}

/** The slice of the WebSocket API the client needs (browser or Node). */
export interface WebSocketLike {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: unknown) => void) | null
  onerror: ((ev: unknown) => void) | null
}

export type WebSocketCtor = new (url: string) => WebSocketLike

export interface HostClientOptions {
  /** Where to connect; `null` when no host can run (binary missing, etc.). */
  readonly resolve: () => Promise<HostEndpoint | null>
  readonly client: { readonly kind: 'desktop' | 'web'; readonly version: string }
  readonly WebSocket?: WebSocketCtor
  readonly backoffMs?: readonly number[]
  readonly callTimeoutMs?: number
}

const HELLO_ID = 1
const DEFAULT_BACKOFF = [500, 1000, 2000, 5000, 10000] as const
const OPEN = 1

interface Pending {
  readonly resolve: (value: unknown) => void
  readonly reject: (err: HostCallError) => void
  readonly timer: ReturnType<typeof setTimeout>
}

export class HostClient {
  private ws: WebSocketLike | null = null
  private nextId = HELLO_ID + 1
  private readonly pending = new Map<number, Pending>()
  private readonly waiting = new Set<() => void>()
  private readonly listeners = new Map<string, Set<(params: unknown) => void>>()
  private readonly statusListeners = new Set<(status: HostStatus) => void>()
  private current: HostStatus = { state: 'idle', attempt: 0 }
  private stopped = true
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private endpoint: HostEndpoint | null = null

  constructor(private readonly options: HostClientOptions) {}

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    void this.connect()
  }

  stop(): void {
    this.stopped = true
    clearTimeout(this.retryTimer)
    const ws = this.ws
    this.ws = null
    ws?.close(1000, 'cliente encerrando')
    this.failPending('disconnected', 'Conexão com o host encerrada.')
    this.setStatus({ state: 'idle', attempt: 0 })
  }

  status(): HostStatus {
    return this.current
  }

  /** Called right away with the current status, then on every change. */
  onStatus(listener: (status: HostStatus) => void): () => void {
    this.statusListeners.add(listener)
    listener(this.current)
    return () => { this.statusListeners.delete(listener) }
  }

  capabilities(): readonly string[] {
    return this.current.state === 'connected' ? this.current.hello?.capabilities ?? [] : []
  }

  /** Whether the connected host serves `<domain>@<major>`. */
  serves(domain: string, major = 1): boolean {
    return this.capabilities().includes(`${domain}@${major}`)
  }

  /**
   * The connected host's HTTP base (for `/files`) and session token. For the
   * byte transport only (the preload on the desktop): the token must never
   * reach the page.
   */
  http(): { readonly base: string; readonly token: string } | null {
    const endpoint = this.current.state === 'connected' ? this.endpoint : null
    if (!endpoint) return null
    return { base: endpoint.url.replace(/^ws(s?):/, 'http$1:').replace(/\/rpc\/?$/, ''), token: endpoint.token }
  }

  /**
   * Calls a host method. While (re)connecting the call waits for the
   * connection, up to its timeout; a dropped connection rejects in-flight
   * calls with `disconnected`.
   */
  async call<T = unknown>(method: string, params?: unknown, timeoutMs = this.options.callTimeoutMs ?? 30000): Promise<T> {
    const deadline = Date.now() + timeoutMs
    if (this.current.state !== 'connected') await this.whenConnected(timeoutMs)
    const ws = this.ws
    if (!ws || ws.readyState !== OPEN) throw new HostCallError('disconnected', 'O host do Prism não está conectado.')
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new HostCallError('timeout', `O host não respondeu a ${method}.`))
      }, Math.max(0, deadline - Date.now()))
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }))
    })
  }

  onNotification(method: string, listener: (params: unknown) => void): () => void {
    let set = this.listeners.get(method)
    if (!set) this.listeners.set(method, (set = new Set()))
    set.add(listener)
    return () => { set!.delete(listener) }
  }

  private whenConnected(timeoutMs: number): Promise<void> {
    if (this.current.state === 'connected') return Promise.resolve()
    if (this.stopped) return Promise.reject(new HostCallError('disconnected', 'O cliente do host está parado.'))
    return new Promise((resolve, reject) => {
      const done = (): void => { clearTimeout(timer); this.waiting.delete(done); resolve() }
      const timer = setTimeout(() => {
        this.waiting.delete(done)
        reject(new HostCallError('disconnected', 'O host do Prism não está conectado.'))
      }, timeoutMs)
      this.waiting.add(done)
    })
  }

  private async connect(): Promise<void> {
    clearTimeout(this.retryTimer)
    this.setStatus({ ...this.current, state: this.current.hello ? 'reconnecting' : 'connecting', error: undefined })
    let endpoint: HostEndpoint | null = null
    try {
      endpoint = await this.options.resolve()
    } catch {
      endpoint = null
    }
    if (this.stopped) return
    if (!endpoint) {
      this.setStatus({ state: 'unavailable', attempt: this.current.attempt + 1, error: 'O host do Prism não está disponível.' })
      this.scheduleRetry()
      return
    }
    const Ctor = this.options.WebSocket ?? (globalThis as unknown as { WebSocket: WebSocketCtor }).WebSocket
    let ws: WebSocketLike
    try {
      ws = new Ctor(endpoint.url)
    } catch {
      this.setStatus({ ...this.current, state: 'reconnecting', attempt: this.current.attempt + 1 })
      this.scheduleRetry()
      return
    }
    this.ws = ws
    this.endpoint = endpoint
    const token = endpoint.token
    const client = { kind: this.options.client.kind, version: endpoint.clientVersion ?? this.options.client.version }
    ws.onopen = () => {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: HELLO_ID, method: 'host.hello', params: {
        protocol: { major: HOST_PROTOCOL.major, minor: HOST_PROTOCOL.minor }, client, token } }))
    }
    ws.onmessage = (event) => this.handle(ws, String(event.data))
    ws.onerror = () => {}
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ws = null
      this.failPending('disconnected', 'A conexão com o host caiu.')
      if (this.stopped || this.current.state === 'incompatible') return
      const refused = this.current.state === 'unauthorized'
      this.setStatus({ ...this.current, state: refused ? 'unauthorized' : 'reconnecting', attempt: this.current.attempt + 1 })
      this.scheduleRetry()
    }
  }

  private handle(ws: WebSocketLike, text: string): void {
    let message: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: RpcError }
    try {
      message = JSON.parse(text)
    } catch {
      return
    }
    if (typeof message.method === 'string' && message.id === undefined) {
      for (const listener of this.listeners.get(message.method) ?? []) listener(message.params)
      return
    }
    if (message.id === HELLO_ID) {
      if (message.error) {
        const code = message.error.data?.code
        // An incompatible host stays refused until one side updates; a bad
        // token is retried, since a restarted host writes a new one.
        this.setStatus({ state: code === 'version_mismatch' ? 'incompatible' : 'unauthorized', attempt: this.current.attempt, error: message.error.message })
        ws.close(1000)
        return
      }
      this.setStatus({ state: 'connected', hello: message.result as HelloResult, attempt: 0 })
      for (const wake of [...this.waiting]) wake()
      return
    }
    if (typeof message.id !== 'number') return
    const call = this.pending.get(message.id)
    if (!call) return
    this.pending.delete(message.id)
    clearTimeout(call.timer)
    if (message.error) call.reject(new HostCallError(message.error.data?.code ?? 'internal', message.error.message))
    else call.resolve(message.result)
  }

  private scheduleRetry(): void {
    if (this.stopped) return
    const backoff = this.options.backoffMs ?? DEFAULT_BACKOFF
    const delay = backoff[Math.min(Math.max(this.current.attempt - 1, 0), backoff.length - 1)]
    clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => { void this.connect() }, delay)
  }

  private failPending(code: HostCallErrorCode, message: string): void {
    for (const [id, call] of this.pending) {
      clearTimeout(call.timer)
      call.reject(new HostCallError(code, message))
      this.pending.delete(id)
    }
  }

  private setStatus(status: HostStatus): void {
    this.current = status
    for (const listener of [...this.statusListeners]) listener(status)
  }
}
