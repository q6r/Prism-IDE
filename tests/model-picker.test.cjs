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
const usage = (prism) => {
  global.window = { prism }
  return load('src/renderer/src/lib/providerUsage.ts', { zustand: fakeZustand() })
}
const U = usage({})
const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR

test('windowSeverity thresholds', () => {
  assert.equal(U.windowSeverity(79, 300), 'healthy')
  assert.equal(U.windowSeverity(80, 300), 'running_low')
  assert.equal(U.windowSeverity(80, 1440), 'running_low')
  assert.equal(U.windowSeverity(80, 10080), 'healthy')
  assert.equal(U.windowSeverity(94, undefined), 'healthy')
  assert.equal(U.windowSeverity(95, undefined), 'running_low')
  assert.equal(U.windowSeverity(100, 300), 'limited')
  assert.equal(U.windowSeverity(120, 10080), 'limited')
})

test('windowLabel', () => {
  const l = (windowMinutes, name) => U.windowLabel({ id: 'x', usedPercent: 1, windowMinutes, name })
  assert.equal(l(300), 'Sessão atual')
  assert.equal(l(10080), 'Semanal')
  assert.equal(l(10080, 'Opus'), 'Opus · Semanal')
  assert.equal(l(undefined), 'Uso')
  assert.equal(l(1440), '1d')
  assert.equal(l(120), '2h')
  assert.equal(l(45), '45m')
})

test('usageWindows converts seconds to ms', () => {
  const [w] = U.usageWindows({ limits: [{ id: 'a', usedPercent: 85, resetsAt: 1000, windowMinutes: 300 }] })
  assert.equal(w.resetsAt, 1_000_000)
  assert.equal(w.severity, 'running_low')
  assert.equal(w.label, 'Sessão atual')
  assert.deepEqual(U.usageWindows(undefined), [])
})

test('projectUsage', () => {
  const now = 10 * DAY
  assert.deepEqual({ ...U.projectUsage(undefined, now) }, { kind: 'not_checked', checkedAt: null })
  assert.equal(U.projectUsage({ fetching: false }, now).kind, 'not_checked')
  const un = U.projectUsage({ fetching: false, details: { limits: [], error: 'boom', updatedAt: 5 } }, now)
  assert.equal(un.kind, 'unavailable'); assert.equal(un.failed, true); assert.equal(un.message, 'boom')
  const un2 = U.projectUsage({ fetching: false, details: { limits: [], unavailable: 'nada' } }, now)
  assert.equal(un2.failed, false); assert.equal(un2.message, 'nada')
  const limits = [{ id: 'a', usedPercent: 50, windowMinutes: 300 }, { id: 'b', usedPercent: 96, windowMinutes: 10080 }, { id: 'c', usedPercent: 82, windowMinutes: 300 }]
  const fresh = U.projectUsage({ fetching: false, details: { limits, updatedAt: now - MIN } }, now)
  assert.equal(fresh.kind, 'detail'); assert.equal(fresh.compact.id, 'b'); assert.equal(fresh.severity, 'running_low')
  assert.equal(U.projectUsage({ fetching: false, details: { limits, updatedAt: now - 6 * MIN } }, now).kind, 'stale')
  assert.equal(U.projectUsage({ fetching: false, details: { limits, updatedAt: now, stale: true } }, now).kind, 'stale')
  const err = U.projectUsage({ fetching: false, details: { limits, updatedAt: now, error: 'x' } }, now)
  assert.equal(err.kind, 'stale'); assert.equal(err.failed, true)
  const lim = U.projectUsage({ fetching: false, details: { limits: [{ id: 'a', usedPercent: 99, windowMinutes: 10080 }, { id: 'b', usedPercent: 100, windowMinutes: 300 }], updatedAt: now } }, now)
  assert.equal(lim.compact.id, 'b')
  const dropped = U.projectUsage({ fetching: false, details: { limits: [{ id: 'a', usedPercent: 0, resetsAt: 1, windowMinutes: 300 }], updatedAt: now } }, now)
  assert.equal(dropped.kind, 'unavailable')
})

