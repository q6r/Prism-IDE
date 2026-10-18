import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ClipboardPaste, Copy, Eraser, MessageSquarePlus, MoreHorizontal, Pencil, Plus, SplitSquareHorizontal, Terminal as TerminalIcon, TerminalSquare, Trash2, X } from 'lucide-react'
import { useStore } from '../store'
import { Badge, Button, DropdownMenu, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, Spinner, Tooltip, cn } from './ui'
import TerminalPane, { type PaneApi } from './terminal/TerminalPane'
import { adoptTerminals, removeTerminalPane, type TerminalLayout } from './terminal/model'
import '@xterm/xterm/css/xterm.css'
import '../styles/terminal.css'

const newPaneId = (): string => `pane-${crypto.randomUUID()}`
const newGroupId = (): string => `group-${crypto.randomUUID()}`
const initialLayout = (): TerminalLayout => {
  const group = { id: newGroupId(), panes: [newPaneId()] }
  return { groups: [group], activeGroup: group.id, activePane: group.panes[0] }
}
const emptyLayout: TerminalLayout = { groups: [], activeGroup: '', activePane: '' }
function IconAction({ label, children, onClick }: { label: string; children: ReactNode; onClick: () => void }) {
  return <Tooltip label={label}><Button variant="ghost" size="icon-sm" aria-label={label} onClick={onClick}>{children}</Button></Tooltip>
}

