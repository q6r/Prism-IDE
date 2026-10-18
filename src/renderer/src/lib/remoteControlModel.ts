// Pure remote-control logic for the unified agent chats: the snapshot the
// phone renders and the decision for each phone command. No runtime imports,
// so tests load it directly (node --test); `lib/remoteControl.ts` wires it to
// the stores and IPC.
import type { RemoteChatSnapshotIpc, RemoteTurnIpc } from '../../../preload/index'
import type { SharedSegment, SharedTurn, UnifiedChat, SubagentInfo } from '../../../shared/agents'
import type { PendingPerm } from '../types'
import type { ChatRuntime } from './agentChats'
import { collectChatImages, imageReferenceNumber } from '../../../shared/imageReferences'

/** How many turns / segments per turn a snapshot carries (payload stays small). */
export const MAX_TURNS = 40
export const MAX_SEGMENTS = 40
/** A user message is cut here; assistant text lives in its (already cut) segments. */
export const MAX_USER_TEXT = 4000
/** Rough size budget (serialized chars) for the turns in one snapshot; the newest turn always fits. */
export const MAX_SNAPSHOT_CHARS = 120_000

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export type PermissionDecision = 'allow' | 'allow_always' | 'deny'
export interface RemoteResult { ok: boolean; reason?: string }

function oneLine(value: string, max: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, max)
}

/** Title the phone lists the chat under. */
export function remoteTitle(chat: Pick<UnifiedChat, 'title' | 'turns'>): string {
  const title = chat.title?.trim()
  if (title && title !== 'Novo chat') return title
  const first = chat.turns.find((t) => t.role === 'user')?.text?.trim()
  return first ? oneLine(first, 36) : title || 'Chat'
}

/** One-line hint of what a tool call touched (path, command, pattern, url…). */
export function toolPreview(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const i = input as Record<string, unknown>
  for (const key of ['file_path', 'notebook_path', 'path', 'command', 'pattern', 'url', 'query', 'prompt', 'description']) {
    const v = i[key]
    if (v === undefined || v === null) continue
    const text = oneLine(typeof v === 'string' ? v : String(v), 140)
    if (text) return text
  }
  return ''
}

/** The body of a permission card: the command, the edit, the content or the raw input. */
export function permissionPreview(perm: Pick<PendingPerm, 'input'>): string {
  const i = (perm.input || {}) as Record<string, unknown>
  if (typeof i.command === 'string') return i.command.slice(0, 600)
  if (i.file_path || i.path) {
    const head = String(i.file_path ?? i.path)
    const body = typeof i.new_string === 'string' ? '\n' + i.new_string.slice(0, 500) : ''
    return head + body
  }
  if (typeof i.content === 'string') return i.content.slice(0, 600)
  try {
    return JSON.stringify(i, null, 1).slice(0, 500)
  } catch {
    return ''
  }
}

/** Tool status as the mobile page names it (`run`, `done`, `err`, `denied`, `awaiting`). */
export function remoteStatus(status: SharedSegment['status']): string {
  if (status === 'running' || status === undefined) return 'run'
  if (status === 'error') return 'err'
  return status
}

function imageRefs(images: import('../../../shared/agents').ChatImage[] | undefined, ref: { turnId?: string; toolId?: string; queueId?: string }): import('../../../preload').RemoteImageIpc[] | undefined {
  return images?.map((image, index) => ({ mime: image.mime, name: image.name, ...(image.number !== undefined ? { number: image.number } : {}), ref: { ...ref, index } }))
}
function remoteSubagent(agent: SubagentInfo): SubagentInfo {
  return { id: agent.id.slice(0, 160), chatId: agent.chatId.slice(0, 160), name: agent.name.slice(0, 120), status: agent.status, startedAt: agent.startedAt, updatedAt: agent.updatedAt,
    ...(agent.description !== undefined ? { description: agent.description.slice(0, 1500) } : {}),
    ...(agent.model !== undefined ? { model: agent.model.slice(0, 100) } : {}),
    ...(agent.spawnToolCallId !== undefined ? { spawnToolCallId: agent.spawnToolCallId.slice(0, 160) } : {}),
    ...(agent.activity !== undefined ? { activity: agent.activity.slice(0, 1500) } : {}),
    ...(agent.summary !== undefined ? { summary: agent.summary.slice(0, 6000) } : {}) }
}
function remoteSegment(s: SharedSegment, turnId: string): NonNullable<RemoteTurnIpc['segments']>[number] {
  if (s.kind === 'user') return { kind: 'user', text: (s.text || '').slice(0, 6000), images: imageRefs(s.images, { turnId, toolId: s.toolId }) }
  if (s.kind === 'tool') return { kind: 'tool', name: s.name, status: remoteStatus(s.status), preview: toolPreview(s.input), ...(s.subagent ? { subagent: remoteSubagent(s.subagent) } : {}), ...(s.images?.length ? { images: imageRefs(s.images, { turnId, toolId: s.toolId }) } : {}) }
  const questions = s.kind === 'text' ? s.questions?.filter(question => typeof question.title === 'string' && question.title.trim()).slice(0, 12)
    .map(question => ({ title: question.title, ...(Array.isArray(question.options) ? { options: question.options.filter(option => typeof option === 'string').slice(0, 24) } : {}) })) : undefined
  return { kind: s.kind, text: (s.text || '').slice(0, s.kind === 'thinking' ? 800 : 6000), ...(s.images?.length ? { images: imageRefs(s.images, { turnId, toolId: s.toolId }) } : {}), ...(questions?.length ? { toolId: s.toolId, questions } : {}) }
}

