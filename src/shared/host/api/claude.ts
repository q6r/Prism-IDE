import type { SteerMessage } from '../../agents'
import type { HostStatus } from '../client'

/**
 * `window.prism.claude` on the host (T06): Claude chats run by the host's own
 * Claude Code client (`claude.*`, the CLI's native protocol). The host sends
 * the same `agent:*` events the IPC did, as `claude.event` notifications, so
 * the renderer is unchanged. Subscriptions hear both sides, because SSH chats
 * (the old remote mode) stay on IPC until T10; stop and answers go to both
 * (each side ignores turns it does not run).
 *
 * Since T07 the host's chats engine runs the turns of the chats it owns and
 * journals them itself; this path serves a window whose chats stay on IPC
 * (a host without `chats@1`).
 */

type Unsub = () => void
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Listener = (data: any) => void

/** The `agent:*` channel behind each subscription member. */
export const CLAUDE_EVENT_CHANNELS = {
  onAgentTurnStart: 'agent:turn-start',
  onAgentSystem: 'agent:system',
  onAgentText: 'agent:text',
  onAgentThinking: 'agent:thinking',
  onAgentTool: 'agent:tool',
  onAgentToolResult: 'agent:tool-result',
  onAgentSubagent: 'agent:subagent',
  onAgentPermission: 'agent:permission',
  onAgentQuestion: 'agent:question',
  onAgentResult: 'agent:result',
  onAgentContext: 'agent:context',
  onAgentDone: 'agent:done',
  onAgentError: 'agent:error'
} as const

export type ClaudeEventMember = keyof typeof CLAUDE_EVENT_CHANNELS
export const CLAUDE_EVENT_MEMBERS = Object.keys(CLAUDE_EVENT_CHANNELS) as ClaudeEventMember[]

/** The slice of `HostClient` this needs. */
export interface ClaudeHostClient {
  call<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>
  onNotification(method: string, listener: (params: unknown) => void): () => void
  onStatus(listener: (status: HostStatus) => void): () => void
}

/** The IPC members the host side wraps (the `claude` block of src/preload/index.ts). */
export interface ClaudeIpc {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  agentSend(payload: any): void
  agentAbort(id: string): void
  agentInterrupt(chatId: string): void
  agentEnd(chatId: string): void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  agentRespondPermission(payload: any): void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  agentRespondQuestion(payload: any): void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onAgentTurnStart(cb: (d: any) => void): Unsub
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [member: string]: any
}

/** A send may wait for the previous process of the chat to close (a route change). */
const SEND_MS = 60_000
/** Stop and answers: never worth a long wait. */
const CONTROL_MS = 5_000
/** Rewind replays the session's file history. */
const REWIND_MS = 120_000

const DROPPED = 'A conexão com o host do Prism caiu e a tarefa foi interrompida.'

/**
 * `profileChanges`: the main process's "this account signed in again" (until
 * the host owns the accounts, T08); the host then drops that account's idle
 * processes and its "always allow" choices, like claudeAgent.ts does.
 */
