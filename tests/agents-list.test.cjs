const test = require('node:test')
const assert = require('node:assert/strict')
const load = require('./helpers/load-typescript.cjs')
const m = load('src/renderer/src/components/agents-list/model.ts')

const ids = (list) => list.map((x) => x.id)
const item = (id, parentChatId, title = id) => ({ id, parentChatId, title })
const chat = (id, extra = {}) => ({
  id, title: id, updatedAt: 0, archived: false, taskId: 't1', selection: { provider: 'claude' }, ...extra
})
const view = (extra = {}) => ({ ...m.DEFAULT_VIEW, ...extra })
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR, WEEK = 7 * DAY

/* ---------- 1. tree ---------- */

test('buildTree: roots for no parent, missing parent and self parent', () => {
  const tree = m.buildTree([item('a'), item('b', 'ghost'), item('c', 'c')])
  assert.deepEqual(ids(tree.map((n) => n.item)), ['a', 'b', 'c'])
  assert.ok(tree.every((n) => n.depth === 0 && !n.hasChildren && n.children.length === 0))
})

test('buildTree: nesting, depth, sibling order = input order', () => {
  const tree = m.buildTree([item('r'), item('z', 'r'), item('a', 'r'), item('m', 'z')])
  assert.equal(tree.length, 1)
  assert.deepEqual(ids(tree[0].children.map((n) => n.item)), ['z', 'a'])
  assert.equal(tree[0].hasChildren, true)
  assert.equal(tree[0].children[0].children[0].depth, 2)
  assert.deepEqual(ids(m.flattenTree(tree).map((n) => n.item)), ['r', 'z', 'm', 'a'])
  assert.deepEqual(m.flattenTree(tree).map((n) => n.depth), [0, 1, 2, 1])
})

test('buildTree: parent cycle becomes a root without loop or duplicates', () => {
  const tree = m.buildTree([item('a', 'b'), item('b', 'a')])
  const flat = ids(m.flattenTree(tree).map((n) => n.item))
  assert.deepEqual(flat.slice().sort(), ['a', 'b'])
  assert.equal(tree.length, 1)
  assert.equal(tree[0].depth, 0)
  const tri = m.buildTree([item('x', 'z'), item('y', 'x'), item('z', 'y'), item('ok')])
  const all = ids(m.flattenTree(tri).map((n) => n.item))
  assert.equal(all.length, 4)
  assert.equal(new Set(all).size, 4)
})

test('buildTree: collapsed hides children but keeps hasChildren and descendants', () => {
  const items = [item('r'), item('c', 'r'), item('g', 'c')]
  const [root] = m.buildTree(items, { collapsed: new Set(['r']) })
  assert.equal(root.expanded, false)
  assert.equal(root.hasChildren, true)
  assert.deepEqual(root.children, [])
  assert.deepEqual(ids(root.descendants), ['c', 'g'])
  assert.deepEqual(ids(m.flattenTree([root]).map((n) => n.item)), ['r'])
  const [open] = m.buildTree(items)
  assert.equal(open.expanded, true)
})

test('buildTree: query keeps matches + ancestors and expands everything', () => {
  const items = [item('r', undefined, 'Raiz'), item('c', 'r', 'Filho'), item('g', 'c', 'Alvo neto'), item('o', undefined, 'Outro'), item('s', 'r', 'Irmão')]
  const tree = m.buildTree(items, { query: 'alvo', collapsed: new Set(['r', 'c']) })
  assert.deepEqual(ids(m.flattenTree(tree).map((n) => n.item)), ['r', 'c', 'g'])
  assert.ok(m.flattenTree(tree).every((n) => n.expanded))
  assert.deepEqual(m.buildTree(items, { query: 'zzz' }), [])
  assert.equal(m.buildTree(items, { query: '   ' }).length, 2) // blank query = no filter
})

test('parentIds: only existing, non-self parents', () => {
  const set = m.parentIds([item('a'), item('b', 'a'), item('c', 'c'), item('d', 'ghost'), item('e', 'b')])
  assert.deepEqual([...set].sort(), ['a', 'b'])
})

/* ---------- 2. search ---------- */

test('normalizeSearch / matchesQuery', () => {
  assert.equal(m.normalizeSearch('  Órfão '), 'orfao')
  assert.equal(m.matchesQuery('Agente Órfão', 'orfao'), true)
  assert.equal(m.matchesQuery('agente orfao', 'ÓRFÃO'), true)
  assert.equal(m.matchesQuery('Agente Órfão', 'agente ghost'), false)
  assert.equal(m.matchesQuery('Agente Órfão', 'orfao agente'), true)
  assert.equal(m.matchesQuery('qualquer', ''), true)
  assert.equal(m.matchesQuery('qualquer', '   '), true)
})

/* ---------- 3. visibleChats ---------- */

