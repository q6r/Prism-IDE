import { ipcMain, dialog, BrowserWindow } from 'electron'
import { promises as fs } from 'fs'
import { basename, dirname, resolve, isAbsolute } from 'path'

/**
 * Lightweight workspace files (`.prism-workspace`, JSON, VS Code-compatible
 * shape). A workspace records a set of root folders so a project layout can be
 * saved and reopened. Folder paths may be absolute or — like VS Code's
 * `.code-workspace` — relative to the workspace file's own directory.
 */

interface WorkspaceFile {
  folders: { path: string }[]
  settings?: Record<string, unknown>
}

// Resolve folder paths declared in a workspace file. Relative paths resolve
// against the workspace file's directory (VS Code semantics), and only folders
// that actually exist on disk are returned.
async function resolveFolders(wsFile: string, data: WorkspaceFile): Promise<string[]> {
  const dir = dirname(wsFile)
  const resolved = (data.folders ?? [])
    .map((f) => f?.path)
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .map((p) => (isAbsolute(p) ? p : resolve(dir, p)))
  const existing: string[] = []
  for (const p of resolved) {
    try {
      if ((await fs.stat(p)).isDirectory()) existing.push(p)
    } catch {
      /* folder no longer exists — skip */
    }
  }
  return existing
}

export function registerWorkspaceHandlers(): void {
  ipcMain.handle('workspace:save', async (e, folders: string[]) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const first = folders[0] ? basename(folders[0]) : 'projeto'
    const opts = {
      title: 'Salvar workspace',
      defaultPath: `${first}.prism-workspace`,
      filters: [{ name: 'Prism Workspace', extensions: ['prism-workspace'] }]
    }
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (r.canceled || !r.filePath) return null
    const data: WorkspaceFile = { folders: folders.map((p) => ({ path: p })) }
    await fs.writeFile(r.filePath, JSON.stringify(data, null, 2), 'utf8')
    return r.filePath
  })

  ipcMain.handle('workspace:open', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts = {
      title: 'Abrir workspace',
      properties: ['openFile' as const],
      filters: [{ name: 'Prism Workspace', extensions: ['prism-workspace'] }]
    }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (r.canceled || !r.filePaths[0]) return null
    try {
      const file = r.filePaths[0]
      const data = JSON.parse(await fs.readFile(file, 'utf8')) as WorkspaceFile
      return { file, folders: await resolveFolders(file, data) }
    } catch {
      return null
    }
  })

  // Open a workspace passed directly (e.g. from a recent list).
  ipcMain.handle('workspace:read', async (_e, file: string) => {
    try {
      const data = JSON.parse(await fs.readFile(file, 'utf8')) as WorkspaceFile
      return { file, folders: await resolveFolders(file, data) }
    } catch {
      return null
    }
  })
}
