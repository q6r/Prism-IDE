// T07 against the real prism-host binary: the chats and tasks domains over a
// real WebSocket, and the main criterion of the ticket: a Claude turn run by
// the host with a FAKE Claude Code CLI (a replay of the contract recorded in
// host/fixtures/claude/<version>/<scenario>/cli.jsonl), surviving the window
// closing. Nothing here touches the real app data, ~/.claude, ~/.codex or
// ~/.traycer: the host runs with HOME, USERPROFILE, APPDATA and
// PRISM_APP_DATA_DIR in temporary folders and a PATH that starts with the fake
// CLI. No paid prompt, no real CLI. Skipped when there is no binary and no cargo.
const assert = require('node:assert/strict')
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..')
const HOST_DIR = path.join(ROOT, 'host')
const EXE = process.platform === 'win32' ? 'prism-host.exe' : 'prism-host'
const CLAUDE_VERSION = '2.1.289'
const FIXTURES = path.join(HOST_DIR, 'fixtures', 'claude', CLAUDE_VERSION)

function findBinary() {
  const found = ['release', 'debug']
    .map((profile) => path.join(HOST_DIR, 'target', profile, EXE))
    .filter((p) => fs.existsSync(p))
  return found.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] ?? null
}

function hasCargo() {
  return spawnSync('cargo', ['--version'], { shell: process.platform === 'win32' }).status === 0
}

function ensureBinary() {
  const existing = findBinary()
  if (existing) return existing
  if (!hasCargo()) return null
  const build = spawnSync('cargo', ['build', '-p', 'prism-host'], {
    cwd: HOST_DIR, shell: process.platform === 'win32', encoding: 'utf8', timeout: 600_000
  })
  if (build.status !== 0) throw new Error(`cargo build -p prism-host falhou:\n${build.stdout}\n${build.stderr}`)
  return findBinary()
}

const BIN = ensureBinary()
const skip = BIN ? false : 'sem binário do prism-host e sem cargo para construí-lo'
if (skip) console.warn(`[host-chats-e2e] ${skip}; testes pulados`)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate, label, timeout = 15_000) {
  const describe = () => (typeof label === 'function' ? label() : label)
  const start = Date.now()
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() - start > timeout) assert.fail(`timeout esperando ${describe()}`)
    await sleep(20)
  }
}

const running = new Set()
const dirs = []
const sockets = new Set()

test.after(() => {
  for (const ws of sockets) { try { ws.close() } catch { /* closed */ } }
  for (const host of running) host.proc.kill()
  for (const dir of dirs) {
    const target=path.resolve(dir)
    assert.ok(target.startsWith(path.resolve(os.tmpdir())+path.sep) && path.basename(target).startsWith('prism-'), 'cleanup stays in this test’s temporary folders')
    try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* still locked */ }
  }
})

function tempDir(prefix = 'prism-host-chats-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function readInstance(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'host-instance.json'), 'utf8')) } catch { return null }
}

/** Spawns the binary on temporary folders (never the real app data) and waits until it serves. */
async function startHost({ env = {} } = {}) {
  const dir = tempDir()
  const home = tempDir('prism-host-home-')
  const appData = tempDir('prism-host-appdata-')
  const proc = spawn(BIN, ['--data-dir', dir, '--idle-timeout', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      USERPROFILE: home, HOME: home, APPDATA: appData, LOCALAPPDATA: appData,
      XDG_DATA_HOME: path.join(home, '.local', 'share'),
      PRISM_APP_DATA_DIR: appData,
      ...env
    }
  })
  let output = ''
  proc.stdout.on('data', (d) => { output += d })
  proc.stderr.on('data', (d) => { output += d })
  const exited = new Promise((resolve) => proc.once('exit', (code, signal) => resolve({ code, signal })))
  const host = { dir, proc, exited, output: () => output, url: '', instance: null }
  running.add(host)
  exited.then(() => running.delete(host))
  const instance = await waitFor(async () => {
    const i = readInstance(dir)
    if (!i || i.pid !== proc.pid) return null
    try {
      const res = await fetch(`http://127.0.0.1:${i.port}/health`)
      return res.ok ? i : null
    } catch { return null }
  }, `o host subir em ${dir}\n${output}`)
  host.instance = instance
  host.url = `ws://127.0.0.1:${instance.port}/rpc`
  return host
}

async function stopHost(host) {
  host.proc.kill()
  await host.exited
}

/** What the renderer does with the deltas (src/shared/chatDeltas.ts), as a reference. */
class Mirror {
  constructor() { this.rev = 0; this.chats = []; this.runtime = {} }

  load(snapshot) {
    this.rev = snapshot.rev
    this.chats = structuredClone(snapshot.chats)
    this.runtime = structuredClone(snapshot.runtime)
  }

  chat(id) { return this.chats.find((c) => c.id === id) }

  turn(chatId, turnId) { return this.chat(chatId)?.turns.find((t) => t.id === turnId) }

