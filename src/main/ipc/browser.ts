import { app, BrowserWindow, dialog, ipcMain, session, shell, type MessageBoxOptions, type Session, type WebContents } from 'electron'
import { execFile } from 'child_process'
import { basename } from 'path'

/**
 * Main-process half of the embedded browser panel
 * (src/renderer/src/components/browser). The panel's <webview> guests live in
 * one persistent partition; this file gives them what a renderer cannot:
 *
 * - popups and target=_blank links become panel tabs (never BrowserWindows),
 *   only right after a click or key and never in a flood; the same rule for
 *   mailto:/tel: hand-offs and automatic downloads;
 * - the partition never loads file:, and camera / location / notifications /
 *   clipboard reading are refused to the web and asked for on localhost;
 * - browser chords pressed inside a focused page (Ctrl+T/W/L/F, reload, zoom,
 *   tab switching) reach the panel instead of the page, and a few app chords
 *   (palette, terminal, settings) reach the app;
 * - certificate warnings are reported, and accepted per origin on request;
 * - downloads report progress;
 * - "clear cookies for this site", favicons as data URLs (the app's CSP allows
 *   no remote images) and the start page's local-server list.
 *
 * Everything the renderer receives travels on one channel, `browser:event`.
 */

export const BROWSER_PARTITION = 'persist:prism-browser'
const EVENT_CHANNEL = 'browser:event'

export type BrowserCommand =
  | 'newTab' | 'closeTab' | 'reopenClosedTab' | 'focusAddress' | 'find'
  | 'reload' | 'hardReload' | 'back' | 'forward'
  | 'zoomIn' | 'zoomOut' | 'zoomReset' | 'devtools'
  | 'nextTab' | 'previousTab' | `selectTab${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`

export interface BrowserKeyInput {
  readonly key: string
  readonly code: string
  readonly ctrl: boolean
  readonly meta: boolean
  readonly shift: boolean
  readonly alt: boolean
}

/**
 * The browser chords a focused page does not get to keep. Same table as the
 * renderer's browserChordForKey (components/browser/browserModel.ts); the
 * tests hold the two copies together.
 */
export function browserChordForKey(input: BrowserKeyInput): BrowserCommand | null {
  const mod = input.ctrl || input.meta
  const key = input.key.length === 1 ? input.key.toLowerCase() : input.key
  if (mod && !input.alt) {
    if (key === 't') return input.shift ? 'reopenClosedTab' : 'newTab'
    if (key === 'w' && !input.shift) return 'closeTab'
    if (key === 'l' && !input.shift) return 'focusAddress'
    if (key === 'f' && !input.shift) return 'find'
    if (key === 'r') return input.shift ? 'hardReload' : 'reload'
    if (key === 'i' && input.shift) return 'devtools'
    if (key === 'Tab') return input.shift ? 'previousTab' : 'nextTab'
    if (key === 'PageDown' && !input.shift) return 'nextTab'
    if (key === 'PageUp' && !input.shift) return 'previousTab'
    if (input.code === 'Equal' || input.code === 'NumpadAdd' || key === '+' || key === '=') return 'zoomIn'
    if (input.code === 'Minus' || input.code === 'NumpadSubtract' || key === '-') return 'zoomOut'
    if (!input.shift && (input.code === 'Digit0' || input.code === 'Numpad0' || key === '0')) return 'zoomReset'
    const digit = /^Digit([1-9])$/.exec(input.code)?.[1] ?? (/^[1-9]$/.test(key) ? key : null)
    if (digit !== null && !input.shift) return `selectTab${Number(digit) as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`
    if (key === 'F5') return 'hardReload'
    return null
  }
  if (input.alt && !mod && !input.shift) {
    if (key === 'ArrowLeft') return 'back'
    if (key === 'ArrowRight') return 'forward'
    if (key === 'd') return 'focusAddress'
    return null
  }
  if (!mod && !input.alt) {
    if (key === 'F5') return input.shift ? 'hardReload' : 'reload'
    if (key === 'F6' && !input.shift) return 'focusAddress'
    if (key === 'F12' && !input.shift) return 'devtools'
    if (key === 'BrowserBack') return 'back'
    if (key === 'BrowserForward') return 'forward'
    if (key === 'BrowserRefresh') return 'reload'
  }
  return null
}

/**
 * App shortcuts replayed into the app even while a page has focus. Kept small
 * and app-level on purpose (Traycer's rule): a chord a site may legitimately
 * bind - Ctrl+B, Ctrl+P, Ctrl+S - stays the page's.
 */