test('withAncestors keeps ancestors, survives cycles', () => {
  const items = [{ id: 'a' }, { id: 'b', parentChatId: 'a' }, { id: 'c', parentChatId: 'b' }, { id: 'd' }]
  assert.deepEqual(ids(m.withAncestors(items, (i) => i.id === 'c')), ['a', 'b', 'c'])
  const cyc = [{ id: 'a', parentChatId: 'b' }, { id: 'b', parentChatId: 'a' }]
  assert.deepEqual(ids(m.withAncestors(cyc, (i) => i.id === 'a')), ['a', 'b'])
})

test('visibleChats: task filter and archive modes', () => {
  const chats = [chat('a'), chat('b', { archived: true }), chat('x', { taskId: 't2' })]
  assert.deepEqual(ids(m.visibleChats(chats, 't1', view()).sort((p, q) => p.id.localeCompare(q.id))), ['a'])
  assert.deepEqual(ids(m.visibleChats(chats, 't1', view({ archive: 'archived' }))), ['b'])
  assert.deepEqual(ids(m.visibleChats(chats, 't1', view({ archive: 'all' })).sort((p, q) => p.id.localeCompare(q.id))), ['a', 'b'])
  assert.deepEqual(m.visibleChats(chats, 'nope', view({ archive: 'all' })), [])
})

test('visibleChats: pinnedIds keeps an archived chat visible in default mode', () => {
  const chats = [chat('a'), chat('b', { archived: true })]
  const got = m.visibleChats(chats, 't1', view(), new Set(['b']))
  assert.deepEqual(ids(got).sort(), ['a', 'b'])
  assert.deepEqual(ids(m.visibleChats(chats, 't1', view())), ['a'])
})

test('visibleChats: archived parent hides its whole subtree; only the path to a pinned row returns', () => {
  const chats = [chat('p', { archived: true }), chat('k', { parentChatId: 'p' }), chat('s', { parentChatId: 'p' }), chat('free')]
  assert.deepEqual(ids(m.visibleChats(chats, 't1', view())), ['free'])
  assert.deepEqual(ids(m.visibleChats(chats, 't1', view(), new Set(['k']))).sort(), ['free', 'k', 'p'])
})

test('visibleChats: harness filter', () => {
  const chats = [
    chat('c1'),
    chat('c2', { selection: { provider: 'codex' }, sourceHarness: 'claude-code' }),
    chat('c3', { selection: { provider: 'claude' }, sourceHarness: 'codex' }),
    chat('c4', { selection: { provider: 'codex' } }),
    chat('c5', { selection: { provider: 'Claude-Code' } })
  ]
  assert.deepEqual(ids(m.visibleChats(chats, 't1', view({ harness: 'claude' }))).sort(), ['c1', 'c2', 'c5'])
  assert.deepEqual(ids(m.visibleChats(chats, 't1', view({ harness: 'codex' }))).sort(), ['c3', 'c4'])
  assert.equal(m.visibleChats(chats, 't1', view({ harness: 'all' })).length, 5)
  assert.equal(m.harnessOf(chats[1]), 'claude-code')
})

test('compareChats / ordering', () => {
  const chats = [chat('a', { title: 'Item 10', updatedAt: 1 }), chat('b', { title: 'item 2', updatedAt: 3 }), chat('c', { title: 'Ágata', updatedAt: 2 })]
  assert.deepEqual(ids(m.visibleChats(chats, 't1', view())), ['b', 'c', 'a'])
  assert.deepEqual(ids(m.visibleChats(chats, 't1', view({ sort: { field: 'updated', direction: 'asc' } }))), ['a', 'c', 'b'])
  assert.deepEqual(ids(m.visibleChats(chats, 't1', view({ sort: { field: 'name', direction: 'asc' } }))), ['c', 'b', 'a']) // numeric: 2 < 10
  assert.deepEqual(ids(m.visibleChats(chats, 't1', view({ sort: { field: 'name', direction: 'desc' } }))), ['a', 'b', 'c'])
})

test('compareChats tie-breaks: updatedAt desc, then id', () => {
  const sort = { field: 'name', direction: 'asc' }
  const tied = [chat('b', { title: 'Same', updatedAt: 1 }), chat('a', { title: 'SAME', updatedAt: 1 }), chat('c', { title: 'same', updatedAt: 5 })]
  assert.deepEqual(ids(tied.slice().sort(m.compareChats(sort))), ['c', 'a', 'b'])
})

/* ---------- 4. emptyReason ---------- */

