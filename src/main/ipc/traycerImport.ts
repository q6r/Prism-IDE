import { app, dialog, ipcMain } from 'electron'
import { createHash } from 'crypto'
import { existsSync, readFileSync, readdirSync, realpathSync, lstatSync, mkdirSync, renameSync, copyFileSync } from 'fs'
import { join, resolve, relative, isAbsolute, dirname } from 'path'
import { homedir } from 'os'
import { DatabaseSync } from 'node:sqlite'
import { agentStore, publicProfiles, traycerAccount, credentialFile, type StoredProfile, type CredentialLink } from '../providers'
import { chatsBackend, hostProfileList, importChatDocs, importHostProfiles, listChats, listTasks, mergeTasks, profilesBackend, removeChats, setProfileLink, storedProfiles } from '../hostChats'
import type { Provider, ProviderProfile, UnifiedChat, SharedTurn } from '../../shared/agents'
import { traycerTurn, type TraycerImportPreview, type TraycerImportRequest, type TraycerImportResult } from '../../shared/traycerImport'

type Row = Record<string, any>
const uuid = /^[a-zA-Z0-9_-]+$/
const parse = (text: unknown): Row => typeof text === 'string' ? JSON.parse(text) : {}
const providerFor = (id: unknown): Provider | null => id === 'claude' || id === 'claude-code' ? 'claude' : id === 'codex' ? 'codex' : null
export function rootPath(path?: string): string {
  const root = realpathSync(resolve(path || join(homedir(), '.traycer')))
  if (!existsSync(join(root, 'host'))) throw new Error('Selecione a pasta .traycer que contém a pasta host.')
  return root
}
export function importedId(root: string, kind: string, source: string): string {
  return 'traycer-' + createHash('sha256').update(`${process.platform === 'win32' ? root.toLowerCase() : root}\0${kind}\0${source}`).digest('hex').slice(0, 32)
}
function within(root: string, path: string): boolean {
  const r = relative(root, path)
  return r === '' || (!r.startsWith('..') && !isAbsolute(r))
}
function sourceProfiles(root: string): Row[] {
  const path = join(root, 'host', 'config', 'provider-accounts.json')
  if (!existsSync(path)) return []
  const data = JSON.parse(readFileSync(path, 'utf8'))
  return (Array.isArray(data.profiles) ? data.profiles : []).filter((p: Row) =>
    p.kind === 'managed' && !p.tombstoned && providerFor(p.providerId) && typeof p.profileId === 'string' && uuid.test(p.profileId))
}
/**
 * The Traycer account directory holding this profile's login, if it has one.
 * On macOS Claude Code keeps the OAuth login in the Keychain, under an entry
 * keyed by the exact CLAUDE_CONFIG_DIR, so the account folder itself is the
 * login: the link passes Traycer's own `dirPath` spelling and runs Traycer's
 * managed CLI (the binary the Keychain item trusts). Not verified on a Mac.
 */
function loginHome(root: string, p: Row): string | null {
  const provider = providerFor(p.providerId)
  const account = provider && traycerAccount(root, provider, p.profileId)
  if (!account) return null
  if (process.platform === 'darwin' && provider === 'claude') return account.home
  const file = join(account.home, credentialFile(provider))
  return existsSync(file) && lstatSync(file).isFile() ? account.home : null
}

/** Field by field: a link read back from the host may list its keys in another order. */
function sameLink(a: CredentialLink | undefined, b: CredentialLink): boolean {
  return !!a && a.root === b.root && a.providerId === b.providerId && a.profileId === b.profileId
}
/** Running chats keep their account. */
function refuseRunning(p: StoredProfile, chats: UnifiedChat[]): void {
  if (chats.some(c => c.selection?.profileId === p.id && c.pendingTurnId)) throw new Error(`Pare as tarefas da conta “${p.name}” antes de trocar o login dela.`)
}
/** Running chats keep their account; native sessions belong to the previous folder. */
function retarget(p: StoredProfile, chats: UnifiedChat[], link: CredentialLink | null): UnifiedChat[] {
  refuseRunning(p, chats)
  if (link) p.credentialLink = link
  else delete p.credentialLink
  const changed: UnifiedChat[] = []
  for (const c of chats) if (c.resume?.route === `${p.provider}:${p.id}`) { delete c.resume; changed.push(c) }
  return changed
}
/**
 * Retires the login an older import copied into the profile's own folder: a
 * forked copy of the rotating refresh token that must never run again. Renamed
 * rather than deleted; Traycer's folder is never touched.
 */
