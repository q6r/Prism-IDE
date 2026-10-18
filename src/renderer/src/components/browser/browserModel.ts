// Pure browser-panel logic (no React, no DOM, no Electron): address-bar
// normalization, tab identity, zoom steps, persistence and the overlay
// decision. Mirrors Traycer's lib/browser-view/* and resolve-tile-overlay so
// the panel behaves like Traycer's browser tile; tested in tests/browser*.cjs.

/** The address a fresh tab opens on; the panel shows the start page for it. */
export const BLANK_URL = 'about:blank'

export type BrowserSearchEngine = 'google' | 'duckduckgo' | 'bing' | 'kagi'

export const BROWSER_SEARCH_ENGINE_LABELS: Record<BrowserSearchEngine, string> = {
  google: 'Google',
  duckduckgo: 'DuckDuckGo',
  bing: 'Bing',
  kagi: 'Kagi'
}

const SEARCH_URLS: Record<BrowserSearchEngine, string> = {
  google: 'https://www.google.com/search',
  duckduckgo: 'https://duckduckgo.com/',
  bing: 'https://www.bing.com/search',
  kagi: 'https://kagi.com/search'
}

export function isBrowserSearchEngine(value: unknown): value is BrowserSearchEngine {
  return value === 'google' || value === 'duckduckgo' || value === 'bing' || value === 'kagi'
}

export function browserSearchUrl(query: string, engine: BrowserSearchEngine): string {
  const url = new URL(SEARCH_URLS[engine])
  url.searchParams.set('q', query)
  return url.href
}

function parseUrl(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

/** The one http(s) parser: anything else (about:, file:, garbage) is `null`. */
export function parseHttpUrl(url: string): URL | null {
  const parsed = parseUrl(url)
  return parsed?.protocol === 'http:' || parsed?.protocol === 'https:' ? parsed : null
}

export function isWebOriginUrl(url: string): boolean {
  return parseHttpUrl(url) !== null
}

export function isBlankUrl(url: string): boolean {
  return url === '' || url === BLANK_URL
}

const IPV4_OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)'
const LOOPBACK_IPV4 = new RegExp(`^127(?:\\.${IPV4_OCTET}){3}$`)

/**
 * A hostname that can only mean this computer: `localhost`, `*.localhost`
 * (Chromium resolves both without DNS), an IPv4 literal in 127.0.0.0/8, or
 * `::1`. Exact, never a prefix test - `127.evil.example` is a public name.
 * src/main/ipc/browser.ts keeps an identical copy; tests hold them together.
 */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '[::1]' || host === '::1') return true
  return LOOPBACK_IPV4.test(host)
}

function authorityHostname(authority: string): string {
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']')
    return end < 0 ? authority : authority.slice(0, end + 1)
  }
  return authority.replace(/:\d+$/, '')
}

