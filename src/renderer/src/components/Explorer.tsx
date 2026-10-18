import {
  useCallback,
  useEffect,
  useRef,
  useMemo,
  type CSSProperties,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type DragEvent as ReactDragEvent
} from 'react'
import {
  ChevronDown, FolderOpen, FilePlus, FolderPlus, RefreshCw, Trash2, Pencil,
  Scissors, Copy, ClipboardPaste, CopyPlus, SquareTerminal, ExternalLink,
  Search, X, LocateFixed, ChevronsDownUp
} from 'lucide-react'
import { useStore } from '../store'
import { fsApi } from '../lib/fsApi'
import { dirname, joinPath, basename } from '../lib/lang'
import { FileTypeIcon, FileTreeChevron, FileIconSpriteSheet } from '../lib/fileIcon'
import { Button, Tooltip, DropdownMenu, DropdownMenuItem, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuShortcut, InputGroup, InputAddon, Spinner } from './ui'
import { ancestorDirectories, filterFileTreeSearchIndex, prepareFileTreeSearchIndex, flattenVisibleEntries, gitDecoration, isWithinPath, pathKey, relativeTreePath, sameTreeEntries, sortTreeEntries, isFileTreeSearchTruncated, reconcileFileTreeSearchSnapshot, reconcileTreeGitSnapshot, type TreeGitDecoration, type TreeGitSnapshot, type FileTreeSearchSnapshot } from './files/fileTreeModel'
import '../styles/files.css'
import { FileTreeName } from './files/FileTreeName'
import { FileDeleteDialog } from './files/FileDeleteDialog'
import { deleteConfirmedTreeEntry } from './files/fileTreeActions'

const EMPTY_SEARCH_FILES: { path: string; rel: string }[] = []
const EMPTY_CHANGED_DIRS: ReadonlySet<string> = new Set()
const EMPTY_GIT_DECORATIONS: Record<string, TreeGitDecoration> = {}

interface DirEntry {
  name: string
  path: string
  isDir: boolean
}

type Editing =
  | { mode: 'create-file' | 'create-folder'; parent: string; value: string }
  | { mode: 'rename'; target: DirEntry; value: string }
  | null

const cleanErr = (e: unknown): string =>
  String((e as Error)?.message || e)
    .split('Error: ')
    .pop() || 'Erro'

