import type { UsageFact } from '../../../../shared/usage'
import { dimensionValue, totalTokens, USAGE_DIMENSIONS, type UsageFilters, type UsageMetric, type UsageTotals } from './aggregate'
import { dayKey, hourAndWeekday, type UsageWindow } from './time'

// CSV and JSON exports of the filtered turns. Pure strings: the renderer
// hands them to the main process to save.

const CSV_COLUMNS = [
  'data_hora_utc', 'dia_local', 'hora_local', 'origem', 'provedor', 'modelo', 'modelo_id', 'conta', 'tarefa', 'projeto', 'chat', 'chat_id', 'turno_id',
  'resultado', 'duracao_s', 'tokens_entrada', 'tokens_cache_leitura', 'tokens_cache_escrita', 'tokens_saida', 'tokens_raciocinio',
  'tokens_total', 'custo_usd', 'base_tokens'
] as const

/**
 * One CSV cell (RFC 4180). Text that a spreadsheet would run as a formula
 * (=, +, -, @, tab, CR first) is prefixed with an apostrophe.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

const OUTCOMES: Readonly<Record<UsageFact['outcome'], string>> = { completed: 'concluido', interrupted: 'interrompido', error: 'erro' }

/** The turns as CSV, oldest first, with a BOM so spreadsheet apps read UTF-8. */
export function factsToCsv(facts: readonly UsageFact[], timeZone: string): string {
  const rows = [...facts].sort((a, b) => a.occurredAt - b.occurredAt || a.id.localeCompare(b.id)).map((f) => [
    new Date(f.occurredAt).toISOString(), dayKey(f.occurredAt, timeZone), hourAndWeekday(f.occurredAt, timeZone).hour,
    f.source, f.provider, f.modelLabel ?? f.model, f.model, f.profileName, f.taskTitle, f.project, f.chatTitle, f.chatId, f.turnId,
    OUTCOMES[f.outcome], f.durationMs === null ? null : Math.round(f.durationMs / 100) / 10,
    f.tokens.input, f.tokens.cacheRead, f.tokens.cacheWrite, f.tokens.output, f.tokens.reasoning, totalTokens(f.tokens),
    f.costUsd === null ? null : Math.round(f.costUsd * 1e6) / 1e6, f.tokenBasis
  ].map(csvCell).join(','))
  return `﻿${CSV_COLUMNS.join(',')}\r\n${rows.map((r) => `${r}\r\n`).join('')}`
}

/** The filtered window as JSON: what was asked, the totals, and every turn. */
export function buildUsageJson(input: {
  readonly facts: readonly UsageFact[]
  readonly window: UsageWindow
  readonly timeZone: string
  readonly filters: UsageFilters
  readonly metric: UsageMetric
  readonly totals: UsageTotals
  readonly generatedAt: number
}): string {
  const filters: Record<string, string[]> = {}
  for (const d of USAGE_DIMENSIONS) {
    const keys = input.filters[d]
    if (!keys?.length) continue
    // Name the selection by label too; keys alone are opaque outside the app.
    const labels = new Map(input.facts.map((f) => { const v = dimensionValue(f, d); return [v.key, v.label] as const }))
    filters[d] = keys.map((k) => labels.get(k) ?? k)
  }
  return JSON.stringify({
    format: 'prism-usage/1',
    generatedAt: new Date(input.generatedAt).toISOString(),
    window: { from: input.window.from, to: input.window.to, days: input.window.days, timeZone: input.timeZone },
    metric: input.metric,
    filters,
    totals: input.totals,
    turns: [...input.facts].sort((a, b) => a.occurredAt - b.occurredAt).map((f) => ({
      occurredAt: new Date(f.occurredAt).toISOString(), startedAt: new Date(f.startedAt).toISOString(), source: f.source,
      provider: f.provider, model: f.model, modelLabel: f.modelLabel ?? f.model, profile: f.profileName, task: f.taskTitle, project: f.project,
      chat: f.chatTitle, chatId: f.chatId, turnId: f.turnId, outcome: f.outcome, durationMs: f.durationMs,
      tokens: f.tokens, totalTokens: totalTokens(f.tokens), costUsd: f.costUsd, tokenBasis: f.tokenBasis
    }))
  }, null, 2)
}

/** "prism-uso-2026-09-10_2026-10-09.csv" */
export function exportFileName(window: UsageWindow, extension: string): string {
  return window.from === window.to ? `prism-uso-${window.from}.${extension}` : `prism-uso-${window.from}_${window.to}.${extension}`
}
