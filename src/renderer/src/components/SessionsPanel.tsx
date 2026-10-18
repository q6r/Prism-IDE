import { useEffect, useMemo, useRef, useState } from 'react'
import { History, RefreshCw, MessageSquare, Trash2, FolderGit2, Search } from 'lucide-react'
import { useStore } from '../store'
import { Button, InputAddon, InputGroup, SegmentedControl, Spinner, Tooltip } from './ui'
import PanelHeader from './shell/PanelHeader'
import { relativeTime, workspacePathKey } from './shell/logic'
import '../styles/shell.css'

type SessionMeta = Awaited<ReturnType<Window['prism']['sessions']['list']>>[number]

export default function SessionsPanel() {
  const folderPath = useStore((s) => s.folderPath)
  const openSession = useStore((s) => s.openSession)
  const addToast = useStore((s) => s.addToast)
  const rid = useStore((s) => s.remote?.id)
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<'project' | 'all'>('project')
  const request = useRef(0)

  const load = (): void => {
    const id = ++request.current
    setLoading(true)
    window.prism.sessions
      .list(undefined, rid)
      .then((list) => { if (id === request.current) setSessions(list) })
      .catch((err: Error) => { if (id === request.current) { setSessions([]); addToast('error', `Não foi possível carregar as sessões: ${err.message}`) } })
      .finally(() => { if (id === request.current) setLoading(false) })
  }

  useEffect(() => {
    load()
    return () => { request.current++ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rid])

  const curr = workspacePathKey(folderPath)

  const filtered = useMemo(() => {
    let list = sessions
    if (scope === 'project' && curr) list = list.filter((s) => workspacePathKey(s.cwd) === curr)
    const q = query.trim().toLowerCase()
    if (q) {
      list = list.filter(
        (s) =>
          s.title.toLowerCase().includes(q) ||
          s.preview.toLowerCase().includes(q) ||
          s.project.toLowerCase().includes(q)
      )
    }
    return list
  }, [sessions, scope, curr, query])

  // Group by project when showing all.
  const groups = useMemo(() => {
    if (scope === 'project') return [{ project: '', items: filtered }]
    const map = new Map<string, SessionMeta[]>()
    for (const s of filtered) {
      const key = s.project || '—'
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(s)
    }
    return Array.from(map.entries()).map(([project, items]) => ({ project, items }))
  }, [filtered, scope])

  const del = async (e: React.MouseEvent, s: SessionMeta): Promise<void> => {
    e.stopPropagation()
    const ok = await window.prism.sessions.delete(s.file, rid)
    if (ok) {
      setSessions((prev) => prev.filter((x) => x.id !== s.id))
      addToast('success', 'Sessão apagada')
    } else addToast('error', 'Falha ao apagar')
  }

  return (
    <div className="ps-shell-panel ps-shell-sessions-panel">
      <PanelHeader title={<><History size={14} />Histórico</>}><Tooltip label="Atualizar"><Button variant="muted" size="icon-xs" aria-label="Atualizar sessões" disabled={loading} onClick={load}><RefreshCw size={14} /></Button></Tooltip></PanelHeader>

      <div className="ps-shell-sessions-scope">
        <SegmentedControl value={scope} onChange={setScope} ariaLabel="Escopo do histórico" options={[{ value: 'project', label: 'Este projeto' }, { value: 'all', label: 'Todas' }]} />
      </div>

      <InputGroup variant="search" className="ps-shell-sessions-search">
        <InputAddon><Search size={14} /></InputAddon>
        <input
          aria-label="Filtrar sessões"
          placeholder="Filtrar sessões…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </InputGroup>

      <div className="ps-shell-sessions-list">
        {loading && <div className="ps-shell-sessions-empty" role="status"><Spinner />Carregando…</div>}
        {!loading && filtered.length === 0 && (
          <div className="ps-shell-sessions-empty">
            {scope === 'project'
              ? 'Nenhuma sessão do Claude Code neste projeto ainda.'
              : 'Nenhuma sessão encontrada.'}
          </div>
        )}
        {!loading &&
          groups.map((g) => (
            <div key={g.project || 'single'}>
              {scope === 'all' && g.project && (
                <div className="ps-shell-sessions-group">
                  <FolderGit2 size={12} /> {g.project}
                </div>
              )}
              {g.items.map((s) => (
                <div
                  key={s.id}
                  className="ps-shell-session-item"
                  title={s.cwd}
                >
                  <button type="button" className="ps-shell-session-open" onClick={() => openSession({ file: s.file, id: s.id, title: s.title, cwd: s.cwd })}>
                  <div className="ps-shell-session-top">
                    <span className="ps-shell-session-title">{s.title}</span>
                    <span className="ps-shell-session-time">{relativeTime(s.mtime)}</span>
                  </div>
                  {s.preview && <div className="ps-shell-session-preview">{s.preview}</div>}
                  <div className="ps-shell-session-meta">
                    <span>
                      <MessageSquare size={11} /> {s.messageCount}
                    </span>
                    {s.gitBranch && <span className="ps-shell-session-branch">{s.gitBranch}</span>}
                  </div>
                  </button>
                    <button type="button"
                      className="ps-shell-session-del"
                      title="Apagar sessão"
                      aria-label={`Apagar sessão ${s.title}`}
                      onClick={(e) => del(e, s)}
                    >
                      <Trash2 size={12} />
                    </button>
                </div>
              ))}
            </div>
          ))}
      </div>
    </div>
  )
}
