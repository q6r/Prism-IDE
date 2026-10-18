import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Check, CircleCheck, CircleX, Link2, RefreshCw, Trash2, TriangleAlert } from 'lucide-react'
import type { Provider, ProviderProfile } from '../../../../../shared/agents'
import { useAgentChats } from '../../../lib/agentChats'
import { PROFILE_ACCENT_COLORS } from '../../../lib/profileAccent'
import { useProviderUsage } from '../../../lib/providerUsage'
import { useStore } from '../../../store'
import { Button, cn, Spinner, Switch, Tooltip } from '../../ui'
import { ActionCard, SettingsDialog } from '../layout'
import { duplicateColorProfile, nextAccentColor } from '../usage'
import { LoginTerminal } from './LoginTerminal'

export const PROVIDER_LABELS: Record<Provider, string> = { claude: 'Claude Code', codex: 'Codex' }

/** The whole palette as selectable swatches (providers/accent-color-swatch-grid.tsx). */
export function AccentColorSwatchGrid({ selected, disabled, onSelect }: { selected: string | null; disabled?: boolean; onSelect: (color: string) => void }) {
  const current = selected?.toLowerCase() ?? null
  return <div className="stg-swatches" role="group" aria-label="Cor de destaque">
    {PROFILE_ACCENT_COLORS.map((color) => {
      const on = current === color
      return <button key={color} type="button" aria-label={`Usar a cor ${color}`} aria-pressed={on} disabled={disabled}
        className={cn('stg-swatch-button', on && 'selected')} style={{ ['--swatch' as string]: color } as CSSProperties} onClick={() => onSelect(color)}>
        {on ? <Check size={12} strokeWidth={3} /> : null}
      </button>
    })}
  </div>
}

/** Name + accent color, shared by the add and edit dialogs (providers/provider-profile-card.tsx). */
function ProfileCard({ provider, profile, profiles, name, onNameChange, color, onColorChange, disabled }: {
  provider: Provider
  profile: ProviderProfile | null
  profiles: readonly ProviderProfile[]
  name: string
  onNameChange: (name: string) => void
  color: string | null
  onColorChange: (color: string) => void
  disabled?: boolean
}) {
  const inputId = useId()
  const clash = duplicateColorProfile(profiles, profile, provider, color)
  return <div className="stg-profile-card">
    <label htmlFor={inputId} className="stg-field">
      Nome do perfil
      <input id={inputId} className="tr-input" value={name} maxLength={80} disabled={disabled} placeholder="Pessoal, trabalho…"
        onChange={(e) => onNameChange(e.target.value)} />
    </label>
    <div className="stg-field-block">
      <div className="stg-field-label">Cor de destaque</div>
      <AccentColorSwatchGrid selected={color} disabled={disabled} onSelect={onColorChange} />
      {clash ? <div className="stg-callout warning"><TriangleAlert size={14} />
        <span>{clash.name} já usa esta cor. Você pode mantê-la, mas cores iguais são mais difíceis de distinguir.</span></div> : null}
    </div>
  </div>
}

/**
 * Tombstones a profile in main, then moves the chats still pointing at it to
 * the provider's terminal account so they keep saving and sending.
 */
export async function removeProviderProfile(profile: ProviderProfile): Promise<void> {
  await window.prism.providers.remove(profile.id)
  const state = useAgentChats.getState()
  for (const chat of state.chats) {
    if (chat.selection.profileId === profile.id) state.configure(chat.id, { ...chat.selection, profileId: `ambient-${chat.selection.provider}` })
  }
  await state.refreshProfiles()
}

/** Login phases: the CLI running, the post-exit login check, and its verdict. */
type SignInPhase = 'running' | 'verifying' | 'done' | 'failed'

/** After the CLI exits, ask whether the profile is actually logged in (exit 0 alone is not proof). */
async function verifyLogin(profile: ProviderProfile, code: number | undefined): Promise<boolean> {
  void useAgentChats.getState().refreshProfiles().catch(() => undefined)
  void useProviderUsage.getState().refresh(profile)
  if (code !== 0) return false
  try { return (await window.prism.providers.status(profile.provider, profile.id)).loggedIn } catch { return false }
}