test('emptyReason', () => {
  const v = view()
  assert.equal(m.emptyReason([chat('a', { taskId: 'other' })], 't1', v, 0), 'none')
  assert.equal(m.emptyReason([], 't1', v, 0), 'none')
  assert.equal(m.emptyReason([chat('a', { archived: true })], 't1', v, 0), 'archived')
  assert.equal(m.emptyReason([chat('a')], 't1', view({ archive: 'archived' }), 0), 'no-archived')
  assert.equal(m.emptyReason([chat('a', { archived: true })], 't1', view({ harness: 'codex' }), 0, new Set(['a'])), 'filtered')
  assert.equal(m.emptyReason([chat('a')], 't1', view({ archive: 'all', harness: 'codex' }), 0), 'filtered')
  assert.equal(m.emptyReason([chat('a'), chat('b', { archived: true })], 't1', v, 0), 'filtered')
  assert.equal(m.emptyReason([chat('a', { archived: true })], 't1', view({ archive: 'archived', harness: 'codex' }), 0), 'filtered')
  assert.equal(m.emptyReason([chat('a')], 't1', v, 1), null)
})

/* ---------- 5. status ---------- */

test('chatStatusKind precedence', () => {
  const k = m.chatStatusKind
  assert.equal(k({ unread: 'failure', busy: false, question: true }), 'failure')
  assert.equal(k({ unread: 'failure', busy: true }), 'running')
  assert.equal(k({ busy: true, question: true, permission: true }), 'interview')
  assert.equal(k({ busy: true, permission: true }), 'approval')
  assert.equal(k({ busy: true }), 'running')
  assert.equal(k({ busy: true, unread: 'done' }), 'running')
  assert.equal(k({ unread: 'done', readOnly: true }), 'done')
  assert.equal(k({ readOnly: true }), 'read-only')
  assert.equal(k({}), 'idle')
  assert.equal(k({ question: true, permission: true }), 'idle') // not busy
})

test('rollupStatus', () => {
  assert.equal(m.rollupStatus([]), null)
  assert.equal(m.rollupStatus(['idle', 'read-only']), null)
  const r = m.rollupStatus(['running', 'done', 'idle', 'running', 'failure'])
  assert.equal(r.kind, 'failure')
  assert.deepEqual({ ...r.counts }, { failure: 1, interview: 0, approval: 0, running: 2, done: 1 })
  assert.equal(m.rollupStatus(['done', 'approval']).kind, 'approval')
})

test('rollupWins: strictly greater, ties go to parent', () => {
  const run = m.rollupStatus(['running'])
  assert.equal(m.rollupWins('idle', run), true)
  assert.equal(m.rollupWins('done', run), true)
  assert.equal(m.rollupWins('running', run), false)
  assert.equal(m.rollupWins('failure', run), false)
  assert.equal(m.rollupWins('idle', null), false)
  assert.equal(m.rollupWins('idle', m.rollupStatus(['done'])), true) // done(2) > idle(0)
  assert.equal(m.rollupWins('done', m.rollupStatus(['done'])), false)
})

test('rollupSummary', () => {
  const s = (kinds) => m.rollupSummary(m.rollupStatus(kinds))
  assert.equal(s(['failure', 'running', 'running']), 'Aninhados: 1 precisa de atenção · 2 em execução')
  assert.equal(s(['failure', 'failure']), 'Aninhados: 2 precisam de atenção')
  assert.equal(s(['interview', 'approval', 'approval']), 'Aninhados: 1 aguardando resposta · 2 aguardando aprovação')
  assert.equal(s(['done']), 'Aninhados: 1 concluído')
  assert.equal(s(['done', 'done']), 'Aninhados: 2 concluídos')
})

/* ---------- 6. view ---------- */

test('view predicates and labels', () => {
  assert.equal(m.isSortActive(m.DEFAULT_SORT), false)
  assert.equal(m.isSortActive({ field: 'name', direction: 'desc' }), true)
  assert.equal(m.isSortActive({ field: 'updated', direction: 'asc' }), true)
  assert.equal(m.filterCount(view()), 0)
  assert.equal(m.filterCount(view({ harness: 'codex' })), 1)
  assert.equal(m.isViewActive(m.DEFAULT_VIEW), false)
  assert.equal(m.isViewActive(view({ archive: 'all' })), true)
  assert.equal(m.isViewActive(view({ harness: 'claude' })), true)
  assert.equal(m.isViewActive(view({ sort: { field: 'name', direction: 'desc' } })), true)
  assert.equal(m.sortSummary({ field: 'name', direction: 'asc' }), 'Nome ↑')
  assert.equal(m.sortSummary({ field: 'updated', direction: 'desc' }), 'Última atualização ↓')
  assert.equal(m.archiveLabel('archived'), 'Somente arquivados')
  assert.equal(m.archiveLabel('bogus'), 'Somente não arquivados')
  assert.equal(m.harnessLabel('claude'), 'Claude Code')
  assert.equal(m.harnessLabel('bogus'), 'Todos')
})

