// Conformance of the real prism-host binary: spawns it on a temp data dir and
// speaks the protocol to it over a real WebSocket. Skipped when there is no
// binary and no cargo to build one.
const assert = require('node:assert/strict')
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { HOST_PROTOCOL } = require('./helpers/load-typescript.cjs')('src/shared/host/version.ts')

const ROOT = path.resolve(__dirname, '..')
const HOST_DIR = path.join(ROOT, 'host')
const EXE = process.platform === 'win32' ? 'prism-host.exe' : 'prism-host'
const TOKEN_RE = /^[0-9a-f]{64}$/

function findBinary() {
  const found = ['release', 'debug']
    .map((profile) => path.join(HOST_DIR, 'target', profile, EXE))
    .filter((p) => fs.existsSync(p))
  // Both can exist; the freshest build is the one under test.
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
if (skip) console.warn(`[host-conformance] ${skip}; testes pulados`)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate, label, timeout = 15_000) {
  const start = Date.now()
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() - start > timeout) assert.fail(`timeout esperando ${label}`)
    await sleep(25)
  }
}

const running = new Set()
const dirs = []

test.after(() => {
  for (const host of running) host.proc.kill()
  for (const dir of dirs) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* still locked */ }
  }
})

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-host-conf-'))
  dirs.push(dir)
  return dir
}

function readInstance(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'host-instance.json'), 'utf8')) } catch { return null }
}

/** Spawns the binary and waits until it is serving. */
async function startHost({ dir = tempDir(), args = ['--idle-timeout', '0'] } = {}) {
  const proc = spawn(BIN, ['--data-dir', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
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

function helloParams(host, overrides = {}) {
  return { protocol: { major: 1, minor: 0 }, client: { kind: 'desktop', version: 'test' }, token: host.instance.token, ...overrides }
}

/** A tiny JSON-RPC client over the Node global WebSocket. */
function connect(url) {
  const ws = new WebSocket(url)
  const queue = []
  const waiters = []
  let closeInfo = null
  const closeWaiters = []
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    const waiter = waiters.shift()
    if (waiter) waiter(message)
    else queue.push(message)
  })
  ws.addEventListener('close', (event) => {
    closeInfo = { code: event.code }
    for (const w of closeWaiters.splice(0)) w(closeInfo)
  })
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', () => reject(new Error('falha ao abrir o WebSocket')), { once: true })
  })
  const client = {
    ws,
    opened,
    send(message) { ws.send(typeof message === 'string' ? message : JSON.stringify(message)) },
    next(timeout = 5000) {
      if (queue.length) return Promise.resolve(queue.shift())
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('sem mensagem do host')), timeout)
        waiters.push((m) => { clearTimeout(timer); resolve(m) })
      })
    },
    closed(timeout = 5000) {
      if (closeInfo) return Promise.resolve(closeInfo)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('o host não fechou a conexão')), timeout)
        closeWaiters.push((i) => { clearTimeout(timer); resolve(i) })
      })
    },
    async request(method, params, id = 1) {
      client.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
      return client.next()
    },
    close() { try { ws.close() } catch { /* already closed */ } }
  }
  return client
}

async function hello(host, overrides) {
  const client = connect(host.url)
  await client.opened
  const reply = await client.request('host.hello', helloParams(host, overrides))
  return { client, reply }
}

const errCode = (reply) => reply.error?.data?.code

test('starts, writes host-instance.json and serves /health', { skip }, async () => {
  const host = await startHost()
  const i = host.instance
  assert.equal(i.pid, host.proc.pid)
  assert.ok(Number.isInteger(i.port) && i.port > 0)
  assert.match(i.token, TOKEN_RE)
  assert.equal(typeof i.hostId, 'string')
  assert.ok(i.hostId.length >= 16)
  assert.equal(typeof i.version, 'string')
  assert.deepEqual(i.protocol, HOST_PROTOCOL)
  assert.ok(i.startedAt > Date.now() - 60_000 && i.startedAt <= Date.now() + 1000, 'startedAt is epoch ms')
  const health = await (await fetch(`http://127.0.0.1:${i.port}/health`)).json()
  assert.deepEqual(health, { ok: true, version: i.version, protocol: HOST_PROTOCOL })
  assert.ok(fs.existsSync(path.join(host.dir, 'logs')), 'logs directory created')
  await stopHost(host)
})

