export interface FileTreeEntry {
  name: string
  path: string
  isDir: boolean
}

export type FileTreeChildren = Record<string, FileTreeEntry[]>

// Windows paths are case-insensitive; SSH/POSIX paths are not.
export function pathKey(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/$/, '')
  if (!normalized && path.startsWith('/')) return '/'
  return /^[a-z]:/i.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized
}

export function isWithinPath(path: string, root: string): boolean {
  const p = pathKey(path)
  const r = pathKey(root)
  return p === r || (r === '/' ? p.startsWith('/') : p.startsWith(r + '/'))
}

export function relativeTreePath(path: string, roots: readonly string[]): string {
  const root = [...roots].sort((a, b) => b.length - a.length).find((r) => isWithinPath(path, r))
  return root ? path.slice(root.replace(/[\\/]$/, '').length).replace(/^[\\/]/, '') : path.split(/[\\/]/).pop() || path
}

const nameOrder = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })
export function sortTreeEntries(entries: readonly FileTreeEntry[]): FileTreeEntry[] {
  return [...entries].sort((a, b) => Number(b.isDir) - Number(a.isDir) || nameOrder.compare(a.name, b.name))
}

export function sameTreeEntries(a: FileTreeEntry[] | undefined, b: FileTreeEntry[]): boolean {
  return !!a && a.length === b.length && a.every((entry, i) => entry.path === b[i].path && entry.name === b[i].name && entry.isDir === b[i].isDir)
}

export function ancestorDirectories(path: string, root: string): string[] {
  if (!isWithinPath(path, root) || pathKey(path) === pathKey(root)) return []
  const sep = root.includes('\\') ? '\\' : '/'
  const parts = relativeTreePath(path, [root]).split(/[\\/]/).slice(0, -1)
  const ancestors = [root]
  let parent = root.replace(/[\\/]$/, '')
  for (const part of parts) {
    parent += sep + part
    ancestors.push(parent)
  }
  return ancestors
}

export function flattenVisibleEntries(roots: readonly string[], children: FileTreeChildren, expanded: ReadonlySet<string>, collapsedRoots: ReadonlySet<string>): FileTreeEntry[] {
  const result: FileTreeEntry[] = []
  const visit = (dir: string): void => {
    for (const entry of children[dir] ?? []) {
      result.push(entry)
      if (entry.isDir && expanded.has(entry.path)) visit(entry.path)
    }
  }
  for (const root of roots) if (!collapsedRoots.has(root)) visit(root)
  return result
}

// listFiles searches the whole workspace, including folders not yet lazily loaded.
// Only matching files and their ancestors enter the filtered tree.
export interface FileTreeSearchEntry {
  readonly path: string
  readonly name: string
  readonly lowerName: string
  readonly isDir: boolean
  readonly ancestors: readonly string[]
}

/** Prepare paths once per listing rather than rebuilding ancestors on every query. */
export function prepareFileTreeSearchIndex(roots: readonly string[], files: readonly { path: string; rel: string; isDir?: boolean }[]): FileTreeSearchEntry[] {
  const candidates = new Map<string, { path: string; isDir?: boolean }>()
  const sortedRoots = [...roots].sort((a, b) => b.length - a.length)
  for (const file of files) {
    const root = sortedRoots.find((r) => isWithinPath(file.path, r))
    if (!root || pathKey(file.path) === pathKey(root)) continue
    candidates.set(pathKey(file.path), file)
    for (const dir of ancestorDirectories(file.path, root).slice(1)) {
      candidates.set(pathKey(dir), { path: dir, isDir: true })
    }
  }
  const index: FileTreeSearchEntry[] = []
  for (const file of candidates.values()) {
    const name = file.path.split(/[\\/]/).pop() || ''
    const root = sortedRoots.find((r) => isWithinPath(file.path, r))
    if (!root) continue
    index.push({ path: file.path, name, lowerName: name.toLocaleLowerCase(), isDir: !!file.isDir, ancestors: ancestorDirectories(file.path, root) })
  }
  return index
}