function looksLikeLocalHttpAddressWithoutScheme(value: string): boolean {
  // The hostname, not the whole string: `app.localhost/path` is as local as
  // `app.localhost`, and guessing https for it fails against a dev server.
  const authority = value.toLowerCase().split(/[/?#]/, 1)[0] ?? ''
  const hostname = authorityHostname(authority)
  return isLoopbackHostname(hostname) || hostname === '0.0.0.0'
}

const KNOWN_SCHEMES = new Set([
  'http', 'https', 'about', 'mailto', 'tel', 'file', 'data', 'blob', 'javascript', 'ftp', 'ws', 'wss',
  'view-source', 'chrome', 'devtools', 'vbscript'
])

/**
 * What the address bar does with what the user typed (Traycer's
 * normalizeBrowserAddressInput): a bare local address gets `http://`, a
 * recognizable host gets `https://`, other text searches. Explicit schemes are
 * left to the navigation policy ({@link navigationPolicy}); empty input stays
 * blank.
 */
export function normalizeBrowserAddressInput(input: string, engine: BrowserSearchEngine): string {
  const trimmed = input.trim()
  if (trimmed.length === 0) return BLANK_URL
  // Search operators resemble URI schemes but belong to the search engine.
  if (/^(?:site|filetype|ext|intitle|allintitle|inurl|allinurl|intext|allintext|before|after):/i.test(trimmed)) {
    return browserSearchUrl(trimmed, engine)
  }
  // Scheme first; a colon followed by digits is a port, not a scheme. Only a
  // scheme a browser knows (or one written with `//`) counts: `foo:bar` and
  // `user:pass@host.com` fall through to the search, as in Chrome.
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):(?!\d)/.exec(trimmed)
  if (scheme && (KNOWN_SCHEMES.has(scheme[1].toLowerCase()) || trimmed.slice(scheme[0].length).startsWith('//'))) return trimmed
  if (!/\s/.test(trimmed) && looksLikeLocalHttpAddressWithoutScheme(trimmed)) return `http://${trimmed}`
  const candidate = /\s/.test(trimmed) ? null : parseHttpUrl(`https://${trimmed}`)
  const authority = trimmed.split(/[/?#]/, 1)[0] ?? ''
  // Dotted hosts, IP literals and explicit host:port addresses navigate.
  // Single words and phrases search; never probe the network to guess.
  if (
    candidate !== null &&
    candidate.username === '' &&
    candidate.password === '' &&
    (authority.includes('.') || authority.startsWith('[') || /:\d+$/.test(authority))
  ) {
    return `https://${trimmed}`
  }
  return browserSearchUrl(trimmed, engine)
}

export type NavigationPolicy =
  | { readonly kind: 'navigate'; readonly url: string }
  | { readonly kind: 'blank' }
  | { readonly kind: 'external'; readonly url: string }
  | { readonly kind: 'unsupported'; readonly url: string }

/**
 * Where a normalized address may go. The guest only ever loads http(s) or the
 * blank start page (main enforces the same rule on attach); mail and phone
 * links hand off to the OS; every other scheme is refused in the panel.
 */
export function navigationPolicy(url: string): NavigationPolicy {
  if (isBlankUrl(url)) return { kind: 'blank' }
  if (parseHttpUrl(url) !== null) return { kind: 'navigate', url }
  if (/^(mailto|tel):/i.test(url)) return { kind: 'external', url }
  return { kind: 'unsupported', url }
}

/** Same page for "submit the same address again reloads" (Traycer's navigateToUrl). */
export function isSameAddress(a: string, b: string): boolean {
  return (parseHttpUrl(a)?.href ?? a) === (parseHttpUrl(b)?.href ?? b)
}

/** What the address field shows for a live URL: nothing for the start page. */
export function addressDisplayValue(url: string): string {
  return isBlankUrl(url) ? '' : url
}

export function browserTabHostname(url: string): string | null {
  const hostname = parseUrl(url)?.hostname ?? ''
  return hostname.length > 0 ? hostname : null
}

export function browserTabOrigin(url: string): string | null {
  return parseHttpUrl(url)?.origin ?? null
}

export function browserTabFaviconUrl(url: string): string | null {
  const parsed = parseHttpUrl(url)
  return parsed === null ? null : new URL('/favicon.ico', parsed.origin).toString()
}

function stripWww(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, '')
}

function normalizeIdentityText(value: string): string {
  return value.trim().toLowerCase().replace(/\/$/, '')
}

/** A document title that just restates the address is no title at all. */
function isFallbackTabTitle(title: string, url: string): boolean {
  const normalizedTitle = normalizeIdentityText(title)
  const hostname = browserTabHostname(url)
  const host = parseHttpUrl(url)?.host ?? null
  const origin = browserTabOrigin(url)
  if ([hostname, host, origin, url].some((c) => c !== null && c !== '' && normalizeIdentityText(c) === normalizedTitle)) return true
  const urlHostKey = hostname === null ? null : stripWww(hostname)
  const parsedTitle = parseUrl(title.includes('://') ? title : `https://${title}`)
  return parsedTitle !== null && urlHostKey !== null && stripWww(parsedTitle.hostname) === urlHostKey
}

export function meaningfulDocumentTitle(title: string | null | undefined, url: string): string | null {
  const trimmed = (title ?? '').trim()
  if (trimmed.length === 0) return null
  if (trimmed === BLANK_URL) return null
  return isFallbackTabTitle(trimmed, url) ? null : trimmed
}

/** The title fallback chain every tab surface uses (Traycer's resolveTabTitle). */
export function resolveTabTitle(title: string | null | undefined, url: string): string {
  if (isBlankUrl(url)) return 'Nova aba'
  return meaningfulDocumentTitle(title, url) ?? browserTabHostname(url) ?? 'Navegador'
}

/** Chromium's zoom presets, the steps Ctrl +/- walk through. */
export const ZOOM_STEPS = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500] as const

export function nextZoomPercent(current: number, direction: 1 | -1): number {
  if (direction === 1) return ZOOM_STEPS.find((step) => step > current + 0.5) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) if (ZOOM_STEPS[i] < current - 0.5) return ZOOM_STEPS[i]
  return ZOOM_STEPS[0]
}

const SECOND_LEVEL_LABELS = new Set(['com', 'net', 'org', 'gov', 'edu', 'co', 'ac', 'or', 'ne', 'go', 'mil', 'nom', 'ltd', 'plc'])