export function isAppForwardedChord(input: BrowserKeyInput): boolean {
  const mod = input.ctrl || input.meta
  if (!mod || input.alt) return false
  const key = input.key.length === 1 ? input.key.toLowerCase() : input.key
  if (input.shift) return key === 'p' || key === 'n'
  return key === '`' || key === ','
}

const SECOND_LEVEL_LABELS = new Set(['com', 'net', 'org', 'gov', 'edu', 'co', 'ac', 'or', 'ne', 'go', 'mil', 'nom', 'ltd', 'plc'])

/** eTLD+1 by heuristic; same as the renderer's registrableDomain. */
export function registrableDomain(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '')
  if (hostname.length === 0) return null
  if (/^\[.*\]$/.test(hostname) || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return hostname
  const labels = hostname.split('.')
  if (labels.length <= 2) return hostname
  const tld = labels[labels.length - 1]
  const second = labels[labels.length - 2]
  const take = tld.length === 2 && SECOND_LEVEL_LABELS.has(second) ? 3 : 2
  return labels.slice(-take).join('.')
}

/** Does a cookie stored for `cookieDomain` belong to `site`? */
export function cookieBelongsToSite(cookieDomain: string | undefined, site: string): boolean {
  const domain = (cookieDomain ?? '').replace(/^\./, '').toLowerCase()
  return domain === site || domain.endsWith(`.${site}`)
}

/** Electron's default UA names Electron and the app; sites (Google sign-in) refuse that. */
export function chromeLikeUserAgent(userAgent: string, appName: string): string {
  const app = appName.toLowerCase()
  return userAgent
    .split(' ')
    .filter((token) => {
      const product = token.split('/')[0]?.toLowerCase() ?? ''
      return product !== 'electron' && product !== app && product !== app.replace(/\s+/g, '-')
    })
    .join(' ')
}

/* ---------------- Local servers ---------------- */

export interface ListeningSocket {
  readonly port: number
  readonly pid: number
  readonly name?: string
}

export interface ProcessEntry {
  readonly pid: number
  readonly ppid: number
  readonly name: string
}

export interface BrowserLocalServer {
  readonly port: number
  readonly pid: number
  readonly processName: string
}

const IPV4_OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)'
const LOOPBACK_IPV4 = new RegExp(`^127(?:\\.${IPV4_OCTET}){3}$`)

/**
 * A hostname that can only mean this computer: `localhost`, `*.localhost`
 * (Chromium resolves both without DNS), an IPv4 literal in 127.0.0.0/8, or
 * `::1`. Exact, never a prefix test - `127.evil.example` is a public name.
 * Identical to the renderer's copy (components/browser/browserModel.ts).
 */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '[::1]' || host === '::1') return true
  return LOOPBACK_IPV4.test(host)
}

/** A socket's bind address (from netstat/lsof/ss) reachable as `localhost:<port>`. */
export function isLocalListenHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  return h === '0.0.0.0' || h === '::' || h === '*' || h === '::ffff:127.0.0.1' || isLoopbackHostname(h)
}

function splitHostPort(address: string): { host: string; port: number } | null {
  const index = address.lastIndexOf(':')
  if (index <= 0) return null
  const port = Number(address.slice(index + 1))
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  return { host: address.slice(0, index), port }
}

/**
 * `netstat -ano -p TCP` (and TCPv6). The state column is localized
 * ("LISTENING", "ESCUTANDO"...), so a listener is recognised by its
 * all-zero foreign address instead.
 */
export function parseWindowsNetstat(text: string): ListeningSocket[] {
  const sockets: ListeningSocket[] = []
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*TCP\s+(\S+)\s+(\S+)\s+\S+\s+(\d+)\s*$/i.exec(line)
    if (!match) continue
    const [, local, foreign, pidText] = match
    if (foreign !== '0.0.0.0:0' && foreign !== '[::]:0') continue
    const address = splitHostPort(local)
    const pid = Number(pidText)
    if (!address || !isLocalListenHost(address.host) || pid <= 4) continue
    sockets.push({ port: address.port, pid })
  }
  return sockets
}

/** `pid|ppid|name` lines from the PowerShell process snapshot. */
export function parseWindowsProcessList(text: string): ProcessEntry[] {
  const entries: ProcessEntry[] = []
  for (const line of text.split(/\r?\n/)) {
    const [pid, ppid, ...name] = line.trim().split('|')
    if (!pid || !ppid || name.length === 0) continue
    const entry = { pid: Number(pid), ppid: Number(ppid), name: name.join('|') }
    if (Number.isInteger(entry.pid) && Number.isInteger(entry.ppid)) entries.push(entry)
  }
  return entries
}

