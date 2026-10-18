import { useEffect, useLayoutEffect, useRef, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Folder, TriangleAlert } from 'lucide-react'
import { Button, cn, computePlacement, Spinner, type Side } from '../ui'
import { FileTypeIcon } from '../../lib/fileIcon'
import { mentionPathTree, middleElideRootLabel, type MentionEntry, type SlashCommandItem } from '../../lib/composerMenu'
import type { ChatImage } from '../../../../shared/agents'
import '../../styles/composer-menu.css'

export interface ComposerMenuRow {
  readonly id: string
  readonly disabledReason: string | null
  readonly item: { readonly kind: 'slash'; readonly command: SlashCommandItem } | { readonly kind: 'mention'; readonly entry: MentionEntry }
    | { readonly kind: 'image'; readonly number: number; readonly image: ChatImage }
}

export interface ComposerMenuSection {
  /** Shown only when the menu has more than one section. */
  readonly label: string
  readonly rows: readonly ComposerMenuRow[]
}

export interface ComposerMenuProps {
  readonly listId: string
  readonly header: string
  readonly emptyLabel: string
  readonly sections: readonly ComposerMenuSection[]
  readonly activeIndex: number
  /** Nothing to show yet. */
  readonly loading: boolean
  /** Refreshing behind rows already shown (header spinner). */
  readonly fetching: boolean
  readonly loadFailed: string | null
  readonly onRetry: () => void
  /** The caret rect the menu opens from. */
  readonly getAnchor: () => DOMRect | null
  readonly onHover: (index: number) => void
  readonly onCommit: (index: number) => void
}

const CARET_GAP = 6
const VIEWPORT_PAD = 8
// Open-time preference only (Traycer's MENU_HEIGHT_ESTIMATE): the side with
// this much room wins; placement still flips once the real height is known.
const MENU_HEIGHT_ESTIMATE = 280
const PANEL_GAP = 6
const PANEL_MAX_WIDTH = 352
const PANEL_MIN_WIDTH = 160

export const menuRowId = (listId: string, index: number): string => `${listId}-item-${index}`

/**
 * Traycer's composer picker (chat/composer/menu/composer-menu.tsx): a
 * caret-anchored popover with a header, the rows, and an info-only preview
 * panel beside the highlighted row. Focus never leaves the editor — rows are
 * chosen with the keyboard there, or with a mouse press that does not steal it.
 */
