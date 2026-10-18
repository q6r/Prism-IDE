import { memo } from 'react'
import { ArrowUpRight, Bot, Check, Square, TriangleAlert } from 'lucide-react'
import type { SharedSegment } from '../../../../shared/agents'
import { useAgentChats } from '../../lib/agentChats'
import { useStore } from '../../store'
import { cn } from '../ui'
import { formatClock } from './activity'
import { LiveElapsed, LivePulse, PanelPre, SegmentCard, SegmentPanel } from './primitives'
import { useOpen } from './state'

type Subagent = NonNullable<SharedSegment['subagent']>
const STATUS: Record<Subagent['status'], string> = {
  pending: 'Iniciando', running: 'Trabalhando', waiting: 'Aguardando', completed: 'Concluído', failed: 'Falhou', stopped: 'Interrompido'
}

/** Native lifecycle stays live even when the parent has finished its own turn. */
export const SubagentCard = memo(function SubagentCard({ segment, openKey }: { segment: SharedSegment; openKey: string }) {
  const agent = segment.subagent!
  const linked = useAgentChats(s => s.chats.some(c => c.id === agent.chatId))
  const [open, setOpen] = useOpen(openKey)
  const live = agent.status === 'pending' || agent.status === 'running' || agent.status === 'waiting'
  const label = STATUS[agent.status]
  const latest = (live ? agent.activity || agent.summary : agent.summary || agent.activity) || agent.description || (live ? 'Aguardando atividade do agente…' : '')
  const openAgent = (): void => {
    useAgentChats.getState().select(agent.chatId)
    useStore.getState().setWorkspaceView('agents')
  }
  const link = linked ? <button type="button" className="ch-subagent-link" aria-label={`Abrir agente ${agent.name}`} onClick={openAgent}>
    Abrir agente<ArrowUpRight size={14} aria-hidden />
  </button> : null
  const header = <>
    <Bot size={16} aria-hidden className="ch-tool-icon" />
    <span className="ch-subagent-name">{agent.name || 'Subagente'}</span>
    <span className={cn('ch-subagent-status', agent.status === 'failed' && 'destructive')}>
      {live ? <LivePulse label={label} tone={agent.status === 'waiting' ? 'idle' : 'active'} />
        : agent.status === 'failed' ? <TriangleAlert size={13} aria-hidden />
          : agent.status === 'stopped' ? <Square size={12} aria-hidden /> : <Check size={13} aria-hidden />}
      {label}
    </span>
    {live ? <LiveElapsed startedAt={agent.startedAt} /> : <span className="ch-elapsed">{formatClock(Math.max(0, agent.updatedAt - agent.startedAt) / 1000)}</span>}
  </>
  const body = <div className="ch-subagent-details">
    {agent.description ? <SegmentPanel label="Tarefa" copyValue={agent.description}><PanelPre>{agent.description}</PanelPre></SegmentPanel> : null}
    {agent.activity ? <SegmentPanel label="Atividade"><PanelPre>{agent.activity}</PanelPre></SegmentPanel> : null}
    {agent.summary ? <SegmentPanel label="Resultado" copyValue={agent.summary}><PanelPre>{agent.summary}</PanelPre></SegmentPanel> : null}
    {agent.model ? <span className="ch-subagent-model">Modelo: {agent.model}</span> : null}
    <div className="ch-subagent-foot">{link}</div>
  </div>
  return <section className="ch-subagent" data-agent-id={agent.id} data-status={agent.status} aria-label={`Subagente ${agent.name}, ${label}`}>
    <SegmentCard open={open} onOpenChange={setOpen} header={header} body={body} expandable stickyHeader
      tone={agent.status === 'failed' ? 'destructive' : live ? 'primary' : 'default'}
      collapsedPreview={<div className="ch-subagent-preview"><span>{latest}</span>{link}</div>} />
  </section>
})