/** `lsof -nP -iTCP -sTCP:LISTEN -Fpcn` field output. */
export function parseLsof(text: string): ListeningSocket[] {
  const sockets: ListeningSocket[] = []
  let pid = 0
  let name = ''
  for (const line of text.split(/\r?\n/)) {
    const field = line[0]
    const value = line.slice(1)
    if (field === 'p') {
      pid = Number(value)
      name = ''
    } else if (field === 'c') {
      name = value
    } else if (field === 'n') {
      const address = splitHostPort(value.replace(/\s.*$/, ''))
      if (address && isLocalListenHost(address.host) && pid > 0) sockets.push({ port: address.port, pid, name })
    }
  }
  return sockets
}

/** `ss -ltnpH` (Linux without lsof). */
export function parseSs(text: string): ListeningSocket[] {
  const sockets: ListeningSocket[] = []
  for (const line of text.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/)
    if (columns.length < 5) continue
    const address = splitHostPort(columns[3])
    const users = /users:\(\("([^"]+)",pid=(\d+)/.exec(line)
    if (!address || !users || !isLocalListenHost(address.host.replace(/%.*$/, ''))) continue
    sockets.push({ port: address.port, pid: Number(users[2]), name: users[1] })
  }
  return sockets
}

/** `ps -A -o pid=,ppid=,comm=`. */
export function parsePs(text: string): ProcessEntry[] {
  const entries: ProcessEntry[] = []
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (match) entries.push({ pid: Number(match[1]), ppid: Number(match[2]), name: basename(match[3].trim()) })
  }
  return entries
}

export function descendantPids(processes: readonly ProcessEntry[], rootPid: number): Set<number> {
  const children = new Map<number, number[]>()
  for (const entry of processes) {
    if (entry.pid === entry.ppid) continue
    const list = children.get(entry.ppid) ?? []
    list.push(entry.pid)
    children.set(entry.ppid, list)
  }
  const found = new Set<number>()
  const queue = [rootPid]
  while (queue.length > 0) {
    const next = queue.shift()!
    for (const child of children.get(next) ?? []) {
      if (found.has(child) || child === rootPid) continue
      found.add(child)
      queue.push(child)
    }
  }
  return found
}

/**
 * The servers a blank tab offers (Traycer's "Local servers"): ports listening
 * on this computer whose process was started from Prism - its terminals and
 * agents - one row per port, Prism's own processes excluded.
 */
export function collectLocalServers(
  sockets: readonly ListeningSocket[],
  processes: readonly ProcessEntry[],
  rootPid: number,
  ownProcessNames: readonly string[]
): BrowserLocalServer[] {
  const descendants = descendantPids(processes, rootPid)
  const names = new Map(processes.map((entry) => [entry.pid, entry.name]))
  const own = new Set(ownProcessNames.map((name) => name.toLowerCase()))
  const byPort = new Map<number, BrowserLocalServer>()
  for (const socket of sockets) {
    if (socket.pid === rootPid || !descendants.has(socket.pid) || byPort.has(socket.port)) continue
    const raw = names.get(socket.pid) ?? socket.name ?? 'servidor'
    if (own.has(raw.toLowerCase())) continue
    byPort.set(socket.port, { port: socket.port, pid: socket.pid, processName: raw.replace(/\.exe$/i, '') })
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port)
}

function run(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 5000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

async function readListeningSockets(): Promise<ListeningSocket[]> {
  if (process.platform === 'win32') {
    const [v4, v6] = await Promise.all([run('netstat', ['-ano', '-p', 'TCP']), run('netstat', ['-ano', '-p', 'TCPv6']).catch(() => '')])
    return parseWindowsNetstat(`${v4}\n${v6}`)
  }
  try {
    return parseLsof(await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn']))
  } catch (error) {
    if (process.platform !== 'linux') throw error
    return parseSs(await run('ss', ['-ltnpH']))
  }
}

async function readProcesses(): Promise<ProcessEntry[]> {
  if (process.platform === 'win32') {
    const script = "Get-CimInstance Win32_Process | ForEach-Object { '{0}|{1}|{2}' -f $_.ProcessId,$_.ParentProcessId,$_.Name }"
    return parseWindowsProcessList(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]))
  }
  return parsePs(await run('ps', ['-A', '-o', 'pid=,ppid=,comm=']))
}

