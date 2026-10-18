import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CalendarDays, ChartArea, Clock3, ListTree, MessagesSquare } from 'lucide-react'
import { useStore } from '../../store'
import { useAgentChats } from '../../lib/agentChats'
import { useModelCatalog } from '../../lib/modelCatalog'
import { Button, SegmentedControl, Select, Spinner } from '../ui'
import {
  applyFilters, buildActivityCalendar, buildBreakdown, buildChartColumns, buildChatRows, buildHourGrid, buildSeriesScale, earliestOccurrence, factsInWindow, filterOptions, summarize, USAGE_DIMENSIONS, type BreakdownGroup, type FilterOption,
  type UsageDimension, type UsageFilters
} from '../../lib/usageAnalytics/aggregate'
import { buildUsageJson, exportFileName, factsToCsv } from '../../lib/usageAnalytics/exportData'
import { DIMENSION_LABELS, formatDayRange, formatInteger, METRIC_LONG_LABELS } from '../../lib/usageAnalytics/format'
import { buildModelNames, labelModels } from '../../lib/usageAnalytics/models'
import { dayKey, previousWindow, resolvePeriod, viewerTimeZone } from '../../lib/usageAnalytics/time'
import { UsageActivityHeatmap, UsageHourGrid } from './UsageActivity'
import { UsageBreakdownTable } from './UsageBreakdown'
import { UsageChart } from './UsageChart'
import { UsageTopChats } from './UsageChats'
import { UsageExportActions, useUsageExport } from './UsageExportActions'
import { UsageFilterBar } from './UsageFilters'
import { UsageAccountLimits } from './UsageLimits'
import { UsageSources } from './UsageSources'
import { UsageHero, UsageStatTiles } from './UsageSummary'
import { MetricPicker, PeriodPicker } from './UsageToolbar'
import { UsageCard, UsageNotice } from './parts'
import { initialUsageMetric, periodOf, useUsagePrefs, type ChartKind } from './prefs'
import type { UsageData } from './useUsageData'

const GROUP_OPTIONS = USAGE_DIMENSIONS.map((d) => ({ value: d, label: DIMENSION_LABELS[d] }))
const BREAKDOWN_OPTIONS: readonly { value: BreakdownGroup; label: string }[] = [
  { value: 'model', label: 'Modelo' }, { value: 'day', label: 'Dia' }, { value: 'provider', label: 'Provedor' }, { value: 'profile', label: 'Conta' },
  { value: 'project', label: 'Projeto' }, { value: 'task', label: 'Tarefa' }, { value: 'source', label: 'Origem' }
]
const KINDS: readonly { value: ChartKind; label: string }[] = [{ value: 'area', label: 'Área' }, { value: 'bar', label: 'Barras' }]

/** Opens a Prism chat and gets Settings out of the way. */
function openChat(id: string): void {
  useAgentChats.getState().select(id)
  const app = useStore.getState()
  app.setWorkspaceView('agents')
  if (!app.chatOpen) app.toggleChat()
  app.setSettingsOpen(false)
}

/**
 * The Usage page body (Traycer's usage-summary-panel, extended): period and
 * metric, filters with a previous-period comparison, the headline and tiles,
 * the stacked chart, the year calendar, the hour grid, account limits, the
 * breakdown, the busiest chats and the data sources.
 */
