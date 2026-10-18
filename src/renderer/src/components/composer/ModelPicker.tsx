import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, RefreshCw, Search, Settings, Zap } from 'lucide-react'
import type { AgentModel, AgentSelection, Provider, ProviderProfile, UnifiedChat } from '../../../../shared/agents'
import { AccentDot, Badge, cn, InputAddon, InputGroup, Kbd, Spinner, ToolbarChip, Tooltip, useFloating } from '../ui'
import ProviderIcon from '../ProviderIcon'
import ProfileDropdown, { profileColor, shortcutProfiles } from '../providers/ProfileDropdown'
import EffortSlider from './EffortSlider'
import { catalogKey, defaultEffortFor, EFFORT_LABELS, readPickerMemory, resolveModelPick, resolveProviderSwitch, selectedModelFor, useModelCatalog } from '../../lib/modelCatalog'
import { useProviderUsage } from '../../lib/providerUsage'
import { useAgentChats } from '../../lib/agentChats'
import { useStore } from '../../store'
import '../../styles/composer.css'

/** Rail order as in Traycer's picker. */
const RAIL: readonly Provider[] = ['codex', 'claude']
const HARNESS_LABEL: Record<Provider, string> = { claude: 'Claude Code', codex: 'Codex' }
const SHORTCUT = 'Shift+Alt+M'
const profileShortcut = (index: number): string | null => index < 9 ? `Ctrl+Shift+${index + 1}` : null
/** The Claude SDK's FastModeDisabledReason, in the picker's words. */
const FAST_REASONS: Record<string, string> = {
  free: 'indisponível no plano gratuito', preference: 'desligado nas preferências do Claude', extra_usage_disabled: 'requer o uso extra ativado',
  network_error: 'erro de rede ao verificar', unknown: 'indisponível agora', not_first_party: 'indisponível neste provedor',
  disabled_by_env: 'desativado por variável de ambiente', model_not_allowed: 'indisponível para este modelo',
  sdk_opt_in_required: 'não ativado pelo app', pending: 'ainda verificando a conta'
}

interface Row { readonly id: string; readonly label: string; readonly model?: AgentModel }

