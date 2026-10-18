import { ipcMain } from 'electron'
import {
  listExtensions,
  setExtensionEnabled,
  setExtensionConfig,
  pushEditorState
} from '../extensions'
import { EditorState } from '../extensions/types'

export function registerExtensionHandlers(): void {
  ipcMain.handle('ext:list', () => listExtensions())
  ipcMain.handle('ext:setEnabled', (_e, id: string, enabled: boolean) =>
    setExtensionEnabled(id, enabled)
  )
  ipcMain.handle('ext:setConfig', (_e, id: string, config: Record<string, unknown>) =>
    setExtensionConfig(id, config)
  )
  ipcMain.on('editor:state', (_e, state: EditorState) => pushEditorState(state))
}
