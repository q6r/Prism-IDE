import { useState, type ReactNode } from 'react'
import { Check, CheckCheck, ChevronRight, FilePenLine, ShieldAlert, X } from 'lucide-react'
import { PendingPerm } from '../types'
import { Badge, Button, Tooltip, cn } from './ui'
import { fileChanges, singleLine, toolInputDetail, toolSummary, type FileChange } from './chat/activity'
import { FileChangeDiff, ToolInputPanel } from './chat/ToolSegments'
import '../styles/chat.css'

type Decide = (decision: 'allow' | 'allow_always' | 'deny') => void

function Disclosure({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return <div className="ch-approval-input">
    <button type="button" className="ch-approval-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
      <ChevronRight size={12} aria-hidden className={cn('ch-approval-chevron', open && 'open')} />{label}
    </button>
    {open ? <div className="ch-approval-detail">{children}</div> : null}
  </div>
}

function Actions({ onDecide }: { onDecide: Decide }) {
  return <div className="ch-approval-actions">
    <Button size="sm" variant="outline" onClick={() => onDecide('deny')}><X aria-hidden /> Negar</Button>
    <Button size="sm" variant="outline" onClick={() => onDecide('allow_always')}><CheckCheck aria-hidden /> Sempre nesta sessão</Button>
    <Button size="sm" variant="default" onClick={() => onDecide('allow')}><Check aria-hidden /> Aprovar</Button>
  </div>
}

const OPERATION: Record<FileChange['operation'], { label: string; tone: string }> = {
  create: { label: 'Criar', tone: 'create' },
  delete: { label: 'Excluir', tone: 'delete' },
  edit: { label: 'Editar', tone: 'edit' },
  write: { label: 'Escrever', tone: 'edit' }
}

/** Edit / Write / MultiEdit approval (composer-slot-file-edit-approval-queue.tsx). */
function FileEditApproval({ perm, changes, onDecide }: { perm: PendingPerm; changes: FileChange[]; onDecide: Decide }) {
  const op = OPERATION[changes[0].operation]
  const headline = perm.description || perm.title || perm.toolName
  return <div className="ch-approval file" role="group" aria-label="Aprovação de edição de arquivo" data-testid="file-edit-approval-prompt">
    <div className="ch-approval-head">
      <FilePenLine size={14} aria-hidden />
      <span className="ch-approval-title">Aprovação de edição de arquivo</span>
    </div>
    <div className="ch-approval-row">
      <div className="ch-approval-call">
        <span className="ch-approval-tool">{perm.displayName || perm.toolName}</span>
        <Badge variant="outline" size="sm" className={cn('ch-op-badge', op.tone)}>{op.label}</Badge>
      </div>
      <p className="ch-approval-headline">{headline}</p>
      <ul className="ch-approval-paths">
        {changes.map((c) => <Tooltip key={c.path} label={c.path}><li>{c.path}</li></Tooltip>)}
      </ul>
      <Disclosure label="Ver alterações">
        <div className="ch-approval-diffs">{changes.map((c) => <FileChangeDiff key={c.path} change={c} />)}</div>
      </Disclosure>
      <Actions onDecide={onDecide} />
    </div>
  </div>
}

/**
 * Pending tool approval, styled as Traycer's composer-slot approval card:
 * "Aprovação necessária" overline, the call as `tool · summary`, the agent's
 * own description, the full input behind a disclosure, then the decisions.
 */
export default function PermissionPrompt({
  perm,
  onDecide
}: {
  perm: PendingPerm
  onDecide: Decide
}) {
  const input = perm.input || {}
  const changes = fileChanges(perm.toolName, input)
  if (changes.length) return <FileEditApproval perm={perm} changes={changes} onDecide={onDecide} />
  const summary = toolSummary(perm.toolName, input)
  const detail = Object.values(input).some((v) => v !== undefined) ? toolInputDetail(perm.toolName, input, null) : null
  // The headline is the provider's own sentence for the ask; when it only
  // repeats the summary it adds nothing.
  const headline = [perm.title, perm.description].filter((t): t is string => !!t && singleLine(t, 200) !== summary).join('\n') || null
  return (
    <div className="ch-approval" role="group" aria-label="Aprovação necessária" data-testid="approval-prompt">
      <div className="ch-approval-head">
        <ShieldAlert size={14} aria-hidden />
        <span className="ch-approval-title">Aprovação necessária</span>
      </div>
      <div className="ch-approval-row">
        <div className="ch-approval-call">
          <span className="ch-approval-tool">{perm.displayName || perm.toolName}</span>
          {summary ? <><span aria-hidden className="ch-dot">·</span><span className="ch-approval-summary">{summary}</span></> : null}
        </div>
        {headline ? <p className="ch-approval-headline">{headline}</p> : null}
        {detail ? <Disclosure label={detail.kind === 'command' ? 'Comando completo' : 'Entrada completa'}><ToolInputPanel detail={detail} /></Disclosure> : null}
        <Actions onDecide={onDecide} />
      </div>
    </div>
  )
}