/**
 * One turn for the phone. The pending permission / question lives on the
 * chat's runtime, not on the turn, so it is attached to the running turn here.
 */
export function remoteTurn(t: SharedTurn, running?: ChatRuntime): RemoteTurnIpc {
  if (t.role === 'user') return { id: t.id, role: 'user', text: cut(t.text || '', MAX_USER_TEXT), ...(t.images?.length ? { images: imageRefs(t.images, { turnId: t.id }) } : {}) }
  // The page renders segments when there are any and `text` only otherwise, so
  // the text is never sent twice: with segments it becomes the leading one.
  const original: SharedSegment[] = t.text?.trim() && t.segments?.length ? [{ kind: 'text', text: t.text }, ...t.segments] : t.segments || []
  const spawned = new Set(original.flatMap(s => s.subagent?.spawnToolCallId ? [s.subagent.spawnToolCallId] : []))
  const source = original.filter(s => s.subagent || !s.toolId || !spawned.has(s.toolId))
  let latestQuestion = -1
  for (let index = source.length - 1; index >= 0; index--) {
    if (source[index].kind === 'user') break
    if (source[index].kind === 'text' && source[index].questions?.some(question => typeof question.title === 'string' && question.title.trim())) { latestQuestion = index; break }
  }
  const indices = new Set<number>()
  // Keep native cards reachable while later tools stream, within the existing cap.
  for (let index = source.length - 1; index >= 0 && indices.size < 24; index--) if (source[index].subagent) indices.add(index)
  if (latestQuestion >= 0) indices.add(latestQuestion)
  for (let index = source.length - 1; index >= 0 && indices.size < MAX_SEGMENTS; index--) indices.add(index)
  const visible = [...indices].sort((a, b) => a - b).map(index => source[index])
  const segments = visible.map(s => remoteSegment(s, t.id))
  if (t.interrupted) segments.push({ kind: 'text', text: '⏹ Tarefa interrompida.' })
  const perm = running?.permission
  const question = running?.question
  return {
    id: t.id,
    role: 'assistant',
    text: segments.length ? '' : cut(t.text || '', 6000),
    error: t.error,
    segments,
    pendingPerm: perm ? {
      permId: perm.permId,
      toolName: perm.toolName,
      title: perm.title || perm.displayName,
      desc: perm.description,
      preview: permissionPreview(perm)
    } : undefined,
    pendingQuestion: question ? {
      dialogId: question.dialogId,
      questions: question.questions.map((q) => ({
        question: q.question,
        header: q.header,
        multiSelect: q.multiSelect,
        options: q.options.map((o) => ({ label: o.label, description: o.description }))
      }))
    } : undefined
  }
}

