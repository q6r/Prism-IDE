const assert = require('node:assert/strict')
const test = require('node:test')
const loadTypescript = require('./helpers/load-typescript.cjs')

const m = loadTypescript('src/main/ipc/providerProfiles.ts')

test('loginTerminalSize accepts integers in range', () => {
  assert.deepEqual({ ...m.loginTerminalSize({ cols: 80, rows: 30 }) }, { cols: 80, rows: 30 })
  assert.deepEqual({ ...m.loginTerminalSize({ cols: 20, rows: 5 }) }, { cols: 20, rows: 5 })
  assert.deepEqual({ ...m.loginTerminalSize({ cols: 500, rows: 200 }) }, { cols: 500, rows: 200 })
})

test('loginTerminalSize falls back per field', () => {
  const def = { cols: 100, rows: 24 }
  for (const bad of [undefined, null, 'x', 5, true, [], {}]) assert.deepEqual({ ...m.loginTerminalSize(bad) }, def)
  assert.deepEqual({ ...m.loginTerminalSize({ cols: 5 }) }, def)
  assert.deepEqual({ ...m.loginTerminalSize({ cols: 80.5, rows: 10.2 }) }, def)
  assert.deepEqual({ ...m.loginTerminalSize({ cols: '80', rows: '30' }) }, def)
  assert.deepEqual({ ...m.loginTerminalSize({ cols: 19, rows: 4 }) }, def)
  assert.deepEqual({ ...m.loginTerminalSize({ cols: 501, rows: 201 }) }, def)
  assert.deepEqual({ ...m.loginTerminalSize({ cols: NaN, rows: Infinity }) }, def)
  assert.deepEqual({ ...m.loginTerminalSize({ cols: 80 }) }, { cols: 80, rows: 24 })
  assert.deepEqual({ ...m.loginTerminalSize({ rows: 40, cols: 'a' }) }, { cols: 100, rows: 40 })
})

test('loginSessionId', () => {
  for (const ok of ['a', 'abc-DEF_123', 'a'.repeat(64)]) assert.equal(m.loginSessionId(ok), ok)
  for (const bad of ['', 'a'.repeat(65), '../x', 'a b', 'a/b', 'a\n', 1, null, undefined, {}, ['a']]) assert.equal(m.loginSessionId(bad), null)
})

const prof = (id, extra = {}) => ({ id, provider: 'claude', ...extra })
const chat = (profileId, extra = {}) => ({ id: 'c-' + profileId, selection: { provider: 'claude', profileId, model: 'm' }, ...extra })

test('profileRemovalError', () => {
  const TERM = 'A conta do terminal é gerenciada pelo terminal e não pode ser removida.'
  const stored = [prof('p1'), prof('p2', { tombstoned: true }), prof('ambient-claude', { ambient: true })]
  for (const bad of [undefined, null, 5, '', 'ambient-claude', 'ambient-x']) assert.equal(m.profileRemovalError(stored, [], bad), TERM)
  assert.equal(m.profileRemovalError(stored, [], 'nope'), 'Conta não encontrada.')
  assert.equal(m.profileRemovalError(stored, [], 'p2'), 'Conta não encontrada.')
  assert.equal(m.profileRemovalError(stored, [chat('p1', { pendingTurnId: 't1' })], 'p1'), 'Pare as tarefas desta conta antes de removê-la.')
  assert.equal(m.profileRemovalError(stored, [chat('p1')], 'p1'), null)
  assert.equal(m.profileRemovalError(stored, [chat('p1', { pendingTurnId: '' })], 'p1'), null)
  assert.equal(m.profileRemovalError(stored, [chat('other', { pendingTurnId: 't1' })], 'p1'), null)
  assert.equal(m.profileRemovalError(stored, [], 'p1'), null)
})

test('tombstoneProfile', () => {
  const a = prof('a', { enabled: true }), b = prof('b', { enabled: true })
  const input = [a, b]
  const out = m.tombstoneProfile(input, 'b')
  assert.notEqual(out, input)
  assert.equal(out[0], a)
  assert.equal(out[1].tombstoned, true)
  assert.equal(out[1].enabled, false)
  assert.equal(out[1].id, 'b')
  assert.equal(b.tombstoned, undefined)
  assert.equal(b.enabled, true)
  assert.deepEqual(input, [a, b])
  assert.deepEqual(m.tombstoneProfile(input, 'zzz').map((p) => p.id), ['a', 'b'])
})

test('moveChatsToTerminal', () => {
  const c1 = chat('p1', { resume: { x: 1 }, lastRunId: 'r1' })
  const c2 = { id: 'c2', selection: { provider: 'codex', profileId: 'p1', model: 'gpt' }, resume: { y: 1 }, lastRunId: 'r2' }
  const c3 = chat('p3', { resume: { z: 1 }, lastRunId: 'r3' })
  const input = [c1, c2, c3]
  assert.equal(m.moveChatsToTerminal(input, 'none'), null)
  const out = m.moveChatsToTerminal(input, 'p1')
  assert.equal(out.length, 3)
  assert.equal(out[0].selection.profileId, 'ambient-claude')
  assert.equal(out[0].selection.model, 'm')
  assert.equal(out[0].selection.provider, 'claude')
  assert.equal(out[0].resume, undefined)
  assert.equal(out[0].lastRunId, undefined)
  assert.equal(out[1].selection.profileId, 'ambient-codex')
  assert.equal(out[1].selection.model, 'gpt')
  assert.equal(out[1].resume, undefined)
  assert.equal(out[1].lastRunId, undefined)
  assert.equal(out[2], c3)
  assert.equal(c1.selection.profileId, 'p1')
  assert.deepEqual(c1.resume, { x: 1 })
  assert.equal(c1.lastRunId, 'r1')
  assert.equal(input[0], c1)
})

test('isProfileFolderName', () => {
  for (const ok of ['3f2c1a9e-1111-4222-8333-444455556666', 'work_profile', 'a', 'A-1']) assert.equal(m.isProfileFolderName(ok), true)
  for (const bad of ['', '.', '..', 'a/b', 'a\b', '../x', 'a b', 'a.b']) assert.equal(m.isProfileFolderName(bad), false)
})
