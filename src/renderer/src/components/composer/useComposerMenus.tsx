import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAgentChats } from '../../lib/agentChats'
import { useStore } from '../../store'
import type { AgentSelection, UnifiedChat } from '../../../../shared/agents'
import { routeKey, sameRemoteTarget } from '../../../../shared/agents'
import type { ImageReference } from '../../../../shared/imageReferences'
import {
  applyCompletion, buildCommandSections, diskCommandItems, findTrigger, imageReferenceInsertion, imageReferenceRemoval, mentionEntries, mentionText, nativeCommandItems, prismCommands,
  rankImageReferences, rankMentions, rebaseInsertionPoint, relativeTo, removalRange, triggerKey, wrapIndex, type DiskCommand, type NativeCommand
} from '../../lib/composerMenu'
import { attachOpenFileForTemplate, runPrismCommand } from '../../lib/composerCommands'
import ComposerMenu, { menuRowId, type ComposerMenuRow, type ComposerMenuSection } from './ComposerMenu'
import { caretClientRect } from './caret'

export interface ComposerMenuChat {
  readonly id: string
  readonly cwd: string
  readonly readOnly: boolean
  readonly selection: AgentSelection
  readonly remoteId?: string
  readonly remoteTarget?: UnifiedChat['remoteTarget']
}

interface Load<T> {
  readonly data: T | null
  readonly loading: boolean
  readonly fetching: boolean
  readonly error: string | null
  readonly retry: () => void
}

type Files = { path: string; rel: string }[]
// Per source for the app's lifetime: reopening a menu shows the last list at
// once and refreshes it behind (Traycer's placeholderData + header spinner).
const fileCache = new Map<string, Files>()
const commandCache = new Map<string, DiskCommand[]>()
const nativeCache = new Map<string, NativeCommand[]>()

/**
 * Fetches `key` each time the menu that needs it opens, serving the cached
 * copy meanwhile. `refresh` is true for a fetch the user asked to retry.
 */
function useCachedLoad<T>(key: string | null, enabled: boolean, cache: Map<string, T>, fetch: (refresh: boolean) => Promise<T>): Load<T> {
  const [state, setState] = useState<{ key: string | null; fetching: boolean; error: string | null; data: T | null }>({ key: null, fetching: false, error: null, data: null })
  const [attempt, setAttempt] = useState(0)
  const fetchRef = useRef(fetch)
  fetchRef.current = fetch
  const retrying = useRef(false)
  useEffect(() => {
    if (!enabled || key === null) return
    let alive = true
    const refresh = retrying.current
    retrying.current = false
    setState({ key, fetching: true, error: null, data: cache.get(key) ?? null })
    fetchRef.current(refresh).then((data) => {
      cache.set(key, data)
      if (alive) setState({ key, fetching: false, error: null, data })
    }, (err: unknown) => {
      if (alive) setState({ key, fetching: false, error: err instanceof Error ? err.message : String(err), data: cache.get(key) ?? null })
    })
    return () => { alive = false }
  }, [enabled, key, attempt])
  const mine = state.key === key
  const data = mine ? state.data : key !== null ? cache.get(key) ?? null : null
  const fetching = mine && state.fetching
  return { data, loading: fetching && data === null, fetching: fetching && data !== null, error: mine ? state.error : null,
    retry: () => { retrying.current = true; setAttempt((n) => n + 1) } }
}

/**
 * Replaces `[start, end)` in the textarea. execCommand keeps the edit on the
 * native undo stack and fires the same input event typing does, so the
 * draft, autosize and menus all follow; the fallback writes the draft directly.
 */
function replaceText(el: HTMLTextAreaElement, start: number, end: number, text: string, fallback: (value: string, caret: number) => void): void {
  el.focus()
  el.setSelectionRange(start, end)
  const ok = start === end && !text ? true : document.execCommand(text ? 'insertText' : 'delete', false, text)
  if (!ok) {
    const next = applyCompletion(el.value, start, end, text)
    fallback(next.text, next.caret)
  }
}

/**
 * The composer's `/` and `@` menus over its textarea (Traycer's composer
 * picker store + suggestion render, without tiptap). Returns the handlers the
 * textarea needs and the menu element to render.
 */
