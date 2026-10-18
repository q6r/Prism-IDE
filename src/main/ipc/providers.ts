import { ipcMain, app, type WebContents } from 'electron'
import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { readdir, rename, rm } from 'fs/promises'
import { join, dirname } from 'path'
import * as pty from '@homebridge/node-pty-prebuilt-multiarch'
import { homedir } from 'os'
import { agentStore, createProfile, getProfile, profileEnvironment, providerCommand, linkState, publicProfiles } from '../providers'
import type { Provider, UnifiedChat, ProfileStatus, AgentTask } from '../../shared/agents'
import { isProfileFolderName, loginRefusal, loginSessionId, loginTerminalSize, profileRemovalError, purgeProfileTrash, removeProfileFolder,
  runProfileRemoval, tombstoneProfile, unprobedStatus, type ProfileFolderOps } from './providerProfiles'
import { flushChatsNow, flushTasksNow, importChatDocs, listChats, listTasks, reassignProfile, removeChats, saveTasks } from '../hostChats'
import { hostBinaryPresent } from '../host/supervisor'

/** Retries cover Windows' EBUSY while the processes this removal just ended let go of their files. */
const folderOps: ProfileFolderOps = { join, rename, rm: (path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) }

export function registerProviderHandlers(): void {
  const profilesBase = join(app.getPath('userData'), 'provider-profiles')
  // What an earlier removal could not delete: trash folders and leftovers of removed profiles.
  // With a host binary the host purges them from its own tombstones (T08): the
  // ones here are old, and a profile it brought back would lose its folder.
  if (!hostBinaryPresent()) {
    const removed = new Set(agentStore.get('profiles').filter((p) => p.tombstoned).map((p) => p.id))
    void readdir(profilesBase).then((names) => purgeProfileTrash(profilesBase, names, folderOps, removed)).catch(() => undefined)
  }
  /** One CLI login per profile; `session` tags its events so a stale exit never reaches a newer login. */
  const logins = new Map<string, { terminal: pty.IPty; owner: number; session: string }>()
  const kill = (id: string): void => {
    const login = logins.get(id)
    if (!login) return
    logins.delete(id)
    try { login.terminal.kill() } catch { /* Already exited. */ }
  }
  /** Ends `id`'s login and resolves once its terminal has exited (or after `ms`, if it never reports). */
  const endLogin = (id: string, ms = 3000): Promise<void> => {
    const login = logins.get(id)
    if (!login) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      login.terminal.onExit(() => { clearTimeout(timer); resolve() })
      kill(id)
    })
  }
  const cancel = (id: string, owner: number, session?: unknown): void => {
    const login = logins.get(id)
    if (login?.owner !== owner) return
    if (typeof session === 'string' && session !== login.session) return
    kill(id)
  }
  const cancelOwned = (owner: number): void => { for (const [id, l] of [...logins]) if (l.owner === owner) kill(id) }
  // Watched once per window: a reload or navigation ends its logins too, so the
  // next attempt is not refused as "already open", and listeners never pile up.
  const watched = new Set<number>()
  const watch = (sender: WebContents): void => {
    const owner = sender.id
    if (watched.has(owner)) return
    watched.add(owner)
    sender.on('did-start-navigation', (...args: unknown[]) => {
      const [event, , isInPlace, isMainFrame] = args as [{ isMainFrame?: boolean; isSameDocument?: boolean }, unknown, boolean | undefined, boolean | undefined]
      const mainFrame = event?.isMainFrame ?? isMainFrame
      const sameDocument = event?.isSameDocument ?? isInPlace
      if (mainFrame && !sameDocument) cancelOwned(owner)
    })
    sender.on('render-process-gone', () => cancelOwned(owner))
    sender.once('destroyed', () => { cancelOwned(owner); watched.delete(owner) })
  }
  app.on('before-quit', () => { for (const id of [...logins.keys()]) kill(id) })
  // Chats and tasks go through hostChats: the host owns them once it serves `chats@1`.
  ipcMain.handle('tasks:load', () => listTasks())
  // The window's last save while closing; a host write is awaited before the app quits.
  ipcMain.on('tasks:flush', (e, tasks: AgentTask[], openIds: string[], activeId: string | null) => {
    try { flushTasksNow(tasks, openIds, activeId); e.returnValue={ok:true} }
    catch { e.returnValue={ok:false} }
  })
  ipcMain.handle('tasks:save', (_e, tasks: AgentTask[], openIds: string[], activeId: string | null) => {
    if (!Array.isArray(tasks) || tasks.some(t => typeof t.id !== 'string' || typeof t.cwd !== 'string' || typeof t.title !== 'string')) throw new Error('Projeto inválido.')
    return saveTasks(tasks, openIds.filter(id => tasks.some(t => t.id === id)), activeId)
  })
  ipcMain.handle('providers:update', async (_e, id: string, patch: {name?: string; enabled?: boolean; color?: string}) => {
    if (id.startsWith('ambient-')) throw new Error('A conta do terminal é gerenciada pelo terminal.')
    if (patch.name !== undefined && !patch.name.trim()) throw new Error('Informe um nome.')
    if (patch.color && !/^#[0-9a-f]{6}$/i.test(patch.color)) throw new Error('Cor inválida.')
    // Disabling ends the account's sessions; a name or a color never touches a running turn.
    if (patch.enabled === false && (await listChats()).some(c => c.selection.profileId === id && c.pendingTurnId)) throw new Error('Pare as tarefas desta conta antes de alterá-la.')
    agentStore.set('profiles', agentStore.get('profiles').map(p => p.id === id ? {...p,
      ...(patch.name !== undefined ? {name: patch.name.trim().slice(0,80)} : {}),
      ...(patch.enabled !== undefined ? {enabled: !!patch.enabled} : {}), ...(patch.color ? {color: patch.color} : {})} : p))
    if (patch.enabled === false) app.emit('prism:profile-changed', id)
    return publicProfiles()
  })
  // Every list sent to the renderer is the public one: link state, never Traycer paths.
  ipcMain.handle('providers:list', () => publicProfiles())
  ipcMain.handle('providers:create', (_e, provider: Provider, name: string) => createProfile(provider, name))
  ipcMain.handle('providers:rename', (_e, id: string, name: string) => {
    if (!name?.trim()) throw new Error('Informe um nome.')
    agentStore.set('profiles', agentStore.get('profiles').map((p) => p.id === id ? { ...p, name: name.trim().slice(0, 80) } : p))
    return publicProfiles()
  })
  ipcMain.handle('providers:status', async (_e, provider: Provider, id: string): Promise<ProfileStatus> => {
    const p = getProfile(provider, id)
    const link = linkState(p)
    // Disabled, or a broken link (never probed: that would fall back to the profile's own stale copy).
    const answered = unprobedStatus(p.enabled !== false, link, !!providerCommand(provider, id))
    if (answered) return answered
    const env = profileEnvironment(provider, id)
    const command = providerCommand(provider, id)
    const viaTraycer = link === 'linked'
    if (!command) return { installed: false, loggedIn: false, detail: `${provider === 'claude' ? 'Claude Code' : 'Codex'} não instalado.` }
    return new Promise((resolve) => {
      let out = '', done = false
      const child = spawn(command.bin, [...command.args, ...(provider === 'claude' ? ['auth', 'status']
        : ['login', 'status', ...(!p.ambient ? ['-c', 'cli_auth_credentials_store="file"'] : [])])],
        { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      const finish = (code: number): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        let loggedIn = code === 0, email: string | undefined, tier: string | undefined
        if (provider === 'claude') {
          try { const auth=JSON.parse(out); loggedIn = auth.loggedIn === true; email=auth.email; tier=auth.subscriptionType } catch { loggedIn = code === 0 && /logged in|authenticated/i.test(out) }
        }
        resolve({ installed: true, loggedIn, email, tier, detail: viaTraycer
          ? loggedIn ? 'Conectada pelo login do Traycer' : 'Entre nesta conta pelo Traycer.'
          : loggedIn ? 'Conectada' : 'Faça login nesta conta.' })
      }
      const timer = setTimeout(() => { child.kill(); finish(1) }, 15000)
      child.stdout.on('data', (d) => { out += d.toString() })
      child.stderr.on('data', (d) => { out += d.toString() })
      child.on('error', () => finish(1))
      child.on('close', (code) => finish(code ?? 1))
    })
  })
  ipcMain.handle('providers:login', async (e, provider: Provider, id: string, options?: { session?: unknown; cols?: unknown; rows?: unknown }) => {
    getProfile(provider, id)
    // Read first: from here on nothing waits, so two logins cannot both pass the check.
    const chats = await listChats()
    const p = getProfile(provider, id)
    // Linked or broken alike, a Traycer link refuses: a login here would overwrite (or fork) Traycer's.
    const refusal = loginRefusal(p, chats, logins.has(id))
    if (refusal) throw new Error(refusal)
    const command = providerCommand(provider, id)
    if (!command) throw new Error(`Instale ${provider === 'claude' ? 'Claude Code' : 'Codex'} e tente novamente.`)
    // The renderer names the session up front so it can match events that arrive before this reply.
    const session = loginSessionId(options?.session) ?? randomUUID()
    const terminal = pty.spawn(command.bin, [...command.args,
      ...(provider === 'claude' ? ['auth', 'login', '--claudeai'] : ['login', '--device-auth', '-c', 'cli_auth_credentials_store="file"'])], {
      name: 'xterm-256color', ...loginTerminalSize(options), cwd: homedir(),
      env: { ...profileEnvironment(provider, id), ELECTRON_RUN_AS_NODE: '1' } as Record<string, string>
    })
    logins.set(id, { terminal, owner: e.sender.id, session })
    const send = (event: object): void => { if (!e.sender.isDestroyed()) e.sender.send('providers:login-event', { profileId: id, session, ...event }) }
    terminal.onData((text) => send({ kind: 'data', text }))
    terminal.onExit(({ exitCode }) => {
      if (logins.get(id)?.terminal === terminal) logins.delete(id)
      app.emit('prism:profile-changed', id)
      send({ kind: 'exit', code: exitCode })
    })
    watch(e.sender)
    return session
  })
  ipcMain.on('providers:login-input', (e, id: string, text: string) => {
    const l = logins.get(id)
    if (l?.owner === e.sender.id && typeof text === 'string') l.terminal.write(text)
  })
  ipcMain.on('providers:login-resize', (e, id: string, size: unknown) => {
    const l = logins.get(id)
    if (l?.owner !== e.sender.id) return
    try { const { cols, rows } = loginTerminalSize(size); l.terminal.resize(cols, rows) } catch { /* Exited meanwhile. */ }
  })
  ipcMain.on('providers:login-cancel', (e, id: string, session?: unknown) => cancel(id, e.sender.id, session))
  /**
   * Removes a profile: its chats moved to the provider's terminal account
   * (the host refuses with `busy` while one runs, and then nothing changes),
   * the profile tombstoned (so old references resolve to "removed"), then
   * everything still running on it closed (idle sessions and app-servers on
   * the change event, the login terminal awaited) BEFORE its Prism-owned
   * folder is deleted, so nothing rewrites a login there afterwards. A folder
   * that stays locked goes to the trash for the next boot. Never a Traycer
   * account folder; the terminal account itself cannot be removed.
   */
  ipcMain.handle('providers:remove', async (_e, id: string) => {
    const chats = await listChats()
    const refusal = profileRemovalError(agentStore.get('profiles'), chats, id)
    if (refusal) throw new Error(refusal)
    try { await reassignProfile(id) } catch (err) { throw new Error((err as Error).message) }
    const outcome = await runProfileRemoval({
      retire: () => { agentStore.set('profiles', tombstoneProfile(agentStore.get('profiles'), id)) },
      // Idle Claude sessions and Codex app-servers of this profile close on this event.
      announce: () => { app.emit('prism:profile-changed', id) },
      endLogin: () => endLogin(id),
      removeFolder: async () => isProfileFolderName(id) && dirname(join(profilesBase, id)) === profilesBase
        ? removeProfileFolder(profilesBase, id, folderOps) : 'skipped' as const
    })
    if (outcome === 'kept') console.warn(`[providers] A pasta do perfil removido ${id} continua em uso; nova tentativa no próximo início.`)
    return publicProfiles()
  })
  ipcMain.handle('chats:list', () => listChats())
  ipcMain.handle('chats:save', async (_e, chat: UnifiedChat) => {
    if (!chat || typeof chat.id !== 'string' || !chat.id || !Array.isArray(chat.turns) || typeof chat.cwd !== 'string') throw new Error('Conversa inválida.')
    getProfile(chat.selection.provider, chat.selection.profileId)
    const { skipped } = await importChatDocs([chat])
    if (skipped.length) throw new Error('Esta conversa está em execução. Aguarde antes de substituir seu histórico.')
    return true
  })
  ipcMain.handle('chats:delete', async (_e, id: string) => {
    await removeChats([id])
    return true
  })
  // Only used during beforeunload. A synchronous snapshot flush lets both
  // close and reload complete without losing the final streamed deltas.
  ipcMain.on('chats:flush', (e, snapshots: UnifiedChat[]) => {
    try {
      if (!Array.isArray(snapshots)) throw new Error('Snapshot inválido.')
      for (const chat of snapshots) {
        if (!chat || typeof chat.id !== 'string' || !Array.isArray(chat.turns)) throw new Error('Conversa inválida.')
        getProfile(chat.selection.provider, chat.selection.profileId)
      }
      flushChatsNow(snapshots)
      e.returnValue = { ok: true }
    } catch (err) { e.returnValue = { ok: false, error: (err as Error).message } }
  })
}
