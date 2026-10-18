import { lazy, Suspense, useEffect, useState } from 'react'
import { useStore } from './store'
import { useAgentTasks } from './lib/agentTasks'
import { isLightTheme } from './lib/appearance'
import TitleBar from './components/TitleBar'
import ActivityBar from './components/ActivityBar'
import Sidebar from './components/Sidebar'
const EditorArea = lazy(() => import('./components/EditorArea'))
const BrowserPanel = lazy(() => import('./components/browser/BrowserPanel'))
import TerminalPanel from './components/TerminalPanel'
import { useTerminalRestore } from './components/terminal/useTerminalRestore'
import AgentWorkspace from './components/AgentWorkspace'
import WorkspaceTabs from './components/shell/WorkspaceTabs'
import StatusBar from './components/StatusBar'
import CommandPalette from './components/CommandPalette'
import QuickOpen from './components/QuickOpen'
import SettingsModal from './components/SettingsModal'
import Toasts from './components/Toasts'
import CloseConfirm from './components/CloseConfirm'
import Splitter from './components/Splitter'
import PresenceBridge from './components/PresenceBridge'
import RemoteControlModal from './components/RemoteControlModal'
import RemoteControlBridge from './components/agent/RemoteControlBridge'
import ErrorBoundary from './components/ErrorBoundary'
import { DiffWorkerPoolProvider } from './components/git/DiffWorkerPoolProvider'

