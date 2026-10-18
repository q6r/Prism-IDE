const { test } = require('node:test')
const assert = require('node:assert/strict')
const load = require('./helpers/load-typescript.cjs')

const appHandlers = {}
const A = load('src/main/ipc/agentCommands.ts', {
  electron: { ipcMain: { handle() {} }, app: { on: (name, fn) => { appHandlers[name] = fn } } },
  fs: { promises: {} },
  os: { homedir: () => '/home/x' },
  path: require('node:path'),
  '../codexServer': { CodexServer: class {} },
  '../providers': { profileEnvironment() {}, providerCommand() {} }
})
const M = load('src/renderer/src/lib/composerMenu.ts')

const none = new Set()

/* ---------------- claudeCommands ---------------- */

test('claudeCommands: strips leading slash and whitespace, drops nameless rows', () => {
  const out = A.claudeCommands([
    { name: '/review' }, { name: '  /spaced  ' }, { name: ' plain ' },
    { name: '' }, { name: '   ' }, { name: '/' }, { name: 42 }, { name: null }, {}, null
  ], none)
  assert.deepEqual(out.map((c) => c.name), ['review', 'spaced', 'plain'])
})

test('claudeCommands: builtin wins over skills, skills decide the rest', () => {
  const skills = new Set(['both', 'sk'])
  const out = A.claudeCommands([
    { name: 'both', builtin: true }, { name: 'sk' }, { name: 'custom' }, { name: '/sk', builtin: false }
  ], skills)
  assert.deepEqual(out.map((c) => [c.name, c.kind, c.builtin]), [
    ['both', 'slash-command', true], ['sk', 'skill', false], ['custom', 'slash-command', false], ['sk', 'skill', false]
  ])
})

test('claudeCommands: builtin only when === true', () => {
  const out = A.claudeCommands([{ name: 'a', builtin: 'true' }, { name: 'b', builtin: 1 }, { name: 'c', builtin: true }, { name: 'd' }], new Set(['a', 'b']))
  assert.deepEqual(out.map((c) => c.builtin), [false, false, true, false])
  // not builtin, so the skill lookup applies
  assert.equal(out[0].kind, 'skill')
  assert.equal(out[1].kind, 'skill')
})

test('claudeCommands: argumentHint trimmed, empty/blank/absent/non-string is null', () => {
  const out = A.claudeCommands([
    { name: 'a', argumentHint: '  <file>  ' }, { name: 'b', argumentHint: '' }, { name: 'c', argumentHint: '   ' },
    { name: 'd' }, { name: 'e', argumentHint: 5 }
  ], none)
  assert.deepEqual(out.map((c) => c.argumentHint), ['<file>', null, null, null, null])
})

test('claudeCommands: non-string description becomes empty', () => {
  const out = A.claudeCommands([{ name: 'a', description: 'desc' }, { name: 'b', description: 3 }, { name: 'c', description: null }, { name: 'd' }], none)
  assert.deepEqual(out.map((c) => c.description), ['desc', '', '', ''])
})

/* ---------------- codexSkillCommands ---------------- */

test('codexSkillCommands: flattens, skips disabled, first duplicate wins', () => {
  const out = A.codexSkillCommands({ data: [
    { skills: [{ name: 'a', description: 'first' }, { name: 'off', enabled: false }, { name: 'b' }] },
    { skills: [{ name: 'a', description: 'second' }, { name: 'c', enabled: true }] }
  ] })
  assert.deepEqual(out.map((c) => c.name), ['a', 'b', 'c'])
  assert.equal(out[0].description, 'first')
})

test('codexSkillCommands: description fallback chain skips blank strings', () => {
  const out = A.codexSkillCommands({ data: [{ skills: [
    { name: 'a', description: 'd', interface: { shortDescription: 'i' }, shortDescription: 's' },
    { name: 'b', description: '   ', interface: { shortDescription: 'i' }, shortDescription: 's' },
    { name: 'c', description: '', interface: { shortDescription: '  ' }, shortDescription: 's' },
    { name: 'd', interface: { shortDescription: '' }, shortDescription: '' },
    { name: 'e', description: 7, interface: {}, shortDescription: 's' },
    { name: 'f' }
  ] }] })
  assert.deepEqual(out.map((c) => c.description), ['d', 'i', 's', '', 's', ''])
})

