const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { DatabaseSync } = require('node:sqlite')
const load = require('./helpers/load-typescript.cjs')

const dir = 'src/renderer/src/lib/usageAnalytics/'
const deltas = load(dir + 'deltas.ts')
const time = load(dir + 'time.ts')
const agg = load(dir + 'aggregate.ts', { './time': time })
const fmt = load(dir + 'format.ts')
const exp = load(dir + 'exportData.ts', { './aggregate': agg, './time': time })
const nbsp = (s) => s.replace(/\u00a0/g, ' ')

/* ---------------- builders ---------------- */
let seq = 0
function obs(o = {}) {
  seq++
  return {
    id: `prism:c:${seq}`, source: 'prism', chatId: 'c', turnId: `t${seq}`, chatTitle: 'Chat', taskId: null, taskTitle: null, project: null,
    provider: 'claude', model: 'opus', profileId: 'p1', profileName: 'Conta', sessionKey: null, startedAt: 1000 * seq, completedAt: 1000 * seq + 500,
    durationMs: 500, outcome: 'completed', prismChatId: null, tokenBasis: 'turn', costBasis: 'none',
    inputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null, reasoningTokens: null, costUsd: null, ...o
  }
}
const T0 = Date.UTC(2026, 9, 9, 12, 0, 0) // 2026-10-09 12:00Z
function fact(o = {}) {
  seq++
  const { tokens, ...rest } = o
  return {
    id: `f${seq}`, source: 'prism', chatId: 'c', turnId: `t${seq}`, chatTitle: 'Chat', taskId: null, taskTitle: null, project: null,
    provider: 'claude', model: 'opus', profileId: 'p1', profileName: 'Conta', occurredAt: T0, startedAt: T0 - 1000, durationMs: 1000,
    outcome: 'completed', prismChatId: null, costUsd: null, measured: true, tokenBasis: 'turn',
    tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, ...tokens }, ...rest
  }
}

/* ---------------- deltas ---------------- */
test('cleanCounter keeps only finite non-negative numbers', () => {
  assert.equal(deltas.cleanCounter(5), 5)
  assert.equal(deltas.cleanCounter(0), 0)
  for (const v of [-1, NaN, Infinity, null, undefined, '3']) assert.equal(deltas.cleanCounter(v), null)
})

test('counterDelta: first reading, growth, drops and null', () => {
  assert.equal(deltas.counterDelta(10, null), 10)
  assert.equal(deltas.counterDelta(15, 10), 5)
  assert.equal(deltas.counterDelta(10, 10), 0)
  assert.equal(deltas.counterDelta(4, 10, 'restart'), 4)
  assert.equal(deltas.counterDelta(4, 10), 4)
  assert.equal(deltas.counterDelta(4, 10, 'unknown'), null)
  assert.equal(deltas.counterDelta(null, 10), null)
  for (const [c, p, d] of [[1, 9, 'restart'], [9, 1, 'restart'], [1, 9, 'unknown'], [0, 0, 'unknown']]) {
    const r = deltas.counterDelta(c, p, d)
    assert.ok(r === null || r >= 0)
  }
})

test('startsNewSession: known keys decide alone, otherwise provider/profile/prism failure', () => {
  const a = obs({ sessionKey: 's1' })
  assert.equal(deltas.startsNewSession(a, obs({ sessionKey: 's1', provider: 'codex', profileId: 'x' })), false)
  assert.equal(deltas.startsNewSession(a, obs({ sessionKey: 's2' })), true)
  const n = obs()
  assert.equal(deltas.startsNewSession(n, obs()), false)
  assert.equal(deltas.startsNewSession(n, obs({ provider: 'codex' })), true)
  assert.equal(deltas.startsNewSession(n, obs({ profileId: 'other' })), true)
  assert.equal(deltas.startsNewSession(obs({ profileId: null, profileName: 'A' }), obs({ profileId: null, profileName: 'B' })), true)
  assert.equal(deltas.startsNewSession(obs({ outcome: 'error' }), obs()), true)
  assert.equal(deltas.startsNewSession(obs({ outcome: 'interrupted' }), obs()), true)
  assert.equal(deltas.startsNewSession(obs({ outcome: 'error', source: 'traycer' }), obs({ source: 'traycer' })), false)
  // one side with a key and the other without falls to the heuristics
  assert.equal(deltas.startsNewSession(obs({ sessionKey: 's1' }), obs()), false)
})

test('deriveTurnUsage: turn and last-call tokens are taken as reported', () => {
  for (const basis of ['turn', 'last-call']) {
    const [f] = deltas.deriveTurnUsage([obs({ tokenBasis: basis, inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 5, outputTokens: 7, reasoningTokens: 3 })])
    assert.deepEqual(f.tokens, { input: 10, cacheRead: 20, cacheWrite: 5, output: 7, reasoning: 3 })
    assert.equal(f.measured, true)
    assert.equal(f.tokenBasis, basis)
  }
})

test('deriveTurnUsage: cumulative tokens become deltas per chat and reset on a new session', () => {
  const mk = (n, i, sessionKey, chatId = 'c') => obs({ chatId, sessionKey, tokenBasis: 'cumulative', inputTokens: i, outputTokens: i / 2, startedAt: n * 100, completedAt: n * 100 + 10 })
  const facts = deltas.deriveTurnUsage([
    mk(1, 100, 's1'), mk(2, 250, 's1'), mk(3, 60, 's2'), mk(4, 100, 's2'),
    mk(1, 1000, 's1', 'other'), mk(2, 1200, 's1', 'other')
  ])
  const byChat = (c) => facts.filter((f) => f.chatId === c).map((f) => f.tokens.input)
  assert.deepEqual(byChat('c'), [100, 150, 60, 40])
  assert.deepEqual(byChat('other'), [1000, 200])
  // a drop inside the same session counts the whole reading
  const drop = deltas.deriveTurnUsage([mk(1, 500, 's1'), mk(2, 30, 's1')])
  assert.deepEqual(drop.map((f) => f.tokens.input), [500, 30])
})

test('deriveTurnUsage: cumulative cost (Claude) delta, drop => null and new baseline', () => {
  const mk = (n, cost) => obs({ sessionKey: 's', costBasis: 'cumulative', costUsd: cost, startedAt: n * 100, completedAt: n * 100 + 10 })
  const facts = deltas.deriveTurnUsage([mk(1, 1), mk(2, 3), mk(3, 2), mk(4, 2.5)])
  assert.deepEqual(facts.map((f) => f.costUsd), [1, 2, null, 0.5])
})

test('deriveTurnUsage: zero after positive cost is null and does not move the base', () => {
  const mk = (n, cost) => obs({ sessionKey: 's', costBasis: 'cumulative', costUsd: cost, startedAt: n * 100, completedAt: n * 100 + 10 })
  const facts = deltas.deriveTurnUsage([mk(1, 2), mk(2, 0), mk(3, 5)])
  assert.deepEqual(facts.map((f) => f.costUsd), [2, null, 3])
  // a zero as the very first reading is a real zero
  assert.equal(deltas.deriveTurnUsage([mk(1, 0)])[0].costUsd, 0)
})

test('deriveTurnUsage: turn cost as is, none basis absent, ordering by completion', () => {
  const [t] = deltas.deriveTurnUsage([obs({ costBasis: 'turn', costUsd: 0.25 })])
  assert.equal(t.costUsd, 0.25)
  const [n] = deltas.deriveTurnUsage([obs({ costBasis: 'none', costUsd: 9, tokenBasis: 'none', inputTokens: 5 })])
  assert.equal(n.costUsd, null); assert.equal(n.measured, false); assert.equal(n.tokens.input, 0)
  // input order is reversed vs completion
  const late = obs({ sessionKey: 's', tokenBasis: 'cumulative', inputTokens: 300, startedAt: 10, completedAt: 900 })
  const early = obs({ sessionKey: 's', tokenBasis: 'cumulative', inputTokens: 100, startedAt: 20, completedAt: 100 })
  const facts = deltas.deriveTurnUsage([late, early])
  assert.equal(facts.find((f) => f.id === early.id).tokens.input, 100)
  assert.equal(facts.find((f) => f.id === late.id).tokens.input, 200)
  // a turn that never completed sorts by startedAt
  const open = obs({ sessionKey: 's', tokenBasis: 'cumulative', inputTokens: 50, startedAt: 5, completedAt: null })
  const fo = deltas.deriveTurnUsage([open])
  assert.equal(fo[0].occurredAt, 5)
  assert.equal(deltas.deriveTurnUsage([obs({ startedAt: 7, completedAt: 99 })])[0].occurredAt, 99)
})

test('deriveTurnUsage: reasoning is capped at output; chats/sources stay separate; measured', () => {
  const [f] = deltas.deriveTurnUsage([obs({ outputTokens: 10, reasoningTokens: 50 })])
  assert.equal(f.tokens.reasoning, 10)
  const [g] = deltas.deriveTurnUsage([obs({ reasoningTokens: 4 })])
  assert.equal(g.tokens.reasoning, 4)
  const [h] = deltas.deriveTurnUsage([obs({ outputTokens: 3 })])
  assert.equal(h.measured, true)
  const same = { chatId: 'same', sessionKey: 's', tokenBasis: 'cumulative', inputTokens: 100 }
  const facts = deltas.deriveTurnUsage([obs({ ...same, source: 'prism' }), obs({ ...same, source: 'traycer' })])
  assert.deepEqual(facts.map((x) => x.tokens.input), [100, 100])
})

/* ---------------- time ---------------- */
test('dayKey honors the zone and falls back to UTC', () => {
  const ms = Date.UTC(2026, 2, 8, 7, 30)
  assert.equal(time.dayKey(ms, 'UTC'), '2026-03-08')
  assert.equal(time.dayKey(ms, 'America/New_York'), '2026-03-08')
  assert.equal(time.dayKey(ms, 'America/Sao_Paulo'), '2026-03-08')
  assert.equal(time.dayKey(Date.UTC(2026, 2, 8, 3, 30), 'America/New_York'), '2026-03-07')
  assert.equal(time.dayKey(Date.UTC(2026, 2, 8, 1, 0), 'America/Sao_Paulo'), '2026-03-07')
  assert.equal(time.dayKey(Date.UTC(2026, 2, 8, 23, 0), 'Not/AZone'), '2026-03-08')
})

