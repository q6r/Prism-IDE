import { create } from 'zustand'
import {
  BLANK_URL,
  MAX_PERSISTED_TABS,
  browserTabFaviconUrl,
  isBlankUrl,
  isBrowserSearchEngine,
  isSameAddress,
  moveTabId,
  navigationPolicy,
  nextActiveAfterClose,
  normalizeBrowserAddressInput,
  parseHttpUrl,
  parsePersistedBrowserState,
  serializeBrowserState,
  type BrowserSearchEngine,
  type BrowserTabStatus,
  type PersistedBrowserTab
} from './browserModel'
import { browserMainBridge, openExternalUrl, tabHandle, type BrowserCertificateError } from './browserBridge'

const STORAGE_KEY = 'prism.browser.tabs.v1'
const SEARCH_ENGINE_KEY = 'prism.browser.searchEngine'
const CLOSED_STACK_LIMIT = 20
/** Tabs a page may push the panel to; past it, popups are refused (the reader can still open more). */
export const MAX_PAGE_OPENED_TABS = MAX_PERSISTED_TABS

/** How far the top progress bar has got: each phase is a target width in browser.css. */
export type ProgressPhase = 'idle' | 'start' | 'commit' | 'dom' | 'done'

export interface BrowserFindState {
  readonly open: boolean
  readonly query: string
  readonly matchCase: boolean
  readonly current: number
  readonly total: number
  readonly searching: boolean
  /** Bumped to re-focus (and select) the find field, e.g. Ctrl+F while it is open. */
  readonly focusNonce: number
}

export interface BrowserLoadError {
  readonly code: number
  readonly description: string
  readonly url: string
}

export interface BrowserTab {
  readonly id: string
  /** The live address (`about:blank` shows the start page). */
  readonly url: string
  readonly title: string
  readonly faviconUrl: string | null
  readonly zoomPercent: number
  readonly status: BrowserTabStatus
  readonly loading: boolean
  readonly progress: ProgressPhase
  readonly error: BrowserLoadError | null
  readonly crashReason: string | null
  readonly canGoBack: boolean
  readonly canGoForward: boolean
  /** The guest has committed a document since it was (re)created. */
  readonly committed: boolean
  /** Restored from a previous run and not opened yet: no guest, no network. */
  readonly dormant: boolean
  /** The address the guest was created with; `null` while only the start page shows. */
  readonly initialSrc: string | null
  /** Bumped to throw the guest away and create a fresh one (crash recovery). */
  readonly mountKey: number
  readonly certificateError: BrowserCertificateError | null
  /** The link under the pointer, for the status bubble. */
  readonly hoverUrl: string
  readonly find: BrowserFindState
  /** Bumped to put the caret in the address field (new tab, Ctrl+L). */
  readonly addressFocusNonce: number
}

const EMPTY_FIND: BrowserFindState = { open: false, query: '', matchCase: false, current: 0, total: 0, searching: false, focusNonce: 0 }

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function makeTab(url: string, init: Partial<BrowserTab> = {}): BrowserTab {
  const web = parseHttpUrl(url) !== null
  return {
    id: newId(),
    url: web ? url : BLANK_URL,
    title: '',
    faviconUrl: null,
    zoomPercent: 100,
    status: web ? 'loading' : 'ready',
    loading: web,
    progress: web ? 'start' : 'idle',
    error: null,
    crashReason: null,
    canGoBack: false,
    canGoForward: false,
    committed: false,
    dormant: false,
    initialSrc: web ? url : null,
    mountKey: 0,
    certificateError: null,
    hoverUrl: '',
    find: EMPTY_FIND,
    addressFocusNonce: 0,
    ...init
  }
}

function restoredTab(saved: PersistedBrowserTab, active: boolean): BrowserTab {
  const web = parseHttpUrl(saved.url) !== null
  return makeTab(saved.url, {
    id: saved.id,
    title: saved.title,
    // Main only proxies icons a page declared this run, or `<origin>/favicon.ico`;
    // a restored tab shows the latter until its page names its own.
    faviconUrl: browserTabFaviconUrl(saved.url),
    zoomPercent: saved.zoomPercent,
    // Only the active tab wakes; the rest stay asleep until opened.
    dormant: web && !active,
    initialSrc: web && active ? saved.url : null,
    status: web && active ? 'loading' : 'ready',
    loading: web && active,
    progress: web && active ? 'start' : 'idle'
  })
}

