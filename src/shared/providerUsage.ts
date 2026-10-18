import type { ProfileDetails, RunMetrics, TurnUsage } from './agents'

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const reset = (v: unknown): number | undefined => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) / 1000 : undefined
const windowLabel = (minutes?: number): string => minutes === 10080 ? '7 dias' : minutes ? `${minutes / 60}h` : 'Janela da conta'

// The windows Traycer reads from the native usage response. Other keys are
// provider codenames (credit grants, promotions, per-surface splits), not limits.
const claudeWindows: [id: string, label: string, name: string | null, minutes: number][] = [
  ['five_hour', 'Sessão · 5h', null, 300], ['seven_day', 'Todos os modelos · 7 dias', null, 10080],
  ['seven_day_opus', 'Opus · 7 dias', 'Opus', 10080], ['seven_day_sonnet', 'Sonnet · 7 dias', 'Sonnet', 10080]]

/* ---------------- Plan names (Traycer host: claudeSubscriptionLabel, codex planType label) ---------------- */

const squash = (v: string): string => v.toLowerCase().replace(/[\s_-]+/g, '')
const titleCase = (v: string): string => v.split(/[\s_-]+/g).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')

/** "max" → "Max", "claude_max_20x"-style tiers → "Max 20x"; unknown tokens are title-cased. */
function claudePlanName(raw: string): string {
  switch (squash(raw)) {
    case 'claudemaxsubscription': case 'claudemax': case 'max': case 'maxplan': return 'Max'
    case 'claudemax5xsubscription': case 'max5': return 'Max 5x'
    case 'claudemax20xsubscription': case 'max20': return 'Max 20x'
    case 'claudeenterprisesubscription': case 'enterprise': return 'Enterprise'
    case 'claudeteamsubscription': case 'team': return 'Team'
    case 'claudeprosubscription': case 'claudepro': case 'pro': return 'Pro'
    case 'claudefreesubscription': case 'free': return 'Free'
    default: return titleCase(raw)
  }
}

/**
 * Traycer's Claude identity tier ("Claude Max Subscription") in Prism's words.
 * The OAuth login's `rateLimitTier` ("default_claude_max_20x") says which Max
 * it is, which neither the usage reply nor `claude auth status` reports.
 */
export function claudePlanLabel(subscriptionType?: string | null, rateLimitTier?: string | null): string | undefined {
  if (!subscriptionType?.trim()) return undefined
  let name = claudePlanName(subscriptionType.trim())
  if (name === 'Max' && rateLimitTier) name = /max_?20x/i.test(rateLimitTier) ? 'Max 20x' : /max_?5x/i.test(rateLimitTier) ? 'Max 5x' : name
  const product = name.replace(/\s*subscription$/i, '')
  return `Assinatura ${squash(product).startsWith('claude') ? product : `Claude ${product}`}`
}

/** Traycer's Codex identity tier ("ChatGPT Plus Subscription") from `account.planType`. */
export function codexPlanLabel(planType?: string | null): string | undefined {
  if (!planType?.trim()) return undefined
  const names: Record<string, string> = { free: 'Free', go: 'Go', plus: 'Plus', pro: 'Pro 20x', prolite: 'Pro 5x', team: 'Team',
    self_serve_business_usage_based: 'Business', business: 'Business', enterprise_cbp_usage_based: 'Enterprise', enterprise: 'Enterprise', edu: 'Edu' }
  if (planType === 'unknown') return 'Assinatura ChatGPT'
  return `Assinatura ChatGPT ${names[planType] ?? titleCase(planType)}`
}

/** The display name for a raw tier token, for a reading that carries no `plan` yet (a login status). */
export function planLabel(provider: 'claude' | 'codex', tier?: string | null): string | undefined {
  return provider === 'claude' ? claudePlanLabel(tier) : codexPlanLabel(tier)
}

