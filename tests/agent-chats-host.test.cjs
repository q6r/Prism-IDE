// agentChats.ts in host mode (T07): the host owns the chats; this window follows its snapshot and deltas.
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

const tick = () => new Promise((r) => setImmediate(r))
const claudeSel = (over = {}) => ({ provider: 'claude', profileId: 'ambient-claude', model: 'opus', effort: 'high', permissionMode: 'default', serviceTier: '', ...over })
const codexSel = (over = {}) => claudeSel({ provider: 'codex', profileId: 'ambient-codex', model: 'gpt', ...over })
const mkChat = (id, over = {}) => ({ id, title: `title-${id}`, createdAt: 1, updatedAt: 1, turns: [], selection: claudeSel(), cwd: 'C:\\w', ...over })
const ROUTE = 'claude:ambient-claude'
const idle = (turnId = 't0', over = {}) => ({ turnId, route: ROUTE, busy: false, ...over })
const busy = (turnId = 't1', over = {}) => ({ turnId, route: ROUTE, busy: true, ...over })
const snapshot = (chats, runtime = {}, rev = 1) => ({ rev, chats, runtime })
const fastModel = (id = 'opus') => ({ id, efforts: [], fast: { id: 'fast' } })
const CAPS = ['chats@1', 'claude@1', 'codex@1']
const SILENT = 'O host do Prism não respondeu. Tentando de novo…'
const { latestStructuredQuestions, buildStructuredQuestionsReply } = load('src/renderer/src/lib/asyncQuestions.ts')
const asyncQuestionChat = (over = {}) => mkChat('c', { selection: codexSel(), draft: 'Rascunho preservado', contextDraft: 'file.ts',
  resume: { route: 'codex:ambient-codex', sessionId: 'session-q' },
  turns: [{ id: 't-q', role: 'assistant', text: '', provider: 'codex', segments: [{ kind: 'text', toolId: 'ask-1', text: 'Qual cor?',
    questions: [{ title: 'Qual cor?', options: ['Azul', 'Verde'] }, { title: 'Nota?', options: null }] }] }], ...over })
const asyncAnswers = { 'Qual cor?': 'Azul', 'Nota?': 'Mais testes' }

const CLAUDE_EVENTS = ['onAgentSystem', 'onAgentText', 'onAgentThinking', 'onAgentTool', 'onAgentToolResult', 'onAgentSubagent',
  'onAgentPermission', 'onAgentQuestion', 'onAgentResult', 'onAgentDone', 'onAgentError']

/** A fresh module + fake window per test (the module keeps `initialization`, `drafts`, `hostCaps`). */
function env(options = {}) {
  const o = { owned: true, connected: true, caps: CAPS, reply: {}, localChats: [], notifyOnDone: true, notifyOnAsk: true, focus: false,
    profiles: [{ id: 'ambient-claude', provider: 'claude', name: 'Claude' }, { id: 'ambient-codex', provider: 'codex', name: 'Codex' }], ...options }
  const calls = { host: [], toasts: [], notify: [], taskNotify: [], bump: 0, reload: 0, claude: [], codex: [], abort: [], flush: [], list: 0, save: [], follow: 0 }
  const storage = new Map()
  if (o.storage) storage.set('prism.chatDrafts', JSON.stringify(o.storage))
  global.localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) }
  const state = { focus: o.focus, current: o.connected ? { state: 'connected', hello: { capabilities: o.caps } } : null, flushReply: { ok: true } }
  const statusListeners = new Set()
  const emitStatus = (s) => { state.current = s; for (const l of [...statusListeners]) l(s) }
  const follow = {}
  const windowEvents = {}
  const claudeCbs = {}
  const codexCbs = []
  const cmd = (name) => (...args) => {
    calls.host.push([name, ...args])
    const fn = o.reply[name]
    return Promise.resolve(fn ? fn(...args) : name === 'send' ? { ok: true, turnId: 'T-host' } : { ok: true })
  }
  const hostApi = Object.fromEntries(['create', 'put', 'configure', 'confirmAccount', 'bindWorkspace', 'rename', 'archive', 'setTask', 'remove', 'send', 'stop', 'steer', 'queue', 'respondPermission', 'respondQuestion']
    .map((n) => [n, cmd(n)]))
  hostApi.follow = (onSnapshot, onDeltas) => { calls.follow++; follow.snap = onSnapshot; follow.deltas = onDeltas; return () => {} }
  hostApi.list = async () => snapshot([], {})
  const chatsApi = { save: async (c) => { calls.save.push(c); return true }, delete: async () => true,
    list: async () => { calls.list++; return o.localChats }, flush: (c) => { calls.flush.push(c); return state.flushReply }, host: hostApi }
  if (o.owned !== undefined) chatsApi.hostOwned = async () => o.owned
  global.window = {
    prism: {
      chats: chatsApi,
      providers: { list: async () => o.profiles },
      host: { onStatus: (l) => { statusListeners.add(l); if (state.current) l(state.current); return () => statusListeners.delete(l) }, capabilities: () => o.caps },
      claude: { agentSend: (p) => calls.claude.push(p), agentAbort: (id) => calls.abort.push(['claude', id]),
        agentRespondPermission() {}, agentRespondQuestion() {},
        ...Object.fromEntries(CLAUDE_EVENTS.map((n) => [n, (cb) => { claudeCbs[n] = cb }])) },
      codex: { send: (p) => calls.codex.push(p), abort: (id) => calls.abort.push(['codex', id]), permission() {}, question() {}, onEvent: (cb) => codexCbs.push(cb) },
      app: { notify: (title, body) => calls.notify.push([title, body]) },
      tasks: { load: async () => ({ tasks: [], openIds: [], activeId: null }) }
    },
    addEventListener: (ev, fn) => { windowEvents[ev] = fn }
  }
  global.document = { hasFocus: () => state.focus }
  const zustand = fakeZustand()
  const useStore = zustand.create(() => ({
    settings: { model: 'sonnet', notifyOnDone: o.notifyOnDone, notifyOnAsk: o.notifyOnAsk }, remote: undefined, chatOpen: false,
    addToast: (kind, msg) => calls.toasts.push(msg), bumpTree: () => { calls.bump++ }, reloadOpenFiles: async () => { calls.reload++ }
  }))
  const useAgentTasks = { getState: () => ({ activeId: o.activeTask, activate() {} }), setState() {} }
  const catalog = load('src/renderer/src/lib/modelCatalog.ts', { zustand })
  const mod = load('src/renderer/src/lib/agentChats.ts', {
    '../../../shared/subagents': load('src/shared/subagents.ts'),
    './asyncQuestions': load('src/renderer/src/lib/asyncQuestions.ts'),
    '../../../shared/imageReferences': load('src/shared/imageReferences.ts'),
    zustand, '../../../shared/agents': load('src/shared/agents.ts'), '../../../shared/providerUsage': load('src/shared/providerUsage.ts'),
    '../../../shared/chatDeltas': load('src/shared/chatDeltas.ts'),
    './notify': { notifyTaskDone: (...a) => calls.taskNotify.push(a) },
    '../store': { useStore }, './agentTasks': { useAgentTasks }, './modelCatalog': catalog
  })
  const chats = mod.useAgentChats
  const e = { chats, S: () => chats.getState(), useStore, catalog, calls, state, follow, claudeCbs, codexCbs, windowEvents, emitStatus, storage,
    drafts: () => JSON.parse(storage.get('prism.chatDrafts') || '{}'),
    hostCalls: (name) => calls.host.filter((c) => c[0] === name),
    async boot(snap) {
      const p = e.S().init()
      await tick(); await tick()
      follow.snap(snap)
      await p
    },
    setCatalog(models, provider = 'claude', profile = 'ambient-claude') {
      catalog.useModelCatalog.setState({ entries: { [catalog.catalogKey(provider, profile)]: { models, loading: false } } })
    } }
  return e
}

/** A test with `setTimeout` faked (15 s silence, 750 ms saves, 40 ms render batches) so nothing fires after it ends. */
const hostTest = (name, options, body) => test(name, async (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] })
  const e = env(options)
  e.ctx = ctx
  await body(e, ctx)
})

// ---------- mode decision ----------

hostTest('IPC native subagents remain linked and live after the parent starts its next turn', { owned: false, localChats: [mkChat('parent')] }, async e => {
  await e.S().init();e.S().send('parent','First')
  const turnId=e.S().runtime.parent.turnId
  e.claudeCbs.onAgentSubagent({id:turnId,agent:{id:'child',name:'Explore',status:'running',text:'Child output'}})
  const childId='subagent:parent:child'
  assert.equal(e.S().runtime[childId].busy,true)
  assert.equal(e.S().chats.find(c=>c.id===childId).parentChatId,'parent')
  e.claudeCbs.onAgentDone({id:turnId})
  assert.equal(e.S().runtime[childId].busy,true)
  assert.equal(e.S().chats.find(c=>c.id==='parent').turns.at(-1).segments[0].subagent.status,'running')
  e.S().send('parent','Second');const second=e.S().runtime.parent.turnId
  e.claudeCbs.onAgentSubagent({id:turnId,agent:{id:'child',status:'completed',summary:'Result'}})
  assert.equal(e.S().runtime[childId].busy,false)
  assert.equal(e.S().runtime.parent.turnId,second);assert.equal(e.S().runtime.parent.busy,true)
  assert.deepEqual(e.S().chats.find(c=>c.id==='parent').turns.at(-1).segments,[])
  assert.equal(e.S().chats.find(c=>c.id===childId).turns[0].segments[0].text,'Child output')
  assert.equal(e.S().send(childId,'Cannot send independently'),false)
})