let serversCache: { at: number; value: Promise<BrowserLocalServer[]> } | null = null
/**
 * pid → whether it is one of Prism's descendants (and its name). The process
 * snapshot is the slow half (PowerShell takes about a second), so it is taken
 * only when a pid nobody has classified yet starts listening.
 */
const listenerOwners = new Map<number, ProcessEntry | null>()

function listLocalServers(): Promise<BrowserLocalServer[]> {
  if (serversCache && Date.now() - serversCache.at < 3000) return serversCache.value
  const value = (async () => {
    const sockets = await readListeningSockets()
    const listening = new Set(sockets.map((socket) => socket.pid))
    for (const pid of [...listenerOwners.keys()]) if (!listening.has(pid)) listenerOwners.delete(pid)
    if ([...listening].some((pid) => !listenerOwners.has(pid))) {
      const processes = await readProcesses()
      const ours = new Set(collectLocalServers(sockets, processes, process.pid, [basename(process.execPath)]).map((server) => server.pid))
      const byPid = new Map(processes.map((entry) => [entry.pid, entry]))
      for (const pid of listening) listenerOwners.set(pid, ours.has(pid) ? (byPid.get(pid) ?? null) : null)
    }
    const known: ProcessEntry[] = [...listenerOwners.values()].filter((entry): entry is ProcessEntry => entry !== null)
    // Re-root the cached owners directly under this process for the pure collector.
    return collectLocalServers(sockets, known.map((entry) => ({ ...entry, ppid: process.pid })), process.pid, [basename(process.execPath)])
  })()
  serversCache = { at: Date.now(), value }
  value.catch(() => { serversCache = null })
  return value
}

/* ---------------- Guests ---------------- */

/** origin → certificate fingerprints the reader chose to proceed past (this run). */
const trustedCertificates = new Map<string, Set<string>>()

/** Granted to any page: harmless on their own. */
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen', 'pointerLock'])
/**
 * Never granted to the web; for a page served from this computer (camera,
 * location or notification testing on a dev server) the reader is asked, once
 * per origin and run - any local process can serve localhost.
 */
const LOOPBACK_PERMISSIONS = new Set(['media', 'geolocation', 'notifications', 'clipboard-read'])

/** An http(s) URL whose host can only be this computer ({@link isLoopbackHostname}). */
export function isLoopbackUrl(url: string | undefined): boolean {
  if (!url) return false
  try {
    const parsed = new URL(url)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && isLoopbackHostname(parsed.hostname)
  } catch {
    return false
  }
}

/** Chrome's transient user activation: how long a click or key counts as "the reader asked". */
export const USER_ACTIVATION_MS = 5000

export interface TokenBucket {
  tokens: number
  at: number
}

export function newTokenBucket(capacity: number, now: number): TokenBucket {
  return { tokens: capacity, at: now }
}

/** Refills `bucket` for the time elapsed and takes one token if there is one. */
export function takeToken(bucket: TokenBucket, now: number, capacity: number, refillMs: number): boolean {
  const refilled = Math.min(capacity, bucket.tokens + Math.max(0, now - bucket.at) / refillMs)
  // Never moves back: a clock stepping backwards must not be counted again as elapsed time.
  bucket.at = Math.max(bucket.at, now)
  if (refilled < 1) {
    bucket.tokens = refilled
    return false
  }
  bucket.tokens = refilled - 1
  return true
}

/** Popup / external-link budget: a burst of 3, then one a second (per guest). */
export const POPUP_BURST = 3
export const POPUP_REFILL_MS = 1000

/**
 * Whether a page may open a tab (or hand a mailto:/tel: link to the OS) now.
 * Chrome's rule - only right after the reader clicked or typed - once this
 * Electron has shown it reports guest input; the token bucket caps it either
 * way, so `setInterval(open)` can never flood the panel.
 */
export function activationAllows(args: { now: number; gestureAt: number; gesturesKnown: boolean; bucket: TokenBucket }): boolean {
  if (args.gesturesKnown && args.now - args.gestureAt > USER_ACTIVATION_MS) return false
  return takeToken(args.bucket, args.now, POPUP_BURST, POPUP_REFILL_MS)
}

/**
 * Chrome's "download multiple files" rule: a download right after a gesture,
 * or the page's first automatic one, goes through; later automatic ones are
 * refused (and, without gesture reporting, spaced at least 5 s apart).
 */
