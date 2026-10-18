const test = require('node:test')
const assert = require('node:assert/strict')
const load = require('./helpers/load-typescript.cjs')
const { usageMeta } = load('src/renderer/src/components/chat/usageMeta.ts')

test('Codex tooltip distinguishes actual turn usage, cumulative usage and last-call context', () => {
  const rows = usageMeta({ scope: 'session', inputTokens: 9000, cachedTokens: 7000, outputTokens: 900,
    totalTokens: 9900, reasoningTokens: 400, contextTokens: 1200, contextWindow: 200000,
    turn: { inputTokens: 50, cacheReadTokens: 1000, outputTokens: 80, reasoningTokens: 30 } })
  assert.deepEqual(rows.turn, [['Entrada sem cache', 50], ['Leitura de cache', 1000], ['Saída', 80], ['Raciocínio (incluído na saída)', 30]])
  assert.equal(rows.session.find(([label]) => label === 'Tokens acumulados')[1], 9900)
  assert.deepEqual(rows.context, [['Última chamada', 1200], ['Janela', 200000]])
  assert.equal(rows.turnCost, undefined)
  assert.equal(rows.sessionCost, undefined)
})

test('known zeros are shown; absent and invalid readings are not converted into zero', () => {
  const rows = usageMeta({ scope: 'session', inputTokens: NaN, cachedTokens: -1, outputTokens: 0, costUsd: 0,
    turn: { inputTokens: 0, outputTokens: 0, costUsd: 0 } })
  assert.deepEqual(rows.turn, [['Entrada sem cache', 0], ['Saída', 0]])
  assert.deepEqual(rows.session, [['Saída', 0]])
  assert.equal(rows.turnCost, 0)
  assert.equal(rows.sessionCost, 0)
  assert.deepEqual(usageMeta(undefined), { turn: [], session: [], context: [] })
})

test('older runs keep their reported session reading without inventing per-turn usage', () => {
  const rows = usageMeta({ scope: 'session', totalTokens: 40, inputTokens: 30, outputTokens: 10 })
  assert.equal(rows.turn.length, 0)
  assert.deepEqual(rows.session, [['Tokens acumulados', 40], ['Entrada', 30], ['Saída', 10]])
})