function quarantineCopy(p: StoredProfile): string | null {
  const file = join(app.getPath('userData'), 'provider-profiles', p.id, credentialFile(p.provider))
  try { if (existsSync(file)) renameSync(file, `${file}.replaced-by-traycer-link-${Date.now()}`); return null }
  catch { return `“${p.name}”: não foi possível desativar a cópia antiga do login; ela não é usada enquanto o vínculo existir.` }
}
/** Prism profiles imported from this Traycer root, by Prism id. */
function importedSources(root: string): Map<string, Row> {
  return new Map(sourceProfiles(root).map((s) => [importedId(root, 'profile', s.profileId), s]))
}
export function database(root: string, epicId: string): DatabaseSync {
  if (!uuid.test(epicId)) throw new Error('Identificador de tarefa inválido.')
  const path = join(root, 'host', 'epic-state', epicId, 'chat', 'chat.db')
  if (!within(realpathSync(join(root, 'host', 'epic-state')), realpathSync(path))) throw new Error('Banco fora da pasta selecionada.')
  return new DatabaseSync(path, { readOnly: true })
}
const samePath = (a: string, b: string): boolean => {
  const norm = (p: string): string => { try { return realpathSync(p) } catch { return resolve(p) } }
  const x = norm(a), y = norm(b)
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y
}

/**
 * The native CLI session Traycer ran this chat on (`activeSessionChain`): its
 * provider, the session id the CLI resumes, and the Traycer account whose home
 * holds the session file. `null` when there is none, or the harness has no Prism
 * provider (a Traycer-only agent).
 */
function nativeSession(root: string, epicId: string, chatId: string): { provider: Provider; sessionId: string; traycerProfileId: string } | null {
  const db = database(root, epicId)
  try {
    const head = db.prepare('SELECT host_private_json FROM chat_projection_head WHERE chat_id=?').get(chatId) as Row
    const chain = parse(head?.host_private_json)?.data?.activeSessionChain || {}
    const provider = providerFor(chain.harnessId)
    const sessionId = typeof chain.sessionId === 'string' ? chain.sessionId : ''
    const traycerProfileId = typeof chain.profileId === 'string' ? chain.profileId : ''
    return provider && sessionId && uuid.test(sessionId) && traycerProfileId ? { provider, sessionId, traycerProfileId } : null
  } finally { db.close() }
}

/** The CLI session file for `sessionId` under `home`, read-only. Codex keeps a
 * rollout in `sessions/<date>/`; Claude keeps `<sessionId>.jsonl` in `projects/<cwd key>/`. */
function sessionFile(home: string, provider: Provider, sessionId: string): string | null {
  const base = join(home, provider === 'codex' ? 'sessions' : 'projects')
  if (!existsSync(base)) return null
  try {
    for (const rel of readdirSync(base, { recursive: true }) as string[]) {
      const name = rel.split(/[\\/]/).pop() || ''
      const matches = provider === 'codex' ? name.endsWith('.jsonl') && name.includes(sessionId) : name === `${sessionId}.jsonl`
      if (!matches) continue
      const full = join(base, rel)
      if (within(realpathSync(base), realpathSync(full)) && lstatSync(full).isFile()) return full
    }
  } catch { /* unreadable layout */ }
  return null
}

/**
 * The CLI home (CODEX_HOME/CLAUDE_CONFIG_DIR) the host will run this chat's
 * account in, decided from the import request (the credential link is applied
 * only later): the terminal's default for an ambient account, Traycer's account
 * folder for a profile that will be linked (its login used in place), else the
 * profile's own folder in the app data.
 */