/** The trimmed chat the phone renders; `tabId` is the unified chat id. */
export function buildRemoteSnapshot(chat: UnifiedChat, runtime?: ChatRuntime): RemoteChatSnapshotIpc {
  const catalog = collectChatImages(chat)
  const numbered = (images: import('../../../shared/agents').ChatImage[] | undefined): import('../../../shared/agents').ChatImage[] | undefined => images?.map(image => ({ ...image, number: imageReferenceNumber(catalog, image) }))
  chat = { ...chat, turns: chat.turns.map(turn => ({ ...turn, images: numbered(turn.images), segments: turn.segments?.map(segment => ({ ...segment, images: numbered(segment.images) })) })),
    queued: chat.queued?.map(row => ({ ...row, images: numbered(row.images) })) }
  const busy = !!runtime?.busy
  // Newest first, until the turn cap or the size budget is reached.
  const turns: RemoteTurnIpc[] = []
  let size = 0
  for (const t of chat.turns.slice(-MAX_TURNS).reverse()) {
    const turn = remoteTurn(t, busy && runtime?.turnId === t.id ? runtime : undefined)
    size += JSON.stringify(turn).length
    if (turns.length && size > MAX_SNAPSHOT_CHARS) break
    turns.push(turn)
  }
  return {
    tabId: chat.id,
    selection: chat.selection,
    queued: (chat.queued || []).map(row => ({ ...row, images: imageRefs(row.images, { queueId: row.id }) })),
    queuePaused: !!chat.queuePaused,
    title: remoteTitle(chat),
    streaming: busy,
    // The phone does not show context usage, and native sessions report
    // cumulative totals rather than a reliable per-turn context figure.
    contextPct: 0,
    turns: turns.reverse()
  }
}

/** What a phone command may do to a chat; each call goes to the chat's store action. */
export interface RemoteActions {
  /** Returns whether the store accepted the message (void: fall back to `isBusy`). */
  send: (text: string) => boolean | void
  stop: () => void
  respondPermission: (decision: PermissionDecision) => void
  respondQuestion: (answers?: Record<string, string>, response?: string) => void
  /** Read after `send`: true when the store actually started a run. */
  isBusy: () => boolean
}

const DECISIONS: readonly PermissionDecision[] = ['allow', 'allow_always', 'deny']

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].trim() !== ''))
}

/**
 * Decides and runs one phone command (`send`, `stop`, `perm`, `question`)
 * against a chat, returning the ack the phone shows. Reasons the mobile page
 * understands: no-chat, empty, busy, gone, read-only, blocked, idle, invalid,
 * unknown.
 */
export function runRemoteCommand(
  chat: UnifiedChat | undefined,
  runtime: ChatRuntime | undefined,
  action: string,
  payload: Record<string, unknown>,
  act: RemoteActions
): RemoteResult {
  if (!chat) return { ok: false, reason: 'no-chat' }
  const busy = !!runtime?.busy
  if (action === 'send') {
    const text = typeof payload.text === 'string' ? payload.text.trim() : ''
    if (!text) return { ok: false, reason: 'empty' }
    if (chat.readOnly) return { ok: false, reason: 'read-only' }
    if (busy) return { ok: false, reason: 'busy' }
    const accepted = act.send(text)
    // The store refuses some sends with a toast on the desktop (imported chat
    // without folder/account, SSH target mismatch): report that to the phone.
    const ok = typeof accepted === 'boolean' ? accepted : act.isBusy()
    return ok ? { ok: true } : { ok: false, reason: 'blocked' }
  }
  if (action === 'stop') {
    if (!busy) return { ok: false, reason: 'idle' }
    act.stop()
    return { ok: true }
  }
  if (action === 'perm') {
    const decision = payload.decision as PermissionDecision
    if (!DECISIONS.includes(decision)) return { ok: false, reason: 'invalid' }
    const perm = runtime?.permission
    if (!busy || !perm || perm.permId !== payload.permId) return { ok: false, reason: 'gone' }
    if (payload.turnId !== undefined && payload.turnId !== runtime?.turnId) return { ok: false, reason: 'gone' }
    act.respondPermission(decision)
    return { ok: true }
  }
  if (action === 'question') {
    const question = runtime?.question
    if (!busy || !question || question.dialogId !== payload.dialogId) return { ok: false, reason: 'gone' }
    if (payload.turnId !== undefined && payload.turnId !== runtime?.turnId) return { ok: false, reason: 'gone' }
    if (payload.cancelled) { act.respondQuestion(); return { ok: true } }
    const answers = stringRecord(payload.answers)
    if (!Object.keys(answers).length) return { ok: false, reason: 'empty' }
    const response = typeof payload.response === 'string' && payload.response.trim() ? payload.response : undefined
    act.respondQuestion(answers, response)
    return { ok: true }
  }
  return { ok: false, reason: 'unknown' }
}
