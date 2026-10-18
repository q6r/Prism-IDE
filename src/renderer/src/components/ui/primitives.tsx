import { useSyncExternalStore, type ButtonHTMLAttributes, type CSSProperties, type HTMLAttributes, type KeyboardEvent, type ReactNode, type Ref, type RefCallback } from 'react'

/** Joins class names, skipping falsy parts (the `cn` every Traycer component uses). */
export function cn(...parts: (string | false | null | undefined | 0)[]): string {
  return parts.filter(Boolean).join(' ')
}

/** Combines refs so a cloned child keeps its own ref (React 19 keeps `ref` in props). */
export function mergeRefs<T>(...refs: (Ref<T> | undefined | null)[]): RefCallback<T> {
  return (node) => {
    for (const ref of refs) {
      if (typeof ref === 'function') ref(node)
      else if (ref) (ref as { current: T | null }).current = node
    }
  }
}

/* ---------------- Kbd ---------------- */
export function Kbd({ variant, size, className, ...rest }: HTMLAttributes<HTMLElement> & { variant?: 'default' | 'mono'; size?: 'default' | 'xs' }) {
  return <kbd data-slot="kbd" className={cn('tr-kbd', variant === 'mono' && 'mono', size === 'xs' && 'xs', className)} {...rest} />
}

/* ---------------- Badge ---------------- */
export type BadgeVariant = 'default' | 'secondary' | 'muted' | 'outline' | 'destructive' | 'success' | 'warning' | 'info' | 'accent'
export function Badge({ variant = 'default', size = 'default', className, ...rest }: HTMLAttributes<HTMLSpanElement> & { variant?: BadgeVariant; size?: 'default' | 'sm' | 'xs' }) {
  return <span data-slot="badge" className={cn('tr-badge', `v-${variant}`, size !== 'default' && `size-${size}`, className)} {...rest} />
}

/* ---------------- Button ---------------- */
export type ButtonVariant = 'default' | 'outline' | 'secondary' | 'ghost' | 'muted' | 'destructive' | 'link'
export type ButtonSize = 'default' | 'xs' | 'sm' | 'lg' | 'icon' | 'icon-xs' | 'icon-sm' | 'icon-lg'
export function buttonClass(variant: ButtonVariant = 'default', size: ButtonSize = 'default', className?: string): string {
  return cn('tr-btn', `v-${variant}`, size !== 'default' && `s-${size}`, className)
}
export function Button({ variant = 'default', size = 'default', className, type, ref, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize; ref?: Ref<HTMLButtonElement> }) {
  return <button ref={ref} type={type ?? 'button'} data-slot="button" data-variant={variant} className={buttonClass(variant, size, className)} {...rest} />
}

