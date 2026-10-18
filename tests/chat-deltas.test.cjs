const assert = require('node:assert/strict')
const test = require('node:test')
const load = require('./helpers/load-typescript.cjs')

const agents = load('src/shared/agents.ts')
const { foldJournal } = load('src/shared/agentJournal.ts', { './agents': agents, './subagents': load('src/shared/subagents.ts') })
const { applyChatDeltas } = load('src/shared/chatDeltas.ts')

const rt = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
const deepFreeze = (v) => {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); Object.values(v).forEach(deepFreeze) }
  return v
}
const sel = { provider: 'claude', profileId: 'p1', model: 'm' }
const mkTurn = (id, extra = {}) => ({ id, prompt: `q-${id}`, startedAt: 1000, segments: [], ...extra })
const mkChat = (id, extra = {}) => ({ id, title: id, selection: sel, turns: [], ...extra })
const apply = (chats, deltas, runtime = {}) => applyChatDeltas({ chats, runtime }, deltas)

test('chat: replaces by id, else appends at the end', () => {
  const a = mkChat('a'), b = mkChat('b')
  const r = apply([a, b], [{ op: 'chat', chat: mkChat('a', { title: 'new' }) }, { op: 'chat', chat: mkChat('c') }])
  assert.deepEqual(r.chats.map((c) => c.id), ['a', 'b', 'c'])
  assert.equal(r.chats[0].title, 'new')
  assert.equal(r.chats[1], b)
  assert.deepEqual(r.changed, ['a', 'c'])
})

test('remove: drops chat and runtime; unknown id is a no-op', () => {
  const a = mkChat('a'), b = mkChat('b')
  const runtime = { a: { busy: true }, b: { busy: false } }
  const r = apply([a, b], [{ op: 'remove', chatId: 'a' }], runtime)
  assert.deepEqual(r.chats, [b])
  assert.deepEqual(r.runtime, { b: { busy: false } })
  assert.deepEqual(r.changed, ['a'])
  assert.deepEqual(runtime, { a: { busy: true }, b: { busy: false } })
  const none = apply([a], [{ op: 'remove', chatId: 'zzz' }], runtime)
  assert.equal(none.chats.length, 1)
  assert.deepEqual(none.changed, [])
  const onlyRuntime = apply([], [{ op: 'remove', chatId: 'a' }], runtime)
  assert.deepEqual(onlyRuntime.changed, ['a'])
  assert.ok(!('a' in onlyRuntime.runtime))
})

test('patch: sets top-level fields, null deletes, turns/id ignored', () => {
  const t = mkTurn('t1')
  const a = mkChat('a', { turns: [t], title: 'old', pendingTurnId: 't1', resume: { route: 'x', sessionId: 's' } })
  const r = apply([a], [{ op: 'patch', chatId: 'a', patch: { title: 'new', pendingTurnId: null, turns: [], id: 'other', extra: 5 } }])
  const c = r.chats[0]
  assert.equal(c.title, 'new')
  assert.ok(!('pendingTurnId' in c))
  assert.equal(c.id, 'a')
  assert.equal(c.turns[0], t)
  assert.equal(c.extra, 5)
  assert.deepEqual(r.changed, ['a'])
  assert.equal(a.title, 'old')
  assert.equal(a.pendingTurnId, 't1')
})

test('turn: replaces by id, else appends', () => {
  const a = mkChat('a', { turns: [mkTurn('t1'), mkTurn('t2')] })
  const r = apply([a], [
    { op: 'turn', chatId: 'a', turn: mkTurn('t1', { prompt: 'edited' }) },
    { op: 'turn', chatId: 'a', turn: mkTurn('t3') }
  ])
  assert.deepEqual(r.chats[0].turns.map((t) => t.id), ['t1', 't2', 't3'])
  assert.equal(r.chats[0].turns[0].prompt, 'edited')
  assert.equal(r.chats[0].turns[1], a.turns[1])
})

