import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { AlignJustify, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Diff, ExternalLink, EyeOff, FileDiff, RefreshCw, Settings2 } from 'lucide-react'
import { useStore } from '../../store'
import type { Tab } from '../../types'
import { FileTypeIcon } from '../../lib/fileIcon'
import { basename, dirname } from '../../lib/lang'
import { isLightTheme } from '../../lib/appearance'
import { Button, DropdownMenu, DropdownMenuItem, DropdownMenuSeparator, Spinner, Switch, Tooltip } from '../ui'
import { getGitDiffContext } from './diff-context'
import { workspaceFilePath } from './workspace-path'
import { DiffSplitIcon, DiffUnifiedIcon } from './DiffModeIcons'
import DiffRenderBoundary from './DiffRenderBoundary'
import '../../styles/git.css'

const PierreDiffContent = lazy(() => import('./PierreDiffContent'))

export interface DiffViewerPreferences {
  mode: 'split' | 'unified'
  wordWrap: boolean
  ignoreWhitespace: boolean
  backgrounds: boolean
  lineNumbers: boolean
  indicatorStyle: 'bars' | 'classic' | 'none'
}
const DEFAULTS: DiffViewerPreferences = { mode: 'split', wordWrap: false, ignoreWhitespace: false, backgrounds: true, lineNumbers: true, indicatorStyle: 'bars' }
function readPreferences(): DiffViewerPreferences {
  try {
    const saved = JSON.parse(localStorage.getItem('prism.git.diff.preferences') || '{}') as Partial<DiffViewerPreferences> | null
    if (!saved || typeof saved !== 'object') return DEFAULTS
    return {
      mode: saved.mode === 'unified' ? 'unified' : 'split',
      indicatorStyle: saved.indicatorStyle === 'classic' || saved.indicatorStyle === 'none' ? saved.indicatorStyle : 'bars',
      ...Object.fromEntries((['wordWrap', 'ignoreWhitespace', 'backgrounds', 'lineNumbers'] as const).map((key) => [key, typeof saved[key] === 'boolean' ? saved[key] : DEFAULTS[key]]))
    } as DiffViewerPreferences
  } catch { return DEFAULTS }
}