/* ---------------- Codex manual resets (Traycer host: rateLimitResetCredits parser) ---------------- */

type ResetCredits = NonNullable<ProfileDetails['resetCredits']>
type ResetCredit = NonNullable<ResetCredits['credits']>[number]
const text = (v: unknown): string | null => typeof v === 'string' && v ? v : null

function resetCredit(raw: any): ResetCredit | null {
  if (!raw || typeof raw !== 'object') return null
  const id = text(raw.id), expires = raw.expiresAt
  // A credit without an id or a grant time, or with a garbled expiry, is dropped, never guessed.
  if (id === null || !finite(raw.grantedAt) || (expires != null && !finite(expires))) return null
  const status = raw.status === 'available' || raw.status === 'redeeming' || raw.status === 'redeemed' ? raw.status : 'unknown'
  return { id, status, grantedAt: raw.grantedAt, expiresAt: expires == null ? null : expires, title: text(raw.title), description: text(raw.description) }
}

export function codexResetCredits(raw: any): ResetCredits | undefined {
  if (!raw || typeof raw !== 'object' || !finite(raw.availableCount) || raw.availableCount < 0) return undefined
  return { availableCount: Math.floor(raw.availableCount),
    credits: Array.isArray(raw.credits) ? raw.credits.flatMap((c: unknown) => { const credit = resetCredit(c); return credit ? [credit] : [] }) : null }
}

export const CODEX_RESET_OUTCOMES = ['reset', 'nothingToReset', 'noCredit', 'alreadyRedeemed'] as const
export type CodexResetOutcome = typeof CODEX_RESET_OUTCOMES[number]

/** `account/rateLimitResetCredit/consume`'s answer; anything else is an error, as in Traycer. */
export function codexResetOutcome(raw: any): CodexResetOutcome {
  const outcome = raw && typeof raw === 'object' ? raw.outcome : undefined
  if (!(CODEX_RESET_OUTCOMES as readonly unknown[]).includes(outcome)) throw new Error('O Codex retornou um resultado desconhecido para a redefinição manual.')
  return outcome as CodexResetOutcome
}

export function claudeDetails(data: any, account: { email?: string; subscriptionType?: string; rateLimitTier?: string } = {}): ProfileDetails {
  const limits: ProfileDetails['limits'] = [], r = data.rate_limits
  if (data.rate_limits_available && r) {
    for (const [id, label, name, windowMinutes] of claudeWindows) {
      const w = r[id]
      if (w && finite(w.utilization)) limits.push({ id, label, name, usedPercent: w.utilization, resetsAt: reset(w.resets_at), windowMinutes })
    }
    for (const [i, w] of (r.model_scoped || []).entries()) if (finite(w.utilization)) limits.push({ id: `model:${i}`, label: `${w.display_name} · 7 dias`, name: w.display_name || null, usedPercent: w.utilization, resetsAt: reset(w.resets_at), windowMinutes: 10080 })
  }
  const extras: ProfileDetails['extras'] = []
  const extra = r?.extra_usage
  if (extra) {
    extras.push({ label: 'Uso extra', value: extra.is_enabled ? 'Ativado' : 'Desativado' })
    // Native protocol amounts retain their original units; do not assume dollars.
    if (finite(extra.monthly_limit)) extras.push({ label: 'Limite mensal de créditos', value: `${extra.monthly_limit}${extra.currency ? ` ${extra.currency}` : ''}` })
    if (finite(extra.used_credits)) extras.push({ label: 'Créditos utilizados', value: String(extra.used_credits) })
    if (finite(extra.utilization)) extras.push({ label: 'Uso extra utilizado', value: `${extra.utilization}%` })
  }
  return { email: account.email || undefined, tier: data.subscription_type || undefined,
    plan: claudePlanLabel(data.subscription_type || account.subscriptionType, account.rateLimitTier), limits, extras, updatedAt: Date.now(),
    unavailable: !data.rate_limits_available
      ? data.subscription_type ? 'Limites da assinatura indisponíveis nesta sessão (API, provedor externo ou login sem acesso ao uso).'
        : 'Esta conta está sem login de assinatura ativo. Entre novamente para ver os limites.'
      : !r ? 'O provedor não retornou o uso desta conta agora. Atualize novamente em instantes.'
      : !limits.length ? 'O provedor não informou janelas de uso para esta conta.' : undefined }
}