test('viewTriggerLabel', () => {
  assert.equal(m.viewTriggerLabel(m.DEFAULT_VIEW), 'Filtrar agentes')
  assert.equal(
    m.viewTriggerLabel({ sort: { field: 'name', direction: 'asc' }, archive: 'archived', harness: 'codex' }),
    'Filtrar agentes, 1 filtro ativo, ordenado por Nome crescente, mostrando somente arquivados'
  )
  assert.equal(m.viewTriggerLabel(view({ sort: { field: 'updated', direction: 'asc' } })), 'Filtrar agentes, ordenado por Última atualização crescente')
  assert.equal(m.viewTriggerLabel(view({ archive: 'all' })), 'Filtrar agentes, mostrando todos os chats')
})

test('parseView falls back field by field', () => {
  assert.deepEqual(m.parseView(null), m.DEFAULT_VIEW)
  assert.deepEqual(m.parseView(undefined), m.DEFAULT_VIEW)
  assert.deepEqual(m.parseView('x'), m.DEFAULT_VIEW)
  assert.deepEqual(m.parseView(42), m.DEFAULT_VIEW)
  assert.deepEqual(m.parseView({ sort: 'name', archive: 1, harness: {} }), m.DEFAULT_VIEW)
  const got = m.parseView({ sort: { field: 'name', direction: 'sideways' }, archive: 'all', harness: 'gemini' })
  assert.deepEqual(got, { sort: { field: 'name', direction: 'desc' }, archive: 'all', harness: 'all' })
  const full = { sort: { field: 'name', direction: 'asc' }, archive: 'archived', harness: 'codex' }
  assert.deepEqual(m.parseView(full), full)
})

/* ---------- 7. time ---------- */

test('formatCompactRelativeTime', () => {
  const now = 10 * WEEK
  const f = (ago) => m.formatCompactRelativeTime(now - ago, now)
  assert.equal(f(0), 'agora')
  assert.equal(f(MIN - 1), 'agora')
  assert.equal(f(MIN), '1m')
  assert.equal(f(5 * MIN + 30_000), '5m')
  assert.equal(f(HOUR - 1), '59m')
  assert.equal(f(3 * HOUR), '3h')
  assert.equal(f(DAY - 1), '23h')
  assert.equal(f(2 * DAY), '2d')
  assert.equal(f(WEEK - 1), '6d')
  assert.equal(f(WEEK), '1sem')
  assert.equal(f(2 * WEEK + DAY), '2sem')
  assert.equal(f(4 * WEEK - 1), '3sem')
  const old = f(4 * WEEK)
  assert.match(old, /\d/)
  assert.doesNotMatch(old, /sem$/)
  assert.equal(m.formatCompactRelativeTime(now + HOUR, now), 'agora')
})

test('formatElapsed', () => {
  assert.equal(m.formatElapsed(-5), '<1m')
  assert.equal(m.formatElapsed(0), '<1m')
  assert.equal(m.formatElapsed(59_999), '<1m')
  assert.equal(m.formatElapsed(12 * MIN), '12m')
  assert.equal(m.formatElapsed(59 * MIN), '59m')
  assert.equal(m.formatElapsed(HOUR), '1h')
  assert.equal(m.formatElapsed(HOUR + 5 * MIN), '1h 5m')
  assert.equal(m.formatElapsed(23 * HOUR + 59 * MIN), '23h 59m')
  assert.equal(m.formatElapsed(DAY), '1d')
  assert.equal(m.formatElapsed(2 * DAY + 5 * HOUR), '2d')
})

/* ---------- 8. task tabs ---------- */

test('openTaskList', () => {
  const tasks = [{ id: 'a' }, { id: 'b', pinned: true }, { id: 'c' }, { id: 'd', pinned: true }]
  assert.deepEqual(ids(m.openTaskList(tasks, ['c', 'ghost', 'd', 'a', 'b'])), ['d', 'b', 'c', 'a'])
  assert.deepEqual(m.openTaskList(tasks, []), [])
  assert.deepEqual(ids(m.openTaskList(tasks, ['a', 'c'])), ['a', 'c'])
})

test('taskActivity', () => {
  const chats = [{ id: 'a', taskId: 't1' }, { id: 'b', taskId: 't1' }, { id: 'c', taskId: 't2' }]
  assert.equal(m.taskActivity(chats, {}, 't1'), 'idle')
  assert.equal(m.taskActivity(chats, { a: { busy: false, permission: {} } }, 't1'), 'idle')
  assert.equal(m.taskActivity(chats, { a: { busy: true } }, 't1'), 'running')
  assert.equal(m.taskActivity(chats, { a: { busy: true }, b: { busy: true, question: { q: 1 } } }, 't1'), 'waiting')
  assert.equal(m.taskActivity(chats, { a: { busy: true, permission: true } }, 't1'), 'waiting')
  assert.equal(m.taskActivity(chats, { c: { busy: true, permission: true } }, 't1'), 'idle')
  assert.equal(m.taskActivity(chats, { c: { busy: true } }, 't2'), 'running')
})

/* ---------- 9. monitor ---------- */

const turn = (id, startedAt, extra = {}) => ({ id, role: 'assistant', startedAt, ...extra })
const mchat = (id, turns, extra = {}) => ({ id, title: id, taskId: 't1', turns, ...extra })

