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
    hook.setState = set
    return hook
  } }
}

const claudeSel = (over = {}) => ({ provider: 'claude', profileId: 'ambient-claude', model: 'opus', effort: 'high', permissionMode: 'default', serviceTier: '', ...over })
const mkChat = (id, over = {}) => ({ id, title: 't', createdAt: 1, updatedAt: 1, turns: [], selection: claudeSel(), cwd: 'C:\\w', ...over })
const fastModel = (id = 'opus') => ({ id, efforts: [], fast: { id: 'fast' } })

function env({ memory, activeTask } = {}) {
  const calls = { claude: [], codex: [], toasts: [], deleted: [] }
  global.localStorage = { getItem: (k) => memory && k === 'prism.picker.memory.v2' ? JSON.stringify(memory) : null, setItem() {} }
  global.window = { prism: {
    chats: { save: async () => true, delete: async (id) => { calls.deleted.push(id); return true }, list: async () => [], flush: () => ({ ok: true }) },
    providers: { list: async () => [] },
    claude: { agentSend: (p) => calls.claude.push(p) },
    codex: { send: (p) => calls.codex.push(p) }
  } }
  const zustand = fakeZustand()
  const useStore = zustand.create(() => ({
    settings: { model: 'sonnet', notifyOnDone: false }, remote: undefined, chatOpen: true,
    addToast: (kind, msg) => calls.toasts.push(msg), bumpTree() {}, reloadOpenFiles: async () => {}
  }))
  const useAgentTasks = { getState: () => ({ activeId: activeTask, activate() {} }), setState() {} }
  const catalog = load('src/renderer/src/lib/modelCatalog.ts', { zustand })
  const agents = load('src/shared/agents.ts')
  const usage = load('src/shared/providerUsage.ts')
  const mod = load('src/renderer/src/lib/agentChats.ts', {
    '../../../shared/subagents': load('src/shared/subagents.ts'),
    './asyncQuestions': load('src/renderer/src/lib/asyncQuestions.ts'),
    '../../../shared/imageReferences': load('src/shared/imageReferences.ts'),
    zustand, '../../../shared/agents': agents, '../../../shared/providerUsage': usage,
    '../../../shared/chatDeltas': load('src/shared/chatDeltas.ts'), './notify': { notifyTaskDone() {} },
    '../store': { useStore }, './agentTasks': { useAgentTasks }, './modelCatalog': catalog
  })
  const chats = mod.useAgentChats
  return { chats, S: () => chats.getState(), useStore, catalog, calls, restore: () => { /* debounced saves fire after the test; keep the fake window alive */ } }
}
const seed = (e, list, extra = {}) => e.chats.setState({ chats: list, ...extra })
const withEnv = (opts, body) => async () => { const e = env(opts); try { await body(e) } finally { e.restore() } }
const setCatalog = (e, models, provider = 'claude', profile = 'ambient-claude') =>
  e.catalog.useModelCatalog.setState({ entries: { [e.catalog.catalogKey(provider, profile)]: { models, loading: false } } })

test('send returns true only when accepted and never touches drafts', withEnv({}, (e) => {
  seed(e, [mkChat('a', { draft: 'D', contextDraft: 'C' })])
  assert.equal(e.S().send('a', 'oi'), true)
  const c = e.S().chats[0]
  assert.equal(c.draft, 'D'); assert.equal(c.contextDraft, 'C')
  assert.equal(e.calls.claude.length, 1)
  // busy now
  assert.equal(e.S().send('a', 'de novo'), false)
  assert.equal(e.calls.claude.length, 1)
  assert.equal(e.S().chats[0].draft, 'D')
  assert.equal(e.S().send('missing', 'x'), false)
  assert.equal(e.S().send('a', '   '), false)
}))

test('send refuses unbound/unconfirmed imports', withEnv({}, (e) => {
  seed(e, [mkChat('w', { workspaceNeedsBinding: true, draft: 'k' }), mkChat('acc', { accountNeedsSelection: true })])
  assert.equal(e.S().send('w', 'x'), false)
  assert.equal(e.S().send('acc', 'x'), false)
  assert.equal(e.calls.claude.length, 0)
  assert.equal(e.S().chats[0].draft, 'k')
  assert.equal(e.S().runtime.w, undefined)
}))