/** One sign-in: the announced status line, then the CLI terminal (never inside the live region). */
function SignInStep({ profile, phase, attempt, onExit }: { profile: ProviderProfile; phase: SignInPhase; attempt: number; onExit: (code: number | undefined) => void }) {
  const copy: Record<SignInPhase, { title: string; guidance: string }> = {
    running: { title: `Entre em ${PROVIDER_LABELS[profile.provider]}`, guidance: 'Use o link exibido para entrar na conta desejada. O login fica separado das outras contas.' },
    verifying: { title: 'Verificando o login', guidance: 'Conferindo se a conta ficou conectada.' },
    done: { title: 'Conta conectada', guidance: `${profile.name} está pronto para novas conversas.` },
    failed: { title: 'O login não foi concluído', guidance: 'O terminal terminou sem conectar a conta. Tente novamente ou cancele.' }
  }
  return <div className="stg-signin">
    <div className="stg-signin-head" role="status" aria-live="polite">
      {phase === 'done' ? <CircleCheck size={16} className="stg-signin-icon ok" />
        : phase === 'failed' ? <CircleX size={16} className="stg-signin-icon failed" />
          : <Spinner tone="muted" />}
      <div className="stg-signin-titles">
        <div className="stg-signin-title">{copy[phase].title}</div>
        <p className="stg-signin-guidance">{copy[phase].guidance}</p>
      </div>
    </div>
    <LoginTerminal key={attempt} profile={profile} onExit={onExit} autoFocus />
  </div>
}

/* ---------------- Add profile (add-provider-profile-dialog.tsx) ---------------- */
/**
 * Name and color first, then "Vincular conta" runs the login. The profile only
 * survives a login that ends connected: cancelling, closing, a failed login or
 * leaving Settings removes the draft, so no "Sem login" orphan is left behind.
 */
export function AddProfileDialog({ provider, profiles, signInBlocked, onClose, onCreated, onSigningInChange }: {
  provider: Provider
  profiles: readonly ProviderProfile[]
  /** Why no login can start (another login open, CLI missing), or null. */
  signInBlocked: string | null
  onClose: () => void
  onCreated: (profile: ProviderProfile) => void
  onSigningInChange: (signingIn: boolean) => void
}) {
  const label = PROVIDER_LABELS[provider]
  const [name, setName] = useState('')
  const [color, setColor] = useState<string>(() => nextAccentColor(profiles, provider))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState<ProviderProfile | null>(null)
  const [phase, setPhase] = useState<SignInPhase>('running')
  const [attempt, setAttempt] = useState(0)
  const trimmed = name.trim()
  // What unmount must clean up: a draft whose login never connected.
  const pendingDraft = useRef<ProviderProfile | null>(null)
  pendingDraft.current = draft && phase !== 'done' ? draft : null
  const signing = useRef(onSigningInChange)
  signing.current = onSigningInChange
  useEffect(() => () => {
    signing.current(false)
    const orphan = pendingDraft.current
    if (orphan) void removeProviderProfile(orphan).catch((err: Error) => useStore.getState().addToast('error', `Não foi possível descartar o perfil ${orphan.name}: ${err.message}`))
  }, [])
  const close = (): void => {
    if (draft && phase === 'done') { void useAgentChats.getState().refreshProfiles().catch(() => undefined); onCreated(draft) }
    onClose()
  }
  const link = async (): Promise<void> => {
    if (!trimmed || busy || signInBlocked) return
    setBusy(true); setError('')
    try {
      const profile = await window.prism.providers.create(provider, trimmed)
      await window.prism.providers.update(profile.id, { color }).catch(() => undefined)
      setPhase('running'); setDraft({ ...profile, color }); onSigningInChange(true)
    } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }
  const onExit = (code: number | undefined): void => {
    if (!draft) return
    setPhase('verifying')
    void verifyLogin(draft, code).then((ok) => { setPhase(ok ? 'done' : 'failed'); if (ok) onSigningInChange(false) })
  }
  const footer: ReactNode = !draft
    ? <Button size="sm" variant="ghost" onClick={close}>Cancelar</Button>
    : phase === 'done' ? <Button size="sm" variant="secondary" onClick={close}>Concluir</Button>
      : phase === 'failed' ? <>
        <Button size="sm" variant="ghost" onClick={close}>Cancelar</Button>
        <Button size="sm" variant="secondary" onClick={() => { setPhase('running'); setAttempt((n) => n + 1) }}>Tentar novamente</Button>
      </> : <Button size="sm" variant="ghost" onClick={close}>Cancelar login</Button>
  return <SettingsDialog open onOpenChange={(open) => { if (!open) close() }} title={`Adicionar novo perfil do ${label}`}
    description={`Dê um nome a este perfil do ${label}, escolha a cor e vincule a conta que ele deve usar.`} footer={footer} wide={!!draft}>
    <ProfileCard provider={provider} profile={draft} profiles={profiles} name={name} onNameChange={setName}
      color={color} onColorChange={setColor} disabled={busy || !!draft} />
    {draft
      ? <div className="stg-dialog-section"><SignInStep profile={draft} phase={phase} attempt={attempt} onExit={onExit} /></div>
      : <Tooltip label={signInBlocked}>
        <span className="stg-block-guard">
          <ActionCard icon={busy ? <Spinner tone="muted" /> : <Link2 size={16} />} title="Vincular conta" description="Entre na conta que este perfil deve usar."
            disabled={!trimmed || busy || !!signInBlocked} onClick={() => void link()} />
        </span>
      </Tooltip>}
    {error ? <p className="stg-error" role="alert">{error}</p> : null}
  </SettingsDialog>
}