export default function TerminalPanel() {
  const toggleTerminal = useStore((s) => s.toggleTerminal)
  const height = useStore((s) => s.settings.terminalHeight)
  const remote = useStore((s) => s.remote)
  const remoteId = remote?.id ?? null
  const pendingTermCmd = useStore((s) => s.pendingTermCmd)
  const consumeTermCmd = useStore((s) => s.consumeTermCmd)
  const sendChatAttachment = useStore((s) => s.sendChatAttachment)
  const addToast = useStore((s) => s.addToast)
  const folderPath = useStore((s) => s.folderPath)
  // Local terminals first ask the host which ones are still running unseen
  // (a reopened window) and adopt them; SSH starts fresh right away.
  const [restoring, setRestoring] = useState(!remoteId)
  const [layout, setLayout] = useState<TerminalLayout>(() => remoteId ? initialLayout() : emptyLayout)
  const [adopted, setAdopted] = useState<Record<string, string>>({})
  const layoutRef = useRef(layout)
  layoutRef.current = layout
  const [labels, setLabels] = useState<Record<string, string>>({})
  const [names, setNames] = useState<Record<string, string>>({})
  const [platform, setPlatform] = useState<'win' | 'unix'>('win')
  const [menu, setMenu] = useState<{ paneId: string; x: number; y: number } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const apisRef = useRef(new Map<string, PaneApi>())
  const transportRef = useRef(remoteId)
  const { groups, activeGroup, activePane } = layout
  useEffect(() => {
    let mounted = true
    void window.prism.app.info().then((info) => { if (mounted) setPlatform(info.platform === 'win32' ? 'win' : 'unix') }).catch(() => {})
    return () => { mounted = false }
  }, [])
  useEffect(() => {
    if (!restoring) return
    let mounted = true
    void window.prism.terminal.list().catch(() => []).then((terminals) => {
      // The window may have switched to SSH meanwhile; that resets the layout.
      if (!mounted || transportRef.current !== null) return
      const unseen = terminals.filter((terminal) => terminal.attached === 0).map((terminal) => terminal.id)
      const restored = adoptTerminals(unseen, useStore.getState().pendingTermCmd !== null, newPaneId, newGroupId)
      setAdopted(restored.adopted)
      setLayout(restored.layout)
      setRestoring(false)
    })
    return () => { mounted = false }
    // Once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (transportRef.current === remoteId) return
    transportRef.current = remoteId
    apisRef.current.clear()
    setRestoring(false)
    setAdopted({})
    setLayout(initialLayout())
    setLabels({})
    setNames({})
    setMenu(null)
    setRenaming(null)
  }, [remoteId])
  useEffect(() => {
    document.getElementById(`terminal-tab-${activeGroup}`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeGroup])
  const defaultLabel = remoteId ? 'ssh' : platform === 'win' ? 'powershell' : 'bash'
  const labelFor = (id: string): string => names[id] || labels[id] || defaultLabel
  const focusPane = (gid: string, pid: string): void => {
    setLayout((previous) => ({ ...previous, activeGroup: gid, activePane: pid }))
    requestAnimationFrame(() => apisRef.current.get(pid)?.focus())
  }
  const newTerminal = (): void => {
    const gid = newGroupId(), pid = newPaneId()
    setLayout((previous) => ({ groups: [...previous.groups, { id: gid, panes: [pid] }], activeGroup: gid, activePane: pid }))
  }
  const split = (): void => {
    const pid = newPaneId()
    setLayout((previous) => ({ ...previous, activePane: pid,
      groups: previous.groups.map((group) => group.id === previous.activeGroup ? { ...group, panes: [...group.panes, pid] } : group) }))
  }
  const closePane = useCallback((pid: string): void => {
    const previous = layoutRef.current
    const next = removeTerminalPane(previous, pid)
    if (next === previous) return
    layoutRef.current = next
    apisRef.current.delete(pid)
    setLayout(next)
    setMenu(null)
    if (!next.groups.length && useStore.getState().terminalOpen) useStore.getState().toggleTerminal()
  }, [])
  const closeGroup = (gid: string): void => {
    for (const pid of layoutRef.current.groups.find((group) => group.id === gid)?.panes ?? []) closePane(pid)
  }
  const clipboardError = (): void => addToast('error', 'Não foi possível acessar a área de transferência')
  const copyPane = (pid: string): void => {
    const text = apisRef.current.get(pid)?.getSelection()
    if (text) void navigator.clipboard.writeText(text).catch(clipboardError)
  }
  const pastePane = (pid: string): void => {
    void navigator.clipboard.readText().then((text) => { if (text) apisRef.current.get(pid)?.paste(text) }).catch(clipboardError)
  }
  const sendPaneToChat = (pid: string): void => {
    const text = apisRef.current.get(pid)?.getSelection().trim()
    if (!text) { addToast('info', 'Selecione um trecho no terminal primeiro'); return }
    sendChatAttachment({ text, lang: remoteId || platform === 'unix' ? 'bash' : 'powershell',
      source: remote ? `SSH ${remote.host} · ${labelFor(pid)}` : `Terminal · ${labelFor(pid)}` })
    addToast('success', 'Enviado ao chat')
  }
  const startRename = (pid: string): void => { setRenaming(pid); setRenameValue(labelFor(pid)) }
  const commitRename = (): void => {
    if (renaming && renameValue.trim()) setNames((previous) => ({ ...previous, [renaming]: renameValue.trim() }))
    setRenaming(null)
  }
  // Consume after delivery: consuming before retries cancels the effect while SSH starts.
  useEffect(() => {
    if (!pendingTermCmd) return
    let tries = 0
    const deliver = (): boolean => {
      const api = apisRef.current.get(layoutRef.current.activePane)
      if (!api?.input(pendingTermCmd + '\r')) return false
      api.focus()
      consumeTermCmd()
      return true
    }
    if (deliver()) return
    const interval = setInterval(() => {
      if (deliver()) clearInterval(interval)
      else if (++tries >= 150) {
        clearInterval(interval)
        consumeTermCmd()
        addToast('error', 'O terminal não ficou pronto para executar o comando')
      }
    }, 100)
    return () => clearInterval(interval)
  }, [pendingTermCmd, consumeTermCmd, addToast])
  const paneMenu = (pid: string): ReactNode => <>
    <DropdownMenuItem onSelect={() => copyPane(pid)}><Copy size={16} />Copiar<DropdownMenuShortcut>Ctrl+Shift+C</DropdownMenuShortcut></DropdownMenuItem>
    <DropdownMenuItem onSelect={() => pastePane(pid)}><ClipboardPaste size={16} />Colar<DropdownMenuShortcut>Ctrl+Shift+V</DropdownMenuShortcut></DropdownMenuItem>
    <DropdownMenuItem onSelect={() => sendPaneToChat(pid)}><MessageSquarePlus size={16} />Enviar seleção ao chat</DropdownMenuItem>
    <DropdownMenuSeparator />
    <DropdownMenuItem onSelect={() => apisRef.current.get(pid)?.clear()}><Eraser size={16} />Limpar terminal</DropdownMenuItem>
    <DropdownMenuItem onSelect={() => startRename(pid)}><Pencil size={16} />Renomear</DropdownMenuItem>
    <DropdownMenuSeparator />
    <DropdownMenuItem variant="destructive" onSelect={() => closePane(pid)}><Trash2 size={16} />Encerrar terminal</DropdownMenuItem>
  </>
  const paneCount = groups.reduce((count, group) => count + group.panes.length, 0)
  return <section className="prism-terminal-panel" style={{ height }} aria-label="Terminais">
    <div className="prism-terminal-strip" onDoubleClick={(event) => {
      if (!(event.target as Element).closest('[role="tab"], button, input')) newTerminal()
    }}>
      <div className="prism-terminal-strip-start">
        <div className="prism-terminal-tabs tr-no-scrollbar" role="tablist" aria-label="Terminais abertos" onKeyDown={(event) => {
          if ((event.target as Element).closest('input, button')) return
          const index = groups.findIndex((group) => group.id === activeGroup)
          const next = event.key === 'ArrowRight' ? (index + 1) % groups.length : event.key === 'ArrowLeft' ? (index - 1 + groups.length) % groups.length : event.key === 'Home' ? 0 : event.key === 'End' ? groups.length - 1 : -1
          if (next < 0 || !groups[next]) return
          event.preventDefault()
          const group = groups[next]
          setLayout((previous) => ({ ...previous, activeGroup: group.id, activePane: group.panes[0] }))
          requestAnimationFrame(() => document.getElementById(`terminal-tab-${group.id}`)?.focus())
        }}>
          {groups.map((group) => {
            const pid = group.panes.includes(activePane) ? activePane : group.panes[0]
            return <div key={group.id} id={`terminal-tab-${group.id}`} role="tab" tabIndex={group.id === activeGroup ? 0 : -1}
              aria-selected={group.id === activeGroup} aria-controls={`terminal-group-${group.id}`} aria-label={labelFor(pid)}
              className={cn('prism-terminal-tab', group.id === activeGroup && 'is-active')}
              onClick={() => focusPane(group.id, pid)} onDoubleClick={() => startRename(pid)}
              onContextMenu={(event) => { event.preventDefault(); setMenu({ paneId: pid, x: event.clientX, y: event.clientY }) }}
              onKeyDown={(event) => { if (renaming || event.target !== event.currentTarget) return; if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); focusPane(group.id, pid) } }}>
              <TerminalSquare size={14} />
              {renaming === pid && paneCount === 1 ? <input autoFocus className="prism-terminal-rename" aria-label="Renomear terminal" value={renameValue}
                onChange={(event) => setRenameValue(event.target.value)} onClick={(event) => event.stopPropagation()} onBlur={commitRename}
                onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Enter') commitRename(); if (event.key === 'Escape') setRenaming(null) }} />
                : <Tooltip label={remote ? `SSH · ${remote.host}` : folderPath || labelFor(pid)}><span className="prism-terminal-label">{labelFor(pid)}</span></Tooltip>}
              {group.panes.length > 1 && <span className="prism-terminal-count">{group.panes.length}</span>}
              <Tooltip label="Fechar aba"><Button variant="ghost" size="icon-sm" className="prism-terminal-tab-close" aria-label={`Fechar ${labelFor(pid)}`}
                onDoubleClick={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); closeGroup(group.id) }}><X size={14} /></Button></Tooltip>
            </div>
          })}
        </div>
        <div className="prism-terminal-add"><IconAction label="Novo terminal" onClick={newTerminal}><Plus size={16} /></IconAction></div>
      </div>
      <div className="prism-terminal-actions">
        {remote && <Badge variant="outline" size="xs" className="prism-terminal-remote">SSH · {remote.host}</Badge>}
        <IconAction label="Dividir terminal" onClick={split}><SplitSquareHorizontal size={16} /></IconAction>
        <DropdownMenu trigger={<Button variant="ghost" size="icon-sm" aria-label="Ações do terminal"><MoreHorizontal size={16} /></Button>} align="end" label="Ações do terminal"
          onCloseAutoFocus={() => apisRef.current.get(activePane)?.focus()}>{paneMenu(activePane)}</DropdownMenu>
        <IconAction label="Fechar painel (Ctrl+`)" onClick={toggleTerminal}><X size={16} /></IconAction>
      </div>
    </div>
    <div className="prism-terminal-body">
      <div className="prism-terminal-stage">
        {restoring && !groups.length && <div className="prism-terminal-overlay" role="status" aria-busy="true"><span>Iniciando terminal</span><Spinner /></div>}
        {groups.map((group) => <div key={`${remoteId}:${group.id}`} id={`terminal-group-${group.id}`} role="tabpanel" aria-labelledby={`terminal-tab-${group.id}`}
          className="prism-terminal-group" hidden={group.id !== activeGroup}>
          {group.panes.map((pid) => <div key={pid} className={cn('prism-terminal-pane-wrap', pid === activePane && 'is-active')}>
            {group.panes.length > 1 && <div className="prism-terminal-pane-heading"><TerminalIcon size={14} /><span>{labelFor(pid)}</span>
              <IconAction label={`Encerrar ${labelFor(pid)}`} onClick={() => closePane(pid)}><X size={14} /></IconAction></div>}
            <TerminalPane paneId={pid} remoteId={remoteId} attachTo={remoteId ? undefined : adopted[pid]} active={pid === activePane} visible={group.id === activeGroup}
              onFocus={() => { if (layoutRef.current.activePane !== pid) focusPane(group.id, pid) }} onClose={() => closePane(pid)}
              onTitle={(title) => setLabels((previous) => previous[pid] === title ? previous : { ...previous, [pid]: title })}
              onContextMenu={(paneId, x, y) => setMenu({ paneId, x, y })}
              registerApi={(api) => { if (api) apisRef.current.set(pid, api); else apisRef.current.delete(pid) }} />
          </div>)}
        </div>)}
      </div>
      {paneCount > 1 && <aside className="prism-terminal-list" aria-label="Lista de terminais">
        {groups.map((group) => <div key={group.id} className={cn('prism-terminal-list-group', group.panes.length > 1 && 'is-split')}>
          {group.panes.map((pid) => <div key={pid} className="prism-terminal-row">
            {renaming === pid ? <div className="prism-terminal-row-main is-active"><TerminalIcon size={14} />
              <input autoFocus className="prism-terminal-rename" aria-label="Renomear terminal" value={renameValue}
                onChange={(event) => setRenameValue(event.target.value)} onBlur={commitRename}
                onKeyDown={(event) => { if (event.key === 'Enter') commitRename(); if (event.key === 'Escape') setRenaming(null) }} />
            </div> : <button type="button" className={cn('prism-terminal-row-main', pid === activePane && 'is-active')} aria-current={pid === activePane ? 'true' : undefined}
              onClick={() => focusPane(group.id, pid)} onDoubleClick={() => startRename(pid)}
              onContextMenu={(event) => { event.preventDefault(); setMenu({ paneId: pid, x: event.clientX, y: event.clientY }) }}>
              <TerminalIcon size={14} /><span className="prism-terminal-label">{labelFor(pid)}</span>
            </button>}
            {renaming !== pid && <div className="prism-terminal-row-actions"><DropdownMenu trigger={<Button variant="ghost" size="icon-xs" aria-label={`Ações de ${labelFor(pid)}`}><MoreHorizontal size={12} /></Button>}
              align="end" label={`Ações de ${labelFor(pid)}`} onCloseAutoFocus={() => apisRef.current.get(activePane)?.focus()}>{paneMenu(pid)}</DropdownMenu></div>}
          </div>)}
        </div>)}
      </aside>}
    </div>
    {menu && <DropdownMenu open onOpenChange={(open) => { if (!open) setMenu(null) }}
      trigger={<button className="prism-terminal-context-anchor" tabIndex={-1} aria-hidden="true" style={{ left: menu.x, top: menu.y }} />}
      sideOffset={0} label="Ações do terminal" onCloseAutoFocus={() => apisRef.current.get(menu.paneId)?.focus()}>{paneMenu(menu.paneId)}</DropdownMenu>}
  </section>
}
