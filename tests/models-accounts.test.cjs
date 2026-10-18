const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { DatabaseSync } = require('node:sqlite')
const load = require('./helpers/load-typescript.cjs')

const tmp = (t, prefix = 'prism-ma-') => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
const writeJson = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data)) }

// ---------------------------------------------------------------- agentModels
const models = load('src/main/ipc/agentModels.ts', {
  electron: { ipcMain: { handle() {} }, app: { on() {} } },
  '../codexServer': { CodexServer: class {} }, '../providers': {}, '../providerUsage': {},
  '../../shared/modelLabels': load('src/shared/modelLabels.ts')
})

test('claudeModelLabel matches the Traycer labels for real CLI rows', () => {
  const L = (value, displayName, description) => models.claudeModelLabel({ value, displayName, description })
  // CLI 2.1.289
  assert.equal(L('default', 'Default (recommended)', 'Opus 5.5 · Best for everyday, complex tasks'), 'Default (Opus 5.5)')
  assert.equal(L('opus', 'Opus 5.5', 'For complex work...'), 'Opus 5.5')
  assert.equal(L('fable', 'Fable 5.1', 'For your toughest challenges'), 'Fable 5.1')
  assert.equal(L('claude-sonnet-5', 'Sonnet 5', 'Efficient...'), 'Sonnet 5')
  // CLI 2.1.281
  assert.equal(L('opus[1m]', 'Opus (1M context)', 'Opus 5.5 with 1M context · ...'), 'Opus 5.5 (1M context)')
  assert.equal(L('claude-fable-5-1[1m]', 'Fable', 'Fable 5.1 · Most capable...'), 'Fable')
  assert.equal(L('sonnet', 'Sonnet', 'Sonnet 5 · Efficient...'), 'Sonnet 5')
  assert.equal(L('haiku', 'Haiku', 'Haiku 4.5 · Fastest...'), 'Haiku 4.5')
  // name without the family at the start, and case-insensitive match
  assert.equal(L('custom', 'Custom', 'Opus 5.5 · something'), 'Custom (Opus 5.5)')
  assert.equal(L('default', 'Default', 'claude opus 4.8 is used'), 'Default (Opus 4.8)')
  assert.equal(L('x', 'Plain', undefined), 'Plain')
})

test('claudeModels keeps CLI order, filters efforts and flags default/fast', () => {
  const out = models.claudeModels([
    { value: 'default', displayName: 'Default (recommended)', description: 'Opus 5.5 · x', supportedEffortLevels: ['low', 'bogus', 'high', 'high', 'max'], supportsFastMode: true },
    { value: 'haiku', displayName: 'Haiku', description: 'Haiku 4.5 · y' },
    { value: 'opus', displayName: 'Opus 5.5', description: 'z', supportedEffortLevels: ['ultra', 'medium'] }
  ])
  assert.deepEqual(out.map((m) => m.id), ['default', 'haiku', 'opus'])
  assert.deepEqual(out[0].efforts, ['low', 'high', 'max'])
  assert.deepEqual(out[1].efforts, [])
  assert.deepEqual(out[2].efforts, ['ultra', 'medium'])
  assert.deepEqual(out.map((m) => m.default), [true, false, false])
  assert.deepEqual(out.map((m) => m.fast), [{ id: 'fast', label: 'Fast' }, null, null])
  assert.ok(out.every((m) => m.provider === 'claude' && m.defaultEffort === 'high'))
  assert.equal(out[0].label, 'Default (Opus 5.5)')
})

test('codexModelLabel capitalises gpt ids and falls back to displayName/id', () => {
  const L = models.codexModelLabel
  assert.equal(L('gpt-6.1-sol'), 'GPT-6.1-Sol')
  assert.equal(L('gpt-5.3-codex'), 'GPT-5.3-Codex')
  assert.equal(L('gpt-5.4-mini'), 'GPT-5.4-Mini')
  assert.equal(L('gpt-5.4'), 'GPT-5.4')
  assert.equal(L('codex-auto-review', 'Auto Review'), 'Auto Review')
  assert.equal(L('codex-auto-review'), 'codex-auto-review')
})

