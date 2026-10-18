import { ipcMain } from 'electron'
import { store, SshHost } from '../store'

/**
 * Saved SSH hosts (electron-store). Passwords are NOT saved by default; when the
 * user opts in to "remember", they're kept locally under `sshSecrets` (plaintext
 * — a keychain is a future hardening). Saved hosts never include a password.
 */

let hostSeq = 0

export function registerSshHostHandlers(): void {
  ipcMain.handle('ssh:hosts:list', () => (store.get('sshHosts') as SshHost[]) ?? [])

  ipcMain.handle('ssh:hosts:save', (_e, host: Omit<SshHost, 'id'> & { id?: string }) => {
    const list = (store.get('sshHosts') as SshHost[]) ?? []
    const id = host.id || `h${Date.now()}_${hostSeq++}`
    const entry: SshHost = {
      id,
      name: host.name || `${host.username}@${host.host}`,
      host: host.host,
      port: host.port || 22,
      username: host.username,
      authType: host.authType,
      keyPath: host.keyPath
    }
    const next = host.id ? list.map((h) => (h.id === id ? entry : h)) : [...list, entry]
    store.set('sshHosts', next)
    return next
  })

  ipcMain.handle('ssh:hosts:delete', (_e, id: string) => {
    const list = (store.get('sshHosts') as SshHost[]) ?? []
    store.set(
      'sshHosts',
      list.filter((h) => h.id !== id)
    )
    const secrets = (store.get('sshSecrets') as Record<string, string>) ?? {}
    delete secrets[id]
    store.set('sshSecrets', secrets)
    return store.get('sshHosts')
  })

  // Remembered password for a saved host (never sent in the host list).
  ipcMain.handle('ssh:hosts:getSecret', (_e, id: string) => {
    const secrets = (store.get('sshSecrets') as Record<string, string>) ?? {}
    return secrets[id] ?? null
  })

  ipcMain.handle('ssh:hosts:setSecret', (_e, id: string, password: string | null) => {
    const secrets = (store.get('sshSecrets') as Record<string, string>) ?? {}
    if (password) secrets[id] = password
    else delete secrets[id]
    store.set('sshSecrets', secrets)
    return true
  })
}
