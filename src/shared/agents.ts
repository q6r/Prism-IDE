export type Provider = 'claude' | 'codex'

export interface ProviderProfile {
  id: string
  provider: Provider
  name: string
  ambient?: boolean
  enabled?: boolean
  color?: string
  tombstoned?: boolean
  /** Runs on a Traycer account's login ('linked'), or that link no longer resolves ('broken'). Set by main's publicProfiles; absent = Prism's own login. */
  traycerLink?: 'linked' | 'broken'
}

export interface ProfileStatus {
  installed: boolean
  loggedIn: boolean
  detail: string
  email?: string
  tier?: string
}

export interface ProfileDetails {
  email?: string
  tier?: string
  /** `name` scopes a window (e.g. "Opus", a Codex bucket); null for the account-wide ones. */
  limits: { id?: string; label?: string; name?: string | null; usedPercent: number; resetsAt?: number; windowMinutes?: number }[]
  updatedAt?: number
  stale?: boolean
  error?: string
  unavailable?: string
  extras?: { label: string; value: string }[]
  /** The subscription's display name, Traycer's identity tier ("Assinatura Claude Max 20x"); `tier` stays the raw token. */
  plan?: string
  /** Codex manual resets (`rateLimitResetCredits`); `credits` is null on a count-only reply. Times in epoch seconds, like `limits[].resetsAt`. */
  resetCredits?: {
    availableCount: number
    credits: { id: string; status: 'available' | 'redeeming' | 'redeemed' | 'unknown'; grantedAt: number; expiresAt: number | null; title: string | null; description: string | null }[] | null
  }
}

/**
 * One turn's own usage as the runtime measured it, never a session total.
 * `inputTokens` excludes cache reads and writes; `reasoningTokens` is part
 * of `outputTokens`. An absent field was not measurable for this turn.
 */
export interface TurnUsage {
  inputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  costUsd?: number
}

export interface RunMetrics {
  scope: 'session'
  inputTokens?: number
  outputTokens?: number
  cachedTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  totalTokens?: number
  contextWindow?: number
  /** Occupied tokens from the provider's last model call, not session totals. */
  contextTokens?: number
  costUsd?: number
  turn?: TurnUsage
  /** The model the provider reported running (an alias like "opus" resolved). */
  model?: string
}

export interface AgentSelection {
  provider: Provider
  profileId: string
  model: string
  /** Catalog order; 'ultra' exists only on Codex models that report it. */
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'
  permissionMode: 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions'
  /** Upgrade speed tier ("Fast"): Claude 'fast', Codex e.g. 'priority'. Absent/'' = provider default. */
  serviceTier?: string
}

/** An image a user attached to a message (Traycer-style image messages). */
export interface ChatImage {
  /** Stable, one-based reference inside this chat, e.g. `#image 1`. */
  number?: number
  /** Media type, e.g. 'image/png', 'image/jpeg'. */
  mime: string
  /** Base64 of the image bytes (no `data:` prefix). */
  data: string
  /** Original file name, when known. */
  name?: string
}

/** A message waiting in a chat's send queue (typed while the agent was busy). */
export interface QueuedMessage {
  id?: string
  text: string
  context?: string
  images?: ChatImage[]
}

export type SubagentStatus = 'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'stopped'

/** Native child events remain addressed to the turn which created the child. */
export interface SubagentUpdate {
  id: string
  /** Transport address can change when a persisted native inbox is resumed. */
  controlId?: string
  controlTurnId?: string
  nativeTurnId?: string
  /** Native inbox address, when distinct from the activity-card identity. */
  messageTarget?: string
  permission?: Record<string, unknown> | null
  question?: Record<string, unknown> | null
  parentId?: string
  spawnToolCallId?: string
  name?: string
  description?: string
  model?: string
  status?: SubagentStatus
  /** Appended deltas. Whole provider item snapshots use `segment`. */
  text?: string
  thinking?: string
  segment?: SharedSegment
  summary?: string
}

export interface SubagentInfo {
  id: string
  messageTarget?: string
  chatId: string
  name: string
  description?: string
  model?: string
  spawnToolCallId?: string
  status: SubagentStatus
  startedAt: number
  updatedAt: number
  activity?: string
  summary?: string
}