test('calendar helpers', () => {
  assert.equal(time.addDays('2026-01-31', 1), '2026-02-01')
  assert.equal(time.addDays('2025-12-31', 1), '2026-01-01')
  assert.equal(time.addDays('2026-03-01', -1), '2026-02-28')
  assert.equal(time.addDays('2028-03-01', -1), '2028-02-29')
  assert.equal(time.daysInclusive('2026-10-01', '2026-10-09'), 9)
  assert.equal(time.daysInclusive('2026-10-09', '2026-10-09'), 1)
  assert.equal(time.daysInclusive('2026-10-09', '2026-10-01'), 0)
  assert.deepEqual(time.dayRange('2026-12-30', '2027-01-02'), ['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02'])
  assert.deepEqual(time.dayRange('2026-10-09', '2026-10-01'), [])
  assert.equal(time.weekdayOf('2026-10-09'), 5) // Friday
  assert.equal(time.weekdayOf('2026-10-04'), 0)
  assert.equal(time.weekStart('2026-10-09'), '2026-10-04')
  assert.equal(time.weekStart('2026-10-04'), '2026-10-04')
  assert.equal(time.isDayKey('2026-02-30'), false)
  assert.equal(time.isDayKey('2026-02-28'), true)
})

test('hourAndWeekday uses h23 and Sunday-first', () => {
  assert.deepEqual(time.hourAndWeekday(Date.UTC(2026, 2, 8, 0, 0), 'UTC'), { hour: 0, weekday: 0 })
  assert.deepEqual(time.hourAndWeekday(Date.UTC(2026, 2, 8, 23, 59), 'UTC'), { hour: 23, weekday: 0 })
  assert.deepEqual(time.hourAndWeekday(Date.UTC(2026, 2, 9, 0, 0), 'UTC'), { hour: 0, weekday: 1 })
  assert.deepEqual(time.hourAndWeekday(Date.UTC(2026, 2, 8, 3, 30), 'America/New_York'), { hour: 22, weekday: 6 })
})

test('resolvePeriod', () => {
  const now = Date.UTC(2026, 9, 9, 12)
  const r = (p, e = null) => time.resolvePeriod(p, now, 'UTC', e)
  assert.deepEqual(r({ kind: 'today' }), { from: '2026-10-09', to: '2026-10-09', days: 1, granularity: 'hour' })
  const w7 = r({ kind: 'last', days: 7 })
  assert.equal(w7.from, '2026-10-03'); assert.equal(w7.days, 7); assert.equal(w7.granularity, 'day')
  assert.equal(r({ kind: 'last', days: 30 }).from, '2026-09-10')
  assert.equal(r({ kind: 'last', days: 90 }).days, 90)
  const y = r({ kind: 'year' })
  assert.equal(y.days, 365); assert.equal(y.granularity, 'week'); assert.equal(y.from, '2025-10-10')
  assert.equal(r({ kind: 'all' }, Date.UTC(2026, 0, 1)).from, '2026-01-01')
  assert.equal(r({ kind: 'all' }, null).from, '2026-10-09')
  assert.equal(r({ kind: 'all' }, Date.UTC(2027, 0, 1)).from, '2026-10-09')
  assert.equal(r({ kind: 'custom', from: '2026-10-05', to: '2026-10-01' }).from, '2026-10-01')
  assert.equal(r({ kind: 'custom', from: '2026-10-05', to: '2026-10-01' }).to, '2026-10-05')
  const fut = r({ kind: 'custom', from: '2026-10-05', to: '2030-01-01' })
  assert.equal(fut.to, '2026-10-09')
  const allFuture = r({ kind: 'custom', from: '2030-01-01', to: '2031-01-01' })
  assert.equal(allFuture.from, '2026-10-09'); assert.equal(allFuture.to, '2026-10-09')
  const bad = r({ kind: 'custom', from: 'nope', to: 'x' })
  assert.deepEqual([bad.from, bad.to, bad.days], ['2026-10-09', '2026-10-09', 1])
  // the viewer's zone defines "today"
  const ny = time.resolvePeriod({ kind: 'today' }, Date.UTC(2026, 9, 9, 2), 'America/New_York', null)
  assert.equal(ny.from, '2026-10-08')
})

test('granularityFor, previousWindow', () => {
  assert.equal(time.granularityFor(1), 'hour')
  assert.equal(time.granularityFor(2), 'day')
  assert.equal(time.granularityFor(120), 'day')
  assert.equal(time.granularityFor(121), 'week')
  const win = { from: '2026-10-03', to: '2026-10-09', days: 7, granularity: 'day' }
  const prev = time.previousWindow(win)
  assert.deepEqual([prev.from, prev.to, prev.days], ['2026-09-26', '2026-10-02', 7])
  const one = time.previousWindow({ from: '2026-10-09', to: '2026-10-09', days: 1, granularity: 'hour' })
  assert.deepEqual([one.from, one.to, one.granularity], ['2026-10-08', '2026-10-08', 'hour'])
})

test('windowBuckets and bucketKeyFor', () => {
  const hour = time.windowBuckets({ from: '2026-10-09', to: '2026-10-09', days: 1, granularity: 'hour' })
  assert.equal(hour.length, 24); assert.equal(hour[0].key, '00'); assert.equal(hour[23].key, '23')
  const day = time.windowBuckets({ from: '2026-10-03', to: '2026-10-09', days: 7, granularity: 'day' })
  assert.deepEqual(day.map((b) => b.key), time.dayRange('2026-10-03', '2026-10-09'))
  assert.ok(day.every((b) => b.from === b.key && b.to === b.key))
  // weeks: 2026-10-07 (Wed) .. 2026-12-30 (Wed), > 120 days is not needed to test buckets directly
  const weeks = time.windowBuckets({ from: '2026-10-07', to: '2026-10-21', days: 15, granularity: 'week' })
  assert.deepEqual(weeks.map((b) => b.key), ['2026-10-04', '2026-10-11', '2026-10-18'])
  assert.deepEqual([weeks[0].from, weeks[0].to], ['2026-10-07', '2026-10-10'])
  assert.deepEqual([weeks[1].from, weeks[1].to], ['2026-10-11', '2026-10-17'])
  assert.deepEqual([weeks[2].from, weeks[2].to], ['2026-10-18', '2026-10-21'])
  const ms = Date.UTC(2026, 9, 9, 15)
  assert.equal(time.bucketKeyFor(ms, { granularity: 'hour' }, 'UTC'), '15')
  assert.equal(time.bucketKeyFor(ms, { granularity: 'day' }, 'UTC'), '2026-10-09')
  assert.equal(time.bucketKeyFor(ms, { granularity: 'week' }, 'UTC'), '2026-10-04')
})

test('DST: a 10-day window in America/New_York across 2026-11-01 has exactly 10 days', () => {
  const tz = 'America/New_York'
  const now = Date.UTC(2026, 10, 6, 17) // Nov 6, noon local
  const w = time.resolvePeriod({ kind: 'custom', from: '2026-10-28', to: '2026-11-06' }, now, tz, null)
  assert.equal(w.days, 10)
  const days = time.dayRange(w.from, w.to)
  assert.equal(days.length, 10)
  assert.equal(new Set(days).size, 10)
  assert.ok(days.includes('2026-11-01'))
  assert.equal(time.windowBuckets(w).length, 10)
  const last10 = time.resolvePeriod({ kind: 'custom', from: '2026-10-28', to: '2026-11-06' }, now, tz, null)
  assert.equal(time.previousWindow(last10).days, 10)
  // the long local day: both 00:30 local and 23:30 local land in 2026-11-01
  assert.equal(time.dayKey(Date.UTC(2026, 10, 1, 4, 30), tz), '2026-11-01')
  assert.equal(time.dayKey(Date.UTC(2026, 10, 2, 4, 30), tz), '2026-11-01')
  assert.equal(time.dayKey(Date.UTC(2026, 10, 2, 5, 30), tz), '2026-11-02')
})

/* ---------------- aggregate ---------------- */
test('metricValue for each metric', () => {
  const f = fact({ tokens: { input: 10, cacheRead: 20, cacheWrite: 5, output: 7, reasoning: 3 }, costUsd: 0.5, durationMs: 2000 })
  const v = (m) => agg.metricValue(f, m)
  assert.equal(v('cost'), 0.5); assert.equal(v('tokens'), 42); assert.equal(v('input'), 10); assert.equal(v('output'), 7)
  assert.equal(v('cache'), 25); assert.equal(v('reasoning'), 3); assert.equal(v('turns'), 1); assert.equal(v('duration'), 2000)
  const n = fact({ costUsd: null, durationMs: null })
  assert.equal(agg.metricValue(n, 'cost'), 0); assert.equal(agg.metricValue(n, 'duration'), 0)
  assert.equal(agg.isTokenMetric('cache'), true); assert.equal(agg.isTokenMetric('cost'), false)
})

test('dimensionValue groups accounts/tasks by folded name and labels empties', () => {
  const a = fact({ profileName: ' Minha Conta ', profileId: 'x', taskTitle: ' Tarefa A' })
  const b = fact({ profileName: 'minha conta', profileId: 'y', taskTitle: 'tarefa a ', source: 'traycer' })
  assert.equal(agg.dimensionValue(a, 'profile').key, agg.dimensionValue(b, 'profile').key)
  assert.equal(agg.dimensionValue(a, 'task').key, agg.dimensionValue(b, 'task').key)
  assert.equal(agg.dimensionValue(fact({ project: null }), 'project').label, 'Sem projeto')
  assert.equal(agg.dimensionValue(fact({ taskTitle: null }), 'task').label, 'Sem tarefa')
  assert.equal(agg.dimensionValue(fact({ provider: 'claude' }), 'provider').label, 'Claude')
  assert.equal(agg.dimensionValue(fact({ source: 'traycer' }), 'source').label, 'Traycer')
  assert.equal(agg.dimensionValue(fact({ model: '' }), 'model').label, 'Padrão')
  assert.equal(agg.dimensionValue(fact({ profileName: '' }), 'profile').label, 'Conta do terminal')
  assert.equal(agg.dimensionValue(fact({ project: 'Prism' }), 'project').key, 'prism')
})

