// Renderer store regressions with the same fresh-module/fake-Zustand harness
// as agent-chats-host.test.cjs. No Electron, native process or account is used.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const load = require('./helpers/load-typescript.cjs')

function fakeZustand() {
  return { create: init => {
    let state
    const set = patch => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) } }
    const get = () => state
    state = init(set, get)
    const hook = () => state
    hook.getState = get
    hook.setState = set
    return hook
  } }
}

const CAPS = ['chats@1', 'codex@1', 'claude@1', 'chats.subagents.message@1']
const callbacks = ['onAgentSystem', 'onAgentText', 'onAgentThinking', 'onAgentTool', 'onAgentToolResult', 'onAgentSubagent', 'onAgentPermission', 'onAgentQuestion', 'onAgentResult', 'onAgentDone', 'onAgentError']
function documents(provider = 'codex') {
  const selection = { provider, profileId: `ambient-${provider}`, model: 'child-model', permissionMode: 'default' }
  const nativeAgent = { id: 'native-child', rootChatId: 'parent', rootTurnId: 'original-parent-turn', status: 'completed', messageTarget: 'direct', updatedAt: 1 }
  const parent = { id: 'parent', title: 'Parent', cwd: 'C:\\QA', createdAt: 1, updatedAt: 1, selection: { ...selection, model: 'parent-model' },
    resume: { route: `${provider}:ambient-${provider}`, sessionId: 'native-parent-thread' },
    turns: [{ id: 'original-parent-turn', role: 'assistant', text: 'Parent output', segments: [{ kind: 'tool', toolId: 'spawn', name: 'Agent', status: 'done', subagent: { id: nativeAgent.id, chatId: 'child', status: 'completed' } }] },
      { id: 'second-parent-turn', role: 'assistant', text: 'Another parent turn', segments: [] }] }
  const child = { id: 'child', title: 'Child', cwd: 'C:\\QA', createdAt: 1, updatedAt: 2, selection, readOnly: true, sourceHarness: provider,
    parentChatId: 'parent', nativeAgent, draft: 'Rascunho preservado', contextDraft: 'context.ts',
    turns: [{ id: 'child-turn', role: 'assistant', text: '', segments: [{ kind: 'text', toolId: 'answer', text: 'Child output' }] }] }
  return [parent, child]
}

async function setup(ctx, options = {}) {
  ctx.mock.timers.enable({ apis: ['setTimeout'] })
  const o = { host: false, caps: CAPS, provider: 'codex', reply: async () => ({ delivery: 'direct', nativeTurnId: 'child-native-turn', steered: true }), ...options }
  const docs = documents(o.provider), calls = { host: [], codex: [], claude: [], saves: [], toasts: [] }, storage = new Map()
  global.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }
  global.window = { addEventListener() {}, prism: {
    chats: { hostOwned: async () => o.host, list: async () => [], save: async chat => { calls.saves.push(chat); return true }, flush: () => ({ ok: true }),
      host: { follow: onSnapshot => { onSnapshot({ rev: 1, chats: docs, runtime: { parent: { busy: true, turnId: 'second-parent-turn', route: `${o.provider}:ambient-${o.provider}` } } }); return () => {} },
        messageSubagent: async (...args) => { calls.host.push(args); return o.reply(...args) }, put: async () => ({ ok: true }) } },
    host: { onStatus: cb => { cb({ state: 'connected', hello: { capabilities: o.caps } }); return () => {} }, capabilities: () => o.caps },
    providers: { list: async () => [] },
    codex: { onEvent() {}, messageSubagent: async payload => { calls.codex.push(payload); return o.reply(payload) } },
    claude: { ...Object.fromEntries(callbacks.map(name => [name, () => {}])), agentMessageSubagent: async payload => { calls.claude.push(payload); return o.reply(payload) } }
  } }
  const zustand = fakeZustand()
  const useStore = zustand.create(() => ({ settings: { notifyOnDone: false, notifyOnAsk: false },
    addToast: (kind, message) => calls.toasts.push({ kind, message }) }))
  const catalog = load('src/renderer/src/lib/modelCatalog.ts', { zustand })
  const { useAgentChats } = load('src/renderer/src/lib/agentChats.ts', {
    zustand, '../../../shared/agents': load('src/shared/agents.ts'), '../../../shared/providerUsage': load('src/shared/providerUsage.ts'),
    '../../../shared/chatDeltas': load('src/shared/chatDeltas.ts'), '../../../shared/subagents': load('src/shared/subagents.ts'),
    '../../../shared/imageReferences': load('src/shared/imageReferences.ts'), './asyncQuestions': load('src/renderer/src/lib/asyncQuestions.ts'),
    './notify': { notifyTaskDone() {} }, '../store': { useStore }, './agentTasks': { useAgentTasks: { getState: () => ({}), setState() {} } }, './modelCatalog': catalog
  })
  if (o.host) await useAgentChats.getState().init()
  else useAgentChats.setState({ mode: 'ipc', ready: true, chats: docs, runtime: { parent: { busy: true, turnId: 'second-parent-turn', route: `${o.provider}:ambient-${o.provider}` } } })
  return { o, docs, calls, store: useAgentChats, state: () => useAgentChats.getState(), child: () => useAgentChats.getState().chats.find(chat => chat.id === 'child') }
}

