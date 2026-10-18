import { useEffect, useMemo, useState } from 'react'
import { Activity, ArrowUpRight, ChevronRight, Gauge, Square, X } from 'lucide-react'
import { useAgentChats, type ChatRuntime } from '../lib/agentChats'
import { useAgentTasks } from '../lib/agentTasks'
import { useStore } from '../store'
import type { SharedTurn } from '../../../shared/agents'
import { Badge, Button, LineTabs, cn } from './ui'
import { EmptyState, PanelSearchField, TipButton } from './agents-list/parts'
import { StatusGlyph } from './agents-list/StatusGlyph'
import { monitorCounts, monitorRows, type ChatStatusKind, type MonitorFilter } from './agents-list/model'
import '../styles/agents-list.css'

export function duration(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000)
  return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m ${s % 60}s` : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`
}
export function useRunClock(active: boolean): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { setNow(Date.now()); if (!active) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [active])
  return now
}
export function runStatus(turn?: SharedTurn, run?: ChatRuntime): string {
  if (!run?.busy) return turn?.interrupted ? 'Interrompido' : turn?.error ? 'Erro' : 'Concluído'
  if (run.permission) return 'Aguardando permissão'
  if (run.question) return 'Aguardando resposta'
  const tool = [...(turn?.segments || [])].reverse().find(s => s.kind === 'tool' && (s.status === 'running' || s.status === 'awaiting'))
  if (tool) return `Executando ${tool.name || 'ferramenta'}`
  const last = turn?.segments?.at(-1)
  return last?.kind === 'thinking' ? 'Raciocinando' : last?.kind === 'text' ? 'Respondendo' : 'Iniciando'
}
export function RunNumbers({ turn }: { turn: SharedTurn }) {
  const m = turn.metrics
  if (!m) return null
  const n = (v: number) => v.toLocaleString('pt-BR')
  return <span className="run-numbers" title="Totais informados pela sessão nativa; não são somados entre respostas.">
    {m.totalTokens != null && <span>{n(m.totalTokens)} tokens</span>}
    {m.inputTokens != null && <span>{n(m.inputTokens)} entrada</span>}
    {m.outputTokens != null && <span>{n(m.outputTokens)} saída</span>}
    {m.cachedTokens != null && <span>{n(m.cachedTokens)} cache</span>}
    {m.reasoningTokens != null && <span>{n(m.reasoningTokens)} raciocínio</span>}
    {m.contextWindow != null && <span>Contexto {n(m.contextWindow)}</span>}
    {m.costUsd != null && <span>US$ {m.costUsd.toFixed(4)} estimado</span>}
    <span>sessão nativa</span>
  </span>
}
function RunDuration({ turn, busy }: { turn: SharedTurn; busy: boolean }) {
  const now = useRunClock(busy)
  return <span className="al-run-time">{duration(busy ? now - turn.startedAt! : turn.durationMs || 0)}</span>
}
function runKind(turn: SharedTurn, run?: ChatRuntime): ChatStatusKind {
  if (run?.busy) return run.question ? 'interview' : run.permission ? 'approval' : 'running'
  return turn.error ? 'failure' : turn.interrupted ? 'idle' : 'done'
}

const FILTERS: readonly { value: MonitorFilter; label: string }[] = [
  { value: 'active', label: 'Ativos' }, { value: 'waiting', label: 'Aguardando' }, { value: 'finished', label: 'Encerrados' }, { value: 'all', label: 'Todos' }
]
const PAGE = 40

/**
 * The run monitor over the conversation (Traycer's Activity strip): every
 * assistant run across chats, live ones first, filtered by state and searched
 * by chat, account, task or model. A row opens its chat or stops its run.
 */
