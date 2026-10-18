const { test } = require('node:test')
const assert = require('node:assert/strict')
const loadTypescript = require('./helpers/load-typescript.cjs')
const M = loadTypescript('src/renderer/src/lib/remoteControlModel.ts', {
  '../../../shared/imageReferences': loadTypescript('src/shared/imageReferences.ts')
})

const user = (id, text) => ({ id, role: 'user', text })
const asst = (id, extra = {}) => ({ id, role: 'assistant', text: '', segments: [], ...extra })
const chat = (extra = {}) => ({ id: 'chat-1', title: 'My chat', turns: [], ...extra })
const perm = (extra = {}) => ({ permId: 'p1', toolName: 'Bash', title: 'Run it', displayName: 'Bash', description: 'why', input: { command: 'ls' }, ...extra })
const question = (extra = {}) => ({
  dialogId: 'd1',
  questions: [{ question: 'Q?', header: 'H', multiSelect: true, options: [{ label: 'A', description: 'da', extra: 1 }] }],
  ...extra
})

function spies(busyAfterSend = true) {
  const calls = []
  return {
    calls,
    act: {
      send: (t) => calls.push(['send', t]),
      stop: () => calls.push(['stop']),
      respondPermission: (d) => calls.push(['perm', d]),
      respondQuestion: (...args) => calls.push(['question', ...args]),
      isBusy: () => busyAfterSend
    }
  }
}

test('constants', () => {
  assert.equal(M.MAX_TURNS, 40)
  assert.equal(M.MAX_SEGMENTS, 40)
})

test('remote snapshot preserves native async question metadata without creating a blocking dialog', () => {
  const turn = asst('async-turn', { segments: [{ kind: 'text', toolId: 'async-call', text: '', questions: [
    { title: 'Qual uso está sem cálculo?', options: ['Tokens/contexto', 'Limites da conta', 'Os dois'] },
    { title: 'Detalhes', options: null }, { title: '', options: ['invalid'] }
  ] }] })
  const snapshot = M.buildRemoteSnapshot(chat({ turns: [turn] }))
  assert.deepEqual(snapshot.turns[0].segments[0], { kind: 'text', text: '', toolId: 'async-call', questions: [
    { title: 'Qual uso está sem cálculo?', options: ['Tokens/contexto', 'Limites da conta', 'Os dois'] }, { title: 'Detalhes' }
  ] })
  assert.equal(snapshot.turns[0].pendingQuestion, undefined)
})

test('mobile segment cap keeps the latest unanswered question and never revives a question followed by an answer', () => {
  const question = { kind: 'text', toolId: 'async-call', questions: [{ title: 'Qual uso?', options: ['Tokens', 'Limites'] }] }
  const tools = Array.from({ length: 50 }, (_, index) => ({ kind: 'tool', toolId: String(index), name: 'Bash', input: { command: 'echo' } }))
  const unanswered = M.remoteTurn(asst('turn', { segments: [question, ...tools] }))
  assert.equal(unanswered.segments.length, M.MAX_SEGMENTS)
  assert.equal(unanswered.segments[0].toolId, 'async-call')
  const answered = M.remoteTurn(asst('turn', { segments: [question, { kind: 'user', text: 'Tokens' }, ...tools] }))
  assert.equal(answered.segments.some(segment => segment.questions), false)
})

test('remoteTitle', () => {
  assert.equal(M.remoteTitle(chat({ title: ' Real ' })), 'Real')
  const long = 'hello\n  world   again ' + 'x'.repeat(50)
  const turns = [asst('a'), user('u', '  ' + long)]
  assert.equal(M.remoteTitle(chat({ title: 'Novo chat', turns })), ('hello world again ' + 'x'.repeat(50)).slice(0, 36))
  assert.equal(M.remoteTitle(chat({ title: '', turns })).startsWith('hello world again'), true)
  assert.equal(M.remoteTitle(chat({ title: 'Novo chat' })), 'Novo chat')
  assert.equal(M.remoteTitle(chat({ title: '' })), 'Chat')
  assert.equal(M.remoteTitle(chat({ title: undefined })), 'Chat')
})

