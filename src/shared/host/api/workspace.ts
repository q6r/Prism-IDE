import type { HostClient } from '../client'
import type { WorkspaceInfo } from '../generated/WorkspaceInfo'
import { readWithFallback } from './call'

/** `window.prism.workspace`. */
export interface WorkspaceApi {
  save(folders: string[]): Promise<string | null>
  open(): Promise<WorkspaceInfo | null>
  read(file: string): Promise<WorkspaceInfo | null>
}

/** Choosing a workspace file is the shell's (a native dialog on the desktop). */
export interface WorkspacePicker {
  savePath(folders: string[]): Promise<string | null>
  openPath(): Promise<string | null>
}

/** The host reads and writes the `.prism-workspace` file; the shell picks it. */
export function createHostWorkspace(deps: { client: HostClient; picker: WorkspacePicker; ipc: WorkspaceApi }): WorkspaceApi {
  const { client, picker, ipc } = deps
  const read = (file: string): Promise<WorkspaceInfo | null> =>
    readWithFallback(() => client.call<WorkspaceInfo | null>('workspace.read', { file }), () => ipc.read(file))
  return {
    save: async (folders) => {
      const file = await picker.savePath(folders)
      return file ? client.call<string>('workspace.write', { file, folders }) : null
    },
    open: async () => {
      const file = await picker.openPath()
      return file ? read(file) : null
    },
    read
  }
}
