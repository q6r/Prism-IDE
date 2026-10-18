const test = require('node:test')
const assert = require('node:assert/strict')
const load = require('./helpers/load-typescript.cjs')

const b = load('src/main/ipc/browser.ts', { electron: {}, child_process: { execFile() {} }, path: require('path') })
const m = load('src/renderer/src/components/browser/browserModel.ts')

const LOOPBACK_TRUE = ['127.0.0.1', '127.255.255.255', '127.1.2.3', 'localhost', 'LOCALHOST.', 'app.localhost', '[::1]', '::1']
const LOOPBACK_FALSE = ['127.evil.example', '127.0.0.1.attacker.example', '127.app.203.0.113.5.nip.io', '127.256.0.1', '127.0.0', '0.0.0.0',
  'evil.localhost.com', 'localhost.evil.com', '', '1.127.0.0.1', '127.0.0.1.', 'example.com', '::2', '[::2]', '127.01.0.1x']

test('isLoopbackHostname: strict, both copies', () => {
  for (const impl of [b, m]) {
    for (const h of LOOPBACK_TRUE) assert.equal(impl.isLoopbackHostname(h), true, h)
    for (const h of LOOPBACK_FALSE) {
      // '127.0.0.1.' has a trailing dot: it is loopback by the FQDN rule, so exclude it from the false list
      if (h === '127.0.0.1.') continue
      assert.equal(impl.isLoopbackHostname(h), false, h)
    }
  }
  for (const h of [...LOOPBACK_TRUE, ...LOOPBACK_FALSE, '127.0.0.1.', '128.0.0.1', 'a.b.localhost', 'LocalHost', '[::1]:80', '0:0:0:0:0:0:0:1'])
    assert.equal(b.isLoopbackHostname(h), m.isLoopbackHostname(h), h)
})

test('isLoopbackUrl', () => {
  assert.equal(b.isLoopbackUrl('https://127.evil.example/'), false)
  assert.equal(b.isLoopbackUrl('http://127.0.0.1:3000'), true)
  assert.equal(b.isLoopbackUrl('http://[::1]:8080/'), true)
  assert.equal(b.isLoopbackUrl('file:///c:/'), false)
  assert.equal(b.isLoopbackUrl(undefined), false)
  assert.equal(b.isLoopbackUrl('not a url'), false)
  assert.equal(b.isLoopbackUrl('ftp://127.0.0.1/'), false)
  assert.equal(b.isLoopbackUrl('http://localhost.evil.com/'), false)
})

test('isLocalListenHost keeps wildcard binds, rejects lookalikes', () => {
  for (const h of ['0.0.0.0', '::', '*', '[::1]', '127.0.0.1', '::ffff:127.0.0.1']) assert.ok(b.isLocalListenHost(h), h)
  for (const h of ['127.evil.example', '192.168.1.2', '10.0.0.1']) assert.ok(!b.isLocalListenHost(h), h)
})

test('renderer: securityState and address normalization with loopback lookalikes', () => {
  assert.equal(m.securityState('http://127.0.0.1.attacker.example', []), 'insecure')
  assert.equal(m.securityState('https://127.evil.example', []), 'secure')
  assert.equal(m.securityState('http://127.0.0.1:3000', []), 'local')
  assert.equal(m.securityState('http://0.0.0.0:3000', []), 'local')
  const n = (s) => m.normalizeBrowserAddressInput(s, 'google')
  assert.equal(n('127.evil.com'), 'https://127.evil.com')
  assert.equal(n('127.0.0.1:3000'), 'http://127.0.0.1:3000')
  assert.equal(n('[::1]:8080'), 'http://[::1]:8080')
  assert.equal(n('0.0.0.0:3000'), 'http://0.0.0.0:3000')
})

test('token bucket', () => {
  const bucket = b.newTokenBucket(3, 0)
  assert.deepEqual([0, 0, 0, 0].map(() => b.takeToken(bucket, 0, 3, 1000)), [true, true, true, false])
  assert.equal(b.takeToken(bucket, 500, 3, 1000), false)
  assert.equal(b.takeToken(bucket, 1000, 3, 1000), true)
  assert.equal(b.takeToken(bucket, 1000, 3, 1000), false)
  // long idle never exceeds capacity
  assert.deepEqual([0, 0, 0, 0].map(() => b.takeToken(bucket, 10_000_000, 3, 1000)), [true, true, true, false])
  // clock going backwards creates no tokens
  const back = b.newTokenBucket(1, 5000)
  assert.ok(b.takeToken(back, 5000, 1, 1000))
  const before = back.tokens
  assert.equal(b.takeToken(back, 1000, 1, 1000), false)
  assert.ok(back.tokens <= before)
  assert.equal(b.takeToken(back, 5000, 1, 1000), false)
})

test('activationAllows', () => {
  const bucket = b.newTokenBucket(b.POPUP_BURST, 0)
  assert.equal(b.USER_ACTIVATION_MS, 5000)
  assert.equal(b.activationAllows({ now: 6000, gestureAt: 0, gesturesKnown: true, bucket }), false)
  assert.equal(bucket.tokens, 3, 'stale gesture spends no token')
  assert.equal(b.activationAllows({ now: 1000, gestureAt: 0, gesturesKnown: true, bucket }), true)
  assert.equal(bucket.tokens, 2)
  assert.equal(b.activationAllows({ now: 5000, gestureAt: 0, gesturesKnown: true, bucket }), true)
  const open = b.newTokenBucket(b.POPUP_BURST, 0)
  assert.equal(b.activationAllows({ now: 999999, gestureAt: 0, gesturesKnown: false, bucket: open }), true)
})

