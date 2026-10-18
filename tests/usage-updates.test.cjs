const test = require('node:test')
const assert = require('node:assert/strict')
const load = require('./helpers/load-typescript.cjs')
const { usageRecordsChanged, followUsageUpdates } = load('src/renderer/src/lib/usageUpdates.ts')

const turn = (id, completedAt, metrics) => ({ id, role: 'assistant', text: '', completedAt, metrics })
const chat = turns => ({ id: 'a', turns })
const state = (turns, runtime = { a: { busy: true, turnId: 'one' } }) => ({ chats: [chat(turns)], runtime })

test('a queued turn finishing reloads records when the next queued turn already started', () => {
  const before = state([turn('one')])
  const next = state([turn('one', 50), { id: 'user-two', role: 'user' }, turn('two')], { a: { busy: true, turnId: 'two' } })
  assert.equal(usageRecordsChanged(next, before), true)
  assert.equal(Object.values(next.runtime).filter(row => row.busy).length, Object.values(before.runtime).filter(row => row.busy).length)
})

test('one chat ending and another starting in the same batch reloads records', () => {
  const before = state([turn('one')], { a: { busy: true, turnId: 'one' }, b: { busy: false, turnId: 'old' } })
  const next = state([turn('one', 80)], { a: { busy: false, turnId: 'one' }, b: { busy: true, turnId: 'new' } })
  assert.equal(usageRecordsChanged(next, before), true)
})

test('completion metadata and late final metrics reload without requiring a runtime update', () => {
  const metrics = { turn: { inputTokens: 20 } }
  const before = state([turn('one', undefined, metrics)])
  const completed = state([turn('one', 50, metrics)], before.runtime)
  assert.equal(usageRecordsChanged(completed, before), true)
  const late = state([turn('one', 50, { turn: { inputTokens: 30 } })], before.runtime)
  assert.equal(usageRecordsChanged(late, completed), true)
})

test('streaming metrics and drafts leave usage records alone until the turn finishes', () => {
  const before = state([turn('one', undefined, { inputTokens: 1 })])
  const streaming = state([turn('one', undefined, { inputTokens: 2 })], before.runtime)
  assert.equal(usageRecordsChanged(streaming, before), false)
  const metrics = { turn: { inputTokens: 2 } }
  const completed = state([turn('one', 50, metrics)], { a: { busy: false, turnId: 'one' } })
  const draft = { ...completed, chats: [{ ...completed.chats[0], draft: 'next message' }] }
  assert.equal(usageRecordsChanged(draft, completed), false)
})

test('finishing batches coalesce and unmount cancels a pending refresh', async () => {
  let listener, refreshed = 0, off = 0
  const subscribe = callback => { listener = callback; return () => { listener = undefined; off++ } }
  const stop = followUsageUpdates(subscribe, () => refreshed++, 5)
  const before = state([turn('one')])
  const completed = state([turn('one', 50)], { a: { busy: false, turnId: 'one' } })
  listener(completed, before)
  listener(completed, before)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(refreshed, 1)
  listener(completed, before)
  stop()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(refreshed, 1)
  assert.equal(off, 1)
})
