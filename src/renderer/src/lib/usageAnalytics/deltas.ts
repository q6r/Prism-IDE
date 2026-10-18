import type { UsageFact, UsageObservation, UsageTokens } from '../../../../shared/usage'

// Session totals -> per-turn usage. Several counters are running totals of a
// native session (Claude's `total_cost_usd`, Codex's `tokenUsage.total`,
// Traycer's per-turn `costUsd`), so a turn's own share is the difference from
// the previous turn of the same session. Pure: no clock, no DOM.

type TokenField = 'inputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'outputTokens' | 'reasoningTokens'
const TOKEN_FIELDS: readonly TokenField[] = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'reasoningTokens']

/** A usable counter reading: finite and non-negative, else absent. */
export function cleanCounter(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * What a reading below the previous one of the same session means:
 * - `restart`: the counter started again from zero (Codex token totals), so
 *   the whole reading is new usage;
 * - `unknown`: the counter was restored from a saved point of the session
 *   (Claude's cost after a process restart "continues from the total its
 *   transcript saved", which can lag the live total), so the base is unknown
 *   and this turn's share can't be told. It reads as absent, never invented.
 */
export type CounterDrop = 'restart' | 'unknown'

/**
 * The part of a running total that belongs to this reading; never negative.
 * The first reading of a session is all new usage.
 */
export function counterDelta(current: number | null, previous: number | null, onDrop: CounterDrop = 'restart'): number | null {
  if (current === null) return null
  if (previous === null) return current
  if (current < previous) return onDrop === 'restart' ? current : null
  return current - previous
}

const profileKey = (o: UsageObservation): string => o.profileId ?? o.profileName

/**
 * Whether `next` runs in a different native session than `prev` (same chat),
 * so running totals start again from zero.
 */
export function startsNewSession(prev: UsageObservation, next: UsageObservation): boolean {
  // Known session ids decide alone: an account label can change mid-session.
  if (prev.sessionKey !== null && next.sessionKey !== null) return prev.sessionKey !== next.sessionKey
  if (prev.provider !== next.provider) return true
  if (profileKey(prev) !== profileKey(next)) return true
  // Without session ids: Prism drops the native session after a failed or
  // stopped turn and continues in a fresh one.
  return next.source === 'prism' && prev.outcome !== 'completed'
}

/** Running totals are reported when a turn ends, so they are read in completion order. */
const byCompletion = (a: UsageObservation, b: UsageObservation): number =>
  (a.completedAt ?? a.startedAt) - (b.completedAt ?? b.startedAt) || a.startedAt - b.startedAt || a.id.localeCompare(b.id)

/**
 * One fact per observation, chat by chat in completion order. Running
 * totals become deltas within each chat's session; `turn` and `last-call`
 * counters are taken as reported; `none` counters are absent.
 */
export function deriveTurnUsage(observations: readonly UsageObservation[]): UsageFact[] {
  const chats = new Map<string, UsageObservation[]>()
  for (const o of observations) {
    const key = `${o.source}\0${o.chatId}`
    const list = chats.get(key)
    if (list) list.push(o)
    else chats.set(key, [o])
  }
  const facts: UsageFact[] = []
  for (const list of chats.values()) {
    list.sort(byCompletion)
    let last: UsageObservation | null = null
    let previousTokens: Record<TokenField, number | null> = emptyReadings()
    let previousCost: number | null = null
    for (const o of list) {
      if (last && startsNewSession(last, o)) { previousTokens = emptyReadings(); previousCost = null }
      const own: Record<TokenField, number | null> = emptyReadings()
      for (const field of TOKEN_FIELDS) {
        const reading = cleanCounter(o[field])
        if (o.tokenBasis === 'none') continue
        if (o.tokenBasis === 'cumulative') {
          own[field] = counterDelta(reading, previousTokens[field])
          if (reading !== null) previousTokens[field] = reading
        } else own[field] = reading
      }
      let cost: number | null = null
      const costReading = cleanCounter(o.costUsd)
      if (o.costBasis === 'cumulative') {
        // A zeroed total after a positive one is a crashed or startup-error
        // result: it says nothing about the session, so it neither counts nor
        // moves the baseline. Any other drop is a restored total (see CounterDrop).
        if (!(costReading === 0 && (previousCost ?? 0) > 0)) {
          cost = counterDelta(costReading, previousCost, 'unknown')
          if (costReading !== null) previousCost = costReading
        }
      } else if (o.costBasis === 'turn') cost = costReading
      const measured = TOKEN_FIELDS.some((f) => own[f] !== null)
      const tokens: UsageTokens = {
        input: own.inputTokens ?? 0,
        cacheRead: own.cacheReadTokens ?? 0,
        cacheWrite: own.cacheWriteTokens ?? 0,
        output: own.outputTokens ?? 0,
        // A subset of output: never larger than it.
        reasoning: Math.min(own.reasoningTokens ?? 0, own.outputTokens ?? Number.POSITIVE_INFINITY)
      }
      facts.push({
        id: o.id, source: o.source, chatId: o.chatId, turnId: o.turnId, chatTitle: o.chatTitle,
        taskId: o.taskId, taskTitle: o.taskTitle, project: o.project, provider: o.provider, model: o.model,
        profileId: o.profileId, profileName: o.profileName,
        occurredAt: o.completedAt ?? o.startedAt, startedAt: o.startedAt,
        durationMs: cleanCounter(o.durationMs), outcome: o.outcome, prismChatId: o.prismChatId,
        tokens, costUsd: cost, measured, tokenBasis: o.tokenBasis
      })
      last = o
    }
  }
  return facts
}

function emptyReadings(): Record<TokenField, number | null> {
  return { inputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null, reasoningTokens: null }
}
