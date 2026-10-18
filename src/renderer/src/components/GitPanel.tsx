import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowDownToLine, ArrowUpFromLine, Check, ChevronDown, ChevronRight, GitBranch, GitBranchPlus, GitCommitHorizontal, List, ListTree, Minus, Plus, RefreshCw, Search, Sparkles, X } from 'lucide-react'
import { useStore } from '../store'
import { basename, languageFromPath } from '../lib/lang'
import { Button, DropdownMenu, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, InputAddon, InputGroup, Spinner, Tooltip } from './ui'
import GitFileList from './git/GitFileList'
import BranchSearchInput from './git/BranchSearchInput'
import ConfirmDiscardDialog from './git/ConfirmDiscardDialog'
import { workspaceFilePath } from './git/workspace-path'
import { filterGitFiles, gitFailure, groupGitFiles, SECTION_LABELS, type GitFile, type GitSection } from './git/git-model'
import { getGitDiffContext, rememberGitDiff } from './git/diff-context'
import '../styles/git.css'

type Status = Awaited<ReturnType<typeof window.prism.git.statusAll>>[number]
type Branches = Awaited<ReturnType<typeof window.prism.git.branches>>
const SECTIONS: GitSection[] = ['conflicts', 'staged', 'working']

export default function GitPanel() {
  const folderPath = useStore((s) => s.folderPath)
  const workspaceFolders = useStore((s) => s.workspaceFolders)
  const treeVersion = useStore((s) => s.treeVersion)
  const remoteId = useStore((s) => s.remote?.id)
  const [repos, setRepos] = useState<Status[] | null>(null)
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [query, setQuery] = useState('')
  const [appliedQuery, setAppliedQuery] = useState('')
  const [tree, setTree] = useState(() => { try { return localStorage.getItem('prism.git.layout') === 'tree' } catch { return false } })
  const request = useRef(0)
  const foldersKey = (workspaceFolders.length ? workspaceFolders : folderPath ? [folderPath] : []).join('\0')
  const refresh = useCallback(async (): Promise<void> => {
    const version = ++request.current
    const folders = foldersKey ? foldersKey.split('\0') : []
    if (!folders.length) { setRepos([]); setRefreshing(false); setError(''); return }
    setRefreshing(true)
    try {
      const result = await window.prism.git.statusAll(folders, remoteId, { stats: true })
      if (request.current === version) { setRepos(result); setError('') }
    } catch (e) {
      if (request.current === version) setError(e instanceof Error ? e.message : 'Não foi possível carregar as alterações')
    } finally { if (request.current === version) setRefreshing(false) }
  }, [foldersKey, remoteId])
  useEffect(() => { setRepos(null); return () => { request.current++ } }, [refresh])
  useEffect(() => { void refresh() }, [treeVersion, refresh])
  useEffect(() => { const timer = setTimeout(() => setAppliedQuery(query), 150); return () => clearTimeout(timer) }, [query])
  const clearQuery = (): void => { setQuery(''); setAppliedQuery('') }
  const setLayout = (): void => { const next = !tree; setTree(next); try { localStorage.setItem('prism.git.layout', next ? 'tree' : 'list') } catch { /* storage unavailable */ } }
  const init = async (): Promise<void> => {
    if (!folderPath) return
    try { const failure = gitFailure(await window.prism.git.init(folderPath, remoteId)); if (failure) throw new Error(failure); await refresh() }
    catch (e) { setError(e instanceof Error ? e.message : 'Não foi possível inicializar o repositório') }
  }
  return <div className="pg-panel">
    <div className="pg-panel-header"><span>Alterações Git</span><div className="pg-toolbar">
      <Tooltip label={tree ? 'Visualização em lista' : 'Visualização em árvore'}><Button variant="muted" size="icon-sm" aria-label={tree ? 'Visualização em lista' : 'Visualização em árvore'} aria-pressed={tree} onClick={setLayout}>{tree ? <ListTree size={16} /> : <List size={16} />}</Button></Tooltip>
      <Tooltip label="Atualizar alterações"><Button variant="muted" size="icon-sm" aria-label="Atualizar alterações" disabled={refreshing} onClick={() => void refresh()}>{refreshing ? <Spinner /> : <RefreshCw size={16} />}</Button></Tooltip>
    </div></div>
    {error && <div className="pg-error" role="alert"><span>{error}</span><Button variant="outline" size="xs" onClick={() => void refresh()}>Tentar novamente</Button></div>}
    {!folderPath ? <div className="pg-empty"><GitBranch size={24} /><span>Abra uma pasta com um repositório Git.</span></div> : repos === null ? error ? <div className="pg-empty">Não foi possível carregar as alterações.</div> : <div className="pg-loading" role="status" aria-label="Carregando alterações"><div /><div /><div /><div /><div /></div> : repos.length === 0 ? <div className="pg-empty"><GitBranch size={24} /><span>Nenhum repositório Git nas pastas abertas.</span><Button size="sm" onClick={() => void init()}>Inicializar repositório</Button></div> : <>
      <div className="pg-filter"><InputGroup variant="search"><InputAddon><Search size={14} /></InputAddon><input aria-label="Filtrar arquivos alterados" placeholder="Filtrar arquivos alterados…" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') { clearQuery(); e.currentTarget.blur() } }} />{query && <InputAddon align="end"><Button variant="muted" size="icon-xs" aria-label="Limpar filtro" onClick={clearQuery}><X size={12} /></Button></InputAddon>}</InputGroup></div>
      <div className="pg-repositories">{repos.map((status) => <RepoSection key={`${remoteId ?? 'local'}:${status.root}`} status={status} multi={repos.length > 1} refreshAll={refresh} query={appliedQuery} tree={tree} />)}</div>
    </>}
  </div>
}