/* ---------------- Sign in to an existing profile (provider-profile-reauth-panel.tsx) ---------------- */
export function SignInDialog({ profile, onClose }: { profile: ProviderProfile; onClose: () => void }) {
  const [phase, setPhase] = useState<SignInPhase>('running')
  const [attempt, setAttempt] = useState(0)
  const close = (): void => {
    if (phase === 'running') { void useAgentChats.getState().refreshProfiles().catch(() => undefined); void useProviderUsage.getState().refresh(profile) }
    onClose()
  }
  const footer: ReactNode = phase === 'done' ? <Button size="sm" variant="secondary" onClick={close}>Concluir</Button>
    : phase === 'failed' ? <>
      <Button size="sm" variant="ghost" onClick={close}>Fechar</Button>
      <Button size="sm" variant="secondary" onClick={() => { setPhase('running'); setAttempt((n) => n + 1) }}>Tentar novamente</Button>
    </> : <Button size="sm" variant="ghost" onClick={close}>Encerrar login</Button>
  return <SettingsDialog open onOpenChange={(open) => { if (!open) close() }} title={`Entrar em ${profile.name}`}
    description="Reconecte este perfil sem mudar o nome ou a cor." wide footer={footer}>
    <SignInStep profile={profile} phase={phase} attempt={attempt}
      onExit={(code) => { setPhase('verifying'); void verifyLogin(profile, code).then((ok) => setPhase(ok ? 'done' : 'failed')) }} />
  </SettingsDialog>
}