/** A Codex `rateLimitReachedType` in the account's words; unknown codes still read as "limit reached". */
export function limitReachedLabel(type: string): string {
  if (/workspace_member/.test(type)) return 'Limite de uso atingido (membro do workspace)'
  if (/workspace/.test(type)) return 'Limite de uso atingido (workspace)'
  if (/credit/.test(type)) return 'Limite de uso atingido (créditos esgotados)'
  return 'Limite de uso atingido'
}

export function codexDetails(account: any, data: any): ProfileDetails {
  const limits: ProfileDetails['limits'] = [], extras: NonNullable<ProfileDetails['extras']> = []
  const buckets = Object.entries(data.rateLimitsByLimitId || {}) as [string, any][]
  const main = data.rateLimits
  if (main && !buckets.some(([id, b]) => id === (main.limitId || 'codex') || b.limitId && b.limitId === main.limitId)) buckets.unshift([main.limitId || 'codex', main])
  const mainId = main?.limitId || 'codex'
  // The account-wide bucket leads, as Traycer lists it; extra buckets follow in order.
  const lead = buckets.findIndex(([id, b]) => id === mainId || (b.limitId && b.limitId === main?.limitId))
  if (lead > 0) buckets.unshift(...buckets.splice(lead, 1))
  for (const [id, b] of buckets) {
    const name = b.limitName || id
    // The account-wide bucket reads as plain "Weekly" in Traycer; extra buckets keep their name.
    const scope = id === mainId || (b.limitId && b.limitId === main?.limitId) ? (b.limitName || null) : name
    for (const key of ['primary', 'secondary']) {
      const w = b[key]
      if (w && finite(w.usedPercent)) limits.push({ id: `${id}:${key}`, label: `${name} · ${windowLabel(w.windowDurationMins)}`, name: scope, usedPercent: w.usedPercent, resetsAt: finite(w.resetsAt) ? w.resetsAt : undefined, windowMinutes: w.windowDurationMins || undefined })
    }
    if (b.credits) extras.push({ label: `${name} · créditos`, value: b.credits.unlimited ? 'Ilimitados' : b.credits.balance != null ? String(b.credits.balance) : b.credits.hasCredits ? 'Disponíveis' : 'Sem créditos' })
    if (b.individualLimit) {
      extras.push({ label: `${name} · limite individual`, value: `${b.individualLimit.used} / ${b.individualLimit.limit} · ${b.individualLimit.remainingPercent}% disponível${b.individualLimit.resetsAt ? ` · renova ${new Date(b.individualLimit.resetsAt * 1000).toLocaleString('pt-BR')}` : ''}` })
    }
    // Traycer shows this as a "Usage limit reached" badge, not the raw protocol code.
    if (b.rateLimitReachedType) extras.push({ label: name, value: limitReachedLabel(String(b.rateLimitReachedType)) })
  }
  const tier = account.account?.planType || main?.planType
  return { email: account.account?.email, tier, plan: codexPlanLabel(tier), limits, extras, resetCredits: codexResetCredits(data.rateLimitResetCredits),
    updatedAt: Date.now(), unavailable: !limits.length ? 'O provedor não informou janelas de uso para esta conta.' : undefined }
}

/** A per-turn capture with only finite, non-negative fields, or undefined. */
function turnUsage(value: any): TurnUsage | undefined {
  if (!value || typeof value !== 'object') return undefined
  const turn: TurnUsage = {}
  for (const key of ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'reasoningTokens', 'costUsd'] as const) {
    if (finite(value[key]) && value[key] >= 0) turn[key] = value[key]
  }
  return Object.keys(turn).length ? turn : undefined
}