function targetCliHome(provider: Provider, selectionProfileId: string, sources: Row[], copyCredentials: boolean, root: string): string {
  if (selectionProfileId.startsWith('ambient-')) return join(homedir(), provider === 'codex' ? '.codex' : '.claude')
  const source = sources.find((s) => importedId(root, 'profile', s.profileId) === selectionProfileId)
  const willLink = !!source && copyCredentials && !!loginHome(root, source)
  if (willLink && source) {
    const account = traycerAccount(root, provider, source.profileId)
    if (account) return account.home
  }
  return join(app.getPath('userData'), 'provider-profiles', selectionProfileId)
}

/**
 * Brings Traycer's native session within reach of the chat's Prism account so a
 * send resumes it (full history, compaction) instead of replaying the transcript
 * — Traycer's own behaviour. Copies the session file into the account's CLI home
 * when it is not already there (never touches Traycer's copy or auth). Returns
 * the resume to store, or `null` to fall back to the bounded transcript.
 *
 * Skipped when: the chat switched provider (no native session for it), the
 * session file is gone, or Claude would need a folder the user has not bound yet
 * (its session is keyed by the working directory).
 */
function prepareNativeResume(args: { root: string; epicId: string; chatId: string; provider: Provider; selectionProfileId: string; workspaceNeedsBinding: boolean; sources: Row[]; copyCredentials: boolean }): UnifiedChat['resume'] | null {
  const native = nativeSession(args.root, args.epicId, args.chatId)
  if (!native || native.provider !== args.provider) return null
  if (args.provider === 'claude' && args.workspaceNeedsBinding) return null
  const sourceHome = traycerAccount(args.root, args.provider, native.traycerProfileId)?.home
  const source = sourceHome ? sessionFile(sourceHome, args.provider, native.sessionId) : null
  if (!sourceHome || !source) return null
  const targetHome = targetCliHome(args.provider, args.selectionProfileId, args.sources, args.copyCredentials, args.root)
  if (!samePath(sourceHome, targetHome)) {
    const sub = args.provider === 'codex' ? 'sessions' : 'projects'
    const dest = join(targetHome, sub, relative(join(sourceHome, sub), source))
    if (!existsSync(dest)) { mkdirSync(dirname(dest), { recursive: true }); copyFileSync(source, dest) }
  }
  return { route: `${args.provider}:${args.selectionProfileId}`, sessionId: native.sessionId }
}

/** Reads one Traycer chat's visible turns and its project folder, read-only. */
function readTraycerChat(root: string, epicId: string, chatId: string, provider: Provider): { turns: SharedTurn[]; cwd: string; settings: Row; tui: Row } {
  const db = database(root, epicId)
  try {
    db.exec('BEGIN')
    const head = db.prepare('SELECT settings_json,host_private_json,tui_agent_json,lifecycle_state FROM chat_projection_head WHERE chat_id=?').get(chatId) as Row
    if (!head || head.lifecycle_state === 'deleted') throw new Error('O chat foi excluído no Traycer; atualize a lista.')
    const settings = parse(head.settings_json), host = parse(head.host_private_json), tui = parse(head.tui_agent_json)
    const turns: SharedTurn[] = []
    let cwd = host.data?.activeSessionChain?.sessionWorkspaceSnapshot?.primaryWorkspace || tui.cwd || ''
    for (const row of db.prepare('SELECT body FROM chat_message WHERE chat_id=? AND removed_seq IS NULL ORDER BY insert_seq').iterate(chatId) as Iterable<Row>) {
      const message = JSON.parse(row.body)
      const turn = traycerTurn(message, providerFor(message.sender?.harnessId) || provider)
      if (turn) turns.push(turn)
      cwd ||= message.sessionAnchor?.sessionWorkspaceSnapshot?.primaryWorkspace || ''
    }
    db.exec('COMMIT')
    return { turns, cwd: typeof cwd === 'string' ? cwd : '', settings, tui }
  } finally { db.close() }
}
/**
 * Whether the user carried an imported chat forward inside Prism, so a refresh
 * must not overwrite its history: a run left a native session (`resume`) or a
 * run id, a turn is in flight, or there are more turns than were imported.
 */