test('codexModels hides, moves the default first, keeps ultra and resolves fast tier', () => {
  const out = models.codexModels([
    { model: 'gpt-5.4', displayName: 'a', description: 'd1', supportedReasoningEfforts: [{ reasoningEffort: 'low' }], defaultReasoningEffort: 'low' },
    { model: 'secret', hidden: true },
    { description: 'no model' },
    null,
    { model: 'gpt-6.1-sol', isDefault: true, description: 'd2', defaultReasoningEffort: 'ultra',
      supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'ultra' }, { reasoningEffort: 'weird' }, { reasoningEffort: 'medium' }],
      serviceTiers: [{ id: 'priority', name: 'Fast' }] },
    { model: 'gpt-5.4-mini', defaultReasoningEffort: 'nonsense' }
  ])
  assert.deepEqual(out.map((m) => m.id), ['gpt-6.1-sol', 'gpt-5.4', 'gpt-5.4-mini'])
  assert.equal(out[0].default, true); assert.equal(out[1].default, false)
  assert.deepEqual(out[0].efforts, ['medium', 'ultra'])
  assert.equal(out[0].defaultEffort, 'ultra')
  assert.deepEqual(out[0].fast, { id: 'priority', label: 'Fast' })
  assert.equal(out[0].label, 'GPT-6.1-Sol')
  assert.equal(out[1].fast, null)
  assert.equal(out[2].defaultEffort, undefined)
  assert.deepEqual(out[2].efforts, [])
  assert.ok(out.every((m) => m.provider === 'codex'))
})

test('codexModels keeps order when the default is already first or absent', () => {
  assert.deepEqual(models.codexModels([{ model: 'a', isDefault: true }, { model: 'b' }]).map((m) => m.id), ['a', 'b'])
  assert.deepEqual(models.codexModels([{ model: 'a' }, { model: 'b' }]).map((m) => m.id), ['a', 'b'])
})

