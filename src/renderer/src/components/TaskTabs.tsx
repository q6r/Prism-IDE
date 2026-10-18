import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { ChevronDown, Folder, MessageSquareCheck, MessageSquareWarning, MessageSquareX, Pencil, Pin, Plus, RotateCcw, X } from 'lucide-react'
import { useAgentTasks } from '../lib/agentTasks'
import { useAgentChats } from '../lib/agentChats'
import { useStore } from '../store'
import type { AgentTask } from '../../../shared/agents'
import { Button, DropdownMenu, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuShortcut, Spinner, Tooltip, cn } from './ui'
import { PointMenu, TipButton } from './agents-list/parts'
import { trackUnreadOutcomes, useUnreadOutcomes } from './agents-list/unread'
import { dropOrder, openTaskList, taskStatuses, type TaskStatus } from './agents-list/model'
import '../styles/agents-list.css'

const tasksApi = () => useAgentTasks.getState()
const MOD = /Mac/i.test(navigator.platform) ? '⌘' : 'Ctrl'

const STATUS_LABEL: Record<Exclude<TaskStatus, 'idle'>, string> = {
  failure: 'Tarefa precisa de atenção', waiting: 'Tarefa aguardando você', running: 'Atividade da tarefa em andamento', done: 'Tarefa concluída'
}
/** The tab's leading status (TabLeadingIcon): failure, waiting, running, unread done; a pin when idle. */
function TabStatusIcon({ status, pinned }: { status: TaskStatus; pinned: boolean }) {
  if (status === 'running') return <Spinner tone="muted" label={STATUS_LABEL.running} />
  if (status === 'failure') return <MessageSquareX className="al-tone-failure" role="img" aria-label={STATUS_LABEL.failure} />
  if (status === 'waiting') return <MessageSquareWarning className="al-tone-approval" role="img" aria-label={STATUS_LABEL.waiting} />
  if (status === 'done') return <MessageSquareCheck className="al-tone-done" role="img" aria-label={STATUS_LABEL.done} />
  if (pinned) return <Pin className="al-tab-pin" role="img" aria-label="Tarefa fixada" />
  return null
}

/**
 * The task tab strip in the title bar (Traycer's TabStrip): the task list
 * menu, one tab per open task - leading status icon, faded title, close on
 * hover, separators between resting tabs, the active one in its own box -
 * and the new-task button. Double-click edits the title in place; right-click
 * opens the tab menu; tabs reorder by dragging; Mod+Shift+T reopens the last
 * closed tab while the Agents view is up.
 */
