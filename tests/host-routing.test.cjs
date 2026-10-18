const assert = require('node:assert/strict')
const test = require('node:test')
const loadTypescript = require('./helpers/load-typescript.cjs')

const { routeFor, routed, HOST_READY_DOMAINS } = loadTypescript('src/shared/host/routing.ts')

test('only ported domains are host-ready', () => {
  assert.ok(HOST_READY_DOMAINS.includes('terminal'))
  assert.equal(routeFor('files', ['files@1', 'host@1'], []), 'ipc')
})

test('routeFor needs the domain ready AND advertised at major 1', () => {
  const caps = ['host@1', 'files@1']
  assert.equal(routeFor('files', caps, ['files']), 'host')
  assert.equal(routeFor('files', [], ['files']), 'ipc', 'ready but not advertised')
  assert.equal(routeFor('files', caps, []), 'ipc', 'advertised but not ready')
  assert.equal(routeFor('git', caps, ['files']), 'ipc')
  assert.equal(routeFor('files', ['files@2'], ['files']), 'ipc', 'other major')
  assert.equal(routeFor('file', caps, ['file']), 'ipc', 'no prefix matching')
})

test('routed decides at call time, not at build time', () => {
  const ipc = { read: (x) => `ipc:${x}` }
  const host = { read: (x) => `host:${x}` }
  let side = 'ipc'
  let hostAvailable = true
  const api = routed('files', ipc, () => (hostAvailable ? host : null), () => side)
  assert.equal(api.read(1), 'ipc:1')
  side = 'host'
  assert.equal(api.read(2), 'host:2')
  hostAvailable = false
  assert.equal(api.read(3), 'ipc:3', 'host side gone')
  hostAvailable = true
  side = 'ipc'
  assert.equal(api.read(4), 'ipc:4')
})

test('routed only consults the host side when routed there, and passes the domain', () => {
  const asked = []
  let hostCalls = 0
  const api = routed('files', { a: () => 'ipc' }, () => { hostCalls++; return { a: () => 'host' } }, (d) => { asked.push(d); return 'ipc' })
  api.a()
  assert.equal(hostCalls, 0)
  assert.deepEqual(asked, ['files'])
})

test('members missing on the host fall back to IPC; non-functions on the host are ignored', () => {
  const ipc = { read: () => 'ipc-read', write: () => 'ipc-write', kind: () => 'ipc-kind' }
  const api = routed('files', ipc, () => ({ read: () => 'host-read', kind: 'not a function' }), () => 'host')
  assert.equal(api.read(), 'host-read')
  assert.equal(api.write(), 'ipc-write')
  assert.equal(api.kind(), 'ipc-kind')
})

test('non-function members are copied from IPC; args pass through; promises are returned as-is', async () => {
  const ipc = { version: '1.0', limits: { max: 3 }, fetch: async () => 'ipc' }
  const calls = []
  const api = routed('x', ipc, () => ({ fetch: async (...args) => { calls.push(args); return 'host' } }), () => 'host')
  assert.equal(api.version, '1.0')
  assert.equal(api.limits, ipc.limits)
  assert.equal(await api.fetch(1, { a: 2 }), 'host')
  assert.deepEqual(calls, [[1, { a: 2 }]])
  assert.deepEqual(Object.keys(api).sort(), ['fetch', 'limits', 'version'])
})

test('members only on the host side are not exposed', () => {
  const api = routed('x', { a: () => 1 }, () => ({ a: () => 2, extra: () => 3 }), () => 'host')
  assert.equal('extra' in api, false)
})