test('toolPreview priority and shaping', () => {
  const all = { description: 'd', prompt: 'p', query: 'q', url: 'u', pattern: 'pa', command: 'c', path: 'pt', notebook_path: 'nb', file_path: 'fp' }
  const order = ['file_path', 'notebook_path', 'path', 'command', 'pattern', 'url', 'query', 'prompt', 'description']
  const input = { ...all }
  for (const key of order) {
    assert.equal(M.toolPreview(input), all[key], key)
    delete input[key]
  }
  assert.equal(M.toolPreview(input), '')
  assert.equal(M.toolPreview({ command: 'a  b\n\tc' }), 'a b c')
  assert.equal(M.toolPreview({ command: 'x'.repeat(200) }).length, 140)
  for (const v of [null, undefined, 'str', 5]) assert.equal(M.toolPreview(v), '')
})

test('permissionPreview', () => {
  assert.equal(M.permissionPreview({ input: { command: 'x'.repeat(700) } }).length, 600)
  assert.equal(M.permissionPreview({ input: { command: 'ls', file_path: '/a' } }), 'ls')
  assert.equal(M.permissionPreview({ input: { file_path: '/a', new_string: 'body' } }), '/a\nbody')
  assert.equal(M.permissionPreview({ input: { path: '/b', new_string: 'y'.repeat(600) } }), '/b\n' + 'y'.repeat(500))
  assert.equal(M.permissionPreview({ input: { file_path: '/a' } }), '/a')
  assert.equal(M.permissionPreview({ input: { content: 'c'.repeat(700) } }).length, 600)
  assert.equal(M.permissionPreview({ input: { foo: 'bar' } }), JSON.stringify({ foo: 'bar' }, null, 1))
  assert.equal(M.permissionPreview({ input: { big: 'z'.repeat(800) } }).length, 500)
  assert.equal(M.permissionPreview({ input: undefined }), '{}')
})

test('remoteStatus', () => {
  assert.equal(M.remoteStatus('running'), 'run')
  assert.equal(M.remoteStatus(undefined), 'run')
  assert.equal(M.remoteStatus('error'), 'err')
  for (const s of ['done', 'denied', 'awaiting']) assert.equal(M.remoteStatus(s), s)
})

test('remoteTurn: user turn', () => {
  assert.deepEqual(M.remoteTurn(user('u', 'hi')), { id: 'u', role: 'user', text: 'hi' })
  assert.deepEqual(M.remoteTurn({ id: 'u', role: 'user' }), { id: 'u', role: 'user', text: '' })
})

test('remoteTurn: segments mapped, truncated and capped', () => {
  const t = asst('a', {
    text: 'final',
    error: 'bad',
    segments: [
      { kind: 'thinking', text: 't'.repeat(1000) },
      { kind: 'text', text: 'x'.repeat(7000) },
      { kind: 'tool', name: 'Read', status: 'error', input: { file_path: '/a' } },
      { kind: 'tool', name: 'Bash', input: { command: 'ls' } },
      { kind: 'text' }
    ]
  })
  const r = M.remoteTurn(t)
  assert.equal(r.role, 'assistant')
  assert.equal(r.text, '')
  assert.equal(r.error, 'bad')
  assert.deepEqual(r.segments[0], { kind: 'text', text: 'final' })
  assert.equal(r.segments[1].text.length, 800)
  assert.equal(r.segments[2].text.length, 6000)
  assert.deepEqual(r.segments[3], { kind: 'tool', name: 'Read', status: 'err', preview: '/a' })
  assert.deepEqual(r.segments[4], { kind: 'tool', name: 'Bash', status: 'run', preview: 'ls' })
  assert.deepEqual(r.segments[5], { kind: 'text', text: '' })
  assert.equal(r.pendingPerm, undefined)
  assert.equal(r.pendingQuestion, undefined)

  const many = Array.from({ length: 55 }, (_, i) => ({ kind: 'text', text: 's' + i }))
  const capped = M.remoteTurn(asst('b', { segments: many }))
  assert.equal(capped.segments.length, 40)
  assert.equal(capped.segments[0].text, 's15')
  assert.equal(capped.segments[39].text, 's54')
  assert.deepEqual(M.remoteTurn({ id: 'c', role: 'assistant' }).segments, [])
})

test('remoteTurn: interrupted appends marker after the cap', () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ kind: 'text', text: 's' + i }))
  const r = M.remoteTurn(asst('a', { segments: many, interrupted: true }))
  assert.equal(r.segments.length, 41)
  assert.deepEqual(r.segments[40], { kind: 'text', text: '⏹ Tarefa interrompida.' })
})