test('send over SSH requires the terminal Claude route and the same target', withEnv({}, (e) => {
  const target = { host: 'srv', port: 22, username: 'u' }
  e.useStore.setState({ remote: { id: 'r', ...target } })
  seed(e, [
    mkChat('wrong', { remoteId: 'r', remoteTarget: target, selection: claudeSel({ profileId: 'claude-work' }) }),
    mkChat('codex', { remoteId: 'r', remoteTarget: target, selection: claudeSel({ provider: 'codex', profileId: 'ambient-codex' }) }),
    mkChat('other', { remoteId: 'r', remoteTarget: { ...target, host: 'outro' } }),
    mkChat('ok', { remoteId: 'r', remoteTarget: { ...target, host: 'SRV' } })
  ])
  assert.equal(e.S().send('wrong', 'x'), false)
  assert.equal(e.S().send('codex', 'x'), false)
  assert.equal(e.S().send('other', 'x'), false)
  assert.equal(e.calls.claude.length, 0)
  assert.equal(e.S().send('ok', 'x'), true)
  assert.equal(e.calls.claude[0].remote, 'r')
}))

test('send: Fast only goes out when the catalog model offers that tier', withEnv({}, (e) => {
  seed(e, [mkChat('a', { selection: claudeSel({ serviceTier: 'fast' }) }), mkChat('b', { selection: claudeSel({ serviceTier: 'fast', model: 'haiku' }) })])
  // no catalog loaded: raw preference
  e.S().send('a', 'x')
  assert.equal(e.calls.claude[0].serviceTier, 'fast')
  e.chats.setState({ runtime: {} })
  setCatalog(e, [fastModel('opus'), { id: 'haiku', efforts: [] }])
  e.S().send('a', 'x')
  assert.equal(e.calls.claude[1].serviceTier, 'fast')
  e.S().send('b', 'x')
  assert.equal(e.calls.claude[2].serviceTier, undefined)
  // empty catalog counts as not loaded
  e.chats.setState({ runtime: {} })
  setCatalog(e, [])
  e.S().send('b', 'x')
  assert.equal(e.calls.claude[3].serviceTier, 'fast')
}))

test('send on Codex carries the effective tier or an empty string', withEnv({}, (e) => {
  const sel = (model, serviceTier) => claudeSel({ provider: 'codex', profileId: 'ambient-codex', model, serviceTier })
  seed(e, [mkChat('x', { selection: sel('gpt', 'fast') }), mkChat('y', { selection: sel('mini', 'fast') }), mkChat('z', { selection: sel('gpt', '') })])
  setCatalog(e, [fastModel('gpt'), { id: 'mini', efforts: [] }], 'codex', 'ambient-codex')
  e.S().send('x', 'a'); e.S().send('y', 'a'); e.S().send('z', 'a')
  assert.deepEqual(e.calls.codex.map((c) => c.selection.serviceTier), ['fast', '', ''])
}))

test('remove of the active chat picks the latest unarchived chat of the same task', withEnv({}, async (e) => {
  seed(e, [
    mkChat('gone', { taskId: 'T1', updatedAt: 5 }),
    mkChat('old', { taskId: 'T1', updatedAt: 2 }),
    mkChat('new', { taskId: 'T1', updatedAt: 4 }),
    mkChat('arch', { taskId: 'T1', updatedAt: 9, archived: true }),
    mkChat('other', { taskId: 'T2', updatedAt: 99 })
  ], { activeId: 'gone' })
  await e.S().remove('gone')
  assert.equal(e.S().activeId, 'new')
  await e.S().remove('new')
  assert.equal(e.S().activeId, 'old')
  await e.S().remove('old')
  assert.equal(e.S().activeId, null, 'archived and other-task chats are never picked')
  assert.deepEqual(e.calls.deleted, ['gone', 'new', 'old'])
}))