  apply(batch) {
    assert.equal(batch.rev - batch.deltas.length, this.rev, `lote não contíguo: rev ${batch.rev} depois de ${this.rev}`)
    for (const d of batch.deltas) {
      switch (d.op) {
        case 'chat': {
          const i = this.chats.findIndex((c) => c.id === d.chat.id)
          if (i >= 0) this.chats[i] = structuredClone(d.chat); else this.chats.push(structuredClone(d.chat))
          break
        }
        case 'remove':
          this.chats = this.chats.filter((c) => c.id !== d.chatId)
          delete this.runtime[d.chatId]
          break
        case 'patch': {
          const chat = this.chat(d.chatId)
          for (const [field, value] of Object.entries(d.patch)) {
            if (value === null) delete chat[field]; else chat[field] = structuredClone(value)
          }
          break
        }
        case 'turn': {
          const turns = this.chat(d.chatId).turns
          const i = turns.findIndex((t) => t.id === d.turn.id)
          if (i >= 0) turns[i] = structuredClone(d.turn); else turns.push(structuredClone(d.turn))
          break
        }
        case 'append': {
          const turn = this.turn(d.chatId, d.turnId)
          turn.segments ??= []
          const last = turn.segments.at(-1)
          if (last && last.kind === d.kind) last.text = `${last.text ?? ''}${d.text}`
          else turn.segments.push({ kind: d.kind, text: d.text })
          break
        }
        case 'segment': {
          const turn = this.turn(d.chatId, d.turnId)
          turn.segments ??= []
          const i = d.segment.toolId ? turn.segments.findIndex((s) => s.toolId === d.segment.toolId) : -1
          if (i >= 0) turn.segments[i] = structuredClone(d.segment); else turn.segments.push(structuredClone(d.segment))
          break
        }
        case 'metrics': {
          const turn = this.turn(d.chatId, d.turnId)
          turn.metrics = { ...(turn.metrics ?? {}), ...d.metrics }
          break
        }
        case 'runtime':
          if (d.runtime) this.runtime[d.chatId] = structuredClone(d.runtime); else delete this.runtime[d.chatId]
          break
        default:
          assert.fail(`delta desconhecido: ${d.op}`)
      }
    }
    this.rev = batch.rev
  }
}

/** A JSON-RPC client with requests by id and every notification kept in order. */
function connect(host) {
  const ws = new WebSocket(host.url)
  sockets.add(ws)
  const pending = new Map()
  const batches = []
  let nextId = 1
  const client = { ws, mirror: new Mirror(), batches, notes: [], closed: false }
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message)
      pending.delete(message.id)
      return
    }
    client.notes.push(message)
    if (message.method === 'chats.delta') {
      batches.push(message.params)
      if (client.following) client.mirror.apply(message.params)
    }
  })
  ws.addEventListener('close', () => { client.closed = true })
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', () => reject(new Error('falha ao abrir o WebSocket')), { once: true })
  })
  client.opened = opened
  client.raw = (method, params, timeout = 20_000) => new Promise((resolve, reject) => {
    const id = nextId++
    const timer = setTimeout(() => reject(new Error(`sem resposta de ${method}`)), timeout)
    pending.set(id, (reply) => { clearTimeout(timer); resolve(reply) })
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }))
  })
  /** The result, or throws with `code` set to the host's error code. */
  client.call = async (method, params) => {
    const reply = await client.raw(method, params)
    if (reply.error) throw Object.assign(new Error(reply.error.message), { code: reply.error.data?.code, reply })
    return reply.result
  }
  client.hello = async (host) => {
    await opened
    return client.call('host.hello', { protocol: { major: 1, minor: 0 }, client: { kind: 'desktop', version: 'test' }, token: host.instance.token })
  }
  /** Subscribes and applies every later batch to `client.mirror`. */
  client.subscribe = async () => {
    // The snapshot answer is processed before any later batch (one socket, one order).
    client.following = false
    const snapshot = await client.call('chats.subscribe', {})
    client.mirror.load(snapshot)
    // Batches that arrived together with the answer but after it are reapplied by rev.
    client.following = true
    for (const batch of batches) if (batch.rev > client.mirror.rev) client.mirror.apply(batch)
    return snapshot
  }
  client.close = () => { try { ws.close() } catch { /* closed */ } }
  return client
}

async function session(host) {
  const client = connect(host)
  const reply = await client.hello(host)
  return { client, reply }
}

/* ---------------------- the chats and tasks domains ---------------------- */

const newChat = (id, cwd, extra = {}) => ({
  id, title: 'Novo chat', cwd, createdAt: 1, updatedAt: 1, turns: [],
  selection: { provider: 'claude', profileId: 'ambient-claude', model: 'haiku', effort: 'low', permissionMode: 'default' },
  ...extra
})

test('hello advertises chats@1 and tasks@1', { skip }, async () => {
  const host = await startHost()
  const { client, reply } = await session(host)
  assert.ok(reply.capabilities.includes('chats@1'), reply.capabilities.join())
  assert.ok(reply.capabilities.includes('tasks@1'), reply.capabilities.join())
  client.close()
  await stopHost(host)
})