test('--version prints the version and exits 0', { skip }, () => {
  const run = spawnSync(BIN, ['--version'], { encoding: 'utf8' })
  assert.equal(run.status, 0)
  assert.match(run.stdout.trim(), /^\d+\.\d+\.\d+/)
})

test('bad arguments exit with code 2', { skip }, () => {
  assert.equal(spawnSync(BIN, ['--bogus'], { encoding: 'utf8' }).status, 2)
  assert.equal(spawnSync(BIN, ['--port', 'abc'], { encoding: 'utf8' }).status, 2)
  assert.equal(spawnSync(BIN, ['--idle-timeout'], { encoding: 'utf8' }).status, 2)
})

test('listens on 127.0.0.1 and honours --port', { skip }, async () => {
  const port = await new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) })
  })
  const host = await startHost({ args: ['--idle-timeout', '0', '--port', String(port)] })
  assert.equal(host.instance.port, port)
  await stopHost(host)
})

test('single instance: a second host on the same data dir exits with code 3 and leaves the first intact', { skip }, async () => {
  const first = await startHost()
  const second = spawn(BIN, ['--data-dir', first.dir, '--idle-timeout', '0'], { stdio: 'ignore', windowsHide: true })
  const code = await new Promise((resolve) => second.once('exit', resolve))
  assert.equal(code, 3)
  const after = readInstance(first.dir)
  assert.equal(after.pid, first.proc.pid)
  assert.equal(after.token, first.instance.token)
  const health = await fetch(`http://127.0.0.1:${first.instance.port}/health`)
  assert.equal(health.status, 200)
  await stopHost(first)
})

test('a new host on the same data dir keeps the same hostId but a new token', { skip }, async () => {
  const first = await startHost()
  await stopHost(first)
  const second = await startHost({ dir: first.dir })
  assert.equal(second.instance.hostId, first.instance.hostId)
  assert.notEqual(second.instance.token, first.instance.token)
  await stopHost(second)
})

test('host.hello succeeds with the token and reports the owner', { skip }, async () => {
  const host = await startHost()
  const { client, reply } = await hello(host)
  assert.equal(reply.jsonrpc, '2.0')
  assert.equal(reply.id, 1)
  assert.equal(reply.error, undefined)
  const r = reply.result
  assert.equal(r.hostId, host.instance.hostId)
  assert.equal(typeof r.hostName, 'string')
  assert.equal(r.version, host.instance.version)
  assert.deepEqual(r.protocol, HOST_PROTOCOL)
  assert.ok(Array.isArray(r.capabilities) && r.capabilities.includes('host@1'))
  assert.equal(r.user.role, 'owner')
  assert.equal(typeof r.user.name, 'string')
  client.close()
  await stopHost(host)
})

test('hello with a higher minor of the same major is accepted', { skip }, async () => {
  const host = await startHost()
  const { client, reply } = await hello(host, { protocol: { major: 1, minor: 42 } })
  assert.equal(reply.error, undefined)
  assert.deepEqual(reply.result.protocol, HOST_PROTOCOL)
  client.close()
  await stopHost(host)
})

test('a different protocol major is refused with version_mismatch (pt-BR) and the socket closes', { skip }, async () => {
  const host = await startHost()
  for (const major of [0, 2]) {
    const { client, reply } = await hello(host, { protocol: { major, minor: 0 } })
    assert.equal(errCode(reply), 'version_mismatch')
    assert.equal(reply.id, 1)
    assert.match(reply.error.message, /Atualize/)
    await client.closed()
  }
  await stopHost(host)
})

test('a wrong or empty token is refused with unauthorized', { skip }, async () => {
  const host = await startHost()
  for (const token of ['x'.repeat(64), '', host.instance.token.slice(0, -1)]) {
    const { client, reply } = await hello(host, { token })
    assert.equal(errCode(reply), 'unauthorized', `token ${token.slice(0, 5)}`)
    await client.closed()
  }
  await stopHost(host)
})

