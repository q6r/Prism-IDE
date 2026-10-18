import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { AppWindow, ChevronsUpDown, Palette, Search, type LucideIcon } from 'lucide-react'
import { useStore } from '../../../store'
import { cn, DropdownMenu, DropdownMenuLabel, DropdownMenuRadioItem, DropdownMenuSeparator, Switch } from '../../ui'
import { COPY, normalizeSearchText, sectionMeta } from '../definitions'
import { railRowClass, SettingsDetailHeader, SettingsGroup, SettingsMasterDetail, SettingsMasterSelect, SettingsPanelShell, SettingsRow } from '../layout'
import { useRevealArea } from '../reveal'
import { THEME_OPTIONS, themeOption, type ThemeOption } from '../themes'

const META = sectionMeta('appearance')

type AreaId = 'themes' | 'interface'
interface Area { readonly id: AreaId; readonly icon: LucideIcon; readonly label: string; readonly description: string; readonly anchors: readonly string[] }

/** The page's areas, in rail order (appearance-settings-panel.tsx APPEARANCE_AREAS). */
const AREAS: readonly Area[] = [
  { id: 'themes', icon: Palette, label: COPY.appearance.themes.label, description: COPY.appearance.themes.description, anchors: ['appearance-themes', 'appearance-theme'] },
  { id: 'interface', icon: AppWindow, label: COPY.appearance.interface.label, description: COPY.appearance.interface.description, anchors: ['appearance-interface', 'appearance-animations'] }
]

const areaForAnchor = (anchor: string): AreaId | null => AREAS.find((a) => a.anchors.includes(anchor))?.id ?? null

/**
 * Appearance, one area at a time, in the master-detail layout Providers uses.
 * Every area stays mounted (hidden while another is picked) so a search result
 * can pick its area and find its row in the same pass.
 */
export function AppearanceSettingsPanel() {
  const [area, setArea] = useState<AreaId>('themes')
  const tabs = useRef<HTMLDivElement>(null)
  const baseId = useId()
  useRevealArea('appearance', areaForAnchor, setArea)
  const onRailKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const index = AREAS.findIndex((a) => a.id === area)
    const to = e.key === 'ArrowDown' ? index + 1 : e.key === 'ArrowUp' ? index - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? AREAS.length - 1 : null
    if (to === null) return
    e.preventDefault()
    const next = AREAS[(to + AREAS.length) % AREAS.length]
    setArea(next.id)
    tabs.current?.querySelector<HTMLElement>(`[data-area="${next.id}"]`)?.focus()
  }
  return <SettingsPanelShell title={META.label} description={META.description} fillHeight>
    <SettingsMasterDetail railLabel="Áreas de aparência"
      mobileSelect={<SettingsMasterSelect label="Área de aparência" value={area} onSelect={setArea}
        options={AREAS.map((a) => ({ value: a.id, label: a.label, icon: <a.icon size={16} /> }))} />}
      rail={<div ref={tabs} role="tablist" aria-orientation="vertical" aria-label="Áreas de aparência" className="stg-md-list" onKeyDown={onRailKey}>
        {AREAS.map((a) => <button key={a.id} type="button" role="tab" data-area={a.id} id={`${baseId}-tab-${a.id}`}
          aria-selected={area === a.id} aria-controls={`${baseId}-panel-${a.id}`} tabIndex={area === a.id ? 0 : -1}
          className={railRowClass(area === a.id)} onClick={() => setArea(a.id)}>
          <a.icon size={16} className="stg-shrink-0" />
          <span className="stg-rail-row-label">{a.label}</span>
        </button>)}
      </div>}>
      {AREAS.map((a) => <div key={a.id} role="tabpanel" id={`${baseId}-panel-${a.id}`} aria-label={a.label} hidden={area !== a.id} className="stg-area">
        <div className="stg-area-head"><SettingsDetailHeader title={a.label} description={a.description} /></div>
        <div className="stg-area-body"><AreaBody area={a.id} /></div>
      </div>)}
    </SettingsMasterDetail>
  </SettingsPanelShell>
}

function AreaBody({ area }: { area: AreaId }): ReactNode {
  return area === 'themes' ? <ThemesArea /> : <InterfaceArea />
}