export function downloadAllowed(args: { now: number; gestureAt: number; gesturesKnown: boolean; downloadsSinceNavigation: number; lastDownloadAt: number }): boolean {
  if (args.gesturesKnown && args.now - args.gestureAt <= USER_ACTIVATION_MS) return true
  if (args.downloadsSinceNavigation === 0) return true
  return !args.gesturesKnown && args.now - args.lastDownloadAt >= 5000
}

/** The permission prompt's verb phrase, in the panel's language. */
export function permissionPromptLabel(permission: string, mediaTypes: readonly string[]): string {
  if (permission === 'media') {
    const video = mediaTypes.includes('video')
    const audio = mediaTypes.includes('audio')
    if (video && !audio) return 'usar a sua câmera'
    if (audio && !video) return 'usar o seu microfone'
    return 'usar a sua câmera e o seu microfone'
  }
  if (permission === 'geolocation') return 'saber a sua localização'
  if (permission === 'notifications') return 'mostrar notificações'
  if (permission === 'clipboard-read') return 'ler a área de transferência'
  return `usar o recurso "${permission}"`
}

/** The decision keys a request needs: one per media type, else the permission itself. */
export function permissionAtoms(permission: string, mediaTypes: readonly string[]): string[] {
  if (permission !== 'media') return [permission]
  const types = mediaTypes.filter((type) => type === 'video' || type === 'audio')
  return (types.length > 0 ? types : ['video', 'audio']).map((type) => `media:${type}`)
}

const GESTURE_INPUTS = new Set(['mouseDown', 'mouseUp', 'pointerDown', 'pointerUp', 'rawKeyDown', 'keyDown', 'touchEnd', 'gestureTap'])

interface GuestState {
  gestureAt: number
  popups: TokenBucket
  external: TokenBucket
  downloadsSinceNavigation: number
  lastDownloadAt: number
  noticeAt: Record<string, number>
}

const guestStates = new Map<number, GuestState>()
/** Set once any guest reports input through 'input-event'; until then gestures cannot be required. */
let gesturesKnown = false

function guestState(guest: WebContents): GuestState {
  let state = guestStates.get(guest.id)
  if (!state) {
    const now = Date.now()
    state = { gestureAt: 0, popups: newTokenBucket(POPUP_BURST, now), external: newTokenBucket(1, now), downloadsSinceNavigation: 0, lastDownloadAt: 0, noticeAt: {} }
    guestStates.set(guest.id, state)
  }
  return state
}

/** Tells the panel something was refused, at most once every 3 s per kind and guest. */
function notifyBlocked(guest: WebContents, kind: 'popup' | 'download' | 'external', detail: string): void {
  const state = guestState(guest)
  const now = Date.now()
  if (now - (state.noticeAt[kind] ?? 0) < 3000) return
  state.noticeAt[kind] = now
  emit(guest, { type: 'blocked', kind, detail })
}

/** mailto:/tel: to the OS, only right after a gesture and never more than once in 3 s. */
function openExternalGated(guest: WebContents, url: string): void {
  const state = guestState(guest)
  const now = Date.now()
  const allowed = (!gesturesKnown || now - state.gestureAt <= USER_ACTIVATION_MS) && takeToken(state.external, now, 1, 3000)
  if (!allowed) {
    notifyBlocked(guest, 'external', url)
    return
  }
  state.gestureAt = 0
  void shell.openExternal(url)
}

/* Permission prompts: one native dialog at a time, one decision per origin, permission and run. */
const permissionDecisions = new Map<string, boolean>()
const pendingPrompts = new Map<string, Promise<boolean>>()
let promptQueue: Promise<unknown> = Promise.resolve()

function decided(origin: string, atoms: readonly string[]): boolean | null {
  const answers = atoms.map((atom) => permissionDecisions.get(`${origin} ${atom}`))
  if (answers.some((answer) => answer === false)) return false
  return answers.every((answer) => answer === true) ? true : null
}

