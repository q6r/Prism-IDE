import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Activity, Code2, Ellipsis, FolderOpen, MessageSquare, PanelRight, Plus, Smartphone, SmartphoneNfc, SquareTerminal } from 'lucide-react'
import { useAgentChats } from '../../lib/agentChats'
import { startRemoteControl, stopRemoteControl } from '../../lib/remoteControl'
import { useStore } from '../../store'
import { Badge, Button, DropdownMenu, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, Tooltip, cn } from '../ui'
import '../../styles/chat.css'
import AgentWorkingDirectoryDialog from './AgentWorkingDirectoryDialog'

/** Chat header: title, remote badge and the workspace actions (40px Traycer header row). */
export default function AgentHeader({ compact, monitorOpen, onToggleMonitor, onNewChat }: {
  compact: boolean
  monitorOpen: boolean
  onToggleMonitor: () => void
  onNewChat: () => void
}) {
  const chat = useAgentChats(useShallow((s) => {
    const c = s.chats.find((x) => x.id === s.activeId)
    return c ? { id: c.id, title: c.title, remoteId: c.remoteId, archived: c.archived, nativeAgent: !!c.nativeAgent } : undefined
  }))
  const activeCount = useAgentChats((s) => Object.values(s.runtime).filter(r => r.busy).length)
  const running = useAgentChats((s) => !!(chat && s.runtime[chat.id]?.busy))
  const shared = useStore((s) => !!chat && s.rcEnabledTabs.includes(chat.id))
  const [directoryChatId, setDirectoryChatId] = useState<string | null>(null)
  return <><header className={cn('ch-header', compact && 'compact')}>
    <div className="ch-header-title">
      <MessageSquare size={14} aria-hidden className="ch-header-icon" />
      <span className="ch-header-name" title={chat?.title || 'Conversas'}>{chat?.title || 'Conversas'}</span>
      {running ? <span className="ch-header-live" role="img" aria-label="Em execução" /> : null}
      {chat?.remoteId ? <Badge variant="outline" size="xs" className="ch-header-badge">SSH</Badge> : null}
      {chat && shared ? <Tooltip label="Controle remoto ativo · mostrar QR">
        <button type="button" className="ch-header-remote" aria-label="Controle remoto ativo — mostrar QR"
          onClick={() => useStore.getState().openRcModal(chat.id)}>
          <Smartphone size={12} aria-hidden />Remoto
        </button>
      </Tooltip> : null}
    </div>
    <div className="ch-header-actions">
      <Tooltip label="Monitor de agentes">
        <Button variant="muted" size="sm" className={cn('ch-header-monitor', monitorOpen && 'active')} aria-label="Monitor de agentes"
          aria-expanded={monitorOpen} onClick={onToggleMonitor}>
          <Activity aria-hidden />
          {activeCount ? <span className="ch-header-count">{activeCount} {activeCount === 1 ? 'ativo' : 'ativos'}</span> : compact ? null : <span>Agentes</span>}
        </Button>
      </Tooltip>
      <span aria-hidden className="ch-header-sep" />
      {compact ? <Tooltip label="Novo chat">
        <Button variant="muted" size="icon-sm" aria-label="Novo chat no projeto" onClick={onNewChat}><Plus aria-hidden /></Button>
      </Tooltip> : null}
      <Tooltip label="Abrir editor">
        <Button variant="muted" size={compact ? 'icon-sm' : 'sm'} aria-label="Abrir editor" onClick={() => useStore.getState().setWorkspaceView('editor')}>
          <Code2 aria-hidden />{compact ? null : <span>Editor</span>}
        </Button>
      </Tooltip>
      <Tooltip label="Terminal">
        <Button variant="muted" size="icon-sm" aria-label="Mostrar terminal" onClick={() => useStore.getState().toggleTerminal()}><SquareTerminal aria-hidden /></Button>
      </Tooltip>
      <Tooltip label="Arquivos e ferramentas">
        <Button variant="muted" size="icon-sm" aria-label="Mostrar arquivos" onClick={() => useStore.getState().toggleSidebar()}><PanelRight aria-hidden /></Button>
      </Tooltip>
      {chat && !chat.nativeAgent ? <DropdownMenu align="end" label="Ações do chat" className="ch-header-menu"
        trigger={<Button variant="muted" size="icon-sm" aria-label="Mais ações do chat"><Ellipsis aria-hidden /></Button>}>
        <DropdownMenuLabel>Chat</DropdownMenuLabel>
        <DropdownMenuItem disabled={running} onSelect={() => setDirectoryChatId(chat.id)}><FolderOpen aria-hidden />Trocar pasta de trabalho</DropdownMenuItem>
        <DropdownMenuItem disabled={!!chat.archived} onSelect={() => void startRemoteControl(chat.id)}>
          <Smartphone aria-hidden />{shared ? 'Mostrar QR do controle remoto' : 'Controle remoto'}
        </DropdownMenuItem>
        {shared ? <>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => stopRemoteControl(chat.id)}>
            <SmartphoneNfc aria-hidden />Parar controle remoto
          </DropdownMenuItem>
        </> : null}
      </DropdownMenu> : null}
    </div>
  </header>
    {directoryChatId && <AgentWorkingDirectoryDialog key={directoryChatId} chatId={directoryChatId} onClose={() => setDirectoryChatId(null)} />}
  </>
}
