import { useLayoutEffect, useRef } from 'react'
import { ArrowUp } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useAgentChats } from '../../lib/agentChats'
import { Button } from '../ui'

/** Native child controls use a separate command and keep the parent's session. */
export function SubagentComposer({ chatId }: { chatId: string }) {
  const chat = useAgentChats(useShallow(s => {
    const c = s.chats.find(chat => chat.id === chatId)
    return c ? { draft: c.draft || '', provider: c.selection.provider, name: c.title } : null
  }))
  const pending = useAgentChats(s => !!s.subagentSending[chatId])
  const waiting = useAgentChats(s => !!s.runtime[chatId]?.permission || !!s.runtime[chatId]?.question)
  const editor = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    if (!editor.current) return
    editor.current.style.height = 'auto'
    editor.current.style.height = `${editor.current.scrollHeight}px`
  }, [chat?.draft])
  if (!chat) return null
  const relay = chat.provider === 'claude'
  const send = async (): Promise<void> => {
    if (pending || waiting || !chat.draft.trim()) return
    const draft = chat.draft
    if (await useAgentChats.getState().messageSubagent(chatId, draft)) {
      if (useAgentChats.getState().chats.find(c => c.id === chatId)?.draft === draft) useAgentChats.getState().draft(chatId, '')
    }
  }
  return <div className="tcm-area ch-subagent-composer">
    <div className="tcm-shell">
      <div className="tcm-editor-frame"><label className="sr-only" htmlFor="subagent-message">Mensagem para {chat.name}</label>
        <textarea id="subagent-message" ref={editor} className="tcm-editor" rows={1} value={chat.draft} maxLength={200000}
          placeholder={relay ? 'Instrução para este subagente, pelo agente principal…' : 'Mensagem para este subagente…'}
          onChange={e => useAgentChats.getState().draft(chatId, e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send() } }} />
      </div>
      <div className="ch-subagent-composer-actions"><span>{waiting ? 'Responda à solicitação acima.' : relay ? 'Claude entrega pelo agente principal com SendMessage.' : 'Envia à mesma conversa nativa deste subagente.'}</span>
        <Button size="icon" aria-label={relay ? 'Encaminhar pelo agente principal' : 'Enviar ao subagente'} disabled={pending || waiting || !chat.draft.trim()} onClick={() => void send()}><ArrowUp size={18} /></Button>
      </div>
    </div>
  </div>
}
