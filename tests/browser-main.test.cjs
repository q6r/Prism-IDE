const test = require('node:test')
const assert = require('node:assert/strict')
const load = require('./helpers/load-typescript.cjs')

const b = load('src/main/ipc/browser.ts', { electron: {}, child_process: { execFile() {} }, path: require('path') })
const m = load('src/renderer/src/components/browser/browserModel.ts')

test('parseWindowsNetstat', () => {
  const text = [
    '  Proto  Endereço local  Endereço externo  Estado  PID',
    '  TCP    0.0.0.0:5173           0.0.0.0:0              ESCUTANDO       1234',
    '  TCP    127.0.0.1:3000         0.0.0.0:0              LISTENING       2222',
    '  TCP    [::1]:8080             [::]:0                 LISTENING       3333',
    '  TCP    [::]:9000              [::]:0                 LISTENING       4444',
    '  TCP    127.0.0.1:3001         127.0.0.1:50000        ESTABLISHED     5555',
    '  TCP    192.168.1.5:4000       0.0.0.0:0              LISTENING       6666',
    '  TCP    0.0.0.0:445            0.0.0.0:0              LISTENING       4',
    '  TCP    0.0.0.0:100            0.0.0.0:0              LISTENING       0'
  ].join('\r\n')
  assert.deepEqual(b.parseWindowsNetstat(text), [
    { port: 5173, pid: 1234 }, { port: 3000, pid: 2222 }, { port: 8080, pid: 3333 }, { port: 9000, pid: 4444 }
  ])
})

test('process list / lsof / ss / ps parsers', () => {
  assert.deepEqual(b.parseWindowsProcessList('10|1|node.exe\r\ngarbage\n|2|x\n11|10|a|b\nx|1|y'), [
    { pid: 10, ppid: 1, name: 'node.exe' }, { pid: 11, ppid: 10, name: 'a|b' }
  ])
  assert.deepEqual(b.parseLsof('p100\ncnode\nn*:8000\nn127.0.0.1:8001\nn10.0.0.2:9000\np200\ncpython\nn[::1]:7000 (LISTEN)'), [
    { port: 8000, pid: 100, name: 'node' }, { port: 8001, pid: 100, name: 'node' }, { port: 7000, pid: 200, name: 'python' }
  ])
  const ss = [
    'LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:(("node",pid=1234,fd=3))',
    'LISTEN 0 511 10.0.0.2:3001 0.0.0.0:* users:(("node",pid=1235,fd=3))',
    'LISTEN 0 511 *:3002 *:*'
  ].join('\n')
  assert.deepEqual(b.parseSs(ss), [{ port: 3000, pid: 1234, name: 'node' }])
  assert.deepEqual(b.parsePs('  1     0 /sbin/init\n 20  1 /usr/bin/node\nbad'), [
    { pid: 1, ppid: 0, name: 'init' }, { pid: 20, ppid: 1, name: 'node' }
  ])
})

test('descendantPids / collectLocalServers', () => {
  const procs = [
    { pid: 1, ppid: 0, name: 'root' }, { pid: 2, ppid: 1, name: 'shell' }, { pid: 3, ppid: 2, name: 'node.exe' },
    { pid: 4, ppid: 1, name: 'Prism.exe' }, { pid: 5, ppid: 99, name: 'other' }, { pid: 6, ppid: 6, name: 'loop' },
    { pid: 7, ppid: 8, name: 'a' }, { pid: 8, ppid: 7, name: 'b' }
  ]
  assert.deepEqual([...b.descendantPids(procs, 1)].sort(), [2, 3, 4])
  assert.deepEqual([...b.descendantPids(procs, 7)].sort(), [8])
  const sockets = [
    { port: 5173, pid: 3 }, { port: 5173, pid: 2 }, { port: 3000, pid: 2, name: 'x' }, { port: 4000, pid: 4 },
    { port: 5000, pid: 5 }, { port: 6000, pid: 1 }, { port: 7000, pid: 50 }
  ]
  assert.deepEqual(b.collectLocalServers(sockets, procs, 1, ['prism.EXE']), [
    { port: 3000, pid: 2, processName: 'shell' }, { port: 5173, pid: 3, processName: 'node' }
  ])
})

