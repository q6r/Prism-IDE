const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { DatabaseSync } = require('node:sqlite')
const load = require('./helpers/load-typescript.cjs')
const shared = load('src/shared/traycerImport.ts')

const clone = (value) => JSON.parse(JSON.stringify(value))

/** The Traycer import with chats AND profiles on the host (T08); one log orders every host call. */
function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-import-host-profiles-'))
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }))
  const root = path.join(temporary, '.traycer'), userData = path.join(temporary, 'prism')
  const epic = 'task-1', dir = path.join(root, 'host', 'epic-state', epic, 'chat')
  fs.mkdirSync(dir, { recursive: true })
  const profileHome = path.join(root, 'host', 'harness-accounts', 'codex', 'account-1')
  fs.mkdirSync(profileHome, { recursive: true })
  fs.writeFileSync(path.join(profileHome, 'auth.json'), '{"tokens":{"access_token":"FAKE_FIXTURE_TOKEN"}}')
  fs.mkdirSync(path.join(root, 'host', 'config'), { recursive: true })
  fs.writeFileSync(path.join(root, 'host', 'config', 'provider-accounts.json'), JSON.stringify({ profiles: [
    { profileId: 'account-1', kind: 'managed', providerId: 'codex', label: 'Test account', dirPath: profileHome },
    { profileId: 'deleted', kind: 'managed', providerId: 'claude-code', tombstoned: true }
  ] }))
  const dbFile = path.join(dir, 'chat.db')
  const db = new DatabaseSync(dbFile)
  db.exec(`CREATE TABLE chat_projection_head (chat_id TEXT PRIMARY KEY,title TEXT,settings_json TEXT,tui_agent_json TEXT,host_private_json TEXT,updated_at INTEGER,lifecycle_state TEXT);
    CREATE TABLE chat_message (chat_id TEXT,body TEXT,insert_seq INTEGER,removed_seq INTEGER);`)
  const settings = JSON.stringify({ harnessId: 'codex', profileId: 'account-1', model: 'model-fixture', reasoningEffort: 'high' })
  const hostPrivate = JSON.stringify({ data: { activeSessionChain: { sessionWorkspaceSnapshot: { primaryWorkspace: temporary } } } })
  db.prepare('INSERT INTO chat_projection_head VALUES (?,?,?,?,?,?,?)').run('chat-1', 'Imported conversation', settings, null, hostPrivate, 1000, 'active')
  db.prepare('INSERT INTO chat_message VALUES (?,?,?,NULL)').run('chat-1', JSON.stringify({ messageId: 'user-1', role: 'user', message: { content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Execute once' }] }] } } }), 1)
  db.close()

  const log = []
  const existing = { id: 'existing', title: 'Keep me', turns: [], cwd: temporary, selection: { provider: 'claude', profileId: 'ambient-claude' } }
  const state = { chats: [existing], tasks: [], profiles: [], failLink: null, calls: { importHostProfiles: [], setProfileLink: [], hostProfileList: 0, importChatDocs: [], mergeTasks: [] } }
  const forbidden = new Proxy({}, {
    get(_t, key) { throw new Error(`agentStore tocado (${String(key)})`) },
    set(_t, key) { throw new Error(`agentStore.${String(key)} gravado`) }
  })
  const simulated = {
    chatsBackend: async () => 'host',
    profilesBackend: async () => 'host',
    storedProfiles: async () => clone(state.profiles),
    hostProfileList: async () => { state.calls.hostProfileList++; log.push('hostProfileList'); return clone(state.profiles) },
    async importHostProfiles(profiles) {
      log.push('importHostProfiles')
      state.calls.importHostProfiles.push(clone(profiles))
      for (const p of profiles) state.profiles = [...state.profiles.filter((x) => x.id !== p.id), clone(p)]
    },
    async setProfileLink(id, link) {
      log.push('setProfileLink')
      state.calls.setProfileLink.push({ id, link: clone(link) })
      if (state.failLink) throw state.failLink
      state.profiles = state.profiles.map((p) => {
        if (p.id !== id) return p
        const next = { ...p }
        if (link) next.credentialLink = clone(link)
        else delete next.credentialLink
        return next
      })
      return clone(state.profiles)
    },
    listChats: async () => clone(state.chats),
    listTasks: async () => ({ tasks: clone(state.tasks), openIds: [], activeId: null }),
    async importChatDocs(chats) {
      log.push('importChatDocs')
      state.calls.importChatDocs.push(clone(chats))
      state.chats = [...state.chats.filter((c) => !chats.some((w) => w.id === c.id)), ...clone(chats)]
      return { written: chats.length, skipped: [] }
    },
    async mergeTasks(tasks) {
      log.push('mergeTasks')
      state.calls.mergeTasks.push(clone(tasks))
      state.tasks = [...state.tasks.filter((x) => !tasks.some((n) => n.id === x.id)), ...clone(tasks)]
    },
    async removeChats() { log.push('removeChats') }
  }
  const providers = load('src/main/providers.ts', {
    'electron-store': { __esModule: true, default: class {} }, electron: { app: { getPath: () => userData } },
    './agentRepository': { AgentRepository: class {} }, crypto, fs, path, os,
    child_process: { execFileSync: () => { throw new Error('Real CLI execution forbidden') } }
  })
  const emitted = []
  const api = load('src/main/ipc/traycerImport.ts', {
    electron: { app: { getPath: () => userData, emit: (...a) => emitted.push(a) }, dialog: {}, ipcMain: {} }, crypto, fs,
    path, os: { ...os, homedir: () => temporary }, 'node:sqlite': { DatabaseSync }, '../../shared/traycerImport': shared,
    '../providers': { agentStore: forbidden, publicProfiles: () => [], traycerAccount: providers.traycerAccount, credentialFile: providers.credentialFile },
    '../hostChats': simulated
  })
  const realRoot = api.rootPath(root)
  return { root, realRoot, userData, profileHome, api, state, log, emitted, existing,
    importedProfile: api.importedId(realRoot, 'profile', 'account-1'), importedChat: api.importedId(realRoot, 'chat', 'task-1/chat-1') }
}

const request = (f, over = {}) => ({ root: f.root, profileIds: ['account-1'], chatIds: ['task-1/chat-1'], copyCredentials: true, ...over })
const link = (f) => ({ root: f.realRoot, providerId: 'codex', profileId: 'account-1' })
const storedImported = (f, extra = {}) => ({ id: f.importedProfile, provider: 'codex', name: 'Test account', ...extra })

test('preview lê imported/linked dos perfis do host', async (t) => {
  const f = fixture(t)
  let p = (await f.api.previewTraycer(f.root)).profiles[0]
  assert.deepEqual([p.imported, p.linked, p.credentialsAvailable], [false, false, true])
  f.state.profiles = [storedImported(f)]
  p = (await f.api.previewTraycer(f.root)).profiles[0]
  assert.deepEqual([p.imported, p.linked], [true, false])
  f.state.profiles = [storedImported(f, { credentialLink: link(f) })]
  p = (await f.api.previewTraycer(f.root)).profiles[0]
  assert.deepEqual([p.imported, p.linked], [true, true])
  f.state.profiles = [storedImported(f, { credentialLink: link(f), tombstoned: true })]
  p = (await f.api.previewTraycer(f.root)).profiles[0]
  assert.deepEqual([p.imported, p.linked], [false, false])
})

test('import: perfis antes de tarefas/chats, vínculo depois, sem tocar o agentStore', async (t) => {
  const f = fixture(t)
  const result = await f.api.importTraycer(request(f))
  assert.deepEqual([result.profiles, result.chats, result.credentials, result.skipped], [1, 1, 1, 0])
  assert.deepEqual(f.log, ['importHostProfiles', 'mergeTasks', 'importChatDocs', 'removeChats', 'setProfileLink'])
  assert.deepEqual(f.state.calls.importHostProfiles, [[{ id: f.importedProfile, provider: 'codex', name: 'Test account' }]])
  assert.deepEqual(f.state.calls.setProfileLink, [{ id: f.importedProfile, link: link(f) }])
  assert.equal(f.state.chats.find((c) => c.id === f.importedChat).selection.profileId, f.importedProfile)
  assert.equal(f.state.profiles[0].credentialLink.profileId, 'account-1')
  assert.deepEqual(f.emitted, [['prism:profile-changed', f.importedProfile]])
  assert.equal(f.state.chats.some((c) => c.id === 'existing'), true)
})

test('import sem copyCredentials: só o perfil, sem vínculo nem evento; depois, com consentimento, vincula sem reenviar o perfil', async (t) => {
  const f = fixture(t)
  const first = await f.api.importTraycer(request(f, { chatIds: [], copyCredentials: false }))
  assert.deepEqual([first.profiles, first.credentials], [1, 0])
  assert.equal(f.state.calls.setProfileLink.length, 0)
  assert.deepEqual(f.emitted, [])
  assert.ok(first.warnings.some((w) => w.includes('use Entrar')))
  const later = await f.api.importTraycer(request(f, { chatIds: [], copyCredentials: true }))
  assert.deepEqual([later.profiles, later.credentials, later.skipped], [0, 1, 1])
  assert.equal(f.state.calls.importHostProfiles.filter((c) => c.length).length, 1)
  assert.equal(f.state.calls.setProfileLink.length, 1)
})

test('setProfileLink rejeitando (busy): aviso, credentials 0, sem evento, resto importado', async (t) => {
  const f = fixture(t)
  f.state.failLink = Object.assign(new Error('Perfil em uso.'), { code: 'busy' })
  const result = await f.api.importTraycer(request(f))
  assert.equal(result.credentials, 0)
  assert.equal(result.chats, 1)
  assert.equal(result.profiles, 1)
  assert.ok(result.warnings.includes('“Test account”: Perfil em uso.'), JSON.stringify(result.warnings))
  assert.deepEqual(f.emitted, [])
  assert.equal(f.state.chats.some((c) => c.id === f.importedChat), true)
  assert.equal(f.state.profiles[0].credentialLink, undefined)
})

test('a cópia antiga do login não é renomeada no modo host', async (t) => {
  const f = fixture(t)
  const dir = path.join(f.userData, 'provider-profiles', f.importedProfile)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'auth.json'), '{"old":true}')
  await f.api.importTraycer(request(f))
  assert.equal(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'), '{"old":true}')
  assert.deepEqual(fs.readdirSync(dir), ['auth.json'])
})

test('conversa em execução no perfil rejeita antes de gravar qualquer coisa', async (t) => {
  const f = fixture(t)
  f.state.profiles = [storedImported(f)]
  f.state.chats.push({ id: 'busy-chat', title: 'busy', turns: [], cwd: '', pendingTurnId: 'x', selection: { provider: 'codex', profileId: f.importedProfile } })
  await assert.rejects(f.api.importTraycer(request(f)), /Pare as tarefas da conta “Test account”/)
  assert.deepEqual(f.log, [])
  assert.deepEqual(f.emitted, [])
})

test('reimportar é idempotente: nada novo para o host, sem novo vínculo nem evento', async (t) => {
  const f = fixture(t)
  await f.api.importTraycer(request(f))
  const emittedBefore = f.emitted.length
  f.log.length = 0
  const again = await f.api.importTraycer(request(f))
  assert.deepEqual([again.profiles, again.chats, again.credentials, again.skipped], [0, 0, 0, 2])
  assert.equal(f.state.calls.setProfileLink.length, 1)
  assert.equal(f.emitted.length, emittedBefore)
  assert.equal(f.state.calls.importHostProfiles.filter((c) => c.length).length, 1)
  assert.equal(f.state.chats.filter((c) => c.id === f.importedChat).length, 1)
})

test('perfil removido no Prism volta (reativado) e é enviado ao host', async (t) => {
  const f = fixture(t)
  f.state.profiles = [storedImported(f, { tombstoned: true, enabled: false })]
  const result = await f.api.importTraycer(request(f, { chatIds: [], copyCredentials: false }))
  assert.equal(result.profiles, 1)
  const sent = f.state.calls.importHostProfiles.at(-1)[0]
  assert.equal(sent.tombstoned, false)
  assert.equal(sent.enabled, true)
})

test('setTraycerLogin no host: vincular chama setProfileLink e devolve a lista do host', async (t) => {
  const f = fixture(t)
  f.state.profiles = [storedImported(f)]
  const list = await f.api.setTraycerLogin(f.importedProfile, true, f.root)
  assert.deepEqual(f.state.calls.setProfileLink, [{ id: f.importedProfile, link: link(f) }])
  assert.deepEqual(list, f.state.profiles)
  assert.equal(list[0].credentialLink.profileId, 'account-1')
  assert.deepEqual(f.emitted, [['prism:profile-changed', f.importedProfile]])
  assert.equal(f.state.calls.importChatDocs.length, 0)
})

test('setTraycerLogin no host: desvincular um vinculado chama setProfileLink(id, null)', async (t) => {
  const f = fixture(t)
  f.state.profiles = [storedImported(f, { credentialLink: link(f) })]
  const list = await f.api.setTraycerLogin(f.importedProfile, false)
  assert.deepEqual(f.state.calls.setProfileLink, [{ id: f.importedProfile, link: null }])
  assert.equal(list[0].credentialLink, undefined)
  assert.equal(f.state.calls.importChatDocs.length, 0)
})

test('setTraycerLogin no host: desvincular sem vínculo devolve hostProfileList sem setProfileLink', async (t) => {
  const f = fixture(t)
  f.state.profiles = [storedImported(f)]
  const list = await f.api.setTraycerLogin(f.importedProfile, false)
  assert.deepEqual(list, f.state.profiles)
  assert.equal(f.state.calls.hostProfileList, 1)
  assert.equal(f.state.calls.setProfileLink.length, 0)
  assert.deepEqual(f.emitted, [])
})

test('setTraycerLogin: id inválido, perfil desconhecido e recusa do host', async (t) => {
  const f = fixture(t)
  await assert.rejects(f.api.setTraycerLogin('', true), /Perfil inválido/)
  await assert.rejects(f.api.setTraycerLogin('nope', true, f.root), /Conta não encontrada/)
  f.state.profiles = [storedImported(f)]
  f.state.failLink = Object.assign(new Error('Perfil em uso.'), { code: 'busy' })
  await assert.rejects(f.api.setTraycerLogin(f.importedProfile, true, f.root), /Perfil em uso\./)
  assert.deepEqual(f.emitted, [])
})

test('pendingTraycerLinks é assíncrona e lê storedProfiles', async (t) => {
  const f = fixture(t)
  const pending = f.api.pendingTraycerLinks(f.root)
  assert.equal(typeof pending.then, 'function')
  assert.deepEqual(await pending, [])
  f.state.profiles = [storedImported(f), { id: 'other', provider: 'codex', name: 'Outra' }]
  assert.deepEqual(await f.api.pendingTraycerLinks(f.root), [{ id: f.importedProfile, provider: 'codex', name: 'Test account' }])
  f.state.profiles = [storedImported(f, { credentialLink: link(f) })]
  assert.deepEqual(await f.api.pendingTraycerLinks(f.root), [])
  f.state.profiles = [storedImported(f, { tombstoned: true })]
  assert.deepEqual(await f.api.pendingTraycerLinks(f.root), [])
  assert.deepEqual(await f.api.pendingTraycerLinks(path.join(f.userData, 'nao-existe')), [])
})
