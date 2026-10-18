import { useEffect, useRef, useState } from 'react'
import { Check, ChevronRight } from 'lucide-react'
import { useStore } from '../store'
import { runEditorAction } from '../lib/editorRef'
import { DropdownMenu, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut } from './ui'

interface MenuItem {
  label?: string
  shortcut?: string
  action?: () => void
  sep?: boolean
  submenu?: { label: string; action: () => void }[]
  disabled?: boolean
  checked?: boolean
}

interface Menu {
  title: string
  items: MenuItem[]
}

const SEP: MenuItem = { sep: true }

function RecentMenu({ item, close }: { item: MenuItem; close: () => void }) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const leave = (event: Event): void => {
      const target = event.target
      if (!(target instanceof Element)) return
      if (trigger.current?.contains(target) || target.closest('.ps-shell-recent-menu')) { clearTimeout(timer); timer = undefined; return }
      if (target.closest('[role^="menuitem"]') || event.type === 'focusin') setOpen(false)
      else if (!timer) timer = setTimeout(() => setOpen(false), 150)
    }
    document.addEventListener('pointermove', leave, true)
    document.addEventListener('focusin', leave)
    return () => { clearTimeout(timer); document.removeEventListener('pointermove', leave, true); document.removeEventListener('focusin', leave) }
  }, [open])
  return <DropdownMenu open={open} onOpenChange={setOpen} className="ps-shell-recent-menu" side="right" align="start" sideOffset={2} label={item.label}
    onContentKeyDown={(event) => { if (event.key === 'ArrowLeft') { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus() } }}
    trigger={<button ref={trigger} type="button" role="menuitem" data-shell-submenu className="tr-menu-item ps-shell-menu-subtrigger" onPointerEnter={() => setOpen(true)} onPointerMove={(event) => event.currentTarget.focus()}><span>{item.label}</span><ChevronRight size={14} /></button>}>
    <div data-tr-keep-open>{item.submenu?.map((sub, i) => <DropdownMenuItem key={i} onSelect={() => { close(); sub.action() }}>{sub.label}</DropdownMenuItem>)}</div>
  </DropdownMenu>
}

