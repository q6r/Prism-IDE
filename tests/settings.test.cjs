const assert = require('node:assert/strict')
const test = require('node:test')
const loadTypescript = require('./helpers/load-typescript.cjs')

const D = 'src/renderer/src/components/settings/'
const defs = loadTypescript(D + 'definitions.ts')
const profileAccent = loadTypescript('src/renderer/src/lib/profileAccent.ts')
const usage = loadTypescript(D + 'usage.ts', { '../../lib/profileAccent': profileAccent })
const escape = loadTypescript(D + 'escape.ts')
const themes = loadTypescript(D + 'themes.ts')
const appearance = loadTypescript('src/renderer/src/lib/appearance.ts')

const SECTION_IDS = ['general', 'appearance', 'editor', 'extensions', 'providers', 'usage', 'notifications']
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/* ---------------- definitions ---------------- */

test('resolveSettingsSection passes valid ids and falls back to general', () => {
  for (const id of SECTION_IDS) assert.equal(defs.resolveSettingsSection(id), id)
  for (const bad of ['ia', 'ext', '', 'GENERAL', null, undefined]) assert.equal(defs.resolveSettingsSection(bad), 'general')
})

test('isSettingsSectionId', () => {
  for (const id of SECTION_IDS) assert.equal(defs.isSettingsSectionId(id), true)
  for (const bad of ['ia', '', null, undefined]) assert.equal(defs.isSettingsSectionId(bad), false)
})

test('sectionMeta returns the matching section', () => {
  assert.equal(defs.sectionMeta('providers').label, 'Provedores')
  assert.equal(defs.sectionMeta('providers').group, 'agents')
  assert.equal(defs.sectionMeta('general').group, 'app')
})