export function useComposerMenus({ inputRef, chat, draft, busy, images }: {
  inputRef: RefObject<HTMLTextAreaElement | null>
  chat: ComposerMenuChat | null
  draft: string
  busy: boolean
  images: readonly ImageReference[]
}): {
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean
  onInput: (el: HTMLTextAreaElement) => void
  insertImageReference: (number: number) => void
  insertImageReferencesAt: (numbers: readonly number[], at: number, expectedChatId: string) => boolean
  removeImageReference: (number: number, expectedChatId: string) => boolean
  inputProps: {
    onSelect: (e: { currentTarget: HTMLTextAreaElement }) => void
    onFocus: (e: { currentTarget: HTMLTextAreaElement }) => void
    onBlur: () => void
    'aria-autocomplete': 'list'
    'aria-controls': string | undefined
    'aria-activedescendant': string | undefined
  }
  menu: ReactNode
} {
  const listId = `${useId()}-composer-menu`
  const [caret, setCaret] = useState<number | null>(null)
  const [focused, setFocused] = useState(false)
  // The occurrence Esc closed: it stays closed until the token goes away.
  const [dismissed, setDismissed] = useState<string | null>(null)
  // The highlighted row, kept by id while the query stays the same.
  const [highlight, setHighlight] = useState<{ query: string; id: string | null }>({ query: '', id: null })
  const pendingCaret = useRef<number | null>(null)

  const chatId = chat?.id ?? null
  useEffect(() => { setCaret(null); setDismissed(null) }, [chatId])

  const trigger = useMemo(() => focused && caret !== null && chat && !chat.readOnly ? findTrigger(draft, caret) : null,
    [focused, caret, draft, chat?.readOnly, chatId])
  const key = triggerKey(trigger)
  useEffect(() => { if (dismissed !== null && dismissed !== key) setDismissed(null) }, [key, dismissed])
  const open = trigger !== null && key !== dismissed
  const kind = open ? trigger.kind : null

  // ---- `/` catalog ----
  const provider = chat?.selection.provider === 'codex' ? 'codex' : 'claude'
  const remote = !!chat?.remoteId
  const canCompact = useAgentChats((s) => {
    const c = s.chats.find((x) => x.id === chatId)
    return !!c?.resume && c.resume.route === routeKey(c.selection)
  })
  const hasOpenFile = useStore((s) => { const t = s.tabs.find((x) => x.path === s.activePath); return !!t && t.kind !== 'media' })
  // The provider's own catalog (Claude's built-ins, custom commands and
  // skills; Codex's skills). The server's is out of reach over SSH.
  const nativeKey = chat && !remote ? `native:${provider}:${chat.selection.profileId}:${chat.cwd}` : null
  const native = useCachedLoad(nativeKey, kind === 'slash', nativeCache,
    (refresh) => chat ? window.prism.agentCommands.list(provider, chat.selection.profileId, chat.cwd, refresh) : Promise.resolve([]))
  // Claude's commands and skills read from disk: shown at once while the
  // native catalog starts up, and kept if it fails.
  const diskKey = chat && provider === 'claude' && !remote ? `commands:${chat.cwd}` : null
  const disk = useCachedLoad(diskKey, kind === 'slash', commandCache,
    () => window.prism.commands.list(chat?.cwd || undefined))
  const nativeReady = native.data !== null

  // ---- `@` files ----
  const liveRemote = useStore((s) => s.remote)
  const remoteReady = !remote || (!!liveRemote && sameRemoteTarget(chat?.remoteTarget, { host: liveRemote.host, port: liveRemote.port, username: liveRemote.username }))
  const filesKey = chat?.cwd && remoteReady ? remote ? `ssh:${liveRemote?.id}:${chat.cwd}` : `local:${chat.cwd}` : null
  const files = useCachedLoad(filesKey, kind === 'mention', fileCache, () => {
    if (!chat?.cwd) return Promise.resolve([])
    return remote && liveRemote ? window.prism.ssh.fs.listFiles(liveRemote.id, chat.cwd) : window.prism.fs.listFiles(chat.cwd)
  })
  const openPaths = useStore(useShallow((s) => [s.activePath, ...s.tabs.map((t) => t.path)].filter((p): p is string => !!p)))
  const entries = useMemo(() => files.data && chat?.cwd ? mentionEntries(files.data, chat.cwd) : [], [files.data, chat?.cwd])

  const sections = useMemo<ComposerMenuSection[]>(() => {
    if (!trigger || !open || !chat) return []
    if (trigger.kind === 'image') {
      return [{ label: 'Imagens desta conversa', rows: rankImageReferences(images, trigger.query).map(({ number, image }): ComposerMenuRow => ({
        id: `image:${number}`, disabledReason: null, item: { kind: 'image', number, image }
      })) }]
    }
    if (trigger.kind === 'slash') {
      const nativeCompact = provider === 'claude' && !!native.data?.some((c) => c.name.replace(/^\//, '') === 'compact')
      const catalog = [...prismCommands({ provider, busy, canCompact, hasOpenFile, nativeCompact }), ...(native.data
        ? nativeCommandItems(native.data, { provider, remote }) : diskCommandItems(disk.data ?? [], { provider, remote }))]
      return buildCommandSections(catalog, trigger.query, trigger.leading).map((s) => ({
        label: s.label,
        rows: s.items.map((command): ComposerMenuRow => ({ id: command.id, disabledReason: command.disabledReason, item: { kind: 'slash', command } }))
      }))
    }
    const pinned = openPaths.map((p) => relativeTo(chat.cwd, p)).filter((p): p is string => !!p)
    return [{ label: 'Arquivos', rows: rankMentions(entries, trigger.query, pinned).map((entry): ComposerMenuRow => ({ id: entry.id, disabledReason: null, item: { kind: 'mention', entry } })) }]
  }, [trigger, open, chat, provider, remote, busy, canCompact, hasOpenFile, native.data, disk.data, entries, openPaths, images])
  const rows = useMemo(() => sections.flatMap((s) => s.rows), [sections])
  const queryKey = trigger ? `${key}|${trigger.query}` : ''
  const activeIndex = highlight.query === queryKey && highlight.id !== null ? Math.max(0, rows.findIndex((r) => r.id === highlight.id)) : 0
  // While the provider's catalog loads for the first time the rows already
  // known show with a loading row under them (Traycer's rows + "Loading…").
  const load = kind === 'image' ? { loading: false, fetching: false, error: null, retry: () => {} } : kind === 'mention' ? files : native
  const { loading, fetching } = load

  // The fallback edit path restores the caret once the new draft is rendered.
  useLayoutEffect(() => {
    const el = inputRef.current
    if (el && pendingCaret.current !== null) { el.setSelectionRange(pendingCaret.current, pendingCaret.current); setCaret(pendingCaret.current); pendingCaret.current = null }
  }, [draft])

  const focusEditor = (): void => { requestAnimationFrame(() => inputRef.current?.focus()) }
  const commit = (index: number): void => {
    const row = rows[index]
    const el = inputRef.current
    if (!row || row.disabledReason !== null || !el || !trigger || !chat) return
    const id = chat.id
    const fallback = (value: string, at: number): void => { pendingCaret.current = at; useAgentChats.getState().draft(id, value) }
    if (row.item.kind === 'image') { replaceText(el, trigger.start, trigger.end, `#image ${row.item.number} `, fallback); return }
    if (row.item.kind === 'mention') { replaceText(el, trigger.start, trigger.end, `${mentionText(row.item.entry)} `, fallback); return }
    const command = row.item.command
    if (command.action === 'insert') { replaceText(el, trigger.start, trigger.end, `${command.prefix}${command.name} `, fallback); return }
    if (command.action === 'template') {
      replaceText(el, trigger.start, trigger.end, command.template ?? '', fallback)
      attachOpenFileForTemplate(id)
      return
    }
    // A Prism action: its token leaves the prompt, the rest of the text stays.
    const range = removalRange(el.value, trigger)
    replaceText(el, range.start, range.end, '', fallback)
    if (!el.value.trim() && el.value) useAgentChats.getState().draft(id, '')
    runPrismCommand(command.name, id, focusEditor)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || e.nativeEvent.isComposing) return false
    const activeRow = rows[activeIndex]
    const handled = (): true => { e.preventDefault(); return true }
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        if (!rows.length) return false
        const next = wrapIndex(activeIndex, e.key === 'ArrowDown' ? 1 : -1, rows.length)
        setHighlight({ query: queryKey, id: rows[next].id })
        return handled()
      }
      case 'Enter':
        if (e.shiftKey) return false
        // Nothing to choose. With the provider's catalog in hand the menu
        // lists everything it accepts, so Enter is swallowed as in Traycer;
        // without it (SSH, a failed load) the text goes out as typed, so a
        // command the menu cannot list still works.
        if (!rows.length) return kind === 'image' || loading || (kind === 'slash' && nativeReady) ? handled() : false
        if (activeRow.disabledReason === null) commit(activeIndex)
        return handled()
      case 'Tab':
        if (e.shiftKey || !rows.length) return false
        if (activeRow.disabledReason === null) commit(activeIndex)
        return handled()
      case 'Escape':
        setDismissed(key)
        e.stopPropagation()
        return handled()
    }
    return false
  }

  const syncCaret = (el: HTMLTextAreaElement): void => { setCaret(el.selectionStart === el.selectionEnd ? el.selectionStart : null) }
  const menu = open && chat ? <ComposerMenu
    listId={listId}
    header={kind === 'image' ? 'Imagens desta conversa' : kind === 'slash' ? 'Comandos' : 'Arquivos'}
    emptyLabel={kind === 'slash' ? 'Nenhum comando corresponde'
      : kind === 'image' ? images.length ? 'Nenhuma imagem corresponde' : 'Anexe uma imagem para mencioná-la aqui.'
      : !chat.cwd ? 'Abra uma pasta de projeto para mencionar arquivos.'
      : !remoteReady ? 'Reconecte o servidor para mencionar arquivos deste chat.'
      : 'Nenhum arquivo corresponde'}
    sections={sections}
    activeIndex={activeIndex}
    loading={loading}
    fetching={fetching}
    loadFailed={load.error}
    onRetry={load.retry}
    getAnchor={() => inputRef.current && trigger ? caretClientRect(inputRef.current, trigger.start) : null}
    onHover={(index) => { if (rows[index]) setHighlight({ query: queryKey, id: rows[index].id }) }}
    onCommit={commit}
  /> : null

  return {
    onKeyDown,
    onInput: syncCaret,
    insertImageReference: (number) => {
      const el = inputRef.current
      if (!el || !chat) return
      const at = el.selectionStart
      const current = findTrigger(el.value, at)
      const start = current?.kind === 'image' ? current.start : at
      const end = current?.kind === 'image' ? current.end : el.selectionEnd
      const prefix = start > 0 && !/\s/.test(el.value[start - 1]) ? ' ' : ''
      replaceText(el, start, end, `${prefix}#image ${number} `, (value, caret) => {
        pendingCaret.current = caret
        useAgentChats.getState().draft(chat.id, value)
      })
    },
    insertImageReferencesAt: (numbers, at, expectedChatId) => {
      const el = inputRef.current
      const state = useAgentChats.getState()
      const current = state.chats.find(c => c.id === chat?.id)
      // A file may finish reading after the user switched chats. The caller
      // writes that chat's stored draft instead of touching the visible editor.
      if (!el || !chat || chat.id !== expectedChatId || state.activeId !== chat.id || !current || el.value !== (current.draft || '')) return false
      const before = el.value
      const insertion = imageReferenceInsertion(before, at, numbers)
      const selection = { start: el.selectionStart, end: el.selectionEnd }
      const caret = selection.start === at && selection.end === at ? insertion.caret : rebaseInsertionPoint(before, insertion.text, selection.end, 'right')
      replaceText(el, at, at, insertion.insert, (value) => {
        pendingCaret.current = caret
        useAgentChats.getState().draft(chat.id, value)
      })
      // Reading is asynchronous: preserve a caret/selection the user moved
      // meanwhile instead of dragging it back to the image's old position.
      if (el.value === insertion.text) {
        const start = selection.start === at && selection.end === at ? caret : rebaseInsertionPoint(before, insertion.text, selection.start, 'right')
        el.setSelectionRange(start, caret)
        syncCaret(el)
      }
      return true
    },
    removeImageReference: (number, expectedChatId) => {
      const el = inputRef.current
      const state = useAgentChats.getState()
      const current = state.chats.find(c => c.id === chat?.id)
      if (!el || !chat || chat.id !== expectedChatId || state.activeId !== chat.id || !current || el.value !== (current.draft || '')) return false
      const removal = imageReferenceRemoval(el.value, number)
      if (!removal) return true
      const caret = rebaseInsertionPoint(el.value, removal.text, el.selectionEnd, 'right')
      replaceText(el, removal.start, removal.end, removal.insert, (value) => {
        pendingCaret.current = caret
        useAgentChats.getState().draft(chat.id, value)
      })
      if (el.value === removal.text) { el.setSelectionRange(caret, caret); syncCaret(el) }
      return true
    },
    inputProps: {
      onSelect: (e) => syncCaret(e.currentTarget),
      onFocus: (e) => { setFocused(true); syncCaret(e.currentTarget) },
      // Clicking anywhere outside closes the menu; its own rows never take focus.
      onBlur: () => setFocused(false),
      'aria-autocomplete': 'list',
      'aria-controls': open ? listId : undefined,
      'aria-activedescendant': open && rows.length ? menuRowId(listId, activeIndex) : undefined
    },
    menu
  }
}
