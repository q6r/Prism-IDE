import { useMemo, useState, type ReactNode } from 'react'
import { Bot, Check, ChevronDown, Database, Folder, Layers, Sparkles, User, X, type LucideIcon } from 'lucide-react'
import { Button, cn, DropdownMenu, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, Switch, Tooltip, useMenuContext, type MenuSelectEvent } from '../ui'
import { USAGE_DIMENSIONS, type FilterOption, type UsageDimension, type UsageFilters as Filters } from '../../lib/usageAnalytics/aggregate'
import { DIMENSION_LABELS, formatInteger } from '../../lib/usageAnalytics/format'

export const DIMENSION_ICONS: Readonly<Record<UsageDimension, LucideIcon>> = {
  provider: Bot, model: Sparkles, profile: User, project: Folder, task: Layers, source: Database
}

/** A checkable menu row that keeps the menu open (Radix CheckboxItem). */
function CheckItem({ checked, onToggle, children }: { checked: boolean; onToggle: () => void; children: ReactNode }) {
  const menu = useMenuContext()
  return <div role="menuitemcheckbox" aria-checked={checked} tabIndex={-1} className="tr-menu-item radio"
    onPointerMove={(e) => { if (document.activeElement !== e.currentTarget) e.currentTarget.focus({ preventScroll: true }) }}
    onPointerLeave={(e) => { if (document.activeElement === e.currentTarget) menu?.content?.focus({ preventScroll: true }) }}
    onClick={onToggle}>
    <span className="tr-menu-item-indicator">{checked ? <Check size={16} /> : null}</span>
    {children}
  </div>
}

/** One dimension's multi-select filter chip. */
export function FilterMenu({ dimension, options, selected, onChange }: {
  dimension: UsageDimension
  options: readonly FilterOption[]
  selected: readonly string[]
  onChange: (keys: string[]) => void
}) {
  const [query, setQuery] = useState('')
  const Icon = DIMENSION_ICONS[dimension]
  const label = DIMENSION_LABELS[dimension]
  const chosen = new Set(selected)
  // A selection the current window no longer contains stays visible, so it can be cleared.
  const all = useMemo(() => {
    const known = new Set(options.map((o) => o.key))
    return [...options, ...selected.filter((k) => !known.has(k)).map((key): FilterOption => ({ key, label: key || 'Sem valor', detail: null, turns: 0 }))]
  }, [options, selected])
  const needle = query.trim().toLocaleLowerCase('pt-BR')
  const shown = needle ? all.filter((o) => `${o.label} ${o.detail ?? ''}`.toLocaleLowerCase('pt-BR').includes(needle)) : all
  const toggle = (key: string): void => onChange(chosen.has(key) ? selected.filter((k) => k !== key) : [...selected, key])
  const first = all.find((o) => o.key === selected[0])
  return <DropdownMenu label={`Filtrar por ${label.toLocaleLowerCase('pt-BR')}`} align="start" onOpenChange={(open) => { if (!open) setQuery('') }}
    trigger={<button type="button" className={cn('usg-filter-chip', selected.length > 0 && 'active')} aria-label={`${label}${selected.length ? `: ${selected.length} selecionado(s)` : ''}`}>
      <Icon aria-hidden="true" />
      <span>{label}</span>
      {selected.length === 1 && first ? <span className="usg-filter-value">{first.label}</span> : null}
      {selected.length > 1 ? <span className="usg-filter-count">{selected.length}</span> : null}
      <ChevronDown aria-hidden="true" />
    </button>}>
    <DropdownMenuLabel>{label}</DropdownMenuLabel>
    {all.length > 7 ? <div className="usg-menu-search">
      <input className="tr-input" value={query} placeholder="Buscar…" aria-label={`Buscar ${label.toLocaleLowerCase('pt-BR')}`}
        onChange={(e) => setQuery(e.target.value)}
        // Typing (Space, Home, End…) edits the query; only list navigation reaches the menu.
        onKeyDown={(e) => { if (!['ArrowDown', 'ArrowUp', 'Escape', 'Tab'].includes(e.key)) e.stopPropagation() }} />
    </div> : null}
    <div className="usg-menu-list">
      {shown.length === 0 ? <div className="usg-menu-empty">{all.length ? 'Nada encontrado.' : 'Sem valores neste período.'}</div> : null}
      {shown.map((o) => <CheckItem key={o.key} checked={chosen.has(o.key)} onToggle={() => toggle(o.key)}>
        <span className="usg-menu-option">
          <span className="usg-menu-option-text">
            <span className="tr-truncate">{o.label}</span>
            {o.detail ? <span className="usg-menu-option-detail">{o.detail}</span> : null}
          </span>
          <span className="usg-menu-option-count">{formatInteger(o.turns)}</span>
        </span>
      </CheckItem>)}
    </div>
    {selected.length ? <>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={(e: MenuSelectEvent) => { e.preventDefault(); onChange([]) }}><X aria-hidden="true" />Limpar seleção</DropdownMenuItem>
    </> : null}
  </DropdownMenu>
}

/** The filter chips, the comparison switch and "clear all". */
export function UsageFilterBar({ options, filters, onChange, compare, onCompareChange, compareDisabledReason }: {
  options: Readonly<Record<UsageDimension, readonly FilterOption[]>>
  filters: Filters
  onChange: (filters: Filters) => void
  compare: boolean
  onCompareChange: (compare: boolean) => void
  compareDisabledReason: string | null
}) {
  const active = USAGE_DIMENSIONS.some((d) => (filters[d]?.length ?? 0) > 0)
  return <div className="usg-filters" role="group" aria-label="Filtros">
    {USAGE_DIMENSIONS.map((d) => <FilterMenu key={d} dimension={d} options={options[d]} selected={filters[d] ?? []}
      onChange={(keys) => onChange({ ...filters, [d]: keys })} />)}
    {active ? <Button variant="ghost" size="xs" onClick={() => onChange({})}><X />Limpar filtros</Button> : null}
    <span className="usg-filter-sep" aria-hidden="true" />
    <Tooltip label={compareDisabledReason}>
      <label className="usg-compare" aria-disabled={compareDisabledReason ? true : undefined}>
        <Switch checked={compare && !compareDisabledReason} disabled={!!compareDisabledReason} onCheckedChange={onCompareChange} aria-label="Comparar com o período anterior" />
        Comparar com o período anterior
      </label>
    </Tooltip>
  </div>
}