test('SETTINGS_SECTIONS: unique ids, contiguous groups in order, all ids covered', () => {
  const ids = defs.SETTINGS_SECTIONS.map((s) => s.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.deepEqual([...ids].sort(), [...SECTION_IDS].sort())
  const groupOrder = defs.SETTINGS_SECTION_GROUPS.map((g) => g.id)
  const seen = []
  for (const s of defs.SETTINGS_SECTIONS) {
    if (seen[seen.length - 1] !== s.group) {
      assert.ok(!seen.includes(s.group), `group ${s.group} is not contiguous`)
      seen.push(s.group)
    }
  }
  assert.deepEqual(seen, groupOrder)
})

test('SETTINGS_SEARCH_ENTRIES: sections exist and anchors are unique', () => {
  const anchors = []
  for (const e of defs.SETTINGS_SEARCH_ENTRIES) {
    assert.ok(SECTION_IDS.includes(e.section), `unknown section ${e.section}`)
    if (e.anchor !== null) anchors.push(e.anchor)
  }
  assert.equal(new Set(anchors).size, anchors.length)
})

test('normalizeSearchText strips accents, lowercases and trims', () => {
  assert.equal(defs.normalizeSearchText('Notificações'), 'notificacoes')
  assert.equal(defs.normalizeSearchText('  Aparência '), 'aparencia')
  assert.equal(defs.normalizeSearchText(''), '')
})

test('isSettingsSearchActive', () => {
  assert.equal(defs.isSettingsSearchActive(''), false)
  assert.equal(defs.isSettingsSearchActive('   \t'), false)
  assert.equal(defs.isSettingsSearchActive(' a '), true)
})

test('matchStrength tiers', () => {
  assert.equal(defs.matchStrength('Limites de uso', 'lim'), 1)
  assert.equal(defs.matchStrength('Limites de uso', 'uso'), 1)
  assert.equal(defs.matchStrength('Modo escuro', 'escuro'), 1)
  assert.equal(defs.matchStrength('Contas', 'ont'), 0.8)
  assert.equal(defs.matchStrength('Aparência', 'PAR'.toLowerCase()), 0.8)
  assert.equal(defs.matchStrength('Aparência', 'zzz'), 0)
  assert.equal(defs.matchStrength('', 'a'), 0)
  assert.equal(defs.matchStrength('abc', ''), 0)
})

test('matchStrength fuzzy: in-order letters, capped at 0.45, needs >= 3 chars', () => {
  const v = defs.matchStrength('abcdef', 'ace')
  assert.ok(v > 0 && v <= 0.45, `got ${v}`)
  assert.ok(Math.abs(v - 0.45 * (3 / 5)) < 1e-9)
  assert.equal(defs.matchStrength('abcdef', 'ac'), 0)
  assert.equal(defs.matchStrength('abcdef', 'eca'), 0)
})

test('searchSettings: blank returns nothing', () => {
  assert.deepEqual(defs.searchSettings(''), [])
  assert.deepEqual(defs.searchSettings('   '), [])
})

test('searchSettings is accent-insensitive', () => {
  const r = defs.searchSettings('notificacoes')
  assert.ok(r.some((x) => x.entry.kind === 'section' && x.entry.section === 'notifications' && x.entry.label === 'Notificações'))
  const r2 = defs.searchSettings('NOTIFICAÇÕES')
  assert.ok(r2.some((x) => x.entry.kind === 'section' && x.entry.section === 'notifications'))
})

test('searchSettings: "tema" ranks label-prefix entries first', () => {
  const r = defs.searchSettings('tema')
  assert.ok(r.length >= 2)
  const labels = r.map((x) => x.entry.label)
  assert.deepEqual(new Set(labels.slice(0, 2)), new Set(['Tema', 'Temas']))
  assert.equal(labels[0], 'Tema')
  // every label-prefix hit precedes any non-prefix hit
  const isPrefix = (x) => defs.normalizeSearchText(x.entry.label).startsWith('tema')
  const firstNon = r.findIndex((x) => !isPrefix(x))
  if (firstNon >= 0) assert.ok(r.slice(firstNon).every((x) => !isPrefix(x)))
})

test('searchSettings: multi-word queries need every token to match', () => {
  const r = defs.searchSettings('tamanho fonte')
  assert.ok(r.length > 0)
  assert.equal(r[0].entry.label, 'Tamanho da fonte')
  assert.deepEqual(defs.searchSettings('tamanho qqqqqqq'), [])
})

test('searchSettings caps results at MAX_SETTINGS_RESULTS and fills labels', () => {
  assert.equal(defs.MAX_SETTINGS_RESULTS, 12)
  const many = defs.searchSettings('a')
  assert.ok(many.length > 0 && many.length <= 12)
  for (const q of ['a', 'e', 'o', 'tema', 'conta', 'discord']) {
    for (const res of defs.searchSettings(q)) {
      assert.ok(res.sectionLabel)
      assert.ok(['Aplicativo', 'Agentes'].includes(res.scopeLabel))
      assert.equal(res.sectionLabel, defs.sectionMeta(res.entry.section).label)
    }
  }
  const synthetic = Array.from({ length: 30 }, (_, i) => ({
    kind: 'setting', section: 'general', label: `Item ${i}`, group: null, description: null, keywords: [], anchor: `a${i}`
  }))
  assert.equal(defs.searchSettings('item', synthetic).length, 12)
})

test('searchSettings: scope label follows the section group', () => {
  const r = defs.searchSettings('limites')
  const hit = r.find((x) => x.entry.label === 'Limites de uso')
  assert.ok(hit)
  assert.equal(hit.entry.section, 'providers')
  assert.equal(hit.entry.anchor, 'providers-usage')
  assert.equal(hit.scopeLabel, 'Agentes')
  const editor = defs.searchSettings('quebra').find((x) => x.entry.section === 'editor')
  assert.equal(editor.scopeLabel, 'Aplicativo')
})

test('settingsSearchResultKey', () => {
  const [anchored] = defs.searchSettings('limites')
  assert.equal(defs.settingsSearchResultKey(anchored.entry), 'providers:providers-usage')
  const page = defs.SETTINGS_SEARCH_ENTRIES.find((e) => e.kind === 'section' && e.section === 'editor')
  assert.equal(page.anchor, null)
  assert.equal(defs.settingsSearchResultKey(page), 'editor:Editor')
})

test('settingsSearchBreadcrumb', () => {
  const theme = defs.searchSettings('tema')[0]
  assert.deepEqual(defs.settingsSearchBreadcrumb(theme), ['Aplicativo', 'Aparência', 'Temas'])
  const page = defs.searchSettings('notificacoes').find((x) => x.entry.kind === 'section')
  assert.deepEqual(defs.settingsSearchBreadcrumb(page), ['Agentes', 'Notificações'])
  // group equal to the label is omitted
  const discord = defs.SETTINGS_SEARCH_ENTRIES.find((e) => e.anchor === 'extensions-discord')
  assert.deepEqual(
    defs.settingsSearchBreadcrumb({ entry: discord, sectionLabel: 'Extensões', scopeLabel: 'Aplicativo' }),
    ['Aplicativo', 'Extensões']
  )
  // empty parts are dropped
  assert.deepEqual(
    defs.settingsSearchBreadcrumb({ entry: page.entry, sectionLabel: 'X', scopeLabel: '' }),
    ['X']
  )
})

/* ---------------- usage ---------------- */

test('formatResetCountdown', () => {
  const now = 1_000_000
  assert.equal(usage.formatResetCountdown(now, now), '0s')
  assert.equal(usage.formatResetCountdown(now - 5000, now), '0s')
  assert.equal(usage.formatResetCountdown(now + 45_000, now), '45s')
  assert.equal(usage.formatResetCountdown(now + 500, now), '1s')
  assert.equal(usage.formatResetCountdown(now + MIN, now), '1m')
  assert.equal(usage.formatResetCountdown(now + 12 * MIN + 30_000, now), '12m')
  assert.equal(usage.formatResetCountdown(now + 4 * HOUR + 7 * MIN, now), '4h 7m')
  assert.equal(usage.formatResetCountdown(now + 3 * HOUR, now), '3h')
  assert.equal(usage.formatResetCountdown(now + 23 * HOUR + 59 * MIN, now), '23h 59m')
  assert.equal(usage.formatResetCountdown(now + DAY, now), '1d')
  assert.equal(usage.formatResetCountdown(now + 3 * DAY + 5 * HOUR, now), '3d')
})

test('isFarReset', () => {
  const now = 5000
  assert.equal(usage.isFarReset(now + DAY, now), true)
  assert.equal(usage.isFarReset(now + DAY - 1, now), false)
  assert.equal(usage.isFarReset(now - 1, now), false)
})

test('settingsWindowDetail', () => {
  const now = 10_000_000
  assert.equal(usage.settingsWindowDetail(62, undefined, now), '62% usado')
  assert.equal(usage.settingsWindowDetail(62.4, undefined, now), '62% usado')
  assert.equal(usage.settingsWindowDetail(62.5, undefined, now), '63% usado')
  assert.equal(usage.settingsWindowDetail(-5, undefined, now), '0% usado')
  assert.equal(usage.settingsWindowDetail(250, undefined, now), '100% usado')
  assert.equal(usage.settingsWindowDetail(10, now, now), '10% usado · Janela encerrada, aguardando nova consulta')
  assert.equal(usage.settingsWindowDetail(10, now - 1, now), '10% usado · Janela encerrada, aguardando nova consulta')
  assert.equal(usage.settingsWindowDetail(62, now + 4 * HOUR + 7 * MIN, now), '62% usado · Renova em 4h 7m')
  const far = usage.settingsWindowDetail(62, now + 3 * DAY, now)
  assert.ok(far.startsWith('62% usado · Renova '))
  assert.ok(!far.includes('Renova em '))
})

test('redactEmail', () => {
  assert.equal(usage.redactEmail('alice@domain.com'), 'a•••@d…')
  assert.equal(usage.redactEmail('nodomain'), '•••')
  assert.equal(usage.redactEmail('@domain.com'), '•••')
  assert.equal(usage.redactEmail(''), '•••')
})

test('profileAuthState and PROFILE_AUTH_TEXT', () => {
  assert.equal(usage.profileAuthState(undefined, true), 'checking')
  assert.equal(usage.profileAuthState(undefined, false), 'signed-out')
  assert.equal(usage.profileAuthState({ installed: true, loggedIn: true }, true), 'signed-in')
  assert.equal(usage.profileAuthState({ installed: true, loggedIn: false }, false), 'signed-out')
  assert.equal(usage.profileAuthState({ installed: false, loggedIn: false }, false), 'unavailable')
  assert.deepEqual(Object.keys(usage.PROFILE_AUTH_TEXT).sort(), ['checking', 'signed-in', 'signed-out', 'unavailable'])
  for (const v of Object.values(usage.PROFILE_AUTH_TEXT)) assert.ok(v)
})

const P = (id, provider, extra = {}) => ({ id, provider, ...extra })

test('duplicateColorProfile', () => {
  const a = P('a', 'claude', { color: '#EF4444' })
  const b = P('b', 'claude', { color: '#3b82f6' })
  const codex = P('c', 'codex', { color: '#10b981' })
  const dead = P('d', 'claude', { color: '#8b5cf6', tombstoned: true })
  const all = [a, b, codex, dead]
  assert.equal(usage.duplicateColorProfile(all, null, 'claude', '#ef4444'), a)
  assert.equal(usage.duplicateColorProfile(all, b, 'claude', '#ef4444'), a)
  assert.equal(usage.duplicateColorProfile(all, a, 'claude', '#ef4444'), null)
  assert.equal(usage.duplicateColorProfile(all, null, 'claude', '#10b981'), null)
  assert.equal(usage.duplicateColorProfile(all, null, 'claude', '#8b5cf6'), null)
  assert.equal(usage.duplicateColorProfile(all, null, 'claude', null), null)
})

test('nextAccentColor', () => {
  const pal = ['#111111', '#222222', '#333333']
  assert.equal(usage.nextAccentColor([], 'claude', pal), '#111111')
  assert.equal(usage.nextAccentColor([P('a', 'claude', { color: '#111111' })], 'claude', pal), '#222222')
  assert.equal(usage.nextAccentColor([P('a', 'claude', { color: '#111111' }), P('b', 'claude')], 'claude', pal), '#222222')
  assert.equal(usage.nextAccentColor([P('a', 'claude', { color: '#AAAAAA' }), P('b', 'claude', { color: '#111111'.toUpperCase() })], 'claude', pal), '#222222')
  assert.equal(usage.nextAccentColor([P('a', 'codex', { color: '#111111' })], 'claude', pal), '#111111')
  assert.equal(usage.nextAccentColor([P('a', 'claude', { color: '#111111', tombstoned: true })], 'claude', pal), '#111111')
  const full = pal.map((c, i) => P('p' + i, 'claude', { color: c }))
  assert.equal(usage.nextAccentColor(full, 'claude', pal), '#111111')
  // default palette
  assert.equal(usage.nextAccentColor([], 'claude'), profileAccent.PROFILE_ACCENT_COLORS[0])
})

test('providerProfiles', () => {
  const list = [
    P('1', 'claude'), P('2', 'codex'), P('3', 'claude', { ambient: true }),
    P('4', 'claude', { tombstoned: true }), P('5', 'claude')
  ]
  assert.deepEqual(usage.providerProfiles(list, 'claude').map((p) => p.id), ['3', '1', '5'])
  assert.deepEqual(usage.providerProfiles(list, 'codex').map((p) => p.id), ['2'])
  assert.deepEqual(usage.providerProfiles(list, 'none'), [])
  assert.deepEqual(list.map((p) => p.id), ['1', '2', '3', '4', '5'], 'input is not mutated')
})

test('latestCheckedAt', () => {
  assert.equal(usage.latestCheckedAt([]), null)
  assert.equal(usage.latestCheckedAt([undefined, undefined]), null)
  assert.equal(usage.latestCheckedAt([3, undefined, 9, 5]), 9)
  assert.equal(usage.latestCheckedAt([0]), 0)
})

/* ---------------- escape ---------------- */

test('escape consumers: newest first, falls through, disposers', () => {
  const base = escape.escapeConsumerCount()
  assert.equal(escape.consumeEscape(), false)
  const calls = []
  const mk = (name, result) => () => { calls.push(name); return result }
  const d1 = escape.pushEscapeConsumer(mk('one', true))
  const d2 = escape.pushEscapeConsumer(mk('two', false))
  const d3 = escape.pushEscapeConsumer(mk('three', false))
  try {
    assert.equal(escape.escapeConsumerCount(), base + 3)
    assert.equal(escape.consumeEscape(), true)
    assert.deepEqual(calls, ['three', 'two', 'one'])

    // remove out of order: the middle one
    calls.length = 0
    d2()
    assert.equal(escape.escapeConsumerCount(), base + 2)
    assert.equal(escape.consumeEscape(), true)
    assert.deepEqual(calls, ['three', 'one'])

    // disposer is idempotent
    d2()
    assert.equal(escape.escapeConsumerCount(), base + 2)

    // top consumer takes it and stops the walk
    d3()
    const top = escape.pushEscapeConsumer(mk('top', true))
    calls.length = 0
    assert.equal(escape.consumeEscape(), true)
    assert.deepEqual(calls, ['top'])
    top()
  } finally {
    d1(); d2(); d3()
  }
  assert.equal(escape.escapeConsumerCount(), base)
  assert.equal(escape.consumeEscape(), false)
})

test('escape: false when no consumer takes it', () => {
  const d = escape.pushEscapeConsumer(() => false)
  try { assert.equal(escape.consumeEscape(), false) } finally { d() }
})

test('escape: same function pushed twice is removed one at a time', () => {
  const base = escape.escapeConsumerCount()
  const fn = () => false
  const a = escape.pushEscapeConsumer(fn)
  const b = escape.pushEscapeConsumer(fn)
  assert.equal(escape.escapeConsumerCount(), base + 2)
  a()
  assert.equal(escape.escapeConsumerCount(), base + 1)
  b()
  assert.equal(escape.escapeConsumerCount(), base)
})

/* ---------------- themes ---------------- */

test('themeOption', () => {
  assert.equal(themes.themeOption('prism-ocean').id, 'prism-ocean')
  assert.equal(themes.themeOption('prism-ocean'), themes.THEME_OPTIONS.find((t) => t.id === 'prism-ocean'))
  for (const bad of ['nope', '', 'PRISM-DARK']) assert.equal(themes.themeOption(bad).id, 'prism-dark')
})

test('THEME_OPTIONS ids unique, all nine present, light ones match appearance.ts', () => {
  const ids = themes.THEME_OPTIONS.map((t) => t.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const id of ['prism-dark', 'prism-neutral', 'prism-ocean', 'prism-nord', 'prism-forest', 'prism-amethyst', 'prism-light-pink', 'prism-sepia', 'prism-daylight']) {
    assert.ok(ids.includes(id), `missing ${id}`)
  }
  assert.equal(ids.length, 9)
  const light = themes.THEME_OPTIONS.filter((t) => t.appearance === 'light').map((t) => t.id).sort()
  assert.deepEqual(light, [...appearance.LIGHT_THEMES].sort())
  assert.deepEqual(light, ['prism-daylight', 'prism-light-pink', 'prism-sepia'])
  for (const t of themes.THEME_OPTIONS) {
    assert.equal(appearance.isLightTheme(t.id), t.appearance === 'light')
    for (const c of Object.values(t.colors)) assert.match(c, /^#[0-9a-f]{6}$/i)
  }
})

/* ---------------- matchStrength / search: fuzzy limits ---------------- */

test('matchStrength: fuzzy flag, span limit and every word-prefix occurrence', () => {
  assert.equal(defs.matchStrength('abcdef', 'ace', false), 0)
  assert.ok(defs.matchStrength('abcdef', 'ace', true) > 0)
  // span 9 > 2 * 3: rejected
  assert.equal(defs.matchStrength('a12345678c9e', 'ace'), 0)
  // span exactly 2 * needle length is accepted
  assert.ok(Math.abs(defs.matchStrength('a1c2e3', 'ace') - 0.45 * (3 / 5)) < 1e-9)
  // a later, tighter start wins
  assert.ok(Math.abs(defs.matchStrength('a1111111c a2c3e', 'ace') - 0.45 * (3 / 5)) < 1e-9)
  // word-prefix on a later occurrence still scores 1
  assert.equal(defs.matchStrength('xatema tema', 'tema'), 1)
  assert.equal(defs.matchStrength('xatema', 'tema'), 0.8)
})

test('searchSettings: fuzzy only on labels/keywords, not descriptions/groups', () => {
  const anim = defs.searchSettings('anim').map((r) => r.entry.label)
  assert.ok(anim.includes('Animações'))
  assert.ok(!anim.includes('CLI'))
  assert.ok(!anim.includes('Limites de uso'))
  const lim = defs.searchSettings('limites').map((r) => r.entry.label)
  assert.ok(lim.includes('Limites de uso'))
  assert.ok(!lim.includes('Tema'))
})

/* ---------------- signInBlockedReason ---------------- */

test('signInBlockedReason precedence', () => {
  const free = { loginOpen: false, busy: false, cliMissing: null }
  const all = { loginOpen: true, busy: true, cliMissing: 'CLI ausente' }
  assert.equal(usage.signInBlockedReason({ id: 'a', provider: 'claude', ambient: true, enabled: false }, all), 'A conta do terminal é gerenciada pelo terminal.')
  assert.equal(usage.signInBlockedReason({ id: 'a', provider: 'claude', enabled: false }, all), 'Ative o perfil para entrar.')
  assert.equal(usage.signInBlockedReason({ id: 'a', provider: 'claude' }, all), 'CLI ausente')
  assert.equal(usage.signInBlockedReason({ id: 'a', provider: 'claude', enabled: true }, { ...all, cliMissing: null }), 'Conclua o login em andamento primeiro.')
  assert.equal(usage.signInBlockedReason({ id: 'a', provider: 'claude' }, { ...free, busy: true }), 'Há uma conversa em andamento com este perfil.')
  assert.equal(usage.signInBlockedReason({ id: 'a', provider: 'claude' }, free), null)
  assert.equal(usage.signInBlockedReason({ id: 'a', provider: 'claude', enabled: true }, free), null)
})