export default function App() {
  const workspaceView = useStore((s) => s.workspaceView)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const terminalOpen = useStore((s) => s.terminalOpen)
  const chatWidth = useStore(s=>s.settings.chatWidth)
  const chatOpen = useStore((s) => s.chatOpen)
  const paletteOpen = useStore((s) => s.paletteOpen)
  const quickOpenOpen = useStore((s) => s.quickOpenOpen)
  const settingsOpen = useStore((s) => s.settingsOpen)
  const animations = useStore((s) => s.settings.animations)
  const theme = useStore((s) => s.settings.theme)
  // The browser mounts on first visit and then stays alive while hidden, so
  // switching views never reloads its pages (Traycer keeps browser tiles alive).
  const [browserMounted, setBrowserMounted] = useState(false)
  useEffect(() => { if (workspaceView === 'browser') setBrowserMounted(true) }, [workspaceView])

  useEffect(() => {
    useStore.getState().init()
  }, [])
  // Terminals the host kept running while this window was closed come back.
  useTerminalRestore()

  // Toggle a root class that disables transitions/animations app-wide.
  useEffect(() => {
    document.documentElement.classList.toggle('no-anim', animations === false)
  }, [animations])

  // Drive the app palette from the selected theme via a [data-theme] attribute.
  // [data-appearance] lets light-vs-dark fixes target whole groups of themes.
  useEffect(() => {
    const root = document.documentElement
    root.setAttribute('data-theme', theme)
    root.setAttribute('data-appearance', isLightTheme(theme) ? 'light' : 'dark')
  }, [theme])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const s = useStore.getState()
      const mod = e.ctrlKey || e.metaKey
      const k = e.key.toLowerCase()
      if (mod && e.key === 'Tab') {
        // The browser view owns its own Ctrl+Tab (tab strip); never cycle the
        // hidden editor tabs from there.
        if (s.workspaceView === 'browser') return
        e.preventDefault()
        if(s.workspaceView === 'agents') useAgentTasks.getState().cycle(e.shiftKey ? -1 : 1)
        else s.cycleTab(e.shiftKey ? -1 : 1)
      } else if (mod && e.shiftKey && k === 'n') {
        e.preventDefault()
        window.prism.window.newWindow()
      } else if (mod && e.shiftKey && k === 'f') {
        e.preventDefault()
        s.setSidebarView('search')
      } else if (mod && e.shiftKey && k === 'g') {
        e.preventDefault()
        s.setSidebarView('git')
      } else if (mod && e.shiftKey && k === 'p') {
        e.preventDefault()
        s.togglePalette()
      } else if (mod && !e.shiftKey && k === 'p') {
        e.preventDefault()
        s.toggleQuickOpen()
      } else if (mod && !e.shiftKey && k === 's') {
        e.preventDefault()
        s.saveActive()
      } else if (mod && k === 'w') {
        // The browser view handles its own Ctrl+W; elsewhere only the visible
        // editor closes a tab (never a hidden one from the chat view).
        if (s.workspaceView === 'browser') return
        e.preventDefault()
        if (s.workspaceView === 'editor' && s.activePath) s.requestCloseTab(s.activePath)
      } else if (mod && e.key === '`') {
        e.preventDefault()
        s.toggleTerminal()
      } else if (mod && k === 'b') {
        e.preventDefault()
        s.toggleSidebar()
      } else if (mod && k === 'l') {
        e.preventDefault()
        s.setWorkspaceView('agents')
        requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('[data-composer-shell] textarea')?.focus())
      } else if (mod && e.key === ',') {
        e.preventDefault()
        s.setSettingsOpen(true)
      } else if (mod && k === 'o') {
        e.preventDefault()
        s.openFolderDialog()
      } else if (e.key === 'Escape') {
        if (s.paletteOpen) s.togglePalette()
        if (s.quickOpenOpen) s.toggleQuickOpen()
        if (s.settingsOpen) s.setSettingsOpen(false)
        if (s.pendingClose) s.cancelClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    // One diff worker pool for the app's lifetime, shared by the editor's diff
    // tabs and the chat's inline diffs.
    <DiffWorkerPoolProvider>
    <div className="app ps-shell-app">
      <TitleBar />
      <WorkspaceTabs />
      <div className="body ps-shell-body">
        <ActivityBar />
        {sidebarOpen && workspaceView !== 'agents' && (
          <>
            <ErrorBoundary label="a barra lateral">
              <Sidebar />
            </ErrorBoundary>
            <Splitter layoutKey="sidebarWidth" axis="x" side="right" min={170} max={520} />
          </>
        )}
        <div className="center ps-shell-center">
          {workspaceView === 'agents' && <div className="agent-region"><ErrorBoundary label="as conversas"><AgentWorkspace /></ErrorBoundary></div>}
          <div className="editor-region" style={{ display: workspaceView === 'editor' ? 'flex' : 'none' }}>
            <ErrorBoundary label="o editor">
              {workspaceView === 'editor' && <Suspense fallback={<div className="editor-loading" role="status">Abrindo editor…</div>}><EditorArea /></Suspense>}
            </ErrorBoundary>
          </div>
          {browserMounted && <div className="browser-region" style={{ display: workspaceView === 'browser' ? 'flex' : 'none', flex: 1, minHeight: 0, minWidth: 0, flexDirection: 'column' }}>
            <ErrorBoundary label="o navegador">
              <Suspense fallback={<div className="editor-loading" role="status">Abrindo navegador…</div>}><BrowserPanel /></Suspense>
            </ErrorBoundary>
          </div>}
          {terminalOpen && (
            <>
              <Splitter layoutKey="terminalHeight" axis="y" side="top" min={120} max={640} />
              <ErrorBoundary label="o terminal">
                <TerminalPanel />
              </ErrorBoundary>
            </>
          )}
        </div>
        {chatOpen && workspaceView === 'editor' && (
          <>
            <Splitter layoutKey="chatWidth" axis="x" side="left" min={300} max={680} />
            <ErrorBoundary label="o chat">
              <div className="agent-editor-dock" style={{width:chatWidth}}><AgentWorkspace compact /></div>
            </ErrorBoundary>
          </>
        )}
        {sidebarOpen && workspaceView === 'agents' && <><Splitter layoutKey="sidebarWidth" axis="x" side="left" min={170} max={420} /><ErrorBoundary label="os arquivos"><Sidebar /></ErrorBoundary></>}
      </div>
      <StatusBar />
      {paletteOpen && <CommandPalette />}
      {quickOpenOpen && <QuickOpen />}
      {settingsOpen && <SettingsModal />}
      <RemoteControlModal />
      {/* Here, not in AgentWorkspace: the phone keeps getting updates and
          answers while the agents view is unmounted. */}
      <RemoteControlBridge />
      <CloseConfirm />
      <Toasts />
      <PresenceBridge />
    </div>
    </DiffWorkerPoolProvider>
  )
}