test('remoteTurn: attaches pending permission and question from runtime', () => {
  const r = M.remoteTurn(asst('a'), { turnId: 'a', busy: true, permission: perm(), question: question() })
  assert.deepEqual(r.pendingPerm, { permId: 'p1', toolName: 'Bash', title: 'Run it', desc: 'why', preview: 'ls' })
  assert.deepEqual(r.pendingQuestion, {
    dialogId: 'd1',
    questions: [{ question: 'Q?', header: 'H', multiSelect: true, options: [{ label: 'A', description: 'da' }] }]
  })
  const fallback = M.remoteTurn(asst('a'), { permission: perm({ title: '' }) })
  assert.equal(fallback.pendingPerm.title, 'Bash')
})

test('buildRemoteSnapshot basics', () => {
  const snap = M.buildRemoteSnapshot(chat({ turns: [user('u', 'hi'), asst('a')] }), { turnId: 'a', busy: true })
  assert.equal(snap.tabId, 'chat-1')
  assert.equal(snap.title, 'My chat')
  assert.equal(snap.streaming, true)
  assert.equal(snap.contextPct, 0)
  assert.equal(snap.turns.length, 2)
  const idle = M.buildRemoteSnapshot(chat())
  assert.equal(idle.streaming, false)
  assert.deepEqual(idle.turns, [])
})

test('buildRemoteSnapshot keeps only the last 40 turns', () => {
  const turns = Array.from({ length: 50 }, (_, i) => user('u' + i, 't'))
  const snap = M.buildRemoteSnapshot(chat({ turns }))
  assert.equal(snap.turns.length, 40)
  assert.equal(snap.turns[0].id, 'u10')
  assert.equal(snap.turns[39].id, 'u49')
})

test('buildRemoteSnapshot attaches pending only to the running turn while busy', () => {
  const turns = [asst('old'), asst('cur')]
  const runtime = { turnId: 'cur', busy: true, permission: perm(), question: question() }
  const snap = M.buildRemoteSnapshot(chat({ turns }), runtime)
  assert.equal(snap.turns[0].pendingPerm, undefined)
  assert.equal(snap.turns[0].pendingQuestion, undefined)
  assert.equal(snap.turns[1].pendingPerm.permId, 'p1')
  assert.equal(snap.turns[1].pendingQuestion.dialogId, 'd1')
  const idle = M.buildRemoteSnapshot(chat({ turns }), { ...runtime, busy: false })
  for (const t of idle.turns) {
    assert.equal(t.pendingPerm, undefined)
    assert.equal(t.pendingQuestion, undefined)
  }
  const other = M.buildRemoteSnapshot(chat({ turns }), { ...runtime, turnId: 'zzz' })
  for (const t of other.turns) assert.equal(t.pendingPerm, undefined)
})

/* runRemoteCommand */

const busyRt = (extra = {}) => ({ turnId: 't1', busy: true, ...extra })

test('command: no chat', () => {
  const { act, calls } = spies()
  assert.deepEqual(M.runRemoteCommand(undefined, busyRt(), 'send', { text: 'x' }, act), { ok: false, reason: 'no-chat' })
  assert.equal(calls.length, 0)
})

test('command send: rejections never call the store', () => {
  const cases = [
    [chat(), undefined, { text: '' }, 'empty'],
    [chat(), undefined, { text: '   \n' }, 'empty'],
    [chat(), undefined, {}, 'empty'],
    [chat(), undefined, { text: 5 }, 'empty'],
    [chat({ readOnly: true }), undefined, { text: 'x' }, 'read-only'],
    [chat(), busyRt(), { text: 'x' }, 'busy']
  ]
  for (const [c, rt, payload, reason] of cases) {
    const { act, calls } = spies()
    assert.deepEqual(M.runRemoteCommand(c, rt, 'send', payload, act), { ok: false, reason })
    assert.equal(calls.length, 0, reason)
  }
})