test('the version check runs before the token check', { skip }, async () => {
  const host = await startHost()
  const { client, reply } = await hello(host, { protocol: { major: 9, minor: 0 }, token: 'wrong' })
  assert.equal(errCode(reply), 'version_mismatch')
  await client.closed()
  await stopHost(host)
})

test('the first message must be host.hello with an id', { skip }, async () => {
  const host = await startHost()
  const ping = connect(host.url)
  await ping.opened
  const reply = await ping.request('host.ping')
  assert.equal(errCode(reply), 'invalid')
  await ping.closed()

  const noId = connect(host.url)
  await noId.opened
  noId.send({ jsonrpc: '2.0', method: 'host.hello', params: helloParams(host) })
  assert.equal(errCode(await noId.next()), 'invalid')
  await noId.closed()

  const garbage = connect(host.url)
  await garbage.opened
  garbage.send('isto não é json')
  assert.equal(errCode(await garbage.next()), 'invalid')
  await garbage.closed()

  const badParams = connect(host.url)
  await badParams.opened
  assert.equal(errCode(await badParams.request('host.hello', { token: 1 })), 'invalid')
  await badParams.closed()
  await stopHost(host)
})

test('host.ping answers pong with the host clock', { skip }, async () => {
  const host = await startHost()
  const { client } = await hello(host)
  const before = Date.now()
  const reply = await client.request('host.ping', undefined, 7)
  assert.equal(reply.id, 7)
  assert.equal(reply.result.pong, true)
  assert.ok(Math.abs(reply.result.at - before) < 5000)
  client.close()
  await stopHost(host)
})

test('responses match request ids, including string ids', { skip }, async () => {
  const host = await startHost()
  const { client } = await hello(host)
  client.send({ jsonrpc: '2.0', id: 'abc', method: 'host.ping' })
  assert.equal((await client.next()).id, 'abc')
  client.send({ jsonrpc: '2.0', id: 99, method: 'host.ping' })
  assert.equal((await client.next()).id, 99)
  client.close()
  await stopHost(host)
})

test('unknown methods return method_not_found; a second hello is invalid; the session survives', { skip }, async () => {
  const host = await startHost()
  const { client } = await hello(host)
  const unknown = await client.request('nope.nothing', undefined, 2)
  assert.equal(errCode(unknown), 'method_not_found')
  assert.equal(unknown.error.code, -32601)
  assert.equal(unknown.id, 2)
  const again = await client.request('host.hello', helloParams(host), 3)
  assert.equal(errCode(again), 'invalid')
  const wrongVersion = await (async () => {
    client.send({ jsonrpc: '1.0', id: 4, method: 'host.ping' })
    return client.next()
  })()
  assert.equal(errCode(wrongVersion), 'invalid')
  const stillThere = await client.request('host.ping', undefined, 5)
  assert.equal(stillThere.result.pong, true)
  client.close()
  await stopHost(host)
})

test('notifications (no id) get no reply', { skip }, async () => {
  const host = await startHost()
  const { client } = await hello(host)
  client.send({ jsonrpc: '2.0', method: 'host.ping' })
  client.send({ jsonrpc: '2.0', id: 8, method: 'host.ping' })
  const next = await client.next()
  assert.equal(next.id, 8, 'the first reply belongs to the request, not the notification')
  client.close()
  await stopHost(host)
})

test('host.shutdown by the owner replies ok, stops the host and removes host-instance.json', { skip }, async () => {
  const host = await startHost()
  const { client } = await hello(host)
  const reply = await client.request('host.shutdown', undefined, 2)
  assert.deepEqual(reply.result, { ok: true })
  const { code } = await host.exited
  assert.equal(code, 0)
  assert.equal(readInstance(host.dir), null)
  assert.ok(!fs.existsSync(path.join(host.dir, 'host-instance.json')))
  client.close()
})

