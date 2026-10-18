import { useEffect, useId, useRef, useState } from 'react'
import { ChevronDown, GripVertical, ImagePlus, ListOrdered, Pause, Pencil, Play, SendHorizontal, Trash2 } from 'lucide-react'
import { useAgentChats } from '../../lib/agentChats'
import type { QueuedMessage } from '../../../../shared/agents'
import { Button, Spinner, Tooltip } from '../ui'

const EMPTY: QueuedMessage[] = []

export default function MessageQueue({ chatId, editing, onEdit }: {
  chatId?: string; editing?: QueuedMessage; onEdit: (item: QueuedMessage) => void
}) {
  const items = useAgentChats(s => s.chats.find(c => c.id === chatId)?.queued) ?? EMPTY
  const paused = useAgentChats(s => !!s.chats.find(c => c.id === chatId)?.queuePaused)
  const readOnly = useAgentChats(s => !!s.chats.find(c => c.id === chatId)?.readOnly)
  const remote = useAgentChats(s => !!s.chats.find(c => c.id === chatId)?.remoteId)
  const run = useAgentChats(s => chatId ? s.runtime[chatId] : undefined)
  const stopping = useAgentChats(s => !!chatId && !!s.stopping[chatId])
  const steering = useAgentChats(s => chatId ? s.steering[chatId] : undefined)
  const [open, setOpen] = useState(true)
  const drag = useRef<QueuedMessage | null>(null)
  const listId = useId()
  useEffect(() => setOpen(true), [chatId])
  if (!chatId || !items.length) return null
  const canResume = paused || !run?.busy
  const disabled = readOnly || stopping || !!steering
  const steerDisabled = disabled || (run?.busy && (remote || !!run.permission || !!run.question || !run.turnId))
  const state = useAgentChats.getState
  return <section className="tcm-queue" aria-label="Fila de mensagens" data-testid="queued-message-rows">
    <div className="tcm-queue-heading">
      <button type="button" className="tcm-queue-toggle" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(v => !v)}>
        <ChevronDown size={12} className={open ? '' : 'collapsed'} aria-hidden />
        {run?.busy && !canResume ? <Spinner label="Fila em execução" /> : null}
        <span className="tcm-queue-title">Fila de mensagens</span><span aria-hidden className="tcm-queue-divider">·</span>
        <ListOrdered size={14} aria-hidden />
        <span className="tr-truncate">{items.length} {items.length === 1 ? 'mensagem' : 'mensagens'}</span>
      </button>
      <Button variant="outline" size="xs" className="tcm-queue-pause" disabled={readOnly || !!steering} onClick={() => state().pauseQueue(chatId, !canResume)}>
        {canResume ? <Play aria-hidden /> : <Pause aria-hidden />}{canResume ? 'Retomar' : 'Pausar'}
      </Button>
    </div>
    {open ? <div id={listId} className="tcm-queue-list" data-testid="queued-message-list">
      {items.map((item, index) => <div key={item.id ?? index} className="tcm-queue-item" data-editing={editing === item || undefined}
        onDragOver={e => { if (drag.current && !disabled) e.preventDefault() }}
        onDrop={e => { e.preventDefault(); const from = items.indexOf(drag.current!); drag.current = null; if (!disabled) state().reorderQueued(chatId, from, index) }}>
        <button type="button" className="tcm-queue-grip" aria-label={`Reordenar mensagem ${index + 1}; use as setas para cima e para baixo`}
          disabled={disabled || items.length < 2} draggable={!disabled && items.length > 1}
          onDragStart={e => { drag.current = item; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(index)) }}
          onDragEnd={() => { drag.current = null }}
          onKeyDown={e => { if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); state().reorderQueued(chatId, index, index + (e.key === 'ArrowUp' ? -1 : 1)) } }}>
          <GripVertical size={14} aria-hidden />
        </button>
        <div className="tcm-queue-content" data-testid="queued-message-content-scroll">
          <div className="tcm-queue-actions" data-testid="queued-message-row-toolbar">
            <span className="tcm-queue-status">{steering === item ? <><Spinner />Enviando</> : editing === item ? 'Editando' : canResume ? 'Pausada' : 'Na fila'}</span>
            <Tooltip label="Editar mensagem na fila"><Button variant="muted" size="icon" aria-label="Editar mensagem na fila" disabled={disabled} onClick={() => onEdit(item)}><Pencil /></Button></Tooltip>
            <Tooltip label="Excluir mensagem da fila"><Button variant="muted" size="icon" aria-label="Excluir mensagem da fila" disabled={disabled} onClick={() => state().dequeue(chatId, index)}><Trash2 /></Button></Tooltip>
            <Tooltip label={remote && run?.busy ? 'Envio durante o turno indisponível nesta conexão SSH' : 'Enviar mensagem agora'}>
              <span className="tcm-steer-guard"><Button variant="muted" size="icon" aria-label="Enviar mensagem agora" disabled={steerDisabled || editing === item}
                onClick={() => { void state().steerQueued(chatId, index) }}><SendHorizontal /></Button></span>
            </Tooltip>
          </div>
          <span className="tcm-queue-text">{item.text || 'Imagem anexada'}</span>
          {item.images?.length ? <span className="tcm-queue-imgs"><ImagePlus size={12} aria-hidden />{item.images.length} {item.images.length === 1 ? 'imagem' : 'imagens'}</span> : null}
        </div>
      </div>)}
    </div> : null}
  </section>
}
