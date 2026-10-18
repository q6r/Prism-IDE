import { useState } from 'react'
import { Server, KeyRound, Lock, FileKey } from 'lucide-react'
import { useStore } from '../store'
import { Button, SegmentedControl, Spinner, Switch } from './ui'
import Dialog from './shell/Dialog'
import { sshPort } from './shell/logic'
import '../styles/shell.css'

type Host = Awaited<ReturnType<Window['prism']['ssh']['hosts']['list']>>[number]

/** Saves a host; the host list owns connecting and prompting for passwords. */
export default function ConnectDialog({ initial, onClose }: { initial?: Host | null; onClose: () => void }) {
  const addToast = useStore((s) => s.addToast)
  const [name, setName] = useState(initial?.name ?? '')
  const [host, setHost] = useState(initial?.host ?? '')
  const [port, setPort] = useState(String(initial?.port ?? 22))
  const [username, setUsername] = useState(initial?.username ?? '')
  const [authType, setAuthType] = useState<'password' | 'key'>(initial?.authType ?? 'password')
  const [password, setPassword] = useState('')
  const [keyPath, setKeyPath] = useState(initial?.keyPath ?? '')
  const [rememberPw, setRememberPw] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const pickKey = async (): Promise<void> => { const path = await window.prism.dialog.openFile(); if (path) setKeyPath(path) }
  const save = async (): Promise<void> => {
    if (busy) return
    if (!host.trim() || !username.trim()) { setError('Informe host e usuário.'); return }
    const parsedPort = sshPort(port)
    if (parsedPort === null) { setError('Informe uma porta entre 1 e 65535.'); return }
    setError(''); setBusy(true)
    try {
      const list = await window.prism.ssh.hosts.save({ id: initial?.id, name: name.trim() || `${username.trim()}@${host.trim()}`, host: host.trim(), port: parsedPort, username: username.trim(), authType, keyPath: authType === 'key' ? keyPath : undefined })
      const saved = list.find((item) => item.host === host.trim() && item.username === username.trim() && item.port === parsedPort)
      if (saved && authType === 'password' && password) await window.prism.ssh.hosts.setSecret(saved.id, rememberPw ? password : null)
      addToast('success', 'Host salvo'); onClose()
    } catch (err) { setError((err as Error).message || 'Não foi possível salvar o host.') }
    finally { setBusy(false) }
  }
  return <Dialog onClose={onClose} busy={busy} title={<><Server size={16} />{initial ? 'Editar host' : 'Salvar host SSH'}</>} className="ps-shell-connect-dialog" footer={
    <><Button variant="outline" size="sm" disabled={busy} onClick={onClose}>Cancelar</Button><Button size="sm" disabled={busy} onClick={save}>{busy && <Spinner />}Salvar host</Button></>
  }>
    <form className="ps-shell-connect-body" onSubmit={(event) => { event.preventDefault(); void save() }}>
      <label className="ps-shell-field"><span>Nome <small>(opcional)</small></span><input className="ps-shell-input" value={name} onChange={(event) => setName(event.target.value)} placeholder="Meu servidor" /></label>
      <div className="ps-shell-field-row"><label className="ps-shell-field ps-shell-grow"><span>Host</span><input className="ps-shell-input" value={host} onChange={(event) => setHost(event.target.value)} placeholder="exemplo.com ou IP" /></label><label className="ps-shell-field ps-shell-port"><span>Porta</span><input className="ps-shell-input" inputMode="numeric" value={port} onChange={(event) => setPort(event.target.value)} /></label></div>
      <label className="ps-shell-field"><span>Usuário</span><input className="ps-shell-input" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="root" /></label>
      <div className="ps-shell-field"><span>Autenticação</span><SegmentedControl value={authType} onChange={setAuthType} ariaLabel="Autenticação SSH" options={[{ value: 'password', label: <><Lock size={13} />Senha</> }, { value: 'key', label: <><FileKey size={13} />Chave privada</> }]} /></div>
      {authType === 'password' ? <>
        <label className="ps-shell-field"><span><KeyRound size={12} />Senha <small>(opcional)</small></span><input type="password" className="ps-shell-input" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Deixe vazio para digitar na conexão" /></label>
        {password.trim() && <div className="ps-shell-field-toggle"><span>Lembrar senha (local)</span><Switch aria-label="Lembrar senha localmente" checked={rememberPw} onCheckedChange={setRememberPw} /></div>}
      </> : <label className="ps-shell-field"><span>Arquivo da chave</span><div className="ps-shell-field-row"><input className="ps-shell-input ps-shell-grow" value={keyPath} onChange={(event) => setKeyPath(event.target.value)} placeholder="~/.ssh/id_ed25519" /><Button variant="outline" size="sm" onClick={pickKey}>Procurar</Button></div></label>}
      {error && <div className="ps-shell-error" role="alert">{error}</div>}
      <button type="submit" className="tr-sr-only" tabIndex={-1}>Salvar host</button>
    </form>
  </Dialog>
}
