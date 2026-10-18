import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { ChevronDown, FileDiff, Folder, GitBranch, Monitor, Circle } from 'lucide-react'
import { useAgentChats } from '../../lib/agentChats'
import { useStore } from '../../store'
import { languageFromPath } from '../../lib/lang'
import { rememberGitDiff } from '../git/diff-context'
import { workspaceFilePath } from '../git/workspace-path'
import type { GitFile } from '../git/git-model'
import '../../styles/chat-details.css'

type Status = Awaited<ReturnType<typeof window.prism.git.status>>

/** One subscription per workspace; token streaming does not cause Git polling. */
export function useChatGit() {
  const chat = useAgentChats(useShallow(s => {
    const c = s.chats.find(c => c.id === s.activeId)
    return c ? { id: c.id, cwd: c.cwd, remoteId: c.remoteId } : null
  }))
  const busy = useAgentChats(s => !!s.activeId && !!s.runtime[s.activeId]?.busy)
  const [result, setResult] = useState<{ key: string; status: Status } | null>(null)
  const key = `${chat?.id}:${chat?.cwd}:${chat?.remoteId}`
  useEffect(() => {
    if (!chat?.cwd) return
    let alive = true, pending = false
    const refresh = async () => {
      if (pending || !alive) return
      pending = true
      try {
        const status = await window.prism.git.status(chat.cwd, chat.remoteId, { stats: true })
        if (alive) setResult({ key, status })
      } catch { if (alive) setResult(null) }
      finally { pending = false }
    }
    void refresh()
    const timer = setInterval(() => { if (!document.hidden) void refresh() }, 8000)
    window.addEventListener('focus', refresh)
    return () => { alive = false; clearInterval(timer); window.removeEventListener('focus', refresh) }
  }, [key, busy])
  return { chat, status: result?.key === key ? result.status : null }
}

export function ChangedFiles({ git }: { git: ReturnType<typeof useChatGit> }) {
  const [expanded, setExpanded] = useState(false)
  useEffect(() => setExpanded(false), [git.chat?.id])
  const files = git.status?.files ?? []
  if (!files.length) return null
  const additions = files.reduce((n, f) => n + (f.stagedStats?.insertions ?? 0) + (f.workingStats?.insertions ?? 0), 0)
  const deletions = files.reduce((n, f) => n + (f.stagedStats?.deletions ?? 0) + (f.workingStats?.deletions ?? 0), 0)
  const open = async (file: GitFile) => {
    const root = git.status?.root || git.chat?.cwd
    if (!root) return
    try {
      const remoteId = git.chat?.remoteId
      // Prefer the working diff; a file with only staged changes opens the index diff.
      const scope = file.y === ' ' && file.staged ? 'staged' : 'working'
      const { original, modified } = await window.prism.git.diff(root, file.path, file.untracked, remoteId, scope, file.origPath)
      const absolute = workspaceFilePath(`${root}/${file.path}`, [root], !!remoteId)
      rememberGitDiff(absolute, { root, file: file.path, origPath: file.origPath, untracked: file.untracked, remoteId, scope })
      useStore.getState().openDiff(absolute, file.path.split('/').at(-1)!, original, modified, languageFromPath(file.path))
      useStore.getState().setWorkspaceView('editor')
    } catch (error) { useStore.getState().addToast('error', `Não foi possível abrir a alteração: ${(error as Error).message}`) }
  }
  return <div className="acd-changes" data-testid="accumulated-changes-panel">
    <button className="acd-summary" aria-expanded={expanded} aria-controls="chat-changed-files" onClick={() => setExpanded(v => !v)}>
      <ChevronDown size={12} className={expanded ? "" : "collapsed"} aria-hidden /><span>{files.length} {files.length === 1 ? 'arquivo alterado' : 'arquivos alterados'}</span>
      <span className="acd-added">+{additions}</span><span className="acd-deleted">−{deletions}</span>
      <span className="acd-summary-spacer" aria-hidden />
    </button>
    {expanded && <div id="chat-changed-files" className="acd-files">
      {files.map(file => <button key={file.path} className="acd-file" title={file.path} onClick={() => void open(file)}>
        <FileDiff size={13} /><span>{file.path}</span>
        <span className="acd-added">+{(file.stagedStats?.insertions ?? 0) + (file.workingStats?.insertions ?? 0)}</span>
        <span className="acd-deleted">−{(file.stagedStats?.deletions ?? 0) + (file.workingStats?.deletions ?? 0)}</span>
      </button>)}
    </div>}
  </div>
}

export function ChatDetails({ git }: { git: ReturnType<typeof useChatGit> }) {
  const metrics = useAgentChats(s => {
    const c = s.chats.find(c => c.id === s.activeId)
    // Current response or the preceding response. Never scan an imported
    // 22k-turn history on each token while waiting for its first metrics.
    return c?.turns.at(-1)?.metrics ?? c?.turns.at(-2)?.metrics ?? c?.turns.at(-3)?.metrics
  })
  if (!git.chat) return null
  const used = metrics?.contextTokens
  const pct = used !== undefined && metrics?.contextWindow ? Math.min(100, Math.round(100 * used / metrics.contextWindow)) : undefined
  const contextTitle = pct === undefined ? 'Uso da última chamada; o provedor ainda não informou o tamanho da janela de contexto.' : `${used!.toLocaleString('pt-BR')} / ${metrics!.contextWindow!.toLocaleString('pt-BR')} tokens na última chamada`
  return <div className="acd-footer" aria-label="Contexto e local da conversa">
    <span title={contextTitle}><Circle size={12} />Contexto {pct !== undefined ? `${pct}%` : used !== undefined ? `${used.toLocaleString('pt-BR')} tokens` : '—'}</span>
    <span title={git.chat.remoteId ? 'Servidor SSH' : 'Computador local'}><Monitor size={12} />{git.chat.remoteId ? 'SSH' : 'Local'}</span>
    <span className="acd-workspace" title={git.chat.cwd}><Folder size={12} />{git.chat.cwd?.split(/[\\/]/).filter(Boolean).at(-1) || 'Sem pasta'}</span>
    {git.status?.isRepo && <span title={git.status.branch || 'HEAD separado'}><GitBranch size={12} />{git.status.branch || 'HEAD'}</span>}
  </div>
}
