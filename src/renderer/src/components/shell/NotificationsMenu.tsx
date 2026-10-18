import { Bell, BellOff, MessageSquare, Trash2 } from 'lucide-react'
import { useMemo } from 'react'
import { useStore } from '../../store'
import { useAgentChats } from '../../lib/agentChats'
import { Button, DropdownMenu, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from '../ui'
import { attentionKey, type AttentionItem } from './logic'

export default function NotificationsMenu({ onOpenChange }: { onOpenChange?: (open: boolean) => void }) {
  const toasts = useStore((s) => s.toasts)
  const key = useAgentChats((s) => attentionKey(s.chats, s.runtime))
  const pending = useMemo(() => JSON.parse(key) as AttentionItem[], [key])
  const count = toasts.length + pending.length
  return <DropdownMenu onOpenChange={onOpenChange} align="end" label="Notificações" className="ps-shell-notifications" trigger={
    <Button variant="muted" size="icon-sm" className="ps-shell-bell" title="Notificações" aria-label={count ? `Notificações, ${count} pendentes` : 'Notificações'}><Bell size={16} />{count > 0 && <i className="ps-shell-notification-dot" />}</Button>
  }>
    <DropdownMenuLabel>Notificações</DropdownMenuLabel><DropdownMenuSeparator />
    {pending.length > 0 && <DropdownMenuLabel>Precisa de você</DropdownMenuLabel>}
    {pending.map((chat) => <DropdownMenuItem key={chat.id} onSelect={() => { useAgentChats.getState().select(chat.id); useStore.getState().setWorkspaceView('agents') }}>
      <MessageSquare size={16} /><span className="ps-shell-notification-copy"><strong>{chat.title}</strong><small>{chat.kind === 'permission' ? 'Aguardando permissão' : 'Aguardando sua resposta'}</small></span>
    </DropdownMenuItem>)}
    {toasts.map((toast) => <DropdownMenuItem key={toast.id} className="ps-shell-notification-row" onSelect={() => useStore.getState().removeToast(toast.id)}><span className={`ps-shell-toast-dot is-${toast.kind}`} /><span>{toast.message}</span></DropdownMenuItem>)}
    {!count && <div className="ps-shell-notifications-empty"><BellOff size={24} /><span>Nenhuma notificação</span></div>}
    {toasts.length > 0 && <><DropdownMenuSeparator /><DropdownMenuItem onSelect={() => toasts.forEach((t) => useStore.getState().removeToast(t.id))}><Trash2 size={14} />Limpar notificações</DropdownMenuItem></>}
  </DropdownMenu>
}