function ThemesArea() {
  const theme = useStore((s) => s.settings.theme)
  const updateSetting = useStore((s) => s.updateSetting)
  const current = themeOption(theme)
  return <SettingsGroup title={COPY.appearance.themes.label} anchor="appearance-themes" showTitle={false}>
    <SettingsRow anchor="appearance-theme" label={COPY.appearance.theme.label}
      labelStatus={current.appearance === 'light' ? 'Claro' : 'Escuro'}
      description={COPY.appearance.theme.description} controlSpansLine
      control={<ThemePicker value={current} onChange={(id) => updateSetting('theme', id)} />} />
  </SettingsGroup>
}

function InterfaceArea() {
  const animations = useStore((s) => s.settings.animations)
  const updateSetting = useStore((s) => s.updateSetting)
  return <SettingsGroup title={COPY.appearance.interface.label} anchor="appearance-interface" showTitle={false}>
    <SettingsRow anchor="appearance-animations" label={COPY.appearance.animations.label} description={COPY.appearance.animations.description}
      control={<Switch checked={animations} onCheckedChange={(v) => updateSetting('animations', v)} aria-label={COPY.appearance.animations.label} />} />
  </SettingsGroup>
}

/** Three stripes of the theme's own colors (theme-gallery.tsx PaletteSwatch). */
export function PaletteSwatch({ theme }: { theme: ThemeOption }) {
  return <span aria-hidden="true" className="stg-swatch">
    {(['background', 'foreground', 'primary'] as const).map((token) => <span key={token} style={{ background: theme.colors[token] } as CSSProperties} />)}
  </span>
}

/**
 * The bordered theme trigger with a search list grouped by appearance
 * (theme-gallery.tsx ThemePicker, built on the kit's dropdown).
 */
function ThemePicker({ value, onChange }: { value: ThemeOption; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const valueId = useId()
  const searchInput = useRef<HTMLInputElement>(null)
  // After the menu's own open focus (it focuses its content), hand focus to the search field.
  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => searchInput.current?.focus({ preventScroll: true }))
    return () => cancelAnimationFrame(frame)
  }, [open])
  const visible = useMemo(() => {
    const q = normalizeSearchText(filter)
    return q ? THEME_OPTIONS.filter((t) => normalizeSearchText(`${t.label} ${t.appearance === 'light' ? 'claro light' : 'escuro dark'}`).includes(q)) : THEME_OPTIONS
  }, [filter])
  const groups: { label: string; items: ThemeOption[] }[] = [
    { label: 'Escuros', items: visible.filter((t) => t.appearance === 'dark') },
    { label: 'Claros', items: visible.filter((t) => t.appearance === 'light') }
  ].filter((g) => g.items.length > 0)
  return <div className="stg-theme-picker">
    <DropdownMenu open={open} onOpenChange={(next) => { setOpen(next); if (!next) setFilter('') }} align="end" label="Temas" className="stg-theme-menu"
      trigger={<button type="button" aria-label="Tema" aria-describedby={valueId} className="stg-theme-trigger">
        <PaletteSwatch theme={value} />
        <span id={valueId} className="stg-theme-name">{value.label}</span>
        <ChevronsUpDown size={14} className="stg-theme-chevron" aria-hidden="true" />
      </button>}>
      <div className="stg-theme-search">
        <Search size={14} aria-hidden="true" />
        <input ref={searchInput} value={filter} placeholder="Buscar temas…" aria-label="Buscar temas" spellCheck={false}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && visible.length === 1) { e.preventDefault(); onChange(visible[0].id); setOpen(false) }
          }} />
      </div>
      <DropdownMenuSeparator />
      {groups.length === 0 ? <div className="stg-theme-empty">Nenhum tema corresponde.</div> : groups.map((group, i) => <div key={group.label} role="group" aria-label={group.label}>
        {i > 0 ? <DropdownMenuSeparator /> : null}
        <DropdownMenuLabel>{group.label}</DropdownMenuLabel>
        {group.items.map((t) => <DropdownMenuRadioItem key={t.id} checked={t.id === value.id} onSelect={() => onChange(t.id)}>
          <PaletteSwatch theme={t} />
          <span className={cn('tr-truncate', 'stg-theme-item-name')}>{t.label}</span>
        </DropdownMenuRadioItem>)}
      </div>)}
    </DropdownMenu>
  </div>
}
