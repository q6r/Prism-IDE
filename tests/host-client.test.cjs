const assert = require('node:assert/strict')
const test = require('node:test')
const loadTypescript = require('./helpers/load-typescript.cjs')

const version = loadTypescript('src/shared/host/version.ts')
const { HostClient, HostCallError } = loadTypescript('src/shared/host/client.ts', { './version': version })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(predicate, label, timeout = 1500) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeout) assert.fail(`timeout waiting for ${label}`)
    await sleep(2)
  }
}

function makeSockets() {
  const sockets = []
  class FakeSocket {
    constructor(url) {
      this.url = url
      this.readyState = 0
      this.sent = []
      this.closed = null
      this.onopen = this.onmessage = this.onclose = this.onerror = null
      sockets.push(this)
    }
    send(data) { this.sent.push(JSON.parse(data)) }
    close(code, reason) {
      if (this.readyState === 3) return
      this.closed = { code, reason }
      this.readyState = 3
      this.onclose?.({})
    }
    // test helpers
    open() { this.readyState = 1; this.onopen?.({}) }
    receive(message) { this.onmessage?.({ data: JSON.stringify(message) }) }
    drop() { this.readyState = 3; this.onclose?.({}) }
    helloReply(result) { this.receive({ jsonrpc: '2.0', id: this.sent[0].id, result }) }
    helloError(code, message = 'recusado') {
      this.receive({ jsonrpc: '2.0', id: this.sent[0].id, error: { code: -32000, message, data: { code } } })
    }
  }
  return { sockets, FakeSocket }
}

const HELLO = {
  hostId: 'h1', hostName: 'pc', version: '0.2.0', protocol: { major: 1, minor: 0 },
  capabilities: ['host@1', 'files@1'], user: { id: 'owner', name: 'q6r', role: 'owner' }
}

function setup(overrides = {}) {
  const { sockets, FakeSocket } = makeSockets()
  let endpoint = { url: 'ws://127.0.0.1:1234/rpc', token: 't'.repeat(64) }
  const resolves = { count: 0 }
  const client = new HostClient({
    resolve: async () => { resolves.count++; return typeof endpoint === 'function' ? endpoint() : endpoint },
    client: { kind: 'desktop', version: '9.9.9' },
    WebSocket: FakeSocket,
    backoffMs: [5, 5, 5],
    callTimeoutMs: 200,
    ...overrides
  })
  return { client, sockets, resolves, setEndpoint: (e) => { endpoint = e } }
}

async function connected(ctx) {
  ctx.client.start()
  await until(() => ctx.sockets.length >= 1, 'socket')
  const ws = ctx.sockets[ctx.sockets.length - 1]
  ws.open()
  ws.helloReply(HELLO)
  await until(() => ctx.client.status().state === 'connected', 'connected')
  return ws
}

test('hello success: connected, capabilities and serves()', async () => {
  const ctx = setup()
  const seen = []
  ctx.client.onStatus((s) => seen.push(s.state))
  assert.equal(ctx.client.status().state, 'idle')
  assert.deepEqual(ctx.client.capabilities(), [])
  assert.equal(ctx.client.serves('files'), false)
  const ws = await connected(ctx)
  assert.equal(ws.url, 'ws://127.0.0.1:1234/rpc')
  assert.deepEqual(ctx.client.capabilities(), ['host@1', 'files@1'])
  assert.equal(ctx.client.serves('files'), true)
  assert.equal(ctx.client.serves('files', 2), false)
  assert.equal(ctx.client.serves('git'), false)
  assert.equal(ctx.client.status().hello.user.role, 'owner')
  assert.deepEqual(seen.slice(0, 1), ['idle'])
  assert.ok(seen.includes('connecting') && seen.at(-1) === 'connected')
  ctx.client.stop()
})

