const { test } = require('node:test')
const assert = require('node:assert/strict')
const loadTypescript = require('./helpers/load-typescript.cjs')
const A = loadTypescript('src/renderer/src/components/chat/activity.ts')

const tool = (name, input = {}, extra = {}) => ({ kind: 'tool', name, input, ...extra })
const think = (text = 'hmm', extra = {}) => ({ kind: 'thinking', text, ...extra })
const text = (t, extra = {}) => ({ kind: 'text', text: t, ...extra })
const item = (segment, key, streaming = false) => ({ key, index: 0, segment, streaming })

/* formatting */

test('formatClock', () => {
  assert.equal(A.formatClock(0), '0s')
  assert.equal(A.formatClock(12), '12s')
  assert.equal(A.formatClock(59.9), '59s')
  assert.equal(A.formatClock(60), '1m 0s')
  assert.equal(A.formatClock(184), '3m 4s')
  assert.equal(A.formatClock(3723), '1h 2m 3s')
  assert.equal(A.formatClock(-5), '0s')
})

test('formatWorkedFor', () => {
  assert.equal(A.formatWorkedFor(0), '<1s')
  assert.equal(A.formatWorkedFor(999), '<1s')
  assert.equal(A.formatWorkedFor(NaN), '<1s')
  assert.equal(A.formatWorkedFor(-10), '<1s')
  assert.equal(A.formatWorkedFor(1999), '1s')
  assert.equal(A.formatWorkedFor(184000), '3m 4s')
})

test('singleLine collapses whitespace and truncates', () => {
  assert.equal(A.singleLine('  a \n\t b   c '), 'a b c')
  assert.equal(A.singleLine('x'.repeat(10), 8), 'xxxxx...')
  assert.equal(A.singleLine('abcdef', 6), 'abcdef')
})

test('relativePath', () => {
  assert.equal(A.relativePath('/x/a/b.ts', '/x'), 'a/b.ts')
  assert.equal(A.relativePath('/x/a/b.ts', '/x/'), 'a/b.ts')
  assert.equal(A.relativePath('C:\\Proj\\src\\a.ts', 'c:\\proj'), 'src/a.ts')
  assert.equal(A.relativePath('c:/proj/src/a.ts', 'C:\\Proj\\'), 'src/a.ts')
  assert.equal(A.relativePath('/y/a.ts', '/x'), '/y/a.ts')
  assert.equal(A.relativePath('/x', '/x'), '.')
  assert.equal(A.relativePath('/xy/a.ts', '/x'), '/xy/a.ts')
  assert.equal(A.relativePath('/x/a', undefined), '/x/a')
  assert.equal(A.relativePath('', '/x'), '')
})

test('baseName', () => {
  assert.equal(A.baseName('/a/b/c.ts'), 'c.ts')
  assert.equal(A.baseName('C:\\a\\b.ts'), 'b.ts')
  assert.equal(A.baseName('/a/b/'), 'b')
})

test('verbs are deterministic and belong to the lists', () => {
  const w = A.pickWorkingVerb('seed-1'), e = A.pickElapsedVerb('seed-1')
  assert.equal(A.pickWorkingVerb('seed-1'), w)
  assert.equal(A.pickElapsedVerb('seed-1'), e)
  assert.match(w, /^[A-Z][a-zçã]+ndo$/)
  assert.match(e, /^[A-Z][a-zçã]+u$|^Remoeu$/)
  const seen = new Set()
  for (let i = 0; i < 60; i++) seen.add(A.pickWorkingVerb(`s${i}`))
  assert.ok(seen.size > 3)
  assert.ok(typeof A.pickWorkingVerb('') === 'string')
})

/* tool classification */

test('toolKind', () => {
  const cases = {
    Read: 'read', Glob: 'explore', Grep: 'search', WebSearch: 'search', WebFetch: 'search',
    Edit: 'edit', MultiEdit: 'edit', Write: 'edit', NotebookEdit: 'edit', Bash: 'run',
    Task: 'subagent', Agent: 'subagent', spawn_agent: 'subagent', 'functions.spawn_agent': 'subagent', PreToolUseHook: 'hook', mcp__x: 'tool', Whatever: 'tool'
  }
  for (const [name, kind] of Object.entries(cases)) assert.equal(A.toolKind(name), kind, name)
  assert.equal(A.normalizeToolName('Web-Search x'), 'web_search_x')
})

