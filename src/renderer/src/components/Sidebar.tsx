import { useStore } from '../store'
import Explorer from './Explorer'
import ExtensionsPanel from './ExtensionsPanel'
import SearchPanel from './SearchPanel'
import GitPanel from './GitPanel'
import SessionsPanel from './SessionsPanel'
import RemotePanel from './RemotePanel'
import '../styles/shell.css'

export default function Sidebar() {
  const view = useStore((s) => s.sidebarView)
  const width = useStore((s) => s.settings.sidebarWidth)
  const workspace = useStore((s) => s.workspaceView)

  return (
    <aside className="ps-shell-sidebar" data-side={workspace === 'agents' ? 'right' : 'left'} style={{ width }} aria-label="Painel lateral">
      {view === 'explorer' && <Explorer />}
      {view === 'search' && <SearchPanel />}
      {view === 'git' && <GitPanel />}
      {view === 'sessions' && <SessionsPanel />}
      {view === 'remote' && <RemotePanel />}
      {view === 'extensions' && <ExtensionsPanel />}
    </aside>
  )
}
