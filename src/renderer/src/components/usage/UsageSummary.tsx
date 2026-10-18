import type { CSSProperties, ReactNode } from 'react'
import { Clock, Database, DatabaseZap, Layers3, MessagesSquare, PenLine } from 'lucide-react'
import { Tooltip } from '../ui'
import { buildStatTiles, isTokenMetric, percentChange, totalsValue, type BreakdownRow, type SeriesScale, type UsageMetric, type UsageTotals } from '../../lib/usageAnalytics/aggregate'
import {
  formatDuration, formatInteger, formatMetricValue, formatPercent, formatTokens, formatUsd, METRIC_LONG_LABELS, turnsLabel
} from '../../lib/usageAnalytics/format'
import { ChangePill } from './parts'

/** The cost sentence every priced total carries, at Traycer's density: asterisk on the figure, five words below. */
const COST_FOOTNOTE = '* se cobrado pela tarifa cheia da API'

function costTooltip(totals: UsageTotals): string {
  const sentences = ['Estimativa do próprio Claude Code com os preços públicos da API — sua assinatura é cobrada à parte.']
  if (totals.unpricedTurns > 0) {
    sentences.push(`${turnsLabel(totals.unpricedTurns)} sem custo informado (o Codex não informa custo) ${totals.unpricedTurns === 1 ? 'fica' : 'ficam'} fora do total.`)
  }
  return sentences.join(' ')
}

const TOKEN_NOTE = 'O Traycer guarda só a última chamada de cada turno; os tokens desses turnos ficam abaixo do real. O custo deles é exato.'

function figureText(totals: UsageTotals, metric: UsageMetric): string {
  const value = totalsValue(totals, metric)
  if (metric === 'cost') return totals.pricedTurns > 0 ? `${formatUsd(value)}*` : '—'
  if (metric === 'turns') return turnsLabel(value)
  if (metric === 'duration') return formatDuration(value)
  return `${formatTokens(value)} tokens`
}

/** The headline: the selected metric's total, its honesty notes, the other totals and the provider split. */
export function UsageHero({ totals, previous, previousLabel, metric, split, scale }: {
  totals: UsageTotals
  previous: UsageTotals | null
  previousLabel: string
  metric: UsageMetric
  split: readonly BreakdownRow[]
  scale: SeriesScale
}) {
  const empty = totals.turns === 0
  const change = previous ? percentChange(totalsValue(totals, metric), totalsValue(previous, metric)) : undefined
  const figure = empty ? 'Nenhum uso neste período' : figureText(totals, metric)
  const tooltip = empty ? null : metric === 'cost' ? (totals.pricedTurns > 0 ? costTooltip(totals) : 'Nenhum turno deste período informou custo.')
    : isTokenMetric(metric) && totals.lastCallTurns > 0 ? TOKEN_NOTE : null
  const footnote = empty ? null : metric === 'cost'
    ? totals.pricedTurns > 0 ? `${COST_FOOTNOTE}${totals.unpricedTurns > 0 ? ` · ${turnsLabel(totals.unpricedTurns)} sem custo` : ''}` : 'Sem custo informado neste período.'
    : isTokenMetric(metric) && totals.lastCallTurns > 0 ? `Inclui ${turnsLabel(totals.lastCallTurns)} do Traycer com só a última chamada registrada.` : null
  const tint = split[0] ? `var(${scale.tokenFor(split[0].key)})` : undefined
  const secondary: { key: UsageMetric; node: ReactNode }[] = [
    { key: 'cost', node: <><strong>{totals.pricedTurns ? formatUsd(totals.costUsd) : '—'}</strong> de custo</> },
    { key: 'tokens', node: <><strong>{formatTokens(totals.totalTokens)}</strong> tokens</> },
    { key: 'turns', node: <><strong>{formatInteger(totals.turns)}</strong> {totals.turns === 1 ? 'turno' : 'turnos'}</> },
    { key: 'duration', node: <><strong>{formatDuration(totals.durationMs)}</strong> em execução</> }
  ]
  const lead: UsageMetric = isTokenMetric(metric) ? 'tokens' : metric
  return <section className="usg-card usg-hero" style={{ '--usg-hero-tint': tint } as CSSProperties} aria-label="Resumo do período">
    <div className="usg-hero-main">
      <span className="usg-eyebrow">{METRIC_LONG_LABELS[metric]} no período</span>
      <div className="usg-figure-row">
        {tooltip ? <Tooltip label={tooltip} side="bottom" align="start">
          <button type="button" className="usg-figure">{figure}</button>
        </Tooltip> : <span className={empty ? 'usg-figure empty' : 'usg-figure'}>{figure}</span>}
        {change !== undefined && !empty ? <ChangePill percent={change} previousLabel={previousLabel} /> : null}
      </div>
      {footnote ? <p className="usg-footnote">{footnote}</p> : null}
      {!empty ? <div className="usg-hero-secondary">
        {secondary.filter((s) => s.key !== lead).map((s) => <span key={s.key}>{s.node}</span>)}
        <span><strong>{formatInteger(totals.chats)}</strong> {totals.chats === 1 ? 'chat' : 'chats'}</span>
      </div> : null}
    </div>
    {split.length ? <div className="usg-hero-split">
      <span className="usg-hero-split-title">Por provedor</span>
      <ul className="usg-split">
        {split.map((row) => {
          const swatch = { '--swatch': `var(${scale.tokenFor(row.key)})` } as CSSProperties
          const percent = row.share * 100
          return <li key={row.key} className="usg-split-row">
            <span className="usg-dot" style={swatch} aria-hidden="true" />
            <span className="usg-split-label">{row.label}</span>
            <span className="usg-bar" role="img" aria-label={`${formatPercent(percent)} de ${METRIC_LONG_LABELS[metric].toLocaleLowerCase('pt-BR')}`}>
              <span style={{ ...swatch, width: `${Math.min(100, percent)}%` }} />
            </span>
            <span className="usg-split-pct">{formatPercent(percent)}</span>
            <span className="usg-split-value">{metric === 'cost' && row.pricedTurns === 0 ? '—' : formatMetricValue(row.value, metric)}</span>
          </li>
        })}
      </ul>
    </div> : null}
  </section>
}

