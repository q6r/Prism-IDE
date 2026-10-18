import type { HostStatus } from '../client'
import type { Route } from '../routing'
import type { TerminalAttached } from '../generated/TerminalAttached'
import type { TerminalCreated } from '../generated/TerminalCreated'
import type { TerminalData } from '../generated/TerminalData'
import type { TerminalExit } from '../generated/TerminalExit'
import type { TerminalInfo } from '../generated/TerminalInfo'

/**
 * `window.prism.terminal` on the host (T04): the shells live in the host and
 * outlive the window. Output carries `seq` (byte offset); this side keeps the
 * last one per terminal, so when the connection comes back it re-attaches
 * with `since` and the panes get exactly what they missed, through the same
 * `onData` stream. The host replays the same way to a reopened window.
 */

export type { TerminalInfo }

type Unsub = () => void

export interface TerminalCreateOptions { id: string; cols?: number; rows?: number; cwd?: string }
/** `persistent`: the host runs it (it survives the window); otherwise the old IPC does. */
export type TerminalStart = { ok: true; persistent: boolean } | { ok: false; error: string }
export type TerminalAttach = { ok: true; truncated: boolean } | { ok: false; error: string }
export interface TerminalDataEvent { id: string; data: string }
/** `lost`: the host no longer has it (it restarted); the pane keeps what it showed. */
export interface TerminalExitEvent { id: string; code?: number | null; lost?: boolean }

/** `window.prism.terminal`, on either side. */
export interface TerminalApi {
  init(cwd?: string): Promise<string>
  setCwd(cwd: string): Promise<string>
  create(opts: TerminalCreateOptions): Promise<TerminalStart>
  input(p: { id: string; data: string }): void
  resize(p: { id: string; cols: number; rows: number }): void
  kill(id: string): void
  onData(cb: (d: TerminalDataEvent) => void): Unsub
  onExit(cb: (d: TerminalExitEvent) => void): Unsub
  /** Terminals running in the host (none without one). */
  list(): Promise<TerminalInfo[]>
  /** Shows a running host terminal here: what it kept arrives through `onData`, then live output. */
  attach(id: string): Promise<TerminalAttach>
}

/** The slice of `HostClient` this needs. */
export interface TerminalHostClient {
  call<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>
  onNotification(method: string, listener: (params: unknown) => void): () => void
  onStatus(listener: (status: HostStatus) => void): () => void
}

