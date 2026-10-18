const test = require('node:test')
const assert = require('node:assert/strict')
const load = require('./helpers/load-typescript.cjs')
const time = load('src/renderer/src/lib/usageAnalytics/time.ts')
const file = 'src/renderer/src/components/usage/prefs.ts'
const { initialUsageMetric, parseUsagePrefs } = load(file, { react: {}, '../../lib/usageAnalytics/time': time })

test('Codex tokens are the initial measure when no turn reports cost', () => {
  assert.equal(initialUsageMetric([{ costUsd: null, measured: true }]), 'tokens')
  assert.equal(initialUsageMetric([{ costUsd: null, measured: false }, { costUsd: null, measured: true }]), 'tokens')
  assert.equal(initialUsageMetric([]), 'cost')
  assert.equal(initialUsageMetric([{ costUsd: null, measured: false }]), 'cost')
})

test('a reported Claude cost, including measured zero, keeps the cost default', () => {
  assert.equal(initialUsageMetric([{ costUsd: null, measured: true }, { costUsd: 0.75, measured: true }]), 'cost')
  assert.equal(initialUsageMetric([{ costUsd: 0, measured: true }]), 'cost')
  assert.equal(initialUsageMetric([{ costUsd: NaN, measured: true }]), 'tokens')
})

test('legacy cost preference stays explicit; a missing or invalid metric is automatic', () => {
  assert.equal(parseUsagePrefs({ metric: 'cost' }).metricChosen, true)
  assert.equal(parseUsagePrefs({ metric: 'output' }).prefs.metric, 'output')
  for (const value of [null, undefined, {}, { metric: 'unknown' }]) assert.equal(parseUsagePrefs(value).metricChosen, false)
})

function hook(saved) {
  const values = new Map(saved ? [['prism.usage.prefs.v1', JSON.stringify(saved)]] : [])
  const previous = global.localStorage
  global.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
  let state
  const react = {
    useState(initial) {
      if (!state) state = typeof initial === 'function' ? initial() : initial
      return [state, updater => { state = typeof updater === 'function' ? updater(state) : updater }]
    },
    useMemo: fn => fn(),
    useCallback: fn => fn
  }
  const { useUsagePrefs } = load(file, { react, '../../lib/usageAnalytics/time': time })
  return { render: metric => useUsagePrefs(metric), saved: () => JSON.parse(values.get('prism.usage.prefs.v1') || '{}'), cleanup: () => { global.localStorage = previous } }
}

test('automatic metric follows loaded usage and layout changes do not save an implicit choice', () => {
  const h = hook()
  try {
    assert.equal(h.render('cost')[0].metric, 'cost', 'loading has no usage yet')
    let [prefs, update] = h.render('tokens')
    assert.equal(prefs.metric, 'tokens', 'Codex records become visible after loading')
    update({ period: '7', chartGroup: 'model' })
    assert.equal(h.saved().metric, undefined)
    assert.equal(h.saved().period, '7')
    assert.equal(h.render('tokens')[0].metric, 'tokens')
    assert.equal(h.render('cost')[0].metric, 'cost', 'cost becomes available on a later refresh')
  } finally { h.cleanup() }
})

test('choosing cost explicitly survives refresh, layout changes and re-opening', () => {
  const h = hook()
  try {
    h.render('tokens')[1]({ metric: 'cost' })
    const [prefs, update] = h.render('tokens')
    assert.equal(prefs.metric, 'cost')
    update({ period: 'all' })
    assert.equal(h.saved().metric, 'cost')
  } finally { h.cleanup() }
  const reopened = hook({ metric: 'cost', period: 'all' })
  try { assert.equal(reopened.render('tokens')[0].metric, 'cost') }
  finally { reopened.cleanup() }
})
