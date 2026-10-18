import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Download, ExternalLink, Eye, EyeOff, LogIn, Plus, Search, Settings2, TriangleAlert, X } from 'lucide-react'
import type { Provider, ProviderProfile } from '../../../../../shared/agents'
import { planLabel } from '../../../../../shared/providerUsage'
import { useAgentChats } from '../../../lib/agentChats'
import { relativeTime, useProviderUsage, type UsageEntry } from '../../../lib/providerUsage'
import { useStore } from '../../../store'
import ProfileDropdown from '../../providers/ProfileDropdown'
import { useNow } from '../../providers/useNow'
import ProviderIcon from '../../ProviderIcon'
import { Badge, Button, InputAddon, InputGroup, LineTabs, Spinner, Tooltip } from '../../ui'
import { COPY, normalizeSearchText, sectionMeta } from '../definitions'
import { railRowClass, RefreshIconButton, SettingsDetailHeader, SettingsMasterDetail, SettingsMasterSelect, SettingsPanelShell } from '../layout'
import { useRevealArea } from '../reveal'
import { cliVersionWarning, latestCheckedAt, PROFILE_AUTH_TEXT, profileAuthState, providerProfiles, redactEmail, signInBlockedReason } from '../usage'
import { AddProfileDialog, ManageProfileDialog, PROVIDER_LABELS, RemoveProfileDialog, SignInDialog } from './ProfileDialogs'
import { ipcErrorMessage } from './resetCredits'
import { TraycerLinkNotice, traycerLinkSignInBlock, UnlinkTraycerDialog } from './TraycerLink'
import { UsageLimitsBody } from './UsageLimits'

const META = sectionMeta('providers')
const PROVIDERS: readonly Provider[] = ['claude', 'codex']
const POLL_MS = 60_000

const PROVIDER_DESCRIPTIONS: Record<Provider, string> = {
  claude: 'CLI Claude Code da Anthropic.',
  codex: 'CLI Codex da OpenAI.'
}
const INSTALL_URLS: Record<Provider, string> = {
  claude: 'https://code.claude.com/docs/en/setup',
  codex: 'https://developers.openai.com/codex/cli'
}

type ProviderTab = 'usage' | 'cli'
/** Wire-style ids, display labels (provider-settings-tabs.ts: `usage` shows as "Profiles & Limits"). */
const TAB_LABELS: Record<ProviderTab, string> = { usage: 'Perfis e limites', cli: 'CLI' }
const TABS: readonly ProviderTab[] = ['usage', 'cli']
const tabForAnchor = (anchor: string): ProviderTab | null => anchor === 'providers-cli' ? 'cli' : anchor.startsWith('providers-') ? 'usage' : null

type Dialog =
  | { readonly kind: 'add'; readonly provider: Provider }
  | { readonly kind: 'manage'; readonly profileId: string }
  | { readonly kind: 'signin'; readonly profileId: string }
  | { readonly kind: 'remove'; readonly profileId: string }
  | { readonly kind: 'unlink'; readonly profileId: string }

/** Profiles whose Traycer login waits for the user's consent, and the action that adopts it. */
interface TraycerLinks {
  readonly pending: ReadonlySet<string>
  readonly onLink: (profile: ProviderProfile) => void
}

/**
 * Settings ▸ Provedores (providers-settings-panel.tsx): a provider rail, the
 * provider's header, a line-tab bar and the "Perfis e limites" body with the
 * shared ProfileDropdown, the selected profile's summary and its usage limits.
 * Usage and login state come from the shared cache (lib/providerUsage), polled
 * every minute while this page is open.
 */