test('native subagents remain visible after the parent turn and replace their spawn tool', () => {
  const subagent = { id: 'native-child', chatId: 'child', name: 'Revisar API', status: 'running', startedAt: 10, updatedAt: 20, spawnToolCallId: 'spawn-1' }
  const segments = [tool('spawn_agent', { message: 'Review' }, { toolId: 'spawn-1', status: 'done' }),
    text('Continuei o trabalho principal.'), tool('Agent', {}, { toolId: 'subagent:native-child', status: 'done', subagent })]
  const timeline = A.buildTimeline(segments, { running: false })
  assert.deepEqual(timeline.map(i => i.kind), ['text', 'subagent'])
  assert.equal(timeline[1].segment.subagent.status, 'running', 'parent completion must not complete the native subagent')
  assert.equal(timeline[1].segment.subagent.chatId, 'child')
  const failed = A.buildTimeline([{ ...segments[2], subagent: { ...subagent, status: 'failed' } }], { running: false })
  assert.equal(failed[0].segment.subagent.status, 'failed')
})

test('rowKind', () => {
  assert.equal(A.rowKind({ name: 'Bash', input: { command: 'ls' } }), 'command')
  assert.equal(A.rowKind({ name: 'Bash', input: {} }), 'tool')
  assert.equal(A.rowKind({ name: 'Edit', input: { file_path: '/a', old_string: 'a', new_string: 'b' } }), 'file')
  assert.equal(A.rowKind({ name: 'Edit', input: {} }), 'tool')
  assert.equal(A.rowKind({ name: 'Read', input: { file_path: '/a' } }), 'tool')
  assert.equal(A.rowKind({ name: 'Write', input: { changes: [{ path: '/a', kind: 'add', diff: 'x' }] } }), 'file')
  assert.equal(A.rowKind({ name: 'mcp__x', input: null }), 'tool')
})

test('toolSummary', () => {
  assert.equal(A.toolSummary('Read', { file_path: '/w/src/a.ts' }, '/w'), 'src/a.ts')
  assert.equal(A.toolSummary('Grep', { pattern: 'foo', path: '/w/src' }, '/w'), 'foo em src')
  assert.equal(A.toolSummary('Grep', { pattern: 'foo' }, '/w'), 'foo')
  assert.equal(A.toolSummary('Glob', { pattern: '**/*.ts' }), '**/*.ts')
  assert.equal(A.toolSummary('WebFetch', { url: 'http://x' }), 'http://x')
  assert.equal(A.toolSummary('WebSearch', { query: 'q' }), 'q')
  assert.equal(A.toolSummary('Task', { description: 'do it' }), 'do it')
  assert.equal(A.toolSummary('TodoWrite', { todos: [1] }), '1 tarefa')
  assert.equal(A.toolSummary('TodoWrite', { todos: [1, 2] }), '2 tarefas')
  assert.equal(A.toolSummary('Bash', { command: 'echo   a\n b' }), 'echo a b')
  assert.equal(A.toolSummary('mcp__x', {}), null)
  assert.equal(A.toolSummary('Read', null), null)
})

test('toolInputDetail', () => {
  assert.deepEqual(A.toolInputDetail('Bash', { command: 'ls -la' }, 'ls -la'), { kind: 'command', command: 'ls -la' })
  const d = A.toolInputDetail('mcp__x', { file_path: '/a', maxResults: 3, empty: '', nested: { a: 1 } }, null)
  assert.equal(d.kind, 'fields')
  assert.deepEqual(d.entries.map((e) => [e.key, e.label, e.value]), [
    ['file_path', 'file path', '/a'],
    ['maxResults', 'max results', '3'],
    ['nested', 'nested', JSON.stringify({ a: 1 }, null, 2)]
  ])
  assert.equal(A.toolInputDetail('Read', { file_path: 'C:\\w\\a.ts' }, 'a.ts'), null)
  assert.equal(A.toolInputDetail('Read', { file_path: 'C:\\w\\a.ts' }, 'C:/w/a.ts'), null)
  assert.equal(A.toolInputDetail('mcp__x', {}, null), null)
  assert.equal(A.toolInputDetail('mcp__x', { a: 'one' }, 'different').kind, 'fields')
})

/* diffs */

