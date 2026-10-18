import { useEffect, useRef } from 'react'
import '../../styles/browser.css'
import { useStore } from '../../store'
import { BrowserTabStrip } from './BrowserTabStrip'
import { BrowserToolbar } from './BrowserToolbar'
import { BrowserFindBar } from './BrowserFindBar'
import { BrowserTabView } from './BrowserTabView'
import { asGuestEvent, browserMainBridge, tabHandle, tabIdForWebContents, type BrowserChordCommand } from './browserBridge'
import { browserChordForKey, browserTabHostname, isBlankUrl, nextZoomPercent } from './browserModel'
import { activeBrowserTab, useBrowserStore } from './browserStore'

/** Runs one browser command against a tab: the keyboard and the guest's reserved chords share it. */
function runBrowserCommand(command: BrowserChordCommand, tabId: string | null): void {
  const store = useBrowserStore.getState()
  const tab = store.tabs.find((candidate) => candidate.id === tabId) ?? null
  const handle = tabHandle(tabId)
  const zoomTo = (percent: number): void => {
    if (tab === null || isBlankUrl(tab.url)) return
    store.patch(tab.id, { zoomPercent: percent })
    handle?.setZoom(percent)
  }
  if (command.startsWith('selectTab')) {
    store.activateNumber(Number(command.slice('selectTab'.length)))
    return
  }
  switch (command) {
    case 'newTab': store.openTab(); return
    case 'reopenClosedTab': store.reopenClosed(); return
    case 'nextTab': store.activateOffset(1); return
    case 'previousTab': store.activateOffset(-1); return
  }
  if (tab === null) return
  switch (command) {
    case 'closeTab': store.closeTab(tab.id); return
    case 'focusAddress': store.focusAddress(tab.id); return
    case 'find':
      if (isBlankUrl(tab.url) || tab.initialSrc === null) return
      store.setFind(tab.id, { open: true, focusNonce: tab.find.focusNonce + 1 })
      return
    case 'reload':
    case 'hardReload':
      if (handle && tab.initialSrc !== null) handle.reload(command === 'hardReload')
      else if (!isBlankUrl(tab.url)) store.navigate(tab.id, tab.url)
      return
    case 'back': handle?.back(); return
    case 'forward': handle?.forward(); return
    case 'zoomIn': zoomTo(nextZoomPercent(tab.zoomPercent, 1)); return
    case 'zoomOut': zoomTo(nextZoomPercent(tab.zoomPercent, -1)); return
    case 'zoomReset': zoomTo(100); return
    case 'devtools': handle?.toggleDevTools(); return
  }
}

/**
 * The embedded browser (Traycer's browser tile, as a workspace view): tab
 * strip, toolbar for the active tab, progress bar, the tab guests and the
 * find bar. Fills its parent as a flex column.
 *
 * `active` gates the keyboard shortcuts and the start page's polling; it
 * defaults to "the Navegador view is the one on screen", so the panel can stay
 * mounted (and its pages alive) while another view is shown.
 */
