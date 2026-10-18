import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import type { SharedTurn } from '../../../../shared/agents'
import { collectChatImages, type ImageReference } from '../../../../shared/imageReferences'
import type { ChatRuntime } from '../../lib/agentChats'
import { ChevronDown, FolderOpen, Info, UserRound } from 'lucide-react'
import { useAgentChats } from '../../lib/agentChats'
import { latestStructuredQuestions } from '../../lib/asyncQuestions'
import { useStore } from '../../store'
import { Button, Spinner } from '../ui'
import PermissionPrompt from '../PermissionPrompt'
import QuestionPrompt from '../QuestionPrompt'
import { AssistantMessage, UserMessage, type SignInAction } from '../chat/Messages'
import { EmptyState } from '../chat/EmptyState'
import { Notice } from '../chat/Notice'
import { pickWorkingVerb } from '../chat/activity'
import { SignInDialog } from '../settings/providers/ProfileDialogs'
import { needsSignIn, reauthTarget } from './reauth'
import '../../styles/chat.css'

const EDGE_PX = 100
const EMPTY_TURNS: SharedTurn[] = []
const ListEdge = () => <div style={{ height: 16 }} aria-hidden />
const LIST_COMPONENTS = { Header: ListEdge, Footer: ListEdge }

// Immutable turns retain their references while another turn streams.
const TranscriptRow = memo(function TranscriptRow({ turn, sentAt, runtime, cwd, signIn, imageCatalog }: {
  turn: SharedTurn; sentAt?: number; runtime?: ChatRuntime; cwd?: string; signIn?: SignInAction; imageCatalog: readonly ImageReference[]
}) {
  return <div className="ch-list-row" data-turn-id={turn.id}>
    {turn.role === 'user' ? <UserMessage turn={turn} sentAt={sentAt} imageCatalog={imageCatalog} />
      : <AssistantMessage turn={turn} runtime={runtime} cwd={cwd} signIn={signIn} imageCatalog={imageCatalog} />}
  </div>
})

/**
 * Chat notices, the scrolling transcript (or the empty state) and, docked
 * above the composer, the pending approval / question cards — Traycer's chat
 * tile body (chat-messages.tsx + chat-tile lower surfaces).
 */
