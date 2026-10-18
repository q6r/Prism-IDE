export interface GitFile {
  path: string
  origPath?: string
  x: string
  y: string
  staged: boolean
  untracked: boolean
  stagedStats?: GitFileStats
  workingStats?: GitFileStats
}

export interface GitFileStats { insertions: number; deletions: number; binary: boolean }

export type GitSection = 'conflicts' | 'staged' | 'working' | 'untracked'
export const SECTION_LABELS: Record<GitSection, string> = {
  conflicts: 'Conflitos', staged: 'Preparadas', working: 'Alterações', untracked: 'Não rastreados'
}

export function isConflict(file: GitFile): boolean {
  return file.x === 'U' || file.y === 'U' || ['AA', 'DD'].includes(file.x + file.y)
}

export function groupGitFiles(files: readonly GitFile[]): Record<GitSection, GitFile[]> {
  const groups: Record<GitSection, GitFile[]> = { conflicts: [], staged: [], working: [], untracked: [] }
  for (const file of files) {
    if (isConflict(file)) { groups.conflicts.push(file); continue }
    if (file.untracked) { groups.untracked.push(file); continue }
    if (file.staged) groups.staged.push(file)
    if (file.y.trim()) groups.working.push(file)
  }
  return groups
}

export function statusBadge(file: GitFile, section: GitSection): { letter: string; label: string; tone: string } {
  if (isConflict(file)) return { letter: '!', label: 'Conflito', tone: 'destructive' }
  const code = file.untracked ? '?' : section === 'staged' ? file.x : file.y
  switch (code) {
    case '?': return { letter: 'A', label: 'Novo arquivo', tone: 'success' }
    case 'A': return { letter: 'A', label: 'Adicionado', tone: 'success' }
    case 'D': return { letter: 'D', label: 'Excluído', tone: 'destructive' }
    case 'R': return { letter: 'R', label: 'Renomeado', tone: 'primary' }
    case 'C': return { letter: 'C', label: 'Copiado', tone: 'muted' }
    case 'T': return { letter: 'T', label: 'Tipo alterado', tone: 'warning' }
    default: return { letter: 'M', label: 'Modificado', tone: 'warning' }
  }
}

export function filterGitFiles(files: readonly GitFile[], query: string): GitFile[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  return files.filter((file) => words.every((word) => file.path.toLocaleLowerCase().includes(word)))
}

export interface GitTreeNode { name: string; path: string; children: GitTreeNode[]; file?: GitFile }
export function buildGitTree(files: readonly GitFile[]): GitTreeNode[] {
  const root: GitTreeNode = { name: '', path: '', children: [] }
  for (const file of files) {
    const parts = file.path.split(/[\\/]/).filter(Boolean)
    let parent = root
    for (let index = 0; index < parts.length; index++) {
      const name = parts[index]
      const path = parts.slice(0, index + 1).join('/')
      const leaf = index === parts.length - 1
      let node = parent.children.find((child) => child.name === name && Boolean(child.file) === leaf)
      if (!node) { node = { name, path, children: [], ...(leaf ? { file } : {}) }; parent.children.push(node) }
      parent = node
    }
  }
  const sort = (nodes: GitTreeNode[]): void => {
    nodes.sort((a, b) => Number(Boolean(a.file)) - Number(Boolean(b.file)) || a.name.localeCompare(b.name, 'pt-BR'))
    for (const node of nodes) sort(node.children)
  }
  sort(root.children)
  return root.children
}

export function diffLineStats(changes: readonly { originalStartLineNumber: number; originalEndLineNumber: number; modifiedStartLineNumber: number; modifiedEndLineNumber: number }[]): { insertions: number; deletions: number } {
  return changes.reduce((stats, change) => ({
    insertions: stats.insertions + (change.modifiedEndLineNumber === 0 ? 0 : change.modifiedEndLineNumber - change.modifiedStartLineNumber + 1),
    deletions: stats.deletions + (change.originalEndLineNumber === 0 ? 0 : change.originalEndLineNumber - change.originalStartLineNumber + 1)
  }), { insertions: 0, deletions: 0 })
}

export function gitFailure(result: unknown): string | null {
  if (!result || typeof result !== 'object' || !('code' in result) || result.code === 0) return null
  const detail = result as { message?: string; stderr?: string; stdout?: string }
  return detail.message?.trim() || detail.stderr?.trim() || detail.stdout?.trim() || 'Falha na operação Git'
}