test('subscribe, create, rename, archive, remove and tasks reach every client with contiguous revs', { skip }, async () => {
  const host = await startHost()
  const cwd = tempDir('prism-work-')
  const a = (await session(host)).client
  const b = (await session(host)).client
  const empty = await a.subscribe()
  assert.deepEqual(empty, { rev: 0, chats: [], runtime: {} })
  await b.subscribe()

  await a.call('chats.create', { chat: newChat('c1', cwd) })
  await assert.rejects(() => b.call('chats.create', { chat: newChat('c1', cwd) }), (err) => err.code === 'invalid')
  await b.call('chats.rename', { chatId: 'c1', title: '  Meu chat  ' })
  await a.call('chats.archive', { chatId: 'c1', archived: true })
  await waitFor(() => a.mirror.chat('c1')?.archived === true && b.mirror.chat('c1')?.archived === true, 'o arquivamento em ambos')
  assert.equal(a.mirror.chat('c1').title, 'Meu chat')
  assert.equal(a.mirror.rev, b.mirror.rev, 'um contador só para todos')
  assert.ok(a.mirror.rev >= 3)

  // Every batch is contiguous for both (Mirror.apply asserts it); a late client gets the snapshot.
  const late = (await session(host)).client
  const snapshot = await late.subscribe()
  assert.equal(snapshot.rev, a.mirror.rev)
  assert.deepEqual(snapshot.chats, a.mirror.chats)
  const listed = await late.call('chats.list', {})
  assert.deepEqual(listed.chats, a.mirror.chats)
  assert.equal(listed.rev, a.mirror.rev)

  await a.call('chats.archive', { chatId: 'c1', archived: false })
  await waitFor(() => !('archived' in (b.mirror.chat('c1') ?? { archived: 1 })), 'o desarquivamento')
  await assert.rejects(() => a.call('chats.rename', { chatId: 'nope', title: 'x' }), (err) => err.code === 'not_found')
  await a.call('chats.remove', { chatId: 'c1' })
  await waitFor(() => a.mirror.chats.length === 0 && b.mirror.chats.length === 0 && late.mirror.chats.length === 0, 'a remoção em todos')
  assert.deepEqual((await a.call('chats.list', {})).chats, [])

  // A client that unsubscribes hears nothing more.
  await late.call('chats.unsubscribe', {})
  const seen = late.mirror.rev
  await a.call('chats.create', { chat: newChat('c2', cwd) })
  await waitFor(() => a.mirror.chat('c2'), 'o chat novo')
  assert.equal(late.mirror.rev, seen)

  // Tasks: whole state, then merge.
  assert.deepEqual(await a.call('tasks.load', {}), { tasks: [], openIds: [], activeId: null })
  const task = (id, title) => ({ id, cwd, title })
  await a.call('tasks.save', { tasks: [task('t1', 'Um'), task('t2', 'Dois')], openIds: ['t2', 'fantasma', 't1'], activeId: 't1' })
  assert.deepEqual(await b.call('tasks.load', {}), { tasks: (await b.call('tasks.load', {})).tasks, openIds: ['t2', 't1'], activeId: 't1' })
  await assert.rejects(() => a.call('tasks.save', { tasks: [{ id: 'x', title: 'sem pasta' }], openIds: [], activeId: null }), (err) => err.code === 'invalid')
  await a.call('tasks.merge', { tasks: [task('t2', 'Dois!'), task('t3', 'Três')] })
  const state = await b.call('tasks.load', {})
  assert.deepEqual(state.tasks.map((t) => `${t.id}=${t.title}`).sort(), ['t1=Um', 't2=Dois!', 't3=Três'])
  assert.deepEqual(state.openIds, ['t2', 't1'])

  for (const c of [a, b, late]) c.close()
  await stopHost(host)
})

test('a chat the window runs itself is stored with put, and flush skips nothing when idle', { skip }, async () => {
  const host = await startHost()
  const cwd = tempDir('prism-work-')
  const { client } = await session(host)
  await client.subscribe()
  await client.call('chats.put', { chat: newChat('p1', cwd, { title: 'SSH' }) })
  const flushed = await client.call('chats.flush', { chats: [newChat('p1', cwd, { title: 'SSH 2' }), newChat('p2', cwd)] })
  assert.deepEqual(flushed, { written: 2, skipped: [] })
  await waitFor(() => client.mirror.chats.length === 2 && client.mirror.chat('p1').title === 'SSH 2', 'os chats gravados')
  assert.deepEqual((await client.call('chats.list', {})).chats, client.mirror.chats)
  client.close()
  await stopHost(host)
})

/* ---------------------- the fake Claude Code CLI ---------------------- */

// Replays one recorded process of `cli.jsonl` (`{ p, d: 'in' | 'out', m }`):
// it waits for each "in" message, in order, and emits the "out" ones. Control
// responses to our own control requests carry the request id the host sent.
// Anything else the host sends is logged; an unexpected control request gets a
// generic success. Everything received is appended to received.jsonl.
const FAKE_CLI = String.raw`
const fs = require('node:fs')
const path = require('node:path')
const readline = require('node:readline')
const dir = path.resolve(__dirname, '..', '..', '..', '..')
if (process.argv.includes('--version')) { console.log('${CLAUDE_VERSION} (Claude Code)'); process.exit(0) }
const steps = fs.readFileSync(path.join(dir, 'script.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
fs.appendFileSync(path.join(dir, 'argv.json'), JSON.stringify(process.argv.slice(2)) + '\n')
const log = (entry) => fs.appendFileSync(path.join(dir, 'received.jsonl'), JSON.stringify(entry) + '\n')
let i = 0
let lastRequest = null
const kind = (m) => m.type === 'control_request' ? 'control_request:' + m.request?.subtype : m.type
function pump() {
  while (i < steps.length && steps[i].d === 'out') {
    const m = structuredClone(steps[i].m)
    if (m.type === 'control_response' && lastRequest) m.response.request_id = lastRequest
    process.stdout.write(JSON.stringify(m) + '\n')
    i++
  }
}
pump()
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return
  const m = JSON.parse(line)
  log(m)
  if (m.type === 'control_request') lastRequest = m.request_id
  if (i < steps.length && steps[i].d === 'in' && kind(steps[i].m) === kind(m)) { i++; pump(); return }
  if (m.type === 'control_request') {
    process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } }) + '\n')
    return
  }
  log({ unexpected: kind(m), waitingFor: steps[i] ? steps[i].d + ':' + kind(steps[i].m) : null })
}).on('close', () => process.exit(0))
`

