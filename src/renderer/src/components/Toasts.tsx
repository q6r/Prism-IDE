import { X, OctagonX, CircleCheck, Info } from 'lucide-react'
import { createPortal } from 'react-dom'
import { useStore } from '../store'
import '../styles/shell.css'

export default function Toasts() {
  const toasts = useStore((s) => s.toasts)
  const remove = useStore((s) => s.removeToast)
  if (!toasts.length) return null
  return createPortal(<section className="ps-shell-toaster" aria-label="Notificações"><ol>
    {toasts.map((toast) => <li key={toast.id} role={toast.kind === 'error' ? 'alert' : 'status'} aria-atomic="true" className={`ps-shell-toast is-${toast.kind}`}>
      {toast.kind === 'error' ? <OctagonX size={18} /> : toast.kind === 'success' ? <CircleCheck size={18} /> : <Info size={18} />}
      <span>{toast.message}</span><button type="button" className="ps-shell-toast-close" aria-label="Fechar notificação" onClick={() => remove(toast.id)}><X size={12} /></button>
    </li>)}
  </ol></section>, document.body)
}
