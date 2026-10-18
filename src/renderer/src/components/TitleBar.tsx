import { useEffect, useState } from 'react'
import { Minus, Square, X, Copy, History, Settings } from 'lucide-react'
import { useStore } from '../store'
import { Button, Tooltip } from './ui'
import MenuBar from './MenuBar'
import TaskTabs from './TaskTabs'
import NotificationsMenu from './shell/NotificationsMenu'
import UsageMenu from './shell/UsageMenu'
import '../styles/shell.css'

export default function TitleBar() {
  const [maximized, setMaximized] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [usageOpen, setUsageOpen] = useState(false)
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const overlayOpen = menuOpen || usageOpen || notificationsOpen
  useEffect(() => {
    let alive = true
    window.prism.window.isMaximized().then((value) => { if (alive) setMaximized(value) })
    const off = window.prism.window.onMaximizeChange(setMaximized)
    return () => { alive = false; off() }
  }, [])
  return <header className="ps-shell-titlebar" data-suppressed={overlayOpen} aria-label="Barra de título">
    <MenuBar onOpenChange={setMenuOpen} />
    <div className="ps-shell-drag-gap" data-suppressed={overlayOpen} aria-hidden="true" />
    <div className="ps-shell-task-tabs"><TaskTabs /></div>
    <div className="ps-shell-drag-gap" data-suppressed={overlayOpen} aria-hidden="true" />
    <div className="ps-shell-header-actions">
      <UsageMenu onOpenChange={setUsageOpen} />
      <Tooltip label="Histórico" side="bottom"><Button variant="muted" size="icon-sm" aria-label="Histórico" onClick={() => {
        const s = useStore.getState()
        if (s.sidebarView !== 'sessions' || !s.sidebarOpen) s.setSidebarView('sessions')
      }}><History size={16} /></Button></Tooltip>
      <NotificationsMenu onOpenChange={setNotificationsOpen} />
      <Tooltip label="Configurações (Ctrl+,)" side="bottom"><Button variant="muted" size="icon-sm" aria-label="Configurações" onClick={() => useStore.getState().openSettings()}><Settings size={16} /></Button></Tooltip>
    </div>
    <div className="ps-shell-window-controls">
      <button type="button" aria-label="Minimizar" title="Minimizar" onClick={() => window.prism.window.minimize()}><Minus size={15} /></button>
      <button type="button" aria-label={maximized ? 'Restaurar janela' : 'Maximizar'} title={maximized ? 'Restaurar janela' : 'Maximizar'} onClick={() => window.prism.window.toggleMaximize()}>{maximized ? <Copy size={12} /> : <Square size={11} />}</button>
      <button type="button" className="ps-shell-window-close" aria-label="Fechar" title="Fechar" onClick={() => window.prism.window.close()}><X size={16} /></button>
    </div>
  </header>
}
