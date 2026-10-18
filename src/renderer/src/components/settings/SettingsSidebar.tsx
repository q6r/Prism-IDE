import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Bell, Blocks, Boxes, ChevronRight, LineChart, Palette, Search, Settings, SquareCode, X, type LucideIcon } from 'lucide-react'
import { cn, InputAddon, InputGroup } from '../ui'
import {
  isSettingsSearchActive, searchSettings, settingsSearchBreadcrumb, settingsSearchResultKey,
  SETTINGS_SECTION_GROUPS, SETTINGS_SECTIONS, type SettingsSearchResult, type SettingsSectionId
} from './definitions'
import { useSettingsUi } from './state'

export const SECTION_ICONS: Record<SettingsSectionId, LucideIcon> = {
  general: Settings,
  appearance: Palette,
  editor: SquareCode,
  extensions: Blocks,
  providers: Boxes,
  usage: LineChart,
  notifications: Bell
}

/**
 * The settings rail (settings-sidebar.tsx, modal mode): search on top, then
 * the sections under their scope headings. A running search REPLACES the
 * section list; the query lives in the settings store so the modal's Escape
 * can clear it before closing anything.
 */
export function SettingsSidebar({ active, onSelect }: { active: SettingsSectionId; onSelect: (section: SettingsSectionId) => void }) {
  const query = useSettingsUi((s) => s.query)
  const setQuery = useSettingsUi((s) => s.setQuery)
  // Scoped to this mount: a remembered query would greet the next visit with a filtered rail.
  useEffect(() => () => setQuery(''), [setQuery])
  const searching = isSettingsSearchActive(query)
  return <aside data-settings-sidebar className="stg-rail">
    <SettingsSearch query={query} onQueryChange={setQuery} onNavigate={onSelect} />
    {searching ? null : SETTINGS_SECTION_GROUPS.map((group, index) => <Fragment key={group.id}>
      {index === 0 ? null : <div aria-hidden="true" className="stg-rail-rule" />}
      <h2 className="stg-rail-heading">{group.label}</h2>
      <div className="stg-rail-items">
        {SETTINGS_SECTIONS.filter((s) => s.group === group.id).map((section) => {
          const Icon = SECTION_ICONS[section.id]
          const selected = section.id === active
          return <button key={section.id} type="button" data-testid={`settings-sidebar-item-${section.id}`}
            aria-current={selected ? 'page' : undefined} className={cn('stg-rail-item', selected && 'active')} onClick={() => onSelect(section.id)}>
            <Icon size={16} className="stg-rail-icon" />
            <span className="stg-rail-label">{section.label}</span>
            <span className="stg-rail-badge" />
          </button>
        })}
      </div>
    </Fragment>)}
  </aside>
}

/**
 * Search field + results (settings-search-box.tsx). The input keeps focus the
 * whole time: arrows move the highlight, Enter opens it, Escape clears the
 * query (the modal's capture listener does that before closing anything).
 */
function SettingsSearch({ query, onQueryChange, onNavigate }: { query: string; onQueryChange: (q: string) => void; onNavigate: (section: SettingsSectionId) => void }) {
  const requestReveal = useSettingsUi((s) => s.requestReveal)
  const [highlighted, setHighlighted] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const listboxId = useId()
  const results = useMemo(() => searchSettings(query), [query])
  const active = isSettingsSearchActive(query)
  const activeIndex = results.length === 0 ? -1 : Math.min(highlighted, results.length - 1)
  const optionId = (index: number): string => `${listboxId}-option-${index}`
  const select = (result: SettingsSearchResult): void => {
    // Armed before navigating: the reveal waits for its element to mount.
    requestReveal(result.entry.section, result.entry.anchor)
    onNavigate(result.entry.section)
  }
  const move = (delta: number): void => {
    if (!results.length) return
    const next = (((activeIndex < 0 ? 0 : activeIndex) + delta) % results.length + results.length) % results.length
    setHighlighted(next)
    document.getElementById(optionId(next))?.scrollIntoView({ block: 'nearest' })
  }
  return <div className={cn('stg-search', active ? 'searching' : 'idle')} data-settings-search-box>
    <InputGroup className="stg-search-field">
      <InputAddon align="start"><Search size={14} aria-hidden="true" /></InputAddon>
      <input ref={input} type="text" value={query} placeholder="Buscar configurações" aria-label="Buscar configurações"
        role="combobox" aria-expanded={active} aria-controls={listboxId} aria-autocomplete="list"
        aria-activedescendant={active && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        autoComplete="off" spellCheck={false}
        onChange={(e) => { onQueryChange(e.target.value); setHighlighted(0) }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); move(1) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
          else if (e.key === 'Enter') { if (activeIndex < 0) return; e.preventDefault(); select(results[activeIndex]) }
        }} />
      {query.length > 0 ? <InputAddon align="end">
        <button type="button" className="stg-search-clear" aria-label="Limpar busca"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => { onQueryChange(''); setHighlighted(0); input.current?.focus() }}>
          <X size={14} aria-hidden="true" />
        </button>
      </InputAddon> : null}
    </InputGroup>
    {active ? (results.length === 0
      ? <div id={listboxId} role="listbox" aria-label="Resultados da busca" className="stg-search-empty">Nada nas configurações corresponde a “{query.trim()}”.</div>
      : <div id={listboxId} role="listbox" aria-label="Resultados da busca" className="stg-search-results" data-settings-search-results>
        {results.map((result, index) => <button key={settingsSearchResultKey(result.entry)} id={optionId(index)} type="button" role="option"
          aria-selected={index === activeIndex} tabIndex={-1} data-result-index={index}
          className={cn('stg-search-result', index === activeIndex && 'active')}
          onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setHighlighted(index)} onClick={() => select(result)}>
          <span className="stg-search-result-label"><span className="tr-truncate">{result.entry.label}</span></span>
          <span className="stg-search-crumbs">
            {settingsSearchBreadcrumb(result).map((part, i) => <span key={`${i}:${part}`} className="stg-search-crumb">
              {i === 0 ? null : <ChevronRight size={12} aria-hidden="true" />}
              <span className="tr-truncate">{part}</span>
            </span>)}
          </span>
        </button>)}
      </div>) : null}
    <p className="tr-sr-only" role="status" aria-live="polite">
      {!active ? '' : results.length === 0 ? 'Nenhuma configuração corresponde.' : `${results.length} ${results.length === 1 ? 'resultado' : 'resultados'}.`}
    </p>
  </div>
}