function RepoSection({ status, multi, refreshAll, query, tree }: { status: Status; multi: boolean; refreshAll: () => Promise<void>; query: string; tree: boolean }) {
  const openDiff = useStore((s) => s.openDiff)
  const addToast = useStore((s) => s.addToast)
  const activePath = useStore((s) => s.activePath)
  const remoteId = useStore((s) => s.remote?.id)
  const root = status.root!
  const [commitMsg, setCommitMsg] = useState('')
  const [generating, setGenerating] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [sectionsCollapsed, setSectionsCollapsed] = useState<Set<GitSection>>(new Set())
  const [pickerOpen, setPickerOpen] = useState(false)
  const [branches, setBranches] = useState<Branches | null>(null)
  const [branchError, setBranchError] = useState('')
  const [branchFilter, setBranchFilter] = useState('')
  const [busy, setBusy] = useState(false)
  const [discardFile, setDiscardFile] = useState<GitFile | null>(null)
  const busyRef = useRef(false)
  const files = status.files ?? []
  const groups = groupGitFiles(files)
  const changes = files.filter((file) => file.untracked || Boolean(file.y.trim()))
  const activeFile = activePath?.startsWith(`diff:${root}/`) ? activePath.slice(`diff:${root}/`.length) : null
  const activeScope = activePath ? getGitDiffContext(activePath)?.scope : undefined
  const reportError = (error: unknown): void => addToast('error', error instanceof Error ? error.message : String(error || 'Falha na operação Git'))
  const run = async (fn: () => Promise<unknown>, success?: string): Promise<boolean> => {
    if (busyRef.current) return false
    busyRef.current = true; setBusy(true)
    try {
      const failure = gitFailure(await fn())
      if (failure) throw new Error(failure)
      if (success) addToast('success', success)
      await refreshAll()
      return true
    } catch (error) { reportError(error); return false }
    finally { busyRef.current = false; setBusy(false) }
  }
  useEffect(() => {
    if (!pickerOpen) return
    let live = true
    setBranches(null)
    setBranchError('')
    window.prism.git.branches(root, remoteId).then((result) => { if (live) setBranches(result) }).catch((error) => { if (live) { setBranchError(error instanceof Error ? error.message : 'Não foi possível carregar branches'); reportError(error) } })
    return () => { live = false }
  }, [pickerOpen, root, remoteId])
  const checkout = async (branch: string): Promise<void> => { if (await run(() => window.prism.git.checkout(root, branch, remoteId), `Branch: ${branch}`)) setPickerOpen(false) }
  const createBranch = async (): Promise<void> => {
    const name = branchFilter.trim()
    if (name && await run(() => window.prism.git.createBranch(root, name, remoteId), `Branch criada: ${name}`)) { setPickerOpen(false); setBranchFilter('') }
  }
  const commit = async (): Promise<void> => {
    const message = commitMsg.trim()
    if (!message || files.length === 0 || groups.conflicts.length) return
    const ok = await run(async () => {
      if (!groups.staged.length && changes.length) {
        const stagedError = gitFailure(await window.prism.git.stageAll(root, remoteId))
        if (stagedError) throw new Error(stagedError)
      }
      return window.prism.git.commit(root, message, remoteId)
    }, 'Commit criado')
    if (ok) setCommitMsg('')
  }
  const genMsg = async (): Promise<void> => {
    if (generating) return
    setGenerating(true)
    try { const result = await window.prism.git.aiCommitMessage(root, remoteId); if (result.ok && result.message) setCommitMsg(result.message); else throw new Error(result.error || 'Não foi possível gerar a mensagem') }
    catch (error) { reportError(error) }
    finally { setGenerating(false) }
  }
  const openDiffFor = async (file: GitFile, section: GitSection): Promise<void> => {
    try {
      const scope = section === 'staged' ? 'staged' : 'working'
      const { original, modified } = await window.prism.git.diff(root, file.path, file.untracked, remoteId, scope, file.origPath)
      const absolutePath = `${root}/${file.path}`
      rememberGitDiff(absolutePath, { root, file: file.path, origPath: file.origPath, untracked: file.untracked, remoteId, scope })
      openDiff(absolutePath, basename(file.path), original, modified, languageFromPath(file.path))
    } catch (error) { reportError(error) }
  }
  const localMatches = (branches?.local ?? []).filter((branch) => branch.toLocaleLowerCase().includes(branchFilter.toLocaleLowerCase()))
  const remoteMatches = (branches?.remote ?? []).filter((branch) => branch.toLocaleLowerCase().includes(branchFilter.toLocaleLowerCase()))
  const exactExists = branches?.local.some((branch) => branch === branchFilter.trim())
  const discard = async (): Promise<void> => {
    if (!discardFile) return
    const file = discardFile
    const ok = await run(async () => {
      if (file.untracked && !remoteId) {
        const { workspaceFolders, folderPath } = useStore.getState()
        const path = workspaceFilePath(`${root}/${file.path}`, workspaceFolders.length ? workspaceFolders : folderPath ? [folderPath] : [])
        if (!await window.prism.fs.trash(path)) throw new Error('Não foi possível mover o arquivo para a lixeira')
        return { code: 0 }
      }
      return window.prism.git.discard(root, file.path, file.untracked, remoteId)
    })
    if (ok) setDiscardFile(null)
  }
  const matches = filterGitFiles(files, query).length
  return <section className="pg-repo" aria-label={`Repositório ${basename(root)}`}>
    <div className="pg-repo-header">
      {multi && <button className="pg-repo-toggle" onClick={() => setCollapsed(!collapsed)} aria-expanded={!collapsed}>{collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}<span>{basename(root)}</span><span className="pg-count">{files.length}</span></button>}
      <div className="pg-branch-bar">
        <DropdownMenu open={pickerOpen} onOpenChange={(open) => { setPickerOpen(open); setBranchFilter('') }} onContentKeyDown={(event) => {
          const input = event.currentTarget.querySelector<HTMLInputElement>('input')
          if (!input) return
          if (event.key === 'Tab') {
            event.preventDefault()
            const targets = [input, ...event.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])')]
            const index = targets.indexOf(document.activeElement as HTMLElement)
            targets[(index + (event.shiftKey ? -1 : 1) + targets.length) % targets.length]?.focus()
          } else if (event.target === input && (event.key === 'Home' || event.key === 'End')) {
            event.preventDefault()
            const position = event.key === 'Home' ? 0 : input.value.length
            if (event.shiftKey) input.setSelectionRange(Math.min(input.selectionStart ?? position, position), Math.max(input.selectionEnd ?? position, position), event.key === 'Home' ? 'backward' : 'forward')
            else input.setSelectionRange(position, position)
          } else if (event.target !== input && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && event.key !== ' ') {
            event.preventDefault(); input.focus(); setBranchFilter((current) => current + event.key)
          }
        }} className="pg-branch-menu" label="Trocar de branch" trigger={<Button variant="muted" size="sm" className="pg-branch-trigger" disabled={busy}><GitBranch size={14} /><span>{status.branch || 'Sem commits'}</span>{Boolean(status.ahead) && <span className="pg-sync-count">↑{status.ahead}</span>}{Boolean(status.behind) && <span className="pg-sync-count">↓{status.behind}</span>}<ChevronDown size={12} /></Button>}>
          <BranchSearchInput value={branchFilter} onChange={setBranchFilter} onSubmit={() => { if (exactExists) void checkout(branchFilter.trim()); else void createBranch() }} />
          {branchError ? <div className="pg-error" role="alert">{branchError}</div> : !branches ? <div className="pg-branch-empty"><Spinner label="Carregando branches" /> Carregando…</div> : <>
            {branchFilter.trim() && !exactExists && <DropdownMenuItem onSelect={() => void createBranch()} disabled={busy}><GitBranchPlus size={14} />Criar branch “{branchFilter.trim()}”</DropdownMenuItem>}
            {localMatches.map((branch) => <DropdownMenuItem key={`local:${branch}`} onSelect={() => { if (branch === branches.current) setPickerOpen(false); else void checkout(branch) }} disabled={busy}><GitBranch size={14} /><span className="pg-menu-label">{branch}</span>{branch === branches.current && <Check size={14} />}</DropdownMenuItem>)}
            {remoteMatches.length > 0 && <><DropdownMenuSeparator /><DropdownMenuLabel>Remotas</DropdownMenuLabel></>}
            {remoteMatches.map((branch) => <DropdownMenuItem key={`remote:${branch}`} onSelect={() => void checkout(branch.split('/').slice(1).join('/') || branch)} disabled={busy}><GitBranch size={14} /><span className="pg-menu-label">{branch}</span></DropdownMenuItem>)}
            {!localMatches.length && !remoteMatches.length && <div className="pg-branch-empty">Nenhuma branch encontrada</div>}
          </>}
        </DropdownMenu>
        <div className="pg-toolbar">
          <Tooltip label="Buscar atualizações (fetch)"><Button variant="muted" size="icon-xs" aria-label="Buscar atualizações" disabled={busy} onClick={() => void run(() => window.prism.git.fetch(root, remoteId), 'Fetch concluído')}><RefreshCw size={14} /></Button></Tooltip>
          <Tooltip label="Receber alterações (pull)"><Button variant="muted" size="icon-xs" aria-label="Receber alterações" disabled={busy} onClick={() => void run(() => window.prism.git.pull(root, remoteId), 'Pull concluído')}><ArrowDownToLine size={14} /></Button></Tooltip>
          <Tooltip label="Enviar alterações (push)"><Button variant="muted" size="icon-xs" aria-label="Enviar alterações" disabled={busy} onClick={() => void run(() => window.prism.git.push(root, remoteId), 'Push concluído')}><ArrowUpFromLine size={14} /></Button></Tooltip>
        </div>
      </div>
    </div>
    {(!collapsed || query.trim()) && <>
      {groups.conflicts.length > 0 && <div className="pg-conflict-banner" role="status">{groups.conflicts.length} {groups.conflicts.length === 1 ? 'conflito precisa' : 'conflitos precisam'} de resolução</div>}
      <div className="pg-commit">
        <div className="pg-commit-field"><textarea aria-label="Mensagem do commit" placeholder="Mensagem do commit" value={commitMsg} rows={2} onChange={(event) => setCommitMsg(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void commit() } }} /><Tooltip label="Gerar mensagem com IA"><Button className="pg-ai-button" variant="muted" size="icon-sm" aria-label="Gerar mensagem de commit com IA" disabled={generating || busy || !files.length} onClick={() => void genMsg()}>{generating ? <Spinner /> : <Sparkles size={14} />}</Button></Tooltip></div>
        <Button size="sm" className="pg-commit-button" disabled={busy || !commitMsg.trim() || !files.length || Boolean(groups.conflicts.length)} onClick={() => void commit()}>{busy ? <Spinner /> : <GitCommitHorizontal size={14} />}Criar commit{groups.staged.length ? ` (${groups.staged.length})` : ''}</Button>
      </div>
      {query.trim() && !matches ? <div className="pg-empty pg-empty-small">Nenhum arquivo corresponde a “{query.trim()}”.</div> : <div className="pg-sections">{SECTIONS.map((section) => {
        const sectionFiles = section === 'working' ? [...groups.working, ...groups.untracked] : groups[section]
        if (section === 'conflicts' && !sectionFiles.length) return null
        const visible = filterGitFiles(sectionFiles, query)
        if (query.trim() && !visible.length) return null
        const closed = !query.trim() && sectionsCollapsed.has(section)
        const sectionStats = visible.map((file) => section === 'staged' ? file.stagedStats : file.workingStats).filter((stats) => stats !== undefined)
        const insertions = sectionStats.reduce((sum, stats) => sum + stats.insertions, 0)
        const deletions = sectionStats.reduce((sum, stats) => sum + stats.deletions, 0)
        return <div className="pg-section" key={section}>
          <div className={`pg-section-header${!sectionFiles.length ? ' is-empty' : ''}`}>
            <button className="pg-section-toggle" aria-expanded={!closed} onClick={() => setSectionsCollapsed((old) => { const next = new Set(old); if (next.has(section)) next.delete(section); else next.add(section); return next })}>{closed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}<span>{SECTION_LABELS[section]}</span><span className="pg-count">{query.trim() ? visible.length : sectionFiles.length}</span></button>
            {sectionStats.length > 0 && <span className="pg-diff-stats"><span>+{insertions}</span><span>−{deletions}</span></span>}
            {sectionFiles.length > 0 && section !== 'conflicts' && <Tooltip label={section === 'staged' ? 'Retirar tudo da preparação' : 'Preparar todas as alterações'}><Button variant="muted" size="icon-xs" disabled={busy} aria-label={section === 'staged' ? 'Retirar tudo da preparação' : 'Preparar todas as alterações'} onClick={() => void run(() => section === 'staged' ? window.prism.git.unstageAll(root, remoteId) : window.prism.git.stageAll(root, remoteId))}>{section === 'staged' ? <Minus size={13} /> : <Plus size={13} />}</Button></Tooltip>}
          </div>
          {!closed && <GitFileList files={sectionFiles} section={section} query={query} tree={tree} activeFile={(section === 'staged' ? activeScope === 'staged' : activeScope !== 'staged') ? activeFile : null} busy={busy} onOpen={(file, source) => void openDiffFor(file, source)} onStage={(file) => void run(() => window.prism.git.stage(root, file.path, remoteId))} onUnstage={(file) => void run(() => window.prism.git.unstage(root, file.path, remoteId))} onDiscard={setDiscardFile} />}
        </div>
      })}</div>}
      {!files.length && <div className="pg-empty pg-empty-small"><Check size={18} /><span>Sem alterações</span></div>}
    </>}
    {discardFile && <ConfirmDiscardDialog file={discardFile} remote={Boolean(remoteId)} busy={busy} onCancel={() => setDiscardFile(null)} onConfirm={() => void discard()} />}
  </section>
}