export default function AgentTranscript({ onStarter }: { onStarter: (text: string) => void }) {
  const chat = useAgentChats(useShallow((s) => {
    const c = s.chats.find((x) => x.id === s.activeId)
    return c ? { id: c.id, turns: c.turns, cwd: c.cwd, selection: c.selection,
      readOnly: c.readOnly, sourceHarness: c.sourceHarness, workspaceNeedsBinding: c.workspaceNeedsBinding,
      accountNeedsSelection: c.accountNeedsSelection, nativeAgent: c.nativeAgent } : undefined
  }))
  const runtime = useAgentChats((s) => chat ? s.runtime[chat.id] : undefined)
  // Image identities stay unchanged while text streams; numbering uses the full history.
  const imageSources = useAgentChats(useShallow(s => {
    const c = s.chats.find(x => x.id === s.activeId)
    return c ? [...c.turns.flatMap(t => [...(t.images || []), ...(t.segments || []).flatMap(segment => segment.images || [])]),
      ...(c.queued || []).flatMap(item => item.images || []), ...(s.attachments[c.id] || [])] : []
  }))
  const imageCatalog = useMemo(() => collectChatImages({ turns: [{ id: 'images', role: 'user', text: '', images: imageSources }] }), [imageSources])
  const profiles = useAgentChats((s) => s.profiles)
  const folderPath = useStore((s) => s.folderPath)
  const busy = runtime?.busy === true
  const list = useRef<VirtuosoHandle>(null)
  const [away, setAway] = useState(false)
  // "Entrar novamente" (a turn whose login is gone): the chat's account, through the Settings sign-in.
  const [signingIn, setSigningIn] = useState<string | null>(null)
  const profileBusy = useAgentChats((s) => !!chat && s.chats.some((c) => c.selection.profileId === chat.selection.profileId && !!s.runtime[c.id]?.busy))
  const target = chat ? reauthTarget(chat, profiles, profileBusy) : null
  const signIn = useMemo<SignInAction | undefined>(() => target
    ? { blocked: target.blocked, onSignIn: () => setSigningIn(target.profile.id) } : undefined, [target?.profile.id, target?.blocked])
  const signInProfile = signingIn ? profiles.find((p) => p.id === signingIn) : undefined

  const toBottom = (smooth = false): void => {
    list.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: smooth ? 'smooth' : 'auto' })
  }
  useEffect(() => {
    setAway(false)
  }, [chat?.id])

  const turns = chat?.turns || EMPTY_TURNS
  const structuredQuestions = useMemo(() => latestStructuredQuestions(turns), [turns])
  const [dismissedQuestions, setDismissedQuestions] = useState<Set<string>>(() => new Set())
  const asyncQuestion = chat && !chat.readOnly && structuredQuestions && !dismissedQuestions.has(structuredQuestions.key)
    ? structuredQuestions : null
  const answerAsync = async (answers: Record<string, string>): Promise<boolean> => {
    if (!chat || !asyncQuestion) return false
    const key = asyncQuestion.key
    const accepted = await useAgentChats.getState().replyToQuestions(chat.id, key, answers)
    if (accepted) setDismissedQuestions(previous => new Set([...previous, key]))
    return accepted
  }
  // Jump after the first measured range. Initial align:end can wait forever
  // for a scroll event when a short history already fits in the viewport.
  const initialRange = useMemo(() => ({ pending: true }), [chat?.id])
  const chooseFolder = (): void => {
    if (!chat) return
    void window.prism.dialog.openFolder().then((cwd) => { if (cwd) useAgentChats.getState().bindWorkspace(chat.id, cwd) }).catch((err) => useStore.getState().addToast('error', err.message))
  }

  return <div className="ch-surface">
    {chat && (chat.readOnly || chat.workspaceNeedsBinding || chat.accountNeedsSelection) ? <div className="ch-notices">
      {chat.readOnly ? <Notice tone="info" icon={<Info size={14} />}
        action={chat.nativeAgent ? <Button variant="outline" size="xs" onClick={() => useAgentChats.getState().select(chat.nativeAgent!.rootChatId)}>Voltar à conversa principal</Button> : undefined}>
        {chat.nativeAgent ? 'Subagente nativo · atividade acompanhada ao vivo. O controle fica na conversa principal.'
          : <>Agente {chat.sourceHarness} · histórico em leitura. Continue a execução no Traycer.</>}
      </Notice> : null}
      {chat.workspaceNeedsBinding && !chat.readOnly ? <Notice tone="warning" icon={<FolderOpen size={14} />}
        action={<Button variant="outline" size="xs" disabled={busy} onClick={chooseFolder}><FolderOpen aria-hidden /> Escolher pasta</Button>}>
        Escolha uma pasta local para continuar este chat importado.
      </Notice> : null}
      {chat.accountNeedsSelection && !chat.readOnly ? <Notice tone="warning" icon={<UserRound size={14} />}
        action={<Button variant="outline" size="xs" disabled={busy} onClick={() => useAgentChats.getState().confirmAccount(chat.id)}>Usar conta selecionada</Button>}>
        A conta original não foi importada. Escolha a conta no seletor de modelo.
      </Notice> : null}
    </div> : null}

    <div className="ch-scroll-frame">
      {!turns.length
        ? <div className="ch-scroll" data-selection-root=""><EmptyState onStarter={onStarter} needsFolder={!folderPath} onOpenFolder={() => void useStore.getState().openFolderDialog()} /></div>
        : <Virtuoso key={chat?.id} ref={list} className="ch-scroll ch-virtual" data-selection-root=""
          components={LIST_COMPONENTS} data={turns} computeItemKey={(_i, turn) => turn.id}
          itemsRendered={() => {
            if (!initialRange.pending) return
            initialRange.pending = false
            const handle = list.current
            requestAnimationFrame(() => handle?.scrollToIndex({ index: 'LAST', align: 'end' }))
          }}
          defaultItemHeight={160} increaseViewportBy={{ top: 400, bottom: 200 }} atBottomThreshold={EDGE_PX}
          followOutput={(bottom) => bottom ? 'auto' : false}
          atBottomStateChange={(bottom) => setAway(!bottom)}
          totalListHeightChanged={() => list.current?.autoscrollToBottom()}
          itemContent={(i, turn) => <TranscriptRow turn={turn} imageCatalog={imageCatalog}
            sentAt={turns[i + 1]?.role === 'assistant' ? turns[i + 1].startedAt : undefined}
            runtime={busy && runtime?.turnId === turn.id ? runtime : undefined} cwd={chat?.cwd}
            signIn={needsSignIn(turn) ? signIn : undefined} />}
        />}
      {turns.length ? <button type="button" className="ch-pill" data-visible={away || undefined} aria-hidden={away ? undefined : true}
        tabIndex={away ? 0 : -1} aria-label="Rolar até o fim"
        onClick={(e) => { e.currentTarget.blur(); setAway(false); toBottom(true) }}>
        {busy && away ? <Spinner /> : null}
        <span>{busy && runtime ? `${pickWorkingVerb(runtime.turnId)}…` : 'Ir para o mais recente'}</span>
        <ChevronDown size={16} aria-hidden className="ch-pill-chevron" />
      </button> : null}
    </div>

    {chat && (runtime?.permission || runtime?.question || asyncQuestion) ? <div className="ch-dock">
      <div className="ch-dock-inner">
        {runtime?.permission ? <PermissionPrompt perm={runtime.permission} onDecide={(d) => useAgentChats.getState().respondPermission(chat.id, d)} /> : null}
        {runtime?.question ? <QuestionPrompt key={runtime.question.dialogId} pending={runtime.question}
          onSubmit={(a, r) => useAgentChats.getState().respondQuestion(chat.id, a, r)} onCancel={() => useAgentChats.getState().respondQuestion(chat.id)} /> : null}
        {!runtime?.question && !runtime?.permission && asyncQuestion ? <QuestionPrompt key={`async:${asyncQuestion.key}`}
          pending={{ dialogId: asyncQuestion.key, questions: asyncQuestion.questions }} autoFocus={false} cancelLabel="Agora não"
          onSubmit={answerAsync} onCancel={() => setDismissedQuestions(previous => new Set([...previous, asyncQuestion.key]))} /> : null}
      </div>
    </div> : null}
    {signInProfile ? <SignInDialog profile={signInProfile} onClose={() => setSigningIn(null)} /> : null}
  </div>
}