test('monitorRows: filters', () => {
  const chats = [
    mchat('a', [turn('a1', 10), turn('a2', 20)]),
    mchat('b', [turn('b1', 30)]),
    mchat('c', [turn('c1', 40), turn('cu', 50, { role: 'user' }), turn('cn', undefined)])
  ]
  const runtime = {
    a: { turnId: 'a2', busy: true },
    b: { turnId: 'b1', busy: true, permission: { x: 1 } },
    c: { turnId: 'c1', busy: false, question: {} }
  }
  const rows = (f, q = '') => m.monitorRows(chats, runtime, [], f, q).map((r) => r.turn.id)
  assert.deepEqual(rows('all'), ['b1', 'a2', 'c1', 'a1']) // busy first, then startedAt desc; user/no-startedAt dropped
  assert.deepEqual(rows('active'), ['b1', 'a2'])
  assert.deepEqual(rows('waiting'), ['b1', 'c1'])
  assert.deepEqual(rows('finished'), ['c1', 'a1'])
  const [first] = m.monitorRows(chats, runtime, [], 'all', '')
  assert.equal(first.run, runtime.b)
  assert.equal(first.chat, chats[1])
  const a1 = m.monitorRows(chats, runtime, [], 'all', '').find((r) => r.turn.id === 'a1')
  assert.equal(a1.run, undefined)
})

test('monitorRows: active/waiting ignore turns that are not the runtime turn', () => {
  const chats = [mchat('a', [turn('old', 1), turn('cur', 2)])]
  assert.deepEqual(m.monitorRows(chats, { a: { turnId: 'cur', busy: true } }, [], 'active', '').map((r) => r.turn.id), ['cur'])
  assert.deepEqual(m.monitorRows(chats, {}, [], 'active', ''), [])
  assert.deepEqual(m.monitorRows(chats, {}, [], 'waiting', ''), [])
})

test('monitorRows: search over title, profile, model and task title', () => {
  const chats = [
    mchat('Órfão', [turn('t1', 1, { profileName: 'Perfil Azul', model: 'opus' })]),
    mchat('beta', [turn('t2', 2, { model: 'sonnet' })], { taskId: 'tk' })
  ]
  const tasks = [{ id: 'tk', title: 'Migração Grande' }]
  const q = (s) => m.monitorRows(chats, {}, tasks, 'all', s).map((r) => r.turn.id)
  assert.deepEqual(q('orfao'), ['t1'])
  assert.deepEqual(q('azul'), ['t1'])
  assert.deepEqual(q('OPUS'), ['t1'])
  assert.deepEqual(q('migracao'), ['t2'])
  assert.deepEqual(q('beta sonnet'), ['t2'])
  assert.deepEqual(q('beta opus'), [])
  assert.deepEqual(q(''), ['t2', 't1'])
})

test('monitorCounts', () => {
  assert.deepEqual(m.monitorCounts({}), { active: 0, waiting: 0 })
  assert.deepEqual(
    m.monitorCounts({
      a: { turnId: '1', busy: true },
      b: { turnId: '2', busy: true, permission: {} },
      c: { turnId: '3', busy: true, question: {} },
      d: { turnId: '4', busy: false, permission: {} },
      e: undefined
    }),
    { active: 3, waiting: 2 }
  )
})

/* ---------- round 2 ---------- */

const set = (x) => [...x].sort()

test('archiveHiddenIds: all hides nothing', () => {
  assert.equal(m.archiveHiddenIds([{ id: 'a', archived: true }], 'all').size, 0)
})

test('archiveHiddenIds: unarchived hides the subtree, pinned path reveals', () => {
  const items = [{ id: 'r' }, { id: 'a', parentChatId: 'r', archived: true }, { id: 'a1', parentChatId: 'a' }, { id: 'a2', parentChatId: 'a' },
    { id: 's', parentChatId: 'r' }, { id: 'x', archived: true }, { id: 'xc', parentChatId: 'x' }]
  assert.deepEqual(set(m.archiveHiddenIds(items, 'unarchived')), ['a', 'a1', 'a2', 'x', 'xc'])
  assert.deepEqual(set(m.archiveHiddenIds(items, 'unarchived', new Set(['a1']))), ['a2', 'x', 'xc'])
  assert.deepEqual(set(m.archiveHiddenIds(items, 'unarchived', new Set(['ghost']))), ['a', 'a1', 'a2', 'x', 'xc'])
  // an archived child of a live parent stays hidden on its own
  const own = [{ id: 'r' }, { id: 'c', parentChatId: 'r', archived: true }, { id: 'cc', parentChatId: 'c' }]
  assert.deepEqual(set(m.archiveHiddenIds(own, 'unarchived')), ['c', 'cc'])
})

