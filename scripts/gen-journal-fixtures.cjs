#!/usr/bin/env node
// Generates the journal fixtures the Rust host checks its fold and importer
// against (host/crates/prism-store/tests): every expected value here comes
// from the TypeScript implementation, so `cargo test` proves the Rust port
// gives the same chats.
//
//   node scripts/gen-journal-fixtures.cjs           write host/fixtures/journal/*.json
//   node scripts/gen-journal-fixtures.cjs --check   exit 1 if the files are stale
//
// - scenarios.json: hand-written journals for each rule of foldJournal;
// - random.json: seeded random journals (all event kinds, unknown turns,
//   route switches, JavaScript corner values);
// - repository-v02.json: the raw rows a real AgentRepository (node:sqlite)
//   leaves in prism-agents.db, including a turn still running at "crash"
//   time, and what the repository returns when reopened. The Rust tests
//   rebuild that database and import it.
//
// Deterministic: the clock is faked while the repository runs.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, 'host', 'fixtures', 'journal')
const load = require(path.join(ROOT, 'tests', 'helpers', 'load-typescript.cjs'))

const agents = load('src/shared/agents.ts')
const journal = load('src/shared/agentJournal.ts', { './agents': agents, './subagents': load('src/shared/subagents.ts') })
const { foldJournal } = journal

/** A JSON round trip: what the database stores and the Rust side reads. */
const rt = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

function foldCase(name, chat, records) {
  const input = { chat: rt(chat), records: rt(records) }
  const expected = rt(foldJournal(rt(input.chat), rt(input.records)))
  return { name, ...input, expected }
}

// ---- hand-written scenarios ----

const selection = { provider: 'claude', profileId: 'work', model: 'opus', effort: 'high', permissionMode: 'default' }
const baseChat = (extra = {}) => ({
  id: 'chat', title: 'Conversa', cwd: 'C:\\QA', selection,
  turns: [
    { id: 'u1', role: 'user', text: 'Olá' },
    { id: 't1', role: 'assistant', text: '', segments: [] }
  ],
  updatedAt: 1000, pendingTurnId: 't1', lastRunId: 't1', ...extra
})
const begin = (turnId, turn = {}, route = 'claude:work') => ({ turnId, event: { kind: 'begin', turn: { id: turnId, role: 'assistant', text: '', startedAt: 1000, ...turn }, route } })
const ev = (turnId, event) => ({ turnId, event })

