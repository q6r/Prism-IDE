import type { HostClient } from '../client'
import type { GitBranches } from '../generated/GitBranches'
import type { GitDiff } from '../generated/GitDiff'
import type { GitMessage } from '../generated/GitMessage'
import type { GitStatus } from '../generated/GitStatus'
import { LONG_CALL_MS, readWithFallback } from './call'

type StatusOptions = { stats?: boolean }

/** `window.prism.git`; `remoteId` (an SSH workspace) stays on IPC. */
export interface GitApi {
  status(dir: string, remoteId?: string, options?: StatusOptions): Promise<GitStatus>
  statusAll(folders: string[], remoteId?: string, options?: StatusOptions): Promise<GitStatus[]>
  branches(root: string, remoteId?: string): Promise<GitBranches>
  checkout(root: string, branch: string, remoteId?: string): Promise<GitMessage>
  createBranch(root: string, name: string, remoteId?: string): Promise<GitMessage>
  fetch(root: string, remoteId?: string): Promise<GitMessage>
  pull(root: string, remoteId?: string): Promise<GitMessage>
  push(root: string, remoteId?: string): Promise<GitMessage>
  stage(root: string, file: string, remoteId?: string): Promise<unknown>
  unstage(root: string, file: string, remoteId?: string): Promise<unknown>
  stageAll(root: string, remoteId?: string): Promise<unknown>
  unstageAll(root: string, remoteId?: string): Promise<unknown>
  discard(root: string, file: string, untracked: boolean, remoteId?: string): Promise<unknown>
  commit(root: string, message: string, remoteId?: string): Promise<GitMessage>
  init(dir: string, remoteId?: string): Promise<unknown>
  diff(root: string, file: string, untracked: boolean, remoteId?: string, scope?: 'staged' | 'working', origPath?: string): Promise<GitDiff>
}

/**
 * Git on the host, same results as the IPC side. `aiCommitMessage` is not
 * here: it stays on IPC until the Claude domain moves (T06). Git can be slow
 * (network, hooks, big repositories), so every call gets the long timeout.
 */
export function createHostGit(deps: { client: HostClient; ipc: GitApi }): GitApi {
  const { client, ipc } = deps
  const call = <T>(verb: string, params: unknown): Promise<T> => client.call<T>(`git.${verb}`, params, LONG_CALL_MS)
  return {
    status: (dir, remoteId, options) => remoteId
      ? ipc.status(dir, remoteId, options)
      : readWithFallback(() => call('status', { dir, stats: options?.stats }), () => ipc.status(dir, remoteId, options)),
    statusAll: (folders, remoteId, options) => remoteId
      ? ipc.statusAll(folders, remoteId, options)
      : readWithFallback(() => call('statusAll', { folders, stats: options?.stats }), () => ipc.statusAll(folders, remoteId, options)),
    branches: (root, remoteId) => remoteId
      ? ipc.branches(root, remoteId)
      : readWithFallback(() => call('branches', { root }), () => ipc.branches(root, remoteId)),
    checkout: (root, branch, remoteId) => remoteId ? ipc.checkout(root, branch, remoteId) : call('checkout', { root, branch }),
    createBranch: (root, name, remoteId) => remoteId ? ipc.createBranch(root, name, remoteId) : call('createBranch', { root, branch: name }),
    fetch: (root, remoteId) => remoteId ? ipc.fetch(root, remoteId) : call('fetch', { root }),
    pull: (root, remoteId) => remoteId ? ipc.pull(root, remoteId) : call('pull', { root }),
    push: (root, remoteId) => remoteId ? ipc.push(root, remoteId) : call('push', { root }),
    stage: (root, file, remoteId) => remoteId ? ipc.stage(root, file, remoteId) : call('stage', { root, file }),
    unstage: (root, file, remoteId) => remoteId ? ipc.unstage(root, file, remoteId) : call('unstage', { root, file }),
    stageAll: (root, remoteId) => remoteId ? ipc.stageAll(root, remoteId) : call('stageAll', { root }),
    unstageAll: (root, remoteId) => remoteId ? ipc.unstageAll(root, remoteId) : call('unstageAll', { root }),
    discard: (root, file, untracked, remoteId) => remoteId
      ? ipc.discard(root, file, untracked, remoteId)
      : call('discard', { root, file, untracked }),
    commit: (root, message, remoteId) => remoteId ? ipc.commit(root, message, remoteId) : call('commit', { root, message }),
    init: (dir, remoteId) => remoteId ? ipc.init(dir, remoteId) : call('init', { dir }),
    diff: (root, file, untracked, remoteId, scope, origPath) => remoteId
      ? ipc.diff(root, file, untracked, remoteId, scope, origPath)
      : readWithFallback(
        () => call('diff', { root, file, untracked, scope, origPath }),
        () => ipc.diff(root, file, untracked, remoteId, scope, origPath)
      )
  }
}
