import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Button, Spinner } from '../ui'
import type { GitFile } from './git-model'

export default function ConfirmDiscardDialog({ file, remote, busy, onCancel, onConfirm }: { file: GitFile; remote: boolean; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const id = useId()
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const node = dialog.current!
    node.showModal()
    return () => { node.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [])
  const trash = file.untracked && !remote
  return createPortal(<dialog ref={dialog} className="pg-confirm" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} onCancel={(event) => { event.preventDefault(); if (!busy) onCancel() }}>
    <div className="pg-confirm-header"><h2 id={`${id}-title`}>{trash ? 'Mover arquivo para a lixeira?' : 'Descartar alterações?'}</h2><p id={`${id}-description`}>{trash ? <>O arquivo <strong>{file.path}</strong> será movido para a lixeira.</> : file.untracked ? <>O arquivo <strong>{file.path}</strong> será excluído permanentemente do servidor. Essa ação não pode ser desfeita.</> : <>As alterações locais de <strong>{file.path}</strong> serão descartadas. Essa ação não pode ser desfeita.</>}</p></div>
    <div className="pg-confirm-footer"><Button variant="muted" size="sm" autoFocus disabled={busy} onClick={onCancel}>Cancelar</Button><Button variant="destructive" size="sm" disabled={busy} onClick={onConfirm}>{busy && <Spinner />}{trash ? 'Mover para a lixeira' : 'Descartar'}</Button></div>
  </dialog>, document.body)
}
