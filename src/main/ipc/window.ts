import { ipcMain, BrowserWindow, IpcMainEvent, IpcMainInvokeEvent } from 'electron'

export function registerWindowHandlers(createWindow: () => BrowserWindow): void {
  // Target the window that sent the message so controls work with multiple windows.
  const win = (e: IpcMainEvent | IpcMainInvokeEvent): BrowserWindow | null =>
    BrowserWindow.fromWebContents(e.sender)

  ipcMain.on('window:minimize', (e) => win(e)?.minimize())

  ipcMain.on('window:maximize-toggle', (e) => {
    const w = win(e)
    if (!w) return
    if (w.isMaximized()) w.unmaximize()
    else w.maximize()
  })

  ipcMain.on('window:close', (e) => win(e)?.close())

  ipcMain.handle('window:is-maximized', (e) => win(e)?.isMaximized() ?? false)

  ipcMain.on('window:new', () => createWindow())
}