test('subagent host sends target child id/text and leaves transcript echo to host deltas', async ctx => {
  const f = await setup(ctx, { host: true, reply: async () => ({ ok: true, delivery: 'direct' }) })
  const parent = structuredClone(f.state().chats.find(chat => chat.id === 'parent'))
  const before = structuredClone(f.child())
  assert.equal(await f.state().messageSubagent('child', '  Confira os testes  '), true)
  assert.deepEqual(f.calls.host, [['child', 'Confira os testes']])
  assert.equal(f.calls.codex.length + f.calls.claude.length, 0)
  assert.deepEqual(f.child(), before, 'no duplicate optimistic user echo before the authoritative host delta')
  assert.deepEqual(f.state().chats.find(chat => chat.id === 'parent'), parent)
  assert.equal(f.state().runtime.parent.turnId, 'second-parent-turn')
  assert.equal(f.state().subagentSending.child, false)
})

for (const provider of ['codex', 'claude']) test(`subagent IPC ${provider} addresses native root/origin/child and echoes only into child history`, async ctx => {
  const f = await setup(ctx, { provider })
  const parent = structuredClone(f.state().chats.find(chat => chat.id === 'parent'))
  const native = structuredClone(f.child().nativeAgent), selection = structuredClone(f.child().selection)
  assert.equal(await f.state().messageSubagent('child', '  Reveja esta parte  '), true)
  assert.deepEqual(f.calls[provider], [{ rootChatId: 'parent', rootTurnId: 'original-parent-turn', agentId: 'native-child', text: 'Reveja esta parte' }])
  assert.equal(f.calls.host.length, 0)
  const echoes = f.child().turns.flatMap(turn => turn.segments || []).filter(segment => segment.kind === 'user')
  assert.equal(echoes.length, 1)
  assert.equal(echoes[0].text, 'Reveja esta parte')
  assert.ok(echoes[0].toolId); assert.equal(typeof echoes[0].sentAt, 'number')
  assert.deepEqual(f.child().nativeAgent, native)
  assert.deepEqual(f.child().selection, selection)
  assert.equal(f.child().parentChatId, 'parent'); assert.equal(f.child().readOnly, true)
  assert.deepEqual(f.state().chats.find(chat => chat.id === 'parent'), parent)
  assert.equal(f.state().runtime.parent.turnId, 'second-parent-turn')
})