test('command send: ok when the store starts a run, blocked otherwise', () => {
  const ok = spies(true)
  assert.deepEqual(M.runRemoteCommand(chat(), undefined, 'send', { text: '  hello  ' }, ok.act), { ok: true })
  assert.deepEqual(ok.calls, [['send', 'hello']])
  const blocked = spies(false)
  assert.deepEqual(M.runRemoteCommand(chat(), { turnId: '', busy: false }, 'send', { text: 'hi' }, blocked.act), { ok: false, reason: 'blocked' })
  assert.deepEqual(blocked.calls, [['send', 'hi']])
})

test('command stop', () => {
  const idle = spies()
  assert.deepEqual(M.runRemoteCommand(chat(), undefined, 'stop', {}, idle.act), { ok: false, reason: 'idle' })
  assert.deepEqual(M.runRemoteCommand(chat(), { turnId: 't', busy: false }, 'stop', {}, idle.act), { ok: false, reason: 'idle' })
  assert.equal(idle.calls.length, 0)
  const busy = spies()
  assert.deepEqual(M.runRemoteCommand(chat(), busyRt(), 'stop', {}, busy.act), { ok: true })
  assert.deepEqual(busy.calls, [['stop']])
})

test('command perm: invalid and gone cases never respond', () => {
  const rt = busyRt({ permission: perm() })
  const cases = [
    [rt, { decision: 'maybe', permId: 'p1' }, 'invalid'],
    [rt, { permId: 'p1' }, 'invalid'],
    [busyRt(), { decision: 'allow', permId: 'p1' }, 'gone'],
    [undefined, { decision: 'allow', permId: 'p1' }, 'gone'],
    [rt, { decision: 'allow', permId: 'other' }, 'gone'],
    [{ ...rt, busy: false }, { decision: 'allow', permId: 'p1' }, 'gone'],
    [rt, { decision: 'allow', permId: 'p1', turnId: 'stale' }, 'gone']
  ]
  for (const [runtime, payload, reason] of cases) {
    const { act, calls } = spies()
    assert.deepEqual(M.runRemoteCommand(chat(), runtime, 'perm', payload, act), { ok: false, reason }, reason)
    assert.equal(calls.length, 0, reason)
  }
})

test('command perm: valid decisions', () => {
  const rt = busyRt({ permission: perm() })
  for (const decision of ['allow', 'allow_always', 'deny']) {
    const { act, calls } = spies()
    assert.deepEqual(M.runRemoteCommand(chat(), rt, 'perm', { decision, permId: 'p1' }, act), { ok: true })
    assert.deepEqual(calls, [['perm', decision]])
  }
  const withTurn = spies()
  assert.deepEqual(M.runRemoteCommand(chat(), rt, 'perm', { decision: 'allow', permId: 'p1', turnId: 't1' }, withTurn.act), { ok: true })
})

test('command question: gone cases never respond', () => {
  const rt = busyRt({ question: question() })
  const cases = [
    [busyRt(), { dialogId: 'd1', answers: { 'Q?': 'A' } }],
    [rt, { dialogId: 'nope', answers: { 'Q?': 'A' } }],
    [{ ...rt, busy: false }, { dialogId: 'd1', answers: { 'Q?': 'A' } }],
    [rt, { dialogId: 'd1', answers: { 'Q?': 'A' }, turnId: 'stale' }],
    [rt, { dialogId: 'd1', cancelled: true, turnId: 'stale' }]
  ]
  for (const [runtime, payload] of cases) {
    const { act, calls } = spies()
    assert.deepEqual(M.runRemoteCommand(chat(), runtime, 'question', payload, act), { ok: false, reason: 'gone' })
    assert.equal(calls.length, 0)
  }
})

test('command question: cancelled, answers, response', () => {
  const rt = busyRt({ question: question() })
  const cancel = spies()
  assert.deepEqual(M.runRemoteCommand(chat(), rt, 'question', { dialogId: 'd1', cancelled: true }, cancel.act), { ok: true })
  assert.deepEqual(cancel.calls, [['question']])

  const empties = [{}, { answers: {} }, { answers: { a: '   ', b: 5 } }, { answers: ['x'] }, { answers: 'x' }, { answers: null }]
  for (const extra of empties) {
    const { act, calls } = spies()
    assert.deepEqual(M.runRemoteCommand(chat(), rt, 'question', { dialogId: 'd1', ...extra }, act), { ok: false, reason: 'empty' })
    assert.equal(calls.length, 0)
  }

  const good = spies()
  const res = M.runRemoteCommand(chat(), rt, 'question', {
    dialogId: 'd1', answers: { 'Q?': 'A', skip: '', num: 3 }, response: 'free text', turnId: 't1'
  }, good.act)
  assert.deepEqual(res, { ok: true })
  assert.deepEqual(good.calls, [['question', { 'Q?': 'A' }, 'free text']])

  const noResp = spies()
  for (const response of [undefined, '   ', 7]) {
    noResp.calls.length = 0
    M.runRemoteCommand(chat(), rt, 'question', { dialogId: 'd1', answers: { 'Q?': 'A' }, response }, noResp.act)
    assert.deepEqual(noResp.calls, [['question', { 'Q?': 'A' }, undefined]])
  }
})

