import { useEffect, useMemo, useState } from 'react'
import { Gauge, RefreshCw, Settings } from 'lucide-react'
import { useAgentChats } from '../../lib/agentChats'
import { useProviderUsage } from '../../lib/providerUsage'
import { followUsageUpdates } from '../../lib/usageUpdates'
import { useStore } from '../../store'
import { Button, DropdownMenu, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, MeterRow, Spinner } from '../ui'

export default function UsageMenu({ onOpenChange }: { onOpenChange?: (open: boolean) => void }) {
  const [open, setOpen] = useState(false)
  const selection = useAgentChats((s) => s.chats.find((c) => c.id === s.activeId)?.selection)
  const profile = useMemo(() => selection ? { id: selection.profileId, provider: selection.provider, name: selection.profileId } : null,
    [selection?.profileId, selection?.provider])
  const entry = useProviderUsage(s => profile ? s.entries[profile.id] : undefined)
  const data = entry?.details
  const loading = !!entry?.fetching
  useEffect(() => {
    if (!open || !profile) return
    const ensure = (): void => { if (!document.hidden) useProviderUsage.getState().ensure(profile) }
    ensure()
    const timer = setInterval(ensure, 60_000)
    window.addEventListener('focus', ensure)
    const off = followUsageUpdates(useAgentChats.subscribe, () => {
      const usage = useProviderUsage.getState()
      if (!document.hidden && !usage.entries[profile.id]?.fetching) void usage.refresh(profile)
    })
    return () => { clearInterval(timer); window.removeEventListener('focus', ensure); off() }
  }, [open, profile])
  return <DropdownMenu open={open} onOpenChange={(next) => { setOpen(next); onOpenChange?.(next) }} align="end" className="ps-shell-usage" label="Limites de uso" trigger={<Button variant="muted" size="icon-sm" aria-label="Limites de uso" title="Limites de uso"><Gauge size={16} /></Button>}>
    <DropdownMenuLabel>Limites de uso</DropdownMenuLabel><DropdownMenuSeparator />
    {loading && <div className="ps-shell-usage-note"><Spinner label="Consultando uso" />Consultando uso…</div>}
    {!selection && <div className="ps-shell-usage-note">Selecione uma conversa para consultar a conta.</div>}
    {data && <div className="ps-shell-usage-body">
      <strong>{selection?.provider === 'claude' ? 'Claude' : 'Codex'}</strong>
      {(data.error || data.unavailable) && <p role={data.error ? 'alert' : undefined}>{data.error || data.unavailable}</p>}
      {data.limits.map((limit, i) => <MeterRow key={limit.id || i} label={limit.label || 'Janela da conta'} usedPercent={limit.usedPercent} detail={`${Math.round(limit.usedPercent)}% usado`} severity={limit.usedPercent >= 100 ? 'limited' : limit.usedPercent >= 80 ? 'running_low' : 'healthy'} />)}
      {data.stale && <small>Última consulta disponível · desatualizada</small>}
    </div>}
    <DropdownMenuSeparator />
    <DropdownMenuItem disabled={!profile || loading} onSelect={(e) => { e.preventDefault(); if (profile) void useProviderUsage.getState().refresh(profile) }}><RefreshCw size={14} />Atualizar</DropdownMenuItem>
    <DropdownMenuItem onSelect={() => useStore.getState().openSettings('providers')}><Settings size={14} />Gerenciar contas</DropdownMenuItem>
  </DropdownMenu>
}