/** Composer toolbar chip (Traycer ToolbarPillButton / ToolbarIconButton, flat style). */
export function ToolbarChip({ square, className, type, ref, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { square?: boolean; ref?: Ref<HTMLButtonElement> }) {
  return <button ref={ref} type={type ?? 'button'} className={cn('tr-chip', square && 'square', className)} {...rest} />
}

/* ---------------- Switch ---------------- */
export function Switch({ checked, onCheckedChange, disabled, className, ...rest }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> & { checked: boolean; onCheckedChange: (next: boolean) => void }) {
  return <button type="button" role="switch" aria-checked={checked} data-state={checked ? 'checked' : 'unchecked'} disabled={disabled}
    className={cn('tr-switch', className)} onClick={() => onCheckedChange(!checked)} {...rest}>
    <span className="tr-switch-thumb" data-state={checked ? 'checked' : 'unchecked'} />
  </button>
}

/* ---------------- Accent dot (profile identity) ---------------- */
export function AccentDot({ color, label, variant, size = 'default', className, style }: { color: string; label?: string | null; variant: 'inline' | 'corner'; size?: 'compact' | 'default'; className?: string; style?: CSSProperties }) {
  const initial = variant === 'corner' ? (label?.trim().slice(0, 1).toLocaleUpperCase() || null) : null
  return <span aria-hidden="true" className={cn('tr-accent-dot', variant, variant === 'corner' && size, className)} style={{ ['--swatch' as string]: color, ...style }}>{initial}</span>
}

/* ---------------- Braille working spinner (agent-spinning-dots) ---------------- */
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
let frame = 0
const listeners = new Set<() => void>()
let ticker: ReturnType<typeof setInterval> | undefined
function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (!ticker) ticker = setInterval(() => { frame = (frame + 1) % FRAMES.length; for (const l of listeners) l() }, 80)
  return () => { listeners.delete(listener); if (!listeners.size && ticker) { clearInterval(ticker); ticker = undefined } }
}
export function Spinner({ tone, className, label }: { tone?: 'muted' | 'default'; className?: string; label?: string }) {
  const index = useSyncExternalStore(subscribe, () => frame, () => 0)
  return <span className={cn('tr-spinner', tone === 'muted' && 'muted', className)} role={label ? 'status' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>{FRAMES[index]}</span>
}

/* ---------------- Input group (search fields) ---------------- */
export function InputGroup({ variant, className, children, ...rest }: HTMLAttributes<HTMLDivElement> & { variant?: 'default' | 'search' }) {
  return <div data-slot="input-group" className={cn('tr-input-group', variant === 'search' && 'search', className)} {...rest}>{children}</div>
}
export function InputAddon({ align = 'start', className, ...rest }: HTMLAttributes<HTMLDivElement> & { align?: 'start' | 'end' }) {
  return <div className={cn('tr-input-addon', align, className)} onPointerDown={(e) => {
    if (!(e.target as HTMLElement).closest('button')) { e.preventDefault(); e.currentTarget.parentElement?.querySelector('input')?.focus() }
  }} {...rest} />
}

/* ---------------- Segmented control ---------------- */
export function SegmentedControl<V extends string>({ value, options, onChange, ariaLabel, disabled }: { value: V; options: readonly { value: V; label: ReactNode }[]; onChange: (next: V) => void; ariaLabel: string; disabled?: boolean }) {
  return <div role="group" aria-label={ariaLabel} aria-disabled={disabled || undefined} className="tr-segmented">
    {options.map((o) => <button key={o.value} type="button" aria-pressed={o.value === value} disabled={disabled} onClick={() => { if (o.value !== value) onChange(o.value) }}>{o.label}</button>)}
  </div>
}

/* ---------------- Line tabs ---------------- */
/**
 * Radix Tabs semantics: one tab stop (the selected tab), arrows/Home/End move
 * and activate. With `idPrefix`, tab `${idPrefix}-tab-${value}` controls the
 * panel the caller renders as `id={tabPanelId(idPrefix, value)}`.
 */
export const tabPanelId = (idPrefix: string, value: string): string => `${idPrefix}-panel-${value}`
export function LineTabs<V extends string>({ value, tabs, onChange, ariaLabel, className, idPrefix }: { value: V; tabs: readonly { value: V; label: ReactNode }[]; onChange: (next: V) => void; ariaLabel: string; className?: string; idPrefix?: string }) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const index = tabs.findIndex((t) => t.value === value)
    const next = e.key === 'ArrowRight' ? index + 1 : e.key === 'ArrowLeft' ? index - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null
    if (next === null || !tabs.length) return
    e.preventDefault()
    const target = tabs[(next + tabs.length) % tabs.length]
    onChange(target.value)
    requestAnimationFrame(() => e.currentTarget?.querySelector<HTMLElement>(`[data-value="${CSS.escape(target.value)}"]`)?.focus())
  }
  return <div role="tablist" aria-label={ariaLabel} className={cn('tr-tabs-line', className)} onKeyDown={onKeyDown}>
    {tabs.map((t) => <button key={t.value} type="button" role="tab" data-value={t.value} aria-selected={t.value === value} tabIndex={t.value === value ? 0 : -1}
      id={idPrefix ? `${idPrefix}-tab-${t.value}` : undefined} aria-controls={idPrefix ? tabPanelId(idPrefix, t.value) : undefined}
      onClick={() => onChange(t.value)}>{t.label}</button>)}
  </div>
}

/* ---------------- Meter row (usage window) ---------------- */
export type Severity = 'healthy' | 'running_low' | 'limited'
export function MeterRow({ label, usedPercent, detail, severity }: { label: ReactNode; usedPercent: number; detail: ReactNode; severity: Severity }) {
  const fill = Math.min(100, Math.max(0, usedPercent))
  return <div className="tr-meter">
    <div className="tr-meter-head"><span>{label}</span><span className="tr-meter-detail">{detail}</span></div>
    <div className="tr-meter-track"><div className={cn('tr-meter-fill', `tr-sev-${severity}`)} style={{ width: `${fill}%` }} /></div>
  </div>
}
