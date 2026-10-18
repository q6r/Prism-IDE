export interface GitDiffContext {
  root: string
  file: string
  origPath?: string
  untracked: boolean
  remoteId?: string
  scope: 'staged' | 'working'
}

// Diff tabs keep their existing store shape; live refresh metadata is owned by Git.
const contexts = new Map<string, GitDiffContext>()
export function rememberGitDiff(absolutePath: string, context: GitDiffContext): void {
  contexts.set(`diff:${absolutePath}`, context)
}
export function getGitDiffContext(tabPath: string): GitDiffContext | undefined {
  return contexts.get(tabPath)
}