interface Tile {
  readonly key: string
  readonly icon: typeof Clock
  readonly label: string
  readonly value: string
  readonly detail: string | null
  readonly change?: number | null
}

/** Six tiles; a secondary line appears only for a figure that was actually reported. */
export function UsageStatTiles({ totals, previous, previousLabel }: { totals: UsageTotals; previous: UsageTotals | null; previousLabel: string }) {
  const t = buildStatTiles(totals)
  const p = previous ? buildStatTiles(previous) : null
  const delta = (current: number, base: number | undefined): number | null | undefined => p && base !== undefined ? percentChange(current, base) : undefined
  const tiles: Tile[] = [
    { key: 'processed', icon: Layers3, label: 'Tokens processados', value: formatTokens(t.processed.total),
      detail: t.processed.perActiveDay === null ? null : `${formatTokens(t.processed.perActiveDay)} por dia ativo`, change: delta(t.processed.total, p?.processed.total) },
    { key: 'cached', icon: DatabaseZap, label: 'Entrada em cache', value: formatTokens(t.cached.cacheRead),
      detail: t.cached.percentOfInput === null ? null : `${formatPercent(Math.round(t.cached.percentOfInput))} da entrada`, change: delta(t.cached.cacheRead, p?.cached.cacheRead) },
    { key: 'uncached', icon: Database, label: 'Entrada sem cache', value: formatTokens(t.uncached.input),
      detail: t.uncached.cacheWrite > 0 ? `+ ${formatTokens(t.uncached.cacheWrite)} gravados em cache` : null, change: delta(t.uncached.input, p?.uncached.input) },
    { key: 'output', icon: PenLine, label: 'Saída', value: formatTokens(t.output.output),
      detail: t.output.reasoning === null ? null : `inclui ${formatTokens(t.output.reasoning)} de raciocínio`, change: delta(t.output.output, p?.output.output) },
    { key: 'turns', icon: MessagesSquare, label: 'Turnos', value: formatInteger(t.turns.turns),
      detail: t.turns.errors + t.turns.interrupted > 0 ? [t.turns.errors ? `${formatInteger(t.turns.errors)} com erro` : '', t.turns.interrupted ? `${formatInteger(t.turns.interrupted)} interrompidos` : ''].filter(Boolean).join(' · ')
        : `em ${formatInteger(t.turns.chats)} ${t.turns.chats === 1 ? 'chat' : 'chats'}`, change: delta(t.turns.turns, p?.turns.turns) },
    { key: 'duration', icon: Clock, label: 'Tempo de execução', value: formatDuration(t.duration.total),
      detail: t.duration.perTurn === null ? null : `${formatDuration(t.duration.perTurn)} por turno`, change: delta(t.duration.total, p?.duration.total) }
  ]
  return <div className="usg-tiles" role="list" aria-label="Estatísticas do período">
    {tiles.map((tile, i) => <div key={tile.key} role="listitem" className="usg-tile" style={{ '--usg-delay': `${60 + i * 30}ms` } as CSSProperties}>
      <span className="usg-tile-label"><tile.icon aria-hidden="true" />{tile.label}</span>
      <span className="usg-tile-value-row">
        <span className="usg-tile-value">{tile.value}</span>
        {tile.change !== undefined && totals.turns > 0 ? <ChangePill percent={tile.change} previousLabel={previousLabel} size="small" /> : null}
      </span>
      {tile.detail ? <span className="usg-tile-detail">{tile.detail}</span> : null}
    </div>)}
  </div>
}
