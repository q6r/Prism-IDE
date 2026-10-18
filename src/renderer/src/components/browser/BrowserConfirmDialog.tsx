import { AlertTriangle } from 'lucide-react'
import { Button, Spinner } from '../ui'
import Dialog from '../shell/Dialog'

/**
 * Traycer's ConfirmDestructiveDialog (banded layout: warning glyph, title and
 * description, then a tinted footer with Cancel and the destructive action),
 * on the app's shared modal so it traps Tab, makes the app inert behind it and
 * returns focus to whatever opened it. Cancel takes the initial focus.
 */
export function BrowserConfirmDialog(props: {
  open: boolean
  title: string
  description: string
  actionLabel: string
  pending?: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}) {
  const { open, pending = false, onOpenChange } = props
  return (
    <Dialog
      open={open}
      onClose={() => onOpenChange(false)}
      title={props.title}
      description={props.description}
      hideHeader
      busy={pending}
      className="brw-confirm"
      footer={
        <>
          <Button data-autofocus variant="ghost" size="sm" disabled={pending} onClick={() => onOpenChange(false)} data-testid="confirm-cancel">
            Cancelar
          </Button>
          <Button variant="destructive" size="sm" disabled={pending} onClick={props.onConfirm} data-testid="confirm-action">
            {pending ? <Spinner /> : null}
            {props.actionLabel}
          </Button>
        </>
      }
    >
      {/* The accessible name and description come from the dialog's own (visually hidden) header. */}
      <div className="brw-dialog-body" aria-hidden data-testid="confirm-destructive-dialog">
        <div className="brw-dialog-glyph"><AlertTriangle /></div>
        <div className="brw-dialog-text">
          <div className="brw-dialog-title">{props.title}</div>
          <p className="brw-dialog-description">{props.description}</p>
        </div>
      </div>
    </Dialog>
  )
}