export interface NativeAgentInfo {
  id: string
  controlId?: string
  controlTurnId?: string
  parentTurnId?: string
  turnId?: string
  generation?: number
  nativeTurns?: Record<string, string>
  messageTarget?: string
  rootChatId: string
  rootTurnId: string
  parentId?: string
  status: SubagentStatus
  name?: string
  description?: string
  summary?: string
  updatedAt: number
}

export interface SharedSegment {
  kind: 'text' | 'thinking' | 'tool' | 'user'
  subagent?: SubagentInfo
  /** Native non-blocking user questions; reply as a message, not an approval RPC. */
  questions?: { title: string; options?: string[] }[]
  images?: ChatImage[]
  sentAt?: number
  text?: string
  toolId?: string
  name?: string
  input?: unknown
  result?: string
  resultIsError?: boolean
  status?: 'running' | 'done' | 'error' | 'denied' | 'awaiting'
}

export interface SharedTurn {
  id: string
  role: 'user' | 'assistant'
  text: string
  /** Images the user attached to this turn (shown in the bubble, sent to the provider). */
  images?: ChatImage[]
  segments?: SharedSegment[]
  provider?: Provider
  /** The route which created this turn, retained for late native child events. */
  selection?: AgentSelection
  profileName?: string
  error?: boolean
  /** Why the turn failed, when the provider said: `cli_auth` (the login is gone) offers "Entrar novamente". */
  errorCode?: string
  interrupted?: boolean
  startedAt?: number
  completedAt?: number
  durationMs?: number
  model?: string
  metrics?: RunMetrics
}

export interface UnifiedChat {
  id: string
  title: string
  taskId?: string
  readOnly?: boolean
  sourceHarness?: string
  parentChatId?: string
    /** Projection of a native child; messages use its provider session, without an independent runner. */
  nativeAgent?: NativeAgentInfo
  archived?: boolean
  // `syncedTurns`: how many turns the last import/refresh brought from Traycer.
  // Lets "Atualizar do Traycer" tell a chat still untouched in Prism (its turn
  // count still matches) from one the user continued here (more turns).
  traycerSource?: { root: string; epicId: string; chatId: string; syncedTurns?: number }
  draft?: string
  contextDraft?: string
  // Device-local send queue (host mode): messages typed while the agent was
  // busy; sent in order as each turn finishes. Kept off the host document, like
  // the drafts, so it never leaves the device.
  queued?: QueuedMessage[]
  queuePaused?: boolean
  cwd: string
  remoteId?: string
  remoteTarget?: { host: string; port: number; username: string }
  selection: AgentSelection
  turns: SharedTurn[]
  // Resume only the immediately preceding route. Switching route starts a
  // native session with the common transcript, so no provider sees stale state.
  resume?: { route: string; sessionId: string }
  pendingTurnId?: string
  lastRunId?: string
  workspaceNeedsBinding?: boolean
  accountNeedsSelection?: boolean
  /** epoch ms; absent on chats created before it was recorded. */
  createdAt?: number
  updatedAt: number
}

export interface AgentTask {
  id: string
  activeChatId?: string
  title: string
  cwd: string
  color?: string
  pinned?: boolean
  updatedAt: number
  editor?: Record<string, unknown>
}

export interface AgentModel {
  id: string
  label: string
  description: string
  provider: Provider
  efforts: AgentSelection['effort'][]
  defaultEffort?: AgentSelection['effort']
  default?: boolean
  contextWindow?: number
  /** The model's upgrade speed tier, when it has one (Traycer's Fast toggle). */
  fast?: { id: string; label: string } | null
}

/** The tier a send should carry: the selection's, only when the model honours it. */
export function effectiveServiceTier(selection: AgentSelection, model?: AgentModel | null): string | undefined {
  if (!selection.serviceTier) return undefined
  if (model === undefined) return selection.serviceTier
  return model?.fast?.id === selection.serviceTier ? selection.serviceTier : undefined
}

export const routeKey = (s: AgentSelection): string => `${s.provider}:${s.profileId}`