test('activationAllows: setInterval(open, 50) for 10s is bounded', () => {
  const run = (gesturesKnown, gestureAt) => {
    const bucket = b.newTokenBucket(b.POPUP_BURST, 0)
    let passed = 0
    for (let t = 0; t <= 10_000; t += 50) if (b.activationAllows({ now: t, gestureAt, gesturesKnown, bucket })) passed++
    return passed
  }
  const limit = (seconds) => b.POPUP_BURST + seconds * (1000 / b.POPUP_REFILL_MS)
  assert.ok(run(false, 0) <= limit(10), 'no gesture info')
  assert.ok(run(true, -1_000_000) === 0, 'gestures known, none ever')
  const once = run(true, 0)
  assert.ok(once > 0 && once <= limit(b.USER_ACTIVATION_MS / 1000), `single gesture: ${once}`)
})

test('downloadAllowed', () => {
  const d = (o) => b.downloadAllowed({ now: 100_000, gestureAt: 0, gesturesKnown: true, downloadsSinceNavigation: 0, lastDownloadAt: 0, ...o })
  assert.equal(d({}), true)
  assert.equal(d({ downloadsSinceNavigation: 1 }), false)
  assert.equal(d({ downloadsSinceNavigation: 1, gestureAt: 98_000 }), true)
  assert.equal(d({ downloadsSinceNavigation: 1, gesturesKnown: false, lastDownloadAt: 97_000 }), false)
  assert.equal(d({ downloadsSinceNavigation: 1, gesturesKnown: false, lastDownloadAt: 95_000 }), true)
  assert.equal(d({ downloadsSinceNavigation: 5, gesturesKnown: false, lastDownloadAt: 95_001 }), false)
})

test('permissionAtoms / permissionPromptLabel', () => {
  assert.deepEqual(b.permissionAtoms('media', ['video']), ['media:video'])
  assert.deepEqual(b.permissionAtoms('media', []), ['media:video', 'media:audio'])
  assert.deepEqual(b.permissionAtoms('media', ['screen']), ['media:video', 'media:audio'])
  assert.deepEqual(b.permissionAtoms('media', ['audio', 'screen']), ['media:audio'])
  assert.deepEqual(b.permissionAtoms('geolocation', []), ['geolocation'])
  assert.equal(b.permissionPromptLabel('media', ['video']), 'usar a sua câmera')
  assert.equal(b.permissionPromptLabel('media', ['audio']), 'usar o seu microfone')
  assert.equal(b.permissionPromptLabel('media', ['video', 'audio']), 'usar a sua câmera e o seu microfone')
  assert.equal(b.permissionPromptLabel('media', []), 'usar a sua câmera e o seu microfone')
  assert.equal(b.permissionPromptLabel('geolocation', []), 'saber a sua localização')
  assert.equal(b.permissionPromptLabel('notifications', []), 'mostrar notificações')
  assert.equal(b.permissionPromptLabel('clipboard-read', []), 'ler a área de transferência')
  assert.match(b.permissionPromptLabel('midi', []), /midi/)
})

test('favicon url helpers', () => {
  assert.equal(b.defaultFaviconUrl('http://x.com:8080/a/b'), 'http://x.com:8080/favicon.ico')
  assert.equal(b.defaultFaviconUrl('file:///x'), null)
  assert.equal(b.defaultFaviconUrl('garbage'), null)
  assert.ok(b.isDefaultFaviconUrl('https://x.com/favicon.ico'))
  assert.ok(b.isDefaultFaviconUrl('http://x.com:81/favicon.ico'))
  for (const u of ['https://x.com/favicon.ico?v=1', 'https://x.com/favicon.ico#a', 'https://u:p@x.com/favicon.ico', 'https://x.com/a/favicon.ico',
    'https://x.com/favicon.png', 'file:///favicon.ico', 'nope'])
    assert.equal(b.isDefaultFaviconUrl(u), false, u)
  assert.equal(b.FAVICON_MAX_BYTES, 262144)
})

function streamOf(chunks, state) {
  let i = 0
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++])
      else controller.close()
    },
    cancel() { state.cancelled = true }
  })
}

test('readBodyLimited', async () => {
  const s1 = { cancelled: false }
  const ok = await b.readBodyLimited(streamOf([new Uint8Array([1, 2]), new Uint8Array([3])], s1), 10)
  assert.deepEqual([...ok], [1, 2, 3])
  assert.ok(Buffer.isBuffer(ok))
  const s2 = { cancelled: false }
  assert.equal(await b.readBodyLimited(streamOf([new Uint8Array(6), new Uint8Array(6), new Uint8Array(6)], s2), 10), null)
  assert.equal(s2.cancelled, true)
  assert.equal(await b.readBodyLimited(null, 10), null)
  const s3 = { cancelled: false }
  const exact = await b.readBodyLimited(streamOf([new Uint8Array(5), new Uint8Array(5)], s3), 10)
  assert.equal(exact.length, 10)
  assert.equal(s3.cancelled, false)
})

test('renderer persistence drops non-http favicons; navigationPolicy unchanged', () => {
  const t = (id, faviconUrl) => ({ id, url: 'https://a.com', title: '', faviconUrl, zoomPercent: 100 })
  const out = JSON.parse(m.serializeBrowserState({ activeId: 'a', tabs: [t('a', 'data:image/png;base64,AAAA'), t('b', 'https://a.com/favicon.ico'), t('c', 'javascript:1')] }))
  assert.deepEqual(out.tabs.map((x) => x.faviconUrl), [null, 'https://a.com/favicon.ico', null])
  for (const u of ['javascript:alert(1)', 'data:text/html,x', 'file:///x']) assert.equal(m.navigationPolicy(u).kind, 'unsupported', u)
  assert.equal(m.navigationPolicy('about:blank').kind, 'blank')
})