test('relativeTime', () => {
  const now = 100 * DAY
  assert.equal(U.relativeTime(now - 30000, now), 'agora mesmo')
  assert.equal(U.relativeTime(now - 19 * MIN, now), 'há 19 min')
  assert.equal(U.relativeTime(now - 3 * HOUR, now), 'há 3 h')
  assert.equal(U.relativeTime(now - 30 * HOUR, now), 'ontem')
  const old = now - 5 * DAY
  assert.equal(U.relativeTime(old, now), new Date(old).toLocaleDateString('pt-BR', { day: 'numeric', month: 'short' }))
})

test('resetCountdown and resetLabel', () => {
  const now = 1_000_000_000
  assert.equal(U.resetCountdown(now, now), '0s')
  assert.equal(U.resetCountdown(now - 5, now), '0s')
  assert.equal(U.resetCountdown(now + 30000, now), '30s')
  assert.equal(U.resetCountdown(now + 45 * MIN, now), '45m')
  assert.equal(U.resetCountdown(now + 2 * HOUR + 13 * MIN, now), '2h 13m')
  assert.equal(U.resetCountdown(now + 3 * HOUR, now), '3h')
  assert.equal(U.resetCountdown(now + 3 * DAY + 5 * HOUR, now), '3d')
  assert.equal(U.resetLabel(undefined, now), null)
  assert.equal(U.resetLabel(now + 2 * HOUR, now), 'Renova em 2h')
  const at = now + 2 * DAY, d = new Date(at)
  assert.equal(U.resetLabel(at, now), `Renova ${d.toLocaleDateString('pt-BR', { weekday: 'short' })} ${d.toLocaleTimeString('pt-BR', { hour: 'numeric', minute: '2-digit' })}`)
})

test('profileStatusSuffix', () => {
  const p = { id: 'a', provider: 'codex' }
  assert.equal(U.profileStatusSuffix({ ...p, enabled: false }, { fetching: false, status: { installed: false } }), null)
  assert.equal(U.profileStatusSuffix(p, undefined), null)
  assert.equal(U.profileStatusSuffix(p, { fetching: false }), null)
  assert.equal(U.profileStatusSuffix(p, { fetching: false, status: { installed: false, loggedIn: false } }), 'Indisponível')
  assert.equal(U.profileStatusSuffix(p, { fetching: false, status: { installed: true, loggedIn: false } }), 'Sem login')
  assert.equal(U.profileStatusSuffix(p, { fetching: false, status: { installed: true, loggedIn: true } }), null)
})

test('usage store dedupes ensure within 60s and refresh forces', async () => {
  const calls = { details: [], status: 0 }
  const M = usage({ providers: {
    details: async (prov, id, force) => { calls.details.push(force); return { limits: [] } },
    status: async () => { calls.status++; return { installed: true, loggedIn: true } } } })
  const s = () => M.useProviderUsage.getState()
  const profile = { id: 'p1', provider: 'codex' }
  s().ensure(profile); s().ensure(profile)
  assert.equal(calls.details.length, 1)
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(s().entries.p1.fetching, false)
  s().ensure(profile)
  assert.equal(calls.details.length, 1)
  await s().refresh(profile)
  assert.deepEqual(calls.details, [false, true])
  assert.equal(calls.status, 2)
  s().ensure({ id: 'p2', provider: 'codex', enabled: false })
  await s().refresh({ id: 'p2', provider: 'codex', enabled: false })
  assert.equal(calls.details.length, 2)
  s().ensure({ id: 'p3', provider: 'codex', tombstoned: true })
  assert.equal(calls.details.length, 2)
})

/* ---------------- modelCatalog ---------------- */
function catalog(storage) {
  global.localStorage = storage
  global.window = { prism: {} }
  return load('src/renderer/src/lib/modelCatalog.ts', { zustand: fakeZustand() })
}
const sel = (o = {}) => ({ provider: 'codex', profileId: 'a', model: '', effort: 'high', serviceTier: '', permissionMode: 'default', ...o })
const mdl = (o = {}) => ({ id: 'm', label: 'M', efforts: ['low', 'medium', 'high'], default: false, fast: null, ...o })