// ------------------------------------------------------------------ providers
function providerFixture(t, storedProfiles = []) {
  const base = tmp(t), userData = path.join(base, 'userData'), home = path.join(base, 'home'), root = path.join(base, '.traycer')
  fs.mkdirSync(home, { recursive: true })
  const env = { PATH: 'p', ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k', CODEX_API_KEY: 'k', CLAUDE_CONFIG_DIR: 'ambient', CODEX_HOME: 'ambient', CODEX_SQLITE_HOME: 'ambient-sqlite' }
  const runtime = { env, platform: process.platform, arch: process.arch, execPath: 'node' }
  const state = { profiles: storedProfiles }
  const mod = load('src/main/providers.ts', {
    'electron-store': { __esModule: true, default: class {} }, electron: { app: { getPath: () => userData } },
    './agentRepository': { AgentRepository: class { get(k) { return k === 'profiles' ? state.profiles : [] } set() {} } },
    crypto, fs, path, os: { homedir: () => home },
    child_process: { execFileSync: () => { throw new Error('forbidden') } }
  }, runtime)
  return { ...mod, base, userData, home, root, env, state }
}

test('compareVersions orders numerically and prereleases first', () => {
  const { compareVersions: c } = providerFixture({ after() {} })
  assert.ok(c('2.1.289', '2.1.281') > 0); assert.ok(c('2.1.281', '2.1.289') < 0)
  assert.ok(c('0.160.0', '0.142.5') > 0)
  assert.ok(c('1.10.0', '1.9.9') > 0)
  assert.equal(c('1.2.3', '1.2.3'), 0)
  assert.ok(c('1.0.0-beta', '1.0.0') < 0); assert.ok(c('1.0.0', '1.0.0-beta') > 0)
})

function packFixture(t, provider = 'claude', mutate = {}) {
  const f = providerFixture(t)
  const platformDir = `${process.platform}-${process.arch}`
  const base = path.join(f.root, 'host', 'providers', provider, platformDir)
  const version = '2.1.289', name = 'claude.exe'
  const cur = mutate.current === undefined ? { pack: provider, version } : mutate.current
  if (cur !== null) writeJson(path.join(base, 'current.json'), cur)
  const pack = mutate.pack === undefined ? { pack: provider, version, executablePath: name } : mutate.pack
  const dirVersion = (mutate.current && typeof mutate.current.version === 'string' && !/[\\/]|\.\./.test(mutate.current.version)) ? mutate.current.version : version
  if (pack !== null) writeJson(path.join(base, dirVersion, 'pack.json'), pack)
  if (mutate.exe !== 'none') {
    const exe = path.join(base, dirVersion, name)
    if (mutate.exe === 'dir') fs.mkdirSync(exe, { recursive: true })
    else { fs.mkdirSync(path.dirname(exe), { recursive: true }); fs.writeFileSync(exe, 'x') }
  }
  return { f, base, exe: path.join(base, version, name), version }
}

test('traycerManagedCommand resolves the managed pack executable', (t) => {
  const { f, exe, version } = packFixture(t)
  const r = f.traycerManagedCommand('claude', f.root)
  assert.deepEqual(r, { command: { bin: exe, args: [] }, version })
})

test('traycerManagedCommand rejects malformed or unsafe packs', (t) => {
  const cases = {
    'missing current.json': { current: null },
    'invalid current.json': { current: '{not json' },
    'version with ..': { current: { pack: 'claude', version: '../x' } },
    'version with dot-only': { current: { pack: 'claude', version: '1.0' } },
    'other pack in current': { current: { pack: 'codex', version: '2.1.289' } },
    'pack.json version mismatch': { pack: { pack: 'claude', version: '9.9.9', executablePath: 'claude.exe' } },
    'pack.json other pack': { pack: { pack: 'codex', version: '2.1.289', executablePath: 'claude.exe' } },
    'executablePath with directory': { pack: { pack: 'claude', version: '2.1.289', executablePath: 'sub/claude.exe' } },
    'executablePath with traversal': { pack: { pack: 'claude', version: '2.1.289', executablePath: '..\\x.exe' } },
    'missing exe': { exe: 'none' },
    'exe is a directory': { exe: 'dir' }
  }
  for (const [name, mutate] of Object.entries(cases)) {
    const { f } = packFixture(t, 'claude', mutate)
    assert.equal(f.traycerManagedCommand('claude', f.root), null, name)
  }
})

function accountFixture(t, { provider = 'claude-code', layout, extra = {}, dir = true, stored } = {}) {
  const f = providerFixture(t, stored ? [stored(null)] : [])
  const profileId = 'acc-1', dirPath = path.join(f.root, 'host', 'harness-accounts', provider, profileId)
  if (dir) fs.mkdirSync(dirPath, { recursive: true })
  const entry = { profileId, providerId: provider, kind: 'managed', dirPath, ...(layout ? { layout } : {}), ...extra }
  writeJson(path.join(f.root, 'host', 'config', 'provider-accounts.json'), { profiles: [entry] })
  return { f, profileId, dirPath }
}

test('traycerAccount returns the Traycer home and layout for a live managed account', (t) => {
  const { f, profileId, dirPath } = accountFixture(t, { layout: 'overlay' })
  assert.deepEqual(f.traycerAccount(f.root, 'claude', profileId), { home: dirPath, layout: 'overlay' })
  assert.deepEqual(accountFixture(t).f.traycerAccount(accountFixture(t).f.root, 'claude', 'acc-1').layout, undefined)
})

test('traycerAccount rejects dead, foreign or escaping accounts', (t) => {
  const bad = [
    ['tombstoned', { extra: { tombstoned: true } }, 'acc-1'],
    ['disabled', { extra: { enabled: false } }, 'acc-1'],
    ['not managed', { extra: { kind: 'imported' } }, 'acc-1'],
    ['dir missing', { dir: false }, 'acc-1'],
    ['dirPath elsewhere', { extra: { dirPath: os.tmpdir() } }, 'acc-1'],
    ['traversal id', {}, '../acc-1']
  ]
  for (const [name, opts, id] of bad) {
    const { f } = accountFixture(t, opts)
    assert.equal(f.traycerAccount(f.root, 'claude', id), null, name)
  }
  const { f, profileId } = accountFixture(t)
  assert.equal(f.traycerAccount(f.root, 'codex', profileId), null, 'other provider')
})

const link = (root, providerId, profileId) => ({ root, providerId, profileId })

test('profileEnvironment: claude link uses Traycer dirPath and strips inherited credentials', (t) => {
  const { f, profileId, dirPath } = accountFixture(t)
  f.state.profiles = [{ id: 'p1', provider: 'claude', name: 'x', credentialLink: link(f.root, 'claude-code', profileId) }]
  const env = f.profileEnvironment('claude', 'p1')
  assert.equal(env.CLAUDE_CONFIG_DIR, dirPath)
  assert.equal(env.ANTHROPIC_API_KEY, undefined); assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.CODEX_API_KEY, undefined)
  assert.equal(env.PATH, 'p')
  assert.equal(fs.existsSync(path.join(f.userData, 'provider-profiles', 'p1')), false)
  assert.equal(f.env.ANTHROPIC_API_KEY, 'k', 'global env not mutated')
})