export default function Explorer() {
  const folderPath = useStore((s) => s.folderPath)
  const workspaceFolders = useStore((s) => s.workspaceFolders)
  const workspaceFile = useStore((s) => s.workspaceFile)
  const treeVersion = useStore((s) => s.treeVersion)
  const remote = useStore((s) => s.remote)
  const activePath = useStore((s) => s.activePath)
  const openFile = useStore((s) => s.openFile)
  const closeTabsUnder = useStore((s) => s.closeTabsUnder)
  const openFolderDialog = useStore((s) => s.openFolderDialog)
  const addToast = useStore((s) => s.addToast)

  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [collapsedRoots, setCollapsedRoots] = useState<Set<string>>(new Set())
  const [childrenMap, setChildrenMap] = useState<Record<string, DirEntry[]>>({})
  const [menu, setMenu] = useState<{ x: number; y: number; entry: DirEntry; root?: boolean } | null>(
    null
  )
  const [editing, setEditing] = useState<Editing>(null)
  const [dragSrc, setDragSrc] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [clipboard, setClipboard] = useState<{ path: string; op: 'cut' | 'copy' } | null>(null)
  const [selected, setSelected] = useState<DirEntry | null>(null)
  const treeRef = useRef<HTMLDivElement>(null)
  const [workspace, setWorkspace] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [searchSnapshot, setSearchSnapshot] = useState<FileTreeSearchSnapshot>({ scope: '', files: [], truncated: false })
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchError, setSearchError] = useState(false)
  const [loading, setLoading] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [gitSnapshot, setGitSnapshot] = useState<TreeGitSnapshot>({ scope: '', decorations: {}, changedDirs: new Set() })
  const [pendingDelete, setPendingDelete] = useState<{ entry: DirEntry; scope: string; remoteId: string | null } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const deletingRef = useRef(false)
  const rowRefs = useRef(new Map<string, HTMLDivElement>())
  const editingSubmitted = useRef(false)
  const roots = useMemo(() => workspace && workspaceFolders.includes(workspace) ? [workspace] : workspaceFolders, [workspace, workspaceFolders])
  const rootKey = roots.join('|')
  const filtering = !!debouncedQuery.trim() && !!query.trim()
  const searchScope = rootKey + ':' + (remote?.id ?? '')
  const hasSearchIndex = searchSnapshot.scope === searchScope
  const searchFiles = hasSearchIndex ? searchSnapshot.files : EMPTY_SEARCH_FILES
  const searchSnapshotRef = useRef(searchSnapshot)
  searchSnapshotRef.current = searchSnapshot
  const searchIndex = useMemo(() => {
    const known = flattenVisibleEntries(roots, childrenMap, new Set(Object.keys(childrenMap)), new Set())
    return prepareFileTreeSearchIndex(roots, [...searchFiles, ...known.map((entry) => ({ ...entry, rel: '' }))])
  }, [roots, searchFiles, childrenMap])
  const filteredMap = useMemo(() => filtering ? filterFileTreeSearchIndex(searchIndex, debouncedQuery) : {}, [searchIndex, debouncedQuery, filtering])
  const displayChildren = filtering ? filteredMap : childrenMap
  const displayExpanded = useMemo(() => filtering ? new Set(Object.keys(filteredMap)) : expanded, [filtering, filteredMap, expanded])
  const displayCollapsedRoots = useMemo(() => filtering ? new Set<string>() : collapsedRoots, [filtering, collapsedRoots])
  const visibleFileEntries = useMemo(() => flattenVisibleEntries(roots, displayChildren, displayExpanded, displayCollapsedRoots), [roots, displayChildren, displayExpanded, displayCollapsedRoots])
  const visibleEntries = useMemo(() => roots.flatMap((root) => [
    ...(roots.length > 1 ? [{ path: root, name: basename(root), isDir: true }] : []),
    ...flattenVisibleEntries([root], displayChildren, displayExpanded, displayCollapsedRoots)
  ]), [roots, displayChildren, displayExpanded, displayCollapsedRoots])
  const scope = workspaceFolders.join('|') + ':' + (remote?.id ?? '')
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const git = gitSnapshot.scope === scope ? gitSnapshot.decorations : EMPTY_GIT_DECORATIONS
  const changedDirs = gitSnapshot.scope === scope ? gitSnapshot.changedDirs : EMPTY_CHANGED_DIRS

  useEffect(() => {
    if (!query.trim()) { setDebouncedQuery(''); return }
    const timer = setTimeout(() => setDebouncedQuery(query), 200)
    return () => clearTimeout(timer)
  }, [query])

  useEffect(() => { setSelected(null) }, [query])

  // Keep refs to the latest state so background refreshes don't need to be
  // re-created on every change.
  const childrenRef = useRef<Record<string, DirEntry[]>>({})
  useEffect(() => {
    childrenRef.current = childrenMap
  }, [childrenMap])
  const expandedRef = useRef<Set<string>>(expanded)
  useEffect(() => {
    expandedRef.current = expanded
  }, [expanded])

  const foldersKey = workspaceFolders.join('|')
  const foldersRef = useRef<string[]>(workspaceFolders)
  foldersRef.current = workspaceFolders

  // Cancel stale local/SSH listings when the workspace or connection changes.
  useEffect(() => {
    let cancelled = false
    childrenRef.current = {}
    setChildrenMap({})
    setExpanded(new Set())
    setCollapsedRoots(new Set())
    setSelected(null)
    setEditing(null)
    setPendingDelete(null)
    setErrors({})
    setLoading(!!workspaceFolders.length)
    Promise.all(workspaceFolders.map(async (root) => {
      try { return [root, sortTreeEntries(await fsApi.readDir(root))] as const }
      catch (error) {
        if (!cancelled) setErrors((prev) => ({ ...prev, [root]: cleanErr(error) }))
        return [root, [] as DirEntry[]] as const
      }
    })).then((pairs) => {
      if (cancelled) return
      setChildrenMap((prev) => ({ ...prev, ...Object.fromEntries(pairs) }))
      setLoading(false)
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [foldersKey, remote?.id])

  useEffect(() => {
    if (!filtering) { setSearchLoading(false); setSearchError(false); return }
    let cancelled = false
    setSearchLoading(searchSnapshotRef.current.scope !== searchScope)
    setSearchError(false)
    const timer = setTimeout(() => {
      Promise.all(roots.map((root) => fsApi.listFiles(root))).then((results) => {
        if (!cancelled) setSearchSnapshot((previous) => reconcileFileTreeSearchSnapshot(previous, {
          scope: searchScope, files: results.flat(), truncated: isFileTreeSearchTruncated(results)
        }))
      }).catch(() => {
        if (!cancelled) setSearchError(true)
      }).finally(() => { if (!cancelled) setSearchLoading(false) })
    }, 150)
    return () => { cancelled = true; clearTimeout(timer) }
    // Query itself filters the returned index locally; only entering search
    // or changing roots/connection invalidates the workspace-wide listing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtering, searchScope, treeVersion])

  useEffect(() => {
    let cancelled = false
    let inFlight = false
    const refreshGit = async (): Promise<void> => {
      if (inFlight || !workspaceFolders.length) return
      inFlight = true
      try {
        const statuses = await window.prism.git.statusAll(workspaceFolders, remote?.id)
        if (cancelled) return
        const next: Record<string, TreeGitDecoration> = {}
        const dirs = new Set<string>()
        for (const repo of statuses) {
          if (!repo.isRepo || !repo.root) continue
          for (const file of repo.files ?? []) {
            const decoration = gitDecoration(file)
            if (!decoration) continue
            const abs = joinPath(repo.root, file.path)
            next[pathKey(abs)] = decoration
            for (const root of workspaceFolders) {
              for (const dir of ancestorDirectories(abs, root)) dirs.add(pathKey(dir))
            }
          }
        }
        setGitSnapshot((previous) => reconcileTreeGitSnapshot(previous, { scope, decorations: next, changedDirs: dirs }))
      } catch { /* Non-repositories/temporary SSH errors leave the tree usable. */ }
      finally { inFlight = false }
    }
    void refreshGit()
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refreshGit()
    }, 4000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [foldersKey, remote?.id, treeVersion])

  // Re-read every directory we already know about (roots + expanded folders),
  // preserving the expansion state and only touching entries that changed. This
  // is what lets external changes (Claude, other processes — especially on a
  // remote/VPS where there's no fs watcher) show up without collapsing the tree.
  const softRefresh = useCallback(async () => {
    const requestScope = scopeRef.current
    // Only the visible directories — roots + expanded folders — need re-reading.
    const visible = new Set([...foldersRef.current, ...expandedRef.current])
    const paths = Object.keys(childrenRef.current).filter((p) => visible.has(p))
    if (!paths.length) return
    const results = await Promise.all(
      paths.map((p) =>
        fsApi
          .readDir(p)
          .then((items) => [p, sortTreeEntries(items)] as const)
          .catch(() => [p, null] as const)
      )
    )
    if (requestScope !== scopeRef.current) return
    setErrors((prev) => {
      if (!results.some(([path, items]) => items && prev[path])) return prev
      const next = { ...prev }
      for (const [path, items] of results) if (items) delete next[path]
      return next
    })
    setChildrenMap((prev) => {
      let next: Record<string, DirEntry[]> | null = null
      for (const [p, items] of results) {
        if (!items) continue
        if (!sameTreeEntries(prev[p], items)) {
          if (!next) next = { ...prev }
          next[p] = items
        }
      }
      return next ?? prev
    })
  }, [])

  // Anything that bumps treeVersion (IDE file ops, the reload button, the agent
  // finishing a turn) triggers a non-destructive refresh.
  useEffect(() => {
    if (treeVersion === 0) return
    softRefresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [treeVersion])

  // Remote (SSH/VPS): no filesystem watcher is possible over SFTP, so poll the
  // visible directories for external changes while the window is in view.
  useEffect(() => {
    if (!remote) return
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') softRefresh()
    }, 4000)
    return () => clearInterval(timer)
  }, [remote, softRefresh])

  const ensureChildren = async (path: string): Promise<void> => {
    if (childrenRef.current[path]) return
    await reload(path)
  }

  const reload = async (path: string): Promise<void> => {
    const requestScope = scopeRef.current
    const items = sortTreeEntries(await fsApi.readDir(path))
    if (requestScope !== scopeRef.current) return
    setChildrenMap((m) => ({ ...m, [path]: items }))
    setErrors((prev) => { const next = { ...prev }; delete next[path]; return next })
  }

  const scrollToEntry = (path: string): void => {
    requestAnimationFrame(() => rowRefs.current.get(path)?.scrollIntoView({ block: 'nearest' }))
  }

  useEffect(() => {
    if (!loading && activePath) scrollToEntry(activePath)
  }, [loading, activePath])

  // Reveal without re-opening a file or stealing the editor's keyboard focus.
  useEffect(() => {
    if (!activePath) return
    let cancelled = false
    const root = [...workspaceFolders].sort((a, b) => b.length - a.length).find((r) => isWithinPath(activePath, r))
    if (!root) return
    const reveal = async (): Promise<void> => {
      if (workspace && !isWithinPath(activePath, workspace)) setWorkspace(root)
      const parents = ancestorDirectories(activePath, root)
      const pairs = await Promise.all(parents.map(async (parent) => {
        if (childrenRef.current[parent]) return [parent, childrenRef.current[parent]] as const
        return [parent, sortTreeEntries(await fsApi.readDir(parent))] as const
      }))
      if (cancelled) return
      setChildrenMap((prev) => ({ ...prev, ...Object.fromEntries(pairs) }))
      setExpanded((prev) => new Set([...prev, ...parents]))
      setCollapsedRoots((prev) => { const next = new Set(prev); next.delete(root); return next })
      scrollToEntry(activePath)
    }
    void reveal().catch(() => { /* A deleted or unavailable active file can stay open. */ })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath, foldersKey, remote?.id])

  const expand = (path: string): void => setExpanded((prev) => new Set(prev).add(path))

  const toggle = async (entry: DirEntry): Promise<void> => {
    if (!entry.isDir) { await openFile(entry.path); return }
    if (filtering) return
    if (workspaceFolders.includes(entry.path)) {
      setCollapsedRoots((prev) => { const next = new Set(prev); if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path); return next })
      return
    }
    if (expanded.has(entry.path)) {
      setExpanded((prev) => { const next = new Set(prev); next.delete(entry.path); return next })
      return
    }
    try {
      await ensureChildren(entry.path)
      expand(entry.path)
    } catch (error) {
      setErrors((prev) => ({ ...prev, [entry.path]: cleanErr(error) }))
      addToast('error', cleanErr(error))
    }
  }

  const startCreate = async (parent: string, isDir: boolean): Promise<void> => {
    setQuery('')
    setCollapsedRoots((prev) => { const next = new Set(prev); next.delete(parent); return next })
    editingSubmitted.current = false
    try {
      const root = workspaceFolders.find((candidate) => isWithinPath(parent, candidate))
      const ancestors = root ? ancestorDirectories(joinPath(parent, '__new_item__'), root) : []
      await Promise.all(ancestors.map(ensureChildren))
      setExpanded((prev) => new Set([...prev, ...ancestors]))
      if (!workspaceFolders.includes(parent) && !expanded.has(parent)) {
        await ensureChildren(parent)
        expand(parent)
      }
      setEditing({ mode: isDir ? 'create-folder' : 'create-file', parent, value: '' })
    } catch (error) {
      addToast('error', cleanErr(error))
    }
  }

  const submitEditing = async (): Promise<void> => {
    if (!editing || editingSubmitted.current) return
    editingSubmitted.current = true
    const name = editing.value.trim()
    if (!name) {
      setEditing(null)
      return
    }
    try {
      if (editing.mode === 'create-file') {
        await fsApi.createFile(joinPath(editing.parent, name))
        await reload(editing.parent)
      } else if (editing.mode === 'create-folder') {
        await fsApi.createDir(joinPath(editing.parent, name))
        await reload(editing.parent)
      } else if (editing.mode === 'rename') {
        const dir = dirname(editing.target.path)
        await fsApi.rename(editing.target.path, joinPath(dir, name))
        await reload(dir || (folderPath as string))
      }
    } catch (e) {
      addToast('error', cleanErr(e))
    }
    setEditing(null)
  }

  const requestDelete = (entry: DirEntry): void => {
    if (deletingRef.current || workspaceFolders.includes(entry.path)) return
    setPendingDelete({ entry, scope: scopeRef.current, remoteId: remote?.id ?? null })
  }

  const confirmDelete = async (): Promise<void> => {
    const request = pendingDelete
    if (!request || deletingRef.current) return
    if (request.scope !== scopeRef.current) { setPendingDelete(null); return }
    deletingRef.current = true
    setDeleting(true)
    try {
      await deleteConfirmedTreeEntry(request.entry.path, request.remoteId, {
        trashLocal: window.prism.fs.trash,
        deleteRemote: window.prism.ssh.fs.delete
      })
      if (request.scope !== scopeRef.current) return
      setPendingDelete(null)
      closeTabsUnder(request.entry.path)
      if (selected?.path === request.entry.path) setSelected(null)
      await reload(dirname(request.entry.path) || (folderPath as string))
      useStore.getState().bumpTree()
      addToast('info', request.remoteId ? `Excluído: ${request.entry.name}` : `Movido para a lixeira: ${request.entry.name}`)
    } catch (e) {
      addToast('error', cleanErr(e))
    } finally {
      deletingRef.current = false
      setDeleting(false)
    }
  }

  const moveItem = async (src: string | null, destDir: string): Promise<void> => {
    if (!src || isWithinPath(destDir, src)) return
    try {
      await fsApi.move(src, destDir)
      await reload(destDir)
      await reload(dirname(src))
      expand(destDir)
    } catch (e) {
      addToast('error', cleanErr(e))
    }
  }

  // Files/folders dragged in from outside the app (Windows Explorer, etc.).
  const isExternalDrag = (e: ReactDragEvent): boolean =>
    Array.from(e.dataTransfer.types).includes('Files')

  const importExternal = async (e: ReactDragEvent, destDir: string): Promise<void> => {
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => {
        try {
          return window.prism.app.pathForFile(f)
        } catch {
          return ''
        }
      })
      .filter(Boolean)
    if (!paths.length) return
    const remote = fsApi.isRemote()
    try {
      if (remote) addToast('info', `Enviando ${paths.length} item(ns) para o servidor…`)
      // Local => copy; remote => SFTP upload.
      const imported = await fsApi.importPaths(paths, destDir)
      await reload(destDir)
      if (!workspaceFolders.includes(destDir)) expand(destDir)
      addToast(
        imported.length ? 'success' : 'error',
        imported.length
          ? remote
            ? `${imported.length} item(ns) enviado(s)`
            : `${imported.length} item(ns) importado(s)`
          : 'Não foi possível importar.'
      )
    } catch (err) {
      addToast('error', cleanErr(err))
    }
  }

  const paste = async (targetDir: string): Promise<void> => {
    if (!clipboard) return
    try {
      if (clipboard.op === 'cut') {
        await fsApi.move(clipboard.path, targetDir)
        await reload(dirname(clipboard.path))
        setClipboard(null)
      } else {
        await fsApi.copyPath(clipboard.path, targetDir)
      }
      await reload(targetDir)
      expand(targetDir)
    } catch (e) {
      addToast('error', cleanErr(e))
    }
  }

  // Ctrl+V: paste the in-app clipboard first; otherwise pull whatever the user
  // copied from the OS file manager (files, or an image) into the folder —
  // locally, or uploaded to the remote.
  const pasteSmart = async (targetDir: string): Promise<void> => {
    if (clipboard) {
      await paste(targetDir)
      return
    }
    try {
      const { paths, image } = await window.prism.app.clipboardFiles()
      const remote = fsApi.isRemote()
      if (paths.length) {
        if (remote) addToast('info', `Enviando ${paths.length} item(ns) para o servidor…`)
        const imported = await fsApi.importPaths(paths, targetDir)
        await reload(targetDir)
        expand(targetDir)
        addToast(
          imported.length ? 'success' : 'error',
          imported.length
            ? remote
              ? `${imported.length} item(ns) enviado(s)`
              : `${imported.length} item(ns) colado(s)`
            : 'Não foi possível colar.'
        )
        return
      }
      if (image) {
        const tmp = await window.prism.fs.saveTempImage(image)
        const imported = await fsApi.importPaths([tmp], targetDir)
        await reload(targetDir)
        expand(targetDir)
        addToast(imported.length ? 'success' : 'error', imported.length ? 'Imagem colada' : 'Falhou')
        return
      }
      addToast('info', 'Nada para colar (copie um arquivo primeiro)')
    } catch (e) {
      addToast('error', cleanErr(e))
    }
  }

  const duplicate = async (entry: DirEntry): Promise<void> => {
    try {
      await fsApi.duplicate(entry.path)
      await reload(dirname(entry.path))
    } catch (e) {
      addToast('error', cleanErr(e))
    }
  }

  const openTerminalHere = async (dir: string): Promise<void> => {
    await window.prism.terminal.setCwd(dir)
    useStore.getState().openTerminal()
  }

  const copyText = (text: string, label: string): void => {
    void navigator.clipboard.writeText(text).then(() => addToast('success', label)).catch((error) => addToast('error', cleanErr(error)))
  }

  const relPath = (p: string): string => relativeTreePath(p, workspaceFolders)

  const parentForCreate = (entry: DirEntry): string => (entry.isDir ? entry.path : dirname(entry.path))

  const beginRename = (entry: DirEntry): void => {
    if (filtering) {
      const root = workspaceFolders.find((candidate) => isWithinPath(entry.path, candidate))
      const ancestors = root ? ancestorDirectories(entry.path, root) : []
      // Search paths already hold their ancestor rows. Load the real listings
      // before leaving search so the rename input stays on a visible row.
      void Promise.all(ancestors.map(ensureChildren)).then(() => {
        setExpanded((prev) => new Set([...prev, ...ancestors]))
        setCollapsedRoots((prev) => { const next = new Set(prev); if (root) next.delete(root); return next })
        setQuery('')
        editingSubmitted.current = false
        setEditing({ mode: 'rename', target: entry, value: entry.name })
      }).catch((error) => addToast('error', cleanErr(error)))
      return
    }
    editingSubmitted.current = false
    setEditing({ mode: 'rename', target: entry, value: entry.name })
  }

  const selectEntry = (entry: DirEntry): void => {
    setSelected(entry)
    scrollToEntry(entry.path)
  }

  const onTreeKey = (e: ReactKeyboardEvent): void => {
    if (editing || menu || pendingDelete) return
    const mod = e.ctrlKey || e.metaKey
    const k = e.key.toLowerCase()
    if (mod && k === 'v') {
      const target = selected ? parentForCreate(selected) : roots[0]
      if (target) { e.preventDefault(); void pasteSmart(target) }
      return
    }
    const index = visibleEntries.findIndex((entry) => entry.path === selected?.path)
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault()
      const nextIndex = e.key === 'Home' ? 0 : e.key === 'End' ? visibleEntries.length - 1
        : e.key === 'ArrowDown' ? Math.min(index + 1, visibleEntries.length - 1)
          : index < 0 ? visibleEntries.length - 1 : Math.max(index - 1, 0)
      if (visibleEntries[nextIndex]) selectEntry(visibleEntries[nextIndex])
      return
    }
    if (!selected) return
    const rootSelected = workspaceFolders.includes(selected.path)
    const selectedOpen = rootSelected ? !displayCollapsedRoots.has(selected.path) : displayExpanded.has(selected.path)
    if (e.key === 'ArrowRight') {
      e.preventDefault()
      if (selected.isDir && !selectedOpen) void toggle(selected)
      else if (selected.isDir && visibleEntries[index + 1] && isWithinPath(visibleEntries[index + 1].path, selected.path)) selectEntry(visibleEntries[index + 1])
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      if (selected.isDir && selectedOpen && !filtering) {
        void toggle(selected)
      } else {
        const parent = visibleEntries.find((entry) => pathKey(entry.path) === pathKey(dirname(selected.path)))
        if (parent) selectEntry(parent)
      }
    } else if (e.key === 'F2') { e.preventDefault(); if (!rootSelected) beginRename(selected) }
    else if (e.key === 'Delete') { e.preventDefault(); if (!rootSelected) requestDelete(selected) }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void toggle(selected) }
    else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault()
      const rect = rowRefs.current.get(selected.path)?.getBoundingClientRect()
      if (rect) setMenu({ x: rect.left + 24, y: rect.bottom, entry: selected, root: rootSelected })
    } else if (mod && k === 'c' && !rootSelected) {
      e.preventDefault(); setClipboard({ path: selected.path, op: 'copy' }); addToast('info', `Copiado: ${selected.name}`)
    } else if (mod && k === 'x' && !rootSelected) { e.preventDefault(); setClipboard({ path: selected.path, op: 'cut' }) }
    else if (mod && k === 'd' && !rootSelected) { e.preventDefault(); void duplicate(selected) }
    else if (e.key === 'Escape') { setSelected(null) }
    else if (!mod && !e.altKey && e.key.length === 1) {
      const ordered = [...visibleEntries.slice(index + 1), ...visibleEntries.slice(0, index + 1)]
      const entry = ordered.find((item) => item.name.toLocaleLowerCase().startsWith(k))
      if (entry) { e.preventDefault(); selectEntry(entry) }
    }
  }

  const editInput = () => (
    <input className="pr-files-input" aria-label={editing?.mode === 'rename' ? 'Renomear item' : 'Nome do novo item'}
      autoFocus value={editing?.value ?? ''}
      onFocus={(event) => {
        if (editing?.mode !== 'rename') return
        const dot = editing.target.isDir ? -1 : editing.value.lastIndexOf('.')
        event.currentTarget.setSelectionRange(0, dot > 0 ? dot : editing.value.length)
      }}
      onClick={(event) => event.stopPropagation()}
      onBlur={() => void submitEditing()}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Enter') { event.preventDefault(); void submitEditing() }
        else if (event.key === 'Escape') { editingSubmitted.current = true; setEditing(null) }
      }}
      onChange={(event) => setEditing((prev) => prev ? { ...prev, value: event.target.value } : prev)} />
  )

  const spacing = (depth: number) => depth > 0 ? <span aria-hidden="true" className="pr-files-spacing">
    {Array.from({ length: depth }, (_, i) => <span key={i} className="pr-files-guide" />)}
  </span> : null

  const creationRow = (parent: string, depth: number) => editing && editing.mode !== 'rename' && editing.parent === parent ? (
    <div className="pr-files-row">
      {spacing(depth)}
      <span className="pr-files-icon-slot">{editing.mode === 'create-folder' ? <FileTreeChevron expanded={false} /> : <FileTypeIcon name={editing.value} size={14} />}</span>
      {editInput()}
    </div>
  ) : null

  const renderNodes = (dir: string, depth: number) => (displayChildren[dir] ?? []).map((entry) => {
    const isOpen = entry.isDir && displayExpanded.has(entry.path)
    const cut = clipboard?.op === 'cut' && clipboard.path === entry.path
    const decoration = git[pathKey(entry.path)]
    const changedChildren = entry.isDir && changedDirs.has(pathKey(entry.path))
    return <div key={entry.path} role="none" className="pr-files-node">
      <div role="treeitem" aria-level={depth + 1} aria-expanded={entry.isDir ? isOpen : undefined}
        aria-selected={selected ? selected.path === entry.path : entry.path === activePath}
        aria-label={entry.name + (decoration ? ', ' + decoration.title : '')}
        id={'pr-files-row-' + encodeURIComponent(entry.path)}
        ref={(element) => { if (element) rowRefs.current.set(entry.path, element); else rowRefs.current.delete(entry.path) }}
        className={'pr-files-row' + (entry.isDir ? ' is-folder' : '') + (isOpen ? ' is-expanded' : '')
          + (entry.path === activePath ? ' is-active' : '') + (selected?.path === entry.path ? ' is-selected' : '')
          + (dropTarget === entry.path ? ' is-drop' : '') + (cut ? ' is-cut' : '')
          + (filtering && !entry.isDir ? ' is-match' : '')}
        data-git={decoration?.status} title={entry.path}
        style={{ '--tr-files-sticky-top': `${depth * 24}px`, '--tr-files-sticky-z': 100 - depth } as CSSProperties}
        draggable={!editing}
        onDragStart={(event) => {
          setDragSrc(entry.path)
          event.dataTransfer.effectAllowed = 'copyMove'
          if (!entry.isDir) event.dataTransfer.setData('application/prism-path', entry.path)
        }}
        onDragEnd={() => { setDragSrc(null); setDropTarget(null) }}
        onDragOver={(event) => {
          if (entry.isDir && (isExternalDrag(event) || (dragSrc && !isWithinPath(entry.path, dragSrc)))) {
            event.preventDefault(); event.stopPropagation(); setDropTarget(entry.path)
          }
        }}
        onDragLeave={() => setDropTarget((target) => target === entry.path ? null : target)}
        onDrop={(event) => {
          event.preventDefault(); event.stopPropagation()
          const dest = parentForCreate(entry)
          if (isExternalDrag(event)) void importExternal(event, dest)
          else if (entry.isDir && dragSrc && !isWithinPath(entry.path, dragSrc)) void moveItem(dragSrc, entry.path)
          setDragSrc(null); setDropTarget(null)
        }}
        onClick={() => {
          setSelected(entry)
          treeRef.current?.focus()
          void toggle(entry).finally(() => requestAnimationFrame(() => treeRef.current?.focus()))
        }}
        onContextMenu={(event) => {
          event.preventDefault(); event.stopPropagation(); setSelected(entry)
          setMenu({ x: event.clientX, y: event.clientY, entry })
        }}>
        {spacing(depth)}
        <span className="pr-files-icon-slot">{entry.isDir ? <FileTreeChevron expanded={isOpen} /> : <FileTypeIcon name={entry.name} size={14} />}</span>
        {editing?.mode === 'rename' && editing.target.path === entry.path ? editInput() : <FileTreeName name={entry.name} isDir={entry.isDir} />}
        {decoration ? <span className="pr-files-git" title={decoration.title}>{decoration.label}</span>
          : changedChildren ? <span className="pr-files-git is-descendant" aria-label="Contém alterações" /> : null}
      </div>
      {isOpen && <div role="group">
        {creationRow(entry.path, depth + 1)}
        {errors[entry.path] && <div className="pr-files-feedback is-error" role="alert">Não foi possível carregar esta pasta.</div>}
        {renderNodes(entry.path, depth + 1)}
      </div>}
    </div>
  })

  const multiRoot = roots.length > 1
  const primaryRoot = roots[0]
  const pickerName = workspace ? basename(workspace) : workspaceFile ? basename(workspaceFile).replace(/\.prism-workspace$/, '')
    : workspaceFolders.length > 1 ? 'Todas as pastas' : basename(primaryRoot || '')
  const pickerPath = workspace || (workspaceFolders.length > 1 ? `${workspaceFolders.length} pastas no workspace` : primaryRoot)

  const renderRoot = (root: string) => {
    const open = !displayCollapsedRoots.has(root)
    return <div key={root} role="none" className="pr-files-node">
      {multiRoot && <div className={'pr-files-row is-folder' + (open ? ' is-expanded' : '') + (dropTarget === root ? ' is-drop' : '') + (selected?.path === root ? ' is-selected' : '')}
        role="treeitem" aria-expanded={open} aria-level={1} aria-selected={selected?.path === root} title={root}
        id={'pr-files-row-' + encodeURIComponent(root)}
        ref={(element) => { if (element) rowRefs.current.set(root, element); else rowRefs.current.delete(root) }}
        style={{ '--tr-files-sticky-top': '0px', '--tr-files-sticky-z': 101 } as CSSProperties}
        onClick={() => { const entry = { path: root, name: basename(root), isDir: true }; setSelected(entry); treeRef.current?.focus(); void toggle(entry) }}
        onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setMenu({ x: event.clientX, y: event.clientY, entry: { path: root, name: basename(root), isDir: true }, root: true }) }}
        onDragOver={(event) => { if (dragSrc || isExternalDrag(event)) { event.preventDefault(); event.stopPropagation(); setDropTarget(root) } }}
        onDragLeave={() => setDropTarget((target) => target === root ? null : target)}
        onDrop={(event) => { event.preventDefault(); event.stopPropagation(); if (isExternalDrag(event)) void importExternal(event, root); else void moveItem(dragSrc, root); setDragSrc(null); setDropTarget(null) }}>
        <span className="pr-files-icon-slot"><FileTreeChevron expanded={open} /></span>
        <span className="pr-files-name">{basename(root)}</span>
        <div className="pr-files-root-actions" onClick={(event) => event.stopPropagation()}>
          <Tooltip label="Novo arquivo"><Button variant="ghost" size="icon-xs" aria-label="Novo arquivo" onClick={() => void startCreate(root, false)}><FilePlus /></Button></Tooltip>
          <Tooltip label="Nova pasta"><Button variant="ghost" size="icon-xs" aria-label="Nova pasta" onClick={() => void startCreate(root, true)}><FolderPlus /></Button></Tooltip>
        </div>
      </div>}
      {open && <div role={multiRoot ? 'group' : 'none'}>
        {creationRow(root, multiRoot ? 1 : 0)}
        {errors[root] ? <div role="alert" className="pr-files-feedback is-error">Não foi possível carregar os arquivos.<Button variant="link" size="xs" onClick={() => void reload(root).catch((error) => addToast('error', cleanErr(error)))}>Tentar novamente</Button></div> : renderNodes(root, multiRoot ? 1 : 0)}
      </div>}
    </div>
  }

  const collapseAll = (): void => { setExpanded(new Set()); setCollapsedRoots(new Set()) }
  const revealActive = async (): Promise<void> => {
    if (!activePath) return
    const root = workspaceFolders.find((r) => isWithinPath(activePath, r))
    if (!root) return
    setWorkspace(root); setQuery('')
    const parents = ancestorDirectories(activePath, root)
    await Promise.all(parents.map(ensureChildren))
    setExpanded((prev) => new Set([...prev, ...parents]))
    setCollapsedRoots((prev) => { const next = new Set(prev); next.delete(root); return next })
    setSelected({ path: activePath, name: basename(activePath), isDir: false })
    scrollToEntry(activePath)
    treeRef.current?.focus()
  }

  const menuEntry = menu?.entry
  const isRootMenu = !!menu?.root

  return <div className="pr-files">
    <FileIconSpriteSheet />
    <div className="pr-files-header">
      <span className="pr-files-title">Arquivos</span>
      <div className="pr-files-actions">
        {primaryRoot && <>
          <Tooltip label="Novo arquivo"><Button variant="ghost" size="icon-xs" aria-label="Novo arquivo" onClick={() => void startCreate(selected ? parentForCreate(selected) : primaryRoot, false)}><FilePlus /></Button></Tooltip>
          <Tooltip label="Nova pasta"><Button variant="ghost" size="icon-xs" aria-label="Nova pasta" onClick={() => void startCreate(selected ? parentForCreate(selected) : primaryRoot, true)}><FolderPlus /></Button></Tooltip>
          <Tooltip label="Revelar arquivo ativo"><Button variant="ghost" size="icon-xs" aria-label="Revelar arquivo ativo" disabled={!activePath} onClick={() => void revealActive().catch((error) => addToast('error', cleanErr(error)))}><LocateFixed /></Button></Tooltip>
          <Tooltip label="Recolher pastas"><Button variant="ghost" size="icon-xs" aria-label="Recolher pastas" onClick={collapseAll}><ChevronsDownUp /></Button></Tooltip>
          <Tooltip label="Atualizar arquivos"><Button variant="ghost" size="icon-xs" aria-label="Atualizar arquivos" onClick={() => useStore.getState().bumpTree()}><RefreshCw /></Button></Tooltip>
        </>}
      </div>
    </div>
    {!workspaceFolders.length ? <div className="pr-files-empty">
      <FolderOpen size={32} aria-hidden="true" />
      <p>Nenhuma pasta aberta.</p><small>Abra uma pasta para explorar seus arquivos.</small>
      <Button size="sm" onClick={() => void openFolderDialog()}>Abrir pasta</Button>
    </div> : <>
      <div className="pr-files-picker-wrap">
        <DropdownMenu className="pr-files-workspace-menu" label="Selecionar workspace" trigger={<button className="pr-files-picker" type="button">
          <span className="pr-files-picker-labels"><span className="pr-files-picker-name">{pickerName}</span><span className="pr-files-picker-path"><span>{pickerPath}</span></span></span>
          <ChevronDown size={14} />
        </button>}>
          {workspaceFolders.length > 1 && <DropdownMenuRadioItem checked={!workspace} onSelect={() => { setWorkspace(null); setSelected(null) }}>Todas as pastas</DropdownMenuRadioItem>}
          {workspaceFolders.map((root) => <DropdownMenuRadioItem key={root} checked={workspace === root || (!workspace && workspaceFolders.length === 1)} onSelect={() => { setWorkspace(root); setSelected(null) }}>
            <span className="pr-files-workspace-option"><span>{basename(root)}</span><small>{root}</small></span>
          </DropdownMenuRadioItem>)}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void openFolderDialog()}><FolderOpen size={14} />Abrir pasta…</DropdownMenuItem>
          {!remote && <DropdownMenuItem onSelect={() => {
            void window.prism.dialog.openFolder().then((path) => {
              if (path && !workspaceFolders.some((root) => pathKey(root) === pathKey(path))) return useStore.getState().openWorkspaceFolders([...workspaceFolders, path], workspaceFile)
            }).catch((error) => addToast('error', cleanErr(error)))
          }}><FolderPlus size={14} />Adicionar pasta ao workspace…</DropdownMenuItem>}
        </DropdownMenu>
      </div>
      <div className="pr-files-body">
        <InputGroup variant="search" className="pr-files-search">
          <InputAddon><Search size={14} /></InputAddon>
          <input value={query} aria-label="Filtrar arquivos por nome" placeholder="Filtrar arquivos por nome…" onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Escape') setQuery(''); if (event.key === 'ArrowDown') { event.preventDefault(); treeRef.current?.focus(); if (visibleEntries[0]) selectEntry(visibleEntries[0]) } }} />
          {query && <InputAddon align="end"><Button variant="ghost" size="icon-xs" aria-label="Limpar filtro de arquivos" onClick={() => setQuery('')}><X size={12} /></Button></InputAddon>}
        </InputGroup>
        <div className={'pr-files-tree' + (dropTarget === '__tree__' ? ' is-drop' : '')} ref={treeRef} role="tree" aria-label="Arquivos do workspace"
          aria-busy={loading || searchLoading} aria-activedescendant={selected ? 'pr-files-row-' + encodeURIComponent(selected.path) : undefined}
          tabIndex={0} onKeyDown={onTreeKey} onScroll={() => setMenu(null)}
          onContextMenu={(event) => {
            if ((event.target as HTMLElement).closest('.pr-files-row') || !primaryRoot) return
            event.preventDefault(); setSelected(null)
            setMenu({ x: event.clientX, y: event.clientY, entry: { name: basename(primaryRoot), path: primaryRoot, isDir: true }, root: true })
          }}
          onDragOver={(event) => { if (isExternalDrag(event) && !(event.target as HTMLElement).closest('.pr-files-row')) { event.preventDefault(); setDropTarget('__tree__') } }}
          onDragLeave={() => setDropTarget((target) => target === '__tree__' ? null : target)}
          onDrop={(event) => { if (isExternalDrag(event) && primaryRoot) { event.preventDefault(); void importExternal(event, primaryRoot) } setDropTarget(null) }}>
          {loading || (filtering && searchLoading && !hasSearchIndex) ? <div className="pr-files-feedback" role="status"><Spinner tone="muted" label="Carregando arquivos" /></div>
            : filtering && searchError && !hasSearchIndex ? <div className="pr-files-feedback is-error" role="alert">Não foi possível filtrar os arquivos.</div>
            : filtering && !visibleFileEntries.length ? <div className="pr-files-feedback" role="status">Nenhum arquivo corresponde ao filtro.</div>
            : <>{roots.map(renderRoot)}{!visibleEntries.length && !editing && !Object.keys(errors).length && <div className="pr-files-feedback">Esta pasta está vazia.</div>}</>}
        </div>
        {filtering && searchError && hasSearchIndex && <p className="pr-files-search-notice is-error" role="status">Não foi possível atualizar a busca. Os últimos resultados continuam visíveis.</p>}
        {filtering && hasSearchIndex && searchSnapshot.truncated && <p className="pr-files-search-notice" role="status">A busca atingiu o limite de 8.000 arquivos por pasta. Alguns resultados podem não aparecer.</p>}
      </div>
    </>}

    {menu && menuEntry && <DropdownMenu open onOpenChange={(open) => { if (!open) setMenu(null) }} sideOffset={0}
      onCloseAutoFocus={() => treeRef.current?.focus()} label="Ações do arquivo" trigger={<span aria-hidden="true" className="pr-files-context-anchor" style={{ left: menu.x, top: menu.y }} />}>
      <DropdownMenuItem onSelect={() => void startCreate(parentForCreate(menuEntry), false)}><FilePlus size={14} />Novo arquivo</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => void startCreate(parentForCreate(menuEntry), true)}><FolderPlus size={14} />Nova pasta</DropdownMenuItem>
      {!isRootMenu && <><DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => setClipboard({ path: menuEntry.path, op: 'cut' })}><Scissors size={14} />Cortar<DropdownMenuShortcut>Ctrl+X</DropdownMenuShortcut></DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setClipboard({ path: menuEntry.path, op: 'copy' })}><Copy size={14} />Copiar<DropdownMenuShortcut>Ctrl+C</DropdownMenuShortcut></DropdownMenuItem>
      </>}
      <DropdownMenuItem onSelect={() => void pasteSmart(parentForCreate(menuEntry))}><ClipboardPaste size={14} />Colar<DropdownMenuShortcut>Ctrl+V</DropdownMenuShortcut></DropdownMenuItem>
      {!isRootMenu && <DropdownMenuItem onSelect={() => void duplicate(menuEntry)}><CopyPlus size={14} />Duplicar<DropdownMenuShortcut>Ctrl+D</DropdownMenuShortcut></DropdownMenuItem>}
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={() => copyText(menuEntry.path, 'Caminho copiado')}><Copy size={14} />Copiar caminho</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => copyText(relPath(menuEntry.path), 'Caminho relativo copiado')}><Copy size={14} />Copiar caminho relativo</DropdownMenuItem>
      {menuEntry.isDir && <DropdownMenuItem onSelect={() => void openTerminalHere(menuEntry.path).catch((error) => addToast('error', cleanErr(error)))}><SquareTerminal size={14} />Abrir terminal aqui</DropdownMenuItem>}
      {!remote && <DropdownMenuItem onSelect={() => void window.prism.app.revealInFolder(menuEntry.path)}><ExternalLink size={14} />Revelar no sistema</DropdownMenuItem>}
      {!isRootMenu && <><DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => beginRename(menuEntry)}><Pencil size={14} />Renomear<DropdownMenuShortcut>F2</DropdownMenuShortcut></DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onSelect={() => requestDelete(menuEntry)}><Trash2 size={14} />Excluir<DropdownMenuShortcut>Del</DropdownMenuShortcut></DropdownMenuItem>
      </>}
    </DropdownMenu>}
    {pendingDelete && <FileDeleteDialog entry={pendingDelete.entry} remote={pendingDelete.remoteId !== null} busy={deleting}
      onCancel={() => { if (!deletingRef.current) setPendingDelete(null) }} onConfirm={() => void confirmDelete()} />}
  </div>
}