interface Tracked {
  /** Offset just past the output delivered so far. */
  seq: number
  /** The host confirmed it (created or attached), so a reconnect re-attaches it. */
  confirmed: boolean
  /** Output that arrived while an attach was in flight, applied after its replay. */
  held: TerminalData[] | null
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const errorCode = (err: unknown): string | undefined => (err as { code?: string } | null)?.code

export function createHostTerminal(client: TerminalHostClient): TerminalApi {
  const tracked = new Map<string, Tracked>()
  const dataListeners = new Set<(d: TerminalDataEvent) => void>()
  const exitListeners = new Set<(d: TerminalExitEvent) => void>()
  const emitData = (d: TerminalDataEvent): void => { for (const cb of [...dataListeners]) cb(d) }
  const emitExit = (d: TerminalExitEvent): void => { for (const cb of [...exitListeners]) cb(d) }

  const deliver = (t: Tracked, note: TerminalData): void => {
    if (note.seq <= t.seq) return
    t.seq = note.seq
    emitData({ id: note.id, data: note.data })
  }

  client.onNotification('terminal.data', (params) => {
    const note = params as TerminalData
    const t = tracked.get(note.id)
    if (!t) return
    if (t.held) t.held.push(note)
    else deliver(t, note)
  })
  client.onNotification('terminal.exit', (params) => {
    const exit = params as TerminalExit
    if (!tracked.delete(exit.id)) return
    emitExit({ id: exit.id, code: exit.code })
  })

  /** Replays from `t.seq`, then lets live output through: nothing missed, nothing twice. */
  async function attachTracked(id: string, t: Tracked): Promise<TerminalAttach> {
    t.held = []
    try {
      const result = await client.call<TerminalAttached>('terminal.attach', { id, since: t.seq })
      if (tracked.get(id) !== t) return { ok: false, error: 'O terminal foi encerrado.' }
      const held = t.held
      t.held = null
      if (result.data) emitData({ id, data: result.data })
      t.seq = Math.max(t.seq, result.seq)
      t.confirmed = true
      for (const note of held) deliver(t, note)
      return { ok: true, truncated: result.truncated }
    } catch (err) {
      t.held = null
      if (errorCode(err) === 'not_found' && tracked.get(id) === t) {
        tracked.delete(id)
        if (t.confirmed) emitExit({ id, lost: true })
      }
      return { ok: false, error: message(err) }
    }
  }

  // A dropped connection loses the subscriptions; the shells keep running.
  let connected = false
  client.onStatus((status) => {
    const now = status.state === 'connected'
    if (now && !connected) {
      for (const [id, t] of tracked) if (t.confirmed && !t.held) void attachTracked(id, t)
    }
    connected = now
  })

  const quiet = (promise: Promise<unknown>): void => { promise.catch(() => {}) }

  return {
    init: (cwd) => client.call<string>('terminal.init', cwd === undefined ? {} : { cwd }),
    setCwd: (cwd) => client.call<string>('terminal.setCwd', { cwd }),
    async create(opts) {
      const t: Tracked = { seq: 0, confirmed: false, held: null }
      tracked.set(opts.id, t)
      try {
        const created = await client.call<TerminalCreated>('terminal.create', opts)
        if (tracked.get(opts.id) !== t) return { ok: false, error: 'O terminal foi encerrado.' }
        // A remount of the same attempt keeps receiving from where the host is.
        if (!created.created) t.seq = Math.max(t.seq, created.seq)
        t.confirmed = true
        return { ok: true, persistent: true }
      } catch (err) {
        if (tracked.get(opts.id) === t) tracked.delete(opts.id)
        return { ok: false, error: message(err) }
      }
    },
    input: (p) => quiet(client.call('terminal.input', p)),
    resize: (p) => quiet(client.call('terminal.resize', p)),
    kill(id) {
      // Forget it first: whatever it still sends is stale.
      tracked.delete(id)
      quiet(client.call('terminal.kill', { id }))
    },
    onData(cb) {
      dataListeners.add(cb)
      return () => { dataListeners.delete(cb) }
    },
    onExit(cb) {
      exitListeners.add(cb)
      return () => { exitListeners.delete(cb) }
    },
    list: () => client.call<TerminalInfo[]>('terminal.list'),
    attach(id) {
      let t = tracked.get(id)
      if (!t) tracked.set(id, (t = { seq: 0, confirmed: false, held: null }))
      return attachTracked(id, t)
    }
  }
}

/**
 * Resolves once the host connection has an outcome (connected or not), or
 * after `timeoutMs`. A terminal created in the first moments of the window
 * waits for it, instead of landing on the IPC side for good.
 */
export function hostSettled(client: Pick<TerminalHostClient, 'onStatus'>, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve) => {
    let done = false
    let off: Unsub | undefined
    const finish = (): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      off?.()
      resolve()
    }
    const timer = setTimeout(finish, timeoutMs)
    off = client.onStatus((status) => {
      if (status.state !== 'connecting' && status.state !== 'reconnecting') finish()
    })
    if (done) off()
  })
}

/**
 * The terminal façade over both sides. Unlike `routed()`, a terminal stays
 * on the side that created it: its input, resizes and kill never follow a
 * route that changed meanwhile (a host that connects or drops later). Ops on
 * an id whose side is still being decided wait for it, in order.
 */
export function routedTerminal(ipc: TerminalApi, host: TerminalApi, route: () => Route, settle: () => Promise<void>): TerminalApi {
  const sides = new Map<string, Route>()
  const deciding = new Map<string, Promise<void>>()
  const pick = (side: Route): TerminalApi => (side === 'host' ? host : ipc)
  const sideOf = (id: string): TerminalApi => pick(sides.get(id) ?? route())
  const onId = (id: string, op: () => void): void => {
    const gate = deciding.get(id)
    if (gate) void gate.then(op)
    else op()
  }
  const both = (a: Unsub, b: Unsub): Unsub => () => { a(); b() }

  return {
    init: (cwd) => pick(route()).init(cwd),
    setCwd: (cwd) => pick(route()).setCwd(cwd),
    create(opts) {
      const decided = settle().then(() => {
        const side = route()
        sides.set(opts.id, side)
        return side
      })
      // Registered first, so the create goes out before anything queued behind the gate.
      const started = decided.then((side) => pick(side).create(opts))
      const gate = decided.then(() => {})
      deciding.set(opts.id, gate)
      void gate.then(() => { if (deciding.get(opts.id) === gate) deciding.delete(opts.id) })
      return started.catch((err: unknown): TerminalStart => ({ ok: false, error: message(err) }))
    },
    input: (p) => onId(p.id, () => sideOf(p.id).input(p)),
    resize: (p) => onId(p.id, () => sideOf(p.id).resize(p)),
    kill: (id) => onId(id, () => {
      sideOf(id).kill(id)
      sides.delete(id)
    }),
    onData: (cb) => both(ipc.onData(cb), host.onData(cb)),
    onExit: (cb) => both(ipc.onExit(cb), host.onExit(cb)),
    async list() {
      await settle()
      if (route() !== 'host') return []
      try {
        return await host.list()
      } catch {
        return []
      }
    },
    async attach(id) {
      await settle()
      if (route() !== 'host') return { ok: false, error: 'O host do Prism não está conectado.' }
      sides.set(id, 'host')
      return host.attach(id)
    }
  }
}