test('hello message carries protocol, client info and token', async () => {
  const ctx = setup()
  const ws = await connected(ctx)
  const hello = ws.sent[0]
  assert.equal(hello.jsonrpc, '2.0')
  assert.equal(hello.method, 'host.hello')
  assert.equal(typeof hello.id, 'number')
  assert.deepEqual(hello.params, {
    protocol: { major: version.HOST_PROTOCOL.major, minor: version.HOST_PROTOCOL.minor },
    client: { kind: 'desktop', version: '9.9.9' },
    token: 't'.repeat(64)
  })
  ctx.client.stop()
})

test('endpoint clientVersion overrides the configured client version in hello', async () => {
  const ctx = setup()
  ctx.setEndpoint({ url: 'ws://x/rpc', token: 'tok', clientVersion: '1.2.3' })
  const ws = await connected(ctx)
  assert.equal(ws.sent[0].params.client.version, '1.2.3')
  assert.equal(ws.sent[0].params.client.kind, 'desktop')
  ctx.client.stop()
})

test('call resolves with the result and sends params only when given', async () => {
  const ctx = setup()
  const ws = await connected(ctx)
  const withParams = ctx.client.call('host.ping', { a: 1 })
  const bare = ctx.client.call('host.ping')
  const [m1, m2] = ws.sent.slice(1)
  assert.deepEqual(m1.params, { a: 1 })
  assert.ok(!('params' in m2))
  assert.notEqual(m1.id, m2.id)
  ws.receive({ jsonrpc: '2.0', id: m2.id, result: 'second' })
  ws.receive({ jsonrpc: '2.0', id: m1.id, result: 'first' })
  assert.equal(await withParams, 'first')
  assert.equal(await bare, 'second')
  ctx.client.stop()
})

test('call rejects with HostCallError carrying the host error code', async () => {
  const ctx = setup()
  const ws = await connected(ctx)
  const call = ctx.client.call('nope.x')
  ws.receive({ jsonrpc: '2.0', id: ws.sent[1].id, error: { code: -32601, message: 'Método desconhecido', data: { code: 'method_not_found' } } })
  await assert.rejects(call, (err) => {
    assert.ok(err instanceof HostCallError)
    assert.ok(err instanceof Error)
    assert.equal(err.name, 'HostCallError')
    assert.equal(err.code, 'method_not_found')
    assert.equal(err.message, 'Método desconhecido')
    return true
  })
  const second = ctx.client.call('x')
  ws.receive({ jsonrpc: '2.0', id: ws.sent[2].id, error: { code: -1, message: 'boom' } })
  await assert.rejects(second, (err) => err.code === 'internal')
  ctx.client.stop()
})

test('notifications reach listeners by method; unsubscribe stops them', async () => {
  const ctx = setup()
  const ws = await connected(ctx)
  const got = []
  const off = ctx.client.onNotification('files.changed', (p) => got.push(p))
  ctx.client.onNotification('other', () => got.push('wrong'))
  ws.receive({ jsonrpc: '2.0', method: 'files.changed', params: { path: 'a' } })
  ws.receive({ jsonrpc: '2.0', method: 'unheard', params: {} })
  assert.deepEqual(got, [{ path: 'a' }])
  off()
  ws.receive({ jsonrpc: '2.0', method: 'files.changed', params: { path: 'b' } })
  assert.deepEqual(got, [{ path: 'a' }])
  ctx.client.stop()
})

test('malformed frames and unknown ids are ignored', async () => {
  const ctx = setup()
  const ws = await connected(ctx)
  ws.onmessage({ data: 'not json' })
  ws.receive({ jsonrpc: '2.0', id: 9999, result: 1 })
  ws.receive({ jsonrpc: '2.0', id: 'str', result: 1 })
  assert.equal(ctx.client.status().state, 'connected')
  ctx.client.stop()
})