test('applyFilters: AND across dimensions, OR within', () => {
  const facts = [
    fact({ provider: 'claude', model: 'a' }), fact({ provider: 'claude', model: 'b' }),
    fact({ provider: 'codex', model: 'a' }), fact({ provider: 'codex', model: 'c' })
  ]
  assert.equal(agg.applyFilters(facts, {}).length, 4)
  assert.equal(agg.applyFilters(facts, { provider: [] }).length, 4)
  assert.equal(agg.applyFilters(facts, { provider: ['claude', 'codex'] }).length, 4)
  assert.equal(agg.applyFilters(facts, { provider: ['claude'] }).length, 2)
  assert.equal(agg.applyFilters(facts, { provider: ['claude', 'codex'], model: ['claude/a'] }).length, 1)
  assert.equal(agg.applyFilters(facts, { provider: ['codex'], model: ['claude/a'] }).length, 0)
  assert.equal(agg.activeFilterCount({ provider: ['x'], model: [] }), 1)
})

test('filterOptions orders by turns then label', () => {
  const facts = [fact({ provider: 'codex' }), fact({ provider: 'claude' }), fact({ provider: 'claude' }), fact({ provider: 'opencode' })]
  const opts = agg.filterOptions(facts, 'provider')
  assert.deepEqual(opts.map((o) => [o.key, o.turns]), [['claude', 2], ['codex', 1], ['opencode', 1]])
})

test('factsInWindow and earliestOccurrence', () => {
  const win = { from: '2026-10-08', to: '2026-10-09', days: 2, granularity: 'day' }
  const facts = [fact({ occurredAt: Date.UTC(2026, 9, 7, 23, 59) }), fact({ occurredAt: Date.UTC(2026, 9, 8, 0, 0) }), fact({ occurredAt: Date.UTC(2026, 9, 9, 23, 59) }), fact({ occurredAt: Date.UTC(2026, 9, 10) })]
  assert.equal(agg.factsInWindow(facts, win, 'UTC').length, 2)
  assert.equal(agg.earliestOccurrence(facts), Date.UTC(2026, 9, 7, 23, 59))
  assert.equal(agg.earliestOccurrence([]), null)
})

test('summarize', () => {
  const facts = [
    fact({ tokens: { input: 10, cacheRead: 5, cacheWrite: 1, output: 4, reasoning: 2 }, costUsd: 0.5, durationMs: 1000, chatId: 'a' }),
    fact({ tokens: { input: 1 }, costUsd: null, durationMs: null, chatId: 'a', measured: false, outcome: 'error', tokenBasis: 'last-call', source: 'traycer', occurredAt: T0 + 86400000 }),
    fact({ costUsd: 0, durationMs: 500, chatId: 'b', outcome: 'interrupted' }),
    fact({ chatId: 'a', source: 'traycer' })
  ]
  const s = agg.summarize(facts, 'UTC')
  assert.equal(s.turns, 4); assert.equal(s.measuredTurns, 3)
  assert.equal(s.pricedTurns, 2); assert.equal(s.unpricedTurns, 2); assert.equal(s.costUsd, 0.5)
  assert.equal(s.errorTurns, 1); assert.equal(s.interruptedTurns, 1); assert.equal(s.lastCallTurns, 1)
  assert.equal(s.timedTurns, 3); assert.equal(s.durationMs, 2500)
  assert.equal(s.activeDays, 2)
  assert.equal(s.chats, 3) // prism:a, prism:b, traycer:a (+ traycer:a again)
  assert.equal(s.prismTurns, 2); assert.equal(s.traycerTurns, 2)
  assert.equal(s.totalTokens, 10 + 5 + 1 + 4 + 1)
  assert.equal(agg.totalsValue(s, 'cache'), 6)
  assert.equal(agg.totalsValue(s, 'turns'), 4)
})

test('percentChange and buildStatTiles', () => {
  assert.equal(agg.percentChange(150, 100), 50)
  assert.equal(agg.percentChange(50, 100), -50)
  assert.equal(agg.percentChange(10, 0), null)
  assert.equal(agg.percentChange(0, 0), null)
  assert.equal(agg.percentChange(NaN, 5), null)
  const empty = agg.buildStatTiles(agg.summarize([], 'UTC'))
  assert.equal(empty.processed.perActiveDay, null); assert.equal(empty.cached.percentOfInput, null)
  assert.equal(empty.output.reasoning, null); assert.equal(empty.duration.perTurn, null)
  const t = agg.buildStatTiles(agg.summarize([fact({ tokens: { input: 50, cacheRead: 50, output: 10, reasoning: 4, cacheWrite: 2 }, durationMs: 3000 })], 'UTC'))
  assert.equal(t.processed.total, 112); assert.equal(t.processed.perActiveDay, 112)
  assert.equal(t.cached.percentOfInput, 50); assert.equal(t.output.reasoning, 4)
  assert.equal(t.duration.perTurn, 3000); assert.equal(t.uncached.cacheWrite, 2)
  assert.deepEqual(t.turns, { turns: 1, errors: 0, interrupted: 0, chats: 1 })
})

test('buildSeriesScale: top N + Outros, stable alphabetical order, brand slots, unknown token', () => {
  const mk = (m, n) => Array.from({ length: n }, () => fact({ model: m, provider: 'x', tokens: { input: 1 } }))
  const facts = [...mk('delta', 5), ...mk('alpha', 4), ...mk('charlie', 3), ...mk('bravo', 2), ...mk('echo', 1)]
  const scale = agg.buildSeriesScale(facts, 'model', 'tokens', 3)
  assert.deepEqual(scale.order, ['x/alpha', 'x/delta', agg.OTHER_SERIES_KEY])
  assert.equal(scale.labelFor(agg.OTHER_SERIES_KEY), 'Outros')
  assert.equal(scale.labelFor('x/delta'), 'delta')
  assert.equal(scale.detailFor(agg.OTHER_SERIES_KEY), null)
  assert.equal(scale.tokenFor('x/alpha'), '--usg-series-1')
  assert.equal(scale.tokenFor('x/delta'), '--usg-series-2')
  assert.equal(scale.tokenFor('nope'), '--usg-series-other')
  assert.equal(scale.tokenFor(agg.OTHER_SERIES_KEY), '--usg-series-other')
  // exactly N series: no Outros
  assert.equal(agg.buildSeriesScale(facts, 'model', 'tokens', 5).order.includes(agg.OTHER_SERIES_KEY), false)
  // order does not depend on magnitudes
  const flipped = facts.map((f) => ({ ...f, tokens: { ...f.tokens, input: f.model === 'alpha' ? 100 : 1 } }))
  assert.deepEqual(agg.buildSeriesScale(flipped, 'model', 'tokens', 5).order, agg.buildSeriesScale(facts, 'model', 'tokens', 5).order)
})

test('buildSeriesScale: claude/codex brand tokens reserve the nearby generic slot', () => {
  const facts = [fact({ provider: 'claude' }), fact({ provider: 'codex' }), fact({ provider: 'opencode' }), fact({ provider: 'zed' })]
  const scale = agg.buildSeriesScale(facts, 'provider', 'turns')
  assert.equal(scale.tokenFor('claude'), '--usg-brand-claude')
  assert.equal(scale.tokenFor('codex'), '--usg-brand-codex')
  const generic = ['opencode', 'zed'].map((k) => scale.tokenFor(k))
  assert.ok(!generic.includes('--usg-series-1') && !generic.includes('--usg-series-2'), generic.join())
  assert.equal(new Set(generic).size, 2)
})

function chartSetup() {
  const win = { from: '2026-10-03', to: '2026-10-09', days: 7, granularity: 'day' }
  const day = (d, h = 12) => Date.UTC(2026, 9, d, h)
  const facts = [
    fact({ provider: 'claude', occurredAt: day(3), tokens: { input: 10 } }),
    fact({ provider: 'codex', occurredAt: day(3), tokens: { input: 5 } }),
    fact({ provider: 'claude', occurredAt: day(9), tokens: { output: 7 } })
  ]
  return { win, facts }
}

test('buildChartColumns: totals match, empty columns are 0, previous aligned', () => {
  const { win, facts } = chartSetup()
  const scale = agg.buildSeriesScale(facts, 'provider', 'tokens')
  const cols = agg.buildChartColumns({ facts, window: win, timeZone: 'UTC', scale, dimension: 'provider', metric: 'tokens' })
  assert.equal(cols.length, 7)
  assert.equal(cols.reduce((s, c) => s + c.total, 0), agg.summarize(facts, 'UTC').totalTokens)
  assert.equal(cols[1].total, 0); assert.ok(cols[1].segments.every((v) => v === 0))
  assert.equal(cols[0].total, 15); assert.equal(cols[6].total, 7)
  assert.ok(cols.every((c) => c.previous === null))
  const pw = time.previousWindow(win)
  const prevFacts = [fact({ occurredAt: Date.UTC(2026, 9, 1, 8), tokens: { input: 99 } })]
  const withPrev = agg.buildChartColumns({ facts, window: win, timeZone: 'UTC', scale, dimension: 'provider', metric: 'tokens', previousFacts: prevFacts, previousWindow: pw })
  assert.equal(pw.from, '2026-09-26')
  assert.equal(withPrev[5].previous, 99) // 10-01 is index 5 of 09-26..10-02
  assert.equal(withPrev[0].previous, 0)
  // facts outside the window are ignored
  const outside = agg.buildChartColumns({ facts: [fact({ occurredAt: Date.UTC(2026, 8, 1), tokens: { input: 1 } })], window: win, timeZone: 'UTC', scale, dimension: 'provider', metric: 'tokens' })
  assert.equal(outside.reduce((s, c) => s + c.total, 0), 0)
})

