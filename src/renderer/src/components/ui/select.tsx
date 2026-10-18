import type { ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { DropdownMenu, DropdownMenuRadioItem } from './dropdown-menu'
import { cn } from './primitives'

export interface SelectOption<V extends string> { readonly value: V; readonly label: ReactNode; readonly icon?: ReactNode; readonly disabled?: boolean }

/** Traycer's Select (ui/select.tsx): bordered trigger + popover list with a trailing check. */
export function Select<V extends string>({ value, options, onValueChange, ariaLabel, size = 'default', className, disabled, placeholder }: {
  value: V
  options: readonly SelectOption<V>[]
  onValueChange: (value: V) => void
  ariaLabel: string
  size?: 'default' | 'sm'
  className?: string
  disabled?: boolean
  placeholder?: ReactNode
}) {
  const selected = options.find((o) => o.value === value)
  return <DropdownMenu matchTriggerWidth label={ariaLabel} trigger={
    <button type="button" aria-label={ariaLabel} disabled={disabled} className={cn('tr-select-trigger', size === 'sm' && 's-sm', className)}>
      <span className="tr-select-value">{selected?.icon}{selected ? <span className="tr-truncate">{selected.label}</span> : <span className="tr-muted">{placeholder}</span>}</span>
      <ChevronDown />
    </button>}>
    {options.map((o) => <DropdownMenuRadioItem key={o.value} checked={o.value === value} disabled={o.disabled} onSelect={() => onValueChange(o.value)}>
      {o.icon}<span className="tr-truncate">{o.label}</span>
    </DropdownMenuRadioItem>)}
  </DropdownMenu>
}