test('a dropped connection rejects pending calls with disconnected and reconnects', async () => {
  const ctx = setup()
  const ws = await connected(ctx)
  const pending = ctx.client.call('slow.thing')
  ws.drop()
  await assert.rejects(pending, (err) => err instanceof HostCallError && err.code === 'disconnected')
  assert.equal(ctx.client.status().state, 'reconnecting')
  assert.equal(ctx.client.status().attempt, 1)
  assert.deepEqual(ctx.client.capabilities(), [])
  await until(() => ctx.sockets.length === 2, 'second socket')
  const ws2 = ctx.sockets[1]
  ws2.open()
  ws2.helloReply(HELLO)
  await until(() => ctx.client.status().state === 'connected', 'reconnected')
  assert.equal(ctx.client.status().attempt, 0)
  const call = ctx.client.call('host.ping')
  ws2.receive({ jsonrpc: '2.0', id: ws2.sent[1].id, result: { pong: true } })
  assert.deepEqual(await call, { pong: true })
  ctx.client.stop()
})

test('a socket that never connects keeps being retried with backoff', async () => {
  const ctx = setup()
  ctx.client.start()
  await until(() => ctx.sockets.length === 1, 'first')
  ctx.sockets[0].drop()
  await until(() => ctx.sockets.length === 2, 'second')
  ctx.sockets[1].drop()
  await until(() => ctx.sockets.length === 3, 'third')
  assert.ok(ctx.client.status().attempt >= 2)
  ctx.client.stop()
})

test('version_mismatch makes the client incompatible and it does not retry', async () => {
  const ctx = setup()
  ctx.client.start()
  await until(() => ctx.sockets.length === 1, 'socket')
  const ws = ctx.sockets[0]
  ws.open()
  ws.helloError('version_mismatch', 'Atualize o Prism ou o host.')
  await sleep(60)
  assert.equal(ctx.client.status().state, 'incompatible')
  assert.equal(ctx.client.status().error, 'Atualize o Prism ou o host.')
  assert.equal(ctx.sockets.length, 1)
  assert.equal(ctx.resolves.count, 1)
  assert.deepEqual(ctx.client.capabilities(), [])
  ctx.client.stop()
})

test('unauthorized is retried (a restarted host writes a new token)', async () => {
  const ctx = setup()
  ctx.client.start()
  await until(() => ctx.sockets.length === 1, 'socket')
  ctx.sockets[0].open()
  ctx.sockets[0].helloError('unauthorized', 'Token inválido.')
  assert.equal(ctx.client.status().state, 'unauthorized')
  assert.equal(ctx.client.status().error, 'Token inválido.')
  ctx.setEndpoint({ url: 'ws://127.0.0.1:1234/rpc', token: 'new-token' })
  await until(() => ctx.sockets.length === 2, 'retry socket')
  const ws = ctx.sockets[1]
  ws.open()
  assert.equal(ws.sent[0].params.token, 'new-token')
  ws.helloReply(HELLO)
  await until(() => ctx.client.status().state === 'connected', 'connected')
  assert.equal(ctx.client.status().error, undefined)
  ctx.client.stop()
})

test('a null resolve is unavailable and retried until a host appears', async () => {
  const ctx = setup()
  ctx.setEndpoint(null)
  ctx.client.start()
  await until(() => ctx.resolves.count >= 3, 'repeated resolves')
  assert.equal(ctx.client.status().state, 'unavailable')
  assert.ok(ctx.client.status().attempt >= 2)
  assert.ok(ctx.client.status().error)
  assert.equal(ctx.sockets.length, 0)
  ctx.setEndpoint({ url: 'ws://127.0.0.1:1234/rpc', token: 'tok' })
  await until(() => ctx.sockets.length === 1, 'socket after host appears')
  ctx.sockets[0].open()
  ctx.sockets[0].helloReply(HELLO)
  await until(() => ctx.client.status().state === 'connected', 'connected')
  ctx.client.stop()
})

