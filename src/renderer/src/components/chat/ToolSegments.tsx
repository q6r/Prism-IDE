import { lazy, memo, Suspense, type ReactNode } from 'react'
import { CircleCheck, Circle, Globe, LoaderCircle, SquareTerminal, Wrench } from 'lucide-react'
import type { SharedSegment } from '../../../../shared/agents'
import { Tooltip, cn } from '../ui'
import { FileTypeIcon } from '../../lib/fileIcon'
import { useStore } from '../../store'
import { isLightTheme } from '../../lib/appearance'
import DiffRenderBoundary from '../git/DiffRenderBoundary'
import type { DiffViewerPreferences } from '../git/GitDiffView'
import {
  baseName, fileChanges, fileVerb, normalizeToolName, relativePath, rowKind, singleLine, toolInputDetail, toolKind, toolSummary,
  type DiffLine, type FileChange, type InputDetail
} from './activity'
import { useOpen, toolStartedAt } from './state'
import { LiveElapsed, LivePulse, PanelPre, SegmentCard, SegmentPanel, SegmentRow, StateBadge } from './primitives'
import { Markdown } from './Markdown'
import { ChatImage } from './ChatImage'

export interface ToolViewProps {
  segment: SharedSegment
  /** Open-state key, scoped to the turn (`${turnId}:${itemKey}`). */
  openKey: string
  variant: 'row' | 'card'
  /** The turn was interrupted: an errored call without output was cut short, not failed. */
  interrupted?: boolean
  cwd?: string
  /** Inside the live activity window a click promotes instead of expanding. */
  onPromote?: (() => void) | null
}

const MAX_OUTPUT = 6000

type Outcome = 'running' | 'awaiting' | 'error' | 'denied' | 'stopped' | 'done'
function outcomeOf(segment: SharedSegment, interrupted?: boolean): Outcome {
  if (segment.status === 'running') return 'running'
  if (segment.status === 'awaiting') return 'awaiting'
  if (segment.status === 'denied') return 'denied'
  if (segment.status === 'error') return interrupted && !segment.result ? 'stopped' : 'error'
  return 'done'
}

/** Elapsed, then the pulse, then the outcome — the trailing cluster every row shares. */
function StatusCluster({ outcome, startKey, label }: { outcome: Outcome; startKey: string; label: string }) {
  const live = outcome === 'running' || outcome === 'awaiting'
  return <span className="ch-status">
    {live ? <LiveElapsed startedAt={toolStartedAt(startKey)} /> : null}
    {outcome === 'running' ? <LivePulse label={label} /> : null}
    {outcome === 'awaiting' ? <LivePulse label="Aguardando aprovação" tone="idle" /> : null}
    {outcome === 'error' ? <StateBadge label="erro" tone="destructive" /> : null}
    {outcome === 'denied' ? <StateBadge label="negado" tone="destructive" /> : null}
    {outcome === 'stopped' ? <StateBadge label="interrompido" tone="muted" /> : null}
  </span>
}

/** Truncates from the start so the file name stays visible (StartTruncatedText). */
function StartTruncated({ text, className, onOpen }: { text: string; className?: string; onOpen?: () => void }) {
  if (!onOpen) return <span className={cn('ch-start-trunc', className)} title={text}><bdi>{text}</bdi></span>
  return <span role="button" tabIndex={0} title={text} className={cn('ch-start-trunc ch-path-link', className)}
    onClick={(e) => { e.stopPropagation(); onOpen() }}
    onKeyDown={(e) => { if (e.key !== 'Enter' && e.key !== ' ') return; e.preventDefault(); e.stopPropagation(); onOpen() }}>
    <bdi>{text}</bdi>
  </span>
}

/* ------------------------------------------------------------------ */
/* Panels                                                              */
/* ------------------------------------------------------------------ */

export function ToolInputPanel({ detail }: { detail: InputDetail }) {
  if (detail.kind === 'command') {
    return <SegmentPanel label="Entrada" copyValue={detail.command}>
      <PanelPre><span className="ch-prompt">$ </span>{detail.command}</PanelPre>
    </SegmentPanel>
  }
  return <SegmentPanel label="Entrada">
    <dl className="ch-fields">
      {detail.entries.map((e) => <div key={e.key} className="ch-field"><dt>{e.label}</dt><dd>{e.value}</dd></div>)}
    </dl>
  </SegmentPanel>
}

