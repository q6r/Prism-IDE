import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { Tooltip, cn } from './ui'
import { buildTree, flattenTree, type TreeNode } from './agents-list/model'
import '../styles/agents-list.css'

export interface ChatTreeItem { id: string; parentChatId?: string; title: string; archived?: boolean }
export interface ChatTreeRowContext<T> { readonly hasChildren: boolean; readonly expanded: boolean; readonly depth: number; readonly descendants: readonly T[] }
export interface ChatTreeRename { readonly id: string; readonly value: string; readonly onChange: (value: string) => void; readonly onCommit: () => void; readonly onCancel: () => void }

// Traycer's tree geometry (epic-sidebar-tree-shared): 16px per level, 8px base, rail 7px into the chevron column.
const INDENT_PX = 16, BASE_PAD_LEFT = 8, GUIDE_OFFSET_PX = 7

interface Renderers<T> {
  readonly onSelect: (id: string) => void
  readonly toggle: (id: string, open: boolean) => void
  readonly icon: (item: T, ctx: ChatTreeRowContext<T>) => ReactNode
  readonly trailing?: (item: T, ctx: ChatTreeRowContext<T>) => ReactNode
  readonly controls?: (item: T) => ReactNode
  readonly controlSlots?: (item: T) => 0 | 1 | 2
  readonly tooltip?: (item: T) => ReactNode
  readonly rowLabel?: (item: T) => string
  readonly onRowDoubleClick?: (item: T) => void
  readonly onRowContextMenu?: (item: T, point: { x: number; y: number }, row: HTMLElement) => void
}

/**
 * The agents tree (epic-sidebar-chat-tree): one row per chat, children nested
 * under their parent with an indent rail per group, a chevron to fold a
 * branch, the row's status glyph, title and trailing time, and hover controls
 * beside the row. A search keeps matches and their ancestors, all unfolded.
 *
 * Rows are memoized on their subtree's items: pass stable callbacks (and the
 * same item objects for unchanged rows) and only rows that changed re-render.
 */