test('a throwing resolve counts as unavailable', async () => {
  const ctx = setup()
  ctx.setEndpoint(() => { throw new Error('boom') })
  ctx.client.start()
  await until(() => ctx.resolves.count >= 2, 'retry')
  assert.equal(ctx.client.status().state, 'unavailable')
  ctx.client.stop()
})

test('stop() goes idle, closes the socket, rejects pending calls and stops retrying', async () => {
  const ctx = setup()
  const ws = await connected(ctx)
  const pending = ctx.client.call('slow.thing')
  ctx.client.stop()
  await assert.rejects(pending, (err) => err.code === 'disconnected')
  assert.equal(ctx.client.status().state, 'idle')
  assert.equal(ctx.client.status().hello, undefined)
  assert.equal(ws.closed.code, 1000)
  await sleep(40)
  assert.equal(ctx.sockets.length, 1)
  await assert.rejects(ctx.client.call('x'), (err) => err.code === 'disconnected')
})

test('stop() during resolve prevents any connection', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const ctx = setup({ resolve: async () => { await gate; return { url: 'ws://x/rpc', token: 't' } } })
  ctx.client.start()
  ctx.client.stop()
  release()
  await sleep(20)
  assert.equal(ctx.sockets.length, 0)
  assert.equal(ctx.client.status().state, 'idle')
})

test('start() is idempotent and restartable after stop()', async () => {
  const ctx = setup()
  ctx.client.start()
  ctx.client.start()
  await until(() => ctx.sockets.length === 1, 'socket')
  await sleep(20)
  assert.equal(ctx.sockets.length, 1)
  ctx.client.stop()
  ctx.client.start()
  await until(() => ctx.sockets.length === 2, 'socket after restart')
  ctx.client.stop()
})

test('a call made while connecting waits for the connection', async () => {
  const ctx = setup({ callTimeoutMs: 1000 })
  ctx.client.start()
  await until(() => ctx.sockets.length === 1, 'socket')
  const ws = ctx.sockets[0]
  let settled = false
  const call = ctx.client.call('host.ping').then((v) => { settled = true; return v })
  await sleep(20)
  assert.equal(settled, false)
  assert.equal(ws.sent.length, 0)
  ws.open()
  ws.helloReply(HELLO)
  await until(() => ws.sent.length === 2, 'call sent after hello')
  assert.equal(ws.sent[0].method, 'host.hello')
  assert.equal(ws.sent[1].method, 'host.ping')
  ws.receive({ jsonrpc: '2.0', id: ws.sent[1].id, result: 'pong' })
  assert.equal(await call, 'pong')
  ctx.client.stop()
})

test('a call that waits too long for a connection is rejected', async () => {
  const ctx = setup()
  ctx.client.start()
  await until(() => ctx.sockets.length === 1, 'socket')
  const started = Date.now()
  await assert.rejects(ctx.client.call('host.ping', undefined, 40), (err) => err instanceof HostCallError && err.code === 'disconnected')
  assert.ok(Date.now() - started < 500)
  ctx.client.stop()
})

test('a call the host never answers times out and is forgotten', async () => {
  const ctx = setup()
  const ws = await connected(ctx)
  await assert.rejects(ctx.client.call('hang', undefined, 30), (err) => err instanceof HostCallError && err.code === 'timeout')
  ws.receive({ jsonrpc: '2.0', id: ws.sent[1].id, result: 'late' })
  assert.equal(ctx.client.status().state, 'connected')
  const started = Date.now()
  await assert.rejects(ctx.client.call('hang2'), (err) => err.code === 'timeout')
  assert.ok(Date.now() - started >= 150)
  ctx.client.stop()
})

test('onStatus replays the current status and unsubscribes', async () => {
  const ctx = setup()
  const seen = []
  const off = ctx.client.onStatus((s) => seen.push(s.state))
  assert.deepEqual(seen, ['idle'])
  off()
  ctx.client.start()
  await until(() => ctx.sockets.length === 1, 'socket')
  assert.deepEqual(seen, ['idle'])
  ctx.client.stop()
})