test('remove of a non-active chat keeps activeId; busy chats cannot be removed', withEnv({}, async (e) => {
  seed(e, [mkChat('a', { taskId: 'T' }), mkChat('b', { taskId: 'T' })], { activeId: 'a', runtime: { b: { busy: true, turnId: 't', route: 'r' } } })
  await assert.rejects(e.S().remove('b'))
  e.chats.setState({ runtime: {} })
  await e.S().remove('b')
  assert.equal(e.S().activeId, 'a')
}))

test('archive is refused while busy; unarchive is allowed', withEnv({}, (e) => {
  seed(e, [mkChat('a'), mkChat('b', { archived: true })], { runtime: { a: { busy: true, turnId: 't', route: 'r' }, b: { busy: true, turnId: 't2', route: 'r' } } })
  e.S().archive('a', true)
  assert.equal(e.S().chats[0].archived, undefined)
  e.S().archive('b', false)
  assert.equal(e.S().chats[1].archived, undefined)
  e.chats.setState({ runtime: {} })
  e.S().archive('a', true)
  assert.equal(e.S().chats[0].archived, true)
}))

test('create: a child inherits cwd, route, selection and task from its parent', withEnv({ activeTask: 'ACTIVE' }, (e) => {
  const target = { host: 'h', port: 22, username: 'u' }
  const parentSel = claudeSel({ model: 'sonnet', effort: 'low', serviceTier: 'fast' })
  seed(e, [mkChat('p', { cwd: 'C:\\parent', remoteId: 'r', remoteTarget: target, taskId: 'PT', selection: parentSel })])
  e.S().create('C:\\ignored', undefined, { parentChatId: 'p' })
  const child = e.S().chats.find((c) => c.id !== 'p')
  assert.equal(child.cwd, 'C:\\parent'); assert.equal(child.remoteId, 'r'); assert.deepEqual(child.remoteTarget, target)
  assert.deepEqual(child.selection, parentSel); assert.notEqual(child.selection, parentSel)
  assert.equal(child.taskId, 'PT'); assert.equal(child.parentChatId, 'p')
  assert.equal(e.S().activeId, child.id)
}))

test('create: a new chat starts from the picker memory and the active task', withEnv({
  activeTask: 'ACTIVE',
  memory: { last: { provider: 'codex', profileId: 'ambient-codex', model: 'gpt', effort: 'medium', serviceTier: 'fast', permissionMode: 'plan' } }
}, (e) => {
  e.S().create('C:\\proj')
  const c = e.S().chats[0]
  assert.equal(c.cwd, 'C:\\proj'); assert.equal(c.taskId, 'ACTIVE'); assert.equal(c.parentChatId, undefined)
  assert.deepEqual({ ...c.selection }, { provider: 'codex', profileId: 'ambient-codex', model: 'gpt', effort: 'medium', serviceTier: 'fast', permissionMode: 'plan' })
}))

test('create: a remembered profile that is gone, tombstoned or disabled falls back to ambient', withEnv({
  memory: { last: { provider: 'claude', profileId: 'claude-work', model: 'opus', effort: 'high', serviceTier: '', permissionMode: 'default' } }
}, (e) => {
  const prof = (over) => ({ id: 'claude-work', provider: 'claude', ...over })
  const cases = [
    [[{ id: 'ambient-claude', provider: 'claude' }], 'ambient-claude'], // removed
    [[prof({ tombstoned: true }), { id: 'ambient-claude', provider: 'claude' }], 'ambient-claude'],
    [[prof({ enabled: false }), { id: 'ambient-claude', provider: 'claude' }], 'ambient-claude'],
    [[prof({})], 'claude-work'],
    [[], 'claude-work'] // profiles not loaded yet: trust memory
  ]
  for (const [profiles, expected] of cases) {
    seed(e, [], { profiles })
    e.S().create('C:\\p')
    assert.equal(e.S().chats.at(-1).selection.profileId, expected, JSON.stringify(profiles))
  }
}))