export default function TaskTabs() {
  const { allTasks, openIds, activeId, closedIds } = useAgentTasks(useShallow((s) => ({ allTasks: s.tasks, openIds: s.openIds, activeId: s.activeId, closedIds: s.closedIds })))
  const unread = useUnreadOutcomes((s) => s.outcomes)
  // One pass over the chats per store change, compared shallowly: streaming output does not re-render the strip.
  const statuses = useAgentChats(useShallow((s) => taskStatuses(s.chats, s.runtime, unread)))
  const [rename, setRenameState] = useState<{ id: string; value: string } | null>(null)
  // Read by blur: Escape clears it before the input's blur can commit.
  const renameRef = useRef<{ id: string; value: string } | null>(null)
  const [menu, setMenu] = useState<{ task: AgentTask; point: { x: number; y: number }; el: HTMLElement } | null>(null)
  const [drop, setDrop] = useState<{ id: string; side: 'before' | 'after' } | null>(null)
  const [listOpen, setListOpen] = useState(false)
  const dragging = useRef<string | null>(null)
  const strip = useRef<HTMLDivElement>(null)
  useEffect(() => { trackUnreadOutcomes(); void tasksApi().init().catch((err: Error) => useStore.getState().addToast('error', err.message)) }, [])
  useEffect(() => {
    strip.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeId])
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey || e.key.toLowerCase() !== 't') return
      if (useStore.getState().workspaceView !== 'agents') return
      e.preventDefault()
      tasksApi().reopenClosed()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const tasks = openTaskList(allTasks, openIds)
  const menuPinned = !!(menu && allTasks.find((t) => t.id === menu.task.id)?.pinned)
  const recent = allTasks.filter((t) => !openIds.includes(t.id)).sort((a, b) => b.updatedAt - a.updatedAt)
  const reopenable = closedIds.some((id) => allTasks.some((t) => t.id === id) && !openIds.includes(id))
  const focusTab = (id: string): void => {
    requestAnimationFrame(() => {
      const focused = document.activeElement
      if (focused && focused !== document.body && !strip.current?.contains(focused)) return
      strip.current?.querySelector<HTMLElement>(`[role="tab"][data-task-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true })
    })
  }
  const setRename = (next: { id: string; value: string } | null): void => {
    const was = renameRef.current
    renameRef.current = next
    setRenameState(next)
    if (was && !next) focusTab(was.id)
  }
  const commitRename = (): void => { const r = renameRef.current; if (r) tasksApi().rename(r.id, r.value); setRename(null) }

  const onDragOver = (e: DragEvent<HTMLDivElement>, id: string): void => {
    if (!e.dataTransfer.types.includes('text/prism-task') || !dragging.current) return
    const box = e.currentTarget.getBoundingClientRect()
    const side = e.clientX < box.left + box.width / 2 ? 'before' : 'after'
    // A drop that would leave the strip as it is (behind the pinned tabs, onto itself) shows no marker and is not a target.
    if (!dropOrder(allTasks, openIds, dragging.current, id, side)) { setDrop((d) => d?.id === id ? null : d); return }
    e.preventDefault()
    setDrop((d) => d?.id === id && d.side === side ? d : { id, side })
  }
  const onDrop = (e: DragEvent<HTMLDivElement>, target: string): void => {
    e.preventDefault()
    const id = dragging.current, side = drop?.id === target ? drop.side : null
    setDrop(null)
    const next = id && side ? dropOrder(allTasks, openIds, id, target, side) : null
    if (next) tasksApi().arrange(next)
  }
  const onTabKey = (e: KeyboardEvent<HTMLDivElement>, task: AgentTask, index: number): void => {
    const focusAt = (i: number): void => {
      const all = strip.current?.querySelectorAll<HTMLElement>('[role="tab"]')
      if (all?.length) all[(i + all.length) % all.length].focus()
    }
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tasksApi().activate(task.id) }
    else if (e.key === 'ArrowRight') { e.preventDefault(); focusAt(index + 1) }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); focusAt(index - 1) }
    else if (e.key === 'F2') { e.preventDefault(); setRename({ id: task.id, value: task.title }) }
    else if (e.key === 'Delete') { e.preventDefault(); tasksApi().close(task.id); requestAnimationFrame(() => strip.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus()) }
    else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault()
      const box = e.currentTarget.getBoundingClientRect()
      setMenu({ task, point: { x: box.left + 12, y: box.bottom }, el: e.currentTarget })
    }
  }

  // While one of the strip's menus is open its ground stops dragging the window,
  // or the drag region would swallow clicks on a menu drawn over it.
  return <div className="al-root al-tabs" data-suppressed={menu || listOpen ? 'true' : undefined}>
    <DropdownMenu open={listOpen} onOpenChange={setListOpen} side="bottom" align="start" sideOffset={6} className="al-menu al-tasks-menu" label="Tarefas abertas e recentes"
      trigger={<TipButton tip="Tarefas abertas e recentes" tipSide="bottom" variant="muted" size="icon-sm" className="al-tabs-btn" aria-label="Tarefas abertas e recentes"><ChevronDown /></TipButton>}>
      <DropdownMenuLabel>Abertas</DropdownMenuLabel>
      {tasks.map((t) => <DropdownMenuRadioItem key={t.id} checked={t.id === activeId} onSelect={() => tasksApi().activate(t.id)}>
        <Folder /><span className="al-task-option"><span className="tr-truncate">{t.title}</span><span className="al-task-path tr-truncate">{t.cwd || 'Escolha uma pasta'}</span></span>
      </DropdownMenuRadioItem>)}
      {recent.length ? <>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Recentes</DropdownMenuLabel>
        {recent.map((t) => <DropdownMenuItem key={t.id} onSelect={() => tasksApi().activate(t.id)}>
          <Folder /><span className="al-task-option"><span className="tr-truncate">{t.title}</span><span className="al-task-path tr-truncate">{t.cwd || 'Escolha uma pasta'}</span></span>
        </DropdownMenuItem>)}
      </> : null}
    </DropdownMenu>
    <div ref={strip} className="al-tabstrip" role="tablist" aria-label="Tarefas abertas" onWheel={(e) => { if (e.deltaY) e.currentTarget.scrollLeft += e.deltaY }}>
      {tasks.map((t, i) => {
        const active = t.id === activeId
        const nextActive = tasks[i + 1]?.id === activeId
        const status = statuses[t.id] ?? 'idle'
        const editing = rename?.id === t.id
        const tab = <div role="tab" aria-selected={active} tabIndex={active ? 0 : -1} data-task-id={t.id}
          className={cn('al-tab', active && 'active', editing && 'editing')}
          onClick={() => tasksApi().activate(t.id)}
          onDoubleClick={() => setRename({ id: t.id, value: t.title })}
          onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); tasksApi().close(t.id) } }}
          onContextMenu={(e) => { e.preventDefault(); setMenu({ task: t, point: { x: e.clientX, y: e.clientY }, el: e.currentTarget }) }}
          onKeyDown={(e) => { if (e.target === e.currentTarget) onTabKey(e, t, i) }}>
          <span aria-hidden="true" className="al-tab-box" />
          {t.color ? <span aria-hidden="true" className="al-tab-color" style={{ background: t.color }} /> : null}
          <span className="al-tab-content">
            <span className="al-tab-status"><TabStatusIcon status={status} pinned={!!t.pinned} /></span>
            {editing
              ? <input className="al-tab-input" autoFocus value={rename.value} maxLength={100} aria-label="Editar título da tarefa"
                onFocus={(e) => e.currentTarget.select()} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}
                onChange={(e) => setRename({ id: t.id, value: e.target.value })} onBlur={commitRename}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter') { e.preventDefault(); commitRename() }
                  else if (e.key === 'Escape') { e.preventDefault(); setRename(null) }
                }} />
              : <span className="al-tab-label">
                <span className="al-tab-title">{t.title}</span>
                <span className="al-tab-trailing">
                  <Button variant="muted" size="icon-xs" className="al-tab-close" aria-label={`Fechar ${t.title}`} tabIndex={-1}
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); tasksApi().close(t.id) }}><X /></Button>
                </span>
              </span>}
          </span>
          {!active && !nextActive && i < tasks.length - 1 ? <span aria-hidden="true" className="al-tab-sep" /> : null}
          {drop?.id === t.id ? <span aria-hidden="true" className={cn('al-tab-drop', drop.side)} /> : null}
        </div>
        return <div key={t.id} className="al-tab-frame" draggable={!editing}
          onDragStart={(e) => { dragging.current = t.id; e.dataTransfer.setData('text/prism-task', t.id); e.dataTransfer.effectAllowed = 'move' }}
          onDragOver={(e) => onDragOver(e, t.id)} onDragLeave={() => setDrop((d) => d?.id === t.id ? null : d)}
          onDrop={(e) => onDrop(e, t.id)} onDragEnd={() => { dragging.current = null; setDrop(null) }}>
          {editing ? tab : <Tooltip side="bottom" delay={700} label={<span className="al-tab-tip"><strong>{t.title}</strong><span>{t.cwd || 'Sem pasta'}</span>
            {status !== 'idle' ? <span>{STATUS_LABEL[status]}</span> : null}</span>}>{tab}</Tooltip>}
        </div>
      })}
    </div>
    <TipButton tip="Nova tarefa" tipSide="bottom" variant="muted" size="icon-sm" className="al-tabs-btn al-tab-new" aria-label="Nova tarefa" onClick={() => tasksApi().create()}><Plus /></TipButton>
    {menu ? <PointMenu point={menu.point} label={`Ações da tarefa ${menu.task.title}`} returnFocus={menu.el} onClose={() => setMenu(null)}>
      <DropdownMenuItem onSelect={() => setRename({ id: menu.task.id, value: menu.task.title })}><Pencil />Editar título</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => tasksApi().pin(menu.task.id)}><Pin className={menuPinned ? 'al-fill' : undefined} />{menuPinned ? 'Desafixar tarefa' : 'Fixar tarefa'}</DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={() => tasksApi().close(menu.task.id)}><X />Fechar aba</DropdownMenuItem>
      <DropdownMenuItem disabled={tasks.length < 2} onSelect={() => { tasksApi().activate(menu.task.id); for (const t of tasks) if (t.id !== menu.task.id) tasksApi().close(t.id) }}><X />Fechar outras abas</DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem disabled={!reopenable} onSelect={() => tasksApi().reopenClosed()}><RotateCcw />Reabrir aba fechada<DropdownMenuShortcut>{MOD}+Shift+T</DropdownMenuShortcut></DropdownMenuItem>
    </PointMenu> : null}
  </div>
}