export function UsageDashboard({ data, onImport }: { data: UsageData; onImport: (root?: string) => void }) {
  const [prefs, setPrefs] = useUsagePrefs(initialUsageMetric(data.facts))
  const [filters, setFilters] = useState<UsageFilters>({})
  const root = useRef<HTMLDivElement>(null)
  const timeZone = useMemo(viewerTimeZone, [])
  const now = data.loadedAt ?? Date.now()
  const today = dayKey(now, timeZone)
  const metric = prefs.metric

  // Model names come from the catalogs, which also resolve aliases ("opus", "default").
  useEffect(() => { const catalog = useModelCatalog.getState(); catalog.load('claude', 'ambient-claude'); catalog.load('codex', 'ambient-codex') }, [])
  const catalogs = useModelCatalog((s) => s.entries)
  const names = useMemo(() => buildModelNames(Object.values(catalogs).flatMap((e) => e.models)), [catalogs])
  const facts = useMemo(() => labelModels(data.facts, names), [data.facts, names])

  const view = useMemo(() => {
    const window = resolvePeriod(periodOf(prefs), now, timeZone, earliestOccurrence(facts))
    const filtered = applyFilters(facts, filters)
    const current = factsInWindow(filtered, window, timeZone)
    const prior = previousWindow(window)
    // "Tudo" has nothing before it to compare with.
    const compareDisabled = prefs.period === 'all' ? 'Indisponível em “Tudo”: não há período anterior.' : null
    const previous = prefs.compare && !compareDisabled ? factsInWindow(filtered, prior, timeZone) : null
    const inWindow = factsInWindow(facts, window, timeZone)
    // Each chip lists what the OTHER filters leave, so a choice never empties its own list.
    const options = Object.fromEntries(USAGE_DIMENSIONS.map((d) => [d, filterOptions(applyFilters(inWindow, { ...filters, [d]: [] }), d)])) as Record<UsageDimension, FilterOption[]>
    return { window, filtered, current, prior, previous, compareDisabled, options, totals: summarize(current, timeZone), previousTotals: previous ? summarize(previous, timeZone) : null }
  }, [facts, prefs, filters, now, timeZone])

  const { window, current, previous, prior } = view
  const chartScale = useMemo(() => buildSeriesScale(current, prefs.chartGroup, metric), [current, prefs.chartGroup, metric])
  const columns = useMemo(() => buildChartColumns({ facts: current, window, timeZone, scale: chartScale, dimension: prefs.chartGroup, metric, previousFacts: previous, previousWindow: prior }),
    [current, window, timeZone, chartScale, prefs.chartGroup, metric, previous, prior])
  const providerScale = useMemo(() => prefs.chartGroup === 'provider' ? chartScale : buildSeriesScale(current, 'provider', metric), [prefs.chartGroup, chartScale, current, metric])
  const split = useMemo(() => buildBreakdown(current, 'provider', metric, timeZone), [current, metric, timeZone])
  const calendar = useMemo(() => buildActivityCalendar(view.filtered, today, metric, timeZone), [view.filtered, today, metric, timeZone])
  const hours = useMemo(() => buildHourGrid(current, metric, timeZone), [current, metric, timeZone])
  const breakdown = useMemo(() => buildBreakdown(current, prefs.breakdown, metric, timeZone), [current, prefs.breakdown, metric, timeZone])
  const breakdownScale = useMemo(() => prefs.breakdown === 'day' ? null : prefs.breakdown === prefs.chartGroup ? chartScale : buildSeriesScale(current, prefs.breakdown, metric, 10),
    [prefs.breakdown, prefs.chartGroup, chartScale, current, metric])
  const chats = useMemo(() => buildChatRows(current, metric), [current, metric])

  const range = formatDayRange(window.from, window.to)
  const previousLabel = formatDayRange(prior.from, prior.to)
  const filterSummary = useMemo(() => USAGE_DIMENSIONS.flatMap((d) => {
    const keys = filters[d]
    if (!keys?.length) return []
    const labels = keys.map((k) => view.options[d].find((o) => o.key === k)?.label ?? (k || 'Sem valor'))
    return [`${DIMENSION_LABELS[d]}: ${labels.join(', ')}`]
  }).join(' · '), [filters, view.options])
  const exporter = useUsageExport({
    rootRef: root, title: 'Uso de agentes',
    subtitle: [range, METRIC_LONG_LABELS[metric], filterSummary].filter(Boolean).join(' · '),
    imageName: exportFileName(window, 'png'),
    dataName: (ext) => exportFileName(window, ext),
    csv: () => factsToCsv(current, timeZone),
    json: () => buildUsageJson({ facts: current, window, timeZone, filters, metric, totals: view.totals, generatedAt: Date.now() })
  })

  const setFiltersSafe = useCallback((next: UsageFilters) => setFilters(next), [])
  const unit = window.granularity === 'hour' ? 'hora' : window.granularity === 'week' ? 'semana' : 'dia'
  const prismTurns = data.facts.filter((f) => f.source === 'prism').length

  if (data.status === 'loading') return <div className="usg-root"><div className="usg-loading"><Spinner tone="muted" />Carregando uso…</div></div>
  if (data.status === 'error') {
    return <div className="usg-root"><UsageNotice tone="error" title="Não foi possível carregar o uso." detail={data.error ?? 'Erro desconhecido.'}
      action={<Button variant="outline" size="sm" onClick={() => { void data.reload() }}>Tentar novamente</Button>} /></div>
  }
  if (!data.facts.length) {
    return <div className="usg-root usg-page" ref={root}>
      <UsageNotice title="Nenhum uso registrado ainda" detail="Converse com um agente para ver tokens, custo e tempo aqui, ou traga seu histórico do Traycer."
        action={<Button variant="outline" size="sm" disabled={data.importing} onClick={() => onImport()}>{data.importing ? <Spinner className="usg-btn-spinner" /> : null}Importar do Traycer</Button>} />
      <UsageAccountLimits delay={60} />
      <UsageSources prismTurns={0} traycerTurns={0} state={data.importState} importing={data.importing} onImport={onImport} now={now} delay={120} />
    </div>
  }

  return <div className="usg-root usg-page" ref={root}>
    <div className="usg-toolbar">
      <div className="usg-toolbar-group"><PeriodPicker prefs={prefs} window={window} today={today} onChange={setPrefs} /></div>
      <div className="usg-toolbar-group">
        <MetricPicker metric={metric} onChange={(m) => setPrefs({ metric: m })} />
        <span className="usg-toolbar-group" data-settings-anchor="usage-export">
          <UsageExportActions ready={data.status === 'ready'} hasData={current.length > 0} exporter={exporter} />
        </span>
      </div>
    </div>
    <UsageFilterBar options={view.options} filters={filters} onChange={setFiltersSafe} compare={prefs.compare}
      onCompareChange={(compare) => setPrefs({ compare })} compareDisabledReason={view.compareDisabled} />

    <div className="usg-stack" data-usage-export-region="">
      <UsageHero totals={view.totals} previous={view.previousTotals} previousLabel={previousLabel} metric={metric} split={split} scale={providerScale} />
      <UsageStatTiles totals={view.totals} previous={view.previousTotals} previousLabel={previousLabel} />
      <UsageCard title={`Uso por ${unit}`} icon={ChartArea} delay={120} data-settings-anchor="usage-chart"
        subtitle={view.previousTotals ? `Linha tracejada: ${previousLabel}` : undefined}
        actions={<div className="usg-card-actions" data-usage-export-exclude="">
          <span className="usg-range-label">Agrupar por</span>
          <Select size="sm" ariaLabel="Agrupar o gráfico por" value={prefs.chartGroup} options={GROUP_OPTIONS} onValueChange={(chartGroup) => setPrefs({ chartGroup })} />
          <SegmentedControl ariaLabel="Tipo de gráfico" value={prefs.chartKind} options={KINDS} onChange={(chartKind) => setPrefs({ chartKind })} />
        </div>}>
        <UsageChart key={`${prefs.chartGroup}:${metric}`} columns={columns} scale={chartScale} metric={metric} granularity={window.granularity}
          kind={prefs.chartKind} compare={!!view.previousTotals} rootRef={root} />
      </UsageCard>
    </div>

    <UsageCard title="Atividade" icon={CalendarDays} data-settings-anchor="usage-activity" subtitle="Últimos 12 meses, com os filtros aplicados." delay={160}>
      <UsageActivityHeatmap calendar={calendar} metric={metric} />
    </UsageCard>
    <UsageCard title="Horários" icon={Clock3} subtitle={`Quando os turnos terminam, no fuso ${timeZone}.`} delay={200}>
      <UsageHourGrid grid={hours} metric={metric} />
    </UsageCard>
    <UsageAccountLimits delay={240} />
    <UsageCard title="Detalhamento" icon={ListTree} delay={280} data-settings-anchor="usage-breakdown"
      actions={<Select size="sm" ariaLabel="Agrupar o detalhamento por" value={prefs.breakdown} options={BREAKDOWN_OPTIONS} onValueChange={(breakdown) => setPrefs({ breakdown })} />}>
      <UsageBreakdownTable key={prefs.breakdown} rows={breakdown} group={prefs.breakdown} metric={metric} scale={breakdownScale} />
    </UsageCard>
    <UsageCard title="Chats com mais uso" icon={MessagesSquare} delay={320}
      subtitle={chats.length ? `${formatInteger(chats.length)} ${chats.length === 1 ? 'chat' : 'chats'} no período, por ${METRIC_LONG_LABELS[metric].toLocaleLowerCase('pt-BR')}.` : undefined}>
      <UsageTopChats key={`${window.from}:${window.to}:${metric}`} rows={chats} metric={metric} timeZone={timeZone} onOpenChat={openChat} />
    </UsageCard>
    <UsageSources prismTurns={prismTurns} traycerTurns={data.facts.length - prismTurns} state={data.importState} importing={data.importing} onImport={onImport} now={now} delay={360} />
  </div>
}