export default function ModelPicker({ chat, disabled, fastReport, onConfigure, onAfterClose }: {
  chat: Pick<UnifiedChat, 'selection' | 'remoteId'>
  disabled: boolean
  /** Claude's report on whether Fast served the last turn of this route. */
  fastReport?: { state: string; reason?: string }
  onConfigure: (patch: Partial<AgentSelection>) => void
  /** Hands focus back to the composer editor (Traycer closes onto the editor, not the pill). */
  onAfterClose: () => void
}) {
  const selection = chat.selection
  const remote = !!chat.remoteId
  const profiles = useAgentChats((s) => s.profiles)
  const catalogs = useModelCatalog((s) => s.entries)
  const loadCatalog = useModelCatalog((s) => s.load)
  const ensureUsage = useProviderUsage((s) => s.ensure)
  const usage = useProviderUsage((s) => s.entries)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeId, setActiveId] = useState<string | null>(null)
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null)
  const [panel, setPanel] = useState<HTMLDivElement | null>(null)
  const [column, setColumn] = useState<HTMLDivElement | null>(null)
  const search = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // Remote chats run the server's terminal Claude; the local catalog still names its models.
  const catalogProvider: Provider = remote ? 'claude' : selection.provider
  const catalogProfile = remote ? 'ambient-claude' : selection.profileId
  const catalog = catalogs[catalogKey(catalogProvider, catalogProfile)]
  const models = catalog?.models ?? []
  useEffect(() => { loadCatalog(catalogProvider, catalogProfile) }, [catalogProvider, catalogProfile])
  const selectable = (p: Provider): ProviderProfile[] => profiles.filter((x) => x.provider === p && !x.tombstoned)
  const providerProfiles = selectable(selection.provider)
  const activeProfile = providerProfiles.find((p) => p.id === selection.profileId)
  const selectedModel = selectedModelFor(selection, models)
  const placement = useFloating(trigger, panel, { open, side: 'bottom', align: 'end', sideOffset: 8, collisionPadding: 12 })

  const rows = useMemo<Row[]>(() => {
    const list: Row[] = models.map((m) => ({ id: m.id, label: m.label, model: m }))
    if (selection.model && !list.some((r) => r.id === selection.model)) list.unshift({ id: selection.model, label: selection.model })
    if (!selection.model && !list.some((r) => r.model?.default)) list.unshift({ id: '', label: 'Padrão do agente' })
    const q = query.trim().toLocaleLowerCase()
    return q ? list.filter((r) => `${r.label} ${r.id} ${r.model?.description || ''}`.toLocaleLowerCase().includes(q)) : list
  }, [models, selection.model, query])
  const selectedRowId = selection.model || (models.find((m) => m.default)?.id ?? '')
  const effectiveActive = activeId !== null && rows.some((r) => r.id === activeId) ? activeId : rows.find((r) => r.id === selectedRowId)?.id ?? rows[0]?.id ?? null

  const close = (refocus = true): void => { setOpen(false); setQuery(''); setActiveId(null); if (refocus) onAfterClose() }
  const openPicker = (): void => {
    if (disabled) return
    setOpen(true); setQuery(''); setActiveId(null)
    loadCatalog(catalogProvider, catalogProfile)
    for (const p of providerProfiles) ensureUsage(p)
  }
  useEffect(() => { if (disabled && open) close(false) }, [disabled])
  useEffect(() => { if (open && placement.ready) search.current?.focus({ preventScroll: true }) }, [open, placement.ready])
  useEffect(() => {
    if (!open) return
    const outside = (e: PointerEvent): void => {
      const t = e.target as Element
      if (panel?.contains(t) || trigger?.contains(t) || t.closest?.('[data-tr-keep-open]')) return
      // An open menu (the profile dropdown) is the top layer: that press only dismisses it.
      if (document.querySelector('.tr-menu')) return
      close(false)
    }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [open, panel, trigger])
  // Shift+Alt+M opens/closes the picker of the visible composer (Traycer's model picker chord).
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.shiftKey && e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyM') {
        if (!trigger || trigger.offsetParent === null) return
        e.preventDefault()
        if (open) close(); else openPicker()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  useEffect(() => { listRef.current?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(effectiveActive ?? '')}"]`)?.scrollIntoView({ block: 'nearest' }) }, [effectiveActive, open])

  // A model pick restores that model's remembered effort/Fast, else its own
  // defaults (Traycer's commitSelection). The panel stays open, as in Traycer.
  const selectRow = (row: Row): void => {
    if (row.id === selection.model) return
    const remembered = row.id ? resolveModelPick(selection.provider, row.id) : { effort: null, serviceTier: null }
    const m = row.model
    const effort = remembered.effort && (!m?.efforts.length || m.efforts.includes(remembered.effort)) ? remembered.effort : defaultEffortFor(m, selection.effort)
    onConfigure({ model: row.id, effort, serviceTier: remembered.serviceTier ?? '' })
    setActiveId(row.id)
  }
  const switchProvider = (provider: Provider): void => {
    if (provider === selection.provider || remote) return
    const memory = resolveProviderSwitch(provider)
    const profile = profiles.find((p) => p.id === memory.profileId && p.provider === provider && p.enabled !== false && !p.tombstoned)
    const profileId = profile?.id ?? `ambient-${provider}`
    // The destination's default row, when its catalog is already loaded, names the default effort.
    const loaded = useModelCatalog.getState().entries[catalogKey(provider, profileId)]?.models ?? []
    const target = memory.model ? loaded.find((m) => m.id === memory.model) : loaded.find((m) => m.default)
    onConfigure({ provider, profileId, model: memory.model, effort: memory.effort ?? defaultEffortFor(target), serviceTier: memory.serviceTier ?? '' })
    setQuery(''); setActiveId(null)
    for (const p of selectable(provider)) ensureUsage(p)
    requestAnimationFrame(() => search.current?.focus({ preventScroll: true }))
  }
  const switchProfile = (profileId: string): void => {
    if (profileId === selection.profileId || remote) return
    onConfigure({ profileId })
    setActiveId(null)
  }
  const efforts = selectedModel?.efforts ?? []
  const fast = selectedModel?.fast ?? null
  const fastOn = !!fast && selection.serviceTier === fast.id
  const fastBlocked = fastOn && !!fastReport && fastReport.state !== 'on'
  const fastStatus = !fastOn ? 'Fast desligado' : fastReport?.state === 'cooldown' ? 'Fast em pausa após atingir o limite'
    : fastBlocked ? `Fast não aplicado: ${FAST_REASONS[fastReport?.reason ?? ''] ?? 'indisponível agora'}` : 'Fast ligado'
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if ((e.target as Element).closest('[role="menu"]')) return
    const digit = /^Digit([0-9])$/.exec(e.code)?.[1]
    if (digit && e.ctrlKey && e.shiftKey && !e.altKey) {
      const target = shortcutProfiles(providerProfiles)[Number(digit) - 1]
      if (target) { e.preventDefault(); switchProfile(target.id) }
      return
    }
    if (digit && e.ctrlKey && !e.shiftKey && !e.altKey) {
      const provider = RAIL[Number(digit) - 1]
      if (provider) { e.preventDefault(); switchProvider(provider) }
      return
    }
    if (digit && e.altKey && !e.ctrlKey && !e.shiftKey) {
      e.preventDefault()
      if (digit === '0') { if (fast) onConfigure({ serviceTier: fastOn ? '' : fast.id }) }
      else { const level = efforts[Number(digit) - 1]; if (level) onConfigure({ effort: level }) }
      return
    }
    const index = rows.findIndex((r) => r.id === effectiveActive)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!rows.length) return
      // Clamped at both ends, as Traycer's harness-model-picker-keyboard.
      const step = e.key === 'ArrowDown' ? 1 : -1
      const next = Math.min(rows.length - 1, Math.max(0, (index === -1 ? (step > 0 ? -1 : rows.length) : index) + step))
      setActiveId(rows[next].id)
    } else if ((e.key === 'Home' || e.key === 'End') && !e.shiftKey && rows.length) {
      e.preventDefault()
      setActiveId(rows[e.key === 'Home' ? 0 : rows.length - 1].id)
    } else if (e.key === 'Enter') {
      if (index >= 0 && (e.target as Element).tagName === 'INPUT') { e.preventDefault(); selectRow(rows[index]) }
    } else if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation()
      if (query.trim()) setQuery(''); else close()
    }
  }

  const label = selectedModel?.label ?? (selection.model || (catalog?.loading ? 'Carregando…' : 'Padrão do agente'))
  const effortLabel = efforts.length ? EFFORT_LABELS[selection.effort] ?? selection.effort : null
  const showDot = providerProfiles.length >= 2 && !!activeProfile
  const tooltip = <div className="tmp-tip">
    <div className="tmp-tip-title">{label}</div>
    <TipRow label="Agente" value={HARNESS_LABEL[selection.provider]} />
    {effortLabel ? <TipRow label="Esforço" value={effortLabel} /> : null}
    {fast ? <TipRow label="Fast" value={fastStatus} /> : null}
    {activeProfile && providerProfiles.length >= 2 ? <TipRow label="Perfil" value={activeProfile.name} /> : null}
    <div className="tmp-tip-shortcut"><span>Atalho</span><Kbd>{SHORTCUT}</Kbd></div>
  </div>
  const summary = [label, effortLabel ? `Raciocínio ${effortLabel}` : null, fastOn ? fastStatus : null, showDot ? activeProfile!.name : null].filter(Boolean).join(', ')

  return <>
    <Tooltip label={tooltip} side="top" open={open ? false : undefined}>
      <ToolbarChip ref={setTrigger} className="tmp-trigger" disabled={disabled} aria-label={summary} aria-haspopup="dialog" aria-expanded={open}
        data-state={open ? 'open' : 'closed'} onClick={() => (open ? close() : openPicker())}>
        {fastOn ? <Zap className={cn('tmp-trigger-zap', fastBlocked && 'blocked')} size={16} strokeWidth={2} aria-hidden="true" /> : null}
        <span className="tmp-trigger-icon">
          {catalog?.loading && !selectedModel ? <Spinner tone="muted" /> : <ProviderIcon provider={selection.provider} size={16} />}
          {showDot ? <AccentDot variant="corner" size="compact" color={profileColor(activeProfile!)} label={activeProfile!.name} /> : null}
        </span>
        <span className="tmp-trigger-label">{label}</span>
        {effortLabel ? <><span className="tmp-trigger-sep" aria-hidden="true">·</span><span className="tmp-trigger-effort">{effortLabel}</span></> : null}
        <ChevronDown className="tmp-trigger-chevron" size={14} />
      </ToolbarChip>
    </Tooltip>
    {open && createPortal(<div ref={setPanel} role="dialog" aria-label="Selecionar modelo" className="tr-popover panel tmp-panel" data-measuring={!placement.ready}
      style={placement.style} onKeyDown={onKeyDown} onBlur={(e) => {
        // Tabbing out of the panel dismisses it (Radix's focus-outside), without stealing focus back.
        const next = e.relatedTarget as Element | null
        if (next && !panel?.contains(next) && !trigger?.contains(next) && !next.closest('[data-tr-keep-open]')) close(false)
      }}>
      <div className="tmp-search">
        <InputGroup variant="search" className="tmp-search-group">
          <input ref={search} value={query} placeholder={`Buscar modelos do ${HARNESS_LABEL[selection.provider]}`} aria-label={`Buscar modelos do ${HARNESS_LABEL[selection.provider]}`}
            aria-controls="tmp-listbox" aria-activedescendant={effectiveActive !== null ? `tmp-row-${effectiveActive}` : undefined}
            onChange={(e) => { setQuery(e.target.value); setActiveId(null) }} />
          <InputAddon><Search /></InputAddon>
        </InputGroup>
      </div>
      <div className="tmp-body">
        <div className="tmp-rail">
          <div role="tablist" aria-label="Provedores de modelos" aria-orientation="vertical" className="tmp-rail-list tr-no-scrollbar">
            {RAIL.map((provider, index) => {
              const list = selectable(provider)
              const dotProfile = list.length >= 2 ? (provider === selection.provider ? activeProfile : list.find((p) => p.id === readPickerMemory().lastProfile[provider])) ?? list[0] : null
              const locked = remote && provider !== 'claude'
              return <Tooltip key={provider} label={locked ? 'O agente não pode ser trocado em conversas SSH' : HARNESS_LABEL[provider]} side="right" sideOffset={6}>
                <button type="button" role="tab" aria-selected={provider === selection.provider} aria-disabled={locked || undefined}
                  aria-label={`${HARNESS_LABEL[provider]} — Ctrl+${index + 1} para trocar`} data-active={provider === selection.provider}
                  className="tmp-rail-btn" tabIndex={locked ? -1 : undefined} onClick={() => { if (!locked) switchProvider(provider) }}>
                  <ProviderIcon provider={provider} size={16} />
                  {dotProfile ? <AccentDot variant="corner" color={profileColor(dotProfile)} label={dotProfile.name} /> : null}
                </button>
              </Tooltip>
            })}
          </div>
          <Tooltip label="Atualizar provedores e modelos" side="top">
            <button type="button" className="tmp-rail-tool" aria-label="Atualizar provedores e modelos" disabled={catalog?.loading}
              onClick={() => { loadCatalog(catalogProvider, catalogProfile, true); for (const p of providerProfiles) ensureUsage(p) }}>
              <RefreshCw size={16} className={cn(catalog?.loading && 'tmp-spin')} />
            </button>
          </Tooltip>
          <Tooltip label="Configurações das CLIs dos provedores" side="top">
            <button type="button" className="tmp-rail-tool" aria-label="Configurações das CLIs dos provedores"
              onClick={() => { close(false); useStore.getState().openSettings('providers') }}><Settings size={16} /></button>
          </Tooltip>
        </div>
        <div ref={setColumn} className="tmp-column">
          {providerProfiles.length >= 2 && !remote ? <div className="tmp-profile-slot">
            <ProfileDropdown providerLabel={HARNESS_LABEL[selection.provider]} profiles={providerProfiles} activeProfileId={selection.profileId}
              onSelectProfile={switchProfile} usage shortcutHintForIndex={profileShortcut} container={column}
              onCloseAutoFocus={() => search.current?.focus({ preventScroll: true })}
              onCreateProfile={() => { close(false); useStore.getState().openSettings('providers') }} />
          </div> : <AuthLine profile={activeProfile ?? providerProfiles[0]} remote={remote} usageStatus={activeProfile ? usage[activeProfile.id]?.status : undefined} />}
          <div ref={listRef} id="tmp-listbox" role="listbox" aria-label={query.trim() ? 'Resultados da busca de modelos' : 'Modelos do provedor'} className="tmp-list">
            <ListState loading={!!catalog?.loading && !models.length} error={catalog?.error && !models.length ? catalog.error : null} empty={!rows.length && !catalog?.loading}
              query={query.trim()} onRetry={() => loadCatalog(catalogProvider, catalogProfile, true)} />
            {rows.map((row) => <div key={row.id || 'default'} className="tmp-row-wrap">
              <ModelRow row={row} selected={row.id === selectedRowId} active={row.id === effectiveActive}
                onHover={() => setActiveId(row.id)} onSelect={() => selectRow(row)} />
            </div>)}
          </div>
          {fast || efforts.length ? <div className="tmp-footer">
            {fast ? <Tooltip label={fastBlocked ? `${fastStatus}. Desligar Fast (Alt+0)` : fastOn ? 'Desligar Fast (Alt+0)' : 'Ligar Fast (Alt+0)'} side="top">
              <button type="button" className="tmp-fast" aria-pressed={fastOn} aria-label={`Modo ${fast.label}`} aria-description={fastBlocked ? fastStatus : undefined} onClick={() => onConfigure({ serviceTier: fastOn ? '' : fast.id })}>
                <Zap size={14} strokeWidth={2} className={cn('tmp-fast-icon', fastOn && 'on', fastBlocked && 'blocked')} /><span className="tr-truncate">{fast.label}</span>
              </button>
            </Tooltip> : null}
            {fast && efforts.length ? <div className="tmp-footer-sep" aria-hidden="true" /> : null}
            {efforts.length ? <fieldset className="tmp-effort" aria-label="Esforço de raciocínio">
              {efforts.length > 1 ? <EffortSlider value={selection.effort} levels={efforts} disabled={disabled} open={open} onChange={(effort) => onConfigure({ effort })} />
                : <button type="button" className="tmp-effort-single" aria-pressed="true">{EFFORT_LABELS[efforts[0]] ?? efforts[0]}</button>}
            </fieldset> : null}
          </div> : null}
        </div>
      </div>
    </div>, document.body)}
  </>
}

