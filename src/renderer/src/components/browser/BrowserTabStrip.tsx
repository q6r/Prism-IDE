import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type WheelEvent } from 'react'
import { ChevronDown, Plus, TriangleAlert, X } from 'lucide-react'
import { Button, DropdownMenu, DropdownMenuLabel, DropdownMenuRadioItem, Kbd, Spinner, Tooltip, cn } from '../ui'
import { BrowserFavicon } from './BrowserFavicon'
import { BrowserContextMenu, type ContextMenuRequest } from './BrowserContextMenu'
import { useBrowserStore, type BrowserTab } from './browserStore'
import { resolveTabTitle } from './browserModel'

const TAB_DRAG_TYPE = 'application/x-prism-browser-tab'

/**
 * Traycer's canvas tab strip (epic-canvas/canvas/tab-strip.tsx) for browser
 * tabs: 36px strip on the canvas, hairline-separated tabs, the active one on
 * the app background with the 2px primary accent on top, favicon + title,
 * close on hover, middle-click close, drag to reorder, double-click the empty
 * end for a new tab.
 */
export function BrowserTabStrip() {
  const tabs = useBrowserStore((s) => s.tabs)
  const activeId = useBrowserStore((s) => s.activeId)
  const openTab = useBrowserStore((s) => s.openTab)
  const activate = useBrowserStore((s) => s.activate)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [menu, setMenu] = useState<ContextMenuRequest | null>(null)
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const tabRefs = useRef(new Map<string, HTMLDivElement>())

  // Keep the active tab in view when it changes.
  useEffect(() => {
    if (activeId === null) return
    tabRefs.current.get(activeId)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeId])

  const onWheel = (event: WheelEvent<HTMLDivElement>): void => {
    const scroller = scrollerRef.current
    if (!scroller || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
    scroller.scrollLeft += event.deltaY
  }

  const dropIndexFor = (event: DragEvent<HTMLElement>, index: number): number => {
    const rect = event.currentTarget.getBoundingClientRect()
    return event.clientX < rect.left + rect.width / 2 ? index : index + 1
  }

  const onDrop = (event: DragEvent<HTMLElement>): void => {
    const id = event.dataTransfer.getData(TAB_DRAG_TYPE)
    if (id && dropIndex !== null) useBrowserStore.getState().moveTab(id, dropIndex)
    setDropIndex(null)
    setDraggingId(null)
  }

  const openMenu = (event: MouseEvent, tab: BrowserTab, index: number): void => {
    event.preventDefault()
    const store = useBrowserStore.getState()
    setMenu({
      x: event.clientX,
      y: event.clientY,
      entries: [
        { kind: 'item', label: 'Fechar', shortcut: 'Ctrl+W', onSelect: () => store.closeTab(tab.id) },
        { kind: 'item', label: 'Fechar outras', disabled: tabs.length < 2, onSelect: () => store.closeOthers(tab.id) },
        { kind: 'item', label: 'Fechar à direita', disabled: index >= tabs.length - 1, onSelect: () => store.closeRight(tab.id) },
        { kind: 'item', label: 'Fechar todas', onSelect: () => store.closeAll() },
        { kind: 'separator' },
        { kind: 'item', label: 'Recarregar', disabled: tab.initialSrc === null, onSelect: () => { store.activate(tab.id); store.navigate(tab.id, tab.url) } },
        { kind: 'item', label: 'Duplicar', onSelect: () => store.duplicate(tab.id) },
        { kind: 'item', label: 'Copiar endereço', disabled: tab.url === 'about:blank', onSelect: () => { void navigator.clipboard?.writeText(tab.url).catch(() => undefined) } },
        { kind: 'separator' },
        { kind: 'item', label: 'Reabrir aba fechada', shortcut: 'Ctrl+Shift+T', disabled: useBrowserStore.getState().closed.length === 0, onSelect: () => store.reopenClosed() }
      ]
    })
  }

  return (
    <div className="brw-strip" data-testid="browser-tab-strip">
      <div
        ref={scrollerRef}
        role="tablist"
        aria-label="Abas do navegador"
        className="brw-strip-tabs tr-no-scrollbar"
        onWheel={onWheel}
        onDoubleClick={(event) => { if (event.target === event.currentTarget) openTab() }}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes(TAB_DRAG_TYPE) || event.target !== event.currentTarget) return
          event.preventDefault()
          setDropIndex(tabs.length)
        }}
        onDragLeave={(event) => { if (event.target === event.currentTarget) setDropIndex(null) }}
        onDrop={onDrop}
      >
        {tabs.map((tab, index) => (
          <BrowserTabItem
            key={tab.id}
            tab={tab}
            index={index}
            active={tab.id === activeId}
            dragging={draggingId === tab.id}
            dropBefore={dropIndex === index && draggingId !== null}
            domRef={(el) => { if (el) tabRefs.current.set(tab.id, el); else tabRefs.current.delete(tab.id) }}
            onSelect={() => activate(tab.id)}
            onContextMenu={(event) => openMenu(event, tab, index)}
            onDragStart={(event) => {
              event.dataTransfer.setData(TAB_DRAG_TYPE, tab.id)
              event.dataTransfer.effectAllowed = 'move'
              setDraggingId(tab.id)
            }}
            onDragOver={(event) => {
              if (!event.dataTransfer.types.includes(TAB_DRAG_TYPE)) return
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
              setDropIndex(dropIndexFor(event, index))
            }}
            onDrop={onDrop}
            onDragEnd={() => { setDraggingId(null); setDropIndex(null) }}
          />
        ))}
        {dropIndex !== null && dropIndex >= tabs.length && draggingId !== null ? <span className="brw-drop-end" aria-hidden /> : null}
      </div>
      <div className={cn('brw-strip-actions', tabs.length === 0 && 'empty')}>
        <Tooltip label={<>Nova aba <Kbd>Ctrl+T</Kbd></>} side="bottom">
          <Button variant="ghost" size="icon-sm" aria-label="Nova aba" data-testid="browser-new-tab" onClick={() => openTab()}>
            <Plus />
          </Button>
        </Tooltip>
        <BrowserTabListMenu tabs={tabs} activeId={activeId} onSelect={activate} />
      </div>
      <BrowserContextMenu request={menu} onClose={() => setMenu(null)} />
    </div>
  )
}

