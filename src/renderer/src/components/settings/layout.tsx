import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight, RefreshCw, RotateCcw, X } from 'lucide-react'
import { Button, cn, Select, Tooltip } from '../ui'
import { pushEscapeConsumer } from './escape'

/*
 * Settings building blocks, one per Traycer file:
 * settings-panel-shell.tsx, settings-group.tsx, settings-row.tsx,
 * settings-master-detail.tsx, settings-rail-row.ts, controls/settings-number-input.tsx,
 * refresh-icon-button.tsx and the banded ui/dialog.tsx. Always the modal's
 * "compact" density.
 */

/* ---------------- Panel shell ---------------- */
export function SettingsPanelShell({ title, description, headerAction, fillHeight, plainBody, children }: {
  title: string
  description?: string
  /** Control at the top-right of the header (e.g. the providers' refresh). */
  headerAction?: ReactNode
  /** Stretch to the pane so the body owns an internal scroll (master-detail pages). */
  fillHeight?: boolean
  /** No card around the body: the groups inside draw their own. */
  plainBody?: boolean
  children: ReactNode
}) {
  return <section data-settings-panel-shell className={cn('stg-shell', fillHeight && 'fill')}>
    <header className="stg-shell-head">
      <div className="stg-shell-titles">
        <h1 className="stg-shell-title">{title}</h1>
        {description ? <p className="stg-shell-desc">{description}</p> : null}
      </div>
      {headerAction === undefined ? null : <div className="stg-shell-action">{headerAction}</div>}
    </header>
    <div data-settings-panel-body className={cn('stg-shell-body', plainBody && 'plain')}>{children}</div>
  </section>
}

/** The vertical rhythm between groups on a plain-body page (`gap-3.5`). */
export function SettingsGroupStack({ children }: { children: ReactNode }) {
  return <div className="stg-group-stack">{children}</div>
}

/* ---------------- Group ---------------- */
/**
 * A named group of rows: the quiet label sits OUTSIDE the bordered card, so a
 * group label never reads as another row. The search anchor goes on the card.
 */
export function SettingsGroup({ title, titleStatus, anchor, tone = 'default', showTitle = true, children }: {
  title: string
  titleStatus?: ReactNode
  anchor?: string
  tone?: 'default' | 'danger'
  showTitle?: boolean
  children: ReactNode
}) {
  return <section className="stg-group">
    {showTitle ? <h2 className={cn('stg-group-title', tone === 'danger' && 'danger')}>{title}{titleStatus}</h2> : null}
    <div data-settings-anchor={anchor} className={cn('stg-group-card', tone === 'danger' && 'danger')}>{children}</div>
  </section>
}

/* ---------------- Row ---------------- */
const rendersContent = (node: ReactNode): boolean => node !== null && node !== undefined && typeof node !== 'boolean' && node !== ''

export function SettingsRow({ label, labelStatus, description, status, hint, control, controlSpansLine, details, anchor }: {
  label: ReactNode
  /** Live badge after the label, behind " · ". */
  labelStatus?: ReactNode
  description?: ReactNode
  /** Live copy shown INSTEAD of the description (null/'' suppresses it). */
  status?: ReactNode
  hint?: ReactNode
  control: ReactNode
  /** Wide controls (fields, pickers) take the whole line once the row stacks. */
  controlSpansLine?: boolean
  /** Options the control governs, on a full-width line under the row. */
  details?: ReactNode
  anchor?: string
}) {
  const descriptionId = useId()
  const shown = status !== undefined ? status : description
  return <div data-settings-anchor={anchor} className="stg-row">
    <div className="stg-row-label">
      <div className="stg-row-name">{label}{labelStatus !== undefined && rendersContent(labelStatus) ? <>{' · '}{labelStatus}</> : null}</div>
      {rendersContent(shown) ? <div id={descriptionId} className="stg-row-desc">{shown}</div> : null}
      {hint ? <p className="stg-row-hint">{hint}</p> : null}
    </div>
    <div className={cn('stg-row-control', controlSpansLine && 'spans')}>{control}</div>
    {details !== undefined && rendersContent(details) ? <div className="stg-row-details">{details}</div> : null}
  </div>
}

/* ---------------- Master-detail ---------------- */
/**
 * Providers' (and Appearance's) body: a rail column beside the detail column,
 * both filling the card. Below 768px the rail collapses into a select above
 * the detail.
 */
export function SettingsMasterDetail({ railLabel, rail, mobileSelect, children }: { railLabel: string; rail: ReactNode; mobileSelect: ReactNode; children: ReactNode }) {
  return <div className="stg-md">
    <div className="stg-md-mobile">{mobileSelect}</div>
    <nav aria-label={railLabel} className="stg-md-rail">{rail}</nav>
    <div className="stg-md-detail">{children}</div>
  </div>
}

