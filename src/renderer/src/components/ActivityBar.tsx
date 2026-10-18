import { Files, Search, GitBranch, Settings, Blocks, History, MessageSquare, type LucideIcon } from 'lucide-react'
import { useStore } from '../store'
import { useAgentChats } from '../lib/agentChats'
import { Tooltip, cn } from './ui'
import SshIcon from './SshIcon'
import '../styles/shell.css'

function Item({ icon: Icon, label, active, onClick, badge }: { icon: LucideIcon | typeof SshIcon; label: string; active: boolean; onClick: () => void; badge?: number }) {
  return <Tooltip label={label} side="right"><button type="button" className={cn('ps-shell-rail-item', active && 'is-active')} aria-label={label} aria-pressed={active} onClick={onClick}>
    <Icon size={20} />{badge ? <span className="ps-shell-rail-badge">{badge > 99 ? '99+' : badge}</span> : null}
  </button></Tooltip>
}
export default function ActivityBar() {
  const view = useStore((s) => s.sidebarView)
  const open = useStore((s) => s.sidebarOpen)
  const workspace = useStore((s) => s.workspaceView)
  const setView = useStore((s) => s.setSidebarView)
  const remote = useStore((s) => s.remote)
  const pending = useAgentChats((s) => Object.values(s.runtime).filter((r) => r.permission || r.question).length)
  return <nav className="ps-shell-rail" aria-label="Navegação do workspace">
    <div className="ps-shell-rail-group">
      <Item icon={MessageSquare} label="Conversas (Ctrl+L)" active={workspace === 'agents'} onClick={() => useStore.getState().setWorkspaceView('agents')} badge={pending} />
      <div className="ps-shell-rail-divider" />
      <Item icon={Files} label="Explorador (Ctrl+B)" active={open && view === 'explorer'} onClick={() => setView('explorer')} />
      <Item icon={Search} label="Buscar (Ctrl+Shift+F)" active={open && view === 'search'} onClick={() => setView('search')} />
      <Item icon={GitBranch} label="Controle de versão (Ctrl+Shift+G)" active={open && view === 'git'} onClick={() => setView('git')} />
      <Item icon={History} label="Histórico de sessões" active={open && view === 'sessions'} onClick={() => setView('sessions')} />
      <Item icon={SshIcon} label={remote ? `Remoto · ${remote.name}` : 'Remoto · SSH'} active={open && view === 'remote'} onClick={() => setView('remote')} />
      <Item icon={Blocks} label="Extensões" active={open && view === 'extensions'} onClick={() => setView('extensions')} />
    </div>
    <div className="ps-shell-rail-group"><Item icon={Settings} label="Configurações (Ctrl+,)" active={false} onClick={() => useStore.getState().openSettings()} /></div>
  </nav>
}