test('lineDiff basics', () => {
  assert.deepEqual(A.lineDiff('a\nb\nc', 'a\nB\nc'), [
    { type: 'context', text: 'a' }, { type: 'del', text: 'b' }, { type: 'add', text: 'B' }, { type: 'context', text: 'c' }
  ])
  assert.deepEqual(A.lineDiff('same\ntext', 'same\ntext'), [])
  assert.deepEqual(A.lineDiff('', ''), [])
})

test('lineDiff puts dels before adds in a changed run', () => {
  const types = A.lineDiff('x\ny\nz', 'p\nq\nr').map((l) => l.type)
  assert.deepEqual(types, ['del', 'del', 'del', 'add', 'add', 'add'])
})

test('lineDiff insertion and CRLF', () => {
  assert.deepEqual(A.lineDiff('a\nc', 'a\nb\nc'), [
    { type: 'context', text: 'a' }, { type: 'add', text: 'b' }, { type: 'context', text: 'c' }
  ])
  assert.deepEqual(A.lineDiff('a\r\nb\r\n', 'a\r\nc\r\n').map((l) => l.text), ['a', 'b', 'c'])
})

test('lineDiff folds context to 3 lines with hunk markers', () => {
  const base = Array.from({ length: 20 }, (_, i) => `l${i}`)
  const next = base.slice()
  next[1] = 'X'
  next[18] = 'Y'
  const out = A.lineDiff(base.join('\n'), next.join('\n'))
  assert.equal(out.filter((l) => l.type === 'hunk').length, 1)
  assert.equal(out.find((l) => l.type === 'hunk').text, '')
  // first hunk: l0 ctx, del l1, add X, ctx l2 l3 l4
  assert.deepEqual(out.slice(0, 6).map((l) => l.text), ['l0', 'l1', 'X', 'l2', 'l3', 'l4'])
  assert.deepEqual(out.slice(-6).map((l) => l.text), ['l15', 'l16', 'l17', 'l18', 'Y', 'l19'])
  assert.equal(out.some((l) => l.text === 'l8'), false)
})

test('lineDiff honours custom context', () => {
  const out = A.lineDiff('a\nb\nc\nd\ne', 'a\nb\nX\nd\ne', 1)
  assert.deepEqual(out.map((l) => l.text), ['b', 'c', 'X', 'd'])
})

test('foldContext', () => {
  assert.deepEqual(A.foldContext([{ type: 'context', text: 'a' }]), [])
  const lines = [
    ...Array.from({ length: 10 }, (_, i) => ({ type: 'context', text: `c${i}` })),
    { type: 'add', text: 'n' }
  ]
  const out = A.foldContext(lines, 2)
  assert.deepEqual(out.map((l) => l.text), ['c8', 'c9', 'n'])
})

test('parseUnifiedDiff', () => {
  const diff = [
    '--- a/f', '+++ b/f', '@@ -1,2 +1,2 @@', ' ctx', '-old', '+new',
    '\\ No newline at end of file', '@@ -9 +9 @@', '-x', '+y'
  ].join('\n')
  assert.deepEqual(A.parseUnifiedDiff(diff), [
    { type: 'context', text: 'ctx' }, { type: 'del', text: 'old' }, { type: 'add', text: 'new' },
    { type: 'hunk', text: '' }, { type: 'del', text: 'x' }, { type: 'add', text: 'y' }
  ])
  assert.deepEqual(A.parseUnifiedDiff('no hunks here'), [])
})

test('fileChanges: Edit', () => {
  const [c] = A.fileChanges('Edit', { file_path: '/a.ts', old_string: 'a\nb', new_string: 'a\nc' })
  assert.equal(c.path, '/a.ts')
  assert.equal(c.operation, 'edit')
  assert.equal(c.additions, 1)
  assert.equal(c.deletions, 1)
  assert.deepEqual(A.fileChanges('Edit', { old_string: 'a', new_string: 'b' }), [])
})

test('fileChanges: MultiEdit separates edits with hunk', () => {
  const [c] = A.fileChanges('MultiEdit', {
    file_path: '/a.ts',
    edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }]
  })
  assert.deepEqual(c.lines.map((l) => l.type), ['del', 'add', 'hunk', 'del', 'add'])
  assert.equal(c.additions, 2)
  assert.equal(c.deletions, 2)
})