test('archiveHiddenIds: archived shows archived rows + ancestors only', () => {
  const items = [{ id: 'r' }, { id: 'a', parentChatId: 'r', archived: true }, { id: 'a1', parentChatId: 'a' }, { id: 's', parentChatId: 'r' }, { id: 'u' }, { id: 'x', archived: true }]
  assert.deepEqual(set(m.archiveHiddenIds(items, 'archived')), ['a1', 's', 'u'])
})

test('archiveHiddenIds: parent cycle does not loop', () => {
  const cyc = [{ id: 'p1', parentChatId: 'p2', archived: true }, { id: 'p2', parentChatId: 'p1' }]
  assert.deepEqual(set(m.archiveHiddenIds(cyc, 'unarchived')), ['p1', 'p2'])
  assert.deepEqual(set(m.archiveHiddenIds(cyc, 'unarchived', new Set(['p2']))), [])
  assert.deepEqual(set(m.archiveHiddenIds(cyc, 'archived')), [])
})

test('visibleChats archived mode + harness: context ancestor needs a matching archived descendant', () => {
  const chats = [
    chat('P'), chat('K', { parentChatId: 'P', archived: true, selection: { provider: 'codex' } }),
    chat('Q'), chat('K2', { parentChatId: 'Q', archived: true })
  ]
  assert.deepEqual(ids(m.visibleChats(chats, 't1', view({ archive: 'archived', harness: 'codex' }))).sort(), ['K', 'P'])
  assert.deepEqual(ids(m.visibleChats(chats, 't1', view({ archive: 'archived', harness: 'claude' }))).sort(), ['K2', 'Q'])
  assert.deepEqual(ids(m.visibleChats(chats, 't1', view({ archive: 'archived' }))).sort(), ['K', 'K2', 'P', 'Q'])
})

test('created sort', () => {
  assert.deepEqual([...m.SORT_FIELDS], ['updated', 'created', 'name'])
  const chats = [chat('a', { updatedAt: 10, createdAt: 100 }), chat('b', { updatedAt: 50, createdAt: 5 }), chat('c', { updatedAt: 70 })]
  const sort = (direction) => ids(m.visibleChats(chats, 't1', view({ sort: { field: 'created', direction } })))
  assert.deepEqual(sort('desc'), ['a', 'c', 'b'])
  assert.deepEqual(sort('asc'), ['b', 'c', 'a'])
  assert.equal(m.sortSummary({ field: 'created', direction: 'desc' }), 'Data de criação ↓')
  assert.equal(m.parseView({ sort: { field: 'created', direction: 'asc' } }).sort.field, 'created')
  assert.equal(m.isSortActive({ field: 'created', direction: 'desc' }), true)
})

test('buildTree isOpen(id, depth)', () => {
  const items = [item('r'), item('c', 'r'), item('g', 'c')]
  const calls = []
  const [root] = m.buildTree(items, { isOpen: (id, depth) => { calls.push([id, depth]); return depth === 0 } })
  assert.equal(root.expanded, true)
  assert.equal(root.children[0].expanded, false)
  assert.equal(root.children[0].hasChildren, true)
  assert.deepEqual(root.children[0].descendants.map((x) => x.id), ['g'])
  assert.deepEqual(calls.sort(), [['c', 1], ['g', 2], ['r', 0]])
  // ignored under a query
  const [q] = m.buildTree(items, { query: 'g', isOpen: () => false })
  assert.ok(m.flattenTree([q]).every((n) => n.expanded))
  assert.equal(m.flattenTree([q]).length, 3)
})

test('taskStatuses', () => {
  const chats = [
    { id: 'a', taskId: 't1' }, { id: 'b', taskId: 't1' },
    { id: 'c', taskId: 't2' }, { id: 'd', taskId: 't2' },
    { id: 'e', taskId: 't3' },
    { id: 'f', taskId: 't4' }, { id: 'g', taskId: 't4' },
    { id: 'h', taskId: 't5' },
    { id: 'i', taskId: 't6' },
    { id: 'orphan' }
  ]
  const runtime = { b: { busy: true }, d: { busy: true, permission: {} }, f: { busy: true, question: {} }, g: { busy: true }, i: { busy: true }, orphan: { busy: true } }
  const unread = { a: 'done', c: 'failure', h: 'done', i: 'failure', orphan: 'failure' }
  assert.deepEqual({ ...m.taskStatuses(chats, runtime, unread) }, { t1: 'running', t2: 'failure', t3: 'idle', t4: 'waiting', t5: 'done', t6: 'running' })
  assert.equal(m.taskStatuses(chats, {}, { c: 'failure', a: 'done' }).t2, 'failure')
  assert.equal(m.taskStatuses(chats, {}, { a: 'done', c: 'failure', b: 'done' }).t1, 'done')
  assert.deepEqual({ ...m.taskStatuses([{ id: 'z', taskId: 'tz' }], {}) }, { tz: 'idle' })
})

