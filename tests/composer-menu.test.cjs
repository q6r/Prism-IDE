const { test } = require('node:test')
const assert = require('node:assert/strict')
const load = require('./helpers/load-typescript.cjs')

const M = load('src/renderer/src/lib/composerMenu.ts')

/* ---------------- findTrigger ---------------- */

test('findTrigger: slash at start', () => {
  assert.deepEqual({ ...M.findTrigger('/', 1) }, { kind: 'slash', start: 0, end: 1, query: '', leading: true })
  const t = M.findTrigger('/lim', 4)
  assert.equal(t.kind, 'slash')
  assert.equal(t.query, 'lim')
  assert.equal(t.start, 0)
  assert.equal(t.end, 4)
  assert.equal(t.leading, true)
})

test('findTrigger: leading flag', () => {
  const mid = M.findTrigger('olá /x', 6)
  assert.equal(mid.start, 4)
  assert.equal(mid.leading, false)
  assert.equal(M.findTrigger('   /x', 5).leading, true)
  assert.equal(M.findTrigger('a\n/x', 4).leading, false)
})

test('findTrigger: end extends to next whitespace after caret', () => {
  const t = M.findTrigger('/limpar resto', 4)
  assert.equal(t.query, 'lim')
  assert.equal(t.start, 0)
  assert.equal(t.end, 7)
})

test('findTrigger: does not open', () => {
  assert.equal(M.findTrigger('a/b', 3), null)
  assert.equal(M.findTrigger('/src/x', 6), null)
  assert.equal(M.findTrigger('nome@site.com', 13), null)
  assert.equal(M.findTrigger('@a@b', 4), null)
  assert.equal(M.findTrigger('/abc', 0), null)
  assert.equal(M.findTrigger('/abc', 10), null)
  assert.equal(M.findTrigger('/abc', -1), null)
  assert.equal(M.findTrigger('/abc', 1.5), null)
  assert.equal(M.findTrigger('/abc ', 5), null)
  assert.equal(M.findTrigger('x /abc', 1), null)
  assert.equal(M.findTrigger('', 0), null)
})

test('findTrigger: mention', () => {
  const t = M.findTrigger('@src/comp', 9)
  assert.equal(t.kind, 'mention')
  assert.equal(t.query, 'src/comp')
  assert.equal(t.start, 0)
  assert.equal(M.findTrigger('veja\n@a', 7).kind, 'mention')
  assert.equal(M.findTrigger('veja\n@a', 7).start, 5)
  assert.equal(M.findTrigger('veja\n@a', 7).leading, false)
})

test('findTrigger: image references keep the number in the replacement span', () => {
  assert.deepEqual(M.findTrigger('#', 1), { kind: 'image', start: 0, end: 1, query: '', leading: true })
  for (const text of ['#i', '#im', '#imag', '#image', '#image ']) {
    assert.equal(M.findTrigger(text, text.length).kind, 'image', text)
  }
  const text = 'compare #image 12 com #image 2'
  const image = M.findTrigger(text, 14)
  assert.deepEqual(image, { kind: 'image', start: 8, end: 17, query: 'image', leading: false })
  assert.equal(M.findTrigger(text, 17).query, 'image 12')
  assert.equal(M.findTrigger(text, 18), null, 'completed reference followed by space leaves the picker')
  assert.equal(M.findTrigger('#image1', 7).query, 'image1')
})

test('findTrigger: image examples, URL fragments and unrelated hashtags stay literal', () => {
  for (const text of ['https://site.test/#image', 'word#image', '#imagery', '#feature', '`#image 1', '```ts\n#image 1', '~~~\n#image 1']) {
    assert.equal(M.findTrigger(text, text.length), null, text)
  }
  for (const text of ['`code` #image 1', '```\ncode\n```\n#im']) assert.equal(M.findTrigger(text, text.length).kind, 'image')
  assert.equal(M.findTrigger('#image1.png', 7), null, 'a file name stays literal even with the caret inside')
})

test('rankImageReferences: partial keyword lists images and numbers match exactly by prefix', () => {
  const images = [{ number: 1 }, { number: 2 }, { number: 12 }]
  for (const query of ['', 'i', 'im', 'image ']) assert.deepEqual(M.rankImageReferences(images, query), images)
  assert.deepEqual(M.rankImageReferences(images, 'image 1'), [images[0], images[2]])
  assert.deepEqual(M.rankImageReferences(images, 'image 2'), [images[1]])
  assert.deepEqual(M.rankImageReferences(images, 'image 99'), [])
})