test('fileChanges: Write and NotebookEdit', () => {
  const [w] = A.fileChanges('Write', { file_path: '/n.txt', content: 'a\nb\n' })
  assert.equal(w.operation, 'write')
  assert.deepEqual(w.lines, [{ type: 'add', text: 'a' }, { type: 'add', text: 'b' }])
  assert.equal(w.additions, 2)
  assert.equal(w.deletions, 0)
  const [n] = A.fileChanges('NotebookEdit', { notebook_path: '/n.ipynb', new_source: 'x=1' })
  assert.equal(n.path, '/n.ipynb')
  assert.deepEqual(n.lines, [{ type: 'add', text: 'x=1' }])
})

test('fileChanges: Codex changes array', () => {
  const out = A.fileChanges('fileChange', {
    changes: [
      { path: '/new.ts', kind: { type: 'add' }, diff: 'l1\nl2' },
      { path: '/gone.ts', kind: 'delete', diff: 'x' },
      { path: '/mod.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-a\n+b' },
      { kind: 'add', diff: 'ignored: no path' }
    ]
  })
  assert.equal(out.length, 3)
  assert.equal(out[0].operation, 'create')
  assert.deepEqual(out[0].lines.map((l) => l.type), ['add', 'add'])
  assert.equal(out[0].additions, 2)
  assert.equal(out[1].operation, 'delete')
  assert.deepEqual(out[1].lines, [{ type: 'del', text: 'x' }])
  assert.equal(out[1].deletions, 1)
  assert.equal(out[2].operation, 'edit')
  assert.deepEqual(out[2].lines, [{ type: 'del', text: 'a' }, { type: 'add', text: 'b' }])
})

test('fileChanges: Codex changes map', () => {
  const out = A.fileChanges('fileChange', {
    changes: { '/a.ts': { kind: { type: 'add' }, content: 'one' }, '/b.ts': { kind: 'update', unified_diff: '@@\n+z' } }
  })
  assert.deepEqual(out.map((c) => [c.path, c.operation, c.additions]), [['/a.ts', 'create', 1], ['/b.ts', 'edit', 1]])
})

test('fileVerb', () => {
  assert.equal(A.fileVerb('create'), 'Criar')
  assert.equal(A.fileVerb('delete'), 'Excluir')
  assert.equal(A.fileVerb('write'), 'Escrever')
  assert.equal(A.fileVerb('edit'), 'Editar')
})

/* timeline */

test('segmentKey', () => {
  assert.equal(A.segmentKey({ kind: 'tool', toolId: 't1' }, 4), 'tool:t1')
  assert.equal(A.segmentKey({ kind: 'text' }, 4), 'i4')
})

test('buildTimeline: text separates groups, contiguous activity merges', () => {
  const segs = [think('a'), tool('Read', {}, { toolId: 't1', status: 'done' }), text('hello'),
    tool('Bash', {}, { toolId: 't2', status: 'done' })]
  const tl = A.buildTimeline(segs, { running: false })
  assert.deepEqual(tl.map((t) => t.kind), ['group', 'text', 'group'])
  assert.equal(tl[0].key, 'g:i0')
  assert.equal(tl[0].items.length, 2)
  assert.equal(tl[0].active, false)
  assert.equal(tl[2].key, 'g:tool:t2')
  assert.equal(tl[1].streaming, false)
})

test('buildTimeline: ignores blank text and empty finished thinking', () => {
  const tl = A.buildTimeline([text('   '), think(''), text('x')], { running: false })
  assert.deepEqual(tl.map((t) => t.kind), ['text'])
})

test('buildTimeline: streaming rules', () => {
  const run = A.buildTimeline([tool('Read', {}, { toolId: 'a', status: 'done' }), text('typing')], { running: true })
  assert.equal(run[1].streaming, true)
  const notLast = A.buildTimeline([text('one'), tool('Read', {}, { toolId: 'a', status: 'done' })], { running: true })
  assert.equal(notLast[0].streaming, false)
  const thinkLast = A.buildTimeline([think('...')], { running: true })
  assert.equal(thinkLast[0].items[0].streaming, true)
  assert.equal(thinkLast[0].active, true)
  const thinkIdle = A.buildTimeline([think('...')], { running: false })
  assert.equal(thinkIdle[0].items[0].streaming, false)
  const emptyStreaming = A.buildTimeline([think('')], { running: true })
  assert.equal(emptyStreaming.length, 1)
})

