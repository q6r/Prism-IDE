const { test } = require('node:test')
const assert = require('node:assert/strict')
const loadTypescript = require('./helpers/load-typescript.cjs')
const { continuationPrompt, transcriptText, boundedTranscript, HISTORY_OMITTED, routeKey, sameRemoteTarget } = loadTypescript('src/shared/agents.ts')

const selection = (overrides = {}) => ({
  provider: 'claude', profileId: 'ambient', model: 'model-a', effort: 'medium',
  permissionMode: 'default', ...overrides
})
const chat = (overrides = {}) => ({
  id: 'chat-a', title: 'A', cwd: '/workspace', updatedAt: 0,
  selection: selection(), turns: [], ...overrides
})

test('same immediate provider/profile resumes with only the new prompt', () => {
  const c = chat({ turns: [{ id: '1', role: 'user', text: 'old' }],
    resume: { route: 'claude:ambient', sessionId: 'native-a' } })
  assert.deepEqual(continuationPrompt(c, 'new'), { prompt: 'new', resume: 'native-a' })
  c.selection = selection({ model: 'model-b', effort: 'high', permissionMode: 'plan' })
  assert.deepEqual(continuationPrompt(c, 'new'), { prompt: 'new', resume: 'native-a' })
})

test('provider or account switches transfer history and never reuse another route session', () => {
  for (const next of [selection({ provider: 'codex' }), selection({ profileId: 'work' })]) {
    const c = chat({ selection: next, turns: [{ id: '1', role: 'user', text: 'prior instruction' }],
      resume: { route: 'claude:ambient', sessionId: 'native-a' } })
    const result = continuationPrompt(c, 'next instruction')
    assert.equal(result.resume, undefined)
    assert.ok(result.prompt.includes('prior instruction'))
    assert.ok(result.prompt.endsWith('next instruction'))
  }
})

test('switching back does not revive an older native session', () => {
  const c = chat({ selection: selection(), resume: { route: 'codex:work', sessionId: 'native-b' },
    turns: [{ id: '1', role: 'assistant', provider: 'codex', text: 'latest work' }] })
  assert.equal(continuationPrompt(c, 'continue').resume, undefined)
  assert.ok(continuationPrompt(c, 'continue').prompt.includes('latest work'))
})

test('handoff keeps the full transcript and tool input/results while excluding reasoning', () => {
  const turns = [
    { id: 'u1', role: 'user', text: 'first instruction' },
    { id: 'a1', role: 'assistant', provider: 'claude', text: 'fallback should not duplicate', segments: [
      { kind: 'thinking', text: 'PRIVATE REASONING' },
      { kind: 'text', text: 'visible answer' },
      { kind: 'tool', name: 'Bash', input: { command: 'npm test' }, result: '42 tests passed' }
    ] },
    { id: 'bad', role: 'assistant', text: 'failed turn', error: true },
    { id: 'u2', role: 'user', text: 'latest instruction' },
    { id: 'a2', role: 'assistant', provider: 'codex', text: 'partial visible output', interrupted: true }
  ]
  const result = continuationPrompt(chat({ turns }), 'new instruction').prompt
  for (const visible of ['first instruction', 'visible answer', 'Bash', 'npm test',
    '42 tests passed', 'latest instruction', 'partial visible output', 'failed turn']) assert.ok(result.includes(visible))
  for (const hidden of ['PRIVATE REASONING', 'fallback should not duplicate']) assert.ok(!result.includes(hidden))
  assert.ok(result.indexOf('first instruction') < result.indexOf('latest instruction'))
  assert.deepEqual(turns[1].segments[0], { kind: 'thinking', text: 'PRIVATE REASONING' })
})