test('image completion changes only the selected reference in a comparison prompt', () => {
  const text = 'quero ver #image 1 e comparar com #image 12 depois'
  const at = text.indexOf('#image 12') + '#image 1'.length
  const trigger = M.findTrigger(text, at)
  assert.equal(trigger.query, 'image 1')
  assert.deepEqual(M.rankImageReferences([{ number: 1 }, { number: 2 }, { number: 12 }], trigger.query), [{ number: 1 }, { number: 12 }])
  assert.equal(M.applyCompletion(text, trigger.start, trigger.end, '#image 2 ').text, 'quero ver #image 1 e comparar com #image 2  depois')
  for (const reference of ['#image1', '#image 1', '#image    1', '#IMAGE\t1']) {
    const trigger = M.findTrigger(reference, reference.length)
    assert.deepEqual(M.rankImageReferences([{ number: 1 }, { number: 2 }], trigger.query), [{ number: 1 }])
    assert.equal(M.findTrigger(`${reference} `, reference.length + 1), null)
  }
})

test('automatic image references enter at the upload caret, in batch order, without replacing prose', () => {
  const text = 'Veja a imagem e compare com #image 1 depois'
  const at = text.indexOf(' e compare')
  const next = M.imageReferenceInsertion(text, at, [2, 3])
  assert.equal(next.text, 'Veja a imagem #image 2 #image 3 e compare com #image 1 depois')
  assert.equal(next.caret, next.text.indexOf(' e compare'))
  assert.deepEqual(M.imageReferenceInsertion('', 0, [1]), { text: '#image 1 ', insert: '#image 1 ', caret: 9 })
  assert.equal(M.imageReferenceInsertion('a|b', 1, [4]).text, 'a #image 4 |b')
  assert.equal(M.imageReferenceInsertion(text, at, []).text, text)
})

test('image load anchor follows text edits without overwriting text typed during FileReader', () => {
  const original = 'veja a imagem'
  const afterTyping = original + ' e depois compare'
  const at = M.rebaseInsertionPoint(original, afterTyping, original.length)
  assert.equal(at, original.length, 'an image pasted first stays before text typed while it loads')
  assert.equal(M.imageReferenceInsertion(afterTyping, at, [1]).text, 'veja a imagem #image 1 e depois compare')
  assert.equal(M.rebaseInsertionPoint(original, 'olá, ' + original, original.length), original.length + 5)
  assert.equal(M.rebaseInsertionPoint('abc def', 'abc novo def', 4), 4)
  assert.equal(M.rebaseInsertionPoint('abc def', 'abc novo def', 7), 12)
  assert.equal(M.rebaseInsertionPoint('abc def', 'abc', 7), 3)
})

test('overlapping asynchronous uploads retain input order at the same caret', () => {
  const original = 'compare'
  const first = M.imageReferenceInsertion(original, original.length, [1])
  const secondAt = M.rebaseInsertionPoint(original, first.text, original.length, 'right')
  assert.equal(secondAt, first.caret)
  const second = M.imageReferenceInsertion(first.text, secondAt, [2])
  assert.equal(second.text, 'compare #image 1 #image 2 ')
  assert.equal(M.rebaseInsertionPoint(original, first.text, original.length), original.length)
})

test('removing an automatic attachment clears its prose references without touching other images or literal examples', () => {
  const text = 'Compare #image 2 com #image 1 e depois #image2 de novo; `#image 2` https://test/#image2 #image2.png'
  const removal = M.imageReferenceRemoval(text, 2)
  assert.equal(removal.text, 'Compare com #image 1 e depois de novo; `#image 2` https://test/#image2 #image2.png')
  assert.equal(M.applyCompletion(text, removal.start, removal.end, removal.insert).text, removal.text)
  assert.equal(M.imageReferenceRemoval('#image 12 e #image 1', 2), null)
  assert.equal(M.imageReferenceRemoval('#image 1 ', 1).text, '')
  assert.equal(M.imageReferenceRemoval('```\n#image 1\n```', 1), null)
})

/* ---------------- small helpers ---------------- */