export function filterFileTreeSearchIndex(index: readonly FileTreeSearchEntry[], query: string): FileTreeChildren {
  const children: Record<string, Map<string, FileTreeEntry>> = {}
  const needle = query.trim().toLocaleLowerCase()
  for (const file of index) {
    if (!file.lowerName.includes(needle)) continue
    const ancestors = file.ancestors
    for (let i = 0; i < ancestors.length; i++) {
      const parent = ancestors[i]
      const child = ancestors[i + 1] ?? file.path
      children[parent] ??= new Map()
      children[parent].set(pathKey(child), { path: child, name: child.split(/[\\/]/).pop() || child, isDir: i + 1 < ancestors.length || !!file.isDir })
    }
  }
  return Object.fromEntries(Object.entries(children).map(([dir, entries]) => [dir, sortTreeEntries([...entries.values()])]))
}

export function buildFilteredTree(roots: readonly string[], files: readonly { path: string; rel: string; isDir?: boolean }[], query: string): FileTreeChildren {
  return filterFileTreeSearchIndex(prepareFileTreeSearchIndex(roots, files), query)
}

/** Existing listFiles IPC caps each root independently and does not expose hasMore. */
export function isFileTreeSearchTruncated(listings: readonly (readonly unknown[])[], cap = 8000): boolean {
  return listings.some((files) => files.length >= cap)
}

export interface FileTreeSearchSnapshot {
  scope: string
  files: { path: string; rel: string }[]
  truncated: boolean
}

export function reconcileFileTreeSearchSnapshot(previous: FileTreeSearchSnapshot, next: FileTreeSearchSnapshot): FileTreeSearchSnapshot {
  return previous.scope === next.scope && previous.truncated === next.truncated
    && previous.files.length === next.files.length
    && previous.files.every((file, i) => file.path === next.files[i].path && file.rel === next.files[i].rel)
    ? previous : next
}

export type TreeGitStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflict'
export interface TreeGitFile { path: string; x: string; y: string; untracked: boolean }
export interface TreeGitDecoration { status: TreeGitStatus; label: string; title: string }

export interface TreeGitSnapshot {
  scope: string
  decorations: Record<string, TreeGitDecoration>
  changedDirs: ReadonlySet<string>
}

/** Preserve the snapshot's identity when polling returns the same content. */
export function reconcileTreeGitSnapshot(previous: TreeGitSnapshot, next: TreeGitSnapshot): TreeGitSnapshot {
  if (previous.scope !== next.scope || previous.changedDirs.size !== next.changedDirs.size) return next
  for (const dir of previous.changedDirs) if (!next.changedDirs.has(dir)) return next
  const keys = Object.keys(previous.decorations)
  if (keys.length !== Object.keys(next.decorations).length) return next
  for (const path of keys) {
    const a = previous.decorations[path]
    const b = next.decorations[path]
    if (!b || a.status !== b.status || a.label !== b.label || a.title !== b.title) return next
  }
  return previous
}

export function gitDecoration(file: TreeGitFile): TreeGitDecoration | null {
  const xy = file.x + file.y
  if (['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(xy)) return { status: 'conflict', label: 'U', title: 'Conflito' }
  if (file.untracked || xy === '??') return { status: 'untracked', label: 'U', title: 'Não rastreado' }
  if (xy.includes('D')) return { status: 'deleted', label: 'D', title: 'Excluído' }
  if (xy.includes('R')) return { status: 'renamed', label: 'R', title: 'Renomeado' }
  if (xy.includes('A')) return { status: 'added', label: 'A', title: 'Adicionado' }
  if (xy.includes('M') || xy.includes('T') || xy.includes('C')) return { status: 'modified', label: 'M', title: 'Modificado' }
  return null
}