test('codexSkillCommands: fixed kind/builtin/argumentHint', () => {
  const [c] = A.codexSkillCommands({ data: [{ skills: [{ name: 'x' }] }] })
  assert.deepEqual({ ...c }, { name: 'x', description: '', argumentHint: null, kind: 'skill', builtin: false })
})

test('codexSkillCommands: invalid responses give []', () => {
  for (const r of [null, undefined, {}, 'x', 3, { data: null }, { data: {} }, { data: 'a' }, { data: [{ skills: {} }] }, { data: [{ skills: null }] }, { data: [null, {}] }]) {
    assert.deepEqual(A.codexSkillCommands(r), [])
  }
})

/* ---------------- nativeCommandItems ---------------- */

const cmd = (name, extra = {}) => ({ name, description: 'd', argumentHint: null, kind: 'slash-command', builtin: false, ...extra })
const claude = { provider: 'claude', remote: false }
const codex = { provider: 'codex', remote: false }

test('nativeCommandItems: remote gives none', () => {
  assert.deepEqual(M.nativeCommandItems([cmd('a')], { provider: 'claude', remote: true }), [])
  assert.deepEqual(M.nativeCommandItems([cmd('a', { kind: 'skill' })], { provider: 'codex', remote: true }), [])
})

test('nativeCommandItems: claude grouping', () => {
  const out = M.nativeCommandItems([
    cmd('compact', { builtin: true }), cmd('sk', { kind: 'skill' }), cmd('mine'), cmd('bsk', { kind: 'skill', builtin: true })
  ], claude)
  assert.deepEqual(out.map((i) => [i.id, i.group, i.leadingOnly, i.prefix, i.action]), [
    ['native:compact', 'native', true, '/', 'insert'],
    ['skill:sk', 'skill', false, '/', 'insert'],
    ['custom:mine', 'custom', true, '/', 'insert'],
    ['skill:bsk', 'skill', false, '/', 'insert']
  ])
})

test('nativeCommandItems: codex is all $skills', () => {
  const out = M.nativeCommandItems([cmd('a'), cmd('b', { builtin: true }), cmd('c', { kind: 'skill' })], codex)
  for (const i of out) {
    assert.equal(i.group, 'skill')
    assert.equal(i.prefix, '$')
    assert.equal(i.leadingOnly, false)
  }
  assert.deepEqual(out.map((i) => i.id), ['skill:a', 'skill:b', 'skill:c'])
})

test('nativeCommandItems: cleans names and hints, drops empty names', () => {
  const out = M.nativeCommandItems([
    cmd('/slash'), cmd('$dollar'), cmd('  /padded '), cmd(''), cmd('/'), cmd('$'), cmd('   '),
    cmd('h1', { argumentHint: '   ' }), cmd('h2', { argumentHint: ' <x> ' }), cmd('h3', { argumentHint: null })
  ], claude)
  assert.deepEqual(out.map((i) => i.name), ['slash', 'dollar', 'padded', 'h1', 'h2', 'h3'])
  assert.deepEqual(out.slice(3).map((i) => i.argumentHint), [null, '<x>', null])
  assert.equal(out[0].id, 'custom:slash')
  assert.equal(out[0].template, null)
  assert.equal(out[0].disabledReason, null)
})

/* ---------------- buildCommandSections ---------------- */

const prismCtx = { provider: 'claude', busy: false, canCompact: true, hasOpenFile: true }
const findItem = (sections, group, name) => sections.find((s) => s.group === group)?.items.find((i) => i.name === name)

test('buildCommandSections: group order and labels', () => {
  const items = [
    ...M.nativeCommandItems([cmd('zz'), cmd('nat', { builtin: true }), cmd('sk', { kind: 'skill' })], claude),
    ...M.prismCommands(prismCtx)
  ]
  const sections = M.buildCommandSections(items, '', true)
  assert.deepEqual(sections.map((s) => s.group), ['prism', 'custom', 'native', 'skill'])
  assert.equal(sections.find((s) => s.group === 'native').label, 'Comandos do Claude')
})

test('buildCommandSections: empty groups disappear', () => {
  const sections = M.buildCommandSections(M.nativeCommandItems([cmd('x', { builtin: true })], claude), '', true)
  assert.deepEqual(sections.map((s) => s.group), ['native'])
})

test('buildCommandSections: Prism beats native of the same name', () => {
  const items = [...M.nativeCommandItems([cmd('login', { builtin: true })], claude), ...M.prismCommands(prismCtx)]
  const sections = M.buildCommandSections(items, '', true)
  assert.ok(findItem(sections, 'prism', 'login'))
  assert.equal(findItem(sections, 'native', 'login'), undefined)
})