function scenarios() {
  const cases = []
  cases.push(foldCase('text and thinking merge into the last segment of the same kind', baseChat(), [
    begin('t1'),
    ev('t1', { kind: 'thinking', text: 'Pensando' }), ev('t1', { kind: 'thinking', text: '…' }),
    ev('t1', { kind: 'text', text: 'ação' }), ev('t1', { kind: 'text', text: '🙂' }),
    ev('t1', { kind: 'thinking', text: 'de novo' }), ev('t1', { kind: 'text', text: 'fim' })
  ]))
  cases.push(foldCase('tool snapshots replace by toolId, segments without toolId append', baseChat(), [
    begin('t1'),
    ev('t1', { kind: 'segment', segment: { kind: 'tool', toolId: 'bash', name: 'Bash', status: 'running', input: { command: 'ls' } } }),
    ev('t1', { kind: 'segment', segment: { kind: 'tool', name: 'Note', status: 'done' } }),
    ev('t1', { kind: 'segment', segment: { kind: 'tool', toolId: 'bash', name: 'Bash', status: 'done', input: { command: 'ls' }, result: 'a\nb' } }),
    ev('t1', { kind: 'segment', segment: { kind: 'tool', toolId: '', name: 'Empty id appends' } }),
    ev('t1', { kind: 'done', at: 4000 })
  ]))
  cases.push(foldCase('codex message snapshots then a text delta appends to the snapshot', baseChat({ selection: { ...selection, provider: 'codex', profileId: 'ambient-codex' } }), [
    begin('t1', {}, 'codex:ambient-codex'),
    ev('t1', { kind: 'segment', segment: { kind: 'text', toolId: 'message', text: 'Parcial' } }),
    ev('t1', { kind: 'segment', segment: { kind: 'text', toolId: 'message', text: 'Parcial e final' } }),
    ev('t1', { kind: 'text', text: ' + delta' }),
    ev('t1', { kind: 'done' })
  ]))
  cases.push(foldCase('metrics merge shallowly, turn usage replaced', baseChat(), [
    begin('t1', { metrics: { scope: 'session', inputTokens: 1, model: 'old' } }),
    ev('t1', { kind: 'metrics', metrics: { scope: 'session', outputTokens: 5, turn: { inputTokens: 3 } } }),
    ev('t1', { kind: 'metrics', metrics: { scope: 'session', inputTokens: 10, costUsd: 0.0123, turn: { outputTokens: 2 } } }),
    ev('t1', { kind: 'done', at: 2500 })
  ]))
  cases.push(foldCase('session on the current route sets resume and survives done', baseChat({ resume: { route: 'claude:work', sessionId: 'older' } }), [
    begin('t1'), ev('t1', { kind: 'session', sessionId: 'native-1' }), ev('t1', { kind: 'text', text: 'ok' }), ev('t1', { kind: 'done', at: 2000 })
  ]))
  cases.push(foldCase('route switched: session ignored and resume kept on error', baseChat({ resume: { route: 'claude:work', sessionId: 'kept' }, selection: { ...selection, profileId: 'personal' } }), [
    begin('t1'), ev('t1', { kind: 'session', sessionId: 'ignored' }), ev('t1', { kind: 'error', message: 'Rate limit', at: 1500 })
  ]))
  cases.push(foldCase('error on the current route clears resume and settles running tools as error', baseChat(), [
    begin('t1'), ev('t1', { kind: 'session', sessionId: 's' }),
    ev('t1', { kind: 'segment', segment: { kind: 'tool', toolId: 'w', name: 'Write', status: 'running' } }),
    ev('t1', { kind: 'segment', segment: { kind: 'tool', toolId: 'q', name: 'AskUserQuestion', status: 'awaiting' } }),
    ev('t1', { kind: 'segment', segment: { kind: 'tool', toolId: 'd', name: 'Read', status: 'denied' } }),
    ev('t1', { kind: 'error', message: 'Falhou: ação 🙂', at: 1800 })
  ]))
  cases.push(foldCase('aborted done marks interrupted, clears resume and pending', baseChat(), [
    begin('t1'), ev('t1', { kind: 'session', sessionId: 's' }),
    ev('t1', { kind: 'segment', segment: { kind: 'tool', toolId: 'b', status: 'running' } }),
    ev('t1', { kind: 'done', aborted: true, at: 1200 })
  ]))
  cases.push(foldCase('done without at keeps the turn completedAt; no startedAt means no duration', baseChat({ lastRunId: undefined }), [
    begin('t1', { startedAt: undefined, completedAt: 7777 }), ev('t1', { kind: 'text', text: 'x' }), ev('t1', { kind: 'done', at: 0 })
  ]))
  cases.push(foldCase('done before startedAt clamps duration to zero', baseChat(), [
    begin('t1', { startedAt: 5000 }), ev('t1', { kind: 'done', at: 4000 })
  ]))
  cases.push(foldCase('events before begin and for unknown turns are ignored', baseChat(), [
    ev('t1', { kind: 'text', text: 'too early' }),
    ev('ghost', { kind: 'session', sessionId: 'ghost' }),
    begin('ghost'), ev('ghost', { kind: 'text', text: 'not in chat.turns' }),
    begin('t1'), ev('t1', { kind: 'text', text: 'kept' }),
    ev('t1', { kind: 'mystery', text: 'unknown kind' })
  ]))
  cases.push(foldCase('pendingTurnId only cleared by its own turn', {
    ...baseChat({ pendingTurnId: 't2', lastRunId: 't2' }),
    turns: [{ id: 'u1', role: 'user', text: 'a' }, { id: 't1', role: 'assistant', text: '' }, { id: 'u2', role: 'user', text: 'b' }, { id: 't2', role: 'assistant', text: '' }]
  }, [
    begin('t1'), ev('t1', { kind: 'done', at: 1100 }),
    begin('t2', { startedAt: 2000 }), ev('t2', { kind: 'text', text: 'running' })
  ]))
  cases.push(foldCase('a second begin restarts the turn', baseChat(), [
    begin('t1'), ev('t1', { kind: 'text', text: 'first attempt' }), ev('t1', { kind: 'error', message: 'x', at: 1100 }),
    begin('t1', { startedAt: 3000, model: 'retry' }), ev('t1', { kind: 'text', text: 'second' }), ev('t1', { kind: 'done', at: 3500 })
  ]))
  cases.push(foldCase('turn fields and unknown chat fields pass through', baseChat({ draft: 'rascunho', traycerSource: { root: 'C:\\x', epicId: 'e', chatId: 'c' }, custom: { nested: [1, 2] } }), [
    begin('t1', { provider: 'claude', profileName: 'Trabalho', extra: { keep: true }, segments: [{ kind: 'text', text: 'dropped by begin' }] }),
    ev('t1', { kind: 'text', text: 'novo' })
  ]))
  cases.push(foldCase('JavaScript corners: undefined text appends "undefined", missing message, numeric text', baseChat(), [
    begin('t1'), ev('t1', { kind: 'text', text: 'a' }), ev('t1', { kind: 'text' }), ev('t1', { kind: 'text', text: 42 }),
    ev('t1', { kind: 'thinking' }), ev('t1', { kind: 'error' })
  ]))
  cases.push(foldCase('no journal leaves the chat as is', baseChat({ resume: { route: 'claude:work', sessionId: 's' } }), []))
  cases.push(foldCase('error with code cli_auth keeps it as the turn errorCode', baseChat(), [
    begin('t1'), ev('t1', { kind: 'session', sessionId: 's' }), ev('t1', { kind: 'text', text: 'Começando' }),
    ev('t1', { kind: 'error', message: 'Sua sessão expirou. Entre novamente.', at: 1900, code: 'cli_auth' })
  ]))
  cases.push(foldCase('a retried turn starts without errorCode; an empty code is not kept', baseChat(), [
    begin('t1'), ev('t1', { kind: 'error', message: 'Login expirado', at: 1100, code: 'cli_auth' }),
    begin('t1', { startedAt: 2000 }), ev('t1', { kind: 'error', message: 'Outra falha', at: 2500, code: '' })
  ]))
  return cases
}