test('create over SSH forces Claude and the terminal account', withEnv({
  memory: { last: { provider: 'codex', profileId: 'ambient-codex', model: 'gpt', effort: 'high', serviceTier: 'fast', permissionMode: 'default' } }
}, (e) => {
  const target = { host: 'h', port: 22, username: 'u' }
  e.useStore.setState({ remote: { id: 'r', ...target } })
  e.S().create('/srv', 'r')
  const c = e.S().chats[0]
  assert.equal(c.selection.provider, 'claude'); assert.equal(c.selection.profileId, 'ambient-claude')
  assert.equal(c.selection.model, 'sonnet'); assert.equal(c.selection.serviceTier, '')
  assert.equal(c.remoteId, 'r'); assert.deepEqual(c.remoteTarget, target)
}))

test('configure clears runtime fast when route, model or tier change', withEnv({}, (e) => {
  const fast = { state: 'on' }
  const run = () => ({ a: { busy: false, turnId: 't', route: 'r', fast } })
  const base = claudeSel({ serviceTier: 'fast' })
  const cases = [
    [claudeSel({ serviceTier: 'fast', profileId: 'claude-work' }), true],
    [claudeSel({ serviceTier: 'fast', model: 'sonnet' }), true],
    [claudeSel({ serviceTier: '' }), true],
    [claudeSel({ serviceTier: 'fast', effort: 'low' }), false]
  ]
  for (const [next, cleared] of cases) {
    seed(e, [mkChat('a', { selection: base })], { runtime: run() })
    e.S().configure('a', next)
    assert.equal(e.S().runtime.a.fast, cleared ? undefined : fast, JSON.stringify(next))
  }
  // Busy chats keep running while choices for the next message change.
  seed(e, [mkChat('a', { selection: base })], { runtime: { a: { busy: true, turnId: 't', route: 'r', fast } } })
  e.S().configure('a', claudeSel())
  assert.equal(e.S().runtime.a.fast, undefined); assert.deepEqual(e.S().chats[0].selection, claudeSel()); assert.equal(e.S().runtime.a.busy, true)
}))

test('the next send keeps the previous fast report', withEnv({}, (e) => {
  const fast = { state: 'cooldown', reason: 'rate_limit' }
  seed(e, [mkChat('a')], { runtime: { a: { busy: false, turnId: 'old', route: 'r', fast } } })
  assert.equal(e.S().send('a', 'x'), true)
  assert.equal(e.S().runtime.a.busy, true)
  assert.deepEqual(e.S().runtime.a.fast, fast)
}))

test('queue preserves FIFO, context and images; sends one message per idle turn', withEnv({}, (e) => {
  seed(e, [mkChat('a')], { runtime: { a: { busy: true } } })
  const image = { mime: 'image/png', data: 'aGVsbG8=', name: 'screen.png' }
  e.S().enqueue('a', { text: 'first', context: 'file.ts', images: [image] })
  e.S().enqueue('a', { text: 'second' })
  e.S().flushQueue('a')
  assert.equal(e.calls.claude.length, 0)
  e.chats.setState({ runtime: {} })
  e.S().flushQueue('a')
  assert.equal(e.calls.claude.length, 1)
  assert.deepEqual(e.calls.claude[0].images, [{ ...image, number: 1 }])
  assert.match(e.calls.claude[0].prompt, /file.ts/)
  assert.equal(e.S().chats[0].queued[0].text, 'second')
  e.S().flushQueue('a')
  assert.equal(e.calls.claude.length, 1)
  assert.deepEqual(e.S().chats[0].turns[0].images, [{ ...image, number: 1 }])
}))

test('image-only sends create a visible user turn; refused queue entries stay queued', withEnv({}, (e) => {
  seed(e, [mkChat('a'), mkChat('blocked', { workspaceNeedsBinding: true })])
  const images = [{ mime: 'image/jpeg', data: 'aGVsbG8=' }]
  assert.equal(e.S().send('a', '', undefined, images), true)
  assert.equal(e.S().chats[0].title, 'Imagem')
  assert.deepEqual(e.S().chats[0].turns[0].images, images.map((image, index) => ({ ...image, number: index + 1 })))
  e.S().enqueue('blocked', { text: 'keep me', images })
  e.S().flushQueue('blocked')
  assert.equal(e.S().chats[1].queued.length, 1)
}))



