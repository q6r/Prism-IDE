// The panel's edges: the <webview> element API it drives, the main-process
// bridge (window.prism.browser, see src/main/ipc/browser.ts) and the registry
// that routes a guest's events (keyed by its webContents id) to its tab.
import type { BrowserCommand } from './browserModel'

/** Persistent cookie jar shared by every tab (main hardens the guests). */
export const BROWSER_PARTITION = 'persist:prism-browser'

/** The subset of Electron's WebviewTag the panel calls. */
export interface WebviewElement extends HTMLElement {
  loadURL(url: string): Promise<void>
  getURL(): string
  getTitle(): string
  isLoading(): boolean
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  reload(): void
  reloadIgnoringCache(): void
  stop(): void
  setZoomFactor(factor: number): void
  findInPage(text: string, options?: { forward?: boolean; findNext?: boolean; matchCase?: boolean }): number
  stopFindInPage(action: 'clearSelection' | 'keepSelection' | 'activateSelection'): void
  openDevTools(): void
  isDevToolsOpened(): boolean
  closeDevTools(): void
  inspectElement(x: number, y: number): void
  getWebContentsId(): number
  copy(): void
  cut(): void
  paste(): void
  selectAll(): void
}

/** What a guest's own keystroke asked the browser to do (main claims the chord). */
export type BrowserChordCommand = BrowserCommand

export interface BrowserCertificateError {
  readonly url: string
  readonly origin: string
  readonly hostname: string
  readonly error: string
  readonly subject: string
  readonly issuer: string
  readonly fingerprint: string
}

export interface BrowserDownloadEvent {
  readonly id: string
  readonly filename: string
  readonly state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'
  readonly receivedBytes: number
  readonly totalBytes: number
}

/** Every event main sends on `browser:event` (BrowserGuestEvent in main). */
export type BrowserGuestEvent =
  | { readonly type: 'open-tab'; readonly webContentsId: number; readonly url: string; readonly background: boolean }
  | { readonly type: 'chord'; readonly webContentsId: number; readonly command: BrowserChordCommand }
  | { readonly type: 'app-chord'; readonly webContentsId: number; readonly key: string; readonly code: string; readonly ctrlKey: boolean; readonly metaKey: boolean; readonly shiftKey: boolean; readonly altKey: boolean }
  | ({ readonly type: 'certificate-error'; readonly webContentsId: number } & BrowserCertificateError)
  | ({ readonly type: 'download'; readonly webContentsId: number | null } & BrowserDownloadEvent)
  /** Main refused something the page tried without a click (popup flood, automatic download, mailto: loop). */
  | { readonly type: 'blocked'; readonly webContentsId: number; readonly kind: 'popup' | 'download' | 'external'; readonly detail: string }

export interface BrowserLocalServer {
  readonly port: number
  readonly pid: number
  readonly processName: string
}

/** window.prism.browser, exposed by the preload once main registers it. */
export interface BrowserMainBridge {
  onEvent(cb: (event: unknown) => void): () => void
  clearSiteCookies(url: string): Promise<{ site: string | null; removed: number }>
  trustCertificate(origin: string, fingerprint: string): Promise<void>
  localServers(): Promise<BrowserLocalServer[]>
  /** A page favicon as a data URL (the app CSP blocks remote images); null when unavailable. */
  favicon?(url: string): Promise<string | null>
}

const faviconCache = new Map<string, Promise<string | null>>()

/**
 * What an <img> in the app can show for a favicon URL: data URLs as they are,
 * remote ones fetched through main. Without the bridge, `null` - the globe.
 */
export function resolveFavicon(url: string): Promise<string | null> {
  if (url.startsWith('data:image/')) return Promise.resolve(url)
  const fetchIcon = browserMainBridge()?.favicon
  if (!fetchIcon) return Promise.resolve(null)
  const cached = faviconCache.get(url)
  if (cached) return cached
  const value = fetchIcon(url).catch(() => null)
  faviconCache.set(url, value)
  if (faviconCache.size > 300) faviconCache.delete(faviconCache.keys().next().value as string)
  // A miss is retried later (the page may declare the icon, or the server come
  // back), not remembered for the whole run.
  void value.then((src) => {
    if (src === null) setTimeout(() => { if (faviconCache.get(url) === value) faviconCache.delete(url) }, 60_000)
  })
  return value
}

/**
 * Read through `unknown` on purpose: the panel must render (with popups,
 * reserved chords and the local-server list switched off) before the preload
 * exposes the bridge, and the shared preload typings are not this file's.
 */
export function browserMainBridge(): BrowserMainBridge | null {
  const prism = (window as unknown as { prism?: { browser?: Partial<BrowserMainBridge> } }).prism
  const bridge = prism?.browser
  if (!bridge || typeof bridge.onEvent !== 'function') return null
  return bridge as BrowserMainBridge
}

export function openExternalUrl(url: string): void {
  const prism = (window as unknown as { prism?: { app?: { openExternal?: (url: string) => Promise<void> } } }).prism
  void prism?.app?.openExternal?.(url)?.catch(() => undefined)
}

const KNOWN_EVENTS = new Set(['open-tab', 'chord', 'app-chord', 'certificate-error', 'download', 'blocked'])

export function asGuestEvent(value: unknown): BrowserGuestEvent | null {
  if (typeof value !== 'object' || value === null) return null
  const type = (value as { type?: unknown }).type
  return typeof type === 'string' && KNOWN_EVENTS.has(type) ? (value as BrowserGuestEvent) : null
}

/* ---------------- Tab handles ---------------- */

/** Imperative controls a mounted tab view publishes for the toolbar and shortcuts. */
export interface BrowserTabHandle {
  readonly webview: () => WebviewElement | null
  readonly webContentsId: () => number | null
  navigate(url: string): void
  back(): void
  forward(): void
  reload(ignoreCache: boolean): void
  stop(): void
  setZoom(percent: number): void
  find(query: string, options: { forward: boolean; findNext: boolean; matchCase: boolean }): void
  stopFind(): void
  toggleDevTools(): void
  focusPage(): void
}

const handles = new Map<string, BrowserTabHandle>()

export function registerTabHandle(tabId: string, handle: BrowserTabHandle): () => void {
  handles.set(tabId, handle)
  return () => {
    if (handles.get(tabId) === handle) handles.delete(tabId)
  }
}

export function tabHandle(tabId: string | null): BrowserTabHandle | null {
  return tabId === null ? null : (handles.get(tabId) ?? null)
}

export function tabIdForWebContents(webContentsId: number): string | null {
  for (const [tabId, handle] of handles) if (handle.webContentsId() === webContentsId) return tabId
  return null
}