test('selectedModelFor', () => {
  const C = catalog({})
  const models = [mdl({ id: 'a' }), mdl({ id: 'b', default: true })]
  assert.equal(C.selectedModelFor(sel({ model: '' }), models).id, 'b')
  assert.equal(C.selectedModelFor(sel({ model: 'a' }), models).id, 'a')
  assert.equal(C.selectedModelFor(sel({ model: 'zzz' }), models), undefined)
})

test('normalizeForModel', () => {
  const C = catalog({})
  assert.equal(C.normalizeForModel(sel(), undefined), null)
  assert.equal(C.normalizeForModel(sel(), mdl()), null)
  assert.deepEqual(C.normalizeForModel(sel({ effort: 'max' }), mdl({ defaultEffort: 'medium' })), { effort: 'medium' })
  assert.deepEqual(C.normalizeForModel(sel({ effort: 'max' }), mdl({ defaultEffort: 'ultra' })), { effort: 'high' })
  assert.deepEqual(C.normalizeForModel(sel({ effort: 'max' }), mdl({ efforts: ['low', 'medium'] })), { effort: 'medium' })
  assert.equal(C.normalizeForModel(sel({ effort: 'max' }), mdl({ efforts: [] })), null)
  // Fast is a sticky preference: the picker never normalizes it away (the send path filters it).
  assert.equal(C.normalizeForModel(sel({ serviceTier: 'fast' }), mdl()), null)
  assert.equal(C.normalizeForModel(sel({ serviceTier: 'fast' }), mdl({ fast: { id: 'priority', label: 'x' } })), null)
  assert.equal(C.normalizeForModel(sel({ serviceTier: 'fast' }), mdl({ fast: { id: 'fast', label: 'x' } })), null)
})

test('defaultEffortFor', () => {
  const C = catalog({})
  assert.equal(C.defaultEffortFor(undefined), 'high')
  assert.equal(C.defaultEffortFor(mdl({ efforts: [] }), 'low'), 'low')
  assert.equal(C.defaultEffortFor(mdl({ defaultEffort: 'medium' })), 'medium')
  assert.equal(C.defaultEffortFor(mdl({ efforts: ['low', 'medium'] })), 'medium')
})

const plain = (v) => JSON.parse(JSON.stringify(v))
const EMPTY = { lastProfile: {}, lastModel: {}, byModel: {} }

test('picker memory: per-(provider, model) effort and Fast, last route, LRU cap', () => {
  const store = new Map()
  const C = catalog({ getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) })
  assert.deepEqual(plain(C.readPickerMemory()), EMPTY)
  C.recordSelection(sel({ model: 'x', effort: 'low', serviceTier: 'priority' }))
  C.recordSelection(sel({ provider: 'claude', profileId: 'c', model: 'opus', effort: 'max', serviceTier: 'fast' }))
  C.recordSelection(sel({ provider: 'claude', profileId: 'c', model: 'sonnet', effort: 'high' }))
  // Opus + Fast -> Sonnet -> Opus brings Fast back (Traycer's per-model memory).
  assert.deepEqual(plain(C.resolveModelPick('claude', 'opus')), { effort: 'max', serviceTier: 'fast' })
  assert.deepEqual(plain(C.resolveModelPick('claude', 'sonnet')), { effort: 'high', serviceTier: null })
  assert.deepEqual(plain(C.resolveModelPick('claude', 'haiku')), { effort: null, serviceTier: null })
  assert.deepEqual(plain(C.resolveProviderSwitch('codex')), { profileId: 'a', model: 'x', effort: 'low', serviceTier: 'priority' })
  assert.deepEqual(plain(C.resolveProviderSwitch('claude')), { profileId: 'c', model: 'sonnet', effort: 'high', serviceTier: null })
  // New chats start from the last committed route.
  assert.deepEqual(plain(C.initialSelection('fallback')), { provider: 'claude', profileId: 'c', model: 'sonnet', effort: 'high', serviceTier: '', permissionMode: 'default' })
  for (let i = 0; i < 205; i++) C.recordSelection(sel({ model: `m${i}` }))
  assert.equal(Object.keys(C.readPickerMemory().byModel).length, 200)
  // Nothing remembered: the provider default row and the built-in route.
  const fresh = catalog({ getItem: () => null, setItem: () => {} })
  assert.deepEqual(plain(fresh.resolveProviderSwitch('codex')), { model: '', effort: null, serviceTier: null })
  assert.deepEqual(plain(fresh.initialSelection('m')), { provider: 'claude', profileId: 'ambient-claude', model: 'm', effort: 'high', permissionMode: 'default' })
})