test('Origin on the /rpc upgrade: UI origins pass, anything else gets 403', { skip }, async () => {
  const host = await startHost()
  const port = host.instance.port
  const upgrade = (origin) => new Promise((resolve, reject) => {
    const headers = {
      Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': Buffer.from('prism-conformance').toString('base64')
    }
    if (origin !== undefined) headers.Origin = origin
    const req = http.request({ host: '127.0.0.1', port, path: '/rpc', headers })
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode) })
    req.on('response', (res) => { res.resume(); resolve(res.statusCode) })
    req.on('error', reject)
    req.end()
  })
  for (const ok of [undefined, 'file://', 'null', 'http://localhost', 'http://localhost:5173', 'http://127.0.0.1:4000']) {
    assert.equal(await upgrade(ok), 101, `origin ${ok}`)
  }
  for (const bad of ['https://evil.example', 'http://localhost.evil.example', 'http://127.0.0.1.nip.io:80', 'http://10.0.0.2:5173', 'https://localhost:5173', 'http://localhost:5173/x']) {
    assert.equal(await upgrade(bad), 403, `origin ${bad}`)
  }
  await stopHost(host)
})

test('/files: 401 without a valid bearer token; with it PUT writes, GET reads, 404 for a missing file', { skip }, async () => {
  const host = await startHost()
  const url = `http://127.0.0.1:${host.instance.port}/files`
  const auth = { Authorization: `Bearer ${host.instance.token}` }
  assert.equal((await fetch(url)).status, 401)
  assert.equal((await fetch(url, { headers: { Authorization: 'Bearer nope' } })).status, 401)
  assert.equal((await fetch(url, { headers: { Authorization: host.instance.token } })).status, 401, 'needs the Bearer prefix')
  assert.equal((await fetch(url, { method: 'POST' })).status, 401, 'any method is checked')
  assert.equal((await fetch(`${url}?path=x`, { method: 'PUT', body: 'x', headers: { Authorization: 'Bearer nope' } })).status, 401)

  const file = path.join(host.dir, 'files-roundtrip.bin')
  const q = (p) => `${url}?path=${encodeURIComponent(p)}`
  const put = await fetch(q(file), { method: 'PUT', headers: auth, body: Buffer.from([1, 2, 3, 255]) })
  assert.equal(put.status, 200)
  assert.equal((await put.json()).path, file)
  const got = await fetch(q(file), { headers: auth })
  assert.equal(got.status, 200)
  assert.deepEqual([...new Uint8Array(await got.arrayBuffer())], [1, 2, 3, 255])
  const missing = await fetch(q(path.join(host.dir, 'nope.bin')), { headers: auth })
  assert.equal(missing.status, 404)
  assert.equal((await missing.json()).code, 'not_found')
  await stopHost(host)
})

test('idle timeout: with no clients the host stops and removes host-instance.json', { skip }, async () => {
  const host = await startHost({ args: ['--idle-timeout', '1'] })
  const { code } = await Promise.race([host.exited, sleep(20_000).then(() => assert.fail('o host não encerrou por ociosidade'))])
  assert.equal(code, 0)
  assert.equal(readInstance(host.dir), null)
})

test('idle timeout: a connected client keeps the host alive, and leaving starts the countdown', { skip }, async () => {
  const host = await startHost({ args: ['--idle-timeout', '2'] })
  const { client } = await hello(host)
  let exited = false
  host.exited.then(() => { exited = true })
  await sleep(4500)
  assert.equal(exited, false, 'client connected: host stays up past the timeout')
  assert.equal((await client.request('host.ping', undefined, 2)).result.pong, true)
  client.close()
  await Promise.race([host.exited, sleep(20_000).then(() => assert.fail('o host não encerrou depois que o cliente saiu'))])
  assert.equal(readInstance(host.dir), null)
})

test('a failed handshake does not count as a client', { skip }, async () => {
  const host = await startHost({ args: ['--idle-timeout', '2'] })
  const { client } = await hello(host, { token: 'wrong' })
  await client.closed()
  const { code } = await Promise.race([host.exited, sleep(20_000).then(() => assert.fail('o host não encerrou'))])
  assert.equal(code, 0)
})

test('--idle-timeout 0 disables the idle shutdown', { skip }, async () => {
  const host = await startHost({ args: ['--idle-timeout', '0'] })
  let exited = false
  host.exited.then(() => { exited = true })
  await sleep(2500)
  assert.equal(exited, false)
  await stopHost(host)
})
