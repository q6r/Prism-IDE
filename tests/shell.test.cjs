const { test } = require('node:test')
const assert = require('node:assert/strict')
const load = require('./helpers/load-typescript.cjs')

function fixture() {
  return load('src/renderer/src/components/shell/logic.ts')
}

// matchRanges

test('matchRanges: empty query returns no ranges', () => {
  const m = fixture()
  assert.deepEqual(m.matchRanges('hello world', '', true), [])
})

test('matchRanges: single literal match reports correct start/end offsets', () => {
  const m = fixture()
  const result = m.matchRanges('hello world', 'world', true)
  assert.deepEqual(result, [{ start: 6, end: 11 }])
})

test('matchRanges: multiple non-overlapping matches are all reported in order', () => {
  const m = fixture()
  const result = m.matchRanges('abcabcabc', 'abc', true)
  assert.deepEqual(result, [
    { start: 0, end: 3 },
    { start: 3, end: 6 },
    { start: 6, end: 9 }
  ])
})

test('matchRanges: case-sensitive search does not match differently-cased text', () => {
  const m = fixture()
  assert.deepEqual(m.matchRanges('Hello World', 'hello', true), [])
})

test('matchRanges: case-insensitive search matches differently-cased text', () => {
  const m = fixture()
  assert.deepEqual(m.matchRanges('Hello World', 'hello', false), [{ start: 0, end: 5 }])
})

test('matchRanges: case-insensitive search folds accented Unicode letters', () => {
  const m = fixture()
  assert.deepEqual(m.matchRanges('café CAFÉ', 'café', false), [
    { start: 0, end: 4 },
    { start: 5, end: 9 }
  ])
})

test('matchRanges: regex special characters in the query are treated as literal text', () => {
  const m = fixture()
  const query = 'a.b*c+d?e^f$g(h)i[j]k{l}m|n\\o'
  const text = `prefix ${query} suffix`
  const result = m.matchRanges(text, query, true)
  assert.deepEqual(result, [{ start: 7, end: 7 + query.length }])
})

test('matchRanges: no match for a query absent from the text returns an empty array', () => {
  const m = fixture()
  assert.deepEqual(m.matchRanges('hello world', 'xyz', true), [])
})

test('matchRanges: offsets stay correct across a preceding surrogate-pair character', () => {
  const m = fixture()
  const text = '😀needle'
  const result = m.matchRanges(text, 'needle', true)
  assert.deepEqual(result, [{ start: 2, end: 8 }])
  assert.equal(text.slice(result[0].start, result[0].end), 'needle')
})

test('matchRanges: a surrogate-pair query matches as a single unit with correct length', () => {
  const m = fixture()
  const text = 'before😀after'
  const result = m.matchRanges(text, '😀', true)
  assert.deepEqual(result, [{ start: 6, end: 8 }])
})

// relativeTime

test('relativeTime: a timestamp less than a minute in the past is "agora"', () => {
  const m = fixture()
  const now = 1_000_000
  assert.equal(m.relativeTime(now - 1, now), 'agora')
  assert.equal(m.relativeTime(now - 59_999, now), 'agora')
})

test('relativeTime: a future timestamp clamps to "agora" instead of going negative', () => {
  const m = fixture()
  const now = 1_000_000
  assert.equal(m.relativeTime(now + 500_000, now), 'agora')
})

test('relativeTime: exactly one minute in the past reports "1m"', () => {
  const m = fixture()
  const now = 1_000_000
  assert.equal(m.relativeTime(now - 60_000, now), '1m')
})

test('relativeTime: just under the hour boundary still reports minutes', () => {
  const m = fixture()
  const now = 1_000_000
  assert.equal(m.relativeTime(now - 59 * 60_000, now), '59m')
})

test('relativeTime: exactly one hour in the past reports "1h"', () => {
  const m = fixture()
  const now = 1_000_000
  assert.equal(m.relativeTime(now - 60 * 60_000, now), '1h')
})

test('relativeTime: just under the day boundary still reports hours', () => {
  const m = fixture()
  const now = 1_000_000
  assert.equal(m.relativeTime(now - 23 * 60 * 60_000, now), '23h')
})

test('relativeTime: exactly one day in the past reports "1d"', () => {
  const m = fixture()
  const now = 1_000_000
  assert.equal(m.relativeTime(now - 24 * 60 * 60_000, now), '1d')
})

test('relativeTime: just under the 30-day boundary still reports days', () => {
  const m = fixture()
  const now = 1_000_000
  assert.equal(m.relativeTime(now - 29 * 24 * 60 * 60_000, now), '29d')
})

test('relativeTime: 30 or more days in the past falls back to a localized date', () => {
  const m = fixture()
  const now = 1_000_000
  const ms = now - 30 * 24 * 60 * 60_000
  const expected = new Date(ms).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })
  assert.equal(m.relativeTime(ms, now), expected)
})

test('relativeTime: defaults `now` to the current time when omitted', () => {
  const m = fixture()
  assert.equal(m.relativeTime(Date.now()), 'agora')
})

