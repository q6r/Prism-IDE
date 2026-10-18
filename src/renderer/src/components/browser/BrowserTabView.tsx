import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import { Button, Spinner, cn } from '../ui'
import { BrowserStartPage } from './BrowserStartPage'
import { BrowserContextMenu, type ContextMenuEntry, type ContextMenuRequest } from './BrowserContextMenu'
import {
  BROWSER_PARTITION, browserMainBridge, openExternalUrl, registerTabHandle,
  type BrowserCertificateError, type BrowserTabHandle, type WebviewElement
} from './browserBridge'
import {
  BLANK_URL, BROWSER_SEARCH_ENGINE_LABELS, navigationPolicy, browserSearchUrl, browserTabFaviconUrl, browserTabOrigin, crashReasonLabel, isBlankUrl,
  isIgnorableLoadError, loadErrorLabel, parseHttpUrl, resolveOverlay, type OverlaySurface
} from './browserModel'
import { useBrowserStore, type BrowserTab } from './browserStore'

/** A `loading` that has not settled this long, on a tab with no page yet, is stalled. */
const NAVIGATION_STALL_TIMEOUT_MS = 30_000

/** Closes every open kit menu: a click into the guest never reaches the host document. */
function dismissHostMenus(): void {
  document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
}

interface WebviewEventMap {
  'did-attach': Event
  'dom-ready': Event
  'did-start-loading': Event
  'did-stop-loading': Event
  'did-start-navigation': Event & { url: string; isInPlace: boolean; isMainFrame: boolean }
  'did-navigate': Event & { url: string }
  'did-navigate-in-page': Event & { url: string; isMainFrame: boolean }
  'did-fail-load': Event & { errorCode: number; errorDescription: string; validatedURL: string; isMainFrame: boolean }
  'page-title-updated': Event & { title: string }
  'page-favicon-updated': Event & { favicons: string[] }
  'render-process-gone': Event & { details: { reason: string; exitCode: number } }
  'found-in-page': Event & { result: { requestId: number; activeMatchOrdinal: number; matches: number; finalUpdate: boolean } }
  'update-target-url': Event & { url: string }
  'context-menu': Event & { params: WebviewContextMenuParams }
  focus: Event
}

interface WebviewContextMenuParams {
  x: number
  y: number
  linkURL: string
  srcURL: string
  mediaType: string
  isEditable: boolean
  selectionText: string
  editFlags: { canCut: boolean; canCopy: boolean; canPaste: boolean; canSelectAll: boolean }
}

function listen<K extends keyof WebviewEventMap>(el: WebviewElement, type: K, listener: (event: WebviewEventMap[K]) => void): () => void {
  const wrapped = listener as unknown as EventListener
  el.addEventListener(type, wrapped)
  return () => el.removeEventListener(type, wrapped)
}

/** Guest calls throw until the guest is attached and dom-ready; none of them matter enough to surface. */
function safely<T>(run: () => T, fallback: T): T {
  try {
    return run()
  } catch {
    return fallback
  }
}

function copyText(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => undefined)
}

/**
 * One browser tab: its <webview> guest (created on the first real address and
 * kept alive while the tab is open, hidden when inactive), the start page for a
 * blank tab, Traycer's loader / "did not load" / "unavailable" panels, the
 * certificate interstitial, the hovered-link bubble and the page's context menu.
 */