function askPermission(contents: WebContents | null, origin: string, permission: string, mediaTypes: readonly string[]): Promise<boolean> {
  const atoms = permissionAtoms(permission, mediaTypes)
  const known = decided(origin, atoms)
  if (known !== null) return Promise.resolve(known)
  const key = `${origin} ${atoms.join(',')}`
  const pending = pendingPrompts.get(key)
  if (pending) return pending
  const prompt = promptQueue
    .catch(() => undefined)
    .then(async () => {
      const again = decided(origin, atoms)
      if (again !== null) return again
      const host = contents && !contents.isDestroyed() ? contents.hostWebContents : null
      const window = host ? BrowserWindow.fromWebContents(host) : null
      const options: MessageBoxOptions = {
        type: 'question',
        buttons: ['Bloquear', 'Permitir'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        title: 'Permissão do site',
        message: `${origin} quer ${permissionPromptLabel(permission, mediaTypes)}`,
        detail: 'Pedido de uma página no navegador do Prism servida por este computador. Permita só se você confia no servidor local. A escolha vale até fechar o Prism.'
      }
      const { response } = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options)
      const granted = response === 1
      for (const atom of atoms) permissionDecisions.set(`${origin} ${atom}`, granted)
      return granted
    })
    .catch(() => false)
    .finally(() => pendingPrompts.delete(key))
  promptQueue = prompt
  pendingPrompts.set(key, prompt)
  return prompt
}

function emit(guest: WebContents, payload: Record<string, unknown>): void {
  const host = guest.hostWebContents
  if (!host || host.isDestroyed()) return
  host.send(EVENT_CHANNEL, { ...payload, webContentsId: guest.id })
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

function wireGuest(guest: WebContents): void {
  guestState(guest)
  guest.once('destroyed', () => guestStates.delete(guest.id))

  // The reader's own clicks and keys: what lets a page open one popup, start a
  // download or hand off a mailto: link (Chrome's user activation).
  guest.on('input-event', (_event, input) => {
    gesturesKnown = true
    if (GESTURE_INPUTS.has(input.type)) guestState(guest).gestureAt = Date.now()
  })

  guest.setWindowOpenHandler(({ url, disposition }) => {
    if (/^https?:/i.test(url)) {
      const state = guestState(guest)
      const now = Date.now()
      if (activationAllows({ now, gestureAt: state.gestureAt, gesturesKnown, bucket: state.popups })) {
        // One popup per gesture, as in Chrome.
        if (gesturesKnown) state.gestureAt = 0
        emit(guest, { type: 'open-tab', url, background: disposition === 'background-tab' })
      } else {
        notifyBlocked(guest, 'popup', url)
      }
    } else if (/^(mailto|tel):/i.test(url)) {
      openExternalGated(guest, url)
    }
    return { action: 'deny' }
  })

  guest.on('will-navigate', (event, url) => {
    if (/^(https?:|about:blank)/i.test(url)) return
    event.preventDefault()
    if (/^(mailto|tel):/i.test(url)) openExternalGated(guest, url)
  })

  guest.on('did-navigate', (_event, url) => {
    guestState(guest).downloadsSinceNavigation = 0
    allowFavicon(defaultFaviconUrl(url))
  })

  guest.on('page-favicon-updated', (_event, favicons) => {
    for (const url of favicons.slice(0, 8)) allowFavicon(url)
  })

  guest.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const key: BrowserKeyInput = { key: input.key, code: input.code, ctrl: input.control, meta: input.meta, shift: input.shift, alt: input.alt }
    const command = browserChordForKey(key)
    if (command !== null) {
      event.preventDefault()
      emit(guest, { type: 'chord', command })
      return
    }
    if (isAppForwardedChord(key)) {
      event.preventDefault()
      emit(guest, { type: 'app-chord', key: input.key, code: input.code, ctrlKey: input.control, metaKey: input.meta, shiftKey: input.shift, altKey: input.alt })
    }
  })

  guest.on('certificate-error', (event, url, error, certificate, callback, isMainFrame) => {
    event.preventDefault()
    const origin = originOf(url)
    if (origin !== null && trustedCertificates.get(origin)?.has(certificate.fingerprint)) {
      callback(true)
      return
    }
    callback(false)
    if (!isMainFrame || origin === null) return
    emit(guest, {
      type: 'certificate-error',
      url,
      origin,
      hostname: new URL(url).hostname,
      error,
      subject: certificate.subjectName,
      issuer: certificate.issuerName,
      fingerprint: certificate.fingerprint
    })
  })
}

/** A webview that is not the panel's: no popups, no navigation off http(s). */
function wireForeignGuest(guest: WebContents): void {
  guest.setWindowOpenHandler(() => ({ action: 'deny' }))
  guest.on('will-navigate', (event, url) => {
    if (!/^(https?:|about:blank)/i.test(url)) event.preventDefault()
  })
}

