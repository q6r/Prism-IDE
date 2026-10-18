const { test } = require('node:test')
const assert = require('node:assert/strict')
const loadTypescript = require('./helpers/load-typescript.cjs')
const { ChatGrants, snapshotDelta, listEntry, sameEntry } = loadTypescript('src/main/ipc/remoteControlState.ts')

const counter = (prefix = 't') => { let n = 0; return () => `${prefix}${++n}` }
const turn = (id, extra = {}) => ({ id, role: 'assistant', text: id, ...extra })
const snap = (turns, extra = {}) => ({ tabId: 'c1', title: 'T', streaming: false, contextPct: 0, turns, ...extra })

/* ChatGrants */

test('grant: same token while shared, different per chat', () => {
  const g = new ChatGrants()
  const mint = counter()
  const a = g.grant('a', mint)
  assert.equal(g.grant('a', mint), a)
  const b = g.grant('b', mint)
  assert.notEqual(a, b)
  assert.equal(g.size, 2)
  assert.equal(g.has('a'), true)
  assert.equal(g.has('zzz'), false)
})

test('grant: colliding mint retries until unique', () => {
  const g = new ChatGrants()
  const seq = ['dup', 'dup', 'dup', 'fresh']
  let i = 0
  const mint = () => seq[Math.min(i++, seq.length - 1)]
  assert.equal(g.grant('a', mint), 'dup')
  assert.equal(g.grant('b', mint), 'fresh')
  assert.equal(g.chatFor('dup'), 'a')
  assert.equal(g.chatFor('fresh'), 'b')
})

test('chatFor resolves tokens and rejects the rest', () => {
  const g = new ChatGrants()
  const t = g.grant('a', counter())
  assert.equal(g.chatFor(t), 'a')
  assert.equal(g.chatFor(null), undefined)
  assert.equal(g.chatFor(undefined), undefined)
  assert.equal(g.chatFor(''), undefined)
  assert.equal(g.chatFor('unknown'), undefined)
})

test('revoke returns the token and invalidates it', () => {
  const g = new ChatGrants()
  const mint = counter()
  const t = g.grant('a', mint)
  g.grant('b', mint)
  assert.equal(g.revoke('a'), t)
  assert.equal(g.chatFor(t), undefined)
  assert.equal(g.has('a'), false)
  assert.equal(g.size, 1)
  assert.equal(g.has('b'), true)
  assert.equal(g.revoke('a'), undefined)
  assert.equal(g.revoke('never'), undefined)
})

test('re-grant after revoke mints a new token', () => {
  const g = new ChatGrants()
  const mint = counter()
  const first = g.grant('a', mint)
  g.revoke('a')
  const second = g.grant('a', mint)
  assert.notEqual(first, second)
  assert.equal(g.chatFor(first), undefined)
  assert.equal(g.chatFor(second), 'a')
})

test('clear drops everything', () => {
  const g = new ChatGrants()
  const t = g.grant('a', counter())
  g.grant('b', counter('x'))
  g.clear()
  assert.equal(g.size, 0)
  assert.equal(g.has('a'), false)
  assert.equal(g.chatFor(t), undefined)
})

/* snapshotDelta */

test('snapshotDelta without a previous snapshot sends everything', () => {
  const next = snap([turn('1'), turn('2')])
  const d = snapshotDelta(undefined, undefined, next)
  assert.equal(d.changed, true)
  assert.equal(d.metaChanged, true)
  assert.deepEqual(d.ids, ['1', '2'])
  assert.deepEqual(d.turns, next.turns)
  assert.deepEqual([...d.cache.keys()], ['1', '2'])
})

test('snapshotDelta: nothing changed', () => {
  const a = snap([turn('1'), turn('2')])
  const first = snapshotDelta(undefined, undefined, a)
  const b = snap([turn('1'), turn('2')])
  const d = snapshotDelta(a, first.cache, b)
  assert.equal(d.changed, false)
  assert.equal(d.metaChanged, false)
  assert.deepEqual(d.turns, [])
  assert.deepEqual(d.ids, ['1', '2'])
})

test('snapshotDelta: only the last turn changed', () => {
  const a = snap([turn('1'), turn('2')])
  const first = snapshotDelta(undefined, undefined, a)
  const b = snap([turn('1'), turn('2', { text: 'more' })])
  const d = snapshotDelta(a, first.cache, b)
  assert.equal(d.changed, true)
  assert.equal(d.metaChanged, false)
  assert.deepEqual(d.turns, [b.turns[1]])
  assert.deepEqual(d.ids, ['1', '2'])
})

