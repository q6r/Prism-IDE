import { useState } from 'react'
import { ChevronRight, ExternalLink } from 'lucide-react'
import { Badge, Button, cn, Tooltip } from '../ui'
import { totalTokens, type ChatUsageRow, type UsageMetric } from '../../lib/usageAnalytics/aggregate'
import {
  formatDateTime, formatDuration, formatInteger, formatMetricValue, formatTokens, formatUsd, providerLabel, sourceLabel, turnsLabel
} from '../../lib/usageAnalytics/format'
import type { UsageFact } from '../../../../shared/usage'

const PAGE = 8
const TURN_PAGE = 30

function OutcomeBadge({ outcome }: { outcome: UsageFact['outcome'] }) {
  if (outcome === 'error') return <Badge variant="destructive" size="xs">Erro</Badge>
  if (outcome === 'interrupted') return <Badge variant="outline" size="xs">Interrompido</Badge>
  return <Badge variant="secondary" size="xs">Concluído</Badge>
}

/** Per-turn drill-down (Traycer's usage-turn-drilldown): time, model, tokens, cost, time, outcome. */
function TurnList({ facts, timeZone }: { facts: readonly UsageFact[]; timeZone: string }) {
  const [limit, setLimit] = useState(TURN_PAGE)
  return <>
    <ul className="usg-turns">
      {facts.slice(0, limit).map((f) => <li key={f.id} className="usg-turn">
        <span className="usg-turn-time">{formatDateTime(f.occurredAt, timeZone)}</span>
        <span className="usg-turn-model" title={`${providerLabel(f.provider)} · ${f.profileName}${f.model ? ` · ${f.model}` : ''}`}>{f.modelLabel ?? (f.model || 'Padrão')}</span>
        <Tooltip label={f.tokenBasis === 'last-call' ? 'Última chamada do turno (registro do Traycer)' : `${formatInteger(totalTokens(f.tokens))} tokens`}>
          <span className="usg-turn-num">{f.measured ? formatTokens(totalTokens(f.tokens)) : '—'}</span>
        </Tooltip>
        <span className="usg-turn-num">{formatDuration(f.durationMs)}</span>
        {/* null = no cost reported, not free. */}
        <span className="usg-turn-cost">{f.costUsd === null ? '—' : formatUsd(f.costUsd)}</span>
        <OutcomeBadge outcome={f.outcome} />
      </li>)}
    </ul>
    {facts.length > limit ? <div className="usg-more"><Button variant="ghost" size="xs" onClick={() => setLimit((l) => l + TURN_PAGE)}>Mostrar mais turnos ({formatInteger(facts.length - limit)})</Button></div> : null}
  </>
}

/** The chats that used the most, each expandable into its turns. */
export function UsageTopChats({ rows, metric, timeZone, onOpenChat }: { rows: readonly ChatUsageRow[]; metric: UsageMetric; timeZone: string; onOpenChat: (prismChatId: string) => void }) {
  const [limit, setLimit] = useState(PAGE)
  const [open, setOpen] = useState<string | null>(null)
  if (!rows.length) return <p className="usg-empty">Nenhum chat com uso neste período.</p>
  return <>
    <ol className="usg-chats">
      {rows.slice(0, limit).map((row, index) => {
        const expanded = open === row.key
        const panelId = `usg-chat-${index}`
        return <li key={row.key} className={cn('usg-chat', expanded && 'open')}>
          <div className="usg-chat-row">
            <button type="button" className="usg-chat-toggle" aria-expanded={expanded} aria-controls={panelId} onClick={() => setOpen(expanded ? null : row.key)}>
              <span className="usg-chat-rank">{index + 1}</span>
              <ChevronRight size={14} className="usg-chat-chevron" aria-hidden="true" />
              <span className="usg-chat-text">
                <span className="usg-chat-title">{row.title}</span>
                <span className="usg-chat-meta">
                  <span>{row.providers.map(providerLabel).join(' + ')}</span>
                  <span aria-hidden="true">·</span>
                  <span>{row.profileName}</span>
                  {row.taskTitle ? <><span aria-hidden="true">·</span><span>{row.taskTitle}</span></> : null}
                  <span aria-hidden="true">·</span>
                  <span>{row.sources.map(sourceLabel).join(' + ')}</span>
                </span>
              </span>
              <span className="usg-chat-figures">
                <span className="optional">{turnsLabel(row.turns)}</span>
                <span className="optional">{formatTokens(row.totalTokens)} tokens</span>
                <strong>{metric === 'cost' && row.unpricedTurns === row.turns ? '—' : formatMetricValue(row.value, metric)}</strong>
              </span>
            </button>
            {row.prismChatId ? <Tooltip label="Abrir chat">
              <Button variant="ghost" size="icon-xs" aria-label={`Abrir o chat ${row.title}`} onClick={() => onOpenChat(row.prismChatId!)}><ExternalLink /></Button>
            </Tooltip> : null}
          </div>
          {expanded ? <div id={panelId}><TurnList facts={row.facts} timeZone={timeZone} /></div> : null}
        </li>
      })}
    </ol>
    {rows.length > limit ? <div className="usg-more"><Button variant="ghost" size="sm" onClick={() => setLimit((l) => l + PAGE)}>Mostrar mais chats ({formatInteger(rows.length - limit)})</Button></div> : null}
  </>
}
