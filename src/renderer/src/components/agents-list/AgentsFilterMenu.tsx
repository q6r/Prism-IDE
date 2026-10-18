import { useState } from 'react'
import { ArrowDownWideNarrow, ArrowUpNarrowWide, ChevronLeft, ChevronRight, ListFilter, RotateCcw } from 'lucide-react'
import { DropdownMenu, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuShortcut } from '../ui'
import { MenuFocusOnChange, TipButton } from './parts'
import {
  ARCHIVE_OPTIONS, DEFAULT_SORT, DEFAULT_VIEW, HARNESS_OPTIONS, SORT_FIELDS, SORT_FIELD_LABELS,
  archiveLabel, filterCount, harnessLabel, isSortActive, isViewActive, sortSummary, viewTriggerLabel, type AgentView
} from './model'

type Detail = 'ordering' | 'show' | 'harness'
const DETAIL_LABELS: Record<Detail, string> = { ordering: 'Ordenação', show: 'Mostrar', harness: 'Agente' }

/**
 * The Agents panel's view menu (ChatFilterMenu): Ordering and Show, then the
 * Filters facets, and Reset view once anything is off its default. Each facet
 * drills in place, with a Back row on top; picks keep the menu open.
 */
export function AgentsFilterMenu({ view, onChange }: { view: AgentView; onChange: (view: AgentView) => void }) {
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState<Detail | null>(null)
  const label = viewTriggerLabel(view)
  const count = filterCount(view)
  const keep = (e: { preventDefault: () => void }): void => e.preventDefault()
  const entry = (d: Detail, summary: string) => <DropdownMenuItem className="al-view-entry" onSelect={(e) => { keep(e); setDetail(d) }}>
    <span className="tr-truncate">{DETAIL_LABELS[d]}</span>
    <span className="al-view-summary tr-truncate">{summary}</span>
    <ChevronRight className="al-view-chevron" />
  </DropdownMenuItem>

  return <DropdownMenu open={open} onOpenChange={(next) => { setOpen(next); if (!next) setDetail(null) }} label={label}
    side="bottom" align="end" sideOffset={6} className="al-menu al-view-menu" trigger={
      <TipButton tip={label} variant="muted" size="icon-sm" aria-label={label} className="al-header-btn al-filter-trigger" data-active={isViewActive(view) || undefined}>
        <ListFilter />
        {count > 0 ? <span className="al-filter-badge" aria-hidden="true">{count}</span> : null}
      </TipButton>}>
    <MenuFocusOnChange token={detail ?? 'root'} />
    {detail ? <>
      <DropdownMenuItem onSelect={(e) => { keep(e); setDetail(null) }}>
        <ChevronLeft />Voltar<DropdownMenuShortcut>{DETAIL_LABELS[detail]}</DropdownMenuShortcut>
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      {detail === 'ordering' ? <>
        <DropdownMenuLabel>Ordenar por</DropdownMenuLabel>
        {SORT_FIELDS.map((field) => <DropdownMenuRadioItem key={field} checked={view.sort.field === field}
          onSelect={(e) => { keep(e); onChange({ ...view, sort: { ...view.sort, field } }) }}>{SORT_FIELD_LABELS[field]}</DropdownMenuRadioItem>)}
        <DropdownMenuSeparator />
        <DropdownMenuRadioItem checked={view.sort.direction === 'desc'} onSelect={(e) => { keep(e); onChange({ ...view, sort: { ...view.sort, direction: 'desc' } }) }}>
          <ArrowDownWideNarrow />Decrescente
        </DropdownMenuRadioItem>
        <DropdownMenuRadioItem checked={view.sort.direction === 'asc'} onSelect={(e) => { keep(e); onChange({ ...view, sort: { ...view.sort, direction: 'asc' } }) }}>
          <ArrowUpNarrowWide />Crescente
        </DropdownMenuRadioItem>
        {isSortActive(view.sort) ? <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={(e) => { keep(e); onChange({ ...view, sort: DEFAULT_SORT }) }}><RotateCcw />Redefinir ordenação</DropdownMenuItem>
        </> : null}
      </> : null}
      {detail === 'show' ? ARCHIVE_OPTIONS.map((o) => <DropdownMenuRadioItem key={o.value} checked={view.archive === o.value}
        onSelect={(e) => { keep(e); onChange({ ...view, archive: o.value }) }}>{o.label}</DropdownMenuRadioItem>) : null}
      {detail === 'harness' ? HARNESS_OPTIONS.map((o) => <DropdownMenuRadioItem key={o.value} checked={view.harness === o.value}
        onSelect={(e) => { keep(e); onChange({ ...view, harness: o.value }) }}>{o.label}</DropdownMenuRadioItem>) : null}
    </> : <>
      {entry('ordering', sortSummary(view.sort))}
      {entry('show', archiveLabel(view.archive))}
      <DropdownMenuLabel className="al-view-group">Filtros</DropdownMenuLabel>
      {entry('harness', harnessLabel(view.harness))}
      {isViewActive(view) ? <>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={(e) => { keep(e); onChange(DEFAULT_VIEW) }}><RotateCcw />Redefinir visualização</DropdownMenuItem>
      </> : null}
    </>}
  </DropdownMenu>
}