function continuedInPrism(chat: UnifiedChat): boolean {
  if (chat.pendingTurnId || chat.resume || chat.lastRunId) return true
  const synced = chat.traycerSource?.syncedTurns
  return typeof synced === 'number' && chat.turns.length !== synced
}
export async function previewTraycer(path?: string): Promise<TraycerImportPreview> {
  const root = rootPath(path)
  const stored = new Map((await storedProfiles()).map((p) => [p.id, p]))
  const profiles = sourceProfiles(root).map((p) => {
    const mine = stored.get(importedId(root, 'profile', p.profileId))
    return { id: p.profileId, provider: providerFor(p.providerId)!, name: p.label || 'Conta Traycer',
      credentialsAvailable: loginHome(root, p) !== null, ambient: false,
      imported: !!mine && !mine.tombstoned, linked: !!mine && !mine.tombstoned && mine.credentialLink?.profileId === p.profileId }
  })
  const preview: TraycerImportPreview = { root, profiles, chats: [], warnings: [] }
  const state = join(root, 'host', 'epic-state')
  if (!existsSync(state)) { preview.warnings.push('Nenhum banco local de chats encontrado.'); return preview }
  const existing = new Set((await listChats()).map((c) => c.id))
  for (const entry of readdirSync(state, { withFileTypes: true })) {
    if (!entry.isDirectory() || !uuid.test(entry.name) || !existsSync(join(state, entry.name, 'chat', 'chat.db'))) continue
    let db: DatabaseSync | undefined
    try {
      db = database(root, entry.name)
      for (const h of db.prepare(`SELECT h.*,h.settings_json,h.tui_agent_json,h.updated_at,
        (SELECT COUNT(*) FROM chat_message m WHERE m.chat_id=h.chat_id AND m.removed_seq IS NULL) AS message_count
        FROM chat_projection_head h WHERE h.lifecycle_state != 'deleted'`).all() as Row[]) {
        const settings = parse(h.settings_json), tui = parse(h.tui_agent_json)
        const provider = providerFor(settings.harnessId || tui.harnessId)
        preview.chats.push({ id: `${entry.name}/${h.chat_id}`, epicId: entry.name, title: h.title || 'Chat Traycer', provider: provider || 'claude', unsupportedHarness: provider ? undefined : String(settings.harnessId || tui.harnessId || 'traycer'),
          parentId: h.parent_chat_id ? `${entry.name}/${h.parent_chat_id}` : undefined, archived: h.lifecycle_state === 'archived' || h.archived_at != null,
          profileId: settings.profileId || tui.profileId || `ambient-${provider || 'claude'}`, updatedAt: h.updated_at,
          messageCount: h.message_count, imported: existing.has(importedId(root, 'chat', `${entry.name}/${h.chat_id}`)) })
      }
    } catch { preview.warnings.push(`Não foi possível ler a tarefa ${entry.name}: banco indisponível ou formato incompatível.`) }
    finally { db?.close() }
  }
  for (const c of preview.chats) c.taskTitle = preview.chats.find(r => r.epicId === c.epicId && !r.parentId)?.title || `Tarefa ${c.epicId}`
  preview.chats.sort((a, b) => b.updatedAt - a.updatedAt)
  return preview
}
/** Items of `after` that are new or differ from `before`, by id. */
function changedItems<T extends { id: string }>(before: readonly T[], after: readonly T[]): T[] {
  const old = new Map(before.map((item) => [item.id, JSON.stringify(item)]))
  return after.filter((item) => old.get(item.id) !== JSON.stringify(item))
}
export async function importTraycer(request: TraycerImportRequest): Promise<TraycerImportResult> {
  if (!request || !Array.isArray(request.profileIds) || !Array.isArray(request.chatIds)) throw new Error('Seleção de importação inválida.')
  const preview = await previewTraycer(request.root)
  const root = preview.root
  const result: TraycerImportResult = { profiles: 0, chats: 0, updated: 0, credentials: 0, skipped: 0, warnings: [...preview.warnings] }
  // Chats, tasks and (T08) profiles live where hostChats says.
  const backend = await chatsBackend()
  const profilesOnHost = await profilesBackend() === 'host'
  const current = { chats: await listChats(), tasks: (await listTasks()).tasks || [] }
  const before = await storedProfiles()
  const profiles: StoredProfile[] = before.map(p => ({ ...p }))
  const chats: UnifiedChat[] = current.chats.map(c=>({...c}))
  const tasks = current.tasks.map(t => ({ ...t }))
  const sources = sourceProfiles(root)
  // Prepare all conversations before changing Prism's store or copying logins.
  for (const id of new Set(request.profileIds)) {
    const p = sources.find((s) => s.profileId === id)
    if (!p) throw new Error('Um perfil selecionado não está mais disponível. Atualize a lista.')
    const imported = importedId(root, 'profile', id)
    const existing = profiles.find((s) => s.id === imported)
    // A profile removed in Prism stays tombstoned in the store; importing it
    // again is an explicit request to bring it back.
    if (existing?.tombstoned) { Object.assign(existing, { tombstoned: false, enabled: true }); result.profiles++; continue }
    if (existing) { result.skipped++; continue }
    profiles.push({ id: imported, provider: providerFor(p.providerId)!, name: p.label || 'Conta Traycer' })
    result.profiles++
  }
  // Native-session resumes to set after linking (so a relink does not strip them).
  const nativeResumes: { id: string; resume: NonNullable<UnifiedChat['resume']> }[] = []
  const selected = new Set(request.chatIds)
  // Include ancestors even when they have no messages. A selected child never
  // becomes an unrelated top-level agent just because its parent was unchecked.
  // A refresh ("Atualizar do Traycer") touches only the chats it was asked to:
  // the parents already exist, so there is nothing to orphan.
  if (!request.refreshHistory) for (const sourceId of selected) {
    let parent = preview.chats.find(c => c.id === sourceId)?.parentId
    const seen = new Set<string>([sourceId])
    while (parent && !seen.has(parent)) {
      seen.add(parent)
      const row = preview.chats.find(c => c.id === parent)
      if (!row) break
      selected.add(parent); parent = row.parentId
    }
  }
  for (const sourceId of selected) {
    const candidate = preview.chats.find((c) => c.id === sourceId)
    if (!candidate) throw new Error('Um chat selecionado não está mais disponível. Atualize a lista.')
    const id = importedId(root, 'chat', sourceId)
    const taskId = importedId(root, 'task', candidate.epicId)
    const parentChatId = candidate.parentId ? importedId(root, 'chat', candidate.parentId) : undefined
    const [, chatId] = sourceId.split('/')
    if (!tasks.some(t => t.id === taskId)) tasks.push({ id: taskId, title: candidate.taskTitle || candidate.title, cwd: '', updatedAt: candidate.updatedAt })
    const existing = chats.find(c => c.id === id)
    if (existing) {
      // Repair old flat imports without replacing local drafts, native sessions,
      // renamed titles or any conversation the user continued inside Prism.
      const synced = existing.traycerSource?.syncedTurns
      const ref: UnifiedChat['traycerSource'] = { root, epicId: candidate.epicId, chatId, ...(typeof synced === 'number' ? { syncedTurns: synced } : {}) }
      Object.assign(existing, { taskId, parentChatId, readOnly: !!candidate.unsupportedHarness, sourceHarness: candidate.unsupportedHarness, archived: candidate.archived, traycerSource: ref })
      // Upgrade an already-imported chat to resume Traycer's native session, as
      // long as it was not continued in Prism and does not resume one already.
      if (!existing.resume && !existing.readOnly && !continuedInPrism(existing) && existing.selection) {
        try {
          const r = prepareNativeResume({ root, epicId: candidate.epicId, chatId, provider: existing.selection.provider as Provider,
            selectionProfileId: existing.selection.profileId, workspaceNeedsBinding: !!existing.workspaceNeedsBinding, sources, copyCredentials: request.copyCredentials })
          if (r) nativeResumes.push({ id, resume: r })
        } catch { /* fall back to the bounded transcript */ }
      }
      if (!request.refreshHistory) { result.skipped++; continue }
      // "Atualizar do Traycer": refresh the history only when the Prism copy is
      // still the imported one. A chat continued here (a native session, a run,
      // or more turns than were imported) keeps its Prism history untouched.
      if (continuedInPrism(existing)) {
        result.warnings.push(`“${candidate.title}”: continuado no Prism; histórico não atualizado.`)
        result.skipped++; continue
      }
      const { turns } = readTraycerChat(root, candidate.epicId, chatId, candidate.provider)
      existing.traycerSource = { root, epicId: candidate.epicId, chatId, syncedTurns: turns.length }
      if (JSON.stringify(turns) === JSON.stringify(existing.turns)) { result.skipped++; continue }
      existing.turns = turns
      existing.updatedAt = candidate.updatedAt
      result.updated++
      continue
    }
    const { turns, cwd, settings, tui } = readTraycerChat(root, candidate.epicId, chatId, candidate.provider)
    const mapped = importedId(root, 'profile', candidate.profileId)
    // Never bind a chat to a removed profile: it would fail every send and save.
    const profile = profiles.find((p) => p.id === mapped && p.provider === candidate.provider && !p.tombstoned)
    if (!profile && !candidate.profileId.startsWith('ambient-')) result.warnings.push(`“${candidate.title}”: conta não importada; selecione uma conta antes de continuar.`)
    const workspaceNeedsBinding = typeof cwd !== 'string' || !cwd || !existsSync(cwd) || !lstatSync(cwd).isDirectory()
    if (workspaceNeedsBinding) result.warnings.push(`“${candidate.title}”: pasta do projeto indisponível; escolha uma pasta para continuar.`)
    const selectionProfileId = profile?.id || `ambient-${candidate.provider}`
    // Resume Traycer's native session (full history, compaction) when it is
    // reachable; otherwise the first send falls back to the bounded transcript.
    // The resume is applied at the end, after any relink (which forgets a
    // profile's sessions) has run, so it is not stripped again.
    try {
      const resume = prepareNativeResume({ root, epicId: candidate.epicId, chatId, provider: candidate.provider, selectionProfileId, workspaceNeedsBinding, sources, copyCredentials: request.copyCredentials })
      if (resume) nativeResumes.push({ id, resume })
    } catch (err) { result.warnings.push(`“${candidate.title}”: não consegui preparar a sessão nativa (${(err as Error).message}); vai continuar pelo histórico recente.`) }
    chats.push({ id, taskId, parentChatId, readOnly: !!candidate.unsupportedHarness, sourceHarness: candidate.unsupportedHarness, archived: candidate.archived, traycerSource: { root, epicId: candidate.epicId, chatId, syncedTurns: turns.length }, title: candidate.title, cwd, turns, updatedAt: candidate.updatedAt,
      workspaceNeedsBinding, accountNeedsSelection: !profile && !candidate.profileId.startsWith('ambient-'),
      selection: { provider: candidate.provider, profileId: selectionProfileId,
        model: settings.model || tui.model || '',
        effort: ['low', 'medium', 'high', 'xhigh', 'max'].includes(settings.reasoningEffort) ? settings.reasoningEffort : 'high',
        permissionMode: 'default' } })
    result.chats++
  }
  const selectedProfiles = new Set(request.profileIds.map((id) => importedId(root, 'profile', id)))
  const relinked: StoredProfile[] = []
  /** Host mode: links the host makes once the profiles and chats are in. */
  const links: { profile: StoredProfile; link: CredentialLink }[] = []
  for (const p of profiles.filter((p) => selectedProfiles.has(p.id))) {
    const source = sources.find((s) => importedId(root, 'profile', s.profileId) === p.id)!
    const dest = join(app.getPath('userData'), 'provider-profiles', p.id)
    mkdirSync(dest, { recursive: true, mode: 0o700 })
    // Consent covers using the Traycer login. It is used in place, never copied,
    // so neither app can invalidate the other's refresh token.
    const home = request.copyCredentials ? loginHome(root, source) : null
    const link: CredentialLink = { root, providerId: source.providerId, profileId: source.profileId }
    if (home && !sameLink(p.credentialLink, link)) {
      if (profilesOnHost) { refuseRunning(p, chats); links.push({ profile: p, link }) }
      else { retarget(p, chats, link); relinked.push(p); result.credentials++ }
    }
    if (!home && !p.credentialLink && !existsSync(join(dest, credentialFile(p.provider)))) {
      result.warnings.push(`“${p.name}”: perfil importado; use Entrar para conectar a conta.`)
    }
  }
  for (const task of tasks.filter(t => t.id.startsWith('traycer-'))) task.cwd ||= chats.find(c => c.taskId === task.id && c.cwd)?.cwd || ''
  if (backend === 'ipc') agentStore.store = { profiles, chats, tasks }
  else {
    // Only what changed goes to the host. Profiles on the host (T08) go first,
    // so the chats never point at an account the host lacks; their links last.
    // Profiles in prism-agents.db go after the chats and tasks, so a host that
    // fails leaves them (and their links) as they were.
    if (profilesOnHost) await importHostProfiles(changedItems(before, profiles))
    await mergeTasks(changedItems(current.tasks, tasks))
    const { skipped } = await importChatDocs(changedItems(current.chats, chats))
    const kept = new Set(chats.map((c) => c.id))
    await removeChats(current.chats.filter((c) => !kept.has(c.id)).map((c) => c.id))
    for (const id of skipped) result.warnings.push(`“${chats.find((c) => c.id === id)?.title || id}”: conversa em execução; não foi atualizada.`)
    if (!profilesOnHost) agentStore.set('profiles', profiles)
  }
  // The host forgets the chats' sessions and retires the old copy of the login itself; `busy` while the profile runs.
  for (const { profile, link } of links) {
    try { await setProfileLink(profile.id, link); relinked.push(profile); result.credentials++ }
    catch (err) { result.warnings.push(`“${profile.name}”: ${(err as Error).message}`) }
  }
  for (const p of relinked) {
    if (!profilesOnHost) {
      const warning = quarantineCopy(p)
      if (warning) result.warnings.push(warning)
    }
    // Drop cached usage and model catalogs read under the previous login.
    app.emit?.('prism:profile-changed', p.id)
  }
  // Native sessions come last: a relink just forgot the profile's sessions, and
  // an imported chat linked to the account that holds its session keeps it.
  const resumed: UnifiedChat[] = []
  for (const { id, resume } of nativeResumes) {
    const chat = chats.find((c) => c.id === id)
    if (chat) { chat.resume = resume; resumed.push(chat) }
  }
  if (resumed.length) {
    if (backend === 'ipc') agentStore.store = { profiles, chats, tasks }
    else {
      try { for (const id of (await importChatDocs(resumed)).skipped) result.warnings.push(`“${chats.find((c) => c.id === id)?.title || id}”: conversa em execução; a sessão não foi retomada.`) }
      catch (err) { result.warnings.push(`Falha ao retomar as sessões nativas: ${(err as Error).message}`) }
    }
  }
  return result
}