export default function GitDiffView({ tab }: { tab: Tab }) {
  const settings = useStore((s) => s.settings)
  const openFile = useStore((s) => s.openFile)
  const openDiff = useStore((s) => s.openDiff)
  const addToast = useStore((s) => s.addToast)
  const [view, setView] = useState<DiffViewerPreferences>(readPreferences)
  const [collapsed, setCollapsed] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [findOpen, setFindOpen] = useState(false)
  const [stats, setStats] = useState<{ insertions: number; deletions: number } | null>(null)
  const request = useRef(0)
  const viewRef = useRef<HTMLDivElement>(null)
  const context = getGitDiffContext(tab.path)
  const absolutePath = tab.path.replace(/^diff:/, '')
  const filePath = context?.file ?? absolutePath
  const fileName = basename(filePath)
  const binary = (tab.original ?? '').includes('\0') || tab.content.includes('\0')
  const patchView = (patch: Partial<DiffViewerPreferences>): void => {
    setView((current) => { const next = { ...current, ...patch }; try { localStorage.setItem('prism.git.diff.preferences', JSON.stringify(next)) } catch { /* storage unavailable */ } return next })
  }
  useEffect(() => () => { request.current++ }, [])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== 'f' || !(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target && !viewRef.current?.contains(target) && target.closest('input, textarea, [contenteditable="true"]')) return
      if (useStore.getState().activePath !== tab.path) return
      event.preventDefault()
      setCollapsed(false)
      setFindOpen(true)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [tab.path])
  const refresh = async (): Promise<void> => {
    if (!context || refreshing) return
    const version = ++request.current
    setRefreshing(true)
    try {
      const result = await window.prism.git.diff(context.root, context.file, context.untracked, context.remoteId, context.scope, context.origPath)
      if (version !== request.current) return
      openDiff(absolutePath, fileName, result.original, result.modified, tab.language)
      setError('')
    } catch (e) { if (version === request.current) setError(e instanceof Error ? e.message : 'Não foi possível atualizar o diff') }
    finally { if (version === request.current) setRefreshing(false) }
  }
  const openInEditor = async (): Promise<void> => {
    try {
      const { workspaceFolders, folderPath, remote } = useStore.getState()
      await openFile(workspaceFilePath(absolutePath, workspaceFolders.length ? workspaceFolders : folderPath ? [folderPath] : [], Boolean(remote)))
    }
    catch (e) { addToast('error', e instanceof Error ? e.message : 'Não foi possível abrir o arquivo') }
  }
  const indicators = [
    { value: 'bars' as const, label: 'Barras', Icon: AlignJustify },
    { value: 'classic' as const, label: 'Mais / menos', Icon: Diff },
    { value: 'none' as const, label: 'Ocultas', Icon: EyeOff }
  ]
  return <div className="pg-diff-view" ref={viewRef}>
    <div className="pg-diff-header">
      <div className="pg-diff-heading"><FileDiff size={16} /><div><h2>{fileName}</h2><div className="pg-diff-subtitle" title={filePath}>{filePath}</div>{context && <div className="pg-diff-context">{context.scope === 'staged' ? 'Alterações preparadas · HEAD → índice' : 'Alterações locais · índice → pasta de trabalho'}</div>}</div></div>
      <div className="pg-diff-toolbar">
        <Tooltip label={collapsed ? 'Expandir arquivo' : 'Recolher arquivo'}><Button variant="muted" size="icon-sm" aria-label={collapsed ? 'Expandir arquivo' : 'Recolher arquivo'} onClick={() => setCollapsed(!collapsed)}>{collapsed ? <ChevronsUpDown size={16} /> : <ChevronsDownUp size={16} />}</Button></Tooltip>
        <Tooltip label={view.mode === 'split' ? 'Visualização lado a lado' : 'Visualização unificada'}><Button variant="muted" size="icon-sm" aria-label={view.mode === 'split' ? 'Alternar para visualização unificada' : 'Alternar para visualização lado a lado'} onClick={() => patchView({ mode: view.mode === 'split' ? 'unified' : 'split' })}>{view.mode === 'split' ? <DiffSplitIcon /> : <DiffUnifiedIcon />}</Button></Tooltip>
        {context && <Tooltip label="Atualizar diff"><Button variant="muted" size="icon-sm" aria-label="Atualizar diff" disabled={refreshing} onClick={() => void refresh()}>{refreshing ? <Spinner /> : <RefreshCw size={16} />}</Button></Tooltip>}
        <DropdownMenu align="end" label="Configurações do diff" className="pg-diff-settings" trigger={<Button variant="muted" size="icon-sm" aria-label="Configurações do diff"><Settings2 size={16} /></Button>}>
          {([
            ['backgrounds', 'Fundos'], ['lineNumbers', 'Números de linha'], ['wordWrap', 'Quebra de linha'], ['ignoreWhitespace', 'Ignorar espaços em branco']
          ] as const).map(([key, label]) => <DropdownMenuItem key={key} className="pg-setting-row" role="menuitemcheckbox" aria-checked={view[key]} onSelect={(event) => { event.preventDefault(); patchView({ [key]: !view[key] }) }}><span>{label}</span><Switch checked={view[key]} aria-label={label} tabIndex={-1} onCheckedChange={(checked) => patchView({ [key]: checked })} onClick={(event) => { event.stopPropagation(); patchView({ [key]: !view[key] }) }} /></DropdownMenuItem>)}
          <div className="pg-indicator-setting"><span>Marcas na margem</span><div className="pg-indicator-control" role="radiogroup" aria-label="Marcas na margem">{indicators.map(({ value, label, Icon }) => <Tooltip key={value} label={label}><button role="radio" aria-checked={view.indicatorStyle === value} aria-label={label} onClick={() => patchView({ indicatorStyle: value })}><Icon size={14} /></button></Tooltip>)}</div></div>
          <DropdownMenuSeparator /><DropdownMenuItem onSelect={() => void openInEditor()}><ExternalLink size={16} />Abrir no editor</DropdownMenuItem>
        </DropdownMenu>
      </div>
    </div>
    {error && <div className="pg-error" role="alert"><span>{error}</span><Button variant="outline" size="xs" onClick={() => void refresh()}>Tentar novamente</Button></div>}
    <div className="pg-diff-body">
      <div className="pg-diff-file-header"><button className="pg-diff-file-toggle" onClick={() => setCollapsed(!collapsed)} aria-expanded={!collapsed}>{collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}<FileTypeIcon name={fileName} size={14} /><span>{fileName}</span>{dirname(filePath) && <span className="pg-file-directory">{dirname(filePath)}</span>}</button>{stats && !binary && <span className="pg-diff-stats" aria-label={`${stats.insertions} linhas adicionadas, ${stats.deletions} linhas removidas`}><span>+{stats.insertions}</span><span>−{stats.deletions}</span></span>}</div>
      {!collapsed && (binary ? <div className="pg-empty">Arquivo binário</div> : <div className="pg-diff-editor" data-diffs-host data-diff-find-file={filePath} data-bundle-diff-file-id={`${context?.scope ?? 'working'}:${filePath}`}>
        <DiffRenderBoundary resetKey={tab}><Suspense fallback={<div className="pg-empty" role="status"><Spinner />Carregando diff…</div>}>
          <PierreDiffContent name={filePath} original={tab.original ?? ''} modified={tab.content} view={view} themeType={isLightTheme(settings.theme) ? 'light' : 'dark'} onStats={setStats} findOpen={findOpen} onCloseFind={() => setFindOpen(false)} />
        </Suspense></DiffRenderBoundary>
      </div>)}
    </div>
  </div>
}