export default function MenuBar({ onOpenChange }: { onOpenChange?: (open: boolean) => void }) {
  const [open, setOpen] = useState<string | null>(null)
  useStore((state) => state.settings)
  useEffect(() => { onOpenChange?.(open !== null) }, [open, onOpenChange])

  const s = (): ReturnType<typeof useStore.getState> => useStore.getState()

  const openFolder = (): Promise<void> => s().openFolderDialog()
  const newWindow = (): void => window.prism.window.newWindow()

  const openWorkspace = async (): Promise<void> => {
    try {
      const ws = await window.prism.workspace.open()
      if (ws && ws.folders.length) await s().openWorkspaceFolders(ws.folders, ws.file)
      else if (ws) s().addToast('error', 'O workspace não tem pastas válidas.')
    } catch (err) {
      s().addToast('error', 'Falha ao abrir workspace: ' + ((err as Error)?.message || err))
    }
  }
  const saveWorkspace = async (): Promise<void> => {
    const folders = s().workspaceFolders.length ? s().workspaceFolders : s().folderPath ? [s().folderPath!] : []
    if (!folders.length) {
      s().addToast('error', 'Abra uma pasta antes de salvar o workspace.')
      return
    }
    try {
      const file = await window.prism.workspace.save(folders)
      if (file) s().addToast('success', 'Workspace salvo.')
    } catch (err) {
      s().addToast('error', 'Falha ao salvar workspace: ' + ((err as Error)?.message || err))
    }
  }

  const recents = s().settings.recentFolders ?? []
  const recentWorkspaces = s().settings.recentWorkspaces ?? []
  const recentRemotes = s().settings.recentRemotes ?? []
  const wsName = (f: string): string =>
    f.replace(/\\/g, '/').split('/').pop()!.replace(/\.prism-workspace$/, '')

  const MENUS: Menu[] = [
    {
      title: 'Arquivo',
      items: [
        { label: 'Nova janela', shortcut: 'Ctrl+Shift+N', action: newWindow },
        SEP,
        { label: 'Abrir pasta…', shortcut: 'Ctrl+O', action: openFolder },
        {
          label: 'Abrir recente',
          submenu:
            recents.length || recentWorkspaces.length || recentRemotes.length
              ? [
                  ...recentRemotes.map((r) => ({
                    label: `${r.name}  (SSH)`,
                    action: () => s().requestReconnect(r)
                  })),
                  ...recentWorkspaces.map((w) => ({
                    label: `${wsName(w)}  (workspace)`,
                    action: () => s().openWorkspaceFile(w)
                  })),
                  ...recents.map((r) => ({
                    label: r.replace(/\\/g, '/').split('/').filter(Boolean).slice(-2).join('/'),
                    action: () => s().openFolder(r)
                  }))
                ]
              : [{ label: '(nenhuma recente)', action: () => {} }]
        },
        SEP,
        { label: 'Abrir workspace…', action: openWorkspace },
        { label: 'Salvar workspace como…', action: saveWorkspace },
        SEP,
        { label: 'Salvar', shortcut: 'Ctrl+S', action: () => s().saveActive() },
        { label: 'Salvar tudo', shortcut: 'Ctrl+K S', action: () => s().saveAll() },
        {
          label: 'Salvar automaticamente',
          checked: s().settings.autoSave,
          action: () => s().updateSetting('autoSave', !s().settings.autoSave)
        },
        SEP,
        {
          label: 'Fechar editor',
          shortcut: 'Ctrl+W',
          action: () => {
            const a = s().activePath
            if (a) s().requestCloseTab(a)
          }
        },
        { label: 'Configurações', shortcut: 'Ctrl+,', action: () => s().setSettingsOpen(true) },
        SEP,
        { label: 'Sair', action: () => window.prism.window.close() }
      ]
    },
    {
      title: 'Editar',
      items: [
        { label: 'Desfazer', shortcut: 'Ctrl+Z', action: () => runEditorAction('undo') },
        { label: 'Refazer', shortcut: 'Ctrl+Y', action: () => runEditorAction('redo') },
        SEP,
        { label: 'Recortar', shortcut: 'Ctrl+X', action: () => runEditorAction('editor.action.clipboardCutAction') },
        { label: 'Copiar', shortcut: 'Ctrl+C', action: () => runEditorAction('editor.action.clipboardCopyAction') },
        { label: 'Colar', shortcut: 'Ctrl+V', action: () => runEditorAction('editor.action.clipboardPasteAction') },
        SEP,
        { label: 'Localizar', shortcut: 'Ctrl+F', action: () => runEditorAction('actions.find') },
        { label: 'Substituir', shortcut: 'Ctrl+H', action: () => runEditorAction('editor.action.startFindReplaceAction') },
        { label: 'Formatar documento', shortcut: 'Shift+Alt+F', action: () => runEditorAction('editor.action.formatDocument') }
      ]
    },
    {
      title: 'Seleção',
      items: [
        { label: 'Selecionar tudo', shortcut: 'Ctrl+A', action: () => runEditorAction('editor.action.selectAll') },
        { label: 'Expandir seleção', shortcut: 'Shift+Alt+→', action: () => runEditorAction('editor.action.smartSelect.expand') },
        SEP,
        { label: 'Copiar linha abaixo', shortcut: 'Shift+Alt+↓', action: () => runEditorAction('editor.action.copyLinesDownAction') },
        { label: 'Mover linha acima', shortcut: 'Alt+↑', action: () => runEditorAction('editor.action.moveLinesUpAction') },
        { label: 'Mover linha abaixo', shortcut: 'Alt+↓', action: () => runEditorAction('editor.action.moveLinesDownAction') },
        SEP,
        { label: 'Adicionar cursor abaixo', shortcut: 'Ctrl+Alt+↓', action: () => runEditorAction('editor.action.insertCursorBelow') },
        { label: 'Selecionar todas ocorrências', shortcut: 'Ctrl+Shift+L', action: () => runEditorAction('editor.action.selectHighlights') }
      ]
    },
    {
      title: 'Exibir',
      items: [
        { label: 'Paleta de comandos', shortcut: 'Ctrl+Shift+P', action: () => s().togglePalette() },
        SEP,
        { label: 'Explorador', shortcut: 'Ctrl+B', action: () => s().setSidebarView('explorer') },
        { label: 'Buscar', shortcut: 'Ctrl+Shift+F', action: () => s().setSidebarView('search') },
        { label: 'Controle de código', shortcut: 'Ctrl+Shift+G', action: () => s().setSidebarView('git') },
        { label: 'Sessões do Claude', action: () => s().setSidebarView('sessions') },
        { label: 'Extensões', action: () => s().setSidebarView('extensions') },
        SEP,
        { label: 'Alternar terminal', shortcut: 'Ctrl+`', action: () => s().toggleTerminal() },
        { label: 'Abrir conversas', shortcut: 'Ctrl+L', action: () => s().setWorkspaceView('agents') },
        { label: 'Alternar painel de conversas do editor', action: () => s().toggleChat() },
        { label: 'Alternar barra lateral', shortcut: 'Ctrl+B', action: () => s().toggleSidebar() },
        { label: 'Quebra de linha', action: () => s().toggleWordWrap() }
      ]
    },
    {
      title: 'Ir',
      items: [
        { label: 'Ir para arquivo…', shortcut: 'Ctrl+P', action: () => s().toggleQuickOpen() },
        { label: 'Paleta de comandos', shortcut: 'Ctrl+Shift+P', action: () => s().togglePalette() },
        SEP,
        { label: 'Próxima aba', shortcut: 'Ctrl+Tab', action: () => s().cycleTab(1) },
        { label: 'Aba anterior', shortcut: 'Ctrl+Shift+Tab', action: () => s().cycleTab(-1) }
      ]
    },
    {
      title: 'Executar',
      items: [
        { label: 'Novo terminal', action: () => s().openTerminal() },
        { label: 'Abrir conversas', shortcut: 'Ctrl+L', action: () => s().setWorkspaceView('agents') }
      ]
    },
    {
      title: 'Terminal',
      items: [
        { label: 'Novo terminal', action: () => s().openTerminal() },
        { label: 'Alternar terminal', shortcut: 'Ctrl+`', action: () => s().toggleTerminal() }
      ]
    },
    {
      title: 'Ajuda',
      items: [
        {
          label: 'Sobre o Prism IDE',
          action: () =>
            window.prism.app.info().then((i) =>
              s().addToast('info', `Prism IDE ${i.version} · ${i.platform}`)
            )
        },
        {
          label: 'Documentação do Claude Code',
          action: () => window.open('https://code.claude.com/docs', '_blank')
        }
      ]
    }
  ]

  const switchMenu = (title: string, direction: number): void => {
    const index = MENUS.findIndex((menu) => menu.title === title)
    setOpen(MENUS[(index + direction + MENUS.length) % MENUS.length].title)
  }
  return <nav className="ps-shell-menubar" aria-label="Menu da aplicação" role="menubar">
    {MENUS.map((menu) => <DropdownMenu key={menu.title} label={menu.title} open={open === menu.title}
      onOpenChange={(next) => setOpen((current) => next ? menu.title : current === menu.title ? null : current)}
      onContentKeyDown={(e) => {
        if (e.defaultPrevented) return
        if (e.key === 'ArrowRight') {
          e.preventDefault()
          const submenu = (e.target as HTMLElement).closest<HTMLElement>('[data-shell-submenu]')
          if (submenu) submenu.click()
          else switchMenu(menu.title, 1)
        }
        if (e.key === 'ArrowLeft') { e.preventDefault(); switchMenu(menu.title, -1) }
      }}
      trigger={<button type="button" role="menuitem" className="ps-shell-menu-trigger"
        onMouseEnter={() => { if (open) setOpen(menu.title) }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); const direction = e.key === 'ArrowRight' ? 1 : -1; switchMenu(menu.title, direction) }
        }}>{menu.title}</button>}>
      {menu.items.map((item, i) => item.sep ? <DropdownMenuSeparator key={i} /> : item.submenu ?
        <RecentMenu key={i} item={item} close={() => setOpen(null)} /> :
        <DropdownMenuItem key={i} disabled={item.disabled} role={item.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'} aria-checked={item.checked} onSelect={() => { setOpen(null); item.action?.() }}>
          <span className="ps-shell-menu-check">{item.checked && <Check size={14} />}</span><span>{item.label}</span>
          {item.shortcut && <DropdownMenuShortcut>{item.shortcut}</DropdownMenuShortcut>}
        </DropdownMenuItem>
      )}
    </DropdownMenu>)}
  </nav>
}
