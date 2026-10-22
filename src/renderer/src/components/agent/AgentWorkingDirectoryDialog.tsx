import { useId, useRef, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { useAgentChats } from '../../lib/agentChats'
import { subagentActive } from '../../../../shared/subagents'
import { useStore } from '../../store'
import { Button, Spinner } from '../ui'
import Dialog from '../shell/Dialog'
import '../../styles/shell.css'

/** The target id is captured by the opener; selecting another chat cannot redirect a save. */
export default function AgentWorkingDirectoryDialog({ chatId, onClose }: { chatId: string; onClose: () => void }) {
  const chat = useAgentChats(s => s.chats.find(c => c.id === chatId))
  const running = useAgentChats(s => !!s.runtime[chatId]?.busy || s.chats.some(c => c.nativeAgent?.rootChatId === chatId && (!!s.subagentSending[c.id] || !!s.runtime[c.id]?.busy || subagentActive(c.nativeAgent.status))))
  const [path, setPath] = useState(() => useAgentChats.getState().chats.find(c => c.id === chatId)?.cwd || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const operation = useRef(false)
  const id = useId()
  if (!chat) return null
  const pick = async (): Promise<void> => {
    if (operation.current) return
    operation.current = true; setBusy(true); setError('')
    try { const selected = await window.prism.dialog.openFolder(); if (selected !== null) setPath(selected) }
    catch (err) { setError((err as Error).message || 'Não foi possível escolher a pasta.') }
    finally { operation.current = false; setBusy(false) }
  }
  const save = async (): Promise<void> => {
    if (operation.current || running || !path) return
    operation.current = true; setBusy(true); setError('')
    try {
      await useAgentChats.getState().changeWorkingDirectory(chatId, path)
      useStore.getState().addToast('success', 'Pasta da conversa alterada.')
      onClose()
    } catch (err) { setError((err as Error).message || 'Não foi possível trocar a pasta.') }
    finally { operation.current = false; setBusy(false) }
  }
  const label = chat.remoteId ? 'Caminho absoluto no servidor SSH' : 'Caminho absoluto da pasta'
  return <Dialog onClose={onClose} busy={busy} title={<><FolderOpen size={16} />Trocar pasta de trabalho</>}
    description="O histórico será mantido. As próximas tarefas desta conversa usarão a nova pasta."
    className="ch-directory-dialog" footer={<>
      <Button variant="outline" size="sm" disabled={busy} onClick={onClose}>Cancelar</Button>
      <Button size="sm" disabled={busy || running || !path} onClick={() => void save()}>{busy && <Spinner />}Trocar pasta</Button>
    </>}>
    <form className="ch-directory-body" onSubmit={event => { event.preventDefault(); void save() }}>
      <label className="ps-shell-field" htmlFor={`${id}-path`}><span>{label}</span>
        <input id={`${id}-path`} aria-label={label} data-autofocus autoFocus className="ps-shell-input" value={path} disabled={busy}
          autoComplete="off" spellCheck={false} aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined}
          onChange={event => { setPath(event.target.value); setError('') }} />
      </label>
      {!chat.remoteId && <Button variant="outline" size="sm" disabled={busy} onClick={() => void pick()}><FolderOpen size={14} />Escolher pasta…</Button>}
      {running && <p role="status" className="ch-directory-hint">Aguarde a tarefa e os subagentes terminarem para trocar a pasta.</p>}
      {error && <p id={`${id}-error`} className="ps-shell-error" role="alert">{error}</p>}
      <button type="submit" className="tr-sr-only" tabIndex={-1}>Aplicar pasta</button>
    </form>
  </Dialog>
}
