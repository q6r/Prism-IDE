import { ipcMain } from 'electron'
import { isAbsolute } from 'path'
import { existsSync } from 'fs'
import { store, PrismSettings, RecentRemote } from '../store'

const cleanRemotes = (list: unknown): RecentRemote[] =>
  Array.isArray(list)
    ? (list as RecentRemote[]).filter(
        (r) => r && typeof r.host === 'string' && typeof r.username === 'string'
      )
    : []

// Recent folders/workspaces must be absolute paths; a relative entry (e.g. just
// a basename) would resolve against the app's cwd and break the explorer.
const cleanRecents = (list: unknown): string[] =>
  Array.isArray(list) ? (list as string[]).filter((p) => typeof p === 'string' && isAbsolute(p)) : []

// Recent workspaces also drop entries whose file no longer exists.
const cleanWorkspaces = (list: unknown): string[] =>
  cleanRecents(list).filter((p) => p.endsWith('.prism-workspace') && existsSync(p))

export function registerSettingsHandlers(): void {
  ipcMain.handle('settings:getAll', () => {
    const all = store.store
    // Never leak the raw API key to the renderer — only whether it's set.
    return {
      model: all.model,
      oneMillionContext: all.oneMillionContext !== false,
      effort: all.effort,
      thinkingEnabled: all.thinkingEnabled,
      chatEngine: all.chatEngine ?? 'agent',
      permissionMode: all.permissionMode ?? 'default',
      animations: all.animations !== false,
      notifyOnAsk: all.notifyOnAsk !== false,
      notifyOnDone: all.notifyOnDone !== false,
      fontSize: all.fontSize,
      tabSize: all.tabSize,
      theme: all.theme,
      wordWrap: all.wordWrap,
      autoSave: all.autoSave === true,
      recentFolders: cleanRecents(all.recentFolders),
      recentWorkspaces: cleanWorkspaces(all.recentWorkspaces),
      recentRemotes: cleanRemotes(all.recentRemotes),
      sidebarWidth: all.sidebarWidth,
      chatWidth: all.chatWidth,
      terminalHeight: all.terminalHeight,
      apiKeyConfigured: !!all.anthropicApiKey
    }
  })

  ipcMain.handle('settings:get', (_e, key: keyof PrismSettings) => {
    if (key === 'anthropicApiKey') return undefined // never expose
    return store.get(key)
  })

  ipcMain.handle('settings:set', (_e, key: keyof PrismSettings, value: unknown) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.set(key, value as any)
    return true
  })

  ipcMain.handle('app:addRecent', (_e, folder: string) => {
    const current = cleanRecents(store.get('recentFolders'))
    // Ignore non-absolute paths so a bad value can never poison the list.
    if (!folder || !isAbsolute(folder)) return current
    const next = [folder, ...current.filter((f) => f !== folder)].slice(0, 8)
    store.set('recentFolders', next)
    return next
  })

  ipcMain.handle('app:getRecents', () => cleanRecents(store.get('recentFolders')))

  ipcMain.handle('app:addRecentWorkspace', (_e, file: string) => {
    const current = cleanWorkspaces(store.get('recentWorkspaces'))
    if (!file || !isAbsolute(file) || !file.endsWith('.prism-workspace')) return current
    const next = [file, ...current.filter((f) => f !== file)].slice(0, 8)
    store.set('recentWorkspaces', next)
    return next
  })

  ipcMain.handle('app:addRecentRemote', (_e, remote: RecentRemote) => {
    const current = cleanRemotes(store.get('recentRemotes'))
    if (!remote || !remote.host || !remote.username) return current
    const same = (r: RecentRemote): boolean =>
      r.host === remote.host && r.username === remote.username && r.port === remote.port
    const next = [remote, ...current.filter((r) => !same(r))].slice(0, 8)
    store.set('recentRemotes', next)
    return next
  })

  ipcMain.handle('app:getRecentRemotes', () => cleanRemotes(store.get('recentRemotes')))
}