test('profileEnvironment: codex overlay layout shares the sqlite home, other layouts do not', (t) => {
  const { f, profileId, dirPath } = accountFixture(t, { provider: 'codex', layout: 'overlay' })
  f.state.profiles = [{ id: 'p1', provider: 'codex', name: 'x', credentialLink: link(f.root, 'codex', profileId) }]
  // Without ~/.codex the unresolved path is used.
  assert.equal(f.profileEnvironment('codex', 'p1').CODEX_SQLITE_HOME, path.join(f.home, '.codex'))
  fs.mkdirSync(path.join(f.home, '.codex'))
  const env = f.profileEnvironment('codex', 'p1')
  assert.equal(env.CODEX_HOME, dirPath)
  assert.equal(env.CODEX_SQLITE_HOME, fs.realpathSync(path.join(f.home, '.codex')))

  const plain = accountFixture(t, { provider: 'codex', layout: 'isolated' })
  plain.f.state.profiles = [{ id: 'p1', provider: 'codex', name: 'x', credentialLink: link(plain.f.root, 'codex', plain.profileId) }]
  // An inherited CODEX_SQLITE_HOME never redirects a managed account's state.
  const e2 = plain.f.profileEnvironment('codex', 'p1')
  assert.equal(e2.CODEX_HOME, plain.dirPath)
  assert.equal(e2.CODEX_SQLITE_HOME, undefined)
})

test('profileEnvironment fails closed when the link is dead, never using the own directory', (t) => {
  for (const mutate of ['tombstone', 'disabled', 'dir']) {
    const { f, profileId, dirPath } = accountFixture(t)
    f.state.profiles = [{ id: 'p1', provider: 'claude', name: 'x', credentialLink: link(f.root, 'claude-code', profileId) }]
    if (mutate !== 'dir') writeJson(path.join(f.root, 'host', 'config', 'provider-accounts.json'), { profiles: [{ profileId, providerId: 'claude-code', kind: 'managed', [mutate === 'tombstone' ? 'tombstoned' : 'enabled']: mutate === 'tombstone', dirPath }] })
    else fs.rmSync(dirPath, { recursive: true })
    assert.equal(f.linkState(f.state.profiles[0]), 'broken', mutate)
    assert.throws(() => f.profileEnvironment('claude', 'p1'), /vinculada ao Traycer/, mutate)
    assert.equal(fs.existsSync(path.join(f.userData, 'provider-profiles', 'p1')), false, mutate)
  }
})

test('ambient profile ignores links and linkedAccount rejects provider mismatch', (t) => {
  const { f, profileId } = accountFixture(t)
  const ambient = f.profileEnvironment('claude')
  assert.equal(ambient.CLAUDE_CONFIG_DIR, 'ambient')
  assert.equal(ambient.ANTHROPIC_API_KEY, 'k')
  assert.equal(f.linkedAccount({ id: 'ambient-claude', provider: 'claude', name: 'a', ambient: true, credentialLink: link(f.root, 'claude-code', profileId) }), null)
  assert.equal(f.linkedAccount({ id: 'p', provider: 'codex', name: 'a', credentialLink: link(f.root, 'claude-code', profileId) }), null)
  assert.equal(f.linkedAccount({ id: 'p', provider: 'claude', name: 'a' }), null)
  assert.ok(f.linkedAccount({ id: 'p', provider: 'claude', name: 'a', credentialLink: link(f.root, 'claude-code', profileId) }))
})