/* ---------------- Manage profile (provider-profile-edit-dialog.tsx) ---------------- */
export function ManageProfileDialog({ profile, profiles, signInBlocked, eligibilityPending, onSetEnabled, onSwitchAccount, onRemove, onClose }: {
  profile: ProviderProfile
  profiles: readonly ProviderProfile[]
  signInBlocked: string | null
  eligibilityPending: boolean
  /** Resolves to an error message, or null on success. */
  onSetEnabled: (enabled: boolean) => Promise<string | null>
  onSwitchAccount: () => void
  onRemove: () => void
  onClose: () => void
}) {
  const [name, setName] = useState(profile.name)
  const [color, setColor] = useState<string | null>(profile.color ?? null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const trimmed = name.trim()
  const changed = trimmed !== profile.name || (color ?? null) !== (profile.color ?? null)
  const save = async (): Promise<void> => {
    if (saving || !trimmed || !changed) return
    setSaving(true); setError('')
    try {
      const patch: { name?: string; color?: string } = {}
      if (trimmed !== profile.name) patch.name = trimmed
      if (color && color !== profile.color) patch.color = color
      await window.prism.providers.update(profile.id, patch)
      await useAgentChats.getState().refreshProfiles()
      onClose()
    } catch (err) { setError((err as Error).message) } finally { setSaving(false) }
  }
  const enabled = profile.enabled !== false
  return <SettingsDialog open onOpenChange={(open) => { if (!open && !saving) onClose() }} locked={saving} title="Editar perfil"
    description={`Atualize como ${profile.name} aparece e qual conta ele usa.`}
    footer={<div className="stg-dialog-foot-row split">
      <Button size="sm" variant="ghost" className="stg-destructive-ghost" aria-label="Remover perfil" disabled={saving} onClick={onRemove}><Trash2 />Remover perfil</Button>
      <div className="stg-dialog-foot-group">
        <Button size="sm" variant="ghost" disabled={saving} onClick={onClose}>Cancelar</Button>
        <Button size="sm" variant="secondary" disabled={saving || !trimmed || !changed} onClick={() => void save()}>{saving ? <Spinner tone="muted" /> : null}Salvar alterações</Button>
      </div>
    </div>}>
    <ProfileCard provider={profile.provider} profile={profile} profiles={profiles} name={name} onNameChange={setName}
      color={color} onColorChange={setColor} disabled={saving} />
    <div className="stg-toggle-card">
      <div className="stg-toggle-card-text">
        <div className="stg-toggle-card-title">Permitir que agentes usem este perfil</div>
        <div className="stg-toggle-card-desc">{enabled ? 'Ativado' : 'Desativado'}. Perfis desativados continuam visíveis, mas não iniciam novos trabalhos.</div>
      </div>
      <Tooltip label={enabled ? 'Ativado: agentes podem usar este perfil.' : 'Desativado: agentes não podem iniciar trabalhos com este perfil.'} side="left">
        <span className="stg-inline-guard">
          <Switch checked={enabled} disabled={eligibilityPending || saving} aria-label={`Permitir que agentes usem ${profile.name}`}
            onCheckedChange={(next) => { setError(''); void onSetEnabled(next).then((message) => { if (message) setError(message) }) }} />
        </span>
      </Tooltip>
    </div>
    <Tooltip label={signInBlocked}>
      <span className="stg-block-guard">
        <ActionCard icon={<RefreshCw size={16} />} title="Trocar conta" description="Entre com outra conta neste perfil."
          disabled={!!signInBlocked || saving} onClick={onSwitchAccount} />
      </span>
    </Tooltip>
    {error ? <p className="stg-error" role="alert">{error}</p> : null}
  </SettingsDialog>
}

/* ---------------- Remove profile (ConfirmDestructiveDialog) ---------------- */
export function RemoveProfileDialog({ profile, onRemoved, onClose }: { profile: ProviderProfile; onRemoved: () => void; onClose: () => void }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const confirm = async (): Promise<void> => {
    if (pending) return
    setPending(true); setError('')
    try { await removeProviderProfile(profile); onRemoved() } catch (err) { setError((err as Error).message); setPending(false) }
  }
  return <SettingsDialog open onOpenChange={(open) => { if (!open && !pending) onClose() }} locked={pending} title={`Remover ${profile.name}?`}
    description={`As conversas que usavam ${profile.name} passam para a conta do terminal, e o login deste perfil é apagado deste computador. Conversas em andamento neste perfil precisam ser paradas antes.`}
    footer={<>
      <Button size="sm" variant="ghost" disabled={pending} onClick={onClose}>Cancelar</Button>
      <Button size="sm" variant="destructive" disabled={pending} onClick={() => void confirm()}>{pending ? <Spinner tone="muted" /> : null}Remover</Button>
    </>}>
    {error ? <p className="stg-error" role="alert">{error}</p> : <p className="stg-usage-note">Esta ação não pode ser desfeita.</p>}
  </SettingsDialog>
}