/** Wakes a dormant tab: its guest is created on the saved address. */
function woken(tab: BrowserTab): BrowserTab {
  if (!tab.dormant) return tab
  const web = parseHttpUrl(tab.url) !== null
  return { ...tab, dormant: false, initialSrc: web ? tab.url : null, status: web ? 'loading' : 'ready', loading: web, progress: web ? 'start' : 'idle' }
}

function toPersisted(tab: BrowserTab): PersistedBrowserTab {
  return { id: tab.id, url: tab.url, title: tab.title, faviconUrl: tab.faviconUrl, zoomPercent: tab.zoomPercent }
}

function readStorage(key: string): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* quota or disabled storage: tabs simply do not survive a restart */
  }
}

function initialState(): { tabs: BrowserTab[]; activeId: string | null } {
  const saved = parsePersistedBrowserState(readStorage(STORAGE_KEY))
  if (saved === null || saved.tabs.length === 0) {
    const tab = makeTab(BLANK_URL)
    return { tabs: [tab], activeId: tab.id }
  }
  return { tabs: saved.tabs.map((tab) => restoredTab(tab, tab.id === saved.activeId)), activeId: saved.activeId }
}

export interface BrowserState {
  readonly tabs: readonly BrowserTab[]
  readonly activeId: string | null
  readonly closed: readonly PersistedBrowserTab[]
  readonly searchEngine: BrowserSearchEngine
  /** Origins the reader chose to proceed to despite a certificate warning (this run only). */
  readonly trustedCertificateOrigins: readonly string[]
  /**
   * Opens a tab and returns its id. `fromPage` marks a tab a page asked for (a
   * popup, a target=_blank link): those stop at {@link MAX_PAGE_OPENED_TABS}
   * open tabs and return `null`.
   */
  openTab(url?: string, options?: { background?: boolean; afterId?: string | null; fromPage?: boolean }): string | null
  closeTab(id: string): void
  closeOthers(id: string): void
  closeRight(id: string): void
  closeAll(): void
  reopenClosed(): void
  duplicate(id: string): void
  activate(id: string): void
  activateOffset(delta: 1 | -1): void
  /** Ctrl+1..8 pick that tab; Ctrl+9 is always the last one (Chrome). */
  activateNumber(n: number): void
  moveTab(id: string, toIndex: number): void
  patch(id: string, patch: Partial<BrowserTab> | ((tab: BrowserTab) => Partial<BrowserTab>)): void
  /** What the address bar and the start page submit. */
  navigate(id: string, input: string): void
  /** Throws the guest away and recreates it on the same address. */
  recover(id: string): void
  setFind(id: string, patch: Partial<BrowserFindState>): void
  focusAddress(id: string): void
  setSearchEngine(engine: BrowserSearchEngine): void
  /** "Prosseguir para esta origem": main accepts the certificate, the tab retries. */
  proceedCertificate(id: string): Promise<void>
}

const initial = initialState()

