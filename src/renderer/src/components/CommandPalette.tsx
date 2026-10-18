import { useEffect, useMemo, useRef, useState } from 'react'
import { FolderOpen, FileSearch, Save, WrapText, Terminal, PanelLeft, MessageSquare, Settings, X, Search } from 'lucide-react'
import { useStore } from '../store'
import { InputAddon, InputGroup, Kbd } from './ui'
import Dialog from './shell/Dialog'
import '../styles/shell.css'

export default function CommandPalette() {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const list = useRef<HTMLDivElement>(null)
  const s = useStore.getState
  const commands = useMemo(() => [
    { id: 'open-folder', icon: FolderOpen, label: 'Abrir pasta', hint: 'Ctrl+O', run: () => s().openFolderDialog() },
    { id: 'quick-open', icon: FileSearch, label: 'Buscar arquivo', hint: 'Ctrl+P', run: () => s().toggleQuickOpen() },
    { id: 'save', icon: Save, label: 'Salvar arquivo', hint: 'Ctrl+S', run: () => s().saveActive() },
    { id: 'wrap', icon: WrapText, label: 'Alternar quebra de linha', hint: '', run: () => s().toggleWordWrap() },
    { id: 'terminal', icon: Terminal, label: 'Alternar terminal', hint: 'Ctrl+`', run: () => s().toggleTerminal() },
    { id: 'sidebar', icon: PanelLeft, label: 'Alternar barra lateral', hint: 'Ctrl+B', run: () => s().toggleSidebar() },
    { id: 'chat', icon: MessageSquare, label: 'Abrir conversas', hint: 'Ctrl+L', run: () => s().setWorkspaceView('agents') },
    { id: 'chat-dock', icon: MessageSquare, label: 'Alternar painel de conversas do editor', hint: '', run: () => s().toggleChat() },
    { id: 'settings', icon: Settings, label: 'Abrir configurações', hint: 'Ctrl+,', run: () => s().openSettings() },
    { id: 'close-tab', icon: X, label: 'Fechar aba atual', hint: '', run: () => { const path = s().activePath; if (path) s().requestCloseTab(path) } }
  ], [])
  const filtered = commands.filter((command) => command.label.toLowerCase().includes(query.toLowerCase()))
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }) }, [index])
  const close = (): void => { if (s().paletteOpen) s().togglePalette() }
  const execute = (command: typeof commands[number] | undefined): void => { if (command) { close(); command.run() } }
  return <Dialog title="Paleta de comandos" hideHeader className="ps-shell-command-dialog" onClose={close}>
    <div className="ps-shell-command">
      <div className="ps-shell-command-input-wrap"><InputGroup variant="search"><InputAddon><Search size={16} /></InputAddon><input role="combobox" aria-label="Buscar comandos" aria-expanded="true" aria-controls="ps-shell-command-list" aria-activedescendant={filtered[index] ? `ps-shell-command-${filtered[index].id}` : undefined}
        placeholder="Buscar comandos…" value={query} onChange={(event) => { setQuery(event.target.value); setIndex(0) }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') { event.preventDefault(); setIndex((i) => Math.min(i + 1, Math.max(0, filtered.length - 1))) }
          else if (event.key === 'ArrowUp') { event.preventDefault(); setIndex((i) => Math.max(i - 1, 0)) }
          else if (event.key === 'Home' && event.ctrlKey) { event.preventDefault(); setIndex(0) }
          else if (event.key === 'End' && event.ctrlKey) { event.preventDefault(); setIndex(Math.max(0, filtered.length - 1)) }
          else if (event.key === 'Enter') { event.preventDefault(); execute(filtered[index]) }
        }} /></InputGroup></div>
      <div className="ps-shell-command-list" ref={list} id="ps-shell-command-list" role="listbox" aria-label="Comandos">
        <div className="ps-shell-command-group">Comandos</div>
        {filtered.map((command, i) => <button type="button" tabIndex={-1} role="option" id={`ps-shell-command-${command.id}`} key={command.id} aria-selected={i === index} className="ps-shell-command-item" onPointerMove={() => setIndex(i)} onClick={() => execute(command)}><command.icon size={16} /><span>{command.label}</span>{command.hint && <Kbd variant="mono">{command.hint}</Kbd>}</button>)}
        {!filtered.length && <div className="ps-shell-command-empty" role="status">Nenhum comando encontrado.</div>}
      </div>
    </div>
  </Dialog>
}
