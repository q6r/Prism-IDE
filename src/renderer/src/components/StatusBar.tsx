import { useEffect, useState } from 'react'
import { Sparkles, FolderGit2, WrapText, Clock3, Server, GitBranch } from 'lucide-react'
import { FaDiscord } from 'react-icons/fa6'
import { useStore } from '../store'
import { useAgentChats } from '../lib/agentChats'
import { runEditorAction } from '../lib/editorRef'
import useGitSummary from './shell/useGitSummary'
import '../styles/shell.css'

function StatusClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15000)
    return () => clearInterval(t)
  }, [])
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  return (
    <span className="ps-shell-status-item ps-shell-status-clock" title="Hora">
      <Clock3 size={12} /> {hh}:{mm}
    </span>
  )
}

type HostStatus = ReturnType<typeof window.prism.host.status>

const HOST_LABEL: Record<HostStatus['state'], string> = {
  idle: '', connecting: 'Host…', reconnecting: 'Host…', connected: 'Host',
  unavailable: 'Sem host', incompatible: 'Host incompatível', unauthorized: 'Host recusou'
}

/** The Prism host (Rust backend) connection; the app works without it. */
function HostIndicator() {
  const [status, setStatus] = useState<HostStatus>(() => window.prism.host.status())
  useEffect(() => window.prism.host.onStatus(setStatus), [])
  if (status.state === 'idle') return null
  const tip = status.state === 'connected' && status.hello
    ? `Host do Prism conectado · ${status.hello.hostName} · v${status.hello.version}`
    : status.state === 'unavailable'
      ? 'O host do Prism não está disponível; o app segue funcionando sem ele.'
      : status.error ?? 'Conectando ao host do Prism…'
  return <span className={`ps-shell-status-item ps-shell-status-host hs-${status.state}`} title={tip} role="status">{HOST_LABEL[status.state]}</span>
}

const DISCORD_TIP: Record<string, string> = {
  connected: 'Discord Rich Presence: conectado',
  connecting: 'Discord Rich Presence: conectando…',
  offline: 'Discord Rich Presence: Discord fechado?',
  disabled: 'Ativar Discord Rich Presence'
}

export default function StatusBar() {
  const branch = useGitSummary()
  const folderName = useStore((s) => s.folderName)
  const tabs = useStore((s) => s.tabs)
  const activePath = useStore((s) => s.activePath)
  const cursor = useStore((s) => s.cursor)
  const settings = useStore((s) => s.settings)
  const workspaceView = useStore((s) => s.workspaceView)
  const chat = useAgentChats((s) => s.chats.find((c) => c.id === s.activeId))
  const agentLabel = workspaceView === 'agents' && chat
    ? `${chat.selection.provider === 'claude' ? 'Claude' : 'Codex'} · ${chat.selection.model || 'Modelo padrão'}`
    : settings.model
  const toggleWordWrap = useStore((s) => s.toggleWordWrap)
  const discord = useStore((s) => s.extensions.find((e) => e.id === 'discord-presence'))
  const setExtEnabled = useStore((s) => s.setExtEnabled)
  const remote = useStore((s) => s.remote)
  const disconnectRemote = useStore((s) => s.disconnectRemote)
  const active = tabs.find((t) => t.path === activePath)

  return (
    <div className="ps-shell-statusbar">
      <div className="ps-shell-status-left">
        {remote && (
          <button
            className="ps-shell-status-item ps-shell-status-remote"
            title={`Conectado a ${remote.host} — clique para desconectar`}
            onClick={disconnectRemote}
          >
            <Server size={12} /> SSH: {remote.name}
          </button>
        )}
        <span className="ps-shell-status-item ps-shell-status-accent">
          <FolderGit2 size={12} /> {folderName || 'Sem pasta'}
        </span>
        {branch && <button className="ps-shell-status-item ps-shell-status-btn" title="Abrir controle de versão" onClick={() => useStore.getState().setSidebarView('git')}><GitBranch size={12} />{branch}</button>}
      </div>
      <div className="ps-shell-status-right">
        {active && (
          <button
            className="ps-shell-status-item ps-shell-status-btn"
            onClick={() => runEditorAction('editor.action.gotoLine')}
            title="Ir para linha"
          >
            Ln {cursor.line}, Col {cursor.col}
          </button>
        )}
        {active && <span className="ps-shell-status-item">{active.language}</span>}
        <button
          className={'ps-shell-status-item ps-shell-status-btn' + (settings.wordWrap ? ' on' : '')}
          onClick={() => toggleWordWrap()}
          title="Quebra de linha"
        >
          <WrapText size={12} /> {settings.wordWrap ? 'Quebra de linha' : 'Sem quebra'}
        </button>
        <span className="ps-shell-status-item">Espaços: {settings.tabSize}</span>
        {discord && (
          <button
            className={
              'ps-shell-status-item ps-shell-status-btn ps-shell-status-discord ' +
              (discord.enabled ? 'st-' + discord.status : 'off')
            }
            title={discord.enabled ? DISCORD_TIP[discord.status] ?? 'Discord' : DISCORD_TIP.disabled}
            onClick={() => setExtEnabled('discord-presence', !discord.enabled)}
          >
            <FaDiscord size={12} /> Discord
          </button>
        )}
        <span className="ps-shell-status-item ps-shell-status-model" title="Modelo de IA ativo">
          <Sparkles size={12} /> {agentLabel}
        </span>
        <HostIndicator />
        <StatusClock />
      </div>
    </div>
  )
}