export interface SettingsMasterOption<V extends string> { readonly value: V; readonly label: string; readonly icon: ReactNode }

/** The rail's narrow-width presentation: one select over the same options. */
export function SettingsMasterSelect<V extends string>({ label, value, options, onSelect }: { label: string; value: V; options: readonly SettingsMasterOption<V>[]; onSelect: (value: V) => void }) {
  return <Select ariaLabel={label} value={value} onValueChange={onSelect} className="stg-md-select"
    options={options.map((o) => ({ value: o.value, label: o.label, icon: o.icon }))} />
}

/** The detail column's head: what is selected, one line on what it is, and a trailing action. */
export function SettingsDetailHeader({ title, badge, description, footer, action }: { title: string; badge?: ReactNode; description: string; footer?: ReactNode; action?: ReactNode }) {
  return <div className="stg-detail-head">
    <div className="stg-detail-titles">
      <div className="stg-detail-title-row"><div className="stg-detail-title">{title}</div>{badge}</div>
      <p className="stg-detail-desc">{description}</p>
      {footer}
    </div>
    {action}
  </div>
}

/** One rail row: the selected row filled, the rest receding until hovered (settings-rail-row.ts). */
export function railRowClass(active: boolean): string {
  return cn('stg-rail-row', active && 'active')
}

/* ---------------- Controls ---------------- */
export function SettingsNumberInput({ value, onChange, min, max, unit, ariaLabel, defaultValue, resetTooltip = 'Restaurar padrão' }: {
  value: number
  onChange: (value: number) => void
  min: number
  max: number
  unit?: string
  ariaLabel: string
  defaultValue: number
  resetTooltip?: string
}) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const commit = (text: string): void => {
    const parsed = Number(text)
    if (text.trim() === '' || !Number.isFinite(parsed)) { setDraft(String(value)); return }
    const next = Math.min(max, Math.max(min, Math.round(parsed)))
    setDraft(String(next))
    if (next !== value) onChange(next)
  }
  return <div className="stg-number">
    <div className="stg-number-reset">
      {value !== defaultValue ? <Tooltip label={resetTooltip}>
        <Button size="icon-sm" variant="ghost" aria-label={resetTooltip} onClick={() => onChange(defaultValue)}><RotateCcw size={14} /></Button>
      </Tooltip> : null}
    </div>
    <div className="stg-number-field">
      <input type="number" className="tr-input stg-number-input" value={draft} min={min} max={max} aria-label={ariaLabel}
        onChange={(e) => {
          setDraft(e.target.value)
          const parsed = Number(e.target.value)
          if (e.target.value.trim() !== '' && Number.isFinite(parsed) && parsed >= min && parsed <= max && parsed !== value) onChange(Math.round(parsed))
        }}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') commit(e.currentTarget.value) }} />
      {unit ? <span className="stg-number-unit">{unit}</span> : null}
    </div>
  </div>
}

/** Spinning refresh icon button with its own tooltip (refresh-icon-button.tsx). */
export function RefreshIconButton({ onRefresh, label, refreshing, disabledReason }: { onRefresh: () => void | Promise<void>; label: string; refreshing?: boolean; disabledReason?: string | null }) {
  const [running, setRunning] = useState(false)
  const busy = running || !!refreshing
  const effective = disabledReason ? `${label} — ${disabledReason}` : label
  const trigger = (): void => {
    if (busy) return
    setRunning(true)
    const done = (): void => setRunning(false)
    // A 10s cap so a refresh that never settles cannot freeze the control.
    const cap = setTimeout(done, 10_000)
    Promise.resolve().then(onRefresh).catch(() => undefined).finally(() => { clearTimeout(cap); done() })
  }
  return <Tooltip label={effective}>
    <span className="stg-inline-guard">
      <button type="button" aria-label={effective} className="stg-refresh" onClick={trigger} disabled={busy || !!disabledReason}>
        <RefreshCw size={16} className={cn(busy && 'stg-spin')} />
      </button>
    </span>
  </Tooltip>
}

/** The "Trocar conta" / "Vincular conta" call-to-action card. */
export function ActionCard({ icon, title, description, onClick, disabled, ariaLabel }: { icon: ReactNode; title: string; description: string; onClick: () => void; disabled?: boolean; ariaLabel?: string }) {
  return <button type="button" aria-label={ariaLabel ?? title} className="stg-action-card" disabled={disabled} onClick={onClick}>
    <span className="stg-action-card-icon">{icon}</span>
    <span className="stg-action-card-text"><span className="stg-action-card-title">{title}</span><span className="stg-action-card-desc">{description}</span></span>
    <ChevronRight size={16} className="stg-action-card-chevron" />
  </button>
}