hostTest('host-driven native subagent notifications are not projected twice by the renderer', {}, async e => {
  await e.boot(snapshot([mkChat('parent',{turns:[{id:'turn',role:'assistant',text:'',segments:[]}]})],{parent:busy('turn')}))
  e.claudeCbs.onAgentSubagent({id:'turn',agent:{id:'child',status:'running'}})
  assert.equal(e.S().chats.length,1)
})

hostTest('queue: host refusal restores the head and its attachments', { reply: { send: () => ({ ok: false, code: 'busy', error: 'Ocupado' }) } }, async (e) => {
  await e.boot(snapshot([mkChat('c')]))
  const first = { text: 'first', context: 'file.ts', images: [{ mime: 'image/png', data: 'aGVsbG8=' }] }
  e.S().enqueue('c', first); e.S().enqueue('c', { text: 'second' })
  e.S().flushQueue('c')
  await tick()
  assert.deepEqual(e.S().chats[0].queued, [{ ...first, images: first.images.map(image => ({ ...image, number: 1 })) }, { text: 'second' }])
  assert.equal(e.S().runtime.c?.busy, undefined)
})

hostTest('mode: hostOwned false → ipc', { owned: false, localChats: [mkChat('a', { updatedAt: 5 })] }, async (e) => {
  await e.S().init()
  assert.equal(e.S().mode, 'ipc')
  assert.equal(e.S().ready, true)
  assert.equal(e.calls.list, 1)
  assert.equal(e.calls.follow, 0)
  assert.equal(e.S().activeId, 'a')
})

hostTest('mode: hostOwned missing → ipc', { owned: undefined }, async (e) => {
  await e.S().init()
  assert.equal(e.S().mode, 'ipc')
  assert.equal(e.calls.list, 1)
})

hostTest('mode: owned and connected with chats@1 → host (and no ipc list)', {}, async (e) => {
  await e.boot(snapshot([mkChat('a')]))
  assert.equal(e.S().mode, 'host')
  assert.equal(e.S().ready, true)
  assert.equal(e.calls.list, 0)
  assert.equal(e.calls.follow, 1)
  assert.equal(e.S().hostError, null)
})

hostTest('mode: owned and connected without chats@1 → ipc', { caps: ['claude@1'], localChats: [mkChat('a')] }, async (e) => {
  await e.S().init()
  assert.equal(e.S().mode, 'ipc')
  assert.equal(e.calls.list, 1)
  assert.equal(e.calls.follow, 0)
})

hostTest('mode: a host that never connects says so after 15 s and does not fall back to ipc; connecting clears it', { connected: false }, async (e, ctx) => {
  const p = e.S().init()
  await tick()
  ctx.mock.timers.tick(14_999)
  assert.equal(e.S().hostError, null)
  ctx.mock.timers.tick(1)
  assert.equal(e.S().hostError, SILENT)
  assert.equal(e.calls.list, 0)
  assert.equal(e.calls.follow, 0)
  assert.equal(e.S().mode, null)
  e.emitStatus({ state: 'connected', hello: { capabilities: CAPS } })
  await tick(); await tick()
  assert.equal(e.S().hostError, null)
  assert.equal(e.S().mode, 'host')
  e.follow.snap(snapshot([mkChat('a')]))
  await p
  assert.equal(e.S().ready, true)
  assert.equal(e.calls.list, 0)
})

hostTest('mode: a host that drops later shows the error after 15 s and clears it on reconnect', {}, async (e, ctx) => {
  await e.boot(snapshot([mkChat('a')]))
  e.emitStatus({ state: 'reconnecting' })
  ctx.mock.timers.tick(14_999)
  assert.equal(e.S().hostError, null)
  ctx.mock.timers.tick(1)
  assert.equal(e.S().hostError, SILENT)
  e.emitStatus({ state: 'connected', hello: { capabilities: CAPS } })
  assert.equal(e.S().hostError, null)
  e.emitStatus({ state: 'reconnecting' })
  e.emitStatus({ state: 'connected', hello: { capabilities: CAPS } })
  ctx.mock.timers.tick(20_000)
  assert.equal(e.S().hostError, null, 'the pending timer was cancelled by the reconnect')
})

// ---------- snapshot ----------

hostTest('snapshot: chats and runtime come as they are, nothing normalized; activeId is the most recent', {}, async (e) => {
  const running = mkChat('run', { updatedAt: 9, pendingTurnId: 't1',
    turns: [{ id: 't1', role: 'assistant', startedAt: 1, segments: [{ kind: 'tool', toolId: 'x', status: 'running' }, { kind: 'tool', toolId: 'y', status: 'awaiting' }] }] })
  const old = mkChat('old', { updatedAt: 2 })
  await e.boot(snapshot([old, running], { run: busy('t1', { permission: { permId: 'p', toolName: 'Bash' } }) }))
  assert.deepEqual(e.S().chats.map((c) => c.id), ['run', 'old'])
  assert.equal(e.S().activeId, 'run')
  const c = e.S().chats[0]
  assert.equal(c.pendingTurnId, 't1')
  assert.equal(c.turns[0].interrupted, undefined)
  assert.deepEqual(c.turns[0].segments.map((s) => s.status), ['running', 'awaiting'])
  assert.equal(e.S().runtime.run.busy, true)
  assert.equal(e.S().runtime.run.permission.permId, 'p')
  assert.deepEqual(e.S().profiles.map((p) => p.id), ['ambient-claude', 'ambient-codex'])
  assert.equal(e.S().ready, true)
})

hostTest('snapshot: a new one replaces chats and runtime but keeps the active chat if it still exists', {}, async (e) => {
  await e.boot(snapshot([mkChat('a', { updatedAt: 5 }), mkChat('b', { updatedAt: 1 })], { a: busy() }))
  e.S().select('b')
  e.follow.snap(snapshot([mkChat('a', { updatedAt: 7, title: 'novo' }), mkChat('b', { updatedAt: 1 })], {}))
  assert.equal(e.S().activeId, 'b')
  assert.equal(e.S().chats[0].title, 'novo')
  assert.deepEqual(e.S().runtime, {})
  e.follow.snap(snapshot([mkChat('a', { updatedAt: 7 })], {}))
  assert.equal(e.S().activeId, 'a')
})

hostTest('snapshot: a chat being created here survives a snapshot that does not have it yet', { reply: { create: () => new Promise(() => {}) } }, async (e) => {
  await e.boot(snapshot([mkChat('a')]))
  e.S().create('C:\\p')
  const id = e.S().activeId
  e.follow.snap(snapshot([mkChat('a')]))
  assert.ok(e.S().chats.some((c) => c.id === id))
})

// ---------- deltas ----------

hostTest('deltas: applied with applyChatDeltas', {}, async (e) => {
  await e.boot(snapshot([mkChat('a', { turns: [{ id: 't1', startedAt: 1, segments: [] }] })], { a: busy('t1') }))
  e.follow.deltas([
    { op: 'append', chatId: 'a', turnId: 't1', kind: 'text', text: 'oi ' },
    { op: 'append', chatId: 'a', turnId: 't1', kind: 'text', text: 'mundo' },
    { op: 'metrics', chatId: 'a', turnId: 't1', metrics: { outputTokens: 3 } },
    { op: 'chat', chat: mkChat('n', { updatedAt: 3 }) }
  ], 2)
  assert.deepEqual(e.S().chats.find((c) => c.id === 'a').turns[0].segments, [{ kind: 'text', text: 'oi mundo' }])
  assert.deepEqual(e.S().chats.find((c) => c.id === 'a').turns[0].metrics, { outputTokens: 3 })
  assert.ok(e.S().chats.some((c) => c.id === 'n'))
  e.follow.deltas([{ op: 'runtime', chatId: 'a', runtime: null }], 3)
  assert.equal(e.S().runtime.a, undefined)
})