function BrowserTabItem(props: {
  tab: BrowserTab
  index: number
  active: boolean
  dragging: boolean
  dropBefore: boolean
  domRef: (el: HTMLDivElement | null) => void
  onSelect: () => void
  onContextMenu: (event: MouseEvent) => void
  onDragStart: (event: DragEvent<HTMLDivElement>) => void
  onDragOver: (event: DragEvent<HTMLDivElement>) => void
  onDrop: (event: DragEvent<HTMLDivElement>) => void
  onDragEnd: () => void
}) {
  const { tab, active } = props
  const closeTab = useBrowserStore((s) => s.closeTab)
  const title = resolveTabTitle(tab.title, tab.url)
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      props.onSelect()
    } else if (event.key === 'Delete') {
      event.preventDefault()
      closeTab(tab.id)
    }
  }
  return (
    <div
      ref={props.domRef}
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      draggable
      data-active={active ? 'true' : 'false'}
      data-testid={`browser-tab-${tab.id}`}
      className={cn('brw-tab', active && 'active', props.dragging && 'dragging')}
      onClick={props.onSelect}
      onKeyDown={onKeyDown}
      onAuxClick={(event) => {
        // Middle-click closes.
        if (event.button !== 1) return
        event.preventDefault()
        closeTab(tab.id)
      }}
      onMouseDown={(event) => { if (event.button === 1) event.preventDefault() }}
      onContextMenu={props.onContextMenu}
      onDragStart={props.onDragStart}
      onDragOver={props.onDragOver}
      onDrop={props.onDrop}
      onDragEnd={props.onDragEnd}
    >
      {props.dropBefore ? <span className="brw-drop-line" aria-hidden /> : null}
      {active ? <span className="brw-tab-accent" aria-hidden /> : null}
      <BrowserTabIcon tab={tab} />
      <span className="brw-tab-label">
        <Tooltip
          label={
            <span className="brw-tab-tooltip">
              <span className="brw-tab-tooltip-title">{title}</span>
              {tab.url === 'about:blank' ? null : <span className="brw-tab-tooltip-url">{tab.url}</span>}
            </span>
          }
          side="bottom"
        >
          <span className="brw-tab-title" data-testid={`browser-tab-title-${tab.id}`}>
            <span className="tr-truncate">{title}</span>
          </span>
        </Tooltip>
        <span className="brw-tab-title-hover" aria-hidden>
          <span className="tr-truncate">{title}</span>
        </span>
      </span>
      <button
        type="button"
        className="brw-tab-close"
        aria-label={`Fechar ${title}`}
        data-testid={`browser-tab-close-${tab.id}`}
        onClick={(event) => {
          event.stopPropagation()
          closeTab(tab.id)
        }}
      >
        <X />
      </button>
    </div>
  )
}

function BrowserTabIcon({ tab }: { tab: BrowserTab }) {
  if (tab.status === 'crashed') {
    return (
      <Tooltip label="O navegador falhou. Abra para recuperar.">
        <span className="brw-tab-icon failed" role="img" aria-label="Falhou">
          <TriangleAlert />
        </span>
      </Tooltip>
    )
  }
  if (tab.loading && !tab.dormant) {
    return (
      <span className="brw-tab-icon">
        <Spinner tone="muted" label="Carregando" />
      </span>
    )
  }
  return <BrowserFavicon faviconUrl={tab.faviconUrl} className={cn('brw-tab-icon', tab.dormant && 'dormant')} />
}

/** The overflow list: every tab, whatever the strip has scrolled out of view. */
function BrowserTabListMenu({ tabs, activeId, onSelect }: { tabs: readonly BrowserTab[]; activeId: string | null; onSelect: (id: string) => void }) {
  return (
    <DropdownMenu
      align="end"
      side="bottom"
      className="brw-tab-list-menu"
      label="Abas abertas"
      trigger={
        <Button variant="ghost" size="icon-sm" aria-label="Abas abertas" data-testid="browser-tab-list">
          <ChevronDown />
        </Button>
      }
    >
      <DropdownMenuLabel>Abas abertas</DropdownMenuLabel>
      {tabs.map((tab) => (
        <DropdownMenuRadioItem key={tab.id} checked={tab.id === activeId} onSelect={() => onSelect(tab.id)}>
          <BrowserFavicon faviconUrl={tab.faviconUrl} className="brw-menu-favicon" />
          <span className="tr-truncate">{resolveTabTitle(tab.title, tab.url)}</span>
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenu>
  )
}