test('buildTimeline: tool status running/awaiting streams', () => {
  for (const status of ['running', 'awaiting']) {
    const tl = A.buildTimeline([tool('Bash', {}, { toolId: 'x', status }), text('after')], { running: false })
    assert.equal(tl[0].items[0].streaming, true)
    assert.equal(tl[0].active, true)
  }
})

test('buildTimeline: trailing group of running turn is active', () => {
  const tl = A.buildTimeline([tool('Read', {}, { toolId: 'a', status: 'done' })], { running: true })
  assert.equal(tl[0].active, true)
  const mid = A.buildTimeline([tool('Read', {}, { toolId: 'a', status: 'done' }), text('t')], { running: true })
  assert.equal(mid[0].active, false)
})

test('buildTimeline: errored turn turns last text into error', () => {
  const tl = A.buildTimeline([tool('Read', {}, { toolId: 'a', status: 'done' }), text('boom')], { running: false, errored: true })
  assert.deepEqual(tl.map((t) => t.kind), ['group', 'error'])
  assert.equal(tl[1].text, 'boom')
  const running = A.buildTimeline([text('boom')], { running: true, errored: true })
  assert.equal(running[0].kind, 'text')
})

/* summary */

test('reasoningLabel', () => {
  assert.equal(A.reasoningLabel(true, null), 'Pensando')
  assert.equal(A.reasoningLabel(false, null), 'Pensou')
  assert.equal(A.reasoningLabel(false, 100), 'Pensou por 1s')
  assert.equal(A.reasoningLabel(false, 5400), 'Pensou por 5s')
  assert.equal(A.reasoningLabel(false, 65000), 'Pensou por 1m 5s')
})

test('groupSummary: counts in order with pt-BR plurals', () => {
  const items = [
    item(think('x'), 'th'),
    item(tool('Glob'), 'g1'),
    item(tool('Read'), 'r1'), item(tool('Read'), 'r2'),
    item(tool('Grep'), 's1'),
    item(tool('Edit', { file_path: '/a', old_string: 'a', new_string: 'b' }), 'e1'),
    item(tool('Edit', { file_path: '/a', old_string: 'c', new_string: 'd' }), 'e2'),
    item(tool('Bash', { command: 'ls' }), 'b1'), item(tool('Bash', { command: 'pwd' }), 'b2'),
    item(tool('PostHook'), 'h1'),
    item(tool('mcp__traycer_browser__repl'), 'br'),
    item(tool('Task'), 'sa'),
    item(tool('Bash', {}, { status: 'denied' }), 'dn'),
    item(tool('mcp__foo'), 'u1')
  ]
  assert.equal(A.groupSummary(items, new Map([['th', 4000]])),
    'Pensou por 4s, explorou 1 arquivo, leu 2 arquivos, buscou em 1 lugar, editou 1 arquivo, executou 2 comandos, executou 1 hook, navegou em 1 página, criou 1 subagente, negou 1 solicitação, usou 1 ferramenta')
})

test('groupSummary: thinking variants', () => {
  assert.equal(A.groupSummary([item(think('x'), 'a', true)]), 'Pensando')
  assert.equal(A.groupSummary([item(think('x'), 'a')]), 'Pensou')
  assert.equal(A.groupSummary([item(think('x'), 'a'), item(think('y'), 'b')], new Map([['a', 2000]])), 'Pensou por 2s+')
  assert.equal(A.groupSummary([item(think('x'), 'a'), item(think('y'), 'b')], new Map([['a', 2000], ['b', 1000]])), 'Pensou por 3s')
})

test('groupSummary: edited counts distinct files; plurals; empty', () => {
  const edits = [
    item(tool('Edit', { file_path: '/a', old_string: 'a', new_string: 'b' }), 'e1'),
    item(tool('Write', { file_path: '/b', content: 'x' }), 'e2')
  ]
  assert.equal(A.groupSummary(edits), 'Editou 2 arquivos')
  assert.equal(A.groupSummary([]), 'Executou atividade')
  assert.equal(A.groupSummary([item(tool('Bash', {}, { status: 'denied' }), 'a'), item(tool('Bash', {}, { status: 'denied' }), 'b')]), 'Negou 2 solicitações')
})