test('command: unknown action', () => {
  const { act, calls } = spies()
  assert.deepEqual(M.runRemoteCommand(chat(), busyRt(), 'explode', {}, act), { ok: false, reason: 'unknown' })
  assert.equal(calls.length, 0)
})

test('remoteTurn: user text is cut at MAX_USER_TEXT with an ellipsis', () => {
  assert.equal(M.MAX_USER_TEXT, 4000)
  assert.equal(M.remoteTurn(user('u', 'x'.repeat(4000))).text, 'x'.repeat(4000))
  assert.equal(M.remoteTurn(user('u', 'x'.repeat(4001))).text, 'x'.repeat(4000) + '…')
})

test('remoteTurn: assistant text is not duplicated when segments exist', () => {
  const noText = M.remoteTurn(asst('a', { text: '   ', segments: [{ kind: 'text', text: 's' }] }))
  assert.equal(noText.text, '')
  assert.deepEqual(noText.segments, [{ kind: 'text', text: 's' }])
  const withText = M.remoteTurn(asst('a', { text: 'lead', segments: [{ kind: 'tool', name: 'Read', input: {} }] }))
  assert.equal(withText.text, '')
  assert.deepEqual(withText.segments.map((s) => s.kind), ['text', 'tool'])
  assert.equal(withText.segments[0].text, 'lead')
})

test('remoteTurn: assistant text without segments is cut at 6000 + ellipsis', () => {
  assert.equal(M.remoteTurn(asst('a', { text: 'hi' })).text, 'hi')
  assert.equal(M.remoteTurn(asst('a', { text: 'y'.repeat(6000) })).text, 'y'.repeat(6000))
  assert.equal(M.remoteTurn(asst('a', { text: 'y'.repeat(6001) })).text, 'y'.repeat(6000) + '…')
})

test('remoteTurn: leading text segment is subject to the segment cap', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ kind: 'text', text: 's' + i }))
  const r = M.remoteTurn(asst('a', { text: 'lead', segments: many }))
  assert.equal(r.segments.length, 40)
  assert.equal(r.segments[0].text, 's0')
  const few = M.remoteTurn(asst('a', { text: 'lead', segments: many.slice(0, 39) }))
  assert.equal(few.segments.length, 40)
  assert.equal(few.segments[0].text, 'lead')
})

test('remoteTurn: interrupted turn without anything else still has the marker segment and empty text', () => {
  const r = M.remoteTurn(asst('a', { text: 'partial', interrupted: true }))
  assert.equal(r.text, '')
  assert.deepEqual(r.segments, [{ kind: 'text', text: '⏹ Tarefa interrompida.' }])
})

test('toolPreview skips empty values and falls through', () => {
  assert.equal(M.toolPreview({ file_path: '', command: 'ls' }), 'ls')
  assert.equal(M.toolPreview({ file_path: '   ', pattern: 'p' }), 'p')
})

test('buildRemoteSnapshot: size budget keeps newest turns in chronological order', () => {
  assert.equal(M.MAX_SNAPSHOT_CHARS, 120000)
  const big = (id) => user(id, 'z'.repeat(3900))
  const turns = Array.from({ length: 40 }, (_, i) => big('u' + i))
  const snap = M.buildRemoteSnapshot(chat({ turns }))
  assert.ok(snap.turns.length < 40 && snap.turns.length > 1)
  assert.equal(snap.turns[snap.turns.length - 1].id, 'u39')
  const ids = snap.turns.map((t) => t.id)
  assert.deepEqual(ids, turns.slice(-ids.length).map((t) => t.id))
  const total = snap.turns.reduce((n, t) => n + JSON.stringify(t).length, 0)
  assert.ok(total <= M.MAX_SNAPSHOT_CHARS)
  // one more turn would have blown the budget
  const next = JSON.stringify(M.remoteTurn(turns[39 - ids.length])).length
  assert.ok(total + next > M.MAX_SNAPSHOT_CHARS)
})