hostTest('deltas: removing the active chat picks the next of the same task', {}, async (e) => {
  await e.boot(snapshot([
    mkChat('gone', { taskId: 'T1', updatedAt: 9 }), mkChat('new', { taskId: 'T1', updatedAt: 4 }), mkChat('old', { taskId: 'T1', updatedAt: 2 }),
    mkChat('arch', { taskId: 'T1', updatedAt: 8, archived: true }), mkChat('other', { taskId: 'T2', updatedAt: 99 })
  ]))
  e.S().select('gone')
  e.follow.deltas([{ op: 'remove', chatId: 'gone' }], 2)
  assert.equal(e.S().activeId, 'new')
  e.follow.deltas([{ op: 'remove', chatId: 'old' }], 3)
  assert.equal(e.S().activeId, 'new', 'removing another chat keeps the active one')
  e.follow.deltas([{ op: 'remove', chatId: 'new' }], 4)
  assert.equal(e.S().activeId, null)
})

// ---------- commands ----------

hostTest('create: optimistic insert, host.create without drafts; a child inherits from its parent', { activeTask: 'ACTIVE' }, async (e) => {
  const target = { host: 'h', port: 22, username: 'u' }
  await e.boot(snapshot([mkChat('p', { cwd: 'C:\\parent', taskId: 'PT', remoteId: 'r', remoteTarget: target, selection: claudeSel({ model: 'sonnet', effort: 'low' }) })]))
  e.S().create('C:\\proj')
  const fresh = e.S().chats.find((c) => c.id !== 'p')
  assert.equal(e.S().activeId, fresh.id)
  assert.equal(fresh.cwd, 'C:\\proj')
  assert.equal(fresh.taskId, 'ACTIVE')
  const [, sent] = e.hostCalls('create')[0]
  assert.equal(sent.id, fresh.id)
  assert.ok(!('draft' in sent) && !('contextDraft' in sent))
  e.S().create('ignored', undefined, { parentChatId: 'p' })
  const child = e.S().chats.find((c) => c.parentChatId === 'p')
  assert.equal(child.cwd, 'C:\\parent'); assert.equal(child.taskId, 'PT'); assert.equal(child.remoteId, 'r')
  assert.deepEqual(child.remoteTarget, target)
  assert.deepEqual(child.selection, claudeSel({ model: 'sonnet', effort: 'low' }))
  assert.equal(e.hostCalls('create').length, 2)
  assert.equal(e.hostCalls('create')[1][1].id, child.id)
})

hostTest('create: a refused creation toasts', { reply: { create: () => ({ ok: false, code: 'invalid', error: 'repetido' }) } }, async (e) => {
  await e.boot(snapshot([mkChat('a')]))
  e.S().create('C:\\p')
  await tick()
  assert.deepEqual(e.calls.toasts, ['Não foi possível criar o chat: repetido'])
})

hostTest('configure works while running; account confirmation and archiving still wait', {}, async (e) => {
  await e.boot(snapshot([mkChat('a'), mkChat('b')], { b: busy() }))
  const sel = claudeSel({ model: 'sonnet' })
  e.S().configure('a', sel)
  e.S().configure('b', sel)
  assert.deepEqual(e.hostCalls('configure'), [['configure', 'a', sel], ['configure', 'b', sel]])
  e.S().confirmAccount('a'); e.S().confirmAccount('b')
  assert.deepEqual(e.hostCalls('confirmAccount'), [['confirmAccount', 'a']])
  e.S().rename('a', '  Novo nome  '); e.S().rename('a', '   ')
  assert.deepEqual(e.hostCalls('rename'), [['rename', 'a', 'Novo nome']])
  e.S().rename('a', 'x'.repeat(150))
  assert.equal(e.hostCalls('rename').at(-1)[2].length, 100)
  e.S().archive('a', true); e.S().archive('b', true); e.S().archive('b', false)
  assert.deepEqual(e.hostCalls('archive'), [['archive', 'a', true], ['archive', 'b', false]])
  // the host's copy is what changes: nothing was edited locally
  assert.equal(e.S().chats.find((c) => c.id === 'a').archived, undefined)
  assert.equal(e.S().chats.find((c) => c.id === 'a').title, 'title-a')
})

hostTest('a refused command shows the host message as a toast', { reply: { archive: () => ({ ok: false, code: 'busy', error: 'Agente em execução.' }) } }, async (e) => {
  await e.boot(snapshot([mkChat('a')]))
  e.S().archive('a', true)
  await tick()
  assert.deepEqual(e.calls.toasts, ['Agente em execução.'])
})

hostTest('bindWorkspace sends remoteTarget and the settings model; busy chats are refused', {}, async (e) => {
  const target = { host: 'h', port: 22, username: 'u' }
  await e.boot(snapshot([mkChat('a'), mkChat('b')], { b: busy() }))
  e.S().bindWorkspace('a', '/local')
  e.useStore.setState({ remote: { id: 'r', ...target } })
  e.S().bindWorkspace('a', '/srv', 'r')
  e.S().bindWorkspace('b', '/x')
  assert.deepEqual(e.hostCalls('bindWorkspace'), [
    ['bindWorkspace', { chatId: 'a', cwd: '/local', remoteId: undefined, remoteTarget: undefined, model: 'sonnet' }],
    ['bindWorkspace', { chatId: 'a', cwd: '/srv', remoteId: 'r', remoteTarget: target, model: 'sonnet' }]
  ])
})

hostTest('stop goes to the host for host-run chats only when busy', {}, async (e) => {
  await e.boot(snapshot([mkChat('a'), mkChat('b')], { b: busy() }))
  e.S().stop('a')
  assert.equal(e.hostCalls('stop').length, 0)
  e.S().stop('b')
  assert.deepEqual(e.hostCalls('stop'), [['stop', 'b']])
  assert.equal(e.calls.abort.length, 0)
})

hostTest('remove: host.remove, forgets the draft; not_found is fine, other refusals throw; busy never calls', {
  storage: { a: { draft: 'D' }, b: { draft: 'E' } },
  reply: { remove: (id) => id === 'b' ? { ok: false, code: 'not_found', error: 'x' } : id === 'c' ? { ok: false, code: 'busy', error: 'Ocupado' } : { ok: true } }
}, async (e) => {
  await e.boot(snapshot([mkChat('a'), mkChat('b'), mkChat('c'), mkChat('d')], { d: busy() }))
  await e.S().remove('a')
  assert.ok(!e.S().chats.some((c) => c.id === 'a'))
  assert.equal(e.drafts().a, undefined)
  await e.S().remove('b')
  assert.ok(!e.S().chats.some((c) => c.id === 'b'))
  await assert.rejects(e.S().remove('c'), /Ocupado/)
  assert.ok(e.S().chats.some((c) => c.id === 'c'))
  await assert.rejects(e.S().remove('d'), /Pare a tarefa/)
  assert.deepEqual(e.hostCalls('remove').map((c) => c[1]), ['a', 'b', 'c'])
})

hostTest('send: local checks, optimistic busy runtime, host.send with the effective Fast, turnId from the reply', {}, async (e) => {
  await e.boot(snapshot([mkChat('c', { selection: claudeSel({ serviceTier: 'fast' }) }), mkChat('w', { workspaceNeedsBinding: true }), mkChat('bz')], { bz: busy() }))
  assert.equal(e.S().send('missing', 'x'), false)
  assert.equal(e.S().send('c', '   '), false)
  assert.equal(e.S().send('bz', 'x'), false)
  assert.equal(e.S().send('w', 'x'), false)
  assert.deepEqual(e.calls.toasts, ['Confirme a pasta e a conta deste chat importado antes de continuar.'])
  assert.equal(e.hostCalls('send').length, 0)
  assert.equal(e.S().send('c', 'oi', 'arquivo.ts'), true)
  assert.deepEqual(e.S().runtime.c, { turnId: '', route: ROUTE, busy: true, fast: undefined })
  assert.deepEqual(e.hostCalls('send'), [['send', { chatId: 'c', text: 'oi', context: 'arquivo.ts', serviceTier: 'fast', profileName: 'Claude' }]])
  assert.equal(e.S().send('c', 'de novo'), false)
  await tick()
  assert.equal(e.S().runtime.c.turnId, 'T-host')
  assert.equal(e.S().runtime.c.busy, true)
  assert.equal(e.calls.claude.length, 0)
  assert.equal(e.S().chats.find((c) => c.id === 'c').turns.length, 0, 'the host builds the turns')
})

hostTest('send: Fast only when the catalog model offers it; no context stays undefined', {}, async (e) => {
  await e.boot(snapshot([mkChat('a', { selection: claudeSel({ serviceTier: 'fast' }) }), mkChat('b', { selection: claudeSel({ serviceTier: 'fast', model: 'haiku' }) })]))
  e.setCatalog([fastModel('opus'), { id: 'haiku', efforts: [] }])
  e.S().send('a', 'x'); e.S().send('b', 'x')
  const sent = e.hostCalls('send').map((c) => c[1])
  assert.equal(sent[0].serviceTier, 'fast')
  assert.equal(sent[1].serviceTier, undefined)
  assert.equal(sent[0].context, undefined)
})

