import type { AgentModel, CodexEvent, CodexSend, ProfileDetails, SteerMessage } from '../../agents'
import type { CodexResetOutcome } from '../../providerUsage'
import type { HostStatus } from '../client'

/**
 * `window.prism.codex` on the host (T05): Codex chats run by the host's
 * `codex app-server` client (`codex.*`). The host emits the same
 * `CodexEvent`s the IPC did (`codex.event`), so the renderer is unchanged.
 * Approvals and questions arrive as `codex.permission` / `codex.question`
 * with the `agent:permission` / `agent:question` payloads; the preload's
 * `claude.onAgentPermission` / `onAgentQuestion` hear those too.
 *
 * `onEvent` hears both sides, and stop and answers go to both (each side
 * ignores chats it does not run), so a turn started before the host
 * connected still finishes on IPC.
 *
 * Since T07 the host's chats engine runs the turns of the chats it owns and
 * journals them itself; this path serves a window whose chats stay on IPC
 * (a host without `chats@1`).
 */

type Unsub = () => void

/** The slice of `HostClient` this needs. */
export interface CodexHostClient {
  call<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>
  onNotification(method: string, listener: (params: unknown) => void): () => void
  onStatus(listener: (status: HostStatus) => void): () => void
}

/** The main process side of the bridge (src/main/ipc/nativeCodex.ts). */
export interface CodexBridge {
  /** `codex:profile-changed`: a login changed, so idle host processes of that profile restart. */
  onProfileChanged?(cb: (profileId: string) => void): Unsub
}

/** The IPC members the host side wraps (the `codex` block of src/preload/index.ts). */
export interface CodexIpc {
  permission(chatId: string, requestId: string, decision: string): void
  question(chatId: string, requestId: string, answers?: Record<string, string>): void
  send(payload: CodexSend): void
  abort(chatId: string): void
  steer?(payload: SteerMessage): Promise<void>
  onEvent(cb: (event: CodexEvent) => void): Unsub
}

/** A send waits for the chat's process to start. */
const SEND_MS = 60_000
/** Stop and answers: never worth a long wait. */
const CONTROL_MS = 5_000

export const CODEX_DROPPED = 'A conexão com o host do Prism caiu e a tarefa foi interrompida.'

const ended = (event: CodexEvent): boolean => event.kind === 'done' || event.kind === 'error'

export function createHostCodex<T extends CodexIpc>(client: CodexHostClient, ipc: T, bridge?: CodexBridge): Partial<T> {
  const listeners = new Set<(event: CodexEvent) => void>()
  /** Turns the host accepted and has not finished: a dropped connection ends them. */
  const running = new Set<string>()
  /** Sends waiting for the host's answer, and whether their turn already ended. */
  const sending = new Map<string, boolean>()

  const deliver = (event: CodexEvent): void => {
    if (ended(event)) {
      running.delete(event.id)
      if (sending.has(event.id)) sending.set(event.id, true)
    }
    for (const listener of [...listeners]) listener(event)
  }

  client.onNotification('codex.event', (params) => {
    const event = params as CodexEvent | null
    if (event && typeof event.id === 'string') deliver(event)
  })

  // The host ends a window's chats when its connection goes: tell the turns so they stop waiting.
  client.onStatus((status) => {
    if (status.state === 'connected') return
    for (const id of [...running]) deliver({ id, kind: 'error', message: CODEX_DROPPED })
  })

  bridge?.onProfileChanged?.((profileId) => {
    void client.call('codex.profileChanged', { profileId }, CONTROL_MS).catch(() => undefined)
  })

  const control = (method: string, params: unknown): void => {
    void client.call(method, params, CONTROL_MS).catch(() => undefined)
  }

  const host: Partial<CodexIpc> = {
    send: (payload: CodexSend): void => {
      const { chat: _chat, ...wire } = payload
      sending.set(payload.id, false)
      client.call('codex.send', wire, SEND_MS).then(() => {
        const over = sending.get(payload.id)
        sending.delete(payload.id)
        if (!over) running.add(payload.id)
      }, (err: unknown) => {
        // Refused before it began (busy chat, missing CLI, disabled account).
        sending.delete(payload.id)
        deliver({ id: payload.id, kind: 'error', message: (err as Error)?.message || String(err) })
      })
    },
    steer: async (payload: SteerMessage): Promise<void> => {
      if (running.has(payload.turnId) || sending.has(payload.turnId)) await client.call('codex.steer', payload);
      else if (ipc.steer) await ipc.steer(payload);
      else throw new Error('Envio durante o turno indisponível.');
    },
    abort: (chatId: string): void => {
      ipc.abort(chatId)
      control('codex.abort', { chatId })
    },
    permission: (chatId: string, requestId: string, decision: string): void => {
      ipc.permission(chatId, requestId, decision)
      control('codex.permission', { chatId, requestId, decision })
    },
    question: (chatId: string, requestId: string, answers?: Record<string, string>): void => {
      ipc.question(chatId, requestId, answers)
      control('codex.question', { chatId, requestId, ...(answers ? { answers } : {}) })
    },
    onEvent: (cb: (event: CodexEvent) => void): Unsub => {
      listeners.add(cb)
      const offIpc = ipc.onEvent(cb)
      return () => {
        listeners.delete(cb)
        offIpc()
      }
    }
  }
  return host as Partial<T>
}

/**
 * The host's Codex approvals and questions, for the `claude` block's
 * `onAgentPermission` / `onAgentQuestion` (the renderer hears both providers there).
 */
export function hostCodexPrompts(client: Pick<CodexHostClient, 'onNotification'>): {
  onPermission(cb: (payload: never) => void): Unsub
  onQuestion(cb: (payload: never) => void): Unsub
} {
  return {
    onPermission: (cb) => client.onNotification('codex.permission', cb as (params: unknown) => void),
    onQuestion: (cb) => client.onNotification('codex.question', cb as (params: unknown) => void)
  }
}

/**
 * The one-shot Codex reads on the host, with the signatures of today's
 * `providers.models/details/codexReset` and `agentCommands.list` for Codex.
 * T08 routes those blocks here.
 */
export function createHostCodexQueries(client: Pick<CodexHostClient, 'call'>): {
  models(profileId: string, refresh?: boolean): Promise<AgentModel[]>
  skills(profileId: string, cwd: string, refresh?: boolean): Promise<{ name: string; description: string; argumentHint: string | null; kind: 'slash-command' | 'skill'; builtin: boolean }[]>
  details(profileId: string, refresh?: boolean): Promise<ProfileDetails>
  reset(profileId: string, idempotencyKey: string, creditId: string | null): Promise<{ outcome: CodexResetOutcome }>
} {
  return {
    models: (profileId, refresh = false) => client.call('codex.models', { profileId, refresh }),
    skills: (profileId, cwd, refresh = false) => client.call('codex.skills', { profileId, cwd, refresh }),
    details: (profileId, refresh = false) => client.call('codex.details', { profileId, refresh }),
    // Spends one real Codex manual reset; the key is per confirmed attempt, so a retry never spends twice.
    reset: (profileId, idempotencyKey, creditId) => client.call('codex.reset', { profileId, idempotencyKey, creditId }, SEND_MS)
  }
}