function OutputPanel({ result, isError, label }: { result?: string; isError?: boolean; label: string }) {
  if (!result || !result.trim()) return null
  const text = result.length > MAX_OUTPUT ? result.slice(0, MAX_OUTPUT) : result
  return <>
    <SegmentPanel label={isError ? 'Erro' : label} copyValue={result} tone={isError ? 'destructive' : 'default'}>
      <PanelPre tone={isError ? 'destructive' : 'default'}>{text}</PanelPre>
    </SegmentPanel>
    {result.length > MAX_OUTPUT ? <div className="ch-truncated">Saída truncada</div> : null}
  </>
}

type Todo = { content?: string; activeForm?: string; status?: string }
function TodoPanel({ todos }: { todos: Todo[] }) {
  return <SegmentPanel label="Tarefas">
    <ul className="ch-todos">
      {todos.map((t, i) => <li key={i} data-status={t.status}>
        {t.status === 'completed' ? <CircleCheck size={14} aria-hidden /> : t.status === 'in_progress' ? <LoaderCircle size={14} aria-hidden /> : <Circle size={14} aria-hidden />}
        <span>{t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content}</span>
      </li>)}
    </ul>
  </SegmentPanel>
}

/* ------------------------------------------------------------------ */
/* Generic tool                                                        */
/* ------------------------------------------------------------------ */

function GenericTool({ segment, openKey, variant, interrupted, cwd, onPromote }: ToolViewProps) {
  const name = segment.name || 'Ferramenta'
  const input = (segment.input && typeof segment.input === 'object' ? segment.input : {}) as Record<string, unknown>
  const n = normalizeToolName(name)
  const outcome = outcomeOf(segment, interrupted)
  const live = outcome === 'running' || outcome === 'awaiting'
  const [open, setOpen] = useOpen(openKey)
  const summary = toolSummary(name, input, cwd)
  const todos = n === 'todowrite' && Array.isArray(input.todos) ? input.todos as Todo[] : null
  const plan = n === 'exitplanmode' && typeof input.plan === 'string' ? input.plan : null
  const detail = todos || plan ? null : toolInputDetail(name, input, summary)
  const hasResult = !!segment.result?.trim() && outcome !== 'stopped'
  const expandable = !!(detail || todos || plan || hasResult)
  const Icon = toolKind(name) === 'browser' ? Globe : Wrench
  const label = toolKind(name) === 'browser' ? 'Navegador' : name
  const status = <StatusCluster outcome={outcome} startKey={openKey} label="Ferramenta em execução" />

  const header = variant === 'card' && live
    ? <>
      <Icon size={14} className="ch-tool-icon stacked" aria-hidden />
      <span className="ch-stack">
        <span className="ch-stack-line"><span className="ch-tool-name">{label}</span>{status}</span>
        <span className="ch-stack-sub"><span aria-hidden className="ch-elbow" /><span className="ch-tool-summary">{summary ? `Executando ${summary}` : 'Executando'}</span></span>
      </span>
    </>
    : <>
      <Icon size={14} className="ch-tool-icon" aria-hidden />
      <span className="ch-tool-name">{label}</span>
      {summary ? <><span aria-hidden className="ch-dot">·</span><span className="ch-tool-summary">{summary}</span></> : <span aria-hidden className="ch-fill" />}
      {status}
    </>

  const body = open ? <div className="ch-stack-body">
    {todos ? <TodoPanel todos={todos} /> : null}
    {plan ? <SegmentPanel label="Plano" copyValue={plan}><Markdown text={plan} size="compact" className="ch-panel-md" /></SegmentPanel> : null}
    {detail ? <ToolInputPanel detail={detail} /> : null}
    {hasResult ? <OutputPanel result={segment.result} isError={segment.resultIsError || outcome === 'error'} label={n.startsWith('mcp__') ? 'Resultado' : 'Saída'} /> : null}
  </div> : null

  const tone = outcome === 'error' ? 'destructive' : 'default'
  if (variant === 'row') return <SegmentRow open={open} onOpenChange={setOpen} header={header} body={body} tone={tone} expandable={expandable} onPromote={onPromote} />
  return <SegmentCard open={open} onOpenChange={setOpen} header={header} body={body} expandable={expandable}
    tone={outcome === 'error' ? 'destructive' : live ? 'primary' : 'default'} />
}