hostTest('send: a refusal undoes the optimistic runtime (restoring the previous one) and toasts', { reply: { send: () => ({ ok: false, code: 'busy', error: 'Ocupado' }) } }, async (e) => {
  const previous = idle('old', { fast: { state: 'on' } })
  await e.boot(snapshot([mkChat('a'), mkChat('b')], { b: previous }))
  assert.equal(e.S().send('a', 'x'), true)
  assert.equal(e.S().runtime.a.busy, true)
  assert.equal(e.S().send('b', 'x'), true)
  assert.equal(e.S().runtime.b.busy, true)
  assert.deepEqual(e.S().runtime.b.fast, { state: 'on' })
  await tick()
  assert.equal(e.S().runtime.a, undefined)
  assert.deepEqual(e.S().runtime.b, previous)
  assert.deepEqual(e.calls.toasts, ['Ocupado', 'Ocupado'])
})

hostTest('send: a runtime replaced by the host meanwhile is not undone or overwritten', { reply: { send: () => ({ ok: false, code: 'busy', error: 'Ocupado' }) } }, async (e) => {
  await e.boot(snapshot([mkChat('a')]))
  e.S().send('a', 'x')
  e.follow.deltas([{ op: 'runtime', chatId: 'a', runtime: busy('real') }], 2)
  await tick()
  assert.equal(e.S().runtime.a.turnId, 'real')
})

hostTest('respondPermission: clears the local permission and answers the host; gone → friendly toast', {
  reply: { respondPermission: () => ({ ok: false, code: 'gone', error: 'não pendente' }), respondQuestion: () => ({ ok: false, code: 'gone', error: 'não pendente' }) }
}, async (e) => {
  await e.boot(snapshot([mkChat('a'), mkChat('b')], {
    a: busy('t1', { permission: { permId: 'p1', toolName: 'Bash' } }),
    b: busy('t2', { question: { dialogId: 'd1', questions: [{ question: 'Q?' }] } })
  }))
  e.S().respondPermission('a', 'allow')
  assert.equal(e.S().runtime.a.permission, undefined)
  assert.equal(e.S().runtime.a.busy, true)
  assert.deepEqual(e.hostCalls('respondPermission'), [['respondPermission', { chatId: 'a', permId: 'p1', decision: 'allow' }]])
  e.S().respondPermission('a', 'deny') // nothing pending any more
  assert.equal(e.hostCalls('respondPermission').length, 1)
  const answered = e.S().respondQuestion('b', { x: 'y' }, 'r')
  assert.equal(e.S().runtime.b.question.dialogId, 'd1', 'the question remains while the host checks the answer')
  assert.deepEqual(e.hostCalls('respondQuestion'), [['respondQuestion', { chatId: 'b', dialogId: 'd1', answers: { x: 'y' }, response: 'r' }]])
  assert.equal(await answered, false)
  assert.equal(e.S().runtime.b.question.dialogId, 'd1', 'a refusal keeps the card and its draft available')
  await tick()
  assert.deepEqual(e.calls.toasts, ['Esta permissão já foi respondida.', 'Esta pergunta já foi respondida.'])
})

hostTest('respondQuestion: waits for acceptance and clears only the answered dialog in the latest runtime', {}, async (e) => {
  const question = { dialogId: 'd1', questions: [{ question: 'Qual?', options: [] }] }
  await e.boot(snapshot([mkChat('c', { draft: 'rascunho' })], { c: busy('t1', { question }) }))
  let accept
  window.prism.chats.host.respondQuestion = payload => {
    e.calls.host.push(['respondQuestion', payload])
    return new Promise(resolve => { accept = resolve })
  }
  const answered = e.S().respondQuestion('c', { 'Qual?': 'Azul' }, 'Azul')
  assert.equal(e.S().runtime.c.question, question)
  e.follow.deltas([{ op: 'runtime', chatId: 'c', runtime: busy('t1', { question, fast: true }) }], 2)
  accept({ ok: true })
  assert.equal(await answered, true)
  assert.equal(e.S().runtime.c.question, undefined)
  assert.equal(e.S().runtime.c.fast, true, 'answering does not overwrite later runtime updates')
  assert.equal(e.S().chats[0].draft, 'rascunho')
  assert.deepEqual(e.hostCalls('respondQuestion'), [['respondQuestion', { chatId: 'c', dialogId: 'd1', answers: { 'Qual?': 'Azul' }, response: 'Azul' }]])
})

for (const [label, replacement] of [
  ['a next question', busy('t1', { question: { dialogId: 'd2', questions: [{ question: 'Próxima?' }] } })],
  ['a new turn with the same dialog id', busy('t2', { question: { dialogId: 'd1', questions: [{ question: 'Outro turno?' }] } })],
  ['the host having already cleared the question', busy('t1')]
]) hostTest(`respondQuestion: an accepted answer preserves ${label}`, {}, async (e) => {
  await e.boot(snapshot([mkChat('c')], { c: busy('t1', { question: { dialogId: 'd1', questions: [{ question: 'Qual?' }] } }) }))
  let accept
  window.prism.chats.host.respondQuestion = () => new Promise(resolve => { accept = resolve })
  const answered = e.S().respondQuestion('c', { 'Qual?': 'Azul' })
  e.follow.deltas([{ op: 'runtime', chatId: 'c', runtime: replacement }], 2)
  const current = e.S().runtime.c
  accept({ ok: true })
  assert.equal(await answered, true)
  assert.equal(e.S().runtime.c, current)
})

hostTest('respondQuestion: transport failures keep the question and composer draft for retry', {
  reply: { respondQuestion: () => Promise.reject(new Error('Host desconectado')) }
}, async (e) => {
  const question = { dialogId: 'd1', questions: [{ question: 'Qual?' }] }
  await e.boot(snapshot([mkChat('c', { draft: 'mensagem preparada' })], { c: busy('t1', { question }) }))
  assert.equal(await e.S().respondQuestion('c', { 'Qual?': 'Azul' }), false)
  assert.equal(e.S().runtime.c.question, question)
  assert.equal(e.S().chats[0].draft, 'mensagem preparada')
  assert.deepEqual(e.calls.toasts, ['Host desconectado'])
})

hostTest('respondQuestion: absent chat or question returns false without sending a command', {}, async (e) => {
  await e.boot(snapshot([mkChat('c')], { c: busy('t1') }))
  assert.equal(await e.S().respondQuestion('c', { 'Qual?': 'Azul' }), false)
  assert.equal(await e.S().respondQuestion('missing', { 'Qual?': 'Azul' }), false)
  assert.equal(e.hostCalls('respondQuestion').length, 0)
})

for (const provider of ['claude', 'codex']) hostTest(`respondQuestion: local ${provider} delivery resolves true after answering`, {}, async (e) => {
  const question = { dialogId: 'd1', questions: [{ question: 'Qual?' }] }
  const selection = provider === 'codex' ? codexSel() : claudeSel()
  await e.boot(snapshot([mkChat('c', { selection })], { c: busy('t1', { local: true, question }) }))
  const calls = []
  if (provider === 'codex') window.prism.codex.question = (...args) => calls.push(args)
  else window.prism.claude.agentRespondQuestion = payload => calls.push(payload)
  assert.equal(await e.S().respondQuestion('c', { 'Qual?': 'Azul' }, 'Azul'), true)
  assert.equal(e.S().runtime.c.question, undefined)
  assert.equal(e.hostCalls('respondQuestion').length, 0)
  assert.deepEqual(calls, provider === 'codex' ? [['c', 'd1', { 'Qual?': 'Azul' }]] : [{ id: 't1', dialogId: 'd1', answers: { 'Qual?': 'Azul' }, response: 'Azul', cancelled: false }])
})

hostTest('async questions: idle local reply is a visible follow-up and preserves the composer and attachments', { owned: false, localChats: [asyncQuestionChat()] }, async (e) => {
  await e.S().init()
  e.S().attachImages('c', [{ mime: 'image/png', data: 'aGVsbG8=' }])
  const attachments = e.S().attachments.c
  const source = latestStructuredQuestions(e.S().chats[0].turns)
  assert.equal(await e.S().replyToQuestions('c', source.key, asyncAnswers), true)
  assert.equal(e.calls.codex[0].prompt, buildStructuredQuestionsReply(source, asyncAnswers))
  assert.equal(e.S().chats[0].turns.at(-2).text, buildStructuredQuestionsReply(source, asyncAnswers))
  assert.equal(e.S().chats[0].draft, 'Rascunho preservado')
  assert.equal(e.S().chats[0].contextDraft, 'file.ts')
  assert.equal(e.S().attachments.c, attachments)
  assert.equal(latestStructuredQuestions(e.S().chats[0].turns), null)
  assert.equal(e.hostCalls('respondQuestion').length, 0)
})