test('dropOrder', () => {
  const tasks = [{ id: 'a' }, { id: 'b', pinned: true }, { id: 'c' }, { id: 'd' }]
  const open = ['a', 'b', 'c', 'd']
  assert.deepEqual(m.dropOrder(tasks, open, 'c', 'a', 'before'), ['c', 'a', 'b', 'd'])
  assert.deepEqual(m.dropOrder(tasks, open, 'd', 'c', 'before'), ['a', 'b', 'd', 'c'])
  assert.deepEqual(m.dropOrder(tasks, open, 'a', 'd', 'after'), ['b', 'c', 'd', 'a'])
  assert.equal(m.dropOrder(tasks, open, 'a', 'b', 'before'), null) // unpinned before pinned: strip unchanged
  assert.equal(m.dropOrder(tasks, open, 'c', 'b', 'after'), null) // own position
  assert.equal(m.dropOrder(tasks, open, 'c', 'd', 'before'), null)
  assert.equal(m.dropOrder(tasks, open, 'c', 'c', 'before'), null)
  assert.equal(m.dropOrder(tasks, open, 'ghost', 'a', 'before'), null)
  assert.equal(m.dropOrder(tasks, open, 'a', 'ghost', 'after'), null)
})

test('runStates', () => {
  assert.deepEqual({ ...m.runStates({
    a: { busy: true }, b: { busy: true, permission: {} }, c: { busy: true, permission: {}, question: {} },
    d: { busy: false, question: {} }, e: undefined
  }) }, { a: 'running', b: 'approval', c: 'interview' })
})

test('chatRows keeps row identity while only turns change', () => {
  const { chatRows } = load('src/renderer/src/components/agents-list/selectors.ts')
  const base = { id: 'c', title: 'T', updatedAt: 1, createdAt: 1, archived: false, parentChatId: 'p', taskId: 't', cwd: '/x', selection: { provider: 'claude' }, turns: [] }
  const [r1] = chatRows([base])
  assert.equal(r1.id, 'c')
  assert.equal('turns' in r1, false)
  const streamed = { ...base, turns: [{ id: 't1', text: 'hel' }], selection: { provider: 'claude' } }
  assert.equal(chatRows([streamed])[0], r1)
  assert.equal(chatRows([{ ...streamed, turns: [...streamed.turns, { id: 't2' }] }])[0], r1)
  for (const patch of [{ title: 'U' }, { archived: true }, { parentChatId: 'q' }, { updatedAt: 2 }, { taskId: 'u' }, { cwd: '/y' }, { selection: { provider: 'codex' } }, { sourceHarness: 'codex' }, { readOnly: true }, { remoteId: 'r' }, { createdAt: 9 }, { nativeAgent: { status: 'running' } }]) {
    const [next] = chatRows([{ ...base, ...patch }])
    assert.notEqual(next, r1, JSON.stringify(patch))
    assert.equal(chatRows([{ ...base, ...patch }])[0], next)
    chatRows([base]) // reset the cache entry for the next patch
  }
})

test('native subagent rows update their status without reacting to streamed prose', () => {
  const { chatRows } = load('src/renderer/src/components/agents-list/selectors.ts')
  const base = { id: 'native', title: 'Auditar API', parentChatId: 'parent', updatedAt: 1, cwd: '/x', selection: { provider: 'codex' }, nativeAgent: { status: 'running' }, turns: [] }
  const [running] = chatRows([base])
  assert.equal(running.nativeAgent, true)
  assert.equal(running.nativeStatus, 'running')
  assert.equal(chatRows([{ ...base, turns: [{ text: 'delta' }] }])[0], running)
  const [finished] = chatRows([{ ...base, nativeAgent: { status: 'completed' } }])
  assert.notEqual(finished, running)
  assert.equal(finished.nativeStatus, 'completed')
})