// ---- seeded random journals ----

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randomCases(seed, count) {
  const rand = mulberry32(seed)
  const int = (n) => Math.floor(rand() * n)
  const pick = (list) => list[int(list.length)]
  const maybe = (p, value) => (rand() < p ? value : undefined)
  const texts = ['a', 'ação', '🙂', ' ', '\n', 'linha\ncom quebra', 'Ünïcødé', '"aspas"', '']
  const statuses = ['running', 'done', 'error', 'denied', 'awaiting', undefined]
  const routes = ['claude:p1', 'claude:p2', 'codex:p1', 'codex:p2', undefined]
  const cases = []
  for (let n = 0; n < count; n++) {
    const turnCount = 1 + int(4)
    const turns = []
    for (let i = 0; i < turnCount; i++) {
      turns.push({ id: `u${i}`, role: 'user', text: pick(texts) })
      turns.push({ id: `t${i}`, role: 'assistant', text: '', ...(rand() < 0.3 ? { segments: [{ kind: 'text', text: 'stored' }] } : {}) })
    }
    const ids = turns.filter((t) => t.role === 'assistant').map((t) => t.id).concat(['ghost'])
    const chat = {
      id: `chat-${n}`, title: `Caso ${n}`, cwd: 'C:\\QA', updatedAt: 1000 + int(1000),
      selection: { provider: pick(['claude', 'codex']), profileId: pick(['p1', 'p2']), model: 'm', effort: 'high', permissionMode: 'default' },
      turns,
      resume: maybe(0.4, { route: pick(routes) || 'claude:p1', sessionId: 'old' }),
      pendingTurnId: maybe(0.6, pick(ids)),
      lastRunId: maybe(0.8, pick(ids))
    }
    const records = []
    const length = int(30)
    for (let i = 0; i < length; i++) {
      const turnId = pick(ids)
      const roll = rand()
      let event
      if (roll < 0.15) {
        event = { kind: 'begin', route: pick(routes), turn: {
          id: turnId, role: 'assistant', text: '', startedAt: maybe(0.8, 1000 + int(5000)), completedAt: maybe(0.2, 2000 + int(5000)),
          model: maybe(0.5, pick(['opus', 'gpt'])), metrics: maybe(0.3, { scope: 'session', inputTokens: int(100) }), extra: maybe(0.2, { k: int(9) })
        } }
      } else if (roll < 0.35) event = { kind: pick(['text', 'thinking']), text: maybe(0.97, pick(texts)) }
      else if (roll < 0.45) event = { kind: 'metrics', metrics: { scope: 'session', inputTokens: maybe(0.7, int(1000)), outputTokens: maybe(0.7, int(1000)), costUsd: maybe(0.4, Math.round(rand() * 10000) / 100000), turn: maybe(0.5, { inputTokens: int(50) }), model: maybe(0.3, 'opus') } }
      else if (roll < 0.7) event = { kind: 'segment', segment: {
        kind: pick(['text', 'tool', 'thinking']), toolId: maybe(0.7, pick(['message', 'bash', 'write', 'read', ''])), name: maybe(0.6, pick(['Bash', 'Write'])),
        status: pick(statuses), text: maybe(0.5, pick(texts)), input: maybe(0.3, { command: pick(texts) }), result: maybe(0.3, pick(texts)), resultIsError: maybe(0.1, true)
      } }
      else if (roll < 0.78) event = { kind: 'session', sessionId: `s${int(5)}` }
      else if (roll < 0.88) event = { kind: 'done', aborted: maybe(0.4, rand() < 0.7), at: pick([undefined, 0, 2000 + int(9000)]) }
      else if (roll < 0.96) event = { kind: 'error', message: maybe(0.9, pick(texts)), at: pick([undefined, 0, 2000 + int(9000)]) }
      else event = { kind: pick(['mystery', 'permission']), detail: int(5) }
      records.push({ turnId, event })
    }
    cases.push(foldCase(`random seed ${seed} #${n}`, chat, records))
  }
  return cases
}

