import { createRoot } from 'react-dom/client'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, useCallback } from 'react'
import { ArrowDown, ArrowUp, Bot, Check, ChevronDown, ChevronRight, Copy, FilePen, Menu, MessageSquare, ShieldCheck, Sparkles, Square, Terminal, TriangleAlert, WifiOff, X } from 'lucide-react'
import { MarkdownContent, type CodeBlockProps } from '../components/chat/MarkdownContent'
import { parseRemoteLink, type RemoteLinkChat } from '../../../shared/remoteLink'
import type { RemoteChatSnapshotIpc as Snapshot, RemoteTurnIpc as Turn } from '../../../preload'
import '../styles/theme.css'
import '../styles/traycer.css'
import '../styles/chat.css'
import '../styles/composer.css'
import './mobile.css'
import { Controls, Queue, Files, Images, RemoteImage, RemoteContext } from './Controls'
import { latestStructuredQuestions, buildStructuredQuestionsReply } from '../lib/asyncQuestions'

type Segment = NonNullable<Turn['segments']>[number]
type Command = (action: string, payload?: Record<string, unknown>) => void
const errors: Record<string, string> = { 'no-chat': 'Esta conversa não está mais aberta no computador.', forbidden: 'Este link não tem acesso à conversa.', busy: 'O agente está trabalhando. Seu rascunho foi mantido.', 'read-only': 'Esta conversa está em modo de leitura.', blocked: 'Confirme a pasta e a conta da conversa no computador.', idle: 'O agente já parou.', gone: 'Esta solicitação já foi respondida.', empty: 'Escreva uma mensagem ou escolha uma resposta.', invalid: 'Não foi possível executar esta ação.', unknown: 'Esta ação não está disponível.' }
const openRemoteLink = (href: string): void => { window.open(href, '_blank', 'noopener,noreferrer') }
function Markdown({ text, compact = false }: { text: string; compact?: boolean }) {
  return <div className={`ch-md ${compact ? 'ch-md-sm ch-md-muted' : 'ch-md-base'}`}><MarkdownContent text={text} CodeBlock={CodeBlock} Image={RemoteImage} openLink={openRemoteLink} /></div>
}
function CopyButton({ text, code = false }: { text: string; code?: boolean }) {
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => { if (!copied && !failed) return; const timer = setTimeout(() => { setCopied(false); setFailed(false) }, 1800); return () => clearTimeout(timer) }, [copied, failed])
  return <button type="button" className={code ? 'ch-code-copy' : 'ch-copy'} aria-label={copied ? 'Copiado' : 'Copiar'} onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true), () => setFailed(true))}>{copied ? <Check size={16} /> : <Copy size={16} />}{failed ? <span className="sr-only" role="status">Não foi possível copiar.</span> : null}</button>
}
function CodeBlock({ code, language }: CodeBlockProps) {
  return <div className="ch-code"><div className="ch-code-head"><span className="ch-code-lang">{language || 'text'}</span><CopyButton text={code} code /></div><div className="ch-code-body"><pre><code>{code}</code></pre></div></div>
}
function Tool({ segment }: { segment: Segment }) {
  const isFile = /edit|write|patch/i.test(segment.name ?? '')
  const Icon = isFile ? FilePen : Terminal
  const status = segment.status === 'run' ? 'Executando' : segment.status === 'err' || segment.status === 'denied' ? 'Falhou' : segment.status === 'awaiting' ? 'Aguardando aprovação' : 'Concluído'
  return <details className="rm-tool"><summary><ChevronRight size={14} /><Icon size={16} /><span className="rm-tool-name">{segment.name}</span><span className="rm-tool-preview">{segment.preview}</span><span className="sr-only">{status}</span>{segment.status === 'run' ? <span className="rm-pulse" /> : segment.status === 'err' || segment.status === 'denied' ? <TriangleAlert size={14} /> : <Check size={14} />}</summary><pre>{segment.preview || status}</pre><Images images={segment.images} /></details>
}
function Subagent({ agent }: { agent: NonNullable<Segment['subagent']> }) {
  const label = { pending: 'Iniciando', running: 'Trabalhando', waiting: 'Aguardando', completed: 'Concluído', failed: 'Falhou', stopped: 'Interrompido' }[agent.status]
  const live = agent.status === 'pending' || agent.status === 'running' || agent.status === 'waiting'
  const latest = (live ? agent.activity || agent.summary : agent.summary || agent.activity) || agent.description
  return <details className="rm-subagent" data-agent-id={agent.id} data-status={agent.status}>
    <summary><ChevronRight size={14} aria-hidden /><Bot size={18} aria-hidden /><span className="rm-subagent-heading"><strong>{agent.name}</strong><small>{label}</small>{latest ? <span className="rm-subagent-latest">{latest}</span> : null}</span>{live ? <span className="rm-pulse" aria-hidden /> : agent.status === 'failed' ? <TriangleAlert size={16} aria-hidden /> : <Check size={16} aria-hidden />}</summary>
    <div className="rm-subagent-detail">{agent.description ? <div><strong>Tarefa</strong><p>{agent.description}</p></div> : null}
      {agent.activity ? <div><strong>Atividade</strong><p>{agent.activity}</p></div> : null}
      {agent.summary ? <div><strong>Resultado</strong><p>{agent.summary}</p></div> : null}
      {agent.model ? <small>Modelo: {agent.model}</small> : null}</div>
  </details>
}
function Message({ turn, working }: { turn: Turn; working: boolean }) {
  if (turn.role === 'user') return <article className="ch-msg user"><span className="ch-overline ch-overline-label">Você</span><div className="ch-user"><div className="ch-bubble"><div className="ch-bubble-text">{turn.text}</div><Images images={turn.images} /></div></div></article>
  const segments = turn.segments?.length ? turn.segments : [{ kind: 'text', text: turn.text } as Segment]
  const reply = segments.filter(s => s.kind === 'text').map(s => s.text ?? '').join('\n\n')
  return <article className="ch-msg assistant"><div className="ch-assistant">{segments.map((segment, index) => segment.subagent ? <Subagent key={segment.subagent.id} agent={segment.subagent} /> : segment.kind === 'tool' ? <Tool key={index} segment={segment} /> : segment.kind === 'user' ? <article className="ch-msg user" key={index}><span className="ch-overline">Você</span><div className="ch-bubble">{segment.text}<Images images={segment.images} /></div></article> : segment.kind === 'thinking' ? <details className="rm-thinking" key={index}><summary><ChevronRight size={14} /><Sparkles size={14} />Raciocínio</summary><Markdown text={segment.text ?? ''} compact /></details> : segment.text?.startsWith('⏹ Tarefa interrompida.') ? <div className="ch-stopped" key={index}><Square size={12} />Interrompido</div> : <div key={index}><Markdown text={segment.text ?? ''} /><Images images={segment.images} /></div>)}
    {turn.error ? <div className="ch-error" role="alert"><TriangleAlert size={16} />Falha no turno. Veja a mensagem acima.</div> : null}
    {working ? <div className="ch-run" role="status"><Sparkles size={14} /><span className="ch-working-text">{turn.pendingPerm || turn.pendingQuestion ? 'Aguardando você' : 'Trabalhando'}</span><span className="ch-working-dots" aria-hidden="true"><span /><span /><span /></span></div> : reply ? <div className="ch-footer"><CopyButton text={reply} /></div> : null}
  </div></article>
}
function Permission({ turn, command, disabled }: { turn: Turn; command: Command; disabled: boolean }) {
  const p = turn.pendingPerm!
  return <section className="rm-card" aria-label="Aprovar ação"><div className="rm-card-title"><ShieldCheck size={18} />{p.title || p.toolName}</div>{p.desc ? <p>{p.desc}</p> : null}{p.preview ? <pre>{p.preview}</pre> : null}<div className="rm-actions"><button type="button" className="rm-primary" disabled={disabled} onClick={() => command('perm', { turnId: turn.id, permId: p.permId, decision: 'allow' })}>Permitir</button><button type="button" disabled={disabled} onClick={() => command('perm', { turnId: turn.id, permId: p.permId, decision: 'allow_always' })}>Sempre permitir</button><button type="button" className="rm-danger" disabled={disabled} onClick={() => command('perm', { turnId: turn.id, permId: p.permId, decision: 'deny' })}>Negar</button></div></section>
}
function Question({ turn, command, disabled }: { turn: Turn; command: Command; disabled: boolean }) {
  const question = turn.pendingQuestion!
  const [values, setValues] = useState<Record<string, string[]>>({})
  const [other, setOther] = useState<Record<string, string>>({})
  const answers = Object.fromEntries(question.questions.map(q => [q.question, [...(values[q.question] ?? []), other[q.question]?.trim() ?? ''].filter(Boolean).join(', ')]))
  return <section className="rm-card" aria-label="Responder ao agente">{question.questions.map((q, index) => <fieldset key={q.question} disabled={disabled}><legend>{q.question}</legend>{q.options.map(option => <label className="rm-option" key={option.label}><input type={q.multiSelect ? 'checkbox' : 'radio'} name={`question-${index}`} checked={!!values[q.question]?.includes(option.label)} onChange={e => setValues(current => ({ ...current, [q.question]: q.multiSelect ? e.target.checked ? [...(current[q.question] ?? []), option.label] : (current[q.question] ?? []).filter(v => v !== option.label) : [option.label] }))} /><span><strong>{option.label}</strong>{option.description ? <small>{option.description}</small> : null}</span></label>)}<label className="rm-other">Outra resposta<input type="text" autoComplete="off" value={other[q.question] ?? ''} onChange={e => setOther(current => ({ ...current, [q.question]: e.target.value }))} /></label></fieldset>)}<div className="rm-actions"><button type="button" className="rm-primary" disabled={disabled || question.questions.some(q => !answers[q.question])} onClick={() => command('question', { turnId: turn.id, dialogId: question.dialogId, answers })}>Enviar resposta</button><button type="button" disabled={disabled} onClick={() => command('question', { turnId: turn.id, dialogId: question.dialogId, cancelled: true })}>Pular</button></div></section>
}
type AsyncQuestionSource = NonNullable<ReturnType<typeof latestStructuredQuestions>>
function AsyncQuestion({ source, answer, disabled }: { source: AsyncQuestionSource; answer: (text: string) => Promise<void>; disabled: boolean }) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [other, setOther] = useState<Record<string, string>>({})
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const answers = Object.fromEntries(source.questions.map(question => [question.question, other[question.question]?.trim() || values[question.question] || '']))
  const text = buildStructuredQuestionsReply(source, answers)
  const submit = async (): Promise<void> => {
    if (!text || disabled || sending) return
    setSending(true); setError('')
    try { await answer(text) } catch (failure) { setError((failure as Error).message) }
    finally { setSending(false) }
  }
  return <section className="rm-card rm-async-question" aria-label="Responder às perguntas do agente"><div className="rm-card-title"><MessageSquare size={18} />Responda ao agente</div>{source.questions.map((question, index) => <fieldset key={question.question} disabled={disabled || sending}><legend>{question.question}</legend>{question.options.map(option => <label className="rm-option" key={option.label}><input type="radio" name={`async-question-${index}`} checked={values[question.question] === option.label && !other[question.question]?.trim()} onChange={() => { setValues(current => ({ ...current, [question.question]: option.label })); setOther(current => ({ ...current, [question.question]: '' })) }} /><span><strong>{option.label}</strong>{option.description ? <small>{option.description}</small> : null}</span></label>)}<label className="rm-other">{question.options.length ? 'Outra resposta' : 'Sua resposta'}<input type="text" autoComplete="off" value={other[question.question] || ''} onChange={event => setOther(current => ({ ...current, [question.question]: event.target.value }))} /></label></fieldset>)}{error ? <p role="alert">{error}</p> : null}<div className="rm-actions"><button type="button" className="rm-primary" disabled={disabled || sending || !text} onClick={() => void submit()}>{sending ? 'Enviando resposta…' : 'Enviar resposta'}</button></div></section>
}
function App() {
  const initial = useRef(parseRemoteLink(location.hash))
  const [chats, setChats] = useState(initial.current.chats)
  const [active, setActive] = useState(initial.current.activeId)
  const [snapshots, setSnapshots] = useState<Record<string, Snapshot>>({})
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [connected, setConnected] = useState(false)
  const [notice, setNotice] = useState('')
  const [menu, setMenu] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const [pending, setPending] = useState<{ action: string; text?: string; requestId?: string } | null>(null)
  const pendingRef = useRef(pending)
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const socket = useRef<WebSocket | null>(null)
  const reads = useRef(new Map<string, { resolve: (data: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>())
  const readChain = useRef<Promise<unknown>>(Promise.resolve())
  const request = useCallback((action: string, payload: Record<string, unknown> = {}): Promise<any> => {
    const ws = socket.current
    const run = (): Promise<any> => new Promise((resolve, reject) => {
      if (!ws || ws !== socket.current || ws.readyState !== WebSocket.OPEN) { reject(new Error('Sem conexão')); return }
      const requestId = crypto.randomUUID()
      const timer = setTimeout(() => { reads.current.delete(requestId); reject(new Error('O computador não respondeu. Tente novamente.')) }, 25000)
      reads.current.set(requestId, { resolve, reject, timer })
      ws.send(JSON.stringify({ t: 'cmd', tabId: (ws as WebSocket & { chatId?: string }).chatId, action, payload, requestId }))
    })
    const next = readChain.current.catch(() => {}).then(run)
    readChain.current = next
    return next
  }, [])
  const scroll = useRef<HTMLDivElement>(null)
  const editor = useRef<HTMLTextAreaElement>(null)
  const positions = useRef<Record<string, { top: number; bottom: boolean }>>({})
  const stick = useRef(true)
  const [away, setAway] = useState(false)
  const [answeredQuestions, setAnsweredQuestions] = useState<Record<string, boolean>>({})
  const queuedAnswers = useRef(new Map<string, { id: string; text: string }>())
  const route = chats.find(c => c.tabId === active) ?? chats[0]
  const snapshot = snapshots[active]
  const latestSnapshots = useRef(snapshots)
  latestSnapshots.current = snapshots
  const draft = drafts[active] ?? ''
  const busy = !!snapshot?.streaming
  const notify = (message: string): void => { setNotice(message) }
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 5000); return () => clearTimeout(timer) }, [notice])
  useEffect(() => { pendingRef.current = pending }, [pending])
  useEffect(() => {
    const vp = window.visualViewport
    const resize = (): void => {
      // Pinch zoom remains available; only the unzoomed keyboard viewport drives layout.
      if (vp && vp.scale === 1) { document.documentElement.style.setProperty('--rm-height', `${vp.height}px`); document.documentElement.style.setProperty('--rm-offset', `${vp.offsetTop}px`) }
    }
    resize(); vp?.addEventListener('resize', resize); vp?.addEventListener('scroll', resize); window.addEventListener('resize', resize)
    return () => { vp?.removeEventListener('resize', resize); vp?.removeEventListener('scroll', resize); window.removeEventListener('resize', resize) }
  }, [])
  useEffect(() => {
    const changed = (): void => { const next = parseRemoteLink(location.hash); setChats(next.chats); setActive(next.activeId) }
    window.addEventListener('hashchange', changed)
    return () => window.removeEventListener('hashchange', changed)
  }, [])
  useEffect(() => {
    if (menu) dialog.current?.showModal(); else dialog.current?.close()
  }, [menu])
  useEffect(() => {
    if (!route) return
    let closed = false, ended = false, retry: ReturnType<typeof setTimeout> | undefined, attempt = 0
    let ws: WebSocket | undefined
    setConnected(false); setPending(null); pendingRef.current = null; clearTimeout(timeout.current)
    for (const read of reads.current.values()) { clearTimeout(read.timer); read.reject(new Error('A conversa mudou')) }; reads.current.clear()
    const connect = (): void => {
      if (closed || ended) return
      ws?.close()
      const current = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/?t=${encodeURIComponent(route.token)}`)
      ;(current as WebSocket & { chatId?: string }).chatId = route.tabId
      ws = current; socket.current = current
      current.onopen = () => { if (closed || ws !== current) return; attempt = 0; setConnected(true) }
      current.onmessage = event => {
        if (closed || ws !== current) return
        let message: any
        try { message = JSON.parse(event.data) } catch { return }
        if (message.t === 'chats') {
          const row = message.chats?.find((c: any) => !route.tabId || c.tabId === route.tabId)
          if (row) {
            if (!route.tabId) setActive(row.tabId)
            setChats(previous => previous.map(c => c.token === route.token ? { ...c, tabId: row.tabId, title: row.title } : c))
          }
        } else if (message.t === 'state' && message.chat?.tabId) {
          setSnapshots(previous => ({ ...previous, [message.chat.tabId]: message.chat }))
        } else if (message.t === 'delta' && (!route.tabId || message.tabId === route.tabId)) {
          setSnapshots(previous => {
            const before = previous[message.tabId]
            if (!before) return previous
            const turns = new Map(before.turns.map(t => [t.id, t]))
            for (const turn of message.turns ?? []) turns.set(turn.id, turn)
            return { ...previous, [message.tabId]: { ...before, title: message.title, streaming: message.streaming, contextPct: message.contextPct, updatedAt: Date.now(), selection: message.selection ?? before.selection, queued: message.queued ?? before.queued, queuePaused: message.queuePaused ?? before.queuePaused, turns: (message.ids ?? []).map((id: string) => turns.get(id)).filter(Boolean) } }
          })
        } else if (['revoked', 'removed', 'stopped'].includes(message.t)) {
          ended = true; setConnected(false); setPending(null); pendingRef.current = null; clearTimeout(timeout.current)
          notify(message.t === 'stopped' ? 'O controle remoto foi encerrado no computador.' : 'Esta conversa deixou de ser compartilhada.')
          if (message.t === 'stopped') setChats([])
          else { setChats(previous => previous.filter(c => c.token !== route.token)); setActive('') }
          current.close()
        } else if (message.t === 'ack') {
          const read = reads.current.get(message.requestId)
          if (read && (message.ok === false || message.stage === 'done')) {
            clearTimeout(read.timer); reads.current.delete(message.requestId)
            if (message.ok) read.resolve(message.data); else read.reject(new Error(errors[message.reason] || 'Não foi possível abrir.'))
            return
          }
          if (message.requestId && message.requestId !== pendingRef.current?.requestId) return
          if (message.ok === false || message.stage === 'done') {
            clearTimeout(timeout.current)
            const request = pendingRef.current
            if (message.ok && request?.action === 'send' && message.action === 'send') {
              setDrafts(previous => previous[route.tabId] === request.text ? { ...previous, [route.tabId]: '' } : previous)
              notify('Mensagem enviada')
              stick.current = true
            } else if (!message.ok) notify(errors[message.reason] ?? 'Não foi possível executar. Tente novamente.')
            else if (message.action === 'stop') notify('Interrupção solicitada')
            setPending(null); pendingRef.current = null
          }
        }
      }
      current.onclose = () => {
        if (closed || ended || ws !== current) return
        setConnected(false)
        retry = setTimeout(connect, Math.min(1000 * 2 ** attempt++, 8000))
      }
      current.onerror = () => current.close()
    }
    connect()
    const ping = setInterval(() => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'ping' })) }, 25000)
    const wake = (): void => { if (document.visibilityState !== 'hidden' && ws?.readyState !== WebSocket.OPEN && ws?.readyState !== WebSocket.CONNECTING) { clearTimeout(retry); connect() } }
    window.addEventListener('online', wake); document.addEventListener('visibilitychange', wake)
    return () => { closed = true; clearTimeout(retry); clearTimeout(timeout.current); clearInterval(ping); ws?.close(); window.removeEventListener('online', wake); document.removeEventListener('visibilitychange', wake) }
  }, [route?.token, route?.tabId])
  const currentId = route?.tabId ?? active
  useEffect(() => { if (currentId && currentId !== active) setActive(currentId) }, [currentId, active])
  useLayoutEffect(() => {
    const saved = positions.current[active]
    stick.current = saved?.bottom ?? true
    setAway(!stick.current)
    if (scroll.current) scroll.current.scrollTop = saved?.top ?? scroll.current.scrollHeight
  }, [active])
  useLayoutEffect(() => { if (stick.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight }, [snapshot])
  useLayoutEffect(() => { if (editor.current) { editor.current.style.height = 'auto'; editor.current.style.height = `${editor.current.scrollHeight}px` } }, [draft, active])
  const changeChat = (chat: RemoteLinkChat): void => {
    if (scroll.current) positions.current[active] = { top: scroll.current.scrollTop, bottom: stick.current }
    setMenu(false); setActive(chat.tabId)
  }
  const command: Command = (action, payload = {}) => {
    if (socket.current?.readyState !== WebSocket.OPEN || !route) { notify('Sem conexão. Aguarde reconectar.'); return }
    if (pendingRef.current) return
    const sent = { action, text: action === 'send' ? drafts[active] ?? '' : undefined }
    const chatId = active
    pendingRef.current = sent; setPending(sent)
    void request(action, payload).then(() => {
      if (action === 'send') {
        setDrafts(previous => previous[chatId] === sent.text ? { ...previous, [chatId]: '' } : previous)
        notify(busy ? 'Mensagem adicionada à fila' : 'Mensagem enviada'); stick.current = true
      } else if (action === 'stop') notify('Interrupção solicitada')
    }, error => notify(error.message)).finally(() => {
      if (pendingRef.current === sent) { pendingRef.current = null; setPending(null) }
    })
  }
  const send = (): void => { if (!draft.trim() || pending) return; command('send', { text: draft.trim() }) }
  const pendingTurn = snapshot?.turns.find(t => t.pendingPerm || t.pendingQuestion)
  const asyncSource = !pendingTurn ? latestStructuredQuestions(snapshot?.turns || []) : null
  const questionKey = asyncSource ? `${active}:${asyncSource.key}` : ''
  const answerAsync = async (text: string): Promise<void> => {
    if (!asyncSource || !route || !connected || pendingRef.current) throw new Error('Aguarde a conexão ou a ação atual terminar.')
    const chatId = active, source = asyncSource, key = questionKey
    const answerSocket = socket.current
    const ask = (action: string, payload: Record<string, unknown>): Promise<any> => {
      if (answerSocket !== socket.current) return Promise.reject(new Error('A conversa mudou. A resposta foi mantida na conversa original.'))
      return request(action, payload)
    }
    const current = latestSnapshots.current[chatId]
    if (current?.turns.some(turn => turn.pendingPerm || turn.pendingQuestion)) throw new Error('Responda à aprovação ou à pergunta pendente primeiro.')
    if (latestStructuredQuestions(current?.turns || [])?.key !== source.key) throw new Error('Esta pergunta já foi respondida ou mudou.')
    const sent = { action: 'async-answer' }
    pendingRef.current = sent; setPending(sent)
    try {
      let queued = queuedAnswers.current.get(key)
      if (queued && current?.queued && !current.queued.some(row => row.id === queued?.id)) { queuedAnswers.current.delete(key); queued = undefined }
      if (busy || queued) {
        const id = queued?.id || `question:${source.key}`
        if (!queued) {
          const accepted = await ask('queue', { operation: 'add', message: { id, text } })
          queuedAnswers.current.set(key, { id: accepted?.id || id, text })
        } else if (queued.text !== text) {
          await ask('queue', { operation: 'replace', id, message: { text } })
          queuedAnswers.current.set(key, { id, text })
        }
        try { await ask('queue', { operation: 'send', id: queuedAnswers.current.get(key)?.id }) }
        catch (failure) {
          // The normal queue can finish sending between the add and send acknowledgements.
          const delivered = latestSnapshots.current[chatId]?.turns.some(turn => turn.role === 'user' && turn.text === text || turn.segments?.some(segment => segment.kind === 'user' && segment.text === text))
          if (!delivered) throw new Error(`${(failure as Error).message} A resposta continua na fila; você pode enviá-la novamente.`)
        }
        queuedAnswers.current.delete(key)
      } else {
        const accepted = await ask('send', { text })
        // A turn may start while the send is in flight; the backend then queues the answer.
        if (typeof accepted?.id === 'string') {
          queuedAnswers.current.set(key, { id: accepted.id, text })
          await ask('queue', { operation: 'send', id: accepted.id })
          queuedAnswers.current.delete(key)
        }
      }
      setAnsweredQuestions(previous => ({ ...previous, [key]: true })); notify('Resposta enviada'); stick.current = true
    } finally {
      if (pendingRef.current === sent) { pendingRef.current = null; setPending(null) }
    }
  }
  const title = snapshot?.title ?? route?.title ?? 'Controle remoto'
  const status = connected ? busy ? pendingTurn ? 'Aguardando você' : 'Trabalhando' : 'Conectado' : route ? 'Reconectando…' : 'Sem conversas compartilhadas'
  return <RemoteContext.Provider value={{ request, command }}><div className="rm-app"><a className="rm-skip" href="#transcript">Ir para as mensagens</a><header className="rm-header"><button type="button" aria-label="Trocar conversa" aria-haspopup="dialog" className="rm-icon" disabled={!chats.length} onClick={() => setMenu(true)}><Menu size={20} /></button><div className="rm-heading"><h1>{title}</h1><span className="rm-status"><span className={`rm-dot ${connected ? 'online' : ''}`} />{status}{chats.length > 1 ? ` · ${chats.length} conversas` : ''}</span></div><span className="rm-brand">Prism</span></header>
    {!connected && route ? <div className="rm-offline" role="status"><WifiOff size={14} />Reconectando ao computador. Seu rascunho está salvo nesta tela.</div> : null}
    <div className="rm-transcript-frame"><main id="transcript" tabIndex={-1} className="rm-scroll" ref={scroll} onScroll={e => { const node = e.currentTarget; stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80; setAway(!stick.current); positions.current[active] = { top: node.scrollTop, bottom: stick.current } }}><div className="rm-messages">{!route ? <div className="rm-empty"><MessageSquare size={28} /><h2>Abra suas conversas aqui</h2><p>No computador, abra Controle remoto, selecione as conversas e escaneie o QR. Você pode trocar de chat nesta mesma tela.</p></div> : !snapshot ? <div className="rm-empty" role="status">Conectando à conversa…</div> : snapshot.turns.length ? snapshot.turns.map((turn, i) => <Message key={turn.id} turn={turn} working={busy && i === snapshot.turns.length - 1 && turn.role === 'assistant'} />) : <div className="rm-empty"><Sparkles size={28} /><h2>O que vamos fazer?</h2><p>Envie uma mensagem para o agente.</p></div>}
      {pendingTurn?.pendingPerm ? <Permission key={pendingTurn.pendingPerm.permId} turn={pendingTurn} command={command} disabled={!!pending || !connected} /> : null}{pendingTurn?.pendingQuestion ? <Question key={pendingTurn.pendingQuestion.dialogId} turn={pendingTurn} command={command} disabled={!!pending || !connected} /> : null}{asyncSource && !answeredQuestions[questionKey] ? <AsyncQuestion key={questionKey} source={asyncSource} answer={answerAsync} disabled={!!pending || !connected} /> : null}</div></main>{away ? <button type="button" className="rm-latest" onClick={() => { stick.current = true; setAway(false); scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }) }}><ArrowDown size={16} />Mais recente</button> : null}</div>
    {route ? <div className="rm-dock" key={active}><Queue rows={snapshot?.queued} paused={snapshot?.queuePaused} disabled={!!pending || !connected} /><Files revision={snapshot?.updatedAt} /></div> : null}
    {route ? <footer className="tcm-area rm-composer"><Controls selection={snapshot?.selection} busy={busy} disabled={!!pending || !connected} /><div className="tcm-shell"><div className="tcm-editor-frame"><label className="sr-only" htmlFor="message">Mensagem para o agente</label><textarea id="message" ref={editor} className="tcm-editor" rows={1} enterKeyHint="enter" autoCapitalize="sentences" placeholder={busy ? 'Mensagem para a fila…' : 'Peça para o agente fazer algo…'} value={draft} onChange={e => setDrafts(current => ({ ...current, [active]: e.target.value }))} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && matchMedia('(pointer: fine)').matches) { e.preventDefault(); send() } }} /></div><div className="rm-composer-toolbar"><span className="rm-composer-hint">{pending?.action === 'send' ? 'Enviando…' : busy ? 'Adicionar à fila' : 'Mensagem'}</span><div className="rm-composer-actions">{busy ? <button type="button" className="rm-send rm-stop" aria-label="Parar o agente" disabled={!connected || !!pending} onClick={() => command('stop')}><Square size={15} fill="currentColor" /></button> : null}<button type="button" className="rm-send" aria-label={busy ? "Adicionar à fila" : "Enviar mensagem"} disabled={!connected || !draft.trim() || !!pending} onClick={send}><ArrowUp size={20} /></button></div></div></div></footer> : null}
    <dialog className="rm-conversations" ref={dialog} aria-labelledby="conversation-title" onCancel={() => setMenu(false)} onClick={e => { if (e.target === e.currentTarget) setMenu(false) }}><div className="rm-sheet-head"><h2 id="conversation-title">Conversas</h2><button type="button" className="rm-icon" aria-label="Fechar conversas" onClick={() => setMenu(false)}><X size={20} /></button></div><div className="rm-chat-list">{chats.map(chat => <button type="button" className="rm-chat-item" key={chat.tabId || chat.token} aria-current={chat.tabId === active ? 'page' : undefined} onClick={() => changeChat(chat)}><MessageSquare size={18} /><span><strong>{snapshots[chat.tabId]?.title ?? chat.title}</strong><small>{snapshots[chat.tabId]?.streaming ? 'Trabalhando' : 'Conversa compartilhada'}</small></span>{chat.tabId === active ? <Check size={18} /> : <ChevronRight size={18} />}</button>)}</div><p>Troque de conversa sem abrir outra guia.</p></dialog>
    <div className={`rm-toast ${notice ? 'show' : ''}`} role="status" aria-live="polite">{notice}</div>
  </div></RemoteContext.Provider>
}
const theme = new URLSearchParams(location.hash.slice(1)).get('theme')
if (theme && /^prism-[a-z-]+$/.test(theme)) { document.documentElement.dataset.theme = theme; document.documentElement.dataset.appearance = theme.includes('light') ? 'light' : 'dark' }
createRoot(document.getElementById('root')!).render(<App />)