hostTest('async questions: active local reply steers the same turn instead of creating a blocking dialog', { owned: false, localChats: [asyncQuestionChat()] }, async (e) => {
  await e.S().init()
  e.chats.setState({ runtime: { c: busy('t-q') } })
  const steers = []
  window.prism.codex.steer = async payload => { steers.push(payload) }
  const source = latestStructuredQuestions(e.S().chats[0].turns)
  assert.equal(await e.S().replyToQuestions('c', source.key, asyncAnswers), true)
  assert.equal(steers.length, 1)
  assert.equal(steers[0].turnId, 't-q')
  assert.equal(steers[0].text, buildStructuredQuestionsReply(source, asyncAnswers))
  assert.equal(e.calls.codex.length, 0)
  assert.equal(e.S().runtime.c.question, undefined)
  assert.equal(e.S().chats[0].queued.length, 0)
  assert.equal(e.S().chats[0].draft, 'Rascunho preservado')
  assert.equal(latestStructuredQuestions(e.S().chats[0].turns), null)
})

hostTest('async questions: a failed local reply stays in one queue row and retry replaces its answer', { owned: false, localChats: [asyncQuestionChat()] }, async (e) => {
  await e.S().init()
  e.chats.setState({ runtime: { c: busy('t-q') } })
  let refuse = true
  const steers = []
  window.prism.codex.steer = async payload => { steers.push(payload); if (refuse) throw new Error('Não enviado') }
  const source = latestStructuredQuestions(e.S().chats[0].turns)
  assert.equal(await e.S().replyToQuestions('c', source.key, asyncAnswers), false)
  assert.equal(e.S().chats[0].queued.length, 1)
  assert.equal(e.S().chats[0].queued[0].id, `question:${source.key}`)
  assert.equal(latestStructuredQuestions(e.S().chats[0].turns).key, source.key)
  const corrected = { ...asyncAnswers, 'Qual cor?': 'Verde' }
  refuse = false
  assert.equal(await e.S().replyToQuestions('c', source.key, corrected), true)
  assert.equal(e.S().chats[0].queued.length, 0)
  assert.equal(steers[1].text, buildStructuredQuestionsReply(source, corrected))
  assert.equal(e.S().chats[0].draft, 'Rascunho preservado')
})

hostTest('async questions: stale sources and incomplete answers never send a follow-up', { owned: false, localChats: [asyncQuestionChat()] }, async (e) => {
  await e.S().init()
  const source = latestStructuredQuestions(e.S().chats[0].turns)
  assert.equal(await e.S().replyToQuestions('c', 'old-source', asyncAnswers), false)
  assert.equal(await e.S().replyToQuestions('c', source.key, { 'Qual cor?': 'Azul' }), false)
  const chat = e.S().chats[0]
  e.chats.setState({ chats: [{ ...chat, turns: [...chat.turns, { id: 'u2', role: 'user', text: 'Já respondi' }] }] })
  assert.equal(await e.S().replyToQuestions('c', source.key, asyncAnswers), false)
  assert.equal(e.calls.codex.length, 0)
  assert.equal(e.S().chats[0].queued, undefined)
})

for (const blocked of ['permission', 'ssh']) hostTest(`async questions: ${blocked} keeps the accepted answer in the local queue`,
  { owned: false, localChats: [asyncQuestionChat(blocked === 'ssh' ? { remoteId: 'ssh' } : {})] }, async e => {
    await e.S().init()
    e.chats.setState({ runtime: { c: busy('t-q', blocked === 'permission' ? { permission: { permId: 'p1' } } : {}) } })
    const source = latestStructuredQuestions(e.S().chats[0].turns)
    assert.equal(await e.S().replyToQuestions('c', source.key, asyncAnswers), true)
    assert.equal(e.S().chats[0].queued.length, 1)
    assert.equal(e.S().chats[0].queued[0].text, buildStructuredQuestionsReply(source, asyncAnswers))
    assert.equal(e.calls.codex.length, 0)
    assert.equal(e.S().chats[0].draft, 'Rascunho preservado')
    assert.match(e.calls.toasts.at(-1), /Resposta adicionada à fila/)
  })

hostTest('async questions: host replies wait for queue acceptance and the real send acknowledgement', { caps: [...CAPS, 'chats.queue@1'] }, async e => {
  await e.boot(snapshot([asyncQuestionChat()], { c: busy('t-q') }))
  const source = latestStructuredQuestions(e.S().chats[0].turns)
  let added, sent
  window.prism.chats.host.queue = (chatId, operation, payload) => {
    e.calls.host.push(['queue', chatId, operation, payload])
    return new Promise(resolve => { if (operation === 'add') added = resolve; else sent = resolve })
  }
  const reply = e.S().replyToQuestions('c', source.key, asyncAnswers)
  const duplicate = e.S().replyToQuestions('c', source.key, asyncAnswers)
  assert.equal(e.hostCalls('queue').length, 1, 'concurrent submissions share the pending request')
  assert.equal(e.S().chats[0].draft, 'Rascunho preservado')
  added({ ok: true, id: `question:${source.key}` })
  await tick()
  assert.deepEqual(e.hostCalls('queue').map(call => call[2]), ['add', 'send'])
  assert.equal(latestStructuredQuestions(e.S().chats[0].turns).key, source.key)
  sent({ ok: true })
  assert.equal(await reply, true)
  assert.equal(await duplicate, true)
  assert.equal(e.hostCalls('respondQuestion').length, 0)
  assert.equal(e.S().chats[0].contextDraft, 'file.ts')
})

hostTest('async questions: rejected host send retains the row and retry uses the same id and updated answers', { caps: [...CAPS, 'chats.queue@1'] }, async e => {
  await e.boot(snapshot([asyncQuestionChat()], { c: busy('t-q') }))
  const source = latestStructuredQuestions(e.S().chats[0].turns)
  const rows = new Map()
  let refuse = true
  window.prism.chats.host.queue = async (chatId, operation, payload) => {
    e.calls.host.push(['queue', chatId, operation, payload])
    if (operation === 'add' || operation === 'replace') { rows.set(payload.message.id, payload.message); return { ok: true, id: payload.message.id } }
    if (refuse) return { ok: false, code: 'busy', error: 'Aguarde o agente' }
    rows.delete(payload.id)
    return { ok: true }
  }
  assert.equal(await e.S().replyToQuestions('c', source.key, asyncAnswers), false)
  assert.equal(rows.size, 1)
  assert.equal(latestStructuredQuestions(e.S().chats[0].turns).key, source.key)
  const corrected = { ...asyncAnswers, 'Qual cor?': 'Verde' }
  refuse = false
  assert.equal(await e.S().replyToQuestions('c', source.key, corrected), true)
  assert.deepEqual(e.hostCalls('queue').map(call => call[2]), ['add', 'send', 'replace', 'send'])
  assert.equal(e.hostCalls('queue')[2][3].message.text, buildStructuredQuestionsReply(source, corrected))
  assert.equal(rows.size, 0)
  assert.equal(e.S().chats[0].draft, 'Rascunho preservado')
})

hostTest('async questions: a pending native approval accepts the host queue answer without sending through it', { caps: [...CAPS, 'chats.queue@1'] }, async e => {
  await e.boot(snapshot([asyncQuestionChat()], { c: busy('t-q', { permission: { permId: 'p1' } }) }))
  const source = latestStructuredQuestions(e.S().chats[0].turns)
  assert.equal(await e.S().replyToQuestions('c', source.key, asyncAnswers), true)
  assert.deepEqual(e.hostCalls('queue').map(call => call[2]), ['add'])
  assert.equal(e.S().runtime.c.permission.permId, 'p1')
  assert.equal(e.S().chats[0].draft, 'Rascunho preservado')
})

hostTest('async questions: a manually removed failed answer can be queued again without duplicating a retry', { caps: [...CAPS, 'chats.queue@1'] }, async e => {
  await e.boot(snapshot([asyncQuestionChat()], { c: busy('t-q') }))
  const source = latestStructuredQuestions(e.S().chats[0].turns)
  const rows = new Map()
  let refuse = true
  window.prism.chats.host.queue = async (chatId, operation, payload) => {
    e.calls.host.push(['queue', chatId, operation, payload])
    if (operation === 'replace' && !rows.has(payload.id)) return { ok: false, code: 'gone', error: 'Removida da fila' }
    if (operation === 'add' || operation === 'replace') { rows.set(payload.message.id, payload.message); return { ok: true } }
    if (refuse) return { ok: false, code: 'busy', error: 'Aguarde o agente' }
    rows.delete(payload.id)
    return { ok: true }
  }
  assert.equal(await e.S().replyToQuestions('c', source.key, asyncAnswers), false)
  rows.delete(`question:${source.key}`) // user removed the failed queued answer elsewhere
  assert.equal(await e.S().replyToQuestions('c', source.key, asyncAnswers), false)
  refuse = false
  assert.equal(await e.S().replyToQuestions('c', source.key, asyncAnswers), true)
  assert.deepEqual(e.hostCalls('queue').map(call => call[2]), ['add', 'send', 'replace', 'add', 'send'])
  assert.equal(rows.size, 0)
})