test('rate-limited or interrupted migration keeps successful side effects in the next provider context', () => {
  for (const termination of [{ error: true }, { interrupted: true }]) {
    const c = chat({ selection: selection({ provider: 'codex' }), turns: [
      { id: 'u', role: 'user', text: 'Apply database migration' },
      { id: 'a', role: 'assistant', provider: 'claude', text: '', ...termination, segments: [
        { kind: 'tool', name: 'Bash', input: { command: 'migrate up' }, result: 'Migration 017 applied successfully', status: 'done' },
        { kind: 'text', text: 'Rate limit reached before final summary' },
        { kind: 'thinking', text: 'HIDDEN MIGRATION REASONING' }
      ] }
    ] })
    const result = continuationPrompt(c, 'Continue safely')
    assert.equal(result.resume, undefined)
    assert.ok(result.prompt.includes('migrate up'))
    assert.ok(result.prompt.includes('Migration 017 applied successfully'))
    assert.ok(result.prompt.includes('Rate limit reached'))
    assert.ok(result.prompt.includes('[Esta execu'))
    assert.ok(!result.prompt.includes('HIDDEN MIGRATION REASONING'))
  }
})

test('SSH target identity survives reconnect ids and requires host, port and username', () => {
  const target = { host: 'Server.Example', port: 22, username: 'alice' }
  assert.equal(sameRemoteTarget({ ...target, id: 'old' }, { ...target, host: 'server.example', id: 'new' }), true)
  for (const other of [undefined, { ...target, host: 'elsewhere.example' }, { ...target, port: 2222 },
    { ...target, username: 'bob' }, { ...target, username: 'Alice' }]) assert.equal(sameRemoteTarget(target, other), false)
  assert.equal(sameRemoteTarget(undefined, target), false)
  assert.equal(sameRemoteTarget(undefined, undefined), false)
})

test('long conversations are not silently truncated on handoff', () => {
  const turns = Array.from({ length: 120 }, (_, i) => ({ id: String(i), role: 'user', text: `turn-${i}-` + 'x'.repeat(1000) }))
  const result = transcriptText(turns)
  for (const turn of turns) assert.ok(result.includes(turn.text))
})

test('a huge import carries only the recent tail within budget, with a marker', () => {
  // ~2 MB of history, far past the Codex 1 MB submission cap.
  const turns = Array.from({ length: 400 }, (_, i) => ({ id: `t${i}`, role: 'user', text: `TURN ${i} ` + 'x'.repeat(5000) }))
  const result = continuationPrompt(chat({ selection: selection({ provider: 'codex', profileId: 'ambient-codex' }), turns }), 'e agora')
  assert.equal(result.resume, undefined)
  assert.ok(result.prompt.length < 200_000 + 2000, `ficou ${result.prompt.length}`)
  assert.ok(result.prompt.includes(HISTORY_OMITTED))
  assert.ok(result.prompt.includes('TURN 399'))
  assert.ok(!result.prompt.includes('TURN 0 '))
  assert.ok(result.prompt.endsWith('Nova mensagem do usuário:\ne agora'))
  // A single over-budget turn still yields a bounded string.
  const one = boundedTranscript([{ id: 'big', role: 'user', text: 'y'.repeat(600_000) }])
  assert.ok(one.length < 200_000 + HISTORY_OMITTED.length + 10)
  assert.ok(one.startsWith(HISTORY_OMITTED))
})

test('fresh chats pass prompts unchanged and remain isolated even with identical selections', () => {
  const a = chat({ turns: [{ id: '1', role: 'user', text: 'only chat A' }],
    resume: { route: routeKey(selection()), sessionId: 'session-a' } })
  const b = chat({ id: 'chat-b' })
  assert.deepEqual(continuationPrompt(b, 'hello'), { prompt: 'hello' })
  assert.deepEqual(continuationPrompt(a, 'hello'), { prompt: 'hello', resume: 'session-a' })
  b.turns.push({ id: '2', role: 'user', text: 'only chat B' })
  assert.ok(!continuationPrompt(b, 'next').prompt.includes('only chat A'))
  assert.equal(a.turns.length, 1)
})
