/** Use the workspace's spelling and separators for local editor tabs. */
export function workspaceFilePath(file: string, folders: readonly string[], remote = false): string {
  const normalize = (path: string): string => path.replace(/\\/g, '/').replace(/\/$/, '')
  const candidate = normalize(file)
  const compare = (path: string): string => remote ? path : path.toLowerCase()
  const root = [...folders].sort((a, b) => b.length - a.length).find((folder) => {
    const prefix = compare(normalize(folder))
    return compare(candidate) === prefix || compare(candidate).startsWith(prefix + '/')
  })
  if (!root) return file
  const suffix = candidate.slice(normalize(root).length)
  return root.replace(/[\\/]$/, '') + (root.includes('\\') && !remote ? suffix.replace(/\//g, '\\') : suffix)
}