hostTest('respondPermission: other refusals show the host message', { reply: { respondPermission: () => ({ ok: false, code: 'internal', error: 'caiu' }) } }, async (e) => {
  await e.boot(snapshot([mkChat('a')], { a: busy('t1', { permission: { permId: 'p1' } }) }))
  e.S().respondPermission('a', 'allow_always')
  await tick()
  assert.deepEqual(e.calls.toasts, ['caiu'])
})

hostTest('importSession: deduplicates by session and remote, else creates on the host', { activeTask: 'ACTIVE' }, async (e) => {
  await e.boot(snapshot([mkChat('x', { resume: { route: ROUTE, sessionId: 's1' } })]))
  e.S().importSession(mkChat('dup', { resume: { route: ROUTE, sessionId: 's1' } }))
  assert.equal(e.S().activeId, 'x')
  assert.equal(e.hostCalls('create').length, 0)
  assert.ok(!e.S().chats.some((c) => c.id === 'dup'))
  e.S().importSession(mkChat('ssh', { resume: { route: ROUTE, sessionId: 's1' }, remoteId: 'r', draft: 'D', contextDraft: 'C' }))
  assert.equal(e.hostCalls('create').length, 1)
  const sent = e.hostCalls('create')[0][1]
  assert.equal(sent.id, 'ssh'); assert.equal(sent.taskId, 'ACTIVE')
  assert.ok(!('draft' in sent) && !('contextDraft' in sent))
  assert.equal(e.S().activeId, 'ssh')
})

// ---------- drafts ----------

hostTest('drafts: never reach the host; saved on the device under prism.chatDrafts', {}, async (e) => {
  await e.boot(snapshot([mkChat('a')]))
  e.S().draft('a', 'rascunho')
  e.S().contextDraft('a', 'ctx')
  e.S().draft('a', 'rascunho 2')
  assert.equal(e.calls.host.length, 0)
  assert.deepEqual(e.drafts(), { a: { draft: 'rascunho 2', contextDraft: 'ctx' } })
  assert.equal(e.S().chats[0].draft, 'rascunho 2')
  assert.equal(e.S().chats[0].contextDraft, 'ctx')
  ctxFlush(e)
  assert.equal(e.calls.host.length, 0, 'no save is scheduled for a draft')
})
function ctxFlush(e) { e.ctx.mock.timers.tick(5_000); }

hostTest('drafts: the device draft beats the document in the snapshot; without one the document draft counts (and is kept)', {
  storage: { a: { draft: 'LOCAL' } }
}, async (e) => {
  await e.boot(snapshot([mkChat('a', { draft: 'DOC', contextDraft: 'CTX', updatedAt: 3 }), mkChat('n', { draft: 'DOCN', updatedAt: 2 }), mkChat('z', { updatedAt: 1 })]))
  const by = (id) => e.S().chats.find((c) => c.id === id)
  assert.equal(by('a').draft, 'LOCAL')
  assert.equal(by('a').contextDraft, 'CTX')
  assert.equal(by('n').draft, 'DOCN')
  assert.equal(by('z').draft, undefined)
  assert.deepEqual(e.drafts().a, { draft: 'LOCAL', contextDraft: 'CTX' })
  assert.deepEqual(e.drafts().n, { draft: 'DOCN' })
})

hostTest('drafts: deltas keep the device draft over the document and adopt a document-only one', { storage: { a: { draft: 'LOCAL' } } }, async (e) => {
  await e.boot(snapshot([mkChat('a'), mkChat('b')]))
  const by = (id) => e.S().chats.find((c) => c.id === id)
  e.follow.deltas([{ op: 'chat', chat: mkChat('a', { draft: 'OTHER' }) }], 2)
  assert.equal(by('a').draft, 'LOCAL')
  e.follow.deltas([{ op: 'patch', chatId: 'a', patch: { draft: 'P' } }], 3)
  assert.equal(by('a').draft, 'LOCAL')
  e.follow.deltas([{ op: 'patch', chatId: 'a', patch: { draft: null } }], 4)
  assert.equal(by('a').draft, 'LOCAL')
  e.follow.deltas([{ op: 'chat', chat: mkChat('b', { draft: 'DOC-B' }) }], 5)
  assert.equal(by('b').draft, 'DOC-B')
  assert.equal(e.drafts().b.draft, 'DOC-B')
  e.follow.deltas([{ op: 'patch', chatId: 'b', patch: { title: 'novo' } }], 6)
  assert.equal(by('b').draft, 'DOC-B')
})

hostTest('drafts: a corrupt or missing storage value is an empty start', {}, async (e) => {
  e.storage.set('prism.chatDrafts', '{not json')
  await e.boot(snapshot([mkChat('a')]))
  e.S().draft('a', 'x')
  assert.deepEqual(e.drafts(), { a: { draft: 'x' } })
})

// ---------- chats this window runs itself ----------

const SSH = { host: 'srv', port: 22, username: 'u' }
const sshChat = (over = {}) => mkChat('r1', { remoteId: 'r', remoteTarget: SSH, draft: 'D', contextDraft: 'C', ...over })

hostTest('ssh chat: run over IPC, runtime local, saved with put (no drafts), events applied', {}, async (e, ctx) => {
  e.useStore.setState({ remote: { id: 'r', ...SSH } })
  await e.boot(snapshot([sshChat()]))
  assert.equal(e.S().chats[0].draft, 'D')
  assert.equal(e.S().send('r1', 'oi'), true)
  assert.equal(e.calls.claude.length, 1)
  assert.equal(e.hostCalls('send').length, 0)
  assert.equal(e.S().runtime.r1.local, true)
  assert.equal(e.S().runtime.r1.busy, true)
  const turnId = e.calls.claude[0].id
  assert.equal(e.S().runtime.r1.turnId, turnId)
  assert.ok(!('draft' in e.calls.claude[0].chat) && !('contextDraft' in e.calls.claude[0].chat))
  const puts = e.hostCalls('put')
  assert.equal(puts.length, 1)
  assert.ok(!('draft' in puts[0][1]) && !('contextDraft' in puts[0][1]))
  assert.equal(puts[0][1].pendingTurnId, turnId)
  assert.equal(puts[0][1].turns.length, 2)
  assert.equal(e.S().chats[0].draft, 'D', 'sending never touches the draft')

  e.claudeCbs.onAgentText({ id: turnId, text: 'ola' })
  e.claudeCbs.onAgentText({ id: turnId, text: ' você' })
  ctx.mock.timers.tick(40)
  const turn = () => e.S().chats[0].turns.find((t) => t.id === turnId)
  assert.deepEqual(turn().segments, [{ kind: 'text', text: 'ola você' }])

  e.claudeCbs.onAgentDone({ id: turnId, aborted: false })
  assert.equal(e.S().runtime.r1.busy, false)
  assert.equal(e.S().runtime.r1.local, true)
  assert.equal(e.S().chats[0].pendingTurnId, undefined)
  assert.equal(turn().error, false)
  assert.equal(e.hostCalls('put').length, 2)
  const last = e.hostCalls('put').at(-1)[1]
  assert.ok(!('draft' in last))
  assert.equal(last.turns.find((t) => t.id === turnId).segments[0].text, 'ola você')
  assert.equal(e.calls.bump, 1)
  assert.deepEqual(e.calls.notify, [['Prism · tarefa concluída', 'oi']])
})

hostTest('ssh chat: a failing put toasts', { reply: { put: () => ({ ok: false, code: 'busy', error: 'host ocupado' }) } }, async (e) => {
  e.useStore.setState({ remote: { id: 'r', ...SSH } })
  await e.boot(snapshot([sshChat()]))
  e.S().send('r1', 'oi')
  await tick()
  assert.ok(e.calls.toasts.some((m) => m.includes('host ocupado')))
})

hostTest('without claude@1 a Claude chat runs locally; codex follows its own capability', { caps: ['chats@1', 'codex@1'] }, async (e) => {
  await e.boot(snapshot([mkChat('c'), mkChat('x', { selection: codexSel() })]))
  assert.equal(e.S().send('c', 'oi'), true)
  assert.equal(e.calls.claude.length, 1)
  assert.equal(e.S().runtime.c.local, true)
  assert.equal(e.hostCalls('put').length, 1)
  assert.equal(e.S().send('x', 'oi'), true)
  assert.equal(e.hostCalls('send').length, 1)
  assert.equal(e.hostCalls('send')[0][1].chatId, 'x')
  assert.equal(e.calls.codex.length, 0)
})

hostTest('without codex@1 a Codex chat runs locally over IPC', { caps: ['chats@1', 'claude@1'] }, async (e) => {
  await e.boot(snapshot([mkChat('x', { selection: codexSel() })]))
  assert.equal(e.S().send('x', 'oi'), true)
  assert.equal(e.calls.codex.length, 1)
  assert.equal(e.S().runtime.x.local, true)
  assert.equal(e.hostCalls('send').length, 0)
})