// workspacePathKey

test('workspacePathKey: null path becomes an empty string', () => {
  const m = fixture()
  assert.equal(m.workspacePathKey(null), '')
})

test('workspacePathKey: empty string path stays empty', () => {
  const m = fixture()
  assert.equal(m.workspacePathKey(''), '')
})

test('workspacePathKey: backslashes are normalized to forward slashes', () => {
  const m = fixture()
  assert.equal(m.workspacePathKey('C:\\Users\\dev\\project'), 'c:/users/dev/project')
})

test('workspacePathKey: a single trailing slash is stripped', () => {
  const m = fixture()
  assert.equal(m.workspacePathKey('/home/dev/project/'), '/home/dev/project')
})

test('workspacePathKey: multiple trailing slashes are all stripped', () => {
  const m = fixture()
  assert.equal(m.workspacePathKey('/home/dev/project///'), '/home/dev/project')
})

test('workspacePathKey: a trailing backslash is normalized then stripped', () => {
  const m = fixture()
  assert.equal(m.workspacePathKey('C:\\Users\\dev\\project\\'), 'c:/users/dev/project')
})

test('workspacePathKey: mixed trailing slashes and backslashes are all stripped', () => {
  const m = fixture()
  assert.equal(m.workspacePathKey('C:\\Users\\dev\\project/\\/'), 'c:/users/dev/project')
})

test('workspacePathKey: a path made entirely of separators collapses to an empty string', () => {
  const m = fixture()
  assert.equal(m.workspacePathKey('///'), '')
  assert.equal(m.workspacePathKey('\\\\\\'), '')
})

test('workspacePathKey: leading slashes are preserved, only trailing ones are stripped', () => {
  const m = fixture()
  assert.equal(m.workspacePathKey('//home/dev/'), '//home/dev')
})

test('workspacePathKey: result is lowercased regardless of input case', () => {
  const m = fixture()
  assert.equal(m.workspacePathKey('C:\\USERS\\DEV\\Project'), 'c:/users/dev/project')
})

test('workspacePathKey: two paths differing only by case, separator style, or trailing slash produce the same key', () => {
  const m = fixture()
  const a = m.workspacePathKey('C:\\Users\\Dev\\Project')
  const b = m.workspacePathKey('c:/users/dev/project/')
  assert.equal(a, b)
})

// fuzzyScore

test('fuzzyScore: an empty query scores 1 regardless of text', () => {
  const m = fixture()
  assert.equal(m.fuzzyScore('', 'anything'), 1)
  assert.equal(m.fuzzyScore('', ''), 1)
})

test('fuzzyScore: a character missing from the text returns -1', () => {
  const m = fixture()
  assert.equal(m.fuzzyScore('xyz', 'abc'), -1)
})

test('fuzzyScore: characters out of order are not a match', () => {
  const m = fixture()
  assert.equal(m.fuzzyScore('ba', 'ab'), -1)
})

test('fuzzyScore: matches are case-insensitive', () => {
  const m = fixture()
  assert.equal(m.fuzzyScore('ABC', 'abc'), m.fuzzyScore('abc', 'abc'))
})

test('fuzzyScore: a fully consecutive match scores higher than the same letters scattered', () => {
  const m = fixture()
  const consecutive = m.fuzzyScore('abc', 'abc')
  const scattered = m.fuzzyScore('abc', 'a_b_c')
  assert.equal(consecutive, 15)
  assert.equal(scattered, 6)
  assert.ok(consecutive > scattered)
})

test('fuzzyScore: a longer consecutive run scores strictly higher than a shorter one, growing with streak length', () => {
  const m = fixture()
  assert.equal(m.fuzzyScore('abc', 'xabc'), 10)
})

test('fuzzyScore: a repeated query character greedily consumes the earliest remaining occurrence', () => {
  const m = fixture()
  assert.equal(m.fuzzyScore('aa', 'aba'), 5)
})

test('fuzzyScore: a surrogate-pair character in the query matches as a single unit and advances position past both code units', () => {
  const m = fixture()
  assert.equal(m.fuzzyScore('😀', '😀'), 4)
  assert.equal(m.fuzzyScore('😀a', '😀ab'), 9)
  assert.equal(m.fuzzyScore('xa', 'xab'), 9)
})

// sshPort

test('sshPort: a blank or whitespace-only value defaults to port 22', () => {
  const m = fixture()
  assert.equal(m.sshPort(''), 22)
  assert.equal(m.sshPort('   '), 22)
})

test('sshPort: in-range integer strings are parsed, including the 1 and 65535 boundaries', () => {
  const m = fixture()
  assert.equal(m.sshPort('22'), 22)
  assert.equal(m.sshPort('1'), 1)
  assert.equal(m.sshPort('65535'), 65535)
})

test('sshPort: values just outside the valid range are invalid', () => {
  const m = fixture()
  assert.equal(m.sshPort('0'), null)
  assert.equal(m.sshPort('65536'), null)
  assert.equal(m.sshPort('-1'), null)
})