/**
 * Claude `result`: `usage` is this turn's main loop, `costUsd` the query's
 * running total, and `turn` (when the runtime measured it) the turn's own
 * usage including subagents.
 */
export function claudeMetrics(data: any): RunMetrics {
  const u = data.usage || {}
  const turn = turnUsage(data.turn)
  return { scope: 'session', inputTokens: u.input_tokens, outputTokens: u.output_tokens,
    cachedTokens: u.cache_read_input_tokens, cacheWriteTokens: u.cache_creation_input_tokens, costUsd: finite(data.costUsd) ? data.costUsd : undefined,
    ...(finite(data.contextTokens) ? { contextTokens: data.contextTokens } : {}),
    ...(finite(data.contextWindow) ? { contextWindow: data.contextWindow } : {}),
    ...(turn ? { turn } : {}), ...(typeof data.model === 'string' && data.model ? { model: data.model } : {}) }
}

/** Last Claude model call; result.usage itself aggregates all calls in a turn. */
export function claudeContext(usage: any, modelUsage: any, model?: string): Pick<RunMetrics, 'contextTokens' | 'contextWindow'> {
  const fields = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens']
  const tokens = fields.some(k => finite(usage?.[k])) ? fields.reduce((n, k) => n + (finite(usage?.[k]) ? usage[k] : 0), 0) : undefined
  const window = model ? modelUsage?.[model]?.contextWindow : undefined
  return { ...(tokens !== undefined ? { contextTokens: tokens } : {}), ...(finite(window) ? { contextWindow: window } : {}) }
}
/** Codex `tokenUsage`: `total` is the thread's running total; `turn` is this turn's share. */
export function codexMetrics(data: any, turn?: TurnUsage): RunMetrics {
  const u = data.total || {}
  const own = turnUsage(turn)
  return { scope: 'session', inputTokens: u.inputTokens, outputTokens: u.outputTokens, cachedTokens: u.cachedInputTokens,
    reasoningTokens: u.reasoningOutputTokens, totalTokens: u.totalTokens, contextWindow: data.modelContextWindow || undefined,
    ...(finite(data.last?.inputTokens) ? { contextTokens: data.last.inputTokens + (finite(data.last.outputTokens) ? data.last.outputTokens : 0) } : {}),
    ...(own ? { turn: own } : {}) }
}

/* ---------------- Per-turn usage ---------------- */

/** Running totals of one Claude query(), summed over every model it called. */
export interface ClaudeTotals { input: number; cacheRead: number; cacheWrite: number; output: number; thinking: number | null; cost: number }

/** A fresh session: nothing spent yet. */
export const NO_CLAUDE_TOTALS: ClaudeTotals = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, thinking: null, cost: 0 }

/**
 * `modelUsage` summed across models (main loop, subagents, compaction): the
 * SDK's field for token and cost accounting, cumulative for the query().
 * Null when the result carries none.
 */
export function claudeTotals(result: any): ClaudeTotals | null {
  const models = result?.modelUsage
  if (!models || typeof models !== 'object') return null
  const totals = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, thinking: null as number | null, cost: 0 }
  let any = false
  for (const m of Object.values(models) as any[]) {
    if (!m || typeof m !== 'object') continue
    any = true
    if (finite(m.inputTokens)) totals.input += m.inputTokens
    if (finite(m.cacheReadInputTokens)) totals.cacheRead += m.cacheReadInputTokens
    if (finite(m.cacheCreationInputTokens)) totals.cacheWrite += m.cacheCreationInputTokens
    if (finite(m.outputTokens)) totals.output += m.outputTokens
    if (finite(m.thinkingTokens)) totals.thinking = (totals.thinking ?? 0) + m.thinkingTokens
    if (finite(m.costUSD)) totals.cost += m.costUSD
  }
  if (!any) return null
  if (finite(result.total_cost_usd)) totals.cost = result.total_cost_usd
  return totals
}

