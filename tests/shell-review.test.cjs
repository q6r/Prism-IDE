const { test } = require('node:test')
const assert = require('node:assert/strict')
const load = require('./helpers/load-typescript.cjs')

function fixture() {
  return load('src/renderer/src/components/shell/branchWatcher.ts')
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// watchBranch

test('watchBranch: reads immediately when the pane starts visible', async () => {
  const m = fixture()
  let calls = 0
  const updates = []
  const cleanup = m.watchBranch({
    read: async () => { calls++; return 'main' },
    update: (b) => updates.push(b),
    isVisible: () => true,
    onVisibilityChange: () => () => {}
  })
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(calls, 1)
  assert.deepEqual(updates, ['main'])
  cleanup()
})

test('watchBranch: does not read while the pane starts hidden', async () => {
  const m = fixture()
  let calls = 0
  const cleanup = m.watchBranch({
    read: async () => { calls++; return 'main' },
    update: () => {},
    isVisible: () => false,
    onVisibilityChange: () => () => {}
  })
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(calls, 0)
  cleanup()
})

test('watchBranch: the interval stops while hidden and resumes with an immediate read once visible again', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const m = fixture()
  let calls = 0
  let visible = true
  let onChange
  const cleanup = m.watchBranch({
    read: async () => { calls++; return `b${calls}` },
    update: () => {},
    isVisible: () => visible,
    onVisibilityChange: (listener) => { onChange = listener; return () => {} },
    every: 1000
  })
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(calls, 1)

  t.mock.timers.tick(1000)
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(calls, 2)

  visible = false
  onChange()
  t.mock.timers.tick(5000)
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(calls, 2, 'no reads should happen once the interval is torn down while hidden')

  visible = true
  onChange()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(calls, 3, 'becoming visible again triggers an immediate read, not just a restarted timer')

  cleanup()
})

test('watchBranch: never runs a second read while one is still in flight', async () => {
  const m = fixture()
  let calls = 0
  const first = deferred()
  const read = () => {
    calls++
    return calls === 1 ? first.promise : Promise.resolve(`b${calls}`)
  }
  let visible = true
  let onChange
  const cleanup = m.watchBranch({
    read,
    update: () => {},
    isVisible: () => visible,
    onVisibilityChange: (listener) => { onChange = listener; return () => {} }
  })
  await Promise.resolve()
  assert.equal(calls, 1)

  // Toggling visibility while the first read is still pending must not start another one.
  onChange()
  onChange()
  await Promise.resolve()
  assert.equal(calls, 1, 'a second refresh must not start while the first is still in flight')

  first.resolve('b1')
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(calls, 1, 'the in-flight guard only releases after the pending read settles')

  cleanup()
})

test('watchBranch: disposing while a read is in flight discards its result and detaches the visibility listener', async () => {
  const m = fixture()
  const pending = deferred()
  const updates = []
  let offCalled = false
  const cleanup = m.watchBranch({
    read: () => pending.promise,
    update: (b) => updates.push(b),
    isVisible: () => true,
    onVisibilityChange: () => { return () => { offCalled = true } }
  })
  await Promise.resolve()
  cleanup()
  assert.equal(offCalled, true)

  pending.resolve('too-late')
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(updates, [], 'a result that arrives after dispose must never reach update()')
})

test('watchBranch: a failed read keeps the last successful update, and the next tick recovers', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const m = fixture()
  const updates = []
  let call = 0
  const read = async () => {
    call++
    if (call === 2) throw new Error('transient failure')
    return `ok${call}`
  }
  const cleanup = m.watchBranch({
    read,
    update: (b) => updates.push(b),
    isVisible: () => true,
    onVisibilityChange: () => () => {},
    every: 100
  })
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(updates, ['ok1'])

  t.mock.timers.tick(100)
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(updates, ['ok1'], 'the errored read must not clear or overwrite the last good value')

  t.mock.timers.tick(100)
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(updates, ['ok1', 'ok3'], 'a later successful read resumes updating normally')

  cleanup()
})

test('watchBranch: cleanup stops the timer so no further reads happen after dispose', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const m = fixture()
  let calls = 0
  const cleanup = m.watchBranch({
    read: async () => { calls++; return `b${calls}` },
    update: () => {},
    isVisible: () => true,
    onVisibilityChange: () => () => {},
    every: 50
  })
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(calls, 1)

  cleanup()
  t.mock.timers.tick(500)
  await Promise.resolve()
  assert.equal(calls, 1, 'no interval tick should fire after cleanup')
})