test('picker memory: v1 migration and broken storage', () => {
  const legacy = new Map([['prism.picker.memory.v1', JSON.stringify({ codex: { profileId: 'p', model: 'gpt', effort: 'xhigh', serviceTier: 'priority' }, bogus: { model: 'z' } })]])
  const L = catalog({ getItem: (k) => legacy.get(k) ?? null, setItem: (k, v) => legacy.set(k, v) })
  assert.deepEqual(plain(L.resolveProviderSwitch('codex')), { profileId: 'p', model: 'gpt', effort: 'xhigh', serviceTier: 'priority' })
  assert.equal(L.readPickerMemory().last, undefined)
  assert.equal(L.readPickerMemory().lastModel.bogus, undefined)
  const broken = catalog({ getItem: () => { throw new Error('no') }, setItem: () => { throw new Error('no') } })
  assert.deepEqual(plain(broken.readPickerMemory()), EMPTY)
  assert.doesNotThrow(() => broken.recordSelection(sel()))
  const garbage = catalog({ getItem: () => '{not json', setItem: () => {} })
  assert.deepEqual(plain(garbage.readPickerMemory()), EMPTY)
  const wrongShape = catalog({ getItem: (k) => k === 'prism.picker.memory.v2' ? JSON.stringify({ byModel: { 'codex x': { effort: 'nope', updatedAt: 'x' } }, last: { provider: 'other' } }) : null, setItem: () => {} })
  assert.deepEqual(plain(wrongShape.readPickerMemory()), EMPTY)
})

test('catalog reuses fresh data and refetches stale data', async () => {
  let calls = 0
  global.localStorage = {}
  global.window = { prism: { providers: { models: async () => { calls++; return [mdl()] } } } }
  const C = load('src/renderer/src/lib/modelCatalog.ts', { zustand: fakeZustand() })
  const flush = () => new Promise((resolve) => setImmediate(resolve))
  C.useModelCatalog.getState().load('codex', 'a'); await flush()
  C.useModelCatalog.getState().load('codex', 'a'); await flush()
  assert.equal(calls, 1)
  const key = C.catalogKey('codex', 'a')
  const entry = C.useModelCatalog.getState().entries[key]
  C.useModelCatalog.getState().entries[key] = { ...entry, loadedAt: Date.now() - C.CATALOG_STALE_MS - 1 }
  C.useModelCatalog.getState().load('codex', 'a'); await flush()
  assert.equal(calls, 2)
  assert.equal(C.useModelCatalog.getState().entries[key].models.length, 1)
})

/* ---------------- agentModels.codexUpgradeTier ---------------- */
test('codexUpgradeTier', () => {
  const { codexUpgradeTier } = load('src/main/ipc/agentModels.ts', {
    electron: { ipcMain: { handle() {} }, app: { on() {} } }, '../codexServer': { CodexServer: class {} },
    '../providers': {}, '../providerUsage': {}, '../../shared/modelLabels': load('src/shared/modelLabels.ts') })
  assert.equal(codexUpgradeTier({}), null)
  assert.equal(codexUpgradeTier({ serviceTiers: [] }), null)
  assert.equal(codexUpgradeTier({ additionalSpeedTiers: ['default'] }), null)
  assert.deepEqual({ ...codexUpgradeTier({ additionalSpeedTiers: ['default', 'fast'] }) }, { id: 'fast', label: 'Fast' })
  assert.deepEqual({ ...codexUpgradeTier({ serviceTiers: [{ id: 'default', name: 'Padrão' }, { id: 'priority', name: 'Priority' }], defaultServiceTier: 'default' }) }, { id: 'priority', label: 'Priority' })
  assert.deepEqual({ ...codexUpgradeTier({ serviceTiers: [{ id: 'p', name: 'Super long tier name' }], defaultServiceTier: 'p' }) }, { id: 'p', label: 'Fast' })
  assert.deepEqual({ ...codexUpgradeTier({ serviceTiers: [{ id: 'a' }, { id: 'b' }], additionalSpeedTiers: ['z'] }) }, { id: 'a', label: 'Fast' })
  assert.deepEqual({ ...codexUpgradeTier({ serviceTiers: [{ id: 'a', name: 'Exactly12chr' }], defaultServiceTier: 'a' }) }, { id: 'a', label: 'Exactly12chr' })
})

