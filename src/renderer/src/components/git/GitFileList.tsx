import { useMemo, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, Folder, FolderOpen, Minus, Plus, RotateCcw } from 'lucide-react'
import { FileTypeIcon } from '../../lib/fileIcon'
import { basename, dirname } from '../../lib/lang'
import { Badge, Button, Tooltip } from '../ui'
import { buildGitTree, filterGitFiles, statusBadge, type GitFile, type GitSection, type GitTreeNode } from './git-model'
import { GitFileName, HighlightedPath } from './HighlightedPath'

interface Props {
  files: GitFile[]
  section: GitSection
  query: string
  tree: boolean
  activeFile: string | null
  busy: boolean
  onOpen: (file: GitFile, section: GitSection) => void
  onStage: (file: GitFile) => void
  onUnstage: (file: GitFile) => void
  onDiscard: (file: GitFile) => void
}

export default function GitFileList(props: Props) {
  const visible = useMemo(() => filterGitFiles(props.files, props.query), [props.files, props.query])
  const nodes = useMemo(() => buildGitTree(visible), [visible])
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const row = (file: GitFile, depth = 0) => {
    const badge = statusBadge(file, props.section)
    const stats = props.section === 'staged' ? file.stagedStats : file.workingStats
    return <div key={file.path} className={`pg-file-row${props.activeFile === file.path ? ' is-active' : ''}${props.section === 'conflicts' ? ' is-conflict' : ''}`} style={{ paddingLeft: 12 + depth * 16 }}>
      <button className="pg-file-open" onClick={() => props.onOpen(file, props.section)} aria-current={props.activeFile === file.path || undefined} title={file.path}>
        <span className={`pg-status pg-tone-${badge.tone}`} aria-label={badge.label}>{badge.letter}</span>
        <FileTypeIcon name={basename(file.path)} size={14} />
        <GitFileName name={basename(file.path)} query={props.query} />
        {!props.tree && dirname(file.path) && <span className="pg-file-directory"><HighlightedPath text={dirname(file.path)} query={props.query} /></span>}
      </button>
      {stats && <span className={`pg-file-stats${props.section === 'staged' ? ' pg-file-stats-staged' : ''}`} aria-label={`${stats.insertions} linhas adicionadas, ${stats.deletions} linhas removidas`}><span>+{stats.insertions}</span><span>−{stats.deletions}</span>{stats.binary && <Badge variant="outline" size="xs">bin</Badge>}</span>}
      <div className="pg-file-actions">
        {props.section === 'staged' ? <Tooltip label="Retirar da preparação"><Button variant="muted" size="icon-xs" aria-label={`Retirar ${file.path} da preparação`} disabled={props.busy} onClick={() => props.onUnstage(file)}><Minus size={13} /></Button></Tooltip> : <>
          <Tooltip label="Descartar alterações"><Button variant="muted" size="icon-xs" aria-label={`Descartar alterações de ${file.path}`} disabled={props.busy} onClick={() => props.onDiscard(file)}><RotateCcw size={13} /></Button></Tooltip>
          <Tooltip label="Preparar alterações"><Button variant="muted" size="icon-xs" aria-label={`Preparar ${file.path}`} disabled={props.busy} onClick={() => props.onStage(file)}><Plus size={13} /></Button></Tooltip>
        </>}
      </div>
    </div>
  }
  const renderNodes = (items: GitTreeNode[], depth: number): ReactNode => items.map((node) => {
    if (node.file) return row(node.file, depth)
    const closed = !props.query.trim() && collapsed.has(node.path)
    return <div key={node.path}>
      <button className="pg-directory-row" style={{ paddingLeft: 12 + depth * 16 }} aria-expanded={!closed} onClick={() => setCollapsed((old) => { const next = new Set(old); if (next.has(node.path)) next.delete(node.path); else next.add(node.path); return next })}>
        {closed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        {closed ? <Folder size={14} /> : <FolderOpen size={14} />}<span><HighlightedPath text={node.name} query={props.query} /></span>
      </button>
      {!closed && renderNodes(node.children, depth + 1)}
    </div>
  })
  return <div className="pg-file-list">{props.tree ? renderNodes(nodes, 0) : visible.map((file) => row(file))}</div>
}
