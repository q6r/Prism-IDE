const { test } = require('node:test')
const assert = require('node:assert/strict')
const load = require('./helpers/load-typescript.cjs')

function fakeZustand() {
  return { create: (init) => {
    let state
    const set = (p) => { state = { ...state, ...(typeof p === 'function' ? p(state) : p) } }
    const get = () => state
    state = init(set, get)
    const hook = () => state
    hook.getState = get
    return hook
  } }
}

function setup() {
  const saved = { window: global.window, now: Date.now }
  let clock = 1_000_000
  Date.now = () => clock
  let fetches = 0
  let pending = []
  global.window = { prism: { providers: {
    details: () => { fetches++; return new Promise((r) => pending.push(() => r({ limits: [] }))) },
    status: async () => ({ installed: true, loggedIn: true })
  } } }
  const { useProviderUsage } = load('src/renderer/src/lib/providerUsage.ts', { zustand: fakeZustand() })
  const settle = async () => { const p = pending; pending = []; p.forEach((f) => f()); for (let i = 0; i < 10; i++) await Promise.resolve() }
  return { useProviderUsage, advance: (ms) => { clock += ms }, settle, fetches: () => fetches,
    restore: () => { global.window = saved.window; Date.now = saved.now } }
}
const profile = { id: 'p', provider: 'claude' }

test('ensure paces from the start of the fetch: a 60s poll with a 3s fetch refreshes every tick', async () => {
  const t = setup()
  try {
    const { ensure } = t.useProviderUsage.getState()
    ensure(profile); assert.equal(t.fetches(), 1)
    t.advance(3000); await t.settle()
    assert.equal(t.useProviderUsage.getState().entries.p.fetching, false)
    ensure(profile); assert.equal(t.fetches(), 1, 'only 3s since the start: too soon')
    t.advance(57_000) // 60s since start, 57s since the end
    ensure(profile); assert.equal(t.fetches(), 2, 'measured from the start, not the end')
    t.advance(3000); await t.settle()
    t.advance(57_000)
    ensure(profile); assert.equal(t.fetches(), 3)
  } finally { t.restore() }
})

test('ensure allows 2s of timer jitter and skips while fetching', async () => {
  const t = setup()
  try {
    const { ensure } = t.useProviderUsage.getState()
    ensure(profile); await t.settle()
    t.advance(57_999); ensure(profile); assert.equal(t.fetches(), 1)
    t.advance(1); ensure(profile); assert.equal(t.fetches(), 2) // exactly 58s since start
    t.advance(120_000); ensure(profile); assert.equal(t.fetches(), 2, 'still fetching')
  } finally { t.restore() }
})