export const BrowserTabView = memo(function BrowserTabView({ tab, active, panelVisible }: { tab: BrowserTab; active: boolean; panelVisible: boolean }) {
  const [webview, setWebview] = useState<WebviewElement | null>(null)
  const [menu, setMenu] = useState<ContextMenuRequest | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [stalledAttempt, setStalledAttempt] = useState<number | null>(null)
  const webContentsIdRef = useRef<number | null>(null)
  const readyRef = useRef(false)
  const tabId = tab.id
  const patch = useBrowserStore((s) => s.patch)
  // A failure (even one refused before any guest existed) wins over the start page.
  const showStartPage = isBlankUrl(tab.url) && tab.status !== 'failed' && tab.status !== 'crashed'
  const setWebviewRef = useCallback((el: HTMLElement | null) => setWebview(el as WebviewElement | null), [])

  // Publish the imperative handle the toolbar, find bar and shortcuts drive.
  useEffect(() => {
    if (webview === null) return
    readyRef.current = false
    webContentsIdRef.current = null
    const current = (): BrowserTab | undefined => useBrowserStore.getState().tabs.find((candidate) => candidate.id === tabId)
    const handle: BrowserTabHandle = {
      webview: () => webview,
      webContentsId: () => webContentsIdRef.current,
      navigate: (url) => {
        // The guest only ever loads http(s) or the blank start page; anything
        // else (file:, javascript:, data:...) is refused here, whoever asked.
        const policy = navigationPolicy(url)
        if (policy.kind !== 'navigate' && policy.kind !== 'blank') return
        patch(tabId, { error: null, crashReason: null, certificateError: null })
        void webview.loadURL(policy.kind === 'blank' ? BLANK_URL : policy.url).catch(() => undefined)
      },
      back: () => safely(() => webview.goBack(), undefined),
      forward: () => safely(() => webview.goForward(), undefined),
      reload: (ignoreCache) => {
        const tab = current()
        if (tab?.status === 'failed' && tab.error) {
          // A failed address goes back through the navigation policy, so a
          // refused file: or javascript: address stays refused on F5.
          useBrowserStore.getState().navigate(tabId, tab.error.url)
          return
        }
        patch(tabId, { certificateError: null })
        safely(() => (ignoreCache ? webview.reloadIgnoringCache() : webview.reload()), undefined)
      },
      stop: () => safely(() => webview.stop(), undefined),
      setZoom: (percent) => {
        if (readyRef.current) safely(() => webview.setZoomFactor(percent / 100), undefined)
      },
      find: (query, options) => {
        if (readyRef.current) safely(() => webview.findInPage(query, options), 0)
      },
      stopFind: () => {
        if (readyRef.current) safely(() => webview.stopFindInPage('clearSelection'), undefined)
      },
      toggleDevTools: () => {
        if (!readyRef.current) return
        safely(() => (webview.isDevToolsOpened() ? webview.closeDevTools() : webview.openDevTools()), undefined)
      },
      focusPage: () => webview.focus()
    }
    return registerTabHandle(tabId, handle)
  }, [patch, tabId, webview])

  // Guest events → tab state.
  useEffect(() => {
    if (webview === null) return
    const navState = (): Partial<BrowserTab> => ({
      canGoBack: safely(() => webview.canGoBack(), false),
      canGoForward: safely(() => webview.canGoForward(), false)
    })
    const offs = [
      listen(webview, 'did-attach', () => {
        webContentsIdRef.current = safely(() => webview.getWebContentsId(), null)
      }),
      listen(webview, 'dom-ready', () => {
        readyRef.current = true
        if (webContentsIdRef.current === null) webContentsIdRef.current = safely(() => webview.getWebContentsId(), null)
        const zoom = useBrowserStore.getState().tabs.find((t) => t.id === tabId)?.zoomPercent ?? 100
        safely(() => webview.setZoomFactor(zoom / 100), undefined)
        patch(tabId, (tab) => ({ progress: tab.loading ? 'dom' : tab.progress }))
      }),
      listen(webview, 'did-start-loading', () => {
        setAttempt((n) => n + 1)
        patch(tabId, (tab) => ({ loading: true, progress: 'start', status: tab.status === 'failed' || tab.status === 'crashed' ? tab.status : 'loading' }))
      }),
      listen(webview, 'did-start-navigation', (event) => {
        if (!event.isMainFrame || event.isInPlace) return
        patch(tabId, { status: 'loading', error: null, certificateError: null })
      }),
      listen(webview, 'did-navigate', (event) => {
        patch(tabId, (tab) => ({
          url: event.url,
          committed: true,
          progress: tab.loading ? 'commit' : tab.progress,
          // A new origin has no title yet and starts from its /favicon.ico (Traycer's
          // fallback) until the page names its own; same-origin keeps both until replaced.
          ...(browserTabOrigin(event.url) !== browserTabOrigin(tab.url) ? { faviconUrl: browserTabFaviconUrl(event.url), title: '' } : {}),
          ...navState()
        }))
      }),
      listen(webview, 'did-navigate-in-page', (event) => {
        if (!event.isMainFrame) return
        patch(tabId, { url: event.url, ...navState() })
      }),
      listen(webview, 'did-fail-load', (event) => {
        if (!event.isMainFrame || isIgnorableLoadError(event.errorCode)) return
        patch(tabId, (tab) => ({
          status: 'failed',
          loading: false,
          progress: 'idle',
          url: event.validatedURL || tab.url,
          error: { code: event.errorCode, description: event.errorDescription, url: event.validatedURL || tab.url },
          ...navState()
        }))
      }),
      listen(webview, 'did-stop-loading', () => {
        const title = safely(() => webview.getTitle(), '')
        patch(tabId, (tab) => ({
          loading: false,
          progress: tab.progress === 'idle' ? 'idle' : 'done',
          status: tab.status === 'loading' ? 'ready' : tab.status,
          title: tab.title || title,
          ...navState()
        }))
      }),
      listen(webview, 'page-title-updated', (event) => patch(tabId, { title: event.title })),
      listen(webview, 'page-favicon-updated', (event) => {
        const icon = event.favicons.find((url) => parseHttpUrl(url) !== null || url.startsWith('data:image/'))
        if (icon) patch(tabId, { faviconUrl: icon })
      }),
      listen(webview, 'render-process-gone', (event) => {
        if (event.details.reason === 'clean-exit') return
        readyRef.current = false
        patch(tabId, { status: 'crashed', crashReason: event.details.reason, loading: false, progress: 'idle' })
      }),
      listen(webview, 'found-in-page', (event) => {
        const { activeMatchOrdinal, matches, finalUpdate } = event.result
        useBrowserStore.getState().setFind(tabId, { current: activeMatchOrdinal, total: matches, searching: !finalUpdate })
      }),
      listen(webview, 'update-target-url', (event) => patch(tabId, { hoverUrl: event.url })),
      listen(webview, 'focus', () => dismissHostMenus())
    ]
    return () => offs.forEach((off) => off())
  }, [patch, tabId, webview])

  // The page's own right-click menu, built here so it reads like the rest of the app.
  useEffect(() => {
    if (webview === null) return
    return listen(webview, 'context-menu', (event) => {
      const params = event.params
      const rect = webview.getBoundingClientRect()
      setMenu({ x: rect.left + params.x, y: rect.top + params.y, entries: pageMenuEntries(tabId, webview, params) })
    })
  }, [tabId, webview])

  // Deterministic stall: a loading episode with no committed page that does not
  // settle in time resolves to the retry surface instead of spinning forever.
  useEffect(() => {
    if (tab.status !== 'loading' || tab.committed) return
    const timer = setTimeout(() => setStalledAttempt(attempt), NAVIGATION_STALL_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [attempt, tab.committed, tab.status])

  // The bar finishes, then collapses back to nothing.
  useEffect(() => {
    if (tab.progress !== 'done') return
    const timer = setTimeout(() => patch(tabId, (t) => (t.progress === 'done' ? { progress: 'idle' } : {})), 450)
    return () => clearTimeout(timer)
  }, [patch, tab.progress, tabId])

  const stalled = tab.status === 'loading' && stalledAttempt === attempt
  const overlay: OverlaySurface = tab.initialSrc === null && !showStartPage && tab.status !== 'failed' ? 'none' : resolveOverlay(tab.status, tab.committed, stalled)
  const store = useBrowserStore.getState
  const retry = (): void => {
    setStalledAttempt(null)
    const target = tab.error?.url ?? tab.initialSrc ?? tab.url
    store().navigate(tabId, target)
  }

  return (
    <div className={cn('brw-view', active && 'active')} data-testid={`browser-view-${tabId}`} aria-hidden={!active}>
      {tab.initialSrc === null ? null : (
        <webview
          key={tab.mountKey}
          ref={setWebviewRef}
          className="brw-webview"
          partition={BROWSER_PARTITION}
          src={tab.initialSrc}
          // Popups route through main's window-open handler into new tabs; without
          // the bridge (main not wired yet) they stay blocked, as by default.
          {...(browserMainBridge() === null ? {} : ({ allowpopups: 'true' } as unknown as Record<string, boolean>))}
        />
      )}
      {showStartPage ? (
        <div className="brw-layer">
          <BrowserStartPage visible={active && panelVisible} onNavigate={(url) => store().navigate(tabId, url)} />
        </div>
      ) : null}
      {overlay === 'none' || showStartPage ? null : (
        <div className={cn('brw-overlay', overlay)} role={overlay === 'loading' ? 'status' : 'alert'} aria-live={overlay === 'loading' ? 'polite' : 'assertive'} aria-busy={overlay === 'loading'}>
          <BrowserOverlayContent surface={overlay} tab={tab} onRetry={retry} onReopen={() => store().recover(tabId)} />
        </div>
      )}
      <BrowserCertificateInterstitial
        error={tab.certificateError}
        onProceed={() => {
          void store().proceedCertificate(tabId).catch(() => undefined)
        }}
      />
      {active && tab.hoverUrl && !showStartPage ? <div className="brw-status-bubble" aria-hidden>{tab.hoverUrl}</div> : null}
      <BrowserContextMenu request={active ? menu : null} onClose={() => setMenu(null)} />
    </div>
  )
})

function BrowserOverlayContent({ surface, tab, onRetry, onReopen }: { surface: OverlaySurface; tab: BrowserTab; onRetry: () => void; onReopen: () => void }) {
  if (surface === 'crashed') {
    return (
      <>
        <div className="brw-overlay-title">Navegador indisponível</div>
        <div className="brw-overlay-reason">
          <span>{crashReasonLabel(tab.crashReason ?? '')}</span>
          <span>Reabrir a aba inicia uma nova visualização da mesma página.</span>
        </div>
        <Button variant="outline" size="sm" onClick={onReopen}>Reabrir aba</Button>
      </>
    )
  }
  if (surface === 'failed' || surface === 'stalled') {
    const error = surface === 'failed' ? tab.error : null
    return (
      <>
        <div className="brw-overlay-title">Esta página não carregou</div>
        <div className="brw-overlay-reason">
          {error === null ? null : <span>{error.code === 0 ? error.description : loadErrorLabel(error.code)}</span>}
          {error === null || error.code === 0 ? null : <span className="brw-overlay-code">{error.description || `ERR ${error.code}`}</span>}
          {error?.url && !isBlankUrl(error.url) ? <span className="brw-overlay-url">{error.url}</span> : null}
        </div>
        {error?.code === 0 ? null : <Button variant="outline" size="sm" onClick={onRetry}>Tentar novamente</Button>}
      </>
    )
  }
  return (
    <>
      <Spinner className="brw-overlay-spinner" />
      <div className="brw-overlay-title">Carregando</div>
    </>
  )
}

/** Traycer's BrowserTileCertificateInterstitial. */
function BrowserCertificateInterstitial({ error, onProceed }: { error: BrowserCertificateError | null; onProceed: () => void }) {
  const [proceeding, setProceeding] = useState(false)
  if (error === null) return null
  return (
    <div className="brw-cert">
      <div className="brw-cert-card" role="alertdialog" aria-labelledby="brw-cert-title">
        <div className="brw-cert-head">
          <ShieldAlert className="brw-cert-icon" aria-hidden />
          <div className="brw-cert-text">
            <div id="brw-cert-title" className="brw-cert-title">Aviso de certificado para {error.hostname}</div>
            <div className="brw-cert-error">{error.error}</div>
          </div>
        </div>
        <dl className="brw-cert-details">
          <div><dt>Assunto</dt><dd className="tr-truncate">{error.subject}</dd></div>
          <div><dt>Emissor</dt><dd className="tr-truncate">{error.issuer}</dd></div>
          <div><dt>SHA-256</dt><dd className="mono">{error.fingerprint}</dd></div>
        </dl>
        <div className="brw-cert-actions">
          <Button variant="destructive" size="sm" disabled={proceeding} onClick={() => { setProceeding(true); onProceed() }}>
            Prosseguir para esta origem
          </Button>
        </div>
      </div>
    </div>
  )
}

function pageMenuEntries(tabId: string, webview: WebviewElement, params: WebviewContextMenuParams): ContextMenuEntry[] {
  const store = useBrowserStore.getState()
  const entries: ContextMenuEntry[] = []
  const openInTab = (url: string): void => { void store.openTab(url, { background: true, afterId: tabId }) }
  if (params.linkURL && parseHttpUrl(params.linkURL) !== null) {
    entries.push(
      { kind: 'item', label: 'Abrir link em nova aba', onSelect: () => openInTab(params.linkURL) },
      { kind: 'item', label: 'Abrir link no navegador padrão', onSelect: () => openExternalUrl(params.linkURL) },
      { kind: 'item', label: 'Copiar endereço do link', onSelect: () => copyText(params.linkURL) },
      { kind: 'separator' }
    )
  }
  if (params.mediaType === 'image' && params.srcURL) {
    if (parseHttpUrl(params.srcURL) !== null) entries.push({ kind: 'item', label: 'Abrir imagem em nova aba', onSelect: () => openInTab(params.srcURL) })
    entries.push({ kind: 'item', label: 'Copiar endereço da imagem', onSelect: () => copyText(params.srcURL) }, { kind: 'separator' })
  }
  if (params.isEditable) {
    entries.push(
      { kind: 'item', label: 'Recortar', shortcut: 'Ctrl+X', disabled: !params.editFlags.canCut, onSelect: () => safely(() => webview.cut(), undefined) },
      { kind: 'item', label: 'Copiar', shortcut: 'Ctrl+C', disabled: !params.editFlags.canCopy, onSelect: () => safely(() => webview.copy(), undefined) },
      { kind: 'item', label: 'Colar', shortcut: 'Ctrl+V', disabled: !params.editFlags.canPaste, onSelect: () => safely(() => webview.paste(), undefined) },
      { kind: 'item', label: 'Selecionar tudo', shortcut: 'Ctrl+A', disabled: !params.editFlags.canSelectAll, onSelect: () => safely(() => webview.selectAll(), undefined) },
      { kind: 'separator' }
    )
  } else if (params.selectionText.trim()) {
    const selection = params.selectionText.trim()
    const short = selection.length > 24 ? `${selection.slice(0, 24)}…` : selection
    entries.push(
      { kind: 'item', label: 'Copiar', shortcut: 'Ctrl+C', onSelect: () => safely(() => webview.copy(), undefined) },
      { kind: 'item', label: `Pesquisar “${short}” no ${BROWSER_SEARCH_ENGINE_LABELS[store.searchEngine]}`, onSelect: () => openInTab(browserSearchUrl(selection, store.searchEngine)) },
      { kind: 'separator' }
    )
  }
  entries.push(
    { kind: 'item', label: 'Voltar', shortcut: 'Alt+←', disabled: !safely(() => webview.canGoBack(), false), onSelect: () => safely(() => webview.goBack(), undefined) },
    { kind: 'item', label: 'Avançar', shortcut: 'Alt+→', disabled: !safely(() => webview.canGoForward(), false), onSelect: () => safely(() => webview.goForward(), undefined) },
    { kind: 'item', label: 'Recarregar', shortcut: 'Ctrl+R', onSelect: () => safely(() => webview.reload(), undefined) },
    { kind: 'separator' },
    { kind: 'item', label: 'Inspecionar', onSelect: () => safely(() => webview.inspectElement(params.x, params.y), undefined) }
  )
  return entries
}