test('buildChartColumns: folded tail lands in Outros; weekly windows keep the total', () => {
  const win = { from: '2026-01-01', to: '2026-06-30', days: 181, granularity: 'week' }
  const facts = ['a', 'b', 'c'].map((m, i) => fact({ model: m, occurredAt: Date.UTC(2026, i, 10 + i), tokens: { input: 3 - i } }))
  const scale = agg.buildSeriesScale(facts, 'model', 'tokens', 2)
  assert.equal(scale.order.length, 2)
  const cols = agg.buildChartColumns({ facts, window: win, timeZone: 'UTC', scale, dimension: 'model', metric: 'tokens' })
  assert.equal(cols.reduce((s, c) => s + c.total, 0), 6)
  assert.ok(cols.every((c) => time.weekdayOf(c.key) === 0))
  assert.equal(cols[0].from, '2026-01-01')
  const otherIdx = scale.order.indexOf(agg.OTHER_SERIES_KEY)
  assert.ok(cols.reduce((s, c) => s + c.segments[otherIdx], 0) > 0)
})

test('hideSeries zeroes hidden series but keeps order', () => {
  const { win, facts } = chartSetup()
  const scale = agg.buildSeriesScale(facts, 'provider', 'tokens')
  const cols = agg.buildChartColumns({ facts, window: win, timeZone: 'UTC', scale, dimension: 'provider', metric: 'tokens' })
  assert.deepEqual(agg.hideSeries(cols, scale, new Set()), cols)
  const hidden = agg.hideSeries(cols, scale, new Set(['claude']))
  assert.equal(hidden[0].total, 5); assert.equal(hidden[6].total, 0)
  assert.equal(hidden[0].segments.length, scale.order.length)
  assert.equal(cols[0].total, 15) // original untouched
})

test('buildBreakdown: share sums to 1, days newest first', () => {
  const facts = [
    fact({ provider: 'claude', occurredAt: Date.UTC(2026, 9, 7), tokens: { input: 30 }, costUsd: 1 }),
    fact({ provider: 'codex', occurredAt: Date.UTC(2026, 9, 9), tokens: { input: 10 } }),
    fact({ provider: 'codex', occurredAt: Date.UTC(2026, 9, 8), tokens: { input: 60 }, costUsd: 2 })
  ]
  const rows = agg.buildBreakdown(facts, 'provider', 'tokens', 'UTC')
  assert.deepEqual(rows.map((r) => r.key), ['codex', 'claude'])
  assert.ok(Math.abs(rows.reduce((s, r) => s + r.share, 0) - 1) < 1e-9)
  assert.equal(rows[0].value, 70); assert.equal(rows[0].turns, 2); assert.equal(rows[0].pricedTurns, 1); assert.equal(rows[0].costUsd, 2)
  const days = agg.buildBreakdown(facts, 'day', 'turns', 'UTC')
  assert.deepEqual(days.map((r) => r.key), ['2026-10-09', '2026-10-08', '2026-10-07'])
  const zero = agg.buildBreakdown([fact()], 'provider', 'cost', 'UTC')
  assert.equal(zero[0].share, 0)
})

test('sortBreakdown', () => {
  const facts = [
    fact({ model: 'b', tokens: { input: 5 }, costUsd: 3 }), fact({ model: 'a', tokens: { input: 50 }, costUsd: 1 }), fact({ model: 'a', tokens: { input: 1 } }),
    fact({ model: 'c', tokens: { input: 20 }, costUsd: 2 })
  ]
  const rows = agg.buildBreakdown(facts, 'model', 'tokens', 'UTC')
  assert.deepEqual(agg.sortBreakdown(rows, 'label', 'asc').map((r) => r.label), ['a', 'b', 'c'])
  assert.deepEqual(agg.sortBreakdown(rows, 'label', 'desc').map((r) => r.label), ['c', 'b', 'a'])
  assert.deepEqual(agg.sortBreakdown(rows, 'cost', 'desc').map((r) => r.label), ['b', 'c', 'a'])
  assert.deepEqual(agg.sortBreakdown(rows, 'turns', 'desc')[0].label, 'a')
  assert.deepEqual(agg.sortBreakdown(rows, 'tokens', 'asc').map((r) => r.label), ['b', 'c', 'a'])
  assert.equal(rows[0].label, 'a') // input untouched
})

test('buildChatRows', () => {
  const facts = [
    fact({ chatId: 'x', chatTitle: 'Old', occurredAt: 1000, tokens: { input: 5 }, provider: 'claude', costUsd: 1 }),
    fact({ chatId: 'x', chatTitle: 'New', occurredAt: 3000, tokens: { input: 5 }, provider: 'codex' }),
    fact({ chatId: 'x', source: 'traycer', occurredAt: 2000, tokens: { input: 100 }, chatTitle: '' }),
    fact({ chatId: 'y', occurredAt: 500, tokens: { input: 50 } })
  ]
  const rows = agg.buildChatRows(facts, 'tokens')
  assert.deepEqual(rows.map((r) => r.key), ['traycer:x', 'prism:y', 'prism:x'])
  const x = rows[2]
  assert.equal(x.title, 'New'); assert.equal(x.turns, 2); assert.equal(x.unpricedTurns, 1); assert.equal(x.costUsd, 1)
  assert.deepEqual([...x.providers].sort(), ['claude', 'codex'])
  assert.deepEqual(x.facts.map((f) => f.occurredAt), [3000, 1000])
  assert.equal(rows[0].title, 'Chat sem título')
})

test('quartileThresholds and heatLevel', () => {
  assert.equal(agg.quartileThresholds([0, 0]), null)
  const th = agg.quartileThresholds([0, 1, 2, 3, 4, 5, 6, 7, 8])
  assert.equal(th.length, 3); assert.ok(th[0] <= th[1] && th[1] <= th[2])
  assert.equal(agg.heatLevel(0, 0, th), 0)
  assert.equal(agg.heatLevel(0, 2, th), 1)
  assert.equal(agg.heatLevel(8, 1, th), 4)
  assert.equal(agg.heatLevel(1, 1, th), 1)
  assert.equal(agg.heatLevel(5, 1, null), 0)
  const levels = [1, 2, 3, 4, 5, 6, 7, 8].map((v) => agg.heatLevel(v, 1, th))
  assert.deepEqual(levels, [...levels].sort())
})

test('buildHourGrid finds the peak', () => {
  const at = (h, d = 8) => Date.UTC(2026, 2, d, h) // 2026-03-08 is Sunday
  const facts = [fact({ occurredAt: at(0), tokens: { input: 5 } }), fact({ occurredAt: at(14, 9), tokens: { input: 50 } }), fact({ occurredAt: at(14, 9), tokens: { input: 5 } })]
  const g = agg.buildHourGrid(facts, 'tokens', 'UTC')
  assert.equal(g.values.length, 7); assert.equal(g.values[0].length, 24)
  assert.deepEqual(g.peak, { weekday: 1, hour: 14, value: 55 })
  assert.equal(g.values[0][0], 5); assert.equal(g.turns[1][14], 2)
  assert.equal(g.byHour[14], 55); assert.equal(g.byWeekday[0], 5)
  assert.equal(g.levels[1][14], 4)
  assert.equal(agg.buildHourGrid([], 'tokens', 'UTC').peak, null)
  // a measured turn with zero value shows the faintest level and no peak
  const z = agg.buildHourGrid([fact({ occurredAt: at(3) })], 'tokens', 'UTC')
  assert.equal(z.peak, null); assert.equal(z.levels[0][3], 1)
})

test('buildActivityCalendar: 365 days, Sunday-first weeks, month labels, streaks', () => {
  const end = '2026-10-09' // Friday
  const at = (d) => Date.UTC(2026, 9, d, 12)
  const facts = [7, 8, 9, 3, 2].map((d, i) => fact({ occurredAt: at(d), tokens: { input: 10 + i } }))
  const cal = agg.buildActivityCalendar(facts, end, 'tokens', 'UTC')
  const cells = cal.weeks.flatMap((w) => w.cells.filter(Boolean))
  assert.equal(cells.length, 365)
  assert.ok(cal.weeks.every((w) => w.cells.length === 7))
  assert.equal(cells[0].day, '2025-10-10'); assert.equal(cells.at(-1).day, end)
  assert.ok(cal.weeks.every((w) => time.weekdayOf(w.firstDay) === 0 || w === cal.weeks[0]))
  // first week is padded in front, last week padded behind (Fri => Sat slot is empty)
  assert.equal(cal.weeks.at(-1).cells[6], null)
  assert.equal(cal.weeks[0].cells[time.weekdayOf('2025-10-10') - 1], null)
  assert.equal(cal.monthLabels.length, 12)
  assert.ok(cal.monthLabels.every((m) => m.weekIndex > 0))
  assert.equal(cal.stats.activeDays, 5)
  assert.equal(cal.stats.longestStreakDays, 3)
  assert.equal(cal.stats.currentStreakDays, 3)
  assert.equal(cal.stats.mostActiveMonth, '2026-10')
  assert.equal(cal.stats.mostActiveDay, '2026-10-02') // 14 > 13 > 12 ...
  // an empty today does not break the current streak
  const gap = agg.buildActivityCalendar([8, 7].map((d) => fact({ occurredAt: at(d), tokens: { input: 1 } })), end, 'tokens', 'UTC')
  assert.equal(gap.stats.currentStreakDays, 2)
  // but an empty yesterday does
  const broken = agg.buildActivityCalendar([fact({ occurredAt: at(7), tokens: { input: 1 } })], end, 'tokens', 'UTC')
  assert.equal(broken.stats.currentStreakDays, 0)
  const none = agg.buildActivityCalendar([], end, 'tokens', 'UTC')
  assert.deepEqual([none.stats.mostActiveDay, none.stats.mostActiveMonth, none.stats.activeDays], [null, null, 0])
  // facts older than the span are ignored
  assert.equal(agg.buildActivityCalendar([fact({ occurredAt: Date.UTC(2024, 0, 1) })], end, 'tokens', 'UTC').stats.activeDays, 0)
})