function hardenSession(ses: Session): void {
  ses.setUserAgent(chromeLikeUserAgent(ses.getUserAgent(), app.getName()))
  // The guest only ever loads http(s); a file: request (a typed address, a
  // subframe, a redirect) is refused at the protocol, whatever asked for it.
  ses.protocol.handle('file', () => new Response('Bloqueado pelo navegador do Prism.', { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } }))
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (permission === 'openExternal') {
      const url = (details as { externalURL?: string }).externalURL ?? ''
      if (/^(mailto|tel):/i.test(url) && contents && contents.getType() === 'webview') openExternalGated(contents, url)
      // Handled above (gated) or refused; Chromium never launches it itself.
      callback(false)
      return
    }
    if (ALLOWED_PERMISSIONS.has(permission)) {
      callback(true)
      return
    }
    const origin = originOf(details.requestingUrl)
    if (!LOOPBACK_PERMISSIONS.has(permission) || origin === null || !isLoopbackUrl(details.requestingUrl)) {
      callback(false)
      return
    }
    const mediaTypes = (details as { mediaTypes?: string[] }).mediaTypes ?? []
    void askPermission(contents, origin, permission, mediaTypes).then(callback, () => callback(false))
  })
  ses.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
    if (ALLOWED_PERMISSIONS.has(permission)) return true
    const origin = originOf(requestingOrigin)
    if (!LOOPBACK_PERMISSIONS.has(permission) || origin === null || !isLoopbackUrl(requestingOrigin)) return false
    const mediaType = (details as { mediaType?: string }).mediaType
    return decided(origin, permissionAtoms(permission, mediaType ? [mediaType] : [])) === true
  })
  ses.on('will-download', (event, item, contents) => {
    if (contents && contents.getType() === 'webview') {
      const state = guestState(contents)
      const now = Date.now()
      if (!downloadAllowed({ now, gestureAt: state.gestureAt, gesturesKnown, downloadsSinceNavigation: state.downloadsSinceNavigation, lastDownloadAt: state.lastDownloadAt })) {
        event.preventDefault()
        notifyBlocked(contents, 'download', item.getFilename())
        return
      }
      state.downloadsSinceNavigation += 1
      state.lastDownloadAt = now
    }
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const report = (state: string): void => {
      if (!contents || contents.isDestroyed()) return
      emit(contents, {
        type: 'download',
        id,
        filename: item.getFilename(),
        state,
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes()
      })
    }
    item.on('updated', (_e, state) => report(state === 'interrupted' ? 'progressing' : state))
    item.once('done', (_e, state) => report(state))
  })
}

async function clearSiteCookies(url: string): Promise<{ site: string | null; removed: number }> {
  const site = registrableDomain(url)
  if (site === null) return { site: null, removed: 0 }
  const ses = session.fromPartition(BROWSER_PARTITION)
  const cookies = await ses.cookies.get({})
  let removed = 0
  for (const cookie of cookies) {
    if (!cookieBelongsToSite(cookie.domain, site)) continue
    const host = (cookie.domain ?? site).replace(/^\./, '')
    const cookieUrl = `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path ?? '/'}`
    try {
      await ses.cookies.remove(cookieUrl, cookie.name)
      removed++
    } catch {
      /* already gone */
    }
  }
  await ses.cookies.flushStore().catch(() => undefined)
  return { site, removed }
}

export const FAVICON_MAX_BYTES = 256 * 1024
const FAVICON_CACHE_LIMIT = 300
const FAVICON_FAILURE_TTL_MS = 60_000
const FAVICON_CONCURRENCY = 4
/** In-memory and separate from the browsing jar: a favicon fetch carries no cookies. */
const FAVICON_PARTITION = 'prism-browser-favicons'
const faviconCache = new Map<string, { at: number; failed: boolean; value: Promise<string | null> }>()
/** Icon addresses a guest itself declared (page-favicon-updated); nothing else is fetched. */
const faviconAllowlist = new Set<string>()

function allowFavicon(url: string | null): void {
  if (url === null || !/^https?:\/\//i.test(url) || faviconAllowlist.has(url)) return
  faviconAllowlist.add(url)
  if (faviconAllowlist.size > 2000) faviconAllowlist.delete(faviconAllowlist.values().next().value as string)
}

/** `<origin>/favicon.ico` for an http(s) page, the address every browser tries. */
export function defaultFaviconUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return `${parsed.origin}/favicon.ico`
  } catch {
    return null
  }
}