test('append: extends last segment of same kind, else new segment', () => {
  const a = mkChat('a', { turns: [mkTurn('t1')] })
  const r = apply([a], [
    { op: 'append', chatId: 'a', turnId: 't1', kind: 'text', text: 'he' },
    { op: 'append', chatId: 'a', turnId: 't1', kind: 'text', text: 'llo' },
    { op: 'append', chatId: 'a', turnId: 't1', kind: 'thinking', text: 'hmm' },
    { op: 'append', chatId: 'a', turnId: 't1', kind: 'text', text: 'again' }
  ])
  assert.deepEqual(r.chats[0].turns[0].segments, [
    { kind: 'text', text: 'hello' }, { kind: 'thinking', text: 'hmm' }, { kind: 'text', text: 'again' }
  ])
  assert.deepEqual(a.turns[0].segments, [])
})

test('append: turn without segments array gets one', () => {
  const t = { id: 't1', prompt: 'q', startedAt: 1 }
  const r = apply([mkChat('a', { turns: [t] })], [{ op: 'append', chatId: 'a', turnId: 't1', kind: 'text', text: 'x' }])
  assert.deepEqual(r.chats[0].turns[0].segments, [{ kind: 'text', text: 'x' }])
})

test('segment: replaces by toolId, else adds (also without toolId)', () => {
  const a = mkChat('a', { turns: [mkTurn('t1')] })
  const r = apply([a], [
    { op: 'segment', chatId: 'a', turnId: 't1', segment: { kind: 'tool', toolId: 'x', status: 'running' } },
    { op: 'segment', chatId: 'a', turnId: 't1', segment: { kind: 'tool', toolId: 'x', status: 'done' } },
    { op: 'segment', chatId: 'a', turnId: 't1', segment: { kind: 'tool', status: 'done' } },
    { op: 'segment', chatId: 'a', turnId: 't1', segment: { kind: 'tool', status: 'done' } }
  ])
  assert.deepEqual(r.chats[0].turns[0].segments.map((s) => [s.toolId, s.status]), [['x', 'done'], [undefined, 'done'], [undefined, 'done']])
})

test('metrics: merges into the turn', () => {
  const a = mkChat('a', { turns: [mkTurn('t1', { metrics: { inputTokens: 1, outputTokens: 2 } })] })
  const r = apply([a], [{ op: 'metrics', chatId: 'a', turnId: 't1', metrics: { outputTokens: 9, costUsd: 3 } }])
  assert.deepEqual(r.chats[0].turns[0].metrics, { inputTokens: 1, outputTokens: 9, costUsd: 3 })
  assert.deepEqual(a.turns[0].metrics, { inputTokens: 1, outputTokens: 2 })
})

test('runtime: sets, replaces, null removes', () => {
  const r1 = apply([mkChat('a')], [{ op: 'runtime', chatId: 'a', runtime: { turnId: 't', route: 'r', busy: true } }])
  assert.deepEqual(r1.runtime, { a: { turnId: 't', route: 'r', busy: true } })
  assert.deepEqual(r1.changed, ['a'])
  const r2 = apply(r1.chats, [{ op: 'runtime', chatId: 'a', runtime: null }], r1.runtime)
  assert.deepEqual(r2.runtime, {})
  assert.deepEqual(r2.changed, ['a'])
  const r3 = apply([], [{ op: 'runtime', chatId: 'ghost', runtime: { turnId: 't', route: 'r', busy: false } }])
  assert.ok(r3.runtime.ghost)
})

test('deltas for missing chat or turn are ignored', () => {
  const a = mkChat('a', { turns: [mkTurn('t1')] })
  const state = { chats: [a], runtime: {} }
  const r = applyChatDeltas(state, [
    { op: 'patch', chatId: 'nope', patch: { title: 'x' } },
    { op: 'turn', chatId: 'nope', turn: mkTurn('t9') },
    { op: 'append', chatId: 'nope', turnId: 't1', kind: 'text', text: 'x' },
    { op: 'append', chatId: 'a', turnId: 'nope', kind: 'text', text: 'x' },
    { op: 'segment', chatId: 'a', turnId: 'nope', segment: { kind: 'tool', toolId: 'q' } },
    { op: 'metrics', chatId: 'a', turnId: 'nope', metrics: { costUsd: 1 } },
    { op: 'runtime', chatId: 'a', runtime: null }
  ])
  assert.deepEqual(r.changed, [])
  assert.equal(r.chats, state.chats)
  assert.equal(r.runtime, state.runtime)
})