/**
 * Profiles imported from Traycer that still run on an old copied login (or on
 * none) although Traycer holds a login for that account: candidates for "Usar
 * o login do Traycer". Empty when Traycer is not installed.
 */
export async function pendingTraycerLinks(path?: string): Promise<{ id: string; provider: Provider; name: string }[]> {
  let root: string
  try { root = rootPath(path) } catch { return [] }
  const sources = importedSources(root)
  return (await storedProfiles()).flatMap((p) => {
    const source = sources.get(p.id)
    return !p.tombstoned && !p.credentialLink && source && providerFor(source.providerId) === p.provider && loginHome(root, source)
      ? [{ id: p.id, provider: p.provider, name: p.name }] : []
  })
}
/**
 * Links (or, with `link === false`, unlinks) one imported profile; the user's
 * click is the consent. Resolves to the host's profile list when the host owns
 * the profiles (T08), else to null (the caller reads `publicProfiles()`).
 */
export async function setTraycerLogin(id: unknown, link: boolean, path?: string): Promise<ProviderProfile[] | null> {
  if (typeof id !== 'string' || !id) throw new Error('Perfil inválido.')
  const onHost = await profilesBackend() === 'host'
  const profiles = (await storedProfiles()).map(p => ({ ...p }))
  const p = profiles.find(p => p.id === id && !p.tombstoned)
  if (!p) throw new Error('Conta não encontrada.')
  let target: CredentialLink | null = null
  if (link) {
    const root = rootPath(path), source = importedSources(root).get(p.id)
    if (!source || providerFor(source.providerId) !== p.provider) throw new Error('Esta conta não foi importada desta instalação do Traycer.')
    if (!loginHome(root, source)) throw new Error('O Traycer não tem um login ativo para esta conta. Entre nela pelo Traycer e tente de novo.')
    target = { root, providerId: source.providerId, profileId: source.profileId }
  } else if (!p.credentialLink) return onHost ? hostProfileList() : null
  if (onHost) {
    // The host refuses with `busy` while the profile runs, forgets its chats'
    // native sessions and retires the old copy of the login itself.
    const list = await setProfileLink(p.id, target)
    app.emit?.('prism:profile-changed', p.id)
    return list
  }
  const changed = retarget(p, await listChats(), target)
  // The chats first: a chat the host started meanwhile keeps the profile as it was.
  if ((await importChatDocs(changed)).skipped.length) throw new Error(`Pare as tarefas da conta “${p.name}” antes de trocar o login dela.`)
  agentStore.set('profiles', profiles)
  if (link) quarantineCopy(p)
  app.emit?.('prism:profile-changed', p.id)
  return null
}
/**
 * "Atualizar do Traycer": brings a single already-imported chat's history up to
 * date from its Traycer source, but only if the Prism copy was not continued
 * here. Reuses the import path (host or IPC) so persistence stays in one place.
 */
