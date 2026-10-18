const test = require('node:test')
const assert = require('node:assert/strict')
const load = require('./helpers/load-typescript.cjs')
const { create } = require('zustand')

const KEY = 'prism.agents.views', LEGACY = 'prism.agents.view'
const model = load('src/renderer/src/components/agents-list/model.ts')
const custom = { sort: { field: 'name', direction: 'asc' }, archive: 'all', harness: 'codex' }

// Fresh views.ts per scenario, on top of a fake localStorage.
function scenario(initial, body) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const data = new Map(Object.entries(initial))
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => void data.set(k, String(v)), removeItem: (k) => void data.delete(k) }
  })
  try {
    const v = load('src/renderer/src/components/agents-list/views.ts', { zustand: { create }, './model': model })
    body(v, data)
  } finally {
    if (saved) Object.defineProperty(globalThis, 'localStorage', saved)
    else delete globalThis.localStorage
  }
}
const stored = (data) => JSON.parse(data.get(KEY))

test('store starts from persisted views (sanitised)', () => {
  scenario({ [KEY]: JSON.stringify({ t1: custom, t2: { archive: 'bogus' }, '': custom, t3: 5 }) }, (v) => {
    const views = v.useAgentViews.getState().views
    assert.deepEqual(Object.keys(views).sort(), ['t1', 't2'])
    assert.deepEqual(views.t1, custom)
    assert.deepEqual(views.t2, model.DEFAULT_VIEW)
  })
})

test('store starts empty without storage, with garbage, or without localStorage', () => {
  scenario({}, (v) => assert.deepEqual(v.useAgentViews.getState().views, {}))
  scenario({ [KEY]: '{not json' }, (v) => assert.deepEqual(v.useAgentViews.getState().views, {}))
  scenario({ [KEY]: '[1,2]' }, (v) => assert.deepEqual(v.useAgentViews.getState().views, {}))
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  delete globalThis.localStorage
  try {
    const v = load('src/renderer/src/components/agents-list/views.ts', { zustand: { create }, './model': model })
    assert.deepEqual(v.useAgentViews.getState().views, {})
    v.useAgentViews.getState().setView('t', custom) // no storage: stays in memory
    assert.deepEqual(v.useAgentViews.getState().views.t, custom)
  } finally { if (saved) Object.defineProperty(globalThis, 'localStorage', saved) }
})

test('setView stores per task and persists', () => {
  scenario({}, (v, data) => {
    v.useAgentViews.getState().setView('t1', custom)
    v.useAgentViews.getState().setView('t2', { ...custom, harness: 'claude' })
    const views = v.useAgentViews.getState().views
    assert.deepEqual(views.t1, custom)
    assert.equal(views.t2.harness, 'claude')
    assert.deepEqual(stored(data), JSON.parse(JSON.stringify(views)))
    // a fresh load reads it back
    const again = load('src/renderer/src/components/agents-list/views.ts', { zustand: { create }, './model': model })
    assert.deepEqual(again.useAgentViews.getState().views, views)
  })
})

test('returning a task to the default deletes its entry', () => {
  scenario({}, (v, data) => {
    const { setView } = v.useAgentViews.getState()
    setView('t1', custom)
    setView('t2', custom)
    setView('t1', { sort: { field: 'updated', direction: 'desc' }, archive: 'unarchived', harness: 'all' })
    assert.deepEqual(Object.keys(v.useAgentViews.getState().views), ['t2'])
    assert.deepEqual(Object.keys(stored(data)), ['t2'])
    setView('t2', model.DEFAULT_VIEW)
    assert.deepEqual(v.useAgentViews.getState().views, {})
    assert.deepEqual(stored(data), {})
  })
})

test('adoptLegacyView moves the global view to the task and removes the legacy key', () => {
  scenario({ [LEGACY]: JSON.stringify(custom) }, (v, data) => {
    v.adoptLegacyView('t1')
    assert.deepEqual(v.useAgentViews.getState().views.t1, custom)
    assert.equal(data.has(LEGACY), false)
    assert.deepEqual(stored(data).t1, custom)
  })
})

test('adoptLegacyView sanitises the legacy value', () => {
  scenario({ [LEGACY]: JSON.stringify({ sort: { field: 'name', direction: 'sideways' }, archive: 'all', harness: 'x' }) }, (v) => {
    v.adoptLegacyView('t1')
    assert.deepEqual(v.useAgentViews.getState().views.t1, { sort: { field: 'name', direction: 'desc' }, archive: 'all', harness: 'all' })
  })
})

test('adoptLegacyView never overwrites an existing task view but still drops the legacy key', () => {
  const mine = { ...custom, harness: 'claude' }
  scenario({ [KEY]: JSON.stringify({ t1: mine }), [LEGACY]: JSON.stringify(custom) }, (v, data) => {
    v.adoptLegacyView('t1')
    assert.deepEqual(v.useAgentViews.getState().views.t1, mine)
    assert.equal(data.has(LEGACY), false)
  })
})

test('adoptLegacyView without a legacy key does nothing', () => {
  scenario({}, (v, data) => {
    v.adoptLegacyView('t1')
    assert.deepEqual(v.useAgentViews.getState().views, {})
    assert.equal(data.has(KEY), false)
    assert.equal(data.has(LEGACY), false)
  })
})

test('adoptLegacyView is one-shot', () => {
  scenario({ [LEGACY]: JSON.stringify(custom) }, (v) => {
    v.adoptLegacyView('t1')
    v.adoptLegacyView('t2')
    assert.deepEqual(Object.keys(v.useAgentViews.getState().views), ['t1'])
  })
})
