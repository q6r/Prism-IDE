const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { DatabaseSync } = require('node:sqlite')
const load = require('./helpers/load-typescript.cjs')
const shared = load('src/shared/traycerImport.ts')

function fixture(t, { host: viaHost = false } = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-import-test-'))
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }))
  const root = path.join(temporary, '.traycer'), userData = path.join(temporary, 'prism')
  const epic = 'task-1', dir = path.join(root, 'host', 'epic-state', epic, 'chat')
  fs.mkdirSync(dir, { recursive: true })
  const profileHome = path.join(root, 'host', 'harness-accounts', 'codex', 'account-1')
  fs.mkdirSync(profileHome, { recursive: true })
  fs.writeFileSync(path.join(profileHome, 'auth.json'), '{"tokens":{"access_token":"FAKE_FIXTURE_TOKEN"}}')
  fs.writeFileSync(path.join(profileHome, 'config.toml'), 'this must not be copied')
  fs.mkdirSync(path.join(root, 'host', 'config'), { recursive: true })
  fs.writeFileSync(path.join(root, 'host', 'config', 'provider-accounts.json'), JSON.stringify({ profiles: [
    { profileId: 'account-1', kind: 'managed', providerId: 'codex', label: 'Test account', dirPath: profileHome },
    { profileId: 'deleted', kind: 'managed', providerId: 'claude-code', tombstoned: true },
    { profileId: '../escape', kind: 'managed', providerId: 'codex' }
  ] }))
  const dbFile = path.join(dir, 'chat.db')
  const db = new DatabaseSync(dbFile)
  db.exec(`CREATE TABLE chat_projection_head (chat_id TEXT PRIMARY KEY,title TEXT,settings_json TEXT,tui_agent_json TEXT,host_private_json TEXT,updated_at INTEGER,lifecycle_state TEXT);
    CREATE TABLE chat_message (chat_id TEXT,body TEXT,insert_seq INTEGER,removed_seq INTEGER);`)
  const settings = JSON.stringify({ harnessId: 'codex', profileId: 'account-1', model: 'model-fixture', permissionMode: 'full_access', reasoningEffort: 'high' })
  const host = JSON.stringify({ data: { activeSessionChain: { sessionId: 'never-resume', sessionWorkspaceSnapshot: { primaryWorkspace: temporary } } } })
  for (const [id, state] of [['chat-1', 'active'], ['deleted-chat', 'deleted']]) {
    db.prepare('INSERT INTO chat_projection_head VALUES (?,?,?,?,?,?,?)').run(id, 'Imported conversation', settings, null, host, 1000, state)
    db.prepare('INSERT INTO chat_message VALUES (?,?,?,NULL)').run(id, JSON.stringify({ messageId: 'user-1', role: 'user', message: { content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Execute once' }] }] } } }), 1)
  }
  db.prepare('INSERT INTO chat_message VALUES (?,?,?,NULL)').run('chat-1', JSON.stringify({ messageId: 'assistant-1', role: 'assistant', blocks: [
    { type: 'reasoning', content: 'PRIVATE_REASONING' }, { type: 'command', blockId: 'tool-1', status: 'completed', command: 'migration', exitCode: 0 },
    { type: 'text', text: 'Finished' }, { type: 'error', message: 'Rate limit' }
  ] }), 2)
  db.close()
  const existing = { id: 'existing', title: 'Keep me', turns: [], cwd: temporary }
  const clone = (value) => JSON.parse(JSON.stringify(value))
  const sets = []
  let store = viaHost ? { profiles: [] } : { profiles: [], chats: [existing], tasks: [] }
  // No host o repositório do main só guarda perfis (T08 leva isso embora); `store =` seria o 0.2.
  const agentStore = viaHost
    ? { get: (key) => store[key], set(key, value) { sets.push([key, clone(value)]); store = { ...store, [key]: value } }, get store() { return store },
      set store(_) { throw new Error('agentStore.store não deve ser usado com o host') } }
    : { get: (key) => store[key], get store() { return store }, set store(value) { store = value },
      readState: (_key, fallback) => fallback, writeState() {}, upsert() {}, removeChat() {}, set() { throw new Error('não usado') } }
  // O host simulado guarda cópias (como o IPC) e deixa o teste marcar conversas "em execução".
  const hostState = { chats: [existing], tasks: [], skip: new Set(), failImport: null,
    calls: { importChatDocs: [], mergeTasks: [], removeChats: [] }, reads: { chats: 0, tasks: 0 } }
  const simulated = {
    chatsBackend: async () => 'host',
    // Um host do T07 (sem `providers@1`): os perfis continuam no agentStore.
    profilesBackend: async () => 'ipc',
    storedProfiles: async () => agentStore.get('profiles'),
    listChats: async () => { hostState.reads.chats++; return clone(hostState.chats) },
    listTasks: async () => { hostState.reads.tasks++; return { tasks: clone(hostState.tasks), openIds: [], activeId: null } },
    async importChatDocs(chats) {
      hostState.calls.importChatDocs.push(clone(chats))
      if (hostState.failImport) throw hostState.failImport
      const skipped = chats.filter((c) => hostState.skip.has(c.id)).map((c) => c.id)
      const written = chats.filter((c) => !skipped.includes(c.id))
      hostState.chats = [...hostState.chats.filter((c) => !written.some((w) => w.id === c.id)), ...clone(written)]
      return { written: written.length, skipped }
    },
    async mergeTasks(tasks) {
      hostState.calls.mergeTasks.push(clone(tasks))
      hostState.tasks = [...hostState.tasks.filter((t) => !tasks.some((n) => n.id === t.id)), ...clone(tasks)]
    },
    async removeChats(ids) { hostState.calls.removeChats.push([...ids]); hostState.chats = hostState.chats.filter((c) => !ids.includes(c.id)) }
  }
  // O caminho ipc usa a fachada de verdade, sem binário do host (nunca cria o cliente).
  const hostChats = viaHost ? simulated : load('src/main/hostChats.ts', {
    './providers': { agentStore }, './host/supervisor': { hostBinaryPresent: () => false },
    './host/mainClient': { mainHostClient: () => { throw new Error('o cliente do host não deve ser criado sem binário') } },
    './ipc/providerProfiles': load('src/main/ipc/providerProfiles.ts')
  })
  // The real Traycer account resolver, without Electron, a store or any CLI.
  const providers = load('src/main/providers.ts', {
    'electron-store': { __esModule: true, default: class {} }, electron: { app: { getPath: () => userData } },
    './agentRepository': { AgentRepository: class {} }, crypto, fs, path, os,
    child_process: { execFileSync: () => { throw new Error('Real CLI execution forbidden') } }
  })
  const emitted = []
  const api = load('src/main/ipc/traycerImport.ts', {
    electron: { app: { getPath: () => userData, emit: (...a) => emitted.push(a) }, dialog: {}, ipcMain: {} }, crypto, fs,
    path, os: { ...os, homedir: () => temporary }, 'node:sqlite': { DatabaseSync }, '../../shared/traycerImport': shared,
    '../providers': { agentStore, traycerAccount: providers.traycerAccount, credentialFile: providers.credentialFile },
    '../hostChats': hostChats
  })
  const realRoot = api.rootPath(root)
  return { root, realRoot, userData, profileHome, dbFile, api, agentStore, hostState, sets, emitted,
    importedProfile: api.importedId(realRoot, 'profile', 'account-1'), importedChat: api.importedId(realRoot, 'chat', 'task-1/chat-1'), importedTask: api.importedId(realRoot, 'task', 'task-1') }
}
test('imports selected profiles and visible conversations, preserves existing chats and never resumes or carries permission grants', async (t) => {
  const f = fixture(t)
  const before = fs.readFileSync(f.dbFile)
  const preview = await f.api.previewTraycer(f.root)
  assert.equal(preview.profiles.length, 1)
  assert.equal(preview.profiles[0].credentialsAvailable, true)
  assert.equal(preview.chats.length, 1)
  const request = { root: f.root, profileIds: ['account-1'], chatIds: ['task-1/chat-1'], copyCredentials: true }
  const result = await f.api.importTraycer(request)
  assert.equal(result.profiles, 1); assert.equal(result.chats, 1)
  assert.equal(result.credentials, 1)
  const store = f.agentStore.store, profile = store.profiles[0], chat = store.chats[1]
  assert.equal(store.chats[0].title, 'Keep me')
  assert.equal(chat.selection.profileId, profile.id)
  assert.equal(chat.selection.model, 'model-fixture')
  assert.equal(chat.selection.permissionMode, 'default')
  assert.equal(chat.resume, undefined)
  assert.equal(chat.workspaceNeedsBinding, false)
  assert.equal(chat.turns.length, 2)
  assert.equal(chat.turns[0].text, 'Execute once')
  assert.equal(JSON.stringify(chat).includes('PRIVATE_REASONING'), false)
  assert.equal(chat.turns[1].error, true)
  assert.equal(chat.turns[1].segments[0].name, 'Bash')
  assert.match(chat.turns[1].segments[0].result, /código 0/)
  // The Traycer login is used in place: linked, never copied.
  assert.deepEqual(profile.credentialLink, { root: f.root, providerId: 'codex', profileId: 'account-1' })
  assert.equal(fs.existsSync(path.join(f.userData, 'provider-profiles', profile.id, 'auth.json')), false)
  assert.equal(fs.existsSync(path.join(f.userData, 'provider-profiles', profile.id, 'config.toml')), false)
  assert.deepEqual(fs.readFileSync(f.dbFile), before)
  const again = await f.api.importTraycer(request)
  assert.equal(again.profiles, 0); assert.equal(again.chats, 0); assert.equal(again.skipped, 2)
  assert.equal(again.credentials, 0)
  assert.equal(f.agentStore.store.chats.length, 2)
  assert.equal((await f.api.previewTraycer(f.root)).chats[0].imported, true)
})
test('metadata-only profile import does not copy credentials', async (t) => {
  const f = fixture(t)
  await f.api.importTraycer({ root: f.root, profileIds: ['account-1'], chatIds: [], copyCredentials: false })
  const id = f.agentStore.store.profiles[0].id
  assert.equal(fs.existsSync(path.join(f.userData, 'provider-profiles', id, 'auth.json')), false)
  const later = await f.api.importTraycer({ root: f.root, profileIds: ['account-1'], chatIds: [], copyCredentials: true })
  assert.equal(later.credentials, 1)
  assert.equal(later.profiles, 0)
  assert.equal(f.agentStore.store.profiles[0].credentialLink.profileId, 'account-1')
  assert.equal(fs.existsSync(path.join(f.userData, 'provider-profiles', id, 'auth.json')), false)
})
test('chat without its account requires an explicit account choice; unavailable workspaces require binding', async (t) => {
  const f = fixture(t)
  const db = new DatabaseSync(f.dbFile)
  db.prepare('UPDATE chat_projection_head SET host_private_json=?').run(JSON.stringify({ data: { activeSessionChain: { sessionWorkspaceSnapshot: { primaryWorkspace: path.join(f.root, 'missing') } } } }))
  db.close()
  const result = await f.api.importTraycer({ root: f.root, profileIds: [], chatIds: ['task-1/chat-1'], copyCredentials: false })
  const chat = f.agentStore.store.chats[1]
  assert.equal(chat.accountNeedsSelection, true)
  assert.equal(chat.workspaceNeedsBinding, true)
  assert.equal(result.warnings.length, 2)
})
test('invalid selections leave the store and credential destination untouched', async (t) => {
  const f = fixture(t), original = f.agentStore.store
  await assert.rejects(f.api.importTraycer({ root: f.root, profileIds: ['account-1'], chatIds: ['task-1/deleted-chat'], copyCredentials: true }), /não está mais disponível/)
  assert.equal(f.agentStore.store, original)
  assert.equal(fs.existsSync(f.userData), false)
})
test('credential paths outside the selected Traycer account layout are not imported', async (t) => {
  const f = fixture(t)
  const file = path.join(f.root, 'host', 'config', 'provider-accounts.json')
  const data = JSON.parse(fs.readFileSync(file, 'utf8')); data.profiles[0].dirPath = os.tmpdir()
  fs.writeFileSync(file, JSON.stringify(data))
  assert.equal((await f.api.previewTraycer(f.root)).profiles[0].credentialsAvailable, false)
  await f.api.importTraycer({ root: f.root, profileIds: ['account-1'], chatIds: [], copyCredentials: true })
  const id = f.agentStore.store.profiles[0].id
  assert.equal(f.agentStore.store.profiles[0].credentialLink, undefined)
  assert.equal(fs.existsSync(path.join(f.userData, 'provider-profiles', id, 'auth.json')), false)
})

test('imports ancestors, empty orchestration chats and task identity; repairing flat imports retains continued history',async t=>{
  const f=fixture(t), db=new DatabaseSync(f.dbFile)
  db.exec('ALTER TABLE chat_projection_head ADD COLUMN parent_chat_id TEXT; ALTER TABLE chat_projection_head ADD COLUMN archived_at INTEGER')
  db.prepare('UPDATE chat_projection_head SET parent_chat_id=? WHERE chat_id=?').run('parent','chat-1')
  db.prepare('INSERT INTO chat_projection_head (chat_id,title,settings_json,updated_at,lifecycle_state) VALUES (?,?,?,?,?)').run('parent','Orchestrator',JSON.stringify({harnessId:'traycer'}),900,'active')
  db.close()
  const preview=await f.api.previewTraycer(f.root)
  assert.equal(preview.chats.length,2)
  assert.equal(preview.chats.find(c=>c.id==='task-1/chat-1').parentId,'task-1/parent')
  await f.api.importTraycer({root:f.root,profileIds:[],chatIds:['task-1/chat-1'],copyCredentials:false})
  const store=f.agentStore.store, child=store.chats.find(c=>c.traycerSource?.chatId==='chat-1'), parent=store.chats.find(c=>c.traycerSource?.chatId==='parent')
  assert.equal(parent.readOnly,true); assert.equal(parent.sourceHarness,'traycer');assert.equal(parent.turns.length,0)
  assert.equal(child.parentChatId,parent.id);assert.equal(child.taskId,parent.taskId)
  assert.equal(store.tasks[0].id,child.taskId);assert.equal(store.tasks[0].title,'Orchestrator')
  child.turns.push({id:'continued',role:'user',text:'New Prism work'}); child.title='Local rename';child.draft='Unsaved local draft'
  delete child.taskId; delete child.parentChatId;delete child.traycerSource
  await f.api.importTraycer({root:f.root,profileIds:[],chatIds:['task-1/chat-1'],copyCredentials:false})
  const fixed=f.agentStore.store.chats.find(c=>c.id===child.id)
  assert.equal(fixed.parentChatId,parent.id);assert.equal(fixed.taskId,parent.taskId)
  assert.equal(fixed.title,'Local rename');assert.equal(fixed.draft,'Unsaved local draft');assert.equal(fixed.turns.at(-1).text,'New Prism work')
  assert.equal(f.agentStore.store.tasks.length,1)
})
test('forest preserves parent/child order and keeps missing parents and cycles visible',()=>{
  const rows=shared.chatForest([{id:'child',parentChatId:'root'},{id:'other'},{id:'root'},{id:'orphan',parentChatId:'missing'},{id:'a',parentChatId:'b'},{id:'b',parentChatId:'a'}])
  assert.equal(rows.length,6);assert.equal(new Set(rows.map(r=>r.item.id)).size,6)
  const root=rows.findIndex(r=>r.item.id==='root');assert.equal(rows[root+1].item.id,'child');assert.equal(rows[root+1].depth,1)
  assert.equal(rows.find(r=>r.item.id==='orphan').depth,0)
})

test('filtered children retain archived ancestors without displaying unrelated archives',()=>{
 const items=[{id:'archived',archived:true},{id:'child',parentChatId:'archived'},{id:'other-archive',archived:true}]
 assert.deepEqual(shared.withChatAncestors(items,i=>!i.archived).map(i=>i.id),['archived','child'])
})

/* ---------------- com o host dono dos chats e das tarefas (T07) ---------------- */

const request = (root, extra = {}) => ({ root, profileIds: ['account-1'], chatIds: ['task-1/chat-1'], copyCredentials: true, ...extra })

test('host: importTraycer manda perfis ao agentStore, chats e tarefas novos ao host e nunca reenvia o inalterado', async (t) => {
  const f = fixture(t, { host: true })
  const result = await f.api.importTraycer(request(f.root))
  assert.equal(result.profiles, 1); assert.equal(result.chats, 1); assert.equal(result.credentials, 1)
  // Perfis: só pelo agentStore.set (o `agentStore.store =` do 0.2 lançaria).
  assert.deepEqual(f.sets.map(([key]) => key), ['profiles'])
  assert.equal(f.sets[0][1].length, 1)
  assert.equal(f.sets[0][1][0].id, f.importedProfile)
  assert.deepEqual(f.sets[0][1][0].credentialLink, { root: f.realRoot, providerId: 'codex', profileId: 'account-1' })
  // Chats e tarefas: só o que é novo.
  assert.equal(f.hostState.calls.importChatDocs.length, 1)
  assert.deepEqual(f.hostState.calls.importChatDocs[0].map((c) => c.id), [f.importedChat]) // 'existing' não vai
  assert.equal(f.hostState.calls.importChatDocs[0][0].taskId, f.importedTask)
  assert.deepEqual(f.hostState.calls.mergeTasks.map((tasks) => tasks.map((x) => [x.id, x.title])), [[[f.importedTask, 'Imported conversation']]])
  assert.deepEqual(f.hostState.calls.removeChats, [[]])
  assert.deepEqual(f.hostState.chats.map((c) => c.id).sort(), ['existing', f.importedChat].sort())
  assert.equal(f.hostState.chats.find((c) => c.id === 'existing').title, 'Keep me')
  assert.equal(f.hostState.chats.find((c) => c.id === f.importedChat).selection.profileId, f.importedProfile)
  // De novo: nada mudou, nada é reenviado.
  const again = await f.api.importTraycer(request(f.root))
  assert.equal(again.profiles, 0); assert.equal(again.chats, 0); assert.equal(again.credentials, 0); assert.equal(again.skipped, 2)
  assert.deepEqual(f.hostState.calls.importChatDocs.at(-1), [])
  assert.deepEqual(f.hostState.calls.mergeTasks.at(-1), [])
  assert.deepEqual(f.hostState.calls.removeChats.at(-1), [])
  assert.equal(f.hostState.chats.length, 2)
})

test('host: um chat já importado alterado localmente só reenvia o reparo; o rascunho local fica', async (t) => {
  const f = fixture(t, { host: true })
  await f.api.importTraycer(request(f.root, { profileIds: [] }))
  const stored = f.hostState.chats.find((c) => c.id === f.importedChat)
  stored.draft = 'rascunho'; stored.title = 'Renomeado'; delete stored.taskId
  await f.api.importTraycer(request(f.root, { profileIds: [] }))
  const sent = f.hostState.calls.importChatDocs.at(-1)
  assert.deepEqual(sent.map((c) => c.id), [f.importedChat])
  assert.equal(sent[0].taskId, f.importedTask); assert.equal(sent[0].draft, 'rascunho'); assert.equal(sent[0].title, 'Renomeado')
})

test('host: conversa em execução (skipped) vira aviso e as demais continuam', async (t) => {
  const f = fixture(t, { host: true })
  f.hostState.skip.add(f.importedChat)
  const result = await f.api.importTraycer(request(f.root))
  assert.ok(result.warnings.some((w) => /“Imported conversation”: conversa em execução; não foi atualizada\./.test(w)), result.warnings.join('|'))
  assert.equal(f.hostState.chats.some((c) => c.id === f.importedChat), false)
  assert.deepEqual(f.sets.map(([key]) => key), ['profiles'])
})

test('host: se o host falha, os perfis (e seus vínculos) ficam como estavam', async (t) => {
  const f = fixture(t, { host: true })
  f.hostState.failImport = new Error('O host do Prism não respondeu.')
  await assert.rejects(f.api.importTraycer(request(f.root)), /O host do Prism não respondeu/)
  assert.deepEqual(f.sets, [])
  assert.equal(f.agentStore.get('profiles').length, 0)
  assert.equal(f.emitted.length, 0)
})

test('host: previewTraycer lê os ids já importados pela fachada', async (t) => {
  const f = fixture(t, { host: true })
  const before = await f.api.previewTraycer(f.root)
  assert.equal(before.chats[0].imported, false)
  assert.equal(f.hostState.reads.chats, 1)
  await f.api.importTraycer(request(f.root, { profileIds: [] }))
  assert.equal((await f.api.previewTraycer(f.root)).chats[0].imported, true)
  assert.equal(f.hostState.reads.chats > 2, true)
})

async function importedForLinking(t) {
  const f = fixture(t, { host: true })
  await f.api.importTraycer(request(f.root, { copyCredentials: false }))
  const imported = f.hostState.chats.find((c) => c.id === f.importedChat)
  imported.resume = { route: `codex:${f.importedProfile}`, sessionId: 's' }
  f.hostState.chats.push({ id: 'other', title: 'Other', turns: [], cwd: '', selection: { provider: 'codex', profileId: 'x' }, resume: { route: 'codex:x', sessionId: 's' } })
  f.hostState.calls.importChatDocs.length = 0
  f.sets.length = 0
  f.emitted.length = 0
  return f
}

test('host: setTraycerLogin manda só os chats alterados por importChatDocs e depois grava o perfil', async (t) => {
  const f = await importedForLinking(t)
  await f.api.setTraycerLogin(f.importedProfile, true, f.root)
  assert.equal(f.hostState.calls.importChatDocs.length, 1)
  assert.deepEqual(f.hostState.calls.importChatDocs[0].map((c) => [c.id, c.resume]), [[f.importedChat, undefined]])
  assert.equal(f.hostState.chats.find((c) => c.id === 'other').resume.route, 'codex:x')
  assert.deepEqual(f.sets.map(([key]) => key), ['profiles'])
  assert.deepEqual(f.agentStore.get('profiles')[0].credentialLink, { root: f.realRoot, providerId: 'codex', profileId: 'account-1' })
  assert.deepEqual(f.emitted.at(-1).slice(0, 2), ['prism:profile-changed', f.importedProfile])
  // Desvincular: não há mais o que reiniciar nos chats, só o perfil muda.
  await f.api.setTraycerLogin(f.importedProfile, false, f.root)
  assert.equal(f.agentStore.get('profiles')[0].credentialLink, undefined)
  assert.equal(f.sets.length, 2)
})

test('host: setTraycerLogin com skipped lança antes de gravar o perfil', async (t) => {
  const f = await importedForLinking(t)
  f.hostState.skip.add(f.importedChat)
  await assert.rejects(f.api.setTraycerLogin(f.importedProfile, true, f.root), /Pare as tarefas da conta “Test account” antes de trocar o login dela/)
  assert.equal(f.hostState.calls.importChatDocs.length, 1)
  assert.deepEqual(f.sets, [])
  assert.equal(f.agentStore.get('profiles')[0].credentialLink, undefined)
  assert.equal(f.hostState.chats.find((c) => c.id === f.importedChat).resume.sessionId, 's')
  assert.equal(f.emitted.length, 0)
})

test('host: setTraycerLogin vê o pendingTurnId dos chats do host antes de tocar em qualquer coisa', async (t) => {
  const f = await importedForLinking(t)
  f.hostState.chats.find((c) => c.id === f.importedChat).pendingTurnId = 'turno'
  await assert.rejects(f.api.setTraycerLogin(f.importedProfile, true, f.root), /Pare as tarefas da conta/)
  assert.equal(f.hostState.calls.importChatDocs.length, 0)
  assert.deepEqual(f.sets, [])
})

/* ---------------- Retomar a sessão nativa do Traycer na importação ---------------- */

function setNativeSession(dbFile, { harnessId, sessionId, profileId, workspace }) {
  const db = new DatabaseSync(dbFile)
  const hp = JSON.stringify({ data: { activeSessionChain: { harnessId, sessionId, profileId, sessionWorkspaceSnapshot: { primaryWorkspace: workspace } } } })
  db.prepare('UPDATE chat_projection_head SET host_private_json=? WHERE chat_id=?').run(hp, 'chat-1')
  db.close()
}
function makeRollout(home, sessionId) {
  const dir = path.join(home, 'sessions', '2026', '10', '11')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `rollout-2026-10-11T00-00-00-${sessionId}.jsonl`)
  fs.writeFileSync(file, JSON.stringify({ sessionId }) + '\n')
  return { dir, file, rel: path.join('2026', '10', '11', path.basename(file)) }
}

test('importação retoma a sessão nativa do Codex: conta vinculada, sem copiar', async (t) => {
  const f = fixture(t)
  const temporary = path.dirname(f.userData)
  const sessionId = '01a10c9d-c033-74e2-b2be-d98c2d44138a'
  setNativeSession(f.dbFile, { harnessId: 'codex', sessionId, profileId: 'account-1', workspace: temporary })
  const rollout = makeRollout(f.profileHome, sessionId)
  await f.api.importTraycer({ root: f.root, profileIds: ['account-1'], chatIds: ['task-1/chat-1'], copyCredentials: true })
  const chat = f.agentStore.store.chats.find((c) => c.id === f.importedChat)
  assert.deepEqual(chat.resume, { route: `codex:${f.importedProfile}`, sessionId })
  // Vinculada: o host usa a home do Traycer, onde a sessão já está. Nada é copiado.
  assert.equal(fs.existsSync(path.join(temporary, '.codex')), false)
  assert.ok(fs.existsSync(rollout.file))
})

test('importação copia o rollout do Codex para a home do CLI numa conta ambient', async (t) => {
  const f = fixture(t)
  const temporary = path.dirname(f.userData)
  const sessionId = '01a11cdf-3b3f-78c0-8495-8a15b080e54d'
  setNativeSession(f.dbFile, { harnessId: 'codex', sessionId, profileId: 'account-1', workspace: temporary })
  const rollout = makeRollout(f.profileHome, sessionId)
  await f.api.importTraycer({ root: f.root, profileIds: [], chatIds: ['task-1/chat-1'], copyCredentials: false })
  const chat = f.agentStore.store.chats.find((c) => c.id === f.importedChat)
  assert.deepEqual(chat.resume, { route: 'codex:ambient-codex', sessionId })
  const copied = path.join(temporary, '.codex', 'sessions', rollout.rel)
  assert.ok(fs.existsSync(copied), 'rollout copiado para ~/.codex')
  assert.ok(fs.existsSync(rollout.file), 'original do Traycer intacto')
})

test('importação não retoma quando o chat trocou de provedor', async (t) => {
  const f = fixture(t)
  const temporary = path.dirname(f.userData)
  // Fixture settings.harnessId = codex (o chat é codex no Prism); Traycer rodou em claude.
  setNativeSession(f.dbFile, { harnessId: 'claude', sessionId: '95ca1e3e-06ad-4462-85a5-67e030945a15', profileId: 'account-1', workspace: temporary })
  makeRollout(f.profileHome, '95ca1e3e-06ad-4462-85a5-67e030945a15')
  await f.api.importTraycer({ root: f.root, profileIds: [], chatIds: ['task-1/chat-1'], copyCredentials: false })
  assert.equal(f.agentStore.store.chats.find((c) => c.id === f.importedChat).resume, undefined)
})

test('importação sem o arquivo da sessão cai no histórico (sem resume)', async (t) => {
  const f = fixture(t)
  const temporary = path.dirname(f.userData)
  setNativeSession(f.dbFile, { harnessId: 'codex', sessionId: '00000000-0000-0000-0000-000000000000', profileId: 'account-1', workspace: temporary })
  await f.api.importTraycer({ root: f.root, profileIds: ['account-1'], chatIds: ['task-1/chat-1'], copyCredentials: true })
  assert.equal(f.agentStore.store.chats.find((c) => c.id === f.importedChat).resume, undefined)
})

test('Atualizar do Traycer retoma a sessão nativa de um chat já importado', async (t) => {
  const f = fixture(t)
  const temporary = path.dirname(f.userData)
  // Importado antes da sessão existir: sem resume.
  await f.api.importTraycer({ root: f.root, profileIds: ['account-1'], chatIds: ['task-1/chat-1'], copyCredentials: true })
  assert.equal(f.agentStore.store.chats.find((c) => c.id === f.importedChat).resume, undefined)
  // Agora a sessão nativa existe; reimportar a adota.
  const sessionId = '01b20d0e-d144-85f3-c3cf-e0e35f33249b'
  setNativeSession(f.dbFile, { harnessId: 'codex', sessionId, profileId: 'account-1', workspace: temporary })
  makeRollout(f.profileHome, sessionId)
  await f.api.reimportTraycerChat(f.importedChat)
  assert.deepEqual(f.agentStore.store.chats.find((c) => c.id === f.importedChat).resume, { route: `codex:${f.importedProfile}`, sessionId })
})

/* ---------------- "Atualizar do Traycer": reimportTraycerChat ---------------- */

function addTraycerMessage(dbFile, chatId, messageId, text) {
  const db = new DatabaseSync(dbFile)
  const seq = db.prepare('SELECT COALESCE(MAX(insert_seq),0)+1 AS n FROM chat_message').get().n
  db.prepare('INSERT INTO chat_message VALUES (?,?,?,NULL)').run(chatId, JSON.stringify({ messageId, role: 'assistant', blocks: [{ type: 'text', text }] }), seq)
  db.close()
}

for (const viaHost of [true, false]) {
  const label = viaHost ? 'host' : 'ipc'
  const chatsOf = (f) => (viaHost ? f.hostState.chats : f.agentStore.store.chats)

  test(`${label}: trocar pasta impede reimportação e refresh de reativar a sessão antiga`, async t => {
    const f = fixture(t, { host: viaHost })
    const temporary = path.dirname(f.userData), sessionId = '01a11cdf-3b3f-78c0-8495-8a15b080e54d'
    setNativeSession(f.dbFile, { harnessId: 'codex', sessionId, profileId: 'account-1', workspace: temporary })
    makeRollout(f.profileHome, sessionId)
    await f.api.importTraycer(request(f.root, { profileIds: [], copyCredentials: false }))
    const chat = chatsOf(f).find(c => c.id === f.importedChat)
    assert.equal(chat.resume.sessionId, sessionId)
    Object.assign(chat, { cwd: path.join(temporary, 'new-project'), cwdPinned: true, workspaceNeedsBinding: false })
    delete chat.resume; delete chat.lastRunId
    await f.api.importTraycer(request(f.root, { profileIds: [], copyCredentials: false }))
    let current = chatsOf(f).find(c => c.id === f.importedChat)
    assert.equal(current.resume, undefined); assert.equal(current.cwdPinned, true); assert.equal(current.cwd, chat.cwd)
    addTraycerMessage(f.dbFile, 'chat-1', 'new-source-turn', 'Novidade da origem')
    const refreshed = await f.api.reimportTraycerChat(f.importedChat)
    assert.equal(refreshed.updated, 1)
    current = chatsOf(f).find(c => c.id === f.importedChat)
    assert.equal(current.resume, undefined); assert.equal(current.cwdPinned, true); assert.equal(current.cwd, chat.cwd)
    assert.equal(current.turns.at(-1).segments[0].text, 'Novidade da origem')
  })

  test(`${label}: reimportTraycerChat atualiza o histórico de um chat ainda não mexido no Prism`, async (t) => {
    const f = fixture(t, { host: viaHost })
    await f.api.importTraycer(request(f.root, { profileIds: [] }))
    assert.equal(chatsOf(f).find((c) => c.id === f.importedChat).turns.length, 2)
    assert.equal(chatsOf(f).find((c) => c.id === f.importedChat).traycerSource.syncedTurns, 2)
    addTraycerMessage(f.dbFile, 'chat-1', 'assistant-2', 'Novo trabalho no Traycer')
    const result = await f.api.reimportTraycerChat(f.importedChat)
    assert.equal(result.updated, 1); assert.equal(result.chats, 0); assert.equal(result.skipped, 0)
    const updated = chatsOf(f).find((c) => c.id === f.importedChat)
    assert.equal(updated.turns.length, 3)
    assert.equal(updated.turns.at(-1).segments[0].text, 'Novo trabalho no Traycer')
    assert.equal(updated.traycerSource.syncedTurns, 3)
    // De novo, sem novidade no Traycer: nada a atualizar.
    const again = await f.api.reimportTraycerChat(f.importedChat)
    assert.equal(again.updated, 0); assert.equal(again.skipped, 1)
    assert.equal(chatsOf(f).find((c) => c.id === f.importedChat).turns.length, 3)
  })

  test(`${label}: reimportTraycerChat não sobrescreve um chat continuado no Prism`, async (t) => {
    const f = fixture(t, { host: viaHost })
    await f.api.importTraycer(request(f.root, { profileIds: [] }))
    const chat = chatsOf(f).find((c) => c.id === f.importedChat)
    chat.resume = { route: `codex:${f.importedProfile}`, sessionId: 's1' }
    chat.turns.push({ id: 'prism-1', role: 'user', text: 'continuei aqui no Prism' })
    addTraycerMessage(f.dbFile, 'chat-1', 'assistant-2', 'mudou no Traycer')
    const result = await f.api.reimportTraycerChat(f.importedChat)
    assert.equal(result.updated, 0); assert.equal(result.skipped, 1)
    assert.ok(result.warnings.some((w) => /continuado no Prism; histórico não atualizado/.test(w)), result.warnings.join('|'))
    const after = chatsOf(f).find((c) => c.id === f.importedChat)
    assert.equal(after.turns.at(-1).text, 'continuei aqui no Prism')
  })

  test(`${label}: reimportTraycerChat vê mais turnos que os importados como "continuado", sem resume`, async (t) => {
    const f = fixture(t, { host: viaHost })
    await f.api.importTraycer(request(f.root, { profileIds: [] }))
    // The user sent in Prism but the run left no resume: the extra turn alone marks it.
    chatsOf(f).find((c) => c.id === f.importedChat).turns.push({ id: 'prism-1', role: 'user', text: 'local' })
    addTraycerMessage(f.dbFile, 'chat-1', 'assistant-2', 'mudou no Traycer')
    const result = await f.api.reimportTraycerChat(f.importedChat)
    assert.equal(result.updated, 0)
    assert.ok(result.warnings.some((w) => /continuado no Prism/.test(w)))
    assert.equal(chatsOf(f).find((c) => c.id === f.importedChat).turns.at(-1).text, 'local')
  })
}

test('reimportTraycerChat recusa conversas inválidas ou que não vieram do Traycer', async (t) => {
  const f = fixture(t)
  await assert.rejects(f.api.reimportTraycerChat(''), /inválida/)
  await assert.rejects(f.api.reimportTraycerChat('não-existe'), /não encontrada/)
  await assert.rejects(f.api.reimportTraycerChat('existing'), /não foi importada do Traycer/)
})

for (const viaHost of [true, false]) {
  test(`${viaHost ? 'host' : 'ipc'}: repairLegacyTraycerImports é assíncrona e repara importações antigas`, async (t) => {
    const f = fixture(t, { host: viaHost })
    // Sem importações antigas: não faz nada.
    const idle = f.api.repairLegacyTraycerImports()
    assert.equal(typeof idle.then, 'function')
    await idle
    if (viaHost) assert.equal(f.hostState.calls.importChatDocs.length, 0)
    await f.api.importTraycer(request(f.root, { profileIds: [] }))
    const chats = viaHost ? f.hostState.chats : f.agentStore.store.chats
    const imported = chats.find((c) => c.id === f.importedChat)
    delete imported.traycerSource; delete imported.taskId; imported.title = 'Renomeado'
    const sent = viaHost ? f.hostState.calls.importChatDocs.length : 0
    await f.api.repairLegacyTraycerImports()
    const repaired = (viaHost ? f.hostState.chats : f.agentStore.store.chats).find((c) => c.id === f.importedChat)
    assert.equal(repaired.traycerSource.chatId, 'chat-1')
    assert.equal(repaired.taskId, f.importedTask)
    assert.equal(repaired.title, 'Renomeado')
    if (viaHost) assert.equal(f.hostState.calls.importChatDocs.length, sent + 1)
  })
}
