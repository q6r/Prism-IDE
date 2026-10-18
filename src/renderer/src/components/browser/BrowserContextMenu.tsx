import type { ReactNode } from 'react'
import { DropdownMenu, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut } from '../ui'

export type ContextMenuEntry =
  | { readonly kind: 'item'; readonly label: string; readonly icon?: ReactNode; readonly shortcut?: string; readonly disabled?: boolean; readonly onSelect: () => void }
  | { readonly kind: 'separator' }

export interface ContextMenuRequest {
  readonly x: number
  readonly y: number
  readonly entries: readonly ContextMenuEntry[]
}

/**
 * A right-click menu at a viewport point, built on the kit's DropdownMenu so it
 * keeps Traycer's menu recipe, roving focus and outside-press dismissal. The
 * anchor is a zero-size fixed point at the cursor.
 */
export function BrowserContextMenu({ request, onClose }: { request: ContextMenuRequest | null; onClose: () => void }) {
  if (request === null) return null
  const entries = request.entries.filter((entry, index, all) =>
    // No leading, trailing or doubled separators once items are filtered out.
    entry.kind !== 'separator' || (index > 0 && index < all.length - 1 && all[index - 1].kind !== 'separator'))
  return (
    <DropdownMenu
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      onCloseAutoFocus={() => undefined}
      side="bottom"
      align="start"
      sideOffset={2}
      className="brw-context-menu"
      label="Menu de contexto"
      trigger={<span className="brw-context-anchor" style={{ left: request.x, top: request.y }} aria-hidden />}
    >
      {entries.map((entry, index) =>
        entry.kind === 'separator' ? (
          <DropdownMenuSeparator key={`sep-${index}`} />
        ) : (
          <DropdownMenuItem key={`${entry.label}-${index}`} disabled={entry.disabled} onSelect={() => { onClose(); entry.onSelect() }}>
            {entry.icon}
            <span className="tr-truncate">{entry.label}</span>
            {entry.shortcut ? <DropdownMenuShortcut>{entry.shortcut}</DropdownMenuShortcut> : null}
          </DropdownMenuItem>
        )
      )}
    </DropdownMenu>
  )
}