function TipRow({ label, value }: { label: string; value: string }) {
  return <div className="tmp-tip-row"><span className="tmp-tip-key">{label}</span><span className="tmp-tip-value">{value}</span></div>
}

function ModelRow({ row, selected, active, onHover, onSelect }: { row: Row; selected: boolean; active: boolean; onHover: () => void; onSelect: () => void }) {
  const capacity = row.model?.contextWindow ? `${row.model.contextWindow >= 1_000_000 ? `${row.model.contextWindow / 1_000_000}M` : `${Math.round(row.model.contextWindow / 1000)}K`}` : null
  return <Tooltip label={row.model?.description || null} side="top" sideOffset={6} delay={700}>
    <button id={`tmp-row-${row.id}`} data-row-id={row.id} type="button" role="option" tabIndex={-1} aria-selected={selected} data-active={active} data-selected={selected}
      className="tmp-row" onMouseEnter={onHover} onFocus={onHover} onClick={onSelect}>
      <span className="tmp-row-label">{row.label}</span>
      {capacity && active ? <span className="tmp-row-capacity">{capacity}</span> : null}
      {selected ? <Check className="tmp-row-check" size={16} /> : <span className="tmp-row-check" />}
    </button>
  </Tooltip>
}

function ListState({ loading, error, empty, query, onRetry }: { loading: boolean; error: string | null; empty: boolean; query: string; onRetry: () => void }): ReactNode {
  if (loading) return <div className="tmp-state"><Spinner tone="muted" /> Carregando modelos…</div>
  if (error) return <div className="tmp-state error"><span>{error}</span><button type="button" className="tmp-state-action" onClick={onRetry}>Tentar novamente</button></div>
  if (empty) return <div className="tmp-state">{query ? `Nenhum modelo corresponde a “${query}”.` : 'Nenhum modelo disponível para esta conta.'}</div>
  return null
}

/** harness-model-picker-auth-line.tsx: the account line when a provider has a single profile. */
function AuthLine({ profile, remote, usageStatus }: { profile?: ProviderProfile; remote: boolean; usageStatus?: { installed: boolean; loggedIn: boolean; detail: string; email?: string } }) {
  if (remote) return <div className="tmp-auth-line"><Badge variant="muted" size="xs" className="tmp-auth-badge">SSH</Badge><span className="tr-truncate">Conta do terminal do servidor</span></div>
  if (!profile || !usageStatus) return null
  if (!usageStatus.installed) return <div className="tmp-auth-line"><span className="tr-truncate">{usageStatus.detail}</span></div>
  if (!usageStatus.loggedIn) return <div className="tmp-auth-line"><span className="tr-truncate">Não autenticado</span></div>
  return <div className="tmp-auth-line">{profile.ambient ? <Badge variant="muted" size="xs" className="tmp-auth-badge">Terminal</Badge> : null}
    <span className="tr-truncate">{usageStatus.email ? `Autenticado como ${usageStatus.email}` : usageStatus.detail}</span></div>
}
