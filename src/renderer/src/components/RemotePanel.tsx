import { useEffect, useRef, useState } from 'react'
import { Server, Plus, Plug, PlugZap, Trash2, Pencil, KeyRound } from 'lucide-react'
import { useStore } from '../store'
import ConnectDialog from './ConnectDialog'
import { Button, Spinner, Tooltip } from './ui'
import PanelHeader from './shell/PanelHeader'
import Dialog from './shell/Dialog'
import '../styles/shell.css'

type Host = Awaited<ReturnType<Window['prism']['ssh']['hosts']['list']>>[number]

export default function RemotePanel() {
  const remote = useStore((s) => s.remote)
  const connectRemote = useStore((s) => s.connectRemote)
  const disconnectRemote = useStore((s) => s.disconnectRemote)
  const addToast = useStore((s) => s.addToast)
  const [hosts, setHosts] = useState<Host[]>([])
  const [dialog, setDialog] = useState<{ open: boolean; initial?: Host | null }>({ open: false })
  const [connectingId, setConnectingId] = useState<string | null>(null)
  // Lightweight "ask password every time" prompt for hosts without a saved one.
  const [pwHost, setPwHost] = useState<Host | null>(null)
  const [pw, setPw] = useState('')
  const [pwBusy, setPwBusy] = useState(false)
  const [pwErr, setPwErr] = useState('')
  const connecting = useRef(false)

  const pendingReconnect = useStore((s) => s.pendingRemoteConnect)
  const consumeReconnect = useStore((s) => s.consumeReconnect)

  const loadHosts = (): void => {
    window.prism.ssh.hosts.list().then(setHosts).catch((err: Error) => addToast('error', `Não foi possível carregar os hosts: ${err.message}`))
  }
  useEffect(loadHosts, [])

  // Reconnect requested from the welcome screen / "Open recent". Reuse the saved
  // host if it still exists; otherwise synthesize one from the recent entry.
  useEffect(() => {
    if (!pendingReconnect || remote) {
      if (pendingReconnect && remote) consumeReconnect()
      return
    }
    const r = pendingReconnect
    const saved = hosts.find((h) => h.id === r.hostId)
    const host: Host = saved ?? {
      id: r.hostId ?? `recent:${r.host}`,
      name: r.name,
      host: r.host,
      port: r.port,
      username: r.username,
      authType: r.authType,
      keyPath: r.keyPath
    }
    consumeReconnect()
    quickConnect(host)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingReconnect, hosts, remote])

  const doConnect = async (h: Host, password?: string): Promise<{ ok: boolean; error?: string }> => {
    return connectRemote({
      hostId: h.id,
      name: h.name,
      host: h.host,
      port: h.port,
      username: h.username,
      authType: h.authType,
      keyPath: h.keyPath,
      password
    })
  }

  const quickConnect = async (h: Host): Promise<void> => {
    if (connecting.current) return
    connecting.current = true
    setConnectingId(h.id)
    try {
      // Key auth, or a remembered password => connect directly; otherwise ask.
      let password: string | undefined
      if (h.authType === 'password') {
        const saved = await window.prism.ssh.hosts.getSecret(h.id)
        if (!saved) { setPw(''); setPwErr(''); setPwHost(h); return }
        password = saved
      }
      const res = await doConnect(h, password)
      if (!res.ok) {
        addToast('error', res.error || 'Falha ao conectar')
        if (h.authType === 'key') setDialog({ open: true, initial: h })
      }
    } catch (err) { addToast('error', (err as Error).message || 'Falha ao conectar') }
    finally {
      setConnectingId(null)
      connecting.current = false
    }
  }

  const submitPw = async (): Promise<void> => {
    if (!pwHost || pwBusy) return
    setPwBusy(true)
    setPwErr('')
    try {
      const res = await doConnect(pwHost, pw)
      if (res.ok) { setPwHost(null); setPw('') }
      else setPwErr(res.error || 'Falha ao conectar')
    } catch (err) { setPwErr((err as Error).message || 'Falha ao conectar') }
    finally { setPwBusy(false) }
  }

  const del = async (e: React.MouseEvent, h: Host): Promise<void> => {
    e.stopPropagation()
    await window.prism.ssh.hosts.delete(h.id)
    loadHosts()
  }
  const edit = (e: React.MouseEvent, h: Host): void => {
    e.stopPropagation()
    setDialog({ open: true, initial: h })
  }

  return (
    <div className="ps-shell-panel ps-shell-remote-panel">
      <PanelHeader title={<><Server size={14} />Remoto · SSH</>}><Tooltip label="Nova conexão"><Button variant="muted" size="icon-xs" aria-label="Nova conexão" onClick={() => setDialog({ open: true, initial: null })}><Plus size={15} /></Button></Tooltip></PanelHeader>

      {remote && (
        <div className="ps-shell-remote-connected">
          <div className="ps-shell-rc-dot" />
          <div className="ps-shell-rc-info">
            <div className="ps-shell-rc-name">{remote.name}</div>
            <div className="ps-shell-rc-host">{remote.host}</div>
          </div>
          <Button variant="muted" size="icon-xs" className="ps-shell-rc-disconnect" aria-label="Desconectar" title="Desconectar" onClick={disconnectRemote}>
            <PlugZap size={14} />
          </Button>
        </div>
      )}

      <div className="ps-shell-remote-list">
        <Button variant="outline" size="sm" className="ps-shell-remote-new" onClick={() => setDialog({ open: true, initial: null })}>
          <Plus size={14} /> Nova conexão
        </Button>

        {hosts.length === 0 && <div className="ps-shell-remote-empty">Nenhum host salvo ainda.</div>}

        {hosts.map((h) => (
          <div
            key={h.id}
            className={'ps-shell-host-item' + (remote?.host === h.host ? ' on' : '')}
            title={`${h.username}@${h.host}:${h.port}`}
          >
            <button type="button" className="ps-shell-host-connect" disabled={connectingId !== null || pwBusy} onClick={() => quickConnect(h)}>
            {connectingId === h.id ? (
              <Spinner label="Conectando" />
            ) : (
              <Plug size={13} />
            )}
            <div className="ps-shell-host-info">
              <span className="ps-shell-host-name">{h.name}</span>
              <span className="ps-shell-host-sub">
                {h.username}@{h.host}
              </span>
            </div>
            </button>
            <span className="ps-shell-host-actions">
              <Button variant="muted" size="icon-xs" aria-label={`Editar ${h.name}`} title="Editar" onClick={(e) => edit(e, h)}>
                <Pencil size={12} />
              </Button>
              <Button variant="muted" size="icon-xs" aria-label={`Remover ${h.name}`} title="Remover" onClick={(e) => del(e, h)}>
                <Trash2 size={12} />
              </Button>
            </span>
          </div>
        ))}
      </div>

      {dialog.open && (
        <ConnectDialog
          initial={dialog.initial}
          onClose={() => {
            setDialog({ open: false })
            loadHosts()
          }}
        />
      )}

      {pwHost && (
        <Dialog busy={pwBusy} onClose={() => { setPwHost(null); setPw('') }} title={<><KeyRound size={15} />Senha — {pwHost.name}</>} footer={<><Button variant="outline" size="sm" disabled={pwBusy} onClick={() => setPwHost(null)}>Cancelar</Button><Button size="sm" onClick={submitPw} disabled={pwBusy}>{pwBusy ? <><Spinner />Conectando…</> : 'Conectar'}</Button></>}>
            <div className="ps-shell-pw-body">
              <div className="ps-shell-pw-sub">
                {pwHost.username}@{pwHost.host}:{pwHost.port}
              </div>
              <input
                type="password"
                aria-label="Senha SSH"
                className="ps-shell-input"
                placeholder="Senha"
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submitPw()}
              />
              {pwErr && <div className="ps-shell-error">{pwErr}</div>}
            </div>
        </Dialog>
      )}
    </div>
  )
}