test('triggerKey', () => {
  assert.equal(M.triggerKey(null), null)
  assert.equal(M.triggerKey(M.findTrigger('x @ab', 5)), 'mention:2')
  assert.equal(M.triggerKey(M.findTrigger('/a', 2)), 'slash:0')
})

test('applyCompletion', () => {
  assert.deepEqual(M.applyCompletion('ver @sr ok', 4, 7, '@src/ '), { text: 'ver @src/  ok', caret: 10 })
  assert.deepEqual(M.applyCompletion('/l', 0, 2, ''), { text: '', caret: 0 })
})

test('removalRange removes only one following space', () => {
  const t = M.findTrigger('/limpar resto', 7)
  assert.deepEqual(M.removalRange('/limpar resto', t), { start: 0, end: 8 })
  assert.deepEqual(M.removalRange('/limpar  resto', M.findTrigger('/limpar  resto', 7)), { start: 0, end: 8 })
  assert.deepEqual(M.removalRange('/limpar', M.findTrigger('/limpar', 7)), { start: 0, end: 7 })
  assert.deepEqual(M.removalRange('/limpar\nx', M.findTrigger('/limpar\nx', 7)), { start: 0, end: 7 })
})

test('wrapIndex', () => {
  assert.equal(M.wrapIndex(0, 1, 3), 1)
  assert.equal(M.wrapIndex(2, 1, 3), 0)
  assert.equal(M.wrapIndex(0, -1, 3), 2)
  assert.equal(M.wrapIndex(5, 0, 0), 0)
  assert.equal(M.wrapIndex(1, 1, -2), 0)
  assert.equal(M.wrapIndex(99, 1, 3), 0) // clamped to 2, then +1 wraps
  assert.equal(M.wrapIndex(99, -1, 3), 1)
  assert.equal(M.wrapIndex(-5, 1, 3), 1) // clamped to 0
  assert.equal(M.wrapIndex(-5, -1, 3), 2)
})

/* ---------------- ranking ---------------- */

test('fuzzyScore', () => {
  assert.equal(M.fuzzyScore('abc', ''), 0)
  assert.equal(M.fuzzyScore('abc', 'ABC'), 0)
  assert.equal(M.fuzzyScore('ABC', 'ac'), 1)
  assert.equal(M.fuzzyScore('abc', 'cb'), null)
  assert.equal(M.fuzzyScore('abc', 'x'), null)
  assert.equal(M.fuzzyScore('xxabc', 'abc'), 2)
  assert.ok(M.fuzzyScore('abc', 'ac') < M.fuzzyScore('axxc', 'ac'))
})

test('rankSlashCommands', () => {
  const cmds = [
    { name: 'zlimpar', description: '' },        // substring of name
    { name: 'limpar', description: '' },         // prefix
    { name: 'lxixm', description: '' },          // subsequence
    { name: 'outro', description: 'tem lim aqui' }, // description substring
    { name: 'nada', description: 'nada' },       // dropped
    { name: 'limite', description: '' }          // prefix, tie with limpar -> input order
  ]
  const names = M.rankSlashCommands(cmds, 'lim').map((c) => c.name)
  assert.deepEqual(names.slice(0, 3), ['limpar', 'limite', 'zlimpar'])
  assert.ok(names.includes('lxixm') && names.includes('outro'))
  assert.ok(!names.includes('nada'))
  assert.equal(names.length, 5)
  assert.deepEqual(M.rankSlashCommands(cmds, '').map((c) => c.name), cmds.map((c) => c.name))
  assert.deepEqual(M.rankSlashCommands(cmds, '   ').map((c) => c.name), cmds.map((c) => c.name))
  assert.deepEqual(M.rankSlashCommands(cmds, 'LIMP').map((c) => c.name), ['limpar', 'zlimpar'])
})

/* ---------------- prismCommands ---------------- */

const ctx = (o = {}) => ({ provider: 'claude', busy: false, canCompact: true, hasOpenFile: true, ...o })