export function createHostClaude<T extends ClaudeIpc>(client: ClaudeHostClient, ipc: T, profileChanges?: (listener: (profileId: string) => void) => void): Partial<T> {
  const listeners = new Map<string, Set<Listener>>()
  /** Turns the host accepted and has not finished: a dropped connection ends them. */
  const running = new Set<string>()
  /** Sends waiting for the host's answer, and whether their turn already ended. */
  const sending = new Map<string, boolean>()

  const deliver = (channel: string, data: unknown): void => {
    const id = (data as { id?: unknown } | null)?.id
    if (typeof id === 'string' && (channel === 'agent:done' || channel === 'agent:error')) {
      running.delete(id)
      if (sending.has(id)) sending.set(id, true)
    }
    for (const listener of [...(listeners.get(channel) ?? [])]) listener(data)
  }

  client.onNotification('claude.event', (params) => {
    const { channel, data } = (params ?? {}) as { channel?: unknown; data?: unknown }
    if (typeof channel === 'string') deliver(channel, data)
  })

  // The host ends a window's chats when its connection goes: tell the turns so they stop waiting.
  client.onStatus((status) => {
    if (status.state === 'connected') return
    for (const id of [...running]) deliver('agent:error', { id, message: DROPPED })
  })

  const control = (method: string, params: unknown): void => {
    void client.call(method, params, CONTROL_MS).catch(() => undefined)
  }

  profileChanges?.((profileId) => {
    if (typeof profileId === 'string' && profileId) control('claude.profileChanged', { profileId })
  })

  const host: Record<string, unknown> = {
    agentAvailable: () => client.call('claude.available'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    agentSend: (payload: any): void => {
      if (payload?.remote) return ipc.agentSend(payload)
      const id = payload.id as string
      sending.set(id, false)
      client.call<{ started?: boolean }>('claude.send', payload, SEND_MS).then((reply) => {
        const ended = sending.get(id)
        sending.delete(id)
        // Refused before it began (busy chat, disabled account) or already over.
        if (reply?.started && !ended) running.add(id)
      }, (err: unknown) => {
        sending.delete(id)
        deliver('agent:error', { id, message: `O host do Prism não executou a mensagem: ${(err as Error)?.message || String(err)}` })
      })
    },
    agentSteer: async (payload: SteerMessage): Promise<void> => {
      if (running.has(payload.turnId) || sending.has(payload.turnId)) await client.call('claude.steer', payload);
      else await ipc.agentSteer(payload);
    },
    agentAbort: (id: string): void => {
      ipc.agentAbort(id)
      control('claude.abort', { id })
    },
    agentInterrupt: (chatId: string): void => {
      ipc.agentInterrupt(chatId)
      control('claude.interrupt', { chatId })
    },
    agentEnd: (chatId: string): void => {
      ipc.agentEnd(chatId)
      control('claude.end', { chatId })
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    agentRespondPermission: (payload: any): void => {
      ipc.agentRespondPermission(payload)
      control('claude.permissionResponse', payload)
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    agentRespondQuestion: (payload: any): void => {
      ipc.agentRespondQuestion(payload)
      control('claude.questionResponse', payload)
    },
    agentCheckpointIds: (sessionId: string) => client.call('claude.checkpointIds', { sessionId }),
    agentFork: (p: { sessionId: string; upToMessageId: string }) => client.call('claude.fork', p),
    agentRewind: (p: { sessionId: string; userMessageId: string; cwd?: string; dryRun?: boolean }) => client.call('claude.rewind', p, REWIND_MS)
  }

  for (const member of CLAUDE_EVENT_MEMBERS) {
    const channel = CLAUDE_EVENT_CHANNELS[member]
    host[member] = (cb: Listener): Unsub => {
      let set = listeners.get(channel)
      if (!set) listeners.set(channel, (set = new Set()))
      set.add(cb)
      const offIpc = typeof ipc[member] === 'function' ? (ipc[member] as (cb: Listener) => Unsub)(cb) : undefined
      return () => {
        set!.delete(cb)
        offIpc?.()
      }
    }
  }
  return host as Partial<T>
}

/**
 * `git:aiCommitMessage` on the host (the git domain's IPC member stays the
 * fallback for SSH roots and a host without `claude@1`).
 */
export function hostCommitMessage(
  client: Pick<ClaudeHostClient, 'call'> & { serves?(domain: string): boolean },
  ipc: (root: string, remoteId?: string) => Promise<{ ok: boolean; message?: string; error?: string }>
): (root: string, remoteId?: string) => Promise<{ ok: boolean; message?: string; error?: string }> {
  return (root, remoteId) => remoteId || (client.serves && !client.serves('claude')) ? ipc(root, remoteId) : client.call('claude.commitMessage', { root }, SEND_MS)
}
