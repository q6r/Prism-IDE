import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Download, MessagesSquare, RefreshCw, X } from 'lucide-react'
import type { SharedTurn } from '../../../shared/agents'
import type { TraycerActivity, TraycerAgentRecord, TraycerTaskRecord } from '../../../shared/traycerImport'
import { withChatAncestors } from '../../../shared/traycerImport'
import { Button, Select, Spinner, Switch } from './ui'
import ChatTree from './ChatTree'
import { EmptyState, PanelSearchField, TipButton } from './agents-list/parts'
import { StatusGlyph } from './agents-list/StatusGlyph'
import '../styles/agents-list.css'

function status(active: boolean | null, session: string | null, archived: boolean): string {
  return archived ? 'Arquivado' : active === true ? 'Trabalhando agora' : active === null ? 'Estado ao vivo indisponível' : session === 'sleeping' ? 'Em repouso · retomável' : 'Entre turnos'
}
const harnessName = (h: string): string => h === 'claude' || h === 'claude-code' ? 'Claude Code' : h === 'codex' ? 'Codex' : h

/**
 * A live, read-only view of Traycer's tasks and agents through the Traycer
 * host: pick a task, browse its agent tree, read an agent's latest messages.
 * Both lists poll every 8s while the window is visible.
 */
export default function TraycerBrowser({ onClose, onImport }: { onClose: () => void; onImport: () => void }) {
  const [tasks, setTasks] = useState<TraycerTaskRecord[]>([]), [task, setTask] = useState(''), [activity, setActivity] = useState<TraycerActivity | null>(null)
  const [chat, setChat] = useState(''), [turns, setTurns] = useState<SharedTurn[]>([]), [query, setQuery] = useState(''), [error, setError] = useState(''), [loading, setLoading] = useState(false), [reading, setReading] = useState(false)
  const [archived, setArchived] = useState(false), [refresh, setRefresh] = useState(0), root = useRef<HTMLDivElement>(null)
  useEffect(() => { let alive = true; void window.prism.traycer.tasks().then(t => { if (alive) { setTasks(t); setTask(t[0]?.id || '') } }).catch(e => { if (alive) setError(e.message) }); return () => { alive = false } }, [])
  useEffect(() => { setChat(''); setTurns([]) }, [task])
  useEffect(() => {
    if (!task) return
    let alive = true, inflight = false
    setActivity(null); setError('')
    const poll = async () => { if (inflight || document.hidden) return; inflight = true; setLoading(true); try { const a = await window.prism.traycer.activity(task); if (alive) { setActivity(a); setError(a.error || ''); setChat(c => a.agents.some(r => r.id === c) ? c : a.agents.find(r => r.active)?.id || a.agents.find(r => !r.parentChatId)?.id || '') } } catch (e) { if (alive) setError((e as Error).message) } finally { inflight = false; if (alive) setLoading(false) } }
    void poll(); const timer = setInterval(() => void poll(), 8000)
    return () => { alive = false; clearInterval(timer) }
  }, [task, refresh])
  useEffect(() => {
    if (!chat || !task) return
    let alive = true, inflight = false
    setTurns([])
    const read = async () => { if (inflight || document.hidden) return; inflight = true; setReading(true); try { const t = await window.prism.traycer.transcript(task, chat); if (alive) setTurns(t) } catch (e) { if (alive) setError((e as Error).message) } finally { inflight = false; if (alive) setReading(false) } }
    void read(); const timer = setInterval(() => void read(), 8000)
    return () => { alive = false; clearInterval(timer) }
  }, [task, chat])
  // onClose lives in a ref: the mount effect below must run once, or every
  // parent re-render (a streaming agent) would steal focus back to the first button.
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null; root.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const key = (e: KeyboardEvent) => {
      // A menu open inside the dialog handles its own Escape first.
      if (e.key === 'Escape' && !document.querySelector('.tr-menu')) { e.stopImmediatePropagation(); closeRef.current() }
      if (e.key === 'Tab') { const els = [...(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex="0"]') || [])]; if (e.shiftKey && document.activeElement === els[0]) { e.preventDefault(); els.at(-1)?.focus() } else if (!e.shiftKey && document.activeElement === els.at(-1)) { e.preventDefault(); els[0]?.focus() } }
    }
    document.addEventListener('keydown', key, true); return () => { document.removeEventListener('keydown', key, true); previous?.focus() }
  }, [])
  const selected = activity?.agents.find(r => r.id === chat), items = withChatAncestors(activity?.agents || [], a => archived || !a.archived)
  const working = activity?.agents.filter(a => a.active && !a.archived).length || 0
  const glyph = (r: TraycerAgentRecord) => r.active ? 'running' as const : 'idle' as const

  return createPortal(<div className="al-overlay" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
    <div ref={root} className="al-root al-dialog al-browser" role="dialog" aria-modal="true" aria-labelledby="traycer-browser-title">
      <header className="al-dialog-head">
        <div className="al-dialog-heading">
          <h2 id="traycer-browser-title" className="al-dialog-title">Traycer · tarefas e agentes</h2>
          <p className="al-dialog-desc">{activity?.error ? 'Estado ao vivo indisponível' : `${working} trabalhando`}{activity ? ` · atualizado ${new Date(activity.checkedAt).toLocaleTimeString('pt-BR')}` : ''}</p>
        </div>
        <div className="al-dialog-actions">
          <Select ariaLabel="Tarefa do Traycer" size="sm" className="al-browser-task" value={task} onValueChange={setTask} placeholder="Nenhuma tarefa"
            options={tasks.map(t => ({ value: t.id, label: <>{t.title} <span className="tr-muted">· {t.count} {t.count === 1 ? 'agente' : 'agentes'}</span></> }))} />
          <TipButton tip="Atualizar" variant="muted" size="icon-sm" onClick={() => setRefresh(n => n + 1)} disabled={loading} aria-label="Atualizar agentes do Traycer">{loading ? <Spinner /> : <RefreshCw />}</TipButton>
          <Button variant="outline" size="sm" onClick={onImport}><Download />Importar para o Prism</Button>
          <TipButton tip="Fechar" variant="muted" size="icon-sm" onClick={onClose} aria-label="Fechar visão do Traycer"><X /></TipButton>
        </div>
      </header>
      {error ? <p className="al-browser-error" role="alert">{error}</p> : null}
      <div className="al-browser-body">
        <aside className="al-browser-side">
          <div className="al-browser-tools">
            <PanelSearchField value={query} onValueChange={setQuery} onClose={null} placeholder="Buscar agentes…" label="Buscar agentes do Traycer" />
            <label className="al-switch-row"><Switch checked={archived} onCheckedChange={setArchived} aria-label="Mostrar arquivados" /><span>Mostrar arquivados</span></label>
          </div>
          <div className="al-browser-tree">
            {items.length
              ? <ChatTree items={items} activeId={chat} query={query} label="Agentes da tarefa do Traycer" onSelect={setChat}
                icon={(r) => <StatusGlyph kind={glyph(r)} label={null} />}
                trailing={(r) => <>
                  {/* Session badge (AgentSessionStateBadge): only states that change what a click does. */}
                  {!r.archived && r.active === null ? <span className="al-idle-time" title="Estado ao vivo indisponível">indisponível</span>
                    : !r.archived && !r.active && r.sessionState === 'sleeping' ? <span className="al-idle-time" title="Em repouso. Retoma na próxima mensagem ou ao abrir.">Em repouso</span> : null}
                  <span className="al-idle-time">{harnessName(r.harness)}</span>
                </>}
                tooltip={(r) => <span className="al-row-tip"><strong>{r.title}</strong><span>{harnessName(r.harness)}{r.model ? ` · ${r.model}` : ''}</span><span>{status(r.active, r.sessionState, r.archived)}</span></span>}
                rowLabel={(r) => `${r.title}, ${status(r.active, r.sessionState, r.archived)}`} />
              : <EmptyState icon={MessagesSquare} title={loading && !activity ? 'Carregando agentes…' : 'Nenhum agente disponível nesta tarefa.'} />}
          </div>
        </aside>
        <main className="al-browser-main">
          <div className="al-browser-heading">
            <strong className="tr-truncate">{selected?.title || 'Selecione um agente'}</strong>
            {selected ? <span className="tr-truncate">{status(selected.active, selected.sessionState, selected.archived)} · {selected.model || harnessName(selected.harness)}{selected.parentChatId ? ` · filho de ${activity?.agents.find(a => a.id === selected.parentChatId)?.title || selected.parentChatId}` : ''}</span> : null}
          </div>
          <div className="al-browser-transcript" aria-label="Histórico do agente no Traycer" aria-live="polite">
            {turns.slice(-80).map(t => <article key={t.id} className={t.role === 'user' ? 'al-msg user' : 'al-msg'}>
              <span className="al-msg-role">{t.role === 'user' ? 'Usuário' : 'Agente'}</span>
              {t.text ? <p>{t.text}</p> : null}
              {t.segments?.map((s, i) => s.kind === 'thinking' ? null : s.kind === 'tool'
                ? <details key={i} className="al-msg-tool"><summary><span className="tr-truncate">{s.name}</span><span className="al-msg-tool-status">{s.status}</span></summary><pre>{typeof s.input === 'string' ? s.input : JSON.stringify(s.input, null, 2)}{'\n'}{s.result}</pre></details>
                : <p key={i}>{s.text}</p>)}
            </article>)}
            {reading && !turns.length ? <EmptyState icon={MessagesSquare} title="Carregando histórico…" /> : null}
            {!reading && chat && !turns.length ? <EmptyState icon={MessagesSquare} title="Este agente ainda não tem mensagens locais." /> : null}
          </div>
        </main>
      </div>
      <footer className="al-dialog-foot muted">Consulta ao vivo pelo host do Traycer. Últimas 80 mensagens locais em leitura; as execuções continuam no Traycer.{turns.length > 80 ? ` Exibindo as últimas 80 de ${turns.length} mensagens.` : ''}</footer>
    </div>
  </div>, document.body)
}