test('prismCommands: catalog per provider', () => {
  const claude = M.prismCommands(ctx()).map((c) => c.name)
  assert.deepEqual(claude, ['compactar', 'conta', 'corrigir', 'explicar', 'limpar', 'login', 'logout', 'remote-control', 'sessoes', 'testes'])
  const codex = M.prismCommands(ctx({ provider: 'codex' }))
  assert.deepEqual(codex.map((c) => c.name), ['conta', 'corrigir', 'explicar', 'limpar', 'login', 'logout', 'remote-control', 'sessoes', 'testes'])
  for (const c of [...M.prismCommands(ctx()), ...codex]) {
    assert.equal(c.group, 'prism')
    assert.equal(c.leadingOnly, true)
    assert.equal(c.id, `prism:${c.name}`)
  }
})

test('prismCommands: compactar state', () => {
  const get = (o) => M.prismCommands(ctx(o)).find((c) => c.name === 'compactar')
  assert.equal(get({}).disabledReason, null)
  assert.ok(get({ busy: true }).disabledReason)
  assert.ok(get({ canCompact: false }).disabledReason)
  assert.ok(get({ busy: true, canCompact: false }).disabledReason)
})

test('prismCommands: templates and actions', () => {
  const byName = (o) => Object.fromEntries(M.prismCommands(ctx(o)).map((c) => [c.name, c]))
  const withFile = byName({}), noFile = byName({ hasOpenFile: false })
  for (const n of ['explicar', 'corrigir', 'testes']) {
    assert.equal(withFile[n].action, 'template')
    assert.ok(withFile[n].template && withFile[n].template.length > 0)
    assert.equal(withFile[n].disabledReason, null)
    assert.ok(noFile[n].disabledReason)
    assert.ok(noFile[n].template)
  }
  for (const n of ['limpar', 'sessoes', 'conta', 'login', 'logout', 'remote-control', 'compactar']) {
    assert.equal(withFile[n].action, 'run')
    assert.equal(withFile[n].template, null)
    assert.equal(noFile[n].disabledReason, null)
  }
})

/* ---------------- diskCommandItems ---------------- */

test('diskCommandItems', () => {
  const list = [
    { name: '/deploy', description: 'd', source: 'user' },
    { name: 'build', description: 'b', source: 'project' },
    { name: '/frontend-design', description: 'f', source: 'skill' },
    { name: '/help', description: 'h', source: 'client' },
    { name: '/', description: 'empty', source: 'user' }
  ]
  assert.deepEqual(M.diskCommandItems(list, { provider: 'codex', remote: false }), [])
  assert.deepEqual(M.diskCommandItems(list, { provider: 'claude', remote: true }), [])
  const items = M.diskCommandItems(list, { provider: 'claude', remote: false })
  assert.deepEqual(items.map((i) => i.name), ['deploy', 'build', 'frontend-design'])
  const [deploy, build, skill] = items
  for (const c of [deploy, build]) {
    assert.equal(c.group, 'custom')
    assert.equal(c.leadingOnly, true)
    assert.equal(c.action, 'insert')
  }
  assert.equal(deploy.id, 'custom:deploy')
  assert.equal(skill.group, 'skill')
  assert.equal(skill.leadingOnly, false)
  assert.equal(skill.action, 'insert')
  assert.equal(skill.id, 'skill:frontend-design')
  assert.equal(skill.disabledReason, null)
})

/* ---------------- buildCommandSections ---------------- */

const item = (name, group, extra = {}) => ({
  id: `${group}:${name}`, name, description: '', argumentHint: null, group,
  action: 'insert', template: null, leadingOnly: group !== 'skill', disabledReason: null, ...extra
})

test('buildCommandSections: group order, empty groups, sorting', () => {
  const cmds = [item('zeta', 'skill'), item('beta', 'custom'), item('Alfa', 'prism'), item('alpha2', 'prism'), item('delta', 'custom')]
  const s = M.buildCommandSections(cmds, '', true)
  assert.deepEqual(s.map((x) => x.group), ['prism', 'custom', 'skill'])
  assert.deepEqual(s.map((x) => x.label), [M.COMMAND_GROUP_LABEL.prism, M.COMMAND_GROUP_LABEL.custom, M.COMMAND_GROUP_LABEL.skill])
  assert.deepEqual(s[0].items.map((i) => i.name), ['Alfa', 'alpha2'])
  assert.deepEqual(s[1].items.map((i) => i.name), ['beta', 'delta'])
  const only = M.buildCommandSections([item('zeta', 'skill')], '', true)
  assert.deepEqual(only.map((x) => x.group), ['skill'])
  assert.deepEqual(M.buildCommandSections([], '', true), [])
  assert.deepEqual(M.buildCommandSections(cmds, 'zzzz', true), [])
})