for (const provider of ['codex', 'claude']) test(`resumed ${provider} child uses current control aliases while a delayed acknowledgement echoes into its exact native generation`, async ctx => {
  const f = await setup(ctx, { provider, reply: async () => ({ delivery: 'direct', nativeTurnId: 'old-native-turn', steered: true }) })
  f.store.setState(state => ({
    chats: state.chats.map(chat => chat.id !== 'child' ? chat : { ...chat,
      nativeAgent: { ...chat.nativeAgent, id: 'historical-native-child', rootTurnId: 'historical-root-origin',
        controlId: 'resumed-native-child', controlTurnId: 'current-control-origin', turnId: 'child-generation-2', generation: 2,
        nativeTurns: { 'old-native-turn': 'child-generation-1', 'current-native-turn': 'child-generation-2' } },
      pendingTurnId: 'child-generation-2',
      turns: [{ id: 'child-generation-1', role: 'assistant', text: '', segments: [{ kind: 'text', text: 'Old child result' }] },
        { id: 'child-generation-2', role: 'assistant', text: '', segments: [{ kind: 'text', text: 'Current child output' }] }] }),
    runtime: { ...state.runtime, child: { busy: true, turnId: 'child-generation-2', route: `${provider}:ambient-${provider}` } }
  }))
  const parent = structuredClone(f.state().chats.find(chat => chat.id === 'parent'))
  const native = structuredClone(f.child().nativeAgent)
  const latest = structuredClone(f.child().turns[1])
  assert.equal(await f.state().messageSubagent('child', 'Mensagem da geração anterior'), true)
  assert.deepEqual(f.calls[provider], [{ rootChatId: 'parent', rootTurnId: 'current-control-origin', agentId: 'resumed-native-child', text: 'Mensagem da geração anterior' }])
  assert.equal(f.child().turns[0].segments.at(-1).kind, 'user')
  assert.equal(f.child().turns[0].segments.at(-1).text, 'Mensagem da geração anterior')
  assert.deepEqual(f.child().turns[1], latest, 'nativeTurnId mapping takes precedence over the current/admitted generation')
  assert.deepEqual(f.child().nativeAgent, native, 'historical identity and current control aliases remain unchanged')
  assert.deepEqual(f.state().chats.find(chat => chat.id === 'parent'), parent)
  assert.equal(f.state().runtime.parent.turnId, 'second-parent-turn')
})

test('subagent parent-mediated delivery confirms forwarding without inventing a child inbox echo', async ctx => {
  const f = await setup(ctx, { provider: 'claude', reply: async () => ({ delivery: 'parent' }) })
  const before = structuredClone(f.child())
  assert.equal(await f.state().messageSubagent('child', 'Verifique o log'), true)
  assert.deepEqual(f.child(), before, 'only the real native peer inbox event may echo this forwarded message into the child')
  assert.match(f.calls.toasts.at(-1).message, /agente principal/)
})

test('subagent host refusal and native transport failure preserve drafts and child history for retry', async ctx => {
  const f = await setup(ctx, { host: true, reply: async () => ({ ok: false, code: 'gone', error: 'Subagente desconectado' }) })
  const before = structuredClone(f.child())
  assert.equal(await f.state().messageSubagent('child', 'Rascunho preservado'), false)
  assert.deepEqual(f.child(), before)
  assert.equal(f.state().subagentSending.child, false)
  assert.deepEqual(f.calls.toasts.at(-1), { kind: 'error', message: 'Subagente desconectado' })
  f.store.setState({ mode: 'ipc' })
  f.o.reply = async () => { throw new Error('Codex desconectado') }
  assert.equal(await f.state().messageSubagent('child', 'Rascunho preservado'), false)
  assert.deepEqual(f.child(), before)
  assert.equal(f.state().subagentSending.child, false)
})

test('subagent duplicate in-flight delivery is blocked and a failed attempt releases the lock', async ctx => {
  let reject
  const f = await setup(ctx, { reply: () => new Promise((resolve, fail) => { reject = fail }) })
  const first = f.state().messageSubagent('child', 'Mensagem única')
  assert.equal(f.state().subagentSending.child, true)
  assert.equal(await f.state().messageSubagent('child', 'Duplicada'), false)
  assert.equal(f.calls.codex.length, 1)
  reject(new Error('Falhou'))
  assert.equal(await first, false)
  assert.equal(f.state().subagentSending.child, false)
  assert.equal(f.child().turns[0].segments.filter(segment => segment.kind === 'user').length, 0)
  f.o.reply = async () => ({ delivery: 'direct' })
  assert.equal(await f.state().messageSubagent('child', 'Mensagem única'), true)
  assert.equal(f.calls.codex.length, 2)
  assert.equal(f.child().turns[0].segments.filter(segment => segment.kind === 'user').length, 1)
})

test('subagent missing capability, unknown targets, ordinary chats and empty input never issue a send', async ctx => {
  const f = await setup(ctx, { host: true, caps: CAPS.filter(cap => cap !== 'chats.subagents.message@1') })
  assert.equal(await f.state().messageSubagent('child', 'Mensagem'), false)
  assert.match(f.calls.toasts.at(-1).message, /Atualize o host/)
  assert.equal(await f.state().messageSubagent('missing', 'Mensagem'), false)
  assert.equal(await f.state().messageSubagent('parent', 'Mensagem'), false)
  assert.equal(await f.state().messageSubagent('child', '  '), false)
  assert.equal(f.calls.host.length + f.calls.codex.length + f.calls.claude.length, 0)
})
