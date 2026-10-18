import { useState, type CSSProperties } from 'react'
import { Link2, Link2Off, TriangleAlert } from 'lucide-react'
import type { ProviderProfile } from '../../../../../shared/agents'
import { useAgentChats } from '../../../lib/agentChats'
import { Badge, Button, Spinner } from '../../ui'
import { SettingsDialog } from '../layout'
import { ipcErrorMessage } from './resetCredits'

// Lives with the other pure login guards (the chat's "Entrar novamente" uses it too).
export { traycerLinkSignInBlock } from '../usage'

const STYLE: Record<'text' | 'row' | 'broken', CSSProperties> = {
  text: { flex: '1 1 auto', minWidth: 0 },
  row: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  broken: { alignItems: 'center', background: 'color-mix(in oklab, var(--tr-destructive) 10%, transparent)', color: 'var(--tr-destructive)' }
}

/**
 * The selected profile's link to its Traycer account: a pending login to
 * adopt (imported, still on its old copy, Traycer's login available), a live
 * link with "Desvincular", or a broken one with its error and "Desvincular".
 * Nothing for the terminal account or a profile on its own Prism login.
 */
export function TraycerLinkNotice({ profile, pendingLink, busy, onLink, onUnlink }: {
  profile: ProviderProfile
  pendingLink: boolean
  busy: boolean
  onLink: () => void
  onUnlink: () => void
}) {
  if (profile.ambient) return null
  if (profile.traycerLink === 'broken') {
    return <div className="stg-callout" style={STYLE.broken} role="alert">
      <TriangleAlert size={14} />
      <span style={STYLE.text}>A conta vinculada ao Traycer está indisponível (desativada ou removida no Traycer). Reative-a no Traycer ou desvincule este perfil.</span>
      <Button size="xs" variant="outline" disabled={busy} onClick={onUnlink}><Link2Off />Desvincular</Button>
    </div>
  }
  if (profile.traycerLink === 'linked') {
    return <div style={STYLE.row}>
      <Badge variant="outline" size="xs" className="stg-summary-badge">Login do Traycer</Badge>
      <span className="stg-usage-note" style={STYLE.text}>Este perfil compartilha o login desta conta com o Traycer.</span>
      <Button size="xs" variant="ghost" disabled={busy} onClick={onUnlink}><Link2Off />Desvincular</Button>
    </div>
  }
  if (!pendingLink) return null
  return <div className="stg-callout warning" style={{ alignItems: 'center' }}>
    <Link2 size={14} />
    <span style={STYLE.text}>Este perfil ainda usa uma cópia antiga do login importado do Traycer. Com o login do Traycer, a cópia antiga deixa de ser usada e o login passa a ser compartilhado com o Traycer.</span>
    <Button size="xs" variant="secondary" disabled={busy} onClick={onLink}>{busy ? <Spinner tone="muted" /> : null}Usar o login do Traycer</Button>
  </div>
}

/** Confirms "Desvincular": the profile drops Traycer's login and needs a Prism sign-in afterwards. */
export function UnlinkTraycerDialog({ profile, onClose, onUnlinked }: { profile: ProviderProfile; onClose: () => void; onUnlinked: () => void }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const confirm = async (): Promise<void> => {
    if (pending) return
    setPending(true); setError('')
    try {
      await window.prism.providers.unlinkTraycer(profile.id)
      await useAgentChats.getState().refreshProfiles()
      onUnlinked()
    } catch (err) { setError(ipcErrorMessage(err)); setPending(false) }
  }
  return <SettingsDialog open onOpenChange={(open) => { if (!open && !pending) onClose() }} locked={pending} title={`Desvincular ${profile.name} do Traycer?`}
    description={`${profile.name} deixa de usar o login do Traycer. Depois será preciso entrar nesta conta pelo Prism para voltar a usá-lo.`}
    footer={<>
      <Button size="sm" variant="ghost" disabled={pending} onClick={onClose}>Cancelar</Button>
      <Button size="sm" variant="destructive" disabled={pending} onClick={() => void confirm()}>{pending ? <Spinner tone="muted" /> : null}Desvincular</Button>
    </>}>
    {error ? <p className="stg-error" role="alert">{error}</p> : null}
  </SettingsDialog>
}