/* ------------------------------------------------------------------ */
/* Shell command                                                       */
/* ------------------------------------------------------------------ */

function CommandTool({ segment, openKey, variant, interrupted, onPromote }: ToolViewProps) {
  const input = (segment.input || {}) as { command?: string; description?: string; cwd?: string }
  const command = input.command || ''
  const outcome = outcomeOf(segment, interrupted)
  const live = outcome === 'running' || outcome === 'awaiting'
  const [open, setOpen] = useOpen(openKey)
  const tip = [input.description, input.cwd ? `cwd: ${input.cwd}` : ''].filter(Boolean).join(' · ')
  const header = <>
    <SquareTerminal size={14} className="ch-tool-icon" aria-hidden />
    <Tooltip label={tip || null} side="top"><span className="ch-command">{singleLine(command, 400)}</span></Tooltip>
    <StatusCluster outcome={outcome} startKey={openKey} label="Comando em execução" />
  </>
  const body = open ? <div className="ch-stack-body">
    <SegmentPanel label="Comando" copyValue={command}><PanelPre><span className="ch-prompt">$ </span>{command}</PanelPre></SegmentPanel>
    {outcome !== 'stopped' ? <OutputPanel result={segment.result} isError={segment.resultIsError} label="Saída" /> : null}
  </div> : null
  const errored = outcome === 'error'
  if (variant === 'row') return <SegmentRow open={open} onOpenChange={setOpen} header={header} body={body} tone={errored ? 'destructive' : 'default'} expandable onPromote={onPromote} />
  return <SegmentCard open={open} onOpenChange={setOpen} header={header} body={body} expandable tone={errored ? 'destructive' : live ? 'primary' : 'default'} />
}

/* ------------------------------------------------------------------ */
/* File changes                                                        */
/* ------------------------------------------------------------------ */

// The Git panel's @pierre/diffs renderer (Traycer's DiffContentPrimitive),
// loaded on first expand. Chat snippets carry no file line numbers, so those
// stay off; the lightweight view below stands in while the chunk loads.
const PierreDiffContent = lazy(() => import('../git/PierreDiffContent'))
const CHAT_DIFF_VIEW: DiffViewerPreferences = { mode: 'unified', wordWrap: false, ignoreWhitespace: false, backgrounds: true, lineNumbers: false, indicatorStyle: 'bars' }
const noop = (): void => {}
// Edit snippets are fragments, not files: a missing final newline is not a
// change worth a "No newline at end of file" row.
const withEol = (text: string): string => text && !text.endsWith('\n') ? `${text}\n` : text

/** Inline diff of one file change (file-change-segment.tsx FileChangeInlineDiff). */
export function FileChangeDiff({ change }: { change: FileChange }) {
  const theme = useStore((s) => s.settings.theme)
  if (!change.lines.length) return <DiffView lines={change.lines} />
  return <div className="ch-diff-pierre" data-diffs-host>
    <DiffRenderBoundary resetKey={change}>
      <Suspense fallback={<DiffView lines={change.lines} />}>
        <PierreDiffContent name={change.path} original={withEol(change.original)} modified={withEol(change.modified)} view={CHAT_DIFF_VIEW}
          themeType={isLightTheme(theme) ? 'light' : 'dark'} onStats={noop} findOpen={false} onCloseFind={noop} />
      </Suspense>
    </DiffRenderBoundary>
  </div>
}

/** Lightweight unified diff: the loading stand-in for the full renderer. */
export function DiffView({ lines }: { lines: DiffLine[] }) {
  if (!lines.length) return <div className="ch-diff-empty">Sem alterações de conteúdo.</div>
  return <div className="ch-diff" role="table" aria-label="Diferenças">
    {lines.map((l, i) => l.type === 'hunk'
      ? <div key={i} className="ch-diff-line hunk" role="row"><span className="ch-diff-gutter" /><span className="ch-diff-code">⋯</span></div>
      : <div key={i} className={cn('ch-diff-line', l.type)} role="row">
        <span className="ch-diff-gutter" aria-hidden>{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}</span>
        <span className="ch-diff-code">{l.text || ' '}</span>
      </div>)}
  </div>
}