// -------------------------------------------------------------- providerUsage
const usage = load('src/shared/providerUsage.ts')

test('claudeDetails only exposes the known windows and model_scoped entries', () => {
  const r = {
    five_hour: { utilization: 10, resets_at: '2026-01-01T00:00:00Z' }, seven_day: { utilization: 20 },
    seven_day_opus: { utilization: 30 }, seven_day_sonnet: { utilization: 40 },
    iguana_necktie: { utilization: 99 }, seven_day_oauth_apps: { utilization: 98 }, seven_day_cowork: { utilization: 97 },
    model_scoped: [{ display_name: 'Fable', utilization: 50 }, { display_name: 'Bad' }]
  }
  const d = usage.claudeDetails({ rate_limits_available: true, rate_limits: r, subscription_type: 'max' })
  assert.deepEqual(d.limits.map((l) => l.id), ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'model:0'])
  assert.equal(d.limits[0].resetsAt, Date.parse('2026-01-01T00:00:00Z') / 1000)
  assert.equal(d.limits[4].name, 'Fable')
  assert.equal(d.unavailable, undefined); assert.equal(d.tier, 'max')
})

test('claudeDetails unavailable messages', () => {
  assert.match(usage.claudeDetails({ rate_limits_available: false, subscription_type: null }).unavailable, /sem login/)
  assert.match(usage.claudeDetails({ rate_limits_available: false, subscription_type: 'max' }).unavailable, /indisponíveis/)
  assert.match(usage.claudeDetails({ rate_limits_available: true, rate_limits: null }).unavailable, /não retornou/)
  assert.match(usage.claudeDetails({ rate_limits_available: true, rate_limits: { iguana_necktie: { utilization: 5 } } }).unavailable, /não informou/)
})

test('codexDetails puts the main bucket first without duplicating it', () => {
  const win = (p) => ({ usedPercent: p, windowDurationMins: 300, resetsAt: 1 })
  const d = usage.codexDetails({}, {
    rateLimits: { limitId: 'codex', primary: win(10) },
    rateLimitsByLimitId: { 'gpt-reserve': { limitId: 'gpt-reserve', limitName: 'Reserve', primary: win(5) }, codex: { limitId: 'codex', primary: win(10) } }
  })
  assert.deepEqual(d.limits.map((l) => l.id), ['codex:primary', 'gpt-reserve:primary'])
  assert.equal(d.limits[0].name, null); assert.equal(d.limits[1].name, 'Reserve')
})

test('codexDetails adds the main bucket when the by-id map omits it', () => {
  const d = usage.codexDetails({}, { rateLimits: { limitId: 'codex', primary: { usedPercent: 1, windowDurationMins: 300 } },
    rateLimitsByLimitId: { other: { limitName: 'Other', primary: { usedPercent: 2, windowDurationMins: 300 } } } })
  assert.deepEqual(d.limits.map((l) => l.id), ['codex:primary', 'other:primary'])
})