/** True for exactly `<origin>/favicon.ico`: fixed path, no query, no credentials. */
export function isDefaultFaviconUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.username === '' && parsed.password === ''
      && parsed.pathname === '/favicon.ico' && parsed.search === '' && parsed.hash === ''
  } catch {
    return false
  }
}

/** Reads a body up to `limit` bytes; `null` (and the stream cancelled) past it. */
export async function readBodyLimited(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Buffer | null> {
  if (body === null) return null
  const reader = body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

let faviconsInFlight = 0
const faviconWaiters: (() => void)[] = []

async function withFaviconSlot<T>(run: () => Promise<T>): Promise<T> {
  while (faviconsInFlight >= FAVICON_CONCURRENCY) await new Promise<void>((resolve) => faviconWaiters.push(resolve))
  faviconsInFlight++
  try {
    return await run()
  } finally {
    faviconsInFlight--
    faviconWaiters.shift()?.()
  }
}

/** Image content type for a favicon response; `.ico` servers often send octet-stream. */
export function faviconContentType(contentType: string | null, url: string): string | null {
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase()
  if (type.startsWith('image/')) return type
  if (/\.ico(\?|#|$)/i.test(url) && (type === '' || type === 'application/octet-stream')) return 'image/x-icon'
  return null
}

/**
 * The host renderer's CSP allows only data: images, so a page's favicon is
 * fetched here and handed over as a data URL - but only an icon a guest
 * declared (or `<origin>/favicon.ico`), from a cookie-less session, at most 4
 * at a time, read as a stream and cut off at 256 KB. Failures are retried
 * after a minute rather than cached for the run.
 */
function fetchFavicon(url: string): Promise<string | null> {
  if (!/^https?:\/\//i.test(url) || !(faviconAllowlist.has(url) || isDefaultFaviconUrl(url))) return Promise.resolve(null)
  const cached = faviconCache.get(url)
  if (cached && (!cached.failed || Date.now() - cached.at < FAVICON_FAILURE_TTL_MS)) return cached.value
  const entry = { at: Date.now(), failed: false, value: Promise.resolve<string | null>(null) }
  entry.value = withFaviconSlot(async () => {
    const ses = session.fromPartition(FAVICON_PARTITION)
    const response = await ses.fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(5000) })
    if (!response.ok) return null
    const type = faviconContentType(response.headers.get('content-type'), url)
    const declared = Number(response.headers.get('content-length') ?? '0')
    if (type === null || declared > FAVICON_MAX_BYTES) {
      await response.body?.cancel().catch(() => undefined)
      return null
    }
    const bytes = await readBodyLimited(response.body, FAVICON_MAX_BYTES)
    if (bytes === null || bytes.length === 0) return null
    return `data:${type};base64,${bytes.toString('base64')}`
  })
    .catch(() => null)
    .then((value) => {
      if (value === null) {
        entry.failed = true
        entry.at = Date.now()
      }
      return value
    })
  faviconCache.set(url, entry)
  if (faviconCache.size > FAVICON_CACHE_LIMIT) faviconCache.delete(faviconCache.keys().next().value as string)
  return entry.value
}

let registered = false

export function registerBrowserHandlers(): void {
  if (registered) return
  registered = true
  const browserSession = session.fromPartition(BROWSER_PARTITION)
  hardenSession(browserSession)
  const faviconSession = session.fromPartition(FAVICON_PARTITION)
  faviconSession.setUserAgent(browserSession.getUserAgent())
  faviconSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))

  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'webview') return
    // The panel's guests all share the persistent partition; any other webview
    // gets the restrictive minimum.
    const ses = contents.session
    if (ses !== browserSession && (ses.storagePath === null || ses.storagePath !== browserSession.storagePath)) {
      wireForeignGuest(contents)
      return
    }
    wireGuest(contents)
  })

  ipcMain.handle('browser:clear-site-cookies', (_event, url: unknown) => clearSiteCookies(typeof url === 'string' ? url : ''))
  ipcMain.handle('browser:trust-certificate', (_event, origin: unknown, fingerprint: unknown) => {
    if (typeof origin !== 'string' || typeof fingerprint !== 'string' || originOf(origin) !== origin) return
    const set = trustedCertificates.get(origin) ?? new Set<string>()
    set.add(fingerprint)
    trustedCertificates.set(origin, set)
  })
  ipcMain.handle('browser:local-servers', () => listLocalServers())
  ipcMain.handle('browser:favicon', (_event, url: unknown) => fetchFavicon(typeof url === 'string' ? url : ''))
}
