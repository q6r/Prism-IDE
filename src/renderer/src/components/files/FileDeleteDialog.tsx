import { AlertTriangle } from 'lucide-react'
import Dialog from '../shell/Dialog'
import { Button, Spinner } from '../ui'
import type { FileTreeEntry } from './fileTreeModel'

export function FileDeleteDialog({ entry, remote, busy, onCancel, onConfirm }: {
  entry: FileTreeEntry; remote: boolean; busy: boolean; onCancel: () => void; onConfirm: () => void
}) {
  const title = remote ? `Excluir “${entry.name}”?` : `Mover “${entry.name}” para a lixeira?`
  const description = remote
      ? 'Este item será excluído permanentemente do servidor. Esta ação não pode ser desfeita.'
      : 'Você poderá restaurar este item pela lixeira do sistema.'
  return <Dialog title={title} description={description} hideHeader
    busy={busy} onClose={onCancel} closeButton={false} className="pr-files-delete-dialog"
    footer={<>
      <Button variant="outline" size="sm" disabled={busy} data-autofocus onClick={onCancel}>Cancelar</Button>
      <Button variant="destructive" size="sm" disabled={busy} onClick={onConfirm}>
        {busy && <Spinner />}{remote ? 'Excluir permanentemente' : 'Mover para a lixeira'}
      </Button>
    </>}>
    <div className="pr-files-delete-body">
      <span className="pr-files-delete-icon" aria-hidden="true"><AlertTriangle size={16} /></span>
      <div className="pr-files-delete-copy">
        <h2 className="pr-files-delete-title" aria-hidden="true">{title}</h2>
        <p aria-hidden="true">{description}</p>
        {entry.isDir && <p>Todos os arquivos e subpastas também serão {remote ? 'excluídos' : 'movidos para a lixeira'}.</p>}
        <p className="pr-files-delete-path">{entry.path}</p>
      </div>
    </div>
  </Dialog>
}