export function sameRemoteTarget(a: UnifiedChat['remoteTarget'], b: UnifiedChat['remoteTarget']): boolean {
  return !!a && !!b && a.host.toLowerCase() === b.host.toLowerCase() && a.port === b.port && a.username === b.username
}

function turnBlock(t: SharedTurn): string {
  const text = t.segments?.length
    ? t.segments.map((s) => s.kind === 'text' ? s.text || '' : s.kind === 'user' ? `Usuário: ${s.text || ''}` : s.kind === 'tool'
      ? `[Ferramenta ${s.name}: ${JSON.stringify(s.input)}]\n${s.result || ''}` : '').filter(Boolean).join('\n')
    : t.text
  return `${t.role === 'user' ? 'Usuário' : t.provider || 'Assistente'}: ${text}${t.error || t.interrupted ? '\n[Esta execução terminou com erro ou foi interrompida; as ferramentas acima podem já ter sido executadas.]' : ''}`
}

export function transcriptText(turns: SharedTurn[]): string {
  return turns.map(turnBlock).join('\n\n')
}

// A route that cannot resume carries the visible history in the prompt. A long
// import (tens of thousands of turns) would blow the model's context and the
// Codex 1 MB submission cap, so only the most recent turns within this budget
// are carried, with a marker. The native-session resume (when available) is the
// path to the full history; this is the fallback. ~50k tokens.
const HISTORY_BUDGET = 200_000
export const HISTORY_OMITTED = '[Parte mais antiga desta conversa foi omitida por limite de tamanho; os arquivos estão no disco.]'

/** The most recent turns whose text fits `budget`, with a marker when older ones were dropped. */
export function boundedTranscript(turns: SharedTurn[], budget = HISTORY_BUDGET): string {
  const blocks = turns.map(turnBlock)
  let total = 0
  let start = blocks.length
  for (let i = blocks.length - 1; i >= 0; i--) {
    const add = blocks[i].length + (start < blocks.length ? 2 : 0)
    if (start < blocks.length && total + add > budget) break
    total += add
    start = i
  }
  let dropped = start > 0
  let body = blocks.slice(start).join('\n\n')
  // One recent turn can still be larger than the budget (a huge tool result): keep its tail.
  if (body.length > budget) { body = body.slice(body.length - budget); dropped = true }
  return dropped && body ? `${HISTORY_OMITTED}\n\n${body}` : body
}

export function continuationPrompt(chat: UnifiedChat, prompt: string): { prompt: string; resume?: string } {
  if (chat.resume?.route === routeKey(chat.selection)) return { prompt, resume: chat.resume.sessionId }
  const history = boundedTranscript(chat.turns)
  return { prompt: history
    ? `Continue esta conversa usando o histórico abaixo como contexto. As ferramentas anteriores já foram executadas; não repita ações só porque aparecem no histórico.\n\n<historico>\n${history}\n</historico>\n\nNova mensagem do usuário:\n${prompt}`
    : prompt }
}

/** A follow-up addressed to the exact running turn; never silently starts another turn. */
export interface SteerMessage {
  messageId?: string
  chatId: string
  turnId: string
  text: string
  context?: string
  images?: ChatImage[]
}

/** A message to one existing native child; never creates a separate agent. */
export interface SubagentMessage {
  rootChatId: string
  rootTurnId: string
  agentId: string
  text: string
}

export interface SubagentMessageResult {
  delivery: 'direct' | 'parent'
  nativeTurnId?: string
  steered?: boolean
}

export interface CodexSend {
  id: string
  chatId: string
  prompt: string
  cwd: string
  resume?: string
  selection: AgentSelection
  chat?: UnifiedChat
  /** Images attached to this message (sent to Codex as local-image inputs). */
  images?: ChatImage[]
}

export type CodexEvent =
  | { id: string; kind: 'session'; sessionId: string }
  | { id: string; kind: 'metrics'; metrics: RunMetrics }
  | { id: string; kind: 'segment'; segment: SharedSegment }
  | { id: string; kind: 'subagent'; agent: SubagentUpdate }
  | { id: string; kind: 'done'; aborted?: boolean }
  | { id: string; kind: 'error'; message: string }

export interface LoginEvent {
  profileId: string
  kind: 'data' | 'exit'
  text?: string
  code?: number
}