/** The first turn of a recorded scenario: its process 0 up to the first result and the idle that follows. */
function firstTurn(scenario) {
  const lines = fs.readFileSync(path.join(FIXTURES, scenario, 'cli.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const process0 = lines.filter((l) => l.p === 0)
  const result = process0.findIndex((l) => l.d === 'out' && l.m?.type === 'result')
  assert.ok(result > 0, `${scenario}: sem result no processo 0`)
  return process0.slice(0, result + 2)
}

/** A HOME with no CLI of its own and a PATH that starts with the fake one. */
function fakeClaude(scenario) {
  const root = tempDir('prism-fake-claude-')
  const bin = path.join(root, 'bin')
  const pkg = path.join(bin, 'node_modules', '@anthropic-ai', 'claude-code')
  fs.mkdirSync(pkg, { recursive: true })
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', version: CLAUDE_VERSION }))
  fs.writeFileSync(path.join(pkg, 'cli.js'), FAKE_CLI)
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(bin, 'claude.cmd'), '@echo off\r\nnode "%~dp0node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n')
  } else {
    const shim = path.join(bin, 'claude')
    fs.writeFileSync(shim, `#!/bin/sh\nexec node "${path.join(pkg, 'cli.js')}" "$@"\n`)
    fs.chmodSync(shim, 0o755)
  }
  fs.writeFileSync(path.join(root, 'script.jsonl'), firstTurn(scenario).map((l) => JSON.stringify(l)).join('\n'))
  const nodeDir = path.dirname(process.execPath)
  return {
    root,
    env: { PATH: [bin, nodeDir, process.env.PATH ?? ''].join(path.delimiter) },
    received: () => {
      try { return fs.readFileSync(path.join(root, 'received.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] }
    },
    argv: () => {
      try { return fs.readFileSync(path.join(root, 'argv.json'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] }
    }
  }
}

/** The request id the CLI gave its `can_use_tool` request: what the host's answer must carry. */
function canUseToolId(scenario) {
  const request = firstTurn(scenario).find((l) => l.d === 'out' && l.m?.type === 'control_request' && l.m.request?.subtype === 'can_use_tool')
  assert.ok(request, `${scenario}: sem can_use_tool`)
  return request.m.request_id
}

const PROMPT = 'Use a ferramenta Write para criar o arquivo a.txt nesta pasta com o conteúdo "um". Não faça mais nada.'

/** A host with the fake CLI, a subscribed client and a Claude chat with its turn started. */
async function startTurn(scenario) {
  const fake = fakeClaude(scenario)
  const host = await startHost({ env: fake.env })
  const cwd = tempDir('prism-work-')
  const a = (await session(host)).client
  await a.subscribe()
  await a.call('chats.create', { chat: newChat('c1', cwd) })
  const { turnId } = await a.call('chats.send', { chatId: 'c1', text: PROMPT })
  assert.equal(typeof turnId, 'string')
  const permissionOf = (client) => client.mirror.runtime.c1?.permission
  await waitFor(
    () => permissionOf(a),
    () => `a permissão pendente\nruntime=${JSON.stringify(a.mirror.runtime)}\nturns=${JSON.stringify(a.mirror.chat('c1')?.turns)}\nargv=${JSON.stringify(fake.argv())}\nreceived=${JSON.stringify(fake.received())}\n${host.output()}`,
    10_000
  )
  return { fake, host, cwd, a, turnId, permissionOf }
}

const lastSegments = (client) => client.mirror.chat('c1').turns.at(-1).segments ?? []

test('E2E Claude: second-turn exit without a result releases the chat and a later message recovers without restarting the host', { skip }, async () => {
  const fake = fakeClaude('permission-allow')
  const pkg = path.join(fake.root, 'bin', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
  fs.writeFileSync(pkg, String.raw`
const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline')
const dir = path.resolve(__dirname, '..', '..', '..', '..')
if (process.argv.includes('--version')) { console.log('${CLAUDE_VERSION} (Claude Code)'); process.exit(0) }
fs.appendFileSync(path.join(dir, 'argv.json'), JSON.stringify(process.argv.slice(2))+'\n')
const log = m => fs.appendFileSync(path.join(dir, 'received.jsonl'), JSON.stringify(m)+'\n')
const output = m => process.stdout.write(JSON.stringify(m)+'\n')
readline.createInterface({input:process.stdin}).on('line', line => {
  const m=JSON.parse(line); log(m)
  if (m.type==='control_request') { output({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{}}}); return }
  if (m.type!=='user') return
  const n=fs.readFileSync(path.join(dir,'received.jsonl'),'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(m=>m.type==='user').length
  // The native runner tests separately cover a closed stdout with a live
  // process. Node keeps inherited Windows pipe handles open until exit, so
  // this end-to-end test covers a clean OS exit without a turn result.
  if (n===2) { process.exit(0); return }
  output({type:'system',subtype:'init',session_id:'claude-warm',model:'haiku',tools:[]})
  output({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'answer-'+n}}})
  output({type:'result',subtype:'success',is_error:false,session_id:'claude-warm',result:'answer-'+n,usage:{input_tokens:1,output_tokens:1},duration_ms:1,num_turns:1})
}).on('close',()=>process.exit(0))
`)
  const host = await startHost({ env: fake.env })
  const client = (await session(host)).client
  try {
    await client.subscribe()
    await client.call('chats.create', { chat: newChat('claude-recovery', tempDir('prism-work-')) })
    const send = async text => {
      const { turnId } = await client.call('chats.send', { chatId: 'claude-recovery', text })
      await waitFor(() => client.mirror.runtime['claude-recovery']?.busy === false && client.mirror.turn('claude-recovery', turnId)?.completedAt, () => 'Claude turn never released: '+JSON.stringify({runtime:client.mirror.runtime['claude-recovery'],turn:client.mirror.turn('claude-recovery',turnId),received:fake.received(),argv:fake.argv()})+'\n'+host.output(), 10000)
      return client.mirror.turn('claude-recovery', turnId)
    }
    const first = await send('first')
    assert.ok(first.segments.some(s => s.text === 'answer-1'))
    const firstSnapshot = structuredClone(first)
    const second = await send('second')
    assert.equal(second.error, true, 'a process exit without a turn result ends with an explicit error')
    assert.equal(second.interrupted, false, 'a transport failure is not reported as a user cancellation')
    assert.equal(fake.argv().length, 1, 'the second message exercised a reused Claude process')
    const third = await send('recover')
    assert.ok(third.segments.some(s => s.text === 'answer-3'))
    assert.equal(third.error, false)
    assert.equal(fake.argv().length, 2, 'only the failed Claude session was restarted')
    // The engine intentionally drops a failed native resume and carries the
    // visible history into a fresh session; do not revive the failed prompt.
    assert.equal(fake.argv()[1].some(arg => arg.startsWith('--resume=')), false)
    const recoveredInput = fake.received().filter(message => message.type === 'user')[2].message.content
    assert.ok(recoveredInput.includes('<historico>') && recoveredInput.includes('answer-1'), 'the recovery carries the existing conversation')
    const fourth = await send('continue')
    assert.ok(fourth.segments.some(s => s.text === 'answer-4'))
    assert.equal(fake.argv().length, 2, 'healthy warm sessions still continue')
    assert.deepEqual(client.mirror.turn('claude-recovery', first.id), firstSnapshot)
    assert.ok((await client.call('chats.list', {})).chats.some(c => c.id === 'claude-recovery'))
  } finally {
    client.close()
    await stopHost(host)
  }
})

test('E2E fake CLI (permission-allow): the turn outlives the window and a new one answers the permission', { skip }, async () => {
  const { fake, host, a, turnId, permissionOf } = await startTurn('permission-allow')
  const permission = permissionOf(a)
  assert.equal(permission.id, turnId)
  assert.equal(permission.toolName, 'Write')
  assert.equal(a.mirror.runtime.c1.busy, true)
  assert.equal(a.mirror.runtime.c1.route, 'claude:ambient-claude')
  assert.ok(fake.argv()[0].includes('--model=haiku'), JSON.stringify(fake.argv()))
  assert.ok(lastSegments(a).some((s) => s.kind === 'tool' && s.status === 'awaiting'), JSON.stringify(lastSegments(a)))

  // The window closes. The turn must not.
  a.close()
  await waitFor(() => a.closed, 'o socket fechar')
  await sleep(300)

  // Another window: the snapshot shows the running turn and the pending permission.
  const b = (await session(host)).client
  const snapshot = await b.subscribe()
  assert.equal(snapshot.runtime.c1.busy, true)
  assert.equal(snapshot.runtime.c1.permission.permId, permission.permId)
  const running = snapshot.chats.find((c) => c.id === 'c1')
  assert.equal(running.pendingTurnId, turnId)
  assert.equal(running.turns[0].text, PROMPT)
  assert.ok(running.turns[1].segments.some((s) => s.kind === 'tool' && s.status === 'awaiting'))

  await b.call('chats.respondPermission', { chatId: 'c1', permId: permission.permId, decision: 'allow' })
  await assert.rejects(
    () => b.call('chats.respondPermission', { chatId: 'c1', permId: permission.permId, decision: 'allow' }),
    (err) => err.code === 'gone'
  )
  await waitFor(() => b.mirror.runtime.c1?.busy === false, `o fim do turno\n${host.output()}\n${JSON.stringify(fake.received())}`, 30_000)

  const response = fake.received().find((m) => m.type === 'control_response' && m.response?.request_id === canUseToolId('permission-allow'))
  assert.ok(response, `a resposta da permissão chegou à CLI: ${JSON.stringify(fake.received().map((m) => m.type))}`)
  assert.equal(response.response.response.behavior, 'allow')
  assert.equal(fake.received().find((m) => m.unexpected), undefined, 'the host sent only what the contract expects')

  // The mirror (snapshot + deltas) is what the host stored.
  const listed = (await b.call('chats.list', {})).chats.find((c) => c.id === 'c1')
  const mirrored = b.mirror.chat('c1')
  assert.deepEqual(mirrored, listed)
  assert.equal(mirrored.pendingTurnId, undefined)
  assert.equal(mirrored.turns[1].error, false)
  assert.ok(mirrored.turns[1].completedAt > 0)
  assert.ok(mirrored.turns[1].segments.some((s) => s.kind === 'tool' && s.name === 'Write' && s.status === 'done'), JSON.stringify(mirrored.turns[1].segments))
  assert.equal(mirrored.resume?.route, 'claude:ambient-claude')
  assert.equal(typeof mirrored.resume?.sessionId, 'string')
  assert.equal(b.mirror.runtime.c1.permission, undefined)

  b.close()
  await stopHost(host)
})

test('E2E fake CLI (permission-deny): two windows see the permission, one denies, the other gets gone', { skip }, async () => {
  const { fake, host, a, turnId, permissionOf } = await startTurn('permission-deny')
  const b = (await session(host)).client
  await b.subscribe()
  assert.equal(permissionOf(b)?.permId, permissionOf(a).permId, 'both windows show the same permission')
  const permission = permissionOf(a)
  assert.equal(permission.id, turnId)

  await Promise.all([
    a.call('chats.respondPermission', { chatId: 'c1', permId: permission.permId, decision: 'deny' }).then(() => 'ok', (err) => err.code),
    sleep(0).then(() => b.call('chats.respondPermission', { chatId: 'c1', permId: permission.permId, decision: 'deny' }).then(() => 'ok', (err) => err.code))
  ]).then((outcomes) => assert.deepEqual([...outcomes].sort(), ['gone', 'ok']))
  await waitFor(() => a.mirror.runtime.c1?.busy === false && b.mirror.runtime.c1?.busy === false, `o fim do turno\n${host.output()}\n${JSON.stringify(fake.received())}`, 30_000)

  const response = fake.received().find((m) => m.type === 'control_response' && m.response?.request_id === canUseToolId('permission-deny'))
  assert.equal(response?.response?.response?.behavior, 'deny')
  const listed = (await a.call('chats.list', {})).chats.find((c) => c.id === 'c1')
  assert.deepEqual(a.mirror.chat('c1'), listed)
  assert.deepEqual(b.mirror.chat('c1'), listed)
  assert.equal(a.mirror.rev, b.mirror.rev)
  assert.ok(listed.turns[1].segments.some((s) => s.kind === 'tool' && (s.status === 'denied' || s.status === 'error')), JSON.stringify(listed.turns[1].segments))

  // Commands on a finished chat: nothing left to answer or stop.
  await assert.rejects(() => b.call('chats.respondPermission', { chatId: 'c1', permId: permission.permId, decision: 'allow' }), (err) => err.code === 'gone')
  await a.call('chats.stop', { chatId: 'c1' })
  a.close()
  b.close()
  await stopHost(host)
})

test('E2E fake CLI: commands that cannot apply to a running chat answer busy', { skip }, async () => {
  const { fake, host, a } = await startTurn('permission-allow')
  await assert.rejects(() => a.call('chats.send', { chatId: 'c1', text: 'outra' }), (err) => err.code === 'busy')
  await assert.rejects(() => a.call('chats.remove', { chatId: 'c1' }), (err) => err.code === 'busy')
  await assert.rejects(() => a.call('chats.archive', { chatId: 'c1', archived: true }), (err) => err.code === 'busy')
  await assert.rejects(() => a.call('chats.put', { chat: newChat('c1', a.mirror.chat('c1').cwd) }), (err) => err.code === 'busy')
  await a.call('chats.setTask', { chatId: 'c1', taskId: 'tarefa' })
  await waitFor(() => a.mirror.chat('c1').taskId === 'tarefa', 'setTask com o turno rodando')

  // Stopping reaches the CLI as an interrupt (the fake never finishes the turn by itself).
  await a.call('chats.stop', { chatId: 'c1' })
  await waitFor(
    () => fake.received().some((m) => m.type === 'control_request' && m.request?.subtype === 'interrupt'),
    () => `o interrupt na CLI: ${JSON.stringify(fake.received().map((m) => m.type + ':' + (m.request?.subtype ?? '')))}`
  )
  assert.equal(a.mirror.runtime.c1.busy, true, 'the turn ends when the CLI says so')
  a.close()
  await stopHost(host)
})

test('E2E stop: an unresponsive CLI ends interrupted and the chats engine remains available', { skip }, async () => {
 const { host, a, turnId } = await startTurn('permission-allow')
 await a.call('chats.stop', {chatId:'c1'})
 await waitFor(()=>a.mirror.runtime.c1?.busy===false, ()=>'forced interruption: '+host.output(), 10000)
 assert.equal(a.mirror.chat('c1').turns.find(t=>t.id===turnId).interrupted,true)
 const listed=await a.call('chats.list',{})
 assert.ok(listed.chats.some(c=>c.id==='c1'))
 a.close();await stopHost(host)
})

// A persistent native process: every message continues the same thread, but
// each host turn has its own event sink. This catches a first-turn sink being
// retained on reuse, which a provider test with one shared sink cannot catch.
const FAKE_CODEX = String.raw`
const fs = require('node:fs')
const readline = require('node:readline')
const log = value => fs.appendFileSync(process.env.PRISM_QA_CODEX_LOG, JSON.stringify(value) + '\n')
if (process.argv.includes('--version')) { console.log('codex-cli 0.142.5'); process.exit(0) }
if (!process.argv.includes('app-server')) process.exit(2)
log({spawn:process.pid})
let serial=0, active=null
const send = value => process.stdout.write(JSON.stringify(value)+'\n')
const notify = (method, params) => send({method,params})
function complete(status='completed') {
  if (!active) return
  const turn=active; active=null
  notify('item/completed',{threadId:'thread-warm',turnId:turn.id,item:{type:'agentMessage',id:'reply-'+turn.id,text:'reply: '+turn.text}})
  notify('turn/completed',{threadId:'thread-warm',turn:{id:turn.id,status}})
}
readline.createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);log(m)
  if (m.id===undefined) return
  if (!m.method) { if (m.id==='approval-'+active?.id) complete();return }
  if (m.method==='initialize') return send({id:m.id,result:{userAgent:'qa'}})
  if (m.method==='thread/start'||m.method==='thread/resume') return send({id:m.id,result:{thread:{id:'thread-warm'}}})
  if (m.method==='skills/list') return send({id:m.id,result:{data:[]}})
  if (m.method==='turn/start') {
    const raw=m.params.input.filter(i=>i.type==='text').map(i=>i.text).join('')
    const marker='Nova mensagem do usuário:\n'
    const text=raw.includes(marker)?raw.slice(raw.lastIndexOf(marker)+marker.length):raw
    active={id:'native-'+(++serial),text}
    send({id:m.id,result:{turn:{id:active.id,status:'inProgress'}}})
    notify('turn/started',{threadId:'thread-warm',turn:{id:active.id,status:'inProgress'}})
    notify('item/completed',{threadId:'thread-warm',turnId:active.id,item:{type:'agentMessage',id:'progress-'+active.id,text:'started: '+text}})
    if (text==='approval') {
      send({id:'approval-'+active.id,method:'item/commandExecution/requestApproval',params:{threadId:'thread-warm',turnId:active.id,itemId:'command-'+active.id,command:'echo simulated',cwd:process.cwd()}})
    } else if (text!=='hold') { setTimeout(()=>complete(),text==='slow'?1000:20) }
    return
  }
  if (m.method==='turn/interrupt') { send({id:m.id,result:{}});complete('interrupted');return }
  send({id:m.id,result:{}})
}).on('close',()=>process.exit(0))
`

function fakeCodex() {
  const root=tempDir('prism-fake-codex-')
  const bin=path.join(root,'bin')
  const entry=path.join(bin,'node_modules','@openai','codex','bin','codex.js')
  fs.mkdirSync(path.dirname(entry),{recursive:true})
  fs.writeFileSync(entry,FAKE_CODEX)
  if (process.platform==='win32') fs.writeFileSync(path.join(bin,'codex.cmd'),'@echo off\r\nnode "%~dp0node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n')
  else { const shim=path.join(bin,'codex');fs.writeFileSync(shim,`#!/bin/sh\nexec node "${entry}" "$@"\n`);fs.chmodSync(shim,0o755) }
  const log=path.join(root,'received.jsonl')
  return {env:{PATH:[bin,path.dirname(process.execPath),process.env.PATH??''].join(path.delimiter),PRISM_QA_CODEX_LOG:log},received:()=>{try{return fs.readFileSync(log,'utf8').split('\n').filter(Boolean).map(JSON.parse)}catch{return []}}}
}

test('E2E Codex: second and later messages publish output, approvals and completion on the reused process', {skip}, async()=>{
  const fake=fakeCodex()
  const host=await startHost({env:fake.env})
  const cwd=tempDir('prism-work-')
  const a=(await session(host)).client
  const b=(await session(host)).client
  await a.subscribe();await b.subscribe()
  await a.call('chats.create',{chat:newChat('codex-warm',cwd,{selection:{provider:'codex',profileId:'ambient-codex',model:'gpt-6.1-sol',effort:'high',permissionMode:'default'}})})
  async function send(text) {
    const {turnId}=await a.call('chats.send',{chatId:'codex-warm',text})
    await waitFor(()=>a.mirror.turn('codex-warm',turnId)?.segments?.some(s=>s.text==='started: '+text),()=>`Codex output for ${text}; native starts=${fake.received().filter(m=>m.method==='turn/start').length}`,3000)
    return turnId
  }
  async function finished(turnId,idle=true) {
    await waitFor(()=>a.mirror.turn('codex-warm',turnId)?.completedAt && b.mirror.turn('codex-warm',turnId)?.completedAt,'Codex completion reaches both windows',3000)
    if (idle) {
      assert.equal(a.mirror.runtime['codex-warm']?.busy,false)
      assert.equal(b.mirror.runtime['codex-warm']?.busy,false)
    }
    if (!a.mirror.turn('codex-warm',turnId).interrupted) assert.equal(a.mirror.chat('codex-warm').resume?.sessionId,'thread-warm')
  }
  const first=await send('first');await finished(first)
  const firstSnapshot=structuredClone(a.mirror.turn('codex-warm',first))
  const second=await send('second');await finished(second)
  assert.deepEqual(a.mirror.turn('codex-warm',first),firstSnapshot,'the second response does not overwrite the first')
  const third=await send('approval')
  await waitFor(()=>a.mirror.runtime['codex-warm']?.permission && b.mirror.runtime['codex-warm']?.permission,'approval on later turn',3000)
  const permission=a.mirror.runtime['codex-warm'].permission
  assert.equal(permission.id,third)
  await b.call('chats.respondPermission',{chatId:'codex-warm',permId:permission.permId,decision:'allow'})
  await finished(third)
  assert.equal(fake.received().filter(m=>m.spawn).length,1,'three successive messages reuse the native process')
  const fourth=await send('hold')
  await a.call('chats.stop',{chatId:'codex-warm'})
  await finished(fourth)
  assert.equal(a.mirror.turn('codex-warm',fourth).interrupted,true)
  const fifth=await send('after-stop');await finished(fifth)
  await a.call('chats.queue',{chatId:'codex-warm',operation:'pause',paused:false})
  const sixth=await send('slow')
  await b.call('chats.queue',{chatId:'codex-warm',operation:'add',message:{id:'queue-one',text:'queued-one'}})
  await b.call('chats.queue',{chatId:'codex-warm',operation:'add',message:{id:'queue-two',text:'queued-two'}})
  await finished(sixth,false)
  await waitFor(()=>a.mirror.chat('codex-warm')?.turns.filter(t=>t.role==='assistant'&&t.completedAt).length===8 && !a.mirror.runtime['codex-warm']?.busy,'both queued messages complete on the same native process',5000)
  assert.deepEqual(a.mirror.chat('codex-warm').queued??[],[])
  assert.deepEqual(a.mirror.chat('codex-warm').turns.filter(t=>t.role==='user').slice(-2).map(t=>t.text),['queued-one','queued-two'])
  assert.equal(fake.received().filter(m=>m.spawn).length,2,'only the explicit Stop restarts the process; queue messages reuse it')
  assert.equal(fake.received().filter(m=>m.method==='thread/start').length,2)
  assert.equal(fake.received().filter(m=>m.method==='turn/start').length,8)
  a.close();b.close();await stopHost(host)
})

test('E2E image references: native bytes on resumed turns and stable legacy queue numbers', { skip }, async () => {
  const fake = fakeCodex()
  const host = await startHost({ env: fake.env })
  const cwd = tempDir('prism-work-')
  const client = (await session(host)).client
  await client.subscribe()
  const selection = { provider: 'codex', profileId: 'ambient-codex', model: 'gpt-6.1-sol', effort: 'high', permissionMode: 'default' }
  const image = (data) => ({ mime: 'image/png', data })
  const starts = () => fake.received().filter(m => m.method === 'turn/start')
  async function finished(chatId, turnId) {
    await waitFor(() => client.mirror.turn(chatId, turnId)?.completedAt && !client.mirror.runtime[chatId]?.busy,
      () => `completion for ${chatId}: ${host.output()}`, 5000)
  }
  await client.call('chats.create', { chat: newChat('image-refs', cwd, { selection }) })
  const first = await client.call('chats.send', { chatId: 'image-refs', text: 'duas imagens', images: [image('b25l'), image('dHdv')] })
  await finished('image-refs', first.turnId)
  const original = client.mirror.chat('image-refs').turns.find(t => t.role === 'user')
  assert.deepEqual(original.images.map(i => i.number), [1, 2])
  const text = 'compare #image2 com #image 1 e #image2'
  const second = await client.call('chats.send', { chatId: 'image-refs', text })
  await finished('image-refs', second.turnId)
  assert.deepEqual(starts()[1].params.input.filter(i => i.type === 'image').map(i => i.url), [
    'data:image/png;base64,dHdv', 'data:image/png;base64,b25l'
  ], 'a resumed native turn receives the historical image bytes, in mention order, once each')
  assert.ok(starts()[1].params.input.find(i => i.type === 'text').text.endsWith('Anexo 1 = #image 2\nAnexo 2 = #image 1'))
  const compared = client.mirror.chat('image-refs').turns.filter(t => t.role === 'user').at(-1)
  assert.equal(compared.text, text)
  assert.equal(compared.images, undefined, 'references do not duplicate historical bytes into new turns')
  assert.equal(fake.received().filter(m => m.spawn).length, 1, 'the numbered references continue the same native process')
  assert.equal(client.mirror.chat('image-refs').resume.sessionId, 'thread-warm')
  const before = client.mirror.chat('image-refs').turns.length
  await assert.rejects(client.call('chats.send', { chatId: 'image-refs', text: 'veja #image 999' }), { code: 'invalid' })
  assert.equal(starts().length, 2)
  assert.equal(client.mirror.chat('image-refs').turns.length, before)
  assert.equal(client.mirror.runtime['image-refs'].busy, false, 'an unknown reference never starts a busy turn')

  await client.call('chats.create', { chat: newChat('legacy-image-queue', cwd, {
    selection, queuePaused: true,
    turns: [{ id: 'old-image', role: 'user', text: 'antiga', images: [image('b2xk')] }],
    queued: [{ id: 'a', text: 'fila a', images: [image('YQ==')] }, { id: 'b', text: 'fila b', images: [image('Yg==')] }]
  }) })
  await client.call('chats.queue', { chatId: 'legacy-image-queue', operation: 'move', id: 'b', to: 0 })
  await waitFor(() => client.mirror.chat('legacy-image-queue')?.queued?.[0]?.id === 'b', 'legacy queue moved')
  assert.deepEqual(client.mirror.chat('legacy-image-queue').queued.map(q => q.images[0].number), [3, 2])
  await client.call('chats.queue', { chatId: 'legacy-image-queue', operation: 'remove', id: 'a' })
  await waitFor(() => client.mirror.chat('legacy-image-queue')?.queued?.length === 1, 'legacy origin removed')
  assert.equal(client.mirror.chat('legacy-image-queue').queued[0].images[0].number, 3)
  await client.call('chats.queue', { chatId: 'legacy-image-queue', operation: 'pause', paused: false })
  await waitFor(() => client.mirror.chat('legacy-image-queue')?.turns.some(t => t.role === 'assistant' && t.completedAt)
    && !client.mirror.runtime['legacy-image-queue']?.busy, 'legacy queue dispatch completes', 5000)
  assert.equal(client.mirror.chat('legacy-image-queue').turns.filter(t => t.role === 'user').at(-1).images[0].number, 3)
  assert.deepEqual(starts().at(-1).params.input.filter(i => i.type === 'image').map(i => i.url), ['data:image/png;base64,Yg=='])
  assert.ok(starts().at(-1).params.input.find(i => i.type === 'text').text.endsWith('Anexo 1 = #image 3'))
  client.close()
  await stopHost(host)
})
