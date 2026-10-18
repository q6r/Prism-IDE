import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { Copy, Check, ExternalLink, Smartphone, Power, Trash2, MessageSquare } from 'lucide-react'
import { useStore } from '../store'
import { Button, Spinner, Tooltip } from './ui'
import Dialog from './shell/Dialog'
import '../styles/shell.css'
import { useAgentChats } from '../lib/agentChats'
import { pushRemoteSnapshot, remoteOnHost } from '../lib/remoteControl'
import { remoteTitle } from '../lib/remoteControlModel'
import { MAX_REMOTE_CHATS, remoteLink } from '../../../shared/remoteLink'

// The desktop-side connection panel for /remote-control: shows a QR + link that
// opens the mobile controller for the active chat, lists every shared chat, and
// lets the user stop sharing one chat or tear the whole tunnel down.
export default function RemoteControlModal(): React.JSX.Element | null {
  const open = useStore((s) => s.rcModalOpen)
  const info = useStore((s) => s.rcInfo)
  const activeTab = useStore((s) => s.rcActiveTab)
  const chats = useStore((s) => s.rcChats)
  const close = useStore((s) => s.closeRcModal)
  const stopAll = useStore((s) => s.stopRemoteControl)
  const disableOne = useStore((s) => s.disableRemoteControl)
  const available = useAgentChats(s => s.chats)
  const theme = useStore(s => s.settings.theme)
  const addToast = useStore((s) => s.addToast)

  const [selected, setSelected] = useState<string[]>([])
  const [linked, setLinked] = useState<string[]>([])
  const [sharing, setSharing] = useState(false)
  const [qrError, setQrError] = useState(false)
  const [qr, setQr] = useState<string>('')
  const [copied, setCopied] = useState(false)
  const [clients, setClients] = useState(0)
  const [stopping, setStopping] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(copyTimer.current), [])

  useEffect(() => {
    if (open && activeTab) { setSelected([activeTab]); setLinked([activeTab]) }
  }, [open])
  const linkedChats = chats.filter(c => linked.includes(c.tabId))
  const link = info ? remoteLink(info.baseUrl, linkedChats, activeTab ?? undefined) : ''
  const deepLink = link ? `${link}&theme=${encodeURIComponent(theme)}` : ''
  const candidates = available.filter(c => !c.archived && !c.readOnly)
  const createLink = async (): Promise<void> => {
    if (!selected.length || sharing) return
    setSharing(true)
    try {
      for (const id of selected) {
        const chat = useAgentChats.getState().chats.find(c => c.id === id)
        if (!chat) throw new Error('Uma conversa selecionada não está mais disponível.')
        if (useStore.getState().rcEnabledTabs.includes(id)) continue
        const title = remoteTitle(chat)
        const result = await window.prism.remoteControl.enable({ tabId: id, title })
        if (!result.ok || !result.baseUrl || !result.token) throw new Error(result.error || 'Não foi possível compartilhar a conversa.')
        useStore.getState().enableRemoteControl(id, title, { baseUrl: result.baseUrl, token: result.token })
        if (!remoteOnHost()) pushRemoteSnapshot(id, true)
      }
      setLinked([...selected])
      addToast('success', `${selected.length} conversa${selected.length === 1 ? '' : 's'} no mesmo link. Escaneie o QR atualizado.`)
    } catch (err) { addToast('error', (err as Error).message) }
    finally { setSharing(false) }
  }

  useEffect(() => {
    setQr('')
    setQrError(false)
    setCopied(false)
    let alive = true
    if (!deepLink) {
      setQr('')
      return
    }
    QRCode.toDataURL(deepLink, {
      width: 260,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#0b0c16', light: '#ffffff' }
    })
      .then((value) => { if (alive) setQr(value) })
      .catch(() => { if (alive) { setQr(''); setQrError(true) } })
    return () => { alive = false }
  }, [deepLink])

  // Live count of connected phones.
  useEffect(() => {
    if (!open) return
    let alive = true
    window.prism.remoteControl.status().then((s) => alive && setClients(s.clients)).catch(() => alive && setClients(0))
    const off = window.prism.remoteControl.onClients(({ count }) => setClients(count))
    return () => {
      alive = false
      off()
    }
  }, [open])

  if (!open || !info) return null

  const activeTitle = chats.find((c) => c.tabId === activeTab)?.title || 'este chat'

  const copy = (): void => {
    navigator.clipboard.writeText(deepLink).then(
      () => {
        setCopied(true)
        clearTimeout(copyTimer.current)
        copyTimer.current = setTimeout(() => setCopied(false), 1600)
      },
      () => addToast('error', 'Não consegui copiar')
    )
  }

  return (
    <Dialog onClose={close} className="ps-shell-remote-control-dialog" title={<><Smartphone size={17} />Controle remoto</>}>
        <div className="ps-shell-control-body">
          <div className="ps-shell-control-qr-side">
            {qr ? (
              <img className="ps-shell-control-qr" src={qr} alt="QR code" />
            ) : (
              <div className="ps-shell-control-qr ps-shell-control-qr-empty">{qrError ? <span>Copie o link abaixo para abrir no celular.</span> : <Spinner label="Gerando QR code" />}</div>
            )}
            <div className="ps-shell-control-scan">
              Escaneie para abrir <b>{linkedChats.length > 1 ? `${linkedChats.length} conversas na mesma tela` : activeTitle}</b>
            </div>
            <div className="ps-shell-control-link">
              <input aria-label="Link de controle remoto" readOnly value={deepLink} onFocus={(e) => e.currentTarget.select()} />
              <Tooltip label={copied ? 'Copiado' : 'Copiar link'}><Button data-autofocus variant="ghost" size="icon-sm" onClick={copy} aria-label="Copiar link">
                {copied ? <Check size={15} /> : <Copy size={15} />}
              </Button></Tooltip>
              <Tooltip label="Abrir no navegador"><Button variant="ghost" size="icon-sm" onClick={() => window.prism.app.openExternal(deepLink)} aria-label="Abrir no navegador">
                <ExternalLink size={15} />
              </Button></Tooltip>
            </div>
            <div className={'ps-shell-control-status' + (clients > 0 ? ' on' : '')}>
              <span className="ps-shell-control-dot" />
              {clients > 0
                ? `${clients} dispositivo${clients === 1 ? '' : 's'} conectado${clients === 1 ? '' : 's'}`
                : 'Aguardando o celular conectar…'}
            </div>
          </div>

          <div className="ps-shell-control-list-side">
            <div className="ps-shell-control-list-label">Conversas neste link</div>
            <div className="ps-shell-control-list">
              {candidates.map(c => <div key={c.id} className={'ps-shell-control-chat' + (selected.includes(c.id) ? ' active' : '')}>
                <label className="ps-shell-control-chat-select"><input type="checkbox" checked={selected.includes(c.id)} disabled={sharing || (!selected.includes(c.id) && selected.length >= MAX_REMOTE_CHATS)}
                  onChange={e => setSelected(previous => e.target.checked ? [...previous, c.id] : previous.filter(id => id !== c.id))} />
                  <MessageSquare size={14} /><span className="ps-shell-control-chat-nm">{remoteTitle(c)}</span></label>
                {chats.some(shared => shared.tabId === c.id) ? <Button variant="ghost" size="icon-xs" className="ps-shell-control-chat-x" aria-label={`Parar de compartilhar ${remoteTitle(c)}`} disabled={sharing}
                  onClick={() => { disableOne(c.id); setSelected(previous => previous.filter(id => id !== c.id)); setLinked(previous => previous.filter(id => id !== c.id)) }}><Trash2 size={13} /></Button> : null}
              </div>)}
              {!candidates.length ? <div className="ps-shell-control-empty">Nenhuma conversa disponível.</div> : null}
            </div>
            <Button variant="default" size="sm" disabled={sharing || !selected.length} onClick={() => void createLink()}>{sharing ? <Spinner /> : <Smartphone size={15} />} {sharing ? 'Compartilhando…' : 'Atualizar QR com as selecionadas'}</Button>
            <div className="ps-shell-control-note">No celular, toque no menu de conversas para alternar entre os chats sem abrir outra guia. Ao mudar as selecionadas, escaneie o QR atualizado.</div>
            <div className="ps-shell-control-note">
              Quem tiver o link controla as conversas selecionadas (aceitar/negar, mandar comando, parar). O link já
              traz um token secreto — não compartilhe.
            </div>
            <Button variant="destructive" size="sm" className="ps-shell-control-stop" disabled={stopping} onClick={async () => { setStopping(true); try { await stopAll() } catch (err) { addToast('error', (err as Error).message || 'Não foi possível parar o controle remoto.') } finally { setStopping(false) } }}>
              {stopping ? <Spinner /> : <Power size={15} />} Parar controle remoto
            </Button>
          </div>
        </div>
    </Dialog>
  )
}