test('tree expansion store and branchOpen', () => {
  const { create } = require('zustand')
  const x = load('src/renderer/src/components/agents-list/expansion.ts', { zustand: { create } })
  const P = { expanded: new Set(), collapsed: new Set() }
  assert.equal(x.branchOpen(P, 'a', 0), true)
  assert.equal(x.branchOpen(P, 'a', 1), false)
  assert.equal(x.branchOpen({ expanded: new Set(['a']), collapsed: new Set() }, 'a', 2), true)
  assert.equal(x.branchOpen({ expanded: new Set(), collapsed: new Set(['a']) }, 'a', 0), false)
  assert.equal(x.branchOpen({ expanded: new Set(['a']), collapsed: new Set(['a']) }, 'a', 1), false) // collapse wins
  const store = x.useTreeExpansion
  assert.deepEqual(store.getState().panels, {})
  assert.equal(x.panelExpansion(store.getState().panels, 'p').expanded.size, 0)
  store.getState().setOpen('p', 'n', true)
  assert.equal(x.branchOpen(x.panelExpansion(store.getState().panels, 'p'), 'n', 1), true)
  store.getState().setOpen('p', 'n', false)
  assert.equal(x.branchOpen(x.panelExpansion(store.getState().panels, 'p'), 'n', 0), false)
  assert.equal(x.panelExpansion(store.getState().panels, 'q').collapsed.size, 0) // per panel
  store.getState().reveal('p', ['n', 'm'])
  const revealed = store.getState()
  assert.equal(x.branchOpen(x.panelExpansion(revealed.panels, 'p'), 'n', 1), true)
  assert.equal(x.branchOpen(x.panelExpansion(revealed.panels, 'p'), 'm', 1), true)
  store.getState().reveal('p', ['n', 'm'])
  assert.equal(store.getState(), revealed) // no-op keeps the same state reference
  store.getState().setOpen('q', 'z', true)
  store.getState().collapseAll('p', new Set(['n', 'k']))
  const p = x.panelExpansion(store.getState().panels, 'p')
  assert.equal(p.expanded.size, 0)
  assert.deepEqual(set(p.collapsed), ['k', 'n'])
  assert.equal(x.branchOpen(p, 'n', 0), false)
  assert.equal(x.panelExpansion(store.getState().panels, 'q').expanded.has('z'), true)
})

/* ---------- round 3: per-task view ---------- */

test('parseViews', () => {
  assert.deepEqual(m.parseViews(null), {})
  assert.deepEqual(m.parseViews(undefined), {})
  assert.deepEqual(m.parseViews([]), {})
  assert.deepEqual(m.parseViews([{ sort: { field: 'name' } }]), {})
  assert.deepEqual(m.parseViews('x'), {})
  assert.deepEqual(m.parseViews(7), {})
  const got = m.parseViews({
    '': { archive: 'all' },
    bad: 'str', nul: null, num: 3,
    t1: { sort: { field: 'name', direction: 'asc' }, archive: 'all', harness: 'codex' },
    t2: { sort: { field: 'zzz', direction: 'up' }, archive: 'nope', harness: 'gemini' }
  })
  assert.deepEqual(Object.keys(got).sort(), ['t1', 't2'])
  assert.deepEqual(got.t1, { sort: { field: 'name', direction: 'asc' }, archive: 'all', harness: 'codex' })
  assert.deepEqual(got.t2, m.DEFAULT_VIEW)
})

test('viewFor', () => {
  const custom = view({ archive: 'all' })
  const views = { t1: custom }
  assert.equal(m.viewFor(views, 't1'), custom)
  assert.equal(m.viewFor(views, 't2'), m.DEFAULT_VIEW)
  assert.equal(m.viewFor(views, null), m.DEFAULT_VIEW)
  assert.equal(m.viewFor(views, undefined), m.DEFAULT_VIEW)
  assert.equal(m.viewFor(views, ''), m.DEFAULT_VIEW)
  const fb = view({ harness: 'codex' })
  assert.equal(m.viewFor(views, 't2', fb), fb)
  assert.equal(m.viewFor(views, '', fb), fb)
  assert.equal(m.viewFor(views, 't1', fb), custom)
})

test('withView', () => {
  const custom = view({ archive: 'all' })
  const input = Object.freeze({ a: view({ harness: 'claude' }) })
  const next = m.withView(input, 'b', custom)
  assert.deepEqual(Object.keys(next).sort(), ['a', 'b'])
  assert.equal(next.b, custom)
  assert.deepEqual(Object.keys(input), ['a']) // not mutated
  assert.notEqual(next, input)
  // resetting to the default drops the entry
  const dropped = m.withView(next, 'b', { ...m.DEFAULT_VIEW, sort: { ...m.DEFAULT_SORT } })
  assert.deepEqual(Object.keys(dropped), ['a'])
  assert.deepEqual(Object.keys(next).sort(), ['a', 'b'])
  // default on an unknown task is a no-op copy
  assert.deepEqual(m.withView(input, 'zzz', m.DEFAULT_VIEW), { a: input.a })
  // overwrite
  assert.equal(m.withView(next, 'b', view({ harness: 'codex' })).b.harness, 'codex')
})


test('monitor live filters skip inactive history and inspect the tail of an active history', () => {
  let reads = 0
  const history = new Proxy(Array.from({length:22187}, (_,i) => ({id:`turn-${i}`,role:'assistant',startedAt:i+1})), {
    get(target, key) { if (/^\d+$/.test(String(key))) reads++; return Reflect.get(target,key) }
  })
  const chats = [chat('big', {turns:history})]
  assert.equal(m.monitorRows(chats, {}, [], 'active', '').length, 0)
  assert.equal(reads, 0)
  const rows = m.monitorRows(chats, {big:{turnId:'turn-22186',busy:true}}, [], 'active', '')
  assert.equal(rows[0].turn.id,'turn-22186')
  assert.ok(reads <= 2, `read ${reads} history turns`)
})