/* ---------------- Outside-press guard ---------------- */
/**
 * Whether a dropdown menu was open when the current pointer press began.
 * Sampled on window capture, ahead of the menu's own document listener, which
 * closes it before the overlay's handler runs: that press dismisses the menu,
 * never the modal underneath (Radix: the first outside click closes only the menu).
 */
export function useMenuOpenAtPointerDown(): { readonly current: boolean } {
  const open = useRef(false)
  useEffect(() => {
    const sample = (): void => { open.current = !!document.querySelector('.tr-menu') }
    window.addEventListener('pointerdown', sample, true)
    return () => window.removeEventListener('pointerdown', sample, true)
  }, [])
  return open
}

/* ---------------- Focus helpers ---------------- */
const TABBABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

export function tabbablesIn(root: HTMLElement | null): HTMLElement[] {
  if (!root) return []
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter((el) => !el.closest('[inert]') && el.getClientRects().length > 0)
}

/** Keeps Tab inside `root` (Radix FocusScope `trapped`). Returns true when it moved focus. */
export function trapTab(e: ReactKeyboardEvent<HTMLElement>, root: HTMLElement | null): boolean {
  if (e.key !== 'Tab' || e.defaultPrevented || !root) return false
  const active = document.activeElement as HTMLElement | null
  if (active && !root.contains(active) && active !== root) return false
  const items = tabbablesIn(root)
  if (!items.length) { e.preventDefault(); return true }
  const first = items[0], last = items[items.length - 1]
  if (e.shiftKey && (active === first || active === root)) { e.preventDefault(); last.focus(); return true }
  if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); return true }
  return false
}

/* ---------------- Dialog (banded) ---------------- */
/**
 * Traycer's `DialogContent layout="banded"`: header band, scrolling body,
 * footer band. Portals over Settings, traps focus, takes Escape before the
 * modal does, and a genuine backdrop click closes it (unless `locked`).
 */
export function SettingsDialog({ open, onOpenChange, title, description, footer, showClose = true, locked = false, wide, children }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description?: ReactNode
  footer?: ReactNode
  showClose?: boolean
  /** Refuses Escape / backdrop dismissal (a sign-in in flight). */
  locked?: boolean
  wide?: boolean
  children: ReactNode
}) {
  const content = useRef<HTMLDivElement>(null)
  const downOnOverlay = useRef(false)
  const menuAtDown = useMenuOpenAtPointerDown()
  const titleId = useId(), descriptionId = useId()
  const latest = useRef({ locked, onOpenChange })
  latest.current = { locked, onOpenChange }
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    const frame = requestAnimationFrame(() => {
      // A body that already placed focus (the login terminal) keeps it.
      if (content.current?.contains(document.activeElement) && document.activeElement !== content.current) return
      const first = tabbablesIn(content.current).find((el) => !el.matches('[data-dialog-close]'))
      ;(first ?? content.current)?.focus({ preventScroll: true })
    })
    const pop = pushEscapeConsumer(() => {
      // A dropdown inside the dialog owns its own Escape.
      if (document.querySelector('.tr-menu')) return false
      if (!latest.current.locked) latest.current.onOpenChange(false)
      return true
    })
    return () => { cancelAnimationFrame(frame); pop(); if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [open])
  if (!open) return null
  return createPortal(<>
    <div className="stg-dialog-overlay" aria-hidden="true"
      onPointerDown={(e) => { downOnOverlay.current = e.target === e.currentTarget && !menuAtDown.current }}
      onClick={(e) => { if (downOnOverlay.current && e.target === e.currentTarget && !locked) onOpenChange(false); downOnOverlay.current = false }} />
    <div ref={content} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined}
      tabIndex={-1} className={cn('stg-dialog', wide && 'wide')}
      onKeyDown={(e) => { if (trapTab(e, content.current)) e.stopPropagation() }}>
      <div className="stg-dialog-head">
        <h2 id={titleId} className="stg-dialog-title">{title}</h2>
        {description ? <p id={descriptionId} className="stg-dialog-desc">{description}</p> : null}
      </div>
      <div className="stg-dialog-body">{children}</div>
      {footer ? <div className="stg-dialog-foot">{footer}</div> : null}
      {showClose ? <Button data-dialog-close variant="ghost" size="icon-sm" className="stg-dialog-close" aria-label="Fechar" disabled={locked} onClick={() => onOpenChange(false)}><X /></Button> : null}
    </div>
  </>, document.body)
}