export const useBrowserStore = create<BrowserState>((set, get) => {
  const closeIds = (ids: ReadonlySet<string>): void => {
    if (ids.size === 0) return
    const { tabs, activeId, closed } = get()
    const closing = tabs.filter((tab) => ids.has(tab.id))
    const remaining = tabs.filter((tab) => !ids.has(tab.id))
    const nextActive = nextActiveAfterClose(tabs.map((tab) => tab.id), activeId, ids)
    const reopenable = closing.filter((tab) => !isBlankUrl(tab.url)).map(toPersisted)
    const nextClosed = [...closed, ...reopenable].slice(-CLOSED_STACK_LIMIT)
    // A browser with no tabs is a blank tab, as in Traycer's Start Page panel.
    if (remaining.length === 0) {
      const tab = makeTab(BLANK_URL, { addressFocusNonce: 1 })
      set({ tabs: [tab], activeId: tab.id, closed: nextClosed })
      return
    }
    const fallback = nextActive ?? remaining[remaining.length - 1].id
    set({ tabs: remaining.map((tab) => (tab.id === fallback ? woken(tab) : tab)), activeId: fallback, closed: nextClosed })
  }

  return {
    tabs: initial.tabs,
    activeId: initial.activeId,
    closed: [],
    trustedCertificateOrigins: [],
    searchEngine: ((): BrowserSearchEngine => {
      const saved = readStorage(SEARCH_ENGINE_KEY)
      return isBrowserSearchEngine(saved) ? saved : 'google'
    })(),

    openTab: (url = BLANK_URL, options = {}) => {
      const { tabs, activeId } = get()
      if (options.fromPage && tabs.length >= MAX_PAGE_OPENED_TABS) return null
      const tab = makeTab(url, isBlankUrl(url) ? { addressFocusNonce: 1 } : {})
      const anchor = options.afterId === undefined ? null : options.afterId
      const index = anchor === null ? tabs.length : tabs.findIndex((t) => t.id === anchor) + 1
      const nextTabs = [...tabs]
      nextTabs.splice(index <= 0 ? tabs.length : index, 0, tab)
      set({ tabs: nextTabs, activeId: options.background ? activeId : tab.id })
      return tab.id
    },

    closeTab: (id) => closeIds(new Set([id])),
    closeOthers: (id) => closeIds(new Set(get().tabs.filter((tab) => tab.id !== id).map((tab) => tab.id))),
    closeRight: (id) => {
      const tabs = get().tabs
      const index = tabs.findIndex((tab) => tab.id === id)
      if (index < 0) return
      closeIds(new Set(tabs.slice(index + 1).map((tab) => tab.id)))
    },
    closeAll: () => closeIds(new Set(get().tabs.map((tab) => tab.id))),

    reopenClosed: () => {
      const closed = get().closed
      const last = closed[closed.length - 1]
      if (!last) return
      set({ closed: closed.slice(0, -1) })
      const id = get().openTab(last.url)
      if (id !== null) get().patch(id, { title: last.title, faviconUrl: last.faviconUrl, zoomPercent: last.zoomPercent })
    },

    duplicate: (id) => {
      const tab = get().tabs.find((candidate) => candidate.id === id)
      if (!tab) return
      const copy = get().openTab(tab.url, { afterId: id })
      if (copy !== null) get().patch(copy, { title: tab.title, faviconUrl: tab.faviconUrl, zoomPercent: tab.zoomPercent })
    },

    activate: (id) => {
      const { tabs, activeId } = get()
      if (id === activeId || !tabs.some((tab) => tab.id === id)) return
      set({ activeId: id, tabs: tabs.map((tab) => (tab.id === id ? woken(tab) : tab)) })
    },

    activateOffset: (delta) => {
      const { tabs, activeId } = get()
      if (tabs.length < 2) return
      const index = tabs.findIndex((tab) => tab.id === activeId)
      get().activate(tabs[(index + delta + tabs.length) % tabs.length].id)
    },

    activateNumber: (n) => {
      const tabs = get().tabs
      if (tabs.length === 0) return
      const target = n >= 9 ? tabs[tabs.length - 1] : tabs[n - 1]
      if (target) get().activate(target.id)
    },

    moveTab: (id, toIndex) => {
      const tabs = get().tabs
      const order = moveTabId(tabs.map((tab) => tab.id), id, toIndex)
      const byId = new Map(tabs.map((tab) => [tab.id, tab]))
      set({ tabs: order.map((tabId) => byId.get(tabId)!).filter(Boolean) })
    },

    patch: (id, patch) => {
      set((state) => ({
        tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, ...(typeof patch === 'function' ? patch(tab) : patch) } : tab))
      }))
    },

    navigate: (id, input) => {
      const tab = get().tabs.find((candidate) => candidate.id === id)
      if (!tab) return
      const url = normalizeBrowserAddressInput(input, get().searchEngine)
      const policy = navigationPolicy(url)
      const handle = tabHandle(id)
      if (policy.kind === 'external') {
        openExternalUrl(policy.url)
        return
      }
      if (policy.kind === 'unsupported') {
        get().patch(id, {
          status: 'failed',
          loading: false,
          progress: 'idle',
          error: { code: 0, description: 'Este navegador só abre endereços http e https.', url: policy.url }
        })
        return
      }
      if (policy.kind === 'blank') {
        if (tab.initialSrc !== null && handle) handle.navigate(BLANK_URL)
        get().patch(id, { url: BLANK_URL, status: 'ready', loading: false, progress: 'idle', error: null, certificateError: null })
        return
      }
      const reset = { error: null, crashReason: null, certificateError: null, dormant: false } as const
      if (tab.initialSrc === null || !handle) {
        // No guest yet (the start page, a dormant tab): create it on the address.
        get().patch(id, { ...reset, url: policy.url, initialSrc: policy.url, status: 'loading', loading: true, progress: 'start', committed: false })
        return
      }
      get().patch(id, reset)
      if (tab.status !== 'failed' && isSameAddress(policy.url, tab.url)) handle.reload(false)
      else handle.navigate(policy.url)
    },

    recover: (id) => {
      get().patch(id, (tab) => {
        const web = parseHttpUrl(tab.url) !== null
        return {
          mountKey: tab.mountKey + 1,
          initialSrc: web ? tab.url : null,
          status: web ? 'loading' : 'ready',
          loading: web,
          progress: web ? 'start' : 'idle',
          committed: false,
          error: null,
          crashReason: null,
          certificateError: null,
          find: EMPTY_FIND
        }
      })
    },

    setFind: (id, patch) => get().patch(id, (tab) => ({ find: { ...tab.find, ...patch } })),

    focusAddress: (id) => get().patch(id, (tab) => ({ addressFocusNonce: tab.addressFocusNonce + 1 })),

    setSearchEngine: (engine) => {
      writeStorage(SEARCH_ENGINE_KEY, engine)
      set({ searchEngine: engine })
    },

    proceedCertificate: async (id) => {
      const tab = get().tabs.find((candidate) => candidate.id === id)
      const warning = tab?.certificateError
      const bridge = browserMainBridge()
      if (!tab || !warning || !bridge) return
      await bridge.trustCertificate(warning.origin, warning.fingerprint)
      set((state) => ({
        trustedCertificateOrigins: state.trustedCertificateOrigins.includes(warning.origin)
          ? state.trustedCertificateOrigins
          : [...state.trustedCertificateOrigins, warning.origin]
      }))
      get().patch(id, { certificateError: null, error: null })
      const handle = tabHandle(id)
      if (handle) handle.navigate(warning.url)
      else get().navigate(id, warning.url)
    }
  }
})

/* ---------------- Persistence ---------------- */

let lastWritten = ''
let saveTimer: ReturnType<typeof setTimeout> | undefined

function persistNow(): void {
  clearTimeout(saveTimer)
  saveTimer = undefined
  const { tabs, activeId } = useBrowserStore.getState()
  const raw = serializeBrowserState({ activeId, tabs: tabs.map(toPersisted) })
  if (raw === lastWritten) return
  lastWritten = raw
  writeStorage(STORAGE_KEY, raw)
}

useBrowserStore.subscribe((state, previous) => {
  if (state.tabs === previous.tabs && state.activeId === previous.activeId) return
  clearTimeout(saveTimer)
  saveTimer = setTimeout(persistNow, 400)
})

if (typeof window !== 'undefined') window.addEventListener('beforeunload', persistNow)

/** Opens `url` in a new foreground tab of the browser panel. */
export function openInBrowserPanel(url: string): string | null {
  return useBrowserStore.getState().openTab(url)
}

export function activeBrowserTab(state: BrowserState): BrowserTab | null {
  return state.tabs.find((tab) => tab.id === state.activeId) ?? null
}
