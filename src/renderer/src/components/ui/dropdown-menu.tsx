import { cloneElement, createContext, isValidElement, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type HTMLAttributes, type KeyboardEvent, type MouseEvent, type ReactElement, type ReactNode, type Ref } from 'react'
import { createPortal } from 'react-dom'
import { Check } from 'lucide-react'
import { useFloating, type Align, type Side } from './floating'
import { cn, mergeRefs } from './primitives'

/** What a menu item's `onSelect` receives; `preventDefault()` keeps the menu open. */
export interface MenuSelectEvent { defaultPrevented: boolean; preventDefault: () => void }

interface MenuContextValue { readonly close: (restoreFocus?: boolean) => void; readonly content: HTMLDivElement | null }
const MenuContext = createContext<MenuContextValue | null>(null)
export const useMenuContext = (): MenuContextValue | null => useContext(MenuContext)

const ITEM_SELECTOR = '[role^="menuitem"]:not([aria-disabled="true"])'
const itemsOf = (content: HTMLElement | null): HTMLElement[] => content ? [...content.querySelectorAll<HTMLElement>(ITEM_SELECTOR)] : []

type TriggerProps = {
  ref?: unknown
  onClick?: (e: MouseEvent) => void
  onKeyDown?: (e: KeyboardEvent) => void
}

/**
 * Traycer's DropdownMenu (Radix recipe): portal content, roving focus over
 * items, Arrow/Home/End/Enter/Escape/Tab, outside-press dismissal. Elements
 * marked `data-tr-keep-open` (e.g. a usage sidecar) do not dismiss it.
 */
export function DropdownMenu({ trigger, children, open: controlled, onOpenChange, side = 'bottom', align = 'start', sideOffset = 4, alignOffset = 0,
  matchTriggerWidth, className, style, container, onCloseAutoFocus, onContentKeyDown, label }: {
  trigger: ReactElement
  children: ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  side?: Side
  align?: Align
  sideOffset?: number
  alignOffset?: number
  /** `min-width: var(--radix-dropdown-menu-trigger-width)` */
  matchTriggerWidth?: boolean
  className?: string
  style?: CSSProperties
  /** Portal target; defaults to document.body. */
  container?: HTMLElement | null
  /** Replaces the default "focus the trigger again" on close. */
  onCloseAutoFocus?: () => void
  /** Runs before the menu's own key handling; preventDefault() skips it. */
  onContentKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void
  label?: string
}) {
  const [inner, setInner] = useState(false)
  const open = controlled ?? inner
  const [triggerEl, setTriggerEl] = useState<HTMLElement | null>(null)
  const [content, setContent] = useState<HTMLDivElement | null>(null)
  const keyboardOpen = useRef(false)
  const setOpen = (next: boolean): void => { if (controlled === undefined) setInner(next); onOpenChange?.(next) }
  const close = (restoreFocus = true): void => {
    setOpen(false)
    if (!restoreFocus) return
    if (onCloseAutoFocus) onCloseAutoFocus()
    else triggerEl?.focus({ preventScroll: true })
  }
  const placement = useFloating(triggerEl, content, { open, side, align, sideOffset, alignOffset, collisionPadding: 8 })
  const setOpenRef = useRef(setOpen)
  setOpenRef.current = setOpen
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      const target = e.target as Element
      if (content?.contains(target) || triggerEl?.contains(target) || target.closest?.('[data-tr-keep-open]')) return
      // Radix menus are modal: the press that dismisses one is consumed, so it
      // never reaches what lies underneath (a dialog backdrop, a tree row).
      // Another menu's trigger still receives it, so menus switch in one click.
      if (!target.closest?.('[aria-haspopup="menu"]')) { e.stopPropagation(); consumeGesture() }
      setOpenRef.current(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [open, content, triggerEl])
  // Focus moves in once the menu is placed: while it measures it is
  // visibility:hidden, and a hidden element silently refuses focus (which
  // left Escape/arrows dead until the user clicked inside).
  const focusedFor = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open || !content) { focusedFor.current = null; return }
    if (!placement.ready || focusedFor.current === content) return
    focusedFor.current = content
    const first = keyboardOpen.current ? itemsOf(content)[0] : null
    ;(first ?? content).focus({ preventScroll: true })
  }, [open, content, placement.ready])
  const triggerProps = isValidElement<TriggerProps>(trigger) ? trigger.props : {}
  // A stable merged ref: a fresh one per render makes React detach and
  // re-attach it on every commit, re-rendering the menu each time.
  const triggerRef = useMemo(() => mergeRefs(triggerProps.ref as never, setTriggerEl), [triggerProps.ref])
  const triggerNode = isValidElement<TriggerProps>(trigger) ? cloneElement(trigger, {
    ref: triggerRef,
    'aria-haspopup': 'menu', 'aria-expanded': open, 'data-state': open ? 'open' : 'closed',
    onClick: (e: MouseEvent) => {
      triggerProps.onClick?.(e)
      if (e.defaultPrevented) return
      keyboardOpen.current = e.detail === 0
      setOpen(!open)
    },
    onKeyDown: (e: KeyboardEvent) => {
      triggerProps.onKeyDown?.(e)
      if (e.defaultPrevented) return
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); keyboardOpen.current = true; setOpen(true) }
    }
  } as TriggerProps) : trigger
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    onContentKeyDown?.(e)
    if (e.defaultPrevented) return
    const items = itemsOf(content)
    const index = items.indexOf(document.activeElement as HTMLElement)
    const focusAt = (i: number): void => items[(i + items.length) % items.length]?.focus({ preventScroll: false })
    if (e.key === 'ArrowDown') { e.preventDefault(); focusAt(index < 0 ? 0 : index + 1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusAt(index < 0 ? items.length - 1 : index - 1) }
    else if (e.key === 'Home') { e.preventDefault(); focusAt(0) }
    else if (e.key === 'End') { e.preventDefault(); focusAt(items.length - 1) }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close() }
    else if (e.key === 'Tab') { e.preventDefault(); close() }
    else if ((e.key === 'Enter' || e.key === ' ') && index >= 0) { e.preventDefault(); items[index].click() }
  }
  return <>
    {triggerNode}
    {open && createPortal(
      <MenuContext.Provider value={{ close, content }}>
        <div ref={setContent} role="menu" aria-label={label} tabIndex={-1} data-side={placement.side} data-measuring={!placement.ready}
          className={cn('tr-menu', className)} onKeyDown={onKeyDown}
          style={{ ...placement.style, maxHeight: 'var(--tr-available-height)', ...(matchTriggerWidth ? { minWidth: placement.anchorWidth || undefined } : {}), ...style }}>
          {children}
        </div>
      </MenuContext.Provider>, container ?? document.body)}
  </>
}