export default function ChatTree<T extends ChatTreeItem>({ items, activeId, query = '', label, isOpen, onToggle, onSelect,
  icon, trailing, controls, controlSlots, tooltip, rowLabel, onRowDoubleClick, onRowContextMenu, rename }: {
  items: T[]
  activeId?: string | null
  query?: string
  label: string
  /** Controlled branch state; without it every branch starts open and the tree keeps its own state. */
  isOpen?: (id: string, depth: number) => boolean
  onToggle?: (id: string, open: boolean) => void
  onSelect: (id: string) => void
  /** The row's status glyph; renders into a fixed 18px slot. */
  icon: (item: T, ctx: ChatTreeRowContext<T>) => ReactNode
  trailing?: (item: T, ctx: ChatTreeRowContext<T>) => ReactNode
  /** Hover-revealed controls laid over the row's right edge (archive, "…"). */
  controls?: (item: T) => ReactNode
  /** How many 24px controls the row reserves room for on hover. */
  controlSlots?: (item: T) => 0 | 1 | 2
  tooltip?: (item: T) => ReactNode
  rowLabel?: (item: T) => string
  /** Double-click or F2 on a row. */
  onRowDoubleClick?: (item: T) => void
  /** Right-click, the context-menu key or Shift+F10 on a row; `point` is where to open the menu. */
  onRowContextMenu?: (item: T, point: { x: number; y: number }, row: HTMLElement) => void
  rename?: ChatTreeRename | null
}) {
  const [own, setOwn] = useState<ReadonlySet<string>>(new Set())
  const open = useMemo(() => isOpen ?? ((id: string) => !own.has(id)), [isOpen, own])
  const toggleRef = useRef(onToggle)
  toggleRef.current = onToggle
  const toggle = useMemo(() => (id: string, next: boolean): void => {
    if (toggleRef.current) toggleRef.current(id, next)
    else setOwn((prev) => { const s = new Set(prev); if (next) s.delete(id); else s.add(id); return s })
  }, [])
  const tree = useMemo(() => buildTree(items, { query, isOpen: open }), [items, query, open])
  const flat = useMemo(() => flattenTree(tree), [tree])
  const root = useRef<HTMLUListElement>(null)
  const focusId = flat.some((n) => n.item.id === activeId) ? activeId : flat[0]?.item.id
  const r = useMemo<Renderers<T>>(() => ({ onSelect, toggle, icon, trailing, controls, controlSlots, tooltip, rowLabel, onRowDoubleClick, onRowContextMenu }),
    [onSelect, toggle, icon, trailing, controls, controlSlots, tooltip, rowLabel, onRowDoubleClick, onRowContextMenu])

  // Leaving a rename (Enter, Esc or blur) hands focus back to its row rather than the page.
  const renaming = rename?.id ?? null
  const lastRename = useRef<string | null>(null)
  useEffect(() => {
    const was = lastRename.current
    lastRename.current = renaming
    if (!was || renaming) return
    const active = document.activeElement
    if (active && active !== document.body && !root.current?.contains(active)) return
    root.current?.querySelector<HTMLElement>(`.al-row[data-node-id="${CSS.escape(was)}"]`)?.focus({ preventScroll: true })
  }, [renaming])

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>): void => {
    const target = e.target as HTMLElement
    if (!target.matches('.al-row')) return
    const index = flat.findIndex((n) => n.item.id === target.dataset.nodeId)
    if (index < 0) return
    const node = flat[index]
    const focusAt = (i: number): void => root.current?.querySelector<HTMLElement>(`.al-row[data-node-id="${CSS.escape(flat[Math.max(0, Math.min(flat.length - 1, i))].item.id)}"]`)?.focus()
    if (e.key === 'ArrowDown') { e.preventDefault(); focusAt(index + 1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusAt(index - 1) }
    else if (e.key === 'Home') { e.preventDefault(); focusAt(0) }
    else if (e.key === 'End') { e.preventDefault(); focusAt(flat.length - 1) }
    else if (e.key === 'ArrowRight' && node.hasChildren) { e.preventDefault(); if (!node.expanded) toggle(node.item.id, true); else focusAt(index + 1) }
    else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      if (node.hasChildren && node.expanded && !query) toggle(node.item.id, false)
      else { const parent = flat.findIndex((n) => n.item.id === node.item.parentChatId); if (parent >= 0) focusAt(parent) }
    } else if (e.key === 'F2' && onRowDoubleClick) { e.preventDefault(); onRowDoubleClick(node.item) }
    else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      if (!onRowContextMenu) return
      e.preventDefault()
      const box = target.getBoundingClientRect()
      onRowContextMenu(node.item, { x: box.left + 24, y: box.bottom }, target)
    }
  }

  return <ul ref={root} role="tree" aria-label={label} className="al-tree" onKeyDown={onKeyDown}>
    {tree.map((node) => <TreeRow<T> key={node.item.id} node={node} activeId={activeId ?? null} focusId={focusId ?? null} searching={!!query}
      rename={inSubtree(node, rename) ? rename! : null} r={r} />)}
  </ul>
}

function inSubtree<T extends ChatTreeItem>(node: TreeNode<T>, rename: ChatTreeRename | null | undefined): boolean {
  return !!rename && (node.item.id === rename.id || node.descendants.some((d) => d.id === rename.id))
}
/** Same rows, same order, same open state, all the way down. */
function sameSubtree<T>(a: TreeNode<T>, b: TreeNode<T>): boolean {
  if (a === b) return true
  return a.item === b.item && a.depth === b.depth && a.hasChildren === b.hasChildren && a.expanded === b.expanded
    && a.descendants.length === b.descendants.length && a.descendants.every((d, i) => d === b.descendants[i])
    && a.children.length === b.children.length && a.children.every((c, i) => sameSubtree(c, b.children[i]))
}
interface TreeRowProps<T> {
  readonly node: TreeNode<T>
  readonly activeId: string | null
  readonly focusId: string | null
  readonly searching: boolean
  readonly rename: ChatTreeRename | null
  readonly r: Renderers<T>
}