test('buildCommandSections: native beats custom, custom beats skill', () => {
  const items = M.nativeCommandItems([
    cmd('review'), cmd('review', { builtin: true }),
    cmd('dup'), cmd('dup', { kind: 'skill' })
  ], claude)
  const sections = M.buildCommandSections(items, '', true)
  assert.ok(findItem(sections, 'native', 'review'))
  assert.equal(findItem(sections, 'custom', 'review'), undefined)
  assert.ok(findItem(sections, 'custom', 'dup'))
  assert.equal(findItem(sections, 'skill', 'dup'), undefined)
})

test('buildCommandSections: $skill coexists with /prism of the same name', () => {
  const items = [...M.prismCommands({ ...prismCtx, provider: 'codex' }), ...M.nativeCommandItems([cmd('testes', { kind: 'skill' })], codex)]
  const sections = M.buildCommandSections(items, '', true)
  const prism = findItem(sections, 'prism', 'testes')
  const skill = findItem(sections, 'skill', 'testes')
  assert.equal(prism.prefix, '/')
  assert.equal(skill.prefix, '$')
})

test('buildCommandSections: dedupe is case-insensitive per prefix', () => {
  const items = M.nativeCommandItems([cmd('Review'), cmd('review', { builtin: true })], claude)
  const sections = M.buildCommandSections(items, '', true)
  assert.equal(sections.flatMap((s) => s.items).length, 1)
  assert.equal(sections[0].group, 'native')
})

test('buildCommandSections: leading:false disables native/custom, keeps skills enabled', () => {
  const items = M.nativeCommandItems([cmd('nat', { builtin: true }), cmd('cus'), cmd('sk', { kind: 'skill' })], claude)
  const sections = M.buildCommandSections(items, '', false)
  assert.equal(findItem(sections, 'native', 'nat').disabledReason, M.LEADING_ONLY_REASON)
  assert.equal(findItem(sections, 'custom', 'cus').disabledReason, M.LEADING_ONLY_REASON)
  assert.equal(findItem(sections, 'skill', 'sk').disabledReason, null)
  const lead = M.buildCommandSections(items, '', true)
  assert.equal(findItem(lead, 'native', 'nat').disabledReason, null)
})

test('buildCommandSections: leading:false keeps an existing disabledReason (Prism)', () => {
  const sections = M.buildCommandSections(M.prismCommands({ ...prismCtx, busy: true }), '', false)
  assert.equal(findItem(sections, 'prism', 'compactar').disabledReason, 'Aguarde o turno atual terminar.')
  assert.equal(findItem(sections, 'prism', 'limpar').disabledReason, M.LEADING_ONLY_REASON)
})

/* ---------------- prefix on prismCommands / diskCommandItems ---------------- */

test('prismCommands and diskCommandItems carry prefix "/"', () => {
  for (const provider of ['claude', 'codex']) {
    const items = M.prismCommands({ ...prismCtx, provider })
    assert.ok(items.length > 0)
    for (const i of items) assert.equal(i.prefix, '/')
  }
  const disk = M.diskCommandItems([
    { name: '/a', description: '', source: 'user' }, { name: 'b', description: '', source: 'project' },
    { name: 's', description: '', source: 'skill' }, { name: 'c', description: '', source: 'client' }, { name: '/', description: '', source: 'user' }
  ], claude)
  assert.deepEqual(disk.map((i) => i.name), ['a', 'b', 's'])
  for (const i of disk) assert.equal(i.prefix, '/')
  assert.deepEqual(M.diskCommandItems([{ name: 'a', description: '', source: 'user' }], codex), [])
})

/* ---------------- codexSkillRefs ---------------- */

test('codexSkillRefs: flattens, skips disabled, trims names', () => {
  const out = A.codexSkillRefs({ data: [
    { skills: [{ name: ' a ', path: '/a' }, { name: 'off', path: '/o', enabled: false }] },
    { skills: [{ name: 'b', path: '/b', enabled: true }] }
  ] })
  assert.deepEqual(out.map((s) => ({ ...s })), [{ name: 'a', path: '/a' }, { name: 'b', path: '/b' }])
})

