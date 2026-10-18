import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, LogIn, Sparkles, Square, TriangleAlert } from 'lucide-react'
import type { SharedSegment, SharedTurn } from '../../../../shared/agents'
import { imageReferenceNumber, type ImageReference } from '../../../../shared/imageReferences'
import type { ChatRuntime } from '../../lib/agentChats'
import { Button, Tooltip, cn } from '../ui'
import ProviderIcon from '../ProviderIcon'
import { runStatus, useRunClock } from '../AgentMonitor'
import { buildTimeline, formatClock, formatWorkedFor, pickElapsedVerb, pickWorkingVerb, replyText } from './activity'
import { noteReasoning } from './state'
import { CopyButton, WorkingDots, WorkingText } from './primitives'
import { Markdown } from './Markdown'
import { ActivityGroup } from './ActivityGroup'
import { SubagentCard } from './Subagent'
import { usageMeta } from './usageMeta'

const PROVIDER_LABEL = { claude: 'Claude Code', codex: 'Codex' } as const

/* ------------------------------------------------------------------ */
/* Time labels                                                         */
/* ------------------------------------------------------------------ */

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}
/** Day-scoped clock label (Traycer useMessageTime): `14:32`, `Ontem 14:32`, `03/10 14:32`. */
export function messageTime(at: number, now = Date.now()): string {
  const d = new Date(at), today = new Date(now)
  const time = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  if (sameDay(d, today)) return time
  const yesterday = new Date(now - 86_400_000)
  if (sameDay(d, yesterday)) return `Ontem ${time}`
  return `${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} ${time}`
}
function timeWithSeconds(at: number): string {
  const d = new Date(at)
  const time = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  return sameDay(d, new Date()) ? time : `${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} ${time}`
}
function formatUsd(value: number): string {
  if (value >= 1) return `US$ ${value.toFixed(2)}`
  if (value < 0.0001) return '<US$ 0,0001'
  return `US$ ${value.toFixed(4)}`
}

/* ------------------------------------------------------------------ */
/* User message                                                        */
/* ------------------------------------------------------------------ */

const CLAMP_PX = 120
const EMPTY_IMAGE_CATALOG: readonly ImageReference[] = []

/** Sender overline + bubble with a 120px clamp and a hover copy chip (chat-message-user-body.tsx). */
export const UserMessage = memo(function UserMessage({ turn, sentAt, imageCatalog = EMPTY_IMAGE_CATALOG }: { turn: SharedTurn; sentAt?: number; imageCatalog?: readonly ImageReference[] }) {
  const content = useRef<HTMLDivElement>(null)
  const [overflowing, setOverflowing] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [preview, setPreview] = useState<number | null>(null)
  const previewDialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    if (preview !== null) previewDialog.current?.showModal()
    else previewDialog.current?.close()
  }, [preview])
  useLayoutEffect(() => {
    const el = content.current
    if (!el) return
    const check = (): void => setOverflowing(el.scrollHeight > CLAMP_PX)
    const observer = new ResizeObserver(check)
    observer.observe(el)
    check()
    return () => observer.disconnect()
  }, [])
  const clamped = overflowing && !expanded
  return <div className="ch-msg user">
    <span className="ch-overline">
      <span className="ch-overline-label">Você</span>
      {sentAt ? <><span aria-hidden> · </span>
        <Tooltip label={new Date(sentAt).toLocaleString('pt-BR', { dateStyle: 'full', timeStyle: 'medium' })}>
          <time className="ch-overline-time" dateTime={new Date(sentAt).toISOString()}>{messageTime(sentAt)}</time>
        </Tooltip></> : null}
    </span>
    <div className="ch-user">
      <div className="ch-user-frame">
        <div className="ch-bubble">
          {turn.images?.length ? <div className="ch-bubble-imgs">
            {turn.images.map((img, i) => {
              const number = imageReferenceNumber(imageCatalog, img) ?? i + 1
              const label = `#image ${number}`
              return <button type="button" key={i} className="ch-bubble-img-button" aria-label={`Ampliar ${label}: ${img.name || 'imagem anexada'}`}
                title={`Use ${label} para citar esta imagem em outra mensagem`} onClick={() => setPreview(i)}>
                <img className="ch-bubble-img" loading="lazy" src={`data:${img.mime};base64,${img.data}`} alt={img.name || label} />
                <span className="ch-image-number">{label}</span>
              </button>
            })}
          </div> : null}
          {turn.text ? <div ref={content} className={cn('ch-bubble-text', clamped && 'clamped')} style={clamped ? { maxHeight: CLAMP_PX } : undefined}>{turn.text}</div> : null}
          {overflowing ? <div className="ch-show-more">
            <Button variant="muted" size="xs" aria-expanded={expanded} onMouseDown={(e) => e.preventDefault()} onClick={() => setExpanded((v) => !v)}>
              {expanded ? <ChevronUp aria-hidden /> : <ChevronDown aria-hidden />}{expanded ? 'Mostrar menos' : 'Mostrar mais'}
            </Button>
          </div> : null}
        </div>
        {turn.text.trim() ? <div className="ch-user-actions"><CopyButton text={turn.text} label="Copiar mensagem" className="ch-user-copy" /></div> : null}
      </div>
    </div>
    {turn.images?.length ? <dialog ref={previewDialog} className="ch-image-preview" aria-label="Imagem anexada" onCancel={() => setPreview(null)} onClick={e => { if (e.target === e.currentTarget) setPreview(null) }}>
      <button type="button" autoFocus onClick={() => setPreview(null)}>Fechar imagem</button>
      {preview !== null && turn.images[preview] ? <img src={`data:${turn.images[preview].mime};base64,${turn.images[preview].data}`} alt={turn.images[preview].name || 'imagem anexada'} /> : null}
    </dialog> : null}
  </div>
})