/* ---------------- format ---------------- */
test('formatUsd', () => {
  assert.equal(nbsp(fmt.formatUsd(1.234)), 'US$ 1,23')
  assert.equal(nbsp(fmt.formatUsd(0)), 'US$ 0,00')
  assert.equal(nbsp(fmt.formatUsd(0.001)), '<US$ 0,01')
  assert.equal(nbsp(fmt.formatUsd(0.004999)), '<US$ 0,01')
  assert.equal(nbsp(fmt.formatUsd(0.005)), 'US$ 0,01')
  assert.equal(nbsp(fmt.formatUsd(1234.5)), 'US$ 1.234,50')
})

test('formatTokens / formatInteger / formatDuration', () => {
  assert.equal(nbsp(fmt.formatTokens(850)), '850')
  assert.match(nbsp(fmt.formatTokens(1_200_000)), /^1,2 (mi|M)/)
  assert.match(nbsp(fmt.formatTokens(12_000)), /^12 mil/)
  assert.equal(fmt.formatInteger(1234567), '1.234.567')
  assert.equal(fmt.formatDuration(null), '—')
  assert.equal(fmt.formatDuration(NaN), '—')
  assert.equal(fmt.formatDuration(0), '0s')
  assert.equal(fmt.formatDuration(400), '<1s')
  assert.equal(fmt.formatDuration(45_000), '45s')
  assert.equal(fmt.formatDuration(12 * 60_000), '12min')
  assert.equal(fmt.formatDuration((2 * 60 + 13) * 60_000), '2h 13min')
  assert.equal(fmt.formatDuration(2 * 3600_000), '2h')
  assert.equal(fmt.formatDuration((3 * 24 + 4) * 3600_000), '3d 4h')
  assert.equal(fmt.formatDuration(3 * 24 * 3600_000), '3d')
})

test('formatPercentChange uses a real minus sign', () => {
  assert.equal(fmt.formatPercentChange(12.3), '+12%')
  assert.equal(fmt.formatPercentChange(-8.54), '−8,5%')
  assert.equal(fmt.formatPercentChange(0), '0%')
  assert.equal(fmt.formatPercentChange(0.01), '0%')
  assert.equal(fmt.formatPercentChange(-0.01), '0%')
  assert.ok(fmt.formatPercentChange(-50).startsWith('\u2212'))
  assert.equal(fmt.formatPercentChange(4.26), '+4,3%')
})

test('day and month formatting', () => {
  assert.equal(fmt.formatDayShort('2026-10-09'), '9 out')
  assert.equal(fmt.formatDayLong('2026-10-09'), '9 out 2026')
  assert.equal(fmt.formatDayShort('garbage'), 'garbage')
  assert.equal(fmt.formatDayRange('2026-09-10', '2026-10-09'), '10 set – 9 out 2026')
  assert.equal(fmt.formatDayRange('2025-12-30', '2026-01-09'), '30 dez 2025 – 9 jan 2026')
  assert.equal(fmt.formatDayRange('2026-10-09', '2026-10-09'), '9 out 2026')
  assert.equal(fmt.formatMonth('2026-03'), 'mar 2026')
  assert.equal(fmt.formatMonth('x'), 'x')
})

test('redactEmail / redactEmails', () => {
  assert.equal(fmt.redactEmail('alice@example.com'), 'a•••@e…')
  assert.equal(fmt.redactEmail('nonsense'), '•••')
  assert.equal(fmt.redactEmail('@x.com'), '•••')
  const out = fmt.redactEmails('Conta alice@example.com e bob.s+t@mail.co.uk ok')
  assert.equal(out, 'Conta a•••@e… e b•••@m… ok')
  assert.equal(fmt.redactEmails('sem email'), 'sem email')
})

/* ---------------- export ---------------- */
test('csvCell escapes quotes, separators and formula injection', () => {
  assert.equal(exp.csvCell(null), ''); assert.equal(exp.csvCell(undefined), '')
  assert.equal(exp.csvCell(12.5), '12.5'); assert.equal(exp.csvCell(NaN), '')
  assert.equal(exp.csvCell('plain'), 'plain')
  assert.equal(exp.csvCell('a,b'), '"a,b"')
  assert.equal(exp.csvCell('say "hi"'), '"say ""hi"""')
  assert.equal(exp.csvCell('l1\nl2'), '"l1\nl2"')
  for (const c of ['=', '+', '-', '@']) assert.equal(exp.csvCell(`${c}SUM(A1)`), `'${c}SUM(A1)`)
  assert.equal(exp.csvCell('=1,2'), '"\'=1,2"')
  assert.equal(exp.csvCell('\tx'), "'\tx")
  assert.equal(exp.csvCell('a=b'), 'a=b')
  assert.equal(exp.csvCell(-3), '-3') // numbers are not text
})

test('factsToCsv: BOM, header, chronological order, empty cost when null', () => {
  const a = fact({ id: 'a', occurredAt: Date.UTC(2026, 9, 9, 15), costUsd: null, chatTitle: '=evil', turnId: 'ta' })
  const b = fact({ id: 'b', occurredAt: Date.UTC(2026, 9, 8, 3), costUsd: 0.1234567891, turnId: 'tb', durationMs: 1234, tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } })
  const csv = exp.factsToCsv([a, b], 'UTC')
  assert.equal(csv.charCodeAt(0), 0xfeff)
  const lines = csv.slice(1).split('\r\n')
  assert.equal(lines.at(-1), '')
  assert.ok(lines[0].startsWith('data_hora_utc,dia_local,hora_local,origem'))
  const head = lines[0].split(',')
  const row = (line) => Object.fromEntries(head.map((h, i) => [h, line.split(',')[i]]))
  const first = row(lines[1]), second = row(lines[2])
  assert.equal(first.turno_id, 'tb'); assert.equal(second.turno_id, 'ta')
  assert.equal(first.dia_local, '2026-10-08'); assert.equal(first.hora_local, '3')
  assert.equal(first.custo_usd, '0.123457'); assert.equal(second.custo_usd, '')
  assert.equal(first.duracao_s, '1.2')
  assert.equal(first.tokens_total, '10')
  assert.equal(first.resultado, 'concluido')
  assert.equal(second.chat, "'=evil")
  assert.equal(lines.length, 4)
  assert.equal(exp.factsToCsv([], 'UTC'), `﻿${head.join(',')}\r\n`)
})

test('buildUsageJson and exportFileName', () => {
  const facts = [fact({ provider: 'claude', occurredAt: Date.UTC(2026, 9, 9, 10), tokens: { input: 2 } }), fact({ provider: 'codex', occurredAt: Date.UTC(2026, 9, 8, 10), model: 'gpt' })]
  const window = { from: '2026-10-03', to: '2026-10-09', days: 7, granularity: 'day' }
  const json = JSON.parse(exp.buildUsageJson({
    facts, window, timeZone: 'UTC', filters: { provider: ['claude'], model: [], task: ['unknown-key'] }, metric: 'tokens',
    totals: agg.summarize(facts, 'UTC'), generatedAt: Date.UTC(2026, 9, 9, 12)
  }))
  assert.equal(json.format, 'prism-usage/1')
  assert.equal(json.generatedAt, '2026-10-09T12:00:00.000Z')
  assert.deepEqual(json.window, { from: '2026-10-03', to: '2026-10-09', days: 7, timeZone: 'UTC' })
  assert.deepEqual(json.filters, { provider: ['Claude'], task: ['unknown-key'] })
  assert.equal(json.metric, 'tokens')
  assert.equal(json.turns.length, 2)
  assert.equal(json.turns[0].provider, 'codex') // chronological
  assert.equal(json.turns[1].totalTokens, 2)
  assert.equal(json.totals.turns, 2)
  assert.equal(exp.exportFileName(window, 'csv'), 'prism-uso-2026-10-03_2026-10-09.csv')
  assert.equal(exp.exportFileName({ ...window, from: '2026-10-09', days: 1 }, 'json'), 'prism-uso-2026-10-09.json')
})

/* ---------------- main/ipc/usage.ts ---------------- */
function usageFixture(t, { epics = true, withEpicHomes = true, withAccounts = true, host: viaHost = false } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-usage-test-'))
  const userData = path.join(tmp, 'prism')
  const root = path.join(tmp, '.traycer')
  const spies = { clipboard: [], save: [], reveal: [], images: [] }
  const stub = {
    rootPath(p) {
      const r = fs.realpathSync(path.resolve(p || root))
      if (!fs.existsSync(path.join(r, 'host'))) throw new Error('Selecione a pasta .traycer que contém a pasta host.')
      return r
    },
    database(r, epicId) { return new DatabaseSync(path.join(r, 'host', 'epic-state', epicId, 'chat', 'chat.db'), { readOnly: true }) }
  }
  let profileList = [{ id: 'prof-1', name: 'Minha Conta' }]
  const store = { chats: [], tasks: [] }
  const electron = {
    app: { getPath: (n) => n === 'downloads' ? path.join(tmp, 'dl') : userData, on() {} },
    BrowserWindow: {}, ipcMain: {}, shell: { showItemInFolder: (p) => spies.reveal.push(p) },
    clipboard: { writeImage: (i) => spies.clipboard.push(i) },
    nativeImage: { createFromBuffer: (b) => { const img = { bytes: b, isEmpty: () => b.length < 2 }; spies.images.push(img); return img } },
    dialog: { showSaveDialog: async (...a) => { spies.save.push(a); return { canceled: false, filePath: path.join(tmp, 'saved.csv') } } }
  }
  fs.mkdirSync(userData, { recursive: true })
  const hostDir = path.join(tmp, 'host-data')
  const agentStore = { get: (k) => store[k], readState: (_key, fallback) => fallback }
  const reads = { chats: 0, tasks: 0 }
  // ipc: a fachada de verdade sem binário do host (lê o agentStore); host: simulada, que lê só o `store`.
  const hostChats = viaHost
    ? { chatsBackend: async () => 'host', listChats: async () => { reads.chats++; return store.chats }, listTasks: async () => { reads.tasks++; return { tasks: store.tasks, openIds: [], activeId: null } } }
    : load('src/main/hostChats.ts', {
      './providers': { agentStore }, './host/supervisor': { hostBinaryPresent: () => false },
      './host/mainClient': { mainHostClient: () => { throw new Error('o cliente do host não deve ser criado sem binário') } },
      './ipc/providerProfiles': load('src/main/ipc/providerProfiles.ts')
    })
  const api = load('src/main/ipc/usage.ts', {
    electron, fs, path, 'node:sqlite': { DatabaseSync },
    '../providers': { agentStore, profiles: () => profileList },
    '../hostChats': hostChats, '../host/supervisor': { hostDataDir: () => hostDir },
    './traycerImport': stub
  })
  const state = { tmp, userData, hostDir, root, api, store, spies, reads, setProfiles: (p) => { profileList = p } }
  t.after(() => { api.closeUsageStore(); fs.rmSync(tmp, { recursive: true, force: true }) })
  if (epics) buildTraycer(state, { withEpicHomes, withAccounts })
  return state
}

