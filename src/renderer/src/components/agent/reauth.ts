// "Entrar novamente" on a turn whose login is gone (T08): the provider says
// so with `cli_auth`, the journal keeps it as the turn's `errorCode`, and the
// transcript offers the account's sign-in (the Settings ▸ Provedores flow).
// Pure, so tests load it without the renderer.
import type { ProviderProfile, SharedTurn, UnifiedChat } from '../../../../shared/agents'
import { signInBlockedReason, traycerLinkSignInBlock } from '../settings/usage'

/** The provider's error code for a login that is gone. */
export const LOGIN_GONE = 'cli_auth'

export function needsSignIn(turn: Pick<SharedTurn, 'errorCode'>): boolean {
  return turn.errorCode === LOGIN_GONE
}

/**
 * The account the chat runs on and why its sign-in cannot start (the same
 * guards as Settings ▸ Provedores: the terminal account, a disabled profile,
 * a Traycer link, a conversation running on it), or null when the account
 * is unknown or removed.
 */
export function reauthTarget(chat: Pick<UnifiedChat, 'selection'>, profiles: readonly ProviderProfile[], busy: boolean): { profile: ProviderProfile; blocked: string | null } | null {
  const profile = profiles.find((p) => p.id === chat.selection.profileId && p.provider === chat.selection.provider && !p.tombstoned)
  if (!profile) return null
  return { profile, blocked: traycerLinkSignInBlock(profile) ?? signInBlockedReason(profile, { loginOpen: false, busy, cliMissing: null }) }
}