test('snapshotDelta: appended turn is sent along with changed ones', () => {
  const a = snap([turn('1')])
  const first = snapshotDelta(undefined, undefined, a)
  const b = snap([turn('1'), turn('2')])
  const d = snapshotDelta(a, first.cache, b)
  assert.equal(d.changed, true)
  assert.deepEqual(d.turns.map((t) => t.id), ['2'])
  assert.deepEqual(d.ids, ['1', '2'])
})

test('snapshotDelta: removal or reorder is a change even with no changed turn', () => {
  const a = snap([turn('1'), turn('2'), turn('3')])
  const first = snapshotDelta(undefined, undefined, a)
  const removed = snapshotDelta(a, first.cache, snap([turn('1'), turn('3')]))
  assert.equal(removed.changed, true)
  assert.equal(removed.metaChanged, false)
  assert.deepEqual(removed.turns, [])
  assert.deepEqual(removed.ids, ['1', '3'])
  const reordered = snapshotDelta(a, first.cache, snap([turn('2'), turn('1'), turn('3')]))
  assert.equal(reordered.changed, true)
  assert.deepEqual(reordered.turns, [])
  assert.deepEqual(reordered.ids, ['2', '1', '3'])
})

test('snapshotDelta: title / streaming / contextPct are meta changes', () => {
  const a = snap([turn('1')])
  const { cache } = snapshotDelta(undefined, undefined, a)
  for (const extra of [{ title: 'New' }, { streaming: true }, { contextPct: 5 }]) {
    const d = snapshotDelta(a, cache, snap([turn('1')], extra))
    assert.equal(d.metaChanged, true, JSON.stringify(extra))
    assert.equal(d.changed, true)
    assert.deepEqual(d.turns, [])
  }
})

test('snapshotDelta: pending permission on a turn counts as that turn changing', () => {
  const a = snap([turn('1')])
  const { cache } = snapshotDelta(undefined, undefined, a)
  const b = snap([turn('1', { pendingPerm: { permId: 'p' } })])
  const d = snapshotDelta(a, cache, b)
  assert.equal(d.changed, true)
  assert.deepEqual(d.turns, b.turns)
})

test('snapshotDelta: returned cache feeds the next diff', () => {
  const s1 = snap([turn('1')])
  const d1 = snapshotDelta(undefined, undefined, s1)
  const s2 = snap([turn('1', { text: 'x' })])
  const d2 = snapshotDelta(s1, d1.cache, s2)
  assert.equal(d2.turns.length, 1)
  const d3 = snapshotDelta(s2, d2.cache, snap([turn('1', { text: 'x' })]))
  assert.equal(d3.changed, false)
  // a stale cache would still report the turn as changed
  const stale = snapshotDelta(s2, d1.cache, snap([turn('1', { text: 'x' })]))
  assert.equal(stale.turns.length, 1)
})

test('snapshotDelta: prev given but no cache sends all turns', () => {
  const a = snap([turn('1'), turn('2')])
  const d = snapshotDelta(a, undefined, snap([turn('1'), turn('2')]))
  assert.equal(d.changed, true)
  assert.equal(d.turns.length, 2)
  assert.equal(d.metaChanged, false)
})

/* listEntry / sameEntry */

test('listEntry', () => {
  assert.deepEqual(listEntry(snap([turn('1')], { title: 'X', streaming: true })), { tabId: 'c1', title: 'X', streaming: true, pending: false })
  assert.equal(listEntry(snap([turn('1'), turn('2', { pendingPerm: { permId: 'p' } })])).pending, true)
  assert.equal(listEntry(snap([turn('1', { pendingQuestion: { dialogId: 'd' } })])).pending, true)
  assert.equal(listEntry(snap([])).pending, false)
})

test('sameEntry', () => {
  const e = { tabId: 'c1', title: 'T', streaming: false, pending: false }
  assert.equal(sameEntry(undefined, e), false)
  assert.equal(sameEntry({ ...e }, e), true)
  assert.equal(sameEntry({ ...e, title: 'U' }, e), false)
  assert.equal(sameEntry({ ...e, streaming: true }, e), false)
  assert.equal(sameEntry({ ...e, pending: true }, e), false)
})
