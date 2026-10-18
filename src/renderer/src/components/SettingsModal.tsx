import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Settings, X } from 'lucide-react'
import { useStore } from '../store'
import { Button, Spinner } from './ui'
import { isSettingsSearchActive, resolveSettingsSection, type SettingsSectionId } from './settings/definitions'
import { consumeEscape } from './settings/escape'
import { trapTab, useMenuOpenAtPointerDown } from './settings/layout'
import { useSettingsAnchorReveal } from './settings/reveal'
import { SettingsSidebar } from './settings/SettingsSidebar'
import { useSettingsUi } from './settings/state'
import { AppearanceSettingsPanel } from './settings/panels/AppearanceSettingsPanel'
import { EditorSettingsPanel } from './settings/panels/EditorSettingsPanel'
import { ExtensionsSettingsPanel } from './settings/panels/ExtensionsSettingsPanel'
import { GeneralSettingsPanel } from './settings/panels/GeneralSettingsPanel'
import { NotificationsSettingsPanel } from './settings/panels/NotificationsSettingsPanel'
import { ProvidersSettingsPanel } from './settings/providers/ProvidersSettingsPanel'
import '../styles/settings.css'

// The usage dashboard (with ECharts and html-to-image) loads only when opened.
const UsageSettingsPanel = lazy(() => import('./settings/panels/UsageSettingsPanel'))

/**
 * Settings as Traycer's floating system-tab modal (promotable-modal-frame.tsx +
 * system-tab-modal-host.tsx + settings-modal-content.tsx): dimmed, blurred
 * overlay; an 80vw × 80vh frame with a title bar; the section rail beside the
 * active panel. Escape closes a nested layer first, then clears a running
 * search, and only then closes Settings.
 */
export default function SettingsModal() {
  const requested = useStore((s) => s.settingsSection)
  const setSection = useStore((s) => s.setSettingsSection)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const section = resolveSettingsSection(requested)
  const frame = useRef<HTMLDivElement>(null)
  const [pane, setPane] = useState<HTMLDivElement | null>(null)
  const downOnOverlay = useRef(false)
  const menuAtDown = useMenuOpenAtPointerDown()
  const close = (): void => setSettingsOpen(false)
  useSettingsAnchorReveal(section, pane)

  // Modal like the shell dialogs: the app behind goes inert, focus moves into
  // the frame, and both are handed back on close.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const root = document.getElementById('root')
    const wasInert = root?.inert ?? false
    if (root) root.inert = true
    frame.current?.focus({ preventScroll: true })
    return () => {
      // A shell dialog opened on top keeps the app inert until it closes itself.
      if (root) root.inert = wasInert || !!document.querySelector('.ps-shell-modal-overlay')
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [])

  // One capture-phase Escape owner, ahead of the app's own window handler.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      // A shell dialog opened over Settings (QuickOpen, palette, CloseConfirm)
      // owns its Escape; so does any other dialog the key comes from.
      if (document.querySelector('.ps-shell-modal-overlay')) return
      const target = e.target as Element | null
      const dialog = target?.closest?.('[role="dialog"], [role="alertdialog"]')
      if (dialog && !dialog.matches('.stg-frame, .stg-dialog')) return
      if (target?.closest?.('#root')) return
      // An open dropdown (theme list, profile menu, select) closes itself first.
      if (target?.closest?.('.tr-menu')) return
      e.preventDefault()
      e.stopImmediatePropagation()
      if (document.querySelector('.tr-menu')) return
      if (consumeEscape()) return
      const ui = useSettingsUi.getState()
      if (isSettingsSearchActive(ui.query)) { ui.setQuery(''); return }
      setSettingsOpen(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [setSettingsOpen])

  // The remembered section may be one this build no longer offers.
  useEffect(() => { if (requested !== section) setSection(section) }, [requested, section, setSection])

  // A scroll left over from another section never greets the next one.
  useEffect(() => { pane?.scrollTo({ top: 0 }) }, [section, pane])

  const navigate = (next: SettingsSectionId): void => setSection(next)
  return createPortal(<div className="stg-root">
    <div className="stg-overlay" aria-hidden="true"
      onPointerDown={(e) => { downOnOverlay.current = e.target === e.currentTarget && !menuAtDown.current }}
      onClick={(e) => { if (downOnOverlay.current && e.target === e.currentTarget) close(); downOnOverlay.current = false }} />
    <div ref={frame} role="dialog" aria-modal="true" aria-labelledby="settings-modal-title" tabIndex={-1} className="stg-frame"
      data-settings-modal onKeyDown={(e) => trapTab(e, frame.current)}>
      <header className="stg-frame-head">
        <Settings size={16} className="stg-frame-icon" aria-hidden="true" />
        <h2 id="settings-modal-title" className="stg-frame-title">Configurações</h2>
        <div className="stg-frame-actions">
          <Button variant="ghost" size="icon-sm" aria-label="Fechar" data-testid="system-tab-modal-close-settings" onClick={close}><X /></Button>
        </div>
      </header>
      <div className="stg-frame-body">
        <SettingsSidebar active={section} onSelect={navigate} />
        <div ref={setPane} data-settings-panel-pane className="stg-pane">
          <SettingsPanel section={section} onNavigate={navigate} />
        </div>
      </div>
    </div>
  </div>, document.body)
}

function SettingsPanel({ section, onNavigate }: { section: SettingsSectionId; onNavigate: (section: SettingsSectionId) => void }): ReactNode {
  switch (section) {
    case 'general': return <GeneralSettingsPanel onNavigate={onNavigate} />
    case 'appearance': return <AppearanceSettingsPanel />
    case 'editor': return <EditorSettingsPanel />
    case 'extensions': return <ExtensionsSettingsPanel />
    case 'providers': return <ProvidersSettingsPanel />
    case 'usage': return <Suspense fallback={<div className="stg-shell"><div className="stg-shell-desc"><Spinner tone="muted" /> Carregando uso…</div></div>}><UsageSettingsPanel /></Suspense>
    case 'notifications': return <NotificationsSettingsPanel />
  }
}
