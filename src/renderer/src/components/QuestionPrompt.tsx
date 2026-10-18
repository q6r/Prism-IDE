import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Check, ChevronLeft, ChevronRight, Circle, CircleHelp, CornerDownLeft, Pencil } from 'lucide-react'
import { PendingQuestion, Question } from '../types'
import { Button, Kbd, Spinner, Tooltip, cn } from './ui'
import { Markdown } from './chat/Markdown'
import {
  answeredCount, buildSubmission, digitTarget, emptyDraft, isAnswered, modeHint, setOtherText, toggleOption, toggleOther, type Draft
} from './chat/questionDraft'
import '../styles/chat.css'

const ADVANCE_DELAY_MS = 110

/** Decorative radio / checkbox glyph (InterviewChoiceGlyph). */
function ChoiceGlyph({ multi, selected }: { multi: boolean; selected: boolean }) {
  return <span aria-hidden className={cn('ch-glyph', multi ? 'checkbox' : 'radio', selected && 'selected')}>
    {selected ? multi ? <Check size={14} /> : <Circle size={8} /> : null}
  </span>
}

/** Option preview: fenced markdown renders as markdown, anything else as a mono box. */
function OptionPreview({ preview }: { preview: string }) {
  if (/^\s*(```|~~~)/m.test(preview)) return <Markdown text={preview} size="compact" />
  return <pre className="ch-option-preview">{preview}</pre>
}

function OptionRow({ index, label, description, preview, selected, pending, multi, onToggle }: {
  index: number
  label: string
  description?: string
  preview?: string
  selected: boolean
  pending: boolean
  multi: boolean
  onToggle: () => void
}) {
  const [details, setDetails] = useState(false)
  const regionId = useId()
  const hasDetails = !!(description?.trim() || preview?.trim())
  return <li className={cn('ch-option-wrap', pending && 'pending')}>
    <div className={cn('ch-option', selected && 'selected')}>
      <button type="button" className="ch-option-hit" aria-pressed={selected} aria-label={`${index + 1}. ${label}`} onClick={onToggle} />
      <ChoiceGlyph multi={multi} selected={selected} />
      <span className="ch-option-label">{label}</span>
      {hasDetails ? <Tooltip label={description?.trim() ? <span className="ch-option-tip">{description}{preview ? <span className="dim">Clique para ver a prévia</span> : null}</span> : 'Mostrar prévia'} side="top" sideOffset={6}>
        <button type="button" className="ch-option-help" aria-label={`Detalhes de ${label}`} aria-expanded={details}
          aria-controls={details ? regionId : undefined} onClick={() => setDetails((v) => !v)}>
          <CircleHelp size={14} aria-hidden />
        </button>
      </Tooltip> : null}
      <span aria-hidden className="ch-fill" />
      <span aria-hidden className="ch-option-number">{index + 1}</span>
    </div>
    {details && hasDetails ? <div id={regionId} role="region" aria-label="Detalhes da opção" className="ch-option-details">
      {description?.trim() ? <div><span className="ch-option-details-label">Detalhes</span><div className="ch-option-details-text">{description}</div></div> : null}
      {preview?.trim() ? <div><span className="ch-option-details-label">Prévia</span><OptionPreview preview={preview} /></div> : null}
    </div> : null}
  </li>
}

function OtherRow({ selected, value, onSelect, onChange }: { selected: boolean; value: string; onSelect: () => void; onChange: (text: string) => void }) {
  if (selected) {
    return <div className="ch-other-field">
      <span aria-hidden className="ch-other-badge selected"><Pencil size={12} /></span>
      <textarea autoFocus rows={1} value={value} placeholder="Digite sua resposta…" aria-label="Outra resposta"
        onChange={(e) => onChange(e.target.value)} />
    </div>
  }
  return <div className="ch-option-wrap">
    <div className="ch-option">
      <button type="button" className="ch-option-hit" aria-label="Outro" onClick={onSelect} />
      <span className="ch-option-label">Outro</span>
      <span aria-hidden className="ch-fill" />
      <span aria-hidden className="ch-other-badge"><Pencil size={12} /></span>
    </div>
  </div>
}

function QuestionPage({ question, draft, isLast, pendingIndex, onToggle, onOther, onOtherText, autoFocus }: {
  question: Question
  draft: Draft
  isLast: boolean
  pendingIndex: number | null
  onToggle: (index: number) => void
  onOther: () => void
  onOtherText: (text: string) => void
  autoFocus: boolean
}) {
  return <div className="ch-question">
    <div className="ch-question-head">
      {question.header?.trim() ? <div className="ch-question-chip">{question.header}</div> : null}
      <div className="ch-question-text"><Markdown text={question.question} size="compact" /></div>
      {question.options.length ? <p className="ch-question-hint">{modeHint(question.multiSelect, isLast)}</p> : null}
    </div>
    {question.options.length ? <div className="ch-options">
      <ul>
        {question.options.map((opt, i) => <OptionRow key={`${opt.label}:${i}`} index={i} label={opt.label} description={opt.description}
          preview={opt.preview} selected={draft.picks.includes(i)} pending={pendingIndex === i} multi={question.multiSelect} onToggle={() => onToggle(i)} />)}
      </ul>
      <OtherRow selected={draft.picks.includes('other')} value={draft.otherText} onSelect={onOther} onChange={onOtherText} />
    </div> : <textarea className="ch-free-answer" autoFocus={autoFocus} rows={2} value={draft.otherText} placeholder="Digite sua resposta…"
      aria-label="Resposta" onChange={(e) => onOtherText(e.target.value)} />}
  </div>
}

/**
 * Claude's AskUserQuestion as Traycer's pending-interview card: one question
 * per page with a pager, numbered options (digits pick, Enter advances or
 * sends, Esc skips), an "Outro" free-text row and option details/previews.
 */
export default function QuestionPrompt({
  pending,
  onSubmit,
  onCancel,
  autoFocus = true,
  cancelLabel = 'Pular'
}: {
  pending: PendingQuestion
  onSubmit: (answers: Record<string, string>, response?: string) => void | boolean | Promise<void | boolean>
  onCancel: () => void | boolean | Promise<void | boolean>
  autoFocus?: boolean
  cancelLabel?: string
}) {
  const questions = pending.questions
  const total = questions.length
  const [page, setPage] = useState(0)
  const [drafts, setDrafts] = useState<Draft[]>(() => questions.map(() => emptyDraft()))
  const [pendingIndex, setPendingIndex] = useState<number | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const inFlight = useRef(false)
  const card = useRef<HTMLElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const latest = useRef(drafts)
  latest.current = drafts
  const pageRef = useRef(page)
  pageRef.current = page

  const safe = Math.min(page, Math.max(total - 1, 0))
  const question = questions[safe]
  const draft = drafts[safe] || emptyDraft()
  const isLast = safe >= total - 1
  const ready = questions.every((q, i) => isAnswered(q, drafts[i]))

  useEffect(() => { if (autoFocus) card.current?.focus({ preventScroll: true }) }, [autoFocus])
  useEffect(() => () => clearTimeout(timer.current), [])
  useEffect(() => { if (body.current) body.current.scrollTop = 0 }, [safe])

  const update = (next: Draft): Draft[] => {
    const all = latest.current.map((d, i) => i === safe ? next : d)
    latest.current = all
    setDrafts(all)
    return all
  }
  const perform = async (action: () => void | boolean | Promise<void | boolean>): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true; setSubmitting(true); setError('')
    try {
      if (await action() === false) setError('Não foi possível enviar. Suas respostas continuam aqui para tentar novamente.')
    } catch {
      setError('Não foi possível enviar. Suas respostas continuam aqui para tentar novamente.')
    } finally { inFlight.current = false; setSubmitting(false) }
  }
  const submitWith = (all: Draft[]): void => {
    if (inFlight.current) return
    if (!questions.every((q, i) => isAnswered(q, all[i]))) return
    clearTimeout(timer.current)
    const { answers, response } = buildSubmission(questions, all)
    void perform(() => onSubmit(answers, response))
  }
  const go = (dir: 1 | -1): void => {
    clearTimeout(timer.current)
    setPendingIndex(null)
    setPage((p) => Math.min(Math.max(p + dir, 0), Math.max(total - 1, 0)))
  }
  const proceed = (): void => { if (isLast) submitWith(latest.current); else go(1) }

  const pick = (index: number): void => {
    if (inFlight.current) return
    if (!question) return
    const all = update(toggleOption(draft, index, question.multiSelect))
    if (question.multiSelect) return
    // Single choice: hold a brief highlight, then advance (or send on the last page).
    setPendingIndex(index)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      setPendingIndex(null)
      // The reader paged away during the highlight: their navigation wins.
      if (pageRef.current !== safe) return
      if (isLast) submitWith(all)
      else setPage(safe + 1)
    }, ADVANCE_DELAY_MS)
  }
  const pickOther = (): void => {
    if (inFlight.current) return
    if (!question) return
    clearTimeout(timer.current)
    setPendingIndex(null)
    update(toggleOther(draft, question.multiSelect))
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>): void => {
    if (inFlight.current) {
      if (/^(Enter|Escape|ArrowLeft|ArrowRight|[1-9])$/.test(e.key)) { e.preventDefault(); e.stopPropagation() }
      return
    }
    const target = e.target as HTMLElement
    const editable = target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable
    let handled = true
    if (e.key === 'Enter') {
      const mod = e.metaKey || e.ctrlKey
      if (!mod && (e.shiftKey || target.tagName === 'BUTTON' || (target.tagName === 'TEXTAREA' && !target.closest('.ch-other-field')))) handled = false
      else proceed()
    } else if (e.key === 'Escape') {
      if (editable) card.current?.focus({ preventScroll: true })
      else void perform(onCancel)
    } else if (e.key === 'ArrowLeft' && !editable) go(-1)
    else if (e.key === 'ArrowRight' && !editable) go(1)
    else if (!editable && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && question?.options.length) {
      const digit = digitTarget(e.key, question.options.length)
      if (digit === null) handled = false
      else if (digit === 'other') pickOther()
      else pick(digit)
    } else handled = false
    if (handled) { e.preventDefault(); e.stopPropagation() }
  }

  return (
    <section ref={card} className="ch-interview" aria-label="Pergunta" tabIndex={-1} onKeyDown={onKeyDown} data-testid="interview-card">
      <fieldset className="ch-interview-fields" disabled={submitting}>
      <div ref={body} className="ch-interview-body">
        {question
          ? <QuestionPage key={safe} question={question} draft={draft} isLast={isLast} pendingIndex={pendingIndex}
            onToggle={pick} onOther={pickOther} onOtherText={(text) => update(setOtherText(draft, text))} autoFocus={autoFocus} />
          : <div className="ch-question-text">Resposta necessária</div>}
      </div>
      <div className="ch-interview-foot">
        <div className="ch-interview-progress">
          {total > 1 ? <div className="ch-pager">
            <Button size="icon-xs" variant="ghost" aria-label="Pergunta anterior" disabled={safe <= 0} onClick={() => go(-1)}><ChevronLeft aria-hidden /></Button>
            <span aria-live="polite">{safe + 1} de {total}</span>
            <Button size="icon-xs" variant="ghost" aria-label="Próxima pergunta" disabled={safe >= total - 1} onClick={() => go(1)}><ChevronRight aria-hidden /></Button>
          </div> : null}
          {total > 0 ? <span className="ch-answered">Respondidas {answeredCount(questions, drafts)}/{total}</span> : null}
        </div>
        <div className="ch-interview-actions">
          <Button size="sm" variant="outline" onClick={() => void perform(onCancel)}>{cancelLabel}<Kbd size="xs" className="ch-hint">Esc</Kbd></Button>
          {isLast
            ? <Button size="sm" variant="default" disabled={!ready} onClick={() => submitWith(latest.current)}>
              {submitting ? <Spinner /> : <Check aria-hidden />}{submitting ? 'Enviando…' : 'Enviar'}<Kbd size="xs" className="ch-hint"><CornerDownLeft size={10} /></Kbd>
            </Button>
            : <Button size="sm" variant="default" disabled={total === 0} onClick={() => go(1)}>
              Próxima<Kbd size="xs" className="ch-hint"><CornerDownLeft size={10} /></Kbd>
            </Button>}
        </div>
      </div>
      </fieldset>
      {error ? <p className="ch-question-error" role="alert">{error}</p> : null}
    </section>
  )
}
