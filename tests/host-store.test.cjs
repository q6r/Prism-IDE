// Conformance of the store domain (store@1) against the real prism-host binary.
// Skipped when there is no binary and no cargo to build one.
const assert = require('node:assert/strict')
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

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
  const proc = spawn(BIN, ['--data-dir', dir, ...args], { env: { ...process.env, PRISM_APP_DATA_DIR: path.join(dir, 'isolated-desktop') }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
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

test('host.hello advertises store@1', { skip }, async () => {
  const host = await startHost()
  const { client, reply } = await hello(host)
  assert.ok(reply.result.capabilities.includes('store@1'), JSON.stringify(reply.result.capabilities))
  client.close()
  await stopHost(host)
})

test('store.stats on a fresh data dir reports an empty database and creates prism-host.db', { skip }, async () => {
  const host = await startHost()
  const { client } = await hello(host)
  const reply = await client.request('store.stats', undefined, 2)
  assert.equal(reply.error, undefined, JSON.stringify(reply.error))
  const r = reply.result
  assert.equal(r.schemaVersion, 1)
  assert.equal(r.events, 0)
  assert.deepEqual(r.documents, {})
  assert.equal(r.imported, null)
  const rel = path.relative(fs.realpathSync(host.dir), fs.realpathSync(path.dirname(r.path)))
  assert.ok(rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)), `path outside data dir: ${r.path}`)
  assert.equal(path.basename(r.path), 'prism-host.db')
  assert.ok(fs.existsSync(path.join(host.dir, 'prism-host.db')))
  client.close()
  await stopHost(host)
})

test('store.nope returns method_not_found', { skip }, async () => {
  const host = await startHost()
  const { client } = await hello(host)
  const reply = await client.request('store.nope', undefined, 2)
  assert.equal(errCode(reply), 'method_not_found')
  assert.equal(reply.error.code, -32601)
  client.close()
  await stopHost(host)
})