/**
 * The site a cookie jar is cleared for: eTLD+1 by a small heuristic (no public
 * suffix list) - `app.example.com` → `example.com`, `x.example.com.br` →
 * `example.com.br`. IP literals and single-label hosts are their own site.
 */
export function registrableDomain(url: string): string | null {
  const parsed = parseHttpUrl(url)
  if (parsed === null) return null
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

export type SecurityState = 'blank' | 'secure' | 'local' | 'insecure' | 'certificate' | 'other'

export function securityState(url: string, trustedCertificateOrigins: readonly string[]): SecurityState {
  if (isBlankUrl(url)) return 'blank'
  const parsed = parseHttpUrl(url)
  if (parsed === null) return 'other'
  if (trustedCertificateOrigins.includes(parsed.origin)) return 'certificate'
  if (parsed.protocol === 'https:') return 'secure'
  if (isLoopbackHostname(parsed.hostname) || parsed.hostname === '0.0.0.0') return 'local'
  return 'insecure'
}

/* ---------------- Overlay (Traycer resolve-tile-overlay) ---------------- */

export type BrowserTabStatus = 'loading' | 'ready' | 'failed' | 'crashed'
export type OverlaySurface = 'none' | 'loading' | 'stalled' | 'failed' | 'crashed'

/**
 * Which state panel covers the page. Loading and stalled only paint while the
 * tab has never committed a document - once a page has committed, a navigation
 * away keeps it painted and the toolbar carries the in-flight state, exactly
 * as in Traycer. A failed load or a crashed renderer always paints.
 */
export function resolveOverlay(status: BrowserTabStatus, committed: boolean, stalled: boolean): OverlaySurface {
  if (status === 'crashed') return 'crashed'
  if (status === 'failed') return 'failed'
  if (status === 'ready') return 'none'
  if (committed) return 'none'
  return stalled ? 'stalled' : 'loading'
}

/** Chromium net errors that are not failures the reader needs to see. */
export function isIgnorableLoadError(errorCode: number): boolean {
  // -3 ERR_ABORTED: a navigation replaced by another (or stopped by the user).
  return errorCode === -3
}

const LOAD_ERROR_LABELS: Record<number, string> = {
  [-2]: 'Ocorreu uma falha ao carregar a página.',
  [-6]: 'O arquivo ou endereço não foi encontrado.',
  [-7]: 'O servidor demorou demais para responder.',
  [-10]: 'O acesso a este endereço foi negado.',
  [-20]: 'O endereço foi bloqueado.',
  [-21]: 'A rede mudou durante o carregamento.',
  [-100]: 'O servidor encerrou a conexão inesperadamente.',
  [-101]: 'A conexão foi redefinida.',
  [-102]: 'A conexão foi recusada. Verifique se o servidor está em execução.',
  [-104]: 'Não foi possível conectar ao servidor.',
  [-105]: 'Não foi possível encontrar o endereço do servidor.',
  [-106]: 'Sem conexão com a internet.',
  [-109]: 'O endereço não está acessível.',
  [-118]: 'A conexão expirou.',
  [-137]: 'Não foi possível resolver o nome do servidor.',
  [-300]: 'O endereço é inválido.',
  [-301]: 'Este navegador não abre endereços desse tipo.',
  [-310]: 'Redirecionamentos demais.',
  [-324]: 'O servidor não enviou nenhum dado.'
}

/** A readable sentence for a Chromium net error (the raw code is shown beside it). */
export function loadErrorLabel(errorCode: number): string {
  if (LOAD_ERROR_LABELS[errorCode]) return LOAD_ERROR_LABELS[errorCode]
  if (errorCode <= -200 && errorCode > -300) return 'O certificado de segurança do site não é confiável.'
  return 'Ocorreu um erro ao carregar a página.'
}

export function crashReasonLabel(reason: string): string {
  switch (reason) {
    case 'crashed': return 'A página travou.'
    case 'oom': return 'A página ficou sem memória.'
    case 'killed': return 'O processo da página foi encerrado.'
    case 'launch-failed': return 'Não foi possível iniciar o processo da página.'
    case 'integrity-failure': return 'A verificação de integridade do processo falhou.'
    default: return 'O processo da página parou inesperadamente.'
  }
}

/* ---------------- Keyboard ---------------- */

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
 * Chrome's tab and page shortcuts. The same table runs in main for keys a
 * focused page would otherwise swallow (src/main/ipc/browser.ts keeps a copy;
 * tests hold the two together).
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

/* ---------------- Find ---------------- */

export function findStatusLabel(query: string, searching: boolean, current: number, total: number): string | null {
  if (query.length === 0) return null
  if (searching) return 'Buscando'
  if (total === 0) return 'Nenhum resultado'
  return `${current} de ${total}`
}

/* ---------------- Persistence ---------------- */

export interface PersistedBrowserTab {
  readonly id: string
  readonly url: string
  readonly title: string
  readonly faviconUrl: string | null
  readonly zoomPercent: number
}

export interface PersistedBrowserState {
  readonly version: 1
  readonly activeId: string | null
  readonly tabs: readonly PersistedBrowserTab[]
}

export const MAX_PERSISTED_TABS = 50

function persistableUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null
  if (isBlankUrl(url)) return BLANK_URL
  return parseHttpUrl(url) !== null ? url : null
}