const EPIC = 'epic-1'
function chatDb(root, epic = EPIC) {
  const dir = path.join(root, 'host', 'epic-state', epic, 'chat')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'chat.db')
  const db = new DatabaseSync(file)
  db.exec(`CREATE TABLE chat_projection_head (chat_id TEXT PRIMARY KEY,title TEXT,lifecycle_state TEXT,settings_json TEXT,parent_chat_id TEXT,created_at INTEGER);
    CREATE TABLE chat_event (chat_id TEXT,turn_id TEXT,event_type TEXT,body TEXT,insert_seq INTEGER PRIMARY KEY AUTOINCREMENT);
    CREATE TABLE chat_message (chat_id TEXT,turn_key TEXT,body TEXT,removed_seq INTEGER,insert_seq INTEGER PRIMARY KEY AUTOINCREMENT);
    CREATE TABLE chat_row_index (chat_id TEXT,unit_key TEXT,role TEXT,unit_state TEXT);
    CREATE TABLE chat_db_meta (key TEXT PRIMARY KEY,value TEXT);
    INSERT INTO chat_db_meta VALUES ('schema_version','42');`)
  return { db, file }
}
const ev = (db, chat, turn, type, body) => db.prepare('INSERT INTO chat_event (chat_id,turn_id,event_type,body) VALUES (?,?,?,?)').run(chat, turn, type, JSON.stringify(body))
function addTurn(db, chat, turn, { harness, model, label, profileId, session, workspace, start, end, usage, kind = 'completed', severity }) {
  ev(db, chat, turn, 'turn.started', { timestamp: start })
  if (kind === 'completed') ev(db, chat, turn, 'turn.completed', { timestamp: end, metadata: usage ? { usage } : {} })
  else if (kind === 'interrupted') ev(db, chat, turn, 'turn.interrupted', { timestamp: end, severity })
  db.prepare('INSERT INTO chat_message (chat_id,turn_key,body) VALUES (?,?,?)').run(chat, turn,
    JSON.stringify({ role: 'assistant', sender: { harnessId: harness, agentId: model }, turnProfile: { labelSnapshot: label, profileId }, startedAt: start }))
  db.prepare('INSERT INTO chat_row_index VALUES (?,?,?,?)').run(chat, `t:${turn}`, 'assistant',
    JSON.stringify({ sessionAnchor: { sessionId: session, sessionWorkspaceSnapshot: { primaryWorkspace: workspace }, labelSnapshot: label, profileId, harnessId: harness } }))
}

function buildTraycer(state, { withEpicHomes, withAccounts }) {
  const { db, file } = chatDb(state.root)
  const head = db.prepare('INSERT INTO chat_projection_head VALUES (?,?,?,?,?,?)')
  head.run('chat-a', 'Claude chat', 'active', JSON.stringify({ harnessId: 'claude-code', model: 'opus' }), null, 1)
  head.run('chat-b', 'Codex chat', 'active', JSON.stringify({ harnessId: 'codex' }), null, 2)
  head.run('chat-del', 'Deleted', 'deleted', '{}', null, 3)
  const ws = path.join(state.tmp, 'work', 'MyProject')
  const claudeUsage = (cost) => ({ inputTokens: 100, outputTokens: 40, cacheReadInputTokens: 500, cacheCreationInputTokens: 20, costUsd: cost })
  addTurn(db, 'chat-a', 'a1', { harness: 'claude-code', model: 'opus', label: 'Terminal account', session: 's-a', workspace: ws, start: 1_000_000, end: 1_005_000, usage: claudeUsage(0.5) })
  addTurn(db, 'chat-a', 'a2', { harness: 'claude-code', model: 'opus', label: 'Terminal account', session: 's-a', workspace: ws, start: 2_000_000, end: 2_005_000, usage: claudeUsage(0.75) })
  addTurn(db, 'chat-a', 'a3', { harness: 'claude-code', model: 'opus', label: 'Terminal account', session: 's-a', workspace: ws, start: 3_000_000, end: 0, kind: 'running' })
  addTurn(db, 'chat-b', 'b1', { harness: 'codex', model: 'gpt-x', label: 'Work Codex', profileId: 'cx', session: 's-b', workspace: ws, start: 1_500_000, end: 1_502_000, usage: { inputTokens: 1000, outputTokens: 50, cacheReadInputTokens: 800, cacheCreationInputTokens: 0 } })
  addTurn(db, 'chat-b', 'b2', { harness: 'codex', model: 'gpt-x', label: 'Work Codex', profileId: 'cx', session: 's-b', workspace: ws, start: 1_600_000, end: 1_601_000, kind: 'interrupted', severity: 'error' })
  addTurn(db, 'chat-b', 'b3', { harness: 'codex', model: 'gpt-x', label: 'Work Codex', profileId: 'cx', session: 's-b', workspace: ws, start: 1_700_000, end: 1_701_000, kind: 'interrupted', severity: 'info' })
  addTurn(db, 'chat-del', 'd1', { harness: 'codex', model: 'gpt-x', label: 'x', start: 1, end: 2, usage: { inputTokens: 1 } })
  db.close()
  if (withEpicHomes) {
    const homes = path.join(state.root, 'host', 'epic-homes')
    fs.mkdirSync(homes, { recursive: true })
    const h = new DatabaseSync(path.join(homes, 'epic-homes.db'))
    h.exec('CREATE TABLE local_epic (epic_id TEXT PRIMARY KEY, list_projection_json TEXT)')
    h.prepare('INSERT INTO local_epic VALUES (?,?)').run(EPIC, JSON.stringify({ title: 'Minha Tarefa' }))
    h.close()
  }
  if (withAccounts) {
    fs.mkdirSync(path.join(state.root, 'host', 'config'), { recursive: true })
    fs.writeFileSync(path.join(state.root, 'host', 'config', 'provider-accounts.json'), JSON.stringify({ profiles: [{ profileId: 'cx', label: 'Ignored Label' }] }))
  }
  return file
}

const snapshot = (file) => ({ bytes: fs.readFileSync(file), mtime: fs.statSync(file).mtimeMs })

test('importTraycerUsage imports finished turns of live chats with normalized fields', async (t) => {
  const f = usageFixture(t)
  const dbFile = path.join(f.root, 'host', 'epic-state', EPIC, 'chat', 'chat.db')
  const before = snapshot(dbFile)
  const state = await f.api.importTraycerUsage(f.root)
  assert.equal(state.status, 'ok', state.error)
  assert.equal(state.tasks, 1)
  assert.equal(state.chats, 2)
  assert.equal(state.turns, 5) // a1 a2 b1 b2 b3 (a3 still running, chat-del deleted)
  assert.equal(state.added, 5); assert.equal(state.updated, 0); assert.equal(state.unchanged, 0)
  assert.deepEqual(state.warnings, [])
  const { observations, importState } = (await f.api.usageRecords())
  assert.equal(importState.status, 'ok')
  const o = (turn) => observations.find((x) => x.turnId === turn)
  assert.equal(observations.length, 5)
  assert.equal(o('a3'), undefined)
  assert.equal(observations.some((x) => x.turnId === 'd1'), false)
  const a1 = o('a1')
  assert.equal(a1.provider, 'claude'); assert.equal(a1.source, 'traycer')
  assert.equal(a1.profileName, 'Conta do terminal')
  assert.equal(a1.taskTitle, 'Minha Tarefa'); assert.equal(a1.taskId, EPIC)
  assert.equal(a1.project, 'MyProject'); assert.equal(a1.sessionKey, 's-a')
  assert.equal(a1.chatId, `${EPIC}/chat-a`); assert.equal(a1.model, 'opus')
  assert.equal(a1.tokenBasis, 'last-call'); assert.equal(a1.costBasis, 'cumulative'); assert.equal(a1.costUsd, 0.5)
  assert.equal(a1.inputTokens, 100); assert.equal(a1.cacheReadTokens, 500); assert.equal(a1.cacheWriteTokens, 20); assert.equal(a1.outputTokens, 40)
  assert.equal(a1.durationMs, 5000); assert.equal(a1.outcome, 'completed'); assert.equal(a1.completedAt, 1_005_000)
  const b1 = o('b1')
  assert.equal(b1.provider, 'codex'); assert.equal(b1.inputTokens, 200) // 1000 - 800 cached
  assert.equal(b1.cacheReadTokens, 800); assert.equal(b1.costBasis, 'none'); assert.equal(b1.costUsd, null)
  assert.equal(b1.profileName, 'Work Codex'); assert.equal(b1.profileId, 'cx')
  const b2 = o('b2')
  assert.equal(b2.outcome, 'error'); assert.equal(b2.tokenBasis, 'none'); assert.equal(b2.inputTokens, null)
  assert.equal(o('b3').outcome, 'interrupted')
  // the Traycer database is untouched
  const after = snapshot(dbFile)
  assert.ok(before.bytes.equals(after.bytes)); assert.equal(before.mtime, after.mtime)
  // and the facts derive sensibly: second Claude turn pays the cost difference
  const deltas_ = load(dir + 'deltas.ts')
  const facts = deltas_.deriveTurnUsage(observations)
  assert.equal(facts.find((x) => x.turnId === 'a2').costUsd, 0.25)
})