test('buildCommandSections: dedupe, prism wins', () => {
  const cmds = [item('Limpar', 'skill'), item('limpar', 'custom'), item('LIMPAR', 'prism'), item('outro', 'custom')]
  const s = M.buildCommandSections(cmds, '', true)
  assert.deepEqual(s.map((x) => x.group), ['prism', 'custom'])
  assert.equal(s[0].items[0].name, 'LIMPAR')
  assert.deepEqual(s[1].items.map((i) => i.name), ['outro'])
  // custom beats skill
  const s2 = M.buildCommandSections([item('x', 'skill'), item('X', 'custom')], '', true)
  assert.deepEqual(s2.map((x) => x.group), ['custom'])
})

test('buildCommandSections: leading=false', () => {
  const cmds = [
    item('a', 'prism'), item('b', 'custom'), item('c', 'skill'),
    item('d', 'prism', { disabledReason: 'motivo próprio' })
  ]
  const s = M.buildCommandSections(cmds, '', false)
  const all = Object.fromEntries(s.flatMap((x) => x.items).map((i) => [i.name, i]))
  assert.equal(all.a.disabledReason, M.LEADING_ONLY_REASON)
  assert.equal(all.b.disabledReason, M.LEADING_ONLY_REASON)
  assert.equal(all.c.disabledReason, null)
  assert.equal(all.d.disabledReason, 'motivo próprio')
  // inputs are not mutated
  assert.equal(cmds[0].disabledReason, null)
  // leading=true leaves everything alone
  const lead = M.buildCommandSections(cmds, '', true).flatMap((x) => x.items)
  assert.equal(lead.find((i) => i.name === 'a').disabledReason, null)
})

test('buildCommandSections: query ranks within group', () => {
  const cmds = [item('zlim', 'prism'), item('limpar', 'prism'), item('outro', 'custom')]
  const s = M.buildCommandSections(cmds, 'lim', true)
  assert.deepEqual(s.map((x) => x.group), ['prism'])
  assert.deepEqual(s[0].items.map((i) => i.name), ['limpar', 'zlim'])
})

/* ---------------- mentions ---------------- */

test('mentionEntries: Windows root', () => {
  const files = [
    { path: 'C:\\proj\\src\\a\\b.ts', rel: 'src\\a\\b.ts' },
    { path: 'C:\\proj\\src\\c.ts', rel: './src/c.ts' },
    { path: 'C:\\proj\\README.md', rel: 'README.md' },
    { path: 'C:\\proj\\', rel: '' }
  ]
  const e = M.mentionEntries(files, 'C:\\proj')
  const by = Object.fromEntries(e.map((x) => [x.id, x]))
  assert.deepEqual(Object.keys(by).sort(), ['file:README.md', 'file:src/a/b.ts', 'file:src/c.ts', 'folder:src', 'folder:src/a'])
  assert.equal(e.length, 5)
  const f = by['file:src/a/b.ts']
  assert.equal(f.kind, 'file')
  assert.equal(f.name, 'b.ts')
  assert.equal(f.dir, 'src/a')
  assert.equal(f.depth, 2)
  assert.equal(f.absolutePath, 'C:\\proj\\src\\a\\b.ts')
  assert.equal(by['file:README.md'].depth, 0)
  assert.equal(by['file:README.md'].dir, '')
  assert.equal(by['folder:src'].absolutePath, 'C:\\proj\\src')
  assert.equal(by['folder:src/a'].absolutePath, 'C:\\proj\\src\\a')
  assert.equal(by['folder:src/a'].name, 'a')
  assert.equal(by['folder:src/a'].dir, 'src')
  assert.equal(by['folder:src/a'].depth, 1)
  assert.equal(by['folder:src'].depth, 0)
})

test('mentionEntries: POSIX root', () => {
  const e = M.mentionEntries([{ path: '/proj/x/y.ts', rel: 'x/y.ts' }], '/proj/')
  const folder = e.find((x) => x.kind === 'folder')
  assert.equal(folder.absolutePath, '/proj/x')
})