hostTest('a local run ignores chat/patch/turn deltas and snapshots of that chat, but not remove', {}, async (e) => {
  e.useStore.setState({ remote: { id: 'r', ...SSH } })
  await e.boot(snapshot([sshChat(), mkChat('h')]))
  e.S().send('r1', 'oi')
  const mine = e.S().chats.find((c) => c.id === 'r1')
  e.follow.deltas([
    { op: 'chat', chat: sshChat({ title: 'HOST' }) },
    { op: 'patch', chatId: 'r1', patch: { title: 'HOST' } },
    { op: 'turn', chatId: 'r1', turn: { id: 'zzz', startedAt: 1, segments: [] } },
    { op: 'patch', chatId: 'h', patch: { title: 'H2' } }
  ], 2)
  assert.equal(e.S().chats.find((c) => c.id === 'r1'), mine)
  assert.equal(e.S().chats.find((c) => c.id === 'h').title, 'H2')
  // a snapshot keeps this window's copy and its runtime
  e.follow.snap(snapshot([sshChat({ title: 'SNAP' }), mkChat('h')], { r1: idle('old') }))
  assert.equal(e.S().chats.find((c) => c.id === 'r1').turns.length, 2)
  assert.equal(e.S().chats.find((c) => c.id === 'r1').title, mine.title)
  assert.equal(e.S().runtime.r1.local, true)
  assert.equal(e.S().runtime.r1.busy, true)
  e.follow.deltas([{ op: 'remove', chatId: 'r1' }], 3)
  assert.ok(!e.S().chats.some((c) => c.id === 'r1'))
})

hostTest('a finished local chat is the host document again (deltas apply)', {}, async (e) => {
  e.useStore.setState({ remote: { id: 'r', ...SSH } })
  await e.boot(snapshot([sshChat()]))
  e.S().send('r1', 'oi')
  e.claudeCbs.onAgentDone({ id: e.calls.claude[0].id })
  e.follow.deltas([{ op: 'patch', chatId: 'r1', patch: { title: 'HOST' } }], 2)
  assert.equal(e.S().chats[0].title, 'HOST')
})

hostTest('beforeunload flushes only the chats this window runs, without drafts', {}, async (e) => {
  e.useStore.setState({ remote: { id: 'r', ...SSH } })
  await e.boot(snapshot([sshChat(), mkChat('h')], { h: busy('th') }))
  const event = { prevented: false, preventDefault() { this.prevented = true } }
  e.windowEvents.beforeunload(event)
  assert.equal(e.calls.flush.length, 0, 'the host keeps its own chats; nothing local is pending')
  e.S().send('r1', 'oi')
  e.ctx.mock.timers.tick(0)
  e.windowEvents.beforeunload(event)
  assert.equal(e.calls.flush.length, 1)
  assert.deepEqual(e.calls.flush[0].map((c) => c.id), ['r1'])
  assert.ok(!('draft' in e.calls.flush[0][0]) && !('contextDraft' in e.calls.flush[0][0]))
  assert.equal(event.prevented, false)
  e.state.flushReply = { ok: false, error: 'disco cheio' }
  e.windowEvents.beforeunload(event)
  assert.equal(event.prevented, true)
  assert.ok(e.calls.toasts.some((m) => m.includes('disco cheio')))
})

// ---------- live effects ----------

const finalBatch = (chatId, turnId, turn = {}, nextRuntime = idle(turnId)) => [
  { op: 'turn', chatId, turn: { id: turnId, startedAt: 1, completedAt: 2, error: false, interrupted: false, provider: 'claude', segments: [], ...turn } },
  { op: 'patch', chatId, patch: { pendingTurnId: null } },
  { op: 'runtime', chatId, runtime: nextRuntime }
]
const running = (over = {}) => mkChat('c', { pendingTurnId: 't1', turns: [{ id: 't1', startedAt: 1, provider: 'claude', segments: [{ kind: 'tool', toolId: 'x', status: 'running' }] }], ...over })

hostTest('turn end (Claude, chat panel closed, unfocused): refresh, OS notification and the toast', {}, async (e) => {
  e.useStore.setState({ chatOpen: false })
  await e.boot(snapshot([running()], { c: busy('t1') }))
  e.follow.deltas(finalBatch('c', 't1'), 2)
  assert.equal(e.calls.bump, 1)
  assert.equal(e.calls.reload, 1)
  assert.deepEqual(e.calls.notify, [['Prism · tarefa concluída', 'title-c']])
  assert.deepEqual(e.calls.taskNotify, [['Claude · tarefa concluída', 'O agente terminou.']])
  assert.deepEqual(e.calls.toasts, ['✓ Claude terminou a tarefa'])
  assert.equal(e.S().chats[0].pendingTurnId, undefined)
})

hostTest('turn end: focused window, active chat, chat panel open → refresh only', { focus: true }, async (e) => {
  e.useStore.setState({ chatOpen: true })
  await e.boot(snapshot([running()], { c: busy('t1') }))
  e.follow.deltas(finalBatch('c', 't1'), 2)
  assert.equal(e.calls.bump, 1); assert.equal(e.calls.reload, 1)
  assert.deepEqual(e.calls.notify, [])
  assert.deepEqual(e.calls.taskNotify, [])
  assert.deepEqual(e.calls.toasts, [])
})

hostTest('turn end: notifies when unfocused or another chat is active, with the panel open and no toast', {}, async (e) => {
  e.useStore.setState({ chatOpen: true })
  await e.boot(snapshot([running(), mkChat('o', { updatedAt: 50 })], { c: busy('t1') }))
  assert.equal(e.S().activeId, 'o')
  e.follow.deltas(finalBatch('c', 't1'), 2)
  assert.equal(e.calls.notify.length, 1, 'another chat is active')
  assert.deepEqual(e.calls.toasts, [])
  assert.deepEqual(e.calls.taskNotify, [])
  e.S().select('c')
  e.follow.deltas([{ op: 'runtime', chatId: 'c', runtime: busy('t2') }], 3)
  e.follow.deltas(finalBatch('c', 't1'), 4)
  assert.equal(e.calls.notify.length, 2, 'unfocused')
})

for (const [name, turn] of [['an error', { error: true }], ['an interruption', { interrupted: true }]]) {
  hostTest(`turn end with ${name}: refresh but no notification, no toast`, {}, async (e) => {
    await e.boot(snapshot([running()], { c: busy('t1') }))
    e.follow.deltas(finalBatch('c', 't1', turn), 2)
    assert.equal(e.calls.bump, 1); assert.equal(e.calls.reload, 1)
    assert.deepEqual(e.calls.notify, [])
    assert.deepEqual(e.calls.taskNotify, [])
    assert.deepEqual(e.calls.toasts, [])
  })
}

hostTest('turn end on Codex: OS notification but no Claude toast', {}, async (e) => {
  const chat = running({ selection: codexSel(), turns: [{ id: 't1', startedAt: 1, segments: [] }] })
  await e.boot(snapshot([chat], { c: busy('t1') }))
  e.follow.deltas(finalBatch('c', 't1', { provider: 'codex' }), 2)
  assert.equal(e.calls.notify.length, 1)
  assert.deepEqual(e.calls.taskNotify, [])
  assert.deepEqual(e.calls.toasts, [])
})

hostTest('turn end with notifyOnDone off: refresh only', { notifyOnDone: false }, async (e) => {
  await e.boot(snapshot([running()], { c: busy('t1') }))
  e.follow.deltas(finalBatch('c', 't1'), 2)
  assert.equal(e.calls.bump, 1)
  assert.deepEqual(e.calls.notify, [])
  assert.deepEqual(e.calls.toasts, [])
})

hostTest('the turn is read from the same batch (final turn state arrives with the runtime)', {}, async (e) => {
  await e.boot(snapshot([running()], { c: busy('t1') }))
  // runtime first, final turn later in the same batch: the final turn still counts
  e.follow.deltas([
    { op: 'runtime', chatId: 'c', runtime: idle('t1') },
    { op: 'turn', chatId: 'c', turn: { id: 't1', startedAt: 1, completedAt: 2, error: true, interrupted: false, provider: 'claude', segments: [] } }
  ], 2)
  assert.deepEqual(e.calls.notify, [])
  assert.equal(e.calls.bump, 1)
})

hostTest('a runtime that was not busy, or goes busy → busy, triggers no end-of-turn effects', {}, async (e) => {
  await e.boot(snapshot([running()], { c: idle('t0') }))
  e.follow.deltas([{ op: 'runtime', chatId: 'c', runtime: idle('t0', { fast: { state: 'on' } }) }], 2)
  e.follow.deltas([{ op: 'runtime', chatId: 'c', runtime: busy('t1') }], 3)
  e.follow.deltas([{ op: 'runtime', chatId: 'c', runtime: busy('t1', { fast: { state: 'on' } }) }], 4)
  assert.equal(e.calls.bump, 0)
  assert.deepEqual(e.calls.notify, [])
})