/* ------------------------------------------------------------------ */
/* Assistant pieces                                                    */
/* ------------------------------------------------------------------ */

/** Faint destructive circle with a solid square: the composer's stop button in miniature. */
function StopBadge() {
  return <span aria-hidden className="ch-stop-badge"><Square /></span>
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return <div className="ch-meta-row"><span>{label}</span><span>{value}</span></div>
}

/** Hover card for the footer / run indicator: agent, usage and timing (AssistantMetaTooltip). */
function MetaTooltip({ turn, status, timing }: { turn: SharedTurn; status?: string; timing: boolean }) {
  const usage = usageMeta(turn.metrics)
  const n = (v: number): string => v.toLocaleString('pt-BR')
  return <div className="ch-meta">
    <div className="ch-meta-title">Agente</div>
    {status ? <MetaRow label="Status" value={status} /> : null}
    <MetaRow label="Provedor" value={PROVIDER_LABEL[turn.provider || 'claude']} />
    {turn.profileName ? <MetaRow label="Perfil" value={turn.profileName} /> : null}
    <MetaRow label="Modelo" value={turn.model || 'Padrão'} />
    {usage.turn.length || usage.turnCost !== undefined ? <><div className="ch-meta-title divider">Uso deste turno</div>{usage.turn.map(([label, value]) => <MetaRow key={label} label={label} value={n(value)} />)}
      {usage.turnCost !== undefined ? <MetaRow label="Custo do turno" value={formatUsd(usage.turnCost)} /> : null}</> : null}
    {usage.session.length || usage.sessionCost !== undefined ? <><div className="ch-meta-title divider">Uso da sessão nativa</div>{usage.session.map(([label, value]) => <MetaRow key={label} label={label} value={n(value)} />)}
      {usage.sessionCost !== undefined ? <MetaRow label="Custo acumulado" value={formatUsd(usage.sessionCost)} /> : null}</> : null}
    {usage.context.length ? <><div className="ch-meta-title divider">Contexto</div>{usage.context.map(([label, value]) => <MetaRow key={label} label={label} value={n(value)} />)}</> : null}
    {timing && turn.startedAt ? <>
      <div className="ch-meta-title divider">Tempo</div>
      <MetaRow label="Início" value={timeWithSeconds(turn.startedAt)} />
      {turn.completedAt ? <MetaRow label={turn.interrupted ? 'Interrompido às' : 'Concluído'} value={timeWithSeconds(turn.completedAt)} /> : null}
    </> : null}
  </div>
}

function FooterIcon({ turn }: { turn: SharedTurn }) {
  if (turn.interrupted) return <StopBadge />
  return turn.provider ? <ProviderIcon provider={turn.provider} size={14} /> : <Sparkles size={14} aria-hidden />
}

/** "Ponderou por 12s" / "Interrompido · 12s" + reply copy (AssistantElapsedFooter). */
function ElapsedFooter({ turn, reply }: { turn: SharedTurn; reply: string }) {
  const ms = turn.durationMs ?? ((turn.completedAt || 0) - (turn.startedAt || turn.completedAt || 0))
  return <div className="ch-footer">
    <Tooltip label={<MetaTooltip turn={turn} timing />} side="top" align="start" sideOffset={6} className="ch-meta-tip">
      <button type="button" className="ch-footer-elapsed">
        <FooterIcon turn={turn} />
        {turn.interrupted
          ? <span><span className="ch-destructive">Interrompido</span>{` · ${formatWorkedFor(ms)}`}</span>
          : <span>{`${pickElapsedVerb(turn.id)} por ${formatWorkedFor(ms)}`}</span>}
      </button>
    </Tooltip>
    {reply ? <CopyButton text={reply} label="Copiar resposta" className="ch-footer-copy" /> : null}
  </div>
}