export default function ComposerMenu(props: ComposerMenuProps) {
  const { listId, header, emptyLabel, sections, activeIndex, loading, fetching, loadFailed, onRetry, getAnchor, onHover, onCommit } = props
  const floatingRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const rows = sections.flatMap((s) => s.rows)
  const active = activeIndex >= 0 && activeIndex < rows.length ? rows[activeIndex] : null
  const preview = active ? previewFor(active) : null
  const anchorRef = useRef(getAnchor)
  anchorRef.current = getAnchor

  // Placement runs before paint on every render (rows, query and caret all
  // move it) and again on resize or any outside scroll.
  useLayoutEffect(() => {
    const floating = floatingRef.current
    if (!floating) return
    const place = (): void => {
      const anchor = anchorRef.current()
      if (!anchor) return
      const viewport = { width: window.innerWidth, height: window.innerHeight }
      floating.style.maxHeight = ''
      const size = { width: floating.offsetWidth, height: floating.offsetHeight }
      const below = viewport.height - anchor.bottom, above = anchor.top
      const side: Side = below >= MENU_HEIGHT_ESTIMATE ? 'bottom' : above >= MENU_HEIGHT_ESTIMATE ? 'top' : below >= above ? 'bottom' : 'top'
      const p = computePlacement(anchor, size, viewport, { side, align: 'start', sideOffset: CARET_GAP, alignOffset: 0, collisionPadding: VIEWPORT_PAD, avoidFlip: false })
      floating.style.maxHeight = `${p.available}px`
      floating.style.transform = `translate3d(${p.left}px, ${p.top}px, 0)`
      floating.style.visibility = ''
      placePanel(floating, listRef.current, panelRef.current, viewport)
    }
    place()
    const onScroll = (e: Event): void => {
      if (e.target instanceof Node && floating.contains(e.target) && e.target !== listRef.current) return
      place()
    }
    window.addEventListener('resize', place)
    window.addEventListener('scroll', onScroll, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', onScroll, true) }
  })

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, rows.length])

  let index = 0
  const renderRow = (row: ComposerMenuRow): ReactNode => {
    const i = index++
    const disabled = row.disabledReason !== null
    const isActive = i === activeIndex
    return <div key={row.id} id={menuRowId(listId, i)} role="option" tabIndex={-1} aria-selected={isActive} aria-disabled={disabled}
      data-active={isActive} data-disabled={disabled} className="tcx-row"
      onMouseEnter={() => onHover(i)}
      onMouseDown={(e) => { e.preventDefault(); if (!disabled) onCommit(i) }}>
      {row.item.kind === 'slash' ? <SlashRow command={row.item.command} /> : row.item.kind === 'image'
        ? <ImageRow number={row.item.number} image={row.item.image} /> : <MentionRow entry={row.item.entry} />}
      {/* The preview that carries the reason is aria-hidden. */}
      {disabled ? <span className="tr-sr-only">{`Desativado. ${row.disabledReason}`}</span> : null}
    </div>
  }
  const statusRow = (content: ReactNode, className?: string): ReactNode => <div className={cn('tcx-status', className)} role="status">{content}</div>
  const loadingRow = statusRow(<><Spinner tone="muted" />Carregando…</>)
  let body: ReactNode
  if (!rows.length && loading) body = loadingRow
  // A failed load with nothing to show is an error, not "nothing matched".
  else if (!rows.length && loadFailed !== null) body = statusRow(<>
    <span className="tr-truncate" title={loadFailed}>Não foi possível carregar a lista.</span>
    <Button variant="muted" size="xs" className="tcx-retry" onClick={onRetry}>Tentar de novo</Button>
  </>, 'error')
  else if (!rows.length) body = statusRow(emptyLabel)
  else body = <>
    {sections.map((section) => sections.length > 1
      ? <div key={section.label} role="group" aria-label={section.label}>
        <div className="tcx-group" aria-hidden="true">{section.label}</div>
        {section.rows.map(renderRow)}
      </div>
      : section.rows.map(renderRow))}
    {loading ? loadingRow : null}
  </>

  // Every press inside keeps the editor focused (and the menu open).
  const keepFocus = (e: MouseEvent): void => { e.preventDefault() }
  return createPortal(<>
    <div ref={floatingRef} className="tcx-menu" data-slot="composer-menu" role="presentation" style={{ visibility: 'hidden' }} onMouseDown={keepFocus}>
      <div className="tcx-head">
        <div className="tcx-head-title">
          <span className="tcx-head-label">{header}</span>
          {fetching && !loading ? <Spinner tone="muted" className="tcx-head-spinner" /> : null}
        </div>
      </div>
      <div ref={listRef} id={listId} role="listbox" aria-label={header} className="tcx-list">{body}</div>
    </div>
    {preview ? <div ref={panelRef} className="tcx-preview" data-slot="mention-preview-panel" data-fits="false" role="presentation" aria-hidden="true" onMouseDown={keepFocus}>
      <div className="tcx-preview-scroll">
        {active?.disabledReason ? <div className="tcx-preview-disabled">
          <TriangleAlert aria-hidden="true" />
          <span><strong>Desativado</strong> — {active.disabledReason}</span>
        </div> : null}
        {preview}
      </div>
    </div> : null}
  </>, document.body)
}

/**
 * The preview sits beside the menu, top-aligned with the highlighted row:
 * right when there is room, else left, hidden when neither side fits a
 * readable panel (Traycer's right-start → left-start with a fit gate).
 */