export function ProvidersSettingsPanel() {
  const profiles = useAgentChats((s) => s.profiles)
  const entries = useProviderUsage((s) => s.entries)
  const listed = useMemo(() => profiles.filter((p) => !p.tombstoned), [profiles])
  const latest = useRef(listed)
  latest.current = listed
  // Automatic, non-forced checks on open and every minute (the old AccountsModal poll).
  useEffect(() => {
    const ensureAll = (): void => { for (const p of latest.current) useProviderUsage.getState().ensure(p) }
    ensureAll()
    const timer = setInterval(ensureAll, POLL_MS)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => { for (const p of listed) useProviderUsage.getState().ensure(p) }, [listed])
  const checking = listed.some((p) => entries[p.id]?.fetching)
  const refreshAll = async (): Promise<void> => {
    await useAgentChats.getState().refreshProfiles().catch(() => undefined)
    await Promise.all(useAgentChats.getState().profiles.filter((p) => !p.tombstoned).map((p) => useProviderUsage.getState().refresh(p)))
  }
  return <SettingsPanelShell title={META.label} description={META.description} fillHeight
    headerAction={<ProvidersGlobalStatus checking={checking} checkedAt={latestCheckedAt(listed.map((p) => entries[p.id]?.checkedAt))} onRefresh={refreshAll} />}>
    <ProvidersRail profiles={listed} entries={entries} />
  </SettingsPanelShell>
}

/** "Todos os provedores · Verificado há 2 min" plus Refresh, in the panel heading row. */
function ProvidersGlobalStatus({ checking, checkedAt, onRefresh }: { checking: boolean; checkedAt: number | null; onRefresh: () => Promise<void> }) {
  const now = useNow(30_000)
  return <div className="stg-global-status" data-testid="providers-global-status">
    <span className="stg-global-label">Todos os provedores</span>
    {checking
      ? <span className="stg-global-checked"><Spinner tone="muted" /> Verificando provedores</span>
      : checkedAt !== null ? <span className="stg-global-checked">Verificado {relativeTime(checkedAt, now)}</span> : null}
    <RefreshIconButton onRefresh={onRefresh} label="Atualizar todos os provedores" refreshing={checking} />
  </div>
}

function ProvidersRail({ profiles, entries }: { profiles: readonly ProviderProfile[]; entries: Record<string, UsageEntry> }) {
  const [active, setActive] = useState<Provider>('claude')
  const [tab, setTab] = useState<ProviderTab>('usage')
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<Partial<Record<Provider, string>>>({})
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [signingIn, setSigningIn] = useState(false)
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState('')
  useRevealArea('providers', tabForAnchor, setTab)
  const visible = PROVIDERS.filter((p) => !filter.trim() || normalizeSearchText(PROVIDER_LABELS[p]).includes(normalizeSearchText(filter)))
  /** Resolves to the error message (also shown on the card), or null. */
  const setEnabled = async (profileId: string, enabled: boolean): Promise<string | null> => {
    setPending((s) => new Set(s).add(profileId)); setError('')
    try {
      await window.prism.providers.update(profileId, { enabled })
      await useAgentChats.getState().refreshProfiles()
      const fresh = useAgentChats.getState().profiles.find((p) => p.id === profileId)
      if (fresh && enabled) void useProviderUsage.getState().refresh(fresh)
      return null
    } catch (err) { const message = (err as Error).message; setError(message); return message } finally {
      setPending((s) => { const next = new Set(s); next.delete(profileId); return next })
    }
  }
  const [pendingLinks, setPendingLinks] = useState<ReadonlySet<string>>(new Set())
  const loadLinks = useCallback(async (): Promise<void> => {
    try { setPendingLinks(new Set((await window.prism.providers.traycerLinks()).map((l) => l.id))) } catch { setPendingLinks(new Set()) }
  }, [])
  // Re-read whenever the list changes (an import, a link, a removal).
  useEffect(() => { void loadLinks() }, [loadLinks, profiles])
  /** Fresh status and usage for a profile whose login source just changed. */
  const afterLinkChange = async (profileId: string): Promise<void> => {
    await useAgentChats.getState().refreshProfiles().catch(() => undefined)
    await loadLinks()
    const fresh = useAgentChats.getState().profiles.find((p) => p.id === profileId)
    if (fresh) void useProviderUsage.getState().refresh(fresh)
  }
  /** The click is the consent: the old copy stops being used and the login is shared with Traycer. */
  const linkTraycer = async (profile: ProviderProfile): Promise<void> => {
    setPending((s) => new Set(s).add(profile.id)); setError('')
    try {
      await window.prism.providers.linkTraycer(profile.id)
      await afterLinkChange(profile.id)
    } catch (err) { setError(ipcErrorMessage(err)) } finally {
      setPending((s) => { const next = new Set(s); next.delete(profile.id); return next })
    }
  }
  const links: TraycerLinks = { pending: pendingLinks, onLink: (p) => void linkTraycer(p) }
  const loginOpen = signingIn || dialog?.kind === 'signin'
  // The terminal account's probe answers for the provider's CLI: logins need it installed.
  const cliMissing = (provider: Provider, action = 'entrar'): string | null =>
    entries[`ambient-${provider}`]?.status?.installed === false ? `Instale o ${PROVIDER_LABELS[provider]} para ${action}.` : null
  return <SettingsMasterDetail railLabel="Provedores"
    mobileSelect={<SettingsMasterSelect label="Provedor" value={active} onSelect={setActive}
      options={PROVIDERS.map((p) => ({ value: p, label: PROVIDER_LABELS[p], icon: <ProviderIcon provider={p} size={16} /> }))} />}
    rail={<>
      <div className="stg-rail-controls">
        <InputGroup className="stg-rail-filter">
          <InputAddon align="start"><Search size={14} aria-hidden="true" /></InputAddon>
          <input type="text" value={filter} placeholder="Filtrar provedores" aria-label="Filtrar provedores" spellCheck={false}
            onChange={(e) => setFilter(e.target.value)} />
          {filter ? <InputAddon align="end"><button type="button" className="stg-search-clear" aria-label="Limpar filtro" onClick={() => setFilter('')}><X size={14} /></button></InputAddon> : null}
        </InputGroup>
      </div>
      <div className="stg-md-list scroll">
        {visible.length === 0 ? <p className="stg-rail-empty">Nenhum provedor corresponde.</p>
          : <ul aria-label="Provedores" className="stg-provider-list">
            {visible.map((p) => <li key={p}>
              <button type="button" aria-label={PROVIDER_LABELS[p]} data-active={p === active} aria-current={p === active ? 'true' : undefined}
                className={railRowClass(p === active)} onClick={() => setActive(p)}>
                <ProviderIcon provider={p} size={16} />
                <span className="stg-rail-row-label">{PROVIDER_LABELS[p]}</span>
              </button>
            </li>)}
          </ul>}
      </div>
    </>}>
    <ProviderDetail key={active} provider={active} profiles={profiles} entries={entries} tab={tab} onTab={setTab}
      selectedId={selected[active]} onSelect={(id) => setSelected((s) => ({ ...s, [active]: id }))}
      pending={pending} error={error} loginOpen={loginOpen} cliMissing={cliMissing(active)} onSetEnabled={(id, on) => void setEnabled(id, on)}
      links={links} onDialog={setDialog} />
    {dialog?.kind === 'add' ? <AddProfileDialog provider={dialog.provider} profiles={profiles}
      signInBlocked={cliMissing(dialog.provider, 'vincular uma conta')} onSigningInChange={setSigningIn}
      onCreated={(p) => setSelected((s) => ({ ...s, [p.provider]: p.id }))} onClose={() => setDialog(null)} /> : null}
    {dialog?.kind === 'manage' ? <ManageDialogHost profileId={dialog.profileId} profiles={profiles} pending={pending.has(dialog.profileId)}
      cliMissing={cliMissing(active)} onSetEnabled={(on) => setEnabled(dialog.profileId, on)}
      onSwitchAccount={() => setDialog({ kind: 'signin', profileId: dialog.profileId })}
      onRemove={() => setDialog({ kind: 'remove', profileId: dialog.profileId })} onClose={() => setDialog(null)} /> : null}
    {dialog?.kind === 'signin' ? (() => {
      const profile = profiles.find((p) => p.id === dialog.profileId)
      return profile ? <SignInDialog profile={profile} onClose={() => setDialog(null)} /> : null
    })() : null}
    {dialog?.kind === 'remove' ? (() => {
      const profile = profiles.find((p) => p.id === dialog.profileId)
      if (!profile) return null
      return <RemoveProfileDialog profile={profile} onClose={() => setDialog({ kind: 'manage', profileId: profile.id })}
        onRemoved={() => {
          // The dropdown falls back to the provider's first remaining profile (the terminal account).
          setSelected((s) => ({ ...s, [profile.provider]: `ambient-${profile.provider}` }))
          setDialog(null)
        }} />
    })() : null}
    {dialog?.kind === 'unlink' ? (() => {
      const profile = profiles.find((p) => p.id === dialog.profileId)
      return profile ? <UnlinkTraycerDialog profile={profile} onClose={() => setDialog(null)}
        onUnlinked={() => { setDialog(null); void afterLinkChange(profile.id) }} /> : null
    })() : null}
  </SettingsMasterDetail>
}

function ManageDialogHost({ profileId, profiles, pending, cliMissing, onSetEnabled, onSwitchAccount, onRemove, onClose }: {
  profileId: string
  profiles: readonly ProviderProfile[]
  pending: boolean
  cliMissing: string | null
  onSetEnabled: (enabled: boolean) => Promise<string | null>
  onSwitchAccount: () => void
  onRemove: () => void
  onClose: () => void
}) {
  const busy = useProfileBusy(profileId)
  const profile = profiles.find((p) => p.id === profileId)
  if (!profile) return null
  return <ManageProfileDialog profile={profile} profiles={profiles}
    signInBlocked={traycerLinkSignInBlock(profile) ?? signInBlockedReason(profile, { loginOpen: false, busy, cliMissing })}
    eligibilityPending={pending} onSetEnabled={onSetEnabled} onSwitchAccount={onSwitchAccount} onRemove={onRemove} onClose={onClose} />
}

/** Whether a conversation on `profileId` is running right now (a login would swap its account mid-turn). */
function useProfileBusy(profileId: string | undefined): boolean {
  return useAgentChats((s) => !!profileId && s.chats.some((c) => c.selection.profileId === profileId && !!s.runtime[c.id]?.busy))
}


function ProviderDetail({ provider, profiles, entries, tab, onTab, selectedId, onSelect, pending, error, loginOpen, cliMissing, onSetEnabled, links, onDialog }: {
  provider: Provider
  profiles: readonly ProviderProfile[]
  entries: Record<string, UsageEntry>
  tab: ProviderTab
  onTab: (tab: ProviderTab) => void
  selectedId: string | undefined
  onSelect: (id: string) => void
  pending: ReadonlySet<string>
  error: string
  loginOpen: boolean
  /** Why logins cannot start because the CLI is not installed, or null. */
  cliMissing: string | null
  onSetEnabled: (id: string, enabled: boolean) => void
  links: TraycerLinks
  onDialog: (dialog: Dialog) => void
}) {
  const own = providerProfiles(profiles, provider)
  const ambient = own.find((p) => p.ambient)
  const versionWarning = useCliVersionWarning(provider)
  return <div className="stg-provider-detail">
    <SettingsDetailHeader title={PROVIDER_LABELS[provider]} description={PROVIDER_DESCRIPTIONS[provider]}
      badge={cliMissing ? <Badge variant="warning" size="xs">CLI não encontrado</Badge> : null} />
    {versionWarning ? <div className="stg-callout warning" role="status" data-settings-anchor="providers-cli-version">
      <TriangleAlert size={14} aria-hidden /><span>{versionWarning}</span>
    </div> : null}
    <div className="stg-provider-tabs">
      <LineTabs ariaLabel={`Seções de ${PROVIDER_LABELS[provider]}`} value={tab} onChange={onTab} className="stg-line-tabs"
        tabs={TABS.map((t) => ({ value: t, label: TAB_LABELS[t] }))} />
      <div role="tabpanel" aria-label={TAB_LABELS[tab]} className="stg-provider-tab-body">
        {tab === 'usage'
          ? <ProfilesSection provider={provider} profiles={own} entries={entries} selectedId={selectedId} onSelect={onSelect}
            pending={pending} error={error} loginOpen={loginOpen} cliMissing={cliMissing} onSetEnabled={onSetEnabled} links={links} onDialog={onDialog} />
          : <CliSection provider={provider} ambient={ambient} entry={ambient ? entries[ambient.id] : undefined} />}
      </div>
    </div>
  </div>
}

/** The host's warning when the installed Claude Code is not a version Prism verified, or null. */
function useCliVersionWarning(provider: Provider): string | null {
  const [warning, setWarning] = useState<string | null>(null)
  useEffect(() => {
    if (provider !== 'claude') return
    let alive = true
    window.prism.providers.available(provider).then((a) => { if (alive) setWarning(cliVersionWarning(a)) }, () => undefined)
    return () => { alive = false }
  }, [provider])
  return warning
}

/** "Perfis" card (provider-profile-scoped-section.tsx): dropdown, summary, actions and usage limits. */
function ProfilesSection({ provider, profiles, entries, selectedId, onSelect, pending, error, loginOpen, cliMissing, onSetEnabled, links, onDialog }: {
  provider: Provider
  profiles: readonly ProviderProfile[]
  entries: Record<string, UsageEntry>
  selectedId: string | undefined
  onSelect: (id: string) => void
  pending: ReadonlySet<string>
  error: string
  loginOpen: boolean
  cliMissing: string | null
  onSetEnabled: (id: string, enabled: boolean) => void
  links: TraycerLinks
  onDialog: (dialog: Dialog) => void
}) {
  const now = useNow(30_000)
  const selected = profiles.find((p) => p.id === selectedId) ?? profiles[0]
  const busy = useProfileBusy(selected?.id)
  const addBlocked = loginOpen ? 'Conclua o login em andamento primeiro.'
    : cliMissing ? `Instale o ${PROVIDER_LABELS[provider]} para adicionar um perfil.` : null
  if (!selected) {
    return <section className="stg-profiles" data-settings-anchor="providers-profiles">
      <div className="stg-profiles-head"><div className="stg-card-title">{COPY.providers.profiles.label}</div>
        <div className="stg-profiles-actions"><AddProfileButton blocked={addBlocked} onClick={() => onDialog({ kind: 'add', provider })} /></div>
      </div>
      <p className="stg-usage-note">Nenhum perfil neste dispositivo.</p>
    </section>
  }
  const entry = entries[selected.id]
  const signInBlocked = traycerLinkSignInBlock(selected) ?? signInBlockedReason(selected, { loginOpen, busy, cliMissing })
  const auth = profileAuthState(entry?.status, !!entry?.fetching)
  const manageHeld = selected.ambient ? 'A conta do terminal é gerenciada pelo terminal.' : null
  return <section className="stg-profiles-wrap">
    <div className="stg-profiles" data-settings-anchor="providers-profiles">
      <div className="stg-profiles-head">
        <div className="stg-card-title">{COPY.providers.profiles.label}</div>
        <div className="stg-profiles-actions" data-settings-anchor="providers-add-profile">
          <Button size="sm" variant="ghost" data-settings-anchor="providers-import" onClick={openTraycerImport}><Download />Importar do Traycer</Button>
          <AddProfileButton blocked={addBlocked} onClick={() => onDialog({ kind: 'add', provider })} />
          <RefreshIconButton label="Atualizar status e limites do perfil" refreshing={!!entry?.fetching}
            disabledReason={selected.enabled === false ? 'Perfil desativado.' : null}
            onRefresh={async () => {
              await useAgentChats.getState().refreshProfiles().catch(() => undefined)
              await useProviderUsage.getState().refresh(selected)
            }} />
        </div>
      </div>
      <ProfileDropdown providerLabel={PROVIDER_LABELS[provider]} profiles={profiles} activeProfileId={selected.id} onSelectProfile={onSelect}
        onCreateProfile={() => onDialog({ kind: 'add', provider })} createProfileDisabledReason={addBlocked}
        eligibility={{
          onSetEnabled: onSetEnabled,
          pending: (id) => pending.has(id),
          disabledReason: (p) => p.ambient ? 'A conta do terminal é gerenciada pelo terminal.' : null
        }} />
      <div className="stg-profile-summary-row" data-slot="profile-summary-actions">
        <ProfileSummary key={selected.id} profile={selected} entry={entry} authText={PROFILE_AUTH_TEXT[auth]} />
        {/* A Traycer link (live or broken) signs in through Traycer; the notice below offers "Desvincular". */}
        {!selected.ambient && !selected.traycerLink && selected.enabled !== false && auth !== 'signed-in' && auth !== 'checking'
          ? <Tooltip label={signInBlocked}>
            <span className="stg-inline-guard"><Button size="xs" variant="secondary" disabled={!!signInBlocked} onClick={() => onDialog({ kind: 'signin', profileId: selected.id })}><LogIn />Entrar</Button></span>
          </Tooltip> : null}
        <Tooltip label={manageHeld ?? 'Altere o nome e a cor do perfil, entre novamente ou desative-o.'} side="bottom" align="end">
          <span className="stg-inline-guard"><Button size="xs" variant="outline" disabled={!!manageHeld} onClick={() => onDialog({ kind: 'manage', profileId: selected.id })}><Settings2 />Gerenciar perfil</Button></span>
        </Tooltip>
      </div>
      <TraycerLinkNotice profile={selected} pendingLink={links.pending.has(selected.id)} busy={pending.has(selected.id) || busy}
        onLink={() => links.onLink(selected)} onUnlink={() => onDialog({ kind: 'unlink', profileId: selected.id })} />
      {error ? <p className="stg-error" role="alert">{error}</p> : null}
      <div className="stg-usage" data-settings-anchor="providers-usage">
        <div className="stg-card-title">{COPY.providers.usage.label}</div>
        <UsageLimitsBody profile={selected} entry={entry} now={now} />
      </div>
    </div>
    <p className="stg-poll-note">Os limites são consultados a cada minuto enquanto esta página está aberta.</p>
  </section>
}

function AddProfileButton({ blocked, onClick }: { blocked: string | null; onClick: () => void }) {
  return <Tooltip label={blocked} side="top" align="start">
    <span className="stg-inline-guard"><Button size="sm" disabled={!!blocked} onClick={onClick}><Plus />Adicionar perfil</Button></span>
  </Tooltip>
}

/** Email (redacted until revealed), login badge and plan badge. */
function ProfileSummary({ profile, entry, authText }: { profile: ProviderProfile; entry: UsageEntry | undefined; authText: string }) {
  const [revealed, setRevealed] = useState(false)
  const email = entry?.details?.email || entry?.status?.email || null
  // Traycer's identity tier ("Assinatura Claude Max 20x"); a login status alone only knows the raw token.
  const plan = entry?.details?.plan || planLabel(profile.provider, entry?.details?.tier || entry?.status?.tier) || null
  const text = email ? (revealed ? email : redactEmail(email)) : entry?.status?.detail || (entry?.fetching ? 'Verificando…' : 'E-mail indisponível')
  return <div className="stg-profile-summary">
    <div className="stg-profile-email">
      <Tooltip label={revealed ? email : null} align="start"><span className="tr-truncate">{text}</span></Tooltip>
      {email ? <button type="button" className="stg-reveal" aria-pressed={revealed}
        aria-label={revealed ? `Ocultar e-mail de ${profile.name}` : `Mostrar e-mail de ${profile.name}`} onClick={() => setRevealed(!revealed)}>
        {revealed ? <EyeOff size={12} /> : <Eye size={12} />}
      </button> : null}
    </div>
    <Badge variant="outline" size="xs" className="stg-summary-badge">{authText}</Badge>
    {plan ? <Tooltip label={plan} align="end"><Badge variant="outline" size="xs" className="stg-summary-badge plan"><span className="tr-truncate">{plan}</span></Badge></Tooltip> : null}
  </div>
}

/** The provider's CLI (the "CLI & Args" tab, reduced to what Prism knows: installed or not). */
function CliSection({ provider, ambient, entry }: { provider: Provider; ambient: ProviderProfile | undefined; entry: UsageEntry | undefined }) {
  const status = entry?.status
  const state = !status ? (entry?.fetching ? 'Verificando' : 'Não verificado') : status.installed ? 'Instalado' : 'Não encontrado'
  return <section className="stg-profiles" data-settings-anchor="providers-cli">
    <div className="stg-profiles-head">
      <div className="stg-card-title">CLI do {PROVIDER_LABELS[provider]}</div>
      <Badge variant={status?.installed ? 'success' : status ? 'warning' : 'muted'} size="xs">{state}</Badge>
    </div>
    <p className="stg-usage-note">{status?.installed
      ? `O Prism executa o ${PROVIDER_LABELS[provider]} instalado neste computador. Cada perfil usa um login separado.`
      : `Instale o ${PROVIDER_LABELS[provider]} para conectar perfis e iniciar conversas.`}
      {status && !status.installed && status.detail ? ` ${status.detail}` : ''}</p>
    <div className="stg-cli-actions">
      <Button size="sm" variant="outline" onClick={() => window.prism.app.openExternal(INSTALL_URLS[provider])}><ExternalLink />Instalar {PROVIDER_LABELS[provider]}</Button>
      {ambient ? <RefreshIconButton label="Verificar instalação novamente" refreshing={!!entry?.fetching}
        onRefresh={() => useProviderUsage.getState().refresh(ambient)} /> : null}
    </div>
  </section>
}

/** Imports live in the agents workspace: close Settings and make sure it is on screen first. */
function openTraycerImport(): void {
  const s = useStore.getState()
  s.setSettingsOpen(false)
  if (s.workspaceView !== 'agents' && !(s.workspaceView === 'editor' && s.chatOpen)) s.setWorkspaceView('agents')
  s.setTraycerImportOpen(true)
}