test('buildRemoteSnapshot: the newest turn always fits even when oversized', () => {
  const huge = asst('new', { segments: Array.from({ length: 40 }, () => ({ kind: 'text', text: 'q'.repeat(6000) })) })
  const snap = M.buildRemoteSnapshot(chat({ turns: [user('u0', 'old'), user('u1', 'old2'), huge] }))
  assert.deepEqual(snap.turns.map((t) => t.id), ['new'])
})

test('command send: boolean from act.send decides over isBusy', () => {
  const accepted = spies(false)
  accepted.act.send = (t) => { accepted.calls.push(['send', t]); return true }
  assert.deepEqual(M.runRemoteCommand(chat(), undefined, 'send', { text: 'a' }, accepted.act), { ok: true })
  const refused = spies(true)
  refused.act.send = (t) => { refused.calls.push(['send', t]); return false }
  assert.deepEqual(M.runRemoteCommand(chat(), undefined, 'send', { text: 'a' }, refused.act), { ok: false, reason: 'blocked' })
  const viaBusy = spies(true)
  viaBusy.act.send = () => undefined
  assert.deepEqual(M.runRemoteCommand(chat(), undefined, 'send', { text: 'a' }, viaBusy.act), { ok: true })
})

test('mobile image labels use the full history before trimming and keep queued numbers', () => {
  const old = { ...user('old', 'old'), images: [{ mime: 'image/png', data: 'old' }] }
  const newest = { ...user('latest', 'latest'), images: [{ mime: 'image/png', data: 'latest' }] }
  const turns = [old, ...Array.from({ length: 40 }, (_, i) => user('u' + i, 'text')), newest]
  const snap = M.buildRemoteSnapshot(chat({ turns, queued: [{ id: 'future', text: 'later', images: [{ mime: 'image/png', data: 'future', number: 5 }] }] }))
  assert.equal(snap.turns.length, 40)
  assert.equal(snap.turns.at(-1).images[0].number, 2)
  assert.equal(snap.queued[0].images[0].number, 5)
  assert.equal(snap.turns.at(-1).images[0].data, undefined)
  assert.deepEqual(snap.turns.at(-1).images[0].ref, { turnId: 'latest', index: 0 })
})

test('mobile retains native subagents beyond the segment cap and removes duplicate spawn tools', () => {
  const agent = { id: 'native', chatId: 'child-not-shared', name: 'Auditar API', status: 'running', startedAt: 10, updatedAt: 20, spawnToolCallId: 'spawn-native',
    description: 'd'.repeat(2000), activity: 'a'.repeat(2000), summary: 's'.repeat(7000), model: 'model', token: 'must-not-copy-unknown-fields' }
  const segments = [{ kind: 'tool', name: 'spawn_agent', toolId: 'spawn-native', status: 'done' },
    { kind: 'tool', name: 'Agent', toolId: 'subagent:native', status: 'done', subagent: agent },
    ...Array.from({ length: 50 }, (_, i) => ({ kind: 'tool', toolId: 'tool-' + i, name: 'Bash', input: { command: 'echo' }, status: 'done' }))]
  const remote = M.remoteTurn(asst('parent-turn', { segments }))
  assert.equal(remote.segments.length, M.MAX_SEGMENTS)
  const cards = remote.segments.filter(s => s.subagent)
  assert.equal(cards.length, 1)
  assert.equal(cards[0].subagent.status, 'running', 'native status survives a completed parent tool')
  assert.equal(cards[0].subagent.name, 'Auditar API')
  assert.equal(cards[0].subagent.description.length, 1500)
  assert.equal(cards[0].subagent.activity.length, 1500)
  assert.equal(cards[0].subagent.summary.length, 6000)
  assert.equal(cards[0].subagent.token, undefined)
  assert.equal(remote.segments.some(s => s.name === 'spawn_agent'), false)
  assert.deepEqual(M.buildRemoteSnapshot(chat({ turns: [asst('p', { segments })] })).tabId, 'chat-1', 'snapshot remains scoped to the shared parent')
})