hostTest('a new permission or question notifies once per id (notifyOnAsk)', {}, async (e) => {
  await e.boot(snapshot([running()], { c: busy('t1') }))
  const perm = (permId, extra = {}) => ({ op: 'runtime', chatId: 'c', runtime: busy('t1', { permission: { permId, toolName: 'Bash', ...extra } }) })
  e.follow.deltas([perm('p1', { title: 'Rodar ls' })], 2)
  e.follow.deltas([perm('p1', { title: 'Rodar ls' })], 3)
  e.follow.deltas([perm('p2')], 4)
  assert.deepEqual(e.calls.notify, [['Prism · permissão necessária', 'Rodar ls'], ['Prism · permissão necessária', 'Bash']])
  const ask = (dialogId, questions) => ({ op: 'runtime', chatId: 'c', runtime: busy('t1', { question: { dialogId, questions } }) })
  e.follow.deltas([ask('d1', [{ question: 'Qual?' }])], 5)
  e.follow.deltas([ask('d1', [{ question: 'Qual?' }])], 6)
  e.follow.deltas([ask('d2', [])], 7)
  assert.deepEqual(e.calls.notify.slice(2), [['Prism · resposta necessária', 'Qual?'], ['Prism · resposta necessária', 'O agente fez uma pergunta.']])
  assert.equal(e.calls.bump, 0)
})

hostTest('notifyOnAsk off: no notification for permissions or questions', { notifyOnAsk: false }, async (e) => {
  await e.boot(snapshot([running()], { c: busy('t1') }))
  e.follow.deltas([{ op: 'runtime', chatId: 'c', runtime: busy('t1', { permission: { permId: 'p1', toolName: 'Bash' } }) }], 2)
  e.follow.deltas([{ op: 'runtime', chatId: 'c', runtime: busy('t1', { question: { dialogId: 'd', questions: [{ question: 'Q' }] } }) }], 3)
  assert.deepEqual(e.calls.notify, [])
})

hostTest('a snapshot (reconnection) with the turn already finished triggers nothing', {}, async (e) => {
  await e.boot(snapshot([running()], { c: busy('t1', { permission: { permId: 'p1', toolName: 'Bash' } }) }))
  e.follow.snap(snapshot([mkChat('c', { turns: [{ id: 't1', startedAt: 1, completedAt: 2, provider: 'claude', segments: [] }] })], { c: idle('t1') }))
  assert.equal(e.S().runtime.c.busy, false)
  e.follow.snap(snapshot([mkChat('c', { turns: [] })], { c: busy('t9', { permission: { permId: 'pNEW', toolName: 'Bash' } }) }))
  assert.equal(e.calls.bump, 0); assert.equal(e.calls.reload, 0)
  assert.deepEqual(e.calls.notify, [])
  assert.deepEqual(e.calls.taskNotify, [])
  assert.deepEqual(e.calls.toasts, [])
})

// ---------- agentTasks in host mode ----------

const { create } = require('zustand')
async function taskScenario(mode, body) {
  const savedWindow = global.window
  const log = { toasts: [], setTask: [], save: [] }
  global.window = {
    prism: {
      tasks: { load: async () => ({ tasks: [], openIds: [], activeId: null }), save: async () => {}, flush: () => ({ ok: true }) },
      chats: { save: async (c) => { log.save.push(c.id) }, host: { setTask: async (...a) => { log.setTask.push(a); return body.reply ?? { ok: true } } } },
      terminal: { setCwd: async () => {} },
      ssh: { onStatus: () => {} }
    },
    addEventListener: () => {}
  }
  const useStore = create(() => ({
    folderPath: null, folderName: '', workspaceFolders: [], workspaceFile: null, tabs: [], activePath: null,
    sidebarView: 'explorer', workspaceView: 'agents', remote: null, pendingChatAttachment: null, pendingClose: null,
    settings: { recentRemotes: [] }, bumpTree: () => {}, addToast: (kind, msg) => log.toasts.push(msg), requestReconnect: () => {}
  }))
  const chat = { id: 'c1', cwd: '/p/proj', updatedAt: 1 }
  const useAgentChats = create((set) => ({ chats: [chat], activeId: null, mode, init: async () => {}, select: (id) => set({ activeId: id }), create: () => {} }))
  try {
    const { useAgentTasks } = load('src/renderer/src/lib/agentTasks.ts', { zustand: { create }, '../store': { useStore }, './agentChats': { useAgentChats } })
    await useAgentTasks.getState().init()
    return { log, chat, tasks: useAgentTasks.getState().tasks }
  } finally {
    await new Promise((r) => setTimeout(r, 450))
    global.window = savedWindow
  }
}

test('agentTasks in host mode assigns an orphan chat to a task with chats.host.setTask, not chats.save', async () => {
  const r = await taskScenario('host', {})
  assert.equal(r.log.setTask.length, 1)
  assert.equal(r.log.setTask[0][0], 'c1')
  assert.equal(r.log.setTask[0][1], r.chat.taskId)
  assert.ok(r.tasks.some((t) => t.id === r.chat.taskId && t.cwd === '/p/proj'))
  assert.deepEqual(r.log.save, [])
})

test('agentTasks in host mode toasts a refused setTask', async () => {
  const r = await taskScenario('host', { reply: { ok: false, code: 'invalid', error: 'recusado' } })
  assert.deepEqual(r.log.toasts, ['Falha ao salvar a tarefa do chat: recusado'])
})

test('agentTasks in ipc mode still uses chats.save', async () => {
  const r = await taskScenario('ipc', {})
  assert.deepEqual(r.log.save, ['c1'])
  assert.equal(r.log.setTask.length, 0)
})


hostTest('steer sends within the existing turn and removes only the accepted queue entry', {}, async e => {
  await e.boot(snapshot([mkChat('c')], { c: busy('live') }))
  const first = { text: 'first' }, target = { text: 'do this now', context: 'file.ts', images: [{ mime: 'image/png', data: 'aGVsbG8=' }] }
  e.S().enqueue('c', first); e.S().enqueue('c', target)
  assert.equal(await e.S().steerQueued('c', 1), true)
  const payload = e.hostCalls('steer')[0][1]
  assert.equal(payload.turnId, 'live'); assert.equal(payload.text, target.text)
  assert.deepEqual(payload.images, target.images.map(image => ({ ...image, number: 1 }))); assert.equal(payload.context, 'file.ts')
  assert.deepEqual(e.S().chats[0].queued, [first]); assert.equal(e.S().runtime.c.busy, true)
  assert.equal(e.hostCalls('send').length, 0); assert.equal(e.hostCalls('stop').length, 0)
})
hostTest('a failed steering request retains images/context and order, even while another message is appended', { reply: { steer: () => ({ ok: false, code: 'gone', error: 'Turn ended' }) } }, async e => {
  await e.boot(snapshot([mkChat('c')], { c: busy('live') }))
  const first = { text: 'first', images: [{ mime: 'image/png', data: 'x' }], context: 'context' }
  e.S().enqueue('c', first)
  const pending = e.S().steerQueued('c', 0)
  e.S().enqueue('c', { text: 'second' })
  assert.equal(await pending, false)
  assert.deepEqual(e.S().chats[0].queued, [{ ...first, images: first.images.map(image => ({ ...image, number: 1 })) }, { text: 'second' }])
  assert.equal(e.S().steering.c, undefined)
})
hostTest('stop can be retried after host refusal, and a completed reconnect clears stopping', { reply: { stop: () => ({ ok: false, code: 'disconnected', error: 'Disconnected' }) } }, async e => {
  await e.boot(snapshot([mkChat('c')], { c: busy('live') }))
  e.S().stop('c'); assert.equal(e.S().stopping.c, true)
  await tick(); assert.equal(e.S().stopping.c, false)
  e.S().stop('c'); assert.equal(e.hostCalls('stop').length, 2)
  e.follow.snap(snapshot([mkChat('c')], { c: idle('live') }, 3))
  assert.equal(e.S().stopping.c, undefined)
})

hostTest('queue resumes if a clean completion arrives before the steering acknowledgement', {}, async e => {
  let acknowledge
  global.window.prism.chats.host.steer = () => new Promise(resolve => { acknowledge = resolve })
  await e.boot(snapshot([mkChat('c', { turns: [{ id: 'live', role: 'assistant', text: '', segments: [], startedAt: 1 }] })], { c: busy('live') }))
  e.S().enqueue('c', { text: 'next' }); e.S().enqueue('c', { text: 'now' })
  const pending = e.S().steerQueued('c', 1)
  e.follow.deltas([{ op: 'turn', chatId: 'c', turn: { id: 'live', role: 'assistant', text: '', segments: [], startedAt: 1, completedAt: 2 } }, { op: 'runtime', chatId: 'c', runtime: idle('live') }], 2)
  assert.equal(e.hostCalls('send').length, 0)
  acknowledge({ ok: true }); assert.equal(await pending, true)
  assert.equal(e.hostCalls('send').length, 1)
  assert.equal(e.hostCalls('send')[0][1].text, 'next')
})
