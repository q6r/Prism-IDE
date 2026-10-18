const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const loadTypescript = require('./helpers/load-typescript.cjs')

const version = loadTypescript('src/shared/host/version.ts')
const stubs = {
  electron: { app: {}, ipcMain: { handle() {} } },
  child_process: { spawn() { throw new Error('not in tests') } },
  fs: { existsSync: () => false, readFileSync: () => '' },
  path,
  '../../shared/host/version': version
}
const { parseInstance, compatible, hostBinaryCandidates } = loadTypescript('src/main/host/supervisor.ts', stubs)

const TOKEN = 'a'.repeat(64)
const valid = () => ({
  pid: 123, port: 5000, hostId: 'abc', version: '0.2.0',
  protocol: { major: 1, minor: 0 }, startedAt: 1700000000000, token: TOKEN
})

test('parseInstance accepts a complete instance file', () => {
  assert.deepEqual(parseInstance(JSON.stringify(valid())), valid())
  assert.ok(parseInstance(JSON.stringify({ ...valid(), token: 'x'.repeat(32) })), '32 chars is the minimum')
})

test('parseInstance rejects missing or mistyped fields', () => {
  for (const key of ['pid', 'port', 'hostId', 'version', 'protocol', 'startedAt', 'token']) {
    const v = valid()
    delete v[key]
    assert.equal(parseInstance(JSON.stringify(v)), null, `missing ${key}`)
  }
  assert.equal(parseInstance(JSON.stringify({ ...valid(), pid: '123' })), null)
  assert.equal(parseInstance(JSON.stringify({ ...valid(), port: 0 })), null)
  assert.equal(parseInstance(JSON.stringify({ ...valid(), port: -1 })), null)
  assert.equal(parseInstance(JSON.stringify({ ...valid(), protocol: { major: 1 } })), null)
  assert.equal(parseInstance(JSON.stringify({ ...valid(), startedAt: '1' })), null)
})

test('parseInstance rejects short tokens', () => {
  assert.equal(parseInstance(JSON.stringify({ ...valid(), token: 'x'.repeat(31) })), null)
  assert.equal(parseInstance(JSON.stringify({ ...valid(), token: '' })), null)
  assert.equal(parseInstance(JSON.stringify({ ...valid(), token: 12345678 })), null)
})

test('parseInstance returns null for broken or non-object JSON', () => {
  assert.equal(parseInstance(''), null)
  assert.equal(parseInstance('{"pid": 1,'), null)
  assert.equal(parseInstance('not json'), null)
  assert.equal(parseInstance('null'), null)
  assert.equal(parseInstance('[]'), null)
  assert.equal(parseInstance('42'), null)
})

test('compatible compares only the protocol major', () => {
  const major = version.HOST_PROTOCOL.major
  assert.equal(compatible({ protocol: { major, minor: 0 } }), true)
  assert.equal(compatible({ protocol: { major, minor: 99 } }), true)
  assert.equal(compatible({ protocol: { major: major + 1, minor: 0 } }), false)
  assert.equal(compatible({ protocol: { major: major - 1, minor: 0 } }), false)
})

const base = { env: {}, packaged: false, resourcesPath: path.join('R', 'resources'), appPath: path.join('A', 'app'), platform: 'win32' }

test('hostBinaryCandidates in development: release before debug, .exe on win32', () => {
  assert.deepEqual(hostBinaryCandidates(base), [
    path.join('A', 'app', 'host', 'target', 'release', 'prism-host.exe'),
    path.join('A', 'app', 'host', 'target', 'debug', 'prism-host.exe')
  ])
})

test('hostBinaryCandidates has no .exe on other platforms', () => {
  for (const platform of ['linux', 'darwin']) {
    const list = hostBinaryCandidates({ ...base, platform })
    assert.equal(list.length, 2)
    assert.ok(list.every((p) => path.basename(p) === 'prism-host'), platform)
  }
})

test('PRISM_HOST_BIN override comes first', () => {
  const list = hostBinaryCandidates({ ...base, env: { PRISM_HOST_BIN: 'C:\\custom\\host.exe' } })
  assert.equal(list[0], 'C:\\custom\\host.exe')
  assert.equal(list.length, 3)
})

test('an empty PRISM_HOST_BIN is ignored', () => {
  assert.equal(hostBinaryCandidates({ ...base, env: { PRISM_HOST_BIN: '' } }).length, 2)
})

test('packaged builds look in resources/host before the dev paths', () => {
  const list = hostBinaryCandidates({ ...base, packaged: true, env: { PRISM_HOST_BIN: 'X' } })
  assert.deepEqual(list.slice(0, 2), ['X', path.join('R', 'resources', 'host', 'prism-host.exe')])
  assert.equal(list.length, 4)
  assert.ok(!hostBinaryCandidates(base).some((p) => p.includes('resources')), 'dev build does not look in resources')
})
