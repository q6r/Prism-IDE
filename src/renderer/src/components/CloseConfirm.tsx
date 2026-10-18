import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { useStore } from '../store'
import { basename } from '../lib/lang'
import { Button, Spinner } from './ui'
import Dialog from './shell/Dialog'
import { saveBeforeClose } from './shell/logic'
import '../styles/shell.css'

export default function CloseConfirm() {
  const pending = useStore((s) => s.pendingClose)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { setError('') }, [pending])
  const save = async (): Promise<void> => {
    if (!pending || busy) return
    setError('')
    setBusy(true)
    try {
      await saveBeforeClose(pending, {
        save: (path) => useStore.getState().saveTab(path),
        isSaved: (path) => { const tab = useStore.getState().tabs.find((item) => item.path === path); return !tab || tab.content === tab.savedContent },
        close: (path) => { const s = useStore.getState(); s.closeTab(path); if (s.pendingClose === path) s.cancelClose() }
      })
    }
    catch (err) { setError((err as Error).message || 'Não foi possível salvar o arquivo.') }
    finally { setBusy(false) }
  }
  return <Dialog open={!!pending} busy={busy} onClose={() => useStore.getState().cancelClose()} closeButton={false} hideHeader title={`Salvar alterações em ${pending ? basename(pending) : 'arquivo'}?`} className="ps-shell-confirm-dialog" footer={
    <><Button variant="destructive" size="sm" disabled={busy} onClick={() => useStore.getState().confirmCloseDiscard()}>Não salvar</Button><Button variant="outline" size="sm" data-autofocus disabled={busy} onClick={() => useStore.getState().cancelClose()}>Cancelar</Button><Button size="sm" disabled={busy} onClick={save}>{busy && <Spinner />}Salvar</Button></>
  }>
    <div className="ps-shell-confirm-body"><span className="ps-shell-confirm-icon"><AlertTriangle size={16} /></span><div><h3>Salvar alterações em {pending ? basename(pending) : 'arquivo'}?</h3><p>Suas alterações serão perdidas se você não salvá-las.</p>{error && <div className="ps-shell-error" role="alert">{error}</div>}</div></div>
  </Dialog>
}