test('immutability: frozen input and deltas, identity preserved, same refs when nothing changes', () => {
  const a = mkChat('a', { turns: [mkTurn('t1'), mkTurn('t2', { segments: [{ kind: 'text', text: 'x' }] })] })
  const b = mkChat('b', { turns: [mkTurn('t1')] })
  const chats = deepFreeze([a, b])
  const runtime = deepFreeze({ a: { turnId: 't', route: 'r', busy: true }, b: { turnId: 't', route: 'r', busy: true } })
  const deltas = deepFreeze([
    { op: 'append', chatId: 'a', turnId: 't2', kind: 'text', text: 'y' },
    { op: 'append', chatId: 'a', turnId: 't2', kind: 'text', text: 'z' },
    { op: 'segment', chatId: 'a', turnId: 't2', segment: { kind: 'tool', toolId: 'k', status: 'running' } },
    { op: 'segment', chatId: 'a', turnId: 't2', segment: { kind: 'tool', toolId: 'k', status: 'done' } },
    { op: 'metrics', chatId: 'a', turnId: 't2', metrics: { costUsd: 1 } },
    { op: 'patch', chatId: 'a', patch: { title: 'T' } },
    { op: 'runtime', chatId: 'b', runtime: null },
    { op: 'turn', chatId: 'a', turn: mkTurn('t3') }
  ])
  const snapshot = rt({ chats, runtime, deltas })
  const r = applyChatDeltas({ chats, runtime }, deltas)
  assert.deepEqual(rt({ chats, runtime, deltas }), snapshot)
  assert.equal(r.chats[1], b)
  assert.equal(r.chats[0].turns[0], a.turns[0])
  assert.notEqual(r.chats[0], a)
  assert.equal(r.chats[0].turns[1].segments[0].text, 'xyz')
  assert.equal(r.chats[0].turns[1].segments[1].status, 'done')
  assert.deepEqual(r.runtime, { a: runtime.a })
  assert.deepEqual(r.changed, ['a', 'b'])
  assert.notEqual(r.chats[0].turns[1].segments[1], deltas[3].segment)
  const empty = applyChatDeltas({ chats, runtime }, [])
  assert.equal(empty.chats, chats)
  assert.equal(empty.runtime, runtime)
  assert.deepEqual(empty.changed, [])
})

test('changed lists each chat once, in first-change order', () => {
  const r = apply([mkChat('a', { turns: [mkTurn('t')] }), mkChat('b')], [
    { op: 'patch', chatId: 'b', patch: { title: '1' } },
    { op: 'patch', chatId: 'a', patch: { title: '2' } },
    { op: 'patch', chatId: 'b', patch: { title: '3' } }
  ])
  assert.deepEqual(r.changed, ['b', 'a'])
})

// ---- equivalence with foldJournal ----

const route = 'claude:p1'
const T0 = 1000
const baseChat = () => mkChat('c', { pendingTurnId: 't1', lastRunId: 't1', turns: [mkTurn('t1', { startedAt: T0 })] })
const begin = { kind: 'begin', turn: mkTurn('t1', { startedAt: T0 }), route }
const seg = (toolId, name, status) => ({ kind: 'tool', toolId, name, status })

/** Each journal event paired with the delta the host sends for it (done/error end the turn separately). */
const streamed = [
  [begin, { op: 'turn', chatId: 'c', turn: mkTurn('t1', { startedAt: T0, segments: [] }) }],
  [{ kind: 'session', sessionId: 'S1' }, { op: 'patch', chatId: 'c', patch: { resume: { route, sessionId: 'S1' } } }],
  [{ kind: 'thinking', text: 'hm' }, { op: 'append', chatId: 'c', turnId: 't1', kind: 'thinking', text: 'hm' }],
  [{ kind: 'thinking', text: 'm' }, { op: 'append', chatId: 'c', turnId: 't1', kind: 'thinking', text: 'm' }],
  [{ kind: 'text', text: 'Hel' }, { op: 'append', chatId: 'c', turnId: 't1', kind: 'text', text: 'Hel' }],
  [{ kind: 'text', text: 'lo' }, { op: 'append', chatId: 'c', turnId: 't1', kind: 'text', text: 'lo' }],
  [{ kind: 'segment', segment: seg('x', 'Read', 'running') }, { op: 'segment', chatId: 'c', turnId: 't1', segment: seg('x', 'Read', 'running') }],
  [{ kind: 'metrics', metrics: { inputTokens: 5 } }, { op: 'metrics', chatId: 'c', turnId: 't1', metrics: { inputTokens: 5 } }],
  [{ kind: 'segment', segment: seg('x', 'Read', 'done') }, { op: 'segment', chatId: 'c', turnId: 't1', segment: seg('x', 'Read', 'done') }],
  [{ kind: 'text', text: ' more' }, { op: 'append', chatId: 'c', turnId: 't1', kind: 'text', text: ' more' }],
  [{ kind: 'segment', segment: seg('y', 'Bash', 'running') }, { op: 'segment', chatId: 'c', turnId: 't1', segment: seg('y', 'Bash', 'running') }],
  [{ kind: 'metrics', metrics: { outputTokens: 7, inputTokens: 6 } },
    { op: 'metrics', chatId: 'c', turnId: 't1', metrics: { outputTokens: 7, inputTokens: 6 } }]
]

