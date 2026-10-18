import type { AgentModel, LoginEvent, Provider, ProfileDetails, ProfileStatus, ProviderProfile } from '../../agents'
import type { CodexResetOutcome } from '../../providerUsage'
import type { AgentCommand } from '../generated/AgentCommand'
import type { CliAvailability } from '../generated/CliAvailability'
import type { CodexResetResult } from '../generated/CodexResetResult'
import type { LoginStarted } from '../generated/LoginStarted'
import type { ProfilesList } from '../generated/ProfilesList'

/**
 * `window.prism.providers` and `window.prism.agentCommands` on the host (T08):
 * the accounts, their logins (a terminal on the host), limits, model catalogs
 * and `/` commands, with the signatures and answers of the IPC side, so the
 * renderer is unchanged.
 *
 * Errors: what rejects today still rejects, with the host's pt-BR message (an
 * Error crossing the context bridge keeps only its message, and the renderer
 * shows it as is). The login's input, resize and cancel return nothing, as on
 * IPC: a refusal there is dropped. `traycerLinks`, `linkTraycer` and
 * `unlinkTraycer` stay on IPC (the Traycer folders are the desktop's).
 *
 * `onLogin` and `onChanged` hear both sides: a login started over IPC (before
 * the host connected) still reports there.
 */

type Unsub = () => void

/** The slice of `HostClient` this needs. */
export interface ProvidersHostClient {
  call<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>
  onNotification(method: string, listener: (params: unknown) => void): () => void
}

export type LoginOptions = { session?: string; cols?: number; rows?: number }
export type ProfilePatch = { name?: string; enabled?: boolean; color?: string }

/** The IPC members the host side wraps (the `providers` block of src/preload/index.ts). */
export interface ProvidersIpc {
  onLogin(cb: (event: LoginEvent & { session?: string }) => void): Unsub
  onChanged(cb: (profiles: ProviderProfile[]) => void): Unsub
}

/** The members served by the host. */
export interface HostProvidersApi {
  details(provider: Provider, profileId: string, refresh?: boolean): Promise<ProfileDetails>
  codexReset(profileId: string, idempotencyKey: string, creditId: string | null): Promise<{ outcome: CodexResetOutcome }>
  models(provider: Provider, profileId: string, refresh?: boolean): Promise<AgentModel[]>
  update(id: string, patch: ProfilePatch): Promise<ProviderProfile[]>
  list(): Promise<ProviderProfile[]>
  create(provider: Provider, name: string): Promise<ProviderProfile>
  rename(id: string, name: string): Promise<ProviderProfile[]>
  status(provider: Provider, id: string): Promise<ProfileStatus>
  login(provider: Provider, id: string, options?: LoginOptions): Promise<string>
  loginInput(id: string, text: string): void
  loginResize(id: string, size: { cols: number; rows: number }): void
  loginCancel(id: string, session?: string): void
  onLogin(cb: (event: LoginEvent & { session?: string }) => void): Unsub
  remove(id: string): Promise<ProviderProfile[]>
  available(provider: Provider): Promise<CliAvailability>
  onChanged(cb: (profiles: ProviderProfile[]) => void): Unsub
}

/** Limits, catalogs and statuses may start the provider's CLI first. */
const QUERY_MS = 60_000
/** A removal waits for the profile's processes and login to end before deleting its folder. */
const REMOVE_MS = 60_000
/** Spending a reset waits for the provider's answer. */
const RESET_MS = 60_000
/** Login keystrokes and cancels: never worth a long wait. */
const CONTROL_MS = 5_000

export function createHostProviders<T extends ProvidersIpc>(client: ProvidersHostClient, ipc: T): HostProvidersApi {
  const call = <R>(method: string, params: unknown, timeoutMs?: number): Promise<R> => client.call<R>(`providers.${method}`, params, timeoutMs)
  const profiles = async (method: string, params: unknown, timeoutMs?: number): Promise<ProviderProfile[]> =>
    (await call<ProfilesList>(method, params, timeoutMs)).profiles
  const control = (method: string, params: unknown): void => {
    void call(method, params, CONTROL_MS).catch(() => undefined)
  }

  return {
    details: (provider, profileId, refresh = false) => call<ProfileDetails>('details', { provider, profileId, refresh }, QUERY_MS),
    // Spends one real Codex manual reset; the key is per confirmed attempt, so a retry never spends twice.
    codexReset: async (profileId, idempotencyKey, creditId) => {
      const { outcome } = await call<CodexResetResult>('codexReset', { profileId, idempotencyKey, creditId }, RESET_MS)
      return { outcome }
    },
    models: (provider, profileId, refresh = false) => call<AgentModel[]>('models', { provider, profileId, refresh }, QUERY_MS),
    update: (id, patch) => profiles('update', { ...patch, id }),
    list: () => profiles('list', {}),
    create: (provider, name) => call<ProviderProfile>('create', { provider, name }),
    rename: (id, name) => profiles('rename', { id, name }),
    status: (provider, id) => call<ProfileStatus>('status', { provider, id }, QUERY_MS),
    login: async (provider, id, options) => {
      const params: Record<string, unknown> = { provider, id }
      if (typeof options?.session === 'string') params.session = options.session
      if (typeof options?.cols === 'number') params.cols = options.cols
      if (typeof options?.rows === 'number') params.rows = options.rows
      return (await call<LoginStarted>('login', params)).session
    },
    loginInput: (id, text) => control('loginInput', { id, text }),
    loginResize: (id, size) => control('loginResize', { id, cols: size.cols, rows: size.rows }),
    loginCancel: (id, session) => control('loginCancel', session ? { id, session } : { id }),
    onLogin: (cb) => {
      const offHost = client.onNotification('providers.login', (params) => {
        const event = params as (LoginEvent & { session?: string }) | null
        if (event && typeof event.profileId === 'string') cb(event)
      })
      const offIpc = ipc.onLogin(cb)
      return () => { offHost(); offIpc() }
    },
    remove: (id) => profiles('remove', { id }, REMOVE_MS),
    available: (provider) => call<CliAvailability>('available', { provider }, QUERY_MS),
    onChanged: (cb) => {
      const offHost = client.onNotification('providers.changed', (params) => {
        const list = (params as ProfilesList | null)?.profiles
        if (Array.isArray(list)) cb(list)
      })
      const offIpc = ipc.onChanged(cb)
      return () => { offHost(); offIpc() }
    }
  }
}

/** `window.prism.agentCommands` on the host: the provider's own `/` catalog, cached 5 min per account and folder. */
export function createHostAgentCommands(client: Pick<ProvidersHostClient, 'call'>): {
  list(provider: Provider, profileId: string, cwd: string, refresh?: boolean): Promise<AgentCommand[]>
} {
  return {
    list: (provider, profileId, cwd, refresh = false) => client.call<AgentCommand[]>('providers.commands', { provider, profileId, cwd, refresh }, QUERY_MS)
  }
}