const E = (rel, kind = 'file') => {
  const segs = rel.split('/')
  return { id: `${kind}:${rel}`, kind, rel, name: segs[segs.length - 1], dir: segs.slice(0, -1).join('/'), absolutePath: '/r/' + rel, depth: segs.length - 1 }
}

test('rankMentions: empty query', () => {
  const entries = [E('z/deep/f.ts'), E('b.ts'), E('src', 'folder'), E('a.ts'), E('z', 'folder'), E('z/deep', 'folder'), E('src/pin.ts'), E('src/pin2.ts')]
  const r = M.rankMentions(entries, '', ['src/pin2.ts', 'nope.ts', 'src/pin.ts', 'src/pin2.ts', 'src'])
  assert.deepEqual(r.slice(0, 2).map((e) => e.rel), ['src/pin2.ts', 'src/pin.ts'])
  // depth 0: folders before files, alphabetical
  assert.deepEqual(r.slice(2, 6).map((e) => e.rel), ['src', 'z', 'a.ts', 'b.ts'])
  // depth 1 then 2
  assert.deepEqual(r.slice(6).map((e) => e.rel), ['z/deep', 'z/deep/f.ts'])
  assert.equal(r.length, entries.length)
})

test('rankMentions: query tiers', () => {
  const entries = [
    E('lib/xx.ts'),          // path substring only ('lib')
    E('app/liberty.ts'),     // name prefix
    E('app/my-lib.ts'),      // name substring
    E('lib', 'folder'),      // name prefix, short path
    E('lib.ts'),             // name prefix, same rel length as folder? 'lib.ts' longer
    E('unrelated.ts')
  ]
  const r = M.rankMentions(entries, 'lib').map((e) => e.rel)
  assert.deepEqual(r.slice(0, 3), ['lib', 'lib.ts', 'app/liberty.ts'])
  assert.equal(r[3], 'app/my-lib.ts')
  assert.equal(r[4], 'lib/xx.ts')
  assert.ok(!r.includes('unrelated.ts'))
})

test('rankMentions: file before folder on tie, backslash query, limit', () => {
  const r = M.rankMentions([E('ab', 'folder'), E('ab')], 'ab').map((e) => e.kind)
  assert.deepEqual(r, ['file', 'folder'])
  const entries = [E('src/a.ts'), E('src/b.ts')]
  assert.deepEqual(M.rankMentions(entries, 'src\\a').map((e) => e.rel), ['src/a.ts'])
  const many = Array.from({ length: 40 }, (_, i) => E(`f${String(i).padStart(2, '0')}.ts`))
  assert.equal(M.MENTION_LIMIT, 25)
  assert.equal(M.rankMentions(many, '').length, 25)
  assert.equal(M.rankMentions(many, 'f').length, 25)
  assert.equal(M.rankMentions(many, '', [], 3).length, 3)
  assert.equal(M.rankMentions(many, 'f', [], 4).length, 4)
})

test('mentionText', () => {
  assert.equal(M.mentionText({ rel: 'a/b.ts', kind: 'file' }), '@a/b.ts')
  assert.equal(M.mentionText({ rel: 'a/b', kind: 'folder' }), '@a/b/')
  assert.equal(M.mentionText({ rel: 'a/b/', kind: 'folder' }), '@a/b/')
  assert.equal(M.mentionText({ rel: 'a b/c.ts', kind: 'file' }), '@"a b/c.ts"')
  assert.equal(M.mentionText({ rel: 'a b', kind: 'folder' }), '@"a b/"')
})

test('relativeTo', () => {
  assert.equal(M.relativeTo('C:\\proj', 'c:\\PROJ\\src\\a.ts'), 'src/a.ts')
  assert.equal(M.relativeTo('C:\\proj\\', 'C:/proj/a.ts'), 'a.ts')
  assert.equal(M.relativeTo('C:\\proj', 'C:\\other\\a.ts'), null)
  assert.equal(M.relativeTo('C:\\proj', 'C:\\project\\a.ts'), null)
  assert.equal(M.relativeTo('C:\\proj', 'C:\\proj'), null)
  assert.equal(M.relativeTo('/proj', '/proj/src/a.ts'), 'src/a.ts')
  assert.equal(M.relativeTo('/proj', '/PROJ/src/a.ts'), null)
  assert.equal(M.relativeTo('/proj', '/proj'), null)
  assert.equal(M.relativeTo('/proj', '/projx/a.ts'), null)
  assert.equal(M.relativeTo('', '/a'), null)
})