/**
 * Swallows the rest of one pointer gesture (mouse compat events, click,
 * context menu), the way Radix's `pointer-events: none` outside a modal menu
 * keeps the dismissing press from activating anything.
 */
function consumeGesture(): void {
  const types = ['mousedown', 'pointerup', 'mouseup', 'click', 'auxclick', 'contextmenu', 'dblclick'] as const
  const stop = (e: Event): void => {
    e.preventDefault(); e.stopPropagation()
    // The click and context menu follow pointerup in the same task.
    if (e.type === 'pointerup') setTimeout(finish, 0)
  }
  const finish = (): void => {
    for (const type of types) document.removeEventListener(type, stop, true)
    document.removeEventListener('pointercancel', finish, true)
    clearTimeout(safety)
  }
  for (const type of types) document.addEventListener(type, stop, true)
  document.addEventListener('pointercancel', finish, true)
  // A press whose release never arrives must not eat a later gesture.
  const safety = setTimeout(finish, 2000)
}

function selectEvent(): MenuSelectEvent {
  const event: MenuSelectEvent = { defaultPrevented: false, preventDefault: () => { event.defaultPrevented = true } }
  return event
}

type ItemProps = Omit<HTMLAttributes<HTMLDivElement>, 'onSelect'> & {
  onSelect?: (event: MenuSelectEvent) => void
  disabled?: boolean
  variant?: 'default' | 'destructive' | 'muted'
  inset?: boolean
}

export function DropdownMenuItem({ onSelect, disabled, variant, inset, className, children, onPointerMove, onPointerLeave, ref, ...rest }: ItemProps & { ref?: Ref<HTMLDivElement> }) {
  const menu = useContext(MenuContext)
  return <div ref={ref} role="menuitem" tabIndex={-1} aria-disabled={disabled || undefined}
    className={cn('tr-menu-item', variant !== 'default' && variant, inset && 'inset', className)}
    onPointerMove={(e) => { onPointerMove?.(e); if (!disabled && document.activeElement !== e.currentTarget) e.currentTarget.focus({ preventScroll: true }) }}
    onPointerLeave={(e) => { onPointerLeave?.(e); if (document.activeElement === e.currentTarget) menu?.content?.focus({ preventScroll: true }) }}
    onClick={() => { if (disabled) return; const ev = selectEvent(); onSelect?.(ev); if (!ev.defaultPrevented) menu?.close() }}
    {...rest}>{children}</div>
}

export function DropdownMenuRadioItem({ checked, className, children, ...rest }: ItemProps & { checked: boolean }) {
  const menu = useContext(MenuContext)
  const { onSelect, disabled } = rest
  return <div role="menuitemradio" aria-checked={checked} tabIndex={-1} aria-disabled={disabled || undefined}
    className={cn('tr-menu-item radio', className)}
    onPointerMove={(e) => { if (!disabled && document.activeElement !== e.currentTarget) e.currentTarget.focus({ preventScroll: true }) }}
    onPointerLeave={(e) => { if (document.activeElement === e.currentTarget) menu?.content?.focus({ preventScroll: true }) }}
    onClick={() => { if (disabled) return; const ev = selectEvent(); onSelect?.(ev); if (!ev.defaultPrevented) menu?.close() }}>
    <span className="tr-menu-item-indicator">{checked ? <Check size={16} /> : null}</span>
    {children}
  </div>
}

export function DropdownMenuSeparator() { return <div role="separator" className="tr-menu-separator" /> }
export function DropdownMenuLabel({ children, className }: { children: ReactNode; className?: string }) { return <div className={cn('tr-menu-label', className)}>{children}</div> }
export function DropdownMenuShortcut({ children, className }: { children: ReactNode; className?: string }) { return <span className={cn('tr-menu-shortcut', className)}>{children}</span> }
