import { useEffect, useRef, type ComponentProps, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Search, TriangleAlert, X, type LucideIcon } from 'lucide-react'
import { Button, DropdownMenu, InputAddon, InputGroup, Spinner, Tooltip, cn, useMenuContext } from '../ui'
import { useMinuteClock } from './clock'
import { formatCompactRelativeTime } from './model'

/**
 * Right-click menu at the pointer (Radix ContextMenu): the kit's DropdownMenu
 * anchored to a zero-size point, so it shares its keyboard, focus and
 * dismissal rules. Focus goes back to `returnFocus` when it closes.
 */
export function PointMenu({ point, onClose, label, returnFocus, children }: {
  point: { x: number; y: number } | null
  onClose: () => void
  label: string
  returnFocus?: HTMLElement | null
  children: ReactNode
}) {
  if (!point) return null
  return <DropdownMenu open label={label} side="bottom" align="start" sideOffset={2} className="al-menu"
    onOpenChange={(open) => { if (!open) onClose() }}
    onCloseAutoFocus={() => returnFocus?.isConnected && returnFocus.focus({ preventScroll: true })}
    trigger={<span aria-hidden="true" className="al-point-anchor" style={{ left: point.x, top: point.y }} />}>
    {children}
  </DropdownMenu>
}

/**
 * A kit Button wearing a label tooltip. Usable as a DropdownMenu trigger: the
 * menu's cloned ref and handlers reach the button itself.
 */
export function TipButton({ tip, tipSide, ...rest }: ComponentProps<typeof Button> & { tip: string; tipSide?: 'top' | 'bottom' | 'left' | 'right' }) {
  return <Tooltip label={tip} side={tipSide}><Button {...rest} /></Tooltip>
}

/** Moves focus back onto the menu surface when its content is swapped (a drill-in view). */
export function MenuFocusOnChange({ token }: { token: string }) {
  const menu = useMenuContext()
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    menu?.content?.focus({ preventScroll: true })
  }, [token])
  return null
}

/**
 * The search field every panel search renders (PanelSearchField): leading
 * magnifier, trailing clear, an `esc` affordance while it is a mode.
 */
export function PanelSearchField({ value, onValueChange, onClose, placeholder, label, inputRef, autoFocus, className }: {
  value: string
  onValueChange: (value: string) => void
  onClose: (() => void) | null
  placeholder: string
  label: string
  inputRef?: RefObject<HTMLInputElement | null>
  autoFocus?: boolean
  className?: string
}) {
  const own = useRef<HTMLInputElement>(null)
  const ref = inputRef ?? own
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key !== 'Escape') return
    e.preventDefault(); e.stopPropagation()
    if (value) onValueChange('')
    else onClose?.()
  }
  return <InputGroup variant="search" className={cn('al-search', className)}>
    <InputAddon align="start"><Search aria-hidden /></InputAddon>
    <input ref={ref} type="text" value={value} autoFocus={autoFocus} placeholder={placeholder} aria-label={label}
      autoComplete="off" spellCheck={false} onChange={(e) => onValueChange(e.target.value)} onKeyDown={onKeyDown} />
    <InputAddon align="end">
      {value ? <Button variant="muted" size="icon-xs" aria-label="Limpar busca" onClick={() => { onValueChange(''); ref.current?.focus() }}><X aria-hidden /></Button> : null}
      {onClose ? <Button variant="muted" size="icon-xs" className="al-search-esc" aria-label="Fechar busca" onClick={onClose}><span aria-hidden="true">esc</span></Button> : null}
    </InputAddon>
  </InputGroup>
}

/** Centered icon, title and hint for an empty panel (SidebarPanelEmptyState). */
export function EmptyState({ icon: Icon, title, description, children }: { icon: LucideIcon; title: string; description?: string | null; children?: ReactNode }) {
  return <div className="al-empty" role="status">
    <Icon className="al-empty-icon" aria-hidden />
    <div className="al-empty-text">
      <p className="al-empty-title">{title}</p>
      {description ? <p className="al-empty-desc">{description}</p> : null}
    </div>
    {children}
  </div>
}

/**
 * Traycer's banded destructive confirmation (ConfirmDestructiveDialog): an
 * alert badge beside title and description, then a footer band with Cancel
 * and the destructive action. Escape and the backdrop cancel.
 */
export function ConfirmDialog({ title, description, detail, actionLabel, pending, onCancel, onConfirm }: {
  title: string
  description: string
  detail?: ReactNode
  actionLabel: string
  pending?: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  // Callbacks live in a ref: a parent re-rendering (a streaming agent) must not
  // re-run the mount effect, which would pull focus back to Cancel.
  const latest = useRef({ onCancel, pending })
  latest.current = { onCancel, pending }
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    cancelRef.current?.focus()
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape' && !latest.current.pending) { e.preventDefault(); e.stopImmediatePropagation(); latest.current.onCancel() }
    }
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('keydown', onKey, true); if (opener?.isConnected) opener.focus({ preventScroll: true }) }
  }, [])
  return createPortal(<div className="al-overlay" onPointerDown={(e) => { if (e.target === e.currentTarget && !pending) onCancel() }}>
    <div className="al-dialog al-confirm" role="alertdialog" aria-modal="true" aria-labelledby="al-confirm-title" aria-describedby="al-confirm-desc"
      onKeyDown={(e) => {
        if (e.key !== 'Tab') return
        const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
        const i = items.indexOf(document.activeElement as HTMLButtonElement)
        if (e.shiftKey && i <= 0) { e.preventDefault(); items.at(-1)?.focus() } else if (!e.shiftKey && i === items.length - 1) { e.preventDefault(); items[0]?.focus() }
      }}>
      <div className="al-confirm-body">
        <div className="al-confirm-badge"><TriangleAlert aria-hidden /></div>
        <div className="al-confirm-copy">
          <h2 id="al-confirm-title" className="al-dialog-title">{title}</h2>
          <p id="al-confirm-desc" className="al-dialog-desc">{description}</p>
          {detail}
        </div>
      </div>
      <div className="al-dialog-foot">
        <Button ref={cancelRef} variant="ghost" size="sm" disabled={pending} onClick={onCancel}>Cancelar</Button>
        <Button variant="destructive" size="sm" disabled={pending} onClick={onConfirm}>{pending ? <Spinner /> : null}{actionLabel}</Button>
      </div>
    </div>
  </div>, document.body)
}

/** A row's trailing last-activity time (ChatRowIdleTime): a leaf, so the shared minute tick repaints only this span. */
export function IdleTime({ at }: { at: number }) {
  const now = useMinuteClock()
  return <span className="al-idle-time">{formatCompactRelativeTime(at, now)}</span>
}