test('basenameOf / dirnameOf / joinPath', () => {
  assert.equal(M.basenameOf('a/b/c.ts'), 'c.ts')
  assert.equal(M.basenameOf('a/b/'), 'b')
  assert.equal(M.basenameOf('c'), 'c')
  assert.equal(M.dirnameOf('a/b/c.ts'), 'a/b')
  assert.equal(M.dirnameOf('a/b/'), 'a')
  assert.equal(M.dirnameOf('c'), '')
  assert.equal(M.joinPath('C:\\proj', 'a/b'), 'C:\\proj\\a\\b')
  assert.equal(M.joinPath('C:\\proj\\', 'a'), 'C:\\proj\\a')
  assert.equal(M.joinPath('/proj', 'a/b'), '/proj/a/b')
  assert.equal(M.joinPath('/proj/', 'a'), '/proj/a')
  assert.equal(M.joinPath('C:/proj', 'a/b'), 'C:/proj/a/b')
})

test('mentionPathTree', () => {
  const t = (p, f = true) => ({ ...M.mentionPathTree(p, f), midDirs: [...M.mentionPathTree(p, f).midDirs] })
  assert.deepEqual(t('f.ts'), { rootLabel: '', midDirs: [], leaf: 'f.ts', leafIsFile: true })
  assert.deepEqual(t('a/f.ts'), { rootLabel: 'a', midDirs: [], leaf: 'f.ts', leafIsFile: true })
  assert.deepEqual(t('a/b/f.ts'), { rootLabel: 'a', midDirs: ['b'], leaf: 'f.ts', leafIsFile: true })
  assert.deepEqual(t('a/b/c/f.ts'), { rootLabel: 'a', midDirs: ['b', 'c'], leaf: 'f.ts', leafIsFile: true })
  assert.deepEqual(t('a/b/c/d/e/f.ts'), { rootLabel: 'a/b/c', midDirs: ['d', 'e'], leaf: 'f.ts', leafIsFile: true })
  assert.deepEqual(t('/a/b/c/d/f', false), { rootLabel: '/a/b', midDirs: ['c', 'd'], leaf: 'f', leafIsFile: false })
  assert.deepEqual(t('/f.ts'), { rootLabel: '', midDirs: [], leaf: '/f.ts', leafIsFile: true })
  assert.deepEqual(t('a\\b\\c\\d\\e\\'), { rootLabel: 'a/b', midDirs: ['c', 'd'], leaf: 'e', leafIsFile: true })
  assert.deepEqual(t(''), { rootLabel: '', midDirs: [], leaf: '', leafIsFile: true })
})

test('middleElideRootLabel', () => {
  const exact = 'a'.repeat(42)
  assert.equal(M.middleElideRootLabel(exact), exact)
  assert.equal(M.middleElideRootLabel('a/b'), 'a/b')
  const long = ['x'.repeat(20), 'y'.repeat(20), 'z'.repeat(20)].join('/')
  assert.equal(M.middleElideRootLabel(long), `${'x'.repeat(20)}/…/${'z'.repeat(20)}`)
  assert.equal(M.middleElideRootLabel('/' + long), `/${'x'.repeat(20)}/…/${'z'.repeat(20)}`)
  // two segments never elided, even when long
  const two = `${'x'.repeat(30)}/${'y'.repeat(30)}`
  assert.equal(M.middleElideRootLabel(two), two)
})

test('prismCommands: nativeCompact hides /compactar for claude only', () => {
  const ctx = { busy: false, canCompact: true, hasOpenFile: true }
  const has = (extra) => M.prismCommands({ ...ctx, ...extra }).map((i) => i.name)
  const base = has({ provider: 'claude' })
  assert.ok(base.includes('compactar'))
  const hidden = has({ provider: 'claude', nativeCompact: true })
  assert.ok(!hidden.includes('compactar'))
  assert.deepEqual(hidden, base.filter((n) => n !== 'compactar'))
  assert.ok(has({ provider: 'claude', nativeCompact: false }).includes('compactar'))
  assert.ok(!has({ provider: 'codex' }).includes('compactar'))
  assert.ok(!has({ provider: 'codex', nativeCompact: false }).includes('compactar'))
})