function placePanel(menu: HTMLElement, list: HTMLElement | null, panel: HTMLElement | null, viewport: { width: number; height: number }): void {
  if (!panel) return
  const row = list?.querySelector<HTMLElement>('[data-active="true"]')
  const rowRect = row?.getBoundingClientRect()
  if (!rowRect || (!rowRect.width && !rowRect.height)) { panel.dataset.fits = 'false'; return }
  const menuRect = menu.getBoundingClientRect()
  const roomRight = viewport.width - menuRect.right - PANEL_GAP - VIEWPORT_PAD
  const roomLeft = menuRect.left - PANEL_GAP - VIEWPORT_PAD
  const width = Math.min(PANEL_MAX_WIDTH, viewport.width * 0.9)
  const right = roomRight >= width || roomRight >= roomLeft
  const fitted = Math.min(width, right ? roomRight : roomLeft)
  if (fitted < PANEL_MIN_WIDTH) { panel.dataset.fits = 'false'; return }
  panel.style.width = `${fitted}px`
  panel.style.maxHeight = `${Math.max(0, viewport.height - VIEWPORT_PAD * 2)}px`
  const top = Math.max(VIEWPORT_PAD, Math.min(rowRect.top, viewport.height - VIEWPORT_PAD - panel.offsetHeight))
  const left = right ? menuRect.right + PANEL_GAP : menuRect.left - PANEL_GAP - fitted
  panel.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`
  panel.dataset.fits = 'true'
}

function SlashRow({ command }: { command: SlashCommandItem }) {
  return <div className="tcx-item">
    <span className="tcx-cmd-name">{command.prefix}{command.name}</span>
    <span className="tcx-cmd-desc">
      {command.description}
      {command.argumentHint ? <span className="tcx-cmd-hint">{command.argumentHint}</span> : null}
    </span>
  </div>
}

function MentionRow({ entry }: { entry: MentionEntry }) {
  return <div className="tcx-item">
    <span className="tcx-mention-icon">{entry.kind === 'file' ? <FileTypeIcon name={entry.name} size={16} /> : <Folder size={16} aria-hidden="true" />}</span>
    <span className="tcx-mention-label">{entry.name}</span>
    {entry.dir ? <span className="tcx-mention-detail">{entry.dir}</span> : null}
  </div>
}

function ImageRow({ number, image }: { number: number; image: ChatImage }) {
  return <div className="tcx-item tcx-image-item">
    <img className="tcx-image-thumb" src={`data:${image.mime};base64,${image.data}`} alt="" />
    <span className="tcx-cmd-name">#image {number}</span>
    <span className="tcx-mention-detail">{image.name || 'Imagem anexada'}</span>
  </div>
}

/** The panel body for a row (Traycer's MentionPreview: text for commands, a path tree for files). */
function previewFor(row: ComposerMenuRow): ReactNode {
  if (row.item.kind === 'image') {
    const { number, image } = row.item
    return <>
      <img className="tcx-image-preview" src={`data:${image.mime};base64,${image.data}`} alt={image.name || `Imagem ${number}`} />
      <div className="tcx-preview-text">#image {number}</div>
      {image.name ? <div className="tcx-preview-footer">{image.name}</div> : null}
    </>
  }
  if (row.item.kind === 'slash') {
    const { description, argumentHint } = row.item.command
    const text = argumentHint ? `${description} ${argumentHint}` : description
    if (!text && !row.disabledReason) return null
    return text ? <div className="tcx-preview-text">{text}</div> : <></>
  }
  const entry = row.item.entry
  const tree = mentionPathTree(entry.rel, entry.kind === 'file')
  const dirs = [middleElideRootLabel(tree.rootLabel), ...tree.midDirs].filter((label) => label.length > 0)
  return <>
    <div className="tcx-tree">
      {dirs.map((label, depth) => <div key={`dir-${depth}`} className="tcx-tree-row" style={{ paddingLeft: depth * 16 }}>
        <Folder aria-hidden="true" /><span className="tcx-tree-label">{label}</span>
      </div>)}
      <div className="tcx-tree-row" style={{ paddingLeft: dirs.length * 16 }}>
        {tree.leafIsFile ? <FileTypeIcon name={tree.leaf} size={14} /> : <Folder aria-hidden="true" />}
        <span className="tcx-tree-label">{tree.leaf}</span>
      </div>
    </div>
    <div className="tcx-preview-footer">{entry.absolutePath}</div>
  </>
}