export async function reimportTraycerChat(chatId: unknown): Promise<TraycerImportResult> {
  if (typeof chatId !== 'string' || !chatId) throw new Error('Conversa inválida.')
  const chat = (await listChats()).find((c) => c.id === chatId)
  if (!chat) throw new Error('Conversa não encontrada.')
  const source = chat.traycerSource
  if (!source?.root || !source.epicId || !source.chatId) throw new Error('Esta conversa não foi importada do Traycer.')
  return importTraycer({ root: source.root, profileIds: [], chatIds: [`${source.epicId}/${source.chatId}`], copyCredentials: false, refreshHistory: true })
}
export async function repairLegacyTraycerImports(): Promise<void> {
  const chats = await listChats()
  if (!chats.some(c=>c.id.startsWith('traycer-') && !c.traycerSource)) return
  const preview=await previewTraycer()
  const old=new Set(chats.filter(c=>!c.traycerSource).map(c=>c.id))
  const chatIds=preview.chats.filter(c=>old.has(importedId(preview.root,'chat',c.id))).map(c=>c.id)
  if(chatIds.length) await importTraycer({root:preview.root,profileIds:[],chatIds,copyCredentials:false})
}
export function registerTraycerImportHandlers(): void {
  // In the background: the host may still be starting. An offline source keeps every Prism conversation intact.
  void repairLegacyTraycerImports().catch((err) => console.warn('[traycer] reparo das importações antigas:', (err as Error)?.message ?? err))
  ipcMain.handle('traycer:preview', (_e, path?: string) => previewTraycer(path))
  ipcMain.handle('traycer:choose-root', async () => {
    const result = await dialog.showOpenDialog({ title: 'Selecionar pasta .traycer', defaultPath: join(homedir(), '.traycer'), properties: ['openDirectory', 'showHiddenFiles'] })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('traycer:import', (_e, request: TraycerImportRequest) => importTraycer(request))
  ipcMain.handle('traycer:reimport-chat', (_e, chatId: unknown) => reimportTraycerChat(chatId))
  ipcMain.handle('traycer:pending-links', () => pendingTraycerLinks())
  ipcMain.handle('traycer:link-login', async (_e, id: unknown) => (await setTraycerLogin(id, true)) ?? publicProfiles())
  ipcMain.handle('traycer:unlink-login', async (_e, id: unknown) => (await setTraycerLogin(id, false)) ?? publicProfiles())
}