test('reimporting is idempotent; a Traycer change becomes updated', async (t) => {
  const f = usageFixture(t)
  await f.api.importTraycerUsage(f.root)
  const again = await f.api.importTraycerUsage(f.root)
  assert.equal(again.added, 0); assert.equal(again.updated, 0); assert.equal(again.unchanged, 5)
  assert.equal((await f.api.usageRecords()).observations.length, 5)
  const db = new DatabaseSync(path.join(f.root, 'host', 'epic-state', EPIC, 'chat', 'chat.db'))
  db.prepare("UPDATE chat_event SET body=? WHERE turn_id='a1' AND event_type='turn.completed'")
    .run(JSON.stringify({ timestamp: 1_005_000, metadata: { usage: { inputTokens: 999, outputTokens: 40, cacheReadInputTokens: 500, cacheCreationInputTokens: 20, costUsd: 0.5 } } }))
  db.close()
  const changed = await f.api.importTraycerUsage(f.root)
  assert.equal(changed.updated, 1); assert.equal(changed.added, 0); assert.equal(changed.unchanged, 4)
  assert.equal((await f.api.usageRecords()).observations.find((x) => x.turnId === 'a1').inputTokens, 999)
  // the stored state survives a store reopen
  f.api.closeUsageStore()
  assert.equal(f.api.importState().updated, 1)
  assert.equal((await f.api.usageRecords()).observations.length, 5)
})

test('task title falls back to the root chat when epic-homes is absent; labels come from accounts file', async (t) => {
  const f = usageFixture(t, { withEpicHomes: false, withAccounts: false })
  const db = new DatabaseSync(path.join(f.root, 'host', 'epic-state', EPIC, 'chat', 'chat.db'))
  db.prepare("DELETE FROM chat_message WHERE turn_key='b1'").run()
  db.prepare("INSERT INTO chat_message (chat_id,turn_key,body) VALUES ('chat-b','b1',?)").run(JSON.stringify({ role: 'assistant', sender: { harnessId: 'codex', agentId: 'gpt-x' }, turnProfile: { profileId: 'cx' } }))
  db.close()
  const state = await f.api.importTraycerUsage(f.root)
  assert.equal(state.status, 'ok', state.error)
  const { observations } = (await f.api.usageRecords())
  assert.equal(observations.find((x) => x.turnId === 'a1').taskTitle, 'Claude chat') // earliest root chat
  // no label anywhere on this turn (anchor still has one though)
  assert.equal(observations.find((x) => x.turnId === 'b1').profileName, 'Work Codex')
})

test('account file supplies a label when the turn has none', async (t) => {
  const f = usageFixture(t)
  const db = new DatabaseSync(path.join(f.root, 'host', 'epic-state', EPIC, 'chat', 'chat.db'))
  db.prepare("UPDATE chat_row_index SET unit_state=? WHERE unit_key='t:b1'").run(JSON.stringify({ sessionAnchor: { sessionId: 's-b', profileId: 'cx', harnessId: 'codex' } }))
  db.prepare("DELETE FROM chat_message WHERE turn_key='b1'").run()
  db.prepare("INSERT INTO chat_message (chat_id,turn_key,body) VALUES ('chat-b','b1',?)").run(JSON.stringify({ role: 'assistant', sender: { harnessId: 'codex', agentId: 'gpt-x' }, turnProfile: { profileId: 'cx' } }))
  db.close()
  await f.api.importTraycerUsage(f.root)
  assert.equal((await f.api.usageRecords()).observations.find((x) => x.turnId === 'b1').profileName, 'Ignored Label')
})

test('unknown schema becomes a readable warning with the version and does not stop the import', async (t) => {
  const f = usageFixture(t)
  const { db } = chatDb(f.root, 'epic-bad')
  db.exec('DROP TABLE chat_event; CREATE TABLE chat_event (chat_id TEXT, body TEXT);')
  db.close()
  const state = await f.api.importTraycerUsage(f.root)
  assert.equal(state.status, 'ok', state.error)
  assert.equal(state.turns, 5)
  assert.equal(state.warnings.length, 1)
  assert.match(state.warnings[0], /formato do banco do Traycer não reconhecido \(versão 42\)/)
  assert.match(state.warnings[0], /epic-bad/)
})

test('a folder without host yields status error with a message and keeps prior counts', async (t) => {
  const f = usageFixture(t)
  const ok = await f.api.importTraycerUsage(f.root)
  const empty = path.join(f.tmp, 'empty')
  fs.mkdirSync(empty)
  const bad = await f.api.importTraycerUsage(empty)
  assert.equal(bad.status, 'error')
  assert.match(bad.error, /pasta host/)
  assert.equal(bad.turns, ok.turns)
  assert.equal(f.api.importState().status, 'error')
  assert.equal((await f.api.usageRecords()).observations.length, 5) // data kept
})

test('a root with no epics warns instead of failing', async (t) => {
  const f = usageFixture(t, { epics: false })
  fs.mkdirSync(path.join(f.root, 'host'), { recursive: true })
  const state = await f.api.importTraycerUsage(f.root)
  assert.equal(state.status, 'ok')
  assert.equal(state.turns, 0)
  assert.equal(state.warnings.length, 1)
})

test('importState starts as never', (t) => {
  const f = usageFixture(t, { epics: false })
  const s = f.api.importState()
  assert.equal(s.status, 'never'); assert.equal(s.at, null)
})

const chat = (o) => ({ id: 'chat-1', title: 'Prism chat', cwd: 'C:\\code\\Proj', taskId: null, updatedAt: 9000, selection: { provider: 'claude', profileId: 'prof-1' }, turns: [], ...o })
const aTurn = (o) => ({ id: 't', role: 'assistant', startedAt: 1000, completedAt: 2000, ...o })

test('usageRecords merges Prism and Traycer observations and links prismChatId', async (t) => {
  const f = usageFixture(t)
  await f.api.importTraycerUsage(f.root)
  f.store.tasks = [{ id: 'task-9', title: 'Prism task' }]
  f.store.chats = [
    chat({ id: 'p1', taskId: 'task-9', traycerSource: { epicId: EPIC, chatId: 'chat-a' }, turns: [aTurn({ id: 'x1', provider: 'claude', model: 'opus', metrics: { inputTokens: 5, outputTokens: 6, costUsd: 1.5 } })] }),
    chat({ id: 'p2', turns: [aTurn({ id: 'imported' , startedAt: undefined, completedAt: undefined })] })
  ]
  const { observations } = (await f.api.usageRecords())
  const prism = observations.filter((o) => o.source === 'prism')
  assert.equal(prism.length, 1)
  assert.equal(prism[0].id, 'prism:p1:x1'); assert.equal(prism[0].taskTitle, 'Prism task'); assert.equal(prism[0].project, 'Proj')
  assert.equal(prism[0].profileName, 'Minha Conta')
  const tr = observations.filter((o) => o.source === 'traycer')
  assert.equal(tr.length, 5)
  assert.ok(tr.filter((o) => o.chatId === `${EPIC}/chat-a`).every((o) => o.prismChatId === 'p1'))
  assert.ok(tr.filter((o) => o.chatId === `${EPIC}/chat-b`).every((o) => o.prismChatId === null))
})

test('prismObservations skips turns without startedAt+metrics, user turns and the pending turn', (t) => {
  const f = usageFixture(t, { epics: false })
  const chats = [chat({
    pendingTurnId: 'pend', turns: [
      aTurn({ id: 'user', role: 'user' }),
      aTurn({ id: 'pend', metrics: { inputTokens: 1 } }),
      aTurn({ id: 'blank', startedAt: undefined, completedAt: undefined }),
      aTurn({ id: 'metricsonly', startedAt: undefined, completedAt: undefined, metrics: { inputTokens: 1 } }),
      aTurn({ id: 'err', error: true }), aTurn({ id: 'int', interrupted: true }), aTurn({ id: 'ok' })
    ]
  })]
  const out = f.api.prismObservations(chats, [], new Map([['prof-1', 'Conta Um']]), new Map())
  assert.deepEqual(out.map((o) => o.turnId), ['metricsonly', 'err', 'int', 'ok'])
  assert.equal(out[0].startedAt, 9000) // falls back to chat.updatedAt
  assert.deepEqual(out.slice(1).map((o) => o.outcome), ['error', 'interrupted', 'completed'])
  assert.equal(out[3].profileName, 'Conta Um'); assert.equal(out[3].durationMs, 1000)
  // journal supplies session and route (provider:profile)
  const j = f.api.prismObservations(chats, [], new Map([['other', 'Outra']]), new Map([['chat-1\0ok', { sessionId: 'sess', route: 'codex:other' }]]))
  const ok = j.find((o) => o.turnId === 'ok')
  assert.equal(ok.sessionKey, 'sess'); assert.equal(ok.provider, 'codex'); assert.equal(ok.profileId, 'other'); assert.equal(ok.profileName, 'Outra')
  assert.equal(f.api.prismObservations([chat({ turns: [aTurn({ profileName: undefined })], selection: { provider: 'claude', profileId: null } })], [], new Map(), new Map())[0].profileName, 'Conta do terminal')
})

test('prismCounters per provider and turn capture', (t) => {
  const f = usageFixture(t, { epics: false })
  const codex = f.api.prismCounters('codex', { inputTokens: 1000, cachedTokens: 300, outputTokens: 50, reasoningTokens: 10, costUsd: 9 })
  assert.deepEqual(codex, { tokenBasis: 'cumulative', costBasis: 'none', inputTokens: 700, cacheReadTokens: 300, cacheWriteTokens: null, outputTokens: 50, reasoningTokens: 10, costUsd: null })
  assert.equal(f.api.prismCounters('codex', { inputTokens: 100, cachedTokens: 300 }).inputTokens, 0)
  const claude = f.api.prismCounters('claude', { inputTokens: 10, cachedTokens: 20, outputTokens: 5, costUsd: 2 })
  assert.equal(claude.tokenBasis, 'turn'); assert.equal(claude.costBasis, 'cumulative'); assert.equal(claude.costUsd, 2); assert.equal(claude.inputTokens, 10)
  assert.equal(f.api.prismCounters('claude', { inputTokens: 10 }).costBasis, 'none')
  const turn = f.api.prismCounters('codex', { inputTokens: 1, turn: { inputTokens: 4, cacheReadTokens: 3, cacheWriteTokens: 2, outputTokens: 1, reasoningTokens: 1, costUsd: 0.2 } })
  assert.deepEqual(turn, { tokenBasis: 'turn', costBasis: 'turn', inputTokens: 4, cacheReadTokens: 3, cacheWriteTokens: 2, outputTokens: 1, reasoningTokens: 1, costUsd: 0.2 })
  assert.equal(f.api.prismCounters('claude', { turn: { inputTokens: 4 } }).costBasis, 'none')
  const none = f.api.prismCounters('claude', undefined)
  assert.equal(none.tokenBasis, 'none'); assert.equal(none.costUsd, null)
})

