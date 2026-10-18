import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { Button, cn } from '../ui'

const layers: HTMLDivElement[] = []
let rootWasInert = false

/** Modal plate using Traycer's banded Dialog recipe and focus lifecycle. */
export default function Dialog({ open = true, onClose, title, description, children, footer, className, hideHeader, closeButton = true, busy = false }: {
  open?: boolean; onClose: () => void; title: ReactNode; description?: ReactNode; children: ReactNode; footer?: ReactNode; className?: string; hideHeader?: boolean; closeButton?: boolean; busy?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const busyRef = useRef(busy)
  busyRef.current = busy
  const id = useId()
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    const root = document.getElementById('root')
    const layer = ref.current
    if (!layers.length) rootWasInert = root?.inert ?? false
    if (layer) layers.push(layer)
    if (root) root.inert = true
    const frame = requestAnimationFrame(() => {
      const target = ref.current?.querySelector<HTMLElement>('[data-autofocus]') ?? ref.current?.querySelector<HTMLElement>('input:not(:disabled)') ?? ref.current?.querySelector<HTMLElement>('button:not(:disabled)')
      ;(target ?? ref.current)?.focus()
    })
    const handleKey = (event: KeyboardEvent): void => {
      if (layers.at(-1) !== layer) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); if (!busyRef.current) closeRef.current(); return }
      if (event.key !== 'Tab') return
      const elements = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]') ?? []).filter((el) => el.tabIndex >= 0 && el.getClientRects().length > 0)
      if (!elements.length) { event.preventDefault(); ref.current?.focus(); return }
      if (!elements.includes(document.activeElement as HTMLElement)) { event.preventDefault(); elements[0].focus() }
      else if (event.shiftKey && document.activeElement === elements[0]) { event.preventDefault(); elements.at(-1)?.focus() }
      else if (!event.shiftKey && document.activeElement === elements.at(-1)) { event.preventDefault(); elements[0].focus() }
    }
    document.addEventListener('keydown', handleKey, true)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('keydown', handleKey, true)
      if (layer) { const index = layers.indexOf(layer); if (index >= 0) layers.splice(index, 1) }
      if (root) root.inert = layers.length > 0 || rootWasInert
      if (previous?.isConnected && (!layers.length || layers.at(-1)?.contains(previous))) previous.focus({ preventScroll: true })
    }
  }, [open])
  if (!open) return null
  return createPortal(<div className="ps-shell-modal-overlay" onPointerDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <div ref={ref} tabIndex={-1} className={cn('ps-shell-dialog', className)} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={description ? `${id}-description` : undefined}>
      <div className={hideHeader ? 'tr-sr-only' : 'ps-shell-modal-header'}><div><h2 id={`${id}-title`}>{title}</h2>{description && <p id={`${id}-description`}>{description}</p>}</div>
        {!hideHeader && closeButton && <Button variant="ghost" size="icon-sm" aria-label="Fechar" disabled={busy} onClick={onClose}><X size={16} /></Button>}
      </div>
      {children}
      {footer && <div className="ps-shell-modal-footer">{footer}</div>}
    </div>
  </div>, document.body)
}