test('small helpers', () => {
  for (const h of ['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0', '::', '*']) assert.ok(b.isLocalListenHost(h), h)
  for (const h of ['192.168.0.1', 'example.com']) assert.ok(!b.isLocalListenHost(h), h)
  const ua = 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Prism-IDE/1.0.0 Chrome/120.0.0.0 Electron/30.0.0 Safari/537.36'
  assert.equal(b.chromeLikeUserAgent(ua, 'Prism IDE'), 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
  assert.equal(b.chromeLikeUserAgent('A/1 prism/2 Chrome/1', 'Prism'), 'A/1 Chrome/1')
  assert.ok(b.cookieBelongsToSite('.example.com', 'example.com'))
  assert.ok(b.cookieBelongsToSite('a.example.com', 'example.com'))
  assert.ok(b.cookieBelongsToSite('example.com', 'example.com'))
  assert.ok(!b.cookieBelongsToSite('notexample.com', 'example.com'))
  assert.ok(!b.cookieBelongsToSite(undefined, 'example.com'))
  assert.equal(b.faviconContentType('image/png;charset=x', 'https://a/x'), 'image/png')
  assert.equal(b.faviconContentType('application/octet-stream', 'https://a/favicon.ico'), 'image/x-icon')
  assert.equal(b.faviconContentType(null, 'https://a/favicon.ico?v=1'), 'image/x-icon')
  assert.equal(b.faviconContentType('text/html', 'https://a/favicon.ico'), null)
  assert.equal(b.faviconContentType('', 'https://a/x.png'), null)
})

test('isAppForwardedChord', () => {
  const k = (key, mods = {}) => ({ key, code: '', ctrl: true, meta: false, shift: false, alt: false, ...mods })
  assert.ok(b.isAppForwardedChord(k('P', { shift: true })))
  assert.ok(b.isAppForwardedChord(k('N', { shift: true })))
  assert.ok(b.isAppForwardedChord(k('`')))
  assert.ok(b.isAppForwardedChord(k(',')))
  for (const x of ['b', 'p', 's']) assert.ok(!b.isAppForwardedChord(k(x)))
  assert.ok(!b.isAppForwardedChord(k('p', { ctrl: false, shift: true })))
  assert.ok(!b.isAppForwardedChord(k(',', { alt: true })))
})

test('parity: browserChordForKey main vs renderer', () => {
  const keys = ['t', 'T', 'w', 'W', 'l', 'f', 'F', 'r', 'R', 'i', 'I', 'd', 'b', 'p', 'a', 'Tab', 'PageDown', 'PageUp', '=', '+', '-', '_', '0', '1', '5', '9',
    'F5', 'F6', 'F12', 'ArrowLeft', 'ArrowRight', 'BrowserBack', 'BrowserForward', 'BrowserRefresh', 'Enter', '`', ',']
  const codes = ['', 'KeyT', 'Equal', 'Minus', 'NumpadAdd', 'NumpadSubtract', 'Digit0', 'Numpad0', 'Digit1', 'Digit5', 'Digit9']
  let n = 0
  for (const k of keys) for (const code of codes) for (let bits = 0; bits < 16; bits++) {
    const input = { key: k, code, ctrl: !!(bits & 1), meta: !!(bits & 2), shift: !!(bits & 4), alt: !!(bits & 8) }
    assert.equal(b.browserChordForKey(input), m.browserChordForKey(input), JSON.stringify(input))
    n++
  }
  assert.ok(n > 5000)
})

test('parity: registrableDomain main vs renderer', () => {
  const urls = ['https://a.b.example.com', 'https://x.example.com.br', 'https://x.foo.co.uk', 'https://example.com.', 'http://localhost:3000', 'http://10.1.2.3',
    'http://[::1]:80', 'file:///x', 'about:blank', '', 'garbage', 'https://co.uk', 'https://a.co.uk', 'https://WWW.Example.COM/x', 'https://a.b.c.d.ac.jp',
    'https://sub.gov.au', 'ftp://a.com', 'https://xn--e1afmkfd.xn--p1ai']
  for (const u of urls) assert.equal(b.registrableDomain(u), m.registrableDomain(u), u)
})