test('soleReasoning', () => {
  assert.equal(A.soleReasoning([item(think('x'), 'a')]), true)
  assert.equal(A.soleReasoning([item(think('x'), 'a'), item(tool('Read'), 'b')]), false)
  assert.equal(A.soleReasoning([item(tool('Read'), 'b')]), false)
})

test('replyText', () => {
  assert.equal(A.replyText([text('  one '), think('no'), tool('Read'), text(''), text('two')]), 'one\n\ntwo')
  assert.equal(A.replyText([think('x')], '  fallback '), 'fallback')
  assert.equal(A.replyText([]), '')
})

/* diff sides (original / modified) */

test('diffSides rebuilds both sides and skips hunk markers', () => {
  const lines = [
    { type: 'context', text: 'c1' }, { type: 'del', text: 'old' }, { type: 'add', text: 'new' },
    { type: 'hunk', text: '' }, { type: 'context', text: 'c2' }, { type: 'add', text: 'extra' }
  ]
  assert.deepEqual(A.diffSides(lines), { original: 'c1\nold\nc2', modified: 'c1\nnew\nc2\nextra' })
  assert.deepEqual(A.diffSides([]), { original: '', modified: '' })
})

test('fileChanges sides: Edit keeps exact strings', () => {
  const [c] = A.fileChanges('Edit', { file_path: '/a', old_string: 'a\nb\n', new_string: 'a\nc\n' })
  assert.equal(c.original, 'a\nb\n')
  assert.equal(c.modified, 'a\nc\n')
})

test('fileChanges sides: MultiEdit joins with blank lines', () => {
  const [c] = A.fileChanges('MultiEdit', {
    file_path: '/a',
    edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }]
  })
  assert.equal(c.original, 'a\n\nc')
  assert.equal(c.modified, 'b\n\nd')
})

test('fileChanges sides: Write and NotebookEdit', () => {
  const [w] = A.fileChanges('Write', { file_path: '/n', content: 'x\ny' })
  assert.equal(w.original, '')
  assert.equal(w.modified, 'x\ny')
  const [n] = A.fileChanges('NotebookEdit', { notebook_path: '/n.ipynb', new_source: 'x=1' })
  assert.equal(n.original, '')
  assert.equal(n.modified, 'x=1')
})

test('fileChanges sides: Codex changes', () => {
  const out = A.fileChanges('fileChange', {
    changes: [
      { path: '/mod', kind: 'update', diff: '@@ -1,2 +1,2 @@\n ctx\n-a\n+b' },
      { path: '/new', kind: { type: 'add' }, diff: 'l1\nl2' },
      { path: '/gone', kind: 'delete', diff: 'x\ny' }
    ]
  })
  assert.equal(out[0].original, 'ctx\na')
  assert.equal(out[0].modified, 'ctx\nb')
  assert.equal(out[1].original, '')
  assert.equal(out[1].modified, 'l1\nl2')
  assert.equal(out[2].original, 'x\ny')
  assert.equal(out[2].modified, '')
})

test('fileChanges sides: text beyond 800 lines is truncated', () => {
  const big = Array.from({ length: 1000 }, (_, i) => `l${i}`).join('\n')
  const [w] = A.fileChanges('Write', { file_path: '/big', content: big })
  assert.equal(w.modified.split('\n').length, 800)
  assert.equal(w.modified.split('\n')[799], 'l799')
  assert.equal(w.lines.length, 800)
  const [e] = A.fileChanges('Edit', { file_path: '/big', old_string: big, new_string: big + '\nz' })
  assert.equal(e.original.split('\n').length, 800)
  assert.equal(e.modified.split('\n').length, 800)
  const small = A.fileChanges('Write', { file_path: '/s', content: 'a\nb' })[0]
  assert.equal(small.modified, 'a\nb')
})


test('same-turn follow-up separates activities and stays out of the assistant copy text', () => {
  const segments = [{ kind: 'text', text: 'Before' }, { kind: 'user', text: 'Change direction', toolId: 'follow-up' }, { kind: 'thinking', text: 'Considering' }, { kind: 'text', text: 'After' }]
  const timeline = A.buildTimeline(segments, { running: true })
  assert.deepEqual(timeline.map(i => i.kind), ['text', 'user', 'group', 'text'])
  assert.equal(A.replyText(segments), 'Before\n\nAfter')
})