export default function AgentMonitor({ onClose, onAccounts }: { onClose: () => void; onAccounts: () => void }) {
  const chats = useAgentChats(s => s.chats)
  const runtime = useAgentChats(s => s.runtime)
  const tasks = useAgentTasks(s => s.tasks)
  const [filter, setFilter] = useState<MonitorFilter>('active'), [query, setQuery] = useState('')
  const [visible, setVisible] = useState(PAGE)
  const [open, setOpen] = useState<string | null>(null)
  useEffect(() => setVisible(PAGE), [filter, query])
  const rows = useMemo(() => monitorRows(chats, runtime, tasks, filter, query), [chats, runtime, filter, query, tasks])
  const { active, waiting } = monitorCounts(runtime)
  const taskTitle = (id?: string): string | undefined => tasks.find(t => t.id === id)?.title
  const count = (n: number) => n ? <span className="al-count">{n}</span> : null
  return <section className="al-root al-monitor" aria-label="Monitor de agentes">
    <header className="al-monitor-head">
      <div className="al-monitor-title">
        <Activity aria-hidden />
        <h2>Execuções do Prism</h2>
        <Badge variant="muted" size="sm">{active} {active === 1 ? 'ativo' : 'ativos'}</Badge>
        {waiting ? <Badge variant="warning" size="sm">{waiting} aguardando</Badge> : null}
      </div>
      <div className="al-monitor-actions">
        <Button variant="ghost" size="xs" onClick={onAccounts}><Gauge />Limites das contas</Button>
        <TipButton tip="Fechar" variant="muted" size="icon-xs" aria-label="Fechar monitor de agentes" onClick={onClose}><X /></TipButton>
      </div>
    </header>
    <div className="al-monitor-bar">
      <LineTabs ariaLabel="Filtrar execuções" value={filter} onChange={setFilter}
        tabs={FILTERS.map(f => ({ value: f.value, label: <>{f.label}{f.value === 'active' ? count(active) : f.value === 'waiting' ? count(waiting) : null}</> }))} />
      <PanelSearchField value={query} onValueChange={setQuery} onClose={null} placeholder="Chat, conta, tarefa ou modelo…" label="Buscar agente" className="al-monitor-search" />
    </div>
    <div className="al-monitor-list" role="list">
      {rows.slice(0, visible).map(({ chat, turn, run }) => {
        const kind = runKind(turn, run), expanded = open === turn.id
        const status = runStatus(turn, run), tools = turn.segments?.filter(s => s.kind === 'tool').length || 0
        return <article key={turn.id} role="listitem" className={cn('al-run', expanded && 'open')} data-status={kind}>
          <button type="button" className="al-run-main" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : turn.id)}>
            <ChevronRight aria-hidden className="al-run-chevron" />
            <span className="al-run-glyph"><StatusGlyph kind={kind} label={status} /></span>
            <span className="al-run-text">
              <span className="al-run-line"><span className="al-run-title">{chat.title}</span>
                <span className={cn('al-run-state', (kind === 'approval' || kind === 'interview') && 'warn', kind === 'failure' && 'fail')}>{status}</span></span>
              <span className="al-run-meta">{taskTitle(chat.taskId) || chat.cwd || 'Sem tarefa'} · {turn.profileName || 'Conta do terminal'} · {turn.model || 'Modelo padrão'}</span>
            </span>
            <RunDuration turn={turn} busy={!!run?.busy} />
          </button>
          <div className="al-run-actions">
            {run?.busy && !chat.nativeAgent ? <TipButton tip="Parar" variant="ghost" size="icon-xs" aria-label={`Parar ${chat.title}`} onClick={() => useAgentChats.getState().stop(chat.id)}><Square /></TipButton> : null}
            <TipButton tip="Abrir chat" variant="ghost" size="icon-xs" aria-label={`Abrir ${chat.title}`} onClick={() => { useAgentChats.getState().select(chat.id); useStore.getState().setWorkspaceView('agents'); onClose() }}><ArrowUpRight /></TipButton>
          </div>
          {/* Kept mounted while folded: its numbers stay in the row's text for search tools and QA. */}
          <div className="al-run-detail" hidden={!expanded}>
            <span>{tools} {tools === 1 ? 'ferramenta' : 'ferramentas'}</span>
            <time dateTime={new Date(turn.startedAt!).toISOString()}>Início {new Date(turn.startedAt!).toLocaleString('pt-BR')}{turn.completedAt ? ` · fim ${new Date(turn.completedAt).toLocaleTimeString('pt-BR')}` : ''}</time>
            {turn.metrics ? <RunNumbers turn={turn} /> : <span>Sem métricas da sessão.</span>}
          </div>
        </article>
      })}
      {rows.length > visible ? <Button variant="ghost" size="sm" className="al-monitor-more" onClick={() => setVisible(n => n + PAGE)}>Mostrar mais ({rows.length - visible})</Button> : null}
      {!rows.length ? <EmptyState icon={Activity} title="Nenhuma execução neste filtro." description={query ? 'Tente outro termo de busca.' : null} /> : null}
    </div>
    <footer className="al-monitor-foot">Cada linha é uma execução dentro de um chat. O tempo inclui esperas por permissão e resposta. Histórico anterior sem horários não entra neste painel.</footer>
  </section>
}