test('equivalence: every prefix of the streamed events matches foldJournal', () => {
  for (let n = 1; n <= streamed.length; n++) {
    const part = streamed.slice(0, n)
    const folded = foldJournal(baseChat(), part.map(([event]) => ({ turnId: 't1', event })))
    const applied = apply([baseChat()], part.map(([, d]) => d)).chats[0]
    assert.deepEqual(rt(applied.turns), rt(folded.turns), `prefix ${n}`)
    assert.deepEqual(rt(applied.resume), rt(folded.resume), `prefix ${n} resume`)
  }
})

const endings = {
  done: {
    event: { kind: 'done', at: T0 + 500 },
    fields: { completedAt: T0 + 500, durationMs: 500, error: false, interrupted: false },
    status: 'done',
    resume: { route, sessionId: 'S1' }
  },
  aborted: {
    event: { kind: 'done', aborted: true, at: T0 + 300 },
    fields: { completedAt: T0 + 300, durationMs: 300, error: false, interrupted: true },
    status: 'error',
    resume: undefined
  },
  error: {
    event: { kind: 'error', message: 'boom', at: T0 + 200 },
    fields: { completedAt: T0 + 200, durationMs: 200, error: true, interrupted: false },
    status: 'error',
    extra: { kind: 'text', text: 'boom' },
    resume: undefined
  }
}

for (const [name, end] of Object.entries(endings)) {
  test(`equivalence: full turn ending in ${name}`, () => {
    const events = [...streamed.map(([e]) => e), end.event]
    const folded = foldJournal(baseChat(), events.map((event) => ({ turnId: 't1', event })))
    // What the host sends at the end: the final turn, then patch {pendingTurnId: null, resume}.
    const before = apply([baseChat()], streamed.map(([, d]) => d)).chats[0].turns[0]
    const segments = before.segments.map((s) => (s.status === 'running' || s.status === 'awaiting' ? { ...s, status: end.status } : s))
    if (end.extra) segments.push(end.extra)
    const finalTurn = { ...before, ...end.fields, segments }
    const deltas = [
      ...streamed.map(([, d]) => d),
      { op: 'turn', chatId: 'c', turn: finalTurn },
      { op: 'patch', chatId: 'c', patch: { pendingTurnId: null, resume: end.resume ?? null } }
    ]
    const applied = apply([baseChat()], deltas).chats[0]
    assert.deepEqual(rt(applied.turns), rt(folded.turns))
    assert.deepEqual(rt(applied.resume), rt(folded.resume))
    assert.equal(applied.pendingTurnId, folded.pendingTurnId)
    assert.equal('pendingTurnId' in applied, false)
    assert.equal(applied.turns[0].segments.find((s) => s.toolId === 'y').status, end.status)
  })
}

test('equivalence: begin resets segments even if the turn arrived with some', () => {
  const folded = foldJournal(baseChat(), [{ turnId: 't1', event: { ...begin, turn: mkTurn('t1', { segments: [{ kind: 'text', text: 'stale' }] }) } }])
  const applied = apply([baseChat()], [{ op: 'turn', chatId: 'c', turn: mkTurn('t1', { segments: [] }) }]).chats[0]
  assert.deepEqual(rt(applied.turns), rt(folded.turns))
})
