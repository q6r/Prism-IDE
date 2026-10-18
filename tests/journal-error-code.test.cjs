const { test } = require('node:test')
const assert = require('node:assert/strict')
const load = require('./helpers/load-typescript.cjs')

// ---- foldJournal ----

const agents = load('src/shared/agents.ts')
const { foldJournal } = load('src/shared/agentJournal.ts', { './agents': agents, './subagents': load('src/shared/subagents.ts') })

const sel = { provider: 'claude', profileId: 'ambient-claude', model: 'opus', effort: 'high', permissionMode: 'default', serviceTier: '' }
const turn = (id) => ({ id, prompt: 'oi', startedAt: 1000, segments: [] })
const chat = (over = {}) => ({ id: 'c', title: 't', createdAt: 1, updatedAt: 1, selection: sel, cwd: '/w', turns: [turn('t1')], pendingTurnId: 't1', lastRunId: 't1', ...over })
const rec = (event, turnId = 't1') => ({ turnId, event })
const begin = rec({ kind: 'begin', turn: turn('t1'), route: 'claude:ambient-claude' })

test('foldJournal: erro com code grava errorCode', () => {
  const out = foldJournal(chat(), [begin, rec({ kind: 'error', message: 'Sem login', at: 2000, code: 'cli_auth' })])
  const t = out.turns[0]
  assert.equal(t.errorCode, 'cli_auth')
  assert.equal(t.error, true)
  assert.equal(t.segments.at(-1).text, 'Sem login')
  assert.equal(out.pendingTurnId, undefined)
})

test('foldJournal: erro sem code ou com code vazio não grava errorCode', () => {
  for (const code of [undefined, '']) {
    const out = foldJournal(chat(), [begin, rec({ kind: 'error', message: 'x', at: 2000, code })])
    assert.equal(out.turns[0].error, true)
    assert.equal('errorCode' in out.turns[0], false)
  }
})

test('foldJournal: done não grava errorCode', () => {
  const out = foldJournal(chat(), [begin, rec({ kind: 'done', at: 2000 })])
  assert.equal(out.turns[0].error, false)
  assert.equal('errorCode' in out.turns[0], false)
})

test('foldJournal: um begin repetido zera o errorCode', () => {
  const out = foldJournal(chat(), [begin, rec({ kind: 'error', message: 'x', code: 'cli_auth' }), begin])
  assert.equal('errorCode' in out.turns[0], false)
  assert.deepEqual(out.turns[0].segments, [])
})

// ---- agentChats (caminho IPC) ----

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

const mkChat = (id, over = {}) => ({ id, title: 't', createdAt: 1, updatedAt: 1, turns: [], selection: sel, cwd: 'C:\\w', ...over })
const CLAUDE_EVENTS = ['onAgentSystem', 'onAgentText', 'onAgentThinking', 'onAgentTool', 'onAgentToolResult',
  'onAgentPermission', 'onAgentQuestion', 'onAgentResult', 'onAgentDone', 'onAgentError']

function env(initialProfiles = [{ id: 'p0' }]) {
  const calls = { claude: [], toasts: [], listed: 0 }
  const cbs = {}
  const changed = []
  global.localStorage = { getItem: () => null, setItem() {} }
  global.document = { hasFocus: () => true }
  global.window = {
    addEventListener() {},
    prism: {
      chats: { save: async () => true, delete: async () => true, list: async () => [mkChat('a')], flush: () => ({ ok: true }) },
      providers: { list: async () => { calls.listed++; return initialProfiles }, onChanged: (cb) => { changed.push(cb); return () => undefined } },
      claude: { agentSend: (p) => calls.claude.push(p), ...Object.fromEntries(CLAUDE_EVENTS.map((n) => [n, (cb) => { cbs[n] = cb }])) },
      codex: { send() {}, onEvent() {} },
      app: { notify() {} }
    }
  }
  const zustand = fakeZustand()
  const useStore = zustand.create(() => ({
    settings: { model: 'sonnet', notifyOnDone: false }, remote: undefined, chatOpen: true,
    addToast: (kind, msg) => calls.toasts.push(msg), bumpTree() {}, reloadOpenFiles: async () => {}
  }))
  const mod = load('src/renderer/src/lib/agentChats.ts', {
    '../../../shared/subagents': load('src/shared/subagents.ts'),
    './asyncQuestions': load('src/renderer/src/lib/asyncQuestions.ts'),
    '../../../shared/imageReferences': load('src/shared/imageReferences.ts'),
    zustand, '../../../shared/agents': agents, '../../../shared/providerUsage': load('src/shared/providerUsage.ts'),
    '../../../shared/chatDeltas': load('src/shared/chatDeltas.ts'), './notify': { notifyTaskDone() {} },
    '../store': { useStore }, './agentTasks': { useAgentTasks: { getState: () => ({ activeId: undefined, activate() {} }), setState() {} } },
    './modelCatalog': load('src/renderer/src/lib/modelCatalog.ts', { zustand })
  })
  const chats = mod.useAgentChats
  return { S: () => chats.getState(), calls, cbs, changed }
}

async function failedTurn(result) {
  const e = env()
  await e.S().init()
  assert.equal(e.S().send('a', 'oi'), true)
  const id = e.calls.claude[0].id
  e.cbs.onAgentResult({ id, sessionId: 's', ...result })
  await new Promise((r) => setImmediate(r))
  return { e, turn: e.S().chats.find((c) => c.id === 'a').turns.at(-1) }
}

test('onAgentResult com isError e code string grava errorCode', async () => {
  const { turn } = await failedTurn({ isError: true, resultText: 'Faça login', code: 'cli_auth' })
  assert.equal(turn.errorCode, 'cli_auth')
  assert.equal(turn.error, true)
  assert.equal(turn.segments.at(-1).text, 'Faça login')
})

test('onAgentResult com isError sem code, ou code não-string, não grava errorCode', async () => {
  for (const extra of [{}, { code: 5 }, { code: null }]) {
    const { turn } = await failedTurn({ isError: true, resultText: 'ruim', ...extra })
    assert.equal(turn.error, true)
    assert.equal('errorCode' in turn, false)
  }
})

test('onAgentResult sem erro não grava errorCode mesmo com code', async () => {
  const { turn } = await failedTurn({ isError: false, resultText: 'ok', code: 'cli_auth' })
  assert.notEqual(turn.error, true)
  assert.equal('errorCode' in turn, false)
})

test('init assina providers.onChanged; a lista recebida vira o estado sem chamar providers.list', async () => {
  const e = env([{ id: 'p0' }])
  await e.S().init()
  assert.equal(e.changed.length, 1)
  assert.deepEqual(e.S().profiles, [{ id: 'p0' }])
  const before = e.calls.listed
  e.changed[0]([{ id: 'p1' }, { id: 'p2' }])
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(e.S().profiles, [{ id: 'p1' }, { id: 'p2' }])
  assert.equal(e.calls.listed, before)
})

test('refreshProfiles sem lista consulta providers.list', async () => {
  const e = env([{ id: 'p0' }])
  await e.S().init()
  const before = e.calls.listed
  await e.S().refreshProfiles()
  assert.equal(e.calls.listed, before + 1)
  await e.S().refreshProfiles([{ id: 'z' }])
  assert.equal(e.calls.listed, before + 1)
  assert.deepEqual(e.S().profiles, [{ id: 'z' }])
})

test('init funciona sem providers.onChanged (optional chaining)', async () => {
  const e = env()
  delete global.window.prism.providers.onChanged
  await e.S().init()
  assert.equal(e.S().ready, true)
})