export default function BrowserPanel({ active: activeProp }: { active?: boolean } = {}) {
  const viewActive = useStore((s) => s.workspaceView === 'browser')
  const active = activeProp ?? viewActive
  const tabs = useBrowserStore((s) => s.tabs)
  const activeId = useBrowserStore((s) => s.activeId)
  const activeTab = useBrowserStore(activeBrowserTab)
  const rootRef = useRef<HTMLDivElement | null>(null)

  // Main-process events: popups become tabs, guest-claimed chords run here,
  // certificate warnings land on their tab, downloads report through toasts.
  useEffect(() => {
    const bridge = browserMainBridge()
    if (bridge === null) return
    const announced = new Set<string>()
    // One toast per key every 10 s: a page that keeps trying must not flood the toaster.
    const noticedAt = new Map<string, number>()
    const notice = (key: string, kind: 'info' | 'error', message: string): void => {
      const now = Date.now()
      if (now - (noticedAt.get(key) ?? 0) < 10_000) return
      noticedAt.set(key, now)
      useStore.getState().addToast(kind, message)
    }
    return bridge.onEvent((raw) => {
      const event = asGuestEvent(raw)
      if (event === null) return
      const store = useBrowserStore.getState()
      switch (event.type) {
        case 'open-tab': {
          const opener = tabIdForWebContents(event.webContentsId)
          if (store.openTab(event.url, { background: event.background, afterId: opener, fromPage: true }) === null) {
            notice('tabs', 'info', 'Pop-up bloqueado: há abas demais abertas. Feche algumas para continuar.')
          }
          return
        }
        case 'blocked': {
          const host = browserTabHostname(event.detail)
          if (event.kind === 'popup') notice(`popup:${event.webContentsId}`, 'info', host ? `Pop-up bloqueado de ${host}` : 'Pop-up bloqueado')
          else if (event.kind === 'download') notice(`download:${event.webContentsId}`, 'info', `Download automático bloqueado: ${event.detail}`)
          else notice(`external:${event.webContentsId}`, 'info', 'Link externo bloqueado: a página tentou abrir outro aplicativo sem um clique.')
          return
        }
        case 'chord':
          runBrowserCommand(event.command, tabIdForWebContents(event.webContentsId) ?? store.activeId)
          return
        case 'app-chord':
          // An app shortcut pressed inside a page: hand it to the app's own handlers.
          window.dispatchEvent(new KeyboardEvent('keydown', {
            key: event.key, code: event.code, ctrlKey: event.ctrlKey, metaKey: event.metaKey,
            shiftKey: event.shiftKey, altKey: event.altKey, bubbles: true, cancelable: true
          }))
          return
        case 'certificate-error': {
          const tabId = tabIdForWebContents(event.webContentsId)
          if (tabId === null) return
          const { type: _type, webContentsId: _id, ...error } = event
          store.patch(tabId, { certificateError: error, loading: false, progress: 'idle' })
          return
        }
        case 'download': {
          const toast = useStore.getState().addToast
          if (event.state === 'progressing') {
            if (!announced.has(event.id)) {
              announced.add(event.id)
              toast('info', `Baixando ${event.filename}…`)
            }
            return
          }
          announced.delete(event.id)
          if (event.state === 'completed') toast('success', `Download concluído: ${event.filename}`)
          else if (event.state === 'interrupted') toast('error', `Download interrompido: ${event.filename}`)
          else toast('info', `Download cancelado: ${event.filename}`)
        }
      }
    })
  }, [])

  // Browser shortcuts while the panel is on screen and holds the focus. Capture
  // phase, so Ctrl+W / Ctrl+L / Ctrl+Tab mean the browser here, not the editor.
  useEffect(() => {
    if (!active) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || !event.isTrusted) return
      const root = rootRef.current
      const focus = document.activeElement
      if (!root || (focus !== null && focus !== document.body && !root.contains(focus))) return
      if (document.querySelector('[aria-modal="true"]')) return
      const command = browserChordForKey({
        key: event.key, code: event.code, ctrl: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey, alt: event.altKey
      })
      if (command === null) return
      event.preventDefault()
      event.stopPropagation()
      runBrowserCommand(command, useBrowserStore.getState().activeId)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [active])

  // Arriving on a blank tab puts the caret in the address field, like a new tab.
  useEffect(() => {
    if (!active || activeId === null) return
    const tab = useBrowserStore.getState().tabs.find((candidate) => candidate.id === activeId)
    if (tab && isBlankUrl(tab.url) && tab.status !== 'failed') useBrowserStore.getState().focusAddress(activeId)
  }, [active, activeId])

  return (
    <div ref={rootRef} className="brw-panel" data-testid="browser-panel">
      <BrowserTabStrip />
      {activeTab ? <BrowserToolbar tab={activeTab} /> : null}
      <div className="brw-progress-track" aria-hidden>
        {activeTab ? <div key={activeTab.id} className="brw-progress" data-phase={activeTab.progress} /> : null}
      </div>
      <div className="brw-stage">
        {tabs.map((tab) =>
          tab.dormant ? null : <BrowserTabView key={tab.id} tab={tab} active={tab.id === activeId} panelVisible={active} />
        )}
        {activeTab ? <BrowserFindBar key={activeTab.id} tab={activeTab} /> : null}
      </div>
    </div>
  )
}