function absolute(path: string, cwd?: string): string {
  if (!cwd || /^([a-z]:[\\/]|[\\/])/i.test(path)) return path
  return `${cwd.replace(/[\\/]+$/, '')}/${path}`
}

function FileChangeRow({ change, outcome, openKey, variant, cwd, onPromote }: {
  change: FileChange
  outcome: Outcome
  openKey: string
  variant: 'row' | 'card'
  cwd?: string
  onPromote?: (() => void) | null
}) {
  const [open, setOpen] = useOpen(openKey)
  const status = outcome === 'denied' ? 'negado' : outcome === 'error' ? 'falhou' : null
  const shown = relativePath(change.path, cwd)
  const header = <>
    <FileTypeIcon name={baseName(change.path)} size={16} />
    <span className="ch-tool-name">{fileVerb(change.operation)}</span>
    <span aria-hidden className="ch-dot">·</span>
    <StartTruncated text={shown} className="ch-file-path" onOpen={change.operation === 'delete' ? undefined : () => { void useStore.getState().openFile(absolute(change.path, cwd)) }} />
    {status
      ? <StateBadge label={status} tone="destructive" />
      : <span className="ch-counts">
        {change.additions > 0 ? <span className="add">+{change.additions}</span> : null}
        {change.deletions > 0 ? <span className="del">−{change.deletions}</span> : null}
      </span>}
    {outcome === 'running' ? <LivePulse label="Alteração de arquivo em andamento" /> : null}
    {outcome === 'awaiting' ? <LivePulse label="Aguardando aprovação" tone="idle" /> : null}
    {outcome === 'stopped' ? <StateBadge label="interrompido" tone="muted" /> : null}
  </>
  const body = open ? <FileChangeDiff change={change} /> : null
  if (variant === 'row') return <SegmentRow open={open} onOpenChange={setOpen} header={header} body={body} expandable onPromote={onPromote} />
  return <SegmentCard open={open} onOpenChange={setOpen} header={header} body={body} expandable stickyHeader />
}

function FileChangeTool({ segment, openKey, variant, interrupted, cwd, onPromote }: ToolViewProps) {
  const changes = fileChanges(segment.name || '', segment.input)
  const outcome = outcomeOf(segment, interrupted)
  const rows: ReactNode[] = changes.map((change, i) => <FileChangeRow key={`${change.path}:${i}`} change={change} outcome={outcome}
    openKey={changes.length > 1 ? `${openKey}:${i}` : openKey} variant={variant} cwd={cwd} onPromote={onPromote} />)
  return rows.length === 1 ? <>{rows}</> : <div className="ch-file-group">{rows}</div>
}

/** One tool call, as a bare activity row (`row`) or a standalone bordered card (`card`). */
export const ToolSegmentView = memo(function ToolSegmentView(props: ToolViewProps) {
  const kind = rowKind(props.segment)
  const { segment } = props
  const content = kind === 'command' ? <CommandTool {...props} />
    : kind === 'file' && !segment.inputPath ? <FileChangeTool {...props} /> : <GenericTool {...props} />
  return <>{content}
    {segment.outputPath || segment.inputPath ? <div className="ch-tool-complete">
      {segment.outputPath ? <button type="button" onClick={() => { void useStore.getState().openFile(segment.outputPath!) }}>Abrir saída completa</button> : null}
      {segment.inputPath ? <button type="button" onClick={() => { void useStore.getState().openFile(segment.inputPath!) }}>Abrir entrada completa</button> : null}
      <span>Prévia carregada; conteúdo completo preservado.</span>
    </div> : null}
    {segment.presentation?.resultPending ? <div className="ch-truncated">Prévia da saída em andamento. O conteúdo completo ficará disponível ao concluir.</div> : null}
    {segment.images?.length ? <div className="ch-tool-images">{segment.images.map((image, index) => image.cacheError
      ? <span role="status" key={image.cacheKey ?? index}>{image.cacheError}</span>
      : <ChatImage key={image.cacheKey ?? image.cachedPath ?? index} src={image.cachedPath || `data:${image.mime};base64,${image.data}`} alt={image.name || `Imagem da ferramenta ${index + 1}`} route={{}} defer />)}</div> : null}
  </>
})
