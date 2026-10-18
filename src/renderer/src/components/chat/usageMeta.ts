import type { RunMetrics } from '../../../../shared/agents'

type MetricRow = readonly [label: string, value: number]
export interface UsageMeta {
  readonly turn: readonly MetricRow[]
  readonly session: readonly MetricRow[]
  readonly context: readonly MetricRow[]
  readonly turnCost?: number
  readonly sessionCost?: number
}

const known = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value) && value >= 0

/** Preserve the provider's per-turn reading separately from cumulative totals. */
export function usageMeta(metrics: RunMetrics | undefined): UsageMeta {
  const turn: MetricRow[] = [], session: MetricRow[] = [], context: MetricRow[] = []
  const push = (rows: MetricRow[], label: string, value: number | undefined): void => { if (known(value)) rows.push([label, value]) }
  const own = metrics?.turn
  push(turn, 'Entrada sem cache', own?.inputTokens)
  push(turn, 'Leitura de cache', own?.cacheReadTokens)
  push(turn, 'Gravação em cache', own?.cacheWriteTokens)
  push(turn, 'Saída', own?.outputTokens)
  push(turn, 'Raciocínio (incluído na saída)', own?.reasoningTokens)
  push(session, 'Tokens acumulados', metrics?.totalTokens)
  push(session, 'Entrada', metrics?.inputTokens)
  push(session, 'Saída', metrics?.outputTokens)
  push(session, 'Cache', metrics?.cachedTokens)
  push(session, 'Raciocínio (incluído na saída)', metrics?.reasoningTokens)
  push(context, 'Última chamada', metrics?.contextTokens)
  push(context, 'Janela', metrics?.contextWindow)
  return { turn, session, context,
    ...(known(own?.costUsd) ? { turnCost: own.costUsd } : {}),
    ...(known(metrics?.costUsd) ? { sessionCost: metrics.costUsd } : {}) }
}