/**
 * Reads what {@link serializeBrowserState} wrote, dropping anything malformed:
 * a corrupt or hand-edited entry costs that tab, never the panel.
 */
export function parsePersistedBrowserState(raw: string | null | undefined): PersistedBrowserState | null {
  if (!raw) return null
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null) return null
  const record = data as { version?: unknown; activeId?: unknown; tabs?: unknown }
  if (record.version !== 1 || !Array.isArray(record.tabs)) return null
  const seen = new Set<string>()
  const tabs: PersistedBrowserTab[] = []
  for (const entry of record.tabs) {
    if (typeof entry !== 'object' || entry === null) continue
    const tab = entry as Record<string, unknown>
    const id = typeof tab.id === 'string' && tab.id.length > 0 ? tab.id : null
    const url = persistableUrl(tab.url)
    if (id === null || url === null || seen.has(id)) continue
    seen.add(id)
    const zoom = typeof tab.zoomPercent === 'number' && Number.isFinite(tab.zoomPercent) ? tab.zoomPercent : 100
    tabs.push({
      id,
      url,
      title: typeof tab.title === 'string' ? tab.title : '',
      faviconUrl: typeof tab.faviconUrl === 'string' && parseHttpUrl(tab.faviconUrl) !== null ? tab.faviconUrl : null,
      zoomPercent: Math.min(500, Math.max(25, zoom))
    })
    if (tabs.length >= MAX_PERSISTED_TABS) break
  }
  const activeId = typeof record.activeId === 'string' && seen.has(record.activeId) ? record.activeId : (tabs[0]?.id ?? null)
  return { version: 1, activeId, tabs }
}

export function serializeBrowserState(state: { activeId: string | null; tabs: readonly PersistedBrowserTab[] }): string {
  // A tab on an address that cannot be restored (blob:, data:, an error page)
  // comes back as a blank tab rather than not at all.
  const tabs = state.tabs.slice(0, MAX_PERSISTED_TABS).map((tab) => ({
    id: tab.id,
    url: persistableUrl(tab.url) ?? BLANK_URL,
    title: tab.title,
    // Only an address: a data: icon can be megabytes, rewritten on every change.
    faviconUrl: tab.faviconUrl !== null && parseHttpUrl(tab.faviconUrl) !== null ? tab.faviconUrl : null,
    zoomPercent: tab.zoomPercent
  }))
  const activeId = tabs.some((tab) => tab.id === state.activeId) ? state.activeId : (tabs[0]?.id ?? null)
  return JSON.stringify({ version: 1, activeId, tabs } satisfies PersistedBrowserState)
}

/* ---------------- Tab ordering ---------------- */

/**
 * Which tab becomes active when `closing` close (Chrome: the nearest surviving
 * tab to the right of the active one, else to its left). An active tab that
 * survives stays active; `null` when nothing survives.
 */
export function nextActiveAfterClose(ids: readonly string[], activeId: string | null, closing: ReadonlySet<string>): string | null {
  const survivors = ids.filter((id) => !closing.has(id))
  if (survivors.length === 0) return null
  if (activeId !== null && survivors.includes(activeId)) return activeId
  const index = activeId === null ? -1 : ids.indexOf(activeId)
  if (index < 0) return survivors[survivors.length - 1]
  const right = ids.slice(index + 1).find((id) => !closing.has(id))
  if (right !== undefined) return right
  return [...ids.slice(0, index)].reverse().find((id) => !closing.has(id)) ?? null
}

/** Moves `id` so it lands before the tab currently at `toIndex` (`ids.length` = end). */
export function moveTabId(ids: readonly string[], id: string, toIndex: number): string[] {
  const from = ids.indexOf(id)
  if (from < 0) return [...ids]
  const without = ids.filter((candidate) => candidate !== id)
  const target = Math.max(0, Math.min(from < toIndex ? toIndex - 1 : toIndex, without.length))
  without.splice(target, 0, id)
  return without
}