/* ---------------- shared/providerUsage ---------------- */
test('claudeDetails names', () => {
  const { claudeDetails } = load('src/shared/providerUsage.ts')
  const w = { utilization: 10, resets_at: '2026-01-01T00:00:00Z' }
  const d = claudeDetails({ rate_limits_available: true, rate_limits: { five_hour: w, seven_day: w, seven_day_opus: w, seven_day_sonnet: w, model_scoped: [{ ...w, display_name: 'Haiku' }, { ...w }] } })
  const by = Object.fromEntries(d.limits.map((l) => [l.id, l]))
  assert.equal(by.five_hour.name, null); assert.equal(by.five_hour.windowMinutes, 300)
  assert.equal(by.seven_day.name, null)
  assert.equal(by.seven_day_opus.name, 'Opus'); assert.equal(by.seven_day_sonnet.name, 'Sonnet')
  assert.equal(by['model:0'].name, 'Haiku'); assert.equal(by['model:1'].name, null)
  assert.equal(by.five_hour.resetsAt, Date.parse('2026-01-01T00:00:00Z') / 1000)
  assert.ok(claudeDetails({ rate_limits_available: false }).unavailable)
})

test('codexDetails main vs extra buckets', () => {
  const { codexDetails } = load('src/shared/providerUsage.ts')
  const win = (p, m) => ({ usedPercent: p, windowDurationMins: m, resetsAt: 5 })
  const d = codexDetails({}, {
    rateLimits: { limitId: 'codex', primary: win(10, 300), secondary: win(20, 10080) },
    rateLimitsByLimitId: { codex: { limitId: 'codex', primary: win(10, 300), secondary: win(20, 10080) }, spark: { limitId: 'spark', limitName: 'Spark', primary: win(30, 300) }, other: { primary: win(40, 300) } } })
  const by = Object.fromEntries(d.limits.map((l) => [l.id, l]))
  assert.equal(by['codex:primary'].name, null); assert.equal(by['codex:secondary'].name, null)
  assert.equal(by['spark:primary'].name, 'Spark')
  assert.equal(by['other:primary'].name, 'other')
  assert.equal(d.limits.length, 4)
  const named = codexDetails({}, { rateLimits: { limitId: 'codex', limitName: 'Codex Plus', primary: win(1, 300) } })
  assert.equal(named.limits[0].name, 'Codex Plus')
  const noId = codexDetails({}, { rateLimits: { primary: win(1, 300) } })
  assert.equal(noId.limits[0].id, 'codex:primary'); assert.equal(noId.limits[0].name, null)
})

/* ---------------- shared/agents.effectiveServiceTier ---------------- */
test('effectiveServiceTier', () => {
  const { effectiveServiceTier } = load('src/shared/agents.ts')
  assert.equal(effectiveServiceTier(sel()), undefined)
  assert.equal(effectiveServiceTier(sel({ serviceTier: 'fast' })), 'fast')
  assert.equal(effectiveServiceTier(sel({ serviceTier: 'fast' }), undefined), 'fast')
  assert.equal(effectiveServiceTier(sel({ serviceTier: 'fast' }), null), undefined)
  assert.equal(effectiveServiceTier(sel({ serviceTier: 'fast' }), mdl()), undefined)
  assert.equal(effectiveServiceTier(sel({ serviceTier: 'fast' }), mdl({ fast: { id: 'fast', label: 'F' } })), 'fast')
  assert.equal(effectiveServiceTier(sel({ serviceTier: 'fast' }), mdl({ fast: { id: 'p', label: 'F' } })), undefined)
})
