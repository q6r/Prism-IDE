const { test } = require('node:test')
const assert = require('node:assert/strict')
const load = require('./helpers/load-typescript.cjs')

// The claude:journal-begin / claude:journal bridge left with T07 (the host
// journals the turns it runs); the login-change forwarding stays until T08.
function fixture({ windows } = {}) {
  const handlers = {}, journal = [], appEvents = {}
  const repo = {
    beginRun: (chat, id) => journal.push({ kind: 'begin', chat: chat.id, id }),
    appendEvent: (chat, id, event) => journal.push({ chat, id, ...event })
  }
  const usage = load('src/shared/providerUsage.ts')
  const module = load('src/main/ipc/claudeAgent.ts', {
  './claudeSubagents':load('src/main/ipc/claudeSubagents.ts'),
  './claudeTurnLifecycle':load('src/main/ipc/claudeTurnLifecycle.ts'),
    '../../shared/providerUsage': usage,
    electron: { ipcMain: { on: (key, fn) => { handlers[key] = fn }, handle: () => {} }, app: { on: (name, fn) => { appEvents[name] = fn } }, ...(windows ? { BrowserWindow: { getAllWindows: () => windows } } : {}) },
    child_process: { spawn: () => { throw Error('No CLI allowed') }, execSync: () => Buffer.from('C:\\fake\\claude.exe') },
    fs: { existsSync: () => true }, 'fs/promises': { readFile: () => Promise.reject(), readdir: () => Promise.resolve([]) }, os: { homedir: () => 'C:\\fake' }, path: require('node:path'),
    '../providers': { profileEnvironment: () => ({}), providerCommand: () => null, agentStore: repo }, './ssh': { matchesSshTarget: () => false, getSshClient: () => null },
    '@anthropic-ai/claude-agent-sdk': { query: () => { throw Error('no query') } }
  })
  module.registerClaudeAgentHandlers()
  return { journal, handlers, appEvents }
}

test('the journal bridge handlers are gone', () => {
  const f = fixture()
  assert.equal(f.handlers['claude:journal-begin'], undefined)
  assert.equal(f.handlers['claude:journal'], undefined)
})

const win = (destroyed = false) => { const sent = []; return { sent, webContents: { isDestroyed: () => destroyed, send: (...a) => sent.push(a) } } }

test('profile-changed is forwarded to every live window as claude:profile-changed', () => {
  const a = win(), b = win(true), c = win()
  const f = fixture({ windows: [a, b, c] })
  f.appEvents['prism:profile-changed']('acct')
  assert.deepEqual(a.sent, [['claude:profile-changed', 'acct']])
  assert.deepEqual(b.sent, [])
  assert.deepEqual(c.sent, [['claude:profile-changed', 'acct']])
})

test('profile-changed does not break when electron has no BrowserWindow', () => {
  const f = fixture()
  assert.doesNotThrow(() => f.appEvents['prism:profile-changed']('acct'))
})
