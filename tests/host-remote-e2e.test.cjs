// T09 against the real prism-host binary: remote control from a phone. The
// ticket's criterion: the desktop shares a chat and CLOSES, a "phone" (a
// WebSocket on the link) sends a prompt, approves the permission and sees the
// turn finish, and a new desktop finds the turn; unshare revokes the link.
// The Claude turn is run with a FAKE Claude Code CLI (a replay of the contract
// recorded in host/fixtures/claude/<version>/<scenario>/cli.jsonl). Nothing
// here touches the real app data, ~/.claude, ~/.codex or ~/.traycer: the host
// runs with HOME, USERPROFILE, APPDATA and PRISM_APP_DATA_DIR in temporary
// folders, PRISM_REMOTE_TUNNEL=off (no cloudflared, no network) and a PATH
// that starts with the fake CLI. No paid prompt, no real CLI. Skipped when
// there is no binary and no cargo.
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
if (skip) console.warn(`[host-remote-e2e] ${skip}; testes pulados`)

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
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* still locked */ }
  }
})

function tempDir(prefix = 'prism-host-remote-') {
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
      PRISM_REMOTE_TUNNEL: 'off',
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

const newChat = (id, cwd, extra = {}) => ({
  id, title: 'Novo chat', cwd, createdAt: 1, updatedAt: 1, turns: [],
  selection: { provider: 'claude', profileId: 'ambient-claude', model: 'haiku', effort: 'low', permissionMode: 'default' },
  ...extra
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

/* ---------------------- the phone ---------------------- */

/** A phone on a shared chat's socket: every message kept in order. */
function openPhone(baseUrl, token) {
  const ws = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/?t=${token}`)
  sockets.add(ws)
  const phone = { ws, messages: [], closed: false }
  ws.addEventListener('message', (event) => phone.messages.push(JSON.parse(String(event.data))))
  ws.addEventListener('close', () => { phone.closed = true })
  phone.opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', () => reject(new Error('falha ao abrir o WebSocket do celular')), { once: true })
  })
  phone.send = (message) => ws.send(JSON.stringify(message))
  /** The first message (already received or arriving) that satisfies `pred`. */
  phone.wait = (pred, label, timeout = 20_000) => waitFor(
    () => phone.messages.find(pred),
    () => `${label}\nmensagens=${JSON.stringify(phone.messages).slice(0, 4000)}`,
    timeout
  )
  /** Sends a command and answers its two acks: `pc` (the desktop) and `done`. */
  phone.command = async (tabId, action, payload) => {
    const before = phone.messages.length
    phone.send({ t: 'cmd', tabId, action, payload })
    const isAck = (stage) => (m) => m.t === 'ack' && m.stage === stage && m.action === action && phone.messages.indexOf(m) >= before
    const pc = await phone.wait(isAck('pc'), `o ack pc de ${action}`)
    const done = await phone.wait(isAck('done'), `o ack done de ${action}`)
    return { pc, done }
  }
  return phone
}

/** The HTTP status of a WebSocket upgrade request (a client library hides it). */
function upgradeStatus(baseUrl, token) {
  const http = require('node:http')
  const { port } = new URL(baseUrl)
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: `/?t=${token}`,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' }
    })
    req.on('response', (res) => { res.resume(); resolve(res.statusCode) })
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode) })
    req.on('error', reject)
    req.end()
  })
}

/** A host with the fake CLI and a desktop that shares chats c1 and c2 (c2 keeps the server up when c1 goes). */
async function startShared(scenario) {
  const fake = fakeClaude(scenario)
  const host = await startHost({ env: fake.env })
  const cwd = tempDir('prism-work-')
  const desktop = (await session(host)).client
  await desktop.call('chats.create', { chat: newChat('c1', cwd) })
  await desktop.call('chats.create', { chat: newChat('c2', cwd) })
  const shared = await desktop.call('remote.share', { chatId: 'c1' })
  const other = await desktop.call('remote.share', { chatId: 'c2' })
  return { fake, host, cwd, desktop, shared, other }
}

const EMPTY_STATUS = { running: false, baseUrl: null, phones: 0, chats: [] }

test('hello advertises remote@1 and nothing is shared at first', { skip }, async () => {
  const host = await startHost()
  const { client, reply } = await session(host)
  assert.ok(reply.capabilities.includes('remote@1'), reply.capabilities.join())
  assert.deepEqual(await client.call('remote.status', {}), EMPTY_STATUS)
  client.close()
  await stopHost(host)
})

test('E2E fake CLI: the phone runs a turn with the desktop closed, approves it, and a new desktop finds it; unshare revokes', { skip }, async () => {
  const { fake, host, desktop, shared, other } = await startShared('permission-allow')
  assert.match(shared.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/, 'PRISM_REMOTE_TUNNEL=off: the link is the loopback')
  assert.equal(shared.url, `${shared.baseUrl}/#t=${shared.token}&c=c1`)
  assert.notEqual(shared.token, other.token)
  assert.equal((await desktop.call('remote.share', { chatId: 'c1' })).token, shared.token, 'sharing again answers the same link')

  // The desktop disconnects, as a closed window.
  desktop.close()
  await waitFor(() => desktop.closed, 'o desktop fechar')
  await sleep(300)

  // The phone: the page's server is up and the socket opens on the token.
  assert.equal((await fetch(`${shared.baseUrl}/health`)).status, 200)
  const phone = openPhone(shared.baseUrl, shared.token)
  await phone.opened
  const state = await phone.wait((m) => m.t === 'state', 'o state de entrada')
  assert.equal(state.chat.tabId, 'c1')
  assert.equal(state.chat.streaming, false)
  await phone.wait((m) => m.t === 'chats', 'a lista de entrada')
  phone.send({ t: 'ping' })
  await phone.wait((m) => m.t === 'pong', 'o pong')

  const sent = await phone.command('c1', 'send', { text: PROMPT })
  assert.deepEqual([sent.pc.ok, sent.done.ok, sent.done.reason], [true, true, ''], JSON.stringify(sent))

  // The permission arrives pending on the running turn.
  const turnsOf = (m) => (m.t === 'delta' ? m.turns : m.t === 'state' ? m.chat.turns : [])
  const withPerm = await phone.wait(
    (m) => turnsOf(m).some((t) => t.pendingPerm),
    `a permissão pendente\n${host.output()}\n${JSON.stringify(fake.received())}`,
    30_000
  )
  const turn = turnsOf(withPerm).find((t) => t.pendingPerm)
  assert.equal(turn.pendingPerm.toolName, 'Write')
  const listed = await phone.wait((m) => m.t === 'chats' && m.chats[0].pending === true, 'o chat pendente na lista')
  assert.equal(listed.chats[0].tabId, 'c1')

  const approved = await phone.command('c1', 'perm', { permId: turn.pendingPerm.permId, decision: 'allow' })
  assert.deepEqual([approved.done.ok, approved.done.reason], [true, ''], JSON.stringify(approved))
  const twice = await phone.command('c1', 'perm', { permId: turn.pendingPerm.permId, decision: 'allow' })
  assert.deepEqual([twice.done.ok, twice.done.reason], [false, 'gone'])

  // The turn ends: the phone hears the chat is no longer streaming.
  await phone.wait(
    (m) => m.t === 'delta' && m.streaming === false,
    `o fim do turno\n${host.output()}\n${JSON.stringify(fake.received())}`,
    30_000
  )
  const response = fake.received().find((m) => m.type === 'control_response' && m.response?.request_id === canUseToolId('permission-allow'))
  assert.equal(response?.response?.response?.behavior, 'allow', JSON.stringify(fake.received().map((m) => m.type)))

  // A new desktop finds the turn the phone ran.
  const next = (await session(host)).client
  const chat = (await next.call('chats.list', {})).chats.find((c) => c.id === 'c1')
  assert.equal(chat.turns[0].text, PROMPT)
  assert.equal(chat.pendingTurnId, undefined)
  assert.ok(chat.turns[1].completedAt > 0)
  assert.ok(chat.turns[1].segments.some((s) => s.kind === 'tool' && s.name === 'Write' && s.status === 'done'), JSON.stringify(chat.turns[1].segments))
  const status = await next.call('remote.status', {})
  assert.deepEqual([status.running, status.phones, status.chats.map((c) => [c.chatId, c.phones])], [true, 1, [['c1', 1], ['c2', 0]]])
  assert.equal(status.chats[0].token, shared.token, 'the new desktop reads the same links')

  // Unshare revokes: the phone is told and dropped, the old token is dead, the other chat lives.
  await next.call('remote.unshare', { chatId: 'c1' })
  await phone.wait((m) => m.t === 'revoked' && m.tabId === 'c1', 'revoked')
  await waitFor(() => phone.closed, 'o socket do celular fechar')
  assert.equal(await upgradeStatus(shared.baseUrl, shared.token), 401)
  assert.equal(await upgradeStatus(shared.baseUrl, 'lixo'), 401)
  assert.equal((await next.call('remote.status', {})).chats.length, 1)
  const second = openPhone(shared.baseUrl, other.token)
  await second.opened
  await second.wait((m) => m.t === 'state' && m.chat.tabId === 'c2', 'o outro chat segue compartilhado')

  next.close()
  await stopHost(host)
})

test('stop brings the server down and tells the phones', { skip }, async () => {
  const host = await startHost()
  const cwd = tempDir('prism-work-')
  const desktop = (await session(host)).client
  await desktop.call('chats.create', { chat: newChat('c1', cwd) })
  const shared = await desktop.call('remote.share', { chatId: 'c1' })
  assert.equal((await fetch(`${shared.baseUrl}/health`)).status, 200)
  const phone = openPhone(shared.baseUrl, shared.token)
  await phone.opened
  await phone.wait((m) => m.t === 'state', 'o state')

  const before = desktop.notes.length
  await desktop.call('remote.stop', {})
  await phone.wait((m) => m.t === 'stopped', 'stopped')
  await waitFor(() => phone.closed, 'o socket fechar')
  const changed = await waitFor(
    () => desktop.notes.slice(before).find((n) => n.method === 'remote.changed' && n.params.reason === 'user'),
    'remote.changed com user'
  )
  assert.deepEqual([changed.params.running, changed.params.chats], [false, []])
  await waitFor(async () => { try { await fetch(`${shared.baseUrl}/health`); return false } catch { return true } }, 'o servidor cair')
  assert.deepEqual(await desktop.call('remote.status', {}), EMPTY_STATUS)
  await assert.rejects(() => desktop.call('remote.share', { chatId: 'nope' }), (err) => err.code === 'not_found')

  desktop.close()
  await stopHost(host)
})