const TreeRow = memo(function TreeRow<T extends ChatTreeItem>({ node, activeId, focusId, searching, rename, r }: TreeRowProps<T>) {
  const { item, depth, hasChildren, expanded } = node
  const ctx: ChatTreeRowContext<T> = { hasChildren, expanded, depth, descendants: node.descendants }
  const active = item.id === activeId
  const padding: CSSProperties = { paddingLeft: depth * INDENT_PX + BASE_PAD_LEFT }
  const chevron = hasChildren
    ? <span aria-hidden="true" className={cn('al-chevron', expanded && 'open')} onClick={(e) => { e.stopPropagation(); if (!searching) r.toggle(item.id, !expanded) }}><ChevronRight /></span>
    : <span aria-hidden="true" className="al-chevron-spacer" />
  const renaming = rename?.id === item.id
  const row = renaming
    ? <div className={cn('al-row al-row-rename', item.archived && 'archived')} style={padding} data-node-id={item.id}>
      <span aria-hidden="true" className="al-chevron-spacer" />
      <span className="al-row-icon">{r.icon(item, ctx)}</span>
      <input className="al-rename-input" autoFocus value={rename.value} maxLength={100} aria-label={`Renomear ${item.title}`}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => rename.onChange(e.target.value)} onBlur={rename.onCommit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); rename.onCommit() }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); rename.onCancel() }
        }} />
    </div>
    : <button type="button" className={cn('al-row', active && 'active', item.archived && 'archived')} style={padding} data-node-id={item.id}
      tabIndex={item.id === focusId ? 0 : -1}
      aria-label={r.rowLabel?.(item) ?? (item.archived ? `${item.title}, arquivado` : item.title)}
      onClick={() => r.onSelect(item.id)} onDoubleClick={() => r.onRowDoubleClick?.(item)}
      onContextMenu={r.onRowContextMenu ? (e) => { e.preventDefault(); r.onRowContextMenu!(item, { x: e.clientX, y: e.clientY }, e.currentTarget) } : undefined}>
      {chevron}
      <span className="al-row-icon">{r.icon(item, ctx)}</span>
      <span className="al-row-line">
        {item.archived ? <span className="al-archived-prefix"><b>Arquivado</b><span aria-hidden="true">·</span></span> : null}
        <span className="al-row-title">{item.title}</span>
        {r.trailing ? <span className="al-row-trailing">{r.trailing(item, ctx)}</span> : null}
      </span>
    </button>
  const tip = !renaming && r.tooltip ? r.tooltip(item) : null
  return <li role="treeitem" aria-selected={active} aria-level={depth + 1} aria-expanded={hasChildren ? expanded : undefined}>
    <div className="al-row-wrap" data-slots={renaming ? 0 : r.controlSlots?.(item) ?? (r.controls ? 1 : 0)}>
      {tip ? <Tooltip label={tip} side="right" align="start" delay={700}>{row}</Tooltip> : row}
      {!renaming && r.controls ? r.controls(item) : null}
    </div>
    {node.children.length ? <ul role="group" className="al-group">
      <span aria-hidden="true" className="al-guide" style={{ left: depth * INDENT_PX + BASE_PAD_LEFT + GUIDE_OFFSET_PX }} />
      {node.children.map((child) => <TreeRow<T> key={child.item.id} node={child} activeId={activeId} focusId={focusId} searching={searching}
        rename={inSubtree(child, rename) ? rename : null} r={r} />)}
    </ul> : null}
  </li>
}, (a, b) => a.activeId === b.activeId && a.focusId === b.focusId && a.searching === b.searching && a.rename === b.rename && a.r === b.r
  && sameSubtree(a.node, b.node)) as <T extends ChatTreeItem>(props: TreeRowProps<T>) => ReactNode