test('codexSkillRefs: first occurrence wins, even without a valid path', () => {
  const out = A.codexSkillRefs({ data: [
    { skills: [{ name: 'dup', path: '/first' }, { name: 'nopath' }] },
    { skills: [{ name: 'dup', path: '/second' }, { name: 'nopath', path: '/late' }] }
  ] })
  assert.deepEqual(out.map((s) => ({ ...s })), [{ name: 'dup', path: '/first' }])
})

test('codexSkillRefs: empty, blank or non-string path is dropped', () => {
  const out = A.codexSkillRefs({ data: [{ skills: [
    { name: 'a', path: '' }, { name: 'b', path: '   ' }, { name: 'c', path: 5 }, { name: 'd', path: null }, { name: 'e', path: '/e' }
  ] }] })
  assert.deepEqual(out.map((s) => s.name), ['e'])
})

test('codexSkillRefs: invalid responses give []', () => {
  for (const r of [null, undefined, {}, 'x', 3, { data: null }, { data: {} }, { data: [{ skills: {} }] }, { data: [null, {}] }]) {
    assert.deepEqual(A.codexSkillRefs(r), [])
  }
})

/* ---------------- codexSkillInputs ---------------- */

const sk = (...ns) => ns.map((name) => ({ name, path: `/s/${name}/SKILL.md` }))
const inputNames = (prompt, skills) => A.codexSkillInputs(prompt, skills).map((i) => i.name)

test('codexSkillInputs: $name at start and after space, tab, newline', () => {
  const s = sk('pdf')
  assert.deepEqual(inputNames('$pdf x', s), ['pdf'])
  assert.deepEqual(inputNames('a $pdf', s), ['pdf'])
  assert.deepEqual(inputNames('a\t$pdf', s), ['pdf'])
  assert.deepEqual(inputNames('a\n$pdf', s), ['pdf'])
})

test('codexSkillInputs: not inside US$100, a$pdf, $$pdf', () => {
  const s = sk('pdf', '100')
  assert.deepEqual(inputNames('US$100', s), [])
  assert.deepEqual(inputNames('a$pdf', s), [])
  assert.deepEqual(inputNames('$$pdf', s), [])
})

test('codexSkillInputs: exact, case-sensitive names', () => {
  assert.deepEqual(inputNames('$PDF', sk('pdf')), [])
  assert.deepEqual(inputNames('$pdfx', sk('pdf')), [])
  assert.deepEqual(inputNames('$PDF', sk('PDF')), ['PDF'])
})

test('codexSkillInputs: trailing punctuation retried; ($pdf) does not match', () => {
  const s = sk('pdf')
  assert.deepEqual(inputNames('use $pdf.', s), ['pdf'])
  assert.deepEqual(inputNames('use $pdf, ok', s), ['pdf'])
  assert.deepEqual(inputNames('use $pdf!?', s), ['pdf'])
  // '$' follows '(' rather than start/whitespace, so the token is never seen.
  assert.deepEqual(inputNames('($pdf)', s), [])
  assert.deepEqual(inputNames('x ($pdf)', s), [])
})

test('codexSkillInputs: a name ending in "." matches exactly', () => {
  assert.deepEqual(inputNames('$a.b', sk('a.b')), ['a.b'])
  assert.deepEqual(inputNames('$a.', sk('a.')), ['a.'])
  assert.deepEqual(inputNames('$a.', sk('a')), ['a'])
})

test('codexSkillInputs: each skill once, in order of appearance', () => {
  assert.deepEqual(inputNames('$b then $a and $b $a. $c', sk('a', 'b')), ['b', 'a'])
})

test('codexSkillInputs: empty skills or no $ gives []', () => {
  assert.deepEqual(A.codexSkillInputs('$pdf', []), [])
  assert.deepEqual(A.codexSkillInputs('pdf', sk('pdf')), [])
})

test('codexSkillInputs: output shape', () => {
  assert.deepEqual(A.codexSkillInputs('$pdf', sk('pdf')).map((i) => ({ ...i })), [{ type: 'skill', name: 'pdf', path: '/s/pdf/SKILL.md' }])
})

/* ---------------- cachedCodexSkills ---------------- */

test('cachedCodexSkills: null with nothing cached; profile-changed handler runs', () => {
  assert.equal(A.cachedCodexSkills('p', '/cwd'), null)
  A.registerAgentCommandHandlers()
  assert.equal(typeof appHandlers['prism:profile-changed'], 'function')
  appHandlers['prism:profile-changed']('anything')
  assert.equal(A.cachedCodexSkills('p', '/cwd'), null)
})