test('paused or edited queue entries do not auto-send; reorder and resume preserve context and images', withEnv({}, e => {
  const first = { text: 'first', context: 'file', images: [{ mime: 'image/png', data: 'x' }] }, second = { text: 'second' }
  seed(e, [mkChat('c')]); e.S().enqueue('c', first); e.S().enqueue('c', second)
  e.S().pauseQueue('c', true); e.S().flushQueue('c'); assert.equal(e.calls.claude.length, 0)
  const stableFirst = { ...first, images: first.images.map(image => ({ ...image, number: 1 })) }
  e.S().reorderQueued('c', 1, 0); assert.deepEqual(e.S().chats[0].queued, [second, stableFirst])
  e.S().setEditingQueued('c', second); e.S().pauseQueue('c', false); assert.equal(e.calls.claude.length, 0)
  const revised = { ...second, text: 'revised' }; e.S().replaceQueued('c', second, revised); e.S().setEditingQueued('c')
  e.S().flushQueue('c'); assert.equal(e.calls.claude[0].prompt, 'revised'); assert.deepEqual(e.S().chats[0].queued, [stableFirst])
}))


for (const provider of ['claude', 'codex']) test(`${provider}: a later prompt resends numbered images without duplicating history`, withEnv({}, e => {
  const first = { mime: 'image/png', data: 'Zmlyc3Q=', name: 'first.png' }
  const second = { mime: 'image/jpeg', data: 'c2Vjb25k', name: 'second.jpg' }
  seed(e, [mkChat('a', { selection: claudeSel({ provider, profileId: `ambient-${provider}` }) })])
  assert.equal(e.S().send('a', 'duas imagens', undefined, [first, second]), true)
  e.chats.setState({ runtime: {} })
  assert.equal(e.S().send('a', 'Compare #image 2 com #image 1 e #image 2'), true)
  const call = e.calls[provider][1]
  assert.deepEqual(call.images.map(i => [i.number, i.data]), [[2, second.data], [1, first.data]])
  assert.match(call.prompt, /Anexo 1 = #image 2\nAnexo 2 = #image 1/)
  const users = e.S().chats[0].turns.filter(t => t.role === 'user')
  assert.equal(users[1].text, 'Compare #image 2 com #image 1 e #image 2')
  assert.equal(users[1].images, undefined)
  // Simulate reloading the persisted chat, then reuse the same stable number.
  const reopened = JSON.parse(JSON.stringify(e.S().chats[0]))
  e.chats.setState({ chats: [reopened], runtime: {} })
  assert.equal(e.S().send('a', 'Observe #image 1'), true)
  assert.equal(e.calls[provider][2].images[0].data, first.data)
  assert.equal(e.calls[provider][2].images[0].number, 1)
}))

test('invalid image reference preserves draft, attachments and idle state', withEnv({}, e => {
  seed(e, [mkChat('a', { draft: 'Observe #image 99' })])
  e.S().attachImages('a', [{ mime: 'image/png', data: 'eA==' }])
  const images = e.S().attachments.a
  assert.equal(e.S().send('a', 'Observe #image 99', undefined, images), false)
  assert.equal(e.S().runtime.a, undefined)
  assert.equal(e.S().chats[0].draft, 'Observe #image 99')
  assert.equal(e.S().attachments.a, images)
  assert.equal(e.calls.claude.length, 0)
  assert.match(e.calls.toasts.at(-1), /99.*n?o foi encontrada/)
}))

test('attachment numbering continues from history and queue and survives queue edits', withEnv({}, e => {
  const one = { mime: 'image/png', data: 'MQ==', number: 1 }
  const two = { mime: 'image/png', data: 'Mg==', number: 2 }
  seed(e, [mkChat('a', { turns: [{ id: 'u', role: 'user', text: '', images: [one] }], queued: [{ text: '', images: [two] }] })])
  e.S().attachImages('a', [{ mime: 'image/png', data: 'Mw==' }])
  assert.equal(e.S().attachments.a[0].number, 3)
  e.S().clearAttachments('a'); e.S().attachImages('a', [two])
  assert.equal(e.S().attachments.a[0].number, 2)
}))

test('cleared uploads keep their numbers reserved while a queue delta is in flight', withEnv({}, e => {
  seed(e, [mkChat('a')])
  e.S().attachImages('a', [{ mime: 'image/png', data: 'Zmlyc3Q=' }])
  const inFlight = e.S().attachments.a[0]
  assert.equal(inFlight.number, 1)
  // The composer clears after queue RPC submission, before the host sends its delta.
  e.S().clearAttachments('a')
  assert.equal(e.S().chats[0].queued, undefined)
  e.S().attachImages('a', [{ mime: 'image/png', data: 'c2Vjb25k' }])
  assert.equal(e.S().attachments.a[0].number, 2)
  // A refusal can restore the first numbered draft without changing its references.
  e.S().clearAttachments('a')
  e.S().attachImages('a', [inFlight])
  assert.equal(e.S().attachments.a[0].number, 1)
  e.S().removeImage('a', 0)
  e.S().attachImages('a', [{ mime: 'image/png', data: 'dGhpcmQ=' }])
  assert.equal(e.S().attachments.a[0].number, 3)
}))

test('legacy queue image labels survive reordering, removal, replacement and sending', withEnv({}, e => {
  const first = { text: 'first', images: [{ mime: 'image/png', data: 'Zmlyc3Q=' }] }
  const second = { text: 'second', images: [{ mime: 'image/png', data: 'c2Vjb25k' }] }
  seed(e, [mkChat('a', { queued: [first, second] })])
  e.S().reorderQueued('a', 1, 0)
  assert.deepEqual(e.S().chats[0].queued.map(row => row.images[0].number), [2, 1])
  e.S().dequeue('a', 1)
  const retained = e.S().chats[0].queued[0]
  assert.equal(retained.images[0].number, 2)
  e.S().replaceQueued('a', retained, { text: 'Compare #image 2', images: second.images })
  assert.equal(e.S().chats[0].queued[0].images[0].number, 2)
  e.S().flushQueue('a')
  assert.equal(e.calls.claude[0].images[0].number, 2)
  assert.equal(e.calls.claude[0].images[0].data, second.images[0].data)
  assert.equal(e.S().chats[0].turns[0].images[0].number, 2)
}))

test('queue image references resend bytes on automatic and immediate send without adding new images', withEnv({}, async e => {
  const image = { mime: 'image/png', data: 'aW1hZ2U=', number: 1 }
  seed(e, [mkChat('a', { turns: [{ id: 'u', role: 'user', text: '', images: [image] }] })])
  e.S().enqueue('a', { text: 'Compare #image 1' })
  e.S().flushQueue('a')
  assert.equal(e.calls.claude[0].images[0].data, image.data)
  const turnId = e.S().runtime.a.turnId
  const steers = []
  window.prism.claude.agentSteer = async p => { steers.push(p) }
  e.S().enqueue('a', { text: 'Confira #image 1 de novo' })
  assert.equal(await e.S().steerQueued('a', 0), true)
  assert.equal(steers[0].turnId, turnId)
  assert.equal(steers[0].images[0].data, image.data)
  assert.match(steers[0].text, /Anexo 1 = #image 1/)
  const user = e.S().chats[0].turns.find(t => t.id === turnId).segments.at(-1)
  assert.equal(user.text, 'Confira #image 1 de novo')
  assert.equal(user.images, undefined)
  e.S().enqueue('a', { text: 'Confira #image 99' })
  assert.equal(await e.S().steerQueued('a', 0), false)
  assert.equal(e.S().chats[0].queued[0].text, 'Confira #image 99')
}))