// ---------------------------------------------------------------- traycerImport
function importFixture(t) {
  const temporary = tmp(t, 'prism-ma-import-')
  const root = path.join(temporary, '.traycer'), userData = path.join(temporary, 'prism')
  const profileHome = path.join(root, 'host', 'harness-accounts', 'codex', 'account-1')
  fs.mkdirSync(profileHome, { recursive: true })
  fs.writeFileSync(path.join(profileHome, 'auth.json'), '{"tokens":{"access_token":"FAKE_FIXTURE_TOKEN"}}')
  writeJson(path.join(root, 'host', 'config', 'provider-accounts.json'), { profiles: [
    { profileId: 'account-1', kind: 'managed', providerId: 'codex', label: 'Test account', dirPath: profileHome }] })
  fs.mkdirSync(path.join(root, 'host', 'epic-state'), { recursive: true })
  let store = { profiles: [], chats: [] }
  const emitted = []
  const agentStore = { get(key) { return store[key] }, get store() { return store }, set store(v) { store = v }, readState: (_key, fallback) => fallback }
  const providers = load('src/main/providers.ts', {
    'electron-store': { __esModule: true, default: class {} }, electron: { app: { getPath: () => userData } },
    './agentRepository': { AgentRepository: class {} }, crypto, fs, path, os,
    child_process: { execFileSync: () => { throw new Error('forbidden') } }
  })
  // A fachada de verdade, sem binário do host: o caminho ipc (agentStore).
  const hostChats = load('src/main/hostChats.ts', {
    './providers': { agentStore }, './host/supervisor': { hostBinaryPresent: () => false },
    './host/mainClient': { mainHostClient: () => { throw new Error('o cliente do host não deve ser criado sem binário') } },
    './ipc/providerProfiles': load('src/main/ipc/providerProfiles.ts')
  })
  const api = load('src/main/ipc/traycerImport.ts', {
    electron: { app: { getPath: () => userData, emit: (...a) => emitted.push(a) }, dialog: {}, ipcMain: {} }, crypto, fs, path, os,
    'node:sqlite': { DatabaseSync }, '../../shared/traycerImport': load('src/shared/traycerImport.ts'),
    '../providers': { agentStore, traycerAccount: providers.traycerAccount, credentialFile: providers.credentialFile },
    '../hostChats': hostChats
  })
  const realRoot = api.rootPath(root)
  return { root, realRoot, userData, api, agentStore, emitted, importedId: api.importedId(realRoot, 'profile', 'account-1') }
}

test('linking an already imported profile counts the credential and drops only its resume', async (t) => {
  const f = importFixture(t), id = f.importedId
  f.agentStore.store = {
    profiles: [{ id, provider: 'codex', name: 'Test account' }],
    chats: [
      { id: 'a', title: 'A', turns: [], cwd: '', selection: { provider: 'codex', profileId: id }, resume: { route: `codex:${id}`, sessionId: 's' } },
      { id: 'b', title: 'B', turns: [], cwd: '', selection: { provider: 'codex', profileId: 'other' }, resume: { route: 'codex:other', sessionId: 's' } }
    ]
  }
  const result = await f.api.importTraycer({ root: f.root, profileIds: ['account-1'], chatIds: [], copyCredentials: true })
  assert.equal(result.profiles, 0); assert.equal(result.skipped, 1); assert.equal(result.credentials, 1)
  const { profiles, chats } = f.agentStore.store
  assert.deepEqual(profiles[0].credentialLink, { root: f.realRoot, providerId: 'codex', profileId: 'account-1' })
  assert.equal(chats.find((c) => c.id === 'a').resume, undefined)
  assert.equal(chats.find((c) => c.id === 'b').resume.route, 'codex:other')
  assert.equal(fs.existsSync(path.join(f.userData, 'provider-profiles', id, 'auth.json')), false)
  assert.deepEqual(f.emitted.map((e) => e.slice(0, 2)), [['prism:profile-changed', id]])
  // Idempotent: relinking the same link does nothing.
  assert.equal((await f.api.importTraycer({ root: f.root, profileIds: ['account-1'], chatIds: [], copyCredentials: true })).credentials, 0)
})

test('linking is refused while the profile has a running turn and leaves the store untouched', async (t) => {
  const f = importFixture(t), id = f.importedId
  f.agentStore.store = {
    profiles: [{ id, provider: 'codex', name: 'Test account' }],
    chats: [{ id: 'a', title: 'A', turns: [], cwd: '', pendingTurnId: 't1', selection: { provider: 'codex', profileId: id }, resume: { route: `codex:${id}` } }]
  }
  const original = f.agentStore.store
  await assert.rejects(f.api.importTraycer({ root: f.root, profileIds: ['account-1'], chatIds: [], copyCredentials: true }), /Pare as tarefas/)
  assert.equal(f.agentStore.store, original)
  assert.equal(original.profiles[0].credentialLink, undefined)
  assert.equal(original.chats[0].resume.route, `codex:${id}`)
  assert.equal(f.emitted.length, 0)
})
