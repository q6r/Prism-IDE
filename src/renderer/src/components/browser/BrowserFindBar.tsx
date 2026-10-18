import { useCallback, useEffect, useRef, type ChangeEvent, type KeyboardEvent } from 'react'
import { CaseSensitive, ChevronDown, ChevronUp, X } from 'lucide-react'
import { Button, cn } from '../ui'
import { tabHandle } from './browserBridge'
import { findStatusLabel } from './browserModel'
import { useBrowserStore, type BrowserTab } from './browserStore'

// Keystrokes coalesce into one search: a page re-highlights its active match on
// every findInPage, which flashes while typing (Traycer's 80ms window).
const TYPED_FIND_QUERY_DEBOUNCE_MS = 80

/** tab id → the last find-focus request already acted on. */
const handledFindFocus = new Map<string, number>()

/**
 * Traycer's TileFindBar (overlay placement) for a browser tab: a floating
 * popover in the top-right corner with the query, the match counter, match
 * case, previous/next and close. Enter / Shift+Enter and Ctrl+G walk matches,
 * Escape closes.
 */
export function BrowserFindBar({ tab }: { tab: BrowserTab }) {
  const find = tab.find
  const setFind = useBrowserStore((s) => s.setFind)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const debounceRef = useRef<number | null>(null)

  // One-shot per Ctrl+F: switching back to a tab with the bar open leaves focus alone.
  useEffect(() => {
    if (!find.open || handledFindFocus.get(tab.id) === find.focusNonce) return
    handledFindFocus.set(tab.id, find.focusNonce)
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [find.open, find.focusNonce, tab.id])

  const cancelPending = useCallback(() => {
    if (debounceRef.current === null) return
    window.clearTimeout(debounceRef.current)
    debounceRef.current = null
  }, [])
  useEffect(() => cancelPending, [cancelPending])

  const runSearch = useCallback(
    (query: string, matchCase: boolean) => {
      const handle = tabHandle(tab.id)
      if (query.length === 0) {
        handle?.stopFind()
        setFind(tab.id, { current: 0, total: 0, searching: false })
        return
      }
      setFind(tab.id, { searching: true })
      // A new query starts a fresh find session (Electron: findNext true).
      handle?.find(query, { forward: true, findNext: true, matchCase })
    },
    [setFind, tab.id]
  )

  /** Runs a still-pending debounced search now; true when one was flushed. */
  const flushPending = useCallback((): boolean => {
    if (debounceRef.current === null) return false
    cancelPending()
    runSearch(find.query, find.matchCase)
    return true
  }, [cancelPending, find.matchCase, find.query, runSearch])

  const navigate = (direction: 1 | -1): void => {
    if (flushPending() || find.query.length === 0) return
    // A follow-up inside the active session (Electron: findNext false).
    tabHandle(tab.id)?.find(find.query, { forward: direction === 1, findNext: false, matchCase: find.matchCase })
  }

  const close = (): void => {
    cancelPending()
    tabHandle(tab.id)?.stopFind()
    setFind(tab.id, { open: false, current: 0, total: 0, searching: false })
    tabHandle(tab.id)?.focusPage()
  }

  const onChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const query = event.target.value
    setFind(tab.id, { query })
    cancelPending()
    if (query.length === 0) {
      runSearch('', find.matchCase)
      return
    }
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null
      runSearch(query, find.matchCase)
    }, TYPED_FIND_QUERY_DEBOUNCE_MS)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      navigate(event.shiftKey ? -1 : 1)
      return
    }
    if (event.key.toLowerCase() === 'g' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      event.stopPropagation()
      navigate(event.shiftKey ? -1 : 1)
    }
  }

  if (!find.open) return null
  const label = findStatusLabel(find.query, find.searching, find.current, find.total)
  const noMatches = !find.searching && find.query.length > 0 && find.total === 0
  const canNavigate = find.query.length > 0
  return (
    <search className="brw-find" aria-label="Localizar na página" data-testid="browser-find-bar">
      <input
        ref={inputRef}
        type="text"
        value={find.query}
        onChange={onChange}
        onKeyDown={onKeyDown}
        placeholder="Localizar"
        aria-label="Localizar na página"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        className="brw-find-input"
      />
      {label === null ? null : (
        <span className={cn('brw-find-status', noMatches && 'none')} data-status={find.searching ? 'searching' : 'idle'} role="status">
          {label}
        </span>
      )}
      <Button
        variant={find.matchCase ? 'secondary' : 'ghost'}
        size="icon-sm"
        aria-label="Diferenciar maiúsculas e minúsculas"
        aria-pressed={find.matchCase}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          cancelPending()
          const matchCase = !find.matchCase
          setFind(tab.id, { matchCase })
          runSearch(find.query, matchCase)
        }}
      >
        <CaseSensitive />
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label="Resultado anterior" disabled={!canNavigate} onMouseDown={(event) => event.preventDefault()} onClick={() => navigate(-1)}>
        <ChevronUp />
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label="Próximo resultado" disabled={!canNavigate} onMouseDown={(event) => event.preventDefault()} onClick={() => navigate(1)}>
        <ChevronDown />
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label="Fechar busca" onMouseDown={(event) => event.preventDefault()} onClick={close}>
        <X />
      </Button>
    </search>
  )
}