test('safeFileName, describeTraycerError, projectName, normalizeHarness', (t) => {
  const f = usageFixture(t, { epics: false })
  assert.equal(f.api.safeFileName('../../etc/passwd.txt', 'csv'), 'passwd.csv')
  assert.equal(f.api.safeFileName('a\\b\\rel:a"t|o?*rio.png', 'csv'), 'relatorio.csv')
  assert.equal(f.api.safeFileName('', 'json'), 'prism-uso.json')
  assert.equal(f.api.safeFileName(undefined, 'png'), 'prism-uso.png')
  assert.equal(f.api.safeFileName(42, 'png'), 'prism-uso.png')
  assert.equal(f.api.safeFileName('noext', 'csv'), 'noext.csv')
  assert.ok(f.api.safeFileName('x'.repeat(500), 'csv').length <= 124)
  assert.match(f.api.describeTraycerError(new Error('database is locked')), /em uso/)
  assert.match(f.api.describeTraycerError(new Error('SQLITE_BUSY')), /em uso/)
  assert.match(f.api.describeTraycerError(new Error('no such table: x')), /não reconhecido/)
  assert.match(f.api.describeTraycerError(new Error('unable to open database file')), /não foi possível abrir/)
  assert.equal(f.api.describeTraycerError('plain'), 'plain')
  assert.equal(f.api.describeTraycerError(new f.api.UnknownTraycerSchema('custom')), 'custom')
  assert.equal(f.api.projectName('C:\\a\\b\\Proj\\'), 'Proj'); assert.equal(f.api.projectName(''), null); assert.equal(f.api.projectName(null), null)
  assert.equal(f.api.normalizeHarness('claude-code'), 'claude'); assert.equal(f.api.normalizeHarness('CODEX'), 'codex')
  assert.equal(f.api.normalizeHarness(null), 'traycer')
})

test('copyImage rejects empty/invalid bytes and writes valid ones', (t) => {
  const f = usageFixture(t, { epics: false })
  assert.throws(() => f.api.copyImage(new Uint8Array(0)), /Imagem inválida/)
  assert.throws(() => f.api.copyImage('text'), /Imagem inválida/)
  assert.throws(() => f.api.copyImage(null), /Imagem inválida/)
  assert.equal(f.spies.clipboard.length, 0)
  assert.throws(() => f.api.copyImage(new Uint8Array([1])), /Imagem inválida/) // mock image reports empty
  f.api.copyImage(new Uint8Array([1, 2, 3]))
  assert.equal(f.spies.clipboard.length, 1)
})

test('saveFile validates the request, sanitizes the name and writes the chosen path', async (t) => {
  const f = usageFixture(t, { epics: false })
  await assert.rejects(f.api.saveFile(null, { kind: 'exe', data: 'x' }), /Formato/)
  await assert.rejects(f.api.saveFile(null, null), /Formato/)
  await assert.rejects(f.api.saveFile(null, { kind: 'csv', data: 5 }), /Conteúdo/)
  await assert.rejects(f.api.saveFile(null, { kind: 'png', data: new Uint8Array(0) }), /Imagem inválida/)
  assert.equal(f.spies.save.length, 0)
  const saved = await f.api.saveFile(null, { kind: 'csv', fileName: '../x/relatorio.json', data: 'a,b' })
  assert.equal(saved, path.join(f.tmp, 'saved.csv'))
  assert.equal(fs.readFileSync(saved, 'utf8'), 'a,b')
  const options = f.spies.save[0][0]
  assert.equal(path.basename(options.defaultPath), 'relatorio.csv')
  assert.deepEqual(options.filters[0].extensions, ['csv'])
})

test('closeUsageStore is safe to call repeatedly', (t) => {
  const f = usageFixture(t, { epics: false })
  f.api.importState()
  f.api.closeUsageStore(); f.api.closeUsageStore()
  assert.equal(f.api.importState().status, 'never')
})

/* ---------------- com o host dono dos chats (T07): leitura pela fachada e diários ---------------- */

/** Um banco de diário (`events`) com os corpos dados, como o do agentStore (0.2) e o do host. */
function journalDb(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT, turn_id TEXT, body TEXT)')
  const insert = db.prepare('INSERT INTO events (chat_id,turn_id,body) VALUES (?,?,?)')
  for (const [chatId, turnId, body] of rows) insert.run(chatId, turnId, typeof body === 'string' ? body : JSON.stringify(body))
  db.close()
}

function journalChats(f) {
  f.store.tasks = [{ id: 'task-9', title: 'Tarefa do host' }]
  f.store.chats = [chat({ id: 'p1', taskId: 'task-9', turns: [aTurn({ id: 'x1' }), aTurn({ id: 'x2' }), aTurn({ id: 'x3' })] })]
}
const prismTurns = (observations) => Object.fromEntries(observations.filter((o) => o.source === 'prism').map((o) => [o.turnId, o]))

test('host: usageRecords é assíncrona e lê chats e tarefas pela fachada', async (t) => {
  const f = usageFixture(t, { epics: false, host: true })
  journalChats(f)
  const pending = f.api.usageRecords()
  assert.equal(typeof pending.then, 'function')
  const { observations } = await pending
  assert.equal(f.reads.chats, 1); assert.equal(f.reads.tasks, 1)
  const turns = prismTurns(observations)
  assert.deepEqual(Object.keys(turns), ['x1', 'x2', 'x3'])
  assert.equal(turns.x1.taskTitle, 'Tarefa do host')
  assert.equal(turns.x1.profileName, 'Minha Conta')
})

test('ipc: usageRecords lê chats e tarefas do agentStore pela fachada real e só o prism-agents.db', async (t) => {
  const f = usageFixture(t, { epics: false })
  journalChats(f)
  journalDb(path.join(f.userData, 'prism-agents.db'), [
    ['p1', 'x1', { kind: 'begin', route: 'codex:other' }],
    // Chaves fora de ordem: a busca não depende de "kind" vir primeiro.
    ['p1', 'x1', '{"sessionId":"agents-s1","kind":"session"}'],
    ['p1', 'x2', { kind: 'session', sessionId: 'agents-s2' }],
    // Texto transmitido que cita o JSON entre aspas escapadas nunca vira sessão.
    ['p1', 'x3', { kind: 'delta', text: 'veja "kind":"session","sessionId":"falso" no log' }]
  ])
  // O banco do host existe, mas no ipc não é lido.
  journalDb(path.join(f.hostDir, 'prism-host.db'), [['p1', 'x3', { kind: 'session', sessionId: 'host-s3' }]])
  const turns = prismTurns((await f.api.usageRecords()).observations)
  assert.equal(turns.x1.taskTitle, 'Tarefa do host')
  assert.equal(turns.x1.sessionKey, 'agents-s1')
  assert.equal(turns.x1.provider, 'codex'); assert.equal(turns.x1.profileId, 'other')
  assert.equal(turns.x2.sessionKey, 'agents-s2')
  assert.equal(turns.x3.sessionKey, null)
})

test('host: journalTurns junta prism-agents.db e <hostDataDir>/prism-host.db, e o do host vence na mesma chave', async (t) => {
  const f = usageFixture(t, { epics: false, host: true })
  journalChats(f)
  journalDb(path.join(f.userData, 'prism-agents.db'), [
    ['p1', 'x1', { kind: 'begin', route: 'codex:other' }],
    ['p1', 'x1', { kind: 'session', sessionId: 'agents-s1' }],
    ['p1', 'x2', { kind: 'session', sessionId: 'agents-s2' }]
  ])
  journalDb(path.join(f.hostDir, 'prism-host.db'), [
    ['p1', 'x1', '{"sessionId":"host-s1","kind":"session"}'], // fora de ordem
    ['p1', 'x1', '{"route":"claude:prof-1","kind":"begin"}'],
    ['p1', 'x3', { kind: 'session', sessionId: 'host-s3' }]
  ])
  const turns = prismTurns((await f.api.usageRecords()).observations)
  assert.equal(turns.x1.sessionKey, 'host-s1') // o host vence
  assert.equal(turns.x1.provider, 'claude'); assert.equal(turns.x1.profileId, 'prof-1')
  assert.equal(turns.x2.sessionKey, 'agents-s2') // só no prism-agents.db (SSH)
  assert.equal(turns.x3.sessionKey, 'host-s3') // só no host
})

test('host: um diário ausente ou ilegível não derruba usageRecords', async (t) => {
  const f = usageFixture(t, { epics: false, host: true })
  journalChats(f)
  fs.mkdirSync(f.hostDir, { recursive: true })
  fs.writeFileSync(path.join(f.hostDir, 'prism-host.db'), 'isto não é um banco sqlite')
  journalDb(path.join(f.userData, 'prism-agents.db'), [['p1', 'x1', { kind: 'session', sessionId: 'agents-s1' }]])
  const turns = prismTurns((await f.api.usageRecords()).observations)
  assert.equal(turns.x1.sessionKey, 'agents-s1')
  fs.rmSync(path.join(f.userData, 'prism-agents.db'))
  fs.rmSync(path.join(f.hostDir, 'prism-host.db'))
  assert.equal(prismTurns((await f.api.usageRecords()).observations).x1.sessionKey, null)
})
