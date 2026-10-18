import { ipcMain, dialog, BrowserWindow } from 'electron'
import { basename } from 'path'

export function registerDialogHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('dialog:openFolder', async () => {
    const win = getWindow()
    const result = await dialog.showOpenDialog(win!, {
      title: 'Abrir pasta no Prism',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // Workspace files when the host serves `workspace`: the shell only picks
  // the path; the host reads and writes the file.
  const WORKSPACE_FILTERS = [{ name: 'Prism Workspace', extensions: ['prism-workspace'] }]
  ipcMain.handle('dialog:workspaceSavePath', async (e, folders: string[]) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const first = Array.isArray(folders) && folders[0] ? basename(folders[0]) : 'projeto'
    const opts = { title: 'Salvar workspace', defaultPath: `${first}.prism-workspace`, filters: WORKSPACE_FILTERS }
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    return r.canceled || !r.filePath ? null : r.filePath
  })

  ipcMain.handle('dialog:workspaceOpenPath', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts = { title: 'Abrir workspace', properties: ['openFile' as const], filters: WORKSPACE_FILTERS }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
  })

  ipcMain.handle('dialog:openFile', async () => {
    const win = getWindow()
    const result = await dialog.showOpenDialog(win!, {
      title: 'Abrir arquivo',
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })
}
