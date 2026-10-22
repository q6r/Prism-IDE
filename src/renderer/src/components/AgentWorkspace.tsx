import { useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { AlertTriangle } from 'lucide-react'
import { useAgentChats, remoteTargetNow } from '../lib/agentChats'
import { useStore } from '../store'
import { useAgentTasks } from '../lib/agentTasks'
import AgentMonitor from './AgentMonitor'
import TraycerImportModal from './TraycerImportModal'
import AgentSidebar from './agent/AgentSidebar'
import AgentHeader from './agent/AgentHeader'
import AgentTranscript from './agent/AgentTranscript'
import AgentComposer from './agent/AgentComposer'
import { ChatDetails, ChangedFiles, useChatGit } from './agent/AgentChatDetails'
import { Notice } from './chat/Notice'
import '../styles/chat.css'

/**
 * The agent workspace shell. Each region lives in its own file under
 * `components/agent/` so it can be restyled independently:
 * AgentSidebar (agents list) · AgentHeader · AgentTranscript · AgentComposer.
 */
export default function AgentWorkspace({ compact = false }: { compact?: boolean }) {
  // Narrow subscriptions: a streaming turn must not re-render the shell.
  const ready = useAgentChats((s) => s.ready)
  const hostError = useAgentChats((s) => s.hostError)
  const chatCount = useAgentChats((s) => s.chats.length)
  const chat = useAgentChats(useShallow((s) => {
    const c = s.chats.find((x) => x.id === s.activeId)
    return c ? { id: c.id, started: c.turns.length > 0 || (c.historyTurnCount ?? 0) > 0, cwd: c.cwd, cwdPinned: c.cwdPinned, remoteId: c.remoteId, child: !!c.parentChatId } : null
  }))
  const tasksReady = useAgentTasks((s) => s.ready)
  const restoringChats = useAgentTasks((s) => s.restoringChats)
  const activeTaskId = useAgentTasks((s) => s.activeId)
  const taskHasChat = useAgentChats((s) => s.chats.some((c) => c.taskId === activeTaskId))
  const folderPath = useStore((s) => s.folderPath)
  const remote = useStore((s) => s.remote)
  const openSessionReq = useStore((s) => s.openSessionReq)
  const pendingAttachment = useStore((s) => s.pendingChatAttachment)
  const traycerImportOpen = useStore((s) => s.traycerImportOpen)
  const [monitorOpen, setMonitorOpen] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null)
  const git = useChatGit()

  useEffect(() => { void useAgentChats.getState().init().catch(() => {}) }, [])
  useEffect(() => {
    if (ready && tasksReady && !restoringChats && !taskHasChat) useAgentChats.getState().create(folderPath || '', remote?.id)
  }, [ready, tasksReady, restoringChats, activeTaskId, chatCount])
  // An unstarted chat follows the open folder. A child agent keeps the
  // workspace it inherited from its parent unless it has none.
  useEffect(() => {
    if (!chat || chat.started || chat.cwdPinned || !folderPath) return
    if (chat.child ? !chat.cwd : chat.cwd !== folderPath || chat.remoteId !== remote?.id) useAgentChats.getState().bindWorkspace(chat.id, folderPath, remote?.id)
  }, [chat?.id, folderPath, remote?.id])
  useEffect(() => {
    if (!ready || !openSessionReq) return
    const ref = openSessionReq
    useStore.getState().consumeOpenSession()
    void window.prism.sessions.read(ref.file, remote?.id).then((turns) => {
      useAgentChats.getState().importSession({ id: crypto.randomUUID(), title: ref.title, cwd: ref.cwd || folderPath || '', remoteId: remote?.id, remoteTarget: remoteTargetNow(),
        selection: { provider: 'claude', profileId: 'ambient-claude', model: useStore.getState().settings.model, effort: 'high', permissionMode: 'default' },
        resume: { route: 'claude:ambient-claude', sessionId: ref.id }, updatedAt: Date.now(),
        turns: turns.map((t) => ({ id: crypto.randomUUID(), role: t.role, text: t.text || '', segments: t.segments,
          provider: t.role === 'assistant' ? 'claude' : undefined })) })
    }).catch((err) => useStore.getState().addToast('error', err.message))
  }, [openSessionReq, ready])
  useEffect(() => {
    if (!chat || !pendingAttachment) return
    useAgentChats.getState().contextDraft(chat.id, `${pendingAttachment.source || 'Código selecionado'}\n\`\`\`${pendingAttachment.lang || ''}\n${pendingAttachment.text}\n\`\`\``)
    useStore.getState().consumeChatAttachment()
  }, [pendingAttachment, chat?.id])

  const newChat = (): void => { useAgentChats.getState().create(folderPath || '', remote?.id); requestAnimationFrame(() => input.current?.focus()) }

  return <div className={`agent-workspace${compact ? ' compact' : ''}`}>
    {!compact && <AgentSidebar onNewChat={newChat} />}
    <main className="agent-conversation">
      <AgentHeader compact={compact} monitorOpen={monitorOpen} onToggleMonitor={() => setMonitorOpen(v => !v)} onNewChat={newChat} />
      {monitorOpen && <AgentMonitor onClose={() => setMonitorOpen(false)} onAccounts={() => useStore.getState().openSettings('providers')} />}
      {hostError ? <div className="ch-notices"><Notice tone="warning" icon={<AlertTriangle size={14} />}>{hostError}</Notice></div> : null}
      <AgentTranscript onStarter={(text) => { if (chat) useAgentChats.getState().draft(chat.id, text); input.current?.focus() }} />
      <AgentComposer inputRef={input} changes={<ChangedFiles git={git} />} details={<ChatDetails git={git} />} />
    </main>
    {traycerImportOpen && <TraycerImportModal onClose={() => useStore.getState().setTraycerImportOpen(false)} />}
  </div>
}