// ---- a real AgentRepository database ----

function repositoryFixture() {
  const { DatabaseSync } = require('node:sqlite')
  const { AgentRepository } = load('src/main/agentRepository.ts', { 'node:sqlite': { DatabaseSync }, fs, path, '../shared/agentJournal': journal, '../shared/subagents': load('src/shared/subagents.ts') })
  const realNow = Date.now
  let clock = 1_760_000_000_000
  Date.now = () => (clock += 7)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-journal-fixture-'))
  const file = path.join(dir, 'prism-agents.db')
  try {
    const legacy = { get: (key) => (key === 'profiles'
      ? [
          { id: 'ambient-claude', provider: 'claude', name: 'Conta do terminal', ambient: true },
          { id: 'traycer-0123', provider: 'claude', name: 'Traycer Max', credentialLink: { root: 'C:\\Users\\qa\\.traycer', providerId: 'anthropic', profileId: 'acc-1' } },
          { id: 'work', provider: 'codex', name: 'Trabalho', color: '#55aaff' }
        ]
      : []) }
    let repo = new AgentRepository(file, legacy)
    repo.set('tasks', [{ id: 'task-1', title: 'Projeto', cwd: 'C:\\QA', updatedAt: 5, editor: { tabs: [{ path: 'C:\\QA\\a.ts', content: 'NÃO SALVO' }] } }])
    repo.writeState('task-tabs', { openIds: ['task-1'], activeId: 'task-1' })

    const chat = (id, provider, profileId, turns) => ({
      id, title: `Conversa ${id}`, taskId: 'task-1', cwd: 'C:\\QA', updatedAt: 10, createdAt: 9,
      selection: { provider, profileId, model: provider === 'claude' ? 'opus' : 'gpt-5', effort: 'high', permissionMode: 'default' }, turns
    })
    // Completed Claude turn, then a Codex-style second turn with coalesced snapshots.
    const a = chat('chat-a', 'claude', 'traycer-0123', [{ id: 'a-u1', role: 'user', text: 'Explique' }, { id: 'a-t1', role: 'assistant', text: '', segments: [] }])
    repo.upsert('chats', { ...a, pendingTurnId: 'a-t1' })
    repo.beginRun({ ...a, pendingTurnId: 'a-t1' }, 'a-t1')
    repo.appendEvent('chat-a', 'a-t1', { kind: 'session', sessionId: 'native-a' })
    repo.appendEvent('chat-a', 'a-t1', { kind: 'thinking', text: 'Lendo o código…' })
    repo.appendEvent('chat-a', 'a-t1', { kind: 'text', text: 'Aqui está ' })
    repo.appendEvent('chat-a', 'a-t1', { kind: 'text', text: 'a explicação 🙂' })
    repo.appendEvent('chat-a', 'a-t1', { kind: 'segment', segment: { kind: 'tool', toolId: 'read-1', name: 'Read', status: 'running', input: { file_path: 'C:\\QA\\a.ts' } } })
    repo.appendEvent('chat-a', 'a-t1', { kind: 'segment', segment: { kind: 'tool', toolId: 'read-1', name: 'Read', status: 'done', input: { file_path: 'C:\\QA\\a.ts' }, result: '1 linha' } })
    repo.appendEvent('chat-a', 'a-t1', { kind: 'metrics', metrics: { scope: 'session', inputTokens: 1200, outputTokens: 80, costUsd: 0.0231, turn: { inputTokens: 1200, outputTokens: 80 }, model: 'claude-opus' } })
    repo.appendEvent('chat-a', 'a-t1', { kind: 'done' })
    const a2 = { ...repo.get('chats').find((c) => c.id === 'chat-a') }
    a2.selection = { ...a2.selection, provider: 'codex', profileId: 'work' }
    a2.turns = [...a2.turns, { id: 'a-u2', role: 'user', text: 'Agora no Codex' }, { id: 'a-t2', role: 'assistant', text: '', segments: [] }]
    a2.pendingTurnId = 'a-t2'
    repo.beginRun(a2, 'a-t2')
    for (const text of ['Par', 'Parcial', 'Parcial e final']) repo.appendEvent('chat-a', 'a-t2', { kind: 'segment', segment: { kind: 'text', toolId: 'msg-1', text } })
    repo.appendEvent('chat-a', 'a-t2', { kind: 'segment', segment: { kind: 'tool', toolId: 'cmd-1', name: 'Bash', status: 'done', input: { command: 'npm test' }, result: 'ok', resultIsError: false } })
    repo.appendEvent('chat-a', 'a-t2', { kind: 'session', sessionId: 'codex-thread' })
    repo.appendEvent('chat-a', 'a-t2', { kind: 'done' })

    // Failed turn: resume cleared, side effects kept.
    const c = chat('chat-c', 'claude', 'ambient-claude', [{ id: 'c-u1', role: 'user', text: 'Rode' }, { id: 'c-t1', role: 'assistant', text: '' }])
    repo.upsert('chats', { ...c, pendingTurnId: 'c-t1' })
    repo.beginRun({ ...c, pendingTurnId: 'c-t1' }, 'c-t1')
    repo.appendEvent('chat-c', 'c-t1', { kind: 'session', sessionId: 'old' })
    repo.appendEvent('chat-c', 'c-t1', { kind: 'segment', segment: { kind: 'tool', toolId: 'w', name: 'Write', status: 'done', result: 'SIDE_EFFECT' } })
    repo.appendEvent('chat-c', 'c-t1', { kind: 'error', message: 'Rate limit' })

    // Still running when the app "crashes": the reopen marks it interrupted.
    const b = chat('chat-b', 'codex', 'work', [{ id: 'b-u1', role: 'user', text: 'Longo' }, { id: 'b-t1', role: 'assistant', text: '', segments: [] }])
    repo.upsert('chats', { ...b, pendingTurnId: 'b-t1' })
    repo.beginRun({ ...b, pendingTurnId: 'b-t1' }, 'b-t1')
    repo.appendEvent('chat-b', 'b-t1', { kind: 'text', text: 'Trabalhando' })
    repo.appendEvent('chat-b', 'b-t1', { kind: 'segment', segment: { kind: 'tool', toolId: 'long', name: 'Bash', status: 'running', input: { command: 'sleep 999' } } })
    repo.close()

    const raw = new DatabaseSync(file)
    const rows = {
      documents: raw.prepare('SELECT kind, id, body FROM documents ORDER BY rowid').all().map((r) => ({ ...r })),
      state: raw.prepare('SELECT key, body FROM state ORDER BY rowid').all().map((r) => ({ ...r })),
      events: raw.prepare('SELECT seq, chat_id, turn_id, body FROM events ORDER BY seq').all().map((r) => ({ ...r }))
    }
    raw.close()

    repo = new AgentRepository(file, { get: () => { throw new Error('must not migrate twice') } })
    const expected = rt({ chats: repo.get('chats'), tasks: repo.get('tasks'), profiles: repo.get('profiles'), taskTabs: repo.readState('task-tabs', null) })
    repo.close()
    return {
      description: 'Rows written by the TypeScript AgentRepository (prism-agents.db) and what it returns when reopened, including the interrupted-turn repair.',
      schema: [
        'CREATE TABLE IF NOT EXISTS documents (kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id));',
        'CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY,body TEXT NOT NULL);',
        'CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT,chat_id TEXT NOT NULL,turn_id TEXT NOT NULL,body TEXT NOT NULL);',
        'CREATE INDEX IF NOT EXISTS events_chat ON events(chat_id,seq);'
      ],
      rows,
      expected
    }
  } finally {
    Date.now = realNow
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function build() {
  const header = 'Generated by scripts/gen-journal-fixtures.cjs from the TypeScript implementation. Do not edit by hand.'
  const files = {
    'scenarios.json': { generatedBy: header, cases: scenarios() },
    'repository-v02.json': { generatedBy: header, ...repositoryFixture() }
  }
  const out = Object.fromEntries(Object.entries(files).map(([name, value]) => [name, JSON.stringify(value, null, 1) + '\n']))
  // Many random cases: one compact case per line keeps the file small and diffable.
  const random = randomCases(20261009, 150)
  out['random.json'] = `{"generatedBy":${JSON.stringify(header)},"cases":[\n${random.map((c) => JSON.stringify(c)).join(',\n')}\n]}\n`
  return out
}

module.exports = { build, OUT }

if (require.main === module) {
  const files = build()
  if (process.argv.includes('--check')) {
    const stale = Object.entries(files).filter(([name, text]) => {
      const file = path.join(OUT, name)
      return !fs.existsSync(file) || fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') !== text
    })
    if (stale.length) {
      console.error(`Fixtures desatualizados: ${stale.map(([n]) => n).join(', ')}. Rode: node scripts/gen-journal-fixtures.cjs`)
      process.exit(1)
    }
    console.log('Fixtures do diário em dia.')
  } else {
    fs.mkdirSync(OUT, { recursive: true })
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(OUT, name), text)
    console.log(`Escrito em ${path.relative(ROOT, OUT)}: ${Object.keys(files).join(', ')}`)
  }
}
