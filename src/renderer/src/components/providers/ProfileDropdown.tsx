import { useEffect, useLayoutEffect, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Plus } from 'lucide-react'
import type { ProviderProfile } from '../../../../shared/agents'
import { AccentDot, Badge, Button, cn, DropdownMenu, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, Kbd, MeterRow, Spinner, Switch, Tooltip } from '../ui'
import { profileAccentColor } from '../../lib/profileAccent'
import { profileStatusSuffix, projectUsage, relativeTime, resetLabel, useProviderUsage, type UsageEntry, type UsageProjection } from '../../lib/providerUsage'
import { useNow } from './useNow'
import '../../styles/composer.css'

export interface ProfileEligibilityControls {
  readonly onSetEnabled: (profileId: string, enabled: boolean) => void
  readonly pending?: (profileId: string) => boolean
  readonly disabledReason?: (profile: ProviderProfile) => string | null
}

export interface ProfileDropdownProps {
  readonly providerLabel: string
  /** Every profile of the provider, ambient first (2+ is the caller's gate in the picker). */
  readonly profiles: readonly ProviderProfile[]
  readonly activeProfileId: string
  readonly onSelectProfile: (profileId: string) => void
  /** `null` hides the "Criar novo perfil" row. */
  readonly onCreateProfile: (() => void) | null
  readonly createProfileDisabledReason?: string | null
  /** Picker only: ⌘⇧-digit hints ("Ctrl+Shift+1"). */
  readonly shortcutHintForIndex?: (index: number) => string | null
  /** Picker only: compact usage bars on the rows and the usage sidecar. */
  readonly usage?: boolean
  /** Settings only: an enable switch per row; disabled rows stay selectable for maintenance. */
  readonly eligibility?: ProfileEligibilityControls | null
  /** Portal target, so a menu opened inside a popover counts as inside it. */
  readonly container?: HTMLElement | null
  readonly onCloseAutoFocus?: () => void
}

export const profileColor = (p: ProviderProfile): string => profileAccentColor(p.id, p.color)

/** Profiles the ⌘⇧-digit shortcuts walk: enabled ones, in list order. */
export const shortcutProfiles = (profiles: readonly ProviderProfile[]): ProviderProfile[] => profiles.filter((p) => p.enabled !== false && !p.tombstoned)

/**
 * Traycer's shared profile switcher (providers/profile-dropdown.tsx): closed =
 * accent dot + name (+ Terminal badge) + chevron; open = one row per profile
 * with status, usage bar, shortcut and check, then "Criar novo perfil".
 */
