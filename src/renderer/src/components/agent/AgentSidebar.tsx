import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Archive, ArchiveRestore, ChevronDown, Copy, CopyMinus, Download, FolderOpen, History, MessagesSquare, MoreHorizontal, Pencil, Plus, RefreshCw, Search, SearchX, Trash2, Users } from 'lucide-react'
import { useAgentChats } from '../../lib/agentChats'
import { useAgentTasks } from '../../lib/agentTasks'
import { useStore } from '../../store'
import { DropdownMenu, DropdownMenuItem, DropdownMenuSeparator } from '../ui'
import ChatTree, { type ChatTreeRowContext } from '../ChatTree'
import TraycerBrowser from '../TraycerBrowser'
import { AgentsFilterMenu } from '../agents-list/AgentsFilterMenu'
import { StatusGlyph } from '../agents-list/StatusGlyph'
import { ConfirmDialog, EmptyState, IdleTime, PanelSearchField, PointMenu, TipButton } from '../agents-list/parts'
import { trackUnreadOutcomes, useUnreadOutcomes } from '../agents-list/unread'
import { branchOpen, panelExpansion, useTreeExpansion } from '../agents-list/expansion'
import { chatRows, type ChatRow } from '../agents-list/selectors'
import { adoptLegacyView, useAgentViews, useTaskView } from '../agents-list/views'
import {
  chatStatusKind, emptyReason, harnessOf, isViewActive, matchesQuery, parentIds,
  rollupStatus, rollupSummary, rollupWins, runStates, visibleChats, type AgentView, type ChatStatusKind
} from '../agents-list/model'
import '../../styles/agents-list.css'
import AgentWorkingDirectoryDialog from './AgentWorkingDirectoryDialog'

const WIDTH_KEY = 'prism.agents.sidebarWidth'
const MIN_WIDTH = 200, MAX_WIDTH = 480, DEFAULT_WIDTH = 272
const harnessName = (h: string): string => h === 'claude' || h === 'claude-code' ? 'Claude Code' : h === 'codex' ? 'Codex' : h
const folderOf = (path: string): string => path.split(/[\\/]/).filter(Boolean).at(-1) || 'Sem pasta'
function readStored<T>(key: string, parse: (raw: unknown) => T, fallback: T): T {
  try { const raw = localStorage.getItem(key); return raw ? parse(JSON.parse(raw)) : fallback } catch { return fallback }
}
function writeStored(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* storage unavailable: keep the in-memory value */ }
}
const chats = () => useAgentChats.getState()
const toastError = (err: Error): void => useStore.getState().addToast('error', err.message)

/**
 * The agents column of the agent workspace - Traycer's epic sidebar with its
 * "Agents" panel: the workspace switcher, the panel header (add, more, view
 * menu, or the search row while searching), the chat tree, and the column's
 * foot with the Traycer view, imports and accounts.
 *
 * It subscribes to list-shaped slices only (rows without turns, run states),
 * so streaming output does not re-render it.
 */