test('sshPort: a non-integer numeric string is invalid', () => {
  const m = fixture()
  assert.equal(m.sshPort('22.5'), null)
})

test('sshPort: non-numeric text is invalid', () => {
  const m = fixture()
  assert.equal(m.sshPort('abc'), null)
})

test('sshPort: surrounding whitespace around a valid number is tolerated', () => {
  const m = fixture()
  assert.equal(m.sshPort('  443  '), 443)
})

test('sshPort: Infinity is numeric but not an integer, so it is invalid', () => {
  const m = fixture()
  assert.equal(m.sshPort('Infinity'), null)
})

// attentionKey

test('attentionKey: stays stable across transcript/busy/turnId deltas unrelated to attention state', () => {
  const m = fixture()
  const runtime = { a: { permission: { id: 'p1' } } }
  const before = m.attentionKey(
    [{ id: 'a', title: 'A', transcript: ['x'], busy: true, turnId: 1 }, { id: 'b', title: 'B' }],
    runtime
  )
  const after = m.attentionKey(
    [{ id: 'a', title: 'A', transcript: ['x', 'y'], busy: false, turnId: 7 }, { id: 'b', title: 'B' }],
    runtime
  )
  assert.equal(before, after)
})

test('attentionKey: changes when a chat gains or loses a pending permission or question', () => {
  const m = fixture()
  const chats = [{ id: 'a', title: 'A' }]
  const idle = m.attentionKey(chats, {})
  const withPermission = m.attentionKey(chats, { a: { permission: { id: 'p1' } } })
  assert.notEqual(idle, withPermission)
  assert.equal(idle, '[]')
})

test('attentionKey: permission and question are reported as distinct kinds, changing the key when one replaces the other', () => {
  const m = fixture()
  const chats = [{ id: 'a', title: 'A' }]
  const withPermission = m.attentionKey(chats, { a: { permission: { id: 'p1' } } })
  const withQuestion = m.attentionKey(chats, { a: { question: { id: 'q1' } } })
  assert.notEqual(withPermission, withQuestion)
  assert.match(withPermission, /"kind":"permission"/)
  assert.match(withQuestion, /"kind":"question"/)
})

test('attentionKey: changes when the title of a chat with pending attention changes', () => {
  const m = fixture()
  const runtime = { a: { question: { id: 'q1' } } }
  const before = m.attentionKey([{ id: 'a', title: 'Old title' }], runtime)
  const after = m.attentionKey([{ id: 'a', title: 'New title' }], runtime)
  assert.notEqual(before, after)
})

test('attentionKey: changes when a chat with pending attention is removed from the list', () => {
  const m = fixture()
  const runtime = { a: { permission: { id: 'p1' } } }
  const before = m.attentionKey([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }], runtime)
  const after = m.attentionKey([{ id: 'b', title: 'B' }], runtime)
  assert.notEqual(before, after)
  assert.equal(after, '[]')
})

test('attentionKey: a chat with no title falls back to the "Conversa" placeholder', () => {
  const m = fixture()
  const key = m.attentionKey([{ id: 'a' }], { a: { permission: { id: 'p1' } } })
  assert.match(key, /"title":"Conversa"/)
})

// saveBeforeClose

test('saveBeforeClose: closes only after save resolves and isSaved confirms true', async () => {
  const m = fixture()
  const calls = []
  await m.saveBeforeClose('/tmp/file.txt', {
    save: async (path) => { calls.push(`save:${path}`) },
    isSaved: () => true,
    close: (path) => calls.push(`close:${path}`)
  })
  assert.deepEqual(calls, ['save:/tmp/file.txt', 'close:/tmp/file.txt'])
})

test('saveBeforeClose: rejects and does not close when save resolves but isSaved reports false', async () => {
  const m = fixture()
  let closed = false
  await assert.rejects(
    m.saveBeforeClose('/tmp/file.txt', {
      save: async () => {},
      isSaved: () => false,
      close: () => { closed = true }
    }),
    /Não foi possível salvar/
  )
  assert.equal(closed, false)
})

test('saveBeforeClose: a rejected save propagates its error and does not close', async () => {
  const m = fixture()
  let closed = false
  await assert.rejects(
    m.saveBeforeClose('/tmp/file.txt', {
      save: async () => { throw new Error('disk full') },
      isSaved: () => true,
      close: () => { closed = true }
    }),
    /disk full/
  )
  assert.equal(closed, false)
})

test('saveBeforeClose: an asynchronous save delay does not close before it settles', async () => {
  const m = fixture()
  const order = []
  const slowSave = () => new Promise((resolve) => setTimeout(() => { order.push('saved'); resolve() }, 5))
  await m.saveBeforeClose('/tmp/file.txt', {
    save: slowSave,
    isSaved: () => true,
    close: () => order.push('closed')
  })
  assert.deepEqual(order, ['saved', 'closed'])
})
