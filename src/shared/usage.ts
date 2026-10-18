// Usage analytics (Settings ▸ Uso): the wire between the main process
// (ipc/usage.ts) and the renderer, and the per-turn facts the renderer's pure
// modules (lib/usageAnalytics) derive. Types only.

export type UsageSource = 'prism' | 'traycer'
export type UsageOutcome = 'completed' | 'interrupted' | 'error'

/**
 * How a counter relates to the turn it is stored on:
 * - `turn`: this turn's own usage (Claude `result.usage`, a per-turn capture);
 * - `cumulative`: a running total of the native session (Claude
 *   `total_cost_usd`, Codex `tokenUsage.total`, Traycer's `costUsd`), so the
 *   turn's share is a delta against the previous turn of the same session;
 * - `last-call`: the last model call of the turn only (Traycer's per-turn
 *   token record, which it keeps for the context meter);
 * - `none`: the source does not report it.
 */
export type UsageCounterBasis = 'turn' | 'cumulative' | 'last-call' | 'none'

/** Tokens split into mutually exclusive buckets, plus reasoning (a subset of output). */
export interface UsageTokens {
  readonly input: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly output: number
  readonly reasoning: number
}

/** One assistant turn as recorded, before session totals are turned into per-turn deltas. */
export interface UsageObservation {
  /** `${source}:${chatId}:${turnId}`, unique across sources. */
  readonly id: string
  readonly source: UsageSource
  readonly chatId: string
  readonly turnId: string
  readonly chatTitle: string
  readonly taskId: string | null
  readonly taskTitle: string | null
  /** Workspace folder name. */
  readonly project: string | null
  /** Harness: 'claude', 'codex', or another Traycer harness id. */
  readonly provider: string
  readonly model: string
  readonly profileId: string | null
  readonly profileName: string
  /** Native session the counters belong to, when known. */
  readonly sessionKey: string | null
  readonly startedAt: number
  readonly completedAt: number | null
  readonly durationMs: number | null
  readonly outcome: UsageOutcome
  /** The Prism chat this turn can be opened in, if any. */
  readonly prismChatId: string | null
  readonly tokenBasis: UsageCounterBasis
  readonly costBasis: UsageCounterBasis
  /** Uncached input (never includes cache reads or writes). */
  readonly inputTokens: number | null
  readonly cacheReadTokens: number | null
  readonly cacheWriteTokens: number | null
  /** Includes reasoning. */
  readonly outputTokens: number | null
  readonly reasoningTokens: number | null
  readonly costUsd: number | null
}

/** One turn's own usage, after deltas: what every chart and table sums. */
export interface UsageFact {
  readonly id: string
  readonly source: UsageSource
  readonly chatId: string
  readonly turnId: string
  readonly chatTitle: string
  readonly taskId: string | null
  readonly taskTitle: string | null
  readonly project: string | null
  readonly provider: string
  /** The recorded id (possibly an alias such as "opus"). */
  readonly model: string
  /** Its display name once resolved against the catalogs (lib/usageAnalytics/models.ts). */
  readonly modelLabel?: string
  readonly profileId: string | null
  readonly profileName: string
  /** Completion (or start, for a turn that never completed): the instant the usage is filed under. */
  readonly occurredAt: number
  readonly startedAt: number
  readonly durationMs: number | null
  readonly outcome: UsageOutcome
  readonly prismChatId: string | null
  readonly tokens: UsageTokens
  /** `null` = no cost reported for this turn (unpriced, never "free"). */
  readonly costUsd: number | null
  /** `false` when the turn reported no token counters at all. */
  readonly measured: boolean
  readonly tokenBasis: UsageCounterBasis
}

export interface UsageImportState {
  readonly status: 'never' | 'ok' | 'error'
  /** epoch ms of the last attempt. */
  readonly at: number | null
  readonly root: string | null
  readonly tasks: number
  readonly chats: number
  readonly turns: number
  readonly added: number
  readonly updated: number
  readonly unchanged: number
  readonly warnings: readonly string[]
  readonly error: string | null
}

export interface UsageRecordsResponse {
  readonly observations: readonly UsageObservation[]
  readonly importState: UsageImportState
  readonly generatedAt: number
}

export type UsageSaveKind = 'png' | 'csv' | 'json'
export interface UsageSaveRequest {
  readonly kind: UsageSaveKind
  readonly fileName: string
  /** PNG bytes, or the CSV/JSON text. */
  readonly data: Uint8Array | string
}