export default function AgentSidebar({ onNewChat }: { onNewChat: () => void }) {
  const ready = useAgentChats((s) => s.ready)
  const activeId = useAgentChats((s) => s.activeId)
  const rows = useAgentChats(useShallow((s) => chatRows(s.chats)))
  const runs = useAgentChats(useShallow((s) => runStates(s.runtime)))
  const taskId = useAgentTasks((s) => s.activeId)
  const tasksReady = useAgentTasks((s) => s.ready)
  const restoringChats = useAgentTasks((s) => s.restoringChats)
  const folderName = useStore((s) => s.folderName)
  const folderPath = useStore((s) => s.folderPath)
  const unread = useUnreadOutcomes((s) => s.outcomes)
  const panelKey = taskId ?? ''
  const expansion = useTreeExpansion(useShallow((s) => panelExpansion(s.panels, panelKey)))
  const view = useTaskView(taskId)
  const [width, setWidth] = useState(() => readStored(WIDTH_KEY, (v) => typeof v === 'number' ? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, v)) : DEFAULT_WIDTH, DEFAULT_WIDTH))
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [renaming, setRenamingState] = useState<{ id: string; value: string } | null>(null)
  // The live rename, read by blur: Escape clears it before the input's blur can commit.
  const renameRef = useRef<{ id: string; value: string } | null>(null)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [directoryChatId, setDirectoryChatId] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ chat: ChatRow; point: { x: number; y: number }; row: HTMLElement } | null>(null)
  const [traycerOpen, setTraycerOpen] = useState(false)
  const rootRef = useRef<HTMLElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const moreRef = useRef<HTMLButtonElement>(null)
  useEffect(() => trackUnreadOutcomes(), [])

  const byId = useMemo(() => new Map(rows.map((c) => [c.id, c])), [rows])
  const byIdRef = useRef(byId)
  byIdRef.current = byId
  // The open chat's branch is always reachable: its ancestors open when it becomes active.
  useEffect(() => {
    if (!activeId) return
    const ancestors: string[] = [], seen = new Set([activeId])
    for (let p = byIdRef.current.get(activeId)?.parentChatId; p && !seen.has(p) && byIdRef.current.has(p); p = byIdRef.current.get(p)?.parentChatId) { seen.add(p); ancestors.push(p) }
    if (ancestors.length) useTreeExpansion.getState().reveal(panelKey, ancestors)
  }, [activeId, panelKey])

  // The view belongs to the open task (Traycer keeps it per epic).
  useEffect(() => { if (taskId) adoptLegacyView(taskId) }, [taskId])
  const setView = (next: AgentView): void => { if (taskId) useAgentViews.getState().setView(taskId, next) }
  const pinned = useMemo(() => new Set([activeId, ...Object.keys(runs), ...Object.keys(unread)].filter((id): id is string => !!id)), [activeId, runs, unread])
  const list = useMemo(() => visibleChats(rows, taskId, view, pinned), [rows, taskId, view, pinned])
  const empty = emptyReason(rows, taskId, view, list.length, pinned)
  const deleting = deleteId ? byId.get(deleteId) : undefined

  /** Moves focus to `id`'s row, or its nearest neighbour once the row is gone - never to the page. */
  const refocusNear = useCallback((id: string): void => {
    const ids = [...(rootRef.current?.querySelectorAll<HTMLElement>('.al-row[data-node-id]') ?? [])].map((el) => el.dataset.nodeId!)
    const at = ids.indexOf(id)
    requestAnimationFrame(() => {
      const root = rootRef.current, focused = document.activeElement
      if (!root || (focused && focused !== document.body && !root.contains(focused))) return
      const row = (target: string | undefined): HTMLElement | null => target ? root.querySelector<HTMLElement>(`.al-row[data-node-id="${CSS.escape(target)}"]`) : null
      ;(row(id) ?? row(ids[at + 1]) ?? row(ids[at - 1]) ?? root.querySelector<HTMLElement>('.al-row'))?.focus({ preventScroll: true })
    })
  }, [])

  const setRenaming = (next: { id: string; value: string } | null): void => { renameRef.current = next; setRenamingState(next) }
  const startRename = useCallback((chat: ChatRow): void => { if (!chat.nativeAgent) { renameRef.current = { id: chat.id, value: chat.title }; setRenamingState(renameRef.current) } }, [])
  const commitRename = (): void => { const r = renameRef.current; if (r) chats().rename(r.id, r.value); setRenaming(null) }
  const toggleArchive = useCallback((chat: ChatRow): void => { chats().archive(chat.id, !chat.archived); refocusNear(chat.id) }, [refocusNear])
  const closeSearch = (): void => { setSearchOpen(false); setQuery(''); requestAnimationFrame(() => moreRef.current?.focus()) }
  const openSearch = (): void => { setSearchOpen(true); requestAnimationFrame(() => searchRef.current?.focus()) }
  const newChild = (parent: ChatRow): void => {
    chats().create(parent.cwd, parent.remoteId, { parentChatId: parent.id })
    useTreeExpansion.getState().setOpen(panelKey, parent.id, true)
    // Same hand-off as the panel's own "+": the caret lands in the new agent's composer.
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Mensagem para o agente"]')?.focus())
  }
  const copyId = (chat: ChatRow): void => {
    void navigator.clipboard.writeText(chat.id).then(() => useStore.getState().addToast('success', 'ID copiado.'), () => useStore.getState().addToast('error', 'Não foi possível copiar o ID.'))
  }
  const confirmDelete = (): void => {
    const id = deleteId
    setDeleteId(null)
    if (id) void chats().remove(id).then(() => refocusNear(id), toastError)
  }

  /** The row's actions, shared by the "…" menu and the right-click menu (chatRowMenuEntries). */
  const rowMenuItems = (chat: ChatRow, busy: boolean): ReactNode => <>
    {!chat.nativeAgent ? <><DropdownMenuItem disabled={!ready} onSelect={() => newChild(chat)}><Plus />Novo agente filho</DropdownMenuItem>
    <DropdownMenuItem onSelect={() => startRename(chat)}><Pencil />Renomear</DropdownMenuItem>
    <DropdownMenuItem disabled={busy} onSelect={() => setDirectoryChatId(chat.id)}><FolderOpen />Trocar pasta de trabalho</DropdownMenuItem>
    <DropdownMenuItem disabled={busy} onSelect={() => toggleArchive(chat)}>{chat.archived ? <ArchiveRestore /> : <Archive />}{chat.archived ? 'Desarquivar' : 'Arquivar'}</DropdownMenuItem></> : null}
    <DropdownMenuItem onSelect={() => copyId(chat)}><Copy />Copiar ID</DropdownMenuItem>
    {chat.fromTraycer ? <DropdownMenuItem disabled={busy} onSelect={() => void chats().reimportFromTraycer(chat.id)}><RefreshCw />Atualizar do Traycer</DropdownMenuItem> : null}
    {!chat.nativeAgent ? <><DropdownMenuSeparator />
    <DropdownMenuItem variant="destructive" disabled={busy} onSelect={() => setDeleteId(chat.id)}><Trash2 />Excluir</DropdownMenuItem></> : null}
  </>
  const rowMenuRef = useRef(rowMenuItems)
  rowMenuRef.current = rowMenuItems

  // Row renderers, stable while nothing they read changes, so memoized rows skip re-rendering.
  const statusOf = useCallback((chat: ChatRow): ChatStatusKind => {
    if (chat.nativeStatus) return chat.nativeStatus === 'completed' ? 'done' : chat.nativeStatus === 'failed' ? 'failure'
      : chat.nativeStatus === 'stopped' ? 'idle' : 'running'
    const run = runs[chat.id]
    return chatStatusKind({ busy: !!run, permission: run === 'approval', question: run === 'interview', unread: unread[chat.id], readOnly: chat.readOnly && !chat.nativeAgent })
  }, [runs, unread])
  const icon = useCallback((chat: ChatRow, ctx: ChatTreeRowContext<ChatRow>): ReactNode => {
    const own = statusOf(chat)
    if (ctx.hasChildren && !ctx.expanded) {
      const rollup = rollupStatus(ctx.descendants.map(statusOf))
      if (rollup && rollupWins(own, rollup)) {
        const title = rollupSummary(rollup)
        return <span role="status" aria-label={title} title={title} className="al-rollup"><StatusGlyph kind={rollup.kind} label={null} /></span>
      }
    }
    return <StatusGlyph kind={own} />
  }, [statusOf])
  const trailing = useCallback((chat: ChatRow): ReactNode => <IdleTime at={chat.updatedAt} />, [])
  const controlSlots = useCallback((chat: ChatRow): 1 | 2 => runs[chat.id] || chat.nativeAgent ? 1 : 2, [runs])
  const controls = useCallback((c: ChatRow): ReactNode => {
    const busy = !!runs[c.id]
    return <>
      {busy || c.nativeAgent ? null : <TipButton tip={c.archived ? `Desarquivar ${c.title}` : `Arquivar ${c.title}`} variant="ghost" size="icon-xs" className="al-ctl al-ctl-archive"
        aria-label={c.archived ? `Desarquivar ${c.title}` : `Arquivar ${c.title}`} onClick={(e) => { e.stopPropagation(); toggleArchive(c) }}>
        {c.archived ? <ArchiveRestore /> : <Archive />}
      </TipButton>}
      <DropdownMenu side="bottom" align="end" className="al-menu" label={`Ações do agente ${c.title}`}
        trigger={<TipButton tip="Mais ações" variant="ghost" size="icon-xs" className="al-ctl al-ctl-more" aria-label={`Ações do agente ${c.title}`}><MoreHorizontal /></TipButton>}>
        {rowMenuRef.current(c, busy)}
      </DropdownMenu>
    </>
  }, [runs, toggleArchive])
  const tooltip = useCallback((c: ChatRow): ReactNode => {
    const run = runs[c.id]
    return <span className="al-row-tip"><strong>{c.title}</strong><span>{harnessName(harnessOf(c))} · {folderOf(c.cwd)}</span>
      {c.nativeAgent ? <span>Subagente nativo · vinculado à conversa principal</span> : null}
      {run ? <span>{run === 'approval' ? 'Aguardando permissão' : run === 'interview' ? 'Aguardando resposta' : 'Em execução'}</span> : null}</span>
  }, [runs])
  const rowLabel = useCallback((c: ChatRow): string => [c.title, c.archived && 'arquivado', runs[c.id] && 'em execução', c.readOnly && !c.nativeAgent && 'somente leitura'].filter(Boolean).join(', '), [runs])
  const onSelect = useCallback((id: string) => chats().select(id), [])
  const onContextMenu = useCallback((c: ChatRow, point: { x: number; y: number }, row: HTMLElement) => setMenu({ chat: c, point, row }), [])
  const isOpen = useCallback((id: string, depth: number) => branchOpen(expansion, id, depth), [expansion])
  const onToggle = useCallback((id: string, open: boolean) => useTreeExpansion.getState().setOpen(panelKey, id, open), [panelKey])

  const headerActions = <div className="al-panel-actions">
    {searchOpen ? null : <TipButton tip="Novo agente" variant="muted" size="icon-sm" className="al-header-btn" aria-label="Novo agente" disabled={!ready} onClick={onNewChat}><Plus /></TipButton>}
    <DropdownMenu side="bottom" align="end" sideOffset={6} className="al-menu" label="Mais ações de agentes"
      trigger={<TipButton ref={moreRef} tip="Mais ações de agentes" variant="muted" size="icon-sm" className="al-header-btn" aria-label="Mais ações de agentes"><MoreHorizontal /></TipButton>}>
      {searchOpen ? null : <DropdownMenuItem onSelect={openSearch}><Search />Buscar agentes</DropdownMenuItem>}
      <DropdownMenuItem onSelect={() => useTreeExpansion.getState().collapseAll(panelKey, parentIds(list))}><CopyMinus />Recolher tudo</DropdownMenuItem>
    </DropdownMenu>
    <AgentsFilterMenu view={view} onChange={setView} />
  </div>

  let body: ReactNode
  // Loading is not an empty workspace, even when restoration takes longer.
  if (!ready || !tasksReady || restoringChats) body = <div className="al-empty" role="status">Carregando agentes…</div>
  else if (empty === 'none') body = <EmptyState icon={MessagesSquare} title="Nenhum agente ainda." description="Crie um agente para começar uma conversa nesta tarefa." />
  else if (empty === 'archived') body = <EmptyState icon={Archive} title="Todos os agentes aqui estão arquivados." description={'Escolha "Somente arquivados" ou "Todos os chats" em Mostrar.'} />
  else if (empty === 'no-archived') body = <EmptyState icon={Archive} title="Nenhum agente arquivado corresponde a esta visualização." description={'Escolha "Somente não arquivados" ou "Todos os chats" em Mostrar.'} />
  else if (empty === 'filtered') body = <EmptyState icon={MessagesSquare} title="Nenhum agente corresponde a esta visualização." description="Ajuste os filtros ou redefina a visualização." />
  else if (query.trim() && !list.some((c) => matchesQuery(c.title, query))) body = <EmptyState icon={SearchX} title="Nenhum agente corresponde à sua busca."
    description={isViewActive(view) ? 'Tente outro termo ou redefina a visualização.' : 'Tente outro termo.'} />
  else body = <ChatTree items={list} activeId={activeId} query={query} label="Árvore de agentes" isOpen={isOpen} onToggle={onToggle}
    onSelect={onSelect} icon={icon} trailing={trailing} controlSlots={controlSlots} controls={controls} tooltip={tooltip} rowLabel={rowLabel}
    onRowDoubleClick={startRename} onRowContextMenu={onContextMenu}
    rename={renaming ? { id: renaming.id, value: renaming.value, onChange: (value) => setRenaming({ id: renaming.id, value }), onCommit: commitRename, onCancel: () => setRenaming(null) } : null} />

  const resize = (e: ReactPointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    const startX = e.clientX, startWidth = width
    let latest = startWidth
    const move = (ev: PointerEvent): void => { latest = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + ev.clientX - startX)); setWidth(latest) }
    const up = (): void => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); document.body.classList.remove('al-resizing'); writeStored(WIDTH_KEY, latest) }
    document.body.classList.add('al-resizing')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const menuChat = menu ? byId.get(menu.chat.id) ?? menu.chat : null

  return <>
    <aside ref={rootRef} className="al-root al-sidebar" aria-label="Agentes" style={{ width }}>
      <div className="al-workspace">
        <button type="button" className="al-workspace-trigger" onClick={() => void useStore.getState().openFolderDialog()} title={folderPath || undefined}>
          <span className="al-workspace-text">
            <span className="al-workspace-name">{folderName || 'Prism Workspace'}</span>
            <span className="al-workspace-path">{folderPath || 'Escolha uma pasta'}</span>
          </span>
          <ChevronDown aria-hidden />
        </button>
      </div>
      <section className="al-panel" aria-label="Agentes">
        {searchOpen
          ? <div className="al-panel-header search">
            <PanelSearchField inputRef={searchRef} value={query} onValueChange={setQuery} onClose={closeSearch} placeholder="Buscar agentes…" label="Buscar agentes" />
            {headerActions}
          </div>
          : <div className="al-panel-header">
            <div className="al-panel-title"><MessagesSquare aria-hidden /><p>Agentes</p></div>
            {headerActions}
          </div>}
        <div className="al-panel-body">{body}</div>
      </section>
      <div className="al-foot">
        <button type="button" className="al-nav-row" onClick={() => setTraycerOpen(true)}><MessagesSquare aria-hidden /><span>Agentes do Traycer</span></button>
        <DropdownMenu side="top" align="start" sideOffset={6} className="al-menu" label="Importar conversas" matchTriggerWidth
          trigger={<button type="button" className="al-nav-row"><History aria-hidden /><span>Importar conversas</span><ChevronDown aria-hidden className="al-nav-trailing" /></button>}>
          <DropdownMenuItem onSelect={() => useStore.getState().setTraycerImportOpen(true)}><Download />Importar do Traycer</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => useStore.getState().setSidebarView('sessions')}><History />Importar sessões do Claude</DropdownMenuItem>
        </DropdownMenu>
        <button type="button" className="al-nav-row al-account-row" onClick={() => useStore.getState().openSettings('providers')}>
          <Users aria-hidden />
          <span className="al-account-text"><span>Contas de agentes</span><span className="al-account-sub">Claude Code e Codex</span></span>
          <Plus aria-hidden className="al-nav-trailing" />
        </button>
      </div>
      <div className="al-resize" role="separator" aria-orientation="vertical" aria-label="Redimensionar barra de agentes" aria-valuemin={MIN_WIDTH} aria-valuemax={MAX_WIDTH} aria-valuenow={width} tabIndex={0}
        onPointerDown={resize} onDoubleClick={() => { setWidth(DEFAULT_WIDTH); writeStored(WIDTH_KEY, DEFAULT_WIDTH) }}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
          e.preventDefault()
          const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width + (e.key === 'ArrowRight' ? 16 : -16)))
          setWidth(next); writeStored(WIDTH_KEY, next)
        }} />
    </aside>
    {menu && menuChat ? <PointMenu point={menu.point} label={`Ações do agente ${menuChat.title}`} returnFocus={menu.row} onClose={() => setMenu(null)}>
      {rowMenuItems(menuChat, !!runs[menuChat.id])}
    </PointMenu> : null}
    {traycerOpen ? <TraycerBrowser onClose={() => setTraycerOpen(false)} onImport={() => { setTraycerOpen(false); useStore.getState().setTraycerImportOpen(true) }} /> : null}
    {directoryChatId && <AgentWorkingDirectoryDialog key={directoryChatId} chatId={directoryChatId} onClose={() => setDirectoryChatId(null)} />}
    {deleting ? <ConfirmDialog title={`Excluir o agente "${deleting.title}"?`}
      description="Esta ação não pode ser desfeita. O histórico salvo no Prism será excluído; as sessões da CLI continuam no disco."
      detail={rows.some((c) => c.parentChatId === deleting.id) ? <p className="al-dialog-desc">Os agentes aninhados sob ele passam para a raiz da lista.</p> : null}
      actionLabel="Excluir" onCancel={() => setDeleteId(null)} onConfirm={confirmDelete} /> : null}
  </>
}