const below = (a: ClaudeTotals, b: ClaudeTotals): boolean =>
  a.input < b.input || a.cacheRead < b.cacheRead || a.cacheWrite < b.cacheWrite || a.output < b.output || a.cost < b.cost
const spent = (t: ClaudeTotals): boolean => t.input + t.cacheRead + t.cacheWrite + t.output + t.cost > 0

/**
 * This turn's own usage from a Claude `result`, given the query's totals
 * before it (`base`): `NO_CLAUDE_TOTALS` for a fresh session, the previous
 * result's totals within a live query, or null when unknown (a resumed
 * session "continues from the total its transcript saved", which can lag the
 * live one). With a known base the turn is the `modelUsage` difference,
 * subagents and cost included. Without one, or when the totals went backwards
 * (a restore or /clear), the tokens fall back to the turn's main-loop
 * `usage` and the cost is left unmeasured rather than guessed.
 * `next` is the base for the following result of the same query.
 */
export function claudeTurnUsage(result: any, base: ClaudeTotals | null): { turn: TurnUsage | undefined; next: ClaudeTotals | null } {
  const totals = claudeTotals(result)
  // A crashed or startup-error result can carry zeroed totals: no information.
  const next = totals && (spent(totals) || !base || !spent(base)) ? totals : base
  if (totals && base && !below(totals, base)) {
    const turn: TurnUsage = {
      inputTokens: totals.input - base.input, cacheReadTokens: totals.cacheRead - base.cacheRead, cacheWriteTokens: totals.cacheWrite - base.cacheWrite,
      outputTokens: totals.output - base.output, costUsd: totals.cost - base.cost
    }
    if (totals.thinking !== null) turn.reasoningTokens = Math.max(0, totals.thinking - (base.thinking ?? 0))
    return { turn: turnUsage(turn), next }
  }
  const u = result?.usage
  const fallback = u && typeof u === 'object' ? turnUsage({ inputTokens: u.input_tokens, cacheReadTokens: u.cache_read_input_tokens,
    cacheWriteTokens: u.cache_creation_input_tokens, outputTokens: u.output_tokens }) : undefined
  return { turn: fallback, next }
}

/** A Codex token breakdown (`tokenUsage.total` / `.last`). */
export interface CodexBreakdown { totalTokens?: number; inputTokens?: number; cachedInputTokens?: number; outputTokens?: number; reasoningOutputTokens?: number }
const CODEX_FIELDS = ['totalTokens', 'inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens'] as const

/** `a - b` field by field (missing fields count as 0). */
export function codexSubtract(a: CodexBreakdown, b: CodexBreakdown): CodexBreakdown {
  const out: CodexBreakdown = {}
  for (const f of CODEX_FIELDS) out[f] = (finite(a?.[f]) ? a[f]! : 0) - (finite(b?.[f]) ? b[f]! : 0)
  return out
}

/**
 * This turn's share of a Codex thread total: `total` minus the total before
 * the turn began. Summing `last` over the turn's updates gives the same
 * number, but a repeated update (same total) would count twice. Undefined
 * when the total went below the base (a restarted counter).
 */
export function codexTurnUsage(base: CodexBreakdown, total: CodexBreakdown): TurnUsage | undefined {
  const d = codexSubtract(total, base)
  if (CODEX_FIELDS.some((f) => d[f]! < 0)) return undefined
  // Codex counts cached input inside input; Prism keeps them apart.
  return turnUsage({ inputTokens: Math.max(0, d.inputTokens! - d.cachedInputTokens!), cacheReadTokens: d.cachedInputTokens,
    outputTokens: d.outputTokens, reasoningTokens: d.reasoningOutputTokens })
}
