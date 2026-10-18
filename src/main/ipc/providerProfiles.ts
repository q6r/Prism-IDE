// Pure rules behind the provider-profile IPC (ipc/providers.ts): the login
// terminal's size, removing a profile and what happens to its chats. No
// Electron imports, so tests load this file directly.
import type { ProfileStatus, ProviderProfile, UnifiedChat } from '../../shared/agents'

export const BROKEN_LINK_STATUS = 'Conta vinculada ao Traycer indisponível: reative-a no Traycer ou desvincule.'
export const LINKED_LOGIN_REFUSAL = 'Esta conta usa o login do Traycer. Entre pelo Traycer ou desvincule para entrar no Prism.'

/**
 * The status answered without running the CLI, or null when it must be
 * probed: a disabled profile, or a Traycer link that no longer resolves
 * (never probed, since that would fall back to the profile's own old copy).
 */
export function unprobedStatus(enabled: boolean, link: 'none' | 'linked' | 'broken', installed: boolean): ProfileStatus | null {
  if (!enabled) return { installed, loggedIn: false, detail: 'Desativada' }
  if (link === 'broken') return { installed, loggedIn: false, detail: BROKEN_LINK_STATUS }
  return null
}

/** Why a Prism login cannot start on `profile`, or null. A Traycer link, live or broken, always refuses. */
export function loginRefusal(profile: ProviderProfile & { credentialLink?: unknown }, chats: readonly UnifiedChat[], loginOpen: boolean): string | null {
  if (chats.some((c) => c.selection.profileId === profile.id && c.pendingTurnId)) return 'Pare as tarefas desta conta antes de fazer login novamente.'
  if (profile.ambient) return 'Adicione uma conta para fazer login sem alterar a conta do terminal.'
  // A login here would overwrite (or fork) the account Traycer runs on.
  if (profile.credentialLink) return LINKED_LOGIN_REFUSAL
  if (loginOpen) return 'O login desta conta já está aberto.'
  return null
}

/**
 * A removal's side effects, in the order that keeps a login from surviving
 * it: the profile is tombstoned and its chats moved first (nothing new can
 * start on it), then everything still running on it is told to close and its
 * login terminal is awaited, and only then is its folder deleted.
 */
export async function runProfileRemoval<R>(steps: {
  retire: () => void
  announce: () => void
  endLogin: () => Promise<void>
  removeFolder: () => Promise<R>
}): Promise<R> {
  steps.retire()
  steps.announce()
  await steps.endLogin()
  return steps.removeFolder()
}

/** The renderer's measured terminal size; anything implausible falls back to 100×24. */
export function loginTerminalSize(size: unknown): { cols: number; rows: number } {
  const s = (size && typeof size === 'object' ? size : {}) as { cols?: unknown; rows?: unknown }
  const int = (v: unknown, min: number, max: number, fallback: number): number =>
    typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : fallback
  return { cols: int(s.cols, 20, 500, 100), rows: int(s.rows, 5, 200, 24) }
}

/** A renderer-chosen login session id, or null when it is not a safe token. */
export function loginSessionId(value: unknown): string | null {
  return typeof value === 'string' && /^[\w-]{1,64}$/.test(value) ? value : null
}

/** Why `id` cannot be removed from `stored` (with `chats`), or null when it can. */
export function profileRemovalError(stored: readonly ProviderProfile[], chats: readonly UnifiedChat[], id: unknown): string | null {
  if (typeof id !== 'string' || !id || id.startsWith('ambient-')) return 'A conta do terminal é gerenciada pelo terminal e não pode ser removida.'
  const target = stored.find((p) => p.id === id)
  if (!target || target.tombstoned) return 'Conta não encontrada.'
  if (chats.some((c) => c.selection.profileId === id && c.pendingTurnId)) return 'Pare as tarefas desta conta antes de removê-la.'
  return null
}

/** The stored profiles with `id` tombstoned (kept so old references read as removed) and disabled. */
export function tombstoneProfile<P extends ProviderProfile>(stored: readonly P[], id: string): P[] {
  return stored.map((p) => p.id === id ? { ...p, tombstoned: true, enabled: false } : p)
}

/**
 * Chats that ran on `id` move to their provider's terminal account. The route
 * changes, so the native session and last run no longer apply. Returns null
 * when no chat referenced the profile.
 */
export function moveChatsToTerminal(chats: readonly UnifiedChat[], id: string): UnifiedChat[] | null {
  if (!chats.some((c) => c.selection.profileId === id)) return null
  return chats.map((c) => c.selection.profileId === id
    ? { ...c, selection: { ...c.selection, profileId: `ambient-${c.selection.provider}` }, resume: undefined, lastRunId: undefined }
    : c)
}

/** Whether a profile id is safe to use as a folder name under provider-profiles/. */
export function isProfileFolderName(id: string): boolean {
  return /^[\w-]+$/.test(id) && id !== '.' && id !== '..'
}

/** `.trash-<id>-<timestamp>`: where a removed profile's folder waits when it cannot be deleted yet. */
export function trashFolderName(id: string, now: number): string {
  return `.trash-${id}-${Math.floor(now)}`
}

/** Whether a provider-profiles/ entry is one of our trash folders (and nothing else). */
export function isTrashFolderName(name: string): boolean {
  const match = /^\.trash-([\w-]+)-(\d+)$/.exec(name)
  return !!match && isProfileFolderName(match[1])
}

/** The file operations removal needs, injected so the order and fallbacks are testable. */
export interface ProfileFolderOps {
  join: (...parts: string[]) => string
  rm: (path: string) => Promise<void>
  rename: (from: string, to: string) => Promise<void>
}

/**
 * Deletes a removed profile's own folder (provider-profiles/<id>, never a
 * Traycer account). A folder Windows still holds open (EBUSY) or that was
 * only partly deleted is renamed into the trash, which the next boot purges,
 * so its login never stays behind under a name the UI no longer shows.
 * 'kept' means neither worked; the caller reports it.
 */
export async function removeProfileFolder(base: string, id: string, ops: ProfileFolderOps, now = Date.now()): Promise<'removed' | 'trashed' | 'kept'> {
  if (!isProfileFolderName(id)) return 'kept'
  const dir = ops.join(base, id)
  try { await ops.rm(dir); return 'removed' } catch { /* Locked or partial: move it aside below. */ }
  try { await ops.rename(dir, ops.join(base, trashFolderName(id, now))); return 'trashed' } catch { return 'kept' }
}

/**
 * Purges, among `names` (a listing of provider-profiles/), the trash folders
 * and the folders of `removedIds` (tombstoned profiles whose folder could not
 * even be moved aside); resolves to how many went. Live profiles are never listed in `removedIds`.
 */
export async function purgeProfileTrash(base: string, names: readonly string[], ops: Pick<ProfileFolderOps, 'join' | 'rm'>, removedIds: ReadonlySet<string> = new Set()): Promise<number> {
  let purged = 0
  for (const name of names) {
    if (!isTrashFolderName(name) && !(removedIds.has(name) && isProfileFolderName(name))) continue
    try { await ops.rm(ops.join(base, name)); purged++ } catch { /* Still locked: the next boot tries again. */ }
  }
  return purged
}