export default function ProfileDropdown(props: ProfileDropdownProps) {
  const { providerLabel, profiles, activeProfileId, onSelectProfile, onCreateProfile, createProfileDisabledReason, shortcutHintForIndex, usage, eligibility, container, onCloseAutoFocus } = props
  const active = profiles.find((p) => p.id === activeProfileId) ?? profiles[0]
  const [open, setOpen] = useState(false)
  const [previewId, setPreviewId] = useState<string>(active?.id)
  const [previewAnchor, setPreviewAnchor] = useState<HTMLElement | null>(null)
  const entries = useProviderUsage((s) => s.entries)
  const ensure = useProviderUsage((s) => s.ensure)
  const refresh = useProviderUsage((s) => s.refresh)
  useEffect(() => { if (open) for (const p of profiles) ensure(p) }, [open])
  if (!active) return null
  const eligible = shortcutProfiles(profiles)
  const preview = profiles.find((p) => p.id === previewId)
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (!usage || e.key.toLowerCase() !== 'r' || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || !preview) return
    if (preview.enabled === false || entries[preview.id]?.fetching) return
    e.preventDefault()
    void refresh(preview)
  }
  return <div className="trp-dropdown">
    <DropdownMenu open={open} onOpenChange={(next) => { setOpen(next); if (next) setPreviewId(active.id); else setPreviewAnchor(null) }}
      matchTriggerWidth container={container} onCloseAutoFocus={onCloseAutoFocus} onContentKeyDown={onKey} label={`Perfis do ${providerLabel}`}
      trigger={<button type="button" className="trp-trigger" aria-label={`Perfil do ${providerLabel}: ${active.name}${active.ambient ? ', Terminal' : ''}${active.enabled === false ? ', Desativado' : ''}`}>
        <AccentDot variant="inline" color={profileColor(active)} />
        <span className={cn('trp-trigger-label', eligibility && 'with-switch')}>
          <span className="trp-trigger-name">{active.name}</span>
          {active.ambient ? <TerminalBadge /> : null}
          {active.enabled === false ? <span className="tr-muted">Desativado</span> : null}
        </span>
        <ChevronDown className="trp-chevron" size={16} />
      </button>}>
      {profiles.map((profile) => {
        const entry = entries[profile.id]
        const suffix = profileStatusSuffix(profile, entry)
        const shortcutIndex = eligible.indexOf(profile)
        const hint = shortcutIndex >= 0 ? shortcutHintForIndex?.(shortcutIndex) ?? null : null
        const pending = eligibility?.pending?.(profile.id) ?? false
        const blocked = (profile.enabled === false && !eligibility) || pending
        const faded = suffix !== null || profile.enabled === false || pending
        return <div key={profile.id} role="group" aria-label={`Controles do perfil ${profile.name}`} className={cn('trp-row', faded && 'faded')}>
          <DropdownMenuItem className="trp-item" aria-current={profile.id === activeProfileId ? 'true' : undefined}
            aria-keyshortcuts={usage ? 'R' : undefined}
            aria-label={`${profile.name}${profile.ambient ? ', Terminal' : ''}${suffix ? `, ${suffix}` : ''}${profile.enabled === false ? ', Desativado' : ''}`}
            ref={(node) => { if (node && profile.id === previewId && previewAnchor !== node) setPreviewAnchor(node) }}
            onFocus={(e) => { setPreviewId(profile.id); setPreviewAnchor(e.currentTarget) }}
            onPointerMove={(e) => { if (previewId !== profile.id) { setPreviewId(profile.id); setPreviewAnchor(e.currentTarget) } }}
            onSelect={(e) => { if (blocked) { e.preventDefault(); return } onSelectProfile(profile.id) }}>
            <span className="trp-item-content">
              <AccentDot variant="inline" color={profileColor(profile)} />
              <span className="trp-item-name"><span className="tr-truncate">{profile.name}</span>{profile.ambient ? <TerminalBadge /> : null}
                {pending ? <span className="tr-muted">Atualizando</span> : profile.enabled === false ? <span className="tr-muted">Desativado</span> : null}</span>
              {suffix ? <span className="tr-muted trp-suffix">{suffix}</span> : null}
              {usage ? <CompactMeter entry={entry} /> : null}
              {hint && profile.enabled !== false && !pending ? <DropdownMenuShortcut><Kbd variant="mono">{hint}</Kbd></DropdownMenuShortcut> : null}
              <span className="trp-check">{profile.id === activeProfileId ? <Check size={16} /> : null}</span>
            </span>
          </DropdownMenuItem>
          {eligibility ? <EnableSwitch profile={profile} controls={eligibility} pending={pending} /> : null}
        </div>
      })}
      {onCreateProfile ? <>
        <DropdownMenuSeparator />
        <Tooltip label={createProfileDisabledReason || null}>
          <span className="trp-create-guard"><DropdownMenuItem disabled={!!createProfileDisabledReason} onSelect={() => onCreateProfile()}><Plus size={14} />Criar novo perfil</DropdownMenuItem></span>
        </Tooltip>
      </> : null}
    </DropdownMenu>
    {eligibility ? <span className="trp-trigger-switch"><EnableSwitch profile={active} controls={eligibility} pending={eligibility.pending?.(active.id) ?? false} /></span> : null}
    {usage && open && preview ? <UsageSidecar anchor={previewAnchor} profile={preview} entry={entries[preview.id]} onRefresh={() => void refresh(preview)} /> : null}
  </div>
}

export function TerminalBadge() {
  return <Badge variant="muted" size="xs" className="trp-terminal-badge">Terminal</Badge>
}

function EnableSwitch({ profile, controls, pending }: { profile: ProviderProfile; controls: ProfileEligibilityControls; pending: boolean }) {
  const reason = controls.disabledReason?.(profile) ?? null
  const label = reason ?? (profile.enabled === false ? 'Permitir que agentes usem este perfil' : 'Impedir que agentes usem este perfil')
  return <Tooltip label={label} side="right" sideOffset={6}>
    <span className="trp-switch-guard">
      <Switch aria-label={`Permitir que agentes usem ${profile.name}`} checked={profile.enabled !== false} disabled={pending} aria-disabled={reason !== null || undefined}
        onCheckedChange={(next) => { if (reason === null) controls.onSetEnabled(profile.id, next) }} />
    </span>
  </Tooltip>
}

/** profile-usage-compact-meter.tsx: the most constrained window only; empty track when unknown. */
export function CompactMeter({ entry }: { entry?: UsageEntry }) {
  const now = useNow(60_000)
  const projection = projectUsage(entry, now)
  const hasDetail = projection.kind === 'detail' || projection.kind === 'stale'
  return <span aria-hidden="true" data-usage-kind={projection.kind} className={cn('trp-meter', (projection.kind === 'stale' || projection.kind === 'unavailable') && 'dim')}>
    {hasDetail ? <span className={cn('trp-meter-fill', `tr-sev-${projection.severity}`)} style={{ width: `${Math.min(100, Math.max(0, projection.compact.usedPercent))}%` }} /> : null}
  </span>
}