/** Live "Ponderando ··· (12s)" line trailing a running turn (AssistantRunIndicator). */
function RunIndicator({ turn, runtime }: { turn: SharedTurn; runtime?: ChatRuntime }) {
  const now = useRunClock(true)
  const status = runStatus(turn, runtime)
  const waiting = !!(runtime?.permission || runtime?.question)
  const indicator = <div className="ch-run" role="status" data-waiting={waiting || undefined}>
    {turn.provider ? <ProviderIcon provider={turn.provider} size={14} /> : null}
    <span className="ch-run-verb">
      {waiting ? <span>{status}</span> : <WorkingText>{pickWorkingVerb(turn.id)}</WorkingText>}
      {waiting ? null : <WorkingDots />}
    </span>
    <span className="ch-run-time">({formatClock((now - (turn.startedAt || now)) / 1000)})</span>
  </div>
  return <Tooltip label={<MetaTooltip turn={turn} status={status} timing={false} />} side="top" align="start" sideOffset={6} className="ch-meta-tip">{indicator}</Tooltip>
}

/** "Entrar novamente" for a turn whose login is gone: why it cannot start (tooltip), or null. */
export interface SignInAction {
  blocked: string | null
  onSignIn: () => void
}

function ErrorCard({ text, provider, signIn }: { text: string; provider?: SharedTurn['provider']; signIn?: SignInAction }) {
  return <div className="ch-error" role="alert">
    <TriangleAlert size={14} aria-hidden className="ch-error-icon" />
    <div className="ch-error-main">
      <span className="ch-error-title">{provider === 'codex' ? 'Falha no turno do Codex' : 'Erro'}</span>
      <span className="ch-error-text">{text}</span>
      {signIn ? <span>
        <Tooltip label={signIn.blocked} side="top" align="start">
          <span className="stg-inline-guard"><Button variant="outline" size="xs" disabled={!!signIn.blocked} onClick={signIn.onSignIn}><LogIn aria-hidden />Entrar novamente</Button></span>
        </Tooltip>
      </span> : null}
    </div>
    <CopyButton text={text} label="Copiar erro" className="ch-error-copy" />
  </div>
}

/* ------------------------------------------------------------------ */
/* Assistant message                                                   */
/* ------------------------------------------------------------------ */

/**
 * One assistant turn (chat-message-assistant-body.tsx): text and activity
 * groups in order, then the live run indicator, then the elapsed footer.
 */
export const AssistantMessage = memo(function AssistantMessage({ turn, runtime, cwd, signIn, imageCatalog }: {
  turn: SharedTurn
  /** Present only while this turn is the chat's running one. */
  runtime?: ChatRuntime
  cwd?: string
  imageCatalog?: readonly ImageReference[]
  /** Present only when the turn failed because the login is gone (`errorCode` `cli_auth`). */
  signIn?: SignInAction
}) {
  const running = !!runtime?.busy
  const segments = useMemo<SharedSegment[]>(() => turn.text?.trim()
    ? [{ kind: 'text', text: turn.text }, ...(turn.segments || [])]
    : turn.segments || [], [turn.text, turn.segments])
  const timeline = useMemo(() => buildTimeline(segments, { running, errored: !!turn.error }), [segments, running, turn.error])
  for (const item of timeline) {
    if (item.kind !== 'group') continue
    for (const child of item.items) if (child.segment.kind === 'thinking') noteReasoning(`${turn.id}:${child.key}`, child.streaming)
  }
  const reply = useMemo(() => replyText(turn.error ? segments.slice(0, -1) : segments), [segments, turn.error])

  if (!timeline.length) {
    if (running) return <div className="ch-msg assistant"><div className="ch-assistant"><RunIndicator turn={turn} runtime={runtime} /></div></div>
    if (turn.interrupted) return <div className="ch-msg assistant"><div role="status" className="ch-stopped"><StopBadge /><span>Interrompido antes de responder</span></div></div>
    return null
  }
  const last = timeline[timeline.length - 1]
  const showFooter = !running && !!turn.completedAt && (turn.interrupted || last.kind !== 'error')
  return <div className="ch-msg assistant">
    <div className="ch-assistant">
      {timeline.map((item) => item.kind === 'group'
        ? <ActivityGroup key={item.key} group={item} scope={turn.id} cwd={cwd} interrupted={turn.interrupted} />
        : item.kind === 'subagent'
          ? <SubagentCard key={item.key} segment={item.segment} openKey={`${turn.id}:${item.key}`} />
        : item.kind === 'user'
          ? <UserMessage key={item.key} turn={{ id: item.key, role: 'user', text: item.segment.text || '', images: item.segment.images }} sentAt={item.segment.sentAt} imageCatalog={imageCatalog} />
        : item.kind === 'error'
          ? <ErrorCard key={item.key} text={item.text} provider={turn.provider} signIn={signIn} />
          : <Markdown key={item.key} text={item.text} streaming={item.streaming} className="ch-text" />)}
      {running ? <RunIndicator turn={turn} runtime={runtime} /> : null}
      {showFooter ? <ElapsedFooter turn={turn} reply={reply} /> : null}
    </div>
  </div>
})
