// Codex manual resets in Settings ▸ Provedores (codex-reset-credit-model.ts,
// the reset-credit lines of provider-rate-limit-views.tsx and the confirmation
// and outcome copy of codex-reset-credit-action.tsx). Pure: tests load it with
// only `../usage` supplied.
import type { ProfileDetails } from '../../../../../shared/agents'
import type { CodexResetOutcome } from '../../../../../shared/providerUsage'
import { formatResetCountdown, formatResetFullDateTime, isFarReset } from '../usage'

export type ResetCredits = NonNullable<ProfileDetails['resetCredits']>
export type ResetCredit = NonNullable<ResetCredits['credits']>[number]

/** A reset expiring inside this window is tinted in the list: use it or lose it. */
export const RESET_CREDIT_WARNING_MS = 48 * 60 * 60 * 1000
const PLAUSIBLE_MS = 365 * 24 * 60 * 60 * 1000

/** The wire's epoch seconds as ms; null means the credit never expires. */
export const creditExpiresAtMs = (credit: ResetCredit): number | null => credit.expiresAt === null ? null : credit.expiresAt * 1000

function byExpiry(a: ResetCredit, b: ResetCredit): number {
  if (a.expiresAt === null && b.expiresAt === null) return 0
  if (a.expiresAt === null) return 1
  if (b.expiresAt === null) return -1
  return a.expiresAt - b.expiresAt
}

/** The listed credits: every one not yet redeemed, soonest expiry first, never-expiring last. */
export function visibleResetCredits(credits: readonly ResetCredit[]): ResetCredit[] {
  return credits.filter((c) => c.status !== 'redeemed').sort(byExpiry)
}

/** The credit a click spends: the available one expiring soonest (selectEarliestExpiringCodexResetCredit). */
export function selectResetCredit(credits: readonly ResetCredit[], now: number): ResetCredit | null {
  return credits.filter((c) => c.status === 'available' && (c.expiresAt === null || c.expiresAt * 1000 > now)).sort(byExpiry)[0] ?? null
}

/** Credits the provider counted but did not list ("+1 não exibida"); a count-only reply lists none to compare. */
export function omittedResetCount(resetCredits: ResetCredits): number {
  const credits = resetCredits.credits
  return credits !== null && credits.length > 0 ? Math.max(0, resetCredits.availableCount - credits.length) : 0
}

/** Whether "Usar redefinição" is offered: a Codex profile, enabled, with a reset to spend. */
export function canUseReset(provider: string, enabled: boolean, resetCredits: ResetCredits | undefined): boolean {
  return provider === 'codex' && enabled && !!resetCredits && resetCredits.availableCount > 0
}

export const resetCountText = (count: number): string => `${count} ${count === 1 ? 'disponível' : 'disponíveis'}`
export const omittedText = (count: number): string => `+${count} ${count === 1 ? 'não exibida' : 'não exibidas'}`

/**
 * A credit's right-hand detail: "Resgatando", "Sem validade", "Validade
 * indisponível" (an implausible timestamp), "Expirada", "Expira em 4h 7m",
 * or the full date when a day or more away. `warning` tints one inside 48h.
 */
export function resetCreditDetail(credit: ResetCredit, now: number): { text: string; warning: boolean; redeeming: boolean } {
  if (credit.status === 'redeeming') return { text: 'Resgatando', warning: false, redeeming: true }
  const expires = creditExpiresAtMs(credit)
  if (expires === null) return { text: 'Sem validade', warning: false, redeeming: false }
  if (expires < now - PLAUSIBLE_MS || expires > now + PLAUSIBLE_MS) return { text: 'Validade indisponível', warning: false, redeeming: false }
  if (expires <= now) return { text: 'Expirada', warning: false, redeeming: false }
  return { text: isFarReset(expires, now) ? `Expira ${formatResetFullDateTime(expires)}` : `Expira em ${formatResetCountdown(expires, now)}`,
    warning: expires - now <= RESET_CREDIT_WARNING_MS, redeeming: false }
}

export const RESET_CONFIRM_TITLE = 'Usar uma redefinição manual do Codex?'
export const RESET_ACTION_LABEL = 'Usar redefinição'
export const RESET_ERROR = 'Não foi possível usar a redefinição manual do Codex.'

/** The confirmation's body: which credit goes, that it cannot be undone, and how many remain. */
export function resetConfirmDescription(selected: ResetCredit | null, availableCount: number, now: number): string {
  if (selected === null) {
    return 'Isso usa uma redefinição manual no limite de uso do Codex atingido no momento. A redefinição não pode ser devolvida nem desfeita.'
  }
  const expires = creditExpiresAtMs(selected)
  const expiry = expires === null ? 'sem validade'
    : isFarReset(expires, now) ? `que expira em ${formatResetFullDateTime(expires)}` : `que expira em ${formatResetCountdown(expires, now)}`
  const remaining = Math.max(0, availableCount - 1)
  return `Isso usa a redefinição ${expiry} no limite de uso do Codex atingido no momento. Ela não pode ser devolvida nem desfeita. `
    + `Você ficará com ${remaining} ${remaining === 1 ? 'redefinição manual' : 'redefinições manuais'}.`
}

/** The toast for each consume outcome (use-consume-rate-limit-reset-credit-mutation.ts). */
export function resetOutcomeToast(outcome: CodexResetOutcome): { kind: 'success' | 'info'; message: string } {
  switch (outcome) {
    case 'reset': return { kind: 'success', message: 'Limite de uso do Codex redefinido.' }
    case 'nothingToReset': return { kind: 'info', message: 'O Codex não tem um limite de uso ativo para redefinir.' }
    case 'noCredit': return { kind: 'info', message: 'Nenhuma redefinição manual do Codex disponível.' }
    case 'alreadyRedeemed': return { kind: 'info', message: 'Essa redefinição manual do Codex já foi usada.' }
  }
}

/** An IPC rejection's own message, without Electron's "Error invoking remote method …" wrapper. */
export function ipcErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err ?? '')
  return message.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '')
}