const SIDECAR_GAP = 8, VIEWPORT_PADDING = 12

/** profile-usage-sidecar.tsx: the hovered row's usage beside the open menu. */
function UsageSidecar({ anchor, profile, entry, onRefresh }: { anchor: HTMLElement | null; profile: ProviderProfile; entry?: UsageEntry; onRefresh: () => void }) {
  const [node, setNode] = useState<HTMLElement | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const now = useNow(30_000)
  useLayoutEffect(() => {
    if (!anchor || !node) return
    const update = (): void => {
      const menu = anchor.closest('[role="menu"]') as HTMLElement | null
      const a = (menu ?? anchor).getBoundingClientRect(), row = anchor.getBoundingClientRect()
      const width = node.offsetWidth, height = node.offsetHeight
      let left = a.right + SIDECAR_GAP
      if (left + width > window.innerWidth - VIEWPORT_PADDING) left = Math.max(VIEWPORT_PADDING, a.left - SIDECAR_GAP - width)
      const top = Math.max(VIEWPORT_PADDING, Math.min(row.top - 4, window.innerHeight - VIEWPORT_PADDING - height))
      setPos((p) => p && p.left === Math.round(left) && p.top === Math.round(top) ? p : { left: Math.round(left), top: Math.round(top) })
    }
    // Wait one frame so the menu's own placement has landed before measuring.
    const frame = requestAnimationFrame(update)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    const observer = new ResizeObserver(update)
    observer.observe(anchor); observer.observe(node)
    return () => { cancelAnimationFrame(frame); window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); observer.disconnect() }
  }, [anchor, node, entry])
  const projection = projectUsage(entry, now)
  const refreshing = !!entry?.fetching
  const retry = projection.kind !== 'not_checked' && 'failed' in projection && projection.failed
  const refreshLabel = retry ? 'Tentar novamente' : 'Atualizar'
  return createPortal(<aside ref={setNode} data-tr-keep-open="" aria-label={`Detalhes de uso de ${profile.name}`} aria-live="off"
    className="trp-sidecar" style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden', pointerEvents: 'none' }}>
    <div className="trp-sidecar-head">
      <AccentDot variant="inline" color={profileColor(profile)} className="trp-sidecar-dot" />
      <div className="trp-sidecar-title">
        <div className="trp-sidecar-name">{profile.name}</div>
        <div className="trp-sidecar-fresh"><span>{freshness(projection, now)}</span>{refreshing ? <><span aria-hidden="true">·</span><span>Atualizando</span></> : null}</div>
      </div>
      {profile.enabled !== false ? <Button variant="ghost" size="xs" aria-label={`${refreshLabel} uso de ${profile.name}`} aria-keyshortcuts="R" disabled={refreshing}
        onPointerDown={(e) => e.preventDefault()} onClick={onRefresh}>
        {refreshing ? <Spinner tone="muted" /> : null}{refreshLabel}<Kbd variant="mono" className="trp-sidecar-kbd">R</Kbd>
      </Button> : null}
    </div>
    <div className="trp-sidecar-body"><UsageDetail projection={projection} now={now} /></div>
  </aside>, document.body)
}

function freshness(projection: UsageProjection, now: number): string {
  if (projection.checkedAt === null) return 'Não verificado'
  return `${projection.kind === 'stale' ? 'Última verificação' : 'Verificado'} ${relativeTime(projection.checkedAt, now)}`
}

export function UsageDetail({ projection, now }: { projection: UsageProjection; now: number }): ReactNode {
  if (projection.kind === 'not_checked') return <EmptyState title="Ainda não verificado" body="Atualize para carregar o uso detalhado deste perfil." />
  if (projection.kind === 'unavailable') return <EmptyState title={projection.failed ? 'Não foi possível atualizar o uso' : 'Uso indisponível'}
    body={projection.message && !projection.failed ? projection.message : 'Nenhum uso detalhado disponível. Tente novamente quando o provedor estiver acessível.'} />
  return <>
    {projection.kind === 'stale' ? <p className="trp-stale-note">{projection.failed ? 'Falha ao atualizar. Exibindo o último uso conhecido.' : 'Exibindo o último uso conhecido.'}</p> : null}
    <div className={cn('trp-windows', projection.kind === 'stale' && 'stale')}>
      {projection.windows.map((w) => {
        const reset = resetLabel(w.resetsAt, now)
        return <MeterRow key={w.id} label={w.label} usedPercent={w.usedPercent} severity={w.severity}
          detail={<span className="trp-window-detail"><span>{Math.round(Math.min(100, Math.max(0, w.usedPercent)))}% usado</span>{reset ? <><span aria-hidden="true">·</span><span>{reset}</span></> : null}</span>} />
      })}
    </div>
  </>
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return <div className="trp-empty"><div className="trp-empty-title">{title}</div><p>{body}</p></div>
}
