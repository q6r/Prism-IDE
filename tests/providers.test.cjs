const { test } = require('node:test')
const assert = require('node:assert/strict')
const load = require('./helpers/load-typescript.cjs')

function fixture() {
  const directories = []
  let uuid = 0
  class MockStore {
    constructor({ defaults }) { this.data = structuredClone(defaults) }
    get(key) { return this.data[key] }
    set(key, value) { this.data[key] = value }
  }
  const env = {
    PATH: 'mock-bin', UNRELATED_SETTING: 'retained', CLAUDE_CONFIG_DIR: 'ambient-claude-dir', CODEX_HOME: 'ambient-codex-dir',
    ANTHROPIC_API_KEY: 'fake-api', ANTHROPIC_AUTH_TOKEN: 'fake-token', CLAUDE_CODE_OAUTH_TOKEN: 'fake-oauth',
    OPENAI_API_KEY: 'fake-openai', CODEX_API_KEY: 'fake-codex', CODEX_ACCESS_TOKEN: 'fake-access',
    ANTHROPIC_BASE_URL: 'https://mock.invalid', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_USE_FOUNDRY: '1'
  }
  const runtime = { env, platform: process.platform, execPath: 'mock-node' }
  const module = load('src/main/providers.ts', {
    'electron-store': { __esModule: true, default: MockStore }, electron: { app: { getPath: () => 'C:\\QA\\mock-user-data' } },
    './agentRepository': { AgentRepository: class {constructor(_path, legacy) {this.legacy=legacy} get(key) {return this.legacy.get(key)} set(key,value){this.legacy.set(key,value)} } },
    crypto: { randomUUID: () => `profile-${++uuid}` },
    fs: { mkdirSync: (dir, options) => directories.push({ dir, options }), existsSync: () => false },
    path: require('node:path'), os: { homedir: () => 'mock-home' },
    child_process: { execFileSync: () => { throw new Error('Real CLI execution forbidden') } }
  }, runtime)
  return { ...module, env, directories }
}

test('managed accounts isolate per-provider config directories and preserve global environment', () => {
  const f = fixture(), original = structuredClone(f.env)
  for (const [provider, key] of [['claude', 'CLAUDE_CONFIG_DIR'], ['codex', 'CODEX_HOME']]) {
    const a = f.createProfile(provider, 'Personal'), b = f.createProfile(provider, 'Work')
    const envA = f.profileEnvironment(provider, a.id), envB = f.profileEnvironment(provider, b.id)
    assert.notEqual(envA[key], envB[key]); assert.notEqual(envA[key], f.env[key])
    assert.ok(envA[key].includes(a.id)); assert.ok(envB[key].includes(b.id))
    assert.equal(envA.UNRELATED_SETTING, 'retained'); assert.equal(envA.PATH, 'mock-bin')
    for (const credential of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
      'OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'ANTHROPIC_BASE_URL',
      'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) {
      assert.equal(envA[credential], undefined); assert.equal(envB[credential], undefined)
    }
  }
  assert.deepEqual(f.env, original)
  assert.ok(f.directories.every(call => call.options.recursive && call.options.mode === 0o700))
})

test('ambient accounts return independent unchanged environment copies without creating auth directories', () => {
  const f = fixture()
  for (const provider of ['claude', 'codex']) {
    const env = f.profileEnvironment(provider)
    assert.deepEqual(env, f.env); assert.notEqual(env, f.env)
    env.PATH = 'changed'; assert.equal(f.env.PATH, 'mock-bin')
  }
  assert.deepEqual(f.directories, [])
})

test('unknown and mismatched profile routes are rejected before directory or environment changes', () => {
  const f = fixture(), profile = f.createProfile('claude', 'Work'), count = f.directories.length
  for (const [provider, id] of [['codex', profile.id], ['claude', 'ambient-codex'], ['codex', 'missing']])
    assert.throws(() => f.profileEnvironment(provider, id), /Conta/)
  assert.equal(f.directories.length, count)
})
