/**
 * The `window.prism` façade routing: each domain is served either by the old
 * Electron IPC or by the host, decided per call. A domain moves to the host
 * when (1) this build ships its host implementation (listed in
 * HOST_READY_DOMAINS) and (2) the connected host advertises `<domain>@1`.
 * Until then the IPC implementation keeps serving, so each ticket can switch
 * one domain without touching the others or the UI code.
 */

/** Domains whose host implementation is wired in this build (T03 onwards add theirs). */
export const HOST_READY_DOMAINS: readonly string[] = ['terminal', 'fs', 'search', 'git', 'workspace', 'sessions', 'commands', 'claude', 'codex', 'providers', 'usage', 'remote']

/**
 * Domains whose state lives in one store (the accounts, T08; the shared
 * chats, T09): once the host served one in this window, its calls wait for
 * the host while it reconnects instead of reaching the IPC side's older copy
 * (two stores would drift apart).
 */
export const HOST_STICKY_DOMAINS: readonly string[] = ['providers', 'remote']

export type Route = 'host' | 'ipc'

export function routeFor(domain: string, capabilities: readonly string[], ready: readonly string[] = HOST_READY_DOMAINS): Route {
  return ready.includes(domain) && capabilities.includes(`${domain}@1`) ? 'host' : 'ipc'
}

/** `route`, except that a sticky domain the host has served keeps going to the host. */
export function stickyRoute(route: (domain: string) => Route, sticky: readonly string[] = HOST_STICKY_DOMAINS): (domain: string) => Route {
  const held = new Set<string>()
  return (domain) => {
    const side = route(domain)
    if (side === 'host' && sticky.includes(domain)) held.add(domain)
    return held.has(domain) ? 'host' : side
  }
}

export const NO_HOST_ANSWER = 'O host do Prism não respondeu.'

/**
 * For a store the host took over (the accounts, T08; sharing, T09): with a host binary, a
 * call made before this window's first `hello` waits for it (up to `ms`) and
 * only then picks its side, so it never reaches the IPC side's older copy (a
 * host without the domain still sends it to IPC then). Without a binary
 * nothing waits. Rejects with NO_HOST_ANSWER when the host does not answer or
 * refuses this version; the next call waits again.
 *
 * Returns the gate: null when a call may route now, else what it waits for.
 */
export function firstHelloGate(deps: {
  /** Whether this app has a host binary (`host:owns-chats`). */
  owned: () => Promise<boolean>
  onStatus: (listener: (status: { state: string }) => void) => () => void
  ms: number
}): () => Promise<void> | null {
  let seen = false
  let binary: boolean | undefined
  let waiting: Promise<void> | null = null
  deps.onStatus((status) => { if (status.state === 'connected') seen = true })
  const hello = (): Promise<void> => new Promise((resolve, reject) => {
    let settled = false
    let off: (() => void) | undefined
    const settle = (ok: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      off?.()
      if (ok) resolve()
      else reject(new Error(NO_HOST_ANSWER))
    }
    const timer = setTimeout(() => settle(false), deps.ms)
    off = deps.onStatus((status) => {
      if (status.state === 'connected') settle(true)
      else if (status.state === 'incompatible') settle(false)
    })
    // Already settled: the listener ran before `off` existed.
    if (settled) off()
  })
  return () => {
    if (seen || binary === false) return null
    waiting ??= deps.owned().then((owned) => {
      binary = owned
      if (owned && !seen) return hello()
    }).catch((err: unknown) => {
      waiting = null
      throw err
    })
    return waiting
  }
}

/**
 * `api` with the members in `keys` held at `gate`: a call before it opens
 * waits, then runs as if made right then (its side decided then); a call
 * after it runs at once. The returned promise's refusal is handled too, so a
 * member whose caller ignores the result (the login's input, resize and
 * cancel) never leaves an unhandled rejection.
 */
export function gated<T extends object>(api: T, keys: readonly (keyof T)[], gate: () => Promise<void> | null): T {
  const out = { ...api }
  for (const key of keys) {
    const member = api[key]
    if (typeof member !== 'function') continue
    const run = member as (...args: unknown[]) => unknown
    out[key] = ((...args: unknown[]) => {
      const wait = gate()
      if (!wait) return run(...args)
      const later = wait.then(() => run(...args))
      later.catch(() => undefined)
      return later
    }) as T[keyof T]
  }
  return out
}

/**
 * One `window.prism` domain with two implementations. Every function picks
 * its side when called, so a host that connects (or drops) later reroutes
 * new calls without rebuilding the façade. Members the host side lacks fall
 * back to IPC; non-function members are copied from the IPC side.
 */
export function routed<T extends object>(domain: string, ipc: T, host: () => Partial<T> | null, route: (domain: string) => Route): T {
  const out = {} as T
  for (const key of Object.keys(ipc) as (keyof T)[]) {
    const ipcMember = ipc[key]
    if (typeof ipcMember !== 'function') {
      out[key] = ipcMember
      continue
    }
    out[key] = ((...args: unknown[]) => {
      const hostMember = route(domain) === 'host' ? host()?.[key] : undefined
      const target = typeof hostMember === 'function' ? hostMember : ipcMember
      return (target as (...a: unknown[]) => unknown)(...args)
    }) as T[keyof T]
  }
  return out
}
